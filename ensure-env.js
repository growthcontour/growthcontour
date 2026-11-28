"use strict";

/**
 * Запуск системи: .env → MySQL → база → адміністратор. Викликається першим рядком server.js.
 *
 * 1. .env (синхронно, у процесі server.js)
 *    - немає → створюється з шаблону: секрети, VAPID і префікс таблиць генеруються, поля користувача — заглушка __REQUIRED__;
 *      запис атомарний (тимчасовий файл + link), права 600 — кілька процесів pm2 не створять файл двічі;
 *    - є → дописуються лише відсутні ключі (під блокуванням .env.lock), наявні значення не змінюються ніколи;
 *    - лишилась заглушка → список полів і вихід з кодом 78 (EX_CONFIG): pm2 із --stop-exit-codes 78 не перезапускає по колу.
 * 2. База (окремим процесом node ensure-env.js --db, синхронно через spawnSync — server.js лишається лінійним):
 *    - підключення, MySQL 8.0+; доступ заборонено / бази немає → 78; MySQL ще не піднявся → 1 (pm2 повторить);
 *    - таблиць із префіксом немає → установка database.sql під GET_LOCK (префікс дампу — з його заголовка: «table prefix: …» або «префікс таблиць: …»; «prefix_» за замовчуванням,
 *      замінюється лише в назвах у зворотних лапках) і перший адміністратор із ADMIN_EMAIL у групі 1, пароль — один раз у консоль;
 *    - таблиці є, користувачі є → система встановлена;
 *    - таблиці є, користувачів немає: усі таблиці database.sql і довідники на місці (схему імпортовано вручну) → лише адміністратор;
 *      бракує таблиць або довідників (установка обірвалась) → нічого не перезаписуємо, 78.
 *    - на кожному запуску (крім щойно встановленої) — звірка з database.sql: таблиці, колонки (тип, NULL, DEFAULT), індекси, FK;
 *      SCHEMA_CHECK=strict — бракує об'єктів або інший тип / NULL → 78; warn — лише звіт; повний звіт — logs/schema-check.log.
 * 3. started() — останній рядок «Система запущена і працює» (з server.js після запуску HTTP і модулів).
 *
 * Вивід — лише кроки запуску; кольори: TTY або pm2, NO_COLOR вимикає, FORCE_COLOR вмикає. У кластері pm2 кроки друкує процес 0.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ENV_PATH = path.join(__dirname, ".env");
const LOCK_PATH = ENV_PATH + ".lock";
const SQL_PATH = path.join(__dirname, "database.sql");
const REQUIRED = "__REQUIRED__";
const EX_CONFIG = 78;
// Поля, які потрібні лише для установки бази (на встановленій системі не вимагаються)
const INSTALL_ONLY = new Set(["ADMIN_EMAIL"]);

/* ─── Вивід ─── */

const COLOR = (() => {
	if ("NO_COLOR" in process.env) return false;
	if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== "0";
	return !!process.stdout.isTTY || process.env.pm_id !== undefined;
})();
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { bold: paint(1), dim: paint(90), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36) };
const INSTANCE = process.env.NODE_APP_INSTANCE !== undefined ? process.env.NODE_APP_INSTANCE : process.env.PM2_INSTANCE;
const PRIMARY = INSTANCE === undefined || String(INSTANCE) === "0";

const say = (line, force) => (PRIMARY || force) && process.stdout.write(line + "\n");
const since = (t) => {
	const ms = Date.now() - t;
	return ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : ms + " ms";
};
function ok(label, detail, t, force) {
	const text = label + (detail ? " · " + detail : "");
	say(`${c.green("✔")} ${text}${t ? " " + " ".repeat(Math.max(1, 44 - text.length)) + c.dim(since(t)) : ""}`, force);
}
function todo(title, lines) {
	say(`${c.yellow("!")} ${title}`, true);
	for (const l of lines) say("  " + c.yellow(l), true);
}
/** Помилка кроку — завжди (stderr), з причиною і порадою; далі вихід */
function fail(label, reason, hints, code) {
	process.stderr.write(`${c.red("✖")} ${label}\n`);
	if (reason) process.stderr.write(`  ${reason}\n`);
	for (const h of hints || []) process.stderr.write(`  ${c.yellow(h)}\n`);
	process.exit(code === undefined ? EX_CONFIG : code);
}

/* ─── Генератори ─── */

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
/** Префікс як в OpenCart: літера + 7 літер/цифр + «_» (k4m9x2qa_) */
function genPrefix() {
	let p = ALNUM[crypto.randomInt(26)];
	for (let i = 0; i < 7; i++) p += ALNUM[crypto.randomInt(ALNUM.length)];
	return p + "_";
}
/** Доступ захисного входу: логін g + 6 hex, пароль 24 символи — «логін:пароль» */
function genGateUser() {
	return "g" + crypto.randomBytes(3).toString("hex") + ":" + genPassword(24);
}

/** Пароль адміністратора: 20 символів без схожих (0/O, 1/l/I) */
function genPassword(len) {
	const A = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
	let p = "";
	for (let i = 0; i < (len || 20); i++) p += A[crypto.randomInt(A.length)];
	return p;
}

// VAPID keypair for Web Push — generated once per run, shared by both fields.
let _vapidPair = null;
function vapidPair() {
	if (_vapidPair) return _vapidPair;
	const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const jwk = privateKey.export({ format: "jwk" });
	const pub = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
	_vapidPair = { publicKey: pub, privateKey: jwk.d };
	return _vapidPair;
}

const BLOCKS = [
	{
		title: "SYSTEM SECRETS (auto-generated, DO NOT TOUCH)",
		header: ["Loss or change = all users logged out, 2FA breaks,", "encrypted tokens become unreadable."],
		fields: [
			{ key: "JWT_SECRET", gen: () => crypto.randomBytes(64).toString("hex"), comment: "Access-JWT signing key. Change = everyone logged out." },
			{ key: "JWT_REFRESH_SECRET", gen: () => crypto.randomBytes(64).toString("hex"), comment: "Refresh-JWT signing key. Separate from access." },
			{ key: "TFA_ENC_KEY", gen: () => crypto.randomBytes(32).toString("hex"), comment: "Encryption of 2FA secrets in DB (32 bytes hex)." },
			{ key: "APP_ENCRYPTION_KEY", gen: () => crypto.randomBytes(32).toString("hex"), comment: "Encryption of integration tokens in DB." },
			{ key: "WEBCHAT_FILE_SECRET", gen: () => crypto.randomBytes(48).toString("hex"), comment: "Signing of web-chat file links." },
			{ key: "DOWNLOAD_LINK_SECRET", gen: () => crypto.randomBytes(32).toString("hex"), comment: "Signing of customer download links for digital products. Change = all issued links stop working." },
			{ key: "SESSION_SECRET", gen: () => crypto.randomBytes(48).toString("hex"), comment: "Server session signing (express-session)." },
			{ key: "MAILING_TOKEN_SECRET", gen: () => crypto.randomBytes(48).toString("hex"), comment: "Signing of unsubscribe/tracking links. Change = all links in sent emails stop working." },
		],
	},

	{
		title: "SERVER",
		header: ["General application server settings."],
		fields: [
			{ key: "NODE_ENV", value: "production", comment: "Mode: production or development" },
			{ key: "PORT", value: "3000", comment: "Port the app listens on" },
			{ key: "APP_URL", value: REQUIRED, comment: "Public URL of the system, e.g. https://crm.example.com" },
			{ key: "APP_LOCALE", value: "uk", comment: "System language (ISO code): the first administrator's language, texts of background jobs and bots" },
			{ key: "CORS_ORIGINS", value: "", comment: "Allowed CORS origins, comma-separated" },
			{ key: "HISTORY_DIR", value: "", comment: "Directory for change history (NDJSON). Empty = ./logs (logs/products, logs/categories, logs/brands)" },
		],
	},

	{
		title: "LOGGING",
		header: ["Journal (pino): logs/app — everything, logs/error — errors only, logs/http — slow / failed requests and SQL. One file per day."],
		fields: [
			{ key: "LOG_DIR", value: "", comment: "Logs root directory. Empty = ./logs" },
			{ key: "LOG_LEVEL", value: "info", comment: "Minimal level written to logs/app: debug | info | warn | error" },
			{ key: "LOG_STDOUT_LEVEL", value: "error", comment: "Minimal level printed to console (pm2 logs) after start: error = errors only, info = everything (diagnostics)" },
			{ key: "LOG_RETENTION_DAYS", value: "30", comment: "Keep logs/app files, days" },
			{ key: "LOG_ERROR_RETENTION_DAYS", value: "90", comment: "Keep logs/error files, days" },
			{ key: "LOG_HTTP_RETENTION_DAYS", value: "14", comment: "Keep logs/http files, days" },
			{ key: "LOG_SLOW_REQUEST_MS", value: "1500", comment: "HTTP request slower than this (ms) is written to logs/http" },
			{ key: "LOG_SLOW_SQL_MS", value: "1000", comment: "SQL slower than this (ms) is written to logs/http" },
		],
	},

	{
		title: "ANALYTICS & REPORTS",
		header: ["Analytics cache and background reports (/reports/)."],
		fields: [
			{ key: "ANALYTICS_CACHE_TTL_MIN", value: "60", comment: "How long a non-standard analytics filter stays cached, minutes" },
			{ key: "ANALYTICS_CONCURRENCY", value: "2", comment: "Analytics computations at the same time" },
			{ key: "REPORTS_DIR", value: "", comment: "Directory for generated report files. Empty = ./storage/reports (not public)" },
			{ key: "REPORTS_CONCURRENCY", value: "1", comment: "Reports generated at the same time" },
			{ key: "REPORTS_RETENTION_DAYS", value: "30", comment: "Keep generated report files, days" },
		],
	},

	{
		title: "DATABASE",
		header: ["MySQL connection credentials."],
		fields: [
			{ key: "DB_HOST", value: "127.0.0.1", comment: "MySQL host (or unix socket path, e.g. /var/run/mysqld/mysqld.sock)" },
			{ key: "DB_PORT", value: "3306", comment: "MySQL port" },
			{ key: "DB_USER", value: REQUIRED, comment: "MySQL user" },
			{ key: "DB_PASSWORD", value: REQUIRED, comment: "MySQL password (socket auth without password: leave the value empty)" },
			{ key: "DB_NAME", value: REQUIRED, comment: "MySQL database name (create an empty database first)" },
			{ key: "DB_PREFIX", gen: genPrefix, comment: "Table prefix (auto-generated). Do not change after installation." },
			{ key: "SCHEMA_CHECK", value: "strict", comment: "Schema check against database.sql on every start: strict = stop on missing tables/columns/indexes/foreign keys or wrong column types; warn = report and start; off = skip" },
		],
	},

	{
		title: "ADMINISTRATOR",
		header: ["First administrator, created automatically on installation (group Administrator).", "The generated password is printed once on the first start."],
		fields: [{ key: "ADMIN_EMAIL", value: REQUIRED, comment: "Administrator email (login)" }],
	},

	{
		title: "ACCESS GATE",
		header: [
			"Extra login/password the browser asks for before the sign-in page (HTTP Basic, like htpasswd).",
			"Protects the sign-in page and all employee pages from bots and password guessing.",
			"Public endpoints (shop APIs, webhooks, chat widget, Telegram storefront, mailing links) are never gated.",
			"Add accesses comma-separated: login1:password1,login2:password2. Changing the list signs everyone out of the gate.",
		],
		fields: [
			// Нова установка — увімкнено; дописано в наявний .env (оновлення) — вимкнено, щоб не закрити працюючу систему несподівано
			{ key: "GATE_ENABLED", value: "true", append: "false", comment: "true = gate on, false = off" },
			{ key: "GATE_USERS", gen: genGateUser, comment: "Accesses login:password, comma-separated (the first one is generated)" },
		],
	},

	{
		title: "ACCESS / INVITATIONS",
		header: ["Lifetime of invitation and password-reset links."],
		fields: [
			{ key: "INVITE_TTL_HOURS", value: "72", comment: "Invitation link TTL, hours" },
			{ key: "RESET_TTL_MINUTES", value: "30", comment: "Password reset link TTL, minutes" },
		],
	},

	{
		title: "TELEGRAM",
		header: ["Encryption key for bot tokens (NOT a bot token itself).", "Actual bot tokens are entered in the admin panel and encrypted with this key."],
		fields: [{ key: "TELEGRAM_TOKEN_KEY", gen: () => crypto.randomBytes(32).toString("hex"), comment: "Bot token encryption key." }],
	},

	{
		title: "INSTAGRAM (Meta App level, shared across accounts)",
		header: ["Meta App credentials used for Instagram integration."],
		fields: [
			{ key: "IG_APP_ID", value: "", comment: "Meta App ID" },
			{ key: "IG_APP_SECRET", value: "", comment: "Meta App Secret" },
			{ key: "IG_REDIRECT_URI", value: "", comment: "OAuth redirect URI" },
			{ key: "IG_VERIFY_TOKEN", value: "", comment: "Webhook verify token" },
			{ key: "IG_GRAPH_VERSION", value: "v21.0", comment: "Graph API version" },
			{ key: "IG_PUBLIC_BASE", value: "", comment: "Public base URL for IG assets" },
		],
	},

	{
		title: "MAIL (SMTP)",
		header: ["Outgoing mail server settings."],
		fields: [
			{ key: "MAIL_HOST", value: "", comment: "SMTP server, e.g. smtp.gmail.com" },
			{ key: "MAIL_PORT", value: "587", comment: "SMTP port (587 or 465)" },
			{ key: "MAIL_USER", value: "", comment: "SMTP login (email)" },
			{ key: "MAIL_PASS", value: "", comment: "SMTP password or app-password" },
			{ key: "MAIL_FROM", value: "", comment: "From address" },
		],
	},

	{
		title: "MAILING (newsletters)",
		header: ["Bulk email campaigns. SMTP senders are configured in the admin panel."],
		fields: [
			{ key: "MAILING_PUBLIC_URL", value: "", comment: "Public URL for unsubscribe/tracking links (empty = APP_URL). E.g. https://news.example.com" },
			{ key: "MAILING_WORKER", value: "1", comment: "1 = this process sends emails. 0 = disable (if a separate worker process is used)" },
			{ key: "MAILING_BATCH_SIZE", value: "50", comment: "Messages taken from queue per tick" },
		],
	},

	{
		title: "WEB PUSH (VAPID)",
		header: ["Browser push notifications for managers.", "Public/Private are one EC P-256 keypair — regenerate BOTH together or neither."],
		fields: [
			{ key: "VAPID_PUBLIC_KEY", gen: () => vapidPair().publicKey, comment: "VAPID public key (used by browser as applicationServerKey)." },
			{ key: "VAPID_PRIVATE_KEY", gen: () => vapidPair().privateKey, comment: "VAPID private key. Keep secret." },
			{ key: "VAPID_SUBJECT", value: "mailto:support@growthcontour.com", comment: "Contact URI for push service (mailto: or https:)." },
		],
	},

	{
		title: "CLIENTS",
		header: ["Clients module defaults."],
		fields: [{ key: "CLIENTS_DEFAULT_COUNTRY", value: "US", comment: "ISO-2 country for phone numbers entered without international code (UA, PL, DE, US...)." }],
	},
];

const HEADER_LINE = "# ═══════════════════════════════════════════════════════";

/* ─── .env ─── */

/** Значення з .env: ключ → рядок (лапки знімаються) */
function readEnv() {
	const map = new Map();
	if (!fs.existsSync(ENV_PATH)) return map;
	for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
		if (!m) continue;
		let v = m[2].trim();
		if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
		map.set(m[1], v);
	}
	return map;
}

/** appending — дописування в наявний .env: поле може мати інше значення для оновлення (append) */
function renderBlock(block, appending) {
	const lines = [`# ─── ${block.title.toUpperCase()} ${"─".repeat(Math.max(2, 50 - block.title.length))}`];
	for (const h of block.header || []) lines.push("# " + h);
	for (const f of block.fields) {
		lines.push("");
		if (f.comment) lines.push("# " + f.comment);
		const v = appending && f.append !== undefined ? f.append : f.gen ? f.gen() : f.value === undefined || f.value === null ? "" : f.value;
		lines.push(`${f.key}=${v}`);
	}
	return lines.join("\n");
}

function renderFullFile() {
	const out = [HEADER_LINE, "#  GROWTH CONTOUR — all system credentials live in this file", HEADER_LINE, ""];
	out.push(`# Fill every ${REQUIRED} value, then start the system again.`);
	out.push("# Secrets and the table prefix are generated automatically. Missing fields are appended on next run;");
	out.push("# existing values are never overwritten.");
	out.push("");
	for (const block of BLOCKS) out.push(renderBlock(block), "");
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Атомарне створення: якщо інший процес встиг першим — його файл лишається, повертає false */
function createEnv() {
	const tmp = `${ENV_PATH}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, renderFullFile(), { mode: 0o600 });
	try {
		fs.linkSync(tmp, ENV_PATH);
		return true;
	} catch (e) {
		if (e.code === "EEXIST") return false;
		throw e;
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Блокування дописування .env між процесами (застарілий lock > 30 с — знімається) */
function withLock(fn) {
	const until = Date.now() + 10000;
	let fd = null;
	while (fd === null) {
		try {
			fd = fs.openSync(LOCK_PATH, "wx");
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
			try {
				if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > 30000) fs.rmSync(LOCK_PATH, { force: true });
			} catch {
				// lock щойно зняли
			}
			if (Date.now() > until) throw new Error("cannot lock " + LOCK_PATH);
			sleep(50);
		}
	}
	try {
		return fn();
	} finally {
		fs.closeSync(fd);
		fs.rmSync(LOCK_PATH, { force: true });
	}
}

/** Дописати відсутні ключі блоками; повертає кількість доданих */
function appendMissing() {
	return withLock(() => {
		const existing = readEnv();
		const chunks = [];
		let n = 0;
		for (const block of BLOCKS) {
			const missing = block.fields.filter((f) => !existing.has(f.key));
			if (!missing.length) continue;
			n += missing.length;
			chunks.push(renderBlock({ ...block, fields: missing }, true));
		}
		if (n) {
			fs.appendFileSync(ENV_PATH, "\n\n" + chunks.join("\n\n") + "\n", { mode: 0o600 });
			fs.chmodSync(ENV_PATH, 0o600);
		}
		return n;
	});
}

/** Поля, де ще стоїть заглушка */
const pendingKeys = (all) => [...readEnv()].filter(([k, v]) => v === REQUIRED && (all || !INSTALL_ONLY.has(k))).map(([k]) => k);

/**
 * Крок 1 (синхронно): .env, потім крок 2 — база окремим процесом. Помилка — вихід із процесу з поясненням.
 */
function ensureEnv() {
	const t = Date.now();
	say(`\n${c.bold(c.cyan("Growth Contour"))}\n`);

	let created = false;
	let added = 0;
	try {
		if (!fs.existsSync(ENV_PATH)) created = createEnv();
		if (!created) added = appendMissing();
	} catch (e) {
		fail("Configuration (.env)", e.message, ["Check write permissions on the system directory"], 1);
	}

	if (created) {
		ok(".env created", "secrets generated, table prefix " + readEnv().get("DB_PREFIX"), 0, true);
		todo("Replace every " + REQUIRED + " value in .env, then start the system again:", [pendingKeys(true).join(", ")]);
		process.exit(EX_CONFIG);
	}

	const pending = pendingKeys(false);
	if (pending.length) {
		todo("Still " + REQUIRED + " in .env — fill these values, then start the system again:", [pending.join(", ")]);
		process.exit(EX_CONFIG);
	}

	process.loadEnvFile(ENV_PATH);
	ok("Configuration", added ? "new keys added: " + added : ".env", t);

	// База — окремим процесом: асинхронний драйвер MySQL, а server.js лишається синхронним до кінця перевірок
	const r = spawnSync(process.execPath, [__filename, "--db"], { stdio: "inherit", env: process.env });
	if (r.error) fail("Database", r.error.message, [], 1);
	if (r.status !== 0) process.exit(r.status === null ? 1 : r.status);
}

/* ─── Перевірка схеми: база ↔ database.sql ─── */

/** Рядок без вмісту лапок — для пошуку ключових слів поза рядками й коментарями */
const unquote = (x) => x.replace(/'(?:[^'\\]|\\.|'')*'/g, "''");

/** Тип колонки: до першого пробілу поза дужками й лапками, + unsigned / zerofill */
function colType(rest) {
	let depth = 0;
	let q = false;
	let i = 0;
	for (; i < rest.length; i++) {
		const ch = rest[i];
		if (q) {
			if (ch === "'" && rest[i + 1] === "'") i++;
			else if (ch === "'") q = false;
		} else if (ch === "'") q = true;
		else if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (ch === " " && depth === 0) break;
	}
	let type = rest.slice(0, i);
	const tail = rest.slice(i);
	const m = /^((?:\s+(?:unsigned|zerofill))+)/i.exec(tail);
	if (m) type += m[1].replace(/\s+/g, " ");
	return { type, after: tail.slice(m ? m[1].length : 0) };
}

/** Значення DEFAULT: рядок у лапках, вираз у дужках або слово; null — немає / NULL */
function colDefault(after) {
	const i = unquote(after).search(/\bDEFAULT\b/i);
	if (i < 0) return null;
	const v = after.slice(i + 7).trimStart();
	if (v[0] === "'") {
		let out = "";
		for (let j = 1; j < v.length; j++) {
			if (v[j] === "'" && v[j + 1] === "'") {
				out += "'";
				j++;
			} else if (v[j] === "'") break;
			else if (v[j] === "\\" && j + 1 < v.length) out += v[++j];
			else out += v[j];
		}
		return out;
	}
	if (v[0] === "(") return "(expr)";
	const w = /^[^\s,]+/.exec(v)[0];
	return /^null$/i.test(w) ? null : w.replace(/\(\)$/, "");
}

const normType = (t) =>
	String(t)
		.toLowerCase()
		.replace(/\b(tinyint|smallint|mediumint|int|bigint)\(\d+\)/g, (m, b) => (m === "tinyint(1)" ? m : b))
		.replace(/\s+/g, " ")
		.trim();
const keyCols = (inner) =>
	inner
		.split(/,(?![^(]*\))/)
		.map((x) => x.trim().replace(/^`|`$/g, "").replace(/`\((\d+)\)$/, "($1)").replace(/` (ASC|DESC)$/i, ""))
		.join(",");

/** database.sql → { таблиця: { columns: Map, indexes: Map, fks: Map } } */
function parseSchema(sql) {
	const out = new Map();
	const re = /^CREATE TABLE (?:IF NOT EXISTS )?`([^`]+)` \(\n([\s\S]*?)\n\)[^;]*;/gm;
	let m;
	while ((m = re.exec(sql))) {
		const t = { columns: new Map(), indexes: new Map(), fks: new Map() };
		for (const raw of m[2].split("\n")) {
			const line = raw.trim().replace(/\s*,$/, "");
			let x;
			if ((x = /^`((?:[^`]|``)+)`\s+(.+)$/.exec(line))) {
				const { type, after } = colType(x[2]);
				t.columns.set(x[1].replace(/``/g, "`"), { type: normType(type), nullable: !/\bNOT NULL\b/i.test(unquote(after)), def: colDefault(after) });
			} else if ((x = /^PRIMARY KEY \((.+)\)/i.exec(line))) {
				t.indexes.set("PRIMARY", { unique: true, cols: keyCols(x[1]) });
			} else if ((x = /^(UNIQUE |FULLTEXT |SPATIAL )?KEY `([^`]+)` \((.+?)\)(?:\s|$|\/\*)/i.exec(line))) {
				t.indexes.set(x[2], { unique: /^UNIQUE/i.test(x[1] || ""), cols: keyCols(x[3]) });
			} else if ((x = /^CONSTRAINT `([^`]+)` FOREIGN KEY \((.+?)\) REFERENCES `([^`]+)` \((.+?)\)/i.exec(line))) {
				t.fks.set(x[1], { cols: keyCols(x[2]), ref: x[3], refCols: keyCols(x[4]) });
			}
		}
		out.set(m[1], t);
	}
	return out;
}

/**
 * Порівняння бази з database.sql. Зайве в базі (таблиці модулів, власні колонки) не помилка.
 * errors — бракує таблиць / колонок / індексів / FK, інший тип або NULL колонки; warnings — інший DEFAULT, склад індексу, ціль FK.
 */
async function compareSchema(conn, P, expected) {
	const where = "TABLE_SCHEMA = DATABASE() AND LEFT(TABLE_NAME, CHAR_LENGTH(?)) = ?";
	const [cols] = await conn.query(`SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type, IS_NULLABLE AS n, COLUMN_DEFAULT AS d, EXTRA AS e FROM information_schema.COLUMNS WHERE ${where}`, [P, P]);
	const [idx] = await conn.query(
		`SELECT TABLE_NAME AS t, INDEX_NAME AS i, NON_UNIQUE AS nu, COLUMN_NAME AS c, SUB_PART AS sp FROM information_schema.STATISTICS WHERE ${where} ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
		[P, P]
	);
	const [fks] = await conn.query(
		`SELECT k.TABLE_NAME AS t, k.CONSTRAINT_NAME AS f, k.COLUMN_NAME AS c, k.REFERENCED_TABLE_NAME AS rt, k.REFERENCED_COLUMN_NAME AS rc
		   FROM information_schema.KEY_COLUMN_USAGE k
		  WHERE k.TABLE_SCHEMA = DATABASE() AND LEFT(k.TABLE_NAME, CHAR_LENGTH(?)) = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
		  ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
		[P, P]
	);

	const dbCols = new Map();
	for (const r of cols) {
		if (!dbCols.has(r.t)) dbCols.set(r.t, new Map());
		dbCols.get(r.t).set(r.c, { type: normType(r.type), nullable: r.n === "YES", def: r.d === null || r.d === undefined ? null : String(r.d), expr: /DEFAULT_GENERATED/i.test(r.e || "") });
	}
	const dbIdx = new Map();
	for (const r of idx) {
		const k = r.t + "." + r.i;
		const cur = dbIdx.get(k) || { unique: Number(r.nu) === 0, cols: [] };
		cur.cols.push(r.c + (r.sp ? "(" + r.sp + ")" : ""));
		dbIdx.set(k, cur);
	}
	const dbFk = new Map();
	for (const r of fks) {
		const k = r.t + "." + r.f;
		const cur = dbFk.get(k) || { ref: r.rt, cols: [], refCols: [] };
		cur.cols.push(r.c);
		cur.refCols.push(r.rc);
		dbFk.set(k, cur);
	}

	const errors = [];
	const warnings = [];
	for (const [t, def] of expected) {
		const have = dbCols.get(t);
		if (!have) {
			errors.push(`table ${t} is missing`);
			continue;
		}
		for (const [c, e] of def.columns) {
			const h = have.get(c);
			if (!h) {
				errors.push(`column ${t}.${c} is missing`);
				continue;
			}
			if (h.type !== e.type) errors.push(`column ${t}.${c}: type ${h.type}, expected ${e.type}`);
			if (h.nullable !== e.nullable) errors.push(`column ${t}.${c}: ${h.nullable ? "NULL" : "NOT NULL"}, expected ${e.nullable ? "NULL" : "NOT NULL"}`);
			// DEFAULT: вирази (DEFAULT (…)) і двійкові типи (MySQL показує їх у hex) не порівнюються; CURRENT_TIMESTAMP — у будь-якому записі
			const isTs = (v) => v !== null && /^current_timestamp/i.test(v);
			const exprDb = h.expr && !isTs(h.def);
			if (e.def !== "(expr)" && !exprDb && !/binary|blob/.test(e.type) && !(isTs(e.def) && isTs(h.def)) && String(h.def) !== String(e.def))
				warnings.push(`column ${t}.${c}: default ${h.def === null ? "NULL" : "'" + h.def + "'"}, expected ${e.def === null ? "NULL" : "'" + e.def + "'"}`);
		}
		for (const [i, e] of def.indexes) {
			const h = dbIdx.get(t + "." + i);
			if (!h) {
				errors.push(`index ${t}.${i} is missing`);
				continue;
			}
			if (h.cols.join(",") !== e.cols || h.unique !== e.unique) warnings.push(`index ${t}.${i}: ${h.unique ? "UNIQUE " : ""}(${h.cols.join(",")}), expected ${e.unique ? "UNIQUE " : ""}(${e.cols})`);
		}
		for (const [f, e] of def.fks) {
			const h = dbFk.get(t + "." + f);
			if (!h) {
				errors.push(`foreign key ${t}.${f} is missing`);
				continue;
			}
			if (h.ref !== e.ref || h.cols.join(",") !== e.cols || h.refCols.join(",") !== e.refCols) warnings.push(`foreign key ${t}.${f}: (${h.cols.join(",")}) → ${h.ref}(${h.refCols.join(",")}), expected (${e.cols}) → ${e.ref}(${e.refCols})`);
		}
	}
	return { errors, warnings, tables: expected.size };
}

/** Повний звіт — у logs/schema-check.log (у консоль — лише перші рядки) */
function writeSchemaReport(r) {
	try {
		const dir = path.resolve(process.env.LOG_DIR || path.join(__dirname, "logs"));
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "schema-check.log");
		const text = [`Schema check ${new Date().toISOString()} — ${r.errors.length} errors, ${r.warnings.length} warnings`, "", ...r.errors.map((x) => "ERROR " + x), ...r.warnings.map((x) => "WARN  " + x), ""].join("\n");
		fs.writeFileSync(file, text);
		return file;
	} catch {
		return null;
	}
}

/* ─── База ─── */

function dbReason(e) {
	const host = String(process.env.DB_HOST || "").startsWith("/") ? process.env.DB_HOST : `${process.env.DB_HOST}:${process.env.DB_PORT || 3306}`;
	switch (e.code) {
		case "ER_ACCESS_DENIED_ERROR":
		case "ER_DBACCESS_DENIED_ERROR":
			return { code: EX_CONFIG, reason: `Access denied for user "${process.env.DB_USER}" to database "${process.env.DB_NAME}".`, hint: "Check DB_USER, DB_PASSWORD and the user's privileges on the database" };
		case "ER_BAD_DB_ERROR":
			return { code: EX_CONFIG, reason: `Database "${process.env.DB_NAME}" does not exist.`, hint: "Create an empty utf8mb4 database or fix DB_NAME" };
		case "ENOTFOUND":
		case "EAI_AGAIN":
			return { code: EX_CONFIG, reason: `MySQL host "${process.env.DB_HOST}" not found.`, hint: "Check DB_HOST" };
		case "ECONNREFUSED":
		case "ETIMEDOUT":
		case "ENOENT":
		case "PROTOCOL_CONNECTION_LOST":
			// MySQL міг ще не запуститись (перезавантаження сервера) — код 1, pm2 повторить
			return { code: 1, reason: `Cannot connect to MySQL at ${host} (${e.code}).`, hint: "Make sure MySQL is running; check DB_HOST / DB_PORT" };
		default:
			return { code: 1, reason: `${e.code || "MySQL"}: ${e.message}`, hint: "" };
	}
}

async function runDb() {
	process.loadEnvFile(ENV_PATH);
	const mysql = require("mysql2/promise");
	const P = process.env.DB_PREFIX || "";
	if (!/^[A-Za-z0-9_]{0,32}$/.test(P)) fail("Table prefix", `DB_PREFIX "${P}" — Latin letters, digits and "_" only, up to 32 characters.`, []);

	let t = Date.now();
	let conn;
	try {
		const socket = String(process.env.DB_HOST || "").startsWith("/");
		conn = await mysql.createConnection({
			...(socket ? { socketPath: process.env.DB_HOST } : { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306) }),
			user: process.env.DB_USER,
			password: process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
			charset: "utf8mb4",
			multipleStatements: true,
			connectTimeout: 10000,
		});
	} catch (e) {
		const r = dbReason(e);
		fail("MySQL", r.reason, r.hint ? [r.hint] : [], r.code);
	}

	try {
		const [[{ v }]] = await conn.query("SELECT VERSION() AS v");
		const major = parseInt(v, 10);
		if (/mariadb/i.test(v) || !(major >= 8)) fail("MySQL", `Server version ${v}.`, ["MySQL 8.0 or newer is required"]);
		ok("MySQL " + v.split("-")[0], process.env.DB_NAME, t);

		t = Date.now();
		// Порівняння початку назви замість LIKE: «_» у префіксі — не шаблон, і не залежить від NO_BACKSLASH_ESCAPES
		const tables = async () => {
			const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND LEFT(table_name, CHAR_LENGTH(?)) = ?", [P, P]);
			return Number(n);
		};
		const hasUsers = async () => {
			const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?", [P + "users"]);
			if (!Number(n)) return false;
			const [[u]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${P}users\``);
			return Number(u.n) > 0;
		};

		// ADMIN_EMAIL — потрібен лише коли адміністратора ще немає (установка або схема, імпортована вручну)
		const adminEmail = () => {
			const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
			if (!email || email === REQUIRED.toLowerCase()) {
				todo("Installation needs this value in .env — fill it, then start the system again:", ["ADMIN_EMAIL"]);
				process.exit(EX_CONFIG);
			}
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) fail("Administrator", `ADMIN_EMAIL "${email}" is not a valid email address.`, []);
			return email;
		};

		/** database.sql з префіксом цієї системи + назви його таблиць */
		const loadSql = () => {
			if (!fs.existsSync(SQL_PATH)) fail("Database installation", "database.sql not found in the system directory.", [], 1);
			let sql = fs.readFileSync(SQL_PATH, "utf8");
			const m = /(?:table prefix|префікс таблиць):\s*([A-Za-z0-9_]+)/i.exec(sql.slice(0, 2000));
			const src = m ? m[1] : "prefix_";
			if (!sql.includes("`" + src)) fail("Database installation", `database.sql has no tables with prefix "${src}".`, [], 1);
			if (src !== P) sql = sql.split("`" + src).join("`" + P);
			const names = [...sql.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?`([^`]+)`/gm)].map((x) => x[1]);
			return { sql, names };
		};

		/**
		 * Таблиці є, користувачів немає. Схему імпортовано вручну (повністю) — створюємо адміністратора;
		 * установка обірвалась (бракує таблиць або довідників) — нічого не чіпаємо.
		 */
		const completeManual = async (n) => {
			const { names } = loadSql();
			const [rows] = await conn.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND LEFT(table_name, CHAR_LENGTH(?)) = ?", [P, P]);
			const have = new Set(rows.map((r) => r.t || r.TABLE_NAME));
			const missing = names.filter((x) => !have.has(x));
			const incomplete = (why) =>
				fail("Database", `Database "${process.env.DB_NAME}" has ${n} tables with prefix "${P}", but the schema is incomplete: ${why}.`, [
					`Drop the tables with prefix "${P}" and start again — the system installs database.sql itself`,
				]);
			if (missing.length) incomplete(`${missing.length} of ${names.length} tables are missing (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""})`);
			const [[g]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${P}users_groups\` WHERE id = 1`);
			const [[l]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${P}languages\``);
			const [[pp]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${P}users_permissions_pages\``);
			if (!Number(g.n) || !Number(l.n) || !Number(pp.n)) incomplete("dictionaries are missing (languages, user groups or permission pages)");
			ok("Database", n + " tables, imported manually", t);
		};

		/** Перший адміністратор у групі 1 (Адміністратор); пароль — один раз у консоль */
		const createAdmin = async (email) => {
			const password = genPassword();
			const hash = await require("bcryptjs").hash(password, 12);
			await conn.beginTransaction();
			try {
				// Мова адміністратора — як у всіх нових користувачів: мова з id 1 (англійська), далі мова за замовчуванням.
				// Змінюється в перемикачі мов — і інтерфейс, і дані (назви статусів, довідників) одразу
				const [[lang]] = await conn.query(`SELECT id FROM \`${P}languages\` ORDER BY id = 1 DESC, is_default = 1 DESC, sort, id LIMIT 1`);
				const [ins] = await conn.query(`INSERT INTO \`${P}users\` (email, password, first_name, id_lang, active) VALUES (?, ?, ?, ?, 1)`, [email, hash, "Administrator", lang ? lang.id : 1]);
				await conn.query(`INSERT INTO \`${P}users_to_groups\` (id_user, id_group) VALUES (?, 1)`, [ins.insertId]);
				await conn.commit();
			} catch (e) {
				await conn.rollback().catch(() => {});
				fail("Administrator", `${e.code || ""} ${e.message}`.trim(), [`Drop the tables with prefix "${P}", then start again`], 1);
			}
			ok("Administrator", email, 0, true);
			say("  Password: " + c.bold(password), true);
			say("  " + c.yellow("Save this password and change it after the first sign-in — it is not shown again."), true);
			const gate = gateAccounts();
			if (gate.enabled && gate.users.length) {
				ok("Access gate", "the browser asks for it before the sign-in page", 0, true);
				say("  Login: " + c.bold(gate.users[0].login) + "   Password: " + c.bold(gate.users[0].password) + c.dim("   (GATE_USERS in .env)"), true);
			}
		};

		/** Звірка зі схемою database.sql (SCHEMA_CHECK: strict | warn | off) */
		const checkSchema = async (installed) => {
			const mode = String(process.env.SCHEMA_CHECK || "strict").toLowerCase();
			if (mode === "off") return;
			const t0 = Date.now();
			if (!fs.existsSync(SQL_PATH)) return say(`${c.yellow("!")} Schema · database.sql not found — check skipped`);
			const r = await compareSchema(conn, P, parseSchema(loadSql().sql));
			if (!r.errors.length && !r.warnings.length) return ok("Schema", "matches database.sql · " + r.tables + " tables", t0);
			const file = writeSchemaReport(r);
			const list = (items, max) => items.slice(0, max).map((x) => "  " + x).concat(items.length > max ? [`  … and ${items.length - max} more`] : []);
			const hint = [`Full report: ${file || "logs/schema-check.log"}`, installed ? "Apply the release migration (see README → Upgrading) or fix the listed objects" : `Drop the tables with prefix "${P}" and start again — the system installs database.sql itself`];
			if (r.errors.length && mode === "strict") {
				process.stderr.write(`${c.red("✖")} Schema · ${r.errors.length} differences from database.sql${r.warnings.length ? ", " + r.warnings.length + " warnings" : ""}\n`);
				for (const l of list(r.errors, 15)) process.stderr.write(l + "\n");
				for (const h of hint.concat(["SCHEMA_CHECK=warn in .env starts the system anyway"])) process.stderr.write(`  ${c.yellow(h)}\n`);
				process.exit(EX_CONFIG);
			}
			say(`${c.yellow("!")} Schema · ${r.errors.length} differences, ${r.warnings.length} warnings against database.sql`, true);
			for (const l of list(r.errors.concat(r.warnings), 10)) say(c.yellow(l), true);
			say("  " + c.yellow(hint[0]), true);
		};

		let n = await tables();
		if (n > 0 && (await hasUsers())) {
			ok("Database", n + " tables", t);
			await checkSchema(true);
			return;
		}

		const email = adminEmail();

		// Один процес установлює, решта (кластер pm2) чекає і бачить уже встановлену базу
		const lockName = "gc_install_" + crypto.createHash("sha1").update(process.env.DB_NAME + "/" + P).digest("hex").slice(0, 32);
		const [[{ l }]] = await conn.query("SELECT GET_LOCK(?, 900) AS l", [lockName]);
		if (Number(l) !== 1) fail("Database installation", "Timed out waiting for another installing process.", [], 1);
		try {
			n = await tables();
			if (n > 0 && (await hasUsers())) {
				ok("Database", n + " tables", t);
				return;
			}
			if (n > 0) {
				// Схему імпортовано вручну
				await completeManual(n);
				await checkSchema(false);
			} else {
				const { sql, names } = loadSql();
				try {
					await conn.query(sql);
				} catch (e) {
					fail("Database installation", `${e.code || ""} ${e.message}`.trim(), [`Drop the tables with prefix "${P}", then start again`], 1);
				}
				ok("Database installed", names.length + " tables", t, true);
			}
			await createAdmin(email);
		} finally {
			await conn.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {});
		}
	} finally {
		await conn.end().catch(() => {});
	}
}

/** Захисний вхід з .env: { enabled, users: [{ login, password }] } */
function gateAccounts() {
	const enabled = String(process.env.GATE_ENABLED || "").toLowerCase() === "true";
	const users = String(process.env.GATE_USERS || "")
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean)
		.map((x) => {
			const i = x.indexOf(":");
			return i > 0 ? { login: x.slice(0, i), password: x.slice(i + 1) } : null;
		})
		.filter((u) => u && u.password);
	return { enabled, users };
}

/* ─── Останній рядок запуску (з server.js) ─── */

function started({ port, modules }) {
	if (modules !== null && modules !== undefined) ok("Modules", String(modules));
	const gate = gateAccounts();
	if (gate.enabled) {
		if (gate.users.length) ok("Access gate", gate.users.length + (gate.users.length === 1 ? " access" : " accesses"));
		else say(`${c.yellow("!")} Access gate · GATE_ENABLED=true but GATE_USERS is empty — the gate is off`);
	}
	const url = process.env.APP_URL && process.env.APP_URL !== REQUIRED ? process.env.APP_URL : "";
	say(`\n${c.green(c.bold("System is up and running"))}${url ? " · " + url : ""} · port ${port} · ${process.env.NODE_ENV || "development"} · ${process.uptime().toFixed(1)} s\n`);
}

module.exports = { ensureEnv, started, gateAccounts };

if (require.main === module) {
	if (process.argv.includes("--db")) {
		runDb().then(
			() => process.exit(0),
			(e) => fail("Database", e.message, [], 1)
		);
	} else {
		ensureEnv();
	}
}