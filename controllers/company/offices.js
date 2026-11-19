"use strict";

/**
 * Офіси компанії: адреса, часовий пояс, робочий графік, свята.
 * Архів (status = 0) — офіс не пропонується для нових призначень, але лишається в історії.
 * Видалити можна лише офіс без людей.
 */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const { validateOffice } = require("../../validator/company/company");

const P = config.get("configDatabase").prefix;
const T = { offices: `${P}company_offices`, holidays: `${P}company_offices_holidays`, deptOffices: `${P}company_departments_offices`, users: `${P}users` };

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

const json = (v, fallback) => {
	if (v == null) return fallback;
	if (typeof v === "object") return v;
	try {
		return JSON.parse(v);
	} catch {
		return fallback;
	}
};

const sqlDate = (v) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}` : String(v).slice(0, 10));

async function list({ archived = false } = {}) {
	const [rows] = await pool.query(
		`SELECT o.id, o.name, o.code, o.country, o.city, o.timezone, o.status, o.sort_order,
		        (SELECT COUNT(*) FROM ${T.users} u WHERE u.id_office = o.id AND u.active = 1) AS people,
		        (SELECT COUNT(*) FROM ${T.deptOffices} d WHERE d.id_office = o.id) AS departments
		   FROM ${T.offices} o
		  ${archived ? "" : "WHERE o.status = 1"}
		  ORDER BY o.status DESC, o.sort_order, o.name`
	);
	return rows;
}

/** Для select-ів: активні офіси (+ вказані, навіть якщо в архіві — щоб не зникло поточне значення) */
async function options(include = []) {
	const ids = include.filter((x) => Number.isInteger(x) && x > 0);
	const [rows] = await pool.query(
		`SELECT id, name, code, timezone, status FROM ${T.offices}
		  WHERE status = 1 ${ids.length ? "OR id IN (?)" : ""}
		  ORDER BY sort_order, name`,
		ids.length ? [ids] : []
	);
	return rows;
}

async function get(id) {
	const [[row]] = await pool.query(`SELECT * FROM ${T.offices} WHERE id = ?`, [id]);
	if (!row) throw httpErr(404, "company.errors.not_found");
	row.work_hours = json(row.work_hours, {});
	const [holidays] = await pool.query(`SELECT date, name, recurring FROM ${T.holidays} WHERE id_office = ? ORDER BY date`, [id]);
	row.holidays = holidays.map((h) => ({ date: sqlDate(h.date), name: h.name, recurring: !!h.recurring }));
	return row;
}

async function save(id, body, idUser) {
	const v = validateOffice(body);
	if (!v.valid) throw httpErr(400, "company.errors.validation", v.errors);
	const d = v.data;

	const cols = ["name", "code", "country", "city", "address", "postcode", "phone", "email", "timezone", "work_hours", "status", "sort_order"];
	const values = cols.map((c) => (c === "work_hours" ? JSON.stringify(d.work_hours) : typeof d[c] === "boolean" ? Number(d[c]) : (d[c] ?? null)));

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		let officeId = id;
		if (id) {
			const [[cur]] = await conn.query(`SELECT id, status FROM ${T.offices} WHERE id = ? FOR UPDATE`, [id]);
			if (!cur) throw httpErr(404, "company.errors.not_found");
			// В архів — лише без активних людей (інакше в них зникне графік і часовий пояс)
			if (cur.status && !d.status) {
				const [[n]] = await conn.query(`SELECT COUNT(*) AS n FROM ${T.users} WHERE id_office = ? AND active = 1`, [id]);
				if (Number(n.n)) throw httpErr(409, "company.errors.office_has_people", [{ field: "status", message: "has_people" }]);
			}
			await conn.query(`UPDATE ${T.offices} SET ${cols.map((c) => `${c} = ?`).join(", ")}, date_edit = NOW() WHERE id = ?`, [...values, id]);
		} else {
			const [r] = await conn.query(`INSERT INTO ${T.offices} (${cols.join(", ")}, id_user_add, date_add, date_edit) VALUES (${cols.map(() => "?").join(", ")}, ?, NOW(), NOW())`, [...values, idUser || null]);
			officeId = r.insertId;
		}

		// Свята — повна заміна списку
		await conn.query(`DELETE FROM ${T.holidays} WHERE id_office = ?`, [officeId]);
		if (d.holidays.length) {
			await conn.query(`INSERT INTO ${T.holidays} (id_office, date, name, recurring) VALUES ?`, [d.holidays.map((h) => [officeId, h.date, h.name, Number(h.recurring)])]);
		}

		await conn.commit();
		return { id: officeId };
	} catch (e) {
		await conn.rollback();
		if (e.code === "ER_DUP_ENTRY") throw httpErr(409, "company.errors.code_taken", [{ field: "code", message: "already exists" }]);
		throw e;
	} finally {
		conn.release();
	}
}

async function remove(id) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [[cur]] = await conn.query(`SELECT id FROM ${T.offices} WHERE id = ? FOR UPDATE`, [id]);
		if (!cur) throw httpErr(404, "company.errors.not_found");
		// Будь-хто, навіть неактивний: інакше в профілі лишиться посилання на неіснуючий офіс
		const [[n]] = await conn.query(`SELECT COUNT(*) AS n FROM ${T.users} WHERE id_office = ?`, [id]);
		if (Number(n.n)) throw httpErr(409, "company.errors.office_has_people");
		// Свята й зв'язки з відділами видаляються каскадно
		await conn.query(`DELETE FROM ${T.offices} WHERE id = ?`, [id]);
		await conn.commit();
		return { ok: true };
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
}

module.exports = { list, options, get, save, remove, json, sqlDate };