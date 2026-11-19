const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;
const MAX_LINKS = 20;

// Тип об'єкта → таблиця для перевірки існування
const TYPES = {
	client: "clients",
	lead: "leads",
	order: "orders",
	deal: "deals",
	conversation: "contact_center_conversations",
};

function clean(links) {
	const out = [];
	const seen = new Set();
	for (const l of Array.isArray(links) ? links : []) {
		const type = String((l && l.type) || "");
		const id = parseInt(l && l.id, 10);
		if (!TYPES[type] || !(id > 0)) continue;
		const k = type + ":" + id;
		if (seen.has(k)) continue;
		seen.add(k);
		out.push({ type, id });
		if (out.length >= MAX_LINKS) break;
	}
	return out;
}

/** Замінити прив'язки події. links null/undefined → не чіпати. Повертає { added, removed } */
async function save(conn, idEvent, links) {
	if (links === null || links === undefined) return { added: [], removed: [] };
	const want = clean(links);

	const ok = [];
	for (const l of want) {
		const [[r]] = await conn.query(`SELECT id FROM ${P}${TYPES[l.type]} WHERE id = ? LIMIT 1`, [l.id]);
		if (r) ok.push(l);
	}

	const [cur] = await conn.query(`SELECT ref_type AS type, id_ref AS id FROM ${P}calendar_event_links WHERE id_event = ?`, [idEvent]);
	const key = (x) => x.type + ":" + x.id;
	const curSet = new Set(cur.map(key));
	const okSet = new Set(ok.map(key));
	const added = ok.filter((x) => !curSet.has(key(x)));
	const removed = cur.filter((x) => !okSet.has(key(x)));

	for (const x of removed) {
		await conn.query(`DELETE FROM ${P}calendar_event_links WHERE id_event = ? AND ref_type = ? AND id_ref = ?`, [idEvent, x.type, x.id]);
	}
	if (added.length) {
		await conn.query(
			`INSERT IGNORE INTO ${P}calendar_event_links (id_event, ref_type, id_ref, date_add) VALUES ${added.map(() => "(?, ?, ?, NOW())").join(", ")}`,
			added.flatMap((x) => [idEvent, x.type, x.id])
		);
	}
	return { added, removed };
}

/** Прив'язки подій: { idEvent: [{type, id}] } */
async function ofEvents(ids) {
	const out = {};
	if (!ids.length) return out;
	const [rows] = await pool.query(`SELECT id_event, ref_type AS type, id_ref AS id FROM ${P}calendar_event_links WHERE id_event IN (?)`, [ids]);
	for (const r of rows) (out[r.id_event] = out[r.id_event] || []).push({ type: r.type, id: r.id });
	return out;
}

/** Події об'єкта: свої (учасник) і загальні (visibility = company). scope: upcoming | done */
async function listFor(type, id, idUser, idLang, scope, limit) {
	if (!TYPES[type]) return [];
	const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
	const statusCond = scope === "done" ? "e.status IN (2, 3)" : "e.status = 1";
	const order = scope === "done" ? "e.date_start DESC" : "e.date_start ASC";

	const [rows] = await pool.query(
		`SELECT e.id, e.title, e.description, e.date_start, e.date_end, e.all_day, e.status, e.priority,
                e.id_user_creator, e.visibility, e.reminder_minutes,
                et.color AS type_color, et.icon AS type_icon, etl.name AS type_name,
                NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS creator_name,
                eu.id_user IS NOT NULL AS is_mine
           FROM ${P}calendar_event_links l
           INNER JOIN ${P}calendar_events e ON e.id = l.id_event AND e.active = 1
           LEFT JOIN ${P}calendar_event_users eu ON eu.id_event = e.id AND eu.id_user = ? AND eu.active = 1
           LEFT JOIN ${P}calendar_event_type et ON et.id = e.id_event_type
           LEFT JOIN ${P}calendar_event_type_lang etl ON etl.id_event_type = e.id_event_type AND etl.id_lang = ?
           LEFT JOIN ${P}users u ON u.id = e.id_user_creator
          WHERE l.ref_type = ? AND l.id_ref = ? AND ${statusCond}
            AND (eu.id_user IS NOT NULL OR e.visibility >= 4)
          ORDER BY ${order}
          LIMIT ${lim}`,
		[idUser, idLang, type, id]
	);
	return rows;
}

// Назви прив'язаних об'єктів: { "client:5": "Іван Петренко", ... }
const LABEL_SQL = {
	client: (ids) => [`SELECT id, display_name AS name FROM ${P}clients WHERE id IN (?)`, [ids]],
	lead: (ids) => [`SELECT id, title AS name FROM ${P}leads WHERE id IN (?)`, [ids]],
	order: (ids) => [`SELECT id, reference AS name FROM ${P}orders WHERE id IN (?)`, [ids]],
};
async function labels(links) {
	const out = {};
	const byType = {};
	for (const l of links) (byType[l.type] = byType[l.type] || new Set()).add(l.id);
	for (const [type, set] of Object.entries(byType)) {
		if (!LABEL_SQL[type]) continue;
		const [sql, params] = LABEL_SQL[type]([...set]);
		const [rows] = await pool.query(sql, params);
		for (const r of rows) out[type + ":" + r.id] = r.name;
	}
	return out;
}

/**
 * «Мій день»: мої заплановані події — прострочені (до daysBack назад) і до кінця сьогодні.
 * Без відпусток і відхилених запрошень.
 */
async function myDay(idUser, idLang, daysBack) {
	const back = Math.min(Math.max(parseInt(daysBack, 10) || 30, 1), 365);
	const [rows] = await pool.query(
		`SELECT e.id, e.title, e.date_start, e.date_end, e.all_day, e.status, e.priority,
                et.color AS type_color, et.icon AS type_icon, etl.name AS type_name
           FROM ${P}calendar_event_users eu
           INNER JOIN ${P}calendar_events e ON e.id = eu.id_event AND e.active = 1 AND e.status = 1
           LEFT JOIN ${P}calendar_event_type et ON et.id = e.id_event_type
           LEFT JOIN ${P}calendar_event_type_lang etl ON etl.id_event_type = e.id_event_type AND etl.id_lang = ?
          WHERE eu.id_user = ? AND eu.active = 1 AND eu.is_hidden = 0 AND eu.response <> 2
            AND eu.date_start >= CURDATE() - INTERVAL ? DAY
            AND eu.date_start < CURDATE() + INTERVAL 1 DAY
            AND COALESCE(et.is_absence, 0) = 0
          ORDER BY e.date_start ASC
          LIMIT 200`,
		[idLang, idUser, back]
	);
	const links = await ofEvents(rows.map((r) => r.id));
	const names = await labels(Object.values(links).flat());
	for (const r of rows) {
		r.links = (links[r.id] || []).map((l) => ({ ...l, name: names[l.type + ":" + l.id] || null }));
	}
	return rows;
}

/** Прив'язки однієї події з назвами: [{type, id, name}] */
async function ofEventNamed(idEvent) {
	const list = (await ofEvents([idEvent]))[idEvent] || [];
	const names = await labels(list);
	return list.map((l) => ({ ...l, name: names[l.type + ":" + l.id] || null }));
}

/** Пошук об'єктів для прив'язки: клієнти, ліди, замовлення */
async function searchTargets(q, onlyUserId) {
	const s = String(q || "")
		.trim()
		.slice(0, 100);
	if (s.length < 2) return [];
	const like = "%" + s + "%";
	const num = /^\d+$/.test(s) ? parseInt(s, 10) : 0;
	const out = [];

	const clients = await require("../clients/queries").search(s, null, onlyUserId);
	for (const c of clients.slice(0, 8)) out.push({ type: "client", id: c.id, name: c.display_name, sub: c.phone || c.email || "" });

	const [leads] = await pool.query(`SELECT id, title FROM ${P}leads WHERE deleted_at IS NULL AND (title LIKE ? OR id = ?) ORDER BY id DESC LIMIT 5`, [like, num]);
	for (const l of leads) out.push({ type: "lead", id: l.id, name: l.title || "#" + l.id, sub: "#" + l.id });

	const [orders] = await pool.query(`SELECT id, reference FROM ${P}orders WHERE deleted_at IS NULL AND (reference LIKE ? OR external_number LIKE ? OR id = ?) ORDER BY id DESC LIMIT 5`, [like, like, num]);
	for (const o of orders) out.push({ type: "order", id: o.id, name: o.reference, sub: "#" + o.id });

	return out;
}

module.exports = { TYPES, clean, save, ofEvents, ofEventNamed, listFor, labels, myDay, searchTargets };
