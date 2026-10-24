"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const reviews = require("../../../controllers/catalog/products/reviews");

const P = config.get("configDatabase").prefix;
const L = "products.list";

const can = (req, action) => auth.hasPermission(req, L, action);
const need = (action) => (req, res, next) => (can(req, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const id = (v) => {
	const n = parseInt(v, 10);
	if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error("Invalid id"), { status: 400 });
	return n;
};
const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error"), errors: e.errors });
	}
};
const userId = (req) => req.user.userId || req.user.id;
const langOf = (req) => req.user.id_lang || 1;

router.get("/catalog/reviews/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	try {
		const [integrations] = await pool.query(`SELECT id, name FROM ${P}settings_integrations ORDER BY name`);
		res.render("pages/catalog/products/reviews", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_reviews" },
			perms: { add: can(req, "add"), edit: can(req, "edit"), delete: can(req, "delete") },
			integrations,
			productFilter: /^\d+$/.test(String(req.query.product || "")) ? Number(req.query.product) : null,
		});
	} catch (e) {
		next(e);
	}
});

router.post("/api/catalog/products/reviews/list/", auth.isAuthenticated, need("view"), handle(async (req) => reviews.list(req.body || {}, langOf(req))));

router.post("/api/catalog/products/reviews/:id/get/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, row: await reviews.get(id(req.params.id)) })));

router.post(
	"/api/catalog/products/reviews/save/",
	auth.isAuthenticated,
	(req, res, next) => need(req.body && req.body.id ? "edit" : "add")(req, res, next),
	handle(async (req) => {
		const rid = req.body.id ? id(req.body.id) : null;
		const r = await reviews.save(rid, req.body.data, { idUser: userId(req) });
		audit.log(req, { action: rid ? "update" : "create", module: "products", entity: "review", id_entity: r.id, count: 1 });
		return { ok: true, id: r.id };
	})
);

router.post(
	"/api/catalog/products/reviews/moderate/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const r = await reviews.moderate(req.body, { idUser: userId(req) });
		audit.log(req, { action: "update", module: "products", entity: "review", count: r.updated, details: { status: req.body.status } });
		return { ok: true, ...r };
	})
);

router.post(
	"/api/catalog/products/reviews/:id/assign/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const rid = id(req.params.id);
		await reviews.assignProduct(rid, id((req.body || {}).id_product));
		audit.log(req, { action: "update", module: "products", entity: "review", id_entity: rid, count: 1, details: { assign: req.body.id_product } });
		return { ok: true };
	})
);

router.post(
	"/api/catalog/products/reviews/delete/",
	auth.isAuthenticated,
	need("delete"),
	handle(async (req) => {
		const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map((x) => parseInt(x, 10)) : [];
		const r = await reviews.remove(ids);
		audit.log(req, { action: "delete", module: "products", entity: "review", count: r.deleted });
		return { ok: true, ...r };
	})
);

// Ручний запуск обміну з магазинами (той самий, що в cron)
router.post(
	"/api/catalog/products/reviews/sync/",
	auth.isAuthenticated,
	need("edit"),
	(req, res, next) => (auth.hasPermission(req, "products.sync", "edit") ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") })),
	handle(async () => ({ ok: true, rows: await reviews.syncAll() }))
);

router.post("/api/catalog/products/reviews/sync/state/", auth.isAuthenticated, need("view"), handle(async () => ({ ok: true, rows: await reviews.syncState() })));

module.exports = router;