const fs = require("fs");
const path = require("path");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const dict = require("./dictionaries");
const history = require("./history");
const { resolveClient } = require("./service");

const P = config.get("configDatabase").prefix;
const DIR = path.join(__dirname, "../../storage/imports");
const MAX_ROWS = 50000;
const MAX_ERRORS = 500;

function httpErr(status, message) {
	const e = new Error(message);
	e.status = status;
	return e;
}

/** Поля, у які можна зіставити колонки файлу */
const TARGETS = [
	{ key: "name", label: "Імʼя повністю" },
	{ key: "first_name", label: "Імʼя" },
	{ key: "last_name", label: "Прізвище" },
	{ key: "middle_name", label: "По батькові" },
	{ key: "organization", label: "Компанія (назва)" },
	{ key: "phone", label: "Телефон" },
	{ key: "phone_2", label: "Телефон 2" },
	{ key: "email", label: "Email" },
	{ key: "email_2", label: "Email 2" },
	{ key: "identifier", label: "Реквізит (ЄДРПОУ / ІПН / VAT)" },
	{ key: "country", label: "Країна (ISO-2)" },
	{ key: "region", label: "Регіон" },
	{ key: "city", label: "Місто" },
	{ key: "address", label: "Адреса" },
	{ key: "postcode", label: "Індекс" },
	{ key: "external_id", label: "ID у зовнішній системі" },
	{ key: "tags", label: "Теги (через кому)" },
	{ key: "note", label: "Нотатка" },
];
const TARGET_KEYS = new Set(TARGETS.map((t) => t.key));

// Автозіставлення за назвою колонки (укр / рус / англ)
const GUESS = [
	["first_name", /^(імʼ?я|ім'я|имя|first ?name|firstname)$/i],
	["last_name", /^(прізвище|фамилия|last ?name|lastname|surname)$/i],
	["middle_name", /^(по ?батькові|отчество|middle ?name)$/i],
	["name", /^(піб|фіо|фио|name|full ?name|клієнт|клиент|контакт)$/i],
	["organization", /(компанія|компания|company|організація|организация|назва компанії)/i],
	["phone_2", /(телефон ?2|phone ?2|дод.*телефон)/i],
	["phone", /(телефон|phone|tel|моб)/i],
	["email_2", /(email ?2|e-mail ?2)/i],
	["email", /(e-?mail|пошта|почта)/i],
	["identifier", /(єдрпоу|едрпоу|іпн|инн|vat|tax|код)/i],
	["country", /^(країна|страна|country)$/i],
	["region", /(область|регіон|регион|region|state)/i],
	["city", /(місто|город|city)/i],
	["address", /(адреса|адрес|address|вулиця|улица)/i],
	["postcode", /(індекс|индекс|zip|postcode|postal)/i],
	["external_id", /^(id|external.?id|customer.?id)$/i],
	["tags", /(тег|tag)/i],
	["note", /(нотатка|примітка|коментар|комментарий|note|comment)/i],
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

// ─── Читання файлу ────────────────────────────────────────────────────────
/** CSV за RFC 4180: лапки, переноси в лапках, роздільник визначається автоматично */
function parseCsv(text) {
	const src = text.replace(/^\uFEFF/, "");
	const firstLine = src.split(/\r?\n/, 1)[0] || "";
	const delim = [";", ",", "\t", "|"].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];

	const rows = [];
	let row = [];
	let cell = "";
	let q = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (q) {
			if (ch === '"') {
				if (src[i + 1] === '"') {
					cell += '"';
					i++;
				} else q = false;
			} else cell += ch;
		} else if (ch === '"') q = true;
		else if (ch === delim) {
			row.push(cell);
			cell = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && src[i + 1] === "\n") i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += ch;
	}
	if (cell !== "" || row.length) {
		row.push(cell);
		rows.push(row);
	}
	return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

async function parseXlsx(file) {
	let ExcelJS;
	try {
		ExcelJS = require("exceljs");
	} catch (e) {
		throw httpErr(400, "Для Excel встановіть пакет exceljs (npm i exceljs) або збережіть файл як CSV.");
	}
	const wb = new ExcelJS.Workbook();
	await wb.xlsx.readFile(file);
	const ws = wb.worksheets[0];
	if (!ws) return [];
	const rows = [];
	ws.eachRow({ includeEmpty: false }, (r) => {
		const vals = [];
		for (let c = 1; c <= r.cellCount; c++) vals.push(String(r.getCell(c).text ?? "").trim());
		rows.push(vals);
	});
	return rows;
}

async function readRows(file, ext) {
	const rows = ext === ".xlsx" ? await parseXlsx(file) : parseCsv(fs.readFileSync(file, "utf8"));
	if (rows.length > MAX_ROWS + 1) throw httpErr(400, `У файлі понад ${MAX_ROWS} рядків — розбийте на частини.`);
	return rows;
}

// ─── Крок 1: завантаження ─────────────────────────────────────────────────
async function upload(fileBuf, originalName, idUser) {
	const ext = path.extname(String(originalName || "")).toLowerCase();
	if (![".csv", ".txt", ".xlsx"].includes(ext)) throw httpErr(400, "Підтримуються файли .csv та .xlsx.");

	fs.mkdirSync(DIR, { recursive: true });
	const [ins] = await pool.query(`INSERT INTO ${P}clients_imports (id_user, file_name, status, date_add, date_edit) VALUES (?, ?, 'uploaded', NOW(), NOW())`, [idUser, String(originalName).slice(0, 255)]);
	const id = ins.insertId;
	const file = path.join(DIR, id + ext);
	fs.writeFileSync(file, fileBuf);

	let rows;
	try {
		rows = await readRows(file, ext);
	} catch (e) {
		fs.unlink(file, () => {});
		await pool.query(`UPDATE ${P}clients_imports SET status = 'failed', error = ? WHERE id = ?`, [String(e.message).slice(0, 500), id]);
		throw e;
	}
	if (rows.length < 2) throw httpErr(400, "У файлі немає даних (потрібен рядок заголовків і хоча б один рядок).");

	const headers = rows[0].map((h, i) => String(h || "").trim() || "Колонка " + (i + 1));
	await pool.query(`UPDATE ${P}clients_imports SET file_path = ?, total = ?, headers = CAST(? AS JSON) WHERE id = ?`, [path.basename(file), rows.length - 1, JSON.stringify(headers), id]);

	return { id, headers, sample: rows.slice(1, 6), total: rows.length - 1, mapping: guessMapping(headers), targets: TARGETS };
}

// ─── Крок 2: запуск ───────────────────────────────────────────────────────
async function start(id, idUser, body) {
	const [[job]] = await pool.query(`SELECT * FROM ${P}clients_imports WHERE id = ? AND id_user = ?`, [id, idUser]);
	if (!job) throw httpErr(404, "Імпорт не знайдено.");
	if (job.status !== "uploaded") throw httpErr(409, "Цей імпорт уже запущено.");

	const headers = typeof job.headers === "string" ? JSON.parse(job.headers) : job.headers || [];
	const mapping = (Array.isArray(body.mapping) ? body.mapping : []).slice(0, headers.length).map((k) => (TARGET_KEYS.has(k) ? k : ""));
	if (!mapping.some((k) => ["phone", "email", "phone_2", "email_2", "identifier", "external_id"].includes(k))) {
		throw httpErr(400, "Зіставте хоча б одне поле для пошуку дублів: телефон, email, реквізит або зовнішній ID.");
	}

	const o = body.options || {};
	const options = {
		country: /^[A-Z]{2}$/.test(String(o.country || "").toUpperCase()) ? String(o.country).toUpperCase() : null,
		identifier_type: String(o.identifier_type || "") || null,
		id_manager: parseInt(o.id_manager, 10) || null,
		id_tag: parseInt(o.id_tag, 10) || null,
		lifecycle: String(o.lifecycle || "") || null,
		create_new: o.create_new === false || o.create_new === 0 || o.create_new === "0" ? 0 : 1,
	};

	const [r] = await pool.query(`UPDATE ${P}clients_imports SET status = 'running', mapping = CAST(? AS JSON), options = CAST(? AS JSON), date_start = NOW(), date_edit = NOW() WHERE id = ? AND status = 'uploaded'`, [JSON.stringify(mapping), JSON.stringify(options), id]);
	if (!r.affectedRows) throw httpErr(409, "Цей імпорт уже запущено.");

	setImmediate(() => runJob(id).catch((e) => console.error("[clients-import]", id, e)));
	return { ok: true, total: job.total, file_name: job.file_name };
}

// ─── Обробка (у фоні, з продовженням після рестарту) ──────────────────────
const running = new Set();

async function runJob(id) {
	if (running.has(id)) return;
	running.add(id);
	try {
		const [[job]] = await pool.query(`SELECT * FROM ${P}clients_imports WHERE id = ?`, [id]);
		if (!job || job.status !== "running") return;

		const file = path.join(DIR, job.file_path);
		const rows = await readRows(file, path.extname(file).toLowerCase());
		const mapping = typeof job.mapping === "string" ? JSON.parse(job.mapping) : job.mapping;
		const opt = typeof job.options === "string" ? JSON.parse(job.options) : job.options || {};
		const errors = typeof job.errors === "string" ? JSON.parse(job.errors || "[]") : job.errors || [];
		const h = history.ctxSystem("import", "import:" + id, job.id_user);
		const tagCache = new Map();

		let { processed, created, matched, skipped } = job;
		const flush = () =>
			pool.query(`UPDATE ${P}clients_imports SET processed = ?, created = ?, matched = ?, skipped = ?, errors = CAST(? AS JSON), date_edit = NOW() WHERE id = ?`, [processed, created, matched, skipped, JSON.stringify(errors.slice(0, MAX_ERRORS)), id]);

		for (let i = 1 + processed; i < rows.length; i++) {
			const rec = {};
			mapping.forEach((k, c) => {
				if (k && rows[i][c] != null && String(rows[i][c]).trim() !== "") rec[k] = String(rows[i][c]).trim();
			});
			try {
				const res = await importRow(rec, opt, h, tagCache);
				if (res === "skip") skipped++;
				else if (res.created) created++;
				else matched++;
			} catch (e) {
				skipped++;
				if (errors.length < MAX_ERRORS) errors.push({ row: i + 1, error: String(e.message).slice(0, 200) });
			}
			processed++;
			if (processed % 50 === 0) {
				await flush();
				const [[st]] = await pool.query(`SELECT status FROM ${P}clients_imports WHERE id = ?`, [id]);
				if (st.status !== "running") return; // скасовано
			}
		}
		await flush();
		await pool.query(`UPDATE ${P}clients_imports SET status = 'done', date_end = NOW() WHERE id = ? AND status = 'running'`, [id]);
		fs.unlink(file, () => {});
	} catch (e) {
		await pool.query(`UPDATE ${P}clients_imports SET status = 'failed', error = ?, date_end = NOW() WHERE id = ?`, [String(e.message).slice(0, 500), id]).catch(() => {});
		throw e;
	} finally {
		running.delete(id);
	}
}

/** Один рядок → resolveClient (дедуплікація) + тег + нотатка */
async function importRow(r, opt, h, tagCache) {
	const contacts = [
		{ type: "phone", value: r.phone },
		{ type: "phone", value: r.phone_2 },
		{ type: "email", value: r.email },
		{ type: "email", value: r.email_2 },
	].filter((c) => c.value);
	const identifiers = r.identifier ? [{ type: opt.identifier_type || "tax_id", value: r.identifier, country: r.country || opt.country }] : [];
	const externalIds = r.external_id ? [{ system: "import", id_integration: 0, external_id: r.external_id }] : [];
	if (!contacts.length && !identifiers.length && !externalIds.length) return "skip";

	const hasPerson = r.name || r.first_name || r.last_name;
	const kind = r.organization && !hasPerson ? "organization" : "person";
	const address = r.city || r.address || r.postcode ? { type: "shipping", country: r.country || opt.country, region: r.region, city: r.city, address_line: r.address, postcode: r.postcode } : null;

	const res = await resolveClient(
		{
			kind,
			name: kind === "organization" ? r.organization : r.name,
			person: kind === "person" ? { first_name: r.first_name, last_name: r.last_name, middle_name: r.middle_name } : undefined,
			organization: kind === "organization" ? { legal_name: r.organization } : undefined,
			contacts,
			identifiers,
			externalIds,
			addresses: address ? [address] : [],
			country: r.country || opt.country,
			lifecycleCode: opt.lifecycle || undefined,
			idManager: opt.id_manager,
			idUser: h.id_user,
			source: "import",
			sourceRef: h.source_ref,
		},
		{ createIfMissing: !!opt.create_new, history: h }
	);
	if (!res.id_client) return "skip";

	// Теги: з налаштувань імпорту + з колонки (лише наявні в довіднику, за назвою або кодом)
	const tagIds = new Set(opt.id_tag ? [opt.id_tag] : []);
	for (const name of String(r.tags || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
		if (!tagCache.has(name)) {
			const all = await dict.list("tags", null, { activeOnly: true });
			const hit = all.find((t) => String(t.name).toLowerCase() === name || String(t.code).toLowerCase() === name);
			tagCache.set(name, hit ? hit.id : null);
		}
		if (tagCache.get(name)) tagIds.add(tagCache.get(name));
	}
	if (tagIds.size) {
		const [ins] = await pool.query(`INSERT IGNORE INTO ${P}clients_tag_links (id_client, id_tag, id_user, date_add) VALUES ${[...tagIds].map(() => "(?, ?, ?, NOW())").join(", ")}`, [...tagIds].flatMap((t) => [res.id_client, t, h.id_user]));
		if (ins.affectedRows) await history.write(null, h, [...tagIds].map((t) => ({ id_client: res.id_client, action: "added", entity: "tag", id_entity: t, value_new: t })));
	}

	if (r.note) {
		await pool.query(`INSERT INTO ${P}clients_notes (id_client, id_user, body, mentions, is_pinned, date_add, date_edit) VALUES (?, ?, ?, JSON_ARRAY(), 0, NOW(), NOW())`, [res.id_client, h.id_user, r.note.slice(0, 10000)]);
	}
	return res;
}

async function status(id, idUser) {
	const [[j]] = await pool.query(`SELECT id, file_name, status, total, processed, created, matched, skipped, errors, error, date_add, date_start, date_end FROM ${P}clients_imports WHERE id = ? AND id_user = ?`, [id, idUser]);
	if (!j) throw httpErr(404, "Імпорт не знайдено.");
	j.errors = typeof j.errors === "string" ? JSON.parse(j.errors || "[]") : j.errors || [];
	return j;
}

async function cancel(id, idUser) {
	const [r] = await pool.query(`UPDATE ${P}clients_imports SET status = 'canceled', date_end = NOW() WHERE id = ? AND id_user = ? AND status IN ('uploaded', 'running')`, [id, idUser]);
	if (!r.affectedRows) throw httpErr(409, "Імпорт уже завершено.");
	return { ok: true };
}

/** Після рестарту сервера — продовжити незавершені імпорти з місця зупинки */
async function recoverOnStartup() {
	const [rows] = await pool.query(`SELECT id FROM ${P}clients_imports WHERE status = 'running'`);
	for (const r of rows) setImmediate(() => runJob(r.id).catch((e) => console.error("[clients-import]", r.id, e)));
	return rows.length;
}

module.exports = { TARGETS, upload, start, status, cancel, recoverOnStartup, parseCsv, guessMapping };