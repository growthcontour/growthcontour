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
const syncProducts = require("../../../controllers/catalog/products/sync-products");
const categoriesCtl = require("../../../controllers/catalog/products/categories");
const attributesCtl = require("../../../controllers/catalog/products/attributes");
const optionsCtl = require("../../../controllers/catalog/products/options");
const brandsCtl = require("../../../controllers/catalog/products/brands");
const suppliersCtl = require("../../../controllers/catalog/products/suppliers");
const warehousesCtl = require("../../../controllers/catalog/products/warehouses");
const pricing = require("../../../controllers/catalog/products/pricing");
const seo = require("../../../controllers/catalog/products/seo");
const assortment = require("../../../controllers/settings/integrations/assortment");

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
	publish: can(req, "products.sync", "edit"),
});

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		console.error("[products api]", req.originalUrl, e);
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
			currencies: (all.currencies.list || []).filter((c) => c.active !== false).map((c) => c.code).filter((c) => c !== all.prices.base_currency),
			publishing: all.publishing.enabled,
		});
	} catch (e) {
		next(e);
	}
});

// ─── Картка товару: усі дані готуються тут, шаблон лише підставляє значення ───
const pad2 = (n) => String(n).padStart(2, "0");
const toDateTimeInput = (x) => (!x ? "" : x instanceof Date ? `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}T${pad2(x.getHours())}:${pad2(x.getMinutes())}` : String(x).replace(" ", "T").slice(0, 16));
const toDateInput = (x) => toDateTimeInput(x).slice(0, 10);
const toDateText = (x) => toDateTimeInput(x).replace("T", " ");
const numText = (x, digits) => Number(x || 0).toLocaleString("uk-UA", digits === undefined ? {} : { maximumFractionDigits: digits });
const VALUE_OPTION_TYPES = ["select", "radio", "checkbox", "color"];
const QUALITY_RULES = ["images", "images_3", "description", "short_description", "category", "brand", "sku", "gtin", "price", "translations", "shipping", "attributes"];

// Значення за замовчуванням нового товару (ті самі, що в схемі)
const NEW_PRODUCT = {
	type: "simple",
	visibility: "all",
	item_condition: "new",
	sort_order: 0,
	price: 0,
	min_qty: 1,
	qty_step: 1,
	out_of_stock_action: "default",
	delivery_time_type: "default",
	redirect_type: "none",
	show_price: 1,
	available_for_order: 1,
	track_inventory: 1,
	subtract_stock: 1,
	requires_shipping: 1,
	robots_index: 1,
	robots_follow: 1,
	is_featured: 0,
	on_sale_flag: 0,
	online_only: 0,
	show_condition: 0,
	price_on_request: 0,
	low_stock_alert: 0,
	sold_individually: 0,
	allow_gift_wrap: 0,
	slug_shared: 0,
	descriptions: {},
	categories: [],
	media: [],
	attributes: [],
	options: [],
	customization: [],
	stock: [],
	prices: [],
	rewards: [],
	customer_groups: [],
	related: [],
	suppliers: [],
	lock: null,
};

async function renderCard(req, res, next, id) {
	try {
		const t = (k) => req.__(k);
		// Час кроків картки: якщо відкриття довше 1,5 с — пишемо в журнал (logs/info.log), що саме гальмує
		const tm0 = Date.now();
		const marks = [];
		const mark = (name) => marks.push(name + ":" + (Date.now() - tm0));
		const idLang = langOf(req);
		const perms = permsOf(req);
		const [all, dict, categoriesTree, attrDict, attrSets, optDict, brandOptions, supplierOptions] = await Promise.all([settings.getAll(), dictionaries(idLang), categoriesCtl.tree(idLang, { counts: false }), attributesCtl.dictionary(idLang), attributesCtl.listSets(), optionsCtl.dictionary(idLang), brandsCtl.options("", idLang), suppliersCtl.options("")]);
		mark("dictionaries");
		const languages = dict.languages;
		const primaryLang = languages[0] ? languages[0].id : 0;

		let product;
		if (id) {
			try {
				product = await products.get(id, idLang, perms);
			} catch (e) {
				if (e.status === 404) return next();
				throw e;
			}
		} else {
			const set = all.card.id_default_attribute_set ? await attributesCtl.getSet(all.card.id_default_attribute_set).catch(() => null) : null;
			product = {
				...NEW_PRODUCT,
				status: all.card.default_status,
				id_attribute_set: all.card.id_default_attribute_set,
				attributes: set ? set.items.map((it) => ({ id_attribute: it.id_attribute, value_ids: [], number: null, date: null, text: {} })) : [],
			};
		}

		mark("product");

		// Незалежні частини картки — паралельно, поки готуються форми
		const canSecret = can(req, "products.cost", "view");
		// Помилку прочитаємо при await; обробник одразу — щоб Node не вважав її необробленою до того
		const keep = (p) => (p && p.catch(() => {}), p);
		const pSeo = seo.effectiveAll("products", id || null, {}).catch(() => ({ limits: { title_max: 60, description_max: 160 }, langs: [] }));
		const pPublish = keep(id && all.publishing.enabled ? Promise.all([syncProducts.publishState(id, all.publishing), syncProducts.readiness([id], { fresh: false })]) : null);
		const pChannels = keep(id ? assortment.forEntity("product", id).catch(() => []) : Promise.resolve([]));
		const pSchedule = keep(id ? pricing.listSchedule(id) : Promise.resolve([]));
		const pHistory = keep(id ? history.cardPage("products", id, { offset: 0, limit: 30, t, langs: languages, secret: canSecret ? [] : [...products.COST_FIELDS, "supplier_price"], price: product.price }) : null);
		const pLocations = keep(Promise.all(product.stock.map((s) => (perms.locations ? warehousesCtl.listLocations(s.id_warehouse).catch(() => []) : Promise.resolve([])))));

		// Дати — одразу у форматі полів форми
		["available_date", "preorder_release_date"].forEach((k) => (product[k] = toDateInput(product[k])));
		["published_at", "unpublished_at"].forEach((k) => (product[k] = toDateTimeInput(product[k])));
		product.prices = product.prices.map((x) => ({ ...x, date_start: toDateTimeInput(x.date_start), date_end: toDateTimeInput(x.date_end) }));
		product.descriptions = product.descriptions || {};
		languages.forEach((l) => (product.descriptions[l.id] = product.descriptions[l.id] || {}));

		const title = id ? product.descriptions[primaryLang].name || "#" + id : t("catalog.products.add");
		const meta = id ? `ID ${product.id} · UUID ${product.uuid} · ${t("catalog.products.f.date_add")}: ${toDateText(product.date_add)} · ${t("catalog.products.f.date_edit")}: ${toDateText(product.date_edit)}` : "";

		// Бренд, якого немає серед перших 50
		if (product.id_brand && !brandOptions.some((b) => b.id === product.id_brand)) {
			const [[b]] = await pool.query(`SELECT b.id, MIN(d.name) AS name FROM ${P}products_brands b LEFT JOIN ${P}products_brands_description d ON d.id_brand = b.id WHERE b.id = ? GROUP BY b.id`, [product.id_brand]);
			brandOptions.push({ id: product.id_brand, name: (b && b.name) || "#" + product.id_brand });
		}

		// Групи покупців: «усі» + активні + невідомі з даних товару
		const groupList = [{ id: 0, name: t("catalog.groups.all") }, ...dict.customerGroups.map((g) => ({ id: g.id, name: g.name }))];
		[...product.prices, ...product.rewards].forEach((x) => {
			const gid = Number(x.id_customer_group || 0);
			if (!groupList.some((g) => g.id === gid)) groupList.push({ id: gid, name: "#" + gid });
		});

		// Залишки з комірками складів
		const locs = await pLocations;
		const stockRows = product.stock.map((s, i) => ({
			...s,
			on_hand: Number(s.on_hand),
			reserved_text: numText(s.reserved),
			incoming_text: numText(s.incoming),
			available_text: numText(s.available),
			locations: locs[i] || [],
		}));

		// Категорії: плоский список з глибиною; data-search — назва разом з усіма вкладеними (для пошуку)
		const selectedCats = new Set(product.categories.map(Number));
		const mainCat = product.id_category_main ? Number(product.id_category_main) : null;
		const categoryRows = [];
		// Діти за батьком — один прохід (на тисячах категорій filter у кожному вузлі давав квадратичний час)
		const kids = new Map();
		for (const c of categoriesTree) {
			const k = c.id_parent || null;
			if (!kids.has(k)) kids.set(k, []);
			kids.get(k).push(c);
		}
		const walk = (parent, depth) => {
			const out = [];
			(kids.get(parent) || []).forEach((c) => {
					const row = { id: c.id, name: c.name, status: c.status, depth, checked: selectedCats.has(c.id), main: mainCat === c.id, search: "" };
					categoryRows.push(row);
					const names = [String(c.name).toLowerCase(), ...walk(c.id, depth + 1)];
					row.search = names.join(" | ");
					out.push(...names);
				});
			return out;
		};
		walk(null, 0);

		// Характеристики товару + ті, що можна додати
		const attrById = new Map(attrDict.attributes.map((a) => [a.id, a]));
		const attrValuesOf = new Map();
		for (const x of attrDict.values) {
			if (!attrValuesOf.has(x.id_attribute)) attrValuesOf.set(x.id_attribute, []);
			attrValuesOf.get(x.id_attribute).push(x);
		}
		const attributeRows = product.attributes
			.filter((v) => attrById.has(v.id_attribute))
			.map((v) => {
				const a = attrById.get(v.id_attribute);
				const ids = (v.value_ids || []).map(Number);
				const text = { ...(v.text || {}) };
				if (text[0] && !text[primaryLang]) text[primaryLang] = text[0];
				return {
					...a,
					values: (attrValuesOf.get(a.id) || []).map((x) => ({ ...x, selected: ids.includes(x.id) })),
					number: v.number,
					date: toDateInput(v.date),
					text,
				};
			});
		const usedAttrs = new Set(attributeRows.map((a) => a.id));
		const attrAddList = attrDict.attributes.filter((a) => !usedAttrs.has(a.id));

		// Опції товару + ті, що можна додати
		const optById = new Map(optDict.options.map((o) => [o.id, o]));
		const optValuesOf = new Map();
		for (const x of optDict.values) {
			if (!optValuesOf.has(x.id_option)) optValuesOf.set(x.id_option, []);
			optValuesOf.get(x.id_option).push(x);
		}
		const optionBlocks = product.options
			.filter((d) => optById.has(d.id_option))
			.map((d) => {
				const o = optById.get(d.id_option);
				const all = optValuesOf.get(o.id) || [];
				const used = new Set(d.values.map((x) => x.id_option_value));
				return {
					...o,
					is_value_type: VALUE_OPTION_TYPES.includes(o.type),
					is_required: Number(d.is_required) === 1,
					default_value: d.default_value || "",
					free_values: all.filter((x) => !used.has(x.id)),
					rows: d.values.map((x) => ({ ...x, value: all.find((y) => y.id === x.id_option_value) || { name: "#" + x.id_option_value, color_hex: null } })),
				};
			});
		const usedOpts = new Set(optionBlocks.map((o) => o.id));
		const optAddList = optDict.options.filter((o) => !usedOpts.has(o.id));

		// SEO: автоматичні значення, лічильники, SERP
		const seoData = await pSeo;
		const seoLangs = {};
		languages.forEach((l) => {
			const sl = seoData.langs.find((x) => x.id === l.id) || { values: {} };
			const d = product.descriptions[l.id];
			const counters = {};
			["meta_title", "meta_description", "og_title", "og_description"].forEach((f) => {
				const own = String(d[f] || "").trim().length;
				const len = own || String(sl.values[f] || "").length;
				const max = f.endsWith("title") ? seoData.limits.title_max : seoData.limits.description_max;
				counters[f] = { cls: len > max ? "text-danger" : len < max * 0.5 ? "text-warning" : "text-success", text: (own ? "" : t("catalog.seo.auto") + " · ") + len + " / " + max };
			});
			seoLangs[l.id] = { auto: sl.values || {}, counters, serp: { title: (sl.values || {}).meta_title || "—", slug: d.slug || sl.slug || "…", description: (sl.values || {}).meta_description || "" } };
		});

		// Якість
		const score = product.quality_score == null ? null : Number(product.quality_score);
		const issues = String(product.quality_issues || "")
			.split(",")
			.filter(Boolean);
		const quality =
			score === null
				? null
				: {
						cls: score >= 80 ? "success" : score >= 50 ? "warning" : "danger",
						label: `${t("catalog.quality.score")} ${score}%`,
						title: t("catalog.quality.card_title") + ":\n" + (issues.length ? issues.map((c) => "• " + (QUALITY_RULES.includes(c) ? t("catalog.quality.rule." + c) : c)).join("\n") : t("catalog.quality.card_ok")),
					};

		// Публікація
		let publish = null;
		if (id && all.publishing.enabled) {
			const [st, readyMap] = await pPublish;
			const ready = readyMap.get(id) || [];
			publish = {
				state: st.state,
				publish_at: toDateTimeInput(st.publish_at),
				unpublish_at: toDateTimeInput(st.unpublish_at),
				schedule_text: [st.publish_at ? t("catalog.publish.scheduled_publish").replace("%d", toDateText(st.publish_at)) : "", st.unpublish_at ? t("catalog.publish.scheduled_unpublish").replace("%d", toDateText(st.unpublish_at)) : ""].filter(Boolean).join(" · "),
				blocked: ready.map((s) => `${s.name}: ${s.missing.map((c) => t("catalog.quality.rule." + c)).join(", ")}`).join("\n"),
				cls: { never: "text-bg-secondary", withdrawn: "text-bg-dark", published: "text-bg-success", changed: "text-bg-warning" }[st.state],
				label: t("catalog.publish.state_" + st.state),
				tip: [
					st.published_at
						? t("catalog.publish.published_at")
								.replace("%d", toDateText(st.published_at))
								.replace("%u", st.published_by || "—")
						: "",
					st.changes.length ? t("catalog.publish.changes") + " " + st.changes.map((c) => t("catalog.publish.fields." + c.field) + (c.lang ? " (" + c.lang + ")" : "")).join(", ") : "",
				]
					.filter(Boolean)
					.join("\n"),
			};
		}

		// Хто редагує зараз (інший користувач)
		const me = req.user.userId || req.user.id;
		const holder = product.lock && Number(product.lock.id_user) !== Number(me) ? product.lock : null;
		const holderText = holder ? `${t("catalog.products.lock.editing")} ${holder.user_name || "#" + holder.id_user}` + (holder.since ? ` ${t("catalog.products.lock.since")} ${toDateText(holder.since).slice(11, 16)}` : "") : "";

		// Канали
		const channels = (await pChannels).map((r) => ({ ...r, reason_text: t("catalog.channels.reason_" + r.reason).replace("%s", r.ref_name || ""), sent_text: r.sent_at ? toDateText(r.sent_at) : "" }));

		// Заплановані зміни ціни
		const scheduleStatus = { pending: "secondary", applied: "success", reverted: "info", canceled: "light", failed: "danger" };
		const schedule = id
			? (await pSchedule).map((s) => ({
					...s,
					field_label: s.field === "price" || s.field === "compare_at_price" ? t("catalog.products.f." + s.field) : s.field,
					value_text: s.value == null ? "—" : numText(s.value, 4),
					old_text: s.old_price == null ? "—" : numText(s.old_price, 4),
					run_text: toDateText(s.run_at) || "—",
					revert_text: toDateText(s.revert_at) || "—",
					status_cls: scheduleStatus[s.status] || "secondary",
					status_label: t("catalog.schedule.status." + s.status),
					can_cancel: perms.edit && (s.status === "pending" || (s.status === "applied" && !!s.revert_at)),
				}))
			: [];

		// Історія (перша сторінка)
		const actionCls = { create: "text-bg-success", update: "text-bg-primary", delete: "text-bg-danger", restore: "text-bg-info" };
		const full = (x) => x === null || x === undefined || typeof x !== "object" || Array.isArray(x);
		const showValue = (x) => (x === null || x === undefined ? { kind: "empty" } : Array.isArray(x) ? { kind: "text", text: x.join(", ") || "—" } : typeof x === "object" ? { kind: "cut", text: x.preview, len: x.len } : { kind: "text", text: String(x) });
		let historyView = null;
		if (id) {
			const h = await pHistory;
			historyView = {
				has_more: h.has_more,
				offset: h.rows.length,
				lowest_text: h.lowest_price_30d === null ? null : Number(h.lowest_price_30d).toLocaleString("uk-UA", { minimumFractionDigits: 2 }),
				rows: h.rows.map((ev) => ({
					ts: ev.ts,
					when: toDateText(new Date(ev.ts)),
					action_cls: actionCls[ev.action] || "text-bg-secondary",
					action_label: t("catalog.history.action." + ev.action),
					user_name: ev.user ? ev.user.name || "#" + ev.user.id : t("catalog.history.system"),
					source_label: t("catalog.history.source." + ev.source),
					copied_from: ev.meta && ev.meta.copied_from ? ev.meta.copied_from : null,
					reverted_from: ev.meta && ev.meta.reverted ? toDateText(new Date(ev.meta.reverted)) : null,
					can_revert: perms.edit && ev.action === "update" && (ev.changes || []).some((c) => full(c.old) && full(c.new)),
					changes: (ev.changes || []).map((c) => ({ label: c.label || c.field, lang_code: c.lang_code, old: showValue(c.old), new: showValue(c.new) })),
				})),
			};
		}

		const canWrite = id ? perms.edit && !holder : perms.add;
		mark("ready");
		if (Date.now() - tm0 > 1500) logging.info({ slow: "product_card", id, ms: Date.now() - tm0, steps: marks.join(" ") });

		res.render("pages/catalog/products/card", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_list" },
			perms,
			productId: id,
			product,
			title,
			meta,
			canWrite,
			holder,
			holderText,
			brandOptions,
			supplierOptions,
			attrSets,
			groupList,
			stockRows,
			categoryRows,
			attributeRows,
			attrAddList,
			optionBlocks,
			optAddList,
			seoLimits: seoData.limits,
			seoLangs,
			quality,
			publish,
			channels,
			schedule,
			historyView,
			// Довідники для додавання нових рядків у браузері
			dictJson: JSON.stringify({ attributes: attrDict.attributes, values: attrDict.values, options: optDict.options, optionValues: optDict.values, customerGroups: groupList }).replace(/</g, "\\u003c"),
			cfg: {
				currency: all.prices.base_currency,
				// Довідник валют для цін у валюті: ефективний курс і округлення — для підказки «≈ у базовій»
				currencies: (all.currencies.list || [])
					// Вимкнена валюта — лише якщо товар її вже використовує (щоб не загубити значення)
					.filter((c) => c.code !== all.prices.base_currency && (c.active !== false || (product && JSON.stringify(product).includes('"' + c.code + '"'))))
					.map((c) => ({ code: c.code, symbol: c.symbol, rate: Number(c.rate) * (1 + (Number(c.correction) || 0) / 100), round: c.round, step: c.step, minus: c.minus })),
				units: all.units,
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

// Попередній перегляд «як на сайті»: що саме піде на кожен сайт після всіх правил
router.post(
	"/api/catalog/products/:id/channels/preview/",
	auth.isAuthenticated,
	need("view"),
	handle(async (req) => ({ ok: true, rows: await syncProducts.preview(intId(req.params.id)) }))
);

// ═══ ПУБЛІКАЦІЯ НА САЙТИ ═══════════════════════════════
router.post(
	"/api/catalog/products/:id/publish/state/",
	auth.isAuthenticated,
	need("view"),
	handle(async (req) => {
		const cfg = await settings.get("publishing");
		if (!cfg.enabled) return { ok: true, enabled: false };
		const st = await syncProducts.publishState(intId(req.params.id), cfg);
		if (!st) throw Object.assign(new Error("Not found"), { status: 404 });
		return { ok: true, enabled: true, ...st };
	})
);

const needPublish = (req, res, next) => (can(req, "products.sync", "edit") ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const publishingOn = async (req) => {
	const cfg = await settings.get("publishing");
	if (!cfg.enabled) throw Object.assign(new Error(req.__("catalog.publish.disabled")), { status: 400 });
};
const idsOf = (req) => {
	const ids = (Array.isArray((req.body || {}).ids) ? req.body.ids : [])
		.map(Number)
		.filter((n) => Number.isInteger(n) && n > 0)
		.slice(0, 5000);
	if (!ids.length) throw Object.assign(new Error("Invalid id"), { status: 400 });
	return ids;
};
// «Сайт А: фото, опис; Сайт Б: ціна»
const blockedText = (req, blocked) =>
	blocked.map((b) => ({
		id: b.id,
		text: b.sites.map((s) => `${s.name}: ${s.missing.map((c) => req.__("catalog.quality.rule." + c)).join(", ")}`).join("; "),
	}));

router.post(
	"/api/catalog/products/publish/",
	auth.isAuthenticated,
	needPublish,
	handle(async (req) => {
		await publishingOn(req);
		const ids = idsOf(req);
		// Неповні для свого сайту товари не публікуються — повертаємо, чого бракує
		const r = await syncProducts.publishChecked(ids, req.user.userId);
		audit.log(req, { action: "update", module: "products", entity: "product", id_entity: ids.length === 1 ? ids[0] : null, count: r.published, details: { publish: true, blocked: r.blocked.length } });
		return { ok: true, published: r.published, blocked: blockedText(req, r.blocked) };
	})
);

router.post(
	"/api/catalog/products/unpublish/",
	auth.isAuthenticated,
	needPublish,
	handle(async (req) => {
		await publishingOn(req);
		const ids = idsOf(req);
		const n = await syncProducts.unpublish(ids);
		audit.log(req, { action: "update", module: "products", entity: "product", id_entity: ids.length === 1 ? ids[0] : null, count: n, details: { unpublish: true } });
		return { ok: true, withdrawn: n };
	})
);

router.post(
	"/api/catalog/products/publish/schedule/",
	auth.isAuthenticated,
	needPublish,
	handle(async (req) => {
		await publishingOn(req);
		const ids = idsOf(req);
		const b = req.body || {};
		const n = await syncProducts.schedule(ids, b.publish_at || null, b.unpublish_at || null);
		audit.log(req, { action: "update", module: "products", entity: "product", id_entity: ids.length === 1 ? ids[0] : null, count: n, details: { publish_at: b.publish_at || null, unpublish_at: b.unpublish_at || null } });
		return { ok: true, scheduled: n };
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