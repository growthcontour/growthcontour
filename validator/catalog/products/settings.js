"use strict";

const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });

const CODE = { type: "string", pattern: "^[a-z0-9_]{1,32}$" };
const CURRENCY = { type: "string", pattern: "^[A-Z]{3}$" };

const SCHEMAS = {
	sku: {
		type: "object",
		additionalProperties: false,
		properties: {
			auto: { type: "boolean", default: false },
			// Токени: {PREFIX} {SEQ:n} {ID:n} {BRAND} {CAT} {YYYY} {YY} {MM} {RAND:n}
			pattern: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_\\-./{}:]+$", default: "{PREFIX}-{SEQ:6}" },
			prefix: { type: "string", maxLength: 16, pattern: "^[A-Za-z0-9_\\-]*$", default: "GC" },
			variant_pattern: { type: "string", minLength: 1, maxLength: 64, default: "{PARENT}-{AXES}" },
			regenerate_on_change: { type: "boolean", default: false },
		},
	},
	ean: {
		type: "object",
		additionalProperties: false,
		properties: {
			auto: { type: "boolean", default: false },
			// 200–299 — діапазон GS1 для внутрішнього використання магазином
			internal_prefix: { type: "string", pattern: "^2[0-9]{2}$", default: "200" },
		},
	},
	slug: {
		type: "object",
		additionalProperties: false,
		properties: {
			auto: { type: "boolean", default: true },
			transliteration: { enum: ["uk", "ru", "none"], default: "uk" },
			max_length: { type: "integer", minimum: 20, maximum: 191, default: 120 },
		},
	},
	images: {
		type: "object",
		additionalProperties: false,
		properties: {
			format: { enum: ["webp", "avif", "jpeg", "original"], default: "webp" },
			quality: { type: "integer", minimum: 30, maximum: 100, default: 82 },
			max_width: { type: "integer", minimum: 200, maximum: 8000, default: 2400 },
			max_height: { type: "integer", minimum: 200, maximum: 8000, default: 2400 },
			keep_original: { type: "boolean", default: false },
			strip_metadata: { type: "boolean", default: true },
			max_file_mb: { type: "integer", minimum: 1, maximum: 50, default: 20 },
			allowed_mime: {
				type: "array",
				uniqueItems: true,
				items: { enum: ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "image/heif", "image/tiff"] },
				default: ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"],
			},
			thumbnails: {
				type: "array",
				maxItems: 10,
				items: {
					type: "object",
					additionalProperties: false,
					required: ["code", "width", "height"],
					properties: {
						code: CODE,
						width: { type: "integer", minimum: 16, maximum: 4000 },
						height: { type: "integer", minimum: 16, maximum: 4000 },
						fit: { enum: ["contain", "cover", "inside"], default: "contain" },
					},
				},
				default: [
					{ code: "small", width: 150, height: 150, fit: "contain" },
					{ code: "medium", width: 500, height: 500, fit: "contain" },
					{ code: "large", width: 1200, height: 1200, fit: "inside" },
				],
			},
			watermark: {
				type: "object",
				additionalProperties: false,
				properties: {
					enabled: { type: "boolean", default: false },
					file: { type: ["string", "null"], pattern: "^[A-Za-z0-9_\\-./]+\\.(png|webp)$", default: null },
					position: { enum: ["center", "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"], default: "southeast" },
					opacity: { type: "number", minimum: 0.05, maximum: 1, default: 0.5 },
					scale: { type: "number", minimum: 0.05, maximum: 1, default: 0.25 },
				},
				default: {},
			},
		},
	},
	stock: {
		type: "object",
		additionalProperties: false,
		properties: {
			multi_warehouse: { type: "boolean", default: true },
			id_default_warehouse: { type: "integer", minimum: 1, default: 1 },
			write_off_strategy: { enum: ["priority", "fifo", "fefo"], default: "priority" },
			reserve_on: { enum: ["order_create", "order_paid", "never"], default: "order_create" },
			reservation_ttl_minutes: { type: "integer", minimum: 0, maximum: 43200, default: 60 },
			allow_negative: { type: "boolean", default: false },
			track_batches: { type: "boolean", default: false },
			track_serials: { type: "boolean", default: false },
			default_out_of_stock_action: { enum: ["deny", "backorder", "preorder"], default: "deny" },
			auto_digital_links: { type: "boolean", default: true },
		},
	},
	prices: {
		type: "object",
		additionalProperties: false,
		properties: {
			base_currency: { ...CURRENCY, default: "UAH" },
			prices_include_tax: { type: "boolean", default: true },
			rounding: { type: "integer", minimum: 0, maximum: 4, default: 2 },
			show_compare_at: { type: "boolean", default: true },
		},
	},
	rewards: {
		type: "object",
		additionalProperties: false,
		properties: {
			enabled: { type: "boolean", default: false },
			point_value: { type: "number", minimum: 0, default: 1 },
			auto_mode: { enum: ["none", "percent"], default: "none" },
			auto_percent: { type: "number", minimum: 0, maximum: 100, default: 0 },
			accrue_on_status: { type: ["integer", "null"], default: null },
		},
	},
	units: {
		type: "object",
		additionalProperties: false,
		properties: {
			weight: { enum: ["kg", "g", "lb", "oz"], default: "kg" },
			length: { enum: ["cm", "mm", "m", "in"], default: "cm" },
		},
	},
	card: {
		type: "object",
		additionalProperties: false,
		properties: {
			default_status: { enum: ["draft", "active"], default: "draft" },
			id_default_attribute_set: { type: ["integer", "null"], default: null },
			required_fields: { type: "array", uniqueItems: true, items: { enum: ["name", "sku", "price", "category", "brand", "image", "description"] }, default: ["name"] },
			per_page: { type: "integer", minimum: 10, maximum: 500, default: 50 },
		},
	},
	seo: {
		type: "object",
		additionalProperties: false,
		properties: {
			title_max: { type: "integer", minimum: 30, maximum: 120, default: 60 },
			description_max: { type: "integer", minimum: 70, maximum: 320, default: 160 },
			// Шаблони: {token}; [ … ] — фрагмент зникає, якщо хоч один токен у ньому порожній
			templates: {
				type: "array",
				maxItems: 300,
				items: {
					type: "object",
					additionalProperties: false,
					required: ["entity", "lang"],
					properties: {
						entity: { enum: ["products", "categories", "brands"] },
						lang: { type: "string", pattern: "^(\\*|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$" },
						meta_title: { type: "string", maxLength: 255, default: "" },
						meta_description: { type: "string", maxLength: 512, default: "" },
						og_title: { type: "string", maxLength: 255, default: "" },
						og_description: { type: "string", maxLength: 512, default: "" },
					},
				},
				default: [
					{ entity: "products", lang: "*", meta_title: "{name}[ — {brand}]", meta_description: "{name}[. {short_description}]", og_title: "", og_description: "" },
					{ entity: "categories", lang: "*", meta_title: "{name}", meta_description: "{name}[. {description}]", og_title: "", og_description: "" },
					{ entity: "brands", lang: "*", meta_title: "{name}", meta_description: "{name}[. {description}]", og_title: "", og_description: "" },
				],
			},
		},
	},
	edit_lock: {
		type: "object",
		additionalProperties: false,
		properties: {
			ttl_seconds: { type: "integer", minimum: 30, maximum: 600, default: 60 },
			heartbeat_seconds: { type: "integer", minimum: 5, maximum: 120, default: 20 },
		},
	},
};

const validators = Object.fromEntries(Object.entries(SCHEMAS).map(([k, s]) => [k, ajv.compile(s)]));

/** Дефолти кожного блоку — з самих схем, щоб не було двох джерел правди */
const DEFAULTS = Object.fromEntries(
	Object.keys(SCHEMAS).map((k) => {
		const obj = {};
		validators[k](obj);
		return [k, obj];
	})
);

function validateSetting(key, value) {
	const v = validators[key];
	if (!v) return { valid: false, errors: [{ field: "key", message: "Unknown settings block" }] };
	const data = JSON.parse(JSON.stringify(value || {}));
	if (!v(data)) {
		return {
			valid: false,
			errors: v.errors.map((e) => ({ field: (e.instancePath || "").replace(/^\//, "").replace(/\//g, ".") || e.params.missingProperty || key, message: e.message, keyword: e.keyword })),
		};
	}
	// Перехресні перевірки
	if (key === "edit_lock" && data.heartbeat_seconds * 2 > data.ttl_seconds) {
		return { valid: false, errors: [{ field: "heartbeat_seconds", message: "must be at most half of ttl_seconds" }] };
	}
	if (key === "seo") {
		const keys = data.templates.map((t) => t.entity + "|" + t.lang.toLowerCase());
		if (new Set(keys).size !== keys.length) return { valid: false, errors: [{ field: "templates", message: "duplicate entity + language" }] };
	}
	if (key === "images") {
		const codes = data.thumbnails.map((t) => t.code);
		if (new Set(codes).size !== codes.length) return { valid: false, errors: [{ field: "thumbnails", message: "duplicate code" }] };
	}
	return { valid: true, data };
}

module.exports = { KEYS: Object.keys(SCHEMAS), DEFAULTS, validateSetting };
