const pool = require("../../config/database/connection_pool");
const logging = require("../../logging/logging");
const cfg = require("../../config/notifications/config");

const P = cfg.prefix;

const impl = {
  inapp: require("./channels/inapp"),
  telegram: require("./channels/telegram"),
  email: require("./channels/email"),
  webpush: require("./channels/webpush"),
};

async function setStatus(job, status, error) {
  if (job.channel === "inapp") return; // inapp не трекаємо в delivery
  await pool
    .query(
      `UPDATE ${P}notif_delivery
        SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = NOW(3)
      WHERE event_id = ? AND user_id = ? AND channel = ?`,
      [status, error ? String(error).slice(0, 2000) : null, job.eventId, job.userId, job.channel]
    )
    .catch((e) => logging.error(e));
}

async function deliver(channel, job) {
  const ch = impl[channel];
  if (!ch) throw new Error(`невідомий канал: ${channel}`);
  try {
    const res = await ch.send(job);
    await setStatus(job, res && res.skipped ? "skipped" : "sent");
    return res;
  } catch (e) {
    await setStatus(job, "failed", e && e.message);
    throw e;
  }
}

module.exports = { deliver, impl };
