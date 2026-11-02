const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const system = require("../../../controllers/common/system");
const audit = require("../../../controllers/common/audit");

// Право system.audit: view — бачити стан, помилки й журнали; edit — повторювати черги, позначати помилки, очищати журнали
const SLUG = "system.audit";
const need = (action) => (req, res, next) => (auth.hasPermission(req, SLUG, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error") });
	}
};
// Tabulator remote чекає { last_page, data } без обгортки ok
const raw = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error") });
	}
};
const userId = (req) => req.user.userId || req.user.id;

router.get("/settings/system/", auth.isAuthenticated, (req, res) => {
	if (!auth.hasPermission(req, SLUG, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	res.render("pages/settings/system/index", {
		i18n: req,
		user: req.user,
		header: { navbar: "settings", subnavbar: "system" },
		perms: { edit: auth.hasPermission(req, SLUG, "edit") },
		queues: Object.keys(system.QUEUES),
	});
});

/* ─── Огляд ─── */

router.post(
	"/api/settings/system/overview/",
	auth.isAuthenticated,
	need("view"),
	handle(async () => {
		const [overview, queues, jobs, files, timeline, logs_size, errs] = await Promise.all([
			system.overview(),
			system.queues(),
			system.jobs(),
			system.logFiles(),
			system.errorsTimeline(48).catch(() => []),
			system.dirSize(system.LOG_ROOT).catch(() => null),
			system.errors({ status: "open", size: 10 }).catch(() => ({ stats: {} })),
		]);
		const perf = system.performance();
		const errors_day = timeline.slice(-24).reduce((s, x) => s + x.n, 0);
		return {
			ok: true,
			...overview,
			queues,
			jobs,
			files,
			timeline,
			errors_day,
			logs_size,
			error_groups: errs.stats || {},
			errors_missing: !!errs.missing,
			loop: perf.loop,
			pools: perf.pools,
			minutes: perf.minutes,
			started_at: perf.started_at,
		};
	})
);

/* ─── Черги ─── */

router.post(
	"/api/settings/system/queue/",
	auth.isAuthenticated,
	need("view"),
	raw(async (req) => {
		const b = req.body || {};
		return system.queueRows(String(b.key), String(b.status), parseInt(b.page, 10) || 1, parseInt(b.size, 10) || 50);
	})
);

router.post(
	"/api/settings/system/queue/retry/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const b = req.body || {};
		const r = await system.retryQueue(String(b.key), b.ids);
		audit.log(req, { action: "queue_retry", module: "system", entity: String(b.key), count: r.retried });
		return { ok: true, ...r };
	})
);

/* ─── Помилки (згруповані) ─── */

router.post("/api/settings/system/errors/", auth.isAuthenticated, need("view"), raw(async (req) => system.errors(req.body || {})));

router.post(
	"/api/settings/system/errors/:id/",
	auth.isAuthenticated,
	need("view"),
	handle(async (req) => {
		const id = parseInt(req.params.id, 10);
		if (!id) throw Object.assign(new Error("Bad id"), { status: 400 });
		return { ok: true, row: await system.errorDetail(id) };
	})
);

router.post(
	"/api/settings/system/errors-set/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const b = req.body || {};
		const r = await system.errorsSet(b.ids, String(b.status), userId(req));
		audit.log(req, { action: "errors_" + String(b.status), module: "system", entity: "system_errors", count: r.changed });
		return { ok: true, ...r };
	})
);

router.post(
	"/api/settings/system/errors-purge/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const r = await system.errorsPurge(parseInt((req.body || {}).days, 10) || 30);
		audit.log(req, { action: "errors_purge", module: "system", entity: "system_errors", count: r.deleted });
		return { ok: true, ...r };
	})
);

router.post(
	"/api/settings/system/errors-delete/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const r = await system.errorsDelete((req.body || {}).ids);
		audit.log(req, { action: "errors_delete", module: "system", entity: "system_errors", count: r.deleted });
		return { ok: true, ...r };
	})
);

/* ─── Журнали ─── */

router.post(
	"/api/settings/system/logs/",
	auth.isAuthenticated,
	need("view"),
	raw(async (req) => {
		const b = req.body || {};
		return system.logs(String(b.file), b);
	})
);

router.get("/api/settings/system/logs/download/", auth.isAuthenticated, need("view"), async (req, res) => {
	try {
		const key = String(req.query.file || "");
		const file = await system.logPath(key);
		res.download(file, key.replace(/[^\w.-]+/g, "_") + (file.endsWith(".jsonl") ? ".jsonl" : ".log"));
	} catch (e) {
		res.status(e.status || 500).type("text/plain; charset=utf-8").send(e.message);
	}
});

router.post(
	"/api/settings/system/logs/clear/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const key = String((req.body || {}).file || "");
		await system.clearLog(key);
		audit.log(req, { action: "log_clear", module: "system", entity: key, count: 1 });
		return { ok: true };
	})
);

/* ─── Продуктивність ─── */

router.post("/api/settings/system/performance/", auth.isAuthenticated, need("view"), handle(async () => ({ ok: true, ...system.performance() })));

// Деталі: маршрут (за ключем «METHOD /route»), SQL (за формою), окремі повільні записи журналу, усе по одному запиту
router.post("/api/settings/system/performance/route/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, row: system.routeDetail((req.body || {}).key) })));
router.post("/api/settings/system/performance/sql/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, row: system.sqlDetail((req.body || {}).sql) })));
router.post("/api/settings/system/performance/slow/", auth.isAuthenticated, need("view"), raw(async (req) => system.slowLog(req.body || {})));
router.post("/api/settings/system/trace/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, ...(await system.trace((req.body || {}).req_id)) })));

router.post(
	"/api/settings/system/performance/reset/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		system.resetMetrics();
		audit.log(req, { action: "metrics_reset", module: "system", entity: "metrics", count: 1 });
		return { ok: true };
	})
);

module.exports = router;