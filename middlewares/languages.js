// middleware/languages.js
const connection_pool = require("../config/database/connection_pool");
const config = require("../config/config");
const configDatabase = config.get("configDatabase");
const logging = require("../logging/logging");

// Кеш активних мов у пам'яті процесу (мови змінюються дуже рідко)
let languagesCache = null;

async function loadLanguages(req, res, next) {
  try {
    if (!languagesCache) {
      const [rows] = await connection_pool.query(
        `SELECT id, iso, name FROM \`${configDatabase.prefix}languages\`
        WHERE active = 1 ORDER BY sort ASC`
      );
      languagesCache = rows;
    }
    res.locals.languages = languagesCache;
    next();
  } catch (error) {
    // ВАЖЛИВО: логуємо помітно, щоб помилка не губилась (саме через це раніше було [])
    logging.error(error);
    res.locals.languages = [];
    next();
  }
}

loadLanguages.clearCache = () => {
  languagesCache = null;
};

module.exports = loadLanguages;
