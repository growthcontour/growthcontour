"use strict";

/**
 * Заявки на повернення й обмін (RMA).
 *
 * Заявка створюється із замовлення: позиції й кількість, причина (довідник REASONS), коментар, тип (return / exchange).
 * Шлях заявки: new → awaiting (чекаємо посилку, ТТН клієнта) → received (товар отримано) → checked (стан кожної позиції: ok / defect)
 *              → refunded (кошти повернено) | exchanged (створено замовлення-обмін) | rejected (відмова) → closed.
 *              Скасувати (canceled) можна, доки нічого не повернено.
 *
 * Гроші й склад — через наявний механізм повернень (refunds.create) в одній транзакції із заявкою:
 *   позиції «ok» повертаються на склад (рух «return»), «defect» — ні (лишаються списаними, видно в заявці як брак).
 * Обмін: сума повернених позицій зараховується як оплата нового замовлення (джерело «Custom»);
 *   нове дорожче — клієнт доплачує різницю (amount_due), дешевше — різниця повертається клієнту (amount).
 *
 * Позиції зберігаються з товаром каталогу (id_product / id_variant / sku), бо рядки orders_items сайт перезаписує з новими id.
 */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const refunds = require("./refunds");

const P = config.get("configDatabase").prefix;
const REASONS = ["size", "defect", "not_as_described", "wrong_item", "damaged", "changed_mind", "other"];
const TYPES = ["return", "exchange"];
const STATUSES = ["new", "awaiting", "received", "checked", "refunded", "exchanged", "rejected", "closed", "canceled"];
// Незавершені — їхня кількість «зайнята» й не доступна для нової заявки
const ACTIVE = ["new", "awaiting", "received", "checked"];
// Ручні переходи (refunded / exchanged — лише через resolve)
const FLOW = {
	new: ["awaiting", "received", "canceled"],
	awaiting: ["received", "canceled"],
	received: ["checked", "rejected"],
	checked: ["received", "rejected"],
	refunded: ["closed"],
	exchanged: ["closed"],
	rejected: ["closed"],
};

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const r4 = (n) => Math.round(Number(n) * 10000) / 10000;
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const json = (v, d) => {
	if (v && typeof v === "object") return v;
	try {
		return v ? JSON.parse(v) : d;
	} catch {
		return d;
	}
};
const httpErr = (status, message, errors) => Object.assign(new Error(message), { status, errors });
const keyOf = (x) => (x.id_product ? `${Number(x.id_product)}:${Number(x.id_variant) || 0}` : "item:" + (x.sku || x.name || ""));

/** Кількість у незавершених заявках по товару (крім exceptId) */
async function reservedMap(db, idOrder, exceptId) {
	const [rows] = await db.query(`SELECT items FROM ${P}orders_returns WHERE id_order = ? AND status IN (?) AND id <> ?`, [idOrder, ACTIVE, exceptId || 0]);
	const m = new Map();
	for (const r of rows) for (const it of json(r.items, [])) m.set(keyOf(it), r3((m.get(keyOf(it)) || 0) + Number(it.qty)));
	return m;
}

/** Позиції для форми заявки: доступно = куплено − повернено − у відкритих заявках */
async function form(idOrder) {
	const f = await refunds.form(idOrder);
	const [rows] = await pool.query(`SELECT id, id_product, id_variant FROM ${P}orders_items WHERE id_order = ?`, [idOrder]);
	const byId = new Map(rows.map((r) => [r.id, r]));
	const left = await reservedMap(pool, idOrder);
	return {
		order: f.order,
		reasons: REASONS,
		items: f.items.map((it) => {
			const row = byId.get(it.id) || {};
			const x = { ...it, id_product: row.id_product || null, id_variant: row.id_variant || 0 };
			const k = keyOf(x);
			const take = Math.min(x.available, left.get(k) || 0);
			left.set(k, r3((left.get(k) || 0) - take));
			return { ...x, in_requests: take, available: r3(x.available - take) };
		}),
	};
}

async function event(conn, idOrder, idUser, payload) {
	await conn.query(`INSERT INTO ${P}orders_events (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, 'rma', ?, 'manual', NOW())`, [idOrder, idUser || null, JSON.stringify(payload)]);
}

const fire = (idOrder, r, status) => require("./notify").fire(idOrder, "rma", { number: r.number, status });

async function tx(fn) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const res = await fn(conn);
		await conn.commit();
		return res;
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

/** Заявки замовлення */
async function forOrder(idOrder) {
	const [rows] = await pool.query(
		`SELECT r.*, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS user_name, x.reference AS exchange_reference
		   FROM ${P}orders_returns r
		   LEFT JOIN ${P}users u ON u.id = r.id_user
		   LEFT JOIN ${P}orders x ON x.id = r.id_exchange_order
		  WHERE r.id_order = ? ORDER BY r.id DESC`,
		[idOrder]
	);
	return rows.map((r) => ({ ...r, items: json(r.items, []), flow: FLOW[r.status] || [] }));
}

/**
 * Нова заявка. body: { type, reason, comment, ttn, items: [{ id_item, qty }] }
 */
async function create(idOrder, b, idUser) {
	b = b || {};
	const type = TYPES.includes(b.type) ? b.type : "return";
	const reason = REASONS.includes(b.reason) ? b.reason : null;
	if (!reason) throw httpErr(400, "Validation failed", [{ field: "reason", message: "required" }]);
	const req = (Array.isArray(b.items) ? b.items : []).map((x) => ({ id_item: parseInt(x.id_item, 10), qty: r3(x.qty) })).filter((x) => x.id_item > 0 && x.qty > 0);
	if (!req.length) throw httpErr(400, "Validation failed", [{ field: "items", message: "nothing selected" }]);

	const res = await tx(async (conn) => {
		const [[o]] = await conn.query(`SELECT id, reference FROM ${P}orders WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [idOrder]);
		if (!o) throw httpErr(404, "Order not found");
		const f = await form(idOrder);
		const byId = new Map(f.items.map((x) => [x.id, x]));
		const used = new Map();
		const lines = req.map((x, i) => {
			const it = byId.get(x.id_item);
			if (!it) throw httpErr(400, "Validation failed", [{ field: `items.${i}.id_item`, message: "item not found" }]);
			const total = r3((used.get(x.id_item) || 0) + x.qty);
			if (total > it.available + 0.0005) throw httpErr(400, "Validation failed", [{ field: `items.${i}.qty`, message: `max ${it.available}` }]);
			used.set(x.id_item, total);
			return { id_product: it.id_product, id_variant: it.id_variant, sku: it.sku || null, name: it.name, qty: x.qty, unit: it.unit, condition: null };
		});
		const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM ${P}orders_returns WHERE id_order = ?`, [idOrder]);
		const number = `${o.reference || idOrder}-${type === "exchange" ? "X" : "V"}${Number(n) + 1}`;
		const ttn = str(b.ttn, 36) || null;
		const status = ttn ? "awaiting" : "new";
		const [ins] = await conn.query(
			`INSERT INTO ${P}orders_returns (id_order, number, type, status, reason, comment, items, ttn, id_user, date_add, date_edit)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
			[idOrder, number, type, status, reason, str(b.comment, 2000) || null, JSON.stringify(lines), ttn, idUser || null]
		);
		await event(conn, idOrder, idUser, { id_return: ins.insertId, number, type, to: status, reason, items: lines.map((l) => ({ name: l.name, qty: l.qty })) });
		return { id: ins.insertId, number, status };
	});
	fire(idOrder, res, res.status);
	return res;
}

async function lockReturn(conn, idOrder, idReturn) {
	const [[o]] = await conn.query(`SELECT id, reference, id_client, client, custom_fields, currency_iso FROM ${P}orders WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [idOrder]);
	if (!o) throw httpErr(404, "Order not found");
	const [[r]] = await conn.query(`SELECT * FROM ${P}orders_returns WHERE id = ? AND id_order = ? FOR UPDATE`, [idReturn, idOrder]);
	if (!r) throw httpErr(404, "Return not found");
	return { o, r: { ...r, items: json(r.items, []) } };
}

/**
 * Зміна заявки без грошей: статус (за FLOW), ТТН, коментар, стан позицій.
 * body: { to?, ttn?, comment?, conditions?: ['ok' | 'defect', …] (за індексом позиції) }
 * Перехід у checked вимагає стану для кожної позиції.
 */
async function update(idOrder, idReturn, b, idUser) {
	b = b || {};
	const res = await tx(async (conn) => {
		const { r } = await lockReturn(conn, idOrder, idReturn);
		const to = b.to ? String(b.to) : null;
		if (to && !(FLOW[r.status] || []).includes(to)) throw httpErr(409, "Status transition not allowed");
		const items = r.items.slice();
		if (Array.isArray(b.conditions)) {
			if (!["new", "awaiting", "received", "checked"].includes(r.status)) throw httpErr(409, "Return already resolved");
			b.conditions.forEach((c, i) => {
				if (items[i]) items[i] = { ...items[i], condition: c === "ok" || c === "defect" ? c : null };
			});
		}
		if (to === "checked" && items.some((x) => !x.condition)) throw httpErr(400, "Validation failed", [{ field: "conditions", message: "required" }]);
		const ttn = b.ttn !== undefined ? str(b.ttn, 36) || null : r.ttn;
		// ТТН у новій заявці — автоматично «чекаємо посилку»
		const status = to || (r.status === "new" && ttn && !r.ttn ? "awaiting" : r.status);
		const comment = b.comment !== undefined ? str(b.comment, 2000) || null : r.comment;
		await conn.query(`UPDATE ${P}orders_returns SET status = ?, ttn = ?, comment = ?, items = ?, date_edit = NOW() WHERE id = ?`, [status, ttn, comment, JSON.stringify(items), r.id]);
		if (status !== r.status || ttn !== r.ttn) await event(conn, idOrder, idUser, { id_return: r.id, number: r.number, from: r.status, to: status, ...(ttn !== r.ttn ? { ttn } : {}) });
		return { number: r.number, status, changed: status !== r.status };
	});
	if (res.changed) fire(idOrder, res, res.status);
	return { status: res.status };
}

/** Рядки повернення для refunds.create: товар заявки → поточні рядки замовлення (з розподілом кількості) */
async function refundLines(conn, idOrder, r) {
	const f = await refunds.form(idOrder);
	const [rows] = await conn.query(`SELECT id, id_product, id_variant FROM ${P}orders_items WHERE id_order = ?`, [idOrder]);
	const byId = new Map(rows.map((x) => [x.id, x]));
	const pool_ = f.items.map((it) => ({ ...it, ...(byId.get(it.id) ? { id_product: byId.get(it.id).id_product, id_variant: byId.get(it.id).id_variant } : {}), left: it.available }));
	const out = [];
	let value = 0;
	for (const line of r.items) {
		let need = Number(line.qty);
		for (const it of pool_) {
			if (need <= 0.0005) break;
			if (keyOf(it) !== keyOf(line) || it.left <= 0.0005) continue;
			const take = Math.min(need, it.left);
			it.left = r3(it.left - take);
			need = r3(need - take);
			out.push({ id_item: it.id, qty: take, restock: line.condition !== "defect" });
			value += take * it.unit;
		}
		if (need > 0.0005) throw httpErr(409, "Item no longer in order: " + (line.name || line.sku || ""));
	}
	return { lines: out, value: r2(value) };
}

/** Перевірка перед вирішенням: заявка перевірена (стан кожної позиції відомий) */
function assertResolvable(r) {
	if (r.status !== "checked") throw httpErr(409, "Return must be checked first");
}

/**
 * Повернути кошти: сума позицій (або вказана), + доставка; брак не повертається на склад.
 * body: { amount?, shipping?, transaction_id? }
 */
async function resolveRefund(idOrder, idReturn, b, idUser) {
	b = b || {};
	let info;
	const conn0 = await pool.getConnection();
	try {
		const { r } = await lockReturn(conn0, idOrder, idReturn);
		assertResolvable(r);
		info = { r, ...(await refundLines(conn0, idOrder, r)) };
	} finally {
		conn0.release();
	}
	const { r, lines } = info;
	const refund = await refunds.create(
		idOrder,
		{ items: lines, restock: true, amount: Number(b.amount) > 0 ? b.amount : undefined, shipping: b.shipping, reason: `${r.number} · ${r.reason}`, transaction_id: b.transaction_id },
		idUser,
		{
			inTx: async (conn, rf) => {
				const [u] = await conn.query(`UPDATE ${P}orders_returns SET status = 'refunded', id_refund = ?, amount = ?, date_edit = NOW() WHERE id = ? AND status = 'checked'`, [rf.id, rf.amount, r.id]);
				if (!u.affectedRows) throw httpErr(409, "Return changed, reload the page");
				await event(conn, idOrder, idUser, { id_return: r.id, number: r.number, from: r.status, to: "refunded", amount: rf.amount, refund: rf.number });
			},
		}
	);
	fire(idOrder, r, "refunded");
	return { refund };
}

/**
 * Обмін: нове замовлення з вибраними товарами; вартість повернених позицій — його оплата.
 * body: { items: [{ sku, name, price, quantity }], shipping? }; labels — назви підсумків і примітка мовою користувача
 */
async function resolveExchange(idOrder, idReturn, b, idUser, labels = {}) {
	b = b || {};
	const items = (Array.isArray(b.items) ? b.items : [])
		.map((it) => {
			const name = str(it.name, 255);
			const quantity = Math.max(1, Math.min(100000, parseInt(it.quantity, 10) || 1));
			const unit_price = Math.max(0, r2(it.price));
			return name ? { name, sku: str(it.sku, 120) || null, quantity, unit_price, total: r2(unit_price * quantity) } : null;
		})
		.filter(Boolean);
	if (!items.length) throw httpErr(400, "Validation failed", [{ field: "items", message: "nothing selected" }]);
	const [[source]] = await pool.query(`SELECT id FROM ${P}settings_integrations WHERE platform = 'custom' AND status = 'active' ORDER BY id LIMIT 1`);
	if (!source) throw httpErr(409, "No active Custom integration for the exchange order");

	let info;
	const conn0 = await pool.getConnection();
	try {
		const { o, r } = await lockReturn(conn0, idOrder, idReturn);
		assertResolvable(r);
		const [[addr]] = await conn0.query(`SELECT * FROM ${P}orders_addresses WHERE id_order = ? AND type = 'shipping' ORDER BY id LIMIT 1`, [idOrder]);
		info = { o, r, addr, ...(await refundLines(conn0, idOrder, r)) };
	} finally {
		conn0.release();
	}
	const { o, r, addr, lines, value } = info;
	const shipping = Math.max(0, r2(b.shipping));
	const subtotal = r2(items.reduce((s, i) => s + i.total, 0));
	const total = r2(subtotal + shipping);
	const credit = Math.min(value, total);
	const back = r2(value - credit); // клієнту повертаємо
	const due = r2(total - credit); // клієнт доплачує
	const client = json(o.client, {});
	const cf = json(o.custom_fields, {});
	let created = null;

	const refund = await refunds.create(
		idOrder,
		{ items: lines, restock: true, amount: value, reason: `${r.number} · ${r.reason}`, transaction_id: "exchange " + r.number },
		idUser,
		{
			notify: false, // сповіщення — подією заявки (rma)
			inTx: async (conn, rf) => {
				const crypto = require("crypto");
				const a = addr || {};
				const id = await require("./inboxProcessor").createOrderFromPayload(conn, {
					source: { external_id: "exc_" + crypto.randomBytes(12).toString("hex"), channel: "manual" },
					currency: { iso: o.currency_iso || undefined },
					client: { firstname: client.firstname || null, lastname: client.lastname || null, phone: client.phone || null, email: client.email || null },
					items,
					status: { financial_status: due > 0 ? "partially_paid" : "paid" },
					summary: { total_products: subtotal, total_shipping: shipping, total, total_paid: credit },
					totals: [
						{ code: "sub_total", title: labels.subtotal || "sub_total", value: subtotal },
						...(shipping ? [{ code: "shipping", title: labels.shipping || "shipping", value: shipping }] : []),
						{ code: "total", title: labels.total || "total", value: total },
					],
					payments: credit > 0 ? [{ amount: credit, status: "paid", transaction_id: "exchange " + r.number, paid_at: new Date().toISOString() }] : [],
					addresses: [
						{
							type: "shipping",
							firstname: a.firstname || client.firstname || null,
							lastname: a.lastname || client.lastname || null,
							middlename: a.middlename || null,
							phone: a.phone || client.phone || null,
							email: a.email || client.email || null,
							country: a.country || null,
							region: a.region || null,
							city: a.city || null,
							city_ref: a.city_ref || null,
							address_1: a.address_1 || null,
							address_2: a.address_2 || null,
							warehouse: a.warehouse || null,
							warehouse_ref: a.warehouse_ref || null,
							postcode: a.postcode || null,
							meta: json(a.meta, null),
						},
					],
					delivery: { method_title: cf._delivery_method || null },
					payment: { method_title: cf._payment_method || null },
					custom_fields: { _exchange_of: o.reference || String(o.id), _exchange_return: r.number },
					note: [labels.note ? labels.note.replace("{number}", r.number).replace("{order}", o.reference || o.id) : r.number, due > 0 && labels.due ? `${labels.due}: ${due.toFixed(2)}` : ""].filter(Boolean).join(". "),
					__id_integration: source.id,
					__can_create_clients: 1,
					__user: idUser,
				});
				// Відповідальний — хто оформив; клієнт — той самий, що в замовленні (якщо не знайшовся за телефоном)
				await conn.query(`UPDATE ${P}orders SET id_user = ?, id_client = COALESCE(id_client, ?) WHERE id = ?`, [idUser || null, o.id_client || null, id]);
				const [[x]] = await conn.query(`SELECT reference FROM ${P}orders WHERE id = ?`, [id]);
				const [u] = await conn.query(
					`UPDATE ${P}orders_returns SET status = 'exchanged', id_refund = ?, id_exchange_order = ?, amount = ?, amount_due = ?, date_edit = NOW() WHERE id = ? AND status = 'checked'`,
					[rf.id, id, back, due, r.id]
				);
				if (!u.affectedRows) throw httpErr(409, "Return changed, reload the page");
				await event(conn, idOrder, idUser, { id_return: r.id, number: r.number, from: r.status, to: "exchanged", id_exchange: id, exchange_reference: x.reference, back, due });
				await event(conn, id, idUser, { number: r.number, exchange_of: idOrder, exchange_of_reference: o.reference, credit, due });
				created = { id, reference: x.reference };
			},
		}
	);
	require("./notify").fire(created.id, "new");
	fire(idOrder, r, "exchanged");
	return { refund, order: created, credit, back, due };
}

/* ─── Список усіх заявок ─── */

/**
 * Tabulator remote. f: { status, type, reason, q, from, to, page, size }; scope — обмеження видимості замовлень (access.scope)
 */
async function list(f, scope) {
	const where = ["o.deleted_at IS NULL"];
	const params = [];
	const add = (sql, ...p) => {
		where.push(sql);
		params.push(...p);
	};
	if (STATUSES.includes(f.status)) add("r.status = ?", f.status);
	else if (f.status === "open") add("r.status IN (?)", ACTIVE);
	if (TYPES.includes(f.type)) add("r.type = ?", f.type);
	if (REASONS.includes(f.reason)) add("r.reason = ?", f.reason);
	if (/^\d{4}-\d{2}-\d{2}$/.test(f.from || "")) add("r.date_add >= ?", f.from);
	if (/^\d{4}-\d{2}-\d{2}$/.test(f.to || "")) add("r.date_add < ? + INTERVAL 1 DAY", f.to);
	const q = str(f.q, 64);
	if (q) {
		const like = "%" + q.replace(/[%_\\]/g, "\\$&") + "%";
		add("(r.number LIKE ? OR o.reference LIKE ? OR r.ttn LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(o.client, '$.phone')) LIKE ?)", like, like, like, like);
	}
	if (scope) add(scope.sql, ...scope.params);
	const lim = Math.min(200, Math.max(10, parseInt(f.size, 10) || 50));
	const page = Math.max(1, parseInt(f.page, 10) || 1);
	const base = `FROM ${P}orders_returns r JOIN ${P}orders o ON o.id = r.id_order WHERE ${where.join(" AND ")}`;
	const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${base}`, params);
	const [rows] = await pool.query(
		`SELECT r.id, r.id_order, r.number, r.type, r.status, r.reason, r.ttn, r.items, r.amount, r.amount_due, r.id_exchange_order, r.date_add, r.date_edit,
		        o.reference, o.currency_iso, o.client, x.reference AS exchange_reference,
		        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS user_name
		   ${base.replace("WHERE", `LEFT JOIN ${P}orders x ON x.id = r.id_exchange_order LEFT JOIN ${P}users u ON u.id = r.id_user WHERE`)}
		  ORDER BY r.id DESC LIMIT ? OFFSET ?`,
		[...params, lim, (page - 1) * lim]
	);
	const [counts] = await pool.query(`SELECT r.status, COUNT(*) AS n FROM ${P}orders_returns r JOIN ${P}orders o ON o.id = r.id_order WHERE o.deleted_at IS NULL${scope ? " AND " + scope.sql : ""} GROUP BY r.status`, scope ? scope.params : []);
	return {
		last_page: Math.max(1, Math.ceil(total / lim)),
		total,
		counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
		data: rows.map((r) => {
			const items = json(r.items, []);
			const c = json(r.client, {});
			return {
				...r,
				client: [c.firstname, c.lastname].filter(Boolean).join(" ") || c.phone || "",
				phone: c.phone || "",
				items: items.map((x) => ({ name: x.name, qty: Number(x.qty), condition: x.condition })),
				value: r2(items.reduce((s, x) => s + Number(x.qty) * Number(x.unit || 0), 0)),
				defect: items.some((x) => x.condition === "defect"),
			};
		}),
	};
}

module.exports = { REASONS, TYPES, STATUSES, ACTIVE, FLOW, form, forOrder, create, update, resolveRefund, resolveExchange, list };