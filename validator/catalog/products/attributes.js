"use strict";

const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });

const TYPES = ["select", "multiselect", "text", "textarea", "integer", "decimal", "boolean", "date", "color"];
const VALUE_TYPES = ["select", "multiselect", "color"];
const AXIS_TYPES = ["select", "color"];

const CODE = { type: ["string", "null"], maxLength: 64, pattern: "^[a-z0-9_]+$", default: null };

const attribute = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["type"],
	properties: {
		code: CODE,
		id_attribute_group: { type: ["integer", "null"], minimum: 1, default: null },
		type: { enum: TYPES },
		unit: { type: ["string", "null"], maxLength: 16, default: null },
		is_translatable: { type: "boolean", default: true },
		is_filterable: { type: "boolean", default: false },
		is_comparable: { type: "boolean", default: false },
		is_visible_on_card: { type: "boolean", default: true },
		is_variant_axis: { type: "boolean", default: false },
		is_required: { type: "boolean", default: false },
		sort_order: { type: "integer", default: 0 },
	},
});

const value = ajv.compile({
	type: "object",
	additionalProperties: false,
	properties: {
		id: { type: ["integer", "null"], minimum: 1, default: null },
		code: { type: ["string", "null"], maxLength: 64, pattern: "^[a-z0-9_\\-]+$", default: null },
		color_hex: { type: ["string", "null"], pattern: "^#[0-9a-fA-F]{6}$", default: null },
		names: { type: "object", default: {} },
	},
});

const group = ajv.compile({
	type: "object",
	additionalProperties: false,
	properties: {
		code: CODE,
		sort_order: { type: "integer", default: 0 },
	},
});

const set = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["name"],
	properties: {
		code: CODE,
		name: { type: "string", minLength: 1, maxLength: 255 },
		sort_order: { type: "integer", default: 0 },
		items: {
			type: "array",
			maxItems: 500,
			default: [],
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id_attribute"],
				properties: {
					id_attribute: { type: "integer", minimum: 1 },
					is_required: { type: "boolean", default: false },
				},
			},
		},
	},
});

function clean(body) {
	const data = JSON.parse(JSON.stringify(body || {}));
	for (const k of Object.keys(data)) {
		if (typeof data[k] === "string") data[k] = data[k].trim();
		if (data[k] === "") data[k] = null;
	}
	return data;
}

function ajvErrors(validate, prefix = "") {
	return validate.errors.map((e) => ({ field: prefix + ((e.instancePath || "").slice(1).replace(/\//g, ".") || e.params.missingProperty), message: e.message }));
}

/**
 * Назви на кожну мову: { [id_lang]: { name, hint? } }.
 * Перша мова — обов'язкова назва; інші — або назва, або всі поля порожні.
 */
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
		if (!row.name && (index === 0 || hasAny)) errors.push({ field: `${prefix}.${idLang}.name`, message: "required" });
		data[idLang] = row.name ? row : null;
	});
	return { errors, data };
}

function validateAttribute(body, langIds) {
	const data = clean(body);
	const names = data.names;
	const values = Array.isArray(data.values) ? data.values : [];
	delete data.names;
	delete data.values;
	delete data.force;

	if (!attribute(data)) return { valid: false, errors: ajvErrors(attribute) };
	if (data.is_variant_axis && !AXIS_TYPES.includes(data.type)) {
		return { valid: false, errors: [{ field: "is_variant_axis", message: "only select and color attributes can be variant axes" }] };
	}

	const n = validateNames(names, langIds, { name: 255, hint: 512 }, "names");
	const errors = [...n.errors];

	const cleanValues = [];
	if (VALUE_TYPES.includes(data.type)) {
		if (values.length > 5000) errors.push({ field: "values", message: "too many values" });
		values.forEach((v, i) => {
			const row = clean(v);
			if (row.code) row.code = String(row.code).toLowerCase();
			if (!value(row)) return errors.push(...ajvErrors(value, `values.${i}.`));
			if (data.type === "color" && !row.color_hex) errors.push({ field: `values.${i}.color_hex`, message: "required" });
			const vn = validateNames(row.names, langIds, { name: 255 }, `values.${i}.names`);
			errors.push(...vn.errors);
			cleanValues.push({ ...row, names: vn.data });
		});
	}

	return errors.length ? { valid: false, errors } : { valid: true, data, names: n.data, values: cleanValues };
}

function validateGroup(body, langIds) {
	const data = clean(body);
	const names = data.names;
	delete data.names;
	if (!group(data)) return { valid: false, errors: ajvErrors(group) };
	const n = validateNames(names, langIds, { name: 255 }, "names");
	return n.errors.length ? { valid: false, errors: n.errors } : { valid: true, data, names: n.data };
}

function validateSet(body) {
	const data = clean(body);
	if (!set(data)) return { valid: false, errors: ajvErrors(set) };
	const ids = data.items.map((i) => i.id_attribute);
	if (new Set(ids).size !== ids.length) return { valid: false, errors: [{ field: "items", message: "duplicate attribute" }] };
	return { valid: true, data };
}

module.exports = { TYPES, VALUE_TYPES, AXIS_TYPES, validateAttribute, validateGroup, validateSet };