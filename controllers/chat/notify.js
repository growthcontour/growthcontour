"use strict";

/**
 * Чат компанії: кому і як сповіщати про повідомлення.
 *
 * Хто в мережі — отримує подію в реальному часі; звук і сповіщення на робочому столі вмикає сторінка,
 * питаючи quiet() (статус «не турбувати» або неробочий час за графіком офісу).
 * Хто не в мережі — web-push у браузер, якщо дозволяють налаштування чату:
 *   none / вимкнено на час — лише термінові;  mentions — особисті чати, згадки, треди, термінові;  all — усе.
 * «Не турбувати» і неробочий час — лише термінові.
 * Термінові: повтор сповіщення через 2, 4, 8, 16 хв, доки адресат не прочитає (до 5 разів).
 */
const { pool, T, roomLink } = require("./common");
const realtime = require("./realtime");
const mentions = require("./mentions");
const logging = require("../../logging/logging");
const i18n = require("../../config/i18n/i18n");

const LOCALE = process.env.APP_LOCALE || "uk";
const t = (phrase, vars) => i18n.__({ phrase, locale: LOCALE }, vars || {});

const URGENT_ATTEMPTS = 5;
const URGENT_PER_DAY = 5;

function socketApi() {
	try {
		return require("../socket/socket");
	} catch {
		return null;
	}
}

/** Тиша для людини: статус «не турбувати» або поза робочим часом офісу */
async function quiet(uid) {
	const [[st]] = await pool.query(`SELECT status FROM ${T.status} WHERE id_user = ? AND (until IS NULL OR until > NOW())`, [uid]);
	if (st && st.status === "dnd") return { quiet: true, reason: "dnd" };
	try {
		const company = require("../company/people");
		const ctx = await company.context(uid);
		if (company.isWorkingAt(ctx) === false) return { quiet: true, reason: "off_hours" };
	} catch (e) {
		logging.error("[chat] quiet", e);
	}
	return { quiet: false, reason: null };
}

async function quietMany(ids) {
	const out = new Set();
	for (const id of ids) if ((await quiet(id)).quiet) out.add(id);
	return out;
}

function preview(msg) {
	if (msg.body) return mentions.plain(msg.body).replace(/\s+/g, " ").slice(0, 160);
	if (msg.files && msg.files.length) return `📎 ${msg.files[0].name}`;
	return "";
}

async function push(uid, payload, key, collapseKey) {
	const { notify } = require("../notifications");
	await notify({ type: "chat.message", audience: { user: uid }, channels: ["webpush"], key, collapseKey, payload }).catch((e) => logging.error("[chat] webpush", e));
}

/**
 * Після надсилання: web-push тим, хто не в мережі.
 * room — membership() автора; mentioned — Set id згаданих; thread — учасники треду (Set) або null
 */
async function onMessage(room, msg, { mentioned = new Set(), thread = null } = {}) {
	const [rows] = await pool.query(
		`SELECT m.id_user, m.notify, (m.muted_until IS NOT NULL AND m.muted_until > NOW()) AS muted
		   FROM ${T.members} m JOIN ${T.users} u ON u.id = m.id_user AND u.active = 1
		  WHERE m.id_room = ? AND m.id_user <> ?`,
		[room.id, msg.id_user]
	);
	const s = socketApi();
	const want = rows.filter((r) => {
		const uid = Number(r.id_user);
		if (thread && !thread.has(uid) && !mentioned.has(uid)) return false;
		if (msg.urgent) return true;
		if (r.notify === "none" || Number(r.muted)) return false;
		// Події системи — лише тим, хто хоче все (інакше стрічка подій засипле сповіщеннями)
		if (msg.type === "event") return r.notify === "all";
		if (r.notify === "mentions") return room.type === "direct" || mentioned.has(uid) || !!thread;
		return true;
	});
	const offline = want.map((r) => Number(r.id_user)).filter((u) => !(s && s.isUserOnline(u)));
	if (!offline.length) return;
	const silent = msg.urgent ? new Set() : await quietMany(offline);

	const title = (msg.urgent ? "❗ " : "") + (room.type === "direct" ? (msg.author && msg.author.name) || "" : `${room.name || ""}${msg.author ? " · " + msg.author.name : ""}`);
	const url = roomLink(room.code, msg.id);
	for (const u of offline) {
		if (silent.has(u)) continue;
		await push(u, { title, body: preview(msg), url, tag: `chat-${room.id}` }, `chat:${msg.id}:${u}`, `chat:${room.id}`);
	}
}

/**
 * Згадали особисто (@Ім'я) у групі чи каналі — сповіщення в дзвіночку, вкладка «Особисті».
 * Згадки відділу, офісу, «всіх» сюди не йдуть (для сотень людей це був би шум — їм лишається лічильник «@» у чаті).
 * Хто вимкнув сповіщення чату повністю (none), не отримує й цього.
 */
async function mentionInbox(room, msg, ids) {
	if (!ids.length || room.type === "direct" || room.type === "notes") return;
	const [rows] = await pool.query(`SELECT id_user FROM ${T.members} WHERE id_room = ? AND id_user IN (?) AND notify <> 'none'`, [room.id, ids]);
	if (!rows.length) return;
	const { notify } = require("../notifications");
	const author = (msg.author && msg.author.name) || "";
	const title = t("chat.notify.mention_title", { user: author, room: room.name || "" });
	const url = roomLink(room.code, msg.id);
	for (const r of rows) {
		await notify({
			type: "personal.chat_mention",
			audience: { user: Number(r.id_user) },
			channels: ["inapp"],
			key: `chat:mention:${msg.id}:${r.id_user}`,
			payload: { title, name: room.name || "", message: preview(msg), url },
		}).catch((e) => logging.error("[chat] mention inbox", e));
	}
}

/** Термінове: скільки людина вже надіслала за добу (ліміт) */
async function urgentLeft(uid, conn = pool) {
	const [[r]] = await conn.query(`SELECT COUNT(*) AS n FROM ${T.messages} WHERE id_user = ? AND urgent = 1 AND date_add > NOW(3) - INTERVAL 1 DAY`, [uid]);
	return Math.max(0, URGENT_PER_DAY - Number(r.n));
}

/** Запланувати повтори для термінового повідомлення */
async function scheduleUrgent(conn, idMessage, recipients) {
	if (!recipients.length) return;
	// Час — у UTC засобами MySQL (часовий пояс сервера бази може бути будь-яким)
	await conn.query(
		`INSERT IGNORE INTO ${T.urgent} (id_message, id_user, attempts, next_at) VALUES ${recipients.map(() => "(?, ?, 0, UTC_TIMESTAMP() + INTERVAL 2 MINUTE)").join(", ")}`,
		recipients.flatMap((u) => [idMessage, u])
	);
}

/** Повтори термінових: раз на хвилину */
async function urgentTick() {
	const [rows] = await pool.query(
		`SELECT x.id_message, x.id_user, x.attempts, m.id_room, m.id_thread, m.id_user AS author, m.body, m.deleted_at,
		        mem.last_read_id, th.last_read_id AS thread_read, r.code AS room_code, r.type AS room_type, r.name AS room_name
		   FROM ${T.urgent} x
		   JOIN ${T.messages} m ON m.id = x.id_message
		   JOIN ${T.rooms} r ON r.id = m.id_room
		   LEFT JOIN ${T.members} mem ON mem.id_room = m.id_room AND mem.id_user = x.id_user
		   LEFT JOIN ${T.threads} th ON th.id_thread = m.id_thread AND th.id_user = x.id_user
		  WHERE x.done = 0 AND x.next_at <= UTC_TIMESTAMP()
		  LIMIT 200`
	);
	for (const r of rows) {
		const read = r.id_thread ? Number(r.thread_read || 0) >= Number(r.id_message) : Number(r.last_read_id || 0) >= Number(r.id_message);
		if (read || r.deleted_at || r.last_read_id == null || r.attempts + 1 >= URGENT_ATTEMPTS) {
			await pool.query(`UPDATE ${T.urgent} SET done = 1 WHERE id_message = ? AND id_user = ?`, [r.id_message, r.id_user]);
			if (read || r.deleted_at || r.last_read_id == null) continue;
		} else {
			const delay = 2 * 2 ** (r.attempts + 1); // 4, 8, 16, 32 хв
			await pool.query(`UPDATE ${T.urgent} SET attempts = attempts + 1, next_at = UTC_TIMESTAMP() + INTERVAL ? MINUTE WHERE id_message = ? AND id_user = ?`, [delay, r.id_message, r.id_user]);
		}
		const [[a]] = await pool.query(`SELECT TRIM(CONCAT_WS(' ', first_name, last_name)) AS name FROM ${T.users} WHERE id = ?`, [r.author]);
		const name = (a && a.name) || "";
		const payload = { id_message: Number(r.id_message), id_room: r.id_room, code: r.room_code, id_thread: r.id_thread, author: name, body: mentions.plain(r.body).slice(0, 160) };
		realtime.emitToUsers([r.id_user], "chat:urgent", payload);
		await push(r.id_user, { title: `❗ ${r.room_type === "direct" ? name : (r.room_name || "") + " · " + name}`, body: payload.body, url: roomLink(r.room_code, r.id_message), tag: `chat-urgent-${r.id_message}` }, `chat:urgent:${r.id_message}:${r.id_user}:${r.attempts + 1}`, `chat-urgent-${r.id_message}`);
	}
	return rows.length;
}

/** Прочитав — повтори термінових у цьому чаті / треді для людини більше не потрібні */
async function urgentRead(uid, upToId, { idRoom = null, idThread = null } = {}) {
	await pool.query(
		`UPDATE ${T.urgent} x JOIN ${T.messages} m ON m.id = x.id_message
		    SET x.done = 1
		  WHERE x.id_user = ? AND x.done = 0 AND m.id <= ? AND ${idThread ? "m.id_thread = ?" : "m.id_room = ? AND m.id_thread IS NULL"}`,
		[uid, upToId, idThread || idRoom]
	);
}

module.exports = { quiet, onMessage, mentionInbox, urgentLeft, scheduleUrgent, urgentTick, urgentRead, URGENT_PER_DAY };