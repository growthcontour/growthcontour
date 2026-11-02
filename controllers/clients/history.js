const crypto = require("crypto");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;
const MAX_VALUE = 5000;

const newBatch = () => crypto.randomBytes(6).toString("hex");

// Будь-яке значення → рядок для історії (дати — без UTC-зсуву, об'єкти — JSON)
function str(v) {
	if (v === null || v === undefined || v === "") return null;
	if (v instanceof Date) {
		const p = (n) => String(n).padStart(2, "0");
		const day = `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
		// Колонки DATE приходять як північ — показуємо лише дату
		if (!v.getHours() && !v.getMinutes() && !v.getSeconds()) return day;
		return `${day} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
	}
	if (typeof v === "object") return JSON.stringify(v).slice(0, MAX_VALUE);
	return String(v).slice(0, MAX_VALUE);
}

/**
 * Контекст зміни: хто, звідки, одним пакетом.
 * Створюється один раз на операцію і передається в усі записи.
 */
function ctx(opts) {
	const o = opts || {};
	return {
		id_user: Number(o.id_user) || null,
		user_name: String(o.user_name || "").slice(0, 255),
		source: String(o.source || "manual").slice(0, 32),
		source_ref: o.source_ref != null && o.source_ref !== "" ? String(o.source_ref).slice(0, 191) : null,
		ip: o.ip || null,
		batch: o.batch || newBatch(),
	};
}

/** Контекст із HTTP-запиту менеджера */
function ctxFromReq(req, source) {
	const u = req.user || {};
	const ip = req.ip || req.socket?.remoteAddress || "";
	return ctx({
		id_user: u.userId || u.id || null,
		source: source || "manual",
		ip: ip.replace(/^::ffff:/, "") || null,
	});
}

/** Системний контекст (воркер замовлень, чат, імпорт) */
function ctxSystem(source, sourceRef, idUser) {
	return ctx({ source: source || "system", source_ref: sourceRef, id_user: idUser });
}

/** Той самий хто/звідки, але новий пакет (інша операція) */
function fork(c, extra) {
	return ctx({ ...(c || {}), batch: null, ...(extra || {}) });
}

// Імена користувачів: кеш на 10 хвилин, щоб не ходити в базу на кожен запис
const nameCache = new Map();
async function userName(q, idUser) {
	if (!idUser) return "";
	const hit = nameCache.get(idUser);
	if (hit && hit.exp > Date.now()) return hit.name;
	let name = "";
	try {
		const [[u]] = await q.query(`SELECT first_name, last_name FROM ${P}users WHERE id = ? LIMIT 1`, [idUser]);
		if (u) name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
	} catch (e) {
		name = "";
	}
	nameCache.set(idUser, { name, exp: Date.now() + 600000 });
	return name;
}

/**
 * Різниця між станами: повертає лише поля, що справді змінились.
 * fields — список полів для порівняння; якщо не задано — усі ключі нового стану.
 */
function diff(before, after, fields) {
	const b = before || {};
	const a = after || {};
	const keys = fields || Object.keys(a);
	const out = [];
	for (const f of keys) {
		const o = str(b[f]);
		const n = str(a[f]);
		if (o !== n) out.push({ field: f, value_old: o, value_new: n });
	}
	return out;
}

/**
 * Записати події в історію. Одним INSERT на весь пакет.
 * rows: [{ id_client, action, entity, id_entity, field, value_old, value_new }]
 * conn — транзакція зміни: відкат зміни = відкат історії.
 */
async function write(conn, c, rows) {
	const list = (rows || []).filter((r) => r && r.id_client && r.action && r.entity);
	if (!list.length) return;
	const q = conn || pool;
	const h = c || ctx();
	if (h.id_user && !h.user_name) h.user_name = (await userName(q, h.id_user)).slice(0, 255);

	const placeholders = list.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, INET6_ATON(?), NOW(3))").join(", ");
	const params = [];
	for (const r of list) {
		params.push(r.id_client, h.id_user, h.user_name, h.source, r.source_ref != null ? String(r.source_ref).slice(0, 191) : h.source_ref, String(r.action).slice(0, 32), String(r.entity).slice(0, 32), r.id_entity || null, r.field ? String(r.field).slice(0, 64) : null, str(r.value_old), str(r.value_new), h.batch, h.ip);
	}

	await q.query(
		`INSERT INTO ${P}clients_history
            (id_client, id_user, user_name, source, source_ref, action, entity, id_entity, field, value_old, value_new, batch, ip, date_add)
         VALUES ${placeholders}`,
		params
	);
}

/** Зміни полів однієї сутності */
async function writeDiff(conn, c, idClient, entity, idEntity, before, after, fields) {
	const changes = diff(before, after, fields);
	if (!changes.length) return 0;
	await write(
		conn,
		c,
		changes.map((ch) => ({ id_client: idClient, action: "updated", entity, id_entity: idEntity, ...ch }))
	);
	return changes.length;
}

/** Рядки «додано / видалено» для всього запису: кожне непорожнє поле окремо */
function rowsOf(action, idClient, entity, idEntity, row, fields) {
	const out = [];
	for (const f of fields) {
		const v = str(row && row[f]);
		if (v === null) continue;
		out.push({
			id_client: idClient,
			action,
			entity,
			id_entity: idEntity,
			field: f,
			value_old: action === "removed" ? v : null,
			value_new: action === "removed" ? null : v,
		});
	}
	return out;
}

/**
 * Прив'язка об'єкта іншого модуля (замовлення, лід, контакт чату) до картки.
 * newId — нова картка («linked»), oldId — попередня («unlinked»). field — роль: buyer / recipient / org.
 * Помилка історії не ламає бізнес-операцію поза транзакцією (conn = null).
 */
async function linked(conn, c, entity, idEntity, newId, oldId, field, label) {
	const n = Number(newId) || null;
	const o = Number(oldId) || null;
	if (n === o) return;
	const rows = [];
	if (n) rows.push({ id_client: n, action: "linked", entity, id_entity: idEntity, field: field || null, value_old: o, value_new: label != null ? label : idEntity });
	if (o) rows.push({ id_client: o, action: "unlinked", entity, id_entity: idEntity, field: field || null, value_old: label != null ? label : idEntity, value_new: n });
	if (conn) return write(conn, c, rows);
	try {
		await write(null, c, rows);
	} catch (e) {
		console.error("clients.history.linked", e.message);
	}
}

/**
 * Історія клієнта з фільтрами і пагінацією за курсором.
 * opts: { before_id, limit, entity, source, id_user, date_from, date_to }
 */
async function list(idClient, opts) {
	const o = opts || {};
	const limit = Math.min(Math.max(parseInt(o.limit, 10) || 50, 1), 200);
	const where = ["h.id_client = ?"];
	const params = [idClient];

	if (o.before_id) {
		where.push("h.id < ?");
		params.push(parseInt(o.before_id, 10));
	}
	if (o.entity) {
		where.push("h.entity = ?");
		params.push(String(o.entity));
	}
	if (o.source) {
		where.push("h.source = ?");
		params.push(String(o.source));
	}
	if (o.id_user) {
		where.push("h.id_user = ?");
		params.push(parseInt(o.id_user, 10));
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(String(o.date_from || ""))) {
		where.push("h.date_add >= ?");
		params.push(o.date_from + " 00:00:00");
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(String(o.date_to || ""))) {
		where.push("h.date_add <= ?");
		params.push(o.date_to + " 23:59:59.999");
	}

	const [rows] = await pool.query(
		`SELECT h.id, h.id_user, h.user_name, h.source, h.source_ref, h.action, h.entity, h.id_entity,
                h.field, h.value_old, h.value_new, h.batch, INET6_NTOA(h.ip) AS ip, h.date_add
           FROM ${P}clients_history h
          WHERE ${where.join(" AND ")}
          ORDER BY h.id DESC
          LIMIT ${limit + 1}`,
		params
	);

	const hasMore = rows.length > limit;
	if (hasMore) rows.pop();
	return { rows, has_more: hasMore, next_before_id: hasMore ? rows[rows.length - 1].id : null };
}

module.exports = { newBatch, ctx, ctxFromReq, ctxSystem, fork, diff, write, writeDiff, rowsOf, linked, list };
