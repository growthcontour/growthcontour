const axios = require("axios");
const config = require("../../../../config/config");
const cryptoHelper = require("../../../../helpers/crypto");

const P = config.get("configDatabase").prefix;
const TABLE = P + "contact_center_channel_instagram";

const GRAPH = "https://graph.instagram.com/v23.0";

module.exports = {
	code: "instagram",
	label: "contact_center.channels.type_instagram",
	icon: "fa-brands fa-instagram",
	color: "#e1306c",
	view: "./types/instagram",
	table: TABLE,

	async create(conn, idChannel) {
		await conn.execute(`INSERT INTO ${TABLE} (id_channel, verify_token) VALUES (?, ?)`, [idChannel, cryptoHelper.random(32)]);
	},

	async load(conn, idChannel) {
		const [rows] = await conn.execute(
			`SELECT id, ig_user_id, ig_username, ig_account_type, ig_profile_picture,
                    token_type, date_token_expires, date_token_refresh, app_id, verify_token,
                    app_secret_cipher
             FROM ${TABLE} WHERE id_channel = ? LIMIT 1`,
			[idChannel]
		);

		const r = rows[0] || {};
		return Object.assign({}, r, {
			has_token: !!r.ig_user_id || !!r.date_token_refresh,
			has_app_secret: !!r.app_secret_cipher,
			token_mask: "••••••••••••",
			app_secret_mask: r.app_secret_cipher ? "••••••••••••" : "",
		});
	},

	validate(body, current) {
		const errors = [];
		const token = String(body.token || "").trim();

		if (!token && !current.has_token) {
			errors.push({ field: "token", message: "Access token обов'язковий" });
		} else if (token && token.length < 30) {
			errors.push({ field: "token", message: "Токен виглядає некоректним" });
		}

		const appId = String(body.app_id || "").trim();
		if (appId && !/^\d{5,32}$/.test(appId)) {
			errors.push({ field: "app_id", message: "App ID має складатися з цифр" });
		}

		const appSecret = String(body.app_secret || "").trim();
		if (appSecret && appSecret.length < 16) {
			errors.push({ field: "app_secret", message: "App Secret виглядає некоректним" });
		}

		return { valid: errors.length === 0, errors: errors };
	},

	async save(conn, idChannel, body, current) {
		const token = String(body.token || "").trim();
		const appId = String(body.app_id || "").trim() || null;

		await conn.execute(`UPDATE ${TABLE} SET app_id = ? WHERE id_channel = ?`, [appId, idChannel]);

		// App Secret:
		//   галочка "очистити" → стираємо;
		//   порожнє поле без галочки → "не змінювати";
		//   заповнене поле → перезаписуємо (шифровано).
		const appSecret = String(body.app_secret || "").trim();
		const appSecretClear = String(body.app_secret_clear || "") === "1";

		if (appSecretClear) {
			await conn.execute(`UPDATE ${TABLE} SET app_secret_cipher = NULL, app_secret_iv = NULL, app_secret_tag = NULL WHERE id_channel = ?`, [idChannel]);
		} else if (appSecret) {
			const encS = cryptoHelper.encrypt(appSecret);
			await conn.execute(`UPDATE ${TABLE} SET app_secret_cipher = ?, app_secret_iv = ?, app_secret_tag = ? WHERE id_channel = ?`, [encS.cipher, encS.iv, encS.tag, idChannel]);
		}

		if (!token) return { configured: current.has_token, reload: false };

		const enc = cryptoHelper.encrypt(token);

		await conn.execute(
			`UPDATE ${TABLE}
             SET token_cipher = ?, token_iv = ?, token_tag = ?,
                 token_type = 'long_lived', date_token_refresh = NOW(),
                 ig_user_id = NULL, ig_username = NULL, ig_account_type = NULL
             WHERE id_channel = ?`,
			[enc.cipher, enc.iv, enc.tag, idChannel]
		);

		return { configured: false, reload: true };
	},

	async test(conn, idChannel) {
		const [rows] = await conn.execute(`SELECT token_cipher, token_iv, token_tag FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);

		const r = rows[0];
		const token = r && cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag);
		if (!token) return { ok: false, error: "Токен не задано" };

		try {
			const response = await axios.get(`${GRAPH}/me`, {
				params: { fields: "user_id,username,account_type,profile_picture_url", access_token: token },
				timeout: 10000,
			});

			const d = response.data;
			const igId = d && (d.user_id || d.id);
			if (!igId) return { ok: false, error: "Instagram не повернув дані акаунта" };

			await conn.execute(`UPDATE ${TABLE} SET ig_user_id = ?, ig_username = ?, ig_account_type = ?, ig_profile_picture = ? WHERE id_channel = ?`, [igId, d.username || null, d.account_type || null, d.profile_picture_url || null, idChannel]);

			return { ok: true };
		} catch (e) {
			const msg = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
			return { ok: false, error: String(msg).slice(0, 500) };
		}
	},

	async send(conn, idChannel, target, message) {
		const [rows] = await conn.execute(`SELECT token_cipher, token_iv, token_tag, ig_user_id FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);

		const r = rows[0];
		const token = r && cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag);
		if (!token) return { ok: false, error: "Токен каналу не задано" };
		if (!r.ig_user_id) return { ok: false, error: "Канал не перевірено" };

		try {
			const response = await axios.post(
				`${GRAPH}/me/messages`,
				{
					recipient: { id: target },
					message: { text: message.text },
				},
				{
					params: { access_token: token },
					timeout: 15000,
				}
			);

			const data = response.data;
			if (!data || !data.message_id) return { ok: false, error: "Instagram не повернув ID повідомлення" };

			return { ok: true, source_id: String(data.message_id) };
		} catch (e) {
			const msg = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
			return { ok: false, error: String(msg).slice(0, 500) };
		}
	},

	// ── Менеджер прочитав → показати клієнту "seen" в Instagram ──
	// Викликається з роуту read/messages (канало-агностичний хук onRead).
	async onRead(conn, idChannel, target, idManager) {
		const [rows] = await conn.execute(`SELECT token_cipher, token_iv, token_tag FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);
		const r = rows[0];
		const token = r && cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag);
		if (!token || !target) return;

		try {
			await axios.post(`${GRAPH}/me/messages`, { recipient: { id: target }, sender_action: "mark_seen" }, { params: { access_token: token }, timeout: 10000 });
		} catch (e) {
			// mark_seen не критичний — тихо ігноруємо
		}
	},

	// ── Відправка медіа (менеджер → клієнт) ──
	// Instagram завантажує файл сам за публічним URL (url має бути https і доступний ззовні).
	// Етап 2: підтримка зображень. Відео/аудіо/файли — та сама схема з іншим type.
	async sendMedia(conn, idChannel, target, media) {
		const [rows] = await conn.execute(`SELECT token_cipher, token_iv, token_tag, ig_user_id FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);

		const r = rows[0];
		const token = r && cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag);
		if (!token) return { ok: false, error: "Токен каналу не задано" };
		if (!r.ig_user_id) return { ok: false, error: "Канал не перевірено" };

		// Дозволені типи Instagram + ліміти (за докою Meta)
		const IG_MEDIA = {
			image: { max: 8 * 1024 * 1024 },
			video: { max: 25 * 1024 * 1024 },
			audio: { max: 25 * 1024 * 1024 },
			file: { max: 25 * 1024 * 1024 },
		};

		const mediaType = String(media.type || "").toLowerCase();
		if (!IG_MEDIA[mediaType]) {
			return { ok: false, error: "Instagram не підтримує цей тип вкладення" };
		}

		if (!/^https:\/\//i.test(String(media.url || ""))) {
			return { ok: false, error: "URL файлу має бути публічним https" };
		}

		// Розмір: Instagram відхиляє завеликі файли з невиразною помилкою —
		// краще перевірити тут і дати зрозуміле повідомлення.
		if (media.size && media.size > IG_MEDIA[mediaType].max) {
			const mb = Math.round(IG_MEDIA[mediaType].max / (1024 * 1024));
			return { ok: false, error: "Файл завеликий для Instagram (ліміт " + mb + " МБ для типу " + mediaType + ")" };
		}

		try {
			// Instagram не приймає підпис разом із медіа одним запитом:
			// якщо є текст-підпис — шлемо його окремим повідомленням спершу.
			if (media.caption) {
				await axios.post(`${GRAPH}/me/messages`, { recipient: { id: target }, message: { text: media.caption } }, { params: { access_token: token }, timeout: 15000 }).catch(function () {
					// підпис не критичний — навіть якщо не пішов, шлемо саме медіа
				});
			}

			const response = await axios.post(
				`${GRAPH}/me/messages`,
				{
					recipient: { id: target },
					message: {
						attachment: {
							type: mediaType,
							payload: { url: media.url, is_reusable: false },
						},
					},
				},
				{ params: { access_token: token }, timeout: 30000 }
			);

			const data = response.data;
			if (!data || !data.message_id) return { ok: false, error: "Instagram не повернув ID повідомлення" };

			return { ok: true, source_id: String(data.message_id) };
		} catch (e) {
			const msg = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
			return { ok: false, error: String(msg).slice(0, 500) };
		}
	},

	// ── Резолв каналу по ig_user_id (== entry.id з вебхука) ──
	// Повертає id_channel, розшифровані token і app_secret, verify_token, статус.
	// Використовується вхідним вебхуком.
	async resolveByIgUserId(conn, igUserId) {
		const [rows] = await conn.execute(
			`SELECT ig.id_channel, ig.verify_token,
                    ig.token_cipher, ig.token_iv, ig.token_tag,
                    ig.app_secret_cipher, ig.app_secret_iv, ig.app_secret_tag,
                    ch.status AS channel_active, ch.deleted
             FROM ${TABLE} AS ig
             INNER JOIN ${P}contact_center_channels AS ch ON ch.id = ig.id_channel
             WHERE ig.ig_user_id = ? AND ig.date_deleted IS NULL AND ch.deleted = 0
             LIMIT 1`,
			[String(igUserId)]
		);

		const r = rows[0];
		if (!r) return null;

		return {
			id_channel: r.id_channel,
			active: Number(r.channel_active) === 1,
			verify_token: r.verify_token || "",
			token: cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag),
			app_secret: cryptoHelper.decrypt(r.app_secret_cipher, r.app_secret_iv, r.app_secret_tag),
		};
	},

	// ── Профіль контакта (ім'я + аватар) ──
	// Instagram Login: GET /<IGSID>?fields=name,profile_pic.
	// Згода користувача виникає автоматично, коли він написав у Direct —
	// тобто рівно наш випадок (тягнемо у відповідь на вхідне).
	async fetchProfile(token, igsid) {
		try {
			const response = await axios.get(`${GRAPH}/${igsid}`, {
				params: { fields: "name,profile_pic", access_token: token },
				timeout: 10000,
			});
			const d = response.data || {};
			return {
				name: d.name || null,
				avatar: d.profile_pic || null,
			};
		} catch (e) {
			// Немає згоди / заблокований / профіль без імені — не помилка, просто пропускаємо
			const msg = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
			console.log("[ig-enrich] fetchProfile помилка:", msg);
			return null;
		}
	},

	// ── Збагачення контакта профілем ──
	// Викликається з вебхука асинхронно (setImmediate), не блокує відповідь Meta.
	// Троттлінг: оновлюємо не частіше разу на добу (profile_pic усе одно
	// протерміновується за кілька днів, тому періодичне оновлення потрібне).
	async enrichContact(conn, idChannel, igsid) {
		const P2 = require("../../../../config/config").get("configDatabase").prefix;
		const T_CONTACTS = P2 + "contact_center_contacts";

		console.log("[ig-enrich] старт igsid=" + igsid + " channel=" + idChannel);

		// 1. Поточний контакт + коли востаннє синкали профіль
		const [rows] = await conn.execute(
			`SELECT id, name, avatar, attributes FROM ${T_CONTACTS}
             WHERE id_channel = ? AND external_id = ? LIMIT 1`,
			[idChannel, String(igsid)]
		);
		const contact = rows[0];
		if (!contact) return;

		let attrs = {};
		try {
			attrs = contact.attributes ? (typeof contact.attributes === "string" ? JSON.parse(contact.attributes) : contact.attributes) : {};
		} catch (e) {
			attrs = {};
		}

		// Троттлінг: не частіше разу на 24 год
		const lastSync = attrs.profile_synced_at ? new Date(attrs.profile_synced_at).getTime() : 0;
		if (Date.now() - lastSync < 24 * 60 * 60 * 1000) return;

		// 2. Токен каналу
		const [tk] = await conn.execute(`SELECT token_cipher, token_iv, token_tag FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);
		const token = tk[0] && cryptoHelper.decrypt(tk[0].token_cipher, tk[0].token_iv, tk[0].token_tag);
		if (!token) return;

		// 3. Запит профілю
		const profile = await this.fetchProfile(token, igsid);
		console.log("[ig-enrich] fetchProfile →", JSON.stringify(profile));
		if (!profile) return;

		// 4. Оновлюємо ім'я/аватар (не перетираємо ім'я порожнім) + таймстемп
		attrs.profile_synced_at = new Date().toISOString();

		await conn.execute(
			`UPDATE ${T_CONTACTS}
                SET name   = COALESCE(NULLIF(?, ''), name),
                    avatar = COALESCE(?, avatar),
                    attributes = ?
              WHERE id = ?`,
			[profile.name || "", profile.avatar || null, JSON.stringify(attrs), contact.id]
		);
	},

	// ── Пошук verify_token для GET-верифікації ──
	// Meta б'є в один URL; verify_token у нас per-channel, тож шукаємо збіг.
	async findByVerifyToken(conn, verifyToken) {
		if (!verifyToken) return null;
		const [rows] = await conn.execute(`SELECT id_channel FROM ${TABLE} WHERE verify_token = ? AND date_deleted IS NULL LIMIT 1`, [String(verifyToken)]);
		return rows[0] ? { id_channel: rows[0].id_channel } : null;
	},

	// ── Нормалізація вебхук-події Instagram → канонічна форма моделі ──
	// entry — елемент payload.entry[]; ev — елемент entry.messaging[].
	// Повертає null, якщо подія нас не стосується (echo, реакції, read, порожнє).
	normalize(entry, ev) {
		if (!ev) return null;

		// Подія прочитання: клієнт прочитав наші вихідні.
		// Instagram Login шле read.mid (конкретне повідомлення).
		if (ev.read) {
			return {
				kind: "read",
				sender_id: ev.sender && ev.sender.id ? String(ev.sender.id) : null,
				mid: ev.read.mid || null,
				watermark: ev.read.watermark || null,
			};
		}

		// Реакція на наше вихідне повідомлення (emoji під бульбашкою).
		if (ev.reaction) {
			return {
				kind: "reaction",
				mid: ev.reaction.mid || null,
				action: ev.reaction.action === "unreact" ? "unreact" : "react",
				emoji: ev.reaction.emoji || null,
			};
		}

		if (!ev.message) return null;

		const msg = ev.message;

		// Echo нашого ж вихідного — не дублюємо
		if (msg.is_echo) return null;

		const senderId = ev.sender && ev.sender.id ? String(ev.sender.id) : null;
		if (!senderId) return null;

		const text = msg.text || null;
		const attachments = [];

		// Медіа: кожне вкладення Meta → рядок для нашого конвеєра.
		// payload.url — тимчасове CDN-посилання; files.js завантажить його
		// з Bearer-токеном каналу (source_type='url' → status='pending').
		const rawAtts = Array.isArray(msg.attachments) ? msg.attachments : [];

		for (const a of rawAtts) {
			const t = a.type;
			const url = a.payload && a.payload.url;
			if (!url) continue; // story_mention/share без url — пропускаємо

			let type = "file";
			let subtype = null;

			if (t === "image") {
				type = "image";
			} else if (t === "video" || t === "ig_reel") {
				type = "video";
			} else if (t === "audio") {
				type = "audio";
				subtype = "voice"; // голосові в IG приходять як audio
			} else {
				type = "file";
			}

			attachments.push({
				type: type,
				subtype: subtype,
				source_type: "url",
				source_ref: String(url),
				file_name: null,
				mime: null,
			});
		}

		// Нічого корисного (напр. чиста реакція чи непідтримуване вкладення без url)
		if (!text && !attachments.length) return null;

		const msgType = attachments.length ? "media" : "text";
		const tsMs = Number(ev.timestamp) || Date.now();

		return {
			contact: {
				external_id: senderId,
				first_name: null,
				last_name: null,
				username: null,
			},
			source_thread_id: senderId,
			message: {
				source_id: String(msg.mid || ""),
				type: msgType,
				subtype: null,
				text: text,
				attachments: attachments,
				// Клієнт відповів на конкретне повідомлення — mid оригіналу
				reply_to_source_id: msg.reply_to && msg.reply_to.mid ? String(msg.reply_to.mid) : null,
				date_add: new Date(tsMs),
			},
		};
	},

	identitySql(alias) {
		return `CONCAT('@', COALESCE(${alias}.ig_username, ''))`;
	},
};
