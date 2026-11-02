/**
 * ===================================================================
 * ФАЙЛ: validators/authorization/login.js
 * ОПИС: AJV схема валідації для входу
 * ЗАХИСТ: Mass Assignment, XSS, Injection
 * ===================================================================
 */

const Ajv = require("ajv").default;
const addFormats = require("ajv-formats");

const ajv = new Ajv({
	allErrors: true,
	strict: true,
	allowUnionTypes: true, // Дозволяємо union-типи (напр. backup: string|boolean)
	coerceTypes: false, // Не приводити типи автоматично
	removeAdditional: false, // Не видаляти додаткові поля (ми їх відхиляємо)
});

addFormats(ajv);

const loginSchema = {
	type: "object",
	required: ["email", "password"],
	additionalProperties: false, // Заборона будь-яких зайвих полів
	properties: {
		email: {
			type: "string",
			minLength: 1, // не порожнє; точну відповідність перевіряє пошук у БД
			maxLength: 255,
		},
		password: {
			type: "string",
			minLength: 1, // на вході перевіряємо ЛИШЕ що поле не порожнє;
			maxLength: 256, // складність пароля — справа реєстрації, не входу
		},
		two_factor_code: {
			type: ["string", "null"],
			// 6 цифр (TOTP) АБО 10 символів A-Z0-9 (backup-код)
			pattern: "^(\\d{6}|[A-Za-z0-9]{10})$",
			minLength: 6,
			maxLength: 10,
		},
		remember_me: {
			type: "boolean",
			default: false,
		},
		backup: {
			type: ["string", "boolean", "null"],
		},
	},
};

const validateLogin = ajv.compile(loginSchema);

function validateLoginInput(data) {
	if (!data || typeof data !== "object") {
		return {
			valid: false,
			errors: [{ field: "body", message: "Request body must be a valid JSON object" }],
		};
	}

	const valid = validateLogin(data);

	if (!valid) {
		const formattedErrors = validateLogin.errors.map((err) => {
			// Для required-помилок ім'я поля лежить у params.missingProperty,
			// а не в instancePath (той порожній). Інакше беремо з instancePath.
			let field = err.instancePath.substring(1);
			if (!field && err.keyword === "required" && err.params?.missingProperty) {
				field = err.params.missingProperty;
			}
			if (!field) field = "root";
			return {
				field,
				message: err.message === "must NOT have additional properties" ? "Unknown field provided" : err.message,
				keyword: err.keyword,
			};
		});
		return { valid: false, errors: formattedErrors };
	}

	return { valid: true, errors: null };
}

module.exports = {
	validateLoginInput,
	validateLogin,
	loginSchema,
};
