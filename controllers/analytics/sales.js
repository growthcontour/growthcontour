"use strict";

/**
 * Продажі для аналітики (головна й /analytics/): KPI, динаміка, статуси, канали, ТОП товарів, воронка, кошики, обмін із сайтами.
 * Джерело — денні агрегати orders_stats_* (cron/analytics/rebuildStats), крім воронки (історія статусів) і кошиків.
 *
 * parseFilters — єдина нормалізація фільтра: у SQL потрапляють лише числа, дати YYYY-MM-DD і значення з білого списку.
 * Кешування — у cache.js; тут лише обчислення.
 */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;
const MAX_RANGE_DAYS = 400; // захист від запиту «за все життя»
const TZ = "Europe/Kyiv";

const pad = (n) => (n < 10 ? "0" + n : "" + n);
const toDay = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
/** Сьогодні за київським часом — так само, як рахує сторінка в браузері користувача */
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const today = () => dayFmt.format(new Date());
const addDays = (day, n) => {
	const d = new Date(day + "T00:00:00");
	d.setDate(d.getDate() + n);
	return toDay(d);
};
const dayKey = (v) => (!v ? null : typeof v === "string" ? v.slice(0, 10) : toDay(v));
const isValidDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

function parseFilters(body) {
	const b = body || {};
	let date_to = isValidDay(b.date_to) ? b.date_to : today();
	let date_from = isValidDay(b.date_from) ? b.date_from : addDays(date_to, -29);
	if (date_from > date_to) [date_from, date_to] = [date_to, date_from];
	const days = Math.round((Date.parse(date_to) - Date.parse(date_from)) / 86400000) + 1;
	if (days > MAX_RANGE_DAYS) date_from = addDays(date_to, -(MAX_RANGE_DAYS - 1));

	// Сайти: масив id або null = всі (id_integration — старий формат головної)
	let integrations = null;
	if (Array.isArray(b.integrations)) {
		integrations = [...new Set(b.integrations.map((v) => parseInt(v, 10)).filter((v) => Number.isInteger(v) && v >= 0))].sort((x, y) => x - y).slice(0, 50);
		if (!integrations.length) integrations = null;
	} else if (b.id_integration !== undefined && b.id_integration !== null && b.id_integration !== "all" && b.id_integration !== "") {
		const v = parseInt(b.id_integration, 10);
		if (Number.isInteger(v) && v >= 0) integrations = [v];
	}
	const granularity = ["day", "week", "month"].includes(b.granularity) ? b.granularity : "day";
	const split_by_integration = b.split_by_integration === true || b.split_by_integration === "true";
	return { date_from, date_to, integrations, granularity, split_by_integration };
}

function integrationClause(integrations, alias) {
	const a = alias ? alias + "." : "";
	if (!integrations) return { sql: "", params: [] };
	return { sql: ` AND ${a}id_integration IN (${integrations.map(() => "?").join(",")})`, params: integrations.slice() };
}

function periodExpr(granularity, alias) {
	const a = alias ? alias + "." : "";
	if (granularity === "month") return `DATE_FORMAT(${a}day, '%Y-%m-01')`;
	if (granularity === "week") return `DATE_SUB(${a}day, INTERVAL WEEKDAY(${a}day) DAY)`;
	return `${a}day`;
}

/** Усі періоди діапазону — пропущені заповнюються нулями, інакше лінія в ECharts рветься */
function buildPeriods(date_from, date_to, granularity) {
	const out = [];
	const cur = new Date(date_from + "T00:00:00");
	const end = new Date(date_to + "T00:00:00");
	if (granularity === "month") cur.setDate(1);
	if (granularity === "week") cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7));
	while (cur <= end && out.length <= 1000) {
		out.push(toDay(cur));
		if (granularity === "month") cur.setMonth(cur.getMonth() + 1);
		else if (granularity === "week") cur.setDate(cur.getDate() + 7);
		else cur.setDate(cur.getDate() + 1);
	}
	return out;
}

/* ─── Розділи ─── */

/** KPI + порівняння з попереднім періодом такої ж довжини */
async function summary(f) {
	const ic = integrationClause(f.integrations);
	const lenDays = Math.round((Date.parse(f.date_to) - Date.parse(f.date_from)) / 86400000) + 1;
	const prevTo = addDays(f.date_from, -1);
	const prevFrom = addDays(prevTo, -(lenDays - 1));
	const sql =
		`SELECT SUM(orders_count) AS orders_count, SUM(orders_valid) AS orders_valid, SUM(orders_canceled) AS orders_canceled,
		        SUM(revenue_gross_base) AS revenue, SUM(refunded_base) AS refunded, SUM(fees_base) AS fees, SUM(discount_base) AS discount,
		        SUM(items_qty) AS items_qty, SUM(new_clients) AS new_clients
		   FROM ${P}orders_stats_daily WHERE day BETWEEN ? AND ?` + ic.sql;
	const [[[cur]], [[prev]]] = await Promise.all([pool.query(sql, [f.date_from, f.date_to, ...ic.params]), pool.query(sql, [prevFrom, prevTo, ...ic.params])]);

	const block = (r) => {
		const revenue = num(r.revenue);
		const valid = num(r.orders_valid);
		return {
			orders_count: num(r.orders_count),
			orders_valid: valid,
			orders_canceled: num(r.orders_canceled),
			revenue,
			refunded: num(r.refunded),
			fees: num(r.fees),
			discount: num(r.discount),
			net_revenue: revenue - num(r.refunded) - num(r.fees),
			items_qty: num(r.items_qty),
			new_clients: num(r.new_clients),
			avg_check: valid > 0 ? revenue / valid : 0,
			cancel_rate: num(r.orders_count) > 0 ? (num(r.orders_canceled) / num(r.orders_count)) * 100 : 0,
		};
	};
	const current = block(cur);
	const previous = block(prev);
	const delta = {};
	for (const k of Object.keys(current)) {
		const a = current[k];
		const b = previous[k];
		delta[k] = b > 0 ? ((a - b) / b) * 100 : a > 0 ? 100 : 0;
	}
	return { period: { date_from: f.date_from, date_to: f.date_to }, previous_period: { date_from: prevFrom, date_to: prevTo }, current, previous, delta };
}

/** Динаміка виручки / замовлень; split — окрема серія на кожен сайт */
async function timeseries(f, labels = {}) {
	const ic = integrationClause(f.integrations, "s");
	const pexpr = periodExpr(f.granularity, "s");
	const periods = buildPeriods(f.date_from, f.date_to, f.granularity);
	const idx = Object.fromEntries(periods.map((p, i) => [p, i]));
	const L = { revenue: "Виручка", refunded: "Повернення", orders: "Замовлення", site: "Сайт", ...labels };

	if (f.split_by_integration) {
		const [rows] = await pool.query(
			`SELECT ${pexpr} AS p, s.id_integration, SUM(s.revenue_gross_base) AS revenue, SUM(s.orders_valid) AS orders
			   FROM ${P}orders_stats_daily s WHERE s.day BETWEEN ? AND ?${ic.sql}
			  GROUP BY p, s.id_integration ORDER BY p`,
			[f.date_from, f.date_to, ...ic.params]
		);
		const [ints] = await pool.query(`SELECT id, name FROM ${P}settings_integrations`);
		const names = Object.fromEntries(ints.map((i) => [i.id, i.name]));
		const byInt = {};
		for (const r of rows) {
			const i = idx[dayKey(r.p)];
			if (i === undefined) continue;
			if (!byInt[r.id_integration]) byInt[r.id_integration] = new Array(periods.length).fill(0);
			byInt[r.id_integration][i] = num(r.revenue);
		}
		const series = Object.keys(byInt).map((id) => ({ name: (names[id] || L.site + " #" + id) + " — " + L.revenue, type: "line", smooth: true, id_integration: Number(id), metric: "revenue", data: byInt[id] }));
		return { granularity: f.granularity, xAxis: periods, legend: series.map((s) => s.name), series };
	}

	const [rows] = await pool.query(
		`SELECT ${pexpr} AS p, SUM(s.revenue_gross_base) AS revenue, SUM(s.orders_valid) AS orders, SUM(s.refunded_base) AS refunded
		   FROM ${P}orders_stats_daily s WHERE s.day BETWEEN ? AND ?${ic.sql}
		  GROUP BY p ORDER BY p`,
		[f.date_from, f.date_to, ...ic.params]
	);
	const revenue = new Array(periods.length).fill(0);
	const orders = new Array(periods.length).fill(0);
	const refunded = new Array(periods.length).fill(0);
	for (const r of rows) {
		const i = idx[dayKey(r.p)];
		if (i === undefined) continue;
		revenue[i] = num(r.revenue);
		orders[i] = num(r.orders);
		refunded[i] = num(r.refunded);
	}
	const series = [
		{ name: L.revenue, type: "line", smooth: true, yAxisIndex: 0, metric: "revenue", data: revenue },
		{ name: L.refunded, type: "line", smooth: true, yAxisIndex: 0, metric: "refunded", data: refunded },
		{ name: L.orders, type: "bar", yAxisIndex: 1, metric: "orders", data: orders },
	];
	return { granularity: f.granularity, xAxis: periods, legend: series.map((s) => s.name), series };
}

/** Розподіл за статусами (pie) — кольори з довідника статусів */
async function statuses(f, idLang) {
	const ic = integrationClause(f.integrations, "s");
	const [rows] = await pool.query(
		`SELECT s.id_status, SUM(s.orders_count) AS orders_count, SUM(s.revenue_base) AS revenue,
		        st.color_background, COALESCE(sl.text, CONCAT('#', s.id_status)) AS name
		   FROM ${P}orders_stats_daily_status s
		   LEFT JOIN ${P}orders_status st ON st.id = s.id_status
		   LEFT JOIN ${P}orders_status_lang sl ON sl.id_status = s.id_status AND sl.id_lang = ?
		  WHERE s.day BETWEEN ? AND ?${ic.sql}
		  GROUP BY s.id_status, st.color_background, sl.text
		  ORDER BY orders_count DESC`,
		[idLang, f.date_from, f.date_to, ...ic.params]
	);
	return { data: rows.map((r) => ({ id_status: r.id_status, name: r.name, value: num(r.orders_count), revenue: num(r.revenue), itemStyle: { color: r.color_background || "#95a5a6" } })) };
}

/** Канали продажів (bar) */
async function channels(f, labels = {}) {
	const ic = integrationClause(f.integrations);
	const [rows] = await pool.query(
		`SELECT source_channel, SUM(orders_count) AS orders_count, SUM(revenue_base) AS revenue
		   FROM ${P}orders_stats_daily_channel WHERE day BETWEEN ? AND ?${ic.sql}
		  GROUP BY source_channel ORDER BY revenue DESC LIMIT 30`,
		[f.date_from, f.date_to, ...ic.params]
	);
	return {
		xAxis: rows.map((r) => r.source_channel || "—"),
		series: [
			{ name: labels.revenue || "Виручка", type: "bar", data: rows.map((r) => num(r.revenue)) },
			{ name: labels.orders || "Замовлення", type: "bar", data: rows.map((r) => num(r.orders_count)) },
		],
	};
}

/** ТОП-50 товарів за виручкою і за кількістю — обидва списки одразу (кеш один, зріз — у відповіді) */
async function topProducts(f) {
	const ic = integrationClause(f.integrations);
	const q = (order) =>
		pool.query(
			`SELECT sku, MAX(name) AS p_name, SUM(qty) AS p_qty, SUM(revenue_base) AS p_revenue
			   FROM ${P}orders_stats_daily_product WHERE day BETWEEN ? AND ?${ic.sql}
			  GROUP BY sku ORDER BY ${order} DESC LIMIT 50`,
			[f.date_from, f.date_to, ...ic.params]
		);
	const [[byRevenue], [byQty]] = await Promise.all([q("p_revenue"), q("p_qty")]);
	const map = (rows) => rows.map((r) => ({ sku: r.sku, name: r.p_name, qty: num(r.p_qty), revenue: num(r.p_revenue) }));
	return { revenue: map(byRevenue), qty: map(byQty) };
}

/** Відповідь у форматі ECharts для ТОП товарів: metric, limit */
function topProductsView(data, metric, limit, labels = {}) {
	const isQty = metric === "qty";
	const rows = (isQty ? data.qty : data.revenue).slice(0, limit).reverse(); // horizontal bar читається знизу вгору
	return {
		yAxis: rows.map((r) => r.name || r.sku),
		series: [{ name: isQty ? labels.qty || "Кількість" : labels.revenue || "Виручка", type: "bar", data: rows.map((r) => (isQty ? r.qty : r.revenue)) }],
		raw: rows,
	};
}

/** Воронка статусів: скільки замовлень пройшло статус і середній час у ньому */
async function funnel(f, idLang) {
	const ic = integrationClause(f.integrations, "o");
	const [rows] = await pool.query(
		`SELECT h.id_status, COUNT(DISTINCT h.id_order) AS orders_count, AVG(h.duration_sec) AS avg_sec,
		        COALESCE(sl.text, CONCAT('#', h.id_status)) AS name, st.color_background
		   FROM ${P}orders_status_history h
		   JOIN ${P}orders o ON o.id = h.id_order
		   LEFT JOIN ${P}orders_status st ON st.id = h.id_status
		   LEFT JOIN ${P}orders_status_lang sl ON sl.id_status = h.id_status AND sl.id_lang = ?
		  WHERE o.date_order_day BETWEEN ? AND ? AND o.deleted_at IS NULL${ic.sql}
		  GROUP BY h.id_status, sl.text, st.color_background
		  ORDER BY orders_count DESC`,
		[idLang, f.date_from, f.date_to, ...ic.params]
	);
	return {
		data: rows.map((r) => ({ name: r.name, value: num(r.orders_count), avg_hours: r.avg_sec ? Math.round(num(r.avg_sec) / 36) / 100 : null, itemStyle: { color: r.color_background || "#95a5a6" } })),
	};
}

/** Кинуті кошики: конверсія відновлення */
async function carts(f) {
	const ic = integrationClause(f.integrations);
	// Діапазон по стовпцю, а не DATE(стовпець) — індекс по first_seen_at працює
	const [rows] = await pool.query(
		`SELECT status, COUNT(*) AS cnt, SUM(total_amount) AS amount
		   FROM ${P}orders_abandoned_cart
		  WHERE first_seen_at >= ? AND first_seen_at < ? + INTERVAL 1 DAY${ic.sql}
		  GROUP BY status`,
		[f.date_from, f.date_to, ...ic.params]
	);
	let total = 0;
	let recovered = 0;
	let lost = 0;
	let recoveredAmount = 0;
	for (const r of rows) {
		total += num(r.cnt);
		if (r.status === "recovered") {
			recovered += num(r.cnt);
			recoveredAmount += num(r.amount);
		} else lost += num(r.amount);
	}
	return {
		data: rows.map((r) => ({ name: r.status, value: num(r.cnt), amount: num(r.amount) })),
		total_carts: total,
		recovered_carts: recovered,
		recovery_rate: total > 0 ? (recovered / total) * 100 : 0,
		recovered_amount: recoveredAmount,
		lost_amount: lost,
	};
}

/** Обмін із сайтами: вхідні / вихідні черги, запити з токенами */
async function health(f) {
	const ic = integrationClause(f.integrations);
	const range = [f.date_from, f.date_to, ...ic.params];
	const [[[inbox]], [[outbox]], [tokens]] = await Promise.all([
		pool.query(`SELECT SUM(status = 'done') AS done, SUM(status = 'failed') AS failed, SUM(status = 'pending') AS pending FROM ${P}orders_inbox WHERE received_at >= ? AND received_at < ? + INTERVAL 1 DAY${ic.sql}`, range),
		pool.query(`SELECT SUM(status = 'done') AS done, SUM(status = 'failed') AS failed, SUM(status = 'pending') AS pending FROM ${P}orders_outbox WHERE date_add >= ? AND date_add < ? + INTERVAL 1 DAY${ic.sql}`, range),
		pool.query(
			`SELECT COALESCE(reject_reason, 'success') AS reason, COUNT(*) AS cnt FROM ${P}settings_integrations_tokens_log
			  WHERE date_add >= ? AND date_add < ? + INTERVAL 1 DAY GROUP BY reason ORDER BY cnt DESC LIMIT 20`,
			[f.date_from, f.date_to]
		),
	]);
	return {
		inbox: { done: num(inbox.done), failed: num(inbox.failed), pending: num(inbox.pending) },
		outbox: { done: num(outbox.done), failed: num(outbox.failed), pending: num(outbox.pending) },
		token_reasons: tokens.map((r) => ({ name: r.reason, value: num(r.cnt) })),
	};
}

/** Сайти для перемикача — лише ті, де є дані */
async function integrations() {
	const [rows] = await pool.query(
		`SELECT i.id, i.name, i.platform, i.base_url, COALESCE(s.orders_count, 0) AS orders_count, s.last_day
		   FROM ${P}settings_integrations i
		   LEFT JOIN (SELECT id_integration, SUM(orders_count) AS orders_count, MAX(day) AS last_day FROM ${P}orders_stats_daily GROUP BY id_integration) s ON s.id_integration = i.id
		  WHERE i.status = 'active'
		  ORDER BY orders_count DESC, i.name ASC LIMIT 1000`
	);
	return { items: rows.map((r) => ({ id: r.id, name: r.name, platform: r.platform, base_url: r.base_url, orders_count: num(r.orders_count), last_day: r.last_day })) };
}

module.exports = { parseFilters, today, addDays, summary, timeseries, statuses, channels, topProducts, topProductsView, funnel, carts, health, integrations };