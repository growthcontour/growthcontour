"use strict";

/**
 * Джерела курсів. Усі віддають гривень за 1 одиницю валюти; якщо базова валюта системи не UAH —
 * курс рахується крос-курсом через гривню (гривень за 1 валюти / гривень за 1 базової).
 * fetch(codes, base) → [{ code, rate }] — rate у базовій валюті системи за 1 одиницю.
 */

let timeoutMs = 15000;
const setTimeoutMs = (ms) => (timeoutMs = Math.max(1000, Number(ms) || 15000));

async function getJson(url) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json", "User-Agent": "Growth contour" } });
		if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

/** uah: Map(code → гривень за 1 одиницю) → [{ code, rate }] у базовій валюті системи */
function toBase(uah, codes, base) {
	uah.set("UAH", 1);
	const baseRate = uah.get(base);
	if (!(baseRate > 0)) throw new Error(`no rate for base currency ${base}`);
	return codes.filter((c) => uah.get(c) > 0).map((c) => ({ code: c, rate: Math.round((uah.get(c) / baseRate) * 1e6) / 1e6 }));
}

/* ─── НБУ: офіційний курс (оновлюється раз на робочий день) ─── */
async function nbu(codes, base) {
	const rows = await getJson("https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json");
	const uah = new Map((Array.isArray(rows) ? rows : []).map((r) => [String(r.cc).toUpperCase(), Number(r.rate)]));
	return toBase(uah, codes, base);
}

/* ─── ПриватБанк: курс продажу (coursid 5 — готівковий, 11 — безготівковий) ─── */
function privat(coursid) {
	return async (codes, base) => {
		const rows = await getJson(`https://api.privatbank.ua/p24api/pubinfo?exchange&coursid=${coursid}`);
		const uah = new Map(
			(Array.isArray(rows) ? rows : []).filter((r) => String(r.base_ccy).toUpperCase() === "UAH").map((r) => [String(r.ccy).toUpperCase().replace("RUR", "RUB"), Number(r.sale)])
		);
		return toBase(uah, codes, base);
	};
}

/* ─── Monobank: курс продажу (або крос-курс, якщо продажу немає). API — не частіше разу на 5 хв ─── */
const ISO = { 840: "USD", 978: "EUR", 826: "GBP", 985: "PLN", 756: "CHF", 203: "CZK", 124: "CAD", 392: "JPY", 156: "CNY", 752: "SEK", 578: "NOK", 208: "DKK", 348: "HUF", 949: "TRY", 498: "MDL", 398: "KZT", 981: "GEL", 36: "AUD", 946: "RON", 975: "BGN" };
async function monobank(codes, base) {
	const rows = await getJson("https://api.monobank.ua/bank/currency");
	const uah = new Map();
	for (const r of Array.isArray(rows) ? rows : []) {
		if (Number(r.currencyCodeB) !== 980 || !ISO[r.currencyCodeA]) continue;
		const rate = Number(r.rateSell) || Number(r.rateCross);
		if (rate > 0) uah.set(ISO[r.currencyCodeA], rate);
	}
	return toBase(uah, codes, base);
}

/** Ключ джерела → функція. Назви — у locales/<мова>.json (modules.currencyRates.providers.<ключ>) */
const PROVIDERS = { nbu, privat_cash: privat(5), privat_card: privat(11), monobank };

module.exports = { PROVIDERS, toBase, setTimeoutMs };