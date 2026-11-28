"use strict";

/**
 * Оформлення замовлення з вітрини Telegram і все, що після нього:
 *  - способи доставки й оплати магазину (для вітрини — без секретів);
 *  - замовлення: кошик перевіряється заново на сервері, створення — тим самим кодом, що й замовлення сайту
 *    (createOrderFromPayload), канал продажу — інтеграція магазину; позиції одразу прив'язані до товарів каталогу;
 *  - оплата: накладений платіж / реквізити — текст; Monobank — посилання модуля monobank (акаунт за каналом продажу);
 *    Telegram Payments — рахунок у Telegram (createInvoiceLink), підтвердження в боті (pre_checkout_query, successful_payment);
 *  - Нова пошта (модуль novaposhta): місто й відділення — з довідника НП; у замовлення йдуть ref міста й відділення,
 *    тож чернетка відправлення НП у замовленні заповнюється без ручного пошуку;
 *  - «Мої замовлення» у вітрині й повідомлення покупцю в бот про зміну статусу (фонова перевірка раз на хвилину).
 */

const crypto = require("crypto");
const { pool, P, T, httpErr, str, statusNameSql, langCode, TG_CURRENCIES, TG_ZERO_EXP } = require("./common");
const tg = require("./telegram");
const shops = require("./shops");
const catalog = require("./catalog");
const i18n = require("../../../config/i18n/i18n");

const L = (k, vars) => i18n.__({ phrase: "modules.telegramshop." + k, locale: process.env.APP_LOCALE || "uk" }, vars || {});
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const ZERO_DEC = TG_ZERO_EXP;
const minor = (amount, iso) => Math.round(Number(amount) * (ZERO_DEC.has(iso) ? 1 : 100));
const fromMinor = (n, iso) => Number(n) / (ZERO_DEC.has(iso) ? 1 : 100);

/** Чи увімкнено модуль Monobank і чи є активний акаунт для каналу продажу */
async function monobankReady(idIntegration) {
	try {
		const [[m]] = await pool.query(`SELECT enabled FROM ${P}modules_state WHERE name = 'monobank'`);
		if (!m || !Number(m.enabled)) return false;
		const acc = await require("../../monobank/controllers/accounts").forIntegration(idIntegration);
		return !!(acc && acc.status);
	} catch {
		return false;
	}
}

/** Чи увімкнено модуль Нова пошта і чи завантажено довідник міст */
let npCache = { at: 0, ok: false };
async function npReady() {
	if (Date.now() - npCache.at < 60 * 1000) return npCache.ok;
	let ok = false;
	try {
		const [[m]] = await pool.query(`SELECT enabled FROM ${P}modules_state WHERE name = 'novaposhta'`);
		if (m && Number(m.enabled)) {
			const [[c]] = await pool.query(`SELECT 1 AS x FROM ${P}np_cities LIMIT 1`);
			ok = !!c;
		}
	} catch {
		ok = false;
	}
	npCache = { at: Date.now(), ok };
	return ok;
}
const isNp = (kind) => String(kind || "").startsWith("np_");
const npDir = () => require("../../novaposhta/controllers/directory");
const npShip = () => require("../../novaposhta/controllers/shipments");

/**
 * Доставка й накладений платіж для кошика (той самий розрахунок для вітрини й оформлення).
 * goods — сума товарів після знижки. → {
 *   price — доставка, що входить у суму замовлення; carrier — покупець платить перевізнику при отриманні;
 *   free; api — ціну рахує Нова пошта; estimate — орієнтовна ціна НП, коли вона не входить у суму;
 *   cod_fee — комісія магазину за накладений платіж (у сумі замовлення); np_cod — комісія НП за грошовий переказ
 *   (платить покупець при отриманні); weight_missing — одиниць товару без ваги (рахуються вагою за замовчуванням) }
 * Без міста або без відповіді НП ціна невідома — як «за тарифами перевізника».
 */
async function shippingFor(shop, delivery, cart, cityRef, pay, goods) {
	const q = shops.shippingQuote(delivery, cart.total, cart.weight);
	const out = { price: q.price, carrier: !!q.carrier, free: !!q.free, api: !!q.api, estimate: null, cod_fee: 0, np_cod: 0, weight_missing: Number(cart.weight_missing) || 0 };
	const cod = !!(pay && pay.kind === "cod");
	if (cod) out.cod_fee = round2((Number(pay.fee_fixed) || 0) + (goods * (Number(pay.fee_percent) || 0)) / 100);
	if (q.api) out.carrier = true;
	if (delivery && isNp(delivery.kind) && cityRef && (q.api || cod) && (await npReady())) {
		const r = await npShip()
			.priceQuote({ idIntegration: shop.id_integration, cityRef, service: delivery.kind.slice(3), weight: cart.weight, missing: out.weight_missing, declared: goods, cod: cod ? goods + out.cod_fee : 0 })
			.catch((e) => (console.error("[telegramshop] np quote:", e.message), null));
		if (r && q.api) {
			if (delivery.api_include) {
				out.price = r.cost;
				out.carrier = false;
				out.free = !(r.cost > 0);
			} else out.estimate = r.cost;
		}
		if (r && cod) out.np_cod = r.cost_redelivery;
	}
	return out;
}

/** Розрахунок для вітрини: b { delivery, payment, city_ref, lines, discount } (discount — знижка промокоду з вітрини, лише для оцінки) */
async function quote(shop, ctx, b) {
	const m = await methods(shop);
	const delivery = m.delivery.find((d) => d.id === b.delivery) || null;
	const pay = m.payments.find((p) => p.id === b.payment) || null;
	const cart = await catalog.cart(shop, ctx, b.lines);
	const goods = round2(Math.max(0, cart.total - Math.max(0, Number(b.discount) || 0)));
	return shippingFor(shop, delivery, cart, str(b.city_ref, 36) || null, pay, goods);
}

/** Пошук міст НП (від 2 символів) */
async function npCities(q) {
	if (!(await npReady())) return [];
	const rows = await npDir().cities(str(q, 64));
	return rows.filter((c) => c.warehouses > 0).map((c) => ({ ref: c.ref, name: c.name, area: c.area || "", type: c.type || "" }));
}

/** Відділення або поштомати міста НП; q — номер або частина адреси */
async function npWarehouses(cityRef, q, kind) {
	if (!(await npReady())) return [];
	const rows = await npDir().warehouses(String(cityRef || ""), str(q, 64), kind === "np_postomat" ? "postomat" : "warehouse");
	return rows.map((w) => ({ ref: w.ref, number: w.number, name: w.name, short: w.short_address || "" }));
}

/** Способи доставки й оплати для вітрини: лише активні й ті, що реально працюють */
async function methods(shop) {
	const s = shop.settings;
	const currency = s.payments.some((p) => p.active && p.kind === "telegram") ? (await catalog.ctxFor(shop, null)).currency : null;
	const mono = s.payments.some((p) => p.active && p.kind === "monobank") ? await monobankReady(shop.id_integration) : false;
	const np = s.delivery.some((d) => d.active && isNp(d.kind)) ? await npReady() : false;
	return {
		delivery: s.delivery
			.filter((d) => d.active && (!isNp(d.kind) || np))
			.map((d) => ({ id: d.id, name: d.name, kind: d.kind, price_mode: d.price_mode, price: d.price, rates: d.rates, free_from: d.free_from, api_include: !!d.api_include, note: d.note })),
		payments: s.payments
			// Оплата в Telegram — лише якщо Telegram приймає валюту магазину
			.filter((p) => p.active && (p.kind !== "monobank" || mono) && (p.kind !== "telegram" || (p.token_enc && TG_CURRENCIES.has(String(currency || "").toUpperCase()))))
			.map((p) => ({ id: p.id, name: p.name, kind: p.kind, text: p.kind === "requisites" ? "" : p.text, fee_fixed: Number(p.fee_fixed) || 0, fee_percent: Number(p.fee_percent) || 0 })),
		note: s.checkout_note || "",
	};
}

/** Покупець вітрини (з підписаного initData) */
async function customerOf(shop, user) {
	const [[c]] = await pool.query(`SELECT * FROM ${T.customers} WHERE id_shop = ? AND tg_user_id = ?`, [shop.id, user.id]);
	if (!c) throw httpErr(401, "modules.telegramshop.app.e_auth");
	return c;
}

// ── Промокоди системи (controllers/orders/promo) ──
const promoLib = () => require("../../../controllers/orders/promo");
const promoKey = (shop, user) => `tg:${shop.id}:${user.id}`;

/** Знижка промокоду для перевіреного кошика (cart — результат catalog.cart) */
async function applyPromo(shop, ctx, user, code, cart, idClient) {
	const [[c]] = await pool.query(`SELECT id, id_client FROM ${T.customers} WHERE id_shop = ? AND tg_user_id = ?`, [shop.id, user.id]);
	const [[o]] = c ? await pool.query(`SELECT COUNT(*) AS n FROM ${T.orders} t JOIN ${P}orders od ON od.id = t.id_order AND od.is_canceled = 0 WHERE t.id_customer = ?`, [c.id]) : [[{ n: 0 }]];
	const ok = cart.lines.filter((l) => l.qty > 0);
	return promoLib().check(code, {
		id_integration: shop.id_integration,
		currency: ctx.currency,
		items: ok.map((l, i) => ({ key: i, id_product: l.id, total: l.sum, on_sale: !!l.on_sale })),
		subtotal: cart.total,
		customer_key: promoKey(shop, user),
		id_client: idClient || (c && c.id_client) || null,
		has_orders: Number(o.n) > 0,
	});
}

/** Перевірка промокоду з вітрини: { code, discount, free_shipping } */
async function promoFor(shop, ctx, user, code, lines) {
	const cart = await catalog.cart(shop, ctx, lines);
	const r = await applyPromo(shop, ctx, user, code, cart);
	return { code: r.code.code, name: r.code.name || "", type: r.code.type, discount: r.discount, free_shipping: r.free_shipping };
}

/** Що покупець вводив минулого разу — щоб не заповнювати знову */
async function lastForm(shop, user) {
	const c = await customerOf(shop, user);
	const [[o]] = await pool.query(
		`SELECT o.client, a.firstname, a.lastname, a.phone, a.email, a.city, a.city_ref, a.address_1, a.postcode, a.warehouse, a.warehouse_ref, t.delivery, t.payment
		   FROM ${T.orders} t JOIN ${P}orders o ON o.id = t.id_order
		   LEFT JOIN ${P}orders_addresses a ON a.id_order = o.id AND a.type = 'shipping'
		  WHERE t.id_customer = ? ORDER BY t.id DESC LIMIT 1`,
		[c.id]
	);
	return {
		firstname: (o && o.firstname) || c.first_name || "",
		lastname: (o && o.lastname) || c.last_name || "",
		phone: (o && o.phone) || c.phone || "",
		email: (o && o.email) || "",
		city: (o && o.city) || "",
		address: (o && o.address_1) || "",
		postcode: (o && o.postcode) || "",
		point: (o && o.warehouse) || "",
		city_ref: (o && o.city_ref) || "",
		point_ref: (o && o.warehouse_ref) || "",
		delivery: (o && o.delivery) || "",
		payment: (o && o.payment) || "",
	};
}

// Захист від повторних і масових запитів: не більше 5 оформлень за 10 хвилин на покупця
const recent = new Map();
function rateLimit(key) {
	const now = Date.now();
	const list = (recent.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
	if (list.length >= 5) throw httpErr(429, "modules.telegramshop.app.e_rate");
	list.push(now);
	recent.set(key, list);
	if (recent.size > 20000) recent.clear();
}

/**
 * Оформити замовлення.
 * b: { key, lines[], firstname, lastname, phone, email, delivery, city, address, postcode, point, payment, note }
 * key — одноразовий ключ спроби з вітрини: повторне надсилання (поганий зв'язок) не створює друге замовлення.
 */
async function place(shop, ctx, user, b) {
	const key = String(b.key || "");
	if (!/^[a-z0-9-]{16,64}$/i.test(key)) throw httpErr(400, "modules.telegramshop.app.e_form");
	const externalId = `tg${shop.id}_${key}`.slice(0, 120);
	const [[dup]] = await pool.query(`SELECT id FROM ${P}orders WHERE id_integration = ? AND external_id = ? LIMIT 1`, [shop.id_integration, externalId]);
	if (dup) return result(shop, dup.id);

	const customer = await customerOf(shop, user);
	rateLimit(`${shop.id}:${user.id}`);

	// Форма
	const f = {
		firstname: str(b.firstname, 100),
		lastname: str(b.lastname, 100),
		phone: str(b.phone, 32).replace(/[^\d+()\-\s]/g, ""),
		email: str(b.email, 120),
		city: str(b.city, 128),
		address: str(b.address, 255),
		postcode: str(b.postcode, 16),
		point: str(b.point, 255),
		note: str(b.note, 999),
		city_ref: str(b.city_ref, 36),
		point_ref: str(b.point_ref, 36),
	};
	const errors = [];
	if (!f.firstname) errors.push("firstname");
	if (String(f.phone).replace(/\D/g, "").length < 6) errors.push("phone");
	if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) errors.push("email");
	const m = await methods(shop);
	const delivery = m.delivery.find((d) => d.id === b.delivery) || null;
	const payment = m.payments.find((p) => p.id === b.payment) || null;
	if (m.delivery.length && !delivery) errors.push("delivery");
	if (!payment) errors.push("payment");
	// Нова пошта: місто й відділення — лише з довідника (ref), назви беремо з нього ж
	let np = null;
	if (delivery && isNp(delivery.kind)) {
		const city = await npDir().city(f.city_ref);
		if (!city) errors.push("city");
		else {
			np = { service: delivery.kind.slice(3), city, point: null };
			f.city = city.name;
			if (delivery.kind !== "np_address") {
				const w = await npDir().warehouse(f.point_ref);
				const okType = w && (delivery.kind === "np_postomat" ? w.type === "postomat" : w.type !== "postomat");
				if (!w || w.city_ref !== city.ref || !okType) errors.push("point");
				else {
					np.point = w;
					f.point = w.name;
				}
			} else if (!f.address) errors.push("address");
		}
	} else {
		if (delivery && delivery.kind !== "pickup" && !f.city) errors.push("city");
		if (delivery && delivery.kind === "point" && !f.point) errors.push("point");
		if (delivery && delivery.kind === "address" && !f.address) errors.push("address");
	}
	if (errors.length) throw Object.assign(httpErr(400, "modules.telegramshop.app.e_form"), { fields: errors });

	// Кошик — заново з цінами й наявністю на зараз; зміни показуємо покупцю, а не оформлюємо мовчки
	const cart = await catalog.cart(shop, ctx, b.lines);
	const ok = cart.lines.filter((l) => l.qty > 0);
	if (!ok.length) throw httpErr(409, "modules.telegramshop.app.e_cart_empty");
	if (cart.lines.some((l) => l.problem)) return { changed: true, cart };
	if (cart.below_min) throw httpErr(409, "modules.telegramshop.app.e_min", { sum: cart.min_order });

	// Промокод: перевірка заново на момент оформлення (ціни, ліміти, строк)
	let promo = null;
	if (String(b.promo || "").trim()) promo = await applyPromo(shop, ctx, user, b.promo, cart);
	const discount = promo ? round2(promo.discount) : 0;
	// Доставка: одна ціна / за вагою / за тарифами перевізника (у суму не входить) / розрахунок Нової пошти / безкоштовно від суми;
	// накладений платіж — комісія магазину окремим рядком
	const pkind = shop.settings.payments.find((p) => p.id === payment.id);
	const goods = round2(Math.max(0, cart.total - discount));
	const sh = await shippingFor(shop, delivery, cart, np ? np.city.ref : null, pkind, goods);
	let shipping = sh.price;
	const shippingFull = shipping;
	// Хто платить перевізнику (Нова пошта): за тарифами — покупець при отриманні; інакше доставку оплачено магазину — магазин
	const npPayer = sh.carrier ? "Recipient" : "Sender";
	const shipTitle = delivery ? (sh.carrier ? `${delivery.name} (${L("app.carrier")})` : delivery.name) : null;
	if (promo && promo.free_shipping) shipping = 0;
	const codFee = sh.cod_fee;
	const total = round2(goods + shipping + codFee);
	const body = {
		source: { external_id: externalId, channel: "telegram" },
		currency: { iso: ctx.currency },
		client: { firstname: f.firstname, lastname: f.lastname || null, phone: f.phone, email: f.email || null },
		items: ok.map((l) => ({
			name: l.variant_label ? `${l.name} (${l.variant_label})` : l.name,
			sku: l.sku || null,
			external_product_id: String(l.id),
			quantity: l.qty,
			unit_price: l.price,
			total: l.sum,
			meta: { id_product: l.id, id_variant: l.variant || 0, source: "telegram" },
		})),
		// Безкоштовна доставка за промокодом: доставка — повна ціна, знижка в рядку промокоду (сума рядків = разом)
		summary: { total_products: cart.total, total_shipping: shippingFull, total_discount: round2(discount + (shippingFull - shipping)), total },
		totals: [
			{ code: "sub_total", title: L("app.subtotal"), value: cart.total },
			...(promo ? [{ code: "coupon", title: i18n.__({ phrase: "orders.promo.line", locale: process.env.APP_LOCALE || "uk" }, { code: promo.code.code }), value: -round2(discount + (shippingFull - shipping)) }] : []),
			...(delivery ? [{ code: "shipping", title: shipTitle, value: shippingFull }] : []),
			...(codFee > 0 ? [{ code: "fee", title: L("app.cod_fee"), value: codFee }] : []),
			{ code: "total", title: L("app.total"), value: total },
		],
		fees: codFee > 0 ? [{ type: "cod", title: L("app.cod_fee"), amount: codFee }] : [],
		addresses: [
			{
				type: "shipping",
				firstname: f.firstname,
				lastname: f.lastname || null,
				phone: f.phone,
				email: f.email || null,
				city: delivery && delivery.kind !== "pickup" ? f.city : null,
				city_ref: np ? np.city.ref : null,
				region: np ? np.city.area || null : null,
				address_1: delivery && (delivery.kind === "address" || delivery.kind === "np_address") ? f.address : null,
				postcode: delivery && delivery.kind === "address" ? f.postcode || null : null,
				warehouse: delivery && (delivery.kind === "point" || (np && np.point)) ? f.point : null,
				warehouse_ref: np && np.point ? np.point.ref : null,
				// Для чернетки відправлення НП: послуга, місто й точка з ref довідника
				meta: np
					? {
							delivery: {
								service: np.service,
								point: { city: { ref: np.city.ref, name: np.city.name }, area: { name: np.city.area || "" }, warehouse: np.point ? { ref: np.point.ref, number: np.point.number, name: np.point.name } : null },
								address: np.service === "address" ? { street: f.address } : null,
								payer: npPayer,
								// Орієнтовна ціна НП (не входить у суму) і комісія НП за грошовий переказ — для менеджера
								estimate: sh.estimate,
								np_cod: sh.np_cod || null,
							},
					  }
					: null,
			},
		],
		delivery: { method_title: shipTitle, method_code: delivery ? (np ? "novaposhta" : `telegram_${delivery.kind}`) : null },
		payment: { method_title: payment.name, method_code: `telegram_${payment.kind}` },
		custom_fields: { telegram_user: user.username ? "@" + user.username : null, telegram_id: String(user.id) },
		note: f.note || null,
		__id_integration: shop.id_integration,
		__can_create_clients: 1,
	};

	const conn = await pool.getConnection();
	let id;
	try {
		await conn.beginTransaction();
		id = await require("../../../controllers/orders/inboxProcessor").createOrderFromPayload(conn, body);
		// Позиції — точно ті товари й варіанти, що в кошику (не за збігом артикула)
		const [rows] = await conn.query(`SELECT id FROM ${P}orders_items WHERE id_order = ? ORDER BY id`, [id]);
		for (let i = 0; i < rows.length && i < ok.length; i++) {
			await conn.query(`UPDATE ${P}orders_items SET id_product = ?, id_variant = ?, map_source = 'manual' WHERE id = ?`, [ok[i].id, ok[i].variant || 0, rows[i].id]);
		}
		await require("../../../controllers/catalog/products/order-stock").afterItems(conn, id, null);
		const [[o]] = await conn.query(`SELECT status, id_client, currency_rate FROM ${P}orders WHERE id = ?`, [id]);
		// Використання промокоду — у тій самій транзакції (вичерпали ліміт, поки оформлювали, — замовлення не створиться)
		if (promo)
			await promoLib().redeem(conn, promo.code.id, {
				id_order: id,
				id_client: o.id_client,
				customer_key: promoKey(shop, user),
				amount: round2(discount + (shippingFull - shipping)),
				currency: ctx.currency,
				currency_rate: o.currency_rate,
			});
		await conn.query(`INSERT INTO ${T.orders} (id_shop, id_customer, id_order, payment, delivery, last_status, date_add) VALUES (?, ?, ?, ?, ?, ?, NOW())`, [
			shop.id,
			customer.id,
			id,
			payment.id,
			delivery ? delivery.id : null,
			o.status,
		]);
		await conn.query(`UPDATE ${T.customers} SET phone = ?, id_client = COALESCE(?, id_client) WHERE id = ?`, [f.phone, o.id_client || null, customer.id]);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	await require("./engage").clearCart(shop, customer.id, id).catch(() => {});
	if (shop.settings.notify_manager) {
		try {
			require("../../../controllers/orders/notify").fire(id, "new");
		} catch (e) {
			console.error("[telegramshop] notify:", e.message);
		}
	}
	confirmInBot(shop, customer, id, pkind).catch((e) => console.error("[telegramshop] confirm:", e.message));
	// Діалог покупця в контакт-центрі — менеджер може одразу написати в той самий бот
	require("./support")
		.orderOpened(shop, customer, id)
		.catch((e) => console.error("[telegramshop] cc order:", e.message));
	return result(shop, id);
}

/** Відповідь вітрині: номер, сума, що робити з оплатою */
async function result(shop, idOrder) {
	const [[o]] = await pool.query(
		`SELECT o.id, o.reference, o.total, o.currency_iso, o.is_paid, t.payment FROM ${P}orders o JOIN ${T.orders} t ON t.id_order = o.id WHERE o.id = ? AND t.id_shop = ?`,
		[idOrder, shop.id]
	);
	if (!o) throw httpErr(404, "modules.telegramshop.app.e_order");
	const pay = shop.settings.payments.find((p) => p.id === o.payment) || null;
	return {
		order: { id: Number(o.id), reference: o.reference, total: Number(o.total), currency: o.currency_iso, paid: !!Number(o.is_paid) },
		payment: pay ? { kind: pay.kind, name: pay.name, text: ["cod", "requisites"].includes(pay.kind) ? fill(pay.text, o) : "" } : null,
	};
}

/** Текст оплати: {order} — номер замовлення, {total} — сума */
const fill = (text, o) =>
	String(text || "")
		.replace(/\{order\}/g, o.reference)
		.replace(/\{total\}/g, `${Number(o.total).toFixed(2)} ${o.currency_iso}`);

/** Підтвердження в чаті бота: номер, склад, сума, оплата */
async function confirmInBot(shop, customer, idOrder, pay) {
	if (Number(customer.is_blocked)) return;
	const [[o]] = await pool.query(`SELECT reference, total, total_shipping, total_discount, currency_iso FROM ${P}orders WHERE id = ?`, [idOrder]);
	const [items] = await pool.query(`SELECT name, quantity, total FROM ${P}orders_items WHERE id_order = ? ORDER BY id`, [idOrder]);
	const cur = tg.html(o.currency_iso);
	const lines = items.map((i) => `• ${tg.html(i.name)} × ${Number(i.quantity)} — ${Number(i.total).toFixed(2)} ${cur}`);
	let text = L("bot.order_placed", { ref: tg.html(o.reference) }) + "\n\n" + lines.join("\n");
	if (Number(o.total_shipping) > 0) text += "\n" + L("bot.shipping", { sum: `${Number(o.total_shipping).toFixed(2)} ${cur}` });
	if (Number(o.total_discount) > 0) text += "\n" + L("bot.discount", { sum: `−${Number(o.total_discount).toFixed(2)} ${cur}` });
	text += "\n<b>" + L("bot.total", { sum: `${Number(o.total).toFixed(2)} ${cur}` }) + "</b>";
	if (pay) text += "\n" + L("bot.payment", { name: tg.html(pay.name) });
	if (pay && ["cod", "requisites"].includes(pay.kind) && pay.text) text += "\n\n" + tg.html(fill(pay.text, { reference: o.reference, total: o.total, currency_iso: o.currency_iso }));
	await tg.call(shop.token, "sendMessage", { chat_id: customer.tg_user_id, text, parse_mode: "HTML" });
}

/** Онлайн-оплата замовлення покупця: Monobank — посилання, Telegram — рахунок */
async function payLink(shop, user, idOrder) {
	const c = await customerOf(shop, user);
	const [[o]] = await pool.query(
		`SELECT o.id, o.reference, o.total, o.total_paid, o.currency_iso, o.is_paid, o.is_canceled, t.payment
		   FROM ${T.orders} t JOIN ${P}orders o ON o.id = t.id_order AND o.deleted_at IS NULL
		  WHERE t.id_shop = ? AND t.id_customer = ? AND t.id_order = ?`,
		[shop.id, c.id, parseInt(idOrder, 10) || 0]
	);
	if (!o) throw httpErr(404, "modules.telegramshop.app.e_order");
	if (Number(o.is_paid) || Number(o.is_canceled)) throw httpErr(409, "modules.telegramshop.app.e_not_payable");
	const pay = shop.settings.payments.find((p) => p.id === o.payment);
	if (!pay || !["monobank", "telegram"].includes(pay.kind)) throw httpErr(409, "modules.telegramshop.app.e_not_payable");
	const due = round2(Number(o.total) - Number(o.total_paid || 0));
	if (!(due > 0)) throw httpErr(409, "modules.telegramshop.app.e_not_payable");

	if (pay.kind === "monobank") {
		// Невикористане посилання, що ще діє, — те саме (не плодимо рахунки в банку)
		try {
			const [[inv]] = await pool.query(
				`SELECT page_url FROM ${P}modules_monobank_invoices WHERE id_order = ? AND status = 'created' AND source = 'link' AND page_url <> '' AND (expires_at IS NULL OR expires_at > DATE_ADD(NOW(), INTERVAL 10 MINUTE)) ORDER BY id DESC LIMIT 1`,
				[o.id]
			);
			if (inv) return { kind: "monobank", url: inv.page_url };
		} catch {}
		const r = await require("../../monobank/controllers/invoices").create(o.id, {}, null);
		return { kind: "monobank", url: r.invoice.page_url };
	}

	const token = shops.providerToken(pay);
	if (!token) throw httpErr(409, "modules.telegramshop.app.e_not_payable");
	const iso = String(o.currency_iso).toUpperCase();
	if (!TG_CURRENCIES.has(iso)) throw httpErr(409, "modules.telegramshop.app.e_currency", { currency: iso });
	try {
		const link = await tg.call(shop.token, "createInvoiceLink", {
			title: str(L("app.invoice_title", { ref: o.reference }), 32),
			description: str(L("app.invoice_desc", { shop: shop.name, ref: o.reference }), 255),
			payload: `o:${o.id}:${crypto.randomBytes(4).toString("hex")}`,
			provider_token: token,
			currency: iso,
			prices: [{ label: str(L("app.invoice_title", { ref: o.reference }), 32), amount: minor(due, iso) }],
		});
		return { kind: "telegram", url: link };
	} catch (e) {
		console.error("[telegramshop] invoice:", e.message);
		throw httpErr(502, "modules.telegramshop.app.e_invoice", { error: String(e.message).slice(0, 200) });
	}
}

/** Telegram питає перед списанням: замовлення є, не оплачене, сума й валюта збігаються */
async function preCheckout(shop, q) {
	const m = /^o:(\d+)/.exec(String(q.invoice_payload || ""));
	let ok = false;
	if (m) {
		const [[o]] = await pool.query(
			`SELECT o.total, o.total_paid, o.currency_iso, o.is_paid, o.is_canceled FROM ${T.orders} t JOIN ${P}orders o ON o.id = t.id_order AND o.deleted_at IS NULL
			  WHERE t.id_shop = ? AND t.id_order = ?`,
			[shop.id, Number(m[1])]
		);
		const iso = o && String(o.currency_iso).toUpperCase();
		ok = !!o && !Number(o.is_paid) && !Number(o.is_canceled) && q.currency === iso && Number(q.total_amount) === minor(round2(Number(o.total) - Number(o.total_paid || 0)), iso);
	}
	await tg.call(shop.token, "answerPreCheckoutQuery", ok ? { pre_checkout_query_id: q.id, ok: true } : { pre_checkout_query_id: q.id, ok: false, error_message: L("app.e_not_payable") });
}

/** Оплата в Telegram пройшла: платіж у замовленні, статус «оплачено» (якщо задано), сповіщення */
async function paid(shop, msg) {
	const sp = msg.successful_payment;
	const m = /^o:(\d+)/.exec(String(sp.invoice_payload || ""));
	if (!m) return;
	const idOrder = Number(m[1]);
	const iso = String(sp.currency).toUpperCase();
	const amount = fromMinor(sp.total_amount, iso);
	const txn = String(sp.provider_payment_charge_id || sp.telegram_payment_charge_id).slice(0, 191);
	const conn = await pool.getConnection();
	let res = null;
	try {
		await conn.beginTransaction();
		const [[o]] = await conn.query(
			`SELECT o.id, o.id_integration, o.currency_rate, o.status FROM ${T.orders} t JOIN ${P}orders o ON o.id = t.id_order WHERE t.id_shop = ? AND t.id_order = ? FOR UPDATE`,
			[shop.id, idOrder]
		);
		if (!o) {
			await conn.rollback();
			return;
		}
		const [[seen]] = await conn.query(`SELECT id FROM ${P}orders_payments WHERE id_order = ? AND driver = 'telegram' AND transaction_id = ?`, [idOrder, txn]);
		if (seen) {
			await conn.rollback();
			return;
		}
		const rate = Number(o.currency_rate) || 1;
		const base = Math.round((amount / rate) * 10000) / 10000;
		await conn.query(
			`INSERT INTO ${P}orders_payments (id_order, id_integration, driver, transaction_id, amount, amount_base, currency_iso, status, paid_at, raw, date_add)
			 VALUES (?, ?, 'telegram', ?, ?, ?, ?, 'paid', NOW(), ?, NOW())`,
			[idOrder, o.id_integration, txn, amount, base, iso, JSON.stringify(sp)]
		);
		await conn.query(`UPDATE ${P}orders SET total_paid = total_paid + ?, total_paid_base = total_paid_base + ? WHERE id = ?`, [amount, base, idOrder]);
		await conn.query(`INSERT INTO ${P}orders_events (id_order, id_user, type, payload, source, date_add) VALUES (?, NULL, 'payment', ?, 'system', NOW())`, [
			idOrder,
			JSON.stringify({ via: "telegram", amount, currency: iso, telegram_charge: sp.telegram_payment_charge_id, provider_charge: sp.provider_payment_charge_id }),
		]);
		const target = shop.settings.status_paid;
		if (target && Number(o.status) !== target) {
			const { applyStatus, deriveOrderFlags } = require("../../../controllers/orders/statusFlags");
			const fin = (await deriveOrderFlags(Number(o.status)).catch(() => ({}))).is_final;
			if (!fin) {
				const r = await applyStatus(conn, idOrder, target, { source: "system", comment: "Telegram Payments", extra: { via: "telegram" } });
				if (r) res = { ...r, to: target };
				// Про цей статус покупець дізнається з підтвердження оплати — окреме повідомлення не потрібне
				await conn.query(`UPDATE ${T.orders} SET last_status = ? WHERE id_order = ?`, [target, idOrder]);
			}
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	const notify = require("../../../controllers/orders/notify");
	if (res) {
		require("../../../controllers/orders/outboxProcessor").kickOutbox();
		notify.fire(idOrder, "status", { to: res.to });
	}
	notify.fire(idOrder, "paid", { amount: amount.toFixed(2) });
	const [[o]] = await pool.query(`SELECT reference FROM ${P}orders WHERE id = ?`, [idOrder]);
	await tg.call(shop.token, "sendMessage", { chat_id: msg.chat.id, text: L("bot.paid", { ref: tg.html(o.reference), sum: `${amount.toFixed(2)} ${tg.html(iso)}` }), parse_mode: "HTML" }).catch(() => {});
}

/** Замовлення покупця для вітрини */
async function myOrders(shop, user) {
	const c = await customerOf(shop, user);
	const [rows] = await pool.query(
		`SELECT o.id, o.reference, o.total, o.total_paid, o.currency_iso, o.is_paid, o.is_canceled, o.is_shipped, o.date_add,
		        ${statusNameSql("o.status")} AS status_name, t.payment,
		        (SELECT COUNT(*) FROM ${P}orders_items i WHERE i.id_order = o.id) AS items
		   FROM ${T.orders} t JOIN ${P}orders o ON o.id = t.id_order AND o.deleted_at IS NULL
		  WHERE t.id_shop = ? AND t.id_customer = ? ORDER BY t.id DESC LIMIT 30`,
		[langCode(user.language_code || c.language_code), shop.id, c.id]
	);
	return rows.map((o) => {
		const pay = shop.settings.payments.find((p) => p.id === o.payment);
		const online = !!pay && ["monobank", "telegram"].includes(pay.kind) && pay.active;
		return {
			id: Number(o.id),
			reference: o.reference,
			total: Number(o.total),
			currency: o.currency_iso,
			status: o.status_name,
			date: o.date_add,
			items: Number(o.items),
			paid: !!Number(o.is_paid),
			canceled: !!Number(o.is_canceled),
			can_pay: online && !Number(o.is_paid) && !Number(o.is_canceled) && Number(o.total) - Number(o.total_paid || 0) > 0.009,
		};
	});
}

/**
 * Повідомлення покупцям про зміну статусу замовлення (раз на хвилину).
 * last_status — статус, про який уже повідомили; перший статус замовлення не надсилається (є підтвердження).
 */
let busy = false;
async function statusTick() {
	if (busy) return;
	busy = true;
	try {
		const [rows] = await pool.query(
			`SELECT t.id, t.id_shop, o.status, o.reference, o.total, o.currency_iso, c.language_code, c.tg_user_id, c.is_blocked
			   FROM ${T.orders} t
			   JOIN ${P}orders o ON o.id = t.id_order AND o.deleted_at IS NULL
			   JOIN ${T.customers} c ON c.id = t.id_customer
			  WHERE t.last_status IS NOT NULL AND o.status <> t.last_status AND t.date_add > NOW() - INTERVAL 120 DAY
			  ORDER BY t.id LIMIT 200`
		);
		const cache = new Map();
		for (const r of rows) {
			// Позначаємо одразу — навіть якщо надіслати не вдалось, не повторюємо безкінечно
			await pool.query(`UPDATE ${T.orders} SET last_status = ? WHERE id = ?`, [r.status, r.id]);
			if (!cache.has(r.id_shop)) {
				const [[s]] = await pool.query(`SELECT slug FROM ${T.shops} WHERE id = ?`, [r.id_shop]);
				cache.set(r.id_shop, s ? await shops.bySlug(s.slug) : null);
			}
			const shop = cache.get(r.id_shop);
			if (!shop || !shop.token || shop.status === "disabled" || !shop.settings.notify_status || Number(r.is_blocked)) continue;
			// Назва статусу — мовою покупця
			const [[sn]] = await pool.query(`SELECT ${statusNameSql("?")} AS name`, [r.status, langCode(r.language_code)]);
			r.status_name = sn && sn.name;
			if (!r.status_name) continue;
			try {
				await tg.call(shop.token, "sendMessage", { chat_id: r.tg_user_id, text: L("bot.status", { ref: tg.html(r.reference), status: tg.html(r.status_name) }), parse_mode: "HTML" });
			} catch (e) {
				if (e.code === 403) await pool.query(`UPDATE ${T.customers} SET is_blocked = 1 WHERE id_shop = ? AND tg_user_id = ?`, [r.id_shop, r.tg_user_id]);
				else console.error("[telegramshop] status:", e.message);
			}
		}
	} finally {
		busy = false;
	}
}

module.exports = { quote, promoFor, npCities, npWarehouses, methods, lastForm, place, payLink, preCheckout, paid, myOrders, statusTick, minor };