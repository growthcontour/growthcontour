"use strict";

/**
 * Звіти: сторінка /reports/ (право reports.view), замовлення звіту, список готових, перегляд, завантаження.
 * Кожен звіт має ще й своє право (definitions.js → perm): без нього звіту немає в каталозі й не видно його результатів.
 * reports.edit — видаляти чужі звіти.
 */
const express = require("express");
const router = express.Router();

const auth = require("../../controllers/authorization/authorization");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging").child("reports");
const jobs = require("../../controllers/reports/jobs");
const defs = require("../../controllers/reports/definitions");

const P = config.get("configDatabase").prefix;
const need = (req, res, next) => (auth.hasPermission(req, "reports", "view") ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const id = (v) => {
	const n = parseInt(v, 10);
	if (!(n > 0)) throw Object.assign(new Error("Bad id"), { status: 400 });
	return n;
};
const handle = (fn, wrap = true) => async (req, res) => {
	try {
		const r = await fn(req);
		res.json(wrap ? { ok: true, ...r } : r);
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error"), errors: e.errors });
	}
};

router.get("/reports/", auth.isAuthenticated, async (req, res) => {
	if (!auth.hasPermission(req, "reports", "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden") });
	try {
		const lang = req.user.id_lang || 1;
		const [[statuses], [sites], [managers]] = await Promise.all([
			pool.query(`SELECT s.id, sl.text AS name FROM ${P}orders_status s LEFT JOIN ${P}orders_status_lang sl ON sl.id_status = s.id AND sl.id_lang = ? ORDER BY s.id`, [lang]),
			pool.query(`SELECT id, name FROM ${P}settings_integrations ORDER BY name`),
			pool.query(`SELECT id, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM ${P}users WHERE active = 1 ORDER BY first_name, last_name`),
		]);
		res.render("pages/reports/index", {
			i18n: req,
			user: req.user,
			header: { navbar: "reports" },
			catalog: jobs.allowed(req.user).map((d) => ({ key: d.key, group: d.group, params: d.params })),
			groups: defs.GROUPS,
			dicts: { statuses, sites, managers },
			perms: { edit: auth.hasPermission(req, "reports", "edit") },
		});
	} catch (e) {
		logging.error(e);
		res.status(500).render("pages/error/404", {});
	}
});

router.post("/api/reports/jobs/", auth.isAuthenticated, need, handle((req) => jobs.list(req, req.body || {}), false));
router.post("/api/reports/create/", auth.isAuthenticated, need, handle((req) => jobs.create(req, req.body || {})));
router.post("/api/reports/jobs/:id/preview/", auth.isAuthenticated, need, handle((req) => jobs.preview(req, id(req.params.id))));
router.post("/api/reports/jobs/:id/repeat/", auth.isAuthenticated, need, handle((req) => jobs.repeat(req, id(req.params.id))));
router.post("/api/reports/jobs/:id/delete/", auth.isAuthenticated, need, handle((req) => jobs.remove(req, id(req.params.id))));

router.get("/api/reports/jobs/:id/download/", auth.isAuthenticated, need, async (req, res) => {
	try {
		const f = await jobs.download(req, id(req.params.id));
		res.download(f.file, f.name);
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).type("text/plain; charset=utf-8").send(e.status ? e.message : req.__("catalog.common.server_error"));
	}
});

module.exports = router;