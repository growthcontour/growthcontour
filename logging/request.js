"use strict";

/**
 * HTTP-запит: id (X-Request-Id), контекст для журналу, метрики, запис повільних і невдалих запитів у logs/http.
 * Підключається першим middleware після helmet. Статика (/assets, /uploads) — без обліку.
 */
const crypto = require("crypto");
const logging = require("./logging");
const metrics = require("./metrics");

const SLOW_MS = parseInt(process.env.LOG_SLOW_REQUEST_MS, 10) || 1500;
const SKIP = /^\/(assets|uploads|favicon\.ico|sw-push\.js|socket\.io)(\/|$)/;
// Значення параметрів запиту не пишемо (там бувають токени відновлення кошика, ключі вебхуків)
const safeUrl = (u) => {
	const i = u.indexOf("?");
	return (i < 0 ? u : u.slice(0, i) + "?" + u.slice(i + 1).replace(/=([^&]*)/g, "=…")).slice(0, 300);
};

module.exports = function requestContext(req, res, next) {
	if (SKIP.test(req.path)) return next();
	const incoming = String(req.get("x-request-id") || "").replace(/[^\w-]/g, "").slice(0, 64);
	const id = incoming || crypto.randomUUID();
	res.setHeader("X-Request-Id", id);
	req.id = id;
	const store = { id, method: req.method, url: safeUrl(req.originalUrl || req.url), req };
	const start = process.hrtime.bigint();

	res.on("finish", () => {
		const ms = Number(process.hrtime.bigint() - start) / 1e6;
		const status = res.statusCode;
		// Шаблон маршруту; не знайдено — 404 без розсипання статистики на кожен URL
		const route = req.route ? (req.baseUrl || "") + req.route.path : status === 404 ? "(404)" : "(middleware)";
		const u = req.user;
		const userId = u ? u.userId || u.id || null : null;
		const size = Number(res.getHeader("content-length")) || 0;
		const sqlCount = store.sqlCount || 0;
		const sqlMs = Math.round(store.sqlMs || 0);
		metrics.request({ route, method: req.method, status, ms, url: store.url, req_id: id, user_id: userId, ip: req.ip, sql_count: sqlCount, sql_ms: sqlMs, size });
		if (status >= 500 || ms >= SLOW_MS) {
			logging.http(
				{
					level: status >= 500 ? "error" : "warn",
					req_id: id,
					method: req.method,
					url: store.url,
					route,
					status,
					ms: Math.round(ms),
					user_id: userId,
					ip: req.ip,
					ua: String(req.get("user-agent") || "").slice(0, 200),
					size: size || undefined,
					sql_count: sqlCount,
					sql_ms: sqlMs,
				},
				status >= 500 ? "request failed" : "slow request"
			);
		}
	});
	logging.context.run(store, next);
};