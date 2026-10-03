"use strict";

const Ajv = require("ajv");
const { parsePhoneNumberFromString } = require("libphonenumber-js");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });

const str = (max, extra = {}) => ({ type: ["string", "null"], maxLength: max, default: null, ...extra });

const warehouse = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["code", "name"],
	properties: {
		code: { type: "string", minLength: 1, maxLength: 32, pattern: "^[A-Za-z0-9_\\-]+$" },
		name: { type: "string", minLength: 1, maxLength: 255 },
		type: { enum: ["own", "supplier", "dropship", "store", "transit"], default: "own" },
		id_supplier: { type: ["integer", "null"], minimum: 1, default: null },
		country: str(2, { pattern: "^[A-Z]{2}$" }),
		city: str(128),
		address: str(512),
		postcode: str(16),
		latitude: { type: ["number", "null"], minimum: -90, maximum: 90, default: null },
		longitude: { type: ["number", "null"], minimum: -180, maximum: 180, default: null },
		carrier_ref: str(64),
		phone: str(32),
		priority: { type: "integer", minimum: -1000, maximum: 1000, default: 0 },
		is_sellable: { type: "boolean", default: true },
		allow_negative: { type: "boolean", default: false },
		status: { type: "boolean", default: true },
		sort_order: { type: "integer", default: 0 },
	},
});

const location = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["code"],
	properties: {
		code: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_\\-./]+$" },
		name: str(255),
		status: { type: "boolean", default: true },
	},
});

function clean(body) {
	const data = JSON.parse(JSON.stringify(body || {}));
	for (const k of Object.keys(data)) {
		if (typeof data[k] === "string") data[k] = data[k].trim();
		if (data[k] === "") data[k] = null;
	}
	if (data.country) data.country = String(data.country).toUpperCase();
	return data;
}

function ajvErrors(validate) {
	return validate.errors.map((e) => ({ field: (e.instancePath || "").slice(1) || e.params.missingProperty, message: e.message }));
}

/**
 * Телефон → E.164. Номер з "+" приймається для будь-якої країни.
 * Без "+" — розбирається за країною запису; якщо країни немає — помилка.
 */
function normalizePhone(phone, country) {
	if (!phone) return { ok: true, value: null };
	const intl = phone.startsWith("+") || phone.startsWith("00");
	if (!intl && !country) return { ok: false, message: "use international format: +<country code><number>" };
	const p = parsePhoneNumberFromString(phone.replace(/^00/, "+"), intl ? undefined : country);
	if (!p || !p.isValid()) return { ok: false, message: "invalid phone number" };
	return { ok: true, value: p.number };
}

function validateWarehouse(body) {
	const data = clean(body);
	if (!warehouse(data)) return { valid: false, errors: ajvErrors(warehouse) };
	data.code = data.code.toUpperCase();
	const phone = normalizePhone(data.phone, data.country);
	if (!phone.ok) return { valid: false, errors: [{ field: "phone", message: phone.message }] };
	data.phone = phone.value;
	return { valid: true, data };
}

function validateLocation(body) {
	const data = clean(body);
	if (!location(data)) return { valid: false, errors: ajvErrors(location) };
	data.code = data.code.toUpperCase();
	return { valid: true, data };
}

module.exports = { validateWarehouse, validateLocation, normalizePhone };