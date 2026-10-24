"use strict";

const Ajv = require("ajv");
const ajv = new Ajv();

const schema = {
    type: "object",
    properties: {
        token: {
            type:      "string",
            minLength: 96,
            maxLength: 96,
        },
        first_name: {
            type:      "string",
            minLength: 1,
            maxLength: 100,
        },
        last_name: {
            type:      "string",
            minLength: 1,
            maxLength: 100,
        },
        patronymic: {
            type:      "string",
            maxLength: 100,
        },
        password: {
            type:      "string",
            minLength: 8,
            maxLength: 255,
        },
        password_confirm: {
            type:      "string",
            minLength: 8,
            maxLength: 255,
        },
    },
    required: ["token", "first_name", "last_name", "password", "password_confirm"],
    additionalProperties: false,
};

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

    // Перевірка співпадіння паролів — ajv не вміє порівнювати поля між собою
    if (data.password !== data.password_confirm) {
        return {
            valid:  false,
            errors: { password_confirm: "passwords_do_not_match" },
        };
    }

    return { valid: true, errors: {} };
};