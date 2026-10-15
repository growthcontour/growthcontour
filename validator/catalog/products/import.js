"use strict";

const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const ajv = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: true });
addFormats(ajv);

/** Колонки файлу: key → тип. Порядок = порядок колонок експорту. */
const COLUMNS = {
	id: "int",
	uuid: "string",
	sku: "string",
	type: "enum:simple,bundle,digital,service,gift_card",
	status: "enum:draft,active,archived",
	visibility: "enum:all,catalog,search,none",
	model: "string",
	mpn: "string",
	ean: "string",
	upc: "string",
	isbn: "string",
	brand_code: "string",
	category_ids: "idlist",
	vendor: "string",
	item_condition: "enum:new,used,refurbished",
	price: "money",
	compare_at_price: "money",
	cost_price: "money",
	wholesale_price: "money",
	points_price: "int",
	track_inventory: "bool",
	subtract_stock: "bool",
	min_qty: "qty",
	qty_step: "qty",
	out_of_stock_action: "enum:default,deny,backorder,preorder",
	qty: "qty",
	requires_shipping: "bool",
	weight: "dim",
	weight_unit: "string",
	length: "dim",
	width: "dim",
	height: "dim",
	length_unit: "string",
	hs_code: "string",
	country_of_origin: "string",
	sort_order: "int",
	robots_index: "bool",
	robots_follow: "bool",
};

/** Колонки описів, повторюються для кожної мови контенту: name_uk, name_en… */
const LANG_COLUMNS = ["name", "h1", "slug", "short_description", "description", "meta_title", "meta_description", "meta_keywords", "og_title", "og_description", "canonical_url", "tags"];

const COST_COLUMNS = ["cost_price", "wholesale_price"];

const rowSchema = {
	type: "object",
	properties: {
		id: { type: "integer", minimum: 1 },
		uuid: { type: "string", format: "uuid" },
		sku: { type: "string", maxLength: 64, pattern: "^[A-Za-z0-9_\\-.]+$" },
		type: { enum: ["simple", "bundle", "digital", "service", "gift_card"] },
		status: { enum: ["draft", "active", "archived"] },
		visibility: { enum: ["all", "catalog", "search", "none"] },
		model: { type: "string", maxLength: 128 },
		mpn: { type: "string", maxLength: 64 },
		ean: { type: "string", pattern: "^(\\d{8}|\\d{12}|\\d{13}|\\d{14})$" },
		upc: { type: "string", pattern: "^\\d{12}$" },
		isbn: { type: "string", maxLength: 17 },
		brand_code: { type: "string", maxLength: 64 },
		category_ids: { type: "array", maxItems: 100, items: { type: "integer", minimum: 1 } },
		vendor: { type: "string", maxLength: 128 },
		item_condition: { enum: ["new", "used", "refurbished"] },
		price: { type: "number", minimum: 0, maximum: 99999999999 },
		compare_at_price: { type: ["number", "null"], minimum: 0, maximum: 99999999999 },
		cost_price: { type: ["number", "null"], minimum: 0, maximum: 99999999999 },
		wholesale_price: { type: ["number", "null"], minimum: 0, maximum: 99999999999 },
		points_price: { type: ["integer", "null"], minimum: 0 },
		track_inventory: { type: "integer", enum: [0, 1] },
		subtract_stock: { type: "integer", enum: [0, 1] },
		min_qty: { type: "number", exclusiveMinimum: 0, maximum: 999999999999 },
		qty_step: { type: "number", exclusiveMinimum: 0, maximum: 999999999999 },
		out_of_stock_action: { enum: ["default", "deny", "backorder", "preorder"] },
		qty: { type: "number", minimum: -999999999999, maximum: 999999999999 },
		requires_shipping: { type: "integer", enum: [0, 1] },
		weight: { type: ["number", "null"], minimum: 0, maximum: 99999999 },
		weight_unit: { enum: ["kg", "g", "lb", "oz", null] },
		length: { type: ["number", "null"], minimum: 0, maximum: 99999999 },
		width: { type: ["number", "null"], minimum: 0, maximum: 99999999 },
		height: { type: ["number", "null"], minimum: 0, maximum: 99999999 },
		length_unit: { enum: ["cm", "mm", "m", "in", null] },
		hs_code: { type: "string", maxLength: 16 },
		country_of_origin: { type: ["string", "null"], pattern: "^[A-Z]{2}$" },
		sort_order: { type: "integer", minimum: -2147483648, maximum: 2147483647 },
		robots_index: { type: "integer", enum: [0, 1] },
		robots_follow: { type: "integer", enum: [0, 1] },
		descriptions: {
			type: "object",
			additionalProperties: {
				type: "object",
				properties: {
					name: { type: "string", minLength: 1, maxLength: 255 },
					slug: { type: ["string", "null"], maxLength: 191 },
					short_description: { type: ["string", "null"], maxLength: 65535 },
					description: { type: ["string", "null"], maxLength: 16777215 },
					meta_title: { type: ["string", "null"], maxLength: 255 },
					meta_description: { type: ["string", "null"], maxLength: 512 },
					tags: { type: ["string", "null"], maxLength: 512 },
					h1: { type: ["string", "null"], maxLength: 255 },
					meta_keywords: { type: ["string", "null"], maxLength: 512 },
					og_title: { type: ["string", "null"], maxLength: 255 },
					og_description: { type: ["string", "null"], maxLength: 512 },
					canonical_url: { type: ["string", "null"], maxLength: 512, pattern: "^(https?://[^\\s]+|/[^\\s]*)$" },
				},
				additionalProperties: false,
			},
		},
	},
	additionalProperties: false,
};

const validateRowSchema = ajv.compile(rowSchema);

const optionsSchema = {
	type: "object",
	properties: {
		mode: { enum: ["create", "update", "upsert"] },
		match_by: { enum: ["sku", "id"] },
		dry_run: { type: "boolean" },
		empty_clears: { type: "boolean" },
	},
	required: ["mode", "match_by"],
	additionalProperties: false,
};
const validateOptionsSchema = ajv.compile(optionsSchema);

/* ---------- Нормалізація значень із клітинок ---------- */

function cellText(v) {
	if (v === null || v === undefined) return "";
	if (typeof v === "object") {
		if (v instanceof Date) return v.toISOString().slice(0, 10);
		if (v.richText) return v.richText.map((r) => r.text).join("");
		if (v.text !== undefined) return String(v.text);
		if (v.result !== undefined) return String(v.result);
	}
	return String(v).trim();
}

/** "1 234,50" / "1,234.50" / "1234.5" → 1234.5 */
function parseNumber(s) {
	let t = String(s).replace(/[\s\u00A0\u202F']/g, "");
	if (t.includes(",") && t.includes(".")) {
		t = t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
	} else {
		t = t.replace(",", ".");
	}
	if (!/^-?\d+(\.\d+)?$/.test(t)) return NaN;
	return Number(t);
}

function round(n, digits) {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}

const TRUE = ["1", "true", "yes", "y", "так", "+"];
const FALSE = ["0", "false", "no", "n", "ні", "-"];

/**
 * Перетворити сирий рядок (header → значення) у товар.
 * Повертає { data, errors }. Порожня клітинка: пропуск поля, або null при emptyClears.
 */
function normalizeRow(raw, langs, emptyClears) {
	const data = {};
	const errors = [];

	for (const [key, type] of Object.entries(COLUMNS)) {
		if (!(key in raw)) continue;
		const s = cellText(raw[key]);
		if (s === "") {
			if (emptyClears && ["money", "dim"].includes(type) && key !== "price") data[key] = null;
			continue;
		}
		if (type === "string") data[key] = key === "country_of_origin" ? s.toUpperCase() : s;
		else if (type === "int") {
			const n = parseNumber(s);
			if (!Number.isInteger(n)) errors.push({ field: key, message: "integer expected" });
			else data[key] = n;
		} else if (type === "money" || type === "qty" || type === "dim") {
			const n = parseNumber(s);
			if (Number.isNaN(n)) errors.push({ field: key, message: "number expected" });
			else data[key] = round(n, type === "money" || type === "dim" ? 4 : 3);
		} else if (type === "bool") {
			const l = s.toLowerCase();
			if (TRUE.includes(l)) data[key] = 1;
			else if (FALSE.includes(l)) data[key] = 0;
			else errors.push({ field: key, message: "boolean expected (1/0)" });
		} else if (type === "idlist") {
			const parts = s.split(/[,;|\s]+/).filter(Boolean).map(Number);
			if (parts.some((n) => !Number.isInteger(n) || n < 1)) errors.push({ field: key, message: "list of ids expected" });
			else data[key] = [...new Set(parts)];
		} else if (type.startsWith("enum:")) data[key] = s.toLowerCase();
	}

	const descriptions = {};
	for (const lang of langs) {
		const d = {};
		for (const f of LANG_COLUMNS) {
			const col = `${f}_${lang.iso}`;
			if (!(col in raw)) continue;
			const s = cellText(raw[col]);
			if (s === "") {
				if (emptyClears && f !== "name") d[f] = null;
				continue;
			}
			d[f] = s;
		}
		if (Object.keys(d).length) descriptions[lang.id] = d;
	}
	if (Object.keys(descriptions).length) data.descriptions = descriptions;

	if (!errors.length && !validateRowSchema(data)) {
		for (const e of validateRowSchema.errors) {
			errors.push({ field: e.instancePath.replace(/^\//, "").replace(/\//g, ".") || e.params.missingProperty || "row", message: e.message });
		}
	}
	return { data, errors };
}

function validateOptions(body) {
	const o = {
		mode: body.mode,
		match_by: body.match_by,
		dry_run: body.dry_run === "1" || body.dry_run === true || body.dry_run === "true",
		empty_clears: body.empty_clears === "1" || body.empty_clears === true || body.empty_clears === "true",
	};
	if (!validateOptionsSchema(o)) return { error: validateOptionsSchema.errors.map((e) => ({ field: e.instancePath.slice(1) || "options", message: e.message })) };
	return { value: o };
}

module.exports = { COLUMNS, LANG_COLUMNS, COST_COLUMNS, normalizeRow, validateOptions, cellText };