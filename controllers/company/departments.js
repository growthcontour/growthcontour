"use strict";

/**
 * Відділи: дерево (відділ → підвідділ), керівник, офіси, де працює відділ.
 * Видалити можна лише відділ без підвідділів і без людей; інакше — в архів.
 */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const { validateDepartment } = require("../../validator/company/company");

const P = config.get("configDatabase").prefix;
const T = { depts: `${P}company_departments`, deptOffices: `${P}company_departments_offices`, offices: `${P}company_offices`, users: `${P}users` };

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

const TREE_LOCK = `${P}company_departments_tree`;

const userName = (a) => `NULLIF(TRIM(CONCAT_WS(' ', ${a}.first_name, ${a}.last_name)), '')`;

/** Плоский список; дерево будує сторінка (Tabulator dataTree) за id_parent */
async function list({ archived = false } = {}) {
	const [rows] = await pool.query(
		`SELECT d.id, d.id_parent, d.name, d.code, d.status, d.sort_order, d.id_head, ${userName("h")} AS head_name,
		        (SELECT COUNT(*) FROM ${T.users} u WHERE u.id_department = d.id AND u.active = 1) AS people,
		        (SELECT GROUP_CONCAT(o.name ORDER BY o.sort_order, o.name SEPARATOR ', ')
		           FROM ${T.deptOffices} x JOIN ${T.offices} o ON o.id = x.id_office WHERE x.id_department = d.id) AS offices
		   FROM ${T.depts} d
		   LEFT JOIN ${T.users} h ON h.id = d.id_head
		  ${archived ? "" : "WHERE d.status = 1"}
		  ORDER BY d.sort_order, d.name`
	);
	// Підвідділ активного відділу міг лишитись без батька у вибірці (батько в архіві) — показуємо його в корені
	const ids = new Set(rows.map((r) => r.id));
	return rows.map((r) => ({ ...r, id_parent: ids.has(r.id_parent) ? r.id_parent : null }));
}

/** Для select-ів: активні (+ вказані); path — «Батько / Відділ» */
async function options(include = []) {
	const ids = include.filter((x) => Number.isInteger(x) && x > 0);
	const [rows] = await pool.query(`SELECT id, id_parent, name, status FROM ${T.depts} WHERE status = 1 ${ids.length ? "OR id IN (?)" : ""}`, ids.length ? [ids] : []);
	const [all] = await pool.query(`SELECT id, id_parent, name FROM ${T.depts}`);
	const byId = new Map(all.map((r) => [r.id, r]));
	const path = (r) => {
		const parts = [];
		const seen = new Set();
		for (let x = r; x && !seen.has(x.id); x = byId.get(x.id_parent)) {
			seen.add(x.id);
			parts.unshift(x.name);
		}
		return parts.join(" / ");
	};
	return rows.map((r) => ({ id: r.id, id_parent: r.id_parent, name: r.name, path: path(r), status: r.status })).sort((a, b) => a.path.localeCompare(b.path));
}

async function get(id) {
	const [[row]] = await pool.query(`SELECT d.*, ${userName("h")} AS head_name FROM ${T.depts} d LEFT JOIN ${T.users} h ON h.id = d.id_head WHERE d.id = ?`, [id]);
	if (!row) throw httpErr(404, "company.errors.not_found");
	const [offices] = await pool.query(`SELECT id_office FROM ${T.deptOffices} WHERE id_department = ?`, [id]);
	row.offices = offices.map((o) => o.id_office);
	return row;
}

/** Чи є candidate нащадком (або самим) id — захист від циклу в дереві */
async function isDescendant(conn, id, candidate) {
	const [all] = await conn.query(`SELECT id, id_parent FROM ${T.depts}`);
	const parent = new Map(all.map((r) => [r.id, r.id_parent]));
	const seen = new Set();
	for (let x = candidate; x != null && !seen.has(x); x = parent.get(x)) {
		if (x === id) return true;
		seen.add(x);
	}
	return false;
}

async function save(id, body, idUser) {
	const v = validateDepartment(body);
	if (!v.valid) throw httpErr(400, "company.errors.validation", v.errors);
	const d = v.data;

	const conn = await pool.getConnection();
	let locked = false;
	try {
		await conn.beginTransaction();
		// Серіалізуємо зміни дерева: дві паралельні зміни батька не зможуть утворити цикл
		const [[lock]] = await conn.query(`SELECT GET_LOCK(?, 10) AS ok`, [TREE_LOCK]);
		if (!lock || Number(lock.ok) !== 1) throw httpErr(409, "company.errors.busy");
		locked = true;

		if (id) {
			const [[cur]] = await conn.query(`SELECT id, status FROM ${T.depts} WHERE id = ?`, [id]);
			if (!cur) throw httpErr(404, "company.errors.not_found");
			if (d.id_parent && (await isDescendant(conn, id, d.id_parent))) throw httpErr(400, "company.errors.validation", [{ field: "id_parent", message: "cycle" }]);
			if (cur.status && !d.status) {
				const [[n]] = await conn.query(
					`SELECT (SELECT COUNT(*) FROM ${T.users} WHERE id_department = ? AND active = 1) AS people,
					        (SELECT COUNT(*) FROM ${T.depts} WHERE id_parent = ? AND status = 1) AS children`,
					[id, id]
				);
				if (Number(n.people) || Number(n.children)) throw httpErr(409, "company.errors.department_not_empty", [{ field: "status", message: "not empty" }]);
			}
		}
		if (d.id_parent) {
			const [[p]] = await conn.query(`SELECT id, status FROM ${T.depts} WHERE id = ?`, [d.id_parent]);
			if (!p) throw httpErr(400, "company.errors.validation", [{ field: "id_parent", message: "not found" }]);
		}
		if (d.id_head) {
			const [[h]] = await conn.query(`SELECT id FROM ${T.users} WHERE id = ? AND active = 1`, [d.id_head]);
			if (!h) throw httpErr(400, "company.errors.validation", [{ field: "id_head", message: "not found" }]);
		}
		if (d.offices.length) {
			const [o] = await conn.query(`SELECT id FROM ${T.offices} WHERE id IN (?)`, [d.offices]);
			if (o.length !== d.offices.length) throw httpErr(400, "company.errors.validation", [{ field: "offices", message: "not found" }]);
		}

		const cols = ["id_parent", "name", "code", "description", "id_head", "status", "sort_order"];
		const values = cols.map((c) => (typeof d[c] === "boolean" ? Number(d[c]) : (d[c] ?? null)));
		let deptId = id;
		if (id) {
			await conn.query(`UPDATE ${T.depts} SET ${cols.map((c) => `${c} = ?`).join(", ")}, date_edit = NOW() WHERE id = ?`, [...values, id]);
		} else {
			const [r] = await conn.query(`INSERT INTO ${T.depts} (${cols.join(", ")}, id_user_add, date_add, date_edit) VALUES (${cols.map(() => "?").join(", ")}, ?, NOW(), NOW())`, [...values, idUser || null]);
			deptId = r.insertId;
		}

		await conn.query(`DELETE FROM ${T.deptOffices} WHERE id_department = ?`, [deptId]);
		if (d.offices.length) await conn.query(`INSERT INTO ${T.deptOffices} (id_department, id_office) VALUES ?`, [d.offices.map((o) => [deptId, o])]);

		await conn.commit();
		return { id: deptId };
	} catch (e) {
		await conn.rollback();
		if (e.code === "ER_DUP_ENTRY") throw httpErr(409, "company.errors.code_taken", [{ field: "code", message: "already exists" }]);
		throw e;
	} finally {
		if (locked) await conn.query(`SELECT RELEASE_LOCK(?)`, [TREE_LOCK]).catch(() => {});
		conn.release();
	}
}

async function remove(id) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [[cur]] = await conn.query(`SELECT id FROM ${T.depts} WHERE id = ? FOR UPDATE`, [id]);
		if (!cur) throw httpErr(404, "company.errors.not_found");
		const [[n]] = await conn.query(
			`SELECT (SELECT COUNT(*) FROM ${T.users} WHERE id_department = ?) AS people,
			        (SELECT COUNT(*) FROM ${T.depts} WHERE id_parent = ?) AS children`,
			[id, id]
		);
		if (Number(n.people) || Number(n.children)) throw httpErr(409, "company.errors.department_not_empty");
		await conn.query(`DELETE FROM ${T.depts} WHERE id = ?`, [id]);
		await conn.commit();
		return { ok: true };
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
}

module.exports = { list, options, get, save, remove };