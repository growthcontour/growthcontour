const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const catalogSettings = require("../catalog/products/settings");

const P = config.get("configDatabase").prefix;

/*
 * Валюти замовлень — один довідник із каталогом: основна валюта = «Ціни → основна валюта»,
 * курси = довідник «Валюти» (скільки основної за 1 одиницю, без комерційної корекції).
 * Таблиця orders_currency лишається для id валюти в замовленні та як запасний курс.
 */
let base = "UAH";
// Символи валют для відображення: довідник, для основної — типові
const KNOWN_SYMBOLS = { UAH: "₴", USD: "$", EUR: "€", GBP: "£", PLN: "zł", CZK: "Kč", CHF: "₣", JPY: "¥", CNY: "¥", TRY: "₺", KZT: "₸" };
let symbols = { ...KNOWN_SYMBOLS };
// Формат суми за валютою: { symbol, symbol_pos, decimals } (довідник «Валюти»; основна — base_format)
let formats = {};
let ratesCache = null;
let ratesCacheAt = 0;
const CACHE_TTL = 60 * 1000;

async function getRates() {
	if (ratesCache && Date.now() - ratesCacheAt < CACHE_TTL) return ratesCache;
	const all = await catalogSettings.getAll();
	base = (all.prices && all.prices.base_currency) || base;
	const [rows] = await connection_pool.query(`SELECT currency_iso_code, rate FROM ${P}orders_currency`);
	ratesCache = {};
	rows.forEach((r) => {
		if (Number(r.rate) > 0) ratesCache[String(r.currency_iso_code).toUpperCase()] = Number(r.rate);
	});
	// Довідник каталогу важливіший за старі курси таблиці замовлень
	((all.currencies && all.currencies.list) || []).forEach((c) => {
		if (Number(c.rate) > 0) ratesCache[c.code] = Number(c.rate);
	});
	ratesCache[base] = 1;
	symbols = { ...KNOWN_SYMBOLS };
	formats = {};
	((all.currencies && all.currencies.list) || []).forEach((c) => {
		if (c.symbol) symbols[c.code] = c.symbol;
		formats[c.code] = { symbol_pos: c.symbol_pos || "after", decimals: Number.isInteger(c.decimals) ? c.decimals : 2 };
	});
	const bf = (all.currencies && all.currencies.base_format) || {};
	if (bf.symbol) symbols[base] = bf.symbol;
	formats[base] = { symbol_pos: bf.symbol_pos || "after", decimals: Number.isInteger(bf.decimals) ? bf.decimals : 2 };
	ratesCacheAt = Date.now();
	return ratesCache;
}

async function getBase() {
	await getRates();
	return base;
}

/**
 * Курс валюти замовлення до основної.
 * Спершу довідник (сайт рахує курс відносно СВОЄЇ валюти за замовчуванням, а не нашої основної);
 * курс від сайту — лише якщо валюти немає в довіднику і він не заглушка 1.
 */
async function resolveRate(iso, incomingRate) {
	const rates = await getRates();
	iso = (iso || base).toUpperCase();
	if (iso === base) return 1;
	if (rates[iso] > 0) return rates[iso];
	const r = Number(incomingRate);
	if (r > 0 && r !== 1) return r;
	logging.error(`[currency] Немає курсу для ${iso}, використано 1`);
	return 1;
}

/** id валюти в orders_currency; немає — додати (курс з довідника) */
async function currencyId(conn, iso) {
	const db = conn || connection_pool;
	iso = String(iso || base).toUpperCase().slice(0, 3);
	const [[cur]] = await db.query(`SELECT id FROM \`${P}orders_currency\` WHERE currency_iso_code = ? LIMIT 1`, [iso]);
	if (cur) return cur.id;
	try {
		const rates = await getRates();
		const [r] = await db.query(`INSERT INTO \`${P}orders_currency\` (currency_iso_code, rate) VALUES (?, ?)`, [iso, rates[iso] || 1]);
		return r.insertId;
	} catch (e) {
		logging.error(`[currency] Не вдалося додати валюту ${iso}: ${e.message}`);
		const [[any]] = await db.query(`SELECT id FROM \`${P}orders_currency\` ORDER BY id LIMIT 1`);
		return any ? any.id : 1;
	}
}

function toBase(amount, rate) {
	return Math.round((Number(amount) || 0) * (Number(rate) || 1) * 10000) / 10000;
}

getRates().catch(() => {});

/** Символ валюти (немає — код) */
const symbolOf = (iso) => symbols[String(iso || base).toUpperCase()] || String(iso || base).toUpperCase();

/** Формати всіх валют для браузера: { CODE: { symbol, symbol_pos, decimals } } */
function formatsMap() {
	const out = {};
	for (const code of new Set([...Object.keys(symbols), ...Object.keys(formats)])) out[code] = { symbol: symbols[code] || code, symbol_pos: "after", decimals: 2, ...(formats[code] || {}) };
	return out;
}

/** Сума з символом за форматом валюти: 1 234,50 ₴ або $1 234,50 */
function formatMoney(amount, iso) {
	const code = String(iso || base).toUpperCase();
	const f = formatsMap()[code] || { symbol: code, symbol_pos: "after", decimals: 2 };
	const n = (Number(amount) || 0).toLocaleString("uk-UA", { minimumFractionDigits: f.decimals, maximumFractionDigits: f.decimals });
	return f.symbol_pos === "before" ? f.symbol + n : n + " " + f.symbol;
}

module.exports = { resolveRate, toBase, getRates, getBase, currencyId, symbolOf, symbolsMap: () => ({ ...symbols }), formatsMap, formatMoney };
// Основна валюта (синхронно, з кешу; оновлюється щохвилини при зверненні до курсів)
Object.defineProperty(module.exports, "BASE_CURRENCY", { enumerable: true, get: () => base });