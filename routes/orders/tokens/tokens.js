// =========================================================================
//  КЕРУВАННЯ API-ТОКЕНАМИ (адмінка, під isAuthenticated)
//  Сторінка + CRUD токенів прийому замовлень.
//  Сам токен показується сирим ЛИШЕ раз при генерації; у БД — тільки SHA-256.
// =========================================================================
const express = require("express");
const crypto = require("crypto");
const router = express.Router();

// Controllers
const authorizationControllers = require("../../../controllers/authorization/authorization");
// END Controllers

// Database
const connection_pool = require("../../../config/database/connection_pool");
// END Database

// Configuration
const config = require("../../../config/config");
const configDatabase = config.get("configDatabase");
// END Configuration

// Logging
const logging = require("../../../logging/logging");
// END Logging

const p = configDatabase.prefix;

// ─────────────────────────────────────────────────────────────────────────
// Утиліти
// ─────────────────────────────────────────────────────────────────────────
const formatDate = (date) => {
  if (!date) return null;
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes} ${day}.${month}.${year}`;
};

const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

// Нормалізація JSON-списку рядків (домени/IP): масив непорожніх trim-рядків
const cleanList = (val) => {
  let arr = val;
  if (typeof val === "string") {
    arr = val.split(/[\n,]+/); // з textarea: рядки або коми
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((s) => String(s).trim()).filter((s) => s.length > 0);
};

const SCOPES = ["can_create_orders", "can_update_orders", "can_update_status", "can_create_clients", "can_read", "can_sync_carts"];

// ─────────────────────────────────────────────────────────────────────────
// GET — сторінка токенів
// ─────────────────────────────────────────────────────────────────────────
router.get("/orders/tokens/", authorizationControllers.isAuthenticated, (req, res) => {
  res.render("pages/orders/tokens/tokens", {
    i18n: req,
    user: req.user,
    header: { navbar: "orders" },
  });
});
// END GET

// ─────────────────────────────────────────────────────────────────────────
// POST — Список токенів (без хешів; лише безпечні для показу поля)
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/tokens/list/", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const [rows] = await connection_pool.query(
      `SELECT id, name, prefix, last4, environment, status,
              revoked_at, expires_at, source_check_mode,
              usage_count, error_count, last_used_at,
              date_add, date_edit
       FROM \`${p}orders_tokens\`
       ORDER BY id DESC`
    );

    const result = rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      last4: r.last4,
      environment: r.environment,
      // Обчислюваний стан для бейджа: revoked > expired > disabled > active
      state: r.revoked_at ? "revoked" : r.expires_at && new Date(r.expires_at) < new Date() ? "expired" : r.status === "disabled" ? "disabled" : "active",
      source_check_mode: r.source_check_mode,
      usage_count: r.usage_count,
      error_count: r.error_count,
      last_used_at: formatDate(r.last_used_at),
      date_add: formatDate(r.date_add),
    }));

    return res.status(200).json(result);
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});
// END Список токенів

// ─────────────────────────────────────────────────────────────────────────
// POST — Деталі токена (для модалки редагування)
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/tokens/get/", authorizationControllers.isAuthenticated, async (req, res) => {
  const id = parseInt(req.body.id, 10);
  if (!id) return res.status(400).json({ message: "Невірний ID." });

  try {
    const [[t]] = await connection_pool.query(
      `SELECT id, name, prefix, last4, environment, id_integration,
              allowed_domains, allowed_ips, source_check_mode,
              can_create_orders, can_update_orders, can_update_status, can_create_clients, can_read,
              status, expires_at, revoked_at, revoked_reason,
              usage_count, error_count, last_used_at, last_used_domain, note
       FROM \`${p}orders_tokens\` WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!t) return res.status(404).json({ message: "Токен не знайдено." });

    // allowed_domains / allowed_ips — JSON-колонки, драйвер повертає масивами
    return res.status(200).json({
      ...t,
      expires_at: t.expires_at ? new Date(t.expires_at).toISOString().slice(0, 10) : "",
      last_used_at: formatDate(t.last_used_at),
    });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});
// END Деталі токена

// ─────────────────────────────────────────────────────────────────────────
// POST — Генерація нового токена. Повертає СИРИЙ токен ОДИН раз.
//   Формат: ok_{env}_{32 hex}. У БД зберігаємо лише SHA-256(raw).
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/tokens/generate/", authorizationControllers.isAuthenticated, async (req, res) => {
  const b = req.body || {};
  const name = (b.name || "").toString().trim();
  if (!name) return res.status(400).json({ message: "Вкажіть назву токена." });

  const environment = b.environment === "test" ? "test" : "live";
  const allowed_domains = cleanList(b.allowed_domains);
  const allowed_ips = cleanList(b.allowed_ips);
  const source_check_mode = ["any", "all", "off"].includes(b.source_check_mode) ? b.source_check_mode : "any";
  const id_integration = b.id_integration ? parseInt(b.id_integration, 10) : null;
  const expires_at = b.expires_at ? String(b.expires_at) : null;
  const note = (b.note || "").toString().slice(0, 999) || null;

  // Scopes (за замовчуванням лише приймання + створення клієнтів)
  const scopeVals = {};
  SCOPES.forEach((s) => {
    scopeVals[s] = b[s] ? 1 : 0;
  });
  if (b.can_create_orders === undefined && b.can_create_clients === undefined) {
    scopeVals.can_create_orders = 1;
    scopeVals.can_create_clients = 1;
  }

  try {
    // Генеруємо унікальний сирий токен (перевіряємо хеш на колізію)
    let rawToken,
      token_hash,
      unique = false,
      guard = 0;
    while (!unique && guard < 5) {
      guard++;
      const rand = crypto.randomBytes(16).toString("hex"); // 32 hex-символи
      rawToken = `ok_${environment}_${rand}`;
      token_hash = hashToken(rawToken);
      const [[dup]] = await connection_pool.query(`SELECT id FROM \`${p}orders_tokens\` WHERE token_hash = ? LIMIT 1`, [token_hash]);
      unique = !dup;
    }
    if (!unique) throw new Error("Не вдалося згенерувати унікальний токен.");

    const prefix = rawToken.slice(0, 12); // ok_live_a3f9…
    const last4 = rawToken.slice(-4);

    const [ins] = await connection_pool.query(
      `INSERT INTO \`${p}orders_tokens\`
        (name, prefix, token_hash, last4, environment, id_integration, id_user,
         allowed_domains, allowed_ips, source_check_mode,
         can_create_orders, can_update_orders, can_update_status, can_create_clients, can_read, can_sync_carts,
         status, expires_at, note, date_add, date_edit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NOW(), NOW())`,
      [name, prefix, token_hash, last4, environment, id_integration, req.user.id, JSON.stringify(allowed_domains), JSON.stringify(allowed_ips), source_check_mode, scopeVals.can_create_orders, scopeVals.can_update_orders, scopeVals.can_update_status, scopeVals.can_create_clients, scopeVals.can_read, scopeVals.can_sync_carts, expires_at, note]
    );

    // Сирий токен повертаємо ЄДИНИЙ раз — більше його не відновити
    return res.status(200).json({ status: "success", id: ins.insertId, token: rawToken });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});
// END Генерація токена

// ─────────────────────────────────────────────────────────────────────────
// POST — Оновлення токена (домени/IP/scopes/режим/статус/термін/назва).
//   Сам токен (хеш) НЕ змінюється — лише налаштування.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/tokens/update/", authorizationControllers.isAuthenticated, async (req, res) => {
  const b = req.body || {};
  const id = parseInt(b.id, 10);
  if (!id) return res.status(400).json({ message: "Невірний ID." });

  const name = (b.name || "").toString().trim();
  if (!name) return res.status(400).json({ message: "Вкажіть назву токена." });

  const allowed_domains = cleanList(b.allowed_domains);
  const allowed_ips = cleanList(b.allowed_ips);
  const source_check_mode = ["any", "all", "off"].includes(b.source_check_mode) ? b.source_check_mode : "any";
  const status = b.status === "disabled" ? "disabled" : "active";
  const expires_at = b.expires_at ? String(b.expires_at) : null;
  const note = (b.note || "").toString().slice(0, 999) || null;
  const id_integration = b.id_integration ? parseInt(b.id_integration, 10) : null;

  const scopeVals = {};
  SCOPES.forEach((s) => {
    scopeVals[s] = b[s] ? 1 : 0;
  });

  try {
    // Не можна редагувати відкликаний токен
    const [[cur]] = await connection_pool.query(`SELECT revoked_at FROM \`${p}orders_tokens\` WHERE id = ? LIMIT 1`, [id]);
    if (!cur) return res.status(404).json({ message: "Токен не знайдено." });
    if (cur.revoked_at) return res.status(400).json({ message: "Токен відкликано — редагування недоступне." });

    await connection_pool.query(
      `UPDATE \`${p}orders_tokens\`
       SET name = ?, id_integration = ?, allowed_domains = ?, allowed_ips = ?, source_check_mode = ?,
           can_create_orders = ?, can_update_orders = ?, can_update_status = ?, can_create_clients = ?, can_read = ?, can_sync_carts = ?,
           status = ?, expires_at = ?, note = ?, date_edit = NOW()
       WHERE id = ?`,
      [name, id_integration, JSON.stringify(allowed_domains), JSON.stringify(allowed_ips), source_check_mode, scopeVals.can_create_orders, scopeVals.can_update_orders, scopeVals.can_update_status, scopeVals.can_create_clients, scopeVals.can_read, scopeVals.can_sync_carts, status, expires_at, note, id]
    );

    return res.status(200).json({ status: "success" });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});
// END Оновлення токена

// ─────────────────────────────────────────────────────────────────────────
// POST — Відкликання токена (незворотно; з причиною й автором).
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/tokens/revoke/", authorizationControllers.isAuthenticated, async (req, res) => {
  const id = parseInt(req.body.id, 10);
  const reason = (req.body.reason || "").toString().slice(0, 255) || null;
  if (!id) return res.status(400).json({ message: "Невірний ID." });

  try {
    const [[cur]] = await connection_pool.query(`SELECT revoked_at FROM \`${p}orders_tokens\` WHERE id = ? LIMIT 1`, [id]);
    if (!cur) return res.status(404).json({ message: "Токен не знайдено." });
    if (cur.revoked_at) return res.status(400).json({ message: "Токен уже відкликано." });

    await connection_pool.query(
      `UPDATE \`${p}orders_tokens\`
       SET revoked_at = NOW(), revoked_by = ?, revoked_reason = ?, status = 'disabled', date_edit = NOW()
       WHERE id = ?`,
      [req.user.id, reason, id]
    );

    return res.status(200).json({ status: "success" });
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});
// END Відкликання токена

// ─────────────────────────────────────────────────────────────────────────
// POST — Видалення токена (фізичне). Ключ односторонній — видаляти безпечно.
//   Лог використань чистимо теж, щоб не лишати сиріт.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/tokens/delete/", authorizationControllers.isAuthenticated, async (req, res) => {
  const id = parseInt(req.body.id, 10);
  if (!id) return res.status(400).json({ message: "Невірний ID." });

  const conn = await connection_pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[cur]] = await conn.query(`SELECT id FROM \`${p}orders_tokens\` WHERE id = ? LIMIT 1`, [id]);
    if (!cur) {
      await conn.rollback();
      return res.status(404).json({ message: "Токен не знайдено." });
    }

    await conn.query(`DELETE FROM \`${p}orders_tokens_log\` WHERE id_token = ?`, [id]);
    await conn.query(`DELETE FROM \`${p}orders_tokens\` WHERE id = ?`, [id]);

    await conn.commit();
    return res.status(200).json({ status: "success", message: "Токен видалено." });
  } catch (error) {
    await conn.rollback();
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  } finally {
    conn.release();
  }
});
// END Видалення токена

// ─────────────────────────────────────────────────────────────────────────
// POST — Журнал використань токена (для модалки логів).
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/tokens/log/", authorizationControllers.isAuthenticated, async (req, res) => {
  const id_token = parseInt(req.body.id, 10);
  if (!id_token) return res.status(400).json({ message: "Невірний ID." });

  try {
    const [rows] = await connection_pool.query(
      `SELECT id, INET6_NTOA(ip) AS ip, domain, method, endpoint,
              result, reject_reason, http_status, id_order, external_id, message, date_add
       FROM \`${p}orders_tokens_log\`
       WHERE id_token = ?
       ORDER BY id DESC
       LIMIT 200`,
      [id_token]
    );
    return res.status(200).json(rows.map((r) => ({ ...r, date_add: formatDate(r.date_add) })));
  } catch (error) {
    logging.error(error);
    return res.status(500).json({ message: "Помилка сервера." });
  }
});
// END Журнал токена

module.exports = router;
