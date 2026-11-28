"use strict";

/**
 * Клієнт Mono Acquiring: https://api.monobank.ua/ (заголовок X-Token).
 * Документація: https://api.monobank.ua/docs/acquiring.html
 */
const crypto = require("crypto");
const { httpErr } = require("./common");

const BASE = "https://api.monobank.ua";
let TIMEOUT = 20000;
const setTimeoutMs = (ms) => (TIMEOUT = Math.max(5000, Number(ms) || 20000));

async function call(token, method, path, body) {
	let res;
	try {
		res = await fetch(BASE + path, {
			method,
			headers: { "X-Token": token || "", "Content-Type": "application/json", Accept: "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
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
	if (res.status === 403 || res.status === 401) throw httpErr(400, "modules.monobank.e.token");
	if (res.status === 429) throw httpErr(429, "modules.monobank.e.rate_limit");
	if (!res.ok) throw httpErr(400, "modules.monobank.e.api", { msg: j.errText || j.errCode || "HTTP " + res.status });
	return j;
}

const details = (token) => call(token, "GET", "/api/merchant/details");
const createInvoice = (token, body) => call(token, "POST", "/api/merchant/invoice/create", body);
const status = (token, invoiceId) => call(token, "GET", "/api/merchant/invoice/status?invoiceId=" + encodeURIComponent(invoiceId));
const remove = (token, invoiceId) => call(token, "POST", "/api/merchant/invoice/remove", { invoiceId });
const finalize = (token, invoiceId, amount) => call(token, "POST", "/api/merchant/invoice/finalize", amount ? { invoiceId, amount } : { invoiceId });
/** Повернення (повне / часткове) або скасування холду. items — обов'язкові, якщо підключено ПРРО */
const cancel = (token, body) => call(token, "POST", "/api/merchant/invoice/cancel", body);
const fiscalChecks = (token, invoiceId) => call(token, "GET", "/api/merchant/invoice/fiscal-checks?invoiceId=" + encodeURIComponent(invoiceId));
/* QR-каси: список, деталі (сума, рахунок), скидання суми. Суму ставить createInvoice з qrId */
const qrList = (token) => call(token, "GET", "/api/merchant/qr/list");
const qrDetails = (token, qrId) => call(token, "GET", "/api/merchant/qr/details?qrId=" + encodeURIComponent(qrId));
const qrReset = (token, qrId) => call(token, "POST", "/api/merchant/qr/reset-amount", { qrId });

/* Токенізація карток (вмикає банк на запит): картки гаманця, оплата токеном, видалення */
const walletCards = (token, walletId) => call(token, "GET", "/api/merchant/wallet?walletId=" + encodeURIComponent(walletId));
const walletPayment = (token, body) => call(token, "POST", "/api/merchant/wallet/payment", body);
const deleteCard = (token, cardToken) => call(token, "DELETE", "/api/merchant/wallet/card?cardToken=" + encodeURIComponent(cardToken));

/** Виписка за період: from / to — Unix-час (секунди, UTC); від новіших до старіших */
const statement = (token, from, to) => call(token, "GET", `/api/merchant/statement?from=${Math.floor(from)}${to ? "&to=" + Math.floor(to) : ""}`);
/** Квитанція: з email — банк надсилає її на пошту клієнта. З тестовим токеном не працює */
const receipt = (token, invoiceId, email) =>
	call(token, "GET", "/api/merchant/invoice/receipt?invoiceId=" + encodeURIComponent(invoiceId) + (email ? "&email=" + encodeURIComponent(email) : ""));

/**
 * Публічний ключ для перевірки підпису вебхуків (X-Sign). Ключ свій для кожного токена;
 * кешуємо на годину, а при невдалій перевірці перечитуємо один раз (банк міг змінити ключ).
 */
const keys = new Map();
async function pubkey(token, fresh) {
	const c = keys.get(token);
	if (!fresh && c && Date.now() - c.at < 60 * 60 * 1000) return c.pem;
	const j = await call(token, "GET", "/api/merchant/pubkey");
	const pem = Buffer.from(String(j.key || ""), "base64").toString("utf8");
	keys.set(token, { pem, at: Date.now() });
	return pem;
}

function verifyWith(pem, raw, sign) {
	try {
		const v = crypto.createVerify("SHA256");
		v.update(raw);
		v.end();
		return v.verify(pem, Buffer.from(String(sign), "base64"));
	} catch (e) {
		return false;
	}
}

/** Підпис вебхука: ECDSA SHA-256 над сирим тілом запиту */
async function verify(token, raw, sign) {
	if (!sign || !raw || !raw.length) return false;
	if (verifyWith(await pubkey(token), raw, sign)) return true;
	return verifyWith(await pubkey(token, true), raw, sign);
}

module.exports = { setTimeoutMs, call, details, createInvoice, status, remove, finalize, cancel, fiscalChecks, receipt, statement, qrList, qrDetails, qrReset, walletCards, walletPayment, deleteCard, verify };