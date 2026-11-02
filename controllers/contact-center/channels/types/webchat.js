const config = require("../../../../config/config");
const cryptoHelper = require("../../../../helpers/crypto");

const P = config.get("configDatabase").prefix;
const TABLE = P + "contact_center_channel_webchat";
const SITES = P + "web_chat_sites";

module.exports = {
	code: "webchat",
	label: "contact_center.channels.type_webchat",
	icon: "fa-solid fa-globe",
	color: "#16a34a",
	view: "./types/webchat",
	table: TABLE,

	// ── Створення каналу ──
	// site_id — ідентифікатор, який віджет передає в data-site-id.
	// Рядок у web_chat_sites створюється одразу: без нього /chat/config
	// відхилить домен і віджет не стартує.
	async create(conn, idChannel) {
		const siteId = "s_" + cryptoHelper.random(12);

		const defaultConfig = {
			version: 1,
			locales: { enabled: ["en"], primary: "en" },
			appearance: {
				position: "right",
				brandColor: "#16a34a",
				headerTitle: { en: "Chat with us" },
			},
			greeting: {
				enabled: true,
				autoOpen: false,
				autoOpenDelaySec: 0,
				desktop: { autoOpen: false, sound: true },
				mobile: { autoOpen: false, sound: false },
				working: { en: "Hi! How can we help you?" },
				offline: { en: "We are currently offline. Leave a message and we'll get back to you." },
				offlineAck: { en: "Thanks! We received your message and will reply during working hours." },
			},
			hours: {
				timezone: "Europe/Kyiv",
				force: "auto",
				schedule: { 1: [[9, 18]], 2: [[9, 18]], 3: [[9, 18]], 4: [[9, 18]], 5: [[9, 18]] },
				holidays: [],
			},
		};

		await conn.execute(`INSERT INTO ${SITES} (site_id, domains, active, config) VALUES (?, '', 0, CAST(? AS JSON))`, [siteId, JSON.stringify(defaultConfig)]);
		await conn.execute(`INSERT INTO ${TABLE} (id_channel, site_id) VALUES (?, ?)`, [idChannel, siteId]);
	},

	// ── Дані для сторінки налаштувань ──
	async load(conn, idChannel) {
		const [rows] = await conn.execute(
			`SELECT w.id, w.site_id,
                    s.domains, s.active AS site_active, s.config
             FROM ${TABLE} AS w
             LEFT JOIN ${SITES} AS s ON s.site_id = w.site_id
             WHERE w.id_channel = ? LIMIT 1`,
			[idChannel]
		);

		const r = rows[0] || {};

		// config — JSON з мовами, привітаннями, годинами, формами й тригерами.
		// Саме він є справжнім джерелом налаштувань віджета.
		let cfg = {};
		try {
			cfg = r.config ? (typeof r.config === "string" ? JSON.parse(r.config) : r.config) : {};
		} catch (e) {
			cfg = {};
		}

		return Object.assign({}, r, { config: cfg, has_token: true });
	},

	// ── Валідація ──
	validate(body) {
		const errors = [];

		const origins = String(body.allowed_origins || "").trim();
		if (!origins) {
			errors.push({ field: "allowed_origins", message: "Вкажіть хоча б один домен" });
		} else if (origins.length > 5000) {
			errors.push({ field: "allowed_origins", message: "Список доменів задовгий" });
		} else {
			const bad = origins
				.split(",")
				.map(function (d) {
					return d.trim();
				})
				.filter(function (d) {
					return d && !/^\*?\.?[a-z0-9.-]+\.[a-z]{2,}$/i.test(d);
				});

			if (bad.length) errors.push({ field: "allowed_origins", message: "Некоректний домен: " + bad[0] });
		}

		// Конфіг віджета валідує сам модуль веб-чату — там повний набір правил
		if (body.widget_config) {
			let cfg = null;

			try {
				cfg = typeof body.widget_config === "string" ? JSON.parse(body.widget_config) : body.widget_config;
			} catch (e) {
				errors.push({ field: "widget_config", message: "Конфіг не є коректним JSON" });
			}

			if (cfg) {
				const webchat = require("../../../../routes/contact-center/web-chat/web-chat");

				if (typeof webchat.validateConfig === "function") {
					const result = webchat.validateConfig(cfg);

					if (!result.ok) {
						result.errors.slice(0, 8).forEach(function (e) {
							errors.push({ field: "widget_config", message: e.path + ": " + e.message });
						});
					}
				}
			}
		}

		return { valid: errors.length === 0, errors: errors };
	},

	// ── Збереження ──
	async save(conn, idChannel, body) {
		const origins = String(body.allowed_origins || "")
			.split(",")
			.map(function (d) {
				return d.trim().toLowerCase();
			})
			.filter(Boolean)
			.join(",");

		// web_chat_sites.active керує тим, чи віджет узагалі відповідає
		const active = origins && body.status ? 1 : 0;

		await conn.execute(
			`UPDATE ${SITES} AS s
                INNER JOIN ${TABLE} AS w ON w.site_id = s.site_id
                SET s.domains = ?, s.active = ?
              WHERE w.id_channel = ?`,
			[origins, active, idChannel]
		);

		if (body.widget_config) {
			const json = typeof body.widget_config === "string" ? body.widget_config : JSON.stringify(body.widget_config);

			await conn.execute(
				`UPDATE ${SITES} AS s
                    INNER JOIN ${TABLE} AS w ON w.site_id = s.site_id
                    SET s.config = CAST(? AS JSON)
                  WHERE w.id_channel = ?`,
				[json, idChannel]
			);

			// Скидаємо 60-секундний кеш конфігу, інакше зміни підхопляться із затримкою
			const [siteRows] = await conn.execute(`SELECT site_id FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);

			if (siteRows.length) {
				const webchat = require("../../../../routes/contact-center/web-chat/web-chat");
				if (typeof webchat.bustWidgetCfg === "function") webchat.bustWidgetCfg(siteRows[0].site_id);
			}
		}

		return { configured: !!origins, reload: false };
	},

	// ── Перевірка підключення ──
	async test(conn, idChannel) {
		const [rows] = await conn.execute(
			`SELECT w.site_id, s.domains, s.active
               FROM ${TABLE} AS w
               LEFT JOIN ${SITES} AS s ON s.site_id = w.site_id
              WHERE w.id_channel = ? LIMIT 1`,
			[idChannel]
		);

		const r = rows[0];
		if (!r || !r.site_id) return { ok: false, error: "site_id не згенеровано" };
		if (r.domains === null) return { ok: false, error: "Сайт віджета не знайдено в web_chat_sites" };
		if (!r.domains) return { ok: false, error: "Не вказано жодного дозволеного домену" };

		return { ok: true };
	},

	// ── Відправка повідомлення ──
	// Веб-чат не має зовнішнього API — доставка через socket namespace /webchat.
	// target тут дорівнює roomId ("<site_id>_<visitor_id>").
	async send(conn, idChannel, target, message) {
		const [rows] = await conn.execute(`SELECT site_id FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);

		const siteId = rows.length ? rows[0].site_id : null;
		if (!siteId) return { ok: false, error: "site_id каналу не задано" };

		// require усередині: модуль веб-чату тягне цей файл через реєстр каналів,
		// тому на верхньому рівні вийшла б циклічна залежність
		const webchat = require("../../../../routes/contact-center/web-chat/web-chat");

		if (typeof webchat.sendFromCrm !== "function") {
			return { ok: false, error: "Модуль веб-чату не підтримує відправку" };
		}

		const result = await webchat.sendFromCrm(siteId, target, message.text, message.id_manager);

		return result.ok ? { ok: true, source_id: "wc_" + result.id } : { ok: false, error: result.error };
	},

	// ── Прочитання менеджером ──
	// Прокидаємо у стару схему, щоб клієнт побачив другу галочку
	async onRead(conn, idChannel, target, idManager) {
		const [rows] = await conn.execute(`SELECT site_id FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);

		const siteId = rows.length ? rows[0].site_id : null;
		if (!siteId) return;

		const webchat = require("../../../../routes/contact-center/web-chat/web-chat");
		if (typeof webchat.markReadFromCrm !== "function") return;

		await webchat.markReadFromCrm(siteId, target, idManager);
	},

	// ── Ідентифікатор у списку каналів ──
	identitySql(alias) {
		return `COALESCE(${alias}.site_id, '')`;
	},
};
