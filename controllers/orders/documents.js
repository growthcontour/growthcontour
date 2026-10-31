"use strict";

/**
 * Друковані документи замовлення: рахунок (invoice) і видаткова накладна (delivery).
 * Реквізити продавця — «Налаштування товарів → Документи замовлень».
 * Сума прописом — для гривні (для інших валют друкується лише числом).
 */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const settings = require("../catalog/products/settings");
const i18n = require("../../config/i18n/i18n");
const LOCALE = process.env.APP_LOCALE || "uk";
const t = (phrase, vars) => i18n.__({ phrase, locale: LOCALE }, vars || {});

const P = config.get("configDatabase").prefix;
const TYPES = ["invoice", "delivery"];
const NON_PRODUCT_ITEM_TYPES = ["shipping", "fee", "tip", "discount", "gift_card", "wrapping"];

function httpErr(status, message) {
	return Object.assign(new Error(message), { status });
}

/* ─── Сума прописом (українська, гривні) ─── */
// Слова — orders.print.words.* (списки через кому); форми: [одна, дві-чотири, пʼять+], рід
const W = (k) => t("orders.print.words." + k).split(",");
const SCALES = [
	["uah", "f"],
	["thousand", "f"],
	["million", "m"],
	["billion", "m"],
];
const plural = (n, forms) => {
	const a = n % 100;
	const b = n % 10;
	if (a >= 11 && a <= 19) return forms[2];
	if (b === 1) return forms[0];
	if (b >= 2 && b <= 4) return forms[1];
	return forms[2];
};
function triad(n, gender) {
	const out = [];
	const h = Math.floor(n / 100);
	const tn = Math.floor((n % 100) / 10);
	const o = n % 10;
	if (h) out.push(W("hundreds")[h]);
	if (tn === 1) out.push(W("teens")[o]);
	else {
		if (tn) out.push(W("tens")[tn]);
		if (o) out.push(W(gender === "f" ? "ones_F" : "ONES_M")[o]);
	}
	return out.join(" ");
}
function uahInWords(amount) {
	const total = Math.round(Math.abs(Number(amount) || 0) * 100);
	let whole = Math.floor(total / 100);
	const kop = total % 100;
	const parts = [];
	if (whole === 0) parts.push(t("orders.print.words.zero"));
	for (let i = 0; whole > 0 && i < SCALES.length; i++) {
		const n = whole % 1000;
		whole = Math.floor(whole / 1000);
		const [scale, gender] = SCALES[i];
		const forms = W(scale);
		if (n || i === 0) parts.unshift([triad(n, gender), plural(n, forms)].filter(Boolean).join(" "));
	}
	const text = parts.join(" ").replace(/\s+/g, " ").trim();
	return text.charAt(0).toUpperCase() + text.slice(1) + ` ${String(kop).padStart(2, "0")} ${plural(kop, W("kop"))}`;
}

/** Дані документа: замовлення, покупець, позиції, суми, реквізити продавця */
async function load(idOrder, type, idLang, opts = {}) {
	if (!TYPES.includes(type)) throw httpErr(404, "Unknown document");
	const [[o]] = await pool.query(
		`SELECT o.*, opl.text AS payment_name, odl.text AS delivery_name
		   FROM ${P}orders o
		   LEFT JOIN ${P}orders_payment_lang opl ON opl.id_payment = o.payment AND opl.id_lang = ?
		   LEFT JOIN ${P}orders_delivery_lang odl ON odl.id_delivery = o.delivery AND odl.id_lang = ?
		  WHERE o.id = ? AND o.deleted_at IS NULL`,
		[idLang, idLang, idOrder]
	);
	if (!o) throw httpErr(404, "Order not found");
	const [items] = await pool.query(`SELECT * FROM ${P}orders_items WHERE id_order = ? ORDER BY id`, [idOrder]);
	const [addresses] = await pool.query(`SELECT * FROM ${P}orders_addresses WHERE id_order = ?`, [idOrder]);
	const seller = await settings.get("documents");

	let client = {};
	try {
		client = typeof o.client === "string" ? JSON.parse(o.client) : o.client || {};
	} catch {}
	const addr = addresses.find((a) => a.type === "billing") || addresses[0] || {};
	const ship = addresses.find((a) => a.type !== "billing") || addr;
	const buyer = {
		name: [addr.company, [addr.firstname || client.firstname, addr.lastname || client.lastname].filter(Boolean).join(" ")].filter(Boolean).join(", ") || client.email || "—",
		phone: addr.phone || client.phone || "",
		email: client.email || "",
		address: [ship.postcode, ship.country, ship.region, ship.city, ship.warehouse, [ship.address_1, ship.address_2].filter(Boolean).join(", ")].filter(Boolean).join(", "),
	};

	// Товари — окремо від доставки / зборів; доставка — рядком, якщо є сума
	const goods = items.filter((it) => !NON_PRODUCT_ITEM_TYPES.includes(it.type || "product"));
	const lines = goods.map((it, i) => ({ n: i + 1, name: it.name, sku: it.sku, qty: Number(it.quantity), price: Number(it.quantity) ? Number(it.total) / Number(it.quantity) : Number(it.unit_price_wt), total: Number(it.total) }));
	if (Number(o.total_shipping) > 0) lines.push({ n: lines.length + 1, name: o.delivery_name || opts.shippingLabel || "", sku: null, qty: 1, price: Number(o.total_shipping), total: Number(o.total_shipping), service: true });

	const date = new Date(o.date_order || o.date_add);
	const valid = seller.invoice_days ? new Date(date.getTime() + seller.invoice_days * 86400000) : null;
	return {
		type,
		order: o,
		number: o.external_number || o.reference || String(o.id),
		date,
		valid,
		seller,
		buyer,
		lines,
		currency: o.currency_iso,
		total: Number(o.total),
		discount: Number(o.total_discount),
		tax: Number(o.total_tax),
		words: o.currency_iso === "UAH" ? uahInWords(o.total) : null,
	};
}

module.exports = { TYPES, load, uahInWords };