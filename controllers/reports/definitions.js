"use strict";

/**
 * Каталог звітів. Кожен звіт:
 *   key, group, perm: [slug, action] — хто може формувати й бачити результати;
 *   scope: "orders" | "clients" — чи обмежується видимістю користувача (без orders.all / clients.all — лише свої);
 *   params: [{ name, type, … }] — поля форми (типи: period, sites, statuses, manager, number, select, bool);
 *   run(p, ctx) → { sheets: [{ key, columns: [[key, width, fmt?]], rows }] } — назви аркушів і колонок беруться з локалі.
 *
 * ctx: { idLang, idUser, scopeAll } — scopeAll: true, якщо автор бачить усі замовлення / клієнтів.
 * Важливо: звіти рахуються у фоні (jobs.js), без req — усе потрібне має бути в p і ctx.
 */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;
const MAX_ROWS = 200000; // більше в Excel не має сенсу й небезпечно для пам'яті
const NON_PRODUCT = ["shipping", "fee", "tip", "discount", "gift_card", "wrapping"];
const MONEY = "#,##0.00";
const PCT = "0.00";
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const n = (v) => Number(v) || 0;
const json = (v, d = {}) => {
	if (v && typeof v === "object") return v;
	try {
		return v ? JSON.parse(v) : d;
	} catch {
		return d;
	}
};
const fullName = (c) => [c.firstname, c.lastname].filter(Boolean).join(" ");

/* ─── Спільні фрагменти SQL ─── */

/** Замовлення періоду (o): дата, сайти, статуси, менеджер, видимість */
function orderWhere(p, ctx, { validOnly = false } = {}) {
	const w = ["o.deleted_at IS NULL", "o.date_order_day BETWEEN ? AND ?"];
	const params = [p.date_from, p.date_to];
	if (p.sites && p.sites.length) {
		w.push("COALESCE(o.id_integration, 0) IN (?)");
		params.push(p.sites);
	}
	if (p.statuses && p.statuses.length) {
		w.push("o.status IN (?)");
		params.push(p.statuses);
	}
	if (p.manager) {
		w.push("o.id_user = ?");
		params.push(p.manager);
	}
	if (validOnly) w.push("st.is_negative = 0");
	if (!ctx.scopeAll) {
		w.push("(o.id_user = ? OR o.id_user IS NULL)");
		params.push(ctx.idUser);
	}
	return { sql: w.join(" AND "), params };
}

/** Видимість клієнтів (c) без clients.all */
function clientScope(ctx) {
	return ctx.scopeAll ? { sql: "", params: [] } : { sql: " AND (c.id_manager = ? OR c.id_manager IS NULL)", params: [ctx.idUser] };
}

async function contactTypes() {
	const dict = require("../clients/dictionaries");
	return { phone: await dict.idOf("contact_types", "phone"), email: await dict.idOf("contact_types", "email") };
}

/* ─── Звіти ─── */

const PERIOD = { name: "period", type: "period", required: true };
const SITES = { name: "sites", type: "sites" };

const REPORTS = [
	/* ─── Продажі ─── */
	{
		key: "sales_daily",
		group: "sales",
		perm: ["analytics", "view"],
		params: [PERIOD, SITES, { name: "granularity", type: "select", options: ["day", "week", "month"], default: "day" }, { name: "by_site", type: "bool" }],
		async run(p) {
			const per = p.granularity === "month" ? "DATE_FORMAT(s.day, '%Y-%m-01')" : p.granularity === "week" ? "DATE_SUB(s.day, INTERVAL WEEKDAY(s.day) DAY)" : "s.day";
			const ic = p.sites && p.sites.length ? " AND s.id_integration IN (?)" : "";
			const [rows] = await pool.query(
				`SELECT ${per} AS period, ${p.by_site ? "COALESCE(i.name, CONCAT('#', s.id_integration))" : "''"} AS site,
				        SUM(s.orders_count) AS orders, SUM(s.orders_valid) AS valid, SUM(s.orders_canceled) AS canceled,
				        SUM(s.revenue_gross_base) AS revenue, SUM(s.refunded_base) AS refunded, SUM(s.fees_base) AS fees,
				        SUM(s.discount_base) AS discount, SUM(s.shipping_base) AS shipping, SUM(s.items_qty) AS items_qty, SUM(s.new_clients) AS new_clients
				   FROM ${P}orders_stats_daily s LEFT JOIN ${P}settings_integrations i ON i.id = s.id_integration
				  WHERE s.day BETWEEN ? AND ?${ic}
				  GROUP BY period, site ORDER BY period, site`,
				[p.date_from, p.date_to, ...(ic ? [p.sites] : [])]
			);
			return {
				sheets: [
					{
						key: "sales",
						columns: [["period", 12], ...(p.by_site ? [["site", 24]] : []), ["orders", 10], ["valid", 10], ["canceled", 10], ["cancel_rate", 10, PCT], ["revenue", 16, MONEY], ["refunded", 14, MONEY], ["fees", 12, MONEY], ["net_revenue", 16, MONEY], ["avg_check", 12, MONEY], ["discount", 12, MONEY], ["shipping", 12, MONEY], ["items_qty", 10], ["new_clients", 10]],
						rows: rows.map((r) => ({
							...r,
							orders: n(r.orders),
							valid: n(r.valid),
							canceled: n(r.canceled),
							cancel_rate: n(r.orders) ? r2((n(r.canceled) / n(r.orders)) * 100) : 0,
							revenue: r2(r.revenue),
							refunded: r2(r.refunded),
							fees: r2(r.fees),
							net_revenue: r2(n(r.revenue) - n(r.refunded) - n(r.fees)),
							avg_check: n(r.valid) ? r2(n(r.revenue) / n(r.valid)) : 0,
							discount: r2(r.discount),
							shipping: r2(r.shipping),
							items_qty: n(r.items_qty),
							new_clients: n(r.new_clients),
						})),
						totals: ["orders", "valid", "canceled", "revenue", "refunded", "fees", "net_revenue", "discount", "shipping", "items_qty", "new_clients"],
					},
				],
			};
		},
	},
	{
		key: "orders_register",
		group: "sales",
		perm: ["orders.list", "view"],
		scope: "orders",
		params: [PERIOD, SITES, { name: "statuses", type: "statuses" }, { name: "manager", type: "manager" }],
		async run(p, ctx) {
			const w = orderWhere(p, ctx);
			const [rows] = await pool.query(
				`SELECT o.id, o.reference, o.date_order, o.date_add, o.client, o.custom_fields, o.total, o.total_paid, o.total_refunded, o.currency_iso, o.source_channel,
				        o.financial_status, o.fulfillment_status, i.name AS site, sl.text AS status_name,
				        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS manager,
				        a.city, a.warehouse, a.address_1,
				        (SELECT COALESCE(SUM(it.quantity), 0) FROM ${P}orders_items it WHERE it.id_order = o.id AND COALESCE(it.type, 'product') NOT IN (?)) AS items_qty,
				        (SELECT GROUP_CONCAT(s.tracking_number SEPARATOR ', ') FROM ${P}orders_shipments s WHERE s.id_order = o.id AND s.tracking_number IS NOT NULL) AS ttn
				   FROM ${P}orders o
				   LEFT JOIN ${P}settings_integrations i ON i.id = o.id_integration
				   LEFT JOIN ${P}orders_status_lang sl ON sl.id_status = o.status AND sl.id_lang = ?
				   LEFT JOIN ${P}users u ON u.id = o.id_user
				   LEFT JOIN ${P}orders_addresses a ON a.id = (SELECT MIN(x.id) FROM ${P}orders_addresses x WHERE x.id_order = o.id AND x.type = 'shipping')
				  WHERE ${w.sql}
				  ORDER BY o.date_order_day, o.id LIMIT ${MAX_ROWS}`,
				[NON_PRODUCT, ctx.idLang, ...w.params]
			);
			return {
				sheets: [
					{
						key: "orders",
						columns: [["reference", 16], ["date", 18], ["site", 18], ["status", 20], ["client", 26], ["phone", 16], ["email", 24], ["city", 18], ["warehouse", 30], ["delivery", 22], ["payment", 22], ["items_qty", 8], ["total", 12, MONEY], ["paid", 12, MONEY], ["refunded", 12, MONEY], ["currency", 6], ["manager", 20], ["ttn", 18], ["channel", 10]],
						rows: rows.map((r) => {
							const c = json(r.client);
							const cf = json(r.custom_fields);
							return {
								reference: r.reference,
								date: r.date_order || r.date_add,
								site: r.site || "",
								status: r.status_name || "",
								client: fullName(c),
								phone: c.phone || "",
								email: c.email || "",
								city: r.city || "",
								warehouse: r.warehouse || r.address_1 || "",
								delivery: cf._delivery_method || "",
								payment: cf._payment_method || "",
								items_qty: n(r.items_qty),
								total: r2(r.total),
								paid: r2(r.total_paid),
								refunded: r2(r.total_refunded),
								currency: r.currency_iso,
								manager: r.manager || "",
								ttn: r.ttn || "",
								channel: r.source_channel || "",
							};
						}),
						totals: ["items_qty", "total", "paid", "refunded"],
					},
				],
			};
		},
	},
	{
		key: "order_items",
		group: "sales",
		perm: ["orders.list", "view"],
		scope: "orders",
		params: [PERIOD, SITES, { name: "statuses", type: "statuses" }, { name: "valid_only", type: "bool", default: true }],
		async run(p, ctx) {
			const w = orderWhere(p, ctx, { validOnly: p.valid_only });
			const [rows] = await pool.query(
				`SELECT o.reference, o.date_order_day AS day, i.name AS site, sl.text AS status_name, it.sku, it.name, it.quantity, it.unit_price, it.discount, it.total, o.currency_iso
				   FROM ${P}orders_items it
				   JOIN ${P}orders o ON o.id = it.id_order
				   JOIN ${P}orders_status st ON st.id = o.status
				   LEFT JOIN ${P}settings_integrations i ON i.id = o.id_integration
				   LEFT JOIN ${P}orders_status_lang sl ON sl.id_status = o.status AND sl.id_lang = ?
				  WHERE ${w.sql} AND COALESCE(it.type, 'product') NOT IN (?)
				  ORDER BY o.date_order_day, o.id, it.id LIMIT ${MAX_ROWS}`,
				[ctx.idLang, ...w.params, NON_PRODUCT]
			);
			return {
				sheets: [
					{
						key: "items",
						columns: [["reference", 16], ["day", 12], ["site", 18], ["status", 20], ["sku", 18], ["product", 44], ["qty", 8], ["unit_price", 12, MONEY], ["discount", 12, MONEY], ["total", 12, MONEY], ["currency", 6]],
						rows: rows.map((r) => ({ reference: r.reference, day: r.day, site: r.site || "", status: r.status_name || "", sku: r.sku || "", product: r.name, qty: n(r.quantity), unit_price: r2(r.unit_price), discount: r2(r.discount), total: r2(r.total), currency: r.currency_iso })),
						totals: ["qty", "discount", "total"],
					},
				],
			};
		},
	},

	/* ─── Товари ─── */
	{
		key: "products_top",
		group: "products",
		perm: ["products.list", "view"],
		params: [PERIOD, SITES, { name: "sort", type: "select", options: ["qty", "revenue", "orders", "clients"], default: "qty" }, { name: "limit", type: "number", min: 10, max: 10000, default: 500 }],
		async run(p, ctx) {
			const w = orderWhere(p, { ...ctx, scopeAll: true }, { validOnly: true });
			const order = { qty: "qty", revenue: "revenue", orders: "orders", clients: "clients" }[p.sort] || "qty";
			const [rows] = await pool.query(
				`SELECT COALESCE(it.id_product, 0) AS id_product, COALESCE(it.id_variant, 0) AS id_variant, MAX(it.sku) AS sku, MAX(it.name) AS name,
				        COUNT(DISTINCT o.id) AS orders, COUNT(DISTINCT o.id_client) AS clients, SUM(it.quantity) AS qty,
				        SUM(it.total * o.currency_rate) AS revenue, MIN(it.unit_price) AS min_price, MAX(it.unit_price) AS max_price
				   FROM ${P}orders_items it
				   JOIN ${P}orders o ON o.id = it.id_order
				   JOIN ${P}orders_status st ON st.id = o.status
				  WHERE ${w.sql} AND COALESCE(it.type, 'product') NOT IN (?)
				  GROUP BY id_product, id_variant, IF(it.id_product IS NULL, it.sku, '')
				  ORDER BY ${order} DESC LIMIT ?`,
				[...w.params, NON_PRODUCT, p.limit]
			);
			const totalRevenue = rows.reduce((s, r) => s + n(r.revenue), 0);
			const totalQty = rows.reduce((s, r) => s + n(r.qty), 0);
			let acc = 0;
			return {
				sheets: [
					{
						key: "products",
						columns: [["rank", 6], ["sku", 18], ["product", 44], ["orders", 10], ["clients", 10], ["qty", 10], ["revenue", 16, MONEY], ["avg_price", 12, MONEY], ["min_price", 12, MONEY], ["max_price", 12, MONEY], ["share_qty", 10, PCT], ["share_revenue", 10, PCT], ["abc", 6]],
						rows: rows.map((r, i) => {
							acc += n(r.revenue);
							return {
								rank: i + 1,
								sku: r.sku || "",
								product: r.name,
								orders: n(r.orders),
								clients: n(r.clients),
								qty: n(r.qty),
								revenue: r2(r.revenue),
								avg_price: n(r.qty) ? r2(n(r.revenue) / n(r.qty)) : 0,
								min_price: r2(r.min_price),
								max_price: r2(r.max_price),
								share_qty: totalQty ? r2((n(r.qty) / totalQty) * 100) : 0,
								share_revenue: totalRevenue ? r2((n(r.revenue) / totalRevenue) * 100) : 0,
								abc: p.sort === "revenue" && totalRevenue ? (acc / totalRevenue <= 0.8 ? "A" : acc / totalRevenue <= 0.95 ? "B" : "C") : "",
							};
						}),
						totals: ["qty", "revenue"],
					},
				],
			};
		},
	},
	{
		key: "products_pairs",
		group: "products",
		perm: ["products.list", "view"],
		params: [PERIOD, SITES, { name: "min_orders", type: "number", min: 2, max: 1000, default: 3 }],
		async run(p, ctx) {
			const w = orderWhere(p, { ...ctx, scopeAll: true }, { validOnly: true });
			// Пари товарів в одному замовленні: «разом купили N разів»; support — частка замовлень з парою, confidence — P(B | A)
			const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${P}orders o JOIN ${P}orders_status st ON st.id = o.status WHERE ${w.sql}`, w.params);
			const [rows] = await pool.query(
				`WITH li AS (
				   SELECT DISTINCT it.id_order, COALESCE(NULLIF(it.sku, ''), it.name) AS k, it.name
				     FROM ${P}orders_items it JOIN ${P}orders o ON o.id = it.id_order JOIN ${P}orders_status st ON st.id = o.status
				    WHERE ${w.sql} AND COALESCE(it.type, 'product') NOT IN (?)
				 ), cnt AS (SELECT k, COUNT(*) AS c FROM li GROUP BY k)
				 SELECT a.k AS a_key, MAX(a.name) AS a_name, b.k AS b_key, MAX(b.name) AS b_name, COUNT(*) AS together, MAX(ca.c) AS a_orders, MAX(cb.c) AS b_orders
				   FROM li a JOIN li b ON b.id_order = a.id_order AND b.k > a.k
				   JOIN cnt ca ON ca.k = a.k JOIN cnt cb ON cb.k = b.k
				  GROUP BY a.k, b.k HAVING together >= ?
				  ORDER BY together DESC LIMIT 5000`,
				[...w.params, NON_PRODUCT, p.min_orders]
			);
			return {
				sheets: [
					{
						key: "pairs",
						columns: [["sku_a", 18], ["product_a", 40], ["sku_b", 18], ["product_b", 40], ["together", 10], ["support", 10, PCT], ["conf_ab", 10, PCT], ["conf_ba", 10, PCT]],
						rows: rows.map((r) => ({
							sku_a: r.a_key,
							product_a: r.a_name,
							sku_b: r.b_key,
							product_b: r.b_name,
							together: n(r.together),
							support: total ? r2((n(r.together) / n(total)) * 100) : 0,
							conf_ab: n(r.a_orders) ? r2((n(r.together) / n(r.a_orders)) * 100) : 0,
							conf_ba: n(r.b_orders) ? r2((n(r.together) / n(r.b_orders)) * 100) : 0,
						})),
					},
				],
			};
		},
	},
	{
		key: "products_margin",
		group: "products",
		perm: ["products.cost", "view"],
		params: [PERIOD, { name: "site", type: "site" }, { name: "group_by", type: "select", options: ["product", "category", "brand", "site", "month"], default: "product" }],
		async run(p, ctx) {
			const m = await require("../catalog/products/reports").margin({ date_from: p.date_from, date_to: p.date_to, id_integration: p.site || "", group: p.group_by }, ctx.idLang);
			return {
				sheets: [
					{
						key: "margin",
						columns: [["label", 44], ["sku", 18], ["qty", 10], ["revenue", 16, MONEY], ["cost", 16, MONEY], ["profit", 16, MONEY], ["margin", 10, PCT], ["no_cost", 10], ["estimated", 10]],
						rows: m.rows.map((r) => ({ ...r, label: r.label || String(r.key), sku: r.sku || "" })),
						totals: ["qty", "revenue", "cost", "profit"],
					},
				],
			};
		},
	},
	{
		key: "stock_turnover",
		group: "products",
		perm: ["products.stock", "view"],
		params: [PERIOD, { name: "site", type: "site" }, { name: "view", type: "select", options: ["all", "dead"], default: "all" }],
		async run(p, ctx) {
			const s = await require("../catalog/products/reports").stock({ date_from: p.date_from, date_to: p.date_to, id_integration: p.site || "", view: p.view }, ctx.idLang);
			return {
				sheets: [
					{
						key: "stock",
						columns: [["sku", 18], ["product", 44], ["abc", 6], ["on_hand", 10], ["sold", 10], ["revenue", 16, MONEY], ["cost_price", 12, MONEY], ["stock_value", 16, MONEY], ["cover_days", 12], ["turnover", 10, PCT], ["dead", 8]],
						rows: s.rows.map((r) => ({ sku: r.sku || "", product: r.name || "", abc: r.abc, on_hand: r.on_hand, sold: r.sold, revenue: r.revenue, cost_price: r.cost, stock_value: r.stock_value, cover_days: r.cover_days, turnover: r.turnover, dead: r.dead ? "✓" : "" })),
						totals: ["on_hand", "sold", "revenue", "stock_value"],
					},
				],
			};
		},
	},
	{
		key: "stock_receipts",
		group: "products",
		perm: ["products.stock", "view"],
		params: [PERIOD, { name: "doc_type", type: "select", options: ["receipt", "return", "writeoff", "transfer", "inventory", "adjustment", "all"], default: "receipt" }],
		async run(p) {
			const types = p.doc_type === "all" ? null : [p.doc_type];
			const [rows] = await pool.query(
				`SELECT d.number, d.type, d.status, d.external_number, d.currency, d.date_document, d.date_posted,
				        w.name AS warehouse, s.name AS supplier,
				        COUNT(it.id) AS lines, COALESCE(SUM(it.qty), 0) AS qty, COALESCE(SUM(it.qty * it.cost_price), 0) AS amount,
				        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS author
				   FROM ${P}products_stock_documents d
				   LEFT JOIN ${P}products_stock_documents_items it ON it.id_document = d.id
				   LEFT JOIN ${P}products_warehouses w ON w.id = d.id_warehouse
				   LEFT JOIN ${P}products_suppliers s ON s.id = d.id_supplier
				   LEFT JOIN ${P}users u ON u.id = d.id_user_add
				  WHERE DATE(COALESCE(d.date_document, d.date_add)) BETWEEN ? AND ?${types ? " AND d.type IN (?)" : ""}
				  GROUP BY d.id ORDER BY d.date_document, d.id LIMIT ${MAX_ROWS}`,
				[p.date_from, p.date_to, ...(types ? [types] : [])]
			);
			return {
				sheets: [
					{
						key: "documents",
						columns: [["number", 16], ["doc_type", 12], ["state", 10], ["date", 18], ["posted", 18], ["supplier", 26], ["external_number", 16], ["warehouse", 20], ["lines", 8], ["qty", 10], ["amount", 16, MONEY], ["currency", 6], ["author", 20]],
						rows: rows.map((r) => ({ number: r.number, doc_type: r.type, state: r.status, date: r.date_document, posted: r.date_posted || "", supplier: r.supplier || "", external_number: r.external_number || "", warehouse: r.warehouse || "", lines: n(r.lines), qty: n(r.qty), amount: r2(r.amount), currency: r.currency || "", author: r.author || "" })),
						totals: ["lines", "qty", "amount"],
					},
				],
			};
		},
	},

	/* ─── Клієнти ─── */
	{
		key: "clients_base",
		group: "clients",
		perm: ["clients.list", "view"],
		scope: "clients",
		params: [{ name: "min_orders", type: "number", min: 0, max: 1000, default: 1 }, { name: "segment", type: "select", options: ["all", "champions", "loyal", "new", "potential", "cant_lose", "at_risk", "need_attention", "hibernating", "lost"], default: "all" }],
		async run(p, ctx) {
			const t = await contactTypes();
			const sc = clientScope(ctx);
			const [rows] = await pool.query(
				`SELECT c.id, c.display_name, st.orders_count, st.orders_valid_count, st.revenue_base, st.avg_order_base, st.first_order_at, st.last_order_at, st.rfm_segment,
				        DATEDIFF(NOW(), st.last_order_at) AS days_since,
				        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS manager,
				        (SELECT cp.value_normalized FROM ${P}clients_contact_points cp WHERE cp.id_client = c.id AND cp.id_contact_type = ? ORDER BY cp.is_primary DESC, cp.id LIMIT 1) AS phone,
				        (SELECT cp.value_normalized FROM ${P}clients_contact_points cp WHERE cp.id_client = c.id AND cp.id_contact_type = ? ORDER BY cp.is_primary DESC, cp.id LIMIT 1) AS email
				   FROM ${P}clients c
				   LEFT JOIN ${P}clients_stats st ON st.id_client = c.id
				   LEFT JOIN ${P}users u ON u.id = c.id_manager
				  WHERE c.deleted_at IS NULL AND c.id_merged_into IS NULL AND COALESCE(st.orders_valid_count, 0) >= ?${p.segment !== "all" ? " AND st.rfm_segment = ?" : ""}${sc.sql}
				  ORDER BY st.revenue_base DESC LIMIT ${MAX_ROWS}`,
				[t.phone, t.email, p.min_orders, ...(p.segment !== "all" ? [p.segment] : []), ...sc.params]
			);
			return {
				sheets: [
					{
						key: "clients",
						columns: [["id", 8], ["client", 30], ["phone", 16], ["email", 26], ["segment", 14], ["orders", 8], ["valid", 8], ["revenue", 16, MONEY], ["avg_check", 12, MONEY], ["first_order", 18], ["last_order", 18], ["days_since", 10], ["manager", 20]],
						rows: rows.map((r) => ({ id: r.id, client: r.display_name || "", phone: r.phone || "", email: r.email || "", segment: r.rfm_segment || "", orders: n(r.orders_count), valid: n(r.orders_valid_count), revenue: r2(r.revenue_base), avg_check: r2(r.avg_order_base), first_order: r.first_order_at || "", last_order: r.last_order_at || "", days_since: r.days_since === null ? "" : n(r.days_since), manager: r.manager || "" })),
						totals: ["orders", "valid", "revenue"],
					},
				],
			};
		},
	},
	{
		key: "clients_sleeping",
		group: "clients",
		perm: ["clients.list", "view"],
		scope: "clients",
		params: [{ name: "days", type: "number", min: 7, max: 3650, default: 90 }, { name: "min_orders", type: "number", min: 1, max: 1000, default: 2 }],
		async run(p, ctx) {
			const t = await contactTypes();
			const sc = clientScope(ctx);
			// Купували щонайменше min_orders разів, але не купували days днів — список для повернення клієнтів
			const [rows] = await pool.query(
				`SELECT c.id, c.display_name, st.orders_valid_count, st.revenue_base, st.avg_order_base, st.last_order_at, DATEDIFF(NOW(), st.last_order_at) AS days_since,
				        (SELECT cp.value_normalized FROM ${P}clients_contact_points cp WHERE cp.id_client = c.id AND cp.id_contact_type = ? ORDER BY cp.is_primary DESC, cp.id LIMIT 1) AS phone,
				        (SELECT cp.value_normalized FROM ${P}clients_contact_points cp WHERE cp.id_client = c.id AND cp.id_contact_type = ? ORDER BY cp.is_primary DESC, cp.id LIMIT 1) AS email
				   FROM ${P}clients c JOIN ${P}clients_stats st ON st.id_client = c.id
				  WHERE c.deleted_at IS NULL AND c.id_merged_into IS NULL AND st.orders_valid_count >= ? AND st.last_order_at < NOW() - INTERVAL ? DAY${sc.sql}
				  ORDER BY st.revenue_base DESC LIMIT ${MAX_ROWS}`,
				[t.phone, t.email, p.min_orders, p.days, ...sc.params]
			);
			return {
				sheets: [
					{
						key: "clients",
						columns: [["id", 8], ["client", 30], ["phone", 16], ["email", 26], ["valid", 8], ["revenue", 16, MONEY], ["avg_check", 12, MONEY], ["last_order", 18], ["days_since", 10]],
						rows: rows.map((r) => ({ id: r.id, client: r.display_name || "", phone: r.phone || "", email: r.email || "", valid: n(r.orders_valid_count), revenue: r2(r.revenue_base), avg_check: r2(r.avg_order_base), last_order: r.last_order_at || "", days_since: n(r.days_since) })),
						totals: ["valid", "revenue"],
					},
				],
			};
		},
	},

	/* ─── Команда й логістика ─── */
	{
		key: "managers",
		group: "team",
		perm: ["orders.all", "view"],
		params: [PERIOD, SITES],
		async run(p) {
			const r = await require("../analytics/reports").managers({ date_from: p.date_from, date_to: p.date_to, integrations: p.sites && p.sites.length ? p.sites : null });
			return {
				sheets: [
					{
						key: "managers",
						columns: [["manager", 26], ["orders", 10], ["valid", 10], ["canceled", 10], ["cancel_rate", 10, PCT], ["revenue", 16, MONEY], ["avg_check", 12, MONEY], ["refunded", 14, MONEY], ["react_min", 12]],
						rows: r.rows.map((x) => ({ ...x, manager: x.name || "—", react_min: x.react_min === null ? "" : x.react_min })),
						totals: ["orders", "valid", "canceled", "revenue", "refunded"],
					},
				],
			};
		},
	},
	{
		key: "delivery_buyout",
		group: "team",
		perm: ["orders.list", "view"],
		params: [PERIOD, SITES],
		async run(p) {
			const d = await require("../analytics/reports").delivery({ date_from: p.date_from, date_to: p.date_to, integrations: p.sites && p.sites.length ? p.sites : null, granularity: "day" });
			return {
				sheets: [
					{ key: "cities", columns: [["city", 28], ["shipments", 10], ["delivered", 10], ["returned", 10], ["buyout", 10, PCT]], rows: d.cities, totals: ["shipments", "delivered", "returned"] },
					{ key: "payments", columns: [["payment", 36], ["delivered", 10], ["returned", 10], ["buyout", 10, PCT]], rows: d.payments, totals: ["delivered", "returned"] },
					{ key: "by_day", columns: [["day", 12], ["delivered", 10], ["returned", 10], ["in_transit", 10]], rows: d.series.map((x) => ({ day: x.p, delivered: x.delivered, returned: x.returned, in_transit: x.in_transit })), totals: ["delivered", "returned", "in_transit"] },
				],
			};
		},
	},
	{
		key: "returns_register",
		group: "team",
		perm: ["orders.list", "view"],
		scope: "orders",
		params: [PERIOD, { name: "type", type: "select", options: ["all", "return", "exchange"], default: "all" }],
		async run(p, ctx) {
			const sc = ctx.scopeAll ? "" : " AND (o.id_user = ? OR o.id_user IS NULL)";
			const [rows] = await pool.query(
				`SELECT r.number, r.type, r.status, r.reason, r.items, r.amount, r.amount_due, r.ttn, r.date_add, r.date_edit, o.reference, x.reference AS exchange_reference,
				        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS author
				   FROM ${P}orders_returns r JOIN ${P}orders o ON o.id = r.id_order AND o.deleted_at IS NULL
				   LEFT JOIN ${P}orders x ON x.id = r.id_exchange_order LEFT JOIN ${P}users u ON u.id = r.id_user
				  WHERE r.date_add >= ? AND r.date_add < ? + INTERVAL 1 DAY${p.type !== "all" ? " AND r.type = ?" : ""}${sc}
				  ORDER BY r.id LIMIT ${MAX_ROWS}`,
				[p.date_from, p.date_to, ...(p.type !== "all" ? [p.type] : []), ...(sc ? [ctx.idUser] : [])]
			);
			const out = [];
			for (const r of rows) {
				for (const it of json(r.items, [])) {
					out.push({ number: r.number, order: r.reference, rma_type: r.type, state: r.status, reason: r.reason, sku: it.sku || "", product: it.name || "", qty: n(it.qty), value: r2(n(it.qty) * n(it.unit)), condition: it.condition || "", refunded: r2(r.amount), due: r2(r.amount_due), exchange: r.exchange_reference || "", ttn: r.ttn || "", date: r.date_add, author: r.author || "" });
				}
			}
			return {
				sheets: [
					{
						key: "returns",
						columns: [["number", 16], ["order", 14], ["rma_type", 10], ["state", 12], ["reason", 16], ["sku", 16], ["product", 40], ["qty", 8], ["value", 12, MONEY], ["condition", 10], ["refunded", 12, MONEY], ["due", 12, MONEY], ["exchange", 14], ["ttn", 18], ["date", 18], ["author", 20]],
						rows: out,
						totals: ["qty", "value"],
					},
				],
			};
		},
	},
	{
		key: "abandoned_carts",
		group: "team",
		perm: ["orders.abandoned", "view"],
		params: [PERIOD, SITES, { name: "cart_status", type: "select", options: ["all", "active", "recovered", "lost"], default: "all" }],
		async run(p) {
			const ic = p.sites && p.sites.length ? " AND a.id_integration IN (?)" : "";
			const sc = p.cart_status === "all" ? "" : p.cart_status === "lost" ? " AND a.status NOT IN ('active', 'recovered')" : " AND a.status = ?";
			const [rows] = await pool.query(
				`SELECT a.id, a.first_seen_at, a.last_activity_at, a.email, a.currency, a.total_amount, a.items_count, a.status, a.utm_source, a.utm_medium, a.utm_campaign, a.cart, i.name AS site
				   FROM ${P}orders_abandoned_cart a LEFT JOIN ${P}settings_integrations i ON i.id = a.id_integration
				  WHERE a.first_seen_at >= ? AND a.first_seen_at < ? + INTERVAL 1 DAY${ic}${sc}
				  ORDER BY a.first_seen_at LIMIT ${MAX_ROWS}`,
				[p.date_from, p.date_to, ...(ic ? [p.sites] : []), ...(sc.includes("?") ? [p.cart_status] : [])]
			);
			return {
				sheets: [
					{
						key: "carts",
						columns: [["date", 18], ["last_activity", 18], ["site", 18], ["client", 24], ["phone", 16], ["email", 26], ["items_qty", 8], ["total", 12, MONEY], ["currency", 6], ["state", 12], ["utm_source", 14], ["utm_medium", 14], ["utm_campaign", 18]],
						rows: rows.map((r) => {
							const c = json(r.cart).customer || json(r.cart).client || {};
							return { date: r.first_seen_at, last_activity: r.last_activity_at, site: r.site || "", client: fullName(c), phone: c.phone || c.telephone || "", email: r.email || c.email || "", items_qty: n(r.items_count), total: r2(r.total_amount), currency: r.currency || "", state: r.status, utm_source: r.utm_source || "", utm_medium: r.utm_medium || "", utm_campaign: r.utm_campaign || "" };
						}),
						totals: ["items_qty", "total"],
					},
				],
			};
		},
	},
];

const BY_KEY = new Map(REPORTS.map((r) => [r.key, r]));
const GROUPS = ["sales", "products", "clients", "team"];

/* ─── Параметри ─── */

const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const ints = (v) => [...new Set((Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x >= 0))].slice(0, 100);

/**
 * Значення форми → чисті параметри звіту (лише відомі поля, у межах). Помилка — { field, message }.
 * Період — не довше 2 років.
 */
function parseParams(def, raw) {
	const b = raw || {};
	const out = {};
	for (const f of def.params) {
		if (f.type === "period") {
			let from = b.date_from;
			let to = b.date_to;
			if (!isDay(from) || !isDay(to)) throw Object.assign(new Error("Validation failed"), { status: 400, errors: [{ field: "period", message: "required" }] });
			if (from > to) [from, to] = [to, from];
			if ((Date.parse(to) - Date.parse(from)) / 86400000 > 731) throw Object.assign(new Error("Validation failed"), { status: 400, errors: [{ field: "period", message: "max 2 years" }] });
			out.date_from = from;
			out.date_to = to;
		} else if (f.type === "sites" || f.type === "statuses") {
			out[f.name] = ints(b[f.name]);
		} else if (f.type === "site" || f.type === "manager") {
			out[f.name] = ints(b[f.name])[0] || null;
		} else if (f.type === "number") {
			const v = parseInt(b[f.name], 10);
			out[f.name] = Number.isInteger(v) ? Math.min(f.max, Math.max(f.min, v)) : f.default;
		} else if (f.type === "select") {
			out[f.name] = f.options.includes(b[f.name]) ? b[f.name] : f.default;
		} else if (f.type === "bool") {
			const v = b[f.name];
			out[f.name] = v === undefined ? !!f.default : v === true || v === "true" || v === "1" || v === 1 || v === "on";
		}
	}
	return out;
}

module.exports = { REPORTS, BY_KEY, GROUPS, parseParams, MAX_ROWS };