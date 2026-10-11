"use strict";
/**
 * Імпорт контактів з Excel (.xlsx) / CSV.
 *
 * Потік:
 *   1. uploadMiddleware (multer) → файл у assets/mailing/imports під випадковим іменем
 *   2. register()  — перевірка вмісту (сигнатура), запис у mailing_imports (status = uploaded)
 *   3. preview()   — перші 20 рядків, кількість колонок, автопошук колонки з email
 *   4. start()     — мапінг колонок + опції → status = queued
 *   5. tick()      — воркер (queue.js) обробляє файл потоково пачками, з продовженням після рестарту
 *   6. звіт відхилених рядків → assets/mailing/reports/*.csv; вихідний файл видаляється після обробки
 *
 * Безпека:
 *   - імʼя файлу на диску генерується (crypto), з БД читається лише basename → path traversal неможливий
 *   - перевірка сигнатури (.xlsx = ZIP, CSV = текст без NUL), ліміти розміру/рядків/колонок/довжини комірки
 *   - мапінг — лише з білого списку цілей; коди нових полів — регулярка model.FIELD_CODE_RE
 *   - SQL — тільки параметризований; масові вставки через VALUES ? (mysql2 екранує)
 *   - звіт CSV захищений від formula injection (=, +, -, @)
 *   - теки imports/ та reports/ закриті від статики в server.js
 * Тексти — лише коди (mailing.import.*), переклад у мовних файлах.
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns");
const model = require("./model");

const { pool, T, err } = model;

// ─── ШЛЯХИ ──────────────────────────────────────────────
const ROOT = path.join(__dirname, "..", "..", "assets", "mailing");
const IMPORT_DIR = path.join(ROOT, "imports");
const REPORT_DIR = path.join(ROOT, "reports");
for (const d of [IMPORT_DIR, REPORT_DIR]) fs.mkdirSync(d, { recursive: true, mode: 0o750 });

// Шлях лише з basename — навіть підмінене значення в БД не вийде за межі теки
const inDir = (dir, name) => (name ? path.join(dir, path.basename(String(name))) : null);

// ─── ЛІМІТИ ─────────────────────────────────────────────
const MAX_FILE = 50 * 1024 * 1024;
const MAX_ROWS = 1000000;
const MAX_COLS = 100;
const MAX_CELL = 1000;
const MAX_REPORT_LINES = 100000;
const BATCH = 500;
const PREVIEW_ROWS = 20;
const EXT = new Set([".xlsx", ".csv", ".txt"]);

const jsonOf = (v) => (typeof v === "string" ? JSON.parse(v) : v || null);
const WORKER = `${require("os").hostname()}:${process.pid}`.slice(0, 64);

// ─── ЗАВАНТАЖЕННЯ ───────────────────────────────────────
let uploader = null;
/** Multer-middleware для роуту завантаження: один файл у полі "file" */
function uploadMiddleware(req, res, next) {
	if (!uploader) {
		const multer = require("multer");
		uploader = multer({
			storage: multer.diskStorage({
				destination: (r, f, cb) => cb(null, IMPORT_DIR),
				filename: (r, f, cb) => cb(null, crypto.randomBytes(16).toString("hex") + path.extname(f.originalname || "").toLowerCase()),
			}),
			limits: { fileSize: MAX_FILE, files: 1, fields: 10, parts: 12 },
			fileFilter: (r, f, cb) => cb(null, EXT.has(path.extname(f.originalname || "").toLowerCase())),
		}).single("file");
	}
	uploader(req, res, (e) => {
		if (e) {
			const code = e.code === "LIMIT_FILE_SIZE" ? "file_too_large" : "upload_failed";
			return res.status(400).json({ ok: false, error: code });
		}
		next();
	});
}

const cleanName = (s) =>
	String(s || "file")
		.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
		.slice(0, 255);

/** Після multer: перевірка вмісту і запис у БД. file = req.file */
async function register(file, idUser) {
	if (!file || !file.filename) throw err(400, "file_required");
	const full = inDir(IMPORT_DIR, file.filename);
	const ext = path.extname(file.filename).toLowerCase();
	try {
		const fh = await fsp.open(full, "r");
		const buf = Buffer.alloc(65536);
		const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
		await fh.close();
		const head = buf.subarray(0, bytesRead);
		if (!bytesRead) throw err(400, "file_empty");
		if (ext === ".xlsx") {
			if (!(head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)) throw err(400, "file_invalid");
		} else if (head.includes(0x00)) {
			throw err(400, "file_invalid"); // бінарний файл під виглядом CSV (у т.ч. старий .xls)
		}
		const [r] = await pool.query(`INSERT INTO ${T.imports} (id_user, file_name, file_path, status, date_add) VALUES (?, ?, ?, 'uploaded', UTC_TIMESTAMP())`, [idUser || null, cleanName(file.originalname), path.basename(full)]);
		return { ok: true, id: r.insertId };
	} catch (e) {
		await fsp.unlink(full).catch(() => {});
		throw e;
	}
}

// ─── ЧИТАННЯ ФАЙЛУ ──────────────────────────────────────
function cellText(v) {
	if (v == null) return "";
	if (v instanceof Date) return isNaN(v) ? "" : v.toISOString().slice(0, 10);
	if (typeof v === "object") {
		if (Array.isArray(v.richText)) return v.richText.map((x) => x.text || "").join("");
		if (v.text != null) return typeof v.text === "object" ? cellText(v.text) : String(v.text);
		if (v.result != null) return cellText(v.result);
		if (v.hyperlink) return String(v.hyperlink).replace(/^mailto:/i, "");
		return "";
	}
	return String(v);
}

const clip = (s) =>
	String(s ?? "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.trim()
		.slice(0, MAX_CELL);

/** Кодування і роздільник CSV — за першими 64 КБ */
async function sniffCsv(full) {
	const fh = await fsp.open(full, "r");
	const buf = Buffer.alloc(65536);
	const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
	await fh.close();
	let head = buf.subarray(0, bytesRead);
	let encoding = "utf-8";
	// Обрізаємо незавершений символ UTF-8 у кінці фрагмента
	let end = head.length;
	while (end > 0 && end > head.length - 4 && (head[end - 1] & 0xc0) === 0x80) end--;
	if (end > 0 && head[end - 1] >= 0xc0) end--;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, end));
	} catch (e) {
		encoding = "windows-1251"; // типовий експорт Excel у кирилиці
	}
	const text = new TextDecoder(encoding).decode(head);
	const line = text.replace(/^﻿/, "").split(/\r?\n/)[0] || "";
	const unquoted = line.replace(/"[^"]*"/g, "");
	let delimiter = ",";
	let best = -1;
	for (const d of [",", ";", "\t", "|"]) {
		const n = unquoted.split(d).length - 1;
		if (n > best) {
			best = n;
			delimiter = d;
		}
	}
	return { encoding, delimiter };
}

/** Асинхронний генератор рядків: масиви рядків (string) */
async function* rowsOf(full) {
	const ext = path.extname(full).toLowerCase();
	if (ext === ".xlsx") {
		const ExcelJS = require("exceljs");
		const reader = new ExcelJS.stream.xlsx.WorkbookReader(full, { sharedStrings: "cache", hyperlinks: "ignore", styles: "ignore", worksheets: "emit", entries: "emit" });
		for await (const ws of reader) {
			for await (const row of ws) {
				const vals = row.values || [];
				const out = [];
				for (let i = 1; i < Math.min(vals.length, MAX_COLS + 1); i++) out.push(clip(cellText(vals[i])));
				yield { n: row.number, cells: out };
			}
			break; // лише перший аркуш
		}
		return;
	}

	const { parse } = require("csv-parse");
	const { encoding, delimiter } = await sniffCsv(full);
	const src = fs.createReadStream(full, { highWaterMark: 256 * 1024 });
	const decoder = new TextDecoder(encoding);
	const parser = parse({ delimiter, bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, max_record_size: 1024 * 1024, to: MAX_ROWS + 1 });
	(async () => {
		try {
			for await (const chunk of src) if (!parser.write(decoder.decode(chunk, { stream: true }))) await new Promise((r) => parser.once("drain", r));
			parser.end(decoder.decode());
		} catch (e) {
			parser.destroy(e);
		}
	})();
	let n = 0;
	try {
		for await (const rec of parser) {
			n++;
			yield { n, cells: rec.slice(0, MAX_COLS).map(clip) };
		}
	} finally {
		src.destroy();
		parser.destroy();
	}
}

// ─── ПРЕВʼЮ ─────────────────────────────────────────────
async function getImport(id) {
	const [[imp]] = await pool.query(`SELECT * FROM ${T.imports} WHERE id = ?`, [id]);
	return imp || null;
}

async function preview(id) {
	const imp = await getImport(id);
	if (!imp) throw err(404, "not_found");
	if (imp.status !== "uploaded") throw err(409, "import_already_started");
	const full = inDir(IMPORT_DIR, imp.file_path);
	const rows = [];
	let columns = 0;
	for await (const r of rowsOf(full)) {
		rows.push(r.cells);
		columns = Math.max(columns, r.cells.length);
		if (rows.length > PREVIEW_ROWS) break;
	}
	if (!rows.length) throw err(400, "file_empty");

	// Колонка з email — за вмістом (не за назвою заголовка: назви бувають будь-якою мовою)
	let emailColumn = null;
	let bestHits = 0;
	for (let c = 0; c < columns; c++) {
		const hits = rows.filter((r) => model.normalizeEmail(r[c])).length;
		if (hits > bestHits) {
			bestHits = hits;
			emailColumn = c;
		}
	}
	const firstIsHeader = emailColumn !== null && !model.normalizeEmail(rows[0][emailColumn]);
	return { id: imp.id, file_name: imp.file_name, columns, rows, email_column: emailColumn, has_header: firstIsHeader };
}

// ─── СТАРТ ──────────────────────────────────────────────
const TARGETS = new Set(["email", "first_name", "last_name", "lang", "timezone", "country"]);
const FIELD_TYPES = new Set(["text", "number", "date", "bool"]);

/**
 * b: {
 *   mapping: { "<індекс колонки>": "email" | "first_name" | "last_name" | "lang" | "timezone" | "country" | "field:<code>" | "skip" },
 *   new_fields: { "<code>": { name, type } },     — нові власні поля, створюються перед імпортом
 *   lists: [id...], consent_source: "<звідки згода>",
 *   has_header, update_existing, id_lang, check_mx, skip_role, skip_disposable
 * }
 */
async function start(id, b, idUser) {
	const imp = await getImport(id);
	if (!imp) throw err(404, "not_found");
	if (imp.status !== "uploaded") throw err(409, "import_already_started");

	const errors = [];
	const mapping = {};
	let hasEmail = false;
	const fieldCodes = new Set((await model.fields()).map((f) => f.code));
	const newFields = {};

	for (const [code, f] of Object.entries((b && b.new_fields) || {}).slice(0, 50)) {
		const c = String(code).trim().toLowerCase();
		if (!model.FIELD_CODE_RE.test(c) || model.RESERVED_FIELDS.has(c)) {
			errors.push({ field: "new_fields." + code, message: "invalid_field_code" });
			continue;
		}
		const name = String((f && f.name) || "").trim().slice(0, 128);
		if (!name) errors.push({ field: "new_fields." + code, message: "required" });
		newFields[c] = { name, type: FIELD_TYPES.has(f && f.type) ? f.type : "text" };
	}

	const used = new Set();
	for (const [col, target] of Object.entries((b && b.mapping) || {})) {
		const idx = parseInt(col, 10);
		if (!(idx >= 0 && idx < MAX_COLS) || String(idx) !== String(col)) {
			errors.push({ field: "mapping", message: "invalid_column" });
			continue;
		}
		const tg = String(target || "skip");
		if (tg === "skip") continue;
		if (TARGETS.has(tg)) {
			if (used.has(tg)) errors.push({ field: "mapping." + col, message: "duplicate_target" });
			used.add(tg);
			if (tg === "email") hasEmail = true;
			mapping[idx] = tg;
			continue;
		}
		const m = /^field:([a-z][a-z0-9_]{0,63})$/.exec(tg);
		if (m && (fieldCodes.has(m[1]) || newFields[m[1]]) && !used.has(tg)) {
			used.add(tg);
			mapping[idx] = tg;
			continue;
		}
		errors.push({ field: "mapping." + col, message: "invalid_target" });
	}
	if (!hasEmail) errors.push({ field: "mapping", message: "email_column_required" });

	const lists = model.ints(b && b.lists).slice(0, 50);
	if (!lists.length) errors.push({ field: "lists", message: "required" });
	else {
		const [rows] = await pool.query(`SELECT id FROM ${T.lists} WHERE id IN (?) AND deleted = 0`, [lists]);
		if (rows.length !== lists.length) errors.push({ field: "lists", message: "invalid_list" });
	}

	const consent = String((b && b.consent_source) || "").trim().slice(0, 255);
	if (consent.length < 3) errors.push({ field: "consent_source", message: "required" });

	const langs = await model.languages();
	const s = await model.getSettings();
	const idLang = parseInt(b && b.id_lang, 10);
	if (b && b.id_lang && !langs.has(idLang)) errors.push({ field: "id_lang", message: "invalid" });

	if (errors.length) throw err(400, "validation_error", { status: "error", errors });

	for (const [code, f] of Object.entries(newFields)) await model.ensureField(null, code, f.name, f.type);

	const options = {
		lists,
		consent_source: consent,
		has_header: !!(b && b.has_header),
		update_existing: !!(b && b.update_existing),
		id_lang: langs.has(idLang) ? idLang : s.default_id_lang,
		check_mx: b && b.check_mx !== undefined ? !!b.check_mx : true,
		skip_role: !!(b && b.skip_role),
		skip_disposable: b && b.skip_disposable !== undefined ? !!b.skip_disposable : true,
	};
	const [r] = await pool.query(`UPDATE ${T.imports} SET status = 'queued', mapping = ?, options = ?, id_user = COALESCE(id_user, ?) WHERE id = ? AND status = 'uploaded'`, [JSON.stringify(mapping), JSON.stringify(options), idUser || null, id]);
	if (!r.affectedRows) throw err(409, "import_already_started");
	return { ok: true };
}

async function cancel(id) {
	const [r] = await pool.query(`UPDATE ${T.imports} SET status = 'cancelled', date_finish = UTC_TIMESTAMP() WHERE id = ? AND status IN ('uploaded','queued','processing')`, [id]);
	if (!r.affectedRows) throw err(409, "import_not_cancellable");
	const imp = await getImport(id);
	if (imp && imp.status === "cancelled" && imp.locked_by === null) await fsp.unlink(inDir(IMPORT_DIR, imp.file_path)).catch(() => {});
	return { ok: true };
}

// ─── ДОМЕНИ: MX + ОДНОРАЗОВІ ────────────────────────────
let DISPOSABLE = null;
function disposableSet() {
	if (!DISPOSABLE) {
		try {
			DISPOSABLE = new Set(require("disposable-email-domains"));
		} catch (e) {
			DISPOSABLE = new Set();
		}
	}
	return DISPOSABLE;
}

const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
const DNS_NOT_FOUND = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

async function hasMail(domain) {
	try {
		if ((await resolver.resolveMx(domain)).some((m) => m.exchange && m.exchange !== ".")) return true;
	} catch (e) {
		if (!DNS_NOT_FOUND.has(e.code)) return null; // збій DNS — не вирішуємо
	}
	try {
		return (await resolver.resolve4(domain)).length > 0; // неявний MX (RFC 5321)
	} catch (e) {
		return DNS_NOT_FOUND.has(e.code) ? false : null;
	}
}

/** → Map(domain → {mx_ok, disposable}). Кеш у mailing_domains на 30 днів. */
async function checkDomains(domains, checkMx) {
	const out = new Map();
	const list = [...new Set(domains)];
	if (!list.length) return out;
	const disp = disposableSet();
	for (const d of list) out.set(d, { mx_ok: true, disposable: disp.has(d) });
	if (!checkMx) return out;

	const [cached] = await pool.query(`SELECT domain, mx_ok FROM ${T.domains} WHERE domain IN (?) AND date_check >= UTC_TIMESTAMP() - INTERVAL 30 DAY`, [list]);
	const known = new Set();
	for (const r of cached) {
		out.get(r.domain).mx_ok = !!r.mx_ok;
		known.add(r.domain);
	}
	const todo = list.filter((d) => !known.has(d));
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(10, todo.length) }, async () => {
			while (i < todo.length) {
				const d = todo[i++];
				const ok = await hasMail(d);
				if (ok === null) continue; // невизначено — вважаємо робочим, не кешуємо
				out.get(d).mx_ok = ok;
				await pool.query(
					`INSERT INTO ${T.domains} (domain, mx_ok, disposable, date_check) VALUES (?, ?, ?, UTC_TIMESTAMP()) AS n
                     ON DUPLICATE KEY UPDATE mx_ok = n.mx_ok, disposable = n.disposable, date_check = n.date_check`,
					[d, ok ? 1 : 0, out.get(d).disposable ? 1 : 0]
				);
			}
		})
	);
	return out;
}

// ─── ЗВІТ ВІДХИЛЕНИХ ────────────────────────────────────
// Захист від formula injection при відкритті в Excel
const csvCell = (v) => {
	let s = String(v ?? "");
	if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
	return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

class Report {
	constructor(imp) {
		this.name = imp.errors_path ? path.basename(imp.errors_path) : `import-${imp.id}-${crypto.randomBytes(8).toString("hex")}.csv`;
		this.full = inDir(REPORT_DIR, this.name);
		this.lines = 0;
		this.stream = null;
		this.resumed = !!imp.errors_path;
	}
	add(row, email, reason) {
		if (this.lines >= MAX_REPORT_LINES) return;
		if (!this.stream) {
			const exists = this.resumed && fs.existsSync(this.full);
			this.stream = fs.createWriteStream(this.full, { flags: "a", mode: 0o640 });
			if (!exists) this.stream.write("﻿row,email,reason\r\n");
		}
		this.lines++;
		this.stream.write(`${row},${csvCell(email)},${reason}\r\n`);
	}
	async close() {
		if (this.stream) await new Promise((r) => this.stream.end(r));
		return this.stream || this.resumed ? this.name : null;
	}
}

// ─── ОБРОБКА ПАЧКИ ──────────────────────────────────────
async function flushBatch(imp, opt, mapping, batch, report, idLangByIso) {
	const c = { created: 0, updated: 0, skipped: 0, invalid: 0, suppressed: 0 };
	const reject = (row, email, reason, counter) => {
		c[counter]++;
		report.add(row.n, email, reason);
	};

	// 1. Нормалізація
	const items = [];
	const seen = new Set();
	for (const row of batch) {
		const rec = { n: row.n, fields: {} };
		let rawEmail = "";
		for (const [idx, tg] of Object.entries(mapping)) {
			const v = row.cells[idx] ?? "";
			if (tg === "email") rawEmail = v;
			else if (tg === "first_name" || tg === "last_name") rec[tg] = v.slice(0, 128) || null;
			else if (tg === "lang") rec.id_lang = idLangByIso.get(v.toLowerCase()) || null;
			else if (tg === "timezone") rec.timezone = v && model.isValidTz(v) ? v.slice(0, 64) : null;
			else if (tg === "country") rec.country = /^[a-z]{2}$/i.test(v) ? v.toUpperCase() : null;
			else if (tg.startsWith("field:") && v !== "") rec.fields[tg.slice(6)] = v;
		}
		if (!rawEmail) {
			reject(row, "", "empty_email", "invalid");
			continue;
		}
		const n = model.normalizeEmail(rawEmail);
		if (!n) {
			reject(row, rawEmail, "invalid_email", "invalid");
			continue;
		}
		if (seen.has(n.email)) {
			reject(row, n.email, "duplicate", "skipped");
			continue;
		}
		seen.add(n.email);
		if (opt.skip_role && n.is_role) {
			reject(row, n.email, "role", "skipped");
			continue;
		}
		Object.assign(rec, n);
		items.push(rec);
	}
	if (!items.length) return c;

	// 2. Домени
	const dom = await checkDomains(
		items.map((x) => x.domain),
		opt.check_mx
	);
	let valid = items.filter((x) => {
		const d = dom.get(x.domain);
		if (opt.check_mx && !d.mx_ok) return reject(x, x.email, "no_mx", "invalid"), false;
		if (opt.skip_disposable && d.disposable) return reject(x, x.email, "disposable", "invalid"), false;
		return true;
	});
	if (!valid.length) return c;

	// 3. Стоп-лист — такі адреси НІКОЛИ не відновлюються імпортом
	const [supp] = await pool.query(`SELECT type, value FROM ${T.supp} WHERE (type = 'email' AND value IN (?)) OR (type = 'domain' AND value IN (?))`, [valid.map((x) => x.email), [...new Set(valid.map((x) => x.domain))]]);
	const suppEmail = new Set(supp.filter((r) => r.type === "email").map((r) => r.value));
	const suppDomain = new Set(supp.filter((r) => r.type === "domain").map((r) => r.value));
	valid = valid.filter((x) => {
		if (suppEmail.has(x.email) || suppDomain.has(x.domain)) return reject(x, x.email, "suppressed", "suppressed"), false;
		return true;
	});
	if (!valid.length) return c;

	await model.withTx(async (conn) => {
		// 4. Хто вже існує
		const emails = valid.map((x) => x.email);
		const [existing] = await conn.query(`SELECT id, email, status, deleted FROM ${T.contacts} WHERE email IN (?)`, [emails]);
		const exMap = new Map(existing.map((r) => [r.email, r]));

		// 5. Масовий upsert
		const hasLangCol = Object.values(mapping).includes("lang");
		const upd = opt.update_existing
			? `first_name = COALESCE(n.first_name, ${T.contacts}.first_name),
               last_name  = COALESCE(n.last_name, ${T.contacts}.last_name),
               ${hasLangCol ? "id_lang = n.id_lang," : ""}
               timezone   = COALESCE(n.timezone, ${T.contacts}.timezone),
               country    = COALESCE(n.country, ${T.contacts}.country),
               fields     = IF(n.fields IS NULL, ${T.contacts}.fields, JSON_MERGE_PATCH(COALESCE(${T.contacts}.fields, JSON_OBJECT()), n.fields)),
               date_edit  = UTC_TIMESTAMP(),`
			: "";
		const values = valid.map((x) => [x.email, x.domain, x.first_name || null, x.last_name || null, x.id_lang || opt.id_lang, x.timezone || null, x.country || null, Object.keys(x.fields).length ? JSON.stringify(x.fields) : null, x.is_role ? 1 : 0, "import", imp.id]);
		await conn.query(
			`INSERT INTO ${T.contacts} (email, email_domain, first_name, last_name, id_lang, timezone, country, fields, is_role, source, id_import, date_add)
             VALUES ${values.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())").join(", ")} AS n
             ON DUPLICATE KEY UPDATE ${upd} deleted = 0, date_deleted = NULL, id_user_deleted = NULL`,
			values.flat()
		);

		const [rows] = await conn.query(`SELECT id, email, status FROM ${T.contacts} WHERE email IN (?)`, [emails]);
		const byEmail = new Map(rows.map((r) => [r.email, r]));

		// 6. Підписки — лише активним; відписаних від списку не повертаємо
		const active = [];
		for (const x of valid) {
			const r = byEmail.get(x.email);
			if (!r) continue;
			if (exMap.has(x.email)) c.updated++;
			else c.created++;
			if (r.status !== "active") {
				c.skipped++;
				report.add(x.n, x.email, "unsubscribed");
				continue;
			}
			active.push(r.id);
		}
		if (!active.length) return;

		const subs = [];
		const consents = [];
		const source = `import:${imp.id}`;
		for (const idC of active) {
			for (const idL of opt.lists) {
				subs.push([idC, idL, "subscribed", "import"]);
				consents.push([idC, idL, "import", source, imp.id_user || null, opt.consent_source]);
			}
		}
		await conn.query(
			`INSERT INTO ${T.subs} (id_contact, id_list, status, source, date_subscribed, date_confirmed)
             VALUES ${subs.map(() => "(?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())").join(", ")} AS n
             ON DUPLICATE KEY UPDATE
                date_subscribed = IF(${T.subs}.status = 'pending', n.date_subscribed, ${T.subs}.date_subscribed),
                date_confirmed  = IF(${T.subs}.status = 'pending', n.date_confirmed, ${T.subs}.date_confirmed),
                status          = IF(${T.subs}.status = 'pending', 'subscribed', ${T.subs}.status)`,
			subs.flat()
		);
		await conn.query(
			`INSERT INTO ${T.consents} (id_contact, id_list, action, source, id_user, note, date_add)
             VALUES ${consents.map(() => "(?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())").join(", ")}`,
			consents.flat()
		);
	});
	return c;
}

// ─── ОБРОБКА ФАЙЛУ ──────────────────────────────────────
async function processImport(imp) {
	const opt = jsonOf(imp.options);
	const mapping = jsonOf(imp.mapping);
	const full = inDir(IMPORT_DIR, imp.file_path);
	const report = new Report(imp);
	const langs = await model.languages();
	const idLangByIso = new Map([...langs].map(([id, iso]) => [iso, id]));
	const skipUntil = Number(imp.rows_processed) || 0; // продовження після рестарту

	let batch = [];
	let lastRow = skipUntil;
	let dataRows = 0;

	const flush = async () => {
		const c = await flushBatch(imp, opt, mapping, batch, report, idLangByIso);
		const [r] = await pool.query(
			`UPDATE ${T.imports}
                SET rows_processed = ?, cnt_created = cnt_created + ?, cnt_updated = cnt_updated + ?, cnt_skipped = cnt_skipped + ?,
                    cnt_invalid = cnt_invalid + ?, cnt_suppressed = cnt_suppressed + ?, errors_path = COALESCE(errors_path, ?)
              WHERE id = ? AND status = 'processing'`,
			[lastRow, c.created, c.updated, c.skipped, c.invalid, c.suppressed, report.lines ? report.name : null, imp.id]
		);
		batch = [];
		return r.affectedRows > 0; // false — імпорт скасовано
	};

	let stopped = false;
	for await (const row of rowsOf(full)) {
		if (row.n <= skipUntil) continue;
		if (opt.has_header && row.n === 1) {
			lastRow = row.n;
			continue;
		}
		if (++dataRows > MAX_ROWS) break;
		if (row.cells.every((x) => !x)) {
			lastRow = row.n;
			continue;
		}
		batch.push(row);
		lastRow = row.n;
		if (batch.length >= BATCH && !(await flush())) {
			stopped = true;
			break;
		}
	}
	if (!stopped && batch.length) stopped = !(await flush());

	const reportName = await report.close();
	if (stopped) {
		await fsp.unlink(full).catch(() => {});
		return;
	}
	await model.linkClients().catch((e) => console.error("[mailing:import] link clients", e.message));
	await pool.query(
		`UPDATE ${T.imports}
            SET status = 'done', rows_total = ?, errors_path = ?, date_finish = UTC_TIMESTAMP(), locked_by = NULL
          WHERE id = ? AND status = 'processing'`,
		[dataRows + skipUntil, reportName, imp.id]
	);
	// Персональні дані не зберігаємо довше, ніж потрібно
	await fsp.unlink(full).catch(() => {});
}

// ─── ВОРКЕР ─────────────────────────────────────────────
/** Після рестарту — продовжити імпорти, що обробляв цей процес */
async function recover() {
	await pool.query(`UPDATE ${T.imports} SET status = 'queued', locked_by = NULL WHERE status = 'processing'`);
}

async function tick() {
	const [r] = await pool.query(
		`UPDATE ${T.imports} SET status = 'processing', locked_by = ?, date_start = COALESCE(date_start, UTC_TIMESTAMP())
          WHERE status = 'queued' ORDER BY id LIMIT 1`,
		[WORKER]
	);
	if (!r.affectedRows) return;
	const [[imp]] = await pool.query(`SELECT * FROM ${T.imports} WHERE status = 'processing' AND locked_by = ? ORDER BY id LIMIT 1`, [WORKER]);
	if (!imp) return;
	try {
		if (!fs.existsSync(inDir(IMPORT_DIR, imp.file_path))) throw err(400, "file_missing");
		await processImport(imp);
	} catch (e) {
		console.error("[mailing:import]", imp.id, e.message);
		await pool.query(`UPDATE ${T.imports} SET status = 'failed', error_message = ?, date_finish = UTC_TIMESTAMP(), locked_by = NULL WHERE id = ?`, [String(e.status ? e.message : "import_error").slice(0, 1000), imp.id]);
		await fsp.unlink(inDir(IMPORT_DIR, imp.file_path)).catch(() => {});
	}
}

/** Прибирання: незапущені завантаження > 24 год, звіти > 30 днів */
async function cleanup() {
	const [stale] = await pool.query(`SELECT id, file_path FROM ${T.imports} WHERE status = 'uploaded' AND date_add < UTC_TIMESTAMP() - INTERVAL 1 DAY LIMIT 500`);
	for (const r of stale) {
		await fsp.unlink(inDir(IMPORT_DIR, r.file_path)).catch(() => {});
		await pool.query(`UPDATE ${T.imports} SET status = 'cancelled', date_finish = UTC_TIMESTAMP() WHERE id = ? AND status = 'uploaded'`, [r.id]);
	}
	const [old] = await pool.query(`SELECT id, errors_path FROM ${T.imports} WHERE errors_path IS NOT NULL AND date_finish < UTC_TIMESTAMP() - INTERVAL 30 DAY LIMIT 500`);
	for (const r of old) {
		await fsp.unlink(inDir(REPORT_DIR, r.errors_path)).catch(() => {});
		await pool.query(`UPDATE ${T.imports} SET errors_path = NULL WHERE id = ?`, [r.id]);
	}
	// Осиротілі файли (multer записав, а register не відбувся)
	const [known] = await pool.query(`SELECT file_path FROM ${T.imports} WHERE status IN ('uploaded','queued','processing')`);
	const keep = new Set(known.map((r) => path.basename(r.file_path)));
	for (const f of await fsp.readdir(IMPORT_DIR).catch(() => [])) {
		if (keep.has(f)) continue;
		const st = await fsp.stat(path.join(IMPORT_DIR, f)).catch(() => null);
		if (st && st.isFile() && Date.now() - st.mtimeMs > 3600000) await fsp.unlink(path.join(IMPORT_DIR, f)).catch(() => {});
	}
}

// ─── ДЛЯ АДМІНКИ ────────────────────────────────────────
const LIST_COLS = `id, file_name, status, rows_total, rows_processed, cnt_created, cnt_updated, cnt_skipped, cnt_invalid, cnt_suppressed,
                   (errors_path IS NOT NULL) AS has_report, error_message, id_user, date_add, date_start, date_finish`;

async function list(b) {
	const page = Math.max(1, parseInt(b && b.page, 10) || 1);
	const size = Math.min(100, Math.max(1, parseInt(b && b.size, 10) || 20));
	const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.imports}`);
	const [rows] = await pool.query(`SELECT ${LIST_COLS} FROM ${T.imports} ORDER BY id DESC LIMIT ? OFFSET ?`, [size, (page - 1) * size]);
	const total = Number(cnt.n) || 0;
	return { last_page: Math.max(1, Math.ceil(total / size)), last_row: total, data: rows };
}

async function status(id) {
	const [[r]] = await pool.query(`SELECT ${LIST_COLS} FROM ${T.imports} WHERE id = ?`, [id]);
	if (!r) throw err(404, "not_found");
	return r;
}

/** Абсолютний шлях до звіту для res.download() у роуті з авторизацією */
async function reportFile(id) {
	const [[r]] = await pool.query(`SELECT errors_path FROM ${T.imports} WHERE id = ?`, [id]);
	const full = r && inDir(REPORT_DIR, r.errors_path);
	if (!full || !fs.existsSync(full)) throw err(404, "not_found");
	return { full, name: `import-${parseInt(id, 10)}-errors.csv` };
}

module.exports = { uploadMiddleware, register, preview, start, cancel, list, status, reportFile, tick, recover, cleanup, IMPORT_DIR, REPORT_DIR };