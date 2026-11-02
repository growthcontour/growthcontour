"use strict";

/**
 * Рахунки Monobank у замовленні: посилання на оплату, стан, деталі платежу, повернення, холд,
 * фіскальні чеки й квитанції, вебхуки, звірка за розкладом.
 * Джерело правди — таблиці modules_monobank_* (orders_payments перезаписується при оновленні замовлення з сайту).
 * Будь-яка зміна стану йде через applyRemote(): блокування рядка, захист від старих вебхуків (modifiedDate),
 * журнал подій і зміна статусу замовлення в одній транзакції.
 */
const { pool, P, T, httpErr, str, json, toMinor, fromMinor, CCY, CCY_ISO, STATES, OPEN_STATES } = require("./common");
const accounts = require("./accounts");
const api = require("./api");
const ordersNotify = require("../../../controllers/orders/notify");
const orderRefunds = require("../../../controllers/orders/refunds");
const { applyStatus, deriveOrderFlags } = require("../../../controllers/orders/statusFlags");
const { kickOutbox } = require("../../../controllers/orders/outboxProcessor");
const crypto = require("crypto");
const cryptoHelper = require("../../../helpers/crypto");

const APP_URL = String(require("../../../config/config").get("configServer").url || "").replace(/\/+$/, "");
const WEBHOOK_PATH = "/api/module/monobank/webhook/";
const HOLD_DAYS = 9; // холд Monobank: не підтверджений за 9 днів — банк сам знімає блокування
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const webhookUrl = (idAccount) => `${APP_URL}${WEBHOOK_PATH}?a=${Number(idAccount)}`;
const dt = (v) => {
	const d = v ? new Date(v) : null;
	return d && !isNaN(d.getTime()) ? d : null;
};
const userName = (alias) => `TRIM(CONCAT(COALESCE(${alias}.first_name, ''), ' ', COALESCE(${alias}.last_name, '')))`;

/** Запис у журнал рахунку. db — пул або з'єднання транзакції */
async function event(db, inv, type, status, payload, idUser) {
	await db.query(`INSERT INTO ${T.events} (id_invoice, id_order, type, status, payload, id_user, date_add) VALUES (?, ?, ?, ?, ?, ?, NOW())`, [
		inv ? inv.id : null,
		inv ? inv.id_order : null,
		type,
		status || null,
		payload ? JSON.stringify(payload) : null,
		idUser || null,
	]);
}

async function orderEvent(db, idOrder, idUser, type, payload, source) {
	await db.query(`INSERT INTO ${P}orders_events (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, ?, ?, ?, NOW())`, [
		idOrder,
		idUser || null,
		type,
		JSON.stringify({ provider: "monobank", ...payload }),
		source,
	]);
}

async function loadOrder(idOrder) {
	const [[o]] = await pool.query(`SELECT id, id_integration, id_client, reference, total, total_shipping, currency_iso, status, is_paid, client FROM ${P}orders WHERE id = ? AND deleted_at IS NULL`, [idOrder]);
	if (!o) throw httpErr(404, "modules.monobank.e.order_not_found");
	return o;
}

/** Email клієнта: картка клієнта в замовленні → адреса оплати / доставки */
async function clientEmail(o) {
	const c = json(o.client, {}) || {};
	if (c.email && EMAIL_RE.test(c.email)) return String(c.email).trim();
	const [[a]] = await pool.query(`SELECT email FROM ${P}orders_addresses WHERE id_order = ? AND email IS NOT NULL AND email <> '' ORDER BY type = 'billing' DESC, id LIMIT 1`, [o.id]);
	return a && EMAIL_RE.test(a.email) ? String(a.email).trim() : null;
}

/** Деталі платежу для показу */
function paymentInfoOf(raw) {
	const p = json(raw, null);
	if (!p) return null;
	return {
		masked_pan: p.maskedPan || null,
		method: p.paymentMethod || null,
		system: p.paymentSystem || null,
		bank: p.bank || null,
		country: p.country || null,
		rrn: p.rrn || null,
		approval_code: p.approvalCode || null,
		tran_id: p.tranId || null,
		terminal: p.terminal || null,
	};
}

function publicInvoice(r, refunds) {
	const own = refunds.filter((x) => x.id_invoice === Number(r.id));
	const refunded = own.filter((x) => x.status !== "failure").reduce((s, x) => s + x.minor, 0);
	return {
		id: Number(r.id),
		invoice_id: r.invoice_id,
		page_url: r.page_url || null,
		source: r.source || "link",
		qr: r.qr_name || r.qr_short || null,
		amount: fromMinor(r.amount),
		final_amount: r.final_amount === null ? null : fromMinor(r.final_amount),
		refundable: r.status === "success" ? fromMinor(Math.max(0, Number(r.amount) - refunded)) : 0,
		currency: CCY_ISO[r.ccy] || String(r.ccy),
		payment_type: r.payment_type,
		status: r.status,
		failure_reason: r.failure_reason,
		payment_info: paymentInfoOf(r.payment_info),
		fee: r.fee === null ? null : fromMinor(r.fee),
		expires_at: r.expires_at,
		hold_until: r.hold_until,
		paid_at: r.paid_at,
		account: r.account_name || null,
		fiscal: !!accounts.settingsOf(r.account_settings).fiscal,
		user: r.user_name || null,
		date_add: r.date_add,
		refunds: own.map((x) => ({ number: x.number, amount: x.amount, status: x.status, hold: x.hold, user: x.user, date_add: x.date_add })),
	};
}

/** Сума, сплачена через Monobank (успішні рахунки, після повернень) — у копійках */
async function paidMinor(idOrder) {
	const [[r]] = await pool.query(`SELECT COALESCE(SUM(COALESCE(final_amount, amount)), 0) AS s FROM ${T.invoices} WHERE id_order = ? AND status = 'success'`, [idOrder]);
	return Number(r.s) || 0;
}

/** Дані для панелі в картці замовлення */
async function forOrder(idOrder) {
	const o = await loadOrder(idOrder);
	const [[acc]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.accounts} WHERE status = 1`);
	const [rows] = await pool.query(
		`SELECT i.*, a.name AS account_name, a.settings AS account_settings, ${userName("u")} AS user_name, q.name AS qr_name, q.short_qr_id AS qr_short
		   FROM ${T.invoices} i
		   LEFT JOIN ${T.accounts} a ON a.id = i.id_account
		   LEFT JOIN ${T.qr} q ON q.id_account = i.id_account AND q.qr_id = i.qr_id
		   LEFT JOIN ${P}users u ON u.id = i.id_user
		  WHERE i.id_order = ? ORDER BY i.id DESC`,
		[idOrder]
	);
	const [refunds] = await pool.query(
		`SELECT r.id_invoice, r.ext_ref, r.amount, r.status, r.id_refund, r.date_add, ${userName("u")} AS user_name
		   FROM ${T.refunds} r LEFT JOIN ${P}users u ON u.id = r.id_user
		  WHERE r.id_order = ? ORDER BY r.id`,
		[idOrder]
	);
	const rf = refunds.map((r) => ({
		id_invoice: Number(r.id_invoice),
		minor: Number(r.amount),
		number: r.ext_ref,
		amount: fromMinor(r.amount),
		status: r.status,
		hold: !r.id_refund,
		user: r.user_name || null,
		date_add: r.date_add,
	}));
	const paid = await paidMinor(idOrder);
	const total = toMinor(o.total);
	const iso = String(o.currency_iso || "UAH").toUpperCase();
	return {
		has_accounts: Number(acc.n) > 0,
		currency: iso,
		supported: !!CCY[iso],
		hold_allowed: iso === "UAH",
		total: fromMinor(total),
		paid: fromMinor(paid),
		due: fromMinor(Math.max(0, total - paid)),
		email: await clientEmail(o),
		invoices: rows.map((r) => publicInvoice(r, rf)),
		// QR-каси акаунта магазину й збережені картки клієнта (етап C)
		...(await accounts.qrForOrder(o)),
		...(await cardsForOrder(o)),
	};
}

/** Склад замовлення для чека Monobank. Сума рядків має збігатися з сумою рахунку, інакше чек не передаємо */
async function basketFor(o, amount, shippingName) {
	const [items] = await pool.query(`SELECT sku, name, quantity, total FROM ${P}orders_items WHERE id_order = ? AND COALESCE(type, 'product') <> 'shipping' ORDER BY id`, [o.id]);
	const lines = [];
	for (const it of items) {
		const qty = Number(it.quantity) || 0;
		if (qty <= 0) continue;
		const sum = toMinor(Number(it.total) / qty);
		// Неціла ціна за одиницю (знижка на рядок) — передаємо рядок як 1 шт. на всю суму
		if (sum * qty === toMinor(it.total)) lines.push({ name: String(it.name).slice(0, 128), qty, sum, code: str(it.sku, 64) || undefined });
		else lines.push({ name: `${String(it.name).slice(0, 120)} ×${qty}`, qty: 1, sum: toMinor(it.total), code: str(it.sku, 64) || undefined });
	}
	const ship = toMinor(o.total_shipping);
	if (ship > 0) lines.push({ name: String(shippingName || "—").slice(0, 128), qty: 1, sum: ship });
	const sum = lines.reduce((s, l) => s + l.sum * l.qty, 0);
	return lines.length && sum === amount ? lines : null;
}

/**
 * Спільна підготовка платежу: замовлення, акаунт магазину, валюта, сума (порожньо — залишок до сплати), тип.
 * opts.zero — дозволити 0 (перевірка картки); opts.debitOnly — лише списання (QR-каси, перевірка)
 */
async function prepare(idOrder, body, opts = {}) {
	if (!APP_URL) throw httpErr(500, "modules.monobank.e.no_app_url");
	const o = await loadOrder(idOrder);
	const iso = String(o.currency_iso || "UAH").toUpperCase();
	const ccy = CCY[iso];
	if (!ccy) throw httpErr(400, "modules.monobank.e.currency", { cur: iso });

	const acc = body.account_id ? await accounts.withToken(Number(body.account_id)) : await accounts.forIntegration(o.id_integration);
	if (!acc || !acc.status) throw httpErr(409, "modules.monobank.e.no_account");

	let amount = 0;
	if (!opts.zero) {
		const due = Math.max(0, toMinor(o.total) - (await paidMinor(idOrder)));
		amount = body.amount !== undefined && body.amount !== null && body.amount !== "" ? toMinor(body.amount) : due;
		if (!(amount > 0)) throw httpErr(400, "modules.monobank.e.amount");
	}
	const s = acc.settings;
	const paymentType = opts.debitOnly ? "debit" : accounts.PAYMENT_TYPES.includes(body.payment_type) ? body.payment_type : s.payment_type;
	// Холд Monobank працює лише в гривні
	if (paymentType === "hold" && ccy !== CCY.UAH) throw httpErr(400, "modules.monobank.e.hold_uah");
	const reference = String(o.reference || o.id);
	const destination = String(s.destination || "{order}").replace(/\{order\}/g, reference).slice(0, 280);
	return { o, acc, s, iso, ccy, amount, paymentType, reference, destination };
}

/** Гаманець клієнта для збережених карток: стабільний id на клієнта системи (без клієнта — картки не зберігаються) */
const walletId = (idClient) => (Number(idClient) > 0 ? `gc-${Number(idClient)}` : null);

/** Записати створений у банку рахунок: рядок, журнал рахунку й подія замовлення */
async function record(idOrder, acc, d, idUser) {
	const conn = await pool.getConnection();
	let id;
	try {
		await conn.beginTransaction();
		const [r] = await conn.query(
			`INSERT INTO ${T.invoices} (id_order, id_account, source, qr_id, invoice_id, page_url, amount, ccy, payment_type, status, basket, expires_at, id_user, date_add, date_edit)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, IF(? > 0, DATE_ADD(NOW(), INTERVAL ? SECOND), NULL), ?, NOW(), NOW())`,
			[idOrder, acc.id, d.source, d.qr_id || null, d.invoice_id, d.page_url || "", d.amount, d.ccy, d.payment_type, d.basket ? JSON.stringify(d.basket) : null, d.validity || 0, d.validity || 0, idUser || null]
		);
		id = r.insertId;
		const inv = { id, id_order: idOrder };
		await event(conn, inv, "created", "created", { amount: fromMinor(d.amount), currency: d.iso, payment_type: d.payment_type, source: d.source, account: acc.name, ...(d.log || {}) }, idUser);
		await orderEvent(conn, idOrder, idUser, d.source === "wallet" ? "payment_wallet" : "payment_link", { invoice: d.invoice_id, amount: fromMinor(d.amount), currency: d.iso, source: d.source }, "manual");
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
	return { id, invoice_id: d.invoice_id, page_url: d.page_url || null, amount: fromMinor(d.amount), currency: d.iso, status: "created", payment_type: d.payment_type, source: d.source };
}

/**
 * Нове посилання на оплату. amount — сума в гривнях (порожньо — залишок до сплати).
 * opts.qrId — виставити суму на QR-касу (лише списання); opts.verification — посилання для збереження картки без списання.
 */
async function create(idOrder, body, idUser, opts = {}) {
	const p = await prepare(idOrder, body, { zero: !!opts.verification, debitOnly: !!(opts.qrId || opts.verification) });
	const { o, acc, s, iso, ccy, amount } = p;
	const paymentType = opts.verification ? "verification" : p.paymentType;
	const validity = Math.round(s.validity_hours * 3600);
	const basket = s.basket && amount > 0 ? await basketFor(o, amount, s.shipping_name) : null;
	const email = s.customer_email ? await clientEmail(o) : null;
	// Збереження картки: увімкнено банком для мерчанта (tokenization), є клієнт; для перевірки — обов'язково
	const wallet = s.tokenization ? walletId(o.id_client) : null;
	if (opts.verification && !wallet) throw httpErr(409, s.tokenization ? "modules.monobank.e.no_client" : "modules.monobank.e.no_tokenization");
	const saveCard = wallet && (opts.verification || (s.save_card && !opts.qrId));

	const res = await api.createInvoice(acc.token, {
		amount,
		ccy,
		merchantPaymInfo: {
			reference: p.reference.slice(0, 64),
			destination: p.destination,
			...(basket ? { basketOrder: basket } : {}),
			...(email ? { customerEmails: [email] } : {}),
		},
		...(s.redirect_url && !opts.qrId ? { redirectUrl: s.redirect_url } : {}),
		...(opts.qrId ? { qrId: opts.qrId } : {}),
		...(saveCard ? { saveCardData: { saveCard: true, walletId: wallet } } : {}),
		webHookUrl: webhookUrl(acc.id),
		validity,
		paymentType,
	});
	if (!res.invoiceId) throw httpErr(502, "modules.monobank.e.bad_response", { code: 200 });

	const invoice = await record(
		idOrder,
		acc,
		{
			source: opts.qrId ? "qr" : "link",
			qr_id: opts.qrId || null,
			invoice_id: res.invoiceId,
			page_url: res.pageUrl,
			amount,
			ccy,
			iso,
			payment_type: paymentType,
			basket,
			validity,
			log: { basket: !!basket, email: email || undefined, save_card: saveCard ? true : undefined, qr: opts.qrId || undefined },
		},
		idUser
	);
	return { invoice };
}

async function loadInvoice(idOrder, idInvoice) {
	const [[r]] = await pool.query(`SELECT * FROM ${T.invoices} WHERE id = ? AND id_order = ?`, [idInvoice, idOrder]);
	if (!r) throw httpErr(404, "modules.monobank.e.invoice_not_found");
	return r;
}

/**
 * Застосувати стан від Monobank (вебхук, звірка або ручне оновлення).
 * Старіший за збережений modifiedDate — ігноруємо (вебхуки можуть приходити не по черзі).
 */
async function applyRemote(idInvoice, data, source, idUser) {
	const status = STATES.includes(data.status) ? data.status : null;
	if (!status) return { changed: false };
	const modified = dt(data.modifiedDate);
	const conn = await pool.getConnection();
	let changed = false;
	let res = null;
	let inv = null;
	try {
		await conn.beginTransaction();
		[[inv]] = await conn.query(`SELECT * FROM ${T.invoices} WHERE id = ? FOR UPDATE`, [idInvoice]);
		if (!inv) {
			await conn.rollback();
			return { changed: false };
		}
		const prev = inv.status;
		const stale = modified && inv.modified_at && modified.getTime() < new Date(inv.modified_at).getTime();
		// Звірка без змін у журнал не пишеться — інакше відкриті рахунки засмічують історію кожні N хвилин
		if (source !== "reconcile" || prev !== status) await event(conn, inv, source, status, { ...data, stale: stale || undefined }, idUser);
		if (!stale) {
			changed = prev !== status;
			const info = data.paymentInfo && typeof data.paymentInfo === "object" ? data.paymentInfo : null;
			const holdFrom = dt(data.createdDate) || modified || new Date();
			await conn.query(
				`UPDATE ${T.invoices}
				    SET status = ?, final_amount = COALESCE(?, final_amount), failure_reason = ?, modified_at = COALESCE(?, modified_at),
				        payment_info = COALESCE(?, payment_info), fee = COALESCE(?, fee),
				        hold_until = IF(? = 'hold' AND hold_until IS NULL, ?, hold_until),
				        paid_at = IF(? = 'success' AND paid_at IS NULL, NOW(), paid_at), date_edit = NOW()
				  WHERE id = ?`,
				[
					status,
					Number.isFinite(Number(data.finalAmount)) ? Number(data.finalAmount) : null,
					str(data.failureReason, 512),
					modified,
					info ? JSON.stringify(info) : null,
					info && Number.isFinite(Number(info.fee)) ? Number(info.fee) : null,
					status,
					new Date(holdFrom.getTime() + HOLD_DAYS * 24 * 3600 * 1000),
					status,
					inv.id,
				]
			);
			await applyCancelList(conn, inv, data.cancelList, status);
			// Збережена картка (saveCardData): токен приходить у walletData
			if (data.walletData && typeof data.walletData === "object") await cardStore(conn, inv, data);
			// Перевірка картки (сума 0) — не оплата: статус замовлення не змінюємо
			const real = inv.payment_type !== "verification";
			if (real && changed && ["success", "hold", "reversed"].includes(status)) res = await orderStatus(conn, inv, status);
			if (changed)
				await orderEvent(conn, inv.id_order, null, "payment", { invoice: inv.invoice_id, before: prev, after: status, amount: fromMinor(Number(data.finalAmount) || inv.amount) }, "system");
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
		ordersNotify.fire(inv.id_order, "status", { to: res.to });
	}
	// Оплата — подія замовлення «paid» (правила сайту, шаблони клієнту, автоправила) незалежно від того, чи змінився статус
	if (changed && status === "success" && inv.payment_type !== "verification") ordersNotify.fire(inv.id_order, "paid", { amount: fromMinor(Number(data.finalAmount) || inv.amount).toFixed(2) });
	else if (res && res.flags.is_paid && !res.was_paid) ordersNotify.fire(inv.id_order, "paid");
	if (changed && status === "failure") require("./statement").failed(inv, str(data.failureReason, 200)).catch(() => null);
	// Подія для інших модулів (фіскальний чек Checkbox): дані платежу й чи фіскалізує сам банк (ПРРО Monobank)
	if (changed && status === "success" && inv.payment_type !== "verification") {
		const [[a]] = await pool.query(`SELECT name, settings FROM ${T.accounts} WHERE id = ?`, [inv.id_account]);
		const pi = (data.paymentInfo && typeof data.paymentInfo === "object" ? data.paymentInfo : null) || json(inv.payment_info, {}) || {};
		require("../../../core/modules/orders").emit(inv.id_order, "monobank.paid", {
			invoice_id: inv.invoice_id,
			amount: fromMinor(Number(data.finalAmount) || inv.amount),
			currency: CCY_ISO[inv.ccy] || "UAH",
			full: Number(data.finalAmount || inv.amount) >= Number(inv.amount),
			bank_fiscal: !!accounts.settingsOf(a && a.settings).fiscal,
			account: a ? a.name : null,
			card_mask: pi.maskedPan || null,
			rrn: pi.rrn || null,
			auth_code: pi.approvalCode || null,
			bank: pi.bank || null,
			payment_system: pi.paymentSystem || null,
			terminal: pi.terminal || null,
			tran_id: pi.tranId || null,
		});
	}
	return { changed, status };
}

/**
 * Стан повернень з відповіді банку. cancelList — прийняті запити на повернення; якщо банк повертає extRef і стан —
 * беремо їх, інакше: рахунок reversed — усі наші повернення по ньому успішні.
 */
async function applyCancelList(conn, inv, list, status) {
	for (const c of Array.isArray(list) ? list : []) {
		if (!c || !c.extRef) continue;
		const st = ["processing", "success", "failure"].includes(c.status) ? c.status : "success";
		await conn.query(`UPDATE ${T.refunds} SET status = ?, date_edit = NOW() WHERE id_invoice = ? AND ext_ref = ? AND status <> ?`, [st, inv.id, String(c.extRef), st]);
	}
	if (status === "reversed") await conn.query(`UPDATE ${T.refunds} SET status = 'success', date_edit = NOW() WHERE id_invoice = ? AND status = 'processing'`, [inv.id]);
}

/** Статус замовлення після оплати / холду / повного повернення (налаштування акаунта) */
async function orderStatus(conn, inv, state) {
	const [[a]] = await conn.query(`SELECT settings FROM ${T.accounts} WHERE id = ?`, [inv.id_account]);
	const s = accounts.settingsOf(a && a.settings);
	const target = Number({ success: s.status_paid, hold: s.status_hold, reversed: s.status_refunded }[state]) || 0;
	if (!target) return null;
	const [[o]] = await conn.query(`SELECT status FROM ${P}orders WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [inv.id_order]);
	const cur = o ? Number(o.status) : 0;
	if (!cur || cur === target) return null;
	// Оплата й холд не чіпають завершене замовлення; повернення — свідома дія менеджера, його статус ставимо завжди
	if (state !== "reversed" && (await deriveOrderFlags(cur).catch(() => ({}))).is_final) return null;
	const r = await applyStatus(conn, inv.id_order, target, { source: "system", comment: `Monobank: ${inv.invoice_id}`, extra: { via: "monobank", invoice: inv.invoice_id } });
	return r ? { ...r, to: target } : null;
}

/** Вебхук: перевірка підпису ключем акаунта, потім застосування стану */
async function webhook(idAccount, raw, sign) {
	if (!idAccount) throw httpErr(400, "bad account");
	const acc = await accounts.withToken(idAccount);
	if (!(await api.verify(acc.token, raw, sign))) throw httpErr(401, "bad signature");
	const data = json(raw.toString("utf8"), null);
	if (!data || !data.invoiceId) throw httpErr(400, "bad body");
	const [[inv]] = await pool.query(`SELECT id FROM ${T.invoices} WHERE invoice_id = ? AND id_account = ?`, [String(data.invoiceId), acc.id]);
	if (!inv) return { ignored: true };
	return applyRemote(inv.id, data, "webhook");
}

/** Ручне оновлення стану з картки замовлення */
async function refresh(idOrder, idInvoice, idUser) {
	const inv = await loadInvoice(idOrder, idInvoice);
	const acc = await accounts.withToken(inv.id_account);
	await applyRemote(inv.id, await api.status(acc.token, inv.invoice_id), "reconcile", idUser);
	return forOrder(idOrder);
}

/** Анулювати неоплачене посилання */
async function invalidate(idOrder, idInvoice, idUser) {
	const inv = await loadInvoice(idOrder, idInvoice);
	if (inv.status !== "created") throw httpErr(409, "modules.monobank.e.cannot_remove");
	const acc = await accounts.withToken(inv.id_account);
	// Сума на QR-касі: спершу звільняємо касу
	if (inv.source === "qr" && inv.qr_id) await api.qrReset(acc.token, inv.qr_id).catch((e) => console.error("[monobank] qr reset:", e.message));
	await api.remove(acc.token, inv.invoice_id);
	await applyRemote(inv.id, { status: "removed" }, "removed", idUser);
	return forOrder(idOrder);
}

/** Підтвердити списання заблокованих коштів (hold). amount — менша сума в гривнях або порожньо (уся) */
async function finalize(idOrder, idInvoice, amount, idUser) {
	const inv = await loadInvoice(idOrder, idInvoice);
	if (inv.status !== "hold") throw httpErr(409, "modules.monobank.e.not_hold");
	const minor = amount !== undefined && amount !== null && amount !== "" ? toMinor(amount) : null;
	if (minor !== null && (minor <= 0 || minor > inv.amount)) throw httpErr(400, "modules.monobank.e.amount");
	const acc = await accounts.withToken(inv.id_account);
	await api.finalize(acc.token, inv.invoice_id, minor);
	await event(pool, inv, "finalized", null, { amount: minor === null ? fromMinor(inv.amount) : fromMinor(minor) }, idUser);
	// Остаточний стан (success) прийде вебхуком; пробуємо одразу підтягнути
	await applyRemote(inv.id, await api.status(acc.token, inv.invoice_id), "reconcile", idUser).catch(() => null);
	return forOrder(idOrder);
}

/** Скасувати холд: кошти розблоковуються на картці клієнта; грошей у замовленні не було — повернення не оформлюється */
async function releaseHold(idOrder, idInvoice, idUser) {
	const inv = await loadInvoice(idOrder, idInvoice);
	if (inv.status !== "hold") throw httpErr(409, "modules.monobank.e.not_hold");
	const acc = await accounts.withToken(inv.id_account);
	const extRef = `${inv.invoice_id}-H`.slice(0, 64);
	const r = await api.cancel(acc.token, { invoiceId: inv.invoice_id, extRef });
	if (r.status === "failure") throw httpErr(400, "modules.monobank.e.refund_failed");
	await pool.query(
		`INSERT INTO ${T.refunds} (id_invoice, id_order, id_refund, ext_ref, amount, status, id_user, date_add, date_edit) VALUES (?, ?, NULL, ?, ?, ?, ?, NOW(), NOW()) AS n
		 ON DUPLICATE KEY UPDATE status = n.status, date_edit = NOW()`,
		[inv.id, inv.id_order, extRef, inv.amount, r.status || "processing", idUser || null]
	);
	await event(pool, inv, "hold_released", r.status || null, null, idUser);
	await applyRemote(inv.id, await api.status(acc.token, inv.invoice_id), "reconcile", idUser).catch(() => null);
	return forOrder(idOrder);
}

/** Позиції для форми повернення: з механізму повернень замовлення + скільки ще можна повернути з цього рахунку */
async function refundForm(idOrder, idInvoice) {
	const inv = await loadInvoice(idOrder, idInvoice);
	if (inv.status !== "success") throw httpErr(409, "modules.monobank.e.not_paid");
	const f = await orderRefunds.form(idOrder);
	const [[a]] = await pool.query(`SELECT settings FROM ${T.accounts} WHERE id = ?`, [inv.id_account]);
	const [[r]] = await pool.query(`SELECT COALESCE(SUM(amount), 0) AS s FROM ${T.refunds} WHERE id_invoice = ? AND status <> 'failure'`, [inv.id]);
	return {
		items: f.items.filter((x) => x.available > 0),
		shipping: Number(f.order.total_shipping) || 0,
		refundable: fromMinor(Math.max(0, Number(inv.amount) - Number(r.s))),
		currency: CCY_ISO[inv.ccy] || "",
		fiscal: !!accounts.settingsOf(a && a.settings).fiscal,
	};
}

/**
 * Повернення коштів на картку клієнта. Оформлюється через механізм повернень замовлення (суми, склад, журнал),
 * а запит до банку йде всередині тієї ж транзакції: банк відмовив — у системі нічого не змінилось.
 * body: { items: [{ id_item, qty, restock? }], shipping, amount?, reason, restock }
 * З ПРРО сума — лише з позицій (банк формує чек повернення по них).
 */
async function refund(idOrder, idInvoice, body, idUser) {
	const inv = await loadInvoice(idOrder, idInvoice);
	if (inv.status !== "success") throw httpErr(409, "modules.monobank.e.not_paid");
	const acc = await accounts.withToken(inv.id_account);
	const b = body || {};
	const form = await orderRefunds.form(idOrder);
	const byId = new Map(form.items.map((x) => [x.id, x]));
	const items = (Array.isArray(b.items) ? b.items : [])
		.map((x) => ({ id_item: parseInt(x.id_item, 10), qty: Number(x.qty) || 0, restock: x.restock !== false }))
		.filter((x) => x.id_item > 0 && x.qty > 0);
	const shipping = Math.max(0, Number(b.shipping) || 0);
	const amountOverride = acc.settings.fiscal ? null : Number(b.amount) > 0 ? Number(b.amount) : null;

	// Позиції чека повернення: обов'язкові з ПРРО; без ПРРО передаються, якщо сума не змінена вручну
	const fiscalItems = items.map((x) => {
		const it = byId.get(x.id_item);
		if (!it) throw httpErr(400, "modules.monobank.e.refund_items");
		return { name: String(it.name).slice(0, 128), qty: x.qty, sum: toMinor(it.unit), ...(it.sku ? { code: String(it.sku).slice(0, 64) } : {}) };
	});
	if (shipping > 0) fiscalItems.push({ name: String(acc.settings.shipping_name || "—").slice(0, 128), qty: 1, sum: toMinor(shipping) });
	if (acc.settings.fiscal && !fiscalItems.length) throw httpErr(400, "modules.monobank.e.refund_items");
	const sendItems = fiscalItems.length && !amountOverride;

	let out = null;
	await orderRefunds.create(
		idOrder,
		{ items, shipping, amount: amountOverride || undefined, reason: b.reason, restock: b.restock !== false, transaction_id: inv.invoice_id },
		idUser,
		{
			inTx: async (conn, r) => {
				const minor = toMinor(r.amount);
				const [[used]] = await conn.query(`SELECT COALESCE(SUM(amount), 0) AS s FROM ${T.refunds} WHERE id_invoice = ? AND status <> 'failure' FOR UPDATE`, [inv.id]);
				const left = Number(inv.amount) - Number(used.s);
				if (minor <= 0 || minor > left) throw httpErr(400, "modules.monobank.e.refund_amount", { max: fromMinor(left).toFixed(2) });
				const extRef = String(r.number).slice(0, 64);
				const res = await api.cancel(acc.token, {
					invoiceId: inv.invoice_id,
					extRef,
					...(minor < left || Number(used.s) > 0 ? { amount: minor } : {}),
					...(sendItems ? { items: fiscalItems } : {}),
				});
				if (res.status === "failure") throw httpErr(400, "modules.monobank.e.refund_failed");
				await conn.query(
					`INSERT INTO ${T.refunds} (id_invoice, id_order, id_refund, ext_ref, amount, status, items, id_user, date_add, date_edit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
					[inv.id, idOrder, r.id, extRef, minor, res.status || "processing", sendItems ? JSON.stringify(fiscalItems) : null, idUser || null]
				);
				await event(conn, inv, "refund", res.status || "processing", { number: r.number, amount: r.amount }, idUser);
				out = { number: r.number, amount: r.amount, status: res.status || "processing" };
			},
		}
	);
	// Новий стан рахунку (finalAmount, reversed) — не критично, якщо банк ще не оновив
	await applyRemote(inv.id, await api.status(acc.token, inv.invoice_id), "reconcile", idUser).catch(() => null);
	return { refund: out, ...(await forOrder(idOrder)) };
}

/** Фіскальні чеки рахунку (ПРРО в кабінеті Monobank). PDF у списку не віддаємо — окремим запитом */
async function fiscalChecks(idOrder, idInvoice) {
	const inv = await loadInvoice(idOrder, idInvoice);
	const acc = await accounts.withToken(inv.id_account);
	const r = await api.fiscalChecks(acc.token, inv.invoice_id);
	return {
		checks: (Array.isArray(r.checks) ? r.checks : []).map((c) => ({
			id: c.id,
			status: c.status,
			type: c.type,
			source: c.fiscalizationSource,
			description: c.statusDescription || null,
			tax_url: c.taxUrl || null,
			has_file: !!c.file,
		})),
	};
}

async function fiscalFile(idOrder, idInvoice, checkId) {
	const inv = await loadInvoice(idOrder, idInvoice);
	const acc = await accounts.withToken(inv.id_account);
	const r = await api.fiscalChecks(acc.token, inv.invoice_id);
	const c = (Array.isArray(r.checks) ? r.checks : []).find((x) => String(x.id) === String(checkId));
	if (!c || !c.file) throw httpErr(404, "modules.monobank.e.check_not_found");
	return { pdf: Buffer.from(c.file, "base64"), name: `check-${String(c.id).replace(/[^\w-]/g, "")}.pdf` };
}

/** Квитанція: з email — банк надсилає на пошту; без — PDF для перегляду */
async function receipt(idOrder, idInvoice, email, idUser) {
	const inv = await loadInvoice(idOrder, idInvoice);
	if (inv.status !== "success" && inv.status !== "reversed") throw httpErr(409, "modules.monobank.e.not_paid");
	if (email && !EMAIL_RE.test(String(email))) throw httpErr(400, "modules.monobank.e.email");
	const acc = await accounts.withToken(inv.id_account);
	const r = await api.receipt(acc.token, inv.invoice_id, email ? String(email).trim() : null);
	if (email) {
		await event(pool, inv, "receipt_sent", null, { email: String(email).trim() }, idUser);
		return { sent: true };
	}
	if (!r.file) throw httpErr(404, "modules.monobank.e.check_not_found");
	return { pdf: Buffer.from(r.file, "base64"), name: `receipt-${String(inv.invoice_id).replace(/[^\w-]/g, "")}.pdf` };
}

/** Копіювання посилання — у журнал, щоб бачити, хто й коли передав його клієнту */
async function logCopied(idOrder, idInvoice, idUser) {
	const inv = await loadInvoice(idOrder, idInvoice);
	await event(pool, inv, "copied", null, null, idUser);
	return {};
}

/** Журнал подій рахунку */
async function events(idOrder, idInvoice) {
	const inv = await loadInvoice(idOrder, idInvoice);
	const [rows] = await pool.query(
		`SELECT e.type, e.status, e.payload, e.date_add, ${userName("u")} AS user_name
		   FROM ${T.events} e LEFT JOIN ${P}users u ON u.id = e.id_user
		  WHERE e.id_invoice = ? ORDER BY e.id`,
		[inv.id]
	);
	return { rows: rows.map((r) => ({ type: r.type, status: r.status, payload: json(r.payload, null), user: r.user_name || null, date_add: r.date_add })) };
}

/**
 * Звірка за розкладом: відкриті рахунки (холд — до 10 днів) та рахунки з поверненнями в обробці.
 * Для простроченого посилання банк вебхук не шле — стан expired підтягується тут.
 */
async function reconcileDue(days) {
	const d = Math.max(1, Number(days) || 7);
	const [rows] = await pool.query(
		`SELECT i.id, i.id_account, i.invoice_id FROM ${T.invoices} i
		  WHERE i.date_edit < NOW() - INTERVAL 5 MINUTE
		    AND ((i.status IN (?) AND i.date_add > NOW() - INTERVAL ? DAY)
		         OR EXISTS (SELECT 1 FROM ${T.refunds} r WHERE r.id_invoice = i.id AND r.status = 'processing' AND r.date_add > NOW() - INTERVAL ? DAY))
		  ORDER BY i.id LIMIT 200`,
		[OPEN_STATES, Math.max(d, HOLD_DAYS + 1), d]
	);
	const tokens = new Map();
	for (const r of rows) {
		try {
			if (!tokens.has(r.id_account)) tokens.set(r.id_account, (await accounts.withToken(r.id_account)).token);
			await applyRemote(r.id, await api.status(tokens.get(r.id_account), r.invoice_id), "reconcile");
		} catch (e) {
			console.error(`[monobank] reconcile ${r.invoice_id}:`, e.message);
		}
	}
	return rows.length;
}

/* ───────────────────────── Збережені картки (токенізація) ───────────────────────── */

/**
 * Збережені картки клієнтів (токенізація Monobank; банк вмикає її для мерчанта на запит).
 *  - Картка зберігається, коли клієнт платить за посиланням із saveCardData (або за посиланням «перевірка картки»
 *    без списання): токен приходить у walletData вебхука й зберігається зашифрованим.
 *  - Гаманець = клієнт системи (walletId gc-<id клієнта>), окремо для кожного акаунта Monobank.
 *  - Оплата токеном — з картки замовлення, без участі клієнта (initiationKind merchant); стан — тим самим вебхуком.
 */

const cardHash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

/** Зберегти токен з вебхука / стану рахунку (у транзакції applyRemote) */
async function cardStore(conn, inv, data) {
	const w = data.walletData || {};
	if (!w.cardToken || !w.walletId) return;
	const m = /^gc-(\d+)$/.exec(String(w.walletId));
	const info = data.paymentInfo || {};
	const enc = cryptoHelper.encrypt(String(w.cardToken));
	await conn.query(
		`INSERT INTO ${T.cards} (id_account, id_client, wallet_id, token_cipher, token_iv, token_tag, token_hash, masked_pan, country, status, id_invoice, date_add, date_edit)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW()) AS n
		 ON DUPLICATE KEY UPDATE status = IF(${T.cards}.status = 'deleted', ${T.cards}.status, n.status), masked_pan = COALESCE(n.masked_pan, ${T.cards}.masked_pan), date_edit = NOW()`,
		[
			inv.id_account,
			m ? Number(m[1]) : null,
			str(w.walletId, 64),
			enc.cipher,
			enc.iv,
			enc.tag,
			cardHash(w.cardToken),
			str(info.maskedPan, 32),
			str(info.country, 8),
			["new", "created", "failed"].includes(w.status) ? w.status : "created",
			inv.id,
		]
	);
}

const cardPub = (r) => ({ id: Number(r.id), masked_pan: r.masked_pan, account: r.account_name || null, status: r.status, date_add: r.date_add });

/** Для панелі замовлення: чи можна зберігати картки, і картки клієнта в акаунті магазину */
async function cardsForOrder(o) {
	const acc = await accounts.forIntegration(o.id_integration).catch(() => null);
	const tokenization = !!(acc && acc.settings.tokenization);
	if (!tokenization || !(Number(o.id_client) > 0)) return { tokenization, client: Number(o.id_client) > 0, cards: [] };
	const [rows] = await pool.query(
		`SELECT c.*, a.name AS account_name FROM ${T.cards} c LEFT JOIN ${T.accounts} a ON a.id = c.id_account
		  WHERE c.id_account = ? AND c.id_client = ? AND c.status IN ('new', 'created') ORDER BY c.id DESC`,
		[acc.id, Number(o.id_client)]
	);
	return { tokenization, client: true, cards: rows.map(cardPub) };
}

async function loadCard(idCard) {
	const [[c]] = await pool.query(`SELECT * FROM ${T.cards} WHERE id = ? AND status IN ('new', 'created')`, [idCard]);
	if (!c) throw httpErr(404, "modules.monobank.e.card_not_found");
	const token = cryptoHelper.decrypt(c.token_cipher, c.token_iv, c.token_tag);
	if (!token) throw httpErr(409, "modules.monobank.e.token_broken");
	return { ...c, token };
}

async function orderClient(idOrder) {
	const [[o]] = await pool.query(`SELECT id_client FROM ${P}orders WHERE id = ?`, [idOrder]);
	return o ? Number(o.id_client) : 0;
}

/**
 * Оплата збереженою карткою. body: { card, amount?, payment_type? }.
 * Картка має належати клієнту цього замовлення й акаунту, через який платимо.
 */
async function cardPay(idOrder, body, idUser) {
	const c = await loadCard(Number(body.card));
	if (!c.id_client || c.id_client !== (await orderClient(idOrder))) throw httpErr(403, "modules.monobank.e.card_not_found");
	const p = await prepare(idOrder, { ...body, account_id: c.id_account });
	if (!p.acc.settings.tokenization) throw httpErr(409, "modules.monobank.e.no_tokenization");
	const res = await api.walletPayment(p.acc.token, {
		cardToken: c.token,
		amount: p.amount,
		ccy: p.ccy,
		initiationKind: "merchant",
		paymentType: p.paymentType,
		webHookUrl: webhookUrl(p.acc.id),
		merchantPaymInfo: { reference: p.reference.slice(0, 64), destination: p.destination },
		...(p.s.redirect_url ? { redirectUrl: p.s.redirect_url } : {}),
	});
	if (!res.invoiceId) throw httpErr(502, "modules.monobank.e.bad_response", { code: 200 });
	const invoice = await record(
		idOrder,
		p.acc,
		{
			source: "wallet",
			invoice_id: res.invoiceId,
			// Якщо банк вимагає 3-D Secure — повертає адресу підтвердження для клієнта
			page_url: res.tdsUrl || res.pageUrl || "",
			amount: p.amount,
			ccy: p.ccy,
			iso: p.iso,
			payment_type: p.paymentType,
			log: { card: c.masked_pan },
		},
		idUser
	);
	// Оплата токеном зазвичай проходить одразу — підтягуємо стан, не чекаючи вебхука
	if (res.status) await applyRemote(invoice.id, { ...res, amount: p.amount }, "reconcile", idUser).catch(() => null);
	return { invoice, tds: !!res.tdsUrl, ...(await forOrder(idOrder)) };
}

/** Посилання «перевірка картки»: клієнт зберігає картку без списання (сума 0) */
async function cardVerificationLink(idOrder, idUser) {
	const r = await create(idOrder, {}, idUser, { verification: true });
	return { invoice: r.invoice, ...(await forOrder(idOrder)) };
}

/** Видалити картку в банку й у системі */
async function cardRemove(idOrder, idCard, idUser) {
	const c = await loadCard(idCard);
	if (!c.id_client || c.id_client !== (await orderClient(idOrder))) throw httpErr(403, "modules.monobank.e.card_not_found");
	const acc = await accounts.withToken(c.id_account);
	await api.deleteCard(acc.token, c.token);
	await pool.query(`UPDATE ${T.cards} SET status = 'deleted', date_edit = NOW() WHERE id = ?`, [c.id]);
	await pool.query(`INSERT INTO ${T.events} (id_invoice, id_order, type, status, payload, id_user, date_add) VALUES (?, ?, 'card_deleted', NULL, ?, ?, NOW())`, [
		c.id_invoice,
		idOrder,
		JSON.stringify({ masked_pan: c.masked_pan }),
		idUser || null,
	]);
	return forOrder(idOrder);
}

/** Звірити картки клієнта з банком: видалені в банку — позначаються видаленими */
async function cardsRefresh(idOrder) {
	const idClient = await orderClient(idOrder);
	const wallet = walletId(idClient);
	if (!wallet) return forOrder(idOrder);
	const [accs] = await pool.query(`SELECT DISTINCT id_account FROM ${T.cards} WHERE id_client = ? AND status IN ('new', 'created')`, [idClient]);
	for (const a of accs) {
		const acc = await accounts.withToken(a.id_account);
		const r = await api.walletCards(acc.token, wallet);
		const alive = new Set((Array.isArray(r.wallet) ? r.wallet : []).map((x) => cardHash(x.cardToken)));
		const [mine] = await pool.query(`SELECT id, token_hash FROM ${T.cards} WHERE id_account = ? AND id_client = ? AND status IN ('new', 'created')`, [acc.id, idClient]);
		for (const c of mine) if (!alive.has(c.token_hash)) await pool.query(`UPDATE ${T.cards} SET status = 'deleted', date_edit = NOW() WHERE id = ?`, [c.id]);
	}
	return forOrder(idOrder);
}

/* ───────────────────────── Список замовлень: колонка, фільтр, масові дії ───────────────────────── */

/**
 * Monobank у списку замовлень: колонка «Monobank», фільтр за станом оплати й масові дії.
 * Підключається до списку через core/modules/orders (сервер) і хуки сторінки (браузер).
 */

/**
 * Стан оплати замовлення (від «найважливішого»):
 *  paid — є успішний платіж; hold — кошти заблоковано; awaiting — є відкрите посилання;
 *  failed — були лише невдалі спроби; lost — посилання прострочені / анульовані; none — посилань не було.
 */
const LIST_FILTERS = {
	paid: (a) => `EXISTS (SELECT 1 FROM ${T.invoices} mi WHERE mi.id_order = ${a}.id AND mi.payment_type <> 'verification' AND mi.status = 'success')`,
	hold: (a) => `EXISTS (SELECT 1 FROM ${T.invoices} mi WHERE mi.id_order = ${a}.id AND mi.payment_type <> 'verification' AND mi.status = 'hold')`,
	awaiting: (a) => `EXISTS (SELECT 1 FROM ${T.invoices} mi WHERE mi.id_order = ${a}.id AND mi.payment_type <> 'verification' AND mi.status IN ('created', 'processing'))`,
	refunded: (a) => `EXISTS (SELECT 1 FROM ${T.refunds} mr WHERE mr.id_order = ${a}.id AND mr.id_refund IS NOT NULL AND mr.status <> 'failure')`,
	failed: (a) => `EXISTS (SELECT 1 FROM ${T.invoices} mi WHERE mi.id_order = ${a}.id AND mi.payment_type <> 'verification' AND mi.status = 'failure')
	                AND NOT EXISTS (SELECT 1 FROM ${T.invoices} mi WHERE mi.id_order = ${a}.id AND mi.payment_type <> 'verification' AND mi.status IN ('success', 'hold', 'created', 'processing'))`,
	unpaid: (a) => `NOT EXISTS (SELECT 1 FROM ${T.invoices} mi WHERE mi.id_order = ${a}.id AND mi.payment_type <> 'verification' AND mi.status IN ('success', 'hold'))`,
	none: (a) => `NOT EXISTS (SELECT 1 FROM ${T.invoices} mi WHERE mi.id_order = ${a}.id AND mi.payment_type <> 'verification')`,
};

function listFilter(value, alias) {
	const f = LIST_FILTERS[String(value)];
	return f ? { sql: f(alias.replace(/[^\w]/g, "")), params: [] } : null;
}

/** Дані для колонки: стан, сплачено, повернено, відкрите посилання */
async function listRows(ids) {
	const out = new Map();
	if (!ids.length) return out;
	const [inv] = await pool.query(`SELECT id_order, status, amount, final_amount, ccy, page_url FROM ${T.invoices} WHERE id_order IN (?) AND payment_type <> 'verification' ORDER BY id DESC`, [ids]);
	const [rf] = await pool.query(`SELECT id_order, SUM(amount) AS s FROM ${T.refunds} WHERE id_order IN (?) AND id_refund IS NOT NULL AND status <> 'failure' GROUP BY id_order`, [ids]);
	const refunded = new Map(rf.map((r) => [Number(r.id_order), Number(r.s)]));
	const by = new Map();
	for (const r of inv) {
		const k = Number(r.id_order);
		if (!by.has(k)) by.set(k, []);
		by.get(k).push(r);
	}
	for (const [id, list] of by) {
		const has = (...st) => list.some((r) => st.includes(r.status));
		const state = has("success") ? "paid" : has("hold") ? "hold" : has("created", "processing") ? "awaiting" : has("failure") ? "failed" : "lost";
		const paid = list.filter((r) => r.status === "success").reduce((s, r) => s + Number(r.final_amount === null ? r.amount : r.final_amount), 0);
		const open = list.find((r) => (r.status === "created" || r.status === "processing") && r.page_url);
		out.set(id, {
			state,
			paid: fromMinor(paid),
			refunded: fromMinor(refunded.get(id) || 0),
			currency: CCY_ISO[list[0].ccy] || "",
			links: list.length,
			url: open ? open.page_url : null,
		});
	}
	return out;
}

/** Масово: посилання на залишок до сплати; пропускає сплачені й ті, де вже є відкрите посилання */
async function bulkCreate(targets, idUser, t, errText) {
	const done = [];
	const skipped = [];
	for (const o of targets) {
		try {
			const s = await forOrder(o.id);
			if (!s.supported) {
				skipped.push({ id: o.id, reference: o.reference, message: t("unsupported") });
				continue;
			}
			if (s.invoices.some((i) => i.status === "created" || i.status === "processing")) {
				skipped.push({ id: o.id, reference: o.reference, message: t("has_link") });
				continue;
			}
			if (!(toMinor(s.due) > 0)) {
				skipped.push({ id: o.id, reference: o.reference, message: t("nothing_due") });
				continue;
			}
			const r = await create(o.id, {}, idUser);
			done.push({ id: o.id, reference: o.reference, url: r.invoice.page_url, amount: r.invoice.amount, currency: r.invoice.currency });
		} catch (e) {
			skipped.push({ id: o.id, reference: o.reference, message: errText(e) });
		}
	}
	return { done: done.length, links: done, skipped };
}

/** Масово: оновити стан відкритих посилань і холдів з банку */
async function bulkRefresh(targets, idUser, errText) {
	let done = 0;
	const skipped = [];
	for (const o of targets) {
		const [list] = await pool.query(`SELECT id FROM ${T.invoices} WHERE id_order = ? AND status IN ('created', 'processing', 'hold')`, [o.id]);
		for (const r of list) {
			try {
				await refresh(o.id, r.id, idUser);
				done++;
			} catch (e) {
				skipped.push({ id: o.id, reference: o.reference, message: errText(e) });
			}
		}
	}
	return { done, skipped };
}

/** Відкриті посилання вибраних замовлень — щоб скопіювати одним списком */
async function bulkLinks(targets) {
	if (!targets.length) return { links: [] };
	const [found] = await pool.query(
		`SELECT id_order, page_url, amount, ccy FROM ${T.invoices} WHERE id_order IN (?) AND status IN ('created', 'processing') AND page_url <> '' ORDER BY id DESC`,
		[targets.map((o) => o.id)]
	);
	const ref = new Map(targets.map((o) => [Number(o.id), o.reference]));
	const seen = new Set();
	const links = [];
	for (const r of found) {
		if (seen.has(Number(r.id_order))) continue;
		seen.add(Number(r.id_order));
		links.push({ id: Number(r.id_order), reference: ref.get(Number(r.id_order)), url: r.page_url, amount: fromMinor(r.amount), currency: CCY_ISO[r.ccy] || "" });
	}
	return { links };
}

module.exports = {
	forOrder,
	create,
	refresh,
	invalidate,
	finalize,
	releaseHold,
	refundForm,
	refund,
	fiscalChecks,
	fiscalFile,
	receipt,
	logCopied,
	events,
	webhook,
	reconcileDue,
	applyRemote,
	prepare,
	record,
	walletId,
	loadInvoice,
	webhookUrl,
	cardsForOrder,
	cardPay,
	cardVerificationLink,
	cardRemove,
	cardsRefresh,
	listFilter,
	listRows,
	bulkCreate,
	bulkRefresh,
	bulkLinks,
	LIST_STATES: Object.keys(LIST_FILTERS),
};