const nodemailer = require("nodemailer");
const config = require("../../../config/config");
const logging = require("../../../logging/logging");

let transport = null;
function buildTransport() {
  if (transport) return transport;
  // ⚠️ ПІДСТАВ свій транспорт з controllers/mail/mail.js, якщо він уже налаштований.
  const mail = config.get("mail") || {};
  transport = nodemailer.createTransport({
    host: mail.host,
    port: mail.port,
    secure: !!mail.secure,
    auth: mail.user ? { user: mail.user, pass: mail.pass } : undefined,
  });
  return transport;
}

async function send(job) {
  const to = job.payload && (job.payload.email || job.payload.to);
  const subject = (job.payload && job.payload.subject) || "Сповіщення";
  const html = (job.payload && (job.payload.html || job.payload.message)) || "";

  if (!to || !html) return { skipped: true };

  try {
    const info = await buildTransport().sendMail({
      from: (config.get("mail") || {}).from || "no-reply@localhost",
      to,
      subject,
      html,
    });
    // bounce/complaint — асинхронні, ловляться вебхуками провайдера (Етап 4)
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    logging.error(e);
    throw e; // черга зробить retry
  }
}

module.exports = { send };
