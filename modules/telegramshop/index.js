"use strict";

/**
 * Модуль «Магазин у Telegram».
 *  - Сторінка /modules/telegramshop/ (право orders.settings): магазини, підключення бота за токеном від @BotFather,
 *    тексти бота, мінімальна сума замовлення, контакт для зв'язку.
 *  - Кожен магазин — канал продажу (Налаштування → Інтеграції, платформа Telegram): асортимент, ціни, залишки,
 *    префікс і стартовий статус замовлень — як для сайту.
 *  - Вебхук бота /api/module/telegramshop/webhook/<slug>/ — секрет у заголовку X-Telegram-Bot-Api-Secret-Token.
 *  - Вітрина (Mini App) /modules/telegramshop/app/<slug>/ — відкривається кнопкою «Магазин» у боті; користувач
 *    визначається підписаними даними Telegram (initData), без входу в систему.
 *  - API вітрини /api/module/telegramshop/app/<slug>/… — лише з заголовком X-Telegram-Init-Data, підписаним ботом магазину.
 *  - Оформлення: доставка й оплата магазину, замовлення в систему; оплата — Monobank (модуль monobank) або Telegram Payments.
 *  - Переписка: звичайні повідомлення покупця — у контакт-центр (канал Telegram з тим самим ботом), відповіді менеджера — через бота.
 *  - Повернення покупців: нагадування про кошик, «повідомити, коли з'явиться», повторити замовлення (раз на 10 хв).
 *  - Фоново раз на хвилину: повідомлення покупцям у бот про зміну статусу замовлення.
 */

const path = require("path");
const BaseModule = require("../../core/modules/modules");
const auth = require("../../controllers/authorization/authorization");
const { pool, P, ensureSchema } = require("./controllers/common");
const shops = require("./controllers/shops");
const bot = require("./controllers/bot");
const catalog = require("./controllers/catalog");
const checkout = require("./controllers/checkout");
const support = require("./controllers/support");
const engage = require("./controllers/engage");
const broadcasts = require("./controllers/broadcasts");
const tg = require("./controllers/telegram");

const PERM = "orders.settings";
// Розсилки Telegram — у розділі «Розсилки»: ті самі права, що й для кампаній розсилок
const PERM_BC = "mailing.campaigns";

class TelegramShopModule extends BaseModule {
	constructor(config) {
		super(config);
		this._registerRoutes();
	}

	_registerRoutes() {
		const can = (req, action) => auth.hasPermission(req, PERM, action);
		const need = (action) => (req, res, next) => (can(req, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
		// Тексти помилок модуля й промокодів системи (orders.promo.e.*)
		const errText = (req, e) => (e.status && /^(modules\.|orders\.promo\.)/.test(String(e.message)) ? req.__(e.message, e.vars || {}) : req.__("catalog.common.server_error"));
		const json = (fn) => async (req, res) => {
			try {
				res.json({ ok: true, ...(await fn(req)) });
			} catch (e) {
				if (!e.status) console.error("[telegramshop]", e);
				res.status(e.status || 500).json({ ok: false, error: errText(req, e), ...(e.fields ? { fields: e.fields } : {}), ...(/^orders\.promo\./.test(String(e.message)) ? { promo: true } : {}) });
			}
		};
		const id = (v) => {
			const n = parseInt(v, 10);
			if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error("modules.telegramshop.e.not_found"), { status: 404 });
			return n;
		};
		const authed = [auth.isAuthenticated];
		const E = [...authed, need("edit")];

		// ── Сторінка магазинів ──
		this.registerRoute({
			method: "GET",
			path: "/",
			page: true,
			middlewares: authed,
			handler: async (req, res) => {
				if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
				const [statuses] = await pool.query(
					`SELECT s.id, COALESCE(sl.text, CONCAT('#', s.id)) AS name FROM ${P}orders_status s
					   LEFT JOIN ${P}orders_status_lang sl ON sl.id_status = s.id AND sl.id_lang = ? ORDER BY s.id`,
					[req.user.id_lang || 1]
				);
				res.render(path.join(__dirname, "views", "admin.ejs"), {
					i18n: req,
					user: req.user,
					header: { navbar: "modules", subnavbar: "telegramshop" },
					perms: { edit: can(req, "edit") },
					statuses,
					appUrlOk: /^https:\/\//.test(require("./controllers/common").APP_URL),
					deliveryKinds: shops.DELIVERY_KINDS,
					paymentKinds: shops.PAYMENT_KINDS,
					abandonedHours: shops.ABANDONED_HOURS,
				});
			},
		});

		this.registerRoute({ method: "POST", path: "/shops/list/", middlewares: [...authed, need("view")], handler: json(async () => ({ rows: await shops.list() })) });
		this.registerRoute({ method: "POST", path: "/shops/create/", middlewares: E, handler: json(async (req) => ({ shop: await shops.create(req.body || {}) })) });
		this.registerRoute({ method: "POST", path: "/shops/:id/save/", middlewares: E, handler: json(async (req) => ({ shop: await shops.save(id(req.params.id), req.body || {}) })) });
		this.registerRoute({ method: "POST", path: "/shops/:id/connect/", middlewares: E, handler: json(async (req) => ({ shop: await shops.connect(id(req.params.id), (req.body || {}).token) })) });
		this.registerRoute({ method: "POST", path: "/shops/:id/check/", middlewares: E, handler: json(async (req) => shops.check(id(req.params.id))) });
		// Переписка з покупцями в контакт-центрі
		this.registerRoute({ method: "POST", path: "/shops/:id/support/", middlewares: [...authed, need("view")], handler: json(async (req) => ({ support: await support.state(shops.publicShop(await shops.getRow(id(req.params.id))).settings.cc_channel) })) });
		this.registerRoute({ method: "POST", path: "/shops/:id/support/link/", middlewares: E, handler: json(async (req) => { const shop = await support.link(id(req.params.id), req.user.userId || req.user.id); return { shop, support: await support.state(shop.settings.cc_channel) }; }) });
		this.registerRoute({ method: "POST", path: "/shops/:id/support/unlink/", middlewares: E, handler: json(async (req) => ({ shop: await support.unlink(id(req.params.id)), support: null })) });
		// Товари вітрини без ваги — попередження в налаштуваннях доставки
		this.registerRoute({ method: "POST", path: "/shops/:id/weights/", middlewares: [...authed, need("view")], handler: json(async (req) => ({ weights: await catalog.missingWeight(await shops.getRow(id(req.params.id))) })) });
		this.registerRoute({ method: "POST", path: "/shops/:id/disconnect/", middlewares: E, handler: json(async (req) => ({ shop: await shops.disconnect(id(req.params.id)) })) });

		// ── Розсилки Telegram (розділ «Розсилки») ──
		const canBc = (req, action) => auth.hasPermission(req, PERM_BC, action);
		const needBc = (action) => (req, res, next) => (canBc(req, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
		const BV = [...authed, needBc("view")];
		const BE = [...authed, needBc("edit")];
		this.registerHook("displayMailingMenu", (p) => {
			if (!p || typeof p.can !== "function" || !p.can(PERM_BC)) return "";
			const on = String(p.path || "").startsWith("/modules/telegramshop/broadcasts/");
			return `<li><a class="dropdown-item${on ? " active" : ""}" href="/modules/telegramshop/broadcasts/"><i class="fa-brands fa-telegram me-1"></i>${p.i18n.__("modules.telegramshop.bc.menu")}</a></li>`;
		});
		const bcPage = (view) => async (req, res) => {
			if (!canBc(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
			const [shopList] = await pool.query(`SELECT id, name, status, bot_username FROM ${P}modules_telegram_shop_shops ORDER BY name`);
			res.render(path.join(__dirname, "views", view + ".ejs"), {
				i18n: req,
				user: req.user,
				header: { navbar: "mailing", subnavbar: "mailing_telegram" },
				perms: { edit: canBc(req, "edit") },
				id: parseInt(req.params.id, 10) || 0,
				shops: shopList,
				segments: broadcasts.SEGMENTS,
				targets: broadcasts.TARGETS,
			});
		};
		this.registerRoute({ method: "GET", path: "/broadcasts/", page: true, middlewares: authed, handler: bcPage("broadcasts") });
		this.registerRoute({ method: "GET", path: "/broadcasts/:id/", page: true, middlewares: authed, handler: bcPage("broadcast") });
		const bc = (p, mw, fn) => this.registerRoute({ method: "POST", path: "/broadcasts/" + p, middlewares: mw, handler: json(fn) });
		const uid = (req) => req.user.userId || req.user.id;
		bc("list/", BV, async (req) => ({ rows: await broadcasts.list(req.body || {}) }));
		bc("promos/", BV, async () => ({ rows: await broadcasts.promoTemplates() }));
		bc("count/", BV, async (req) => broadcasts.count((req.body || {}).audience || {}));
		bc("products/", BV, async (req) => {
			const q = String((req.body || {}).q || "").trim().slice(0, 100);
			if (q.length < 2 && !/^\d+$/.test(q)) return { rows: [] };
			const [rows] = await pool.query(
				`SELECT p.id, MAX(d.name) AS name, p.sku FROM ${P}products p JOIN ${P}products_description d ON d.id_product = p.id
				  WHERE p.deleted_at IS NULL AND (p.id = ? OR p.sku LIKE ? OR d.name LIKE ?) GROUP BY p.id, p.sku ORDER BY p.id DESC LIMIT 20`,
				[/^\d+$/.test(q) ? Number(q) : 0, `%${q}%`, `%${q}%`]
			);
			return { rows };
		});
		bc("save/", BE, async (req) => ({ item: await broadcasts.save(parseInt((req.body || {}).id, 10) || null, req.body || {}, uid(req)) }));
		bc(":id/get/", BV, async (req) => ({ item: await broadcasts.get(id(req.params.id)) }));
		bc(":id/check/", BV, async (req) => broadcasts.check(id(req.params.id)));
		bc(":id/launch/", BE, async (req) => ({ item: await broadcasts.launch(id(req.params.id), uid(req)) }));
		bc(":id/unschedule/", BE, async (req) => ({ item: await broadcasts.unschedule(id(req.params.id)) }));
		bc(":id/pause/", BE, async (req) => ({ item: await broadcasts.pause(id(req.params.id)) }));
		bc(":id/resume/", BE, async (req) => ({ item: await broadcasts.resume(id(req.params.id)) }));
		bc(":id/cancel/", BE, async (req) => ({ item: await broadcasts.cancel(id(req.params.id)) }));
		bc(":id/copy/", BE, async (req) => ({ item: await broadcasts.copy(id(req.params.id), uid(req)) }));
		bc(":id/delete/", BE, async (req) => broadcasts.remove(id(req.params.id)));
		bc(":id/test/", BE, async (req) => broadcasts.sendTest(id(req.params.id), req.body || {}));
		bc(":id/recipients/", BV, async (req) => ({ rows: await broadcasts.recipients(id(req.params.id), req.body || {}) }));
		// Посилання з кнопки розсилки: позначити перехід і перенаправити (публічне — відкривається з Telegram)
		this.registerRoute({
			method: "GET",
			path: "/r/:id/:sig/",
			middlewares: [],
			handler: async (req, res) => {
				try {
					const url = await broadcasts.redirect(parseInt(req.params.id, 10) || 0, String(req.params.sig || ""));
					if (!url) return res.status(404).end();
					res.redirect(302, url);
				} catch (e) {
					console.error("[telegramshop] redirect:", e.message);
					res.status(500).end();
				}
			},
		});

		// ── Вебхук бота (публічний; перевірка — секрет у заголовку) ──
		this.registerRoute({
			method: "POST",
			path: "/webhook/:slug/",
			middlewares: [],
			handler: async (req, res) => {
				try {
					const code = await bot.webhook(req.params.slug, req.get("X-Telegram-Bot-Api-Secret-Token"), req.body);
					res.status(code).end();
				} catch (e) {
					console.error("[telegramshop] webhook:", e.message);
					res.status(500).end();
				}
			},
		});

		// ── API вітрини: користувач — з підписаного initData; магазин має бути активним ──
		const seen = new Map(); // tg-користувач → коли оновлювали «востаннє був» (не частіше ніж раз на 5 хв)
		const tgAuth = async (req, res, next) => {
			try {
				const shop = await shops.bySlug(req.params.slug);
				if (!shop || !shop.token) return res.status(404).json({ ok: false, error: req.__("modules.telegramshop.e.not_found") });
				if (shop.status !== "active") return res.status(403).json({ ok: false, code: "closed", error: req.__("modules.telegramshop.bot.closed") });
				const data = tg.verifyInitData(req.get("X-Telegram-Init-Data"), shop.token);
				if (!data) return res.status(401).json({ ok: false, code: "auth", error: req.__("modules.telegramshop.app.e_auth") });
				const key = `${shop.id}:${data.user.id}`;
				if (!seen.has(key) || Date.now() - seen.get(key) > 5 * 60 * 1000) {
					await bot.upsertCustomer(shop.id, data.user);
					seen.set(key, Date.now());
					if (seen.size > 50000) seen.clear();
				}
				req.tgShop = shop;
				req.tgUser = data.user;
				req.tgCtx = await catalog.ctxFor(shop, data.user.language_code);
				next();
			} catch (e) {
				console.error("[telegramshop] app auth:", e);
				res.status(500).json({ ok: false, error: req.__("catalog.common.server_error") });
			}
		};
		const app = (sub, fn) =>
			this.registerRoute({ method: "POST", path: `/app/:slug/${sub}/`, middlewares: [tgAuth], handler: json(async (req) => fn(req.tgShop, req.tgCtx, req.body || {}, req)) });

		app("init", async (shop, ctx, b, req) => {
			// Відкрили з кнопки розсилки — перехід у статистику розсилки
			if (b.b) await broadcasts.click(b.b, req.tgUser.id).catch(() => {});
			return {
			shop: { name: shop.name, support: shop.settings.support || "", min_order: Number(shop.settings.min_order) || 0, currency: ctx.currency, lang: ctx.iso, back_in_stock: !!shop.settings.back_in_stock },
			categories: await catalog.categories(shop, ctx),
			cart: await engage.savedCart(shop, req.tgUser),
			};
		});
		app("products", async (shop, ctx, b) => catalog.products(shop, ctx, b));
		app("product", async (shop, ctx, b, req) => {
			const item = await catalog.product(shop, ctx, b.id);
			if (!item) throw Object.assign(new Error("modules.telegramshop.app.e_gone"), { status: 404 });
			return { item, watched: shop.settings.back_in_stock ? await engage.watched(shop, req.tgUser, item.id) : [] };
		});
		// Кошик на сервері, «повідомити, коли з'явиться», повторити замовлення
		app("cart/save", async (shop, ctx, b, req) => engage.saveCart(shop, ctx, req.tgUser, b.lines));
		app("watch", async (shop, ctx, b, req) => engage.watch(shop, req.tgUser, b));
		app("reorder", async (shop, ctx, b, req) => engage.reorder(shop, ctx, req.tgUser, b.id));
		app("cart", async (shop, ctx, b) => ({ cart: await catalog.cart(shop, ctx, b.lines) }));
		// Оформлення: способи доставки й оплати + що покупець вводив минулого разу
		app("checkout/form", async (shop, ctx, b, req) => ({ methods: await checkout.methods(shop), form: await checkout.lastForm(shop, req.tgUser) }));
		// Нова пошта: пошук міста й відділення з довідника модуля novaposhta
		app("np/cities", async (shop, ctx, b) => ({ rows: await checkout.npCities(b.q) }));
		app("np/warehouses", async (shop, ctx, b) => ({ rows: await checkout.npWarehouses(b.city_ref, b.q, b.kind) }));
		// Ціна доставки й комісії для кошика (розрахунок Нової пошти, накладений платіж)
		app("quote", async (shop, ctx, b) => ({ quote: await checkout.quote(shop, ctx, b) }));
		// Промокод: перевірка для кошика (знижка без змін у базі; фіксується при оформленні)
		app("promo", async (shop, ctx, b, req) => ({ promo: await checkout.promoFor(shop, ctx, req.tgUser, b.code, b.lines, b.delivery) }));
		app("checkout", async (shop, ctx, b, req) => checkout.place(shop, ctx, req.tgUser, b));
		app("orders", async (shop, ctx, b, req) => ({ orders: await checkout.myOrders(shop, req.tgUser) }));
		app("pay", async (shop, ctx, b, req) => ({ pay: await checkout.payLink(shop, req.tgUser, b.id) }));

		// ── Вітрина Mini App (публічна сторінка; дані — лише з підписаним initData) ──
		this.registerRoute({
			method: "GET",
			path: "/app/:slug/",
			page: true,
			middlewares: [],
			handler: async (req, res) => {
				const shop = await shops.bySlug(req.params.slug);
				if (!shop || shop.status === "disabled") return res.status(404).type("text/plain").send("Not found");
				// Telegram Web і Desktop відкривають Mini App у фреймі — дозволяємо вбудовування лише доменам Telegram
				res.removeHeader("X-Frame-Options");
				res.setHeader(
					"Content-Security-Policy",
					"default-src 'self'; script-src 'self' https://telegram.org 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org"
				);
				res.setHeader("Cache-Control", "no-store");
				res.render(path.join(__dirname, "views", "app.ejs"), { i18n: req, shop: { name: shop.name, slug: shop.slug, status: shop.status, support: shop.settings.support || "", bot: shop.bot_username || "" } });
			},
		});
	}

	async enable() {
		await ensureSchema();
		const tick = () => checkout.statusTick().catch((e) => console.error("[telegramshop] status tick:", e.message));
		const eTick = () => engage.tick().catch((e) => console.error("[telegramshop] engage tick:", e.message));
		this.timers = [setInterval(tick, 60 * 1000), setTimeout(tick, 30 * 1000), setInterval(eTick, 10 * 60 * 1000), setTimeout(eTick, 2 * 60 * 1000)];
		this.timers.forEach((t) => t.unref());
		support.register();
		broadcasts.start();
		return super.enable();
	}

	async disable() {
		(this.timers || []).forEach((t) => clearTimeout(t));
		this.timers = [];
		support.unregister();
		broadcasts.stop();
		return super.disable();
	}
}

module.exports = TelegramShopModule;