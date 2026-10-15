"use strict";

// Асортимент інтеграції: що з каталогу системи передається на конкретний сайт.
// Рішення людини зберігаються розріджено (settings_integrations_assortment), результат рахується:
//   товар (вручну) → найближча категорія вгору по дереву → режим інтеграції (all | selected).
// Товар у кількох категоріях передається, якщо хоч одна з них (з урахуванням успадкування) увімкнена.
const crypto = require("crypto");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const platforms = require("./platforms");
const languages = require("../../catalog/products/languages");

const P = config.get("configDatabase").prefix;
const ENTITIES = ["category", "product"];
const MODES = ["include", "exclude"];
const CHUNK = 5000;

function httpErr(status, message) {
	return Object.assign(new Error(message), { status });
}

async function resolver(idIntegration) {
	const [[integ]] = await pool.query(`SELECT assortment_mode FROM ${P}settings_integrations WHERE id = ?`, [idIntegration]);
	if (!integ) throw httpErr(404, "Integration not found");
	const def = integ.assortment_mode === "selected" ? "exclude" : "include";
	const defReason = def === "include" ? "default_all" : "default_selected";

	// mode IS NULL — рядок тримає лише значення для сайту (ціна, назва), рішення успадковується
	const [rules] = await pool.query(`SELECT entity, id_entity, mode FROM ${P}settings_integrations_assortment WHERE id_integration = ? AND mode IS NOT NULL`, [idIntegration]);
	const prodRule = new Map();
	const catRule = new Map();
	for (const r of rules) (r.entity === "product" ? prodRule : catRule).set(Number(r.id_entity), r.mode);

	// id_category → [предки від найближчого: {anc, depth}]; включно із самою категорією (depth 0)
	const pathCache = new Map();
	async function loadPaths(catIds) {
		const missing = [...new Set(catIds)].filter((c) => !pathCache.has(c));
		for (let i = 0; i < missing.length; i += CHUNK) {
			const part = missing.slice(i, i + CHUNK);
			part.forEach((c) => pathCache.set(c, []));
			const [rows] = await pool.query(`SELECT id_category, id_ancestor, depth FROM ${P}products_categories_path WHERE id_category IN (?) ORDER BY id_category, depth`, [part]);
			for (const r of rows) pathCache.get(Number(r.id_category)).push({ anc: Number(r.id_ancestor), depth: Number(r.depth) });
		}
	}
	const ancestorsOf = (c) => (pathCache.get(c) && pathCache.get(c).length ? pathCache.get(c) : [{ anc: c, depth: 0 }]);

	/** Найближче рішення для категорії (skipSelf — без самої категорії, для «успадковано») */
	function categoryDecision(c, skipSelf) {
		for (const p of ancestorsOf(c)) {
			if (skipSelf && p.depth === 0) continue;
			if (catRule.has(p.anc)) return { mode: catRule.get(p.anc), ref: p.anc };
		}
		return null;
	}

	/** Стан товарів: Map(id → { published, reason, ref }) */
	async function products(ids) {
		const out = new Map();
		const rest = [];
		for (const id of ids) {
			const pr = prodRule.get(Number(id));
			if (pr) out.set(Number(id), { published: pr === "include", reason: `product_${pr}`, ref: null });
			else rest.push(Number(id));
		}
		if (!rest.length) return out;
		if (!catRule.size) {
			rest.forEach((id) => out.set(id, { published: def === "include", reason: defReason, ref: null }));
			return out;
		}

		const catsOf = new Map();
		for (let i = 0; i < rest.length; i += CHUNK) {
			const [rows] = await pool.query(`SELECT id_product, id_category FROM ${P}products_to_categories WHERE id_product IN (?)`, [rest.slice(i, i + CHUNK)]);
			for (const r of rows) {
				if (!catsOf.has(r.id_product)) catsOf.set(r.id_product, []);
				catsOf.get(r.id_product).push(Number(r.id_category));
			}
		}
		await loadPaths([].concat(...catsOf.values()));

		for (const id of rest) {
			const cats = catsOf.get(id) || [];
			let inc = null;
			let exc = null;
			let viaDefault = false;
			for (const c of cats) {
				const d = categoryDecision(c, false);
				if (!d) viaDefault = true;
				else if (d.mode === "include") inc = inc || d;
				else exc = exc || d;
			}
			if (inc) out.set(id, { published: true, reason: "category_include", ref: inc.ref });
			else if (viaDefault || !cats.length) out.set(id, { published: def === "include", reason: defReason, ref: null });
			else out.set(id, { published: false, reason: "category_exclude", ref: exc.ref });
		}
		return out;
	}

	/** Категорії, що йдуть на сайт: увімкнені (з успадкуванням) + категорії вручну увімкнених товарів + усі їхні предки */
	async function categories() {
		const [all] = await pool.query(`SELECT id FROM ${P}products_categories`);
		const ids = all.map((r) => Number(r.id));
		const set = new Set();
		if (!catRule.size && def === "include") {
			ids.forEach((id) => set.add(id));
			return set;
		}
		await loadPaths(ids);
		for (const c of ids) {
			const d = categoryDecision(c, false);
			if ((d ? d.mode : def) === "include") set.add(c);
		}
		const included = [...prodRule].filter(([, m]) => m === "include").map(([id]) => id);
		for (let i = 0; i < included.length; i += CHUNK) {
			const [rows] = await pool.query(`SELECT DISTINCT id_category FROM ${P}products_to_categories WHERE id_product IN (?)`, [included.slice(i, i + CHUNK)]);
			rows.forEach((r) => set.add(Number(r.id_category)));
		}
		await loadPaths([...set]);
		for (const c of [...set]) ancestorsOf(c).forEach((p) => set.add(p.anc));
		return set;
	}

	/** Скільки товарів іде на сайт (для прогресу обміну) */
	async function countProducts() {
		let n = 0;
		let after = 0;
		for (;;) {
			const [rows] = await pool.query(`SELECT id FROM ${P}products WHERE id > ? ORDER BY id LIMIT ?`, [after, CHUNK]);
			if (!rows.length) break;
			after = rows[rows.length - 1].id;
			const st = await products(rows.map((r) => r.id));
			st.forEach((s) => s.published && n++);
		}
		return n;
	}

	return { mode: integ.assortment_mode, products, categories, countProducts, categoryDecision, loadPaths, catRule, def, defReason };
}

/**
 * SQL-умова «товар (alias p) передається на сайт інтеграції» — та сама логіка, що й resolver():
 * рішення товару → найближча категорія вгору по дереву → режим інтеграції.
 * Без кешу, тож завжди актуальна. Для фільтрів і лічильників.
 */
function sqlPublished(idIntegration, alias = "p") {
	const def = `(SELECT IF(si.assortment_mode = 'selected', 'exclude', 'include') FROM ${P}settings_integrations si WHERE si.id = ?)`;
	const sql = `COALESCE(
		(SELECT a.mode = 'include' FROM ${P}settings_integrations_assortment a
		  WHERE a.id_integration = ? AND a.entity = 'product' AND a.id_entity = ${alias}.id),
		IF(EXISTS (SELECT 1 FROM ${P}products_to_categories x WHERE x.id_product = ${alias}.id),
		   EXISTS (SELECT 1 FROM ${P}products_to_categories x WHERE x.id_product = ${alias}.id AND COALESCE(
		       (SELECT a.mode FROM ${P}products_categories_path pp
		          JOIN ${P}settings_integrations_assortment a ON a.id_integration = ? AND a.entity = 'category' AND a.id_entity = pp.id_ancestor
		         WHERE pp.id_category = x.id_category ORDER BY pp.depth LIMIT 1),
		       ${def}) = 'include'),
		   ${def} = 'include'))`;
	const id = Number(idIntegration);
	return { sql, params: [id, id, id, id] };
}

/** Скільки товарів (не видалених) іде на кожен сайт: { id_integration: n } */
async function counts() {
	const integs = await catalogIntegrations();
	const out = {};
	for (const i of integs) {
		const w = sqlPublished(i.id);
		const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products p WHERE p.deleted_at IS NULL AND ${w.sql}`, w.params);
		out[i.id] = Number(r.n);
	}
	const [[t]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products WHERE deleted_at IS NULL`);
	const [errs] = await pool.query(`SELECT id_integration, COUNT(*) AS n FROM ${P}settings_integrations_assortment WHERE entity = 'product' AND err_message IS NOT NULL GROUP BY id_integration`);
	return { counts: out, total: Number(t.n), errors: Object.fromEntries(errs.map((r) => [r.id_integration, Number(r.n)])) };
}

/** Інтеграції з обміном каталогу */
async function catalogIntegrations() {
	const [rows] = await pool.query(`SELECT id, name, platform, color_text, color_background, status, assortment_mode FROM ${P}settings_integrations ORDER BY name`);
	return rows.filter((r) => {
		const pl = platforms.get(r.platform);
		return pl && pl.caps.includes("catalog");
	});
}

async function categoryNames(ids) {
	if (!ids.length) return new Map();
	const langs = await languages.active();
	const lang = langs[0] ? langs[0].id : 1;
	const [rows] = await pool.query(`SELECT id_category, name FROM ${P}products_categories_description WHERE id_category IN (?) AND id_lang = ?`, [ids, lang]);
	return new Map(rows.map((r) => [Number(r.id_category), r.name]));
}

/** Для картки товару / категорії: стан по кожній інтеграції */
async function forEntity(entity, id) {
	if (!ENTITIES.includes(entity)) throw httpErr(400, "Bad entity");
	const integs = await catalogIntegrations();
	const [own] = integs.length ? await pool.query(`SELECT id_integration, mode, overrides, err_message, err_attempts, err_at, retry_at, sent_at FROM ${P}settings_integrations_assortment WHERE entity = ? AND id_entity = ?`, [entity, id]) : [[]];
	const ownOf = new Map(own.filter((r) => r.mode).map((r) => [Number(r.id_integration), r.mode]));
	const ovOf = new Map(own.map((r) => [Number(r.id_integration), normOverrides(r.overrides)]));
	const sentOf = new Map(own.filter((r) => r.sent_at).map((r) => [Number(r.id_integration), r.sent_at]));
	const errOf = new Map(own.filter((r) => r.err_message).map((r) => [Number(r.id_integration), { message: r.err_message, attempts: Number(r.err_attempts) || 0, at: r.err_at, retry_at: r.retry_at }]));

	const out = [];
	for (const i of integs) {
		const r = await resolver(i.id);
		let st;
		if (entity === "product") {
			st = (await r.products([id])).get(Number(id));
		} else {
			await r.loadPaths([Number(id)]);
			const mine = ownOf.get(i.id);
			const inherited = r.categoryDecision(Number(id), true);
			if (mine) st = { published: mine === "include", reason: `own_${mine}`, ref: null };
			else if (inherited) st = { published: inherited.mode === "include", reason: `category_${inherited.mode}`, ref: inherited.ref };
			else st = { published: r.def === "include", reason: r.defReason, ref: null };
		}
		out.push({
			id: i.id,
			name: i.name,
			color_text: i.color_text,
			color_background: i.color_background,
			active: i.status === "active",
			assortment_mode: i.assortment_mode,
			own: ownOf.get(i.id) || null,
			overrides: entity === "product" ? ovOf.get(i.id) || null : null,
			error: errOf.get(i.id) || null,
			sent_at: sentOf.get(i.id) || null,
			published: !!st.published,
			reason: st.reason,
			ref: st.ref,
		});
	}
	const names = await categoryNames([...new Set(out.map((o) => o.ref).filter(Boolean))]);
	out.forEach((o) => (o.ref_name = o.ref ? names.get(o.ref) || `#${o.ref}` : null));
	return out;
}

/** Встановити рішення (mode = null — наслідувати) */
async function set(entity, ids, idIntegration, mode, idUser) {
	if (!ENTITIES.includes(entity)) throw httpErr(400, "Bad entity");
	if (mode !== null && !MODES.includes(mode)) throw httpErr(400, "Bad mode");
	ids = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 10000);
	if (!ids.length) throw httpErr(400, "Bad id");
	const [[integ]] = await pool.query(`SELECT id FROM ${P}settings_integrations WHERE id = ?`, [idIntegration]);
	if (!integ) throw httpErr(404, "Integration not found");

	if (mode === null) {
		// Значення для сайту (ціна, назва) лишаються — зникає лише рішення
		await pool.query(`DELETE FROM ${P}settings_integrations_assortment WHERE id_integration = ? AND entity = ? AND id_entity IN (?) AND overrides IS NULL AND err_message IS NULL AND sent_hash IS NULL`, [idIntegration, entity, ids]);
		await pool.query(`UPDATE ${P}settings_integrations_assortment SET mode = NULL, date_edit = NOW() WHERE id_integration = ? AND entity = ? AND id_entity IN (?)`, [idIntegration, entity, ids]);
		return { updated: ids.length };
	}

	const table = entity === "product" ? "products" : "products_categories";
	const [found] = await pool.query(`SELECT id FROM ${P}${table} WHERE id IN (?)`, [ids]);
	if (!found.length) throw httpErr(404, "Not found");
	await pool.query(
		`INSERT INTO ${P}settings_integrations_assortment (id_integration, entity, id_entity, mode, id_user, date_edit) VALUES ?
		 ON DUPLICATE KEY UPDATE mode = VALUES(mode), id_user = VALUES(id_user), date_edit = NOW()`,
		[found.map((r) => [idIntegration, entity, r.id, mode, idUser || null, new Date()])]
	);
	return { updated: found.length };
}

/* ─── Значення для сайту: правило ціни інтеграції + ціна / назва конкретного товару ─────────── */

const PRICE_SOURCES = ["price", "wholesale_price", "compare_at_price"];
const ROUNDS = ["none", "int", "9", "99", "10"];
const parseJson = (v) => {
	if (!v) return null;
	try {
		return typeof v === "string" ? JSON.parse(v) : v;
	} catch (e) {
		return null;
	}
};
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Правило ціни сайту: джерело, націнка %, округлення, мінімальна націнка над собівартістю % */
function normRule(raw) {
	const r = parseJson(raw) || {};
	const percent = num(r.percent);
	const minMargin = num(r.min_margin);
	const rate = num(r.rate);
	const currency = /^[A-Z]{3}$/.test(String(r.currency || "").toUpperCase()) ? String(r.currency).toUpperCase() : null;
	const ids = (a) => [...new Set((Array.isArray(a) ? a : [a]).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
	return {
		source: PRICE_SOURCES.includes(r.source) ? r.source : "price",
		percent: percent === null ? 0 : Math.max(-99, Math.min(1000, percent)),
		round: ROUNDS.includes(String(r.round)) ? String(r.round) : "none",
		min_margin: minMargin === null ? null : Math.max(0, Math.min(1000, minMargin)),
		// Валюта сайту: ціна системи × курс (1 одиниця базової валюти = rate одиниць валюти сайту)
		currency,
		rate: currency && rate > 0 ? Math.min(1e6, rate) : null,
		// Умовні правила: перше, що підійшло, замінює загальну націнку
		rules: (Array.isArray(r.rules) ? r.rules : [])
			.slice(0, 50)
			.map((x) => {
				const p = num(x && x.percent);
				return {
					brands: ids(x && x.brands),
					categories: ids(x && x.categories),
					price_from: num(x && x.price_from),
					price_to: num(x && x.price_to),
					percent: p === null ? 0 : Math.max(-99, Math.min(1000, p)),
				};
			})
			.filter((x) => x.brands.length || x.categories.length || x.price_from !== null || x.price_to !== null),
	};
}
const ruleIsDefault = (r) => r.source === "price" && !r.percent && r.round === "none" && r.min_margin === null && !r.rate && !r.rules.length;

/** Умовне правило для товару: бренд, категорія (з підкатегоріями), діапазон ціни */
function matchRule(rule, info, base) {
	for (const x of rule.rules) {
		if (x.brands.length && !(info && x.brands.includes(Number(info.id_brand)))) continue;
		if (x.categories.length && !(info && x.categories.some((c) => info.ancestors.has(c)))) continue;
		if (x.price_from !== null && base < x.price_from) continue;
		if (x.price_to !== null && base > x.price_to) continue;
		return x;
	}
	return null;
}

/** Значення товару для сайту: { price, names: { code: name } } або null */
function normOverrides(raw) {
	const o = parseJson(raw) || {};
	const price = num(o.price);
	const names = {};
	for (const [code, name] of Object.entries(o.names || {})) {
		const t = String(name || "")
			.trim()
			.slice(0, 255);
		if (/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(code) && t) names[code] = t;
	}
	const out = {};
	if (price !== null && price >= 0) out.price = Math.round(price * 10000) / 10000;
	if (Object.keys(names).length) out.names = names;
	return Object.keys(out).length ? out : null;
}

function roundPrice(v, mode) {
	if (!(v > 0)) return Math.max(0, Math.round((v || 0) * 100) / 100);
	if (mode === "int") return Math.round(v);
	if (mode === "10") return Math.max(10, Math.round(v / 10) * 10);
	if (mode === "9") return Math.max(9, Math.ceil((v + 1) / 10) * 10 - 1);
	if (mode === "99") return Math.floor(v) + 0.99;
	return Math.round(v * 100) / 100;
}

/** Ціна товару (рядок products) для сайту */
function sitePrice(row, rule, ov, info) {
	// Ціна товару для сайту задається вже у валюті сайту
	if (ov && ov.price !== undefined) return ov.price;
	let v = num(row[rule.source]);
	if (!(v > 0)) v = Number(row.price) || 0;
	const hit = matchRule(rule, info, v);
	const percent = hit ? hit.percent : rule.percent;
	if (percent) v *= 1 + percent / 100;
	const cost = num(row.cost_price);
	if (rule.min_margin !== null && cost > 0) v = Math.max(v, cost * (1 + rule.min_margin / 100));
	if (rule.rate) v *= rule.rate;
	return roundPrice(v, rule.round);
}

/** Усе, що потрібно, щоб застосувати значення сайту до набору товарів */
/* ─── Правила вмісту сайту: шаблони назви й обрамлення опису ─────────────────── */

const CONTENT_FIELDS = ["name", "description_before", "description_after"];

/**
 * { templates: { "*": {name, description_before, description_after}, "uk": {...} } }
 * Токени: {name} {brand} {sku} {ean} {category} {h1}; фрагмент у [ ] зникає, якщо хоч один токен у ньому порожній.
 */
function normContent(raw) {
	const r = parseJson(raw) || {};
	const templates = {};
	for (const [code, t] of Object.entries(r.templates || {})) {
		if (code !== "*" && !/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(code)) continue;
		const o = {};
		for (const f of CONTENT_FIELDS) {
			const v = String((t && t[f]) || "").slice(0, f === "name" ? 255 : 5000);
			if (v.trim()) o[f] = v;
		}
		if (Object.keys(o).length) templates[code] = o;
	}
	return { templates };
}

function fillTemplate(tpl, vals) {
	const tok = (s) => s.replace(/\{(name|brand|sku|ean|category|h1)\}/g, (_, k) => vals[k] || "");
	// [ … ] — необов'язковий фрагмент
	const out = tpl.replace(/\[([^\]]*)\]/g, (_, frag) => {
		const keys = [...frag.matchAll(/\{(name|brand|sku|ean|category|h1)\}/g)].map((m) => m[1]);
		return keys.some((k) => !vals[k]) ? "" : tok(frag);
	});
	return tok(out).replace(/\s{2,}/g, " ").trim();
}

/** Шаблони сайту → назви й описи елемента обміну (за мовами; назва з картки для сайту має пріоритет — її ставить applyToItem) */
function applyContent(item, ch) {
	const t = ch.content.templates;
	if (!Object.keys(t).length || !Array.isArray(item.languages)) return item;
	const catNames = ch.catNames.get(Number(item.main_category)) || new Map();
	return {
		...item,
		languages: item.languages.map((l) => {
			const tp = { ...(t["*"] || {}), ...(t[l.code] || {}) };
			if (!Object.keys(tp).length) return l;
			const vals = { name: l.name, brand: item.brand, sku: item.sku, ean: item.ean, h1: l.h1, category: catNames.get(l.code) || "" };
			const out = { ...l };
			if (tp.name) out.name = fillTemplate(tp.name, vals).slice(0, 255) || l.name;
			if (tp.description_before) out.description = fillTemplate(tp.description_before, vals) + (l.description || "");
			if (tp.description_after) out.description = (out.description || "") + fillTemplate(tp.description_after, vals);
			return out;
		}),
	};
}

/** Склади й запас сайту: { warehouses: [id] (порожньо — усі продавані), buffer: шт., що віднімаються від залишку } */
function normStock(raw) {
	const r = parseJson(raw) || {};
	const warehouses = [...new Set((Array.isArray(r.warehouses) ? r.warehouses : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 100);
	const buffer = Math.max(0, Math.min(100000, parseInt(r.buffer, 10) || 0));
	return { warehouses, buffer };
}

async function channel(idIntegration, ids) {
	const [[integ]] = await pool.query(`SELECT price_rule, stock_rule, content_rule FROM ${P}settings_integrations WHERE id = ?`, [idIntegration]);
	const content = normContent(integ && integ.content_rule);
	// Назви головних категорій кожною мовою — для токена {category}
	const catNames = new Map();
	if (ids && ids.length && JSON.stringify(content.templates).includes("{category}")) {
		const [cn] = await pool.query(
			`SELECT d.id_category, l.code, d.name FROM ${P}products p
			   JOIN ${P}products_categories_description d ON d.id_category = p.id_category_main
			   JOIN ${P}products_languages l ON l.id = d.id_lang
			  WHERE p.id IN (?)`,
			[ids]
		);
		for (const r of cn) {
			if (!catNames.has(Number(r.id_category))) catNames.set(Number(r.id_category), new Map());
			catNames.get(Number(r.id_category)).set(r.code, r.name || "");
		}
	}
	const rule = normRule(integ && integ.price_rule);
	const stockRule = normStock(integ && integ.stock_rule);
	const ov = new Map();
	if (ids && ids.length) {
		const [rows] = await pool.query(`SELECT id_entity, overrides FROM ${P}settings_integrations_assortment WHERE id_integration = ? AND entity = 'product' AND id_entity IN (?) AND overrides IS NOT NULL`, [idIntegration, ids]);
		for (const r of rows) {
			const o = normOverrides(r.overrides);
			if (o) ov.set(Number(r.id_entity), o);
		}
	}
	// Бренд і предки головної категорії — для умовних правил
	const info = new Map();
	if (rule.rules.length && ids && ids.length) {
		const [prows] = await pool.query(`SELECT id, id_brand, id_category_main FROM ${P}products WHERE id IN (?)`, [ids]);
		prows.forEach((r) => info.set(Number(r.id), { id_brand: r.id_brand, ancestors: new Set() }));
		const [paths] = await pool.query(
			`SELECT p.id, cp.id_ancestor FROM ${P}products p JOIN ${P}products_categories_path cp ON cp.id_category = p.id_category_main WHERE p.id IN (?)`,
			[ids]
		);
		paths.forEach((r) => info.get(Number(r.id)) && info.get(Number(r.id)).ancestors.add(Number(r.id_ancestor)));
	}
	const active = !ruleIsDefault(rule) || ov.size > 0;
	const stockActive = stockRule.warehouses.length > 0 || stockRule.buffer > 0;
	return {
		rule,
		active,
		overrides: (id) => ov.get(Number(id)) || null,
		price: (row) => sitePrice(row, rule, ov.get(Number(row.id)), info.get(Number(row.id))),
		stockRule,
		stockActive,
		content,
		catNames,
		// Залишок для сайту: лише склади сайту, мінус запас (не нижче 0)
		siteQty: (q) => Math.max(0, Math.floor(Number(q) || 0) - stockRule.buffer),
		/** Map "id_product:id_variant" → доступно на складах сайту; "id_product:*" — сума по товару */
		stock: async (productIds) => {
			const out = new Map();
			if (!productIds || !productIds.length) return out;
			const [rows] = await pool.query(
				`SELECT s.id_product, s.id_variant, SUM(s.available) AS qty
				   FROM ${P}products_stock s
				   JOIN ${P}products_warehouses w ON w.id = s.id_warehouse AND w.deleted_at IS NULL AND w.status = 1 AND w.is_sellable = 1
				        ${stockRule.warehouses.length ? "AND w.id IN (?)" : ""}
				  WHERE s.id_product IN (?) GROUP BY s.id_product, s.id_variant`,
				stockRule.warehouses.length ? [stockRule.warehouses, productIds] : [productIds]
			);
			for (const r of rows) {
				const q = Number(r.qty) || 0;
				out.set(`${r.id_product}:${r.id_variant}`, q);
				out.set(`${r.id_product}:*`, (out.get(`${r.id_product}:*`) || 0) + q);
			}
			return out;
		},
	};
}

/** Залишки сайту в елементі обміну (товар і варіанти) */
function applyStock(item, ch, qmap) {
	if (!ch.stockActive || !qmap) return item;
	const id = Number(item.crm_id);
	const out = { ...item };
	if (out.track) out.quantity = ch.siteQty(qmap.get(`${id}:*`) || 0);
	if (Array.isArray(out.variants)) out.variants = out.variants.map((v) => ({ ...v, quantity: ch.siteQty(qmap.get(`${id}:${v.crm_id}`) || 0) }));
	return out;
}

/**
 * Застосувати значення сайту до елемента обміну (crm_id, price, variants, languages).
 * Варіанти отримують ту саму пропорцію, що й товар, і те саме округлення.
 */
function applyToItem(item, row, ch) {
	if (!ch.active) return item;
	const ov = ch.overrides(row.id);
	const base = Number(item.price) || 0;
	const next = ch.price(row);
	const ratio = base > 0 ? next / base : 1;
	const out = { ...item, price: next };
	if (Array.isArray(item.variants) && ratio !== 1) out.variants = item.variants.map((v) => ({ ...v, price: roundPrice(Number(v.price) * ratio, ch.rule.round) }));
	if (ov && ov.names && Array.isArray(item.languages)) out.languages = item.languages.map((l) => (ov.names[l.code] ? { ...l, name: ov.names[l.code] } : l));
	return out;
}

/** Зберегти значення товару для сайту (null / порожнє — прибрати) */
async function setOverrides(idIntegration, idProduct, raw, idUser) {
	const [[integ]] = await pool.query(`SELECT id FROM ${P}settings_integrations WHERE id = ?`, [idIntegration]);
	if (!integ) throw httpErr(404, "Integration not found");
	const [[p]] = await pool.query(`SELECT id FROM ${P}products WHERE id = ?`, [idProduct]);
	if (!p) throw httpErr(404, "Not found");
	const ov = normOverrides(raw);
	if (!ov) {
		await pool.query(`UPDATE ${P}settings_integrations_assortment SET overrides = NULL, date_edit = NOW() WHERE id_integration = ? AND entity = 'product' AND id_entity = ?`, [idIntegration, idProduct]);
		await pool.query(`DELETE FROM ${P}settings_integrations_assortment WHERE id_integration = ? AND entity = 'product' AND id_entity = ? AND mode IS NULL AND err_message IS NULL AND sent_hash IS NULL`, [idIntegration, idProduct]);
		return null;
	}
	await pool.query(
		`INSERT INTO ${P}settings_integrations_assortment (id_integration, entity, id_entity, mode, overrides, id_user, date_edit) VALUES (?, 'product', ?, NULL, ?, ?, NOW())
		 ON DUPLICATE KEY UPDATE overrides = VALUES(overrides), id_user = VALUES(id_user), date_edit = NOW()`,
		[idIntegration, idProduct, JSON.stringify(ov), idUser || null]
	);
	return ov;
}

/* ─── Черга помилок: товари, які сайт не прийняв ───────────────────────────── */

const MAX_ATTEMPTS = 8;

/** Результат пакета обміну: прийняті — з черги прибрати, відхилені — записати з наростаючою паузою */
async function recordResults(idIntegration, items, results) {
	const byId = new Map((results || []).filter((r) => r && r.crm_id !== undefined).map((r) => [Number(r.crm_id), r]));
	const ok = [];
	const bad = [];
	for (const it of items) {
		const r = byId.get(Number(it.crm_id));
		if (r && r.ok === false) bad.push([Number(it.crm_id), String(r.error || r.message || "error").slice(0, 500)]);
		else ok.push(Number(it.crm_id));
	}
	if (ok.length) await recordSent(idIntegration, items.filter((it) => ok.includes(Number(it.crm_id))));
	if (ok.length) {
		await pool.query(
			`UPDATE ${P}settings_integrations_assortment SET err_message = NULL, err_attempts = 0, err_at = NULL, retry_at = NULL
			  WHERE id_integration = ? AND entity = 'product' AND id_entity IN (?) AND err_message IS NOT NULL`,
			[idIntegration, ok]
		);
		await pool.query(
			`DELETE FROM ${P}settings_integrations_assortment
			  WHERE id_integration = ? AND entity = 'product' AND id_entity IN (?) AND mode IS NULL AND overrides IS NULL AND err_message IS NULL AND sent_hash IS NULL`,
			[idIntegration, ok]
		);
	}
	// Пауза: 5 хв × 2^(спроба−1), не більше доби
	for (const [id, msg] of bad) {
		await pool.query(
			`INSERT INTO ${P}settings_integrations_assortment (id_integration, entity, id_entity, mode, err_message, err_attempts, err_at, retry_at, date_edit)
			 VALUES (?, 'product', ?, NULL, ?, 1, NOW(), NOW() + INTERVAL 5 MINUTE, NOW())
			 ON DUPLICATE KEY UPDATE err_message = VALUES(err_message), err_attempts = err_attempts + 1, err_at = NOW(),
			                         retry_at = NOW() + INTERVAL LEAST(1440, 5 * POW(2, err_attempts - 1)) MINUTE`,
			[idIntegration, id, msg]
		);
	}
	return { ok: ok.length, bad: bad.length };
}

/**
 * Канальна історія: сайт прийняв товар — запам'ятати відбиток переданого; якщо він змінився з минулого разу,
 * записати в історію товару «що передано на сайт» (ціна, залишок, статус, назва).
 */
async function recordSent(idIntegration, items) {
	if (!items.length) return;
	const ids = items.map((it) => Number(it.crm_id));
	const [prev] = await pool.query(
		`SELECT id_entity, sent_hash FROM ${P}settings_integrations_assortment WHERE id_integration = ? AND entity = 'product' AND id_entity IN (?)`,
		[idIntegration, ids]
	);
	const before = new Map(prev.map((r) => [Number(r.id_entity), r.sent_hash]));
	const changed = [];
	for (const it of items) {
		const hash = crypto.createHash("md5").update(JSON.stringify(it)).digest("hex");
		if (before.get(Number(it.crm_id)) !== hash) changed.push([it, hash]);
	}
	if (!changed.length) return;
	await pool.query(
		`INSERT INTO ${P}settings_integrations_assortment (id_integration, entity, id_entity, mode, sent_hash, sent_at, date_edit) VALUES ?
		 ON DUPLICATE KEY UPDATE sent_hash = VALUES(sent_hash), sent_at = VALUES(sent_at)`,
		[changed.map(([it, hash]) => [idIntegration, "product", Number(it.crm_id), null, hash, new Date(), new Date()])]
	);
	const [[site]] = await pool.query(`SELECT name FROM ${P}settings_integrations WHERE id = ?`, [idIntegration]);
	const history = require("../../catalog/products/history");
	for (const [it] of changed) {
		const name = ((it.languages || [])[0] || {}).name || "";
		const text = [
			`${site ? site.name : "#" + idIntegration}:`,
			`ціна ${it.price}`,
			it.track ? `залишок ${it.quantity}` : null,
			`статус ${it.status ? "увімкнено" : "вимкнено"}`,
			Array.isArray(it.variants) && it.variants.length ? `варіантів ${it.variants.length}` : null,
			name ? `«${name.slice(0, 80)}»` : null,
		]
			.filter(Boolean)
			.join(" ");
		await history.record("products", it.crm_id, {
			user: null,
			source: "sync",
			action: "update",
			changes: [{ field: "site_sync", old: null, new: text }],
			meta: { id_integration: idIntegration },
		});
	}
}

/** Список «не прийняті сайтом» */
async function errorsList(idIntegration, idLang) {
	const [rows] = await pool.query(
		`SELECT a.id_entity AS id, a.err_message AS message, a.err_attempts AS attempts, a.err_at AS at, a.retry_at,
		        p.sku, COALESCE(NULLIF(d.name, ''), CONCAT('#', a.id_entity)) AS name
		   FROM ${P}settings_integrations_assortment a
		   LEFT JOIN ${P}products p ON p.id = a.id_entity
		   LEFT JOIN ${P}products_description d ON d.id_product = a.id_entity AND d.id_lang = ?
		  WHERE a.id_integration = ? AND a.entity = 'product' AND a.err_message IS NOT NULL
		  ORDER BY a.err_at DESC LIMIT 1000`,
		[idLang || 1, idIntegration]
	);
	return rows.map((r) => ({ ...r, attempts: Number(r.attempts), exhausted: Number(r.attempts) >= MAX_ATTEMPTS }));
}

/** «Спробувати знову»: скинути лічильник і поставити в чергу зараз (ids порожній — усі) */
async function retryNow(idIntegration, ids) {
	const list = (ids || []).map(Number).filter((n) => n > 0);
	const [r] = await pool.query(
		`UPDATE ${P}settings_integrations_assortment SET err_attempts = 0, retry_at = NOW()
		  WHERE id_integration = ? AND entity = 'product' AND err_message IS NOT NULL${list.length ? " AND id_entity IN (?)" : ""}`,
		list.length ? [idIntegration, list] : [idIntegration]
	);
	return r.affectedRows;
}

/** Сайти, у яких настав час повтору (і ще є спроби). Відсуваємо retry_at, щоб не запускати двічі, поки йде обмін */
async function dueRetries() {
	const [rows] = await pool.query(
		`SELECT a.id_integration, COUNT(*) AS n FROM ${P}settings_integrations_assortment a
		   JOIN ${P}settings_integrations i ON i.id = a.id_integration AND i.status = 'active'
		  WHERE a.entity = 'product' AND a.err_message IS NOT NULL AND a.retry_at <= NOW() AND a.err_attempts < ?
		  GROUP BY a.id_integration`,
		[MAX_ATTEMPTS]
	);
	for (const r of rows) {
		await pool.query(
			`UPDATE ${P}settings_integrations_assortment SET retry_at = NOW() + INTERVAL 30 MINUTE
			  WHERE id_integration = ? AND entity = 'product' AND err_message IS NOT NULL AND retry_at <= NOW()`,
			[r.id_integration]
		);
	}
	return rows.map((r) => Number(r.id_integration));
}

module.exports = { normContent, applyContent, fillTemplate, normStock, applyStock, recordResults, errorsList, retryNow, dueRetries, MAX_ATTEMPTS, resolver, forEntity, set, catalogIntegrations, sqlPublished, counts, normRule, channel, applyToItem, roundPrice, setOverrides };
