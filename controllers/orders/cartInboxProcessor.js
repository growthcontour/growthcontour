const crypto = require("crypto");
const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
const logging = require("../../logging/logging");

const P = configDatabase.prefix;

const MAX_ATTEMPTS = 5;
const BATCH = 20; // кошиків більше, ніж замовлень — беремо ширшу пачку
const STALE_MIN = 10;
const RETRY_DELAY_MS = 15000;

const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

const toDbDateTime = (v) => {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
};

// ─── Нормалізований знімок для колонки cart (json) ───────────────────────
//     Форма { customer, cart } збережена сумісною зі списком кошиків.
const buildSnapshot = (body) => {
  const c = body.customer || {};
  const customer = {
    customer_id: c.customer_id != null ? c.customer_id : null,
    firstname: c.firstname || "",
    lastname: c.lastname || "",
    email: c.email || "",
    telephone: c.telephone || c.phone || "",
    consent: c.consent != null ? (c.consent ? 1 : 0) : null,
  };

  const cart = (Array.isArray(body.items) ? body.items : []).map((it) => ({
    product_id: it.product_id != null ? it.product_id : null,
    sku: it.sku || null,
    name: it.name || "",
    quantity: Number(it.quantity) || 0,
    price: round4(it.price),
    total: round4(it.total != null ? it.total : (Number(it.price) || 0) * (Number(it.quantity) || 0)),
    options: it.options && typeof it.options === "object" ? it.options : {},
    image_url: it.image_url || null,
    product_url: it.product_url || null,
    recurring: !!it.recurring,
  }));
  return { customer, cart };
};

// ─── Похідні значення (валюта, сума, кількість) ──────────────────────────
const deriveCartValues = (body, snapshot) => {
  const currencyIso = (typeof body.currency === "string" ? body.currency : (body.currency && body.currency.iso) || "UAH").toUpperCase().slice(0, 3);

  let total_amount = body.totals && body.totals.total_amount != null ? round4(body.totals.total_amount) : null;
  if (total_amount == null) {
    total_amount = round4(snapshot.cart.reduce((s, i) => s + (Number(i.total) || 0), 0));
  }

  let items_count = body.totals && body.totals.items_count != null ? parseInt(body.totals.items_count, 10) : null;
  if (items_count == null) {
    items_count = snapshot.cart.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  }

  return { currencyIso, total_amount, items_count };
};

// ─── Хеш змістовного стану (echo-suppression). БЕЗ last_activity_at ──────
const computeCartSyncHash = (snapshot, derived) => {
  const material = {
    customer: snapshot.customer,
    cart: snapshot.cart,
    total_amount: derived.total_amount,
    items_count: derived.items_count,
    currency: derived.currencyIso,
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
};

// ─── Upsert кошика (уся логіка в одній транзакції, за uq_store_session) ──
const upsertCartFromPayload = async (conn, body) => {
  const src = body.source || {};
  const store_id = parseInt(src.store_id, 10);
  const session_id = String(src.session_id);
  const external_cart_id = src.external_cart_id != null ? String(src.external_cart_id) : null;
  const id_integration = body.__id_integration ?? src.id_integration ?? null;

  const snapshot = buildSnapshot(body);
  const derived = deriveCartValues(body, snapshot);
  const syncHash = computeCartSyncHash(snapshot, derived);

  const ctx = body.context || {};
  const utm = body.utm || {};
  const id_customer = body.customer && body.customer.customer_id != null ? parseInt(body.customer.customer_id, 10) || null : null;
  const emailNorm = snapshot.customer && snapshot.customer.email ? String(snapshot.customer.email).trim().toLowerCase() : null;

  const firstSeen = toDbDateTime(ctx.first_seen_at);
  const lastActivity = toDbDateTime(ctx.last_activity_at);

  const [[exists]] = await conn.query(
    `SELECT id, sync_hash, status FROM \`${P}orders_abandoned_cart\`
     WHERE store_id = ? AND session_id = ? LIMIT 1 FOR UPDATE`,
    [store_id, session_id]
  );

  if (exists) {
    // Закритий кошик тут не воскрешаємо — це справа recover/reconcile (Етапи 4–5)
    if (exists.status === "recovered") {
      return exists.id; // відновлений (замовлений) кошик не воскрешаємо
    }
    // 'expired' навмисно НЕ повертаємо — дозволяємо повторне відкриття нижче

    // Echo: зміст не змінився → лише продовжуємо таймер активності
    if (exists.sync_hash && exists.sync_hash === syncHash && exists.status !== "expired") {
      await conn.query(
        `UPDATE \`${P}orders_abandoned_cart\`
         SET last_activity_at = GREATEST(last_activity_at, COALESCE(?, last_activity_at)),
             date_edit = NOW()
         WHERE id = ?`,
        [lastActivity, exists.id]
      );
      return exists.id;
    }
    // Повне оновлення знімка
    await conn.query(
      `UPDATE \`${P}orders_abandoned_cart\`
       		SET status = IF(status = 'expired', 'active', status),
           id_integration = ?, id_customer = ?, email = ?, external_cart_id = ?,
           currency = ?, total_amount = ?, items_count = ?, sync_hash = ?,
           cart = ?, utm_source = ?, utm_medium = ?, utm_campaign = ?,
           ip = COALESCE(?, ip), user_agent = COALESCE(?, user_agent),
           last_activity_at = GREATEST(last_activity_at, COALESCE(?, last_activity_at)),
           date_edit = NOW()
       WHERE id = ?`,
      [id_integration, id_customer, emailNorm, external_cart_id, derived.currencyIso, derived.total_amount, derived.items_count, syncHash, JSON.stringify(snapshot), utm.source || null, utm.medium || null, utm.campaign || null, ctx.ip || null, ctx.user_agent || null, lastActivity, exists.id]
    );
    return exists.id;
  }

  const [ins] = await conn.query(
    `INSERT INTO \`${P}orders_abandoned_cart\`
      (store_id, id_integration, id_customer, email, session_id, external_cart_id, currency,
       total_amount, items_count, sync_hash, status, cart,
       utm_source, utm_medium, utm_campaign, ip, user_agent,
       first_seen_at, last_activity_at, date_add, date_edit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?,
             COALESCE(?, NOW()), COALESCE(?, NOW()), NOW(), NOW())`,
    [store_id, id_integration, id_customer, emailNorm, session_id, external_cart_id, derived.currencyIso, derived.total_amount, derived.items_count, syncHash, JSON.stringify(snapshot), utm.source || null, utm.medium || null, utm.campaign || null, ctx.ip || null, ctx.user_agent || null, firstSeen, lastActivity]
  );
  return ins.insertId;
};

// ─── Обробка однієї пачки inbox. Повертає { count, hadRetryable } ────────
const processCartInbox = async () => {
  await connection_pool.query(
    `UPDATE \`${P}orders_abandoned_cart_inbox\`
     SET status = 'pending', locked_at = NULL
     WHERE status = 'processing' AND locked_at < (NOW() - INTERVAL ? MINUTE)`,
    [STALE_MIN]
  );

  const conn = await connection_pool.getConnection();
  let batch = [];
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT id, id_integration, payload FROM \`${P}orders_abandoned_cart_inbox\`
       WHERE status = 'pending' AND attempts < ?
       ORDER BY id ASC LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS, BATCH]
    );
    if (rows.length) {
      await conn.query(`UPDATE \`${P}orders_abandoned_cart_inbox\` SET status = 'processing', locked_at = NOW() WHERE id IN (?)`, [rows.map((r) => r.id)]);
      batch = rows;
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    logging.error(e);
    return { count: 0, hadRetryable: false };
  } finally {
    conn.release();
  }

  let hadRetryable = false;

  for (const row of batch) {
    const c = await connection_pool.getConnection();
    try {
      await c.beginTransaction();
      const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      payload.__id_integration = row.id_integration;
      const cartId = await upsertCartFromPayload(c, payload);
      await c.query(
        `UPDATE \`${P}orders_abandoned_cart_inbox\`
         SET status = 'done', id_cart = ?, processed_at = NOW(), last_error = NULL WHERE id = ?`,
        [cartId, row.id]
      );
      await c.commit();
    } catch (err) {
      await c.rollback();
      logging.error(err);
      hadRetryable = true;
      await connection_pool.query(
        `UPDATE \`${P}orders_abandoned_cart_inbox\`
         SET attempts = attempts + 1,
             status = IF(attempts + 1 >= ?, 'failed', 'pending'),
             locked_at = NULL,
             last_error = ?
         WHERE id = ?`,
        [MAX_ATTEMPTS, String(err.message || err).slice(0, 999), row.id]
      );
    } finally {
      c.release();
    }
  }

  return { count: batch.length, hadRetryable };
};

// ─── Подієвий воркер (без polling за годинником) ─────────────────────────
let running = false;
let queued = false;
let retryTimer = null;

const kickCartWorker = () => {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  setImmediate(drain);
};

async function drain() {
  try {
    const { count, hadRetryable } = await processCartInbox();
    if (count === BATCH) {
      setImmediate(drain);
      return;
    }
    if (hadRetryable && !retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        kickCartWorker();
      }, RETRY_DELAY_MS);
    }
  } catch (e) {
    logging.error(e);
  }
  running = false;
  if (queued) {
    queued = false;
    kickCartWorker();
  }
}

const recoverCartInboxOnStartup = async () => {
  try {
    await connection_pool.query(`UPDATE \`${P}orders_abandoned_cart_inbox\` SET status = 'pending', locked_at = NULL WHERE status = 'processing'`);
    kickCartWorker();
    logging.info?.("Cart inbox recovered on startup");
  } catch (e) {
    logging.error(e);
  }
};

module.exports = { processCartInbox, kickCartWorker, recoverCartInboxOnStartup, upsertCartFromPayload };
