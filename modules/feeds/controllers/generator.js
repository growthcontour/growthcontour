"use strict";

/**
 * Генерація фіду: потоковий запис у тимчасовий файл пачками за id (keyset), потім атомарна заміна.
 * Пам'ять не залежить від розміру каталогу. Віддача — готовий файл з ETag / Last-Modified.
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("../../../controllers/catalog/products/settings");
const languages = require("../../../controllers/catalog/products/languages");
const images = require("../../../controllers/catalog/products/images");
const feeds = require("./feeds");
const i18n = require("../../../config/i18n/i18n");

const P = config.get("configDatabase").prefix;
const FORMATS = { google: require("./formats/google"), prom: require("./formats/prom") };
const BATCH = 1000;
const FILE_RE = /^([0-9a-f]{32})\.xml$/;

const appUrl = () => String(process.env.APP_URL || "").replace(/\/+$/, "");

/** Довідники, що потрібні на весь прогін: категорії (з шляхом), бренди */
async function loadMaps(idLang, primary) {
	const [cats] = await pool.query(
		`SELECT c.id, c.id_parent, c.status, COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', c.id)) AS name
		   FROM ${P}products_categories c
		   LEFT JOIN ${P}products_categories_description d  ON d.id_category = c.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_categories_description dp ON dp.id_category = c.id AND dp.id_lang = ?`,
		[idLang, primary]
	);
	const [brands] = await pool.query(
		`SELECT b.id, COALESCE(NULLIF(d.name, ''), dp.name) AS name
		   FROM ${P}products_brands b
		   LEFT JOIN ${P}products_brands_description d  ON d.id_brand = b.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_brands_description dp ON dp.id_brand = b.id AND dp.id_lang = ?`,
		[idLang, primary]
	);
	const catMap = new Map(cats.map((c) => [c.id, c]));
	const pathCache = new Map();
	const catPath = (id) => {
		if (!id || !catMap.has(id)) return [];
		if (pathCache.has(id)) return pathCache.get(id);
		const out = [];
		const seen = new Set();
		for (let c = catMap.get(id); c && !seen.has(c.id); c = catMap.get(c.id_parent)) {
			seen.add(c.id);
			out.unshift(c.name);
		}
		pathCache.set(id, out);
		return out;
	};
	return { categories: cats, catPath, brands: new Map(brands.map((b) => [b.id, b.name])) };
}

/** Одна пачка товарів з усім, що потрібно для фіду */
async function loadBatch(feed, ctx, afterId) {
	const f = feed.filters || {};
	const where = ["p.deleted_at IS NULL", "p.id > ?", "p.status IN (?)", "p.type NOT IN ('service', 'gift_card')", "p.show_price = 1"];
	const params = [afterId, f.statuses && f.statuses.length ? f.statuses : ["active"]];
	if (f.brands && f.brands.length) {
		where.push("p.id_brand IN (?)");
		params.push(f.brands);
	}
	if (f.categories && f.categories.length) {
		where.push(`EXISTS (SELECT 1 FROM ${P}products_to_categories ptc JOIN ${P}products_categories_path cp ON cp.id_category = ptc.id_category
		                     WHERE ptc.id_product = p.id AND cp.id_ancestor IN (?))`);
		params.push(f.categories);
	}
	const [products] = await pool.query(`SELECT p.* FROM ${P}products p WHERE ${where.join(" AND ")} ORDER BY p.id LIMIT ?`, [...params, BATCH]);
	if (!products.length) return { products: [], lastId: afterId };
	const ids = products.map((p) => p.id);

	const [[desc], [media], [stock], [variants], [links]] = await Promise.all([
		pool.query(
			`SELECT id_product, id_lang, name, description, short_description, slug FROM ${P}products_description WHERE id_product IN (?) AND id_lang IN (?)`,
			[ids, [...new Set([ctx.idLang, ctx.primary])]]
		),
		pool.query(`SELECT id, id_product, file FROM ${P}products_media WHERE id_product IN (?) AND type = 'image' ORDER BY id_product, is_cover DESC, sort_order, id`, [ids]),
		pool.query(
			`SELECT s.id_product, s.id_variant, SUM(s.available) AS qty
			   FROM ${P}products_stock s
			   JOIN ${P}products_warehouses w ON w.id = s.id_warehouse AND w.deleted_at IS NULL AND w.status = 1 AND w.is_sellable = 1
			  WHERE s.id_product IN (?) GROUP BY s.id_product, s.id_variant`,
			[ids]
		),
		f.variants === false
			? [[]]
			: pool.query(
					`SELECT v.id, v.id_product, v.sku, v.ean, v.mpn, v.price_mode, v.price, v.compare_at_price, v.weight_impact,
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
		feed.id_integration
			? pool.query(`SELECT id_product, id_variant, external_id, external_variant_id FROM ${P}products_external_links WHERE id_integration = ? AND id_product IN (?)`, [feed.id_integration, ids])
			: [[]],
	]);

	const group = (rows, key) => rows.reduce((m, r) => (m.get(r[key]) ? m.get(r[key]).push(r) : m.set(r[key], [r]), m), new Map());
	const descBy = group(desc, "id_product");
	const mediaBy = group(media, "id_product");
	const varBy = group(variants, "id_product");
	const stockKey = new Map(stock.map((s) => [`${s.id_product}:${s.id_variant}`, Number(s.qty)]));
	const linkKey = new Map(links.map((l) => [`${l.id_product}:${l.id_variant}`, l]));

	for (const p of products) {
		const d = descBy.get(p.id) || [];
		const own = d.find((x) => x.id_lang === ctx.idLang) || {};
		const prim = d.find((x) => x.id_lang === ctx.primary) || {};
		p._name = own.name || prim.name || "";
		p._description = own.description || prim.description || "";
		p._short = own.short_description || prim.short_description || "";
		p._slug = own.slug || prim.slug || "";
		p._media = mediaBy.get(p.id) || [];
		p._variants = varBy.get(p.id) || [];
		p._qty = (stockKey.get(`${p.id}:0`) || 0) + p._variants.reduce((a, v) => a + (stockKey.get(`${p.id}:${v.id}`) || 0), 0);
		p._stockKey = stockKey;
		p._link = linkKey.get(`${p.id}:0`) || null;
		p._linkKey = linkKey;
	}
	return { products, lastId: products[products.length - 1].id };
}

/** Спільна логіка для форматів: посилання, фото, ціни, наявність */
function helpers(feed, ctx) {
	const imageUrl = (file) => (file ? appUrl() + images.url("products", file, feed.image_size || null) : null);
	const withUtm = (url) => (feed.utm ? url + (url.includes("?") ? "&" : "?") + feed.utm.replace(/^[?&]/, "") : url);
	const productUrl = (p, v) => {
		const link = v ? p._linkKey.get(`${p.id}:${v.id}`) || p._link : p._link;
		const values = {
			slug: p._slug,
			id: String(p.id),
			sku: (v && v.sku) || p.sku || "",
			external_id: link ? link.external_id : "",
		};
		if (feed.url_template.includes("{slug}") && !values.slug) return null;
		if (feed.url_template.includes("{external_id}") && !values.external_id) return null;
		const pathPart = feed.url_template.replace(/\{(slug|id|sku|external_id)\}/g, (_, k) => encodeURIComponent(values[k]).replace(/%2F/gi, "/"));
		let url = /^https?:\/\//.test(pathPart) ? pathPart : feed.base_url + (pathPart.startsWith("/") ? "" : "/") + pathPart;
		// Варіант: Google вимагає унікальне посилання; параметр варіанта — найменш руйнівний спосіб
		if (v && link && link.external_variant_id) url += (url.includes("?") ? "&" : "?") + "variant=" + encodeURIComponent(link.external_variant_id);
		return withUtm(url);
	};
	const priceOf = (p, v) => {
		const base = v ? (v.price_mode === "fixed" ? Number(v.price) : Number(p.price) + Number(v.price)) : Number(p.price);
		const cmp = v && v.compare_at_price !== null ? Number(v.compare_at_price) : p.compare_at_price !== null ? Number(p.compare_at_price) : null;
		return { price: Math.round(base * 100) / 100, compare: cmp !== null && cmp > base ? Math.round(cmp * 100) / 100 : null };
	};
	const qtyOf = (p, v) => (v ? p._stockKey.get(`${p.id}:${v.id}`) || 0 : p._variants.length ? p._qty : p._stockKey.get(`${p.id}:0`) || 0);
	const availability = (p, v) => {
		if (!Number(p.track_inventory)) return "in_stock";
		if (qtyOf(p, v) > 0) return "in_stock";
		const action = p.out_of_stock_action && p.out_of_stock_action !== "default" ? p.out_of_stock_action : ctx.stockCfg.default_out_of_stock_action;
		return action === "preorder" ? "preorder" : action === "backorder" ? "backorder" : "out_of_stock";
	};
	const imagesOf = (p, v) => {
		let list = p._media;
		if (v && v.media_ids) {
			const ids = String(v.media_ids).split(",").map(Number);
			const own = ids.map((id) => p._media.find((m) => m.id === id)).filter(Boolean);
			if (own.length) list = [...own, ...p._media.filter((m) => !ids.includes(m.id))];
		}
		return list.map((m) => imageUrl(m.file)).filter(Boolean);
	};
	const stripHtml = (html) =>
		String(html || "")
			.replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
			.replace(/<[^>]*>/g, "")
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/[ \t]+/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	return { productUrl, priceOf, qtyOf, availability, imagesOf, stripHtml, brandOf: (p) => (p.id_brand ? ctx.maps.brands.get(p.id_brand) || null : null), catPath: (p) => ctx.maps.catPath(p.id_category_main) };
}

/** Зробити один фід */
async function generate(idFeed) {
	const feed = await feeds.get(idFeed);
	const started = Date.now();
	const fmt = FORMATS[feed.format];
	const langs = await languages.active();
	const primary = langs[0] ? langs[0].id : 1;
	const idLang = feed.id_lang && langs.some((l) => l.id === feed.id_lang) ? feed.id_lang : primary;
	const lang = langs.find((l) => l.id === idLang) || { iso: "uk" };
	const [pricesCfg, stockCfg] = await Promise.all([settings.get("prices"), settings.get("stock")]);
	const ctx = {
		idLang,
		primary,
		lang: lang.iso,
		currency: feed.currency || pricesCfg.base_currency,
		stockCfg,
		maps: await loadMaps(idLang, primary),
	};
	// Назва параметра варіанта мовою фіду (якщо такої локалі інтерфейсу немає — українською)
	const t = (locale) => i18n.__({ phrase: "modules.feeds.variant_param", locale });
	ctx.variantParam = t(lang.iso) !== "modules.feeds.variant_param" ? t(lang.iso) : t("uk");
	if (feed.currency && feed.currency !== pricesCfg.base_currency) {
		// Курсів у каталозі ще немає — ціни в іншій валюті були б неправдою
		throw Object.assign(new Error(`Currency conversion is not supported yet (base ${pricesCfg.base_currency})`), { status: 400 });
	}
	const h = helpers(feed, ctx);

	const final = path.join(feeds.CACHE_DIR, `${feed.id}-${feed.token}.xml`);
	const tmp = `${final}.${process.pid}.tmp`;
	await fsp.mkdir(feeds.CACHE_DIR, { recursive: true });
	const out = fs.createWriteStream(tmp, { encoding: "utf8" });
	const write = (s) => (out.write(s) ? Promise.resolve() : new Promise((r) => out.once("drain", r)));

	const report = { skipped: {} };
	const skip = (reason) => (report.skipped[reason] = (report.skipped[reason] || 0) + 1);
	let items = 0;
	try {
		await write(fmt.head(feed, ctx));
		for (let last = 0; ; ) {
			const { products, lastId } = await loadBatch(feed, ctx, last);
			if (!products.length) break;
			last = lastId;
			for (const p of products) {
				for (const entry of fmt.items(p, feed, ctx, h)) {
					if (entry.skip) {
						skip(entry.skip);
						continue;
					}
					await write(entry.xml);
					items++;
				}
			}
		}
		await write(fmt.tail(feed, ctx));
		await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
		await fsp.rename(tmp, final);
	} catch (e) {
		out.destroy();
		await fsp.unlink(tmp).catch(() => {});
		await pool.query(`UPDATE ${feeds.T} SET last_error = ?, last_generated_at = NOW() WHERE id = ?`, [String(e.message).slice(0, 1024), feed.id]);
		throw e;
	}
	const { size } = await fsp.stat(final);
	const skipped = Object.values(report.skipped).reduce((a, b) => a + b, 0);
	const result = { items, skipped, file_size: size, duration_ms: Date.now() - started, report };
	await pool.query(
		`UPDATE ${feeds.T} SET last_generated_at = NOW(), last_duration_ms = ?, items = ?, skipped = ?, file_size = ?, last_error = NULL, report = ? WHERE id = ?`,
		[result.duration_ms, items, skipped, size, JSON.stringify(report), feed.id]
	);
	return result;
}

const inProgress = new Set();

/** Запуск у фоні з захистом від паралельної генерації одного фіду */
async function start(idFeed) {
	await feeds.get(idFeed);
	if (inProgress.has(idFeed)) return { started: false, busy: true };
	inProgress.add(idFeed);
	generate(idFeed)
		.catch((e) => console.error("[feeds] generate", idFeed, e.message))
		.finally(() => inProgress.delete(idFeed));
	return { started: true };
}

let running = false;

/** Таймер модуля: перегенерувати фіди, у яких минув інтервал */
async function runDue() {
	if (running) return;
	running = true;
	try {
		const [rows] = await pool.query(
			`SELECT id FROM ${feeds.T} WHERE status = 1 AND (last_generated_at IS NULL OR last_generated_at <= NOW() - INTERVAL interval_hours HOUR) ORDER BY last_generated_at IS NOT NULL, last_generated_at`
		);
		for (const { id } of rows) {
			if (inProgress.has(id)) continue;
			inProgress.add(id);
			try {
				await generate(id);
			} catch (e) {
				console.error("[feeds] generate", id, e.message);
			} finally {
				inProgress.delete(id);
			}
		}
	} finally {
		running = false;
	}
}

/** Публічна віддача: /modules/feeds/f/<token>.xml */
async function serve(file, req, res) {
	const m = FILE_RE.exec(file);
	if (!m) return res.status(404).type("text/plain").send("Not found");
	const [[feed]] = await pool.query(`SELECT id, token, status, format FROM ${feeds.T} WHERE token = ?`, [m[1]]);
	if (!feed || !feed.status) return res.status(404).type("text/plain").send("Not found");
	const full = path.join(feeds.CACHE_DIR, `${feed.id}-${feed.token}.xml`);
	let st;
	try {
		st = await fsp.stat(full);
	} catch {
		return res.status(503).set("Retry-After", "300").type("text/plain").send("Feed is being generated");
	}
	const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
	res.set({
		"Content-Type": "application/xml; charset=utf-8",
		"Last-Modified": st.mtime.toUTCString(),
		ETag: etag,
		"Cache-Control": "public, max-age=300",
		"X-Robots-Tag": "noindex",
	});
	if (req.headers["if-none-match"] === etag) return res.status(304).end();
	fs.createReadStream(full).pipe(res);
}

module.exports = { FORMATS: Object.keys(FORMATS), generate, start, runDue, serve };