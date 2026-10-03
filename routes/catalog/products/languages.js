"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const languages = require("../../../controllers/catalog/products/languages");

const S = "products.settings";
const can = (req, action) => auth.hasPermission(req, S, action);
const need = (action) => (req, res, next) => (can(req, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const intId = (v) => {
	if (!/^\d+$/.test(String(v))) throw Object.assign(new Error("Invalid id"), { status: 400 });
	return parseInt(v, 10);
};
const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, code: e.code, error: e.status ? e.message : req.__("catalog.common.server_error"), errors: e.errors });
	}
};

router.get("/catalog/products/languages/", auth.isAuthenticated, (req, res) => {
	if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	res.render("pages/catalog/products/languages", {
		i18n: req,
		user: req.user,
		header: { navbar: "catalog", subnavbar: "products_languages" },
		perms: { edit: can(req, "edit") },
	});
});

router.post("/api/catalog/products/languages/list/", auth.isAuthenticated, need("view"), handle(async () => ({ ok: true, rows: await languages.list() })));

router.post(
	"/api/catalog/products/languages/save/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const b = req.body || {};
		const id = b.id ? intId(b.id) : null;
		const r = await languages.save(id, b);
		audit.log(req, { action: id ? "update" : "create", module: "products", entity: "language", id_entity: r.id, count: 1, details: b });
		return { ok: true, id: r.id };
	})
);

router.post(
	"/api/catalog/products/languages/:id/primary/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		await languages.setPrimary(id);
		audit.log(req, { action: "update", module: "products", entity: "language", id_entity: id, count: 1, details: { primary: true } });
		return { ok: true };
	})
);

router.post(
	"/api/catalog/products/languages/:id/delete/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		await languages.remove(id);
		audit.log(req, { action: "delete", module: "products", entity: "language", id_entity: id, count: 1 });
		return { ok: true };
	})
);

module.exports = router;