"use strict";

/**
 * Фіскальні чеки замовлення: продаж, повернення (повне / за позиціями), статус, файли, повторне надсилання.
 * Чек створюється з нашим UUID і спершу записується в таблицю (CREATED): повтор запиту чи збій мережі
 * не створять другий чек, а стан дотягне синхронізація. Фіскалізація в Checkbox асинхронна (CREATED → DONE / ERROR).
 */
const crypto = require("crypto");
const { pool, P, T, httpErr, str, json, toMinor, fromMinor, phone380, EMAIL_RE, RECEIPT_OPEN } = require("./common");
const registers = require("./registers");
const shifts = registers.shifts;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAY_TYPES = ["CASH", "CASHLESS"];
const FILE_KINDS = { pdf: "application/pdf", html: "text/html; charset=utf-8", text: "text/plain; charset=utf-8", png: "image/png" };

async function event(db, idRegister, idOrder, type, payload, idUser) {
	await db.query(`INSERT INTO ${T.events} (id_register, id_order, type, payload, id_user, date_add) VALUES (?, ?, ?, ?, ?, NOW())`, [
		idRegister || null,
		idOrder || null,
		type,
		payload ? JSON.stringify(payload) : null,
		idUser || null,
	]);
}

async function orderEvent(idOrder, idUser, type, payload) {
	await pool.query(`INSERT INTO ${P}orders_events (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, ?, ?, ?, NOW())`, [
		idOrder,
		idUser || null,
		type,
		JSON.stringify({ provider: "checkbox", ...payload }),
		idUser ? "manual" : "system",
	]);
}

async function loadOrder(idOrder) {
	const [[o]] = await pool.query(`SELECT id, id_integration, reference, total, total_shipping, currency_iso, client FROM ${P}orders WHERE id = ? AND deleted_at IS NULL`, [idOrder]);
	if (!o) throw httpErr(404, "modules.checkbox.e.order_not_found");
	if (String(o.currency_iso || "UAH").toUpperCase() !== "UAH") throw httpErr(400, "modules.checkbox.e.currency", { cur: o.currency_iso });
	return o;
}

/** Контакти клієнта для доставки чека: картка клієнта → адреси замовлення */
async function contacts(o) {
	const c = json(o.client, {}) || {};
	const [addr] = await pool.query(`SELECT email, phone FROM ${P}orders_addresses WHERE id_order = ? ORDER BY type = 'billing' DESC, id`, [o.id]);
	const email = [c.email, ...addr.map((a) => a.email)].map((v) => String(v || "").trim()).find((v) => EMAIL_RE.test(v)) || null;
	const phone = [c.phone, ...addr.map((a) => a.phone)].map(phone380).find(Boolean) || null;
	return { email, phone };
}

const taxOf = (list) => (list && list.length ? list.map((c) => (/^\d+$/.test(c) ? Number(c) : c)) : undefined);

/**
 * Позиції чека із замовлення. Ціна за одиницю в копійках, кількість ×1000.
 * Знижка в рядку (сума не ділиться на кількість без залишку) — точна сума рядка через total_sum.
 */
async function goodsOf(o, reg) {
	const [items] = await pool.query(
		`SELECT id, sku, name, quantity, total, type FROM ${P}orders_items WHERE id_order = ? AND COALESCE(type, 'product') NOT IN ('shipping', 'discount') ORDER BY id`,
		[o.id]
	);
	const s = reg.settings;
	const goods = [];
	for (const it of items) {
		const qty = Number(it.quantity) || 0;
		const total = toMinor(it.total);
		if (qty <= 0 || total < 0) continue;
		const price = Math.round(total / qty);
		goods.push({
			good: { code: String(it.sku || "ITEM-" + it.id).slice(0, 64), name: String(it.name || "—").slice(0, 256), price, ...(taxOf(s.tax_codes) ? { tax: taxOf(s.tax_codes) } : {}) },
			quantity: Math.round(qty * 1000),
			...(price * qty !== total ? { total_sum: total } : {}),
			_line: it.id,
		});
	}
	const ship = toMinor(o.total_shipping);
	if (ship > 0)
		goods.push({
			good: { code: "SHIPPING", name: String(s.shipping_name || "—").slice(0, 256), price: ship, ...(taxOf(s.shipping_tax_codes) ? { tax: taxOf(s.shipping_tax_codes) } : {}) },
			quantity: 1000,
			_line: "shipping",
		});
	return goods;
}

const lineSum = (g) => (g.total_sum !== undefined ? g.total_sum : Math.round((g.good.price * g.quantity) / 1000));
const strip = (goods) => goods.map(({ _line, ...g }) => g);

function publicRow(r) {
	return {
		id: Number(r.id),
		receipt_id: r.receipt_id,
		type: r.type,
		status: r.status,
		total: fromMinor(r.total),
		payment_type: r.payment_type,
		serial: r.serial,
		fiscal_code: r.fiscal_code,
		fiscal_date: r.fiscal_date,
		tax_url: r.tax_url,
		related_id: r.related_id ? Number(r.related_id) : null,
		chain: r.chain || null,
		source: r.source,
		error: r.error,
		register: r.register_name || null,
		user: r.user_name || null,
		date_add: r.date_add,
	};
}

/** Оновити стан чека з Checkbox */
async function sync(row) {
	const reg = await registers.get(row.id_register);
	let r;
	try {
		r = await reg.api.receipt(row.receipt_id);
	} catch (e) {
		// Чека немає в Checkbox — запит не дійшов: позначаємо помилкою, можна видати знову
		if (e.http === 404) {
			await pool.query(`UPDATE ${T.receipts} SET status = 'ERROR', error = ?, date_edit = NOW() WHERE id = ?`, ["not found in Checkbox", row.id]);
			return "ERROR";
		}
		throw e;
	}
	await pool.query(
		`UPDATE ${T.receipts} SET status = ?, serial = COALESCE(?, serial), fiscal_code = COALESCE(?, fiscal_code), fiscal_date = COALESCE(?, fiscal_date),
		        tax_url = COALESCE(?, tax_url), total = COALESCE(?, total), date_edit = NOW() WHERE id = ?`,
		[
			String(r.status || row.status),
			r.serial || null,
			str(r.fiscal_code, 64),
			r.fiscal_date ? new Date(r.fiscal_date) : null,
			str(r.tax_url, 512),
			Number.isFinite(Number(r.total_sum)) ? Number(r.total_sum) : null,
			row.id,
		]
	);
	if (r.status === "ERROR" && row.status !== "ERROR") await registers.alertError(row.id_register, row.id_order, `${row.type} ${row.receipt_id}`, "checkbox_err_" + row.receipt_id);
	if (r.status === "DONE" && row.status !== "DONE" && row.id_order) await orderEvent(row.id_order, null, row.type === "RETURN" ? "receipt_return" : "receipt", { receipt: row.receipt_id, fiscal_code: r.fiscal_code, total: fromMinor(r.total_sum) });
	return r.status;
}

/** Після створення: кілька секунд чекаємо фіскалізацію, далі — синхронізація за розкладом */
async function settle(idRow) {
	for (let i = 0; i < 8; i++) {
		await sleep(i < 3 ? 700 : 1500);
		const [[row]] = await pool.query(`SELECT * FROM ${T.receipts} WHERE id = ?`, [idRow]);
		if (!row || !RECEIPT_OPEN.includes(row.status)) return;
		const st = await sync(row).catch(() => null);
		if (st && !RECEIPT_OPEN.includes(st)) return;
	}
}

/**
 * Відправити чек у Checkbox. Рядок пишемо до запиту (CREATED), щоб UUID був збережений навіть при обриві.
 * Помилка Checkbox — рядок ERROR із текстом, виняток далі.
 */
async function submit(reg, idOrder, type, body, meta, idUser) {
	const uuid = crypto.randomUUID();
	const payload = { id: uuid, ...body };
	const [ins] = await pool.query(
		`INSERT INTO ${T.receipts} (id_order, id_register, receipt_id, type, chain, id_chain, status, total, payment_type, related_id, id_refund, source, payload, id_user, date_add, date_edit)
		 VALUES (?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
		[idOrder || null, reg.id, uuid, type, meta.chain || null, meta.id_chain || null, meta.total, meta.payment_type || null, meta.related_id || null, meta.id_refund || null, meta.source || "manual", JSON.stringify(payload), idUser || null]
	);
	try {
		await shifts.ensureOpen(reg, idUser);
		// meta.send — інший метод Checkbox (передплата, післяплата); інакше продаж / повернення або службовий чек
		await (meta.send ? meta.send(payload) : type === "SERVICE_IN" || type === "SERVICE_OUT" ? reg.api.service(payload) : reg.api.sell(payload));
	} catch (e) {
		const msg = e.vars && e.vars.msg ? e.vars.msg : e.message;
		// Checkbox недоступний (мережа, збій сервера) — чек у черзі, відправиться повторно з тим самим UUID
		if (transient(e)) {
			await pool.query(`UPDATE ${T.receipts} SET status = 'QUEUED', error = ?, date_edit = NOW() WHERE id = ?`, [String(msg).slice(0, 1000), ins.insertId]);
			await event(pool, reg.id, idOrder, "queued", { type, receipt: uuid, message: msg }, idUser);
			return ins.insertId;
		}
		await pool.query(`UPDATE ${T.receipts} SET status = 'ERROR', error = ?, date_edit = NOW() WHERE id = ?`, [String(msg).slice(0, 1000), ins.insertId]);
		await event(pool, reg.id, idOrder, "error", { type, receipt: uuid, message: msg }, idUser);
		// Автоматичний чек (без користувача) — сповіщення; вручну помилку видно одразу
		if (!idUser) await registers.alertError(reg.id, idOrder, msg, "checkbox_err_" + uuid);
		throw e;
	}
	await event(pool, reg.id, idOrder, type === "RETURN" ? "return" : type.startsWith("SERVICE") ? "service" : "receipt", { receipt: uuid, total: fromMinor(meta.total), source: meta.source }, idUser);
	await settle(ins.insertId);
	return ins.insertId;
}

/** Тимчасова недоступність Checkbox: мережа, тайм-аут, 5xx, обмеження частоти — повторюємо пізніше */
function transient(e) {
	if (!e) return false;
	if (e.http === undefined) return e.status === 502; // network / bad_response без HTTP-відповіді
	return e.http >= 500 || e.http === 429;
}

/**
 * Повторна відправка чека з черги (QUEUED): той самий UUID і тіло. Метод — за типом чека:
 * службовий / передплата (новий ланцюжок) / доплата в ланцюжок / продаж і повернення.
 * Checkbox відповів, що чек з таким id уже є, — запит дійшов раніше: просто синхронізуємо.
 */
async function resend(row) {
	const reg = await registers.get(row.id_register);
	const payload = json(row.payload, {}) || {};
	// У нашому payload повернення є службове поле _index — у Checkbox не відправляємо
	if (Array.isArray(payload.goods)) payload.goods = payload.goods.map(({ _index, ...g }) => g);
	let sender;
	if (row.type === "SERVICE_IN" || row.type === "SERVICE_OUT") sender = (p) => reg.api.service(p);
	else if (row.chain === "pre" && payload.custom_relation_id) sender = (p) => reg.api.prepay(p);
	else if ((row.chain === "pre" || row.chain === "after") && row.id_chain) {
		const [[c]] = await pool.query(`SELECT relation_id FROM ${T.chains} WHERE id = ?`, [row.id_chain]);
		if (!c) throw httpErr(409, "modules.checkbox.e.no_chain");
		sender = (p) => reg.api.afterpay(c.relation_id, p);
	} else sender = (p) => reg.api.sell(p);
	try {
		await shifts.ensureOpen(reg, null);
		await sender(payload);
	} catch (e) {
		const msg = e.vars && e.vars.msg ? e.vars.msg : e.message;
		if (transient(e)) {
			await pool.query(`UPDATE ${T.receipts} SET error = ?, date_edit = NOW() WHERE id = ?`, [String(msg).slice(0, 1000), row.id]);
			return "QUEUED";
		}
		if (/already|exist|вже існує|unique/i.test(String(msg))) {
			await pool.query(`UPDATE ${T.receipts} SET status = 'CREATED', error = NULL, date_edit = NOW() WHERE id = ?`, [row.id]);
			return sync({ ...row, status: "CREATED" });
		}
		await pool.query(`UPDATE ${T.receipts} SET status = 'ERROR', error = ?, date_edit = NOW() WHERE id = ?`, [String(msg).slice(0, 1000), row.id]);
		await event(pool, reg.id, row.id_order, "error", { type: row.type, receipt: row.receipt_id, message: msg, resend: true }, null);
		await registers.alertError(reg.id, row.id_order, msg, "checkbox_err_" + row.receipt_id);
		return "ERROR";
	}
	await pool.query(`UPDATE ${T.receipts} SET status = 'CREATED', error = NULL, date_edit = NOW() WHERE id = ?`, [row.id]);
	await event(pool, reg.id, row.id_order, "resent", { receipt: row.receipt_id }, null);
	await settle(row.id);
	return "CREATED";
}

/** Поля CardPaymentPayload Checkbox із даних банку (лише відомі й непорожні) */
function cardDetails(p) {
	const out = {};
	const map = { card_mask: 64, bank_name: 128, auth_code: 64, rrn: 64, payment_system: 64, terminal: 64, transaction_id: 128, acquiring: 128 };
	for (const [k, n] of Object.entries(map)) if (p[k]) out[k] = String(p[k]).slice(0, n);
	return out;
}

function paymentOf(type, value, label, reg) {
	const t = PAY_TYPES.includes(type) ? type : "CASHLESS";
	return { type: t, value, ...(t === "CASHLESS" ? { label: String(label || reg.settings.cashless_label || "").slice(0, 128) || undefined } : label ? { label: String(label).slice(0, 128) } : {}) };
}

/**
 * Чек продажу для замовлення. body: { register?, payment_type, label?, email?, phone?, force? }.
 * Повторний чек на замовлення, де вже є чинний чек продажу, — лише з force (захист від подвійної фіскалізації).
 */
async function sell(idOrder, body, idUser, opts = {}) {
	const b = body || {};
	const o = await loadOrder(idOrder);
	const reg = b.register ? await registers.get(Number(b.register)) : await registers.forIntegration(o.id_integration);
	if (!reg || !reg.status) throw httpErr(409, "modules.checkbox.e.no_register");
	if (!b.force) {
		const [[ex]] = await pool.query(
			`SELECT COUNT(*) AS n FROM ${T.receipts} WHERE id_order = ? AND type = 'SELL' AND status IN ('QUEUED', 'CREATED', 'DONE')
			    AND NOT EXISTS (SELECT 1 FROM ${T.receipts} r2 WHERE r2.related_id = ${T.receipts}.id AND r2.type = 'RETURN' AND r2.status = 'DONE' AND r2.total >= ${T.receipts}.total)`,
			[idOrder]
		);
		const [[et]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.ettn} WHERE id_order = ? AND status IN ('CREATED', 'DONE', 'DONE_WITHOUT_SMS')`, [idOrder]);
		if (Number(ex.n) || Number(et.n)) throw httpErr(409, "modules.checkbox.e.already_fiscal");
	}
	const goods = await goodsOf(o, reg);
	if (!goods.length) throw httpErr(400, "modules.checkbox.e.no_goods");
	const total = goods.reduce((s, g) => s + lineSum(g), 0);
	if (total <= 0) throw httpErr(400, "modules.checkbox.e.no_goods");
	const c = await contacts(o);
	const email = b.email !== undefined ? String(b.email || "").trim() : reg.settings.send_email ? c.email : null;
	const phone = b.phone !== undefined ? phone380(b.phone) : reg.settings.send_sms ? c.phone : null;
	if (email && !EMAIL_RE.test(email)) throw httpErr(400, "modules.checkbox.e.email");
	// Деталі безготівкової оплати (маска картки, RRN, код авторизації — з банку) потрапляють у чек
	const payment = { ...paymentOf(b.payment_type, total, b.label, reg), ...(b.payment_type === "CASHLESS" && b.payment && typeof b.payment === "object" ? cardDetails(b.payment) : {}) };
	const id = await submit(
		reg,
		idOrder,
		"SELL",
		{
			goods: strip(goods),
			payments: [payment],
			...(email || phone ? { delivery: { ...(email ? { emails: [email] } : {}), ...(phone ? { phone } : {}) } } : {}),
			...(reg.settings.header ? { header: reg.settings.header } : {}),
			footer: [reg.settings.footer, `№ ${o.reference || o.id}`].filter(Boolean).join("\n"),
			context: { order: String(o.reference || o.id) },
		},
		{ total, payment_type: payment.type, source: opts.source || "manual" },
		idUser
	);
	return { id, ...(await forOrder(idOrder)) };
}

/** Позиції чека продажу для форми повернення (з того, що відправлено в Checkbox) мінус уже повернене */
async function returnForm(idOrder, idReceipt) {
	const sale = await loadReceipt(idOrder, idReceipt);
	if (sale.type !== "SELL" || sale.status !== "DONE") throw httpErr(409, "modules.checkbox.e.not_returnable");
	// Чеки ланцюжка передплати повертаються лише всім ланцюжком
	if (sale.chain) throw httpErr(409, "modules.checkbox.e.chain_return_only");
	const goods = (json(sale.payload, {}) || {}).goods || [];
	const back = await returnedQty(sale.id);
	return {
		items: goods
			.map((g, i) => ({ index: i, code: g.good.code, name: g.good.name, price: fromMinor(lineSum(g) / (g.quantity / 1000)), quantity: g.quantity / 1000, returned: (back[i] || 0) / 1000 }))
			.filter((x) => x.quantity > x.returned),
		payment_type: sale.payment_type,
	};
}

async function returnedQty(idSale) {
	const [rows] = await pool.query(`SELECT payload FROM ${T.receipts} WHERE related_id = ? AND type = 'RETURN' AND status IN ('QUEUED', 'CREATED', 'DONE')`, [idSale]);
	const out = {};
	for (const r of rows) for (const g of (json(r.payload, {}) || {}).goods || []) if (g._index !== undefined) out[g._index] = (out[g._index] || 0) + g.quantity;
	return out;
}

/**
 * Чек повернення до чека продажу. body: { items: [{ index, qty }] } — порожньо: усе, що ще не повернено.
 * opts.id_refund — повернення замовлення, до якого належить чек.
 */
async function refund(idOrder, idReceipt, body, idUser, opts = {}) {
	const sale = await loadReceipt(idOrder, idReceipt);
	if (sale.type !== "SELL" || sale.status !== "DONE") throw httpErr(409, "modules.checkbox.e.not_returnable");
	if (sale.chain) throw httpErr(409, "modules.checkbox.e.chain_return_only");
	const reg = await registers.get(sale.id_register);
	const src = (json(sale.payload, {}) || {}).goods || [];
	const back = await returnedQty(sale.id);
	const want = Array.isArray((body || {}).items) && body.items.length ? body.items : src.map((g, i) => ({ index: i, qty: (g.quantity - (back[i] || 0)) / 1000 }));
	const goods = [];
	for (const w of want) {
		const g = src[Number(w.index)];
		if (!g) throw httpErr(400, "modules.checkbox.e.return_items");
		const left = g.quantity - (back[Number(w.index)] || 0);
		const q = Math.min(left, Math.round(Number(w.qty) * 1000));
		if (q <= 0) continue;
		// Пропорційна частина рядка з точною сумою (знижки рядка)
		const sum = Math.round((lineSum(g) * q) / g.quantity);
		goods.push({ good: g.good, quantity: q, is_return: true, ...(sum !== Math.round((g.good.price * q) / 1000) ? { total_sum: sum } : {}), _index: Number(w.index) });
	}
	if (!goods.length) throw httpErr(400, "modules.checkbox.e.return_items");
	const total = goods.reduce((s, g) => s + lineSum(g), 0);
	const payment = (json(sale.payload, {}).payments || [])[0] || { type: sale.payment_type || "CASHLESS" };
	const c = await contacts(await loadOrder(idOrder));
	const payload = {
		goods: goods.map(({ _index, ...g }) => g),
		payments: [{ ...payment, value: total }],
		related_receipt_id: sale.receipt_id,
		...(reg.settings.send_email && c.email ? { delivery: { emails: [c.email] } } : {}),
	};
	// _index зберігаємо в нашому payload, щоб рахувати вже повернене по рядках
	const id = await submit(reg, idOrder, "RETURN", payload, { total, payment_type: payment.type, related_id: sale.id, id_refund: opts.id_refund, source: opts.source || "manual" }, idUser);
	await pool.query(`UPDATE ${T.receipts} SET payload = JSON_SET(payload, '$.goods', CAST(? AS JSON)) WHERE id = ?`, [JSON.stringify(goods), id]);
	return { id, ...(await forOrder(idOrder)) };
}

async function loadReceipt(idOrder, idReceipt) {
	const [[r]] = await pool.query(`SELECT * FROM ${T.receipts} WHERE id = ? AND id_order = ?`, [idReceipt, idOrder]);
	if (!r) throw httpErr(404, "modules.checkbox.e.receipt_not_found");
	return r;
}

async function refresh(idOrder, idReceipt) {
	await sync(await loadReceipt(idOrder, idReceipt));
	return forOrder(idOrder);
}

/** Файл чека з Checkbox: pdf, html, text, png */
async function file(idOrder, idReceipt, kind) {
	if (!FILE_KINDS[kind]) throw httpErr(400, "modules.checkbox.e.bad_id");
	const r = await loadReceipt(idOrder, idReceipt);
	if (r.status !== "DONE") throw httpErr(409, "modules.checkbox.e.not_done");
	const reg = await registers.get(r.id_register);
	const f = await reg.api.receiptFile(r.receipt_id, kind);
	const buffer = f.buffer || Buffer.from(f.text !== undefined ? f.text : JSON.stringify(f.data || ""), "utf8");
	return { buffer, type: FILE_KINDS[kind], name: `receipt-${r.fiscal_code || r.receipt_id}.${kind === "text" ? "txt" : kind}` };
}

/** Надіслати чек ще раз: email або SMS (SMS — платна послуга Checkbox) */
async function send(idOrder, idReceipt, body, idUser) {
	const r = await loadReceipt(idOrder, idReceipt);
	if (r.status !== "DONE") throw httpErr(409, "modules.checkbox.e.not_done");
	const reg = await registers.get(r.id_register);
	const email = String((body || {}).email || "").trim();
	const phone = phone380((body || {}).phone);
	if (!email && !phone) throw httpErr(400, "modules.checkbox.e.contact_required");
	if (email && !EMAIL_RE.test(email)) throw httpErr(400, "modules.checkbox.e.email");
	if (email) await reg.api.sendEmail(r.receipt_id, [email]);
	if (phone) await reg.api.sendSms(r.receipt_id, phone);
	await event(pool, r.id_register, idOrder, "sent", { receipt: r.receipt_id, email: email || undefined, phone: phone || undefined }, idUser);
	return { sent: true };
}

/** Дані для панелі в картці замовлення: чеки, ЕТТН, каси, відправлення НП, контакти */
async function forOrder(idOrder) {
	const o = await loadOrder(idOrder).catch((e) => (e.status === 400 ? null : Promise.reject(e)));
	const [regs] = await pool.query(`SELECT id, name, is_default, settings FROM ${T.registers} WHERE status = 1 ORDER BY is_default DESC, name`);
	if (!o) return { supported: false, registers: regs.length };
	const [rows] = await pool.query(
		`SELECT r.*, g.name AS register_name, TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS user_name
		   FROM ${T.receipts} r LEFT JOIN ${T.registers} g ON g.id = r.id_register LEFT JOIN ${P}users u ON u.id = r.id_user
		  WHERE r.id_order = ? ORDER BY r.id DESC`,
		[idOrder]
	);
	const [ettn] = await pool.query(`SELECT e.*, g.name AS register_name FROM ${T.ettn} e LEFT JOIN ${T.registers} g ON g.id = e.id_register WHERE e.id_order = ? ORDER BY e.id DESC`, [idOrder]);
	const [ships] = await pool.query(
		`SELECT id, tracking_number, raw FROM ${P}orders_shipments WHERE id_order = ? AND carrier = 'novaposhta' AND tracking_number IS NOT NULL AND tracking_number <> '' ORDER BY id`,
		[idOrder]
	);
	const reg = await registers.forIntegration(o.id_integration).catch(() => null);
	const goods = reg ? await goodsOf(o, reg) : [];
	return {
		supported: true,
		registers: regs.map((r) => ({ id: Number(r.id), name: r.name, is_default: !!Number(r.is_default) })),
		register: reg ? reg.id : null,
		cashless_label: reg ? reg.settings.cashless_label : "",
		total: fromMinor(goods.reduce((s, g) => s + lineSum(g), 0)),
		contacts: await contacts(o),
		receipts: rows.map(publicRow),
		chain: await chainForOrder(idOrder),
		ettn: ettn.map((e) => ({
			id: Number(e.id),
			ttn: e.ttn,
			status: e.status,
			total: fromMinor(e.total),
			error: e.error,
			has_receipt: !!e.receipt_id,
			register: e.register_name,
			last_check: e.last_check,
			date_add: e.date_add,
		})),
		shipments: ships
			.filter((s) => !ettn.some((e) => e.ttn === s.tracking_number && e.status !== "CANCELLED" && e.status !== "ERROR"))
			.map((s) => ({ id: Number(s.id), ttn: s.tracking_number, cod: Number((json(s.raw, {}) || {}).cod) || 0 })),
	};
}

/* ───────────────────────── Усі чеки кас (сторінка «Чеки», Tabulator remote) ───────────────────────── */

const LIST_SORT = { date_add: "r.date_add", total: "r.total", fiscal_date: "r.fiscal_date", status: "r.status" };

async function listAll(body) {
	const b = body || {};
	const f = b.filter || {};
	const w = ["1 = 1"];
	const p = [];
	if (Number(f.register) > 0) {
		w.push("r.id_register = ?");
		p.push(Number(f.register));
	}
	if (["SELL", "RETURN", "SERVICE_IN", "SERVICE_OUT"].includes(f.type)) {
		w.push("r.type = ?");
		p.push(f.type);
	}
	if (["QUEUED", "CREATED", "DONE", "ERROR"].includes(f.status)) {
		w.push("r.status = ?");
		p.push(f.status);
	}
	if (["manual", "auto", "ettn", "service"].includes(f.source)) {
		w.push("r.source = ?");
		p.push(f.source);
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(String(f.from || ""))) {
		w.push("r.date_add >= ?");
		p.push(f.from + " 00:00:00");
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(String(f.to || ""))) {
		w.push("r.date_add <= ?");
		p.push(f.to + " 23:59:59");
	}
	const q = String(f.q || "").trim();
	if (q) {
		w.push("(r.fiscal_code = ? OR r.receipt_id = ? OR o.reference = ? OR CAST(r.id_order AS CHAR) = ?)");
		p.push(q, q, q, q);
	}
	const size = Math.min(200, Math.max(10, Number(b.size) || 50));
	const page = Math.max(1, Number(b.page) || 1);
	const s0 = Array.isArray(b.sort) && b.sort[0] ? b.sort[0] : null;
	const order = s0 && LIST_SORT[s0.field] ? `${LIST_SORT[s0.field]} ${s0.dir === "asc" ? "ASC" : "DESC"}` : "r.id DESC";
	const base = `FROM ${T.receipts} r LEFT JOIN ${T.registers} g ON g.id = r.id_register LEFT JOIN ${P}orders o ON o.id = r.id_order WHERE ${w.join(" AND ")}`;
	const [[c]] = await pool.query(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN r.status = 'DONE' AND r.type = 'SELL' THEN r.total END), 0) AS sell, COALESCE(SUM(CASE WHEN r.status = 'DONE' AND r.type = 'RETURN' THEN r.total END), 0) AS ret ${base}`, p);
	const [rows] = await pool.query(
		`SELECT r.*, g.name AS register_name, o.reference AS order_reference, TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS user_name
		   ${base.replace("WHERE", `LEFT JOIN ${P}users u ON u.id = r.id_user WHERE`)} ORDER BY ${order}, r.id DESC LIMIT ? OFFSET ?`,
		[...p, size, (page - 1) * size]
	);
	return {
		last_page: Math.max(1, Math.ceil(Number(c.n) / size)),
		total: Number(c.n),
		sums: { sell: fromMinor(c.sell), returns: fromMinor(c.ret) },
		data: rows.map((r) => ({ ...publicRow(r), id_order: r.id_order ? Number(r.id_order) : null, order_reference: r.order_reference })),
	};
}

/** Файл чека зі сторінки «Чеки» (чек може бути без замовлення — службовий) */
async function fileById(idReceipt, kind) {
	const [[r]] = await pool.query(`SELECT id, id_order FROM ${T.receipts} WHERE id = ?`, [idReceipt]);
	if (!r) throw httpErr(404, "modules.checkbox.e.receipt_not_found");
	if (r.id_order) return file(r.id_order, r.id, kind);
	if (!FILE_KINDS[kind]) throw httpErr(400, "modules.checkbox.e.bad_id");
	const [[row]] = await pool.query(`SELECT * FROM ${T.receipts} WHERE id = ?`, [idReceipt]);
	if (row.status !== "DONE") throw httpErr(409, "modules.checkbox.e.not_done");
	const reg = await registers.get(row.id_register);
	const f = await reg.api.receiptFile(row.receipt_id, kind);
	const buffer = f.buffer || Buffer.from(f.text !== undefined ? f.text : JSON.stringify(f.data || ""), "utf8");
	return { buffer, type: FILE_KINDS[kind], name: `receipt-${row.fiscal_code || row.receipt_id}.${kind === "text" ? "txt" : kind}` };
}

/* ───────────────────────── Вебхук Checkbox ───────────────────────── */

/**
 * Запит від Checkbox (фіскалізація чека, зміна, службовий чек). Підпис: base64(HMAC-SHA256(ключ каси, сире тіло))
 * у заголовку x-request-signature. Стан беремо не з тіла, а повторним запитом до Checkbox (sync) — тіло лише сигнал.
 * Невідомий чек каси — можливо, чек ЕТТН (посилку отримано): одразу перевіряємо відкриті ЕТТН каси.
 */
async function onWebhook(idRegister, raw, sign) {
	if (!idRegister) throw httpErr(400, "bad register");
	const key = await registers.webhookKey(idRegister);
	if (!key) throw httpErr(401, "webhook not configured");
	const expected = crypto.createHmac("sha256", key).update(raw).digest();
	let got;
	try {
		got = Buffer.from(String(sign || ""), "base64");
	} catch (e) {
		got = Buffer.alloc(0);
	}
	if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) throw httpErr(401, "bad signature");
	const body = json(raw.toString("utf8"), null);
	if (!body || typeof body !== "object") throw httpErr(400, "bad body");
	// Формат обгортки Checkbox не задокументований: шукаємо чек у тілі, receipt або data
	const obj = [body.receipt, body.data, body].find((x) => x && typeof x === "object" && x.id && (x.fiscal_code !== undefined || x.goods || x.payments)) || null;
	await event(pool, idRegister, null, "webhook", { kind: body.type || body.event || (obj ? "receipt" : "other"), id: obj ? obj.id : body.id || null }, null);
	if (!obj) return { ignored: true };
	const [[row]] = await pool.query(`SELECT * FROM ${T.receipts} WHERE receipt_id = ? AND id_register = ?`, [String(obj.id), idRegister]);
	if (row) {
		await sync(row);
		return { synced: true };
	}
	await require("./ettn").syncRegister(idRegister);
	return { ettn: true };
}

/** Синхронізація за розкладом: чеки, що зависли в CREATED (старші за хвилину) */
async function syncDue() {
	// Черга (Checkbox був недоступний): по порядку, щоб чеки йшли в тій послідовності, у якій видавались
	const [queued] = await pool.query(`SELECT * FROM ${T.receipts} WHERE status = 'QUEUED' AND date_edit < NOW() - INTERVAL 1 MINUTE AND date_add > NOW() - INTERVAL 3 DAY ORDER BY id LIMIT 100`);
	for (const r of queued) {
		const st = await resend(r).catch((e) => console.error(`[checkbox] resend ${r.receipt_id}:`, e.message));
		if (st === "QUEUED") break; // Checkbox досі недоступний — решту спробуємо наступного разу
	}
	const [rows] = await pool.query(`SELECT * FROM ${T.receipts} WHERE status IN (?) AND date_edit < NOW() - INTERVAL 1 MINUTE AND date_add > NOW() - INTERVAL 7 DAY ORDER BY id LIMIT 100`, [RECEIPT_OPEN]);
	for (const r of rows) await sync(r).catch((e) => console.error(`[checkbox] receipt ${r.receipt_id}:`, e.message));
	return queued.length + rows.length;
}

/** Вручну: відправити чек з черги зараз (кнопка в картці замовлення) */
async function retry(idOrder, idReceipt) {
	const r = await loadReceipt(idOrder, idReceipt);
	if (r.status !== "QUEUED") throw httpErr(409, "modules.checkbox.e.not_queued");
	await resend(r);
	return forOrder(idOrder);
}

/** Службове внесення / видача готівки (інкасація). amount — гривні; > 0 внесення, < 0 видача */
async function service(idRegister, amount, idUser) {
	const reg = await registers.get(idRegister);
	const v = toMinor(amount);
	if (!v) throw httpErr(400, "modules.checkbox.e.amount");
	await submit(reg, null, v > 0 ? "SERVICE_IN" : "SERVICE_OUT", { payment: { type: "CASH", value: v } }, { total: v, payment_type: "CASH", source: "service" }, idUser);
	return {};
}

/* ───────────────────────── Передплата й післяплата (ланцюжок чеків) ───────────────────────── */

/**
 * Передплата й післяплата (ланцюжок чеків Checkbox).
 *  - Чек передплати: усі товари замовлення + отримана частина суми. Номер ланцюжка задаємо самі
 *    (custom_relation_id = GC-<замовлення>-<випадкове>), тому після обриву зв'язку ланцюжок знаходиться за ним же.
 *  - Доплата: сума менша за залишок — ще одна передплата; дорівнює (або більша, готівкою з рештою) — чек післяплати.
 *  - Післяплата накладеним платежем: ЕТТН на залишок (controllers/ettn) — Checkbox видає чек при отриманні посилки.
 *  - Повернення — лише всього ланцюжка (так працює Checkbox): по чеку повернення на кожен чек ланцюжка.
 */

/** Відкритий ланцюжок замовлення (не скасований) */
async function openChain(idOrder) {
	const [[c]] = await pool.query(`SELECT * FROM ${T.chains} WHERE id_order = ? AND status NOT IN ('CANCELLED', 'PARTIAL_CANCELLED') ORDER BY id DESC LIMIT 1`, [idOrder]);
	return c || null;
}

/** Стан ланцюжка з Checkbox → таблиця */
async function refreshChain(chain) {
	const reg = await registers.get(chain.id_register);
	const r = await reg.api.chain(chain.relation_id);
	await pool.query(`UPDATE ${T.chains} SET status = ?, total = ?, paid = ?, left_to_pay = ?, raw = ?, date_edit = NOW() WHERE id = ?`, [
		String(r.pre_payment_status || chain.status).slice(0, 24),
		Number(r.total_sum) || chain.total,
		Number(r.paid_sum) || 0,
		Math.max(0, Number(r.left_to_pay) || 0),
		JSON.stringify(r),
		chain.id,
	]);
	return r;
}

function pub(c) {
	return c ? { id: Number(c.id), relation_id: c.relation_id, status: c.status, total: fromMinor(c.total), paid: fromMinor(c.paid), left: fromMinor(c.left_to_pay) } : null;
}

async function delivery(o, reg) {
	const c = await contacts(o);
	return reg.settings.send_email && c.email && EMAIL_RE.test(c.email) ? { delivery: { emails: [c.email] } } : {};
}

/**
 * Чек передплати (перший у ланцюжку або додатковий). body: { amount, payment_type, label?, payment? }.
 * Якщо ланцюжок уже є — це доплата через pay().
 */
async function prepay(idOrder, body, idUser, opts = {}) {
	const b = body || {};
	const ex = await openChain(idOrder);
	if (ex) return pay(idOrder, b, idUser, opts);
	const o = await loadOrder(idOrder);
	const reg = b.register ? await registers.get(Number(b.register)) : await registers.forIntegration(o.id_integration);
	if (!reg || !reg.status) throw httpErr(409, "modules.checkbox.e.no_register");
	const [[sold]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.receipts} WHERE id_order = ? AND type = 'SELL' AND status IN ('QUEUED', 'CREATED', 'DONE')`, [idOrder]);
	if (Number(sold.n)) throw httpErr(409, "modules.checkbox.e.already_fiscal");
	const goods = await goodsOf(o, reg);
	const total = goods.reduce((s, g) => s + lineSum(g), 0);
	const amount = toMinor(b.amount);
	if (!(amount > 0) || amount >= total) throw httpErr(400, "modules.checkbox.e.prepay_amount", { total: fromMinor(total).toFixed(2) });

	const relation = `GC-${o.id}-${crypto.randomBytes(4).toString("hex")}`;
	const [ins] = await pool.query(
		`INSERT INTO ${T.chains} (id_order, id_register, relation_id, status, total, paid, left_to_pay, id_user, date_add, date_edit) VALUES (?, ?, ?, 'PARTIAL_PAID', ?, 0, ?, ?, NOW(), NOW())`,
		[o.id, reg.id, relation, total, total, idUser || null]
	);
	const pay0 = { ...paymentOf(b.payment_type, amount, b.label, reg), ...(b.payment_type === "CASHLESS" && b.payment ? cardDetails(b.payment) : {}) };
	try {
		await submit(
			reg,
			o.id,
			"SELL",
			{
				goods: strip(goods),
				payments: [pay0],
				custom_relation_id: relation,
				...(await delivery(o, reg)),
				footer: [reg.settings.footer, `№ ${o.reference || o.id}`].filter(Boolean).join("\n"),
			},
			{ total: amount, payment_type: pay0.type, chain: "pre", id_chain: ins.insertId, source: opts.source || "manual", send: (p) => reg.api.prepay(p) },
			idUser
		);
	} catch (e) {
		// Checkbox не створив ланцюжок — прибираємо наш запис
		await pool.query(`DELETE FROM ${T.chains} WHERE id = ? AND NOT EXISTS (SELECT 1 FROM ${T.receipts} WHERE id_chain = ? AND status IN ('QUEUED', 'CREATED', 'DONE'))`, [ins.insertId, ins.insertId]);
		throw e;
	}
	await refreshChain({ id: ins.insertId, id_register: reg.id, relation_id: relation, status: "PARTIAL_PAID", total }).catch(() => null);
	await orderEvent(o.id, idUser, "receipt_prepayment", { relation, amount: fromMinor(amount) });
	return forOrder(o.id);
}

/** Доплата в ланцюжок: менша за залишок — ще передплата, інакше — чек післяплати. amount порожньо — увесь залишок */
async function pay(idOrder, body, idUser, opts = {}) {
	const b = body || {};
	const chain = await openChain(idOrder);
	if (!chain) throw httpErr(409, "modules.checkbox.e.no_chain");
	await refreshChain(chain).catch(() => null);
	const [[c]] = await pool.query(`SELECT * FROM ${T.chains} WHERE id = ?`, [chain.id]);
	if (!(c.left_to_pay > 0)) throw httpErr(409, "modules.checkbox.e.chain_paid");
	const [[et]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.ettn} WHERE id_order = ? AND status = 'CREATED'`, [idOrder]);
	if (Number(et.n)) throw httpErr(409, "modules.checkbox.e.chain_has_ettn");
	const reg = await registers.get(c.id_register);
	const amount = b.amount !== undefined && b.amount !== null && b.amount !== "" ? toMinor(b.amount) : c.left_to_pay;
	if (!(amount > 0)) throw httpErr(400, "modules.checkbox.e.amount");
	const after = amount >= c.left_to_pay;
	const o = await loadOrder(idOrder);
	const p = { ...paymentOf(b.payment_type, amount, b.label, reg), ...(b.payment_type === "CASHLESS" && b.payment ? cardDetails(b.payment) : {}) };
	await submit(
		reg,
		idOrder,
		"SELL",
		{ payments: [p], ...(await delivery(o, reg)) },
		{ total: after ? c.left_to_pay : amount, payment_type: p.type, chain: after ? "after" : "pre", id_chain: c.id, source: opts.source || "manual", send: (pl) => reg.api.afterpay(c.relation_id, pl) },
		idUser
	);
	await refreshChain(c).catch(() => null);
	await orderEvent(idOrder, idUser, after ? "receipt_afterpayment" : "receipt_prepayment", { relation: c.relation_id, amount: fromMinor(amount) });
	return forOrder(idOrder);
}

/** Повернути весь ланцюжок: Checkbox створює чек повернення на кожен чек ланцюжка */
async function returnChain(idOrder, idUser) {
	const chain = await openChain(idOrder);
	if (!chain) throw httpErr(409, "modules.checkbox.e.no_chain");
	const [[et]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.ettn} WHERE id_order = ? AND status = 'CREATED'`, [idOrder]);
	if (Number(et.n)) throw httpErr(409, "modules.checkbox.e.chain_has_ettn");
	const reg = await registers.get(chain.id_register);
	await shifts.ensureOpen(reg, idUser);
	const list = await reg.api.chainReturn(chain.relation_id, {});
	for (const r of Array.isArray(list) ? list : []) {
		if (!r || !r.id) continue;
		const [[orig]] = await pool.query(`SELECT id FROM ${T.receipts} WHERE receipt_id = ?`, [String(r.related_receipt_id || "")]);
		await pool.query(
			`INSERT IGNORE INTO ${T.receipts} (id_order, id_register, receipt_id, type, chain, id_chain, status, total, payment_type, related_id, source, payload, id_user, date_add, date_edit)
			 VALUES (?, ?, ?, 'RETURN', ?, ?, ?, ?, ?, ?, 'manual', NULL, ?, NOW(), NOW())`,
			[idOrder, reg.id, String(r.id), "ret", chain.id, String(r.status || "CREATED"), Number(r.total_sum) || 0, ((r.payments || [])[0] || {}).type || null, orig ? orig.id : null, idUser || null]
		);
		const [[row]] = await pool.query(`SELECT * FROM ${T.receipts} WHERE receipt_id = ?`, [String(r.id)]);
		if (row) await sync(row).catch(() => null);
	}
	await refreshChain(chain).catch(() => null);
	await event(pool, reg.id, idOrder, "chain_return", { relation: chain.relation_id }, idUser);
	await orderEvent(idOrder, idUser, "receipt_chain_return", { relation: chain.relation_id });
	return forOrder(idOrder);
}

async function chainForOrder(idOrder) {
	const [[c]] = await pool.query(`SELECT * FROM ${T.chains} WHERE id_order = ? ORDER BY id DESC LIMIT 1`, [idOrder]);
	return pub(c);
}

/* ───────────────────────── Автоматичні чеки за подіями замовлень ───────────────────────── */

/**
 * Автоматичні фіскальні чеки за подіями замовлень (core/modules/orders):
 *  - monobank.paid — оплата через Monobank (якщо банк не фіскалізує сам): повна сума — чек продажу,
 *    частина — чек передплати, доплата в наявний ланцюжок — передплата / післяплата;
 *  - status — перехід замовлення у вибрані в касі статуси;
 *  - refund — повернення в замовленні: чек повернення до чека продажу за тими самими позиціями.
 * Повторний чек не створюється: продаж — якщо на замовлення вже є чинний чек або ЕТТН; повернення — один на повернення замовлення.
 * Причина пропуску й помилки — у журналі каси (events), помилка видачі — рядок чека зі станом ERROR у картці замовлення.
 */

async function regFor(idOrder) {
	const [[o]] = await pool.query(`SELECT id_integration, currency_iso FROM ${P}orders WHERE id = ? AND deleted_at IS NULL`, [idOrder]);
	if (!o || String(o.currency_iso || "UAH").toUpperCase() !== "UAH") return null;
	const reg = await registers.forIntegration(o.id_integration).catch(() => null);
	return reg && reg.status ? reg : null;
}

const skip = (reg, idOrder, reason, extra) => event(pool, reg && reg.id, idOrder, "auto_skip", { reason, ...(extra || {}) }, null);

/** Помилки 409 (уже є чек, немає зміни без автовідкриття) — очікувані: лише в журнал */
async function run(reg, idOrder, what, fn) {
	try {
		await fn();
	} catch (e) {
		const msg = e.vars && e.vars.msg ? e.vars.msg : e.message;
		if (e.status === 409) return skip(reg, idOrder, msg, { what });
		console.error(`[checkbox] auto ${what} #${idOrder}:`, msg);
		await event(pool, reg.id, idOrder, "auto_error", { what, message: msg }, null);
	}
}

async function onMonobankPaid(idOrder, d) {
	const reg = await regFor(idOrder);
	if (!reg || !reg.settings.auto_monobank) return;
	if (d.bank_fiscal) return skip(reg, idOrder, "bank_fiscal", { invoice: d.invoice_id });
	const body = {
		payment_type: "CASHLESS",
		label: reg.settings.monobank_label || undefined,
		amount: d.amount,
		payment: { card_mask: d.card_mask, rrn: d.rrn, auth_code: d.auth_code, bank_name: d.bank, payment_system: d.payment_system, terminal: d.terminal, transaction_id: d.tran_id },
	};
	// Уже є ланцюжок передплати — доплата (передплата або післяплата)
	if (await openChain(idOrder)) return run(reg, idOrder, "monobank", () => pay(idOrder, body, null, { source: "auto" }));
	const o = await loadOrder(idOrder);
	const goods = await goodsOf(o, reg);
	const total = goods.reduce((s, g) => s + lineSum(g), 0);
	const paid = toMinor(d.amount);
	// Повна сума — звичайний чек продажу; частина — чек передплати (залишок — доплатою чи ЕТТН при отриманні)
	if (paid === total) return run(reg, idOrder, "monobank", () => sell(idOrder, body, null, { source: "auto" }));
	if (paid > 0 && paid < total) return run(reg, idOrder, "monobank", () => prepay(idOrder, body, null, { source: "auto" }));
	return skip(reg, idOrder, "amount_mismatch", { paid: d.amount, total: total / 100 });
}

async function onStatus(idOrder, d) {
	const reg = await regFor(idOrder);
	if (!reg || !reg.settings.auto_statuses.length) return;
	const [[o]] = await pool.query(`SELECT status FROM ${P}orders WHERE id = ?`, [idOrder]);
	const to = Number(d.to || (o && o.status));
	if (!reg.settings.auto_statuses.includes(to)) return;
	await run(reg, idOrder, "status", () => sell(idOrder, { payment_type: reg.settings.auto_payment }, null, { source: "auto" }));
}

/** Повернення замовлення → чек повернення: позиції повернення зіставляються з чеком продажу за кодом (SKU) або назвою */
async function onRefund(idOrder, d) {
	const idRefund = Number(d.id_refund) || 0;
	if (!idRefund) return;
	const reg = await regFor(idOrder);
	if (!reg || !reg.settings.auto_return) return;
	const [[dup]] = await pool.query(`SELECT id FROM ${T.receipts} WHERE id_refund = ? AND status IN ('QUEUED', 'CREATED', 'DONE')`, [idRefund]);
	if (dup) return;
	const [[ref]] = await pool.query(`SELECT items, shipping_refunded, amount FROM ${P}orders_refunds WHERE id = ? AND id_order = ?`, [idRefund, idOrder]);
	if (!ref) return;
	const [[sale]] = await pool.query(`SELECT id, payload FROM ${T.receipts} WHERE id_order = ? AND type = 'SELL' AND status = 'DONE' ORDER BY id DESC LIMIT 1`, [idOrder]);
	if (!sale) return skip(reg, idOrder, "no_sale", { refund: idRefund });
	const goods = (json(sale.payload, {}) || {}).goods || [];
	const items = [];
	for (const it of json(ref.items, []) || []) {
		const i = goods.findIndex((g) => (it.sku && g.good.code === String(it.sku)) || g.good.name === String(it.name || "").slice(0, 256));
		if (i < 0) return skip(reg, idOrder, "no_match", { refund: idRefund, item: it.sku || it.name });
		items.push({ index: i, qty: Number(it.qty) || 0 });
	}
	if (Number(ref.shipping_refunded) > 0) {
		const i = goods.findIndex((g) => g.good.code === "SHIPPING");
		if (i >= 0) items.push({ index: i, qty: 1 });
	}
	// Повернення лише сумою, без позицій, — чек повернення за позиціями скласти не можна
	if (!items.length) return skip(reg, idOrder, "amount_only", { refund: idRefund });
	await run(reg, idOrder, "return", () => refund(idOrder, sale.id, { items }, null, { id_refund: idRefund, source: "auto" }));
}

/* ───────────────────────── Список замовлень: колонка й фільтр «Чек» ───────────────────────── */

/**
 * Checkbox у списку замовлень: колонка «Чек» і фільтр за станом фіскалізації
 * (core/modules/orders + хуки displayOrdersColumns / displayOrdersFilters).
 */

const LIST_DONE = (a) => `EXISTS (SELECT 1 FROM ${T.receipts} cr WHERE cr.id_order = ${a}.id AND cr.type = 'SELL' AND cr.status = 'LIST_DONE')`;
const LIST_FILTERS = {
	done: LIST_DONE,
	waiting: (a) => `NOT ${LIST_DONE(a)} AND EXISTS (SELECT 1 FROM ${T.ettn} ce WHERE ce.id_order = ${a}.id AND ce.status = 'CREATED')`,
	error: (a) =>
		`NOT ${LIST_DONE(a)} AND (EXISTS (SELECT 1 FROM ${T.receipts} cr WHERE cr.id_order = ${a}.id AND cr.status = 'ERROR') OR EXISTS (SELECT 1 FROM ${T.ettn} ce WHERE ce.id_order = ${a}.id AND ce.status IN ('ERROR', 'RECEIPT_ERROR')))`,
	returned: (a) => `EXISTS (SELECT 1 FROM ${T.receipts} cr WHERE cr.id_order = ${a}.id AND cr.type = 'RETURN' AND cr.status = 'LIST_DONE')`,
	none: (a) => `NOT EXISTS (SELECT 1 FROM ${T.receipts} cr WHERE cr.id_order = ${a}.id AND cr.status IN ('CREATED', 'LIST_DONE')) AND NOT EXISTS (SELECT 1 FROM ${T.ettn} ce WHERE ce.id_order = ${a}.id AND ce.status IN ('CREATED', 'LIST_DONE', 'DONE_WITHOUT_SMS'))`,
};

function listFilter(value, alias) {
	const f = LIST_FILTERS[String(value)];
	return f ? { sql: f(String(alias).replace(/[^\w]/g, "")), params: [] } : null;
}

/** Стан для колонки: done / returned / waiting / error / pending (чек у черзі) і фіскальний номер */
async function listRows(ids) {
	const out = new Map();
	if (!ids.length) return out;
	const [rc] = await pool.query(`SELECT id_order, type, status, fiscal_code FROM ${T.receipts} WHERE id_order IN (?) ORDER BY id DESC`, [ids]);
	const [et] = await pool.query(`SELECT id_order, status, ttn FROM ${T.ettn} WHERE id_order IN (?) ORDER BY id DESC`, [ids]);
	for (const id of ids) {
		const r = rc.filter((x) => Number(x.id_order) === id);
		const e = et.filter((x) => Number(x.id_order) === id);
		if (!r.length && !e.length) continue;
		const sale = r.find((x) => x.type === "SELL" && x.status === "LIST_DONE");
		const ret = r.find((x) => x.type === "RETURN" && x.status === "LIST_DONE");
		let state = null;
		if (sale) state = ret ? "returned" : "done";
		else if (r.some((x) => x.status === "CREATED" || x.status === "QUEUED")) state = "pending";
		else if (e.some((x) => x.status === "CREATED")) state = "waiting";
		else if (r.some((x) => x.status === "ERROR") || e.some((x) => x.status === "ERROR" || x.status === "RECEIPT_ERROR")) state = "error";
		if (state) out.set(id, { state, fiscal_code: sale ? sale.fiscal_code : null, ttn: (e.find((x) => x.status === "CREATED") || {}).ttn || null });
	}
	return out;
}

module.exports = {
	submit,
	paymentOf,
	cardDetails,
	sell,
	returnForm,
	refund,
	refresh,
	file,
	send,
	forOrder,
	syncDue,
	service,
	goodsOf,
	lineSum,
	strip,
	contacts,
	loadOrder,
	event,
	orderEvent,
	sync,
	openChain,
	refreshChain,
	prepay,
	pay,
	returnChain,
	onMonobankPaid,
	onStatus,
	onRefund,
	listFilter,
	listRows,
	listAll,
	fileById,
	onWebhook,
	retry,
	LIST_STATES: Object.keys(LIST_FILTERS),
};