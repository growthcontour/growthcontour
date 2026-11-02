"use strict";

// Джерело категорій для обміну CRM → магазин. Порядок: батьки раніше за дітей.
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const languages = require("./languages");
const assortment = require("../../settings/integrations/assortment");

const P = config.get("configDatabase").prefix;

const appBaseUrl = () => String(process.env.APP_URL || "").trim().replace(/\/+$/, "");
const imageUrl = (file) => (file && appBaseUrl() ? `${appBaseUrl()}/assets/images/categories/${file}` : null);

async function source(idIntegration) {
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

	// Лише категорії, що йдуть на цей сайт (увімкнені, з товарами сайту, та їхні предки)
	const allowed = await (await assortment.resolver(idIntegration)).categories();

	let items = cats.filter((c) => allowed.has(Number(c.id))).map((c) => ({
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

	// Категорії сайту: «Дерево сайту» — система категорій не веде; «Змішаний» — лише незіставлені
	// (з успадкуванням), кореневі з них — під обраною категорією сайту (parent_site_id)
	const cm = await assortment.categoryMap(idIntegration);
	if (cm.mode === "site") items = [];
	else {
		// Назва й місце категорії саме на цьому сайті (вікно «Категорії сайту»)
		items = items.map((x) => {
			const o = cm.ov.get(x.crm_id);
			if (!o) return x;
			const y = { ...x };
			if (o.names) y.languages = x.languages.map((l) => (o.names[l.code] ? { ...l, name: o.names[l.code] } : l));
			if (o.parent !== undefined) y.parent_crm_id = o.parent || null;
			return y;
		});
		if (cm.mode === "mixed") {
			await cm.loadPaths(items.map((x) => x.crm_id).concat(items.map((x) => x.parent_crm_id).filter(Boolean)));
			items = items.filter((x) => !cm.nearest(x.crm_id));
		}
		// Батько, якого на сайт не передаємо: у змішаному — його категорія сайту або обрана коренева; інакше — корінь
		const sent = new Set(items.map((x) => x.crm_id));
		items = items.map((x) => {
			if (x.parent_crm_id && sent.has(x.parent_crm_id)) return x;
			const n = cm.mode === "mixed" && x.parent_crm_id ? cm.nearest(x.parent_crm_id) : null;
			const parentSite = n ? n.site[0] : cm.mode === "mixed" ? cm.root : null;
			return { ...x, parent_crm_id: null, ...(parentSite ? { parent_site_id: parentSite } : {}) };
		});
		// Батьки раніше за дітей (після перенесень порядок міг змінитись)
		const byId = new Map(items.map((x) => [x.crm_id, x]));
		const done = new Set();
		const ordered = [];
		const visit = (x, g = 0) => {
			if (done.has(x.crm_id) || g > 100) return;
			const parent = x.parent_crm_id && byId.get(x.parent_crm_id);
			if (parent) visit(parent, g + 1);
			if (done.has(x.crm_id)) return;
			done.add(x.crm_id);
			ordered.push(x);
		};
		items.forEach((x) => visit(x));
		items = ordered;
	}

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