"use strict";

// Джерело категорій для обміну CRM → магазин. Порядок: батьки раніше за дітей.
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const languages = require("./languages");

const P = config.get("configDatabase").prefix;

const appBaseUrl = () => String(process.env.APP_URL || "").trim().replace(/\/+$/, "");
const imageUrl = (file) => (file && appBaseUrl() ? `${appBaseUrl()}/assets/images/categories/${file}` : null);

async function source() {
	const codeById = new Map((await languages.active()).map((l) => [Number(l.id), l.code]));

	const [cats] = await pool.query(
		`SELECT c.id, c.id_parent, c.image, c.status, c.show_in_menu, c.menu_columns, c.sort_order, c.deleted_at,
		        COALESCE((SELECT MAX(p.depth) FROM ${P}products_categories_path p WHERE p.id_category = c.id), 0) AS depth
		   FROM ${P}products_categories c
		  ORDER BY depth, c.sort_order, c.id`
	);
	const [descs] = await pool.query(
		`SELECT id_category, id_lang, name, h1, description, description_bottom, meta_title, meta_description, meta_keywords, slug
		   FROM ${P}products_categories_description`
	);

	const langsOf = new Map();
	for (const d of descs) {
		const code = codeById.get(Number(d.id_lang));
		if (!code) continue;
		if (!langsOf.has(d.id_category)) langsOf.set(d.id_category, []);
		langsOf.get(d.id_category).push({
			code,
			name: d.name || "",
			h1: d.h1 || "",
			description: d.description || "",
			description_bottom: d.description_bottom || "",
			meta_title: d.meta_title || "",
			meta_description: d.meta_description || "",
			meta_keywords: d.meta_keywords || "",
			slug: d.slug || "",
		});
	}

	const items = cats.map((c) => ({
		crm_id: Number(c.id),
		parent_crm_id: c.id_parent ? Number(c.id_parent) : null,
		status: Number(c.status) === 1 && !c.deleted_at ? 1 : 0,
		deleted: !!c.deleted_at,
		top: Number(c.show_in_menu) === 1 ? 1 : 0,
		column: Number(c.menu_columns) || 1,
		sort_order: Number(c.sort_order) || 0,
		image: imageUrl(c.image),
		languages: langsOf.get(c.id) || [],
	}));

	return {
		BATCH: 200,
		start: 0,
		resume: (crmId) => {
			const i = items.findIndex((x) => x.crm_id === Number(crmId));
			return i >= 0 ? i + 1 : 0;
		},
		count: async () => items.length,
		batch: async (cursor, size) => ({ items: items.slice(cursor, cursor + size), next: cursor + size }),
	};
}

module.exports = { source };