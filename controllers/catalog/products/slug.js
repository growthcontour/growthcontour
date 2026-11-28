"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");

const P = config.get("configDatabase").prefix;

// Постанова КМУ №55 від 27.01.2010; на початку слова — інші відповідники для є, ї, й, ю, я
const UK = { а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", "'": "", "’": "", ʼ: "" };
const UK_START = { є: "ye", ї: "yi", й: "y", ю: "yu", я: "ya" };
const RU = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", і: "i", ї: "yi", є: "ye", ґ: "g" };

// Таблиці, для яких дозволена перевірка унікальності (захист від SQL-ін'єкції в імені таблиці)
const TABLES = {
	products: { table: "products_description", idCol: "id_product" },
	categories: { table: "products_categories_description", idCol: "id_category" },
	brands: { table: "products_brands_description", idCol: "id_brand" },
};

function transliterate(text, mode) {
	const src = String(text || "").normalize("NFC").toLowerCase();
	if (mode === "none") return src;
	const map = mode === "ru" ? RU : UK;
	let out = "";
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		const wordStart = i === 0 || !/[\p{L}'’ʼ]/u.test(src[i - 1]);
		if (mode !== "ru" && wordStart && UK_START[ch]) out += UK_START[ch];
		else if (mode !== "ru" && ch === "г" && src[i - 1] === "з") out += "gh"; // зг → zgh
		else out += map[ch] !== undefined ? map[ch] : ch;
	}
	return out;
}

function slugify(text, opts = {}) {
	const maxLength = opts.max_length || 120;
	return transliterate(text, opts.transliteration || "uk")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "") // діакритика: é → e
		.replace(/&/g, "-and-")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLength)
		.replace(/-+$/g, "");
}

/**
 * Перелік уже зайнятих slug-ів з кореня root: живі адреси інших записів + історія URL інших записів
 * (стара адреса, з якої йде 301, не повинна дістатися новому запису).
 */
async function takenSlugs(db, entity, idLang, root, excludeId) {
	const t = TABLES[entity];
	const like = root.replace(/[\\%_]/g, "\\$&") + "-%";
	const langCond = idLang === null ? "" : "id_lang = ? AND ";
	const langArg = idLang === null ? [] : [idLang];
	const [rows] = await db.query(
		`SELECT slug FROM ${P}${t.table} WHERE ${langCond}(slug = ? OR slug LIKE ?) AND ${t.idCol} <> ?
		 UNION
		 SELECT slug FROM ${P}products_url_history WHERE entity = ? AND ${langCond}(slug = ? OR slug LIKE ?) AND id_entity <> ?`,
		[...langArg, root, like, excludeId || 0, entity, ...langArg, root, like, excludeId || 0]
	);
	return new Set(rows.map((r) => r.slug));
}

function firstFree(root, taken) {
	if (!taken.has(root)) return root;
	for (let n = 2; n < 10000; n++) {
		const candidate = `${root}-${n}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${root}-${Date.now()}`;
}

/** Унікальний slug у межах (сутність, мова); excludeId — поточний запис при редагуванні */
async function unique(entity, idLang, base, excludeId, conn) {
	if (!TABLES[entity]) throw new Error("slug.unique: unknown entity " + entity);
	const root = base || "item";
	return firstFree(root, await takenSlugs(conn || pool, entity, idLang, root, excludeId));
}

/** Один slug для всіх мов запису: вільний у кожній мові сутності */
async function uniqueShared(entity, base, excludeId, conn) {
	if (!TABLES[entity]) throw new Error("slug.uniqueShared: unknown entity " + entity);
	const root = base || "item";
	return firstFree(root, await takenSlugs(conn || pool, entity, null, root, excludeId));
}

module.exports = { transliterate, slugify, unique, uniqueShared, TABLES };