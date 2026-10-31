const express = require("express");
const router = express.Router();
const crypto = require("crypto");

const connection_pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const logging = require("../../../logging/logging");
const types = require("../../../controllers/contact-center/channels/index");
const model = require("../../../controllers/contact-center/model");
const realtime = require("../../../controllers/contact-center/realtime");
const ccNotifications = require("../../../controllers/contact-center/notifications");

const P = config.get("configDatabase").prefix;

// Локальний час сервера у форматі "YYYY-MM-DD HH:MM:SS" — той самий,
// що getMessages віддає з БД. Без toISOString (він перегонить у UTC і зсуває зону).
function formatLocal(d) {
	const dt = d instanceof Date ? d : new Date(d);
	const p = (n) => String(n).padStart(2, "0");
	return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate()) + " " + p(dt.getHours()) + ":" + p(dt.getMinutes()) + ":" + p(dt.getSeconds());
}

// Спільна обробка нормалізованого повідомлення
async function handleIncoming(idChannel, channelType, normalized) {
	if (!normalized) return;

	const result = await model.addIncoming({
		id_channel: idChannel,
		contact: normalized.contact,
		source_thread_id: normalized.source_thread_id,
		message: normalized.message,
	});

	// Повтор вебхука — нічого не робимо
	if (result.duplicate) return;

	const [rows] = await connection_pool.query(
		`SELECT c.id, c.id_channel, c.url_token, c.id_manager, c.status, c.messages_count,
                c.last_message_text, c.last_message_dir, c.date_last_message,
                ch.type AS channel, ch.name AS channel_name, ch.status AS channel_active,
                ct.name AS contact_name, ct.username AS contact_username,
				0 AS count
         FROM ${P}contact_center_conversations AS c
         INNER JOIN ${P}contact_center_channels AS ch ON ch.id = c.id_channel
         INNER JOIN ${P}contact_center_contacts AS ct ON ct.id = c.id_contact
         LEFT JOIN ${P}contact_center_unread AS ur ON ur.id_conversation = c.id AND ur.id_manager = c.id_manager
         WHERE c.id = ? LIMIT 1`,
		[result.id_conversation]
	);

	if (!rows.length) return;

	const r = rows[0];
	const meta = types.get(r.channel) || {};

	// Сповіщення менеджерам — після socket, поза критичним шляхом
	ccNotifications
		.notifyIncoming(
			{
				id: r.id,
				id_channel: r.id_channel,
				url_token: r.url_token,
				channel: r.channel,
				channel_name: r.channel_name,
				title: r.contact_name || (r.contact_username ? "@" + r.contact_username : "—"),
			},
			normalized.message,
			// Новий діалог — якщо це перше повідомлення або діалог відкрили заново
			result.reopened || Number(r.messages_count) <= 1
		)
		.catch(function (e) {
			console.error("cc notify:", e.message);
		});

	realtime.message({
		direction: "in",
		reopened: result.reopened,
		conversation: {
			id: r.id,
			url_token: r.url_token,
			channel: r.channel,
			channel_name: r.channel_name,
			channel_icon: meta.icon || "",
			channel_color: meta.color || "#6c757d",
			channel_active: Number(r.channel_active) === 1 ? 1 : 0,
			title: r.contact_name || (r.contact_username ? "@" + r.contact_username : "—"),
			preview: r.last_message_text || "",
			preview_dir: r.last_message_dir || "in",
			last_at: r.date_last_message,
			count: r.count | 0,
			status: r.id_manager === null ? 0 : 1,
			id_manager: r.id_manager,
		},
		message: Object.assign({ id: result.id_message, direction: "in", status: "delivered" }, normalized.message, {
			attachments: normalized.message.attachments || [],
			date_add: formatLocal(normalized.message.date_add || new Date()),
			reply_text: result.reply_text || null,
		}),
	});
}

/**
 * Echo: повідомлення, надіслане від імені сторінки / акаунта.
 * Наше (з контакт-центру) вже є в діалозі; написане прямо в Instagram / Facebook / Meta Business Suite —
 * додаємо як вихідне, щоб історія листування була повною.
 * Затримка: наш запит на відправку ще може чекати відповіді API і не встиг записати source_id.
 */
const ECHO_DELAY_MS = 30000; // відправка медіа з контакт-центру може тривати до 30 с
function scheduleEcho(idChannel, channelType, appId, normalized) {
	if (!normalized || !normalized.message || !normalized.message.source_id) return;
	// Надіслано нашим додатком (Facebook передає app_id) — це наше повідомлення
	if (normalized.app_id && appId && String(normalized.app_id) === String(appId)) return;
	setTimeout(() => {
		handleEcho(idChannel, channelType, normalized).catch((e) => {
			console.error("[cc-echo]", e.message);
			logging.error(e);
		});
	}, ECHO_DELAY_MS);
}

async function handleEcho(idChannel, channelType, normalized) {
	const [exists] = await connection_pool.query(`SELECT id FROM ${P}contact_center_messages WHERE id_channel = ? AND source_id = ? LIMIT 1`, [idChannel, normalized.message.source_id]);
	if (exists.length) return;

	const result = await model.addEcho({ id_channel: idChannel, contact: normalized.contact, source_thread_id: normalized.source_thread_id, message: normalized.message });
	if (!result || result.duplicate) return;

	const [rows] = await connection_pool.query(
		`SELECT c.id, c.url_token, c.id_manager, c.last_message_text, c.last_message_dir, c.date_last_message,
                ch.type AS channel, ch.name AS channel_name, ch.status AS channel_active,
                ct.name AS contact_name, ct.username AS contact_username
           FROM ${P}contact_center_conversations AS c
           INNER JOIN ${P}contact_center_channels AS ch ON ch.id = c.id_channel
           INNER JOIN ${P}contact_center_contacts AS ct ON ct.id = c.id_contact
          WHERE c.id = ? LIMIT 1`,
		[result.id_conversation]
	);
	if (!rows.length) return;
	const r = rows[0];
	const meta = types.get(r.channel) || {};
	realtime.message({
		direction: "out",
		reopened: false,
		conversation: {
			id: r.id,
			url_token: r.url_token,
			channel: r.channel,
			channel_name: r.channel_name,
			channel_icon: meta.icon || "",
			channel_color: meta.color || "#6c757d",
			channel_active: Number(r.channel_active) === 1 ? 1 : 0,
			title: r.contact_name || (r.contact_username ? "@" + r.contact_username : "—"),
			preview: r.last_message_text || "",
			preview_dir: r.last_message_dir || "out",
			last_at: r.date_last_message,
			count: 0,
			status: r.id_manager === null ? 0 : 1,
			id_manager: r.id_manager,
		},
		message: Object.assign({ id: result.id_message, direction: "out", status: "sent", external: true }, normalized.message, {
			attachments: normalized.message.attachments || [],
			date_add: formatLocal(normalized.message.date_add || new Date()),
		}),
	});
}

// ── Telegram ──
// Секрет у шляху: один URL на канал, чужий запит не пройде.
router.post(["/api/contact-center/webhook/telegram/:secret/", "/api/contact-center/webhook/telegram/:secret"], async (req, res) => {
	const secret = String(req.params.secret || "");
	if (!/^[a-f0-9]{64}$/.test(secret)) return res.sendStatus(403);

	// Відповідаємо одразу: Telegram повторює вебхук, якщо чекає довше 60с
	res.sendStatus(200);

	try {
		const [rows] = await connection_pool.query(
			`SELECT t.id_channel, ch.status
             FROM ${P}contact_center_channel_telegram AS t
             INNER JOIN ${P}contact_center_channels AS ch ON ch.id = t.id_channel
             WHERE t.webhook_secret = ? AND ch.deleted = 0 AND t.date_deleted IS NULL
             LIMIT 1`,
			[secret]
		);

		if (!rows.length) return;
		if (Number(rows[0].status) !== 1) return;

		const type = types.get("telegram");
		const update = req.body || {};

		// пост каналу переслано в групу обговорень — це для першого коментаря публікації (контакт-центр → публікації)
		if (update.message && update.message.is_automatic_forward) {
			await require("../../../controllers/contact-center/social/first-comment").onTelegramUpdate(update);
			return;
		}

		const normalized = type.normalize(update);
		await handleIncoming(rows[0].id_channel, "telegram", normalized);

		// Аватар контакта — асинхронно, не блокує обробку
		const msg = update.message || update.edited_message;
		const chatId = msg && msg.chat && msg.chat.type === "private" ? msg.chat.id : null;

		if (chatId && normalized && typeof type.enrichContact === "function") {
			const idChannel = rows[0].id_channel;
			setImmediate(function () {
				connection_pool
					.getConnection()
					.then(async function (c) {
						try {
							await type.enrichContact(c, idChannel, chatId);
						} finally {
							c.release();
						}
					})
					.catch(function (e) {
						console.error("[tg-enrich]", e.message);
					});
			});
		}
	} catch (error) {
		console.error("telegram webhook:", error.message);
		logging.error(error);
	}
});

// ── Instagram: GET-верифікація ──
// Meta б'є в один спільний URL. verify_token у нас per-channel,
// тож приймаємо challenge, якщо токен збігається з будь-яким каналом.
router.get(["/api/contact-center/webhook/instagram/", "/api/contact-center/webhook/instagram"], async (req, res) => {
	const mode = req.query["hub.mode"];
	const token = req.query["hub.verify_token"];
	const challenge = req.query["hub.challenge"];

	if (mode !== "subscribe" || !token) return res.sendStatus(403);

	try {
		const type = types.get("instagram");
		const conn = await connection_pool.getConnection();
		let found;
		try {
			found = await type.findByVerifyToken(conn, token);
		} finally {
			conn.release();
		}
		if (found) return res.status(200).send(String(challenge));
		return res.sendStatus(403);
	} catch (error) {
		console.error("instagram webhook verify:", error.message);
		logging.error(error);
		return res.sendStatus(403);
	}
});

// ── Instagram: POST-прийом ──
// Сире тіло дає middleware express.raw у server.js (до bodyParser.json).
router.post(["/api/contact-center/webhook/instagram/", "/api/contact-center/webhook/instagram"], async (req, res) => {
	// Відповідаємо швидко, інакше Meta повторює й може вимкнути webhook.
	res.sendStatus(200);

	const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}), "utf8");

	let payload;
	try {
		payload = JSON.parse(raw.toString("utf8"));
	} catch (e) {
		return logging.error(e);
	}

	if (!payload || payload.object !== "instagram") return;

	const type = types.get("instagram");
	const signature = req.get("x-hub-signature-256") || "";

	for (const entry of payload.entry || []) {
		const igUserId = String(entry.id || "");
		if (!igUserId) continue;

		let account;
		try {
			const conn = await connection_pool.getConnection();
			try {
				account = await type.resolveByIgUserId(conn, igUserId);
			} finally {
				conn.release();
			}
		} catch (e) {
			logging.error(e);
			continue;
		}

		if (!account || !account.active) continue;

		// Перевірка підпису на App Secret каналу (якщо секрет заданий)
		if (account.app_secret) {
			const expected = "sha256=" + crypto.createHmac("sha256", account.app_secret).update(raw).digest("hex");
			const a = Buffer.from(signature);
			const b = Buffer.from(expected);
			if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
				console.warn("[ig-webhook] підпис не пройшов для ig_user_id=" + igUserId);
				continue;
			}
		}

		// Коментарі під постами (поле «comments» у вебхуках Instagram)
		for (const change of entry.changes || []) {
			await require("../../../controllers/contact-center/comments")
				.onInstagramChange(account.id_channel, igUserId, change)
				.catch((e) => logging.error(e));
		}

		const events = entry.messaging || [];
		for (const ev of events) {
			try {
				const normalized = type.normalize(entry, ev);

				// Подія прочитання: клієнт прочитав наші вихідні
				if (normalized && normalized.kind === "read") {
					if (normalized.mid) {
						const rr = await model.markOutgoingReadBySourceId(account.id_channel, normalized.mid);
						if (rr.affected > 0 && rr.id_conversation) {
							realtime.readReceipt(rr.id_conversation, rr.up_to_id);
						}
					}
					continue;
				}

				// Реакція клієнта на наше повідомлення
				if (normalized && normalized.kind === "reaction") {
					if (normalized.mid) {
						const rx = await model.setMessageReaction(account.id_channel, normalized.mid, normalized.action, normalized.emoji);
						if (rx.affected > 0) {
							realtime.reaction(rx.id_conversation, rx.id_message, rx.reaction);
						}
					}
					continue;
				}

				// Повідомлення, надіслане від імені акаунта (з Instagram або з контакт-центру)
				if (normalized && normalized.kind === "echo") {
					scheduleEcho(account.id_channel, "instagram", account.app_id, normalized);
					continue;
				}

				await handleIncoming(account.id_channel, "instagram", normalized);

				// Збагачення профілю контакта (ім'я + аватар) — асинхронно,
				// не блокує обробку. Тільки для вхідних від клієнта.
				const senderId = ev.sender && ev.sender.id ? String(ev.sender.id) : null;
				const isIncoming = !!(ev.message && !ev.message.is_echo && senderId && senderId !== igUserId);

				if (isIncoming && typeof type.enrichContact === "function") {
					const idChannel = account.id_channel;
					setImmediate(function () {
						connection_pool
							.getConnection()
							.then(async function (c) {
								try {
									await type.enrichContact(c, idChannel, senderId);
								} finally {
									c.release();
								}
							})
							.catch(function (e) {
								console.error("[ig-enrich]", e.message);
							});
					});
				}
			} catch (e) {
				console.error("instagram webhook:", e.message);
				logging.error(e);
			}
		}
	}
});

// ── Facebook Messenger: GET-верифікація ──
// verify_token у кожного каналу свій — приймаємо, якщо збігається з будь-яким каналом Facebook.
router.get(["/api/contact-center/webhook/facebook/", "/api/contact-center/webhook/facebook"], async (req, res) => {
	const token = req.query["hub.verify_token"];
	console.log("[fb-webhook] GET верифікація: mode=%s token=%s", req.query["hub.mode"], token ? token.slice(0, 6) + "…" : "(порожньо)");
	if (req.query["hub.mode"] !== "subscribe" || !token) return res.sendStatus(403);
	try {
		const conn = await connection_pool.getConnection();
		let found;
		try {
			found = await types.get("facebook").findByVerifyToken(conn, token);
		} finally {
			conn.release();
		}
		console.log("[fb-webhook] GET верифікація:", found ? "OK, канал #" + found.id_channel : "verify token не знайдено → 403");
		return found ? res.status(200).send(String(req.query["hub.challenge"])) : res.sendStatus(403);
	} catch (error) {
		logging.error(error);
		return res.sendStatus(403);
	}
});

// ── Facebook Messenger: POST-прийом ──
router.post(["/api/contact-center/webhook/facebook/", "/api/contact-center/webhook/facebook"], async (req, res) => {
	res.sendStatus(200);

	const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}), "utf8");
	let payload;
	try {
		payload = JSON.parse(raw.toString("utf8"));
	} catch (e) {
		return logging.error(e);
	}
	console.log("[fb-webhook] POST отримано:", raw.toString("utf8").slice(0, 2000));
	if (!payload || payload.object !== "page") return console.log("[fb-webhook] пропуск: object =", payload && payload.object);

	const type = types.get("facebook");
	const signature = req.get("x-hub-signature-256") || "";

	for (const entry of payload.entry || []) {
		const pageId = String(entry.id || "");
		if (!pageId) continue;

		let account;
		try {
			const conn = await connection_pool.getConnection();
			try {
				account = await type.resolveByPageId(conn, pageId);
			} finally {
				conn.release();
			}
		} catch (e) {
			logging.error(e);
			continue;
		}
		if (!account) {
			console.log("[fb-webhook] пропуск: немає каналу Facebook для page_id=" + pageId);
			continue;
		}
		if (!account.active) {
			console.log("[fb-webhook] пропуск: канал #" + account.id_channel + " вимкнений (увімкніть «Активний» і збережіть)");
			continue;
		}
		console.log("[fb-webhook] канал #" + account.id_channel + ", подій: " + (entry.messaging || []).length + (entry.changes ? ", changes: " + entry.changes.length : ""));

		if (account.app_secret) {
			const expected = Buffer.from("sha256=" + crypto.createHmac("sha256", account.app_secret).update(raw).digest("hex"));
			const got = Buffer.from(signature);
			if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
				console.warn("[fb-webhook] підпис не пройшов для page_id=" + pageId + " — перевірте App Secret у каналі (той самий додаток, що в Meta)");
				continue;
			}
		}

		// Коментарі під постами сторінки (поле «feed»)
		for (const change of entry.changes || []) {
			await require("../../../controllers/contact-center/comments")
				.onFacebookChange(account.id_channel, pageId, change)
				.catch((e) => logging.error(e));
		}

		for (const ev of entry.messaging || []) {
			try {
				const normalized = type.normalize(entry, ev);
				console.log("[fb-webhook] подія:", JSON.stringify(ev).slice(0, 500), "→", normalized ? normalized.kind || "message" : "пропущено (delivery / порожньо)");
				if (!normalized) continue;

				if (normalized.kind === "read") {
					if (normalized.sender_id) {
						const rr = await model.markOutgoingReadByWatermark(account.id_channel, normalized.sender_id, normalized.watermark);
						if (rr.affected > 0 && rr.id_conversation) realtime.readReceipt(rr.id_conversation, rr.up_to_id);
					}
					continue;
				}

				if (normalized.kind === "reaction") {
					if (normalized.mid) {
						const rx = await model.setMessageReaction(account.id_channel, normalized.mid, normalized.action, normalized.emoji);
						if (rx.affected > 0) realtime.reaction(rx.id_conversation, rx.id_message, rx.reaction);
					}
					continue;
				}

				if (normalized.kind === "echo") {
					scheduleEcho(account.id_channel, "facebook", account.app_id, normalized);
					continue;
				}

				await handleIncoming(account.id_channel, "facebook", normalized);
				console.log("[fb-webhook] повідомлення збережено, канал #" + account.id_channel + ", від " + normalized.contact.external_id);

				const psid = normalized.contact.external_id;
				const idChannel = account.id_channel;
				setImmediate(() => {
					connection_pool
						.getConnection()
						.then(async (c) => {
							try {
								await type.enrichContact(c, idChannel, psid);
							} finally {
								c.release();
							}
						})
						.catch((e) => console.error("[fb-enrich]", e.message));
				});
			} catch (e) {
				console.error("facebook webhook:", e.message);
				logging.error(e);
			}
		}
	}
});

module.exports = router;