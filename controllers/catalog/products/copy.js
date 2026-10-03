"use strict";

const crypto = require("crypto");
const config = require("../../../config/config");
const settings = require("./settings");
const sku = require("./sku");
const slug = require("./slug");

const P = config.get("configDatabase").prefix;

// Колонки таблиць кешуємо: копіювальник універсальний і не залежить від списку полів
const columnsCache = new Map();
async function columns(conn, table) {
	if (!columnsCache.has(table)) {
		const [rows] = await conn.query(`SHOW COLUMNS FROM ${P}${table}`);
		columnsCache.set(table, {
			all: rows.filter((r) => !/GENERATED/i.test(r.Extra)).map((r) => r.Field),
			autoId: rows.some((r) => r.Field === "id" && /auto_increment/i.test(r.Extra)),
		});
	}
	return columnsCache.get(table);
}

/**
 * Скопіювати рядки дочірньої таблиці.
 * set — фіксовані значення колонок; remap — { колонка: Map(старий id → новий id) }.
 * Повертає Map(старий id → новий id) для таблиць з автоінкрементним id.
 */
async function copyRows(conn, table, where, params, set, remap = {}) {
	const meta = await columns(conn, table);
	const [rows] = await conn.query(`SELECT * FROM ${P}${table} WHERE ${where}`, params);
	const idMap = new Map();
	for (const row of rows) {
		const data = { ...row, ...set };
		for (const [col, map] of Object.entries(remap)) {
			if (data[col] && map.has(data[col])) data[col] = map.get(data[col]);
		}
		const cols = meta.all.filter((c) => !(meta.autoId && c === "id"));
		const [r] = await conn.query(`INSERT INTO ${P}${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => data[c]));
		if (meta.autoId) idMap.set(row.id, r.insertId);
	}
	return idMap;
}

/** Копія товару в межах відкритої транзакції. Повертає id нового товару. */
async function copyProduct(conn, srcId, idUser) {
	const [[src]] = await conn.query(`SELECT * FROM ${P}products WHERE id = ? AND deleted_at IS NULL`, [srcId]);
	if (!src) throw Object.assign(new Error("Not found"), { status: 404 });

	// ── Ядро ────────────────────────────────────────────
	const meta = await columns(conn, "products");
	const override = {
		uuid: crypto.randomUUID(),
		version: 1,
		status: "draft",
		sku: null,
		ean: null,
		upc: null,
		jan: null,
		isbn: null,
		viewed: 0,
		sales_count: 0,
		rating_avg: null,
		reviews_count: 0,
		id_user_add: idUser || null,
		id_user_edit: idUser || null,
		id_source_product: srcId,
		date_add: new Date(),
		date_edit: new Date(),
		deleted_at: null,
		id_user_deleted: null,
	};
	const cols = meta.all.filter((c) => c !== "id");
	const data = { ...src, ...override };
	const [ins] = await conn.query(`INSERT INTO ${P}products (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => data[c]));
	const newId = ins.insertId;

	const skuCfg = await settings.get("sku");
	if (skuCfg.auto) {
		const brand = src.id_brand ? (await conn.query(`SELECT code FROM ${P}products_brands WHERE id = ?`, [src.id_brand]))[0][0] : null;
		const newSku = await sku.generateForProduct({ id: newId, brandCode: brand && brand.code, categoryId: src.id_category_main }, conn);
		await conn.query(`UPDATE ${P}products SET sku = ? WHERE id = ?`, [newSku, newId]);
	}

	// ── Описи: slug — новий унікальний ──────────────────
	const slugCfg = await settings.get("slug");
	const [descs] = await conn.query(`SELECT * FROM ${P}products_description WHERE id_product = ?`, [srcId]);
	const descMeta = await columns(conn, "products_description");
	for (const d of descs) {
		const base = d.slug || slug.slugify(d.name, slugCfg);
		const newSlug = base ? await slug.unique("products", d.id_lang, base, newId, conn) : null;
		const row = { ...d, id_product: newId, slug: newSlug };
		await conn.query(`INSERT INTO ${P}products_description (${descMeta.all.join(", ")}) VALUES (${descMeta.all.map(() => "?").join(", ")})`, descMeta.all.map((c) => row[c]));
	}

	const by = "id_product = ?";
	const set = { id_product: newId };

	// ── Прості зв'язки ──────────────────────────────────
	for (const t of ["products_to_categories", "products_to_stores", "products_to_customer_groups", "products_to_carriers", "products_to_attachments", "products_to_attributes", "products_to_attributes_text", "products_variant_axes", "products_metafields"]) {
		await copyRows(conn, t, by, [srcId], set);
	}

	// ── Медіа (файли спільні: ім'я = хеш вмісту) ────────
	const mediaMap = await copyRows(conn, "products_media", by, [srcId], set);
	for (const [oldId, newMediaId] of mediaMap) {
		await copyRows(conn, "products_media_description", "id_media = ?", [oldId], { id_media: newMediaId });
	}

	// ── Варіанти ────────────────────────────────────────
	const [variants] = await conn.query(`SELECT id FROM ${P}products_variants WHERE id_product = ?`, [srcId]);
	const variantMap = new Map();
	for (const v of variants) {
		const m = await copyRows(conn, "products_variants", "id = ?", [v.id], { id_product: newId, uuid: crypto.randomUUID(), sku: null, ean: null, upc: null, jan: null, isbn: null });
		const newVariantId = m.get(v.id);
		variantMap.set(v.id, newVariantId);
		await copyRows(conn, "products_variant_values", "id_variant = ?", [v.id], { id_variant: newVariantId });
		await copyRows(conn, "products_variant_media", "id_variant = ?", [v.id], { id_variant: newVariantId }, { id_media: mediaMap });
	}
	const byVariant = { id_variant: variantMap };

	// ── Таблиці з id_variant ────────────────────────────
	for (const t of ["products_prices", "products_rewards", "products_to_suppliers", "products_downloads", "products_subscription_plans"]) {
		const map = await copyRows(conn, t, by, [srcId], set, byVariant);
		if (t === "products_downloads") {
			for (const [oldId, newDl] of map) await copyRows(conn, "products_downloads_description", "id_download = ?", [oldId], { id_download: newDl });
		}
	}

	// ── Опції ───────────────────────────────────────────
	const optMap = await copyRows(conn, "products_to_options", by, [srcId], set);
	for (const [oldPo, newPo] of optMap) {
		await copyRows(conn, "products_to_option_values", "id_product_option = ?", [oldPo], { id_product_option: newPo });
	}

	// ── Персоналізація ──────────────────────────────────
	const cfMap = await copyRows(conn, "products_customization_fields", by, [srcId], set);
	for (const [oldCf, newCf] of cfMap) {
		await copyRows(conn, "products_customization_fields_description", "id_customization_field = ?", [oldCf], { id_customization_field: newCf });
	}

	// ── Комплект і пов'язані ────────────────────────────
	await copyRows(conn, "products_bundle_items", "id_bundle = ?", [srcId], { id_bundle: newId });
	await copyRows(conn, "products_related", by, [srcId], set);

	// Не копіюються навмисно: залишки, партії, серійники, рух, резерви, відгуки, зовнішні прив'язки, lock
	return newId;
}

module.exports = { copyProduct };