// routes/orders/abandoned-cart/report/report.js
const express = require("express");
const router = express.Router();

const authorizationControllers = require("../../../../controllers/authorization/authorization");
const connection_pool = require("../../../../config/database/connection_pool");
const config = require("../../../../config/config");
const configDatabase = config.get("configDatabase");
const logging = require("../../../../logging/logging");
const acLogger = require("../../../../logging/abandoned-cart-logger");

const P = configDatabase.prefix;

// GET сторінка звіту
router.get("/orders/abandoned-cart/report/", authorizationControllers.isAuthenticated, (req, res) => {
  res.render("pages/orders/abandoned-cart/report/index", {
    i18n: req,
    user: req.user,
    header: { navbar: "abandoned-cart-report" },
  });
});

// POST зведення (KPI + розбивки). Фільтр за датами: {from, to} 'YYYY-MM-DD'
router.post("/api/orders/abandoned-cart/report-summary/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const from = typeof req.body?.from === "string" ? req.body.from : null;
    const to = typeof req.body?.to === "string" ? req.body.to : null;
    const range = [];
    let where = "1=1";
    if (from) {
      where += " AND l.date_add >= ?";
      range.push(from + " 00:00:00");
    }
    if (to) {
      where += " AND l.date_add <= ?";
      range.push(to + " 23:59:59");
    }

    // Відправки (status: 1=success, 2=error)
    const [[send]] = await connection_pool.query(
      `SELECT
         COUNT(*) AS total,
         SUM(status=1) AS success,
         SUM(status=2) AS failed
       FROM \`${P}orders_abandoned_cart_log\` l
       WHERE ${where}`,
      range
    );

    // Розбивка по каналах
    const [byChannel] = await connection_pool.query(
      `SELECT channel, COUNT(*) AS c, SUM(status=1) AS ok
       FROM \`${P}orders_abandoned_cart_log\` l
       WHERE ${where} GROUP BY channel`,
      range
    );

    // Стан черги (без діапазону — це моментний зріз)
    const [queue] = await connection_pool.query(
      `SELECT status, COUNT(*) AS c
       FROM \`${P}orders_abandoned_cart_queue\` GROUP BY status`
    );

    // Воронка кошиків (моментний зріз)
    const [carts] = await connection_pool.query(
      `SELECT status, COUNT(*) AS c
       FROM \`${P}orders_abandoned_cart\` GROUP BY status`
    );

    const cartMap = {};
    for (const r of carts) cartMap[r.status] = Number(r.c);
    const recovered = cartMap.recovered || 0;
    const denom = (cartMap.abandoned || 0) + (cartMap.notified || 0) + recovered + (cartMap.expired || 0);
    const recovery_rate = denom > 0 ? Math.round((recovered * 1000) / denom) / 10 : 0;

    const sent = Number(send.success || 0);
    const failed = Number(send.failed || 0);
    const totalSends = Number(send.total || 0);

    return res.status(200).json({
      range: { from, to },
      sends: {
        total: totalSends,
        success: sent,
        failed,
        success_rate: totalSends > 0 ? Math.round((sent * 1000) / totalSends) / 10 : 0,
      },
      by_channel: byChannel.map((r) => ({
        channel: r.channel,
        total: Number(r.c),
        success: Number(r.ok || 0),
      })),
      queue: queue.reduce((a, r) => ((a[r.status] = Number(r.c)), a), {}),
      carts: cartMap,
      recovery_rate,
    });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

// POST сирі події з JSONL (drill-down)
router.post("/api/orders/abandoned-cart/report-events/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const { from, to, type, correlation_id, cart_id, event_id, limit } = req.body || {};
    const events = acLogger.readEvents({
      from: from || null,
      to: to || null,
      type: type || null,
      correlation_id: correlation_id || null,
      cart_id: cart_id != null ? Number(cart_id) : null,
      event_id: event_id != null ? Number(event_id) : null,
      limit: Math.min(Number(limit) || 500, 5000),
    });
    // найновіші зверху
    events.reverse();
    return res.status(200).json({ count: events.length, events });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

// GET сторінка логів однієї події (самодостатня; ?event_id= або :id у URL)
router.get("/orders/abandoned-cart/event/:id/logs/", authorizationControllers.isAuthenticated, (req, res) => {
  res.render("pages/orders/abandoned-cart/logs/index", {
    i18n: req,
    user: req.user,
    header: { navbar: "abandoned-cart-event" },
    event_id: req.params.id,
  });
});

// POST логи відправок з БД (авторитетне джерело: таблиця log + черга)
router.post("/api/orders/abandoned-cart/event-logs/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const event_id = Number(req.body?.event_id);
    if (!event_id) return res.status(400).json({ message: "Не вказано event_id." });
    const limit = Math.min(Number(req.body?.limit) || 200, 2000);

    // логи відправок
    const [logs] = await connection_pool.query(
      `SELECT l.id, l.cart_id, l.service_id, l.channel, l.recipient, l.message,
              l.status, l.http_status, l.request, l.response, l.sent_at, l.date_add
       FROM \`${P}orders_abandoned_cart_log\` l
       WHERE l.event_id = ?
       ORDER BY l.id DESC
       LIMIT ?`,
      [event_id, limit]
    );

    // моментний стан черги по цій події (доставка)
    const [queue] = await connection_pool.query(
      `SELECT id, cart_id, attempt_no, status, correlation_id, recipient,
              provider_message_ids, delivery_status, delivery_extra, delivery_final,
              delivery_checked_at, sent_at, run_after, attempts, last_error
       FROM \`${P}orders_abandoned_cart_queue\`
       WHERE event_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      [event_id, limit]
    );

    const rows = logs.map((r) => {
      let correlation_id = null;
      try {
        const req = typeof r.request === "string" ? JSON.parse(r.request) : r.request;
        correlation_id = req?.correlation_id ?? null;
      } catch {}
      return {
        id: r.id,
        cart_id: r.cart_id,
        channel: r.channel,
        recipient: r.recipient,
        message: r.message,
        success: r.status === 1,
        http_status: r.http_status,
        correlation_id,
        sent_at: r.sent_at,
        date_add: r.date_add,
      };
    });

    return res.status(200).json({ logs: rows, queue });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

module.exports = router;
