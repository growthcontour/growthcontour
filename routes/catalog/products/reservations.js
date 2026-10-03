"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const descriptions = require("../../../controllers/catalog/products/descriptions");
const reservations = require("../../../controllers/catalog/products/reservations");

const P = config.get("configDatabase").prefix;
const S = "products.stock";
const can = (req, action) => auth.hasPermission(req, S, action);
const langOf = (req) => req.user.id_lang || 1;

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error"), errors: e.errors });
	}
};
const need = (action) => (req, res, next) => (can(req, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const intId = (v) => {
	if (!/^\d+$/.test(String(v))) throw Object.assign(new Error("Invalid id"), { status: 400 });
	return parseInt(v, 10);
};

router.get("/catalog/products/stock/reservations/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	try {
		const [warehouses] = await pool.query(`SELECT id, name FROM ${P}products_warehouses WHERE deleted_at IS NULL ORDER BY priority, sort_order, id`);
		const [refTypes] = await pool.query(`SELECT DISTINCT ref_type FROM ${P}products_stock_reservations ORDER BY ref_type`);
		res.render("pages/catalog/products/reservations", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_stock" },
			perms: { edit: can(req, "edit") },
			warehouses,
			refTypes: refTypes.map((r) => r.ref_type),
			productId: /^\d+$/.test(String(req.query.id_product || "")) ? parseInt(req.query.id_product, 10) : null,
		});
	} catch (e) {
		next(e);
	}
});

router.post(
	"/api/catalog/products/reservations/list/",
	auth.isAuthenticated,
	need("view"),
	handle(async (req) => {
		const langs = await descriptions.contentLanguages();
		return reservations.list(req.body || {}, langOf(req), langs[0] ? langs[0].id : langOf(req));
	})
);

router.post(
	"/api/catalog/products/reservations/:id/release/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		const comment = String((req.body || {}).comment || "").trim().slice(0, 255) || null;
		const r = await reservations.releaseOne(id, req.user.userId, comment);
		audit.log(req, { action: "update", module: "products", entity: "reservation", id_entity: id, count: 1, details: { release: true, ...r, comment } });
		return { ok: true };
	})
);

router.post(
	"/api/catalog/products/reservations/release-ref/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const b = req.body || {};
		if (!/^[a-z_]{1,32}$/.test(String(b.ref_type || ""))) throw Object.assign(new Error("Invalid ref_type"), { status: 400 });
		const refId = intId(b.ref_id);
		const n = await reservations.releaseRef(b.ref_type, refId, req.user.userId);
		audit.log(req, { action: "update", module: "products", entity: "reservation", count: n, details: { release_ref: true, ref_type: b.ref_type, ref_id: refId } });
		return { ok: true, released: n };
	})
);

module.exports = router;