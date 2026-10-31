"use strict";

/**
 * Групування помилок у базі (system_errors) — як у Sentry: одна помилка = один рядок з лічильником,
 * першою / останньою появою, стеком і контекстом останнього разу.
 * Відбиток (fingerprint) = модуль + текст без чисел / id / лапок + перший кадр стеку з коду системи.
 *
 * Записи з журналу накопичуються в пам'яті й пишуться пачкою раз на FLUSH_MS одним INSERT … ON DUPLICATE KEY UPDATE —
 * шквал однакових помилок не навантажує базу. Помилка, позначена «виправлено», при повторі знову відкривається.
 * Якщо база недоступна — запис лишається лише у файлі журналу (без рекурсії через логер).
 */
const crypto = require("crypto");
const path = require("path");

const FLUSH_MS = 3000;
const MAX_GROUPS = 300; // різних помилок за один інтервал (решта — лише у файлі)
const APP_ROOT = path.resolve(__dirname, "..");

const buffer = new Map();
let timer = null;
let disabled = false; // таблиці немає — не пробуємо до перезапуску
let failing = 0;

/** Текст без змінних частин: числа, id, ref, рядки в лапках, e-mail */
function shape(msg) {
	return String(msg || "")
		.replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "<email>")
		.replace(/(['"`]).*?\1/g, "<str>")
		.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi, "<uuid>")
		.replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
		.replace(/\d+(\.\d+)?/g, "#")
		.slice(0, 300);
}

/** Перший кадр стеку з коду системи (не node_modules / node:internal) */
function appFrame(stack) {
	for (const line of String(stack || "").split("\n").slice(1)) {
		if (line.includes("node_modules") || line.includes("node:")) continue;
		const m = /\(?([^()]+):(\d+):\d+\)?$/.exec(line.trim());
		if (m) return path.relative(APP_ROOT, m[1]) + ":" + m[2];
	}
	return "";
}

function push(chunk) {
	if (disabled) return;
	let o;
	try {
		o = JSON.parse(chunk);
	} catch {
		return;
	}
	if (o.module === "error-store") return;
	const err = o.err || {};
	const module = String(o.module || "app").slice(0, 64);
	const message = String(o.msg || err.message || "—").slice(0, 1000);
	const frame = appFrame(err.stack);
	const fp = crypto.createHash("sha1").update([module, err.type || "", shape(message), frame].join("|")).digest("hex");
	const cur = buffer.get(fp);
	if (cur) {
		cur.count++;
		cur.last = o;
		return;
	}
	if (buffer.size >= MAX_GROUPS) return;
	buffer.set(fp, { fp, module, message, frame, level: o.level >= 60 ? "fatal" : "error", count: 1, first: o, last: o });
	if (!timer) {
		timer = setTimeout(flush, FLUSH_MS);
		timer.unref();
	}
}

/** Контекст для показу: без часу / рівня / стеку (вони окремо) */
function ctx(o) {
	const { time, level, msg, err, pid, hostname, ...rest } = o;
	const s = JSON.stringify(rest);
	return s.length > 8000 ? JSON.stringify({ truncated: true, req_id: rest.req_id, url: rest.url, user_id: rest.user_id }) : s;
}
// Час журналу — ISO UTC; у базу — місцевий час процесу (як NOW() і решта дат системи)
const pad = (n) => String(n).padStart(2, "0");
const dbTime = (iso) => {
	const d = iso ? new Date(iso) : new Date();
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

async function flush() {
	timer = null;
	if (!buffer.size) return;
	const items = [...buffer.values()];
	buffer.clear();
	const pool = require("../config/database/connection_pool");
	const P = require("../config/config").get("configDatabase").prefix;
	try {
		const rows = items.map((x) => {
			const err = x.last.err || {};
			return [x.fp, x.level, x.module, x.message, x.frame || null, err.type ? String(err.type).slice(0, 64) : null, err.stack ? String(err.stack).slice(0, 20000) : null, x.count, dbTime(x.first.time), dbTime(x.last.time), ctx(x.last)];
		});
		await pool.query(
			`INSERT INTO ${P}system_errors (fingerprint, level, module, message, frame, type, stack, count, first_seen, last_seen, context, status)
			 VALUES ?
			 ON DUPLICATE KEY UPDATE count = count + VALUES(count), last_seen = VALUES(last_seen), message = VALUES(message), stack = VALUES(stack),
			        context = VALUES(context), level = VALUES(level),
			        status = IF(status = 'resolved', 'open', status), resolved_at = IF(status = 'open', NULL, resolved_at)`,
			[rows.map((r) => [...r, "open"])]
		);
		failing = 0;
	} catch (e) {
		if (e.code === "ER_NO_SUCH_TABLE") disabled = true;
		// У файл — напряму через pino, з module error-store (не повертається сюди)
		if (failing++ < 3) require("./logging").warn({ module: "error-store", code: e.code }, "cannot save errors: " + e.message);
	}
}

module.exports = { push, flush, shape, appFrame };