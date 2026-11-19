"use strict";

/**
 * Точки розширення замовлень для модулів (modules/<назва>): без правок ядра модуль може
 *  - додати колонку й фільтр у список замовлень (register / unregister),
 *  - підписатися на події замовлень і слати власні (on / off / emit).
 * Підключення в модулі: const ordersExt = require("../../core/modules/orders");
 */

/**
 * ── Список замовлень ──
 * Розширення списку замовлень модулями: власні фільтри й дані для колонок — без правок ядра.
 *
 * Сервер (модуль у enable() / disable()):
 *   ordersExt.register("monobank", {
 *     filter: (value, alias) => ({ sql: "EXISTS (...)", params: [...] }) | null, // f.ext.monobank зі списку
 *     rows: async (ids) => Map<id замовлення, дані>,                              // потрапляє в row.ext.monobank
 *   });
 *   ordersExt.unregister("monobank");
 *
 * Сторінка (views/pages/orders/index.ejs):
 *   хук displayOrdersFilters — поля фільтра з атрибутом data-ext-filter="<назва>";
 *   хук displayOrdersColumns — <script>, що додає колонки в window.ordersExtColumns (до створення таблиці).
 *
 * Фільтр працює лише по колонках orders (alias o) і підзапитах — без JOIN, щоб лічильник списку лишався простим.
 */
const exts = new Map();

function register(name, def) {
	if (!name || !def) return;
	exts.set(String(name), { filter: typeof def.filter === "function" ? def.filter : null, rows: typeof def.rows === "function" ? def.rows : null });
}

function unregister(name) {
	exts.delete(String(name));
}

/** Умови фільтрів модулів → where / params списку. Помилка модуля не ламає список */
function applyFilters(ext, alias, where, params) {
	if (!ext || typeof ext !== "object") return;
	for (const [name, value] of Object.entries(ext)) {
		const e = exts.get(name);
		if (!e || !e.filter || value === "" || value === null || value === undefined) continue;
		try {
			const r = e.filter(value, alias);
			if (r && r.sql) {
				where.push(`(${r.sql})`);
				params.push(...(r.params || []));
			}
		} catch (err) {
			console.error(`[orders list] filter ${name}:`, err.message);
		}
	}
}

/** Дані модулів для рядків поточної сторінки: row.ext[<назва>] */
async function decorate(rows) {
	if (!rows.length || !exts.size) return rows;
	const ids = rows.map((r) => Number(r.id));
	for (const [name, e] of exts) {
		if (!e.rows) continue;
		try {
			const map = await e.rows(ids);
			for (const r of rows) {
				const v = map && map.get(Number(r.id));
				if (v !== undefined) (r.ext = r.ext || {})[name] = v;
			}
		} catch (err) {
			console.error(`[orders list] rows ${name}:`, err.message);
		}
	}
	return rows;
}

/**
 * ── Події замовлень ──
 * Події замовлень для модулів (підписка без правок ядра).
 *   const ordersExt = require("../../core/modules/orders");
 *   ordersExt.on("checkbox", "paid", async (idOrder, extra) => { … });   // у enable()
 *   ordersExt.off("checkbox");                                           // у disable()
 *
 * Події ядра (controllers/orders/notify.fire): new, status { to }, paid, ttn, delivered, returned, refund { amount, id_refund }, rma.
 * Модулі шлють власні події з префіксом, напр. "monobank.paid" — через emit().
 * Обробники виконуються у фоні: помилка одного модуля не зупиняє інших і не ламає дію, що викликала подію.
 */
const subs = new Map(); // модуль → Map<подія, обробник>

function on(module, event, fn) {
	if (!subs.has(module)) subs.set(module, new Map());
	subs.get(module).set(event, fn);
}

function off(module) {
	subs.delete(module);
}

function emit(idOrder, event, extra = {}) {
	for (const [module, map] of subs) {
		const fn = map.get(event);
		if (!fn) continue;
		setImmediate(() => {
			Promise.resolve()
				.then(() => fn(Number(idOrder), extra || {}))
				.catch((e) => console.error(`[orders events] ${module} ${event} #${idOrder}:`, e && e.message ? e.message : e));
		});
	}
}

module.exports = { register, unregister, applyFilters, decorate, on, off, emit };