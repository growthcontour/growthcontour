const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const types = require("./channels/index");
const model = require("./model");
const ccNotifications = require("./notifications");
const files = require("./files");

const P = config.get("configDatabase").prefix;

const T_CONVS = P + "contact_center_conversations";
const T_CONTACTS = P + "contact_center_contacts";
const T_CHANNELS = P + "contact_center_channels";
const T_UNREAD = P + "contact_center_unread";

// Метадані типів каналів — щоб фронту не треба було нічого доганяти
const META = {};
types.all().forEach(function (t) {
	META[t.code] = { icon: t.icon, color: t.color, label: t.label };
});

const conversationsControllers = {
	// ── Список чатів ──
	// Один запит на всі канали. Новий канал нічого тут не змінює.
	list: async (req, res) => {
		try {
			const currentUserId = req.user.userId;

			const b = req.body || {};
			const view = b.view === "mine" ? "mine" : "all";
			const tab = ["open", "pending", "resolved", "archived"].indexOf(b.tab) !== -1 ? b.tab : "open";
			const limit = Math.min(Math.max(parseInt(b.limit, 10) || 30, 1), 100);

			const params = [currentUserId, tab];
			let where = "";

			if (view === "mine") {
				// Тільки мої діалоги
				where += " AND c.id_manager = ?";
				params.push(currentUserId);
			} else {
				// Спільна черга: нерозібрані + мої. Чужі не показуємо.
				where += " AND (c.id_manager IS NULL OR c.id_manager = ?)";
				params.push(currentUserId);
			}

			// Курсорна пагінація: (date_last_message, id) — пара унікальна і монотонна
			const cursorDate = b.cursorDate ? String(b.cursorDate) : null;
			const cursorId = b.cursorId ? parseInt(b.cursorId, 10) : null;

			if (cursorDate && cursorId) {
				where += ` AND (c.date_last_message < CAST(? AS DATETIME(3))
                           OR (c.date_last_message = CAST(? AS DATETIME(3)) AND c.id < ?))`;
				params.push(cursorDate, cursorDate, cursorId);
			}

			const [rows] = await connection_pool.query(
				`SELECT
                    c.id, c.url_token, c.status, c.id_manager,
                    c.last_message_text, c.last_message_type, c.last_message_dir,
                    c.date_last_message,
                    ch.type AS channel, ch.name AS channel_name, ch.status AS channel_active,
					ct.name AS contact_name, ct.username AS contact_username, ct.avatar AS contact_avatar,
                    (SELECT COUNT(*)
                       FROM ${P}contact_center_messages AS m
                      WHERE m.id_conversation = c.id
                        AND m.direction = 'in'
                        AND m.id > COALESCE(ur.id_last_read_message, 0)
                    ) AS count
                 FROM ${T_CONVS} AS c
                 INNER JOIN ${T_CHANNELS} AS ch ON ch.id = c.id_channel
                 INNER JOIN ${T_CONTACTS} AS ct ON ct.id = c.id_contact
                 LEFT JOIN ${T_UNREAD} AS ur ON ur.id_conversation = c.id AND ur.id_manager = ?
				 WHERE ch.deleted = 0 AND ch.status = 1 AND c.status = ? ${where}
                 ORDER BY c.date_last_message DESC, c.id DESC
                 LIMIT ${limit}`,
				params
			);

			const hasMore = rows.length === limit;

			const items = rows.map(function (r) {
				const meta = META[r.channel] || {};

				return {
					id: r.id,
					url_token: r.url_token,
					channel: r.channel,
					channel_name: r.channel_name,
					channel_icon: meta.icon || "",
					channel_color: meta.color || "#6c757d",
					channel_active: Number(r.channel_active) === 1 ? 1 : 0,
					title: r.contact_name || (r.contact_username ? "@" + r.contact_username : "—"),
					avatar: r.contact_avatar || "",
					preview: r.last_message_text || "",
					preview_dir: r.last_message_dir || "in",
					last_at: r.date_last_message,
					count: r.count | 0,
					// 0 — нерозібраний, 1 — мій
					status: r.id_manager === null ? 0 : 1,
				};
			});

			const last = rows[rows.length - 1];

			res.status(200).json({
				items: items,
				nextCursorDate: hasMore && last ? String(last.date_last_message) : null,
				nextCursorId: hasMore && last ? last.id : null,
			});
		} catch (error) {
			console.error("conversations list:", error.message);
			logging.error(error);
			res.status(500).json({ error: "server_error" });
		}
	},

	// ── Сторінка діалогу ──
	page: async (req, res) => {
		const token = String(req.params.token || "");

		// url_token — рівно 32 hex
		if (!/^[a-f0-9]{32}$/.test(token)) return res.redirect("/contact-center/");

		try {
			const conv = await model.getConversationByToken(token);
			if (!conv) return res.redirect("/contact-center/");

			const type = types.get(conv.channel_type);

			res.render("pages/contact-center/contact-center/dialog", {
				i18n: res,
				user: req.user,
				data: {
					conversation: conv,
					meta: type ? { icon: type.icon, color: type.color, label: type.label } : { icon: "", color: "#6c757d", label: "" },
					// Команди канало-специфічні: дропдаун показується лише там, де вони є
					commands: (type && type.commands) || [],
					canSendMedia: !!(type && typeof type.sendMedia === "function"),
				},
				header: { navbar: "contact-center" },
			});
		} catch (error) {
			console.error("conversation page:", error.message);
			logging.error(error);
			res.status(500).send("Internal Server Error");
		}
	},

	// ── Стрічка повідомлень ──
	messages: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ error: "bad_id" });

		try {
			const result = await model.getMessages(id, req.body && req.body.before, req.body && req.body.limit);

			// Відкрив діалог — непрочитані обнуляються
			await model.markRead(id, req.user.userId);
			await ccNotifications.markConversationRead(id, req.user.userId);

			// Канал може мати власну логіку прочитання (веб-чат шле галочку клієнту)
			const [convRows] = await connection_pool.query(
				`SELECT c.id_channel, c.source_thread_id, ct.external_id, ch.type AS channel_type
                   FROM ${T_CONVS} AS c
                   INNER JOIN ${T_CONTACTS} AS ct ON ct.id = c.id_contact
                   INNER JOIN ${T_CHANNELS} AS ch ON ch.id = c.id_channel
                  WHERE c.id = ? LIMIT 1`,
				[id]
			);

			if (convRows.length) {
				const type = types.get(convRows[0].channel_type);
				if (type && typeof type.onRead === "function") {
					const conn = await connection_pool.getConnection();
					try {
						await type.onRead(conn, convRows[0].id_channel, convRows[0].source_thread_id || convRows[0].external_id, req.user.userId);
					} catch (e) {
						console.error("channel onRead:", e.message);
					} finally {
						conn.release();
					}
				}
			}

			res.status(200).json(result);
		} catch (error) {
			console.error("conversation messages:", error.message);
			logging.error(error);
			res.status(500).json({ error: "server_error" });
		}
	},

	// ── Відправка повідомлення ──
	// Порядок навмисний: спершу запис у БД зі status='pending',
	// потім виклик API каналу, потім markSent/markFailed.
	// Збій відправки лишається видимим станом, а не втратою повідомлення.
	send: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		const text = String((req.body && req.body.text) || "").trim();

		if (!id) return res.status(400).json({ status: "error", message: "Невірний ID" });
		if (!text) return res.status(400).json({ status: "error", message: "Порожнє повідомлення" });
		if (text.length > 4000) return res.status(400).json({ status: "error", message: "Повідомлення задовге" });

		try {
			const [rows] = await connection_pool.query(
				`SELECT c.id, c.id_channel, c.id_manager, c.source_thread_id, ct.external_id,
                        ch.type AS channel_type, ch.status AS channel_active
                 FROM ${T_CONVS} AS c
                 INNER JOIN ${T_CONTACTS} AS ct ON ct.id = c.id_contact
                 INNER JOIN ${T_CHANNELS} AS ch ON ch.id = c.id_channel
                 WHERE c.id = ? AND ch.deleted = 0 LIMIT 1`,
				[id]
			);

			if (!rows.length) return res.status(404).json({ status: "error", message: "Діалог не знайдено" });

			const conv = rows[0];
			if (Number(conv.channel_active) !== 1) {
				return res.status(400).json({ status: "error", message: "Канал вимкнено" });
			}

			// Відповідати може лише менеджер, який узяв діалог у роботу.
			// Перевірка на сервері — UI лише дублює її для зручності.
			if (conv.id_manager === null) {
				return res.status(403).json({ status: "error", message: "Спочатку візьміть діалог у роботу" });
			}
			if (Number(conv.id_manager) !== Number(req.user.userId)) {
				return res.status(403).json({ status: "error", message: "Діалог веде інший менеджер" });
			}

			const type = types.get(conv.channel_type);
			if (!type || typeof type.send !== "function") {
				return res.status(400).json({ status: "error", message: "Канал не підтримує відправку" });
			}

			// 1. Запис у БД
			const saved = await model.addOutgoing({
				id_conversation: conv.id,
				id_manager: req.user.userId,
				message: { type: "text", text: text },
			});

			// 2. Відправка в канал
			const target = conv.source_thread_id || conv.external_id;
			const conn = await connection_pool.getConnection();
			let result;
			try {
				result = await type.send(conn, conv.id_channel, target, { text: text, id_manager: req.user.userId });
			} finally {
				conn.release();
			}

			// 3. Фіксація результату
			if (result.ok) {
				await model.markSent(saved.id_message, result.source_id);
			} else {
				await model.markFailed(saved.id_message, result.error);
			}

			res.status(200).json({
				status: result.ok ? "success" : "error",
				id_message: saved.id_message,
				date_add: saved.date_add,
				message: result.ok ? null : result.error,
			});
		} catch (error) {
			console.error("conversation send:", error.message);
			logging.error(error);
			res.status(500).json({ status: "error", message: "Помилка сервера" });
		}
	},

	// ── Позначити прочитаним ──
	// Викликається не лише при відкритті сторінки, а й на кожне нове
	// повідомлення у видимому діалозі — інакше клієнт не бачить другу галочку.
	read: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ status: "error" });

		try {
			await model.markRead(id, req.user.userId);
			await ccNotifications.markConversationRead(id, req.user.userId);

			const [rows] = await connection_pool.query(
				`SELECT c.id_channel, c.source_thread_id, ct.external_id, ch.type AS channel_type
                   FROM ${T_CONVS} AS c
                   INNER JOIN ${T_CONTACTS} AS ct ON ct.id = c.id_contact
                   INNER JOIN ${T_CHANNELS} AS ch ON ch.id = c.id_channel
                  WHERE c.id = ? LIMIT 1`,
				[id]
			);

			if (rows.length) {
				const type = types.get(rows[0].channel_type);
				if (type && typeof type.onRead === "function") {
					const conn = await connection_pool.getConnection();
					try {
						await type.onRead(conn, rows[0].id_channel, rows[0].source_thread_id || rows[0].external_id, req.user.userId);
					} catch (e) {
						console.error("channel onRead:", e.message);
					} finally {
						conn.release();
					}
				}
			}

			res.status(200).json({ status: "success" });
		} catch (error) {
			console.error("conversation read:", error.message);
			logging.error(error);
			res.status(500).json({ status: "error" });
		}
	},

	// ── Завантаження файлу від менеджера ──
	// Файл спершу лягає до нас, потім віддається каналу за публічним URL.
	upload: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ status: "error", message: "Невірний ID" });
		if (!req.file) return res.status(400).json({ status: "error", message: "Файл не передано" });

		try {
			const [rows] = await connection_pool.query(
				`SELECT c.id, c.id_channel, c.id_manager, c.url_token, c.source_thread_id,
                        ct.external_id, ch.type AS channel_type, ch.status AS channel_active
                 FROM ${T_CONVS} AS c
                 INNER JOIN ${T_CONTACTS} AS ct ON ct.id = c.id_contact
                 INNER JOIN ${T_CHANNELS} AS ch ON ch.id = c.id_channel
                 WHERE c.id = ? AND ch.deleted = 0 LIMIT 1`,
				[id]
			);

			if (!rows.length) return res.status(404).json({ status: "error", message: "Діалог не знайдено" });

			const conv = rows[0];

			if (Number(conv.channel_active) !== 1) return res.status(400).json({ status: "error", message: "Канал вимкнено" });
			if (conv.id_manager === null) return res.status(403).json({ status: "error", message: "Спочатку візьміть діалог у роботу" });
			if (Number(conv.id_manager) !== Number(req.user.userId)) return res.status(403).json({ status: "error", message: "Діалог веде інший менеджер" });

			// Тип вкладення з MIME
			const mime = req.file.mimetype || "application/octet-stream";
			const attachType = /^image\//.test(mime) ? "image" : /^video\//.test(mime) ? "video" : /^audio\//.test(mime) ? "audio" : "file";

			const publicPath = files.PUBLIC_PREFIX + "/" + files.conversationDir(conv.channel_type, conv.url_token, "manager").replace(/\\/g, "/") + "/" + req.file.filename;

			const caption = String((req.body && req.body.caption) || "").trim() || null;

			// 1. Запис у БД
			const saved = await model.addOutgoing({
				id_conversation: conv.id,
				id_manager: req.user.userId,
				message: {
					type: "media",
					text: caption,
					attachments: [
						{
							type: attachType,
							path: publicPath,
							file_name: req.file.originalname,
							mime: mime,
							size: req.file.size,
							source_type: "none",
						},
					],
				},
			});

			// 2. Відправка в канал
			const type = types.get(conv.channel_type);
			const target = conv.source_thread_id || conv.external_id;

			let result = { ok: false, error: "Канал не підтримує файли" };

			if (type && typeof type.sendMedia === "function") {
				const conn = await connection_pool.getConnection();
				try {
					result = await type.sendMedia(conn, conv.id_channel, target, {
						type: attachType,
						url: config.get("configServer").url + publicPath,
						caption: caption,
						size: req.file.size,
					});
				} finally {
					conn.release();
				}
			}

			// 3. Фіксація
			if (result.ok) await model.markSent(saved.id_message, result.source_id);
			else await model.markFailed(saved.id_message, result.error);

			res.status(200).json({
				status: result.ok ? "success" : "error",
				id_message: saved.id_message,
				date_add: saved.date_add,
				attachment: { type: attachType, path: publicPath, file_name: req.file.originalname, mime: mime, size: req.file.size, status: "done" },
				message: result.ok ? null : result.error,
			});
		} catch (error) {
			console.error("conversation upload:", error.message);
			logging.error(error);
			res.status(500).json({ status: "error", message: "Помилка сервера" });
		}
	},

	// ── Команда каналу (запит контакту, геолокації) ──
	command: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		const command = String((req.body && req.body.command) || "");
		const text = String((req.body && req.body.text) || "").trim();

		if (!id) return res.status(400).json({ status: "error", message: "Невірний ID" });
		if (!command) return res.status(400).json({ status: "error", message: "Команду не вказано" });

		try {
			const [rows] = await connection_pool.query(
				`SELECT c.id, c.id_channel, c.id_manager, c.source_thread_id,
                        ct.external_id, ch.type AS channel_type, ch.status AS channel_active
                 FROM ${T_CONVS} AS c
                 INNER JOIN ${T_CONTACTS} AS ct ON ct.id = c.id_contact
                 INNER JOIN ${T_CHANNELS} AS ch ON ch.id = c.id_channel
                 WHERE c.id = ? AND ch.deleted = 0 LIMIT 1`,
				[id]
			);

			if (!rows.length) return res.status(404).json({ status: "error", message: "Діалог не знайдено" });

			const conv = rows[0];

			if (Number(conv.channel_active) !== 1) return res.status(400).json({ status: "error", message: "Канал вимкнено" });
			if (Number(conv.id_manager) !== Number(req.user.userId)) return res.status(403).json({ status: "error", message: "Спочатку візьміть діалог у роботу" });

			const type = types.get(conv.channel_type);
			if (!type || typeof type.sendCommand !== "function") {
				return res.status(400).json({ status: "error", message: "Канал не підтримує команди" });
			}

			// Текст кнопки — те, що побачить клієнт
			const label = text || (command === "request_contact" ? "Поділитися номером" : "Поділитися локацією");

			const saved = await model.addOutgoing({
				id_conversation: conv.id,
				id_manager: req.user.userId,
				message: { type: "system", subtype: command, text: label },
			});

			const conn = await connection_pool.getConnection();
			let result;
			try {
				result = await type.sendCommand(conn, conv.id_channel, conv.source_thread_id || conv.external_id, command, label);
			} finally {
				conn.release();
			}

			if (result.ok) await model.markSent(saved.id_message, result.source_id);
			else await model.markFailed(saved.id_message, result.error);

			res.status(200).json({
				status: result.ok ? "success" : "error",
				id_message: saved.id_message,
				date_add: saved.date_add,
				text: label,
				message: result.ok ? null : result.error,
			});
		} catch (error) {
			console.error("conversation command:", error.message);
			logging.error(error);
			res.status(500).json({ status: "error", message: "Помилка сервера" });
		}
	},

	// ── Медіатека діалогу ──
	media: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ error: "bad_id" });

		try {
			const data = await model.getMedia(id);
			res.status(200).json(data);
		} catch (error) {
			console.error("conversation media:", error.message);
			logging.error(error);
			res.status(500).json({ error: "server_error" });
		}
	},

	// ── Взяти в роботу / звільнити ──
	assign: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ status: "error" });

		// take — призначити собі, release — зняти
		const take = !(req.body && req.body.release);

		try {
			await model.assignManager(id, take ? req.user.userId : null);
			res.status(200).json({ status: "success", id_manager: take ? req.user.userId : null });
		} catch (error) {
			console.error("conversation assign:", error.message);
			logging.error(error);
			res.status(500).json({ status: "error" });
		}
	},

	// ── Зміна статусу ──
	status: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		const status = String((req.body && req.body.status) || "");

		if (!id) return res.status(400).json({ status: "error" });
		if (["open", "pending", "resolved", "archived"].indexOf(status) === -1) {
			return res.status(400).json({ status: "error", message: "Невідомий статус" });
		}

		try {
			await model.setStatus(id, status);
			res.status(200).json({ status: "success" });
		} catch (error) {
			console.error("conversation status:", error.message);
			logging.error(error);
			res.status(500).json({ status: "error" });
		}
	},

	// ── Лічильники для вкладок ──
	// Окремим запитом, щоб список не тягнув COUNT на кожне оновлення.
	counters: async (req, res) => {
		try {
			const currentUserId = req.user.userId;

			const [rows] = await connection_pool.query(
				`SELECT c.status,
                        COUNT(*) AS total,
                        SUM(CASE WHEN c.id_manager = ? THEN 1 ELSE 0 END) AS mine,
                        SUM(CASE WHEN c.id_manager IS NULL THEN 1 ELSE 0 END) AS unassigned,
                                                COALESCE(SUM(
                            (SELECT COUNT(*)
                               FROM ${P}contact_center_messages AS m
                              WHERE m.id_conversation = c.id
                                AND m.direction = 'in'
                                AND m.id > COALESCE(ur.id_last_read_message, 0))
                        ), 0) AS unread
                 FROM ${T_CONVS} AS c
                 INNER JOIN ${T_CHANNELS} AS ch ON ch.id = c.id_channel
                 LEFT JOIN ${T_UNREAD} AS ur ON ur.id_conversation = c.id AND ur.id_manager = ?
				 WHERE ch.deleted = 0 AND ch.status = 1
                   AND (c.id_manager IS NULL OR c.id_manager = ?)
                 GROUP BY c.status`,
				[currentUserId, currentUserId, currentUserId]
			);

			const out = { open: 0, pending: 0, resolved: 0, archived: 0, unread: 0 };

			rows.forEach(function (r) {
				out[r.status] = Number(r.total) || 0;
				out.unread += Number(r.unread) || 0;
			});

			res.status(200).json(out);
		} catch (error) {
			console.error("conversations counters:", error.message);
			logging.error(error);
			res.status(500).json({ open: 0, pending: 0, resolved: 0, archived: 0, unread: 0 });
		}
	},

	// ── Повне видалення діалогу (БД + файли, незворотно) ──
	// Право: власник діалогу АБО can_delete на сторінці контакт-центру.
	delete: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ status: "error", message: "Невірний ID" });

		try {
			const [rows] = await connection_pool.query(`SELECT id, id_manager FROM ${T_CONVS} WHERE id = ? LIMIT 1`, [id]);
			if (!rows.length) return res.status(404).json({ status: "error", message: "Діалог не знайдено" });

			const conv = rows[0];
			const isOwner = conv.id_manager !== null && Number(conv.id_manager) === Number(req.user.userId);
			const canDelete = req.user.permissions && req.user.permissions["contact-center"] && req.user.permissions["contact-center"].delete === true;

			if (!isOwner && !canDelete) {
				return res.status(403).json({ status: "error", message: "Видаляти може лише власник діалогу або адміністратор" });
			}

			const info = await model.deleteConversation(id);

			if (info && info.channel_type === "webchat" && info.site_id && info.room_id) {
				try {
					const webchat = require("../../routes/contact-center/web-chat/web-chat");
					if (typeof webchat.deleteChatExternal === "function") {
						await webchat.deleteChatExternal(info.site_id, info.room_id);
					}
				} catch (e) {
					console.error("webchat deleteChatExternal:", e.message);
				}
			}

			res.status(200).json({ status: "success" });
		} catch (error) {
			console.error("conversation delete:", error.message);
			logging.error(error);
			res.status(500).json({ status: "error", message: "Помилка сервера" });
		}
	},

	// Товари, які переглядав клієнт (веб-чат): поточний + історія
	products: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ error: "bad_id" });
		try {
			const bridge = require("./webchat-bridge");
			const data = await bridge.productsForConversation(id);
			res.status(200).json(data);
		} catch (error) {
			console.error("conversation products:", error.message);
			res.status(200).json({ current: null, history: [] });
		}
	},

	online: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ online: false });
		try {
			const bridge = require("./webchat-bridge");
			const online = await bridge.isConversationOnline(id);
			res.status(200).json({ online: !!online });
		} catch (e) {
			res.status(200).json({ online: false });
		}
	},

	onlineList: async (req, res) => {
		try {
			const bridge = require("./webchat-bridge");
			const ids = await bridge.onlineConversationIds();
			res.status(200).json({ ids: ids });
		} catch (e) {
			res.status(200).json({ ids: [] });
		}
	},

	visitorInfo: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ info: null });
		try {
			const bridge = require("./webchat-bridge");
			const info = await bridge.visitorInfoForConversation(id);
			res.status(200).json({ info: info });
		} catch (e) {
			res.status(200).json({ info: null });
		}
	},
};

module.exports = conversationsControllers;
