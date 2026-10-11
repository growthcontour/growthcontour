"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const trash = require("../../../controllers/common/trash");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("../../../controllers/catalog/products/settings");
const descriptions = require("../../../controllers/catalog/products/descriptions");
const products = require("../../../controllers/catalog/products/products");
const editLock = require("../../../controllers/catalog/products/edit-lock");
const { getIO } = require("../../../controllers/socket/socket");
const history = require("../../../controllers/catalog/products/history");
const customerGroups = require("../../../controllers/catalog/products/customer-groups");

const P = config.get("configDatabase").prefix;
const L = "products.list";

const can = (req, slug, action) => auth.hasPermission(req, slug, action);
const need = (action) => (req, res, next) => (can(req, L, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const intId = (v) => {
	const n = parseInt(v, 10);
	if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error("Invalid id"), { status: 400 });
	return n;
};
const langOf = (req) => req.user.id_lang || 1;
const permsOf = (req) => ({
	view: can(req, L, "view"),
	add: can(req, L, "add"),
	edit: can(req, L, "edit"),
	delete: can(req, L, "delete"),
	cost: can(req, "products.cost", "view"),
	stock: can(req, "products.stock", "edit"),
	locations: can(req, "products.warehouses", "view"),
	costEdit: can(req, "products.cost", "edit"),
	import: can(req, "products.import", "view"),
});

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({
			ok: false,
			error: e.status ? e.message : req.__("catalog.common.server_error"),
			errors: e.errors,
			code: e.code && !String(e.code).startsWith("ER_") ? e.code : undefined,
			version: e.version,
		});
	}
};

const forbiddenPage = (req, res) => res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });

async function dictionaries(idLang) {
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const [[taxClasses], [stockStatuses]] = await Promise.all([
		pool.query(
			`SELECT t.id, t.code, t.rate, COALESCE(NULLIF(d.name, ''), dp.name, t.code) AS name
			   FROM ${P}products_tax_classes t
			   LEFT JOIN ${P}products_tax_classes_description d  ON d.id_tax_class = t.id AND d.id_lang = ?
			   LEFT JOIN ${P}products_tax_classes_description dp ON dp.id_tax_class = t.id AND dp.id_lang = ?
			  WHERE t.status = 1 ORDER BY t.sort_order, t.id`,
			[idLang, primary]
		),
		pool.query(
			`SELECT s.id, s.code, COALESCE(NULLIF(d.name, ''), dp.name, s.code) AS name
			   FROM ${P}products_stock_statuses s
			   LEFT JOIN ${P}products_stock_statuses_description d  ON d.id_stock_status = s.id AND d.id_lang = ?
			   LEFT JOIN ${P}products_stock_statuses_description dp ON dp.id_stock_status = s.id AND dp.id_lang = ?
			  ORDER BY s.sort_order, s.id`,
			[idLang, primary]
		),
	]);
	return { languages: langs, taxClasses, stockStatuses, customerGroups: await customerGroups.options() };
}

// ═══ СТОРІНКИ ══════════════════════════════════════════
const num = (v) => Number(v || 0);

async function catalogOverview(idLang, withStock) {
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const q = (sql, params) => pool.query(sql, params).then(([rows]) => rows);
	const [[pr], [cat], [br], [st], [rv], recent] = await Promise.all([
		q(`SELECT COUNT(*) AS total, SUM(status = 'active') AS active, SUM(status = 'draft') AS draft, SUM(status = 'archived') AS archived,
		          ROUND(AVG(quality_score)) AS quality_avg, SUM(quality_score < 50) AS quality_low
		     FROM ${P}products WHERE deleted_at IS NULL`),
		q(`SELECT COUNT(*) AS total FROM ${P}products_categories`),
		q(`SELECT COUNT(*) AS total FROM ${P}products_brands WHERE deleted_at IS NULL`),
		withStock
			? q(`SELECT COUNT(*) AS low FROM ${P}products_stock s
			       JOIN ${P}products p ON p.id = s.id_product AND p.deleted_at IS NULL AND p.track_inventory = 1
			       JOIN ${P}products_warehouses w ON w.id = s.id_warehouse AND w.deleted_at IS NULL AND w.status = 1
			      WHERE s.reorder_point IS NOT NULL AND s.available <= s.reorder_point`)
			: [{}],
		q(`SELECT SUM(status = 'pending') AS pending, COUNT(*) AS total FROM ${P}products_reviews WHERE deleted_at IS NULL`),
		q(
			`SELECT p.id, p.sku, p.status, p.date_edit, p.quality_score, COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', p.id)) AS name
		     FROM ${P}products p
		     LEFT JOIN ${P}products_description d  ON d.id_product = p.id AND d.id_lang = ?
		     LEFT JOIN ${P}products_description dp ON dp.id_product = p.id AND dp.id_lang = ?
		    WHERE p.deleted_at IS NULL ORDER BY p.date_edit DESC, p.id DESC LIMIT 8`,
			[idLang, primary]
		),
	]);
	return {
		products: { total: num(pr.total), active: num(pr.active), draft: num(pr.draft), archived: num(pr.archived), quality_avg: pr.quality_avg === null ? null : num(pr.quality_avg), quality_low: num(pr.quality_low) },
		categories: num(cat.total),
		brands: num(br.total),
		stockLow: num(st.low),
		reviews: { pending: num(rv.pending), total: num(rv.total) },
		recent,
	};
}

async function stockOverview(idLang) {
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const q = (sql, params) => pool.query(sql, params).then(([rows]) => rows);
	const [warehouses, [low], [res], [docs], movements] = await Promise.all([
		q(`SELECT w.id, w.code, w.name, w.status, w.is_sellable,
		          COALESCE(SUM(s.on_hand), 0) AS on_hand, COALESCE(SUM(s.reserved), 0) AS reserved, COALESCE(SUM(s.available), 0) AS available,
		          COUNT(DISTINCT CASE WHEN s.on_hand <> 0 THEN s.id_product END) AS products
		     FROM ${P}products_warehouses w
		     LEFT JOIN ${P}products_stock s ON s.id_warehouse = w.id
		    WHERE w.deleted_at IS NULL
		    GROUP BY w.id ORDER BY w.priority, w.sort_order, w.id`),
		q(`SELECT COUNT(*) AS n FROM ${P}products_stock s
		     JOIN ${P}products p ON p.id = s.id_product AND p.deleted_at IS NULL AND p.track_inventory = 1
		     JOIN ${P}products_warehouses w ON w.id = s.id_warehouse AND w.deleted_at IS NULL AND w.status = 1
		    WHERE s.reorder_point IS NOT NULL AND s.available <= s.reorder_point`),
		q(`SELECT COUNT(DISTINCT ref_type, ref_id) AS refs, COALESCE(SUM(qty), 0) AS qty FROM ${P}products_stock_reservations`),
		q(`SELECT COUNT(*) AS drafts FROM ${P}products_stock_documents WHERE status = 'draft'`),
		q(
			`SELECT m.id, m.id_product, m.type, m.qty, m.date_add, w.name AS warehouse,
		          COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', m.id_product)) AS name
		     FROM ${P}products_stock_movements m
		     JOIN ${P}products_warehouses w ON w.id = m.id_warehouse
		     LEFT JOIN ${P}products_description d  ON d.id_product = m.id_product AND d.id_lang = ?
		     LEFT JOIN ${P}products_description dp ON dp.id_product = m.id_product AND dp.id_lang = ?
		    WHERE m.field = 'on_hand'
		    ORDER BY m.id DESC LIMIT 10`,
			[idLang, primary]
		),
	]);
	return {
		warehouses: warehouses.map((w) => ({ ...w, on_hand: Number(w.on_hand), reserved: Number(w.reserved), available: Number(w.available), products: num(w.products) })),
		low: num(low.n),
		reserved: { refs: num(res.refs), qty: Number(res.qty) },
		drafts: num(docs.drafts),
		movements,
	};
}

// Огляд каталогу
router.get("/catalog/", auth.isAuthenticated, async (req, res, next) => {
	try {
		const perms = {
			list: can(req, L, "view"),
			add: can(req, L, "add"),
			categories: can(req, "products.categories", "view"),
			brands: can(req, "products.brands", "view"),
			attributes: can(req, "products.attributes", "view"),
			options: can(req, "products.options", "view"),
			import: can(req, "products.import", "view"),
			sync: can(req, "products.sync", "view"),
			stock: can(req, "products.warehouses", "view") || can(req, "products.suppliers", "view") || can(req, "products.stock", "view"),
			settings: can(req, "products.settings", "view"),
		};
		if (!Object.values(perms).some(Boolean)) return forbiddenPage(req, res);
		res.render("pages/catalog/products/catalog", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "catalog_overview" },
			perms,
			data: await catalogOverview(langOf(req), perms.stock),
		});
	} catch (e) {
		next(e);
	}
});

// Огляд складу
router.get("/catalog/stock/", auth.isAuthenticated, async (req, res, next) => {
	const perms = {
		warehouses: can(req, "products.warehouses", "view"),
		suppliers: can(req, "products.suppliers", "view"),
		stock: can(req, "products.stock", "view"),
		stockAdd: can(req, "products.stock", "add"),
	};
	if (!perms.warehouses && !perms.suppliers && !perms.stock) return forbiddenPage(req, res);
	try {
		res.render("pages/catalog/products/stock", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "stock_overview" },
			perms,
			data: await stockOverview(langOf(req)),
		});
	} catch (e) {
		next(e);
	}
});

// Список товарів
router.get("/catalog/products/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, L, "view")) return forbiddenPage(req, res);
	try {
		const all = await settings.getAll();
		res.render("pages/catalog/products/index", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_list" },
			perms: permsOf(req),
			perPage: all.card.per_page,
			currency: all.prices.base_currency,
		});
	} catch (e) {
		next(e);
	}
});

async function renderCard(req, res, next, id) {
	try {
		const [all, dict] = await Promise.all([settings.getAll(), dictionaries(langOf(req))]);
		res.render("pages/catalog/products/card", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_list" },
			perms: permsOf(req),
			productId: id,
			cfg: {
				currency: all.prices.base_currency,
				units: all.units,
				defaultStatus: all.card.default_status,
				defaultAttributeSet: all.card.id_default_attribute_set,
				skuAuto: all.sku.auto,
				eanAuto: all.ean.auto,
				lock: all.edit_lock,
			},
			...dict,
		});
	} catch (e) {
		next(e);
	}
}

// Новий товар
router.get("/catalog/products/new/", auth.isAuthenticated, (req, res, next) => {
	if (!can(req, L, "add")) return forbiddenPage(req, res);
	renderCard(req, res, next, null);
});

// Картка товару
router.get("/catalog/products/:id/", auth.isAuthenticated, (req, res, next) => {
	if (!/^\d+$/.test(req.params.id)) return next();
	if (!can(req, L, "view")) return forbiddenPage(req, res);
	renderCard(req, res, next, parseInt(req.params.id, 10));
});

// ═══ API ═══════════════════════════════════════════════
router.post(
	"/api/catalog/products/list/",
	auth.isAuthenticated,
	need("view"),
	handle(async (req) => products.list(req.body || {}, langOf(req), permsOf(req)))
);

router.post(
	"/api/catalog/products/search/",
	auth.isAuthenticated,
	need("view"),
	handle(async (req) => ({ ok: true, rows: await products.search((req.body || {}).search, langOf(req), parseInt((req.body || {}).exclude, 10) || 0) }))
);

router.post(
	"/api/catalog/products/:id/get/",
	auth.isAuthenticated,
	need("view"),
	handle(async (req) => ({ ok: true, row: await products.get(intId(req.params.id), langOf(req), permsOf(req)) }))
);

router.post(
	"/api/catalog/products/save/",
	auth.isAuthenticated,
	(req, res, next) => need(req.body && req.body.id ? "edit" : "add")(req, res, next),
	handle(async (req) => {
		const id = req.body.id ? intId(req.body.id) : null;
		const r = await products.save(id, req.body, {
			idUser: req.user.userId,
			perms: permsOf(req),
			lockToken: req.body.lock_token,
			version: req.body.version,
		});
		audit.log(req, { action: id ? "update" : "create", module: "products", entity: "product", id_entity: r.id, count: 1, details: r.changed ? { changed: r.changed } : {} });
		// Глядачам карточки: товар оновлено
		const io = getIO();
		if (io && id) io.to(editLock.room(id)).emit("product:saved", { id, version: r.version, by: req.user.userId });
		return { ok: true, id: r.id, version: r.version };
	})
);

router.post(
	"/api/catalog/products/:id/copy/",
	auth.isAuthenticated,
	need("add"),
	handle(async (req) => {
		const src = intId(req.params.id);
		const id = await products.copy(src, req.user.userId);
		await history.record("products", id, { user: req.user.userId, source: "copy", action: "create", meta: { copied_from: src } });
		audit.log(req, { action: "create", module: "products", entity: "product", id_entity: id, count: 1, details: { copied_from: src } });
		return { ok: true, id };
	})
);

router.post(
	"/api/catalog/products/:id/delete/",
	auth.isAuthenticated,
	need("delete"),
	handle(async (req) => {
		const id = intId(req.params.id);
		const holder = await editLock.holder(id);
		if (holder && holder.id_user !== req.user.userId) throw Object.assign(new Error(req.__("catalog.products.locked_by_other")), { status: 423, code: "locked" });
		await trash.softDelete("products", id, req.user.userId);
		await history.record("products", id, { user: req.user.userId, source: "card", action: "delete" });
		audit.log(req, { action: "delete", module: "products", entity: "product", id_entity: id, count: 1 });
		const io = getIO();
		if (io) io.to(editLock.room(id)).emit("product:deleted", { id });
		return { ok: true };
	})
);

module.exports = router;
