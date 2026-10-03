"use strict";

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("./settings");

const P = config.get("configDatabase").prefix;
const ROOT = path.join(__dirname, "..", "..", "..", "assets", "images");
const KINDS = ["products", "categories", "brands"];
const MAX_PIXELS = 100 * 1000 * 1000; // 100 Мп — захист від decompression bomb

const FORMAT_MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif", gif: "image/gif", heif: "image/heif", tiff: "image/tiff" };
const EXT = { jpeg: "jpg", png: "png", webp: "webp", avif: "avif", gif: "gif" };
const FILE_RE = /^[0-9a-f]{2}\/[0-9a-f]{64}\.(webp|avif|jpg|png|gif)$/;

function httpErr(status, message) {
	const e = new Error(message);
	e.status = status;
	return e;
}

function assertKind(kind) {
	if (!KINDS.includes(kind)) throw new Error("images: unknown kind " + kind);
}

/** Абсолютний шлях з перевіркою формату імені — жодного path traversal */
function absPath(kind, file, thumbCode) {
	assertKind(kind);
	if (!FILE_RE.test(file)) throw httpErr(400, "Invalid image path");
	if (thumbCode && !/^[a-z0-9_]{1,32}$/.test(thumbCode)) throw httpErr(400, "Invalid thumbnail code");
	return thumbCode ? path.join(ROOT, kind, "cache", thumbCode, file) : path.join(ROOT, kind, file);
}

function url(kind, file, thumbCode) {
	if (!file) return null;
	return thumbCode ? `/assets/images/${kind}/cache/${thumbCode}/${file}` : `/assets/images/${kind}/${file}`;
}

async function writeAtomic(target, buffer, force) {
	await fs.mkdir(path.dirname(target), { recursive: true });
	if (!force) {
		try {
			await fs.access(target);
			return; // уже є (той самий хеш = той самий вміст)
		} catch {}
	}
	const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	await fs.writeFile(tmp, buffer, { mode: 0o644 });
	await fs.rename(tmp, target);
}

function encode(pipeline, format, quality, sourceFormat) {
	switch (format) {
		case "webp":
			return pipeline.webp({ quality, effort: 4 });
		case "avif":
			return pipeline.avif({ quality, effort: 4 });
		case "jpeg":
			return pipeline.flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true, progressive: true });
		case "original":
		default:
			if (sourceFormat === "png") return pipeline.png({ compressionLevel: 9, palette: false });
			if (sourceFormat === "gif") return pipeline.gif();
			if (sourceFormat === "webp") return pipeline.webp({ quality });
			if (sourceFormat === "avif") return pipeline.avif({ quality });
			return pipeline.jpeg({ quality, mozjpeg: true, progressive: true }); // heif/tiff → jpeg
	}
}

function targetFormat(cfgFormat, sourceFormat) {
	if (cfgFormat !== "original") return cfgFormat;
	return EXT[sourceFormat] ? sourceFormat : "jpeg";
}

async function watermarkLayer(cfg, width) {
	const wm = cfg.watermark;
	if (!wm || !wm.enabled || !wm.file) return null;
	const wmPath = path.join(ROOT, "products", path.normalize(wm.file).replace(/^(\.\.[/\\])+/, ""));
	if (!wmPath.startsWith(path.join(ROOT, "products") + path.sep)) return null;
	try {
		const targetWidth = Math.max(16, Math.round(width * wm.scale));
		const input = await sharp(wmPath).resize({ width: targetWidth, withoutEnlargement: false }).ensureAlpha().toBuffer();
		// Прозорість: множимо лише альфа-канал
		const layer = await sharp(input).linear([1, 1, 1, wm.opacity], [0, 0, 0, 0]).png().toBuffer();
		return { input: layer, gravity: wm.position };
	} catch (e) {
		console.error("[images] watermark skipped:", e.message);
		return null;
	}
}

/**
 * Обробити завантажене зображення.
 * kind: products | categories | brands; buffer — сирі байти файлу
 * Повертає { file, url, width, height, size, mime, hash }
 */
async function processUpload(kind, buffer) {
	assertKind(kind);
	const cfg = await settings.get("images");

	if (!Buffer.isBuffer(buffer) || !buffer.length) throw httpErr(400, "Empty file");
	if (buffer.length > cfg.max_file_mb * 1024 * 1024) throw httpErr(413, `File too large (max ${cfg.max_file_mb} MB)`);

	let meta;
	try {
		meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: "error" }).metadata();
	} catch {
		throw httpErr(415, "Unsupported or corrupted image");
	}
	const mime = FORMAT_MIME[meta.format];
	if (!mime || !cfg.allowed_mime.includes(mime)) throw httpErr(415, "Image format not allowed");

	const hash = crypto.createHash("sha256").update(buffer).digest("hex");
	const format = targetFormat(cfg.format, meta.format);
	const ext = EXT[format];
	const file = `${hash.slice(0, 2)}/${hash}.${ext}`;
	const animated = meta.format === "gif" && (meta.pages || 1) > 1 && (format === "gif" || format === "webp");

	let pipeline = sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: "error", animated })
		.rotate() // застосувати EXIF-орієнтацію до зрізання метаданих
		.resize({ width: cfg.max_width, height: cfg.max_height, fit: "inside", withoutEnlargement: true });
	if (!cfg.strip_metadata) pipeline = pipeline.keepIccProfile();

	// Водяний знак — лише для фото товарів і не для анімацій
	if (kind === "products" && !animated) {
		const finalWidth = Math.min(meta.autoOrient?.width || meta.width, cfg.max_width);
		const layer = await watermarkLayer(cfg, finalWidth);
		if (layer) pipeline = pipeline.composite([layer]);
	}

	const { data, info } = await encode(pipeline, format, cfg.quality, meta.format).toBuffer({ resolveWithObject: true });
	await writeAtomic(absPath(kind, file), data);

	if (cfg.keep_original) {
		const origExt = EXT[meta.format] || "bin";
		await writeAtomic(path.join(ROOT, kind, "original", hash.slice(0, 2), `${hash}.${origExt}`), buffer);
	}

	await Promise.all(cfg.thumbnails.map((t) => makeThumbnail(kind, file, data, t, format, cfg.quality)));

	return { file, url: url(kind, file), width: info.width, height: info.height, size: data.length, mime: FORMAT_MIME[format], hash };
}

async function makeThumbnail(kind, file, source, t, format, quality, force) {
	const target = absPath(kind, file, t.code);
	const transparent = format === "webp" || format === "avif" || format === "png" || format === "gif";
	const pipeline = sharp(source, { limitInputPixels: MAX_PIXELS }).resize({
		width: t.width,
		height: t.height,
		fit: t.fit,
		withoutEnlargement: t.fit === "inside",
		background: transparent ? { r: 255, g: 255, b: 255, alpha: 0 } : "#ffffff",
	});
	const out = await encode(pipeline, format === "gif" ? "webp" : format, quality, format).toBuffer();
	await writeAtomic(target, out, force);
}

/** Чи використовується файл деінде (дедуп за хешем → один файл може належати кільком записам) */
async function isReferenced(kind, file) {
	assertKind(kind);
	const checks = {
		products: [
			`SELECT 1 FROM ${P}products_media WHERE file = ? LIMIT 1`,
			`SELECT 1 FROM ${P}products_attribute_values WHERE image = ? LIMIT 1`,
			`SELECT 1 FROM ${P}products_option_values WHERE image = ? LIMIT 1`,
		],
		categories: [`SELECT 1 FROM ${P}products_categories WHERE image = ? OR icon = ? OR banner = ? LIMIT 1`],
		brands: [`SELECT 1 FROM ${P}products_brands WHERE logo = ? LIMIT 1`],
	}[kind];
	for (const sql of checks) {
		const n = (sql.match(/\?/g) || []).length;
		const [rows] = await pool.query(sql, Array(n).fill(file));
		if (rows.length) return true;
	}
	return false;
}

/** Видалити файл і всі мініатюри, лише якщо на нього більше ніхто не посилається */
async function removeIfUnused(kind, file) {
	if (!file || !FILE_RE.test(file)) return false;
	if (await isReferenced(kind, file)) return false;
	const cfg = await settings.get("images");
	const targets = [absPath(kind, file), ...cfg.thumbnails.map((t) => absPath(kind, file, t.code))];
	await Promise.all(targets.map((p) => fs.unlink(p).catch((e) => e.code !== "ENOENT" && console.error("[images] unlink", p, e.message))));
	return true;
}

module.exports = { KINDS, ROOT, FILE_RE, MAX_PIXELS, processUpload, removeIfUnused, isReferenced, url, absPath, makeThumbnail };