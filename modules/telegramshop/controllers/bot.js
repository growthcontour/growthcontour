"use strict";

/**
 * Вебхук бота магазину: оновлення Telegram → дії.
 *   /start, /shop — привітання й кнопка «Відкрити магазин» (Mini App); клієнт записується в покупці магазину;
 *   /orders      — останні замовлення клієнта з поточним статусом;
 *   інший текст   — відповідь «як з нами зв'язатися» (контакт із налаштувань магазину);
 *   my_chat_member — клієнт зупинив / відновив бота (не надсилати повідомлення заблокованим).
 * Telegram чекає відповіді на вебхук до ~60 с і повторює при помилці — маршрут відповідає одразу, обробка йде після.
 */

const tg = require("./telegram");
const { pool, P, T, statusNameSql, langCode } = require("./common");
const shops = require("./shops");

const LOCALE = process.env.APP_LOCALE || "uk";
const L = (k, v) => require("../../../config/i18n/i18n").__({ phrase: "modules.telegramshop.bot." + k, locale: LOCALE }, v || {});

/** Покупець магазину за користувачем Telegram (створюється або оновлюється) */
async function upsertCustomer(idShop, u, opts = {}) {
	if (!u || !u.id || u.is_bot) return null;
	await pool.query(
		`INSERT INTO ${T.customers} (id_shop, tg_user_id, username, first_name, last_name, language_code, started_at, last_seen_at, date_add)
		 VALUES (?, ?, ?, ?, ?, ?, ${opts.started ? "NOW()" : "NULL"}, NOW(), NOW())
		 ON DUPLICATE KEY UPDATE username = VALUES(username), first_name = VALUES(first_name), last_name = VALUES(last_name),
		   language_code = VALUES(language_code), last_seen_at = NOW(), is_blocked = 0${opts.started ? ", started_at = COALESCE(started_at, NOW())" : ""}`,
		[idShop, u.id, u.username || null, u.first_name || null, u.last_name || null, u.language_code || null]
	);
	const [[c]] = await pool.query(`SELECT * FROM ${T.customers} WHERE id_shop = ? AND tg_user_id = ?`, [idShop, u.id]);
	return c;
}

const openButton = (shop, hash, text) => ({ inline_keyboard: [[{ text: text || shop.settings.button || L("open_shop"), web_app: { url: require("./common").appUrl(shop.slug) + (hash ? "#" + hash : "") } }]] });

/** Посилання «поділитися товаром»: t.me/<бот>?start=p<ID> → картка товару з кнопкою, що відкриває його у вітрині */
async function sendProduct(shop, chatId, customer, idProduct) {
	const catalog = require("./catalog");
	const ctx = await catalog.ctxFor(shop, customer && customer.language_code);
	const p = await catalog.product(shop, ctx, idProduct);
	if (!p) return sendWelcome(shop, chatId);
	const price = p.priced && p.price !== null ? `${p.price_from ? L("from") + " " : ""}${Number(p.price).toFixed(2)} ${tg.html(ctx.currency)}` : "";
	const caption = `<b>${tg.html(p.name)}</b>${price ? "\n" + price : ""}${p.short ? "\n\n" + tg.html(p.short).slice(0, 700) : ""}`;
	const markup = openButton(shop, "product/" + p.id, L("product_open"));
	const photo = p.images && p.images[0] ? require("./common").APP_URL + (p.images[0].thumb || p.images[0].url) : null;
	if (photo && /^https:\/\//.test(photo)) {
		try {
			return await tg.call(shop.token, "sendPhoto", { chat_id: chatId, photo, caption, parse_mode: "HTML", reply_markup: markup });
		} catch {}
	}
	await tg.call(shop.token, "sendMessage", { chat_id: chatId, text: caption, parse_mode: "HTML", reply_markup: markup });
}

async function sendWelcome(shop, chatId) {
	const text = shop.settings.welcome ? tg.html(shop.settings.welcome) : L("welcome", { shop: tg.html(shop.name) });
	await tg.call(shop.token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: openButton(shop) });
}

async function sendOrders(shop, chatId, customer) {
	const [rows] = await pool.query(
		`SELECT o.reference, o.total, o.currency_iso, o.date_add, ${statusNameSql("o.status")} AS status_name
		   FROM ${T.orders} t JOIN ${P}orders o ON o.id = t.id_order
		  WHERE t.id_shop = ? AND t.id_customer = ? ORDER BY t.id DESC LIMIT 5`,
		[langCode(customer.language_code), shop.id, customer.id]
	);
	const text = rows.length
		? L("orders_title") + "\n\n" + rows.map((o) => `<b>${tg.html(o.reference)}</b> · ${Number(o.total).toFixed(2)} ${tg.html(o.currency_iso)}\n${tg.html(o.status_name)} · ${String(o.date_add).slice(0, 10)}`).join("\n\n")
		: L("orders_empty");
	await tg.call(shop.token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: openButton(shop) });
}

async function handle(shop, u) {
	if (u.my_chat_member) {
		const m = u.my_chat_member;
		const blocked = ["kicked", "left"].includes(m.new_chat_member && m.new_chat_member.status);
		await pool.query(`UPDATE ${T.customers} SET is_blocked = ? WHERE id_shop = ? AND tg_user_id = ?`, [blocked ? 1 : 0, shop.id, m.from && m.from.id]);
		return;
	}
	// Оплата в Telegram: підтвердження перед списанням (Telegram чекає відповідь до 10 с) і факт оплати
	if (u.pre_checkout_query) return require("./checkout").preCheckout(shop, u.pre_checkout_query);
	if (u.message && u.message.successful_payment) return require("./checkout").paid(shop, u.message);
	if (u.callback_query) {
		// Кнопки з повідомлень (наступні етапи) — прибираємо «годинник» на кнопці
		await tg.call(shop.token, "answerCallbackQuery", { callback_query_id: u.callback_query.id }).catch(() => {});
		return;
	}
	const msg = u.message || u.edited_message;
	if (!msg || !msg.chat || msg.chat.type !== "private") return;
	const text = String(msg.text || "").trim();
	const cmd = (/^\/([a-z_]+)(@\w+)?/i.exec(text) || [])[1];
	const customer = await upsertCustomer(shop.id, msg.from, { started: cmd === "start" });
	if (!customer) return;
	const own = cmd === "start" || cmd === "shop" || cmd === "orders";
	// Переписка з менеджером: усе, крім команд магазину, — у контакт-центр (і коли магазин ще не працює)
	if (!own && shop.settings.cc_channel && (await require("./support").forward(shop, u))) return;
	if (u.edited_message) return;
	if (shop.status !== "active") {
		await tg.call(shop.token, "sendMessage", { chat_id: msg.chat.id, text: L("closed") });
		return;
	}
	const startArg = cmd === "start" ? (/^\/start(?:@\w+)?\s+(\S+)/i.exec(text) || [])[1] || "" : "";
	if (/^p\d{1,10}$/.test(startArg)) return sendProduct(shop, msg.chat.id, customer, Number(startArg.slice(1)));
	if (cmd === "start" || cmd === "shop") return sendWelcome(shop, msg.chat.id);
	if (cmd === "orders") return sendOrders(shop, msg.chat.id, customer);
	// Довільне повідомлення: як зв'язатися (переписка з менеджером — через контакт-центр, наступний етап)
	const support = shop.settings.support ? "\n\n" + tg.html(shop.settings.support) : "";
	await tg.call(shop.token, "sendMessage", { chat_id: msg.chat.id, text: L("free_text") + support, parse_mode: "HTML", reply_markup: openButton(shop) });
}

/** Обробник маршруту вебхука: перевірка секрету, відповідь 200 одразу, обробка — після */
async function webhook(slug, secretHeader, update) {
	const shop = await shops.bySlug(slug);
	if (!shop || !shop.token || !shop.webhook_secret) return 404;
	const a = Buffer.from(String(secretHeader || ""));
	const b = Buffer.from(String(shop.webhook_secret));
	if (a.length !== b.length || !require("crypto").timingSafeEqual(a, b)) return 401;
	setImmediate(() =>
		handle(shop, update || {}).catch((e) => {
			// Клієнт заблокував бота — позначаємо, інші помилки — в журнал
			if (e && e.code === 403) {
				const from = (update.message && update.message.from) || {};
				pool.query(`UPDATE ${T.customers} SET is_blocked = 1 WHERE id_shop = ? AND tg_user_id = ?`, [shop.id, from.id || 0]).catch(() => {});
			} else console.error("[telegramshop] webhook:", e && e.message);
		})
	);
	return 200;
}

module.exports = { webhook, handle, upsertCustomer, sendWelcome };