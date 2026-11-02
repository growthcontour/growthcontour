"use strict";

const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });

const IMG = "^[0-9a-f]{2}/[0-9a-f]{64}\\.(webp|avif|jpg|png|gif)$";
const STATUSES = ["pending", "approved", "rejected", "spam"];
// Звідки відгук: вручну, перенесено з Prom, з сайту (pull), імпорт
const SOURCES = ["manual", "prom", "site", "import"];
const DT = "^\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}(:\\d{2})?$";
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
		date_add: { type: ["string", "null"], pattern: DT, default: null },
		media: { type: "array", maxItems: 10, default: [], items: { type: "string", pattern: IMG } },
		source: { enum: SOURCES, default: "manual" },
		source_url: str(500),
		// Клієнт: вибраний наявний або знайти/створити за email чи телефоном
		id_client: { type: ["integer", "null"], minimum: 1, default: null },
		create_client: { type: "boolean", default: false },
		client_phone: str(32),
		// Сайти, куди публікувати, і коли (null — одразу)
		sites: {
			type: "array",
			maxItems: 50,
			default: [],
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id_integration"],
				properties: {
					id_integration: { type: "integer", minimum: 1 },
					publish_at: { type: ["string", "null"], pattern: DT, default: null },
				},
			},
		},
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
	for (const k of ["author_name", "author_email", "title", "body", "pros", "cons", "reply", "source_url", "client_phone"]) data[k] = trimOrNull(data[k]);
	const errors = [];
	if (!data.author_name) errors.push({ field: "author_name", message: "required" });
	if (data.author_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.author_email)) errors.push({ field: "author_email", message: "invalid email" });
	const dt = (v) => v.replace("T", " ").padEnd(19, ":00").slice(0, 19);
	if (data.date_add) data.date_add = dt(data.date_add);
	if (data.source_url && !/^https?:\/\/[^\s]+$/i.test(data.source_url)) errors.push({ field: "source_url", message: "invalid url" });
	if (data.create_client && !data.id_client && !data.author_email && !data.client_phone) errors.push({ field: "client_phone", message: "email or phone required" });
	const seen = new Set();
	data.sites = data.sites.filter((x) => !seen.has(x.id_integration) && seen.add(x.id_integration)).map((x) => ({ id_integration: x.id_integration, publish_at: x.publish_at ? dt(x.publish_at) : null }));
	data.media = [...new Set(data.media)];
	return errors.length ? { valid: false, errors } : { valid: true, data };
}

function validateModeration(body) {
	const data = JSON.parse(JSON.stringify(body || {}));
	if (!moderation(data)) return { valid: false, errors: ajvErrors(moderation) };
	return { valid: true, data };
}

module.exports = { STATUSES, SOURCES, validateReview, validateModeration, trimOrNull };