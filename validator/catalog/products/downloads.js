"use strict";

const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });

const FILE_RE = "^[0-9a-f]{2}/[0-9a-f]{64}$";

const item = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["file", "original_name", "mime", "size", "hash"],
	properties: {
		id: { type: ["integer", "null"], minimum: 1, default: null },
		file: { type: "string", pattern: FILE_RE },
		original_name: { type: "string", minLength: 1, maxLength: 255 },
		mime: { type: "string", minLength: 1, maxLength: 128 },
		size: { type: "integer", minimum: 0 },
		hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
		id_variant: { type: "integer", minimum: 0, default: 0 },
		version: { type: ["string", "null"], maxLength: 32, default: null },
		max_downloads: { type: ["integer", "null"], minimum: 1, maximum: 65535, default: null },
		expires_days: { type: ["integer", "null"], minimum: 1, maximum: 65535, default: null },
		names: { type: "object", default: {} },
	},
});

function validateDownloads(list, langIds) {
	if (!Array.isArray(list) || list.length > 100) return { valid: false, errors: [{ field: "files", message: "invalid list" }] };
	const errors = [];
	const out = [];
	list.forEach((raw, i) => {
		const row = JSON.parse(JSON.stringify(raw || {}));
		for (const k of Object.keys(row)) if (row[k] === "") row[k] = null;
		if (!item(row)) {
			item.errors.forEach((e) => errors.push({ field: `files.${i}.${(e.instancePath || "").slice(1) || e.params.missingProperty}`, message: e.message }));
			return;
		}
		if (row.file.split("/")[1] !== row.hash) errors.push({ field: `files.${i}`, message: "file/hash mismatch" });
		const names = {};
		langIds.forEach((lang, k) => {
			const v = row.names[lang] && row.names[lang].name != null ? String(row.names[lang].name).trim() : "";
			if (v.length > 255) errors.push({ field: `files.${i}.names.${lang}`, message: "too long" });
			if (!v && k === 0) errors.push({ field: `files.${i}.names.${lang}`, message: "required" });
			names[lang] = v ? { name: v } : null;
		});
		out.push({ ...row, names });
	});
	return errors.length ? { valid: false, errors } : { valid: true, data: out };
}

module.exports = { validateDownloads, FILE_RE: new RegExp(FILE_RE) };