"use strict";

/**
 * "Покупка частинами" monobank — окремий API банку (https://u2.monobank.com.ua), не еквайринг:
 * заголовки store-id і signature = Base64(HMAC-SHA256(тіло запиту, секрет магазину)).
 *
 * Сценарій: менеджер у картці замовлення надсилає заявку (телефон клієнта, кількість платежів) → банк надсилає
 * клієнту push у застосунок monobank → клієнт погоджує → банк шле callback IN_PROCESS/WAITING_FOR_STORE_CONFIRM →
 * магазин підтверджує видачу товару (confirm; або одразу, якщо так налаштовано) → SUCCESS/ACTIVE, кошти магазину
 * перераховує банк. Відмова клієнта, ліміт, ризики — FAIL/*. Магазин може відмовити сам (reject) до підтвердження.
 * Callback приходить не на кожну зміну, тож відкриті заявки ще й опитуються за розкладом.
 */
const crypto = require("crypto");
const { pool, P, T, httpErr, str, json, toMinor, fromMinor } = require("./common");
const accounts = require("./accounts");
const ordersNotify = require("../../../controllers/orders/notify");
const { applyStatus, deriveOrderFlags } = require("../../../controllers/orders/statusFlags");
const { kickOutbox } = require("../../../controllers/orders/outboxProcessor");

const BASES = { production: "https://u2.monobank.com.ua", sandbox: "https://u2-demo-ext.mono.st4g3.com" };
const APP_URL = String(require("../../../config/config").get("configServer").url || "").replace(/\/+$/, "");
const CALLBACK_PATH = "/api/module/monobank/parts/callback/";
const callbackUrl = (idAccount) => `${APP_URL}${CALLBACK_PATH}?a=${Number(idAccount)}`;
const STATES = ["IN_PROCESS", "SUCCESS", "FAIL"];
const TIMEOUT = 20000;
const userName = (alias) => `TRIM(CONCAT(COALESCE(${alias}.first_name, ''), ' ', COALESCE(${alias}.last_name, '')))`;

const i18n = require("../../../config/i18n/i18n");
const L = (k, vars) => i18n.__({ phrase: "modules.monobank.parts." + k, locale: process.env.APP_LOCALE || "uk" }, vars || {});
const sign = (raw, secret) => crypto.createHmac("sha256", String(secret)).update(raw).digest("base64");

/** Запит до API "Покупки частинами" */
async function call(acc, path, body) {
	const raw = Buffer.from(JSON.stringify(body || {}), "utf8");
	let res;
	try {
		res = await fetch((BASES[acc.parts.env] || BASES.production) + path, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json", "store-id": acc.parts.store_id, signature: sign(raw, acc.parts.secret) },
			body: raw,
			signal: AbortSignal.timeout(TIMEOUT),
		});
	} catch (e) {
		throw httpErr(502, "modules.monobank.e.network", { msg: e.message });
	}
	const text = await res.text();
	let j = {};
	try {
		j = text ? JSON.parse(text) : {};
	} catch (e) {
		throw httpErr(502, "modules.monobank.e.bad_response", { code: res.status });
	}
	if (res.status === 401 || res.status === 403) throw httpErr(400, "modules.monobank.e.parts_auth");
	if (res.status === 429) throw httpErr(429, "modules.monobank.e.rate_limit");
	if (!res.ok) throw httpErr(400, "modules.monobank.e.api", { msg: j.message || j.errText || "HTTP " + res.status });
	return j;
}

/** Телефон у форматі банку: +380XXXXXXXXX або null */
function normPhone(v) {
	let d = String(v || "").replace(/\D/g, "");
	if (d.length === 10 && d[0] === "0") d = "38" + d;
	if (d.length === 9) d = "380" + d;
	return /^380\d{9}$/.test(d) ? "+" + d : null;
}

async function loadOrder(idOrder) {
	const [[o]] = await pool.query(`SELECT id, id_integration, reference, total, total_shipping, currency_iso, status, is_paid, client FROM ${P}orders WHERE id = ? AND deleted_at IS NULL`, [idOrder]);
	if (!o) throw httpErr(404, "modules.monobank.e.order_not_found");
	return o;
}

/** Телефон клієнта для заявки: картка клієнта в замовленні → адреса доставки / оплати */
async function orderPhone(o) {
	const c = json(o.client, {}) || {};
	if (normPhone(c.phone)) return normPhone(c.phone);
	const [rows] = await pool.query(`SELECT phone FROM ${P}orders_addresses WHERE id_order = ? AND phone IS NOT NULL ORDER BY type = 'shipping' DESC`, [o.id]);
	for (const r of rows) if (normPhone(r.phone)) return normPhone(r.phone);
	return "";
}

async function event(db, row, type, status, payload, idUser) {
	await db.query(`INSERT INTO ${T.events} (id_invoice, id_order, type, status, payload, id_user, date_add) VALUES (NULL, ?, ?, ?, ?, ?, NOW())`, [
		row.id_order,
		type,
		status || null,
		JSON.stringify({ parts: row.id, order_id: row.order_id, ...(payload || {}) }),
		idUser || null,
	]);
}

async function orderEvent(db, idOrder, idUser, type, payload, source) {
	await db.query(`INSERT INTO ${P}orders_events (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, ?, ?, ?, NOW())`, [
		idOrder,
		idUser || null,
		type,
		JSON.stringify({ provider: "monobank_parts", ...payload }),
		source,
	]);
}

const pub = (r) => ({
	id: Number(r.id),
	order_id: r.order_id,
	store_order_id: r.store_order_id,
	phone: r.phone,
	amount: fromMinor(r.amount),
	parts: json(r.parts, []) || [],
	state: r.state,
	sub_state: r.sub_state,
	message: r.message,
	open: r.state === "IN_PROCESS",
	// Банк чекає підтвердження видачі товару від магазину
	can_confirm: r.state === "IN_PROCESS" && r.sub_state === "WAITING_FOR_STORE_CONFIRM",
	confirmed_at: r.confirmed_at,
	account: r.account_name || null,
	user: r.user_name || null,
	date_add: r.date_add,
	date_edit: r.date_edit,
});

/** Дані для панелі в картці замовлення */
async function forOrder(idOrder) {
	const o = await loadOrder(idOrder);
	const acc = await accounts.forParts(o.id_integration).catch(() => null);
	const [rows] = await pool.query(
		`SELECT p.*, a.name AS account_name, ${userName("u")} AS user_name FROM ${T.parts} p
		   LEFT JOIN ${T.accounts} a ON a.id = p.id_account LEFT JOIN ${P}users u ON u.id = p.id_user
		  WHERE p.id_order = ? ORDER BY p.id DESC`,
		[idOrder]
	);
	const iso = String(o.currency_iso || "UAH").toUpperCase();
	return {
		parts: {
			enabled: !!acc,
			supported: iso === "UAH",
			counts: acc ? acc.parts.counts : [],
			min_sum: acc ? Number(acc.parts.min_sum) || 0 : 0,
			total: Number(o.total) || 0,
			phone: await orderPhone(o),
			// Відкрита заявка вже є — нову не створюємо (банк і так відмовить: EXISTS_OTHER_OPEN_ORDER)
			busy: rows.some((r) => r.state === "IN_PROCESS"),
			rows: rows.map(pub),
		},
	};
}

/**
 * Позиції для банку: назва, кількість, ціна за одиницю. Сума позицій має дорівнювати сумі заявки;
 * якщо ні (знижки, комісії, округлення) — одна позиція "Замовлення №…" на всю суму.
 */
async function productsFor(o, amountMinor) {
	const [items] = await pool.query(`SELECT name, quantity, total FROM ${P}orders_items WHERE id_order = ? AND COALESCE(type, 'product') <> 'shipping' ORDER BY id`, [o.id]);
	const lines = [];
	let sum = 0;
	let exact = true;
	for (const it of items) {
		const qty = Math.max(1, Math.round(Number(it.quantity) || 1));
		const line = toMinor(it.total);
		if (line % qty !== 0) exact = false;
		lines.push({ name: String(it.name || "").slice(0, 255) || "—", count: qty, sum: Math.round(line / qty) / 100 });
		sum += line;
	}
	const ship = toMinor(o.total_shipping);
	if (ship > 0) {
		lines.push({ name: L("line_shipping"), count: 1, sum: ship / 100 });
		sum += ship;
	}
	if (!exact || !lines.length || sum !== amountMinor) return [{ name: L("line_order", { ref: o.reference }).slice(0, 255), count: 1, sum: amountMinor / 100 }];
	return lines;
}

/** Нова заявка: body { phone, parts: [кількості] (порожньо — усі з договору) } */
async function create(idOrder, body, idUser) {
	const o = await loadOrder(idOrder);
	if (String(o.currency_iso || "UAH").toUpperCase() !== "UAH") throw httpErr(409, "modules.monobank.e.parts_currency");
	const acc = await accounts.forParts(o.id_integration);
	if (!acc) throw httpErr(409, "modules.monobank.e.parts_off");
	const phone = normPhone(body.phone);
	if (!phone) throw httpErr(400, "modules.monobank.e.parts_phone");
	const amount = toMinor(o.total);
	if (amount < 100) throw httpErr(409, "modules.monobank.e.parts_sum");
	if (Number(acc.parts.min_sum) > 0 && amount < toMinor(acc.parts.min_sum)) throw httpErr(409, "modules.monobank.e.parts_min", { sum: Number(acc.parts.min_sum).toFixed(2) });
	const allowed = acc.parts.counts;
	const picked = (Array.isArray(body.parts) ? body.parts : [body.parts]).map((n) => parseInt(n, 10)).filter((n) => allowed.includes(n));
	const counts = picked.length ? [...new Set(picked)].sort((a, b) => a - b) : allowed;
	const [[open]] = await pool.query(`SELECT id FROM ${T.parts} WHERE id_order = ? AND state = 'IN_PROCESS' LIMIT 1`, [o.id]);
	if (open) throw httpErr(409, "modules.monobank.e.parts_open");

	// Номер заявки магазину: номер замовлення + спроба (повтор із тим самим номером банк вважає тією самою заявкою)
	const [[n]] = await pool.query(`SELECT COUNT(*) AS c FROM ${T.parts} WHERE id_order = ?`, [o.id]);
	const storeOrderId = `${o.reference}${Number(n.c) ? "-" + (Number(n.c) + 1) : ""}`.slice(0, 64);
	const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());
	const req = {
		store_order_id: storeOrderId,
		client_phone: phone,
		total_sum: amount / 100,
		invoice: { date: today, number: String(o.reference).slice(0, 64), source: "INTERNET" },
		available_programs: [{ available_parts_count: counts, type: "payment_installments" }],
		products: await productsFor(o, amount),
		result_callback: callbackUrl(acc.id),
	};
	const r = await call(acc, "/api/order/create", req);
	const orderId = str(r.order_id, 64);
	if (!orderId) throw httpErr(502, "modules.monobank.e.bad_response", { code: 201 });

	const conn = await pool.getConnection();
	let id;
	try {
		await conn.beginTransaction();
		const [ins] = await conn.query(
			`INSERT INTO ${T.parts} (id_order, id_account, order_id, store_order_id, phone, amount, parts, state, sub_state, id_user, date_add, date_edit)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'IN_PROCESS', 'WAITING_FOR_CLIENT', ?, NOW(), NOW())`,
			[o.id, acc.id, orderId, storeOrderId, phone, amount, JSON.stringify(counts), idUser || null]
		);
		id = ins.insertId;
		await event(conn, { id, id_order: o.id, order_id: orderId }, "parts_created", "IN_PROCESS", { amount: amount / 100, phone, counts }, idUser);
		await orderEvent(conn, o.id, idUser, "payment_parts", { order_id: orderId, amount: amount / 100, phone, counts }, "manual");
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
	// Сценарій без callback (банк не надіслав зміну одразу) — перше оновлення стану
	refresh(o.id, id, null).catch(() => null);
	return forOrder(o.id);
}

async function loadRow(idOrder, idPart) {
	const [[r]] = await pool.query(`SELECT * FROM ${T.parts} WHERE id = ? AND id_order = ?`, [idPart, idOrder]);
	if (!r) throw httpErr(404, "modules.monobank.e.parts_not_found");
	return r;
}

/** Статус замовлення: погоджено клієнтом (status_approved) / розстрочка активна — як оплата (status_paid акаунта) */
async function orderStatus(conn, row, acc, kind) {
	const target = Number(kind === "approved" ? acc.parts.status_approved : acc.settings.status_paid) || 0;
	if (!target) return null;
	const [[o]] = await conn.query(`SELECT status FROM ${P}orders WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [row.id_order]);
	const cur = o ? Number(o.status) : 0;
	if (!cur || cur === target) return null;
	if ((await deriveOrderFlags(cur).catch(() => ({}))).is_final) return null;
	const r = await applyStatus(conn, row.id_order, target, { source: "system", comment: L("status_comment", { id: row.order_id }), extra: { via: "monobank_parts", order_id: row.order_id } });
	return r ? { ...r, to: target } : null;
}

/**
 * Застосувати стан від банку (callback, опитування, відповідь на confirm / reject).
 * data: { state, order_sub_state, message? }
 */
async function applyRemote(idPart, data, source, idUser) {
	const state = STATES.includes(data.state) ? data.state : null;
	if (!state) return { changed: false };
	const sub = str(data.order_sub_state, 48);
	const conn = await pool.getConnection();
	let row = null;
	let res = null;
	let changed = false;
	let becameActive = false;
	let becameWaiting = false;
	try {
		await conn.beginTransaction();
		[[row]] = await conn.query(`SELECT * FROM ${T.parts} WHERE id = ? FOR UPDATE`, [idPart]);
		if (!row) {
			await conn.rollback();
			return { changed: false };
		}
		changed = row.state !== state || row.sub_state !== sub;
		if (source !== "reconcile" || changed) await event(conn, row, "parts_" + source, state + (sub ? "/" + sub : ""), data, idUser);
		if (changed) {
			await conn.query(`UPDATE ${T.parts} SET state = ?, sub_state = ?, message = COALESCE(?, message), date_edit = NOW() WHERE id = ?`, [state, sub, str(data.message, 512), row.id]);
			const acc = await accounts.withParts(row.id_account);
			becameWaiting = state === "IN_PROCESS" && sub === "WAITING_FOR_STORE_CONFIRM";
			becameActive = state === "SUCCESS" && row.state !== "SUCCESS";
			if (becameWaiting) res = await orderStatus(conn, row, acc, "approved");
			if (becameActive) res = (await orderStatus(conn, row, acc, "paid")) || res;
			await orderEvent(conn, row.id_order, null, "payment_parts_state", { order_id: row.order_id, before: `${row.state}/${row.sub_state || ""}`, after: `${state}/${sub || ""}`, amount: fromMinor(row.amount) }, "system");
			row.__acc = acc;
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
	if (res) {
		kickOutbox();
		ordersNotify.fire(row.id_order, "status", { to: res.to });
	}
	if (becameActive) ordersNotify.fire(row.id_order, "paid", { amount: fromMinor(row.amount).toFixed(2) });
	// Клієнт погодив, а магазин видає товар одразу — підтверджуємо банку автоматично
	if (becameWaiting && row.__acc && row.__acc.parts.auto_confirm) await confirm(row.id_order, row.id, null).catch((e) => console.error("[monobank] parts auto confirm:", e.message));
	return { changed, state, sub_state: sub };
}

/** Оновити стан з банку */
async function refresh(idOrder, idPart, idUser) {
	const row = await loadRow(idOrder, idPart);
	if (!row.order_id) return forOrder(idOrder);
	const acc = await accounts.withParts(row.id_account);
	const d = await call(acc, "/api/order/state", { order_id: row.order_id });
	await applyRemote(row.id, d, idUser ? "refresh" : "reconcile", idUser);
	return forOrder(idOrder);
}

/** Магазин підтверджує видачу товару — розстрочка активується */
async function confirm(idOrder, idPart, idUser) {
	const row = await loadRow(idOrder, idPart);
	if (!(row.state === "IN_PROCESS" && row.sub_state === "WAITING_FOR_STORE_CONFIRM")) throw httpErr(409, "modules.monobank.e.parts_not_waiting");
	const acc = await accounts.withParts(row.id_account);
	const d = await call(acc, "/api/order/confirm", { order_id: row.order_id });
	await pool.query(`UPDATE ${T.parts} SET confirmed_at = NOW() WHERE id = ?`, [row.id]);
	await event(pool, row, "parts_confirm", null, null, idUser);
	if (d && d.state) await applyRemote(row.id, d, "confirm", idUser);
	else await refresh(idOrder, idPart, idUser).catch(() => null);
	return forOrder(idOrder);
}

/** Магазин відмовляє (товару немає тощо) — до підтвердження видачі */
async function reject(idOrder, idPart, idUser) {
	const row = await loadRow(idOrder, idPart);
	if (row.state !== "IN_PROCESS") throw httpErr(409, "modules.monobank.e.parts_closed");
	const acc = await accounts.withParts(row.id_account);
	const d = await call(acc, "/api/order/reject", { order_id: row.order_id });
	await event(pool, row, "parts_reject", null, null, idUser);
	await applyRemote(row.id, d && d.state ? d : { state: "FAIL", order_sub_state: "REJECTED_BY_STORE" }, "reject", idUser);
	return forOrder(idOrder);
}

/** Callback банку: підпис HMAC-SHA256 сирого тіла секретом акаунта */
async function callback(idAccount, raw, signature) {
	if (!idAccount) throw httpErr(400, "bad account");
	const acc = await accounts.withParts(idAccount);
	const expected = Buffer.from(sign(raw, acc.parts.secret));
	const got = Buffer.from(String(signature || ""));
	if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) throw httpErr(401, "bad signature");
	const data = json(raw.toString("utf8"), null);
	if (!data || !data.order_id) throw httpErr(400, "bad body");
	const [[row]] = await pool.query(`SELECT id FROM ${T.parts} WHERE order_id = ? AND id_account = ?`, [String(data.order_id), acc.id]);
	if (!row) return { ignored: true };
	return applyRemote(row.id, data, "callback");
}

/** Розклад: відкриті заявки за останні days днів (клієнт міг погодити без callback, банк міг закрити заявку) */
async function reconcileDue(days) {
	const [rows] = await pool.query(`SELECT id, id_order FROM ${T.parts} WHERE state = 'IN_PROCESS' AND date_add > NOW() - INTERVAL ? DAY ORDER BY id LIMIT 200`, [Math.max(1, Number(days) || 7)]);
	let n = 0;
	for (const r of rows) {
		try {
			await refresh(r.id_order, r.id, null);
			n++;
		} catch (e) {
			if (!e.status) console.error("[monobank] parts reconcile:", e.message);
		}
	}
	return n;
}

module.exports = { forOrder, create, refresh, confirm, reject, callback, reconcileDue, callbackUrl, normPhone };