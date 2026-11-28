"use strict";

/**
 * Прийом лідів і вебхуки лідів.
 *
 * Налаштування (право leads.settings — edit, перевіряє controllers/leads/access):
 *   /leads/settings/intake/            — ключі прийому лідів (як /settings/tokens/)
 *   /leads/settings/intake/new/, :id/  — створення / редагування ключа + журнал + приклади підключення
 *   /leads/settings/webhooks/          — вихідні вебхуки (сповіщати інші системи про події з лідами)
 *   /leads/settings/webhooks/new/, :id/
 * Публічно (без входу, за ключем):
 *   POST /api/leads/v1/intake/         — прийом ліда
 *   POST /api/leads/add/:token/        — старий формат адреси
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const auth = require("../../controllers/authorization/authorization");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const intake = require("../../controllers/leads/intake");
const webhooks = require("../../controllers/leads/webhooks");

const P = config.get("configDatabase").prefix;

/* ═══ Публічний прийом ═══ */

const publicHandle = (req, res) =>
	intake.handle(req, res).catch((e) => {
		logging.error(e);
		if (!res.headersSent) res.status(500).json({ ok: false, error: "server_error" });
	});
router.options(["/api/leads/v1/intake/", "/api/leads/add/:token/"], intake.preflight);
router.post(["/api/leads/v1/intake/", "/api/leads/add/:token/"], publicHandle);

/* ═══ Утиліти налаштувань ═══ */

const fmt = (d) => {
	if (!d) return null;
	const x = new Date(String(d).replace(" ", "T"));
	if (isNaN(x)) return String(d);
	const p = (n) => String(n).padStart(2, "0");
	return `${p(x.getHours())}:${p(x.getMinutes())} ${p(x.getDate())}.${p(x.getMonth() + 1)}.${x.getFullYear()}`;
};
const list = (val) => (Array.isArray(val) ? val : String(val || "").split(/[\n,]+/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 200);
const intOrNull = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const parse = (v, def) => {
	if (v === null || v === undefined) return def;
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return def;
	}
};
const userId = (req) => req.user.userId || req.user.id;
const baseUrl = (req) => String(process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
const bad = (res, message, status = 400) => res.status(status).json({ message });

/** Довідники для форми ключа (назви мовою користувача) */
async function dicts(idLang) {
	const dict = (table, fk, extra = "", where = "") =>
		pool.query(`SELECT d.id, COALESCE(dl.name, CONCAT('#', d.id)) AS name${extra} FROM \`${P}${table}\` d LEFT JOIN \`${P}${table}_lang\` dl ON dl.${fk} = d.id AND dl.id_lang = ? ${where} ORDER BY d.id`, [idLang]).then(([r]) => r);
	const [pipelines, stages, statuses, sources, priorities, tags, managers] = await Promise.all([
		dict("leads_pipelines", "id_pipeline"),
		dict("leads_pipeline_stages", "id_stage", ", d.id_pipeline", "WHERE d.is_active = 1"),
		dict("leads_settings_status", "id_status", "", "WHERE d.is_active = 1"),
		dict("leads_sources", "id_source", "", "WHERE d.is_active = 1"),
		dict("leads_priorities", "id_priority", "", "WHERE d.is_active = 1"),
		dict("leads_tags", "id_tag"),
		pool.query(`SELECT id, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM \`${P}users\` WHERE active = 1 ORDER BY first_name, last_name`).then(([r]) => r),
	]);
	return { pipelines, stages, statuses, sources, priorities, tags, managers };
}

/* ═══ Ключі прийому: сторінки ═══ */

router.get("/leads/settings/intake/", auth.isAuthenticated, (req, res) => {
	res.render("pages/leads/settings/intake", { i18n: req, user: req.user, header: { navbar: "leads" } });
});

router.get(["/leads/settings/intake/new/", "/leads/settings/intake/:id/"], auth.isAuthenticated, async (req, res, next) => {
	const tokenId = req.params.id ? Number(req.params.id) : null;
	if (req.params.id !== undefined && !(Number.isInteger(tokenId) && tokenId > 0)) return next();
	try {
		res.render("pages/leads/settings/intake-edit", {
			i18n: req,
			user: req.user,
			header: { navbar: "leads" },
			tokenId,
			endpoint: baseUrl(req) + "/api/leads/v1/intake/",
			d: await dicts(req.user.id_lang || 1),
		});
	} catch (e) {
		logging.error(e);
		next(e);
	}
});

/* ═══ Ключі прийому: API ═══ */


/** Тіло форми → колонки ключа або { error } */
async function tokenValues(b) {
	const name = String(b.name || "").trim().slice(0, 100);
	if (!name) return { error: "name" };
	const v = {
		name,
		allowed_domains: JSON.stringify(list(b.allowed_domains)),
		allowed_ips: JSON.stringify(list(b.allowed_ips)),
		source_check_mode: ["any", "all", "off"].includes(b.source_check_mode) ? b.source_check_mode : "any",
		id_pipeline: intOrNull(b.id_pipeline),
		id_stage: intOrNull(b.id_stage),
		id_status: intOrNull(b.id_status),
		id_source: intOrNull(b.id_source),
		id_priority: intOrNull(b.id_priority),
		id_manager: intOrNull(b.id_manager),
		tags: JSON.stringify((Array.isArray(b.tags) ? b.tags : []).map(intOrNull).filter(Boolean)),
		dedupe_hours: Math.min(720, Math.max(0, parseInt(b.dedupe_hours, 10) || 0)),
		rate_limit: Math.min(1000, Math.max(0, parseInt(b.rate_limit, 10) || 0)),
		honeypot: /^[A-Za-z0-9_-]{0,64}$/.test(String(b.honeypot || "")) ? String(b.honeypot || "") : "",
		notify_manager: b.notify_manager ? 1 : 0,
		success_redirect: /^https?:\/\//i.test(String(b.success_redirect || "")) ? String(b.success_redirect).slice(0, 500) : "",
		expires_at: /^\d{4}-\d{2}-\d{2}$/.test(String(b.expires_at || "")) ? b.expires_at : null,
		note: String(b.note || "").slice(0, 999),
	};
	// Відповідність полів: рядки «поле_форми = наше_поле»
	const map = {};
	for (const line of String(b.field_map || "").split("\n")) {
		const m = /^\s*([A-Za-z0-9_.\-[\]]{1,64})\s*=\s*([A-Za-z0-9_.]{1,70})\s*$/.exec(line);
		if (m) map[m[1]] = m[2];
	}
	v.field_map = JSON.stringify(map);
	// Етап — з вибраної воронки
	if (v.id_stage) {
		const [[st]] = await pool.query(`SELECT id_pipeline FROM \`${P}leads_pipeline_stages\` WHERE id = ?`, [v.id_stage]);
		if (!st || (v.id_pipeline && Number(st.id_pipeline) !== v.id_pipeline)) return { error: "stage" };
		if (!v.id_pipeline) v.id_pipeline = Number(st.id_pipeline);
	}
	return { value: v };
}

const tokenState = (t) => (t.revoked_at ? "revoked" : t.expires_at && new Date(String(t.expires_at).slice(0, 10) + "T23:59:59") < new Date() ? "expired" : Number(t.is_active) ? "active" : "disabled");

router.post("/api/leads/settings/intake/list/", auth.isAuthenticated, async (req, res) => {
	try {
		const [rows] = await pool.query(`SELECT id, name, prefix, last4, is_active, expires_at, revoked_at, usage_count, error_count, last_used_at, date_add FROM \`${P}leads_api_tokens\` ORDER BY id DESC`);
		res.json(rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, last4: r.last4, state: tokenState(r), usage_count: r.usage_count, error_count: r.error_count, last_used_at: fmt(r.last_used_at), date_add: fmt(r.date_add) })));
	} catch (e) {
		logging.error(e);
		bad(res, req.__("leads.server.server"), 500);
	}
});

router.post("/api/leads/settings/intake/get/", auth.isAuthenticated, async (req, res) => {
	try {
		const [[t]] = await pool.query(`SELECT *, INET6_NTOA(last_used_ip) AS last_ip FROM \`${P}leads_api_tokens\` WHERE id = ?`, [intOrNull((req.body || {}).id)]);
		if (!t) return bad(res, req.__("leads.server.not_found"), 404);
		const map = parse(t.field_map, {}) || {};
		res.json({
			id: t.id,
			name: t.name,
			prefix: t.prefix,
			last4: t.last4,
			state: tokenState(t),
			is_active: Number(t.is_active),
			allowed_domains: parse(t.allowed_domains, []),
			allowed_ips: parse(t.allowed_ips, []),
			source_check_mode: t.source_check_mode,
			id_pipeline: t.id_pipeline,
			id_stage: t.id_stage,
			id_status: t.id_status,
			id_source: t.id_source,
			id_priority: t.id_priority,
			id_manager: t.id_manager,
			tags: parse(t.tags, []),
			field_map: Object.entries(map).map(([k, v]) => `${k} = ${v}`).join("\n"),
			dedupe_hours: t.dedupe_hours,
			rate_limit: t.rate_limit,
			honeypot: t.honeypot,
			notify_manager: Number(t.notify_manager),
			success_redirect: t.success_redirect,
			expires_at: t.expires_at ? String(t.expires_at).slice(0, 10) : "",
			note: t.note,
			revoked_at: fmt(t.revoked_at),
			revoked_reason: t.revoked_reason,
			usage_count: t.usage_count,
			error_count: t.error_count,
			last_used_at: fmt(t.last_used_at),
			last_ip: t.last_ip,
			last_used_domain: t.last_used_domain,
		});
	} catch (e) {
		logging.error(e);
		bad(res, req.__("leads.server.server"), 500);
	}
});

router.post("/api/leads/settings/intake/generate/", auth.isAuthenticated, async (req, res) => {
	try {
		const r = await tokenValues(req.body || {});
		if (r.error) return bad(res, req.__("leads.intake.e." + r.error));
		let raw;
		let hash;
		for (let i = 0; i < 5; i++) {
			raw = "lk_" + crypto.randomBytes(20).toString("hex");
			hash = intake.hashToken(raw);
			const [[dup]] = await pool.query(`SELECT id FROM \`${P}leads_api_tokens\` WHERE token_hash = ?`, [hash]);
			if (!dup) break;
		}
		const v = { ...r.value, prefix: raw.slice(0, 11), token_hash: hash, last4: raw.slice(-4), is_active: 1, id_user: userId(req) };
		const [ins] = await pool.query(`INSERT INTO \`${P}leads_api_tokens\` SET ?, date_add = NOW(), date_edit = NOW()`, [v]);
		require("../../controllers/common/audit").log(req, { action: "create", module: "leads", entity: "intake_token", id_entity: ins.insertId, count: 1 });
		res.json({ ok: true, id: ins.insertId, token: raw });
	} catch (e) {
		logging.error(e);
		bad(res, req.__("leads.server.server"), 500);
	}
});

router.post("/api/leads/settings/intake/update/", auth.isAuthenticated, async (req, res) => {
	try {
		const b = req.body || {};
		const id = intOrNull(b.id);
		const [[cur]] = await pool.query(`SELECT revoked_at FROM \`${P}leads_api_tokens\` WHERE id = ?`, [id]);
		if (!cur) return bad(res, req.__("leads.server.not_found"), 404);
		if (cur.revoked_at) return bad(res, req.__("leads.intake.e.revoked"));
		const r = await tokenValues(b);
		if (r.error) return bad(res, req.__("leads.intake.e." + r.error));
		await pool.query(`UPDATE \`${P}leads_api_tokens\` SET ?, is_active = ?, date_edit = NOW() WHERE id = ?`, [r.value, b.is_active ? 1 : 0, id]);
		res.json({ ok: true });
	} catch (e) {
		logging.error(e);
		bad(res, req.__("leads.server.server"), 500);
	}
});

router.post("/api/leads/settings/intake/revoke/", auth.isAuthenticated, async (req, res) => {
	try {
		const b = req.body || {};
		const [r] = await pool.query(`UPDATE \`${P}leads_api_tokens\` SET revoked_at = NOW(), revoked_by = ?, revoked_reason = ?, is_active = 0, date_edit = NOW() WHERE id = ? AND revoked_at IS NULL`, [userId(req), String(b.reason || "").slice(0, 255) || null, intOrNull(b.id)]);
		if (!r.affectedRows) return bad(res, req.__("leads.intake.e.revoked"));
		res.json({ ok: true });
	} catch (e) {
		logging.error(e);
		bad(res, req.__("leads.server.server"), 500);
	}
});

router.post("/api/leads/settings/intake/delete/", auth.isAuthenticated, async (req, res) => {
	try {
		const id = intOrNull((req.body || {}).id);
		const [r] = await pool.query(`DELETE FROM \`${P}leads_api_tokens\` WHERE id = ?`, [id]);
		if (!r.affectedRows) return bad(res, req.__("leads.server.not_found"), 404);
		await pool.query(`UPDATE \`${P}leads_api_log\` SET id_token = NULL WHERE id_token = ?`, [id]);
		require("../../controllers/common/audit").log(req, { action: "delete", module: "leads", entity: "intake_token", id_entity: id, count: 1 });
		res.json({ ok: true });
	} catch (e) {
		logging.error(e);
		bad(res, req.__("leads.server.server"), 500);
	}
});

/** Журнал запитів ключа: сторінки й фільтр — на сервері */
router.post("/api/leads/settings/intake/log/", auth.isAuthenticated, async (req, res) => {
	try {
		const b = req.body || {};
		const size = [20, 50, 100].includes(Number(b.size)) ? Number(b.size) : 20;
		const page = Math.max(1, parseInt(b.page, 10) || 1);
		const where = ["id_token = ?"];
		const params = [intOrNull(b.id)];
		if (["success", "duplicate", "spam", "rejected"].includes(b.result)) {
			where.push("result = ?");
			params.push(b.result);
		}
		const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM \`${P}leads_api_log\` WHERE ${where.join(" AND ")}`, params);
		const [rows] = await pool.query(
			`SELECT id, INET6_NTOA(ip) AS ip, domain, result, reject_reason, http_status, id_lead, payload, message, date_add FROM \`${P}leads_api_log\` WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`,
			[...params, size, (page - 1) * size]
		);
		res.json({ last_page: Math.max(1, Math.ceil(total / size)), data: rows.map((r) => ({ ...r, payload: parse(r.payload, null), date_add: fmt(r.date_add) })) });
	} catch (e) {
		logging.error(e);
		bad(res, req.__("leads.server.server"), 500);
	}
});

/* ═══ Вебхуки: сторінки ═══ */

router.get("/leads/settings/webhooks/", auth.isAuthenticated, (req, res) => {
	res.render("pages/leads/settings/webhooks", { i18n: req, user: req.user, header: { navbar: "leads" } });
});

router.get(["/leads/settings/webhooks/new/", "/leads/settings/webhooks/:id/"], auth.isAuthenticated, (req, res, next) => {
	const hookId = req.params.id ? Number(req.params.id) : null;
	if (req.params.id !== undefined && !(Number.isInteger(hookId) && hookId > 0)) return next();
	res.render("pages/leads/settings/webhook-edit", { i18n: req, user: req.user, header: { navbar: "leads" }, hookId, events: webhooks.EVENTS });
});

/* ═══ Вебхуки: API ═══ */

router.post("/api/leads/settings/webhooks/list/", auth.isAuthenticated, async (req, res) => {
	try {
		const [rows] = await pool.query(`SELECT id, name, url, events, is_active, last_status, last_sent_at, fail_count, date_add FROM \`${P}leads_webhooks\` ORDER BY id DESC`);
		res.json(rows.map((r) => ({ ...r, events: parse(r.events, []), last_sent_at: fmt(r.last_sent_at), date_add: fmt(r.date_add) })));
	} catch (e) {
		logging.error(e);
		bad(res, req.__("leads.server.server"), 500);
	}
});

router.post("/api/leads/settings/webhooks/get/", auth.isAuthenticated, async (req, res) => {
	try {
		const [[w]] = await pool.query(`SELECT * FROM \`${P}leads_webhooks\` WHERE id = ?`, [intOrNull((req.body || {}).id)]);
		if (!w) return bad(res, req.__("leads.server.not_found"), 404);
		const headers = parse(w.headers, {}) || {};
		res.json({ ...w, events: parse(w.events, []), headers: Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\n"), secret: w.secret || "", last_sent_at: fmt(w.last_sent_at) });
	} catch (e) {
		logging.error(e);
		bad(res, req.__("leads.server.server"), 500);
	}
});

router.post("/api/leads/settings/webhooks/save/", auth.isAuthenticated, async (req, res) => {
	try {
		const b = req.body || {};
		const id = intOrNull(b.id);
		const url = String(b.url || "").trim().slice(0, 1000);
		const urlErr = await webhooks.checkUrl(url);
		if (urlErr) return bad(res, req.__("leads.webhooks.e." + urlErr));
		const events = (Array.isArray(b.events) ? b.events : []).filter((e) => webhooks.EVENTS.includes(e));
		if (!events.length) return bad(res, req.__("leads.webhooks.e.events"));
		const headers = {};
		for (const line of String(b.headers || "").split("\n")) {
			const m = /^\s*([A-Za-z0-9-]{1,64})\s*:\s*(.{1,1000})$/.exec(line);
			if (m && !/^(host|content-length|content-type)$/i.test(m[1])) headers[m[1]] = m[2].trim();
		}
		const v = {
			name: String(b.name || "").trim().slice(0, 100) || url.replace(/^https?:\/\//, "").slice(0, 100),
			url,
			method: b.method === "PUT" ? "PUT" : "POST",
			events: JSON.stringify(events),
			headers: JSON.stringify(headers),
			secret: String(b.secret || "").slice(0, 255) || null,
			is_active: b.is_active ? 1 : 0,
			note: String(b.note || "").slice(0, 999),
		};
		if (id) {
			const [r] = await pool.query(`UPDATE \`${P}leads_webhooks\` SET ?, date_edit = NOW() WHERE id = ?`, [v, id]);
			if (!r.affectedRows) return bad(res, req.__("leads.server.not_found"), 404);
			return res.json({ ok: true, id });
		}
		if (!v.secret) v.secret = crypto.randomBytes(24).toString("hex");
		const [ins] = await pool.query(`INSERT INTO \`${P}leads_webhooks\` SET ?, date_add = NOW(), date_edit = NOW()`, [v]);
		res.json({ ok: true, id: ins.insertId });
	} catch (e) {
		logging.error(e);
		bad(res, req.__("leads.server.server"), 500);
	}
});

router.post("/api/leads/settings/webhooks/delete/", auth.isAuthenticated, async (req, res) => {
	try {
		const id = intOrNull((req.body || {}).id);
		await pool.query(`DELETE FROM \`${P}leads_webhooks_log\` WHERE id_webhook = ?`, [id]);
		const [r] = await pool.query(`DELETE FROM \`${P}leads_webhooks\` WHERE id = ?`, [id]);
		if (!r.affectedRows) return bad(res, req.__("leads.server.not_found"), 404);
		res.json({ ok: true });
	} catch (e) {
		logging.error(e);
		bad(res, req.__("leads.server.server"), 500);
	}
});

router.post("/api/leads/settings/webhooks/test/", auth.isAuthenticated, async (req, res) => {
	try {
		const r = await webhooks.test(intOrNull((req.body || {}).id));
		if (!r) return bad(res, req.__("leads.server.not_found"), 404);
		res.json({ ok: r.ok, code: r.code, error: r.error, body: (r.body || "").slice(0, 500) });
	} catch (e) {
		logging.error(e);
		bad(res, req.__("leads.server.server"), 500);
	}
});

router.post("/api/leads/settings/webhooks/retry/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json({ ok: await webhooks.retry(intOrNull((req.body || {}).id)) });
	} catch (e) {
		logging.error(e);
		bad(res, req.__("leads.server.server"), 500);
	}
});

router.post("/api/leads/settings/webhooks/log/", auth.isAuthenticated, async (req, res) => {
	try {
		const b = req.body || {};
		const size = [20, 50, 100].includes(Number(b.size)) ? Number(b.size) : 20;
		const page = Math.max(1, parseInt(b.page, 10) || 1);
		const where = ["id_webhook = ?"];
		const params = [intOrNull(b.id)];
		if (["success", "pending", "failed"].includes(b.result)) {
			where.push("result = ?");
			params.push(b.result);
		}
		const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM \`${P}leads_webhooks_log\` WHERE ${where.join(" AND ")}`, params);
		const [rows] = await pool.query(
			`SELECT id, id_lead, event, result, attempt, response_code, response_body, error, next_attempt_at, date_add, date_sent FROM \`${P}leads_webhooks_log\` WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`,
			[...params, size, (page - 1) * size]
		);
		res.json({ last_page: Math.max(1, Math.ceil(total / size)), data: rows.map((r) => ({ ...r, date_add: fmt(r.date_add), date_sent: fmt(r.date_sent), next_attempt_at: fmt(r.next_attempt_at) })) });
	} catch (e) {
		logging.error(e);
		bad(res, req.__("leads.server.server"), 500);
	}
});

module.exports = router;