"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const trash = require("../../../controllers/common/trash");
const warehouses = require("../../../controllers/catalog/products/warehouses");
const suppliers = require("../../../controllers/catalog/products/suppliers");

const can = (req, slug, action) => auth.hasPermission(req, slug, action);
const need = (slug, action) => (req, res, next) => (can(req, slug, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
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

const page = (view, slug, subnavbar) => (req, res) => {
	if (!can(req, slug, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	res.render(view, {
		i18n: req,
		user: req.user,
		header: { navbar: "catalog", subnavbar },
		perms: { add: can(req, slug, "add"), edit: can(req, slug, "edit"), delete: can(req, slug, "delete") },
	});
};

// ═══ СКЛАДИ ════════════════════════════════════════════
const W = "products.warehouses";

router.get("/catalog/stock/warehouses/", auth.isAuthenticated, page("pages/catalog/products/warehouses", W, "products_warehouses"));

router.post("/api/catalog/products/warehouses/list/", auth.isAuthenticated, need(W, "view"), handle(async () => ({ ok: true, rows: await warehouses.list() })));

router.post("/api/catalog/products/warehouses/:id/get/", auth.isAuthenticated, need(W, "view"), handle(async (req) => ({ ok: true, row: await warehouses.get(id(req.params.id)) })));

router.post(
	"/api/catalog/products/warehouses/save/",
	auth.isAuthenticated,
	(req, res, next) => need(W, req.body && req.body.id ? "edit" : "add")(req, res, next),
	handle(async (req) => {
		const wid = req.body.id ? id(req.body.id) : null;
		const r = await warehouses.save(wid, req.body.data);
		audit.log(req, { action: wid ? "update" : "create", module: "products", entity: "warehouse", id_entity: r.id, count: 1 });
		return { ok: true, id: r.id };
	})
);

router.post(
	"/api/catalog/products/warehouses/:id/default/",
	auth.isAuthenticated,
	need(W, "edit"),
	need("products.settings", "edit"),
	handle(async (req) => {
		const wid = id(req.params.id);
		await warehouses.setDefault(wid, req.user.userId);
		audit.log(req, { action: "settings_save", module: "products", entity: "stock.id_default_warehouse", id_entity: wid, count: 1 });
		return { ok: true };
	})
);

router.post(
	"/api/catalog/products/warehouses/:id/delete/",
	auth.isAuthenticated,
	need(W, "delete"),
	handle(async (req) => {
		const wid = id(req.params.id);
		await warehouses.remove(wid, req.user.userId);
		audit.log(req, { action: "delete", module: "products", entity: "warehouse", id_entity: wid, count: 1 });
		return { ok: true };
	})
);

// ─── Комірки ─────────────────────────────────────────
router.post("/api/catalog/products/warehouses/:id/locations/list/", auth.isAuthenticated, need(W, "view"), handle(async (req) => ({ ok: true, rows: await warehouses.listLocations(id(req.params.id)) })));

router.post(
	"/api/catalog/products/warehouses/:id/locations/save/",
	auth.isAuthenticated,
	need(W, "edit"),
	handle(async (req) => {
		const wid = id(req.params.id);
		const lid = req.body.id ? id(req.body.id) : null;
		const r = await warehouses.saveLocation(wid, lid, req.body.data);
		audit.log(req, { action: lid ? "update" : "create", module: "products", entity: "warehouse_location", id_entity: r.id, count: 1, details: { id_warehouse: wid } });
		return { ok: true, id: r.id };
	})
);

router.post(
	"/api/catalog/products/warehouses/:id/locations/:lid/delete/",
	auth.isAuthenticated,
	need(W, "edit"),
	handle(async (req) => {
		const wid = id(req.params.id);
		const lid = id(req.params.lid);
		await warehouses.deleteLocation(wid, lid);
		audit.log(req, { action: "delete", module: "products", entity: "warehouse_location", id_entity: lid, count: 1, details: { id_warehouse: wid } });
		return { ok: true };
	})
);

// ═══ ПОСТАЧАЛЬНИКИ ═════════════════════════════════════
const S = "products.suppliers";

router.get("/catalog/stock/suppliers/", auth.isAuthenticated, page("pages/catalog/products/suppliers", S, "products_suppliers"));

router.post("/api/catalog/products/suppliers/list/", auth.isAuthenticated, need(S, "view"), handle(async (req) => suppliers.list(req.body || {})));

// Для select-ів в інших розділах достатньо права бачити склади або товари
router.post(
	"/api/catalog/products/suppliers/options/",
	auth.isAuthenticated,
	(req, res, next) => (can(req, S, "view") || can(req, W, "view") || can(req, "products.list", "view") ? next() : res.status(403).json({ ok: false })),
	handle(async (req) => ({ ok: true, rows: await suppliers.options((req.body || {}).search) }))
);

router.post("/api/catalog/products/suppliers/:id/get/", auth.isAuthenticated, need(S, "view"), handle(async (req) => ({ ok: true, row: await suppliers.get(id(req.params.id)) })));

router.post(
	"/api/catalog/products/suppliers/save/",
	auth.isAuthenticated,
	(req, res, next) => need(S, req.body && req.body.id ? "edit" : "add")(req, res, next),
	handle(async (req) => {
		const sid = req.body.id ? id(req.body.id) : null;
		const r = await suppliers.save(sid, req.body.data);
		audit.log(req, { action: sid ? "update" : "create", module: "products", entity: "supplier", id_entity: r.id, count: 1 });
		return { ok: true, id: r.id };
	})
);

router.post(
	"/api/catalog/products/suppliers/:id/delete/",
	auth.isAuthenticated,
	need(S, "delete"),
	handle(async (req) => {
		const sid = id(req.params.id);
		await trash.softDelete("product_suppliers", sid, req.user.userId);
		audit.log(req, { action: "delete", module: "products", entity: "supplier", id_entity: sid, count: 1 });
		return { ok: true };
	})
);

module.exports = router;