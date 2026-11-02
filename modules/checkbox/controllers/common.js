"use strict";

const pool = require("../../../config/database/connection_pool");
const P = require("../../../config/config").get("configDatabase").prefix;

/** Таблиці модуля: <prefix>modules_checkbox_* */
const T = {
	registers: `${P}modules_checkbox_registers`,
	receipts: `${P}modules_checkbox_receipts`,
	ettn: `${P}modules_checkbox_ettn`,
	events: `${P}modules_checkbox_events`,
	chains: `${P}modules_checkbox_chains`,
};

/** Помилка з HTTP-статусом. message — ключ перекладу (modules.checkbox.e.*) */
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
/** Гривні → копійки (ціле) */
const toMinor = (v) => Math.round((Number(v) || 0) * 100);
const fromMinor = (v) => Math.round(Number(v) || 0) / 100;
/** Телефон у форматі Checkbox: 380XXXXXXXXX */
function phone380(v) {
	let d = String(v || "").replace(/\D/g, "");
	if (d.length === 10 && d[0] === "0") d = "38" + d;
	if (d.length === 9) d = "380" + d;
	return /^380\d{9}$/.test(d) ? d : null;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Стани чека Checkbox: CREATED — у черзі на фіскалізацію; DONE — фіскалізовано; ERROR — помилка.
 * Локальний QUEUED — Checkbox був недоступний (мережа / збій сервера): чек відправиться повторно автоматично.
 */
const RECEIPT_ALIVE = ["QUEUED", "CREATED", "DONE"];
const RECEIPT_OPEN = ["CREATED", "CANCELLATION"];
/** Стани ЕТТН: CREATED — очікує отримання посилки; DONE / DONE_WITHOUT_SMS — чек видано; CANCELLED / RETURNED; RECEIPT_ERROR */
const ETTN_OPEN = ["CREATED"];

/* ───────────────────────── Схема БД ───────────────────────── */

let ready = false;

/** Таблиці модуля створюються самі при увімкненні; SQL вручну не потрібен */
async function ensureSchema() {
	if (ready) return;
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.registers} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  name VARCHAR(128) NOT NULL,
	  test TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 — тестовий сервер dev-api.checkbox.in.ua',
	  license_cipher VARBINARY(512) NULL,
	  license_iv VARBINARY(16) NULL,
	  license_tag VARBINARY(16) NULL,
	  license_last4 CHAR(4) NULL,
	  pin_cipher VARBINARY(128) NULL,
	  pin_iv VARBINARY(16) NULL,
	  pin_tag VARBINARY(16) NULL,
	  token_cipher VARBINARY(4096) NULL COMMENT 'JWT касира, оновлюється при 401',
	  token_iv VARBINARY(16) NULL,
	  token_tag VARBINARY(16) NULL,
	  token_at DATETIME NULL,
	  cash_register_id VARCHAR(64) NULL,
	  fiscal_number VARCHAR(64) NULL,
	  cashier_name VARCHAR(255) NULL,
	  status TINYINT(1) NOT NULL DEFAULT 1,
	  is_default TINYINT(1) NOT NULL DEFAULT 0,
	  settings JSON NULL COMMENT 'податки, доставка чека, зміни, ЕТТН, тексти',
	  integrations JSON NULL COMMENT 'id інтеграцій (магазинів), для яких каса за замовчуванням',
	  date_add DATETIME NOT NULL,
	  date_edit DATETIME NOT NULL,
	  PRIMARY KEY (id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.receipts} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  id_order INT UNSIGNED NULL,
	  id_register INT UNSIGNED NOT NULL,
	  receipt_id CHAR(36) NOT NULL COMMENT 'UUID чека (задаємо самі — повтор запиту не створить другий чек)',
	  type VARCHAR(16) NOT NULL COMMENT 'SELL, RETURN, SERVICE_IN, SERVICE_OUT',
	  status VARCHAR(16) NOT NULL DEFAULT 'CREATED',
	  total INT NOT NULL DEFAULT 0 COMMENT 'копійки',
	  payment_type VARCHAR(16) NULL COMMENT 'CASH, CASHLESS',
	  serial INT UNSIGNED NULL,
	  fiscal_code VARCHAR(64) NULL,
	  fiscal_date DATETIME NULL,
	  tax_url VARCHAR(512) NULL,
	  related_id INT UNSIGNED NULL COMMENT 'чек продажу, до якого повернення',
	  id_refund INT UNSIGNED NULL COMMENT 'orders_refunds.id',
	  source VARCHAR(16) NOT NULL DEFAULT 'manual' COMMENT 'manual, auto, ettn, service',
	  error VARCHAR(1000) NULL,
	  payload JSON NULL COMMENT 'що відправлено в Checkbox',
	  id_user INT UNSIGNED NULL,
	  date_add DATETIME NOT NULL,
	  date_edit DATETIME NOT NULL,
	  PRIMARY KEY (id),
	  UNIQUE KEY uq_receipt (receipt_id),
	  KEY idx_order (id_order),
	  KEY idx_open (status, date_add)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.ettn} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  id_order INT UNSIGNED NOT NULL,
	  id_register INT UNSIGNED NOT NULL,
	  id_shipment INT UNSIGNED NULL,
	  ttn VARCHAR(32) NOT NULL,
	  ettn_id VARCHAR(64) NULL COMMENT 'id замовлення ЕТТН у Checkbox',
	  status VARCHAR(24) NOT NULL DEFAULT 'CREATED',
	  total INT NOT NULL DEFAULT 0 COMMENT 'копійки — має дорівнювати сумі контролю оплати в ТТН',
	  receipt_id VARCHAR(64) NULL COMMENT 'чек, виданий Checkbox при отриманні',
	  return_receipt_id VARCHAR(64) NULL,
	  error VARCHAR(1000) NULL,
	  raw JSON NULL,
	  last_check DATETIME NULL,
	  id_user INT UNSIGNED NULL,
	  date_add DATETIME NOT NULL,
	  date_edit DATETIME NOT NULL,
	  PRIMARY KEY (id),
	  UNIQUE KEY uq_ttn (ttn),
	  KEY idx_order (id_order),
	  KEY idx_open (status)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.events} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  id_register INT UNSIGNED NULL,
	  id_order INT UNSIGNED NULL,
	  type VARCHAR(32) NOT NULL COMMENT 'shift_open, shift_close, receipt, return, ettn, x_report, error …',
	  payload JSON NULL,
	  id_user INT UNSIGNED NULL,
	  date_add DATETIME NOT NULL,
	  PRIMARY KEY (id),
	  KEY idx_register (id_register, id),
	  KEY idx_order (id_order, id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	// Етап 2: ланцюжки передплати / післяплати
	await pool.query(`CREATE TABLE IF NOT EXISTS ${T.chains} (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  id_order INT UNSIGNED NOT NULL,
	  id_register INT UNSIGNED NOT NULL,
	  relation_id VARCHAR(64) NOT NULL COMMENT 'номер ланцюжка в Checkbox (наш custom_relation_id)',
	  status VARCHAR(24) NOT NULL DEFAULT 'PARTIAL_PAID' COMMENT 'PARTIAL_PAID, FULL_PAID, CANCELLED, PARTIAL_CANCELLED',
	  total INT NOT NULL DEFAULT 0 COMMENT 'копійки — сума товарів ланцюжка',
	  paid INT NOT NULL DEFAULT 0,
	  left_to_pay INT NOT NULL DEFAULT 0,
	  raw JSON NULL,
	  id_user INT UNSIGNED NULL,
	  date_add DATETIME NOT NULL,
	  date_edit DATETIME NOT NULL,
	  PRIMARY KEY (id),
	  UNIQUE KEY uq_relation (relation_id),
	  KEY idx_order (id_order)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await addColumn(T.receipts, "chain", "VARCHAR(8) NULL COMMENT 'pre — чек передплати; after — чек післяплати; NULL — звичайний' AFTER type");
	await addColumn(T.receipts, "id_chain", "INT UNSIGNED NULL AFTER chain");
	// Етап 4: вебхук Checkbox — секретний ключ каси для перевірки підпису
	await addColumn(T.registers, "webhook_cipher", "VARBINARY(256) NULL AFTER token_at");
	await addColumn(T.registers, "webhook_iv", "VARBINARY(16) NULL AFTER webhook_cipher");
	await addColumn(T.registers, "webhook_tag", "VARBINARY(16) NULL AFTER webhook_iv");
	await addColumn(T.registers, "webhook_at", "DATETIME NULL COMMENT 'коли підключено вебхук' AFTER webhook_tag");
	// Етап 5: повернення каси в онлайн — Checkbox приймає go-online не частіше раз на 2 хв, повторюємо до успіху
	await addColumn(T.registers, "online_pending", "DATETIME NULL COMMENT 'з якого часу повертаємо касу в онлайн' AFTER webhook_at");
	await addColumn(T.registers, "online_try", "DATETIME NULL COMMENT 'останній запит go-online' AFTER online_pending");
	ready = true;
}

async function addColumn(table, column, definition) {
	const [[c]] = await pool.query(`SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column]);
	if (!c) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

module.exports = { pool, P, T, httpErr, str, json, toMinor, fromMinor, phone380, EMAIL_RE, RECEIPT_OPEN, RECEIPT_ALIVE, ETTN_OPEN, ensureSchema };