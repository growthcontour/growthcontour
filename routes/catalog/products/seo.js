"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const settings = require("../../../controllers/catalog/products/settings");
const languages = require("../../../controllers/catalog/products/languages");
const seo = require("../../../controllers/catalog/products/seo");
const { validateSetting } = require("../../../validator/catalog/products/settings");

const VIEW_SLUG = { products: "products.list", categories: "products.categories", brands: "products.brands" };

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error"), errors: e.errors });
	}
};
const forbidden = (req) => Object.assign(new Error(req.__("catalog.common.forbidden")), { status: 403 });
const optId = (v) => (v === null || v === undefined || v === "" ? null : /^\d+$/.test(String(v)) ? parseInt(v, 10) : null);

router.get("/catalog/settings/seo/", auth.isAuthenticated, async (req, res, next) => {
	if (!auth.hasPermission(req, "products.settings", "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	try {
		res.render("pages/catalog/products/seo", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_seo" },
			perms: { edit: auth.hasPermission(req, "products.settings", "edit") },
			cfg: await settings.get("seo"),
			languages: await languages.active(),
		});
	} catch (e) {
		next(e);
	}
});

// Превʼю ефективних значень для редакторів (чернетка форми поверх збереженого)
router.post(
	"/api/catalog/products/seo/preview/",
	auth.isAuthenticated,
	handle(async (req) => {
		const b = req.body || {};
		const slug = VIEW_SLUG[b.entity];
		if (!slug) throw Object.assign(new Error("Unknown entity"), { status: 400 });
		if (!auth.hasPermission(req, slug, "view")) throw forbidden(req);
		const draft = b.descriptions && typeof b.descriptions === "object" ? b.descriptions : {};
		const r = await seo.effectiveAll(b.entity, optId(b.id), draft);
		return { ok: true, limits: r.limits, langs: r.langs };
	})
);

// Перевірка шаблонів (у т.ч. незбережених) на конкретному записі
router.post(
	"/api/catalog/products/seo/test/",
	auth.isAuthenticated,
	handle(async (req) => {
		if (!auth.hasPermission(req, "products.settings", "view")) throw forbidden(req);
		const b = req.body || {};
		if (!VIEW_SLUG[b.entity]) throw Object.assign(new Error("Unknown entity"), { status: 400 });
		const id = optId(b.id);
		if (!id) throw Object.assign(new Error("Invalid id"), { status: 400 });
		let cfg = null;
		if (b.cfg) {
			const v = validateSetting("seo", b.cfg);
			if (!v.valid) throw Object.assign(new Error("Validation failed"), { status: 400, errors: v.errors });
			cfg = v.data;
		}
		const r = await seo.effectiveAll(b.entity, id, {}, cfg);
		if (!r.row) throw Object.assign(new Error("Not found"), { status: 404 });
		return { ok: true, langs: r.langs };
	})
);

router.post(
	"/api/catalog/products/seo/duplicates/",
	auth.isAuthenticated,
	handle(async (req) => {
		if (!auth.hasPermission(req, "products.settings", "view")) throw forbidden(req);
		const b = req.body || {};
		const idLang = optId(b.id_lang);
		if (!idLang) throw Object.assign(new Error("Invalid language"), { status: 400 });
		return { ok: true, rows: await seo.duplicates(b.entity, b.field, idLang) };
	})
);

module.exports = router;