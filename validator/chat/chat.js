"use strict";

/** Чат компанії: перевірка вхідних даних API */
const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });

const MAX_BODY = 10000;
const MAX_FILES = 10;
const ISO = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$";
const ids = (max) => ({ type: "array", maxItems: max, default: [], items: { type: "integer", minimum: 1 } });

const room = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["type", "name"],
	properties: {
		type: { enum: ["group", "channel"] },
		name: { type: "string", minLength: 1, maxLength: 255 },
		description: { type: ["string", "null"], maxLength: 1000, default: null },
		visibility: { enum: ["public", "private"], default: "private" },
		color: { type: ["string", "null"], pattern: "^#[0-9a-fA-F]{6}$", default: null },
		members: ids(1000),
	},
});

const roomEdit = ajv.compile({
	type: "object",
	additionalProperties: false,
	properties: {
		name: { type: "string", minLength: 1, maxLength: 255 },
		description: { type: ["string", "null"], maxLength: 1000 },
		visibility: { enum: ["public", "private"] },
		color: { type: ["string", "null"], pattern: "^#[0-9a-fA-F]{6}$" },
	},
});

const message = ajv.compile({
	type: "object",
	additionalProperties: false,
	properties: {
		body: { type: ["string", "null"], maxLength: MAX_BODY, default: null },
		files: ids(MAX_FILES),
		id_reply: { type: ["integer", "null"], minimum: 1, default: null },
		id_thread: { type: ["integer", "null"], minimum: 1, default: null },
		// Картки записів системи, додані вручну (посилання в тексті сервер знаходить сам)
		records: {
			type: "array",
			maxItems: 5,
			default: [],
			items: { type: "object", additionalProperties: false, required: ["type", "id"], properties: { type: { enum: ["order", "lead", "client", "deal"] }, id: { type: "integer", minimum: 1, maximum: 4294967295 } } },
		},
		urgent: { type: "boolean", default: false },
		// Потрібне підтвердження «Ознайомлений(-а)» від усіх учасників
		ack: { type: "boolean", default: false },
		// Опитування: body — питання
		poll: {
			type: ["object", "null"],
			default: null,
			additionalProperties: false,
			required: ["options"],
			properties: {
				options: { type: "array", minItems: 2, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 300 } },
				multiple: { type: "boolean", default: false },
				anonymous: { type: "boolean", default: false },
				closes_at: { type: ["string", "null"], pattern: ISO, default: null },
			},
		},
		// Чекліст: body — назва
		checklist: {
			type: ["object", "null"],
			default: null,
			additionalProperties: false,
			required: ["items"],
			properties: { items: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 500 } } },
		},
		// Відкладене надсилання: момент з часовим поясом (ISO 8601)
		send_at: { type: ["string", "null"], pattern: ISO, default: null },
		client_id: { type: ["string", "null"], pattern: "^[0-9a-fA-F-]{36}$", default: null },
	},
});

const settings = ajv.compile({
	type: "object",
	additionalProperties: false,
	properties: {
		notify: { enum: ["all", "mentions", "none"] },
		// 0 — увімкнути, N — вимкнути на N хвилин, -1 — до ручного ввімкнення
		mute_minutes: { type: "integer", minimum: -1, maximum: 525600 },
		pinned: { type: "boolean" },
		hidden: { type: "boolean" },
	},
});

const status = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["status"],
	properties: {
		status: { enum: ["available", "away", "meeting", "vacation", "dnd"] },
		text: { type: ["string", "null"], maxLength: 100, default: null },
		until: { type: ["string", "null"], pattern: ISO, default: null },
	},
});

const search = ajv.compile({
	type: "object",
	additionalProperties: false,
	properties: {
		q: { type: ["string", "null"], maxLength: 200, default: null },
		id_room: { type: ["integer", "null"], minimum: 1, default: null },
		id_user: { type: ["integer", "null"], minimum: 1, default: null },
		date_from: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$", default: null },
		date_to: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$", default: null },
		has_files: { type: "boolean", default: false },
		has_links: { type: "boolean", default: false },
		mentions_me: { type: "boolean", default: false },
		before: { type: ["integer", "null"], minimum: 1, default: null },
	},
});

const reminder = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["remind_at"],
	properties: {
		remind_at: { type: "string", pattern: ISO },
		note: { type: ["string", "null"], maxLength: 255, default: null },
		// Нагадати, лише якщо на повідомлення ніхто не відповів
		if_no_reply: { type: "boolean", default: false },
	},
});

const task = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["title", "start"],
	properties: {
		title: { type: "string", minLength: 1, maxLength: 255 },
		id_user: { type: ["integer", "null"], minimum: 1, default: null },
		start: { type: "string", pattern: ISO },
		description: { type: ["string", "null"], maxLength: 5000, default: null },
	},
});

const subscription = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["source"],
	properties: {
		source: { type: "string", maxLength: 32 },
		events: { type: "array", maxItems: 30, default: [], items: { type: "string", maxLength: 32 } },
	},
});

function clean(body) {
	const data = JSON.parse(JSON.stringify(body && typeof body === "object" ? body : {}));
	for (const k of Object.keys(data)) if (typeof data[k] === "string" && k !== "body") data[k] = data[k].trim();
	return data;
}

const errorsOf = (fn) => fn.errors.map((e) => ({ field: (e.instancePath || "").slice(1).split("/")[0] || e.params.missingProperty, message: e.message }));

function check(fn, body) {
	const data = clean(body);
	return fn(data) ? { valid: true, data } : { valid: false, errors: errorsOf(fn) };
}

function validateMessage(body) {
	const v = check(message, body);
	if (!v.valid) return v;
	const d = v.data;
	// Текст: лише кінці рядків \n, без керівних символів (крім табуляції), без порожніх рядків по краях
	if (typeof d.body === "string") {
		d.body = d.body
			.replace(/\r\n?/g, "\n")
			.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
			.replace(/^\s*\n|\n\s*$/g, "");
		if (!d.body.trim()) d.body = null;
	}
	d.files = [...new Set(d.files)];
	const bad = (field, text) => ({ valid: false, errors: [{ field, message: text }] });
	if (d.poll || d.checklist) {
		if (d.poll && d.checklist) return bad("poll", "one of poll or checklist");
		if (!d.body) return bad("body", "required");
		// Відкладене надсилання зберігає лише текст, файли й картки
		if (d.send_at) return bad("send_at", "not with poll or checklist");
		const list = (d.poll ? d.poll.options : d.checklist.items).map((x) => x.replace(/[\u0000-\u001F\u007F]/g, " ").trim()).filter(Boolean);
		if (d.poll) {
			if (new Set(list.map((x) => x.toLowerCase())).size !== list.length || list.length < 2) return bad("poll", "options must be different");
			d.poll.options = list;
			if (d.poll.closes_at) {
				const at = new Date(d.poll.closes_at);
				if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 60000) return bad("closes_at", "must be in the future");
			}
		} else {
			if (!list.length) return bad("checklist", "empty");
			d.checklist.items = list;
		}
	}
	if (d.ack && d.send_at) return bad("send_at", "not with ack");
	// Повідомлення без тексту — лише з файлами або карткою запису
	if (!d.body && !d.files.length && !d.records.length) return { valid: false, errors: [{ field: "body", message: "empty" }] };
	return v;
}

function validateStatus(body) {
	const v = check(status, body);
	if (!v.valid) return v;
	if (v.data.until) {
		const t = new Date(v.data.until);
		if (Number.isNaN(t.getTime()) || t.getTime() <= Date.now()) return { valid: false, errors: [{ field: "until", message: "must be in the future" }] };
		v.data.until = t;
	}
	return v;
}

module.exports = {
	MAX_BODY,
	MAX_FILES,
	validateRoom: (b) => check(room, b),
	validateRoomEdit: (b) => check(roomEdit, b),
	validateMessage,
	validateSettings: (b) => check(settings, b),
	validateStatus,
	validateSearch: (b) => check(search, b),
	validateReminder: (b) => check(reminder, b),
	validateTask(b) {
		const v = check(task, b);
		if (!v.valid) return v;
		const at = new Date(v.data.start);
		// Задача може бути й на «зараз», але не в далекому минулому чи за роки вперед
		if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() - 864e5 || at.getTime() > Date.now() + 5 * 366 * 864e5) return { valid: false, errors: [{ field: "start", message: "out of range" }] };
		v.data.start = at;
		return v;
	},
	validateSubscription: (b) => check(subscription, b),
	isIso: (s) => typeof s === "string" && new RegExp(ISO).test(s),
};