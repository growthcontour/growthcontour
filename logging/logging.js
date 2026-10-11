const pino = require("pino");

const errorLogger = pino({
  level: "error",
}, pino.destination("./logging/logs/error.log"));

const infoLogger = pino({
  level: "info",
}, pino.destination("./logging/logs/info.log"));

module.exports = {
  error: errorLogger.error.bind(errorLogger),
  info: infoLogger.info.bind(infoLogger),
};
