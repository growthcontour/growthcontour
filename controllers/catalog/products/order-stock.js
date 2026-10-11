"use strict";

/**
 * Склад ↔ замовлення.
 * Позиції замовлення зіставляються з товарами каталогу (зв'язок магазину → SKU → вручну),
 * а резерв/списання декларативно приводяться до стану замовлення:
 *   скасоване або видалене → нічого; відправлене → списано; інакше → резерв (за налаштуванням reserve_on).
 * Джерело правди про замовлення — магазин, тому нестача товару НЕ блокує прийом:
 * стан фіксується в orders.stock_state, а cron повторює спробу.
 */
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("./settings");
const stock = require("./stock");
const reservations = require("./reservations");

const P = config.get("configDatabase").prefix;
const REF = "order";
const NO_STOCK_TYPES = ["service", "digital", "gift_card"];
// Рядки замовлення, що не є товаром
const NON_PRODUCT_ITEM_TYPES = ["shipping", "fee", "tip", "discount", "gift_card", "wrapping"];

const key = (p, v, w) => `${p}:${v}:${w}`;
const parseKey = (k) => k.split(":").map(Number);
const milli = (n) => Math.round(Number(n) * 1000);
const itemKey = (it) => `${it.external_product_id || ""}|${it.sku || ""}|${it.name || ""}`;

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

async function findBySku(conn, sku) {
	const [[v]] = await conn.query(
		`SELECT v.id_product, v.id AS id_variant FROM ${P}products_variants v JOIN ${P}products p ON p.id = v.id_product AND p.deleted_at IS NULL WHERE v.sku = ? LIMIT 1`,
		[sku]
	);
	if (v) return v;
	const [[p]] = await conn.query(`SELECT id AS id_product, 0 AS id_variant FROM ${P}products WHERE sku = ? AND deleted_at IS NULL LIMIT 1`, [sku]);
	return p || null;
}

/** Ручні зіставлення до заміни позицій вебхуком (DELETE + INSERT) */
async function snapshotMapping(conn, idOrder) {
	const [rows] = await conn.query(
		`SELECT external_product_id, sku, name, id_product, id_variant FROM ${P}orders_items WHERE id_order = ? AND map_source = 'manual' AND id_product IS NOT NULL`,
		[idOrder]
	);
	return new Map(rows.map((r) => [itemKey(r), { id_product: r.id_product, id_variant: r.id_variant }]));
}

/** Зіставити незіставлені позиції: ручне (зі знімка) → зв'язок інтеграції → SKU */
async function mapItems(conn, idOrder, manual) {
	const [[order]] = await conn.query(`SELECT id_integration FROM ${P}orders WHERE id = ?`, [idOrder]);
	const [items] = await conn.query(
		`SELECT id, external_product_id, sku, name, meta FROM ${P}orders_items
		  WHERE id_order = ? AND id_product IS NULL AND COALESCE(type, 'product') NOT IN (?)`,
		[idOrder, NON_PRODUCT_ITEM_TYPES]
	);
	for (const it of items) {
		let hit = null;
		let source = null;
		const m = manual && manual.get(itemKey(it));
		if (m) {
			hit = m;
			source = "manual";
		}
		if (!hit && order && order.id_integration && it.external_product_id) {
			let meta = {};
			try {
				meta = typeof it.meta === "string" ? JSON.parse(it.meta) : it.meta || {};
			} catch {}
			const [[link]] = await conn.query(
				`SELECT l.id_product, l.id_variant FROM ${P}products_external_links l JOIN ${P}products p ON p.id = l.id_product AND p.deleted_at IS NULL
				  WHERE l.id_integration = ? AND l.external_id = ?
				  ORDER BY (l.external_variant_id = ?) DESC LIMIT 1`,
				[order.id_integration, String(it.external_product_id), String(meta.external_variant_id || "")]
			);
			if (link) ((hit = link), (source = "link"));
		}
		if (!hit && it.sku) {
			const bySku = await findBySku(conn, String(it.sku).trim());
			if (bySku) ((hit = bySku), (source = "sku"));
		}
		if (hit) await conn.query(`UPDATE ${P}orders_items SET id_product = ?, id_variant = ?, map_source = ? WHERE id = ?`, [hit.id_product, hit.id_variant || 0, source, it.id]);
	}
}

/** Бажані рядки складу: Map key → { qty (×1000), cost } */
async function desiredLines(conn, idOrder, idWarehouse, warnings) {
	const [items] = await conn.query(
		`SELECT i.id, i.id_product, i.id_variant, i.quantity, p.type, p.track_inventory, p.pack_stock_mode, p.cost_price
		   FROM ${P}orders_items i JOIN ${P}products p ON p.id = i.id_product
		  WHERE i.id_order = ? AND i.id_product IS NOT NULL AND COALESCE(i.type, 'product') NOT IN (?)`,
		[idOrder, NON_PRODUCT_ITEM_TYPES]
	);
	const out = new Map();
	const add = (idProduct, idVariant, qty, cost) => {
		const k = key(idProduct, idVariant || 0, idWarehouse);
		const cur = out.get(k);
		out.set(k, { qty: (cur ? cur.qty : 0) + milli(qty), cost: cost ?? null });
	};
	for (const it of items) {
		if (NO_STOCK_TYPES.includes(it.type)) continue;
		if (it.type === "bundle" && it.pack_stock_mode === "components") {
			const [components] = await conn.query(
				`SELECT bi.id_product, bi.id_variant, bi.qty, p.track_inventory, p.cost_price
				   FROM ${P}products_bundle_items bi JOIN ${P}products p ON p.id = bi.id_product
				  WHERE bi.id_bundle = ? AND bi.is_optional = 0`,
				[it.id_product]
			);
			for (const c of components) if (Number(c.track_inventory)) add(c.id_product, c.id_variant, Number(c.qty) * Number(it.quantity), c.cost_price);
			continue;
		}
		if (!Number(it.track_inventory)) continue;
		if (it.type === "variable" && !Number(it.id_variant)) {
			warnings.push({ id_item: it.id, code: "variant_required" });
			continue;
		}
		add(it.id_product, it.id_variant, it.quantity, it.cost_price);
	}
	return out;
}

async function reconcileReservations(conn, idOrder, target, idUser, warnings) {
	const [rows] = await conn.query(`SELECT * FROM ${P}products_stock_reservations WHERE ref_type = ? AND ref_id = ? FOR UPDATE`, [REF, idOrder]);
	const current = new Map(rows.map((r) => [key(r.id_product, r.id_variant, r.id_warehouse), r]));
	for (const k of [...new Set([...current.keys(), ...target.keys()])].sort()) {
		const [idProduct, idVariant, idWarehouse] = parseKey(k);
		const want = target.get(k);
		const have = current.get(k);
		if (!want || want.qty <= 0) {
			if (have) {
				await stock.adjust(conn, { idProduct, idVariant, idWarehouse, field: "reserved", delta: -Number(have.qty), type: "unreserve", refType: REF, refId: idOrder, idUser });
				await conn.query(`DELETE FROM ${P}products_stock_reservations WHERE id = ?`, [have.id]);
			}
			continue;
		}
		if (have && milli(have.qty) === want.qty) continue;
		try {
			await conn.query("SAVEPOINT sp_order_reserve");
			await reservations.reserve(conn, { idProduct, idVariant, idWarehouse, qty: want.qty / 1000, refType: REF, refId: idOrder, idUser, ttlMinutes: 0 });
			await conn.query("RELEASE SAVEPOINT sp_order_reserve");
		} catch (e) {
			if (e.status !== 409) throw e;
			await conn.query("ROLLBACK TO SAVEPOINT sp_order_reserve");
			warnings.push({ id_product: idProduct, id_variant: idVariant, id_warehouse: idWarehouse, code: "insufficient_to_reserve" });
		}
	}
}

/** Списання: різниця з уже списаним — рух sale (−) або return (+). Нестача — попередження, не помилка */
async function reconcileShipped(conn, idOrder, target, idUser, warnings) {
	const [rows] = await conn.query(
		`SELECT id_product, id_variant, id_warehouse, -SUM(qty) AS shipped
		   FROM ${P}products_stock_movements
		  WHERE ref_type = ? AND ref_id = ? AND field = 'on_hand' AND type IN ('sale', 'return')
		  GROUP BY id_product, id_variant, id_warehouse`,
		[REF, idOrder]
	);
	const current = new Map(rows.map((r) => [key(r.id_product, r.id_variant, r.id_warehouse), milli(r.shipped)]));
	for (const k of [...new Set([...current.keys(), ...target.keys()])].sort()) {
		const [idProduct, idVariant, idWarehouse] = parseKey(k);
		const diff = (target.has(k) ? target.get(k).qty : 0) - (current.get(k) || 0);
		if (diff === 0) continue;
		try {
			await conn.query("SAVEPOINT sp_order_ship");
			await stock.adjust(conn, {
				idProduct,
				idVariant,
				idWarehouse,
				field: "on_hand",
				delta: -diff / 1000,
				type: diff > 0 ? "sale" : "return",
				costPrice: target.has(k) ? target.get(k).cost : null,
				refType: REF,
				refId: idOrder,
				idUser,
			});
			await conn.query("RELEASE SAVEPOINT sp_order_ship");
		} catch (e) {
			if (e.status !== 409) throw e;
			await conn.query("ROLLBACK TO SAVEPOINT sp_order_ship");
			warnings.push({ id_product: idProduct, id_variant: idVariant, id_warehouse: idWarehouse, code: "insufficient_to_ship", need: diff / 1000 });
		}
	}
}

/**
 * Привести склад до стану замовлення (у транзакції викликача; замовлення бажано заблоковане).
 * Повертає { state, warnings }.
 */
async function sync(conn, idOrder, idUser) {
	const [[o]] = await conn.query(`SELECT id, id_warehouse, is_paid, is_shipped, is_canceled, deleted_at FROM ${P}orders WHERE id = ?`, [idOrder]);
	if (!o) throw httpErr(404, "Order not found");
	const cfg = await settings.get("stock");
	const warnings = [];
	const idWarehouse = o.id_warehouse || cfg.id_default_warehouse;

	const [[{ unmapped }]] = await conn.query(
		`SELECT COUNT(*) AS unmapped FROM ${P}orders_items WHERE id_order = ? AND id_product IS NULL AND COALESCE(type, 'product') NOT IN (?)`,
		[idOrder, NON_PRODUCT_ITEM_TYPES]
	);
	if (Number(unmapped)) warnings.push({ code: "unmapped_items", count: Number(unmapped) });

	const lines = idWarehouse ? await desiredLines(conn, idOrder, idWarehouse, warnings) : new Map();
	if (!idWarehouse) warnings.push({ code: "no_warehouse" });

	const closed = !!o.deleted_at || !!Number(o.is_canceled);
	const shipped = !closed && !!Number(o.is_shipped);
	const reserve = !closed && !shipped && (cfg.reserve_on === "order_create" || (cfg.reserve_on === "order_paid" && Number(o.is_paid)));

	// Спершу знімаємо резерви, потім списуємо — інакше резерв «з'їсть» доступний залишок
	await reconcileReservations(conn, idOrder, reserve ? lines : new Map(), idUser, warnings);
	await reconcileShipped(conn, idOrder, shipped ? lines : new Map(), idUser, warnings);

	const hard = warnings.some((w) => ["insufficient_to_ship", "no_warehouse"].includes(w.code));
	const state = closed && !warnings.length ? "none" : hard ? "error" : warnings.length ? "warning" : lines.size ? "ok" : "none";
	await conn.query(`UPDATE ${P}orders SET stock_state = ?, stock_message = ?, stock_synced_at = NOW() WHERE id = ?`, [
		state,
		warnings.length ? JSON.stringify(warnings).slice(0, 4000) : null,
		idOrder,
	]);
	return { state, warnings };
}

/**
 * Хук після запису позицій (вебхук / прийом). Ніколи не кидає: збій складу не має
 * зривати прийом замовлення — помилка фіксується в замовленні й подіях.
 */
async function afterItems(conn, idOrder, manual) {
	await conn.query("SAVEPOINT sp_order_stock");
	try {
		await mapItems(conn, idOrder, manual);
		const r = await sync(conn, idOrder, null);
		await conn.query("RELEASE SAVEPOINT sp_order_stock");
		return r;
	} catch (e) {
		await conn.query("ROLLBACK TO SAVEPOINT sp_order_stock");
		console.error("[order-stock]", idOrder, e.message);
		await conn
			.query(`UPDATE ${P}orders SET stock_state = 'error', stock_message = ?, stock_synced_at = NOW() WHERE id = ?`, [JSON.stringify([{ code: "exception", message: String(e.message).slice(0, 500) }]), idOrder])
			.catch(() => {});
		return { state: "error", warnings: [] };
	}
}

async function tx(fn) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const r = await fn(conn);
		await conn.commit();
		return r;
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
}

async function lockOrder(conn, idOrder) {
	const [[o]] = await conn.query(`SELECT id, id_integration FROM ${P}orders WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [idOrder]);
	if (!o) throw httpErr(404, "Order not found");
	return o;
}

/** Дані для панелі «Склад» у картці замовлення */
async function info(idOrder, idLang) {
	const [[o]] = await pool.query(`SELECT id, id_integration, id_warehouse, stock_state, stock_message, stock_synced_at FROM ${P}orders WHERE id = ?`, [idOrder]);
	if (!o) throw httpErr(404, "Order not found");
	const [items] = await pool.query(
		`SELECT i.id, i.name, i.sku, i.external_product_id, i.quantity, i.type, i.id_product, i.id_variant, i.map_source,
		        p.sku AS product_sku, p.type AS product_type, v.sku AS variant_sku,
		        COALESCE(NULLIF(d.name, ''), (SELECT d2.name FROM ${P}products_description d2 WHERE d2.id_product = p.id ORDER BY d2.id_lang LIMIT 1)) AS product_name
		   FROM ${P}orders_items i
		   LEFT JOIN ${P}products p ON p.id = i.id_product
		   LEFT JOIN ${P}products_variants v ON v.id = i.id_variant AND i.id_variant > 0
		   LEFT JOIN ${P}products_description d ON d.id_product = p.id AND d.id_lang = ?
		  WHERE i.id_order = ? AND COALESCE(i.type, 'product') NOT IN (?)
		  ORDER BY i.id`,
		[idLang, idOrder, NON_PRODUCT_ITEM_TYPES]
	);
	const [reserved] = await pool.query(
		`SELECT id_product, id_variant, id_warehouse, qty FROM ${P}products_stock_reservations WHERE ref_type = ? AND ref_id = ?`,
		[REF, idOrder]
	);
	const [shipped] = await pool.query(
		`SELECT id_product, id_variant, id_warehouse, -SUM(qty) AS qty FROM ${P}products_stock_movements
		  WHERE ref_type = ? AND ref_id = ? AND field = 'on_hand' AND type IN ('sale', 'return')
		  GROUP BY id_product, id_variant, id_warehouse HAVING qty <> 0`,
		[REF, idOrder]
	);
	const [warehouses] = await pool.query(`SELECT id, code, name FROM ${P}products_warehouses WHERE deleted_at IS NULL AND status = 1 ORDER BY priority, sort_order, id`);
	const cfg = await settings.get("stock");
	let messages = [];
	try {
		messages = o.stock_message ? JSON.parse(o.stock_message) : [];
	} catch {}
	return { order: { ...o, stock_message: undefined }, messages, items, reserved, shipped, warehouses, id_default_warehouse: cfg.id_default_warehouse };
}

/** Ручне зіставлення позиції. remember — створити зв'язок інтеграції, щоб наступні замовлення зіставлялись самі */
async function mapItem(idOrder, idItem, body, idUser) {
	const idProduct = parseInt(body.id_product, 10) || null;
	const idVariant = parseInt(body.id_variant, 10) || 0;
	return tx(async (conn) => {
		const o = await lockOrder(conn, idOrder);
		const [[it]] = await conn.query(`SELECT id, external_product_id, sku, meta FROM ${P}orders_items WHERE id = ? AND id_order = ? FOR UPDATE`, [idItem, idOrder]);
		if (!it) throw httpErr(404, "Item not found");
		if (idProduct) {
			const [[p]] = await conn.query(`SELECT id, type FROM ${P}products WHERE id = ? AND deleted_at IS NULL`, [idProduct]);
			if (!p) throw httpErr(400, "Validation failed", [{ field: "id_product", message: "product not found" }]);
			if (idVariant) {
				const [[v]] = await conn.query(`SELECT id FROM ${P}products_variants WHERE id = ? AND id_product = ?`, [idVariant, idProduct]);
				if (!v) throw httpErr(400, "Validation failed", [{ field: "id_variant", message: "variant not found" }]);
			} else if (p.type === "variable") {
				throw httpErr(400, "Validation failed", [{ field: "id_variant", message: "variant required" }]);
			}
		}
		await conn.query(`UPDATE ${P}orders_items SET id_product = ?, id_variant = ?, map_source = ? WHERE id = ?`, [idProduct, idProduct ? idVariant : 0, idProduct ? "manual" : null, idItem]);

		if (idProduct && body.remember && o.id_integration && it.external_product_id) {
			let meta = {};
			try {
				meta = typeof it.meta === "string" ? JSON.parse(it.meta) : it.meta || {};
			} catch {}
			await conn.query(
				`INSERT INTO ${P}products_external_links (id_product, id_variant, id_integration, external_id, external_variant_id, external_sku)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON DUPLICATE KEY UPDATE id_product = VALUES(id_product), id_variant = VALUES(id_variant), external_sku = VALUES(external_sku)`,
				[idProduct, idVariant, o.id_integration, String(it.external_product_id).slice(0, 64), String(meta.external_variant_id || "").slice(0, 64), it.sku ? String(it.sku).slice(0, 64) : null]
			);
		}
		await conn.query(
			`INSERT INTO ${P}orders_events (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, 'item_mapped', ?, 'manual', NOW())`,
			[idOrder, idUser, JSON.stringify({ id_item: idItem, id_product: idProduct, id_variant: idVariant, remember: !!body.remember })]
		);
		return sync(conn, idOrder, idUser);
	});
}

async function setWarehouse(idOrder, idWarehouse, idUser) {
	return tx(async (conn) => {
		await lockOrder(conn, idOrder);
		if (idWarehouse) {
			const [[w]] = await conn.query(`SELECT id FROM ${P}products_warehouses WHERE id = ? AND deleted_at IS NULL AND status = 1`, [idWarehouse]);
			if (!w) throw httpErr(400, "Validation failed", [{ field: "id_warehouse", message: "warehouse not found" }]);
		}
		await conn.query(`UPDATE ${P}orders SET id_warehouse = ? WHERE id = ?`, [idWarehouse || null, idOrder]);
		await conn.query(
			`INSERT INTO ${P}orders_events (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, 'warehouse_change', ?, 'manual', NOW())`,
			[idOrder, idUser, JSON.stringify({ id_warehouse: idWarehouse || null })]
		);
		return sync(conn, idOrder, idUser);
	});
}

/** Ручний «перерахувати склад» */
async function resync(idOrder, idUser) {
	return tx(async (conn) => {
		await lockOrder(conn, idOrder);
		await mapItems(conn, idOrder, null);
		return sync(conn, idOrder, idUser);
	});
}

/** Видалене замовлення: зняти резерви (списане не повертаємо — товар фізично вже відправлено) */
async function releaseOnDelete(conn, idOrder, idUser) {
	await reconcileReservations(conn, idOrder, new Map(), idUser, []);
	await conn.query(`UPDATE ${P}orders SET stock_state = 'none', stock_message = NULL WHERE id = ?`, [idOrder]);
}

let running = false;

/** Cron: повторити замовлення з помилками/попередженнями (нестача могла зникнути після приходу) */
async function retryPending(limit = 200) {
	if (running) return { skipped: true };
	running = true;
	let done = 0;
	try {
		const [rows] = await pool.query(
			`SELECT id FROM ${P}orders WHERE deleted_at IS NULL AND stock_state IN ('error', 'warning')
			    AND date_add > NOW() - INTERVAL 90 DAY ORDER BY stock_synced_at IS NULL DESC, stock_synced_at LIMIT ?`,
			[limit]
		);
		for (const { id } of rows) {
			try {
				await resync(id, null);
				done++;
			} catch (e) {
				console.error("[order-stock retry]", id, e.message);
			}
		}
		return { done };
	} finally {
		running = false;
	}
}

module.exports = { REF, snapshotMapping, mapItems, sync, afterItems, info, mapItem, setWarehouse, resync, releaseOnDelete, retryPending };