"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");

const P = config.get("configDatabase").prefix;
const CACHE_MS = 30000;
// BCP 47: мова (2–3), [писемність (4)], [регіон (2 літери або 3 цифри)]
const CODE_RE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-(?:[A-Z]{2}|[0-9]{3}))?$/;

let cache = null;
let cacheAt = 0;
let langTables = null;

function httpErr(status, message, errors, code) {
	return Object.assign(new Error(message), { status, errors, code });
}

/** uk, PT-br, zh-hans → uk, pt-BR, zh-Hans */
function normalizeCode(raw) {
	return String(raw || "")
		.trim()
		.replace(/_/g, "-")
		.split("-")
		.filter(Boolean)
		.map((p, i) => (i === 0 ? p.toLowerCase() : p.length === 4 ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p.toUpperCase()))
		.join("-");
}

/** Активні мови контенту: основна перша, далі за порядком */
async function active() {
	if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
	const [rows] = await pool.query(
		`SELECT id, code, LOWER(code) AS iso, name, native_name, direction, is_primary
		   FROM ${P}products_languages WHERE status = 1
		  ORDER BY is_primary DESC, sort_order, id`
	);
	cache = rows.map((r) => ({ ...r, id: Number(r.id), is_primary: Number(r.is_primary) }));
	cacheAt = Date.now();
	return cache;
}

function invalidate() {
	cache = null;
	cacheAt = 0;
}

/** Усі таблиці каталогу з колонкою id_lang (описи) — визначаються зі схеми БД */
async function descriptionTables() {
	if (langTables) return langTables;
	const like = (P + "products_").replace(/[\\%_]/g, (m) => "\\" + m) + "%";
	const [rows] = await pool.query(
		`SELECT TABLE_NAME AS t FROM information_schema.COLUMNS
		  WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'id_lang' AND TABLE_NAME LIKE ?`,
		[like]
	);
	langTables = rows.map((r) => r.t).filter((t) => /^[A-Za-z0-9_]+$/.test(t));
	return langTables;
}

/** Кількість перекладів по кожній мові */
async function usage() {
	const out = new Map();
	for (const t of await descriptionTables()) {
		const [rows] = await pool.query(`SELECT id_lang, COUNT(*) AS n FROM \`${t}\` GROUP BY id_lang`);
		for (const r of rows) out.set(Number(r.id_lang), (out.get(Number(r.id_lang)) || 0) + Number(r.n));
	}
	return out;
}

async function list() {
	const [rows] = await pool.query(`SELECT id, code, name, native_name, direction, is_primary, status, sort_order FROM ${P}products_languages ORDER BY is_primary DESC, sort_order, id`);
	const used = await usage();
	return rows.map((r) => ({ ...r, translations: used.get(Number(r.id)) || 0 }));
}

function validate(b) {
	const errors = [];
	const v = {
		code: normalizeCode(b.code),
		name: String(b.name || "").trim(),
		native_name: String(b.native_name || "").trim(),
		direction: b.direction === "rtl" ? "rtl" : "ltr",
		status: b.status === false || b.status === 0 || b.status === "0" ? 0 : 1,
		sort_order: Number.isInteger(Number(b.sort_order)) ? Number(b.sort_order) : 0,
	};
	if (!CODE_RE.test(v.code) || v.code.length > 16) errors.push({ field: "code", message: "invalid BCP 47 code (uk, en, ar, pt-BR, zh-Hans)" });
	if (!v.name || v.name.length > 64) errors.push({ field: "name", message: "required, max 64" });
	if (!v.native_name || v.native_name.length > 64) errors.push({ field: "native_name", message: "required, max 64" });
	if (errors.length) throw httpErr(400, "Validation failed", errors);
	return v;
}

async function save(id, body) {
	const v = validate(body || {});
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		if (id) {
			const [[cur]] = await conn.query(`SELECT id, is_primary FROM ${P}products_languages WHERE id = ? FOR UPDATE`, [id]);
			if (!cur) throw httpErr(404, "Not found");
			if (Number(cur.is_primary) && !v.status) throw httpErr(400, "Primary language cannot be disabled", [{ field: "status", message: "primary language cannot be disabled" }], "primary");
			await conn.query(
				`UPDATE ${P}products_languages SET code = ?, name = ?, native_name = ?, direction = ?, status = ?, sort_order = ? WHERE id = ?`,
				[v.code, v.name, v.native_name, v.direction, v.status, v.sort_order, id]
			);
		} else {
			// Якщо така мова є серед мов інтерфейсу — беремо її id (тоді список товарів показує назви мовою користувача)
			const lower = v.code.toLowerCase();
			const base = lower.split("-")[0];
			const [[sys]] = await conn.query(
				`SELECT id FROM ${P}languages WHERE LOWER(iso) IN (?, ?) ORDER BY LOWER(iso) = ? DESC LIMIT 1`,
				[lower, base, lower]
			);
			let newId = null;
			if (sys && Number(sys.id) <= 255) {
				const [[taken]] = await conn.query(`SELECT id FROM ${P}products_languages WHERE id = ?`, [sys.id]);
				if (!taken) newId = Number(sys.id);
			}
			const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM ${P}products_languages`);
			const isPrimary = Number(n) === 0 ? 1 : 0;
			const [r] = await conn.query(
				`INSERT INTO ${P}products_languages (${newId ? "id, " : ""}code, name, native_name, direction, status, sort_order, is_primary)
				 VALUES (${newId ? "?, " : ""}?, ?, ?, ?, ?, ?, ?)`,
				[...(newId ? [newId] : []), v.code, v.name, v.native_name, v.direction, isPrimary ? 1 : v.status, v.sort_order, isPrimary]
			);
			id = newId || r.insertId;
		}
		await conn.commit();
		invalidate();
		return { id };
	} catch (e) {
		await conn.rollback().catch(() => {});
		if (e.code === "ER_DUP_ENTRY" && /uq_code/.test(e.message)) throw httpErr(409, "Language with this code already exists", [{ field: "code", message: "already exists" }]);
		if (e.code === "ER_AUTOINC_READ_FAILED" || e.code === "ER_WARN_DATA_OUT_OF_RANGE") throw httpErr(409, "Language limit reached");
		throw e;
	} finally {
		conn.release();
	}
}

async function setPrimary(id) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [[row]] = await conn.query(`SELECT id, status FROM ${P}products_languages WHERE id = ? FOR UPDATE`, [id]);
		if (!row) throw httpErr(404, "Not found");
		if (!Number(row.status)) throw httpErr(400, "Enable the language first", null, "disabled");
		await conn.query(`UPDATE ${P}products_languages SET is_primary = 0 WHERE is_primary = 1`);
		await conn.query(`UPDATE ${P}products_languages SET is_primary = 1 WHERE id = ?`, [id]);
		await conn.commit();
		invalidate();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

async function remove(id) {
	const [[row]] = await pool.query(`SELECT id, is_primary FROM ${P}products_languages WHERE id = ?`, [id]);
	if (!row) throw httpErr(404, "Not found");
	if (Number(row.is_primary)) throw httpErr(400, "Primary language cannot be deleted", null, "primary");
	const n = (await usage()).get(Number(id)) || 0;
	if (n) throw httpErr(409, `Language has ${n} translations — disable it instead`, null, "in_use");
	await pool.query(`DELETE FROM ${P}products_languages WHERE id = ?`, [id]);
	invalidate();
}

module.exports = { active, invalidate, list, save, setPrimary, remove, normalizeCode };