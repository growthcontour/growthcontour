"use strict";

const Ajv = require("ajv");
const html = require("./html");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });

const IMG = { type: ["string", "null"], pattern: "^[0-9a-f]{2}/[0-9a-f]{64}\\.(webp|avif|jpg|png|gif)$", default: null };

const category = ajv.compile({
	type: "object",
	additionalProperties: false,
	properties: {
		id_parent: { type: ["integer", "null"], minimum: 1, default: null },
		image: IMG,
		icon: IMG,
		banner: IMG,
		status: { type: "boolean", default: true },
		show_in_menu: { type: "boolean", default: true },
		menu_columns: { type: "integer", minimum: 1, maximum: 6, default: 1 },
		is_filterable: { type: "boolean", default: true },
		default_sort: { type: ["string", "null"], enum: [null, "sort_order", "name", "price_asc", "price_desc", "newest", "popular", "rating"], default: null },
		layout_template: { type: ["string", "null"], maxLength: 64, pattern: "^[a-z0-9_\\-]*$", default: null },
		sort_order: { type: "integer", default: 0 },
		robots_index: { type: "boolean", default: true },
		robots_follow: { type: "boolean", default: true },
	},
});

const brand = ajv.compile({
	type: "object",
	additionalProperties: false,
	properties: {
		code: { type: ["string", "null"], maxLength: 64, pattern: "^[A-Za-z0-9_\\-]+$", default: null },
		logo: IMG,
		website: { type: ["string", "null"], maxLength: 255, pattern: "^https?://[^\\s]+$", default: null },
		country: { type: ["string", "null"], pattern: "^[A-Z]{2}$", default: null },
		status: { type: "boolean", default: true },
		sort_order: { type: "integer", default: 0 },
		robots_index: { type: "boolean", default: true },
		robots_follow: { type: "boolean", default: true },
	},
});

// Поля описів і їхні ліміти (збігаються з колонками БД)
const DESCRIPTION_FIELDS = {
	categories: { name: 255, h1: 255, description: 16777215, description_bottom: 16777215, meta_title: 255, meta_description: 512, meta_keywords: 512, slug: 191, og_title: 255, og_description: 512, canonical_url: 512 },
	brands: { name: 255, description: 16777215, meta_title: 255, meta_description: 512, slug: 191, og_title: 255, og_description: 512, canonical_url: 512 },
	products: {
		name: 255,
		h1: 255,
		short_description: 65535,
		description: 16777215,
		meta_title: 255,
		meta_description: 512,
		meta_keywords: 512,
		slug: 191,
		tags: 512,
		search_keywords: 512,
		text_in_stock: 255,
		text_out_of_stock: 255,
		delivery_text_in_stock: 255,
		delivery_text_out_stock: 255,
		unit_label: 32,
		og_title: 255,
		og_description: 512,
		canonical_url: 512,
	},
};

function run(validate, body) {
	const data = JSON.parse(JSON.stringify(body || {}));
	for (const k of Object.keys(data)) if (typeof data[k] === "string" && data[k].trim() === "") data[k] = null;
	if (validate(data)) return { valid: true, data };
	return { valid: false, errors: validate.errors.map((e) => ({ field: (e.instancePath || "").slice(1) || e.params.missingProperty, message: e.message })) };
}

/**
 * Описи: { [id_lang]: { name, ... } }.
 * Перша мова контенту — обов'язкова назва. Інші мови: або є назва, або всі поля порожні.
 * Повертає { valid, data: { [id_lang]: {...} | null } } — null означає «видалити переклад».
 */
function validateDescriptions(entity, input, langIds) {
	const fields = DESCRIPTION_FIELDS[entity];
	const src = input && typeof input === "object" ? input : {};
	const errors = [];
	const data = {};

	langIds.forEach((idLang, index) => {
		const raw = src[idLang] || src[String(idLang)] || {};
		const row = {};
		for (const [f, max] of Object.entries(fields)) {
			let v = raw[f] == null ? "" : String(raw[f]).trim();
			if (v && html.isHtmlField(entity, f)) v = html.clean(v) || "";
			if (v.length > max) errors.push({ field: `descriptions.${idLang}.${f}`, message: `must NOT have more than ${max} characters` });
			row[f] = v === "" ? null : v;
		}
		if (row.canonical_url && !/^(https?:\/\/[^\s]+|\/[^\s]*)$/i.test(row.canonical_url)) {
			errors.push({ field: `descriptions.${idLang}.canonical_url`, message: "absolute URL (https://…) or path (/…)" });
		}
		const hasAny = Object.values(row).some((v) => v !== null);
		if (!row.name && (index === 0 || hasAny)) errors.push({ field: `descriptions.${idLang}.name`, message: "required" });
		data[idLang] = row.name ? row : null;
	});

	return errors.length ? { valid: false, errors } : { valid: true, data };
}

module.exports = {
	validateCategory: (b) => run(category, b),
	validateBrand: (b) => run(brand, b),
	validateDescriptions,
	DESCRIPTION_FIELDS,
};
