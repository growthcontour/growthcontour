"use strict";

const config = require("../../../config/config");
const settings = require("./settings");
const stock = require("./stock");
const reservations = require("./reservations");

const P = config.get("configDatabase").prefix;
const REF = "deal";
const NO_STOCK_TYPES = ["service", "digital", "gift_card"];

const key = (p, v, w) => `${p}:${v}:${w}`;

/** Додати name / sku / warehouse до записів { id_product, id_variant, id_warehouse } */
async function describe(conn, list) {
	const items = list.filter((x) => x.id_product);
	if (!items.length) return list;
	const ids = [...new Set(items.map((x) => x.id_product))];
	const vids = [...new Set(items.map((x) => x.id_variant).filter(Boolean))];
	const wids = [...new Set(items.map((x) => x.id_warehouse).filter(Boolean))];
	const [products] = await conn.query(
		`SELECT p.id, p.sku, (SELECT d.name FROM ${P}products_description d WHERE d.id_product = p.id ORDER BY d.id_lang LIMIT 1) AS name
		   FROM ${P}products p WHERE p.id IN (?)`,
		[ids]
	);
	const [variants] = vids.length ? await conn.query(`SELECT id, sku FROM ${P}products_variants WHERE id IN (?)`, [vids]) : [[]];
	const [warehouses] = wids.length ? await conn.query(`SELECT id, name FROM ${P}products_warehouses WHERE id IN (?)`, [wids]) : [[]];
	const pm = new Map(products.map((r) => [r.id, r]));
	const vm = new Map(variants.map((r) => [r.id, r]));
	const wm = new Map(warehouses.map((r) => [r.id, r]));
	for (const x of items) {
		const p = pm.get(x.id_product) || {};
		x.name = p.name || "#" + x.id_product;
		x.sku = (x.id_variant && vm.get(x.id_variant) ? vm.get(x.id_variant).sku : null) || p.sku || null;
		x.warehouse = wm.get(x.id_warehouse) ? wm.get(x.id_warehouse).name : null;
	}
	return list;
}
const parseKey = (k) => k.split(":").map(Number);
const milli = (n) => Math.round(Number(n) * 1000);

function httpErr(status, message, extra) {
	return Object.assign(new Error(message), { status }, extra || {});
}

/**
 * Що має бути на складі для рядків угоди: Map key → { qty, cost }
 * (комплекти розгорнуто, товари без обліку відкинуто).
 */
async function desiredLines(conn, idDeal, idDefaultWarehouse, warnings) {
	const [items] = await conn.query(
		`SELECT i.id, i.id_product, i.id_variant, i.id_warehouse, i.qty,
		        p.type, p.track_inventory, p.pack_stock_mode, p.cost_price, p.deleted_at
		   FROM ${P}deals_item i
		   JOIN ${P}products p ON p.id = i.id_product
		  WHERE i.id_deal = ? AND i.active = 1 AND i.id_product IS NOT NULL`,
		[idDeal]
	);

	const out = new Map();
	const add = (idProduct, idVariant, idWarehouse, qty, cost) => {
		const k = key(idProduct, idVariant || 0, idWarehouse);
		const cur = out.get(k);
		out.set(k, { qty: (cur ? cur.qty : 0) + milli(qty), cost: cost ?? null });
	};

	for (const it of items) {
		const wh = it.id_warehouse || idDefaultWarehouse;
		if (NO_STOCK_TYPES.includes(it.type)) continue;

		if (it.type === "bundle" && it.pack_stock_mode === "components") {
			const [components] = await conn.query(
				`SELECT bi.id_product, bi.id_variant, bi.qty, p.track_inventory, p.cost_price
				   FROM ${P}products_bundle_items bi JOIN ${P}products p ON p.id = bi.id_product
				  WHERE bi.id_bundle = ? AND bi.is_optional = 0`,
				[it.id_product]
			);
			for (const c of components) {
				if (Number(c.track_inventory)) add(c.id_product, c.id_variant, wh, Number(c.qty) * Number(it.qty), c.cost_price);
			}
			continue;
		}

		if (!Number(it.track_inventory)) continue;
		if (it.type === "variable" && !Number(it.id_variant)) {
			warnings.push({ id_item: it.id, code: "variant_required" });
			continue;
		}
		add(it.id_product, it.id_variant, wh, it.qty, it.cost_price);
	}
	return out;
}

/** Привести резерви угоди до target (Map key → {qty}) */
async function reconcileReservations(conn, idDeal, target, idUser, warnings) {
	const [rows] = await conn.query(`SELECT * FROM ${P}products_stock_reservations WHERE ref_type = ? AND ref_id = ? FOR UPDATE`, [REF, idDeal]);
	const current = new Map(rows.map((r) => [key(r.id_product, r.id_variant, r.id_warehouse), r]));
	const keys = [...new Set([...current.keys(), ...target.keys()])].sort();

	for (const k of keys) {
		const [idProduct, idVariant, idWarehouse] = parseKey(k);
		const want = target.get(k);
		const have = current.get(k);

		if (!want || want.qty <= 0) {
			if (have) {
				await stock.adjust(conn, { idProduct, idVariant, idWarehouse, field: "reserved", delta: -Number(have.qty), type: "unreserve", refType: REF, refId: idDeal, idUser });
				await conn.query(`DELETE FROM ${P}products_stock_reservations WHERE id = ?`, [have.id]);
			}
			continue;
		}
		if (have && milli(have.qty) === want.qty) continue;

		try {
			await conn.query("SAVEPOINT sp_reserve");
			await reservations.reserve(conn, { idProduct, idVariant, idWarehouse, qty: want.qty / 1000, refType: REF, refId: idDeal, idUser, ttlMinutes: 0 });
			await conn.query("RELEASE SAVEPOINT sp_reserve");
		} catch (e) {
			if (e.status !== 409) throw e;
			await conn.query("ROLLBACK TO SAVEPOINT sp_reserve");
			warnings.push({ id_product: idProduct, id_variant: idVariant, id_warehouse: idWarehouse, code: "insufficient_to_reserve" });
		}
	}
}

/** Привести списане по угоді до target: різниця — рух sale (−) або return (+) */
async function reconcileShipped(conn, idDeal, target, idUser) {
	const [rows] = await conn.query(
		`SELECT id_product, id_variant, id_warehouse, -SUM(qty) AS shipped
		   FROM ${P}products_stock_movements
		  WHERE ref_type = ? AND ref_id = ? AND field = 'on_hand' AND type IN ('sale', 'return')
		  GROUP BY id_product, id_variant, id_warehouse`,
		[REF, idDeal]
	);
	const current = new Map(rows.map((r) => [key(r.id_product, r.id_variant, r.id_warehouse), milli(r.shipped)]));
	const keys = [...new Set([...current.keys(), ...target.keys()])].sort();
	const shortages = [];

	for (const k of keys) {
		const [idProduct, idVariant, idWarehouse] = parseKey(k);
		const want = target.has(k) ? target.get(k).qty : 0;
		const have = current.get(k) || 0;
		const diff = want - have;
		if (diff === 0) continue;
		try {
			await stock.adjust(conn, {
				idProduct,
				idVariant,
				idWarehouse,
				field: "on_hand",
				delta: -diff / 1000,
				type: diff > 0 ? "sale" : "return",
				costPrice: target.has(k) ? target.get(k).cost : null,
				refType: REF,
				refId: idDeal,
				idUser,
			});
		} catch (e) {
			if (e.status !== 409) throw e;
			shortages.push({ id_product: idProduct, id_variant: idVariant, id_warehouse: idWarehouse, need: diff / 1000 });
		}
	}
	if (shortages.length) throw httpErr(409, "Insufficient stock to ship the deal", { code: "insufficient_stock", shortages: await describe(conn, shortages) });
}

/**
 * Синхронізувати склад з угодою (у транзакції викликача, угода вже заблокована FOR UPDATE).
 * stageType — тип стадії ПІСЛЯ зміни. Повертає warnings (резерв не вдався тощо).
 */
async function sync(conn, idDeal, stageType, idUser) {
	const cfg = await settings.get("stock");
	const warnings = [];
	const lines = await desiredLines(conn, idDeal, cfg.id_default_warehouse, warnings);

	const closed = stageType === "lost" || stageType === "canceled";
	const won = stageType === "won";
	const reserveTarget = !won && !closed && cfg.reserve_on === "order_create" ? lines : new Map();
	const shipTarget = won ? lines : new Map();

	// Спершу знімаємо резерви, потім списуємо — інакше резерв "з'їсть" доступний залишок
	await reconcileReservations(conn, idDeal, reserveTarget, idUser, warnings);
	await reconcileShipped(conn, idDeal, shipTarget, idUser);
	return describe(conn, warnings);
}

module.exports = { sync, REF };
