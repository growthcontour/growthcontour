const TelegramBot = require("node-telegram-bot-api");
const logging = require("../../../logging/logging");

// Формат токена бота — жорстко; будь-що інше не потрапляє в URL (захист від підміни хоста / шляху)
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
// Методи Bot API, які викликаємо напряму (whitelist замість довільного рядка)
const METHODS = new Set(["getMe", "sendMessage", "sendPhoto", "sendVideo", "sendAudio", "sendDocument"]);

/**
 * Прямий виклик Bot API — для налаштувань і сповіщень у спільні чати (канали зв'язку, сайти).
 * Повертає відповідь Telegram ({ ok, result | description }), не кидає помилок.
 */
async function call(token, method, params) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return { ok: false, description: "invalid_token_format" };
  if (!METHODS.has(method)) return { ok: false, description: "method_not_allowed" };
  try {
    const res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params || {}),
      redirect: "error",
    });
    return await res.json();
  } catch (e) {
    return { ok: false, description: e.message };
  }
}

// Кеш інстансів ботів за токеном (polling:false — тільки відправка)
const bots = {};
function getBot(token) {
  if (!bots[token]) bots[token] = new TelegramBot(token, { polling: false });
  return bots[token];
}

// Токен: або глобальний з env, або переданий у payload (мульти-бот)
function resolveToken(job) {
  return (job.payload && job.payload.bot_token) || process.env.TELEGRAM_BOT_TOKEN;
}

async function send(job) {
  const token = resolveToken(job);
  const chatId = job.payload && (job.payload.tg_chat_id || job.payload.chat_id);
  const text = (job.payload && (job.payload.tg_text || job.payload.message)) || "";

  if (!token || !chatId || !text) return { skipped: true };

  try {
    const opts = { parse_mode: "HTML" };
    const threadId = job.payload && (job.payload.topic_id || job.payload.message_thread_id);
    if (threadId) opts.message_thread_id = Number(threadId);
    await getBot(token).sendMessage(chatId, text, opts);
    return { ok: true };
  } catch (e) {
    // 429 → кидаємо помилку з retry-after, щоб черга зробила backoff
    const retryAfter = e && e.response && e.response.body && e.response.body.parameters && e.response.body.parameters.retry_after;
    if (retryAfter) {
      const err = new Error(`telegram 429, retry after ${retryAfter}s`);
      err.retryAfter = retryAfter;
      throw err;
    }
    logging.error(e);
    throw e;
  }
}

module.exports = { send, call, TOKEN_RE };
