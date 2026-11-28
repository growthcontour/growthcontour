"use strict";

/**
 * Магазини в Telegram: налаштування й підключення бота.
 *
 * Кожен магазин — окремий бот і окремий канал продажу (settings_integrations, платформа telegram):
 * асортимент, правило ціни й залишків, префікс і стартовий статус замовлень налаштовуються там, як для сайту.
 * Токен бота зберігається зашифрованим (helpers/crypto, APP_ENCRYPTION_KEY), назовні — лише останні 4 символи.
 *
 * Підключення бота (connect): getMe → вебхук із секретом (X-Telegram-Bot-Api-Secret-Token) → кнопка меню «Магазин»
 * (Mini App) → команди → опис бота. Повторне підключення того самого бота нічого не ламає.
 */

const crypto = require("crypto");
const cipher = require("../../../helpers/crypto");
const tg = require("./telegram");
const { pool, P, T, APP_URL, httpErr, str, json, appUrl, webhookUrl } = require("./common");

const DEFAULTS = {
	welcome: "",
	button: "",
	about_short: "",
	about: "",
	support: "",
	min_order: 0,
	notify_manager: true,
	notify_status: true,
	status_paid: null,
	checkout_note: "",
	abandoned_hours: 3,
	back_in_stock: true,
};
const ABANDONED_HOURS = [0, 1, 3, 6, 12, 24];

// np_* — Нова пошта (модуль novaposhta): місто й відділення / поштомат — з довідника НП, адреса — кур'єр НП
const DELIVERY_KINDS = ["pickup", "point", "address", "np_warehouse", "np_postomat", "np_address"];
const PAYMENT_KINDS = ["cod", "requisites", "monobank", "telegram"];
const money = (v) => Math.max(0, Math.round((Number(String(v ?? "").replace(",", ".")) || 0) * 100) / 100);
const methodId = (v) => (/^[a-z0-9]{6,16}$/.test(String(v || "")) ? String(v) : crypto.randomBytes(4).toString("hex"));

// Ціна доставки: fixed — одна ціна; weight — за вагою кошика (до N кг — ціна); carrier — за тарифами перевізника
// (покупець платить перевізнику при отриманні, у суму замовлення не входить); api — розрахунок Нової пошти за містом,
// вагою й оцінкою (api_include: входить у суму замовлення — платить магазин; інакше покупцю показується орієнтовна ціна,
// платить отримувач). Безкоштовно від суми — для будь-якого режиму.
const PRICE_MODES = ["fixed", "weight", "carrier", "api"];
const isNpKind = (k) => String(k || "").startsWith("np_");
const kgNum = (v) => Math.max(0, Math.round((Number(String(v ?? "").replace(",", ".")) || 0) * 1000) / 1000);

/** Ставки за вагою: [{ to: кг, price }], до 20, за зростанням ваги, без дублів межі */
function cleanRates(list) {
	const seen = new Set();
	return (Array.isArray(list) ? list : [])
		.slice(0, 20)
		.map((r) => ({ to: kgNum(r && r.to), price: money(r && r.price) }))
		.filter((r) => r.to > 0 && !seen.has(r.to) && seen.add(r.to))
		.sort((a, b) => a.to - b.to);
}

/** Способи доставки: назва, тип (самовивіз / пункт видачі / адреса / Нова пошта), режим ціни, безкоштовно від суми, примітка для покупця */
function cleanDelivery(list) {
	return (Array.isArray(list) ? list : [])
		.slice(0, 20)
		.map((d) => {
			const kind = DELIVERY_KINDS.includes(d && d.kind) ? d.kind : "address";
			// Без збереженого режиму (налаштування до цієї версії): Нова пошта — за тарифами перевізника, решта — одна ціна
			let mode = PRICE_MODES.includes(d && d.price_mode) ? d.price_mode : isNpKind(kind) ? "carrier" : "fixed";
			// Розрахунок через API — лише для Нової пошти
			if (mode === "api" && !isNpKind(kind)) mode = "fixed";
			return {
				id: methodId(d && d.id),
				name: str(d && d.name, 64),
				kind,
				price_mode: mode,
				price: money(d && d.price),
				rates: cleanRates(d && d.rates),
				free_from: money(d && d.free_from),
				api_include: !!(d && d.api_include),
				note: str(d && d.note, 500),
				active: d && d.active !== undefined ? !!d.active : true,
			};
		})
		.filter((d) => d.name);
}

/**
 * Вартість доставки для кошика: { price, free, carrier }.
 *  free — безкоштовно (сума від «Безкоштовно від» або ціна 0); carrier — за тарифами перевізника (у суму не входить).
 *  За вагою: перша ставка, межа якої не менша за вагу; важчий кошик — остання ставка; без ставок — як за тарифами перевізника.
 *  api — ціну рахує Нова пошта (checkout.shipping); тут лише ознака api: true.
 */
function shippingQuote(d, total, kg) {
	if (!d) return { price: 0, free: false, carrier: false };
	if (Number(d.free_from) > 0 && Number(total) >= Number(d.free_from)) return { price: 0, free: true, carrier: false };
	if (d.price_mode === "carrier") return { price: 0, free: false, carrier: true };
	if (d.price_mode === "api") return { price: 0, free: false, carrier: !d.api_include, api: true };
	if (d.price_mode === "weight") {
		const rates = Array.isArray(d.rates) ? d.rates : [];
		if (!rates.length) return { price: 0, free: false, carrier: true };
		const w = Number(kg) || 0;
		const r = rates.find((x) => w <= Number(x.to)) || rates[rates.length - 1];
		const price = money(r.price);
		return { price, free: price === 0, carrier: false };
	}
	const price = money(d.price);
	return { price, free: price === 0, carrier: false };
}

/**
 * Способи оплати. Токен платіжного провайдера Telegram (від @BotFather → Payments) зберігається зашифрованим:
 * token_enc — base64 {c, i, t}; назовні — лише token_last4.
 */
function cleanPayments(list, prevList) {
	const prev = new Map((Array.isArray(prevList) ? prevList : []).map((p) => [p && p.id, p]));
	return (Array.isArray(list) ? list : [])
		.slice(0, 20)
		.map((p) => {
			const id = methodId(p && p.id);
			const kind = PAYMENT_KINDS.includes(p && p.kind) ? p.kind : "cod";
			const old = prev.get(id) || {};
			const out = { id, kind, name: str(p && p.name, 64), text: str(p && p.text, 1000), active: p && p.active !== undefined ? !!p.active : true };
			// Накладений платіж: комісія магазину (додається до замовлення окремим рядком): сума + % від товарів
			if (kind === "cod") {
				out.fee_fixed = money(p && p.fee_fixed);
				out.fee_percent = Math.min(20, money(p && p.fee_percent));
			}
			if (kind === "telegram") {
				const fresh = str(p && p.token, 512);
				if (fresh) {
					const e = cipher.encrypt(fresh);
					out.token_enc = { c: e.cipher.toString("base64"), i: e.iv.toString("base64"), t: e.tag.toString("base64") };
					out.token_last4 = cipher.last4(fresh);
				} else if (p && p.token_enc && p.token_enc.c) {
					out.token_enc = p.token_enc;
					out.token_last4 = p.token_last4 || null;
				} else if (old.token_enc && !(p && p.token_clear)) {
					out.token_enc = old.token_enc;
					out.token_last4 = old.token_last4 || null;
				}
			}
			return out;
		})
		.filter((p) => p.name);
}

/** Розшифрований токен провайдера оплати Telegram */
function providerToken(pay) {
	const e = pay && pay.token_enc;
	if (!e || !e.c) return null;
	return cipher.decrypt(Buffer.from(e.c, "base64"), Buffer.from(e.i, "base64"), Buffer.from(e.t, "base64"));
}

function cleanSettings(raw, prev) {
	const s = { ...DEFAULTS, ...(prev || {}), ...(raw && typeof raw === "object" ? raw : {}) };
	return {
		welcome: str(s.welcome, 2000),
		button: str(s.button, 32),
		about_short: str(s.about_short, 120),
		about: str(s.about, 512),
		support: str(s.support, 255),
		min_order: Math.max(0, Math.round((Number(String(s.min_order).replace(",", ".")) || 0) * 100) / 100),
		notify_manager: !!s.notify_manager,
		notify_status: !!s.notify_status,
		status_paid: Number(s.status_paid) > 0 ? Number(s.status_paid) : null,
		checkout_note: str(s.checkout_note, 1000),
		// Нагадування про кошик через N годин (0 — вимкнено); «повідомити, коли з'явиться»
		abandoned_hours: ABANDONED_HOURS.includes(Number(s.abandoned_hours)) ? Number(s.abandoned_hours) : DEFAULTS.abandoned_hours,
		back_in_stock: !!s.back_in_stock,
		// Канал контакт-центру для переписки — ставиться лише підключенням (support.link), не формою
		cc_channel: Number(s.cc_channel) > 0 ? Number(s.cc_channel) : null,
		delivery: cleanDelivery(s.delivery),
		payments: cleanPayments(s.payments, prev && prev.payments),
	};
}

/** Налаштування без секретів — для сторінки адміністрування */
function safeSettings(s) {
	return { ...s, payments: s.payments.map(({ token_enc, ...p }) => ({ ...p, has_token: !!(token_enc && token_enc.c) })) };
}

/** Публічний вигляд магазину (без токена й секрету) */
function publicShop(r) {
	return {
		id: r.id,
		name: r.name,
		slug: r.slug,
		status: r.status,
		id_integration: r.id_integration,
		integration_name: r.integration_name || null,
		bot_username: r.bot_username,
		token_last4: r.token_last4,
		connected: !!r.bot_id,
		webhook_ok: !!Number(r.webhook_ok),
		webhook_error: r.webhook_error,
		settings: safeSettings(cleanSettings(json(r.settings, {}))),
		app_url: appUrl(r.slug),
		bot_url: r.bot_username ? `https://t.me/${r.bot_username}` : null,
		orders: Number(r.orders || 0),
		customers: Number(r.customers || 0),
	};
}

async function list() {
	const [rows] = await pool.query(
		`SELECT s.*, i.name AS integration_name,
		        (SELECT COUNT(*) FROM ${T.orders} o WHERE o.id_shop = s.id) AS orders,
		        (SELECT COUNT(*) FROM ${T.customers} c WHERE c.id_shop = s.id) AS customers
		   FROM ${T.shops} s LEFT JOIN ${P}settings_integrations i ON i.id = s.id_integration ORDER BY s.id`
	);
	return rows.map(publicShop);
}

async function getRow(id) {
	const [[r]] = await pool.query(`SELECT s.*, i.name AS integration_name FROM ${T.shops} s LEFT JOIN ${P}settings_integrations i ON i.id = s.id_integration WHERE s.id = ?`, [id]);
	if (!r) throw httpErr(404, "modules.telegramshop.e.not_found");
	return r;
}

/** Магазин за публічним slug (вітрина, вебхук) — з розшифрованим токеном */
async function bySlug(slug) {
	if (!/^[a-z0-9]{8,32}$/.test(String(slug || ""))) return null;
	const [[r]] = await pool.query(`SELECT * FROM ${T.shops} WHERE slug = ?`, [slug]);
	if (!r) return null;
	r.token = cipher.decrypt(r.token_cipher, r.token_iv, r.token_tag);
	r.settings = cleanSettings(json(r.settings, {}));
	return r;
}

async function tokenOf(id) {
	const r = await getRow(id);
	const token = cipher.decrypt(r.token_cipher, r.token_iv, r.token_tag);
	if (!token) throw httpErr(409, "modules.telegramshop.e.no_token");
	return { row: r, token };
}

/** Новий магазин: запис магазину й канал продажу (інтеграція «Telegram») зі стартовим статусом */
async function create(b) {
	const name = str(b.name, 128);
	if (!name) throw httpErr(400, "modules.telegramshop.e.name");
	const idStatus = parseInt(b.default_status_id, 10) || null;
	if (!idStatus) throw httpErr(400, "modules.telegramshop.e.status");
	const conn = await pool.getConnection();
	let id;
	try {
		await conn.beginTransaction();
		const [ir] = await conn.query(
			`INSERT INTO ${P}settings_integrations (name, order_prefix, platform, default_status_id, base_url, status, assortment_mode, date_add, date_edit)
			 VALUES (?, ?, 'telegram', ?, NULL, 'active', 'all', NOW(), NOW())`,
			[("Telegram · " + name).slice(0, 255), str(b.order_prefix, 16) || "TG", idStatus]
		);
		const [sr] = await conn.query(`INSERT INTO ${T.shops} (name, slug, id_integration, status, settings, date_add, date_edit) VALUES (?, ?, ?, 'draft', ?, NOW(), NOW())`, [
			name,
			crypto.randomBytes(8).toString("hex"),
			ir.insertId,
			JSON.stringify(cleanSettings(b.settings)),
		]);
		id = sr.insertId;
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	return publicShop(await getRow(id));
}

async function save(id, b) {
	const r = await getRow(id);
	const name = str(b.name, 128) || r.name;
	const prev = json(r.settings, {});
	const settings = cleanSettings({ ...(b.settings || {}), cc_channel: prev.cc_channel }, prev);
	const status = ["draft", "active", "disabled"].includes(b.status) ? b.status : r.status;
	if (status === "active" && !r.bot_id) throw httpErr(409, "modules.telegramshop.e.connect_first");
	// Оплата в Telegram: валюта каналу продажу має бути серед валют Telegram Payments
	if (settings.payments.some((p) => p.active && p.kind === "telegram")) {
		const { TG_CURRENCIES } = require("./common");
		const cur = String((await require("./catalog").ctxFor({ id_integration: r.id_integration }, null)).currency || "").toUpperCase();
		if (!TG_CURRENCIES.has(cur)) throw httpErr(409, "modules.telegramshop.e.tg_currency", { currency: cur });
	}
	await pool.query(`UPDATE ${T.shops} SET name = ?, status = ?, settings = ?, date_edit = NOW() WHERE id = ?`, [name, status, JSON.stringify(settings), id]);
	// Тексти бота (опис, кнопка) — одразу в Telegram, якщо бот підключено
	if (r.bot_id) await applyBotProfile(id).catch(() => {});
	return publicShop(await getRow(id));
}

/** Кнопка меню, команди й опис бота за налаштуваннями магазину */
async function applyBotProfile(id) {
	const { row, token } = await tokenOf(id);
	const s = cleanSettings(json(row.settings, {}));
	const t = require("../../../config/i18n/i18n");
	const L = (k) => t.__({ phrase: "modules.telegramshop.bot." + k, locale: process.env.APP_LOCALE || "uk" });
	await tg.call(token, "setChatMenuButton", { menu_button: { type: "web_app", text: s.button || L("open_shop"), web_app: { url: appUrl(row.slug) } } });
	await tg.call(token, "setMyCommands", {
		commands: [
			{ command: "start", description: L("cmd_start") },
			{ command: "shop", description: L("cmd_shop") },
			{ command: "orders", description: L("cmd_orders") },
		],
	});
	await tg.call(token, "setMyShortDescription", { short_description: s.about_short || row.name }).catch(() => {});
	await tg.call(token, "setMyDescription", { description: s.about || "" }).catch(() => {});
}

/** Підключити бота за токеном від @BotFather */
async function connect(id, token) {
	token = String(token || "").trim();
	if (!/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(token)) throw httpErr(400, "modules.telegramshop.e.token_format");
	if (!/^https:\/\//.test(APP_URL)) throw httpErr(409, "modules.telegramshop.e.https");
	const row = await getRow(id);
	let me;
	try {
		me = await tg.call(token, "getMe");
	} catch (e) {
		throw httpErr(400, "modules.telegramshop.e.token_rejected", { error: e.message });
	}
	// Один бот — один магазин: інакше вебхук одного магазину перебив би інший
	const [[other]] = await pool.query(`SELECT id, name FROM ${T.shops} WHERE bot_id = ? AND id <> ?`, [me.id, id]);
	if (other) throw httpErr(409, "modules.telegramshop.e.bot_used", { shop: other.name });
	const secret = crypto.randomBytes(24).toString("hex");
	const enc = cipher.encrypt(token);
	await pool.query(
		`UPDATE ${T.shops} SET bot_id = ?, bot_username = ?, token_cipher = ?, token_iv = ?, token_tag = ?, token_last4 = ?, webhook_secret = ?, webhook_ok = 0, webhook_error = NULL, date_edit = NOW() WHERE id = ?`,
		[me.id, me.username || null, enc.cipher, enc.iv, enc.tag, cipher.last4(token), secret, id]
	);
	let hookErr = null;
	try {
		await tg.call(token, "setWebhook", { url: webhookUrl(row.slug), secret_token: secret, allowed_updates: ["message", "edited_message", "callback_query", "pre_checkout_query", "my_chat_member"], drop_pending_updates: false });
		await applyBotProfile(id);
	} catch (e) {
		hookErr = String(e.message || e).slice(0, 500);
	}
	await pool.query(`UPDATE ${T.shops} SET webhook_ok = ?, webhook_error = ? WHERE id = ?`, [hookErr ? 0 : 1, hookErr, id]);
	await require("./support").syncToken(id).catch((e) => console.error("[telegramshop] cc token:", e.message));
	return publicShop(await getRow(id));
}

/** Стан вебхука в Telegram (для кнопки «Перевірити») */
async function check(id) {
	const { row, token } = await tokenOf(id);
	let info = await tg.call(token, "getWebhookInfo");
	// Вебхук бота забрав хтось інший (напр. «Перевірити» в каналі контакт-центру) — повертаємо магазину
	if (info.url !== webhookUrl(row.slug)) {
		await tg.call(token, "setWebhook", { url: webhookUrl(row.slug), secret_token: row.webhook_secret, allowed_updates: ["message", "edited_message", "callback_query", "pre_checkout_query", "my_chat_member"], drop_pending_updates: false });
		info = await tg.call(token, "getWebhookInfo");
	}
	const ok = info.url === webhookUrl(row.slug) && !info.last_error_message;
	await pool.query(`UPDATE ${T.shops} SET webhook_ok = ?, webhook_error = ? WHERE id = ?`, [ok ? 1 : 0, info.last_error_message ? String(info.last_error_message).slice(0, 500) : info.url === webhookUrl(row.slug) ? null : "url", id]);
	return { ok, pending: info.pending_update_count || 0, last_error: info.last_error_message || null, last_error_at: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null, shop: publicShop(await getRow(id)) };
}

/** Відключити бота: прибрати вебхук і кнопку меню, токен видалити; магазин — у чернетку */
async function disconnect(id) {
	try {
		const { token } = await tokenOf(id);
		await tg.call(token, "deleteWebhook", {}).catch(() => {});
		await tg.call(token, "setChatMenuButton", { menu_button: { type: "default" } }).catch(() => {});
	} catch {
		/* токена вже немає */
	}
	await pool.query(
		`UPDATE ${T.shops} SET bot_id = NULL, bot_username = NULL, token_cipher = NULL, token_iv = NULL, token_tag = NULL, token_last4 = NULL, webhook_secret = NULL, webhook_ok = 0, webhook_error = NULL, status = 'draft', date_edit = NOW() WHERE id = ?`,
		[id]
	);
	await require("./support").syncToken(id).catch(() => {});
	return publicShop(await getRow(id));
}

module.exports = { list, getRow, bySlug, tokenOf, create, save, connect, check, disconnect, applyBotProfile, publicShop, cleanSettings, providerToken, shippingQuote, DELIVERY_KINDS, PAYMENT_KINDS, PRICE_MODES, ABANDONED_HOURS };