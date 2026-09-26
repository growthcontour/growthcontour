// controllers/orders/recoveryToken.js
// Один стабільний recovery-токен на кошик. Ідемпотентно: якщо вже є — вертає наявний.
const crypto = require("crypto");
const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");

const P = configDatabase.prefix;

// Повертає (створює за потреби) recovery_token для кошика.
async function getOrCreateToken(cartRow) {
  const cartId = cartRow.id;

  const [[existing]] = await connection_pool.query(`SELECT token FROM \`${P}orders_abandoned_cart_recovery\` WHERE cart_id = ? LIMIT 1`, [cartId]);
  if (existing) return existing.token;

  const token = crypto.randomBytes(32).toString("hex");
  try {
    await connection_pool.query(
      `INSERT INTO \`${P}orders_abandoned_cart_recovery\`
         (cart_id, token, id_integration, store_id, session_id, date_add)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [cartId, token, cartRow.id_integration ?? null, cartRow.store_id ?? null, cartRow.session_id ?? null]
    );
    return token;
  } catch (e) {
    // гонка: інший процес щойно створив — перечитуємо
    const [[again]] = await connection_pool.query(`SELECT token FROM \`${P}orders_abandoned_cart_recovery\` WHERE cart_id = ? LIMIT 1`, [cartId]);
    if (again) return again.token;
    throw e;
  }
}

module.exports = { getOrCreateToken };
