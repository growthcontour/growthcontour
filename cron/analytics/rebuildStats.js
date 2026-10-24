const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");

const P = config.get("configDatabase").prefix;

function toDay(d) {
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/**
 * Перерахунок агрегатів за діапазон дат.
 * Ідемпотентний — можна викликати повторно на тому ж діапазоні.
 */
async function rebuildRange(dFrom, dTo) {
  const conn = await connection_pool.getConnection();

  try {
    // Захист: замовлення зі статусом, якого немає в довіднику, випадуть
    // з JOIN і тихо зникнуть зі звітів. Краще дізнатись про це одразу.
    const [orphans] = await conn.query(
      `SELECT o.status, COUNT(*) cnt
                 FROM ${P}orders o
                 LEFT JOIN ${P}orders_status st ON st.id = o.status
                WHERE o.date_order_day BETWEEN ? AND ?
                  AND o.deleted_at IS NULL AND st.id IS NULL
                GROUP BY o.status`,
      [dFrom, dTo]
    );
    if (orphans.length) {
      logging.error(`[analytics] Замовлення з невідомим статусом: ` + orphans.map((o) => `#${o.status}×${o.cnt}`).join(", "));
    }

    /* ---------- Основний денний агрегат ---------- */
    await conn.query(
      `INSERT INTO ${P}orders_stats_daily
                (day, id_integration, orders_count, orders_valid, orders_confirmed,
                orders_canceled, revenue_gross_base, revenue_confirmed_base,
                refunded_base, fees_base, discount_base, shipping_base,
                items_qty, new_clients, date_edit)
             SELECT o.date_order_day,
                    COALESCE(o.id_integration, 0),
                    COUNT(*),
                    SUM(CASE WHEN st.is_negative = 0 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN st.count_in_revenue = 1 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN st.is_negative = 1 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN st.is_negative = 0 THEN o.total_base ELSE 0 END),
                    SUM(CASE WHEN st.count_in_revenue = 1 THEN o.total_base ELSE 0 END),
                                        SUM(o.total_refunded_base),
                    SUM(o.total_fees_base),
                    SUM(o.total_discount_base),
                    SUM(ROUND(o.total_shipping * o.currency_rate, 4)),
                    0, 0, NOW()
               FROM ${P}orders o
               JOIN ${P}orders_status st ON st.id = o.status
              WHERE o.date_order_day BETWEEN ? AND ?
                AND o.deleted_at IS NULL
              GROUP BY o.date_order_day, COALESCE(o.id_integration, 0)
             ON DUPLICATE KEY UPDATE
                orders_count = VALUES(orders_count),
                orders_valid = VALUES(orders_valid),
                orders_confirmed = VALUES(orders_confirmed),
                orders_canceled = VALUES(orders_canceled),
                revenue_gross_base = VALUES(revenue_gross_base),
                revenue_confirmed_base = VALUES(revenue_confirmed_base),
                refunded_base = VALUES(refunded_base),
                fees_base = VALUES(fees_base),
                discount_base = VALUES(discount_base),
                shipping_base = VALUES(shipping_base),
                date_edit = NOW()`,
      [dFrom, dTo]
    );

    // Обнулити дні, де замовлення зникли (видалені/soft-delete)
    await conn.query(
      `UPDATE ${P}orders_stats_daily s
                LEFT JOIN (
                    SELECT date_order_day AS d, COALESCE(id_integration,0) AS ii
                      FROM ${P}orders
                     WHERE date_order_day BETWEEN ? AND ? AND deleted_at IS NULL
                     GROUP BY 1,2
                ) o ON o.d = s.day AND o.ii = s.id_integration
                                SET s.orders_count = 0, s.orders_valid = 0, s.orders_confirmed = 0,
                                        s.orders_canceled = 0, s.revenue_gross_base = 0, s.revenue_confirmed_base = 0,
                    s.items_qty = 0, s.date_edit = NOW()
              WHERE s.day BETWEEN ? AND ? AND o.d IS NULL`,
      [dFrom, dTo, dFrom, dTo]
    );

    /* ---------- По статусах ---------- */
    await conn.query(`DELETE FROM ${P}orders_stats_daily_status WHERE day BETWEEN ? AND ?`, [dFrom, dTo]);
    await conn.query(
      `INSERT INTO ${P}orders_stats_daily_status
                (day, id_integration, id_status, orders_count, revenue_base)
             SELECT o.date_order_day, COALESCE(o.id_integration,0), o.status,
                    COUNT(*), SUM(o.total_base)
               FROM ${P}orders o
              WHERE o.date_order_day BETWEEN ? AND ? AND o.deleted_at IS NULL
              GROUP BY o.date_order_day, COALESCE(o.id_integration,0), o.status`,
      [dFrom, dTo]
    );

    /* ---------- По каналах ---------- */
    await conn.query(`DELETE FROM ${P}orders_stats_daily_channel WHERE day BETWEEN ? AND ?`, [dFrom, dTo]);
    await conn.query(
      `INSERT INTO ${P}orders_stats_daily_channel
                (day, id_integration, source_channel, orders_count, revenue_base)
             SELECT o.date_order_day, COALESCE(o.id_integration,0), COALESCE(o.source_channel,''),
                    COUNT(*), SUM(CASE WHEN st.is_negative = 0 THEN o.total_base ELSE 0 END)
               FROM ${P}orders o
               JOIN ${P}orders_status st ON st.id = o.status
              WHERE o.date_order_day BETWEEN ? AND ? AND o.deleted_at IS NULL
              GROUP BY o.date_order_day, COALESCE(o.id_integration,0), COALESCE(o.source_channel,'')`,
      [dFrom, dTo]
    );

    /* ---------- По товарах ---------- */
    await conn.query(`DELETE FROM ${P}orders_stats_daily_product WHERE day BETWEEN ? AND ?`, [dFrom, dTo]);
    await conn.query(
      `INSERT INTO ${P}orders_stats_daily_product
                (day, id_integration, sku, name, qty, revenue_base)
             SELECT o.date_order_day, COALESCE(o.id_integration,0),
                    COALESCE(NULLIF(i.sku,''), CONCAT('X-', i.external_product_id), '—'),
                    MAX(i.name), SUM(i.quantity), SUM(i.total_base)
               FROM ${P}orders_items i
               JOIN ${P}orders o ON o.id = i.id_order
               JOIN ${P}orders_status st ON st.id = o.status
              WHERE o.date_order_day BETWEEN ? AND ?
                AND o.deleted_at IS NULL AND st.is_negative = 0
              GROUP BY o.date_order_day, COALESCE(o.id_integration,0),
                       COALESCE(NULLIF(i.sku,''), CONCAT('X-', i.external_product_id), '—')`,
      [dFrom, dTo]
    );

    /* ---------- items_qty ---------- */
    await conn.query(
      `UPDATE ${P}orders_stats_daily s
                LEFT JOIN (SELECT day, id_integration, SUM(qty) q
                             FROM ${P}orders_stats_daily_product
                            WHERE day BETWEEN ? AND ?
                            GROUP BY day, id_integration) p
                  ON p.day = s.day AND p.id_integration = s.id_integration
                SET s.items_qty = COALESCE(p.q, 0)
              WHERE s.day BETWEEN ? AND ?`,
      [dFrom, dTo, dFrom, dTo]
    );

    /* ---------- Нові клієнти ---------- */
    await conn.query(
      `UPDATE ${P}orders_stats_daily s
                JOIN (SELECT DATE(first_order_at) d, COALESCE(id_integration,0) ii, COUNT(*) c
                      FROM ${P}orders_clients
                      WHERE DATE(first_order_at) BETWEEN ? AND ? AND deleted_at IS NULL
                      GROUP BY 1,2) c
                      ON c.d = s.day AND c.ii = s.id_integration
                SET s.new_clients = COALESCE(c.c, 0)
              WHERE s.day BETWEEN ? AND ?`,
      [dFrom, dTo, dFrom, dTo]
    );

    /* ---------- Каса: платежі ---------- */
    await conn.query(`DELETE FROM ${P}orders_stats_cash_daily WHERE day BETWEEN ? AND ?`, [dFrom, dTo]);
    await conn.query(
      `INSERT INTO ${P}orders_stats_cash_daily
                (day, id_integration, paid_base, payments_count, date_edit)
             SELECT DATE(p.paid_at), COALESCE(o.id_integration,0),
                    SUM(p.amount * o.currency_rate), COUNT(*), NOW()
               FROM ${P}orders_payments p
               JOIN ${P}orders o ON o.id = p.id_order
              WHERE p.paid_at IS NOT NULL
                AND DATE(p.paid_at) BETWEEN ? AND ?
                AND p.status = 'paid'
                AND o.deleted_at IS NULL
              GROUP BY DATE(p.paid_at), COALESCE(o.id_integration,0)`,
      [dFrom, dTo]
    );

    /* ---------- Каса: повернення ---------- */
    await conn.query(
      `INSERT INTO ${P}orders_stats_cash_daily
                (day, id_integration, refunded_base, refunds_count, date_edit)
             SELECT DATE(r.date_add), COALESCE(o.id_integration,0),
                    SUM(r.amount * o.currency_rate), COUNT(*), NOW()
               FROM ${P}orders_refunds r
               JOIN ${P}orders o ON o.id = r.id_order
              WHERE DATE(r.date_add) BETWEEN ? AND ?
                AND o.deleted_at IS NULL
              GROUP BY DATE(r.date_add), COALESCE(o.id_integration,0)
             ON DUPLICATE KEY UPDATE
                refunded_base = VALUES(refunded_base),
                refunds_count = VALUES(refunds_count),
                date_edit = NOW()`,
      [dFrom, dTo]
    );
  } finally {
    conn.release();
  }
}

/** Перерахунок останніх N днів */
async function rebuild(daysBack = 7) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - daysBack);
  await rebuildRange(toDay(from), toDay(to));
}

/** Backfill порціями по місяцю — для історії */
async function backfill(fromDay, toDay_) {
  let cur = new Date(fromDay + "T00:00:00");
  const end = new Date(toDay_ + "T00:00:00");

  while (cur <= end) {
    const next = new Date(cur);
    next.setMonth(next.getMonth() + 1);
    const chunkEnd = new Date(Math.min(next.getTime() - 86400000, end.getTime()));

    await rebuildRange(toDay(cur), toDay(chunkEnd));
    console.log("[backfill]", toDay(cur), "→", toDay(chunkEnd));

    cur = next;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Звірка агрегату з сирими даними */
async function verify(dFrom, dTo) {
  const [[c]] = await connection_pool.query(
    `SELECT
            (SELECT COALESCE(SUM(revenue_confirmed_base),0) FROM ${P}orders_stats_daily
              WHERE day BETWEEN ? AND ?) agg,
            (SELECT COALESCE(SUM(o.total_base),0) FROM ${P}orders o
               JOIN ${P}orders_status st ON st.id = o.status
              WHERE o.date_order_day BETWEEN ? AND ?
                AND o.deleted_at IS NULL AND st.count_in_revenue = 1) raw`,
    [dFrom, dTo, dFrom, dTo]
  );

  const diff = Math.abs(Number(c.agg) - Number(c.raw));
  if (diff > 0.01) {
    logging.error(`[analytics] РОЗБІЖНІСТЬ: агрегат ${c.agg} vs сирі ${c.raw}`);
    return false;
  }
  return true;
}

module.exports = { rebuild, rebuildRange, backfill, verify };
