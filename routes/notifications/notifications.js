const express = require("express");
const crypto = require("crypto");
const router = express.Router();

// Controllers
const authorizationControllers = require("../../controllers/authorization/authorization");
// END Controllers

//Database connection
const connection = require("../../config/database/database");
const connection_pool = require("../../config/database/connection_pool");
//END Database connection

// Configuration
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
const notifyCfg = require("../../config/notifications/config");
// END Configuration

// Logging
const logging = require("../../logging/logging");
// END Logging

const { getIO } = require("../../controllers/socket/socket");
const io = getIO();

router.post("/api/notifications/list/", authorizationControllers.isAuthenticated, async (req, res) => {
	const userId = req.user.id;
	const P = configDatabase.prefix;

	const resolveTab = (t) => {
		const map = notifyCfg.tabByType || {};
		return map[t] || map[String(t).split(".")[0]] || notifyCfg.defaultTab || "personal";
	};

	try {
		const [rows] = await connection_pool.query(
			`SELECT i.event_id, i.collapse_key, i.read_at, i.created_at,
              e.event_type, e.payload,
              (SELECT COUNT(*)
                 FROM ${P}notif_inbox AS c
                WHERE c.user_id = i.user_id
                  AND c.archived_at IS NULL
                  AND c.read_at IS NULL
                  AND c.collapse_key = i.collapse_key
                  AND c.collapse_key <> ''
              ) AS unread_count
         FROM ${P}notif_inbox AS i
         JOIN ${P}notif_events AS e ON e.id = i.event_id
         JOIN (
           SELECT COALESCE(collapse_key, CAST(event_id AS CHAR)) AS ck, MAX(event_id) AS max_eid
             FROM ${P}notif_inbox
            WHERE user_id = ? AND archived_at IS NULL
            GROUP BY ck
         ) latest
           ON i.event_id = latest.max_eid
        WHERE i.user_id = ? AND i.archived_at IS NULL
        ORDER BY i.event_id DESC
        LIMIT 50`,
			[userId, userId]
		);

		const list = rows.map((r) => {
			const payload = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
			return {
				event_id: r.event_id,
				tab: resolveTab(r.event_type),
				title: payload && payload.title,
				message: payload && payload.message,
				url: payload && payload.url,
				channel: payload && payload.channel, // ← телеграм-дизайн
				count: Number(r.unread_count) || (payload && payload.count) || 0,
				date: payload && payload.date, // ← дата з payload
				collapse_key: r.collapse_key,
				read: !!r.read_at,
				date_add: r.created_at,
			};
		});

		res.send(list);
	} catch (e) {
		logging.error(e);
		res.status(500).send([]);
	}
});

router.post("/api/notifications/delete/contact-center/", authorizationControllers.isAuthenticated, async (req, res) => {
	const { id_chat } = req.body;
	const manager_id = req.user.id;

	if (!id_chat) {
		return res.status(400).json({ error: "id_chat обов'язковий" });
	}

	try {
		// Скидаємо персональний лічильник тільки для цього менеджера
		await connection_pool.query(
			`DELETE FROM ${configDatabase.prefix}telegram_unread
             WHERE chat_id = ? AND manager_id = ?`,
			[id_chat, manager_id]
		);

		res.status(200).json({ success: true });
	} catch (error) {
		console.error(error);
		logging.error(error);
		res.status(500).json({ error: "Помилка сервера" });
	}
});

// Позначити всі inapp-сповіщення користувача як побачені (seen)
router.post("/api/notifications/seen/", authorizationControllers.isAuthenticated, async (req, res) => {
	const userId = req.user.id;
	const P = configDatabase.prefix;
	try {
		await connection_pool.query(
			`UPDATE ${P}notif_inbox
          SET seen_at = NOW(3)
        WHERE user_id = ? AND seen_at IS NULL`,
			[userId]
		);
		// Скинути Redis-лічильник непрочитаного (якщо bull-режим)
		res.status(200).json({ success: true });
	} catch (e) {
		logging.error(e);
		console.log(error);
		res.status(500).json({ error: "server_error" });
	}
});

// Архівувати одне сповіщення користувача (натиск на "x")
router.post("/api/notifications/delete/", authorizationControllers.isAuthenticated, async (req, res) => {
	const userId = req.user.id;
	const P = configDatabase.prefix;
	const { event_id, collapse_key } = req.body;

	if (!event_id && !collapse_key) return res.status(400).json({ error: "потрібен event_id або collapse_key" });

	try {
		let ck = collapse_key;

		// Якщо collapse_key не передали — дістанемо його з події
		if (!ck && event_id) {
			const [[row]] = await connection_pool.query(`SELECT collapse_key FROM ${P}notif_inbox WHERE user_id = ? AND event_id = ? LIMIT 1`, [userId, event_id]);
			ck = row && row.collapse_key;
		}

		if (ck) {
			// архівуємо ВСІ події цього чату для юзера
			await connection_pool.query(
				`UPDATE ${P}notif_inbox
            SET archived_at = NOW(3)
          WHERE user_id = ? AND collapse_key = ?`,
				[userId, ck]
			);

			// телеграм-чат → скинути персональний лічильник
			const m = String(ck).match(/^telegram:(.+)$/);
			if (m) {
				await connection_pool.query(`DELETE FROM ${P}telegram_unread WHERE chat_id = ? AND manager_id = ?`, [m[1], userId]).catch((e) => logging.error(e));
			}

			// контакт-центр → зсунути позначку прочитаного на останнє повідомлення діалогу
			const cc = String(ck).match(/^cc_conv_(\d+)$/);
			if (cc) {
				await require("../../controllers/contact-center/model")
					.markRead(Number(cc[1]), userId)
					.catch((e) => logging.error(e));
			}
		} else if (event_id) {
			await connection_pool.query(`UPDATE ${P}notif_inbox SET archived_at = NOW(3) WHERE user_id = ? AND event_id = ?`, [userId, event_id]);
		}

		res.status(200).json({ success: true });
	} catch (e) {
		logging.error(e);
		res.status(500).json({ error: "server_error" });
	}
});
// END POST

module.exports = router;
