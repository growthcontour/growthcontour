"use strict";

const { pool, P } = require("./common");

let ready = false;

/** Таблиці модуля створюються самі (увімкнення модуля); SQL вручну не потрібен */
async function ensureSchema() {
	if (ready) return;
	const q = (sql) => pool.query(sql);
	await q(`CREATE TABLE IF NOT EXISTS ${P}np_accounts (
	  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
	  name VARCHAR(128) NOT NULL,
	  api_key VARCHAR(64) NOT NULL,
	  status TINYINT(1) NOT NULL DEFAULT 1,
	  is_default TINYINT(1) NOT NULL DEFAULT 0,
	  settings JSON NULL COMMENT 'відправник, платник, тип вантажу, опис, вага за замовчуванням, наложений платіж',
	  integrations JSON NULL COMMENT 'id інтеграцій (магазинів), для яких акаунт за замовчуванням',
	  date_add DATETIME NOT NULL,
	  date_edit DATETIME NOT NULL,
	  PRIMARY KEY (id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await q(`CREATE TABLE IF NOT EXISTS ${P}np_areas (
	  ref CHAR(36) NOT NULL,
	  name VARCHAR(100) NOT NULL,
	  name_ru VARCHAR(100) NULL,
	  seen DATETIME NOT NULL,
	  PRIMARY KEY (ref)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await q(`CREATE TABLE IF NOT EXISTS ${P}np_cities (
	  ref CHAR(36) NOT NULL,
	  name VARCHAR(200) NOT NULL,
	  name_ru VARCHAR(200) NULL,
	  area_ref CHAR(36) NULL,
	  area VARCHAR(100) NULL,
	  type VARCHAR(50) NULL,
	  seen DATETIME NOT NULL,
	  PRIMARY KEY (ref),
	  KEY idx_name (name(30)),
	  KEY idx_name_ru (name_ru(30))
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await q(`CREATE TABLE IF NOT EXISTS ${P}np_warehouses (
	  ref CHAR(36) NOT NULL,
	  city_ref CHAR(36) NOT NULL,
	  number INT UNSIGNED NOT NULL DEFAULT 0,
	  type ENUM('warehouse','postomat','cargo') NOT NULL DEFAULT 'warehouse',
	  name VARCHAR(512) NOT NULL,
	  name_ru VARCHAR(512) NULL,
	  short_address VARCHAR(512) NULL,
	  max_weight INT UNSIGNED NOT NULL DEFAULT 0,
	  status VARCHAR(32) NULL,
	  seen DATETIME NOT NULL,
	  PRIMARY KEY (ref),
	  KEY idx_city (city_ref, number),
	  KEY idx_number (number)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	await q(`CREATE TABLE IF NOT EXISTS ${P}np_sync (
	  k VARCHAR(32) NOT NULL,
	  started_at DATETIME NULL,
	  finished_at DATETIME NULL,
	  total INT UNSIGNED NOT NULL DEFAULT 0,
	  message VARCHAR(1000) NULL,
	  PRIMARY KEY (k)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
	ready = true;
}

module.exports = { ensureSchema };
