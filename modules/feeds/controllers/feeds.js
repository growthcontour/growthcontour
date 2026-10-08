"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const Ajv = require("ajv");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const languages = require("../../../controllers/catalog/products/languages");

const P = config.get("configDatabase").prefix;
const T = `${P}feeds`;
const CACHE_DIR = path.join(__dirname, "..", "cache");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });
const ids = { type: "array", maxItems: 5000, uniqueItems: true, default: [], items: { type: "integer", minimum: 1 } };

const schema = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["name", "format", "base_url", "url_template"],
	properties: {
		name: { type: "string", minLength: 1, maxLength: 128 },
		format: { enum: ["google", "prom"] },
		status: { type: "boolean", default: true },
		id_lang: { type: ["integer", "null"], minimum: 1, default: null },
		currency: { type: ["string", "null"], pattern: "^[A-Z]{3}$", default: null },
		// Адреса сайту та шаблон посилання на товар: {slug} {id} {sku} {external_id}
		base_url: { type: "string", maxLength: 255, pattern: "^https?://[^\\s]+$" },
		url_template: { type: "string", minLength: 1, maxLength: 255 },
		id_integration: { type: ["integer", "null"], minimum: 1, default: null },
		image_size: { type: ["string", "null"], pattern: "^[a-z0-9_]{1,32}$", default: null },
		utm: { type: ["string", "null"], maxLength: 255, pattern: "^[^\\s?#]*$", default: null },
		interval_hours: { type: "integer", minimum: 1, maximum: 168, default: 6 },
		filters: {
			type: "object",
			additionalProperties: false,
			default: {},
			properties: {
				statuses: { type: "array", default: ["active"], items: { enum: ["active", "draft"] }, minItems: 1, uniqueItems: true },
				categories: ids,
				brands: ids,
				in_stock_only: { type: "boolean", default: false },
				with_images_only: { type: "boolean", default: true },
				variants: { type: "boolean", default: true },
			},
		},
		shop: {
			type: "object",
			additionalProperties: false,
			default: {},
			properties: {
				name: { type: "string", maxLength: 128, default: "" },
				company: { type: "string", maxLength: 255, default: "" },
			},
		},
	},
});

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

/** Таблиця модуля — створюється при увімкненні (ідемпотентно) */
async function ensureSchema() {
	await pool.query(
		`CREATE TABLE IF NOT EXISTS ${T} (
		  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
		  name VARCHAR(128) NOT NULL,
		  format ENUM('google','prom') NOT NULL,
		  token CHAR(32) NOT NULL,
		  status TINYINT(1) NOT NULL DEFAULT 1,
		  id_lang INT UNSIGNED NULL,
		  currency CHAR(3) NULL,
		  base_url VARCHAR(255) NOT NULL,
		  url_template VARCHAR(255) NOT NULL,
		  id_integration INT UNSIGNED NULL,
		  image_size VARCHAR(32) NULL,
		  utm VARCHAR(255) NULL,
		  interval_hours SMALLINT UNSIGNED NOT NULL DEFAULT 6,
		  filters JSON NULL,
		  shop JSON NULL,
		  last_generated_at DATETIME NULL,
		  last_duration_ms INT UNSIGNED NULL,
		  items INT UNSIGNED NULL,
		  skipped INT UNSIGNED NULL,
		  file_size BIGINT UNSIGNED NULL,
		  last_error VARCHAR(1024) NULL,
		  report JSON NULL,
		  date_add DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		  date_upd DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		  PRIMARY KEY (id),
		  UNIQUE KEY uq_token (token)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
	);
	await fs.mkdir(CACHE_DIR, { recursive: true });
}

const parse = (v, def) => {
	if (v == null) return def;
	if (typeof v === "object") return v;
	try {
		return JSON.parse(v);
	} catch {
		return def;
	}
};

const publicUrl = (row) => `${String(process.env.APP_URL || "").replace(/\/+$/, "")}/modules/feeds/f/${row.token}.xml`;

function present(row) {
	return { ...row, filters: parse(row.filters, {}), shop: parse(row.shop, {}), report: parse(row.report, null), url: publicUrl(row) };
}

async function list() {
	const [rows] = await pool.query(`SELECT * FROM ${T} ORDER BY id`);
	return rows.map(present);
}

async function get(id) {
	const [[row]] = await pool.query(`SELECT * FROM ${T} WHERE id = ?`, [id]);
	if (!row) throw httpErr(404, "Not found");
	return present(row);
}

async function save(id, body) {
	const data = JSON.parse(JSON.stringify(body || {}));
	if (!schema(data)) {
		throw httpErr(
			400,
			"Validation failed",
			schema.errors.map((e) => ({ field: (e.instancePath || "").replace(/^\//, "").replace(/\//g, ".") || (e.params && e.params.missingProperty) || "", message: e.message }))
		);
	}
	if (!/\{(slug|id|sku|external_id)\}/.test(data.url_template)) throw httpErr(400, "Validation failed", [{ field: "url_template", message: "must contain {slug}, {id}, {sku} or {external_id}" }]);
	if (data.url_template.includes("{external_id}") && !data.id_integration) throw httpErr(400, "Validation failed", [{ field: "id_integration", message: "required for {external_id}" }]);
	data.base_url = data.base_url.replace(/\/+$/, "");

	const cols = ["name", "format", "status", "id_lang", "currency", "base_url", "url_template", "id_integration", "image_size", "utm", "interval_hours", "filters", "shop"];
	const values = cols.map((c) => (c === "filters" || c === "shop" ? JSON.stringify(data[c]) : typeof data[c] === "boolean" ? Number(data[c]) : data[c]));
	if (id) {
		const [r] = await pool.query(`UPDATE ${T} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...values, id]);
		if (!r.affectedRows) throw httpErr(404, "Not found");
		return { id };
	}
	const [r] = await pool.query(`INSERT INTO ${T} (${cols.join(", ")}, token) VALUES (?)`, [[...values, crypto.randomBytes(16).toString("hex")]]);
	return { id: r.insertId };
}

async function remove(id) {
	const row = await get(id);
	await pool.query(`DELETE FROM ${T} WHERE id = ?`, [id]);
	await fs.unlink(path.join(CACHE_DIR, `${row.id}-${row.token}.xml`)).catch(() => {});
	return { ok: true };
}

/** Нова адреса фіду (якщо стара потрапила не туди). Старий файл видаляється одразу */
async function regenerateToken(id) {
	const row = await get(id);
	const token = crypto.randomBytes(16).toString("hex");
	await pool.query(`UPDATE ${T} SET token = ? WHERE id = ?`, [token, id]);
	const oldFile = path.join(CACHE_DIR, `${row.id}-${row.token}.xml`);
	await fs.rename(oldFile, path.join(CACHE_DIR, `${row.id}-${token}.xml`)).catch(() => {});
	return { url: publicUrl({ token }) };
}

/** Довідники для форми */
async function dictionaries(idLang) {
	const langs = await languages.active();
	const primary = langs[0] ? langs[0].id : idLang;
	const [[integrations], [categories], [brands]] = await Promise.all([
		pool.query(`SELECT id, name FROM ${P}orders_integrations ORDER BY name`),
		pool.query(
			`SELECT c.id, c.id_parent, COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', c.id)) AS name
			   FROM ${P}products_categories c
			   LEFT JOIN ${P}products_categories_description d  ON d.id_category = c.id AND d.id_lang = ?
			   LEFT JOIN ${P}products_categories_description dp ON dp.id_category = c.id AND dp.id_lang = ?
			  ORDER BY c.sort_order, c.id`,
			[idLang, primary]
		),
		pool.query(
			`SELECT b.id, COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', b.id)) AS name
			   FROM ${P}products_brands b
			   LEFT JOIN ${P}products_brands_description d  ON d.id_brand = b.id AND d.id_lang = ?
			   LEFT JOIN ${P}products_brands_description dp ON dp.id_brand = b.id AND dp.id_lang = ?
			  WHERE b.deleted_at IS NULL ORDER BY name`,
			[idLang, primary]
		),
	]);
	const settings = require("../../../controllers/catalog/products/settings");
	const imagesCfg = await settings.get("images");
	return { languages: langs, integrations, categories, brands, thumbnails: (imagesCfg.thumbnails || []).map((t) => t.code) };
}

module.exports = { T, CACHE_DIR, ensureSchema, list, get, save, remove, regenerateToken, dictionaries, publicUrl };