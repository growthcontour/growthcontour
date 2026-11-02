"use strict";

const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { normalizePhone } = require("./warehouses");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });
addFormats(ajv, ["email", "uri"]);

const str = (max, extra = {}) => ({ type: ["string", "null"], maxLength: max, default: null, ...extra });

const supplier = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["name"],
	properties: {
		code: str(64, { pattern: "^[A-Za-z0-9_\\-]+$" }),
		name: { type: "string", minLength: 1, maxLength: 255 },
		tax_number: str(64),
		contact_person: str(255),
		email: str(255, { format: "email" }),
		phone: str(32),
		website: str(255, { format: "uri", pattern: "^https?://" }),
		address: str(512),
		country: str(2, { pattern: "^[A-Z]{2}$" }),
		currency: str(3, { pattern: "^[A-Z]{3}$" }),
		lead_time_days: { type: ["integer", "null"], minimum: 0, maximum: 3650, default: null },
		note: str(5000),
		status: { type: "boolean", default: true },
	},
});

function validateSupplier(body) {
	const data = JSON.parse(JSON.stringify(body || {}));
	for (const k of Object.keys(data)) {
		if (typeof data[k] === "string") data[k] = data[k].trim();
		if (data[k] === "") data[k] = null;
	}
	if (data.country) data.country = String(data.country).toUpperCase();
	if (data.currency) data.currency = String(data.currency).toUpperCase();

	if (!supplier(data)) {
		return { valid: false, errors: supplier.errors.map((e) => ({ field: (e.instancePath || "").slice(1) || e.params.missingProperty, message: e.message })) };
	}
	if (data.code) data.code = data.code.toUpperCase();
	if (data.email) data.email = data.email.toLowerCase();

	const phone = normalizePhone(data.phone, data.country);
	if (!phone.ok) return { valid: false, errors: [{ field: "phone", message: phone.message }] };
	data.phone = phone.value;
	return { valid: true, data };
}

module.exports = { validateSupplier };