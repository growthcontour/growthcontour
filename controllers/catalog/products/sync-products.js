"use strict";

// Джерело товарів для обміну CRM → магазин: пакети за курсором id (масштабується на мільйони)
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const languages = require("./languages");
const assortment = require("../../settings/integrations/assortment");
const settings = require("./settings");

const P = config.get("configDatabase").prefix;

const appBaseUrl = () =>
	String(process.env.APP_URL || "")
		.trim()
		.replace(/\/+$/, "");
const imageUrl = (file) => (file && appBaseUrl() ? `${appBaseUrl()}/assets/images/products/${file}` : null);

const group = (rows, key) => {
	const m = new Map();
	for (const r of rows) {
		if (!m.has(r[key])) m.set(r[key], []);
		m.get(r[key]).push(r);
	}
	return m;
};

const { attributeDict } = require("./sync-attributes");

// Характеристики товару → текст кожною мовою (як у OpenCart). Разом з довідником, щоб модуль міг створити відсутні
async function loadAttributes(ids, codeById) {
	const [[pta], [ptt]] = await Promise.all([pool.query(`SELECT id_product, id_attribute, id_attribute_value, value_number, value_date FROM ${P}products_to_attributes WHERE id_product IN (?) ORDER BY id_product, sort_order, id`, [ids]), pool.query(`SELECT id_product, id_attribute, id_lang, value FROM ${P}products_to_attributes_text WHERE id_product IN (?)`, [ids])]);
	const attrIds = [...new Set([...pta, ...ptt].map((r) => r.id_attribute))];
	if (!attrIds.length) return () => [];
	const dictMap = await attributeDict(attrIds, codeById);

	const valIds = [...new Set(pta.map((r) => r.id_attribute_value).filter(Boolean))];
	const [vnames] = valIds.length ? await pool.query(`SELECT id_attribute_value, id_lang, name FROM ${P}products_attribute_values_description WHERE id_attribute_value IN (?)`, [valIds]) : [[]];
	const valName = new Map();
	for (const v of vnames) {
		const code = codeById.get(Number(v.id_lang));
		if (!code) continue;
		if (!valName.has(v.id_attribute_value)) valName.set(v.id_attribute_value, new Map());
		valName.get(v.id_attribute_value).set(code, v.name || "");
	}

	const codes = [...codeById.values()];
	const out = new Map(); // id_product → Map(id_attribute → Map(code → [частини]))
	const add = (p, a, code, text) => {
		if (text === "" || text === null || text === undefined) return;
		if (!out.has(p)) out.set(p, new Map());
		const byAttr = out.get(p);
		if (!byAttr.has(a)) byAttr.set(a, new Map());
		const byLang = byAttr.get(a);
		if (!byLang.has(code)) byLang.set(code, []);
		byLang.get(code).push(String(text));
	};

	for (const r of pta) {
		const d = dictMap.get(r.id_attribute);
		if (!d) continue;
		if (r.id_attribute_value) {
			const n = valName.get(r.id_attribute_value) || new Map();
			const fallback = n.size ? n.values().next().value : "";
			for (const code of codes) add(r.id_product, r.id_attribute, code, n.get(code) || fallback);
		} else if (r.value_number !== null && r.value_number !== undefined) {
			const t = String(Number(r.value_number)) + (d.unit ? ` ${d.unit}` : "");
			for (const code of codes) add(r.id_product, r.id_attribute, code, t);
		} else if (r.value_date) {
			const t = r.value_date instanceof Date ? r.value_date.toISOString().slice(0, 10) : String(r.value_date).slice(0, 10);
			for (const code of codes) add(r.id_product, r.id_attribute, code, t);
		}
	}
	for (const r of ptt) {
		const code = codeById.get(Number(r.id_lang));
		if (code) add(r.id_product, r.id_attribute, code, r.value);
	}

	return (idProduct) => {
		const m = out.get(idProduct);
		if (!m) return [];
		return [...m]
			.filter(([aid]) => dictMap.has(aid))
			.map(([aid, byLang]) => {
				const { unit, ...d } = dictMap.get(aid);
				return { ...d, values: [...byLang].map(([code, parts]) => ({ code, text: parts.join(", ") })) };
			});
	};
}

// Опції товарів: довідник (тип, назви опцій і значень) + налаштування значень у кожному товарі
async function loadOptions(pto, codeById) {
	if (!pto.length) return () => [];
	const optIds = [...new Set(pto.map((o) => o.id_option))];
	const [[ptov], [opts], [onames], [vnames], [vals]] = await Promise.all([
		pool.query(
			`SELECT id_product_option, id_option_value, price_mode, price, points, weight, quantity, subtract_stock
			   FROM ${P}products_to_option_values WHERE id_product_option IN (?) ORDER BY sort_order, id`,
			[pto.map((o) => o.id)]
		),
		pool.query(`SELECT id, type, sort_order FROM ${P}products_options WHERE id IN (?)`, [optIds]),
		pool.query(`SELECT id_option, id_lang, name FROM ${P}products_options_description WHERE id_option IN (?)`, [optIds]),
		pool.query(
			`SELECT d.id_option_value, d.id_lang, d.name FROM ${P}products_option_values_description d
			   JOIN ${P}products_option_values v ON v.id = d.id_option_value WHERE v.id_option IN (?)`,
			[optIds]
		),
		pool.query(`SELECT id, sort_order FROM ${P}products_option_values WHERE id_option IN (?)`, [optIds]),
	]);

	const names = (rows, key) => {
		const m = new Map();
		for (const r of rows) {
			const code = codeById.get(Number(r.id_lang));
			if (!code) continue;
			if (!m.has(r[key])) m.set(r[key], []);
			m.get(r[key]).push({ code, name: r.name || "" });
		}
		return m;
	};
	const optName = names(onames, "id_option");
	const valName = names(vnames, "id_option_value");
	const optDef = new Map(opts.map((o) => [o.id, o]));
	const valSort = new Map(vals.map((v) => [v.id, Number(v.sort_order) || 0]));
	const valsOf = group(ptov, "id_product_option");
	const byProduct = group(pto, "id_product");

	return (idProduct) =>
		(byProduct.get(idProduct) || [])
			.filter((o) => optDef.has(o.id_option))
			.map((o) => {
				const def = optDef.get(o.id_option);
				return {
					crm_id: Number(o.id_option),
					type: def.type,
					sort_order: Number(def.sort_order) || 0,
					names: optName.get(o.id_option) || [],
					required: Number(o.is_required) ? 1 : 0,
					default_value: o.default_value || "",
					values: (valsOf.get(o.id) || []).map((v) => ({
						crm_id: Number(v.id_option_value),
						names: valName.get(v.id_option_value) || [],
						sort_order: valSort.get(v.id_option_value) || 0,
						price_mode: v.price_mode,
						price: Number(v.price) || 0,
						points: Number(v.points) || 0,
						weight: Number(v.weight) || 0,
						quantity: Number(v.quantity) || 0,
						subtract: Number(v.subtract_stock) ? 1 : 0,
					})),
				};
			});
}

// Варіанти товару (комбінації): ціна, артикул, EAN, вага, залишок, значення осей з назвами
async function loadVariants(ids, codeById) {
	const [vars] = await pool.query(`SELECT id, id_product, sku, ean, price_mode, price, weight_impact, is_default, status FROM ${P}products_variants WHERE id_product IN (?) ORDER BY id_product, sort_order, id`, [ids]);
	if (!vars.length) return () => [];
	const vIds = vars.map((v) => v.id);
	const [[vv], [vstock]] = await Promise.all([
		pool.query(
			`SELECT vv.id_variant, vv.id_attribute, vv.id_attribute_value, av.color_hex
			   FROM ${P}products_variant_values vv JOIN ${P}products_attribute_values av ON av.id = vv.id_attribute_value
			  WHERE vv.id_variant IN (?)`,
			[vIds]
		),
		pool.query(
			`SELECT s.id_variant, SUM(s.available) AS qty FROM ${P}products_stock s
			   JOIN ${P}products_warehouses w ON w.id = s.id_warehouse AND w.deleted_at IS NULL AND w.status = 1 AND w.is_sellable = 1
			  WHERE s.id_variant IN (?) GROUP BY s.id_variant`,
			[vIds]
		),
	]);
	const attrIds = [...new Set(vv.map((x) => x.id_attribute))];
	const valIds = [...new Set(vv.map((x) => x.id_attribute_value))];
	const [[an], [vn]] = await Promise.all([attrIds.length ? pool.query(`SELECT id_attribute, id_lang, name FROM ${P}products_attributes_description WHERE id_attribute IN (?)`, [attrIds]) : Promise.resolve([[]]), valIds.length ? pool.query(`SELECT id_attribute_value, id_lang, name FROM ${P}products_attribute_values_description WHERE id_attribute_value IN (?)`, [valIds]) : Promise.resolve([[]])]);
	const names = (rows, key) => {
		const m = new Map();
		for (const r of rows) {
			const code = codeById.get(Number(r.id_lang));
			if (!code) continue;
			if (!m.has(r[key])) m.set(r[key], []);
			m.get(r[key]).push({ code, name: r.name || "" });
		}
		return m;
	};
	const aNames = names(an, "id_attribute");
	const vNames = names(vn, "id_attribute_value");
	const valsOf = group(vv, "id_variant");
	const qtyOf = new Map(vstock.map((s) => [s.id_variant, Number(s.qty) || 0]));
	const byProduct = group(vars, "id_product");

	return (idProduct, basePrice) =>
		(byProduct.get(idProduct) || []).map((v) => ({
			crm_id: Number(v.id),
			sku: v.sku || "",
			ean: v.ean || "",
			price: Math.round((v.price_mode === "fixed" ? Number(v.price) : Number(basePrice) + Number(v.price || 0)) * 10000) / 10000,
			weight_impact: Number(v.weight_impact) || 0,
			is_default: Number(v.is_default) ? 1 : 0,
			status: Number(v.status) === 1 ? 1 : 0,
			quantity: Math.max(0, Math.floor(qtyOf.get(v.id) || 0)),
			values: (valsOf.get(v.id) || []).map((x) => ({
				attr_crm_id: Number(x.id_attribute),
				attr_names: aNames.get(x.id_attribute) || [],
				value_crm_id: Number(x.id_attribute_value),
				value_names: vNames.get(x.id_attribute_value) || [],
				color_hex: x.color_hex || "",
			})),
		}));
}

// Повний стан товарів для сайту (без фільтра асортименту): основа і для обміну, і для знімка публікації
async function buildItems(rows, codeById, primaryLang) {
	if (!rows.length) return [];
	const ids = rows.map((r) => r.id);
	const brandIds = [...new Set(rows.map((r) => r.id_brand).filter(Boolean))];
	const [[descs], [media], [cats], [stock], [brands]] = await Promise.all([
		pool.query(`SELECT id_product, id_lang, name, h1, short_description, description, meta_title, meta_description, meta_keywords, slug FROM ${P}products_description WHERE id_product IN (?)`, [ids]),
		pool.query(`SELECT id_product, file FROM ${P}products_media WHERE id_product IN (?) AND type = 'image' AND file IS NOT NULL ORDER BY id_product, is_cover DESC, sort_order, id`, [ids]),
		pool.query(`SELECT id_product, id_category FROM ${P}products_to_categories WHERE id_product IN (?)`, [ids]),
		pool.query(
			`SELECT s.id_product, SUM(s.available) AS qty
			   FROM ${P}products_stock s
			   JOIN ${P}products_warehouses w ON w.id = s.id_warehouse AND w.deleted_at IS NULL AND w.status = 1 AND w.is_sellable = 1
			  WHERE s.id_product IN (?) GROUP BY s.id_product`,
			[ids]
		),
		brandIds.length ? pool.query(`SELECT id_brand, name FROM ${P}products_brands_description WHERE id_brand IN (?) AND id_lang = ?`, [brandIds, primaryLang]) : Promise.resolve([[]]),
	]);

	const [pto] = await pool.query(`SELECT id, id_product, id_option, is_required, default_value FROM ${P}products_to_options WHERE id_product IN (?) ORDER BY id_product, sort_order, id`, [ids]);

	const optionsOf = await loadOptions(pto, codeById);
	const attributesOf = await loadAttributes(ids, codeById);
	const variantsOf = await loadVariants(ids, codeById);

	const descOf = group(descs, "id_product");
	const mediaOf = group(media, "id_product");
	const catsOf = group(cats, "id_product");
	const qtyOf = new Map(stock.map((s) => [s.id_product, Number(s.qty) || 0]));
	const brandOf = new Map(brands.map((b) => [b.id_brand, b.name]));

	return rows.map((r) => {
		const track = Number(r.track_inventory) === 1 && !["service", "digital"].includes(r.type);
		return {
			crm_id: Number(r.id),
			sku: r.sku || "",
			ean: r.ean || "",
			price: Math.round(Number(r.price || 0) * 10000) / 10000,
			track,
			quantity: track ? Math.max(0, Math.floor(qtyOf.get(r.id) || 0)) : 0,
			status: r.status === "active" && !r.deleted_at ? 1 : 0,
			deleted: !!r.deleted_at,
			weight: Number(r.weight) || 0,
			brand: r.id_brand ? brandOf.get(r.id_brand) || "" : "",
			categories: [...new Set((catsOf.get(r.id) || []).map((c) => Number(c.id_category)))].sort((a, b) => a - b),
			main_category: Number(r.id_category_main) || null,
			images: (mediaOf.get(r.id) || []).map((m) => imageUrl(m.file)).filter(Boolean),
			// Службові поля знімка для фідів (на сайти не йдуть — їх прибирає forSite)
			_files: (mediaOf.get(r.id) || []).map((m) => m.file).filter(Boolean),
			_compare: r.compare_at_price === null || r.compare_at_price === undefined ? null : Number(r.compare_at_price),
			options: optionsOf(r.id),
			attributes: attributesOf(r.id),
			variants: variantsOf(r.id, Number(r.price || 0)),
			languages: (descOf.get(r.id) || [])
				.filter((d) => codeById.has(Number(d.id_lang)))
				.map((d) => ({
					code: codeById.get(Number(d.id_lang)),
					name: d.name || "",
					h1: d.h1 || "",
					short_description: d.short_description || "",
					description: d.description || "",
					meta_title: d.meta_title || "",
					meta_description: d.meta_description || "",
					meta_keywords: d.meta_keywords || "",
					slug: d.slug || "",
				})),
		};
	});
}

// Лише категорії, що йдуть на цей сайт
function forSite(item, pubCats) {
	const categories = item.categories.filter((c) => pubCats.has(c));
	const out = { ...item, categories, main_category: categories.includes(item.main_category) ? item.main_category : categories[0] || null };
	for (const k of Object.keys(out)) if (k.startsWith("_")) delete out[k];
	return out;
}

/* ─── Публікація: знімок контенту, який бачать сайти ─────────────────────── */

const parseSnap = (v) => {
	if (!v) return null;
	try {
		return typeof v === "string" ? JSON.parse(v) : v;
	} catch (e) {
		return null;
	}
};

// Опублікований знімок + живі дані, що не чекають кнопки (залишок завжди; ціна й статус — за налаштуванням)
function overlay(snap, live, cfg) {
	const out = { ...snap, track: live.track, quantity: live.quantity, deleted: live.deleted };
	if (cfg.live_price) out.price = live.price;
	out.status = live.deleted ? 0 : cfg.live_status ? live.status : snap.status;
	const lv = new Map(live.variants.map((v) => [v.crm_id, v]));
	out.variants = (snap.variants || []).map((v) => {
		const l = lv.get(v.crm_id);
		return {
			...v,
			quantity: l ? l.quantity : 0,
			price: cfg.live_price && l ? l.price : v.price,
			status: cfg.live_status ? (l ? l.status : 0) : v.status,
		};
	});
	const lo = new Map();
	for (const o of live.options) for (const x of o.values) lo.set(`${o.crm_id}:${x.crm_id}`, x);
	out.options = (snap.options || []).map((o) => ({
		...o,
		values: o.values.map((x) => {
			const l = lo.get(`${o.crm_id}:${x.crm_id}`);
			return { ...x, quantity: l ? l.quantity : 0, price: cfg.live_price && l ? l.price : x.price };
		}),
	}));
	return out;
}

async function langCtx() {
	const langs = await languages.active();
	return { codeById: new Map(langs.map((l) => [Number(l.id), l.code])), primaryLang: langs[0] ? langs[0].id : 1 };
}

/** Опублікувати поточний стан товарів. Повертає кількість опублікованих */
async function publish(ids, idUser) {
	ids = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
	if (!ids.length) return 0;
	const { codeById, primaryLang } = await langCtx();
	let n = 0;
	for (let i = 0; i < ids.length; i += 100) {
		const [rows] = await pool.query(`SELECT * FROM ${P}products WHERE id IN (?) AND deleted_at IS NULL`, [ids.slice(i, i + 100)]);
		const items = await buildItems(rows, codeById, primaryLang);
		for (let k = 0; k < rows.length; k++) {
			// Версію фіксуємо ту, з якої зібрано знімок: правка під час збирання лишить товар «зміненим»
			// date_edit = date_edit — публікація не є редагуванням
			const [r] = await pool.query(`UPDATE ${P}products SET published_data = ?, published_version = ?, sync_published_at = NOW(), id_user_published = ?, date_edit = date_edit WHERE id = ?`, [JSON.stringify(items[k]), rows[k].version, idUser || null, rows[k].id]);
			n += r.affectedRows;
		}
	}
	return n;
}

// Поля, що змінились від публікації (живі поля не рахуються)
function diffItems(snap, cur, cfg) {
	const out = [];
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	const strip = (it) => ({
		variants: (it.variants || []).map(({ quantity, price, status, ...v }) => ({ ...v, ...(cfg.live_price ? {} : { price }), ...(cfg.live_status ? {} : { status }) })),
		options: (it.options || []).map((o) => ({ ...o, values: o.values.map(({ quantity, price, ...x }) => ({ ...x, ...(cfg.live_price ? {} : { price }) })) })),
	});
	const keys = ["sku", "ean", "weight", "brand", "categories", "main_category", "images", "attributes"];
	if (!cfg.live_price) keys.push("price", "_compare");
	if (!cfg.live_status) keys.push("status");
	for (const k of keys) if (!same(snap[k], cur[k])) out.push({ field: k });
	const a = strip(snap);
	const b = strip(cur);
	if (!same(a.variants, b.variants)) out.push({ field: "variants" });
	if (!same(a.options, b.options)) out.push({ field: "options" });
	const ls = new Map((snap.languages || []).map((l) => [l.code, l]));
	for (const l of cur.languages || []) {
		const o = ls.get(l.code) || {};
		for (const f of ["name", "h1", "short_description", "description", "meta_title", "meta_description", "meta_keywords", "slug"]) {
			if ((o[f] || "") !== (l[f] || "")) out.push({ field: f, lang: l.code });
		}
	}
	return out;
}

/** Стан публікації товару: never | published | changed (+ перелік змін) */
async function publishState(id, cfg) {
	const [[row]] = await pool.query(`SELECT * FROM ${P}products WHERE id = ?`, [id]);
	if (!row) return null;
	const [[u]] = row.id_user_published ? await pool.query(`SELECT NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM ${P}users WHERE id = ?`, [row.id_user_published]) : [[null]];
	const snap = parseSnap(row.published_data);
	const base = { published_at: row.sync_published_at, published_by: u ? u.name : null, publish_at: row.sync_publish_at, unpublish_at: row.sync_unpublish_at };
	// published_version = 0 — знято з публікації (на сайти не йде)
	if (!snap) return { state: Number(row.published_version) === 0 ? "withdrawn" : "never", changes: [], ...base };
	const { codeById, primaryLang } = await langCtx();
	const [cur] = await buildItems([row], codeById, primaryLang);
	const changes = diffItems(snap, cur, cfg);
	// Версія зросла лише через живі поля (залишок, ціна) — знімок актуальний, вирівнюємо позначку
	if (!changes.length && Number(row.version) > Number(row.published_version)) {
		await pool.query(`UPDATE ${P}products SET published_version = ?, date_edit = date_edit WHERE id = ? AND published_version = ?`, [row.version, row.id, row.published_version]);
	}
	return { state: changes.length ? "changed" : "published", changes, ...base };
}

/* ─── Готовність до сайту, зняття з публікації, розклад ─────────────────────── */

/**
 * Чого бракує товарам для кожного сайту, на який вони йдуть.
 * Обов'язкові поля сайту — коди правил оцінки якості (settings_integrations.required_fields).
 * Повертає Map(id → [{ id_integration, name, missing: [code] }]) — лише товари з проблемами.
 */
async function readiness(ids, opts = {}) {
	const out = new Map();
	ids = [...new Set(ids.map(Number).filter((n) => n > 0))];
	if (!ids.length) return out;
	const [integs] = await pool.query(`SELECT id, name, required_fields FROM ${P}settings_integrations WHERE status = 'active' AND required_fields IS NOT NULL`);
	const sites = integs.map((i) => ({ ...i, required: parseSnap(i.required_fields) || [] })).filter((i) => Array.isArray(i.required) && i.required.length);
	if (!sites.length) return out;
	// Свіжа оцінка — правки могли бути після нічного перерахунку
	if (opts.fresh !== false) await require("./quality").recalc(ids);
	const [rows] = await pool.query(`SELECT id, quality_issues FROM ${P}products WHERE id IN (?)`, [ids]);
	const issuesOf = new Map(rows.map((r) => [Number(r.id), new Set(String(r.quality_issues || "").split(",").filter(Boolean))]));
	for (const site of sites) {
		const st = await (await assortment.resolver(site.id)).products(ids);
		for (const id of ids) {
			if (!(st.get(id) || {}).published) continue;
			const missing = site.required.filter((c) => (issuesOf.get(id) || new Set()).has(c));
			if (!missing.length) continue;
			if (!out.has(id)) out.set(id, []);
			out.get(id).push({ id_integration: site.id, name: site.name, missing });
		}
	}
	return out;
}

/** Опублікувати лише готові товари; неготові повертаються з переліком, чого бракує */
async function publishChecked(ids, idUser) {
	const bad = await readiness(ids);
	const ok = ids.map(Number).filter((id) => !bad.has(id));
	const published = ok.length ? await publish(ok, idUser) : 0;
	if (ok.length) await pool.query(`UPDATE ${P}products SET sync_publish_at = NULL, date_edit = date_edit WHERE id IN (?)`, [ok]);
	return { published, blocked: [...bad].map(([id, sites]) => ({ id, sites })) };
}

/** Зняти з публікації: на сайтах спрацює політика «відсутні в системі» модуля */
async function unpublish(ids) {
	ids = [...new Set(ids.map(Number).filter((n) => n > 0))];
	if (!ids.length) return 0;
	const [r] = await pool.query(
		`UPDATE ${P}products SET published_data = NULL, published_version = 0, sync_unpublish_at = NULL, sync_published_at = NOW(), date_edit = date_edit WHERE id IN (?)`,
		[ids]
	);
	return r.affectedRows;
}

/** Запланувати публікацію / зняття (null — скасувати) */
async function schedule(ids, publishAt, unpublishAt) {
	ids = [...new Set(ids.map(Number).filter((n) => n > 0))];
	if (!ids.length) return 0;
	const d = (v) => (v ? new Date(v) : null);
	const pa = d(publishAt);
	const ua = d(unpublishAt);
	if ((pa && isNaN(pa)) || (ua && isNaN(ua))) throw Object.assign(new Error("Invalid date"), { status: 400 });
	if (pa && ua && ua <= pa) throw Object.assign(new Error("Unpublish date must be after publish date"), { status: 400, code: "bad_range" });
	const [r] = await pool.query(`UPDATE ${P}products SET sync_publish_at = ?, sync_unpublish_at = ?, date_edit = date_edit WHERE id IN (?) AND deleted_at IS NULL`, [pa, ua, ids]);
	return r.affectedRows;
}

/** Крон: виконати розклад (щохвилини) */
async function runSchedule() {
	const cfg = await settings.get("publishing");
	if (!cfg.enabled) return { published: 0, blocked: 0, withdrawn: 0 };
	const res = { published: 0, blocked: 0, withdrawn: 0 };
	const [due] = await pool.query(`SELECT id FROM ${P}products WHERE sync_publish_at IS NOT NULL AND sync_publish_at <= NOW() AND deleted_at IS NULL LIMIT 500`);
	if (due.length) {
		const ids = due.map((r) => r.id);
		const r = await publishChecked(ids, null);
		res.published += r.published;
		res.blocked += r.blocked.length;
		// Неготові теж знімаємо з розкладу, інакше вони пробуватимуть щохвилини; причина — у журналі
		if (r.blocked.length) {
			await pool.query(`UPDATE ${P}products SET sync_publish_at = NULL, date_edit = date_edit WHERE id IN (?)`, [r.blocked.map((b) => b.id)]);
			const history = require("./history");
			for (const b of r.blocked) {
				await history.record("products", b.id, { user: null, source: "schedule", action: "update", changes: [{ field: "publish_blocked", old: null, new: b.sites.map((s) => `${s.name}: ${s.missing.join(", ")}`).join("; ") }] });
			}
		}
	}
	const [gone] = await pool.query(`SELECT id FROM ${P}products WHERE sync_unpublish_at IS NOT NULL AND sync_unpublish_at <= NOW() LIMIT 500`);
	if (gone.length) res.withdrawn += await unpublish(gone.map((r) => r.id));
	return res;
}

/** Під час увімкнення режиму: знімок поточного стану всім наявним товарам, щоб сайти нічого не втратили */
async function snapshotExisting(before) {
	// Повторне ввімкнення: старі знімки застаріли — сайти весь цей час отримували живі дані
	await pool.query(`UPDATE ${P}products SET published_data = NULL, published_version = NULL, date_edit = date_edit WHERE published_version IS NOT NULL AND date_add < ?`, [before]);
	let after = 0;
	let total = 0;
	for (;;) {
		const [rows] = await pool.query(`SELECT id FROM ${P}products WHERE id > ? AND published_version IS NULL AND deleted_at IS NULL AND date_add < ? ORDER BY id LIMIT 500`, [after, before]);
		if (!rows.length) break;
		after = rows[rows.length - 1].id;
		total += await publish(
			rows.map((r) => r.id),
			null
		);
	}
	return total;
}

/**
 * Режим публікації: нові товари не йдуть на сайти до першої публікації; published_version = 0 — знято з публікації.
 * Старі товари без знімка (ще знімаються після ввімкнення режиму) — йдуть як є.
 */
function goesOut(r, pubCfg) {
	if (!pubCfg.enabled) return true;
	const enabledAt = pubCfg.enabled_at ? new Date(pubCfg.enabled_at) : null;
	return Number(r.published_version) > 0 || (r.published_version === null && !!enabledAt && new Date(r.date_add) < enabledAt);
}

/** Рівно те, що піде на сайт: знімок публікації + живі поля + ціна / назва / залишок сайту + категорії сайту */
async function siteItems(idIntegration, rows, ctx) {
	const live = await buildItems(rows, ctx.codeById, ctx.primaryLang);
	// Значення сайту: правило ціни інтеграції, ціна / назва товару для цього сайту
	const ch = await assortment.channel(idIntegration, rows.map((r) => r.id));
	// Склади сайту й запас: «показувати 0, коли лишилось N шт.»
	const qmap = ch.stockActive ? await ch.stock(rows.map((r) => r.id)) : null;
	const out = live.map((it, i) => {
		const row = rows[i];
		const snap = ctx.pubCfg.enabled ? parseSnap(row.published_data) : null;
		const item = snap ? overlay(snap, it, ctx.pubCfg) : it;
		// Ціна чекає публікації — правило сайту рахуємо від опублікованої ціни
		const base = snap && !ctx.pubCfg.live_price ? { ...row, price: snap.price, compare_at_price: snap._compare } : row;
		return forSite(assortment.applyStock(assortment.applyToItem(assortment.applyContent(item, ch), base, ch), ch, qmap), ctx.pubCats);
	});
	// Категорії сайту (режими «Дерево сайту» / «Змішаний»): ID категорій на сайті за відповідністю
	const cm = await assortment.categoryMap(idIntegration);
	if (cm.mode === "system") return out;
	await cm.loadPaths([].concat(...out.map((it) => it.categories || []), ...out.map((it) => (it.main_category ? [it.main_category] : []))));
	await cm.prepare(rows);
	const mapped = out.map((it) => cm.apply(it));
	if (ctx.withNames) mapped.forEach((it) => Object.defineProperty(it, "__siteNames", { value: (it.site_categories || []).map((id) => cm.sitePath(id)), enumerable: false }));
	return mapped;
}

/** Попередній перегляд для картки: що саме піде на кожен сайт і чому товар не йде */
async function preview(idProduct) {
	const [[row]] = await pool.query(`SELECT * FROM ${P}products WHERE id = ?`, [idProduct]);
	if (!row) return [];
	const { codeById, primaryLang } = await langCtx();
	const pubCfg = await settings.get("publishing");
	const sites = await assortment.catalogIntegrations();
	const ready = await readiness([idProduct], { fresh: false });
	const catIds = new Set();
	const out = [];
	for (const s of sites) {
		const assort = await assortment.resolver(s.id);
		const st = (await assort.products([row.id])).get(Number(row.id));
		const base = { id: s.id, name: s.name, active: s.status === "active", color_text: s.color_text, color_background: s.color_background };
		if (!st.published) {
			out.push({ ...base, goes: false, reason: "assortment" });
			continue;
		}
		if (!goesOut(row, pubCfg)) {
			out.push({ ...base, goes: false, reason: Number(row.published_version) === 0 ? "withdrawn" : "not_published" });
			continue;
		}
		const pubCats = await assort.categories();
		const [item] = await siteItems(s.id, [row], { codeById, primaryLang, pubCats, pubCfg, withNames: true });
		// Категорії на сайті (режими «Дерево сайту» / «Змішаний») і звідки вони: товар / правило / відповідність / за замовчуванням
		if (item.__siteNames) {
			item.site_category_names = item.__siteNames;
			item.site_category_source = item.__why;
		}
		if (item.__unmapped) {
			out.push({ ...base, goes: false, reason: "category_unmapped" });
			continue;
		}
		item.categories.forEach((c) => catIds.add(c));
		const missing = ((ready.get(Number(row.id)) || []).find((x) => x.id_integration === s.id) || {}).missing || [];
		out.push({ ...base, goes: true, missing, item });
	}
	// Назви категорій основною мовою — для показу
	const names = new Map();
	if (catIds.size) {
		const [cn] = await pool.query(`SELECT id_category, name FROM ${P}products_categories_description WHERE id_category IN (?) AND id_lang = ?`, [[...catIds], primaryLang]);
		cn.forEach((r) => names.set(Number(r.id_category), r.name));
	}
	for (const o of out) if (o.item) o.item.category_names = o.item.categories.map((c) => names.get(c) || `#${c}`);
	return out;
}

/**
 * Частковий обмін: лише вказані товари. Ті, що (більше) не йдуть на сайт — у gone: модуль застосує до них
 * «Відсутні в системі», решту сайту не чіпає.
 */
function partialSource(idIntegration, ids) {
	const list = [...new Set(ids.map(Number).filter((n) => n > 0))].sort((a, b) => a - b);
	const gone = [];
	let ctx = null;
	let assort = null;
	async function init() {
		if (ctx) return;
		const { codeById, primaryLang } = await langCtx();
		assort = await assortment.resolver(idIntegration);
		ctx = { codeById, primaryLang, pubCats: await assort.categories(), pubCfg: await settings.get("publishing") };
	}
	return {
		partial: true,
		BATCH: 100,
		start: 0,
		resume: () => 0,
		gone: () => gone,
		count: async () => list.length,
		batch: async (pos, size) => {
			await init();
			const part = list.slice(pos, pos + size);
			if (!part.length) return { items: [], next: pos };
			const next = pos + part.length;
			const [scan] = await pool.query(`SELECT * FROM ${P}products WHERE id IN (?) ORDER BY id`, [part]);
			const found = new Set(scan.map((r) => Number(r.id)));
			part.filter((id) => !found.has(id)).forEach((id) => gone.push(id)); // видалені назовсім
			const state = await assort.products(scan.map((r) => r.id));
			const rows = [];
			for (const r of scan) {
				if (state.get(r.id).published && goesOut(r, ctx.pubCfg)) rows.push(r);
				else gone.push(Number(r.id));
			}
			if (!rows.length) return { items: [], next, more: next < list.length };
			const items = await siteItems(idIntegration, rows, ctx);
			// Категорію не зіставлено (режим «Дерево сайту») — товар на сайт не йде
			items.filter((it) => it.__unmapped).forEach((it) => gone.push(Number(it.crm_id)));
			return { items: items.filter((it) => !it.__unmapped), next, more: next < list.length };
		},
		afterBatch: (items, results) => assortment.recordResults(idIntegration, items, results),
	};
}

/** Змінені товари з моменту since: правки, публікація, залишки (рухи складу після movementId), значення й рішення для сайту */
async function changedSince(idIntegration, since, movementId, limit = 5001) {
	const [rows] = await pool.query(
		`SELECT id FROM ${P}products WHERE date_edit >= ? OR sync_published_at >= ?
		 UNION SELECT DISTINCT id_product FROM ${P}products_stock_movements WHERE id > ?
		 UNION SELECT id_entity FROM ${P}settings_integrations_assortment WHERE id_integration = ? AND entity = 'product' AND date_edit >= ? AND err_message IS NULL
		 LIMIT ?`,
		[since, since, movementId, idIntegration, since, limit]
	);
	return rows.map((r) => Number(r.id));
}

/** Які з товарів ids ідуть на сайт інтеграції: не видалені, в асортименті сайту, опубліковані */
async function goingOut(idIntegration, ids) {
	const out = new Set();
	if (!ids.length) return out;
	const pubCfg = await settings.get("publishing");
	const st = await (await assortment.resolver(idIntegration)).products(ids);
	const [rows] = await pool.query(`SELECT id, published_version, date_add, deleted_at FROM ${P}products WHERE id IN (?)`, [ids]);
	for (const r of rows) if (!r.deleted_at && (st.get(r.id) || {}).published && goesOut(r, pubCfg)) out.add(Number(r.id));
	return out;
}

/**
 * Прибрати на сайті зв'язки товарів, які система на цей сайт не передає (зайві після імпорту тощо).
 * Самі товари на сайті не змінюються — лише перестають бути «товарами системи», тож обмін їх більше не вимкне й не видалить.
 */
async function unlinkExtra(idIntegration) {
	const client = require("./sync-client");
	const [[integ]] = await pool.query(`SELECT id, base_url, callback_url, outbound_token, status FROM ${P}settings_integrations WHERE id = ?`, [idIntegration]);
	if (!integ) throw Object.assign(new Error("Integration not found"), { status: 404 });
	const linked = [];
	for (let after = 0, guard = 0; guard < 5000; guard++) {
		const r = await client.call(integ, "products.state", { after, limit: 2000 });
		(r.items || []).forEach((x) => linked.push(Number(x.crm_id)));
		if (!r.more) break;
		after = Number(r.next) || 0;
	}
	const extra = [];
	for (let i = 0; i < linked.length; i += 2000) {
		const part = linked.slice(i, i + 2000);
		const going = await goingOut(idIntegration, part);
		part.forEach((id) => going.has(id) || extra.push(id));
	}
	for (let i = 0; i < extra.length; i += 500) {
		await client.call(integ, "export.unlink", { items: extra.slice(i, i + 500).map((id) => ({ entity: "product", crm_id: id })) });
	}
	await pool.query(`UPDATE ${P}settings_integrations SET recon_extra = 0, prune_blocked = 0, prune_confirm = 0 WHERE id = ?`, [idIntegration]);
	return { linked: linked.length, unlinked: extra.length };
}

/**
 * Перевірка розбіжностей (щоночі): що мало бути на сайті й чого там немає, що лишилось зайвим, що змінили на сайті вручну.
 * Результат — у settings_integrations (recon_*); відсутні й (за налаштуванням) змінені вручну — у частковий обмін.
 */
async function reconcile(idIntegration) {
	const client = require("./sync-client");
	const [[integ]] = await pool.query(`SELECT id, base_url, callback_url, outbound_token, status, content_rule FROM ${P}settings_integrations WHERE id = ?`, [idIntegration]);
	if (!integ || integ.status !== "active") return null;
	// Стан сайту: crm_id → { present, status, modified }
	const site = new Map();
	let unlinked = 0;
	for (let after = 0, guard = 0; guard < 5000; guard++) {
		const r = await client.call(integ, "products.state", { after, limit: 2000 });
		if (r.unlinked !== undefined) unlinked = Number(r.unlinked) || 0;
		(r.items || []).forEach((x) => site.set(Number(x.crm_id), x));
		if (!r.more) break;
		after = Number(r.next) || 0;
	}
	// Що має бути на сайті за асортиментом і публікацією
	const pubCfg = await settings.get("publishing");
	const assort = await assortment.resolver(idIntegration);
	const missing = [];
	const modified = [];
	const expected = new Set();
	for (let after = 0; ; ) {
		const [rows] = await pool.query(`SELECT id, published_version, date_add, deleted_at FROM ${P}products WHERE id > ? ORDER BY id LIMIT 2000`, [after]);
		if (!rows.length) break;
		after = rows[rows.length - 1].id;
		const st = await assort.products(rows.map((r) => r.id));
		for (const r of rows) {
			if (r.deleted_at || !st.get(r.id).published || !goesOut(r, pubCfg)) continue;
			const id = Number(r.id);
			expected.add(id);
			const s = site.get(id);
			if (!s || !Number(s.present)) missing.push(id);
			else if (Number(s.modified)) modified.push(id);
		}
	}
	// «Дерево сайту»: товари без зіставленої категорії на сайт не йдуть — це не розбіжність
	if (missing.length && (await assortment.categoryMap(idIntegration)).mode === "site") {
		const { codeById, primaryLang } = await langCtx();
		const pubCats = await assort.categories();
		const skip = new Set();
		for (let k = 0; k < missing.length; k += 200) {
			const [rows] = await pool.query(`SELECT * FROM ${P}products WHERE id IN (?)`, [missing.slice(k, k + 200)]);
			(await siteItems(idIntegration, rows, { codeById, primaryLang, pubCats, pubCfg })).forEach((it) => it.__unmapped && skip.add(Number(it.crm_id)));
		}
		skip.forEach((id) => expected.delete(id));
		missing.splice(0, missing.length, ...missing.filter((id) => !skip.has(id)));
	}
	let extra = 0;
	for (const [id, s] of site) if (Number(s.present) && Number(s.status) === 1 && !expected.has(id)) extra++;

	const manual = assortment.normContent(integ.content_rule).manual_edits;
	await pool.query(
		`UPDATE ${P}settings_integrations SET recon_missing = ?, recon_extra = ?, recon_modified = ?, recon_unlinked = ?, recon_at = NOW() WHERE id = ?`,
		[missing.length, extra, modified.length, unlinked, idIntegration]
	);
	// Виправлення: відсутні — передати; змінені вручну — перезаписати, якщо так налаштовано; зайві — прибере повний обмін
	const fix = missing.slice(0, 5000);
	if (manual === "overwrite" && modified.length) {
		const ids = modified.slice(0, 5000);
		await client.call(integ, "products.state", { after: 0, limit: 1, reset_modified: ids });
		fix.push(...ids);
	}
	if (extra) await pool.query(`UPDATE ${P}settings_integrations SET sync_full_at = NOW() WHERE id = ?`, [idIntegration]);
	return { missing: missing.length, extra, modified: modified.length, unlinked, fix: [...new Set(fix)] };
}

function source(idIntegration) {
	let codeById = null;
	let assort = null;
	let pubCats = null;
	let primaryLang = 1;
	let pubCfg = null;

	async function init() {
		if (codeById) return;
		({ codeById, primaryLang } = await langCtx());
		// Асортимент цієї інтеграції: які товари й категорії йдуть на сайт
		assort = await assortment.resolver(idIntegration);
		pubCats = await assort.categories();
		pubCfg = await settings.get("publishing");
	}

	return {
		BATCH: 100,
		start: 0,
		resume: (crmId) => Number(crmId) || 0,
		count: async () => {
			await init();
			return assort.countProducts();
		},
		batch: async (after, size) => {
			await init();
			const [scan] = await pool.query(`SELECT * FROM ${P}products WHERE id > ? ORDER BY id LIMIT ?`, [after, size]);
			if (!scan.length) return { items: [], next: after };
			const scanned = scan[scan.length - 1].id;

			// Лише товари, що йдуть на цей сайт; решту модуль обробить як «відсутні в системі»
			const state = await assort.products(scan.map((r) => r.id));
			let rows = scan.filter((r) => state.get(r.id).published);

			rows = rows.filter((r) => goesOut(r, pubCfg));
			if (!rows.length) return { items: [], next: scanned, more: true };

			// Категорію не зіставлено (режим «Дерево сайту») — товар на сайт не йде, модуль обробить як «відсутній»
			const items = (await siteItems(idIntegration, rows, { codeById, primaryLang, pubCats, pubCfg })).filter((it) => !it.__unmapped);
			if (!items.length) return { items: [], next: scanned, more: true };
			return { items, next: scanned };
		},
		// Відповідь сайту по кожному товару → черга помилок (повтори з паузою, список «не прийняті сайтом»)
		afterBatch: (items, results) => assortment.recordResults(idIntegration, items, results),
	};
}

module.exports = { goingOut, unlinkExtra, reconcile, partialSource, changedSince, preview, source, publish, publishState, snapshotExisting, parseSnap, readiness, publishChecked, unpublish, schedule, runSchedule };
