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

	const ranked = rules
		.map((r) => ({ ...r, result: round4(applyRule(base, r)) }))
		.sort(
			(a, b) =>
				(b.id_variant ? 1 : 0) - (a.id_variant ? 1 : 0) ||
				(b.id_customer_group ? 1 : 0) - (a.id_customer_group ? 1 : 0) ||
				a.priority - b.priority ||
				Number(b.min_qty) - Number(a.min_qty) ||
				a.result - b.result
		);

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
	const [[p]] = await pool.query(`SELECT id FROM ${P}products WHERE id = ? AND deleted_at IS NULL`, [idProduct]);
	if (!p) throw httpErr(404, "Not found");
	const [r] = await pool.query(
		`INSERT INTO ${P}products_price_schedule (id_product, id_variant, field, value, set_compare_at, run_at, revert_at, comment, id_user)
		 VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)`,
		[idProduct, d.field, d.value, Number(d.set_compare_at), d.run_at, d.revert_at, d.comment, ctx.idUser]
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
	const [[p]] = await conn.query(`SELECT id, price, compare_at_price FROM ${P}products WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [job.id_product]);
	if (!p) {
		await conn.query(`UPDATE ${P}products_price_schedule SET status = 'failed', error = 'product not found', revert_at = NULL WHERE id = ?`, [job.id]);
		return null;
	}
	const price = Number(p.price);
	const cmp = p.compare_at_price === null ? null : Number(p.compare_at_price);
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

	const keys = Object.keys(set);
	await conn.query(`UPDATE ${P}products SET ${keys.map((k) => `${k} = ?`).join(", ")}, version = version + 1, id_user_edit = ? WHERE id = ?`, [...keys.map((k) => set[k]), job.id_user, job.id_product]);
	const before = { price, compare_at_price: cmp };
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

module.exports = { resolve, listSchedule, createSchedule, cancelSchedule, runDue };