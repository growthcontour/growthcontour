const pool = require("../../config/database/connection_pool");
const logging = require("../../logging/logging");
const cfg = require("../../config/notifications/config");

const P = cfg.prefix;

// ── Резолв аудиторії → масив user_id ──
async function resolveRecipients(conn, aud) {
	if (aud.type === "user") return [Number(aud.ref)];

	if (aud.type === "group") {
		const [rows] = await conn.query(`SELECT id_user FROM ${P}users_to_groups WHERE id_group = ?`, [aud.ref]);
		return rows.map((r) => Number(r.id_user));
	}

	if (aud.type === "topic") {
		const [rows] = await conn.query(`SELECT user_id FROM ${P}notif_subscriptions WHERE topic = ?`, [aud.ref]);
		return rows.map((r) => Number(r.user_id));
	}

	return null; // broadcast
}

// ── In-app доставка через socket.io (прямо, без channels/queue) ──
function pushInApp(uid, eventId, ev, payload) {
	try {
		const { getIO } = require("../socket/socket");
		const server = getIO();
		console.log("[inapp-direct] server?", !!server, "user", uid);
		if (!server) return;

		const room = `io_manager_notifications_${uid}`;
		const data = {
			event_id: eventId,
			type: ev.event_type,
			tab: tabByType(ev.event_type),
			title: payload && payload.title,
			name: payload && payload.name,
			message: payload && payload.message,
			url: payload && payload.url,
			channel: payload && payload.channel,
			count: payload && payload.count,
			date: payload && payload.date,
			collapse_key: ev.collapse_key,
		};

		// Ім'я події ДОРІВНЮЄ назві кімнати — саме це слухає script.ejs
		console.log("[inapp-direct] emit →", room);
		server.to(room).emit(room, data);
		server.to("io_notifications_header").emit("io_notifications_header", data);
	} catch (e) {
		console.log("[inapp-direct] ERROR:", e.message, e.stack);
		logging.error(e);
	}
}

function tabByType(eventType) {
	const map = cfg.tabByType || {};
	if (map[eventType]) return map[eventType];
	const prefix = String(eventType || "").split(".")[0];
	return map[prefix] || cfg.defaultTab || "personal";
}

// ── Головна функція розвезення події ──
async function dispatchEvent(eventId) {
	const conn = await pool.getConnection();
	try {
		const [[ev]] = await conn.query(`SELECT * FROM ${P}notif_events WHERE id = ?`, [eventId]);
		console.log("[dispatch] event", eventId, "found:", !!ev);
		if (!ev) return;

		// Атомарний claim: подію обробляє РІВНО ОДИН диспетчер.
		// Захист від гонки черги і fallback-полера outbox → без подвійного push.
		const [claim] = await conn.query(`UPDATE ${P}notif_events SET dispatched = 1 WHERE id = ? AND dispatched = 0`, [eventId]);
		if (claim.affectedRows === 0) {
			console.log("[dispatch] event", eventId, "вже оброблено — пропуск");
			return;
		}

		const channels = Array.isArray(ev.channels) ? ev.channels : JSON.parse(ev.channels || '["inapp"]');
		console.log("[dispatch] channels:", channels);

		const payload = typeof ev.payload === "string" ? JSON.parse(ev.payload) : ev.payload;

		const aud = { type: ev.audience_type, ref: ev.audience_ref };
		const recipients = await resolveRecipients(conn, aud);
		console.log("[dispatch] recipients:", recipients);

		// BROADCAST або понад поріг → read-time, не матеріалізуємо
		if (recipients === null || recipients.length > cfg.fanoutThreshold) {
			await conn.query(`UPDATE ${P}notif_events SET materialized = 0, dispatched = 1 WHERE id = ?`, [eventId]);
			return;
		}

		// ── FAN-OUT ON WRITE ──
		await conn.beginTransaction();
		const wantsInapp = channels.includes("inapp");
		for (const uid of recipients) {
			// інбокс лише якщо подія має in-app канал (телеграм-адресату inbox не потрібен)
			if (wantsInapp) {
				await conn.query(
					`INSERT IGNORE INTO ${P}notif_inbox (event_id, user_id, collapse_key)
           VALUES (?,?,?)`,
					[eventId, uid, ev.collapse_key]
				);
			}
			// рядки доставки для зовнішніх каналів (крім inapp)
			for (const ch of channels) {
				if (ch === "inapp") continue;
				await conn.query(
					`INSERT IGNORE INTO ${P}notif_delivery (event_id, user_id, channel, status)
           VALUES (?,?,?, 'pending')`,
					[eventId, uid, ch]
				);
			}
		}
		await conn.query(`UPDATE ${P}notif_events SET materialized = 1, dispatched = 1 WHERE id = ?`, [eventId]);
		await conn.commit();

		// ── Доставка поза транзакцією ──
		const queue = require("./queue");
		for (const uid of recipients) {
			if (channels.includes("inapp")) {
				pushInApp(uid, eventId, ev, payload);
			}
			for (const ch of channels) {
				if (ch === "inapp") continue;
				await queue
					.enqueueSend(ch, {
						channel: ch,
						eventId,
						userId: uid,
						eventType: ev.event_type,
						collapseKey: ev.collapse_key,
						payload,
					})
					.catch((e) => logging.error(e));
			}
		}
	} catch (error) {
		await conn.rollback().catch(() => {});
		console.log("[dispatch] ERROR:", error.message, error.stack);
		logging.error(error);
		throw error;
	} finally {
		conn.release();
	}
}

module.exports = { dispatchEvent };
