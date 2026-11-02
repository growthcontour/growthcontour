"use strict";

/**
 * «Що дозамовити»: рядки залишку, де доступного + очікуваного не вистачає.
 * Сигнал: доступне + в дорозі ≤ точки дозамовлення (reorder_point) АБО закінчиться раніше, ніж приїде поставка
 * (середні продажі за 30 днів × термін поставки постачальника).
 * Пропозиція: до «точка + партія» (reorder_qty; немає — продажі на max(термін, 14) днів), з кратністю мін. партії постачальника.
 * З вибраних рядків створюються чернетки надходження — по одній на склад для постачальника.
 */
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const docs = require("./stock-documents");

const P = config.get("configDatabase").prefix;
const DAYS = 30;

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

async function list({ idLang = 1, idWarehouse = null } = {}) {
	const wh = idWarehouse ? " AND s.id_warehouse = ?" : "";
	const args = idWarehouse ? [idLang, idWarehouse] : [idLang];
	// Продажі за 30 днів по рядку залишку (рух sale мінус return)
	const [rows] = await pool.query(
		`SELECT s.id_product, s.id_variant, s.id_warehouse, s.on_hand, s.reserved, s.available, s.incoming, s.reorder_point, s.reorder_qty,
		        w.code AS warehouse, COALESCE(v.sku, p.sku) AS sku,
		        COALESCE((SELECT NULLIF(d.name, '') FROM ${P}products_description d WHERE d.id_product = s.id_product AND d.id_lang = ?),
		                 (SELECT d2.name FROM ${P}products_description d2 WHERE d2.id_product = s.id_product ORDER BY d2.id_lang LIMIT 1)) AS name,
		        COALESCE((SELECT -SUM(m.qty) FROM ${P}products_stock_movements m
		                   WHERE m.id_product = s.id_product AND m.id_variant = s.id_variant AND m.id_warehouse = s.id_warehouse
		                     AND m.field = 'on_hand' AND m.type IN ('sale', 'return') AND m.date_add >= NOW() - INTERVAL ${DAYS} DAY), 0) AS sold
		   FROM ${P}products_stock s
		   JOIN ${P}products p ON p.id = s.id_product AND p.deleted_at IS NULL AND p.track_inventory = 1 AND p.status <> 'archived'
		   JOIN ${P}products_warehouses w ON w.id = s.id_warehouse AND w.deleted_at IS NULL AND w.status = 1
		   LEFT JOIN ${P}products_variants v ON v.id = s.id_variant AND s.id_variant > 0
		  WHERE (s.reorder_point IS NOT NULL OR EXISTS (SELECT 1 FROM ${P}products_stock_movements m2 WHERE m2.id_product = s.id_product AND m2.id_variant = s.id_variant
		         AND m2.id_warehouse = s.id_warehouse AND m2.type = 'sale' AND m2.date_add >= NOW() - INTERVAL ${DAYS} DAY))${wh}
		  LIMIT 5000`,
		args
	);
	if (!rows.length) return [];

	// Постачальник: для варіанта — свій рядок, інакше товару; основний — першим
	const ids = [...new Set(rows.map((r) => r.id_product))];
	const [sup] = await pool.query(
		`SELECT ts.id_product, ts.id_variant, ts.id_supplier, ts.supplier_sku, ts.supplier_price, ts.currency, ts.lead_time_days, ts.min_order_qty, ts.is_default, s.name AS supplier
		   FROM ${P}products_to_suppliers ts JOIN ${P}products_suppliers s ON s.id = ts.id_supplier AND s.deleted_at IS NULL
		  WHERE ts.id_product IN (?) ORDER BY ts.is_default DESC, ts.id_supplier`,
		[ids]
	);
	const supOf = (r) => sup.find((x) => x.id_product === r.id_product && Number(x.id_variant) === Number(r.id_variant)) || sup.find((x) => x.id_product === r.id_product && !Number(x.id_variant)) || null;

	const out = [];
	for (const r of rows) {
		const s = supOf(r);
		const daily = Math.max(0, Number(r.sold)) / DAYS;
		const lead = s && Number(s.lead_time_days) > 0 ? Number(s.lead_time_days) : 7;
		const available = Number(r.available);
		const incoming = Number(r.incoming) || 0;
		const covered = available + incoming;
		const point = r.reorder_point === null ? null : Number(r.reorder_point);
		const byPoint = point !== null && covered <= point;
		const byRunOut = daily > 0 && covered < daily * lead;
		if (!byPoint && !byRunOut) continue;
		const batch = r.reorder_qty !== null && Number(r.reorder_qty) > 0 ? Number(r.reorder_qty) : Math.ceil(daily * Math.max(lead, 14));
		let qty = Math.max(0, Math.ceil((point || 0) + batch - covered));
		const moq = s && Number(s.min_order_qty) > 0 ? Number(s.min_order_qty) : 0;
		if (moq && qty > 0) qty = Math.ceil(qty / moq) * moq;
		out.push({
			id_product: r.id_product,
			id_variant: r.id_variant,
			id_warehouse: r.id_warehouse,
			warehouse: r.warehouse,
			sku: r.sku,
			name: r.name || "#" + r.id_product,
			available,
			incoming,
			reorder_point: point,
			daily: Math.round(daily * 100) / 100,
			days_left: daily > 0 ? Math.floor(available / daily) : null,
			lead,
			reason: byPoint ? "point" : "run_out",
			qty,
			supplier: s ? { id: s.id_supplier, name: s.supplier, sku: s.supplier_sku, price: s.supplier_price === null ? null : Number(s.supplier_price), currency: s.currency || null, moq } : null,
		});
	}
	// Спершу те, що вже скінчилось / закінчиться найшвидше
	return out.sort((a, b) => (a.days_left ?? 1e9) - (b.days_left ?? 1e9) || a.available - b.available);
}

/**
 * Чернетки надходження з вибраних рядків. lines: [{ id_product, id_variant, id_warehouse, qty, id_supplier, price?, currency? }]
 * Групування: постачальник × склад × валюта ціни — одна чернетка на групу.
 */
async function createDrafts(lines, ctx) {
	const clean = (Array.isArray(lines) ? lines : [])
		.map((l) => ({
			id_product: parseInt(l.id_product, 10),
			id_variant: parseInt(l.id_variant, 10) || 0,
			id_warehouse: parseInt(l.id_warehouse, 10),
			id_supplier: parseInt(l.id_supplier, 10) || null,
			qty: Number(l.qty),
			price: l.price === null || l.price === undefined || l.price === "" ? null : Number(l.price),
			currency: l.currency && /^[A-Z]{3}$/.test(l.currency) ? l.currency : null,
		}))
		.filter((l) => l.id_product > 0 && l.id_warehouse > 0 && l.qty > 0);
	if (!clean.length) throw httpErr(400, "Validation failed", [{ field: "lines", message: "nothing selected" }]);
	const groups = new Map();
	for (const l of clean) {
		const k = `${l.id_supplier || 0}:${l.id_warehouse}:${l.currency || ""}`;
		(groups.get(k) || groups.set(k, []).get(k)).push(l);
	}
	const today = new Date().toISOString().slice(0, 10);
	const created = [];
	for (const g of groups.values()) {
		const h = g[0];
		const r = await docs.saveDraft(
			null,
			{
				header: { type: "receipt", id_warehouse: h.id_warehouse, id_supplier: h.id_supplier, currency: h.currency, date_document: today, comment: ctx.comment || null },
				items: g.map((l) => ({ id_product: l.id_product, id_variant: l.id_variant, qty: l.qty, cost_price: l.price })),
			},
			ctx
		);
		created.push(r.id);
	}
	return { created };
}

module.exports = { list, createDrafts };