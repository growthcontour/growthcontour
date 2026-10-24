"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const { validateSupplier } = require("../../../validator/catalog/products/suppliers");

const P = config.get("configDatabase").prefix;

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

const SORTABLE = { id: "s.id", code: "s.code", name: "s.name", country: "s.country", lead_time_days: "s.lead_time_days", status: "s.status", date_add: "s.date_add" };

/** Серверна пагінація для Tabulator (paginationMode: remote) */
async function list(q) {
	const size = Math.min(Math.max(parseInt(q.size, 10) || 50, 1), 200);
	const page = Math.max(parseInt(q.page, 10) || 1, 1);
	const where = ["s.deleted_at IS NULL"];
	const params = [];

	const search = String(q.search || "").trim();
	if (search) {
		const like = "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
		where.push("(s.name LIKE ? OR s.code LIKE ? OR s.email LIKE ? OR s.phone LIKE ? OR s.tax_number LIKE ?)");
		params.push(like, like, like, like, like);
	}
	if (q.status === "0" || q.status === "1") {
		where.push("s.status = ?");
		params.push(Number(q.status));
	}

	const sort = Array.isArray(q.sort) && q.sort[0] ? q.sort[0] : {};
	const orderCol = SORTABLE[sort.field] || "s.name";
	const orderDir = sort.dir === "desc" ? "DESC" : "ASC";

	const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${P}products_suppliers s WHERE ${where.join(" AND ")}`, params);
	const [rows] = await pool.query(
		`SELECT s.id, s.code, s.name, s.contact_person, s.email, s.phone, s.country, s.currency, s.lead_time_days, s.status,
		        (SELECT COUNT(DISTINCT pts.id_product) FROM ${P}products_to_suppliers pts WHERE pts.id_supplier = s.id) AS products_count
		   FROM ${P}products_suppliers s
		  WHERE ${where.join(" AND ")}
		  ORDER BY ${orderCol} ${orderDir}, s.id ${orderDir}
		  LIMIT ? OFFSET ?`,
		[...params, size, (page - 1) * size]
	);
	return { last_page: Math.max(Math.ceil(total / size), 1), last_row: total, data: rows };
}

/** Короткий список для select-ів (склади, карточка товару) */
async function options(search) {
	const like = "%" + String(search || "").replace(/[\\%_]/g, "\\$&") + "%";
	const [rows] = await pool.query(
		`SELECT id, name, code FROM ${P}products_suppliers
		  WHERE deleted_at IS NULL AND status = 1 AND (name LIKE ? OR code LIKE ?)
		  ORDER BY name LIMIT 50`,
		[like, like]
	);
	return rows;
}

async function get(id) {
	const [[row]] = await pool.query(`SELECT * FROM ${P}products_suppliers WHERE id = ? AND deleted_at IS NULL`, [id]);
	if (!row) throw httpErr(404, "Not found");
	return row;
}

async function save(id, body) {
	const v = validateSupplier(body);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);
	const d = v.data;

	const cols = ["code", "name", "tax_number", "contact_person", "email", "phone", "website", "address", "country", "currency", "lead_time_days", "note", "status"];
	const values = cols.map((c) => (typeof d[c] === "boolean" ? Number(d[c]) : d[c] ?? null));
	try {
		if (id) {
			const [r] = await pool.query(`UPDATE ${P}products_suppliers SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND deleted_at IS NULL`, [...values, id]);
			if (!r.affectedRows) throw httpErr(404, "Not found");
			return { id };
		}
		const [r] = await pool.query(`INSERT INTO ${P}products_suppliers (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, values);
		return { id: r.insertId };
	} catch (e) {
		if (e.code === "ER_DUP_ENTRY") throw httpErr(409, "Code already exists", [{ field: "code", message: "already exists" }]);
		throw e;
	}
}

module.exports = { list, options, get, save };