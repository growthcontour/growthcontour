const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
const logging = require("../../logging/logging");
const P = configDatabase.prefix;

// Які прапорці інтеграції керують якими подіями (напрям CRM→сайт).
// status_change → sync_status_out; решта змін складу/замовлення → sync_orders_out.
const EVENT_SYNC_FLAG = {
  status_change: "sync_status_out",
  order_updated: "sync_orders_out",
};

// Поставити зміну в чергу CRM→сайт. Викликати ТІЛЬКИ для ручних змін оператора.
// conn — активне з'єднання транзакції (емісія — частина тієї ж транзакції, що й зміна).
//
// Запобіжники (як у топових CRM): не ставимо в чергу, якщо джерело не здатне
// або не налаштоване приймати зміну назад. Тихо виходимо — це не помилка.
const emitToOutbox = async (conn, { id_order, event_type, data }) => {
  // Ядро замовлення + налаштування інтеграції одним запитом
  const [[o]] = await conn.query(
    `SELECT o.id_integration, o.external_id, o.source_channel,
            i.platform, i.callback_url, i.status AS integration_status,
            i.sync_orders_out, i.sync_status_out
     FROM \`${P}orders\` o
     LEFT JOIN \`${P}orders_integrations\` i ON i.id = o.id_integration
     WHERE o.id = ? LIMIT 1`,
    [id_order],
  );

  // 1) Немає інтеграції або external_id → нема куди/що слати
  //    (замовлення створене вручну в CRM або швидке "1 клік" без справжнього order_id на сайті)
  if (!o || !o.id_integration || !o.external_id) return;

  // 2) Інтеграція вимкнена → не синхронізуємо
  if (o.integration_status !== "active") return;

  // 3) Custom-джерело або джерело без приймача (callback_url) не вміє приймати зміни назад
  if (o.platform === "custom" || !o.callback_url) return;

  // 4) Прапорець напряму синхронізації під тип події має бути ввімкнений
  const flag = EVENT_SYNC_FLAG[event_type];
  if (flag && Number(o[flag]) !== 1) return;

  // Пройшли всі запобіжники → ставимо в чергу
  await conn.query(
    `INSERT INTO \`${P}orders_outbox\`
      (id_integration, id_order, external_id, event_type, payload, status, date_add)
     VALUES (?, ?, ?, ?, ?, 'pending', NOW())`,
    [o.id_integration, id_order, o.external_id, event_type, JSON.stringify(data)],
  );
};

module.exports = { emitToOutbox };