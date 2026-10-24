"use strict";

// Символи, заборонені в XML 1.0 (керівні, крім \t \n \r) — інакше Google/Prom відхиляють увесь файл
const INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

const esc = (v) =>
	String(v == null ? "" : v)
		.replace(INVALID, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");

// CDATA не може містити "]]>" — розбиваємо послідовність
const cdata = (v) => "<![CDATA[" + String(v == null ? "" : v).replace(INVALID, "").replace(/]]>/g, "]]]]><![CDATA[>") + "]]>";

/** Обрізати до max символів (не посередині сурогатної пари) */
const cut = (s, max) => {
	const a = Array.from(String(s || ""));
	return a.length > max ? a.slice(0, max - 1).join("").trimEnd() + "…" : a.join("");
};

const tag = (name, value) => (value === null || value === undefined || value === "" ? "" : `<${name}>${esc(value)}</${name}>`);

module.exports = { esc, cdata, cut, tag };