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
	const [rows] = await pool.query(`SELECT id, name, platform, color_text, color_background, status, assortment_mode, category_mode FROM ${P}settings_integrations ORDER BY name`);
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
			category_mode: i.category_mode || "system",
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

	// Рішення асортименту можуть зачепити багато товарів — наступний автообмін цього сайту буде повним
	await pool.query(`UPDATE ${P}settings_integrations SET sync_full_at = NOW() WHERE id = ?`, [idIntegration]).catch(() => {});
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
	// Категорії сайту саме для цього товару (найвищий пріоритет; режими «Дерево сайту» / «Змішаний»)
	const siteCats = [...new Set((Array.isArray(o.site_categories) ? o.site_categories : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50);
	if (siteCats.length) out.site_categories = siteCats;
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

// Поле ціни → [валюта групи, сума у валюті] — щоб сайт у тій самій валюті отримав рівно введену суму, без подвійного перерахунку
const NATIVE = { price: ["price_currency", "price_cur"], compare_at_price: ["price_currency", "compare_cur"], wholesale_price: ["wholesale_currency", "wholesale_cur"] };

/**
 * Ціна товару (рядок products) для сайту.
 * Порядок: ціна для сайту на товарі → фіксована ціна товару у валюті сайту → ціна у валюті сайту, введена на товарі
 * (без перерахунку) → базова × курс. Курс сайту: вписаний у правилі або з довідника валют (siteRate — одиниць валюти сайту за 1 базової).
 */
function sitePrice(row, rule, ov, info, siteRate) {
	// Ціна товару для сайту задається вже у валюті сайту
	if (ov && ov.price !== undefined) return ov.price;
	const cur = rule.currency;
	if (cur) {
		const fixed = parseJson(row.price_fixed);
		if (fixed && Number(fixed[cur]) > 0) return Number(fixed[cur]);
	}
	const rate = rule.rate || siteRate || null;
	const nat = cur && !rule.rate ? NATIVE[rule.source] : null;
	const native = !!(nat && row[nat[0]] === cur && num(row[nat[1]]) > 0);
	let v = native ? Number(row[nat[1]]) : num(row[rule.source]);
	if (!(v > 0)) v = Number(row.price) || 0;
	// Умовні правила (діапазон ціни) — у базовій валюті
	const hit = matchRule(rule, info, native && rate ? v / rate : v);
	const percent = hit ? hit.percent : rule.percent;
	if (percent) v *= 1 + percent / 100;
	let cost = num(row.cost_price);
	if (native && cost > 0) cost = rate ? cost * rate : null;
	if (rule.min_margin !== null && cost > 0) v = Math.max(v, cost * (1 + rule.min_margin / 100));
	if (!native && rate) v *= rate;
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
	// Ручні правки товару на сайті: overwrite — перезаписувати при нічній перевірці, highlight — лише показувати
	return { templates, manual_edits: r.manual_edits === "overwrite" ? "overwrite" : "highlight" };
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
	// Валюта сайту без вписаного курсу — курс з довідника валют (1 базової = 1 / курс валюти)
	let siteRate = null;
	if (rule.currency && !rule.rate) {
		const cx = await require("../../catalog/products/pricing").currencyCtx();
		const r = rule.currency === cx.base ? 1 : cx.rate(rule.currency);
		siteRate = r ? 1 / r : null;
	}
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
	// Валюта сайту з курсом довідника або фіксовані ціни у валюті сайту — теж «правило»
	const active = !ruleIsDefault(rule) || ov.size > 0 || !!rule.currency;
	const stockActive = stockRule.warehouses.length > 0 || stockRule.buffer > 0;
	return {
		rule,
		active,
		overrides: (id) => ov.get(Number(id)) || null,
		price: (row) => sitePrice(row, rule, ov.get(Number(row.id)), info.get(Number(row.id)), siteRate),
		// Курс сайту (одиниць валюти сайту за 1 базової): вписаний або з довідника; null — без перерахунку
		siteRate: rule.currency ? rule.rate || siteRate : null,
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
	// Сайт в іншій валюті: фіксовані надбавки опцій — теж у валюті сайту
	if (ch.siteRate && ch.siteRate !== 1 && Array.isArray(item.options)) {
		out.options = item.options.map((o) => ({ ...o, values: (o.values || []).map((x) => (x.price_mode === "fixed" ? { ...x, price: Math.round(Number(x.price) * ch.siteRate * 100) / 100 } : x)) }));
	}
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

/* ─── Категорії сайту: власне дерево сайту і відповідність «категорія системи → категорії сайту» ─── */

// system — система веде дерево на сайті; site — товари лише розкладаються по наявних категоріях сайту;
// mixed — зіставлені йдуть у категорії сайту, решту система створює (під category_root)
const CAT_MODES = ["system", "site", "mixed"];
// Товар без жодної зіставленої категорії (режим site): skip — не передавати, default — у категорію за замовчуванням
const CAT_UNMAPPED = ["skip", "default"];
// Версія модуля сайту, з якої він приймає site_categories і віддає categories.list
const SITE_CATEGORIES_MIN = "2.1.0";

const verCmp = (a, b) => {
	const x = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
	const y = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
	return 0;
};
const idList = (a, max) => [...new Set((Array.isArray(a) ? a : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, max);

const LANG_RE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/;

/**
 * Категорія для сайту: { site: [id категорії сайту], names: { code: назва }, parent: id категорії системи (0 — корінь) } або null.
 * site — відповідність (режими site / mixed); names і parent — назва й місце категорії, яку веде система (режими system / mixed).
 */
function normCatOverrides(raw) {
	const o = Array.isArray(parseJson(raw)) ? { site: parseJson(raw) } : parseJson(raw) || {};
	const out = {};
	const site = idList(o.site, 50);
	if (site.length) out.site = site;
	const names = {};
	for (const [code, name] of Object.entries(o.names && typeof o.names === "object" ? o.names : {})) {
		const t = String(name || "").trim().slice(0, 255);
		if (LANG_RE.test(code) && t) names[code] = t;
	}
	if (Object.keys(names).length) out.names = names;
	if (o.parent !== undefined && o.parent !== null && o.parent !== "" && Number.isInteger(Number(o.parent)) && Number(o.parent) >= 0) out.parent = Number(o.parent);
	return Object.keys(out).length ? out : null;
}

/**
 * Правила розкладу по категоріях сайту (за порядком). Умови: бренди, категорії системи (з підкатегоріями),
 * значення характеристик, ціна на сайті від / до, наявність. add — додати категорії сайту, replace — лише їх (далі не дивитись).
 */
function normCatRules(raw) {
	const r = parseJson(raw);
	return (Array.isArray(r) ? r : [])
		.slice(0, 100)
		.map((x) => ({
			brands: idList(x && x.brands, 200),
			categories: idList(x && x.categories, 200),
			values: idList(x && x.values, 200),
			price_from: num(x && x.price_from),
			price_to: num(x && x.price_to),
			stock: ["in", "out"].includes(x && x.stock) ? x.stock : "any",
			action: x && x.action === "replace" ? "replace" : "add",
			site: idList(x && x.site, 50),
		}))
		.filter((x) => x.site.length);
}

/** Дерево сайту: [{ id, parent, name }] */
function normSiteTree(raw) {
	const t = parseJson(raw);
	return (Array.isArray(t) ? t : [])
		.map((x) => ({ id: Number(x && x.id) || 0, parent: Number(x && x.parent) || 0, name: String((x && x.name) || "").slice(0, 255) }))
		.filter((x) => x.id > 0)
		.slice(0, 20000);
}

function normCatSettings(i) {
	return {
		mode: CAT_MODES.includes(i && i.category_mode) ? i.category_mode : "system",
		unmapped: CAT_UNMAPPED.includes(i && i.category_unmapped) ? i.category_unmapped : "skip",
		default: Number(i && i.category_default) || null,
		root: Number(i && i.category_root) || null,
	};
}

/**
 * Категорії сайту для інтеграції: що куди йде з урахуванням успадкування
 * (категорія без власної відповідності бере відповідність найближчої батьківської).
 */
async function categoryMap(idIntegration) {
	const [[i]] = await pool.query(
		`SELECT category_mode, category_unmapped, category_default, category_root, category_tree, category_rules FROM ${P}settings_integrations WHERE id = ?`,
		[idIntegration]
	);
	const cfg = normCatSettings(i);
	const tree = normSiteTree(i && i.category_tree);
	const known = new Set(tree.map((x) => x.id));
	const alive = (ids) => ids.filter((id) => !known.size || known.has(id)); // зниклі з сайту (після оновлення дерева) не передаємо
	const map = new Map();
	const ov = new Map(); // назва й місце категорії на сайті (system / mixed)
	const [rows] = await pool.query(
		`SELECT id_entity, overrides FROM ${P}settings_integrations_assortment WHERE id_integration = ? AND entity = 'category' AND overrides IS NOT NULL`,
		[idIntegration]
	);
	for (const r of rows) {
		const o = normCatOverrides(r.overrides);
		if (!o) continue;
		if (o.names || o.parent !== undefined) ov.set(Number(r.id_entity), { names: o.names || null, parent: o.parent });
		const site = cfg.mode !== "system" && o.site ? alive(o.site) : [];
		if (site.length) map.set(Number(r.id_entity), site);
	}
	const rules = cfg.mode === "system" ? [] : normCatRules(i && i.category_rules).map((x) => ({ ...x, site: alive(x.site) })).filter((x) => x.site.length);
	const pathCache = new Map();
	async function loadPaths(catIds) {
		const missing = [...new Set(catIds.map(Number))].filter((c) => c > 0 && !pathCache.has(c));
		for (let k = 0; k < missing.length; k += CHUNK) {
			const part = missing.slice(k, k + CHUNK);
			part.forEach((c) => pathCache.set(c, []));
			const [rows] = await pool.query(`SELECT id_category, id_ancestor FROM ${P}products_categories_path WHERE id_category IN (?) ORDER BY id_category, depth`, [part]);
			for (const r of rows) pathCache.get(Number(r.id_category)).push(Number(r.id_ancestor));
		}
	}
	/** Найближча відповідність вгору по дереву: { site, ref } або null */
	function nearest(c) {
		const path = pathCache.get(Number(c));
		for (const anc of path && path.length ? path : [Number(c)]) if (map.has(anc)) return { site: map.get(anc), ref: anc };
		return null;
	}
	const defOk = cfg.default && (!known.size || known.has(cfg.default));

	// Дані товарів для правил і категорії сайту, задані на самому товарі
	const info = new Map();
	const manual = new Map();
	async function prepare(prodRows) {
		if (cfg.mode === "system" || !prodRows.length) return;
		const ids = prodRows.map((r) => Number(r.id));
		prodRows.forEach((r) => info.set(Number(r.id), { brand: Number(r.id_brand) || 0, values: new Set() }));
		const [ovRows] = await pool.query(
			`SELECT id_entity, overrides FROM ${P}settings_integrations_assortment WHERE id_integration = ? AND entity = 'product' AND id_entity IN (?) AND overrides IS NOT NULL`,
			[idIntegration, ids]
		);
		for (const r of ovRows) {
			const o = normOverrides(r.overrides);
			const site = o && o.site_categories ? alive(o.site_categories) : [];
			if (site.length) manual.set(Number(r.id_entity), site);
		}
		if (rules.some((x) => x.values.length)) {
			const [vals] = await pool.query(`SELECT id_product, id_attribute_value FROM ${P}products_to_attributes WHERE id_product IN (?) AND id_attribute_value IS NOT NULL`, [ids]);
			vals.forEach((v) => info.get(Number(v.id_product)) && info.get(Number(v.id_product)).values.add(Number(v.id_attribute_value)));
		}
		if (rules.some((x) => x.categories.length)) {
			const [cats] = await pool.query(`SELECT DISTINCT id_category FROM ${P}products_to_categories WHERE id_product IN (?)`, [ids]);
			await loadPaths(cats.map((c) => c.id_category));
		}
	}
	function ruleMatch(x, it) {
		const inf = info.get(Number(it.crm_id)) || { brand: 0, values: new Set() };
		if (x.brands.length && !x.brands.includes(inf.brand)) return false;
		if (x.categories.length && !(it._sysCats || []).some((c) => (pathCache.get(c) || [c]).some((a) => x.categories.includes(a)))) return false;
		if (x.values.length && !x.values.some((v) => inf.values.has(v))) return false;
		const price = Number(it.price) || 0;
		if (x.price_from !== null && price < x.price_from) return false;
		if (x.price_to !== null && price > x.price_to) return false;
		const inStock = !it.track || Number(it.quantity) > 0;
		if (x.stock === "in" && !inStock) return false;
		if (x.stock === "out" && inStock) return false;
		return true;
	}
	// Шлях категорії сайту («Кава › Зерно») — для попереднього перегляду
	const byId = new Map(tree.map((x) => [x.id, x]));
	function sitePath(id, g = 0) {
		const x = byId.get(Number(id));
		if (!x) return "#" + id;
		return (x.parent && byId.has(x.parent) && g < 50 ? sitePath(x.parent, g + 1) + " › " : "") + x.name;
	}

	/**
	 * Елемент обміну товару → категорії сайту. site_categories / site_main_category — ID на сайті;
	 * categories — лише ті категорії системи, що лишаються за системою (режим mixed).
	 * __unmapped — товар не передається (режим site, нічого не зіставлено, без категорії за замовчуванням).
	 */
	function apply(it) {
		if (cfg.mode === "system") return it;
		const id = Number(it.crm_id);
		let site = new Set();
		let rest = [];
		let why = "map";
		let mainSite = null;
		for (const c of it.categories || []) {
			const n = nearest(c);
			if (n) n.site.forEach((s) => site.add(s));
			else rest.push(c);
		}
		const nm = it.main_category ? nearest(it.main_category) : null;
		if (nm) mainSite = nm.site[0];
		// Пріоритет: категорії на товарі → правила (за порядком) → відповідність → за замовчуванням
		if (manual.has(id)) {
			site = new Set(manual.get(id));
			rest = [];
			mainSite = manual.get(id)[0];
			why = "manual";
		} else {
			const probe = { ...it, _sysCats: it.categories || [] };
			for (const x of rules) {
				if (!ruleMatch(x, probe)) continue;
				why = "rule";
				if (x.action === "replace") {
					site = new Set(x.site);
					rest = [];
					mainSite = x.site[0];
					break;
				}
				x.site.forEach((s) => site.add(s));
			}
		}
		const out = { ...it };
		if (cfg.mode === "site") {
			out.categories = [];
			out.main_category = null;
			if (!site.size) {
				if (cfg.unmapped === "default" && defOk) {
					site.add(cfg.default);
					why = "default";
				} else out.__unmapped = true;
			}
		} else {
			out.categories = rest;
			out.main_category = rest.includes(it.main_category) && !mainSite ? it.main_category : mainSite ? null : rest[0] || null;
		}
		out.site_categories = [...site].sort((a, b) => a - b);
		out.site_main_category = mainSite && site.has(mainSite) ? mainSite : out.main_category ? null : out.site_categories[0] || null;
		// Звідки категорії (для попереднього перегляду) — неперелічуване поле, на сайт не йде й не впливає на відбиток
		Object.defineProperty(out, "__why", { value: why, enumerable: false });
		return out;
	}

	return { ...cfg, tree, map, ov, rules, loadPaths, nearest, prepare, apply, sitePath };
}

/** Для вікна «Категорії сайту»: налаштування, дерево сайту, категорії системи (що йдуть на сайт) і відповідність */
async function categoriesGet(idIntegration, idLang) {
	const [[i]] = await pool.query(
		`SELECT id, category_mode, category_unmapped, category_default, category_root, category_tree, category_tree_at, category_rules, health_version FROM ${P}settings_integrations WHERE id = ?`,
		[idIntegration]
	);
	if (!i) throw httpErr(404, "Integration not found");
	if (!idLang) idLang = ((await languages.active())[0] || {}).id || 1;
	const goes = await (await resolver(idIntegration)).categories();
	const [cats] = await pool.query(
		`SELECT c.id, c.id_parent, c.sort_order,
		        COALESCE(NULLIF(d.name, ''), CONCAT('#', c.id)) AS name,
		        COALESCE((SELECT MAX(pp.depth) FROM ${P}products_categories_path pp WHERE pp.id_category = c.id), 0) AS depth
		   FROM ${P}products_categories c
		   LEFT JOIN ${P}products_categories_description d ON d.id_category = c.id AND d.id_lang = ?
		  WHERE c.deleted_at IS NULL`,
		[idLang]
	);
	// Порядок дерева: батько, потім діти (за sort_order)
	const kids = new Map();
	for (const c of cats) {
		const k = Number(c.id_parent) || 0;
		if (!kids.has(k)) kids.set(k, []);
		kids.get(k).push(c);
	}
	const system = [];
	const walk = (parent, depth) => {
		for (const c of (kids.get(parent) || []).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)) {
			system.push({ id: Number(c.id), parent: Number(c.id_parent) || 0, depth, name: c.name, goes: goes.has(Number(c.id)) });
			walk(Number(c.id), depth + 1);
		}
	};
	walk(0, 0);

	const [rows] = await pool.query(
		`SELECT id_entity, overrides FROM ${P}settings_integrations_assortment WHERE id_integration = ? AND entity = 'category' AND overrides IS NOT NULL`,
		[idIntegration]
	);
	const map = {};
	for (const r of rows) {
		const o = normCatOverrides(r.overrides);
		if (o) map[r.id_entity] = o;
	}
	// Значення характеристик (для умов правил): «Характеристика: значення»
	const [values] = await pool.query(
		`SELECT v.id, CONCAT(COALESCE(NULLIF(ad.name, ''), a.code), ': ', COALESCE(NULLIF(vd.name, ''), v.code)) AS name
		   FROM ${P}products_attribute_values v
		   JOIN ${P}products_attributes a ON a.id = v.id_attribute
		   LEFT JOIN ${P}products_attributes_description ad ON ad.id_attribute = a.id AND ad.id_lang = ?
		   LEFT JOIN ${P}products_attribute_values_description vd ON vd.id_attribute_value = v.id AND vd.id_lang = ?
		  ORDER BY name LIMIT 5000`,
		[idLang, idLang]
	);

	// Товари сайту без жодної зіставленої категорії (з урахуванням успадкування) — за збереженим станом
	let unmappedProducts = 0;
	const cm = await categoryMap(idIntegration);
	if (cm.mode !== "system") {
		const goesIds = [...goes];
		await cm.loadPaths(goesIds);
		const mapped = goesIds.filter((c) => cm.nearest(c));
		const w = sqlPublished(idIntegration);
		const [[n]] = await pool.query(
			`SELECT COUNT(*) AS n FROM ${P}products p
			  WHERE p.deleted_at IS NULL AND ${w.sql}
			    ${mapped.length ? `AND NOT EXISTS (SELECT 1 FROM ${P}products_to_categories x WHERE x.id_product = p.id AND x.id_category IN (?))` : ""}`,
			mapped.length ? [...w.params, mapped] : w.params
		);
		unmappedProducts = Number(n.n);
	}

	return {
		...normCatSettings(i),
		tree: normSiteTree(i.category_tree),
		tree_at: i.category_tree_at,
		module_version: i.health_version || null,
		module_ok: !!i.health_version && verCmp(i.health_version, SITE_CATEGORIES_MIN) >= 0,
		module_min: SITE_CATEGORIES_MIN,
		system,
		map,
		rules: normCatRules(i.category_rules),
		values,
		gone: await categoriesGone(idIntegration),
		unmapped_products: unmappedProducts,
	};
}

/** Скільки вибраних категорій сайту (відповідність, правила, товари, за замовчуванням) зникло з дерева сайту */
async function categoriesGone(idIntegration) {
	const [[i]] = await pool.query(`SELECT category_mode, category_tree, category_rules, category_default, category_root FROM ${P}settings_integrations WHERE id = ?`, [idIntegration]);
	if (!i || normCatSettings(i).mode === "system") return 0;
	const tree = normSiteTree(i.category_tree);
	if (!tree.length) return 0;
	const known = new Set(tree.map((x) => x.id));
	const used = new Set([Number(i.category_default) || 0, Number(i.category_root) || 0].filter(Boolean));
	normCatRules(i.category_rules).forEach((x) => x.site.forEach((s) => used.add(s)));
	const [rows] = await pool.query(
		`SELECT entity, overrides FROM ${P}settings_integrations_assortment WHERE id_integration = ? AND overrides IS NOT NULL AND (entity = 'category' OR overrides LIKE '%site_categories%')`,
		[idIntegration]
	);
	for (const r of rows) {
		const o = r.entity === "category" ? normCatOverrides(r.overrides) : normOverrides(r.overrides);
		((o && (o.site || o.site_categories)) || []).forEach((s) => used.add(s));
	}
	return [...used].filter((s) => !known.has(s)).length;
}

/** Дерево сайту для картки товару (вибір категорій сайту саме для товару) */
async function categoriesSite(idIntegration) {
	const [[i]] = await pool.query(`SELECT category_mode, category_tree FROM ${P}settings_integrations WHERE id = ?`, [idIntegration]);
	if (!i) throw httpErr(404, "Integration not found");
	const tree = normSiteTree(i.category_tree);
	const byId = new Map(tree.map((x) => [x.id, x]));
	const path = (x, g = 0) => (x.parent && byId.has(x.parent) && g < 50 ? path(byId.get(x.parent), g + 1) + " › " : "") + x.name;
	return { mode: normCatSettings(i).mode, tree: tree.map((x) => ({ id: x.id, path: path(x) })).sort((a, b) => a.path.localeCompare(b.path)) };
}
/** Оновити дерево сайту з модуля (categories.list) */
async function categoriesPullTree(idIntegration) {
	const client = require("../../catalog/products/sync-client");
	const [[integ]] = await pool.query(`SELECT id, base_url, callback_url, outbound_token, status FROM ${P}settings_integrations WHERE id = ?`, [idIntegration]);
	if (!integ) throw httpErr(404, "Integration not found");
	const items = [];
	for (let after = 0, guard = 0; guard < 200; guard++) {
		const r = await client.call(integ, "categories.list", { after, limit: 1000 });
		(r.items || []).forEach((x) => items.push(x));
		if (!r.more) break;
		after = Number(r.next) || 0;
	}
	const tree = normSiteTree(items);
	await pool.query(`UPDATE ${P}settings_integrations SET category_tree = ?, category_tree_at = NOW() WHERE id = ?`, [JSON.stringify(tree), idIntegration]);
	return tree;
}

/** Зберегти налаштування категорій і всю відповідність ({ id_категорії: [id сайту] }) */
async function categoriesSave(idIntegration, b, idUser) {
	const [[i]] = await pool.query(`SELECT id, health_version FROM ${P}settings_integrations WHERE id = ?`, [idIntegration]);
	if (!i) throw httpErr(404, "Integration not found");
	const cfg = normCatSettings({ category_mode: b.mode, category_unmapped: b.unmapped, category_default: b.default, category_root: b.root });
	// Старий модуль не знає категорій сайту — поклав би товари лише в категорії системи
	if (cfg.mode !== "system" && !(i.health_version && verCmp(i.health_version, SITE_CATEGORIES_MIN) >= 0)) {
		throw Object.assign(httpErr(409, "module"), { code: "module_old" });
	}
	const want = new Map();
	for (const [k, v] of Object.entries(b.map && typeof b.map === "object" ? b.map : {})) {
		const id = Number(k);
		const o = normCatOverrides(v);
		if (Number.isInteger(id) && id > 0 && o) want.set(id, o);
	}
	// Перенесення під іншу категорію: не під саму себе й не під власну підкатегорію
	const moved = [...want].filter(([, o]) => o.parent);
	if (moved.length) {
		const [desc] = await pool.query(`SELECT id_category, id_ancestor FROM ${P}products_categories_path WHERE id_category IN (?)`, [moved.map(([, o]) => o.parent)]);
		const bad = new Set(desc.filter((d) => want.has(Number(d.id_ancestor)) && want.get(Number(d.id_ancestor)).parent === Number(d.id_category)).map((d) => Number(d.id_ancestor)));
		for (const id of bad) delete want.get(id).parent;
	}
	await pool.query(
		`UPDATE ${P}settings_integrations SET category_mode = ?, category_unmapped = ?, category_default = ?, category_root = ?, category_rules = ?, sync_full_at = NOW() WHERE id = ?`,
		[cfg.mode, cfg.unmapped, cfg.default, cfg.root, JSON.stringify(normCatRules(b.rules)), idIntegration]
	);
	// Повна заміна відповідності: зайве — прибрати, нове — записати
	await pool.query(
		`UPDATE ${P}settings_integrations_assortment SET overrides = NULL, date_edit = NOW()
		  WHERE id_integration = ? AND entity = 'category' AND overrides IS NOT NULL${want.size ? " AND id_entity NOT IN (?)" : ""}`,
		want.size ? [idIntegration, [...want.keys()]] : [idIntegration]
	);
	await pool.query(
		`DELETE FROM ${P}settings_integrations_assortment WHERE id_integration = ? AND entity = 'category' AND mode IS NULL AND overrides IS NULL AND err_message IS NULL AND sent_hash IS NULL`,
		[idIntegration]
	);
	if (want.size) {
		const [found] = await pool.query(`SELECT id FROM ${P}products_categories WHERE id IN (?)`, [[...want.keys()]]);
		const rows = found.map((r) => [idIntegration, "category", r.id, null, JSON.stringify(want.get(Number(r.id))), idUser || null, new Date()]);
		for (let k = 0; k < rows.length; k += 1000) {
			await pool.query(
				`INSERT INTO ${P}settings_integrations_assortment (id_integration, entity, id_entity, mode, overrides, id_user, date_edit) VALUES ?
				 ON DUPLICATE KEY UPDATE overrides = VALUES(overrides), id_user = VALUES(id_user), date_edit = NOW()`,
				[rows.slice(k, k + 1000)]
			);
		}
	}
	return { ...cfg, mapped: want.size };
}

/* ─── Черга помилок: товари, які сайт не прийняв ───────────────────────────── */

const MAX_ATTEMPTS = 8;

/** Результат пакета обміну: прийняті — з черги прибрати, відхилені — записати з наростаючою паузою */
async function recordResults(idIntegration, items, results) {
	// Модуль OpenCart повертає номер запису в полі ref, інші — у crm_id
	const byId = new Map((results || []).filter((r) => r && (r.crm_id !== undefined || r.ref !== undefined)).map((r) => [Number(r.crm_id !== undefined ? r.crm_id : r.ref), r]));
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

/** Товари сайту в черзі помилок, що ще мають спроби (для часткового повтору) */
async function retryItems(idIntegration) {
	const [rows] = await pool.query(
		`SELECT id_entity FROM ${P}settings_integrations_assortment
		  WHERE id_integration = ? AND entity = 'product' AND err_message IS NOT NULL AND err_attempts < ? LIMIT 5000`,
		[idIntegration, MAX_ATTEMPTS]
	);
	return rows.map((r) => Number(r.id_entity));
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

module.exports = { categoriesGone, categoriesSite, normOverrides, categoryMap, categoriesGet, categoriesPullTree, categoriesSave, SITE_CATEGORIES_MIN, retryItems, normContent, applyContent, fillTemplate, normStock, applyStock, recordResults, errorsList, retryNow, dueRetries, MAX_ATTEMPTS, resolver, forEntity, set, catalogIntegrations, sqlPublished, counts, normRule, channel, applyToItem, roundPrice, setOverrides };
