"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const descriptions = require("./descriptions");
const { mutate, httpErr } = require("./product-mutate");
const { validateBundle } = require("../../../validator/catalog/products/bundles");

const P = config.get("configDatabase").prefix;

/** Доступний залишок товару/варіанта по активних складах для продажу */
async function available(db, idProduct, idVariant) {
	const [[r]] = await db.query(
		`SELECT COALESCE(SUM(s.available), 0) AS qty
		   FROM ${P}products_stock s
		   JOIN ${P}products_warehouses w ON w.id = s.id_warehouse AND w.deleted_at IS NULL AND w.status = 1 AND w.is_sellable = 1
		  WHERE s.id_product = ? AND s.id_variant = ?`,
		[idProduct, idVariant || 0]
	);
	return Number(r.qty);
}

/**
 * Скільки комплектів можна продати.
 * components — мінімум floor(залишок / к-сть) по обов'язкових компонентах (без обліку — не обмежує);
 * pack — власний залишок; both — мінімум з двох. null = без обмеження.
 */
async function bundleAvailability(db, bundleRow) {
	const [items] = await db.query(
		`SELECT bi.id_product, bi.id_variant, bi.qty, bi.is_optional, p.track_inventory
		   FROM ${P}products_bundle_items bi JOIN ${P}products p ON p.id = bi.id_product
		  WHERE bi.id_bundle = ?`,
		[bundleRow.id]
	);
	let fromComponents = null;
	for (const it of items) {
		if (Number(it.is_optional) || !Number(it.track_inventory)) continue;
		const n = Math.floor((await available(db, it.id_product, it.id_variant)) / Number(it.qty));
		fromComponents = fromComponents === null ? n : Math.min(fromComponents, n);
	}
	const own = Number(bundleRow.track_inventory) ? await available(db, bundleRow.id, 0) : null;
	const mode = bundleRow.pack_stock_mode;
	if (mode === "pack") return own;
	if (mode === "components") return fromComponents;
	if (own === null) return fromComponents;
	if (fromComponents === null) return own;
	return Math.max(0, Math.min(own, fromComponents));
}

const variantLabelSql = (idLangParam) => `
	(SELECT GROUP_CONCAT(COALESCE(NULLIF(vd.name, ''), vdp.name, av.code) ORDER BY ax.sort_order SEPARATOR ' / ')
	   FROM ${P}products_variant_values vv
	   JOIN ${P}products_attribute_values av ON av.id = vv.id_attribute_value
	   LEFT JOIN ${P}products_variant_axes ax ON ax.id_product = v.id_product AND ax.id_attribute = vv.id_attribute
	   LEFT JOIN ${P}products_attribute_values_description vd  ON vd.id_attribute_value = vv.id_attribute_value AND vd.id_lang = ${idLangParam}
	   LEFT JOIN ${P}products_attribute_values_description vdp ON vdp.id_attribute_value = vv.id_attribute_value AND vdp.id_lang = ?
	  WHERE vv.id_variant = v.id)`;

async function get(idBundle, idLang) {
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const [[product]] = await pool.query(
		`SELECT p.id, p.type, p.version, p.price, p.pack_stock_mode, p.track_inventory, COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', p.id)) AS name
		   FROM ${P}products p
		   LEFT JOIN ${P}products_description d  ON d.id_product = p.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_description dp ON dp.id_product = p.id AND dp.id_lang = ?
		  WHERE p.id = ? AND p.deleted_at IS NULL`,
		[idLang, primary, idBundle]
	);
	if (!product) throw httpErr(404, "Not found");

	const [items] = await pool.query(
		`SELECT bi.id_product, bi.id_variant, bi.qty, bi.is_optional, bi.price_override,
		        p.sku, p.type, p.price, p.track_inventory, p.status, p.deleted_at,
		        COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', p.id)) AS name,
		        v.sku AS variant_sku, v.price_mode, v.price AS variant_price,
		        ${variantLabelSql("?")} AS variant_label
		   FROM ${P}products_bundle_items bi
		   JOIN ${P}products p ON p.id = bi.id_product
		   LEFT JOIN ${P}products_variants v ON v.id = bi.id_variant
		   LEFT JOIN ${P}products_description d  ON d.id_product = p.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_description dp ON dp.id_product = p.id AND dp.id_lang = ?
		  WHERE bi.id_bundle = ?
		  ORDER BY bi.sort_order, bi.id`,
		[idLang, primary, idLang, primary, idBundle]
	);
	for (const it of items) {
		it.available = Number(it.track_inventory) ? await available(pool, it.id_product, it.id_variant) : null;
		const base = Number(it.price);
		it.unit_price = it.id_variant ? (it.price_mode === "fixed" ? Number(it.variant_price) : base + Number(it.variant_price || 0)) : base;
	}
	return { product, items, availability: await bundleAvailability(pool, product) };
}

/** Варіанти компонента для вибору */
async function componentVariants(idProduct, idLang) {
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const [rows] = await pool.query(
		`SELECT v.id, v.sku, v.status, ${variantLabelSql("?")} AS label
		   FROM ${P}products_variants v
		  WHERE v.id_product = ?
		  ORDER BY v.sort_order, v.id`,
		[idLang, primary, idProduct]
	);
	return rows;
}

async function save(idBundle, body, ctx) {
	const v = validateBundle(body);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);

	return mutate(idBundle, ctx, async (conn, product) => {
		if (product.type !== "bundle") throw httpErr(409, "Set product type to bundle first", [{ field: "type", message: "product is not a bundle" }]);

		const ids = [...new Set(v.data.items.map((i) => i.id_product))];
		const comps = new Map();
		if (ids.length) {
			const [rows] = await conn.query(`SELECT id, type, deleted_at FROM ${P}products WHERE id IN (?)`, [ids]);
			rows.forEach((r) => comps.set(r.id, r));
		}
		for (const [i, it] of v.data.items.entries()) {
			const c = comps.get(it.id_product);
			const f = `items.${i}`;
			if (!c || c.deleted_at) throw httpErr(400, "Validation failed", [{ field: f, message: "product not found" }]);
			if (it.id_product === idBundle) throw httpErr(400, "Validation failed", [{ field: f, message: "bundle cannot contain itself" }]);
			if (c.type === "bundle") throw httpErr(400, "Validation failed", [{ field: f, message: "nested bundles are not supported" }]);
			if (c.type === "variable") {
				if (!it.id_variant) throw httpErr(400, "Validation failed", [{ field: f, message: "select a variant" }]);
				const [[vr]] = await conn.query(`SELECT id FROM ${P}products_variants WHERE id = ? AND id_product = ?`, [it.id_variant, it.id_product]);
				if (!vr) throw httpErr(400, "Validation failed", [{ field: f, message: "variant does not belong to product" }]);
			} else if (it.id_variant) {
				throw httpErr(400, "Validation failed", [{ field: f, message: "product has no variants" }]);
			}
		}

		await conn.query(`DELETE FROM ${P}products_bundle_items WHERE id_bundle = ?`, [idBundle]);
		if (v.data.items.length) {
			await conn.query(
				`INSERT INTO ${P}products_bundle_items (id_bundle, id_product, id_variant, qty, is_optional, price_override, sort_order) VALUES ?`,
				[v.data.items.map((it, k) => [idBundle, it.id_product, it.id_variant, it.qty, Number(it.is_optional), it.price_override, k])]
			);
		}
		await conn.query(`UPDATE ${P}products SET pack_stock_mode = ? WHERE id = ?`, [v.data.pack_stock_mode, idBundle]);
		return { saved: v.data.items.length };
	});
}

module.exports = { get, save, componentVariants, bundleAvailability, available };