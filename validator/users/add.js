"use strict";

const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const ajv = new Ajv({ allErrors: true, logger: false });
addFormats(ajv);

// ─── Схема додавання користувача ─────────────────────────────────────────
const schemaAdd = {
	type: "object",
	properties: {
		last_name: { type: "string", minLength: 1, maxLength: 64 },
		first_name: { type: "string", minLength: 1, maxLength: 64 },
		patronymic: { type: "string", maxLength: 64 },
		email: { type: "string", minLength: 1, maxLength: 128, format: "email" },
		password: { type: "string", minLength: 8, maxLength: 128 },

		// Обробляються в роуті окремо (parseInt / порівняння), тут — лише допуск
		id_group: { type: ["string", "integer", "null"] },
	},
	required: ["last_name", "first_name", "email"],
	additionalProperties: false, // будь-яке зайве поле — помилка
};

const validateAddSchema = ajv.compile(schemaAdd);

// ─── Мапа: (поле → keyword → суфікс ключа перекладу) ──────────────────────
const MESSAGE_MAP = {
	last_name: { minLength: "last_name_required", maxLength: "last_name_max", type: "last_name_required" },
	first_name: { minLength: "first_name_required", maxLength: "first_name_max", type: "first_name_required" },
	patronymic: { maxLength: "patronymic_max" },
	email: { minLength: "email_required", format: "email_invalid", maxLength: "email_max", type: "email_required" },
	password: { minLength: "password_min", maxLength: "password_max", type: "password_required" },
};

// Менше число = вищий пріоритет (дедуп однієї помилки на поле)
const KEYWORD_PRIORITY = { required: 0, type: 1, minLength: 2, format: 3, maxLength: 4 };

function validateAdd(body, __, opts = {}) {
	const requirePassword = opts.requirePassword !== false; // default true

	// У режимі інвайту пароль не потрібен — прибираємо його з перевірки
	const dataToCheck = requirePassword ? body : { ...body, password: undefined };

	if (validateAddSchema(dataToCheck)) {
		return { valid: true, errors: [] };
	}

	const best = new Map(); // field -> { key, priority }

	for (const err of validateAddSchema.errors) {
		const keyword = err.keyword;
		const field = keyword === "required" ? err.params.missingProperty : err.instancePath.slice(1); // прибираємо провідний '/'

		const suffix = keyword === "required" ? `${field}_required` : MESSAGE_MAP[field]?.[keyword];

		if (!suffix) continue; // помилки по id_group/send_email не показуємо

		const priority = KEYWORD_PRIORITY[keyword] ?? 99;
		const current = best.get(field);
		if (!current || priority < current.priority) {
			best.set(field, { key: `users.add.${suffix}`, priority });
		}
	}

	// Пароль вимагається лише поза режимом інвайту.
	// Схема його в required не тримає, тому перевіряємо тут вручну.
	if (requirePassword && !best.has("password")) {
		const pwd = (body.password || "").trim();
		if (!pwd) {
			best.set("password", { key: "users.add.password_required", priority: 0 });
		} else if (pwd.length < 8) {
			best.set("password", { key: "users.add.password_min", priority: 2 });
		} else if (pwd.length > 128) {
			best.set("password", { key: "users.add.password_max", priority: 4 });
		}
	}

	const errors = [...best.entries()].map(([field, v]) => ({
		field,
		msg: __(v.key),
	}));

	return { valid: errors.length === 0, errors };
}

module.exports = validateAdd;
