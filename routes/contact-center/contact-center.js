const express = require("express");
const router = express.Router();

// Controllers
const authorizationControllers = require("../../controllers/authorization/authorization");
const conversationsControllers = require("../../controllers/contact-center/conversations");
const ccUpload = require("../../controllers/contact-center/upload");
// END Controllers

//Database connection
const connection = require("../../config/database/database");
const connection_pool = require("../../config/database/connection_pool");
//END Database connection

// Configuration
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
// END Configuration

// Логування
const logging = require("../../logging/logging");
// END Логування

router.get("/contact-center/", authorizationControllers.isAuthenticated, (req, res) => {
	res.render("pages/contact-center/contact-center/index", {
		i18n: res,
		user: req.user,
		header: {
			navbar: "contact-center",
		},
	});
});

router.get("/contact-center/settings/", authorizationControllers.isAuthenticated, (req, res) => {
	res.render("pages/contact-center/contact-center/settings", {
		i18n: res,
		user: req.user,
		header: {
			navbar: "contact-center",
		},
	});
});

// POST
router.post("/api/contact-center/get-list-chats/", authorizationControllers.isAuthenticated, conversationsControllers.list);
router.post("/api/contact-center/get-counters/", authorizationControllers.isAuthenticated, conversationsControllers.counters);

// Діалог
router.get("/contact-center/chat/:token/", authorizationControllers.isAuthenticated, conversationsControllers.page);
router.post("/api/contact-center/chat/:id/messages/", authorizationControllers.isAuthenticated, conversationsControllers.messages);
router.post("/api/contact-center/chat/:id/media/", authorizationControllers.isAuthenticated, conversationsControllers.media);
router.post("/api/contact-center/chat/:id/products/", authorizationControllers.isAuthenticated, conversationsControllers.products);
router.post("/api/contact-center/chat/:id/send/", authorizationControllers.isAuthenticated, conversationsControllers.send);
router.post("/api/contact-center/chat/:id/read/", authorizationControllers.isAuthenticated, conversationsControllers.read);
router.post("/api/contact-center/chat/:id/upload/", authorizationControllers.isAuthenticated, ccUpload.single("file"), conversationsControllers.upload);
router.post("/api/contact-center/chat/:id/command/", authorizationControllers.isAuthenticated, conversationsControllers.command);
router.post("/api/contact-center/chat/:id/assign/", authorizationControllers.isAuthenticated, conversationsControllers.assign);
router.post("/api/contact-center/chat/:id/status/", authorizationControllers.isAuthenticated, conversationsControllers.status);
router.post("/api/contact-center/chat/:id/delete/", authorizationControllers.isAuthenticated, conversationsControllers.delete);
router.post("/api/contact-center/chat/:id/online/", authorizationControllers.isAuthenticated, conversationsControllers.online);
router.post("/api/contact-center/online-list/", authorizationControllers.isAuthenticated, conversationsControllers.onlineList);
router.post("/api/contact-center/chat/:id/visitor-info/", authorizationControllers.isAuthenticated, conversationsControllers.visitorInfo);

// END POST

// ── Веб-чат: сторінка діалогу (по непрозорому url_token) ──
router.get("/contact-center/webchat/:token/", authorizationControllers.isAuthenticated, async (req, res) => {
	const token = String(req.params.token || "");
	// токен — рівно 32 hex; інші формати одразу відкидаємо
	if (!/^[a-f0-9]{32}$/.test(token)) return res.redirect("/contact-center/");
	try {
		const [rows] = await connection_pool.query(`SELECT site_id, room_id FROM ${configDatabase.prefix}web_chat_conversations WHERE url_token = ? LIMIT 1`, [token]);
		if (!rows.length) return res.redirect("/contact-center/");

		res.render("pages/contact-center/contact-center/webchat/dialog", {
			i18n: res,
			user: req.user,
			data: {
				roomId: rows[0].room_id,
				siteId: rows[0].site_id,
			},
			header: { navbar: "contact-center" },
		});
	} catch (error) {
		logging.error(error);
		res.status(500).send("Internal Server Error");
	}
});

// ── Веб-чат: сторінка редагування сайту ──
router.get("/contact-center/webchat/settings/:siteId/", authorizationControllers.isAuthenticated, async (req, res) => {
	const P = configDatabase.prefix;
	const siteId = req.params.siteId;
	try {
		const [rows] = await connection_pool.query(
			`SELECT site_id, domains, active, product_card_enabled, lead_timeout_sec,
                    offline_lead_enabled, offline_lead_delay_sec, brand_color, config
             FROM ${P}web_chat_sites WHERE site_id = ? LIMIT 1`,
			[siteId]
		);
		if (!rows.length) return res.redirect("/contact-center/webchat/settings/");

		const site = rows[0];
		if (site.config && typeof site.config === "object") site.config = JSON.stringify(site.config);

		res.render("pages/contact-center/contact-center/webchat/settings-edit", {
			i18n: res,
			user: req.user,
			data: { site },
			header: { navbar: "contact-center" },
		});
	} catch (error) {
		console.error("webchat settings edit page:", error.message);
		logging.error(error);
		res.status(500).send("Internal Server Error");
	}
});

// ── Веб-чат: список сайтів для таблиці налаштувань ──
router.post("/api/contact-center/webchat/settings/list/", authorizationControllers.isAuthenticated, async (req, res) => {
	const P = configDatabase.prefix;
	try {
		const [rows] = await connection_pool.query(
			`SELECT site_id, domains, active, product_card_enabled,
                    lead_timeout_sec, offline_lead_enabled, offline_lead_delay_sec, brand_color, config
             FROM ${P}web_chat_sites
             ORDER BY site_id ASC`
		);
		// config → рядок JSON, щоб Tabulator не намагався рендерити обʼєкт
		rows.forEach((r) => {
			if (r.config && typeof r.config === "object") r.config = JSON.stringify(r.config);
		});
		res.send(rows);
	} catch (error) {
		console.error("webchat settings list:", error.message);
		logging.error(error);
		res.status(500).send([]);
	}
});

// ── Веб-чат: додати сайт ──
router.post("/api/contact-center/webchat/settings/insert/", authorizationControllers.isAuthenticated, async (req, res) => {
	const P = configDatabase.prefix;
	const b = req.body || {};

	const siteId = String(b.site_id || "").trim();
	if (!siteId || siteId.length > 190) return res.status(400).json({ error: "Невірний Site ID" });

	const domains = String(b.domains || "")
		.trim()
		.slice(0, 5000);
	const brandColor = /^#[0-9a-fA-F]{6}$/.test(b.brand_color) ? b.brand_color : "#007fff";
	const leadTimeout = Math.max(0, parseInt(b.lead_timeout_sec, 10) || 0);
	const offlineDelay = Math.max(0, parseInt(b.offline_lead_delay_sec, 10) || 0);
	const active = b.active ? 1 : 0;
	const productCard = b.product_card_enabled ? 1 : 0;
	const offlineLead = b.offline_lead_enabled ? 1 : 0;

	// config: приймаємо рядок JSON, валідуємо
	let configStr = null;
	if (b.config != null && String(b.config).trim() !== "") {
		try {
			const parsed = typeof b.config === "string" ? JSON.parse(b.config) : b.config;
			configStr = JSON.stringify(parsed);
		} catch (e) {
			return res.status(400).json({ error: "Невалідний JSON у config" });
		}
	}

	try {
		const [result] = await connection_pool.query(
			`UPDATE ${P}web_chat_sites SET
                domains = ?, active = ?, product_card_enabled = ?, lead_timeout_sec = ?,
                offline_lead_enabled = ?, offline_lead_delay_sec = ?, brand_color = ?,
                config = COALESCE(CAST(? AS JSON), config)
             WHERE site_id = ?`,
			[domains, active, productCard, leadTimeout, offlineLead, offlineDelay, brandColor, configStr, siteId]
		);
		res.status(200).json({ success: true });
	} catch (error) {
		console.error("webchat settings insert:", error.message);
		logging.error(error);
		res.status(500).json({ error: "Помилка сервера" });
	}
});

// ── Веб-чат: оновити сайт ──
router.post("/api/contact-center/webchat/settings/update/", authorizationControllers.isAuthenticated, async (req, res) => {
	const P = configDatabase.prefix;
	const b = req.body || {};

	const siteId = String(b.site_id || "").trim();
	if (!siteId) return res.status(400).json({ error: "Невірний Site ID" });

	const domains = String(b.domains || "")
		.trim()
		.slice(0, 5000);
	const brandColor = /^#[0-9a-fA-F]{6}$/.test(b.brand_color) ? b.brand_color : "#007fff";
	const leadTimeout = Math.max(0, parseInt(b.lead_timeout_sec, 10) || 0);
	const offlineDelay = Math.max(0, parseInt(b.offline_lead_delay_sec, 10) || 0);
	const active = b.active ? 1 : 0;
	const productCard = b.product_card_enabled ? 1 : 0;
	const offlineLead = b.offline_lead_enabled ? 1 : 0;

	// config: приймаємо рядок JSON, валідуємо
	let configStr = null;
	if (b.config != null && String(b.config).trim() !== "") {
		try {
			const parsed = typeof b.config === "string" ? JSON.parse(b.config) : b.config;
			configStr = JSON.stringify(parsed);
		} catch (e) {
			return res.status(400).json({ error: "Невалідний JSON у config" });
		}
	}

	try {
		const [result] = await connection_pool.query(
			`UPDATE ${P}web_chat_sites SET
                domains = ?, active = ?, product_card_enabled = ?, lead_timeout_sec = ?,
                offline_lead_enabled = ?, offline_lead_delay_sec = ?, brand_color = ?,
                config = COALESCE(CAST(? AS JSON), config)
             WHERE site_id = ?`,
			[domains, active, productCard, leadTimeout, offlineLead, offlineDelay, brandColor, configStr, siteId]
		);
		if (result.affectedRows === 0) return res.status(404).json({ error: "Сайт не знайдено" });
		res.status(200).json({ success: true });
	} catch (error) {
		console.error("webchat settings update:", error.message);
		logging.error(error);
		res.status(500).json({ error: "Помилка сервера" });
	}
});

// ── Веб-чат: деактивувати сайт (м'яко) ──
router.post("/api/contact-center/webchat/settings/deactivate/", authorizationControllers.isAuthenticated, async (req, res) => {
	const P = configDatabase.prefix;
	const siteId = String((req.body && req.body.site_id) || "").trim();
	if (!siteId) return res.status(400).json({ error: "site_id обов'язковий" });
	try {
		const [r] = await connection_pool.query(`UPDATE ${P}web_chat_sites SET active = 0 WHERE site_id = ?`, [siteId]);
		if (r.affectedRows === 0) return res.status(404).json({ error: "Сайт не знайдено" });
		res.status(200).json({ success: true });
	} catch (e) {
		console.error("webchat deactivate:", e.message);
		logging.error(e);
		res.status(500).json({ error: "Помилка сервера" });
	}
});

// ── Веб-чат: повне каскадне видалення сайту ──
router.post("/api/contact-center/webchat/settings/delete/", authorizationControllers.isAuthenticated, async (req, res) => {
	const P = configDatabase.prefix;
	const siteId = String((req.body && req.body.site_id) || "").trim();
	const confirm = String((req.body && req.body.confirm) || "").trim();
	if (!siteId) return res.status(400).json({ error: "site_id обов'язковий" });
	if (confirm !== siteId) return res.status(400).json({ error: "Підтвердження не збігається" });

	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		// усі кімнати цього сайту (для чищення нотифікацій по room_id)
		const [rooms] = await conn.query(`SELECT room_id FROM ${P}web_chat_conversations WHERE site_id = ?`, [siteId]);

		// повʼязані таблиці з колонкою site_id
		const tablesBySite = ["web_chat_conversations", "web_chat_messages", "web_chat_leads", "web_chat_visitor_meta", "web_chat_visitor_products", "web_chat_operator_reads", "web_chat_client_reads", "web_chat_sessions"];

		for (const t of tablesBySite) {
			await conn.query(`DELETE FROM ${P}${t} WHERE site_id = ?`, [siteId]).catch(function () {});
		}

		// нотифікації веб-чату цього сайту (type=3) + їх reads
		if (rooms.length) {
			const roomIds = rooms.map(function (r) {
				return r.room_id;
			});
			const ph = roomIds
				.map(function () {
					return "?";
				})
				.join(",");
			await conn
				.query(
					`DELETE r FROM ${P}notification_reads AS r
                 INNER JOIN ${P}notifications AS n ON n.id = r.notification_id
                 WHERE n.type = 3 AND JSON_UNQUOTE(JSON_EXTRACT(n.data,'$.site_id')) = ?`,
					[siteId]
				)
				.catch(function () {});
			await conn
				.query(
					`DELETE FROM ${P}notifications
                 WHERE type = 3 AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.site_id')) = ?`,
					[siteId]
				)
				.catch(function () {});
		}

		// сам сайт
		await conn.query(`DELETE FROM ${P}web_chat_sites WHERE site_id = ?`, [siteId]);

		await conn.commit();
		res.status(200).json({ success: true });
	} catch (e) {
		await conn.rollback();
		console.error("webchat delete:", e.message);
		logging.error(e);
		res.status(500).json({ error: "Помилка сервера при видаленні" });
	} finally {
		conn.release();
	}
});

// ── Веб-чат: активувати сайт ──
router.post("/api/contact-center/webchat/settings/activate/", authorizationControllers.isAuthenticated, async (req, res) => {
	const P = configDatabase.prefix;
	const siteId = String((req.body && req.body.site_id) || "").trim();
	if (!siteId) return res.status(400).json({ error: "site_id обов'язковий" });
	try {
		const [r] = await connection_pool.query(`UPDATE ${P}web_chat_sites SET active = 1 WHERE site_id = ?`, [siteId]);
		if (r.affectedRows === 0) return res.status(404).json({ error: "Сайт не знайдено" });
		res.status(200).json({ success: true });
	} catch (e) {
		console.error("webchat activate:", e.message);
		logging.error(e);
		res.status(500).json({ error: "Помилка сервера" });
	}
});

module.exports = router;
