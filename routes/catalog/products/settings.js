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
// Валюти й курси: окреме право products.currencies, якщо його додано в групи; інакше — як налаштування товарів
const CUR_SLUG = "products.currencies";
const canCur = (req, action) => (req.user && req.user.permissions && req.user.permissions[CUR_SLUG] ? auth.hasPermission(req, CUR_SLUG, action) : can(req, action));
const needCur = (action) => (req, res, next) => (canCur(req, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.products.settings.forbidden") }));
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
router.get("/catalog/settings/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.products.settings.forbidden"), error: { status: 403 } });
	try {
		const [[current], [languages], [warehouses]] = await Promise.all([settings.getAll().then((s) => [s]), pool.query(`SELECT id, iso FROM ${P}languages WHERE active = 1 ORDER BY id`), pool.query(`SELECT id, code, name FROM ${P}products_warehouses WHERE deleted_at IS NULL AND status = 1 ORDER BY priority, sort_order, id`)]);
		// Довідники для правил формули ціни: бренди, категорії (шляхом), постачальники — основною мовою
		const [[lang]] = await pool.query(`SELECT id FROM ${P}products_languages WHERE status = 1 ORDER BY is_primary DESC, sort_order, id LIMIT 1`).catch(() => [[null]]);
		const idLang = lang ? lang.id : 1;
		const [[brands], [categories], [suppliers]] = await Promise.all([
			pool.query(`SELECT b.id, COALESCE(NULLIF(d.name, ''), CONCAT('#', b.id)) AS name FROM ${P}products_brands b LEFT JOIN ${P}products_brands_description d ON d.id_brand = b.id AND d.id_lang = ? WHERE b.deleted_at IS NULL ORDER BY name LIMIT 3000`, [idLang]).catch(() => [[]]),
			pool
				.query(
					`SELECT c.id, GROUP_CONCAT(COALESCE(NULLIF(d.name, ''), CONCAT('#', pp.id_ancestor)) ORDER BY pp.depth DESC SEPARATOR ' › ') AS name
					   FROM ${P}products_categories c
					   JOIN ${P}products_categories_path pp ON pp.id_category = c.id
					   LEFT JOIN ${P}products_categories_description d ON d.id_category = pp.id_ancestor AND d.id_lang = ?
					  WHERE c.deleted_at IS NULL GROUP BY c.id ORDER BY name LIMIT 5000`,
					[idLang]
				)
				.catch(() => [[]]),
			pool.query(`SELECT id, name FROM ${P}products_suppliers WHERE deleted_at IS NULL ORDER BY name LIMIT 3000`).catch(() => [[]]),
		]);
		res.render("pages/catalog/products/settings", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_settings" },
			current,
			languages,
			warehouses,
			formulaDict: { brands, categories, suppliers },
			canEdit: can(req, "edit"),
			canCur: canCur(req, "edit"),
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

// ─── ВАЛЮТИ ──────────────────────────────────────────
const pricing = require("../../../controllers/catalog/products/pricing");

// Довідник, журнал курсів, модулі курсів
router.post(
	"/api/catalog/products/currencies/get/",
	auth.isAuthenticated,
	needCur("view"),
	handle(async () => ({
		ok: true,
		currencies: await settings.get("currencies"),
		base: (await settings.get("prices")).base_currency,
		providers: pricing.providerList(),
		// Джерела модулів з останнім станом (час, помилка, курси)
		sources: pricing.providersOverview(),
	}))
);

// «Перевірити» джерело: курси для всіх валют довідника поруч із поточними — нічого не застосовує
router.post(
	"/api/catalog/products/currencies/provider/test/",
	auth.isAuthenticated,
	needCur("edit"),
	handle(async (req) => {
		const key = String((req.body || {}).key || "");
		try {
			return { ok: true, rows: await pricing.testProvider(key), sources: pricing.providersOverview() };
		} catch (e) {
			if (e.status) throw e;
			return { ok: false, error: String(e.message || e), sources: pricing.providersOverview() };
		}
	})
);

// Зміна основної валюти: apply = false — огляд (скільки товарів, приклад), true — перехід із перерахунком усіх цін
router.post(
	"/api/catalog/products/currencies/base/",
	auth.isAuthenticated,
	needCur("edit"),
	handle(async (req) => {
		const b = req.body || {};
		const r = await pricing.changeBase({
			code: b.code,
			rate: Number(b.rate),
			mode: b.mode,
			round: b.round,
			step: Number(b.step),
			minus: Number(b.minus),
			name: b.name,
			symbol: b.symbol,
			apply: b.apply === true,
			idUser: req.user.userId,
		});
		if (b.apply === true) audit.log(req, { action: "currency_base", module: "products", entity: "currencies", count: 1, details: { from: r.from, to: r.to, rate: r.rate, mode: b.mode } });
		return { ok: true, info: r, currencies: await settings.get("currencies"), base: (await settings.get("prices")).base_currency };
	})
);

// Курс, затриманий захистом від стрибка: прийняти / відхилити
router.post(
	"/api/catalog/products/currencies/accept/",
	auth.isAuthenticated,
	needCur("edit"),
	handle(async (req) => {
		const b = req.body || {};
		const r = await pricing.acceptSuggested(String(b.code || "").toUpperCase(), b.accept !== false, req.user.userId);
		audit.log(req, { action: "currency_accept", module: "products", entity: "currencies", count: 1, details: { code: b.code, accept: b.accept !== false } });
		return { ok: true, ...r, currencies: await settings.get("currencies") };
	})
);

// Зберегти довідник (нові курси — у журнал; перерахунок цін за правилами кожної валюти)
router.post(
	"/api/catalog/products/currencies/save/",
	auth.isAuthenticated,
	needCur("edit"),
	handle(async (req) => {
		const r = await pricing.saveCurrencies((req.body || {}).list, req.user.userId, (req.body || {}).base_format);
		audit.log(req, { action: "settings_save", module: "products", entity: "currencies", count: 1, details: { changed: r.changed, recalculated: r.recalculated } });
		return { ok: true, ...r };
	})
);

// Перерахунок цін: preview — що зміниться; apply — застосувати (codes порожньо — усі валюти)
router.post(
	"/api/catalog/products/currencies/recalc/",
	auth.isAuthenticated,
	needCur("edit"),
	handle(async (req) => {
		const b = req.body || {};
		const codes = (Array.isArray(b.codes) ? b.codes : []).map((c) => String(c).toUpperCase());
		const r = await pricing.recalcCurrencies({ codes, apply: !!b.apply, idUser: req.user.userId });
		if (b.apply) audit.log(req, { action: "currency_recalc", module: "products", entity: "currencies", count: r.products, details: { codes: r.codes, options: r.options } });
		return { ok: true, ...r };
	})
);

// Курси від модулів зараз (не чекаючи щогодинного оновлення)
router.post(
	"/api/catalog/products/currencies/pull/",
	auth.isAuthenticated,
	needCur("edit"),
	handle(async () => ({ ok: true, result: await pricing.runProviders(), currencies: await settings.get("currencies"), sources: pricing.providersOverview() }))
);

// Ціна за формулою: перегляд / застосування для всіх товарів «за формулою»
router.post(
	"/api/catalog/products/formula/recalc/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const b = req.body || {};
		const r = await pricing.recalcFormula({ apply: !!b.apply, idUser: req.user.userId });
		if (b.apply) audit.log(req, { action: "formula_recalc", module: "products", entity: "price_formula", count: r.products, details: {} });
		return { ok: true, ...r };
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
