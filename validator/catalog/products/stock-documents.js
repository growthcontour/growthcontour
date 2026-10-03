"use strict";

const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });
addFormats(ajv, ["date"]);

const TYPES = ["receipt", "transfer", "writeoff", "inventory", "return", "adjustment"];
const str = (max, extra = {}) => ({ type: ["string", "null"], maxLength: max, default: null, ...extra });

const header = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["type", "id_warehouse", "date_document"],
	properties: {
		type: { enum: TYPES },
		id_warehouse: { type: "integer", minimum: 1 },
		id_warehouse_to: { type: ["integer", "null"], minimum: 1, default: null },
		id_supplier: { type: ["integer", "null"], minimum: 1, default: null },
		external_number: str(64),
		currency: str(3, { pattern: "^[A-Z]{3}$" }),
		comment: str(5000),
		date_document: { type: "string", format: "date" },
	},
});

const items = ajv.compile({
	type: "array",
	maxItems: 5000,
	items: {
		type: "object",
		additionalProperties: false,
		required: ["id_product", "qty"],
		properties: {
			id_product: { type: "integer", minimum: 1 },
			id_variant: { type: "integer", minimum: 0, default: 0 },
			id_location: { type: ["integer", "null"], minimum: 1, default: null },
			batch_no: str(64, { pattern: "^[A-Za-z0-9_\\-./]+$" }),
			expiry_date: { type: ["string", "null"], format: "date", default: null },
			qty: { type: "number", minimum: -999999999, maximum: 999999999 },
			cost_price: { type: ["number", "null"], minimum: 0, maximum: 99999999999, default: null },
			serials: { type: "array", maxItems: 10000, uniqueItems: true, default: [], items: { type: "string", minLength: 1, maxLength: 128 } },
		},
	},
});

function validateDocument(body) {
	const h = JSON.parse(JSON.stringify((body && body.header) || {}));
	for (const k of Object.keys(h)) {
		if (typeof h[k] === "string") h[k] = h[k].trim();
		if (h[k] === "") h[k] = null;
	}
	if (h.currency) h.currency = String(h.currency).toUpperCase();
	if (!header(h)) return { valid: false, errors: header.errors.map((e) => ({ field: "header." + ((e.instancePath || "").slice(1) || e.params.missingProperty), message: e.message })) };

	const list = JSON.parse(JSON.stringify((body && body.items) || []));
	list.forEach((it) => {
		for (const k of Object.keys(it)) if (it[k] === "") it[k] = null;
		if (Array.isArray(it.serials)) it.serials = it.serials.map((s) => String(s).trim()).filter(Boolean);
	});
	if (!items(list)) return { valid: false, errors: items.errors.map((e) => ({ field: "items" + (e.instancePath || "").replace(/\//g, "."), message: e.message })) };

	const errors = [];
	if (h.type === "transfer") {
		if (!h.id_warehouse_to) errors.push({ field: "header.id_warehouse_to", message: "required" });
		else if (h.id_warehouse_to === h.id_warehouse) errors.push({ field: "header.id_warehouse_to", message: "must differ from source warehouse" });
	} else h.id_warehouse_to = null;
	if (h.type !== "receipt") h.id_supplier = null;

	const seen = new Set();
	list.forEach((it, i) => {
		const f = `items.${i}`;
		if (h.type === "adjustment" && it.qty === 0) errors.push({ field: `${f}.qty`, message: "must not be 0" });
		if (h.type === "inventory" && it.qty < 0) errors.push({ field: `${f}.qty`, message: "must be >= 0" });
		if (!["adjustment", "inventory"].includes(h.type) && it.qty <= 0) errors.push({ field: `${f}.qty`, message: "must be > 0" });
		if (it.serials.length && (!Number.isInteger(Math.abs(it.qty)) || it.serials.length !== Math.abs(it.qty))) {
			errors.push({ field: `${f}.serials`, message: "number of serials must equal qty" });
		}
		if (h.type !== "receipt" && h.type !== "return") {
			it.cost_price = null;
			it.expiry_date = null;
		}
		const key = `${it.id_product}:${it.id_variant}:${it.batch_no || ""}`;
		if (seen.has(key)) errors.push({ field: f, message: "duplicate line (product, variant, batch)" });
		seen.add(key);
	});

	return errors.length ? { valid: false, errors } : { valid: true, header: h, items: list };
}

module.exports = { TYPES, validateDocument };