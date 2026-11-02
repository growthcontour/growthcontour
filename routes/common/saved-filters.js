const express = require("express");
const router = express.Router();

const authorizationControllers = require("../../controllers/authorization/authorization");
const logging = require("../../logging/logging");
const savedFilters = require("../../controllers/common/savedFilters");

// Сторінки, де доступні збережені фільтри
const PAGES = ["clients", "orders", "leads"];

const handle = (fn) => async (req, res) => {
	try {
		if (!PAGES.includes(req.params.page)) return res.status(404).json({ ok: false, error: "Невідома сторінка." });
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Помилка сервера." });
	}
};
const userOf = (req) => req.user.userId || req.user.id;
const isAdmin = (req) => authorizationControllers.hasPermission(req, "users.list", "edit");

router.post("/api/saved-filters/:page/", authorizationControllers.isAuthenticated, handle((req) => savedFilters.list(req.params.page, userOf(req))));
router.post("/api/saved-filters/:page/save/", authorizationControllers.isAuthenticated, handle((req) => savedFilters.save(req.params.page, userOf(req), req.body || {})));
router.post("/api/saved-filters/:page/delete/", authorizationControllers.isAuthenticated, handle((req) => savedFilters.remove(req.params.page, userOf(req), parseInt((req.body || {}).id, 10), isAdmin(req))));

module.exports = router;