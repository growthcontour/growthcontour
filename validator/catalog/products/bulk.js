"use strict";

const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, removeAdditional: true, coerceTypes: false });

const MAX_IDS = 1000;
const MONEY_MAX = 99999999999;

const schema = {
	type: "object",
	required: ["ids", "action"],
	properties: {
		ids: { type: "array", minItems: 1, maxItems: MAX_IDS, uniqueItems: true, items: { type: "integer", minimum: 1 } },
		action: { enum: ["status", "visibility", "featured", "brand", "categories", "price", "compare_from_price", "delete"] },
		params: { type: "object" },
	},
	additionalProperties: false,
	allOf: [
		{
			if: { properties: { action: { const: "status" } } },
			then: { properties: { params: { type: "object", required: ["status"], properties: { status: { enum: ["draft", "active", "archived"] } }, additionalProperties: false } }, required: ["params"] },
		},
		{
			if: { properties: { action: { const: "visibility" } } },
			then: { properties: { params: { type: "object", required: ["visibility"], properties: { visibility: { enum: ["all", "catalog", "search", "none"] } }, additionalProperties: false } }, required: ["params"] },
		},
		{
			if: { properties: { action: { const: "featured" } } },
			then: { properties: { params: { type: "object", required: ["value"], properties: { value: { enum: [0, 1] } }, additionalProperties: false } }, required: ["params"] },
		},
		{
			if: { properties: { action: { const: "brand" } } },
			then: { properties: { params: { type: "object", required: ["id_brand"], properties: { id_brand: { type: ["integer", "null"], minimum: 1 } }, additionalProperties: false } }, required: ["params"] },
		},
		{
			if: { properties: { action: { const: "categories" } } },
			then: {
				required: ["params"],
				properties: {
					params: {
						type: "object",
						required: ["op", "ids"],
						properties: {
							op: { enum: ["add", "remove", "replace"] },
							ids: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "integer", minimum: 1 } },
							set_main: { type: "boolean" },
						},
						additionalProperties: false,
					},
				},
			},
		},
		{
			if: { properties: { action: { const: "price" } } },
			then: {
				required: ["params"],
				properties: {
					params: {
						type: "object",
						required: ["field", "op", "value"],
						properties: {
							field: { enum: ["price", "compare_at_price", "cost_price", "wholesale_price"] },
							op: { enum: ["set", "percent", "amount"] },
							value: { type: "number", minimum: -MONEY_MAX, maximum: MONEY_MAX },
							round: { enum: ["none", "0", "1", "2", "99", "9"] },
							variants: { type: "boolean" },
						},
						additionalProperties: false,
					},
				},
			},
		},
		{
			if: { properties: { action: { const: "compare_from_price" } } },
			then: { properties: { params: { type: "object", properties: { variants: { type: "boolean" } }, additionalProperties: false } } },
		},
	],
};

const validate = ajv.compile(schema);

function validateBulk(body) {
	if (!validate(body)) {
		return { error: validate.errors.filter((e) => e.keyword !== "if").map((e) => ({ field: e.instancePath.replace(/^\//, "").replace(/\//g, ".") || e.params.missingProperty || "body", message: e.message })) };
	}
	const v = body;
	if (v.action === "price") {
		const p = v.params;
		if (p.op === "set" && p.value < 0) return { error: [{ field: "params.value", message: "must be >= 0" }] };
		if (p.op === "percent" && (p.value < -100 || p.value > 10000)) return { error: [{ field: "params.value", message: "percent out of range" }] };
		if (!p.round) p.round = "none";
		if (p.variants === undefined) p.variants = true;
	}
	if (v.action === "compare_from_price") v.params = { variants: true, ...(v.params || {}) };
	return { value: v };
}

module.exports = { validateBulk, MAX_IDS };