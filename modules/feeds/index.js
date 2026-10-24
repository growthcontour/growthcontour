"use strict";

/**
 * Модуль «Фіди»: генерація товарних фідів з каталогу.
 * Формати: google (Google Merchant Center, RSS 2.0 + g:), prom (Prom.ua, YML).
 * Сторінка керування: /modules/feeds/ ; публічна адреса фіду: /modules/feeds/f/<token>.xml
 */
const BaseModule = require("../../core/modules/modules");
const auth = require("../../controllers/authorization/authorization");
const feeds = require("./controllers/feeds");
const generator = require("./controllers/generator");

const PERM = "products.settings";

class FeedsModule extends BaseModule {
	constructor(config) {
		super(config);
		this.timer = null;
		this._registerHooks();
		this._registerRoutes();
	}

	_registerHooks() {
		// Пункт меню «Каталог → Налаштування» (header.ejs: hook('displayCatalogMenu', { i18n, can, header }))
		this.registerHook("displayCatalogMenu", (p) => {
			if (!p || !p.can || !p.can(PERM)) return null;
			const active = p.header && p.header.subnavbar === "products_feeds" ? ' class="active"' : "";
			return `<li><a href="/modules/feeds/"${active}>${p.i18n.__("modules.feeds.menu")}</a></li>`;
		});
	}

	_registerRoutes() {
		const can = (req, action) => auth.hasPermission(req, PERM, action);
		const need = (action) => (req, res, next) => (can(req, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
		const json = (fn) => async (req, res) => {
			try {
				res.json({ ok: true, ...(await fn(req)) });
			} catch (e) {
				if (!e.status) console.error("[feeds]", e);
				res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error"), errors: e.errors });
			}
		};
		const id = (v) => {
			const n = parseInt(v, 10);
			if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error("Invalid id"), { status: 400 });
			return n;
		};

		// ── Сторінка керування ──
		this.registerRoute({
			method: "GET",
			path: "/",
			page: true,
			middlewares: [auth.isAuthenticated],
			handler: async (req, res) => {
				if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
				res.render(require("path").join(__dirname, "views", "admin.ejs"), {
					i18n: req,
					user: req.user,
					header: { navbar: "modules", subnavbar: "products_feeds" },
					perms: { edit: can(req, "edit") },
					formats: generator.FORMATS,
					...(await feeds.dictionaries(req.user.id_lang || 1)),
				});
			},
		});

		// ── API ──
		this.registerRoute({ method: "POST", path: "/list/", middlewares: [auth.isAuthenticated, need("view")], handler: json(async () => ({ rows: await feeds.list() })) });
		this.registerRoute({ method: "POST", path: "/:id/get/", middlewares: [auth.isAuthenticated, need("view")], handler: json(async (req) => ({ row: await feeds.get(id(req.params.id)) })) });
		this.registerRoute({
			method: "POST",
			path: "/save/",
			middlewares: [auth.isAuthenticated, need("edit")],
			handler: json(async (req) => feeds.save(req.body && req.body.id ? id(req.body.id) : null, (req.body || {}).data)),
		});
		this.registerRoute({ method: "POST", path: "/:id/delete/", middlewares: [auth.isAuthenticated, need("edit")], handler: json(async (req) => feeds.remove(id(req.params.id))) });
		this.registerRoute({ method: "POST", path: "/:id/token/", middlewares: [auth.isAuthenticated, need("edit")], handler: json(async (req) => feeds.regenerateToken(id(req.params.id))) });
		this.registerRoute({
			method: "POST",
			path: "/:id/generate/",
			middlewares: [auth.isAuthenticated, need("edit")],
			// У фоні: великий каталог генерується хвилинами — HTTP-запит не має цього чекати
			handler: json(async (req) => generator.start(id(req.params.id))),
		});

		// ── Публічна адреса фіду (секрет — у токені) ──
		this.registerRoute({
			method: "GET",
			path: "/f/:file",
			page: true,
			handler: async (req, res) => generator.serve(String(req.params.file), req, res),
		});
	}

	async enable() {
		await feeds.ensureSchema();
		const minutes = Math.max(1, Number(this.config.config && this.config.config.check_interval_minutes) || 5);
		// Перевірка «чи час перегенерувати» — без node-cron, щоб вимкнення модуля зупиняло таймер
		this.timer = setInterval(() => generator.runDue().catch((e) => console.error("[feeds] runDue", e.message)), minutes * 60 * 1000);
		this.timer.unref();
		return super.enable();
	}

	async disable() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		return super.disable();
	}
}

module.exports = FeedsModule;