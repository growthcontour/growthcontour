const express = require("express");
const router = express.Router();

const authorizationControllers = require("../../controllers/authorization/authorization");
const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const audit = require("../../controllers/common/audit");

const P = config.get("configDatabase").prefix;
const canView = (req) => authorizationControllers.hasPermission(req, "system.audit", "view");

router.get("/audit/", authorizationControllers.isAuthenticated, async (req, res) => {
	if (!canView(req)) return res.status(403).send("Немає доступу.");
	try {
		const [users] = await connection_pool.query(`SELECT id, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM ${P}users ORDER BY name`);
		res.render("pages/audit/index", { i18n: req, user: req.user, header: { navbar: "users" }, users });
	} catch (e) {
		logging.error(e);
		res.status(500).send("Помилка сервера.");
	}
});

router.post("/api/audit/list/", authorizationControllers.isAuthenticated, async (req, res) => {
	if (!canView(req)) return res.status(403).json({ ok: false, error: "Немає доступу." });
	try {
		res.json(await audit.list(req.body || {}));
	} catch (e) {
		logging.error(e);
		res.status(500).json({ ok: false, error: "Помилка сервера." });
	}
});

module.exports = router;