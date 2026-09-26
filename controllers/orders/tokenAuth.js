const crypto = require("crypto");
const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
const logging = require("../../logging/logging");

const P = configDatabase.prefix;

const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

const getClientIp = (req) => {
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.ip || req.connection?.remoteAddress || null;
};

const getRequestHost = (req) => {
  const s = req.headers["origin"] || req.headers["referer"] || "";
  if (!s) return null;
  try { return new URL(s).hostname.toLowerCase(); } catch { return null; }
};

// off | any | all
const checkSource = (mode, host, ip, domains, ips) => {
  if (mode === "off") return { ok: true };
  domains = Array.isArray(domains) ? domains : [];
  ips = Array.isArray(ips) ? ips : [];
  const dSet = domains.length > 0, iSet = ips.length > 0;
  if (!dSet && !iSet) return { ok: true };
  const dOk = dSet ? (host && domains.includes(host)) : null;
  const iOk = iSet ? (ip && ips.includes(ip)) : null;
  if (mode === "all") {
    if (dSet && !dOk) return { ok: false, reason: "domain_denied" };
    if (iSet && !iOk) return { ok: false, reason: "ip_denied" };
    return { ok: true };
  }
  if (dOk === true || iOk === true) return { ok: true };
  return { ok: false, reason: dSet ? "domain_denied" : "ip_denied" };
};

// Запис спроби в orders_tokens_log + лічильники токена
const logAttempt = async (data) => {
  const d = {
    id_token: null, prefix: null, ip: null, domain: null, method: "POST",
    endpoint: null, user_agent: null, result: "rejected", reject_reason: null,
    http_status: null, id_order: null, external_id: null, message: null, ...data,
  };
  try {
    await connection_pool.query(
      `INSERT INTO \`${P}orders_tokens_log\`
        (id_token, prefix, ip, domain, method, endpoint, user_agent,
         result, reject_reason, http_status, id_order, external_id, message, date_add)
       VALUES (?, ?, INET6_ATON(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [d.id_token, d.prefix, d.ip, d.domain, d.method, d.endpoint, d.user_agent,
       d.result, d.reject_reason, d.http_status, d.id_order, d.external_id, (d.message || "").slice(0, 999)],
    );
    if (d.id_token) {
      await connection_pool.query(
        d.result === "success"
          ? `UPDATE \`${P}orders_tokens\` SET usage_count = usage_count + 1, last_used_at = NOW(), last_used_ip = INET6_ATON(?), last_used_domain = ? WHERE id = ?`
          : `UPDATE \`${P}orders_tokens\` SET error_count = error_count + 1 WHERE id = ?`,
        d.result === "success" ? [d.ip, d.domain, d.id_token] : [d.id_token],
      );
    }
  } catch (e) { logging.error(e); }
};

// Фабрика middleware: verifyOrderToken('can_create_orders')
const verifyOrderToken = (requiredScope) => async (req, res, next) => {
  const ip = getClientIp(req);
  const host = getRequestHost(req);
  const ua = (req.headers["user-agent"] || "").slice(0, 512);
  const endpoint = req.originalUrl;
  const externalId = req.body?.source?.external_id != null ? String(req.body.source.external_id) : null;

  const reject = async (status, reason, id_token = null, prefix = null) => {
    await logAttempt({ id_token, prefix, ip, domain: host, endpoint, user_agent: ua,
      result: "rejected", reject_reason: reason, http_status: status, external_id: externalId,
      message: `rejected: ${reason}` });
    return res.status(status).json({ status: "error", reason });
  };

  try {
    const auth = req.headers["authorization"] || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const raw = m ? m[1].trim() : null;
    if (!raw) return reject(401, "bad_token");

    const prefix = raw.slice(0, 12);
    const [[t]] = await connection_pool.query(
  `SELECT id, id_integration, environment, allowed_domains, allowed_ips, source_check_mode,
          can_create_orders, can_update_orders, can_update_status, can_create_clients, can_read,
          can_sync_carts,
          status, expires_at, revoked_at
   FROM \`${P}orders_tokens\` WHERE token_hash = ? LIMIT 1`,
  [hashToken(raw)],
);

    if (!t) return reject(401, "bad_token", null, prefix);
    if (t.revoked_at) return reject(403, "revoked", t.id, prefix);
    if (t.status === "disabled") return reject(403, "disabled", t.id, prefix);
    if (t.expires_at && new Date(t.expires_at) < new Date()) return reject(403, "expired", t.id, prefix);

    const src = checkSource(t.source_check_mode, host, ip, t.allowed_domains, t.allowed_ips);
    if (!src.ok) return reject(403, src.reason, t.id, prefix);

    if (requiredScope && t[requiredScope] !== 1) return reject(403, "no_scope", t.id, prefix);

    req.orderToken = t;
    req.orderTokenPrefix = prefix;
    req.clientIp = ip;
    req.sourceHost = host;
    next();
  } catch (e) {
    logging.error(e);
    return res.status(500).json({ status: "error", message: "Помилка сервера." });
  }
};

module.exports = { verifyOrderToken, logAttempt, getClientIp, getRequestHost };