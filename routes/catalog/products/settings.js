"use strict";

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs/promises");
const sharp = require("sharp");

const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("../../../controllers/catalog/products/settings");

const P = config.get("configDatabase").prefix;
const SLUG = "products.settings";
const WATERMARK_DIR = path.join(__dirname, "..", "..", "..", "assets", "images", "products", "watermark");

const can = (req, action) => auth.hasPermission(req, SLUG, action);
const need = (action) => (req, res, next) => (can(req, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.products.settings.forbidden") }));

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.products.settings.server_error"), errors: e.errors });
	}
};

// Водяний знак: один файл, 2 МБ, у пам'яті (далі перевіряється й перекодовується sharp-ом)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } }).single("file");
const uploadSafe = (req, res, next) =>
	upload(req, res, (err) => {
		if (!err) return next();
		const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
		res.status(status).json({ ok: false, error: err.message });
	});

// ─── СТОРІНКА ────────────────────────────────────────
router.get("/catalog/products/settings/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.products.settings.forbidden"), error: { status: 403 } });
	try {
		const [[current], [languages], [warehouses]] = await Promise.all([
			settings.getAll().then((s) => [s]),
			pool.query(`SELECT id, iso FROM ${P}languages WHERE active = 1 ORDER BY id`),
			pool.query(`SELECT id, code, name FROM ${P}products_warehouses WHERE deleted_at IS NULL AND status = 1 ORDER BY priority, sort_order, id`),
		]);
		res.render("pages/catalog/products/settings", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_settings" },
			current,
			languages,
			warehouses,
			canEdit: can(req, "edit"),
		});
	} catch (e) {
		next(e);
	}
});

// ─── API ─────────────────────────────────────────────
router.post(
	"/api/catalog/products/settings/get/",
	auth.isAuthenticated,
	need("view"),
	handle(async () => ({ ok: true, settings: await settings.getAll() }))
);

router.post(
	"/api/catalog/products/settings/:key/save/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const key = String(req.params.key);
		if (!settings.KEYS.includes(key)) throw Object.assign(new Error("Unknown settings block"), { status: 404 });
		const saved = await settings.save(key, (req.body || {}).value, req.user.userId);
		audit.log(req, { action: "settings_save", module: "products", entity: key, count: 1, details: { value: saved } });
		return { ok: true, value: saved };
	})
);

router.post(
	"/api/catalog/products/settings/watermark/upload/",
	auth.isAuthenticated,
	need("edit"),
	uploadSafe,
	handle(async (req) => {
		const buf = req.file && req.file.buffer;
		if (!buf) throw Object.assign(new Error(req.__("catalog.products.settings.watermark_required")), { status: 400 });
		let meta;
		try {
			meta = await sharp(buf, { limitInputPixels: 25e6, failOn: "error" }).metadata();
		} catch {
			throw Object.assign(new Error(req.__("catalog.products.settings.watermark_invalid")), { status: 415 });
		}
		if (!["png", "webp"].includes(meta.format)) throw Object.assign(new Error(req.__("catalog.products.settings.watermark_invalid")), { status: 415 });

		// Перекодовуємо в PNG з альфа-каналом — у файл не потрапить нічого, крім пікселів
		const png = await sharp(buf).ensureAlpha().png({ compressionLevel: 9 }).toBuffer();
		const hash = crypto.createHash("sha256").update(png).digest("hex");
		const name = `${hash}.png`;
		await fs.mkdir(WATERMARK_DIR, { recursive: true });
		await fs.writeFile(path.join(WATERMARK_DIR, name), png, { mode: 0o644 });

		const current = await settings.get("images");
		const saved = await settings.save("images", { ...current, watermark: { ...current.watermark, file: `watermark/${name}` } }, req.user.userId);
		audit.log(req, { action: "settings_save", module: "products", entity: "images.watermark", count: 1, details: { file: `watermark/${name}` } });
		return { ok: true, value: saved, url: `/assets/images/products/watermark/${name}` };
	})
);

module.exports = router;