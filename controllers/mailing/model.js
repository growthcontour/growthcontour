"use strict";
/**
 * Розсилки: дані (контакти, списки, підписки, згоди, стоп-лист, поля, налаштування, мови).
 * Усі дати — UTC (UTC_TIMESTAMP()). Усі запити — параметризовані.
 * Помилки — з кодом e.status і ключем перекладу в e.message (mailing.errors.*).
 */
const net = require("net");
const { domainToASCII } = require("url");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const i18n = require("../../config/i18n/i18n");

const P = config.get("configDatabase").prefix;
const T = {
	lists: `${P}mailing_lists`,
	listsLang: `${P}mailing_lists_lang`,
	contacts: `${P}mailing_contacts`,
	fields: `${P}mailing_fields`,
	subs: `${P}mailing_subscriptions`,
	consents: `${P}mailing_consents`,
	supp: `${P}mailing_suppressions`,
	domains: `${P}mailing_domains`,
	settings: `${P}mailing_settings`,
	senders: `${P}mailing_senders`,
	templates: `${P}mailing_templates`,
	contents: `${P}mailing_contents`,
	campaigns: `${P}mailing_campaigns`,
	variants: `${P}mailing_campaign_variants`,
	messages: `${P}mailing_messages`,
	links: `${P}mailing_links`,
	events: `${P}mailing_events`,
	imports: `${P}mailing_imports`,
};

// Помилка з кодом — роутерна обгортка віддасть її як є
const err = (status, message, payload) => Object.assign(new Error(message), { status, payload });

const ints = (v) => [...new Set((Array.isArray(v) ? v : v != null ? [v] : []).map((x) => parseInt(x, 10)).filter((x) => x > 0))];

const toSql = (d) => d.toISOString().slice(0, 19).replace("T", " ");

async function withTx(fn) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const r = await fn(conn);
		await conn.commit();
		return r;
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

// ─── НАЛАШТУВАННЯ ───────────────────────────────────────
const SETTINGS_DEFAULT = {
	default_timezone: "Europe/Kyiv",
	default_id_lang: 1,
	frequency_cap: { count: 0, days: 7 }, // 0 = вимкнено
	soft_bounce_limit: 3,
	sunset_days: 0, // 0 = вимкнено; >0 — не слати тим, хто не відкривав/не клікав N днів
	double_optin_ttl_days: 7,
	clients_sync: { enabled: false, id_list: null },
};

let settingsCache = null;
let settingsAt = 0;

async function getSettings(force = false) {
	if (!force && settingsCache && Date.now() - settingsAt < 60000) return settingsCache;
	const [rows] = await pool.query(`SELECT \`key\`, \`value\` FROM ${T.settings}`);
	const s = JSON.parse(JSON.stringify(SETTINGS_DEFAULT));
	for (const r of rows) {
		if (!(r.key in s)) continue;
		const v = typeof r.value === "string" ? JSON.parse(r.value) : r.value;
		s[r.key] = v && typeof v === "object" && !Array.isArray(v) && typeof s[r.key] === "object" && s[r.key] !== null ? { ...s[r.key], ...v } : v;
	}
	settingsCache = s;
	settingsAt = Date.now();
	return s;
}

async function saveSettings(patch) {
	const keys = Object.keys(patch || {}).filter((k) => k in SETTINGS_DEFAULT);
	for (const k of keys) {
		await pool.query(
			`INSERT INTO ${T.settings} (\`key\`, \`value\`, date_edit) VALUES (?, ?, UTC_TIMESTAMP()) AS n
             ON DUPLICATE KEY UPDATE \`value\` = n.\`value\`, date_edit = n.date_edit`,
			[k, JSON.stringify(patch[k])]
		);
	}
	return getSettings(true);
}

// ─── МОВИ ОТРИМУВАЧІВ ───────────────────────────────────
// id_lang → iso з таблиці languages; тексти — лише з locales/{iso}/mailing/mailing.json
let langCache = null;
let langAt = 0;

async function languages() {
	if (!langCache || Date.now() - langAt > 5 * 60000) {
		const [rows] = await pool.query(`SELECT id, iso FROM ${P}languages WHERE active = 1`);
		langCache = new Map(rows.map((r) => [Number(r.id), String(r.iso || "").toLowerCase()]));
		langAt = Date.now();
	}
	return langCache;
}

/** iso-код для i18n; невідома мова → en */
async function localeOf(idLang) {
	const iso = (await languages()).get(Number(idLang));
	return iso && i18n.getLocales().includes(iso) ? iso : "en";
}

/** iso → id_lang (публічна форма підписки); невідомий → null */
async function idLangOfIso(iso) {
	const code = String(iso || "")
		.toLowerCase()
		.slice(0, 8);
	if (!code) return null;
	for (const [id, v] of await languages()) if (v === code) return id;
	return null;
}

const t = (locale, key, vars) => i18n.__({ phrase: key, locale }, vars || {});

// ─── ЧАСОВІ ПОЯСИ ───────────────────────────────────────
function tzOffsetMin(tz, date) {
	const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
	const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
	return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime()) / 60000;
}

/** "2026-10-10 10:00:00" у поясі tz → "YYYY-MM-DD HH:MM:SS" UTC */
function zonedToUtc(local, tz) {
	const [d, tm = "00:00:00"] = String(local).trim().split(/[ T]/);
	const [Y, M, D] = d.split("-").map(Number);
	const [h, m, s = 0] = tm.split(":").map(Number);
	const guess = Date.UTC(Y, M - 1, D, h || 0, m || 0, s || 0);
	let off = 0;
	try {
		off = tzOffsetMin(tz, new Date(guess));
	} catch (e) {}
	return toSql(new Date(guess - off * 60000));
}

function isValidTz(tz) {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch (e) {
		return false;
	}
}

// ─── EMAIL ──────────────────────────────────────────────
const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;
const ROLE = new Set(["admin", "administrator", "info", "sales", "support", "office", "contact", "contacts", "hello", "noreply", "no-reply", "postmaster", "abuse", "webmaster", "billing", "help", "marketing", "team", "hr", "jobs", "mail", "manager", "service", "accounting", "order", "orders"]);

/** Нормалізація: trim, lowercase, mailto:, IDN → punycode. null = невалідний */
function normalizeEmail(raw) {
	const s = String(raw ?? "")
		.trim()
		.replace(/^mailto:/i, "")
		.replace(/^<|>$/g, "");
	if (!s || s.length > 254) return null;
	const at = s.lastIndexOf("@");
	if (at < 1 || at === s.length - 1) return null;
	const local = s.slice(0, at).toLowerCase();
	const domain = domainToASCII(s.slice(at + 1).toLowerCase().replace(/\.$/, ""));
	if (!domain || local.length > 64 || !LOCAL_RE.test(local) || !DOMAIN_RE.test(domain)) return null;
	const email = `${local}@${domain}`;
	if (email.length > 254) return null;
	return { email, local, domain, is_role: ROLE.has(local.split("+")[0]) };
}

// ─── IP ─────────────────────────────────────────────────
function ipToBin(ip) {
	const s = String(ip || "").replace(/^::ffff:/, "");
	const v = net.isIP(s);
	if (v === 4) return Buffer.from(s.split(".").map(Number));
	if (v !== 6) return null;
	const [h, tl] = s.split("::");
	const hp = h ? h.split(":") : [];
	const tp = tl !== undefined && tl ? tl.split(":") : [];
	const fill = tl !== undefined ? Array(8 - hp.length - tp.length).fill("0") : [];
	const parts = [...hp, ...fill, ...tp];
	if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/i.test(p))) return null;
	return Buffer.from(parts.flatMap((p) => [parseInt(p, 16) >> 8, parseInt(p, 16) & 255]));
}

function binToIp(b) {
	if (!b) return null;
	const buf = Buffer.from(b);
	if (buf.length === 4) return [...buf].join(".");
	if (buf.length === 16) return [...Array(8)].map((_, i) => buf.readUInt16BE(i * 2).toString(16)).join(":");
	return null;
}

/** Контекст дії для журналу згод */
function ctxFromReq(req, source) {
	return {
		source,
		ip: req.ip,
		user_agent: req.headers["user-agent"] || null,
		id_user: req.user ? req.user.userId || req.user.id : null,
	};
}

// ─── ЗГОДИ (журнал, тільки INSERT) ──────────────────────
async function logConsent(db, c) {
	await (db || pool).query(
		`INSERT INTO ${T.consents} (id_contact, id_list, action, source, ip, user_agent, id_message, id_user, note, date_add)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
		[
			c.id_contact,
			c.id_list || null,
			c.action,
			String(c.source || "manual").slice(0, 64),
			ipToBin(c.ip),
			c.user_agent ? String(c.user_agent).slice(0, 512) : null,
			c.id_message || null,
			c.id_user || null,
			c.note ? String(c.note).slice(0, 512) : null,
		]
	);
}

// ─── СТОП-ЛИСТ ──────────────────────────────────────────
const SUPP_STATUS = { hard_bounce: "bounced", complaint: "complained", unsubscribe_all: "unsubscribed", manual: "cleaned", invalid: "cleaned" };

async function isSuppressed(email, domain, db) {
	const [rows] = await (db || pool).query(
		`SELECT reason FROM ${T.supp}
          WHERE (type = 'email' AND value = ?) OR (type = 'domain' AND value = ?)
          LIMIT 1`,
		[email, domain]
	);
	return rows[0] ? rows[0].reason : null;
}

/** s: {type:'email'|'domain', value, reason, id_message?, id_user?, note?} */
async function suppress(db, s) {
	const d = db || pool;
	if (!["email", "domain"].includes(s.type) || !SUPP_STATUS[s.reason]) throw err(400, "invalid_request");
	let value = String(s.value || "")
		.trim()
		.toLowerCase();
	if (s.type === "email") {
		const n = normalizeEmail(value);
		if (!n) throw err(400, "invalid_email");
		value = n.email;
	} else {
		value = domainToASCII(value.replace(/^@/, ""));
		if (!DOMAIN_RE.test(value)) throw err(400, "invalid_domain");
	}
	await d.query(
		`INSERT IGNORE INTO ${T.supp} (type, value, reason, id_message, id_user, note, date_add)
         VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
		[s.type, value, s.reason, s.id_message || null, s.id_user || null, s.note ? String(s.note).slice(0, 512) : null]
	);
	if (s.type === "email") {
		await d.query(`UPDATE ${T.contacts} SET status = ?, date_edit = UTC_TIMESTAMP() WHERE email = ? AND status = 'active'`, [SUPP_STATUS[s.reason], value]);
	}
	return { ok: true, value };
}

/**
 * Зняти зі стоп-листа. Відписку і скаргу зняти НЕ можна —
 * лише людина сама може підписатися знову (нова згода).
 */
async function unsuppress(id, ctx) {
	return withTx(async (conn) => {
		const [[row]] = await conn.query(`SELECT * FROM ${T.supp} WHERE id = ? FOR UPDATE`, [id]);
		if (!row) throw err(404, "not_found");
		if (["unsubscribe_all", "complaint"].includes(row.reason)) throw err(409, "suppression_requires_consent");
		await conn.query(`DELETE FROM ${T.supp} WHERE id = ?`, [id]);
		if (row.type === "email") {
			const [[c]] = await conn.query(`SELECT id FROM ${T.contacts} WHERE email = ?`, [row.value]);
			if (c) {
				await conn.query(`UPDATE ${T.contacts} SET status = 'active', soft_bounces = 0, date_edit = UTC_TIMESTAMP() WHERE id = ? AND status IN ('bounced','cleaned')`, [c.id]);
				await logConsent(conn, { id_contact: c.id, action: "resubscribe", ...ctx, source: "admin", note: "unsuppress:" + row.reason });
			}
		}
		return { ok: true };
	});
}

// ─── КОНТАКТИ ───────────────────────────────────────────
const cut = (v, l) => (v == null || v === "" ? null : String(v).trim().slice(0, l) || null);

/**
 * Створити або оновити контакт за email.
 * d: {email, first_name, last_name, id_client, id_lang, timezone, country, fields{}, source, id_import}
 * opt.updateExisting=false — існуючому контакту лише прив'язуємо клієнта.
 * Статус (відписка/bounce) цей метод НІКОЛИ не змінює.
 */
async function upsertContact(db, d, opt = {}) {
	const n = normalizeEmail(d.email);
	if (!n) throw err(400, "invalid_email");
	const s = await getSettings();
	const upd = opt.updateExisting !== false;
	const fields = d.fields && typeof d.fields === "object" && !Array.isArray(d.fields) && Object.keys(d.fields).length ? JSON.stringify(d.fields) : null;
	const tz = d.timezone && isValidTz(d.timezone) ? String(d.timezone).slice(0, 64) : null;
	const country = d.country && /^[a-z]{2}$/i.test(d.country) ? String(d.country).toUpperCase() : null;
	const idLang = parseInt(d.id_lang, 10) || null;

	const updates = upd
		? `first_name = COALESCE(n.first_name, ${T.contacts}.first_name),
           last_name  = COALESCE(n.last_name, ${T.contacts}.last_name),
           id_lang    = IF(?, n.id_lang, ${T.contacts}.id_lang),
           timezone   = COALESCE(n.timezone, ${T.contacts}.timezone),
           country    = COALESCE(n.country, ${T.contacts}.country),
           fields     = IF(n.fields IS NULL, ${T.contacts}.fields, JSON_MERGE_PATCH(COALESCE(${T.contacts}.fields, JSON_OBJECT()), n.fields)),`
		: "";

	const [r] = await (db || pool).query(
		`INSERT INTO ${T.contacts}
            (email, email_domain, id_client, first_name, last_name, id_lang, timezone, country, fields, is_role, source, id_import, date_add)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP()) AS n
         ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(${T.contacts}.id),
            ${updates}
            id_client = COALESCE(${T.contacts}.id_client, n.id_client),
            deleted = 0, date_deleted = NULL, id_user_deleted = NULL,
            date_edit = UTC_TIMESTAMP()`,
		[
			n.email,
			n.domain,
			parseInt(d.id_client, 10) || null,
			cut(d.first_name, 128),
			cut(d.last_name, 128),
			idLang || s.default_id_lang,
			tz,
			country,
			fields,
			n.is_role ? 1 : 0,
			String(d.source || "manual").slice(0, 32),
			parseInt(d.id_import, 10) || null,
			...(upd ? [idLang ? 1 : 0] : []),
		]
	);
	return { id: r.insertId, created: r.affectedRows === 1, email: n.email };
}

async function getContact(id, db) {
	const [[c]] = await (db || pool).query(`SELECT * FROM ${T.contacts} WHERE id = ?`, [id]);
	return c || null;
}

async function getContactByEmail(email, db) {
	const n = normalizeEmail(email);
	if (!n) return null;
	const [[c]] = await (db || pool).query(`SELECT * FROM ${T.contacts} WHERE email = ?`, [n.email]);
	return c || null;
}

async function deleteContact(id, idUser) {
	await pool.query(`UPDATE ${T.contacts} SET deleted = 1, date_deleted = UTC_TIMESTAMP(), id_user_deleted = ? WHERE id = ?`, [idUser || null, id]);
	return { ok: true };
}

/**
 * GDPR «право на забуття»: знеособлюємо контакт, email лишається у стоп-листі,
 * щоб повторний імпорт не відновив розсилку.
 */
async function eraseContact(id, ctx) {
	return withTx(async (conn) => {
		const c = await getContact(id, conn);
		if (!c) throw err(404, "not_found");
		await suppress(conn, { type: "email", value: c.email, reason: "unsubscribe_all", id_user: ctx.id_user, note: "erase" });
		await logConsent(conn, { id_contact: id, action: "erase", ...ctx });
		await conn.query(
			`UPDATE ${T.contacts}
                SET first_name = NULL, last_name = NULL, fields = NULL, id_client = NULL, timezone = NULL, country = NULL,
                    status = 'unsubscribed', deleted = 1, date_deleted = UTC_TIMESTAMP(), id_user_deleted = ?
              WHERE id = ?`,
			[ctx.id_user || null, id]
		);
		await conn.query(`DELETE FROM ${T.subs} WHERE id_contact = ?`, [id]);
		await conn.query(`UPDATE ${T.events} SET ip = NULL, user_agent = NULL WHERE id_contact = ?`, [id]);
		return { ok: true };
	});
}

// ─── ПІДПИСКИ ───────────────────────────────────────────
/**
 * o: {source, double_optin, force, consent_action, ctx}
 * force=true — людина САМА підписується знову (форма, preference center).
 * Без force відписаний контакт НЕ підписується (імпорт, синхронізація, адмін).
 * Повертає 'subscribed' | 'pending' | 'unsubscribed' | 'blocked'.
 */
async function subscribe(db, idContact, idList, o = {}) {
	const d = db || pool;
	const ctx = o.ctx || {};
	const c = await getContact(idContact, d);
	if (!c) throw err(404, "contact_not_found");

	if (c.status !== "active") {
		// Bounce/скарга/очищення — лише через зняття зі стоп-листа
		if (c.status !== "unsubscribed" || !o.force) return c.status === "unsubscribed" ? "unsubscribed" : "blocked";
		await d.query(`DELETE FROM ${T.supp} WHERE type = 'email' AND value = ? AND reason = 'unsubscribe_all'`, [c.email]);
		await d.query(`UPDATE ${T.contacts} SET status = 'active', date_edit = UTC_TIMESTAMP() WHERE id = ?`, [idContact]);
	}

	const [[cur]] = await d.query(`SELECT status FROM ${T.subs} WHERE id_contact = ? AND id_list = ?`, [idContact, idList]);
	if (cur && cur.status === "subscribed") return "subscribed";
	if (cur && cur.status === "unsubscribed" && !o.force) return "unsubscribed";

	const status = o.double_optin ? "pending" : "subscribed";
	await d.query(
		`INSERT INTO ${T.subs} (id_contact, id_list, status, source, date_subscribed, date_confirmed, date_unsubscribed)
         VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?, NULL) AS n
         ON DUPLICATE KEY UPDATE status = n.status, source = n.source, date_subscribed = n.date_subscribed,
                                 date_confirmed = n.date_confirmed, date_unsubscribed = NULL`,
		[idContact, idList, status, String(o.source || "manual").slice(0, 32), status === "subscribed" ? toSql(new Date()) : null]
	);
	await logConsent(d, {
		...ctx,
		id_contact: idContact,
		id_list: idList,
		action: o.consent_action || (cur && cur.status === "unsubscribed" ? "resubscribe" : "subscribe"),
		source: ctx.source || o.source,
	});
	return status;
}

/** Double opt-in: підтвердити pending-підписки контакту (усі або один список) у межах TTL */
async function confirm(idContact, idList, ctx = {}) {
	const s = await getSettings();
	return withTx(async (conn) => {
		const [rows] = await conn.query(
			`SELECT id_list FROM ${T.subs}
              WHERE id_contact = ? AND status = 'pending' ${idList ? "AND id_list = ?" : ""}
                AND date_subscribed >= UTC_TIMESTAMP() - INTERVAL ? DAY
              FOR UPDATE`,
			idList ? [idContact, idList, s.double_optin_ttl_days] : [idContact, s.double_optin_ttl_days]
		);
		for (const r of rows) {
			await conn.query(`UPDATE ${T.subs} SET status = 'subscribed', date_confirmed = UTC_TIMESTAMP() WHERE id_contact = ? AND id_list = ?`, [idContact, r.id_list]);
			await logConsent(conn, { ...ctx, id_contact: idContact, id_list: r.id_list, action: "confirm" });
		}
		return { confirmed: rows.length };
	});
}

/**
 * Відписка. o: {id_list (null = від усього), id_message, ctx}
 * Від усього → статус контакту unsubscribed + стоп-лист (переживе видалення і повторний імпорт).
 */
async function unsubscribe(db, idContact, o = {}) {
	const d = db || pool;
	const ctx = o.ctx || {};
	const c = await getContact(idContact, d);
	if (!c) throw err(404, "contact_not_found");

	if (o.id_list) {
		const [r] = await d.query(`UPDATE ${T.subs} SET status = 'unsubscribed', date_unsubscribed = UTC_TIMESTAMP() WHERE id_contact = ? AND id_list = ? AND status <> 'unsubscribed'`, [idContact, o.id_list]);
		if (r.affectedRows) await logConsent(d, { ...ctx, id_contact: idContact, id_list: o.id_list, action: "unsubscribe", id_message: o.id_message });
	} else {
		await d.query(`UPDATE ${T.subs} SET status = 'unsubscribed', date_unsubscribed = UTC_TIMESTAMP() WHERE id_contact = ? AND status <> 'unsubscribed'`, [idContact]);
		await suppress(d, { type: "email", value: c.email, reason: "unsubscribe_all", id_message: o.id_message, id_user: ctx.id_user });
		await logConsent(d, { ...ctx, id_contact: idContact, action: "unsubscribe_all", id_message: o.id_message });
	}

	// Атрибуція відписки до листа (лише перша)
	if (o.id_message) {
		const [r] = await d.query(`UPDATE ${T.messages} SET date_unsubscribed = UTC_TIMESTAMP() WHERE id = ? AND id_contact = ? AND date_unsubscribed IS NULL`, [o.id_message, idContact]);
		if (r.affectedRows) {
			await d.query(
				`INSERT INTO ${T.events} (id_message, id_campaign, id_contact, type, ip, user_agent, meta, date_add)
                 SELECT id, id_campaign, id_contact, 'unsubscribe', ?, ?, ?, UTC_TIMESTAMP(3) FROM ${T.messages} WHERE id = ?`,
				[ipToBin(ctx.ip), ctx.user_agent ? String(ctx.user_agent).slice(0, 512) : null, JSON.stringify({ id_list: o.id_list || null, source: ctx.source || null }), o.id_message]
			);
		}
	}
	return { ok: true };
}

async function contactSubscriptions(idContact, idLang) {
	const s = await getSettings();
	const [rows] = await pool.query(
		`SELECT l.id, l.code, l.is_public, s.status, s.date_subscribed, s.date_unsubscribed,
                COALESCE(ll.name, lf.name, l.code) AS name, COALESCE(ll.description, lf.description) AS description
           FROM ${T.lists} l
           LEFT JOIN ${T.subs} s ON s.id_list = l.id AND s.id_contact = ?
           LEFT JOIN ${T.listsLang} ll ON ll.id_list = l.id AND ll.id_lang = ?
           LEFT JOIN ${T.listsLang} lf ON lf.id_list = l.id AND lf.id_lang = ?
          WHERE l.deleted = 0 AND l.active = 1
          ORDER BY l.sort_order, l.id`,
		[idContact, idLang, s.default_id_lang]
	);
	return rows;
}

// ─── СПИСКИ ─────────────────────────────────────────────
async function lists(idLang, opt = {}) {
	const s = await getSettings();
	const counts = opt.withCounts
		? `, (SELECT COUNT(*) FROM ${T.subs} s INNER JOIN ${T.contacts} mc ON mc.id = s.id_contact AND mc.deleted = 0 AND mc.status = 'active'
               WHERE s.id_list = l.id AND s.status = 'subscribed') AS cnt_subscribed,
             (SELECT COUNT(*) FROM ${T.subs} s WHERE s.id_list = l.id AND s.status = 'pending') AS cnt_pending,
             (SELECT COUNT(*) FROM ${T.subs} s WHERE s.id_list = l.id AND s.status = 'unsubscribed') AS cnt_unsubscribed`
		: "";
	const [rows] = await pool.query(
		`SELECT l.*, COALESCE(ll.name, lf.name, l.code) AS name, COALESCE(ll.description, lf.description) AS description ${counts}
           FROM ${T.lists} l
           LEFT JOIN ${T.listsLang} ll ON ll.id_list = l.id AND ll.id_lang = ?
           LEFT JOIN ${T.listsLang} lf ON lf.id_list = l.id AND lf.id_lang = ?
          WHERE l.deleted = 0 ${opt.activeOnly ? "AND l.active = 1" : ""}
          ORDER BY l.sort_order, l.id`,
		[idLang, s.default_id_lang]
	);
	return rows;
}

async function getList(id) {
	const [[l]] = await pool.query(`SELECT * FROM ${T.lists} WHERE id = ? AND deleted = 0`, [id]);
	if (!l) return null;
	const [lang] = await pool.query(`SELECT id_lang, name, description FROM ${T.listsLang} WHERE id_list = ?`, [id]);
	l.lang = Object.fromEntries(lang.map((r) => [r.id_lang, { name: r.name, description: r.description }]));
	return l;
}

/** b — провалідовані дані: {code, is_public, double_optin, sort_order, active, lang: {id_lang: {name, description}}} */
async function saveList(id, b) {
	return withTx(async (conn) => {
		const vals = [
			String(b.code).trim().toLowerCase(),
			b.is_public ? 1 : 0,
			b.double_optin ? 1 : 0,
			parseInt(b.sort_order, 10) || 0,
			b.active === undefined || b.active ? 1 : 0,
		];
		let listId = id;
		try {
			if (id) {
				const [r] = await conn.query(`UPDATE ${T.lists} SET code = ?, is_public = ?, double_optin = ?, sort_order = ?, active = ?, date_edit = UTC_TIMESTAMP() WHERE id = ? AND deleted = 0`, [...vals, id]);
				if (!r.affectedRows) throw err(404, "not_found");
			} else {
				const [r] = await conn.query(`INSERT INTO ${T.lists} (code, is_public, double_optin, sort_order, active, date_add) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())`, vals);
				listId = r.insertId;
			}
		} catch (e) {
			if (e.code === "ER_DUP_ENTRY") throw err(409, "code_exists", { errors: [{ field: "code", message: "code_exists" }] });
			throw e;
		}
		const langs = await languages();
		for (const [lang, v] of Object.entries(b.lang || {})) {
			const idLang = parseInt(lang, 10);
			if (!langs.has(idLang) || !v || !String(v.name || "").trim()) continue;
			await conn.query(
				`INSERT INTO ${T.listsLang} (id_list, id_lang, name, description) VALUES (?, ?, ?, ?) AS n
                 ON DUPLICATE KEY UPDATE name = n.name, description = n.description`,
				[listId, idLang, String(v.name).trim().slice(0, 128), v.description ? String(v.description).trim().slice(0, 512) : null]
			);
		}
		return { ok: true, id: listId };
	});
}

async function deleteList(id, idUser) {
	const [[used]] = await pool.query(
		`SELECT COUNT(*) AS n FROM ${T.campaigns}
          WHERE deleted = 0 AND status IN ('scheduled','preparing','sending','paused')
            AND JSON_CONTAINS(audience->'$.lists', CAST(? AS JSON))`,
		[String(parseInt(id, 10))]
	);
	if (used.n) throw err(409, "list_in_active_campaign");
	await pool.query(`UPDATE ${T.lists} SET deleted = 1, date_deleted = UTC_TIMESTAMP(), id_user_deleted = ? WHERE id = ?`, [idUser || null, id]);
	return { ok: true };
}

// ─── ДОДАТКОВІ ПОЛЯ ─────────────────────────────────────
const FIELD_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVED_FIELDS = new Set(["email", "first_name", "last_name", "full_name", "id", "id_lang", "timezone", "country", "unsubscribe_url", "preferences_url", "web_version_url", "company", "company_address", "current_year"]);

async function fields() {
	const [rows] = await pool.query(`SELECT * FROM ${T.fields} ORDER BY sort_order, id`);
	return rows;
}

async function ensureField(db, code, name, type = "text") {
	const c = String(code || "")
		.trim()
		.toLowerCase();
	if (!FIELD_CODE_RE.test(c) || RESERVED_FIELDS.has(c)) throw err(400, "invalid_field_code");
	await (db || pool).query(`INSERT IGNORE INTO ${T.fields} (code, name, type, date_add) VALUES (?, ?, ?, UTC_TIMESTAMP())`, [c, String(name || c).slice(0, 128), ["text", "number", "date", "bool"].includes(type) ? type : "text"]);
	return c;
}

async function deleteField(id) {
	const [r] = await pool.query(`DELETE FROM ${T.fields} WHERE id = ?`, [id]);
	if (!r.affectedRows) throw err(404, "not_found");
	// Значення в contacts.fields лишаються — без опису поле не показується
	return { ok: true };
}

// ─── ЗВ'ЯЗОК З КЛІЄНТАМИ ────────────────────────────────
/** Прив'язати контакти до клієнтів за email + перевести зі злитих клієнтів на актуальних */
async function linkClients() {
	const dict = require("../clients/dictionaries");
	const emailType = await dict.idOf("contact_types", "email");
	await pool.query(
		`UPDATE ${T.contacts} mc
           INNER JOIN ${P}clients c ON c.id = mc.id_client AND c.id_merged_into IS NOT NULL
            SET mc.id_client = c.id_merged_into`
	);
	if (!emailType) return { linked: 0 };
	const [r] = await pool.query(
		`UPDATE ${T.contacts} mc
           INNER JOIN ${P}clients_contact_points cp ON cp.id_contact_type = ? AND cp.value_normalized = mc.email
           INNER JOIN ${P}clients c ON c.id = cp.id_client AND c.deleted_at IS NULL AND c.id_merged_into IS NULL
            SET mc.id_client = c.id
          WHERE mc.id_client IS NULL`,
		[emailType]
	);
	return { linked: r.affectedRows };
}

/**
 * Синхронізація клієнтів зі згодою на розсилки (marketing_consent = 1) у список з налаштувань.
 * Згоду знято в картці клієнта → відписуємо зі списку синхронізації.
 * Явно відписаних НЕ підписуємо знову.
 */
async function syncFromClients() {
	const s = await getSettings();
	const idList = parseInt(s.clients_sync && s.clients_sync.id_list, 10);
	if (!s.clients_sync || !s.clients_sync.enabled || !idList) return { skipped: true };

	const dict = require("../clients/dictionaries");
	const emailType = await dict.idOf("contact_types", "email");
	if (!emailType) return { skipped: true };

	await linkClients();

	let added = 0;
	let removed = 0;

	const [rows] = await pool.query(
		`SELECT cp.id_client, cp.value_normalized AS email, c.id_lang, c.timezone, c.country, p.first_name, p.last_name
           FROM ${P}clients_contact_points cp
           INNER JOIN ${P}clients c ON c.id = cp.id_client AND c.deleted_at IS NULL AND c.id_merged_into IS NULL
           LEFT JOIN ${P}clients_persons p ON p.id_client = c.id
          WHERE cp.id_contact_type = ? AND cp.marketing_consent = 1
            AND NOT EXISTS (
                SELECT 1 FROM ${T.subs} s INNER JOIN ${T.contacts} mc ON mc.id = s.id_contact
                 WHERE mc.email = cp.value_normalized AND s.id_list = ?)
          LIMIT 2000`,
		[emailType, idList]
	);
	for (const r of rows) {
		try {
			await withTx(async (conn) => {
				const c = await upsertContact(conn, { ...r, source: "client" }, { updateExisting: false });
				const st = await subscribe(conn, c.id, idList, { source: "client", double_optin: false, ctx: { source: "client:" + r.id_client } });
				if (st === "subscribed") added++;
			});
		} catch (e) {
			if (e.status !== 400) console.error("[mailing:sync]", e.message);
		}
	}

	const [revoked] = await pool.query(
		`SELECT s.id_contact
           FROM ${T.subs} s
           INNER JOIN ${T.contacts} mc ON mc.id = s.id_contact
           INNER JOIN ${P}clients_contact_points cp ON cp.id_client = mc.id_client AND cp.id_contact_type = ? AND cp.value_normalized = mc.email
          WHERE s.id_list = ? AND s.status = 'subscribed' AND s.source = 'client' AND cp.marketing_consent = 0
          LIMIT 2000`,
		[emailType, idList]
	);
	for (const r of revoked) {
		await unsubscribe(null, r.id_contact, { id_list: idList, ctx: { source: "client_consent_revoked" } });
		removed++;
	}
	return { added, removed };
}

module.exports = {
	pool,
	P,
	T,
	err,
	ints,
	toSql,
	withTx,
	SETTINGS_DEFAULT,
	getSettings,
	saveSettings,
	languages,
	localeOf,
	idLangOfIso,
	t,
	tzOffsetMin,
	zonedToUtc,
	isValidTz,
	normalizeEmail,
	ipToBin,
	binToIp,
	ctxFromReq,
	logConsent,
	isSuppressed,
	suppress,
	unsuppress,
	upsertContact,
	getContact,
	getContactByEmail,
	deleteContact,
	eraseContact,
	subscribe,
	confirm,
	unsubscribe,
	contactSubscriptions,
	lists,
	getList,
	saveList,
	deleteList,
	FIELD_CODE_RE,
	RESERVED_FIELDS,
	fields,
	ensureField,
	deleteField,
	linkClients,
	syncFromClients,
};