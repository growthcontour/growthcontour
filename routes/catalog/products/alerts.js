"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const alerts = require("../../../controllers/catalog/products/alerts");

const S = "products.settings";
const can = (req, slug, action) => auth.hasPermission(req, slug, action);
const need = (slug, action) => (req, res, next) => (can(req, slug, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error"), errors: e.errors });
	}
};
const langOf = (req) => req.user.id_lang || 1;

router.get("/catalog/settings/alerts/", auth.isAuthenticated, (req, res) => {
	if (!can(req, S, "view") && !can(req, "products.stock", "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	res.render("pages/catalog/products/alerts", {
		i18n: req,
		user: req.user,
		header: { navbar: "catalog", subnavbar: "products_alerts" },
		perms: { settings: can(req, S, "view"), edit: can(req, S, "edit") },
		events: alerts.EVENTS,
	});
});

router.post("/api/catalog/products/alerts/recipients/", auth.isAuthenticated, need(S, "view"), handle(async (req) => ({ ok: true, rows: await alerts.getRecipients(langOf(req)) })));

router.post(
	"/api/catalog/products/alerts/recipients/save/",
	auth.isAuthenticated,
	need(S, "edit"),
	handle(async (req) => {
		await alerts.saveRecipients(req.body);
		audit.log(req, { action: "settings_save", module: "products", entity: "alerts", count: 1 });
		return { ok: true };
	})
);

router.post(
	"/api/catalog/products/alerts/low-stock/",
	auth.isAuthenticated,
	(req, res, next) => (can(req, S, "view") || can(req, "products.stock", "view") ? next() : res.status(403).json({ ok: false })),
	handle(async (req) => ({ ok: true, rows: await alerts.currentStock(langOf(req)) }))
);

// Ручний прогін сканерів (той самий, що в cron) — для перевірки налаштувань
router.post(
	"/api/catalog/products/alerts/run/",
	auth.isAuthenticated,
	need(S, "edit"),
	handle(async () => ({ ok: true, result: await alerts.runAll() }))
);

module.exports = router;
