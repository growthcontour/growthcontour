"use strict";
/**
 * Відправники: CRUD, шифрування паролів (helpers/crypto.js), пул SMTP-з'єднань,
 * класифікація помилок, перевірка SPF/DKIM/DMARC, прогрів домену.
 */
const nodemailer = require("nodemailer");
const dns = require("dns").promises;
const cryptoHelper = require("../../helpers/crypto");
const model = require("./model");

const { pool, T, err } = model;

// iv(12) + tag(16) + cipher → одна VARBINARY-колонка
function pack(plain) {
	const e = cryptoHelper.encrypt(plain);
	return e.cipher ? Buffer.concat([e.iv, e.tag, e.cipher]) : null;
}

function unpack(buf) {
	if (!buf) return null;
	const b = Buffer.from(buf);
	if (b.length < 29) return null;
	return cryptoHelper.decrypt(b.subarray(28), b.subarray(0, 12), b.subarray(12, 28));
}

// ─── CRUD ───────────────────────────────────────────────
// Паролі назовні НЕ віддаються ніколи
const PUBLIC_COLS = `id, name, provider, from_name, from_email, reply_to, company_address, smtp_host, smtp_port, smtp_secure, smtp_user,
                     smtp_max_connections, bounce_address, dkim_selector, imap_host, imap_port, imap_user, imap_mailbox,
                     rate_per_minute, daily_limit, warmup_start, domain_limits, dns_check, is_default, active, date_add, date_edit,
                     (imap_pass_enc IS NOT NULL) AS has_imap_pass`;

async function list() {
	const [rows] = await pool.query(`SELECT ${PUBLIC_COLS} FROM ${T.senders} WHERE deleted = 0 ORDER BY is_default DESC, id`);
	return rows;
}

async function getPublic(id) {
	const [[s]] = await pool.query(`SELECT ${PUBLIC_COLS} FROM ${T.senders} WHERE id = ? AND deleted = 0`, [id]);
	return s || null;
}

/** Повний рядок (з шифрованими паролями) — лише для внутрішнього використання */
async function get(id) {
	const [[s]] = await pool.query(`SELECT * FROM ${T.senders} WHERE id = ? AND deleted = 0`, [id]);
	return s || null;
}

async function getDefault() {
	const [[s]] = await pool.query(`SELECT * FROM ${T.senders} WHERE deleted = 0 AND active = 1 ORDER BY is_default DESC, id LIMIT 1`);
	return s || null;
}

/** b — вже провалідовані дані. Паролі оновлюються лише якщо передані. */
async function save(id, b) {
	return model.withTx(async (conn) => {
		const lower = (v) => (v ? String(v).trim().toLowerCase() : null);
		const cols = {
			name: String(b.name).trim().slice(0, 128),
			from_name: String(b.from_name).trim().slice(0, 128),
			from_email: lower(b.from_email),
			reply_to: lower(b.reply_to),
			company_address: b.company_address ? String(b.company_address).trim().slice(0, 512) : null,
			smtp_host: String(b.smtp_host).trim().slice(0, 255),
			smtp_port: parseInt(b.smtp_port, 10) || 587,
			smtp_secure: b.smtp_secure ? 1 : 0,
			smtp_user: String(b.smtp_user).trim().slice(0, 255),
			smtp_max_connections: Math.min(10, Math.max(1, parseInt(b.smtp_max_connections, 10) || 3)),
			bounce_address: lower(b.bounce_address),
			dkim_selector: b.dkim_selector ? String(b.dkim_selector).trim().slice(0, 63) : null,
			imap_host: b.imap_host ? String(b.imap_host).trim().slice(0, 255) : null,
			imap_port: parseInt(b.imap_port, 10) || 993,
			imap_user: b.imap_user ? String(b.imap_user).trim().slice(0, 255) : null,
			imap_mailbox: b.imap_mailbox ? String(b.imap_mailbox).trim().slice(0, 128) : "INBOX",
			rate_per_minute: Math.max(1, parseInt(b.rate_per_minute, 10) || 60),
			daily_limit: Math.max(0, parseInt(b.daily_limit, 10) || 0),
			warmup_start: b.warmup_start || null,
			domain_limits: b.domain_limits && Object.keys(b.domain_limits).length ? JSON.stringify(b.domain_limits) : null,
			is_default: b.is_default ? 1 : 0,
			active: b.active === undefined || b.active ? 1 : 0,
		};
		cols.provider = b.provider === "gmail" ? "gmail" : "smtp";
		let smtpPass = b.smtp_pass ? String(b.smtp_pass) : "";
		let imapPass = b.imap_pass ? String(b.imap_pass) : "";

		// Gmail / Google Workspace: параметри фіксовані на сервері, з форми беремо лише адресу і пароль застосунку
		if (cols.provider === "gmail") {
			if (!/@/.test(cols.from_email || "")) throw err(400, "validation_error", { status: "error", errors: [{ field: "from_email", message: "required" }] });
			smtpPass = smtpPass.replace(/\s+/g, "");
			if (smtpPass && !/^[a-z]{16}$/i.test(smtpPass)) throw err(400, "validation_error", { status: "error", errors: [{ field: "smtp_pass", message: "gmail_app_password" }] });
			Object.assign(cols, {
				smtp_host: "smtp.gmail.com",
				smtp_port: 465,
				smtp_secure: 1,
				smtp_user: cols.from_email,
				smtp_max_connections: Math.min(cols.smtp_max_connections, 3),
				bounce_address: null, // Gmail переписує envelope-from — VERP не працює, bounce ловимо через IMAP
				imap_host: "imap.gmail.com",
				imap_port: 993,
				imap_user: cols.from_email,
				imap_mailbox: "INBOX",
				rate_per_minute: Math.min(cols.rate_per_minute, 20),
				daily_limit: cols.daily_limit > 0 ? Math.min(cols.daily_limit, 2000) : 450,
			});
			imapPass = smtpPass; // один пароль застосунку на SMTP і IMAP
		}

		if (smtpPass) cols.smtp_pass_enc = pack(smtpPass);
		if (imapPass) cols.imap_pass_enc = pack(imapPass);
		if (!id && !cols.smtp_pass_enc) throw err(400, "smtp_pass_required", { errors: [{ field: "smtp_pass", message: "required" }] });

		// Назви колонок — лише ключі об'єкта вище (фіксований набір), значення — параметри
		const keys = Object.keys(cols);
		let sid = id;
		if (id) {
			const [r] = await conn.query(`UPDATE ${T.senders} SET ${keys.map((k) => `\`${k}\` = ?`).join(", ")}, date_edit = UTC_TIMESTAMP() WHERE id = ? AND deleted = 0`, [...keys.map((k) => cols[k]), id]);
			if (!r.affectedRows) throw err(404, "not_found");
		} else {
			const [r] = await conn.query(`INSERT INTO ${T.senders} (${keys.map((k) => `\`${k}\``).join(", ")}, date_add) VALUES (${keys.map(() => "?").join(", ")}, UTC_TIMESTAMP())`, keys.map((k) => cols[k]));
			sid = r.insertId;
		}
		if (cols.is_default) await conn.query(`UPDATE ${T.senders} SET is_default = 0 WHERE id <> ?`, [sid]);
		closeTransport(sid);
		return { ok: true, id: sid };
	});
}

async function remove(id, idUser) {
	const [[used]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.campaigns} WHERE id_sender = ? AND deleted = 0 AND status IN ('scheduled','preparing','sending','paused')`, [id]);
	if (used.n) throw err(409, "sender_in_active_campaign");
	await pool.query(`UPDATE ${T.senders} SET deleted = 1, active = 0, date_deleted = UTC_TIMESTAMP(), id_user_deleted = ? WHERE id = ?`, [idUser || null, id]);
	closeTransport(id);
	return { ok: true };
}

// ─── SMTP ───────────────────────────────────────────────
const transports = new Map();

function closeTransport(id) {
	const cur = transports.get(Number(id));
	if (cur) {
		cur.t.close();
		transports.delete(Number(id));
	}
}

function transportFor(s) {
	const ver = String(s.date_edit || s.date_add);
	const cur = transports.get(Number(s.id));
	if (cur && cur.ver === ver) return cur.t;
	if (cur) cur.t.close();
	const pass = unpack(s.smtp_pass_enc);
	if (!pass) throw Object.assign(new Error("smtp_pass_unreadable"), { code: "EAUTH" });
	const t = nodemailer.createTransport({
		pool: true,
		host: s.smtp_host,
		port: s.smtp_port,
		secure: !!s.smtp_secure,
		requireTLS: !s.smtp_secure,
		auth: { user: s.smtp_user, pass },
		maxConnections: Math.max(1, s.smtp_max_connections || 3),
		maxMessages: 100,
		connectionTimeout: 20000,
		greetingTimeout: 15000,
		socketTimeout: 60000,
		tls: { minVersion: "TLSv1.2" },
	});
	transports.set(Number(s.id), { ver, t });
	return t;
}

const send = (s, mail) => transportFor(s).sendMail(mail);

/** Перевірка підключення + тестовий лист (опційно). locale — мова користувача адмінки. */
async function test(id, to, locale = "en") {
	const s = await get(id);
	if (!s) throw err(404, "not_found");
	closeTransport(id);
	try {
		await transportFor(s).verify();
	} catch (e) {
		throw err(400, "smtp_failed", { detail: String(e.response || e.message).slice(0, 300) });
	}
	if (to) {
		const n = model.normalizeEmail(to);
		if (!n) throw err(400, "invalid_email");
		await send(s, {
			from: { name: s.from_name, address: s.from_email },
			to: n.email,
			subject: model.t(locale, "mailing.smtp_test.subject"),
			text: model.t(locale, "mailing.smtp_test.body"),
		});
	}
	return { ok: true };
}

/**
 * Класифікація помилки SMTP:
 * hard      — адреса не існує → стоп-лист
 * soft      — тимчасово (скринька переповнена, сірий список) → повтор з паузою
 * blocked   — відхилено політикою/спам-фільтром (5.7.x): адреса ок, повтор кілька разів
 * throttle  — сервер просить сповільнитись (421, 4.7.x) → пауза для домену
 * transient — проблема з'єднання (наша сторона) → повтор без лічильника спроб
 * auth      — невірний логін/пароль SMTP → пауза кампаній відправника
 */
function classify(e) {
	const code = Number(e.responseCode) || 0;
	const resp = String(e.response || e.message || "");
	const enh = resp.match(/\b([245])\.(\d{1,3})\.(\d{1,3})\b/);
	if (e.code === "EAUTH" || code === 535 || code === 534) return "auth";
	if (!code && ["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNRESET", "ECONNREFUSED", "ETLS", "EPROTOCOL"].includes(e.code)) return "transient";
	if (!code && e.code === "EENVELOPE") return "hard";
	if (code === 421 || (enh && enh[1] === "4" && enh[2] === "7")) return "throttle";
	if (code >= 500) {
		if (enh && enh[2] === "7") return "blocked";
		if (code === 552 || (enh && enh[2] === "2" && enh[3] === "2")) return "soft";
		return "hard";
	}
	if (code >= 400) return "soft";
	return "transient";
}

// ─── ПРОГРІВ ────────────────────────────────────────────
const WARMUP = [50, 100, 200, 400, 700, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 30000, 50000];

function effectiveDailyLimit(s) {
	let lim = Number(s.daily_limit) || 0;
	if (s.warmup_start) {
		const days = Math.floor((Date.now() - new Date(String(s.warmup_start).slice(0, 10) + "T00:00:00Z").getTime()) / 86400000);
		if (days >= 0 && days < WARMUP.length) lim = lim ? Math.min(lim, WARMUP[days]) : WARMUP[days];
	}
	return lim;
}

// ─── DNS ────────────────────────────────────────────────
const DKIM_SELECTORS = ["default", "mail", "dkim", "google", "selector1", "selector2", "k1", "s1", "s2", "smtp", "mx"];
const SELECTOR_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

async function checkDns(id) {
	const s = await get(id);
	if (!s) throw err(404, "not_found");
	const domain = String(s.from_email).split("@")[1];
	const txt = async (n) => {
		try {
			return (await dns.resolveTxt(n)).map((r) => r.join(""));
		} catch (e) {
			return [];
		}
	};

	const spf = (await txt(domain)).find((r) => /^v=spf1/i.test(r)) || null;
	const dmarc = (await txt("_dmarc." + domain)).find((r) => /^v=DMARC1/i.test(r)) || null;
	let dkimSelector = null;
	for (const sel of [s.dkim_selector, ...DKIM_SELECTORS].filter((x) => x && SELECTOR_RE.test(x))) {
		if ((await txt(`${sel}._domainkey.${domain}`)).some((x) => /v=DKIM1|k=rsa|p=/i.test(x))) {
			dkimSelector = sel;
			break;
		}
	}
	let mx = false;
	try {
		mx = (await dns.resolveMx(domain)).length > 0;
	} catch (e) {}

	const smtpRoot = String(s.smtp_host).toLowerCase().split(".").slice(-2).join(".");
	const r = {
		domain,
		spf,
		spf_includes_smtp: spf ? spf.toLowerCase().includes(smtpRoot) : false,
		dmarc,
		dmarc_policy: dmarc ? (dmarc.match(/;\s*p=(\w+)/i) || [])[1] || null : null,
		dkim: !!dkimSelector,
		dkim_selector: dkimSelector,
		mx,
		date: new Date().toISOString(),
	};
	await pool.query(`UPDATE ${T.senders} SET dns_check = ? WHERE id = ?`, [JSON.stringify(r), id]);
	return r;
}

module.exports = { pack, unpack, list, get, getPublic, getDefault, save, remove, send, test, classify, closeTransport, effectiveDailyLimit, checkDns };