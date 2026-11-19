"use strict";

/**
 * Масова зміна залишків — через звичайні складські документи (а не напряму в таблицю залишків):
 *   «встановити кількість» → документ інвентаризації, «додати / відняти» → документ коригування.
 * Кожні DOC_PRODUCTS товарів — один документ (рядок на товар або на кожен варіант), проводиться звичайним проведенням:
 * рухи, партії, журнал руху — усе як при ручному документі. Відміна масової зміни скасовує ці документи
 * (сторнування рухів у зворотному порядку): продажі між зміною й відміною не губляться.
 *
 * Документи зміни знаходяться за зовнішнім номером BULK-<зміна>-<перший товар кроку>[-pN] — окрема колонка
 * не потрібна, і після падіння сервера вже проведений документ не створиться вдруге.
 */

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const logging = require("../../../logging/logging");
const settings = require("./settings");
const docs = require("./stock-documents");

const P = config.get("configDatabase").prefix;
const DOC_PRODUCTS = 100; // товарів на документ
const DOC_LINES = 5000; // рядків на документ (межа складського документа)
const REF = "stock_document";

const httpErr = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});
const milli = (v) => Math.round(Number(v || 0) * 1000);
const num = (m) => m / 1000;
const prefix = (idJob) => `BULK-${Number(idJob)}-`;
const today = () => new Date().toISOString().slice(0, 10);
// Колонки JSON приходять з бази вже об'єктами, текстові — рядками
const parse = (v, def) => {
	if (v === null || v === undefined) return def;
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return def;
	}
};

/** Дія залишків у зміні (вона там завжди одна — перевіряє валідатор) */
const stockOp = (ops) => (ops && ops.length === 1 && ops[0].action === "stock" ? ops[0] : null);

/** Права й склад: запуск — право проводити документи, склад існує. Повертає контекст для обробки */
async function prepare(params, ctx) {
	if (!ctx.perms || !ctx.perms.stockEdit) throw httpErr(403, "Forbidden");
	const [[wh]] = await pool.query(`SELECT id, code, name, allow_negative FROM ${P}products_warehouses WHERE id = ? AND deleted_at IS NULL`, [params.id_warehouse]);
	if (!wh) throw httpErr(400, "Warehouse not found", { errors: [{ field: "params.id_warehouse", message: "not found" }] });
	const cfg = await settings.get("stock");
	return { wh, negativeOk: !!cfg.allow_negative || Number(wh.allow_negative) === 1 };
}

/**
 * Рядки для набору товарів: на простий товар — один (варіант 0), на варіативний — по рядку на кожен варіант.
 * exclude — пари «товар:варіант», уже проведені документами цього кроку (після перезапуску не повторюються).
 * Повертає по товару: { id, status: changed | unchanged | skipped | error, message, lines: [{ id_variant, sku, old, next, qty }] }
 */
async function plan(ids, params, sc, exclude) {
	if (!ids.length) return [];
	const [products] = await pool.query(`SELECT id, type FROM ${P}products WHERE id IN (?) AND deleted_at IS NULL`, [ids]);
	const byId = new Map(products.map((p) => [Number(p.id), p]));
	const variable = products.filter((p) => p.type === "variable").map((p) => p.id);
	const [variants] = variable.length ? await pool.query(`SELECT id, id_product, sku FROM ${P}products_variants WHERE id_product IN (?) ORDER BY id_product, id`, [variable]) : [[]];
	const [stock] = await pool.query(`SELECT id_product, id_variant, on_hand FROM ${P}products_stock WHERE id_warehouse = ? AND id_product IN (?)`, [sc.wh.id, ids]);
	const onHand = new Map(stock.map((s) => [`${s.id_product}:${s.id_variant}`, milli(s.on_hand)]));
	const vars = new Map();
	for (const v of variants) {
		if (!vars.has(Number(v.id_product))) vars.set(Number(v.id_product), []);
		vars.get(Number(v.id_product)).push(v);
	}
	const q = milli(params.qty);
	return ids.map((id) => {
		const p = byId.get(Number(id));
		if (!p) return { id, status: "error", message: "not_found", lines: [] };
		const slots = p.type === "variable" ? (vars.get(Number(id)) || []).map((v) => ({ id_variant: Number(v.id), sku: v.sku })) : [{ id_variant: 0, sku: null }];
		if (!slots.length) return { id, status: "skipped", message: "no_variants", lines: [] };
		const lines = [];
		let done = 0;
		let blocked = 0;
		for (const s of slots) {
			const key = `${id}:${s.id_variant}`;
			if (exclude && exclude.has(key)) {
				done++;
				continue;
			}
			const old = onHand.get(key) || 0;
			const next = params.op === "set" ? q : old + q;
			if (next === old) continue;
			if (next < 0 && !sc.negativeOk) {
				blocked++;
				continue;
			}
			lines.push({ ...s, old: num(old), next: num(next), qty: params.op === "set" ? num(next) : num(q) });
		}
		if (lines.length || done) return { id, status: "changed", lines, partial: blocked };
		if (blocked) return { id, status: "skipped", message: "insufficient", lines: [] };
		return { id, status: "unchanged", lines: [] };
	});
}

/** Перегляд «було → стане» для перших товарів набору */
async function preview(ids, params, ctx) {
	const sc = await prepare(params, ctx);
	const rows = await plan(ids, params, sc, null);
	return rows.map((r) => ({
		id: r.id,
		status: r.status,
		message: r.message,
		changes: r.lines.map((l) => ({ field: "stock", label: sc.wh.name + (l.id_variant ? ` · ${l.sku || "#" + l.id_variant}` : ""), old: l.old, new: l.next })),
	}));
}

/** Документи кроку, створені раніше (до падіння): проведені — їхні рядки вже враховано; чернетки — прибираються */
async function earlier(ext) {
	const [rows] = await pool.query(`SELECT id, status, version FROM ${P}products_stock_documents WHERE external_number = ? OR external_number LIKE ?`, [ext, ext + "-p%"]);
	const posted = rows.filter((d) => d.status === "posted");
	for (const d of rows.filter((x) => x.status === "draft")) await docs.removeDraft(d.id).catch((e) => logging.error(e));
	const exclude = new Set();
	if (posted.length) {
		const [items] = await pool.query(`SELECT id_product, id_variant FROM ${P}products_stock_documents_items WHERE id_document IN (?)`, [posted.map((d) => d.id)]);
		items.forEach((i) => exclude.add(`${i.id_product}:${i.id_variant}`));
	}
	return { exclude, parts: rows.length };
}

/**
 * Обробка зміни залишків. hooks: { saveCursor(processed), step(processed) → чи попросили зупинитись }.
 * Курсор (processed) зсувається лише після проведення документів кроку.
 */
async function run(j, state, hooks) {
	const ids = parse(j.ids, []).map(Number);
	const op = stockOp(parse(j.operations, []));
	const params = op.params;
	const ctx = { idUser: Number(j.id_user), perms: parse(j.perms, {}) };
	const sc = await prepare(params, ctx);
	const type = params.op === "set" ? "inventory" : "adjustment";
	const comment = String(j.title || `#${j.id}`).slice(0, 200);

	for (let start = Number(j.processed); start < ids.length; start += DOC_PRODUCTS) {
		const chunk = ids.slice(start, start + DOC_PRODUCTS);
		const ext = `${prefix(j.id)}${start}`;
		const prev = await earlier(ext);
		const rows = await plan(chunk, params, sc, prev.exclude);
		const items = rows.flatMap((r) => r.lines.map((l) => ({ id_product: r.id, id_variant: l.id_variant, qty: l.qty })));

		// Документи кроку (більше DOC_LINES рядків — кілька частин); помилка проведення — помилка всіх товарів документа
		const failed = new Map();
		for (let k = 0, part = prev.parts; k < items.length; k += DOC_LINES, part++) {
			const lines = items.slice(k, k + DOC_LINES);
			let id = null;
			try {
				const d = await docs.saveDraft(null, { header: { type, id_warehouse: sc.wh.id, date_document: today(), external_number: part ? `${ext}-p${part + 1}` : ext, comment }, items: lines }, { idUser: ctx.idUser, perms: { cost: false } });
				id = d.id;
				await docs.post(d.id, { version: d.version }, { idUser: ctx.idUser });
			} catch (e) {
				if (!e.status) logging.error(e);
				if (id) await docs.removeDraft(id).catch((x) => logging.error(x));
				const msg = e.status === 409 && /insufficient/i.test(e.message) ? "insufficient" : e.status ? "doc_failed" : "server_error";
				lines.forEach((l) => failed.set(l.id_product, msg));
			}
		}

		for (const r of rows) {
			if (failed.has(r.id)) {
				state.c.errors++;
				state.report.push({ id: r.id, status: "error", message: failed.get(r.id) });
			} else if (r.status === "changed") {
				state.c.changed++;
				if (r.partial) {
					state.c.skipped++;
					state.report.push({ id: r.id, status: "skipped", message: "insufficient_partial" });
				}
			} else {
				state.c[r.status === "error" ? "errors" : r.status]++;
				if (r.message) state.report.push({ id: r.id, status: r.status, message: r.message });
			}
		}
		const processed = Math.min(ids.length, start + DOC_PRODUCTS);
		await hooks.saveCursor(processed);
		if (await hooks.step(processed)) return "cancelled";
	}
	return "done";
}

/** Документи зміни (проведені й уже скасовані) — від останнього до першого */
async function documents(idJob) {
	const [rows] = await pool.query(
		`SELECT id, number, status, version, type, (SELECT COUNT(*) FROM ${P}products_stock_documents_items i WHERE i.id_document = d.id) AS lines_count
		   FROM ${P}products_stock_documents d
		  WHERE external_number LIKE ? AND status IN ('posted', 'cancelled')
		  ORDER BY id DESC`,
		[prefix(idJob) + "%"]
	);
	return rows;
}

/** Відміна: документи скасовуються по одному, від останнього; уже скасований (вручну) — пропуск */
async function revert(j, src, state, hooks) {
	if (!parse(j.perms, {}).stockDelete) throw new Error("No permission to cancel stock documents");
	const list = await documents(src.id);
	const idUser = Number(j.id_user);
	for (let i = Number(j.processed); i < list.length; i++) {
		const d = list[i];
		const [[cur]] = await pool.query(`SELECT status, version FROM ${P}products_stock_documents WHERE id = ?`, [d.id]);
		const [[first]] = await pool.query(`SELECT MIN(id_product) AS id FROM ${P}products_stock_documents_items WHERE id_document = ?`, [d.id]);
		const pid = first ? first.id : 0;
		if (!cur || cur.status !== "posted") {
			state.c.skipped++;
			state.report.push({ id: pid, status: "skipped", message: "doc_already_cancelled", fields: [d.number] });
		} else {
			try {
				await docs.cancel(d.id, { version: cur.version }, { idUser });
				state.c.changed++;
			} catch (e) {
				if (!e.status) logging.error(e);
				state.c.errors++;
				state.report.push({ id: pid, status: "error", message: e.status === 409 && /insufficient/i.test(e.message) ? "doc_cancel_insufficient" : "doc_cancel_failed", fields: [d.number] });
			}
		}
		await hooks.saveCursor(i + 1);
		if (await hooks.step(i + 1)) return "cancelled";
	}
	return "done";
}

/** Рядки «було → стало» для Excel: рухи проведення документів зміни (без сторнування), порціями */
async function* movements(idJob) {
	let after = 0;
	for (;;) {
		const [rows] = await pool.query(
			`SELECT m.id, m.id_product, m.id_variant, m.qty_before, m.qty_after, d.number, w.name AS warehouse, v.sku AS variant_sku
			   FROM ${P}products_stock_movements m
			   JOIN ${P}products_stock_documents d ON d.id = m.ref_id
			   JOIN ${P}products_warehouses w ON w.id = m.id_warehouse
			   LEFT JOIN ${P}products_variants v ON v.id = m.id_variant
			  WHERE m.ref_type = ? AND d.external_number LIKE ? AND (m.comment IS NULL OR m.comment NOT LIKE 'REVERSAL%') AND m.id > ?
			  ORDER BY m.id LIMIT 500`,
			[REF, prefix(idJob) + "%", after]
		);
		if (!rows.length) return;
		yield rows;
		after = rows[rows.length - 1].id;
	}
}

module.exports = { stockOp, prepare, preview, run, revert, documents, movements, DOC_PRODUCTS };