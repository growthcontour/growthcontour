const logging = require("../../../logging/logging");
const cfg = require("../../../config/notifications/config");

function getServer() {
  try {
    return require("../../socket/socket").getIO();
  } catch (e) {
    console.log("[inapp] getIO error:", e.message);
    return null;
  }
}

function resolveTab(eventType) {
  if (cfg.tabByType && cfg.tabByType[eventType]) return cfg.tabByType[eventType];
  const prefix = String(eventType || "").split(".")[0];
  return (cfg.tabByType && cfg.tabByType[prefix]) || cfg.defaultTab || "personal";
}

async function send(job) {
  const server = getServer();
  console.log("[inapp] send, server?", !!server, "user", job.userId);
  if (!server) return { skipped: true };

  const room = `io_manager_notifications_${job.userId}`;
  const data = {
    event_id: job.eventId,
    type: job.eventType,
    tab: resolveTab(job.eventType),
    title: job.payload && job.payload.title,
    name: job.payload && job.payload.name,
    message: job.payload && job.payload.message,
    url: job.payload && job.payload.url,
    collapse_key: job.collapseKey,
  };

  // Ім'я події МУСИТЬ дорівнювати назві кімнати — саме це слухає script.ejs
  console.log("[inapp] emit →", room, data);
  server.to(room).emit(room, data);
  server.to("io_notifications_header").emit("io_notifications_header", data);

  return { ok: true };
}

module.exports = { send };
