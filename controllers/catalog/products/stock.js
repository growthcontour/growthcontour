"use strict";

const config = require("../../../config/config");
const settings = require("./settings");

const P = config.get("configDatabase").prefix;
const FIELDS = ["on_hand", "reserved", "incoming"];

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

// DECIMAL(15,3) приходить рядком — рахуємо в тисячних, щоб не ловити похибку float
const toMilli = (v) => Math.round(Number(v || 0) * 1000);
const fromMilli = (m) => m / 1000;

/**
 * Змінити залишок у межах відкритої транзакції conn.
 * o: { idProduct, idVariant=0, idWarehouse, field='on_hand', delta, type, refType, refId, idUser, comment, costPrice, idBatch }
 * Повертає { before, after }.
 */
async function adjust(conn, o) {
	const field = o.field || "on_hand";
	if (!FIELDS.includes(field)) throw new Error("stock.adjust: invalid field " + field);
	const delta = toMilli(o.delta);
	if (delta === 0) return null;
	const idVariant = o.idVariant || 0;

	const [[wh]] = await conn.query(`SELECT id, allow_negative, status, deleted_at FROM ${P}products_warehouses WHERE id = ?`, [o.idWarehouse]);
	if (!wh || wh.deleted_at) throw httpErr(400, "Warehouse not found", [{ field: "stock", message: "warehouse not found" }]);

	// Рядок залишку створюємо, якщо його ще немає; далі — блокування рядка до кінця транзакції
	await conn.query(
		`INSERT INTO ${P}products_stock (id_product, id_variant, id_warehouse) VALUES (?, ?, ?)
		 ON DUPLICATE KEY UPDATE id = id`,
		[o.idProduct, idVariant, o.idWarehouse]
	);
	const [[row]] = await conn.query(
		`SELECT id, ${field} AS qty FROM ${P}products_stock WHERE id_product = ? AND id_variant = ? AND id_warehouse = ? FOR UPDATE`,
		[o.idProduct, idVariant, o.idWarehouse]
	);

	const before = toMilli(row.qty);
	const after = before + delta;
	if (after < 0) {
		const cfg = await settings.get("stock");
		const negativeAllowed = field === "on_hand" && (cfg.allow_negative || Number(wh.allow_negative) === 1);
		if (!negativeAllowed) throw httpErr(409, "Insufficient stock", [{ field: "stock", message: `insufficient ${field} in warehouse #${o.idWarehouse}` }]);
	}

	await conn.query(`UPDATE ${P}products_stock SET ${field} = ? WHERE id = ?`, [fromMilli(after), row.id]);
	await conn.query(
		`INSERT INTO ${P}products_stock_movements
		   (id_product, id_variant, id_warehouse, id_batch, type, qty, field, qty_before, qty_after, cost_price, ref_type, ref_id, id_user, comment)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[o.idProduct, idVariant, o.idWarehouse, o.idBatch || null, o.type, fromMilli(delta), field, fromMilli(before), fromMilli(after), o.costPrice ?? null, o.refType || null, o.refId || null, o.idUser || null, o.comment ? String(o.comment).slice(0, 512) : null]
	);
	return { before: fromMilli(before), after: fromMilli(after) };
}

/** Встановити точне значення (інвентаризація, ручне коригування) — через рух на різницю */
async function setQty(conn, o) {
	const idVariant = o.idVariant || 0;
	const [[row]] = await conn.query(
		`SELECT on_hand FROM ${P}products_stock WHERE id_product = ? AND id_variant = ? AND id_warehouse = ? FOR UPDATE`,
		[o.idProduct, idVariant, o.idWarehouse]
	);
	const current = row ? toMilli(row.on_hand) : 0;
	const target = toMilli(o.qty);
	if (current === target) return null;
	return adjust(conn, { ...o, field: "on_hand", delta: fromMilli(target - current) });
}

module.exports = { adjust, setQty };