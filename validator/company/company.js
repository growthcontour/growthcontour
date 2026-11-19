"use strict";

/**
 * Структура компанії: офіси, відділи, робочі й регіональні дані користувача.
 * Часові пояси — IANA (Intl), формати — BCP 47, телефони — E.164, країна — ISO 3166-1 alpha-2.
 */
const Ajv = require("ajv");
const { normalizePhone } = require("../catalog/products/warehouses");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });

const str = (max, extra = {}) => ({ type: ["string", "null"], maxLength: max, default: null, ...extra });
const CODE = "^[A-Za-z0-9_\\-]+$";
const TIME = "^([01]\\d|2[0-3]):[0-5]\\d$";
const DATE = "^\\d{4}-\\d{2}-\\d{2}$";

// Дні тижня ISO 8601: 1 — понеділок … 7 — неділя; до 3 проміжків на день (наприклад, з перервою)
const DAYS = ["1", "2", "3", "4", "5", "6", "7"];
const interval = { type: "array", minItems: 2, maxItems: 2, items: { type: "string", pattern: TIME } };
const workHours = {
	type: "object",
	additionalProperties: false,
	properties: Object.fromEntries(DAYS.map((d) => [d, { type: "array", maxItems: 3, items: interval, default: [] }])),
	default: {},
};

const office = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["name", "timezone"],
	properties: {
		name: { type: "string", minLength: 1, maxLength: 255 },
		code: str(32, { pattern: CODE }),
		country: str(2, { pattern: "^[A-Z]{2}$" }),
		city: str(128),
		address: str(512),
		postcode: str(16),
		phone: str(32),
		email: str(255),
		timezone: { type: "string", minLength: 1, maxLength: 64 },
		work_hours: workHours,
		holidays: {
			type: "array",
			maxItems: 366,
			default: [],
			items: {
				type: "object",
				additionalProperties: false,
				required: ["date", "name"],
				properties: {
					date: { type: "string", pattern: DATE },
					name: { type: "string", minLength: 1, maxLength: 255 },
					recurring: { type: "boolean", default: false },
				},
			},
		},
		status: { type: "boolean", default: true },
		sort_order: { type: "integer", minimum: -100000, maximum: 100000, default: 0 },
	},
});

const department = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["name"],
	properties: {
		name: { type: "string", minLength: 1, maxLength: 255 },
		code: str(32, { pattern: CODE }),
		description: str(1000),
		id_parent: { type: ["integer", "null"], minimum: 1, default: null },
		id_head: { type: ["integer", "null"], minimum: 1, default: null },
		offices: { type: "array", maxItems: 500, default: [], items: { type: "integer", minimum: 1 } },
		status: { type: "boolean", default: true },
		sort_order: { type: "integer", minimum: -100000, maximum: 100000, default: 0 },
	},
});

// Робочі дані (змінює той, хто має право редагувати користувачів)
const work = ajv.compile({
	type: "object",
	additionalProperties: false,
	properties: {
		id_office: { type: ["integer", "null"], minimum: 1, default: null },
		id_department: { type: ["integer", "null"], minimum: 1, default: null },
		position: str(128),
		id_manager: { type: ["integer", "null"], minimum: 1, default: null },
	},
});

// Регіональні налаштування (змінює й сам користувач). null — за офісом / мовою інтерфейсу
const regional = ajv.compile({
	type: "object",
	additionalProperties: false,
	properties: {
		timezone: str(64),
		locale: str(16, { pattern: "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$" }),
		hour12: { type: ["boolean", "null"], default: null },
	},
});

// Перевіряємо через сам Intl: список supportedValuesOf містить лише канонічні назви
// (у деяких збірках ICU — «Europe/Kiev» замість «Europe/Kyiv»), а псевдоніми теж дійсні
const isTimezone = (tz) => {
	if (typeof tz !== "string" || !tz || tz.length > 64) return false;
	try {
		new Intl.DateTimeFormat("en", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
};

const isLocale = (loc) => {
	try {
		return Intl.DateTimeFormat.supportedLocalesOf([loc]).length === 1;
	} catch {
		return false;
	}
};

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function clean(body) {
	const data = JSON.parse(JSON.stringify(body && typeof body === "object" ? body : {}));
	for (const k of Object.keys(data)) {
		if (typeof data[k] === "string") data[k] = data[k].trim();
		if (data[k] === "") data[k] = null;
	}
	return data;
}

function ajvErrors(validate) {
	return validate.errors.map((e) => ({ field: (e.instancePath || "").slice(1).split("/")[0] || e.params.missingProperty, message: e.message }));
}

const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function validateOffice(body) {
	const data = clean(body);
	if (data.country) data.country = String(data.country).toUpperCase();
	if (data.code) data.code = String(data.code).toUpperCase();
	if (data.email) data.email = String(data.email).toLowerCase();
	if (!office(data)) return { valid: false, errors: ajvErrors(office) };

	const errors = [];
	if (!isTimezone(data.timezone)) errors.push({ field: "timezone", message: "unknown_timezone" });
	if (data.email && !isEmail(data.email)) errors.push({ field: "email", message: "invalid_email" });

	const phone = normalizePhone(data.phone, data.country);
	if (!phone.ok) errors.push({ field: "phone", message: phone.message });
	else data.phone = phone.value;

	// Проміжки: початок < кінця, без перетинів, за зростанням
	for (const d of DAYS) {
		const list = (data.work_hours[d] || []).slice().sort((a, b) => toMinutes(a[0]) - toMinutes(b[0]));
		for (let i = 0; i < list.length; i++) {
			if (toMinutes(list[i][0]) >= toMinutes(list[i][1])) errors.push({ field: "work_hours", message: "start_before_end" });
			if (i && toMinutes(list[i][0]) < toMinutes(list[i - 1][1])) errors.push({ field: "work_hours", message: "intervals_overlap" });
		}
		data.work_hours[d] = list;
	}

	// Свята: дійсна дата, без повторів
	const seen = new Set();
	for (const h of data.holidays) {
		const dt = new Date(h.date + "T00:00:00Z");
		if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== h.date) errors.push({ field: "holidays", message: "invalid_date" });
		const key = h.recurring ? "r" + h.date.slice(5) : h.date;
		if (seen.has(key)) errors.push({ field: "holidays", message: "duplicate_date" });
		seen.add(key);
	}

	return errors.length ? { valid: false, errors } : { valid: true, data };
}

function validateDepartment(body) {
	const data = clean(body);
	if (data.code) data.code = String(data.code).toUpperCase();
	if (!department(data)) return { valid: false, errors: ajvErrors(department) };
	data.offices = [...new Set(data.offices)];
	return { valid: true, data };
}

function validateWork(body) {
	const data = clean(body);
	if (!work(data)) return { valid: false, errors: ajvErrors(work) };
	return { valid: true, data };
}

function validateRegional(body) {
	const data = clean(body);
	if (!regional(data)) return { valid: false, errors: ajvErrors(regional) };
	const errors = [];
	if (data.timezone && !isTimezone(data.timezone)) errors.push({ field: "timezone", message: "unknown_timezone" });
	if (data.locale && !isLocale(data.locale)) errors.push({ field: "locale", message: "unsupported_locale" });
	return errors.length ? { valid: false, errors } : { valid: true, data };
}

module.exports = { validateOffice, validateDepartment, validateWork, validateRegional, isTimezone, DAYS };