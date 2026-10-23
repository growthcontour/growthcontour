"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const quality = require("../../../controllers/catalog/products/quality");
const images = require("../../../controllers/catalog/products/images");

const L = "products.list";
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

router.get("/catalog/quality/", auth.isAuthenticated, (req, res) => {
	if (!can(req, L, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	res.render("pages/catalog/products/quality", {
		i18n: req,
		user: req.user,
		header: { navbar: "catalog", subnavbar: "products_quality" },
		perms: { edit: can(req, L, "edit"), settings: can(req, "products.settings", "edit") },
		rules: quality.RULES.map((r) => r.code),
	});
});

router.post("/api/catalog/products/quality/summary/", auth.isAuthenticated, need(L, "view"), handle(async () => ({ ok: true, ...(await quality.summary()) })));

router.post(
	"/api/catalog/products/quality/duplicates/",
	auth.isAuthenticated,
	need(L, "view"),
	handle(async (req) => {
		const b = req.body || {};
		const groups = await quality.duplicates(String(b.type || "ean"), langOf(req), b.limit);
		groups.forEach((g) => g.products.forEach((p) => (p.image_url = images.url("products", p.image, "small"))));
		return { ok: true, groups };
	})
);

router.post(
	"/api/catalog/products/quality/duplicates/ignore/",
	auth.isAuthenticated,
	need(L, "edit"),
	handle(async (req) => ({ ok: true, ...(await quality.ignore((req.body || {}).ids, req.user.userId || req.user.id)) }))
);

// Повний перерахунок (той самий, що вночі) — у фоні, відповідь одразу
router.post(
	"/api/catalog/products/quality/recalc/",
	auth.isAuthenticated,
	need("products.settings", "edit"),
	handle(async () => {
		quality.recalcAll().catch((e) => logging.error(e));
		return { ok: true };
	})
);

module.exports = router;