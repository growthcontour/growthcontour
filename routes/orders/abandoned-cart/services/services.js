const express = require("express");
const crypto = require("crypto");
const router = express.Router();

// Controllers
const authorizationControllers = require("../../../../controllers/authorization/authorization");
const { readServiceConfig, normalizePhone } = require("../../../../controllers/orders/serviceConfig");
const smsclub = require("../../../../controllers/orders/providers/smsclub");
const { renderTemplate } = require("../../../../controllers/orders/renderTemplate");
// END Controllers

const connection = require("../../../../config/database/database");
const connection_pool = require("../../../../config/database/connection_pool");
//END Database connection

// Configuration
const config = require("../../../../config/config");
const configDatabase = config.get("configDatabase");
// END Configuration

// Logging
const logging = require("../../../../logging/logging");
const abandonedCartLogger = require("../../../../logging/abandoned-cart-logger");
// END Logging

const { getIO } = require("../../../../controllers/socket/socket");
const io = getIO();

// GET
router.get("/orders/abandoned-cart/services/", authorizationControllers.isAuthenticated, (req, res) => {
  res.render("pages/orders/abandoned-cart/services/index", {
    i18n: req,
    user: req.user,
    header: { navbar: "abandoned-cart-services" },
  });
});

// END GET

// POST
router.post("/api/orders/abandoned-cart/services-all/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const [rows] = await connection_pool.query(`
            SELECT id, channel, provider, name, logo_url, description, config_fields,
                   is_connected, is_default, active, sort_order, date_add, date_edit
            FROM \`${configDatabase.prefix}orders_abandoned_cart_services\`
            ORDER BY sort_order ASC, id ASC
        `);

    if (!rows.length) return res.status(404).json({ message: "Сервіси не знайдено." });

    const result = rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      provider: row.provider,
      name: row.name,
      logo_url: row.logo_url,
      description: row.description,
      config_fields: typeof row.config_fields === "string" ? JSON.parse(row.config_fields) : row.config_fields,
      // config не віддаємо — там токени
      is_connected: row.is_connected,
      is_default: row.is_default,
      active: row.active,
      sort_order: row.sort_order,
      date_add: row.date_add,
      date_edit: row.date_edit,
    }));

    return res.status(200).json(result);
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

// =====================================================
// POST Ручна відправка Viber (джерело тексту — events, не templates)
//   Приймає { cart_id, event_id }. template_id — backward-compat алиас.
// =====================================================
router.post("/api/orders/abandoned-cart/send-viber/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const cart_id = req.body.cart_id;
    const event_id = req.body.event_id ?? req.body.template_id;

    if (!cart_id || !event_id) return res.status(400).json({ message: "Потрібні cart_id та event_id." });

    const [cartRows] = await connection_pool.query(
      `
            SELECT * FROM \`${configDatabase.prefix}orders_abandoned_cart\` WHERE id = ?
        `,
      [cart_id]
    );
    if (!cartRows.length) return res.status(404).json({ message: "Кошик не знайдено." });

    const cartRow = cartRows[0];
    const cart = typeof cartRow.cart === "string" ? JSON.parse(cartRow.cart) : cartRow.cart;

    const telephone = cart.customer?.telephone;
    if (!telephone) return res.status(400).json({ message: "Телефон покупця відсутній." });

    const [eventRows] = await connection_pool.query(
      `
            SELECT e.message, e.service_id, s.config, s.config_fields, s.provider, s.channel
            FROM \`${configDatabase.prefix}orders_abandoned_cart_events\` e
            JOIN \`${configDatabase.prefix}orders_abandoned_cart_services\` s ON s.id = e.service_id
            WHERE e.id = ? AND s.is_connected = 1 AND s.active = 1
        `,
      [event_id]
    );
    if (!eventRows.length) return res.status(404).json({ message: "Подію або сервіс не знайдено / не підключено." });

    const ev = eventRows[0];
    const serviceConfig = readServiceConfig(ev); // {key:value}, токен розшифровано

    const phone = normalizePhone(telephone);
    if (!phone) return res.status(400).json({ message: "Некоректний номер телефону покупця." });

    // Idempotency: не слати повторно те саме за останні 5 хв (захист від подвійного кліку)
    const IDEMPOTENCY_MIN = 5;
    const [dup] = await connection_pool.query(
      `SELECT id, sent_at FROM \`${configDatabase.prefix}orders_abandoned_cart_log\`
       WHERE cart_id = ? AND event_id = ? AND status = 1
         AND sent_at >= (NOW() - INTERVAL ? MINUTE)
       ORDER BY id DESC LIMIT 1`,
      [cart_id, event_id, IDEMPOTENCY_MIN]
    );
    if (dup.length) {
      return res.status(409).json({
        message: `Це повідомлення вже відправлено ${IDEMPOTENCY_MIN} хв тому. Повторна відправка заблокована.`,
        code: "duplicate",
        last_sent_at: dup[0].sent_at,
      });
    }

    const { message, recovery_token } = await renderTemplate(ev.message, { ...cartRow, ...cart }, cart);

    const result = await smsclub.send(serviceConfig, { phones: [phone], message });
    const success = result.ok;
    const correlation_id = crypto.randomUUID();
    const payload = result.request; // для логу
    const providerResponse = result.response; // для логу
    const httpStatus = result.httpStatus ?? 0;

    await connection_pool.query(
      `
            INSERT INTO \`${configDatabase.prefix}orders_abandoned_cart_log\`
            (cart_id, event_id, attempt_no, source, service_id, channel, recipient, message, recovery_token,
             status, http_status, request, response, sent_at, date_add)
            VALUES (?, ?, 0, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `,
      [cart_id, event_id, ev.service_id ?? null, ev.channel ?? null, phone, message, recovery_token, success ? 1 : 2, httpStatus, JSON.stringify({ correlation_id, payload }), JSON.stringify(providerResponse), success ? new Date() : null]
    );

    abandonedCartLogger.event("send", {
      correlation_id,
      source: "manual",
      provider: ev.provider,
      result: success ? "success" : "error",
      cart_id,
      event_id,
      service_id: ev.service_id,
      channel: ev.channel,
      recipient: phone,
      http_status: httpStatus,
      code: result.code,
      retriable: result.retriable,
      provider_ids: result.messages.map((m) => m.id),
      request: payload,
      response: providerResponse,
    });

    if (!success) return res.status(400).json({ message: result.message, code: result.code, details: providerResponse });
    return res.status(200).json({ message: "Повідомлення відправлено.", provider_ids: result.messages.map((m) => m.id), response: providerResponse });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

router.post("/api/orders/abandoned-cart/events-run/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const { event_id } = req.body;
    if (!event_id) return res.status(400).json({ message: "Відсутній event_id." });

    const [eventRows] = await connection_pool.query(
      `
            SELECT e.id AS event_id, e.message AS template, s.id AS service_id, s.provider, s.channel, s.config, s.config_fields
            FROM \`${configDatabase.prefix}orders_abandoned_cart_events\` e
            JOIN \`${configDatabase.prefix}orders_abandoned_cart_services\` s ON s.id = e.service_id
            WHERE e.id = ? AND s.is_connected = 1 AND s.active = 1
        `,
      [event_id]
    );
    if (!eventRows.length) return res.status(404).json({ message: "Подію або сервіс не знайдено / не підключено." });

    const event = eventRows[0];
    const serviceConfig = readServiceConfig(event);

    const [cartRows] = await connection_pool.query(`
            SELECT id, cart, total_amount, currency, items_count, id_integration, store_id, session_id
            FROM \`${configDatabase.prefix}orders_abandoned_cart\`
            ORDER BY id DESC LIMIT 1
        `);
    if (!cartRows.length) return res.status(404).json({ message: "Покинутих кошиків не знайдено." });

    const cartRow = cartRows[0];
    const cart = typeof cartRow.cart === "string" ? JSON.parse(cartRow.cart) : cartRow.cart;

    const telephone = cart.customer?.telephone;
    if (!telephone) return res.status(400).json({ message: "Телефон покупця відсутній в кошику." });

    const phone = normalizePhone(telephone);
    if (!phone) return res.status(400).json({ message: "Некоректний номер телефону покупця." });

    const { message, recovery_token } = await renderTemplate(event.template, cartRow, cart);

    const SUPPORTED = new Set(["smsclub_viber", "smsclub_viber2"]);
    if (!SUPPORTED.has(event.provider)) {
      return res.status(400).json({ message: `Провайдер ${event.provider} не підтримується.` });
    }

    const result = await smsclub.send(serviceConfig, { phones: [phone], message });
    const success = result.ok;
    const correlation_id = crypto.randomUUID();
    const payload = result.request;
    const providerResponse = result.response;
    const httpStatus = result.httpStatus ?? 0;

    await connection_pool.query(
      `
            INSERT INTO \`${configDatabase.prefix}orders_abandoned_cart_log\`
            (cart_id, event_id, attempt_no, source, service_id, channel, recipient, message, recovery_token,
             status, http_status, request, response, sent_at, date_add)
            VALUES (?, ?, 0, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `,
      [cartRow.id, event.event_id, event.service_id ?? null, event.channel ?? null, phone, message, recovery_token, success ? 1 : 2, httpStatus, JSON.stringify({ correlation_id, payload }), JSON.stringify(providerResponse), success ? new Date() : null]
    );

    abandonedCartLogger.event("send", {
      correlation_id,
      source: "manual",
      provider: event.provider,
      result: success ? "success" : "error",
      event_id,
      cart_id: cartRow.id,
      service_id: event.service_id,
      channel: event.channel,
      recipient: phone,
      http_status: httpStatus,
      code: result.code,
      retriable: result.retriable,
      provider_ids: result.messages.map((m) => m.id),
      request: payload,
      response: providerResponse,
    });

    if (!success) return res.status(400).json({ message: result.message, code: result.code, details: providerResponse });
    return res.status(200).json({ message: "Повідомлення відправлено.", cart_id: cartRow.id, recipient: phone, provider_ids: result.messages.map((m) => m.id) });
  } catch (error) {
    logging.error(error);
    console.log(error);
    abandonedCartLogger.log("unknown", "error", { event_id: req.body?.event_id, error: error.message });
    return res.status(500).json({ message: "Помилка сервера." });
  }
});
// END POST

module.exports = router;
