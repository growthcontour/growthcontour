const Ajv = require("ajv");
const ajv = new Ajv({ allErrors: true, coerceTypes: true, logger: false, logger: false });

const FINANCIAL = ["pending", "authorized", "paid", "partially_paid", "partially_refunded", "refunded", "voided"];
const FULFILLMENT = ["unfulfilled", "partial", "fulfilled", "returned"];
const money = { type: "number" };

const addressSchema = {
	type: "object",
	properties: {
		type: { type: "string", enum: ["billing", "shipping"] },
		firstname: { type: ["string", "null"], maxLength: 255 },
		lastname: { type: ["string", "null"], maxLength: 255 },
		middlename: { type: ["string", "null"], maxLength: 255 },
		company: { type: ["string", "null"], maxLength: 255 },
		phone: { type: ["string", "null"], maxLength: 64 },
		email: { type: ["string", "null"], maxLength: 255 },
		country: { type: ["string", "null"], maxLength: 2 },
		region: { type: ["string", "null"], maxLength: 255 },
		city: { type: ["string", "null"], maxLength: 255 },
		city_ref: { type: ["string", "null"], maxLength: 64 },
		address_1: { type: ["string", "null"], maxLength: 512 },
		address_2: { type: ["string", "null"], maxLength: 512 },
		warehouse: { type: ["string", "null"], maxLength: 255 },
		warehouse_ref: { type: ["string", "null"], maxLength: 64 },
		postcode: { type: ["string", "null"], maxLength: 32 },
		meta: { type: ["object", "null"] },
	},
	required: ["type"],
	additionalProperties: true,
};

const itemSchema = {
	type: "object",
	properties: {
		external_product_id: { type: ["string", "number", "null"] },
		sku: { type: ["string", "null"], maxLength: 191 },
		name: { type: "string", minLength: 1, maxLength: 512 },
		type: { type: ["string", "null"], maxLength: 64 },
		quantity: { type: "number", minimum: 0 },
		unit_price: money,
		unit_price_wt: { type: ["number", "null"] },
		discount: { type: ["number", "null"] },
		tax_rate: { type: ["number", "null"] },
		total: money,
		attributes: { type: ["object", "null"] },
		meta: { type: ["object", "null"] },
	},
	required: ["name", "quantity", "unit_price", "total"],
	additionalProperties: true,
};

const schemaReceive = {
	type: "object",
	properties: {
		source: {
			type: "object",
			properties: {
				id_integration: { type: ["integer", "null"] },
				channel: { type: ["string", "null"], maxLength: 64 },
				external_id: { type: ["string", "number"] },
				external_number: { type: ["string", "number", "null"] },
				external_cart_id: { type: ["string", "number", "null"] },
				secure_key: { type: ["string", "null"], maxLength: 64 },
				date_order: { type: ["string", "null"] },
			},
			required: ["external_id"],
			additionalProperties: true,
		},
		currency: {
			type: "object",
			properties: {
				iso: { type: "string", minLength: 3, maxLength: 3 },
				rate: { type: "number", exclusiveMinimum: 0 },
			},
			additionalProperties: true,
		},
		status: {
			type: "object",
			properties: {
				financial_status: { type: "string", enum: FINANCIAL },
				fulfillment_status: { type: "string", enum: FULFILLMENT },
			},
			additionalProperties: true,
		},
		client: {
			type: "object",
			properties: {
				firstname: { type: ["string", "null"], maxLength: 255 },
				lastname: { type: ["string", "null"], maxLength: 255 },
				email: { type: ["string", "null"], maxLength: 255 },
				phone: { type: ["string", "null"], maxLength: 64 },
				company: { type: ["string", "null"], maxLength: 255 },
				vat: { type: ["string", "null"], maxLength: 64 },
			},
			additionalProperties: true,
		},
		addresses: { type: "array", items: addressSchema, maxItems: 10 },
		items: { type: "array", items: itemSchema, maxItems: 500 },
		totals: {
			type: "array",
			maxItems: 50,
			items: {
				type: "object",
				properties: {
					code: { type: "string", maxLength: 32 },
					title: { type: "string", maxLength: 255 },
					value: money,
					sort_order: { type: ["integer", "null"] },
				},
				required: ["code", "value"],
				additionalProperties: true,
			},
		},
		summary: { type: ["object", "null"] },
		payment: { type: ["object", "null"] },
		delivery: { type: ["object", "null"] },
		payments: {
			type: "array",
			maxItems: 50,
			items: {
				type: "object",
				properties: {
					transaction_id: { type: ["string", "null"], maxLength: 191 },
					amount: money,
					currency_iso: { type: ["string", "null"], minLength: 3, maxLength: 3 },
					status: { type: ["string", "null"], enum: ["pending", "authorized", "paid", "failed", "refunded", "partially_refunded", null] },
					paid_at: { type: ["string", "null"] },
					raw: { type: ["object", "null"] },
				},
				required: ["amount"],
				additionalProperties: true,
			},
		},
		fees: {
			type: "array",
			maxItems: 50,
			items: {
				type: "object",
				properties: {
					type: { type: ["string", "null"], maxLength: 64 },
					title: { type: ["string", "null"], maxLength: 255 },
					amount: money,
				},
				required: ["amount"],
				additionalProperties: true,
			},
		},
		discounts: {
			type: "array",
			maxItems: 50,
			items: {
				type: "object",
				properties: {
					code: { type: ["string", "null"], maxLength: 191 },
					name: { type: ["string", "null"], maxLength: 255 },
					title: { type: ["string", "null"], maxLength: 255 },
					type: { type: ["string", "null"], maxLength: 32 },
					value: money,
				},
				required: ["value"],
				additionalProperties: true,
			},
		},
		note: { type: ["string", "null"] },
		is_gift: { type: ["boolean", "integer", "null"] },
		gift_message: { type: ["string", "null"] },
		custom_fields: { type: ["object", "null"] },
		meta: { type: ["object", "null"] },
		raw: {},
	},
	required: ["source"],
	additionalProperties: true,
};

const validateReceive = ajv.compile(schemaReceive);

module.exports = {
	receive: (data) => {
		const valid = validateReceive(data);
		return valid ? { valid: true } : { valid: false, errors: validateReceive.errors };
	},
};
