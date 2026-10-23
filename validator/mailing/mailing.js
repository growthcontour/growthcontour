"use strict";
/**
 * Валідатор розсилок (AJV).
 * Повертає { valid, data, errors: [{ field, message }] }, де message — ключ перекладу mailing.validation.*
 * Невідомі поля відкидаються (removeAdditional), типи приводяться (coerceTypes), значення за замовчуванням підставляються.
 */
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true, coerceTypes: true, removeAdditional: "all", useDefaults: true });
addFormats(ajv, ["email", "date", "date-time", "uri"]);

// ─── СПІЛЬНІ ТИПИ ───────────────────────────────────────
const id = { type: "integer", minimum: 1, maximum: 4294967295 };
const idOrNull = { type: ["integer", "null"], minimum: 1, maximum: 4294967295 };
const ids = { type: "array", items: id, maxItems: 500, uniqueItems: true };
const bool = { type: "boolean" };
const str = (max, min = 0) => ({ type: "string", minLength: min, maxLength: max });
const strOrNull = (max) => ({ type: ["string", "null"], maxLength: max });
const email = { type: "string", format: "email", maxLength: 254 };
const emailOrNull = { anyOf: [{ type: "string", format: "email", maxLength: 254 }, { type: "string", maxLength: 0 }, { type: "null" }] };
const host = { type: "string", minLength: 3, maxLength: 255, pattern: "^[A-Za-z0-9.-]+$" };
const hostOrNull = { anyOf: [host, { type: "string", maxLength: 0 }, { type: "null" }] };
const port = { type: "integer", minimum: 1, maximum: 65535 };
const datetime = { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}(:\\d{2})?$" };
const langMap = (inner) => ({ type: "object", propertyNames: { pattern: "^[0-9]{1,3}$" }, additionalProperties: inner, maxProperties: 50 });

// ─── СХЕМИ ──────────────────────────────────────────────
const schemas = {
	sender: {
		type: "object",
		required: ["name", "from_name", "from_email"],
		properties: {
			name: str(128, 1),
			provider: { type: "string", enum: ["smtp", "gmail"], default: "smtp" },
			from_name: str(128, 1),
			from_email: email,
			reply_to: emailOrNull,
			company_address: strOrNull(512),
			smtp_host: hostOrNull,
			smtp_port: port,
			smtp_secure: bool,
			smtp_user: strOrNull(255),
			smtp_pass: strOrNull(512),
			smtp_max_connections: { type: "integer", minimum: 1, maximum: 10, default: 3 },
			bounce_address: emailOrNull,
			dkim_selector: { type: ["string", "null"], maxLength: 63, pattern: "^$|^[A-Za-z0-9][A-Za-z0-9._-]*$" },
			imap_host: hostOrNull,
			imap_port: { type: ["integer", "null"], minimum: 1, maximum: 65535 },
			imap_user: strOrNull(255),
			imap_pass: strOrNull(512),
			imap_mailbox: { type: ["string", "null"], maxLength: 128, pattern: "^[^\\r\\n\\u0000]*$" },
			rate_per_minute: { type: "integer", minimum: 1, maximum: 10000, default: 60 },
			daily_limit: { type: "integer", minimum: 0, maximum: 10000000, default: 0 },
			warmup_start: { anyOf: [{ type: "string", format: "date" }, { type: "string", maxLength: 0 }, { type: "null" }] },
			domain_limits: { type: "object", propertyNames: { pattern: "^[a-z0-9.-]{3,253}$" }, additionalProperties: { type: "integer", minimum: 1, maximum: 10000 }, maxProperties: 50 },
			is_default: bool,
			active: { type: "boolean", default: true },
		},
		// Для SMTP-провайдера сервер і логін обовʼязкові
		if: { properties: { provider: { const: "smtp" } } },
		then: { required: ["smtp_host", "smtp_port", "smtp_user"], properties: { smtp_host: host, smtp_user: str(255, 1) } },
	},

	senderTest: {
		type: "object",
		properties: { to: emailOrNull },
	},

	list: {
		type: "object",
		required: ["code", "lang"],
		properties: {
			code: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9_-]+$" },
			is_public: { type: "boolean", default: true },
			double_optin: { type: "boolean", default: true },
			sort_order: { type: "integer", minimum: -100000, maximum: 100000, default: 0 },
			active: { type: "boolean", default: true },
			lang: langMap({ type: "object", properties: { name: str(128), description: strOrNull(512) } }),
		},
	},

	field: {
		type: "object",
		required: ["code", "name"],
		properties: {
			code: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]*$" },
			name: str(128, 1),
			type: { type: "string", enum: ["text", "number", "date", "bool"], default: "text" },
		},
	},

	settings: {
		type: "object",
		properties: {
			default_timezone: str(64, 1),
			default_id_lang: id,
			frequency_cap: { type: "object", properties: { count: { type: "integer", minimum: 0, maximum: 100 }, days: { type: "integer", minimum: 1, maximum: 365 } } },
			soft_bounce_limit: { type: "integer", minimum: 1, maximum: 20 },
			sunset_days: { type: "integer", minimum: 0, maximum: 3650 },
			double_optin_ttl_days: { type: "integer", minimum: 1, maximum: 90 },
			clients_sync: { type: "object", properties: { enabled: bool, id_list: idOrNull } },
		},
	},

	contact: {
		type: "object",
		required: ["email"],
		properties: {
			email,
			first_name: strOrNull(128),
			last_name: strOrNull(128),
			id_lang: idOrNull,
			timezone: strOrNull(64),
			country: { type: ["string", "null"], pattern: "^$|^[A-Za-z]{2}$" },
			fields: { type: "object", propertyNames: { pattern: "^[a-z][a-z0-9_]{0,63}$" }, additionalProperties: { type: ["string", "number", "boolean", "null"], maxLength: 1000 }, maxProperties: 100 },
			lists: ids,
		},
	},

	subscriptions: {
		type: "object",
		required: ["lists"],
		properties: { lists: ids },
	},

	suppression: {
		type: "object",
		required: ["type", "value"],
		properties: {
			type: { type: "string", enum: ["email", "domain"] },
			value: str(254, 3),
			note: strOrNull(512),
		},
	},

	template: {
		type: "object",
		required: ["name"],
		properties: { name: str(255, 1) },
	},

	content: {
		type: "object",
		required: ["owner_type", "id_owner", "id_lang"],
		properties: {
			owner_type: { type: "string", enum: ["template", "variant"] },
			id_owner: id,
			id_lang: id,
			subject: { type: "string", maxLength: 255, default: "" },
			preheader: strOrNull(255),
			source: { type: "string", maxLength: 2 * 1024 * 1024, default: "" },
		},
	},

	compile: {
		type: "object",
		required: ["source"],
		properties: {
			source: { type: "string", maxLength: 2 * 1024 * 1024 },
		},
	},

	campaign: {
		type: "object",
		required: ["name"],
		properties: {
			name: str(255, 1),
			type: { type: "string", enum: ["regular", "ab", "resend"], default: "regular" },
			id_sender: idOrNull,
			id_parent: idOrNull,
			audience: {
				type: "object",
				properties: {
					lists: ids,
					exclude_lists: ids,
					exclude_campaigns: ids,
					resend_of: idOrNull,
					resend_mode: { type: "string", enum: ["not_opened", "not_clicked"] },
					exclude_role: bool,
					ignore_sunset: bool,
					// Структуру правил перевіряє audience.js (білий список полів/операторів)
					segment: { type: ["object", "null"] },
				},
			},
			send_mode: { type: "string", enum: ["now", "scheduled", "timezone"], default: "now" },
			date_scheduled: datetime,
			ab_percent: { type: ["integer", "null"], minimum: 5, maximum: 50 },
			ab_metric: { type: ["string", "null"], enum: ["open", "click", null] },
			ab_wait_minutes: { type: ["integer", "null"], minimum: 30, maximum: 10080 },
			track_opens: { type: "boolean", default: true },
			track_clicks: { type: "boolean", default: true },
			utm: {
				type: ["object", "null"],
				properties: {
					source: strOrNull(100),
					medium: strOrNull(100),
					campaign: strOrNull(100),
					content: strOrNull(100),
					term: strOrNull(100),
				},
			},
			ignore_frequency_cap: bool,
			variants: {
				type: "array",
				maxItems: 4,
				items: { type: "object", required: ["code"], properties: { id: idOrNull, code: { type: "string", enum: ["A", "B", "C", "D"] }, from_name: strOrNull(128) } },
			},
		},
	},

	automation: {
		type: "object",
		required: ["name"],
		properties: {
			name: str(255, 1),
			id_sender: idOrNull,
			trigger_type: { type: "string", enum: ["list_subscribe", "date_field", "inactive", "manual"], default: "list_subscribe" },
			// Ключі та межі нормалізує automations.js
			trigger_config: {
				type: ["object", "null"],
				properties: {
					id_list: idOrNull,
					field: { type: ["string", "null"], maxLength: 64, pattern: "^[a-z][a-z0-9_]*$" },
					offset_days: { type: "integer", minimum: -60, maximum: 60 },
					days: { type: "integer", minimum: 7, maximum: 3650 },
					hour: { type: "integer", minimum: 0, maximum: 23 },
				},
			},
			audience: {
				type: ["object", "null"],
				properties: {
					lists: ids,
					exclude_lists: ids,
					exclude_role: bool,
					segment: { type: ["object", "null"] }, // правила перевіряє audience.js
				},
			},
			goal: { type: ["object", "null"] }, // правила перевіряє audience.js
			track_opens: { type: "boolean", default: true },
			track_clicks: { type: "boolean", default: true },
			utm: {
				type: ["object", "null"],
				properties: { source: strOrNull(100), medium: strOrNull(100), campaign: strOrNull(100), content: strOrNull(100), term: strOrNull(100) },
			},
			include_existing: bool,
			allow_reentry: bool,
			reentry_days: { type: "integer", minimum: 0, maximum: 3650, default: 0 },
			steps: {
				type: "array",
				maxItems: 30,
				items: {
					type: "object",
					required: ["type"],
					properties: {
						id: idOrNull,
						type: { type: "string", enum: ["email", "wait", "condition"] },
						copy_from: idOrNull, // id варіанта email-кроку цієї ж автоматизації
						config: {
							type: ["object", "null"],
							properties: {
								amount: { type: "integer", minimum: 1, maximum: 10080 },
								unit: { type: "string", enum: ["minutes", "hours", "days"] },
								check: { type: "string", enum: ["opened", "clicked", "segment"] },
								ref_index: { type: ["integer", "null"], minimum: 0, maximum: 29 },
								segment: { type: ["object", "null"] },
								if_true: { type: "string", enum: ["continue", "exit"] },
								if_false: { type: "string", enum: ["continue", "exit"] },
							},
						},
					},
				},
			},
		},
	},

	testSend: {
		type: "object",
		required: ["emails"],
		properties: {
			emails: { type: "array", minItems: 1, maxItems: 5, items: email },
			id_variant: idOrNull,
			id_lang: idOrNull,
			id_contact: idOrNull, // превʼю «очима» конкретного контакту
		},
	},

	audience: {
		type: "object",
		required: ["audience"],
		properties: { audience: { $ref: "#/definitions/audienceObj" } },
		definitions: {},
	},

	grid: {
		type: "object",
		properties: {
			page: { type: "integer", minimum: 1, maximum: 100000, default: 1 },
			size: { type: "integer", minimum: 1, maximum: 100, default: 20 },
			sort: { type: "array", maxItems: 3, items: { type: "object", properties: { field: str(64), dir: { type: "string", enum: ["asc", "desc"] } } } },
			search: { type: "string", maxLength: 100, default: "" },
			status: { type: "string", maxLength: 32, default: "" },
			id_list: idOrNull,
			id_import: idOrNull,
			source: { type: "string", maxLength: 32, default: "" },
			filter: { type: "string", maxLength: 32, default: "" },
		},
	},
};

// audience для підрахунку — та ж структура, що й у кампанії
schemas.audience.definitions.audienceObj = schemas.campaign.properties.audience;

const compiled = Object.fromEntries(Object.entries(schemas).map(([k, s]) => [k, ajv.compile(s)]));

function mapErrors(errors) {
	const out = [];
	const seen = new Set();
	for (const e of errors || []) {
		if (["if", "anyOf"].includes(e.keyword)) continue;
		let field = String(e.instancePath || "")
			.replace(/^\//, "")
			.replace(/\//g, ".");
		if (e.keyword === "required") field = (field ? field + "." : "") + e.params.missingProperty;
		field = field || "body";
		if (seen.has(field)) continue;
		seen.add(field);
		const map = { required: "required", format: "invalid", pattern: "invalid", enum: "invalid", type: "invalid", minLength: "required", maxLength: "too_long", minimum: "too_small", maximum: "too_large", maxItems: "too_many", minItems: "required", uniqueItems: "invalid", maxProperties: "too_many" };
		out.push({ field, message: map[e.keyword] || "invalid" });
	}
	return out;
}

/** v(name, body) → { valid, data, errors } — data є очищеною копією (зайві поля видалено) */
function v(name, body) {
	const fn = compiled[name];
	if (!fn) throw new Error("unknown schema " + name);
	if (!body || typeof body !== "object" || Array.isArray(body)) return { valid: false, data: null, errors: [{ field: "body", message: "invalid" }] };
	const data = JSON.parse(JSON.stringify(body)); // копія: AJV змінює обʼєкт (defaults/coerce/remove)
	const ok = fn(data);
	return ok ? { valid: true, data, errors: null } : { valid: false, data: null, errors: mapErrors(fn.errors) };
}

module.exports = { v, schemas };