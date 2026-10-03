"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const sync = require("../../../controllers/catalog/products/sync");

const P = config.get("configDatabase").prefix;
const S = "products.sync";
const can = (req, action) => auth.hasPermission(req, S, action);
const langOf = (req) => req.user.id_lang || 1;

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({
			ok: false,
			code: e.code,
			error: e.code === "busy" ? req.__("catalog.sync.busy") : e.status ? e.message : req.__("catalog.common.server_error"),
		});
	}
};
const need = (action) => (req, res, next) => (can(req, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const intId = (v) => {
	if (!/^\d+$/.test(String(v))) throw Object.assign(new Error("Invalid id"), { status: 400 });
	return parseInt(v, 10);
};

router.get("/catalog/products/sync/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	try {
		const [warehouses] = await pool.query(`SELECT id, name FROM ${P}products_warehouses WHERE deleted_at IS NULL AND status = 1 ORDER BY priority, sort_order, id`);
		res.render("pages/catalog/products/sync", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_sync" },
			perms: { edit: can(req, "edit") },
			integrations: await sync.listIntegrations(),
			warehouses,
		});
	} catch (e) {
		next(e);
	}
});

router.post("/api/catalog/products/sync/integrations/", auth.isAuthenticated, need("view"), handle(async () => ({ ok: true, rows: await sync.listIntegrations() })));

router.post(
	"/api/catalog/products/sync/:id/settings/",
	auth.isAuthenticated,
	need("view"),
	handle(async (req) => ({ ok: true, settings: await sync.getSettings(intId(req.params.id)) }))
);

router.post(
	"/api/catalog/products/sync/:id/settings/save/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		const settings = await sync.saveSettings(id, req.body || {});
		audit.log(req, { action: "update", module: "products", entity: "sync_settings", id_entity: id, count: 1, details: settings });
		return { ok: true, settings };
	})
);

router.post("/api/catalog/products/sync/:id/ping/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, ...(await sync.ping(intId(req.params.id))) })));

router.post(
	"/api/catalog/products/sync/:id/links/",
	auth.isAuthenticated,
	need("view"),
	handle(async (req) => sync.links(intId(req.params.id), req.body || {}, langOf(req)))
);

router.post(
	"/api/catalog/products/sync/:id/links/add/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		await sync.linkManual(id, req.body || {});
		audit.log(req, { action: "create", module: "products", entity: "external_link", count: 1, details: { integration: id, ...req.body } });
		return { ok: true };
	})
);

router.post(
	"/api/catalog/products/sync/:id/links/:linkId/delete/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		const linkId = intId(req.params.linkId);
		await sync.unlink(id, linkId);
		audit.log(req, { action: "delete", module: "products", entity: "external_link", id_entity: linkId, count: 1, details: { integration: id } });
		return { ok: true };
	})
);

router.post(
	"/api/catalog/products/sync/:id/match/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		const apply = (req.body || {}).apply === true || (req.body || {}).apply === 1;
		return { ok: true, ...(await sync.pullAndMatch(id, { apply }, req.user.userId)) };
	})
);

router.post(
	"/api/catalog/products/sync/:id/push/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		const force = (req.body || {}).force === true || (req.body || {}).force === 1;
		return { ok: true, stats: await sync.push(id, { trigger: "manual", force }, req.user.userId) };
	})
);

router.post("/api/catalog/products/sync/:id/log/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, rows: await sync.logList(intId(req.params.id)) })));

module.exports = router;