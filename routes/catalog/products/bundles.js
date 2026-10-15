"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const settings = require("../../../controllers/catalog/products/settings");
const bundles = require("../../../controllers/catalog/products/bundles");
const editLock = require("../../../controllers/catalog/products/edit-lock");
const { getIO } = require("../../../controllers/socket/socket");

const L = "products.list";
const can = (req, action) => auth.hasPermission(req, L, action);
const need = (action) => (req, res, next) => (can(req, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
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
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error"), errors: e.errors, code: e.code && !String(e.code).startsWith("ER_") ? e.code : undefined, version: e.version });
	}
};

router.get("/catalog/products/:id/bundle/", auth.isAuthenticated, async (req, res, next) => {
	if (!/^\d+$/.test(req.params.id)) return next();
	if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	try {
		const all = await settings.getAll();
		res.render("pages/catalog/products/bundle", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_list" },
			productId: parseInt(req.params.id, 10),
			perms: { edit: can(req, "edit") },
			currency: all.prices.base_currency,
			heartbeatSeconds: all.edit_lock.heartbeat_seconds,
		});
	} catch (e) {
		next(e);
	}
});

router.post("/api/catalog/products/:id/bundle/get/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, ...(await bundles.get(intId(req.params.id), langOf(req))) })));

router.post(
	"/api/catalog/products/:id/bundle/variants/",
	auth.isAuthenticated,
	need("view"),
	handle(async (req) => ({ ok: true, rows: await bundles.componentVariants(intId((req.body || {}).id_product), langOf(req)) }))
);

router.post(
	"/api/catalog/products/:id/bundle/save/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		const r = await bundles.save(id, req.body, { idUser: req.user.userId, lockToken: req.body.lock_token, version: req.body.version });
		audit.log(req, { action: "update", module: "products", entity: "product_bundle", id_entity: id, count: r.saved });
		const io = getIO();
		if (io) io.to(editLock.room(id)).emit("product:saved", { id, version: r.version, by: req.user.userId });
		return { ok: true, version: r.version };
	})
);

module.exports = router;