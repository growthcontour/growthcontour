"use strict";

/**
 * Вітрина Mini App: каталог магазину з товарів системи.
 *  - Асортимент, ціни й залишки — правила каналу продажу магазину (як для сайту): sqlPublished + assortment.channel.
 *  - Режим публікації каталогу: показуються лише опубліковані товари, тексти й ціни — з опублікованої версії.
 *  - Мова контенту — мова Telegram користувача, якщо вона є серед мов каталогу; інакше основна.
 *  - Кошик перевіряється на сервері (ціни, наявність, мін. кількість, крок) — клієнт ціни не передає.
 */

const { pool, P } = require("./common");
const settings = require("../../../controllers/catalog/products/settings");
const languages = require("../../../controllers/catalog/products/languages");
const images = require("../../../controllers/catalog/products/images");
const assortment = require("../../../controllers/settings/integrations/assortment");
const { parseSnap } = require("../../../controllers/catalog/products/sync-products");

const PAGE = 20;
const CTX_MS = 60 * 1000;
const MAX_CART_LINES = 50;
const ctxCache = new Map();

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** Налаштування каталогу на прогін: мови, публікація, залишки, мініатюра, валюта магазину */
async function baseCtx(idIntegration) {
	const hit = ctxCache.get(idIntegration);
	if (hit && Date.now() - hit.at < CTX_MS) return hit.ctx;
	const [langs, pricesCfg, stockCfg, pub, imagesCfg] = await Promise.all([languages.active(), settings.get("prices"), settings.get("stock"), settings.get("publishing"), settings.get("images")]);
	const [[integ]] = await pool.query(`SELECT price_rule FROM ${P}settings_integrations WHERE id = ?`, [idIntegration]);
	const rule = assortment.normRule(integ && integ.price_rule);
	// Мініатюра для карток — найменша не вужча за 360px; немає — оригінал
	const thumbs = ((imagesCfg && imagesCfg.thumbnails) || []).filter((t) => Number(t.width) >= 360).sort((a, b) => a.width - b.width);
	const ctx = {
		langs,
		primary: (langs[0] && langs[0].id) || 1,
		pub: pub || {},
		stockCfg: stockCfg || {},
		currency: rule.currency || pricesCfg.base_currency,
		thumb: thumbs.length ? thumbs[0].code : null,
	};
	ctxCache.set(idIntegration, { at: Date.now(), ctx });
	return ctx;
}

/** Контекст запиту: мова користувача */
async function ctxFor(shop, langCode) {
	const base = await baseCtx(shop.id_integration);
	const code = String(langCode || "").toLowerCase().split("-")[0];
	const own = base.langs.find((l) => l.iso === code || String(l.iso).split("-")[0] === code);
	const idLang = own ? own.id : base.primary;
	const lang = base.langs.find((l) => l.id === idLang) || {};
	const prim = base.langs.find((l) => l.id === base.primary) || {};
	return { ...base, idLang, codeLang: lang.code, codePrimary: prim.code, iso: lang.iso || "uk" };
}

/** Умови «товар є на вітрині»: не видалений, продається, канал магазину, публікація */
function baseWhere(shop, ctx) {
	const pubSql = assortment.sqlPublished(shop.id_integration, "p");
	const where = ["p.deleted_at IS NULL", "p.type NOT IN ('service', 'gift_card')", pubSql.sql];
	const params = [...pubSql.params];
	if (ctx.pub.enabled) {
		if (ctx.pub.live_status) where.push("p.status = 'active'");
		where.push("(p.published_version > 0 OR (p.published_version IS NULL AND p.date_add < ?))");
		params.push(ctx.pub.enabled_at ? new Date(ctx.pub.enabled_at) : new Date(0));
	} else where.push("p.status = 'active'");
	return { where, params };
}

const imageUrl = (file, thumb) => (file ? images.url("products", file, thumb || null) : null);

/** Чи можна замовити, коли залишку немає */
function oosAction(p, ctx) {
	return p.out_of_stock_action && p.out_of_stock_action !== "default" ? p.out_of_stock_action : ctx.stockCfg.default_out_of_stock_action || "hide";
}

/**
 * Повні дані товарів для вітрини: назва, тексти, фото, варіанти, ціни каналу, наявність.
 * Товар, що в режимі публікації опублікований не як активний, відкидається.
 */
async function hydrate(shop, ctx, ids, full) {
	if (!ids.length) return [];
	const [rows] = await pool.query(`SELECT p.* FROM ${P}products p WHERE p.id IN (?)`, [ids]);
	const [[desc], [media], [variants]] = await Promise.all([
		pool.query(`SELECT id_product, id_lang, name, ${full ? "description, short_description," : ""} slug FROM ${P}products_description WHERE id_product IN (?) AND id_lang IN (?)`, [ids, [...new Set([ctx.idLang, ctx.primary])]]),
		pool.query(`SELECT id, id_product, file FROM ${P}products_media WHERE id_product IN (?) AND type = 'image' ORDER BY id_product, is_cover DESC, sort_order, id`, [ids]),
		pool.query(
			`SELECT v.id, v.id_product, v.sku, v.price_mode, v.price, v.compare_at_price,
			        (SELECT GROUP_CONCAT(COALESCE(NULLIF(vd.name, ''), vdp.name, av.code) ORDER BY ax.sort_order SEPARATOR ' / ')
			           FROM ${P}products_variant_values vv
			           JOIN ${P}products_attribute_values av ON av.id = vv.id_attribute_value
			           LEFT JOIN ${P}products_variant_axes ax ON ax.id_product = v.id_product AND ax.id_attribute = vv.id_attribute
			           LEFT JOIN ${P}products_attribute_values_description vd  ON vd.id_attribute_value = vv.id_attribute_value AND vd.id_lang = ?
			           LEFT JOIN ${P}products_attribute_values_description vdp ON vdp.id_attribute_value = vv.id_attribute_value AND vdp.id_lang = ?
			          WHERE vv.id_variant = v.id) AS label,
			        (SELECT GROUP_CONCAT(vm.id_media ORDER BY vm.sort_order) FROM ${P}products_variant_media vm WHERE vm.id_variant = v.id) AS media_ids
			   FROM ${P}products_variants v WHERE v.id_product IN (?) AND v.status = 1 ORDER BY v.id_product, v.id`,
			[ctx.idLang, ctx.primary, ids]
		),
	]);
	const group = (list, key) => list.reduce((m, r) => (m.get(r[key]) ? m.get(r[key]).push(r) : m.set(r[key], [r]), m), new Map());
	const descBy = group(desc, "id_product");
	const mediaBy = group(media, "id_product");
	const varBy = group(variants, "id_product");

	let products = rows.map((p) => {
		const d = descBy.get(p.id) || [];
		const own = d.find((x) => x.id_lang === ctx.idLang) || {};
		const prim = d.find((x) => x.id_lang === ctx.primary) || {};
		p._name = own.name || prim.name || "";
		p._description = own.description || prim.description || "";
		p._short = own.short_description || prim.short_description || "";
		p._media = mediaBy.get(p.id) || [];
		p._variants = varBy.get(p.id) || [];
		return p;
	});
	// Опублікована версія: тексти, фото, ціна (якщо чекає публікації); неактивні в знімку — прибрати
	if (ctx.pub.enabled) {
		products = products.filter((p) => {
			const sn = parseSnap(p.published_data);
			if (!sn) return ctx.pub.live_status || p.status === "active";
			if (!ctx.pub.live_status && sn.status !== 1) return false;
			applySnapshot(p, sn, ctx);
			return true;
		});
	}
	// Ціни каналу; варіанти — у тій самій пропорції, що й товар
	const pids = products.map((p) => p.id);
	const ch = await assortment.channel(shop.id_integration, pids);
	for (const p of products) {
		const base = Number(p.price) || 0;
		const site = ch.active ? ch.price(p) : base;
		const ratio = base > 0 ? site / base : 1;
		p._price = round2(site);
		p._compare = p.compare_at_price !== null && p.compare_at_price !== undefined ? round2(Number(p.compare_at_price) * ratio) : null;
		for (const v of p._variants) {
			const vp = v.price_mode === "fixed" ? Number(v.price) : base + Number(v.price || 0);
			v._price = ch.active ? assortment.roundPrice(vp * ratio, ch.rule.round) : round2(vp);
			v._compare = v.compare_at_price !== null && v.compare_at_price !== undefined ? round2(Number(v.compare_at_price) * ratio) : null;
		}
		const ov = ch.overrides(p.id);
		if (ov && ov.names) p._name = ov.names[ctx.codeLang] || ov.names[ctx.codePrimary] || p._name;
	}
	// Наявність — склади каналу й запас
	const q = await ch.stock(pids);
	const qty = (k) => ch.siteQty(q.get(k) || 0);
	const byId = new Map(products.map((p) => [p.id, p]));
	return ids
		.map((id) => byId.get(Number(id)))
		.filter(Boolean)
		.map((p) => shape(p, ctx, qty, full))
		.filter((x) => x.visible);
}

function applySnapshot(p, sn, ctx) {
	const langs = sn.languages || [];
	const own = langs.find((l) => l.code === ctx.codeLang) || {};
	const prim = langs.find((l) => l.code === ctx.codePrimary) || langs[0] || {};
	p._name = own.name || prim.name || p._name;
	p._description = own.description || prim.description || "";
	p._short = own.short_description || prim.short_description || "";
	if (Array.isArray(sn._files)) {
		const byFile = new Map(p._media.map((m) => [m.file, m]));
		p._media = sn._files.map((file, i) => byFile.get(file) || { id: -1 - i, id_product: p.id, file });
	}
	if (!ctx.pub.live_price) {
		p.price = sn.price;
		if (sn._compare !== undefined) p.compare_at_price = sn._compare;
		const sv = new Map((sn.variants || []).map((v) => [v.crm_id, v]));
		for (const v of p._variants) {
			const s = sv.get(Number(v.id));
			if (s) {
				v.price_mode = "fixed";
				v.price = s.price;
			}
		}
	}
}

/** Товар у вигляді для вітрини */
function shape(p, ctx, qty, full) {
	const track = !!Number(p.track_inventory);
	const action = oosAction(p, ctx);
	const canOrder = (n) => !track || n > 0 || action === "preorder" || action === "backorder";
	const stockOf = (n) => (!track || n > 0 ? "in_stock" : action === "preorder" ? "preorder" : action === "backorder" ? "backorder" : "out_of_stock");
	const priced = !!Number(p.show_price) && !Number(p.price_on_request);
	const variants = p._variants.map((v) => {
		const n = qty(`${p.id}:${v.id}`);
		return {
			id: Number(v.id),
			label: v.label || v.sku || `#${v.id}`,
			sku: v.sku || null,
			price: v._price,
			compare: v._compare !== null && v._compare > v._price ? v._compare : null,
			stock: stockOf(n),
			available: canOrder(n),
			max: track && n > 0 && action !== "preorder" && action !== "backorder" ? n : null,
			media: v.media_ids ? String(v.media_ids).split(",").map(Number) : [],
		};
	});
	const own = qty(`${p.id}:0`);
	const total = variants.length ? qty(`${p.id}:*`) : own;
	const available = variants.length ? variants.some((v) => v.available) : canOrder(own);
	const prices = variants.length ? variants.map((v) => v.price) : [p._price];
	const out = {
		id: Number(p.id),
		name: p._name,
		image: p._media.length ? imageUrl(p._media[0].file, ctx.thumb) : null,
		priced,
		price: priced ? Math.min(...prices) : null,
		price_from: priced && variants.length > 1 && Math.min(...prices) !== Math.max(...prices),
		compare: priced && !variants.length && p._compare !== null && p._compare > p._price ? p._compare : null,
		stock: variants.length ? (available ? "in_stock" : "out_of_stock") : stockOf(own),
		available: priced && available,
		has_variants: variants.length > 0,
		// «Сховати» товар без залишку — його немає на вітрині
		visible: !!p._name && !(track && total <= 0 && action === "hide"),
	};
	if (!full) return out;
	const medias = p._media.map((m) => ({ id: Number(m.id), url: imageUrl(m.file), thumb: imageUrl(m.file, ctx.thumb) }));
	return {
		...out,
		sku: p.sku || null,
		short: p._short || "",
		description: sanitize(p._description),
		images: medias,
		max: !variants.length && track && own > 0 && action !== "preorder" && action !== "backorder" ? own : null,
		min_qty: Math.max(1, Number(p.min_qty) || 1),
		qty_step: Math.max(1, Number(p.qty_step) || 1),
		max_qty: Number(p.max_qty) > 0 ? Number(p.max_qty) : null,
		variants: priced ? variants : variants.map((v) => ({ ...v, price: null, compare: null, available: false })),
	};
}

/** Опис для вітрини: без скриптів, стилів, обробників і небезпечних посилань */
function sanitize(html) {
	return String(html || "")
		.replace(/<(script|style|iframe|object|embed|form|button|textarea|select|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<\/?(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta|base|noscript|template)\b[^>]*>/gi, "")
		.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/\s(href|src)\s*=\s*("|')\s*(javascript|data|vbscript):[^"']*\2/gi, "")
		.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, "");
}

/** Категорії, в яких є товари вітрини (з предками), деревом за порядком */
async function categories(shop, ctx) {
	const w = baseWhere(shop, ctx);
	const [counts] = await pool.query(
		`SELECT cp.id_ancestor AS id, COUNT(DISTINCT p.id) AS n
		   FROM ${P}products p
		   JOIN ${P}products_to_categories ptc ON ptc.id_product = p.id
		   JOIN ${P}products_categories_path cp ON cp.id_category = ptc.id_category
		  WHERE ${w.where.join(" AND ")} GROUP BY cp.id_ancestor`,
		w.params
	);
	if (!counts.length) return [];
	const n = new Map(counts.map((r) => [Number(r.id), Number(r.n)]));
	const [cats] = await pool.query(
		`SELECT c.id, c.id_parent, c.image, c.sort_order, COALESCE(NULLIF(d.name, ''), dp.name) AS name
		   FROM ${P}products_categories c
		   LEFT JOIN ${P}products_categories_description d  ON d.id_category = c.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_categories_description dp ON dp.id_category = c.id AND dp.id_lang = ?
		  WHERE c.id IN (?) AND c.status = 1 AND c.deleted_at IS NULL
		  ORDER BY c.sort_order, name`,
		[ctx.idLang, ctx.primary, [...n.keys()]]
	);
	const ids = new Set(cats.map((c) => Number(c.id)));
	return cats
		.filter((c) => c.name)
		.map((c) => ({
			id: Number(c.id),
			// Батько прихований або без товарів — категорія піднімається на верхній рівень
			parent: c.id_parent && ids.has(Number(c.id_parent)) ? Number(c.id_parent) : null,
			name: c.name,
			image: c.image ? images.url("categories", c.image) : null,
			count: n.get(Number(c.id)) || 0,
		}));
}

const SORTS = {
	popular: "p.sort_order, p.id DESC",
	new: "p.date_add DESC, p.id DESC",
	price_asc: "p.price ASC, p.id DESC",
	price_desc: "p.price DESC, p.id DESC",
	name: "name_sort ASC, p.id DESC",
};

/** Сторінка товарів: пошук, категорія (з підкатегоріями), сортування */
async function products(shop, ctx, opts = {}) {
	const w = baseWhere(shop, ctx);
	const page = Math.max(1, Math.min(500, parseInt(opts.page, 10) || 1));
	const cat = parseInt(opts.category, 10);
	if (cat > 0) {
		w.where.push(`EXISTS (SELECT 1 FROM ${P}products_to_categories ptc JOIN ${P}products_categories_path cp ON cp.id_category = ptc.id_category
		                      WHERE ptc.id_product = p.id AND cp.id_ancestor = ?)`);
		w.params.push(cat);
	}
	const q = String(opts.q || "").trim().slice(0, 100);
	if (q) {
		const like = `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
		w.where.push(`(p.sku LIKE ? OR EXISTS (SELECT 1 FROM ${P}products_description sd WHERE sd.id_product = p.id AND sd.id_lang IN (?) AND sd.name LIKE ?)
		              OR EXISTS (SELECT 1 FROM ${P}products_variants sv WHERE sv.id_product = p.id AND sv.status = 1 AND sv.sku LIKE ?))`);
		w.params.push(like, [...new Set([ctx.idLang, ctx.primary])], like, like);
	}
	const sort = SORTS[opts.sort] ? opts.sort : "popular";
	const nameSort = sort === "name" ? `, (SELECT COALESCE(NULLIF(MAX(CASE WHEN nd.id_lang = ? THEN nd.name END), ''), MAX(nd.name)) FROM ${P}products_description nd WHERE nd.id_product = p.id AND nd.id_lang IN (?)) AS name_sort` : "";
	const nameParams = sort === "name" ? [ctx.idLang, [...new Set([ctx.idLang, ctx.primary])]] : [];
	// Беремо на один більше — щоб знати, чи є наступна сторінка
	const [rows] = await pool.query(`SELECT p.id${nameSort} FROM ${P}products p WHERE ${w.where.join(" AND ")} ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`, [...nameParams, ...w.params, PAGE + 1, (page - 1) * PAGE]);
	const more = rows.length > PAGE;
	const items = await hydrate(
		shop,
		ctx,
		rows.slice(0, PAGE).map((r) => Number(r.id)),
		false
	);
	return { items, page, more };
}

/** Картка товару */
async function product(shop, ctx, id) {
	const pid = parseInt(id, 10);
	if (!(pid > 0)) return null;
	const w = baseWhere(shop, ctx);
	const [[r]] = await pool.query(`SELECT p.id FROM ${P}products p WHERE p.id = ? AND ${w.where.join(" AND ")}`, [pid, ...w.params]);
	if (!r) return null;
	const [item] = await hydrate(shop, ctx, [pid], true);
	return item || null;
}

/**
 * Перевірка кошика: актуальні ціни й наявність, кількість з урахуванням мін./кроку/залишку.
 * lines: [{ id, variant, qty }] → { lines, total, count, problems }
 */
async function cart(shop, ctx, lines) {
	const list = (Array.isArray(lines) ? lines : []).slice(0, MAX_CART_LINES).map((l) => ({
		id: parseInt(l && l.id, 10) || 0,
		variant: parseInt(l && l.variant, 10) || 0,
		qty: Math.max(0, Math.min(9999, parseInt(l && l.qty, 10) || 0)),
	}));
	const ids = [...new Set(list.filter((l) => l.id > 0 && l.qty > 0).map((l) => l.id))];
	let found = [];
	if (ids.length) {
		const w = baseWhere(shop, ctx);
		const [ok] = await pool.query(`SELECT p.id FROM ${P}products p WHERE p.id IN (?) AND ${w.where.join(" AND ")}`, [ids, ...w.params]);
		found = await hydrate(
			shop,
			ctx,
			ok.map((x) => Number(x.id)),
			true
		);
	}
	const byId = new Map(found.map((p) => [p.id, p]));
	const out = [];
	let total = 0;
	let count = 0;
	for (const l of list) {
		if (!(l.id > 0) || !(l.qty > 0)) continue;
		const p = byId.get(l.id);
		const base = { id: l.id, variant: l.variant, qty_wanted: l.qty };
		if (!p) {
			out.push({ ...base, name: null, problem: "gone", qty: 0 });
			continue;
		}
		const v = l.variant ? p.variants.find((x) => x.id === l.variant) : null;
		if ((l.variant && !v) || (!l.variant && p.has_variants)) {
			out.push({ ...base, name: p.name, image: p.image, problem: "variant", qty: 0 });
			continue;
		}
		const price = v ? v.price : p.price;
		const available = v ? v.available : p.available;
		if (!p.priced || price === null || !available) {
			out.push({ ...base, name: p.name, variant_label: v ? v.label : null, image: p.image, problem: "unavailable", qty: 0 });
			continue;
		}
		// Кількість: мінімум, крок, ліміт товару й залишок
		let qty = Math.max(l.qty, p.min_qty);
		if (p.qty_step > 1) qty = Math.ceil(qty / p.qty_step) * p.qty_step;
		const caps = [p.max_qty, v ? v.max : p.max].filter((x) => x !== null && x !== undefined);
		let problem = null;
		if (caps.length) {
			const cap = Math.min(...caps);
			if (qty > cap) {
				qty = p.qty_step > 1 ? Math.floor(cap / p.qty_step) * p.qty_step : cap;
				problem = "qty";
			}
		}
		if (qty < p.min_qty) {
			out.push({ ...base, name: p.name, variant_label: v ? v.label : null, image: p.image, problem: "unavailable", qty: 0 });
			continue;
		}
		if (qty !== l.qty && !problem) problem = "qty";
		const sum = round2(price * qty);
		total = round2(total + sum);
		count += qty;
		out.push({
			...base,
			name: p.name,
			variant_label: v ? v.label : null,
			sku: (v && v.sku) || p.sku,
			image: (v && v.media.length && (p.images.find((m) => m.id === v.media[0]) || {}).thumb) || p.image,
			price,
			qty,
			sum,
			min_qty: p.min_qty,
			qty_step: p.qty_step,
			// Товар зі знижкою (є стара ціна) — для промокодів «не діє на акційні»
			on_sale: !!(v ? v.compare : p.compare),
			problem,
		});
	}
	const minOrder = Number((shop.settings || {}).min_order) || 0;
	const w = await cartWeight(out);
	// weight_missing — одиниць товару без ваги (для розрахунку Нової пошти — по вазі за замовчуванням акаунта)
	return { lines: out, total, count, weight: w.kg, weight_missing: w.missing, currency: ctx.currency, min_order: minOrder, below_min: minOrder > 0 && total < minOrder };
}

const KG = { kg: 1, g: 0.001, lb: 0.453592, oz: 0.0283495 };

/** Вага кошика в кг (для доставки за вагою): вага товару ± вага варіанта, × кількість; товари без ваги — 0 й у missing (штук) */
async function cartWeight(lines) {
	const ok = lines.filter((l) => l.qty > 0);
	if (!ok.length) return { kg: 0, missing: 0 };
	const [prods] = await pool.query(`SELECT id, weight, weight_unit FROM ${P}products WHERE id IN (?)`, [[...new Set(ok.map((l) => l.id))]]);
	const vIds = [...new Set(ok.filter((l) => l.variant).map((l) => l.variant))];
	const [vars] = vIds.length ? await pool.query(`SELECT id, weight_impact FROM ${P}products_variants WHERE id IN (?)`, [vIds]) : [[]];
	const pw = new Map(prods.map((p) => [Number(p.id), p]));
	const vw = new Map(vars.map((v) => [Number(v.id), Number(v.weight_impact) || 0]));
	let kg = 0;
	let missing = 0;
	for (const l of ok) {
		const p = pw.get(l.id);
		if (!p) continue;
		const k = KG[p.weight_unit] || 1;
		const one = Math.max(0, (Number(p.weight) || 0) + (l.variant ? vw.get(l.variant) || 0 : 0)) * k;
		if (!(one > 0)) missing += l.qty;
		kg += one * l.qty;
	}
	return { kg: Math.round(kg * 1000) / 1000, missing };
}

/** Товари вітрини без ваги (доставка за вагою чи розрахунок Нової пошти неточні): кількість і до 10 назв */
async function missingWeight(shop) {
	const ctx = await ctxFor(shop, null);
	const { where, params } = baseWhere(shop, ctx);
	where.push("(p.weight IS NULL OR p.weight <= 0)", "p.type <> 'digital'");
	const [[c]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products p WHERE ${where.join(" AND ")}`, params);
	const [rows] = Number(c.n)
		? await pool.query(
				`SELECT p.id, COALESCE(NULLIF(d.name, ''), p.sku, CONCAT('#', p.id)) AS name FROM ${P}products p
				   LEFT JOIN ${P}products_description d ON d.id_product = p.id AND d.id_lang = ?
				  WHERE ${where.join(" AND ")} ORDER BY p.id DESC LIMIT 10`,
				[ctx.primary, ...params]
		  )
		: [[]];
	return { count: Number(c.n), sample: rows.map((r) => ({ id: Number(r.id), name: r.name })) };
}

module.exports = { ctxFor, categories, products, product, cart, sanitize, missingWeight, PAGE };