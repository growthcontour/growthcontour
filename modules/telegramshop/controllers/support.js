"use strict";

/**
 * Переписка покупців з менеджерами: бот магазину ↔ контакт-центр.
 *
 * Бот магазину стає каналом контакт-центру (тип telegram) з тим самим токеном. Вебхук бота лишається за магазином:
 * команди, оплати й кнопки обробляє магазин, а звичайні повідомлення покупця (текст, фото, файли, голосові)
 * передаються в контакт-центр — там з'являється діалог, менеджер відповідає звичайним способом (відповідь іде через того ж бота).
 *
 * Якщо в каналі контакт-центру натиснуть «Перевірити» і вебхук переїде на контакт-центр — нічого не ламається:
 * перехоплювач вебхука контакт-центру віддає оновлення цього бота магазину (а переписку магазин повертає назад).
 */

const cipher = require("../../../helpers/crypto");
const { pool, P, httpErr, json, webhookUrl } = require("./common");

const CC = `${P}contact_center_channels`;
const CC_TG = `${P}contact_center_channel_telegram`;

const ccRoutes = () => require("../../../routes/contact-center/webhooks/webhooks");

/** Підключити переписку: створити (або взяти наявний для цього бота) канал контакт-центру й прив'язати до магазину */
async function link(idShop, idUser) {
	const shops = require("./shops");
	const { row, token } = await shops.tokenOf(idShop);
	if (!row.bot_id) throw httpErr(409, "modules.telegramshop.e.connect_first");
	const enc = cipher.encrypt(token);
	const settings = shops.cleanSettings(json(row.settings, {}));
	const conn = await pool.getConnection();
	let idChannel;
	try {
		await conn.beginTransaction();
		// Той самий бот уже є каналом контакт-центру — беремо його (історія діалогів зберігається)
		const [[ex]] = await conn.query(
			`SELECT t.id_channel FROM ${CC_TG} t JOIN ${CC} c ON c.id = t.id_channel AND c.deleted = 0
			  WHERE (t.bot_id = ? OR t.id_channel = ?) AND t.date_deleted IS NULL ORDER BY (t.id_channel = ?) DESC LIMIT 1`,
			[row.bot_id, settings.cc_channel || 0, settings.cc_channel || 0]
		);
		if (ex) idChannel = Number(ex.id_channel);
		else {
			const [r] = await conn.query(`INSERT INTO ${CC} (type, name, status, is_configured, connection_status, id_user, date_add) VALUES ('telegram', ?, 1, 1, 'ok', ?, NOW())`, [
				`Telegram · ${row.name}`.slice(0, 255),
				idUser || null,
			]);
			idChannel = r.insertId;
			await conn.query(`INSERT INTO ${CC_TG} (id_channel, token_cipher, token_iv, token_tag, webhook_secret) VALUES (?, ?, ?, ?, ?)`, [idChannel, enc.cipher, enc.iv, enc.tag, cipher.random(32)]);
		}
		// Токен і дані бота — актуальні; вебхук — магазину (канал його не ставить)
		await conn.query(
			`UPDATE ${CC_TG} SET token_cipher = ?, token_iv = ?, token_tag = ?, token_last4 = ?, bot_id = ?, bot_username = ?, webhook_url = ?, webhook_set = 1, date_webhook_set = NOW() WHERE id_channel = ?`,
			[enc.cipher, enc.iv, enc.tag, cipher.last4(token), row.bot_id, row.bot_username || null, webhookUrl(row.slug), idChannel]
		);
		await conn.query(`UPDATE ${CC} SET status = 1, is_configured = 1, connection_status = 'ok', connection_error = NULL, date_checked = NOW() WHERE id = ?`, [idChannel]);
		await conn.query(`UPDATE ${P}modules_telegram_shop_shops SET settings = JSON_SET(COALESCE(settings, JSON_OBJECT()), '$.cc_channel', ?), date_edit = NOW() WHERE id = ?`, [idChannel, idShop]);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	cache.at = 0;
	return shops.publicShop(await shops.getRow(idShop));
}

/** Відключити переписку: канал контакт-центру вимикається (діалоги лишаються), бот знову відповідає сам */
async function unlink(idShop) {
	const shops = require("./shops");
	const row = await shops.getRow(idShop);
	const s = shops.cleanSettings(json(row.settings, {}));
	if (s.cc_channel) await pool.query(`UPDATE ${CC} SET status = 0 WHERE id = ?`, [s.cc_channel]);
	await pool.query(`UPDATE ${P}modules_telegram_shop_shops SET settings = JSON_REMOVE(COALESCE(settings, JSON_OBJECT()), '$.cc_channel'), date_edit = NOW() WHERE id = ?`, [idShop]);
	cache.at = 0;
	return shops.publicShop(await shops.getRow(idShop));
}

/** Новий токен бота магазину — і в каналі контакт-центру; бот відключено — канал вимикається */
async function syncToken(idShop) {
	const shops = require("./shops");
	const row = await shops.getRow(idShop);
	const s = shops.cleanSettings(json(row.settings, {}));
	if (!s.cc_channel) return;
	if (!row.bot_id) {
		await pool.query(`UPDATE ${CC} SET status = 0 WHERE id = ?`, [s.cc_channel]);
		return;
	}
	const { token } = await shops.tokenOf(idShop);
	const enc = cipher.encrypt(token);
	await pool.query(`UPDATE ${CC_TG} SET token_cipher = ?, token_iv = ?, token_tag = ?, token_last4 = ?, bot_id = ?, bot_username = ?, webhook_url = ? WHERE id_channel = ?`, [
		enc.cipher,
		enc.iv,
		enc.tag,
		cipher.last4(token),
		row.bot_id,
		row.bot_username || null,
		webhookUrl(row.slug),
		s.cc_channel,
	]);
	await pool.query(`UPDATE ${CC} SET status = 1 WHERE id = ?`, [s.cc_channel]);
	cache.at = 0;
}

/** Стан каналу для сторінки магазину */
async function state(idChannel) {
	if (!idChannel) return null;
	const [[c]] = await pool.query(`SELECT id, name, status, deleted FROM ${CC} WHERE id = ?`, [idChannel]);
	return c && !Number(c.deleted) ? { id: Number(c.id), name: c.name, active: !!Number(c.status), url: `/contact-center/channels/${Number(c.id)}/` } : null;
}

/** Чи канал активний (вимкнений у контакт-центрі — бот відповідає сам) */
async function channelActive(idChannel) {
	if (!idChannel) return false;
	const [[c]] = await pool.query(`SELECT status, deleted FROM ${CC} WHERE id = ?`, [idChannel]);
	return !!c && !Number(c.deleted) && !!Number(c.status);
}

/** Передати повідомлення покупця в контакт-центр */
async function forward(shop, update) {
	if (!(await channelActive(shop.settings.cc_channel))) return false;
	await ccRoutes().processTelegram(shop.settings.cc_channel, update);
	return true;
}

// Канал контакт-центру → магазин (для перехоплювача); оновлюється раз на хвилину або після змін
const cache = { at: 0, map: new Map() };
async function shopForChannel(idChannel) {
	if (Date.now() - cache.at > 60 * 1000) {
		const [rows] = await pool.query(
			`SELECT slug, CAST(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.cc_channel')) AS UNSIGNED) AS ch FROM ${P}modules_telegram_shop_shops WHERE JSON_EXTRACT(settings, '$.cc_channel') IS NOT NULL`
		);
		cache.map = new Map(rows.filter((r) => Number(r.ch) > 0).map((r) => [Number(r.ch), r.slug]));
		cache.at = Date.now();
	}
	return cache.map.get(Number(idChannel)) || null;
}

/** Реєстрація перехоплювача у вебхуку контакт-центру (при увімкненні модуля) */
function register() {
	ccRoutes().setTelegramInterceptor(async (idChannel, update) => {
		const slug = await shopForChannel(idChannel);
		if (!slug) return false;
		const shop = await require("./shops").bySlug(slug);
		if (!shop || !shop.token) return false;
		await require("./bot").handle(shop, update);
		return true;
	});
}
function unregister() {
	ccRoutes().setTelegramInterceptor(null);
}

/**
 * Нове замовлення з вітрини → діалог покупця в контакт-центрі (якщо переписку підключено):
 * службовий запис «Нове замовлення …» (покупцю нічого не надсилається), контакт — до картки клієнта замовлення,
 * діалог — у замовлення (кнопка «Відкрити чат» у картці). Менеджер одразу може написати покупцю в той самий бот.
 */
async function orderOpened(shop, customer, idOrder) {
	const idChannel = shop.settings.cc_channel;
	if (!idChannel || !(await channelActive(idChannel))) return null;
	const [[o]] = await pool.query(
		`SELECT o.id, o.reference, o.total, o.currency_iso, o.id_client, o.custom_fields,
		        a.phone, a.city, a.warehouse, a.address_1
		   FROM ${P}orders o LEFT JOIN ${P}orders_addresses a ON a.id_order = o.id AND a.type = 'shipping' WHERE o.id = ?`,
		[idOrder]
	);
	if (!o) return null;
	const cf = json(o.custom_fields, {});
	const L = (k, v) => require("../../../config/i18n/i18n").__({ phrase: "modules.telegramshop.cc." + k, locale: process.env.APP_LOCALE || "uk" }, v || {});
	const where = [o.city, o.warehouse || o.address_1].filter(Boolean).join(", ");
	const text = [
		L("order_note", { ref: o.reference, sum: `${Number(o.total).toFixed(2)} ${o.currency_iso}` }),
		[cf._delivery_method, where].filter(Boolean).join(": "),
		cf._payment_method ? L("order_payment", { name: cf._payment_method }) : "",
	]
		.filter(Boolean)
		.join(" · ");
	const res = await ccRoutes().openWithSystem(
		idChannel,
		"telegram",
		{
			external_id: String(customer.tg_user_id),
			first_name: customer.first_name || null,
			last_name: customer.last_name || null,
			username: customer.username || null,
			lang: customer.language_code || null,
			phone: o.phone || null,
		},
		{ subtype: "order", text, source_id: `order:${o.id}` },
		String(customer.tg_user_id)
	);
	if (!res || !res.id_conversation) return null;
	// Контакт — до картки клієнта замовлення (якщо ще не прив'язаний); діалог — у замовлення
	if (o.id_client && res.id_contact) await pool.query(`UPDATE ${P}contact_center_contacts SET id_client = ? WHERE id = ? AND id_client IS NULL`, [o.id_client, res.id_contact]);
	await pool.query(`UPDATE ${P}orders SET custom_fields = JSON_SET(COALESCE(custom_fields, JSON_OBJECT()), '$.cc_conversation', ?) WHERE id = ?`, [res.id_conversation, o.id]);
	return res;
}

module.exports = { link, unlink, syncToken, state, forward, register, unregister, orderOpened };