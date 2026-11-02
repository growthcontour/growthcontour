"use strict";

// Сторінка «Імпорт із сайту» в системі: ті самі тест / пробний / повний імпорт, що й із модуля магазину
const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const siteImport = require("../../../controllers/catalog/products/site-import");

const S = "products.import";
const can = (req, action) => auth.hasPermission(req, S, action);
const userId = (req) => (req.user && (req.user.userId || req.user.id)) || null;

const fail = (req, res, e) => {
	if (!e.status || e.status >= 500) logging.error(e);
	res.status(e.status && e.status < 500 ? e.status : 500).json({ ok: false, error: e.status && e.status < 500 ? e.message : req.__("catalog.common.server_error"), code: e.code || null });
};
const need = (action) => (req, res, next) => (can(req, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const integ = (req) => parseInt((req.body || {}).id_integration, 10) || 0;
const jobId = (req) => parseInt((req.body || {}).id, 10) || 0;

// ═══ СТОРІНКА ══════════════════════════════════════════
router.get("/catalog/import/site/", auth.isAuthenticated, async (req, res) => {
	if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	try {
		res.render("pages/catalog/products/site-import", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_import" },
			perms: { view: true, add: can(req, "add"), edit: can(req, "edit") },
			integrations: await siteImport.integrations(),
		});
	} catch (e) {
		logging.error(e);
		res.status(500).render("pages/error/404", { message: req.__("catalog.common.server_error"), error: { status: 500 } });
	}
});

// ═══ API ═══════════════════════════════════════════════
const B = "/api/catalog/products/site-import";

router.post(`${B}/options/`, auth.isAuthenticated, need("view"), async (req, res) => {
	try {
		const [system, site] = await Promise.all([siteImport.systemOptions(), siteImport.siteMeta(integ(req))]);
		res.json({ ok: true, system, site });
	} catch (e) {
		fail(req, res, e);
	}
});

// Розклад: читання — з правом перегляду, збереження — з правом додавання
router.post(`${B}/schedule/`, auth.isAuthenticated, need("view"), async (req, res) => {
	try {
		const b = req.body || {};
		if (b.save && !can(req, "add")) return res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") });
		const schedule = b.save ? await siteImport.saveSchedule(integ(req), { hours: b.hours, at: b.at, options: b.options }) : await siteImport.getSchedule(integ(req));
		res.json({ ok: true, schedule });
	} catch (e) {
		fail(req, res, e);
	}
});

router.post(`${B}/start/`, auth.isAuthenticated, need("add"), async (req, res) => {	try {
		const b = req.body || {};
		res.json({ ok: true, ...(await siteImport.start(integ(req), { mode: b.mode, options: b.options, resume_id: b.resume_id }, userId(req))) });
	} catch (e) {
		fail(req, res, e);
	}
});

router.post(`${B}/status/`, auth.isAuthenticated, need("view"), async (req, res) => {
	try {
		res.json({ ok: true, ...(await siteImport.status(integ(req), jobId(req) || null)) });
	} catch (e) {
		fail(req, res, e);
	}
});

router.post(`${B}/items/`, auth.isAuthenticated, need("view"), async (req, res) => {
	try {
		const b = req.body || {};
		res.json({ ok: true, ...(await siteImport.items(integ(req), jobId(req), { action: b.action, search: b.search, warnings: b.warnings, page: b.page, limit: b.limit })) });
	} catch (e) {
		fail(req, res, e);
	}
});

router.post(`${B}/cancel/`, auth.isAuthenticated, need("add"), async (req, res) => {
	try {
		res.json({ ok: true, ...(await siteImport.cancel(integ(req), jobId(req))) });
	} catch (e) {
		fail(req, res, e);
	}
});

router.post(`${B}/rollback/`, auth.isAuthenticated, need("edit"), async (req, res) => {
	try {
		res.json({ ok: true, ...(await siteImport.rollback(integ(req), jobId(req), userId(req))) });
	} catch (e) {
		fail(req, res, e);
	}
});

module.exports = router;
