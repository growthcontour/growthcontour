"use strict";

/**
 * Розподіл нових лідів і сповіщення отримувачів модуля лідів.
 *
 * Правила (leads_routing_rules, назва — leads_routing_rules_lang): перевіряються за порядком (sort, id), спрацьовує перше,
 * чиї умови збіглися. Діє лише на лід без відповідального.
 *   conditions (JSON, усі задані умови мають збігтися; порожня умова — «будь-що»):
 *     sources: [id джерела], capture: ["api","webchat","contact-center","manual"], pipelines: [id воронки],
 *     phone_prefix: ["+48", "+380"] — початок номера (міжнародний формат, без прив'язки до країни),
 *     value_min / value_max — сума, days: [1..7] (1 — понеділок), time_from / time_to "HH:MM" — час сервера.
 *   assign_mode: fixed — id_manager; round_robin — по черзі між активними користувачами групи id_team;
 *                least_loaded — тому з групи, у кого найменше відкритих лідів.
 *   id_pipeline / id_stage (необов'язково) — перемістити лід у цю воронку / етап.
 * Черга round_robin — за історією ліда (action auto_assigned, field_name = rule:ID): наступним іде той, кому
 *   найдавніше призначали за цим правилом; вибір і запис — під GET_LOCK правила (кілька процесів pm2).
 *
 * Отримувачі (notif_recipients, scope leads / 0), події: new_all — кожен новий лід, new_unassigned — новий лід,
 *   який не вдалося розподілити, sla_unassigned — минув час відповіді в ліда без відповідального,
 *   sla_all — минув час відповіді в будь-якого ліда (для керівників).
 *
 * onNew(id) викликають: створення вручну, прийом із сайтів (intake), фонова служба — для лідів з інших джерел (чат, контакт-центр).
 */

const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const i18n = require("../../config/i18n/i18n");

const P = config.get("configDatabase").prefix;
const LOCALE = process.env.APP_LOCALE || "uk";
const tSys = (phrase, vars) => i18n.__({ phrase, locale: LOCALE }, vars || {});
const MODES = ["fixed", "round_robin", "least_loaded"];
const CAPTURE = ["api", "webchat", "contact-center", "manual"];
const SCOPE = "leads";
const SCOPE_REF = "0";
const EVENTS = ["new_all", "new_unassigned", "sla_unassigned", "sla_all"];

const parse = (v, def) => {
	if (v === null || v === undefined) return def;
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return def;
	}
};
const ids = (a) => [...new Set((Array.isArray(a) ? a : []).map((x) => parseInt(x, 10)).filter((x) => x > 0))].slice(0, 200);
const hhmm = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || "")) ? String(v) : "");

/* ═══ Правила: читання й збереження ═══ */

async function list(idLang) {
	const [rows] = await pool.query(
		`SELECT r.id, r.conditions, r.id_pipeline, r.id_stage, r.id_manager, r.id_team, r.assign_mode, r.is_active, r.sort,
		        COALESCE(rl.name, CONCAT('#', r.id)) AS name, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS manager_name
		   FROM \`${P}leads_routing_rules\` r
		   LEFT JOIN \`${P}leads_routing_rules_lang\` rl ON rl.id_rule = r.id AND rl.id_lang = ?
		   LEFT JOIN \`${P}users\` u ON u.id = r.id_manager
		  ORDER BY r.sort, r.id`,
		[Number(idLang) || 1]
	);
	return rows.map((r) => ({ ...r, conditions: parse(r.conditions, {}) || {} }));
}

/** Тіло форми → чисті умови й дія; помилки по полях */
function clean(b) {
	const c = b.conditions && typeof b.conditions === "object" ? b.conditions : {};
	const num = (v) => (v === "" || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v)));
	const conditions = {
		sources: ids(c.sources),
		capture: (Array.isArray(c.capture) ? c.capture : []).filter((x) => CAPTURE.includes(x)),
		pipelines: ids(c.pipelines),
		phone_prefix: (Array.isArray(c.phone_prefix) ? c.phone_prefix : String(c.phone_prefix || "").split(/[\s,;]+/))
			.map((x) => String(x).trim().replace(/[^\d+]/g, ""))
			.filter((x) => /^\+?\d{1,6}$/.test(x))
			.slice(0, 50),
		value_min: num(c.value_min),
		value_max: num(c.value_max),
		days: ids(c.days).filter((d) => d >= 1 && d <= 7),
		time_from: hhmm(c.time_from),
		time_to: hhmm(c.time_to),
	};
	const errors = {};
	const name = String(b.name || "").trim().slice(0, 255);
	if (!name) errors.name = "leads.routing.e.name";
	const mode = MODES.includes(b.assign_mode) ? b.assign_mode : "fixed";
	const id_manager = parseInt(b.id_manager, 10) || null;
	const id_team = parseInt(b.id_team, 10) || null;
	if (mode === "fixed" && !id_manager) errors.id_manager = "leads.routing.e.manager";
	if (mode !== "fixed" && !id_team) errors.id_team = "leads.routing.e.team";
	if ((conditions.time_from && !conditions.time_to) || (!conditions.time_from && conditions.time_to)) errors.time_to = "leads.routing.e.time";
	if (conditions.value_min !== null && conditions.value_max !== null && conditions.value_min > conditions.value_max) errors.value_max = "leads.routing.e.range";
	return {
		errors,
		row: {
			conditions: JSON.stringify(conditions),
			assign_mode: mode,
			id_manager: mode === "fixed" ? id_manager : null,
			id_team: mode === "fixed" ? null : id_team,
			id_pipeline: parseInt(b.id_pipeline, 10) || null,
			id_stage: parseInt(b.id_stage, 10) || null,
			is_active: b.is_active ? 1 : 0,
			sort: Math.max(0, Math.min(100000, parseInt(b.sort, 10) || 0)),
		},
		name,
	};
}

async function save(b, idLang) {
	const { errors, row, name } = clean(b || {});
	if (row.id_stage) {
		const [[st]] = await pool.query(`SELECT id_pipeline FROM \`${P}leads_pipeline_stages\` WHERE id = ?`, [row.id_stage]);
		if (!st || (row.id_pipeline && Number(st.id_pipeline) !== Number(row.id_pipeline))) errors.id_stage = "leads.routing.e.stage";
		else row.id_pipeline = Number(st.id_pipeline);
	}
	if (Object.keys(errors).length) return { errors };
	const id = parseInt(b.id, 10) || 0;
	const conn = await pool.getConnection();
	let ruleId = id;
	try {
		await conn.beginTransaction();
		if (id) {
			const [r] = await conn.query(`UPDATE \`${P}leads_routing_rules\` SET ?, date_edit = NOW() WHERE id = ?`, [row, id]);
			if (!r.affectedRows) throw Object.assign(new Error("leads.server.not_found"), { status: 404 });
		} else {
			const [r] = await conn.query(`INSERT INTO \`${P}leads_routing_rules\` SET ?, date_add = NOW(), date_edit = NOW()`, [row]);
			ruleId = r.insertId;
		}
		await conn.query(`INSERT INTO \`${P}leads_routing_rules_lang\` (id_rule, id_lang, name) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`, [ruleId, Number(idLang) || 1, name]);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	return { ok: true, id: ruleId };
}

async function remove(id) {
	await pool.query(`DELETE FROM \`${P}leads_routing_rules_lang\` WHERE id_rule = ?`, [id]);
	const [r] = await pool.query(`DELETE FROM \`${P}leads_routing_rules\` WHERE id = ?`, [id]);
	return { ok: !!r.affectedRows };
}

/* ═══ Розподіл ═══ */

/** Чи підходить лід під умови правила (now — для перевірки днів і часу) */
function matches(c, lead, now) {
	const phone = String((lead.contact && lead.contact.phone) || "").replace(/[^\d+]/g, "");
	const digits = phone.replace(/\D/g, "");
	if (c.sources && c.sources.length && !c.sources.includes(Number(lead.id_source))) return false;
	if (c.capture && c.capture.length && !c.capture.includes(String(lead.capture_type || ""))) return false;
	if (c.pipelines && c.pipelines.length && !c.pipelines.includes(Number(lead.id_pipeline))) return false;
	if (c.phone_prefix && c.phone_prefix.length && !c.phone_prefix.some((p) => (p.startsWith("+") ? phone.startsWith(p) || digits.startsWith(p.slice(1)) : digits.startsWith(p)))) return false;
	const v = Number(lead.value) || 0;
	if (c.value_min !== null && c.value_min !== undefined && v < Number(c.value_min)) return false;
	if (c.value_max !== null && c.value_max !== undefined && v > Number(c.value_max)) return false;
	const dow = now.getDay() === 0 ? 7 : now.getDay();
	if (c.days && c.days.length && !c.days.includes(dow)) return false;
	if (c.time_from && c.time_to) {
		const cur = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
		// Нічна зміна: 22:00–06:00
		const inside = c.time_from <= c.time_to ? cur >= c.time_from && cur < c.time_to : cur >= c.time_from || cur < c.time_to;
		if (!inside) return false;
	}
	return true;
}

/** Активні групи користувачів (для вибору команди й отримувачів) */
async function groups(idLang) {
	const [rows] = await pool.query(
		`SELECT g.id, COALESCE(gl.name, CONCAT('#', g.id)) AS name FROM \`${P}users_groups\` g
		   LEFT JOIN \`${P}users_groups_lang\` gl ON gl.id_group = g.id AND gl.id_lang = ?
		  WHERE g.active = 1 ORDER BY gl.name, g.id`,
		[Number(idLang) || 1]
	);
	return rows;
}

/** Активні користувачі групи */
async function members(conn, idTeam) {
	const [rows] = await conn.query(`SELECT u.id FROM \`${P}users_to_groups\` g JOIN \`${P}users\` u ON u.id = g.id_user AND u.active = 1 WHERE g.id_group = ? ORDER BY u.id`, [idTeam]);
	return rows.map((r) => r.id);
}

async function pick(conn, rule) {
	if (rule.assign_mode === "fixed") {
		const [[u]] = await conn.query(`SELECT id FROM \`${P}users\` WHERE id = ? AND active = 1`, [rule.id_manager]);
		return u ? u.id : null;
	}
	const team = await members(conn, rule.id_team);
	if (!team.length) return null;
	if (rule.assign_mode === "least_loaded") {
		const [rows] = await conn.query(
			`SELECT l.id_manager, COUNT(*) AS n FROM \`${P}leads\` l
			  WHERE l.id_manager IN (?) AND l.deleted_at IS NULL AND l.is_converted = 0
			    AND NOT EXISTS (SELECT 1 FROM \`${P}leads_settings_status\` st WHERE st.id = l.id_status AND st.system_type IN ('won', 'lost'))
			  GROUP BY l.id_manager`,
			[team]
		);
		const load = new Map(rows.map((r) => [Number(r.id_manager), Number(r.n)]));
		return team.slice().sort((a, b) => (load.get(a) || 0) - (load.get(b) || 0) || a - b)[0];
	}
	// round_robin: найдавніше призначений за цим правилом (ще ні разу — першим)
	const [rows] = await conn.query(
		`SELECT CAST(h.value_new AS UNSIGNED) AS id_user, MAX(h.id) AS last FROM \`${P}leads_history\` h
		  WHERE h.action_type = 'auto_assigned' AND h.field_name = ? GROUP BY h.value_new`,
		["rule:" + rule.id]
	);
	const last = new Map(rows.map((r) => [Number(r.id_user), Number(r.last)]));
	return team.slice().sort((a, b) => (last.get(a) || 0) - (last.get(b) || 0) || a - b)[0];
}

/**
 * Розподілити лід за правилами (лише без відповідального). Повертає { id_manager, rule } або null.
 */
async function assign(idLead) {
	const [[lead]] = await pool.query(`SELECT id, title, id_manager, id_source, id_pipeline, id_stage, capture_type, value, contact_info FROM \`${P}leads\` WHERE id = ? AND deleted_at IS NULL`, [idLead]);
	if (!lead || lead.id_manager) return null;
	lead.contact = parse(lead.contact_info, {}) || {};
	const rules = (await list(1)).filter((r) => Number(r.is_active));
	const now = new Date();
	const rule = rules.find((r) => matches(r.conditions, lead, now));
	if (!rule) return null;

	const conn = await pool.getConnection();
	let user = null;
	let stageChanged = false;
	try {
		const lockName = P + "leads_route_" + rule.id;
		const [[lk]] = await conn.query(`SELECT GET_LOCK(?, 5) AS ok`, [lockName]);
		try {
			user = await pick(conn, rule);
			const set = {};
			if (user) set.id_manager = user;
			if (rule.id_stage && Number(rule.id_stage) !== Number(lead.id_stage)) {
				set.id_stage = rule.id_stage;
				set.id_pipeline = rule.id_pipeline;
				stageChanged = true;
			} else if (rule.id_pipeline && !rule.id_stage && Number(rule.id_pipeline) !== Number(lead.id_pipeline)) {
				const [[first]] = await conn.query(`SELECT id FROM \`${P}leads_pipeline_stages\` WHERE id_pipeline = ? AND is_active = 1 ORDER BY sort, id LIMIT 1`, [rule.id_pipeline]);
				if (first) {
					set.id_pipeline = rule.id_pipeline;
					set.id_stage = first.id;
					stageChanged = true;
				}
			}
			if (!Object.keys(set).length) return null;
			const [r] = await conn.query(`UPDATE \`${P}leads\` SET ?, date_edit = NOW() WHERE id = ? AND id_manager IS NULL`, [set, idLead]);
			if (!r.affectedRows) return null;
			const hist = [];
			if (user) hist.push([idLead, null, "auto_assigned", "rule:" + rule.id, null, String(user), rule.name, "system", null]);
			if (stageChanged) hist.push([idLead, null, "field_change", "id_stage", lead.id_stage == null ? "" : String(lead.id_stage), String(set.id_stage), rule.name, "system", null]);
			if (hist.length) await conn.query(`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES ${hist.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())").join(", ")}`, hist.flat());
		} finally {
			if (lk && Number(lk.ok)) await conn.query(`SELECT RELEASE_LOCK(?)`, [lockName]).catch(() => {});
		}
	} finally {
		conn.release();
	}
	if (stageChanged) await require("./sla").arm(idLead).catch((e) => logging.error(e));
	const hooks = require("./webhooks");
	if (user) {
		hooks.fire("lead.assigned", idLead, { previous: { id_manager: null }, rule: rule.id });
		Promise.resolve(
			require("../notifications").notify({
				type: "leads.assigned",
				channels: ["inapp"],
				audience: { user: Number(user) },
				key: `leads_assigned_${idLead}_${user}`,
				priority: 6,
				payload: { title: tSys("leads.view.n.assigned", { id: String(idLead) }), name: lead.title || "#" + idLead, message: tSys("leads.routing.n.by_rule", { rule: rule.name }), url: `/leads/${idLead}/` },
			})
		).catch((e) => logging.error(e));
	}
	if (stageChanged) hooks.fire("lead.stage_changed", idLead, { previous: { id_stage: lead.id_stage } });
	return { id_manager: user, rule: rule.id, stageChanged };
}

/* ═══ Отримувачі ═══ */

async function getRecipients(idLang) {
	const rows = await require("../notifications").recipients.list(SCOPE, SCOPE_REF, idLang);
	return rows.map((r) => {
		const events = {};
		EVENTS.forEach((e) => (events[e] = !!(r.options && r.options[e])));
		return { kind: r.kind, ref: r.ref, name: r.name, events };
	});
}

async function saveRecipients(body) {
	const items = (Array.isArray(body && body.recipients) ? body.recipients : [])
		.filter((r) => r && ["user", "group"].includes(r.kind) && /^\d{1,10}$/.test(String(r.ref)))
		.slice(0, 100)
		.map((r) => {
			const item = { kind: r.kind, ref: String(r.ref) };
			EVENTS.forEach((e) => (item[e] = !!(r.events && r.events[e])));
			return item;
		});
	await require("../notifications").recipients.save(null, SCOPE, SCOPE_REF, items);
	return { ok: true };
}

/** Надіслати отримувачам з увімкненою подією (key — одна подія на лід, повтори не дублюються) */
function toRecipients(event, idLead, payload) {
	Promise.resolve(
		require("../notifications").recipients.notifyScope(
			SCOPE,
			SCOPE_REF,
			{ type: "leads." + event, channels: ["inapp"], key: `leads_${event}_${idLead}_${payload.deadline || ""}`, priority: event.startsWith("sla") ? 8 : 6, payload },
			(o) => !!o[event]
		)
	).catch((e) => logging.error(e));
}

/** Новий лід: розподіл (якщо без відповідального), автоматизації «новий лід» і «вхід на етап», сповіщення отримувачам */
async function onNew(idLead) {
	try {
		await assign(idLead);
	} catch (e) {
		logging.error(e);
	}
	// Автоматизації — один раз на лід (фонова служба теж може викликати onNew для того ж ліда)
	try {
		const [[done]] = await pool.query(
			`SELECT 1 AS x FROM \`${P}leads_automations_log\` WHERE id_lead = ? AND depth = 0 AND JSON_UNQUOTE(JSON_EXTRACT(trigger_data, '$.event')) IN ('created', 'stage_enter') LIMIT 1`,
			[idLead]
		);
		if (!done) {
			const auto = require("./automations");
			await auto.emit("created", idLead);
			await auto.emit("stage_enter", idLead);
		}
	} catch (e) {
		logging.error(e);
	}
	const [[l]] = await pool.query(`SELECT id, title, id_manager, contact_info FROM \`${P}leads\` WHERE id = ? AND deleted_at IS NULL`, [idLead]);
	if (!l) return;
	const ci = parse(l.contact_info, {}) || {};
	const base = { name: l.title || "#" + l.id, message: [ci.name, ci.phone, ci.email].filter(Boolean).join(" · "), url: `/leads/${l.id}/` };
	toRecipients("new_all", l.id, { ...base, title: tSys("leads.routing.n.new", { id: String(l.id) }) });
	if (!l.id_manager) toRecipients("new_unassigned", l.id, { ...base, title: tSys("leads.routing.n.unassigned", { id: String(l.id) }) });
}

/** Минув час відповіді (викликає фонова служба): керівникам і — для ліда без відповідального — відповідальним за розподіл */
function onBreach(l) {
	const base = { name: l.title || "#" + l.id, message: tSys("leads.sla.n.breach_text", { deadline: String(l.response_deadline).slice(0, 16) }), url: `/leads/${l.id}/`, deadline: String(l.response_deadline).replace(/\D/g, "") };
	toRecipients("sla_all", l.id, { ...base, title: tSys("leads.sla.n.breach", { id: String(l.id) }) });
	if (!l.id_manager) toRecipients("sla_unassigned", l.id, { ...base, title: tSys("leads.routing.n.sla_unassigned", { id: String(l.id) }) });
}

module.exports = { MODES, CAPTURE, EVENTS, clean, groups, list, save, remove, matches, assign, onNew, onBreach, getRecipients, saveRecipients };