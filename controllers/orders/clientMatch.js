const crypto = require("crypto");
const { parsePhoneNumberFromString } = require("libphonenumber-js");
const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");

const P = configDatabase.prefix;
const DEFAULT_GROUP_ID = 1; // Роздріб (is_default=1)

// Нормалізація телефону до E.164 (єдина версія для всього проєкту).
// Повертає { e164, normalized, country } або null.
const normalizePhone = (raw, defaultCountry = null) => {
  if (!raw) return null;
  const hasIntl = /^\s*(\+|00)/.test(String(raw));
  const country = defaultCountry ? String(defaultCountry).toUpperCase() : undefined;
  const parsed = parsePhoneNumberFromString(String(raw), hasIntl ? undefined : country);
  if (parsed && parsed.isValid()) {
    return { e164: parsed.number, normalized: true, country: parsed.country || null };
  }
  const digits = String(raw).replace(/[^\d+]/g, "");
  return digits ? { e164: digits, normalized: false, country: null } : null;
};

// Перерахунок кешу клієнта — ІДЕНТИЧНО orders.js (щоб цифри збігались)
const recalcClientStats = async (conn, id_client) => {
  if (!id_client) return;
  const [[agg]] = await conn.query(
    `SELECT COUNT(*) AS orders_count,
            SUM(CASE WHEN is_canceled = 0 THEN 1 ELSE 0 END) AS orders_valid_count,
            COALESCE(SUM(CASE WHEN is_canceled = 0 THEN total ELSE 0 END), 0) AS total_spent,
            MIN(date_add) AS first_order_at, MAX(date_add) AS last_order_at
     FROM \`${P}orders\` WHERE id_client = ? AND deleted_at IS NULL`,
    [id_client],
  );
  const validCount = Number(agg.orders_valid_count) || 0;
  const totalSpent = Number(agg.total_spent) || 0;
  await conn.query(
    `UPDATE \`${P}orders_clients\`
     SET orders_count = ?, orders_valid_count = ?, total_spent = ?, avg_order_value = ?,
         first_order_at = ?, last_order_at = ?, date_edit = NOW()
     WHERE id = ?`,
    [Number(agg.orders_count) || 0, validCount, totalSpent, validCount > 0 ? totalSpent / validCount : 0,
     agg.first_order_at, agg.last_order_at, id_client],
  );
};

// Пошук збігу В ТРАНЗАКЦІЇ (з блокуванням рядка).
// Пріоритет: external_id → email → нормалізований phone. Ім'я саме по собі НЕ матчить.
// Повертає { id, matched_by } або null.
const findMatchTx = async (conn, { email, phone, id_integration, externalId, defaultCountry }) => {
  // 1) Найнадійніше — той самий клієнт із того самого джерела
  if (externalId && id_integration != null) {
    const [[byExt]] = await conn.query(
      `SELECT id FROM \`${P}orders_clients\`
       WHERE id_integration <=> ? AND external_id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
      [id_integration, String(externalId)],
    );
    if (byExt) return { id: byExt.id, matched_by: "external_id" };
  }
  // 2) Точний email
  const cleanEmail = (email || "").trim().toLowerCase() || null;
  if (cleanEmail) {
    const [[byEmail]] = await conn.query(
      `SELECT id FROM \`${P}orders_clients\`
       WHERE LOWER(email) = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
      [cleanEmail],
    );
    if (byEmail) return { id: byEmail.id, matched_by: "email" };
  }
  // 3) Точний нормалізований телефон
  const ph = normalizePhone(phone, defaultCountry);
  if (ph && ph.normalized) {
    const [[byPhone]] = await conn.query(
      `SELECT id FROM \`${P}orders_clients\`
       WHERE phone = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
      [ph.e164],
    );
    if (byPhone) return { id: byPhone.id, matched_by: "phone" };
  }
  return null;
};

// Створення нового клієнта. Повертає id.
const createClientTx = async (conn, data) => {
  const { snapshot = {}, address = null, id_integration = null, externalId = null,
          sourceChannel = "web", defaultCountry = null, ip = null } = data;

  const cleanEmail = (snapshot.email || "").trim().toLowerCase() || null;
  const ph = normalizePhone(snapshot.phone, defaultCountry);
  const e164 = ph ? ph.e164 : null;
  const display = [snapshot.firstname, snapshot.lastname].filter(Boolean).join(" ") || cleanEmail || e164 || "Без імені";
  const isCompany = snapshot.company ? 1 : 0;

  const [ins] = await conn.query(
    `INSERT INTO \`${P}orders_clients\`
      (id_integration, external_id, source_channel, firstname, lastname, middlename,
       display_name, email, phone, is_company, company, vat_number,
       id_lang, id_default_group, type, ip, date_add, date_edit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, 'customer', ${ip ? "INET6_ATON(?)" : "NULL"}, NOW(), NOW())`,
    [
      id_integration, externalId != null ? String(externalId) : null, sourceChannel,
      snapshot.firstname || null, snapshot.lastname || null, snapshot.middlename || null,
      display, cleanEmail, e164, isCompany, snapshot.company || null, snapshot.vat || null,
      DEFAULT_GROUP_ID, ...(ip ? [ip] : []),
    ],
  );
  const id_client = ins.insertId;

  // Адреса в адресну книгу (якщо є щось змістовне)
  if (address && (address.city || address.address_1 || address.warehouse)) {
    await conn.query(
      `INSERT INTO \`${P}orders_clients_addresses\`
        (id_client, alias, is_default, type, firstname, lastname, middlename, company, phone,
         country, region, city, city_ref, address_1, address_2, warehouse, warehouse_ref, postcode, meta,
         date_add, date_edit)
       VALUES (?, 'Основна', 1, 'both', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [id_client, address.firstname || null, address.lastname || null, address.middlename || null,
       address.company || null, address.phone || e164 || null, address.country || null, address.region || null,
       address.city || null, address.city_ref || null, address.address_1 || null, address.address_2 || null,
       address.warehouse || null, address.warehouse_ref || null, address.postcode || null,
       address.meta && typeof address.meta === "object" ? JSON.stringify(address.meta) : null],
    );
  }
  return id_client;
};

module.exports = { normalizePhone, recalcClientStats, findMatchTx, createClientTx, DEFAULT_GROUP_ID };