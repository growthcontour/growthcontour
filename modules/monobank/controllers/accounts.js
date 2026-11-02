"use strict";

/**
 * Акаунти Mono Acquiring: кілька токенів (кілька ФОП / магазинів).
 * Токен зберігається зашифрованим (AES-256-GCM, helpers/crypto) і назовні не віддається.
 */
const { pool, T, httpErr, str, json } = require("./common");
const cryptoHelper = require("../../../helpers/crypto");
const api = require("./api");

const PAYMENT_TYPES = ["debit", "hold"];

const DEFAULTS = {
	payment_type: "debit", // debit — одразу списання; hold — блокування коштів, списання після підтвердження
	validity_hours: 24, // скільки діє посилання
	destination: "", // призначення платежу; {order} — номер замовлення (початкове значення — з перекладу на сторінці акаунта)
	basket: true, // передавати склад замовлення в чек Monobank
	shipping_name: "", // назва рядка доставки в чеку
	status_paid: null, // статус замовлення після оплати
	status_hold: null, // статус після блокування коштів (лише для hold)
	status_refunded: null, // статус після повного повернення коштів
	customer_email: true, // банк надсилає квитанцію на email клієнта із замовлення
	redirect_url: "", // куди повернути клієнта після оплати (сторінка «Дякуємо» на сайті)
	fiscal: false, // у кабінеті Monobank підключено ПРРО: повернення — лише по позиціях, чеки в замовленні
	tokenization: false, // банк увімкнув збереження карток (saveCardData) для мерчанта
	save_card: true, // пропонувати клієнту зберегти картку під час оплати за посиланням
};

function settingsOf(raw) {
	return { ...DEFAULTS, ...(json(raw, {}) || {}) };
}

function publicRow(r) {
	return {
		id: Number(r.id),
		name: r.name,
		token: r.token_last4 ? "••••" + r.token_last4 : "",
		merchant_id: r.merchant_id,
		merchant_name: r.merchant_name,
		status: Number(r.status),
		is_default: Number(r.is_default),
		settings: settingsOf(r.settings),
		integrations: (json(r.integrations, []) || []).map(Number),
	};
}

function tokenOf(r) {
	const t = cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag);
	if (!t) throw httpErr(409, "modules.monobank.e.token_broken");
	return t;
}

async function list() {
	const [rows] = await pool.query(`SELECT * FROM ${T.accounts} ORDER BY is_default DESC, name`);
	return rows.map(publicRow);
}

/** Акаунт із розшифрованим токеном — лише для серверного коду */
async function withToken(id) {
	const [[r]] = await pool.query(`SELECT * FROM ${T.accounts} WHERE id = ?`, [id]);
	if (!r) throw httpErr(404, "modules.monobank.e.account_not_found");
	return { ...publicRow(r), token: tokenOf(r) };
}

/** Акаунт для магазину: прив'язаний до інтеграції → за замовчуванням → перший активний */
async function forIntegration(idIntegration) {
	const [rows] = await pool.query(`SELECT * FROM ${T.accounts} WHERE status = 1 ORDER BY is_default DESC, id`);
	const own = rows.find((r) => (json(r.integrations, []) || []).map(Number).includes(Number(idIntegration)));
	const r = own || rows[0];
	return r ? { ...publicRow(r), token: tokenOf(r) } : null;
}

const statusId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

function cleanSettings(s) {
	s = s && typeof s === "object" ? s : {};
	const hours = Math.round(Number(s.validity_hours));
	return {
		payment_type: PAYMENT_TYPES.includes(s.payment_type) ? s.payment_type : DEFAULTS.payment_type,
		validity_hours: Number.isFinite(hours) ? Math.min(24 * 30, Math.max(1, hours)) : DEFAULTS.validity_hours,
		destination: str(s.destination, 280),
		basket: s.basket !== false,
		shipping_name: str(s.shipping_name, 128),
		status_paid: statusId(s.status_paid),
		status_hold: statusId(s.status_hold),
		status_refunded: statusId(s.status_refunded),
		customer_email: s.customer_email !== false,
		redirect_url: /^https:\/\/[^\s]+$/i.test(String(s.redirect_url || "").trim()) ? String(s.redirect_url).trim().slice(0, 500) : "",
		fiscal: !!s.fiscal,
		tokenization: !!s.tokenization,
		save_card: s.save_card !== false,
	};
}

async function save(id, b) {
	const name = str(b.name, 128);
	if (!name) throw httpErr(400, "modules.monobank.e.name_required");
	const token = str(b.token, 255);
	// Новий акаунт — токен обов'язковий; існуючий — порожнє поле означає «не змінювати»
	if (!id && !token) throw httpErr(400, "modules.monobank.e.token_required");

	let merchant = null;
	if (token) {
		const d = await api.details(token);
		merchant = { id: str(d.merchantId, 64), name: str(d.merchantName, 255) };
	}
	const clean = cleanSettings(b.settings);
	if (!clean.destination) throw httpErr(400, "modules.monobank.e.destination_required");
	if (clean.basket && !clean.shipping_name) throw httpErr(400, "modules.monobank.e.shipping_required");
	if (String((b.settings || {}).redirect_url || "").trim() && !clean.redirect_url) throw httpErr(400, "modules.monobank.e.redirect_url");
	const settings = JSON.stringify(clean);
	const integrations = JSON.stringify([...new Set((Array.isArray(b.integrations) ? b.integrations : []).map(Number).filter((n) => n > 0))]);
	const status = b.status ? 1 : 0;
	const isDefault = b.is_default ? 1 : 0;

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		if (isDefault) await conn.query(`UPDATE ${T.accounts} SET is_default = 0`);
		if (id) {
			const [[cur]] = await conn.query(`SELECT id FROM ${T.accounts} WHERE id = ? FOR UPDATE`, [id]);
			if (!cur) throw httpErr(404, "modules.monobank.e.account_not_found");
			await conn.query(`UPDATE ${T.accounts} SET name = ?, status = ?, is_default = ?, settings = ?, integrations = ?, date_edit = NOW() WHERE id = ?`, [name, status, isDefault, settings, integrations, id]);
			if (token) {
				const enc = cryptoHelper.encrypt(token);
				await conn.query(`UPDATE ${T.accounts} SET token_cipher = ?, token_iv = ?, token_tag = ?, token_last4 = ?, merchant_id = ?, merchant_name = ? WHERE id = ?`, [enc.cipher, enc.iv, enc.tag, cryptoHelper.last4(token), merchant.id, merchant.name, id]);
			}
		} else {
			const enc = cryptoHelper.encrypt(token);
			const [r] = await conn.query(
				`INSERT INTO ${T.accounts} (name, token_cipher, token_iv, token_tag, token_last4, merchant_id, merchant_name, status, is_default, settings, integrations, date_add, date_edit)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
				[name, enc.cipher, enc.iv, enc.tag, cryptoHelper.last4(token), merchant.id, merchant.name, status, isDefault, settings, integrations]
			);
			id = r.insertId;
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
	const [[row]] = await pool.query(`SELECT * FROM ${T.accounts} WHERE id = ?`, [id]);
	return publicRow(row);
}

async function remove(id) {
	const [[used]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.invoices} WHERE id_account = ?`, [id]);
	// Є рахунки — лише вимикаємо, щоб вебхуки й історія платежів працювали далі
	if (Number(used.n)) {
		await pool.query(`UPDATE ${T.accounts} SET status = 0, is_default = 0, date_edit = NOW() WHERE id = ?`, [id]);
		return { disabled: true };
	}
	await pool.query(`DELETE FROM ${T.accounts} WHERE id = ?`, [id]);
	return { deleted: true };
}

/* ───────────────────────── QR-каси ───────────────────────── */

/**
 * QR-каси Monobank. Список кас кожного акаунта зберігається в системі (назви, тип суми) і оновлюється з банку.
 * На касу з типом суми merchant можна виставити суму замовлення: клієнт сканує QR на точці й платить,
 * оплата приходить вебхуком як звичайний рахунок замовлення (джерело qr). Суму з каси можна скинути.
 */

/** Оновити список кас акаунта з банку; каси, яких більше немає, позначаються неактивними */
async function qrSync(idAccount) {
	const acc = await withToken(idAccount);
	const r = await api.qrList(acc.token);
	const items = Array.isArray(r.list) ? r.list : [];
	for (const q of items) {
		if (!q || !q.qrId) continue;
		await pool.query(
			`INSERT INTO ${T.qr} (id_account, qr_id, short_qr_id, amount_type, page_url, active, date_add, date_edit) VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW()) AS n
			 ON DUPLICATE KEY UPDATE short_qr_id = n.short_qr_id, amount_type = n.amount_type, page_url = n.page_url, active = 1, date_edit = NOW()`,
			[acc.id, str(q.qrId, 32), str(q.shortQrId, 32), str(q.amountType, 16), str(q.pageUrl, 512)]
		);
	}
	const ids = items.map((q) => String(q.qrId));
	await pool.query(`UPDATE ${T.qr} SET active = 0, date_edit = NOW() WHERE id_account = ? AND active = 1${ids.length ? " AND qr_id NOT IN (?)" : ""}`, ids.length ? [acc.id, ids] : [acc.id]);
	return items.length;
}

const qrPub = (r) => ({ id: Number(r.id), id_account: Number(r.id_account), qr_id: r.qr_id, short: r.short_qr_id, name: r.name, amount_type: r.amount_type, page_url: r.page_url, active: !!r.active });

/** Каси всіх акаунтів — для сторінки налаштувань */
async function qrList() {
	const [rows] = await pool.query(`SELECT * FROM ${T.qr} ORDER BY id_account, active DESC, name IS NULL, name, short_qr_id`);
	return { rows: rows.map(qrPub) };
}

async function qrSyncAll() {
	const [accs] = await pool.query(`SELECT id FROM ${T.accounts} WHERE status = 1`);
	let total = 0;
	for (const a of accs) total += await qrSync(a.id);
	return { total, ...(await qrList()) };
}

async function qrRename(id, name) {
	const [r] = await pool.query(`UPDATE ${T.qr} SET name = ?, date_edit = NOW() WHERE id = ?`, [str(name, 128), id]);
	if (!r.affectedRows) throw httpErr(404, "modules.monobank.e.qr_not_found");
	return {};
}

/** Для панелі замовлення: каси, на які можна виставити суму (акаунт магазину) */
async function qrForOrder(o) {
	const acc = await forIntegration(o.id_integration).catch(() => null);
	if (!acc) return { qr: [] };
	const [rows] = await pool.query(`SELECT * FROM ${T.qr} WHERE id_account = ? AND active = 1 AND amount_type = 'merchant' ORDER BY name IS NULL, name, short_qr_id`, [acc.id]);
	return { qr: rows.map((r) => ({ id: Number(r.id), name: r.name || r.short_qr_id, short: r.short_qr_id })) };
}

async function loadQr(id) {
	const [[q]] = await pool.query(`SELECT * FROM ${T.qr} WHERE id = ? AND active = 1`, [id]);
	if (!q) throw httpErr(404, "modules.monobank.e.qr_not_found");
	if (q.amount_type !== "merchant") throw httpErr(409, "modules.monobank.e.qr_type");
	return q;
}

/**
 * Виставити суму замовлення на касу. Каса зайнята сумою іншого рахунку — помилка, або (force) спершу скидаємо її.
 * body: { qr: id каси, amount?, force? }
 */
async function qrAssign(idOrder, body, idUser) {
	const q = await loadQr(Number(body.qr));
	const acc = await withToken(q.id_account);
	const d = await api.qrDetails(acc.token, q.qr_id).catch(() => ({}));
	if (d && d.invoiceId && Number(d.amount) > 0) {
		if (!body.force) throw httpErr(409, "modules.monobank.e.qr_busy", { name: q.name || q.short_qr_id });
		await qrReset(q, acc, idUser);
	}
	return require("./invoices").create(idOrder, { amount: body.amount, account_id: q.id_account }, idUser, { qrId: q.qr_id });
}

/** Скинути суму з каси; рахунок системи на цій касі (якщо не оплачений) анулюється */
async function qrReset(q, acc, idUser) {
	await api.qrReset(acc.token, q.qr_id);
	const [open] = await pool.query(`SELECT id FROM ${T.invoices} WHERE id_account = ? AND qr_id = ? AND status = 'created'`, [q.id_account, q.qr_id]);
	for (const r of open) await require("./invoices").applyRemote(r.id, { status: "removed" }, "removed", idUser);
}

module.exports = { list, withToken, forIntegration, save, remove, settingsOf, PAYMENT_TYPES, qrSync, qrSyncAll, qrList, qrRename, qrForOrder, qrAssign };