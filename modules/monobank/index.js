"use strict";

/**
 * Модуль «Monobank» (Mono Acquiring).
 *  - Сторінка /modules/monobank/ (право orders.settings): акаунти (кілька токенів / ФОП), тип оплати (одразу / холд),
 *    термін дії посилання, статуси замовлення після оплати й холду, прив'язка до магазинів.
 *  - Панель у картці замовлення (хук displayOrderPayment, право orders.list): посилання на оплату, стан,
 *    деталі платежу (картка, спосіб, банк, RRN, комісія), оновлення, анулювання, холд (списати / скасувати),
 *    повернення коштів через механізм повернень замовлення, фіскальні чеки ПРРО, квитанція на email, журнал подій.
 *  - Вебхук /api/module/monobank/webhook/?a=<акаунт> — підпис X-Sign перевіряється ключем банку (сире тіло, server.js).
 *  - Звірка відкритих рахунків за розкладом — на випадок втраченого вебхука.
 *  - Сторінка /modules/monobank/payments/ (право orders.settings): виписка всіх платежів, прив'язка до замовлень
 *    (автоматично й вручну), звірка розбіжностей, звіт. Виписка завантажується за розкладом.
 *  - Сповіщення менеджеру: невдала оплата, холд закінчується менш ніж за добу.
 *  - Список замовлень: колонка й фільтр «Monobank» (хуки displayOrdersColumns / displayOrdersFilters + core/modules/orders),
 *    масові дії (хук displayOrdersBulk): посилання на залишок, оновлення стану, копіювання посилань.
 *  - QR-каси: список із банку й назви (налаштування), сума замовлення на касу з картки замовлення.
 *  - Збережені картки (токенізація, вмикає банк): збереження під час оплати або посиланням «перевірка картки»,
 *    оплата карткою з картки замовлення, видалення.
 */
const path = require("path");
const BaseModule = require("../../core/modules/modules");
const auth = require("../../controllers/authorization/authorization");
const ordersAccess = require("../../controllers/orders/access");
const { pool, P, ensureSchema } = require("./controllers/common");
const api = require("./controllers/api");
const accounts = require("./controllers/accounts");
const invoices = require("./controllers/invoices");
const statement = require("./controllers/statement");
// Колонки / фільтри списку замовлень для модулів
const ordersExt = require("../../core/modules/orders");

const PERM_SETTINGS = "orders.settings";
const PERM_ORDERS = "orders.list";

class MonobankModule extends BaseModule {
	constructor(config) {
		super(config);
		this.timers = [];
		this._registerHooks();
		this._registerListHooks();
		this._registerRoutes();
	}

	_registerHooks() {
		// Картка замовлення: views/pages/orders/page.ejs → hook('displayOrderPayment', { i18n, can, order })
		this.registerHook("displayOrderPayment", (p) => {
			if (!p || !p.order || !p.can || !p.can(PERM_ORDERS, "view")) return null;
			const L = p.i18n.__("modules.monobank.panel");
			const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
			return `<div id="mono-panel" class="border-bottom" data-order="${Number(p.order.id)}" data-edit="${p.can(PERM_ORDERS, "edit") ? 1 : 0}" data-settings="${p.can(PERM_SETTINGS, "view") ? 1 : 0}" data-l="${attr(JSON.stringify(L))}"></div>
<script src="/api/module/monobank/panel/?v=${encodeURIComponent(this.version)}" defer></script>`;
		});
	}

	_registerListHooks() {
		const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
		const js = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
		// Фільтр у панелі фільтрів списку: значення йде в f.ext.monobank
		this.registerHook("displayOrdersFilters", (p) => {
			if (!p || !p.can || !p.can(PERM_ORDERS, "view")) return null;
			const L = p.i18n.__("modules.monobank.list");
			const opts = invoices.LIST_STATES.map((k) => `<option value="${k}">${attr(L["f_" + k])}</option>`).join("");
			return `<div class="col-6 col-md-2">
	<label class="section-title d-block">${attr(L.filter)}</label>
	<select class="form-select form-select-sm rounded-0" data-ext-filter="monobank"><option value="">${attr(L.any)}</option>${opts}</select>
</div>`;
		});
		// Колонка: стан оплати, сплачено / повернено, відкрите посилання
		this.registerHook("displayOrdersColumns", (p) => {
			if (!p || !p.can || !p.can(PERM_ORDERS, "view")) return null;
			const L = p.i18n.__("modules.monobank.list");
			return `<script>
(function () {
	const L = ${js(L)};
	const BADGE = { paid: "success", hold: "primary", awaiting: "warning", failed: "danger", lost: "secondary" };
	const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	const money = (v, c) => Number(v || 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + esc(c || "");
	(window.ordersExtColumns = window.ordersExtColumns || []).push({
		title: L.column,
		field: "ext",
		headerSort: false,
		width: 150,
		formatter: (cell) => {
			const m = (cell.getValue() || {}).monobank;
			if (!m) return '<span class="text-muted">—</span>';
			let h = '<span class="badge rounded-0 text-bg-' + (BADGE[m.state] || "secondary") + '">' + esc(L["s_" + m.state] || m.state) + "</span>";
			if (m.paid) h += '<div class="small text-nowrap">' + money(m.paid, m.currency) + "</div>";
			if (m.refunded) h += '<div class="small text-danger text-nowrap">−' + money(m.refunded, m.currency) + "</div>";
			if (m.url) h += '<div class="small"><a href="' + esc(m.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(L.link) + "</a></div>";
			return h;
		},
	});
})();
</script>`;
		});
		// Масові дії (window.ordersBulk — API сторінки списку)
		this.registerHook("displayOrdersBulk", (p) => {
			if (!p || !p.can || !p.can(PERM_ORDERS, "edit")) return null;
			const L = p.i18n.__("modules.monobank.list");
			return `<div class="btn-group btn-group-sm" id="mono-bulk">
	<button type="button" class="btn btn-outline-success rounded-0" data-mono="create"><i class="fa-solid fa-link me-1"></i>${attr(L.bulk_create)}</button>
	<button type="button" class="btn btn-outline-primary rounded-0" data-mono="links" title="${attr(L.bulk_copy)}"><i class="fa-regular fa-copy"></i></button>
	<button type="button" class="btn btn-outline-primary rounded-0" data-mono="refresh" title="${attr(L.bulk_refresh)}"><i class="fa-solid fa-rotate"></i></button>
</div>
<script>
(function () {
	const L = ${js(L)};
	const box = document.getElementById("mono-bulk");
	const post = async (path, body) => {
		const res = await fetch("/api/module/monobank/orders/" + path + "/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		const r = await res.json().catch(() => ({}));
		if (!res.ok || !r.ok) throw new Error(r.error || "Error");
		return r;
	};
	const copy = async (links) => {
		const text = links.map((l) => l.reference + " — " + l.amount.toFixed(2) + " " + l.currency + " — " + l.url).join("\\n");
		try {
			await navigator.clipboard.writeText(text);
			notyf.success(L.copied.replace("%n", links.length));
		} catch (e) {
			window.prompt(L.copy_manual, text);
		}
	};
	box.addEventListener("click", async (e) => {
		const b = e.target.closest("[data-mono]");
		if (!b || !window.ordersBulk) return;
		const ids = window.ordersBulk.ids();
		if (!ids.length) return;
		const act = b.dataset.mono;
		if (act === "create" && !confirm(L.confirm_create.replace("%n", ids.length))) return;
		b.disabled = true;
		try {
			if (act === "links") {
				const r = await post("bulk-links", { ids });
				if (!r.links.length) notyf.error(L.no_links);
				else await copy(r.links);
				return;
			}
			const r = await post(act === "create" ? "bulk-create" : "bulk-refresh", { ids });
			window.ordersBulk.report(r);
			window.ordersBulk.reload();
			if (act === "create" && r.links && r.links.length) await copy(r.links);
		} catch (err) {
			notyf.error(err.message);
		} finally {
			b.disabled = false;
		}
	});
})();
</script>`;
		});
	}

	_registerRoutes() {
		const can = (req, perm, action) => auth.hasPermission(req, perm, action);
		const need = (perm, action) => (req, res, next) => (can(req, perm, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
		// Текст помилки: ключ перекладу модуля / помилки перевірки повернення замовлення / загальна
		const errText = (req, e) => {
			if (e.status && String(e.message).startsWith("modules.")) return req.__(e.message, e.vars || {});
			if (e.status && Array.isArray(e.errors) && e.errors.length) return e.errors.map((x) => x.message).join("; ");
			return req.__("catalog.common.server_error");
		};
		const json = (fn) => async (req, res) => {
			try {
				res.json({ ok: true, ...(await fn(req)) });
			} catch (e) {
				if (!e.status) console.error("[monobank]", e);
				// code — ключ помилки модуля: панель реагує на конкретні випадки (наприклад, зайнята QR-каса)
				res.status(e.status || 500).json({ ok: false, error: errText(req, e), code: e.status && String(e.message).startsWith("modules.") ? e.message : undefined });
			}
		};
		// PDF (фіскальний чек, квитанція): помилка — текстом, бо відкривається в новій вкладці
		const pdf = (fn) => async (req, res) => {
			try {
				const r = await fn(req);
				res.set("Content-Type", "application/pdf");
				res.set("Content-Disposition", `inline; filename="${r.name}"`);
				res.send(r.pdf);
			} catch (e) {
				if (!e.status) console.error("[monobank]", e);
				res.status(e.status || 500).type("text/plain; charset=utf-8").send(errText(req, e));
			}
		};
		const id = (v) => {
			const n = parseInt(v, 10);
			if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error("modules.monobank.e.bad_id"), { status: 400 });
			return n;
		};
		const uid = (req) => req.user.userId || req.user.id;
		const authed = [auth.isAuthenticated];

		// ── Сторінка налаштувань ──
		this.registerRoute({
			method: "GET",
			path: "/",
			page: true,
			middlewares: authed,
			handler: async (req, res) => {
				if (!can(req, PERM_SETTINGS, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
				const [[integrations], [statuses]] = await Promise.all([
					pool.query(`SELECT id, name FROM ${P}settings_integrations ORDER BY name`),
					pool.query(
						`SELECT s.id, COALESCE(sl.text, CONCAT('#', s.id)) AS name FROM ${P}orders_status s
						   LEFT JOIN ${P}orders_status_lang sl ON sl.id_status = s.id AND sl.id_lang = ?
						  ORDER BY s.id`,
						[req.user.id_lang]
					),
				]);
				res.render(path.join(__dirname, "views", "admin.ejs"), {
					i18n: req,
					user: req.user,
					header: { navbar: "modules", subnavbar: "monobank" },
					perms: { edit: can(req, PERM_SETTINGS, "edit") },
					integrations,
					statuses,
					webhook: invoices.webhookUrl(0).replace(/\?a=0$/, ""),
				});
			},
		});

		// ── Масові дії зі списку замовлень ──
		const bulkIds = (v) => (Array.isArray(v) ? v : String(v || "").split(",")).map((x) => parseInt(x, 10)).filter((n) => n > 0);
		const tList = (req) => (k) => req.__("modules.monobank.list." + k);
		this.registerRoute({
			method: "POST",
			path: "/orders/bulk-create/",
			middlewares: [...authed, need(PERM_ORDERS, "edit")],
			handler: json(async (req) => {
				const t = await ordersAccess.targets(req, bulkIds((req.body || {}).ids));
				const r = await invoices.bulkCreate(t.ok, uid(req), tList(req), (e) => errText(req, e));
				return { done: r.done, links: r.links, skipped: [...t.skipped, ...r.skipped] };
			}),
		});
		this.registerRoute({
			method: "POST",
			path: "/orders/bulk-refresh/",
			middlewares: [...authed, need(PERM_ORDERS, "edit")],
			handler: json(async (req) => {
				const t = await ordersAccess.targets(req, bulkIds((req.body || {}).ids));
				const r = await invoices.bulkRefresh(t.ok, uid(req), (e) => errText(req, e));
				return { done: r.done, skipped: [...t.skipped, ...r.skipped] };
			}),
		});
		this.registerRoute({
			method: "POST",
			path: "/orders/bulk-links/",
			middlewares: [...authed, need(PERM_ORDERS, "view")],
			handler: json(async (req) => {
				const t = await ordersAccess.targets(req, bulkIds((req.body || {}).ids));
				return invoices.bulkLinks(t.ok);
			}),
		});

		// ── Платежі: виписка, звірка, звіт ──
		this.registerRoute({
			method: "GET",
			path: "/payments/",
			page: true,
			middlewares: authed,
			handler: async (req, res) => {
				if (!can(req, PERM_SETTINGS, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
				res.render(path.join(__dirname, "views", "payments.ejs"), {
					i18n: req,
					user: req.user,
					header: { navbar: "modules", subnavbar: "monobank" },
					perms: { edit: can(req, PERM_SETTINGS, "edit") && can(req, PERM_ORDERS, "edit") },
					accounts: (await accounts.list()).map((a) => ({ id: a.id, name: a.name })),
				});
			},
		});
		const PV = [...authed, need(PERM_SETTINGS, "view")];
		const PE = [...authed, need(PERM_SETTINGS, "edit"), need(PERM_ORDERS, "edit")];
		// Tabulator очікує { last_page, data } без обгортки ok
		this.registerRoute({
			method: "POST",
			path: "/payments/list/",
			middlewares: PV,
			handler: async (req, res) => {
				try {
					res.json(await statement.list(req.body || {}));
				} catch (e) {
					console.error("[monobank] payments list:", e);
					res.status(500).json({ last_page: 1, data: [] });
				}
			},
		});
		this.registerRoute({ method: "POST", path: "/payments/state/", middlewares: PV, handler: json(async () => statement.state()) });
		this.registerRoute({ method: "POST", path: "/payments/sync/", middlewares: [...authed, need(PERM_SETTINGS, "edit")], handler: json(async () => statement.syncInBackground()) });
		this.registerRoute({ method: "POST", path: "/payments/reconcile/", middlewares: PV, handler: json(async (req) => statement.reconcile(req.body || {})) });
		this.registerRoute({ method: "POST", path: "/payments/report/", middlewares: PV, handler: json(async (req) => statement.report(req.body || {})) });
		this.registerRoute({ method: "POST", path: "/payments/:id/attach/", middlewares: PE, handler: json(async (req) => statement.attach(id(req.params.id), (req.body || {}).order, uid(req))) });
		this.registerRoute({ method: "POST", path: "/payments/:id/detach/", middlewares: PE, handler: json(async (req) => statement.detach(id(req.params.id), uid(req))) });
		this.registerRoute({ method: "POST", path: "/payments/invoice/:id/refresh/", middlewares: PE, handler: json(async (req) => statement.fixInvoice(id(req.params.id), uid(req))) });

		// ── Скрипт панелі в картці замовлення ──
		this.registerRoute({
			method: "GET",
			path: "/panel/",
			middlewares: authed,
			handler: (req, res) => {
				res.set("Cache-Control", "private, max-age=3600");
				res.type("application/javascript");
				res.sendFile(path.join(__dirname, "views", "panel.js"), (err) => {
					if (err && !res.headersSent) res.status(404).send(`console.error("[monobank] Немає файлу modules/monobank/views/panel.js на сервері");`);
				});
			},
		});

		// ── Вебхук Monobank: без авторизації, достовірність — підписом X-Sign ──
		this.registerRoute({
			method: "POST",
			path: "/webhook/",
			handler: async (req, res) => {
				const raw = Buffer.isBuffer(req.body) ? req.body : null;
				if (!raw) {
					console.error("[monobank] webhook: тіло не сире — перевірте express.raw для /api/module/monobank/webhook у server.js");
					return res.status(500).end();
				}
				try {
					await invoices.webhook(parseInt(req.query.a, 10) || 0, raw, req.get("X-Sign"));
					res.status(200).end();
				} catch (e) {
					// 4xx — підробка чи чужий запит: банк не повторює; 5xx — повторить пізніше
					if (!e.status || e.status >= 500) console.error("[monobank] webhook:", e);
					else console.warn("[monobank] webhook rejected:", e.message);
					res.status(e.status && e.status < 500 ? e.status : 500).end();
				}
			},
		});

		// ── Акаунти ──
		const S = (action) => [...authed, need(PERM_SETTINGS, action)];
		// ── QR-каси (налаштування) ──
		this.registerRoute({ method: "POST", path: "/qr/", middlewares: S("view"), handler: json(async () => accounts.qrList()) });
		this.registerRoute({ method: "POST", path: "/qr/sync/", middlewares: S("edit"), handler: json(async () => accounts.qrSyncAll()) });
		this.registerRoute({ method: "POST", path: "/qr/:id/rename/", middlewares: S("edit"), handler: json(async (req) => accounts.qrRename(id(req.params.id), (req.body || {}).name)) });

		this.registerRoute({ method: "POST", path: "/accounts/", middlewares: S("view"), handler: json(async () => ({ rows: await accounts.list() })) });
		this.registerRoute({ method: "POST", path: "/accounts/save/", middlewares: S("edit"), handler: json(async (req) => ({ row: await accounts.save(req.body && req.body.id ? id(req.body.id) : null, req.body || {}) })) });
		this.registerRoute({ method: "POST", path: "/accounts/:id/delete/", middlewares: S("edit"), handler: json(async (req) => accounts.remove(id(req.params.id))) });
		this.registerRoute({
			method: "POST",
			path: "/accounts/:id/check/",
			middlewares: S("view"),
			handler: json(async (req) => {
				const acc = await accounts.withToken(id(req.params.id));
				const d = await api.details(acc.token);
				return { merchant: { id: d.merchantId, name: d.merchantName, edrpou: d.edrpou } };
			}),
		});

		// ── Рахунки в замовленні ──
		// Замовлення в роботі в іншого менеджера — дії з оплатою недоступні (як і зміни самого замовлення)
		const unlocked = async (req, res, next) => {
			const h = await ordersAccess.lockedBy(req, req.params.id);
			if (h) return res.status(423).json({ ok: false, error: req.__("orders.lock.busy", { name: h.name || "#" + h.id }) });
			next();
		};
		const O = (action) => [...authed, need(PERM_ORDERS, action), ...(action === "edit" ? [unlocked] : [])];
		this.registerRoute({ method: "POST", path: "/order/:id/", middlewares: O("view"), handler: json(async (req) => invoices.forOrder(id(req.params.id))) });
		// QR-каса й збережені картки — до маршрутів /order/:id/:iid/…, щоб «qr» / «cards» не сприймались як id рахунку
		this.registerRoute({ method: "POST", path: "/order/:id/qr/", middlewares: O("edit"), handler: json(async (req) => accounts.qrAssign(id(req.params.id), req.body || {}, uid(req))) });
		this.registerRoute({ method: "POST", path: "/order/:id/cards/pay/", middlewares: O("edit"), handler: json(async (req) => invoices.cardPay(id(req.params.id), req.body || {}, uid(req))) });
		this.registerRoute({ method: "POST", path: "/order/:id/cards/verify/", middlewares: O("edit"), handler: json(async (req) => invoices.cardVerificationLink(id(req.params.id), uid(req))) });
		this.registerRoute({ method: "POST", path: "/order/:id/cards/refresh/", middlewares: O("view"), handler: json(async (req) => invoices.cardsRefresh(id(req.params.id))) });
		this.registerRoute({ method: "POST", path: "/order/:id/cards/:cid/delete/", middlewares: O("edit"), handler: json(async (req) => invoices.cardRemove(id(req.params.id), id(req.params.cid), uid(req))) });
		this.registerRoute({ method: "POST", path: "/order/:id/create/", middlewares: O("edit"), handler: json(async (req) => invoices.create(id(req.params.id), req.body || {}, uid(req))) });
		this.registerRoute({ method: "POST", path: "/order/:id/:iid/refresh/", middlewares: O("view"), handler: json(async (req) => invoices.refresh(id(req.params.id), id(req.params.iid), uid(req))) });
		this.registerRoute({ method: "POST", path: "/order/:id/:iid/remove/", middlewares: O("edit"), handler: json(async (req) => invoices.invalidate(id(req.params.id), id(req.params.iid), uid(req))) });
		this.registerRoute({
			method: "POST",
			path: "/order/:id/:iid/finalize/",
			middlewares: O("edit"),
			handler: json(async (req) => invoices.finalize(id(req.params.id), id(req.params.iid), (req.body || {}).amount, uid(req))),
		});
		this.registerRoute({ method: "POST", path: "/order/:id/:iid/release/", middlewares: O("edit"), handler: json(async (req) => invoices.releaseHold(id(req.params.id), id(req.params.iid), uid(req))) });

		// Повернення коштів — право редагувати замовлення
		const R = O("edit");
		this.registerRoute({ method: "POST", path: "/order/:id/:iid/refund-form/", middlewares: R, handler: json(async (req) => invoices.refundForm(id(req.params.id), id(req.params.iid))) });
		this.registerRoute({ method: "POST", path: "/order/:id/:iid/refund/", middlewares: R, handler: json(async (req) => invoices.refund(id(req.params.id), id(req.params.iid), req.body || {}, uid(req))) });

		// Фіскальні чеки й квитанції
		this.registerRoute({ method: "POST", path: "/order/:id/:iid/fiscal/", middlewares: O("view"), handler: json(async (req) => invoices.fiscalChecks(id(req.params.id), id(req.params.iid))) });
		this.registerRoute({ method: "GET", path: "/order/:id/:iid/fiscal/:cid/", middlewares: O("view"), handler: pdf(async (req) => invoices.fiscalFile(id(req.params.id), id(req.params.iid), String(req.params.cid))) });
		this.registerRoute({ method: "GET", path: "/order/:id/:iid/receipt/", middlewares: O("view"), handler: pdf(async (req) => invoices.receipt(id(req.params.id), id(req.params.iid), null, uid(req))) });
		this.registerRoute({
			method: "POST",
			path: "/order/:id/:iid/receipt/",
			middlewares: O("view"),
			handler: json(async (req) => invoices.receipt(id(req.params.id), id(req.params.iid), String((req.body || {}).email || "").trim() || null, uid(req))),
		});

		this.registerRoute({ method: "POST", path: "/order/:id/:iid/copied/", middlewares: O("view"), handler: json(async (req) => invoices.logCopied(id(req.params.id), id(req.params.iid), uid(req))) });
		this.registerRoute({ method: "POST", path: "/order/:id/:iid/events/", middlewares: O("view"), handler: json(async (req) => invoices.events(id(req.params.id), id(req.params.iid))) });
	}

	async enable() {
		await ensureSchema();
		const cfg = (this.config && this.config.config) || {};
		api.setTimeoutMs(cfg.timeout_ms);
		const every = Math.max(5, Number(cfg.reconcile_minutes) || 15) * 60 * 1000;
		const tick = () => invoices.reconcileDue(cfg.reconcile_days).catch((e) => console.error("[monobank] reconcile:", e.message));
		// Виписка за розкладом; холди, що закінчуються, — щогодини
		statement.configure(cfg);
		const stEvery = Math.max(0.25, Number(cfg.statement_hours) || 1) * 60 * 60 * 1000;
		const stTick = () => statement.sync().catch((e) => console.error("[monobank] statement:", e.message));
		const holdTick = () => statement.holdsExpiring().catch((e) => console.error("[monobank] holds:", e.message));
		this.timers = [setInterval(tick, every), setTimeout(tick, 60 * 1000), setInterval(stTick, stEvery), setTimeout(stTick, 3 * 60 * 1000), setInterval(holdTick, 60 * 60 * 1000), setTimeout(holdTick, 5 * 60 * 1000)];
		this.timers.forEach((t) => t.unref());
		ordersExt.register("monobank", { filter: invoices.listFilter, rows: invoices.listRows });
		return super.enable();
	}

	async disable() {
		this.timers.forEach((t) => clearTimeout(t));
		this.timers = [];
		ordersExt.unregister("monobank");
		return super.disable();
	}
}

module.exports = MonobankModule;