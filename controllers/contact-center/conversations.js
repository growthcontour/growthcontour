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

			// Сповіщення цього діалогу чистимо ДО рендера — щоб сторінка
			// відкрилася вже без них (а не зникали після оновлення).
			try {
				const P2 = config.get("configDatabase").prefix;
				await connection_pool.query(`UPDATE ${P2}notif_inbox SET archived_at = NOW(3) WHERE user_id = ? AND collapse_key = ? AND archived_at IS NULL`, [req.user.userId, "cc_conv_" + conv.id]);
				await model.markRead(conv.id, req.user.userId);
				await ccNotifications.markConversationRead(conv.id, req.user.userId).catch(function () {});
			} catch (e) {
				console.error("cc page notif clear:", e.message);
			}

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

	// ── Взяти в роботу / звільнити / передати ──
	assign: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ status: "error" });

		const b = req.body || {};
		const me = Number(req.user.userId);

		// Три режими:
		//   take (за замовч.) — призначити собі
		//   release          — зняти менеджера
		//   transfer_to      — передати іншому менеджеру (id)
		let newManager;
		if (b.transfer_to != null && String(b.transfer_to).trim() !== "") {
			newManager = parseInt(b.transfer_to, 10);
			if (!newManager) return res.status(400).json({ status: "error", message: "Невірний менеджер" });
		} else if (b.release) {
			newManager = null;
		} else {
			newManager = me;
		}

		const conn = await connection_pool.getConnection();
		try {
			// Поточний власник
			const [rows] = await conn.query(`SELECT id_manager FROM ${T_CONVS} WHERE id = ? LIMIT 1`, [id]);
			if (!rows.length) return res.status(404).json({ status: "error", message: "Діалог не знайдено" });

			const owner = rows[0].id_manager === null ? null : Number(rows[0].id_manager);

			// Правила:
			//   вільний чат можна лише взяти собі (take);
			//   звільняти/передавати може ЛИШЕ поточний власник.
			if (newManager === me && owner === null) {
				// take вільного — ок
			} else if (owner === me) {
				// release або transfer від власника — ок
			} else {
				return res.status(403).json({ status: "error", message: "Дію може виконати лише менеджер, який веде діалог" });
			}

			await model.assignManager(id, newManager);

			// Realtime
			const realtime = require("./realtime");
			// Хто втратив діалог (звільнення або передача) — прибрати зі списку "мої"
			if (owner !== null && owner !== newManager) {
				realtime.conversationRemoved(id, owner);
			}
			// Оновити спільний список: чат став вільним або перейшов
			realtime.conversationStatus(id, newManager === null ? "unassigned" : "assigned");

			res.status(200).json({ status: "success", id_manager: newManager });
		} catch (error) {
			console.error("conversation assign:", error.message);
			logging.error(error);
			res.status(500).json({ status: "error" });
		} finally {
			conn.release();
		}
	},

	// ── Пошук менеджерів для передачі діалогу (формат Select2 + пагінація) ──
	managersSearch: async (req, res) => {
		const b = req.body || {};
		const q = String(b.q || "").trim();
		const page = Math.max(parseInt(b.page, 10) || 1, 1);
		const perPage = 10;
		const offset = (page - 1) * perPage;
		const me = Number(req.user.userId);

		try {
			const params = [];
			let where = "active = 1 AND id <> ?";
			params.push(me);

			if (q) {
				// Префіксний пошук — по індексу
				const like = q + "%";
				where += " AND (last_name LIKE ? OR first_name LIKE ?)";
				params.push(like, like);
			}

			// Беремо на 1 більше, ніж perPage, щоб зрозуміти, чи є ще сторінки
			const [rows] = await connection_pool.query(
				`SELECT id, first_name, last_name,
                        NULLIF(TRIM(CONCAT_WS(' ', last_name, first_name)), '') AS user_name
                 FROM ${P}users
                 WHERE ${where}
                 ORDER BY last_name, first_name
                 LIMIT ${perPage + 1} OFFSET ${offset}`,
				params
			);

			const more = rows.length > perPage;
			if (more) rows.pop();

			res.status(200).json({
				results: rows.map(function (u) {
					return { id: u.id, text: u.user_name || "#" + u.id };
				}),
				pagination: { more: more },
			});
		} catch (error) {
			console.error("managers search:", error.message);
			logging.error(error);
			res.status(500).json({ results: [], pagination: { more: false } });
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

	typing: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ ok: false });
		try {
			const bridge = require("./webchat-bridge");
			await bridge.operatorTyping(id);
			res.status(200).json({ ok: true });
		} catch (e) {
			res.status(200).json({ ok: false });
		}
	},

	listForms: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ ok: false });
		try {
			const bridge = require("./webchat-bridge");
			const forms = await bridge.formsByConversation(id);
			res.status(200).json({ ok: true, forms });
		} catch (e) {
			res.status(200).json({ ok: true, forms: [] });
		}
	},

	sendForm: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		const formId = String((req.body && req.body.formId) || "");
		if (!id || !formId) return res.status(400).json({ ok: false, error: "Невірні дані" });
		try {
			// лише власник діалогу
			const [convRows] = await connection_pool.query(`SELECT id_manager FROM ${T_CONVS} WHERE id = ? LIMIT 1`, [id]);
			if (!convRows.length) return res.status(404).json({ ok: false, error: "Діалог не знайдено" });
			if (Number(convRows[0].id_manager) !== Number(req.user.userId)) {
				return res.status(403).json({ ok: false, error: "Спершу візьміть діалог у роботу" });
			}
			const bridge = require("./webchat-bridge");
			const result = await bridge.sendFormByConversation(id, formId, req.user.userId);
			res.status(result.ok ? 200 : 400).json(result);
		} catch (e) {
			logging.error(e);
			res.status(500).json({ ok: false, error: "Помилка сервера" });
		}
	},

	createLead: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ ok: false, error: "Невірний ID" });
		const b = req.body || {};
		const P = config.get("configDatabase").prefix;

		try {
			const [convRows] = await connection_pool.query(
				`SELECT c.id, c.url_token, ch.type AS channel_type, ct.name AS contact_name, ct.phone, ct.email, ct.external_id, c.id_channel
                 FROM ${T_CONVS} c
                 INNER JOIN ${P}contact_center_contacts ct ON ct.id = c.id_contact
                 INNER JOIN ${P}contact_center_channels ch ON ch.id = c.id_channel
                 WHERE c.id = ? LIMIT 1`,
				[id]
			);

			if (!convRows.length) return res.status(404).json({ ok: false, error: "Діалог не знайдено" });
			const conv = convRows[0];

			const name = String(b.name || conv.contact_name || "").trim();
			const phone = String(b.phone || conv.phone || "").trim();
			const email = String(b.email || conv.email || "").trim();
			const note = String(b.note || "").slice(0, 2000);
			const value = b.value != null && String(b.value).trim() !== "" ? Number(String(b.value).replace(",", ".")) : 0;

			const contactInfo = { name, phone, email, company: "", position: "" };
			const title = String(b.title || "").trim() || "Чат: " + (name || phone || email || "клієнт");

			// Товар / UTM / fingerprint — для веб-чату підтягуємо з bridge
			let productsJson = null,
				utm = null,
				fingerprint = null;
			if (conv.channel_type === "webchat") {
				try {
					const bridge = require("./webchat-bridge");
					const prods = await bridge.productsForConversation(id).catch(() => null);
					if (prods && prods.current) productsJson = JSON.stringify([prods.current]);
					else if (prods && prods.history && prods.history.length) productsJson = JSON.stringify([prods.history[0].product]);

					const info = await bridge.visitorInfoForConversation(id).catch(() => null);
					if (info) {
						const u = info.utm || {};
						const utmObj = { source: u.source || "", medium: u.medium || "", campaign: u.campaign || "", term: u.term || "", content: u.content || "", referrer: info.referrer || "" };
						if (Object.values(utmObj).some((v) => v)) utm = utmObj;
						const fp = { ip: info.ip || "", os: info.platform || "", page: info.pageUrl || "", screen: info.screen || "", languages: info.languages || "", timezone: info.timezone || "", userAgent: info.userAgent || "" };
						if (Object.values(fp).some((v) => v)) fingerprint = fp;
					}
				} catch (e) {}
			}

			// Пайплайн 1, статус 1, перша активна стадія
			const LEAD_PIPELINE = 1,
				LEAD_STATUS = 1;
			let leadStageId = null;
			try {
				const [stg] = await connection_pool.query(`SELECT id FROM ${P}leads_pipeline_stages WHERE id_pipeline = ? AND is_active = 1 ORDER BY sort ASC LIMIT 1`, [LEAD_PIPELINE]);
				if (stg.length) leadStageId = stg[0].id;
			} catch (e) {}

			const now = new Date().toISOString().slice(0, 19).replace("T", " ");
			const [ins] = await connection_pool.query(
				`INSERT INTO ${P}leads
                    (title, note, value, id_pipeline, id_stage, id_status, priority, lead_source, website,
                     capture_type, capture_ref, id_manager, contact_info, utm, fingerprint, products, date_add, date_edit)
                 VALUES (?, ?, ?, ?, ?, ?, 1, 'contact-center', '', 'contact-center', ?, ?, CAST(? AS JSON),
                         ${utm ? "CAST(? AS JSON)" : "NULL"},
                         ${fingerprint ? "CAST(? AS JSON)" : "NULL"},
                         ${productsJson ? "CAST(? AS JSON)" : "NULL"},
                         ?, ?)`,
				(function () {
					const params = [title, note, isNaN(value) ? 0 : value, LEAD_PIPELINE, leadStageId, LEAD_STATUS, "cc_conv_" + id, req.user.userId, JSON.stringify(contactInfo)];
					if (utm) params.push(JSON.stringify(utm));
					if (fingerprint) params.push(JSON.stringify(fingerprint));
					if (productsJson) params.push(productsJson);
					params.push(now, now);
					return params;
				})()
			);

			res.status(200).json({ ok: true, id_lead: ins.insertId });
		} catch (error) {
			console.error("createLead:", error.message);
			logging.error(error);
			res.status(500).json({ ok: false, error: error.sqlMessage || "Помилка сервера" });
		}
	},

	createOrder: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ ok: false, error: "Невірний ID" });
		const b = req.body || {};
		const P = config.get("configDatabase").prefix;

		try {
			const [convRows] = await connection_pool.query(
				`SELECT c.id, ch.type AS channel_type, ct.name AS contact_name, ct.phone, ct.email
                 FROM ${T_CONVS} c
                 INNER JOIN ${P}contact_center_contacts ct ON ct.id = c.id_contact
                 INNER JOIN ${P}contact_center_channels ch ON ch.id = c.id_channel
                 WHERE c.id = ? LIMIT 1`,
				[id]
			);
			if (!convRows.length) return res.status(404).json({ ok: false, error: "Діалог не знайдено" });
			const conv = convRows[0];

			// Товари з тіла (менеджер відредагував). Кожен: {name, price, quantity, sku}
			const rawItems = Array.isArray(b.items) ? b.items : [];
			const items = rawItems
				.map(function (it) {
					const name = String(it.name || "").trim();
					if (!name) return null;
					const quantity = Math.max(1, parseInt(it.quantity, 10) || 1);
					const unit_price = it.price != null ? Number(String(it.price).replace(",", ".")) : 0;
					return {
						name: name.slice(0, 255),
						sku: it.sku ? String(it.sku).slice(0, 120) : null,
						quantity,
						unit_price: isNaN(unit_price) ? 0 : unit_price,
						total: (isNaN(unit_price) ? 0 : unit_price) * quantity,
					};
				})
				.filter(Boolean);

			if (!items.length) return res.status(400).json({ ok: false, error: "Додайте хоча б один товар" });

			const client = {
				firstname: String(b.firstname || conv.contact_name || "").trim() || null,
				lastname: String(b.lastname || "").trim() || null,
				phone: String(b.phone || conv.phone || "").trim() || null,
				email: String(b.email || conv.email || "").trim() || null,
			};

			// Envelope за контрактом воркера. channel='contact-center' → внутрішнє (id_integration=NULL дозволено).
			const envelope = {
				source: { external_id: "cc_" + require("crypto").randomBytes(12).toString("hex"), channel: "contact-center" },
				client: client,
				items: items,
				note: String(b.note || "").slice(0, 999) || null,
				custom_fields: { cc_conversation: id },
				__can_create_clients: 1,
			};

			// Кладемо в чергу inbox (id_integration = NULL для внутрішніх)
			const [ins] = await connection_pool.query(
				`INSERT INTO ${P}orders_inbox (id_token, id_integration, external_id, payload, status, received_at)
                 VALUES (NULL, NULL, ?, ?, 'pending', NOW())`,
				[envelope.source.external_id, JSON.stringify(envelope)]
			);

			// Штовхаємо воркер
			try {
				const { kickWorker } = require("../orders/inboxProcessor");
				if (typeof kickWorker === "function") kickWorker();
			} catch (e) {
				console.error("kickWorker:", e.message);
			}

			res.status(200).json({ ok: true, inbox_id: ins.insertId });
		} catch (error) {
			console.error("createOrder:", error.message);
			logging.error(error);
			res.status(500).json({ ok: false, error: error.sqlMessage || "Помилка сервера" });
		}
	},

	editMessage: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		const msgId = parseInt(req.params.msgId, 10);
		const text = String((req.body && req.body.text) || "").trim();
		if (!id || !msgId) return res.status(400).json({ status: "error", message: "Невірний ID" });
		if (!text) return res.status(400).json({ status: "error", message: "Порожній текст" });
		if (text.length > 4000) return res.status(400).json({ status: "error", message: "Задовге" });

		try {
			// Тільки власник діалогу може редагувати
			const [convRows] = await connection_pool.query(`SELECT id_manager FROM ${T_CONVS} WHERE id = ? LIMIT 1`, [id]);
			if (!convRows.length) return res.status(404).json({ status: "error", message: "Діалог не знайдено" });
			if (Number(convRows[0].id_manager) !== Number(req.user.userId)) {
				return res.status(403).json({ status: "error", message: "Діалог веде інший менеджер" });
			}

			// Оновлюємо в CRM-схемі (з перевіркою власника повідомлення)
			const result = await model.editOutgoingMessage(msgId, req.user.userId, text);
			if (!result.ok) {
				const msg = result.error === "not_owner" ? "Можна редагувати лише свої повідомлення" : result.error === "not_editable" ? "Це повідомлення не можна редагувати" : "Повідомлення не знайдено";
				return res.status(400).json({ status: "error", message: msg });
			}

			// Дзеркалимо у веб-чат (якщо це веб-чат-повідомлення) → клієнт побачить зміну
			if (result.source_id) {
				const bridge = require("./webchat-bridge");
				bridge.editWebchatMessage(id, result.source_id, text).catch(function (e) {
					console.error("edit webchat mirror:", e.message);
				});
			}

			// Realtime іншим менеджерам у CRM
			try {
				const realtime = require("./realtime");
				if (typeof realtime.messageEdited === "function") realtime.messageEdited(id, msgId, text);
			} catch (e) {
				console.error("realtime edited:", e.message);
			}

			res.status(200).json({ status: "success" });
		} catch (error) {
			console.error("conversation edit:", error.message);
			logging.error(error);
			res.status(500).json({ status: "error", message: "Помилка сервера" });
		}
	},
};

module.exports = conversationsControllers;
