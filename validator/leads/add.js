const Ajv = require("ajv");
const ajv = new Ajv();

const schema = {
    type: "object",
    properties: {
        title: { type: "string", minLength: 1, maxLength: 999 },
        status: { type: "string", pattern: "^\\d+$" },
        note: { type: "string", maxLength: 999 },
        value: { type: "string", pattern: "^\\d+(\\.\\d{1,2})?$" },
        priority: { type: "string", pattern: "^\\d+$" },
        lead_source: { type: "string", maxLength: 999 },
        website: { type: "string", maxLength: 999, },
        tags: { type: "array", items: { type: "string" } },
        contact_info: {
            type: "object",
            properties: {
                id_user: { type: "string" },
                first_name: { type: "string" },
                last_name: { type: "string" },
                patronymic: { type: "string" },
                email: { type: "string", },
                phone: { type: "string" }
            },
            additionalProperties: false
        },
        utm: {
            type: "object",
            properties: {
                utm_source: { type: "string" },
                utm_medium: { type: "string" },
                utm_campaign: { type: "string" },
                utm_term: { type: "string" },
                utm_content: { type: "string" }
            },
            additionalProperties: false
        },
        custom_fields: {
            type: "object",
            additionalProperties: { type: "string" }
        }
    },
    required: ["title"], // Обов`язкові поля
    additionalProperties: false
};

const validate = ajv.compile(schema);

module.exports = (data) => {
    const valid = validate(data);
    if (!valid) {
        return { valid: false, errors: validate.errors };
    }
    return { valid: true };
};