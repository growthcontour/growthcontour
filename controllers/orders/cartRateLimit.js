// controllers/orders/cartRateLimit.js
// In-memory sliding-window rate limiter для приймальних endpoint-ів.
// Ключ = id_token + IP. Один інстанс; під кластер замінюється на Redis-бекенд.

const logging = require("../../logging/logging");

// налаштування через env, з дефолтами
const WINDOW_MS = parseInt(process.env.CART_RL_WINDOW_MS || "1000", 10); // вікно
const MAX_HITS = parseInt(process.env.CART_RL_MAX || "20", 10); // запитів у вікні
const SWEEP_MS = 60 * 1000;

// key -> number[] (таймстемпи звернень у поточному вікні)
const buckets = new Map();

function hit(key, now = Date.now(), maxHits = MAX_HITS) {
  let arr = buckets.get(key);
  if (!arr) {
    arr = [];
    buckets.set(key, arr);
  }
  const from = now - WINDOW_MS;
  while (arr.length && arr[0] < from) arr.shift();
  if (arr.length >= maxHits) {
    const retryMs = arr[0] + WINDOW_MS - now;
    return { allowed: false, retryAfterMs: Math.max(0, retryMs), remaining: 0 };
  }
  arr.push(now);
  return { allowed: true, retryAfterMs: 0, remaining: maxHits - arr.length };
}

// періодичне прибирання порожніх бакетів, щоб Map не ріс
const sweeper = setInterval(() => {
  const from = Date.now() - WINDOW_MS;
  for (const [k, arr] of buckets) {
    while (arr.length && arr[0] < from) arr.shift();
    if (!arr.length) buckets.delete(k);
  }
}, SWEEP_MS);
if (sweeper.unref) sweeper.unref();

// Middleware-фабрика. Викликати ПІСЛЯ verifyOrderToken (потрібен req.orderToken).
// name — мітка endpoint-а для логів/заголовків.
// пер-endpoint перевизначення ліміту (мітка → maxHits)
const PER_NAME_MAX = {
  reconcile: parseInt(process.env.CART_RL_MAX_RECONCILE || "60", 10),
};

function cartRateLimit(name) {
  return function (req, res, next) {
    const tokenId = req.orderToken?.id ?? "anon";
    const ip = req.clientIp || req.ip || "0.0.0.0";
    const key = `${name}:${tokenId}:${ip}`;
    const maxForName = PER_NAME_MAX[name] ?? MAX_HITS;

    const r = hit(key, Date.now(), maxForName);
    if (r.allowed) {
      res.setHeader("X-RateLimit-Limit", maxForName);
      res.setHeader("X-RateLimit-Remaining", r.remaining);
      return next();
    }

    const retryAfterSec = Math.ceil(r.retryAfterMs / 1000) || 1;
    res.setHeader("Retry-After", retryAfterSec);
    res.setHeader("X-RateLimit-Limit", MAX_HITS);
    res.setHeader("X-RateLimit-Remaining", 0);
    logging.error?.(`[cartRateLimit] 429 ${key} retryAfter=${retryAfterSec}s`);
    return res.status(429).json({ status: "error", reason: "rate_limited", retry_after: retryAfterSec });
  };
}

module.exports = { cartRateLimit };
