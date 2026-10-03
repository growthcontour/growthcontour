"use strict";

const fs = require("fs/promises");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const images = require("./images");
const descriptions = require("./descriptions");
const { validateBrand, validateDescriptions } = require("../../../validator/catalog/products/catalog");

const P = config.get("configDatabase").prefix;

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

const SORTABLE = { id: "b.id", name: "name", code: "b.code", country: "b.country", sort_order: "b.sort_order", status: "b.status", products: "products" };

async function list(q, idLang) {
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const size = Math.min(Math.max(parseInt(q.size, 10) || 50, 1), 200);
	const page = Math.max(parseInt(q.page, 10) || 1, 1);
	const where = ["b.deleted_at IS NULL"];
	const params = [];

	const search = String(q.search || "").trim();
	if (search) {
		const like = "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
		where.push(`(b.code LIKE ? OR EXISTS (SELECT 1 FROM ${P}products_brands_description x WHERE x.id_brand = b.id AND x.name LIKE ?))`);
		params.push(like, like);
	}
	if (q.status === "0" || q.status === "1") {
		where.push("b.status = ?");
		params.push(Number(q.status));
	}
	const sort = Array.isArray(q.sort) && q.sort[0] ? q.sort[0] : {};
	const orderCol = SORTABLE[sort.field] || "b.sort_order";
	const orderDir = sort.dir === "desc" ? "DESC" : "ASC";

	const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${P}products_brands b WHERE ${where.join(" AND ")}`, params);
	const [rows] = await pool.query(
		`SELECT b.id, b.code, b.logo, b.website, b.country, b.status, b.sort_order,
		        COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', b.id)) AS name,
		        (SELECT COUNT(*) FROM ${P}products p WHERE p.id_brand = b.id AND p.deleted_at IS NULL) AS products
		   FROM ${P}products_brands b
		   LEFT JOIN ${P}products_brands_description d  ON d.id_brand = b.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_brands_description dp ON dp.id_brand = b.id AND dp.id_lang = ?
		  WHERE ${where.join(" AND ")}
		  ORDER BY ${orderCol} ${orderDir}, b.id ${orderDir}
		  LIMIT ? OFFSET ?`,
		[idLang, primary, ...params, size, (page - 1) * size]
	);
	return {
		last_page: Math.max(Math.ceil(total / size), 1),
		last_row: total,
		data: rows.map((r) => ({ ...r, logo_url: images.url("brands", r.logo, "small") })),
	};
}

/** Для select-ів у карточці товару */
async function options(search, idLang) {
	const like = "%" + String(search || "").replace(/[\\%_]/g, "\\$&") + "%";
	const [rows] = await pool.query(
		`SELECT b.id, b.code, COALESCE(NULLIF(d.name, ''), MIN(x.name)) AS name
		   FROM ${P}products_brands b
		   JOIN ${P}products_brands_description x ON x.id_brand = b.id
		   LEFT JOIN ${P}products_brands_description d ON d.id_brand = b.id AND d.id_lang = ?
		  WHERE b.deleted_at IS NULL AND b.status = 1 AND (x.name LIKE ? OR b.code LIKE ?)
		  GROUP BY b.id, b.code, d.name
		  ORDER BY name LIMIT 50`,
		[idLang, like, like]
	);
	return rows;
}

async function get(id) {
	const [[row]] = await pool.query(`SELECT * FROM ${P}products_brands WHERE id = ? AND deleted_at IS NULL`, [id]);
	if (!row) throw httpErr(404, "Not found");
	return { ...row, logo_url: images.url("brands", row.logo, "medium"), descriptions: await descriptions.load("brands", id) };
}

async function save(id, body) {
	const v = validateBrand(body);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);
	const d = v.data;
	if (d.code) d.code = d.code.toUpperCase();

	const langs = await descriptions.contentLanguages();
	const dv = validateDescriptions("brands", body.descriptions, langs.map((l) => l.id));
	if (!dv.valid) throw httpErr(400, "Validation failed", dv.errors);

	if (d.logo) {
		try {
			await fs.access(images.absPath("brands", d.logo));
		} catch {
			throw httpErr(400, "Validation failed", [{ field: "logo", message: "file not found, upload again" }]);
		}
	}

	const cols = ["code", "logo", "website", "country", "status", "sort_order"];
	const values = cols.map((c) => (typeof d[c] === "boolean" ? Number(d[c]) : d[c] ?? null));
	const conn = await pool.getConnection();
	let oldLogo = null;
	try {
		await conn.beginTransaction();
		if (id) {
			const [[cur]] = await conn.query(`SELECT logo FROM ${P}products_brands WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [id]);
			if (!cur) throw httpErr(404, "Not found");
			await conn.query(`UPDATE ${P}products_brands SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...values, id]);
			if (cur.logo && cur.logo !== d.logo) oldLogo = cur.logo;
		} else {
			const [r] = await conn.query(`INSERT INTO ${P}products_brands (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, values);
			id = r.insertId;
		}
		const slugShared = body.slug_shared === true || body.slug_shared === 1 || body.slug_shared === "1";
		await descriptions.save(conn, "brands", id, dv.data, { sharedSlug: slugShared, primaryLang: langs[0] && langs[0].id });
		await conn.query(`UPDATE ${P}products_brands SET slug_shared = ? WHERE id = ?`, [slugShared ? 1 : 0, id]);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		if (e.code === "ER_DUP_ENTRY" && /uq_code/.test(e.message)) throw httpErr(409, "Code already exists", [{ field: "code", message: "already exists" }]);
		throw e;
	} finally {
		conn.release();
	}
	if (oldLogo) await images.removeIfUnused("brands", oldLogo).catch(() => {});
	return { id };
}

module.exports = { list, options, get, save };