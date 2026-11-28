"use strict";

/**
 * Виписка Monobank: усі платежі мерчанта (посилання системи, QR-каси, оплати з інших джерел).
 *  - sync(): завантаження за розкладом шматками до 31 дня, з перекриттям останніх днів (холд → успіх, повернення).
 *  - Прив'язка до замовлень: посилання системи — за invoiceId; інші — автоматично за номером замовлення
 *    в reference / призначенні та точною сумою, або вручну. Прив'язаний платіж стає рахунком замовлення
 *    (джерело statement): видно в картці, рахується в сплаченому, з нього можна повернути кошти.
 *  - Звірка: неприв'язані платежі, сплачені посилання без запису у виписці, розбіжності стану й суми.
 *  - Звіт: надходження, повернення, комісія, конверсія посилань.
 */
const { pool, P, T, httpErr, str, toMinor, fromMinor, CCY_ISO } = require("./common");
const accounts = require("./accounts");
const api = require("./api");
const invoices = require("./invoices");
const { notify } = require("../../../controllers/notifications/notify");
const i18n = require("../../../config/i18n/i18n");

const CHUNK_DAYS = 31;
const DAY = 24 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dt = (v) => {
	const d = v ? new Date(v) : null;
	return d && !isNaN(d.getTime()) ? d : null;
};
const STATUSES = ["hold", "processing", "success", "failure"];

let running = false;
let cfg = { initialDays: 90, overlapDays: 3 };
const configure = (c) => {
	cfg = { initialDays: Math.max(1, Number(c.statement_initial_days) || 90), overlapDays: Math.max(1, Number(c.statement_overlap_days) || 3) };
};

/* ───────────────────────── Завантаження ───────────────────────── */

async function upsert(acc, items) {
	let n = 0;
	for (const r of items) {
		if (!r || !r.invoiceId) continue;
		const cancels = Array.isArray(r.cancelList) ? r.cancelList : [];
		const refunded = cancels.reduce((s, c) => s + (Number(c.amount) || 0), 0);
		const date = dt(r.date) || new Date();
		await pool.query(
			`INSERT INTO ${T.statement}
			   (id_account, invoice_id, status, date, amount, refunded, profit_amount, ccy, masked_pan, reference, destination, approval_code, rrn, payment_scheme, short_qr_id, cancel_list, date_add, date_edit)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW()) AS n
			 ON DUPLICATE KEY UPDATE status = n.status, date = n.date, amount = n.amount, refunded = n.refunded, profit_amount = n.profit_amount,
			   masked_pan = n.masked_pan, reference = n.reference, destination = n.destination, approval_code = n.approval_code, rrn = n.rrn,
			   payment_scheme = n.payment_scheme, short_qr_id = n.short_qr_id, cancel_list = n.cancel_list, date_edit = NOW()`,
			[
				acc.id,
				String(r.invoiceId).slice(0, 64),
				STATUSES.includes(r.status) ? r.status : String(r.status || "").slice(0, 16),
				date,
				Number(r.amount) || 0,
				refunded,
				Number.isFinite(Number(r.profitAmount)) ? Number(r.profitAmount) : null,
				Number(r.ccy) || 980,
				str(r.maskedPan, 32),
				str(r.reference, 255),
				str(r.destination, 512),
				str(r.approvalCode, 32),
				str(r.rrn, 64),
				str(r.paymentScheme, 32),
				str(r.shortQrId, 32),
				cancels.length ? JSON.stringify(cancels) : null,
			]
		);
		n++;
	}
	return n;
}

async function setSync(idAccount, fields) {
	const keys = Object.keys(fields);
	await pool.query(
		`INSERT INTO ${T.sync} (id_account, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")}) AS n
		 ON DUPLICATE KEY UPDATE ${keys.map((k) => `${k} = n.${k}`).join(", ")}`,
		[idAccount, ...keys.map((k) => fields[k])]
	);
}

/** Один акаунт: від останньої завантаженої дати (мінус перекриття) до зараз, шматками по 31 день */
async function syncAccount(acc) {
	const [[st]] = await pool.query(`SELECT * FROM ${T.sync} WHERE id_account = ?`, [acc.id]);
	const now = Date.now();
	let from = st && st.synced_to ? new Date(st.synced_to).getTime() - cfg.overlapDays * DAY : now - cfg.initialDays * DAY;
	const firstFrom = st && st.synced_from ? Math.min(new Date(st.synced_from).getTime(), from) : from;
	await setSync(acc.id, { started_at: new Date(), message: null });
	let total = 0;
	try {
		while (from < now) {
			const to = Math.min(now, from + CHUNK_DAYS * DAY);
			const r = await api.statement(acc.token, from / 1000, to / 1000);
			total += await upsert(acc, Array.isArray(r.list) ? r.list : []);
			await setSync(acc.id, { synced_from: new Date(firstFrom), synced_to: new Date(to), total });
			from = to;
			if (from < now) await sleep(1500);
		}
		await setSync(acc.id, { finished_at: new Date(), total, message: null });
	} catch (e) {
		await setSync(acc.id, { finished_at: new Date(), total, message: String(e.vars && e.vars.msg ? e.vars.msg : e.message).slice(0, 1000) });
		throw e;
	}
	return total;
}

/** Усі активні акаунти. Повторний запуск, поки йде попередній, — пропускається */
async function sync() {
	if (running) return { running: true };
	running = true;
	let total = 0;
	try {
		const [rows] = await pool.query(`SELECT id FROM ${T.accounts} WHERE status = 1 ORDER BY id`);
		for (const r of rows) {
			try {
				total += await syncAccount(await accounts.withToken(r.id));
			} catch (e) {
				console.error(`[monobank] statement account #${r.id}:`, e.message);
			}
		}
		await matchAll();
	} finally {
		running = false;
	}
	return { total };
}

/** Запуск у фоні (кнопка на сторінці): відповідь одразу, стан — через state() */
function syncInBackground() {
	if (running) return { started: false, running: true };
	sync().catch((e) => console.error("[monobank] statement:", e.message));
	return { started: true };
}

/* ───────────────────────── Прив'язка до замовлень ───────────────────────── */

/** Номери замовлень, згадані в reference / призначенні платежу */
function tokens(row) {
	const text = `${row.reference || ""} ${row.destination || ""}`;
	return [...new Set((text.match(/[A-Za-z0-9][A-Za-z0-9_-]{2,40}/g) || []).map((x) => x.replace(/[-_]+$/, "")))].slice(0, 20);
}

/**
 * Неприв'язані рядки: спершу — посилання системи (invoiceId), далі — автоматично,
 * якщо рівно одне замовлення має згаданий номер і точно таку суму (усю чи залишок до сплати).
 */
async function matchAll() {
	// Посилання системи
	await pool.query(
		`UPDATE ${T.statement} s JOIN ${T.invoices} i ON i.invoice_id = s.invoice_id AND i.id_account = s.id_account
		    SET s.id_order = i.id_order, s.id_invoice = i.id, s.match_type = 'invoice', s.date_edit = NOW()
		  WHERE s.match_type IS NULL`
	);
	const [rows] = await pool.query(`SELECT * FROM ${T.statement} WHERE match_type IS NULL AND status IN ('success', 'hold') ORDER BY id LIMIT 500`);
	let matched = 0;
	for (const row of rows) {
		const tk = tokens(row);
		if (!tk.length) continue;
		const [orders] = await pool.query(`SELECT id, reference, total FROM ${P}orders WHERE deleted_at IS NULL AND (reference IN (?) OR CAST(id AS CHAR) IN (?))`, [tk, tk]);
		const fit = [];
		for (const o of orders) {
			const [[paid]] = await pool.query(`SELECT COALESCE(SUM(COALESCE(final_amount, amount)), 0) AS s FROM ${T.invoices} WHERE id_order = ? AND status = 'success'`, [o.id]);
			const total = toMinor(o.total);
			if (Number(row.amount) === total || Number(row.amount) === total - Number(paid.s)) fit.push(o);
		}
		if (fit.length !== 1) continue;
		try {
			await attachRow(row.id, fit[0].id, null, "auto");
			matched++;
		} catch (e) {
			console.error(`[monobank] auto-match ${row.invoice_id}:`, e.message);
		}
	}
	return matched;
}

/** Знайти замовлення за номером (reference) або id */
async function findOrder(q) {
	const v = String(q || "").trim().replace(/^#/, "");
	if (!v) throw httpErr(400, "modules.monobank.e.order_not_found");
	const [rows] = await pool.query(`SELECT id FROM ${P}orders WHERE deleted_at IS NULL AND (reference = ? OR id = ?) ORDER BY reference = ? DESC LIMIT 2`, [v, /^\d+$/.test(v) ? Number(v) : 0, v]);
	if (!rows.length) throw httpErr(404, "modules.monobank.e.order_not_found");
	return Number(rows[0].id);
}

/**
 * Прив'язати рядок виписки до замовлення: створюється рахунок замовлення (джерело statement)
 * і застосовується стан платежу — статус замовлення, журнал, сповіщення — як для посилання системи.
 */
async function attachRow(idRow, idOrder, idUser, type) {
	const conn = await pool.getConnection();
	let idInvoice;
	try {
		await conn.beginTransaction();
		const [[row]] = await conn.query(`SELECT * FROM ${T.statement} WHERE id = ? FOR UPDATE`, [idRow]);
		if (!row) throw httpErr(404, "modules.monobank.e.payment_not_found");
		if (row.id_order && row.match_type !== "none") throw httpErr(409, "modules.monobank.e.already_matched");
		const [[o]] = await conn.query(`SELECT id FROM ${P}orders WHERE id = ? AND deleted_at IS NULL`, [idOrder]);
		if (!o) throw httpErr(404, "modules.monobank.e.order_not_found");
		const [[ex]] = await conn.query(`SELECT id, id_order FROM ${T.invoices} WHERE invoice_id = ?`, [row.invoice_id]);
		if (ex && Number(ex.id_order) !== Number(idOrder)) throw httpErr(409, "modules.monobank.e.already_matched");
		if (ex) idInvoice = ex.id;
		else {
			const [r] = await conn.query(
				`INSERT INTO ${T.invoices} (id_order, id_account, source, invoice_id, page_url, amount, ccy, payment_type, status, id_user, date_add, date_edit)
				 VALUES (?, ?, 'statement', ?, '', ?, ?, ?, 'created', ?, ?, NOW())`,
				[idOrder, row.id_account, row.invoice_id, row.amount, row.ccy, row.status === "hold" ? "hold" : "debit", idUser || null, row.date]
			);
			idInvoice = r.insertId;
		}
		await conn.query(`UPDATE ${T.statement} SET id_order = ?, id_invoice = ?, match_type = ?, id_user = ?, date_edit = NOW() WHERE id = ?`, [idOrder, idInvoice, type, idUser || null, row.id]);
		await conn.query(`INSERT INTO ${T.events} (id_invoice, id_order, type, status, payload, id_user, date_add) VALUES (?, ?, 'matched', ?, ?, ?, NOW())`, [
			idInvoice,
			idOrder,
			row.status,
			JSON.stringify({ match: type, amount: fromMinor(row.amount), masked_pan: row.masked_pan, reference: row.reference }),
			idUser || null,
		]);
		await conn.query(`INSERT INTO ${P}orders_events (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, 'payment_matched', ?, ?, NOW())`, [
			idOrder,
			idUser || null,
			JSON.stringify({ provider: "monobank", invoice: row.invoice_id, amount: fromMinor(row.amount), match: type }),
			idUser ? "manual" : "system",
		]);
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
	// Стан і статус замовлення — тим самим шляхом, що й вебхук (поза транзакцією прив'язки)
	const [[row]] = await pool.query(`SELECT status, date, amount, refunded FROM ${T.statement} WHERE id = ?`, [idRow]);
	await invoices.applyRemote(idInvoice, { status: row.status, modifiedDate: row.date, finalAmount: Number(row.amount) - Number(row.refunded) }, "statement", idUser);
	return { id_order: idOrder, id_invoice: idInvoice };
}

async function attach(idRow, orderQuery, idUser) {
	return attachRow(idRow, await findOrder(orderQuery), idUser, "manual");
}

/** Відв'язати помилково прив'язаний платіж. Посилання системи й платежі з поверненнями не відв'язуються */
async function detach(idRow, idUser) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [[row]] = await conn.query(`SELECT * FROM ${T.statement} WHERE id = ? FOR UPDATE`, [idRow]);
		if (!row || !row.id_order) throw httpErr(404, "modules.monobank.e.payment_not_found");
		if (row.match_type === "invoice") throw httpErr(409, "modules.monobank.e.cannot_detach");
		const [[inv]] = await conn.query(`SELECT id, source FROM ${T.invoices} WHERE id = ?`, [row.id_invoice]);
		const [[rf]] = await conn.query(`SELECT COUNT(*) AS n FROM ${T.refunds} WHERE id_invoice = ?`, [row.id_invoice || 0]);
		if (!inv || inv.source !== "statement" || Number(rf.n)) throw httpErr(409, "modules.monobank.e.cannot_detach");
		await conn.query(`DELETE FROM ${T.events} WHERE id_invoice = ?`, [inv.id]);
		await conn.query(`DELETE FROM ${T.invoices} WHERE id = ?`, [inv.id]);
		// match_type = 'none': автоматична прив'язка більше не чіпає цей платіж
		await conn.query(`UPDATE ${T.statement} SET id_order = NULL, id_invoice = NULL, match_type = 'none', id_user = ?, date_edit = NOW() WHERE id = ?`, [idUser || null, row.id]);
		await conn.query(`INSERT INTO ${P}orders_events (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, 'payment_unmatched', ?, 'manual', NOW())`, [
			row.id_order,
			idUser || null,
			JSON.stringify({ provider: "monobank", invoice: row.invoice_id, amount: fromMinor(row.amount) }),
		]);
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
	return {};
}

/* ───────────────────────── Список (Tabulator remote) ───────────────────────── */

const SORT = { date: "s.date", amount: "s.amount", refunded: "s.refunded", status: "s.status", account: "a.name" };

function where(f) {
	const w = ["1 = 1"];
	const p = [];
	if (Number(f.account) > 0) {
		w.push("s.id_account = ?");
		p.push(Number(f.account));
	}
	if (STATUSES.includes(f.status)) {
		w.push("s.status = ?");
		p.push(f.status);
	}
	if (f.matched === "no") w.push("s.id_order IS NULL AND s.status IN ('success', 'hold')");
	else if (f.matched === "yes") w.push("s.id_order IS NOT NULL");
	if (dt(f.from)) {
		w.push("s.date >= ?");
		p.push(dt(f.from));
	}
	if (dt(f.to)) {
		w.push("s.date < ? + INTERVAL 1 DAY");
		p.push(dt(f.to));
	}
	const q = String(f.q || "").trim();
	if (q) {
		w.push("(s.invoice_id = ? OR s.rrn = ? OR s.approval_code = ? OR s.masked_pan LIKE ? OR s.reference LIKE ? OR s.destination LIKE ? OR o.reference = ?)");
		p.push(q, q, q, `%${q}%`, `%${q}%`, `%${q}%`, q);
	}
	return { sql: w.join(" AND "), params: p };
}

async function list(body) {
	const b = body || {};
	const size = Math.min(200, Math.max(10, Number(b.size) || 50));
	const page = Math.max(1, Number(b.page) || 1);
	const s0 = Array.isArray(b.sort) && b.sort[0] ? b.sort[0] : null;
	const order = s0 && SORT[s0.field] ? `${SORT[s0.field]} ${s0.dir === "asc" ? "ASC" : "DESC"}` : "s.date DESC";
	const w = where(b.filter || b);
	const base = `FROM ${T.statement} s LEFT JOIN ${T.accounts} a ON a.id = s.id_account LEFT JOIN ${P}orders o ON o.id = s.id_order WHERE ${w.sql}`;
	const [[c]] = await pool.query(`SELECT COUNT(*) AS n ${base}`, w.params);
	const [rows] = await pool.query(
		`SELECT s.*, a.name AS account_name, o.reference AS order_reference ${base} ORDER BY ${order}, s.id DESC LIMIT ? OFFSET ?`,
		[...w.params, size, (page - 1) * size]
	);
	return {
		last_page: Math.max(1, Math.ceil(Number(c.n) / size)),
		total: Number(c.n),
		data: rows.map((r) => ({
			id: Number(r.id),
			account: r.account_name,
			invoice_id: r.invoice_id,
			status: r.status,
			date: r.date,
			amount: fromMinor(r.amount),
			refunded: fromMinor(r.refunded),
			fee: r.profit_amount === null ? null : fromMinor(Math.max(0, Number(r.amount) - Number(r.refunded) - Number(r.profit_amount))),
			currency: CCY_ISO[r.ccy] || String(r.ccy),
			masked_pan: r.masked_pan,
			reference: r.reference,
			destination: r.destination,
			rrn: r.rrn,
			approval_code: r.approval_code,
			scheme: r.payment_scheme,
			qr: r.short_qr_id,
			id_order: r.id_order ? Number(r.id_order) : null,
			order_reference: r.order_reference,
			match_type: r.match_type,
		})),
	};
}

/* ───────────────────────── Стан завантаження ───────────────────────── */

async function state() {
	const [rows] = await pool.query(
		`SELECT a.id, a.name, s.synced_from, s.synced_to, s.started_at, s.finished_at, s.total, s.message
		   FROM ${T.accounts} a LEFT JOIN ${T.sync} s ON s.id_account = a.id WHERE a.status = 1 ORDER BY a.name`
	);
	return { running, accounts: rows.map((r) => ({ id: Number(r.id), name: r.name, synced_from: r.synced_from, synced_to: r.synced_to, finished_at: r.finished_at, message: r.message })) };
}

/* ───────────────────────── Звірка ───────────────────────── */

/**
 * Три списки розбіжностей:
 *  unmatched — успішні платежі виписки без замовлення;
 *  missing   — сплачені посилання системи, яких немає у вже завантаженій виписці (старші за 2 год);
 *  mismatch  — стан або сума рахунку в системі не збігаються з випискою.
 */
async function reconcile(f) {
	const acc = Number((f || {}).account) || 0;
	const accSql = (alias) => (acc ? ` AND ${alias}.id_account = ${pool.escape(acc)}` : "");
	const [unmatched] = await pool.query(
		`SELECT s.id, s.invoice_id, s.date, s.amount, s.ccy, s.status, s.masked_pan, s.reference, s.destination, a.name AS account
		   FROM ${T.statement} s LEFT JOIN ${T.accounts} a ON a.id = s.id_account
		  WHERE s.id_order IS NULL AND s.status IN ('success', 'hold')${accSql("s")} ORDER BY s.date DESC LIMIT 500`
	);
	const [missing] = await pool.query(
		`SELECT i.id, i.id_order, o.reference AS order_reference, i.invoice_id, i.amount, i.ccy, i.status, i.paid_at, a.name AS account
		   FROM ${T.invoices} i
		   JOIN ${T.sync} y ON y.id_account = i.id_account
		   LEFT JOIN ${T.accounts} a ON a.id = i.id_account
		   LEFT JOIN ${P}orders o ON o.id = i.id_order
		  WHERE i.status = 'success' AND i.paid_at BETWEEN y.synced_from AND y.synced_to - INTERVAL 2 HOUR
		    AND NOT EXISTS (SELECT 1 FROM ${T.statement} s WHERE s.id_account = i.id_account AND s.invoice_id = i.invoice_id)${accSql("i")}
		  ORDER BY i.paid_at DESC LIMIT 500`
	);
	const [mismatch] = await pool.query(
		`SELECT i.id, i.id_order, o.reference AS order_reference, i.invoice_id, i.ccy, i.status AS our_status, s.status AS bank_status,
		        COALESCE(i.final_amount, i.amount) AS our_amount, s.amount - s.refunded AS bank_amount, a.name AS account
		   FROM ${T.invoices} i
		   JOIN ${T.statement} s ON s.id_account = i.id_account AND s.invoice_id = i.invoice_id
		   LEFT JOIN ${T.accounts} a ON a.id = i.id_account
		   LEFT JOIN ${P}orders o ON o.id = i.id_order
		  WHERE (s.status = 'success' AND i.status NOT IN ('success', 'reversed'))
		     OR (s.status = 'hold' AND i.status <> 'hold')
		     OR (s.status = 'success' AND i.status = 'success' AND COALESCE(i.final_amount, i.amount) <> s.amount - s.refunded)${accSql("i")}
		  ORDER BY s.date DESC LIMIT 500`
	);
	const cur = (c) => CCY_ISO[c] || String(c);
	return {
		unmatched: unmatched.map((r) => ({ id: Number(r.id), invoice_id: r.invoice_id, date: r.date, amount: fromMinor(r.amount), currency: cur(r.ccy), status: r.status, masked_pan: r.masked_pan, reference: r.reference, destination: r.destination, account: r.account })),
		missing: missing.map((r) => ({ id: Number(r.id), id_order: Number(r.id_order), order_reference: r.order_reference, invoice_id: r.invoice_id, amount: fromMinor(r.amount), currency: cur(r.ccy), paid_at: r.paid_at, account: r.account })),
		mismatch: mismatch.map((r) => ({
			id: Number(r.id),
			id_order: Number(r.id_order),
			order_reference: r.order_reference,
			invoice_id: r.invoice_id,
			currency: cur(r.ccy),
			our_status: r.our_status,
			bank_status: r.bank_status,
			our_amount: fromMinor(r.our_amount),
			bank_amount: fromMinor(r.bank_amount),
			account: r.account,
		})),
	};
}

/** Оновити стан рахунку з банку (кнопка в розбіжностях) */
async function fixInvoice(idInvoice, idUser) {
	const [[i]] = await pool.query(`SELECT id_order FROM ${T.invoices} WHERE id = ?`, [idInvoice]);
	if (!i) throw httpErr(404, "modules.monobank.e.invoice_not_found");
	await invoices.refresh(Number(i.id_order), idInvoice, idUser);
	return {};
}

/* ───────────────────────── Звіт ───────────────────────── */

/**
 * За період: надходження з виписки (усі платежі мерчанта) і конверсія посилань системи.
 * Суми — по валютах окремо. Комісія = сума − повернення − до зарахування (коли банк віддає profitAmount).
 */
async function report(f) {
	const from = dt((f || {}).from) || new Date(Date.now() - 30 * DAY);
	const to = dt((f || {}).to) || new Date();
	const acc = Number((f || {}).account) || 0;
	const accS = acc ? ` AND s.id_account = ${pool.escape(acc)}` : "";
	const accI = acc ? ` AND i.id_account = ${pool.escape(acc)}` : "";
	const [totals] = await pool.query(
		`SELECT s.ccy, COUNT(*) AS cnt, SUM(s.amount) AS amount, SUM(s.refunded) AS refunded,
		        SUM(CASE WHEN s.profit_amount IS NULL THEN 0 ELSE GREATEST(0, s.amount - s.refunded - s.profit_amount) END) AS fee,
		        SUM(s.id_order IS NULL) AS unmatched
		   FROM ${T.statement} s
		  WHERE s.status = 'success' AND s.date >= ? AND s.date < ? + INTERVAL 1 DAY${accS}
		  GROUP BY s.ccy`,
		[from, to]
	);
	const [daily] = await pool.query(
		`SELECT DATE(s.date) AS day, s.ccy, COUNT(*) AS cnt, SUM(s.amount) AS amount, SUM(s.refunded) AS refunded,
		        SUM(CASE WHEN s.profit_amount IS NULL THEN 0 ELSE GREATEST(0, s.amount - s.refunded - s.profit_amount) END) AS fee
		   FROM ${T.statement} s
		  WHERE s.status = 'success' AND s.date >= ? AND s.date < ? + INTERVAL 1 DAY${accS}
		  GROUP BY DATE(s.date), s.ccy ORDER BY day DESC`,
		[from, to]
	);
	const [[links]] = await pool.query(
		`SELECT COUNT(*) AS created,
		        SUM(i.status IN ('success', 'reversed')) AS paid,
		        SUM(i.status = 'hold') AS hold,
		        SUM(i.status IN ('expired', 'removed')) AS lost,
		        SUM(i.status = 'failure') AS failed,
		        AVG(CASE WHEN i.paid_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, i.date_add, i.paid_at) END) AS avg_min
		   FROM ${T.invoices} i
		  WHERE i.source = 'link' AND i.payment_type <> 'verification' AND i.date_add >= ? AND i.date_add < ? + INTERVAL 1 DAY${accI}`,
		[from, to]
	);
	const cur = (c) => CCY_ISO[c] || String(c);
	const sum = (r) => ({
		currency: cur(r.ccy),
		count: Number(r.cnt) || 0,
		amount: fromMinor(r.amount),
		refunded: fromMinor(r.refunded),
		fee: fromMinor(r.fee),
		net: fromMinor(Number(r.amount) - Number(r.refunded) - Number(r.fee)),
	});
	const created = Number(links.created) || 0;
	const paid = Number(links.paid) || 0;
	return {
		from,
		to,
		totals: totals.map((r) => ({ ...sum(r), unmatched: Number(r.unmatched) || 0 })),
		daily: daily.map((r) => ({ day: r.day, ...sum(r) })),
		links: {
			created,
			paid,
			hold: Number(links.hold) || 0,
			lost: Number(links.lost) || 0,
			failed: Number(links.failed) || 0,
			conversion: created ? Math.round((paid / created) * 1000) / 10 : 0,
			avg_minutes: links.avg_min === null ? null : Math.round(Number(links.avg_min)),
		},
	};
}

/* ───────────────────────── Сповіщення команді ───────────────────────── */

/**
 * Сповіщення команді від модуля (дзвіночок / push через спільну notify()).
 * Оплата й повернення йдуть через сповіщення замовлень (orders/notify: paid, refund — за правилами сайту);
 * тут — те, чого в замовленнях немає: невдала оплата і холд, що скоро закінчиться.
 * Адресати: менеджер замовлення і той, хто створив посилання.
 */

const LOCALE = process.env.APP_LOCALE || "uk";
const t = (phrase, vars) => i18n.__({ phrase, locale: LOCALE }, vars || {});
const money = (minor, ccy) => new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(fromMinor(minor)) + " " + (CCY_ISO[ccy] || "");

async function send(inv, kind, message) {
	const [[o]] = await pool.query(`SELECT id, reference, id_user FROM ${P}orders WHERE id = ?`, [inv.id_order]);
	if (!o) return;
	const users = [...new Set([o.id_user, inv.id_user].map(Number).filter((n) => n > 0))];
	const payload = {
		title: `💳 ${t("modules.monobank.notify." + kind)} · ${o.reference || "#" + o.id}`,
		name: "Monobank",
		message,
		url: `/orders/${o.id}/`,
		date: new Date().toISOString().slice(0, 19).replace("T", " "),
	};
	for (const user of users) {
		await notify({
			type: "modules.monobank." + kind,
			audience: { user },
			channels: ["inapp", "webpush"],
			key: `monobank_${kind}_${inv.id}`.slice(0, 64),
			collapseKey: `monobank_${inv.id}`,
			priority: 6,
			payload,
		}).catch((e) => console.error("[monobank] notify:", e.message));
	}
}

/** Невдала оплата: клієнт спробував, але банк відхилив */
async function failed(inv, reason) {
	await send(inv, "failed", [money(inv.amount, inv.ccy), reason].filter(Boolean).join(" · "));
}

/**
 * Холд закінчується менш ніж за добу: якщо не підтвердити, банк сам поверне кошти клієнту.
 * Раз на рахунок — позначка hold_warned у журналі.
 */
async function holdsExpiring() {
	const [rows] = await pool.query(
		`SELECT i.* FROM ${T.invoices} i
		  WHERE i.status = 'hold' AND i.hold_until IS NOT NULL AND i.hold_until < NOW() + INTERVAL 1 DAY AND i.hold_until > NOW()
		    AND NOT EXISTS (SELECT 1 FROM ${T.events} e WHERE e.id_invoice = i.id AND e.type = 'hold_warned')
		  LIMIT 100`
	);
	for (const inv of rows) {
		await pool.query(`INSERT INTO ${T.events} (id_invoice, id_order, type, status, payload, id_user, date_add) VALUES (?, ?, 'hold_warned', 'hold', NULL, NULL, NOW())`, [inv.id, inv.id_order]);
		await send(inv, "hold_expiring", `${money(inv.amount, inv.ccy)} · ${t("modules.monobank.notify.hold_until", { date: new Date(inv.hold_until).toLocaleString("uk-UA") })}`);
	}
	return rows.length;
}

module.exports = { configure, sync, syncInBackground, state, list, attach, detach, reconcile, fixInvoice, report, matchAll, failed, holdsExpiring };