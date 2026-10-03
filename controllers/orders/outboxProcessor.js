const https = require("https");
const http = require("http");
const { URL } = require("url");
const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
const logging = require("../../logging/logging");

const P = configDatabase.prefix;

const MAX_ATTEMPTS = 5;
const BATCH = 10;
const STALE_MIN = 10;
const RETRY_DELAY_MS = 15000;
const TIMEOUT_MS = 20000;

// ─── HTTP POST JSON (без зовнішніх залежностей) ───────────────────────────
const postJson = (urlStr, token, bodyObj) =>
  new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve({ ok: false, status: 0, error: "bad callback_url" }); }

    const data = Buffer.from(JSON.stringify(bodyObj), "utf8");
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        timeout: TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Accept": "application/json",
          "Authorization": "Bearer " + token,
          "Content-Length": data.length,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (ch) => (raw += ch));
        res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, raw }));
      },
    );
    req.on("error", (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0, error: "timeout" }); });
    req.write(data);
    req.end();
  });

// ─── Обробка однієї пачки outbox ──────────────────────────────────────────
const processOutbox = async () => {
  await connection_pool.query(
    `UPDATE \`${P}orders_outbox\` SET status='pending', locked_at=NULL
     WHERE status='processing' AND locked_at < (NOW() - INTERVAL ? MINUTE)`,
    [STALE_MIN],
  );

  const conn = await connection_pool.getConnection();
  let batch = [];
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT o.id, o.id_integration, o.id_order, o.external_id, o.event_type, o.payload,
              i.callback_url, i.outbound_token, i.status AS integ_status,
              i.sync_orders_out, i.sync_status_out
       FROM \`${P}orders_outbox\` o
       JOIN \`${P}orders_integrations\` i ON i.id = o.id_integration
       WHERE o.status='pending' AND o.attempts < ?
       ORDER BY o.id ASC LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS, BATCH],
    );
    if (rows.length) {
      await conn.query(
        `UPDATE \`${P}orders_outbox\` SET status='processing', locked_at=NOW() WHERE id IN (?)`,
        [rows.map((r) => r.id)],
      );
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
    // Інтеграція вимкнена або напрямок вимкнено → позначаємо done (не шлемо)
    const skip =
      row.integ_status !== "active" ||
      !row.callback_url ||
      !row.outbound_token ||
      (row.event_type === "status_change" && !row.sync_status_out) ||
      (row.event_type === "order_updated" && !row.sync_orders_out);

    if (skip) {
      await connection_pool.query(
        `UPDATE \`${P}orders_outbox\` SET status='done', processed_at=NOW(), last_error='skipped (disabled)' WHERE id=?`,
        [row.id],
      );
      continue;
    }

    const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    const envelope = {
      event: row.event_type,
      external_id: row.external_id,
      id_order: row.id_order,
      data: payload,
      sent_at: new Date().toISOString(),
    };

    const res = await postJson(row.callback_url, row.outbound_token, envelope);

    if (res.ok) {
      await connection_pool.query(
        `UPDATE \`${P}orders_outbox\` SET status='done', http_status=?, processed_at=NOW(), last_error=NULL WHERE id=?`,
        [res.status, row.id],
      );
    } else {
      hadRetryable = true;
      await connection_pool.query(
        `UPDATE \`${P}orders_outbox\`
         SET attempts=attempts+1, status=IF(attempts+1>=?, 'failed','pending'),
             http_status=?, locked_at=NULL, last_error=?
         WHERE id=?`,
        [MAX_ATTEMPTS, res.status || null, String(res.error || `http ${res.status}`).slice(0, 999), row.id],
      );
    }
  }

  return { count: batch.length, hadRetryable };
};

// ─── Подієвий воркер (без polling) ────────────────────────────────────────
let running = false, queued = false, retryTimer = null;

const kickOutbox = () => {
  if (running) { queued = true; return; }
  running = true;
  setImmediate(drain);
};

async function drain() {
  try {
    const { count, hadRetryable } = await processOutbox();
    if (count === BATCH) { setImmediate(drain); return; }
    if (hadRetryable && !retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; kickOutbox(); }, RETRY_DELAY_MS);
    }
  } catch (e) {
    logging.error(e);
  }
  running = false;
  if (queued) { queued = false; kickOutbox(); }
}

const recoverOutboxOnStartup = async () => {
  try {
    await connection_pool.query(
      `UPDATE \`${P}orders_outbox\` SET status='pending', locked_at=NULL WHERE status='processing'`,
    );
    kickOutbox();
    logging.info?.("Outbox recovered on startup");
  } catch (e) {
    logging.error(e);
  }
};

module.exports = { processOutbox, kickOutbox, recoverOutboxOnStartup };