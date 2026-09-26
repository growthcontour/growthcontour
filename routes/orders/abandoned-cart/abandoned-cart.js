const express = require("express");
const router = express.Router();

// Controllers
const authorizationControllers = require("../../../controllers/authorization/authorization");
// END Controllers

const connection_pool = require("../../../config/database/connection_pool");
//END Database connection

// Configuration
const config = require("../../../config/config");
const configDatabase = config.get("configDatabase");
// END Configuration

// Logging
const logging = require("../../../logging/logging");
// END Logging

const { getIO } = require("../../../controllers/socket/socket");
const io = getIO();

// Прийом кошиків із джерела (webhook) — токен-автентифікація
const { verifyOrderToken, logAttempt } = require("../../../controllers/orders/tokenAuth");
const { kickCartWorker } = require("../../../controllers/orders/cartInboxProcessor");
const cartReceiveValidator = require("../../../validator/orders/abandoned-cart");
const { cartRateLimit } = require("../../../controllers/orders/cartRateLimit");
const { SECRET_TYPES, parseJson, normalizeSchema, flattenSchema, configToObject, encryptSecret } = require("../../../controllers/orders/serviceConfig");

// =====================================================
// GET
// =====================================================
router.get("/orders/abandoned-cart/", authorizationControllers.isAuthenticated, (req, res) => {
  res.render("pages/orders/abandoned-cart/index", {
    i18n: req,
    user: req.user,
    header: { navbar: "abandoned-cart" },
  });
});

router.get("/orders/abandoned-cart/event/", authorizationControllers.isAuthenticated, (req, res) => {
  res.render("pages/orders/abandoned-cart/event", {
    i18n: req,
    user: req.user,
    header: { navbar: "abandoned-cart-event" },
  });
});

router.get("/orders/abandoned-cart/event/create/", authorizationControllers.isAuthenticated, (req, res) => {
  res.render("pages/orders/abandoned-cart/create", {
    i18n: req,
    user: req.user,
    header: { navbar: "abandoned-cart-event-create" },
  });
});

router.get("/orders/abandoned-cart/event/:id/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await connection_pool.query(
      `
            SELECT
                e.id,
                e.service_id,
                e.id_integration,
                e.store_id,
                e.name,
                e.delay_hours,
                e.delay_minutes,
                e.send_time_from,
                e.send_time_to,
                e.send_slot_1,
                e.send_slot_2,
                e.send_days,
                e.resend_mode,
                e.repeat_after_hours,
                e.min_cart_amount,
                e.message,
                e.active,
                e.sort_order,
                e.date_add,
                e.date_edit,
                s.name     AS service_name,
                s.channel  AS service_channel,
                s.logo_url AS service_logo
            FROM \`${configDatabase.prefix}orders_abandoned_cart_events\` e
            JOIN \`${configDatabase.prefix}orders_abandoned_cart_services\` s
                ON s.id = e.service_id
            WHERE e.id = ?
        `,
      [id]
    );

    if (!rows.length) {
      return res.redirect("/abandoned-cart/event/");
    }

    return res.render("pages/orders/abandoned-cart/event/edit", {
      i18n: req,
      user: req.user,
      header: { navbar: "abandoned-cart-event" },
      event: rows[0],
    });
  } catch (error) {
    logging.error(error);
    return res.redirect("/abandoned-cart/event/");
  }
});

// =====================================================
// POST Список покинутих кошиків
// =====================================================
router.post("/api/orders/abandoned-cart/abandoned-cart-list/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const [rows] = await connection_pool.query(`
            SELECT
                ac.id,
                ac.store_id,
                ac.session_id,
                ac.currency,
                ac.total_amount,
                ac.items_count,
                ac.cart,
                ac.utm_source,
                ac.utm_medium,
                ac.utm_campaign,
                ac.ip,
                ac.user_agent,
                ac.first_seen_at,
                ac.last_activity_at,
                ac.date_add,
                ac.date_edit
            FROM \`${configDatabase.prefix}orders_abandoned_cart\` ac
            ORDER BY ac.id DESC
        `);

    // Завжди мапимо дані, навіть якщо rows порожній
    const result = rows.map((row) => {
      const cart = typeof row.cart === "string" ? JSON.parse(row.cart) : row.cart;
      return {
        id: row.id,
        store_id: row.store_id,
        session_id: row.session_id,
        currency: row.currency,
        total_amount: row.total_amount,
        items_count: row.items_count,
        utm_source: row.utm_source,
        utm_medium: row.utm_medium,
        utm_campaign: row.utm_campaign,
        ip: row.ip,
        user_agent: row.user_agent,
        first_seen_at: row.first_seen_at ? new Date(row.first_seen_at).toLocaleTimeString("uk-UA") + " " + new Date(row.first_seen_at).toLocaleDateString("uk-UA") : "",
        last_activity_at: row.last_activity_at ? new Date(row.last_activity_at).toLocaleTimeString("uk-UA") + " " + new Date(row.last_activity_at).toLocaleDateString("uk-UA") : "",
        date_add: row.date_add ? new Date(row.date_add).toLocaleTimeString("uk-UA") + " " + new Date(row.date_add).toLocaleDateString("uk-UA") : "",
        date_edit: row.date_edit ? new Date(row.date_edit).toLocaleTimeString("uk-UA") + " " + new Date(row.date_edit).toLocaleDateString("uk-UA") : "",
        customer: {
          customer_id: cart.customer?.customer_id || null,
          firstname: cart.customer?.firstname || "",
          lastname: cart.customer?.lastname || "",
          email: cart.customer?.email || "",
          telephone: cart.customer?.telephone || "",
        },
        products: (cart.cart || []).map((item) => ({
          product_id: item.product_id || null,
          sku: item.sku || null,
          name: item.name || "",
          quantity: item.quantity || 0,
          price: item.price || 0,
          total: item.total || 0,
          image_url: item.image_url || null,
          product_url: item.product_url || null,
          options: item.options || {},
        })),
      };
    });

    // Завжди повертаємо масив (порожній, якщо немає даних)
    return res.status(200).json(result);
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

// =====================================================
// POST Список сервісів
// =====================================================
router.post("/api/orders/abandoned-cart/services-list/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const [rows] = await connection_pool.query(`
            SELECT
                id,
                channel,
                name,
                logo_url,
                is_connected,
                active
            FROM \`${configDatabase.prefix}orders_abandoned_cart_services\`
            WHERE active = 1
            ORDER BY sort_order ASC, id ASC
        `);

    if (!rows.length) {
      return res.status(404).json({ message: "Сервіси не знайдено." });
    }

    return res.status(200).json(rows);
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

// ── Валідатори полів розкладу події ─────────────────────────────
function clampInt(v, min, max, dflt) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = dflt;
  return Math.min(max, Math.max(min, n));
}

// "HH:MM" або "HH:MM:SS" → "HH:MM:SS"; інакше fallback
function normTime(v, fallback) {
  const m = String(v ?? "").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return fallback;
  const hh = Math.min(23, parseInt(m[1], 10));
  const mm = Math.min(59, parseInt(m[2], 10));
  const ss = Math.min(59, parseInt(m[3] || "0", 10));
  const p = (x) => String(x).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}`;
}

// бітмаска днів Пн..Нд: приймає число (0..127) або масив індексів [0..6]
function normDaysMask(v) {
  if (Array.isArray(v)) {
    let mask = 0;
    for (const d of v) {
      const i = parseInt(d, 10);
      if (i >= 0 && i <= 6) mask |= 1 << i;
    }
    return mask || 127;
  }
  const n = parseInt(v, 10);
  if (Number.isFinite(n) && n >= 0 && n <= 127) return n;
  return 127; // дефолт — усі дні
}

const RESEND_MODES = new Set(["once", "once_repeat"]);

// =====================================================
// POST Збереження сервісу
// =====================================================
router.post("/api/orders/abandoned-cart/events-save/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const { id, service_id, name, message } = req.body;
    // прив'язка до джерела: null = подія для всіх сайтів
    const id_integration = req.body.id_integration != null && req.body.id_integration !== "" ? parseInt(req.body.id_integration, 10) : null;
    const store_id = req.body.store_id != null && req.body.store_id !== "" ? parseInt(req.body.store_id, 10) : null;

    if (!service_id || !name || !message) {
      return res.status(400).json({ message: "Відсутні обов'язкові поля." });
    }

    const [serviceRows] = await connection_pool.query(
      `
            SELECT id, is_connected
            FROM \`${configDatabase.prefix}orders_abandoned_cart_services\`
            WHERE id = ? AND active = 1
        `,
      [service_id]
    );

    if (!serviceRows.length) {
      return res.status(404).json({ message: "Сервіс не знайдено." });
    }

    if (!serviceRows[0].is_connected) {
      return res.status(400).json({ message: "Сервіс не підключений." });
    }

    const normalizedMessage = message.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // ── Нормалізація полів розкладу (безпечні дефолти з DDL) ──
    const delay_hours = clampInt(req.body.delay_hours, 0, 8760, 24);
    const delay_minutes = clampInt(req.body.delay_minutes, 0, 59, 0);
    const send_time_from = normTime(req.body.send_time_from, "09:00:00");
    const send_time_to = normTime(req.body.send_time_to, "20:00:00");
    const send_slot_1 = normTime(req.body.send_slot_1, "10:00:00");
    const send_slot_2 = req.body.send_slot_2 ? normTime(req.body.send_slot_2, null) : null;
    const send_days = normDaysMask(req.body.send_days);
    const resend_mode = RESEND_MODES.has(req.body.resend_mode) ? req.body.resend_mode : "once";
    const repeat_after_hours = clampInt(req.body.repeat_after_hours, 1, 8760, 24);
    const min_cart_amount = Number.isFinite(Number(req.body.min_cart_amount)) ? Math.max(0, Number(req.body.min_cart_amount)) : 0;
    const active = req.body.active ?? 1;
    const sort_order = clampInt(req.body.sort_order, 0, 999999, 0);

    // вікно: from не має бути пізніше за to (інакше воркер ніколи не відправить)
    if (send_time_from > send_time_to) {
      return res.status(400).json({ message: "Початок вікна відправлення пізніше за кінець." });
    }

    if (id) {
      await connection_pool.query(
        `
              UPDATE \`${configDatabase.prefix}orders_abandoned_cart_events\`
                SET
                    service_id         = ?,
                    id_integration     = ?,
                    store_id           = ?,
                    name               = ?,
                    delay_hours        = ?,
                    delay_minutes      = ?,
                    send_time_from     = ?,
                    send_time_to       = ?,
                    send_slot_1        = ?,
                    send_slot_2        = ?,
                    send_days          = ?,
                    resend_mode        = ?,
                    repeat_after_hours = ?,
                    min_cart_amount    = ?,
                    message            = ?,
                    active             = ?,
                    sort_order         = ?,
                    date_edit          = NOW()
                WHERE id = ?
            `,
        [service_id, id_integration, store_id, name.trim(), delay_hours, delay_minutes, send_time_from, send_time_to, send_slot_1, send_slot_2, send_days, resend_mode, repeat_after_hours, min_cart_amount, normalizedMessage, active, sort_order, id]
      );
    } else {
      await connection_pool.query(
        `
                INSERT INTO \`${configDatabase.prefix}orders_abandoned_cart_events\`
                (service_id, id_integration, store_id, name, delay_hours, delay_minutes, send_time_from, send_time_to,
                 send_slot_1, send_slot_2, send_days, resend_mode, repeat_after_hours,
                 min_cart_amount, message, active, sort_order, date_add, date_edit)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
            `,
        [service_id, id_integration, store_id, name.trim(), delay_hours, delay_minutes, send_time_from, send_time_to, send_slot_1, send_slot_2, send_days, resend_mode, repeat_after_hours, min_cart_amount, normalizedMessage, active, sort_order]
      );
    }

    return res.status(200).json({ message: "Подію збережено." });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

// =====================================================
// POST Список подій розсилок
// =====================================================
router.post("/api/orders/abandoned-cart/events-list/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const [rows] = await connection_pool.query(`
            SELECT
                e.id,
                e.name,
                e.delay_hours,
                e.message,
                e.active,
                e.sort_order,
                e.date_add,
                e.date_edit,
                s.name      AS service_name,
                s.provider  AS service_provider,
                s.channel   AS service_channel,
                s.logo_url  AS service_logo
            FROM \`${configDatabase.prefix}orders_abandoned_cart_events\` e
            JOIN \`${configDatabase.prefix}orders_abandoned_cart_services\` s
                ON s.id = e.service_id
            ORDER BY e.sort_order ASC, e.id ASC
        `);
    if (!rows.length) {
      return res.status(404).json({ message: "Події не знайдено." });
    }
    const result = rows.map((row) => ({
      ...row,
      date_add: row.date_add
        ? new Date(row.date_add).toLocaleTimeString("uk-UA", {
            hour: "2-digit",
            minute: "2-digit",
          }) +
          " " +
          new Date(row.date_add).toLocaleDateString("uk-UA")
        : "",
      date_edit: row.date_edit
        ? new Date(row.date_edit).toLocaleTimeString("uk-UA", {
            hour: "2-digit",
            minute: "2-digit",
          }) +
          " " +
          new Date(row.date_edit).toLocaleDateString("uk-UA")
        : "",
    }));
    return res.status(200).json(result);
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

// =====================================================
// POST Прийом покинутого кошика з джерела (webhook).
//   Валідує → кладе в чергу orders_abandoned_cart_inbox → миттєво 202.
//   Обробку штовхає подієво kickCartWorker (без polling за годинником).
// =====================================================
router.post("/api/orders/abandoned-cart/receive/", verifyOrderToken("can_sync_carts"), cartRateLimit("receive"), async (req, res) => {
  const P = configDatabase.prefix;
  const token = req.orderToken;
  const body = req.body || {};

  const check = cartReceiveValidator.receive(body);
  if (!check.valid) {
    await logAttempt({
      id_token: token.id,
      prefix: req.orderTokenPrefix,
      ip: req.clientIp,
      domain: req.sourceHost,
      endpoint: req.originalUrl,
      result: "rejected",
      reject_reason: "bad_payload",
      http_status: 422,
      external_id: body?.source?.session_id != null ? String(body.source.session_id) : null,
      message: "cart schema validation failed",
    });
    return res.status(422).json({
      status: "error",
      reason: "bad_payload",
      errors: check.errors.map((e) => ({
        field: e.instancePath || (e.params && e.params.missingProperty) || "",
        msg: e.message,
      })),
    });
  }

  const session_id = String(body.source.session_id);
  const id_integration = token.id_integration || body.source.id_integration || null;

  try {
    const [ins] = await connection_pool.query(
      `INSERT INTO \`${P}orders_abandoned_cart_inbox\`
              (id_token, id_integration, external_id, payload, status, ip, received_at)
             VALUES (?, ?, ?, ?, 'pending', INET6_ATON(?), NOW())`,
      [token.id, id_integration, session_id, JSON.stringify(body), req.clientIp]
    );

    await logAttempt({
      id_token: token.id,
      prefix: req.orderTokenPrefix,
      ip: req.clientIp,
      domain: req.sourceHost,
      endpoint: req.originalUrl,
      result: "success",
      http_status: 202,
      external_id: session_id,
      message: `queued cart inbox#${ins.insertId}`,
    });

    kickCartWorker(); // ← подієвий запуск обробки

    return res.status(202).json({ status: "queued", inbox_id: ins.insertId });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ status: "error", message: "Помилка сервера." });
  }
});

// =====================================================
// POST Recovery: купили → закриваємо кошик у CRM.
//   Матч: session_id → (резерв) id_customer у вікні 30 днів.
//   Лінкуємо id_order за orders.external_id = 'OC-<id>'. Ідемпотентно.
// =====================================================
router.post("/api/orders/abandoned-cart/recover/", verifyOrderToken("can_sync_carts"), cartRateLimit("recover"), async (req, res) => {
  const P = configDatabase.prefix;
  const token = req.orderToken;
  const body = req.body || {};
  const src = body.source || {};
  const ord = body.order || {};

  const session_id = src.session_id != null ? String(src.session_id) : "";
  const store_id = src.store_id != null ? parseInt(src.store_id, 10) : null;
  const id_integration = token.id_integration || src.id_integration || null;
  const customer_id = ord.customer_id != null ? parseInt(ord.customer_id, 10) : null;
  const email = ord.email != null ? String(ord.email).trim().toLowerCase() : null;
  const external_order_id = ord.external_id != null ? String(ord.external_id) : null;

  if (!session_id && !customer_id && !email) {
    return res.status(422).json({
      status: "error",
      reason: "bad_payload",
      message: "Потрібен session_id, customer_id або email.",
    });
  }

  const conn = await connection_pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1) Лінк на CRM-замовлення (best-effort)
    let id_order = null;
    if (external_order_id) {
      const [[o]] = await conn.query(`SELECT id FROM \`${P}orders\` WHERE external_id = ? AND id_integration <=> ? LIMIT 1`, [external_order_id, id_integration]);
      if (o) id_order = o.id;
    }

    // 2) Пошук кошика: спершу за сесією, потім за клієнтом (вікно 30 днів)
    let cart = null;
    if (session_id) {
      const [[c]] = await conn.query(
        `SELECT id, status FROM \`${P}orders_abandoned_cart\`
                 WHERE session_id = ? AND (id_integration <=> ? OR store_id <=> ?)
                 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [session_id, id_integration, store_id]
      );
      if (c) cart = c;
    }
    if (!cart && customer_id) {
      const [[c]] = await conn.query(
        `SELECT id, status FROM \`${P}orders_abandoned_cart\`
                 WHERE id_customer = ? AND (id_integration <=> ? OR store_id <=> ?)
                   AND status IN ('active','abandoned','notified')
                   AND last_activity_at >= (NOW() - INTERVAL 30 DAY)
					ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [customer_id, id_integration, store_id]
      );
      if (c) cart = c;
    }
    if (!cart && email) {
      const [[c]] = await conn.query(
        `SELECT id, status FROM \`${P}orders_abandoned_cart\`
                 WHERE email = ? AND (id_integration <=> ? OR store_id <=> ?)
                   AND status IN ('active','abandoned','notified')
                   AND last_activity_at >= (NOW() - INTERVAL 30 DAY)
                 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [email, id_integration, store_id]
      );
      if (c) cart = c;
    }

    if (!cart) {
      await conn.commit();
      return res.status(200).json({ status: "no_cart", message: "Активний кошик не знайдено." });
    }
    if (cart.status === "recovered" || cart.status === "expired") {
      await conn.commit();
      return res.status(200).json({ status: "already_closed", id_cart: cart.id });
    }

    await conn.query(
      `UPDATE \`${P}orders_abandoned_cart\`
             SET status = 'recovered', id_order = COALESCE(?, id_order), recovered_at = NOW(), date_edit = NOW()
             WHERE id = ?`,
      [id_order, cart.id]
    );
    await conn.commit();

    return res.status(200).json({ status: "recovered", id_cart: cart.id, id_order });
  } catch (error) {
    await conn.rollback();
    logging.error(error);
    return res.status(500).json({ status: "error", message: "Помилка сервера." });
  }
});

// =====================================================
// POST Reconcile (mark-and-sweep). OC шле відкриті сесії пачками зі
//   спільним as_of (CRM фіксує на 1-й пачці, OC echo-їть далі).
//   На final — закриваємо все непозначене й старше за as_of у 'expired'.
// =====================================================
router.post("/api/orders/abandoned-cart/reconcile/", verifyOrderToken("can_sync_carts"), cartRateLimit("reconcile"), async (req, res) => {
  const P = configDatabase.prefix;
  const token = req.orderToken;
  const body = req.body || {};
  const src = body.source || {};

  const id_integration = token.id_integration || src.id_integration || null;
  const store_id = src.store_id != null ? parseInt(src.store_id, 10) : null;
  const sessions = Array.isArray(body.sessions) ? body.sessions.map(String).filter(Boolean).slice(0, 5000) : [];
  const final = !!body.final;

  const conn = await connection_pool.getConnection();
  try {
    await conn.beginTransaction();

    // as_of: перша пачка — CRM фіксує NOW(); далі OC echo-їть значення назад
    let asOf = typeof body.as_of === "string" && body.as_of.length <= 25 ? body.as_of : null;
    if (!asOf) {
      const [[r]] = await conn.query(`SELECT NOW() AS now`);
      asOf = new Date(r.now).toISOString().slice(0, 19).replace("T", " ");
    }

    let marked = 0;
    if (sessions.length) {
      const [mk] = await conn.query(
        `UPDATE \`${P}orders_abandoned_cart\`
                 SET reconciled_at = ?
                 WHERE (id_integration <=> ? OR store_id <=> ?)
                   AND session_id IN (?)
                   AND status IN ('active','abandoned','notified')`,
        [asOf, id_integration, store_id, sessions]
      );
      marked = mk.affectedRows || 0;
    }

    let swept = 0;
    if (final) {
      const [sw] = await conn.query(
        `UPDATE \`${P}orders_abandoned_cart\`
                 SET status = 'expired', date_edit = NOW()
                 WHERE (id_integration <=> ? OR store_id <=> ?)
                   AND status IN ('active','abandoned','notified')
                   AND (reconciled_at IS NULL OR reconciled_at < ?)
                   AND last_activity_at < ?`,
        [id_integration, store_id, asOf, asOf]
      );
      swept = sw.affectedRows || 0;
    }

    await conn.commit();
    return res.status(200).json({ status: "ok", as_of: asOf, marked, swept, final });
  } catch (error) {
    await conn.rollback();
    logging.error(error);
    return res.status(500).json({ status: "error", message: "Помилка сервера." });
  }
});

// =====================================================
// POST Close: кошик спорожнили → закриваємо в CRM ('expired').
//   Матч: session_id (точний, та сама сесія) → резерв email.
// =====================================================
router.post("/api/orders/abandoned-cart/close/", verifyOrderToken("can_sync_carts"), cartRateLimit("close"), async (req, res) => {
  const P = configDatabase.prefix;
  const token = req.orderToken;
  const body = req.body || {};
  const src = body.source || {};
  const cust = body.customer || {};

  const session_id = src.session_id != null ? String(src.session_id) : "";
  const store_id = src.store_id != null ? parseInt(src.store_id, 10) : null;
  const id_integration = token.id_integration || src.id_integration || null;
  const customer_id = cust.customer_id != null ? parseInt(cust.customer_id, 10) : null;
  const email = cust.email != null ? String(cust.email).trim().toLowerCase() : null;

  if (!session_id && !customer_id && !email) {
    return res.status(422).json({ status: "error", reason: "bad_payload" });
  }

  const conn = await connection_pool.getConnection();
  try {
    await conn.beginTransaction();

    let cart = null;
    if (session_id) {
      const [[c]] = await conn.query(
        `SELECT id, status FROM \`${P}orders_abandoned_cart\`
                 WHERE session_id = ? AND (id_integration <=> ? OR store_id <=> ?)
                 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [session_id, id_integration, store_id]
      );
      if (c) cart = c;
    }
    if (!cart && email) {
      const [[c]] = await conn.query(
        `SELECT id, status FROM \`${P}orders_abandoned_cart\`
                 WHERE email = ? AND (id_integration <=> ? OR store_id <=> ?)
                   AND status IN ('active','abandoned','notified')
                 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [email, id_integration, store_id]
      );
      if (c) cart = c;
    }

    if (!cart) {
      await conn.commit();
      return res.status(200).json({ status: "no_cart" });
    }
    if (cart.status === "recovered" || cart.status === "expired") {
      await conn.commit();
      return res.status(200).json({ status: "already_closed", id_cart: cart.id });
    }

    await conn.query(`UPDATE \`${P}orders_abandoned_cart\` SET status = 'expired', date_edit = NOW() WHERE id = ?`, [cart.id]);
    await conn.commit();
    return res.status(200).json({ status: "closed", id_cart: cart.id });
  } catch (error) {
    await conn.rollback();
    logging.error(error);
    return res.status(500).json({ status: "error", message: "Помилка сервера." });
  }
});

// =====================================================
// POST Підключити / оновити сервіс
// =====================================================
router.post("/api/orders/abandoned-cart/services-connect/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const serviceId = Number(req.body?.service_id);
    const values = req.body?.values;
    if (!serviceId) return res.status(400).json({ message: "Не вказано ID сервісу." });
    if (!values || typeof values !== "object") return res.status(400).json({ message: "Некоректні дані." });

    const [rows] = await connection_pool.query(`SELECT config_fields, config FROM \`${configDatabase.prefix}orders_abandoned_cart_services\` WHERE id = ? LIMIT 1`, [serviceId]);
    if (!rows.length) return res.status(404).json({ message: "Сервіс не знайдено." });

    const schema = normalizeSchema(parseJson(rows[0].config_fields, []));
    const existing = configToObject(rows[0].config);

    const nextConfig = { ...existing };
    const errors = [];
    const missing = [];

    for (const field of flattenSchema(schema)) {
      const isSecret = SECRET_TYPES.has(field.type);
      const provided = Object.prototype.hasOwnProperty.call(values, field.key);
      const rawVal = provided ? values[field.key] : undefined;
      const providedEmpty = rawVal === "" || rawVal === null || rawVal === undefined;

      if (isSecret && (!provided || providedEmpty)) {
        if (field.required && !(field.key in existing)) missing.push(field.label || field.key);
        continue;
      }

      if (!provided) {
        if (field.required && (existing[field.key] === undefined || existing[field.key] === "")) {
          missing.push(field.label || field.key);
        }
        continue;
      }

      const { value, error } = validateField(field, rawVal);
      if (error) {
        errors.push(error);
        continue;
      }

      const isEmpty = value === "" || value === null || value === undefined;
      if (field.required && isEmpty) {
        missing.push(field.label || field.key);
        continue;
      }

      nextConfig[field.key] = isSecret ? encryptSecret(String(value)) : value;
    }

    if (errors.length) return res.status(400).json({ message: errors.join(" ") });
    if (missing.length) return res.status(400).json({ message: "Не заповнені поля: " + missing.join(", ") });

    await connection_pool.query(
      `UPDATE \`${configDatabase.prefix}orders_abandoned_cart_services\`
       SET config = ?, is_connected = 1, date_edit = NOW()
       WHERE id = ?`,
      [JSON.stringify(nextConfig), serviceId]
    );

    return res.status(200).json({ message: "Сервіс підключено.", is_connected: true });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

// =====================================================
// POST Зведення по кошиках (для віджета в адмінці CRM)
// =====================================================
router.post("/api/orders/abandoned-cart/stats/", authorizationControllers.isAuthenticated, async (req, res) => {
  const P = configDatabase.prefix;
  try {
    const [rows] = await connection_pool.query(`SELECT status, COUNT(*) AS c FROM \`${P}orders_abandoned_cart\` GROUP BY status`);
    const stats = {
      active: 0,
      abandoned: 0,
      notified: 0,
      recovered: 0,
      expired: 0,
      total: 0,
    };
    for (const r of rows) {
      if (stats[r.status] !== undefined) stats[r.status] = Number(r.c);
      stats.total += Number(r.c);
    }
    const denom = stats.abandoned + stats.notified + stats.recovered + stats.expired;
    stats.recovery_rate = denom > 0 ? Math.round((stats.recovered * 1000) / denom) / 10 : 0;
    return res.status(200).json(stats);
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

function validateField(field, value) {
  const label = field.label || field.key;
  if (field.type === "checkbox") return { value: Boolean(value), error: null };

  if (field.type === "number") {
    if (value === "" || value === null || value === undefined) return { value: null, error: null };
    const n = Number(value);
    if (Number.isNaN(n)) return { value: null, error: `«${label}»: має бути числом.` };
    if (field.min !== undefined && n < Number(field.min)) return { value: n, error: `«${label}»: мінімум ${field.min}.` };
    if (field.max !== undefined && n > Number(field.max)) return { value: n, error: `«${label}»: максимум ${field.max}.` };
    return { value: n, error: null };
  }

  let v = typeof value === "string" ? value.trim() : (value ?? "");
  if (v === "") return { value: "", error: null };

  if (field.minlength !== undefined && v.length < Number(field.minlength))
    return {
      value: v,
      error: `«${label}»: мінімум ${field.minlength} символів.`,
    };
  if (field.maxlength !== undefined && v.length > Number(field.maxlength))
    return {
      value: v,
      error: `«${label}»: максимум ${field.maxlength} символів.`,
    };
  if (field.pattern) {
    try {
      if (!new RegExp(field.pattern).test(v)) return { value: v, error: `«${label}»: невірний формат.` };
    } catch {}
  }
  if (field.type === "time" || field.type === "date") {
    if (field.min !== undefined && v < String(field.min)) return { value: v, error: `«${label}»: не раніше ${field.min}.` };
    if (field.max !== undefined && v > String(field.max)) return { value: v, error: `«${label}»: не пізніше ${field.max}.` };
  }
  return { value: v, error: null };
}

router.post("/api/orders/abandoned-cart/service-get/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const id = Number(req.body?.id);
    if (!id) return res.status(400).json({ message: "Не вказано ID сервісу." });

    const [rows] = await connection_pool.query(
      `SELECT id, channel, provider, name, logo_url, description,
              config_fields, config, is_connected, is_default, active, sort_order, date_add, date_edit
       FROM \`${configDatabase.prefix}orders_abandoned_cart_services\`
       WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: "Сервіс не знайдено." });

    const row = rows[0];
    const schema = normalizeSchema(parseJson(row.config_fields, []));
    const stored = configToObject(row.config);

    const values = {}; // не-секретні значення для префілу форми
    const secrets = {}; // секрет -> { is_set }

    for (const f of flattenSchema(schema)) {
      if (SECRET_TYPES.has(f.type)) {
        const v = stored[f.key];
        secrets[f.key] = { is_set: v !== undefined && v !== null && v !== "" };
      } else {
        const v = stored[f.key];
        values[f.key] = v !== undefined && v !== null ? v : (f.default ?? "");
      }
    }

    return res.status(200).json({
      id: row.id,
      channel: row.channel,
      provider: row.provider,
      name: row.name,
      logo_url: row.logo_url,
      description: row.description,
      config_fields: schema, // тільки схема, без значень
      values,
      secrets,
      is_connected: Boolean(row.is_connected),
      is_default: Boolean(row.is_default),
      active: Boolean(row.active),
      sort_order: row.sort_order,
      date_add: row.date_add,
      date_edit: row.date_edit,
    });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

// =====================================================
// POST Список джерел (сайтів) для прив'язки подій
// =====================================================
router.post("/api/orders/abandoned-cart/integrations-list/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const [rows] = await connection_pool.query(
      `SELECT id, name, platform, base_url, status
       FROM \`${configDatabase.prefix}orders_integrations\`
       WHERE status = 'active'
       ORDER BY name ASC`
    );
    return res.status(200).json(rows);
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});

router.post("/api/orders/abandoned-cart/delete/", authorizationControllers.isAuthenticated, async (req, res) => {
  const id = parseInt(req.body.id, 10);
  if (!id || isNaN(id)) {
    return res.status(400).json({ status: "error", message: "Невірний ID кошика." });
  }

  const conn = await connection_pool.getConnection();
  try {
    await conn.beginTransaction();

    // (Опціонально) перевіряємо, чи існує кошик
    const [[cart]] = await conn.query(`SELECT id FROM \`${configDatabase.prefix}orders_abandoned_cart\` WHERE id = ? FOR UPDATE`, [id]);
    if (!cart) {
      await conn.rollback();
      return res.status(404).json({ status: "error", message: "Кошик не знайдено." });
    }

    // Видаляємо запис; пов'язані дані (log, queue, recovery) видаляться каскадно
    await conn.query(`DELETE FROM \`${configDatabase.prefix}orders_abandoned_cart\` WHERE id = ?`, [id]);

    await conn.commit();

    // Якщо використовуєте кеш – інвалідуйте його (наприклад, invalidateAbandonedCartCache())

    return res.status(200).json({ status: "success" });
  } catch (error) {
    await conn.rollback();
    logging.error(error);
    return res.status(500).json({ status: "error", message: "Помилка сервера." });
  } finally {
    conn.release();
  }
});

// Локальний бекстоп: експірація застарілих + ретенція (стартує один раз)
require("../../../controllers/orders/cartMaintenance").startCartMaintenance();
require("../../../controllers/orders/cartSendWorker").startCartSendWorker();
require("../../../controllers/orders/cartStatusPoller").startCartStatusPoller();
require("../../../controllers/orders/cartScheduler").startCartScheduler();

module.exports = router;
