"use strict";

const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });

const IMG = "^[0-9a-f]{2}/[0-9a-f]{64}\\.(webp|avif|jpg|png|gif)$";
const STATUSES = ["pending", "approved", "rejected", "spam"];
const str = (max) => ({ type: ["string", "null"], maxLength: max, default: null });

const review = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["id_product", "rating", "author_name"],
	properties: {
		id_product: { type: "integer", minimum: 1 },
		id_variant: { type: "integer", minimum: 0, default: 0 },
		id_lang: { type: ["integer", "null"], minimum: 1, default: null },
		rating: { type: "integer", minimum: 1, maximum: 5 },
		author_name: { type: "string", minLength: 1, maxLength: 128 },
		author_email: { type: ["string", "null"], maxLength: 191, default: null },
		title: str(255),
		body: str(10000),
		pros: str(2000),
		cons: str(2000),
		verified_purchase: { type: "boolean", default: false },
		status: { enum: STATUSES, default: "approved" },
		reply: str(5000),
		date_add: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}(:\\d{2})?$", default: null },
		media: { type: "array", maxItems: 10, default: [], items: { type: "string", pattern: IMG } },
	},
});

const moderation = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["ids", "status"],
	properties: {
		ids: { type: "array", minItems: 1, maxItems: 1000, uniqueItems: true, items: { type: "integer", minimum: 1 } },
		status: { enum: STATUSES },
	},
});

function ajvErrors(fn) {
	return (fn.errors || []).map((e) => ({
		field: (e.instancePath || "").replace(/^\//, "").replace(/\//g, ".") || (e.params && (e.params.missingProperty || e.params.additionalProperty)) || "",
		message: e.message,
	}));
}

const trimOrNull = (v) => {
	if (v == null) return null;
	const s = String(v).replace(/\r\n/g, "\n").trim();
	return s === "" ? null : s;
};

function validateReview(body) {
	const data = JSON.parse(JSON.stringify(body || {}));
	if (!review(data)) return { valid: false, errors: ajvErrors(review) };
	for (const k of ["author_name", "author_email", "title", "body", "pros", "cons", "reply"]) data[k] = trimOrNull(data[k]);
	const errors = [];
	if (!data.author_name) errors.push({ field: "author_name", message: "required" });
	if (data.author_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.author_email)) errors.push({ field: "author_email", message: "invalid email" });
	if (data.date_add) data.date_add = data.date_add.replace("T", " ").padEnd(19, ":00").slice(0, 19);
	data.media = [...new Set(data.media)];
	return errors.length ? { valid: false, errors } : { valid: true, data };
}

function validateModeration(body) {
	const data = JSON.parse(JSON.stringify(body || {}));
	if (!moderation(data)) return { valid: false, errors: ajvErrors(moderation) };
	return { valid: true, data };
}

module.exports = { STATUSES, validateReview, validateModeration, trimOrNull };