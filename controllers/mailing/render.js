"use strict";
/**
 * Рендер листа:
 * - токени публічних посилань (HMAC, без терміну дії)
 * - компіляція контенту: MJML → HTML, очищення вставленого HTML, CSS-інлайн, валідація
 * - підготовка шаблону кампанії (кеш): UTM, трекінг кліків, прехедер, футер, піксель
 * - персоналізація під отримувача + заголовки (List-Unsubscribe, VERP)
 * Тексти футера — лише з locales/{iso}/mailing/mailing.json.
 */
const crypto = require("crypto");
const sanitizeHtml = require("sanitize-html");
const juice = require("juice");
const model = require("./model");

const { pool, T, err } = model;

const SECRET = () => {
	const s = process.env.MAILING_TOKEN_SECRET;
	if (!s) throw new Error("MAILING_TOKEN_SECRET is not set");
	return s;
};
const hmac = (s) => crypto.createHmac("sha256", SECRET()).update(s).digest();
const jsonOf = (v) => (typeof v === "string" ? JSON.parse(v) : v || null);

// ═══ ТОКЕНИ ═════════════════════════════════════════════
// kind: u=відписка (лист), o=відкриття, c=клік, v=веб-версія, d=підтвердження, p=налаштування (контакт)
function sign(kind, id, extra = 0) {
	const payload = `${kind}.${Number(id).toString(36)}.${Number(extra).toString(36)}`;
	return `${Buffer.from(payload).toString("base64url")}.${hmac(payload).subarray(0, 12).toString("base64url")}`;
}

function verify(token, kind) {
	const [p, m] = String(token || "").split(".");
	if (!p || !m || p.length > 64 || m.length !== 16) return null;
	const payload = Buffer.from(p, "base64url").toString();
	if (!/^[a-z]\.[0-9a-z]{1,13}\.[0-9a-z]{1,13}$/.test(payload)) return null;
	const exp = hmac(payload).subarray(0, 12);
	const got = Buffer.from(m, "base64url");
	if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) return null;
	const [k, id, extra] = payload.split(".");
	if (kind && k !== kind) return null;
	const n = parseInt(id, 36);
	return n > 0 && Number.isSafeInteger(n) ? { kind: k, id: n, extra: parseInt(extra, 36) || 0 } : null;
}

// VERP: локальна частина email — лише lowercase (частина MTA не зберігає регістр)
function verpLocal(idMessage, kind = "b") {
	const id = Number(idMessage).toString(36);
	return `${kind}-${id}-${hmac(`verp.${kind}.${id}`).subarray(0, 5).toString("hex")}`;
}

function verpParse(local) {
	const m = /(?:^|\+)([bu])-([0-9a-z]{1,13})-([0-9a-f]{10})$/.exec(String(local || "").toLowerCase());
	if (!m) return null;
	const exp = hmac(`verp.${m[1]}.${m[2]}`).subarray(0, 5);
	const got = Buffer.from(m[3], "hex");
	if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) return null;
	return { kind: m[1], id: parseInt(m[2], 36) };
}

const publicBase = () => String(process.env.MAILING_PUBLIC_URL || process.env.APP_URL || "").replace(/\/+$/, "");

const url = {
	unsubscribe: (idMsg) => `${publicBase()}/mailing/unsubscribe/${sign("u", idMsg)}`,
	oneClick: (idMsg) => `${publicBase()}/api/mailing/unsubscribe/${sign("u", idMsg)}`,
	open: (idMsg) => `${publicBase()}/mailing/open/${sign("o", idMsg)}.gif`,
	click: (idMsg, idLink) => `${publicBase()}/mailing/click/${sign("c", idMsg, idLink)}`,
	web: (idMsg) => `${publicBase()}/mailing/view/${sign("v", idMsg)}`,
	confirm: (idContact, idList) => `${publicBase()}/mailing/confirm/${sign("d", idContact, idList)}`,
	prefs: (idContact) => `${publicBase()}/mailing/preferences/${sign("p", idContact)}`,
};

// ═══ HTML: ОЧИЩЕННЯ ═════════════════════════════════════
const ATTR_ALL = ["style", "class", "id", "align", "valign", "width", "height", "bgcolor", "border", "cellpadding", "cellspacing", "role", "dir", "lang", "title", "background"];

const SANITIZE = {
	allowedTags: ["html", "head", "body", "meta", "title", "style", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col", "div", "span", "p", "br", "hr", "a", "img", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "small", "sup", "sub", "ul", "ol", "li", "blockquote", "pre", "code", "center", "font", "section", "header", "footer", "article", "picture", "source"],
	allowVulnerableTags: true, // <style> потрібен для media queries (адаптив)
	allowedAttributes: {
		"*": ATTR_ALL,
		a: [...ATTR_ALL, "href", "target", "name", "rel"],
		img: [...ATTR_ALL, "src", "alt"],
		td: [...ATTR_ALL, "colspan", "rowspan"],
		th: [...ATTR_ALL, "colspan", "rowspan", "scope"],
		meta: ["name", "content", "http-equiv", "charset"],
		font: [...ATTR_ALL, "color", "face", "size"],
		source: ["srcset", "media", "type"],
		col: [...ATTR_ALL, "span"],
	},
	allowedSchemes: ["http", "https", "mailto", "tel"],
	allowedSchemesByTag: { img: ["http", "https"] },
	allowProtocolRelative: false,
	parseStyleAttributes: false, // не різати inline-стилі
	transformTags: {
		"*": (tagName, attribs) => {
			if (attribs.style && /expression\s*\(|javascript:|behavior\s*:|-moz-binding|url\s*\(\s*['"]?\s*(javascript|data|vbscript):/i.test(attribs.style)) delete attribs.style;
			if (attribs.background && !/^https?:\/\//i.test(attribs.background)) delete attribs.background;
			return { tagName, attribs };
		},
	},
};

const UNSAFE_RE = /<script|<iframe|<form|<object|<embed|<input|<textarea|\son[a-z]+\s*=|javascript:/i;
const MSO_RE = /<!--\[if ([^\]]{1,64})\]>([\s\S]*?)<!\[endif\]-->/gi;

// Вміст умовних коментарів Outlook (VML) зберігаємо, але без небезпечного
function stripDanger(s) {
	return s
		.replace(/<(script|iframe|object|embed|form|style)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<(script|iframe|object|embed|form|input|textarea|link|meta|base)\b[^>]*>/gi, "")
		.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/(javascript|vbscript|data)\s*:/gi, "")
		.replace(/-->/g, "");
}

function sanitizeEmailHtml(input) {
	const blocks = [];
	const withPlaceholders = String(input || "").replace(MSO_RE, (full, cond, inner) => {
		const safeCond = cond.replace(/[^a-zA-Z0-9 !()&|]/g, "");
		blocks.push(`<!--[if ${safeCond}]>${stripDanger(inner)}<![endif]-->`);
		return `%%GCMSO${blocks.length - 1}%%`;
	});
	let html = sanitizeHtml(withPlaceholders, SANITIZE);
	if (!/<html[\s>]/i.test(html)) html = `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${html}</body></html>`;
	return { html: "<!DOCTYPE html>" + html, blocks };
}

const restoreMso = (html, blocks) => html.replace(/%%GCMSO(\d+)%%/g, (m, i) => blocks[Number(i)] || "");

// ═══ HTML → ТЕКСТ ═══════════════════════════════════════
const ENT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", zwnj: "", "#39": "'", "#847": "" };
const decodeEntities = (s) =>
	String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
		const k = e.toLowerCase();
		if (k in ENT) return ENT[k];
		if (k[0] === "#") {
			const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
			return Number.isFinite(n) && n > 31 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
		}
		return m;
	});

function htmlToText(html) {
	let s = String(html || "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<div[^>]*display:\s*none[^>]*>[\s\S]*?<\/div>/gi, "")
		.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, tx) => {
			const tt = tx.replace(/<[^>]+>/g, "").trim();
			return /^(mailto:|tel:)/i.test(href) || !tt ? tt : `${tt} (${href})`;
		})
		.replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, "$1")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|h[1-6]|table|blockquote|ul|ol)>/gi, "\n\n")
		.replace(/<li[^>]*>/gi, "• ")
		.replace(/<\/li>/gi, "\n")
		.replace(/<[^>]+>/g, "");
	s = decodeEntities(s);
	return s
		.replace(/[ \t\u00a0]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// ═══ ВАЛІДАЦІЯ ══════════════════════════════════════════
// code — ключ перекладу mailing.warnings.{code}
function validate(html, text) {
	const w = [];
	const size = Buffer.byteLength(html, "utf8");
	if (size > 102 * 1024) w.push({ level: "error", code: "gmail_clip", value: Math.round(size / 1024) });
	else if (size > 85 * 1024) w.push({ level: "warning", code: "size_large", value: Math.round(size / 1024) });

	const imgs = html.match(/<img\b[^>]*>/gi) || [];
	const noAlt = imgs.filter((x) => !/\salt=["'][^"']+["']/i.test(x)).length;
	if (noAlt) w.push({ level: "warning", code: "img_no_alt", value: noAlt });
	const rel = imgs.filter((x) => !/\ssrc=["'](https?:)?\/\//i.test(x) && !/\ssrc=["']\{\{/i.test(x)).length;
	if (rel) w.push({ level: "error", code: "img_relative", value: rel });
	const insecure = imgs.filter((x) => /\ssrc=["']http:\/\//i.test(x)).length;
	if (insecure) w.push({ level: "warning", code: "img_insecure", value: insecure });

	const links = html.match(/<a\b[^>]*>/gi) || [];
	const empty = links.filter((x) => !/\shref=["'][^"'#\s]+/i.test(x)).length;
	if (empty) w.push({ level: "warning", code: "link_empty", value: empty });
	const httpLinks = links.filter((x) => /\shref=["']http:\/\//i.test(x)).length;
	if (httpLinks) w.push({ level: "warning", code: "link_insecure", value: httpLinks });

	if (!/\{\{\s*(unsubscribe_url|preferences_url)\s*\}\}/i.test(html)) w.push({ level: "info", code: "footer_auto" });
	if (imgs.length && text.replace(/\s+/g, "").length < 200) w.push({ level: "warning", code: "image_heavy" });
	return { size, warnings: w };
}

// Редактори/інлайнер кодують лапки й дужки всередині {{ }} — повертаємо як було
function normalizeTags(s) {
	return String(s)
		.replace(/%7B%7B\s*([a-z_][a-z0-9_]*)\s*%7D%7D/gi, "{{$1}}")
		.replace(/\{\{[^{}]{0,200}\}\}/g, (m) => m.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&"));
}

/**
 * Компіляція контенту при збереженні.
 * c: {editor:'visual'|'html', source} → {html, text, size, warnings}
 */
async function compileContent(c) {
	const warnings = [];
	let html = String(c.source || "");
	if (Buffer.byteLength(html, "utf8") > 2 * 1024 * 1024) throw err(400, "content_too_large");

	if (c.editor === "visual") {
		const mjml2html = require("mjml");
		const r = await Promise.resolve(mjml2html(html, { validationLevel: "soft", keepComments: true }));
		for (const e of (r.errors || []).slice(0, 20)) warnings.push({ level: "warning", code: "mjml", message: String(e.formattedMessage || e.message || "").slice(0, 300), line: e.line });
		html = r.html || "";
	}

	if (UNSAFE_RE.test(html)) warnings.push({ level: "warning", code: "removed_unsafe" });

	const { html: clean, blocks } = sanitizeEmailHtml(html);
	html = juice(clean, {
		preserveMediaQueries: true,
		preserveFontFaces: true,
		preserveImportant: true,
		removeStyleTags: true,
		insertPreservedExtraCss: true,
		applyWidthAttributes: true,
		applyHeightAttributes: false,
	});
	html = restoreMso(html, blocks);
	html = normalizeTags(html);

	const text = htmlToText(html);
	const v = validate(html, text);
	return { html, text, size: v.size, warnings: [...warnings, ...v.warnings] };
}

// ═══ MERGE-ТЕГИ ═════════════════════════════════════════
// {{ key }}, {{ key | "за замовчуванням" }}, {{#if key}}...{{else}}...{{/if}} (без вкладеності)
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const truthy = (v) => v != null && v !== "" && v !== false && v !== 0 && v !== "0";
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function merge(tpl, vars, isHtml) {
	return String(tpl || "")
		.replace(/\{\{#if\s+([a-z][a-z0-9_]*)\s*\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/gi, (m, k, a, b = "") => (has(vars, k.toLowerCase()) && truthy(vars[k.toLowerCase()]) ? a : b))
		.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*(?:\|\s*(?:"([^"]*)"|'([^']*)'))?\s*\}\}/gi, (m, k, d1, d2) => {
			const key = k.toLowerCase();
			const v = has(vars, key) ? vars[key] : null;
			const val = v == null || v === "" || typeof v === "object" ? (d1 ?? d2 ?? "") : v;
			return isHtml ? esc(val) : String(val);
		});
}

// ═══ ПІДГОТОВКА ШАБЛОНУ КАМПАНІЇ (кеш) ══════════════════
const ft = (locale, k) => model.t(locale, "mailing.footer." + k);

const footerHtml = (locale) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;"><tr><td align="center" style="padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#8a8a8a;">
${esc(ft(locale, "why"))}<br>{{company}}{{#if company_address}} · {{company_address}}{{/if}}<br>
<a href="{{unsubscribe_url}}" style="color:#8a8a8a;text-decoration:underline;">${esc(ft(locale, "unsubscribe"))}</a> · <a href="{{preferences_url}}" style="color:#8a8a8a;text-decoration:underline;">${esc(ft(locale, "preferences"))}</a> · <a href="{{web_version_url}}" style="color:#8a8a8a;text-decoration:underline;">${esc(ft(locale, "web_version"))}</a>
</td></tr></table>`;

const footerText = (locale) => `\n\n--\n${ft(locale, "why")}\n{{company}}\n${ft(locale, "unsubscribe")}: {{unsubscribe_url}}\n${ft(locale, "preferences")}: {{preferences_url}}`;

const preheaderHtml = (p) => `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(p)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>`;

const insertAfterBodyOpen = (html, s) => (/<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (m) => m + s) : s + html);
const insertBeforeBodyClose = (html, s) => (/<\/body>/i.test(html) ? html.replace(/<\/body>/i, s + "</body>") : html + s);

const A_HREF_RE = /(<a\b[^>]*?\shref\s*=\s*)(["'])(.*?)\2/gi;

function addUtm(u, utm) {
	try {
		const x = new URL(u);
		if (!/^https?:$/.test(x.protocol) || x.searchParams.has("utm_source")) return u;
		for (const k of ["source", "medium", "campaign", "content", "term"]) if (utm[k]) x.searchParams.set("utm_" + k, String(utm[k]).slice(0, 100));
		return x.toString();
	} catch (e) {
		return u;
	}
}

const linkCache = new Map();
async function linkId(idCampaign, u) {
	const k = idCampaign + "|" + u;
	if (linkCache.has(k)) return linkCache.get(k);
	if (linkCache.size > 20000) linkCache.clear();
	const h = crypto.createHash("sha1").update(u).digest();
	await pool.query(`INSERT IGNORE INTO ${T.links} (id_campaign, url_hash, url) VALUES (?, ?, ?)`, [idCampaign, h, u]);
	const [[r]] = await pool.query(`SELECT id FROM ${T.links} WHERE id_campaign = ? AND url_hash = ?`, [idCampaign, h]);
	linkCache.set(k, r.id);
	return r.id;
}

async function getContent(ownerType, idOwner, idLang, defLang) {
	const [[c]] = await pool.query(
		`SELECT * FROM ${T.contents}
          WHERE owner_type = ? AND id_owner = ?
          ORDER BY id_lang = ? DESC, id_lang = ? DESC, id_lang ASC
          LIMIT 1`,
		[ownerType, idOwner, idLang, defLang]
	);
	return c || null;
}

const tplCache = new Map();
const TPL_TTL = 5 * 60000;

function clearCache(idCampaign) {
	for (const k of tplCache.keys()) if (!idCampaign || k.startsWith(idCampaign + ":")) tplCache.delete(k);
}

/**
 * Шаблон кампанії під варіант і мову: трекінг, UTM, прехедер, футер, піксель.
 * Персональні частини — плейсхолдери {{...}}, {{__c_ID}}, {{__open}}.
 */
async function prepared(campaign, idVariant, idLang) {
	const key = `${campaign.id}:${idVariant}:${idLang}`;
	const hit = tplCache.get(key);
	if (hit && Date.now() - hit.at < TPL_TTL) return hit.v;
	if (tplCache.size > 2000) tplCache.clear();

	const s = await model.getSettings();
	const c = await getContent("variant", idVariant, idLang, s.default_id_lang);
	if (!c) throw err(500, "content_missing");
	const compiled = c.html ? { html: c.html } : await compileContent(c);
	const lang = c.id_lang;
	const locale = await model.localeOf(lang);

	let html = normalizeTags(compiled.html);
	const hasFooter = /\{\{\s*(unsubscribe_url|preferences_url)\s*\}\}/i.test(html);
	if (!hasFooter) html = insertBeforeBodyClose(html, footerHtml(locale));
	if (c.preheader) html = insertAfterBodyOpen(html, preheaderHtml(c.preheader));

	const utm = jsonOf(campaign.utm);
	const base = publicBase();
	const trackMap = new Map();
	const textMap = new Map();
	const hrefs = new Set();
	html.replace(A_HREF_RE, (m, pre, q, u) => hrefs.add(u));
	for (const raw of hrefs) {
		const u = decodeEntities(raw).trim();
		if (!/^https?:\/\//i.test(u) || u.includes("{{") || (base && (u.startsWith(base + "/mailing/") || u.startsWith(base + "/api/mailing/")))) continue;
		const finalUrl = utm ? addUtm(u, utm) : u;
		textMap.set(raw, esc(finalUrl));
		trackMap.set(raw, campaign.track_clicks ? `{{__c_${await linkId(campaign.id, finalUrl)}}}` : esc(finalUrl));
	}

	const textHtml = html.replace(A_HREF_RE, (m, pre, q, u) => (textMap.has(u) ? `${pre}${q}${textMap.get(u)}${q}` : m));
	let text = htmlToText(textHtml);
	if (!hasFooter) text += footerText(locale);

	html = html.replace(A_HREF_RE, (m, pre, q, u) => (trackMap.has(u) ? `${pre}${q}${trackMap.get(u)}${q}` : m));
	if (campaign.track_opens) html = insertBeforeBodyClose(html, `<img src="{{__open}}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;outline:none;" />`);

	const v = { subject: c.subject, html, text, id_lang: lang };
	tplCache.set(key, { at: Date.now(), v });
	return v;
}

// ═══ ЛИСТ ДЛЯ ОТРИМУВАЧА ════════════════════════════════
/**
 * m: рядок mailing_messages + поля контакту (first_name, last_name, fields)
 * campaign: {id, name, track_opens, track_clicks, utm}
 * sender: рядок mailing_senders
 */
async function buildMessage(m, campaign, sender) {
	const tpl = await prepared(campaign, m.id_variant, m.id_lang);
	const fields = jsonOf(m.fields) || {};
	const custom = {};
	for (const [k, v] of Object.entries(fields)) {
		const key = String(k).toLowerCase();
		if (model.FIELD_CODE_RE.test(key) && !model.RESERVED_FIELDS.has(key) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) custom[key] = v;
	}
	const unsub = url.unsubscribe(m.id);

	const vars = {
		...custom,
		first_name: m.first_name || "",
		last_name: m.last_name || "",
		full_name: [m.first_name, m.last_name].filter(Boolean).join(" "),
		email: m.email,
		company: sender.from_name,
		company_address: sender.company_address || "",
		current_year: new Date().getUTCFullYear(),
		unsubscribe_url: unsub,
		preferences_url: unsub,
		web_version_url: url.web(m.id),
	};

	const html = merge(tpl.html, vars, true)
		.replace(/\{\{__c_(\d+)\}\}/g, (x, l) => url.click(m.id, Number(l)))
		.replace(/\{\{__open\}\}/g, url.open(m.id));
	const text = merge(tpl.text, vars, false);
	const subject = merge(tpl.subject, vars, false)
		.replace(/[\r\n]+/g, " ")
		.trim()
		.slice(0, 255);

	const fromDomain = String(sender.from_email).split("@")[1];
	const messageId = `<${m.id}.${crypto.randomBytes(6).toString("hex")}@${fromDomain}>`;
	const listUnsub = [`<${url.oneClick(m.id)}>`];
	let envelopeFrom = sender.from_email;
	if (sender.bounce_address && sender.bounce_address.includes("@")) {
		const [bl, bd] = sender.bounce_address.split("@");
		envelopeFrom = `${bl}+${verpLocal(m.id, "b")}@${bd}`;
		listUnsub.push(`<mailto:${bl}+${verpLocal(m.id, "u")}@${bd}?subject=unsubscribe>`);
	}

	return {
		subject,
		html,
		text,
		messageId,
		envelopeFrom,
		headers: {
			"List-Unsubscribe": listUnsub.join(", "),
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
			"List-Id": `<c${campaign.id}.${fromDomain}>`,
			"Feedback-ID": `${campaign.id}:${sender.id}:mailing:growthcontour`,
			"X-GC-Ref": sign("v", m.id),
		},
	};
}

module.exports = {
	sign,
	verify,
	verpLocal,
	verpParse,
	publicBase,
	url,
	sanitizeEmailHtml,
	htmlToText,
	validate,
	compileContent,
	normalizeTags,
	merge,
	prepared,
	buildMessage,
	clearCache,
	decodeEntities,
};