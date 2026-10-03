"use strict";

const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });
addFormats(ajv, ["date"]);

const MAX_MONEY = 99999999999;
const money = { type: ["number", "null"], minimum: 0, maximum: MAX_MONEY, default: null };
const qty = { type: ["number", "null"], minimum: 0, maximum: 999999999, default: null };
const dim = { type: ["number", "null"], minimum: 0, maximum: 99999999, default: null };
const str = (max, extra = {}) => ({ type: ["string", "null"], maxLength: max, default: null, ...extra });
const id = { type: ["integer", "null"], minimum: 1, default: null };
const bool = (d) => ({ type: "boolean", default: d });
const DATETIME = { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}(:\\d{2})?$", default: null };
const DATE = { type: ["string", "null"], format: "date", default: null };
const IMG = "^[0-9a-f]{2}/[0-9a-f]{64}\\.(webp|avif|jpg|png|gif)$";

const core = ajv.compile({
	type: "object",
	additionalProperties: false,
	properties: {
		type: { enum: ["simple", "variable", "bundle", "digital", "service", "gift_card"], default: "simple" },
		status: { enum: ["draft", "active", "archived"], default: "draft" },
		visibility: { enum: ["all", "catalog", "search", "none"], default: "all" },
		published_at: DATETIME,
		unpublished_at: DATETIME,
		redirect_type: { enum: ["none", "301_product", "302_product", "301_category", "302_category", "404", "410"], default: "none" },
		redirect_target_id: id,

		sku: str(64, { pattern: "^[A-Za-z0-9_\\-./]+$" }),
		model: str(128),
		mpn: str(64),
		ean: str(14, { pattern: "^(\\d{8}|\\d{12,14})$" }),
		upc: str(12, { pattern: "^\\d{12}$" }),
		jan: str(13, { pattern: "^(\\d{8}|\\d{13})$" }),
		isbn: str(17, { pattern: "^(97[89])?\\d{9}[\\dX]$" }),

		id_brand: id,
		id_supplier: id,
		id_category_main: id,
		id_attribute_set: id,
		id_tax_class: id,
		product_type_label: str(128),
		vendor: str(128),
		item_condition: { enum: ["new", "used", "refurbished"], default: "new" },
		show_condition: bool(false),
		is_featured: bool(false),
		on_sale_flag: bool(false),
		online_only: bool(false),
		age_restriction: { type: ["integer", "null"], minimum: 0, maximum: 99, default: null },
		layout_template: str(64, { pattern: "^[a-z0-9_\\-]*$" }),

		price: { type: "number", minimum: 0, maximum: MAX_MONEY, default: 0 },
		compare_at_price: money,
		cost_price: money,
		wholesale_price: money,
		unit_price: money,
		unit_price_unit: str(16),
		unit_price_base: qty,
		ecotax: money,
		points_price: { type: ["integer", "null"], minimum: 0, maximum: 2147483647, default: null },
		show_price: bool(true),
		price_on_request: bool(false),
		available_for_order: bool(true),

		track_inventory: bool(true),
		subtract_stock: bool(true),
		min_qty: { type: "number", exclusiveMinimum: 0, maximum: 999999999, default: 1 },
		max_qty: qty,
		qty_step: { type: "number", exclusiveMinimum: 0, maximum: 999999999, default: 1 },
		low_stock_threshold: qty,
		low_stock_alert: bool(false),
		out_of_stock_action: { enum: ["default", "deny", "backorder", "preorder"], default: "default" },
		id_stock_status: id,
		available_date: DATE,
		preorder_release_date: DATE,
		sold_individually: bool(false),
		pack_stock_mode: { enum: ["pack", "components", "both"], default: "components" },

		requires_shipping: bool(true),
		weight: dim,
		weight_unit: { type: ["string", "null"], enum: [null, "kg", "g", "lb", "oz"], default: null },
		length: dim,
		width: dim,
		height: dim,
		length_unit: { type: ["string", "null"], enum: [null, "cm", "mm", "m", "in"], default: null },
		shipping_class: str(64),
		additional_shipping_cost: money,
		delivery_time_type: { enum: ["none", "default", "custom"], default: "default" },
		hs_code: str(16, { pattern: "^[0-9.]{4,16}$" }),
		country_of_origin: str(2, { pattern: "^[A-Z]{2}$" }),

		gift_card_value: money,
		gift_card_expiry_days: { type: ["integer", "null"], minimum: 1, maximum: 36500, default: null },
		allow_gift_wrap: bool(false),

		internal_note: str(10000),
		sort_order: { type: "integer", default: 0 },
	},
});

const parts = ajv.compile({
	type: "object",
	properties: {
		categories: { type: "array", maxItems: 200, uniqueItems: true, items: { type: "integer", minimum: 1 }, default: [] },
		media: {
			type: "array",
			maxItems: 100,
			default: [],
			items: {
				type: "object",
				additionalProperties: false,
				required: ["file"],
				properties: {
					id: id,
					file: { type: "string", pattern: IMG },
					is_cover: bool(false),
					alt: { type: "object", default: {} },
				},
			},
		},
		attributes: {
			type: "array",
			maxItems: 1000,
			default: [],
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id_attribute"],
				properties: {
					id_attribute: { type: "integer", minimum: 1 },
					value_ids: { type: "array", maxItems: 500, uniqueItems: true, items: { type: "integer", minimum: 1 }, default: [] },
					number: { type: ["number", "null"], default: null },
					date: DATE,
					text: { type: "object", default: {} },
				},
			},
		},
		stock: {
			type: "array",
			maxItems: 1000,
			default: [],
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id_warehouse"],
				properties: {
					id_warehouse: { type: "integer", minimum: 1 },
					on_hand: { type: ["number", "null"], minimum: -999999999, maximum: 999999999, default: null },
					id_location: id,
					reorder_point: qty,
					reorder_qty: qty,
				},
			},
		},
		prices: {
			type: "array",
			maxItems: 500,
			default: [],
			items: {
				type: "object",
				additionalProperties: false,
				required: ["value"],
				properties: {
					kind: { enum: ["special", "tier"], default: "special" },
					id_customer_group: { type: "integer", minimum: 0, default: 0 },
					min_qty: { type: "number", exclusiveMinimum: 0, default: 1 },
					reduction_type: { enum: ["new_price", "fixed", "percent"], default: "new_price" },
					value: { type: "number", minimum: 0, maximum: MAX_MONEY },
					priority: { type: "integer", default: 0 },
					date_start: DATETIME,
					date_end: DATETIME,
				},
			},
		},
		rewards: {
			type: "array",
			maxItems: 100,
			default: [],
			items: {
				type: "object",
				additionalProperties: false,
				required: ["points"],
				properties: {
					id_customer_group: { type: "integer", minimum: 0, default: 0 },
					points: { type: "integer", minimum: 0, maximum: 2147483647 },
				},
			},
		},
		related: {
			type: "array",
			maxItems: 500,
			default: [],
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id_related"],
				properties: {
					id_related: { type: "integer", minimum: 1 },
					type: { enum: ["related", "upsell", "crosssell", "accessory"], default: "related" },
				},
			},
		},
		suppliers: {
			type: "array",
			maxItems: 100,
			default: [],
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id_supplier"],
				properties: {
					id_supplier: { type: "integer", minimum: 1 },
					supplier_sku: str(64),
					supplier_price: money,
					currency: str(3, { pattern: "^[A-Z]{3}$" }),
					lead_time_days: { type: ["integer", "null"], minimum: 0, maximum: 3650, default: null },
					min_order_qty: qty,
					is_default: bool(false),
				},
			},
		},
	},
});

function ajvErrors(validate, prefix = "") {
	return validate.errors.map((e) => ({ field: prefix + ((e.instancePath || "").slice(1).replace(/\//g, ".") || e.params.missingProperty), message: e.message }));
}

function cleanObject(obj) {
	const data = JSON.parse(JSON.stringify(obj || {}));
	for (const k of Object.keys(data)) {
		if (typeof data[k] === "string") data[k] = data[k].trim();
		if (data[k] === "") data[k] = null;
	}
	return data;
}

/** Ядро товару + перехресні перевірки */
function validateCore(body) {
	const data = cleanObject(body);
	if (data.isbn) data.isbn = String(data.isbn).replace(/[-\s]/g, "").toUpperCase();
	if (data.country_of_origin) data.country_of_origin = String(data.country_of_origin).toUpperCase();
	if (!core(data)) return { valid: false, errors: ajvErrors(core) };

	const errors = [];
	if (data.compare_at_price !== null && data.compare_at_price <= data.price) errors.push({ field: "compare_at_price", message: "must be greater than price" });
	if (data.max_qty !== null && data.max_qty < data.min_qty) errors.push({ field: "max_qty", message: "must be greater than or equal to min_qty" });
	if (data.published_at && data.unpublished_at && data.unpublished_at <= data.published_at) errors.push({ field: "unpublished_at", message: "must be later than published_at" });
	if (data.type === "gift_card" && !data.gift_card_value) errors.push({ field: "gift_card_value", message: "required" });
	if (data.redirect_type !== "none" && !["404", "410"].includes(data.redirect_type) && !data.redirect_target_id) errors.push({ field: "redirect_target_id", message: "required" });
	// Цифрові товари й послуги не доставляються
	if (["digital", "service", "gift_card"].includes(data.type)) data.requires_shipping = false;
	return errors.length ? { valid: false, errors } : { valid: true, data };
}

function validateParts(body) {
	const data = JSON.parse(JSON.stringify(body || {}));
	if (!parts(data)) return { valid: false, errors: ajvErrors(parts) };
	const errors = [];

	const covers = data.media.filter((m) => m.is_cover).length;
	if (data.media.length && covers === 0) data.media[0].is_cover = true;
	if (covers > 1) errors.push({ field: "media", message: "only one cover image is allowed" });

	const attrIds = data.attributes.map((a) => a.id_attribute);
	if (new Set(attrIds).size !== attrIds.length) errors.push({ field: "attributes", message: "duplicate attribute" });

	const whIds = data.stock.map((s) => s.id_warehouse);
	if (new Set(whIds).size !== whIds.length) errors.push({ field: "stock", message: "duplicate warehouse" });

	data.prices.forEach((p, i) => {
		if (p.reduction_type === "percent" && p.value > 100) errors.push({ field: `prices.${i}.value`, message: "must be <= 100" });
		if (p.date_start && p.date_end && p.date_end <= p.date_start) errors.push({ field: `prices.${i}.date_end`, message: "must be later than date_start" });
	});

	const relKeys = data.related.map((r) => r.id_related + ":" + r.type);
	if (new Set(relKeys).size !== relKeys.length) errors.push({ field: "related", message: "duplicate related product" });

	const supIds = data.suppliers.map((s) => s.id_supplier);
	if (new Set(supIds).size !== supIds.length) errors.push({ field: "suppliers", message: "duplicate supplier" });
	if (data.suppliers.filter((s) => s.is_default).length > 1) errors.push({ field: "suppliers", message: "only one default supplier" });

	return errors.length ? { valid: false, errors } : { valid: true, data };
}

module.exports = { validateCore, validateParts };