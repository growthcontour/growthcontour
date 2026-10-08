"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("./settings");
const descriptions = require("./descriptions");
const bundles = require("./bundles");

const P = config.get("configDatabase").prefix;

function httpErr(status, message) {
	return Object.assign(new Error(message), { status });
}

const likeOf = (s) => "%" + s.replace(/[\\%_]/g, (m) => "\\" + m) + "%";

const variantLabelSql = `
	(SELECT GROUP_CONCAT(COALESCE(NULLIF(vd.name, ''), vdp.name, av.code) ORDER BY ax.sort_order SEPARATOR ' / ')
	   FROM ${P}products_variant_values vv
	   JOIN ${P}products_attribute_values av ON av.id = vv.id_attribute_value
	   LEFT JOIN ${P}products_variant_axes ax ON ax.id_product = v.id_product AND ax.id_attribute = vv.id_attribute
	   LEFT JOIN ${P}products_attribute_values_description vd  ON vd.id_attribute_value = vv.id_attribute_value AND vd.id_lang = ?
	   LEFT JOIN ${P}products_attribute_values_description vdp ON vdp.id_attribute_value = vv.id_attribute_value AND vdp.id_lang = ?
	  WHERE vv.id_variant = v.id)`;

async function primaryLang(idLang) {
	const langs = await descriptions.contentLanguages();
	return langs[0] ? langs[0].id : idLang;
}

/** Пошук для вибору товару: назва, SKU/EAN товару або варіанта */
async function search(text, idLang, perms) {
	const s = String(text || "").trim().slice(0, 100);
	if (s.length < 2) return [];
	const primary = await primaryLang(idLang);
	const like = likeOf(s);

	const [rows] = await pool.query(
		`SELECT p.id, p.type, p.sku, p.price, ${perms.cost ? "p.cost_price," : ""} p.track_inventory, p.status,
		        COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', p.id)) AS name,
		        (SELECT COALESCE(SUM(st.available), 0)
		           FROM ${P}products_stock st
		           JOIN ${P}products_warehouses w ON w.id = st.id_warehouse AND w.deleted_at IS NULL AND w.status = 1 AND w.is_sellable = 1
		          WHERE st.id_product = p.id) AS available
		   FROM ${P}products p
		   LEFT JOIN ${P}products_description d  ON d.id_product = p.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_description dp ON dp.id_product = p.id AND dp.id_lang = ?
		  WHERE p.deleted_at IS NULL AND p.status <> 'archived'
		    AND (d.name LIKE ? OR dp.name LIKE ? OR p.sku LIKE ? OR p.ean = ?
		         OR EXISTS (SELECT 1 FROM ${P}products_variants v WHERE v.id_product = p.id AND (v.sku LIKE ? OR v.ean = ?)))
		  ORDER BY (p.sku = ?) DESC, name
		  LIMIT 20`,
		[idLang, primary, like, like, like, s, like, s, s]
	);
	return rows.map((r) => ({ ...r, price: Number(r.price), available: r.type === "bundle" ? null : Number(r.available) }));
}

/** Дані для позиції: варіанти з цінами, склади, залишки по складах */
async function get(id, idLang, perms) {
	const primary = await primaryLang(idLang);
	const [[p]] = await pool.query(
		`SELECT p.id, p.type, p.status, p.sku, p.price, p.cost_price, p.track_inventory, p.pack_stock_mode,
		        COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', p.id)) AS name
		   FROM ${P}products p
		   LEFT JOIN ${P}products_description d  ON d.id_product = p.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_description dp ON dp.id_product = p.id AND dp.id_lang = ?
		  WHERE p.id = ? AND p.deleted_at IS NULL`,
		[idLang, primary, id]
	);
	if (!p) throw httpErr(404, "Product not found");

	let variants = [];
	if (p.type === "variable") {
		const [rows] = await pool.query(
			`SELECT v.id, v.sku, v.price_mode, v.price, v.cost_price, ${variantLabelSql} AS label
			   FROM ${P}products_variants v
			  WHERE v.id_product = ? AND v.status = 1
			  ORDER BY v.sort_order, v.id`,
			[idLang, primary, id]
		);
		variants = rows.map((v) => ({
			id: v.id,
			sku: v.sku || p.sku,
			label: v.label || "#" + v.id,
			price: v.price_mode === "fixed" ? Number(v.price) : Number(p.price) + Number(v.price),
			cost_price: perms.cost ? (v.cost_price ?? p.cost_price) : undefined,
		}));
	}

	const [[warehouses], [stock]] = await Promise.all([
		pool.query(`SELECT id, code, name FROM ${P}products_warehouses WHERE deleted_at IS NULL AND status = 1 ORDER BY priority, sort_order, id`),
		pool.query(`SELECT id_variant, id_warehouse, on_hand, reserved, available FROM ${P}products_stock WHERE id_product = ?`, [id]),
	]);
	const cfg = await settings.get("stock");

	return {
		id: p.id,
		type: p.type,
		status: p.status,
		sku: p.sku,
		name: p.name,
		price: Number(p.price),
		cost_price: perms.cost ? p.cost_price : undefined,
		track_inventory: Number(p.track_inventory),
		bundle_available: p.type === "bundle" ? await bundles.bundleAvailability(pool, p) : undefined,
		variants,
		warehouses,
		stock,
		id_default_warehouse: cfg.id_default_warehouse,
	};
}

module.exports = { search, get };