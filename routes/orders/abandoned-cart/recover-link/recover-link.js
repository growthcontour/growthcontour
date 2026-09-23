// routes/orders/abandoned-cart/recover-link/recover-link.js
// Публічний обробник recovery-лінка з повідомлення.
// token → кошик → редірект на сайт (OpenCart відновлює корзину за session_id/токеном).

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const connection_pool = require("../../../../config/database/connection_pool");
const config = require("../../../../config/config");
const configDatabase = config.get("configDatabase");
const logging = require("../../../../logging/logging");

const P = configDatabase.prefix;

// Простий in-memory rate-limit по IP для публічних recovery-ендпоінтів.
// Вікно і ліміт — з env, дефолт: 30 запитів за 60 секунд з однієї IP.
const RL_WINDOW_MS = parseInt(process.env.RECOVER_RL_WINDOW_MS || "60000", 10);
const RL_MAX = parseInt(process.env.RECOVER_RL_MAX || "30", 10);
const rlBuckets = new Map();

function recoverRateLimit(req, res, next) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || req.connection?.remoteAddress || "0.0.0.0";
  const now = Date.now();
  const from = now - RL_WINDOW_MS;

  let arr = rlBuckets.get(ip);
  if (!arr) {
    arr = [];
    rlBuckets.set(ip, arr);
  }
  while (arr.length && arr[0] < from) arr.shift();

  if (arr.length >= RL_MAX) {
    const retryAfter = Math.ceil((arr[0] + RL_WINDOW_MS - now) / 1000) || 1;
    res.setHeader("Retry-After", retryAfter);
    return res.status(429).send("Забагато запитів. Спробуйте за хвилину.");
  }
  arr.push(now);
  next();
}

// періодичне прибирання порожніх бакетів
const rlSweeper = setInterval(() => {
  const from = Date.now() - RL_WINDOW_MS;
  for (const [ip, arr] of rlBuckets) {
    while (arr.length && arr[0] < from) arr.shift();
    if (!arr.length) rlBuckets.delete(ip);
  }
}, 60000);
if (rlSweeper.unref) rlSweeper.unref();

router.get("/recover", recoverRateLimit, async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).send("Некоректне посилання.");
  }

  try {
    const [[rec]] = await connection_pool.query(
      `SELECT r.cart_id, r.session_id, r.id_integration, r.store_id,
              ac.status AS cart_status
       FROM \`${P}orders_abandoned_cart_recovery\` r
       JOIN \`${P}orders_abandoned_cart\` ac ON ac.id = r.cart_id
       WHERE r.token = ? LIMIT 1`,
      [token]
    );

    if (!rec) return res.status(404).send("Кошик не знайдено або посилання застаріло.");

    // облік кліку (best-effort)
    connection_pool
      .query(
        `UPDATE \`${P}orders_abandoned_cart_recovery\`
         SET clicks = clicks + 1,
             first_click_at = COALESCE(first_click_at, NOW()),
             last_click_at = NOW()
         WHERE token = ?`,
        [token]
      )
      .catch(() => {});

    // база сайту
    const [[integ]] = await connection_pool.query(`SELECT base_url FROM \`${P}orders_integrations\` WHERE id = ? AND status = 'active' LIMIT 1`, [rec.id_integration]);

    const base = (integ?.base_url || process.env.RECOVERY_SITE_FALLBACK || "").replace(/\/+$/, "");
    if (!base) {
      return res.status(500).send("Сайт для відновлення не налаштований.");
    }

    // Редірект на модуль сайту, який відновить корзину за session_id.
    // Формат узгоджений з OpenCart-модулем (див. специфікацію нижче).
    const url = `${base}/index.php?route=extension/module/growthcontour/restore&token=${encodeURIComponent(token)}`;

    return res.redirect(302, url);
  } catch (error) {
    logging.error(error);
    return res.status(500).send("Помилка сервера.");
  }
});

// POST recover-verify — сайт запитує склад кошика за recovery-токеном.
// Захист: Bearer = outbound_token тієї інтеграції, до якої належить кошик.
router.post("/api/orders/abandoned-cart/recover-verify/", recoverRateLimit, async (req, res) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return res.status(400).json({ status: "error", message: "bad token" });
    }

    const [[rec]] = await connection_pool.query(
      `SELECT r.cart_id, r.id_integration, ac.cart, ac.status AS cart_status,
              ac.total_amount, ac.currency, ac.items_count
       FROM \`${P}orders_abandoned_cart_recovery\` r
       JOIN \`${P}orders_abandoned_cart\` ac ON ac.id = r.cart_id
       WHERE r.token = ? LIMIT 1`,
      [token]
    );
    if (!rec) return res.status(404).json({ status: "error", message: "not found" });

    // перевірка токена: SHA-256(bearer) має збігтися з token_hash в orders_tokens,
    // токен активний, не відкликаний, не прострочений, зі scope can_sync_carts
    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!bearer) {
      return res.status(401).json({ status: "error", message: "unauthorized" });
    }
    const token_hash = crypto.createHash("sha256").update(bearer).digest("hex");

    const [[tok]] = await connection_pool.query(
      `SELECT id, status, revoked_at, expires_at, can_sync_carts, id_integration
       FROM \`${P}orders_tokens\`
       WHERE token_hash = ? LIMIT 1`,
      [token_hash]
    );

    const tokenValid = tok && tok.status === "active" && !tok.revoked_at && (!tok.expires_at || new Date(tok.expires_at) >= new Date()) && Number(tok.can_sync_carts) === 1;

    if (!tokenValid) {
      return res.status(401).json({ status: "error", message: "unauthorized" });
    }

    // Кошик уже відновлено (клієнт купив) — не віддаємо товари для відновлення
    if (rec.cart_status === "recovered") {
      return res.status(200).json({
        status: "already_recovered",
        cart_id: rec.cart_id,
        items: [],
      });
    }

    const cart = typeof rec.cart === "string" ? JSON.parse(rec.cart) : rec.cart;
    const items = (cart.cart || []).map((it) => ({
      product_id: it.product_id,
      quantity: it.quantity,
      options: it.options || {},
      options_raw: Array.isArray(it.options_raw) ? it.options_raw : [],
    }));

    return res.status(200).json({
      status: "success",
      cart_id: rec.cart_id,
      cart_status: rec.cart_status,
      currency: rec.currency,
      total_amount: rec.total_amount,
      items_count: rec.items_count,
      items,
    });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ status: "error", message: "server error" });
  }
});

module.exports = router;
