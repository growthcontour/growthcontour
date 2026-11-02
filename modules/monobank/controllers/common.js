"use strict";

const pool = require("../../../config/database/connection_pool");
const P = require("../../../config/config").get("configDatabase").prefix;

/** Таблиці модуля: <prefix>modules_monobank_* */
const T = {
	accounts: `${P}modules_monobank_accounts`,
	invoices: `${P}modules_monobank_invoices`,
	events: `${P}modules_monobank_events`,
	refunds: `${P}modules_monobank_refunds`,
	statement: `${P}modules_monobank_statement`,
	sync: `${P}modules_monobank_sync`,
	qr: `${P}modules_monobank_qr`,
	cards: `${P}modules_monobank_cards`,
};

/** Помилка з HTTP-статусом. message — ключ перекладу (modules.monobank.e.*) */
function httpErr(status, message, vars) {
	const e = new Error(message);
	e.status = status;
	if (vars) e.vars = vars;
	return e;
}

const str = (v, n) => (v === null || v === undefined ? null : String(v).trim().slice(0, n) || null);
const json = (v, d) => {
	if (v && typeof v === "object" && !Buffer.isBuffer(v)) return v;
	try {
		return v ? JSON.parse(v) : d;
	} catch (e) {
		return d;
	}
};

/** Гривні → копійки (ціле), без похибки плаваючої коми */
const toMinor = (v) => Math.round((Number(v) || 0) * 100);
const fromMinor = (v) => Math.round(Number(v) || 0) / 100;

/** ISO 4217: код валюти → числовий код Monobank */
const CCY = { UAH: 980, USD: 840, EUR: 978 };
const CCY_ISO = Object.fromEntries(Object.entries(CCY).map(([k, v]) => [v, k]));

/** Стани рахунку Monobank */
const STATES = ["created", "processing", "hold", "success", "failure", "reversed", "expired", "removed"];
/** Стани, які ще можуть змінитися — їх звіряємо за розкладом */
const OPEN_STATES = ["created", "processing", "hold"];

/* ───────────────────────── Схема БД ───────────────────────── */

let ready = false;

/** Таблиці модуля створюються самі при увімкненні; SQL вручну не потрібен */
async function ensureSchema() {
	if (ready) return;
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.accounts} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  name VARCHAR(128) NOT NULL,
	  token_cipher VARBINARY(512) NULL,
	  token_iv VARBINARY(16) NULL,
	  token_tag VARBINARY(16) NULL,
	  token_last4 CHAR(4) NULL,
	  merchant_id VARCHAR(64) NULL,
	  merchant_name VARCHAR(255) NULL,
	  status TINYINT(1) NOT NULL DEFAULT 1,
	  is_default TINYINT(1) NOT NULL DEFAULT 0,
	  settings JSON NULL COMMENT 'тип оплати, термін дії, статуси замовлення, призначення платежу',
	  integrations JSON NULL COMMENT 'id інтеграцій (магазинів), для яких акаунт за замовчуванням',
	  date_add DATETIME NOT NULL,
	  date_edit DATETIME NOT NULL,
	  PRIMARY KEY (id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.invoices} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  id_order INT UNSIGNED NOT NULL,
	  id_account INT UNSIGNED NOT NULL,
	  invoice_id VARCHAR(64) NOT NULL,
	  page_url VARCHAR(512) NOT NULL,
	  amount INT UNSIGNED NOT NULL COMMENT 'копійки',
	  final_amount INT UNSIGNED NULL COMMENT 'копійки, фактично списано',
	  ccy SMALLINT UNSIGNED NOT NULL DEFAULT 980,
	  payment_type ENUM('debit','hold') NOT NULL DEFAULT 'debit',
	  status VARCHAR(16) NOT NULL DEFAULT 'created',
	  failure_reason VARCHAR(512) NULL,
	  modified_at DATETIME(3) NULL COMMENT 'modifiedDate від Monobank — захист від старих вебхуків',
	  expires_at DATETIME NULL,
	  paid_at DATETIME NULL,
	  id_user INT UNSIGNED NULL,
	  date_add DATETIME NOT NULL,
	  date_edit DATETIME NOT NULL,
	  PRIMARY KEY (id),
	  UNIQUE KEY uq_invoice (invoice_id),
	  KEY idx_order (id_order),
	  KEY idx_open (status, date_add)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.events} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  id_invoice INT UNSIGNED NULL,
	  id_order INT UNSIGNED NULL,
	  type VARCHAR(32) NOT NULL COMMENT 'created, copied, webhook, reconcile, finalized, removed, error',
	  status VARCHAR(16) NULL,
	  payload JSON NULL,
	  id_user INT UNSIGNED NULL,
	  date_add DATETIME NOT NULL,
	  PRIMARY KEY (id),
	  KEY idx_invoice (id_invoice, id),
	  KEY idx_order (id_order, id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.refunds} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  id_invoice INT UNSIGNED NOT NULL,
	  id_order INT UNSIGNED NOT NULL,
	  id_refund INT UNSIGNED NULL COMMENT 'orders_refunds.id; NULL — скасування холду',
	  ext_ref VARCHAR(64) NOT NULL,
	  amount INT UNSIGNED NOT NULL COMMENT 'копійки',
	  status VARCHAR(16) NOT NULL DEFAULT 'processing' COMMENT 'processing, success, failure',
	  items JSON NULL COMMENT 'позиції для фіскального чека повернення',
	  id_user INT UNSIGNED NULL,
	  date_add DATETIME NOT NULL,
	  date_edit DATETIME NOT NULL,
	  PRIMARY KEY (id),
	  UNIQUE KEY uq_ext (id_invoice, ext_ref),
	  KEY idx_order (id_order),
	  KEY idx_status (status)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	// Колонки, додані після першої версії модуля
	await addColumn(T.invoices, "payment_info", "JSON NULL COMMENT 'картка, спосіб оплати, банк, RRN, код авторизації' AFTER failure_reason");
	await addColumn(T.invoices, "fee", "INT UNSIGNED NULL COMMENT 'комісія еквайрингу, копійки' AFTER payment_info");
	await addColumn(T.invoices, "basket", "JSON NULL COMMENT 'склад чека, як передано в Monobank' AFTER fee");
	await addColumn(T.invoices, "hold_until", "DATETIME NULL COMMENT 'кінець холду (9 днів), далі банк сам знімає блокування' AFTER expires_at");
	await addColumn(T.invoices, "source", "ENUM('link','statement') NOT NULL DEFAULT 'link' COMMENT 'link — посилання із системи; statement — платіж із виписки, прив’язаний до замовлення' AFTER id_account");
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.statement} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  id_account INT UNSIGNED NOT NULL,
	  invoice_id VARCHAR(64) NOT NULL,
	  status VARCHAR(16) NOT NULL,
	  date DATETIME NOT NULL COMMENT 'дата фінансової операції',
	  amount INT UNSIGNED NOT NULL COMMENT 'копійки',
	  refunded INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'сума повернень із cancelList, копійки',
	  profit_amount INT UNSIGNED NULL COMMENT 'до зарахування після розрахунку банку, копійки',
	  ccy SMALLINT UNSIGNED NOT NULL DEFAULT 980,
	  masked_pan VARCHAR(32) NULL,
	  reference VARCHAR(255) NULL,
	  destination VARCHAR(512) NULL,
	  approval_code VARCHAR(32) NULL,
	  rrn VARCHAR(64) NULL,
	  payment_scheme VARCHAR(32) NULL COMMENT 'full, bnpl_parts_4, bnpl_later_30',
	  short_qr_id VARCHAR(32) NULL,
	  cancel_list JSON NULL,
	  id_order INT UNSIGNED NULL,
	  id_invoice INT UNSIGNED NULL,
	  match_type VARCHAR(16) NULL COMMENT 'invoice — посилання системи; auto — за номером і сумою; manual — вручну; none — відв’язано вручну',
	  id_user INT UNSIGNED NULL COMMENT 'хто прив’язав / відв’язав',
	  date_add DATETIME NOT NULL,
	  date_edit DATETIME NOT NULL,
	  PRIMARY KEY (id),
	  UNIQUE KEY uq_invoice (id_account, invoice_id),
	  KEY idx_date (date),
	  KEY idx_order (id_order),
	  KEY idx_unmatched (match_type, status, date)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.sync} (
	  id_account INT UNSIGNED NOT NULL,
	  synced_from DATETIME NULL COMMENT 'з якої дати виписка завантажена',
	  synced_to DATETIME NULL COMMENT 'до якої дати виписка завантажена',
	  started_at DATETIME NULL,
	  finished_at DATETIME NULL,
	  total INT UNSIGNED NOT NULL DEFAULT 0,
	  message VARCHAR(1000) NULL,
	  PRIMARY KEY (id_account)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	// Етап C: QR-каси, збережені картки, нові джерела й типи рахунків
	await enumHas(T.invoices, "source", ["link", "statement", "qr", "wallet"], "NOT NULL DEFAULT 'link'");
	await enumHas(T.invoices, "payment_type", ["debit", "hold", "verification"], "NOT NULL DEFAULT 'debit'");
	await addColumn(T.invoices, "qr_id", "VARCHAR(32) NULL COMMENT 'QR-каса, на яку виставлено суму' AFTER source");
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.qr} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  id_account INT UNSIGNED NOT NULL,
	  qr_id VARCHAR(32) NOT NULL,
	  short_qr_id VARCHAR(32) NULL,
	  amount_type VARCHAR(16) NULL COMMENT 'merchant — суму ставить магазин; client — вводить клієнт; fix — фіксована',
	  page_url VARCHAR(512) NULL,
	  name VARCHAR(128) NULL COMMENT 'назва каси в системі (наприклад, «Офіс»)',
	  active TINYINT(1) NOT NULL DEFAULT 1 COMMENT '0 — каси вже немає в банку',
	  date_add DATETIME NOT NULL,
	  date_edit DATETIME NOT NULL,
	  PRIMARY KEY (id),
	  UNIQUE KEY uq_qr (id_account, qr_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.cards} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  id_account INT UNSIGNED NOT NULL,
	  id_client INT UNSIGNED NULL,
	  wallet_id VARCHAR(64) NOT NULL,
	  token_cipher VARBINARY(512) NOT NULL,
	  token_iv VARBINARY(16) NOT NULL,
	  token_tag VARBINARY(16) NOT NULL,
	  token_hash CHAR(64) NOT NULL COMMENT 'SHA-256 токена — унікальність без розшифрування',
	  masked_pan VARCHAR(32) NULL,
	  country VARCHAR(8) NULL,
	  status VARCHAR(16) NOT NULL DEFAULT 'created' COMMENT 'new, created, failed, deleted',
	  id_invoice INT UNSIGNED NULL COMMENT 'рахунок, під час оплати якого збережено',
	  date_add DATETIME NOT NULL,
	  date_edit DATETIME NOT NULL,
	  PRIMARY KEY (id),
	  UNIQUE KEY uq_token (id_account, token_hash),
	  KEY idx_wallet (id_account, wallet_id),
	  KEY idx_client (id_client)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	ready = true;
}

/** ENUM-колонка має містити всі значення; інакше розширюємо (наявні значення зберігаються) */
async function enumHas(table, column, values, tail) {
	const [[c]] = await pool.query(`SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column]);
	if (!c) return;
	const have = (String(c.t).match(/'([^']*)'/g) || []).map((v) => v.slice(1, -1));
	if (values.every((v) => have.includes(v))) return;
	const all = [...new Set([...have, ...values])];
	await pool.query(`ALTER TABLE ${table} MODIFY ${column} ENUM(${all.map((v) => pool.escape(v)).join(", ")}) ${tail}`);
}

async function addColumn(table, column, definition) {
	const [[c]] = await pool.query(`SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column]);
	if (!c) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

module.exports = { pool, P, T, httpErr, str, json, toMinor, fromMinor, CCY, CCY_ISO, STATES, OPEN_STATES, ensureSchema };