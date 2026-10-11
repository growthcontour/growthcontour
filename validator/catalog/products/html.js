"use strict";

/**
 * Серверна санітизація HTML описів (TinyMCE → БД → вітрина/синхронізація).
 * Білий список тегів/атрибутів/стилів; клієнту не довіряємо ніколи.
 */
const sanitizeHtml = require("sanitize-html");

// Які поля описів містять HTML (решта — звичайний текст)
const HTML_FIELDS = {
	products: ["short_description", "description"],
	categories: ["description", "description_bottom"],
	brands: ["description"],
};

const COLOR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+\s*)?\)$/i, /^[a-z]{3,20}$/i];
const SIZE = [/^\d{1,4}(\.\d{1,3})?(px|%|em|rem)?$/, /^auto$/];

const OPTIONS = {
	allowedTags: [
		"p", "br", "hr", "div", "span", "blockquote", "pre", "code",
		"h1", "h2", "h3", "h4", "h5", "h6",
		"strong", "b", "em", "i", "u", "s", "del", "ins", "sub", "sup", "small", "mark",
		"ul", "ol", "li", "dl", "dt", "dd",
		"a", "img", "figure", "figcaption", "picture", "source", "video", "iframe",
		"table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td",
	],
	allowedAttributes: {
		"*": ["style", "class", "dir", "lang", "title"],
		a: ["href", "name", "target", "rel"],
		img: ["src", "alt", "width", "height", "loading"],
		source: ["src", "srcset", "type", "media"],
		video: ["src", "poster", "controls", "width", "height", "muted", "loop", "playsinline"],
		iframe: ["src", "width", "height", "allow", "allowfullscreen", "frameborder"],
		ol: ["start", "type", "reversed"],
		col: ["span", "width"],
		colgroup: ["span"],
		td: ["colspan", "rowspan", "width", "height"],
		th: ["colspan", "rowspan", "scope", "width", "height"],
		table: ["border", "cellpadding", "cellspacing", "width"],
	},
	allowedClasses: { "*": [/^[a-z0-9][a-z0-9_-]{0,63}$/i] },
	allowedStyles: {
		"*": {
			"text-align": [/^(left|right|center|justify|start|end)$/],
			"vertical-align": [/^(top|middle|bottom|baseline)$/],
			color: COLOR,
			"background-color": COLOR,
			"font-weight": [/^(normal|bold|[1-9]00)$/],
			"font-style": [/^(normal|italic)$/],
			"text-decoration": [/^(none|underline|line-through)( [a-z-]+)?$/],
			"list-style-type": [/^[a-z-]{3,30}$/],
			float: [/^(left|right|none)$/],
			width: SIZE,
			height: SIZE,
			"max-width": SIZE,
			"margin-left": SIZE,
			"margin-right": SIZE,
			"padding-left": SIZE,
			"padding-right": SIZE,
			"border-collapse": [/^(collapse|separate)$/],
			"border-width": SIZE,
			"border-style": [/^(none|solid|dashed|dotted|double)$/],
			"border-color": COLOR,
		},
	},
	allowedSchemes: ["http", "https", "mailto", "tel"],
	allowedSchemesByTag: { img: ["http", "https"], source: ["http", "https"], video: ["http", "https"], iframe: ["https"] },
	allowProtocolRelative: false,
	// Вбудовування відео — лише з перевірених хостингів
	allowedIframeHostnames: ["www.youtube.com", "www.youtube-nocookie.com", "player.vimeo.com"],
	allowIframeRelativeUrls: false,
	disallowedTagsMode: "discard",
	nonTextTags: ["script", "style", "textarea", "option", "noscript", "template", "object", "embed"],
	transformTags: {
		a: (tagName, attribs) => {
			const out = { ...attribs };
			if (out.target && out.target !== "_blank") delete out.target;
			if (out.target === "_blank") {
				const rel = new Set(String(out.rel || "").split(/\s+/).filter(Boolean));
				rel.add("noopener");
				rel.add("noreferrer");
				out.rel = [...rel].join(" ");
			}
			return { tagName, attribs: out };
		},
		b: "strong",
		i: "em",
	},
};

/** Очищений HTML або null, якщо після очистки немає ні тексту, ні медіа */
function clean(html) {
	if (html == null) return null;
	const out = sanitizeHtml(String(html), OPTIONS).trim();
	if (!out) return null;
	const hasMedia = /<(img|iframe|video|hr|table)\b/i.test(out);
	const text = out.replace(/<[^>]*>/g, "").replace(/&nbsp;|\u00a0/g, " ").trim();
	return text || hasMedia ? out : null;
}

function isHtmlField(entity, field) {
	return (HTML_FIELDS[entity] || []).includes(field);
}

// Локальні зображення каталогу всередині HTML (оригінал або мініатюра)
const IMG_RE = /\/assets\/images\/(products|categories|brands)\/(?:cache\/[a-z0-9_]{1,32}\/)?([0-9a-f]{2}\/[0-9a-f]{64}\.(?:webp|avif|jpg|png|gif))/g;

/** [{ kind, file }] — унікальні файли, на які посилається HTML */
function extractImages(html) {
	const seen = new Map();
	if (!html) return [];
	for (const m of String(html).matchAll(IMG_RE)) seen.set(`${m[1]}:${m[2]}`, { kind: m[1], file: m[2] });
	return [...seen.values()];
}

module.exports = { HTML_FIELDS, clean, isHtmlField, extractImages };