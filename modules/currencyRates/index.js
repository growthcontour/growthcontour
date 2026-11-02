"use strict";

/**
 * Модуль «Курси валют»: джерела курсів для довідника «Валюти» (налаштування каталогу).
 * Увімкнений — джерела з'являються в колонці «Джерело»; ядро щогодини бере курси для валют із цими джерелами
 * і далі обробляє їх як ручну зміну курсу (журнал, корекція %, поріг, «лише вгору», перерахунок цін).
 * Вимкнений — джерела зникають, валюти лишаються з останнім курсом (оновлюються вручну).
 *
 * Які джерела вмикати — module.json → config.providers. «Оновити курси зараз» — кнопка в «Налаштування каталогу → Валюти».
 * GET /api/module/currencyRates/status/ (право products.settings) — останнє звернення до кожного джерела: час, курси або помилка.
 */
const path = require("path");
const BaseModule = require("../../core/modules/modules");
const auth = require("../../controllers/authorization/authorization");
const pricing = require("../../controllers/catalog/products/pricing");
const { PROVIDERS, setTimeoutMs } = require("./controllers/providers");

const PERM = "products.settings";

class CurrencyRatesModule extends BaseModule {
	constructor(config) {
		super(config);
		this.registered = [];
		this.last = {}; // key → { at, ok, rates | error }
		this._registerRoutes();
	}

	/** Назви джерел — з перекладів модуля (основна мова — uk) */
	_names() {
		try {
			return require(path.join(__dirname, "locales", "uk.json")).modules.currencyRates.providers;
		} catch (e) {
			return {};
		}
	}

	_registerRoutes() {
		const can = (req, action) => auth.hasPermission(req, PERM, action);
		const need = (action) => (req, res, next) => (can(req, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));

		this.registerRoute({
			method: "GET",
			path: "/status/",
			middlewares: [auth.isAuthenticated, need("view")],
			handler: async (req, res) => res.json({ ok: true, providers: this.registered, status: this.last }),
		});
	}

	async enable() {
		const cfg = (this.config && this.config.config) || {};
		setTimeoutMs(cfg.timeout_ms);
		const on = cfg.providers || {};
		const names = this._names();
		for (const [key, fetchRates] of Object.entries(PROVIDERS)) {
			if (on[key] === false) continue;
			pricing.registerProvider(key, {
				name: names[key] || key,
				// Обгортка: запам'ятати результат для /status/ (помилку — і пробросити, щоб ядро її залогувало)
				fetch: async (codes, base) => {
					try {
						const rates = await fetchRates(codes, base);
						this.last[key] = { at: new Date().toISOString(), ok: true, rates };
						return rates;
					} catch (e) {
						this.last[key] = { at: new Date().toISOString(), ok: false, error: String(e.message || e) };
						throw e;
					}
				},
			});
			this.registered.push(key);
		}
		return super.enable();
	}

	async disable() {
		for (const key of this.registered) pricing.unregisterProvider(key);
		this.registered = [];
		return super.disable();
	}
}

module.exports = CurrencyRatesModule;