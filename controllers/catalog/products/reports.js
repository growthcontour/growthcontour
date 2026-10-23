"use strict";

/**
 * Звіти каталогу (в основній валюті).
 * Продажі — позиції замовлень за статусами «враховувати у виручці», без скасованих і видалених, за датою замовлення.
 * Повернення віднімаються (кількість, виручка й собівартість — пропорційно поверненій кількості).
 * Собівартість — зафіксована в позиції на момент продажу; немає — поточна собівартість товару (позначається «оцінка»).
 *
 * margin(): маржа за товарами / категоріями / брендами / сайтами / місяцями.
 * stock(): оборотність — продажі за період, залишок, вартість запасу, на скільки днів вистачить, ABC за виручкою, «мертвий» запас.
 */
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");

const P = config.get("configDatabase").prefix;
const NON_PRODUCT_ITEM_TYPES = ["shipping", "fee", "tip", "discount", "gift_card", "wrapping"];
const MAX_DAYS = 731;

const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const day = (d) => d.toISOString().slice(0, 10);
const r2 = (n) => Math.round(Number(n) * 100) / 100;

function range(q) {
	let to = isDay(q.date_to) ? q.date_to : day(new Date());
	let from = isDay(q.date_from) ? q.date_from : day(new Date(Date.parse(to) - 29 * 86400000));
	if (from > to) [from, to] = [to, from];
	if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_DAYS) from = day(new Date(Date.parse(to) - MAX_DAYS * 86400000));
	const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
	return { from, to, days };
}

/** Позиції продажів за період з урахуванням повернень */
async function salesLines(q) {
	const { from, to } = range(q);
	const integ = parseInt(q.id_integration, 10);
	const [items] = await pool.query(
		`SELECT i.id_order, i.id_product, i.id_variant, i.sku, i.name, i.quantity, i.total_base, i.cost_price,
		        o.id_integration, DATE_FORMAT(o.date_order_day, '%Y-%m') AS month,
		        p.id_brand, p.id_category_main, COALESCE(v.cost_price, p.cost_price) AS cost_now
		   FROM ${P}orders_items i
		   JOIN ${P}orders o ON o.id = i.id_order AND o.deleted_at IS NULL AND o.is_canceled = 0
		   JOIN ${P}orders_status s ON s.id = o.status AND s.count_in_revenue = 1
		   LEFT JOIN ${P}products p ON p.id = i.id_product
		   LEFT JOIN ${P}products_variants v ON v.id = i.id_variant AND i.id_variant > 0
		  WHERE o.date_order_day BETWEEN ? AND ? AND COALESCE(i.type, 'product') NOT IN (?)${integ >= 0 && !isNaN(integ) ? " AND o.id_integration = ?" : ""}`,
		[from, to, NON_PRODUCT_ITEM_TYPES, ...(integ >= 0 && !isNaN(integ) ? [integ] : [])]
	);
	if (!items.length) return [];
	// Повернення: кількість по (замовлення, товар)
	const orders = [...new Set(items.map((i) => i.id_order))];
	const back = new Map();
	for (let k = 0; k < orders.length; k += 1000) {
		const [refunds] = await pool.query(`SELECT id_order, items FROM ${P}orders_refunds WHERE id_order IN (?) AND items IS NOT NULL`, [orders.slice(k, k + 1000)]);
		for (const r of refunds) {
			let list = [];
			try {
				list = typeof r.items === "string" ? JSON.parse(r.items) : r.items || [];
			} catch {}
			for (const it of list) {
				const key = `${r.id_order}:${Number(it.id_product) || 0}:${Number(it.id_variant) || 0}`;
				back.set(key, (back.get(key) || 0) + Number(it.qty || 0));
			}
		}
	}
	const out = [];
	for (const it of items) {
		const qty = Number(it.quantity);
		if (!(qty > 0)) continue;
		const key = `${it.id_order}:${Number(it.id_product) || 0}:${Number(it.id_variant) || 0}`;
		const ret = Math.min(qty, back.get(key) || 0);
		if (ret) back.set(key, back.get(key) - ret);
		const k = (qty - ret) / qty;
		if (k <= 0) continue;
		const estimated = it.cost_price === null;
		const unitCost = it.cost_price !== null ? Number(it.cost_price) : it.cost_now !== null ? Number(it.cost_now) : null;
		out.push({
			...it,
			qty: qty - ret,
			revenue: Number(it.total_base) * k,
			cost: unitCost === null ? null : unitCost * (qty - ret),
			estimated: estimated && unitCost !== null,
		});
	}
	return out;
}

const GROUPS = ["product", "category", "brand", "site", "month"];

async function margin(q, idLang) {
	const by = GROUPS.includes(q.group) ? q.group : "product";
	const lines = await salesLines(q);
	const agg = new Map();
	const tot = { revenue: 0, cost: 0, qty: 0, no_cost: 0, estimated: 0 };
	for (const l of lines) {
		const key =
			by === "product" ? (l.id_product ? `${l.id_product}:${l.id_variant}` : "sku:" + (l.sku || l.name)) : by === "category" ? l.id_category_main || 0 : by === "brand" ? l.id_brand || 0 : by === "site" ? l.id_integration || 0 : l.month;
		const a = agg.get(key) || { key, id_product: l.id_product, id_variant: l.id_variant, sku: l.sku, name: l.name, revenue: 0, cost: 0, revenue_costed: 0, qty: 0, no_cost: 0, estimated: 0 };
		a.revenue += l.revenue;
		a.qty += l.qty;
		tot.revenue += l.revenue;
		tot.qty += l.qty;
		if (l.cost === null) {
			a.no_cost++;
			tot.no_cost++;
		} else {
			a.cost += l.cost;
			a.revenue_costed += l.revenue;
			tot.cost += l.cost;
			if (l.estimated) (a.estimated++, tot.estimated++);
		}
		agg.set(key, a);
	}
	// Назви груп
	const ids = [...agg.keys()].filter((k) => typeof k === "number" && k > 0);
	const names = new Map();
	if (ids.length && by === "category") {
		const [r] = await pool.query(
			`SELECT c.id, COALESCE(NULLIF(d.name, ''), (SELECT d2.name FROM ${P}products_categories_description d2 WHERE d2.id_category = c.id ORDER BY d2.id_lang LIMIT 1)) AS name
			   FROM ${P}products_categories c LEFT JOIN ${P}products_categories_description d ON d.id_category = c.id AND d.id_lang = ? WHERE c.id IN (?)`,
			[idLang, ids]
		);
		r.forEach((x) => names.set(x.id, x.name));
	} else if (ids.length && by === "brand") {
		const [r] = await pool.query(
			`SELECT b.id, COALESCE(NULLIF(d.name, ''), b.code) AS name FROM ${P}products_brands b LEFT JOIN ${P}products_brands_description d ON d.id_brand = b.id AND d.id_lang = ? WHERE b.id IN (?)`,
			[idLang, ids]
		);
		r.forEach((x) => names.set(x.id, x.name));
	} else if (ids.length && by === "site") {
		const [r] = await pool.query(`SELECT id, name FROM ${P}settings_integrations WHERE id IN (?)`, [ids]);
		r.forEach((x) => names.set(x.id, x.name));
	}
	const rows = [...agg.values()].map((a) => {
		const profit = a.revenue_costed - a.cost;
		return {
			key: a.key,
			label: by === "product" ? a.name : by === "month" ? a.key : names.get(a.key) || null,
			id_product: by === "product" ? a.id_product : null,
			sku: by === "product" ? a.sku : null,
			qty: r2(a.qty),
			revenue: r2(a.revenue),
			cost: r2(a.cost),
			profit: r2(profit),
			margin: a.revenue_costed > 0 ? r2((profit / a.revenue_costed) * 100) : null,
			no_cost: a.no_cost,
			estimated: a.estimated,
		};
	});
	rows.sort((x, y) => (by === "month" ? String(x.key).localeCompare(String(y.key)) : y.profit - x.profit || y.revenue - x.revenue));
	// Маржа — лише з позицій, для яких відома собівартість
	const costedRevenue = tot.revenue - lines.filter((l) => l.cost === null).reduce((x, l) => x + l.revenue, 0);
	const profit = costedRevenue - tot.cost;
	return {
		range: range(q),
		group: by,
		total: { revenue: r2(tot.revenue), cost: r2(tot.cost), profit: r2(profit), qty: r2(tot.qty), margin: costedRevenue > 0 ? r2((profit / costedRevenue) * 100) : null, no_cost: tot.no_cost, estimated: tot.estimated },
		rows: rows.slice(0, 2000),
	};
}

/** Оборотність і ABC: продажі за період по товару / варіанту + поточний залишок */
async function stock(q, idLang) {
	const rg = range(q);
	const lines = await salesLines(q);
	const sold = new Map();
	for (const l of lines) {
		if (!l.id_product) continue;
		const k = `${l.id_product}:${l.id_variant}`;
		const s = sold.get(k) || { qty: 0, revenue: 0 };
		s.qty += l.qty;
		s.revenue += l.revenue;
		sold.set(k, s);
	}
	const [st] = await pool.query(
		`SELECT s.id_product, s.id_variant, SUM(s.on_hand) AS on_hand, COALESCE(v.sku, p.sku) AS sku, COALESCE(v.cost_price, p.cost_price) AS cost,
		        COALESCE((SELECT NULLIF(d.name, '') FROM ${P}products_description d WHERE d.id_product = s.id_product AND d.id_lang = ?),
		                 (SELECT d2.name FROM ${P}products_description d2 WHERE d2.id_product = s.id_product ORDER BY d2.id_lang LIMIT 1)) AS name
		   FROM ${P}products_stock s
		   JOIN ${P}products p ON p.id = s.id_product AND p.deleted_at IS NULL AND p.track_inventory = 1
		   LEFT JOIN ${P}products_variants v ON v.id = s.id_variant AND s.id_variant > 0
		  GROUP BY s.id_product, s.id_variant`,
		[idLang]
	);
	const rows = new Map();
	for (const s of st) rows.set(`${s.id_product}:${s.id_variant}`, { id_product: s.id_product, id_variant: s.id_variant, sku: s.sku, name: s.name, on_hand: Number(s.on_hand), cost: s.cost === null ? null : Number(s.cost) });
	// Продане, але без рядка залишку (не ведеться облік) — теж у ABC
	for (const l of lines) {
		const k = `${l.id_product}:${l.id_variant}`;
		if (l.id_product && !rows.has(k)) rows.set(k, { id_product: l.id_product, id_variant: l.id_variant, sku: l.sku, name: l.name, on_hand: null, cost: null });
	}
	const list = [...rows.entries()].map(([k, r]) => {
		const s = sold.get(k) || { qty: 0, revenue: 0 };
		const daily = s.qty / rg.days;
		return {
			...r,
			sold: r2(s.qty),
			revenue: r2(s.revenue),
			stock_value: r.on_hand !== null && r.cost !== null ? r2(Math.max(0, r.on_hand) * r.cost) : null,
			cover_days: r.on_hand !== null && daily > 0 ? Math.round(Math.max(0, r.on_hand) / daily) : null,
			turnover: r.on_hand > 0 ? r2(s.qty / r.on_hand) : null,
			dead: r.on_hand > 0 && s.qty === 0,
		};
	});
	// ABC за виручкою: A — перші 80%, B — до 95%, C — решта (і без продажів)
	const total = list.reduce((x, r) => x + r.revenue, 0);
	let acc = 0;
	list.sort((a, b) => b.revenue - a.revenue)
		.forEach((r) => {
			if (!(r.revenue > 0) || !total) return (r.abc = "C");
			acc += r.revenue;
			r.abc = acc / total <= 0.8 + 1e-9 ? "A" : acc / total <= 0.95 + 1e-9 ? "B" : "C";
		});
	const summary = {
		items: list.length,
		stock_value: r2(list.reduce((x, r) => x + (r.stock_value || 0), 0)),
		dead: list.filter((r) => r.dead).length,
		dead_value: r2(list.filter((r) => r.dead).reduce((x, r) => x + (r.stock_value || 0), 0)),
		abc: { A: list.filter((r) => r.abc === "A").length, B: list.filter((r) => r.abc === "B").length, C: list.filter((r) => r.abc === "C").length },
	};
	const view = q.view === "dead" ? list.filter((r) => r.dead).sort((a, b) => (b.stock_value || 0) - (a.stock_value || 0)) : list;
	return { range: rg, summary, rows: view.slice(0, 3000) };
}

module.exports = { margin, stock };