// routes/orders/abandoned-cart/dispatch/dispatch.js
// Зведення розсилок по кошиках: список кошиків + агрегати по відправках,
// і деталізація всіх відправлень одного кошика.

const express = require("express");
const router = express.Router();

const authorizationControllers = require("../../../../controllers/authorization/authorization");
const connection_pool = require("../../../../config/database/connection_pool");
const config = require("../../../../config/config");
const configDatabase = config.get("configDatabase");
const logging = require("../../../../logging/logging");

const P = configDatabase.prefix;

// Технічну помилку черги → людською мовою
function humanizeError(err) {
  if (!err) return null;
  const s = String(err).toLowerCase();
  if (s.includes("invalid phone")) return "Некоректний або відсутній телефон";
  if (s.includes("cart status")) return "Кошик закрито (відновлено або прострочено)";
  if (s.includes("not supported")) return "Провайдер не підтримується";
  if (s.includes("auth")) return "Помилка авторизації сервісу (токен)";
  if (s.includes("no_money") || s.includes("недостат")) return "Недостатньо коштів на балансі сервісу";
  if (s.includes("bad_sender")) return "Некоректне ім'я відправника";
  if (s.includes("bad_text")) return "Некоректний текст повідомлення";
  if (s.includes("no_valid_phone")) return "Провайдер відхилив номер";
  if (s.includes("rate")) return "Перевищено ліміт запитів до сервісу";
  if (s.includes("timeout") || s.includes("network")) return "Сервіс недоступний (мережа/таймаут)";
  return err.length > 80 ? err.slice(0, 80) + "…" : err;
}

// GET сторінка
router.get("/orders/abandoned-cart/dispatch/", authorizationControllers.isAuthenticated, (req, res) => {
  res.render("pages/orders/abandoned-cart/dispatch/index", {
    i18n: req,
    user: req.user,
    header: { navbar: "abandoned-cart-dispatch" },
  });
});

// POST зведення по кошиках (кошик + агрегати з log + доставка з queue)
router.post("/api/orders/abandoned-cart/dispatch-list/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const [rows] = await connection_pool.query(
      `
      SELECT
        ac.id,
        ac.status AS cart_status,
        ac.total_amount,
        ac.currency,
        ac.last_activity_at,
        JSON_UNQUOTE(JSON_EXTRACT(ac.cart, '$.customer.firstname')) AS firstname,
        JSON_UNQUOTE(JSON_EXTRACT(ac.cart, '$.customer.lastname'))  AS lastname,
        JSON_UNQUOTE(JSON_EXTRACT(ac.cart, '$.customer.email'))     AS email,
        JSON_UNQUOTE(JSON_EXTRACT(ac.cart, '$.customer.telephone')) AS telephone,
        COALESCE(lg.sent_total, 0)   AS sent_total,
        COALESCE(lg.ok_total, 0)     AS ok_total,
        COALESCE(lg.auto_total, 0)   AS auto_total,
        COALESCE(lg.manual_total, 0) AS manual_total,
        COALESCE(lg.repeat_total, 0) AS repeat_total,
        lg.last_sent_at,
        q.delivery_status,
        q.delivery_extra,
        f.fail_status,
        f.last_error
      FROM \`${P}orders_abandoned_cart\` ac
      LEFT JOIN (
        SELECT
          cart_id,
          COUNT(*)                                    AS sent_total,
          SUM(status = 1)                             AS ok_total,
          SUM(source = 'auto')                        AS auto_total,
          SUM(source = 'manual')                      AS manual_total,
          SUM(attempt_no >= 2)                        AS repeat_total,
          MAX(sent_at)                                AS last_sent_at
        FROM \`${P}orders_abandoned_cart_log\`
        GROUP BY cart_id
      ) lg ON lg.cart_id = ac.id
      LEFT JOIN (
        SELECT q1.cart_id, q1.delivery_status, q1.delivery_extra
        FROM \`${P}orders_abandoned_cart_queue\` q1
        JOIN (
          SELECT cart_id, MAX(id) AS max_id
          FROM \`${P}orders_abandoned_cart_queue\`
          WHERE status = 'sent'
          GROUP BY cart_id
        ) q2 ON q2.cart_id = q1.cart_id AND q2.max_id = q1.id
      ) q ON q.cart_id = ac.id
      LEFT JOIN (
        SELECT f1.cart_id, f1.status AS fail_status, f1.last_error
        FROM \`${P}orders_abandoned_cart_queue\` f1
        JOIN (
          SELECT cart_id, MAX(id) AS max_id
          FROM \`${P}orders_abandoned_cart_queue\`
          WHERE status IN ('failed','skipped')
          GROUP BY cart_id
        ) f2 ON f2.cart_id = f1.cart_id AND f2.max_id = f1.id
      ) f ON f.cart_id = ac.id
      ORDER BY ac.id DESC
      `
    );

    const result = rows.map((r) => ({
      id: r.id,
      cart_status: r.cart_status,
      total_amount: r.total_amount,
      currency: r.currency,
      last_activity_at: r.last_activity_at ? new Date(r.last_activity_at).toLocaleString("uk-UA") : "",
      customer: {
        firstname: r.firstname || "",
        lastname: r.lastname || "",
        email: r.email || "",
        telephone: r.telephone || "",
      },
      sent_total: Number(r.sent_total),
      ok_total: Number(r.ok_total),
      auto_total: Number(r.auto_total),
      manual_total: Number(r.manual_total),
      repeat_total: Number(r.repeat_total),
      last_sent_at: r.last_sent_at ? new Date(r.last_sent_at).toLocaleString("uk-UA") : "",
      delivery_status: r.delivery_status || null,
      delivery_extra: r.delivery_extra || null,
      fail_status: r.fail_status || null,
      fail_reason: humanizeError(r.last_error),
    }));

    return res.status(200).json(result);
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

// POST деталі однієї розсилки: всі відправлення конкретного кошика
router.post("/api/orders/abandoned-cart/dispatch-detail/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const cart_id = Number(req.body?.cart_id);
    if (!cart_id) return res.status(400).json({ message: "Не вказано cart_id." });

    const [logs] = await connection_pool.query(
      `
      SELECT
        l.id, l.event_id, l.attempt_no, l.source, l.channel,
        l.recipient, l.message, l.status, l.http_status, l.sent_at, l.date_add,
        e.name AS event_name
      FROM \`${P}orders_abandoned_cart_log\` l
      LEFT JOIN \`${P}orders_abandoned_cart_events\` e ON e.id = l.event_id
      WHERE l.cart_id = ?
      ORDER BY l.id DESC
      `,
      [cart_id]
    );

    const result = logs.map((r) => ({
      id: r.id,
      event_id: r.event_id,
      event_name: r.event_name || "—",
      attempt_no: r.attempt_no,
      source: r.source,
      channel: r.channel,
      recipient: r.recipient,
      message: r.message,
      success: r.status === 1,
      http_status: r.http_status,
      sent_at: r.sent_at ? new Date(r.sent_at).toLocaleString("uk-UA") : "",
      date_add: r.date_add ? new Date(r.date_add).toLocaleString("uk-UA") : "",
    }));

    return res.status(200).json({ cart_id, logs: result });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

module.exports = router;
