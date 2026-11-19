"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("./settings");
const slug = require("./slug");
const descriptions = require("./descriptions");
const { VALUE_TYPES, validateOption } = require("../../../validator/catalog/products/options");

const P = config.get("configDatabase").prefix;

function httpErr(status, message, errors, extra) {
	return Object.assign(new Error(message), { status, errors }, extra || {});
}

async function tx(fn) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const r = await fn(conn);
		await conn.commit();
		return r;
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

const langIds = async () => (await descriptions.contentLanguages()).map((l) => l.id);

async function saveNames(conn, table, idCol, id, names) {
	for (const [lang, row] of Object.entries(names)) {
		if (!row) {
			await conn.query(`DELETE FROM ${P}${table} WHERE ${idCol} = ? AND id_lang = ?`, [id, Number(lang)]);
			continue;
		}
		await conn.query(`INSERT INTO ${P}${table} (${idCol}, id_lang, name) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = ?`, [id, Number(lang), row.name, row.name]);
	}
}

async function uniqueCode(conn, base, excludeId) {
	const [rows] = await conn.query(`SELECT code FROM ${P}products_options WHERE (code = ? OR code LIKE ?) AND id <> ?`, [base, base + "\\_%", excludeId || 0]);
	const taken = new Set(rows.map((r) => r.code));
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

async function list(idLang) {
	const ids = await langIds();
	const primary = ids[0] || idLang;
	const [rows] = await pool.query(
		`SELECT o.id, o.code, o.type, o.sort_order,
		        COALESCE(NULLIF(d.name, ''), dp.name, o.code) AS name,
		        (SELECT COUNT(*) FROM ${P}products_option_values v WHERE v.id_option = o.id) AS values_count,
		        (SELECT COUNT(DISTINCT pto.id_product) FROM ${P}products_to_options pto WHERE pto.id_option = o.id) AS products
		   FROM ${P}products_options o
		   LEFT JOIN ${P}products_options_description d  ON d.id_option = o.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_options_description dp ON dp.id_option = o.id AND dp.id_lang = ?
		  ORDER BY o.sort_order, o.id`,
		[idLang, primary]
	);
	return rows;
}

async function get(id) {
	const [[row]] = await pool.query(`SELECT * FROM ${P}products_options WHERE id = ?`, [id]);
	if (!row) throw httpErr(404, "Not found");
	const [names] = await pool.query(`SELECT id_lang, name FROM ${P}products_options_description WHERE id_option = ?`, [id]);
	const [values] = await pool.query(
		`SELECT v.id, v.color_hex, v.sort_order,
		        (SELECT COUNT(DISTINCT pto.id_product) FROM ${P}products_to_option_values ptov
		           JOIN ${P}products_to_options pto ON pto.id = ptov.id_product_option
		          WHERE ptov.id_option_value = v.id) AS products
		   FROM ${P}products_option_values v WHERE v.id_option = ? ORDER BY v.sort_order, v.id`,
		[id]
	);
	const [vnames] = await pool.query(
		`SELECT d.id_option_value, d.id_lang, d.name FROM ${P}products_option_values_description d
		   JOIN ${P}products_option_values v ON v.id = d.id_option_value WHERE v.id_option = ?`,
		[id]
	);
	const byValue = {};
	vnames.forEach((n) => ((byValue[n.id_option_value] = byValue[n.id_option_value] || {})[n.id_lang] = { name: n.name }));
	return {
		...row,
		names: Object.fromEntries(names.map((n) => [n.id_lang, { name: n.name }])),
		values: values.map((v) => ({ ...v, names: byValue[v.id] || {} })),
	};
}

async function save(id, body) {
	const ids = await langIds();
	const v = validateOption(body, ids);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);
	const d = v.data;

	return tx(async (conn) => {
		if (!d.code) {
			const cfg = await settings.get("slug");
			const base = slug.slugify((v.names[ids[0]] || {}).name || "option", { transliteration: cfg.transliteration === "none" ? "uk" : cfg.transliteration, max_length: 60 }).replace(/-/g, "_") || "option";
			d.code = await uniqueCode(conn, base, id);
		}
		try {
			if (id) {
				const [[cur]] = await conn.query(`SELECT * FROM ${P}products_options WHERE id = ? FOR UPDATE`, [id]);
				if (!cur) throw httpErr(404, "Not found");
				const wasValueType = VALUE_TYPES.includes(cur.type);
				const isValueType = VALUE_TYPES.includes(d.type);
				if (wasValueType !== isValueType) {
					const [[u]] = await conn.query(`SELECT COUNT(*) AS n FROM ${P}products_to_options WHERE id_option = ?`, [id]);
					if (Number(u.n) > 0) throw httpErr(409, "Incompatible type change", [{ field: "type", message: `option is used in ${u.n} products` }]);
				}
				await conn.query(`UPDATE ${P}products_options SET code = ?, type = ?, sort_order = ? WHERE id = ?`, [d.code, d.type, d.sort_order, id]);
			} else {
				const [r] = await conn.query(`INSERT INTO ${P}products_options (code, type, sort_order) VALUES (?, ?, ?)`, [d.code, d.type, d.sort_order]);
				id = r.insertId;
			}
		} catch (e) {
			if (e.code === "ER_DUP_ENTRY") throw httpErr(409, "Code already exists", [{ field: "code", message: "already exists" }]);
			throw e;
		}
		await saveNames(conn, "products_options_description", "id_option", id, v.names);

		// ── Значення: синхронізація з перевіркою використання ──
		const [existing] = await conn.query(`SELECT id FROM ${P}products_option_values WHERE id_option = ? FOR UPDATE`, [id]);
		const existingIds = new Set(existing.map((e) => e.id));
		const incoming = VALUE_TYPES.includes(d.type) ? v.values : [];
		for (const val of incoming) if (val.id && !existingIds.has(val.id)) throw httpErr(400, "Validation failed", [{ field: "values", message: "invalid value id" }]);
		const keep = new Set(incoming.filter((x) => x.id).map((x) => x.id));
		const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
		if (toDelete.length) {
			const [[used]] = await conn.query(
				`SELECT COUNT(DISTINCT pto.id_product) AS n FROM ${P}products_to_option_values ptov
				   JOIN ${P}products_to_options pto ON pto.id = ptov.id_product_option
				  WHERE ptov.id_option_value IN (?)`,
				[toDelete]
			);
			if (Number(used.n) > 0) throw httpErr(409, "Values are used in products", [{ field: "values", message: `removed values are used in ${used.n} products — remove them from products first` }]);
			await conn.query(`DELETE FROM ${P}products_option_values WHERE id IN (?)`, [toDelete]);
		}
		for (let i = 0; i < incoming.length; i++) {
			const val = incoming[i];
			let vid = val.id;
			if (vid) await conn.query(`UPDATE ${P}products_option_values SET color_hex = ?, sort_order = ? WHERE id = ?`, [val.color_hex, i, vid]);
			else {
				const [r] = await conn.query(`INSERT INTO ${P}products_option_values (id_option, color_hex, sort_order) VALUES (?, ?, ?)`, [id, val.color_hex, i]);
				vid = r.insertId;
			}
			await saveNames(conn, "products_option_values_description", "id_option_value", vid, val.names);
		}
		return { id };
	});
}

async function remove(id) {
	return tx(async (conn) => {
		const [[cur]] = await conn.query(`SELECT id FROM ${P}products_options WHERE id = ? FOR UPDATE`, [id]);
		if (!cur) throw httpErr(404, "Not found");
		const [[u]] = await conn.query(`SELECT COUNT(DISTINCT id_product) AS n FROM ${P}products_to_options WHERE id_option = ?`, [id]);
		if (Number(u.n) > 0) throw httpErr(409, `Option is used in ${u.n} products — remove it from products first`);
		await conn.query(`DELETE FROM ${P}products_options WHERE id = ?`, [id]);
		return { ok: true };
	});
}

/** Довідник для карточки товару */
async function dictionary(idLang) {
	const ids = await langIds();
	const primary = ids[0] || idLang;
	const options = await list(idLang);
	const [values] = await pool.query(
		`SELECT v.id, v.id_option, v.color_hex, COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', v.id)) AS name
		   FROM ${P}products_option_values v
		   LEFT JOIN ${P}products_option_values_description d  ON d.id_option_value = v.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_option_values_description dp ON dp.id_option_value = v.id AND dp.id_lang = ?
		  ORDER BY v.id_option, v.sort_order, v.id`,
		[idLang, primary]
	);
	return { options, values };
}

module.exports = { list, get, save, remove, dictionary };