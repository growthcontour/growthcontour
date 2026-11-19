"use strict";

/** Чат компанії: довідник людей (з ким почати розмову) і статуси (на зв'язку, на зустрічі, у відпустці …) */
const { pool, T, userName, avatarUrl } = require("./common");
const rooms = require("./rooms");
const realtime = require("./realtime");

function online(id) {
	try {
		return require("../socket/socket").isUserOnline(id);
	} catch {
		return false;
	}
}

/** Активні колеги з пошуком за ім'ям, email, посадою, відділом, офісом */
async function directory(uid, q) {
	const search = String(q || "").trim().slice(0, 100);
	const params = [];
	let where = "";
	if (search) {
		const like = `%${search.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
		where = "AND (CONCAT_WS(' ', u.first_name, u.last_name, u.patronymic) LIKE ? OR u.email LIKE ? OR u.position LIKE ? OR d.name LIKE ? OR o.name LIKE ?)";
		params.push(like, like, like, like, like);
	}
	const [rows] = await pool.query(
		`SELECT u.id, ${userName("u")} AS name, u.avatar, u.position, u.date_last_seen,
		        d.name AS department, o.name AS office, COALESCE(u.timezone, o.timezone) AS timezone
		   FROM ${T.users} u
		   LEFT JOIN ${T.depts} d ON d.id = u.id_department
		   LEFT JOIN ${T.offices} o ON o.id = u.id_office
		  WHERE u.active = 1 ${where}
		  ORDER BY u.last_name, u.first_name, u.id
		  LIMIT 300`,
		params
	);
	const st = await rooms.statuses(rows.map((r) => Number(r.id)));
	return rows.map((r) => ({
		id: Number(r.id),
		name: r.name,
		avatar: avatarUrl(r.id, r.avatar),
		position: r.position,
		department: r.department,
		office: r.office,
		timezone: r.timezone,
		online: online(r.id),
		last_seen: r.date_last_seen,
		status: st.get(Number(r.id)) || null,
		me: Number(r.id) === uid,
	}));
}

async function getStatus(uid) {
	const st = await rooms.statuses([uid]);
	return st.get(uid) || { status: "available", text: null, until: null };
}

/** Встановити статус. available без тексту — запис видаляється */
async function setStatus(uid, d) {
	if (d.status === "available" && !d.text) {
		await pool.query(`DELETE FROM ${T.status} WHERE id_user = ?`, [uid]);
	} else {
		await pool.query(
			`INSERT INTO ${T.status} (id_user, status, text, until, date_edit) VALUES (?, ?, ?, ?, NOW())
			 ON DUPLICATE KEY UPDATE status = VALUES(status), text = VALUES(text), until = VALUES(until), date_edit = NOW()`,
			[uid, d.status, d.text, d.until]
		);
	}
	const status = await getStatus(uid);
	await broadcastStatus(uid, status);
	return status;
}

/** Статус бачать усі, хто має з людиною спільний чат */
async function broadcastStatus(uid, status) {
	const [rows] = await pool.query(`SELECT DISTINCT b.id_user FROM ${T.members} a JOIN ${T.members} b ON b.id_room = a.id_room WHERE a.id_user = ? LIMIT 10000`, [uid]);
	realtime.emitToUsers(
		rows.map((r) => Number(r.id_user)),
		"chat:status",
		{ id_user: uid, status }
	);
}

/** Статуси зі строком, що минув, — прибрати й повідомити (раз на хвилину) */
async function expireStatuses() {
	const [rows] = await pool.query(`SELECT id_user FROM ${T.status} WHERE until IS NOT NULL AND until <= NOW() LIMIT 500`);
	if (!rows.length) return 0;
	const ids = rows.map((r) => Number(r.id_user));
	await pool.query(`DELETE FROM ${T.status} WHERE id_user IN (?) AND until IS NOT NULL AND until <= NOW()`, [ids]);
	for (const id of ids) await broadcastStatus(id, { status: "available", text: null, until: null });
	return ids.length;
}

module.exports = { directory, getStatus, setStatus, expireStatuses };