const crypto = require("crypto");
const pool = require("../../config/database/connection_pool");
const logging = require("../../logging/logging");
const cfg = require("../../config/notifications/config");
const queue = require("./queue");

const P = cfg.prefix;

// audience: { user:ID } | { group:ID } | { topic:'x' } | { broadcast:true }
function normalizeAudience(a) {
  if (!a || typeof a !== "object") throw new Error("audience обов'язкова");
  if (a.broadcast) return { type: "broadcast", ref: "all" };
  if (a.user != null) return { type: "user", ref: String(a.user) };
  if (a.group != null) return { type: "group", ref: String(a.group) };
  if (a.topic != null) return { type: "topic", ref: String(a.topic) };
  throw new Error("невідома audience");
}

function makeKey(type, aud, payload, explicit) {
  if (explicit) return String(explicit).slice(0, 64);
  const raw = JSON.stringify({ type, aud, payload });
  return crypto.createHash("sha1").update(raw).digest("hex"); // 40 симв.
}

/**
 * ЄДИНИЙ вхідний контракт. Весь код системи кличе тільки це.
 * @returns {Promise<{id:number, deduped:boolean}>}
 */
async function notify(event) {
  const { type, audience, channels = ["inapp"], payload = {}, key, priority = 5, collapseKey = "", expiresAt = null } = event || {};

  if (!type) throw new Error("type обов'язковий");
  const aud = normalizeAudience(audience);
  const eventKey = makeKey(type, aud, payload, key);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [res] = await conn.query(
      `INSERT INTO ${P}notif_events
         (event_key, event_type, audience_type, audience_ref,
          channels, priority, collapse_key, payload, expires_at)
       VALUES (?,?,?,?,CAST(? AS JSON),?,?,CAST(? AS JSON),?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [eventKey, type, aud.type, aud.ref, JSON.stringify(channels), priority, collapseKey, JSON.stringify(payload), expiresAt]
    );

    // affectedRows: 1 = вставлено нове; 2 = спрацював ON DUPLICATE (дубль)
    const isNew = res.affectedRows === 1;
    const eventId = res.insertId;

    await conn.commit();

    // Передаємо в чергу ТІЛЬКИ нову подію. Дубль — просто повертаємо існуючий id.
    if (isNew) {
      await queue.enqueueDispatch(eventId).catch((e) => {
        // Черга/воркер упали? Подія в MySQL (dispatched=0) — її підбере
        // fallback-полер outbox (Етап 2). Нічого не втрачено.
        logging.error(e);
      });
    }
    return { id: eventId, deduped: !isNew };
  } catch (error) {
    await conn.rollback().catch(() => {});
    logging.error(error);
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = { notify };
