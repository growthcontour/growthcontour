"use strict";

/**
 * Метрики процесу в пам'яті (з моменту запуску): HTTP-запити за маршрутами, SQL, затримка event loop, пули з'єднань.
 * Нічого не пише в базу — лише лічильники; сторінка «Стан системи» читає snapshot().
 *
 * Похвилинна історія — кільце на 120 хвилин: запити, помилки 5xx, середній / максимальний час, SQL і повільні SQL.
 * Маршрут — шаблон Express (/api/orders/:id/), а не конкретний URL, щоб статистика не розсипалась на тисячі рядків.
 */
const { monitorEventLoopDelay } = require("perf_hooks");

const MINUTES = 120;
const MAX_ROUTES = 1000;
const MAX_SQL = 300;
const BUCKETS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, Infinity]; // мс — для p95 без зберігання кожного запиту

const startedAt = Date.now();
const minute = () => Math.floor(Date.now() / 60000);

function emptyMinute(m) {
	return { m, req: 0, err5: 0, err4: 0, ms: 0, max: 0, sql: 0, sql_slow: 0, sql_ms: 0, errors: 0 };
}
const ring = [];
function bucket() {
	const m = minute();
	let last = ring[ring.length - 1];
	if (!last || last.m !== m) {
		// Пропущені хвилини — нулями, щоб графік не «склеював» простої
		const from = last ? last.m + 1 : m;
		for (let x = Math.max(from, m - MINUTES + 1); x <= m; x++) ring.push(emptyMinute(x));
		while (ring.length > MINUTES) ring.shift();
		last = ring[ring.length - 1];
	}
	return last;
}

const routes = new Map();
const sqlStats = new Map();
const pools = new Map();
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

function hist() {
	return BUCKETS.map(() => 0);
}
function pctl(h, total, p) {
	if (!total) return 0;
	let acc = 0;
	for (let i = 0; i < h.length; i++) {
		acc += h[i];
		if (acc / total >= p) return BUCKETS[i] === Infinity ? BUCKETS[i - 1] * 2 : BUCKETS[i];
	}
	return 0;
}

/** Завершений HTTP-запит */
function request({ route, method, status, ms }) {
	const b = bucket();
	b.req++;
	b.ms += ms;
	if (ms > b.max) b.max = ms;
	if (status >= 500) b.err5++;
	else if (status >= 400) b.err4++;

	const key = method + " " + route;
	let r = routes.get(key);
	if (!r) {
		if (routes.size >= MAX_ROUTES) return;
		r = { route, method, count: 0, err5: 0, err4: 0, ms: 0, max: 0, h: hist(), last: 0 };
		routes.set(key, r);
	}
	r.count++;
	r.ms += ms;
	r.last = Date.now();
	if (ms > r.max) r.max = ms;
	if (status >= 500) r.err5++;
	else if (status >= 400) r.err4++;
	r.h[BUCKETS.findIndex((x) => ms <= x)]++;
}

/** SQL без значень: числа й рядки → ?, пробіли стиснуті */
function sqlShape(sql) {
	return String(sql || "")
		.replace(/'(?:[^'\\]|\\.)*'/g, "?")
		.replace(/\b\d+(\.\d+)?\b/g, "?")
		.replace(/\(\s*\?(\s*,\s*\?)+\s*\)/g, "(?…)")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 500);
}

/** Виконаний SQL; slow — перевищено поріг */
function sql(text, ms, slow, failed) {
	const b = bucket();
	b.sql++;
	b.sql_ms += ms;
	if (slow) b.sql_slow++;
	if (!slow && !failed) return;
	const key = sqlShape(text);
	let s = sqlStats.get(key);
	if (!s) {
		if (sqlStats.size >= MAX_SQL) return;
		s = { sql: key, count: 0, failed: 0, ms: 0, max: 0, last: 0 };
		sqlStats.set(key, s);
	}
	s.count++;
	if (failed) s.failed++;
	s.ms += ms;
	s.last = Date.now();
	if (ms > s.max) s.max = ms;
}

/** Помилка в журналі (рахує logging через errorStore не можна — там групування; тут — просто кількість) */
function error() {
	bucket().errors++;
}

/** Пул з'єднань: name → () => { all, free, queue, limit } */
function registerPool(name, read) {
	pools.set(name, read);
}

function snapshot() {
	bucket();
	const r = [...routes.values()].map((x) => ({
		method: x.method,
		route: x.route,
		count: x.count,
		err5: x.err5,
		err4: x.err4,
		avg: x.count ? Math.round(x.ms / x.count) : 0,
		p95: pctl(x.h, x.count, 0.95),
		max: Math.round(x.max),
		total_sec: Math.round(x.ms / 1000),
		last: x.last,
	}));
	const s = [...sqlStats.values()].map((x) => ({ ...x, avg: x.count ? Math.round(x.ms / x.count) : 0, max: Math.round(x.max) }));
	const poolState = {};
	for (const [name, read] of pools) {
		try {
			poolState[name] = read();
		} catch {
			poolState[name] = null;
		}
	}
	return {
		started_at: startedAt,
		minutes: ring.map((b) => ({ ...b, avg: b.req ? Math.round(b.ms / b.req) : 0, max: Math.round(b.max), sql_avg: b.sql ? Math.round(b.sql_ms / b.sql) : 0 })),
		routes: r,
		sql: s,
		loop: { mean: Math.round(loop.mean / 1e6) || 0, p99: Math.round(loop.percentile(99) / 1e6) || 0, max: Math.round(loop.max / 1e6) || 0 },
		pools: poolState,
	};
}

/** Скинути накопичене (маршрути, SQL, event loop) */
function reset() {
	routes.clear();
	sqlStats.clear();
	loop.reset();
}

module.exports = { request, sql, error, registerPool, snapshot, reset, sqlShape };