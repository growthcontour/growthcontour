"use strict";

/**
 * Модуль «Магазин у Telegram»: спільне — таблиці, схема БД, дрібні помічники.
 * Таблиці: <prefix>modules_telegram_shop_* (правило назв модулів).
 */

const pool = require("../../../config/database/connection_pool");
const P = require("../../../config/config").get("configDatabase").prefix;
const APP_URL = String(require("../../../config/config").get("configServer").url || "").replace(/\/+$/, "");

const T = {
	shops: `${P}modules_telegram_shop_shops`,
	customers: `${P}modules_telegram_shop_customers`,
	orders: `${P}modules_telegram_shop_orders`,
	watch: `${P}modules_telegram_shop_watch`,
	broadcasts: `${P}modules_telegram_shop_broadcasts`,
	bmessages: `${P}modules_telegram_shop_broadcast_messages`,
};

/** Помилка з HTTP-статусом; message — ключ перекладу (modules.telegramshop.e.*) */
function httpErr(status, message, vars) {
	return Object.assign(new Error(message), { status, vars });
}

const str = (v, n) => (v === null || v === undefined ? "" : String(v).trim().slice(0, n));
const json = (v, d) => {
	if (v && typeof v === "object" && !Buffer.isBuffer(v)) return v;
	try {
		return v ? JSON.parse(v) : d;
	} catch {
		return d;
	}
};

let ready = false;
/** Таблиці модуля створюються самі при увімкненні модуля */
async function ensureSchema() {
	if (ready) return;
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.shops} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  name VARCHAR(128) NOT NULL,
	  slug VARCHAR(32) NOT NULL COMMENT 'публічний ідентифікатор у посиланнях вітрини й вебхука',
	  id_integration INT NULL COMMENT 'канал продажу: асортимент, ціни, залишки, джерело замовлень',
	  status ENUM('draft','active','disabled') NOT NULL DEFAULT 'draft',
	  bot_id BIGINT UNSIGNED NULL,
	  bot_username VARCHAR(64) NULL,
	  token_cipher VARBINARY(512) NULL,
	  token_iv VARBINARY(16) NULL,
	  token_tag VARBINARY(16) NULL,
	  token_last4 VARCHAR(4) NULL,
	  webhook_secret VARCHAR(64) NULL,
	  webhook_ok TINYINT(1) NOT NULL DEFAULT 0,
	  webhook_error VARCHAR(500) NULL,
	  settings JSON NULL,
	  date_add DATETIME NOT NULL,
	  date_edit DATETIME NOT NULL,
	  PRIMARY KEY (id),
	  UNIQUE KEY uq_slug (slug),
	  KEY idx_integration (id_integration)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.customers} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  id_shop INT UNSIGNED NOT NULL,
	  tg_user_id BIGINT UNSIGNED NOT NULL,
	  username VARCHAR(64) NULL,
	  first_name VARCHAR(128) NULL,
	  last_name VARCHAR(128) NULL,
	  language_code VARCHAR(16) NULL,
	  phone VARCHAR(32) NULL,
	  id_client INT UNSIGNED NULL,
	  is_blocked TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'клієнт зупинив бота — повідомлення не надсилаються',
	  started_at DATETIME NULL,
	  last_seen_at DATETIME NULL,
	  date_add DATETIME NOT NULL,
	  PRIMARY KEY (id),
	  UNIQUE KEY uq_shop_user (id_shop, tg_user_id),
	  KEY idx_client (id_client)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.orders} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  id_shop INT UNSIGNED NOT NULL,
	  id_customer INT UNSIGNED NOT NULL,
	  id_order INT UNSIGNED NOT NULL,
	  payment VARCHAR(32) NULL,
	  delivery VARCHAR(64) NULL,
	  last_status INT NULL COMMENT 'останній статус, про який повідомили клієнта',
	  date_add DATETIME NOT NULL,
	  PRIMARY KEY (id),
	  UNIQUE KEY uq_order (id_order),
	  KEY idx_customer (id_customer, id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	// Підписки «повідомити, коли з'явиться»: покупець — товар (варіант); після повідомлення рядок видаляється
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.watch} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  id_shop INT UNSIGNED NOT NULL,
	  id_customer INT UNSIGNED NOT NULL,
	  id_product INT UNSIGNED NOT NULL,
	  id_variant INT UNSIGNED NOT NULL DEFAULT 0,
	  date_add DATETIME NOT NULL,
	  PRIMARY KEY (id),
	  UNIQUE KEY uq_watch (id_customer, id_product, id_variant),
	  KEY idx_shop (id_shop, id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	// Розсилки покупцям ботів (розділ «Розсилки → Telegram»)
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.broadcasts} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  name VARCHAR(255) NOT NULL,
	  status ENUM('draft','scheduled','preparing','sending','paused','sent','cancelled','failed') NOT NULL DEFAULT 'draft',
	  audience JSON NULL COMMENT '{shops:[], segment, days, langs:[]}',
	  message JSON NULL COMMENT '{text, photo, button:{text, target, product, url}}',
	  date_scheduled DATETIME NULL COMMENT 'UTC',
	  cnt_total INT UNSIGNED NOT NULL DEFAULT 0,
	  cnt_sent INT UNSIGNED NOT NULL DEFAULT 0,
	  cnt_failed INT UNSIGNED NOT NULL DEFAULT 0,
	  cnt_blocked INT UNSIGNED NOT NULL DEFAULT 0,
	  cnt_clicked INT UNSIGNED NOT NULL DEFAULT 0,
	  cnt_orders INT UNSIGNED NOT NULL DEFAULT 0,
	  sum_orders DECIMAL(15,4) NOT NULL DEFAULT 0,
	  last_error VARCHAR(1024) NULL,
	  id_user INT UNSIGNED NULL,
	  id_user_launched INT UNSIGNED NULL,
	  date_launched DATETIME NULL,
	  date_finished DATETIME NULL,
	  date_add DATETIME NOT NULL,
	  date_edit DATETIME NULL,
	  deleted TINYINT(1) NOT NULL DEFAULT 0,
	  PRIMARY KEY (id),
	  KEY idx_status (status, date_scheduled)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.bmessages} (
	  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	  id_broadcast INT UNSIGNED NOT NULL,
	  id_shop INT UNSIGNED NOT NULL,
	  id_customer INT UNSIGNED NOT NULL,
	  tg_user_id BIGINT NOT NULL,
	  status ENUM('queued','sent','failed','blocked','cancelled') NOT NULL DEFAULT 'queued',
	  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
	  date_next_attempt DATETIME NOT NULL,
	  error VARCHAR(255) NULL,
	  date_sent DATETIME NULL,
	  date_clicked DATETIME NULL,
	  PRIMARY KEY (id),
	  UNIQUE KEY uq_bc (id_broadcast, id_customer),
	  KEY idx_queue (status, date_next_attempt),
	  KEY idx_customer (id_customer, date_sent)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	// Персональний промокод адресата розсилки ({promo} у тексті)
	await addColumns(T.bmessages, { promo_code: "VARCHAR(64) NULL COMMENT 'персональний промокод адресата'" });
	// Кошик покупця на сервері: між пристроями і для нагадування про незавершене замовлення
	await addColumns(T.customers, {
		cart: "JSON NULL COMMENT 'кошик вітрини: [{id, variant, qty}]'",
		cart_at: "DATETIME NULL COMMENT 'коли кошик востаннє змінювався'",
		cart_reminded_at: "DATETIME NULL COMMENT 'коли нагадали про цей кошик'",
	});
	ready = true;
}

/** Додати колонки, яких ще немає (таблиці модуля з попередніх версій) */
async function addColumns(table, cols) {
	const [have] = await pool.query(`SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
	const set = new Set(have.map((r) => r.c));
	for (const [name, def] of Object.entries(cols)) if (!set.has(name)) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}

/** Посилання вітрини (Mini App) і вебхука бота магазину */
const appUrl = (slug) => `${APP_URL}/modules/telegramshop/app/${slug}/`;
const webhookUrl = (slug) => `${APP_URL}/api/module/telegramshop/webhook/${slug}/`;

/**
 * Назва статусу замовлення мовою покупця (мова Telegram), інакше — мовою системи за замовчуванням, інакше — будь-якою.
 * Один параметр — код мови покупця (uk, en, pl…; null — мова за замовчуванням).
 */
const statusNameSql = (statusCol) =>
	`COALESCE((SELECT sl.text FROM ${P}orders_status_lang sl JOIN ${P}languages lg ON lg.id = sl.id_lang
	            WHERE sl.id_status = ${statusCol} AND sl.text <> ''
	            ORDER BY (lg.iso = ?) DESC, (lg.is_default = 1) DESC, lg.sort, lg.id LIMIT 1), '')`;
const langCode = (v) => (String(v || "").toLowerCase().split("-")[0] || null);

/** Валюти Telegram Payments (core.telegram.org/bots/payments#supported-currencies); exp 0 — сума в цілих одиницях */
const TG_CURRENCIES = new Set(
	"AED AFN ALL AMD ARS AUD AZN BAM BDT BGN BND BOB BRL BYN CAD CHF CLP CNY COP CRC CZK DKK DOP DZD EGP ETB EUR GBP GEL GTQ HKD HNL HRK HUF IDR ILS INR ISK JMD JPY KES KGS KRW KZT LBP LKR MAD MDL MNT MUR MVR MXN MYR MZN NGN NIO NOK NPR NZD PAB PEN PHP PKR PLN PYG QAR RON RSD RUB SAR SEK SGD THB TJS TRY TTD TWD TZS UAH UGX USD UYU UZS VND YER ZAR".split(" ")
);
const TG_ZERO_EXP = new Set(["CLP", "ISK", "JPY", "KRW", "PYG", "UGX", "VND"]);

module.exports = { pool, P, T, APP_URL, httpErr, str, json, ensureSchema, appUrl, webhookUrl, statusNameSql, langCode, TG_CURRENCIES, TG_ZERO_EXP };