"use strict";

/**
 * Єдиний журнал системи (pino).
 *
 * Куди пишеться (корінь — LOG_DIR, за замовчуванням ./logs; поруч живуть logs/abandoned-cart, історія змін тощо):
 *   logs/app/YYYY-MM-DD.log    — усе від рівня LOG_LEVEL (info): робота системи, попередження, помилки
 *   logs/error/YYYY-MM-DD.log  — лише error / fatal (критичне — окремо, щоб не губилось серед info)
 *   logs/http/YYYY-MM-DD.log   — повільні й невдалі HTTP-запити, повільні SQL
 * Файл на добу (за київським часом); старі видаляються за LOG_RETENTION_DAYS / LOG_ERROR_RETENTION_DAYS / LOG_HTTP_RETENTION_DAYS.
 * Помилки додатково групуються в базі (errorStore → system_errors) — сторінка «Стан системи» бачить їх одразу.
 *
 * API як у console: logging.error(err) / logging.error("текст", err, { order: 5 }) / warn / info / debug / fatal.
 * logging.child("orders") — те саме з полем module. Поточний HTTP-запит (req_id, user_id, url) додається сам (AsyncLocalStorage).
 * install() — один раз на старті: перехоплює console.*, uncaughtException, unhandledRejection, warning.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const pino = require("pino");
const { AsyncLocalStorage } = require("async_hooks");

const ROOT = path.resolve(process.env.LOG_DIR || path.join(__dirname, "..", "logs"));
const LEVEL = process.env.LOG_LEVEL || "info";
// У консоль (pm2 logs) — усе від info, як і у файл logs/app. Тихіше: LOG_STDOUT_LEVEL=warn
const STDOUT_LEVEL = process.env.LOG_STDOUT_LEVEL || "info";
const TZ = process.env.LOG_TZ || "Europe/Kyiv";
const CATEGORIES = ["app", "error", "http"];
const RETENTION = {
	app: parseInt(process.env.LOG_RETENTION_DAYS, 10) || 30,
	error: parseInt(process.env.LOG_ERROR_RETENTION_DAYS, 10) || 90,
	http: parseInt(process.env.LOG_HTTP_RETENTION_DAYS, 10) || 14,
};
const LEVELS = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };

/** Контекст поточного запиту / задачі: { id, method, url, req } */
const context = new AsyncLocalStorage();

/* ─── Файл на добу ─── */

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const today = () => dayFmt.format(new Date());

class DailyFile {
	constructor(category) {
		this.category = category;
		this.dir = path.join(ROOT, category);
		this.day = null;
		this.dest = null;
		this.checkAt = 0;
	}
	/** Дата перевіряється не частіше разу на хвилину — дешево на кожному записі */
	current() {
		const now = Date.now();
		if (this.dest && now < this.checkAt) return this.dest;
		this.checkAt = now + 60000;
		const d = today();
		if (d === this.day && this.dest) return this.dest;
		const old = this.dest;
		this.day = d;
		this.dest = pino.destination({ dest: path.join(this.dir, d + ".log"), sync: false, mkdir: true, minLength: 4096 });
		this.dest.on("error", (e) => process.stderr.write(`[logging] ${this.category}: ${e.message}\n`));
		if (old) old.end();
		return this.dest;
	}
	write(chunk) {
		this.current().write(chunk);
	}
	flushSync() {
		try {
			if (this.dest) this.dest.flushSync();
		} catch {
			// файл ще не відкрито або вже закрито
		}
	}
}

const files = Object.fromEntries(CATEGORIES.map((c) => [c, new DailyFile(c)]));

/* ─── Консоль: коротко й читабельно (pm2 logs / docker logs) ─── */

const COLORS = { 20: "\x1b[90m", 30: "\x1b[36m", 40: "\x1b[33m", 50: "\x1b[31m", 60: "\x1b[41m" };
const useColor = !!process.stdout.isTTY;
const stdoutStream = {
	write(chunk) {
		let o;
		try {
			o = JSON.parse(chunk);
		} catch {
			return process.stdout.write(chunk);
		}
		const lv = String(LEVELS[o.level] || o.level).toUpperCase().padEnd(5);
		const time = String(o.time || "").slice(11, 19);
		const head = `${time} ${useColor ? (COLORS[o.level] || "") + lv + "\x1b[0m" : lv}${o.module ? " [" + o.module + "]" : ""} ${o.msg || ""}`;
		const stack = o.err && o.err.stack ? "\n" + o.err.stack : "";
		(o.level >= 50 ? process.stderr : process.stdout).write(head + stack + "\n");
	},
};

/* ─── Помилки → база (групування) ─── */

const errorSink = {
	write(chunk) {
		// Лінивий require: errorStore тягне пул бази, а пул — цей модуль
		try {
			require("./metrics").error();
			require("./errorStore").push(chunk);
		} catch (e) {
			process.stderr.write(`[logging] error store: ${e.message}\n`);
		}
	},
};

/* ─── Логери ─── */

// Секрети не потрапляють у файли навіть якщо їх передали в об'єкті
const REDACT = [
	"password", "pass", "token", "secret", "api_key", "apiKey", "authorization", "cookie",
	"*.password", "*.pass", "*.token", "*.secret", "*.api_key", "*.apiKey", "*.authorization", "*.cookie",
	"*.*.password", "*.*.token", "*.*.secret", "*.*.api_key",
];

const baseOptions = {
	level: LEVEL,
	base: { pid: process.pid, host: os.hostname() },
	timestamp: pino.stdTimeFunctions.isoTime,
	redact: { paths: REDACT, censor: "[redacted]" },
	serializers: { err: pino.stdSerializers.err },
	// Поточний HTTP-запит — до кожного запису, без передачі вручну
	mixin() {
		const c = context.getStore();
		if (!c) return {};
		const u = c.req && c.req.user;
		return { req_id: c.id, method: c.method, url: c.url, ...(u ? { user_id: u.userId || u.id || null } : {}) };
	},
};

const root = pino(
	baseOptions,
	pino.multistream(
		[
			{ level: LEVEL, stream: files.app },
			{ level: "error", stream: files.error },
			{ level: "error", stream: errorSink },
			{ level: STDOUT_LEVEL, stream: stdoutStream },
		],
		{ dedupe: false }
	)
);

// HTTP — окремий файл (повільні / невдалі запити, повільні SQL)
const httpLogger = pino({ ...baseOptions, level: "info" }, files.http);

/**
 * Аргументи як у console → (об'єкт, текст) для pino.
 * Error → err; рядки й числа — у текст; об'єкти зливаються; масив — у data.
 */
function normalize(args) {
	const obj = {};
	const parts = [];
	for (const a of args) {
		if (a instanceof Error) {
			if (!obj.err) obj.err = a;
			else parts.push(a.message);
		} else if (Array.isArray(a)) {
			obj.data = a;
		} else if (a && typeof a === "object") {
			Object.assign(obj, a);
		} else if (a !== undefined) {
			parts.push(String(a));
		}
	}
	if (!obj.err && obj.error instanceof Error) {
		obj.err = obj.error;
		delete obj.error;
	}
	let msg = parts.join(" ");
	if (typeof obj.msg === "string") {
		msg = msg ? msg + " " + obj.msg : obj.msg;
		delete obj.msg;
	}
	if (!msg && obj.err) msg = obj.err.message || String(obj.err);
	// Модуль з префікса «[orders] …», якщо не задано явно
	if (!obj.module) {
		const m = /^\[([\w\-./: ]{1,40})\]\s*/.exec(msg);
		if (m) {
			obj.module = m[1].trim();
			msg = msg.slice(m[0].length) || msg;
		}
	}
	return [obj, msg];
}

function api(logger) {
	const call = (level) => (...args) => {
		try {
			if (!logger.isLevelEnabled(level)) return;
			const [obj, msg] = normalize(args);
			logger[level](obj, msg);
		} catch (e) {
			process.stderr.write(`[logging] ${e.message}\n`);
		}
	};
	return {
		fatal: call("fatal"),
		error: call("error"),
		warn: call("warn"),
		info: call("info"),
		debug: call("debug"),
		child: (module, extra) => api(logger.child({ module, ...(extra || {}) })),
		isLevelEnabled: (l) => logger.isLevelEnabled(l),
	};
}

const logging = api(root);

/** Запис у журнал HTTP: { level?, …поля } */
function http(obj, msg) {
	try {
		const { level = "info", ...rest } = obj || {};
		httpLogger[level](rest, msg || "");
	} catch (e) {
		process.stderr.write(`[logging] http: ${e.message}\n`);
	}
}

function flushSync() {
	Object.values(files).forEach((f) => f.flushSync());
}

/* ─── Очищення старих файлів ─── */

function cleanup() {
	const now = Date.now();
	for (const [cat, days] of Object.entries(RETENTION)) {
		const dir = path.join(ROOT, cat);
		let names = [];
		try {
			names = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const n of names) {
			const m = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(n);
			if (m && now - Date.parse(m[1]) > (days + 1) * 86400000) {
				try {
					fs.unlinkSync(path.join(dir, n));
				} catch (e) {
					logging.warn({ module: "logging", file: n }, "cannot delete old log: " + e.message);
				}
			}
		}
	}
}

/* ─── Перехоплення console і процесу ─── */

let installed = false;
function install() {
	if (installed) return;
	installed = true;

	// console.* → журнал (у stdout пише сам журнал, тож без дублювання)
	const consoleLog = logging.child("console");
	const map = { log: "info", info: "info", warn: "warn", error: "error", debug: "debug" };
	for (const [m, level] of Object.entries(map)) console[m] = (...args) => consoleLog[level](...args);

	process.on("uncaughtException", (err, origin) => {
		logging.fatal({ module: "process", err, origin }, "uncaughtException: " + (err && err.message));
		flushSync();
		// Стан процесу невизначений — завершуємо, менеджер процесів (pm2 / systemd) перезапустить
		setTimeout(() => process.exit(1), 300).unref();
	});
	process.on("unhandledRejection", (reason) => {
		const err = reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : JSON.stringify(reason));
		logging.error({ module: "process", err }, "unhandledRejection: " + err.message);
	});
	process.on("warning", (w) => logging.warn({ module: "process", err: w }, w.message));
	process.on("exit", flushSync);
	for (const sig of ["SIGINT", "SIGTERM"]) {
		process.once(sig, () => {
			logging.info({ module: "process" }, "stopping: " + sig);
			flushSync();
			process.exit(0);
		});
	}

	setTimeout(cleanup, 30000).unref();
	setInterval(cleanup, 6 * 3600000).unref();
	logging.info({ module: "process", node: process.version, level: LEVEL, dir: ROOT }, "started");
}

module.exports = { ...logging, http, context, install, flushSync, cleanup, normalize, ROOT, CATEGORIES, RETENTION, LEVELS, today };