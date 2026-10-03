"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const trash = require("../../../controllers/common/trash");
const descriptions = require("../../../controllers/catalog/products/descriptions");
const categories = require("../../../controllers/catalog/products/categories");
const brands = require("../../../controllers/catalog/products/brands");

const can = (req, slug, action) => auth.hasPermission(req, slug, action);
const need = (slug, action) => (req, res, next) => (can(req, slug, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const intId = (v) => {
	const n = parseInt(v, 10);
	if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error("Invalid id"), { status: 400 });
	return n;
};
const langOf = (req) => req.user.id_lang || 1;

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error"), errors: e.errors });
	}
};

const page = (view, slug, subnavbar) => async (req, res, next) => {
	if (!can(req, slug, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	try {
		res.render(view, {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar },
			perms: { add: can(req, slug, "add"), edit: can(req, slug, "edit"), delete: can(req, slug, "delete") },
			languages: await descriptions.contentLanguages(),
		});
	} catch (e) {
		next(e);
	}
};

// ═══ КАТЕГОРІЇ ═════════════════════════════════════════
const C = "products.categories";

router.get("/catalog/products/categories/", auth.isAuthenticated, page("pages/catalog/products/categories", C, "products_categories"));

// Дерево потрібне також карточці товару — достатньо права бачити товари
router.post(
	"/api/catalog/products/categories/tree/",
	auth.isAuthenticated,
	(req, res, next) => (can(req, C, "view") || can(req, "products.list", "view") ? next() : res.status(403).json({ ok: false })),
	handle(async (req) => ({ ok: true, rows: await categories.tree(langOf(req)) }))
);

router.post("/api/catalog/products/categories/:id/get/", auth.isAuthenticated, need(C, "view"), handle(async (req) => ({ ok: true, row: await categories.get(intId(req.params.id)) })));

router.post(
	"/api/catalog/products/categories/save/",
	auth.isAuthenticated,
	(req, res, next) => need(C, req.body && req.body.id ? "edit" : "add")(req, res, next),
	handle(async (req) => {
		const id = req.body.id ? intId(req.body.id) : null;
		const r = await categories.save(id, { ...(req.body.data || {}), descriptions: req.body.descriptions });
		audit.log(req, { action: id ? "update" : "create", module: "products", entity: "category", id_entity: r.id, count: 1 });
		return { ok: true, id: r.id };
	})
);

router.post(
	"/api/catalog/products/categories/:id/move/",
	auth.isAuthenticated,
	need(C, "edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		const parent = req.body.id_parent ? intId(req.body.id_parent) : null;
		await categories.move(id, parent, req.body.order);
		audit.log(req, { action: "update", module: "products", entity: "category", id_entity: id, count: 1, details: { move_to: parent } });
		return { ok: true };
	})
);

router.post(
	"/api/catalog/products/categories/:id/delete/",
	auth.isAuthenticated,
	need(C, "delete"),
	handle(async (req) => {
		const id = intId(req.params.id);
		await categories.remove(id);
		audit.log(req, { action: "delete", module: "products", entity: "category", id_entity: id, count: 1 });
		return { ok: true };
	})
);

// ═══ БРЕНДИ ════════════════════════════════════════════
const B = "products.brands";

router.get("/catalog/products/brands/", auth.isAuthenticated, page("pages/catalog/products/brands", B, "products_brands"));

router.post("/api/catalog/products/brands/list/", auth.isAuthenticated, need(B, "view"), handle(async (req) => brands.list(req.body || {}, langOf(req))));

router.post(
	"/api/catalog/products/brands/options/",
	auth.isAuthenticated,
	(req, res, next) => (can(req, B, "view") || can(req, "products.list", "view") ? next() : res.status(403).json({ ok: false })),
	handle(async (req) => ({ ok: true, rows: await brands.options((req.body || {}).search, langOf(req)) }))
);

router.post("/api/catalog/products/brands/:id/get/", auth.isAuthenticated, need(B, "view"), handle(async (req) => ({ ok: true, row: await brands.get(intId(req.params.id)) })));

router.post(
	"/api/catalog/products/brands/save/",
	auth.isAuthenticated,
	(req, res, next) => need(B, req.body && req.body.id ? "edit" : "add")(req, res, next),
	handle(async (req) => {
		const id = req.body.id ? intId(req.body.id) : null;
		const r = await brands.save(id, { ...(req.body.data || {}), descriptions: req.body.descriptions });
		audit.log(req, { action: id ? "update" : "create", module: "products", entity: "brand", id_entity: r.id, count: 1 });
		return { ok: true, id: r.id };
	})
);

router.post(
	"/api/catalog/products/brands/:id/delete/",
	auth.isAuthenticated,
	need(B, "delete"),
	handle(async (req) => {
		const id = intId(req.params.id);
		await trash.softDelete("product_brands", id, req.user.userId);
		audit.log(req, { action: "delete", module: "products", entity: "brand", id_entity: id, count: 1 });
		return { ok: true };
	})
);

// Старий шлях заготовки брендів → новий
router.get("/brands/", (req, res) => res.redirect(301, "/catalog/products/brands/"));

module.exports = router;