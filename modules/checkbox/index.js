"use strict";

/**
 * Модуль «Checkbox» (ПРРО, https://checkbox.ua).
 *  - Сторінка /modules/checkbox/ (право orders.settings): каси (ліцензійний ключ + PIN касира, тест / бойовий сервер),
 *    прив'язка до магазинів, податкові ставки, доставка чеків, автовідкриття й автозакриття зміни, ЕТТН;
 *    керування зміною (відкрити / закрити з Z-звітом), X-звіт, службове внесення / видача готівки.
 *  - Панель у картці замовлення (хук displayOrderPayment, право orders.list): чек продажу (готівка / безготівка),
 *    повернення (повне чи за позиціями), стан, PDF / HTML / текст, надсилання email / SMS,
 *    ЕТТН — чек, який Checkbox видає сам, коли клієнт забирає посилку Нової Пошти.
 *  - За розкладом: стан чеків, що зависли; стан ЕТТН; автоматичні ЕТТН для ТТН з накладеним платежем.
 *  - Передплата / післяплата: чек передплати на частину суми, доплата, ЕТТН на залишок, повернення всього ланцюжка.
 *  - Вебхук Checkbox (/api/module/checkbox/webhook/?r=<каса>): стан чеків і ЕТТН одразу; опитування лишається запасним.
 *  - Офлайн: Checkbox сам переходить в офлайн, коли мовчить ДПС; система стежить за режимом каси, поповнює запас
 *    офлайн-кодів, дає перейти в офлайн / повернути в онлайн. Checkbox недоступний — чек у черзі (QUEUED), повтор автоматично.
 *  - Сторінка /modules/checkbox/receipts/: усі чеки кас (фільтри, суми), періодичний звіт і Z-звіти за дати.
 *  - Сповіщення (адресати каси + менеджер замовлення): помилка фіскалізації, зміна понад 20 год, мало офлайн-кодів.
 *  - Автоматичні чеки (налаштування каси, події core/modules/orders): оплата Monobank, статуси замовлення,
 *    повернення в замовленні → чек повернення.
 */
const path = require("path");
const BaseModule = require("../../core/modules/modules");
const auth = require("../../controllers/authorization/authorization");
const ordersAccess = require("../../controllers/orders/access");
const { pool, P, ensureSchema } = require("./controllers/common");
const api = require("./controllers/api");
const registers = require("./controllers/registers");
const receipts = require("./controllers/receipts");
const ettn = require("./controllers/ettn");
// Події замовлень і колонки / фільтри списку замовлень для модулів
const ordersExt = require("../../core/modules/orders");

const { shifts } = registers;

const PERM_SETTINGS = "orders.settings";
const PERM_ORDERS = "orders.list";

class CheckboxModule extends BaseModule {
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
			const L = p.i18n.__("modules.checkbox.panel");
			const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
			return `<div id="cb-panel" class="border-bottom" data-order="${Number(p.order.id)}" data-edit="${p.can(PERM_ORDERS, "edit") ? 1 : 0}" data-settings="${p.can(PERM_SETTINGS, "view") ? 1 : 0}" data-l="${attr(JSON.stringify(L))}"></div>
<script src="/api/module/checkbox/panel/?v=${encodeURIComponent(this.version)}" defer></script>`;
		});
	}

	_registerListHooks() {
		const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
		const js = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
		// Фільтр «Чек Checkbox» у панелі фільтрів (значення → f.ext.checkbox)
		this.registerHook("displayOrdersFilters", (p) => {
			if (!p || !p.can || !p.can(PERM_ORDERS, "view")) return null;
			const L = p.i18n.__("modules.checkbox.list");
			return `<div class="col-6 col-md-2">
	<label class="section-title d-block">${attr(L.filter)}</label>
	<select class="form-select form-select-sm rounded-0" data-ext-filter="checkbox"><option value="">${attr(L.any)}</option>${receipts.LIST_STATES.map((k) => `<option value="${k}">${attr(L["f_" + k])}</option>`).join("")}</select>
</div>`;
		});
		// Колонка «Чек»: стан фіскалізації, фіскальний номер, ТТН, що чекає отримання
		this.registerHook("displayOrdersColumns", (p) => {
			if (!p || !p.can || !p.can(PERM_ORDERS, "view")) return null;
			const L = p.i18n.__("modules.checkbox.list");
			return `<script>
(function () {
	const L = ${js(L)};
	const BADGE = { done: "success", returned: "secondary", pending: "warning", waiting: "info", error: "danger" };
	const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	(window.ordersExtColumns = window.ordersExtColumns || []).push({
		title: L.column,
		field: "ext",
		headerSort: false,
		width: 140,
		formatter: (cell) => {
			const m = (cell.getValue() || {}).checkbox;
			if (!m) return '<span class="text-muted">—</span>';
			let h = '<span class="badge rounded-0 text-bg-' + (BADGE[m.state] || "secondary") + '">' + esc(L["s_" + m.state] || m.state) + "</span>";
			if (m.fiscal_code) h += '<div class="small text-muted">' + esc(m.fiscal_code) + "</div>";
			else if (m.ttn) h += '<div class="small text-muted">' + esc(m.ttn) + "</div>";
			return h;
		},
	});
})();
</script>`;
		});
	}

	_registerRoutes() {
		const can = (req, perm, action) => auth.hasPermission(req, perm, action);
		const need = (perm, action) => (req, res, next) => (can(req, perm, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
		// Текст помилки: ключ перекладу модуля (з підстановками, у т. ч. текст від Checkbox) або загальна
		const errText = (req, e) => (e.status && String(e.message).startsWith("modules.") ? req.__(e.message, e.vars || {}) : req.__("catalog.common.server_error"));
		const json = (fn) => async (req, res) => {
			try {
				res.json({ ok: true, ...(await fn(req)) });
			} catch (e) {
				if (!e.status) console.error("[checkbox]", e);
				res.status(e.status || 500).json({ ok: false, error: errText(req, e), code: e.status && String(e.message).startsWith("modules.") ? e.message : undefined });
			}
		};
		const id = (v) => {
			const n = parseInt(v, 10);
			if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error("modules.checkbox.e.bad_id"), { status: 400 });
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
					header: { navbar: "modules", subnavbar: "checkbox" },
					perms: { edit: can(req, PERM_SETTINGS, "edit") },
					integrations,
					statuses,
					users: await registers.users(),
				});
			},
		});

		// ── Сторінка «Чеки»: усі чеки кас, періодичний звіт, Z-звіти ──
		this.registerRoute({
			method: "GET",
			path: "/receipts/",
			page: true,
			middlewares: authed,
			handler: async (req, res) => {
				if (!can(req, PERM_SETTINGS, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
				res.render(path.join(__dirname, "views", "receipts.ejs"), {
					i18n: req,
					user: req.user,
					header: { navbar: "modules", subnavbar: "checkbox" },
					registers: (await registers.list()).map((r) => ({ id: r.id, name: r.name })),
				});
			},
		});

		// ── Вебхук Checkbox: без авторизації, достовірність — підписом x-request-signature (сире тіло, server.js) ──
		this.registerRoute({
			method: "POST",
			path: "/webhook/",
			handler: async (req, res) => {
				const raw = Buffer.isBuffer(req.body) ? req.body : null;
				if (!raw) {
					console.error("[checkbox] webhook: тіло не сире — перевірте express.raw для /api/module/checkbox/webhook у server.js");
					return res.status(500).end();
				}
				try {
					await receipts.onWebhook(parseInt(req.query.r, 10) || 0, raw, req.get("x-request-signature"));
					res.status(200).end();
				} catch (e) {
					// 4xx — підробка / чужий запит (Checkbox повторює лише при помилці; відповідь 401 зупинить повтори не одразу, але це прийнятно)
					if (!e.status || e.status >= 500) console.error("[checkbox] webhook:", e);
					else console.warn("[checkbox] webhook rejected:", e.message);
					res.status(e.status && e.status < 500 ? e.status : 500).end();
				}
			},
		});

		// ── Скрипт панелі в картці замовлення ──
		this.registerRoute({
			method: "GET",
			path: "/panel/",
			middlewares: authed,
			handler: (req, res) => {
				res.set("Cache-Control", "private, max-age=3600");
				res.type("application/javascript");
				res.sendFile(path.join(__dirname, "views", "panel.js"), (err) => {
					if (err && !res.headersSent) res.status(404).send(`console.error("[checkbox] Немає файлу modules/checkbox/views/panel.js на сервері");`);
				});
			},
		});

		// ── Каси, зміни, звіти ──
		const S = (action) => [...authed, need(PERM_SETTINGS, action)];
		this.registerRoute({ method: "POST", path: "/registers/", middlewares: S("view"), handler: json(async () => ({ rows: await registers.list() })) });
		this.registerRoute({ method: "POST", path: "/registers/save/", middlewares: S("edit"), handler: json(async (req) => ({ row: await registers.save(req.body && req.body.id ? id(req.body.id) : null, req.body || {}) })) });
		this.registerRoute({ method: "POST", path: "/registers/:id/delete/", middlewares: S("edit"), handler: json(async (req) => registers.remove(id(req.params.id))) });
		this.registerRoute({ method: "POST", path: "/registers/:id/taxes/", middlewares: S("view"), handler: json(async (req) => registers.taxes(id(req.params.id))) });
		this.registerRoute({ method: "POST", path: "/registers/:id/shift/", middlewares: S("view"), handler: json(async (req) => ({ shift: await shifts.current(await registers.get(id(req.params.id))) })) });
		this.registerRoute({ method: "POST", path: "/registers/:id/shift/open/", middlewares: S("edit"), handler: json(async (req) => shifts.open(await registers.get(id(req.params.id)), uid(req))) });
		this.registerRoute({ method: "POST", path: "/registers/:id/shift/close/", middlewares: S("edit"), handler: json(async (req) => shifts.close(await registers.get(id(req.params.id)), uid(req))) });
		this.registerRoute({ method: "POST", path: "/registers/:id/x-report/", middlewares: S("view"), handler: json(async (req) => shifts.xReport(await registers.get(id(req.params.id)), uid(req))) });
		this.registerRoute({ method: "POST", path: "/registers/:id/service/", middlewares: S("edit"), handler: json(async (req) => receipts.service(id(req.params.id), (req.body || {}).amount, uid(req))) });

		// Tabulator очікує { last_page, data } без обгортки ok
		this.registerRoute({
			method: "POST",
			path: "/receipts/list/",
			middlewares: S("view"),
			handler: async (req, res) => {
				try {
					res.json(await receipts.listAll(req.body || {}));
				} catch (e) {
					console.error("[checkbox] receipts list:", e);
					res.status(500).json({ last_page: 1, data: [] });
				}
			},
		});
		this.registerRoute({
			method: "GET",
			path: "/receipts/:rid/file/:kind/",
			middlewares: S("view"),
			handler: async (req, res) => {
				try {
					const f = await receipts.fileById(id(req.params.rid), String(req.params.kind));
					res.set("Content-Type", f.type);
					res.set("Content-Disposition", `inline; filename="${f.name}"`);
					res.send(f.buffer);
				} catch (e) {
					if (!e.status) console.error("[checkbox]", e);
					res.status(e.status || 500).type("text/plain; charset=utf-8").send(errText(req, e));
				}
			},
		});
		this.registerRoute({ method: "POST", path: "/registers/:id/mode/", middlewares: S("view"), handler: json(async (req) => registers.mode(id(req.params.id))) });
		this.registerRoute({ method: "POST", path: "/registers/:id/go-offline/", middlewares: S("edit"), handler: json(async (req) => registers.goOffline(id(req.params.id), uid(req))) });
		this.registerRoute({ method: "POST", path: "/registers/:id/go-online/", middlewares: S("edit"), handler: json(async (req) => registers.goOnline(id(req.params.id), uid(req))) });
		this.registerRoute({ method: "POST", path: "/registers/:id/ask-codes/", middlewares: S("edit"), handler: json(async (req) => registers.askCodes(id(req.params.id), uid(req))) });
		this.registerRoute({ method: "POST", path: "/registers/:id/webhook/", middlewares: S("edit"), handler: json(async (req) => registers.setupWebhook(id(req.params.id))) });
		this.registerRoute({ method: "POST", path: "/registers/:id/webhook-info/", middlewares: S("view"), handler: json(async (req) => registers.webhookInfo(id(req.params.id))) });
		this.registerRoute({ method: "POST", path: "/registers/:id/periodical/", middlewares: S("view"), handler: json(async (req) => registers.periodical(id(req.params.id), (req.body || {}).from, (req.body || {}).to)) });
		this.registerRoute({ method: "POST", path: "/registers/:id/z-reports/", middlewares: S("view"), handler: json(async (req) => registers.zReports(id(req.params.id), (req.body || {}).from, (req.body || {}).to)) });
		this.registerRoute({ method: "POST", path: "/registers/:id/report-text/", middlewares: S("view"), handler: json(async (req) => registers.reportText(id(req.params.id), (req.body || {}).report)) });

		// ── Чеки замовлення ──
		// Замовлення в роботі в іншого менеджера — видавати чеки не можна (як і змінювати замовлення)
		const unlocked = async (req, res, next) => {
			const h = await ordersAccess.lockedBy(req, req.params.id);
			if (h) return res.status(423).json({ ok: false, error: req.__("orders.lock.busy", { name: h.name || "#" + h.id }) });
			next();
		};
		const O = (action) => [...authed, need(PERM_ORDERS, action), ...(action === "edit" ? [unlocked] : [])];
		this.registerRoute({ method: "POST", path: "/order/:id/", middlewares: O("view"), handler: json(async (req) => receipts.forOrder(id(req.params.id))) });
		this.registerRoute({ method: "POST", path: "/order/:id/sell/", middlewares: O("edit"), handler: json(async (req) => receipts.sell(id(req.params.id), req.body || {}, uid(req))) });
		this.registerRoute({ method: "POST", path: "/order/:id/receipt/:rid/retry/", middlewares: O("edit"), handler: json(async (req) => receipts.retry(id(req.params.id), id(req.params.rid))) });
		this.registerRoute({ method: "POST", path: "/order/:id/receipt/:rid/refresh/", middlewares: O("view"), handler: json(async (req) => receipts.refresh(id(req.params.id), id(req.params.rid))) });
		this.registerRoute({ method: "POST", path: "/order/:id/receipt/:rid/return-form/", middlewares: O("edit"), handler: json(async (req) => receipts.returnForm(id(req.params.id), id(req.params.rid))) });
		this.registerRoute({ method: "POST", path: "/order/:id/receipt/:rid/return/", middlewares: O("edit"), handler: json(async (req) => receipts.refund(id(req.params.id), id(req.params.rid), req.body || {}, uid(req))) });
		this.registerRoute({ method: "POST", path: "/order/:id/receipt/:rid/send/", middlewares: O("view"), handler: json(async (req) => receipts.send(id(req.params.id), id(req.params.rid), req.body || {}, uid(req))) });
		this.registerRoute({
			method: "GET",
			path: "/order/:id/receipt/:rid/file/:kind/",
			middlewares: O("view"),
			handler: async (req, res) => {
				try {
					const f = await receipts.file(id(req.params.id), id(req.params.rid), String(req.params.kind));
					res.set("Content-Type", f.type);
					res.set("Content-Disposition", `inline; filename="${f.name}"`);
					res.send(f.buffer);
				} catch (e) {
					if (!e.status) console.error("[checkbox]", e);
					res.status(e.status || 500).type("text/plain; charset=utf-8").send(errText(req, e));
				}
			},
		});

		// ── Передплата / післяплата (ланцюжок чеків) ──
		this.registerRoute({ method: "POST", path: "/order/:id/chain/prepay/", middlewares: O("edit"), handler: json(async (req) => receipts.prepay(id(req.params.id), req.body || {}, uid(req))) });
		this.registerRoute({ method: "POST", path: "/order/:id/chain/pay/", middlewares: O("edit"), handler: json(async (req) => receipts.pay(id(req.params.id), req.body || {}, uid(req))) });
		this.registerRoute({ method: "POST", path: "/order/:id/chain/return/", middlewares: O("edit"), handler: json(async (req) => receipts.returnChain(id(req.params.id), uid(req))) });
		this.registerRoute({
			method: "POST",
			path: "/order/:id/chain/refresh/",
			middlewares: O("view"),
			handler: json(async (req) => {
				const c = await receipts.openChain(id(req.params.id));
				if (c) await receipts.refreshChain(c);
				return receipts.forOrder(id(req.params.id));
			}),
		});

		// ── ЕТТН: чек при отриманні посилки ──
		this.registerRoute({ method: "POST", path: "/order/:id/ettn/create/", middlewares: O("edit"), handler: json(async (req) => ettn.create(id(req.params.id), id((req.body || {}).shipment), uid(req))) });
		this.registerRoute({ method: "POST", path: "/order/:id/ettn/:eid/refresh/", middlewares: O("view"), handler: json(async (req) => ettn.refresh(id(req.params.id), id(req.params.eid))) });
		this.registerRoute({ method: "POST", path: "/order/:id/ettn/:eid/cancel/", middlewares: O("edit"), handler: json(async (req) => ettn.cancel(id(req.params.id), id(req.params.eid), uid(req))) });
		this.registerRoute({ method: "POST", path: "/order/:id/ettn/:eid/fiscalize/", middlewares: O("edit"), handler: json(async (req) => ettn.fiscalize(id(req.params.id), id(req.params.eid), uid(req))) });
	}

	async enable() {
		await ensureSchema();
		const cfg = (this.config && this.config.config) || {};
		api.setTimeoutMs(cfg.timeout_ms);
		const rEvery = Math.max(1, Number(cfg.sync_minutes) || 5) * 60 * 1000;
		const eEvery = Math.max(5, Number(cfg.ettn_minutes) || 15) * 60 * 1000;
		const rTick = () => receipts.syncDue().catch((e) => console.error("[checkbox] receipts sync:", e.message));
		const eTick = async () => {
			await ettn.autoCreate().catch((e) => console.error("[checkbox] ettn auto:", e.message));
			await ettn.syncDue(cfg.ettn_minutes).catch((e) => console.error("[checkbox] ettn sync:", e.message));
		};
		// Щогодини: зміна відкрита понад 20 год, запас офлайн-кодів
		const mTick = () => registers.monitor().catch((e) => console.error("[checkbox] monitor:", e.message));
		// Щохвилини: повернення кас в онлайн (go-online повторюється, доки каса не стане онлайн)
		const oTick = () => registers.onlineTick().catch((e) => console.error("[checkbox] online:", e.message));
		this.timers = [setInterval(rTick, rEvery), setTimeout(rTick, 60 * 1000), setInterval(eTick, eEvery), setTimeout(eTick, 2 * 60 * 1000), setInterval(mTick, 60 * 60 * 1000), setTimeout(mTick, 5 * 60 * 1000), setInterval(oTick, 60 * 1000)];
		this.timers.forEach((t) => t.unref());
		ordersExt.register("checkbox", { filter: receipts.listFilter, rows: receipts.listRows });
		ordersExt.on("checkbox", "monobank.paid", receipts.onMonobankPaid);
		ordersExt.on("checkbox", "status", receipts.onStatus);
		ordersExt.on("checkbox", "refund", receipts.onRefund);
		return super.enable();
	}

	async disable() {
		this.timers.forEach((t) => clearTimeout(t));
		this.timers = [];
		ordersExt.off("checkbox");
		ordersExt.unregister("checkbox");
		return super.disable();
	}
}

module.exports = CheckboxModule;