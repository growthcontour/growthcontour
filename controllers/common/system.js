"use strict";

/**
 * Стан системи: сервер і база, черги обміну (з повтором невдалих), фонові задачі,
 * журнали (logs/app|error|http — денні файли pino, покинуті кошики JSONL, старі logging/logs),
 * згруповані помилки (system_errors), продуктивність (метрики процесу: маршрути, SQL, event loop, пули).
 */
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;
const ROOT = path.resolve(__dirname, "..", "..");
const STARTED_AT = new Date(Date.now() - process.uptime() * 1000);

const httpErr = (status, message) => Object.assign(new Error(message), { status });

/* ─── Черги ─── */

// key → таблиця, дата постановки, поле зовнішнього номера, як «штовхнути» обробник після повтору
const QUEUES = {
	orders_inbox: { table: "orders_inbox", date: "received_at", ref: "external_id", kick: () => require("../orders/inboxProcessor").kickWorker() },
	orders_outbox: { table: "orders_outbox", date: "date_add", ref: "external_id", kick: () => require("../orders/outboxProcessor").kickOutbox() },
	cart_inbox: { table: "orders_abandoned_cart_inbox", date: "received_at", ref: "external_id", kick: () => require("../orders/cartInboxProcessor").kickCartWorker() },
	cart_queue: { table: "orders_abandoned_cart_queue", date: "run_after", ref: "cart_id", kick: () => require("../orders/cartSendWorker").kickCartSendWorker() },
	messages: { table: "orders_messages", date: "date_add", ref: "id_order", kick: null },
};

async function queues() {
	const out = [];
	for (const [key, q] of Object.entries(QUEUES)) {
		try {
			const [rows] = await pool.query(
				`SELECT status, COUNT(*) AS n, MIN(${q.date}) AS oldest, SUM(${q.date} > NOW() - INTERVAL 1 DAY) AS day
				   FROM ${P}${q.table} GROUP BY status`
			);
			const by = Object.fromEntries(rows.map((r) => [r.status, { n: Number(r.n), oldest: r.oldest, day: Number(r.day) || 0 }]));
			const pending = by.pending || { n: 0, oldest: null };
			out.push({
				key,
				exists: true,
				statuses: by,
				pending: pending.n,
				processing: (by.processing || {}).n || 0,
				failed: (by.failed || {}).n || 0,
				failed_day: (by.failed || {}).day || 0,
				// Найстаріше в черзі — ознака, що обробник зупинився
				pending_age_min: pending.oldest ? Math.max(0, Math.round((Date.now() - new Date(pending.oldest).getTime()) / 60000)) : 0,
			});
		} catch (e) {
			if (e.code !== "ER_NO_SUCH_TABLE") throw e;
			out.push({ key, exists: false });
		}
	}
	return out;
}

async function queueRows(key, status, page = 1, size = 50) {
	const q = QUEUES[key];
	if (!q) throw httpErr(400, "Unknown queue");
	const st = ["pending", "processing", "failed", "done", "sent", "skipped"].includes(status) ? status : "failed";
	const lim = Math.min(200, Math.max(10, size));
	const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${P}${q.table} WHERE status = ?`, [st]);
	const [rows] = await pool.query(
		`SELECT id, ${q.ref} AS ref, status, attempts, last_error, ${q.date} AS date FROM ${P}${q.table} WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
		[st, lim, (Math.max(1, page) - 1) * lim]
	);
	return { last_page: Math.max(1, Math.ceil(total / lim)), total, data: rows };
}

/** Невдалі — знову в чергу (спроби з нуля); ids — лише вибрані */
async function retryQueue(key, ids) {
	const q = QUEUES[key];
	if (!q) throw httpErr(400, "Unknown queue");
	const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => n > 0);
	const extra = key === "messages" ? ", next_at = NOW()" : key === "cart_queue" ? ", run_after = NOW()" : "";
	const [r] = await pool.query(
		`UPDATE ${P}${q.table} SET status = 'pending', attempts = 0, last_error = NULL, locked_at = NULL${extra} WHERE status = 'failed'${list.length ? " AND id IN (?)" : ""}`,
		list.length ? [list] : []
	);
	if (r.affectedRows && q.kick) q.kick();
	return { retried: r.affectedRows };
}

/* ─── Сервер, база, фонові задачі ─── */

async function overview() {
	const mem = process.memoryUsage();
	const t0 = Date.now();
	const [[db]] = await pool.query(
		`SELECT VERSION() AS version, NOW() AS now, @@time_zone AS tz, @@max_connections AS max_conn,
		        (SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE DB = DATABASE()) AS connections,
		        (SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()) AS size,
		        (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()) AS tables`
	);
	const latency = Date.now() - t0;
	let disk = null;
	try {
		const s = await fsp.statfs(ROOT);
		disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
	} catch {
		// statfs недоступний у старих Node
	}
	return {
		server: {
			node: process.version,
			env: process.env.NODE_ENV || "development",
			pid: process.pid,
			host: os.hostname(),
			platform: `${os.type()} ${os.release()}`,
			started_at: STARTED_AT,
			uptime_sec: Math.round(process.uptime()),
			os_uptime_sec: Math.round(os.uptime()),
			cpus: os.cpus().length,
			load: os.loadavg(),
			mem_total: os.totalmem(),
			mem_free: os.freemem(),
			rss: mem.rss,
			heap_used: mem.heapUsed,
			heap_total: mem.heapTotal,
			disk,
		},
		db: { ...db, latency_ms: latency, size: Number(db.size), tables: Number(db.tables), connections: Number(db.connections) },
	};
}

/** Останні запуски фонових задач (з таблиць, де вони лишають слід); відсутня таблиця — пропускаємо */
async function jobs() {
	const probes = [
		["np_directory", `SELECT finished_at AS last, message AS error, started_at FROM ${P}np_sync WHERE k = 'directory'`],
		["catalog_push", `SELECT date_add AS last, IF(errors > 0, message, NULL) AS error FROM ${P}products_sync_log ORDER BY id DESC LIMIT 1`],
		["rules", `SELECT date_add AS last, error FROM ${P}orders_rules_log ORDER BY id DESC LIMIT 1`],
		["messages", `SELECT sent_at AS last, NULL AS error FROM ${P}orders_messages WHERE status = 'sent' ORDER BY id DESC LIMIT 1`],
		["tokens_log", `SELECT MAX(date_add) AS last, NULL AS error FROM ${P}settings_integrations_tokens_log`],
		["audit", `SELECT MAX(date_add) AS last, NULL AS error FROM ${P}audit_log`],
	];
	const out = [];
	for (const [key, sql] of probes) {
		try {
			const [[r]] = await pool.query(sql);
			out.push({ key, last: r ? r.last : null, error: r ? r.error : null });
		} catch {
			out.push({ key, last: null, error: null, missing: true });
		}
	}
	return out;
}

/* ─── Журнали ─── */

const logging = require("../../logging/logging");
const metrics = require("../../logging/metrics");

const LEGACY_DIR = path.join(ROOT, "logging", "logs"); // старі error.log / info.log — до переходу на logs/
const CART_DIR = process.env.ABANDONED_CART_LOG_DIR || path.join(ROOT, "logs", "abandoned-cart");
const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.log$/;

/**
 * Усі файли журналів: { key, category, day, size, mtime }.
 * key: "app:2026-10-27" | "error:…" | "http:…" | "cart:…" | "legacy:error" — лише з цього списку можна читати (без довільних шляхів).
 */
async function logIndex() {
	const list = [];
	for (const cat of logging.CATEGORIES) {
		const dir = path.join(logging.ROOT, cat);
		const names = await fsp.readdir(dir).catch(() => []);
		for (const n of names) {
			const m = DAY_RE.exec(n);
			if (m) list.push({ key: `${cat}:${m[1]}`, category: cat, day: m[1], file: path.join(dir, n) });
		}
	}
	const carts = await fsp.readdir(CART_DIR).catch(() => []);
	for (const n of carts) {
		const m = /^abandoned-cart-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(n);
		if (m) list.push({ key: `cart:${m[1]}`, category: "cart", day: m[1], file: path.join(CART_DIR, n) });
	}
	for (const n of ["error", "info"]) list.push({ key: `legacy:${n}`, category: "legacy", day: n, file: path.join(LEGACY_DIR, n + ".log") });
	const out = [];
	for (const l of list) {
		const st = await fsp.stat(l.file).catch(() => null);
		if (st) out.push({ ...l, size: st.size, mtime: st.mtime });
	}
	out.sort((a, b) => a.category.localeCompare(b.category) || b.day.localeCompare(a.day));
	return out;
}

async function logFiles() {
	return (await logIndex()).map(({ file, ...x }) => x);
}

async function fileOf(key) {
	const f = (await logIndex()).find((x) => x.key === key);
	if (!f) throw httpErr(404, "Log not found");
	return f.file;
}

const TAIL_BYTES = 16 * 1024 * 1024; // читаємо лише хвіст великих файлів

async function readTail(file) {
	const st = await fsp.stat(file).catch(() => null);
	if (!st || !st.size) return { lines: [], truncated: false };
	const start = Math.max(0, st.size - TAIL_BYTES);
	const fh = await fsp.open(file, "r");
	try {
		const buf = Buffer.alloc(st.size - start);
		await fh.read(buf, 0, buf.length, start);
		const lines = buf.toString("utf8").split("\n");
		if (start > 0) lines.shift(); // перший рядок обрізаний
		return { lines: lines.filter(Boolean), truncated: start > 0 };
	} finally {
		await fh.close();
	}
}

/** Запис журналу → однаковий вигляд: час, рівень, модуль, текст, деталі */
function parseLine(line, i) {
	let o;
	try {
		o = JSON.parse(line);
	} catch {
		return { i, time: null, level: "raw", module: "", msg: line.slice(0, 2000), data: null };
	}
	const err = o.err || (o.type && o.stack ? o : null);
	const time = o.time ? new Date(o.time) : o.ts ? new Date(o.ts) : o.at ? new Date(o.at) : null;
	const level = typeof o.level === "number" ? logging.LEVELS[o.level] || String(o.level) : o.level || (o.result === "error" ? "error" : "info");
	const msg = o.msg || (err && err.message) || o.message || o.event || o.type || "";
	return {
		i,
		time,
		level,
		module: o.module || (o.provider ? "cart" : ""),
		msg: String(msg).slice(0, 2000),
		req_id: o.req_id || null,
		status: o.status || null,
		ms: o.ms || null,
		data: o,
	};
}

/**
 * Записи файлу журналу з фільтрами. f: { level, module, q, req_id, from, to (час ISO / дата), page, size }.
 * Новіші — першими. counts — за рівнями й модулями (для підказок фільтра).
 */
async function logs(key, f = {}) {
	const { lines, truncated } = await readTail(await fileOf(key));
	const needle = String(f.q || "").trim().toLowerCase();
	const level = String(f.level || "");
	const minLevel = level.startsWith(">=") ? level.slice(2) : null; // ">=warn" — від рівня й вище
	const order = ["trace", "debug", "info", "warn", "error", "fatal"];
	const module = String(f.module || "");
	const reqId = String(f.req_id || "").trim();
	const tFrom = f.from ? Date.parse(f.from) : null;
	const tTo = f.to ? Date.parse(f.to) + (String(f.to).length <= 10 ? 86399999 : 0) : null;
	const all = [];
	const counts = { levels: {}, modules: {} };
	for (let i = lines.length - 1; i >= 0; i--) {
		if (needle && !lines[i].toLowerCase().includes(needle)) continue;
		if (reqId && !lines[i].includes(reqId)) continue;
		const r = parseLine(lines[i], i);
		if ((tFrom || tTo) && r.time) {
			const t = r.time.getTime();
			if ((tFrom && t < tFrom) || (tTo && t > tTo)) continue;
		}
		counts.levels[r.level] = (counts.levels[r.level] || 0) + 1;
		if (r.module) counts.modules[r.module] = (counts.modules[r.module] || 0) + 1;
		if (level && !minLevel && r.level !== level) continue;
		if (minLevel && order.indexOf(r.level) < order.indexOf(minLevel)) continue;
		if (module && r.module !== module) continue;
		all.push(r);
	}
	const lim = Math.min(500, Math.max(10, parseInt(f.size, 10) || 50));
	const page = Math.max(1, parseInt(f.page, 10) || 1);
	return { last_page: Math.max(1, Math.ceil(all.length / lim)), total: all.length, truncated, counts, data: all.slice((page - 1) * lim, page * lim) };
}

async function logPath(key) {
	return fileOf(key);
}

/** Видалити файл журналу (поточний денний — лише очистити: у нього продовжують писати) */
async function clearLog(key) {
	const file = await fileOf(key);
	const [cat, day] = key.split(":");
	if (logging.CATEGORIES.includes(cat) && day === logging.today()) await fsp.truncate(file, 0);
	else if (cat === "legacy") await fsp.truncate(file, 0);
	else await fsp.unlink(file);
	return { ok: true };
}

/** Помилки по годинах за останні hours годин — з денних файлів logs/error */
async function errorsTimeline(hours = 48) {
	const since = Date.now() - hours * 3600000;
	const idx = (await logIndex()).filter((x) => x.category === "error" && Date.parse(x.day) >= since - 86400000 * 2);
	const buckets = new Map();
	for (const f of idx) {
		const { lines } = await readTail(f.file);
		for (const l of lines) {
			const r = parseLine(l, 0);
			if (!r.time || r.time.getTime() < since) continue;
			const h = Math.floor(r.time.getTime() / 3600000) * 3600000;
			buckets.set(h, (buckets.get(h) || 0) + 1);
		}
	}
	const out = [];
	const start = Math.floor(since / 3600000) * 3600000;
	for (let h = start; h <= Date.now(); h += 3600000) out.push({ t: h, n: buckets.get(h) || 0 });
	return out;
}

async function errorsToday() {
	return (await errorsTimeline(24)).reduce((s, x) => s + x.n, 0);
}

/** Розмір теки журналів (з підтеками) */
async function dirSize(dir) {
	let total = 0;
	const walk = async (d) => {
		for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
		}
	};
	await walk(dir);
	return total;
}

/* ─── Згруповані помилки (system_errors) ─── */

const ERR_STATUSES = ["open", "resolved", "ignored"];

/** Tabulator remote. f: { status, q, module, level, page, size, sort } */
async function errors(f = {}) {
	const where = [];
	const params = [];
	if (ERR_STATUSES.includes(f.status)) {
		where.push("status = ?");
		params.push(f.status);
	}
	if (f.module) {
		where.push("module = ?");
		params.push(String(f.module));
	}
	if (f.level === "fatal") where.push("level = 'fatal'");
	const q = String(f.q || "").trim().slice(0, 100);
	if (q) {
		where.push("(message LIKE ? OR frame LIKE ? OR type LIKE ?)");
		const like = "%" + q.replace(/[%_\\]/g, "\\$&") + "%";
		params.push(like, like, like);
	}
	const w = where.length ? "WHERE " + where.join(" AND ") : "";
	const sort = { last: "last_seen DESC", count: "count DESC", first: "first_seen DESC" }[f.sort] || "last_seen DESC";
	const lim = Math.min(200, Math.max(10, parseInt(f.size, 10) || 50));
	const page = Math.max(1, parseInt(f.page, 10) || 1);
	try {
		const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${P}system_errors ${w}`, params);
		const [rows] = await pool.query(
			`SELECT id, level, module, message, frame, type, count, first_seen, last_seen, status, resolved_at
			   FROM ${P}system_errors ${w} ORDER BY ${sort} LIMIT ? OFFSET ?`,
			[...params, lim, (page - 1) * lim]
		);
		const [stat] = await pool.query(`SELECT status, COUNT(*) AS n, SUM(last_seen > NOW() - INTERVAL 1 DAY) AS day FROM ${P}system_errors GROUP BY status`);
		const [mods] = await pool.query(`SELECT module, COUNT(*) AS n FROM ${P}system_errors WHERE status = 'open' GROUP BY module ORDER BY n DESC LIMIT 50`);
		return {
			last_page: Math.max(1, Math.ceil(total / lim)),
			total,
			stats: Object.fromEntries(stat.map((s) => [s.status, { n: Number(s.n), day: Number(s.day) || 0 }])),
			modules: mods.map((m) => m.module),
			data: rows,
		};
	} catch (e) {
		if (e.code === "ER_NO_SUCH_TABLE") return { last_page: 1, total: 0, stats: {}, modules: [], data: [], missing: true };
		throw e;
	}
}

async function errorDetail(id) {
	const [[r]] = await pool.query(
		`SELECT e.*, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS resolved_name
		   FROM ${P}system_errors e LEFT JOIN ${P}users u ON u.id = e.resolved_by WHERE e.id = ?`,
		[id]
	);
	if (!r) throw httpErr(404, "Not found");
	let context = null;
	try {
		context = r.context ? JSON.parse(r.context) : null;
	} catch {
		context = r.context;
	}
	return { ...r, context };
}

/** Позначити помилки: resolved — виправлено (повтор відкриє знову), ignored — не показувати серед відкритих, open — повернути */
async function errorsSet(ids, status, idUser) {
	if (!ERR_STATUSES.includes(status)) throw httpErr(400, "Bad status");
	const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => n > 0).slice(0, 1000);
	if (!list.length) return { changed: 0 };
	const [r] = await pool.query(
		`UPDATE ${P}system_errors SET status = ?, resolved_by = ?, resolved_at = IF(? = 'open', NULL, NOW()) WHERE id IN (?)`,
		[status, status === "open" ? null : idUser || null, status, list]
	);
	return { changed: r.affectedRows };
}

/** Видалити позначені виправленими / проігнорованими давніше days днів */
async function errorsPurge(days = 30) {
	const [r] = await pool.query(`DELETE FROM ${P}system_errors WHERE status <> 'open' AND last_seen < NOW() - INTERVAL ? DAY`, [Math.max(1, days)]);
	return { deleted: r.affectedRows };
}

/** Видалити вибрані помилки (будь-якого статусу) */
async function errorsDelete(ids) {
	const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => n > 0).slice(0, 1000);
	if (!list.length) return { deleted: 0 };
	const [r] = await pool.query(`DELETE FROM ${P}system_errors WHERE id IN (?)`, [list]);
	return { deleted: r.affectedRows };
}

/* ─── Продуктивність ─── */

/** Зведення: маршрути — за сумарним часом (що найбільше навантажує), SQL — так само */
function performance() {
	const m = metrics.snapshot();
	return { ...m, routes: m.routes.sort((a, b) => b.total_sec - a.total_sec || b.count - a.count), sql: m.sql.sort((a, b) => b.total_sec - a.total_sec || b.max - a.max) };
}

function routeDetail(key) {
	const r = metrics.routeDetail(String(key || ""));
	if (!r) throw httpErr(404, "Not found");
	return r;
}

function sqlDetail(shape) {
	const r = metrics.sqlDetail(String(shape || ""));
	if (!r) throw httpErr(404, "Not found");
	return r;
}

/**
 * Окремі повільні й невдалі запити з журналу logs/http за день (кожен — з усіма полями).
 * f: { day, kind: "request" | "sql" | "", q, min_ms, page, size }
 */
async function slowLog(f = {}) {
	const day = /^\d{4}-\d{2}-\d{2}$/.test(f.day || "") ? f.day : logging.today();
	const file = path.join(logging.ROOT, "http", day + ".log");
	const { lines, truncated } = await readTail(file);
	const needle = String(f.q || "").trim().toLowerCase();
	const minMs = Math.max(0, parseInt(f.min_ms, 10) || 0);
	const out = [];
	for (let i = lines.length - 1; i >= 0; i--) {
		if (needle && !lines[i].toLowerCase().includes(needle)) continue;
		let o;
		try {
			o = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		const isSql = o.module === "db";
		if (f.kind === "sql" && !isSql) continue;
		if (f.kind === "request" && isSql) continue;
		if ((o.ms || 0) < minMs) continue;
		out.push({ i, time: o.time, kind: isSql ? "sql" : "request", level: logging.LEVELS[o.level] || o.level, ms: o.ms || 0, status: o.status || null, method: o.method || null, url: o.url || null, route: o.route || null, sql: o.sql || null, req_id: o.req_id || null, user_id: o.user_id || null, ip: o.ip || null, sql_count: o.sql_count ?? null, sql_ms: o.sql_ms ?? null, size: o.size || null, ua: o.ua || null, msg: o.msg || "" });
	}
	const lim = Math.min(500, Math.max(10, parseInt(f.size, 10) || 50));
	const page = Math.max(1, parseInt(f.page, 10) || 1);
	return { last_page: Math.max(1, Math.ceil(out.length / lim)), total: out.length, truncated, day, data: out.slice((page - 1) * lim, page * lim) };
}

/** Усе, що відбувалось у межах одного HTTP-запиту (req_id): журнал app і http за сьогодні й учора, за часом */
async function trace(reqId) {
	const id = String(reqId || "").replace(/[^\w-]/g, "").slice(0, 64);
	if (!id) throw httpErr(400, "Bad id");
	const days = [logging.today(), new Date(Date.now() - 86400000).toISOString().slice(0, 10)];
	const out = [];
	for (const cat of ["app", "http"]) {
		for (const d of days) {
			const { lines } = await readTail(path.join(logging.ROOT, cat, d + ".log"));
			for (const l of lines) {
				if (!l.includes(id)) continue;
				const r = parseLine(l, 0);
				if (r.req_id === id || (r.data && r.data.req_id === id)) out.push({ ...r, category: cat });
			}
		}
	}
	out.sort((a, b) => (a.time && b.time ? a.time - b.time : 0));
	return { req_id: id, rows: out.slice(0, 500) };
}

module.exports = {
	overview,
	queues,
	queueRows,
	retryQueue,
	jobs,
	logFiles,
	logs,
	logPath,
	clearLog,
	errorsToday,
	errorsTimeline,
	dirSize,
	errors,
	errorDetail,
	errorsSet,
	errorsPurge,
	errorsDelete,
	performance,
	resetMetrics: metrics.reset,
	routeDetail,
	sqlDetail,
	slowLog,
	trace,
	QUEUES,
	LOG_ROOT: logging.ROOT,
};