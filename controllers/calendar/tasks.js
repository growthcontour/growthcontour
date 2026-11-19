"use strict";

/**
 * Системні задачі в календарі (автозадачі, нагадування з модулів).
 * Задача — звичайна подія календаря: власник = виконавець, видима лише йому, сповіщення — лише йому.
 * Працює в транзакції того, хто викликає (conn), щоб задача й запис у журналі автоматизації комітились разом.
 */
const config = require("../../config/config");
const calLinks = require("./links");

const P = config.get("configDatabase").prefix;

// Ті самі значення, що й у календарі (routes/index/index.js)
const STATUS_PLANNED = 1;
const RESPONSE_ACCEPTED = 1;
const VISIBILITY_PRIVATE = 1;
const NOTIFY_ME = 1;

const pad = (n) => String(n).padStart(2, "0");
// Локальний час сервера у форматі календаря: YYYY-MM-DD HH:MM:SS
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * Створити задачу. Повертає id події.
 * o: { idUser, title, description, start (Date|рядок), durationMin, idEventType, priority (1–4), reminderMinutes, links: [{type, id}] }
 */
async function createTask(o, conn) {
	if (!conn) throw new Error("createTask: transaction connection is required");
	const idUser = parseInt(o && o.idUser, 10);
	if (!(idUser > 0)) throw new Error("createTask: idUser is required");

	const start = o.start instanceof Date ? o.start : new Date(o.start || Date.now());
	if (isNaN(start)) throw new Error("createTask: invalid start");
	const end = new Date(start.getTime() + Math.max(5, parseInt(o.durationMin, 10) || 15) * 60000);
	const title = String(o.title || "").trim().slice(0, 255) || "—";
	const description = o.description ? String(o.description).slice(0, 65000) : null;
	const priority = Math.min(4, Math.max(1, parseInt(o.priority, 10) || 2));
	const reminder = parseInt(o.reminderMinutes, 10) > 0 ? parseInt(o.reminderMinutes, 10) : null;
	const idEventType = parseInt(o.idEventType, 10) > 0 ? parseInt(o.idEventType, 10) : null;

	const [r] = await conn.query(
		`INSERT INTO \`${P}calendar_events\`
		   (id_user_creator, id_event_type, title, description, location, location_url,
		    date_start, date_end, all_day, tz_offset,
		    priority, status, is_shared, visibility, notify_scope, is_busy,
		    participants_cnt, reminder_minutes, id_ref_type, id_ref,
		    active, date_add, date_edit)
		 VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?, ?, ?, 0, ?, ?, 1, 1, ?, NULL, NULL, 1, NOW(), NOW())`,
		[idUser, idEventType, title, description, fmt(start), fmt(end), 0, priority, STATUS_PLANNED, VISIBILITY_PRIVATE, NOTIFY_ME, reminder]
	);
	const idEvent = r.insertId;

	await conn.query(
		`INSERT INTO \`${P}calendar_event_users\` (id_user, date_start, id_event, date_end, is_owner, response, is_hidden, active, date_add)
		 VALUES (?, ?, ?, ?, 1, ?, 0, 1, NOW())`,
		[idUser, fmt(start), idEvent, fmt(end), RESPONSE_ACCEPTED]
	);

	// Нагадування: kind 1 — заздалегідь (якщо задано), kind 2 — у момент початку; лише майбутні
	const now = Date.now();
	const rows = [];
	if (reminder && start.getTime() - reminder * 60000 > now) rows.push([idEvent, idUser, 1, new Date(start.getTime() - reminder * 60000)]);
	if (start.getTime() > now) rows.push([idEvent, idUser, 2, start]);
	if (rows.length) {
		await conn.query(
			`INSERT INTO \`${P}calendar_reminder_queue\` (id_event, id_user, kind, date_fire, sent, attempts)
			 VALUES ${rows.map(() => "(?, ?, ?, ?, 0, 0)").join(", ")}
			 ON DUPLICATE KEY UPDATE date_fire = VALUES(date_fire), sent = 0, attempts = 0`,
			rows.flat()
		);
	}

	await calLinks.save(conn, idEvent, o.links || []);
	return idEvent;
}

module.exports = { createTask };