"use strict";

/**
 * Розширена аналітика (/analytics/): доставка й викуп, клієнти й когорти, менеджери, час замовлень,
 * повідомлення й правила, повернення, товари (маржа / ABC з catalog/products/reports) та вивантаження в Excel.
 *
 * Фільтр f — з parseFilters маршруту аналітики: { date_from, date_to, integrations: [id] | null, granularity }.
 * Рахується «наживо» з таблиць замовлень (агрегати orders_stats_* лише для продажів), тож діапазон обмежено там само (400 днів).
 * Суми — в основній валюті (*_base). Виручка — замовлення не в «негативних» статусах (orders_status.is_negative = 0).
 */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (a, b) => (Number(b) > 0 ? r2((Number(a) / Number(b)) * 100) : 0);
const n = (v) => Number(v) || 0;

/** WHERE для замовлень періоду: дата, сайти, не видалені */
function orderWhere(f, a = "o") {
	const params = [f.date_from, f.date_to];
	let sql = `${a}.date_order_day BETWEEN ? AND ? AND ${a}.deleted_at IS NULL`;
	if (f.integrations) {
		sql += ` AND COALESCE(${a}.id_integration, 0) IN (?)`;
		params.push(f.integrations);
	}
	return { sql, params };
}

/** Період для групування в SQL (як periodExpr маршруту, але по даті замовлення) */
function periodSql(granularity, col) {
	if (granularity === "month") return `DATE_FORMAT(${col}, '%Y-%m-01')`;
	if (granularity === "week") return `DATE_SUB(${col}, INTERVAL WEEKDAY(${col}) DAY)`;
	return col;
}

const dayStr = (v) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}` : String(v || "").slice(0, 10));

/* ─── Доставка й викуп ─── */

/**
 * Відправлення замовлень періоду: стан, викуп (доставлено / (доставлено + повернення)), середній час доставки,
 * динаміка й міста з найгіршим викупом.
 */
async function delivery(f) {
	const w = orderWhere(f);
	const [[t]] = await pool.query(
		`SELECT COUNT(*) AS shipments,
		        SUM(s.status = 'delivered') AS delivered,
		        SUM(s.status = 'returned') AS returned,
		        SUM(s.status IN ('created', 'in_transit')) AS in_transit,
		        SUM(s.status IN ('draft', 'review')) AS draft,
		        AVG(CASE WHEN s.status = 'delivered' AND s.delivered_at IS NOT NULL AND s.shipped_at IS NOT NULL THEN TIMESTAMPDIFF(HOUR, s.shipped_at, s.delivered_at) END) AS avg_hours,
		        SUM(CASE WHEN s.status = 'returned' THEN o.total_base ELSE 0 END) AS returned_value,
		        COALESCE(SUM(s.cost), 0) AS cost
		   FROM ${P}orders_shipments s JOIN ${P}orders o ON o.id = s.id_order
		  WHERE ${w.sql}`,
		w.params
	);
	const per = periodSql(f.granularity, "o.date_order_day");
	const [series] = await pool.query(
		`SELECT ${per} AS p, SUM(s.status = 'delivered') AS delivered, SUM(s.status = 'returned') AS returned, SUM(s.status IN ('created', 'in_transit')) AS in_transit
		   FROM ${P}orders_shipments s JOIN ${P}orders o ON o.id = s.id_order
		  WHERE ${w.sql} GROUP BY p ORDER BY p`,
		w.params
	);
	const [cities] = await pool.query(
		`SELECT COALESCE(NULLIF(a.city, ''), '—') AS city, COUNT(*) AS shipments,
		        SUM(s.status = 'delivered') AS delivered, SUM(s.status = 'returned') AS returned
		   FROM ${P}orders_shipments s
		   JOIN ${P}orders o ON o.id = s.id_order
		   LEFT JOIN ${P}orders_addresses a ON a.id = (SELECT MIN(x.id) FROM ${P}orders_addresses x WHERE x.id_order = o.id AND x.type = 'shipping')
		  WHERE ${w.sql} AND s.status IN ('delivered', 'returned')
		  GROUP BY city HAVING shipments >= 3 ORDER BY shipments DESC LIMIT 30`,
		w.params
	);
	// Викуп за способом оплати (накладений платіж vs передоплата — головне джерело повернень)
	const [byPayment] = await pool.query(
		`SELECT COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(o.custom_fields, '$._payment_method')), 'null'), '—') AS payment,
		        SUM(s.status = 'delivered') AS delivered, SUM(s.status = 'returned') AS returned
		   FROM ${P}orders_shipments s JOIN ${P}orders o ON o.id = s.id_order
		  WHERE ${w.sql} AND s.status IN ('delivered', 'returned')
		  GROUP BY payment ORDER BY (delivered + returned) DESC LIMIT 15`,
		w.params
	);
	const done = n(t.delivered) + n(t.returned);
	return {
		total: {
			shipments: n(t.shipments),
			delivered: n(t.delivered),
			returned: n(t.returned),
			in_transit: n(t.in_transit),
			draft: n(t.draft),
			buyout: pct(t.delivered, done),
			avg_days: t.avg_hours === null ? null : r2(n(t.avg_hours) / 24),
			returned_value: r2(t.returned_value),
			cost: r2(t.cost),
		},
		series: series.map((r) => ({ p: dayStr(r.p), delivered: n(r.delivered), returned: n(r.returned), in_transit: n(r.in_transit) })),
		cities: cities.map((r) => ({ city: r.city, shipments: n(r.shipments), delivered: n(r.delivered), returned: n(r.returned), buyout: pct(r.delivered, n(r.delivered) + n(r.returned)) })),
		payments: byPayment.map((r) => ({ payment: r.payment, delivered: n(r.delivered), returned: n(r.returned), buyout: pct(r.delivered, n(r.delivered) + n(r.returned)) })),
	};
}

/* ─── Клієнти ─── */

/**
 * Нові / повторні клієнти за періодами, частка повторних, середній чек, LTV;
 * когорти — місяць першого замовлення × частка, що купила знову через 1..6 місяців (лише по клієнтах з карткою).
 */
async function clients(f) {
	const w = orderWhere(f);
	const per = periodSql(f.granularity, "o.date_order_day");
	// Перше замовлення клієнта (за весь час, не лише період) — щоб відрізнити нового від повторного
	const first = `(SELECT MIN(x.date_order_day) FROM ${P}orders x WHERE x.id_client = o.id_client AND x.deleted_at IS NULL)`;
	const [series] = await pool.query(
		`SELECT ${per} AS p,
		        COUNT(DISTINCT CASE WHEN o.id_client IS NOT NULL AND ${first} >= ${periodSql(f.granularity, "o.date_order_day")} THEN o.id_client END) AS new_clients,
		        COUNT(DISTINCT CASE WHEN o.id_client IS NOT NULL AND ${first} < ${periodSql(f.granularity, "o.date_order_day")} THEN o.id_client END) AS returning_clients,
		        SUM(o.id_client IS NULL) AS guests
		   FROM ${P}orders o JOIN ${P}orders_status st ON st.id = o.status
		  WHERE ${w.sql} AND st.is_negative = 0
		  GROUP BY p ORDER BY p`,
		w.params
	);
	const [[t]] = await pool.query(
		`SELECT COUNT(DISTINCT o.id_client) AS clients, COUNT(*) AS orders, SUM(o.id_client IS NULL) AS guests, SUM(o.total_base) AS revenue,
		        COUNT(DISTINCT CASE WHEN ${first} < ? THEN o.id_client END) AS returning_clients
		   FROM ${P}orders o JOIN ${P}orders_status st ON st.id = o.status
		  WHERE ${w.sql} AND st.is_negative = 0`,
		[f.date_from, ...w.params]
	);
	// Топ клієнтів періоду
	const [top] = await pool.query(
		`SELECT o.id_client, MAX(JSON_UNQUOTE(JSON_EXTRACT(o.client, '$.phone'))) AS phone,
		        MAX(TRIM(CONCAT_WS(' ', JSON_UNQUOTE(JSON_EXTRACT(o.client, '$.firstname')), JSON_UNQUOTE(JSON_EXTRACT(o.client, '$.lastname'))))) AS name,
		        COUNT(*) AS orders, SUM(o.total_base) AS revenue
		   FROM ${P}orders o JOIN ${P}orders_status st ON st.id = o.status
		  WHERE ${w.sql} AND st.is_negative = 0 AND o.id_client IS NOT NULL
		  GROUP BY o.id_client ORDER BY revenue DESC LIMIT 20`,
		w.params
	);
	// Когорти: перші замовлення в межах періоду (не більше 12 місяців), повторні — за будь-який час після
	const ints = f.integrations ? ` AND COALESCE(x.id_integration, 0) IN (?)` : "";
	const [coh] = await pool.query(
		`SELECT DATE_FORMAT(c.first_day, '%Y-%m') AS cohort,
		        PERIOD_DIFF(DATE_FORMAT(x.date_order_day, '%Y%m'), DATE_FORMAT(c.first_day, '%Y%m')) AS m,
		        COUNT(DISTINCT x.id_client) AS buyers
		   FROM (SELECT y.id_client, MIN(y.date_order_day) AS first_day FROM ${P}orders y
		          WHERE y.id_client IS NOT NULL AND y.deleted_at IS NULL GROUP BY y.id_client
		         HAVING first_day BETWEEN GREATEST(?, ? - INTERVAL 12 MONTH) AND ?) c
		   JOIN ${P}orders x ON x.id_client = c.id_client AND x.deleted_at IS NULL AND x.date_order_day > c.first_day${ints}
		  GROUP BY cohort, m
		 HAVING m BETWEEN 1 AND 6`,
		[f.date_from, f.date_to, f.date_to, ...(f.integrations ? [f.integrations] : [])]
	);
	const [sizes] = await pool.query(
		`SELECT DATE_FORMAT(first_day, '%Y-%m') AS cohort, COUNT(*) AS size
		   FROM (SELECT MIN(date_order_day) AS first_day FROM ${P}orders WHERE id_client IS NOT NULL AND deleted_at IS NULL GROUP BY id_client) f1
		  WHERE first_day BETWEEN GREATEST(?, ? - INTERVAL 12 MONTH) AND ?
		  GROUP BY cohort ORDER BY cohort`,
		[f.date_from, f.date_to, f.date_to]
	);
	const cohorts = sizes.map((s) => {
		const row = { cohort: s.cohort, size: n(s.size), months: [] };
		for (let m = 1; m <= 6; m++) {
			const hit = coh.find((c) => c.cohort === s.cohort && n(c.m) === m);
			row.months.push(hit ? pct(hit.buyers, s.size) : 0);
		}
		return row;
	});
	const known = n(t.orders) - n(t.guests);
	return {
		total: {
			clients: n(t.clients),
			returning: n(t.returning_clients),
			new: Math.max(0, n(t.clients) - n(t.returning_clients)),
			repeat_rate: pct(t.returning_clients, t.clients),
			orders_per_client: n(t.clients) ? r2(known / n(t.clients)) : 0,
			guests: n(t.guests),
			revenue_per_client: n(t.clients) ? r2(n(t.revenue) / n(t.clients)) : 0,
		},
		series: series.map((r) => ({ p: dayStr(r.p), new: n(r.new_clients), returning: n(r.returning_clients), guests: n(r.guests) })),
		cohorts,
		top: top.map((r) => ({ id_client: r.id_client, name: r.name || "", phone: r.phone || "", orders: n(r.orders), revenue: r2(r.revenue) })),
	};
}

/* ─── Менеджери ─── */

/** По відповідальному: замовлення, виручка, середній чек, скасування, повернення, час до «взяти в роботу» */
async function managers(f) {
	const w = orderWhere(f);
	// Час реакції — від надходження до першої дії менеджера (взяв у роботу / змінив статус)
	const [rows] = await pool.query(
		`SELECT t.id_user, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS name,
		        COUNT(*) AS orders, SUM(t.neg = 0) AS valid, SUM(t.neg = 1) AS canceled,
		        SUM(CASE WHEN t.neg = 0 THEN t.total_base ELSE 0 END) AS revenue,
		        SUM(t.total_refunded_base) AS refunded, AVG(t.react) AS react_min
		   FROM (SELECT o.id_user, st.is_negative AS neg, o.total_base, o.total_refunded_base,
		                (SELECT TIMESTAMPDIFF(MINUTE, o.date_add, MIN(e.date_add)) FROM ${P}orders_events e
		                  WHERE e.id_order = o.id AND e.type IN ('taken', 'status_change')) AS react
		           FROM ${P}orders o JOIN ${P}orders_status st ON st.id = o.status
		          WHERE ${w.sql}) t
		   LEFT JOIN ${P}users u ON u.id = t.id_user
		  GROUP BY t.id_user, name ORDER BY revenue DESC`,
		w.params
	);
	return {
		rows: rows.map((r) => ({
			id_user: r.id_user,
			name: r.name,
			orders: n(r.orders),
			valid: n(r.valid),
			canceled: n(r.canceled),
			cancel_rate: pct(r.canceled, r.orders),
			revenue: r2(r.revenue),
			avg_check: n(r.valid) ? r2(n(r.revenue) / n(r.valid)) : 0,
			refunded: r2(r.refunded),
			react_min: r.react_min === null ? null : Math.round(n(r.react_min)),
		})),
	};
}

/* ─── Час замовлень ─── */

/** Теплова карта: день тижня × година (за часом надходження замовлення) */
async function heatmap(f) {
	const w = orderWhere(f);
	const [rows] = await pool.query(
		`SELECT WEEKDAY(COALESCE(o.date_order, o.date_add)) AS d, HOUR(COALESCE(o.date_order, o.date_add)) AS h, COUNT(*) AS cnt, SUM(o.total_base) AS revenue
		   FROM ${P}orders o WHERE ${w.sql} GROUP BY d, h`,
		w.params
	);
	return { data: rows.map((r) => [n(r.h), n(r.d), n(r.cnt), r2(r.revenue)]) };
}

/* ─── Повідомлення й правила ─── */

async function automation(f) {
	const ints = f.integrations ? ` AND COALESCE(o.id_integration, 0) IN (?)` : "";
	const p = [f.date_from, f.date_to, ...(f.integrations ? [f.integrations] : [])];
	const [msg] = await pool.query(
		`SELECT m.status, m.source, COUNT(*) AS cnt
		   FROM ${P}orders_messages m JOIN ${P}orders o ON o.id = m.id_order
		  WHERE m.date_add >= ? AND m.date_add < ? + INTERVAL 1 DAY${ints}
		  GROUP BY m.status, m.source`,
		p
	).catch(() => [[]]);
	const [tpl] = await pool.query(
		`SELECT COALESCE(t.name, '—') AS name, COUNT(*) AS cnt, SUM(m.status = 'sent') AS sent, SUM(m.status = 'failed') AS failed
		   FROM ${P}orders_messages m JOIN ${P}orders o ON o.id = m.id_order LEFT JOIN ${P}orders_message_templates t ON t.id = m.id_template
		  WHERE m.date_add >= ? AND m.date_add < ? + INTERVAL 1 DAY${ints}
		  GROUP BY name ORDER BY cnt DESC LIMIT 20`,
		p
	).catch(() => [[]]);
	const [rules] = await pool.query(
		`SELECT r.name, COUNT(*) AS runs, SUM(l.result = 'ok') AS ok, SUM(l.result = 'partial') AS partial, SUM(l.result = 'error') AS error
		   FROM ${P}orders_rules_log l JOIN ${P}orders_rules r ON r.id = l.id_rule JOIN ${P}orders o ON o.id = l.id_order
		  WHERE l.date_add >= ? AND l.date_add < ? + INTERVAL 1 DAY${ints}
		  GROUP BY r.id, r.name ORDER BY runs DESC`,
		p
	).catch(() => [[]]);
	const by = (k) => msg.filter((m) => m.status === k).reduce((s, m) => s + n(m.cnt), 0);
	return {
		messages: { total: msg.reduce((s, m) => s + n(m.cnt), 0), sent: by("sent"), failed: by("failed"), pending: by("pending"), auto: msg.filter((m) => m.source === "auto").reduce((s, m) => s + n(m.cnt), 0) },
		templates: tpl.map((r) => ({ name: r.name, total: n(r.cnt), sent: n(r.sent), failed: n(r.failed) })),
		rules: rules.map((r) => ({ name: r.name, runs: n(r.runs), ok: n(r.ok), partial: n(r.partial), error: n(r.error) })),
	};
}

/* ─── Повернення й обміни ─── */

async function returns(f) {
	const ints = f.integrations ? ` AND COALESCE(o.id_integration, 0) IN (?)` : "";
	const p = [f.date_from, f.date_to, ...(f.integrations ? [f.integrations] : [])];
	let rows;
	try {
		[rows] = await pool.query(
			`SELECT r.type, r.status, r.reason, r.items, r.amount, r.amount_due
			   FROM ${P}orders_returns r JOIN ${P}orders o ON o.id = r.id_order AND o.deleted_at IS NULL
			  WHERE r.date_add >= ? AND r.date_add < ? + INTERVAL 1 DAY${ints}`,
			p
		);
	} catch (e) {
		if (e.code === "ER_NO_SUCH_TABLE") return { total: { requests: 0 }, reasons: [], statuses: [], products: [] };
		throw e;
	}
	const reasons = new Map();
	const statuses = new Map();
	const products = new Map();
	let value = 0;
	let defects = 0;
	let qty = 0;
	let refunded = 0;
	let exchanges = 0;
	for (const r of rows) {
		reasons.set(r.reason, (reasons.get(r.reason) || 0) + 1);
		statuses.set(r.status, (statuses.get(r.status) || 0) + 1);
		if (r.type === "exchange") exchanges++;
		refunded += n(r.amount);
		let items = [];
		try {
			items = typeof r.items === "string" ? JSON.parse(r.items) : r.items || [];
		} catch {
			items = [];
		}
		for (const it of items) {
			const k = it.sku || it.name;
			const pr = products.get(k) || { sku: it.sku || "", name: it.name || "", qty: 0, defect: 0, value: 0 };
			pr.qty += n(it.qty);
			pr.value += n(it.qty) * n(it.unit);
			if (it.condition === "defect") pr.defect += n(it.qty);
			products.set(k, pr);
			qty += n(it.qty);
			value += n(it.qty) * n(it.unit);
			if (it.condition === "defect") defects += n(it.qty);
		}
	}
	return {
		total: { requests: rows.length, exchanges, returns: rows.length - exchanges, qty, value: r2(value), refunded: r2(refunded), defect_rate: pct(defects, qty) },
		reasons: [...reasons.entries()].map(([k, v]) => ({ key: k, value: v })).sort((a, b) => b.value - a.value),
		statuses: [...statuses.entries()].map(([k, v]) => ({ key: k, value: v })),
		products: [...products.values()].map((x) => ({ ...x, value: r2(x.value) })).sort((a, b) => b.qty - a.qty).slice(0, 30),
	};
}

/* ─── Товари: маржа й ABC (звіти каталогу) ─── */

async function products(f, group, idLang) {
	const reports = require("../catalog/products/reports");
	// Звіти каталогу фільтрують по одному сайту; кілька вибраних — усі
	const q = { date_from: f.date_from, date_to: f.date_to, id_integration: f.integrations && f.integrations.length === 1 ? f.integrations[0] : "", group };
	const [m, s] = await Promise.all([reports.margin(q, idLang), group === "product" ? reports.stock(q, idLang) : null]);
	const abc = new Map(s ? s.rows.map((r) => [`${r.id_product}:${r.id_variant}`, r]) : []);
	return {
		total: m.total,
		abc: s ? s.summary.abc : null,
		dead: s ? { count: s.summary.dead, value: s.summary.dead_value } : null,
		rows: m.rows.slice(0, 500).map((r) => {
			const st = abc.get(String(r.key));
			return { ...r, abc: st ? st.abc : null, on_hand: st ? st.on_hand : null, cover_days: st ? st.cover_days : null };
		}),
	};
}

/* ─── Excel ─── */

/** Продажі для книги — з денних агрегатів (як KPI й графіки на сторінці) */
async function sales(f, idLang) {
	const ic = f.integrations ? ` AND id_integration IN (?)` : "";
	const p = [f.date_from, f.date_to, ...(f.integrations ? [f.integrations] : [])];
	const [[t]] = await pool.query(
		`SELECT SUM(orders_count) AS orders, SUM(orders_valid) AS valid, SUM(orders_canceled) AS canceled, SUM(revenue_gross_base) AS revenue,
		        SUM(refunded_base) AS refunded, SUM(fees_base) AS fees, SUM(items_qty) AS items_qty, SUM(new_clients) AS new_clients
		   FROM ${P}orders_stats_daily WHERE day BETWEEN ? AND ?${ic}`,
		p
	);
	const per = periodSql(f.granularity, "day");
	const [series] = await pool.query(
		`SELECT ${per} AS p, SUM(revenue_gross_base) AS revenue, SUM(refunded_base) AS refunded, SUM(orders_valid) AS orders
		   FROM ${P}orders_stats_daily WHERE day BETWEEN ? AND ?${ic} GROUP BY p ORDER BY p`,
		p
	);
	const [statuses] = await pool.query(
		`SELECT COALESCE(sl.text, CONCAT('#', s.id_status)) AS name, SUM(s.orders_count) AS orders, SUM(s.revenue_base) AS revenue
		   FROM ${P}orders_stats_daily_status s LEFT JOIN ${P}orders_status_lang sl ON sl.id_status = s.id_status AND sl.id_lang = ?
		  WHERE s.day BETWEEN ? AND ?${ic.replace("id_integration", "s.id_integration")} GROUP BY s.id_status, sl.text ORDER BY orders DESC`,
		[idLang, ...p]
	);
	const [channels] = await pool.query(
		`SELECT COALESCE(source_channel, '—') AS name, SUM(orders_count) AS orders, SUM(revenue_base) AS revenue
		   FROM ${P}orders_stats_daily_channel WHERE day BETWEEN ? AND ?${ic} GROUP BY name ORDER BY revenue DESC`,
		p
	);
	const revenue = n(t.revenue);
	return {
		total: {
			orders: n(t.orders),
			valid: n(t.valid),
			canceled: n(t.canceled),
			revenue: r2(revenue),
			refunded: r2(t.refunded),
			net_revenue: r2(revenue - n(t.refunded) - n(t.fees)),
			avg_check: n(t.valid) ? r2(revenue / n(t.valid)) : 0,
			items_qty: n(t.items_qty),
			new_clients: n(t.new_clients),
		},
		series: series.map((r) => ({ p: dayStr(r.p), revenue: r2(r.revenue), refunded: r2(r.refunded), orders: n(r.orders) })),
		statuses: statuses.map((r) => ({ name: r.name, orders: n(r.orders), revenue: r2(r.revenue) })),
		channels: channels.map((r) => ({ name: r.name, orders: n(r.orders), revenue: r2(r.revenue) })),
	};
}

/**
 * Книга з усіма розділами. labels — заголовки мовою користувача: { sheets: {…}, cols: {…} }.
 */
async function workbook(f, idLang, labels) {
	const ExcelJS = require("exceljs");
	const wb = new ExcelJS.Workbook();
	wb.creator = "Growth contour";
	wb.created = new Date();
	const L = labels.cols;
	const sheet = (name, cols, rows) => {
		const ws = wb.addWorksheet(String(name).slice(0, 31));
		ws.columns = cols.map(([key, title, width, fmt]) => ({ key, header: title, width: width || 16, style: fmt ? { numFmt: fmt } : {} }));
		ws.getRow(1).font = { bold: true };
		ws.views = [{ state: "frozen", ySplit: 1 }];
		rows.forEach((r) => ws.addRow(r));
		ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
		return ws;
	};
	const MONEY = "#,##0.00";

	const [sl, dl, cl, mg, rt, au, pr] = await Promise.all([sales(f, idLang), delivery(f), clients(f), managers(f), returns(f), automation(f), products(f, "product", idLang)]);

	// Підсумок
	const s = sl.total;
	sheet(labels.sheets.summary, [["k", L.metric, 36], ["v", L.value, 18, MONEY]], [
		{ k: L.period, v: `${f.date_from} — ${f.date_to}` },
		{ k: L.orders, v: s.orders },
		{ k: L.valid, v: s.valid },
		{ k: L.canceled, v: s.canceled },
		{ k: L.revenue, v: s.revenue },
		{ k: L.net_revenue, v: s.net_revenue },
		{ k: L.refunded, v: s.refunded },
		{ k: L.avg_check, v: s.avg_check },
		{ k: L.items_qty, v: s.items_qty },
		{ k: L.new_clients, v: s.new_clients },
		{ k: L.buyout + ", %", v: dl.total.buyout },
		{ k: L.repeat_rate + ", %", v: cl.total.repeat_rate },
		{ k: L.returns, v: rt.total.requests },
	]);
	sheet(labels.sheets.sales, [["p", L.period, 14], ["revenue", L.revenue, 16, MONEY], ["refunded", L.refunded, 16, MONEY], ["orders", L.orders, 12]], sl.series);
	sheet(labels.sheets.statuses, [["name", L.status, 30], ["orders", L.orders, 12], ["revenue", L.revenue, 16, MONEY]], sl.statuses);
	sheet(labels.sheets.channels, [["name", L.channel, 24], ["orders", L.orders, 12], ["revenue", L.revenue, 16, MONEY]], sl.channels);
	sheet(labels.sheets.products, [["sku", "SKU", 18], ["label", L.product, 44], ["abc", "ABC", 6], ["qty", L.qty, 10], ["revenue", L.revenue, 16, MONEY], ["cost", L.cost, 16, MONEY], ["profit", L.profit, 16, MONEY], ["margin", L.margin + ", %", 10], ["on_hand", L.on_hand, 10], ["cover_days", L.cover_days, 12]], pr.rows);
	sheet(labels.sheets.delivery, [["city", L.city, 28], ["shipments", L.shipments, 12], ["delivered", L.delivered, 12], ["returned", L.returned, 12], ["buyout", L.buyout + ", %", 10]], dl.cities);
	sheet(labels.sheets.payments, [["payment", L.payment, 36], ["delivered", L.delivered, 12], ["returned", L.returned, 12], ["buyout", L.buyout + ", %", 10]], dl.payments);
	sheet(labels.sheets.clients, [["p", L.period, 14], ["new", L.new_clients, 14], ["returning", L.returning, 14], ["guests", L.guests, 12]], cl.series);
	sheet(labels.sheets.cohorts, [["cohort", L.cohort, 12], ["size", L.clients, 10], ...[1, 2, 3, 4, 5, 6].map((m) => ["m" + m, "+" + m, 8])],
		cl.cohorts.map((c) => ({ cohort: c.cohort, size: c.size, ...Object.fromEntries(c.months.map((v, i) => ["m" + (i + 1), v])) })));
	sheet(labels.sheets.top_clients, [["name", L.client, 30], ["phone", L.phone, 18], ["orders", L.orders, 10], ["revenue", L.revenue, 16, MONEY]], cl.top);
	sheet(labels.sheets.managers, [["name", L.manager, 28], ["orders", L.orders, 10], ["valid", L.valid, 10], ["cancel_rate", L.cancel_rate + ", %", 12], ["revenue", L.revenue, 16, MONEY], ["avg_check", L.avg_check, 14, MONEY], ["refunded", L.refunded, 14, MONEY], ["react_min", L.react_min, 14]],
		mg.rows.map((r) => ({ ...r, name: r.name || L.unassigned })));
	sheet(labels.sheets.returns, [["sku", "SKU", 18], ["name", L.product, 44], ["qty", L.qty, 10], ["defect", L.defect, 10], ["value", L.value, 16, MONEY]], rt.products);
	sheet(labels.sheets.automation, [["name", L.rule, 36], ["runs", L.runs, 10], ["ok", "OK", 10], ["partial", L.partial, 10], ["error", L.error, 10]], au.rules);
	return wb;
}

module.exports = { sales, delivery, clients, managers, heatmap, automation, returns, products, workbook };