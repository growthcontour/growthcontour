"use strict";

/**
 * Системні сповіщення каталогу (вкладка «Система»).
 * Сканери порівнюють поточний стан із products_alerts_state: сповіщення надходить лише
 * при переході в проблемний стан, а після відновлення стан очищається — повторний перехід сповістить знову.
 * Одне сповіщення на тип за прогін (дайджест), щоб не засипати користувачів.
 */
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const i18n = require("../../../config/i18n/i18n");
const notifications = require("../../notifications/index");
const settings = require("./settings");

const P = config.get("configDatabase").prefix;
const SCOPE = "catalog.alerts";
const SCOPE_REF = "0";
const EVENTS = ["low_stock", "out_of_stock", "price_schedule", "order_stock", "reviews", "sync"];
const LOCALE = process.env.APP_LOCALE || "uk";
const MAX_LIST = 5;

const t = (phrase, vars) => i18n.__({ phrase, locale: LOCALE }, vars || {});

/* ═══ ОТРИМУВАЧІ ═══ */

/**
 * Отримувачі зберігаються в наявній notif_recipients (scope catalog.alerts).
 * Які події отримує кожен — прапорці в options отримувача, як у контакт-центрі.
 */
async function getRecipients(idLang) {
	const rows = await notifications.recipients.list(SCOPE, SCOPE_REF, idLang);
	return rows.map((r) => {
		const events = {};
		EVENTS.forEach((e) => (events[e] = !!(r.options && r.options[e])));
		return { kind: r.kind, ref: r.ref, name: r.name, events };
	});
}

async function saveRecipients(body) {
	const list = (Array.isArray(body && body.recipients) ? body.recipients : [])
		.filter((r) => r && ["user", "group"].includes(r.kind) && /^\d{1,10}$/.test(String(r.ref)))
		.slice(0, 100)
		.map((r) => {
			const item = { kind: r.kind, ref: String(r.ref) };
			EVENTS.forEach((e) => (item[e] = !!(r.events && r.events[e])));
			return item;
		});
	await notifications.recipients.save(null, SCOPE, SCOPE_REF, list);
	return { ok: true };
}

/**
 * Надіслати тим отримувачам каталогу, у яких увімкнена подія.
 * Без явного key: notify() рахує ключ з типу + аудиторії + payload, тож кожен отримувач
 * отримує власну подію; мітка часу в payload не дає дедуплікувати однаковий текст наступних прогонів.
 */
async function send(event, payload) {
	return notifications.recipients.notifyScope(
		SCOPE,
		SCOPE_REF,
		{ type: "system.catalog." + event, channels: ["inapp"], payload: { ...payload, at: new Date().toISOString() } },
		(o) => !!o[event]
	);
}

/* ═══ СТАН ═══ */

/**
 * current: Map "a:b:c" → дані. Повертає нові записи (яких не було в стані) і очищає відновлені.
 * Порівняння — у пам'яті по одному типу (кількість проблемних позицій обмежена LIMIT у сканерах).
 */
async function diffState(kind, current) {
	const [rows] = await pool.query(`SELECT ref_a, ref_b, ref_c FROM ${P}products_alerts_state WHERE kind = ?`, [kind]);
	const known = new Set(rows.map((r) => `${r.ref_a}:${r.ref_b}:${r.ref_c}`));
	const fresh = [...current.entries()].filter(([k]) => !known.has(k));
	const gone = [...known].filter((k) => !current.has(k));
	if (fresh.length) {
		await pool.query(`INSERT IGNORE INTO ${P}products_alerts_state (kind, ref_a, ref_b, ref_c) VALUES ?`, [fresh.map(([k]) => [kind, ...k.split(":").map(Number)])]);
	}
	for (let i = 0; i < gone.length; i += 500) {
		const part = gone.slice(i, i + 500).map((k) => [kind, ...k.split(":").map(Number)]);
		await pool.query(`DELETE FROM ${P}products_alerts_state WHERE (kind, ref_a, ref_b, ref_c) IN (?)`, [part]);
	}
	return fresh.map(([, v]) => v);
}

const nameSql = (alias) =>
	`COALESCE((SELECT NULLIF(d.name, '') FROM ${P}products_description d WHERE d.id_product = ${alias}.id_product ORDER BY d.id_lang LIMIT 1), CONCAT('#', ${alias}.id_product))`;

const listText = (items, fmt) => items.slice(0, MAX_LIST).map(fmt).join("; ") + (items.length > MAX_LIST ? ` … +${items.length - MAX_LIST}` : "");

/* ═══ СКАНЕРИ ═══ */

/** Залишки: низький (≤ точки дозамовлення) і нульовий (лише позиції з рухом за добу — щоб не тягнути весь каталог) */
async function scanStock() {
	const [rows] = await pool.query(
		`SELECT s.id_product, s.id_variant, s.id_warehouse, s.available, s.reorder_point, w.name AS warehouse, ${nameSql("s")} AS name,
		        COALESCE(v.sku, p.sku) AS sku
		   FROM ${P}products_stock s
		   JOIN ${P}products p ON p.id = s.id_product AND p.deleted_at IS NULL AND p.track_inventory = 1 AND p.status <> 'archived'
		   JOIN ${P}products_warehouses w ON w.id = s.id_warehouse AND w.deleted_at IS NULL AND w.status = 1 AND w.is_sellable = 1
		   LEFT JOIN ${P}products_variants v ON v.id = s.id_variant AND s.id_variant > 0
		  WHERE (s.reorder_point IS NOT NULL AND s.available <= s.reorder_point)
		     OR (s.available <= 0 AND EXISTS (SELECT 1 FROM ${P}products_stock_movements m
		                                       WHERE m.id_product = s.id_product AND m.id_variant = s.id_variant AND m.id_warehouse = s.id_warehouse
		                                         AND m.date_add > NOW() - INTERVAL 1 DAY))
		  LIMIT 5000`
	);
	const low = new Map();
	const out = new Map();
	for (const r of rows) {
		const k = `${r.id_product}:${r.id_variant}:${r.id_warehouse}`;
		if (Number(r.available) <= 0) out.set(k, r);
		else low.set(k, r);
	}
	const fmt = (r) => `${r.name}${r.sku ? " (" + r.sku + ")" : ""} — ${Number(r.available)} @ ${r.warehouse}`;
	const freshLow = await diffState("low_stock", low);
	const freshOut = await diffState("out_of_stock", out);
	const url = "/catalog/settings/alerts/";
	if (freshLow.length) await send("low_stock", { title: t("catalog.alerts.n.low_stock", { n: freshLow.length }), message: listText(freshLow, fmt), url });
	if (freshOut.length) await send("out_of_stock", { title: t("catalog.alerts.n.out_of_stock", { n: freshOut.length }), message: listText(freshOut, fmt), url });
	return { low: freshLow.length, out: freshOut.length };
}

/** Заплановані ціни: застосовані, повернуті й помилкові за 2 доби */
async function scanPriceSchedule() {
	const [rows] = await pool.query(
		`SELECT s.id, s.id_product, s.status, s.value, s.error, ${nameSql("s")} AS name
		   FROM ${P}products_price_schedule s
		  WHERE s.status IN ('applied', 'reverted', 'failed')
		    AND COALESCE(s.reverted_at, s.applied_at, s.run_at) > NOW() - INTERVAL 2 DAY
		  LIMIT 2000`
	);
	const cur = new Map(rows.map((r) => [`${r.id}:${["applied", "reverted", "failed"].indexOf(r.status)}:0`, r]));
	const fresh = await diffState("price_schedule", cur);
	if (!fresh.length) return 0;
	const failed = fresh.filter((r) => r.status === "failed");
	const title = failed.length ? t("catalog.alerts.n.price_failed", { n: failed.length }) : t("catalog.alerts.n.price_applied", { n: fresh.length });
	const list = failed.length ? failed : fresh;
	await send("price_schedule", { title, message: listText(list, (r) => `${r.name}: ${t("catalog.schedule.status." + r.status)}${r.error ? " — " + r.error : ""}`), url: `/catalog/products/${list[0].id_product}/` });
	return fresh.length;
}

/** Замовлення з помилкою складу */
async function scanOrderStock() {
	const [rows] = await pool.query(
		`SELECT id, reference FROM ${P}orders WHERE deleted_at IS NULL AND stock_state = 'error' AND date_add > NOW() - INTERVAL 90 DAY LIMIT 2000`
	);
	const fresh = await diffState("order_stock", new Map(rows.map((r) => [`${r.id}:0:0`, r])));
	if (fresh.length) {
		await send("order_stock", { title: t("catalog.alerts.n.order_stock", { n: fresh.length }), message: listText(fresh, (r) => r.reference || "#" + r.id), url: `/orders/${fresh[0].id}/` });
	}
	return fresh.length;
}

/** Нові відгуки на модерації */
async function scanReviews() {
	const [rows] = await pool.query(
		`SELECT id, rating, author_name FROM ${P}products_reviews WHERE status = 'pending' AND deleted_at IS NULL AND date_add > NOW() - INTERVAL 30 DAY LIMIT 2000`
	);
	const fresh = await diffState("reviews", new Map(rows.map((r) => [`${r.id}:0:0`, r])));
	if (fresh.length) {
		await send("reviews", { title: t("catalog.alerts.n.reviews", { n: fresh.length }), message: listText(fresh, (r) => `${"★".repeat(r.rating)} ${r.author_name}`), url: "/catalog/reviews/" });
	}
	return fresh.length;
}

/** Помилки обміну з магазинами: остання відправка товарів з помилками, помилка обміну відгуками */
async function scanSync() {
	const [push] = await pool.query(
		`SELECT g.id_integration, i.name, g.errors, g.message
		   FROM ${P}products_sync_log g
		   JOIN (SELECT id_integration, MAX(id) AS id FROM ${P}products_sync_log GROUP BY id_integration) last ON last.id = g.id
		   JOIN ${P}orders_integrations i ON i.id = g.id_integration
		  WHERE g.errors > 0`
	);
	const [rev] = await pool.query(
		`SELECT rs.id_integration, i.name, rs.last_error AS message FROM ${P}products_reviews_sync rs
		   JOIN ${P}orders_integrations i ON i.id = rs.id_integration WHERE rs.last_error IS NOT NULL`
	);
	const cur = new Map([...push.map((r) => [`${r.id_integration}:1:0`, r]), ...rev.map((r) => [`${r.id_integration}:2:0`, r])]);
	const fresh = await diffState("sync", cur);
	if (fresh.length) {
		await send("sync", { title: t("catalog.alerts.n.sync", { n: fresh.length }), message: listText(fresh, (r) => `${r.name}: ${String(r.message || r.errors || "").slice(0, 120)}`), url: "/catalog/sync/" });
	}
	return fresh.length;
}

let running = false;

/** Cron: усі сканери; збій одного не зупиняє інші */
async function runAll() {
	if (running) return { skipped: true };
	running = true;
	const out = {};
	try {
		const recipients = await notifications.recipients.list(SCOPE, SCOPE_REF, 1);
		if (!recipients.length) return { skipped: "no_recipients" };
		for (const [name, fn] of Object.entries({ stock: scanStock, price: scanPriceSchedule, orders: scanOrderStock, reviews: scanReviews, sync: scanSync })) {
			try {
				out[name] = await fn();
			} catch (e) {
				console.error("[catalog-alerts]", name, e.message);
			}
		}
		return out;
	} finally {
		running = false;
	}
}

/* ═══ ЦИФРОВІ ТОВАРИ: УГОДА ВИГРАНА ═══ */

/**
 * Після переходу угоди у «виграно» (поза транзакцією угоди): створити посилання на завантаження
 * для всіх цифрових позицій (налаштування stock.auto_digital_links) і сповістити відповідального за угоду.
 */
async function onDealWon(idDeal) {
	try {
		if (!(await settings.get("stock")).auto_digital_links) return;
		const downloadLinks = require("./download-links");
		const [items] = await pool.query(
			`SELECT i.id FROM ${P}deals_item i JOIN ${P}products p ON p.id = i.id_product AND p.type = 'digital'
			  WHERE i.id_deal = ? AND i.active = 1`,
			[idDeal]
		);
		if (!items.length) return;
		let created = 0;
		for (const it of items) {
			try {
				created += await downloadLinks.create(idDeal, it.id, null);
			} catch (e) {
				if (!["no_files", "deal_not_won"].includes(e.code)) console.error("[digital-links auto]", idDeal, it.id, e.message);
			}
		}
		if (!created) return;
		const [[deal]] = await pool.query(`SELECT id, id_user, name FROM ${P}deals WHERE id = ?`, [idDeal]);
		if (!deal || !deal.id_user) return;
		await notifications.notify({
			type: "system.catalog.digital_links",
			audience: { user: deal.id_user },
			channels: ["inapp"],
			payload: { title: t("catalog.alerts.n.digital_links", { n: created }), message: deal.name || "#" + idDeal, url: `/deals/${idDeal}` },
			key: `catalog:digital_links:${idDeal}:${Date.now()}`,
		});
	} catch (e) {
		console.error("[digital-links auto]", idDeal, e.message);
	}
}

/* ═══ СТОРІНКА: ПОТОЧНІ ПРОБЛЕМИ ═══ */

async function currentStock(idLang) {
	const [rows] = await pool.query(
		`SELECT s.id_product, s.id_variant, s.id_warehouse, s.on_hand, s.reserved, s.available, s.reorder_point, s.reorder_qty,
		        w.name AS warehouse, COALESCE(v.sku, p.sku) AS sku,
		        COALESCE((SELECT NULLIF(d.name, '') FROM ${P}products_description d WHERE d.id_product = s.id_product AND d.id_lang = ?), ${nameSql("s")}) AS name
		   FROM ${P}products_stock s
		   JOIN ${P}products p ON p.id = s.id_product AND p.deleted_at IS NULL AND p.track_inventory = 1 AND p.status <> 'archived'
		   JOIN ${P}products_warehouses w ON w.id = s.id_warehouse AND w.deleted_at IS NULL AND w.status = 1
		   LEFT JOIN ${P}products_variants v ON v.id = s.id_variant AND s.id_variant > 0
		  WHERE s.reorder_point IS NOT NULL AND s.available <= s.reorder_point
		  ORDER BY (s.available <= 0) DESC, s.available - s.reorder_point
		  LIMIT 1000`,
		[idLang]
	);
	return rows;
}

module.exports = { EVENTS, getRecipients, saveRecipients, runAll, onDealWon, currentStock };