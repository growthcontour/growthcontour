"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const descriptions = require("../../../controllers/catalog/products/descriptions");
const options = require("../../../controllers/catalog/products/options");

const O = "products.options";

const can = (req, action) => auth.hasPermission(req, O, action);
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
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error"), errors: e.errors });
	}
};

router.get("/catalog/products/options/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	try {
		res.render("pages/catalog/products/options", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_options" },
			perms: { add: can(req, "add"), edit: can(req, "edit"), delete: can(req, "delete") },
			languages: await descriptions.contentLanguages(),
		});
	} catch (e) {
		next(e);
	}
});

// Довідник для карточки — достатньо права бачити товари
router.post(
	"/api/catalog/products/options/dictionary/",
	auth.isAuthenticated,
	(req, res, next) => (can(req, "view") || auth.hasPermission(req, "products.list", "view") ? next() : res.status(403).json({ ok: false })),
	handle(async (req) => ({ ok: true, ...(await options.dictionary(langOf(req))) }))
);

router.post("/api/catalog/products/options/list/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, rows: await options.list(langOf(req)) })));
router.post("/api/catalog/products/options/:id/get/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, row: await options.get(intId(req.params.id)) })));

router.post(
	"/api/catalog/products/options/save/",
	auth.isAuthenticated,
	(req, res, next) => need(req.body && req.body.id ? "edit" : "add")(req, res, next),
	handle(async (req) => {
		const id = req.body.id ? intId(req.body.id) : null;
		const r = await options.save(id, req.body.data);
		audit.log(req, { action: id ? "update" : "create", module: "products", entity: "option", id_entity: r.id, count: 1 });
		return { ok: true, id: r.id };
	})
);

router.post(
	"/api/catalog/products/options/:id/delete/",
	auth.isAuthenticated,
	need("delete"),
	handle(async (req) => {
		const id = intId(req.params.id);
		await options.remove(id);
		audit.log(req, { action: "delete", module: "products", entity: "option", id_entity: id, count: 1 });
		return { ok: true };
	})
);

module.exports = router;