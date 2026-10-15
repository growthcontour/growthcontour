"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const trash = require("../../common/trash");
const editLock = require("./edit-lock");
const history = require("./history");

const P = config.get("configDatabase").prefix;

/* ─── Арифметика цін у цілих (1/10000), без похибок float ─── */
const SCALE = 10000;
const toInt = (v) => Math.round(Number(v) * SCALE);
const fromInt = (n) => (n / SCALE).toFixed(4);

function roundPrice(n, mode) {
	// n — ціле в 1/10000
	switch (mode) {
		case "0":
			return Math.round(n / SCALE) * SCALE;
		case "1":
			return Math.round(n / 1000) * 1000;
		case "2":
			return Math.round(n / 100) * 100;
		case "99": {
			// x.99: 123.40 → 123.99; 0.40 → 0.99
			return Math.floor(n / SCALE) * SCALE + 9900;
		}
		case "9": {
			// закінчення на 9 гривень/одиниць: 123.40 → 129; 7 → 9
			const units = Math.round(n / SCALE);
			return (Math.floor(units / 10) * 10 + 9) * SCALE;
		}
		default:
			return n;
	}
}

/**
 * Нова ціна. current — DECIMAL рядок/число або null.
 * isImpact — значення є надбавкою варіанта (може бути від'ємним).
 */
function computePrice(current, p, isImpact) {
	if (p.op === "set") return roundPrice(toInt(p.value), p.round);
	if (current === null || current === undefined) return null; // нема від чого рахувати
	const base = toInt(current);
	let next = p.op === "percent" ? Math.round((base * (100 + p.value)) / 100) : base + toInt(p.value);
	if (!isImpact) {
		next = roundPrice(next, p.round);
		if (next < 0) next = 0;
	}
	return next;
}

function httpErr(status, message, extra) {
	return Object.assign(new Error(message), { status }, extra || {});
}

/* ─── Дії над одним товаром у відкритій транзакції ─── */
async function applyOne(conn, product, action, params, ctx) {
	const set = {};
	const extra = [];

	switch (action) {
		case "status":
			if (product.status === params.status) return false;
			set.status = params.status;
			if (params.status === "active") set.published_at = product.published_at || new Date();
			break;

		case "visibility":
			if (product.visibility === params.visibility) return false;
			set.visibility = params.visibility;
			break;

		case "featured":
			if (Number(product.is_featured) === params.value) return false;
			set.is_featured = params.value;
			break;

		case "brand":
			if ((product.id_brand || null) === params.id_brand) return false;
			set.id_brand = params.id_brand;
			break;

		case "categories": {
			const [rows] = await conn.query(`SELECT id_category FROM ${P}products_to_categories WHERE id_product = ?`, [product.id]);
			const current = rows.map((r) => r.id_category);
			let next;
			if (params.op === "add") next = [...new Set([...current, ...params.ids])];
			else if (params.op === "remove") next = current.filter((c) => !params.ids.includes(c));
			else next = [...params.ids];

			const toDelete = current.filter((c) => !next.includes(c));
			const toInsert = next.filter((c) => !current.includes(c));
			if (toDelete.length) await conn.query(`DELETE FROM ${P}products_to_categories WHERE id_product = ? AND id_category IN (?)`, [product.id, toDelete]);
			if (toInsert.length) await conn.query(`INSERT INTO ${P}products_to_categories (id_product, id_category) VALUES ?`, [toInsert.map((c) => [product.id, c])]);

			let main = product.id_category_main;
			if (params.set_main && params.op !== "remove") main = params.ids[0];
			else if (main && !next.includes(main)) main = next[0] || null;
			else if (!main && next.length) main = next[0];
			if (main !== product.id_category_main) set.id_category_main = main;

			if (toDelete.length || toInsert.length) extra.push({ field: "categories", old: [...current].sort((a, b) => a - b), new: [...next].sort((a, b) => a - b) });
			if (!toDelete.length && !toInsert.length && !("id_category_main" in set)) return false;
			break;
		}

		case "price": {
			const next = computePrice(product[params.field], params, false);
			if (next !== null && next !== toInt(product[params.field] ?? 0)) set[params.field] = fromInt(next);
			let variantsChanged = 0;
			if (params.variants && product.type === "variable") {
				const vc = await applyVariantsPrice(conn, product.id, params);
				variantsChanged = vc.length;
				extra.push(...vc);
			}
			if (!Object.keys(set).length && !variantsChanged) return false;
			break;
		}

		case "compare_from_price": {
			if (toInt(product.price) > 0 && toInt(product.compare_at_price ?? -1) !== toInt(product.price)) set.compare_at_price = product.price;
			let variantsChanged = 0;
			if (params.variants && product.type === "variable") {
				const [r] = await conn.query(
					`UPDATE ${P}products_variants SET compare_at_price = price
					  WHERE id_product = ? AND price_mode = 'fixed' AND price > 0 AND (compare_at_price IS NULL OR compare_at_price <> price)`,
					[product.id]
				);
				variantsChanged = r.affectedRows;
				if (r.affectedRows) extra.push({ field: "variants.compare_at_price", old: null, new: `= price (${r.affectedRows})` });
			}
			if (!Object.keys(set).length && !variantsChanged) return false;
			break;
		}

		default:
			throw httpErr(400, "Unknown action");
	}

	const keys = Object.keys(set);
	await conn.query(
		`UPDATE ${P}products SET ${keys.map((k) => `\`${k}\` = ?`).join(", ")}${keys.length ? ", " : ""}version = version + 1, id_user_edit = ? WHERE id = ?`,
		[...keys.map((k) => set[k]), ctx.idUser, product.id]
	);
	const norm = (v) => (v === undefined || v === null ? null : v instanceof Date ? v.toISOString() : String(v));
	return [...keys.map((k) => ({ field: k, old: norm(product[k]), new: norm(set[k]) })), ...extra];
}

/** fixed — та сама операція; impact — лише масштабування у %; ціни <0 у fixed не допускаються */
async function applyVariantsPrice(conn, idProduct, params) {
	const [variants] = await conn.query(`SELECT id, price_mode, ${params.field} AS value FROM ${P}products_variants WHERE id_product = ? FOR UPDATE`, [idProduct]);
	const changes = [];
	for (const v of variants) {
		const isImpact = v.price_mode === "impact" && params.field === "price";
		if (isImpact && params.op !== "percent") continue;
		const next = computePrice(v.value, params, isImpact);
		if (next === null || next === toInt(v.value ?? 0)) continue;
		await conn.query(`UPDATE ${P}products_variants SET ${params.field} = ? WHERE id = ?`, [fromInt(next), v.id]);
		changes.push({ field: `variant.${v.id}.${params.field}`, old: v.value === null ? null : String(v.value), new: fromInt(next) });
	}
	return changes;
}

/**
 * Масова дія. ctx: { idUser, perms: { edit, delete, costEdit } }
 * Повертає { summary, report, changedIds }.
 */
async function apply(input, ctx) {
	const { ids, action, params = {} } = input;

	if (action === "delete" ? !ctx.perms.delete : !ctx.perms.edit) throw httpErr(403, "Forbidden");
	if (action === "price" && ["cost_price", "wholesale_price"].includes(params.field) && !ctx.perms.costEdit) throw httpErr(403, "Forbidden");

	// Довідкові перевірки — один раз на всю операцію
	if (action === "brand" && params.id_brand) {
		const [[b]] = await pool.query(`SELECT id FROM ${P}products_brands WHERE id = ? AND deleted_at IS NULL`, [params.id_brand]);
		if (!b) throw httpErr(400, "Brand not found", { errors: [{ field: "params.id_brand", message: "not found" }] });
	}
	if (action === "categories") {
		const [cats] = await pool.query(`SELECT id FROM ${P}products_categories WHERE id IN (?)`, [params.ids]);
		if (cats.length !== params.ids.length) throw httpErr(400, "Category not found", { errors: [{ field: "params.ids", message: "not found" }] });
	}

	const summary = { total: ids.length, changed: 0, unchanged: 0, skipped: 0, error: 0 };
	const report = [];
	const changedIds = [];

	// Сортування за id — однаковий порядок блокувань між паралельними операціями (без deadlock)
	for (const id of [...ids].sort((a, b) => a - b)) {
		if (action === "delete") {
			const h = await editLock.holder(id);
			if (h && h.id_user !== ctx.idUser) {
				summary.skipped++;
				report.push({ id, status: "skipped", message: "locked", user_name: h.user_name });
				continue;
			}
			try {
				await trash.softDelete("products", id, ctx.idUser);
				summary.changed++;
				changedIds.push(id);
				await history.record("products", id, { user: ctx.idUser, source: "bulk", action: "delete" });
			} catch (e) {
				summary.error++;
				report.push({ id, status: "error", message: e.status ? e.message : "server error" });
				if (!e.status) ctx.logError(e);
			}
			continue;
		}

		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();
			const [[product]] = await conn.query(`SELECT * FROM ${P}products WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [id]);
			if (!product) {
				await conn.rollback();
				summary.error++;
				report.push({ id, status: "error", message: "not found" });
				continue;
			}
			const h = await editLock.holder(id, conn);
			if (h) {
				await conn.rollback();
				summary.skipped++;
				report.push({ id, sku: product.sku, status: "skipped", message: "locked", user_name: h.user_name });
				continue;
			}
			const changed = await applyOne(conn, product, action, params, ctx);
			await conn.commit();
			if (changed && changed.length) {
				summary.changed++;
				changedIds.push(id);
				await history.record("products", id, { user: ctx.idUser, source: "bulk", action: "update", changes: changed, meta: { bulk: action } });
			} else summary.unchanged++;
		} catch (e) {
			await conn.rollback().catch(() => {});
			summary.error++;
			report.push({ id, status: "error", message: e.status ? e.message : "server error" });
			if (!e.status) ctx.logError(e);
		} finally {
			conn.release();
		}
	}

	return { summary, report, changedIds };
}

module.exports = { apply, computePrice, roundPrice };