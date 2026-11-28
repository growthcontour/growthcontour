// controllers/orders/renderTemplate.js
const crypto = require("crypto");
const config = require("../../config/config");
const configServer = config.get("configServer");

const RECOVERY_BASE = String(configServer.url || "").replace(/\/+$/, "");

const { getOrCreateToken } = require("./recoveryToken");

async function renderTemplate(template, cartRow, cart) {
  const customer = cart.customer || {};
  const recovery_token = await getOrCreateToken(cartRow);

  const productsList = (cart.cart || [])
    .map((item, index) => {
      const options = item.options && Object.keys(item.options).length ? Object.values(item.options).join(", ") : null;
      return options ? `${index + 1}. ${item.name} - ${options}` : `${index + 1}. ${item.name}`;
    })
    .join("\n");

  const recovery_url = RECOVERY_BASE ? `${RECOVERY_BASE}/recover?token=${recovery_token}` : `/recover?token=${recovery_token}`;

  const message = String(template || "")
    .replace(/{firstname}/g, customer.firstname || "")
    .replace(/{lastname}/g, customer.lastname || "")
    .replace(/{email}/g, customer.email || "")
    .replace(/{telephone}/g, customer.telephone || "")
    .replace(/{total_amount}/g, cartRow.total_amount || "0")
    .replace(/{currency}/g, cartRow.currency || "")
    .replace(/{items_count}/g, cartRow.items_count || "0")
    .replace(/{products}/g, productsList || "")
    .replace(/{recovery_url}/g, recovery_url);

  return { message, recovery_token };
}

module.exports = { renderTemplate, RECOVERY_BASE };
