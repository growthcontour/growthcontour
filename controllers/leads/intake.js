"use strict";

/**
 * Прийом лідів із сайтів, лендингів, форм і сторонніх сервісів — за ключем доступу (leads_api_tokens).
 *
 *   POST /api/leads/v1/intake/          — основний вхід (JSON або звичайна HTML-форма)
 *   POST /api/leads/add/:token/         — старий формат адреси (ключ у шляху), працює так само
 *
 * Ключ: заголовок «Authorization: Bearer lk_…» або «X-Api-Key: lk_…»; для HTML-форм без JS — поле _token.
 * У базі лише SHA-256 ключа. Перевірки по черзі: ключ → відкликано / вимкнено / прострочено → звідки запит
 * (домени / IP, як у /settings/tokens/) → частота з одного IP → приховане поле-пастка (спам) → дані → повтор
 * (той самий телефон / email за N годин — коментар до наявного ліда, а не новий лід).
 * Кожна спроба — у журнал leads_api_log.
 */

const crypto = require("crypto");
const dns = require("dns").promises;
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");

const P = config.get("configDatabase").prefix;
const LOG_KEEP_OK = 30;
const LOG_KEEP_REJECTED = 90;

const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");
const nowSql = () => {
	const d = new Date();
	const p = (x) => String(x).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const parse = (v, def) => {
	if (v === null || v === undefined) return def;
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return def;
	}
};

/* ─── Звідки запит: домен (Origin / Referer або DNS домену = IP з'єднання) та IP — як у токенах замовлень ─── */

const clientIp = (req) => (req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "") || null;
const normHost = (s) => {
	s = String(s || "").trim().toLowerCase();
	if (!s) return "";
	try {
		if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = "http://" + s;
		return new URL(s).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
};
const requestHost = (req) => normHost(req.headers.origin || req.headers.referer || "") || null;

const dnsCache = new Map();
async function resolveHost(host) {
	const c = dnsCache.get(host);
	if (c && c.exp > Date.now()) return c.ips;
	let ips = [];
	try {
		ips = (await dns.lookup(host, { all: true })).map((a) => a.address.replace(/^::ffff:/, ""));
	} catch {
		/* домен не резолвиться */
	}
	dnsCache.set(host, { ips, exp: Date.now() + 5 * 60 * 1000 });
	return ips;
}

/** IP у списку: точний збіг або підмережа IPv4 (1.2.3.0/24) */
function ipAllowed(ip, list) {
	if (!ip) return false;
	const toInt = (s) => s.split(".").reduce((a, x) => (a << 8) + (Number(x) & 255), 0) >>> 0;
	return list.some((rule) => {
		if (rule === ip) return true;
		const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(rule);
		if (!m || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
		const bits = Number(m[2]);
		const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
		return (toInt(ip) & mask) === (toInt(m[1]) & mask);
	});
}

/** off — без перевірки; any — підходить домен АБО IP; all — і домен, і IP */
async function checkSource(mode, host, ip, domainsRaw, ipsRaw) {
	if (mode === "off") return { ok: true };
	const domains = (Array.isArray(domainsRaw) ? domainsRaw : []).map(normHost).filter(Boolean);
	const ips = (Array.isArray(ipsRaw) ? ipsRaw : []).map((s) => String(s).trim()).filter(Boolean);
	if (!domains.length && !ips.length) return { ok: true };
	let dOk = null;
	if (domains.length) {
		dOk = !!(host && domains.some((d) => host === d || host.endsWith("." + d)));
		if (!dOk && ip) for (const d of domains) if ((await resolveHost(d)).includes(ip)) dOk = true;
	}
	const iOk = ips.length ? ipAllowed(ip, ips) : null;
	if (mode === "all") {
		if (!domains.length || !ips.length) return { ok: false, reason: "source_incomplete" };
		if (!dOk) return { ok: false, reason: "domain_denied" };
		if (!iOk) return { ok: false, reason: "ip_denied" };
		return { ok: true };
	}
	if (dOk === true || iOk === true) return { ok: true };
	return { ok: false, reason: domains.length ? "domain_denied" : "ip_denied" };
}

/** Браузерна форма з іншого сайту: дозволяємо її домену читати відповідь */
function corsFor(req, res, token) {
	const origin = req.headers.origin;
	if (!origin) return;
	const host = normHost(origin);
	const domains = (Array.isArray(token.allowed_domains) ? token.allowed_domains : []).map(normHost).filter(Boolean);
	const ok = token.source_check_mode === "off" || !domains.length ? true : domains.some((d) => host === d || host.endsWith("." + d));
	if (!ok) return;
	res.setHeader("Access-Control-Allow-Origin", origin);
	res.setHeader("Vary", "Origin");
}

/* ─── Частота: N запитів за хвилину з одного IP на ключ (у пам'яті процесу) ─── */

const hits = new Map();
function tooFrequent(idToken, ip, limit) {
	if (!limit) return false;
	const key = idToken + "|" + ip;
	const now = Date.now();
	const list = (hits.get(key) || []).filter((t) => now - t < 60000);
	list.push(now);
	hits.set(key, list);
	if (hits.size > 20000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 60000) hits.delete(k);
	return list.length > limit;
}

/* ─── Журнал ─── */

async function logAttempt(d) {
	try {
		// Що прийшло — без ключа; завелике — лише назви полів (JSON-колонка не приймає обрізаний JSON)
		let payload = null;
		if (d.payload && typeof d.payload === "object") {
			const clean = Object.fromEntries(Object.entries(d.payload).filter(([k]) => !SERVICE.has(k)));
			payload = JSON.stringify(clean);
			if (payload.length > 8000) payload = JSON.stringify({ _truncated: true, keys: Object.keys(clean).slice(0, 100) });
		}
		await pool.query(
			`INSERT INTO \`${P}leads_api_log\` (id_token, prefix, ip, domain, user_agent, result, reject_reason, http_status, id_lead, payload, message, date_add)
			 VALUES (?, ?, INET6_ATON(?), ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
			[d.id_token || null, d.prefix || null, d.ip || null, d.domain || null, (d.ua || "").slice(0, 512), d.result, d.reason || null, d.status || null, d.id_lead || null, payload, (d.message || "").slice(0, 999)]
		);
		if (d.id_token) {
			if (d.result === "success" || d.result === "duplicate") await pool.query(`UPDATE \`${P}leads_api_tokens\` SET usage_count = usage_count + 1, last_used_at = NOW(), last_used_ip = INET6_ATON(?), last_used_domain = ? WHERE id = ?`, [d.ip, d.domain, d.id_token]);
			else await pool.query(`UPDATE \`${P}leads_api_tokens\` SET error_count = error_count + 1 WHERE id = ?`, [d.id_token]);
		}
	} catch (e) {
		logging.error(e);
	}
}

async function pruneLog() {
	let removed = 0;
	for (const [cond, days] of [["result IN ('success','duplicate')", LOG_KEEP_OK], ["result IN ('rejected','spam')", LOG_KEEP_REJECTED]]) {
		for (;;) {
			const [r] = await pool.query(`DELETE FROM \`${P}leads_api_log\` WHERE ${cond} AND date_add < NOW() - INTERVAL ? DAY LIMIT 5000`, [days]);
			removed += r.affectedRows;
			if (r.affectedRows < 5000) break;
		}
	}
	return removed;
}

/* ─── Дані запиту → поля ліда ─── */

// Поля, які розуміє прийом (назви з форми можна перейменувати в налаштуваннях ключа: «Відповідність полів»)
const KNOWN = ["title", "name", "first_name", "last_name", "phone", "email", "company", "position", "message", "note", "value", "website", "page_url", "source", "external_id", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
const SERVICE = new Set(["_token", "token", "api_key", "_redirect"]);
const str = (v, max = 255) => (v === null || v === undefined || typeof v === "object" ? "" : String(v).trim().slice(0, max));

/**
 * Тіло запиту → { lead, contact, utm, custom } або { error }.
 * Підтримує плоскі поля (name, phone, …) і вкладені contact_info / utm / custom_fields (старий формат).
 */
function normalize(body, fieldMap, honeypot) {
	const src = {};
	const custom = {};
	const flat = { ...(body || {}) };
	// Старий формат: вкладені об'єкти
	if (flat.contact_info && typeof flat.contact_info === "object") Object.assign(flat, flat.contact_info);
	if (flat.utm && typeof flat.utm === "object") Object.assign(flat, flat.utm);
	if (flat.custom_fields && typeof flat.custom_fields === "object") for (const [k, v] of Object.entries(flat.custom_fields)) custom[str(k, 64)] = str(v, 1000);
	delete flat.contact_info;
	delete flat.utm;
	delete flat.custom_fields;
	const map = fieldMap && typeof fieldMap === "object" ? fieldMap : {};
	for (const [k0, v] of Object.entries(flat)) {
		if (SERVICE.has(k0) || (honeypot && k0 === honeypot)) continue;
		const k = map[k0] || k0;
		if (k.startsWith("custom.")) custom[str(k.slice(7), 64)] = str(v, 1000);
		else if (KNOWN.includes(k)) src[k] = v;
		else if (k !== "tags" && k !== "status" && k !== "priority" && k !== "lead_source" && Object.keys(custom).length < 50) custom[str(k, 64)] = str(v, 1000);
	}
	const name = str(src.name) || [str(src.first_name), str(src.last_name)].filter(Boolean).join(" ");
	const phone = str(src.phone, 32);
	const email = str(src.email).toLowerCase();
	if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "bad_email" };
	if (phone && !/^[\d\s()+\-.]{5,32}$/.test(phone)) return { error: "bad_phone" };
	if (!name && !phone && !email) return { error: "empty_contact" };
	const valueNum = Number(String(src.value ?? "").replace(",", "."));
	const contact = Object.fromEntries(Object.entries({ name, phone, email, company: str(src.company), position: str(src.position) }).filter(([, v]) => v));
	const utm = Object.fromEntries(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].map((k) => [k, str(src[k])]).filter(([, v]) => v));
	const page = str(src.page_url, 1000);
	if (page) custom.page_url = page;
	if (str(src.external_id)) custom.external_id = str(src.external_id, 191);
	return {
		lead: {
			title: str(src.title, 500),
			note: str(src.message || src.note, 65000),
			value: Number.isFinite(valueNum) && valueNum > 0 ? Math.round(valueNum * 100) / 100 : 0,
			website: normHost(src.website || page) || str(src.website),
			lead_source: str(src.source),
		},
		contact,
		utm,
		custom,
	};
}

/* ─── Запит прийому ─── */

function rawToken(req) {
	const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
	return (m && m[1].trim()) || String(req.headers["x-api-key"] || "").trim() || (req.params && req.params.token) || str((req.body || {})._token, 128) || str((req.query || {}).token, 128) || "";
}

/** Звичайна HTML-форма (не fetch): після успіху — перенаправлення на сторінку подяки або коротка відповідь */
const isHtmlForm = (req) => (req.headers["content-type"] || "").includes("application/x-www-form-urlencoded") && (req.headers.accept || "").includes("text/html");

async function handle(req, res) {
	const ip = clientIp(req);
	const host = requestHost(req);
	const ua = req.headers["user-agent"] || "";
	const base = { ip, domain: host, ua };
	const reject = async (status, reason, t, extra) => {
		await logAttempt({ ...base, id_token: t && t.id, prefix: t && t.prefix, result: "rejected", reason, status, payload: req.body, ...(extra || {}) });
		return res.status(status).json({ ok: false, error: reason });
	};

	const raw = rawToken(req);
	if (!raw) return reject(401, "no_token");
	const [[t]] = await pool.query(`SELECT * FROM \`${P}leads_api_tokens\` WHERE token_hash = ? LIMIT 1`, [hashToken(raw)]);
	if (!t) return reject(401, "bad_token", null, { prefix: raw.slice(0, 12) });
	t.allowed_domains = parse(t.allowed_domains, []);
	t.allowed_ips = parse(t.allowed_ips, []);
	corsFor(req, res, t);
	if (t.revoked_at) return reject(403, "revoked", t);
	if (!Number(t.is_active)) return reject(403, "disabled", t);
	if (t.expires_at && new Date(String(t.expires_at).slice(0, 10) + "T23:59:59") < new Date()) return reject(403, "expired", t);
	const src = await checkSource(t.source_check_mode, host, ip, t.allowed_domains, t.allowed_ips);
	if (!src.ok) return reject(403, src.reason, t);
	if (tooFrequent(t.id, ip, Number(t.rate_limit))) return reject(429, "rate_limited", t);

	const body = req.body || {};
	// Пастка для ботів: приховане поле заповнене — відповідаємо «прийнято», але ліда не створюємо
	if (t.honeypot && str(body[t.honeypot])) {
		await logAttempt({ ...base, id_token: t.id, prefix: t.prefix, result: "spam", reason: "honeypot", status: 201, payload: body });
		return respondOk(req, res, t, 201, { ok: true, lead_id: null });
	}

	const n = normalize(body, parse(t.field_map, {}), t.honeypot);
	if (n.error) return reject(400, n.error, t);

	// Повтор: той самий телефон або email за останні N годин — коментар до наявного ліда
	const digits = (n.contact.phone || "").replace(/\D/g, "");
	if (Number(t.dedupe_hours) && (digits.length >= 9 || n.contact.email)) {
		const cond = [];
		const params = [];
		if (digits.length >= 9) {
			cond.push("RIGHT(REGEXP_REPLACE(JSON_UNQUOTE(JSON_EXTRACT(contact_info, '$.phone')), '[^0-9]', ''), 9) = ?");
			params.push(digits.slice(-9));
		}
		if (n.contact.email) {
			cond.push("LOWER(JSON_UNQUOTE(JSON_EXTRACT(contact_info, '$.email'))) = ?");
			params.push(n.contact.email);
		}
		const [[dup]] = await pool.query(
			`SELECT id FROM \`${P}leads\` WHERE deleted_at IS NULL AND date_add > NOW() - INTERVAL ? HOUR AND (${cond.join(" OR ")}) ORDER BY id DESC LIMIT 1`,
			[Number(t.dedupe_hours), ...params]
		);
		if (dup) {
			const text = [n.lead.title, n.lead.note].filter(Boolean).join("\n").slice(0, 2000);
			await pool.query(
				`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES (?, NULL, 'comment', NULL, NULL, NULL, ?, 'api', ?, NOW())`,
				[dup.id, ("Повторна заявка (" + (t.name || t.prefix) + ")" + (text ? ":\n" + text : "")).slice(0, 5000), ip]
			);
			await pool.query(`UPDATE \`${P}leads\` SET date_edit = NOW() WHERE id = ?`, [dup.id]);
			await logAttempt({ ...base, id_token: t.id, prefix: t.prefix, result: "duplicate", status: 200, id_lead: dup.id, payload: body });
			return respondOk(req, res, t, 200, { ok: true, lead_id: dup.id, duplicate: true });
		}
	}

	const id = await createLead(t, n, req);
	await logAttempt({ ...base, id_token: t.id, prefix: t.prefix, result: "success", status: 201, id_lead: id, payload: body });
	return respondOk(req, res, t, 201, { ok: true, lead_id: id });
}

function respondOk(req, res, t, status, json) {
	if (isHtmlForm(req)) {
		// Адреса з форми — лише на дозволений домен ключа (інакше форма стала б «перенаправлялкою» на будь-який сайт)
		const own = str(req.body && req.body._redirect, 500);
		const domains = (Array.isArray(t.allowed_domains) ? t.allowed_domains : []).map(normHost).filter(Boolean);
		const ownHost = normHost(own);
		const to = own && ownHost && domains.some((d) => ownHost === d || ownHost.endsWith("." + d)) ? own : t.success_redirect;
		if (/^https?:\/\//i.test(to || "")) return res.redirect(303, to);
		return res.status(status).type("html").send('<!doctype html><meta charset="utf-8"><title>OK</title><p style="font-family:sans-serif">Дякуємо! Заявку отримано.</p>');
	}
	return res.status(status).json(json);
}

/** Новий лід із типовими значеннями ключа: воронка, етап, статус, джерело, пріоритет, відповідальний, теги */
async function createLead(t, n, req) {
	const conn = await pool.getConnection();
	let id;
	try {
		await conn.beginTransaction();
		const one = async (sql, params) => ((await conn.query(sql, params))[0][0] || null);
		const pipeline = t.id_pipeline || (await one(`SELECT id FROM \`${P}leads_pipelines\` ORDER BY id LIMIT 1`))?.id || null;
		let stage = t.id_stage;
		if (!stage && pipeline) stage = (await one(`SELECT id FROM \`${P}leads_pipeline_stages\` WHERE id_pipeline = ? AND is_active = 1 ORDER BY sort, id LIMIT 1`, [pipeline]))?.id || null;
		const status = t.id_status || (await one(`SELECT id FROM \`${P}leads_settings_status\` WHERE is_active = 1 ORDER BY is_default DESC, sort, id LIMIT 1`))?.id || 0;
		const name = n.contact.name || n.contact.phone || n.contact.email;
		const title = n.lead.title || req.__("leads.server.request_title", { name });
		const now = nowSql();
		const [r] = await conn.query(
			`INSERT INTO \`${P}leads\`
			   (title, note, value, id_pipeline, id_stage, id_status, id_priority, id_manager, id_source, lead_source, website,
			    capture_type, capture_ref, contact_info, utm, custom_fields, date_add, date_edit)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', ?, ?, ?, ?, ?, ?)`,
			[title, n.lead.note, n.lead.value, pipeline, stage, status, t.id_priority || null, t.id_manager || null, t.id_source || null, n.lead.lead_source || t.name || "", n.lead.website, t.prefix, JSON.stringify(n.contact), JSON.stringify(n.utm), JSON.stringify(n.custom), now, now]
		);
		id = r.insertId;
		const tags = (parse(t.tags, []) || []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
		if (tags.length) await conn.query(`INSERT IGNORE INTO \`${P}leads_tags_rel\` (id_lead, id_tag) SELECT ?, id FROM \`${P}leads_tags\` WHERE id IN (?)`, [id, tags]);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}

	// Після коміту: картка клієнта, сповіщення відповідальному, вебхуки
	try {
		await require("../clients/links").linkLead(id);
	} catch (e) {
		logging.error(e);
	}
	// Без відповідального з ключа — розподіл за правилами; сповіщення отримувачам модуля
	await require("./routing").onNew(id);
	if (Number(t.notify_manager) && t.id_manager) {
		try {
			const { notify } = require("../notifications");
			Promise.resolve(
				notify({
					type: "leads.new",
					channels: ["inapp"],
					audience: { user: Number(t.id_manager) },
					key: `leads_new_${id}`,
					priority: 6,
					payload: { title: req.__("leads.intake.n_new", { id: String(id) }), name: n.contact.name || n.contact.phone || n.contact.email || "#" + id, message: t.name || "", url: `/leads/${id}/` },
				})
			).catch((e) => logging.error(e));
		} catch (e) {
			logging.error(e);
		}
	}
	require("./webhooks").fire("lead.created", id);
	return id;
}

/** Перехресний запит браузера (fetch з іншого сайту): дозволяємо відправку; домен перевіряється на самому запиті */
function preflight(req, res) {
	if (req.headers.origin) {
		res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
		res.setHeader("Vary", "Origin");
	}
	res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key");
	res.setHeader("Access-Control-Max-Age", "86400");
	return res.status(204).end();
}

module.exports = { handle, preflight, pruneLog, hashToken, normalize, checkSource, ipAllowed, LOG_KEEP_OK, LOG_KEEP_REJECTED };