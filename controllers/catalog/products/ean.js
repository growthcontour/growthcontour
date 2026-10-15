"use strict";

const settings = require("./settings");
const { nextSequence } = require("./sku");

/** Контрольна цифра GTIN (EAN-8/UPC-12/EAN-13/GTIN-14) за алгоритмом mod 10 */
function checkDigit(body) {
	let sum = 0;
	for (let i = 0; i < body.length; i++) {
		const d = Number(body[body.length - 1 - i]);
		sum += i % 2 === 0 ? d * 3 : d;
	}
	return String((10 - (sum % 10)) % 10);
}

/** Перевірка будь-якого GTIN: лише цифри, довжина 8/12/13/14, коректна контрольна цифра */
function isValid(code) {
	const s = String(code || "");
	if (!/^\d{8}$|^\d{12,14}$/.test(s)) return false;
	return checkDigit(s.slice(0, -1)) === s.slice(-1);
}

/** Внутрішній EAN-13: префікс 200–299 + 9 цифр лічильника + контрольна */
async function generate(conn) {
	const cfg = await settings.get("ean");
	const seq = await nextSequence("ean", conn);
	if (seq > 999999999) throw Object.assign(new Error("Вичерпано діапазон внутрішніх EAN для префікса"), { status: 409 });
	const body = cfg.internal_prefix + String(seq).padStart(9, "0");
	return body + checkDigit(body);
}

module.exports = { checkDigit, isValid, generate };