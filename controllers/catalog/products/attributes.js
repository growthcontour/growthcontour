"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("./settings");
const slug = require("./slug");
const descriptions = require("./descriptions");
const { VALUE_TYPES, validateAttribute, validateGroup, validateSet } = require("../../../validator/catalog/products/attributes");

const P = config.get("configDatabase").prefix;

// Між якими типами можна перемикатися, коли характеристика вже заповнена в товарах
const COMPATIBLE = [["select", "multiselect", "color"], ["text", "textarea"], ["integer", "decimal"], ["boolean"], ["date"]];
const compatible = (a, b) => a === b || COMPATIBLE.some((g) => g.includes(a) && g.includes(b));

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

async function langIds() {
	return (await descriptions.contentLanguages()).map((l) => l.id);
}

/** Код з назви: латиниця, цифри, "_" (для значень дозволено ще "-") */
async function codeFromName(name, allowDash) {
	const cfg = await settings.get("slug");
	let code = slug.slugify(name || "", { transliteration: cfg.transliteration === "none" ? "uk" : cfg.transliteration, max_length: 64 });
	if (!allowDash) code = code.replace(/-/g, "_");
	return code.toLowerCase().replace(/[^a-z0-9_\-]/g, "").slice(0, 64) || "item";
}

function uniqueIn(base, taken, maxLen = 64) {
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = base.slice(0, maxLen - String(n).length - 1) + "_" + n;
		if (!taken.has(candidate)) return candidate;
	}
}

async function loadNames(conn, table, idCol, id) {
	const [rows] = await (conn || pool).query(`SELECT * FROM ${P}${table} WHERE ${idCol} = ?`, [id]);
	const out = {};
	for (const r of rows) {
		const { [idCol]: _, id_lang, ...rest } = r;
		out[id_lang] = rest;
	}
	return out;
}

async function saveNames(conn, table, idCol, id, names) {
	for (const [lang, row] of Object.entries(names)) {
		if (!row) {
			await conn.query(`DELETE FROM ${P}${table} WHERE ${idCol} = ? AND id_lang = ?`, [id, Number(lang)]);
			continue;
		}
		const cols = Object.keys(row);
		await conn.query(
			`INSERT INTO ${P}${table} (${idCol}, id_lang, ${cols.join(", ")}) VALUES (?, ?, ${cols.map(() => "?").join(", ")})
			 ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = ?`).join(", ")}`,
			[id, Number(lang), ...cols.map((c) => row[c]), ...cols.map((c) => row[c])]
		);
	}
}

const nameSql = (alias, table, idCol, idLang, primary) =>
	`COALESCE(NULLIF((SELECT x.name FROM ${P}${table} x WHERE x.${idCol} = ${alias}.id AND x.id_lang = ${Number(idLang)}), ''),
	          (SELECT x.name FROM ${P}${table} x WHERE x.${idCol} = ${alias}.id AND x.id_lang = ${Number(primary)}),
	          CONCAT('#', ${alias}.id))`;

async function primaryLang(idLang) {
	const ids = await langIds();
	return ids[0] || idLang;
}

// ═══ ГРУПИ ═════════════════════════════════════════════
async function listGroups(idLang) {
	const primary = await primaryLang(idLang);
	const [rows] = await pool.query(
		`SELECT g.id, g.code, g.sort_order, ${nameSql("g", "products_attribute_groups_description", "id_attribute_group", idLang, primary)} AS name,
		        (SELECT COUNT(*) FROM ${P}products_attributes a WHERE a.id_attribute_group = g.id) AS attributes
		   FROM ${P}products_attribute_groups g
		  ORDER BY g.sort_order, g.id`
	);
	return rows;
}

async function getGroup(id) {
	const [[row]] = await pool.query(`SELECT * FROM ${P}products_attribute_groups WHERE id = ?`, [id]);
	if (!row) throw httpErr(404, "Not found");
	return { ...row, names: await loadNames(null, "products_attribute_groups_description", "id_attribute_group", id) };
}

async function saveGroup(id, body) {
	const v = validateGroup(body, await langIds());
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);
	return tx(async (conn) => {
		try {
			if (id) {
				const [r] = await conn.query(`UPDATE ${P}products_attribute_groups SET code = ?, sort_order = ? WHERE id = ?`, [v.data.code, v.data.sort_order, id]);
				if (!r.affectedRows) throw httpErr(404, "Not found");
			} else {
				const [r] = await conn.query(`INSERT INTO ${P}products_attribute_groups (code, sort_order) VALUES (?, ?)`, [v.data.code, v.data.sort_order]);
				id = r.insertId;
			}
		} catch (e) {
			if (e.code === "ER_DUP_ENTRY") throw httpErr(409, "Code already exists", [{ field: "code", message: "already exists" }]);
			throw e;
		}
		await saveNames(conn, "products_attribute_groups_description", "id_attribute_group", id, v.names);
		return { id };
	});
}

async function removeGroup(id) {
	// Характеристики групи лишаються, їхній id_attribute_group → NULL (FK SET NULL)
	const [r] = await pool.query(`DELETE FROM ${P}products_attribute_groups WHERE id = ?`, [id]);
	if (!r.affectedRows) throw httpErr(404, "Not found");
	return { ok: true };
}

// ═══ ХАРАКТЕРИСТИКИ ════════════════════════════════════
async function listAttributes(idLang) {
	const primary = await primaryLang(idLang);
	const [rows] = await pool.query(
		`SELECT a.id, a.code, a.type, a.unit, a.id_attribute_group, a.is_filterable, a.is_comparable, a.is_visible_on_card,
		        a.is_variant_axis, a.is_required, a.sort_order,
		        ${nameSql("a", "products_attributes_description", "id_attribute", idLang, primary)} AS name,
		        ${nameSql("g", "products_attribute_groups_description", "id_attribute_group", idLang, primary)} AS group_name,
		        (SELECT COUNT(*) FROM ${P}products_attribute_values v WHERE v.id_attribute = a.id) AS values_count,
		        ((SELECT COUNT(DISTINCT pa.id_product) FROM ${P}products_to_attributes pa WHERE pa.id_attribute = a.id)
		         + (SELECT COUNT(DISTINCT pt.id_product) FROM ${P}products_to_attributes_text pt WHERE pt.id_attribute = a.id)) AS products
		   FROM ${P}products_attributes a
		   LEFT JOIN ${P}products_attribute_groups g ON g.id = a.id_attribute_group
		  ORDER BY g.sort_order IS NULL, g.sort_order, a.sort_order, a.id`
	);
	return rows;
}

async function getAttribute(id) {
	const [[row]] = await pool.query(`SELECT * FROM ${P}products_attributes WHERE id = ?`, [id]);
	if (!row) throw httpErr(404, "Not found");
	const [values] = await pool.query(
		`SELECT v.id, v.code, v.color_hex, v.sort_order,
		        (SELECT COUNT(DISTINCT pa.id_product) FROM ${P}products_to_attributes pa WHERE pa.id_attribute_value = v.id) AS products,
		        (SELECT COUNT(*) FROM ${P}products_variant_values vv WHERE vv.id_attribute_value = v.id) AS variants
		   FROM ${P}products_attribute_values v
		  WHERE v.id_attribute = ?
		  ORDER BY v.sort_order, v.id`,
		[id]
	);
	const [vnames] = await pool.query(
		`SELECT d.id_attribute_value, d.id_lang, d.name FROM ${P}products_attribute_values_description d
		   JOIN ${P}products_attribute_values v ON v.id = d.id_attribute_value
		  WHERE v.id_attribute = ?`,
		[id]
	);
	const byValue = {};
	vnames.forEach((n) => ((byValue[n.id_attribute_value] = byValue[n.id_attribute_value] || {})[n.id_lang] = { name: n.name }));
	return {
		...row,
		names: await loadNames(null, "products_attributes_description", "id_attribute", id),
		values: values.map((v) => ({ ...v, names: byValue[v.id] || {} })),
	};
}

async function usage(conn, idAttribute) {
	const [[u]] = await conn.query(
		`SELECT (SELECT COUNT(DISTINCT id_product) FROM ${P}products_to_attributes WHERE id_attribute = ?)
		      + (SELECT COUNT(DISTINCT id_product) FROM ${P}products_to_attributes_text WHERE id_attribute = ?) AS products,
		        (SELECT COUNT(*) FROM ${P}products_variant_axes WHERE id_attribute = ?) AS axes`,
		[idAttribute, idAttribute, idAttribute]
	);
	return { products: Number(u.products), axes: Number(u.axes) };
}

/** Перевірка безпечності зміни типу / прапорців для вже заповненої характеристики */
async function assertTypeChange(conn, cur, next) {
	const u = await usage(conn, cur.id);
	if (cur.is_variant_axis && !next.is_variant_axis && u.axes > 0) {
		throw httpErr(409, "Attribute is used as a variant axis", [{ field: "is_variant_axis", message: "used as variant axis in products" }]);
	}
	if (cur.type === next.type) return;
	if (u.axes > 0 && !["select", "color"].includes(next.type)) {
		throw httpErr(409, "Attribute is used as a variant axis", [{ field: "type", message: "used as variant axis in products" }]);
	}
	if (u.products > 0 && !compatible(cur.type, next.type)) {
		throw httpErr(409, "Incompatible type change", [{ field: "type", message: `cannot change ${cur.type} → ${next.type}: attribute is filled in ${u.products} products` }]);
	}
	if (cur.type === "multiselect" && next.type !== "multiselect") {
		const [[multi]] = await conn.query(
			`SELECT id_product FROM ${P}products_to_attributes WHERE id_attribute = ? GROUP BY id_product HAVING COUNT(*) > 1 LIMIT 1`,
			[cur.id]
		);
		if (multi) throw httpErr(409, "Some products have several values", [{ field: "type", message: "some products have several values selected" }]);
	}
	if (cur.type === "decimal" && next.type === "integer") {
		const [[frac]] = await conn.query(`SELECT 1 AS x FROM ${P}products_to_attributes WHERE id_attribute = ? AND value_number <> FLOOR(value_number) LIMIT 1`, [cur.id]);
		if (frac) throw httpErr(409, "Some products have fractional values", [{ field: "type", message: "some products have fractional values" }]);
	}
}

/** Синхронізація списку значень: оновити наявні, додати нові, видалити відсутні (з перевірками) */
async function syncValues(conn, idAttribute, values, force, primary) {
	const [existing] = await conn.query(
		`SELECT v.id,
		        (SELECT COUNT(DISTINCT pa.id_product) FROM ${P}products_to_attributes pa WHERE pa.id_attribute_value = v.id) AS products,
		        (SELECT COUNT(*) FROM ${P}products_variant_values vv WHERE vv.id_attribute_value = v.id) AS variants
		   FROM ${P}products_attribute_values v WHERE v.id_attribute = ? FOR UPDATE`,
		[idAttribute]
	);
	const existingIds = new Set(existing.map((e) => e.id));
	for (const v of values) {
		if (v.id && !existingIds.has(v.id)) throw httpErr(400, "Value does not belong to attribute", [{ field: "values", message: "invalid value id" }]);
	}
	const keep = new Set(values.filter((v) => v.id).map((v) => v.id));
	const toDelete = existing.filter((e) => !keep.has(e.id));

	const inVariants = toDelete.filter((e) => Number(e.variants) > 0);
	if (inVariants.length) throw httpErr(409, "Values are used in product variants", [{ field: "values", message: `${inVariants.length} removed values are used in product variants` }]);
	const affected = toDelete.reduce((s, e) => s + Number(e.products), 0);
	if (affected > 0 && !force) throw httpErr(409, "Values are used in products", null, { code: "values_in_use", products: affected });

	if (toDelete.length) await conn.query(`DELETE FROM ${P}products_attribute_values WHERE id IN (?)`, [toDelete.map((e) => e.id)]);

	// Тимчасові коди — щоб обмін кодами між значеннями не впав на UNIQUE(id_attribute, code)
	if (keep.size) await conn.query(`UPDATE ${P}products_attribute_values SET code = CONCAT('~', id) WHERE id IN (?)`, [[...keep]]);

	const slugCfg = await settings.get("slug");
	const taken = new Set();
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		const primaryName = (v.names[primary] || {}).name;
		const code = uniqueIn(v.code || (await codeFromName(primaryName, true)), taken);
		taken.add(code);
		let id = v.id;
		if (id) {
			await conn.query(`UPDATE ${P}products_attribute_values SET code = ?, color_hex = ?, sort_order = ? WHERE id = ?`, [code, v.color_hex, i, id]);
		} else {
			const [r] = await conn.query(`INSERT INTO ${P}products_attribute_values (id_attribute, code, color_hex, sort_order) VALUES (?, ?, ?, ?)`, [idAttribute, code, v.color_hex, i]);
			id = r.insertId;
		}
		const names = {};
		for (const [lang, row] of Object.entries(v.names)) {
			names[lang] = row ? { name: row.name, slug: slug.slugify(row.name, slugCfg) || null } : null;
		}
		await saveNames(conn, "products_attribute_values_description", "id_attribute_value", id, names);
	}
}

async function saveAttribute(id, body) {
	const ids = await langIds();
	const primary = ids[0];
	const v = validateAttribute(body, ids);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);
	const d = v.data;
	const force = body && body.force === true;

	return tx(async (conn) => {
		if (d.id_attribute_group) {
			const [[g]] = await conn.query(`SELECT id FROM ${P}products_attribute_groups WHERE id = ?`, [d.id_attribute_group]);
			if (!g) throw httpErr(400, "Validation failed", [{ field: "id_attribute_group", message: "group not found" }]);
		}

		if (!d.code) {
			const base = await codeFromName((v.names[primary] || {}).name, false);
			const [rows] = await conn.query(`SELECT code FROM ${P}products_attributes WHERE (code = ? OR code LIKE ?) AND id <> ?`, [base, base + "\\_%", id || 0]);
			d.code = uniqueIn(base, new Set(rows.map((r) => r.code)));
		}

		const cols = ["code", "id_attribute_group", "type", "unit", "is_translatable", "is_filterable", "is_comparable", "is_visible_on_card", "is_variant_axis", "is_required", "sort_order"];
		const values = cols.map((c) => (typeof d[c] === "boolean" ? Number(d[c]) : d[c] ?? null));

		try {
			if (id) {
				const [[cur]] = await conn.query(`SELECT * FROM ${P}products_attributes WHERE id = ? FOR UPDATE`, [id]);
				if (!cur) throw httpErr(404, "Not found");
				await assertTypeChange(conn, cur, d);
				await conn.query(`UPDATE ${P}products_attributes SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...values, id]);
			} else {
				const [r] = await conn.query(`INSERT INTO ${P}products_attributes (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, values);
				id = r.insertId;
			}
		} catch (e) {
			if (e.code === "ER_DUP_ENTRY") throw httpErr(409, "Code already exists", [{ field: "code", message: "already exists" }]);
			throw e;
		}

		await saveNames(conn, "products_attributes_description", "id_attribute", id, v.names);
		// Для типів без довідника значень — усі значення прибираються (з тими самими перевірками)
		await syncValues(conn, id, VALUE_TYPES.includes(d.type) ? v.values : [], force, primary);
		return { id };
	});
}

async function removeAttribute(id, force) {
	return tx(async (conn) => {
		const [[cur]] = await conn.query(`SELECT id FROM ${P}products_attributes WHERE id = ? FOR UPDATE`, [id]);
		if (!cur) throw httpErr(404, "Not found");
		const u = await usage(conn, id);
		const [[vv]] = await conn.query(`SELECT COUNT(*) AS n FROM ${P}products_variant_values WHERE id_attribute = ?`, [id]);
		if (u.axes > 0 || Number(vv.n) > 0) throw httpErr(409, "Attribute is used in product variants");
		if (u.products > 0 && !force) throw httpErr(409, "Attribute is used in products", null, { code: "attribute_in_use", products: u.products });
		await conn.query(`DELETE FROM ${P}products_attributes WHERE id = ?`, [id]);
		return { ok: true };
	});
}

// ═══ НАБОРИ ════════════════════════════════════════════
async function listSets() {
	const { id_default_attribute_set } = await settings.get("card");
	const [rows] = await pool.query(
		`SELECT s.id, s.code, s.name, s.sort_order,
		        (SELECT COUNT(*) FROM ${P}products_attribute_sets_items i WHERE i.id_attribute_set = s.id) AS attributes,
		        (SELECT COUNT(*) FROM ${P}products p WHERE p.id_attribute_set = s.id AND p.deleted_at IS NULL) AS products
		   FROM ${P}products_attribute_sets s
		  ORDER BY s.sort_order, s.name`
	);
	return rows.map((r) => ({ ...r, is_default: r.id === id_default_attribute_set }));
}

async function getSet(id) {
	const [[row]] = await pool.query(`SELECT * FROM ${P}products_attribute_sets WHERE id = ?`, [id]);
	if (!row) throw httpErr(404, "Not found");
	const [items] = await pool.query(`SELECT id_attribute, is_required FROM ${P}products_attribute_sets_items WHERE id_attribute_set = ? ORDER BY sort_order`, [id]);
	return { ...row, items };
}

async function saveSet(id, body) {
	const v = validateSet(body);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);
	const d = v.data;
	return tx(async (conn) => {
		if (!d.code) {
			const base = await codeFromName(d.name, false);
			const [rows] = await conn.query(`SELECT code FROM ${P}products_attribute_sets WHERE (code = ? OR code LIKE ?) AND id <> ?`, [base, base + "\\_%", id || 0]);
			d.code = uniqueIn(base, new Set(rows.map((r) => r.code)));
		}
		if (d.items.length) {
			const [found] = await conn.query(`SELECT id FROM ${P}products_attributes WHERE id IN (?)`, [d.items.map((i) => i.id_attribute)]);
			if (found.length !== d.items.length) throw httpErr(400, "Validation failed", [{ field: "items", message: "unknown attribute" }]);
		}
		try {
			if (id) {
				const [r] = await conn.query(`UPDATE ${P}products_attribute_sets SET code = ?, name = ?, sort_order = ? WHERE id = ?`, [d.code, d.name, d.sort_order, id]);
				if (!r.affectedRows) throw httpErr(404, "Not found");
			} else {
				const [r] = await conn.query(`INSERT INTO ${P}products_attribute_sets (code, name, sort_order) VALUES (?, ?, ?)`, [d.code, d.name, d.sort_order]);
				id = r.insertId;
			}
		} catch (e) {
			if (e.code === "ER_DUP_ENTRY") throw httpErr(409, "Code already exists", [{ field: "code", message: "already exists" }]);
			throw e;
		}
		await conn.query(`DELETE FROM ${P}products_attribute_sets_items WHERE id_attribute_set = ?`, [id]);
		if (d.items.length) {
			await conn.query(
				`INSERT INTO ${P}products_attribute_sets_items (id_attribute_set, id_attribute, is_required, sort_order) VALUES ?`,
				[d.items.map((it, i) => [id, it.id_attribute, Number(it.is_required), i])]
			);
		}
		return { id };
	});
}

async function setDefaultSet(id, idUser) {
	if (id) {
		const [[s]] = await pool.query(`SELECT id FROM ${P}products_attribute_sets WHERE id = ?`, [id]);
		if (!s) throw httpErr(404, "Not found");
	}
	const card = await settings.get("card");
	await settings.save("card", { ...card, id_default_attribute_set: id || null }, idUser);
	return { ok: true };
}

async function removeSet(id, idUser) {
	const [r] = await pool.query(`DELETE FROM ${P}products_attribute_sets WHERE id = ?`, [id]);
	if (!r.affectedRows) throw httpErr(404, "Not found");
	const card = await settings.get("card");
	if (card.id_default_attribute_set === id) await settings.save("card", { ...card, id_default_attribute_set: null }, idUser);
	return { ok: true };
}

// ═══ ДОВІДНИК ДЛЯ КАРТОЧКИ ТОВАРУ ═════════════════════
/** Усі характеристики зі значеннями однією відповіддю (мова користувача → основна) */
async function dictionary(idLang) {
	const primary = await primaryLang(idLang);
	const [groups, attributes] = await Promise.all([listGroups(idLang), listAttributes(idLang)]);
	const [values] = await pool.query(
		`SELECT v.id, v.id_attribute, v.code, v.color_hex,
		        COALESCE(NULLIF(d.name, ''), dp.name, v.code) AS name
		   FROM ${P}products_attribute_values v
		   LEFT JOIN ${P}products_attribute_values_description d  ON d.id_attribute_value = v.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_attribute_values_description dp ON dp.id_attribute_value = v.id AND dp.id_lang = ?
		  ORDER BY v.id_attribute, v.sort_order, v.id`,
		[idLang, primary]
	);
	return { groups, attributes, values };
}

module.exports = {
	listGroups, getGroup, saveGroup, removeGroup,
	listAttributes, getAttribute, saveAttribute, removeAttribute,
	listSets, getSet, saveSet, setDefaultSet, removeSet,
	dictionary,
};