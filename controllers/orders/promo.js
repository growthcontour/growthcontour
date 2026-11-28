"use strict";

/**
 * Промокоди системи: спільні для каналів продажу, що оформлюють замовлення в системі
 * (магазин у Telegram; надалі — інші канали й ручні замовлення).
 * Замовлення з сайтів приходять уже зі знижкою, порахованою сайтом (рядок підсумку coupon), — тут не перераховуються.
 *
 * Типи: відсоток (з обмеженням максимальної знижки), фіксована сума (у валюті промокоду — лише для замовлень у тій самій валюті),
 * безкоштовна доставка. Умови: період дії, мінімальна сума, загальний ліміт використань, ліміт на покупця,
 * лише перше замовлення, канали продажу, товари / категорії (з підкатегоріями), не діє на товари зі знижкою.
 *
 * Перевірка (check) — без змін у базі; використання (redeem) — у транзакції замовлення, ліміт — атомарно.
 * Таблиці створюються самі (ensureSchema) — окремий SQL запускати не треба.
 *
 * Персональні коди (issue): копія промокоду-шаблону з одним використанням — напр. для кожного адресата розсилки.
 * У списку видно лише шаблон; його статистика — разом з усіма персональними кодами (id_parent).
 */

const crypto = require("crypto");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const currencyLib = require("./currency");

const P = config.get("configDatabase").prefix;
const T = { codes: `${P}promo_codes`, uses: `${P}promo_code_uses` };
const TYPES = ["percent", "fixed", "free_shipping"];

const err = (status, key, vars, extra) => Object.assign(new Error(key), { status, i18nKey: key, vars: vars || {}, ...(extra || {}) });
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const num = (v) => {
	const n = Number(String(v ?? "").replace(",", "."));
	return Number.isFinite(n) ? n : null;
};
const normCode = (v) =>
	String(v || "")
		.trim()
		.toUpperCase()
		.replace(/\s+/g, "")
		.slice(0, 64);
const json = (v, d) => {
	if (v === null || v === undefined || v === "") return d;
	if (typeof v === "object") return v;
	try {
		return JSON.parse(v);
	} catch {
		return d;
	}
};
const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => parseInt(x, 10)).filter((x) => x > 0))].slice(0, 500);

let ready = null;
function ensureSchema() {
	if (!ready)
		ready = (async () => {
			await pool.query(`CREATE TABLE IF NOT EXISTS ${T.codes} (
			  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
			  code VARCHAR(64) NOT NULL COMMENT 'у верхньому регістрі',
			  name VARCHAR(255) NOT NULL DEFAULT '',
			  status TINYINT(1) NOT NULL DEFAULT 1,
			  type ENUM('percent','fixed','free_shipping') NOT NULL DEFAULT 'percent',
			  value DECIMAL(15,4) NOT NULL DEFAULT 0,
			  currency CHAR(3) NULL COMMENT 'для fixed і мінімальної суми',
			  max_discount DECIMAL(15,4) NULL,
			  min_order DECIMAL(15,4) NULL,
			  date_start DATETIME NULL,
			  date_end DATETIME NULL,
			  limit_total INT UNSIGNED NULL,
			  limit_per_customer INT UNSIGNED NULL,
			  first_order_only TINYINT(1) NOT NULL DEFAULT 0,
			  exclude_sale TINYINT(1) NOT NULL DEFAULT 0,
			  channels JSON NULL COMMENT 'id інтеграцій; порожньо — усі',
			  categories JSON NULL COMMENT 'id категорій (з підкатегоріями); порожньо — усі',
			  products JSON NULL COMMENT 'id товарів; порожньо — усі',
			  used_count INT UNSIGNED NOT NULL DEFAULT 0,
			  id_parent INT UNSIGNED NULL COMMENT 'шаблон для персональних кодів',
			  issued_for VARCHAR(100) NULL COMMENT 'кому видано персональний код',
			  issued_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'скільки персональних кодів видано (у шаблону)',
			  note VARCHAR(1000) NULL,
			  id_user INT UNSIGNED NULL,
			  date_add DATETIME NOT NULL,
			  date_edit DATETIME NULL,
			  deleted TINYINT(1) NOT NULL DEFAULT 0,
			  PRIMARY KEY (id),
			  KEY idx_code (code, deleted),
			  KEY idx_parent (id_parent)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
			// Таблиця з попередньої версії — додати колонки персональних кодів
			const [have] = await pool.query(`SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [T.codes]);
			const cols = new Set(have.map((x) => x.c));
			if (!cols.has("id_parent")) await pool.query(`ALTER TABLE ${T.codes} ADD COLUMN id_parent INT UNSIGNED NULL, ADD KEY idx_parent (id_parent)`);
			if (!cols.has("issued_for")) await pool.query(`ALTER TABLE ${T.codes} ADD COLUMN issued_for VARCHAR(100) NULL`);
			if (!cols.has("issued_count")) await pool.query(`ALTER TABLE ${T.codes} ADD COLUMN issued_count INT UNSIGNED NOT NULL DEFAULT 0`);
			await pool.query(`CREATE TABLE IF NOT EXISTS ${T.uses} (
			  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
			  id_code INT UNSIGNED NOT NULL,
			  id_order INT UNSIGNED NOT NULL,
			  id_client INT UNSIGNED NULL,
			  customer_key VARCHAR(100) NULL COMMENT 'ідентифікатор покупця в каналі (tg:<shop>:<user>, телефон…)',
			  amount DECIMAL(15,4) NOT NULL DEFAULT 0 COMMENT 'знижка у валюті замовлення',
			  currency CHAR(3) NOT NULL,
			  amount_base DECIMAL(15,4) NOT NULL DEFAULT 0,
			  date_add DATETIME NOT NULL,
			  PRIMARY KEY (id),
			  UNIQUE KEY uq_order (id_order),
			  KEY idx_code (id_code),
			  KEY idx_client (id_client),
			  KEY idx_key (customer_key)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
		})().catch((e) => {
			ready = null;
			throw e;
		});
	return ready;
}

// ── Довідник ──
function shape(r) {
	return {
		id: Number(r.id),
		code: r.code,
		name: r.name,
		status: !!Number(r.status),
		type: r.type,
		value: Number(r.value),
		currency: r.currency || null,
		max_discount: r.max_discount !== null ? Number(r.max_discount) : null,
		min_order: r.min_order !== null ? Number(r.min_order) : null,
		date_start: r.date_start,
		date_end: r.date_end,
		limit_total: r.limit_total !== null ? Number(r.limit_total) : null,
		limit_per_customer: r.limit_per_customer !== null ? Number(r.limit_per_customer) : null,
		first_order_only: !!Number(r.first_order_only),
		exclude_sale: !!Number(r.exclude_sale),
		channels: json(r.channels, []),
		categories: json(r.categories, []),
		products: json(r.products, []),
		used_count: Number(r.used_count),
		issued_count: Number(r.issued_count || 0),
		// Використання шаблону разом з персональними кодами
		used_all: r.used_all !== undefined ? Number(r.used_all || 0) : undefined,
		note: r.note || "",
		date_add: r.date_add,
		// Статистика (у list)
		discount_base: r.discount_base !== undefined ? Number(r.discount_base || 0) : undefined,
		orders_base: r.orders_base !== undefined ? Number(r.orders_base || 0) : undefined,
	};
}

async function list(q = {}) {
	await ensureSchema();
	const where = ["c.deleted = 0", "c.id_parent IS NULL"];
	const params = [];
	if (q.search) {
		where.push("(c.code LIKE ? OR c.name LIKE ?)");
		const s = `%${String(q.search).slice(0, 64).replace(/[\\%_]/g, (x) => "\\" + x)}%`;
		params.push(s, s);
	}
	if (q.state === "active") where.push("c.status = 1 AND (c.date_end IS NULL OR c.date_end >= NOW()) AND (c.limit_total IS NULL OR c.used_count < c.limit_total)");
	if (q.state === "inactive") where.push("NOT (c.status = 1 AND (c.date_end IS NULL OR c.date_end >= NOW()) AND (c.limit_total IS NULL OR c.used_count < c.limit_total))");
	const [rows] = await pool.query(
		`SELECT c.*,
		        (SELECT COUNT(*) FROM ${T.uses} u JOIN ${T.codes} x ON x.id = u.id_code WHERE x.id = c.id OR x.id_parent = c.id) AS used_all,
		        (SELECT SUM(u.amount_base) FROM ${T.uses} u JOIN ${T.codes} x ON x.id = u.id_code WHERE x.id = c.id OR x.id_parent = c.id) AS discount_base,
		        (SELECT SUM(o.total_base) FROM ${T.uses} u JOIN ${T.codes} x ON x.id = u.id_code JOIN ${P}orders o ON o.id = u.id_order AND o.deleted_at IS NULL AND o.is_canceled = 0 WHERE x.id = c.id OR x.id_parent = c.id) AS orders_base
		   FROM ${T.codes} c WHERE ${where.join(" AND ")} ORDER BY c.id DESC LIMIT 2000`,
		params
	);
	return { rows: rows.map(shape), base_currency: currencyLib.BASE_CURRENCY };
}

async function get(id) {
	await ensureSchema();
	const [[r]] = await pool.query(`SELECT * FROM ${T.codes} WHERE id = ? AND deleted = 0`, [id]);
	if (!r) throw err(404, "orders.promo.e.not_found");
	return shape(r);
}

function cleanDate(v, endOfDay) {
	if (!v) return null;
	const s = String(v).replace("T", " ").trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + (endOfDay ? " 23:59:59" : " 00:00:00");
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return s.slice(0, 16) + ":00";
	return null;
}

function clean(d) {
	const type = TYPES.includes(d.type) ? d.type : "percent";
	const value = type === "free_shipping" ? 0 : num(d.value);
	const errors = {};
	const code = normCode(d.code);
	if (!/^[A-Z0-9_-]{3,64}$/.test(code)) errors.code = "orders.promo.e.code";
	if (type === "percent" && !(value > 0 && value <= 100)) errors.value = "orders.promo.e.percent";
	if (type === "fixed" && !(value > 0)) errors.value = "orders.promo.e.value";
	const currency = String(d.currency || "")
		.toUpperCase()
		.slice(0, 3);
	if (type === "fixed" && !/^[A-Z]{3}$/.test(currency)) errors.currency = "orders.promo.e.currency";
	const date_start = cleanDate(d.date_start, false);
	const date_end = cleanDate(d.date_end, true);
	if (date_start && date_end && date_end < date_start) errors.date_end = "orders.promo.e.dates";
	const pos = (v) => {
		const n = parseInt(v, 10);
		return n > 0 ? n : null;
	};
	const money = (v) => {
		const n = num(v);
		return n !== null && n > 0 ? r2(n) : null;
	};
	return {
		errors,
		row: {
			code,
			name: String(d.name || "")
				.trim()
				.slice(0, 255),
			status: d.status === false || d.status === 0 || d.status === "0" ? 0 : 1,
			type,
			value: value || 0,
			currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
			max_discount: type === "percent" ? money(d.max_discount) : null,
			min_order: money(d.min_order),
			date_start,
			date_end,
			limit_total: pos(d.limit_total),
			limit_per_customer: pos(d.limit_per_customer),
			first_order_only: d.first_order_only ? 1 : 0,
			exclude_sale: d.exclude_sale ? 1 : 0,
			channels: JSON.stringify(ids(d.channels)),
			categories: JSON.stringify(ids(d.categories)),
			products: JSON.stringify(ids(d.products)),
			note: String(d.note || "").slice(0, 1000) || null,
		},
	};
}

async function save(id, d, idUser) {
	await ensureSchema();
	const { errors, row } = clean(d || {});
	if (Object.keys(errors).length) throw err(400, "orders.promo.e.form", {}, { errors });
	const [[dup]] = await pool.query(`SELECT id FROM ${T.codes} WHERE code = ? AND deleted = 0 AND id <> ?`, [row.code, id || 0]);
	if (dup) throw err(409, "orders.promo.e.duplicate", {}, { errors: { code: "orders.promo.e.duplicate" } });
	const cols = Object.keys(row);
	if (id) {
		await get(id);
		await pool.query(`UPDATE ${T.codes} SET ${cols.map((c) => `${c} = ?`).join(", ")}, date_edit = NOW() WHERE id = ?`, [...cols.map((c) => row[c]), id]);
		return get(id);
	}
	const [r] = await pool.query(`INSERT INTO ${T.codes} (${cols.join(", ")}, id_user, date_add) VALUES (${cols.map(() => "?").join(", ")}, ?, NOW())`, [...cols.map((c) => row[c]), idUser || null]);
	return get(r.insertId);
}

async function remove(id) {
	await get(id);
	await pool.query(`UPDATE ${T.codes} SET deleted = 1, status = 0, date_edit = NOW() WHERE id = ?`, [id]);
	return {};
}

/** Випадковий код (без схожих символів 0/O, 1/I) */
function generate(prefix, len) {
	const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const bytes = crypto.randomBytes(len || 8);
	let s = "";
	for (const b of bytes) s += abc[b % abc.length];
	return normCode((prefix ? normCode(prefix) + "-" : "") + s);
}

/** Використання промокоду: замовлення */
async function uses(id) {
	await get(id);
	const [rows] = await pool.query(
		`SELECT u.id_order, u.amount, u.currency, u.date_add, o.reference, o.total, o.currency_iso, o.is_canceled, o.id_client,
		        c.display_name AS client
		        , pc.code AS code
		   FROM ${T.uses} u JOIN ${T.codes} pc ON pc.id = u.id_code JOIN ${P}orders o ON o.id = u.id_order
		   LEFT JOIN ${P}clients c ON c.id = o.id_client
		  WHERE pc.id = ? OR pc.id_parent = ? ORDER BY u.id DESC LIMIT 500`,
		[id, id]
	);
	return rows;
}

// ── Застосування ──
/**
 * Перевірити промокод для кошика.
 * ctx: { id_integration, currency, items: [{ key, id_product, total, on_sale }], subtotal, shipping, customer_key, id_client, has_orders }
 * → { code: {id, code, type…}, discount, free_shipping, lines: { key: знижка } }
 */
async function check(codeRaw, ctx) {
	await ensureSchema();
	const code = normCode(codeRaw);
	if (!code) throw err(400, "orders.promo.e.not_found");
	const [[r]] = await pool.query(`SELECT * FROM ${T.codes} WHERE code = ? AND deleted = 0 LIMIT 1`, [code]);
	if (!r || !Number(r.status)) throw err(404, "orders.promo.e.not_found");
	const c = shape(r);
	const now = new Date();
	const asDate = (s) => new Date(String(s).replace(" ", "T"));
	if (c.date_start && asDate(c.date_start) > now) throw err(409, "orders.promo.e.not_started");
	if (c.date_end && asDate(c.date_end) < now) throw err(409, "orders.promo.e.expired");
	if (c.limit_total && c.used_count >= c.limit_total) throw err(409, "orders.promo.e.used_up");
	if (c.channels.length && !c.channels.includes(Number(ctx.id_integration))) throw err(409, "orders.promo.e.channel");
	const cur = String(ctx.currency || "").toUpperCase();
	if (c.currency && c.currency !== cur && (c.type === "fixed" || c.min_order)) throw err(409, "orders.promo.e.other_currency", { currency: c.currency });
	if (c.first_order_only && ctx.has_orders) throw err(409, "orders.promo.e.first_order");
	if (c.limit_per_customer && (ctx.customer_key || ctx.id_client)) {
		const [[u]] = await pool.query(
			`SELECT COUNT(*) AS n FROM ${T.uses} u JOIN ${P}orders o ON o.id = u.id_order AND o.is_canceled = 0
			  WHERE u.id_code = ? AND (${ctx.customer_key ? "u.customer_key = ?" : "0"} OR ${ctx.id_client ? "u.id_client = ?" : "0"})`,
			[c.id, ...(ctx.customer_key ? [ctx.customer_key] : []), ...(ctx.id_client ? [ctx.id_client] : [])]
		);
		if (Number(u.n) >= c.limit_per_customer) throw err(409, "orders.promo.e.per_customer");
	}
	const subtotal = r2(ctx.subtotal);
	if (c.min_order && subtotal < c.min_order) throw err(409, "orders.promo.e.min_order", { sum: c.min_order.toFixed(2) + " " + cur });

	// Позиції, на які діє промокод
	const items = Array.isArray(ctx.items) ? ctx.items : [];
	let eligible = items.filter((i) => !(c.exclude_sale && i.on_sale));
	if (c.products.length || c.categories.length) {
		const pids = [...new Set(eligible.map((i) => Number(i.id_product)).filter(Boolean))];
		let inCats = new Set();
		if (c.categories.length && pids.length) {
			const [rows] = await pool.query(
				`SELECT DISTINCT ptc.id_product FROM ${P}products_to_categories ptc JOIN ${P}products_categories_path cp ON cp.id_category = ptc.id_category
				  WHERE ptc.id_product IN (?) AND cp.id_ancestor IN (?)`,
				[pids, c.categories]
			);
			inCats = new Set(rows.map((x) => Number(x.id_product)));
		}
		eligible = eligible.filter((i) => c.products.includes(Number(i.id_product)) || inCats.has(Number(i.id_product)));
	}
	const base = r2(eligible.reduce((a, i) => a + Number(i.total || 0), 0));
	if (c.type !== "free_shipping" && !(base > 0)) throw err(409, "orders.promo.e.no_items");

	let discount = 0;
	if (c.type === "percent") {
		discount = r2((base * c.value) / 100);
		if (c.max_discount && (!c.currency || c.currency === cur)) discount = Math.min(discount, c.max_discount);
	}
	if (c.type === "fixed") discount = Math.min(r2(c.value), base);
	// Розподіл знижки по позиціях (пропорційно; остача — на найбільшу)
	const lines = {};
	if (discount > 0) {
		let left = discount;
		const sorted = [...eligible].sort((a, b) => b.total - a.total);
		sorted.forEach((i, k) => {
			const part = k === sorted.length - 1 ? left : r2((discount * Number(i.total)) / base);
			lines[i.key] = r2(Math.min(part, left));
			left = r2(left - lines[i.key]);
		});
	}
	return {
		code: { id: c.id, code: c.code, name: c.name, type: c.type, value: c.value },
		discount: r2(discount),
		free_shipping: c.type === "free_shipping",
		lines,
	};
}

/**
 * Зафіксувати використання в транзакції замовлення (conn). Ліміт — атомарно: якщо поки оформлювали, промокод вичерпали — помилка.
 */
async function redeem(conn, idCode, o) {
	await ensureSchema();
	const [u] = await conn.query(`UPDATE ${T.codes} SET used_count = used_count + 1 WHERE id = ? AND status = 1 AND deleted = 0 AND (limit_total IS NULL OR used_count < limit_total)`, [idCode]);
	if (!u.affectedRows) throw err(409, "orders.promo.e.used_up");
	const rate = Number(o.currency_rate) || 1;
	await conn.query(
		`INSERT INTO ${T.uses} (id_code, id_order, id_client, customer_key, amount, currency, amount_base, date_add) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
		 ON DUPLICATE KEY UPDATE id_code = VALUES(id_code), amount = VALUES(amount)`,
		[idCode, o.id_order, o.id_client || null, o.customer_key || null, r2(o.amount), String(o.currency || "").toUpperCase(), Math.round((Number(o.amount) / rate) * 10000) / 10000]
	);
}

/**
 * Видати персональний код за шаблоном: ті самі умови, одне використання, позначка кому видано.
 * Шаблон має бути увімкнений і не завершений.
 */
async function issue(idTemplate, forKey) {
	await ensureSchema();
	const [[t]] = await pool.query(`SELECT * FROM ${T.codes} WHERE id = ? AND deleted = 0 AND id_parent IS NULL`, [idTemplate]);
	if (!t || !Number(t.status)) throw err(409, "orders.promo.e.template");
	if (t.date_end && new Date(String(t.date_end).replace(" ", "T")) < new Date()) throw err(409, "orders.promo.e.expired");
	const prefix = String(t.code).slice(0, 12);
	for (let i = 0; i < 5; i++) {
		const code = generate(prefix, 6);
		const [[dup]] = await pool.query(`SELECT id FROM ${T.codes} WHERE code = ? AND deleted = 0`, [code]);
		if (dup) continue;
		await pool.query(
			`INSERT INTO ${T.codes} (code, name, status, type, value, currency, max_discount, min_order, date_start, date_end, limit_total, limit_per_customer, first_order_only, exclude_sale, channels, categories, products, id_parent, issued_for, date_add)
			 SELECT ?, name, 1, type, value, currency, max_discount, min_order, date_start, date_end, 1, 1, first_order_only, exclude_sale, channels, categories, products, id, ?, NOW() FROM ${T.codes} WHERE id = ?`,
			[code, forKey ? String(forKey).slice(0, 100) : null, t.id]
		);
		await pool.query(`UPDATE ${T.codes} SET issued_count = issued_count + 1 WHERE id = ?`, [t.id]);
		return code;
	}
	throw err(500, "orders.promo.e.server");
}

/** Шаблони для персональних кодів (для вибору в розсилці) */
async function templates() {
	await ensureSchema();
	const [rows] = await pool.query(
		`SELECT id, code, name, type, value, currency, date_end FROM ${T.codes}
		  WHERE deleted = 0 AND id_parent IS NULL AND status = 1 AND (date_end IS NULL OR date_end >= NOW()) ORDER BY id DESC LIMIT 200`
	);
	return rows;
}

module.exports = { TYPES, ensureSchema, list, get, save, remove, generate, uses, check, redeem, normCode, issue, templates };