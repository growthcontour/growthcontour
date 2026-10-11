"use strict";

const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });

const TYPES = ["select", "radio", "checkbox", "color", "text", "textarea", "number", "file", "date", "time", "datetime"];
const VALUE_TYPES = ["select", "radio", "checkbox", "color"];
const MAX_MONEY = 99999999999;

// ─── Довідник ────────────────────────────────────────
const option = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["type"],
	properties: {
		code: { type: ["string", "null"], maxLength: 64, pattern: "^[a-z0-9_]+$", default: null },
		type: { enum: TYPES },
		sort_order: { type: "integer", default: 0 },
	},
});

const optionValue = ajv.compile({
	type: "object",
	additionalProperties: false,
	properties: {
		id: { type: ["integer", "null"], minimum: 1, default: null },
		color_hex: { type: ["string", "null"], pattern: "^#[0-9a-fA-F]{6}$", default: null },
		names: { type: "object", default: {} },
	},
});

// ─── Опції в товарі ──────────────────────────────────
const productOption = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["id_option"],
	properties: {
		id_option: { type: "integer", minimum: 1 },
		is_required: { type: "boolean", default: false },
		default_value: { type: ["string", "null"], maxLength: 255, default: null },
		values: {
			type: "array",
			maxItems: 1000,
			default: [],
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id_option_value"],
				properties: {
					id_option_value: { type: "integer", minimum: 1 },
					price_mode: { enum: ["fixed", "percent"], default: "fixed" },
					price: { type: "number", minimum: -MAX_MONEY, maximum: MAX_MONEY, default: 0 },
					points: { type: "integer", minimum: -2147483648, maximum: 2147483647, default: 0 },
					weight: { type: "number", minimum: -99999999, maximum: 99999999, default: 0 },
					quantity: { type: ["number", "null"], minimum: 0, maximum: 999999999, default: null },
					subtract_stock: { type: "boolean", default: false },
					sku_suffix: { type: ["string", "null"], maxLength: 32, pattern: "^[A-Za-z0-9_\\-.]*$", default: null },
					is_default: { type: "boolean", default: false },
				},
			},
		},
	},
});

const customization = ajv.compile({
	type: "object",
	additionalProperties: false,
	properties: {
		id: { type: ["integer", "null"], minimum: 1, default: null },
		type: { enum: ["text", "file"], default: "text" },
		is_required: { type: "boolean", default: false },
		max_length: { type: ["integer", "null"], minimum: 1, maximum: 65535, default: null },
		price: { type: "number", minimum: 0, maximum: MAX_MONEY, default: 0 },
		labels: { type: "object", default: {} },
	},
});

function clean(obj) {
	const data = JSON.parse(JSON.stringify(obj || {}));
	for (const k of Object.keys(data)) {
		if (typeof data[k] === "string") data[k] = data[k].trim();
		if (data[k] === "") data[k] = null;
	}
	return data;
}
const ajvErrors = (v, prefix = "") => v.errors.map((e) => ({ field: prefix + ((e.instancePath || "").slice(1).replace(/\//g, ".") || e.params.missingProperty), message: e.message }));

/** Назви на кожну мову; перша мова обов'язкова */
function validateNames(input, langIds, fields, prefix) {
	const src = input && typeof input === "object" ? input : {};
	const errors = [];
	const data = {};
	langIds.forEach((idLang, index) => {
		const raw = src[idLang] || src[String(idLang)] || {};
		const row = {};
		for (const [f, max] of Object.entries(fields)) {
			const v = raw[f] == null ? "" : String(raw[f]).trim();
			if (v.length > max) errors.push({ field: `${prefix}.${idLang}.${f}`, message: `must NOT have more than ${max} characters` });
			row[f] = v === "" ? null : v;
		}
		const hasAny = Object.values(row).some((v) => v !== null);
		const key = Object.keys(fields)[0];
		if (!row[key] && (index === 0 || hasAny)) errors.push({ field: `${prefix}.${idLang}.${key}`, message: "required" });
		data[idLang] = row[key] ? row : null;
	});
	return { errors, data };
}

function validateOption(body, langIds) {
	const data = clean(body);
	const names = data.names;
	const values = Array.isArray(data.values) ? data.values : [];
	delete data.names;
	delete data.values;
	if (!option(data)) return { valid: false, errors: ajvErrors(option) };

	const n = validateNames(names, langIds, { name: 255 }, "names");
	const errors = [...n.errors];
	const out = [];
	if (VALUE_TYPES.includes(data.type)) {
		if (values.length > 5000) errors.push({ field: "values", message: "too many values" });
		values.forEach((v, i) => {
			const row = clean(v);
			if (!optionValue(row)) return errors.push(...ajvErrors(optionValue, `values.${i}.`));
			if (data.type === "color" && !row.color_hex) errors.push({ field: `values.${i}.color_hex`, message: "required" });
			const vn = validateNames(row.names, langIds, { name: 255 }, `values.${i}.names`);
			errors.push(...vn.errors);
			out.push({ ...row, names: vn.data });
		});
	}
	return errors.length ? { valid: false, errors } : { valid: true, data, names: n.data, values: out };
}

/** Опції та персоналізація товару (частина збереження карточки) */
function validateProductOptions(body, langIds) {
	const errors = [];
	const options = [];
	const custom = [];
	const srcOptions = Array.isArray(body && body.options) ? body.options : [];
	const srcCustom = Array.isArray(body && body.customization) ? body.customization : [];
	if (srcOptions.length > 200) errors.push({ field: "options", message: "too many options" });
	if (srcCustom.length > 50) errors.push({ field: "customization", message: "too many fields" });

	srcOptions.forEach((o, i) => {
		const row = JSON.parse(JSON.stringify(o || {}));
		if (!productOption(row)) return errors.push(...ajvErrors(productOption, `options.${i}.`));
		const ids = row.values.map((v) => v.id_option_value);
		if (new Set(ids).size !== ids.length) errors.push({ field: `options.${i}`, message: "duplicate value" });
		row.values.forEach((v, k) => {
			if (v.price_mode === "percent" && (v.price < -100 || v.price > 1000)) errors.push({ field: `options.${i}.values.${k}.price`, message: "percent out of range" });
		});
		options.push(row);
	});
	const optIds = options.map((o) => o.id_option);
	if (new Set(optIds).size !== optIds.length) errors.push({ field: "options", message: "duplicate option" });

	srcCustom.forEach((c, i) => {
		const row = clean(c);
		if (!customization(row)) return errors.push(...ajvErrors(customization, `customization.${i}.`));
		const n = validateNames(row.labels, langIds, { label: 255 }, `customization.${i}.labels`);
		errors.push(...n.errors);
		custom.push({ ...row, labels: n.data });
	});

	return errors.length ? { valid: false, errors } : { valid: true, data: { options, customization: custom } };
}

module.exports = { TYPES, VALUE_TYPES, validateOption, validateProductOptions };