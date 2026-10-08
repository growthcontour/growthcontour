const connection_pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const logging = require("../../../logging/logging");
const types = require("./index");
const ccNotifications = require("../notifications");
const ccNotify = require("./notify");

const P = config.get("configDatabase").prefix;
const TABLE = P + "contact_center_channels";

const channelsControllers = {
	// ── Сторінка списку ──
	page: (req, res) => {
		res.render("pages/contact-center/channels/index", {
			i18n: res,
			user: req.user,
			data: { types: types.meta() },
			header: { navbar: "contact-center" },
		});
	},

	// ── Дані для Tabulator ──
	// Ідентифікатор кожного типу тягнеться LEFT JOIN-ом по його таблиці.
	// Запит будується з реєстру — новий тип не вимагає правки цього коду.
	list: async (req, res) => {
		try {
			const joins = [];
			const cases = [];

			types.all().forEach(function (t, i) {
				const alias = "t" + i;
				joins.push(`LEFT JOIN ${t.table} AS ${alias} ON ${alias}.id_channel = c.id`);
				cases.push(`WHEN '${t.code}' THEN ${t.identitySql(alias)}`);
			});

			const [rows] = await connection_pool.query(
				`SELECT c.id, c.type, c.name, c.status, c.is_configured,
                        c.connection_status, c.connection_error, c.date_checked, c.date_add,
                        CASE c.type ${cases.join(" ")} ELSE '' END AS identity
                 FROM ${TABLE} AS c
                 ${joins.join("\n                 ")}
                 WHERE c.deleted = 0
                 ORDER BY c.sort_order ASC, c.id DESC`
			);

			res.status(200).json(rows);
		} catch (error) {
			console.error("channels list:", error.message);
			logging.error(error);
			res.status(500).json([]);
		}
	},

	// ── Створення з модалки ──
	create: async (req, res) => {
		const b = req.body || {};
		const type = String(b.type || "").trim();

		const typeDef = types.get(type);
		if (!typeDef) return res.status(400).json({ status: "error", errors: [{ field: "type", message: "Оберіть тип каналу" }] });

		// Назву задають уже на сторінці каналу — тут ставимо дефолтну (назва типу).
		const defaultName = res.__ ? res.__(typeDef.label) : typeDef.code;
		const name = String(b.name || "").trim() || defaultName;

		const conn = await connection_pool.getConnection();
		try {
			await conn.beginTransaction();

			const [r] = await conn.execute(`INSERT INTO ${TABLE} (type, name, id_user) VALUES (?, ?, ?)`, [type, name, req.user.userId]);

			// канал і його налаштування створюються атомарно
			await types.get(type).create(conn, r.insertId);

			await conn.commit();
			res.status(200).json({ status: "success", id: r.insertId });
		} catch (error) {
			await conn.rollback();
			console.error("channels create:", error.message);
			logging.error(error);
			res.status(500).json({ status: "error", errors: [{ message: "Помилка сервера" }] });
		} finally {
			conn.release();
		}
	},

	// ── Перемикач активності зі списку ──
	// Увімкнути можна лише налаштований канал — перевірка в самому UPDATE.
	status: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		const status = req.body && req.body.status ? 1 : 0;
		if (!id) return res.status(400).json({ status: "error", message: "Невірний ID" });

		try {
			const [r] = await connection_pool.execute(`UPDATE ${TABLE} SET status = ?, id_user_edited = ? WHERE id = ? AND deleted = 0 AND (? = 0 OR is_configured = 1)`, [status, req.user.userId, id, status]);

			if (r.affectedRows === 0) {
				return res.status(400).json({ status: "error", message: "Канал не налаштовано" });
			}

			// Веб-чат: вимкнений канал → віджет замовкає
			try {
				const [tr] = await connection_pool.query(`SELECT type FROM ${TABLE} WHERE id = ? LIMIT 1`, [id]);
				if (tr.length && tr[0].type === "webchat") {
					await require("../../../routes/contact-center/web-chat/web-chat").setSiteActiveByChannel(id, status);
				}
			} catch (e) {
				console.error("wc sync status:", e.message);
			}

			res.status(200).json({ status: "success" });
		} catch (error) {
			console.error("channels status:", error.message);
			logging.error(error);
			res.status(500).json({ status: "error" });
		}
	},

	// ── Сторінка редагування ──
	edit: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.redirect("/contact-center/channels/");

		const conn = await connection_pool.getConnection();
		try {
			const [rows] = await conn.execute(`SELECT * FROM ${TABLE} WHERE id = ? AND deleted = 0 LIMIT 1`, [id]);
			if (!rows.length) return res.redirect("/contact-center/channels/");

			const channel = rows[0];
			const type = types.get(channel.type);
			if (!type) return res.redirect("/contact-center/channels/");

			const settings = await type.load(conn, id);
			const recipients = await ccNotifications.list(id, req.user && req.user.id_lang);
			const notify = await ccNotify.load(conn, id);

			res.render("pages/contact-center/channels/edit", {
				i18n: res,
				user: req.user,
				data: {
					channel: channel,
					settings: settings,
					meta: { code: type.code, label: type.label, icon: type.icon, color: type.color },
					typeView: type.view,
					recipients: recipients,
					appUrl: config.get("configServer").url,
					notify: notify,
				},
				header: { navbar: "contact-center" },
			});
		} catch (error) {
			console.error("channels edit:", error.message);
			logging.error(error);
			res.status(500).send("Internal Server Error");
		} finally {
			conn.release();
		}
	},

	// ── Збереження ──
	update: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ status: "error", errors: [{ message: "Невірний ID" }] });

		const conn = await connection_pool.getConnection();
		try {
			const [rows] = await conn.execute(`SELECT id, type FROM ${TABLE} WHERE id = ? AND deleted = 0 LIMIT 1`, [id]);
			if (!rows.length) return res.status(404).json({ status: "error", errors: [{ message: "Канал не знайдено" }] });

			const type = types.get(rows[0].type);
			if (!type) return res.status(400).json({ status: "error", errors: [{ message: "Невідомий тип каналу" }] });

			const b = req.body || {};
			const errors = [];

			// Спільна валідація назви
			const name = String(b.name || "").trim();
			if (!name) errors.push({ field: "name", message: "Вкажіть назву каналу" });
			else if (name.length > 255) errors.push({ field: "name", message: "Назва задовга (макс. 255)" });
			else {
				const [dup] = await conn.execute(`SELECT id FROM ${TABLE} WHERE deleted = 0 AND id <> ? AND LOWER(TRIM(name)) = LOWER(?) LIMIT 1`, [id, name]);
				if (dup.length) errors.push({ field: "name", message: "Канал з такою назвою вже існує" });
			}

			// Спільна перевірка widget_config:
			//   • якщо переданий — має бути plain-object (не масив, не рядок, не число);
			//   • розмір у межах, щоб не вилетіти на max_allowed_packet.
			// Глибока перевірка вмісту (appearance.extraButtons.items[], svg тощо)
			// живе у type.validate() — там є і b, і current, і специфіка типу.
			if (b.widget_config !== undefined && b.widget_config !== null) {
				if (typeof b.widget_config !== "object" || Array.isArray(b.widget_config)) {
					errors.push({ field: "widget_config", message: "Некоректний формат конфігу віджета" });
				} else {
					const size = Buffer.byteLength(JSON.stringify(b.widget_config), "utf8");
					if (size > 256 * 1024) {
						errors.push({ field: "widget_config", message: "Конфіг віджета завеликий (макс. 256 КБ)" });
					}
				}
			}

			// Валідація типової частини — всередині типу
			const current = await type.load(conn, id);
			const typeCheck = type.validate(b, current);
			if (!typeCheck.valid) errors.push.apply(errors, typeCheck.errors);

			const currentNotify = await ccNotify.load(conn, id);
			const notifyCheck = ccNotify.validate(b.notify, currentNotify);
			if (!notifyCheck.valid) errors.push.apply(errors, notifyCheck.errors);

			if (errors.length) return res.status(400).json({ status: "error", errors: errors });

			await conn.beginTransaction();

			const result = await type.save(conn, id, b, current);

			// Отримувачі сповіщень — спільні для всіх типів каналів
			await ccNotifications.save(conn, id, b.recipients);
			await ccNotify.save(conn, id, b.notify);
			const configured = result.configured ? 1 : 0;

			// Увімкнути можна лише налаштований канал.
			// Якщо канал перестав бути налаштованим — вимикаємо і скидаємо стан перевірки.
			await conn.execute(
				`UPDATE ${TABLE}
             SET name = ?,
                 status = IF(? = 1, ?, 0),
                 is_configured = ?,
                 connection_status = IF(? = 1, connection_status, 'unknown'),
                 connection_error = IF(? = 1, connection_error, NULL),
                 id_user_edited = ?
             WHERE id = ?`,
				[name, configured, b.status ? 1 : 0, configured, configured, configured, req.user.userId, id]
			);

			await conn.commit();

			// Веб-чат: синхронізуємо активність сайту з фінальним статусом каналу
			if (rows[0].type === "webchat") {
				const finalActive = configured && b.status ? 1 : 0;
				try {
					await require("../../../routes/contact-center/web-chat/web-chat").setSiteActiveByChannel(id, finalActive);
				} catch (e) {
					console.error("wc sync update:", e.message);
				}
			}

			res.status(200).json({ status: "success", reload: !!result.reload });
		} catch (error) {
			await conn.rollback();
			console.error("channels update:", error.message);
			logging.error(error);
			res.status(500).json({ status: "error", errors: [{ message: "Помилка сервера" }] });
		} finally {
			conn.release();
		}
	},

	// Ручне оновлення Instagram-токена (кнопка у формі каналу)
	async refresh(req, res) {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ status: "error", message: "Невірний ID" });

		try {
			// Тип каналу — оновлення підтримує лише instagram
			const connection_pool = require("../../../config/database/connection_pool");
			const config = require("../../../config/config");
			const P = config.get("configDatabase").prefix;

			const [rows] = await connection_pool.query(`SELECT type FROM ${P}contact_center_channels WHERE id = ? AND deleted = 0 LIMIT 1`, [id]);

			if (!rows.length) return res.status(404).json({ status: "error", message: "Канал не знайдено" });
			if (rows[0].type !== "instagram") {
				return res.status(400).json({ status: "error", message: "Оновлення токена підтримує лише Instagram" });
			}

			const igRefresh = require("../instagram-refresh");
			const result = await igRefresh.refreshOne(id);

			if (result.ok) {
				const days = Math.round((result.expires_in || 0) / 86400);
				return res.status(200).json({ status: "success", message: "Токен оновлено. Дійсний ще ~" + days + " днів." });
			}

			return res.status(200).json({ status: "error", message: result.error || "Не вдалося оновити токен" });
		} catch (error) {
			console.error("channel refresh:", error.message);
			return res.status(500).json({ status: "error", message: "Помилка сервера" });
		}
	},

	notifyTestTelegram: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ ok: false, error: "Невірний ID" });
		const conn = await connection_pool.getConnection();
		try {
			const result = await ccNotify.testTelegram(conn, id, req.body || {});
			return res.status(200).json(result);
		} catch (e) {
			logging.error(e);
			return res.status(500).json({ ok: false, error: "Помилка сервера" });
		} finally {
			conn.release();
		}
	},

	// ── Web Push: віддати публічний VAPID-ключ ──
	pushVapidKey: (req, res) => {
		const wp = require("../../../helpers/webpush");
		if (!wp.ready) return res.status(500).json({ ok: false, error: "VAPID не налаштовано на сервері" });
		return res.status(200).json({ ok: true, key: wp.publicKey });
	},

	// ── Web Push: зберегти підписку поточного браузера (привʼязка до менеджера) ──
	pushSubscribe: async (req, res) => {
		const b = req.body || {};
		const sub = b.subscription || b;
		if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
			return res.status(400).json({ ok: false, error: "Невірна підписка" });
		}
		try {
			await connection_pool.query(
				`INSERT INTO ${P}manager_push_subs (id_manager, endpoint, p256dh, auth, user_agent, date_add, date_last_ok)
                 VALUES (?,?,?,?,?, NOW(), NOW())
                 ON DUPLICATE KEY UPDATE id_manager=VALUES(id_manager), p256dh=VALUES(p256dh),
                    auth=VALUES(auth), user_agent=VALUES(user_agent), date_last_ok=NOW()`,
				[req.user.userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(req.headers["user-agent"] || "").slice(0, 255)]
			);
			return res.status(200).json({ ok: true });
		} catch (e) {
			logging.error(e);
			return res.status(500).json({ ok: false, error: "Помилка сервера" });
		}
	},

	// ── Web Push: видалити підписку ──
	pushUnsubscribe: async (req, res) => {
		const endpoint = (req.body && req.body.endpoint) || "";
		if (!endpoint) return res.status(400).json({ ok: false, error: "endpoint обовʼязковий" });
		try {
			await connection_pool.query(`DELETE FROM ${P}manager_push_subs WHERE endpoint = ? AND id_manager = ?`, [endpoint, req.user.userId]);
			return res.status(200).json({ ok: true });
		} catch (e) {
			logging.error(e);
			return res.status(500).json({ ok: false, error: "Помилка сервера" });
		}
	},

	// ── М'яке видалення ──
	remove: async (req, res) => {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ status: "error", message: "Невірний ID" });

		try {
			const [r] = await connection_pool.execute(`UPDATE ${TABLE} SET deleted = 1, status = 0, date_deleted = NOW(), id_user_deleted = ? WHERE id = ? AND deleted = 0`, [req.user.userId, id]);

			if (r.affectedRows === 0) return res.status(404).json({ status: "error", message: "Канал не знайдено" });

			try {
				const [tr] = await connection_pool.query(`SELECT type FROM ${TABLE} WHERE id = ? LIMIT 1`, [id]);
				if (tr.length && tr[0].type === "webchat") {
					await require("../../../routes/contact-center/web-chat/web-chat").setSiteActiveByChannel(id, 0);
				}
			} catch (e) {
				console.error("wc sync remove:", e.message);
			}

			res.status(200).json({ status: "success" });
		} catch (error) {
			console.error("channels delete:", error.message);
			logging.error(error);
			res.status(500).json({ status: "error" });
		}
	},
};

module.exports = channelsControllers;
