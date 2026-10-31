const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;

// Через скільки днів видалене прибирається остаточно
const KEEP_DAYS = 30;

function httpErr(status, message) {
	const e = new Error(message);
	e.status = status;
	return e;
}

/**
 * Типи об'єктів у кошику.
 * purge: true — після KEEP_DAYS видаляється остаточно; false — лишається в базі назавжди
 * (замовлення — фінансові документи, їх не можна знищувати).
 */
const TYPES = {
	clients: {
		title: "Клієнти",
		table: "clients",
		name: "t.display_name",
		url: (id) => "/clients/" + id + "/",
		purge: true,
	},
	leads: {
		title: "Ліди",
		table: "leads",
		name: "t.title",
		url: (id) => "/leads/" + id + "/",
		purge: true,
	},
	products: {
		title: "Товари",
		table: "products",
		name: "(SELECT pd.name FROM " + P + "products_description pd WHERE pd.id_product = t.id ORDER BY pd.id_lang LIMIT 1)",
		url: (id) => "/catalog/products/" + id + "/",
		purge: true,
	},
	product_brands: {
		title: "Бренди",
		table: "products_brands",
		name: "(SELECT d.name FROM " + P + "products_brands_description d WHERE d.id_brand = t.id ORDER BY d.id_lang LIMIT 1)",
		url: () => "/catalog/brands/",
		purge: true,
	},
	product_warehouses: {
		title: "Склади",
		table: "products_warehouses",
		name: "t.name",
		url: () => "/catalog/stock/warehouses/",
		purge: true,
	},
	product_suppliers: {
		title: "Постачальники",
		table: "products_suppliers",
		name: "t.name",
		url: () => "/catalog/stock/suppliers/",
		purge: true,
	},
	orders: {
		title: "Замовлення",
		table: "orders",
		name: "t.reference",
		url: (id) => "/orders/" + id + "/",
		purge: false,
	},
};

const typeOf = (type) => {
	const t = TYPES[type];
	if (!t) throw httpErr(404, "Невідомий тип.");
	return t;
};

/** Вміст кошика одного типу */
async function list(type, o) {
	const t = typeOf(type);
	const limit = Math.min(Math.max(parseInt((o || {}).limit, 10) || 50, 1), 200);
	const before = parseInt((o || {}).before_id, 10) || 0;
	const [rows] = await pool.query(
		`SELECT t.id, ${t.name} AS name, t.deleted_at, t.id_user_deleted,
                NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS deleted_by
           FROM ${P}${t.table} t
           LEFT JOIN ${P}users u ON u.id = t.id_user_deleted
          WHERE t.deleted_at IS NOT NULL ${before ? "AND t.id < ?" : ""}
          ORDER BY t.deleted_at DESC, t.id DESC
          LIMIT ${limit + 1}`,
		before ? [before] : []
	);
	const more = rows.length > limit;
	if (more) rows.pop();
	return {
		rows: rows.map((r) => ({
			...r,
			url: t.url(r.id),
			purge_at: t.purge ? new Date(new Date(r.deleted_at).getTime() + KEEP_DAYS * 86400000) : null,
		})),
		has_more: more,
		next_before_id: more ? rows[rows.length - 1].id : null,
		purge: t.purge,
		keep_days: KEEP_DAYS,
	};
}

/** Скільки об'єктів у кошику кожного типу */
async function counts() {
	const out = {};
	for (const [k, t] of Object.entries(TYPES)) {
		const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}${t.table} WHERE deleted_at IS NOT NULL`);
		out[k] = Number(r.n) || 0;
	}
	return out;
}

/** М'яке видалення (клієнти, ліди; замовлення мають власний роут) */
async function softDelete(type, id, idUser) {
	const t = typeOf(type);
	const [r] = await pool.query(`UPDATE ${P}${t.table} SET deleted_at = NOW(), id_user_deleted = ? WHERE id = ? AND deleted_at IS NULL`, [idUser || null, id]);
	if (!r.affectedRows) throw httpErr(404, "Не знайдено або вже видалено.");
	await afterChange(type, id);
	return { ok: true };
}

/** Відновити з кошика */
async function restore(type, id) {
	const t = typeOf(type);
	const [r] = await pool.query(`UPDATE ${P}${t.table} SET deleted_at = NULL, id_user_deleted = NULL WHERE id = ? AND deleted_at IS NOT NULL`, [id]);
	if (!r.affectedRows) throw httpErr(404, "У кошику не знайдено.");
	await afterChange(type, id);
	return { ok: true, url: t.url(id) };
}

/** Видалити остаточно (лише типи з purge) */
async function purge(type, id) {
	const t = typeOf(type);
	if (!t.purge) throw httpErr(400, "Цей тип не видаляється остаточно.");
	const [r] = await pool.query(`DELETE FROM ${P}${t.table} WHERE id = ? AND deleted_at IS NOT NULL`, [id]);
	if (!r.affectedRows) throw httpErr(404, "У кошику не знайдено.");
	return { ok: true };
}

/** Перерахунки після видалення/відновлення, щоб цифри скрізь були правильні */
async function afterChange(type, id) {
	const stats = require("../clients/stats");
	if (type === "orders") {
		await stats.recalcForOrder(null, id);
		const [[o]] = await pool.query(`SELECT date_order_day FROM ${P}orders WHERE id = ?`, [id]);
		const day = o && o.date_order_day ? new Date(o.date_order_day).toISOString().slice(0, 10) : null;
		if (day) {
			try {
				await require("../../cron/analytics/rebuildStats").rebuildRange(day, day);
			} catch (e) {
				console.error("[trash] rebuildStats", e.message);
			}
		}
	}
	if (type === "leads") {
		const [[l]] = await pool.query(`SELECT id_client, id_client_org FROM ${P}leads WHERE id = ?`, [id]);
		if (l && l.id_client) await stats.recalc(null, l.id_client);
		if (l && l.id_client_org) await stats.recalc(null, l.id_client_org);
	}
}

/** Нічне прибирання: старше KEEP_DAYS — остаточно */
async function purgeOld() {
	const out = {};
	for (const [k, t] of Object.entries(TYPES)) {
		if (!t.purge) continue;
		// По одному: якщо запис тримає зовнішній ключ — пропускаємо його, а не зупиняємо все прибирання
		const [rows] = await pool.query(`SELECT id FROM ${P}${t.table} WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL ? DAY LIMIT 5000`, [KEEP_DAYS]);
		let done = 0;
		let failed = 0;
		for (const r of rows) {
			try {
				await pool.query(`DELETE FROM ${P}${t.table} WHERE id = ? AND deleted_at IS NOT NULL`, [r.id]);
				done++;
			} catch (e) {
				failed++;
				console.error("[trash purge]", k, r.id, e.code || e.message);
			}
		}
		out[k] = { purged: done, failed };
	}
	return out;
}

module.exports = { TYPES, KEEP_DAYS, list, counts, softDelete, restore, purge, purgeOld };