// controllers/orders/cartSendWorker.js
// Send-worker: claim (SKIP LOCKED) → застосувати вікно → відправити → фіналізувати.
// Ретраї з backoff на рівні черги. НЕ будує payload сам — тільки через smsclub.send().

const os = require("os");
const crypto = require("crypto");
const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
const logging = require("../../logging/logging");
const abandonedCartLogger = require("../../logging/abandoned-cart-logger");

const smsclub = require("./providers/smsclub");
const { readServiceConfig, normalizePhone } = require("./serviceConfig");
const { renderTemplate } = require("./renderTemplate");
const { minutesUntilAllowed } = require("./sendSchedule");

const P = configDatabase.prefix;
const WORKER_ID = `${os.hostname()}#${process.pid}`;
const TICK_MS = 15 * 1000;
const BATCH = 20;
const MAX_DRAIN_LOOPS = 25; // запобіжник від нескінченного зливу за тік
const STALE_MIN = 5; // reclaim 'processing', завислих довше N хв
const SUPPORTED = new Set(["smsclub_viber", "smsclub_viber2"]);

let timer = null;
let running = false;

function backoffMs(attempts) {
  const s = Math.min(3600, 60 * Math.pow(2, Math.max(0, attempts - 1)));
  return s * 1000;
}

// Повернути завислі processing → pending
async function reclaimStale() {
  await connection_pool.query(
    `UPDATE \`${P}orders_abandoned_cart_queue\`
     SET status='pending', locked_at=NULL, locked_by=NULL, date_edit=NOW()
     WHERE status='processing' AND locked_at < (NOW() - INTERVAL ? MINUTE)`,
    [STALE_MIN]
  );
}

// Атомарно захопити пачку завдань
async function claimBatch(limit) {
  const conn = await connection_pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT id FROM \`${P}orders_abandoned_cart_queue\`
       WHERE status='pending' AND run_after <= NOW()
       ORDER BY run_after ASC, id ASC
       LIMIT ${Number(limit)}
       FOR UPDATE SKIP LOCKED`
    );
    if (!rows.length) {
      await conn.commit();
      return [];
    }
    const ids = rows.map((r) => r.id);
    await conn.query(
      `UPDATE \`${P}orders_abandoned_cart_queue\`
       SET status='processing', locked_at=NOW(), locked_by=?, date_edit=NOW()
       WHERE id IN (?)`,
      [WORKER_ID, ids]
    );
    await conn.commit();
    return ids;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function loadTask(id) {
  const [rows] = await connection_pool.query(
    `SELECT q.id, q.cart_id, q.event_id, q.service_id, q.attempt_no, q.attempts, q.max_attempts,
            ac.cart, ac.status AS cart_status, ac.total_amount, ac.currency, ac.items_count,
            e.message AS template, e.send_time_from, e.send_time_to, e.send_days,
            s.config, s.config_fields, s.provider, s.channel
     FROM \`${P}orders_abandoned_cart_queue\` q
     JOIN \`${P}orders_abandoned_cart\` ac ON ac.id = q.cart_id
     JOIN \`${P}orders_abandoned_cart_events\` e ON e.id = q.event_id
     JOIN \`${P}orders_abandoned_cart_services\` s ON s.id = q.service_id
     WHERE q.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

// Фіналізатори (guard WHERE status='processing' — щоб не перетерти reclaim)
async function toSent(t, phone, providerIds, correlation_id) {
  await connection_pool.query(
    `UPDATE \`${P}orders_abandoned_cart_queue\`
     SET status='sent', attempts=attempts+1, sent_at=NOW(), recipient=?,
         provider_message_ids=?, correlation_id=?, last_error=NULL,
         locked_at=NULL, locked_by=NULL, date_edit=NOW()
     WHERE id=? AND status='processing'`,
    [phone, JSON.stringify(providerIds || []), correlation_id || null, t.id]
  );
  await connection_pool.query(
    `UPDATE \`${P}orders_abandoned_cart\`
     SET status='notified', date_edit=NOW()
     WHERE id=? AND status IN ('active','abandoned')`,
    [t.cart_id]
  );
}

async function toRetry(t, errMsg) {
  const nextAttempts = t.attempts + 1;
  await connection_pool.query(
    `UPDATE \`${P}orders_abandoned_cart_queue\`
     SET status='pending', attempts=?, run_after=(NOW() + INTERVAL ? SECOND),
         last_error=?, locked_at=NULL, locked_by=NULL, date_edit=NOW()
     WHERE id=? AND status='processing'`,
    [nextAttempts, Math.round(backoffMs(nextAttempts) / 1000), errMsg?.slice(0, 1000) || null, t.id]
  );
}

async function toFailed(t, errMsg) {
  await connection_pool.query(
    `UPDATE \`${P}orders_abandoned_cart_queue\`
     SET status='failed', attempts=attempts+1, last_error=?, locked_at=NULL, locked_by=NULL, date_edit=NOW()
     WHERE id=? AND status='processing'`,
    [errMsg?.slice(0, 1000) || null, t.id]
  );
}

async function toSkipped(t, reason) {
  await connection_pool.query(
    `UPDATE \`${P}orders_abandoned_cart_queue\`
     SET status='skipped', last_error=?, locked_at=NULL, locked_by=NULL, date_edit=NOW()
     WHERE id=? AND status='processing'`,
    [reason?.slice(0, 1000) || null, t.id]
  );
}

async function rescheduleWindow(t, waitMinutes) {
  await connection_pool.query(
    `UPDATE \`${P}orders_abandoned_cart_queue\`
     SET status='pending', run_after=(NOW() + INTERVAL ? MINUTE),
         locked_at=NULL, locked_by=NULL, date_edit=NOW()
     WHERE id=? AND status='processing'`,
    [waitMinutes, t.id]
  );
}

async function writeLog(t, { correlation_id, recipient, message, recovery_token, success, httpStatus, request, response }) {
  const reqWithCid = { correlation_id, payload: request ?? null };
  await connection_pool.query(
    `INSERT INTO \`${P}orders_abandoned_cart_log\`
      (cart_id, event_id, attempt_no, source, service_id, channel, recipient, message, recovery_token,
       status, http_status, request, response, sent_at, date_add)
     VALUES (?, ?, ?, 'auto', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [t.cart_id, t.event_id, t.attempt_no ?? 1, t.service_id ?? null, t.channel ?? null, recipient || "", message ?? null, recovery_token ?? null, success ? 1 : 2, httpStatus ?? null, JSON.stringify(reqWithCid), JSON.stringify(response ?? null), success ? new Date() : null]
  );
}

async function processTask(id) {
  const t = await loadTask(id);
  if (!t) return;

  // 1) Кошик міг закритися після постановки в чергу
  if (!["active", "abandoned", "notified"].includes(t.cart_status)) {
    await toSkipped(t, `cart status=${t.cart_status}`);
    return;
  }

  // 2) Провайдер підтримується?
  if (!SUPPORTED.has(t.provider)) {
    await toFailed(t, `provider ${t.provider} not supported`);
    return;
  }

  // 3) Send-вікно
  const wait = minutesUntilAllowed(new Date(), {
    from: t.send_time_from,
    to: t.send_time_to,
    days: t.send_days,
  });
  if (wait > 0) {
    await rescheduleWindow(t, wait); // спробу НЕ витрачаємо
    return;
  }

  const correlation_id = crypto.randomUUID();
  const cart = typeof t.cart === "string" ? JSON.parse(t.cart) : t.cart;
  const telephone = cart.customer?.telephone || "";
  const phone = normalizePhone(telephone);

  if (!phone) {
    await writeLog(t, { correlation_id, recipient: telephone, message: null, recovery_token: null, success: false, httpStatus: null, request: null, response: { error: "invalid_phone" } });
    abandonedCartLogger.event("send", {
      correlation_id,
      provider: t.provider,
      result: "error",
      code: "invalid_phone",
      retriable: false,
      queue_id: t.id,
      cart_id: t.cart_id,
      event_id: t.event_id,
      attempt_no: t.attempt_no,
      recipient_raw: telephone,
    });
    await toFailed(t, "invalid phone");
    return;
  }

  const serviceConfig = readServiceConfig(t);
  const { message, recovery_token } = await renderTemplate(t.template, t, cart);

  // 5) Відправка через provider-модуль
  const result = await smsclub.send(serviceConfig, { phones: [phone], message });

  await writeLog(t, {
    correlation_id,
    recipient: phone,
    message,
    recovery_token,
    success: result.ok,
    httpStatus: result.httpStatus,
    request: result.request,
    response: result.response,
  });

  abandonedCartLogger.event("send", {
    correlation_id,
    provider: t.provider,
    result: result.ok ? "success" : "error",
    queue_id: t.id,
    cart_id: t.cart_id,
    event_id: t.event_id,
    service_id: t.service_id,
    attempt_no: t.attempt_no,
    channel: t.channel,
    recipient: phone,
    http_status: result.httpStatus,
    code: result.code,
    retriable: result.retriable,
    provider_ids: result.messages.map((m) => m.id),
    incorrect_phones: result.incorrectPhones,
    black_list: result.blackList,
    total_amount: t.total_amount,
    currency: t.currency,
    request: result.request,
    response: result.response,
  });

  if (result.ok) {
    await toSent(
      t,
      phone,
      result.messages.map((m) => m.id),
      correlation_id
    );
    return;
  }

  // 6) Помилка: ретрай чи термінальна
  if (result.retriable && t.attempts + 1 < t.max_attempts) {
    await toRetry(t, `${result.code}: ${result.message}`);
  } else {
    await toFailed(t, `${result.code}: ${result.message}`);
  }
}

async function drainOnce() {
  const ids = await claimBatch(BATCH);
  if (!ids.length) return 0;
  for (const id of ids) {
    try {
      await processTask(id);
    } catch (e) {
      logging.error(e);
      // звільняємо лок, лишаємо на повторний підбір
      await connection_pool
        .query(
          `UPDATE \`${P}orders_abandoned_cart_queue\`
           SET status='pending', locked_at=NULL, locked_by=NULL, date_edit=NOW()
           WHERE id=? AND status='processing'`,
          [id]
        )
        .catch(() => {});
    }
  }
  return ids.length;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await reclaimStale();
    for (let i = 0; i < MAX_DRAIN_LOOPS; i++) {
      const n = await drainOnce();
      if (n < BATCH) break; // черга спорожніла
    }
  } catch (e) {
    logging.error(e);
  } finally {
    running = false;
  }
}

function kickCartSendWorker() {
  setImmediate(tick);
}

function startCartSendWorker() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  reclaimStale().catch(() => {});
  tick();
}

module.exports = { startCartSendWorker, kickCartSendWorker };
