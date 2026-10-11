"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const { KEYS, DEFAULTS, validateSetting } = require("../../../validator/catalog/products/settings");

const P = config.get("configDatabase").prefix;

// Кеш у процесі. Короткий TTL — щоб кілька інстансів підхоплювали зміни без шини подій.
const TTL_MS = 30 * 1000;
let cache = null;
let cacheAt = 0;

function httpErr(status, message, errors) {
	const e = new Error(message);
	e.status = status;
	if (errors) e.errors = errors;
	return e;
}

const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

/** Усі блоки налаштувань: дефолти + збережене, прогнане через схему (стара/битa конфігурація не пролізе) */
async function getAll() {
	if (cache && Date.now() - cacheAt < TTL_MS) return cache;
	const [rows] = await pool.query(`SELECT setting_key, value FROM ${P}products_settings`);
	const stored = Object.fromEntries(rows.map((r) => [r.setting_key, parse(r.value)]));
	const out = {};
	for (const key of KEYS) {
		const merged = { ...DEFAULTS[key], ...(stored[key] || {}) };
		const v = validateSetting(key, merged);
		out[key] = v.valid ? v.data : structuredClone(DEFAULTS[key]);
	}
	cache = Object.freeze(out);
	cacheAt = Date.now();
	return cache;
}

async function get(key) {
	if (!KEYS.includes(key)) throw httpErr(404, "Unknown settings block");
	return (await getAll())[key];
}

async function save(key, value, idUser) {
	if (!KEYS.includes(key)) throw httpErr(404, "Unknown settings block");
	const v = validateSetting(key, value);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);

	if (key === "stock") {
		const [[wh]] = await pool.query(`SELECT id FROM ${P}products_warehouses WHERE id = ? AND deleted_at IS NULL AND status = 1`, [v.data.id_default_warehouse]);
		if (!wh) throw httpErr(400, "Validation failed", [{ field: "id_default_warehouse", message: "warehouse not found or inactive" }]);
	}

	await pool.query(
		`INSERT INTO ${P}products_settings (setting_key, value, id_user_edit)
		 VALUES (?, CAST(? AS JSON), ?)
		 ON DUPLICATE KEY UPDATE value = CAST(? AS JSON), id_user_edit = ?`,
		[key, JSON.stringify(v.data), idUser || null, JSON.stringify(v.data), idUser || null]
	);
	invalidate();
	return v.data;
}

function invalidate() {
	cache = null;
	cacheAt = 0;
}

module.exports = { getAll, get, save, invalidate, KEYS };