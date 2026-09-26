const express = require("express");
const router = express.Router();

// Controllers
const authorizationControllers = require("../../../controllers/authorization/authorization");
// END Controllers

//Database connection
const connection = require("../../../config/database/database");
const connection_pool = require("../../../config/database/connection_pool");
//END Database connection

// Configuration
const config = require("../../../config/config");
const configDatabase = config.get("configDatabase");
// END Configuration

// Logging
const logging = require("../../../logging/logging");
// END Logging

const P = configDatabase.prefix;

/* ------------------------------------------------------------------ */
/* Хелпери                                                             */
/* ------------------------------------------------------------------ */

const MAX_RANGE_DAYS = 400; // захист від запиту "за все життя"
const CACHE_TTL_MS = 60 * 1000; // 60 сек кеш відповідей

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.v;
}

function cacheSet(key, value) {
  if (cache.size > 500) cache.clear();
  cache.set(key, { t: Date.now(), v: value });
}

function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}

function toDay(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/** Нормалізує значення дати з MySQL (Date або 'YYYY-MM-DD') у 'YYYY-MM-DD' */
function dayKey(v) {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  return toDay(v);
}

function isValidDay(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

/**
 * Нормалізація фільтрів з body. Нічого з body не йде в SQL напряму —
 * тільки числа, дати формату YYYY-MM-DD та значення з білого списку.
 */
function parseFilters(body) {
  const b = body || {};

  let date_to = isValidDay(b.date_to) ? b.date_to : toDay(new Date());
  let date_from = isValidDay(b.date_from) ? b.date_from : null;

  if (!date_from) {
    const d = new Date(date_to);
    d.setDate(d.getDate() - 29);
    date_from = toDay(d);
  }

  if (date_from > date_to) {
    const tmp = date_from;
    date_from = date_to;
    date_to = tmp;
  }

  // обмеження діапазону
  const days = Math.round((Date.parse(date_to) - Date.parse(date_from)) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) {
    const d = new Date(date_to);
    d.setDate(d.getDate() - (MAX_RANGE_DAYS - 1));
    date_from = toDay(d);
  }

  // Перемикач сайтів: масив id або null = всі
  let integrations = null;
  if (Array.isArray(b.integrations)) {
    integrations = b.integrations
      .map((v) => parseInt(v, 10))
      .filter((v) => Number.isInteger(v) && v >= 0)
      .slice(0, 50); // не даємо зібрати монстра з 1000 сайтів в одному IN
    if (!integrations.length) integrations = null;
  } else if (b.id_integration !== undefined && b.id_integration !== null && b.id_integration !== "all") {
    const v = parseInt(b.id_integration, 10);
    if (Number.isInteger(v) && v >= 0) integrations = [v];
  }

  // Гранулярність
  const granularity = ["day", "week", "month"].includes(b.granularity) ? b.granularity : "day";

  // Розрізи "по сайтах окремо" чи "сумарно"
  const split_by_integration = b.split_by_integration === true || b.split_by_integration === "true";

  const limit = Math.min(Math.max(parseInt(b.limit, 10) || 10, 1), 50);

  return { date_from, date_to, integrations, granularity, split_by_integration, limit };
}

/** Фрагмент WHERE по інтеграціях + параметри */
function integrationClause(integrations, alias) {
  const a = alias ? alias + "." : "";
  if (!integrations) return { sql: "", params: [] };
  return {
    sql: ` AND ${a}id_integration IN (${integrations.map(() => "?").join(",")})`,
    params: integrations.slice(),
  };
}

/** Вираз групування періоду для ECharts (день/тиждень/місяць) */
function periodExpr(granularity, alias) {
  const a = alias ? alias + "." : "";
  if (granularity === "month") return `DATE_FORMAT(${a}day, '%Y-%m-01')`;
  if (granularity === "week") return `DATE_SUB(${a}day, INTERVAL WEEKDAY(${a}day) DAY)`;
  return `${a}day`;
}

/** Заповнення пропущених періодів нулями — інакше лінія в ECharts рветься */
function buildPeriods(date_from, date_to, granularity) {
  const out = [];
  let cur = new Date(date_from + "T00:00:00");
  const end = new Date(date_to + "T00:00:00");

  if (granularity === "month") cur.setDate(1);
  if (granularity === "week") cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7));

  while (cur <= end) {
    out.push(toDay(cur));
    if (granularity === "month") cur.setMonth(cur.getMonth() + 1);
    else if (granularity === "week") cur.setDate(cur.getDate() + 7);
    else cur.setDate(cur.getDate() + 1);
    if (out.length > 1000) break;
  }
  return out;
}

function num(v) {
  return v === null || v === undefined ? 0 : Number(v);
}

function makeCacheKey(name, f) {
  return name + "|" + f.date_from + "|" + f.date_to + "|" + (f.integrations ? f.integrations.join(",") : "all") + "|" + f.granularity + "|" + f.split_by_integration + "|" + f.limit;
}

/* ------------------------------------------------------------------ */
/* GET                                                                 */
/* ------------------------------------------------------------------ */

router.get("/analytics/", authorizationControllers.isAuthenticated, (req, res) => {
  res.render("pages/analytics/index", {
    i18n: req,
    user: req.user,
    header: {
      navbar: "analytics",
    },
  });
});

/* ------------------------------------------------------------------ */
/* POST                                                                */
/* ------------------------------------------------------------------ */

/**
 * Список сайтів для перемикача.
 * Повертає тільки ті, де реально є дані — при 1000 інтеграцій це критично.
 */
router.post("/api/analytics/integrations/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const [rows] = await connection_pool.query(
      `SELECT i.id, i.name, i.platform, i.base_url, i.status,
                    COALESCE(s.orders_count, 0) AS orders_count,
                    s.last_day
               FROM ${P}orders_integrations i
               LEFT JOIN (
                    SELECT id_integration, SUM(orders_count) AS orders_count, MAX(day) AS last_day
                      FROM ${P}orders_stats_daily
                     GROUP BY id_integration
               ) s ON s.id_integration = i.id
              WHERE i.status = 'active'
              ORDER BY orders_count DESC, i.name ASC
              LIMIT 1000`
    );

    return res.status(200).json({
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        platform: r.platform,
        base_url: r.base_url,
        orders_count: num(r.orders_count),
        last_day: r.last_day,
      })),
    });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

/**
 * KPI-картки + порівняння з попереднім періодом такої ж довжини.
 */
router.post("/api/analytics/summary/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const f = parseFilters(req.body);
    const key = makeCacheKey("summary", f);
    const cached = cacheGet(key);
    if (cached) return res.status(200).json(cached);

    const ic = integrationClause(f.integrations);

    // Попередній період
    const lenDays = Math.round((Date.parse(f.date_to) - Date.parse(f.date_from)) / 86400000) + 1;
    const prevTo = new Date(f.date_from + "T00:00:00");
    prevTo.setDate(prevTo.getDate() - 1);
    const prevFrom = new Date(prevTo);
    prevFrom.setDate(prevFrom.getDate() - (lenDays - 1));

    const sql =
      `SELECT SUM(orders_count) AS orders_count,
                    SUM(orders_valid) AS orders_valid,
                    SUM(orders_canceled) AS orders_canceled,
                    SUM(revenue_gross_base) AS revenue,
                    SUM(refunded_base) AS refunded,
                    SUM(fees_base) AS fees,
                    SUM(discount_base) AS discount,
                    SUM(items_qty) AS items_qty,
                    SUM(new_clients) AS new_clients
               FROM ${P}orders_stats_daily
              WHERE day BETWEEN ? AND ?` + ic.sql;

    const [[cur]] = await connection_pool.query(sql, [f.date_from, f.date_to, ...ic.params]);
    const [[prev]] = await connection_pool.query(sql, [toDay(prevFrom), toDay(prevTo), ...ic.params]);

    function block(r) {
      const revenue = num(r.revenue);
      const valid = num(r.orders_valid);
      return {
        orders_count: num(r.orders_count),
        orders_valid: valid,
        orders_canceled: num(r.orders_canceled),
        revenue: revenue,
        refunded: num(r.refunded),
        fees: num(r.fees),
        discount: num(r.discount),
        net_revenue: revenue - num(r.refunded) - num(r.fees),
        items_qty: num(r.items_qty),
        new_clients: num(r.new_clients),
        avg_check: valid > 0 ? revenue / valid : 0,
        cancel_rate: num(r.orders_count) > 0 ? (num(r.orders_canceled) / num(r.orders_count)) * 100 : 0,
      };
    }

    const current = block(cur);
    const previous = block(prev);

    const delta = {};
    Object.keys(current).forEach((k) => {
      const a = current[k],
        b = previous[k];
      delta[k] = b > 0 ? ((a - b) / b) * 100 : a > 0 ? 100 : 0;
    });

    const payload = {
      period: { date_from: f.date_from, date_to: f.date_to },
      previous_period: { date_from: toDay(prevFrom), date_to: toDay(prevTo) },
      current,
      previous,
      delta,
    };

    cacheSet(key, payload);
    return res.status(200).json(payload);
  } catch (error) {
    logging.error(error);
    console.log(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

/**
 * Динаміка виручки/замовлень. Готовий payload для ECharts.
 * split_by_integration = true → окрема серія на кожен сайт (перемикач "порівняти сайти").
 */
router.post("/api/analytics/timeseries/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const f = parseFilters(req.body);
    const key = makeCacheKey("timeseries", f);
    const cached = cacheGet(key);
    if (cached) return res.status(200).json(cached);

    const ic = integrationClause(f.integrations);
    const pexpr = periodExpr(f.granularity);
    const periods = buildPeriods(f.date_from, f.date_to, f.granularity);

    let rows;

    if (f.split_by_integration) {
      [rows] = await connection_pool.query(
        `SELECT ${pexpr} AS p, s.id_integration,
                                                SUM(s.revenue_gross_base) AS revenue,
                        SUM(s.orders_valid) AS orders
                   FROM ${P}orders_stats_daily s
                  WHERE s.day BETWEEN ? AND ?` +
          integrationClause(f.integrations, "s").sql +
          `
                  GROUP BY p, s.id_integration
                  ORDER BY p ASC`,
        [f.date_from, f.date_to, ...ic.params]
      );
    } else {
      [rows] = await connection_pool.query(
        `SELECT ${pexpr} AS p,
                        SUM(revenue_gross_base) AS revenue,
                        SUM(orders_valid) AS orders,
                        SUM(refunded_base) AS refunded
                   FROM ${P}orders_stats_daily
                  WHERE day BETWEEN ? AND ?` +
          ic.sql +
          `
                  GROUP BY p
                  ORDER BY p ASC`,
        [f.date_from, f.date_to, ...ic.params]
      );
    }

    // Назви сайтів для легенди
    let names = {};
    if (f.split_by_integration) {
      const [ints] = await connection_pool.query(`SELECT id, name FROM ${P}orders_integrations`);
      ints.forEach((i) => {
        names[i.id] = i.name;
      });
    }

    const idx = {};
    periods.forEach((p, i) => {
      idx[p] = i;
    });

    let series;

    if (f.split_by_integration) {
      const byInt = {};
      rows.forEach((r) => {
        const day = dayKey(r.p);
        const id = r.id_integration;
        if (!byInt[id]) {
          byInt[id] = { revenue: new Array(periods.length).fill(0), orders: new Array(periods.length).fill(0) };
        }
        const i = idx[day];
        if (i !== undefined) {
          byInt[id].revenue[i] = num(r.revenue);
          byInt[id].orders[i] = num(r.orders);
        }
      });

      series = [];
      Object.keys(byInt).forEach((id) => {
        series.push({
          name: (names[id] || "Сайт #" + id) + " — виручка",
          type: "line",
          smooth: true,
          id_integration: Number(id),
          metric: "revenue",
          data: byInt[id].revenue,
        });
      });
    } else {
      const revenue = new Array(periods.length).fill(0);
      const orders = new Array(periods.length).fill(0);
      const refunded = new Array(periods.length).fill(0);

      rows.forEach((r) => {
        const i = idx[dayKey(r.p)];
        if (i === undefined) return;
        revenue[i] = num(r.revenue);
        orders[i] = num(r.orders);
        refunded[i] = num(r.refunded);
      });

      series = [
        { name: "Виручка", type: "line", smooth: true, yAxisIndex: 0, metric: "revenue", data: revenue },
        { name: "Повернення", type: "line", smooth: true, yAxisIndex: 0, metric: "refunded", data: refunded },
        { name: "Замовлення", type: "bar", yAxisIndex: 1, metric: "orders", data: orders },
      ];
    }

    const payload = {
      granularity: f.granularity,
      xAxis: periods,
      legend: series.map((s) => s.name),
      series,
    };

    cacheSet(key, payload);
    return res.status(200).json(payload);
  } catch (error) {
    console.log(error);
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

/**
 * Розподіл по статусах (pie). Кольори беремо з orders_status —
 * ECharts їх застосує напряму.
 */
router.post("/api/analytics/statuses/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const f = parseFilters(req.body);
    const key = makeCacheKey("statuses", f);
    const cached = cacheGet(key);
    if (cached) return res.status(200).json(cached);

    const ic = integrationClause(f.integrations, "s");
    const idLang = parseInt(req.body && req.body.id_lang, 10) || 2;

    const [rows] = await connection_pool.query(
      `SELECT s.id_status,
                    SUM(s.orders_count) AS orders_count,
                    SUM(s.revenue_base) AS revenue,
                    st.color_background, st.color_text, st.icon,
                    COALESCE(sl.text, CONCAT('#', s.id_status)) AS name
               FROM ${P}orders_stats_daily_status s
               LEFT JOIN ${P}orders_status st ON st.id = s.id_status
               LEFT JOIN ${P}orders_status_lang sl ON sl.id_status = s.id_status AND sl.id_lang = ?
              WHERE s.day BETWEEN ? AND ?` +
        ic.sql +
        `
              GROUP BY s.id_status, st.color_background, st.color_text, st.icon, sl.text
              ORDER BY orders_count DESC`,
      [idLang, f.date_from, f.date_to, ...ic.params]
    );

    const payload = {
      data: rows.map((r) => ({
        id_status: r.id_status,
        name: r.name,
        value: num(r.orders_count),
        revenue: num(r.revenue),
        itemStyle: { color: r.color_background || "#95a5a6" },
      })),
    };

    cacheSet(key, payload);
    return res.status(200).json(payload);
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

/**
 * Канали продажів (web/phone/marketplace/instagram) — bar.
 */
router.post("/api/analytics/channels/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const f = parseFilters(req.body);
    const key = makeCacheKey("channels", f);
    const cached = cacheGet(key);
    if (cached) return res.status(200).json(cached);

    const ic = integrationClause(f.integrations);

    const [rows] = await connection_pool.query(
      `SELECT source_channel,
                    SUM(orders_count) AS orders_count,
                    SUM(revenue_base) AS revenue
               FROM ${P}orders_stats_daily_channel
              WHERE day BETWEEN ? AND ?` +
        ic.sql +
        `
              GROUP BY source_channel
              ORDER BY revenue DESC
              LIMIT 30`,
      [f.date_from, f.date_to, ...ic.params]
    );

    const payload = {
      xAxis: rows.map((r) => r.source_channel || "—"),
      series: [
        { name: "Виручка", type: "bar", data: rows.map((r) => num(r.revenue)) },
        { name: "Замовлення", type: "bar", data: rows.map((r) => num(r.orders_count)) },
      ],
    };

    cacheSet(key, payload);
    return res.status(200).json(payload);
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

/**
 * ТОП товарів — horizontal bar.
 */
router.post("/api/analytics/top-products/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const f = parseFilters(req.body);
    const key = makeCacheKey("topproducts", f);
    const cached = cacheGet(key);
    if (cached) return res.status(200).json(cached);

    const ic = integrationClause(f.integrations);

    // Визначаємо метрику з тіла запиту
    const metric = req.body.metric === "qty" ? "qty" : "revenue";
    const orderBy = metric === "qty" ? "p_qty" : "p_revenue";

    const [rows] = await connection_pool.query(
      `SELECT sku,
              MAX(name) AS p_name,
              SUM(qty) AS p_qty,
              SUM(revenue_base) AS p_revenue
         FROM ${P}orders_stats_daily_product
        WHERE day BETWEEN ? AND ?` +
        ic.sql +
        `
        GROUP BY sku
        ORDER BY ${orderBy} DESC
        LIMIT ?`,
      [f.date_from, f.date_to, ...ic.params, f.limit]
    );

    // ECharts horizontal bar читає знизу вгору
    rows.reverse();

    const payload = {
      yAxis: rows.map((r) => r.p_name || r.sku),
      series: [
        {
          name: metric === "qty" ? "Кількість" : "Виручка",
          type: "bar",
          data: rows.map((r) => (metric === "qty" ? num(r.p_qty) : num(r.p_revenue))),
        },
      ],
      raw: rows.map((r) => ({
        sku: r.sku,
        name: r.p_name,
        qty: num(r.p_qty),
        revenue: num(r.p_revenue),
      })),
    };

    cacheSet(key, payload);
    return res.status(200).json(payload);
  } catch (error) {
    logging.error(error);
    console.log(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

/**
 * Воронка статусів — середній час перебування + скільки дійшло до кінця.
 * Тут читаємо status_history, тому жорстко обмежуємо вибірку по даті.
 */
router.post("/api/analytics/funnel/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const f = parseFilters(req.body);
    const key = makeCacheKey("funnel", f);
    const cached = cacheGet(key);
    if (cached) return res.status(200).json(cached);

    const ic = integrationClause(f.integrations, "o");
    const idLang = parseInt(req.body && req.body.id_lang, 10) || 2;

    const [rows] = await connection_pool.query(
      `SELECT h.id_status,
                    COUNT(DISTINCT h.id_order) AS orders_count,
                    AVG(h.duration_sec) AS avg_sec,
                    COALESCE(sl.text, CONCAT('#', h.id_status)) AS name,
                    st.color_background
               FROM ${P}orders_status_history h
               JOIN ${P}orders o ON o.id = h.id_order
               LEFT JOIN ${P}orders_status st ON st.id = h.id_status
               LEFT JOIN ${P}orders_status_lang sl ON sl.id_status = h.id_status AND sl.id_lang = ?
              WHERE o.date_order_day BETWEEN ? AND ?
                AND o.deleted_at IS NULL` +
        ic.sql +
        `
              GROUP BY h.id_status, sl.text, st.color_background
              ORDER BY orders_count DESC`,
      [idLang, f.date_from, f.date_to, ...ic.params]
    );

    const payload = {
      data: rows.map((r) => ({
        name: r.name,
        value: num(r.orders_count),
        avg_hours: r.avg_sec ? Math.round(num(r.avg_sec) / 36) / 100 : null,
        itemStyle: { color: r.color_background || "#95a5a6" },
      })),
    };

    cacheSet(key, payload);
    return res.status(200).json(payload);
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

/**
 * Кинуті кошики: конверсія відновлення.
 */
router.post("/api/analytics/abandoned-carts/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const f = parseFilters(req.body);
    const key = makeCacheKey("carts", f);
    const cached = cacheGet(key);
    if (cached) return res.status(200).json(cached);

    const ic = integrationClause(f.integrations);

    const [rows] = await connection_pool.query(
      `SELECT status,
                    COUNT(*) AS cnt,
                    SUM(total_amount) AS amount
               FROM ${P}orders_abandoned_cart
              WHERE DATE(first_seen_at) BETWEEN ? AND ?` +
        ic.sql +
        `
              GROUP BY status`,
      [f.date_from, f.date_to, ...ic.params]
    );

    let total = 0,
      recovered = 0,
      lost = 0,
      recoveredAmount = 0;
    rows.forEach((r) => {
      total += num(r.cnt);
      if (r.status === "recovered") {
        recovered += num(r.cnt);
        recoveredAmount += num(r.amount);
      } else {
        lost += num(r.amount);
      }
    });

    const payload = {
      data: rows.map((r) => ({ name: r.status, value: num(r.cnt), amount: num(r.amount) })),
      total_carts: total,
      recovered_carts: recovered,
      recovery_rate: total > 0 ? (recovered / total) * 100 : 0,
      recovered_amount: recoveredAmount,
      lost_amount: lost,
    };

    cacheSet(key, payload);
    return res.status(200).json(payload);
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

/**
 * Здоров'я інтеграцій: невдалі inbox/outbox та відхилені токени.
 * Це не «продажі», але саме тут ловляться реальні втрати замовлень.
 */
router.post("/api/analytics/integration-health/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const f = parseFilters(req.body);
    const ic = integrationClause(f.integrations);

    const [[inbox]] = await connection_pool.query(
      `SELECT SUM(status='done') AS done,
                    SUM(status='failed') AS failed,
                    SUM(status='pending') AS pending
               FROM ${P}orders_inbox
              WHERE DATE(received_at) BETWEEN ? AND ?` + ic.sql,
      [f.date_from, f.date_to, ...ic.params]
    );

    const [[outbox]] = await connection_pool.query(
      `SELECT SUM(status='done') AS done,
                    SUM(status='failed') AS failed,
                    SUM(status='pending') AS pending
               FROM ${P}orders_outbox
              WHERE DATE(date_add) BETWEEN ? AND ?` + ic.sql,
      [f.date_from, f.date_to, ...ic.params]
    );

    const [tokens] = await connection_pool.query(
      `SELECT COALESCE(reject_reason,'success') AS reason, COUNT(*) AS cnt
               FROM ${P}orders_tokens_log
              WHERE DATE(date_add) BETWEEN ? AND ?
              GROUP BY reason
              ORDER BY cnt DESC
              LIMIT 20`,
      [f.date_from, f.date_to]
    );

    return res.status(200).json({
      inbox: { done: num(inbox.done), failed: num(inbox.failed), pending: num(inbox.pending) },
      outbox: { done: num(outbox.done), failed: num(outbox.failed), pending: num(outbox.pending) },
      token_reasons: tokens.map((r) => ({ name: r.reason, value: num(r.cnt) })),
    });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

module.exports = router;
