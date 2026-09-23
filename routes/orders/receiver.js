// =========================================================================
//  ПРИЙОМ ЗАМОВЛЕНЬ ІЗ ЗОВНІШНІХ ДЖЕРЕЛ (CMS/маркетплейси)
//  Автентифікація за API-токеном (НЕ за сесією адмінки).
//  Окремо від orders.js, бо тут інша модель доступу.
// =========================================================================
const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
const logging = require("../../logging/logging");

const p = configDatabase.prefix;

// ─────────────────────────────────────────────────────────────────────────
// Хеш токена — SHA-256 (у БД зберігається лише хеш, не сам токен)
// ─────────────────────────────────────────────────────────────────────────
const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

// ─────────────────────────────────────────────────────────────────────────
// Витягнути домен (host) із Origin або Referer запиту
// ─────────────────────────────────────────────────────────────────────────
const extractDomain = (req) => {
  const src = req.get("origin") || req.get("referer") || "";
  if (!src) return null;
  try {
    return new URL(src).hostname.toLowerCase();
  } catch (e) {
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Клієнтський IP (враховуючи проксі). Бере перший X-Forwarded-For або socket.
// ─────────────────────────────────────────────────────────────────────────
const clientIp = (req) => {
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.socket?.remoteAddress || null;
};

// ─────────────────────────────────────────────────────────────────────────
// Проста перевірка збігу IP зі списком (точний збіг або CIDR-підмережа).
//   allowed — масив рядків ["1.2.3.4","10.0.0.0/24"]. Порожній → дозволено все.
//   Для IPv4 підтримуємо CIDR; для IPv6 — точний збіг (CIDR згодом).
// ─────────────────────────────────────────────────────────────────────────
const ipAllowed = (ip, allowed) => {
  if (!Array.isArray(allowed) || allowed.length === 0) return true; // порожній = будь-який
  if (!ip) return false;
  const clean = ip.replace(/^::ffff:/, ""); // нормалізуємо IPv4-mapped IPv6

  const ipToLong = (s) => s.split(".").reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
  const isV4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

  for (const rule of allowed) {
    if (rule.includes("/") && isV4(clean)) {
      // CIDR для IPv4
      const [net, bitsStr] = rule.split("/");
      if (!isV4(net)) continue;
      const bits = parseInt(bitsStr, 10);
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if ((ipToLong(clean) & mask) === (ipToLong(net) & mask)) return true;
    } else if (rule === clean || rule === ip) {
      return true; // точний збіг (v4 або v6)
    }
  }
  return false;
};

// ─────────────────────────────────────────────────────────────────────────
// Перевірка домену зі списку (точний збіг або суфікс піддомену).
//   allowed — ["shop.com"]. "www.shop.com" пройде під "shop.com".
//   Порожній список → дозволено будь-який домен.
// ─────────────────────────────────────────────────────────────────────────
const domainAllowed = (domain, allowed) => {
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  if (!domain) return false;
  const d = domain.toLowerCase();
  return allowed.some((a) => {
    const base = String(a).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return d === base || d.endsWith("." + base);
  });
};

// ─────────────────────────────────────────────────────────────────────────
// ЗАПИС У ЖУРНАЛ використань токена (детальний аудит кожної спроби).
//   Викликається і при успіху, і при відмові. Ніколи не кидає — лог не має
//   ламати основний потік (помилку логування просто пишемо в logging).
// ─────────────────────────────────────────────────────────────────────────
const logTokenUse = async (data) => {
  try {
    await connection_pool.query(
      `INSERT INTO \`${p}orders_tokens_log\`
        (id_token, prefix, ip, domain, method, endpoint, user_agent,
         result, reject_reason, http_status, id_order, external_id, message, date_add)
       VALUES (?, ?, INET6_ATON(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        data.id_token || null,
        data.prefix || null,
        data.ip || null,
        data.domain || null,
        data.method || null,
        data.endpoint || null,
        (data.user_agent || "").slice(0, 512),
        data.result, // 'success' | 'rejected'
        data.reject_reason || null,
        data.http_status || null,
        data.id_order || null,
        data.external_id || null,
        (data.message || "").slice(0, 999),
      ],
    );
  } catch (e) {
    logging.error(e); // лог не повинен валити запит
  }
};

// ─────────────────────────────────────────────────────────────────────────
// СЕРЦЕ: перевірка токена. Повертає { ok, token?, status, reason?, message? }.
//   Порядок перевірок: хеш → відкликано → вимкнено → термін → джерело → scope.
//   Кожна відмова — з кодом причини (reason) для логу й HTTP-статусом.
//   requiredScope — назва булевого поля scope, напр. 'can_create_orders'.
// ─────────────────────────────────────────────────────────────────────────
const verifyToken = async (rawToken, { ip, domain, requiredScope } = {}) => {
  if (!rawToken) {
    return { ok: false, status: 401, reason: "bad_token", message: "Токен відсутній." };
  }

  const token_hash = hashToken(rawToken);
  const [[token]] = await connection_pool.query(
    `SELECT * FROM \`${p}orders_tokens\` WHERE token_hash = ? LIMIT 1`,
    [token_hash],
  );

  if (!token) {
    return { ok: false, status: 401, reason: "bad_token", message: "Невірний токен." };
  }

  // Відкликаний — назавжди (незворотно)
  if (token.revoked_at) {
    return { ok: false, status: 403, reason: "revoked", token, message: "Токен відкликано." };
  }
  // Тимчасово вимкнений
  if (token.status === "disabled") {
    return { ok: false, status: 403, reason: "disabled", token, message: "Токен вимкнено." };
  }
  // Термін дії
  if (token.expires_at && new Date(token.expires_at) < new Date()) {
    return { ok: false, status: 403, reason: "expired", token, message: "Термін дії токена сплив." };
  }

  // Перевірка джерела (IP / домен) за режимом
  const mode = token.source_check_mode; // 'any' | 'all' | 'off'
  if (mode !== "off") {
    const okIp = ipAllowed(ip, token.allowed_ips);
    const okDomain = domainAllowed(domain, token.allowed_domains);

    if (mode === "all") {
      if (!okIp) return { ok: false, status: 403, reason: "ip_denied", token, message: "IP не дозволено." };
      if (!okDomain) return { ok: false, status: 403, reason: "domain_denied", token, message: "Домен не дозволено." };
    } else {
      // 'any' — досить одного зі збігів, АЛЕ лише якщо відповідний список заданий.
      // Якщо обидва списки порожні → пропускаємо (обмежень немає).
      const hasIpList = Array.isArray(token.allowed_ips) && token.allowed_ips.length > 0;
      const hasDomList = Array.isArray(token.allowed_domains) && token.allowed_domains.length > 0;
      if (hasIpList || hasDomList) {
        if (!(okIp || okDomain)) {
          return { ok: false, status: 403, reason: "ip_denied", token, message: "Джерело не дозволено (IP/домен)." };
        }
      }
    }
  }

  // Scope (право на дію)
  if (requiredScope && !token[requiredScope]) {
    return { ok: false, status: 403, reason: "no_scope", token, message: "Недостатньо прав токена." };
  }

  return { ok: true, status: 200, token };
};

// ─────────────────────────────────────────────────────────────────────────
// Оновити кеш використання токена після успіху (last_used_*, лічильники).
// ─────────────────────────────────────────────────────────────────────────
const touchTokenSuccess = async (id_token, ip, domain) => {
  try {
    await connection_pool.query(
      `UPDATE \`${p}orders_tokens\`
       SET last_used_at = NOW(), last_used_ip = INET6_ATON(?), last_used_domain = ?,
           usage_count = usage_count + 1
       WHERE id = ?`,
      [ip || null, domain || null, id_token],
    );
  } catch (e) {
    logging.error(e);
  }
};

const touchTokenError = async (id_token) => {
  if (!id_token) return;
  try {
    await connection_pool.query(
      `UPDATE \`${p}orders_tokens\` SET error_count = error_count + 1 WHERE id = ?`,
      [id_token],
    );
  } catch (e) {
    logging.error(e);
  }
};

// Експорт сервісів (роути прийому додамо далі в цьому ж файлі)
module.exports = router;
module.exports.verifyToken = verifyToken;
module.exports.hashToken = hashToken;
module.exports.extractDomain = extractDomain;
module.exports.clientIp = clientIp;
module.exports.logTokenUse = logTokenUse;
module.exports.touchTokenSuccess = touchTokenSuccess;
module.exports.touchTokenError = touchTokenError;