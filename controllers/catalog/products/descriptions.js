"use strict";

const config = require("../../../config/config");
const pool = require("../../../config/database/connection_pool");
const settings = require("./settings");
const slug = require("./slug");
const languages = require("./languages");
const { DESCRIPTION_FIELDS } = require("../../../validator/catalog/products/catalog");
const html = require("../../../validator/catalog/products/html");

const P = config.get("configDatabase").prefix;

// Таблиці описів — лише з цього списку (ім'я таблиці не приходить від клієнта)
const ENTITIES = {
	categories: { table: "products_categories_description", idCol: "id_category" },
	brands: { table: "products_brands_description", idCol: "id_brand" },
	products: { table: "products_description", idCol: "id_product" },
};

/** Мови контенту (довідник каталогу): основна — перша. Поля: id, code, iso, name, native_name, direction */
async function contentLanguages() {
	return languages.active();
}

async function load(entity, id, conn) {
	const e = ENTITIES[entity];
	const [rows] = await (conn || pool).query(`SELECT * FROM ${P}${e.table} WHERE ${e.idCol} = ?`, [id]);
	const out = {};
	for (const r of rows) {
		const { [e.idCol]: _, id_lang, ...rest } = r;
		out[id_lang] = rest;
	}
	return out;
}

/** Зображення з HTML-полів перекладу → індекс посилань (щоб очищення не видалило їх) */
async function syncImageRefs(conn, entity, id, idLang, record) {
	await conn.query(`DELETE FROM ${P}products_html_images WHERE entity = ? AND id_entity = ? AND id_lang = ?`, [entity, id, idLang]);
	const found = new Map();
	for (const f of html.HTML_FIELDS[entity] || []) {
		for (const img of html.extractImages(record[f])) found.set(`${img.kind}:${img.file}`, img);
	}
	if (!found.size) return;
	await conn.query(`INSERT IGNORE INTO ${P}products_html_images (entity, id_entity, id_lang, kind, file) VALUES ?`, [
		[...found.values()].map((img) => [entity, id, idLang, img.kind, img.file]),
	]);
}

function writer(conn, e, entity, id) {
	const fields = Object.keys(DESCRIPTION_FIELDS[entity]);
	return async (idLang, record) => {
		await conn.query(
			`INSERT INTO ${P}${e.table} (${e.idCol}, id_lang, ${fields.join(", ")})
			 VALUES (?, ?, ${fields.map(() => "?").join(", ")})
			 ON DUPLICATE KEY UPDATE ${fields.map((f) => `${f} = ?`).join(", ")}`,
			[id, idLang, ...fields.map((f) => record[f] ?? null), ...fields.map((f) => record[f] ?? null)]
		);
		await syncImageRefs(conn, entity, id, idLang, record);
	};
}

async function currentSlugs(conn, e, id) {
	const [rows] = await conn.query(`SELECT id_lang, slug FROM ${P}${e.table} WHERE ${e.idCol} = ?`, [id]);
	return new Map(rows.map((r) => [Number(r.id_lang), r.slug]));
}

/** Стара адреса → історія (для 301); нова адреса більше не редирект */
async function rememberSlug(conn, entity, id, idLang, oldSlug, newSlug) {
	if (newSlug) await conn.query(`DELETE FROM ${P}products_url_history WHERE entity = ? AND id_lang = ? AND slug = ?`, [entity, idLang, newSlug]);
	if (oldSlug && oldSlug !== newSlug) {
		await conn.query(
			`INSERT INTO ${P}products_url_history (entity, id_entity, id_lang, slug) VALUES (?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE id_entity = VALUES(id_entity), date_add = NOW()`,
			[entity, id, idLang, oldSlug]
		);
	}
}

/**
 * Зберегти описи в межах відкритої транзакції conn.
 * data: { [id_lang]: row | null } після validateDescriptions (null — видалити переклад).
 * opts.sharedSlug — один URL для всіх мов (з основної мови); opts.primaryLang — id основної мови.
 */
async function save(conn, entity, id, data, opts = {}) {
	const e = ENTITIES[entity];
	const slugCfg = await settings.get("slug");
	const write = writer(conn, e, entity, id);
	const old = await currentSlugs(conn, e, id);

	if (opts.sharedSlug) return saveShared(conn, e, entity, id, data, slugCfg, write, opts, old);

	for (const [idLangRaw, row] of Object.entries(data)) {
		const idLang = Number(idLangRaw);
		if (!row) {
			await conn.query(`DELETE FROM ${P}${e.table} WHERE ${e.idCol} = ? AND id_lang = ?`, [id, idLang]);
			await rememberSlug(conn, entity, id, idLang, old.get(idLang), null);
			continue;
		}
		const source = row.slug || (slugCfg.auto ? row.name : null);
		const base = source ? slug.slugify(source, slugCfg) : null;

		// Унікальність гарантує UNIQUE(id_lang, slug); при гонці — повтор із новим суфіксом
		for (let attempt = 0; ; attempt++) {
			const value = base ? await slug.unique(entity, idLang, attempt ? `${base}-${Date.now().toString(36)}` : base, id, conn) : null;
			try {
				await write(idLang, { ...row, slug: value });
				await rememberSlug(conn, entity, id, idLang, old.get(idLang), value);
				break;
			} catch (err) {
				if (err.code !== "ER_DUP_ENTRY" || attempt >= 2) throw err;
			}
		}
	}
}

/** Один slug для всіх перекладів запису (у т.ч. вимкнених мов і тих, що не прийшли в запиті) */
async function saveShared(conn, e, entity, id, data, slugCfg, write, opts, old) {
	const langs = await contentLanguages();
	const primary = opts.primaryLang || (langs[0] && langs[0].id);

	let src = data[primary];
	if (src === undefined) {
		const [[row]] = await conn.query(`SELECT name, slug FROM ${P}${e.table} WHERE ${e.idCol} = ? AND id_lang = ?`, [id, primary]);
		src = row || null;
	}
	const source = src ? src.slug || (slugCfg.auto ? src.name : null) : null;
	const base = source ? slug.slugify(source, slugCfg) : null;

	for (let attempt = 0; ; attempt++) {
		const value = base ? await slug.uniqueShared(entity, attempt ? `${base}-${Date.now().toString(36)}` : base, id, conn) : null;
		try {
			const written = [];
			for (const [idLangRaw, row] of Object.entries(data)) {
				const idLang = Number(idLangRaw);
				if (!row) {
					await conn.query(`DELETE FROM ${P}${e.table} WHERE ${e.idCol} = ? AND id_lang = ?`, [id, idLang]);
					await rememberSlug(conn, entity, id, idLang, old.get(idLang), null);
					continue;
				}
				await write(idLang, { ...row, slug: value });
				written.push(idLang);
			}
			await conn.query(
				`UPDATE ${P}${e.table} SET slug = ? WHERE ${e.idCol} = ?${written.length ? " AND id_lang NOT IN (?)" : ""}`,
				written.length ? [value, id, written] : [value, id]
			);
			const [rest] = await conn.query(`SELECT id_lang FROM ${P}${e.table} WHERE ${e.idCol} = ?`, [id]);
			for (const r of rest) await rememberSlug(conn, entity, id, Number(r.id_lang), old.get(Number(r.id_lang)), value);
			return;
		} catch (err) {
			if (err.code !== "ER_DUP_ENTRY" || attempt >= 2) throw err;
		}
	}
}

module.exports = { ENTITIES, contentLanguages, load, save };