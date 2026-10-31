// controllers/orders/statusFlags.js
// Єдине джерело істини для похідних прапорців замовлення.
//
// Прапорці orders.is_paid / is_shipped / is_canceled НЕ приходять із джерела —
// вони похідні від довідника orders_status. Довідник змінюється рідко (адмін
// руками), а читається на кожне вхідне замовлення, тому тримаємо його в кеші
// з TTL і примусовим скиданням при редагуванні статусів.

const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");

const P = config.get("configDatabase").prefix;

const TTL_MS = 5 * 60 * 1000;

let cache = null; // Map<id_status, flags>
let cachedAt = 0;
let inflight = null; // дедуплікація одночасних промахів кешу

// Завантаження довідника у Map. Окремо від getMap(), щоб inflight
// гарантовано очищався навіть при помилці запиту.
async function loadMap() {
  const [rows] = await connection_pool.query(
    `SELECT id, paid, shipped, is_negative, count_in_revenue, is_final
       FROM \`${P}orders_status\``
  );

  const map = new Map();
  for (const r of rows) {
    map.set(
      Number(r.id),
      Object.freeze({
        id_status: Number(r.id),
        is_paid: Number(r.paid) === 1 ? 1 : 0,
        is_shipped: Number(r.shipped) === 1 ? 1 : 0,
        is_canceled: Number(r.is_negative) === 1 ? 1 : 0,
        count_in_revenue: Number(r.count_in_revenue) === 1 ? 1 : 0,
        is_final: Number(r.is_final) === 1 ? 1 : 0,
      })
    );
  }
  return map;
}

// Актуальна Map. Паралельні виклики під час промаху чекають один запит,
// а не роблять N однакових (важливо для пачки inbox по 10 замовлень).
async function getMap() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  if (inflight) return inflight;

  inflight = loadMap()
    .then((map) => {
      cache = map;
      cachedAt = Date.now();
      return map;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/**
 * Прапорці замовлення, похідні від статусу.
 * @param {number} idStatus — FK orders_status
 * @returns {Promise<{is_paid:number,is_shipped:number,is_canceled:number,count_in_revenue:number,is_final:number}>}
 * @throws {Error} якщо статусу немає в довіднику
 */
async function deriveOrderFlags(idStatus) {
  const id = Number(idStatus);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Unknown status: invalid id (${idStatus})`);
  }

  let map = await getMap();
  let flags = map.get(id);

  // Промах може означати, що статус створили щойно, а invalidate не долетів
  // (інший процес / pm2 cluster). Даємо рівно один примусовий перечит.
  if (!flags && Date.now() - cachedAt > 0) {
    invalidateStatusFlags();
    map = await getMap();
    flags = map.get(id);
  }

  if (!flags) {
    // Свідомо кидаємо: краще лишити замовлення в inbox на retry,
    // ніж записати його з нульовими прапорцями і зіпсувати аналітику.
    throw new Error(`Unknown status #${id}: not in ${P}orders_status`);
  }

  return flags;
}

/** Скидання кешу. Викликати після будь-якої зміни orders_status. */
function invalidateStatusFlags() {
  cache = null;
  cachedAt = 0;
}

/** Усі статуси (для місць, де потрібен весь довідник, напр. валідація). */
async function getAllStatusFlags() {
  return Array.from((await getMap()).values());
}

/** Прогрів на старті — щоб перше замовлення не чекало на запит. */
async function warmStatusFlags() {
  try {
    await getMap();
  } catch (err) {
    logging.error("[statusFlags] прогрів не вдався: " + err.message);
  }
}

/**
 * Зміна статусу замовлення в межах транзакції conn: прапорці, історія, журнал подій,
 * статистика клієнта, склад і черга CRM→сайт. Сповіщення й kickOutbox — після commit, у викликача.
 * @returns {Promise<null|{id_status_old:number, was_paid:number, flags:object}>} null — замовлення немає
 * @throws {Error} статусу немає в довіднику
 */
async function applyStatus(conn, idOrder, idStatus, { idUser = null, source = "manual", comment = "", notify = 0, extra = {} } = {}) {
  const [[order]] = await conn.query(
    `SELECT status, is_paid FROM \`${P}orders\` WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
    [idOrder]
  );
  if (!order) return null;

  const flags = await deriveOrderFlags(idStatus);
  const idStatusOld = Number(order.status);

  await conn.query(
    `UPDATE \`${P}orders\` SET status = ?, is_paid = ?, is_shipped = ?, is_canceled = ?, date_edit = NOW() WHERE id = ?`,
    [idStatus, flags.is_paid, flags.is_shipped, flags.is_canceled, idOrder]
  );
  await conn.query(
    `INSERT INTO \`${P}orders_status_history\` (id_order, id_status, id_status_old, id_user, source, comment, notified, date_add)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [idOrder, idStatus, idStatusOld, idUser, source, comment, notify]
  );
  await conn.query(
    `INSERT INTO \`${P}orders_events\` (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, 'status_change', ?, ?, NOW())`,
    [idOrder, idUser, JSON.stringify({ before: idStatusOld, after: idStatus, comment, notify, ...extra }), source]
  );

  // Ліниві require — ці модулі самі залежать від статусів
  await require("../clients/stats").recalcForOrder(conn, idOrder);
  await require("../catalog/products/order-stock").afterItems(conn, idOrder, null);
  await require("./emitOutbox").emitToOutbox(conn, {
    id_order: idOrder,
    event_type: "status_change",
    data: { id_status: idStatus, id_status_old: idStatusOld, comment: comment || null },
  });

  return { id_status_old: idStatusOld, was_paid: Number(order.is_paid), flags };
}

module.exports = {
  applyStatus,
  deriveOrderFlags,
  invalidateStatusFlags,
  getAllStatusFlags,
  warmStatusFlags,
};