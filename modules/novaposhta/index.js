"use strict";

/**
 * Модуль «Нова пошта».
 *  - Сторінка /modules/novaposhta/ (право orders.settings): акаунти (кілька ключів API / ФОП), відправники, умови за замовчуванням,
 *    прив'язка акаунтів до магазинів, довідники міст і відділень (синхронізація з НП).
 *  - Панель у картці замовлення (хук displayOrderShipping, право orders.list): відправлення з адреси замовлення,
 *    зміна міста / відділення пошуком по довіднику, отримувач, вага, місця, оголошена вартість, наложений платіж, розрахунок вартості.
 *  - ТТН (створення, друк, реєстри, відстеження) — наступний етап на тих самих відправленнях.
 */
const path = require("path");
const BaseModule = require("../../core/modules/modules");
const auth = require("../../controllers/authorization/authorization");
const ordersAccess = require("../../controllers/orders/access");
const { pool, P } = require("./controllers/common");
const { ensureSchema } = require("./controllers/schema");
const api = require("./controllers/api");
const accounts = require("./controllers/accounts");
const directory = require("./controllers/directory");
const shipments = require("./controllers/shipments");

const PERM_SETTINGS = "orders.settings";
const PERM_ORDERS = "orders.list";

class NovaposhtaModule extends BaseModule {
	constructor(config) {
		super(config);
		this.timer = null;
		this._registerHooks();
		this._registerRoutes();
	}

	_registerHooks() {
		// Картка замовлення: views/pages/orders/page.ejs → hook('displayOrderShipping', { i18n, can, order })
		this.registerHook("displayOrderShipping", (p) => {
			if (!p || !p.order || !p.can || !p.can(PERM_ORDERS, "view")) return null;
			const L = p.i18n.__("modules.novaposhta.panel");
			const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
			return `<div id="np-panel" class="border-bottom" data-order="${Number(p.order.id)}" data-edit="${p.can(PERM_ORDERS, "edit") ? 1 : 0}" data-settings="${p.can(PERM_SETTINGS, "view") ? 1 : 0}" data-l="${attr(JSON.stringify(L))}"></div>
<script src="/api/module/novaposhta/panel/?v=${encodeURIComponent(this.version)}" defer></script>`;
		});
	}

	_registerRoutes() {
		const can = (req, perm, action) => auth.hasPermission(req, perm, action);
		const need = (perm, action) => (req, res, next) => (can(req, perm, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
		// Помилки: ключ перекладу modules.novaposhta.e.* з підстановками або текст від НП
		const json = (fn) => async (req, res) => {
			try {
				res.json({ ok: true, ...(await fn(req)) });
			} catch (e) {
				if (!e.status) console.error("[novaposhta]", e);
				const msg = e.status ? (String(e.message).startsWith("modules.") ? req.__(e.message, e.vars || {}) : e.message) : req.__("catalog.common.server_error");
				res.status(e.status || 500).json({ ok: false, error: msg });
			}
		};
		const id = (v) => {
			const n = parseInt(v, 10);
			if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error("Invalid id"), { status: 400 });
			return n;
		};
		const authed = [auth.isAuthenticated];

		// ── Сторінка налаштувань ──
		this.registerRoute({
			method: "GET",
			path: "/",
			page: true,
			middlewares: authed,
			handler: async (req, res) => {
				if (!can(req, PERM_SETTINGS, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
				const [integrations] = await pool.query(`SELECT id, name FROM ${P}settings_integrations ORDER BY name`);
				res.render(path.join(__dirname, "views", "admin.ejs"), {
					i18n: req,
					user: req.user,
					header: { navbar: "modules", subnavbar: "novaposhta" },
					perms: { edit: can(req, PERM_SETTINGS, "edit") },
					integrations,
				});
			},
		});

		// ── Скрипт панелі в картці замовлення (API-адреса модуля — працює без сторінок /modules/…) ──
		this.registerRoute({
			method: "GET",
			path: "/panel/",
			middlewares: authed,
			handler: (req, res) => {
				res.set("Cache-Control", "private, max-age=3600");
				res.type("application/javascript");
				res.sendFile(path.join(__dirname, "views", "panel.js"), (err) => {
					// Файлу немає на сервері — зрозуміла помилка в консолі браузера замість HTML-сторінки
					if (err && !res.headersSent) res.status(404).send(`console.error("[novaposhta] Немає файлу modules/novaposhta/views/panel.js на сервері");`);
				});
			},
		});

		// ── Акаунти ──
		const S = (action) => [...authed, need(PERM_SETTINGS, action)];
		this.registerRoute({ method: "POST", path: "/accounts/", middlewares: S("view"), handler: json(async () => ({ rows: await accounts.list() })) });
		this.registerRoute({ method: "POST", path: "/accounts/save/", middlewares: S("edit"), handler: json(async (req) => ({ row: await accounts.save(req.body && req.body.id ? id(req.body.id) : null, req.body || {}) })) });
		this.registerRoute({ method: "POST", path: "/accounts/:id/delete/", middlewares: S("edit"), handler: json(async (req) => accounts.remove(id(req.params.id))) });
		this.registerRoute({
			method: "POST",
			path: "/accounts/senders/",
			middlewares: S("edit"),
			handler: json(async (req) => ({ senders: await accounts.senders(req.body && req.body.id ? id(req.body.id) : null, req.body && req.body.api_key) })),
		});

		// ── Довідники ──
		this.registerRoute({ method: "POST", path: "/directory/", middlewares: S("view"), handler: json(async () => directory.syncState()) });
		this.registerRoute({ method: "POST", path: "/directory/sync/", middlewares: S("edit"), handler: json(async () => directory.sync()) });

		// ── Пошук (картка замовлення й налаштування) ──
		// Замовлення в роботі в іншого менеджера — змінювати відправлення не можна (як і саме замовлення)
		const unlocked = async (req, res, next) => {
			const h = await ordersAccess.lockedBy(req, req.params.id);
			if (h) return res.status(423).json({ ok: false, error: req.__("orders.lock.busy", { name: h.name || "#" + h.id }) });
			next();
		};
		const O = (action) => [...authed, need(PERM_ORDERS, action), ...(action === "edit" ? [unlocked] : [])];
		this.registerRoute({ method: "POST", path: "/cities/", middlewares: authed, handler: json(async (req) => ({ rows: await directory.cities((req.body || {}).q) })) });
		this.registerRoute({
			method: "POST",
			path: "/warehouses/",
			middlewares: authed,
			handler: json(async (req) => ({ rows: await directory.warehouses((req.body || {}).city_ref, (req.body || {}).q, (req.body || {}).type) })),
		});

		// ── Відправлення в замовленні ──
		this.registerRoute({ method: "POST", path: "/order/:id/", middlewares: O("view"), handler: json(async (req) => shipments.forOrder(id(req.params.id))) });
		this.registerRoute({
			method: "POST",
			path: "/order/:id/:sid/save/",
			middlewares: O("edit"),
			handler: json(async (req) => ({ shipment: await shipments.save(id(req.params.id), id(req.params.sid), req.body || {}) })),
		});
		this.registerRoute({ method: "POST", path: "/order/:id/:sid/calc/", middlewares: O("edit"), handler: json(async (req) => shipments.calc(id(req.params.id), id(req.params.sid))) });
		this.registerRoute({ method: "POST", path: "/order/:id/:sid/rebuild/", middlewares: O("edit"), handler: json(async (req) => shipments.rebuild(id(req.params.id), id(req.params.sid))) });

		// ── ТТН: створення, видалення, статус, друк (A4 / 100×100) ──
		this.registerRoute({ method: "POST", path: "/order/:id/:sid/ttn/", middlewares: O("edit"), handler: json(async (req) => shipments.createTtn(id(req.params.id), id(req.params.sid), req.user.userId || req.user.id)) });
		this.registerRoute({ method: "POST", path: "/order/:id/:sid/ttn/delete/", middlewares: O("edit"), handler: json(async (req) => shipments.deleteTtn(id(req.params.id), id(req.params.sid), req.user.userId || req.user.id)) });
		this.registerRoute({ method: "POST", path: "/order/:id/:sid/track/", middlewares: O("view"), handler: json(async (req) => shipments.track(id(req.params.id), id(req.params.sid))) });
		this.registerRoute({
			method: "GET",
			path: "/order/:id/:sid/print/",
			middlewares: O("view"),
			handler: async (req, res) => {
				try {
					const r = await shipments.printTtn(id(req.params.id), id(req.params.sid), req.query.format);
					res.set("Content-Type", "application/pdf");
					res.set("Content-Disposition", `inline; filename="${r.name}"`);
					res.send(r.pdf);
				} catch (e) {
					if (!e.status) console.error("[novaposhta]", e);
					const msg = e.status && String(e.message).startsWith("modules.") ? req.__(e.message, e.vars || {}) : req.__("catalog.common.server_error");
					res.status(e.status || 500).type("text/plain; charset=utf-8").send(msg);
				}
			},
		});
	}

	async enable() {
		await ensureSchema();
		const cfg = (this.config && this.config.config) || {};
		api.setTimeoutMs(cfg.timeout_ms);
		shipments.setDefaultWeight(cfg.default_weight_kg);
		const hours = Math.max(1, Number(cfg.directory_sync_hours) || 24);
		// Раз на годину: чи не пора оновити довідник (порожній або старший за N годин)
		const tick = () => directory.syncIfDue(hours).catch((e) => console.error("[novaposhta] sync check:", e.message));
		this.timer = setInterval(tick, 60 * 60 * 1000);
		this.timer.unref();
		setTimeout(tick, 30 * 1000).unref();
		return super.enable();
	}

	async disable() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		return super.disable();
	}
}

module.exports = NovaposhtaModule;
