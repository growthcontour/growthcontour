"use strict";

const config = require("../../../config/config");
const pool = require("../../../config/database/connection_pool");
const settings = require("./settings");
const slug = require("./slug");
const languages = require("./languages");
const { DESCRIPTION_FIELDS } = require("../../../validator/catalog/products/catalog");

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

function writer(conn, e, entity, id) {
	const fields = Object.keys(DESCRIPTION_FIELDS[entity]);
	return (idLang, record) =>
		conn.query(
			`INSERT INTO ${P}${e.table} (${e.idCol}, id_lang, ${fields.join(", ")})
			 VALUES (?, ?, ${fields.map(() => "?").join(", ")})
			 ON DUPLICATE KEY UPDATE ${fields.map((f) => `${f} = ?`).join(", ")}`,
			[id, idLang, ...fields.map((f) => record[f] ?? null), ...fields.map((f) => record[f] ?? null)]
		);
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

	if (opts.sharedSlug) return saveShared(conn, e, entity, id, data, slugCfg, write, opts);

	for (const [idLangRaw, row] of Object.entries(data)) {
		const idLang = Number(idLangRaw);
		if (!row) {
			await conn.query(`DELETE FROM ${P}${e.table} WHERE ${e.idCol} = ? AND id_lang = ?`, [id, idLang]);
			continue;
		}
		const source = row.slug || (slugCfg.auto ? row.name : null);
		const base = source ? slug.slugify(source, slugCfg) : null;

		// Унікальність гарантує UNIQUE(id_lang, slug); при гонці — повтор із новим суфіксом
		for (let attempt = 0; ; attempt++) {
			const value = base ? await slug.unique(entity, idLang, attempt ? `${base}-${Date.now().toString(36)}` : base, id, conn) : null;
			try {
				await write(idLang, { ...row, slug: value });
				break;
			} catch (err) {
				if (err.code !== "ER_DUP_ENTRY" || attempt >= 2) throw err;
			}
		}
	}
}

/** Один slug для всіх перекладів запису (у т.ч. вимкнених мов і тих, що не прийшли в запиті) */
async function saveShared(conn, e, entity, id, data, slugCfg, write, opts) {
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
					continue;
				}
				await write(idLang, { ...row, slug: value });
				written.push(idLang);
			}
			await conn.query(
				`UPDATE ${P}${e.table} SET slug = ? WHERE ${e.idCol} = ?${written.length ? " AND id_lang NOT IN (?)" : ""}`,
				written.length ? [value, id, written] : [value, id]
			);
			return;
		} catch (err) {
			if (err.code !== "ER_DUP_ENTRY" || attempt >= 2) throw err;
		}
	}
}

module.exports = { ENTITIES, contentLanguages, load, save };