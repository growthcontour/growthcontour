const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
const logging = require("../../logging/logging");

const P = configDatabase.prefix;

// Скільки днів неактивності до авто-експірації активного кошика
const RETENTION_DAYS = parseInt(process.env.CART_RETENTION_DAYS, 10) || 30;
// Скільки днів тримати закриті кошики перед фізичним видаленням (0 = не видаляти)
const PURGE_DAYS = parseInt(process.env.CART_PURGE_DAYS, 10) || 90;
// Період прогону обслуговування
const INTERVAL_MS = (parseInt(process.env.CART_MAINT_INTERVAL_MIN, 10) || 60) * 60000;

const runMaintenance = async () => {
  try {
    // 1) Застарілі активні → expired
    await connection_pool.query(
      `UPDATE \`${P}orders_abandoned_cart\`
       SET status = 'expired', date_edit = NOW()
       WHERE status IN ('active','abandoned','notified')
         AND last_activity_at < (NOW() - INTERVAL ? DAY)`,
      [RETENTION_DAYS]
    );

    // 2) Ретенція: прибираємо давно закриті
    if (PURGE_DAYS > 0) {
      await connection_pool.query(
        `DELETE FROM \`${P}orders_abandoned_cart\`
         WHERE status IN ('recovered','expired')
           AND date_edit < (NOW() - INTERVAL ? DAY)`,
        [PURGE_DAYS]
      );
    }
  } catch (e) {
    logging.error(e);
  }
};

let started = false;
const startCartMaintenance = () => {
  if (started) return;
  started = true;
  setTimeout(runMaintenance, 30000); // перший прогін через 30с після старту
  setInterval(runMaintenance, INTERVAL_MS); // далі — за періодом
  logging.info?.("Cart maintenance started");
};

module.exports = { runMaintenance, startCartMaintenance };
