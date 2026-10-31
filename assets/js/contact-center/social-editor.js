/**
 * Редактор тексту публікацій (Контакт-центр → Публікації, Шаблони).
 *
 * Зберігає обмежений HTML — ті самі теги, що й серверний controllers/contact-center/social/format.js:
 *   b i u s a code pre blockquote ul ol li br p span.tg-spoiler
 * Telegram отримує форматування, Instagram / Facebook / Viber — простий текст (toPlain).
 *
 * Панель кнопок береться з <template id="social_rte_toolbar"> (views/partials/contact-center/social-editor.ejs),
 * тож тексти підказок — з мовних файлів, а не з цього скрипта.
 *
 * Використання:
 *   const ed = SocialEditor.create(textarea);   // textarea — джерело і місце збереження HTML
 *   ed.setHtml(html); ed.insert(text); ed.setDisabled(true);
 *   SocialEditor.toPlain(html); SocialEditor.tgPreview(html);
 */
(function () {
	"use strict";

	const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	const isHtml = (s) => /<[a-z][^>]*>/i.test(String(s || ""));
	const toHtml = (v) => (isHtml(v) ? v : esc(v).replace(/\n/g, "<br>"));

	const ALLOWED = { B: "b", STRONG: "b", I: "i", EM: "i", U: "u", S: "s", STRIKE: "s", DEL: "s", A: "a", CODE: "code", PRE: "pre", BLOCKQUOTE: "blockquote", UL: "ul", OL: "ol", LI: "li", BR: "br", P: "p", DIV: "p", SPAN: "span" };

	/** DOM редактора → дозволений HTML */
	function cleanHtml(root) {
		const out = (node) =>
			Array.from(node.childNodes)
				.map((n) => {
					if (n.nodeType === 3) return esc(n.nodeValue);
					if (n.nodeType !== 1) return "";
					const tag = ALLOWED[n.tagName];
					const inner = out(n);
					if (!tag) return inner;
					if (tag === "br") return "<br>";
					if (tag === "a") {
						const href = n.getAttribute("href") || "";
						return /^(https?:|tg:|mailto:)/i.test(href) ? '<a href="' + esc(href) + '">' + inner + "</a>" : inner;
					}
					if (tag === "span") return n.classList.contains("tg-spoiler") ? '<span class="tg-spoiler">' + inner + "</span>" : inner;
					return "<" + tag + ">" + inner + "</" + tag + ">";
				})
				.join("");
		return out(root).replace(/<p><\/p>/g, "").replace(/^(<br>)+|(<br>)+$/g, "");
	}

	/** Простий текст — так побачать Instagram / Facebook / Viber (як format.toPlain на сервері) */
	function toPlain(html) {
		const d = document.createElement("div");
		d.innerHTML = toHtml(html);
		const walk = (node, ctx) =>
			Array.from(node.childNodes)
				.map((n) => {
					if (n.nodeType === 3) return n.nodeValue;
					if (n.nodeType !== 1) return "";
					const t = n.tagName;
					if (t === "BR") return "\n";
					if (t === "UL" || t === "OL") return "\n" + walk(n, { ol: t === "OL", n: 0 }) + "\n";
					if (t === "LI") return (ctx && ctx.ol ? ++ctx.n + ". " : "• ") + walk(n, ctx) + "\n";
					if (t === "P" || t === "DIV") return walk(n, ctx) + "\n";
					if (t === "BLOCKQUOTE") return "\n«" + walk(n, ctx) + "»\n";
					if (t === "A") {
						const txt = walk(n, ctx).trim();
						const url = n.getAttribute("href") || "";
						return !txt || txt === url || txt === url.replace(/^https?:\/\//, "") ? url : txt + " (" + url + ")";
					}
					return walk(n, ctx);
				})
				.join("");
		return walk(d, null).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	}

	/** Перегляд для Telegram (як format.toTelegram): абзаци й списки → переноси та маркери */
	function tgPreview(html) {
		if (!isHtml(html)) return esc(html).replace(/\n/g, "<br>");
		const d = document.createElement("div");
		d.innerHTML = html;
		d.querySelectorAll("ol").forEach((ol) => ol.querySelectorAll(":scope > li").forEach((li, i) => li.insertAdjacentText("afterbegin", i + 1 + ". ")));
		d.querySelectorAll("ul > li").forEach((li) => li.insertAdjacentText("afterbegin", "• "));
		return d.innerHTML
			.replace(/<(ul|ol)>/g, "<br>")
			.replace(/<\/li>/g, "<br>")
			.replace(/<\/?(ul|ol|li)>/g, "")
			.replace(/<\/p>\s*<p>/g, "<br><br>")
			.replace(/<\/?p>/g, "");
	}

	/** Кількість хештегів у тексті (Instagram — не більше 30) */
	function countTags(text) {
		return (String(text || "").match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length;
	}

	function create(src) {
		const tpl = document.getElementById("social_rte_toolbar");
		const box = document.createElement("div");
		box.className = "rte";
		const bar = document.createElement("div");
		bar.className = "rte-bar";
		if (tpl) bar.appendChild(tpl.content.cloneNode(true));
		const body = document.createElement("div");
		body.className = "rte-body";
		body.contentEditable = "true";
		body.dataset.ph = src.dataset.ph || "";
		box.append(bar, body);
		src.parentNode.insertBefore(box, src);
		body.innerHTML = toHtml(src.value);
		try {
			document.execCommand("defaultParagraphSeparator", false, "p");
		} catch (e) {
			// старі браузери
		}

		let lastRange = null;
		const sync = () => {
			src.value = cleanHtml(body);
			src.dispatchEvent(new Event("input", { bubbles: true }));
		};
		// Позиція курсора — щоб вставляти шаблон / хештеги туди, де користувач зупинився
		const remember = () => {
			const sel = window.getSelection();
			if (sel.rangeCount && body.contains(sel.anchorNode)) lastRange = sel.getRangeAt(0).cloneRange();
		};
		body.addEventListener("keyup", remember);
		body.addEventListener("mouseup", remember);
		body.addEventListener("blur", remember);

		// Обгорнути виділення тегом (моноширинний, спойлер)
		const wrap = (tag, cls) => {
			const sel = window.getSelection();
			if (!sel.rangeCount || sel.isCollapsed || !body.contains(sel.anchorNode)) return;
			const el = document.createElement(tag);
			if (cls) el.className = cls;
			const range = sel.getRangeAt(0);
			el.appendChild(range.extractContents());
			range.insertNode(el);
		};
		bar.addEventListener("mousedown", (e) => e.preventDefault()); // не втрачати виділення
		bar.addEventListener("click", (e) => {
			const b = e.target.closest("button[data-cmd]");
			if (!b) return;
			body.focus();
			const cmd = b.dataset.cmd;
			if (cmd === "link") {
				const url = (prompt((tpl && tpl.dataset.linkPrompt) || "URL", "https://") || "").trim();
				if (/^(https?:\/\/.+|tg:.+|mailto:.+)/i.test(url)) {
					if (window.getSelection().isCollapsed) document.execCommand("insertText", false, url);
					else document.execCommand("createLink", false, url);
				}
			} else if (cmd === "code") wrap("code");
			else if (cmd === "spoiler") wrap("span", "tg-spoiler");
			else if (cmd === "quote") document.execCommand("formatBlock", false, "blockquote");
			else if (cmd === "removeFormat") {
				document.execCommand("removeFormat");
				document.execCommand("unlink");
			} else document.execCommand(cmd);
			sync();
		});
		body.addEventListener("input", sync);
		// Вставка — лише текст (без стилів, шрифтів і картинок з Word / сайтів)
		body.addEventListener("paste", (e) => {
			e.preventDefault();
			document.execCommand("insertText", false, (e.clipboardData || window.clipboardData).getData("text/plain"));
		});

		return {
			box,
			body,
			setHtml(html) {
				body.innerHTML = toHtml(html);
				sync();
			},
			/** Вставити в позицію курсора: html — фрагмент редактора, або простий текст */
			insert(content, asHtml) {
				body.focus();
				const sel = window.getSelection();
				if (lastRange) {
					sel.removeAllRanges();
					sel.addRange(lastRange);
				} else {
					// курсора ще не було — в кінець
					const r = document.createRange();
					r.selectNodeContents(body);
					r.collapse(false);
					sel.removeAllRanges();
					sel.addRange(r);
				}
				if (asHtml) document.execCommand("insertHTML", false, content);
				else document.execCommand("insertText", false, content);
				remember();
				sync();
			},
			setDisabled(d) {
				box.classList.toggle("disabled", d);
				body.contentEditable = d ? "false" : "true";
			},
		};
	}

	/** Вставити текст у звичайне поле (textarea) в позицію курсора */
	function insertIntoTextarea(ta, text) {
		const start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
		const end = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
		const before = ta.value.slice(0, start);
		const sep = before && !/\s$/.test(before) ? (text.startsWith("#") ? " " : "\n") : "";
		ta.value = before + sep + text + ta.value.slice(end);
		const pos = (before + sep + text).length;
		ta.focus();
		ta.setSelectionRange(pos, pos);
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	}

	window.SocialEditor = { create, cleanHtml, toPlain, tgPreview, countTags, insertIntoTextarea, esc, isHtml };
})();
