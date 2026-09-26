const cfg = require("../../config/notifications/config");
const dispatch = require("./dispatch");

// ── SYNC driver ─────────────────────────────────────────
const syncDriver = {
  async enqueueDispatch(eventId) {
    return dispatch.dispatchEvent(eventId);
  },
  async enqueueSend(channel, job) {
    // синхронна доставка одразу
    const channels = require("./channels");
    return channels.deliver(channel, job);
  },
};

// ── BULL driver ─────────────────────────────────────────
let bullDriver = null;
function buildBullDriver() {
  const { Queue } = require("bullmq");
  const { connection } = require("./redis");

  const defaultJobOpts = {
    attempts: cfg.retry.attempts,
    backoff: { type: "exponential", delay: cfg.retry.backoffMs },
    removeOnComplete: 1000, // не роздуваємо Redis
    removeOnFail: 5000,
  };

  const dispatchQ = new Queue("notif:dispatch", { connection, defaultJobOptions: defaultJobOpts });
  const channelQ = {}; // ліниво створювані черги каналів
  const getChannelQ = (ch) => {
    if (!channelQ[ch]) {
      channelQ[ch] = new Queue(`notif:send:${ch}`, { connection, defaultJobOptions: defaultJobOpts });
    }
    return channelQ[ch];
  };

  return {
    async enqueueDispatch(eventId) {
      // jobId = ідемпотентність: та сама подія не дублює dispatch-job
      await dispatchQ.add("dispatch", { eventId }, { jobId: `disp:${eventId}` });
    },
    async enqueueSend(channel, job) {
      const q = getChannelQ(channel);
      // jobId склеює канал+подію+юзера → без дублів при ретраях
      const jobId = `snd:${channel}:${job.eventId}:${job.userId}`;
      await q.add("send", job, { jobId, priority: job.priority || 5 });
    },
    _dispatchQ: dispatchQ,
    _getChannelQ: getChannelQ,
  };
}

function getDriver() {
  if (cfg.driver !== "bull") return syncDriver;
  if (!bullDriver) bullDriver = buildBullDriver();
  return bullDriver;
}

module.exports = {
  enqueueDispatch: (id) => getDriver().enqueueDispatch(id),
  enqueueSend: (ch, job) => getDriver().enqueueSend(ch, job),
  _getDriver: getDriver, // для воркера
};
