"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const history = require("../../../controllers/catalog/products/history");
const languages = require("../../../controllers/catalog/products/languages");
const { COST_FIELDS } = require("../../../controllers/catalog/products/products");

const P = config.get("configDatabase").prefix;
const SECRET_FIELDS = [...COST_FIELDS, "supplier_price"];

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? req.__(e.message) : req.__("catalog.common.server_error") });
	}
};

router.post(
	"/api/catalog/products/:id/history/",
	auth.isAuthenticated,
	(req, res, next) => (auth.hasPermission(req, "products.list", "view") ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") })),
	handle(async (req) => {
		if (!/^\d+$/.test(req.params.id)) throw Object.assign(new Error("Invalid id"), { status: 400 });
		const id = parseInt(req.params.id, 10);
		const b = req.body || {};
		const offset = Math.max(parseInt(b.offset, 10) || 0, 0);
		const limit = Math.min(Math.max(parseInt(b.limit, 10) || 30, 1), 100);
		const [[p]] = offset ? [[null]] : await pool.query(`SELECT price FROM ${P}products WHERE id = ?`, [id]);
		const r = await history.cardPage("products", id, {
			offset,
			limit,
			t: (k) => req.__(k),
			langs: await languages.active(),
			secret: auth.hasPermission(req, "products.cost", "view") ? [] : SECRET_FIELDS,
			price: p ? p.price : undefined,
		});
		return { ok: true, ...r };
	})
);

// Динаміка цін для графіка на картці: зміни ціни, старої ціни (і собівартості — з правом products.cost) з причинами
router.post(
	"/api/catalog/products/:id/history/prices/",
	auth.isAuthenticated,
	(req, res, next) => (auth.hasPermission(req, "products.list", "view") ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") })),
	handle(async (req) => {
		if (!/^\d+$/.test(req.params.id)) throw Object.assign(new Error("Invalid id"), { status: 400 });
		const id = parseInt(req.params.id, 10);
		const days = Math.min(Math.max(parseInt((req.body || {}).days, 10) || 0, 0), 3650);
		const cost = auth.hasPermission(req, "products.cost", "view");
		const base = ["price", "compare_at_price", ...(cost ? ["cost_price"] : [])];
		const [[p]] = await pool.query(`SELECT price, compare_at_price${cost ? ", cost_price" : ""} FROM ${P}products WHERE id = ?`, [id]);
		if (!p) throw Object.assign(new Error("Not found"), { status: 404 });
		// Варіанти товару — для вибору на графіку (історія варіанта — поля variant.<id>.<поле>)
		const [variants] = await pool.query(`SELECT id, sku, price, compare_at_price${cost ? ", cost_price" : ""} FROM ${P}products_variants WHERE id_product = ? ORDER BY sort_order, id`, [id]);
		const idVariant = parseInt((req.body || {}).variant, 10) || 0;
		const v = idVariant ? variants.find((x) => x.id === idVariant) : null;
		if (idVariant && !v) throw Object.assign(new Error("Variant not found"), { status: 404 });
		const src = v || p;
		const key = (f) => (v ? `variant.${v.id}.${f}` : f);
		const r = await history.priceTimeline("products", id, { days, fields: base.map(key) });
		// Для браузера — короткі імена полів (price, compare_at_price, cost_price)
		const short = (f) => (v ? f.split(".").slice(2).join(".") : f);
		const start = {};
		Object.entries(r.start).forEach(([f, val]) => (start[short(f)] = val));
		const now = {};
		base.forEach((f) => (now[f] = src[f] === null ? null : Number(src[f])));
		return {
			ok: true,
			fields: base,
			now,
			since: r.since,
			start,
			points: r.points.map((x) => ({ ...x, field: short(x.field) })),
			variants: variants.map((x) => ({ id: x.id, sku: x.sku })),
		};
	})
);

// Повернути зміни події (стан «до»)
router.post(
	"/api/catalog/products/:id/history/revert/",
	auth.isAuthenticated,
	(req, res, next) => (auth.hasPermission(req, "products.list", "edit") ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") })),
	handle(async (req) => {
		if (!/^\d+$/.test(req.params.id)) throw Object.assign(new Error("Invalid id"), { status: 400 });
		const id = parseInt(req.params.id, 10);
		const ts = String((req.body || {}).ts || "");
		if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(ts)) throw Object.assign(new Error("Invalid event"), { status: 400 });
		const r = await history.revertProduct(id, ts, req.user.userId);
		const { getIO } = require("../../../controllers/socket/socket");
		const io = getIO();
		if (io) io.to(require("../../../controllers/catalog/products/edit-lock").room(id)).emit("product:saved", { id, by: req.user.userId });
		return { ok: true, ...r };
	})
);

// ═══ Пакети: масове редагування й імпорт файлу — перегляд і відкат цілком ═══
const perm = (action) => (req, res, next) => (auth.hasPermission(req, "products.list", action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));

router.get("/catalog/history/", auth.isAuthenticated, (req, res) => {
	if (!auth.hasPermission(req, "products.list", "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	res.render("pages/catalog/products/history", {
		i18n: req,
		user: req.user,
		header: { navbar: "catalog", subnavbar: "products_history" },
		perms: { edit: auth.hasPermission(req, "products.list", "edit") },
	});
});

router.post(
	"/api/catalog/history/batches/",
	auth.isAuthenticated,
	perm("view"),
	handle(async (req) => {
		const b = req.body || {};
		const r = await history.batches({ offset: Math.max(parseInt(b.offset, 10) || 0, 0), limit: Math.min(Math.max(parseInt(b.limit, 10) || 30, 1), 100) });
		return { ok: true, ...r };
	})
);

router.post(
	"/api/catalog/history/batches/:id/revert/",
	auth.isAuthenticated,
	perm("edit"),
	handle(async (req) => {
		const r = await history.revertBatch(String(req.params.id), req.user.userId);
		require("../../../controllers/common/audit").log(req, { action: "revert", module: "products", entity: "history_batch", count: r.reverted + r.deleted + r.restored, details: { batch: req.params.id, ...r, skipped: r.skipped.length } });
		return { ok: true, ...r };
	})
);

module.exports = router;