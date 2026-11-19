"use strict";

/**
 * Звіти у фоні: черга в базі (reports_jobs), обробник у процесі, файли на диску (storage/reports — не через статику).
 *
 * Користувач замовляє звіт → запис «у черзі» → обробник по одному (REPORTS_CONCURRENCY) рахує й пише XLSX / CSV
 * → «готово» з посиланням, першими рядками для перегляду й сповіщенням автору.
 * Перезапуск сервера: незавершені повертаються в чергу. Старі файли видаляються через REPORTS_RETENTION_DAYS.
 *
 * Хто бачить результат: автор; інші — якщо звіт спільний (is_shared), у них є право цього звіту
 * і, для звітів з видимістю (orders / clients), — право бачити всіх, якщо автор формував «по всіх» (scope_all).
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging").child("reports");
const defs = require("./definitions");

const P = config.get("configDatabase").prefix;
const DIR = path.resolve(process.env.REPORTS_DIR || path.join(__dirname, "..", "..", "storage", "reports"));
const CONCURRENCY = Math.max(1, parseInt(process.env.REPORTS_CONCURRENCY, 10) || 1);
const RETENTION_DAYS = parseInt(process.env.REPORTS_RETENTION_DAYS, 10) || 30;
const PER_USER = 3; // незавершених на користувача
const PREVIEW_ROWS = 100;
const FORMATS = ["xlsx", "csv"];
const SCOPE_ALL = { orders: "orders.all", clients: "clients.all" };

const httpErr = (status, message, errors) => Object.assign(new Error(message), { status, errors });
const can = (user, [slug, action]) => user?.permissions?.[slug]?.[action] === true;
const userOf = (req) => req.user.userId || req.user.id;

/* ─── Доступ ─── */

/** Звіти, які користувач може формувати й бачити */
function allowed(user) {
	return defs.REPORTS.filter((d) => can(user, d.perm));
}

/** SQL видимості завдань для користувача (alias j) */
function visibility(user, idUser) {
	const parts = ["j.id_user = ?"];
	const params = [idUser];
	for (const d of allowed(user)) {
		const all = !d.scope || can(user, [SCOPE_ALL[d.scope], "view"]);
		parts.push(`(j.report = ? AND j.is_shared = 1${all ? "" : " AND j.scope_all = 0"})`);
		params.push(d.key);
	}
	return { sql: "(" + parts.join(" OR ") + ")", params };
}

/* ─── Замовлення звіту ─── */

async function create(req, b) {
	b = b || {};
	const def = defs.BY_KEY.get(String(b.report));
	if (!def || !can(req.user, def.perm)) throw httpErr(403, "Forbidden");
	const params = defs.parseParams(def, b.params);
	const format = FORMATS.includes(b.format) ? b.format : "xlsx";
	const idUser = userOf(req);
	const [[{ busy }]] = await pool.query(`SELECT COUNT(*) AS busy FROM ${P}reports_jobs WHERE id_user = ? AND status IN ('queued', 'running')`, [idUser]);
	if (busy >= PER_USER) throw httpErr(429, req.__("reports.e_busy", { n: PER_USER }));
	const scopeAll = def.scope ? (can(req.user, [SCOPE_ALL[def.scope], "view"]) ? 1 : 0) : 1;
	const [r] = await pool.query(
		`INSERT INTO ${P}reports_jobs (report, title, params, format, status, id_user, is_shared, scope_all, locale, id_lang, date_add, expires_at)
		 VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, NOW(), NOW() + INTERVAL ? DAY)`,
		[def.key, String(b.title || "").trim().slice(0, 255) || null, JSON.stringify(params), format, idUser, b.is_shared === false ? 0 : 1, scopeAll, String(req.getLocale ? req.getLocale() : "uk").slice(0, 8), req.user.id_lang || 1, RETENTION_DAYS]
	);
	kick();
	return { id: r.insertId };
}

/* ─── Список / завантаження / видалення ─── */

/** Tabulator remote. f: { mine, report, status, page, size } */
async function list(req, f = {}) {
	const idUser = userOf(req);
	const v = visibility(req.user, idUser);
	const where = [v.sql];
	const params = [...v.params];
	if (f.mine === true || f.mine === "true") {
		where.push("j.id_user = ?");
		params.push(idUser);
	}
	if (defs.BY_KEY.has(f.report)) {
		where.push("j.report = ?");
		params.push(f.report);
	}
	if (["queued", "running", "done", "failed"].includes(f.status)) {
		where.push("j.status = ?");
		params.push(f.status);
	}
	const lim = Math.min(200, Math.max(10, parseInt(f.size, 10) || 50));
	const page = Math.max(1, parseInt(f.page, 10) || 1);
	const w = where.join(" AND ");
	const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${P}reports_jobs j WHERE ${w}`, params);
	const [rows] = await pool.query(
		`SELECT j.id, j.report, j.title, j.params, j.format, j.status, j.rows_count, j.size, j.error, j.id_user, j.is_shared, j.downloads,
		        j.date_add, j.started_at, j.finished_at, j.expires_at, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS author
		   FROM ${P}reports_jobs j LEFT JOIN ${P}users u ON u.id = j.id_user
		  WHERE ${w} ORDER BY j.id DESC LIMIT ? OFFSET ?`,
		[...params, lim, (page - 1) * lim]
	);
	const canManage = can(req.user, ["reports", "edit"]);
	return {
		last_page: Math.max(1, Math.ceil(total / lim)),
		total,
		data: rows.map((r) => ({ ...r, params: typeof r.params === "string" ? JSON.parse(r.params) : r.params, own: r.id_user === idUser, can_delete: r.id_user === idUser || canManage })),
	};
}

async function jobFor(req, id) {
	const v = visibility(req.user, userOf(req));
	const [[j]] = await pool.query(`SELECT j.* FROM ${P}reports_jobs j WHERE j.id = ? AND ${v.sql}`, [id, ...v.params]);
	if (!j) throw httpErr(404, "Not found");
	return j;
}

/** Файл готового звіту: { file, name } */
async function download(req, id) {
	const j = await jobFor(req, id);
	if (j.status !== "done" || !j.file) throw httpErr(409, "Not ready");
	const file = path.join(DIR, j.file);
	if (!file.startsWith(DIR + path.sep) || !fs.existsSync(file)) throw httpErr(410, "File expired");
	await pool.query(`UPDATE ${P}reports_jobs SET downloads = downloads + 1 WHERE id = ?`, [j.id]);
	const day = String(j.finished_at || j.date_add).slice(0, 10);
	return { file, name: `${j.report}_${day}_${j.id}.${j.format}` };
}

/** Перші рядки для перегляду на сторінці */
async function preview(req, id) {
	const j = await jobFor(req, id);
	return { status: j.status, preview: j.preview ? JSON.parse(j.preview) : null };
}

async function remove(req, id) {
	const j = await jobFor(req, id);
	if (j.id_user !== userOf(req) && !can(req.user, ["reports", "edit"])) throw httpErr(403, "Forbidden");
	if (j.status === "running") throw httpErr(409, "Running");
	await pool.query(`DELETE FROM ${P}reports_jobs WHERE id = ?`, [j.id]);
	if (j.file) await fsp.unlink(path.join(DIR, j.file)).catch(() => {});
	return { ok: true };
}

/** Повторити з тими самими параметрами (як новий запит від поточного користувача) */
async function repeat(req, id) {
	const j = await jobFor(req, id);
	return create(req, { report: j.report, title: j.title, format: j.format, is_shared: !!j.is_shared, params: { ...JSON.parse(j.params) } });
}

/* ─── Запис файлів ─── */

function translator(locale) {
	const i18n = require("../../config/i18n/i18n");
	return (key, fallback) => {
		const v = i18n.__({ phrase: key, locale });
		return v === key ? fallback || key.split(".").pop() : v;
	};
}

const cell = (v) => (v === null || v === undefined ? "" : v);

async function writeXlsx(file, sheets, t) {
	const ExcelJS = require("exceljs");
	const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: true });
	wb.creator = "Growth contour";
	for (const s of sheets) {
		// Потоковий аркуш: закріплений заголовок і автофільтр — лише через параметри створення (views — тільки для читання)
		const ws = wb.addWorksheet(t("reports.sheets." + s.key).slice(0, 31), {
			views: [{ state: "frozen", ySplit: 1 }],
			autoFilter: { from: { row: 1, column: 1 }, to: { row: 1, column: s.columns.length } },
		});
		ws.columns = s.columns.map(([key, width, fmt]) => ({ key, header: t("reports.cols." + key), width: width || 14, style: fmt ? { numFmt: fmt } : {} }));
		ws.getRow(1).font = { bold: true };
		ws.getRow(1).commit();
		for (const r of s.rows) ws.addRow(Object.fromEntries(s.columns.map(([k]) => [k, cell(r[k])]))).commit();
		if (s.totals && s.rows.length) {
			const tot = { [s.columns[0][0]]: t("reports.total") };
			for (const k of s.totals) tot[k] = Math.round(s.rows.reduce((a, r) => a + (Number(r[k]) || 0), 0) * 100) / 100;
			const row = ws.addRow(tot);
			row.font = { bold: true };
			row.commit();
		}
		ws.commit();
	}
	await wb.commit();
}

async function writeCsv(file, sheets, t) {
	// UTF-8 з BOM і «;» — так Excel в українській локалі відкриває одразу правильно
	const esc = (v) => {
		const s = String(cell(v));
		return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
	};
	const out = fs.createWriteStream(file, { encoding: "utf8" });
	out.write("﻿");
	sheets.forEach((s, i) => {
		if (sheets.length > 1) out.write((i ? "\r\n" : "") + esc(t("reports.sheets." + s.key)) + "\r\n");
		out.write(s.columns.map(([k]) => esc(t("reports.cols." + k))).join(";") + "\r\n");
		for (const r of s.rows) out.write(s.columns.map(([k]) => esc(r[k])).join(";") + "\r\n");
	});
	await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
}

/* ─── Обробник ─── */

let running = 0;
let timer = null;

async function claim() {
	// Атомарно забираємо найстаріший у черзі; LAST_INSERT_ID — у межах одного з'єднання
	const conn = await pool.getConnection();
	try {
		const [r] = await conn.query(`UPDATE ${P}reports_jobs SET status = 'running', started_at = NOW(), id = LAST_INSERT_ID(id) WHERE status = 'queued' ORDER BY id LIMIT 1`);
		if (!r.affectedRows) return null;
		const [[j]] = await conn.query(`SELECT * FROM ${P}reports_jobs WHERE id = LAST_INSERT_ID()`);
		return j || null;
	} finally {
		conn.release();
	}
}

async function process1(j) {
	const def = defs.BY_KEY.get(j.report);
	const t0 = Date.now();
	const t = translator(j.locale || "uk");
	try {
		if (!def) throw new Error("Unknown report " + j.report);
		const params = typeof j.params === "string" ? JSON.parse(j.params) : j.params;
		const res = await def.run(params, { idLang: j.id_lang || 1, idUser: j.id_user, scopeAll: !!j.scope_all });
		const sheets = res.sheets || [];
		const month = new Date().toISOString().slice(0, 7);
		await fsp.mkdir(path.join(DIR, month), { recursive: true });
		const rel = path.join(month, `${j.id}_${j.report}.${j.format}`);
		const file = path.join(DIR, rel);
		if (j.format === "csv") await writeCsv(file, sheets, t);
		else await writeXlsx(file, sheets, t);
		const size = (await fsp.stat(file)).size;
		const first = sheets[0] || { columns: [], rows: [] };
		const preview = { columns: first.columns.map(([k, , fmt]) => ({ key: k, title: t("reports.cols." + k), money: fmt === "#,##0.00" })), rows: first.rows.slice(0, PREVIEW_ROWS), total: first.rows.length, sheets: sheets.map((s) => ({ title: t("reports.sheets." + s.key), rows: s.rows.length })) };
		const rows = sheets.reduce((a, s) => a + s.rows.length, 0);
		await pool.query(`UPDATE ${P}reports_jobs SET status = 'done', file = ?, size = ?, rows_count = ?, preview = ?, finished_at = NOW(), error = NULL WHERE id = ?`, [rel, size, rows, JSON.stringify(preview), j.id]);
		logging.info({ job: j.id, report: j.report, rows, ms: Date.now() - t0 }, "report done");
		notifyAuthor(j, t, "done", rows);
	} catch (e) {
		logging.error({ err: e, job: j.id, report: j.report }, "report failed");
		await pool.query(`UPDATE ${P}reports_jobs SET status = 'failed', error = ?, finished_at = NOW() WHERE id = ?`, [String(e.message).slice(0, 1000), j.id]).catch(() => {});
		notifyAuthor(j, t, "failed");
	}
}

function notifyAuthor(j, t, kind, rows) {
	try {
		const { notify } = require("../notifications/notify");
		Promise.resolve(notify({
			type: "reports." + kind,
			channels: ["inapp"],
			audience: { user: j.id_user },
			key: `report_${j.id}_${kind}`,
			priority: kind === "failed" ? 6 : 4,
			payload: {
				title: t("reports.n_" + kind),
				name: t("reports.r." + j.report + ".title"),
				message: kind === "done" ? t("reports.n_rows").replace("%n", rows) : t("reports.n_failed_hint"),
				url: "/reports/?job=" + j.id,
				date: new Date().toISOString().slice(0, 19).replace("T", " "),
			},
		})).catch((e) => logging.warn({ err: e }, "notify failed"));
	} catch (e) {
		logging.warn({ err: e }, "notify failed");
	}
}

async function tick() {
	while (running < CONCURRENCY) {
		let j;
		try {
			j = await claim();
		} catch (e) {
			if (e.code !== "ER_NO_SUCH_TABLE") logging.error({ err: e }, "reports claim failed");
			return;
		}
		if (!j) return;
		running++;
		process1(j).finally(() => {
			running--;
			kick();
		});
	}
}

function kick() {
	setImmediate(() => tick().catch((e) => logging.error({ err: e }, "reports tick failed")));
}

/** Прибрати прострочені звіти (файли й записи) */
async function cleanup() {
	try {
		const [rows] = await pool.query(`SELECT id, file FROM ${P}reports_jobs WHERE expires_at < NOW() AND status <> 'running' LIMIT 1000`);
		for (const r of rows) if (r.file) await fsp.unlink(path.join(DIR, r.file)).catch(() => {});
		if (rows.length) await pool.query(`DELETE FROM ${P}reports_jobs WHERE id IN (?)`, [rows.map((r) => r.id)]);
	} catch (e) {
		if (e.code !== "ER_NO_SUCH_TABLE") logging.error({ err: e }, "reports cleanup failed");
	}
}

/** Старт: незавершені після перезапуску — знову в чергу; опитування раз на 10 с (на випадок іншого процесу) */
async function start() {
	if (timer) return;
	try {
		await pool.query(`UPDATE ${P}reports_jobs SET status = 'queued', started_at = NULL WHERE status = 'running'`);
	} catch (e) {
		if (e.code === "ER_NO_SUCH_TABLE") return logging.warn("reports_jobs table is missing — reports are disabled");
		logging.error({ err: e }, "reports recover failed");
	}
	timer = setInterval(kick, 10000);
	timer.unref();
	setInterval(cleanup, 6 * 3600000).unref();
	cleanup();
	kick();
}

module.exports = { allowed, create, list, download, preview, remove, repeat, start, DIR };