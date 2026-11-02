// Налаштування — лише з .env (тека config/ без json-файлів). Прапорець має стояти ДО require("config"),
// інакше node-config встигає надрукувати попередження «No configurations found» / «NODE_ENV … did not match».
process.env.SUPPRESS_NO_CONFIG_WARNING = "true";
// Без цього бібліотека config попереджає, що для NODE_ENV=production немає config/production.json
process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
// pm2 передає номер процесу в NODE_APP_INSTANCE ('0', '1' …), а node-config шукає за ним config/default-0.json
// і друкує «NODE_APP_INSTANCE value of '0' did not match …». Номер зберігаємо в PM2_INSTANCE, а для config прибираємо.
if (process.env.NODE_APP_INSTANCE !== undefined) {
  process.env.PM2_INSTANCE = process.env.PM2_INSTANCE || process.env.NODE_APP_INSTANCE;
  delete process.env.NODE_APP_INSTANCE;
}
const config = require("config");

config.util.setModuleDefaults("configServer", {
  port: Number(process.env.PORT || 3000),
  url: process.env.APP_URL || "",
});

config.util.setModuleDefaults("configDatabase", {
  prefix: process.env.DB_PREFIX || "",
});

config.util.setModuleDefaults("configInvite", {
  ttl_hours: Number(process.env.INVITE_TTL_HOURS || 72),
  reset_ttl_minutes: Number(process.env.RESET_TTL_MINUTES || 30),
});

config.util.setModuleDefaults("configJWT", {
  jwt: {
    jwt_secret: process.env.JWT_SECRET,
    jwt_refresh_secret: process.env.JWT_REFRESH_SECRET,
    jwt_time_expires: process.env.JWT_EXPIRES || "7d",
    jwt_time_expires_remember: process.env.JWT_EXPIRES_REMEMBER || "30d",
    jwt_cookie_expiring: process.env.JWT_COOKIE_EXPIRING || "90",
  },
});

config.util.setModuleDefaults("configTFA", {
  tfa: {
    enc_key: process.env.TFA_ENC_KEY,
    issuer: process.env.TFA_ISSUER || "Growth contour",
    step: Number(process.env.TFA_STEP || 30),
    window: Number(process.env.TFA_WINDOW || 1),
    backup_codes_count: Number(process.env.TFA_BACKUP_COUNT || 10),
  },
});

config.util.setModuleDefaults("telegramTokenKey", {
  telegramTokenKey: process.env.TELEGRAM_TOKEN_KEY || "",
});

config.util.setModuleDefaults("configMail", {
  host: process.env.MAIL_HOST,
  port: Number(process.env.MAIL_PORT || 587),
  user: process.env.MAIL_USER,
  pass: process.env.MAIL_PASS,
  from: process.env.MAIL_FROM,
});

for (const key of ["JWT_SECRET", "JWT_REFRESH_SECRET", "TFA_ENC_KEY", "APP_ENCRYPTION_KEY", "WEBCHAT_FILE_SECRET", "SESSION_SECRET"]) {
  if (!process.env[key]) throw new Error(`[config] відсутній авто-секрет: ${key}. Запусти: node ensure-env.js`);
}

module.exports = config;