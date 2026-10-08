"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const descriptions = require("./descriptions");
const { mutate, httpErr } = require("./product-mutate");
const { validateDownloads, FILE_RE } = require("../../../validator/catalog/products/downloads");

const P = config.get("configDatabase").prefix;

// Закрите сховище: Express його не роздає. Віддача — лише через авторизований маршрут.
const STORAGE = path.join(__dirname, "..", "..", "..", "storage", "products", "downloads");
const TMP = path.join(STORAGE, "tmp");
const MAX_SIZE = 2 * 1024 * 1024 * 1024; // 2 ГБ

function absPath(file) {
	if (!FILE_RE.test(file)) throw httpErr(400, "Invalid file path");
	return path.join(STORAGE, file);
}

async function ensureDirs() {
	await fsp.mkdir(TMP, { recursive: true, mode: 0o750 });
}

/**
 * Прийняти завантажений multer-ом тимчасовий файл: порахувати sha256 потоком,
 * перенести під ім'ям хешу (дублікати не множаться).
 */
async function ingest(tmpPath, originalName, mime) {
	try {
		const hash = crypto.createHash("sha256");
		await pipeline(fs.createReadStream(tmpPath), hash);
		const digest = hash.digest("hex");
		const file = `${digest.slice(0, 2)}/${digest}`;
		const target = absPath(file);
		await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
		const { size } = await fsp.stat(tmpPath);
		try {
			await fsp.access(target);
			await fsp.unlink(tmpPath); // такий файл уже є
		} catch {
			await fsp.rename(tmpPath, target);
			await fsp.chmod(target, 0o640);
		}
		const safeName = path.basename(String(originalName || "file")).replace(/[\u0000-\u001f\u007f"\\/]/g, "_").slice(0, 255) || "file";
		return { file, hash: digest, size, original_name: safeName, mime: String(mime || "application/octet-stream").slice(0, 128) };
	} catch (e) {
		await fsp.unlink(tmpPath).catch(() => {});
		throw e;
	}
}

async function list(idProduct, idLang) {
	const langs = await descriptions.contentLanguages();
	const [[product]] = await pool.query(
		`SELECT p.id, p.type, p.version, COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', p.id)) AS name
		   FROM ${P}products p
		   LEFT JOIN ${P}products_description d  ON d.id_product = p.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_description dp ON dp.id_product = p.id AND dp.id_lang = ?
		  WHERE p.id = ? AND p.deleted_at IS NULL`,
		[idLang, langs[0] ? langs[0].id : idLang, idProduct]
	);
	if (!product) throw httpErr(404, "Not found");
	const [rows] = await pool.query(
		`SELECT id, id_variant, file, original_name, mime, size, hash, version, max_downloads, expires_days, date_add
		   FROM ${P}products_downloads WHERE id_product = ? ORDER BY sort_order, id`,
		[idProduct]
	);
	const [names] = rows.length ? await pool.query(`SELECT id_download, id_lang, name FROM ${P}products_downloads_description WHERE id_download IN (?)`, [rows.map((r) => r.id)]) : [[]];
	const [variants] = await pool.query(`SELECT id, sku FROM ${P}products_variants WHERE id_product = ? ORDER BY sort_order, id`, [idProduct]);
	return {
		product,
		variants,
		files: rows.map((r) => ({ ...r, names: names.filter((n) => n.id_download === r.id).reduce((m, n) => ((m[n.id_lang] = { name: n.name }), m), {}) })),
	};
}

async function isReferenced(file) {
	const [rows] = await pool.query(`SELECT 1 FROM ${P}products_downloads WHERE file = ? LIMIT 1`, [file]);
	return rows.length > 0;
}

async function removeIfUnused(file) {
	if (!FILE_RE.test(file) || (await isReferenced(file))) return false;
	await fsp.unlink(absPath(file)).catch((e) => e.code !== "ENOENT" && console.error("[downloads] unlink", e.message));
	return true;
}

async function save(idProduct, body, ctx) {
	const langIds = (await descriptions.contentLanguages()).map((l) => l.id);
	const v = validateDownloads(body.files, langIds);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);

	return mutate(idProduct, ctx, async (conn, product) => {
		if (product.type !== "digital") throw httpErr(409, "Set product type to digital first", [{ field: "type", message: "product is not digital" }]);

		const [existing] = await conn.query(`SELECT id, file FROM ${P}products_downloads WHERE id_product = ? FOR UPDATE`, [idProduct]);
		const byId = new Map(existing.map((e) => [e.id, e]));
		const [variants] = await conn.query(`SELECT id FROM ${P}products_variants WHERE id_product = ?`, [idProduct]);
		const variantIds = new Set(variants.map((x) => x.id));

		for (const [i, f] of v.data.entries()) {
			if (f.id && !byId.has(f.id)) throw httpErr(400, "Validation failed", [{ field: `files.${i}`, message: "invalid file id" }]);
			if (f.id_variant && !variantIds.has(f.id_variant)) throw httpErr(400, "Validation failed", [{ field: `files.${i}.id_variant`, message: "variant not found" }]);
			if (!f.id) {
				try {
					await fsp.access(absPath(f.file));
				} catch {
					throw httpErr(400, "Validation failed", [{ field: `files.${i}`, message: "file not found, upload again" }]);
				}
			}
		}

		const keep = new Set(v.data.filter((f) => f.id).map((f) => f.id));
		const removed = existing.filter((e) => !keep.has(e.id));
		if (removed.length) await conn.query(`DELETE FROM ${P}products_downloads WHERE id IN (?)`, [removed.map((e) => e.id)]);

		for (const [i, f] of v.data.entries()) {
			let id = f.id;
			if (id) {
				// Файл існуючого запису не змінюється (новий файл = новий запис) — історія видач лишається коректною
				await conn.query(
					`UPDATE ${P}products_downloads SET id_variant = ?, version = ?, max_downloads = ?, expires_days = ?, sort_order = ? WHERE id = ?`,
					[f.id_variant, f.version, f.max_downloads, f.expires_days, i, id]
				);
			} else {
				const [r] = await conn.query(
					`INSERT INTO ${P}products_downloads (id_product, id_variant, file, original_name, mime, size, hash, version, max_downloads, expires_days, sort_order)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[idProduct, f.id_variant, f.file, f.original_name, f.mime, f.size, f.hash, f.version, f.max_downloads, f.expires_days, i]
				);
				id = r.insertId;
			}
			for (const [lang, n] of Object.entries(f.names)) {
				if (!n) await conn.query(`DELETE FROM ${P}products_downloads_description WHERE id_download = ? AND id_lang = ?`, [id, Number(lang)]);
				else await conn.query(`INSERT INTO ${P}products_downloads_description (id_download, id_lang, name) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = ?`, [id, Number(lang), n.name, n.name]);
			}
		}

		const removedFiles = removed.map((e) => e.file);
		return { saved: v.data.length, afterCommit: () => Promise.all(removedFiles.map(removeIfUnused)) };
	});
}

/** Віддати файл співробітнику (потоком, як вкладення) */
async function stream(idProduct, idDownload, res) {
	const [[row]] = await pool.query(`SELECT file, original_name, mime, size FROM ${P}products_downloads WHERE id = ? AND id_product = ?`, [idDownload, idProduct]);
	if (!row) throw httpErr(404, "Not found");
	const p = absPath(row.file);
	await fsp.access(p).catch(() => {
		throw httpErr(404, "File is missing in storage");
	});
	res.setHeader("Content-Type", row.mime || "application/octet-stream");
	res.setHeader("Content-Length", row.size);
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
	res.setHeader("Cache-Control", "private, no-store");
	res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(row.original_name)}"; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
	await pipeline(fs.createReadStream(p), res);
}

module.exports = { STORAGE, TMP, MAX_SIZE, ensureDirs, ingest, list, save, stream, removeIfUnused };