"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const settings = require("../../../controllers/catalog/products/settings");
const variants = require("../../../controllers/catalog/products/variants");
const editLock = require("../../../controllers/catalog/products/edit-lock");
const { getIO } = require("../../../controllers/socket/socket");

const L = "products.list";

const can = (req, slug, action) => auth.hasPermission(req, slug, action);
const need = (action) => (req, res, next) => (can(req, L, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const intId = (v) => {
	const n = parseInt(v, 10);
	if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error("Invalid id"), { status: 400 });
	return n;
};
const langOf = (req) => req.user.id_lang || 1;
const permsOf = (req) => ({
	edit: can(req, L, "edit"),
	cost: can(req, "products.cost", "view"),
	stock: can(req, "products.stock", "edit"),
});
const ctxOf = (req) => ({ idUser: req.user.userId, perms: permsOf(req), lockToken: req.body.lock_token, version: req.body.version });

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
			version: e.version,
		});
	}
};

/** Після змін — сповістити відкриті карточки цього товару */
function notifySaved(req, id, version) {
	const io = getIO();
	if (io) io.to(editLock.room(id)).emit("product:saved", { id, version, by: req.user.userId });
}

// ─── СТОРІНКА ────────────────────────────────────────
router.get("/catalog/products/:id/variants/", auth.isAuthenticated, async (req, res, next) => {
	if (!/^\d+$/.test(req.params.id)) return next();
	if (!can(req, L, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	try {
		const all = await settings.getAll();
		res.render("pages/catalog/products/variants", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_list" },
			productId: parseInt(req.params.id, 10),
			perms: permsOf(req),
			currency: all.prices.base_currency,
			heartbeatSeconds: all.edit_lock.heartbeat_seconds,
		});
	} catch (e) {
		next(e);
	}
});

// ─── API ─────────────────────────────────────────────
router.post("/api/catalog/products/:id/variants/get/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, ...(await variants.get(intId(req.params.id), langOf(req), permsOf(req))) })));

router.post(
	"/api/catalog/products/:id/variants/axes/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		const r = await variants.setAxes(id, req.body, ctxOf(req));
		audit.log(req, { action: "update", module: "products", entity: "product_variant_axes", id_entity: id, count: 1, details: { axes: req.body.axes } });
		notifySaved(req, id, r.version);
		return { ok: true, version: r.version };
	})
);

router.post(
	"/api/catalog/products/:id/variants/generate/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		const r = await variants.generate(id, req.body, ctxOf(req));
		audit.log(req, { action: "create", module: "products", entity: "product_variant", id_entity: id, count: r.created });
		notifySaved(req, id, r.version);
		return { ok: true, created: r.created, version: r.version };
	})
);

router.post(
	"/api/catalog/products/:id/variants/save/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		const r = await variants.save(id, req.body, ctxOf(req));
		audit.log(req, { action: "update", module: "products", entity: "product_variant", id_entity: id, count: r.saved });
		notifySaved(req, id, r.version);
		return { ok: true, version: r.version };
	})
);

router.post(
	"/api/catalog/products/:id/variants/delete/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		const r = await variants.remove(id, req.body, ctxOf(req));
		audit.log(req, { action: "delete", module: "products", entity: "product_variant", id_entity: id, count: r.deleted, details: { ids: req.body.ids } });
		notifySaved(req, id, r.version);
		return { ok: true, version: r.version };
	})
);

module.exports = router;