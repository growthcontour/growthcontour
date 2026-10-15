"use strict";

const crypto = require("crypto");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("./settings");

const P = config.get("configDatabase").prefix;
const MAX_LEN = 64;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // без 0/O, 1/I — щоб не плутали при читанні

/** Атомарний наступний номер послідовності (безпечно при паралельних запитах і кількох інстансах) */
async function nextSequence(name, conn) {
	const db = conn || (await pool.getConnection());
	try {
		await db.query(`INSERT IGNORE INTO ${P}products_sequences (name, value) VALUES (?, 0)`, [name]);
		await db.query(`UPDATE ${P}products_sequences SET value = LAST_INSERT_ID(value + 1) WHERE name = ?`, [name]);
		const [[r]] = await db.query("SELECT LAST_INSERT_ID() AS v");
		return Number(r.v);
	} finally {
		if (!conn) db.release();
	}
}

const pad = (v, n) => String(v).padStart(Number(n) || 0, "0");
const randomCode = (n) => Array.from({ length: Math.min(Number(n) || 4, 16) }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
const clean = (s) =>
	String(s || "")
		.toUpperCase()
		.replace(/[^A-Z0-9_\-.]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");

/**
 * Згенерувати артикул за шаблоном.
 * ctx: { id, brandCode, categoryId } — значення для токенів (усі необов'язкові)
 */
async function render(pattern, cfg, ctx, conn) {
	const now = new Date();
	let seq = null;
	const out = await replaceAsync(pattern, /\{([A-Z]+)(?::(\d{1,2}))?\}/g, async (_, token, arg) => {
		switch (token) {
			case "PREFIX":
				return cfg.prefix || "";
			case "SEQ":
				if (seq === null) seq = await nextSequence("sku", conn);
				return pad(seq, arg);
			case "ID":
				return ctx.id ? pad(ctx.id, arg) : "";
			case "BRAND":
				return ctx.brandCode || "";
			case "CAT":
				return ctx.categoryId ? pad(ctx.categoryId, arg) : "";
			case "YYYY":
				return String(now.getFullYear());
			case "YY":
				return String(now.getFullYear()).slice(-2);
			case "MM":
				return pad(now.getMonth() + 1, 2);
			case "RAND":
				return randomCode(arg);
			default:
				return "";
		}
	});
	return clean(out).slice(0, MAX_LEN);
}

async function replaceAsync(str, re, fn) {
	const parts = [];
	let last = 0;
	for (const m of str.matchAll(re)) {
		parts.push(str.slice(last, m.index), await fn(...m));
		last = m.index + m[0].length;
	}
	parts.push(str.slice(last));
	return parts.join("");
}

/** Чи вільний артикул серед товарів І варіантів (артикул має бути унікальним глобально) */
async function isFree(sku, { excludeProductId = 0, excludeVariantId = 0 } = {}, conn) {
	const db = conn || pool;
	const [rows] = await db.query(
		`SELECT 1 FROM ${P}products WHERE sku = ? AND id <> ?
		 UNION ALL
		 SELECT 1 FROM ${P}products_variants WHERE sku = ? AND id <> ?
		 LIMIT 1`,
		[sku, excludeProductId, sku, excludeVariantId]
	);
	return rows.length === 0;
}

/** Артикул для товару. Кілька спроб — на випадок колізії з вручну введеним артикулом. */
async function generateForProduct(ctx = {}, conn) {
	const cfg = await settings.get("sku");
	for (let attempt = 0; attempt < 5; attempt++) {
		const sku = await render(cfg.pattern, cfg, ctx, conn);
		if (sku && (await isFree(sku, { excludeProductId: ctx.id }, conn))) return sku;
	}
	throw Object.assign(new Error("Не вдалося згенерувати унікальний артикул — змініть шаблон"), { status: 409 });
}

/** Артикул варіанта: {PARENT}-{AXES}, де AXES — коди значень осей (XL-RED) */
async function generateForVariant(parentSku, axisCodes, ctx = {}, conn) {
	const cfg = await settings.get("sku");
	const axes = clean((axisCodes || []).join("-"));
	let base = clean(cfg.variant_pattern.replace("{PARENT}", parentSku || "").replace("{AXES}", axes)).slice(0, MAX_LEN);
	if (!base) base = await render(cfg.pattern, cfg, ctx, conn);
	if (await isFree(base, { excludeVariantId: ctx.variantId }, conn)) return base;
	for (let n = 2; n < 100; n++) {
		const candidate = (base.slice(0, MAX_LEN - String(n).length - 1) + "-" + n).replace(/-{2,}/g, "-");
		if (await isFree(candidate, { excludeVariantId: ctx.variantId }, conn)) return candidate;
	}
	throw Object.assign(new Error("Не вдалося згенерувати унікальний артикул варіанта"), { status: 409 });
}

module.exports = { nextSequence, render, isFree, generateForProduct, generateForVariant, clean };