"use strict";

const fs = require("fs/promises");
const crypto = require("crypto");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("./settings");
const descriptions = require("./descriptions");
const images = require("./images");
const sku = require("./sku");
const ean = require("./ean");
const stock = require("./stock");
const editLock = require("./edit-lock");
const { copyProduct } = require("./copy");
const productOptions = require("./product-options");
const { validateProductOptions } = require("../../../validator/catalog/products/options");
const { validateCore, validateParts } = require("../../../validator/catalog/products/products");
const { validateDescriptions } = require("../../../validator/catalog/products/catalog");

const P = config.get("configDatabase").prefix;
const COST_FIELDS = ["cost_price", "wholesale_price"];

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

const likeOf = (s) => "%" + String(s).replace(/[\\%_]/g, "\\$&") + "%";

// ═══ СПИСОК ════════════════════════════════════════════
const SORTABLE = { id: "p.id", name: "name", sku: "p.sku", price: "p.price", qty: "qty", status: "p.status", date_add: "p.date_add", date_edit: "p.date_edit", sort_order: "p.sort_order" };

async function list(q, idLang, perms) {
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const size = Math.min(Math.max(parseInt(q.size, 10) || 50, 1), 500);
	const page = Math.max(parseInt(q.page, 10) || 1, 1);
	const where = ["p.deleted_at IS NULL"];
	const params = [];

	const search = String(q.search || "").trim();
	if (search) {
		where.push(`(p.sku LIKE ? OR p.ean = ? OR p.model LIKE ? OR p.mpn LIKE ? OR p.id = ?
		            OR EXISTS (SELECT 1 FROM ${P}products_description sd WHERE sd.id_product = p.id AND sd.name LIKE ?)
		            OR EXISTS (SELECT 1 FROM ${P}products_variants sv WHERE sv.id_product = p.id AND (sv.sku LIKE ? OR sv.ean = ?)))`);
		params.push(likeOf(search), search, likeOf(search), likeOf(search), parseInt(search, 10) || 0, likeOf(search), likeOf(search), search);
	}
	if (["draft", "active", "archived"].includes(q.status)) {
		where.push("p.status = ?");
		params.push(q.status);
	}
	if (["simple", "variable", "bundle", "digital", "service", "gift_card"].includes(q.type)) {
		where.push("p.type = ?");
		params.push(q.type);
	}
	if (parseInt(q.id_brand, 10) > 0) {
		where.push("p.id_brand = ?");
		params.push(parseInt(q.id_brand, 10));
	}
	if (parseInt(q.id_category, 10) > 0) {
		// Категорія разом із усіма підкатегоріями (closure table)
		where.push(`EXISTS (SELECT 1 FROM ${P}products_to_categories ptc
		                     JOIN ${P}products_categories_path cp ON cp.id_category = ptc.id_category
		                    WHERE ptc.id_product = p.id AND cp.id_ancestor = ?)`);
		params.push(parseInt(q.id_category, 10));
	}
	if (q.stock === "in") where.push("COALESCE(st.qty, 0) > 0");
	if (q.stock === "out") where.push("COALESCE(st.qty, 0) <= 0");
	if (q.stock === "low") where.push("p.low_stock_threshold IS NOT NULL AND COALESCE(st.qty, 0) <= p.low_stock_threshold");
	if (q.price_from !== undefined && q.price_from !== "" && !isNaN(q.price_from)) {
		where.push("p.price >= ?");
		params.push(Number(q.price_from));
	}
	if (q.price_to !== undefined && q.price_to !== "" && !isNaN(q.price_to)) {
		where.push("p.price <= ?");
		params.push(Number(q.price_to));
	}

	const sort = Array.isArray(q.sort) && q.sort[0] ? q.sort[0] : {};
	const orderCol = SORTABLE[sort.field] || "p.date_edit";
	const orderDir = sort.dir === "asc" ? "ASC" : "DESC";

	// Доступний залишок лише по активних складах, відкритих для продажу
	const stockJoin = `LEFT JOIN (
		SELECT s.id_product, SUM(s.available) AS qty
		  FROM ${P}products_stock s
		  JOIN ${P}products_warehouses w ON w.id = s.id_warehouse AND w.deleted_at IS NULL AND w.status = 1 AND w.is_sellable = 1
		 GROUP BY s.id_product
	) st ON st.id_product = p.id`;

	const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${P}products p ${stockJoin} WHERE ${where.join(" AND ")}`, params);
	const [rows] = await pool.query(
		`SELECT p.id, p.type, p.status, p.sku, p.price, p.compare_at_price, ${perms.cost ? "p.cost_price," : ""} p.track_inventory, p.date_add, p.date_edit,
		        COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', p.id)) AS name,
		        COALESCE(st.qty, 0) AS qty,
		        (SELECT m.file FROM ${P}products_media m WHERE m.id_product = p.id AND m.type = 'image' ORDER BY m.is_cover DESC, m.sort_order, m.id LIMIT 1) AS image,
		        (SELECT COALESCE(NULLIF(cd.name, ''), cdp.name) FROM ${P}products_categories_description cdp
		           LEFT JOIN ${P}products_categories_description cd ON cd.id_category = cdp.id_category AND cd.id_lang = ?
		          WHERE cdp.id_category = p.id_category_main AND cdp.id_lang = ?) AS category,
		        (SELECT COALESCE(NULLIF(bd.name, ''), bdp.name) FROM ${P}products_brands_description bdp
		           LEFT JOIN ${P}products_brands_description bd ON bd.id_brand = bdp.id_brand AND bd.id_lang = ?
		          WHERE bdp.id_brand = p.id_brand AND bdp.id_lang = ?) AS brand,
		        (SELECT NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') FROM ${P}products_edit_locks l
		           JOIN ${P}users u ON u.id = l.id_user
		          WHERE l.id_product = p.id AND l.expires_at > NOW(3)) AS locked_by
		   FROM ${P}products p
		   LEFT JOIN ${P}products_description d  ON d.id_product = p.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_description dp ON dp.id_product = p.id AND dp.id_lang = ?
		   ${stockJoin}
		  WHERE ${where.join(" AND ")}
		  ORDER BY ${orderCol} ${orderDir}, p.id ${orderDir}
		  LIMIT ? OFFSET ?`,
		[idLang, primary, idLang, primary, idLang, primary, ...params, size, (page - 1) * size]
	);
	return {
		last_page: Math.max(Math.ceil(total / size), 1),
		last_row: total,
		data: rows.map((r) => ({ ...r, image_url: images.url("products", r.image, "small") })),
	};
}

/** Короткий пошук для пов'язаних товарів, комплектів тощо */
async function search(term, idLang, excludeId) {
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const t = String(term || "").trim();
	if (!t) return [];
	const [rows] = await pool.query(
		`SELECT p.id, p.sku, p.price, p.status, COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', p.id)) AS name
		   FROM ${P}products p
		   LEFT JOIN ${P}products_description d  ON d.id_product = p.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_description dp ON dp.id_product = p.id AND dp.id_lang = ?
		  WHERE p.deleted_at IS NULL AND p.id <> ?
		    AND (p.sku LIKE ? OR p.ean = ? OR p.id = ? OR EXISTS (SELECT 1 FROM ${P}products_description x WHERE x.id_product = p.id AND x.name LIKE ?))
		  ORDER BY name LIMIT 30`,
		[idLang, primary, excludeId || 0, likeOf(t), t, parseInt(t, 10) || 0, likeOf(t)]
	);
	return rows;
}

// ═══ ЧИТАННЯ ═══════════════════════════════════════════
async function get(id, idLang, perms) {
	const [[row]] = await pool.query(`SELECT * FROM ${P}products WHERE id = ? AND deleted_at IS NULL`, [id]);
	if (!row) throw httpErr(404, "Not found");
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;

	const [[categories], [media], [mediaAlt], [attrs], [attrText], [stockRows], [prices], [rewards], [related], [suppliers]] = await Promise.all([
		pool.query(`SELECT id_category FROM ${P}products_to_categories WHERE id_product = ?`, [id]),
		pool.query(`SELECT id, type, file, url, width, height, size, is_cover, sort_order FROM ${P}products_media WHERE id_product = ? ORDER BY sort_order, id`, [id]),
		pool.query(`SELECT md.id_media, md.id_lang, md.alt FROM ${P}products_media_description md JOIN ${P}products_media m ON m.id = md.id_media WHERE m.id_product = ?`, [id]),
		pool.query(`SELECT id_attribute, id_attribute_value, value_number, value_date FROM ${P}products_to_attributes WHERE id_product = ? ORDER BY sort_order, id`, [id]),
		pool.query(`SELECT id_attribute, id_lang, value FROM ${P}products_to_attributes_text WHERE id_product = ?`, [id]),
		pool.query(
			`SELECT w.id AS id_warehouse, w.code, w.name, w.is_sellable, w.status,
			        COALESCE(s.on_hand, 0) AS on_hand, COALESCE(s.reserved, 0) AS reserved, COALESCE(s.incoming, 0) AS incoming,
			        COALESCE(s.available, 0) AS available, s.id_location, s.reorder_point, s.reorder_qty
			   FROM ${P}products_warehouses w
			   LEFT JOIN ${P}products_stock s ON s.id_warehouse = w.id AND s.id_product = ? AND s.id_variant = 0
			  WHERE w.deleted_at IS NULL AND (w.status = 1 OR s.id IS NOT NULL)
			  ORDER BY w.priority, w.sort_order, w.id`,
			[id]
		),
		pool.query(`SELECT kind, id_customer_group, min_qty, reduction_type, value, priority, date_start, date_end FROM ${P}products_prices WHERE id_product = ? AND id_variant = 0 ORDER BY kind, min_qty, id`, [id]),
		pool.query(`SELECT id_customer_group, points FROM ${P}products_rewards WHERE id_product = ? AND id_variant = 0`, [id]),
		pool.query(
			`SELECT r.id_related, r.type, p.sku, COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', p.id)) AS name
			   FROM ${P}products_related r
			   JOIN ${P}products p ON p.id = r.id_related
			   LEFT JOIN ${P}products_description d  ON d.id_product = p.id AND d.id_lang = ?
			   LEFT JOIN ${P}products_description dp ON dp.id_product = p.id AND dp.id_lang = ?
			  WHERE r.id_product = ? ORDER BY r.type, r.sort_order`,
			[idLang, primary, id]
		),
		pool.query(
			`SELECT ts.id_supplier, s.name, ts.supplier_sku, ts.supplier_price, ts.currency, ts.lead_time_days, ts.min_order_qty, ts.is_default
			   FROM ${P}products_to_suppliers ts JOIN ${P}products_suppliers s ON s.id = ts.id_supplier
			  WHERE ts.id_product = ? AND ts.id_variant = 0`,
			[id]
		),
	]);

	const altBy = {};
	mediaAlt.forEach((a) => ((altBy[a.id_media] = altBy[a.id_media] || {})[a.id_lang] = a.alt));
	const attributes = {};
	attrs.forEach((a) => {
		const x = (attributes[a.id_attribute] = attributes[a.id_attribute] || { id_attribute: a.id_attribute, value_ids: [], number: null, date: null, text: {} });
		if (a.id_attribute_value) x.value_ids.push(a.id_attribute_value);
		if (a.value_number !== null) x.number = Number(a.value_number);
		if (a.value_date) x.date = a.value_date;
	});
	attrText.forEach((t) => ((attributes[t.id_attribute] = attributes[t.id_attribute] || { id_attribute: t.id_attribute, value_ids: [], number: null, date: null, text: {} }).text[t.id_lang] = t.value));

	const out = {
		...row,
		descriptions: await descriptions.load("products", id),
		categories: categories.map((c) => c.id_category),
		media: media.map((m) => ({ ...m, alt: altBy[m.id] || {}, url_medium: images.url("products", m.file, "medium"), url_large: images.url("products", m.file, "large") })),
		attributes: Object.values(attributes),
		stock: stockRows,
		prices,
		rewards,
		related,
		suppliers,
		lock: editLock.publicHolder(await editLock.holder(id)),
		...(await productOptions.load(id)),
	};
	if (!perms.cost) {
		COST_FIELDS.forEach((f) => delete out[f]);
		out.suppliers = out.suppliers.map(({ supplier_price, ...rest }) => rest);
	}
	return out;
}

// ═══ ЗБЕРЕЖЕННЯ ════════════════════════════════════════
async function assertExists(conn, table, idValue, field, extraWhere = "") {
	if (!idValue) return;
	const [[r]] = await conn.query(`SELECT id FROM ${P}${table} WHERE id = ? ${extraWhere}`, [idValue]);
	if (!r) throw httpErr(400, "Validation failed", [{ field, message: "not found" }]);
}

async function checkRequired(core, parts, descs, primary) {
	const { required_fields } = await settings.get("card");
	const errors = [];
	const has = {
		name: !!(descs[primary] && descs[primary].name),
		sku: !!core.sku || (await settings.get("sku")).auto,
		price: core.price > 0 || core.price_on_request,
		category: parts.categories.length > 0,
		brand: !!core.id_brand,
		image: parts.media.length > 0,
		description: !!(descs[primary] && descs[primary].description),
	};
	for (const f of required_fields) {
		if (has[f] === false) errors.push({ field: f === "name" || f === "description" ? `descriptions.${primary}.${f}` : f === "category" ? "categories" : f === "image" ? "media" : f, message: "required" });
	}
	return errors;
}

async function syncMedia(conn, id, media, langIds) {
	const [existing] = await conn.query(`SELECT id, file FROM ${P}products_media WHERE id_product = ?`, [id]);
	const existingById = new Map(existing.map((m) => [m.id, m]));
	for (const m of media) if (m.id && !existingById.has(m.id)) throw httpErr(400, "Validation failed", [{ field: "media", message: "invalid media id" }]);

	const keep = new Set(media.filter((m) => m.id).map((m) => m.id));
	const removed = existing.filter((m) => !keep.has(m.id));
	if (removed.length) await conn.query(`DELETE FROM ${P}products_media WHERE id IN (?)`, [removed.map((m) => m.id)]);

	for (let i = 0; i < media.length; i++) {
		const m = media[i];
		let mediaId = m.id;
		if (mediaId) {
			await conn.query(`UPDATE ${P}products_media SET is_cover = ?, sort_order = ? WHERE id = ?`, [Number(m.is_cover), i, mediaId]);
		} else {
			try {
				await fs.access(images.absPath("products", m.file));
			} catch {
				throw httpErr(400, "Validation failed", [{ field: `media.${i}`, message: "file not found, upload again" }]);
			}
			const hash = m.file.split("/")[1].split(".")[0];
			const [r] = await conn.query(
				`INSERT INTO ${P}products_media (id_product, type, file, hash, mime, is_cover, sort_order) VALUES (?, 'image', ?, ?, ?, ?, ?)`,
				[id, m.file, hash, "image/" + (m.file.endsWith(".jpg") ? "jpeg" : m.file.split(".").pop()), Number(m.is_cover), i]
			);
			mediaId = r.insertId;
		}
		for (const lang of langIds) {
			const alt = m.alt && m.alt[lang] ? String(m.alt[lang]).trim().slice(0, 255) : null;
			if (alt) {
				await conn.query(
					`INSERT INTO ${P}products_media_description (id_media, id_lang, alt) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE alt = ?`,
					[mediaId, lang, alt, alt]
				);
			} else {
				await conn.query(`DELETE FROM ${P}products_media_description WHERE id_media = ? AND id_lang = ?`, [mediaId, lang]);
			}
		}
	}
	// Файли видаляються після коміту і лише якщо ними більше ніхто не користується
	return removed.map((m) => m.file).filter((f) => !media.some((x) => x.file === f));
}

async function saveAttributes(conn, id, attributes, langIds) {
	await conn.query(`DELETE FROM ${P}products_to_attributes WHERE id_product = ?`, [id]);
	await conn.query(`DELETE FROM ${P}products_to_attributes_text WHERE id_product = ?`, [id]);
	if (!attributes.length) return;

	const [defs] = await conn.query(`SELECT id, type, is_translatable FROM ${P}products_attributes WHERE id IN (?)`, [attributes.map((a) => a.id_attribute)]);
	const defById = new Map(defs.map((d) => [d.id, d]));
	const valueIds = attributes.flatMap((a) => a.value_ids);
	const valueOwner = new Map();
	if (valueIds.length) {
		const [vals] = await conn.query(`SELECT id, id_attribute FROM ${P}products_attribute_values WHERE id IN (?)`, [valueIds]);
		vals.forEach((v) => valueOwner.set(v.id, v.id_attribute));
	}

	let order = 0;
	for (const [i, a] of attributes.entries()) {
		const def = defById.get(a.id_attribute);
		const f = `attributes.${i}`;
		if (!def) throw httpErr(400, "Validation failed", [{ field: f, message: "attribute not found" }]);

		if (["select", "multiselect", "color"].includes(def.type)) {
			if (!a.value_ids.length) continue;
			if (def.type !== "multiselect" && a.value_ids.length > 1) throw httpErr(400, "Validation failed", [{ field: f, message: "only one value allowed" }]);
			for (const vid of a.value_ids) {
				if (valueOwner.get(vid) !== a.id_attribute) throw httpErr(400, "Validation failed", [{ field: f, message: "value does not belong to attribute" }]);
				await conn.query(`INSERT INTO ${P}products_to_attributes (id_product, id_attribute, id_attribute_value, sort_order) VALUES (?, ?, ?, ?)`, [id, a.id_attribute, vid, order++]);
			}
		} else if (def.type === "integer" || def.type === "decimal" || def.type === "boolean") {
			if (a.number === null) continue;
			if (def.type === "integer" && !Number.isInteger(a.number)) throw httpErr(400, "Validation failed", [{ field: f, message: "must be integer" }]);
			const num = def.type === "boolean" ? (a.number ? 1 : 0) : a.number;
			await conn.query(`INSERT INTO ${P}products_to_attributes (id_product, id_attribute, value_number, sort_order) VALUES (?, ?, ?, ?)`, [id, a.id_attribute, num, order++]);
		} else if (def.type === "date") {
			if (!a.date) continue;
			await conn.query(`INSERT INTO ${P}products_to_attributes (id_product, id_attribute, value_date, sort_order) VALUES (?, ?, ?, ?)`, [id, a.id_attribute, a.date, order++]);
		} else {
			// text / textarea: перекладне значення — на кожну мову, інакше один запис з id_lang = 0
			const langs = Number(def.is_translatable) ? langIds : [0];
			for (const lang of langs) {
				const v = a.text && a.text[lang] != null ? String(a.text[lang]).trim() : "";
				if (!v) continue;
				if (v.length > 65535) throw httpErr(400, "Validation failed", [{ field: f, message: "too long" }]);
				await conn.query(`INSERT INTO ${P}products_to_attributes_text (id_product, id_attribute, id_lang, value) VALUES (?, ?, ?, ?)`, [id, a.id_attribute, lang, v]);
			}
		}
	}
}

/**
 * Зберегти товар.
 * ctx: { idUser, perms: { cost, stock }, lockToken, version }
 * Повертає { id, version, changed, removedFiles }.
 */
async function save(id, body, ctx) {
	const langIds = (await descriptions.contentLanguages()).map((l) => l.id);
	const primary = langIds[0];

	const vc = validateCore(body.data);
	const vp = validateParts(body);
	const vd = validateDescriptions("products", body.descriptions, langIds);
	const vo = validateProductOptions(body, langIds);
	const errors = [...(vc.valid ? [] : vc.errors), ...(vp.valid ? [] : vp.errors), ...(vd.valid ? [] : vd.errors), ...(vo.valid ? [] : vo.errors)];
	if (errors.length) throw httpErr(400, "Validation failed", errors);
	const core = vc.data;
	const parts = vp.data;

	const reqErrors = await checkRequired(core, parts, vd.data, primary);
	if (reqErrors.length) throw httpErr(400, "Validation failed", reqErrors);

	let removedFiles = [];
	const result = await tx(async (conn) => {
		let before = null;
		if (id) {
			[[before]] = await conn.query(`SELECT * FROM ${P}products WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [id]);
			if (!before) throw httpErr(404, "Not found");
			await editLock.assertHeld(conn, id, ctx.lockToken, ctx.idUser);
			if (Number(ctx.version) !== Number(before.version)) {
				throw httpErr(409, "Product was changed by someone else", null, { code: "version_conflict", version: before.version });
			}
			const [[{ variantsCount }]] = await conn.query(`SELECT COUNT(*) AS variantsCount FROM ${P}products_variants WHERE id_product = ?`, [id]);
			if (Number(variantsCount) > 0 && core.type !== "variable") {
				throw httpErr(409, "Product has variants", [{ field: "type", message: "delete variants before changing type" }]);
			}
			const [[{ bundleItems }]] = await conn.query(`SELECT COUNT(*) AS bundleItems FROM ${P}products_bundle_items WHERE id_bundle = ?`, [id]);
			if (Number(bundleItems) > 0 && core.type !== "bundle") {
				throw httpErr(409, "Bundle has components", [{ field: "type", message: "remove bundle components before changing type" }]);
			}
		}

		// Без права на собівартість — зберігаємо старі значення, а не затираємо
		if (!ctx.perms.cost) COST_FIELDS.forEach((f) => (core[f] = before ? before[f] : null));

		await assertExists(conn, "products_brands", core.id_brand, "id_brand", "AND deleted_at IS NULL");
		await assertExists(conn, "products_suppliers", core.id_supplier, "id_supplier", "AND deleted_at IS NULL");
		await assertExists(conn, "products_attribute_sets", core.id_attribute_set, "id_attribute_set");
		await assertExists(conn, "products_tax_classes", core.id_tax_class, "id_tax_class");
		await assertExists(conn, "products_stock_statuses", core.id_stock_status, "id_stock_status");
		if (core.redirect_type.endsWith("_category")) await assertExists(conn, "products_categories", core.redirect_target_id, "redirect_target_id");
		if (core.redirect_type.endsWith("_product")) {
			if (core.redirect_target_id === id) throw httpErr(400, "Validation failed", [{ field: "redirect_target_id", message: "cannot redirect to itself" }]);
			await assertExists(conn, "products", core.redirect_target_id, "redirect_target_id", "AND deleted_at IS NULL");
		}

		if (parts.categories.length) {
			const [cats] = await conn.query(`SELECT id FROM ${P}products_categories WHERE id IN (?)`, [parts.categories]);
			if (cats.length !== parts.categories.length) throw httpErr(400, "Validation failed", [{ field: "categories", message: "category not found" }]);
		}
		if (core.id_category_main && !parts.categories.includes(core.id_category_main)) parts.categories.push(core.id_category_main);
		if (!core.id_category_main && parts.categories.length) core.id_category_main = parts.categories[0];

		if (core.ean && !ean.isValid(core.ean)) throw httpErr(400, "Validation failed", [{ field: "ean", message: "invalid check digit" }]);
		if (core.sku && !(await sku.isFree(core.sku, { excludeProductId: id || 0 }, conn))) throw httpErr(409, "SKU already exists", [{ field: "sku", message: "already exists" }]);

		// ── Ядро ────────────────────────────────────────
		const cols = Object.keys(core);
		const values = cols.map((c) => (typeof core[c] === "boolean" ? Number(core[c]) : core[c]));
		if (id) {
			await conn.query(`UPDATE ${P}products SET ${cols.map((c) => `${c} = ?`).join(", ")}, version = version + 1, id_user_edit = ? WHERE id = ?`, [...values, ctx.idUser, id]);
		} else {
			const [r] = await conn.query(
				`INSERT INTO ${P}products (uuid, ${cols.join(", ")}, id_user_add, id_user_edit) VALUES (?, ${cols.map(() => "?").join(", ")}, ?, ?)`,
				[crypto.randomUUID(), ...values, ctx.idUser, ctx.idUser]
			);
			id = r.insertId;
		}

		// Автогенерація артикулу / EAN — після INSERT, щоб був доступний {ID}
		if (!core.sku && (await settings.get("sku")).auto) {
			const [[brand]] = core.id_brand ? await conn.query(`SELECT code FROM ${P}products_brands WHERE id = ?`, [core.id_brand]) : [[null]];
			core.sku = await sku.generateForProduct({ id, brandCode: brand && brand.code, categoryId: core.id_category_main }, conn);
			await conn.query(`UPDATE ${P}products SET sku = ? WHERE id = ?`, [core.sku, id]);
		}
		if (!core.ean && (await settings.get("ean")).auto) {
			core.ean = await ean.generate(conn);
			await conn.query(`UPDATE ${P}products SET ean = ? WHERE id = ?`, [core.ean, id]);
		}

		const slugShared = body.slug_shared === true || body.slug_shared === 1 || body.slug_shared === "1";
		await descriptions.save(conn, "products", id, vd.data, { sharedSlug: slugShared, primaryLang: primary });
		await conn.query(`UPDATE ${P}products SET slug_shared = ? WHERE id = ?`, [slugShared ? 1 : 0, id]);

		// ── Категорії ───────────────────────────────────
		await conn.query(`DELETE FROM ${P}products_to_categories WHERE id_product = ?`, [id]);
		if (parts.categories.length) await conn.query(`INSERT INTO ${P}products_to_categories (id_product, id_category) VALUES ?`, [parts.categories.map((c) => [id, c])]);

		removedFiles = await syncMedia(conn, id, parts.media, langIds);
		await saveAttributes(conn, id, parts.attributes, langIds);
		await productOptions.save(conn, id, vo.data);

		// ── Залишки: лише з правом products.stock / edit ─
		if (ctx.perms.stock) {
			for (const s of parts.stock) {
				const [[wh]] = await conn.query(`SELECT id FROM ${P}products_warehouses WHERE id = ? AND deleted_at IS NULL`, [s.id_warehouse]);
				if (!wh) throw httpErr(400, "Validation failed", [{ field: "stock", message: "warehouse not found" }]);
				if (s.id_location) await assertExists(conn, "products_warehouse_locations", s.id_location, "stock", `AND id_warehouse = ${Number(s.id_warehouse)}`);
				if (s.on_hand !== null) {
					await stock.setQty(conn, { idProduct: id, idWarehouse: s.id_warehouse, qty: s.on_hand, type: "adjustment", refType: "product_card", refId: id, idUser: ctx.idUser, comment: "Manual change in product card" });
				}
				await conn.query(
					`INSERT INTO ${P}products_stock (id_product, id_variant, id_warehouse, id_location, reorder_point, reorder_qty) VALUES (?, 0, ?, ?, ?, ?)
					 ON DUPLICATE KEY UPDATE id_location = VALUES(id_location), reorder_point = VALUES(reorder_point), reorder_qty = VALUES(reorder_qty)`,
					[id, s.id_warehouse, s.id_location, s.reorder_point, s.reorder_qty]
				);
			}
		}

		// ── Ціни, бонуси, пов'язані ─────────────────────
		await conn.query(`DELETE FROM ${P}products_prices WHERE id_product = ? AND id_variant = 0`, [id]);
		if (parts.prices.length) {
			await conn.query(
				`INSERT INTO ${P}products_prices (id_product, id_variant, kind, id_customer_group, min_qty, reduction_type, value, priority, date_start, date_end) VALUES ?`,
				[parts.prices.map((p) => [id, 0, p.kind, p.id_customer_group, p.min_qty, p.reduction_type, p.value, p.priority, p.date_start, p.date_end])]
			);
		}
		await conn.query(`DELETE FROM ${P}products_rewards WHERE id_product = ? AND id_variant = 0`, [id]);
		if (parts.rewards.length) {
			await conn.query(`INSERT INTO ${P}products_rewards (id_product, id_variant, id_customer_group, points) VALUES ? ON DUPLICATE KEY UPDATE points = VALUES(points)`, [parts.rewards.map((r) => [id, 0, r.id_customer_group, r.points])]);
		}

		if (parts.related.some((r) => r.id_related === id)) throw httpErr(400, "Validation failed", [{ field: "related", message: "product cannot be related to itself" }]);
		if (parts.related.length) {
			const ids = [...new Set(parts.related.map((r) => r.id_related))];
			const [found] = await conn.query(`SELECT id FROM ${P}products WHERE id IN (?) AND deleted_at IS NULL`, [ids]);
			if (found.length !== ids.length) throw httpErr(400, "Validation failed", [{ field: "related", message: "product not found" }]);
		}
		await conn.query(`DELETE FROM ${P}products_related WHERE id_product = ?`, [id]);
		if (parts.related.length) await conn.query(`INSERT INTO ${P}products_related (id_product, id_related, type, sort_order) VALUES ?`, [parts.related.map((r, i) => [id, r.id_related, r.type, i])]);

		// ── Постачальники ───────────────────────────────
		const [oldSup] = await conn.query(`SELECT id_supplier, supplier_price FROM ${P}products_to_suppliers WHERE id_product = ? AND id_variant = 0`, [id]);
		const oldPrice = new Map(oldSup.map((s) => [s.id_supplier, s.supplier_price]));
		if (parts.suppliers.length) {
			const [found] = await conn.query(`SELECT id FROM ${P}products_suppliers WHERE id IN (?) AND deleted_at IS NULL`, [parts.suppliers.map((s) => s.id_supplier)]);
			if (found.length !== parts.suppliers.length) throw httpErr(400, "Validation failed", [{ field: "suppliers", message: "supplier not found" }]);
		}
		await conn.query(`DELETE FROM ${P}products_to_suppliers WHERE id_product = ? AND id_variant = 0`, [id]);
		if (parts.suppliers.length) {
			await conn.query(
				`INSERT INTO ${P}products_to_suppliers (id_product, id_variant, id_supplier, supplier_sku, supplier_price, currency, lead_time_days, min_order_qty, is_default) VALUES ?`,
				[parts.suppliers.map((s) => [id, 0, s.id_supplier, s.supplier_sku, ctx.perms.cost ? s.supplier_price : oldPrice.get(s.id_supplier) ?? null, s.currency, s.lead_time_days, s.min_order_qty, Number(s.is_default)])]
			);
		}

		const [[after]] = await conn.query(`SELECT * FROM ${P}products WHERE id = ?`, [id]);
		const changed = before ? Object.keys(core).filter((k) => String(before[k] ?? "") !== String(after[k] ?? "")) : null;
		return { id, version: after.version, changed };
	});

	await Promise.all(removedFiles.map((f) => images.removeIfUnused("products", f).catch(() => {})));
	return result;
}

async function copy(srcId, idUser) {
	return tx((conn) => copyProduct(conn, srcId, idUser));
}

module.exports = { list, search, get, save, copy, COST_FIELDS };