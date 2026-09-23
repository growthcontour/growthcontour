// controllers/orders/cartStatusPoller.js
// Добирає статуси доставки Viber через smsclub.getStatus для завдань зі status='sent'.
// Не конкурує з send-worker: торкається лише delivery_* полів.

const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
const logging = require("../../logging/logging");
const acLogger = require("../../logging/abandoned-cart-logger");

const smsclub = require("./providers/smsclub");
const { readServiceConfig } = require("./serviceConfig");

const P = configDatabase.prefix;
const TICK_MS = 60 * 1000;
const BATCH_TASKS = 200; // завдань за прохід
const RECHECK_MIN = 10; // не частіше, ніж раз на N хв на завдання
const GIVEUP_HOURS = 72; // після цього перестаємо опитувати
const MAX_STATUS_ATTEMPTS = 60;

// Термінальні головні статуси — далі не опитуємо
const FINAL_MAIN = new Set(["Delivered", "Expired", "Undeliverable", "Rejected"]);
// Пріоритет для агрегації кількох id одного завдання (більше = «краще»)
const RANK = { Delivered: 5, Read: 5, Sent: 4, Pending: 3, Rejected: 2, Undeliverable: 1, Expired: 0 };

let timer = null;
let running = false;

// Завдання, яким ще потрібен статус, згруповані по сервісу
async function loadPollable() {
  const [rows] = await connection_pool.query(
    `SELECT q.id, q.service_id, q.correlation_id, q.provider_message_ids,
            q.cart_id, q.event_id, q.channel,
            s.config, s.config_fields, s.provider
     FROM \`${P}orders_abandoned_cart_queue\` q
     JOIN \`${P}orders_abandoned_cart_services\` s ON s.id = q.service_id
     WHERE q.status='sent'
       AND q.delivery_final=0
       AND q.provider_message_ids IS NOT NULL
       AND q.sent_at >= (NOW() - INTERVAL ? HOUR)
       AND q.status_attempts < ?
       AND (q.delivery_checked_at IS NULL OR q.delivery_checked_at < (NOW() - INTERVAL ? MINUTE))
     ORDER BY q.delivery_checked_at IS NULL DESC, q.delivery_checked_at ASC, q.id ASC
     LIMIT ?`,
    [GIVEUP_HOURS, MAX_STATUS_ATTEMPTS, RECHECK_MIN, BATCH_TASKS]
  );
  return rows;
}

function parseIds(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Обрати найкращий (за RANK) статус серед id завдання; final лише коли ВСІ термінальні
function aggregate(ids, statuses) {
  let best = null;
  let allFinal = ids.length > 0;
  for (const id of ids) {
    const st = statuses[id];
    const main = st?.status || null;
    const extra = st?.additionalStatus ?? st?.additionStatus ?? null; // у API трапляється обидва написання
    if (!main) {
      allFinal = false;
      continue;
    }
    if (!FINAL_MAIN.has(main)) allFinal = false;
    const rank = (RANK[main] ?? -1) + (extra === "Read" ? 1 : 0);
    if (!best || rank > best.rank) best = { main, extra, rank };
  }
  return { main: best?.main || null, extra: best?.extra || null, final: allFinal && best != null };
}

async function updateTask(task, agg) {
  await connection_pool.query(
    `UPDATE \`${P}orders_abandoned_cart_queue\`
     SET delivery_status=?, delivery_extra=?, delivery_final=?,
         delivery_checked_at=NOW(), status_attempts=status_attempts+1, date_edit=NOW()
     WHERE id=? AND status='sent'`,
    [agg.main, agg.extra, agg.final ? 1 : 0, task.id]
  );
}

// Позначити перевіреним навіть коли провайдер не дав статусів (щоб не бити щохвилини)
async function touchTask(task) {
  await connection_pool.query(
    `UPDATE \`${P}orders_abandoned_cart_queue\`
     SET delivery_checked_at=NOW(), status_attempts=status_attempts+1, date_edit=NOW()
     WHERE id=? AND status='sent'`,
    [task.id]
  );
}

async function pollServiceGroup(serviceRow, tasks) {
  const cfg = readServiceConfig(serviceRow);

  // Мапа id → завдання; збір усіх id пачки (стеля 500 за документацією)
  const idToTask = new Map();
  const allIds = [];
  for (const t of tasks) {
    const ids = parseIds(t.provider_message_ids);
    t._ids = ids;
    for (const id of ids) {
      idToTask.set(id, t);
      allIds.push(id);
    }
  }
  if (!allIds.length) {
    for (const t of tasks) await touchTask(t);
    return;
  }

  for (let i = 0; i < allIds.length; i += 500) {
    const slice = allIds.slice(i, i + 500);
    const resp = await smsclub.getStatus(cfg, slice);
    if (!resp.ok) {
      // тимчасова проблема — лишаємо на наступний тік, лічильник не крутимо
      logging.error?.(`[cartStatusPoller] getStatus ${serviceRow.provider} failed: ${resp.code}`);
      continue;
    }
    const statuses = resp.statuses || {};
    const touched = new Set();
    for (const t of tasks) {
      if (touched.has(t.id)) continue;
      // опрацьовуємо завдання, чиї id є в цьому slice
      if (!t._ids.some((id) => slice.includes(id))) continue;
      touched.add(t.id);

      const agg = aggregate(t._ids, statuses);
      if (agg.main) {
        await updateTask(t, agg);
        acLogger.event("status", {
          correlation_id: t.correlation_id,
          provider: serviceRow.provider,
          queue_id: t.id,
          cart_id: t.cart_id,
          event_id: t.event_id,
          channel: t.channel,
          delivery_status: agg.main,
          delivery_extra: agg.extra,
          final: agg.final,
          provider_ids: t._ids,
        });
      } else {
        await touchTask(t);
      }
    }
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const rows = await loadPollable();
    if (!rows.length) return;

    // групування по service_id (щоб один токен → одна пачка)
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.service_id)) groups.set(r.service_id, { service: r, tasks: [] });
      groups.get(r.service_id).tasks.push(r);
    }
    for (const { service, tasks } of groups.values()) {
      try {
        await pollServiceGroup(service, tasks);
      } catch (e) {
        logging.error(e);
      }
    }
  } catch (e) {
    logging.error(e);
  } finally {
    running = false;
  }
}

function kickCartStatusPoller() {
  setImmediate(tick);
}

function startCartStatusPoller() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  tick();
}

module.exports = { startCartStatusPoller, kickCartStatusPoller };
