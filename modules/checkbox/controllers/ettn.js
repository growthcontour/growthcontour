"use strict";

/**
 * ЕТТН — чек при отриманні посилки Нової Пошти.
 * Система передає в Checkbox склад чека й номер ТТН; коли клієнт забирає посилку, Нова Пошта повідомляє Checkbox,
 * і Checkbox сам фіскалізує чек і надсилає його клієнту (SMS на телефон з ТТН / email).
 * Умова Checkbox: ТТН створена з «Контролем оплати» NovaPay (договір з NovaPay), сума чека = сума контролю оплати.
 *
 * Стани Checkbox: CREATED — чекає отримання; DONE / DONE_WITHOUT_SMS — чек видано; CANCELLED; RETURNED — посилку повернуто;
 * RECEIPT_ERROR — помилка фіскалізації. Локально ще ERROR — Checkbox не прийняв запит (можна створити знову).
 */
const { pool, P, T, httpErr, str, json, toMinor, fromMinor, phone380, ETTN_OPEN } = require("./common");
const registers = require("./registers");
const receipts = require("./receipts");
const i18n = require("../../../config/i18n/i18n");

const t = (phrase, vars) => i18n.__({ phrase, locale: process.env.APP_LOCALE || "uk" }, vars || {});

async function loadShipment(idOrder, idShipment) {
	const [[s]] = await pool.query(`SELECT * FROM ${P}orders_shipments WHERE id = ? AND id_order = ? AND carrier = 'novaposhta'`, [idShipment, idOrder]);
	if (!s || !s.tracking_number) throw httpErr(404, "modules.checkbox.e.shipment_not_found");
	return s;
}

/** Телефон отримувача з відправлення НП → з клієнта замовлення */
function recipientPhone(ship, contacts) {
	const d = json(ship.raw, {}) || {};
	return phone380(d.recipient && d.recipient.phone) || contacts.phone;
}

/**
 * Створити ЕТТН для відправлення замовлення. Сума чека має дорівнювати накладеному платежу в ТТН.
 * opts.auto — створено автоматично (без користувача).
 */
async function create(idOrder, idShipment, idUser, opts = {}) {
	const ship = await loadShipment(idOrder, idShipment);
	const o = await receipts.loadOrder(idOrder);
	const reg = await registers.forIntegration(o.id_integration);
	if (!reg || !reg.status) throw httpErr(409, "modules.checkbox.e.no_register");
	const ttn = String(ship.tracking_number).replace(/\s/g, "");
	const [[ex]] = await pool.query(`SELECT id, status FROM ${T.ettn} WHERE ttn = ?`, [ttn]);
	if (ex && !["CANCELLED", "ERROR"].includes(ex.status)) throw httpErr(409, "modules.checkbox.e.ettn_exists");

	// Є передплата — ЕТТН на залишок у тому ж ланцюжку (чек післяплати при отриманні); інакше — на всю суму
	const chain = await receipts.openChain(o.id);
	if (chain) await receipts.refreshChain(chain).catch(() => null);
	const [[ch]] = chain ? await pool.query(`SELECT * FROM ${T.chains} WHERE id = ?`, [chain.id]) : [[null]];
	const goods = ch ? null : await receipts.goodsOf(o, reg);
	const total = ch ? Number(ch.left_to_pay) : goods.reduce((s, g) => s + receipts.lineSum(g), 0);
	if (ch && !(total > 0)) throw httpErr(409, "modules.checkbox.e.chain_paid");
	const cod = toMinor((json(ship.raw, {}) || {}).cod);
	if (!(cod > 0)) throw httpErr(400, "modules.checkbox.e.ettn_no_cod");
	if (cod !== total) throw httpErr(400, ch ? "modules.checkbox.e.ettn_sum_left" : "modules.checkbox.e.ettn_sum", { cod: fromMinor(cod).toFixed(2), total: fromMinor(total).toFixed(2) });

	const c = await receipts.contacts(o);
	const phone = recipientPhone(ship, c);
	const s = reg.settings;
	const common = {
		payments: [{ value: total, ettn: ttn, ...(s.cashless_label ? { label: s.cashless_label } : {}) }],
		delivery: { ...(s.ettn_sms && phone ? { phone } : {}), ...(s.send_email && c.email ? { emails: [c.email] } : {}) },
		footer: [s.footer, `№ ${o.reference || o.id}`].filter(Boolean).join("\n"),
	};
	const body = {
		receipt_body: ch ? { ...common, relationId: ch.relation_id } : { goods: receipts.strip(goods), ...common },
		provider: "novapost",
		...(s.ettn_sender_phone ? { senderPhone: s.ettn_sender_phone } : {}),
	};

	// Рядок до запиту — якщо Checkbox не відповів, видно, що спроба була
	if (ex) await pool.query(`DELETE FROM ${T.ettn} WHERE id = ?`, [ex.id]);
	const [ins] = await pool.query(
		`INSERT INTO ${T.ettn} (id_order, id_register, id_shipment, ttn, status, total, raw, id_user, date_add, date_edit) VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?, NOW(), NOW())`,
		[idOrder, reg.id, ship.id, ttn, total, JSON.stringify({ request: body }), idUser || null]
	);
	let r;
	try {
		r = await (ch ? reg.api.ettnPrepay(body) : reg.api.ettnCreate(body));
	} catch (e) {
		const msg = e.vars && e.vars.msg ? e.vars.msg : e.message;
		await pool.query(`UPDATE ${T.ettn} SET status = 'ERROR', error = ?, date_edit = NOW() WHERE id = ?`, [String(msg).slice(0, 1000), ins.insertId]);
		await receipts.event(pool, reg.id, idOrder, "error", { ettn: ttn, message: msg, auto: !!opts.auto }, idUser);
		if (opts.auto) await registers.alertError(reg.id, idOrder, `${ttn}: ${msg}`, "checkbox_ettn_new_" + ins.insertId);
		throw e;
	}
	await apply(ins.insertId, r);
	await receipts.event(pool, reg.id, idOrder, "ettn", { ttn, total: fromMinor(total), auto: !!opts.auto }, idUser);
	await receipts.orderEvent(idOrder, idUser, "ettn_created", { ttn, total: fromMinor(total) });
	return receipts.forOrder(idOrder);
}

/** Стан ЕТТН з відповіді Checkbox; чек, виданий при отриманні, — у таблицю чеків замовлення */
async function apply(idRow, r) {
	if (!r) return;
	const [[row]] = await pool.query(`SELECT * FROM ${T.ettn} WHERE id = ?`, [idRow]);
	if (!row) return;
	const status = str(r.status, 24) || row.status;
	await pool.query(
		`UPDATE ${T.ettn} SET ettn_id = COALESCE(?, ettn_id), status = ?, receipt_id = COALESCE(?, receipt_id), return_receipt_id = COALESCE(?, return_receipt_id),
		        error = ?, raw = JSON_SET(COALESCE(raw, JSON_OBJECT()), '$.response', CAST(? AS JSON)), last_check = NOW(), date_edit = NOW() WHERE id = ?`,
		[str(r.id, 64), status, str(r.receiptId, 64), str(r.returnReceiptId, 64), str(r.rawError, 1000), JSON.stringify(r), row.id]
	);
	// Чек видано (клієнт забрав посилку): фіксуємо його як чек продажу (або післяплати ланцюжка) замовлення
	if (r.receiptId && !row.receipt_id) {
		const body = ((json(row.raw, {}) || {}).request || {}).receipt_body || {};
		const [[rel]] = body.relationId ? await pool.query(`SELECT id, id_register, relation_id, status, total FROM ${T.chains} WHERE relation_id = ?`, [body.relationId]) : [[null]];
		await pool.query(
			`INSERT IGNORE INTO ${T.receipts} (id_order, id_register, receipt_id, type, chain, id_chain, status, total, payment_type, source, payload, date_add, date_edit)
			 VALUES (?, ?, ?, 'SELL', ?, ?, 'CREATED', ?, 'CASHLESS', 'ettn', ?, NOW(), NOW())`,
			[row.id_order, row.id_register, String(r.receiptId), rel ? "after" : null, rel ? rel.id : null, row.total, JSON.stringify(body)]
		);
		const [[rc]] = await pool.query(`SELECT * FROM ${T.receipts} WHERE receipt_id = ?`, [String(r.receiptId)]);
		if (rc) await receipts.sync(rc).catch(() => null);
		if (rel) await receipts.refreshChain(rel).catch(() => null);
		await receipts.orderEvent(row.id_order, null, "ettn_fiscalized", { ttn: row.ttn, receipt: r.receiptId });
	}
	if (status === "RECEIPT_ERROR" && row.status !== "RECEIPT_ERROR") await registers.alertError(row.id_register, row.id_order, `${row.ttn}: ${r.rawError || status}`, "checkbox_ettn_" + row.id);
	if (status !== row.status && (status === "RETURNED" || status === "CANCELLED" || status === "RECEIPT_ERROR"))
		await receipts.orderEvent(row.id_order, null, "ettn_" + status.toLowerCase(), { ttn: row.ttn, error: r.rawError || undefined });
}

async function loadRow(idOrder, id) {
	const [[e]] = await pool.query(`SELECT * FROM ${T.ettn} WHERE id = ? AND id_order = ?`, [id, idOrder]);
	if (!e) throw httpErr(404, "modules.checkbox.e.ettn_not_found");
	return e;
}

async function refresh(idOrder, id) {
	const e = await loadRow(idOrder, id);
	if (!e.ettn_id) throw httpErr(409, "modules.checkbox.e.ettn_not_found");
	const reg = await registers.get(e.id_register);
	await apply(e.id, await reg.api.ettnGet(e.ettn_id));
	return receipts.forOrder(idOrder);
}

/** Скасувати ЕТТН (посилку ще не отримано): Checkbox не видасть чек при отриманні */
async function cancel(idOrder, id, idUser) {
	const e = await loadRow(idOrder, id);
	if (e.status === "ERROR") {
		await pool.query(`DELETE FROM ${T.ettn} WHERE id = ?`, [e.id]);
		return receipts.forOrder(idOrder);
	}
	if (!ETTN_OPEN.includes(e.status)) throw httpErr(409, "modules.checkbox.e.ettn_closed");
	const reg = await registers.get(e.id_register);
	await reg.api.ettnDelete(e.ettn_id);
	await pool.query(`UPDATE ${T.ettn} SET status = 'CANCELLED', date_edit = NOW() WHERE id = ?`, [e.id]);
	await receipts.event(pool, e.id_register, idOrder, "ettn_cancel", { ttn: e.ttn }, idUser);
	return receipts.forOrder(idOrder);
}

/** Фіскалізувати вручну (наприклад, гроші отримано, а статус від Нової Пошти не прийшов) */
async function fiscalize(idOrder, id, idUser) {
	const e = await loadRow(idOrder, id);
	if (!ETTN_OPEN.includes(e.status) && e.status !== "RECEIPT_ERROR") throw httpErr(409, "modules.checkbox.e.ettn_closed");
	const reg = await registers.get(e.id_register);
	await apply(e.id, await reg.api.ettnFiscalize(e.ettn_id));
	await receipts.event(pool, e.id_register, idOrder, "ettn_fiscalize", { ttn: e.ttn }, idUser);
	return receipts.forOrder(idOrder);
}

/** За розкладом: стан відкритих ЕТТН (не частіше, ніж раз на N хвилин кожна) */
async function syncDue(minutes) {
	const [rows] = await pool.query(
		`SELECT * FROM ${T.ettn} WHERE status IN ('CREATED', 'RECEIPT_ERROR') AND ettn_id IS NOT NULL
		   AND (last_check IS NULL OR last_check < NOW() - INTERVAL ? MINUTE) AND date_add > NOW() - INTERVAL 45 DAY ORDER BY last_check LIMIT 100`,
		[Math.max(5, Number(minutes) || 15)]
	);
	for (const e of rows) {
		try {
			const reg = await registers.get(e.id_register);
			await apply(e.id, await reg.api.ettnGet(e.ettn_id));
		} catch (err) {
			console.error(`[checkbox] ettn ${e.ttn}:`, err.message);
			await pool.query(`UPDATE ${T.ettn} SET last_check = NOW() WHERE id = ?`, [e.id]);
		}
	}
	return rows.length;
}

/** Вебхук каси приніс невідомий чек — можливо, це чек ЕТТН (клієнт забрав посилку): перевіряємо відкриті ЕТТН каси одразу */
async function syncRegister(idRegister) {
	const [rows] = await pool.query(`SELECT * FROM ${T.ettn} WHERE id_register = ? AND status IN ('CREATED', 'RECEIPT_ERROR') AND ettn_id IS NOT NULL ORDER BY id LIMIT 50`, [idRegister]);
	if (!rows.length) return 0;
	const reg = await registers.get(idRegister);
	for (const e of rows) await apply(e.id, await reg.api.ettnGet(e.ettn_id)).catch((err) => console.error(`[checkbox] ettn ${e.ttn}:`, err.message));
	return rows.length;
}

/**
 * Автоматичні ЕТТН (у касі увімкнено ettn_auto): ТТН Нової Пошти з накладеним платежем за останні 14 днів,
 * для яких ще немає ЕТТН і чека продажу. Невдала спроба лишається рядком ERROR — повторно не створюється
 * (видно в замовленні, можна створити вручну).
 */
async function autoCreate() {
	const [regs] = await pool.query(`SELECT id FROM ${T.registers} WHERE status = 1 AND JSON_EXTRACT(settings, '$.ettn_auto') = true`);
	if (!regs.length) return 0;
	const [rows] = await pool.query(
		`SELECT s.id, s.id_order FROM ${P}orders_shipments s JOIN ${P}orders o ON o.id = s.id_order AND o.deleted_at IS NULL
		  WHERE s.carrier = 'novaposhta' AND s.tracking_number IS NOT NULL AND s.tracking_number <> ''
		    AND COALESCE(JSON_EXTRACT(s.raw, '$.cod'), 0) > 0 AND s.date_add > NOW() - INTERVAL 14 DAY
		    AND NOT EXISTS (SELECT 1 FROM ${T.ettn} e WHERE e.ttn = REPLACE(s.tracking_number, ' ', ''))
		    AND NOT EXISTS (SELECT 1 FROM ${T.receipts} r WHERE r.id_order = s.id_order AND r.type = 'SELL' AND r.status IN ('QUEUED', 'CREATED', 'DONE') AND (r.chain IS NULL OR r.chain = 'after'))
		  ORDER BY s.id LIMIT 50`
	);
	let n = 0;
	for (const r of rows) {
		try {
			const o = await receipts.loadOrder(r.id_order);
			const reg = await registers.forIntegration(o.id_integration);
			if (!reg || !reg.settings.ettn_auto) continue;
			await create(r.id_order, r.id, null, { auto: true });
			n++;
		} catch (e) {
			if (e.status === 409) continue;
			// Перевірка не пройшла до запиту в Checkbox (сума, немає накладеного платежу…) — фіксуємо, щоб не повторювати
			const text = String(e.message).startsWith("modules.") ? t(e.message, e.vars) : e.message;
			const [[ship]] = await pool.query(`SELECT tracking_number FROM ${P}orders_shipments WHERE id = ?`, [r.id]);
			const o = await receipts.loadOrder(r.id_order).catch(() => null);
			const reg = o ? await registers.forIntegration(o.id_integration).catch(() => null) : null;
			if (ship && reg)
				await pool.query(
					`INSERT IGNORE INTO ${T.ettn} (id_order, id_register, id_shipment, ttn, status, total, error, date_add, date_edit) VALUES (?, ?, ?, ?, 'ERROR', 0, ?, NOW(), NOW())`,
					[r.id_order, reg.id, r.id, String(ship.tracking_number).replace(/\s/g, ""), String(text).slice(0, 1000)]
				);
			console.error(`[checkbox] auto ettn order #${r.id_order}:`, text);
		}
	}
	return n;
}

module.exports = { create, refresh, cancel, fiscalize, syncDue, autoCreate, syncRegister };