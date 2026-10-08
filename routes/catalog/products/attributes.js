"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const descriptions = require("../../../controllers/catalog/products/descriptions");
const settings = require("../../../controllers/catalog/products/settings");
const attributes = require("../../../controllers/catalog/products/attributes");

const A = "products.attributes";

const can = (req, action) => auth.hasPermission(req, A, action);
const need = (action) => (req, res, next) => (can(req, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const needSaveRight = (req, res, next) => need(req.body && req.body.id ? "edit" : "add")(req, res, next);
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
		res.status(e.status || 500).json({
			ok: false,
			error: e.status ? e.message : req.__("catalog.common.server_error"),
			errors: e.errors,
			code: e.code && !String(e.code).startsWith("ER_") ? e.code : undefined,
			products: e.products,
		});
	}
};

// ─── СТОРІНКА ────────────────────────────────────────
router.get("/catalog/attributes/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	try {
		res.render("pages/catalog/products/attributes", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_attributes" },
			perms: { add: can(req, "add"), edit: can(req, "edit"), delete: can(req, "delete") },
			canSettings: auth.hasPermission(req, "products.settings", "edit"),
			languages: await descriptions.contentLanguages(),
		});
	} catch (e) {
		next(e);
	}
});

// ─── ДОВІДНИК (для карточки товару) ──────────────────
router.post(
	"/api/catalog/products/attributes/dictionary/",
	auth.isAuthenticated,
	(req, res, next) => (can(req, "view") || auth.hasPermission(req, "products.list", "view") ? next() : res.status(403).json({ ok: false })),
	handle(async (req) => ({ ok: true, ...(await attributes.dictionary(langOf(req))) }))
);

// ─── ГРУПИ ───────────────────────────────────────────
router.post("/api/catalog/products/attributes/groups/list/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, rows: await attributes.listGroups(langOf(req)) })));
router.post("/api/catalog/products/attributes/groups/:id/get/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, row: await attributes.getGroup(intId(req.params.id)) })));
router.post(
	"/api/catalog/products/attributes/groups/save/",
	auth.isAuthenticated,
	needSaveRight,
	handle(async (req) => {
		const id = req.body.id ? intId(req.body.id) : null;
		const r = await attributes.saveGroup(id, req.body.data);
		audit.log(req, { action: id ? "update" : "create", module: "products", entity: "attribute_group", id_entity: r.id, count: 1 });
		return { ok: true, id: r.id };
	})
);
router.post(
	"/api/catalog/products/attributes/groups/:id/delete/",
	auth.isAuthenticated,
	need("delete"),
	handle(async (req) => {
		const id = intId(req.params.id);
		await attributes.removeGroup(id);
		audit.log(req, { action: "delete", module: "products", entity: "attribute_group", id_entity: id, count: 1 });
		return { ok: true };
	})
);

// ─── ХАРАКТЕРИСТИКИ ──────────────────────────────────
router.post("/api/catalog/products/attributes/list/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, rows: await attributes.listAttributes(langOf(req)) })));
router.post("/api/catalog/products/attributes/:id/get/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, row: await attributes.getAttribute(intId(req.params.id)) })));
router.post(
	"/api/catalog/products/attributes/save/",
	auth.isAuthenticated,
	needSaveRight,
	handle(async (req) => {
		const id = req.body.id ? intId(req.body.id) : null;
		// Примусове видалення значень, що використовуються в товарах, — лише з правом видалення
		const force = req.body.force === true && can(req, "delete");
		const r = await attributes.saveAttribute(id, { ...(req.body.data || {}), force });
		audit.log(req, { action: id ? "update" : "create", module: "products", entity: "attribute", id_entity: r.id, count: 1, details: { force } });
		return { ok: true, id: r.id };
	})
);
router.post(
	"/api/catalog/products/attributes/:id/delete/",
	auth.isAuthenticated,
	need("delete"),
	handle(async (req) => {
		const id = intId(req.params.id);
		await attributes.removeAttribute(id, req.body && req.body.force === true);
		audit.log(req, { action: "delete", module: "products", entity: "attribute", id_entity: id, count: 1 });
		return { ok: true };
	})
);

// ─── НАБОРИ ──────────────────────────────────────────
router.post("/api/catalog/products/attributes/sets/list/", auth.isAuthenticated, need("view"), handle(async () => ({ ok: true, rows: await attributes.listSets() })));
router.post("/api/catalog/products/attributes/sets/:id/get/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, row: await attributes.getSet(intId(req.params.id)) })));
router.post(
	"/api/catalog/products/attributes/sets/save/",
	auth.isAuthenticated,
	needSaveRight,
	handle(async (req) => {
		const id = req.body.id ? intId(req.body.id) : null;
		const r = await attributes.saveSet(id, req.body.data);
		audit.log(req, { action: id ? "update" : "create", module: "products", entity: "attribute_set", id_entity: r.id, count: 1 });
		return { ok: true, id: r.id };
	})
);
router.post(
	"/api/catalog/products/attributes/sets/:id/default/",
	auth.isAuthenticated,
	need("edit"),
	(req, res, next) => (auth.hasPermission(req, "products.settings", "edit") ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") })),
	handle(async (req) => {
		const id = intId(req.params.id);
		await attributes.setDefaultSet(id, req.user.userId);
		audit.log(req, { action: "settings_save", module: "products", entity: "card.id_default_attribute_set", id_entity: id, count: 1 });
		return { ok: true };
	})
);
router.post(
	"/api/catalog/products/attributes/sets/:id/delete/",
	auth.isAuthenticated,
	need("delete"),
	handle(async (req) => {
		const id = intId(req.params.id);
		await attributes.removeSet(id, req.user.userId);
		audit.log(req, { action: "delete", module: "products", entity: "attribute_set", id_entity: id, count: 1 });
		return { ok: true };
	})
);

module.exports = router;