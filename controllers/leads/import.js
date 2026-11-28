"use strict";

/**
 * Імпорт лідів з Excel (.xlsx) або CSV — три кроки, як імпорт клієнтів (controllers/clients/import.js):
 *   1. upload — файл у storage/imports/leads-<id>.<ext>, заголовки, перші рядки, автозіставлення колонок;
 *   2. start  — зіставлення колонок і налаштування → фонова обробка (leads_imports, status running);
 *   3. status / cancel — прогрес, помилки по рядках; після рестарту сервера — продовження з місця зупинки.
 *
 * Рядок → лід: назва, контакт, сума, нотатка, сайт, джерело / етап / статус / відповідальний / теги — за назвою
 * (невідомі значення — з налаштувань імпорту), UTM-мітки. capture_type = import.
 * Дублікати (той самий телефон або email у лідах, що не в кошику): skip — пропустити, update — дописати порожні поля
 * наявного ліда, create — створити (фонова служба позначить як можливий дубль).
 * Розподіл за правилами — за бажанням; сповіщення про нові ліди й автоматизації для імпорту не запускаються
 * (тисячі старих лідів не мають засипати менеджерів), дедлайн першої відповіді — не ставиться.
 */

const fs = require("fs");
const path = require("path");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");

const P = config.get("configDatabase").prefix;
const DIR = path.join(process.cwd(), "storage", "imports");
const MAX_ROWS = 50000;
const MAX_ERRORS = 500;
const httpErr = (code, message, params) => Object.assign(new Error(message), { status: code, params });

const TARGETS = ["title", "name", "phone", "email", "company", "position", "value", "note", "website", "source", "stage", "status", "manager", "tags", "utm_source", "utm_medium", "utm_campaign", "date_add"];
const TARGET_SET = new Set(TARGETS);
const GUESS = [
	// UTM — першими, щоб «utm_source» не зіставилось із «Джерелом»
	["utm_source", /utm[_ ]?source/i],
	["utm_medium", /utm[_ ]?medium/i],
	["utm_campaign", /utm[_ ]?campaign/i],
	["title", /^(назва|название|title|subject|лід|лид|lead|запит|заявка)$/i],
	["name", /^(імʼ?я|ім'я|имя|name|піб|фіо|фио|контакт|contact|full ?name|клієнт|клиент)$/i],
	["phone", /(телефон|phone|tel|моб)/i],
	["email", /(e-?mail|пошта|почта)/i],
	["company", /(компанія|компания|company|організація|организация)/i],
	["position", /(посада|должность|position|job ?title)/i],
	["value", /(сума|сумма|amount|value|бюджет|budget|price|ціна|цена)/i],
	["note", /(нотатка|примітка|коментар|комментарий|note|comment|опис|описание|description|повідомлення|сообщение|message)/i],
	["website", /(сайт|website|site|url|domain)/i],
	["source", /(джерело|источник|source|канал|channel)/i],
	["stage", /(етап|этап|stage)/i],
	["status", /(статус|status|стан)/i],
	["manager", /(менеджер|відповідальний|ответственный|manager|owner|assigned)/i],
	["tags", /(тег|tag|мітки)/i],
	["date_add", /(дата|date|created|створено|создан)/i],
];

function guessMapping(headers) {
	const used = new Set();
	return headers.map((h) => {
		const hit = GUESS.find(([k, re]) => !used.has(k) && re.test(String(h || "").trim()));
		if (!hit) return "";
		used.add(hit[0]);
		return hit[0];
	});
}

/* ═══ Читання файлу ═══ */

async function readRows(file, ext) {
	let rows;
	if (ext === ".xlsx") {
		const ExcelJS = require("exceljs");
		const wb = new ExcelJS.Workbook();
		await wb.xlsx.readFile(file);
		const ws = wb.worksheets[0];
		rows = [];
		if (ws) {
			ws.eachRow({ includeEmpty: false }, (r) => {
				const vals = [];
				for (let c = 1; c <= r.cellCount; c++) {
					const cell = r.getCell(c);
					// Дати з Excel — як РРРР-ММ-ДД ГГ:ХХ, решта — текстом
					vals.push(cell.value instanceof Date ? cell.value.toISOString().slice(0, 16).replace("T", " ") : String(cell.text ?? "").trim());
				}
				rows.push(vals);
			});
		}
	} else rows = require("../clients/import").parseCsv(fs.readFileSync(file, "utf8"));
	if (rows.length > MAX_ROWS + 1) throw httpErr(400, "leads.import.e.too_many", { max: MAX_ROWS });
	return rows;
}

/* ═══ Крок 1 ═══ */

async function upload(buf, originalName, idUser) {
	const ext = path.extname(String(originalName || "")).toLowerCase();
	if (![".csv", ".txt", ".xlsx"].includes(ext)) throw httpErr(400, "leads.import.e.ext");
	fs.mkdirSync(DIR, { recursive: true, mode: 0o750 });
	const [ins] = await pool.query(`INSERT INTO \`${P}leads_imports\` (id_user, file_name, status, date_add, date_edit) VALUES (?, ?, 'uploaded', NOW(), NOW())`, [idUser, String(originalName).slice(0, 255)]);
	const id = ins.insertId;
	const file = path.join(DIR, "leads-" + id + ext);
	fs.writeFileSync(file, buf);
	let rows;
	try {
		rows = await readRows(file, ext);
	} catch (e) {
		fs.unlink(file, () => {});
		await pool.query(`UPDATE \`${P}leads_imports\` SET status = 'failed', error = ? WHERE id = ?`, [String(e.message).slice(0, 500), id]);
		if (e.status) throw e;
		logging.error(e);
		throw httpErr(400, "leads.import.e.read");
	}
	if (rows.length < 2) {
		fs.unlink(file, () => {});
		throw httpErr(400, "leads.import.e.empty");
	}
	const headers = rows[0].map((h, i) => String(h || "").trim() || "#" + (i + 1));
	await pool.query(`UPDATE \`${P}leads_imports\` SET file_path = ?, total = ?, headers = CAST(? AS JSON) WHERE id = ?`, [path.basename(file), rows.length - 1, JSON.stringify(headers), id]);
	return { id, headers, sample: rows.slice(1, 6), total: rows.length - 1, mapping: guessMapping(headers), targets: TARGETS };
}

/* ═══ Крок 2 ═══ */

async function start(id, idUser, body) {
	const [[job]] = await pool.query(`SELECT * FROM \`${P}leads_imports\` WHERE id = ? AND id_user = ?`, [id, idUser]);
	if (!job) throw httpErr(404, "leads.import.e.not_found");
	if (job.status !== "uploaded") throw httpErr(409, "leads.import.e.started");
	const headers = typeof job.headers === "string" ? JSON.parse(job.headers) : job.headers || [];
	const mapping = (Array.isArray(body.mapping) ? body.mapping : []).slice(0, headers.length).map((k) => (TARGET_SET.has(k) ? k : ""));
	if (!mapping.some((k) => ["phone", "email", "name", "title", "company"].includes(k))) throw httpErr(400, "leads.import.e.need_field");
	const o = body.options || {};
	const int = (v) => parseInt(v, 10) || null;
	const options = {
		id_pipeline: int(o.id_pipeline),
		id_stage: int(o.id_stage),
		id_status: int(o.id_status),
		id_source: int(o.id_source),
		id_manager: o.id_manager === "rules" ? null : int(o.id_manager),
		route: o.id_manager === "rules",
		id_tag: int(o.id_tag),
		duplicates: ["skip", "update", "create"].includes(o.duplicates) ? o.duplicates : "skip",
	};
	if (!options.id_pipeline || !options.id_stage || !options.id_status) throw httpErr(400, "leads.import.e.defaults");
	const [[st]] = await pool.query(`SELECT id FROM \`${P}leads_pipeline_stages\` WHERE id = ? AND id_pipeline = ?`, [options.id_stage, options.id_pipeline]);
	if (!st) throw httpErr(400, "leads.import.e.defaults");
	const [r] = await pool.query(`UPDATE \`${P}leads_imports\` SET status = 'running', mapping = CAST(? AS JSON), options = CAST(? AS JSON), date_start = NOW(), date_edit = NOW() WHERE id = ? AND status = 'uploaded'`, [JSON.stringify(mapping), JSON.stringify(options), id]);
	if (!r.affectedRows) throw httpErr(409, "leads.import.e.started");
	setImmediate(() => runJob(id).catch((e) => logging.error(e)));
	return { ok: true, total: job.total, file_name: job.file_name };
}

/* ═══ Обробка ═══ */

/** Довідники за назвою (без регістру): назва → id */
async function lookups(opt) {
	const map = async (sql, params = []) => {
		const [rows] = await pool.query(sql, params);
		const m = new Map();
		rows.forEach((r) => r.name && !m.has(String(r.name).trim().toLowerCase()) && m.set(String(r.name).trim().toLowerCase(), r.id));
		return m;
	};
	return {
		source: await map(`SELECT DISTINCT d.id, dl.name FROM \`${P}leads_sources\` d JOIN \`${P}leads_sources_lang\` dl ON dl.id_source = d.id`),
		stage: await map(`SELECT DISTINCT s.id, sl.name FROM \`${P}leads_pipeline_stages\` s JOIN \`${P}leads_pipeline_stages_lang\` sl ON sl.id_stage = s.id WHERE s.id_pipeline = ? AND s.is_active = 1`, [opt.id_pipeline]),
		status: await map(`SELECT DISTINCT s.id, sl.name FROM \`${P}leads_settings_status\` s JOIN \`${P}leads_settings_status_lang\` sl ON sl.id_status = s.id WHERE s.is_active = 1`),
		tag: await map(`SELECT DISTINCT t.id, tl.name FROM \`${P}leads_tags\` t JOIN \`${P}leads_tags_lang\` tl ON tl.id_tag = t.id`),
		manager: await (async () => {
			const [rows] = await pool.query(`SELECT id, email, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM \`${P}users\` WHERE active = 1`);
			const m = new Map();
			rows.forEach((u) => {
				if (u.email) m.set(String(u.email).toLowerCase(), u.id);
				if (u.name) m.set(String(u.name).toLowerCase(), u.id);
			});
			return m;
		})(),
	};
}

const pad = (x) => String(x).padStart(2, "0");
const nowSql = () => {
	const d = new Date();
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
/** Дата з файлу: РРРР-ММ-ДД[ ГГ:ХХ] або ДД.ММ.РРРР[ ГГ:ХХ]; майбутня або нерозпізнана — зараз */
function dateOf(v) {
	const s = String(v || "").trim();
	let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
	if (!m) {
		const d = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s);
		if (d) m = [null, d[3], pad(d[2]), pad(d[1]), d[4] ? pad(d[4]) : null, d[5] || null];
	}
	if (!m) return null;
	const out = `${m[1]}-${m[2]}-${m[3]} ${m[4] || "00"}:${m[5] || "00"}:00`;
	return isNaN(Date.parse(out.replace(" ", "T"))) || out > nowSql() ? null : out;
}

async function importRow(r, opt, lk, idUser, idJob) {
	const contact = {};
	const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
	if (r.name) contact.name = str(r.name, 255);
	if (r.phone && /[\d]{5,}/.test(String(r.phone).replace(/\D/g, ""))) contact.phone = str(r.phone, 32);
	if (r.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(r.email).trim())) contact.email = str(r.email, 255).toLowerCase();
	if (r.company) contact.company = str(r.company, 255);
	if (r.position) contact.position = str(r.position, 255);
	const title = str(r.title, 500) || contact.company || contact.name || contact.phone || contact.email;
	if (!title) return "skip";
	const value = Math.max(0, Math.round((Number(String(r.value || "").replace(/\s/g, "").replace(",", ".")) || 0) * 100) / 100);
	const low = (v) => String(v || "").trim().toLowerCase();

	// Дублікати серед лідів (не в кошику)
	if (contact.phone || contact.email) {
		const found = await require("./dupes").matches({ id: 0, contact_info: contact }, null, 1);
		if (found.length && opt.duplicates === "skip") return "duplicate";
		if (found.length && opt.duplicates === "update") {
			const target = found[0];
			const [[cur]] = await pool.query(`SELECT id, value, note, website, contact_info, date_edit FROM \`${P}leads\` WHERE id = ?`, [target.id]);
			const ci = typeof cur.contact_info === "string" ? JSON.parse(cur.contact_info || "{}") : cur.contact_info || {};
			const set = {};
			let touched = false;
			for (const k of Object.keys(contact)) if (!ci[k]) (ci[k] = contact[k]), (touched = true);
			if (touched) set.contact_info = JSON.stringify(ci);
			if (!Number(cur.value) && value) set.value = value;
			if (!String(cur.website || "").trim() && r.website) set.website = str(r.website, 255);
			if (r.note) set.note = [cur.note, str(r.note, 10000)].map((x) => String(x || "").trim()).filter(Boolean).join("\n\n");
			if (!Object.keys(set).length) return "matched";
			await pool.query(`UPDATE \`${P}leads\` SET ?, date_edit = NOW() WHERE id = ?`, [set, target.id]);
			await pool.query(
				`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES (?, ?, 'field_change', ?, NULL, NULL, ?, 'import', NULL, NOW())`,
				[target.id, idUser, Object.keys(set).join(","), "import:" + idJob]
			);
			return "matched";
		}
	}

	const tagIds = new Set(opt.id_tag ? [opt.id_tag] : []);
	String(r.tags || "")
		.split(/[,;]/)
		.map(low)
		.filter(Boolean)
		.forEach((t) => lk.tag.has(t) && tagIds.add(lk.tag.get(t)));
	const utm = {};
	["utm_source", "utm_medium", "utm_campaign"].forEach((k) => r[k] && (utm[k] = str(r[k], 255)));
	const date = dateOf(r.date_add) || nowSql();
	const [ins] = await pool.query(`INSERT INTO \`${P}leads\` SET ?`, [
		{
			title,
			note: str(r.note, 65000),
			value,
			website: str(r.website, 255),
			id_pipeline: opt.id_pipeline,
			id_stage: lk.stage.get(low(r.stage)) || opt.id_stage,
			id_status: lk.status.get(low(r.status)) || opt.id_status,
			id_source: lk.source.get(low(r.source)) || opt.id_source || null,
			id_manager: lk.manager.get(low(r.manager)) || opt.id_manager || null,
			lead_source: str(r.source, 255),
			capture_type: "import",
			capture_ref: "import:" + idJob,
			contact_info: JSON.stringify(contact),
			utm: JSON.stringify(utm),
			date_add: date,
			date_edit: nowSql(),
		},
	]);
	const id = ins.insertId;
	if (tagIds.size) await pool.query(`INSERT IGNORE INTO \`${P}leads_tags_rel\` (id_lead, id_tag) VALUES ?`, [[...tagIds].map((t) => [id, t])]);
	await pool.query(
		`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES (?, ?, 'imported', NULL, NULL, NULL, ?, 'import', NULL, NOW())`,
		[id, idUser, "import:" + idJob]
	);
	if (opt.route) await require("./routing").assign(id).catch((e) => logging.error(e));
	return "created";
}

const running = new Set();
async function runJob(id) {
	if (running.has(id)) return;
	running.add(id);
	try {
		const [[job]] = await pool.query(`SELECT * FROM \`${P}leads_imports\` WHERE id = ?`, [id]);
		if (!job || job.status !== "running") return;
		const file = path.join(DIR, job.file_path);
		const rows = await readRows(file, path.extname(file).toLowerCase());
		const mapping = typeof job.mapping === "string" ? JSON.parse(job.mapping) : job.mapping;
		const opt = typeof job.options === "string" ? JSON.parse(job.options) : job.options || {};
		const errors = typeof job.errors === "string" ? JSON.parse(job.errors || "[]") : job.errors || [];
		const lk = await lookups(opt);
		let { processed, created, matched, skipped } = job;
		const flush = () => pool.query(`UPDATE \`${P}leads_imports\` SET processed = ?, created = ?, matched = ?, skipped = ?, errors = CAST(? AS JSON), date_edit = NOW() WHERE id = ?`, [processed, created, matched, skipped, JSON.stringify(errors.slice(0, MAX_ERRORS)), id]);
		for (let i = 1 + processed; i < rows.length; i++) {
			const rec = {};
			mapping.forEach((k, c) => {
				if (k && rows[i][c] != null && String(rows[i][c]).trim() !== "") rec[k] = String(rows[i][c]).trim();
			});
			try {
				const res = await importRow(rec, opt, lk, job.id_user, id);
				if (res === "created") created++;
				else if (res === "matched" || res === "duplicate") matched++;
				else {
					skipped++;
					if (errors.length < MAX_ERRORS) errors.push({ row: i + 1, error: "empty" });
				}
			} catch (e) {
				skipped++;
				if (errors.length < MAX_ERRORS) errors.push({ row: i + 1, error: String(e.message).slice(0, 200) });
			}
			processed++;
			if (processed % 50 === 0) {
				await flush();
				const [[s]] = await pool.query(`SELECT status FROM \`${P}leads_imports\` WHERE id = ?`, [id]);
				if (s.status !== "running") return;
			}
		}
		await flush();
		await pool.query(`UPDATE \`${P}leads_imports\` SET status = 'done', date_end = NOW() WHERE id = ? AND status = 'running'`, [id]);
		fs.unlink(file, () => {});
	} catch (e) {
		await pool.query(`UPDATE \`${P}leads_imports\` SET status = 'failed', error = ?, date_end = NOW() WHERE id = ?`, [String(e.message).slice(0, 500), id]).catch(() => {});
		throw e;
	} finally {
		running.delete(id);
	}
}

async function status(id, idUser) {
	const [[j]] = await pool.query(`SELECT id, file_name, status, total, processed, created, matched, skipped, errors, error, date_add, date_start, date_end FROM \`${P}leads_imports\` WHERE id = ? AND id_user = ?`, [id, idUser]);
	if (!j) throw httpErr(404, "leads.import.e.not_found");
	j.errors = typeof j.errors === "string" ? JSON.parse(j.errors || "[]") : j.errors || [];
	return j;
}

async function cancel(id, idUser) {
	const [r] = await pool.query(`UPDATE \`${P}leads_imports\` SET status = 'canceled', date_end = NOW() WHERE id = ? AND id_user = ? AND status IN ('uploaded', 'running')`, [id, idUser]);
	if (!r.affectedRows) throw httpErr(409, "leads.import.e.finished");
	return { ok: true };
}

/** Останні імпорти користувача (для сторінки) */
async function recent(idUser) {
	const [rows] = await pool.query(`SELECT id, file_name, status, total, processed, created, matched, skipped, date_add FROM \`${P}leads_imports\` WHERE id_user = ? ORDER BY id DESC LIMIT 10`, [idUser]);
	return rows;
}

async function recoverOnStartup() {
	const [rows] = await pool.query(`SELECT id FROM \`${P}leads_imports\` WHERE status = 'running'`);
	rows.forEach((r) => setImmediate(() => runJob(r.id).catch((e) => logging.error(e))));
	return rows.length;
}

module.exports = { TARGETS, guessMapping, dateOf, upload, start, status, cancel, recent, recoverOnStartup, importRow };