"use strict";

const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const dealStock = require("../catalog/products/deal-stock");

const p = config.get("configDatabase").prefix;

function httpErr(status, message, extra) {
	return Object.assign(new Error(message), { status }, extra || {});
}

const num = (v, def = 0) => {
	const n = parseFloat(v);
	return Number.isFinite(n) ? n : def;
};
const intOrNull = (v) => {
	const n = parseInt(v, 10);
	return Number.isInteger(n) && n > 0 ? n : null;
};
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

/** Розрахунок рядка — та сама формула, що була в роутах угод */
function calc(b) {
	const qty = num(b.qty, 1);
	const price = num(b.price);
	const discount = num(b.discount);
	const taxRate = num(b.tax_rate);
	const taxIncluded = Number(b.tax_included) === 1 ? 1 : 0;

	const discountAmount = Number(b.discount_type) === 1 ? discount : (price * qty * discount) / 100;
	const amount = price * qty - discountAmount;
	const taxAmount = taxIncluded ? amount - amount / (1 + taxRate / 100) : (amount * taxRate) / 100;
	const amountTotal = taxIncluded ? amount : amount + taxAmount;
	const cost = num(b.cost_price);
	const marginAmount = amountTotal - cost * qty;

	return {
		qty,
		price,
		discount,
		discount_type: Number(b.discount_type) === 1 ? 1 : 0,
		discount_amount: round(discountAmount, 4),
		tax_rate: taxRate,
		tax_included: taxIncluded,
		tax_amount: round(taxAmount, 4),
		amount: round(amount, 4),
		amount_total: round(amountTotal, 4),
		cost_price: cost,
		margin_amount: round(marginAmount, 4),
		margin_percent: amountTotal > 0 ? round((marginAmount / amountTotal) * 100, 2) : 0,
	};
}

/** Підставити дані товару: перевірка існування/варіанта, назва, SKU, собівартість */
async function resolveProduct(conn, b) {
	const idProduct = intOrNull(b.id_product);
	if (!idProduct) return { id_product: null, id_variant: 0, id_warehouse: intOrNull(b.id_warehouse) };

	const [[product]] = await conn.query(
		`SELECT p.id, p.type, p.sku, p.cost_price,
		        (SELECT d.name FROM ${p}products_description d WHERE d.id_product = p.id ORDER BY d.id_lang LIMIT 1) AS name
		   FROM ${p}products p WHERE p.id = ? AND p.deleted_at IS NULL`,
		[idProduct]
	);
	if (!product) throw httpErr(400, "Product not found", { code: "product_not_found" });

	let idVariant = intOrNull(b.id_variant) || 0;
	let sku = product.sku;
	let cost = product.cost_price;
	if (product.type === "variable") {
		if (!idVariant) throw httpErr(400, "Variant is required", { code: "variant_required" });
		const [[v]] = await conn.query(`SELECT id, sku, cost_price FROM ${p}products_variants WHERE id = ? AND id_product = ?`, [idVariant, idProduct]);
		if (!v) throw httpErr(400, "Variant not found", { code: "variant_not_found" });
		sku = v.sku || sku;
		cost = v.cost_price ?? cost;
	} else idVariant = 0;

	const idWarehouse = intOrNull(b.id_warehouse);
	if (idWarehouse) {
		const [[w]] = await conn.query(`SELECT id FROM ${p}products_warehouses WHERE id = ? AND deleted_at IS NULL AND status = 1`, [idWarehouse]);
		if (!w) throw httpErr(400, "Warehouse not found", { code: "warehouse_not_found" });
	}

	return {
		id_product: idProduct,
		id_variant: idVariant,
		id_warehouse: idWarehouse,
		name: String(b.name || "").trim() || product.name,
		sku: String(b.sku || "").trim() || sku,
		cost_price: b.cost_price === undefined || b.cost_price === null || b.cost_price === "" ? cost : b.cost_price,
	};
}

/** Перерахунок сум угоди одним запитом */
async function recalcDeal(conn, idDeal) {
	await conn.query(
		`UPDATE ${p}deals d
		   JOIN (SELECT COALESCE(SUM(price * qty), 0)     AS gross,
		                COALESCE(SUM(amount), 0)          AS amount,
		                COALESCE(SUM(discount_amount), 0) AS discount,
		                COALESCE(SUM(tax_amount), 0)      AS tax,
		                COALESCE(SUM(amount_total), 0)    AS total,
		                COALESCE(SUM(margin_amount), 0)   AS margin
		           FROM ${p}deals_item WHERE id_deal = ? AND active = 1) t
		    SET d.amount_gross    = t.gross,
		        d.amount          = t.amount,
		        d.discount_amount = t.discount,
		        d.tax_amount      = t.tax,
		        d.amount_final    = t.total,
		        d.amount_weighted = t.total * d.probability / 100,
		        d.margin_amount   = t.margin,
		        d.margin_percent  = IF(t.total > 0, ROUND(t.margin / t.total * 100, 2), 0),
		        d.date_edit       = NOW()
		  WHERE d.id = ?`,
		[idDeal, idDeal]
	);
}

async function lockDeal(conn, idDeal) {
	const [[deal]] = await conn.query(
		`SELECT d.id, s.stage_type FROM ${p}deals d LEFT JOIN ${p}deals_stage s ON s.id = d.id_stage
		  WHERE d.id = ? AND d.active = 1 FOR UPDATE`,
		[idDeal]
	);
	if (!deal) throw httpErr(404, "Deal not found");
	return deal;
}

/** Створити (itemId = null) або змінити рядок угоди */
async function save(idDeal, itemId, b, idUser) {
	const name = String(b.name || "").trim();
	if (!intOrNull(b.id_product) && !name) throw httpErr(400, "Name is required", { code: "name_required" });
	if (!(num(b.qty, 1) > 0)) throw httpErr(400, "Qty must be > 0", { code: "qty_invalid" });

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const deal = await lockDeal(conn, idDeal);

		if (itemId) {
			const [[own]] = await conn.query(`SELECT id FROM ${p}deals_item WHERE id = ? AND id_deal = ? AND active = 1 FOR UPDATE`, [itemId, idDeal]);
			if (!own) throw httpErr(404, "Item not found");
		}

		const prod = await resolveProduct(conn, b);
		const c = calc({ ...b, cost_price: prod.id_product ? prod.cost_price : b.cost_price });
		const row = {
			id_item_type: intOrNull(b.item_type) || 8,
			id_product: prod.id_product,
			id_variant: prod.id_variant,
			id_warehouse: prod.id_warehouse,
			ref_type: b.ref_type || null,
			id_ref: intOrNull(b.id_ref),
			id_unit: intOrNull(b.id_unit),
			id_tax: intOrNull(b.id_tax),
			name: prod.id_product ? prod.name : name,
			description: b.description || null,
			sku: prod.id_product ? prod.sku : b.sku || null,
			price_currency: b.price_currency || "USD",
			billing_period: b.billing_period || null,
			billing_cycles: b.billing_cycles || null,
			date_from: b.date_from || null,
			date_to: b.date_to || null,
			sort_order: parseInt(b.sort_order, 10) || 0,
			...c,
		};
		const cols = Object.keys(row);

		let id = itemId;
		if (itemId) {
			await conn.query(`UPDATE ${p}deals_item SET ${cols.map((k) => `\`${k}\` = ?`).join(", ")}, date_edit = NOW() WHERE id = ?`, [...cols.map((k) => row[k]), itemId]);
		} else {
			const [r] = await conn.query(
				`INSERT INTO ${p}deals_item (id_deal, ${cols.map((k) => `\`${k}\``).join(", ")}, active, date_add, date_edit)
				 VALUES (?, ${cols.map(() => "?").join(", ")}, 1, NOW(), NOW())`,
				[idDeal, ...cols.map((k) => row[k])]
			);
			id = r.insertId;
		}

		await recalcDeal(conn, idDeal);
		const warnings = await dealStock.sync(conn, idDeal, deal.stage_type, idUser);
		await conn.commit();
		return { id, warnings };
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

async function remove(idDeal, itemId, idUser) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const deal = await lockDeal(conn, idDeal);
		const [r] = await conn.query(`UPDATE ${p}deals_item SET active = 0, date_edit = NOW() WHERE id = ? AND id_deal = ? AND active = 1`, [itemId, idDeal]);
		if (!r.affectedRows) throw httpErr(404, "Item not found");
		await recalcDeal(conn, idDeal);
		const warnings = await dealStock.sync(conn, idDeal, deal.stage_type, idUser);
		await conn.commit();
		return { warnings };
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

/**
 * Зміна стадії разом зі складом в одній транзакції.
 * Повертає { warnings } або кидає 409 insufficient_stock (стадія не змінюється).
 */
async function changeStage(idDeal, body, user, ip) {
	const stageId = parseInt(body.id_stage, 10);
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [[deal]] = await conn.query(`SELECT id_stage, probability, date_stage_changed, date_add FROM ${p}deals WHERE id = ? AND active = 1 FOR UPDATE`, [idDeal]);
		if (!deal) throw httpErr(404, "Not found");
		const [[stage]] = await conn.query(`SELECT stage_type, probability FROM ${p}deals_stage WHERE id = ? LIMIT 1`, [stageId]);
		if (!stage) throw httpErr(404, "Stage not found");

		let probability = stage.probability;
		if (stage.stage_type === "won") probability = 100;
		else if (stage.stage_type === "lost" || stage.stage_type === "canceled") probability = 0;

		let extra = "";
		let extraValues = [];
		if (stage.stage_type === "won") {
			extra = ", date_close_fact = ?";
			extraValues = [body.date_close_fact || new Date()];
		} else if (stage.stage_type === "lost") {
			extra = ", id_lost_reason = ?, competitor_name = COALESCE(?, competitor_name)";
			extraValues = [body.id_lost_reason || null, body.competitor_name || null];
		}

		const from = deal.date_stage_changed ? new Date(deal.date_stage_changed) : new Date(deal.date_add);
		const days = Math.floor((Date.now() - from) / 86400000);
		const note = body.note || null;
		const userName = [user.last_name, user.first_name].filter(Boolean).join(" ");

		await conn.query(
			`UPDATE ${p}deals
			    SET id_stage_prev = id_stage, id_stage = ?, probability = ?, probability_override = 0,
			        amount_weighted = amount_final * ? / 100, date_stage_changed = NOW(), date_edit = NOW()${extra}
			  WHERE id = ?`,
			[stageId, probability, probability, ...extraValues, idDeal]
		);
		await conn.query(
			`INSERT INTO ${p}deals_stage_history (id_deal, id_stage_from, id_stage_to, id_user, duration_days, note, date_add) VALUES (?, ?, ?, ?, ?, ?, NOW())`,
			[idDeal, deal.id_stage, stageId, user.id, days, note]
		);
		await conn.query(
			`INSERT INTO ${p}deals_audit_log (id_user, user_name, user_ip, entity_type, id_entity, action, field_name, value_old, value_new, description, date_add)
			 VALUES (?, ?, ?, 'deal', ?, 'stage_change', 'id_stage', ?, ?, ?, NOW())`,
			[user.id, userName, ip, idDeal, deal.id_stage, stageId, note]
		);
		if (Number(deal.probability) !== Number(probability)) {
			await conn.query(
				`INSERT INTO ${p}deals_audit_log (id_user, user_name, user_ip, entity_type, id_entity, action, field_name, value_old, value_new, description, date_add)
				 VALUES (?, ?, ?, 'deal', ?, 'update', 'probability', ?, ?, 'Автоматично від стадії', NOW())`,
				[user.id, userName, ip, idDeal, deal.probability, probability]
			);
		}

		const warnings = await dealStock.sync(conn, idDeal, stage.stage_type, user.id);
		await conn.commit();
		// Після commit: посилання на цифрові товари + сповіщення відповідальному (помилка не впливає на зміну стадії)
		if (stage.stage_type === "won") setImmediate(() => require("../catalog/products/alerts").onDealWon(idDeal));
		return { warnings };
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

module.exports = { save, remove, changeStage, recalcDeal, calc };