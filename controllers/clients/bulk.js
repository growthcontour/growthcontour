const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const dict = require("./dictionaries");
const history = require("./history");

const P = config.get("configDatabase").prefix;
const MAX_BULK = 10000;
const CHUNK = 500;

function httpErr(status, message) {
	const e = new Error(message);
	e.status = status;
	return e;
}

/**
 * Цільові клієнти: явні ids або «усі за фільтром» (where/params з buildClientWhere).
 * Повертає масив id (не більше MAX_BULK).
 */
async function resolveTargets(ids, filter) {
	if (Array.isArray(ids) && ids.length) {
		const list = [...new Set(ids.map((x) => parseInt(x, 10)).filter(Boolean))];
		if (list.length > MAX_BULK) throw httpErr(400, `Не більше ${MAX_BULK} клієнтів за раз.`);
		const [rows] = await pool.query(`SELECT id FROM ${P}clients WHERE id IN (?) AND deleted_at IS NULL AND id_merged_into IS NULL`, [list]);
		return rows.map((r) => r.id);
	}
	if (filter) {
		const [rows] = await pool.query(
			`SELECT c.id FROM ${P}clients c LEFT JOIN ${P}clients_stats st ON st.id_client = c.id
              WHERE ${filter.where.join(" AND ")} ORDER BY c.id LIMIT ${MAX_BULK + 1}`,
			filter.params
		);
		if (rows.length > MAX_BULK) throw httpErr(400, `За фільтром понад ${MAX_BULK} клієнтів — звузьте умови.`);
		return rows.map((r) => r.id);
	}
	throw httpErr(400, "Не обрано жодного клієнта.");
}

const chunks = (arr) => Array.from({ length: Math.ceil(arr.length / CHUNK) }, (_, i) => arr.slice(i * CHUNK, (i + 1) * CHUNK));

/**
 * Масова дія. action: set_manager | set_lifecycle | add_tag | remove_tag
 * Кожна порція — окрема транзакція; кожна зміна — в історію (один пакет на всю дію).
 */
async function apply(action, ids, value, h) {
	let changed = 0;

	if (action === "set_manager") {
		const idManager = value === "" || value === null || value === "none" ? null : parseInt(value, 10);
		if (idManager) {
			const [[u]] = await pool.query(`SELECT id FROM ${P}users WHERE id = ? AND active = 1`, [idManager]);
			if (!u) throw httpErr(400, "Менеджера не знайдено.");
		}
		for (const part of chunks(ids)) {
			changed += await tx(async (conn) => {
				const [cur] = await conn.query(`SELECT id, id_manager FROM ${P}clients WHERE id IN (?) AND NOT (id_manager <=> ?) FOR UPDATE`, [part, idManager]);
				if (!cur.length) return 0;
				await conn.query(`UPDATE ${P}clients SET id_manager = ?, id_user_edit = ?, date_edit = NOW() WHERE id IN (?)`, [idManager, h.id_user, cur.map((r) => r.id)]);
				await history.write(conn, h, cur.map((r) => ({ id_client: r.id, action: "updated", entity: "client", id_entity: r.id, field: "id_manager", value_old: r.id_manager, value_new: idManager })));
				return cur.length;
			});
		}
		return { ok: true, changed };
	}

	if (action === "set_lifecycle") {
		const st = await dict.byId("lifecycle_stages", value);
		if (!st) throw httpErr(400, "Невідома стадія.");
		for (const part of chunks(ids)) {
			changed += await tx(async (conn) => {
				const [cur] = await conn.query(`SELECT id, id_lifecycle FROM ${P}clients WHERE id IN (?) AND NOT (id_lifecycle <=> ?) FOR UPDATE`, [part, st.id]);
				if (!cur.length) return 0;
				await conn.query(`UPDATE ${P}clients SET id_lifecycle = ?, id_user_edit = ?, date_edit = NOW() WHERE id IN (?)`, [st.id, h.id_user, cur.map((r) => r.id)]);
				await history.write(conn, h, cur.map((r) => ({ id_client: r.id, action: "updated", entity: "client", id_entity: r.id, field: "id_lifecycle", value_old: r.id_lifecycle, value_new: st.id })));
				return cur.length;
			});
		}
		return { ok: true, changed };
	}

	if (action === "add_tag" || action === "remove_tag") {
		const tag = await dict.byId("tags", value);
		if (!tag) throw httpErr(400, "Невідомий тег.");
		for (const part of chunks(ids)) {
			changed += await tx(async (conn) => {
				const [has] = await conn.query(`SELECT id_client FROM ${P}clients_tag_links WHERE id_tag = ? AND id_client IN (?)`, [tag.id, part]);
				const hasSet = new Set(has.map((r) => r.id_client));
				const target = action === "add_tag" ? part.filter((id) => !hasSet.has(id)) : part.filter((id) => hasSet.has(id));
				if (!target.length) return 0;
				if (action === "add_tag") {
					await conn.query(`INSERT IGNORE INTO ${P}clients_tag_links (id_client, id_tag, id_user, date_add) VALUES ${target.map(() => "(?, ?, ?, NOW())").join(", ")}`, target.flatMap((id) => [id, tag.id, h.id_user]));
				} else {
					await conn.query(`DELETE FROM ${P}clients_tag_links WHERE id_tag = ? AND id_client IN (?)`, [tag.id, target]);
				}
				const act = action === "add_tag" ? "added" : "removed";
				await history.write(conn, h, target.map((id) => ({ id_client: id, action: act, entity: "tag", id_entity: tag.id, value_old: act === "removed" ? tag.id : null, value_new: act === "added" ? tag.id : null })));
				return target.length;
			});
		}
		return { ok: true, changed };
	}

	throw httpErr(400, "Невідома дія.");
}

async function tx(fn) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const r = await fn(conn);
		await conn.commit();
		return r;
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

/**
 * Експорт у CSV (UTF-8 з BOM, роздільник «;» — коректно відкривається в Excel).
 * Пише в res порціями, без завантаження всієї вибірки в памʼять.
 */
async function exportCsv(ids, idLang, res) {
	const [lifecycle, tags] = await Promise.all([dict.list("lifecycle_stages", idLang, { activeOnly: false }), dict.list("tags", idLang, { activeOnly: false })]);
	const lc = new Map(lifecycle.map((r) => [r.id, r.name]));
	const tg = new Map(tags.map((r) => [r.id, r.name]));
	const phoneType = await dict.idOf("contact_types", "phone");
	const emailType = await dict.idOf("contact_types", "email");

	const cell = (v) => {
		const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 19).replace("T", " ") : String(v);
		// Захист від формул в Excel (CSV injection)
		const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
		return /[";\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
	};

	const stamp = new Date().toISOString().slice(0, 10);
	res.setHeader("Content-Type", "text/csv; charset=utf-8");
	res.setHeader("Content-Disposition", `attachment; filename="clients-${stamp}.csv"`);
	res.write("\uFEFF");
	res.write(["ID", "Назва", "Тип", "Телефон", "Email", "Країна", "Стадія", "Менеджер", "Теги", "Замовлень", "Виручка", "Остання покупка", "Створено"].join(";") + "\r\n");

	for (const part of chunks(ids)) {
		const [rows] = await pool.query(
			`SELECT c.id, c.display_name, c.kind, c.country, c.id_lifecycle, c.date_add,
                    NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS manager,
                    st.orders_valid_count, st.revenue_base, st.last_order_at,
                    (SELECT cp.value FROM ${P}clients_contact_points cp WHERE cp.id_client = c.id AND cp.id_contact_type = ? ORDER BY cp.is_primary DESC, cp.id LIMIT 1) AS phone,
                    (SELECT cp.value FROM ${P}clients_contact_points cp WHERE cp.id_client = c.id AND cp.id_contact_type = ? ORDER BY cp.is_primary DESC, cp.id LIMIT 1) AS email,
                    (SELECT GROUP_CONCAT(tl.id_tag) FROM ${P}clients_tag_links tl WHERE tl.id_client = c.id) AS tag_ids
               FROM ${P}clients c
               LEFT JOIN ${P}clients_stats st ON st.id_client = c.id
               LEFT JOIN ${P}users u ON u.id = c.id_manager
              WHERE c.id IN (?)
              ORDER BY c.id`,
			[phoneType, emailType, part]
		);
		const lines = rows.map((r) =>
			[
				r.id,
				r.display_name,
				r.kind,
				r.phone,
				r.email,
				r.country,
				lc.get(r.id_lifecycle) || "",
				r.manager,
				String(r.tag_ids || "")
					.split(",")
					.filter(Boolean)
					.map((id) => tg.get(Number(id)) || "")
					.filter(Boolean)
					.join(", "),
				Number(r.orders_valid_count) || 0,
				Number(r.revenue_base || 0).toFixed(2),
				r.last_order_at,
				r.date_add,
			]
				.map(cell)
				.join(";")
		);
		res.write(lines.join("\r\n") + "\r\n");
	}
	res.end();
}

module.exports = { MAX_BULK, resolveTargets, apply, exportCsv };