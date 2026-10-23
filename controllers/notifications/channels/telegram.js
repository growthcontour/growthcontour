const TelegramBot = require("node-telegram-bot-api");
const logging = require("../../../logging/logging");

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

module.exports = { send };
