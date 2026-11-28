"use strict";

/**
 * Вихідні вебхуки лідів: подія з лідом → POST (або PUT) на адресу іншої системи.
 *
 * Черга — таблиця leads_webhooks_log (шаблон B ядра: рядки pending, пачка FOR UPDATE SKIP LOCKED, kick + таймер):
 *   fire(event, idLead, extra) — після коміту бізнес-дії: рядок pending на кожен активний вебхук, підписаний на подію;
 *   drain()                    — доставка: 2xx → success; інакше повтор через 1, 5, 15, 60, 180 хв, після 6-ї спроби — failed.
 * Підпис: X-GC-Signature: sha256=HMAC_SHA256(secret, тіло) — отримувач перевіряє, що запит саме від нас.
 */

const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const os = require("os");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");

const P = config.get("configDatabase").prefix;
const EVENTS = ["lead.created", "lead.updated", "lead.status_changed", "lead.stage_changed", "lead.assigned", "lead.converted", "lead.deleted"];
const RETRY_MIN = [1, 5, 15, 60, 180]; // після 1-ї … 5-ї невдалої спроби
const MAX_ATTEMPTS = RETRY_MIN.length + 1;
const BATCH = 10;
const TIMEOUT_MS = 10000;
const STALE_MIN = 10;
const WORKER = `${os.hostname()}:${process.pid}`;

const parse = (v, def) => {
	if (v === null || v === undefined) return def;
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return def;
	}
};

/* ─── Адреса: лише http(s) і не внутрішня мережа (щоб вебхук не став ходом у локальні сервіси) ─── */

function privateIp(ip) {
	if (net.isIPv6(ip)) {
		const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
		if (v4) return privateIp(v4[1]);
		return ip === "::1" || ip === "::" || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip);
	}
	const [a, b] = ip.split(".").map(Number);
	return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function checkUrl(url) {
	let u;
	try {
		u = new URL(url);
	} catch {
		return "bad_url";
	}
	if (!["http:", "https:"].includes(u.protocol)) return "bad_url";
	if (process.env.LEADS_WEBHOOKS_ALLOW_PRIVATE === "1") return null;
	const host = u.hostname.replace(/^\[|\]$/g, "");
	if (host === "localhost") return "private_url";
	const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
	if (!ips.length) return "dns_failed";
	return ips.some(privateIp) ? "private_url" : null;
}

/* ─── Дані ліда для вебхука ─── */

async function leadPayload(idLead) {
	const [[l]] = await pool.query(
		`SELECT l.id, l.title, l.note, l.value, l.id_pipeline, l.id_stage, l.id_status, l.id_source, l.id_manager,
		        l.contact_info, l.utm, l.custom_fields, l.website, l.capture_type, l.score, l.grade, l.is_converted, l.deleted_at, l.date_add, l.date_edit,
		        (SELECT name FROM \`${P}leads_settings_status_lang\` WHERE id_status = l.id_status ORDER BY id_lang LIMIT 1) AS status_name,
		        (SELECT name FROM \`${P}leads_pipeline_stages_lang\` WHERE id_stage = l.id_stage ORDER BY id_lang LIMIT 1) AS stage_name,
		        (SELECT name FROM \`${P}leads_sources_lang\` WHERE id_source = l.id_source ORDER BY id_lang LIMIT 1) AS source_name,
		        (SELECT NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') FROM \`${P}users\` WHERE id = l.id_manager) AS manager_name,
		        (SELECT email FROM \`${P}users\` WHERE id = l.id_manager) AS manager_email
		   FROM \`${P}leads\` l WHERE l.id = ?`,
		[idLead]
	);
	if (!l) return null;
	const [tags] = await pool.query(
		`SELECT t.id, (SELECT name FROM \`${P}leads_tags_lang\` WHERE id_tag = t.id ORDER BY id_lang LIMIT 1) AS name
		   FROM \`${P}leads_tags_rel\` r JOIN \`${P}leads_tags\` t ON t.id = r.id_tag WHERE r.id_lead = ?`,
		[idLead]
	);
	const base = String(process.env.APP_URL || "").replace(/\/+$/, "");
	return {
		id: l.id,
		title: l.title,
		note: l.note,
		value: Number(l.value),
		status: l.id_status ? { id: l.id_status, name: l.status_name } : null,
		pipeline_id: l.id_pipeline,
		stage: l.id_stage ? { id: l.id_stage, name: l.stage_name } : null,
		source: l.id_source ? { id: l.id_source, name: l.source_name } : null,
		manager: l.id_manager ? { id: l.id_manager, name: l.manager_name, email: l.manager_email } : null,
		contact: parse(l.contact_info, {}),
		utm: parse(l.utm, {}),
		custom_fields: parse(l.custom_fields, {}),
		tags: tags.map((t) => ({ id: t.id, name: t.name })),
		website: l.website,
		capture_type: l.capture_type,
		score: l.score,
		grade: l.grade,
		is_converted: !!l.is_converted,
		deleted: !!l.deleted_at,
		url: base ? `${base}/leads/${l.id}/` : `/leads/${l.id}/`,
		date_add: l.date_add,
		date_edit: l.date_edit,
	};
}

/**
 * Подія з лідом — у чергу кожного активного вебхука, підписаного на неї. Викликати ПІСЛЯ коміту.
 * extra — що додати в тіло (напр. { changes: ["id_status", …] }). Помилки не кидає.
 */
function fire(event, idLead, extra) {
	(async () => {
		const [hooks] = await pool.query(`SELECT id, events FROM \`${P}leads_webhooks\` WHERE is_active = 1`);
		const targets = hooks.filter((h) => (parse(h.events, []) || []).includes(event));
		if (!targets.length) return;
		const lead = await leadPayload(idLead);
		if (!lead) return;
		const body = { event, occurred_at: new Date().toISOString(), lead, ...(extra || {}) };
		await pool.query(
			`INSERT INTO \`${P}leads_webhooks_log\` (id_webhook, id_lead, event, payload, result, attempt, next_attempt_at, date_add) VALUES ?`,
			[targets.map((h) => [h.id, idLead, event, JSON.stringify(body), "pending", 0, null, new Date()])]
		);
		kick();
	})().catch((e) => logging.error(e));
}

/* ─── Доставка ─── */

async function send(hook, deliveryId, event, bodyObj) {
	const body = JSON.stringify(bodyObj);
	const ts = Math.floor(Date.now() / 1000);
	const headers = { "Content-Type": "application/json", "User-Agent": "GrowthContour-Webhooks/1.0", "X-GC-Event": event, "X-GC-Delivery": String(deliveryId), "X-GC-Timestamp": String(ts) };
	if (hook.secret) headers["X-GC-Signature"] = "sha256=" + crypto.createHmac("sha256", hook.secret).update(body).digest("hex");
	for (const [k, v] of Object.entries(parse(hook.headers, {}) || {})) if (/^[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === "string") headers[k] = v.slice(0, 1000);
	const bad = await checkUrl(hook.url);
	if (bad) return { ok: false, code: null, body: "", error: bad };
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const r = await fetch(hook.url, { method: hook.method === "PUT" ? "PUT" : "POST", headers, body, signal: ctrl.signal, redirect: "manual" });
		const text = (await r.text().catch(() => "")).slice(0, 2000);
		return { ok: r.status >= 200 && r.status < 300, code: r.status, body: text, error: r.status >= 200 && r.status < 300 ? null : "http_" + r.status };
	} catch (e) {
		return { ok: false, code: null, body: "", error: e.name === "AbortError" ? "timeout" : String(e.cause?.code || e.message || e).slice(0, 200) };
	} finally {
		clearTimeout(timer);
	}
}

async function drainOnce() {
	// Зависле «відправляється» (процес упав посеред доставки) — назад у чергу
	await pool.query(`UPDATE \`${P}leads_webhooks_log\` SET result = 'pending', locked_at = NULL WHERE result = 'sending' AND locked_at < NOW() - INTERVAL ? MINUTE`, [STALE_MIN]);
	const conn = await pool.getConnection();
	let rows;
	try {
		await conn.beginTransaction();
		[rows] = await conn.query(
			`SELECT id FROM \`${P}leads_webhooks_log\` WHERE result = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()) ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`,
			[BATCH]
		);
		if (rows.length) await conn.query(`UPDATE \`${P}leads_webhooks_log\` SET result = 'sending', locked_at = NOW() WHERE id IN (?)`, [rows.map((r) => r.id)]);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	for (const { id } of rows) {
		const [[d]] = await pool.query(
			`SELECT g.id, g.id_webhook, g.event, g.payload, g.attempt, w.url, w.method, w.headers, w.secret, w.is_active
			   FROM \`${P}leads_webhooks_log\` g LEFT JOIN \`${P}leads_webhooks\` w ON w.id = g.id_webhook WHERE g.id = ?`,
			[id]
		);
		if (!d || !d.url || !Number(d.is_active)) {
			await pool.query(`UPDATE \`${P}leads_webhooks_log\` SET result = 'cancelled', error = 'webhook_disabled', locked_at = NULL WHERE id = ?`, [id]);
			continue;
		}
		const r = await send(d, id, d.event, parse(d.payload, {}));
		const attempt = Number(d.attempt) + 1;
		const final = r.ok ? "success" : attempt >= MAX_ATTEMPTS ? "failed" : "pending";
		await pool.query(
			`UPDATE \`${P}leads_webhooks_log\`
			    SET result = ?, attempt = ?, response_code = ?, response_body = ?, error = ?, date_sent = NOW(), locked_at = NULL,
			        next_attempt_at = ${final === "pending" ? "NOW() + INTERVAL ? MINUTE" : "NULL"}
			  WHERE id = ?`,
			[final, attempt, r.code, r.body || null, r.error, ...(final === "pending" ? [RETRY_MIN[attempt - 1]] : []), id]
		);
		await pool.query(`UPDATE \`${P}leads_webhooks\` SET last_status = ?, last_sent_at = NOW(), fail_count = ${r.ok ? "0" : "fail_count + 1"} WHERE id = ?`, [r.ok ? "success" : "error", d.id_webhook]);
	}
	return rows.length;
}

let running = false;
let again = false;
function kick() {
	if (running) {
		again = true;
		return;
	}
	running = true;
	(async () => {
		try {
			do {
				again = false;
				while ((await drainOnce()) === BATCH);
			} while (again);
		} catch (e) {
			logging.error(e);
		} finally {
			running = false;
		}
	})();
}

let timer = null;
/** Старт у server.js: зависле — у чергу, далі таймер для повторів (повтори мають час — kick їх не дочекається) */
function start() {
	if (timer) return;
	pool.query(`UPDATE \`${P}leads_webhooks_log\` SET result = 'pending', locked_at = NULL WHERE result = 'sending'`).catch((e) => logging.error(e)).finally(kick);
	timer = setInterval(kick, 30000);
	timer.unref();
}

/** Пробна доставка з налаштувань: одразу, без черги; результат — у журнал і у відповідь */
async function test(idWebhook) {
	const [[hook]] = await pool.query(`SELECT * FROM \`${P}leads_webhooks\` WHERE id = ?`, [idWebhook]);
	if (!hook) return null;
	const [[last]] = await pool.query(`SELECT id FROM \`${P}leads\` WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1`);
	const lead = last ? await leadPayload(last.id) : { id: 0, title: "Test lead", contact: { name: "Test", phone: "+380000000000" } };
	const body = { event: "test", occurred_at: new Date().toISOString(), test: true, lead };
	const [ins] = await pool.query(`INSERT INTO \`${P}leads_webhooks_log\` (id_webhook, id_lead, event, payload, result, attempt, date_add) VALUES (?, ?, 'test', ?, 'sending', 0, NOW())`, [hook.id, lead.id || null, JSON.stringify(body)]);
	const r = await send(hook, ins.insertId, "test", body);
	await pool.query(`UPDATE \`${P}leads_webhooks_log\` SET result = ?, attempt = 1, response_code = ?, response_body = ?, error = ?, date_sent = NOW() WHERE id = ?`, [r.ok ? "success" : "failed", r.code, r.body || null, r.error, ins.insertId]);
	await pool.query(`UPDATE \`${P}leads_webhooks\` SET last_status = ?, last_sent_at = NOW() WHERE id = ?`, [r.ok ? "success" : "error", hook.id]);
	return r;
}

/** Повторити одну доставку з журналу (неуспішну) */
async function retry(idLog) {
	const [r] = await pool.query(`UPDATE \`${P}leads_webhooks_log\` SET result = 'pending', next_attempt_at = NULL, attempt = 0 WHERE id = ? AND result IN ('failed', 'pending', 'cancelled')`, [idLog]);
	if (r.affectedRows) kick();
	return r.affectedRows > 0;
}

/** Журнал: успішні — 30 днів, решта — 90 */
async function pruneLog() {
	let removed = 0;
	for (const [cond, days] of [["result = 'success'", 30], ["result IN ('failed', 'cancelled')", 90]]) {
		for (;;) {
			const [r] = await pool.query(`DELETE FROM \`${P}leads_webhooks_log\` WHERE ${cond} AND date_add < NOW() - INTERVAL ? DAY LIMIT 5000`, [days]);
			removed += r.affectedRows;
			if (r.affectedRows < 5000) break;
		}
	}
	return removed;
}

module.exports = { EVENTS, fire, kick, start, test, retry, pruneLog, checkUrl, leadPayload, WORKER };