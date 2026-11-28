"use strict";

/**
 * Масові дії з фото товару (дія «Фото» масового редагування):
 *   cover  — зробити головним перше / останнє / фото на позиції N;
 *   remove — прибрати всі фото, усі крім головного, усі після перших N або повтори того самого файла;
 *   alt    — ALT (і title) фото за шаблоном, кожною мовою своєю мовою.
 *
 * Історія: одна зміна «media» на товар зі знімком медіа товару до й після (рядки, ALT мовами, прив'язки до варіантів).
 * Відміна повертає знімок «до» — і видалені фото: файли при масовому видаленні не стираються одразу
 * (їх прибирає звичайне обслуговування зображень, коли ними ніхто не користується).
 */

const fs = require("fs/promises");
const config = require("../../../config/config");
const images = require("./images");

const P = config.get("configDatabase").prefix;
const ALT_MAX = 255;

/** Знімок медіа товару: усе, що потрібно, щоб повернути його точно таким */
async function snapshot(conn, idProduct) {
	const [rows] = await conn.query(`SELECT id, type, file, url, hash, mime, width, height, size, is_cover, sort_order FROM ${P}products_media WHERE id_product = ? ORDER BY sort_order, id`, [idProduct]);
	if (!rows.length) return { items: [] };
	const ids = rows.map((r) => r.id);
	const [descs] = await conn.query(`SELECT id_media, id_lang, alt, title FROM ${P}products_media_description WHERE id_media IN (?) ORDER BY id_media, id_lang`, [ids]);
	const [links] = await conn.query(`SELECT id_media, id_variant, sort_order FROM ${P}products_variant_media WHERE id_media IN (?) ORDER BY id_media, id_variant`, [ids]);
	return {
		items: rows.map((r) => ({
			...r,
			is_cover: Number(r.is_cover),
			alts: Object.fromEntries(descs.filter((d) => d.id_media === r.id).map((d) => [d.id_lang, { alt: d.alt, title: d.title }])),
			variants: links.filter((l) => l.id_media === r.id).map((l) => [l.id_variant, l.sort_order]),
		})),
	};
}

/** Однаковий стан медіа (для відміни «лише якщо після зміни не чіпали») */
const key = (snap) => JSON.stringify((snap.items || []).map((m) => [m.id, m.is_cover, m.sort_order, m.alts, m.variants]));
const same = (a, b) => key(a) === key(b);

/** Короткий опис знімка для журналу й перегляду: кількість фото, позиція головного, ALT головного */
function summary(snap, idLang) {
	const imgs = (snap && snap.items ? snap.items : []).filter((m) => m.type === "image");
	const at = imgs.findIndex((m) => m.is_cover);
	const cover = imgs[at] || null;
	const alt = cover && cover.alts ? (cover.alts[idLang] || Object.values(cover.alts)[0] || {}).alt || "" : "";
	return { n: imgs.length, cover: at >= 0 ? at + 1 : null, alt };
}

/** Повернути знімок: зайве — видалити, відсутнє — вставити з тим самим id (якщо файл ще на диску), порядок, ALT, варіанти */
async function restore(conn, idProduct, snap) {
	const want = snap.items || [];
	const [cur] = await conn.query(`SELECT id FROM ${P}products_media WHERE id_product = ?`, [idProduct]);
	const wantIds = new Set(want.map((m) => m.id));
	const extra = cur.filter((r) => !wantIds.has(r.id)).map((r) => r.id);
	if (extra.length) await conn.query(`DELETE FROM ${P}products_media WHERE id IN (?)`, [extra]);
	const have = new Set(cur.map((r) => r.id));
	const missing = [];
	for (const m of want) {
		if (have.has(m.id)) {
			await conn.query(`UPDATE ${P}products_media SET is_cover = ?, sort_order = ? WHERE id = ? AND id_product = ?`, [m.is_cover, m.sort_order, m.id, idProduct]);
		} else {
			// Файл уже прибрало обслуговування зображень — це фото повернути не можна
			if (m.file && !(await fs.access(images.absPath("products", m.file)).then(() => true, () => false))) {
				missing.push(m.file);
				continue;
			}
			await conn.query(`INSERT INTO ${P}products_media (id, id_product, type, file, url, hash, mime, width, height, size, is_cover, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
				m.id, idProduct, m.type, m.file, m.url, m.hash, m.mime, m.width, m.height, m.size, m.is_cover, m.sort_order,
			]);
		}
		await conn.query(`DELETE FROM ${P}products_media_description WHERE id_media = ?`, [m.id]);
		const alts = Object.entries(m.alts || {});
		if (alts.length) await conn.query(`INSERT INTO ${P}products_media_description (id_media, id_lang, alt, title) VALUES ?`, [alts.map(([lang, d]) => [m.id, Number(lang), d.alt, d.title])]);
		await conn.query(`DELETE FROM ${P}products_variant_media WHERE id_media = ?`, [m.id]);
		if ((m.variants || []).length) {
			// Лише варіанти, які ще існують у цього товару
			const [vs] = await conn.query(`SELECT id FROM ${P}products_variants WHERE id_product = ? AND id IN (?)`, [idProduct, m.variants.map((v) => v[0])]);
			const ok = new Set(vs.map((v) => v.id));
			const rows = m.variants.filter((v) => ok.has(v[0])).map((v) => [v[0], m.id, v[1]]);
			if (rows.length) await conn.query(`INSERT INTO ${P}products_variant_media (id_variant, id_media, sort_order) VALUES ?`, [rows]);
		}
	}
	return { missing };
}

/** Головне фото — одне: якщо головного серед фото немає, ним стає перше; порядок — 0, 1, 2… */
async function normalize(conn, idProduct) {
	const [rows] = await conn.query(`SELECT id, type, is_cover FROM ${P}products_media WHERE id_product = ? ORDER BY sort_order, id`, [idProduct]);
	const imgs = rows.filter((r) => r.type === "image");
	const coverId = (imgs.find((r) => Number(r.is_cover)) || imgs[0] || {}).id;
	for (const [i, r] of rows.entries()) await conn.query(`UPDATE ${P}products_media SET sort_order = ?, is_cover = ? WHERE id = ?`, [i, r.id === coverId ? 1 : 0, r.id]);
}

/** Підстановки шаблону ALT мовою lang: {name} {brand} {category} {sku} {model} {id} {n} — n: номер фото */
function render(template, vals, n) {
	return template
		.replace(/\{(name|brand|category|sku|model|id|n)\}/g, (_, k) => (k === "n" ? String(n) : vals[k] || ""))
		.replace(/\s+/g, " ")
		.replace(/([|,;:–—-])(\s*[|,;:–—-])+/g, "$1")
		.replace(/^[\s|,;:–—-]+|[\s|,;:–—-]+$/g, "")
		.slice(0, ALT_MAX)
		.trim();
}

/**
 * Застосувати дію до товару (у транзакції обробки). Повертає зміну для історії або null (нічого не змінилося).
 * h: { langs: [id мови], primary: id основної мови, nameIn(conn, table, col, id, lang, primary) }
 */
async function apply(conn, product, params, h) {
	const before = await snapshot(conn, product.id);
	const imgs = before.items.filter((m) => m.type === "image");
	if (!imgs.length) return null;

	if (params.op === "cover") {
		const target = params.pick === "last" ? imgs[imgs.length - 1] : params.pick === "position" ? imgs[params.position - 1] : imgs[0];
		if (!target || target.is_cover) return null;
		await conn.query(`UPDATE ${P}products_media SET is_cover = (id = ?) WHERE id_product = ? AND type = 'image'`, [target.id, product.id]);
		// Головне — першим у галереї (так його бачить і сайт, і картка)
		if (params.move_first) {
			const order = [target, ...before.items.filter((m) => m.id !== target.id)];
			for (const [i, m] of order.entries()) await conn.query(`UPDATE ${P}products_media SET sort_order = ? WHERE id = ?`, [i, m.id]);
		}
	} else if (params.op === "remove") {
		let drop;
		if (params.what === "all") drop = imgs;
		else if (params.what === "except_cover") {
			const keepId = (imgs.find((x) => x.is_cover) || imgs[0]).id;
			drop = imgs.filter((m) => m.id !== keepId);
		}
		else if (params.what === "keep_first") drop = imgs.slice(params.keep);
		else {
			// Повтори: той самий файл (хеш) удруге й далі — лишається перше входження (або головне)
			const seen = new Set(imgs.filter((m) => m.is_cover).map((m) => m.hash || m.file));
			drop = imgs.filter((m) => {
				const k = m.hash || m.file;
				if (m.is_cover) return false;
				if (seen.has(k)) return true;
				seen.add(k);
				return false;
			});
		}
		if (!drop.length) return null;
		await conn.query(`DELETE FROM ${P}products_media WHERE id IN (?)`, [drop.map((m) => m.id)]);
		await normalize(conn, product.id);
	} else if (params.op === "alt") {
		const primary = Number(h.primary);
		const [descRows] = await conn.query(`SELECT id_lang, name FROM ${P}products_description WHERE id_product = ?`, [product.id]);
		const names = new Map(descRows.map((d) => [Number(d.id_lang), d.name]));
		let touched = false;
		for (const lang of h.langs) {
			const vals = {
				name: names.get(lang) || names.get(primary) || "",
				brand: await h.nameIn(conn, "products_brands_description", "id_brand", product.id_brand, lang, primary),
				category: await h.nameIn(conn, "products_categories_description", "id_category", product.id_category_main, lang, primary),
				sku: product.sku || "",
				model: product.model || "",
				id: String(product.id),
			};
			for (const [i, m] of imgs.entries()) {
				const cur = (m.alts[lang] || {})[params.field] || null;
				if (params.only_empty && cur && String(cur).trim() !== "") continue;
				const text = params.clear ? null : render(params.template, vals, i + 1) || null;
				if ((cur || null) === text) continue;
				await conn.query(`INSERT INTO ${P}products_media_description (id_media, id_lang, \`${params.field}\`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE \`${params.field}\` = VALUES(\`${params.field}\`)`, [m.id, lang, text]);
				touched = true;
			}
		}
		if (!touched) return null;
		// Рядок без ALT і title — зайвий
		await conn.query(`DELETE FROM ${P}products_media_description WHERE id_media IN (?) AND alt IS NULL AND title IS NULL`, [imgs.map((m) => m.id)]);
	} else return null;

	const after = await snapshot(conn, product.id);
	if (same(before, after)) return null;
	return { field: "media", media: true, old: before, new: after };
}

module.exports = { apply, snapshot, restore, same, summary };