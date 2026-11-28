"use strict";

/**
 * Ціноутворення: ефективна ціна з урахуванням групи клієнта, кількості й дати,
 * а також відкладені (заплановані) зміни базової ціни з автоматичним поверненням.
 */
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const history = require("./history");
const groups = require("./customer-groups");
const { validateSchedule } = require("../../../validator/catalog/products/customer-groups");

const P = config.get("configDatabase").prefix;
const EPS = 0.00005;

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

const round4 = (n) => Math.round(Number(n) * 10000) / 10000;

function applyRule(base, r) {
	const v = Number(r.value);
	if (r.reduction_type === "new_price") return v;
	if (r.reduction_type === "fixed") return Math.max(0, base - v);
	return Math.max(0, base * (1 - v / 100));
}

/**
 * Ефективна ціна.
 * Порядок вибору правила: правило варіанта → правило конкретної групи → менший priority →
 * більший min_qty → нижча ціна. Якщо жодне правило не підходить — знижка групи (discount_percent).
 * Дати порівнюються з часом сервера БД (DATETIME без зони, як і всі дати каталогу).
 */
async function resolve({ idProduct, idVariant = 0, idGroup = null, qty = 1, at = null }, conn) {
	const db = conn || pool;
	const [[p]] = await db.query(`SELECT id, price, compare_at_price, price_on_request FROM ${P}products WHERE id = ? AND deleted_at IS NULL`, [idProduct]);
	if (!p) throw httpErr(404, "Not found");

	let base = Number(p.price);
	let compareAt = p.compare_at_price === null ? null : Number(p.compare_at_price);
	if (idVariant) {
		const [[v]] = await db.query(`SELECT price_mode, price, compare_at_price FROM ${P}products_variants WHERE id = ? AND id_product = ?`, [idVariant, idProduct]);
		if (!v) throw httpErr(404, "Variant not found");
		base = v.price_mode === "fixed" ? Number(v.price) : base + Number(v.price);
		if (v.compare_at_price !== null) compareAt = Number(v.compare_at_price);
	}

	if (!idGroup) {
		const def = (await groups.options()).find((g) => g.is_default);
		idGroup = def ? def.id : 0;
	}
	const group = (await groups.options()).find((g) => g.id === Number(idGroup)) || null;

	const when = at || null; // null → NOW() сервера БД
	const [rules] = await db.query(
		`SELECT id, id_variant, kind, id_customer_group, min_qty, reduction_type, value, priority, date_start, date_end
		   FROM ${P}products_prices
		  WHERE id_product = ? AND id_variant IN (0, ?) AND id_customer_group IN (0, ?) AND min_qty <= ?
		    AND (date_start IS NULL OR date_start <= COALESCE(?, NOW())) AND (date_end IS NULL OR date_end > COALESCE(?, NOW()))`,
		[idProduct, idVariant || 0, idGroup || 0, qty, when, when]
	);

	const ranked = rules.map((r) => ({ ...r, result: round4(applyRule(base, r)) })).sort((a, b) => (b.id_variant ? 1 : 0) - (a.id_variant ? 1 : 0) || (b.id_customer_group ? 1 : 0) - (a.id_customer_group ? 1 : 0) || a.priority - b.priority || Number(b.min_qty) - Number(a.min_qty) || a.result - b.result);

	let price = base;
	let source = "base";
	let rule = null;
	if (ranked.length) {
		rule = ranked[0];
		price = rule.result;
		source = rule.kind;
	} else if (group && group.discount_percent > 0) {
		price = round4(base * (1 - group.discount_percent / 100));
		source = "group";
	}

	// Перекреслена ціна: явна compare_at або базова, якщо діє знижка
	const strike = price < base - EPS ? Math.max(base, compareAt || 0) : compareAt !== null && compareAt > price + EPS ? compareAt : null;

	return {
		id_product: idProduct,
		id_variant: idVariant || 0,
		id_customer_group: idGroup || 0,
		qty,
		at: when,
		base: round4(base),
		price: round4(price),
		compare_at_price: strike === null ? null : round4(strike),
		source,
		rule: rule ? { id: rule.id, kind: rule.kind, reduction_type: rule.reduction_type, value: Number(rule.value), min_qty: Number(rule.min_qty), date_end: rule.date_end } : null,
		price_on_request: !!p.price_on_request,
	};
}

/* ═══ ЗАПЛАНОВАНІ ЗМІНИ ЦІН ═══ */

async function listSchedule(idProduct) {
	const [rows] = await pool.query(
		`SELECT s.*, CONCAT_WS(' ', u.first_name, u.last_name) AS user_name
		   FROM ${P}products_price_schedule s
		   LEFT JOIN ${P}users u ON u.id = s.id_user
		  WHERE s.id_product = ? AND s.id_variant = 0
		  ORDER BY FIELD(s.status, 'pending', 'applied', 'failed', 'reverted', 'canceled'), s.run_at DESC
		  LIMIT 200`,
		[idProduct]
	);
	return rows;
}

async function createSchedule(idProduct, body, ctx) {
	const v = validateSchedule(body);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);
	const d = v.data;
	const [[p]] = await pool.query(`SELECT id, price_currency FROM ${P}products WHERE id = ? AND deleted_at IS NULL`, [idProduct]);
	if (!p) throw httpErr(404, "Not found");
	// Значення — у валюті ціни товару на момент створення (null — базова)
	const [r] = await pool.query(
		`INSERT INTO ${P}products_price_schedule (id_product, id_variant, field, value, currency, set_compare_at, run_at, revert_at, comment, id_user)
		 VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[idProduct, d.field, d.value, p.price_currency || null, Number(d.set_compare_at), d.run_at, d.revert_at, d.comment, ctx.idUser]
	);
	return { id: r.insertId };
}

/** pending → canceled; applied з revert_at → скасувати лише повернення */
async function cancelSchedule(idProduct, id) {
	const [r1] = await pool.query(`UPDATE ${P}products_price_schedule SET status = 'canceled' WHERE id = ? AND id_product = ? AND status = 'pending'`, [id, idProduct]);
	if (r1.affectedRows) return { canceled: "change" };
	const [r2] = await pool.query(`UPDATE ${P}products_price_schedule SET revert_at = NULL WHERE id = ? AND id_product = ? AND status = 'applied' AND revert_at IS NOT NULL`, [id, idProduct]);
	if (r2.affectedRows) return { canceled: "revert" };
	throw httpErr(409, "Nothing to cancel");
}

const same = (a, b) => (a === null || a === undefined ? b === null || b === undefined : b !== null && b !== undefined && Math.abs(Number(a) - Number(b)) < EPS);

/** Один крок: застосувати або повернути. Повертає подію для історії або null */
async function step(conn, job, mode) {
	const [[p]] = await conn.query(`SELECT id, price, compare_at_price, price_currency, price_cur, compare_cur FROM ${P}products WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [job.id_product]);
	if (!p) {
		await conn.query(`UPDATE ${P}products_price_schedule SET status = 'failed', error = 'product not found', revert_at = NULL WHERE id = ?`, [job.id]);
		return null;
	}
	// Ціна у валюті: розклад працює з сумами у валюті (price_cur / compare_cur), базова — перерахунком
	const cur = job.currency || null;
	if ((p.price_currency || null) !== cur) {
		await conn.query(`UPDATE ${P}products_price_schedule SET status = 'failed', error = 'price currency changed', revert_at = NULL WHERE id = ?`, [job.id]);
		return null;
	}
	const price = Number(cur ? p.price_cur : p.price);
	const cmpRaw = cur ? p.compare_cur : p.compare_at_price;
	const cmp = cmpRaw === null || cmpRaw === undefined ? null : Number(cmpRaw);
	const set = {};

	if (mode === "apply") {
		const value = job.value === null ? null : Number(job.value);
		if (job.field === "price") {
			set.price = value;
			if (job.set_compare_at && value < price - EPS) set.compare_at_price = Math.max(price, cmp || 0);
			else if (cmp !== null && cmp <= value + EPS) set.compare_at_price = null; // інваріант compare_at > price
		} else {
			if (value !== null && value <= price + EPS) {
				await conn.query(`UPDATE ${P}products_price_schedule SET status = 'failed', error = 'compare_at_price must be greater than price', revert_at = NULL WHERE id = ?`, [job.id]);
				return null;
			}
			set.compare_at_price = value;
		}
		await conn.query(`UPDATE ${P}products_price_schedule SET status = 'applied', applied_at = NOW(), old_price = ?, old_compare_at = ? WHERE id = ?`, [price, cmp, job.id]);
	} else {
		// Повертаємо, лише якщо ніхто не змінив значення вручну після застосування
		const expected = job.field === "price" ? price : cmp;
		const applied = job.value === null ? null : Number(job.value);
		if (!same(expected, applied)) {
			await conn.query(`UPDATE ${P}products_price_schedule SET status = 'reverted', reverted_at = NOW(), error = 'skipped: value changed manually' WHERE id = ?`, [job.id]);
			return null;
		}
		if (job.field === "price") {
			set.price = Number(job.old_price);
			const restoreCmp = job.old_compare_at === null ? null : Number(job.old_compare_at);
			if (!same(cmp, restoreCmp)) set.compare_at_price = restoreCmp !== null && restoreCmp > set.price + EPS ? restoreCmp : null;
		} else {
			const restoreCmp = job.old_compare_at === null ? null : Number(job.old_compare_at);
			set.compare_at_price = restoreCmp !== null && restoreCmp > price + EPS ? restoreCmp : null;
		}
		await conn.query(`UPDATE ${P}products_price_schedule SET status = 'reverted', reverted_at = NOW() WHERE id = ?`, [job.id]);
	}

	// Суми у валюті → *_cur, у звичні поля — перерахунок у базову
	if (cur) {
		const cx = await currencyCtx();
		if ("price" in set) {
			set.price_cur = set.price;
			set.price = cx.price(set.price, cur);
		}
		if ("compare_at_price" in set) {
			set.compare_cur = set.compare_at_price;
			set.compare_at_price = set.compare_at_price === null ? null : cx.price(set.compare_at_price, cur);
		}
	}
	const keys = Object.keys(set);
	await conn.query(`UPDATE ${P}products SET ${keys.map((k) => `${k} = ?`).join(", ")}, version = version + 1, id_user_edit = ? WHERE id = ?`, [...keys.map((k) => set[k]), job.id_user, job.id_product]);
	const before = cur ? { price: Number(p.price), compare_at_price: p.compare_at_price === null ? null : Number(p.compare_at_price), price_cur: price, compare_cur: cmp } : { price, compare_at_price: cmp };
	const changes = keys.filter((k) => !same(before[k], set[k])).map((k) => ({ field: k, old: before[k], new: set[k] }));
	return changes.length ? { id: job.id_product, user: job.id_user, changes, meta: { schedule: job.id, mode } } : null;
}

let running = false;

/** Cron (щохвилини): застосувати всі pending з run_at <= NOW() і повернути applied з revert_at <= NOW() */
async function runDue(limit = 500) {
	if (running) return { skipped: true };
	running = true;
	const stats = { applied: 0, reverted: 0, failed: 0 };
	try {
		for (const mode of ["apply", "revert"]) {
			const where = mode === "apply" ? "status = 'pending' AND run_at <= NOW()" : "status = 'applied' AND revert_at IS NOT NULL AND revert_at <= NOW()";
			for (let done = 0; done < limit; ) {
				const conn = await pool.getConnection();
				let ev = null;
				let found = false;
				let jobId = null;
				try {
					await conn.beginTransaction();
					const [[job]] = await conn.query(`SELECT * FROM ${P}products_price_schedule WHERE ${where} ORDER BY ${mode === "apply" ? "run_at" : "revert_at"}, id LIMIT 1 FOR UPDATE SKIP LOCKED`);
					if (job) {
						found = true;
						jobId = job.id;
						ev = await step(conn, job, mode);
					}
					await conn.commit();
				} catch (e) {
					await conn.rollback();
					stats.failed++;
					console.error("[price-schedule]", jobId, e.message);
					// Позначити, щоб одна зламана задача не блокувала чергу щохвилини
					if (!jobId) break;
					await pool.query(`UPDATE ${P}products_price_schedule SET status = 'failed', error = ?, revert_at = NULL WHERE id = ?`, [String(e.message).slice(0, 255), jobId]).catch(() => {});
					done++;
					continue;
				} finally {
					conn.release();
				}
				if (!found) break;
				done++;
				if (ev) {
					stats[mode === "apply" ? "applied" : "reverted"]++;
					await history.record("products", ev.id, { user: ev.user, source: "schedule", action: "update", changes: ev.changes, meta: ev.meta });
				}
			}
		}
		return stats;
	} finally {
		running = false;
	}
}

/* ═══ ВАЛЮТИ ═══════════════════════════════════════════════════════════════
 * Ціни товарів можна вводити в будь-якій валюті з довідника (налаштування каталогу → «Валюти»).
 * Введене зберігається в *_cur, а звичні поля (price, compare_at_price, cost_price, wholesale_price,
 * ціна значення опції) — уже в базовій валюті системи: їх читають сайти, замовлення, фіди, як і раніше.
 * Курс = скільки базової валюти за 1 одиницю валюти; ефективний курс = курс × (1 + корекція %).
 * Ядро не ходить в інтернет. Автоматичні курси дають модулі: registerProvider() у процесі
 * або POST /api/integrations/v1/currency/rates/ ззовні — обидва йдуть через setRates().
 */

const settings = require("./settings");
const CUR_RE = /^[A-Z]{3}$/;
const providers = new Map(); // key → { name, fetch(codes, base) → [{ code, rate }] }
let recalcBusy = false;

/** Модуль курсів: providers.set; fetch повертає [{ code, rate }] (rate — базової валюти за 1 одиницю) */
function registerProvider(key, def) {
	if (!/^[a-z0-9_]{1,32}$/.test(String(key)) || key === "manual") throw new Error("Bad provider key");
	if (!def || typeof def.fetch !== "function") throw new Error("Provider needs fetch()");
	providers.set(key, { name: String(def.name || key), fetch: def.fetch });
}
/** Прибрати джерело (модуль вимкнено). Валюти з цим джерелом лишаються з останнім курсом */
function unregisterProvider(key) {
	providers.delete(key);
}
const providerList = () => [{ key: "manual", name: "manual" }, ...[...providers].map(([key, d]) => ({ key, name: d.name }))];

/** Округлення продажної ціни за правилом валюти: none — до копійок; up / nearest / down — до кроку; minus — «закінчення» (100 − 1 → …99) */
function roundMoney(v, c) {
	const x = Number(v) || 0;
	if (!c || c.round === "none") return Math.round(x * 100) / 100;
	const step = Number(c.step) > 0 ? Number(c.step) : 1;
	const q = round4(x / step);
	const f = c.round === "up" ? Math.ceil : c.round === "down" ? Math.floor : Math.round;
	let out = f(q) * step;
	if (Number(c.minus) > 0 && out - Number(c.minus) > 0) out -= Number(c.minus);
	return Math.max(0, round4(out));
}

/** Контекст валют: базова, довідник, ефективні курси й перерахунок сум */
async function currencyCtx() {
	const all = await settings.getAll();
	const base = all.prices.base_currency;
	const list = ((all.currencies && all.currencies.list) || []).filter((c) => c.code !== base);
	const byCode = new Map(list.map((c) => [c.code, c]));
	const rate = (code) => {
		if (!code || code === base) return 1;
		const c = byCode.get(code);
		return c && Number(c.rate) > 0 ? Number(c.rate) * (1 + (Number(c.correction) || 0) / 100) : null;
	};
	const need = (code) => {
		const r = rate(code);
		if (r === null) throw httpErr(400, "Validation failed", [{ field: "currency", message: `unknown currency ${code}` }]);
		return r;
	};
	return {
		base,
		list,
		byCode,
		rate,
		has: (code) => !code || code === base || byCode.has(code),
		// продажна ціна: курс + округлення валюти
		price: (amount, code) => (amount === null || amount === undefined ? null : roundMoney(Number(amount) * need(code), byCode.get(code))),
		// собівартість: лише курс, 4 знаки
		plain: (amount, code) => (amount === null || amount === undefined ? null : round4(Number(amount) * need(code))),
		// надбавка (опції, ± до ціни): курс, до копійок
		delta: (amount, code) => (amount === null || amount === undefined ? null : Math.round(Number(amount) * need(code) * 100) / 100),
	};
}

// Групи цін товару: поле валюти → [поле в базовій, поле в валюті, як рахувати]
const PRODUCT_CUR = [
	[
		"price_currency",
		[
			["price", "price_cur", "price"],
			["compare_at_price", "compare_cur", "price"],
		],
	],
	["cost_currency", [["cost_price", "cost_cur", "plain"]]],
	["wholesale_currency", [["wholesale_price", "wholesale_cur", "price"]]],
];

/**
 * Ядро товару перед записом: якщо в групи цін є валюта (не базова) — суми з форми вважаються сумами в цій валюті:
 * їх запам'ятовуємо в *_cur, а в звичні поля пишемо перерахунок у базову. Без валюти — *_cur очищаються.
 */
function convertCore(core, cx) {
	// Фіксовані ціни у валютах: лише валюти з довідника, суми > 0
	if (core.price_fixed !== undefined) {
		let fx = {};
		try {
			fx = core.price_fixed ? JSON.parse(core.price_fixed) : {};
		} catch (e) {
			throw httpErr(400, "Validation failed", [{ field: "price_fixed", message: "invalid" }]);
		}
		const clean = {};
		for (const [code, v] of Object.entries(fx && typeof fx === "object" ? fx : {})) {
			const c = String(code).toUpperCase();
			if (CUR_RE.test(c) && c !== cx.base && cx.has(c) && Number(v) > 0) clean[c] = Math.round(Number(v) * 10000) / 10000;
		}
		core.price_fixed = Object.keys(clean).length ? JSON.stringify(clean) : null;
	}
	for (const [cf, fields] of PRODUCT_CUR) {
		const code = core[cf] && core[cf] !== cx.base ? String(core[cf]).toUpperCase() : null;
		if (code && !cx.has(code)) throw httpErr(400, "Validation failed", [{ field: cf, message: "unknown currency" }]);
		core[cf] = code;
		for (const [f, cur, kind] of fields) {
			if (!code) {
				core[cur] = null;
				continue;
			}
			core[cur] = core[f] === null || core[f] === undefined ? null : Number(core[f]);
			core[f] = core[cur] === null ? (f === "price" ? 0 : null) : cx[kind](core[cur], code);
		}
	}
	return core;
}

/** Значення опцій: price_currency — своя валюта (null — як у товару); фіксована надбавка у валюті → *_cur і базова */
function convertOptions(data, productCurrency, cx) {
	for (const o of data.options || []) {
		for (const v of o.values || []) {
			const own = v.price_currency ? String(v.price_currency).toUpperCase() : null;
			if (own && !cx.has(own)) throw httpErr(400, "Validation failed", [{ field: "options", message: "unknown currency" }]);
			v.price_currency = own;
			const code = own || productCurrency || null;
			if (v.price_mode === "fixed" && code && code !== cx.base) {
				v.price_cur = Number(v.price) || 0;
				v.price = cx.delta(v.price_cur, code);
			} else v.price_cur = null;
		}
	}
	return data;
}

/**
 * Перерахунок цін у валютах codes за поточними курсами.
 * apply = false — лише попередній перегляд: скільки зміниться, вгору / вниз, нижче собівартості, приклади.
 * «Лише вгору» (only_up) — нова продажна ціна нижча за поточну → лишаємо поточну. Собівартість рахується завжди.
 */
async function recalcCurrencies({ codes, apply = false, idUser = null, source = "currency", ignoreOnlyUp = false, withDeleted = false } = {}) {
	// withDeleted — разом із товарами в кошику (зміна основної валюти: після відновлення ціни вже правильні)
	const alive = withDeleted ? "1 = 1" : "deleted_at IS NULL";
	const pAlive = withDeleted ? "1 = 1" : "p.deleted_at IS NULL";
	const cx = await currencyCtx();
	codes = [...new Set((codes && codes.length ? codes : cx.list.map((c) => c.code)).filter((c) => cx.byCode.has(c)))];
	const batch = history.lazyBatch({ source, user: idUser, title: codes.join(", "), meta: { currencies: codes } });
	const out = { codes, products: 0, variants: 0, price_rules: 0, options: 0, up: 0, down: 0, kept: 0, below_cost: 0, sample: [] };
	if (!codes.length) return out;
	if (apply && recalcBusy) throw httpErr(409, "Recalculation is already running");
	if (apply) recalcBusy = true;
	const onlyUp = (code) => !!(cx.byCode.get(code) || {}).only_up;
	const cmp = (oldV, newV, code, isSale) => {
		if (newV === null || oldV === null || oldV === undefined) return newV;
		if (isSale && !ignoreOnlyUp && onlyUp(code) && newV < Number(oldV)) {
			out.kept++;
			return Number(oldV);
		}
		return newV;
	};
	try {
		// ── Товари ──
		for (let after = 0; ; ) {
			const [rows] = await pool.query(
				`SELECT id, price, compare_at_price, cost_price, wholesale_price, price_currency, price_cur, compare_cur, cost_currency, cost_cur, wholesale_currency, wholesale_cur
				   FROM ${P}products
				  WHERE id > ? AND ${alive} AND (price_currency IN (?) OR cost_currency IN (?) OR wholesale_currency IN (?))
				  ORDER BY id LIMIT 500`,
				[after, codes, codes, codes]
			);
			if (!rows.length) break;
			after = rows[rows.length - 1].id;
			for (const r of rows) {
				const set = {};
				for (const [cf, fields] of PRODUCT_CUR) {
					const code = r[cf];
					if (!codes.includes(code)) continue;
					for (const [f, cur, kind] of fields) {
						if (r[cur] === null) continue;
						const nv = cmp(r[f], cx[kind](r[cur], code), code, kind === "price");
						if (Math.abs(Number(nv) - Number(r[f] || 0)) > EPS) set[f] = nv;
					}
				}
				// Стара ціна не може стати нижчою за ціну
				const price = set.price !== undefined ? set.price : Number(r.price);
				const compare = set.compare_at_price !== undefined ? set.compare_at_price : r.compare_at_price;
				if (compare !== null && compare !== undefined && Number(compare) <= price) set.compare_at_price = null;
				if (!Object.keys(set).length) continue;
				out.products++;
				if (set.price !== undefined) set.price > Number(r.price) ? out.up++ : out.down++;
				const cost = set.cost_price !== undefined ? set.cost_price : r.cost_price;
				if (cost !== null && Number(cost) > 0 && price < Number(cost)) out.below_cost++;
				if (out.sample.length < 200) out.sample.push({ id: r.id, changes: Object.entries(set).map(([field, v]) => ({ field, old: r[field] === null ? null : Number(r[field]), new: v })) });
				if (apply) {
					const keys = Object.keys(set);
					await pool.query(`UPDATE ${P}products SET ${keys.map((k) => `${k} = ?`).join(", ")}, version = version + 1, date_edit = NOW() WHERE id = ?`, [...keys.map((k) => set[k]), r.id]);
					await history.record("products", r.id, {
						user: idUser,
						source,
						action: "update",
						changes: keys.map((k) => ({ field: k, old: r[k] === null ? null : Number(r[k]), new: set[k] })),
						meta: { currencies: codes },
						batch: await batch(),
					});
				}
			}
		}
		// ── Варіанти: валюта своя або як у товару; fixed — ціна, impact — надбавка ──
		const vTouched = new Set();
		const vHist = new Map(); // id товару → зміни варіантів для історії
		for (let after = 0; ; ) {
			const [vs] = await pool.query(
				`SELECT v.id, v.id_product, v.price_mode, v.price, v.compare_at_price, v.cost_price, v.price_cur, v.compare_cur, v.cost_cur,
				        COALESCE(v.price_currency, p.price_currency) AS pc, COALESCE(v.cost_currency, p.cost_currency) AS cc
				   FROM ${P}products_variants v
				   JOIN ${P}products p ON p.id = v.id_product AND ${pAlive}
				  WHERE v.id > ? AND (COALESCE(v.price_currency, p.price_currency) IN (?) OR COALESCE(v.cost_currency, p.cost_currency) IN (?))
				  ORDER BY v.id LIMIT 1000`,
				[after, codes, codes]
			);
			if (!vs.length) break;
			after = vs[vs.length - 1].id;
			for (const v of vs) {
				const set = {};
				if (codes.includes(v.pc)) {
					if (v.price_cur !== null) {
						const nv = cmp(v.price, v.price_mode === "fixed" ? cx.price(v.price_cur, v.pc) : cx.delta(v.price_cur, v.pc), v.pc, true);
						if (Math.abs(Number(nv) - Number(v.price)) > EPS) set.price = nv;
					}
					if (v.compare_cur !== null) {
						const nv = cmp(v.compare_at_price, cx.price(v.compare_cur, v.pc), v.pc, true);
						if (Math.abs(Number(nv) - Number(v.compare_at_price || 0)) > EPS) set.compare_at_price = nv;
					}
				}
				if (codes.includes(v.cc) && v.cost_cur !== null) {
					const nv = cx.plain(v.cost_cur, v.cc);
					if (Math.abs(Number(nv) - Number(v.cost_price || 0)) > EPS) set.cost_price = nv;
				}
				if (!Object.keys(set).length) continue;
				out.variants = (out.variants || 0) + 1;
				if (apply) {
					const keys = Object.keys(set);
					await pool.query(`UPDATE ${P}products_variants SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => set[k]), v.id]);
					vTouched.add(v.id_product);
					// Історія товару: зміни варіанта — полями variant.<id>.<поле>
					const list = vHist.get(v.id_product) || vHist.set(v.id_product, []).get(v.id_product);
					keys.forEach((k) => list.push({ field: `variant.${v.id}.${k}`, old: v[k] === null ? null : Number(v[k]), new: set[k] }));
				}
			}
		}
		if (vTouched.size) await pool.query(`UPDATE ${P}products SET version = version + 1, date_edit = NOW() WHERE id IN (?)`, [[...vTouched]]);
		for (const [pid, changes] of vHist) await history.record("products", pid, { user: idUser, source, action: "update", changes, meta: { currencies: codes }, batch: await batch() });

		// ── Ціни груп клієнтів / від кількості у валюті ──
		const [prs] = await pool.query(
			`SELECT pp.id, pp.id_product, pp.reduction_type, pp.value, pp.value_cur, pp.currency
			   FROM ${P}products_prices pp JOIN ${P}products p ON p.id = pp.id_product AND ${pAlive}
			  WHERE pp.currency IN (?) AND pp.value_cur IS NOT NULL AND pp.reduction_type <> 'percent'`,
			[codes]
		);
		const prTouched = new Set();
		for (const r of prs) {
			const nv = cmp(r.value, r.reduction_type === "new_price" ? cx.price(r.value_cur, r.currency) : cx.delta(r.value_cur, r.currency), r.currency, r.reduction_type === "new_price");
			if (Math.abs(Number(nv) - Number(r.value)) <= EPS) continue;
			out.price_rules = (out.price_rules || 0) + 1;
			if (apply) {
				await pool.query(`UPDATE ${P}products_prices SET value = ? WHERE id = ?`, [nv, r.id]);
				prTouched.add(r.id_product);
			}
		}
		if (prTouched.size) await pool.query(`UPDATE ${P}products SET version = version + 1, date_edit = NOW() WHERE id IN (?)`, [[...prTouched]]);

		// ── Значення опцій (фіксована надбавка у валюті) ──
		const [ovs] = await pool.query(
			`SELECT ov.id, ov.price, ov.price_cur, COALESCE(ov.price_currency, p.price_currency) AS code, po.id_product
			   FROM ${P}products_to_option_values ov
			   JOIN ${P}products_to_options po ON po.id = ov.id_product_option
			   JOIN ${P}products p ON p.id = po.id_product AND ${pAlive}
			  WHERE ov.price_mode = 'fixed' AND ov.price_cur IS NOT NULL AND COALESCE(ov.price_currency, p.price_currency) IN (?)`,
			[codes]
		);
		const touched = new Set();
		for (const v of ovs) {
			const nv = cmp(v.price, cx.delta(v.price_cur, v.code), v.code, true);
			if (Math.abs(Number(nv) - Number(v.price)) <= EPS) continue;
			out.options++;
			if (apply) {
				await pool.query(`UPDATE ${P}products_to_option_values SET price = ? WHERE id = ?`, [nv, v.id]);
				touched.add(v.id_product);
			}
		}
		// Товари зі зміненими опціями — у автообмін сайтів
		if (touched.size) await pool.query(`UPDATE ${P}products SET version = version + 1, date_edit = NOW() WHERE id IN (?)`, [[...touched]]);

		// Собівартість у валюті змінилась — товари «за формулою» з цією собівартістю отримують нову ціну
		if (apply) {
			const [auto] = await pool.query(
				`SELECT p.id FROM ${P}products p WHERE p.deleted_at IS NULL AND p.price_auto = 1
				    AND (p.cost_currency IN (?) OR EXISTS (SELECT 1 FROM ${P}products_variants v WHERE v.id_product = p.id AND v.price_auto = 1 AND v.cost_currency IN (?)))`,
				[codes, codes]
			);
			if (auto.length) out.formula = (await recalcFormula({ ids: auto.map((r) => r.id), apply: true, idUser, source })).products;
		}

		if (apply) await markApplied(codes, cx);
	} finally {
		if (apply) recalcBusy = false;
	}
	return out;
}

/* ═══ ЗМІНА ОСНОВНОЇ ВАЛЮТИ ══════════════════════════════════════════════
 * Стара основна B → нова N (N уже є в довіднику). Курс r — скільки B за 1 N.
 * Крок 1 (у транзакції): суми, введені в B (валюта порожня), отримують валюту B і *_cur = введена сума;
 *   суми у валюті N стають сумами в основній (валюта порожня, звичне поле = *_cur). Інші валюти не чіпаються.
 * Крок 2: довідник — курси всіх валют діляться на r, B додається валютою з курсом 1/r, N прибирається.
 * Крок 3: перерахунок усіх цін за новими курсами (без «лише вгору» — змінюється одиниця виміру).
 * mode = "keep" — ціни, введені в B, і далі прив'язані до B (змінюється курс — змінюються ціни);
 * mode = "convert" — після перерахунку ціни в B відв'язуються й стають звичайними цінами в N.
 */
async function changeBase({ code, rate, mode = "keep", round = "none", step = 1, minus = 0, name = "", symbol = "", apply = false, idUser = null } = {}) {
	const cx = await currencyCtx();
	const B = cx.base;
	const N = String(code || "").toUpperCase();
	const n = cx.byCode.get(N);
	if (!n || N === B) throw httpErr(400, "Validation failed", [{ field: "code", message: "unknown currency" }]);
	const r = Number(rate) > 0 ? Number(rate) : Number(n.rate);
	if (!(r > 0)) throw httpErr(400, "Validation failed", [{ field: "rate", message: "invalid" }]);
	if (!["keep", "convert"].includes(mode)) throw httpErr(400, "Validation failed", [{ field: "mode", message: "invalid" }]);
	if (!["none", "up", "nearest", "down"].includes(round)) round = "none";

	// Огляд: скільки рядків у старій основній і в новій
	const cnt = async (sql, args) => Number((await pool.query(sql, args))[0][0].n);
	const isB = (f) => `(${f} IS NULL OR ${f} = '' OR ${f} = ?)`;
	const info = {
		from: B,
		to: N,
		rate: r,
		products_base: await cnt(`SELECT COUNT(*) n FROM ${P}products WHERE deleted_at IS NULL AND ${isB("price_currency")}`, [B]),
		products_new: await cnt(`SELECT COUNT(*) n FROM ${P}products WHERE deleted_at IS NULL AND (price_currency = ? OR cost_currency = ? OR wholesale_currency = ?)`, [N, N, N]),
		products_other: await cnt(`SELECT COUNT(*) n FROM ${P}products WHERE deleted_at IS NULL AND price_currency IS NOT NULL AND price_currency NOT IN ('', ?, ?)`, [B, N]),
		schedule: await cnt(`SELECT COUNT(*) n FROM ${P}products_price_schedule WHERE status IN ('pending', 'applied')`, []),
		sample: (await pool.query(`SELECT id, price, price_currency, price_cur FROM ${P}products WHERE deleted_at IS NULL AND price > 0 ORDER BY id LIMIT 5`))[0].map((p) => {
			const fromB = !p.price_currency || p.price_currency === B;
			const amount = fromB ? Number(p.price) : p.price_currency === N ? Number(p.price_cur) : null;
			const nb = fromB ? roundMoney(Number(p.price) / r, { round, step, minus }) : amount;
			return { id: p.id, old: Number(p.price), currency: fromB ? B : p.price_currency, new: amount === null ? null : nb };
		}),
	};
	if (!apply) return info;
	if (recalcBusy) throw httpErr(409, "Recalculation is already running");
	recalcBusy = true;

	// Знімок цін у валюті N (вони стають цінами в основній без перерахунку) — для історії товарів
	const PF = ["price", "compare_at_price", "cost_price", "wholesale_price"];
	const VF = ["price", "compare_at_price", "cost_price"];
	const [snapP] = await pool.query(`SELECT id, ${PF.join(", ")} FROM ${P}products WHERE price_currency = ? OR cost_currency = ? OR wholesale_currency = ?`, [N, N, N]);
	const [snapV] = await pool.query(
		`SELECT v.id, v.id_product, ${VF.map((f) => "v." + f).join(", ")} FROM ${P}products_variants v JOIN ${P}products p ON p.id = v.id_product
		  WHERE COALESCE(NULLIF(v.price_currency, ''), NULLIF(p.price_currency, '')) = ? OR COALESCE(NULLIF(v.cost_currency, ''), NULLIF(p.cost_currency, '')) = ?`,
		[N, N]
	);

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		// Пари (поле валюти; [звичне, у валюті]) — спершу залежні таблиці: вони дивляться на валюту товару до зміни
		// Два окремі SET: у багатотабличному UPDATE MySQL не гарантує порядок присвоєнь
		const toBaseSet = (pairs) => pairs.map(([f, c]) => `${f} = COALESCE(${c}, ROUND(${f} / ${r}, 4))`).join(", ");
		const clearSet = (pairs) => pairs.map(([, c]) => `${c} = NULL`).join(", ");
		const toCurSet = (pairs) => pairs.map(([f, c]) => `${c} = ${f}`).join(", ");
		// Варіанти: валюта своя або як у товару
		for (const [vf, pf, pairs] of [
			["price_currency", "price_currency", [["v.price", "v.price_cur"], ["v.compare_at_price", "v.compare_cur"]]],
			["cost_currency", "cost_currency", [["v.cost_price", "v.cost_cur"]]],
		]) {
			const eff = `COALESCE(NULLIF(v.${vf}, ''), NULLIF(p.${pf}, ''))`;
			await conn.query(`UPDATE ${P}products_variants v JOIN ${P}products p ON p.id = v.id_product SET ${toBaseSet(pairs)} WHERE ${eff} = ?`, [N]);
			await conn.query(`UPDATE ${P}products_variants v JOIN ${P}products p ON p.id = v.id_product SET ${clearSet(pairs)}, v.${vf} = IF(p.${pf} = ?, NULL, v.${vf}) WHERE ${eff} = ?`, [N, N]);
			await conn.query(`UPDATE ${P}products_variants v JOIN ${P}products p ON p.id = v.id_product SET ${toCurSet(pairs)} WHERE ${eff} IS NULL OR ${eff} = ?`, [B]);
		}
		// Значення опцій (фіксована надбавка)
		const oeff = `COALESCE(NULLIF(ov.price_currency, ''), NULLIF(p.price_currency, ''))`;
		const ojoin = `${P}products_to_option_values ov JOIN ${P}products_to_options po ON po.id = ov.id_product_option JOIN ${P}products p ON p.id = po.id_product`;
		await conn.query(`UPDATE ${ojoin} SET ov.price = COALESCE(ov.price_cur, ROUND(ov.price / ${r}, 2)) WHERE ov.price_mode = 'fixed' AND ${oeff} = ?`, [N]);
		await conn.query(`UPDATE ${ojoin} SET ov.price_cur = NULL, ov.price_currency = IF(p.price_currency = ?, NULL, ov.price_currency) WHERE ov.price_mode = 'fixed' AND ${oeff} = ?`, [N, N]);
		await conn.query(`UPDATE ${ojoin} SET ov.price_cur = ov.price WHERE ov.price_mode = 'fixed' AND (${oeff} IS NULL OR ${oeff} = ?)`, [B]);
		// Ціни груп і від кількості (відсоток — без валюти)
		await conn.query(`UPDATE ${P}products_prices SET value = COALESCE(value_cur, ROUND(value / ${r}, 4)), value_cur = NULL, currency = NULL WHERE currency = ?`, [N]);
		await conn.query(`UPDATE ${P}products_prices SET value_cur = value, currency = ? WHERE reduction_type <> 'percent' AND ${isB("currency")}`, [B]);
		// Заплановані зміни: суми вже у своїй валюті — міняється лише позначка валюти
		await conn.query(`UPDATE ${P}products_price_schedule SET currency = IF(currency = ?, NULL, ?) WHERE status IN ('pending', 'applied') AND (${isB("currency")} OR currency = ?)`, [N, B, B, N]);
		// Товари
		for (const [cf, pairs] of [
			["price_currency", [["price", "price_cur"], ["compare_at_price", "compare_cur"]]],
			["cost_currency", [["cost_price", "cost_cur"]]],
			["wholesale_currency", [["wholesale_price", "wholesale_cur"]]],
		]) {
			await conn.query(`UPDATE ${P}products SET ${toBaseSet(pairs)} WHERE ${cf} = ?`, [N]);
			await conn.query(`UPDATE ${P}products SET ${clearSet(pairs)}, ${cf} = NULL WHERE ${cf} = ?`, [N]);
			await conn.query(`UPDATE ${P}products SET ${toCurSet(pairs)}, ${cf} = ? WHERE ${isB(cf)}`, [B, B]);
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		recalcBusy = false;
		throw e;
	} finally {
		conn.release();
	}

	// Історія: суми в N тепер у звичних полях (одиниця — нова основна)
	try {
		const hist = new Map();
		const add = (pid, ch) => (hist.get(pid) || hist.set(pid, []).get(pid)).push(ch);
		const num = (x) => (x === null || x === undefined ? null : Number(x));
		const diff = (o, n) => (o === null ? n !== null : n === null || Math.abs(o - n) > EPS);
		if (snapP.length) {
			const [after] = await pool.query(`SELECT id, ${PF.join(", ")} FROM ${P}products WHERE id IN (?)`, [snapP.map((x) => x.id)]);
			const byId = new Map(after.map((x) => [x.id, x]));
			for (const b of snapP) for (const f of PF) if (byId.has(b.id) && diff(num(b[f]), num(byId.get(b.id)[f]))) add(b.id, { field: f, old: num(b[f]), new: num(byId.get(b.id)[f]) });
		}
		if (snapV.length) {
			const [after] = await pool.query(`SELECT id, ${VF.join(", ")} FROM ${P}products_variants WHERE id IN (?)`, [snapV.map((x) => x.id)]);
			const byId = new Map(after.map((x) => [x.id, x]));
			for (const b of snapV) for (const f of VF) if (byId.has(b.id) && diff(num(b[f]), num(byId.get(b.id)[f]))) add(b.id_product, { field: `variant.${b.id}.${f}`, old: num(b[f]), new: num(byId.get(b.id)[f]) });
		}
		const batch = history.lazyBatch({ source: "base_change", user: idUser, title: `${B} → ${N}`, meta: { base: { from: B, to: N } } });
		for (const [pid, changes] of hist) await history.record("products", pid, { user: idUser, source: "base_change", action: "update", changes, meta: { base: { from: B, to: N } }, batch: await batch() });
	} catch (e) {
		console.error("[base_change] history", e.message);
	}

	try {
		// Довідник: курси відносно нової основної; стара основна — звичайна валюта з курсом 1/r
		const cur = await settings.get("currencies");
		const now = new Date().toISOString();
		const r8 = (x) => Math.round(x * 1e8) / 1e8;
		const list = cur.list
			.filter((c) => c.code !== N)
			.map((c) => ({ ...c, rate: r8(Number(c.rate) / r), applied_rate: null, applied_at: null, pending: false, suggested_rate: null, suggested_source: null, suggested_at: null, updated_at: now }));
		list.unshift({
			code: B,
			name: String(name || B).slice(0, 64),
			symbol: String(symbol || "").slice(0, 8),
			rate: r8(1 / r),
			correction: 0,
			threshold: 0,
			only_up: false,
			round,
			step: Number(step) > 0 ? Number(step) : 1,
			minus: Number(minus) > 0 ? Number(minus) : 0,
			apply: "auto",
			provider: n.provider || "manual",
			fallback: n.fallback || "",
			max_jump: Number(n.max_jump) || 0,
			active: true,
			updated_at: now,
		});
		const log = [{ code: N, rate: 1, prev: r, source: "base", at: now, user: idUser || null }, { code: B, rate: r8(1 / r), prev: null, source: "base", at: now, user: idUser || null }];
		// Старий журнал — у курси відносно нової основної (графік курсу без стрибка); записи N — тепер основна, лишаються як історія з позначкою
		const oldLog = (cur.log || []).map((x) =>
			x.code === N || x.source === "base" ? x : { ...x, rate: r8(Number(x.rate) / r), prev: x.prev === null || x.prev === undefined ? null : r8(Number(x.prev) / r) }
		);
		await settings.save("currencies", { ...cur, list, log: [...log, ...oldLog].slice(0, 500) }, idUser, { internal: true });
		await settings.save("prices", { ...(await settings.get("prices")), base_currency: N }, idUser, { internal: true });
	} finally {
		recalcBusy = false;
	}

	// Усі ціни — за новими курсами
	const result = await recalcCurrencies({ apply: true, idUser, source: "base_change", ignoreOnlyUp: true, withDeleted: true });
	info.recalculated = result;

	// Відв'язати ціни від старої валюти: вони стають звичайними цінами в N (уже перераховані з округленням B)
	if (mode === "convert") {
		const k = Math.round((1 / r) * 1e8) / 1e8;
		for (const [vf, pf, pairs] of [
			["price_currency", "price_currency", ["v.price_cur", "v.compare_cur"]],
			["cost_currency", "cost_currency", ["v.cost_cur"]],
		]) {
			await pool.query(`UPDATE ${P}products_variants v JOIN ${P}products p ON p.id = v.id_product SET ${pairs.map((c) => `${c} = NULL`).join(", ")}, v.${vf} = NULL WHERE COALESCE(NULLIF(v.${vf}, ''), p.${pf}) = ?`, [B]);
		}
		await pool.query(`UPDATE ${P}products_to_option_values ov JOIN ${P}products_to_options po ON po.id = ov.id_product_option JOIN ${P}products p ON p.id = po.id_product SET ov.price_cur = NULL, ov.price_currency = NULL WHERE COALESCE(NULLIF(ov.price_currency, ''), p.price_currency) = ?`, [B]);
		await pool.query(`UPDATE ${P}products_prices SET value_cur = NULL, currency = NULL WHERE currency = ?`, [B]);
		await pool.query(
			`UPDATE ${P}products_price_schedule SET currency = NULL, value = ROUND(value * ${k}, 4), old_price = ROUND(old_price * ${k}, 4), old_compare_at = ROUND(old_compare_at * ${k}, 4) WHERE currency = ? AND status IN ('pending', 'applied')`,
			[B]
		);
		for (const [cf, curs] of [
			["price_currency", ["price_cur", "compare_cur"]],
			["cost_currency", ["cost_cur"]],
			["wholesale_currency", ["wholesale_cur"]],
		]) {
			await pool.query(`UPDATE ${P}products SET ${curs.map((c) => `${c} = NULL`).join(", ")}, ${cf} = NULL WHERE ${cf} = ?`, [B]);
		}
	}
	// Усі товари — у повний автообмін (змінилась валюта всіх цін)
	await pool.query(`UPDATE ${P}products SET version = version + 1, date_edit = NOW() WHERE deleted_at IS NULL`);
	return info;
}

/** Запам'ятати курс, за яким перераховано (для порогу) і зняти позначку «чекає підтвердження» */
async function markApplied(codes, cx) {
	const cur = await settings.get("currencies");
	const now = new Date().toISOString();
	const list = cur.list.map((c) => (codes.includes(c.code) ? { ...c, applied_rate: cx.rate(c.code), applied_at: now, pending: false } : c));
	await settings.save("currencies", { ...cur, list }, null, { internal: true });
}

/**
 * Нові курси (вручну, від модуля, через API). items: [{ code, rate }]. Пише журнал і, якщо валюта
 * перераховується автоматично й зміна більша за поріг, — одразу перераховує ціни; інакше позначає «чекає підтвердження».
 */
async function setRates(items, { source = "manual", idUser = null, force = false } = {}) {
	const cur = await settings.get("currencies");
	const now = new Date().toISOString();
	const changed = [];
	const held = [];
	const log = [];
	const list = cur.list.map((c) => {
		const it = (items || []).find((x) => String(x && x.code).toUpperCase() === c.code);
		const rate = it ? Number(it.rate) : NaN;
		const src = String((it && it.source) || source).slice(0, 32);
		if (!(rate > 0)) return c;
		// Курс від модуля збігся з поточним — затриманий раніше стрибок уже неактуальний
		if (Math.abs(rate - Number(c.rate)) < 1e-9) return c.suggested_rate && src !== "manual" ? { ...c, suggested_rate: null, suggested_source: null, suggested_at: null } : c;
		// Захист від помилкового курсу: стрибок більший за max_jump — не застосовуємо, чекаємо підтвердження
		const jump = Number(c.rate) > 0 ? (Math.abs(rate - Number(c.rate)) / Number(c.rate)) * 100 : 0;
		if (!force && src !== "manual" && Number(c.max_jump) > 0 && jump > Number(c.max_jump)) {
			held.push(c.code);
			if (Number(c.suggested_rate) !== rate) log.push({ code: c.code, rate, prev: Number(c.rate), source: src, at: now, user: idUser || null, held: true });
			return { ...c, suggested_rate: rate, suggested_source: src, suggested_at: now };
		}
		changed.push(c.code);
		log.push({ code: c.code, rate, prev: Number(c.rate), source: src, at: now, user: idUser || null });
		return { ...c, rate, updated_at: now, suggested_rate: null, suggested_source: null, suggested_at: null };
	});
	if (!changed.length && !held.length) return { changed: [], held: [], recalculated: [], pending: [] };
	await settings.save("currencies", { ...cur, list, log: [...log, ...(cur.log || [])].slice(0, 500) }, idUser, { internal: true });
	if (!changed.length) return { changed: [], held, recalculated: [], pending: [] };
	return { ...(await afterRates(changed, { idUser })), held };
}

/** Прийняти курс, затриманий захистом від стрибка (або відхилити: accept = false) */
async function acceptSuggested(code, accept, idUser) {
	const cur = await settings.get("currencies");
	const c = cur.list.find((x) => x.code === code);
	if (!c || !c.suggested_rate) throw httpErr(404, "Nothing to accept");
	if (!accept) {
		await settings.save("currencies", { ...cur, list: cur.list.map((x) => (x.code === code ? { ...x, suggested_rate: null, suggested_source: null, suggested_at: null } : x)) }, idUser, { internal: true });
		return { changed: [], recalculated: [], pending: [] };
	}
	return setRates([{ code, rate: c.suggested_rate, source: c.suggested_source || "manual" }], { idUser, force: true });
}

/** Після зміни курсу (або налаштувань валюти): авто — перерахувати, якщо зміна ≥ порогу; підтвердження — позначити */
async function afterRates(codes, { idUser = null, force = false } = {}) {
	const cx = await currencyCtx();
	const auto = [];
	const pending = [];
	for (const code of codes) {
		const c = cx.byCode.get(code);
		if (!c) continue;
		const now = cx.rate(code);
		const was = Number(c.applied_rate) || 0;
		const diff = was > 0 ? (Math.abs(now - was) / was) * 100 : 100;
		if (!force && was > 0 && diff < (Number(c.threshold) || 0)) continue; // менше порогу — ціни не чіпаємо
		(c.apply === "confirm" && !force ? pending : auto).push(code);
	}
	if (pending.length) {
		const cur = await settings.get("currencies");
		await settings.save("currencies", { ...cur, list: cur.list.map((c) => (pending.includes(c.code) ? { ...c, pending: true } : c)) }, idUser, { internal: true });
	}
	let result = null;
	if (auto.length) result = await recalcCurrencies({ codes: auto, apply: true, idUser });
	return { changed: codes, recalculated: auto, pending, result };
}

/**
 * Зберегти довідник валют з налаштувань (службові поля — курс застосування, журнал — лишаються серверні).
 * Зміна курсу тут — ручне оновлення курсу (у журнал, перерахунок за правилами валюти).
 */
async function saveCurrencies(rawList, idUser, baseFormat) {
	const cur = await settings.get("currencies");
	const base = (await settings.get("prices")).base_currency;
	const prev = new Map(cur.list.map((c) => [c.code, c]));
	const list = (Array.isArray(rawList) ? rawList : []).map((c) => {
		const code = String((c && c.code) || "").toUpperCase();
		const p = prev.get(code) || {};
		return {
			...c,
			code,
			rate: Number(c && c.rate) > 0 ? Number(c.rate) : p.rate,
			applied_rate: p.applied_rate ?? null,
			applied_at: p.applied_at ?? null,
			pending: !!p.pending,
			updated_at: p.updated_at ?? null,
			suggested_rate: p.suggested_rate ?? null,
			suggested_source: p.suggested_source ?? null,
			suggested_at: p.suggested_at ?? null,
		};
	});
	const errors = [];
	list.forEach((c, i) => {
		if (!CUR_RE.test(c.code)) errors.push({ field: `list.${i}.code`, message: "3 letters" });
		if (c.code === base) errors.push({ field: `list.${i}.code`, message: "base currency" });
	});
	if (new Set(list.map((c) => c.code)).size !== list.length) errors.push({ field: "list", message: "duplicate code" });
	if (errors.length) throw httpErr(400, "Validation failed", errors);
	// Нові курси — окремо, через setRates (журнал + перерахунок)
	const rates = list.filter((c) => prev.has(c.code) && Math.abs(Number(c.rate) - Number(prev.get(c.code).rate)) > 1e-9).map((c) => ({ code: c.code, rate: c.rate }));
	const keepRates = list.map((c) => (prev.has(c.code) ? { ...c, rate: prev.get(c.code).rate } : { ...c, updated_at: new Date().toISOString() }));
	// Валюта, яку прибирають, а товари ще в ній — не можна
	const removed = [...prev.keys()].filter((code) => !list.some((c) => c.code === code));
	if (removed.length) {
		const [[u]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products WHERE deleted_at IS NULL AND (price_currency IN (?) OR cost_currency IN (?) OR wholesale_currency IN (?))`, [removed, removed, removed]);
		const [[o]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products_to_option_values WHERE price_currency IN (?)`, [removed]);
		const [[v]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products_variants WHERE price_currency IN (?) OR cost_currency IN (?)`, [removed, removed]);
		const [[pr]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products_prices WHERE currency IN (?)`, [removed]);
		const [[sc]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products_price_schedule WHERE currency IN (?) AND status IN ('pending', 'applied')`, [removed]);
		// Фіксовані ціни й правила ціни сайтів — JSON: шукаємо код валюти в тексті
		let fx = 0;
		let sites = 0;
		for (const code of removed) {
			const [[f]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products WHERE deleted_at IS NULL AND price_fixed LIKE ?`, [`%"${code}"%`]);
			const [[s]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}settings_integrations WHERE price_rule LIKE ?`, [`%"currency":"${code}"%`]);
			fx += Number(f.n);
			sites += Number(s.n);
		}
		const used = { products: Number(u.n), options: Number(o.n), variants: Number(v.n), price_rules: Number(pr.n), schedule: Number(sc.n), fixed: fx, sites };
		if (Object.values(used).some((n) => n > 0)) {
			throw httpErr(409, "Currency is in use", [
				{
					field: "list",
					message:
						`${removed.join(", ")}: ` +
						Object.entries(used)
							.filter(([, n]) => n)
							.map(([k, n]) => `${k} ${n}`)
							.join(", "),
				},
			]);
		}
	}
	await settings.save("currencies", { ...cur, list: keepRates, ...(baseFormat && typeof baseFormat === "object" ? { base_format: baseFormat } : {}) }, idUser, { internal: true });
	// Змінились корекція / округлення — ціни теж треба перерахувати (за правилами валюти)
	const ruleChanged = list
		.filter((c) => prev.has(c.code))
		.filter((c) => ["correction", "round", "step", "minus"].some((k) => String(c[k] ?? "") !== String(prev.get(c.code)[k] ?? "")))
		.map((c) => c.code);
	const r = rates.length ? await setRates(rates, { source: "manual", idUser }) : { changed: [], recalculated: [], pending: [] };
	const extra = ruleChanged.filter((c) => !r.changed.includes(c));
	if (extra.length) {
		const r2 = await afterRates(extra, { idUser, force: false });
		r.recalculated = [...(r.recalculated || []), ...r2.recalculated];
		r.pending = [...(r.pending || []), ...r2.pending];
	}
	return { currencies: await settings.get("currencies"), ...r };
}

/* ═══ ЦІНА ЗА ФОРМУЛОЮ: собівартість × (1 + націнка %) ═══════════════════ */

/** Для товарів: бренд, постачальник, категорії з усіма предками — Map(id → info) */
async function formulaInfo(db, rows) {
	const out = new Map(rows.map((r) => [Number(r.id), { brand: Number(r.id_brand) || 0, supplier: Number(r.id_supplier) || 0, cats: new Set((r.categories || []).map(Number)) }]));
	const ids = rows
		.filter((r) => !r.categories)
		.map((r) => Number(r.id))
		.filter((id) => id > 0);
	if (ids.length) {
		const [pc] = await db.query(`SELECT id_product, id_category FROM ${P}products_to_categories WHERE id_product IN (?)`, [ids]);
		pc.forEach((r) => out.get(Number(r.id_product)) && out.get(Number(r.id_product)).cats.add(Number(r.id_category)));
	}
	const cats = [...new Set([].concat(...[...out.values()].map((i) => [...i.cats])))];
	if (cats.length) {
		const [paths] = await db.query(`SELECT id_category, id_ancestor FROM ${P}products_categories_path WHERE id_category IN (?)`, [cats]);
		const anc = new Map();
		paths.forEach((r) => (anc.get(Number(r.id_category)) || anc.set(Number(r.id_category), new Set()).get(Number(r.id_category))).add(Number(r.id_ancestor)));
		for (const i of out.values()) for (const c of [...i.cats]) (anc.get(c) || []).forEach((a) => i.cats.add(a));
	}
	return out;
}

/** Націнка товару: перше правило, що підійшло (усі задані умови мають збігтися), інакше — за замовчуванням */
function formulaMarkup(f, info) {
	for (const r of f.rules || []) {
		if (r.brands.length && !r.brands.includes(info.brand)) continue;
		if (r.suppliers.length && !r.suppliers.includes(info.supplier)) continue;
		if (r.categories.length && !r.categories.some((c) => info.cats.has(c))) continue;
		return Number(r.markup);
	}
	return f.default_markup === null || f.default_markup === undefined ? null : Number(f.default_markup);
}

/** { price, compare } за формулою або null (немає собівартості чи націнки) */
function formulaPrice(cost, f, info) {
	if (!(Number(cost) > 0) || !info) return null;
	const m = formulaMarkup(f, info);
	if (m === null) return null;
	const price = roundMoney(Number(cost) * (1 + m / 100), f);
	const compare = f.compare_markup ? roundMoney(price * (1 + Number(f.compare_markup) / 100), f) : undefined;
	return { price, compare: compare !== undefined && compare > price ? compare : undefined, markup: m };
}

/**
 * Варіанти товарів «за формулою»: варіант із власною собівартістю й price_auto = 1 отримує фіксовану ціну
 * за тією ж формулою, що й товар (націнка за брендом / категорією / постачальником товару). Без власної собівартості —
 * варіант не чіпаємо (ціна як у товару ± надбавка). Повертає кількість змінених варіантів.
 */
async function formulaVariants(db, productIds, { apply = true, f = null, info = null, record = true, idUser = null, source = "formula", collect = null, batch = null } = {}) {
	if (!productIds || !productIds.length) return 0;
	f = f || (await settings.get("price_formula"));
	const [vs] = await db.query(
		`SELECT v.id, v.id_product, v.price_mode, v.price, v.compare_at_price, v.cost_price, v.price_currency
		   FROM ${P}products_variants v JOIN ${P}products p ON p.id = v.id_product
		  WHERE v.id_product IN (?) AND p.price_auto = 1 AND v.price_auto = 1 AND v.cost_price > 0`,
		[productIds]
	);
	if (!vs.length) return 0;
	if (!info) {
		const [ps] = await db.query(`SELECT id, id_brand, id_supplier FROM ${P}products WHERE id IN (?)`, [[...new Set(vs.map((v) => v.id_product))]]);
		info = await formulaInfo(db, ps);
	}
	let n = 0;
	const touched = new Set();
	const hist = new Map();
	for (const v of vs) {
		const fp = formulaPrice(v.cost_price, f, info.get(Number(v.id_product)));
		if (!fp) continue;
		const compare = fp.compare !== undefined ? fp.compare : v.compare_at_price !== null && Number(v.compare_at_price) > fp.price ? Number(v.compare_at_price) : null;
		if (v.price_mode === "fixed" && Math.abs(Number(v.price) - fp.price) <= EPS && !v.price_currency && Math.abs(Number(v.compare_at_price || 0) - Number(compare || 0)) <= EPS) continue;
		n++;
		if (!apply) continue;
		await db.query(`UPDATE ${P}products_variants SET price_mode = 'fixed', price = ?, compare_at_price = ?, price_currency = NULL, price_cur = NULL, compare_cur = NULL WHERE id = ?`, [fp.price, compare, v.id]);
		touched.add(v.id_product);
		const list = hist.get(v.id_product) || hist.set(v.id_product, []).get(v.id_product);
		if (Math.abs(Number(v.price) - fp.price) > EPS) list.push({ field: `variant.${v.id}.price`, old: Number(v.price), new: fp.price });
		if (Math.abs(Number(v.compare_at_price || 0) - Number(compare || 0)) > EPS) list.push({ field: `variant.${v.id}.compare_at_price`, old: v.compare_at_price === null ? null : Number(v.compare_at_price), new: compare });
	}
	if (touched.size) await db.query(`UPDATE ${P}products SET version = version + 1, date_edit = NOW() WHERE id IN (?)`, [[...touched]]);
	if (collect) for (const changes of hist.values()) collect.push(...changes);
	if (record) for (const [pid, changes] of hist) if (changes.length) await history.record("products", pid, { user: idUser, source, action: "update", changes, meta: { formula: true }, batch: batch ? await batch() : undefined });
	return n;
}

/**
 * Перерахунок цін товарів «за формулою» (усіх або ids). apply = false — попередній перегляд.
 * Ціна за формулою — у базовій валюті (валюта ціни знімається), собівартість — уже в базовій (з урахуванням курсу її валюти).
 */
async function recalcFormula({ ids = null, apply = false, idUser = null, source = "formula", batch: outerBatch = null } = {}) {
	const f = await settings.get("price_formula");
	const out = { products: 0, variants: 0, up: 0, down: 0, no_cost: 0, no_markup: 0, sample: [] };
	const batch = outerBatch || history.lazyBatch({ source, user: idUser, meta: { formula: true } });
	for (let after = 0; ; ) {
		const [rows] = await pool.query(
			`SELECT id, price, compare_at_price, cost_price, id_brand, id_supplier, price_currency FROM ${P}products
			  WHERE id > ? AND deleted_at IS NULL AND price_auto = 1${ids ? " AND id IN (?)" : ""} ORDER BY id LIMIT 500`,
			ids ? [after, ids] : [after]
		);
		if (!rows.length) break;
		after = rows[rows.length - 1].id;
		const info = await formulaInfo(pool, rows);
		// Варіанти з власною собівартістю — за тією ж формулою (навіть якщо в самого товару собівартості немає)
		out.variants += await formulaVariants(pool, rows.map((r) => r.id), { apply, f, info, idUser, source, batch });
		for (const r of rows) {
			if (!(Number(r.cost_price) > 0)) {
				out.no_cost++;
				continue;
			}
			const fp = formulaPrice(r.cost_price, f, info.get(Number(r.id)));
			if (!fp) {
				out.no_markup++;
				continue;
			}
			const set = {};
			if (Math.abs(fp.price - Number(r.price)) > EPS) set.price = fp.price;
			if (fp.compare !== undefined && Math.abs(fp.compare - Number(r.compare_at_price || 0)) > EPS) set.compare_at_price = fp.compare;
			else if (fp.compare === undefined && r.compare_at_price !== null && Number(r.compare_at_price) <= fp.price) set.compare_at_price = null;
			if (r.price_currency) Object.assign(set, { price_currency: null, price_cur: null, compare_cur: null });
			if (!Object.keys(set).length) continue;
			out.products++;
			if (set.price !== undefined) set.price > Number(r.price) ? out.up++ : out.down++;
			if (out.sample.length < 200) out.sample.push({ id: r.id, changes: ["price", "compare_at_price"].filter((k) => k in set).map((k) => ({ field: k, old: r[k] === null ? null : Number(r[k]), new: set[k] })) });
			if (apply) {
				const keys = Object.keys(set);
				await pool.query(`UPDATE ${P}products SET ${keys.map((k) => `${k} = ?`).join(", ")}, version = version + 1, date_edit = NOW() WHERE id = ?`, [...keys.map((k) => set[k]), r.id]);
				await history.record("products", r.id, {
					user: idUser,
					source,
					action: "update",
					changes: ["price", "compare_at_price"].filter((k) => k in set).map((k) => ({ field: k, old: r[k] === null ? null : Number(r[k]), new: set[k] })),
					meta: { formula: true },
					batch: await batch(),
				});
			}
		}
	}
	return out;
}

/** Крон: курси від модулів (provider ≠ manual) */
// Останнє звернення до кожного джерела: { at, ok, error, rates: { code: rate } }
const providerStatus = new Map();

/** Запитати курси в джерела (без застосування). Повертає Map(code → rate) */
async function fetchProvider(key, codes, base) {
	const p = providers.get(key);
	if (!p) throw httpErr(404, "Unknown provider");
	try {
		const rows = await p.fetch(codes, base);
		const m = new Map((rows || []).map((r) => [String(r.code).toUpperCase(), Number(r.rate)]).filter(([c, r]) => codes.includes(c) && r > 0));
		providerStatus.set(key, { at: new Date().toISOString(), ok: true, error: null, rates: Object.fromEntries(m) });
		return m;
	} catch (e) {
		providerStatus.set(key, { at: new Date().toISOString(), ok: false, error: String(e.message || e), rates: {} });
		throw e;
	}
}

/** Джерела з останнім станом — для вкладки «Валюти» */
function providersOverview() {
	return [...providers].map(([key, d]) => ({ key, name: d.name, status: providerStatus.get(key) || null }));
}

/** «Перевірити»: курси джерела для всіх валют довідника, поруч із поточними — нічого не застосовує */
async function testProvider(key) {
	const cur = await settings.get("currencies");
	const base = (await settings.get("prices")).base_currency;
	const codes = cur.list.map((c) => c.code);
	const m = await fetchProvider(key, codes, base);
	return cur.list.map((c) => ({ code: c.code, current: Number(c.rate), rate: m.get(c.code) || null }));
}

/**
 * Крон / кнопка «Оновити курси зараз»: курси від модулів. Кожне джерело питаємо один раз;
 * для валюти беремо основне джерело, а якщо воно не відповіло чи не має цієї валюти — резервне.
 */
async function runProviders() {
	const cur = await settings.get("currencies");
	const base = (await settings.get("prices")).base_currency;
	const chain = (c) => [c.provider, c.fallback].filter((k, i, a) => k && k !== "manual" && providers.has(k) && a.indexOf(k) === i);
	const need = new Map();
	for (const c of cur.list) for (const k of chain(c)) (need.get(k) || need.set(k, new Set()).get(k)).add(c.code);
	if (!need.size) return { providers: {}, changed: [], held: [], recalculated: [], pending: [], none: true };

	const fetched = new Map();
	for (const [k, codes] of need) {
		try {
			fetched.set(k, await fetchProvider(k, [...codes], base));
		} catch (e) {
			fetched.set(k, null);
			console.error("[currency]", k, e.message || e);
		}
	}
	const items = [];
	const fallbackUsed = [];
	for (const c of cur.list) {
		const ks = chain(c);
		const k = ks.find((x) => fetched.get(x) && fetched.get(x).get(c.code) > 0);
		if (!k) continue;
		items.push({ code: c.code, rate: fetched.get(k).get(c.code), source: k });
		if (k !== ks[0]) fallbackUsed.push(c.code);
	}
	const r = items.length ? await setRates(items, { source: "provider" }) : { changed: [], held: [], recalculated: [], pending: [] };
	return { providers: Object.fromEntries([...need.keys()].map((k) => [k, providerStatus.get(k) || null])), fallback: fallbackUsed, ...r };
}

module.exports = {
	resolve,
	listSchedule,
	createSchedule,
	cancelSchedule,
	runDue,
	registerProvider,
	unregisterProvider,
	providerList,
	providersOverview,
	testProvider,
	acceptSuggested,
	changeBase,
	PRODUCT_CUR,
	currencyCtx,
	roundMoney,
	convertCore,
	convertOptions,
	recalcCurrencies,
	setRates,
	afterRates,
	saveCurrencies,
	runProviders,
	formulaInfo,
	formulaPrice,
	formulaVariants,
	recalcFormula,
};
