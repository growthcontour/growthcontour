"use strict";

// Характеристики CRM → магазин: довідник (групи + характеристики). Значення в товарах ідуть разом із товарами.
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const languages = require("./languages");

const P = config.get("configDatabase").prefix;

function names(rows, key, codeById) {
	const m = new Map();
	for (const r of rows) {
		const code = codeById.get(Number(r.id_lang));
		if (!code) continue;
		if (!m.has(r[key])) m.set(r[key], []);
		m.get(r[key]).push({ code, name: r.name || "" });
	}
	return m;
}

/** id характеристики → { crm_id, sort_order, unit, group: { crm_id, sort_order, names }, names } */
async function attributeDict(attrIds, codeById) {
	if (!attrIds.length) return new Map();
	const [attrs] = await pool.query(`SELECT id, id_attribute_group, unit, sort_order FROM ${P}products_attributes WHERE id IN (?)`, [attrIds]);
	const gIds = [...new Set(attrs.map((a) => a.id_attribute_group).filter(Boolean))];
	const [[an], [groups], [gn]] = await Promise.all([
		pool.query(`SELECT id_attribute, id_lang, name FROM ${P}products_attributes_description WHERE id_attribute IN (?)`, [attrIds]),
		gIds.length ? pool.query(`SELECT id, sort_order FROM ${P}products_attribute_groups WHERE id IN (?)`, [gIds]) : Promise.resolve([[]]),
		gIds.length
			? pool.query(`SELECT id_attribute_group, id_lang, name FROM ${P}products_attribute_groups_description WHERE id_attribute_group IN (?)`, [gIds])
			: Promise.resolve([[]]),
	]);
	const aNames = names(an, "id_attribute", codeById);
	const gNames = names(gn, "id_attribute_group", codeById);
	const gMap = new Map(groups.map((g) => [g.id, { crm_id: Number(g.id), sort_order: Number(g.sort_order) || 0, names: gNames.get(g.id) || [] }]));
	const noGroup = { crm_id: 0, sort_order: 0, names: [] };

	return new Map(
		attrs.map((a) => [
			a.id,
			{
				crm_id: Number(a.id),
				sort_order: Number(a.sort_order) || 0,
				unit: a.unit || "",
				group: gMap.get(a.id_attribute_group) || noGroup,
				names: aNames.get(a.id) || [],
			},
		])
	);
}

function source() {
	let codeById = null;
	const init = async () => {
		if (!codeById) codeById = new Map((await languages.active()).map((l) => [Number(l.id), l.code]));
	};

	return {
		BATCH: 200,
		start: 0,
		resume: (crmId) => Number(crmId) || 0,
		count: async () => {
			const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products_attributes`);
			return Number(r.n);
		},
		batch: async (after, size) => {
			await init();
			const [rows] = await pool.query(`SELECT id FROM ${P}products_attributes WHERE id > ? ORDER BY id LIMIT ?`, [after, size]);
			if (!rows.length) return { items: [], next: after };
			const dict = await attributeDict(rows.map((r) => r.id), codeById);
			const items = rows
				.map((r) => dict.get(r.id))
				.filter(Boolean)
				.map(({ unit, ...a }) => a);
			return { items, next: rows[rows.length - 1].id };
		},
	};
}

module.exports = { source, attributeDict };