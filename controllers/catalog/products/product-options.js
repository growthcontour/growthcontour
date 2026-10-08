"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const { VALUE_TYPES } = require("../../../validator/catalog/products/options");

const P = config.get("configDatabase").prefix;

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

/** Опції та поля персоналізації товару */
async function load(idProduct, conn) {
	const db = conn || pool;
	const [opts] = await db.query(`SELECT id, id_option, is_required, default_value FROM ${P}products_to_options WHERE id_product = ? ORDER BY sort_order, id`, [idProduct]);
	const [vals] = opts.length
		? await db.query(
				`SELECT id_product_option, id_option_value, price_mode, price, points, weight, quantity, subtract_stock, sku_suffix, is_default
				   FROM ${P}products_to_option_values WHERE id_product_option IN (?) ORDER BY sort_order, id`,
				[opts.map((o) => o.id)]
		  )
		: [[]];
	const [custom] = await db.query(`SELECT id, type, is_required, max_length, price FROM ${P}products_customization_fields WHERE id_product = ? ORDER BY sort_order, id`, [idProduct]);
	const [labels] = custom.length
		? await db.query(`SELECT id_customization_field, id_lang, label FROM ${P}products_customization_fields_description WHERE id_customization_field IN (?)`, [custom.map((c) => c.id)])
		: [[]];

	return {
		options: opts.map((o) => ({
			id_option: o.id_option,
			is_required: o.is_required,
			default_value: o.default_value,
			values: vals.filter((v) => v.id_product_option === o.id).map(({ id_product_option, ...v }) => v),
		})),
		customization: custom.map((c) => ({
			...c,
			labels: labels.filter((l) => l.id_customization_field === c.id).reduce((m, l) => ((m[l.id_lang] = { label: l.label }), m), {}),
		})),
	};
}

/** Зберегти в межах транзакції карточки. data — після validateProductOptions. */
async function save(conn, idProduct, data) {
	// ── Опції: повна заміна (значення — каскадом) ──────
	const optIds = data.options.map((o) => o.id_option);
	const defs = new Map();
	if (optIds.length) {
		const [rows] = await conn.query(`SELECT id, type FROM ${P}products_options WHERE id IN (?)`, [optIds]);
		rows.forEach((r) => defs.set(r.id, r.type));
		if (rows.length !== optIds.length) throw httpErr(400, "Validation failed", [{ field: "options", message: "option not found" }]);
	}
	const valueIds = data.options.flatMap((o) => o.values.map((v) => v.id_option_value));
	const valueOwner = new Map();
	if (valueIds.length) {
		const [rows] = await conn.query(`SELECT id, id_option FROM ${P}products_option_values WHERE id IN (?)`, [valueIds]);
		rows.forEach((r) => valueOwner.set(r.id, r.id_option));
	}

	await conn.query(`DELETE FROM ${P}products_to_options WHERE id_product = ?`, [idProduct]);
	for (const [i, o] of data.options.entries()) {
		const type = defs.get(o.id_option);
		const isValueType = VALUE_TYPES.includes(type);
		if (isValueType && !o.values.length) throw httpErr(400, "Validation failed", [{ field: `options.${i}`, message: "add at least one value" }]);
		if (isValueType && type !== "checkbox" && o.values.filter((v) => v.is_default).length > 1) throw httpErr(400, "Validation failed", [{ field: `options.${i}`, message: "only one default value" }]);
		for (const v of o.values) {
			if (valueOwner.get(v.id_option_value) !== o.id_option) throw httpErr(400, "Validation failed", [{ field: `options.${i}`, message: "value does not belong to option" }]);
		}

		const [r] = await conn.query(
			`INSERT INTO ${P}products_to_options (id_product, id_option, is_required, default_value, sort_order) VALUES (?, ?, ?, ?, ?)`,
			[idProduct, o.id_option, Number(o.is_required), isValueType ? null : o.default_value, i]
		);
		if (isValueType && o.values.length) {
			await conn.query(
				`INSERT INTO ${P}products_to_option_values
				   (id_product_option, id_option_value, price_mode, price, points, weight, quantity, subtract_stock, sku_suffix, is_default, sort_order) VALUES ?`,
				[o.values.map((v, k) => [r.insertId, v.id_option_value, v.price_mode, v.price, v.points, v.weight, v.quantity, Number(v.subtract_stock), v.sku_suffix, Number(v.is_default), k])]
			);
		}
	}

	// ── Персоналізація: синхронізація зі збереженням id ──
	const [existing] = await conn.query(`SELECT id FROM ${P}products_customization_fields WHERE id_product = ?`, [idProduct]);
	const existingIds = new Set(existing.map((e) => e.id));
	for (const c of data.customization) if (c.id && !existingIds.has(c.id)) throw httpErr(400, "Validation failed", [{ field: "customization", message: "invalid field id" }]);
	const keep = new Set(data.customization.filter((c) => c.id).map((c) => c.id));
	const removed = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
	if (removed.length) await conn.query(`DELETE FROM ${P}products_customization_fields WHERE id IN (?)`, [removed]);

	for (const [i, c] of data.customization.entries()) {
		let id = c.id;
		const maxLength = c.type === "text" ? c.max_length : null;
		if (id) {
			await conn.query(`UPDATE ${P}products_customization_fields SET type = ?, is_required = ?, max_length = ?, price = ?, sort_order = ? WHERE id = ?`, [c.type, Number(c.is_required), maxLength, c.price, i, id]);
		} else {
			const [r] = await conn.query(
				`INSERT INTO ${P}products_customization_fields (id_product, type, is_required, max_length, price, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
				[idProduct, c.type, Number(c.is_required), maxLength, c.price, i]
			);
			id = r.insertId;
		}
		for (const [lang, row] of Object.entries(c.labels)) {
			if (!row) {
				await conn.query(`DELETE FROM ${P}products_customization_fields_description WHERE id_customization_field = ? AND id_lang = ?`, [id, Number(lang)]);
				continue;
			}
			await conn.query(
				`INSERT INTO ${P}products_customization_fields_description (id_customization_field, id_lang, label) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE label = ?`,
				[id, Number(lang), row.label, row.label]
			);
		}
	}
}

module.exports = { load, save };