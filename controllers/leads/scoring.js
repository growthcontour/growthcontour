"use strict";

/**
 * Автоматичний скоринг лідів.
 *
 * Дві складові, як і раніше: score_fit (наскільки лід «наш» — за даними) і score_activity (наскільки він живий — за діями).
 * score = fit + activity (0–100), grade: A ≥ 80, B ≥ 60, C ≥ 40, інакше D.
 * Правила — leads_score_rules (назва — leads_score_rules_lang), score_type fit | activity, score_delta — бали (може бути від'ємним).
 *
 * fit — condition { field, op, value }:
 *   filled:     contact.phone | contact.email | contact.company | contact.position | contact.name | website | note — заповнено;
 *   corporate:  email — не з безкоштовної пошти (gmail, outlook, yahoo…, перелік FREE_MAIL);
 *   gte / lte:  value (сума);
 *   in:         id_source | id_pipeline | id_priority | id_temperature | id_qualification | capture_type — одне зі значень;
 *   has:        tag — має тег;  starts: phone — номер починається з коду (+48, +1…);
 *   eq / contains: utm_source | utm_medium | utm_campaign — мітка дорівнює / містить (без регістру).
 * activity — condition { type: тип активності | "any", direction: any | inbound | outbound, days, max }:
 *   кожна виконана активність за останні days днів дає score_delta; разом з правила — не більше max (0 — без обмеження).
 *   Старі активності «згасають»: score_decay_at — коли найближча з них вийде з вікна, і бал перерахується.
 *
 * Якщо активних правил якогось типу немає — ця складова лишається ручною (поле на картці ліда).
 * Перерахунок: збереження ліда, активності, створення (одразу); зміни іншими шляхами й згасання — фонова служба
 * (ліди, змінені після останнього перерахунку score_at, і ті, в кого настав score_decay_at). Зміна правил — повний перерахунок
 * відкритих лідів фоном. Кожна зміна складової — у журнал leads_score_log, зміна оцінки (grade) — в історію ліда.
 */

const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");

const P = config.get("configDatabase").prefix;
const TYPES = ["fit", "activity"];
const FILLED = ["contact.phone", "contact.email", "contact.name", "contact.company", "contact.position", "website", "note"];
const IN_FIELDS = ["id_source", "id_pipeline", "id_priority", "id_temperature", "id_qualification", "capture_type"];
const UTM = ["utm_source", "utm_medium", "utm_campaign"];
const ACT_TYPES = ["any", "call", "email", "meeting", "task", "note", "whatsapp", "telegram", "viber", "sms", "demo", "other"];
const FREE_MAIL = new Set(
	"gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com icloud.com me.com mac.com aol.com proton.me protonmail.com gmx.com gmx.de gmx.net web.de mail.com yandex.com yandex.ru mail.ru inbox.ru list.ru bk.ru ukr.net i.ua meta.ua zoho.com tutanota.com fastmail.com qq.com 163.com 126.com naver.com wp.pl o2.pl interia.pl onet.pl seznam.cz libero.it orange.fr free.fr laposte.net t-online.de".split(" ")
);

const parse = (v, def) => {
	if (v === null || v === undefined) return def;
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return def;
	}
};
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const gradeOf = (s) => (s >= 80 ? "A" : s >= 60 ? "B" : s >= 40 ? "C" : "D");

/* ═══ Правила ═══ */

let cache = null;
let cacheAt = 0;
async function activeRules() {
	if (cache && Date.now() - cacheAt < 60000) return cache;
	const [rows] = await pool.query(
		`SELECT r.id, r.score_type, r.condition, r.score_delta, COALESCE(rl.name, CONCAT('#', r.id)) AS name
		   FROM \`${P}leads_score_rules\` r LEFT JOIN \`${P}leads_score_rules_lang\` rl ON rl.id_rule = r.id AND rl.id_lang = 1
		  WHERE r.is_active = 1 ORDER BY r.sort, r.id`
	);
	cache = rows.map((r) => ({ ...r, condition: parse(r.condition, {}) || {} }));
	cacheAt = Date.now();
	return cache;
}

/** Які складові рахуються автоматично (є активні правила) */
async function autoTypes() {
	const rules = await activeRules();
	return { fit: rules.some((r) => r.score_type === "fit"), activity: rules.some((r) => r.score_type === "activity") };
}

async function list(idLang) {
	const [rows] = await pool.query(
		`SELECT r.id, r.score_type, r.condition, r.score_delta, r.is_active, r.sort, COALESCE(rl.name, CONCAT('#', r.id)) AS name
		   FROM \`${P}leads_score_rules\` r LEFT JOIN \`${P}leads_score_rules_lang\` rl ON rl.id_rule = r.id AND rl.id_lang = ?
		  ORDER BY r.score_type, r.sort, r.id`,
		[Number(idLang) || 1]
	);
	return rows.map((r) => ({ ...r, condition: parse(r.condition, {}) || {} }));
}

/** Умова з форми → чиста умова або null */
function cleanCondition(type, c) {
	c = c && typeof c === "object" ? c : {};
	const ids = (a) => [...new Set((Array.isArray(a) ? a : String(a || "").split(",")).map((x) => String(x).trim()).filter(Boolean))].slice(0, 100);
	if (type === "activity") {
		return {
			type: ACT_TYPES.includes(c.type) ? c.type : "any",
			direction: ["any", "inbound", "outbound"].includes(c.direction) ? c.direction : "any",
			days: Math.max(1, Math.min(365, parseInt(c.days, 10) || 30)),
			max: Math.max(0, Math.min(100, parseInt(c.max, 10) || 0)),
		};
	}
	const f = String(c.field || "");
	if (c.op === "filled" && FILLED.includes(f)) return { field: f, op: "filled" };
	if (c.op === "corporate") return { field: "contact.email", op: "corporate" };
	if ((c.op === "gte" || c.op === "lte") && f === "value" && Number.isFinite(Number(c.value))) return { field: "value", op: c.op, value: Math.max(0, Number(c.value)) };
	if (c.op === "in" && IN_FIELDS.includes(f)) {
		const v = f === "capture_type" ? ids(c.value) : ids(c.value).map(Number).filter((x) => x > 0);
		return v.length ? { field: f, op: "in", value: v } : null;
	}
	if (c.op === "has" && f === "tag" && parseInt(c.value, 10) > 0) return { field: "tag", op: "has", value: parseInt(c.value, 10) };
	if (c.op === "starts" && f === "phone") {
		const v = ids(c.value).map((x) => x.replace(/[^\d+]/g, "")).filter((x) => /^\+?\d{1,6}$/.test(x));
		return v.length ? { field: "phone", op: "starts", value: v } : null;
	}
	if ((c.op === "eq" || c.op === "contains") && UTM.includes(f) && String(c.value || "").trim()) return { field: f, op: c.op, value: String(c.value).trim().slice(0, 255) };
	return null;
}

async function save(b, idLang) {
	const errors = {};
	const name = String(b.name || "").trim().slice(0, 255);
	if (!name) errors.name = "leads.scoring.e.name";
	const type = TYPES.includes(b.score_type) ? b.score_type : "fit";
	const condition = cleanCondition(type, b.condition);
	if (!condition) errors.condition = "leads.scoring.e.condition";
	const delta = parseInt(b.score_delta, 10);
	if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 100) errors.score_delta = "leads.scoring.e.delta";
	if (Object.keys(errors).length) return { errors };
	const row = { score_type: type, condition: JSON.stringify(condition), score_delta: delta, is_active: b.is_active ? 1 : 0, sort: Math.max(0, Math.min(100000, parseInt(b.sort, 10) || 0)) };
	const id = parseInt(b.id, 10) || 0;
	const conn = await pool.getConnection();
	let ruleId = id;
	try {
		await conn.beginTransaction();
		if (id) {
			const [r] = await conn.query(`UPDATE \`${P}leads_score_rules\` SET ?, date_edit = NOW() WHERE id = ?`, [row, id]);
			if (!r.affectedRows) throw Object.assign(new Error("leads.server.not_found"), { status: 404 });
		} else {
			const [r] = await conn.query(`INSERT INTO \`${P}leads_score_rules\` SET ?, date_add = NOW(), date_edit = NOW()`, [row]);
			ruleId = r.insertId;
		}
		await conn.query(`INSERT INTO \`${P}leads_score_rules_lang\` (id_rule, id_lang, name) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`, [ruleId, Number(idLang) || 1, name]);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	await requeueAll();
	return { ok: true, id: ruleId };
}

async function remove(id) {
	await pool.query(`DELETE FROM \`${P}leads_score_rules_lang\` WHERE id_rule = ?`, [id]);
	const [r] = await pool.query(`DELETE FROM \`${P}leads_score_rules\` WHERE id = ?`, [id]);
	await requeueAll();
	return { ok: !!r.affectedRows };
}

/** Правила змінились — перерахувати відкриті ліди фоном */
async function requeueAll() {
	cache = null;
	await pool.query(
		`UPDATE \`${P}leads\` l SET l.score_at = NULL
		  WHERE l.deleted_at IS NULL AND l.is_converted = 0
		    AND NOT EXISTS (SELECT 1 FROM \`${P}leads_settings_status\` st WHERE st.id = l.id_status AND st.system_type IN ('won', 'lost'))`
	);
}

/* ═══ Розрахунок ═══ */

function fitMatch(c, lead, tags) {
	const ci = lead.contact;
	const get = (f) => (f.startsWith("contact.") ? ci[f.slice(8)] : lead[f]);
	switch (c.op) {
		case "filled":
			return String(get(c.field) ?? "").trim() !== "";
		case "corporate": {
			const m = /@([^@\s]+)$/.exec(String(ci.email || "").trim().toLowerCase());
			return !!m && !FREE_MAIL.has(m[1]);
		}
		case "gte":
			return Number(lead.value || 0) >= Number(c.value);
		case "lte":
			return Number(lead.value || 0) <= Number(c.value);
		case "in":
			return c.field === "capture_type" ? c.value.includes(String(lead.capture_type || "")) : c.value.includes(Number(lead[c.field]));
		case "has":
			return tags.includes(Number(c.value));
		case "starts": {
			const phone = String(ci.phone || "").replace(/[^\d+]/g, "");
			const digits = phone.replace(/\D/g, "");
			return c.value.some((p) => (p.startsWith("+") ? phone.startsWith(p) || digits.startsWith(p.slice(1)) : digits.startsWith(p)));
		}
		case "eq":
		case "contains": {
			const v = String((lead.utm || {})[c.field] || "").toLowerCase();
			const want = String(c.value).toLowerCase();
			return c.op === "eq" ? v === want : !!v && v.includes(want);
		}
	}
	return false;
}

/** Розклад балів ліда: [{ id, name, type, delta, hits? }], підсумки fit / activity і коли перерахувати через згасання */
async function breakdown(idLead) {
	const rules = await activeRules();
	const [[l]] = await pool.query(`SELECT id, value, note, website, capture_type, contact_info, utm, id_source, id_pipeline, id_priority, id_temperature, id_qualification, score_fit, score_activity FROM \`${P}leads\` WHERE id = ?`, [idLead]);
	if (!l) return null;
	l.contact = parse(l.contact_info, {}) || {};
	l.utm = parse(l.utm, {}) || {};
	const [tagRows] = await pool.query(`SELECT id_tag FROM \`${P}leads_tags_rel\` WHERE id_lead = ?`, [idLead]);
	const tags = tagRows.map((r) => Number(r.id_tag));
	const fitRules = rules.filter((r) => r.score_type === "fit");
	const actRules = rules.filter((r) => r.score_type === "activity");
	const items = [];
	let fit = 0;
	for (const r of fitRules) {
		if (!fitMatch(r.condition, l, tags)) continue;
		fit += Number(r.score_delta);
		items.push({ id: r.id, name: r.name, type: "fit", delta: Number(r.score_delta) });
	}
	let act = 0;
	let decayAt = null;
	if (actRules.length) {
		const maxDays = Math.max(...actRules.map((r) => Number(r.condition.days) || 30));
		const [acts] = await pool.query(
			`SELECT type, direction, done_at, TIMESTAMPDIFF(SECOND, done_at, NOW()) AS age FROM \`${P}leads_activities\`
			  WHERE id_lead = ? AND status = 'done' AND deleted_at IS NULL AND done_at > NOW() - INTERVAL ? DAY`,
			[idLead, maxDays]
		);
		for (const r of actRules) {
			const c = r.condition;
			const win = (Number(c.days) || 30) * 86400;
			const hit = acts.filter((a) => Number(a.age) < win && (c.type === "any" || a.type === c.type) && (c.direction === "any" || a.direction === c.direction));
			if (!hit.length) continue;
			let pts = hit.length * Number(r.score_delta);
			if (Number(c.max) > 0) pts = Math.sign(pts) * Math.min(Math.abs(pts), Number(c.max));
			act += pts;
			items.push({ id: r.id, name: r.name, type: "activity", delta: pts, hits: hit.length });
			// Найближче згасання: коли найстаріша з урахованих активностей вийде з вікна
			const oldest = Math.max(...hit.map((a) => Number(a.age)));
			const leftSec = win - oldest;
			const at = new Date(Date.now() + Math.max(60, leftSec) * 1000);
			if (!decayAt || at < decayAt) decayAt = at;
		}
	}
	return {
		auto: { fit: fitRules.length > 0, activity: actRules.length > 0 },
		fit: fitRules.length ? clamp(fit) : Number(l.score_fit) || 0,
		activity: actRules.length ? clamp(act) : Number(l.score_activity) || 0,
		items,
		decayAt,
		current: { fit: Number(l.score_fit) || 0, activity: Number(l.score_activity) || 0 },
	};
}

/** Перерахувати лід: оновити бали, журнал, історію (якщо змінилась оцінка). Повертає { score, grade, changed } */
async function recalc(idLead) {
	try {
		const b = await breakdown(idLead);
		if (!b) return null;
		const [[l]] = await pool.query(`SELECT score, grade FROM \`${P}leads\` WHERE id = ?`, [idLead]);
		const score = clamp(b.fit + b.activity);
		const grade = gradeOf(score);
		const changed = b.fit !== b.current.fit || b.activity !== b.current.activity || score !== Number(l.score) || grade !== l.grade;
		// date_edit не чіпаємо: перерахунок — не зміна ліда людиною (інакше відкрита форма отримала б «конфлікт»)
		await pool.query(`UPDATE \`${P}leads\` SET score_fit = ?, score_activity = ?, score = ?, grade = ?, score_decay_at = ?, score_at = NOW() WHERE id = ?`, [b.fit, b.activity, score, grade, b.decayAt, idLead]);
		if (changed) {
			const reason = b.items.map((i) => `${i.name} ${i.delta > 0 ? "+" : ""}${i.delta}`).join("; ").slice(0, 500);
			const logs = [];
			if (b.fit !== b.current.fit) logs.push([idLead, "fit", b.fit - b.current.fit, score, reason]);
			if (b.activity !== b.current.activity) logs.push([idLead, "activity", b.activity - b.current.activity, score, reason]);
			if (logs.length) await pool.query(`INSERT INTO \`${P}leads_score_log\` (id_lead, score_type, delta, score_after, reason, date_add) VALUES ${logs.map(() => "(?, ?, ?, ?, ?, NOW())").join(", ")}`, logs.flat());
			if (grade !== l.grade) {
				await pool.query(
					`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES (?, NULL, 'score_change', 'grade', ?, ?, ?, 'system', NULL, NOW())`,
					[idLead, `${l.score} / ${l.grade}`, `${score} / ${grade}`, reason || null]
				);
			}
		}
		return { score, grade, changed };
	} catch (e) {
		logging.error(e);
		return null;
	}
}

/** Фонова служба: змінені ліди, нові, після зміни правил і ті, в кого настало згасання */
async function tick() {
	const rules = await activeRules();
	if (!rules.length) return;
	const [rows] = await pool.query(
		`SELECT id FROM \`${P}leads\`
		  WHERE deleted_at IS NULL AND (score_at IS NULL OR date_edit > score_at OR (score_decay_at IS NOT NULL AND score_decay_at <= NOW()))
		  ORDER BY id DESC LIMIT 300`
	);
	for (const r of rows) await recalc(r.id);
}

module.exports = { TYPES, FILLED, IN_FIELDS, UTM, ACT_TYPES, list, save, remove, autoTypes, breakdown, recalc, tick, gradeOf };