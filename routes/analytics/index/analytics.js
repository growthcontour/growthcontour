"use strict";

/**
 * Аналітика: сторінка /analytics/ і дані для неї та для головної.
 * Усі дані — через кеш (controllers/analytics/cache.js): готові відповіді, без важких запитів на кожне відкриття.
 * Право analytics: view — бачити; edit — «Оновити дані» (перерахунок кешу).
 *
 * Старі адреси головної (/api/analytics/summary/ тощо) збережені й відповідають тим самим форматом, але теж із кешу.
 */
const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging").child("analytics");
const cache = require("../../../controllers/analytics/cache");
const sales = require("../../../controllers/analytics/sales");
const reports = require("../../../controllers/analytics/reports");

const SLUG = "analytics";
const can = (req, action) => auth.hasPermission(req, SLUG, action);
const need = (action) => (req, res, next) => (can(req, action) ? next() : res.status(403).json({ ok: false, message: req.__("catalog.common.forbidden") }));
const lang = (req) => req.user.id_lang || 1;
const fail = (req, res, e) => {
	if (!e.status) logging.error(e);
	res.status(e.status || 500).json({ ok: false, message: e.status ? e.message : req.__("catalog.common.server_error") });
};

router.get("/analytics/", auth.isAuthenticated, (req, res) => {
	if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	res.render("pages/analytics/index", { i18n: req, user: req.user, header: { navbar: "analytics" }, perms: { edit: can(req, "edit") } });
});

/**
 * Дані розділу з кешу: { ok, data, built_at, cached }.
 * body: фільтр сторінки + group (товари), metric / limit (ТОП товарів), fresh (лише з правом edit).
 */
router.post("/api/analytics/data/:name/", auth.isAuthenticated, need("view"), async (req, res) => {
	try {
		const b = req.body || {};
		const name = String(req.params.name);
		const r = await cache.get(name, b, { lang: lang(req), group: b.group }, { fresh: !!b.fresh && can(req, "edit") });
		const data = name === "top_products" ? sales.topProductsView(r.data, b.metric, Math.min(50, Math.max(1, parseInt(b.limit, 10) || 10))) : r.data;
		res.json({ ok: true, data, built_at: r.built_at, cached: r.cached });
	} catch (e) {
		fail(req, res, e);
	}
});

/* ─── Старі адреси головної: той самий формат відповіді ─── */

const LEGACY = {
	summary: "summary",
	timeseries: "timeseries",
	statuses: "statuses",
	channels: "channels",
	"top-products": "top_products",
	funnel: "funnel",
	"abandoned-carts": "carts",
	"integration-health": "health",
};
for (const [path, name] of Object.entries(LEGACY)) {
	router.post(`/api/analytics/${path}/`, auth.isAuthenticated, need("view"), async (req, res) => {
		try {
			const b = req.body || {};
			const r = await cache.get(name, b, { lang: lang(req) });
			res.json(name === "top_products" ? sales.topProductsView(r.data, b.metric, Math.min(50, Math.max(1, parseInt(b.limit, 10) || 10))) : r.data);
		} catch (e) {
			fail(req, res, e);
		}
	});
}
// Розділи сторінки /analytics/ (попередня адреса)
router.post("/api/analytics/section/:name/", auth.isAuthenticated, need("view"), async (req, res) => {
	try {
		const b = req.body || {};
		res.json((await cache.get(String(req.params.name), b, { lang: lang(req), group: b.group })).data);
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/analytics/integrations/", auth.isAuthenticated, need("view"), async (req, res) => {
	try {
		res.json(await sales.integrations());
	} catch (e) {
		fail(req, res, e);
	}
});

/* ─── Кеш: стан і ручне оновлення ─── */

router.post("/api/analytics/cache/status/", auth.isAuthenticated, need("view"), (req, res) => res.json({ ok: true, ...cache.status() }));

router.post("/api/analytics/cache/refresh/", auth.isAuthenticated, need("edit"), (req, res) => {
	const st = cache.status();
	if (!st.running) {
		cache.warm("full");
		require("../../../controllers/common/audit").log(req, { action: "analytics_refresh", module: "analytics", entity: "analytics_cache", count: 1 });
	}
	res.json({ ok: true, ...cache.status() });
});

/* ─── Excel ─── */

// Книга рахується наживо (усі розділи) — одночасно не більше однієї, щоб не перевантажити базу
let exporting = false;
router.get("/api/analytics/export/", auth.isAuthenticated, need("view"), async (req, res) => {
	if (exporting) return res.status(429).type("text/plain; charset=utf-8").send(req.__("analytics.export.busy"));
	exporting = true;
	try {
		const q = req.query || {};
		const f = sales.parseFilters({ ...q, integrations: q.integrations ? String(q.integrations).split(",") : undefined });
		const t = (k) => req.__("analytics.export." + k);
		const labels = { sheets: {}, cols: {} };
		["summary", "sales", "statuses", "channels", "products", "delivery", "payments", "clients", "cohorts", "top_clients", "managers", "returns", "automation"].forEach((k) => (labels.sheets[k] = t("sheets." + k)));
		Object.keys(req.__("analytics.export.cols")).forEach((k) => (labels.cols[k] = t("cols." + k)));
		const wb = await reports.workbook(f, lang(req), labels);
		res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
		res.setHeader("Content-Disposition", `attachment; filename="analytics_${f.date_from}_${f.date_to}.xlsx"`);
		await wb.xlsx.write(res);
		res.end();
	} catch (e) {
		logging.error(e);
		if (!res.headersSent) res.status(500).send(req.__("catalog.common.server_error"));
	} finally {
		exporting = false;
	}
});

module.exports = router;