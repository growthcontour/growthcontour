"use strict";

/**
 * Чат компанії: відкладене надсилання і нагадування.
 * Час зберігається в UTC (send_at, remind_at) і порівнюється з UTC_TIMESTAMP() —
 * незалежно від часових поясів сервера застосунку, сервера бази й людей.
 * Клієнт надсилає момент у ISO 8601 з поясом (2026-11-16T09:00:00+05:30 або …Z), сервер повертає ISO у UTC.
 */
const { pool, T, httpErr, membership, roomLink, canPost, canComment, permissions, chatPerms } = require("./common");
const realtime = require("./realtime");
const mentions = require("./mentions");
const logging = require("../../logging/logging");

const MAX_WAIT = 100; // запланованих повідомлень на людину
const MAX_REMINDERS = 200;
const MAX_AHEAD_DAYS = 366;

/** ISO з поясом → 'YYYY-MM-DD HH:MM:SS' UTC для MySQL; перевіряє, що момент у майбутньому і не далі ніж за рік */
function toUtc(iso, field) {
	const t = new Date(iso);
	const now = Date.now();
	if (Number.isNaN(t.getTime()) || t.getTime() < now + 30 * 1000 || t.getTime() > now + MAX_AHEAD_DAYS * 86400000) {
		throw httpErr(400, "chat.errors.validation", [{ field, message: "out of range" }]);
	}
	return t.toISOString().slice(0, 19).replace("T", " ");
}

// UTC-рядок з бази (DATE_FORMAT) → ISO
const iso = (s) => (s ? String(s).replace(" ", "T") + "Z" : null);
const UTC_FMT = (col) => `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i:%s')`;

/** Права людини на момент надсилання (могли змінитися після планування) */
const permsOf = async (uid) => chatPerms(await permissions(uid));

// ═══ ВІДКЛАДЕНЕ НАДСИЛАННЯ ════════════════════════════

/** Запланувати. d — перевірене validateMessage + send_at */
async function create(uid, idRoom, d, perms) {
	const m = await membership(idRoom, uid);
	if (!canPost(m, perms) && !(d.id_thread && canComment(m))) throw httpErr(403, "chat.errors.cannot_post");
	const at = toUtc(d.send_at, "send_at");
	const [[n]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.scheduled} WHERE id_user = ? AND status = 'wait'`, [uid]);
	if (Number(n.n) >= MAX_WAIT) throw httpErr(400, "chat.errors.too_many_scheduled");
	if (d.files.length) {
		const [own] = await pool.query(`SELECT id FROM ${T.files} WHERE id IN (?) AND id_room = ? AND id_user = ? AND id_message IS NULL`, [d.files, idRoom, uid]);
		if (own.length !== d.files.length) throw httpErr(400, "chat.errors.validation", [{ field: "files", message: "not found" }]);
	}
	// Згадки перевіряємо одразу, щоб людина дізналася про помилку (наприклад, @всі без права) зараз, а не в момент надсилання
	await mentions.expand(pool, m, uid, d.body, perms);
	const [r] = await pool.query(
		`INSERT INTO ${T.scheduled} (id_room, id_user, body, files, records, id_reply, id_thread, urgent, send_at, status, date_add)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'wait', NOW())`,
		[idRoom, uid, d.body, d.files.length ? JSON.stringify(d.files) : null, d.records && d.records.length ? JSON.stringify(d.records) : null, d.id_reply, d.id_thread, Number(!!d.urgent), at]
	);
	return { scheduled: await one(uid, r.insertId) };
}

async function one(uid, id) {
	const [[r]] = await pool.query(
		`SELECT s.id, s.id_room, s.body, s.files, s.id_thread, s.urgent, ${UTC_FMT("s.send_at")} AS send_at, s.status, s.error, s.id_message
		   FROM ${T.scheduled} s WHERE s.id = ? AND s.id_user = ?`,
		[id, uid]
	);
	if (!r) throw httpErr(404, "chat.errors.not_found");
	return shape(r);
}

const shape = (r) => ({
	id: Number(r.id),
	id_room: r.id_room,
	body: r.body,
	files: (typeof r.files === "string" ? JSON.parse(r.files) : r.files) || [],
	id_thread: r.id_thread ? Number(r.id_thread) : null,
	urgent: !!r.urgent,
	send_at: iso(r.send_at),
	status: r.status,
	error: r.error,
	id_message: r.id_message ? Number(r.id_message) : null,
	room_name: r.room_name,
});

/** Заплановані людиною (у чаті або всі), а також ті, що не вдалося надіслати */
async function list(uid, idRoom = null) {
	const [rows] = await pool.query(
		`SELECT s.id, s.id_room, s.body, s.files, s.id_thread, s.urgent, ${UTC_FMT("s.send_at")} AS send_at, s.status, s.error, s.id_message, r.name AS room_name
		   FROM ${T.scheduled} s JOIN ${T.rooms} r ON r.id = s.id_room
		  WHERE s.id_user = ? AND s.status IN ('wait', 'failed') ${idRoom ? "AND s.id_room = ?" : ""}
		  ORDER BY s.status = 'failed' DESC, s.send_at
		  LIMIT 200`,
		idRoom ? [uid, idRoom] : [uid]
	);
	return { scheduled: rows.map(shape) };
}

/** Скасувати (або прибрати невдале) */
async function cancel(uid, id) {
	const [r] = await pool.query(`UPDATE ${T.scheduled} SET status = 'cancelled' WHERE id = ? AND id_user = ? AND status IN ('wait', 'failed')`, [id, uid]);
	if (!r.affectedRows) throw httpErr(404, "chat.errors.not_found");
	return { ok: true };
}

/** Змінити час */
async function reschedule(uid, id, sendAt) {
	const at = toUtc(sendAt, "send_at");
	const [r] = await pool.query(`UPDATE ${T.scheduled} SET send_at = ?, status = 'wait', error = NULL WHERE id = ? AND id_user = ? AND status IN ('wait', 'failed')`, [at, id, uid]);
	if (!r.affectedRows) throw httpErr(404, "chat.errors.not_found");
	return { scheduled: await one(uid, id) };
}

// Ключ повтору для запланованого: якщо процес упаде між надсиланням і позначкою, повторна спроба не створить дубль
const clientIdOf = (id) => "00000000-0000-4000-8000-" + Number(id).toString(16).padStart(12, "0");

/** Надіслати заплановане зараз (не чекаючи часу) */
async function sendNow(uid, id) {
	const [r] = await pool.query(`UPDATE ${T.scheduled} SET send_at = UTC_TIMESTAMP(), status = 'wait', error = NULL WHERE id = ? AND id_user = ? AND status IN ('wait', 'failed')`, [id, uid]);
	if (!r.affectedRows) throw httpErr(404, "chat.errors.not_found");
	await sendDue();
	const [[x]] = await pool.query(`SELECT status, error, id_message FROM ${T.scheduled} WHERE id = ?`, [id]);
	if (x.status === "failed") throw httpErr(400, x.error || "chat.errors.server");
	return { id_message: x.id_message ? Number(x.id_message) : null };
}

/**
 * Надіслати те, чому настав час. Рядок спершу «займаємо» (status → sent без id_message),
 * щоб паралельний запуск не надіслав його вдруге; помилка — status failed з ключем перекладу.
 * Зайняті, але не позначені за 5 хв (процес перезапустився) — повертаємо в чергу; дубля не буде завдяки client_id.
 */
async function sendDue() {
	const messages = require("./messages");
	await pool.query(`UPDATE ${T.scheduled} SET status = 'wait' WHERE status = 'sent' AND id_message IS NULL AND send_at < UTC_TIMESTAMP() - INTERVAL 5 MINUTE`);
	const [due] = await pool.query(`SELECT id FROM ${T.scheduled} WHERE status = 'wait' AND send_at <= UTC_TIMESTAMP() ORDER BY send_at LIMIT 50`);
	for (const { id } of due) {
		const [claim] = await pool.query(`UPDATE ${T.scheduled} SET status = 'sent' WHERE id = ? AND status = 'wait'`, [id]);
		if (!claim.affectedRows) continue;
		const [[s]] = await pool.query(`SELECT s.*, u.active FROM ${T.scheduled} s JOIN ${T.users} u ON u.id = s.id_user WHERE s.id = ?`, [id]);
		try {
			if (!s || Number(s.active) !== 1) throw httpErr(403, "chat.errors.forbidden");
			const perms = await permsOf(s.id_user);
			if (!perms.view) throw httpErr(403, "chat.errors.forbidden");
			const fileIds = (typeof s.files === "string" ? JSON.parse(s.files) : s.files) || [];
			const records = (typeof s.records === "string" ? JSON.parse(s.records) : s.records) || [];
			const msg = await messages.send(
				Number(s.id_user),
				s.id_room,
				{ body: s.body, files: fileIds, records, id_reply: s.id_reply ? Number(s.id_reply) : null, id_thread: s.id_thread ? Number(s.id_thread) : null, urgent: !!s.urgent, client_id: clientIdOf(id) },
				perms
			);
			await pool.query(`UPDATE ${T.scheduled} SET id_message = ? WHERE id = ?`, [msg.id, id]);
			realtime.emitToUsers([s.id_user], "chat:scheduled", { id: Number(id), status: "sent", id_room: s.id_room, id_message: msg.id });
		} catch (e) {
			if (!e.status) logging.error("[chat] scheduled", e);
			const key = e.status ? e.message : "chat.errors.server";
			await pool.query(`UPDATE ${T.scheduled} SET status = 'failed', error = ? WHERE id = ?`, [String(key).slice(0, 255), id]);
			if (s) realtime.emitToUsers([s.id_user], "chat:scheduled", { id: Number(id), status: "failed", id_room: s.id_room, error: key });
		}
	}
	return due.length;
}

// ═══ НАГАДУВАННЯ ══════════════════════════════════════

/** ifNoReply — нагадати, лише якщо до того часу ніхто інший не відповів (див. replied) */
async function remind(uid, idMessage, remindAt, note, ifNoReply = false) {
	const [[msg]] = await pool.query(`SELECT id, id_room, deleted_at FROM ${T.messages} WHERE id = ?`, [idMessage]);
	if (!msg || msg.deleted_at) throw httpErr(404, "chat.errors.not_found");
	await membership(msg.id_room, uid);
	const at = toUtc(remindAt, "remind_at");
	const [[n]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.reminders} WHERE id_user = ? AND done = 0`, [uid]);
	if (Number(n.n) >= MAX_REMINDERS) throw httpErr(400, "chat.errors.too_many_reminders");
	const [r] = await pool.query(`INSERT INTO ${T.reminders} (id_user, id_message, remind_at, note, if_no_reply, done, date_add) VALUES (?, ?, ?, ?, ?, 0, NOW())`, [uid, idMessage, at, note || null, Number(!!ifNoReply)]);
	return { reminder: (await reminders(uid, r.insertId)).reminders[0] };
}

/**
 * Чи відповіли на повідомлення інші: відповідь у треді, відповідь із цитатою,
 * в особистому чаті — будь-яке наступне повідомлення співрозмовника.
 */
async function replied(idMessage, uid) {
	const [[r]] = await pool.query(
		`SELECT EXISTS (
		    SELECT 1 FROM ${T.messages} x JOIN ${T.messages} src ON src.id = ? JOIN ${T.rooms} room ON room.id = src.id_room
		     WHERE x.id_room = src.id_room AND x.deleted_at IS NULL AND x.type = 'text' AND x.id_user <> ? AND x.id > src.id
		       AND (x.id_thread = src.id OR x.id_reply = src.id OR (room.type = 'direct' AND x.id_thread IS NULL AND src.id_thread IS NULL)
		            OR (src.id_thread IS NOT NULL AND x.id_thread = src.id_thread))
		  ) AS yes`,
		[idMessage, uid]
	);
	return Number(r.yes) === 1;
}

/** Мої нагадування, що ще не спрацювали */
async function reminders(uid, onlyId = null) {
	const [rows] = await pool.query(
		`SELECT x.id, x.id_message, ${UTC_FMT("x.remind_at")} AS remind_at, x.note, m.id_room, m.id_thread, LEFT(m.body, 300) AS body, m.has_files, r.name AS room_name, r.type AS room_type
		   FROM ${T.reminders} x
		   JOIN ${T.messages} m ON m.id = x.id_message
		   JOIN ${T.rooms} r ON r.id = m.id_room
		   JOIN ${T.members} mem ON mem.id_room = m.id_room AND mem.id_user = x.id_user
		  WHERE x.id_user = ? AND x.done = 0 ${onlyId ? "AND x.id = ?" : ""}
		  ORDER BY x.remind_at
		  LIMIT 200`,
		onlyId ? [uid, onlyId] : [uid]
	);
	return {
		reminders: rows.map((r) => ({
			id: Number(r.id),
			id_message: Number(r.id_message),
			id_room: r.id_room,
			id_thread: r.id_thread ? Number(r.id_thread) : null,
			remind_at: iso(r.remind_at),
			note: r.note,
			body: r.body ? mentions.plain(r.body) : null,
			has_files: !!r.has_files,
			room_name: r.room_type === "direct" ? null : r.room_name,
		})),
	};
}

async function cancelReminder(uid, id) {
	const [r] = await pool.query(`UPDATE ${T.reminders} SET done = 1 WHERE id = ? AND id_user = ? AND done = 0`, [id, uid]);
	if (!r.affectedRows) throw httpErr(404, "chat.errors.not_found");
	return { ok: true };
}

/** Спрацювати нагадування: подія на сторінку і web-push (нагадування люди ставлять собі самі — «не турбувати» не діє) */
async function remindDue() {
	const [due] = await pool.query(`SELECT id, id_user FROM ${T.reminders} WHERE done = 0 AND remind_at <= UTC_TIMESTAMP() ORDER BY remind_at LIMIT 100`);
	for (const { id, id_user: uid } of due) {
		const [claim] = await pool.query(`UPDATE ${T.reminders} SET done = 1 WHERE id = ? AND done = 0`, [id]);
		if (!claim.affectedRows) continue;
		try {
			const [[x]] = await pool.query(
				`SELECT x.note, x.if_no_reply, m.id AS id_message, m.id_room, m.id_thread, m.body, m.deleted_at, r.code AS room_code
				   FROM ${T.reminders} x JOIN ${T.messages} m ON m.id = x.id_message
				   JOIN ${T.rooms} r ON r.id = m.id_room
				   JOIN ${T.members} mem ON mem.id_room = m.id_room AND mem.id_user = x.id_user
				  WHERE x.id = ?`,
				[id]
			);
			if (!x || x.deleted_at) continue;
			if (x.if_no_reply && (await replied(Number(x.id_message), Number(uid)))) continue;
			const body = x.body ? mentions.plain(x.body).replace(/\s+/g, " ").slice(0, 160) : "";
			const payload = { id: Number(id), id_message: Number(x.id_message), id_room: x.id_room, code: x.room_code, id_thread: x.id_thread ? Number(x.id_thread) : null, note: x.note, body };
			realtime.emitToUsers([uid], "chat:reminder", payload);
			const { notify } = require("../notifications");
			await notify({
				type: "chat.reminder",
				audience: { user: Number(uid) },
				channels: ["webpush"],
				key: `chat:reminder:${id}`,
				payload: { title: "⏰ " + (x.note || body).slice(0, 120), body: x.note ? body : "", url: roomLink(x.room_code, x.id_message), tag: `chat-reminder-${id}` },
			}).catch((e) => logging.error("[chat] reminder push", e));
		} catch (e) {
			logging.error("[chat] reminder", e);
		}
	}
	return due.length;
}

module.exports = { create, list, cancel, reschedule, sendNow, sendDue, remind, reminders, cancelReminder, remindDue, permsOf, toUtc };