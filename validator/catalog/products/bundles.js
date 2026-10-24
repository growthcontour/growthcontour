"use strict";

const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });

const bundle = ajv.compile({
	type: "object",
	additionalProperties: false,
	properties: {
		pack_stock_mode: { enum: ["pack", "components", "both"], default: "components" },
		items: {
			type: "array",
			maxItems: 200,
			default: [],
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id_product", "qty"],
				properties: {
					id_product: { type: "integer", minimum: 1 },
					id_variant: { type: "integer", minimum: 0, default: 0 },
					qty: { type: "number", exclusiveMinimum: 0, maximum: 999999 },
					is_optional: { type: "boolean", default: false },
					price_override: { type: ["number", "null"], minimum: 0, maximum: 99999999999, default: null },
				},
			},
		},
	},
});

function validateBundle(body) {
	const data = JSON.parse(JSON.stringify(body || {}));
	if (!bundle(data)) {
		return { valid: false, errors: bundle.errors.map((e) => ({ field: (e.instancePath || "").slice(1).replace(/\//g, ".") || e.params.missingProperty, message: e.message })) };
	}
	const keys = data.items.map((i) => `${i.id_product}:${i.id_variant}`);
	if (new Set(keys).size !== keys.length) return { valid: false, errors: [{ field: "items", message: "duplicate component" }] };
	if (data.items.length && data.items.every((i) => i.is_optional)) return { valid: false, errors: [{ field: "items", message: "at least one required component" }] };
	return { valid: true, data };
}

module.exports = { validateBundle };