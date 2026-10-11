"use strict";

/**
 * Google Merchant Center — RSS 2.0 з простором імен g:
 * https://support.google.com/merchants/answer/7052112 (специфікація атрибутів)
 * Варіанти — окремі товари з g:item_group_id; ціна зі знижкою — g:price (стара) + g:sale_price.
 */
const { esc, cut, tag } = require("./xml");

const WEIGHT_UNITS = { kg: "kg", g: "g", lb: "lb", oz: "oz" };

function head(feed, ctx) {
	return (
		`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>\n` +
		tag("title", (feed.shop && feed.shop.name) || feed.name) +
		"\n" +
		tag("link", feed.base_url) +
		"\n" +
		tag("description", feed.name) +
		"\n"
	);
}

function tail() {
	return "</channel>\n</rss>\n";
}

const money = (n, cur) => `${Number(n).toFixed(2)} ${cur}`;

/** Записи фіду для товару: [{ xml } | { skip: reason }] */
function* items(p, feed, ctx, h) {
	const list = p._variants.length ? p._variants : [null];
	if (p.type === "variable" && !p._variants.length) return yield { skip: "variable_without_variants" };

	for (const v of list) {
		const title = cut([p._name, v && v.label].filter(Boolean).join(" — "), 150);
		if (!title) {
			yield { skip: "no_name" };
			continue;
		}
		const { price, compare } = h.priceOf(p, v);
		if (!(price > 0) || Number(p.price_on_request)) {
			yield { skip: "no_price" };
			continue;
		}
		const link = h.productUrl(p, v);
		if (!link) {
			yield { skip: "no_link" };
			continue;
		}
		const imgs = h.imagesOf(p, v);
		if (!imgs.length) {
			yield { skip: "no_image" };
			continue;
		}
		const availability = h.availability(p, v);
		if (feed.filters.in_stock_only && availability !== "in_stock") {
			yield { skip: "out_of_stock" };
			continue;
		}

		const brand = h.brandOf(p);
		const gtin = (v && v.ean) || p.ean || p.upc || p.isbn || null;
		const mpn = (v && v.mpn) || p.mpn || null;
		const description = cut(h.stripHtml(p._description) || h.stripHtml(p._short) || p._name, 5000);
		const path = h.catPath(p);
		const id = (v ? v.sku || `${p.id}-${v.id}` : p.sku || String(p.id)).slice(0, 50);
		const weight = p.weight !== null && Number(p.weight) > 0 ? Number(p.weight) + Number((v && v.weight_impact) || 0) : null;

		let x = "<item>\n";
		x += tag("g:id", id);
		x += tag("title", title);
		x += tag("description", description);
		x += tag("link", link);
		x += tag("g:image_link", imgs[0]);
		imgs.slice(1, 11).forEach((u) => (x += tag("g:additional_image_link", u)));
		x += tag("g:availability", availability);
		if (compare) {
			x += tag("g:price", money(compare, ctx.currency));
			x += tag("g:sale_price", money(price, ctx.currency));
		} else {
			x += tag("g:price", money(price, ctx.currency));
		}
		x += tag("g:condition", p.item_condition || "new");
		x += tag("g:brand", brand);
		x += tag("g:gtin", gtin);
		x += tag("g:mpn", mpn);
		// Без GTIN і без пари бренд+MPN Google вимагає явно сказати, що ідентифікаторів немає
		if (!gtin && !(brand && mpn)) x += tag("g:identifier_exists", "no");
		if (v) x += tag("g:item_group_id", p.sku || String(p.id));
		if (path.length) x += tag("g:product_type", path.join(" > "));
		if (weight && WEIGHT_UNITS[p.weight_unit || "kg"]) x += tag("g:shipping_weight", `${weight} ${WEIGHT_UNITS[p.weight_unit || "kg"]}`);
		x += "</item>\n";
		yield { xml: x };
	}
}

module.exports = { head, tail, items, esc };