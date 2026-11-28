"use strict";

/**
 * Повернення покупців:
 *  - кошик на сервері: вітрина зберігає кошик (між пристроями покупця), нагадування про незавершене замовлення
 *    через N годин (налаштування магазину), один раз на кожен кошик;
 *  - «повідомити, коли з'явиться»: підписка на товар / варіант без наявності, повідомлення в бот, коли його знову можна купити;
 *  - «повторити замовлення»: позиції минулого замовлення — у кошик за сьогоднішніми цінами й наявністю.
 *
 * Кошики дублюються в кошики системи (orders_abandoned_cart, канал продажу магазину): вони видні в списку кошиків
 * і в аналітиці на головній (відновлення, втрачена сума) разом із кошиками сайтів.
 * Телефону в знімку немає — зовнішні сервіси нагадувань системи ці кошики не беруть: нагадує бот.
 */

const { pool, P, T, httpErr, json } = require("./common");
const tg = require("./telegram");
const catalog = require("./catalog");
const i18n = require("../../../config/i18n/i18n");

const L = (k, vars) => i18n.__({ phrase: "modules.telegramshop." + k, locale: process.env.APP_LOCALE || "uk" }, vars || {});
const MAX_LINES = 50;
const MAX_WATCH = 50;

const cleanLines = (lines) =>
	(Array.isArray(lines) ? lines : [])
		.slice(0, MAX_LINES)
		.map((l) => ({ id: parseInt(l && l.id, 10) || 0, variant: parseInt(l && l.variant, 10) || 0, qty: Math.max(0, Math.min(9999, parseInt(l && l.qty, 10) || 0)) }))
		.filter((l) => l.id > 0 && l.qty > 0);

async function customerId(shop, user) {
	const [[c]] = await pool.query(`SELECT id FROM ${T.customers} WHERE id_shop = ? AND tg_user_id = ?`, [shop.id, user.id]);
	if (!c) throw httpErr(401, "modules.telegramshop.app.e_auth");
	return c.id;
}

const ACT = `${P}orders_abandoned_cart`;
const session = (idShop, idCustomer) => `tg:${idShop}:${idCustomer}`;

/** Кошик покупця → кошики системи (знімок з цінами каналу на зараз) */
async function mirror(shop, ctx, idCustomer, list) {
	const [[c]] = await pool.query(`SELECT id_client, username, first_name, last_name FROM ${T.customers} WHERE id = ?`, [idCustomer]);
	const cart = await catalog.cart(shop, ctx, list);
	const ok = cart.lines.filter((l) => l.qty > 0);
	if (!ok.length) return expire(shop, idCustomer);
	const snap = {
		customer: { customer_id: null, firstname: (c && c.first_name) || "", lastname: (c && c.last_name) || "", email: "", telephone: "", telegram: c && c.username ? "@" + c.username : "", consent: null },
		cart: ok.map((l) => ({ product_id: l.id, sku: l.sku || null, name: l.name + (l.variant_label ? ` (${l.variant_label})` : ""), quantity: l.qty, price: l.price, total: l.sum, options: l.variant ? { id_variant: l.variant } : {}, image_url: l.image || null, product_url: null, recurring: false })),
		source: "telegram",
	};
	await pool.query(
		`INSERT INTO ${ACT} (store_id, id_integration, id_client, session_id, currency, total_amount, items_count, status, cart, first_seen_at, last_activity_at, date_add, date_edit)
		 VALUES (0, ?, ?, ?, ?, ?, ?, 'active', ?, NOW(), NOW(), NOW(), NOW())
		 ON DUPLICATE KEY UPDATE id_client = VALUES(id_client), currency = VALUES(currency), total_amount = VALUES(total_amount), items_count = VALUES(items_count), cart = VALUES(cart),
		   first_seen_at = IF(status IN ('recovered', 'expired'), NOW(), first_seen_at), id_order = IF(status IN ('recovered', 'expired'), NULL, id_order),
		   recovered_at = IF(status IN ('recovered', 'expired'), NULL, recovered_at), status = 'active', last_activity_at = NOW(), date_edit = NOW()`,
		[shop.id_integration, (c && c.id_client) || null, session(shop.id, idCustomer), String(ctx.currency || "").slice(0, 3), cart.total, cart.count, JSON.stringify(snap)]
	);
}
async function expire(shop, idCustomer) {
	await pool.query(`UPDATE ${ACT} SET status = 'expired', date_edit = NOW() WHERE store_id = 0 AND session_id = ? AND status IN ('active', 'abandoned', 'notified')`, [session(shop.id, idCustomer)]);
}

/** Кошик з вітрини: змінився — новий цикл нагадування */
async function saveCart(shop, ctx, user, lines) {
	const list = cleanLines(lines);
	const [[c]] = await pool.query(`SELECT id, cart FROM ${T.customers} WHERE id_shop = ? AND tg_user_id = ?`, [shop.id, user.id]);
	if (!c) throw httpErr(401, "modules.telegramshop.app.e_auth");
	const same = JSON.stringify(cleanLines(json(c.cart, []))) === JSON.stringify(list);
	if (same) return { saved: list.length };
	if (!list.length) await clearCart(shop, c.id, null);
	else await pool.query(`UPDATE ${T.customers} SET cart = ?, cart_at = NOW(), cart_reminded_at = NULL WHERE id = ?`, [JSON.stringify(list), c.id]);
	if (list.length) await mirror(shop, ctx, c.id, list).catch((e) => console.error("[telegramshop] cart mirror:", e.message));
	return { saved: list.length };
}

/** Збережений кошик (для іншого пристрою покупця) */
async function savedCart(shop, user) {
	const [[c]] = await pool.query(`SELECT cart FROM ${T.customers} WHERE id_shop = ? AND tg_user_id = ?`, [shop.id, user.id]);
	return cleanLines(json(c && c.cart, []));
}

/** Кошик спорожнено: оформили замовлення (idOrder) — кошик системи «відновлений», інакше — «закритий» */
async function clearCart(shop, idCustomer, idOrder) {
	await pool.query(`UPDATE ${T.customers} SET cart = NULL, cart_at = NULL, cart_reminded_at = NULL WHERE id = ?`, [idCustomer]);
	if (!idOrder) return expire(shop, idCustomer).catch(() => {});
	await pool.query(
		`UPDATE ${ACT} SET status = 'recovered', id_order = ?, recovered_at = NOW(), date_edit = NOW() WHERE store_id = 0 AND session_id = ? AND status IN ('active', 'abandoned', 'notified')`,
		[idOrder, session(shop.id, idCustomer)]
	).catch(() => {});
}

/** Підписки покупця на товар: id варіантів (0 — товар без варіантів) */
async function watched(shop, user, idProduct) {
	const [rows] = await pool.query(
		`SELECT w.id_variant FROM ${T.watch} w JOIN ${T.customers} c ON c.id = w.id_customer WHERE c.id_shop = ? AND c.tg_user_id = ? AND w.id_product = ?`,
		[shop.id, user.id, parseInt(idProduct, 10) || 0]
	);
	return rows.map((r) => Number(r.id_variant));
}

/** Підписатися / відписатися від «з'явиться в наявності» */
async function watch(shop, user, b) {
	if (!shop.settings.back_in_stock) throw httpErr(409, "modules.telegramshop.app.e_watch_off");
	const id = await customerId(shop, user);
	const pid = parseInt(b.id, 10) || 0;
	const vid = parseInt(b.variant, 10) || 0;
	if (!(pid > 0)) throw httpErr(400, "modules.telegramshop.app.e_gone");
	if (b.on === false) {
		await pool.query(`DELETE FROM ${T.watch} WHERE id_customer = ? AND id_product = ? AND id_variant = ?`, [id, pid, vid]);
		return { on: false };
	}
	const [[n]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.watch} WHERE id_customer = ?`, [id]);
	if (Number(n.n) >= MAX_WATCH) throw httpErr(409, "modules.telegramshop.app.e_watch_limit", { n: MAX_WATCH });
	await pool.query(`INSERT IGNORE INTO ${T.watch} (id_shop, id_customer, id_product, id_variant, date_add) VALUES (?, ?, ?, ?, NOW())`, [shop.id, id, pid, vid]);
	return { on: true };
}

/** Позиції замовлення покупця — у кошик (перевірка цін і наявності — як для звичайного кошика) */
async function reorder(shop, ctx, user, idOrder) {
	const id = await customerId(shop, user);
	const [[own]] = await pool.query(`SELECT id_order FROM ${T.orders} WHERE id_shop = ? AND id_customer = ? AND id_order = ?`, [shop.id, id, parseInt(idOrder, 10) || 0]);
	if (!own) throw httpErr(404, "modules.telegramshop.app.e_order");
	const [items] = await pool.query(
		`SELECT id_product, id_variant, SUM(quantity) AS qty FROM ${P}orders_items WHERE id_order = ? AND id_product IS NOT NULL AND COALESCE(type, 'product') = 'product' GROUP BY id_product, id_variant ORDER BY MIN(id)`,
		[own.id_order]
	);
	const cart = await catalog.cart(
		shop,
		ctx,
		items.map((i) => ({ id: Number(i.id_product), variant: Number(i.id_variant) || 0, qty: Math.round(Number(i.qty)) || 1 }))
	);
	return {
		lines: cart.lines.filter((l) => l.qty > 0).map((l) => ({ id: l.id, variant: l.variant, qty: l.qty, name: l.name, image: l.image || null })),
		skipped: cart.lines.filter((l) => !(l.qty > 0)).length,
	};
}

/** Кнопка «Відкрити» з переходом усередину вітрини (#cart, #product/ID) */
const openButton = (shop, text, hash) => ({ inline_keyboard: [[{ text, web_app: { url: require("./common").appUrl(shop.slug) + (hash ? "#" + hash : "") } }]] });

/** Нагадування про незавершені кошики */
async function remindCarts(shop) {
	const hours = Number(shop.settings.abandoned_hours) || 0;
	if (!hours || shop.status !== "active") return 0;
	const [rows] = await pool.query(
		`SELECT c.id, c.tg_user_id, c.language_code, c.cart FROM ${T.customers} c
		  WHERE c.id_shop = ? AND c.is_blocked = 0 AND c.cart IS NOT NULL AND c.cart_reminded_at IS NULL
		    AND c.cart_at < NOW() - INTERVAL ? HOUR AND c.cart_at > NOW() - INTERVAL 7 DAY
		    AND NOT EXISTS (SELECT 1 FROM ${T.orders} o WHERE o.id_customer = c.id AND o.date_add >= c.cart_at)
		  ORDER BY c.cart_at LIMIT 100`,
		[shop.id, hours]
	);
	let sent = 0;
	for (const c of rows) {
		// Позначаємо до відправки: збій мережі не має призвести до повторних нагадувань
		await pool.query(`UPDATE ${T.customers} SET cart_reminded_at = NOW() WHERE id = ?`, [c.id]);
		const ctx = await catalog.ctxFor(shop, c.language_code);
		const cart = await catalog.cart(shop, ctx, cleanLines(json(c.cart, [])));
		const ok = cart.lines.filter((l) => l.qty > 0);
		if (!ok.length) continue;
		const names = ok.slice(0, 3).map((l) => "• " + tg.html(l.name + (l.variant_label ? ` (${l.variant_label})` : ""))).join("\n") + (ok.length > 3 ? "\n…" : "");
		const sum = `${cart.total.toFixed(2)} ${tg.html(cart.currency)}`;
		try {
			await tg.call(shop.token, "sendMessage", {
				chat_id: c.tg_user_id,
				text: L("bot.cart_reminder", { n: cart.count, sum }) + "\n\n" + names,
				parse_mode: "HTML",
				reply_markup: openButton(shop, L("bot.cart_open"), "cart"),
			});
			sent++;
			await pool.query(`UPDATE ${ACT} SET status = 'notified', date_edit = NOW() WHERE store_id = 0 AND session_id = ? AND status IN ('active', 'abandoned')`, [session(shop.id, c.id)]).catch(() => {});
		} catch (e) {
			if (e.code === 403) await pool.query(`UPDATE ${T.customers} SET is_blocked = 1 WHERE id = ?`, [c.id]);
			else console.error("[telegramshop] cart reminder:", e.message);
		}
	}
	return sent;
}

/** «З'явився в наявності»: перевірка підписок магазину, повідомлення й видалення підписки */
async function notifyBack(shop) {
	if (!shop.settings.back_in_stock || shop.status !== "active") return 0;
	const [rows] = await pool.query(
		`SELECT w.id, w.id_product, w.id_variant, w.date_add, c.id AS id_customer, c.tg_user_id, c.language_code, c.is_blocked
		   FROM ${T.watch} w JOIN ${T.customers} c ON c.id = w.id_customer
		  WHERE w.id_shop = ? ORDER BY w.id LIMIT 1000`,
		[shop.id]
	);
	if (!rows.length) return 0;
	// Наявність перевіряємо один раз на товар / варіант
	const ctx = await catalog.ctxFor(shop, null);
	const keys = [...new Map(rows.map((r) => [`${r.id_product}:${r.id_variant}`, { id: Number(r.id_product), variant: Number(r.id_variant), qty: 1 }])).values()];
	const state = new Map();
	for (let i = 0; i < keys.length; i += 50) {
		const cart = await catalog.cart(shop, ctx, keys.slice(i, i + 50));
		for (const l of cart.lines) state.set(`${l.id}:${l.variant}`, l);
	}
	let sent = 0;
	for (const r of rows) {
		const l = state.get(`${r.id_product}:${r.id_variant}`);
		const old = Date.now() - new Date(r.date_add).getTime() > 90 * 24 * 3600 * 1000;
		if (!l || l.problem === "gone" || l.problem === "variant") {
			// Товар прибрали з вітрини — підписку тримаємо 90 днів (може повернутися), далі видаляємо
			if (old) await pool.query(`DELETE FROM ${T.watch} WHERE id = ?`, [r.id]);
			continue;
		}
		if (!(l.qty > 0)) {
			if (old) await pool.query(`DELETE FROM ${T.watch} WHERE id = ?`, [r.id]);
			continue;
		}
		await pool.query(`DELETE FROM ${T.watch} WHERE id = ?`, [r.id]);
		if (Number(r.is_blocked)) continue;
		try {
			await tg.call(shop.token, "sendMessage", {
				chat_id: r.tg_user_id,
				text: L("bot.back_in_stock", { name: tg.html(l.name + (l.variant_label ? ` (${l.variant_label})` : "")), price: `${Number(l.price).toFixed(2)} ${tg.html(ctx.currency)}` }),
				parse_mode: "HTML",
				reply_markup: openButton(shop, L("bot.product_open"), "product/" + r.id_product),
			});
			sent++;
		} catch (e) {
			if (e.code === 403) await pool.query(`UPDATE ${T.customers} SET is_blocked = 1 WHERE id = ?`, [r.id_customer]);
			else console.error("[telegramshop] back in stock:", e.message);
		}
	}
	return sent;
}

/** Фонова перевірка: усі активні магазини (раз на 10 хвилин) */
let busy = false;
async function tick() {
	if (busy) return;
	busy = true;
	try {
		const [list] = await pool.query(`SELECT slug FROM ${T.shops} WHERE status = 'active' AND bot_id IS NOT NULL`);
		for (const s of list) {
			const shop = await require("./shops").bySlug(s.slug);
			if (!shop || !shop.token) continue;
			await remindCarts(shop).catch((e) => console.error("[telegramshop] carts:", e.message));
			await notifyBack(shop).catch((e) => console.error("[telegramshop] watch:", e.message));
		}
	} finally {
		busy = false;
	}
}

module.exports = { saveCart, savedCart, clearCart, watched, watch, reorder, remindCarts, notifyBack, tick };