"use strict";

/**
 * Промокоди: сторінка «Замовлення → Промокоди» і API.
 * Права — налаштування замовлень (orders.settings): перегляд / зміни.
 */

const express = require("express");
const router = express.Router();

const auth = require("../../controllers/authorization/authorization");
const logging = require("../../logging/logging");
const promo = require("../../controllers/orders/promo");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;
const PERM = "orders.settings";

const id = (v) => {
	const n = parseInt(v, 10);
	if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error("orders.promo.e.not_found"), { status: 404, i18nKey: "orders.promo.e.not_found" });
	return n;
};
const can = (action) => (req, res, next) => (auth.hasPermission(req, PERM, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const handle = (fn) => async (req, res) => {
	try {
		res.json({ ok: true, ...(await fn(req)) });
	} catch (e) {
		if (!e.status) logging.error(e);
		const errors = e.errors ? Object.fromEntries(Object.entries(e.errors).map(([k, v]) => [k, req.__(v)])) : undefined;
		res.status(e.status || 500).json({ ok: false, error: e.i18nKey ? req.__(e.i18nKey, e.vars || {}) : req.__("catalog.common.server_error"), errors });
	}
};
const userId = (req) => req.user.userId || req.user.id;

router.get("/orders/promo/", auth.isAuthenticated, async (req, res) => {
	if (!auth.hasPermission(req, PERM, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	try {
		await promo.ensureSchema();
		// Канали продажу — для обмеження промокоду
		const [channels] = await pool.query(`SELECT id, name, platform FROM ${P}settings_integrations ORDER BY name`).catch(() => [[]]);
		res.render("pages/orders/promo", {
			i18n: req,
			user: req.user,
			header: { navbar: "orders" },
			perms: { edit: auth.hasPermission(req, PERM, "edit") },
			channels,
			baseCurrency: require("../../controllers/orders/currency").BASE_CURRENCY,
		});
	} catch (e) {
		logging.error(e);
		res.status(500).render("pages/error/404", { message: req.__("catalog.common.server_error"), error: { status: 500 } });
	}
});

const V = [auth.isAuthenticated, can("view")];
const E = [auth.isAuthenticated, can("edit")];
router.post("/api/orders/promo/list/", V, handle(async (req) => promo.list(req.body || {})));
router.post("/api/orders/promo/save/", E, handle(async (req) => ({ item: await promo.save(parseInt((req.body || {}).id, 10) || null, req.body || {}, userId(req)) })));
router.post("/api/orders/promo/generate/", E, handle(async (req) => ({ code: promo.generate((req.body || {}).prefix, Math.max(4, Math.min(16, parseInt((req.body || {}).length, 10) || 8))) })));
router.post("/api/orders/promo/:id/get/", V, handle(async (req) => ({ item: await promo.get(id(req.params.id)) })));
router.post("/api/orders/promo/:id/uses/", V, handle(async (req) => ({ rows: await promo.uses(id(req.params.id)) })));
router.post("/api/orders/promo/:id/delete/", E, handle(async (req) => promo.remove(id(req.params.id))));
// Пошук категорій і товарів для обмежень промокоду
router.post(
	"/api/orders/promo/lookup/",
	V,
	handle(async (req) => {
		const b = req.body || {};
		const q = String(b.q || "")
			.trim()
			.slice(0, 100);
		const like = `%${q.replace(/[\\%_]/g, (x) => "\\" + x)}%`;
		const lang = req.user.id_lang || 1;
		if (b.kind === "categories") {
			const [rows] = await pool.query(
				`SELECT c.id, COALESCE(MAX(CASE WHEN d.id_lang = ? THEN d.name END), MAX(d.name)) AS name FROM ${P}products_categories c
				   JOIN ${P}products_categories_description d ON d.id_category = c.id
				  WHERE c.deleted_at IS NULL AND ${Array.isArray(b.ids) ? "c.id IN (?)" : "d.name LIKE ?"} GROUP BY c.id ORDER BY name LIMIT 30`,
				[lang, Array.isArray(b.ids) ? (b.ids.length ? b.ids.map(Number) : [0]) : like]
			);
			return { rows };
		}
		const [rows] = await pool.query(
			`SELECT p.id, p.sku, COALESCE(MAX(CASE WHEN d.id_lang = ? THEN d.name END), MAX(d.name)) AS name FROM ${P}products p
			   JOIN ${P}products_description d ON d.id_product = p.id
			  WHERE p.deleted_at IS NULL AND ${Array.isArray(b.ids) ? "p.id IN (?)" : "(p.sku LIKE ? OR d.name LIKE ? OR p.id = ?)"} GROUP BY p.id, p.sku ORDER BY p.id DESC LIMIT 30`,
			[lang, ...(Array.isArray(b.ids) ? [b.ids.length ? b.ids.map(Number) : [0]] : [like, like, /^\d+$/.test(q) ? Number(q) : 0])]
		);
		return { rows };
	})
);

module.exports = router;