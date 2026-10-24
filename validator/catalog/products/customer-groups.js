"use strict";

const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });

const MAX_MONEY = 99999999999;
const DATETIME = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}(:\\d{2})?$" };

const group = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["code", "name"],
	properties: {
		code: { type: "string", minLength: 1, maxLength: 32, pattern: "^[A-Za-z0-9_\\-]+$" },
		name: { type: "string", minLength: 1, maxLength: 128 },
		discount_percent: { type: "number", minimum: 0, maximum: 100, default: 0 },
		price_display: { enum: ["tax_incl", "tax_excl"], default: "tax_incl" },
		min_order_amount: { type: ["number", "null"], minimum: 0, maximum: MAX_MONEY, default: null },
		requires_approval: { type: "boolean", default: false },
		status: { type: "boolean", default: true },
		sort_order: { type: "integer", minimum: -100000, maximum: 100000, default: 0 },
		// Назви для вітрини: { [id_lang]: { name, description } }
		descriptions: { type: "object", default: {} },
	},
});

const schedule = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["field", "value", "run_at"],
	properties: {
		field: { enum: ["price", "compare_at_price"] },
		value: { type: ["number", "null"], minimum: 0, maximum: MAX_MONEY },
		set_compare_at: { type: "boolean", default: false },
		run_at: DATETIME,
		revert_at: { anyOf: [DATETIME, { type: "null" }], default: null },
		comment: { type: ["string", "null"], maxLength: 255, default: null },
	},
});

function ajvErrors(fn) {
	return (fn.errors || []).map((e) => ({
		field: (e.instancePath || "").replace(/^\//, "").replace(/\//g, ".") || (e.params && (e.params.missingProperty || e.params.additionalProperty)) || "",
		message: e.message,
	}));
}

const normDt = (v) => (v ? String(v).replace("T", " ").padEnd(19, ":00").slice(0, 19) : null);

function validateGroup(body, langIds) {
	const data = JSON.parse(JSON.stringify(body || {}));
	if (!group(data)) return { valid: false, errors: ajvErrors(group) };
	data.code = data.code.trim();
	data.name = data.name.trim();
	const errors = [];
	const descs = {};
	for (const idLang of langIds) {
		const raw = data.descriptions[idLang] || data.descriptions[String(idLang)] || {};
		const name = raw.name == null ? "" : String(raw.name).trim();
		const description = raw.description == null ? "" : String(raw.description).trim();
		if (name.length > 128) errors.push({ field: `descriptions.${idLang}.name`, message: "must NOT have more than 128 characters" });
		if (description.length > 1000) errors.push({ field: `descriptions.${idLang}.description`, message: "must NOT have more than 1000 characters" });
		descs[idLang] = name || description ? { name: name || null, description: description || null } : null;
	}
	data.descriptions = descs;
	return errors.length ? { valid: false, errors } : { valid: true, data };
}

function validateSchedule(body) {
	const data = JSON.parse(JSON.stringify(body || {}));
	if (!schedule(data)) return { valid: false, errors: ajvErrors(schedule) };
	data.run_at = normDt(data.run_at);
	data.revert_at = normDt(data.revert_at);
	const errors = [];
	if (data.field === "price" && data.value === null) errors.push({ field: "value", message: "required" });
	if (data.field !== "price") data.set_compare_at = false;
	if (data.revert_at && data.revert_at <= data.run_at) errors.push({ field: "revert_at", message: "must be later than run_at" });
	return errors.length ? { valid: false, errors } : { valid: true, data };
}

module.exports = { validateGroup, validateSchedule };