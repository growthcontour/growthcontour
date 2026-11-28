"use strict";

/**
 * Люди в структурі компанії: офіс, відділ, посада, керівник
 * і регіональні налаштування користувача (часовий пояс, формат дат і чисел).
 * context() — «фактичні» значення для інших розділів (чат, нагадування, графіки):
 * власні налаштування користувача → налаштування офісу → мова інтерфейсу.
 */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const offices = require("./offices");
const departments = require("./departments");
const { validateWork, validateRegional } = require("../../validator/company/company");

const P = config.get("configDatabase").prefix;
const T = { users: `${P}users`, offices: `${P}company_offices`, holidays: `${P}company_offices_holidays`, depts: `${P}company_departments`, languages: `${P}languages` };

// Формати дат і чисел для вибору в профілі (BCP 47). Підписи будує сторінка через Intl.DisplayNames
const LOCALES = [
	"en-US", "en-GB", "en-CA", "en-AU", "en-IN", "uk-UA", "pl-PL", "de-DE", "de-AT", "de-CH", "fr-FR", "fr-CA", "es-ES", "es-MX", "it-IT", "pt-PT", "pt-BR",
	"nl-NL", "cs-CZ", "sk-SK", "ro-RO", "bg-BG", "hu-HU", "el-GR", "tr-TR", "sv-SE", "da-DK", "fi-FI", "nb-NO", "lt-LT", "lv-LV", "et-EE", "sl-SI", "hr-HR",
	"sr-RS", "ka-GE", "az-AZ", "kk-KZ", "zh-CN", "ja-JP", "ko-KR", "hi-IN", "th-TH", "vi-VN", "id-ID",
];

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

const userName = (a) => `NULLIF(TRIM(CONCAT_WS(' ', ${a}.first_name, ${a}.last_name)), '')`;

/** Вкладка «Люди»: фільтр за офісом, відділом (з підвідділами), пошук */
async function list(q = {}) {
	const where = ["u.active IN (1, 3)"];
	const params = [];
	if (q.inactive) where[0] = "1 = 1";
	if (Number.isInteger(q.id_office)) {
		where.push(q.id_office === 0 ? "u.id_office IS NULL" : "u.id_office = ?");
		if (q.id_office) params.push(q.id_office);
	}
	if (Number.isInteger(q.id_department)) {
		if (q.id_department === 0) where.push("u.id_department IS NULL");
		else {
			const ids = await subtree(q.id_department);
			where.push("u.id_department IN (?)");
			params.push(ids);
		}
	}
	const search = String(q.search || "").trim().slice(0, 100);
	if (search) {
		where.push("(CONCAT_WS(' ', u.first_name, u.last_name, u.patronymic) LIKE ? OR u.email LIKE ? OR u.position LIKE ?)");
		const like = `%${search.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
		params.push(like, like, like);
	}
	const [rows] = await pool.query(
		`SELECT u.id, ${userName("u")} AS name, u.email, u.avatar, u.active, u.position,
		        u.id_office, o.name AS office_name, u.id_department, d.name AS department_name,
		        u.id_manager, ${userName("m")} AS manager_name,
		        COALESCE(u.timezone, o.timezone) AS timezone
		   FROM ${T.users} u
		   LEFT JOIN ${T.offices} o ON o.id = u.id_office
		   LEFT JOIN ${T.depts} d ON d.id = u.id_department
		   LEFT JOIN ${T.users} m ON m.id = u.id_manager
		  WHERE ${where.join(" AND ")}
		  ORDER BY u.last_name, u.first_name, u.id`,
		params
	);
	return rows;
}

/** id відділу та всіх його підвідділів */
async function subtree(id) {
	const [all] = await pool.query(`SELECT id, id_parent FROM ${T.depts}`);
	const out = new Set([id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const r of all) {
			if (r.id_parent && out.has(r.id_parent) && !out.has(r.id)) {
				out.add(r.id);
				grew = true;
			}
		}
	}
	return [...out];
}

/** Для select-ів керівника відділу й безпосереднього керівника */
async function options(include = []) {
	const ids = include.filter((x) => Number.isInteger(x) && x > 0);
	const [rows] = await pool.query(
		`SELECT u.id, ${userName("u")} AS name, u.email, u.active
		   FROM ${T.users} u
		  WHERE u.active = 1 ${ids.length ? "OR u.id IN (?)" : ""}
		  ORDER BY u.last_name, u.first_name, u.id`,
		ids.length ? [ids] : []
	);
	return rows.map((r) => ({ id: r.id, name: r.name || r.email, active: r.active }));
}

/** Картка «Робота та регіон» у профілі користувача */
async function profile(idUser) {
	const [[u]] = await pool.query(
		`SELECT u.id, u.id_office, u.id_department, u.position, u.id_manager, u.timezone, u.locale, u.hour12,
		        o.timezone AS office_timezone, l.iso AS lang_iso
		   FROM ${T.users} u
		   LEFT JOIN ${T.offices} o ON o.id = u.id_office
		   LEFT JOIN ${T.languages} l ON l.id = u.id_lang
		  WHERE u.id = ?`,
		[idUser]
	);
	if (!u) throw httpErr(404, "company.errors.not_found");
	const [officeOpts, deptOpts, userOpts] = await Promise.all([offices.options([u.id_office]), departments.options([u.id_department]), options([u.id_manager])]);
	return {
		data: {
			id_office: u.id_office,
			id_department: u.id_department,
			position: u.position,
			id_manager: u.id_manager,
			timezone: u.timezone,
			locale: u.locale,
			hour12: u.hour12 == null ? null : !!u.hour12,
		},
		defaults: { timezone: u.office_timezone || null, locale: u.lang_iso || null },
		options: { offices: officeOpts, departments: deptOpts, users: userOpts.filter((x) => x.id !== idUser), locales: LOCALES },
	};
}

/** Чи стане candidate підлеглим idUser (ланцюжок керівників) — захист від циклу */
async function managesChain(idUser, candidate) {
	const [all] = await pool.query(`SELECT id, id_manager FROM ${T.users} WHERE id_manager IS NOT NULL`);
	const boss = new Map(all.map((r) => [r.id, r.id_manager]));
	const seen = new Set();
	for (let x = candidate; x != null && !seen.has(x); x = boss.get(x)) {
		if (x === idUser) return true;
		seen.add(x);
	}
	return false;
}

async function saveWork(idUser, body) {
	const v = validateWork(body);
	if (!v.valid) throw httpErr(400, "company.errors.validation", v.errors);
	const d = v.data;

	const [[u]] = await pool.query(`SELECT id, id_office, id_department, id_manager FROM ${T.users} WHERE id = ?`, [idUser]);
	if (!u) throw httpErr(404, "company.errors.not_found");

	// Архівний офіс / відділ не призначаємо, але поточне значення можна лишити
	if (d.id_office && d.id_office !== u.id_office) {
		const [[o]] = await pool.query(`SELECT id FROM ${T.offices} WHERE id = ? AND status = 1`, [d.id_office]);
		if (!o) throw httpErr(400, "company.errors.validation", [{ field: "id_office", message: "not found" }]);
	}
	if (d.id_department && d.id_department !== u.id_department) {
		const [[dep]] = await pool.query(`SELECT id FROM ${T.depts} WHERE id = ? AND status = 1`, [d.id_department]);
		if (!dep) throw httpErr(400, "company.errors.validation", [{ field: "id_department", message: "not found" }]);
	}
	if (d.id_manager) {
		if (d.id_manager === idUser) throw httpErr(400, "company.errors.validation", [{ field: "id_manager", message: "self" }]);
		if (d.id_manager !== u.id_manager) {
			const [[m]] = await pool.query(`SELECT id FROM ${T.users} WHERE id = ? AND active = 1`, [d.id_manager]);
			if (!m) throw httpErr(400, "company.errors.validation", [{ field: "id_manager", message: "not found" }]);
		}
		if (await managesChain(idUser, d.id_manager)) throw httpErr(400, "company.errors.validation", [{ field: "id_manager", message: "cycle" }]);
	}

	await pool.query(`UPDATE ${T.users} SET id_office = ?, id_department = ?, position = ?, id_manager = ?, date_edit = NOW() WHERE id = ?`, [
		d.id_office,
		d.id_department,
		d.position,
		d.id_manager,
		idUser,
	]);
	return { ok: true, changed: { id_office: d.id_office !== u.id_office, id_department: d.id_department !== u.id_department, id_manager: d.id_manager !== u.id_manager } };
}

async function saveRegional(idUser, body) {
	const v = validateRegional(body);
	if (!v.valid) throw httpErr(400, "company.errors.validation", v.errors);
	const d = v.data;
	const [r] = await pool.query(`UPDATE ${T.users} SET timezone = ?, locale = ?, hour12 = ?, date_edit = NOW() WHERE id = ?`, [d.timezone, d.locale, d.hour12 == null ? null : Number(d.hour12), idUser]);
	if (!r.affectedRows) throw httpErr(404, "company.errors.not_found");
	return { ok: true };
}

/**
 * Фактичні регіональні дані й робочий графік користувача.
 * timezone: власний → офісу → null (тоді — пояс браузера); locale: власний → мова інтерфейсу.
 */
async function context(idUser) {
	const [[u]] = await pool.query(
		`SELECT u.id, u.id_office, u.id_department, u.timezone, u.locale, u.hour12, l.iso AS lang_iso,
		        o.timezone AS office_timezone, o.work_hours, o.status AS office_status
		   FROM ${T.users} u
		   LEFT JOIN ${T.offices} o ON o.id = u.id_office
		   LEFT JOIN ${T.languages} l ON l.id = u.id_lang
		  WHERE u.id = ?`,
		[idUser]
	);
	if (!u) return null;
	let holidays = [];
	if (u.id_office) {
		const [rows] = await pool.query(`SELECT date, recurring FROM ${T.holidays} WHERE id_office = ?`, [u.id_office]);
		holidays = rows.map((h) => ({ date: offices.sqlDate(h.date), recurring: !!h.recurring }));
	}
	return {
		id_user: u.id,
		id_office: u.id_office,
		id_department: u.id_department,
		timezone: u.timezone || u.office_timezone || null,
		locale: u.locale || u.lang_iso || "en",
		hour12: u.hour12 == null ? null : !!u.hour12,
		work_hours: u.id_office ? offices.json(u.work_hours, null) : null,
		holidays,
	};
}

/** Чи робочий зараз час у користувача (за графіком і святами офісу). Без офісу — null (невідомо) */
function isWorkingAt(ctx, date = new Date()) {
	if (!ctx || !ctx.work_hours || !ctx.timezone) return null;
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", { timeZone: ctx.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
			.formatToParts(date)
			.map((p) => [p.type, p.value])
	);
	const ymd = `${parts.year}-${parts.month}-${parts.day}`;
	if (ctx.holidays.some((h) => (h.recurring ? h.date.slice(5) === ymd.slice(5) : h.date === ymd))) return false;
	const dow = { Mon: "1", Tue: "2", Wed: "3", Thu: "4", Fri: "5", Sat: "6", Sun: "7" }[parts.weekday];
	const now = `${parts.hour}:${parts.minute}`;
	return (ctx.work_hours[dow] || []).some(([from, to]) => now >= from && now < to);
}

module.exports = { list, options, profile, saveWork, saveRegional, context, isWorkingAt, LOCALES };