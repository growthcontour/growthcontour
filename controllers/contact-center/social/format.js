/**
 * Текст публікації: редактор зберігає обмежений HTML, а кожна мережа отримує свій формат.
 *
 *   Telegram          — HTML (parse_mode=HTML): жирний, курсив, підкреслений, закреслений, посилання,
 *                       моноширинний, цитата, спойлер; списки → «• » / «1. ».
 *   Instagram, Facebook, Viber — простий текст: форматування знімається, посилання → «текст (адреса)»,
 *                       абзаци й переноси рядків зберігаються.
 *
 * Старі публікації без тегів (простий текст) обробляються так само — переноси рядків зберігаються.
 */
const sanitizeHtml = require("sanitize-html");

const ALLOWED = {
	allowedTags: ["p", "div", "br", "b", "strong", "i", "em", "u", "s", "strike", "del", "a", "code", "pre", "blockquote", "ul", "ol", "li", "span"],
	allowedAttributes: { a: ["href"], span: ["class"] },
	allowedClasses: { span: ["tg-spoiler"] },
	allowedSchemes: ["http", "https", "tg", "mailto"],
	// Ворд / сайти вставляють стилі й шрифти — відкидаємо
	transformTags: { strong: "b", em: "i", strike: "s", del: "s", div: "p" },
};

const isHtml = (s) => /<\/?[a-z][^>]*>/i.test(String(s || ""));
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
const decode = (s) =>
	String(s)
		.replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&([a-z#0-9]+);/gi, (m, n) => (n in ENT ? ENT[n] : m));

/** Очистити HTML з редактора (зберігається в БД) */
function clean(input) {
	const s = String(input || "");
	if (!s.trim()) return "";
	if (!isHtml(s)) return escapeHtml(s).replace(/\r?\n/g, "<br>");
	return sanitizeHtml(s, ALLOWED).trim();
}

/** Блоки → переноси рядків, списки → маркери (спільне для обох форматів) */
function blocks(html) {
	const stack = []; // відкриті списки: { ol: bool, n }
	return String(html)
		.replace(/\r?\n/g, "")
		.replace(/<(\/?)(ul|ol|li|br|p)\b[^>]*>/gi, (m, close, tag) => {
			tag = tag.toLowerCase();
			if (tag === "br") return "\n";
			if (tag === "p") return close ? "\n" : "";
			if (tag === "ul" || tag === "ol") {
				if (close) stack.pop();
				else stack.push({ ol: tag === "ol", n: 0 });
				return "\n";
			}
			// li
			if (close) return "\n";
			const top = stack[stack.length - 1];
			return top && top.ol ? `${++top.n}. ` : "• ";
		});
}

const tidy = (s) => s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** Простий текст (Instagram, Facebook, Viber) */
function toPlain(input) {
	const html = clean(input);
	if (!html) return "";
	let s = blocks(html)
		.replace(/<blockquote[^>]*>/gi, "\n«")
		.replace(/<\/blockquote>/gi, "»\n")
		.replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
			const t = decode(text.replace(/<[^>]+>/g, "")).trim();
			const url = decode(href);
			return !t || t === url || t === url.replace(/^https?:\/\//, "") ? url : `${t} (${url})`;
		})
		.replace(/<[^>]+>/g, "");
	return tidy(decode(s));
}

/** Telegram HTML (parse_mode=HTML) */
function toTelegram(input) {
	const html = clean(input);
	if (!html) return "";
	const s = blocks(html)
		.replace(/<span class="tg-spoiler">/gi, "<tg-spoiler>")
		.replace(/<\/span>/gi, (m, off, all) => (all.lastIndexOf("<tg-spoiler>", off) > all.lastIndexOf("</tg-spoiler>", off) ? "</tg-spoiler>" : ""))
		.replace(/<span[^>]*>/gi, "")
		// Telegram: перенос усередині тегу допустимий; лишаємо тільки підтримувані теги
		.replace(/<(?!\/?(b|i|u|s|a|code|pre|blockquote|tg-spoiler)\b)[^>]+>/gi, "");
	return tidy(s);
}

/** Довжина видимого тексту (ліміти мереж рахуються без тегів) */
const visibleLength = (input) => toPlain(input).length;

module.exports = { clean, toPlain, toTelegram, visibleLength, isHtml };