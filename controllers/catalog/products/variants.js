"use strict";

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
const { validateVariants, validateAxes, validateGenerate } = require("../../../validator/catalog/products/variants");

const P = config.get("configDatabase").prefix;
const MAX_VARIANTS = 1000;

function httpErr(status, message, errors, extra) {
	return Object.assign(new Error(message), { status, errors }, extra || {});
}

/**
 * Транзакція з тими самими гарантіями, що й збереження карточки:
 * товар заблоковано рядком, lock цієї вкладки живий, версія збігається. Після змін версія +1.
 */
async function mutate(idProduct, ctx, fn) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [[product]] = await conn.query(`SELECT * FROM ${P}products WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [idProduct]);
		if (!product) throw httpErr(404, "Not found");
		await editLock.assertHeld(conn, idProduct, ctx.lockToken, ctx.idUser);
		if (Number(ctx.version) !== Number(product.version)) throw httpErr(409, "Product was changed by someone else", null, { code: "version_conflict", version: product.version });

		const result = await fn(conn, product);

		// Тип товару стежить за наявністю варіантів
		const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM ${P}products_variants WHERE id_product = ?`, [idProduct]);
		const type = Number(n) > 0 ? "variable" : product.type === "variable" ? "simple" : product.type;
		await conn.query(`UPDATE ${P}products SET type = ?, version = version + 1, id_user_edit = ? WHERE id = ?`, [type, ctx.idUser, idProduct]);
		const [[{ version }]] = await conn.query(`SELECT version FROM ${P}products WHERE id = ?`, [idProduct]);
		await conn.commit();
		return { ...(result || {}), version };
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

// ═══ ЧИТАННЯ ═══════════════════════════════════════════
async function get(idProduct, idLang, perms) {
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;

	const [[product]] = await pool.query(
		`SELECT p.id, p.version, p.type, p.sku, p.price, p.status, COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', p.id)) AS name
		   FROM ${P}products p
		   LEFT JOIN ${P}products_description d  ON d.id_product = p.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_description dp ON dp.id_product = p.id AND dp.id_lang = ?
		  WHERE p.id = ? AND p.deleted_at IS NULL`,
		[idLang, primary, idProduct]
	);
	if (!product) throw httpErr(404, "Not found");

	const [[axes], [axisCandidates], [values], [variants], [vValues], [vMedia], [vStock], [warehouses], [media]] = await Promise.all([
		pool.query(`SELECT id_attribute FROM ${P}products_variant_axes WHERE id_product = ? ORDER BY sort_order, id_attribute`, [idProduct]),
		pool.query(
			`SELECT a.id, a.code, a.type, COALESCE(NULLIF(d.name, ''), dp.name, a.code) AS name
			   FROM ${P}products_attributes a
			   LEFT JOIN ${P}products_attributes_description d  ON d.id_attribute = a.id AND d.id_lang = ?
			   LEFT JOIN ${P}products_attributes_description dp ON dp.id_attribute = a.id AND dp.id_lang = ?
			  WHERE a.is_variant_axis = 1 AND a.type IN ('select', 'color')
			  ORDER BY a.sort_order, a.id`,
			[idLang, primary]
		),
		pool.query(
			`SELECT v.id, v.id_attribute, v.code, v.color_hex, COALESCE(NULLIF(d.name, ''), dp.name, v.code) AS name
			   FROM ${P}products_attribute_values v
			   JOIN ${P}products_attributes a ON a.id = v.id_attribute AND a.is_variant_axis = 1
			   LEFT JOIN ${P}products_attribute_values_description d  ON d.id_attribute_value = v.id AND d.id_lang = ?
			   LEFT JOIN ${P}products_attribute_values_description dp ON dp.id_attribute_value = v.id AND dp.id_lang = ?
			  ORDER BY v.id_attribute, v.sort_order, v.id`,
			[idLang, primary]
		),
		pool.query(
			`SELECT id, sku, mpn, ean, price_mode, price, compare_at_price, ${perms.cost ? "cost_price," : ""} weight_impact, is_default, status, sort_order
			   FROM ${P}products_variants WHERE id_product = ? ORDER BY sort_order, id`,
			[idProduct]
		),
		pool.query(`SELECT vv.id_variant, vv.id_attribute, vv.id_attribute_value FROM ${P}products_variant_values vv JOIN ${P}products_variants v ON v.id = vv.id_variant WHERE v.id_product = ?`, [idProduct]),
		pool.query(`SELECT vm.id_variant, vm.id_media FROM ${P}products_variant_media vm JOIN ${P}products_variants v ON v.id = vm.id_variant WHERE v.id_product = ? ORDER BY vm.sort_order`, [idProduct]),
		pool.query(`SELECT id_variant, id_warehouse, on_hand, reserved, incoming, available FROM ${P}products_stock WHERE id_product = ? AND id_variant > 0`, [idProduct]),
		pool.query(`SELECT id, code, name FROM ${P}products_warehouses WHERE deleted_at IS NULL AND status = 1 ORDER BY priority, sort_order, id`),
		pool.query(`SELECT id, file FROM ${P}products_media WHERE id_product = ? AND type = 'image' ORDER BY sort_order, id`, [idProduct]),
	]);

	const group = (rows, key) => rows.reduce((m, r) => ((m[r[key]] = m[r[key]] || []).push(r), m), {});
	const valuesBy = group(vValues, "id_variant");
	const mediaBy = group(vMedia, "id_variant");
	const stockBy = group(vStock, "id_variant");

	return {
		product,
		axes: axes.map((a) => a.id_attribute),
		axis_candidates: axisCandidates,
		values,
		warehouses,
		media: media.map((m) => ({ id: m.id, url: images.url("products", m.file, "small") })),
		variants: variants.map((v) => ({
			...v,
			value_ids: (valuesBy[v.id] || []).map((x) => x.id_attribute_value),
			media_ids: (mediaBy[v.id] || []).map((x) => x.id_media),
			stock: (stockBy[v.id] || []).map((s) => ({ id_warehouse: s.id_warehouse, on_hand: Number(s.on_hand), reserved: Number(s.reserved), incoming: Number(s.incoming), available: Number(s.available) })),
		})),
	};
}

// ═══ ОСІ ═══════════════════════════════════════════════
async function setAxes(idProduct, body, ctx) {
	const v = validateAxes(body);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);
	return mutate(idProduct, ctx, async (conn) => {
		const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM ${P}products_variants WHERE id_product = ?`, [idProduct]);
		if (Number(n) > 0) throw httpErr(409, "Delete all variants before changing axes", [{ field: "axes", message: "variants exist" }]);
		if (v.data.length) {
			const [found] = await conn.query(`SELECT id FROM ${P}products_attributes WHERE id IN (?) AND is_variant_axis = 1 AND type IN ('select', 'color')`, [v.data]);
			if (found.length !== v.data.length) throw httpErr(400, "Validation failed", [{ field: "axes", message: "attribute cannot be a variant axis" }]);
		}
		await conn.query(`DELETE FROM ${P}products_variant_axes WHERE id_product = ?`, [idProduct]);
		if (v.data.length) await conn.query(`INSERT INTO ${P}products_variant_axes (id_product, id_attribute, sort_order) VALUES ?`, [v.data.map((a, i) => [idProduct, a, i])]);
	});
}

// ═══ ГЕНЕРАЦІЯ ═════════════════════════════════════════
function cartesian(lists) {
	return lists.reduce((acc, list) => acc.flatMap((prefix) => list.map((x) => [...prefix, x])), [[]]);
}

async function generate(idProduct, body, ctx) {
	const v = validateGenerate(body);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);

	return mutate(idProduct, ctx, async (conn, product) => {
		const [axes] = await conn.query(`SELECT id_attribute FROM ${P}products_variant_axes WHERE id_product = ? ORDER BY sort_order, id_attribute`, [idProduct]);
		if (!axes.length) throw httpErr(409, "Set variant axes first", [{ field: "axes", message: "required" }]);

		const axisIds = axes.map((a) => a.id_attribute);
		const lists = [];
		for (const idAttr of axisIds) {
			const ids = v.data[idAttr] || [];
			if (!ids.length) throw httpErr(400, "Validation failed", [{ field: `values.${idAttr}`, message: "select at least one value" }]);
			const [found] = await conn.query(`SELECT id, code FROM ${P}products_attribute_values WHERE id IN (?) AND id_attribute = ?`, [ids, idAttr]);
			if (found.length !== ids.length) throw httpErr(400, "Validation failed", [{ field: `values.${idAttr}`, message: "value does not belong to attribute" }]);
			lists.push(found.map((f) => ({ id_attribute: idAttr, id: f.id, code: f.code })));
		}

		const combos = cartesian(lists);
		const [existing] = await conn.query(`SELECT combination_key FROM ${P}products_variants WHERE id_product = ?`, [idProduct]);
		const have = new Set(existing.map((e) => e.combination_key));
		const toCreate = combos.filter((c) => !have.has(c.map((x) => x.id).sort((a, b) => a - b).join("-")));
		if (existing.length + toCreate.length > MAX_VARIANTS) throw httpErr(400, `Too many variants (max ${MAX_VARIANTS})`, [{ field: "values", message: `max ${MAX_VARIANTS} variants` }]);

		const skuCfg = await settings.get("sku");
		const eanCfg = await settings.get("ean");
		const [[{ maxSort }]] = await conn.query(`SELECT COALESCE(MAX(sort_order), -1) AS maxSort FROM ${P}products_variants WHERE id_product = ?`, [idProduct]);
		let sort = Number(maxSort) + 1;
		let first = existing.length === 0;

		for (const combo of toCreate) {
			const key = combo.map((x) => x.id).sort((a, b) => a - b).join("-");
			const [r] = await conn.query(
				`INSERT INTO ${P}products_variants (id_product, uuid, combination_key, price_mode, price, is_default, status, sort_order)
				 VALUES (?, ?, ?, 'impact', 0, ?, 1, ?)`,
				[idProduct, crypto.randomUUID(), key, first ? 1 : 0, sort++]
			);
			const idVariant = r.insertId;
			first = false;
			await conn.query(`INSERT INTO ${P}products_variant_values (id_variant, id_attribute, id_attribute_value) VALUES ?`, [combo.map((x) => [idVariant, x.id_attribute, x.id])]);

			if (product.sku || skuCfg.auto) {
				const vSku = await sku.generateForVariant(product.sku, combo.map((x) => x.code), { id: idProduct, variantId: idVariant, categoryId: product.id_category_main }, conn);
				await conn.query(`UPDATE ${P}products_variants SET sku = ? WHERE id = ?`, [vSku, idVariant]);
			}
			if (eanCfg.auto) await conn.query(`UPDATE ${P}products_variants SET ean = ? WHERE id = ?`, [await ean.generate(conn), idVariant]);
		}
		return { created: toCreate.length };
	});
}

// ═══ ЗБЕРЕЖЕННЯ ════════════════════════════════════════
async function save(idProduct, body, ctx) {
	const v = validateVariants(body.variants);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);

	return mutate(idProduct, ctx, async (conn) => {
		const [own] = await conn.query(`SELECT id, cost_price FROM ${P}products_variants WHERE id_product = ? FOR UPDATE`, [idProduct]);
		const ownById = new Map(own.map((o) => [o.id, o]));
		const [mediaRows] = await conn.query(`SELECT id FROM ${P}products_media WHERE id_product = ?`, [idProduct]);
		const mediaIds = new Set(mediaRows.map((m) => m.id));
		const [whRows] = await conn.query(`SELECT id FROM ${P}products_warehouses WHERE deleted_at IS NULL`);
		const whIds = new Set(whRows.map((w) => w.id));

		for (const [i, row] of v.data.entries()) {
			if (!ownById.has(row.id)) throw httpErr(400, "Validation failed", [{ field: `variants.${i}`, message: "variant does not belong to product" }]);
			if (row.media_ids.some((m) => !mediaIds.has(m))) throw httpErr(400, "Validation failed", [{ field: `variants.${i}.media_ids`, message: "image not found" }]);
			if (row.ean && !ean.isValid(row.ean)) throw httpErr(400, "Validation failed", [{ field: `variants.${i}.ean`, message: "invalid check digit" }]);
			if (row.sku && !(await sku.isFree(row.sku, { excludeVariantId: row.id }, conn))) throw httpErr(409, "SKU already exists", [{ field: `variants.${i}.sku`, message: "already exists" }]);
		}

		// Якщо змінювали лише частину — основний варіант лишається одним на товар
		if (v.data.some((x) => x.is_default)) await conn.query(`UPDATE ${P}products_variants SET is_default = 0 WHERE id_product = ?`, [idProduct]);

		for (const row of v.data) {
			const cost = ctx.perms.cost ? row.cost_price : ownById.get(row.id).cost_price;
			await conn.query(
				`UPDATE ${P}products_variants
				    SET sku = ?, mpn = ?, ean = ?, price_mode = ?, price = ?, compare_at_price = ?, cost_price = ?, weight_impact = ?, is_default = ?, status = ?
				  WHERE id = ?`,
				[row.sku, row.mpn, row.ean, row.price_mode, row.price, row.compare_at_price, cost, row.weight_impact, Number(row.is_default), Number(row.status), row.id]
			);
			await conn.query(`DELETE FROM ${P}products_variant_media WHERE id_variant = ?`, [row.id]);
			if (row.media_ids.length) await conn.query(`INSERT INTO ${P}products_variant_media (id_variant, id_media, sort_order) VALUES ?`, [row.media_ids.map((m, k) => [row.id, m, k])]);

			if (ctx.perms.stock) {
				for (const s of row.stock) {
					if (!whIds.has(s.id_warehouse)) throw httpErr(400, "Validation failed", [{ field: "stock", message: "warehouse not found" }]);
					await stock.setQty(conn, { idProduct, idVariant: row.id, idWarehouse: s.id_warehouse, qty: s.on_hand, type: "adjustment", refType: "product_variants", refId: idProduct, idUser: ctx.idUser, comment: "Manual change in variants" });
				}
			}
		}

		// Гарантуємо рівно один основний варіант
		const [[{ d }]] = await conn.query(`SELECT COUNT(*) AS d FROM ${P}products_variants WHERE id_product = ? AND is_default = 1`, [idProduct]);
		if (Number(d) === 0) await conn.query(`UPDATE ${P}products_variants SET is_default = 1 WHERE id_product = ? ORDER BY sort_order, id LIMIT 1`, [idProduct]);
		return { saved: v.data.length };
	});
}

// ═══ ВИДАЛЕННЯ ═════════════════════════════════════════
async function remove(idProduct, body, ctx) {
	const ids = Array.isArray(body && body.ids) ? [...new Set(body.ids.map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0))] : [];
	if (!ids.length) throw httpErr(400, "Validation failed", [{ field: "ids", message: "required" }]);

	return mutate(idProduct, ctx, async (conn) => {
		const [own] = await conn.query(`SELECT id FROM ${P}products_variants WHERE id_product = ? AND id IN (?) FOR UPDATE`, [idProduct, ids]);
		if (own.length !== ids.length) throw httpErr(400, "Validation failed", [{ field: "ids", message: "variant does not belong to product" }]);

		const [[busy]] = await conn.query(
			`SELECT COUNT(*) AS n FROM ${P}products_stock WHERE id_product = ? AND id_variant IN (?) AND (on_hand <> 0 OR reserved <> 0 OR incoming <> 0)`,
			[idProduct, ids]
		);
		if (Number(busy.n) > 0) throw httpErr(409, "Variants have stock, reservations or incoming goods", [{ field: "ids", message: "stock is not zero" }]);
		const [[res]] = await conn.query(`SELECT COUNT(*) AS n FROM ${P}products_stock_reservations WHERE id_product = ? AND id_variant IN (?)`, [idProduct, ids]);
		if (Number(res.n) > 0) throw httpErr(409, "Variants are reserved", [{ field: "ids", message: "reserved" }]);

		// Таблиці з id_variant без FK — чистимо явно; журнал руху лишається як історія
		for (const t of ["products_stock", "products_prices", "products_rewards", "products_to_suppliers", "products_downloads", "products_subscription_plans", "products_bundle_items", "products_external_links"]) {
			await conn.query(`DELETE FROM ${P}${t} WHERE id_variant IN (?)`, [ids]);
		}
		await conn.query(`DELETE FROM ${P}products_variants WHERE id IN (?)`, [ids]); // values і media — каскадом

		const [[{ d }]] = await conn.query(`SELECT COUNT(*) AS d FROM ${P}products_variants WHERE id_product = ? AND is_default = 1`, [idProduct]);
		if (Number(d) === 0) await conn.query(`UPDATE ${P}products_variants SET is_default = 1 WHERE id_product = ? ORDER BY sort_order, id LIMIT 1`, [idProduct]);
		return { deleted: ids.length };
	});
}

module.exports = { get, setAxes, generate, save, remove };