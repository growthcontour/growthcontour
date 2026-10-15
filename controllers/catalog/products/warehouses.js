"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("./settings");
const { validateWarehouse, validateLocation } = require("../../../validator/catalog/products/warehouses");

const P = config.get("configDatabase").prefix;

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

async function list() {
	const [rows] = await pool.query(
		`SELECT w.id, w.code, w.name, w.type, w.city, w.country, w.priority, w.is_sellable, w.allow_negative, w.status, w.sort_order,
		        s.name AS supplier_name,
		        (SELECT COUNT(*) FROM ${P}products_warehouse_locations l WHERE l.id_warehouse = w.id) AS locations_count,
		        (SELECT COALESCE(SUM(st.on_hand), 0) FROM ${P}products_stock st WHERE st.id_warehouse = w.id) AS on_hand_total
		   FROM ${P}products_warehouses w
		   LEFT JOIN ${P}products_suppliers s ON s.id = w.id_supplier
		  WHERE w.deleted_at IS NULL
		  ORDER BY w.priority, w.sort_order, w.id`
	);
	const { id_default_warehouse } = await settings.get("stock");
	return rows.map((r) => ({ ...r, is_default: r.id === id_default_warehouse }));
}

async function get(id) {
	const [[row]] = await pool.query(`SELECT * FROM ${P}products_warehouses WHERE id = ? AND deleted_at IS NULL`, [id]);
	if (!row) throw httpErr(404, "Not found");
	return row;
}

async function save(id, body) {
	const v = validateWarehouse(body);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);
	const d = v.data;

	if (d.id_supplier) {
		const [[s]] = await pool.query(`SELECT id FROM ${P}products_suppliers WHERE id = ? AND deleted_at IS NULL`, [d.id_supplier]);
		if (!s) throw httpErr(400, "Validation failed", [{ field: "id_supplier", message: "supplier not found" }]);
	}
	if (id) {
		const { id_default_warehouse } = await settings.get("stock");
		if (id === id_default_warehouse && !d.status) throw httpErr(409, "Default warehouse cannot be disabled", [{ field: "status", message: "default warehouse" }]);
	}

	const cols = ["code", "name", "type", "id_supplier", "country", "city", "address", "postcode", "latitude", "longitude", "carrier_ref", "phone", "priority", "is_sellable", "allow_negative", "status", "sort_order"];
	const values = cols.map((c) => (typeof d[c] === "boolean" ? Number(d[c]) : d[c] ?? null));

	try {
		if (id) {
			const [r] = await pool.query(`UPDATE ${P}products_warehouses SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND deleted_at IS NULL`, [...values, id]);
			if (!r.affectedRows) throw httpErr(404, "Not found");
			return { id };
		}
		const [r] = await pool.query(`INSERT INTO ${P}products_warehouses (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, values);
		return { id: r.insertId };
	} catch (e) {
		if (e.code === "ER_DUP_ENTRY") throw httpErr(409, "Code already exists", [{ field: "code", message: "already exists" }]);
		throw e;
	}
}

async function setDefault(id, idUser) {
	const w = await get(id);
	if (!w.status) throw httpErr(409, "Inactive warehouse cannot be default");
	const stock = await settings.get("stock");
	await settings.save("stock", { ...stock, id_default_warehouse: id }, idUser);
	return { ok: true };
}

async function remove(id, idUser) {
	const { id_default_warehouse } = await settings.get("stock");
	if (id === id_default_warehouse) throw httpErr(409, "Default warehouse cannot be deleted");

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		// Блокуємо рядок складу, щоб паралельний рух залишків не проскочив між перевіркою і видаленням
		const [[w]] = await conn.query(`SELECT id FROM ${P}products_warehouses WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [id]);
		if (!w) throw httpErr(404, "Not found");

		const [[st]] = await conn.query(`SELECT COALESCE(SUM(ABS(on_hand) + reserved + incoming), 0) AS qty FROM ${P}products_stock WHERE id_warehouse = ?`, [id]);
		if (Number(st.qty) > 0) throw httpErr(409, "Warehouse has stock, reservations or incoming goods");

		const [[docs]] = await conn.query(`SELECT COUNT(*) AS n FROM ${P}products_stock_documents WHERE status = 'draft' AND (id_warehouse = ? OR id_warehouse_to = ?)`, [id, id]);
		if (Number(docs.n) > 0) throw httpErr(409, "Warehouse is used in draft stock documents");

		await conn.query(`UPDATE ${P}products_warehouses SET deleted_at = NOW(), id_user_deleted = ?, status = 0 WHERE id = ?`, [idUser || null, id]);
		await conn.commit();
		return { ok: true };
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
}

// ─── Комірки ─────────────────────────────────────────
async function listLocations(idWarehouse) {
	await get(idWarehouse);
	const [rows] = await pool.query(
		`SELECT l.id, l.code, l.name, l.status,
		        (SELECT COUNT(*) FROM ${P}products_stock st WHERE st.id_location = l.id) AS items
		   FROM ${P}products_warehouse_locations l
		  WHERE l.id_warehouse = ?
		  ORDER BY l.code`,
		[idWarehouse]
	);
	return rows;
}

async function saveLocation(idWarehouse, id, body) {
	await get(idWarehouse);
	const v = validateLocation(body);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);
	const d = v.data;
	try {
		if (id) {
			const [r] = await pool.query(`UPDATE ${P}products_warehouse_locations SET code = ?, name = ?, status = ? WHERE id = ? AND id_warehouse = ?`, [d.code, d.name, Number(d.status), id, idWarehouse]);
			if (!r.affectedRows) throw httpErr(404, "Not found");
			return { id };
		}
		const [r] = await pool.query(`INSERT INTO ${P}products_warehouse_locations (id_warehouse, code, name, status) VALUES (?, ?, ?, ?)`, [idWarehouse, d.code, d.name, Number(d.status)]);
		return { id: r.insertId };
	} catch (e) {
		if (e.code === "ER_DUP_ENTRY") throw httpErr(409, "Code already exists", [{ field: "code", message: "already exists" }]);
		throw e;
	}
}

async function deleteLocation(idWarehouse, id) {
	// FK products_stock.id_location → ON DELETE SET NULL: товари втрачають прив’язку до комірки
	const [r] = await pool.query(`DELETE FROM ${P}products_warehouse_locations WHERE id = ? AND id_warehouse = ?`, [id, idWarehouse]);
	if (!r.affectedRows) throw httpErr(404, "Not found");
	return { ok: true };
}

module.exports = { list, get, save, setDefault, remove, listLocations, saveLocation, deleteLocation };