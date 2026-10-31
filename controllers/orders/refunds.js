"use strict";

/**
 * Повернення в замовленні.
 * Повернення = позиції й кількість + сума (+ доставка) + причина + «повернути на склад».
 * Склад не змінюється напряму: order-stock віднімає повернену кількість (restock) від списаного,
 * і sync() сам робить рух «return» на склад замовлення — журнал руху й резерви лишаються узгодженими.
 * Позиції повернення зберігаються з товаром каталогу (id_product / id_variant), бо рядки orders_items
 * перезаписуються вебхуком сайту (нові id).
 */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const orderStock = require("../catalog/products/order-stock");

const P = config.get("configDatabase").prefix;
const NON_PRODUCT_ITEM_TYPES = ["shipping", "fee", "tip", "discount", "gift_card", "wrapping"];
const r4 = (n) => Math.round(Number(n) * 10000) / 10000;
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

const parse = (v) => {
	if (!v) return [];
	try {
		const x = typeof v === "string" ? JSON.parse(v) : v;
		return Array.isArray(x) ? x : [];
	} catch {
		return [];
	}
};
const pkey = (idProduct, idVariant) => `${Number(idProduct) || 0}:${Number(idVariant) || 0}`;

/** Уже повернено по товару каталогу (усі повернення замовлення; restock — окремо) */
async function returnedMap(db, idOrder) {
	const [rows] = await db.query(`SELECT items, restock FROM ${P}orders_refunds WHERE id_order = ?`, [idOrder]);
	const all = new Map();
	const restocked = new Map();
	for (const r of rows) {
		for (const it of parse(r.items)) {
			const k = it.id_product ? pkey(it.id_product, it.id_variant) : "item:" + (it.sku || it.name || "");
			all.set(k, r3((all.get(k) || 0) + Number(it.qty)));
			// restock: false на позиції — брак: сума повертається, товар на склад ні
			if (Number(r.restock) && it.id_product && it.restock !== false) restocked.set(k, r3((restocked.get(k) || 0) + Number(it.qty)));
		}
	}
	return { all, restocked };
}

/** Позиції для форми повернення: скільки куплено, скільки вже повернено, ціна за од. */
async function form(idOrder) {
	const [[o]] = await pool.query(`SELECT id, currency_iso, total_paid, total_refunded, total_shipping FROM ${P}orders WHERE id = ? AND deleted_at IS NULL`, [idOrder]);
	if (!o) throw httpErr(404, "Order not found");
	const [items] = await pool.query(
		`SELECT id, id_product, id_variant, sku, name, quantity, total FROM ${P}orders_items WHERE id_order = ? AND COALESCE(type, 'product') NOT IN (?) ORDER BY id`,
		[idOrder, NON_PRODUCT_ITEM_TYPES]
	);
	const { all } = await returnedMap(pool, idOrder);
	// Повернене розподіляємо по рядках з тим самим товаром — по черзі
	const left = new Map(all);
	return {
		order: o,
		items: items.map((it) => {
			const k = it.id_product ? pkey(it.id_product, it.id_variant) : "item:" + (it.sku || it.name || "");
			const take = Math.min(Number(it.quantity), left.get(k) || 0);
			left.set(k, r3((left.get(k) || 0) - take));
			const qty = Number(it.quantity);
			return { id: it.id, sku: it.sku, name: it.name, quantity: qty, returned: take, available: r3(qty - take), unit: qty > 0 ? r4(Number(it.total) / qty) : 0, mapped: !!it.id_product };
		}),
	};
}

/**
 * Оформити повернення. body: { items: [{ id_item, qty, restock? }], restock, amount?, shipping?, reason, transaction_id? }
 * amount не задано — сума позицій за ціною продажу (з урахуванням знижки рядка).
 * opts.inTx(conn, { id, number, amount }) — дія в тій самій транзакції (заявка на повернення / обмін); opts.notify: false — без сповіщення.
 */
async function create(idOrder, body, idUser, opts = {}) {
	const b = body || {};
	const reqItems = (Array.isArray(b.items) ? b.items : []).map((x) => ({ id_item: parseInt(x.id_item, 10), qty: r3(x.qty), restock: x.restock !== false })).filter((x) => x.id_item > 0 && x.qty > 0);
	const shipping = Math.max(0, r4(b.shipping || 0));
	const reason = String(b.reason || "").trim().slice(0, 255);
	if (!reqItems.length && !(Number(b.amount) > 0) && !(shipping > 0)) throw httpErr(400, "Validation failed", [{ field: "items", message: "nothing to refund" }]);

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [[o]] = await conn.query(`SELECT id, reference, currency_rate, total, total_paid, total_refunded FROM ${P}orders WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [idOrder]);
		if (!o) throw httpErr(404, "Order not found");
		const f = await form(idOrder);
		const byId = new Map(f.items.map((x) => [x.id, x]));
		const [rows] = await conn.query(`SELECT id, id_product, id_variant, sku, name FROM ${P}orders_items WHERE id_order = ?`, [idOrder]);
		const rowById = new Map(rows.map((x) => [x.id, x]));

		const lines = [];
		const used = new Map(); // той самий рядок кількома частинами (придатне + брак) — сумарно не більше доступного
		let itemsAmount = 0;
		for (const [i, x] of reqItems.entries()) {
			const it = byId.get(x.id_item);
			if (!it) throw httpErr(400, "Validation failed", [{ field: `items.${i}.id_item`, message: "item not found" }]);
			const sum = r3((used.get(x.id_item) || 0) + x.qty);
			if (sum > it.available + 0.0005) throw httpErr(400, "Validation failed", [{ field: `items.${i}.qty`, message: `max ${it.available}` }]);
			used.set(x.id_item, sum);
			const row = rowById.get(x.id_item);
			lines.push({ id_product: row.id_product || null, id_variant: row.id_variant || 0, sku: row.sku || null, name: row.name, qty: x.qty, unit: it.unit, amount: r4(it.unit * x.qty), ...(x.restock ? {} : { restock: false }) });
			itemsAmount += it.unit * x.qty;
		}
		const amount = Number(b.amount) > 0 ? r4(b.amount) : r4(itemsAmount + shipping);
		// Не більше, ніж сума замовлення мінус уже повернене
		const limit = r4(Number(o.total) - Number(o.total_refunded));
		if (amount > limit + 0.005) throw httpErr(400, "Validation failed", [{ field: "amount", message: `max ${limit}` }]);
		const restock = b.restock !== false && lines.some((l) => l.id_product) ? 1 : 0;

		const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM ${P}orders_refunds WHERE id_order = ?`, [idOrder]);
		const number = `${o.reference || idOrder}-R${Number(n) + 1}`;
		const amountBase = r4(amount * Number(o.currency_rate || 1));
		const [ins] = await conn.query(
			`INSERT INTO ${P}orders_refunds (id_order, number, reason, amount, amount_base, shipping_refunded, restock, id_user, transaction_id, items, date_add)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
			[idOrder, number, reason || null, amount, amountBase, shipping, restock, idUser || null, b.transaction_id ? String(b.transaction_id).slice(0, 191) : null, JSON.stringify(lines)]
		);
		await totals(conn, idOrder);
		await conn.query(`INSERT INTO ${P}orders_events (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, 'refund', ?, 'manual', NOW())`, [
			idOrder,
			idUser,
			JSON.stringify({ id_refund: ins.insertId, number, amount, restock: !!restock, items: lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty })) }),
		]);
		if (opts.inTx) await opts.inTx(conn, { id: ins.insertId, number, amount });
		// Склад: повернене (restock) віднімається від списаного → рух «return»
		const stockState = await orderStock.sync(conn, idOrder, idUser);
		await conn.commit();
		if (opts.notify !== false) require("./notify").fire(idOrder, "refund", { amount: Number(amount).toFixed(2) });
		return { id: ins.insertId, number, amount, stock: stockState };
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
}

/** Скасувати повернення (помилково оформлене): суми й склад повертаються як були */
async function remove(idOrder, idRefund, idUser) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [[o]] = await conn.query(`SELECT id FROM ${P}orders WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [idOrder]);
		if (!o) throw httpErr(404, "Order not found");
		const [[r]] = await conn.query(`SELECT id, number, amount FROM ${P}orders_refunds WHERE id = ? AND id_order = ?`, [idRefund, idOrder]);
		if (!r) throw httpErr(404, "Refund not found");
		// Повернення за заявкою (повернення / обмін) не скасовується окремо від неї
		const [[rma]] = await conn.query(`SELECT number FROM ${P}orders_returns WHERE id_refund = ? LIMIT 1`, [idRefund]);
		if (rma) throw httpErr(409, "Linked to return request " + rma.number);
		await conn.query(`DELETE FROM ${P}orders_refunds WHERE id = ?`, [idRefund]);
		await totals(conn, idOrder);
		await conn.query(`INSERT INTO ${P}orders_events (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, 'refund_canceled', ?, 'manual', NOW())`, [
			idOrder,
			idUser,
			JSON.stringify({ id_refund: r.id, number: r.number, amount: Number(r.amount) }),
		]);
		const stockState = await orderStock.sync(conn, idOrder, idUser);
		await conn.commit();
		return { stock: stockState };
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
}

/** Суми повернень у замовленні й фінансовий / відвантажувальний стан */
async function totals(conn, idOrder) {
	const [[s]] = await conn.query(`SELECT COALESCE(SUM(amount), 0) AS a, COALESCE(SUM(amount_base), 0) AS b FROM ${P}orders_refunds WHERE id_order = ?`, [idOrder]);
	const [[o]] = await conn.query(`SELECT total, total_paid, financial_status, fulfillment_status FROM ${P}orders WHERE id = ?`, [idOrder]);
	const refunded = Number(s.a);
	const paid = Number(o.total_paid) > 0 ? Number(o.total_paid) : Number(o.total);
	let fin = o.financial_status;
	if (refunded > 0) fin = refunded + 0.005 >= paid ? "refunded" : "partially_refunded";
	else if (["refunded", "partially_refunded"].includes(fin)) fin = Number(o.total_paid) > 0 ? "paid" : "pending";
	// Усі товари повернено → «returned»; скасували повернення — назад «fulfilled»
	const f = await formOn(conn, idOrder);
	const allBack = f.length && f.every((x) => x.available <= 0.0005);
	let ful = o.fulfillment_status;
	if (allBack) ful = "returned";
	else if (ful === "returned") ful = "fulfilled";
	await conn.query(`UPDATE ${P}orders SET total_refunded = ?, total_refunded_base = ?, financial_status = ?, fulfillment_status = ?, revision = revision + 1, date_edit = NOW() WHERE id = ?`, [
		r4(refunded),
		r4(s.b),
		fin,
		ful,
		idOrder,
	]);
}

/** Залишок до повернення по рядках — у межах транзакції */
async function formOn(conn, idOrder) {
	const [items] = await conn.query(`SELECT id_product, id_variant, sku, name, quantity FROM ${P}orders_items WHERE id_order = ? AND COALESCE(type, 'product') NOT IN (?)`, [idOrder, NON_PRODUCT_ITEM_TYPES]);
	const { all } = await returnedMap(conn, idOrder);
	const left = new Map(all);
	return items.map((it) => {
		const k = it.id_product ? pkey(it.id_product, it.id_variant) : "item:" + (it.sku || it.name || "");
		const take = Math.min(Number(it.quantity), left.get(k) || 0);
		left.set(k, r3((left.get(k) || 0) - take));
		return { available: r3(Number(it.quantity) - take) };
	});
}

module.exports = { form, create, remove, returnedMap, pkey };