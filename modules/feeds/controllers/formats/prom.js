"use strict";

/**
 * Prom.ua — формат YML (yml_catalog).
 * Варіанти — окремі offer з group_id; категорії — увесь активний довідник (parentId зберігає дерево).
 */
const { esc, cdata, cut, tag } = require("./xml");

function head(feed, ctx) {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
	let x = `<?xml version="1.0" encoding="UTF-8"?>\n<yml_catalog date="${date}">\n<shop>\n`;
	x += tag("name", (feed.shop && feed.shop.name) || feed.name) + "\n";
	x += tag("company", (feed.shop && feed.shop.company) || (feed.shop && feed.shop.name) || feed.name) + "\n";
	x += tag("url", feed.base_url) + "\n";
	x += `<currencies><currency id="${esc(ctx.currency)}" rate="1"/></currencies>\n<categories>\n`;
	for (const c of ctx.maps.categories) {
		if (!Number(c.status)) continue;
		x += `<category id="${c.id}"${c.id_parent ? ` parentId="${c.id_parent}"` : ""}>${esc(c.name)}</category>\n`;
	}
	return x + "</categories>\n<offers>\n";
}

function tail() {
	return "</offers>\n</shop>\n</yml_catalog>\n";
}

function* items(p, feed, ctx, h) {
	const list = p._variants.length ? p._variants : [null];
	if (p.type === "variable" && !p._variants.length) return yield { skip: "variable_without_variants" };

	for (const v of list) {
		if (!p._name) {
			yield { skip: "no_name" };
			continue;
		}
		if (!p.id_category_main) {
			yield { skip: "no_category" };
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
		if (!imgs.length && feed.filters.with_images_only !== false) {
			yield { skip: "no_image" };
			continue;
		}
		const availability = h.availability(p, v);
		// Prom: available="false" означає «під замовлення». Товар, який не можна замовити, у фід не йде
		if (availability === "out_of_stock" || (feed.filters.in_stock_only && availability !== "in_stock")) {
			yield { skip: "out_of_stock" };
			continue;
		}

		const id = v ? `${p.id}v${v.id}` : String(p.id);
		const qty = h.qtyOf(p, v);
		const available = availability === "in_stock" ? "true" : "false";
		let x = `<offer id="${esc(id)}" available="${available}"${v ? ` group_id="${p.id}"` : ""}>\n`;
		x += tag("url", link);
		x += tag("price", price.toFixed(2));
		if (compare) x += tag("oldprice", compare.toFixed(2));
		x += tag("currencyId", ctx.currency);
		x += tag("categoryId", p.id_category_main);
		imgs.slice(0, 10).forEach((u) => (x += tag("picture", u)));
		x += tag("name", cut([p._name, v && v.label].filter(Boolean).join(" "), 255));
		x += tag("vendor", h.brandOf(p));
		x += tag("vendorCode", (v && v.sku) || p.sku);
		x += tag("barcode", (v && v.ean) || p.ean);
		if (Number(p.track_inventory)) x += tag("quantity_in_stock", Math.max(0, Math.floor(qty)));
		// Prom приймає HTML в описі, тож віддаємо як є (вже очищений санітайзером при збереженні)
		const description = p._description || p._short;
		if (description) x += `<description>${cdata(description)}</description>`;
		if (v && v.label) x += `<param name="${esc(ctx.variantParam)}">${esc(v.label)}</param>`;
		x += "\n</offer>\n";
		yield { xml: x };
	}
}

module.exports = { head, tail, items };