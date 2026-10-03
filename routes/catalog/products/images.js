"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const settings = require("../../../controllers/catalog/products/settings");
const images = require("../../../controllers/catalog/products/images");
const maintenance = require("../../../controllers/catalog/products/images-maintenance");

const S = "products.settings";
const can = (req, action) => auth.hasPermission(req, S, action);

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({
			ok: false,
			code: e.status === 409 ? "busy" : undefined,
			error: e.status === 409 ? req.__("catalog.images_maint.busy") : e.status ? e.message : req.__("catalog.common.server_error"),
		});
	}
};

router.get("/catalog/products/settings/images/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	try {
		const cfg = await settings.get("images");
		res.render("pages/catalog/products/images-maintenance", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_images" },
			perms: { edit: can(req, "edit") },
			kinds: images.KINDS,
			thumbnails: cfg.thumbnails,
		});
	} catch (e) {
		next(e);
	}
});

router.post(
	"/api/catalog/products/images/status/",
	auth.isAuthenticated,
	(req, res, next) => (can(req, "view") ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") })),
	handle(async () => ({ ok: true, job: maintenance.status() }))
);

router.post(
	"/api/catalog/products/images/run/",
	auth.isAuthenticated,
	(req, res, next) => (can(req, "edit") ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") })),
	handle(async (req) => {
		const b = req.body || {};
		const type = b.type === "regenerate" ? "regenerate" : b.type === "cleanup" ? "cleanup" : null;
		if (!type) throw Object.assign(new Error("Invalid type"), { status: 400 });
		const kinds = Array.isArray(b.kinds) ? b.kinds.filter((k) => images.KINDS.includes(k)) : [];
		const codes = Array.isArray(b.codes) ? b.codes.filter((c) => /^[a-z0-9_]{1,32}$/.test(c)) : [];
		const minAge = parseInt(b.min_age_hours, 10);
		const opts = {
			kinds,
			codes,
			dryRun: b.dry_run === true || b.dry_run === 1 || b.dry_run === "1",
			minAgeHours: Number.isInteger(minAge) && minAge >= 1 && minAge <= 720 ? minAge : 24,
		};
		const job = await maintenance.start(type, opts);
		if (!opts.dryRun) audit.log(req, { action: "update", module: "products", entity: "images", count: 0, details: { maintenance: type, kinds, codes } });
		return { ok: true, job };
	})
);

module.exports = router;