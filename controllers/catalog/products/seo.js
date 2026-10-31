"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("./settings");
const languages = require("./languages");
const images = require("./images");

const P = config.get("configDatabase").prefix;
const FIELDS = ["meta_title", "meta_description", "og_title", "og_description"];
const ENTITY = {
	products: { table: "products", desc: "products_description", idCol: "id_product" },
	categories: { table: "products_categories", desc: "products_categories_description", idCol: "id_category" },
	brands: { table: "products_brands", desc: "products_brands_description", idCol: "id_brand" },
};

function httpErr(status, message) {
	return Object.assign(new Error(message), { status });
}

/* ─── Текст ─── */
function truncate(s, max) {
	if (!s || s.length <= max) return s || "";
	const cut = s.slice(0, max - 1);
	const space = cut.lastIndexOf(" ");
	return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:—–-]+$/u, "") + "…";
}

function plain(html, max) {
	const s = String(html || "")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	return max ? truncate(s, max) : s;
}

/** {token} — значення; [ … ] — фрагмент зникає, якщо хоч один токен у ньому порожній */
function render(tpl, tokens) {
	const val = (k) => {
		const v = tokens[k];
		return v === null || v === undefined ? "" : String(v);
	};
	let out = String(tpl || "").replace(/\[([^[\]]*)\]/g, (_, inner) => {
		let empty = false;
		const r = inner.replace(/\{([a-z_]+)\}/g, (m, k) => {
			const v = val(k);
			if (!v) empty = true;
			return v;
		});
		return empty ? "" : r;
	});
	out = out.replace(/\{([a-z_]+)\}/g, (m, k) => val(k));
	return out.replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

function templateFor(cfg, entity, code) {
	const list = (cfg.templates || []).filter((t) => t.entity === entity);
	const lower = String(code || "").toLowerCase();
	return (
		list.find((t) => t.lang.toLowerCase() === lower) ||
		list.find((t) => t.lang.toLowerCase() === lower.split("-")[0]) ||
		list.find((t) => t.lang === "*") ||
		{}
	);
}

function formatPrice(v, code, digits) {
	if (v === null || v === undefined || v === "") return "";
	const n = Number(v);
	if (!Number.isFinite(n)) return "";
	try {
		return new Intl.NumberFormat(code, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
	} catch {
		return n.toFixed(digits);
	}
}

/* ─── Контекст: дані запису й довідників, з яких беруться токени ─── */
async function byLang(db, sql, args) {
	const [rows] = await db.query(sql, args);
	return new Map(rows.map((r) => [Number(r.id_lang), r.name]));
}

async function loadContext(entity, id, db) {
	const e = ENTITY[entity];
	if (!e) throw httpErr(400, "Unknown entity");
	const ctx = { entity, row: null, desc: {}, names: {}, extra: {} };
	if (!id) return ctx;
	const [[row]] = await db.query(`SELECT * FROM ${P}${e.table} WHERE id = ?`, [id]);
	if (!row) return ctx;
	ctx.row = row;
	const [d] = await db.query(`SELECT * FROM ${P}${e.desc} WHERE ${e.idCol} = ?`, [id]);
	for (const r of d) ctx.desc[Number(r.id_lang)] = r;

	if (entity === "products") {
		if (row.id_brand) ctx.names.brand = await byLang(db, `SELECT id_lang, name FROM ${P}products_brands_description WHERE id_brand = ?`, [row.id_brand]);
		if (row.id_category_main) ctx.names.category = await byLang(db, `SELECT id_lang, name FROM ${P}products_categories_description WHERE id_category = ?`, [row.id_category_main]);
	} else if (entity === "categories") {
		if (row.id_parent) ctx.names.parent = await byLang(db, `SELECT id_lang, name FROM ${P}products_categories_description WHERE id_category = ?`, [row.id_parent]);
		const [[s]] = await db.query(
			`SELECT COUNT(*) AS n, MIN(p.price) AS min_price FROM ${P}products_to_categories pc
			   JOIN ${P}products p ON p.id = pc.id_product AND p.deleted_at IS NULL AND p.status = 'active'
			  WHERE pc.id_category = ?`,
			[id]
		);
		ctx.extra = { products: Number(s.n), min_price: s.min_price };
	} else if (entity === "brands") {
		const [[s]] = await db.query(
			`SELECT COUNT(*) AS n, MIN(price) AS min_price FROM ${P}products WHERE id_brand = ? AND deleted_at IS NULL AND status = 'active'`,
			[id]
		);
		ctx.extra = { products: Number(s.n), min_price: s.min_price };
	}
	return ctx;
}

function tokensFor(ctx, lang, primaryId, desc, prices) {
	const pick = (map) => (map ? map.get(lang.id) ?? map.get(primaryId) ?? null : null);
	const primaryDesc = ctx.desc[primaryId] || {};
	const name = desc.name || primaryDesc.name || "";
	const digits = Number.isInteger(prices.rounding) ? prices.rounding : 2;
	const t = { name, h1: desc.h1 || name };
	if (ctx.entity === "products") {
		const r = ctx.row || {};
		Object.assign(t, {
			short_description: plain(desc.short_description, 200),
			description: plain(desc.description, 200),
			brand: pick(ctx.names.brand),
			category: pick(ctx.names.category),
			sku: r.sku || "",
			model: r.model || "",
			price: r.price === undefined ? "" : formatPrice(r.price, lang.code, digits),
			currency: prices.base_currency || "",
			unit: desc.unit_label || "",
		});
	} else if (ctx.entity === "categories") {
		Object.assign(t, {
			description: plain(desc.description, 200),
			parent: pick(ctx.names.parent),
			products: ctx.extra.products || "",
			min_price: formatPrice(ctx.extra.min_price, lang.code, digits),
			currency: prices.base_currency || "",
		});
	} else {
		Object.assign(t, {
			description: plain(desc.description, 200),
			country: (ctx.row && ctx.row.country) || "",
			products: ctx.extra.products || "",
			min_price: formatPrice(ctx.extra.min_price, lang.code, digits),
			currency: prices.base_currency || "",
		});
	}
	return t;
}

/** Ефективні значення: вручну заповнене поле або згенероване з шаблону */
function effective(cfg, entity, lang, tokens, desc) {
	const tpl = templateFor(cfg, entity, lang.code);
	const values = {};
	const generated = {};
	const man = (f) => (desc[f] && String(desc[f]).trim()) || "";

	values.meta_title = man("meta_title") || truncate(render(tpl.meta_title, tokens) || tokens.name, cfg.title_max);
	generated.meta_title = !man("meta_title");
	values.meta_description = man("meta_description") || truncate(render(tpl.meta_description, tokens), cfg.description_max);
	generated.meta_description = !man("meta_description");
	values.og_title = man("og_title") || (tpl.og_title ? truncate(render(tpl.og_title, tokens), cfg.title_max) : values.meta_title);
	generated.og_title = !man("og_title");
	values.og_description = man("og_description") || (tpl.og_description ? truncate(render(tpl.og_description, tokens), cfg.description_max) : values.meta_description);
	generated.og_description = !man("og_description");
	return { values, generated };
}

/**
 * Ефективні SEO-значення запису по всіх активних мовах.
 * draft — незбережені описи з форми { [id_lang]: {...} } (для превʼю), cfgOverride — неzбережені шаблони.
 */
async function effectiveAll(entity, id, draft = {}, cfgOverride = null, db = pool) {
	const [cfg, prices, langs, ctx] = await Promise.all([cfgOverride ? Promise.resolve(cfgOverride) : settings.get("seo"), settings.get("prices"), languages.active(), loadContext(entity, id, db)]);
	const primaryId = langs[0] ? langs[0].id : null;
	// Чернетка поверх збереженого
	for (const [k, v] of Object.entries(draft || {})) ctx.desc[Number(k)] = { ...(ctx.desc[Number(k)] || {}), ...v };

	return {
		limits: { title_max: cfg.title_max, description_max: cfg.description_max },
		row: ctx.row,
		langs: langs.map((lang) => {
			const desc = ctx.desc[lang.id] || {};
			const tokens = tokensFor(ctx, lang, primaryId, desc, prices);
			const r = effective(cfg, entity, lang, tokens, desc);
			return { id: lang.id, code: lang.code, direction: lang.direction, name: desc.name || null, slug: desc.slug || null, canonical_url: desc.canonical_url || null, ...r };
		}),
	};
}

/** Дублікати meta_title або назв у межах мови */
async function duplicates(entity, field, idLang) {
	const e = ENTITY[entity];
	if (!e || !["meta_title", "name"].includes(field)) throw httpErr(400, "Invalid params");
	const alive = entity === "categories" ? "" : "AND t.deleted_at IS NULL";
	const [rows] = await pool.query(
		`SELECT d.${field} AS value, COUNT(*) AS n,
		        SUBSTRING_INDEX(GROUP_CONCAT(d.${e.idCol} ORDER BY d.${e.idCol}), ',', 20) AS ids
		   FROM ${P}${e.desc} d
		   JOIN ${P}${e.table} t ON t.id = d.${e.idCol} ${alive}
		  WHERE d.id_lang = ? AND d.${field} IS NOT NULL AND d.${field} <> ''
		    ${field === "name" ? "AND (d.meta_title IS NULL OR d.meta_title = '')" : ""}
		  GROUP BY d.${field}
		 HAVING n > 1
		  ORDER BY n DESC
		  LIMIT 200`,
		[idLang]
	);
	return rows.map((r) => ({ value: r.value, count: Number(r.n), ids: String(r.ids || "").split(",").filter(Boolean).map(Number) }));
}

/**
 * SEO + контент товару для синхронізації з магазином.
 * opts: { seo, content, baseUrl }
 */
async function syncContent(idProduct, opts) {
	const eff = await effectiveAll("products", idProduct);
	if (!eff.row) return null;
	const out = {};
	if (opts.seo) {
		let ogFile = eff.row.og_image;
		if (!ogFile) {
			const [[m]] = await pool.query(
				`SELECT file FROM ${P}products_media WHERE id_product = ? AND type = 'image' AND file IS NOT NULL ORDER BY is_cover DESC, sort_order, id LIMIT 1`,
				[idProduct]
			);
			ogFile = m ? m.file : null;
		}
		const [hist] = await pool.query(
			`SELECT id_lang, slug FROM ${P}products_url_history WHERE entity = 'products' AND id_entity = ? ORDER BY date_add DESC`,
			[idProduct]
		);
		out.robots = { index: Number(eff.row.robots_index) === 1, follow: Number(eff.row.robots_follow) === 1 };
		out.og_image = ogFile ? (opts.baseUrl || "") + images.url("products", ogFile) : null;
		out.redirects_by_lang = hist.reduce((acc, h) => ((acc[h.id_lang] = acc[h.id_lang] || []).push(h.slug), acc), {});
	}
	const [descRows] = opts.content ? await pool.query(`SELECT id_lang, name, h1, short_description, description, meta_keywords FROM ${P}products_description WHERE id_product = ?`, [idProduct]) : [[]];
	const content = new Map(descRows.map((d) => [Number(d.id_lang), d]));

	out.languages = eff.langs
		.filter((l) => l.name || content.has(l.id))
		.map((l) => {
			const item = { code: l.code };
			if (opts.seo) {
				Object.assign(item, {
					slug: l.slug,
					meta_title: l.values.meta_title,
					meta_description: l.values.meta_description,
					og_title: l.values.og_title,
					og_description: l.values.og_description,
					canonical_url: l.canonical_url,
					redirects: (out.redirects_by_lang || {})[l.id] || [],
				});
			}
			if (opts.content) {
				const c = content.get(l.id) || {};
				Object.assign(item, { name: c.name || null, h1: c.h1 || null, short_description: c.short_description || null, description: c.description || null, meta_keywords: c.meta_keywords || null });
			}
			return item;
		});
	delete out.redirects_by_lang;
	return out;
}

module.exports = { FIELDS, render, truncate, effectiveAll, duplicates, syncContent };