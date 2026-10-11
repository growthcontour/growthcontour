"use strict";

const fs = require("fs/promises");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const images = require("./images");
const descriptions = require("./descriptions");
const history = require("./history");
const { validateCategory, validateDescriptions } = require("../../../validator/catalog/products/catalog");

const P = config.get("configDatabase").prefix;
const TREE_LOCK = `${P}products_categories_tree`;
const IMAGE_FIELDS = ["image", "icon", "banner"];

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

/** Транзакція + named lock на дерево: усі зміни структури серіалізовані */
async function withTree(fn) {
	const conn = await pool.getConnection();
	let locked = false;
	try {
		const [[l]] = await conn.query("SELECT GET_LOCK(?, 10) AS ok", [TREE_LOCK]);
		if (l.ok !== 1) throw httpErr(503, "Category tree is busy, try again");
		locked = true;
		await conn.beginTransaction();
		const result = await fn(conn);
		await conn.commit();
		return result;
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		if (locked) await conn.query("SELECT RELEASE_LOCK(?)", [TREE_LOCK]).catch(() => {});
		conn.release();
	}
}

async function assertImagesExist(data) {
	for (const f of IMAGE_FIELDS) {
		if (!data[f]) continue;
		try {
			await fs.access(images.absPath("categories", data[f]));
		} catch {
			throw httpErr(400, "Validation failed", [{ field: f, message: "file not found, upload again" }]);
		}
	}
}

/** Плаский список для дерева; назва — мовою користувача, інакше основною мовою контенту */
async function tree(idLang) {
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const [rows] = await pool.query(
		`SELECT c.id, c.id_parent, c.status, c.show_in_menu, c.sort_order, c.image,
		        COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', c.id)) AS name,
		        (SELECT COUNT(*) FROM ${P}products_to_categories ptc WHERE ptc.id_category = c.id) AS products
		   FROM ${P}products_categories c
		   LEFT JOIN ${P}products_categories_description d  ON d.id_category = c.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_categories_description dp ON dp.id_category = c.id AND dp.id_lang = ?
		  ORDER BY c.id_parent IS NOT NULL, c.id_parent, c.sort_order, c.id`,
		[idLang, primary]
	);
	return rows.map((r) => ({ ...r, image_url: images.url("categories", r.image, "small") }));
}

async function get(id) {
	const [[row]] = await pool.query(`SELECT * FROM ${P}products_categories WHERE id = ?`, [id]);
	if (!row) throw httpErr(404, "Not found");
	const out = { ...row, descriptions: await descriptions.load("categories", id) };
	for (const f of IMAGE_FIELDS) out[f + "_url"] = images.url("categories", row[f], "medium");
	return out;
}

async function insertPaths(conn, id, idParent) {
	await conn.query(
		`INSERT INTO ${P}products_categories_path (id_category, id_ancestor, depth)
		 SELECT ?, id_ancestor, depth + 1 FROM ${P}products_categories_path WHERE id_category = ?
		 UNION ALL SELECT ?, ?, 0`,
		[id, idParent || 0, id, id]
	);
}

/** Перенести піддерево id під newParent (closure table) */
async function movePaths(conn, id, newParent) {
	if (newParent) {
		const [[cycle]] = await conn.query(`SELECT 1 AS x FROM ${P}products_categories_path WHERE id_category = ? AND id_ancestor = ?`, [newParent, id]);
		if (cycle) throw httpErr(409, "Cannot move a category into itself or its descendant", [{ field: "id_parent", message: "cycle" }]);
	}
	// Від'єднати піддерево від старих предків
	await conn.query(
		`DELETE a FROM ${P}products_categories_path a
		   JOIN ${P}products_categories_path d ON a.id_category = d.id_category
		   LEFT JOIN ${P}products_categories_path x ON x.id_ancestor = d.id_ancestor AND x.id_category = a.id_ancestor
		  WHERE d.id_ancestor = ? AND x.id_ancestor IS NULL`,
		[id]
	);
	// Приєднати до нових
	if (newParent) {
		await conn.query(
			`INSERT INTO ${P}products_categories_path (id_category, id_ancestor, depth)
			 SELECT sub.id_category, sup.id_ancestor, sup.depth + sub.depth + 1
			   FROM ${P}products_categories_path sup
			   JOIN ${P}products_categories_path sub
			  WHERE sup.id_category = ? AND sub.id_ancestor = ?`,
			[newParent, id]
		);
	}
}

async function assertParent(conn, idParent) {
	if (!idParent) return;
	const [[p]] = await conn.query(`SELECT id FROM ${P}products_categories WHERE id = ?`, [idParent]);
	if (!p) throw httpErr(400, "Validation failed", [{ field: "id_parent", message: "parent not found" }]);
}

async function save(id, body, ctx = {}) {
	const isNew = !id;
	const v = validateCategory(body);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);
	const d = v.data;

	const langs = await descriptions.contentLanguages();
	const dv = validateDescriptions("categories", body.descriptions, langs.map((l) => l.id));
	if (!dv.valid) throw httpErr(400, "Validation failed", dv.errors);
	await assertImagesExist(d);

	const cols = ["id_parent", "image", "icon", "banner", "status", "show_in_menu", "menu_columns", "is_filterable", "default_sort", "layout_template", "sort_order", "robots_index", "robots_follow"];
	const values = cols.map((c) => (typeof d[c] === "boolean" ? Number(d[c]) : d[c] ?? null));

	let oldImages = [];
	let changes = [];
	const result = await withTree(async (conn) => {
		await assertParent(conn, d.id_parent);
		if (id) {
			const [[cur]] = await conn.query(`SELECT * FROM ${P}products_categories WHERE id = ? FOR UPDATE`, [id]);
			if (!cur) throw httpErr(404, "Not found");
			var beforeRow = cur;
			var beforeDesc = await descriptions.load("categories", id, conn);
			if (d.id_parent === id) throw httpErr(409, "Category cannot be its own parent", [{ field: "id_parent", message: "cycle" }]);
			if ((cur.id_parent || null) !== (d.id_parent || null)) await movePaths(conn, id, d.id_parent);
			await conn.query(`UPDATE ${P}products_categories SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...values, id]);
			oldImages = IMAGE_FIELDS.map((f) => cur[f]).filter((f, i) => f && f !== d[IMAGE_FIELDS[i]]);
		} else {
			const [r] = await conn.query(`INSERT INTO ${P}products_categories (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, values);
			id = r.insertId;
			await insertPaths(conn, id, d.id_parent);
		}
		const slugShared = body.slug_shared === true || body.slug_shared === 1 || body.slug_shared === "1";
		await descriptions.save(conn, "categories", id, dv.data, { sharedSlug: slugShared, primaryLang: langs[0] && langs[0].id });
		await conn.query(`UPDATE ${P}products_categories SET slug_shared = ? WHERE id = ?`, [slugShared ? 1 : 0, id]);
		if (typeof beforeRow !== "undefined" && beforeRow) {
			const [[afterRow]] = await conn.query(`SELECT * FROM ${P}products_categories WHERE id = ?`, [id]);
			changes = [...history.rowChanges(beforeRow, afterRow), ...history.descChanges(beforeDesc, await descriptions.load("categories", id, conn))];
		}
		return { id };
	});

	// Файли чистимо після коміту: відкат транзакції не повинен лишити запис без картинки
	await Promise.all(oldImages.map((f) => images.removeIfUnused("categories", f).catch(() => {})));
	await history.record("categories", result.id, { user: ctx.idUser, source: "card", action: isNew ? "create" : "update", changes });
	return result;
}

/** Drag & drop: новий батько + повний порядок сусідів */
async function move(id, idParent, orderedIds) {
	const siblings = (Array.isArray(orderedIds) ? orderedIds : []).map((x) => parseInt(x, 10)).filter((x) => x > 0);
	if (!siblings.includes(id)) throw httpErr(400, "Invalid order");
	return withTree(async (conn) => {
		const [[cur]] = await conn.query(`SELECT id, id_parent FROM ${P}products_categories WHERE id = ? FOR UPDATE`, [id]);
		if (!cur) throw httpErr(404, "Not found");
		await assertParent(conn, idParent);
		if (idParent === id) throw httpErr(409, "Category cannot be its own parent");
		if ((cur.id_parent || null) !== (idParent || null)) {
			await movePaths(conn, id, idParent);
			await conn.query(`UPDATE ${P}products_categories SET id_parent = ? WHERE id = ?`, [idParent || null, id]);
		}
		// Порядок — лише для реальних дітей цього батька (чужі id ігноруються)
		const [kids] = await conn.query(`SELECT id FROM ${P}products_categories WHERE id_parent <=> ?`, [idParent || null]);
		const allowed = new Set(kids.map((k) => k.id));
		let pos = 0;
		for (const sid of siblings) {
			if (allowed.has(sid)) await conn.query(`UPDATE ${P}products_categories SET sort_order = ? WHERE id = ?`, [pos++, sid]);
		}
		return { ok: true };
	});
}

async function remove(id) {
	let files = [];
	await withTree(async (conn) => {
		const [[cur]] = await conn.query(`SELECT * FROM ${P}products_categories WHERE id = ? FOR UPDATE`, [id]);
		if (!cur) throw httpErr(404, "Not found");
		const [[kids]] = await conn.query(`SELECT COUNT(*) AS n FROM ${P}products_categories WHERE id_parent = ?`, [id]);
		if (Number(kids.n) > 0) throw httpErr(409, "Category has subcategories — move or delete them first");
		// path, описи, зв'язки з товарами — каскадом; products.id_category_main → NULL
		await conn.query(`DELETE FROM ${P}products_categories WHERE id = ?`, [id]);
		files = IMAGE_FIELDS.map((f) => cur[f]).filter(Boolean);
	});
	await Promise.all(files.map((f) => images.removeIfUnused("categories", f).catch(() => {})));
	return { ok: true };
}

module.exports = { tree, get, save, move, remove };