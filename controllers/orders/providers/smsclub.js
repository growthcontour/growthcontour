// controllers/orders/providers/smsclub.js
// Клієнт SMSclub Viber API. Один шар над HTTP: побудова payload за правилами
// документації, clamping lifetime, парсинг відповіді, маппінг помилок.

const i18n = require("../../../config/i18n/i18n");
const LOCALE = process.env.APP_LOCALE || "uk";
const t = (phrase, vars) => i18n.__({ phrase, locale: LOCALE }, vars || {});

const SEND_URL = "https://im.smsclub.mobi/vibers/send";
const STATUS_URL = "https://im.smsclub.mobi/vibers/status";

const DEFAULT_TIMEOUT_MS = 15000;
const LIFETIME_DEFAULT = 43200;
const LIFETIME_MIN_SINGLE = 60;
const LIFETIME_MIN_BULK = 3600;
const LIFETIME_MAX = 86400;

// Маппінг HTTP-статусів провайдера у стабільні коди + ознака ретраю.
// retriable=true → тимчасова проблема, воркер може повторити.
const STATUS_MAP = {
  200: { code: "ok", retriable: false },
  400: { code: "validation_error", retriable: false },
  401: { code: "auth_error", retriable: false },
  429: { code: "rate_limited", retriable: true },
  460: { code: "account_disabled", retriable: false },
  461: { code: "bad_sender", retriable: false },
  462: { code: "bad_text", retriable: false },
  463: { code: "no_valid_phone", retriable: false },
  464: { code: "no_money", retriable: false },
  465: { code: "provider_error", retriable: true },
  466: { code: "bad_sender_sms", retriable: false },
  467: { code: "bad_text_sms", retriable: false },
  468: { code: "no_money_sms", retriable: false },
};

// Текст статусу — orders.providers.smsclub.<code>
function mapStatus(httpStatus) {
  const m = STATUS_MAP[httpStatus] || (httpStatus >= 500 ? { code: "unavailable", retriable: true } : { code: "unknown", retriable: false });
  return { ...m, message: t("orders.providers.smsclub." + m.code, { http: httpStatus }) };
}

function clampLifetime(raw, phonesCount) {
  const min = phonesCount > 1 ? LIFETIME_MIN_BULK : LIFETIME_MIN_SINGLE;
  let n = parseInt(raw, 10);
  if (!Number.isFinite(n)) n = LIFETIME_DEFAULT;
  return Math.min(LIFETIME_MAX, Math.max(min, n));
}

// Побудова тіла запиту за правилами документації:
//  - button_txt і button_url — тільки разом;
//  - picture_url — лише за наявності пари кнопки;
//  - senderSms і messageSms (Viber+SMS) — тільки разом.
function buildPayload(cfg, { phones, message }) {
  const payload = {
    sender: cfg.sender,
    phones,
    message,
    lifetime: clampLifetime(cfg.lifetime, phones.length),
  };

  const btnTxt = (cfg.button_txt || "").trim();
  const btnUrl = (cfg.button_url || "").trim();
  if (btnTxt && btnUrl) {
    payload.button_txt = btnTxt;
    payload.button_url = btnUrl;
    const pic = (cfg.picture_url || "").trim();
    if (pic) payload.picture_url = pic;
  }

  const smsSender = (cfg.sender_sms || "").trim();
  const smsText = (cfg.message_sms || "").trim();
  if (smsSender && smsText) {
    payload.senderSms = smsSender;
    payload.messageSms = smsText;
  }

  return payload;
}

// Розбір успішної відповіді: successfulRequest.requestData.{messages, additionalInfo}
function parseSuccess(body) {
  const rd = body?.successfulRequest?.requestData || {};
  const messages = Array.isArray(rd.messages) ? rd.messages : [];
  const add = rd.additionalInfo || {};
  return {
    messages, // [{ number, id }]
    incorrectPhones: Array.isArray(add.incorrectPhones) ? add.incorrectPhones : [],
    blackList: Array.isArray(add.blackList) ? add.blackList : [],
  };
}

// Розбір errorRequest.errors → плаский рядок
function parseError(body) {
  const errs = body?.errorRequest?.errors;
  if (!errs || typeof errs !== "object") return null;
  const parts = [];
  for (const k of Object.keys(errs)) {
    const v = errs[k];
    parts.push(Array.isArray(v) ? v.join("; ") : String(v));
  }
  return parts.join(" | ") || null;
}

async function httpPost(url, token, payload, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { httpStatus: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// Головний метод відправлення. Один запит (ретраї — на рівні воркера).
// Повертає нормалізований результат.
async function send(cfg, { phones, message, timeoutMs } = {}) {
  if (!cfg?.token) {
    return { ok: false, code: "auth_error", retriable: false, message: t("orders.providers.smsclub.no_token"), httpStatus: null, request: null, response: null, messages: [], incorrectPhones: [], blackList: [] };
  }
  const list = (Array.isArray(phones) ? phones : [phones]).filter(Boolean);
  if (!list.length) {
    return { ok: false, code: "no_valid_phone", retriable: false, message: t("orders.providers.smsclub.no_phones"), httpStatus: null, request: null, response: null, messages: [], incorrectPhones: [], blackList: [] };
  }

  const payload = buildPayload(cfg, { phones: list, message });

  let httpStatus = null;
  let body = null;
  try {
    ({ httpStatus, body } = await httpPost(SEND_URL, cfg.token, payload, timeoutMs));
  } catch (e) {
    const aborted = e?.name === "AbortError";
    return {
      ok: false,
      code: aborted ? "timeout" : "network_error",
      retriable: true,
      message: t(aborted ? "orders.providers.smsclub.timeout" : "orders.providers.smsclub.network"),
      httpStatus: null,
      request: payload,
      response: { error: String(e?.message || e) },
      messages: [],
      incorrectPhones: [],
      blackList: [],
    };
  }

  const mapped = mapStatus(httpStatus);
  const base = { httpStatus, request: payload, response: body, code: mapped.code, retriable: mapped.retriable };

  if (httpStatus === 200) {
    const parsed = parseSuccess(body);
    // 200, але жодне повідомлення не прийнято → фактична невдача
    if (!parsed.messages.length) {
      const provErr = parseError(body);
      return { ok: false, message: provErr || t("orders.providers.smsclub.not_accepted"), ...base, code: "not_accepted", retriable: false, ...parsed };
    }
    return { ok: true, message: mapped.message, ...base, ...parsed };
  }

  const provErr = parseError(body);
  return { ok: false, message: provErr || mapped.message, ...base, messages: [], incorrectPhones: [], blackList: [] };
}

// Статуси повідомлень за їх id (для Етапу 5 — status poller)
async function getStatus(cfg, messageIds, { timeoutMs } = {}) {
  if (!cfg?.token) return { ok: false, code: "auth_error", statuses: {}, response: null };
  const ids = (Array.isArray(messageIds) ? messageIds : [messageIds]).filter(Boolean).map(String);
  if (!ids.length) return { ok: false, code: "no_ids", statuses: {}, response: null };

  let httpStatus = null;
  let body = null;
  try {
    ({ httpStatus, body } = await httpPost(STATUS_URL, cfg.token, { messageIds: ids }, timeoutMs));
  } catch (e) {
    return { ok: false, code: "network_error", statuses: {}, response: { error: String(e?.message || e) } };
  }
  if (httpStatus !== 200) {
    return { ok: false, code: mapStatus(httpStatus).code, statuses: {}, response: body };
  }
  const statuses = body?.successfulRequest?.requestData || {};
  return { ok: true, code: "ok", statuses, response: body };
}

module.exports = {
  send,
  getStatus,
  buildPayload,
  clampLifetime,
  mapStatus,
  parseSuccess,
  parseError,
  SEND_URL,
  STATUS_URL,
};
