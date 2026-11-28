"use strict";

/**
 * Створення ліда вручну (сторінка /leads/new/).
 * Перевірка значень, правила етапу (обов'язкові поля, причина програшу — controllers/leads/rules.js),
 * розподіл без відповідального (controllers/leads/routing.js),
 * запис ліда й тегів; після — картка клієнта, дедлайн першої відповіді, сповіщення відповідальному, вебхук.
 * Дублікати позначає фонова служба (controllers/leads/sla.js); форма попереджає про збіги ще до збереження.
 */

const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");

const P = config.get("configDatabase").prefix;
const httpErr = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});
const CONTACT = ["name", "phone", "email", "company", "position"];
const pad = (x) => String(x).padStart(2, "0");
const nowSql = () => {
	const d = new Date();
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** Довідники для форми створення */
async function formDicts(idLang) {
	const L = Number(idLang) || 1;
	const q = (sql) => pool.query(sql, [L]).then(([r]) => r);
	const [pipelines, stages, statuses, sources, priorities, temperatures, qualifications, tags, managers] = await Promise.all([
		q(`SELECT p.id, COALESCE(pl.name, CONCAT('#', p.id)) AS name, p.is_default FROM \`${P}leads_pipelines\` p LEFT JOIN \`${P}leads_pipelines_lang\` pl ON pl.id_pipeline = p.id AND pl.id_lang = ? WHERE p.is_active = 1 ORDER BY p.is_default DESC, p.sort, p.id`),
		require("./rules").stagesOf(null, L),
		q(`SELECT s.id, COALESCE(sl.name, CONCAT('#', s.id)) AS name, s.system_type, s.is_default FROM \`${P}leads_settings_status\` s LEFT JOIN \`${P}leads_settings_status_lang\` sl ON sl.id_status = s.id AND sl.id_lang = ? WHERE s.is_active = 1 ORDER BY s.is_default DESC, s.sort, s.id`),
		q(`SELECT d.id, COALESCE(dl.name, CONCAT('#', d.id)) AS name FROM \`${P}leads_sources\` d LEFT JOIN \`${P}leads_sources_lang\` dl ON dl.id_source = d.id AND dl.id_lang = ? WHERE d.is_active = 1 ORDER BY d.sort, d.id`),
		q(`SELECT d.id, COALESCE(dl.name, CONCAT('#', d.id)) AS name FROM \`${P}leads_priorities\` d LEFT JOIN \`${P}leads_priorities_lang\` dl ON dl.id_priority = d.id AND dl.id_lang = ? WHERE d.is_active = 1 ORDER BY d.sort, d.id`),
		q(`SELECT d.id, COALESCE(dl.name, CONCAT('#', d.id)) AS name FROM \`${P}leads_temperatures\` d LEFT JOIN \`${P}leads_temperatures_lang\` dl ON dl.id_temperature = d.id AND dl.id_lang = ? WHERE d.is_active = 1 ORDER BY d.sort, d.id`),
		q(`SELECT d.id, COALESCE(dl.name, CONCAT('#', d.id)) AS name FROM \`${P}leads_qualifications\` d LEFT JOIN \`${P}leads_qualifications_lang\` dl ON dl.id_qualification = d.id AND dl.id_lang = ? WHERE d.is_active = 1 ORDER BY d.sort, d.id`),
		q(`SELECT t.id, t.color, COALESCE(tl.name, CONCAT('#', t.id)) AS name FROM \`${P}leads_tags\` t LEFT JOIN \`${P}leads_tags_lang\` tl ON tl.id_tag = t.id AND tl.id_lang = ? WHERE t.is_active = 1 ORDER BY t.sort, t.id`),
		pool.query(`SELECT id, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM \`${P}users\` WHERE active = 1 ORDER BY first_name, last_name`).then(([r]) => r),
	]);
	return { pipelines, stages: stages.filter((s) => Number(s.is_active)), statuses, sources, priorities, temperatures, qualifications, tags, managers };
}

/** Значення з форми → поля ліда; помилки — по полях */
function values(b, t) {
	const errors = {};
	const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
	const ref = (v) => (parseInt(v, 10) > 0 ? parseInt(v, 10) : null);
	const contact = {};
	const src = b.contact && typeof b.contact === "object" ? b.contact : {};
	for (const k of CONTACT) {
		const x = str(src[k], 255);
		if (x) contact[k] = x;
	}
	if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) errors["contact.email"] = t("leads.view.e.email");
	if (contact.phone && !/^[\d\s()+\-.]{5,32}$/.test(contact.phone)) errors["contact.phone"] = t("leads.view.e.phone");
	const v = {
		title: str(b.title, 500),
		note: str(b.note, 65000),
		value: 0,
		website: str(b.website, 255),
		expected_close_date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.expected_close_date || "")) ? String(b.expected_close_date) : null,
		id_pipeline: ref(b.id_pipeline),
		id_stage: ref(b.id_stage),
		id_status: ref(b.id_status),
		id_source: ref(b.id_source),
		id_priority: ref(b.id_priority),
		id_temperature: ref(b.id_temperature),
		id_qualification: ref(b.id_qualification),
		id_manager: ref(b.id_manager),
		contact_info: contact,
	};
	const n = Number(String(b.value ?? "").replace(",", ".").replace(/\s/g, "") || 0);
	if (!Number.isFinite(n) || n < 0 || n > 99999999999) errors.value = t("leads.view.e.number");
	else v.value = Math.round(n * 10000) / 10000;
	if (!v.title && !contact.name && !contact.phone && !contact.email && !contact.company) errors.title = t("leads.new.e.title");
	if (!v.id_pipeline) errors.id_pipeline = t("leads.view.e.required");
	if (!v.id_stage) errors.id_stage = t("leads.view.e.required");
	if (!v.id_status) errors.id_status = t("leads.view.e.required");
	const tags = [...new Set((Array.isArray(b.tags) ? b.tags : []).map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 50);
	return { v, tags, errors };
}

async function create(req, body) {
	const t = (k, vars) => req.__(k, vars);
	const idUser = req.user.userId || req.user.id;
	const { v, tags, errors } = values(body || {}, t);
	if (Object.keys(errors).length) throw httpErr(400, "leads.view.e.check", { errors });

	// Довідники мають існувати; етап — з обраної воронки
	const exists = async (table, id, extra = "") => !id || !!(await pool.query(`SELECT id FROM \`${P}${table}\` WHERE id = ?${extra} LIMIT 1`, [id]))[0][0];
	const checks = [
		["id_pipeline", "leads_pipelines", " AND is_active = 1"],
		["id_status", "leads_settings_status", " AND is_active = 1"],
		["id_source", "leads_sources"],
		["id_priority", "leads_priorities"],
		["id_temperature", "leads_temperatures"],
		["id_qualification", "leads_qualifications"],
		["id_manager", "users", " AND active = 1"],
	];
	for (const [f, table, extra] of checks) if (!(await exists(table, v[f], extra))) errors[f] = t("leads.view.e.ref");
	const [[stage]] = await pool.query(`SELECT id, id_pipeline FROM \`${P}leads_pipeline_stages\` WHERE id = ? AND is_active = 1`, [v.id_stage]);
	if (!stage || Number(stage.id_pipeline) !== Number(v.id_pipeline)) errors.id_stage = t("leads.view.e.ref");
	if (Object.keys(errors).length) throw httpErr(400, "leads.view.e.check", { errors });

	// Правила етапу, на який потрапляє лід
	const rules = await require("./rules").check({}, { ...v, id_loss_reason: null }, t);
	if (Object.keys(rules.errors).length) throw httpErr(400, "leads.rules.e.check", { errors: rules.errors, missing: rules.missing });

	const title = v.title || v.contact_info.company || v.contact_info.name || v.contact_info.phone || v.contact_info.email;
	const now = nowSql();
	const [[tmp]] = v.id_temperature ? await pool.query(`SELECT slug FROM \`${P}leads_temperatures\` WHERE id = ?`, [v.id_temperature]) : [[null]];
	const [[qual]] = v.id_qualification ? await pool.query(`SELECT slug FROM \`${P}leads_qualifications\` WHERE id = ?`, [v.id_qualification]) : [[null]];
	const conn = await pool.getConnection();
	let id;
	try {
		await conn.beginTransaction();
		const [r] = await conn.query(`INSERT INTO \`${P}leads\` SET ?`, [
			{
				title,
				note: v.note,
				value: v.value,
				website: v.website,
				expected_close_date: v.expected_close_date,
				id_pipeline: v.id_pipeline,
				id_stage: v.id_stage,
				id_status: v.id_status,
				id_source: v.id_source,
				id_priority: v.id_priority,
				id_temperature: v.id_temperature,
				id_qualification: v.id_qualification,
				...(tmp && tmp.slug ? { temperature: tmp.slug } : {}),
				...(qual && qual.slug ? { qualification: qual.slug } : {}),
				id_manager: v.id_manager,
				capture_type: "manual",
				capture_ref: "user:" + idUser,
				contact_info: JSON.stringify(v.contact_info),
				date_add: now,
				date_edit: now,
			},
		]);
		id = r.insertId;
		if (tags.length) await conn.query(`INSERT IGNORE INTO \`${P}leads_tags_rel\` (id_lead, id_tag) SELECT ?, id FROM \`${P}leads_tags\` WHERE id IN (?)`, [id, tags]);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}

	// Після коміту: картка клієнта, дедлайн відповіді, сповіщення, вебхук
	try {
		await require("../clients/links").linkLead(id, idUser);
	} catch (e) {
		logging.error(e);
	}
	try {
		await require("./sla").arm(id);
	} catch (e) {
		logging.error(e);
	}
	// Без відповідального — розподіл за правилами; сповіщення отримувачам модуля
	await require("./routing").onNew(id);
	if (v.id_manager && Number(v.id_manager) !== Number(idUser)) {
		const who = [req.user.firstName, req.user.lastName].filter(Boolean).join(" ").trim() || "#" + idUser;
		Promise.resolve(
			require("../notifications").notify({
				type: "leads.assigned",
				channels: ["inapp"],
				audience: { user: Number(v.id_manager) },
				priority: 6,
				payload: { title: t("leads.view.n.assigned", { id: String(id) }), name: title, message: t("leads.bulk.n.assigned_by", { who }), url: `/leads/${id}/` },
			})
		).catch((e) => logging.error(e));
	}
	require("./webhooks").fire("lead.created", id);
	require("../common/audit").log(req, { action: "create", module: "leads", entity: "lead", id_entity: id, count: 1 });
	return { ok: true, id, url: `/leads/${id}/` };
}

/** Перевірка контактів до створення: ліди з тим самим телефоном / email (у межах видимості) */
async function similar(req, contact) {
	const rows = await require("./dupes").matches({ id: 0, contact_info: { phone: contact.phone, email: contact.email } }, require("./access").scope(req, "l"), req.user.id_lang || 1);
	return rows.slice(0, 10).map((r) => ({ id: r.id, title: r.title, contact_info: r.contact_info, by: r.by, status_name: r.status_name, manager_name: r.manager_name, date_add: r.date_add }));
}

module.exports = { formDicts, create, similar };