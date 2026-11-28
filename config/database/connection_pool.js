const mysql = require("mysql2/promise");
const logging = require("../../logging/logging");
const metrics = require("../../logging/metrics");

// Якщо DB_HOST — це шлях до .sock, підключаємось через сокет, інакше через TCP
const isSocket = String(process.env.DB_HOST || "").startsWith("/");
// Поріг повільного SQL (мс): такі запити — у logs/http і в «Стан системи» → «Запити»
const SLOW_SQL_MS = parseInt(process.env.LOG_SLOW_SQL_MS, 10) || 1000;

const pool = mysql.createPool({
	...(isSocket ? { socketPath: process.env.DB_HOST } : { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306) }),
	user: process.env.DB_USER,
	database: process.env.DB_NAME,
	password: process.env.DB_PASSWORD,
	waitForConnections: true,
	connectionLimit: 50,
	queueLimit: 500,
	enableKeepAlive: true,
	keepAliveInitialDelay: 0,
	dateStrings: true,
});

// ── Діагностика: стан пулу — лічильники для сторінки «Стан системи» (без запису кожного acquire/release у журнал) ──
const inner = pool.pool;
metrics.registerPool("promise", () => ({
	all: inner._allConnections.length,
	free: inner._freeConnections.length,
	queue: inner._connectionQueue.length,
	limit: inner.config.connectionLimit,
}));
// Черга очікування з'єднання — ознака перевантаження; попередження не частіше разу на хвилину
let enqueueWarnAt = 0;
inner.on("enqueue", () => {
	if (Date.now() - enqueueWarnAt < 60000) return;
	enqueueWarnAt = Date.now();
	logging.warn({ module: "db", pool: "promise", queue: inner._connectionQueue.length }, "pool exhausted: waiting for free connection");
});

/**
 * Час кожного SQL: метрики (статистика за формою запиту), лічильник SQL поточного HTTP-запиту (скільки запитів і часу в базі),
 * повільні — у журнал HTTP з текстом (без значень параметрів) і номером запиту.
 */
const textOf = (sql) => (typeof sql === "string" ? sql : sql && sql.sql) || "";
function timed(target, method) {
	const orig = target[method];
	target[method] = async function (sql, ...rest) {
		const t = process.hrtime.bigint();
		const ctx = logging.context.getStore();
		const done = (failed, err) => {
			const ms = Number(process.hrtime.bigint() - t) / 1e6;
			if (ctx) {
				ctx.sqlCount = (ctx.sqlCount || 0) + 1;
				ctx.sqlMs = (ctx.sqlMs || 0) + ms;
			}
			const slow = !failed && ms >= SLOW_SQL_MS;
			metrics.sql(textOf(sql), ms, slow, failed, ctx, err ? String(err.code || "") + " " + String(err.message || "").slice(0, 300) : null);
			if (slow) logging.http({ level: "warn", module: "db", ms: Math.round(ms), sql: metrics.sqlShape(textOf(sql)), req_id: ctx && ctx.id, url: ctx && ctx.url }, "slow sql");
		};
		try {
			const r = await orig.call(this, sql, ...rest);
			done(false);
			return r;
		} catch (e) {
			done(true, e);
			throw e;
		}
	};
}
timed(pool, "query");
timed(pool, "execute");
// З'єднання з getConnection (транзакції) — та сама обгортка
const getConnection = pool.getConnection.bind(pool);
pool.getConnection = async function () {
	const conn = await getConnection();
	if (!conn.__timed) {
		timed(conn, "query");
		timed(conn, "execute");
		conn.__timed = true;
	}
	return conn;
};

module.exports = pool;