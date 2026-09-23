const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const logging = require("../../../logging/logging");
const crypto = require("../../../helpers/crypto");

const P = config.get("configDatabase").prefix;
const TABLE = P + "contact_center_channel_notifications";

const TG_TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

// ── Виклик Telegram Bot API (self-contained, без залежностей) ──
// Потрібен Node 18+ (global fetch). Якщо у types/telegram.js є свій http-хелпер — можна замінити на нього.
async function tgCall(token, method, params) {
	try {
		const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params || {}),
		});
		return await res.json();
	} catch (e) {
		return { ok: false, description: e.message };
	}
}

const ccNotify = {
	// Стан для форми. Токен НАЗОВНІ не віддаємо — лише маску.
	async load(conn, idChannel) {
		const q = conn || pool;
		const [rows] = await q.query(`SELECT * FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);
		if (!rows.length) {
			return { exists: false, push_enabled: 0, tg_enabled: 0, has_token: false, tg_bot_username: null, tg_bot_token_last4: null, tg_chat_id: null, tg_use_thread: 0, tg_thread_id: null };
		}
		const r = rows[0];
		return {
			exists: true,
			push_enabled: Number(r.push_enabled) || 0,
			tg_enabled: Number(r.tg_enabled) || 0,
			has_token: !!r.tg_bot_token_cipher,
			tg_bot_id: r.tg_bot_id,
			tg_bot_username: r.tg_bot_username,
			tg_bot_token_last4: r.tg_bot_token_last4,
			tg_chat_id: r.tg_chat_id,
			tg_use_thread: Number(r.tg_use_thread) || 0,
			tg_thread_id: r.tg_thread_id,
		};
	},

	// Структурна валідація (current — результат load(), щоб знати чи є збережений токен)
	validate(body, current) {
		const errors = [];
		body = body || {};
		current = current || {};
		if (body.tg_enabled) {
			const hasNew = String(body.tg_bot_token || "").trim() !== "";
			if (!hasNew && !current.has_token) errors.push({ field: "tg_bot_token", message: "Вкажіть токен бота" });
			if (hasNew && !TG_TOKEN_RE.test(String(body.tg_bot_token).trim())) errors.push({ field: "tg_bot_token", message: "Невірний формат токена" });
			if (!String(body.tg_chat_id || "").trim()) errors.push({ field: "tg_chat_id", message: "Вкажіть ID чату / каналу" });
			if (body.tg_use_thread) {
				const th = String(body.tg_thread_id == null ? "" : body.tg_thread_id).trim();
				if (!/^\d+$/.test(th)) errors.push({ field: "tg_thread_id", message: "Вкажіть коректний ID гілки" });
			}
		}
		return { valid: errors.length === 0, errors };
	},

	// Збереження. Викликається ВСЕРЕДИНІ транзакції update() — жодних мережевих викликів тут.
	async save(conn, idChannel, body) {
		body = body || {};
		const tgEnabled = body.tg_enabled ? 1 : 0;
		const pushEnabled = body.push_enabled ? 1 : 0;
		const chatId = String(body.tg_chat_id || "").trim() || null;
		const useThread = body.tg_use_thread ? 1 : 0;
		const threadId = body.tg_thread_id != null && String(body.tg_thread_id).trim() !== "" ? parseInt(body.tg_thread_id, 10) : null;

		// гарантуємо наявність рядка
		await conn.query(`INSERT INTO ${TABLE} (id_channel, date_add) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE id_channel = id_channel`, [idChannel]);

		const token = String(body.tg_bot_token || "").trim();
		if (token) {
			const enc = crypto.encrypt(token);
			await conn.query(
				`UPDATE ${TABLE} SET tg_enabled=?, push_enabled=?,
                    tg_bot_token_cipher=?, tg_bot_token_iv=?, tg_bot_token_tag=?, tg_bot_token_last4=?,
                    tg_chat_id=?, tg_use_thread=?, tg_thread_id=?, date_update=NOW()
                 WHERE id_channel=?`,
				[tgEnabled, pushEnabled, enc.cipher, enc.iv, enc.tag, crypto.last4(token), chatId, useThread, threadId, idChannel]
			);
		} else {
			// токен не міняємо
			await conn.query(
				`UPDATE ${TABLE} SET tg_enabled=?, push_enabled=?,
                    tg_chat_id=?, tg_use_thread=?, tg_thread_id=?, date_update=NOW()
                 WHERE id_channel=?`,
				[tgEnabled, pushEnabled, chatId, useThread, threadId, idChannel]
			);
		}
	},

	async _token(conn, idChannel) {
		const q = conn || pool;
		const [rows] = await q.query(`SELECT tg_bot_token_cipher, tg_bot_token_iv, tg_bot_token_tag FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);
		if (!rows.length) return null;
		return crypto.decrypt(rows[0].tg_bot_token_cipher, rows[0].tg_bot_token_iv, rows[0].tg_bot_token_tag);
	},

	// Тест: getMe + (за наявності chat_id) реальний sendMessage у цільовий чат/гілку.
	// Пріоритет — значенням із форми (щоб тестувати незбережене), інакше збережені.
	async testTelegram(conn, idChannel, body) {
		body = body || {};
		const fromForm = String(body.tg_bot_token || "").trim() !== "";
		let token = fromForm ? String(body.tg_bot_token).trim() : await this._token(conn, idChannel);
		if (!token) return { ok: false, error: "Немає токена бота" };

		const me = await tgCall(token, "getMe");
		if (!me.ok) return { ok: false, error: me.description || "Невірний токен" };

		// зберігаємо ідентичність бота (не заважає, якщо рядка ще нема — 0 rows)
		await conn.query(`UPDATE ${TABLE} SET tg_bot_id=?, tg_bot_username=? WHERE id_channel=?`, [me.result.id, me.result.username || null, idChannel]).catch(() => {});

		let chatId = String(body.tg_chat_id || "").trim();
		let useThread = body.tg_use_thread ? 1 : 0;
		let threadId = body.tg_thread_id != null && String(body.tg_thread_id).trim() !== "" ? parseInt(body.tg_thread_id, 10) : null;
		if (!chatId) {
			const cur = await this.load(conn, idChannel);
			chatId = cur.tg_chat_id || "";
			if (body.tg_use_thread === undefined) {
				useThread = cur.tg_use_thread;
				threadId = cur.tg_thread_id;
			}
		}

		if (chatId) {
			const params = { chat_id: chatId, text: "✅ CRM: тест сповіщень каналу пройдено." };
			if (useThread && threadId) params.message_thread_id = threadId;
			const sent = await tgCall(token, "sendMessage", params);
			if (!sent.ok) return { ok: false, error: "Чат: " + (sent.description || "не вдалося надіслати") };
		}
		return { ok: true, bot: { id: me.result.id, username: me.result.username, first_name: me.result.first_name } };
	},

	// Бойовий відправник алерту. Смикається в точці приходу вхідного. Бере власне зʼєднання.
	async sendTelegram(idChannel, text, opts) {
		const conn = await pool.getConnection();
		try {
			const [rows] = await conn.query(
				`SELECT tg_enabled, tg_bot_token_cipher, tg_bot_token_iv, tg_bot_token_tag,
                        tg_chat_id, tg_use_thread, tg_thread_id
                 FROM ${TABLE} WHERE id_channel = ? LIMIT 1`,
				[idChannel]
			);
			if (!rows.length || !Number(rows[0].tg_enabled)) return { ok: false, error: "disabled" };
			const r = rows[0];
			const token = crypto.decrypt(r.tg_bot_token_cipher, r.tg_bot_token_iv, r.tg_bot_token_tag);
			if (!token || !r.tg_chat_id) return { ok: false, error: "not-configured" };

			const params = { chat_id: r.tg_chat_id, text, parse_mode: "HTML", disable_web_page_preview: true };
			if (Number(r.tg_use_thread) && r.tg_thread_id != null) params.message_thread_id = Number(r.tg_thread_id);
			if (opts && opts.reply_markup) params.reply_markup = opts.reply_markup;

			const resp = await tgCall(token, "sendMessage", params);
			return resp.ok ? { ok: true, result: resp.result } : { ok: false, error: resp.description };
		} catch (e) {
			logging.error(e);
			return { ok: false, error: e.message };
		} finally {
			conn.release();
		}
	},
};

module.exports = ccNotify;