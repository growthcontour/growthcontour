"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("../../../controllers/catalog/products/settings");
const docs = require("../../../controllers/catalog/products/stock-documents");

const P = config.get("configDatabase").prefix;
const S = "products.stock";

const can = (req, slug, action) => auth.hasPermission(req, slug, action);
const need = (action) => (req, res, next) => (can(req, S, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const intId = (v) => {
	const n = parseInt(v, 10);
	if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error("Invalid id"), { status: 400 });
	return n;
};
const langOf = (req) => req.user.id_lang || 1;
const permsOf = (req) => ({
	view: can(req, S, "view"),
	add: can(req, S, "add"),
	edit: can(req, S, "edit"),
	delete: can(req, S, "delete"),
	cost: can(req, "products.cost", "view"),
	locations: can(req, "products.warehouses", "view"),
});

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error"), errors: e.errors, code: e.code && !String(e.code).startsWith("ER_") ? e.code : undefined, version: e.version });
	}
};

const forbidden = (req, res) => res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });

async function pageData(req) {
	const [[warehouses], [suppliers], all] = await Promise.all([
		pool.query(`SELECT id, code, name, status FROM ${P}products_warehouses WHERE deleted_at IS NULL ORDER BY priority, sort_order, id`),
		pool.query(`SELECT id, name, code FROM ${P}products_suppliers WHERE deleted_at IS NULL AND status = 1 ORDER BY name LIMIT 1000`),
		settings.getAll(),
	]);
	return {
		i18n: req,
		user: req.user,
		header: { navbar: "catalog", subnavbar: "products_stock" },
		perms: permsOf(req),
		warehouses,
		suppliers,
		stockCfg: all.stock,
		currency: all.prices.base_currency,
	};
}

// ═══ СТОРІНКИ ══════════════════════════════════════════
router.get("/catalog/stock/documents/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, S, "view")) return forbidden(req, res);
	try {
		res.render("pages/catalog/products/stock-documents", await pageData(req));
	} catch (e) {
		next(e);
	}
});

router.get("/catalog/stock/documents/new/:type/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, S, "add")) return forbidden(req, res);
	if (!docs.PREFIX[req.params.type]) return next();
	try {
		res.render("pages/catalog/products/stock-document", { ...(await pageData(req)), documentId: null, documentType: req.params.type });
	} catch (e) {
		next(e);
	}
});

router.get("/catalog/stock/documents/:id/", auth.isAuthenticated, async (req, res, next) => {
	if (!/^\d+$/.test(req.params.id)) return next();
	if (!can(req, S, "view")) return forbidden(req, res);
	try {
		res.render("pages/catalog/products/stock-document", { ...(await pageData(req)), documentId: parseInt(req.params.id, 10), documentType: null });
	} catch (e) {
		next(e);
	}
});

// «Що дозамовити»: нестача за точкою дозамовлення або за швидкістю продажів; чернетки надходження постачальнику
const reorder = require("../../../controllers/catalog/products/reorder");
router.get("/catalog/stock/reorder/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, S, "view")) return forbidden(req, res);
	try {
		res.render("pages/catalog/products/reorder", await pageData(req));
	} catch (e) {
		next(e);
	}
});
router.post("/api/catalog/products/stock/reorder/list/", auth.isAuthenticated, need("view"), handle(async (req) => {
	const rows = await reorder.list({ idLang: langOf(req), idWarehouse: parseInt((req.body || {}).id_warehouse, 10) || null });
	// Ціни постачальника — лише з правом на собівартість
	if (!can(req, "products.cost", "view")) rows.forEach((r) => r.supplier && (r.supplier.price = null));
	return { ok: true, rows };
}));
router.post("/api/catalog/products/stock/reorder/create/", auth.isAuthenticated, need("add"), handle(async (req) => {
	const r = await reorder.createDrafts((req.body || {}).lines, { idUser: req.user.userId, perms: permsOf(req), comment: req.__("catalog.stock.reorder.comment") });
	audit.log(req, { action: "reorder_drafts", module: "products", entity: "stock_documents", count: r.created.length, details: { ids: r.created } });
	return { ok: true, ...r };
}));

// Звіти: маржа (право на собівартість) і оборотність / ABC / «мертвий» запас
const reports = require("../../../controllers/catalog/products/reports");
router.get("/catalog/reports/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, S, "view")) return forbidden(req, res);
	try {
		const [integrations] = await pool.query(`SELECT id, name FROM ${P}settings_integrations ORDER BY name`);
		res.render("pages/catalog/products/reports", { ...(await pageData(req)), integrations });
	} catch (e) {
		next(e);
	}
});
router.post("/api/catalog/products/reports/margin/", auth.isAuthenticated, need("view"), handle(async (req) => {
	if (!can(req, "products.cost", "view")) throw Object.assign(new Error(req.__("catalog.common.forbidden")), { status: 403 });
	return { ok: true, ...(await reports.margin(req.body || {}, langOf(req))) };
}));
router.post("/api/catalog/products/reports/stock/", auth.isAuthenticated, need("view"), handle(async (req) => {
	const r = await reports.stock(req.body || {}, langOf(req));
	// Вартість запасу — лише з правом на собівартість
	if (!can(req, "products.cost", "view")) {
		r.rows.forEach((x) => ((x.stock_value = null), (x.cost = null)));
		r.summary.stock_value = null;
		r.summary.dead_value = null;
	}
	return { ok: true, ...r };
}));

router.get("/catalog/stock/movements/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, S, "view")) return forbidden(req, res);
	try {
		res.render("pages/catalog/products/stock-movements", await pageData(req));
	} catch (e) {
		next(e);
	}
});

// ═══ API ═══════════════════════════════════════════════
router.post("/api/catalog/products/stock/documents/list/", auth.isAuthenticated, need("view"), handle(async (req) => docs.list(req.body || {})));
router.post("/api/catalog/products/stock/documents/:id/get/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, row: await docs.get(intId(req.params.id), langOf(req), permsOf(req)) })));

router.post(
	"/api/catalog/products/stock/documents/save/",
	auth.isAuthenticated,
	(req, res, next) => need(req.body && req.body.id ? "edit" : "add")(req, res, next),
	handle(async (req) => {
		const id = req.body.id ? intId(req.body.id) : null;
		const r = await docs.saveDraft(id, req.body, { idUser: req.user.userId, perms: permsOf(req) });
		audit.log(req, { action: id ? "update" : "create", module: "products", entity: "stock_document", id_entity: r.id, count: 1 });
		return { ok: true, id: r.id, version: r.version };
	})
);

router.post(
	"/api/catalog/products/stock/documents/:id/post/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		await docs.post(id, req.body || {}, { idUser: req.user.userId });
		audit.log(req, { action: "update", module: "products", entity: "stock_document", id_entity: id, count: 1, details: { status: "posted" } });
		return { ok: true };
	})
);

router.post(
	"/api/catalog/products/stock/documents/:id/cancel/",
	auth.isAuthenticated,
	need("delete"),
	handle(async (req) => {
		const id = intId(req.params.id);
		await docs.cancel(id, req.body || {}, { idUser: req.user.userId });
		audit.log(req, { action: "update", module: "products", entity: "stock_document", id_entity: id, count: 1, details: { status: "cancelled" } });
		return { ok: true };
	})
);

router.post(
	"/api/catalog/products/stock/documents/:id/delete/",
	auth.isAuthenticated,
	need("delete"),
	handle(async (req) => {
		const id = intId(req.params.id);
		await docs.removeDraft(id);
		audit.log(req, { action: "delete", module: "products", entity: "stock_document", id_entity: id, count: 1 });
		return { ok: true };
	})
);

router.post("/api/catalog/products/stock/movements/list/", auth.isAuthenticated, need("view"), handle(async (req) => docs.movements(req.body || {}, langOf(req), permsOf(req))));

module.exports = router;