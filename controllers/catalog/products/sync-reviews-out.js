"use strict";

// Відгуки CRM → магазин. Відгуки, що прийшли з цього ж сайту, прив'язуються до своїх оригіналів (без дублів).
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const assortment = require("../../settings/integrations/assortment");

const P = config.get("configDatabase").prefix;

function source(idIntegration) {
	let assort = null;
	const init = async () => {
		if (!assort) assort = await assortment.resolver(idIntegration);
	};
	const publishedOf = async (rows) => {
		const st = await assort.products([...new Set(rows.map((r) => r.id_product))]);
		return rows.filter((r) => st.get(Number(r.id_product)).published);
	};

	return {
		BATCH: 200,
		start: 0,
		resume: (crmId) => Number(crmId) || 0,
		count: async () => {
			await init();
			const [rows] = await pool.query(`SELECT id_product, COUNT(*) AS n FROM ${P}products_reviews WHERE id_product IS NOT NULL GROUP BY id_product`);
			return (await publishedOf(rows)).reduce((s, r) => s + Number(r.n), 0);
		},
		batch: async (after, size) => {
			const [rows] = await pool.query(
				`SELECT id, id_product, id_integration, external_id, rating, author_name, title, body, pros, cons, status, deleted_at, date_add
				   FROM ${P}products_reviews WHERE id > ? AND id_product IS NOT NULL ORDER BY id LIMIT ?`,
				[after, size]
			);
			if (!rows.length) return { items: [], next: after };
			await init();

			// Відгуки лише до товарів, що йдуть на цей сайт
			const list = await publishedOf(rows);
			if (!list.length) return { items: [], next: rows[rows.length - 1].id, more: true };

			const items = list.map((r) => {
				const text = [
					r.title ? String(r.title).trim() : "",
					r.body ? String(r.body).trim() : "",
					r.pros ? `+ ${String(r.pros).trim()}` : "",
					r.cons ? `− ${String(r.cons).trim()}` : "",
				]
					.filter(Boolean)
					.join("\n\n");
				return {
					crm_id: Number(r.id),
					product_crm_id: Number(r.id_product),
					oc_id: Number(r.id_integration) === Number(idIntegration) && /^\d+$/.test(String(r.external_id || "")) ? Number(r.external_id) : null,
					author: r.author_name || "—",
					text,
					rating: Math.min(5, Math.max(1, Number(r.rating) || 5)),
					status: r.status === "approved" && !r.deleted_at ? 1 : 0,
					deleted: !!r.deleted_at,
					date_add: r.date_add instanceof Date ? r.date_add.toISOString().slice(0, 19).replace("T", " ") : String(r.date_add || ""),
				};
			});
			return { items, next: rows[rows.length - 1].id };
		},
	};
}

module.exports = { source };