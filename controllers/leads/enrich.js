"use strict";

/**
 * Збагачення ліда без платних сервісів і без прив'язки до країни. Нічого не змінює саме — повертає пропозиції,
 * менеджер обирає, що застосувати (застосування — звичайне збереження ліда, з історією й захистом від одночасних змін).
 *
 *   - телефон: міжнародний формат E.164 (якщо номер уже з кодом країни: +… або 00…) і країна за телефонним кодом;
 *   - сайт: з корпоративного email (домен не з безкоштовної пошти) → https://домен;
 *   - сайт компанії (поле «Сайт» або домен email): назва (og:site_name / title), опис, контакти й соцмережі зі сторінки;
 *     компанія — з назви сайту, якщо в ліда не вказана.
 * Сайт завантажується з сервера: лише http(s), без приватних адрес (та сама перевірка, що й для вебхуків),
 * без переходів на інші адреси, до 8 с і 1 МБ.
 */

const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;
const TIMEOUT_MS = 8000;
const MAX_BYTES = 1024 * 1024;

const FREE_MAIL = new Set(
	"gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com icloud.com me.com mac.com aol.com proton.me protonmail.com gmx.com gmx.de gmx.net web.de mail.com yandex.com yandex.ru mail.ru inbox.ru list.ru bk.ru ukr.net i.ua meta.ua zoho.com tutanota.com fastmail.com qq.com 163.com 126.com naver.com wp.pl o2.pl interia.pl onet.pl seznam.cz libero.it orange.fr free.fr laposte.net t-online.de".split(" ")
);

// Телефонні коди країн (ITU-T E.164): код → ISO 3166-1 alpha-2. Довші коди перевіряються першими.
const CODES = {
	1: "US", 7: "KZ", 20: "EG", 27: "ZA", 30: "GR", 31: "NL", 32: "BE", 33: "FR", 34: "ES", 36: "HU", 39: "IT", 40: "RO", 41: "CH", 43: "AT", 44: "GB", 45: "DK", 46: "SE", 47: "NO", 48: "PL", 49: "DE",
	51: "PE", 52: "MX", 53: "CU", 54: "AR", 55: "BR", 56: "CL", 57: "CO", 58: "VE", 60: "MY", 61: "AU", 62: "ID", 63: "PH", 64: "NZ", 65: "SG", 66: "TH", 81: "JP", 82: "KR", 84: "VN", 86: "CN",
	90: "TR", 91: "IN", 92: "PK", 93: "AF", 94: "LK", 95: "MM", 98: "IR", 212: "MA", 213: "DZ", 216: "TN", 218: "LY", 220: "GM", 221: "SN", 233: "GH", 234: "NG", 237: "CM", 251: "ET", 254: "KE", 255: "TZ", 256: "UG",
	260: "ZM", 263: "ZW", 351: "PT", 352: "LU", 353: "IE", 354: "IS", 355: "AL", 356: "MT", 357: "CY", 358: "FI", 359: "BG", 370: "LT", 371: "LV", 372: "EE", 373: "MD", 374: "AM", 375: "BY", 376: "AD", 377: "MC",
	380: "UA", 381: "RS", 382: "ME", 383: "XK", 385: "HR", 386: "SI", 387: "BA", 389: "MK", 420: "CZ", 421: "SK", 423: "LI", 852: "HK", 853: "MO", 855: "KH", 856: "LA", 880: "BD", 886: "TW",
	960: "MV", 961: "LB", 962: "JO", 963: "SY", 964: "IQ", 965: "KW", 966: "SA", 967: "YE", 968: "OM", 970: "PS", 971: "AE", 972: "IL", 973: "BH", 974: "QA", 975: "BT", 976: "MN", 977: "NP",
	992: "TJ", 993: "TM", 994: "AZ", 995: "GE", 996: "KG", 998: "UZ",
};

/** Номер з кодом країни → { e164, country } або null (без коду країну не вгадуємо — система міжнародна) */
function phoneInfo(raw) {
	const s = String(raw || "").trim();
	let digits = s.replace(/\D/g, "");
	if (s.startsWith("+")) {
		/* уже міжнародний */
	} else if (digits.startsWith("00")) digits = digits.slice(2);
	else return null;
	if (digits.length < 8 || digits.length > 15) return null;
	for (const len of [3, 2, 1]) {
		const cc = digits.slice(0, len);
		if (CODES[cc]) return { e164: "+" + digits, country: CODES[cc], code: "+" + cc };
	}
	return { e164: "+" + digits, country: null, code: null };
}

const domainOf = (email) => {
	const m = /@([^@\s]+)$/.exec(String(email || "").trim().toLowerCase());
	return m ? m[1] : null;
};

const decode = (s) =>
	String(s || "")
		.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
			const k = e.toLowerCase();
			if (k === "amp") return "&";
			if (k === "lt") return "<";
			if (k === "gt") return ">";
			if (k === "quot") return '"';
			if (k === "apos") return "'";
			if (k === "nbsp") return " ";
			const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
			return Number.isFinite(n) ? String.fromCodePoint(n) : m;
		})
		.replace(/\s+/g, " ")
		.trim();

/** Сторінка сайту: назва, опис, соцмережі, email і телефони зі сторінки */
async function siteInfo(url) {
	const bad = await require("./webhooks").checkUrl(url);
	if (bad) return { error: bad };
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		let r = await fetch(url, { redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; LeadEnrich/1.0)", Accept: "text/html" } });
		// Один перехід — лише в межах того ж домену (http → https, www)
		if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
			const next = new URL(r.headers.get("location"), url);
			const same = next.hostname.replace(/^www\./, "") === new URL(url).hostname.replace(/^www\./, "");
			if (!same || (await require("./webhooks").checkUrl(next.href))) return { error: "redirect" };
			r = await fetch(next.href, { redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; LeadEnrich/1.0)", Accept: "text/html" } });
			url = next.href;
		}
		if (!r.ok) return { error: "http_" + r.status };
		if (!/text\/html|application\/xhtml/i.test(r.headers.get("content-type") || "")) return { error: "not_html" };
		const reader = r.body.getReader();
		const chunks = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			chunks.push(value);
			if (size > MAX_BYTES) {
				ctrl.abort();
				break;
			}
		}
		const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
		const meta = (name) => {
			const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "i");
			const tag = re.exec(html);
			const c = tag && /content=["']([^"']*)["']/i.exec(tag[0]);
			return c ? decode(c[1]).slice(0, 300) : "";
		};
		const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "").slice(0, 300);
		const SOCIAL = { linkedin: /linkedin\.com\/(company|in)\//i, facebook: /facebook\.com\//i, instagram: /instagram\.com\//i, x: /(twitter|x)\.com\//i, youtube: /youtube\.com\//i, telegram: /t\.me\//i };
		const links = [...html.matchAll(/href=["'](https?:\/\/[^"'#\s]+)["']/gi)].map((m) => m[1]);
		const social = {};
		for (const [k, re] of Object.entries(SOCIAL)) {
			const hit = links.find((l) => re.test(l) && !/sharer|share\?|intent\//i.test(l));
			if (hit) social[k] = hit.slice(0, 300);
		}
		const emails = [...new Set([...html.matchAll(/mailto:([^"'?\s]+@[^"'?\s]+)/gi)].map((m) => decode(m[1]).toLowerCase()))].slice(0, 5);
		const phones = [...new Set([...html.matchAll(/tel:([+\d][\d\s().-]{6,20})/gi)].map((m) => m[1].trim()))].slice(0, 5);
		return { url, name: meta("og:site_name") || title.split(/\s[|–—-]\s/)[0].trim(), title, description: meta("og:description") || meta("description"), social, emails, phones };
	} catch (e) {
		return { error: e.name === "AbortError" ? "timeout" : "fetch" };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Пропозиції для ліда: [{ field, current, value, source }] + довідкова інформація (країна, сайт, соцмережі).
 * field — ключ збереження ліда: website, contact.phone, contact.company.
 */
async function suggest(idLead) {
	const [[l]] = await pool.query(`SELECT id, website, contact_info FROM \`${P}leads\` WHERE id = ? AND deleted_at IS NULL`, [idLead]);
	if (!l) return null;
	const ci = typeof l.contact_info === "string" ? JSON.parse(l.contact_info || "{}") : l.contact_info || {};
	const out = [];
	const info = {};
	const ph = phoneInfo(ci.phone);
	if (ph) {
		info.country = ph.country;
		info.phone_code = ph.code;
		if (ph.e164 !== String(ci.phone).trim()) out.push({ field: "contact.phone", current: ci.phone, value: ph.e164, source: "e164" });
	}
	const domain = domainOf(ci.email);
	const corporate = domain && !FREE_MAIL.has(domain);
	let site = String(l.website || "").trim();
	if (!site && corporate) {
		site = "https://" + domain;
		out.push({ field: "website", current: "", value: site, source: "email" });
	}
	if (site) {
		if (!/^https?:\/\//i.test(site)) site = "https://" + site;
		const s = await siteInfo(site);
		info.site = s;
		if (!s.error && s.name && !String(ci.company || "").trim()) out.push({ field: "contact.company", current: "", value: s.name.slice(0, 255), source: "site" });
		if (!s.error && !String(ci.phone || "").trim() && s.phones && s.phones[0]) out.push({ field: "contact.phone", current: "", value: s.phones[0], source: "site" });
	}
	return { suggestions: out, info, email_type: domain ? (corporate ? "corporate" : "free") : null };
}

module.exports = { phoneInfo, siteInfo, suggest, FREE_MAIL };