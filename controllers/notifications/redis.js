const IORedis = require("ioredis");
const cfg = require("../../config/notifications/config");
const logging = require("../../logging/logging");

// BullMQ вимагає maxRetriesPerRequest: null
const connection = new IORedis({
  host: cfg.redis.host,
  port: cfg.redis.port,
  password: cfg.redis.password,
  db: cfg.redis.db,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

connection.on("error", (e) => logging.error(e));

module.exports = { connection };
