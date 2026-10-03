const Ajv = require("ajv");
const ajv = new Ajv({ allErrors: true, coerceTypes: true, logger: false });

// Тонка схема для швидких замовлень ("Купити в 1 клік").
// Форма НЕ шле source/external_id/дату — їх проставляє CRM.
// Обовʼязкове: хоча б один контакт (phone АБО email) + товар з назвою.
const schemaQuickReceive = {
	type: "object",
	properties: {
		client: {
			type: "object",
			properties: {
				firstname: { type: ["string", "null"], maxLength: 255 },
				lastname: { type: ["string", "null"], maxLength: 255 },
				email: { type: ["string", "null"], maxLength: 255 },
				phone: { type: ["string", "null"], maxLength: 64 },
			},
			anyOf: [
				{ required: ["phone"], properties: { phone: { type: "string", minLength: 3 } } },
				{ required: ["email"], properties: { email: { type: "string", minLength: 3 } } },
			],
			additionalProperties: true,
		},
		items: {
			type: "array",
			minItems: 1,
			maxItems: 50,
			items: {
				type: "object",
				properties: {
					name: { type: "string", minLength: 1, maxLength: 512 },
					external_product_id: { type: ["string", "number", "null"] },
					sku: { type: ["string", "null"], maxLength: 191 },
					quantity: { type: ["number", "null"], minimum: 0 },
					unit_price: { type: ["number", "null"], minimum: 0 },
					total: { type: ["number", "null"], minimum: 0 },
				},
				required: ["name"],
				additionalProperties: true,
			},
		},
		customer_comment: { type: ["string", "null"], maxLength: 2000 },
		utm: { type: ["object", "null"] },
	},
	required: ["client", "items"],
	additionalProperties: true,
};

const validateQuickReceive = ajv.compile(schemaQuickReceive);

module.exports = {
	receiveQuick: (data) => {
		const valid = validateQuickReceive(data);
		return valid ? { valid: true } : { valid: false, errors: validateQuickReceive.errors };
	},
};
