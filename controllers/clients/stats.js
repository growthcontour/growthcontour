const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const service = require("./service");

const P = config.get("configDatabase").prefix;

/**
 * Перерахувати статистику клієнта з замовлень і лідів.
 * Рахує замовлення, де клієнт — покупець (id_client) або компанія-покупець (id_client_org).
 * Виручка — лише за статусами з count_in_revenue = 1.
 */
async function recalc(conn, idClient) {
	const q = conn || pool;
	const id = Number(idClient);
	if (!id) return;

	const [[o]] = await q.query(
		`SELECT COUNT(*) AS orders_count,
                COALESCE(SUM(s.count_in_revenue = 1), 0) AS orders_valid_count,
                COALESCE(SUM(IF(s.count_in_revenue = 1, o.total_base, 0)), 0) AS revenue_base,
                MIN(COALESCE(o.date_order, o.date_add)) AS first_order_at,
                MAX(COALESCE(o.date_order, o.date_add)) AS last_order_at
           FROM ${P}orders o
           LEFT JOIN ${P}orders_status s ON s.id = o.status
          WHERE (o.id_client = ? OR o.id_client_org = ?) AND o.deleted_at IS NULL`,
		[id, id]
	);
	const [[l]] = await q.query(
		`SELECT COUNT(*) AS leads_count, MAX(date_add) AS last_lead_at
           FROM ${P}leads
          WHERE (id_client = ? OR id_client_org = ?) AND deleted_at IS NULL`,
		[id, id]
	);

	const valid = Number(o.orders_valid_count) || 0;
	const revenue = Number(o.revenue_base) || 0;
	const avg = valid ? revenue / valid : 0;

	await q.query(
		`INSERT INTO ${P}clients_stats
            (id_client, orders_count, orders_valid_count, revenue_base, avg_order_base,
             first_order_at, last_order_at, leads_count, last_lead_at, date_recalc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
            orders_count = VALUES(orders_count),
            orders_valid_count = VALUES(orders_valid_count),
            revenue_base = VALUES(revenue_base),
            avg_order_base = VALUES(avg_order_base),
            first_order_at = VALUES(first_order_at),
            last_order_at = VALUES(last_order_at),
            leads_count = VALUES(leads_count),
            last_lead_at = VALUES(last_lead_at),
            date_recalc = NOW()`,
		[id, Number(o.orders_count) || 0, valid, revenue, avg, o.first_order_at, o.last_order_at, Number(l.leads_count) || 0, l.last_lead_at]
	);

	// Знову купив після «Втраченого» — повертаємо в покупці (стадія «лише вгору» тут не спрацює)
	await require("./rfm").unchurn(q, id, valid, o.last_order_at);

	// Стадія лише вгору
	if (valid >= 2) await service.upgradeLifecycle(id, "repeat_customer", q);
	else if (valid >= 1) await service.upgradeLifecycle(id, "customer", q);

	if (o.last_order_at) {
		await q.query(`UPDATE ${P}clients SET date_last_activity = GREATEST(COALESCE(date_last_activity, ?), ?) WHERE id = ?`, [o.last_order_at, o.last_order_at, id]);
	}
}

/** Перерахувати всіх клієнтів, пов'язаних із замовленням */
async function recalcForOrder(conn, orderId) {
	const q = conn || pool;
	const [[r]] = await q.query(`SELECT id_client, id_client_org FROM ${P}orders WHERE id = ? LIMIT 1`, [orderId]);
	if (!r) return;
	if (r.id_client) await recalc(q, r.id_client);
	if (r.id_client_org && r.id_client_org !== r.id_client) await recalc(q, r.id_client_org);
}

/** Перерахувати статистику всіх активних клієнтів (після зміни базової валюти, імпорту тощо) */
async function recalcAll() {
	const [rows] = await pool.query(`SELECT id FROM ${P}clients WHERE deleted_at IS NULL AND id_merged_into IS NULL`);
	for (const r of rows) await recalc(null, r.id);
	return rows.length;
}

module.exports = { recalc, recalcForOrder, recalcAll };
