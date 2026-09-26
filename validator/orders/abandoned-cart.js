const Ajv = require("ajv");
const ajv = new Ajv({ allErrors: true, coerceTypes: true, logger: false });

const money = { type: "number" };

const cartItemSchema = {
	type: "object",
	properties: {
		product_id: { type: ["string", "number", "null"] },
		sku: { type: ["string", "null"], maxLength: 191 },
		name: { type: "string", minLength: 1, maxLength: 512 },
		quantity: { type: "number", minimum: 0 },
		price: money,
		total: { type: ["number", "null"] },
		options: { type: ["object", "null"] },
		image_url: { type: ["string", "null"], maxLength: 1024 },
		product_url: { type: ["string", "null"], maxLength: 1024 },
		recurring: { type: ["boolean", "null"] },
		meta: { type: ["object", "null"] },
	},
	required: ["name", "quantity"],
	additionalProperties: true,
};

const schemaReceiveCart = {
	type: "object",
	properties: {
		source: {
			type: "object",
			properties: {
				id_integration: { type: ["integer", "null"] },
				store_id: { type: ["integer", "string"] },
				session_id: { type: "string", minLength: 1, maxLength: 128 },
				external_cart_id: { type: ["string", "number", "null"] },
				channel: { type: ["string", "null"], maxLength: 64 },
			},
			required: ["store_id", "session_id"],
			additionalProperties: true,
		},
		customer: {
			type: "object",
			properties: {
				customer_id: { type: ["integer", "string", "null"] },
				firstname: { type: ["string", "null"], maxLength: 255 },
				lastname: { type: ["string", "null"], maxLength: 255 },
				email: { type: ["string", "null"], maxLength: 255 },
				phone: { type: ["string", "null"], maxLength: 64 },
				telephone: { type: ["string", "null"], maxLength: 64 },
			},
			additionalProperties: true,
		},
		currency: {
			anyOf: [
				{ type: "string", minLength: 3, maxLength: 3 },
				{
					type: "object",
					properties: {
						iso: { type: "string", minLength: 3, maxLength: 3 },
						rate: { type: "number", exclusiveMinimum: 0 },
					},
					additionalProperties: true,
				},
				{ type: "null" },
			],
		},
		items: { type: "array", items: cartItemSchema, maxItems: 500 },
		totals: {
			type: "object",
			properties: {
				total_amount: money,
				items_count: { type: ["integer", "number", "null"], minimum: 0 },
			},
			additionalProperties: true,
		},
		context: {
			type: "object",
			properties: {
				ip: { type: ["string", "null"], maxLength: 45 },
				user_agent: { type: ["string", "null"], maxLength: 512 },
				first_seen_at: { type: ["string", "null"] },
				last_activity_at: { type: ["string", "null"] },
			},
			additionalProperties: true,
		},
		utm: {
			type: ["object", "null"],
			properties: {
				source: { type: ["string", "null"], maxLength: 100 },
				medium: { type: ["string", "null"], maxLength: 100 },
				campaign: { type: ["string", "null"], maxLength: 100 },
			},
			additionalProperties: true,
		},
		meta: { type: ["object", "null"] },
	},
	required: ["source"],
	additionalProperties: true,
};

const validateReceiveCart = ajv.compile(schemaReceiveCart);

module.exports = {
	receive: (data) => {
		const valid = validateReceiveCart(data);
		return valid ? { valid: true } : { valid: false, errors: validateReceiveCart.errors };
	},
};
