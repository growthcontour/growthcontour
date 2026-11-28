"use strict";
/**
 * Події розсилки: відкриття, кліки (з відсіюванням машинних), bounce, скарги,
 * IMAP-збирач (VERP), лист підтвердження double opt-in.
 * Тексти листа підтвердження — лише з locales/{iso}/mailing/mailing.json.
 */
const model = require("./model");
const render = require("./render");
const sender = require("./sender");

const { pool, T } = model;

// ─── ДОПОМІЖНЕ ──────────────────────────────────────────
// Дедуплікація в пам'яті (з межею розміру — захист від переповнення)
const recent = new Map();
function seenRecently(key, ms) {
	const now = Date.now();
	const t = recent.get(key);
	if (t && now - t < ms) return true;
	if (recent.size > 50000) recent.clear();
	recent.set(key, now);
	return false;
}

const BOT_UA = /(bot\b|bot\/|crawl|spider|slurp|python|curl|wget|go-http|java\/|okhttp|axios|node-fetch|libwww|httpclient|headless|phantom|barracuda|mimecast|proofpoint|symantec|forcepoint|trendmicro|sophos|messagelabs|safelinks|linkscanner|urldefense|ironport|fortinet|zscaler|scanner|facebookexternalhit|slackbot|whatsapp|telegrambot|skypeuripreview|discordbot)/i;

function parseUa(ua) {
	const s = String(ua || "");
	let mail_client = null;
	if (/GoogleImageProxy/i.test(s)) mail_client = "gmail";
	else if (/YahooMailProxy/i.test(s)) mail_client = "yahoo";
	else if (/Outlook|Microsoft Office|MSOffice|ms-office/i.test(s)) mail_client = "outlook";
	else if (/Thunderbird/i.test(s)) mail_client = "thunderbird";
	else if (/(iPhone|iPad|Macintosh).*AppleWebKit/i.test(s) && !/Safari|Chrome|CriOS|Firefox/i.test(s)) mail_client = "apple_mail";
	else if (/Android/i.test(s) && /;\s*wv\)/i.test(s)) mail_client = "android_app";
	else if (s) mail_client = "browser";
	const device = !s ? null : /iPad|Tablet/i.test(s) ? "tablet" : /Mobi|iPhone|Android/i.test(s) ? "mobile" : "desktop";
	return { mail_client, device };
}

const isAppleIp = (ip) => {
	const b = model.ipToBin(ip);
	return !!(b && b.length === 4 && b[0] === 17);
};

/**
 * Машинне відкриття?
 * Apple Mail Privacy Protection: мінімальний UA "Mozilla/5.0" або IP-мережа Apple 17.0.0.0/8.
 * Gmail/Yahoo-проксі — реальне відкриття (картинку тягнуть, коли людина відкрила лист).
 */
function machineOpen(age, meta) {
	const ua = String(meta.ua || "");
	if (!ua) return "no_ua";
	if (BOT_UA.test(ua)) return "scanner_ua";
	if (/^Mozilla\/5\.0$/.test(ua.trim()) || isAppleIp(meta.ip)) return "apple_mpp";
	if (age !== null && age < 3) return "scanner_fast";
	return null;
}

function machineClick(age, meta) {
	const ua = String(meta.ua || "");
	if (meta.method === "HEAD") return "head";
	if (!ua) return "no_ua";
	if (BOT_UA.test(ua)) return "scanner_ua";
	if (age !== null && age < 10) return "scanner_fast";
	return null;
}

async function insertEvent(e) {
	await pool.query(
		`INSERT INTO ${T.events}
            (id_message, id_campaign, id_contact, type, id_link, is_machine, machine_reason, ip, user_agent, device, mail_client, meta, date_add)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
		[
			e.id_message || null,
			e.id_campaign || null,
			e.id_contact || null,
			e.type,
			e.id_link || null,
			e.machine ? 1 : 0,
			e.machine || null,
			model.ipToBin(e.ip),
			e.ua ? String(e.ua).slice(0, 512) : null,
			e.device || null,
			e.mail_client || null,
			e.meta ? JSON.stringify(e.meta) : null,
		]
	);
}

// ─── ВІДКРИТТЯ ──────────────────────────────────────────
async function recordOpen(idMessage, meta) {
	if (seenRecently("o" + idMessage, 30000)) return;
	const [[m]] = await pool.query(
		`SELECT id, id_campaign, id_contact, date_sent, TIMESTAMPDIFF(SECOND, date_sent, UTC_TIMESTAMP()) AS age
           FROM ${T.messages} WHERE id = ?`,
		[idMessage]
	);
	if (!m || !m.date_sent) return;

	const ua = parseUa(meta.ua);
	const machine = machineOpen(m.age === null ? null : Number(m.age), meta);
	await insertEvent({ id_message: m.id, id_campaign: m.id_campaign, id_contact: m.id_contact, type: "open", machine, ip: meta.ip, ua: meta.ua, ...ua });

	await pool.query(
		`UPDATE ${T.messages}
            SET cnt_opens = LEAST(cnt_opens + 1, 65535),
                date_first_open = COALESCE(date_first_open, UTC_TIMESTAMP())
                ${machine ? "" : ", date_first_open_human = COALESCE(date_first_open_human, UTC_TIMESTAMP())"}
          WHERE id = ?`,
		[m.id]
	);
	if (!machine) await pool.query(`UPDATE ${T.contacts} SET date_last_open = UTC_TIMESTAMP(), soft_bounces = 0 WHERE id = ?`, [m.id_contact]);
}

// ─── КЛІК ───────────────────────────────────────────────
/** Повертає безпечний URL для редіректу або null. URL — ЛИШЕ з mailing_links кампанії цього листа. */
async function recordClick(idMessage, idLink, meta) {
	const [[r]] = await pool.query(
		`SELECT l.url, m.id, m.id_campaign, m.id_contact, m.date_sent, TIMESTAMPDIFF(SECOND, m.date_sent, UTC_TIMESTAMP()) AS age
           FROM ${T.links} l
           INNER JOIN ${T.messages} m ON m.id = ? AND m.id_campaign = l.id_campaign
          WHERE l.id = ?`,
		[idMessage, idLink]
	);
	if (!r) return null;

	let target;
	try {
		const u = new URL(r.url);
		if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
		target = u.href;
	} catch (e) {
		return null;
	}
	if (!r.date_sent || seenRecently(`c${idMessage}:${idLink}`, 2000)) return target;

	const ua = parseUa(meta.ua);
	let machine = machineClick(r.age === null ? null : Number(r.age), meta);

	// Сканер «прокликує» всі посилання листа за секунди
	if (!machine) {
		const [[b]] = await pool.query(
			`SELECT COUNT(DISTINCT id_link) AS n FROM ${T.events}
              WHERE id_message = ? AND type = 'click' AND id_link <> ? AND date_add >= UTC_TIMESTAMP(3) - INTERVAL 3 SECOND`,
			[r.id, idLink]
		);
		if (Number(b.n) >= 2) {
			machine = "all_links";
			await pool.query(`UPDATE ${T.events} SET is_machine = 1, machine_reason = 'all_links' WHERE id_message = ? AND type = 'click' AND date_add >= UTC_TIMESTAMP(3) - INTERVAL 3 SECOND`, [r.id]);
		}
	}

	let firstOnLink = false;
	if (!machine) {
		const [[ex]] = await pool.query(`SELECT 1 AS x FROM ${T.events} WHERE id_message = ? AND type = 'click' AND id_link = ? AND is_machine = 0 LIMIT 1`, [r.id, idLink]);
		firstOnLink = !ex;
	}

	await insertEvent({ id_message: r.id, id_campaign: r.id_campaign, id_contact: r.id_contact, type: "click", id_link: idLink, machine, ip: meta.ip, ua: meta.ua, ...ua });
	if (machine) return target;

	await pool.query(`UPDATE ${T.links} SET cnt_clicks = cnt_clicks + 1, cnt_clicks_unique = cnt_clicks_unique + ? WHERE id = ?`, [firstOnLink ? 1 : 0, idLink]);
	await pool.query(
		`UPDATE ${T.messages}
            SET cnt_clicks = LEAST(cnt_clicks + 1, 65535),
                date_first_click = COALESCE(date_first_click, UTC_TIMESTAMP()),
                date_first_open = COALESCE(date_first_open, UTC_TIMESTAMP()),
                date_first_open_human = COALESCE(date_first_open_human, UTC_TIMESTAMP())
          WHERE id = ?`,
		[r.id]
	);
	await pool.query(`UPDATE ${T.contacts} SET date_last_click = UTC_TIMESTAMP(), date_last_open = UTC_TIMESTAMP(), soft_bounces = 0 WHERE id = ?`, [r.id_contact]);
	return target;
}

// ─── ПОВНИЙ ЛИСТ (веб-версія) ───────────────────────────
async function loadMessageFull(idMessage) {
	const [[m]] = await pool.query(
		`SELECT m.*, mc.first_name, mc.last_name, mc.fields, mc.deleted AS contact_deleted,
                c.name AS campaign_name, c.track_opens, c.track_clicks, c.utm
           FROM ${T.messages} m
           INNER JOIN ${T.contacts} mc ON mc.id = m.id_contact
           INNER JOIN ${T.campaigns} c ON c.id = m.id_campaign
          WHERE m.id = ?`,
		[idMessage]
	);
	return m || null;
}

// ─── BOUNCE / СКАРГИ ────────────────────────────────────
async function bounce(idMessage, type, meta) {
	const [[m]] = await pool.query(`SELECT id, id_campaign, id_contact, email FROM ${T.messages} WHERE id = ?`, [idMessage]);
	if (!m) return;
	await insertEvent({ id_message: m.id, id_campaign: m.id_campaign, id_contact: m.id_contact, type: "bounce", meta: { bounce: type, ...meta } });

	if (type === "hard") {
		await pool.query(`UPDATE ${T.messages} SET status = 'bounced', bounce_type = 'hard' WHERE id = ?`, [m.id]);
		await model.suppress(null, { type: "email", value: m.email, reason: "hard_bounce", id_message: m.id, note: String(meta.status || "") });
		return;
	}
	if (type === "soft") {
		await pool.query(`UPDATE ${T.messages} SET bounce_type = COALESCE(bounce_type, 'soft') WHERE id = ?`, [m.id]);
		await pool.query(`UPDATE ${T.contacts} SET soft_bounces = LEAST(soft_bounces + 1, 255) WHERE id = ?`, [m.id_contact]);
		const s = await model.getSettings();
		const [[c]] = await pool.query(`SELECT soft_bounces FROM ${T.contacts} WHERE id = ?`, [m.id_contact]);
		if (c && c.soft_bounces >= (parseInt(s.soft_bounce_limit, 10) || 3)) {
			await model.suppress(null, { type: "email", value: m.email, reason: "invalid", id_message: m.id, note: "soft_bounce_limit" });
		}
	}
	// blocked (5.7.x) — лише подія: адреса робоча, проблема в репутації/контенті
}

async function complaint(idMessage, meta) {
	const [[m]] = await pool.query(`SELECT id, id_campaign, id_contact, email FROM ${T.messages} WHERE id = ?`, [idMessage]);
	if (!m) return;
	const [r] = await pool.query(`UPDATE ${T.messages} SET date_complained = UTC_TIMESTAMP() WHERE id = ? AND date_complained IS NULL`, [m.id]);
	if (!r.affectedRows) return;
	await insertEvent({ id_message: m.id, id_campaign: m.id_campaign, id_contact: m.id_contact, type: "complaint", meta });
	await model.suppress(null, { type: "email", value: m.email, reason: "complaint", id_message: m.id });
	await model.unsubscribe(null, m.id_contact, { id_message: m.id, ctx: { source: "complaint" } });
}

// ─── IMAP-ЗБИРАЧ ────────────────────────────────────────
const MAX_RAW = 5 * 1024 * 1024;
const PER_RUN = 200;

function collectRecipients(mail) {
	const out = [];
	const add = (v) => {
		if (!v) return;
		if (Array.isArray(v)) return v.forEach(add);
		if (typeof v === "string") return out.push(...v.split(/[,\s]+/));
		if (v.value) return add(v.value);
		if (v.address) out.push(v.address);
	};
	add(mail.to);
	add(mail.cc);
	for (const h of ["delivered-to", "x-original-to", "envelope-to", "x-envelope-to"]) add(mail.headers.get(h));
	return out
		.map((a) => String(a).replace(/[<>]/g, "").trim().toLowerCase())
		.filter((a) => a.includes("@"))
		.slice(0, 50);
}

async function findReference(mail, allText) {
	for (const a of collectRecipients(mail)) {
		const p = render.verpParse(a.split("@")[0]);
		if (p) return p;
	}
	const ref = /X-GC-Ref:\s*([A-Za-z0-9_-]{4,64}\.[A-Za-z0-9_-]{16})/i.exec(allText);
	if (ref) {
		const v = render.verify(ref[1], "v");
		if (v) return { kind: "b", id: v.id };
	}
	const mid = /^Message-ID:\s*(<[^>\s]{5,250}>)/im.exec(allText);
	if (mid) {
		const [[r]] = await pool.query(`SELECT id FROM ${T.messages} WHERE message_id = ? LIMIT 1`, [mid[1]]);
		if (r) return { kind: "b", id: r.id };
	}
	return null;
}

async function handleInbound(raw) {
	const { simpleParser } = require("mailparser");
	const mail = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: 1024 * 1024 });

	// Текст службових частин (delivery-status, feedback-report, вкладений оригінал)
	const parts = [String(mail.text || "").slice(0, 200000)];
	for (const a of (mail.attachments || []).slice(0, 10)) {
		if (/^(message\/(delivery-status|feedback-report|rfc822|global-delivery-status)|text\/rfc822-headers)/i.test(a.contentType || "") && a.size < 1024 * 1024) {
			parts.push(a.content.toString("utf8"));
		}
	}
	const all = parts.join("\n");

	const ref = await findReference(mail, all);
	if (!ref) return "unmatched";

	const ct = mail.headers.get("content-type");
	const reportType = String((ct && ct.params && ct.params["report-type"]) || "").toLowerCase();

	// mailto-відписка з List-Unsubscribe
	if (ref.kind === "u") {
		const [[m]] = await pool.query(`SELECT id, id_contact FROM ${T.messages} WHERE id = ?`, [ref.id]);
		if (m) await model.unsubscribe(null, m.id_contact, { id_message: m.id, ctx: { source: "mailto" } });
		return "unsubscribe";
	}

	// Скарга (ARF)
	if (reportType === "feedback-report" || /^Feedback-Type:\s*abuse/im.test(all)) {
		await complaint(ref.id, { source: "arf" });
		return "complaint";
	}

	// DSN (RFC 3464)
	const status = (/^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(all) || [])[1] || null;
	const action = String((/^Action:\s*([a-z]+)/im.exec(all) || [])[1] || "").toLowerCase();
	const diagnostic = String((/^Diagnostic-Code:\s*(.{1,500})$/im.exec(all) || [])[1] || "").trim();

	if (reportType === "delivery-status" || status) {
		if (action === "delayed" || (status && status[0] === "4")) return "delayed";
		if (status && status[0] === "5") {
			const [, sub, det] = status.split(".");
			const type = sub === "7" ? "blocked" : sub === "2" && det === "2" ? "soft" : "hard";
			await bounce(ref.id, type, { status, action, diagnostic, stage: "dsn" });
			return "bounce:" + type;
		}
		return "ignored";
	}

	// Нестандартні повідомлення про недоставку: шукаємо розширений код 5.1.x
	const enh = /\b5\.1\.[0-9]{1,3}\b/.exec(all);
	if (enh && /\b(550|551|553|554)\b/.test(all)) {
		await bounce(ref.id, "hard", { status: enh[0], diagnostic: "heuristic", stage: "text" });
		return "bounce:hard";
	}
	return "ignored";
}

async function pollSender(s) {
	const { ImapFlow } = require("imapflow");
	const pass = sender.unpack(s.imap_pass_enc);
	if (!pass) return;
	const port = Number(s.imap_port) || 993;
	const client = new ImapFlow({
		host: s.imap_host,
		port,
		secure: port === 993,
		auth: { user: s.imap_user, pass },
		logger: false,
		socketTimeout: 60000,
		tls: { minVersion: "TLSv1.2" },
	});
	await client.connect();
	const lock = await client.getMailboxLock(s.imap_mailbox || "INBOX");
	try {
		const uids = (await client.search({ seen: false }, { uid: true })) || [];
		for (const uid of uids.slice(0, PER_RUN)) {
			try {
				const meta = await client.fetchOne(uid, { size: true }, { uid: true });
				if (meta && meta.size <= MAX_RAW) {
					const full = await client.fetchOne(uid, { source: true }, { uid: true });
					if (full && full.source) await handleInbound(full.source);
				}
			} catch (e) {
				console.error("[mailing:imap]", s.id, uid, e.message);
			}
			await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }).catch(() => {});
		}
	} finally {
		lock.release();
		await client.logout().catch(() => {});
	}
}

async function pollBounces() {
	const [senders] = await pool.query(`SELECT * FROM ${T.senders} WHERE deleted = 0 AND active = 1 AND imap_host IS NOT NULL AND imap_user IS NOT NULL AND imap_pass_enc IS NOT NULL`);
	for (const s of senders) {
		try {
			await pollSender(s);
		} catch (e) {
			console.error("[mailing:imap]", s.id, e.message);
		}
	}
}

// ─── DOUBLE OPT-IN ──────────────────────────────────────
const emailAttempts = new Map();
/** Не більше 3 листів-підтверджень на адресу за добу (захист від «бомбардування» підписками) */
function allowEmailAttempt(email) {
	const now = Date.now();
	if (emailAttempts.size > 50000) emailAttempts.clear();
	const a = emailAttempts.get(email);
	if (!a || a.reset < now) {
		emailAttempts.set(email, { n: 1, reset: now + 86400000 });
		return true;
	}
	return ++a.n <= 3;
}

const esc = (v) => String(v).replace(/[&<>"']/g, (x) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[x]);

async function sendConfirmation(idContact) {
	const c = await model.getContact(idContact);
	const s = await sender.getDefault();
	if (!c || !s) return;
	const locale = await model.localeOf(c.id_lang);
	const tr = (k) => model.t(locale, "mailing.confirm_email." + k);
	const link = render.url.confirm(c.id, 0);
	await sender.send(s, {
		from: { name: s.from_name, address: s.from_email },
		to: c.email,
		subject: tr("subject"),
		text: `${tr("body")}\n\n${link}\n\n${tr("ignore")}`,
		html: `<!DOCTYPE html><html lang="${esc(locale)}"><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;font-size:15px;color:#222;">
<p>${esc(tr("body"))}</p>
<p><a href="${esc(link)}" style="display:inline-block;padding:12px 20px;background:#0d3b66;color:#fff;text-decoration:none;">${esc(tr("button"))}</a></p>
<p style="color:#888;font-size:12px;">${esc(tr("ignore"))}</p></body></html>`,
		headers: { "Auto-Submitted": "auto-generated" },
	});
}

module.exports = {
	parseUa,
	recordOpen,
	recordClick,
	loadMessageFull,
	bounce,
	complaint,
	handleInbound,
	pollBounces,
	allowEmailAttempt,
	sendConfirmation,
};