"use strict";

// Джерело товарів для обміну CRM → магазин: пакети за курсором id (масштабується на мільйони)
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const languages = require("./languages");

const P = config.get("configDatabase").prefix;

const appBaseUrl = () => String(process.env.APP_URL || "").trim().replace(/\/+$/, "");
const imageUrl = (file) => (file && appBaseUrl() ? `${appBaseUrl()}/assets/images/products/${file}` : null);

const group = (rows, key) => {
	const m = new Map();
	for (const r of rows) {
		if (!m.has(r[key])) m.set(r[key], []);
		m.get(r[key]).push(r);
	}
	return m;
};

function source() {
	let codeById = null;
	let primaryLang = 1;

	async function init() {
		if (codeById) return;
		const langs = await languages.active();
		codeById = new Map(langs.map((l) => [Number(l.id), l.code]));
		primaryLang = langs[0] ? langs[0].id : 1;
	}

	return {
		BATCH: 100,
		start: 0,
		resume: (crmId) => Number(crmId) || 0,
		count: async () => {
			const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products`);
			return Number(r.n);
		},
		batch: async (after, size) => {
			await init();
			const [rows] = await pool.query(`SELECT * FROM ${P}products WHERE id > ? ORDER BY id LIMIT ?`, [after, size]);
			if (!rows.length) return { items: [], next: after };

			const ids = rows.map((r) => r.id);
			const brandIds = [...new Set(rows.map((r) => r.id_brand).filter(Boolean))];
			const [[descs], [media], [cats], [stock], [brands]] = await Promise.all([
				pool.query(
					`SELECT id_product, id_lang, name, h1, description, meta_title, meta_description, meta_keywords, slug FROM ${P}products_description WHERE id_product IN (?)`,
					[ids]
				),
				pool.query(
					`SELECT id_product, file FROM ${P}products_media WHERE id_product IN (?) AND type = 'image' AND file IS NOT NULL ORDER BY id_product, is_cover DESC, sort_order, id`,
					[ids]
				),
				pool.query(`SELECT id_product, id_category FROM ${P}products_to_categories WHERE id_product IN (?)`, [ids]),
				pool.query(
					`SELECT s.id_product, SUM(s.available) AS qty
					   FROM ${P}products_stock s
					   JOIN ${P}products_warehouses w ON w.id = s.id_warehouse AND w.deleted_at IS NULL AND w.status = 1 AND w.is_sellable = 1
					  WHERE s.id_product IN (?) GROUP BY s.id_product`,
					[ids]
				),
				brandIds.length
					? pool.query(`SELECT id_brand, name FROM ${P}products_brands_description WHERE id_brand IN (?) AND id_lang = ?`, [brandIds, primaryLang])
					: Promise.resolve([[]]),
			]);

			const descOf = group(descs, "id_product");
			const mediaOf = group(media, "id_product");
			const catsOf = group(cats, "id_product");
			const qtyOf = new Map(stock.map((s) => [s.id_product, Number(s.qty) || 0]));
			const brandOf = new Map(brands.map((b) => [b.id_brand, b.name]));

			const items = rows.map((r) => {
				const track = Number(r.track_inventory) === 1 && !["service", "digital"].includes(r.type);
				const categories = [...new Set((catsOf.get(r.id) || []).map((c) => Number(c.id_category)))].sort((a, b) => a - b);
				return {
					crm_id: Number(r.id),
					sku: r.sku || "",
					ean: r.ean || "",
					price: Math.round(Number(r.price || 0) * 10000) / 10000,
					track,
					quantity: track ? Math.max(0, Math.floor(qtyOf.get(r.id) || 0)) : 0,
					status: r.status === "active" && !r.deleted_at ? 1 : 0,
					deleted: !!r.deleted_at,
					weight: Number(r.weight) || 0,
					brand: r.id_brand ? brandOf.get(r.id_brand) || "" : "",
					categories,
					main_category: r.id_category_main ? Number(r.id_category_main) : categories[0] || null,
					images: (mediaOf.get(r.id) || []).map((m) => imageUrl(m.file)).filter(Boolean),
					languages: (descOf.get(r.id) || [])
						.filter((d) => codeById.has(Number(d.id_lang)))
						.map((d) => ({
							code: codeById.get(Number(d.id_lang)),
							name: d.name || "",
							h1: d.h1 || "",
							description: d.description || "",
							meta_title: d.meta_title || "",
							meta_description: d.meta_description || "",
							meta_keywords: d.meta_keywords || "",
							slug: d.slug || "",
						})),
				};
			});

			return { items, next: rows[rows.length - 1].id };
		},
	};
}

module.exports = { source };