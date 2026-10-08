"use strict";

const Ajv = require("ajv");
const ajv = new Ajv();

const schema = {
    type: "object",
    properties: {
        last_name: {
            type:      "string",
            minLength: 1,
            maxLength: 100,
        },
        first_name: {
            type:      "string",
            minLength: 1,
            maxLength: 100,
        },
        patronymic: {
            type:      "string",
            maxLength: 100,
        },
        email: {
            type:      "string",
            format:    "email",
            maxLength: 255,
        },
        password: {
            type:      "string",
            minLength: 8,
            maxLength: 255,
        },
        id_group: {
            type: ["string", "integer", "null"],
        },
        send_email: {
            type: ["string", "integer", "null"],
        },
    },
    required: ["last_name", "first_name", "email", "password"],
    additionalProperties: false,
};

// Потрібен ajv-formats для перевірки format: "email"
const addFormats = require("ajv-formats");
addFormats(ajv);

const validate = ajv.compile(schema);

module.exports = (data) => {
    const valid = validate(data);
    if (!valid) {
        const errors = {};
        for (const error of validate.errors) {
            const field = error.instancePath.replace("/", "") || error.params?.missingProperty;
            if (field && !errors[field]) {
                errors[field] = error.message;
            }
        }
        return { valid: false, errors };
    }
    return { valid: true, errors: {} };
};