"use strict";

/**
 * Дублікати лідів: пошук за телефоном / email, позначка, «не дубль», злиття двох лідів.
 *
 * Збіг: телефон — за останніми 9 цифрами (однаково для +380…, 0…, 380…; коротші номери — повністю),
 *       email — без урахування регістру. Порівнюються лише ліди не в кошику.
 * Позначка (is_duplicate, id_duplicate_of, duplicate_method): ставиться новішому ліду, вказує на найстаріший
 *   збіг. Перевіряє фонова служба лідів (controllers/leads/sla.js) — нові ліди з будь-якого джерела
 *   (форми сайтів, чат, контакт-центр) і ліди, в яких змінили контакти (duplicate_method скидається в NULL).
 *   duplicate_method: phone | email — дубль; none — збігів немає; dismissed — «не дубль»; merged — злитий в інший.
 * Злиття: основний лід лишається, другий — у кошик (з позначкою merged → основний). В основний переходять
 *   активності, файли, історія, конвертації, угоди, теги; поля — ті, що обрав менеджер.
 */

const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");

const P = config.get("configDatabase").prefix;
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const parse = (v) => {
	if (!v) return {};
	if (typeof v === "object") return v;
	try {
		return JSON.parse(v) || {};
	} catch {
		return {};
	}
};

/** Ключ телефону: останні 9 цифр (або всі, якщо їх 5–8) */
function phoneKey(v) {
	const d = String(v || "").replace(/\D/g, "");
	if (d.length < 5) return "";
	return d.length > 9 ? d.slice(-9) : d;
}
const emailKey = (v) => {
	const e = String(v || "").trim().toLowerCase();
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : "";
};

const PHONE_SQL = "REGEXP_REPLACE(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.contact_info, '$.phone')), ''), '[^0-9]', '')";
const EMAIL_SQL = "LOWER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.contact_info, '$.email')), '')))";

/**
 * Ліди з тим самим телефоном або email (крім самого ліда). scope — умова видимості для аліаса l (або null).
 * Повертає [{ id, title, contact_info, date_add, manager_name, status_name, by: 'phone'|'email' }], старші — першими.
 */
async function matches(lead, scope, idLang) {
	const ci = parse(lead.contact_info);
	const ph = phoneKey(ci.phone);
	const em = emailKey(ci.email);
	if (!ph && !em) return [];
	const cond = [];
	const params = [];
	if (ph) {
		cond.push(ph.length === 9 ? `RIGHT(${PHONE_SQL}, 9) = ?` : `${PHONE_SQL} = ?`);
		params.push(ph);
	}
	if (em) {
		cond.push(`${EMAIL_SQL} = ?`);
		params.push(em);
	}
	const [rows] = await pool.query(
		`SELECT l.id, l.title, l.value, l.contact_info, l.date_add, l.id_manager, l.is_converted,
		        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS manager_name, sl.name AS status_name
		   FROM \`${P}leads\` l
		   LEFT JOIN \`${P}users\` u ON u.id = l.id_manager
		   LEFT JOIN \`${P}leads_settings_status_lang\` sl ON sl.id_status = l.id_status AND sl.id_lang = ?
		  WHERE l.deleted_at IS NULL AND l.id <> ? AND (${cond.join(" OR ")})${scope ? " AND " + scope.sql : ""}
		  ORDER BY l.date_add, l.id
		  LIMIT 50`,
		[Number(idLang) || 1, lead.id, ...params, ...(scope ? scope.params : [])]
	);
	return rows.map((r) => {
		const c = parse(r.contact_info);
		return { ...r, contact_info: c, by: ph && phoneKey(c.phone) === ph ? "phone" : "email" };
	});
}

/** Перевірка ліда (фонова служба): позначити дублем найстарішого збігу або записати, що збігів немає */
async function check(idLead) {
	const [[l]] = await pool.query(`SELECT id, contact_info, date_add, duplicate_method FROM \`${P}leads\` WHERE id = ? AND deleted_at IS NULL`, [idLead]);
	if (!l || l.duplicate_method !== null) return null;
	const found = (await matches(l, null, 1)).filter((m) => String(m.date_add) < String(l.date_add) || (String(m.date_add) === String(l.date_add) && m.id < l.id));
	if (!found.length) {
		await pool.query(`UPDATE \`${P}leads\` SET duplicate_method = 'none' WHERE id = ? AND duplicate_method IS NULL`, [idLead]);
		return null;
	}
	const of = found[0];
	const [r] = await pool.query(`UPDATE \`${P}leads\` SET is_duplicate = 1, id_duplicate_of = ?, duplicate_method = ? WHERE id = ? AND duplicate_method IS NULL`, [of.id, of.by, idLead]);
	if (r.affectedRows) {
		await pool.query(
			`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES (?, NULL, 'duplicate_marked', ?, NULL, ?, NULL, 'system', NULL, NOW())`,
			[idLead, of.by, String(of.id)]
		);
	}
	return of.id;
}

/** Контакти змінились — перевірити знову (крім злитих) */
async function recheck(idLead) {
	await pool.query(`UPDATE \`${P}leads\` SET is_duplicate = 0, id_duplicate_of = NULL, duplicate_method = NULL WHERE id = ? AND (duplicate_method IS NULL OR duplicate_method <> 'merged')`, [idLead]);
}

/** «Не дубль»: позначка знімається і не ставиться знову, доки не змінять контакти */
async function dismiss(idLead, idUser, ip) {
	const [r] = await pool.query(`UPDATE \`${P}leads\` SET is_duplicate = 0, id_duplicate_of = NULL, duplicate_method = 'dismissed' WHERE id = ? AND deleted_at IS NULL`, [idLead]);
	if (!r.affectedRows) throw httpErr(404, "leads.server.not_found");
	await pool.query(
		`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES (?, ?, 'duplicate_dismissed', NULL, NULL, NULL, NULL, 'web', ?, NOW())`,
		[idLead, idUser, ip || null]
	);
	return { ok: true };
}

/* ═══ Злиття ═══ */

const MERGE_FIELDS = ["title", "value", "note", "id_status", "id_manager", "id_source", "expected_close_date", "contact.name", "contact.phone", "contact.email", "contact.company", "contact.position"];
const CONTACT = ["name", "phone", "email", "company", "position"];

/**
 * Злити other в main. pick: { поле: 'other' } — значення з другого ліда (решта — з основного);
 * note: 'both' — обидві нотатки разом. dateEdit — версія основного ліда (захист від одночасних змін).
 */
async function merge(req, idMain, idOther, pick, dateEdit) {
	if (!idOther || idOther === idMain) throw httpErr(400, "leads.dupes.e.other");
	const idUser = req.user.userId || req.user.id;
	const scope = require("./access").scope(req, "l");
	const conn = await pool.getConnection();
	let main;
	let other;
	try {
		await conn.beginTransaction();
		const [rows] = await conn.query(`SELECT l.* FROM \`${P}leads\` l WHERE l.id IN (?, ?) AND l.deleted_at IS NULL${scope ? " AND " + scope.sql : ""} ORDER BY l.id FOR UPDATE`, [idMain, idOther, ...(scope ? scope.params : [])]);
		main = rows.find((r) => r.id === idMain);
		other = rows.find((r) => r.id === idOther);
		if (!main || !other) throw httpErr(404, "leads.server.not_found");
		if (dateEdit && String(main.date_edit) !== String(dateEdit)) throw httpErr(409, "leads.view.conflict_text");

		// Поля: обране з другого ліда
		const set = {};
		const p = pick && typeof pick === "object" ? pick : {};
		for (const f of ["title", "value", "id_status", "id_manager", "id_source", "expected_close_date"]) if (p[f] === "other") set[f] = other[f];
		if (p.note === "other") set.note = other.note;
		else if (p.note === "both" && String(other.note || "").trim()) set.note = [main.note, other.note].map((x) => String(x || "").trim()).filter(Boolean).join("\n\n— #" + other.id + " —\n");
		const mc = parse(main.contact_info);
		const oc = parse(other.contact_info);
		let contactChanged = false;
		for (const k of CONTACT) {
			if (p["contact." + k] === "other" || (!mc[k] && oc[k])) {
				if ((mc[k] || "") !== (oc[k] || "")) contactChanged = true;
				if (oc[k]) mc[k] = oc[k];
				else delete mc[k];
			}
		}
		if (contactChanged) set.contact_info = JSON.stringify(mc);
		// Порожнє в основному — береться з другого без питань
		if (!main.id_client && other.id_client) set.id_client = other.id_client;
		if (!main.id_client_org && other.id_client_org) set.id_client_org = other.id_client_org;
		if (!main.id_manager && other.id_manager && set.id_manager === undefined) set.id_manager = other.id_manager;
		if (other.first_response_at && (!main.first_response_at || String(other.first_response_at) < String(main.first_response_at))) set.first_response_at = other.first_response_at;
		if (Number(other.is_converted) && !Number(main.is_converted)) {
			set.is_converted = 1;
			set.converted_at = other.converted_at;
		}
		if (Number(main.is_duplicate) && Number(main.id_duplicate_of) === idOther) {
			set.is_duplicate = 0;
			set.id_duplicate_of = null;
			set.duplicate_method = "dismissed";
		}

		// Пов'язане — в основний лід
		for (const t of ["leads_activities", "leads_files", "leads_history", "leads_conversions"]) await conn.query(`UPDATE \`${P}${t}\` SET id_lead = ? WHERE id_lead = ?`, [idMain, idOther]);
		await conn.query(`UPDATE \`${P}deals\` SET id_lead = ? WHERE id_lead = ?`, [idMain, idOther]);
		await conn.query(`INSERT IGNORE INTO \`${P}leads_tags_rel\` (id_lead, id_tag) SELECT ?, id_tag FROM \`${P}leads_tags_rel\` WHERE id_lead = ?`, [idMain, idOther]);
		await conn.query(`UPDATE \`${P}leads\` SET id_duplicate_of = ? WHERE id_duplicate_of = ? AND id <> ?`, [idMain, idOther, idMain]);

		set.date_edit = new Date();
		await conn.query(`UPDATE \`${P}leads\` SET ? WHERE id = ?`, [set, idMain]);
		await conn.query(`UPDATE \`${P}leads\` SET is_duplicate = 1, id_duplicate_of = ?, duplicate_method = 'merged' WHERE id = ?`, [idMain, idOther]);
		await conn.query(
			`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES (?, ?, 'merged', NULL, ?, ?, ?, 'web', ?, NOW())`,
			[idMain, idUser, String(idOther), String(idMain), other.title || null, req.ip || null]
		);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}

	// Після коміту: другий лід — у кошик, клієнт, вебхуки
	try {
		await require("../common/trash").softDelete("leads", idOther, idUser);
	} catch (e) {
		if (!e.status) logging.error(e);
	}
	try {
		await require("../clients/links").linkLead(idMain, idUser);
	} catch (e) {
		logging.error(e);
	}
	const hooks = require("./webhooks");
	hooks.fire("lead.updated", idMain, { changes: ["merged"], merged_from: idOther });
	hooks.fire("lead.deleted", idOther, { merged_into: idMain });
	require("../common/audit").log(req, { action: "merge", module: "leads", entity: "lead", id_entity: idMain, count: 1 });
	return { ok: true, id: idMain };
}

/** Дані для вікна злиття: обидва ліди з назвами довідників */
async function pair(req, idMain, idOther) {
	const idLang = req.user.id_lang || 1;
	const scope = require("./access").scope(req, "l");
	const [rows] = await pool.query(
		`SELECT l.id, l.title, l.value, l.note, l.id_status, l.id_manager, l.id_source, l.expected_close_date, l.contact_info, l.date_add, l.date_edit,
		        sl.name AS id_status_name, src.name AS id_source_name, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS id_manager_name,
		        (SELECT COUNT(*) FROM \`${P}leads_activities\` a WHERE a.id_lead = l.id AND a.deleted_at IS NULL) AS n_activities,
		        (SELECT COUNT(*) FROM \`${P}leads_files\` f WHERE f.id_lead = l.id AND f.deleted_at IS NULL) AS n_files
		   FROM \`${P}leads\` l
		   LEFT JOIN \`${P}leads_settings_status_lang\` sl ON sl.id_status = l.id_status AND sl.id_lang = ?
		   LEFT JOIN \`${P}leads_sources_lang\` src ON src.id_source = l.id_source AND src.id_lang = ?
		   LEFT JOIN \`${P}users\` u ON u.id = l.id_manager
		  WHERE l.id IN (?, ?) AND l.deleted_at IS NULL${scope ? " AND " + scope.sql : ""}`,
		[idLang, idLang, idMain, idOther, ...(scope ? scope.params : [])]
	);
	const main = rows.find((r) => r.id === idMain);
	const other = rows.find((r) => r.id === idOther);
	if (!main || !other) throw httpErr(404, "leads.server.not_found");
	main.contact_info = parse(main.contact_info);
	other.contact_info = parse(other.contact_info);
	return { main, other, fields: MERGE_FIELDS };
}

module.exports = { phoneKey, emailKey, matches, check, recheck, dismiss, merge, pair, MERGE_FIELDS };