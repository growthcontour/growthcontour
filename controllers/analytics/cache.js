"use strict";

/**
 * Кеш аналітики: сторінки читають готові дані, а не рахують їх на кожен запит.
 *
 * Як працює:
 *  - Типові фільтри (усі сайти; сьогодні / 7 / 30 / 90 / 365 днів; по днях) рахуються у фоні заздалегідь («прогрів»)
 *    і зберігаються в базі (analytics_cache) — після перезапуску сервера дані є одразу.
 *  - Повний прогрів — щодня вночі (після перерахунку денних агрегатів) і вручну кнопкою «Оновити дані».
 *    Короткі періоди (сьогодні / 7 днів) — щогодини, бо вони змінюються протягом дня.
 *  - Нестандартний фільтр (інший сайт, свої дати) рахується при першому запиті й живе в пам'яті ANALYTICS_CACHE_TTL_MIN хвилин.
 *  - Однакові одночасні запити не рахуються двічі (спільний проміс); обчислень одночасно — не більше CONCURRENCY,
 *    решта чекає в черзі — 10 менеджерів на сторінці не покладуть базу.
 *
 * Відповідь: { data, built_at, cached } — сторінка показує, на який час дані.
 */
const crypto = require("crypto");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging").child("analytics");
const sales = require("./sales");
const reports = require("./reports");

const P = config.get("configDatabase").prefix;
const CONCURRENCY = Math.max(1, parseInt(process.env.ANALYTICS_CONCURRENCY, 10) || 2);
const TTL_MS = (parseInt(process.env.ANALYTICS_CACHE_TTL_MIN, 10) || 60) * 60000;
const MEM_MAX = 500;
const PRESETS = [1, 7, 30, 90, 365]; // днів, як кнопки на сторінках
const HOURLY_PRESETS = [1, 7];

/**
 * Розділи: обчислення й від чого залежить результат (extra — додаткові параметри ключа).
 * lang: true — назви статусів мовою користувача.
 */
const SECTIONS = {
	summary: { fn: (f) => sales.summary(f) },
	timeseries: { fn: (f) => sales.timeseries(f) },
	statuses: { fn: (f, x) => sales.statuses(f, x.lang), lang: true },
	channels: { fn: (f) => sales.channels(f) },
	top_products: { fn: (f) => sales.topProducts(f) },
	funnel: { fn: (f, x) => sales.funnel(f, x.lang), lang: true },
	carts: { fn: (f) => sales.carts(f) },
	health: { fn: (f) => sales.health(f) },
	delivery: { fn: (f) => reports.delivery(f) },
	clients: { fn: (f) => reports.clients(f) },
	managers: { fn: (f) => reports.managers(f) },
	heatmap: { fn: (f) => reports.heatmap(f) },
	automation: { fn: (f) => reports.automation(f) },
	returns: { fn: (f) => reports.returns(f) },
	products: { fn: (f, x) => reports.products(f, x.group, x.lang), lang: true, group: true },
};
const GROUPS = ["product", "category", "brand", "site"];

/** Ключ: розділ + нормалізований фільтр + лише ті параметри, від яких розділ залежить */
function keyOf(name, f, x) {
	const s = SECTIONS[name];
	const parts = [name, f.date_from, f.date_to, f.integrations ? f.integrations.join(",") : "all", f.granularity, f.split_by_integration ? 1 : 0, s.lang ? x.lang : "", s.group ? x.group : ""];
	return { key: crypto.createHash("sha1").update(parts.join("|")).digest("hex"), params: { name, ...f, ...(s.lang ? { lang: x.lang } : {}), ...(s.group ? { group: x.group } : {}) } };
}

/* ─── Пам'ять + обмеження одночасних обчислень ─── */

const mem = new Map(); // key → { data, built_at, expires, pinned }
const inflight = new Map(); // key → Promise
let running = 0;
const waiting = [];

function limit(fn) {
	return new Promise((resolve, reject) => {
		const run = () => {
			running++;
			Promise.resolve()
				.then(fn)
				.then(resolve, reject)
				.finally(() => {
					running--;
					if (waiting.length) waiting.shift()();
				});
		};
		running < CONCURRENCY ? run() : waiting.push(run);
	});
}

function remember(key, entry) {
	mem.delete(key);
	mem.set(key, entry);
	// Витісняємо найстаріші непрогріті
	if (mem.size > MEM_MAX) {
		for (const [k, v] of mem) {
			if (mem.size <= MEM_MAX) break;
			if (!v.pinned) mem.delete(k);
		}
	}
}

async function persist(key, params, entry, ms) {
	await pool.query(
		`INSERT INTO ${P}analytics_cache (cache_key, name, params, payload, built_at, ms) VALUES (?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE payload = VALUES(payload), built_at = VALUES(built_at), ms = VALUES(ms), params = VALUES(params)`,
		[key, params.name, JSON.stringify(params), JSON.stringify(entry.data), entry.built_at, ms]
	);
}

/** Обчислити й покласти в кеш. pinned — прогрів (живе до наступного прогріву, зберігається в базі) */
function compute(name, f, x, { pinned = false } = {}) {
	const { key, params } = keyOf(name, f, x);
	if (inflight.has(key)) return inflight.get(key);
	const p = limit(async () => {
		const t = Date.now();
		const data = await SECTIONS[name].fn(f, x);
		const ms = Date.now() - t;
		const entry = { data, built_at: new Date(), expires: pinned ? Infinity : Date.now() + TTL_MS, pinned };
		remember(key, entry);
		if (pinned) await persist(key, params, entry, ms).catch((e) => logging.warn({ err: e }, "cache persist failed"));
		if (ms > 5000) logging.warn({ section: name, ms, params }, "slow analytics section");
		return entry;
	}).finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}

/**
 * Дані розділу. body — фільтр сторінки; x: { lang, group }.
 * fresh — перерахувати, навіть якщо є в кеші (кнопка «Оновити» для власного фільтра).
 */
async function get(name, body, x = {}, { fresh = false } = {}) {
	if (!SECTIONS[name]) throw Object.assign(new Error("Unknown section"), { status: 404 });
	const f = sales.parseFilters(body);
	const ex = { lang: parseInt(x.lang, 10) || 1, group: GROUPS.includes(x.group) ? x.group : "product" };
	const { key } = keyOf(name, f, ex);
	const hit = mem.get(key);
	if (hit && !fresh && hit.expires > Date.now()) return { data: hit.data, built_at: hit.built_at, cached: true };
	const e = await compute(name, f, ex, { pinned: !!(hit && hit.pinned) });
	return { data: e.data, built_at: e.built_at, cached: false };
}

/* ─── Прогрів ─── */

const state = { running: false, total: 0, done: 0, failed: 0, started_at: null, finished_at: null, kind: null, last_error: null };

/** Мови, якими користуються (назви статусів) */
async function langs() {
	const [rows] = await pool.query(`SELECT DISTINCT COALESCE(id_lang, 1) AS l FROM ${P}users`).catch(() => [[{ l: 1 }]]);
	return [...new Set(rows.map((r) => Number(r.l) || 1))];
}

/** Набір прогріву: presets днів × усі розділи (короткі — лише продажі, решта на них не дивиться) */
async function plan(presets) {
	const to = sales.today();
	const ls = await langs();
	const jobs = [];
	for (const days of presets) {
		const f = sales.parseFilters({ date_from: sales.addDays(to, -(days - 1)), date_to: to, granularity: "day" });
		for (const name of Object.keys(SECTIONS)) {
			const s = SECTIONS[name];
			for (const lang of s.lang ? ls : [1]) {
				for (const group of s.group ? ["product"] : [null]) jobs.push({ name, f, x: { lang, group: group || "product" } });
			}
		}
	}
	return jobs;
}

/**
 * Прогріти кеш. kind: "full" (усі періоди) | "hourly" (сьогодні й 7 днів).
 * Повертається одразу, якщо прогрів уже йде. Помилка одного розділу не зупиняє інші.
 */
async function warm(kind = "full") {
	if (state.running) return state;
	Object.assign(state, { running: true, kind, done: 0, failed: 0, started_at: new Date(), finished_at: null, last_error: null });
	try {
		const jobs = await plan(kind === "hourly" ? HOURLY_PRESETS : PRESETS);
		state.total = jobs.length;
		// Повний прогрів — старі непрогріті (свої фільтри) застаріли разом із даними
		if (kind === "full") for (const [k, v] of mem) if (!v.pinned) mem.delete(k);
		for (const j of jobs) {
			try {
				await compute(j.name, j.f, j.x, { pinned: true });
				state.done++;
			} catch (e) {
				state.failed++;
				state.last_error = e.message;
				logging.error({ err: e, section: j.name }, "analytics warm failed");
			}
		}
		// Прогріте за минулі дати (вчорашні «30 днів» тощо) — прибрати з пам'яті й бази
		if (kind === "full") {
			for (const [k, v] of mem) if (v.pinned && v.built_at < state.started_at) mem.delete(k);
			await pool.query(`DELETE FROM ${P}analytics_cache WHERE built_at < ? - INTERVAL 1 HOUR`, [state.started_at]).catch(() => {});
		}
		logging.info({ kind, total: state.total, failed: state.failed, sec: Math.round((Date.now() - state.started_at) / 1000) }, "analytics cache warmed");
	} catch (e) {
		state.last_error = e.message;
		logging.error({ err: e }, "analytics warm failed");
	} finally {
		state.running = false;
		state.finished_at = new Date();
	}
	return state;
}

/** Після перезапуску — прогріте з бази (свіже за добу); немає — повний прогрів у фоні */
async function load() {
	try {
		const [rows] = await pool.query(`SELECT cache_key, payload, built_at FROM ${P}analytics_cache WHERE built_at > NOW() - INTERVAL 1 DAY`);
		for (const r of rows) {
			try {
				remember(r.cache_key, { data: JSON.parse(r.payload), built_at: new Date(r.built_at), expires: Infinity, pinned: true });
			} catch {
				// пошкоджений запис — перерахується
			}
		}
		logging.info({ entries: rows.length }, "analytics cache loaded");
		if (!rows.length) warm("full");
	} catch (e) {
		if (e.code === "ER_NO_SUCH_TABLE") logging.warn("analytics_cache table is missing — cache works in memory only");
		else logging.error({ err: e }, "analytics cache load failed");
		warm("full");
	}
}

function status() {
	let pinned = 0;
	for (const v of mem.values()) if (v.pinned) pinned++;
	const builts = [...mem.values()].filter((v) => v.pinned).map((v) => +v.built_at);
	return { ...state, entries: mem.size, pinned, queue: waiting.length, computing: running, oldest: builts.length ? new Date(Math.min(...builts)) : null };
}

module.exports = { get, warm, load, status, SECTIONS, PRESETS };