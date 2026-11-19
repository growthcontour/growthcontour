const axios = require("axios");
const config = require("../../../../config/config");
const cryptoHelper = require("../../../../helpers/crypto");
const i18n = require("../../../../config/i18n/i18n");

const P = config.get("configDatabase").prefix;
const TABLE = P + "contact_center_channel_facebook";

const GRAPH = "https://graph.facebook.com/v23.0";

// Події Messenger, на які підписуємо сторінку
// feed — коментарі під постами сторінки (Контакт-центр → Коментарі)
const SUBSCRIBED_FIELDS = "messages,messaging_postbacks,message_reads,message_deliveries,message_echoes,message_reactions,feed";

// Фонові тексти — мова системи (APP_LOCALE)
const LOCALE = process.env.APP_LOCALE || "uk";
const t = (phrase, vars) => i18n.__({ phrase, locale: LOCALE }, vars || {});

const graphError = (e) => String((e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message).slice(0, 500);

async function loadToken(conn, idChannel) {
	const [rows] = await conn.execute(`SELECT token_cipher, token_iv, token_tag, page_id FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);
	const r = rows[0];
	return { token: r ? cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag) : null, page_id: r ? r.page_id : null };
}

/** Перевірка токена сторінки + підписка сторінки на webhook додатку */
async function connectPage(token, pageId) {
	const me = await axios.get(`${GRAPH}/me`, { params: { fields: "id,name,picture{url}", access_token: token }, timeout: 15000 });
	const d = me.data || {};
	if (!d.id) throw new Error(t("contact_center.channels.facebook.err.no_page"));
	if (pageId && String(d.id) !== String(pageId)) throw new Error(t("contact_center.channels.facebook.err.page_mismatch", { id: d.id }));

	await axios.post(`${GRAPH}/${d.id}/subscribed_apps`, null, { params: { subscribed_fields: SUBSCRIBED_FIELDS, access_token: token }, timeout: 15000 });

	return { id: String(d.id), name: d.name || null, picture: d.picture && d.picture.data ? d.picture.data.url : null };
}

module.exports = {
	code: "facebook",
	label: "contact_center.channels.type_facebook",
	icon: "fa-brands fa-facebook-messenger",
	color: "#0866ff",
	view: "./types/facebook",
	table: TABLE,

	async create(conn, idChannel) {
		await conn.execute(`INSERT INTO ${TABLE} (id_channel, verify_token) VALUES (?, ?)`, [idChannel, cryptoHelper.random(32)]);
	},

	async load(conn, idChannel) {
		const [rows] = await conn.execute(
			`SELECT id, page_id, page_name, page_picture, app_id, verify_token, connection_error,
                    token_cipher IS NOT NULL AS has_token, app_secret_cipher IS NOT NULL AS has_app_secret, date_connected
             FROM ${TABLE} WHERE id_channel = ? LIMIT 1`,
			[idChannel]
		);
		const r = rows[0] || {};
		return Object.assign({}, r, {
			has_token: !!Number(r.has_token),
			has_app_secret: !!Number(r.has_app_secret),
			token_mask: "••••••••••••",
		});
	},

	validate(body, current) {
		const errors = [];
		const token = String(body.token || "").trim();
		const pageId = String(body.page_id || "").trim();
		const appId = String(body.app_id || "").trim();
		const appSecret = String(body.app_secret || "").trim();

		if (!pageId || !/^\d{5,32}$/.test(pageId)) errors.push({ field: "page_id", message: t("contact_center.channels.facebook.err.page_id") });
		if (!token && !current.has_token) errors.push({ field: "token", message: t("contact_center.channels.facebook.err.token_required") });
		else if (token && token.length < 30) errors.push({ field: "token", message: t("contact_center.channels.facebook.err.token_bad") });
		if (appId && !/^\d{5,32}$/.test(appId)) errors.push({ field: "app_id", message: t("contact_center.channels.facebook.err.app_id") });
		if (appSecret && appSecret.length < 16) errors.push({ field: "app_secret", message: t("contact_center.channels.facebook.err.app_secret") });

		return { valid: errors.length === 0, errors: errors };
	},

	/**
	 * Зберігає налаштування. Новий токен або інша сторінка → перевірка через Graph API
	 * і підписка сторінки на webhook. Канал налаштований, якщо сторінка підключилась.
	 */
	async save(conn, idChannel, body, current) {
		const token = String(body.token || "").trim();
		const pageId = String(body.page_id || "").trim();
		const appId = String(body.app_id || "").trim() || null;
		const appSecret = String(body.app_secret || "").trim();
		const appSecretClear = String(body.app_secret_clear || "") === "1";

		await conn.execute(`UPDATE ${TABLE} SET app_id = ? WHERE id_channel = ?`, [appId, idChannel]);

		if (appSecretClear) {
			await conn.execute(`UPDATE ${TABLE} SET app_secret_cipher = NULL, app_secret_iv = NULL, app_secret_tag = NULL WHERE id_channel = ?`, [idChannel]);
		} else if (appSecret) {
			const s = cryptoHelper.encrypt(appSecret);
			await conn.execute(`UPDATE ${TABLE} SET app_secret_cipher = ?, app_secret_iv = ?, app_secret_tag = ? WHERE id_channel = ?`, [s.cipher, s.iv, s.tag, idChannel]);
		}

		// Нічого не змінилось у підключенні — залишаємо як є
		const pageChanged = pageId !== String(current.page_id || "");
		if (!token && !pageChanged) return { configured: !!current.date_connected, reload: false };

		let useToken = token;
		if (!useToken) useToken = (await loadToken(conn, idChannel)).token;

		if (token) {
			const enc = cryptoHelper.encrypt(token);
			await conn.execute(`UPDATE ${TABLE} SET token_cipher = ?, token_iv = ?, token_tag = ? WHERE id_channel = ?`, [enc.cipher, enc.iv, enc.tag, idChannel]);
		}

		try {
			console.log("[fb-channel] #" + idChannel + " перевірка токена і підписка сторінки " + pageId);
			const page = await connectPage(useToken, pageId);
			console.log("[fb-channel] #" + idChannel + " підключено: " + page.name + " (" + page.id + ")");
			await conn.execute(
				`UPDATE ${TABLE} SET page_id = ?, page_name = ?, page_picture = ?, connection_error = NULL, date_connected = NOW() WHERE id_channel = ?`,
				[page.id, page.name, page.picture, idChannel]
			);
			return { configured: true, reload: true };
		} catch (e) {
			console.error("[fb-channel] #" + idChannel + " помилка підключення:", graphError(e));
			await conn.execute(`UPDATE ${TABLE} SET page_id = ?, connection_error = ?, date_connected = NULL WHERE id_channel = ?`, [pageId, graphError(e), idChannel]);
			return { configured: false, reload: true };
		}
	},

	async send(conn, idChannel, target, message) {
		const { token } = await loadToken(conn, idChannel);
		if (!token) return { ok: false, error: t("contact_center.channels.facebook.err.token_required") };

		try {
			const r = await axios.post(`${GRAPH}/me/messages`, { recipient: { id: target }, messaging_type: "RESPONSE", message: { text: message.text } }, { params: { access_token: token }, timeout: 15000 });
			console.log("[fb-send] #" + idChannel + " → " + target + ": " + JSON.stringify(r.data));
			if (!r.data || !r.data.message_id) return { ok: false, error: t("contact_center.channels.facebook.err.no_message_id") };
			return { ok: true, source_id: String(r.data.message_id) };
		} catch (e) {
			console.error("[fb-send] #" + idChannel + " → " + target + " помилка:", graphError(e));
			return { ok: false, error: graphError(e) };
		}
	},

	// Менеджер прочитав → клієнт бачить «переглянуто»
	async onRead(conn, idChannel, target) {
		const { token } = await loadToken(conn, idChannel);
		if (!token || !target) return;
		try {
			await axios.post(`${GRAPH}/me/messages`, { recipient: { id: target }, sender_action: "mark_seen" }, { params: { access_token: token }, timeout: 10000 });
		} catch (e) {
			// не критично
		}
	},

	// Медіа: Messenger завантажує файл сам за публічним https-URL
	async sendMedia(conn, idChannel, target, media) {
		const { token } = await loadToken(conn, idChannel);
		if (!token) return { ok: false, error: t("contact_center.channels.facebook.err.token_required") };

		const LIMITS = { image: 8, video: 25, audio: 25, file: 25 };
		const type = String(media.type || "").toLowerCase();
		if (!LIMITS[type]) return { ok: false, error: t("contact_center.channels.facebook.err.media_type") };
		if (!/^https:\/\//i.test(String(media.url || ""))) return { ok: false, error: t("contact_center.channels.facebook.err.media_url") };
		if (media.size && media.size > LIMITS[type] * 1024 * 1024) return { ok: false, error: t("contact_center.channels.facebook.err.media_size", { mb: LIMITS[type] }) };

		const post = (message) => axios.post(`${GRAPH}/me/messages`, { recipient: { id: target }, messaging_type: "RESPONSE", message }, { params: { access_token: token }, timeout: 30000 });

		try {
			// Підпис — окремим повідомленням (Messenger не приймає текст разом із вкладенням)
			if (media.caption) await post({ text: media.caption }).catch(() => {});
			const r = await post({ attachment: { type, payload: { url: media.url, is_reusable: false } } });
			if (!r.data || !r.data.message_id) return { ok: false, error: t("contact_center.channels.facebook.err.no_message_id") };
			return { ok: true, source_id: String(r.data.message_id) };
		} catch (e) {
			return { ok: false, error: graphError(e) };
		}
	},

	// Канал за ID сторінки (entry.id у webhook)
	async resolveByPageId(conn, pageId) {
		const [rows] = await conn.execute(
			`SELECT fb.id_channel, fb.app_id, fb.token_cipher, fb.token_iv, fb.token_tag,
                    fb.app_secret_cipher, fb.app_secret_iv, fb.app_secret_tag, ch.status AS channel_active
             FROM ${TABLE} AS fb
             INNER JOIN ${P}contact_center_channels AS ch ON ch.id = fb.id_channel
             WHERE fb.page_id = ? AND ch.deleted = 0
             ORDER BY fb.date_connected DESC
             LIMIT 1`,
			[String(pageId)]
		);
		const r = rows[0];
		if (!r) return null;
		return {
			id_channel: r.id_channel,
			app_id: r.app_id || null,
			active: Number(r.channel_active) === 1,
			token: cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag),
			app_secret: cryptoHelper.decrypt(r.app_secret_cipher, r.app_secret_iv, r.app_secret_tag),
		};
	},

	async findByVerifyToken(conn, verifyToken) {
		if (!verifyToken) return null;
		const [rows] = await conn.execute(`SELECT id_channel FROM ${TABLE} WHERE verify_token = ? LIMIT 1`, [String(verifyToken)]);
		return rows[0] ? { id_channel: rows[0].id_channel } : null;
	},

	// Ім'я та фото співрозмовника (PSID) — не частіше разу на добу
	async enrichContact(conn, idChannel, psid) {
		const T_CONTACTS = P + "contact_center_contacts";
		const [rows] = await conn.execute(`SELECT id, attributes FROM ${T_CONTACTS} WHERE id_channel = ? AND external_id = ? LIMIT 1`, [idChannel, String(psid)]);
		const contact = rows[0];
		if (!contact) return;

		let attrs = {};
		try {
			attrs = contact.attributes ? (typeof contact.attributes === "string" ? JSON.parse(contact.attributes) : contact.attributes) : {};
		} catch (e) {
			attrs = {};
		}
		const last = attrs.profile_synced_at ? new Date(attrs.profile_synced_at).getTime() : 0;
		if (Date.now() - last < 24 * 60 * 60 * 1000) return;

		const { token } = await loadToken(conn, idChannel);
		if (!token) return;

		let d;
		try {
			d = (await axios.get(`${GRAPH}/${psid}`, { params: { fields: "first_name,last_name,profile_pic", access_token: token }, timeout: 10000 })).data || {};
		} catch (e) {
			console.log("[fb-enrich]", graphError(e));
			return;
		}

		attrs.profile_synced_at = new Date().toISOString();
		const name = [d.first_name, d.last_name].filter(Boolean).join(" ");
		await conn.execute(
			`UPDATE ${T_CONTACTS} SET name = COALESCE(NULLIF(?, ''), name), avatar = COALESCE(?, avatar), attributes = ? WHERE id = ?`,
			[name, d.profile_pic || null, JSON.stringify(attrs), contact.id]
		);
	},

	/**
	 * Подія Messenger → канонічна форма моделі.
	 * read (watermark), reaction, message; echo і postback без тексту — пропускаємо.
	 */
	normalize(entry, ev) {
		if (!ev) return null;
		const senderId = ev.sender && ev.sender.id ? String(ev.sender.id) : null;

		if (ev.read) return { kind: "read", sender_id: senderId, watermark: Number(ev.read.watermark) || null };
		if (ev.delivery) return null;
		if (ev.reaction) return { kind: "reaction", mid: ev.reaction.mid || null, action: ev.reaction.action === "unreact" ? "unreact" : "react", emoji: ev.reaction.emoji || null };

		// Кнопка (postback) — показуємо як текст натиснутої кнопки
		const msg = ev.message || (ev.postback ? { mid: ev.postback.mid, text: ev.postback.title || ev.postback.payload } : null);
		if (!msg || !senderId) return null;
		// Echo — повідомлення від імені сторінки (з контакт-центру або прямо з Facebook / Meta Business Suite);
		// співрозмовник у такому разі — отримувач
		const echo = !!msg.is_echo;
		const peerId = echo ? (ev.recipient && ev.recipient.id ? String(ev.recipient.id) : null) : senderId;
		if (!peerId) return null;

		const attachments = [];
		for (const a of Array.isArray(msg.attachments) ? msg.attachments : []) {
			const url = a.payload && a.payload.url;
			if (!url) continue;
			const type = a.type === "image" ? "image" : a.type === "video" ? "video" : a.type === "audio" ? "audio" : "file";
			attachments.push({ type, subtype: type === "audio" ? "voice" : null, source_type: "url", source_ref: String(url), file_name: null, mime: null });
		}

		const text = msg.text || null;
		if (!text && !attachments.length) return null;

		return {
			kind: echo ? "echo" : undefined,
			app_id: msg.app_id ? String(msg.app_id) : null,
			contact: { external_id: peerId, first_name: null, last_name: null, username: null },
			source_thread_id: peerId,
			message: {
				source_id: String(msg.mid || ""),
				type: attachments.length ? "media" : "text",
				subtype: null,
				text,
				attachments,
				reply_to_source_id: msg.reply_to && msg.reply_to.mid ? String(msg.reply_to.mid) : null,
				date_add: new Date(Number(ev.timestamp) || Date.now()),
			},
		};
	},

	identitySql(alias) {
		return `COALESCE(${alias}.page_name, ${alias}.page_id, '')`;
	},
};