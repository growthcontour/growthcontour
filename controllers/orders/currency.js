const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");

const P = config.get("configDatabase").prefix;
const BASE_CURRENCY = "UAH";

let ratesCache = null;
let ratesCacheAt = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getRates() {
  if (ratesCache && Date.now() - ratesCacheAt < CACHE_TTL) return ratesCache;

  const [rows] = await connection_pool.query(`SELECT currency_iso_code, rate FROM ${P}orders_currency`);
  ratesCache = {};
  rows.forEach((r) => {
    ratesCache[r.currency_iso_code] = Number(r.rate) || 0;
  });
  ratesCache[BASE_CURRENCY] = 1;
  ratesCacheAt = Date.now();
  return ratesCache;
}

/**
 * Повертає курс валюти до базової.
 * incomingRate — те, що прислав сайт. Довіряємо йому лише якщо він осмислений.
 */
async function resolveRate(iso, incomingRate) {
  iso = (iso || BASE_CURRENCY).toUpperCase();
  if (iso === BASE_CURRENCY) return 1;

  const rates = await getRates();

  const r = Number(incomingRate);
  // Сайт часто шле rate=1 як заглушку. Довіряємо йому, тільки якщо
  // довідник підтверджує, що курс дійсно близький до одиниці.
  if (r > 0) {
    const ref = rates[iso];
    if (r !== 1) return r;
    if (ref > 0 && Math.abs(ref - 1) < 0.01) return 1;
  }

  if (rates[iso] > 0) return rates[iso];

  logging.error(`[currency] Немає курсу для ${iso}, використано 1`);
  return 1;
}

function toBase(amount, rate) {
  return Math.round((Number(amount) || 0) * (Number(rate) || 1) * 10000) / 10000;
}

module.exports = { resolveRate, toBase, getRates, BASE_CURRENCY };
