"use strict";

/**
 * Якість каталогу: оцінка заповненості картки (0–100) і пошук можливих дублів.
 * Оцінка зберігається в products.quality_score / quality_issues — фільтр і сортування в списку без перерахунку.
 * Перераховується після збереження картки і щоночі для всього каталогу (зміни імпортом/масово).
 */
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const languages = require("./languages");

const P = config.get("configDatabase").prefix;
const CHUNK = 500;
const PHYSICAL = ["simple", "variable", "bundle"];
const MIN_DESCRIPTION = 300; // символів тексту без HTML

/**
 * Правила: code → вага і чи застосовне до товару. Сума ваг застосовних правил = 100%.
 * Порядок — від найважливішого (так показуються в картці).
 */
const RULES = [
	{ code: "images", weight: 15 },
	{ code: "description", weight: 15 },
	{ code: "category", weight: 10 },
	{ code: "price", weight: 10 },
	{ code: "translations", weight: 10, when: (c) => c.langs > 1 },
	{ code: "images_3", weight: 5 },
	{ code: "short_description", weight: 5 },
	{ code: "brand", weight: 5 },
	{ code: "sku", weight: 5 },
	{ code: "gtin", weight: 5, when: (c) => PHYSICAL.includes(c.p.type) },
	{ code: "shipping", weight: 10, when: (c) => Number(c.p.requires_shipping) === 1 && PHYSICAL.includes(c.p.type) },
	{ code: "attributes", weight: 5 },
];

const CHECK = {
	images: (c) => c.images >= 1,
	images_3: (c) => c.images >= 3,
	description: (c) => c.descLen >= MIN_DESCRIPTION,
	short_description: (c) => c.shortLen > 0,
	category: (c) => !!c.p.id_category_main,
	brand: (c) => !!c.p.id_brand,
	sku: (c) => !!(c.p.sku && String(c.p.sku).trim()),
	gtin: (c) => !!(c.p.ean || c.p.isbn || c.p.upc),
	price: (c) => Number(c.p.price) > 0 || Number(c.p.price_on_request) === 1,
	translations: (c) => c.names >= c.langs,
	shipping: (c) => [c.p.weight, c.p.length, c.p.width, c.p.height].every((v) => v !== null && Number(v) > 0),
	attributes: (c) => c.attributes >= 1,
};

function evaluate(c) {
	let total = 0;
	let got = 0;
	const issues = [];
	for (const r of RULES) {
		if (r.when && !r.when(c)) continue;
		total += r.weight;
		if (CHECK[r.code](c)) got += r.weight;
		else issues.push(r.code);
	}
	return { score: total ? Math.round((got / total) * 100) : 100, issues };
}

const byId = (rows, field) => new Map(rows.map((r) => [Number(r.id_product), Number(r[field])]));

/** Перерахувати оцінку для списку товарів (пачками) */
async function recalc(ids) {
	const list = [...new Set((ids || []).map(Number).filter((x) => x > 0))];
	if (!list.length) return 0;
	const langs = await languages.active();
	const langIds = langs.map((l) => l.id);
	const primary = langIds[0];
	let done = 0;

	for (let i = 0; i < list.length; i += CHUNK) {
		const part = list.slice(i, i + CHUNK);
		const [products] = await pool.query(`SELECT * FROM ${P}products WHERE id IN (?) AND deleted_at IS NULL`, [part]);
		if (!products.length) continue;
		const pids = products.map((p) => p.id);
		const [[names], [desc], [imgs], [attrs]] = await Promise.all([
			pool.query(
				`SELECT id_product, COUNT(*) AS n FROM ${P}products_description WHERE id_product IN (?) AND id_lang IN (?) AND name IS NOT NULL AND name <> '' GROUP BY id_product`,
				[pids, langIds.length ? langIds : [0]]
			),
			pool.query(
				`SELECT id_product,
				        CHAR_LENGTH(TRIM(REGEXP_REPLACE(COALESCE(description, ''), '<[^>]*>', ''))) AS dlen,
				        CHAR_LENGTH(TRIM(REGEXP_REPLACE(COALESCE(short_description, ''), '<[^>]*>', ''))) AS slen
				   FROM ${P}products_description WHERE id_product IN (?) AND id_lang = ?`,
				[pids, primary || 0]
			),
			pool.query(`SELECT id_product, COUNT(*) AS n FROM ${P}products_media WHERE id_product IN (?) AND type = 'image' GROUP BY id_product`, [pids]),
			pool.query(`SELECT id_product, COUNT(DISTINCT id_attribute) AS n FROM ${P}products_to_attributes WHERE id_product IN (?) GROUP BY id_product`, [pids]),
		]);
		const nameMap = byId(names, "n");
		const dMap = byId(desc, "dlen");
		const sMap = byId(desc, "slen");
		const iMap = byId(imgs, "n");
		const aMap = byId(attrs, "n");

		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();
			for (const p of products) {
				const r = evaluate({
					p,
					langs: langIds.length,
					names: nameMap.get(p.id) || 0,
					descLen: dMap.get(p.id) || 0,
					shortLen: sMap.get(p.id) || 0,
					images: iMap.get(p.id) || 0,
					attributes: aMap.get(p.id) || 0,
				});
				// Не чіпаємо version / date_edit — це похідна статистика, а не редагування
				await conn.query(`UPDATE ${P}products SET quality_score = ?, quality_issues = ?, quality_at = NOW() WHERE id = ?`, [r.score, r.issues.join(",") || null, p.id]);
			}
			await conn.commit();
			done += products.length;
		} catch (e) {
			await conn.rollback();
			throw e;
		} finally {
			conn.release();
		}
	}
	return done;
}

let running = false;

/** Cron: увесь каталог, пачками за id (keyset — без OFFSET) */
async function recalcAll() {
	if (running) return { skipped: true };
	running = true;
	let last = 0;
	let total = 0;
	try {
		for (;;) {
			const [rows] = await pool.query(`SELECT id FROM ${P}products WHERE id > ? AND deleted_at IS NULL ORDER BY id LIMIT ?`, [last, CHUNK * 4]);
			if (!rows.length) break;
			total += await recalc(rows.map((r) => r.id));
			last = rows[rows.length - 1].id;
		}
		return { total };
	} finally {
		running = false;
	}
}

/** Зведення для сторінки якості: розподіл оцінок і найчастіші проблеми */
async function summary() {
	const [[dist]] = await pool.query(
		`SELECT SUM(quality_score < 50) AS low, SUM(quality_score BETWEEN 50 AND 79) AS mid, SUM(quality_score >= 80) AS high,
		        SUM(quality_score IS NULL) AS unknown, ROUND(AVG(quality_score)) AS avg_score, COUNT(*) AS total
		   FROM ${P}products WHERE deleted_at IS NULL`
	);
	const issues = {};
	for (const r of RULES) {
		const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products WHERE deleted_at IS NULL AND FIND_IN_SET(?, quality_issues)`, [r.code]);
		issues[r.code] = Number(n);
	}
	return { dist, issues };
}

/* ═══ ДУБЛІ ═══ */

const DUP_TYPES = ["ean", "name", "image"];

/** Пари, позначені «не дубль» */
async function ignoredSet() {
	const [rows] = await pool.query(`SELECT id_a, id_b FROM ${P}products_duplicates_ignored`);
	return new Set(rows.map((r) => `${r.id_a}:${r.id_b}`));
}

/** Прибрати з групи товари, усі пари яких проігноровані; група лишається, якщо є хоч одна неігнорована пара */
function filterGroup(ids, ignored) {
	const sorted = [...new Set(ids)].sort((a, b) => a - b);
	const keep = new Set();
	for (let i = 0; i < sorted.length; i++) {
		for (let j = i + 1; j < sorted.length; j++) {
			if (!ignored.has(`${sorted[i]}:${sorted[j]}`)) {
				keep.add(sorted[i]);
				keep.add(sorted[j]);
			}
		}
	}
	return [...keep];
}

/**
 * Групи можливих дублів:
 *  ean   — однаковий EAN/GTIN (майже напевно дубль);
 *  name  — однакова назва основною мовою (без регістру й зайвих пробілів) у межах бренду;
 *  image — однаковий файл фото (ім'я файлу = хеш вмісту; копії товару теж потрапляють сюди).
 */
async function duplicates(type, idLang, limit = 100) {
	if (!DUP_TYPES.includes(type)) type = "ean";
	const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
	let groups = [];
	if (type === "ean") {
		const [rows] = await pool.query(
			`SELECT ean AS k, GROUP_CONCAT(id ORDER BY id) AS ids FROM ${P}products
			  WHERE deleted_at IS NULL AND ean IS NOT NULL AND ean <> '' GROUP BY ean HAVING COUNT(*) > 1 LIMIT ?`,
			[lim * 2]
		);
		groups = rows;
	} else if (type === "name") {
		const primary = ((await languages.active())[0] || {}).id || idLang;
		const [rows] = await pool.query(
			`SELECT CONCAT(COALESCE(p.id_brand, 0), '|', d.name_key) AS k, GROUP_CONCAT(p.id ORDER BY p.id) AS ids
			   FROM ${P}products_description d JOIN ${P}products p ON p.id = d.id_product AND p.deleted_at IS NULL
			  WHERE d.id_lang = ? AND d.name_key IS NOT NULL AND d.name_key <> ''
			  GROUP BY p.id_brand, d.name_key HAVING COUNT(*) > 1 LIMIT ?`,
			[primary, lim * 2]
		);
		groups = rows;
	} else {
		const [rows] = await pool.query(
			`SELECT m.file AS k, GROUP_CONCAT(DISTINCT m.id_product ORDER BY m.id_product) AS ids
			   FROM ${P}products_media m JOIN ${P}products p ON p.id = m.id_product AND p.deleted_at IS NULL
			  WHERE m.type = 'image' AND m.file IS NOT NULL
			  GROUP BY m.file HAVING COUNT(DISTINCT m.id_product) > 1 LIMIT ?`,
			[lim * 2]
		);
		groups = rows;
	}

	const ignored = await ignoredSet();
	const out = [];
	for (const g of groups) {
		const ids = filterGroup(String(g.ids).split(",").map(Number), ignored);
		if (ids.length > 1) out.push({ key: g.k, ids });
		if (out.length >= lim) break;
	}
	const all = [...new Set(out.flatMap((g) => g.ids))];
	const info = new Map();
	if (all.length) {
		const [rows] = await pool.query(
			`SELECT p.id, p.sku, p.ean, p.status, p.price, p.quality_score,
			        COALESCE((SELECT NULLIF(d.name, '') FROM ${P}products_description d WHERE d.id_product = p.id AND d.id_lang = ?),
			                 (SELECT d.name FROM ${P}products_description d WHERE d.id_product = p.id ORDER BY d.id_lang LIMIT 1)) AS name,
			        (SELECT m.file FROM ${P}products_media m WHERE m.id_product = p.id AND m.type = 'image' ORDER BY m.is_cover DESC, m.sort_order, m.id LIMIT 1) AS image
			   FROM ${P}products p WHERE p.id IN (?)`,
			[idLang, all]
		);
		rows.forEach((r) => info.set(r.id, r));
	}
	return out.map((g) => ({ key: type === "name" ? String(g.key).split("|").slice(1).join("|") : g.key, products: g.ids.map((id) => info.get(id)).filter(Boolean) }));
}

/** «Не дубль»: усі пари всередині набору */
async function ignore(ids, idUser) {
	const list = [...new Set((ids || []).map(Number).filter((x) => x > 0))].sort((a, b) => a - b);
	if (list.length < 2 || list.length > 50) throw Object.assign(new Error("2–50 products required"), { status: 400 });
	const pairs = [];
	for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) pairs.push([list[i], list[j], idUser || null]);
	await pool.query(`INSERT IGNORE INTO ${P}products_duplicates_ignored (id_a, id_b, id_user) VALUES ?`, [pairs]);
	return { pairs: pairs.length };
}

module.exports = { RULES, recalc, recalcAll, summary, duplicates, ignore, DUP_TYPES };