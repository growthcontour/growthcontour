const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;
const MAX_PER_USER = 50;

function httpErr(status, message) {
	const e = new Error(message);
	e.status = status;
	return e;
}

// Лише прості значення фільтрів: id поля → рядок (без вкладених об'єктів і зайвого)
function cleanFilters(f) {
	const out = {};
	for (const [k, v] of Object.entries(f && typeof f === "object" ? f : {})) {
		if (!/^f-[a-z0-9-]{1,40}$/.test(k)) continue;
		const s = String(v ?? "").slice(0, 200);
		if (s !== "") out[k] = s;
	}
	return out;
}

/** Мої + спільні фільтри сторінки */
async function list(page, idUser) {
	const [rows] = await pool.query(
		`SELECT f.id, f.name, f.filters, f.is_shared, f.id_user,
                NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS author
           FROM ${P}saved_filters f
           LEFT JOIN ${P}users u ON u.id = f.id_user
          WHERE f.page = ? AND (f.id_user = ? OR f.is_shared = 1)
          ORDER BY (f.id_user = ?) DESC, f.sort, f.name`,
		[page, idUser, idUser]
	);
	return {
		rows: rows.map((r) => ({
			id: r.id,
			name: r.name,
			filters: typeof r.filters === "string" ? JSON.parse(r.filters) : r.filters || {},
			is_shared: Number(r.is_shared) === 1,
			is_mine: r.id_user === idUser,
			author: r.author,
		})),
	};
}

/** Створити або оновити свій фільтр. b: { id?, name, filters, is_shared } */
async function save(page, idUser, b) {
	const name = String((b && b.name) || "").trim().slice(0, 100);
	if (!name) throw httpErr(400, "Вкажіть назву.");
	const filters = cleanFilters(b.filters);
	if (!Object.keys(filters).length) throw httpErr(400, "Фільтр порожній — задайте хоча б одну умову.");
	const shared = b.is_shared ? 1 : 0;
	const id = parseInt(b.id, 10) || 0;

	if (id) {
		const [r] = await pool.query(`UPDATE ${P}saved_filters SET name = ?, filters = CAST(? AS JSON), is_shared = ?, date_edit = NOW() WHERE id = ? AND id_user = ? AND page = ?`, [name, JSON.stringify(filters), shared, id, idUser, page]);
		if (!r.affectedRows) throw httpErr(404, "Фільтр не знайдено або він не ваш.");
		return { ok: true, id };
	}

	const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}saved_filters WHERE id_user = ? AND page = ?`, [idUser, page]);
	if (Number(cnt.n) >= MAX_PER_USER) throw httpErr(400, `Максимум ${MAX_PER_USER} збережених фільтрів.`);

	const [[dup]] = await pool.query(`SELECT id FROM ${P}saved_filters WHERE id_user = ? AND page = ? AND name = ? LIMIT 1`, [idUser, page, name]);
	if (dup) throw httpErr(409, "Фільтр з такою назвою вже є.");

	const [ins] = await pool.query(
		`INSERT INTO ${P}saved_filters (page, id_user, name, filters, is_shared, sort, date_add, date_edit) VALUES (?, ?, ?, CAST(? AS JSON), ?, 0, NOW(), NOW())`,
		[page, idUser, name, JSON.stringify(filters), shared]
	);
	return { ok: true, id: ins.insertId };
}

/** Видалити: власник або адміністратор (для спільних) */
async function remove(page, idUser, id, isAdmin) {
	const [r] = await pool.query(`DELETE FROM ${P}saved_filters WHERE id = ? AND page = ? AND (id_user = ? OR (? = 1 AND is_shared = 1))`, [id, page, idUser, isAdmin ? 1 : 0]);
	if (!r.affectedRows) throw httpErr(404, "Фільтр не знайдено або немає прав.");
	return { ok: true };
}

module.exports = { list, save, remove };