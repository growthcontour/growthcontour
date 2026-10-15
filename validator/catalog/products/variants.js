"use strict";

const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });

const MAX_MONEY = 99999999999;
const money = { type: ["number", "null"], minimum: 0, maximum: MAX_MONEY, default: null };

const variant = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["id"],
	properties: {
		id: { type: "integer", minimum: 1 },
		sku: { type: ["string", "null"], maxLength: 64, pattern: "^[A-Za-z0-9_\\-./]+$", default: null },
		mpn: { type: ["string", "null"], maxLength: 64, default: null },
		ean: { type: ["string", "null"], pattern: "^(\\d{8}|\\d{12,14})$", default: null },
		price_mode: { enum: ["impact", "fixed"], default: "impact" },
		price: { type: "number", minimum: -MAX_MONEY, maximum: MAX_MONEY, default: 0 },
		compare_at_price: money,
		cost_price: money,
		weight_impact: { type: ["number", "null"], minimum: -99999999, maximum: 99999999, default: null },
		is_default: { type: "boolean", default: false },
		status: { type: "boolean", default: true },
		media_ids: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "integer", minimum: 1 }, default: [] },
		stock: {
			type: "array",
			maxItems: 1000,
			default: [],
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id_warehouse", "on_hand"],
				properties: {
					id_warehouse: { type: "integer", minimum: 1 },
					on_hand: { type: "number", minimum: -999999999, maximum: 999999999 },
				},
			},
		},
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

function validateVariants(list) {
	if (!Array.isArray(list) || list.length > 1000) return { valid: false, errors: [{ field: "variants", message: "invalid list" }] };
	const errors = [];
	const out = [];
	list.forEach((v, i) => {
		const data = clean(v);
		if (!variant(data)) {
			variant.errors.forEach((e) => errors.push({ field: `variants.${i}.${(e.instancePath || "").slice(1).replace(/\//g, ".") || e.params.missingProperty}`, message: e.message }));
			return;
		}
		if (data.price_mode === "fixed" && data.price < 0) errors.push({ field: `variants.${i}.price`, message: "must be >= 0" });
		const wh = data.stock.map((s) => s.id_warehouse);
		if (new Set(wh).size !== wh.length) errors.push({ field: `variants.${i}.stock`, message: "duplicate warehouse" });
		out.push(data);
	});
	if (out.filter((v) => v.is_default).length > 1) errors.push({ field: "variants", message: "only one default variant" });
	const skus = out.map((v) => v.sku).filter(Boolean);
	if (new Set(skus).size !== skus.length) errors.push({ field: "variants", message: "duplicate SKU" });
	return errors.length ? { valid: false, errors } : { valid: true, data: out };
}

function validateAxes(body) {
	const ids = Array.isArray(body && body.axes) ? body.axes.map((x) => parseInt(x, 10)) : null;
	if (!ids || ids.some((x) => !Number.isInteger(x) || x < 1) || ids.length > 5 || new Set(ids).size !== ids.length) {
		return { valid: false, errors: [{ field: "axes", message: "1–5 unique attributes required" }] };
	}
	return { valid: true, data: ids };
}

function validateGenerate(body) {
	const src = body && body.values && typeof body.values === "object" ? body.values : null;
	if (!src) return { valid: false, errors: [{ field: "values", message: "required" }] };
	const data = {};
	for (const [k, arr] of Object.entries(src)) {
		const idAttr = parseInt(k, 10);
		if (!Number.isInteger(idAttr) || !Array.isArray(arr)) return { valid: false, errors: [{ field: "values", message: "invalid" }] };
		const ids = [...new Set(arr.map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0))];
		data[idAttr] = ids;
	}
	return { valid: true, data };
}

module.exports = { validateVariants, validateAxes, validateGenerate };