const axios = require("axios");
const config = require("../../../../config/config");
const cryptoHelper = require("../../../../helpers/crypto");

const P = config.get("configDatabase").prefix;
const TABLE = P + "contact_center_channel_telegram";

module.exports = {
	code: "telegram",
	label: "contact_center.channels.type_telegram",
	icon: "fa-brands fa-telegram",
	color: "#24a1de",
	view: "./types/telegram",
	table: TABLE,

	// Рядок налаштувань при створенні каналу
	async create(conn, idChannel) {
		await conn.execute(`INSERT INTO ${TABLE} (id_channel, webhook_secret) VALUES (?, ?)`, [idChannel, cryptoHelper.random(32)]);
	},

	// Дані для сторінки редагування. Токен назовні не віддаємо — тільки маску.
	async load(conn, idChannel) {
		const [rows] = await conn.execute(
			`SELECT id, bot_id, bot_username, bot_first_name, token_last4,
                    webhook_secret, webhook_url, webhook_set, date_webhook_set
             FROM ${TABLE} WHERE id_channel = ? LIMIT 1`,
			[idChannel]
		);

		const r = rows[0] || {};
		return Object.assign({}, r, {
			has_token: !!r.token_last4,
			token_mask: r.token_last4 ? "••••••••" + r.token_last4 : "",
		});
	},

	// { valid, errors[] } — формат як у решті проєкту
	validate(body, current) {
		const errors = [];
		const token = String(body.token || "").trim();

		// Порожнє поле = "не змінювати", але для нового каналу токен обов'язковий
		if (!token && !current.has_token) {
			errors.push({ field: "token", message: "Токен бота обов'язковий" });
		} else if (token && !/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
			errors.push({ field: "token", message: "Невірний формат токена" });
		}

		return { valid: errors.length === 0, errors: errors };
	},

	// Повертає { configured, reload }
	// configured — чи канал готовий до роботи
	// reload — чи треба перемалювати сторінку (змінилися прочитувані поля)
	async save(conn, idChannel, body, current) {
		const token = String(body.token || "").trim();

		if (!token) return { configured: current.has_token, reload: false };

		const enc = cryptoHelper.encrypt(token);

		// Новий токен — дані бота застаріли, webhook треба ставити наново
		await conn.execute(
			`UPDATE ${TABLE}
             SET token_cipher = ?, token_iv = ?, token_tag = ?, token_last4 = ?,
                 bot_id = ?, bot_username = NULL, bot_first_name = NULL,
                 webhook_set = 0, date_webhook_set = NULL
             WHERE id_channel = ?`,
			[enc.cipher, enc.iv, enc.tag, cryptoHelper.last4(token), Number(token.split(":")[0]) || null, idChannel]
		);

		return { configured: false, reload: true };
	},

	// Перевірка підключення + підтягування даних бота
	async test(conn, idChannel) {
		const [rows] = await conn.execute(`SELECT token_cipher, token_iv, token_tag FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);

		const r = rows[0];
		const token = r && cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag);
		if (!token) return { ok: false, error: "Токен не задано" };

		try {
			const response = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 10000 });
			const data = response.data;
			if (!data || !data.ok) return { ok: false, error: "Telegram відхилив токен" };

			await conn.execute(`UPDATE ${TABLE} SET bot_id = ?, bot_username = ?, bot_first_name = ? WHERE id_channel = ?`, [data.result.id, data.result.username || null, data.result.first_name || null, idChannel]);

			// Реєструємо webhook одразу після успішної перевірки токена
			const [secretRows] = await conn.execute(`SELECT webhook_secret FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);

			const webhookUrl = config.get("configServer").url + "/api/contact-center/webhook/telegram/" + secretRows[0].webhook_secret + "/";

			await axios.post(
				`https://api.telegram.org/bot${token}/setWebhook`,
				{
					url: webhookUrl,
					allowed_updates: ["message", "edited_message"],
					drop_pending_updates: true,
				},
				{ timeout: 15000 }
			);

			await conn.execute(`UPDATE ${TABLE} SET webhook_url = ?, webhook_set = 1, date_webhook_set = NOW() WHERE id_channel = ?`, [webhookUrl, idChannel]);

			return { ok: true };
		} catch (e) {
			const msg = (e.response && e.response.data && e.response.data.description) || e.message;
			return { ok: false, error: String(msg).slice(0, 500) };
		}
	},

	// Відправка повідомлення в канал.
	// Повертає { ok, source_id, error }
	async send(conn, idChannel, target, message) {
		const [rows] = await conn.execute(`SELECT token_cipher, token_iv, token_tag FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);

		const r = rows[0];
		const token = r && cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag);
		if (!token) return { ok: false, error: "Токен каналу не задано" };

		try {
			const response = await axios.post(
				`https://api.telegram.org/bot${token}/sendMessage`,
				{
					chat_id: target,
					text: message.text,
					parse_mode: "HTML",
					reply_to_message_id: message.reply_source_id || undefined,
				},
				{ timeout: 15000 }
			);

			const data = response.data;
			if (!data || !data.ok) return { ok: false, error: "Telegram відхилив повідомлення" };

			return { ok: true, source_id: String(data.result.message_id) };
		} catch (e) {
			const msg = (e.response && e.response.data && e.response.data.description) || e.message;
			return { ok: false, error: String(msg).slice(0, 500) };
		}
	},

	// ── Нормалізація вхідного оновлення Telegram ──
	// Перетворює update на канонічну форму моделі.
	// Повертає null, якщо оновлення нас не стосується.
	normalize(update) {
		const msg = update.message || update.edited_message;
		if (!msg || !msg.chat) return null;

		const from = msg.from || {};
		const attachments = [];

		let type = "text";
		let subtype = null;
		let text = msg.text || msg.caption || null;

		// Фото: беремо найбільший розмір — останній елемент масиву
		if (msg.photo && msg.photo.length) {
			type = "media";
			const p = msg.photo[msg.photo.length - 1];
			attachments.push({ type: "image", source_type: "telegram_file_id", source_ref: p.file_id, size: p.file_size, width: p.width, height: p.height });
		} else if (msg.animation) {
			type = "media";
			attachments.push({ type: "image", subtype: "animation", source_type: "telegram_file_id", source_ref: msg.animation.file_id, file_name: msg.animation.file_name, mime: msg.animation.mime_type, size: msg.animation.file_size, width: msg.animation.width, height: msg.animation.height, duration: msg.animation.duration });
		} else if (msg.video) {
			type = "media";
			attachments.push({ type: "video", source_type: "telegram_file_id", source_ref: msg.video.file_id, file_name: msg.video.file_name, mime: msg.video.mime_type, size: msg.video.file_size, width: msg.video.width, height: msg.video.height, duration: msg.video.duration });
		} else if (msg.video_note) {
			type = "media";
			attachments.push({ type: "video", subtype: "video_note", source_type: "telegram_file_id", source_ref: msg.video_note.file_id, size: msg.video_note.file_size, duration: msg.video_note.duration });
		} else if (msg.voice) {
			type = "media";
			attachments.push({ type: "audio", subtype: "voice", source_type: "telegram_file_id", source_ref: msg.voice.file_id, mime: msg.voice.mime_type, size: msg.voice.file_size, duration: msg.voice.duration });
		} else if (msg.audio) {
			type = "media";
			attachments.push({ type: "audio", source_type: "telegram_file_id", source_ref: msg.audio.file_id, file_name: msg.audio.file_name, mime: msg.audio.mime_type, size: msg.audio.file_size, duration: msg.audio.duration });
		} else if (msg.document) {
			type = "media";
			attachments.push({ type: "file", source_type: "telegram_file_id", source_ref: msg.document.file_id, file_name: msg.document.file_name, mime: msg.document.mime_type, size: msg.document.file_size });
		} else if (msg.sticker) {
			type = "sticker";
			subtype = msg.sticker.is_animated ? "tgs" : msg.sticker.is_video ? "webm" : "webp";
			text = msg.sticker.emoji || null;
			attachments.push({ type: "sticker", subtype: subtype, source_type: "telegram_file_id", source_ref: msg.sticker.file_id, width: msg.sticker.width, height: msg.sticker.height });
		} else if (msg.location || msg.venue) {
			type = "location";
			const loc = msg.venue ? msg.venue.location : msg.location;
			subtype = msg.venue ? "venue" : null;
			if (msg.venue) text = msg.venue.title + ", " + msg.venue.address;
			return this._build(msg, from, type, subtype, text, [], { lat: loc.latitude, lng: loc.longitude });
		} else if (msg.contact) {
			type = "contact";
			text = [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(" ") + " " + msg.contact.phone_number;
		} else if (msg.poll) {
			type = "poll";
			text = msg.poll.question;
		} else if (!text) {
			// Службові оновлення (вхід у групу, закріплення тощо) не зберігаємо
			return null;
		}

		return this._build(msg, from, type, subtype, text, attachments, {});
	},

	_build(msg, from, type, subtype, text, attachments, extra) {
		return {
			// Ідентифікатор співрозмовника в каналі
			contact: {
				external_id: String(msg.chat.id),
				first_name: from.first_name || msg.chat.first_name || null,
				last_name: from.last_name || msg.chat.last_name || null,
				username: from.username || msg.chat.username || null,
				lang: from.language_code || null,
				attributes: { is_bot: !!from.is_bot, chat_type: msg.chat.type },
			},
			source_thread_id: String(msg.chat.id),
			message: {
				source_id: String(msg.message_id),
				type: type,
				subtype: subtype,
				text: text,
				lat: extra.lat || null,
				lng: extra.lng || null,
				attachments: attachments,
				date_add: new Date(msg.date * 1000),
				// Пряме поле — його читає model.addIncoming (як для Instagram)
				reply_to_source_id: msg.reply_to_message ? String(msg.reply_to_message.message_id) : null,
			},
		};
	},

	// Відправка файлу. Telegram уміє тягнути файл за публічним URL —
	// це надійніше і простіше, ніж multipart-завантаження з нашого боку.
	async sendMedia(conn, idChannel, target, media) {
		const [rows] = await conn.execute(`SELECT token_cipher, token_iv, token_tag FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);

		const r = rows[0];
		const token = r && cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag);
		if (!token) return { ok: false, error: "Токен каналу не задано" };

		// Канонічний тип вкладення → метод Bot API
		const methodMap = {
			image: { method: "sendPhoto", field: "photo" },
			video: { method: "sendVideo", field: "video" },
			audio: { method: "sendAudio", field: "audio" },
			file: { method: "sendDocument", field: "document" },
		};

		const m = methodMap[media.type] || methodMap.file;

		const body = { chat_id: target };
		body[m.field] = media.url;
		if (media.caption) body.caption = String(media.caption).slice(0, 1024);

		try {
			const response = await axios.post(`https://api.telegram.org/bot${token}/${m.method}`, body, { timeout: 60000 });

			const data = response.data;
			if (!data || !data.ok) return { ok: false, error: "Telegram відхилив файл" };

			return { ok: true, source_id: String(data.result.message_id) };
		} catch (e) {
			const msg = (e.response && e.response.data && e.response.data.description) || e.message;
			return { ok: false, error: String(msg).slice(0, 500) };
		}
	},

	// ── Аватар контакта (ім'я вже приходить в апдейті) ──
	// Telegram: getUserProfilePhotos → getFile → завантажуємо до себе.
	// URL Telegram містить токен бота, тож показувати його не можна — качаємо локально.
	async enrichContact(conn, idChannel, chatId) {
		const P2 = require("../../../../config/config").get("configDatabase").prefix;
		const T_CONTACTS = P2 + "contact_center_contacts";

		const [crows] = await conn.execute(`SELECT id, avatar, attributes FROM ${T_CONTACTS} WHERE id_channel = ? AND external_id = ? LIMIT 1`, [idChannel, String(chatId)]);
		const contact = crows[0];
		if (!contact) return;

		let attrs = {};
		try {
			attrs = contact.attributes ? (typeof contact.attributes === "string" ? JSON.parse(contact.attributes) : contact.attributes) : {};
		} catch (e) {
			attrs = {};
		}

		// Троттлінг: не частіше разу на добу
		const lastSync = attrs.avatar_synced_at ? new Date(attrs.avatar_synced_at).getTime() : 0;
		if (Date.now() - lastSync < 24 * 60 * 60 * 1000) return;

		const [trow] = await conn.execute(`SELECT token_cipher, token_iv, token_tag FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);
		const token = trow[0] && cryptoHelper.decrypt(trow[0].token_cipher, trow[0].token_iv, trow[0].token_tag);
		if (!token) return;

		try {
			// У приватному чаті chat.id === user.id
			const photos = await axios.get(`https://api.telegram.org/bot${token}/getUserProfilePhotos`, {
				params: { user_id: chatId, limit: 1 },
				timeout: 10000,
			});

			const pd = photos.data;
			if (!pd || !pd.ok || !pd.result.total_count) {
				// Немає фото — фіксуємо таймстемп, щоб не смикати щоразу
				attrs.avatar_synced_at = new Date().toISOString();
				await conn.execute(`UPDATE ${T_CONTACTS} SET attributes = ? WHERE id = ?`, [JSON.stringify(attrs), contact.id]);
				return;
			}

			// Найменший розмір фото (перший) — для аватара досить
			const sizes = pd.result.photos[0];
			const fileId = sizes[0].file_id;

			const fileResp = await axios.get(`https://api.telegram.org/bot${token}/getFile`, { params: { file_id: fileId }, timeout: 10000 });
			if (!fileResp.data || !fileResp.data.ok) return;

			const filePath = fileResp.data.result.file_path;
			const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;

			// Завантажуємо до себе
			const files = require("../../files");
			const saved = await files.downloadAvatar(downloadUrl, "tg_" + chatId, filePath.split(".").pop() || "jpg");
			if (!saved) return;

			attrs.avatar_synced_at = new Date().toISOString();
			await conn.execute(`UPDATE ${T_CONTACTS} SET avatar = ?, attributes = ? WHERE id = ?`, [saved, JSON.stringify(attrs), contact.id]);
		} catch (e) {
			// не критично
		}
	},

	// Стандартні запити Telegram: контакт і геолокація.
	// Реалізуються reply-клавіатурою з одноразовими кнопками.
	commands: [
		{ code: "request_contact", label: "contact_center.dialog.cmd_request_contact", icon: "fa-solid fa-address-card" },
		{ code: "request_location", label: "contact_center.dialog.cmd_request_location", icon: "fa-solid fa-location-dot" },
	],

	async sendCommand(conn, idChannel, target, command, text) {
		const [rows] = await conn.execute(`SELECT token_cipher, token_iv, token_tag FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);

		const r = rows[0];
		const token = r && cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag);
		if (!token) return { ok: false, error: "Токен каналу не задано" };

		const buttons = {
			request_contact: { text: text, request_contact: true },
			request_location: { text: text, request_location: true },
		};

		if (!buttons[command]) return { ok: false, error: "Невідома команда" };

		try {
			const response = await axios.post(
				`https://api.telegram.org/bot${token}/sendMessage`,
				{
					chat_id: target,
					text: text,
					reply_markup: {
						keyboard: [[buttons[command]]],
						resize_keyboard: true,
						one_time_keyboard: true,
					},
				},
				{ timeout: 15000 }
			);

			const data = response.data;
			if (!data || !data.ok) return { ok: false, error: "Telegram відхилив запит" };

			return { ok: true, source_id: String(data.result.message_id) };
		} catch (e) {
			const msg = (e.response && e.response.data && e.response.data.description) || e.message;
			return { ok: false, error: String(msg).slice(0, 500) };
		}
	},

	identitySql(alias) {
		return `CONCAT('@', COALESCE(${alias}.bot_username, ''))`;
	},
};
