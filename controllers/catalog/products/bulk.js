"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const trash = require("../../common/trash");
const editLock = require("./edit-lock");
const history = require("./history");
const pricing = require("./pricing");
const { FIELD_DEFS, VARIANT_FIELD_DEFS, TEXT_FIELDS, safeRegex } = require("../../../validator/catalog/products/bulk");
const htmlV = require("../../../validator/catalog/products/html");

/* ─── Ціни у валютах ─── */
// Поле ціни → [поле валюти групи, поле суми у валюті, як рахувати базову]
const CUR_OF = {
	price: ["price_currency", "price_cur", "price"],
	compare_at_price: ["price_currency", "compare_cur", "price"],
	cost_price: ["cost_currency", "cost_cur", "plain"],
	wholesale_price: ["wholesale_currency", "wholesale_cur", "price"],
};
const GROUPS = {
	price: ["price_currency", [["price", "price_cur", "price"], ["compare_at_price", "compare_cur", "price"]]],
	cost: ["cost_currency", [["cost_price", "cost_cur", "plain"]]],
	wholesale: ["wholesale_currency", [["wholesale_price", "wholesale_cur", "price"]]],
};
const r4 = (n) => Math.round(Number(n) * 10000) / 10000;

/**
 * Зміна валюти суми. baseVal — у базовій, curVal — у старій валюті (oldCode), kind — price / plain / delta.
 * convert — нова сума = базова / курс нової валюти (до копійок); keep — те саме число вважається сумою в новій валюті.
 */
function switchAmount(cx, baseVal, curVal, oldCode, newCode, kind, mode) {
	if (baseVal === null || baseVal === undefined) return { base: null, cur: null };
	const shown = oldCode && curVal !== null && curVal !== undefined ? Number(curVal) : Number(baseVal);
	const amount = mode === "keep" ? shown : newCode ? Math.round((Number(baseVal) / cx.rate(newCode)) * 100) / 100 : Number(baseVal);
	if (!newCode) return { base: r4(amount), cur: null };
	return { base: cx[kind](amount, newCode), cur: amount };
}

const P = config.get("configDatabase").prefix;

/* ─── Арифметика цін у цілих (1/10000), без похибок float ─── */
const SCALE = 10000;
const toInt = (v) => Math.round(Number(v) * SCALE);
const fromInt = (n) => (n / SCALE).toFixed(4);

function roundPrice(n, mode) {
	// n — ціле в 1/10000
	switch (mode) {
		case "0":
			return Math.round(n / SCALE) * SCALE;
		case "1":
			return Math.round(n / 1000) * 1000;
		case "2":
			return Math.round(n / 100) * 100;
		case "99": {
			// x.99: 123.40 → 123.99; 0.40 → 0.99
			return Math.floor(n / SCALE) * SCALE + 9900;
		}
		case "9": {
			// закінчення на 9 гривень/одиниць: 123.40 → 129; 7 → 9
			const units = Math.round(n / SCALE);
			return (Math.floor(units / 10) * 10 + 9) * SCALE;
		}
		default:
			return n;
	}
}

/**
 * Нова ціна. current — DECIMAL рядок/число або null.
 * isImpact — значення є надбавкою варіанта (може бути від'ємним).
 */
function computePrice(current, p, isImpact) {
	if (p.op === "set") return roundPrice(toInt(p.value), p.round);
	if (current === null || current === undefined) return null; // нема від чого рахувати
	const base = toInt(current);
	let next = p.op === "percent" ? Math.round((base * (100 + p.value)) / 100) : base + toInt(p.value);
	if (!isImpact) {
		next = roundPrice(next, p.round);
		if (next < 0) next = 0;
	}
	return next;
}

function httpErr(status, message, extra) {
	return Object.assign(new Error(message), { status }, extra || {});
}

/* ─── Дії масового редагування: поле товару, тексти, SEO за шаблоном, характеристика, коди ─── */

const ymd = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : d ? String(d).slice(0, 10) : null);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Нове значення поля товару за операцією. undefined — змінювати нічого (нема від чого рахувати).
 * Результат поза межами поля — помилка цього товару (у звіт), а не тихе обрізання.
 */
function fieldNext(cur, p, def) {
	const bad = (code) => httpErr(400, code);
	let next;
	switch (p.op) {
		case "clear":
			return null;
		case "set":
			next = def.t === "bool" ? (p.value ? 1 : 0) : p.value;
			break;
		case "percent":
		case "amount": {
			if (cur === null || cur === undefined || cur === "") return undefined;
			const n = p.op === "percent" ? Number(cur) * (1 + p.value / 100) : Number(cur) + p.value;
			next = def.t === "int" ? Math.round(n) : r4(n);
			break;
		}
		case "prepend":
			next = p.value + (cur || "");
			break;
		case "append":
			next = (cur || "") + p.value;
			break;
		case "replace":
			if (cur === null || cur === undefined) return undefined;
			next = String(cur).split(p.find).join(p.value);
			break;
		default:
			return undefined;
	}
	if (def.t === "num" || def.t === "int") {
		if (next < def.min || next > def.max || (def.gt0 && next <= 0)) throw bad("out_of_range");
	} else if (def.t === "str") {
		next = String(next).trim();
		if (next === "") {
			if (!def.nullable) throw bad("required");
			return null;
		}
		if (next.length > def.max) throw bad("too_long");
		if (def.pattern && !new RegExp(def.pattern).test(next)) throw bad("invalid_format");
	}
	return next;
}

/** Чи однакові значення поля (числа — як числа, дати — як рік-місяць-день) */
function sameField(cur, next, def) {
	if (cur === null || cur === undefined) return next === null || next === undefined;
	if (next === null) return false;
	if (def.t === "num" || def.t === "int" || def.t === "bool") return Number(cur) === Number(next);
	if (def.t === "date") return ymd(cur) === next;
	return String(cur) === String(next);
}

/** Новий текст перекладу за операцією (set, clear, prepend, append, replace, regex) */
function textNext(cur, p) {
	switch (p.op) {
		case "set":
			return p.value;
		case "clear":
			return null;
		case "prepend":
			return p.value + (cur || "");
		case "append":
			return (cur || "") + p.value;
		case "replace":
			if (cur === null || cur === undefined) return cur;
			return p.case_sensitive ? cur.split(p.find).join(p.value) : cur.replace(new RegExp(escRe(p.find), "gi"), () => p.value);
		case "regex":
			// $1, $2… у заміні — групи з виразу
			if (cur === null || cur === undefined) return cur;
			return cur.replace(safeRegex(p.find, p.case_sensitive ? "g" : "gi"), p.value);
		default:
			return cur;
	}
}

/** Обрізати текст до довжини поля по межі слова (для SEO-шаблонів) */
function cut(text, max) {
	if (text.length <= max) return text;
	const part = text.slice(0, max);
	const sp = part.lastIndexOf(" ");
	return (sp > max * 0.6 ? part.slice(0, sp) : part).replace(/[\s,;:|–—-]+$/, "");
}

/** Назва бренду / головної категорії мовою (з запасною основною мовою) — для SEO-шаблонів */
async function nameIn(conn, table, key, id, idLang, primary) {
	if (!id) return "";
	const [[r]] = await conn.query(
		`SELECT COALESCE(NULLIF(a.name, ''), b.name) AS name FROM ${P}${table} b LEFT JOIN ${P}${table} a ON a.${key} = b.${key} AND a.id_lang = ?
		  WHERE b.${key} = ? AND b.id_lang = ?`,
		[idLang, id, primary]
	);
	return (r && r.name) || "";
}

/**
 * Переклади товару: змінити поле в усіх вибраних мовах (лише наявні переклади — новий переклад з одного поля не створюється).
 * Повертає зміни { field, lang, old, new } — значення повністю (не скорочено), щоб масову зміну можна було відмінити й для довгих описів.
 */
async function applyTexts(conn, product, field, langIds, compute) {
	const out = [];
	if (!langIds.length) return out;
	const [rows] = await conn.query(`SELECT * FROM ${P}products_description WHERE id_product = ? AND id_lang IN (?) FOR UPDATE`, [product.id, langIds]);
	const isHtml = htmlV.isHtmlField("products", field);
	for (const row of rows) {
		const cur = row[field] === undefined ? null : row[field];
		let next = await compute(cur, row);
		if (next === undefined) continue;
		if (next !== null) {
			next = String(next);
			if (isHtml) next = htmlV.clean(next) || "";
			if (!isHtml) next = next.trim();
			if (next === "") next = null;
		}
		if (next === null && field === "name") throw httpErr(400, "required");
		if (next !== null && next.length > TEXT_FIELDS[field]) throw httpErr(400, "too_long");
		if ((cur || null) === next) continue;
		await conn.query(`UPDATE ${P}products_description SET \`${field}\` = ? WHERE id_product = ? AND id_lang = ?`, [next, product.id, row.id_lang]);
		if (isHtml) await require("./descriptions").syncImageRefs(conn, "products", product.id, row.id_lang, { ...row, [field]: next });
		out.push({ field, lang: Number(row.id_lang), old: cur, new: next });
	}
	return out;
}

/** Мови дії: вибрані або всі мови контенту */
const langsOf = (p, ctx) => (p.langs && p.langs.length ? p.langs : ctx.langs.map((l) => Number(l.id)));

/** Значення характеристики з параметрів дії (у вигляді знімка attributes.productAttr) */
function attrSnapFromParams(def, p, ctx) {
	const snap = { value_ids: [], number: null, date: null, text: {} };
	if (["select", "multiselect", "color"].includes(def.type)) snap.value_ids = [...p.value_ids].sort((a, b) => a - b);
	else if (["integer", "decimal"].includes(def.type)) snap.number = Number(p.number);
	else if (def.type === "boolean") snap.number = p.number ? 1 : 0;
	else if (def.type === "date") snap.date = p.date;
	else {
		const langs = Number(def.is_translatable) ? ctx.langs.map((l) => Number(l.id)) : [0];
		for (const l of langs) snap.text[l] = String(p.text).trim();
	}
	return snap;
}

/* ─── Дії над одним товаром у відкритій транзакції ─── */
async function applyOne(conn, product, action, params, ctx) {
	const set = {};
	const extra = [];

	switch (action) {
		case "status":
			if (product.status === params.status) return false;
			set.status = params.status;
			if (params.status === "active") set.published_at = product.published_at || new Date();
			break;

		case "visibility":
			if (product.visibility === params.visibility) return false;
			set.visibility = params.visibility;
			break;

		case "featured":
			if (Number(product.is_featured) === params.value) return false;
			set.is_featured = params.value;
			break;

		case "brand":
			if ((product.id_brand || null) === params.id_brand) return false;
			set.id_brand = params.id_brand;
			break;

		case "categories": {
			const [rows] = await conn.query(`SELECT id_category FROM ${P}products_to_categories WHERE id_product = ?`, [product.id]);
			const current = rows.map((r) => r.id_category);
			let next;
			if (params.op === "add") next = [...new Set([...current, ...params.ids])];
			else if (params.op === "remove") next = current.filter((c) => !params.ids.includes(c));
			else next = [...params.ids];

			const toDelete = current.filter((c) => !next.includes(c));
			const toInsert = next.filter((c) => !current.includes(c));
			if (toDelete.length) await conn.query(`DELETE FROM ${P}products_to_categories WHERE id_product = ? AND id_category IN (?)`, [product.id, toDelete]);
			if (toInsert.length) await conn.query(`INSERT INTO ${P}products_to_categories (id_product, id_category) VALUES ?`, [toInsert.map((c) => [product.id, c])]);

			let main = product.id_category_main;
			if (params.set_main && params.op !== "remove") main = params.ids[0];
			else if (main && !next.includes(main)) main = next[0] || null;
			else if (!main && next.length) main = next[0];
			if (main !== product.id_category_main) set.id_category_main = main;

			if (toDelete.length || toInsert.length) extra.push({ field: "categories", old: [...current].sort((a, b) => a - b), new: [...next].sort((a, b) => a - b) });
			if (!toDelete.length && !toInsert.length && !("id_category_main" in set)) return false;
			break;
		}

		case "price": {
			// Ціна у валюті: операція — над сумою у валюті (*_cur), базова — перерахунком за курсом
			const [gc, cur, kind] = CUR_OF[params.field];
			const code = product[gc] || null;
			if (code) {
				const next = computePrice(product[cur], params, false);
				if (next !== null && next !== toInt(product[cur] ?? 0)) {
					set[cur] = fromInt(next);
					set[params.field] = ctx.cx[kind](Number(fromInt(next)), code);
				}
			} else {
				const next = computePrice(product[params.field], params, false);
				if (next !== null && next !== toInt(product[params.field] ?? 0)) set[params.field] = fromInt(next);
			}
			let variantsChanged = 0;
			if (params.variants && product.type === "variable") {
				const vc = await applyVariantsPrice(conn, product, params, ctx.cx);
				variantsChanged = vc.length;
				extra.push(...vc);
			}
			if (!Object.keys(set).length && !variantsChanged) return false;
			break;
		}

		case "compare_from_price": {
			if (toInt(product.price) > 0 && toInt(product.compare_at_price ?? -1) !== toInt(product.price)) set.compare_at_price = product.price;
			let variantsChanged = 0;
			if (params.variants && product.type === "variable") {
				const [r] = await conn.query(
					`UPDATE ${P}products_variants SET compare_at_price = price
					  WHERE id_product = ? AND price_mode = 'fixed' AND price > 0 AND (compare_at_price IS NULL OR compare_at_price <> price)`,
					[product.id]
				);
				variantsChanged = r.affectedRows;
				if (r.affectedRows) extra.push({ field: "variants.compare_at_price", old: null, new: `= price (${r.affectedRows})` });
			}
			if (!Object.keys(set).length && !variantsChanged) return false;
			break;
		}

		case "formula": {
			// Ціна за формулою: увімкнути (і одразу порахувати, якщо є собівартість і націнка) / вимкнути
			if (!params.on) {
				if (!Number(product.price_auto)) return false;
				set.price_auto = 0;
				break;
			}
			if (!Number(product.price_auto)) set.price_auto = 1;
			const info = await pricing.formulaInfo(conn, [product]);
			// Варіанти з власною собівартістю — за тією ж формулою (після ввімкнення формули в товару)
			if (params.variants !== false) {
				if (set.price_auto) await conn.query(`UPDATE ${P}products SET price_auto = 1 WHERE id = ?`, [product.id]);
				await pricing.formulaVariants(conn, [product.id], { f: ctx.formula, info, record: false, collect: extra });
			}
			const fp = pricing.formulaPrice(product.cost_price, ctx.formula, info.get(Number(product.id)));
			if (fp) {
				if (Math.abs(fp.price - Number(product.price)) > 0.00005) set.price = fp.price;
				if (fp.compare !== undefined) set.compare_at_price = fp.compare;
				else if (product.compare_at_price !== null && Number(product.compare_at_price) <= fp.price) set.compare_at_price = null;
				if (product.price_currency) Object.assign(set, { price_currency: null, price_cur: null, compare_cur: null });
			}
			if (!Object.keys(set).length && !extra.length) return false;
			break;
		}

		case "fixed_price": {
			// Фіксовані ціни сайтів у валюті (price_fixed): convert — зафіксувати поточну ціну за курсом, percent — змінити на %, clear — прибрати
			let fx = {};
			try {
				fx = product.price_fixed ? JSON.parse(product.price_fixed) || {} : {};
			} catch (e) {
				fx = {};
			}
			const before = JSON.stringify(fx);
			const c = ctx.cx.byCode.get(params.code);
			const dec = c && Number.isInteger(c.decimals) ? c.decimals : 2;
			const round = (v) => Math.round(v * 10 ** dec) / 10 ** dec;
			if (params.op === "clear") delete fx[params.code];
			else if (params.op === "convert") {
				const rate = ctx.cx.rate(params.code);
				if (!(rate > 0) || !(Number(product.price) > 0)) return false;
				fx[params.code] = round(Number(product.price) / rate);
			} else if (params.op === "percent") {
				if (!(Number(fx[params.code]) > 0)) return false;
				fx[params.code] = round(Number(fx[params.code]) * (1 + params.value / 100));
				if (!(fx[params.code] > 0)) delete fx[params.code];
			}
			const after = Object.keys(fx).length ? JSON.stringify(fx) : null;
			if ((after || "{}") === before || (after === null && !product.price_fixed)) return false;
			set.price_fixed = after;
			break;
		}

		case "currency": {
			const [gc, fields] = GROUPS[params.group];
			const oldCode = product[gc] || null;
			const newCode = params.code && params.code !== ctx.cx.base ? params.code : null;
			if (oldCode !== newCode) {
				set[gc] = newCode;
				for (const [f, cur, kind] of fields) {
					const r = switchAmount(ctx.cx, product[f], product[cur], oldCode, newCode, kind, params.mode);
					if (r.base === null && f === "price") continue;
					set[f] = r.base;
					set[cur] = r.cur;
				}
			}
			let deps = 0;
			// Варіанти й надбавки опцій, що беруть валюту з товару, — разом із товаром
			if (oldCode !== newCode && params.group !== "wholesale" && params.variants) {
				const [vs] = await conn.query(
					`SELECT id, price_mode, price, compare_at_price, price_cur, compare_cur, cost_price, cost_cur FROM ${P}products_variants
					  WHERE id_product = ? AND ${params.group === "price" ? "price_currency" : "cost_currency"} IS NULL FOR UPDATE`,
					[product.id]
				);
				for (const v of vs) {
					const vset = {};
					const list = params.group === "price" ? [["price", "price_cur", v.price_mode === "fixed" ? "price" : "delta"], ["compare_at_price", "compare_cur", "price"]] : [["cost_price", "cost_cur", "plain"]];
					for (const [f, cur, kind] of list) {
						const r = switchAmount(ctx.cx, v[f], v[cur], oldCode, newCode, kind, params.mode);
						if (r.base === null && f === "price") continue;
						vset[f] = r.base;
						vset[cur] = r.cur;
					}
					const keys = Object.keys(vset);
					if (keys.length) await conn.query(`UPDATE ${P}products_variants SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => vset[k]), v.id]);
					deps++;
				}
			}
			if (oldCode !== newCode && params.group === "price" && params.options) {
				const [ovs] = await conn.query(
					`SELECT ov.id, ov.price, ov.price_cur FROM ${P}products_to_option_values ov JOIN ${P}products_to_options po ON po.id = ov.id_product_option
					  WHERE po.id_product = ? AND ov.price_mode = 'fixed' AND ov.price_currency IS NULL`,
					[product.id]
				);
				for (const v of ovs) {
					const r = switchAmount(ctx.cx, v.price, v.price_cur, oldCode, newCode, "delta", params.mode);
					await conn.query(`UPDATE ${P}products_to_option_values SET price = ?, price_cur = ? WHERE id = ?`, [r.base ?? 0, r.cur, v.id]);
					deps++;
				}
			}
			if (deps) extra.push({ field: `${params.group}_currency.dependents`, old: null, new: String(deps) });
			if (!Object.keys(set).length && !deps) return false;
			break;
		}

		case "field": {
			const def = FIELD_DEFS[params.field];
			const next = fieldNext(product[params.field], params, def);
			if (next === undefined || sameField(product[params.field], next, def)) return false;
			set[params.field] = next;
			break;
		}

		case "variant_field": {
			// Кожен варіант варіативного товару; простий товар — без змін
			if (product.type !== "variable") return false;
			const def = VARIANT_FIELD_DEFS[params.field];
			const f = params.field;
			const [variants] = await conn.query(`SELECT id, \`${f}\` AS value FROM ${P}products_variants WHERE id_product = ? ORDER BY id FOR UPDATE`, [product.id]);
			const ch = [];
			for (const v of variants) {
				if (params.only_empty && v.value !== null && v.value !== undefined && String(v.value).trim() !== "") continue;
				const next = fieldNext(v.value, params, def);
				if (next === undefined || sameField(v.value, next, def)) continue;
				await conn.query(`UPDATE ${P}products_variants SET \`${f}\` = ? WHERE id = ?`, [next, v.id]);
				ch.push({ field: `variant.${v.id}.${f}`, old: v.value === null ? null : v.value instanceof Date ? ymd(v.value) : String(v.value), new: next === null ? null : String(next) });
			}
			if (!ch.length) return false;
			extra.push(...ch);
			break;
		}

		case "text": {
			const ch = await applyTexts(conn, product, params.field, langsOf(params, ctx), (cur) => textNext(cur, params));
			if (!ch.length) return false;
			extra.push(...ch);
			break;
		}

		case "seo": {
			// Шаблон: {name} {brand} {category} {sku} {model} {price} {currency} {id} — кожною мовою своєю мовою
			const primary = Number(ctx.langs[0].id);
			const ch = await applyTexts(conn, product, params.field, langsOf(params, ctx), async (cur, row) => {
				if (params.only_empty && cur !== null && String(cur).trim() !== "") return undefined;
				const lang = Number(row.id_lang);
				const vals = {
					name: row.name || "",
					brand: await nameIn(conn, "products_brands_description", "id_brand", product.id_brand, lang, primary),
					category: await nameIn(conn, "products_categories_description", "id_category", product.id_category_main, lang, primary),
					sku: product.sku || "",
					model: product.model || "",
					price: product.price !== null && product.price !== undefined ? String(Number(product.price)) : "",
					currency: ctx.cx ? ctx.cx.base : "",
					id: String(product.id),
				};
				const text = params.template
					.replace(/\{(name|brand|category|sku|model|price|currency|id)\}/g, (_, k) => vals[k])
					.replace(/\s+/g, " ")
					// Порожні підстановки не лишають «висячих» розділювачів: «Назва |  | бренд» → «Назва | бренд»
					.replace(/([|,;:–—-])(\s*[|,;:–—-])+/g, "$1")
					.replace(/^[\s|,;:–—-]+|[\s|,;:–—-]+$/g, "");
				return text ? cut(text, TEXT_FIELDS[params.field]) : undefined;
			});
			if (!ch.length) return false;
			extra.push(...ch);
			break;
		}

		case "media": {
			// Фото: головне, видалення, ALT — знімок медіа до й після (відміна повертає і видалені фото)
			const ch = await require("./bulk-media").apply(conn, product, params, { langs: langsOf(params, ctx), primary: Number(ctx.langs[0].id), nameIn });
			if (!ch) return false;
			extra.push(ch);
			break;
		}

		case "attribute": {
			const attrs = require("./attributes");
			const def = ctx.attrs.get(params.id_attribute);
			const cur = await attrs.productAttr(conn, product.id, params.id_attribute);
			if (params.op === "set" && params.only_empty && !attrs.attrEmpty(cur)) return false;
			const next = params.op === "remove" ? { value_ids: [], number: null, date: null, text: {} } : attrSnapFromParams(def, params, ctx);
			if (JSON.stringify(cur) === JSON.stringify(next)) return false;
			await attrs.setProductAttr(conn, product.id, params.id_attribute, next);
			extra.push({ field: `attribute.${params.id_attribute}`, attr: true, old: cur, new: next });
			break;
		}

		case "codes": {
			if (params.code === "ean") {
				if (product.ean) return false;
				set.ean = await require("./ean").generate(conn);
				break;
			}
			// Артикул: за шаблоном дії або правилом із налаштувань каталогу; зайнятий — помилка товару, а не дубль
			if (params.only_empty && product.sku) return false;
			const sku = require("./sku");
			const pattern = params.template || ctx.skuCfg.pattern;
			const [[b]] = product.id_brand ? await conn.query(`SELECT code FROM ${P}products_brands WHERE id = ?`, [product.id_brand]) : [[null]];
			const tokens = { id: product.id, brandCode: b && b.code ? sku.clean(b.code) : "", categoryId: product.id_category_main };
			let value = null;
			for (let attempt = 0; attempt < (/\{(SEQ|RAND)/.test(pattern) ? 5 : 1); attempt++) {
				const v = await sku.render(pattern, ctx.skuCfg, tokens, conn);
				if (v && v === product.sku) return false;
				if (v && (await sku.isFree(v, { excludeProductId: product.id }, conn))) {
					value = v;
					break;
				}
			}
			if (!value) throw httpErr(409, "duplicate");
			set.sku = value;
			break;
		}

		default:
			throw httpErr(400, "Unknown action");
	}

	const keys = Object.keys(set);
	await conn.query(
		`UPDATE ${P}products SET ${keys.map((k) => `\`${k}\` = ?`).join(", ")}${keys.length ? ", " : ""}version = version + 1, id_user_edit = ? WHERE id = ?`,
		[...keys.map((k) => set[k]), ctx.idUser, product.id]
	);
	const norm = (v) => (v === undefined || v === null ? null : v instanceof Date ? v.toISOString() : String(v));
	return [...keys.map((k) => ({ field: k, old: norm(product[k]), new: norm(set[k]) })), ...extra];
}

/** fixed — та сама операція; impact — лише масштабування у %; ціни <0 у fixed не допускаються. Ціни у валюті — над сумами у валюті */
async function applyVariantsPrice(conn, product, params, cx) {
	const idProduct = product.id;
	const curCol = { price: "price_cur", compare_at_price: "compare_cur", cost_price: "cost_cur" }[params.field];
	const codeCol = params.field === "cost_price" ? "cost_currency" : "price_currency";
	const [variants] = await conn.query(
		`SELECT id, price_mode, ${params.field} AS value${curCol ? `, ${curCol} AS cur, ${codeCol} AS code` : ""} FROM ${P}products_variants WHERE id_product = ? FOR UPDATE`,
		[idProduct]
	);
	const changes = [];
	for (const v of variants) {
		const isImpact = v.price_mode === "impact" && params.field === "price";
		if (isImpact && params.op !== "percent") continue;
		const code = curCol ? v.code || product[codeCol] || null : null;
		if (code && v.cur !== null) {
			const next = computePrice(v.cur, params, isImpact);
			if (next === null || next === toInt(v.cur ?? 0)) continue;
			const amount = Number(fromInt(next));
			const base = params.field === "cost_price" ? cx.plain(amount, code) : isImpact ? cx.delta(amount, code) : cx.price(amount, code);
			await conn.query(`UPDATE ${P}products_variants SET ${params.field} = ?, ${curCol} = ? WHERE id = ?`, [base, amount, v.id]);
			changes.push({ field: `variant.${v.id}.${params.field}`, old: v.value === null ? null : String(v.value), new: String(base) });
			continue;
		}
		const next = computePrice(v.value, params, isImpact);
		if (next === null || next === toInt(v.value ?? 0)) continue;
		await conn.query(`UPDATE ${P}products_variants SET ${params.field} = ? WHERE id = ?`, [fromInt(next), v.id]);
		changes.push({ field: `variant.${v.id}.${params.field}`, old: v.value === null ? null : String(v.value), new: fromInt(next) });
	}
	return changes;
}

/**
 * Перевірити дію перед виконанням (права, довідники, валюти) і доповнити ctx тим, що їй потрібно (курси, формула).
 * Один раз на всю операцію — і для списку товарів, і для масового редагування через чергу.
 * ctx: { idUser, perms: { edit, delete, costEdit } }
 */
async function prepare(action, params, ctx) {
	if (action === "delete" ? !ctx.perms.delete : !ctx.perms.edit) throw httpErr(403, "Forbidden");
	if (action === "price" && ["cost_price", "wholesale_price"].includes(params.field) && !ctx.perms.costEdit) throw httpErr(403, "Forbidden");
	if (action === "currency" && params.group !== "price" && !ctx.perms.costEdit) throw httpErr(403, "Forbidden");
	// Формула рахує ціну від собівартості — лише з правом на собівартість
	if (action === "formula" && !ctx.perms.costEdit) throw httpErr(403, "Forbidden");
	if (!ctx.cx) ctx.cx = await pricing.currencyCtx();
	if (action === "formula" && !ctx.formula) ctx.formula = await require("./settings").get("price_formula");
	if (action === "fixed_price" && (!params.code || params.code === ctx.cx.base || !ctx.cx.byCode.has(params.code))) throw httpErr(400, "Unknown currency", { errors: [{ field: "params.code", message: "unknown currency" }] });
	if (action === "currency" && params.code && !ctx.cx.has(params.code)) throw httpErr(400, "Unknown currency", { errors: [{ field: "params.code", message: "unknown currency" }] });

	// Тексти й SEO — мови контенту; вибрані мови мають існувати
	if (["text", "seo", "attribute", "media"].includes(action) && !ctx.langs) ctx.langs = await require("./descriptions").contentLanguages();
	if (["text", "seo", "media"].includes(action) && (params.langs || []).some((l) => !ctx.langs.some((x) => Number(x.id) === l))) {
		throw httpErr(400, "Unknown language", { errors: [{ field: "params.langs", message: "unknown language" }] });
	}
	if (action === "codes" && params.code === "sku" && !ctx.skuCfg) ctx.skuCfg = await require("./settings").get("sku");
	// Характеристика: існує, значення належать їй і підходять до її типу
	if (action === "attribute") {
		const [[def]] = await pool.query(`SELECT id, type, is_translatable FROM ${P}products_attributes WHERE id = ?`, [params.id_attribute]);
		const bad = (field, message) => httpErr(400, "Validation failed", { errors: [{ field: `params.${field}`, message }] });
		if (!def) throw bad("id_attribute", "not found");
		if (params.op === "set") {
			if (["select", "multiselect", "color"].includes(def.type)) {
				const ids = params.value_ids || [];
				if (!ids.length || (def.type !== "multiselect" && ids.length > 1)) throw bad("value_ids", def.type === "multiselect" ? "required" : "exactly one value");
				const [own] = await pool.query(`SELECT id FROM ${P}products_attribute_values WHERE id IN (?) AND id_attribute = ?`, [ids, def.id]);
				if (own.length !== ids.length) throw bad("value_ids", "value does not belong to attribute");
			} else if (["integer", "decimal", "boolean"].includes(def.type)) {
				if (typeof params.number !== "number" || (def.type === "integer" && !Number.isInteger(params.number))) throw bad("number", "required");
			} else if (def.type === "date") {
				if (!params.date) throw bad("date", "required");
			} else if (!String(params.text || "").trim()) throw bad("text", "required");
		}
		if (!ctx.attrs) ctx.attrs = new Map();
		ctx.attrs.set(def.id, def);
	}

	// Довідкові перевірки
	if (action === "brand" && params.id_brand) {
		const [[b]] = await pool.query(`SELECT id FROM ${P}products_brands WHERE id = ? AND deleted_at IS NULL`, [params.id_brand]);
		if (!b) throw httpErr(400, "Brand not found", { errors: [{ field: "params.id_brand", message: "not found" }] });
	}
	if (action === "categories") {
		const [cats] = await pool.query(`SELECT id FROM ${P}products_categories WHERE id IN (?)`, [params.ids]);
		if (cats.length !== params.ids.length) throw httpErr(400, "Category not found", { errors: [{ field: "params.ids", message: "not found" }] });
	}
}

/**
 * Кілька дій над одним товаром у відкритій транзакції, по черзі. Між діями товар перечитується —
 * наступна дія бачить результат попередньої (як у перегляді, так і при застосуванні).
 * Повертає зміни [{ field, old, new }] (по полю — перше «було» й останнє «стало») або [] — нічого не змінилось.
 */
async function runOps(conn, product, ops, ctx) {
	const merged = new Map();
	let row = product;
	for (const op of ops) {
		const changed = await applyOne(conn, row, op.action, op.params || {}, ctx);
		if (!changed || !changed.length) continue;
		for (const c of changed) {
			const k = c.field + (c.lang ? ":" + c.lang : "");
			const prev = merged.get(k);
			merged.set(k, prev ? { ...prev, new: c.new } : c);
		}
		const [[fresh]] = await conn.query(`SELECT * FROM ${P}products WHERE id = ?`, [product.id]);
		row = fresh;
	}
	// Поле повернулось до початкового значення через кілька дій — це не зміна
	return [...merged.values()].filter((c) => JSON.stringify(c.old) !== JSON.stringify(c.new) || c.field.includes("."));
}

/**
 * Масова дія зі списку товарів (позначені товари, одразу). ctx: { idUser, perms: { edit, delete, costEdit } }
 * Повертає { summary, report, changedIds }.
 */
async function apply(input, ctx) {
	const { ids, action, params = {} } = input;
	await prepare(action, params, ctx);

	const summary = { total: ids.length, changed: 0, unchanged: 0, skipped: 0, error: 0 };
	const report = [];
	const changedIds = [];
	// Пакет історії — при першій реальній зміні (операцію цілком можна відкотити в «Історії змін»)
	let batch = null;
	const batchId = () => batch || (batch = history.newBatch({ source: "bulk", user: ctx.idUser, title: action, meta: { action, params } }));

	// Сортування за id — однаковий порядок блокувань між паралельними операціями (без deadlock)
	for (const id of [...ids].sort((a, b) => a - b)) {
		if (action === "delete") {
			const h = await editLock.holder(id);
			if (h && h.id_user !== ctx.idUser) {
				summary.skipped++;
				report.push({ id, status: "skipped", message: "locked", user_name: h.user_name });
				continue;
			}
			try {
				await trash.softDelete("products", id, ctx.idUser);
				summary.changed++;
				changedIds.push(id);
				await history.record("products", id, { user: ctx.idUser, source: "bulk", action: "delete", batch: await batchId() });
			} catch (e) {
				summary.error++;
				report.push({ id, status: "error", message: e.status ? e.message : "server error" });
				if (!e.status) ctx.logError(e);
			}
			continue;
		}

		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();
			const [[product]] = await conn.query(`SELECT * FROM ${P}products WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [id]);
			if (!product) {
				await conn.rollback();
				summary.error++;
				report.push({ id, status: "error", message: "not found" });
				continue;
			}
			const h = await editLock.holder(id, conn);
			if (h) {
				await conn.rollback();
				summary.skipped++;
				report.push({ id, sku: product.sku, status: "skipped", message: "locked", user_name: h.user_name });
				continue;
			}
			const changed = await applyOne(conn, product, action, params, ctx);
			await conn.commit();
			if (changed && changed.length) {
				summary.changed++;
				changedIds.push(id);
				await history.record("products", id, { user: ctx.idUser, source: "bulk", action: "update", changes: changed, meta: { bulk: action }, batch: await batchId() });
			} else summary.unchanged++;
		} catch (e) {
			await conn.rollback().catch(() => {});
			summary.error++;
			report.push({ id, status: "error", message: e.status ? e.message : "server error" });
			if (!e.status) ctx.logError(e);
		} finally {
			conn.release();
		}
	}

	return { summary, report, changedIds, batch: batch ? await batch : null };
}

module.exports = { apply, prepare, runOps, computePrice, roundPrice };