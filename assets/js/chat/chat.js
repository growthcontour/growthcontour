/**
 * Чат компанії — клієнт. Один і той самий чат у трьох місцях (розмітка — views/partials/chat/app.ejs):
 *   page  — сторінка /chat/;
 *   panel — бічна панель справа на будь-якій сторінці (вмикається при першому відкритті панелі);
 *   pulse — "Пульс компанії" на головній: канал оголошень і поруч інформація про нього.
 * Кожен екземпляр має свій префікс id (data-chat-prefix), тож на одній сторінці їх може бути кілька.
 * Налаштування й тексти — з /api/chat/config/ (один запит на сторінку), дані — REST /api/chat/...,
 * зміни — події socket.io (глобальний socket із partials/script.ejs).
 *
 * Два поля вводу з однаковою поведінкою (згадки, файли, голосові, правка): основне і в панелі треду.
 * Згадки в полі показуються як "@Ім'я", а на сервер ідуть токенами @[Ім'я](u:12) (див. controllers/chat/mentions.js).
 * Час для "надіслати пізніше" й нагадувань вибирається в часовому поясі людини (профіль → офіс), на сервер іде UTC.
 */
/* global socket, MediaRecorder, EmojiMart */
(function () {
	"use strict";

	// Налаштування й тексти — один запит на сторінку для всіх екземплярів
	let configP = null;
	function loadConfig() {
		if (!configP)
			configP = fetch("/api/chat/config/", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}" })
				.then((r) => r.json())
				.then((j) => {
					if (!j.ok) throw j;
					return j;
				});
		return configP;
	}
	// Спливаючі повідомлення — одна Notyf на сторінку
	function sharedNotyf() {
		if (!window.gcChatNotyf)
			window.gcChatNotyf = new Notyf({
				duration: 4000,
				position: { x: "right", y: "top" },
				types: [
					{ type: "error", background: "indianred", dismissible: true, icon: false },
					{ type: "info", background: "#0d6efd", dismissible: true, icon: false },
				],
			});
		return window.gcChatNotyf;
	}

	function mount(root, cfg) {
	const MODE = root.dataset.chatMode || "page";
	const PFX = root.dataset.chatPrefix || "";
	const C = Object.assign({}, cfg.config, { embed: MODE !== "page", pulse: MODE === "pulse" });
	// socket оголошено в partials/script.ejs через const — це глобальна змінна, але не властивість window
	const SOCK = typeof socket !== "undefined" ? socket : null;
	// Панель справа: прочитаним позначаємо лише коли вона відкрита
	const offcanvas = root.closest(".offcanvas");
	let visible = !offcanvas || offcanvas.classList.contains("show");
	if (offcanvas) {
		offcanvas.addEventListener("shown.bs.offcanvas", () => {
			visible = true;
			markRead();
			markThreadRead();
		});
		offcanvas.addEventListener("hidden.bs.offcanvas", () => (visible = false));
	}
	// Список чатів завантажено (потрібен, наприклад, щоб поділитися записом одразу після відкриття панелі)
	let markReady;
	const ready = new Promise((resolve) => (markReady = resolve));
	// Зовнішній доступ: поділитися записом (кнопка "Обговорити" на сторінці запису)
	root.chatApi = {
		share: (rec) => ready.then(() => shareRecord(rec)),
		open: (idRoom, idMsg) => ready.then(() => openRoom(idRoom, idMsg ? { around: idMsg } : {})),
	};
	const seen = () => visible && !document.hidden;
	const L = cfg.texts || {};
	const ME = Number(C.me);
	const LOCALE = C.locale || C.lang || undefined;
	const TZ = C.timezone || undefined;
	const $ = (id) => document.getElementById(PFX + id);
	const notyf = sharedNotyf();

	// Модальні вікна панелі справа — у body: усередині offcanvas їх перекриває затемнення
	if (MODE === "panel") root.querySelectorAll(".modal").forEach((m) => document.body.appendChild(m));

	// ═══ ДОПОМІЖНЕ ═════════════════════════════════════════
	const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
	const t = (key, vars) => String(L[key] == null ? key : L[key]).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : m));
	const fail = (e) => notyf.error((e && e.error) || t("error"));
	const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
	const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	/**
	 * Підтвердження й короткі запитання — модальне вікно чату (замість alert / confirm / prompt).
	 * fields: [{ name, label, value, type: "text" | "number" | "textarea", maxlength, required }]
	 * Повертає true (без полів) або { name: value } — чи null, якщо скасовано.
	 */
	function ask({ title, text = "", ok, danger = false, fields = [] }) {
		return new Promise((resolve) => {
			const modal = $("chat-dialog");
			const form = $("chat-dialog-form");
			let result = null;
			$("chat-dialog-title").textContent = title;
			$("chat-dialog-text").textContent = text;
			$("chat-dialog-text").classList.toggle("d-none", !text);
			$("chat-dialog-ok").textContent = ok || t("ok");
			$("chat-dialog-ok").className = "btn rounded-0 " + (danger ? "btn-danger" : "btn-primary");
			$("chat-dialog-fields").innerHTML = fields
				.map((f, i) => {
					const id = `${PFX}chat-dialog-f${i}`;
					const attrs = `class="form-control rounded-0" id="${id}" name="${esc(f.name)}"${f.maxlength ? ` maxlength="${f.maxlength}"` : ""}${f.required ? " required" : ""}`;
					const input = f.type === "textarea" ? `<textarea ${attrs} rows="3">${esc(f.value || "")}</textarea>` : `<input type="${f.type === "number" ? "number" : "text"}" ${attrs}${f.type === "number" ? ' min="0" step="0.5"' : ""} value="${esc(f.value == null ? "" : f.value)}">`;
					return `<div class="${text || i ? "mt-3" : ""}"><label class="form-label" for="${id}">${esc(f.label)}</label>${input}${f.hint ? `<div class="form-text">${esc(f.hint)}</div>` : ""}</div>`;
				})
				.join("");
			form.onsubmit = (e) => {
				e.preventDefault();
				const bad = [...form.querySelectorAll("[required]")].find((x) => !x.value.trim());
				if (bad) return bad.classList.add("is-invalid");
				result = fields.length ? Object.fromEntries(fields.map((f) => [f.name, form.elements[f.name].value])) : true;
				bootstrap.Modal.getOrCreateInstance(modal).hide();
			};
			modal.addEventListener("hidden.bs.modal", () => resolve(result), { once: true });
			modal.addEventListener("shown.bs.modal", () => (form.querySelector("input, textarea") || $("chat-dialog-ok")).focus(), { once: true });
			bootstrap.Modal.getOrCreateInstance(modal).show();
		});
	}

	async function api(url, body) {
		const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body || {}) });
		const json = await res.json().catch(() => ({}));
		if (!res.ok || json.ok === false) throw json;
		return json;
	}

	// Дати й час — у поясі та форматі людини (профіль → офіс → мова інтерфейсу)
	function fmt(options) {
		const o = Object.assign({}, options);
		if (TZ && !o.timeZone) o.timeZone = TZ;
		if (C.hour12 != null && (o.hour || o.timeStyle)) o.hour12 = !!C.hour12;
		try {
			return new Intl.DateTimeFormat(LOCALE, o);
		} catch {
			return new Intl.DateTimeFormat(undefined, options);
		}
	}
	const F = { time: fmt({ hour: "2-digit", minute: "2-digit" }), day: fmt({ day: "numeric", month: "long", year: "numeric" }), short: fmt({ day: "2-digit", month: "2-digit" }), full: fmt({ dateStyle: "full", timeStyle: "short" }), when: fmt({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }), weekday: fmt({ weekday: "short" }) };
	const dayKey = (d) => fmt({ year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
	function listTime(d) {
		if (!d) return "";
		const date = new Date(d);
		const now = new Date();
		if (dayKey(date) === dayKey(now)) return F.time.format(date);
		if (now - date < 6 * 864e5) return F.weekday.format(date);
		return F.short.format(date);
	}
	function dayLabel(d) {
		const k = dayKey(d);
		if (k === dayKey(new Date())) return t("today");
		if (k === dayKey(Date.now() - 864e5)) return t("yesterday");
		return F.day.format(new Date(d));
	}
	const size = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB");

	// Час у поясі tz: на зараз або на момент date
	function timeAt(tz, date = new Date(), opts = { hour: "2-digit", minute: "2-digit" }) {
		try {
			return fmt(Object.assign({}, opts, { timeZone: tz })).format(date);
		} catch {
			return "";
		}
	}
	// Час "там" — для співрозмовника з іншого часового поясу
	const localTimeAt = (tz) => (!tz || tz === TZ ? "" : timeAt(tz));

	// ─── Часові пояси: "настінний" час у поясі людини ↔ момент (UTC) ───
	function zoneParts(date, tz) {
		const o = { hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" };
		if (tz) o.timeZone = tz;
		const p = {};
		new Intl.DateTimeFormat("en-US", o).formatToParts(date).forEach((x) => (p[x.type] = x.value));
		return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
	}
	// Зсув поясу (хв) у момент date
	function zoneOffset(date, tz) {
		const p = zoneParts(date, tz);
		return (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000) / 60000;
	}
	// 'YYYY-MM-DDTHH:MM' у поясі людини → Date. Двічі уточнюємо зсув — правильно біля переходу на літній час
	function wallToDate(value) {
		const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || "");
		if (!m) return null;
		const guess = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
		if (!TZ) return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
		let at = guess - zoneOffset(new Date(guess), TZ) * 60000;
		at = guess - zoneOffset(new Date(at), TZ) * 60000;
		return new Date(at);
	}
	const pad = (n) => String(n).padStart(2, "0");
	function dateToWall(date) {
		const p = zoneParts(date, TZ);
		return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
	}
	// "Сьогодні / завтра / у понеділок о HH:MM" у поясі людини
	function wallAt(daysAhead, h, mi = 0) {
		const p = zoneParts(new Date(), TZ);
		const d = new Date(Date.UTC(p.y, p.mo - 1, p.d + daysAhead));
		return wallToDate(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(h)}:${pad(mi)}`);
	}
	const zoneCity = (tz) => String(tz || "").split("/").pop().replace(/_/g, " ");

	// ─── Згадки: токени в тексті ───
	const TOKEN = /@\[([^\]\n]{1,100})\]\((?:(u|d|o):(\d{1,10})|(all))\)/g;
	const tokenPlain = (text) => String(text || "").replace(TOKEN, (m, name) => "@" + name);

	/**
	 * Розмітка повідомлень (безпечна: спершу екрануємо, потім застосовуємо):
	 * ```код```, `код`, **жирний**, _курсив_, ~~закреслений~~, > цитата, - список, посилання, згадки
	 */
	function render(text) {
		if (!text) return "";
		const blocks = [];
		let s = esc(text).replace(/```(?:[a-z0-9]*\n)?([\s\S]*?)```/g, (m, code) => {
			blocks.push(`<pre class="chat-pre"><code>${code.replace(/^\n|\n$/g, "")}</code></pre>`);
			return `\u0000${blocks.length - 1}\u0000`;
		});
		const inline = [];
		s = s.replace(/`([^`\n]+)`/g, (m, code) => {
			inline.push(`<code>${code}</code>`);
			return `\u0001${inline.length - 1}\u0001`;
		});
		// Згадки — до решти розмітки, щоб ім'я не стало курсивом чи посиланням
		const chips = [];
		s = s.replace(/@\[([^\]\n]{1,300})\]\((?:(u|d|o):(\d{1,10})|(all))\)/g, (m, name, kind, id, all) => {
			const me = all || (kind === "u" && Number(id) === ME);
			chips.push(`<span class="chat-mention${me ? " me" : ""}${kind === "u" ? `" data-user="${Number(id)}` : ""}">@${name}</span>`);
			return `\u0002${chips.length - 1}\u0002`;
		});
		s = s
			.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
			.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
			.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, "$1<em>$2</em>")
			.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
		// Цитати й списки — по рядках
		const lines = s.split("\n");
		const out = [];
		let list = null;
		let quote = null;
		const flush = () => {
			if (list) out.push(`<ul class="chat-ul">${list.join("")}</ul>`);
			if (quote) out.push(`<blockquote class="chat-quote">${quote.join("<br>")}</blockquote>`);
			list = quote = null;
		};
		for (const line of lines) {
			let m;
			if ((m = line.match(/^\s*[-•*]\s+(.*)$/))) {
				if (quote) flush();
				(list = list || []).push(`<li>${m[1]}</li>`);
			} else if ((m = line.match(/^&gt;\s?(.*)$/))) {
				if (list) flush();
				(quote = quote || []).push(m[1]);
			} else {
				flush();
				out.push(line);
			}
		}
		flush();
		// Блоки (список, цитата, код) самі з нового рядка — зайві переноси довкола них прибираємо
		s = out
			.join("\n")
			.replace(/\n*(<\/?(?:ul|blockquote)\b[^>]*>)\n*/g, "$1")
			.replace(/\n*(\u0000\d+\u0000)\n*/g, "$1")
			.replace(/\n/g, "<br>");
		return s
			.replace(/\u0002(\d+)\u0002/g, (m, i) => chips[i])
			.replace(/\u0001(\d+)\u0001/g, (m, i) => inline[i])
			.replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[i]);
	}
	const plain = (text) =>
		tokenPlain(text)
			.replace(/```[\s\S]*?```/g, "[code]")
			.replace(/[*_~`>]/g, "")
			.replace(/\s+/g, " ")
			.trim();

	// ═══ СТАН ══════════════════════════════════════════════
	const S = {
		rooms: [],
		byId: new Map(),
		people: new Map(), // id → { name, avatar, timezone, … }
		online: new Set(),
		side: "rooms", // ліва колонка: rooms — чати; people — колеги
		dir: null, // довідник колег (вкладка "Колеги")
		dirAt: 0,
		room: null, // відкритий чат (з учасниками)
		messages: [], // стрічка відкритого чату (за зростанням id)
		more: { older: false, newer: false },
		loading: false,
		typing: new Map(), // id_user → таймер
		status: null,
		infoTab: "members",
		draftTimer: null,
		pins: [],
		pinIndex: 0,
		scheduled: [],
		mentionData: null, // підказки "@" для відкритого чату
		threadsUnread: 0,
	};
	// Поля вводу: основне і в панелі треду
	function composer(prefix, thread) {
		return { key: prefix, thread, input: $(prefix + "-input"), ctx: $(prefix + "-context"), up: $(prefix + "-uploads"), pop: $(prefix + "-mentions"), send: $(prefix + "-send"), root: $(prefix + "-composer"), uploads: [], records: [], reply: null, editing: null, urgent: false, map: new Map(), sel: 0, items: [], at: -1, rec: null, cmd: false, ack: false };
	}
	const MAIN = composer("chat", false);
	const THC = composer("chat-thread", true);


	// Вибір людей і чатів (модальне вікно): новий чат, учасники, переслати, поділитися записом
	const pick = { mode: null, selected: new Set(), list: [], message: null, record: null };
	const pickModal = () => bootstrap.Modal.getOrCreateInstance($("chat-pick"));

	// Відкритий тред (панель справа)
	const TH = { id: null, root: null, replies: [], lastRead: 0, following: false, mode: null }; // mode: thread | list

	const roomName = (r) => {
		if (!r) return "";
		if (r.type === "direct") return (r.partner && r.partner.name) || t("deleted_user");
		if (r.type === "notes") return t("notes");
		if (r.kind === "announcements") return t("announcements");
		return r.name || "—";
	};
	const roomIcon = (r) => {
		if (r.type === "notes") return '<i class="fa-regular fa-bookmark"></i>';
		if (r.kind === "announcements") return '<i class="fa-solid fa-bullhorn"></i>';
		if (r.kind === "office") return '<i class="fa-solid fa-building"></i>';
		if (r.kind === "department") return '<i class="fa-solid fa-sitemap"></i>';
		if (r.type === "channel") return '<i class="fa-solid fa-hashtag"></i>';
		return '<i class="fa-solid fa-users"></i>';
	};
	function avatar(p, cls = "") {
		if (p && p.avatar) return `<img class="chat-ava ${cls}" src="${esc(p.avatar)}" alt="" loading="lazy">`;
		const name = (p && p.name) || "?";
		const letters = name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((x) => [...x][0])
			.join("")
			.toUpperCase();
		let h = 0;
		for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
		return `<span class="chat-ava chat-ava-letters ${cls}" style="background:hsl(${h},45%,45%)">${esc(letters)}</span>`;
	}
	function roomAvatar(r) {
		if (r.type === "direct") return `<span class="chat-ava-wrap">${avatar(r.partner)}${presenceDot(r.partner)}</span>`;
		return `<span class="chat-ava chat-ava-icon" style="${r.color ? "background:" + esc(r.color) : ""}">${roomIcon(r)}</span>`;
	}
	const isOnline = (p) => p && (S.online.has(Number(p.id)) || p.online);
	function presenceDot(p) {
		if (!p) return "";
		const st = p.status && p.status.status;
		const cls = st && st !== "available" ? "st-" + st : isOnline(p) ? "st-online" : "st-offline";
		return `<span class="chat-dot ${cls}"></span>`;
	}
	function statusLine(p) {
		if (!p) return "";
		const parts = [];
		if (p.status && p.status.status !== "available") parts.push(t("status_" + p.status.status));
		if (isOnline(p)) parts.push(t("online"));
		else if (p.last_seen) parts.push(t("last_seen", { time: listTime(p.last_seen) + (dayKey(p.last_seen) === dayKey(new Date()) ? "" : " " + F.time.format(new Date(p.last_seen))) }));
		const there = localTimeAt(p.timezone);
		if (there) parts.push(t("local_time", { time: there }));
		return parts.join(" · ");
	}
	function rememberPeople(list) {
		(list || []).forEach((p) => p && p.id && S.people.set(Number(p.id), Object.assign(S.people.get(Number(p.id)) || {}, p)));
	}
	const personName = (id) => (S.people.get(Number(id)) || {}).name || t("deleted_user");
	const partnerOf = (room) => (room && room.type === "direct" ? S.people.get((room.members.find((m) => m.id !== ME) || {}).id) : null);

	// ═══ СПИСОК ЧАТІВ ══════════════════════════════════════
	async function loadRooms() {
		const r = await api("/api/chat/rooms/list/");
		S.rooms = r.rooms;
		S.byId = new Map(r.rooms.map((x) => [x.id, x]));
		rememberPeople(r.rooms.map((x) => x.partner).filter(Boolean));
		S.status = r.me.status;
		S.threadsUnread = r.threads_unread || 0;
		renderStatus();
		renderRooms();
		renderThreadsBtn();
	}

	function preview(r) {
		const l = r.last;
		if (r.draft && (!S.room || S.room.id !== r.id)) return `<span class="text-danger">${esc(t("draft"))}:</span> ${esc(plain(r.draft).slice(0, 80))}`;
		if (!l) return `<span class="text-muted">${esc(t("no_messages"))}</span>`;
		if (l.deleted) return `<em class="text-muted">${esc(t("deleted"))}</em>`;
		if (l.type === "system") return `<em class="text-muted">${esc(systemText(l.data))}</em>`;
		if (l.type === "event") return `<i class="fa-solid fa-bolt text-warning me-1"></i>${esc(eventTitle(l.data))}`;
		const who = l.id_user === ME ? t("you") + ": " : r.type !== "direct" && l.author ? l.author + ": " : "";
		const body = l.body ? plain(l.body) : l.has_files ? "📎 " + t("file") : "";
		return esc(who + body).slice(0, 120);
	}
	const muted = (r) => r.notify === "none" || (r.muted_until && new Date(r.muted_until) > new Date());

	// ═══ КОЛЕГИ: хто в мережі, статус, посада, офіс, місцевий час ═══
	async function loadPeople(force) {
		if (!force && S.dir && Date.now() - S.dirAt < 60000) return renderPeople();
		try {
			S.dir = await loadDirectory("");
			S.dirAt = Date.now();
		} catch (e) {
			if (!S.dir) S.dir = [];
		}
		renderPeople();
	}
	// Онлайн лише з поточного списку присутності (сокет); "не на місці" (away, meeting…) — теж у мережі, але нижче
	const personRank = (p) => (isOnline(p) ? (!p.status || p.status.status === "available" ? 0 : 1) : 2);
	function personRow(p) {
		const sub = [p.position, p.department, p.office].filter(Boolean).join(" · ");
		return `<button class="chat-room" data-person="${p.id}"${p.me ? " disabled" : ""}>
			<span class="chat-ava-wrap">${avatar(p)}${presenceDot(p)}</span>
			<span class="chat-room-main">
				<span class="chat-room-top"><span class="chat-room-name">${esc(p.name || t("deleted_user"))}${p.me ? ` <small class="text-muted">(${esc(t("you"))})</small>` : ""}</span></span>
				<span class="chat-room-bottom"><span class="chat-room-last">${esc([sub, statusLine(p)].filter(Boolean).join(" · "))}</span></span>
			</span>
		</button>`;
	}
	function renderOnlineCount() {
		const el = $("chat-online-count");
		if (!el) return;
		const n = S.dir ? S.dir.filter((p) => !p.me && isOnline(p)).length : [...S.online].filter((id) => id !== ME).length;
		el.textContent = n;
		el.classList.toggle("d-none", !n);
	}
	function renderPeople() {
		renderOnlineCount();
		const box = $("chat-people");
		if (!box || S.side !== "people") return;
		if (!S.dir) {
			box.innerHTML = `<div class="p-3 text-muted small text-center"><span class="spinner-border spinner-border-sm"></span></div>`;
			return;
		}
		const q = $("chat-filter").value.trim().toLowerCase();
		const hay = (p) => [p.name, p.position, p.department, p.office].filter(Boolean).join(" ").toLowerCase();
		const list = S.dir
			.map((p) => Object.assign(p, S.people.get(p.id) || {}))
			.filter((p) => !q || hay(p).includes(q))
			.sort((a, b) => personRank(a) - personRank(b) || (personRank(a) === 2 ? new Date(b.last_seen || 0) - new Date(a.last_seen || 0) : 0) || String(a.name).localeCompare(String(b.name)));
		const on = list.filter((p) => isOnline(p));
		const off = list.filter((p) => !isOnline(p));
		const head = (text, n) => `<div class="px-2 pt-2 pb-1 small text-muted text-uppercase">${esc(text)} · ${n}</div>`;
		box.innerHTML = list.length ? (on.length ? head(t("people_online"), on.length) + on.map(personRow).join("") : "") + (off.length ? head(t("people_offline"), off.length) + off.map(personRow).join("") : "") : `<div class="p-3 text-muted small text-center">${esc(t("people_none"))}</div>`;
	}
	function setSide(side) {
		S.side = side;
		["rooms", "people"].forEach((s) => {
			const tab = $("chat-tab-" + s);
			if (tab) tab.classList.toggle("active", s === side);
		});
		$("chat-rooms").classList.toggle("d-none", side !== "rooms");
		if ($("chat-people")) $("chat-people").classList.toggle("d-none", side !== "people");
		$("chat-filter").placeholder = side === "people" ? t("search_people") : t("filter");
		if (side === "people") loadPeople(false);
		else renderRooms();
	}
	["rooms", "people"].forEach((s) => {
		const tab = $("chat-tab-" + s);
		if (tab) tab.addEventListener("click", () => setSide(s));
	});
	if ($("chat-people"))
		$("chat-people").addEventListener("click", (e) => {
			const b = e.target.closest("[data-person]");
			if (b && !b.disabled) openDirect(Number(b.dataset.person));
		});

	function renderRooms() {
		const q = $("chat-filter").value.trim().toLowerCase();
		const list = S.rooms.filter((r) => !q || roomName(r).toLowerCase().includes(q));
		$("chat-rooms").innerHTML =
			list
				.map(
					(r) => `<button class="chat-room${S.room && S.room.id === r.id ? " active" : ""}${r.archived ? " archived" : ""}" data-room="${r.id}">
				${roomAvatar(r)}
				<span class="chat-room-main">
					<span class="chat-room-top"><span class="chat-room-name">${esc(roomName(r))}</span>${r.pinned && r.type !== "notes" ? '<i class="fa-solid fa-thumbtack chat-pin"></i>' : ""}${muted(r) && r.type !== "notes" ? '<i class="fa-solid fa-bell-slash chat-mute"></i>' : ""}<span class="chat-room-time">${esc(listTime(r.last ? r.last.date : r.activity_at))}</span></span>
					<span class="chat-room-bottom"><span class="chat-room-last">${preview(r)}</span>${r.mentions ? `<span class="badge rounded-pill text-bg-danger" title="${esc(t("mentions_you"))}">@</span>` : ""}${r.unread ? `<span class="badge rounded-pill ${muted(r) ? "text-bg-secondary" : "text-bg-primary"}">${r.unread > 99 ? "99+" : r.unread}</span>` : ""}</span>
				</span>
			</button>`
				)
				.join("") || `<div class="p-3 text-muted small text-center">${esc(t("no_rooms"))}</div>`;
	}

	function bumpRoom(id) {
		const i = S.rooms.findIndex((r) => r.id === id);
		if (i < 0) return;
		const [r] = S.rooms.splice(i, 1);
		// Порядок: "Збережене" завжди перше, далі закріплені, далі решта (новіші вище)
		const top = (x) => x.type === "notes";
		const at = top(r) ? 0 : r.pinned ? S.rooms.findIndex((x) => !top(x)) : S.rooms.findIndex((x) => !top(x) && !x.pinned);
		S.rooms.splice(at < 0 ? S.rooms.length : at, 0, r);
	}

	// ═══ МІЙ СТАТУС ════════════════════════════════════════
	const STATUSES = ["available", "away", "meeting", "vacation", "dnd"];
	function renderStatus() {
		const st = (S.status && S.status.status) || "available";
		const until = S.status && S.status.until ? " · " + t("until", { time: F.full.format(new Date(S.status.until)) }) : "";
		$("chat-my-status").innerHTML = `<span class="chat-dot st-${st === "available" ? "online" : st} position-static me-1"></span>${esc(t("status_" + st))}<small class="text-muted">${esc(until)}</small>`;
		// Лише стандартні статуси (свого тексту статусу немає)
		$("chat-status-menu").innerHTML = STATUSES.map((s) => `<li><button class="dropdown-item" data-status="${s}"><span class="chat-dot st-${s === "available" ? "online" : s} position-static me-2"></span>${esc(t("status_" + s))}</button></li>`).join("");
	}
	$("chat-status-menu").addEventListener("click", async (e) => {
		const b = e.target.closest("[data-status]");
		if (!b) return;
		// Статус діє, доки людина його не змінить
		const data = { status: b.dataset.status, text: null, until: null };
		try {
			S.status = (await api("/api/chat/status/save/", { data })).status;
			renderStatus();
		} catch (err) {
			fail(err);
		}
	});

	// ═══ ВІДКРИТИЙ ЧАТ ═════════════════════════════════════
	const box = $("chat-messages");
	const tbox = $("chat-thread-list");
	const atBottom = (el = box) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
	const scrollBottom = (el = box) => (el.scrollTop = el.scrollHeight);

	// Адреса чату: випадковий код чату (номер чату в адресі не показуємо)
	const roomUrl = (code, idMessage = null) => `/chat/?room=${encodeURIComponent(code || "")}${idMessage ? "&message=" + Number(idMessage) : ""}`;

	async function openRoom(id, { around = null } = {}) {
		// У віджеті "Пульс компанії" інші чати відкриваються на сторінці чату
		if (C.pulse && S.pulseRoom && id !== S.pulseRoom) {
			window.top.location.assign(roomUrl((S.byId.get(id) || {}).code, around));
			return;
		}
		try {
			const [info, hist] = await Promise.all([api(`/api/chat/rooms/${id}/get/`), api(`/api/chat/rooms/${id}/messages/`, around ? { around } : {})]);
			saveDraftNow();
			const changed = !S.room || S.room.id !== id;
			S.room = info.room;
			rememberPeople(info.room.members);
			S.messages = hist.messages;
			S.more = hist.more;
			S.lastReadAtOpen = hist.last_read_id;
			S.typing.forEach((tm) => clearTimeout(tm));
			S.typing.clear();
			if (changed) {
				resetComposer(MAIN);
				S.mentionData = null;
				if (TH.mode === "thread") closeThread();
			}
			$("chat-empty").classList.add("d-none");
			$("chat-conv-inner").classList.remove("d-none");
			$("chat-app").classList.add("has-room");
			$("chat-app").classList.toggle("is-direct", info.room.type === "direct" || info.room.type === "notes");
			const r = S.byId.get(id);
			if (changed) {
				if (around) $("chat-catchup").classList.add("d-none");
				else showCatchup(id, (r && r.unread) || 0);
			}
			if (changed) {
				MAIN.input.value = fromTokens(MAIN, (r && r.draft) || "");
				autosize(MAIN);
			}
			renderHead();
			renderMessages({ keepScroll: false, focusId: hist.open_thread ? null : around });
			renderComposer(MAIN);
			renderUploads(MAIN);
			renderTyping();
			if (!$("chat-info").classList.contains("d-none")) renderInfo();
			renderRooms();
			loadPins();
			loadScheduled();
			try {
				if (MODE === "page") history.replaceState(null, "", roomUrl(info.room.code));
			} catch {
				/* ок */
			}
			if (hist.open_thread) {
				flash(box.querySelector(`.chat-msg[data-id="${hist.open_thread.id_thread}"]`));
				openThread(hist.open_thread.id_thread, { focusId: hist.open_thread.id_message });
			} else if (!around) markRead();
			if (!hist.open_thread) MAIN.input.focus();
		} catch (e) {
			fail(e);
			if (e && e.error) loadRooms().catch(() => {});
		}
	}

	function closeRoom() {
		saveDraftNow();
		S.room = null;
		S.messages = [];
		S.pins = [];
		closeThread();
		$("chat-conv-inner").classList.add("d-none");
		$("chat-empty").classList.remove("d-none");
		$("chat-app").classList.remove("has-room");
		$("chat-info").classList.add("d-none");
		renderRooms();
	}

	function renderHead() {
		const room = S.room;
		const r = S.byId.get(room.id) || {};
		let sub = "";
		if (room.type === "direct") sub = statusLine(partnerOf(room));
		else if (room.type !== "notes") sub = t("members_count", { n: room.members.length }) + (room.description ? " · " + room.description : "");
		const view = room.type === "direct" ? Object.assign({}, r, { partner: partnerOf(room) }) : Object.assign({}, room, r);
		// "Збережене" (як у Telegram): лише ви — без сповіщень і налаштувань сповіщень
		$("chat-room-bell").closest(".dropdown").classList.toggle("d-none", room.type === "notes");
		$("chat-conv-title").innerHTML = `<div class="d-flex align-items-center gap-2 min-w-0">${roomAvatar(view)}<div class="min-w-0"><div class="fw-bold text-truncate">${esc(roomName(view))}${room.archived ? ` <span class="badge text-bg-secondary rounded-0">${esc(t("archived"))}</span>` : ""}</div><div class="small text-muted text-truncate">${esc(sub)}</div></div></div>`;
		renderNotifyMenu();
	}

	function renderNotifyMenu() {
		const r = S.byId.get(S.room.id) || {};
		const item = (data, label, active) => `<li><button class="dropdown-item${active ? " active" : ""}" ${data}>${esc(label)}</button></li>`;
		const isMuted = r.muted_until && new Date(r.muted_until) > new Date();
		$("chat-room-bell").innerHTML = muted(r) ? '<i class="fa-solid fa-bell-slash"></i>' : '<i class="fa-regular fa-bell"></i>';
		$("chat-room-notify").innerHTML = [
			item('data-notify="all"', t("notify_all"), r.notify === "all"),
			item('data-notify="mentions"', t("notify_mentions"), r.notify === "mentions"),
			item('data-notify="none"', t("notify_none"), r.notify === "none"),
			'<li><hr class="dropdown-divider"></li>',
			isMuted ? `<li><span class="dropdown-item-text small text-muted">${esc(t("muted_until", { time: new Date(r.muted_until).getFullYear() > 9000 ? t("forever") : F.full.format(new Date(r.muted_until)) }))}</span></li>` + item('data-mute="0"', t("unmute")) : "",
			item('data-mute="60"', t("mute_1h")),
			item('data-mute="480"', t("mute_8h")),
			item('data-mute="1440"', t("mute_24h")),
			item('data-mute="-1"', t("mute_forever")),
			'<li><hr class="dropdown-divider"></li>',
			item('data-pin="1"', r.pinned ? t("unpin") : t("pin")),
		].join("");
	}
	$("chat-room-notify").addEventListener("click", async (e) => {
		const b = e.target.closest("button");
		if (!b || !S.room) return;
		const r = S.byId.get(S.room.id) || {};
		const data = {};
		if (b.dataset.notify) data.notify = b.dataset.notify;
		if (b.dataset.mute != null) data.mute_minutes = parseInt(b.dataset.mute, 10);
		if (b.dataset.pin) data.pinned = !r.pinned;
		try {
			await api(`/api/chat/rooms/${S.room.id}/settings/`, { data });
			await loadRooms();
			renderNotifyMenu();
		} catch (err) {
			fail(err);
		}
	});

	// ─── Стрічка повідомлень ───
	function systemText(d) {
		if (!d) return "";
		const users = (ids) => (ids || []).map(personName).join(", ");
		switch (d.event) {
			case "created":
				return t("sys_created", { user: personName(d.by) });
			case "renamed":
				return t("sys_renamed", { user: personName(d.by), name: d.name });
			case "added":
				return t("sys_added", { user: personName(d.by), users: users(d.users) });
			case "removed":
				return t("sys_removed", { user: personName(d.by), users: personName(d.user) });
			case "left":
				return t("sys_left", { user: personName(d.user) });
			case "joined":
				return t("sys_joined", { user: personName(d.user) });
			case "archived":
				return t("sys_archived", { user: personName(d.by) });
			case "unarchived":
				return t("sys_unarchived", { user: personName(d.by) });
			case "pinned":
				return t("sys_pinned", { user: personName(d.by) });
			case "unpinned":
				return t("sys_unpinned", { user: personName(d.by) });
			case "decision":
				return t("sys_decision", { user: personName(d.by) });
			case "task":
				return Number(d.by) === Number(d.user) ? t("sys_task_self", { user: personName(d.by), title: d.title || "" }) : t("sys_task", { user: personName(d.by), to: personName(d.user), title: d.title || "" });
			default:
				return "";
		}
	}

	// Прочитано хоч кимось, крім автора (для ✓✓)
	function readByOthers(m) {
		return S.room.members.some((x) => x.id !== m.id_user && x.last_read_id >= m.id);
	}

	function filesHtml(files) {
		if (!files || !files.length) return "";
		const imgs = files.filter((f) => f.inline && f.mime.startsWith("image/"));
		const rest = files.filter((f) => !(f.inline && f.mime.startsWith("image/")));
		let html = "";
		if (imgs.length) html += `<div class="chat-imgs n${Math.min(imgs.length, 4)}">${imgs.map((f) => `<a href="${esc(f.url)}" data-view="${esc(f.url)}"><img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy"${f.width ? ` width="${f.width}" height="${f.height}"` : ""}></a>`).join("")}</div>`;
		html += rest
			.map((f) => {
				if (f.inline && f.mime.startsWith("video/")) return `<video class="chat-video" src="${esc(f.url)}" controls preload="metadata"></video>`;
				if (f.inline && f.mime.startsWith("audio/")) return `<div class="chat-voice">${/^voice-/.test(f.name) ? `<i class="fa-solid fa-microphone text-primary"></i>` : ""}<audio class="chat-audio" src="${esc(f.url)}" controls preload="metadata"></audio></div>`;
				const icon = f.mime === "application/pdf" ? "fa-file-pdf" : /zip|rar|7z|tar|gzip/.test(f.mime) ? "fa-file-zipper" : /sheet|excel|csv/.test(f.mime) ? "fa-file-excel" : /word|document/.test(f.mime) ? "fa-file-word" : "fa-file";
				return `<div class="chat-file"><i class="fa-regular ${icon} fa-lg"></i><a class="min-w-0 flex-grow-1 text-reset text-decoration-none" href="${esc(f.url)}" target="_blank" rel="noopener"><span class="d-block text-truncate">${esc(f.name)}</span><small class="text-muted">${esc(size(f.size))}</small></a><a class="text-muted" href="${esc(f.url)}?download=1" title="${esc(t("download"))}"><i class="fa-solid fa-download"></i></a></div>`;
			})
			.join("");
		return `<div class="chat-files">${html}</div>`;
	}

	const canModerate = () => C.perms.moderate || (S.room && S.room.can.manage);
	// Закріплювати: особистий чат і нотатки — будь-хто; ручна група / канал — власник і адміністратори; автоматичні — модератори
	const canPin = () => {
		const r = S.room;
		if (!r || r.archived) return false;
		if (r.type === "direct" || r.type === "notes") return true;
		return r.kind === "manual" ? r.role === "owner" || r.role === "admin" : !!C.perms.moderate;
	};

	function reactionsHtml(m) {
		if (m.deleted || !m.reactions || !m.reactions.length) return "";
		return `<div class="chat-reacts">${m.reactions
			.map((r) => `<button class="chat-react${r.mine ? " mine" : ""}" data-react="${esc(r.emoji)}" title="${esc(r.users.map(personName).join(", "))}">${esc(r.emoji)}<span>${r.count}</span></button>`)
			.join("")}</div>`;
	}

	// ─── Картки записів системи ───
	const RECORD_ICON = { order: "fa-solid fa-cart-shopping", lead: "fa-solid fa-filter-circle-dollar", client: "fa-regular fa-user", deal: "fa-solid fa-handshake" };
	const SOURCE_ICON = { orders: "fa-solid fa-cart-shopping", catalog: "fa-solid fa-boxes-stacked" };
	function money(amount, currency) {
		if (amount == null) return "";
		try {
			return currency ? new Intl.NumberFormat(LOCALE, { style: "currency", currency }).format(amount) : new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 }).format(amount);
		} catch {
			return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 }).format(amount) + (currency ? " " + currency : "");
		}
	}
	function cardHtml(c) {
		const kind = t("record_" + c.type);
		if (c.denied || c.missing)
			return `<div class="chat-card muted"><i class="${RECORD_ICON[c.type] || "fa-regular fa-file"}"></i><span>${esc(t(c.denied ? "record_denied" : "record_missing", { kind, id: c.id }))}</span></div>`;
		const sub = [c.sub, c.owner_name ? t("record_owner", { name: c.owner_name }) : ""].filter(Boolean).join(" · ");
		return `<a class="chat-card" href="${esc(c.url)}" target="_top"><i class="${RECORD_ICON[c.type] || "fa-regular fa-file"}"></i><span class="min-w-0 flex-grow-1"><span class="d-block small text-muted">${esc(kind)}</span><span class="d-block fw-semibold text-truncate">${esc(c.title)}</span>${sub ? `<span class="d-block small text-muted text-truncate">${esc(sub)}</span>` : ""}</span><span class="text-end flex-shrink-0">${c.status ? `<span class="badge text-bg-light border rounded-0 d-block mb-1">${esc(c.status)}</span>` : ""}${c.amount != null ? `<span class="small fw-semibold">${esc(money(c.amount, c.currency))}</span>` : ""}</span></a>`;
	}
	const cardsHtml = (list) => (list && list.length ? `<div class="chat-cards">${list.map(cardHtml).join("")}</div>` : "");

	// Подія системи: текст за джерелом (замовлення — з карткою, каталог — текст сповіщення)
	function eventTitle(d) {
		if (!d) return "";
		if (d.source === "orders") {
			const x = d.extra || {};
			const detail = d.ev === "status" ? x.status_name || "" : x.number || (x.status ? t("ev_rma_" + x.status) : "");
			return t("ev_orders_" + d.ev) + (detail ? ": " + detail : "");
		}
		return d.title || t("ev_" + d.source + "_" + d.ev);
	}
	function eventHtml(m) {
		const d = m.data || {};
		const text = d.source === "orders" ? "" : d.message || "";
		return `<div class="chat-event-title">${esc(eventTitle(d))}</div>${text ? `<div class="chat-event-text">${esc(text)}</div>` : ""}${d.url ? `<a class="small" href="${esc(d.url)}" target="_top">${esc(t("open"))}</a>` : ""}`;
	}

	// ─── Опитування, чеклісти, підтвердження, рішення ───
	const canDecide = (m) => {
		const r = S.room;
		return r.type === "direct" || r.type === "notes" || m.id_user === ME || r.role === "owner" || r.role === "admin" || !!C.perms.moderate;
	};
	function decisionHtml(d) {
		return `<div class="chat-decision-tag" title="${esc(t("decision_by", { name: personName(d.by) }))}"><i class="fa-solid fa-gavel me-1"></i>${esc(t("decision"))}${d.note ? ": " + esc(d.note) : ""}</div>`;
	}
	function pollHtml(m) {
		const p = m.poll;
		if (!p) return "";
		const max = Math.max(1, ...p.options.map((o) => o.count));
		const total = p.options.reduce((a, o) => a + o.count, 0);
		const canClose = !p.closed && (m.id_user === ME || canModerate());
		const opts = p.options
			.map((o) => {
				const pct = total ? Math.round((o.count / total) * 100) : 0;
				const who = o.voters && o.voters.length ? o.voters.map(personName).join(", ") : "";
				return `<button class="chat-poll-opt${o.mine ? " mine" : ""}" data-vote="${o.id}"${p.closed ? " disabled" : ""} title="${esc(who)}"><span class="chat-poll-bar" style="width:${(o.count / max) * 100}%"></span><span class="chat-poll-mark"><i class="${p.multiple ? (o.mine ? "fa-solid fa-square-check" : "fa-regular fa-square") : o.mine ? "fa-solid fa-circle-dot" : "fa-regular fa-circle"}"></i></span><span class="chat-poll-text">${esc(o.text)}</span><span class="chat-poll-n">${o.count ? o.count + " · " + pct + "%" : ""}</span></button>`;
			})
			.join("");
		const info = [t("poll_votes", { n: p.total }), p.anonymous ? t("poll_anonymous") : "", p.multiple ? t("poll_multiple") : "", p.closed ? t("poll_closed") : p.closes_at ? t("poll_until", { time: F.when.format(new Date(p.closes_at)) }) : ""].filter(Boolean).join(" · ");
		return `<div class="chat-poll" data-poll-id="${m.id}">${opts}<div class="chat-poll-info">${esc(info)}${canClose ? ` · <button class="btn btn-link btn-sm p-0 align-baseline" data-poll-close>${esc(t("poll_close"))}</button>` : ""}</div></div>`;
	}
	function checklistHtml(m) {
		const list = m.checklist;
		if (!list) return "";
		const done = list.filter((i) => i.done).length;
		return `<div class="chat-check"><div class="chat-check-progress"><span style="width:${list.length ? (done / list.length) * 100 : 0}%"></span></div><div class="small text-muted mb-1">${esc(t("checklist_done", { done, total: list.length }))}</div>${list
			.map((i) => `<label class="chat-check-item${i.done ? " done" : ""}"${i.done ? ` title="${esc(t("checked_by", { name: i.done_name || personName(i.done_by) }))}"` : ""}><input type="checkbox" class="form-check-input mt-0" data-check="${i.id}"${i.done ? " checked" : ""}${S.room.archived ? " disabled" : ""}><span>${esc(i.text)}</span></label>`)
			.join("")}</div>`;
	}
	function ackHtml(m) {
		const a = m.ack;
		if (!a) return "";
		const counter = `<button class="btn btn-link btn-sm p-0" data-acks="${m.id}">${esc(t("ack_count", { n: a.count, total: a.total }))}</button>`;
		if (m.id_user === ME) return `<div class="chat-ack"><i class="fa-solid fa-circle-check me-1"></i>${esc(t("ack_required"))} · ${counter}</div>`;
		return `<div class="chat-ack">${a.mine ? `<span class="text-success"><i class="fa-solid fa-circle-check me-1"></i>${esc(t("ack_done"))}</span>` : `<button class="btn btn-sm btn-success rounded-0" data-ack-do>${esc(t("ack_button"))}</button>`} · ${counter}</div>`;
	}

	/** Повідомлення. inThread — у панелі треду (без треду, закріплення, роздільника "нові") */
	function messageHtml(m, prev, { inThread = false } = {}) {
		const showDay = !prev || dayKey(prev.date) !== dayKey(m.date);
		let html = showDay ? `<div class="chat-day"><span>${esc(dayLabel(m.date))}</span></div>` : "";
		const lastRead = inThread ? TH.lastRead : S.lastReadAtOpen;
		if (lastRead && prev && prev.id <= lastRead && m.id > lastRead && m.id_user !== ME) html += `<div class="chat-new-sep"${inThread ? "" : ` id="${PFX}chat-new-sep"`}><span>${esc(t("new_messages"))}</span></div>`;
		if (m.type === "system") return html + `<div class="chat-sys" data-id="${m.id}">${esc(systemText(m.data))}</div>`;

		const mine = m.id_user === ME;
		const isEvent = m.type === "event";
		const grouped = !showDay && prev && prev.type === "text" && !isEvent && prev.id_user === m.id_user && new Date(m.date) - new Date(prev.date) < 5 * 60e3 && !m.urgent;
		const author = isEvent ? { name: t("system_events"), system: true } : m.author || S.people.get(Number(m.id_user)) || { name: t("deleted_user") };
		const fwd = m.forwarded && m.data && m.data.forward ? `<div class="chat-fwd"><i class="fa-solid fa-share me-1"></i>${esc(t("forwarded_from", { name: m.data.forward.from_name || t("deleted_user") }))}${m.data.forward.from_room ? " · " + esc(m.data.forward.from_room) : ""}</div>` : "";
		const reply = m.reply
			? `<button class="chat-reply-quote" data-goto="${m.reply.id}"><strong>${esc(m.reply.author || t("deleted_user"))}</strong><span>${m.reply.deleted ? esc(t("deleted")) : esc(plain(m.reply.body).slice(0, 140) || (m.reply.has_files ? "📎 " + t("file") : ""))}</span></button>`
			: "";
		const urgent = m.urgent && !m.deleted ? `<div class="chat-urgent-tag"><i class="fa-solid fa-circle-exclamation me-1"></i>${esc(t("urgent"))}</div>` : "";
		const body = m.deleted ? `<em class="text-muted"><i class="fa-solid fa-ban me-1"></i>${esc(t("deleted"))}</em>` : isEvent ? eventHtml(m) : render(m.body);
		const showTicks = mine && !m.deleted && S.room.type !== "notes";
		const read = showTicks && !inThread && readByOthers(m);
		// Галочки — як у діалогах контакт-центру: ✓ надіслано, ✓✓ синім — прочитано
		const ticks = showTicks ? ` <button class="chat-ticks" data-readers="${m.id}" title="${esc(read ? t("status_read") : t("status_sent"))}"><i class="${read ? "fa-solid fa-check-double text-primary" : "fa-solid fa-check"} msg-status"></i></button>` : "";
		// Час під бульбашкою, як у діалогах контакт-центру
		const meta = `<span class="time chat-meta">${m.pinned ? `<i class="fa-solid fa-thumbtack me-1" title="${esc(t("pinned"))}"></i>` : ""}<span title="${esc(F.full.format(new Date(m.date)))}">${esc(F.time.format(new Date(m.date)))}</span>${m.edited_at && !m.deleted ? `<span class="msg-edited-mark" title="${esc(F.full.format(new Date(m.edited_at)))}">(${esc(t("edited"))})</span>` : ""}${ticks}</span>`;
		// Коментарі (тред) — нижній рядок бульбашки, як у каналах Telegram
		const thread = !inThread && m.thread && m.thread.count ? `<button class="chat-thread-link" data-thread="${m.id}"><i class="fa-regular fa-comments"></i><span class="flex-grow-1 text-start">${esc(t("thread_replies", { n: m.thread.count }))}</span><span class="text-muted small">${esc(listTime(m.thread.last_at))}</span><i class="fa-solid fa-chevron-right small"></i></button>` : "";

		return (
			html +
			`<div class="chat-msg${mine ? " mine" : ""}${isEvent ? " event" : ""}${grouped ? " grouped" : ""}${m.deleted ? " deleted" : ""}${m.urgent && !m.deleted ? " urgent" : ""}${m.mentioned ? " mentioned" : ""}" data-id="${m.id}">
				<div class="chat-msg-ava">${grouped ? "" : isEvent ? `<span class="chat-ava chat-ava-icon"><i class="${SOURCE_ICON[(m.data && m.data.source) || ""] || "fa-solid fa-bolt"}"></i></span>` : avatar(author)}</div>
				<div class="chat-msg-main">
					${grouped ? "" : `<div class="chat-msg-author">${esc(author.name)}</div>`}
					<div class="alert ${mine ? "alert-primary" : "alert-light"} rounded-0 mb-0 p-2 chat-bubble">${urgent}${fwd}${reply}${!m.deleted && m.decision ? decisionHtml(m.decision) : ""}<div class="chat-text">${body}</div>${m.deleted ? "" : pollHtml(m) + checklistHtml(m) + filesHtml(m.files) + cardsHtml(m.records) + ackHtml(m)}${reactionsHtml(m)}${thread}</div>
					${meta}
				</div>
			</div>`
		);
	}
	function flash(el) {
		if (!el) return;
		el.scrollIntoView({ block: "center" });
		el.classList.add("flash");
		setTimeout(() => el.classList.remove("flash"), 2000);
	}
	function renderMessages({ keepScroll = true, focusId = null } = {}) {
		const before = box.scrollHeight - box.scrollTop;
		const stick = atBottom();
		let html = S.more.older ? `<div class="chat-more"><button class="btn btn-sm btn-light rounded-0" data-older>${esc(t("load_older"))}</button></div>` : "";
		S.messages.forEach((m, i) => (html += messageHtml(m, S.messages[i - 1])));
		if (S.more.newer) html += `<div class="chat-more"><button class="btn btn-sm btn-light rounded-0" data-newer>${esc(t("load_newer"))}</button></div>`;
		if (!S.messages.length) html = `<div class="text-center text-muted small p-4">${esc(t("no_messages"))}</div>`;
		box.innerHTML = html;
		if (focusId) flash(box.querySelector(`.chat-msg[data-id="${focusId}"]`));
		else if (!keepScroll) {
			const sep = $("chat-new-sep");
			if (sep) sep.scrollIntoView({ block: "start" });
			else scrollBottom();
			S.stick = !sep;
		} else if (stick) scrollBottom();
		else box.scrollTop = box.scrollHeight - before;
	}

	async function loadOlder() {
		if (S.loading || !S.more.older || !S.messages.length) return;
		S.loading = true;
		try {
			const r = await api(`/api/chat/rooms/${S.room.id}/messages/`, { before: S.messages[0].id });
			const height = box.scrollHeight;
			const top = box.scrollTop;
			S.messages = r.messages.concat(S.messages);
			S.more.older = r.more.older;
			renderMessages({ keepScroll: true });
			box.scrollTop = box.scrollHeight - height + top;
		} catch (e) {
			fail(e);
		} finally {
			S.loading = false;
		}
	}
	async function loadNewer() {
		if (S.loading || !S.messages.length) return;
		S.loading = true;
		try {
			const r = await api(`/api/chat/rooms/${S.room.id}/messages/`, { after: S.messages[S.messages.length - 1].id });
			S.messages = S.messages.concat(r.messages.filter((m) => !S.messages.some((x) => x.id === m.id)));
			S.more.newer = r.more.newer;
			renderMessages({ keepScroll: true });
		} catch (e) {
			fail(e);
		} finally {
			S.loading = false;
		}
	}
	/**
	 * Притиснуто до низу: картинки, відео й картки вантажаться вже після показу стрічки й збільшують її висоту —
	 * якщо людина була внизу, лишаємо її внизу (інакше останнє повідомлення обрізається).
	 */
	S.stick = true;
	const keepBottom = (el, flag) => () => {
		if (flag()) scrollBottom(el);
	};
	["load", "loadedmetadata"].forEach((ev) => {
		box.addEventListener(ev, keepBottom(box, () => S.stick), true);
		tbox.addEventListener(ev, keepBottom(tbox, () => TH.stick), true);
	});
	tbox.addEventListener("scroll", () => {
		TH.stick = atBottom(tbox);
		if (tbox.scrollTop < 60) loadOlderThread();
	});
	// Старіші відповіді треду — пачкою при прокрутці вгору (позиція на екрані не стрибає)
	let threadLoading = false;
	async function loadOlderThread() {
		if (threadLoading || TH.mode !== "thread" || !TH.more || !TH.replies.length) return;
		threadLoading = true;
		const id = TH.id;
		try {
			const r = await api(`/api/chat/threads/${id}/`, { before: TH.replies[0].id });
			if (TH.id !== id) return;
			const height = tbox.scrollHeight;
			const top = tbox.scrollTop;
			TH.replies = r.replies.concat(TH.replies);
			TH.more = r.more;
			renderThread({ keepScroll: true });
			tbox.scrollTop = tbox.scrollHeight - height + top;
		} catch (e) {
			fail(e);
		} finally {
			threadLoading = false;
		}
	}
	box.addEventListener("scroll", () => {
		S.stick = atBottom();
		if (box.scrollTop < 60) loadOlder();
		if (atBottom()) {
			$("chat-jump").classList.add("d-none");
			markRead();
		}
	});
	$("chat-jump").addEventListener("click", async () => {
		if (S.more.newer) {
			await openRoom(S.room.id);
			return;
		}
		scrollBottom();
	});

	// Прочитано: чат відкритий, видно низ стрічки, вкладка активна
	let readTimer = null;
	function markRead() {
		if (!S.room || !S.messages.length || !seen() || S.more.newer) return;
		const last = S.messages[S.messages.length - 1];
		const r = S.byId.get(S.room.id);
		if (!atBottom()) return;
		if (r && r.last_read_id >= last.id && !r.unread && !r.mentions) return;
		clearTimeout(readTimer);
		const idRoom = S.room.id;
		readTimer = setTimeout(async () => {
			try {
				await api(`/api/chat/rooms/${idRoom}/read/`, { id_message: last.id });
				if (r) {
					r.last_read_id = last.id;
					r.unread = 0;
					r.mentions = 0;
					renderRooms();
				}
			} catch {
				/* наступна спроба — при новому повідомленні */
			}
		}, 300);
	}
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) return;
		markRead();
		markThreadRead();
	});
	window.addEventListener("focus", () => {
		markRead();
		markThreadRead();
	});

	// ─── Дії з повідомленнями (стрічка і тред) ───
	const findMessage = (id) => S.messages.find((x) => x.id === id) || (TH.root && TH.root.id === id ? TH.root : null) || TH.replies.find((x) => x.id === id) || null;

	async function onListClick(e, inThread) {
		if (e.target.closest("[data-older]")) return loadOlder();
		if (e.target.closest("[data-newer]")) return loadNewer();
		const view = e.target.closest("[data-view]");
		if (view) {
			e.preventDefault();
			return showImage(view.dataset.view);
		}
		const go = e.target.closest("[data-goto]");
		if (go) return inThread ? flash(tbox.querySelector(`.chat-msg[data-id="${go.dataset.goto}"]`)) : gotoMessage(Number(go.dataset.goto));
		const rd = e.target.closest("[data-readers]");
		if (rd) return showReaders(Number(rd.dataset.readers));
		const th = e.target.closest("[data-thread]");
		if (th) return openThread(Number(th.dataset.thread));
		const mu = e.target.closest(".chat-mention[data-user]");
		if (mu && Number(mu.dataset.user) !== ME) return openDirect(Number(mu.dataset.user));
		const vt = e.target.closest("[data-vote]");
		if (vt) return vote(Number(vt.closest(".chat-msg").dataset.id), Number(vt.dataset.vote));
		if (e.target.closest("[data-poll-close]")) return closePoll(Number(e.target.closest(".chat-msg").dataset.id));
		// Пункт чекліста: стан бере не браузер (він сам перемикає галочку), а дані повідомлення — і показує те, що відповів сервер
		const ck = e.target.closest(".chat-check-item");
		if (ck) {
			e.preventDefault();
			const input = ck.querySelector("[data-check]");
			if (input && !input.disabled) checkItem(Number(ck.closest(".chat-msg").dataset.id), Number(input.dataset.check));
			return;
		}
		if (e.target.closest("[data-ack-do]")) return doAck(Number(e.target.closest(".chat-msg").dataset.id));
		const ac = e.target.closest("[data-acks]");
		if (ac) return showAcks(Number(ac.dataset.acks));
		const re = e.target.closest("[data-react]");
		if (re) return react(Number(re.closest(".chat-msg").dataset.id), re.dataset.react);
		const b = e.target.closest("[data-act]");
		if (!b) return;
		const id = Number(b.closest(".chat-msg").dataset.id);
		if (b.dataset.act === "menu") {
			const r = b.getBoundingClientRect();
			return openMenu(id, inThread, r.left, r.bottom + 4);
		}
		return runAct(b.dataset.act, id, inThread, b);
	}

	/** Дія з повідомленням (кнопки біля бульбашки й контекстне меню) */
	async function runAct(act, id, inThread, anchor) {
		const m = findMessage(id);
		if (!m) return;
		const cmp = inThread ? THC : MAIN;
		switch (act) {
			case "react":
				return openReactPicker(anchor, id);
			case "copy_sel":
				navigator.clipboard && navigator.clipboard.writeText(S.ctxSelection || "").then(() => notyf.success(t("copied")));
				break;
			case "reactions":
				return showReactions(m);
			case "readers":
				return showReaders(id);
			case "thread":
				return openThread(id, { focusInput: true });
			case "reply":
				cmp.editing = null;
				cmp.reply = m;
				renderComposer(cmp);
				cmp.input.focus();
				break;
			case "edit":
				cmp.reply = null;
				cmp.editing = m;
				cmp.input.value = fromTokens(cmp, m.body || "");
				autosize(cmp);
				renderComposer(cmp);
				cmp.input.focus();
				break;
			case "copy":
				navigator.clipboard && navigator.clipboard.writeText(tokenPlain(m.body || "")).then(() => notyf.success(t("copied")));
				break;
			case "delete":
				if (!(await ask({ title: t("delete"), text: t("confirm_delete"), ok: t("delete"), danger: true }))) return;
				try {
					upsertMessage((await api(`/api/chat/messages/${id}/delete/`)).message);
				} catch (err) {
					fail(err);
				}
				break;
			case "forward":
				pickRooms(m);
				break;
			case "remind":
				return remindAbout(m);
			case "task":
				return makeTask(m);
			case "decision":
				return toggleDecision(m);
			case "pin":
				try {
					await api(`/api/chat/messages/${id}/pin/`, { value: !m.pinned });
				} catch (err) {
					fail(err);
				}
				break;
		}
	}
	box.addEventListener("click", (e) => onListClick(e, false));
	tbox.addEventListener("click", (e) => {
		const open = e.target.closest("[data-open-thread]");
		if (open) return openThread(Number(open.dataset.openThread), { idRoom: Number(open.dataset.room) });
		onListClick(e, true);
	});

	function showImage(url) {
		$("chat-viewer-body").innerHTML = `<img src="${esc(url)}" class="img-fluid" alt="">`;
		$("chat-viewer-download").href = url + "?download=1";
		bootstrap.Modal.getOrCreateInstance($("chat-viewer")).show();
	}

	async function gotoMessage(id) {
		const el = box.querySelector(`.chat-msg[data-id="${id}"]`);
		if (el) {
			el.scrollIntoView({ block: "center", behavior: "smooth" });
			el.classList.add("flash");
			setTimeout(() => el.classList.remove("flash"), 2000);
			return;
		}
		await openRoom(S.room.id, { around: id });
	}

	/** Хто прочитав — лише ті, хто прочитав (сторінками), скільки ще ні — числом */
	async function showReaders(id, after = 0) {
		try {
			const r = await api(`/api/chat/messages/${id}/readers/`, { after });
			const row = (p) => `<div class="d-flex align-items-center gap-2 mb-2">${avatar(p, "sm")}<span>${esc(p.name || t("deleted_user"))}</span></div>`;
			const more = r.next ? `<button class="btn btn-sm btn-light rounded-0 w-100" data-readers-more="${id}" data-after="${r.next}">${esc(t("load_more"))}</button>` : "";
			const body = $("chat-readers-body");
			if (after) {
				const old = body.querySelector("[data-readers-more]");
				if (old) old.remove();
				body.querySelector(".chat-readers-list").insertAdjacentHTML("beforeend", r.read.map(row).join(""));
				return body.insertAdjacentHTML("beforeend", more);
			}
			$("chat-readers-title").textContent = t("readers");
			body.innerHTML = `<div class="small text-muted mb-2">${esc(t("read_by"))}: ${r.read_count}${r.unread_count ? ` · ${esc(t("not_read_count", { n: r.unread_count }))}` : ""}</div><div class="chat-readers-list">${r.read.map(row).join("") || `<div class="text-muted small">${esc(t("nobody_read"))}</div>`}</div>${more}`;
			bootstrap.Modal.getOrCreateInstance($("chat-readers")).show();
		} catch (e) {
			fail(e);
		}
	}
	$("chat-readers-body").addEventListener("click", (e) => {
		const b = e.target.closest("[data-readers-more]");
		if (b) showReaders(Number(b.dataset.readersMore), Number(b.dataset.after));
	});

	/** Нове або змінене повідомлення — у стрічку, у тред, у перше повідомлення треду */
	function upsertMessage(m) {
		if (!S.room || m.id_room !== S.room.id) return;
		if (m.id_thread) {
			if (TH.mode === "thread" && TH.id === m.id_thread) {
				const i = TH.replies.findIndex((x) => x.id === m.id);
				if (i >= 0) TH.replies[i] = m;
				else TH.replies.push(m);
				renderThread({ keepScroll: true });
			}
			return;
		}
		if (TH.root && TH.root.id === m.id) {
			TH.root = m;
			renderThread({ keepScroll: true });
		}
		const i = S.messages.findIndex((x) => x.id === m.id);
		if (i >= 0) S.messages[i] = m;
		else if (!S.more.newer) S.messages.push(m);
		renderMessages({ keepScroll: true });
	}
	function rerender(m) {
		if (m.id_thread || (TH.root && TH.root.id === m.id)) renderThread({ keepScroll: true });
		if (!m.id_thread) renderMessages({ keepScroll: true });
	}

	// ═══ ЕМОДЗІ — Emoji Mart (та сама бібліотека й налаштування, що в діалогах контакт-центру) ═══
	// Бібліотека вантажиться при першому відкритті; на сторінці діалогу вона вже є — вдруге не підключаємо
	let emojiLib = null;
	function loadEmojiMart() {
		if (typeof EmojiMart !== "undefined") return Promise.resolve();
		if (!emojiLib)
			emojiLib = new Promise((resolve, reject) => {
				const el = document.createElement("script");
				el.src = "https://cdn.jsdelivr.net/npm/emoji-mart@5.6.0/dist/browser.min.js";
				el.onload = resolve;
				el.onerror = reject;
				document.head.appendChild(el);
			});
		return emojiLib;
	}
	async function emojiPicker(onSelect) {
		try {
			await loadEmojiMart();
			return new EmojiMart.Picker({
				data: async () => (await fetch("https://cdn.jsdelivr.net/npm/@emoji-mart/data")).json(),
				locale: "en",
				theme: "light",
				previewPosition: "none",
				skinTonePosition: "search",
				searchPosition: "sticky",
				navPosition: "top",
				perLine: 9,
				maxFrequentRows: 1,
				onEmojiSelect: (emoji) => onSelect(emoji.native),
			});
		} catch (e) {
			console.error("emoji-mart:", e);
			notyf.error(t("emoji_error"));
			return null;
		}
	}
	// Панель емодзі над полем вводу (своя для основного поля і для треду)
	async function toggleEmoji(cmp) {
		const panel = cmp.root.querySelector(".chat-emoji-panel");
		if (!panel.classList.contains("d-none")) return panel.classList.add("d-none");
		if (!panel.firstChild) {
			const picker = await emojiPicker((native) => {
				cmp.input.setRangeText(native, cmp.input.selectionStart, cmp.input.selectionEnd, "end");
				cmp.input.focus();
				autosize(cmp);
			});
			if (!picker) return;
			panel.appendChild(picker);
		}
		panel.classList.remove("d-none");
	}
	// Клік поза панеллю — закрити
	document.addEventListener("click", (e) => {
		root.querySelectorAll(".chat-emoji-panel:not(.d-none)").forEach((panel) => {
			const own = panel.closest(".chat-composer");
			if (!panel.contains(e.target) && !(own && own.querySelector("[data-emoji]").contains(e.target))) panel.classList.add("d-none");
		});
	});

	// ═══ РЕАКЦІЇ ══════════════════════════════════════════
	const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🙏", "✅", "🔥", "👀", "🎉"];
	const pop = $("chat-react-pop");
	let popFor = null;
	let popAnchor = null;
	const closeReactPicker = () => {
		pop.classList.add("d-none");
		popFor = null;
	};
	// Вікно реакцій — біля повідомлення й завжди в межах екрана (над ним, а якщо місця немає — під ним)
	function placePop() {
		if (!popAnchor) return;
		const a = popAnchor.getBoundingClientRect();
		const w = pop.offsetWidth;
		const h = pop.offsetHeight;
		pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, a.left)) + "px";
		const above = a.top - h - 6;
		pop.style.top = (above >= 8 ? above : Math.max(8, Math.min(window.innerHeight - h - 8, a.bottom + 6))) + "px";
	}
	// Усі емодзі одразу (Emoji Mart) — швидкі реакції вже є вгорі контекстного меню
	function openReactPicker(anchor, id) {
		popFor = id;
		popAnchor = anchor;
		emojiPicker((native) => {
			react(id, native);
			closeReactPicker();
		}).then((picker) => {
			if (!picker || popFor !== id) return;
			pop.replaceChildren(picker);
			pop.classList.add("expanded");
			pop.classList.remove("d-none");
			// Розмір пікера відомий після його першого малювання
			placePop();
			requestAnimationFrame(() => setTimeout(placePop, 30));
		});
	}
	document.addEventListener("mousedown", (e) => {
		if (popFor && !pop.contains(e.target) && !e.target.closest('[data-act="react"]')) closeReactPicker();
	});
	document.addEventListener("keydown", (e) => e.key === "Escape" && popFor && closeReactPicker());

	// Ліміт різних емодзі на повідомленні (сервер перевіряє так само)
	const reactionsFull = (m) => !!(m.reactions && m.reactions.length >= ((C.limits && C.limits.reactions) || 10));
	async function react(id, emoji) {
		const m = findMessage(id);
		if (m && reactionsFull(m) && !m.reactions.some((r) => r.emoji === emoji)) return notyf.error(t("reactions_limit", { n: m.reactions.length }));
		try {
			const r = await api(`/api/chat/messages/${id}/react/`, { emoji });
			const cur = findMessage(id);
			if (cur) {
				cur.reactions = r.reactions;
				rerender(cur);
			}
		} catch (e) {
			fail(e);
		}
	}
	function applyReactions(d) {
		const m = findMessage(d.id_message);
		if (!m) return;
		m.reactions = d.reactions.map((r) => Object.assign({}, r, { mine: r.users.includes(ME) }));
		rerender(m);
	}

	/**
	 * Довге натискання (телефон, планшет): fn(x, y, target) через 500 мс, якщо палець не зрушив більше ніж на 10 px.
	 * Після спрацювання дотик не стає кліком — інакше відпущений палець одразу натиснув би пункт щойно відкритого меню.
	 * accept(target) — чи починати відлік для цього елемента. fn може повернути false — "не спрацювало".
	 */
	function longPress(el, fn, accept = () => true) {
		let timer = null;
		let start = null;
		let fired = false;
		el.addEventListener(
			"touchstart",
			(e) => {
				fired = false;
				clearTimeout(timer);
				if (e.touches.length !== 1 || !accept(e.target)) return;
				const p = e.touches[0];
				start = { x: p.clientX, y: p.clientY, target: e.target };
				timer = setTimeout(() => {
					timer = null;
					if (fn(start.x, start.y, start.target) === false) return;
					fired = true;
					if (navigator.vibrate) navigator.vibrate(10);
				}, 500);
			},
			{ passive: true }
		);
		el.addEventListener(
			"touchmove",
			(e) => {
				if (!timer || !start) return;
				const p = e.touches[0];
				if (Math.abs(p.clientX - start.x) > 10 || Math.abs(p.clientY - start.y) > 10) {
					clearTimeout(timer);
					timer = null;
				}
			},
			{ passive: true }
		);
		el.addEventListener("touchend", (e) => {
			clearTimeout(timer);
			timer = null;
			if (fired && e.cancelable) e.preventDefault();
		});
		el.addEventListener("touchcancel", () => {
			clearTimeout(timer);
			timer = null;
		});
	}

	// ═══ КОНТЕКСТНЕ МЕНЮ ПОВІДОМЛЕННЯ (права кнопка, довге натискання) ═══
	const ctx = $("chat-ctx");
	let ctxFor = null; // { id, inThread }
	function menuItems(m, inThread) {
		const mine = m.id_user === ME;
		const isEvent = m.type === "event";
		const isRoot = inThread && TH.root && TH.root.id === m.id;
		const open = !S.room.archived;
		const tg = S.ctxTarget || {};
		return [
			tg.file ? ["download", "fa-solid fa-download", t("download")] : null,
			tg.link ? ["copy_link", "fa-solid fa-link", t("copy_link")] : null,
			tg.file || tg.link ? "-" : null,
			!isRoot && !isEvent && open ? ["reply", "fa-solid fa-reply", t("reply")] : null,
			!inThread && open ? ["thread", "fa-regular fa-comments", t("reply_thread")] : null,
			S.ctxSelection ? ["copy_sel", "fa-regular fa-copy", t("copy_selected")] : !isEvent && m.body ? ["copy", "fa-regular fa-copy", t("copy")] : null,
			mine && !isEvent && open ? ["edit", "fa-solid fa-pen", t("edit")] : null,
			!isEvent ? ["forward", "fa-solid fa-share", t("forward")] : null,
			!inThread && canPin() ? ["pin", "fa-solid fa-thumbtack", m.pinned ? t("unpin_message") : t("pin_message")] : null,
			"-",
			["remind", "fa-regular fa-clock", t("remind_me")],
			open ? ["task", "fa-regular fa-square-check", t("make_task")] : null,
			open && canDecide(m) ? ["decision", "fa-solid fa-gavel", m.decision ? t("decision_unmark") : t("decision_mark")] : null,
			m.reactions && m.reactions.length ? ["reactions", "fa-regular fa-face-smile", t("who_reacted", { n: m.reactions.reduce((a, r) => a + r.count, 0) })] : null,
			mine && S.room.type !== "notes" && !inThread ? ["readers", "fa-solid fa-check-double", t("readers")] : null,
			(mine || canModerate()) && !isRoot ? "-" : null,
			(mine || canModerate()) && !isRoot ? ["delete", "fa-regular fa-trash-can", t("delete"), true] : null,
		].filter(Boolean);
	}
	function openMenu(id, inThread, x, y) {
		const m = findMessage(id);
		if (!m || m.deleted || (m.type !== "text" && m.type !== "event")) return;
		closeReactPicker();
		ctxFor = { id, inThread };
		const items = menuItems(m, inThread)
			.filter((it, i, a) => it !== "-" || (i > 0 && a[i - 1] !== "-" && i < a.length - 1))
			.map((it) => (it === "-" ? '<li><hr class="dropdown-divider"></li>' : `<li><button class="dropdown-item${it[3] ? " text-danger" : ""}" data-ctx="${it[0]}"><i class="${it[1]} fa-fw me-2"></i>${esc(it[2])}</button></li>`))
			.join("");
		// Швидкі реакції — зверху, як у Telegram. Досягнуто ліміту різних емодзі — лише вже поставлені (можна приєднатися)
		const full = reactionsFull(m);
		const quickList = full ? m.reactions.map((r) => r.emoji) : QUICK.slice(0, 8);
		const quick = !S.room.archived ? `<li class="chat-ctx-react">${quickList.map((e) => `<button type="button" data-ctx-react="${esc(e)}">${esc(e)}</button>`).join("")}${full ? "" : `<button type="button" data-ctx="react" title="${esc(t("all_emoji"))}"><i class="fa-solid fa-chevron-down"></i></button>`}</li><li><hr class="dropdown-divider"></li>` : "";
		ctx.innerHTML = quick + items;
		showCtx(x, y);
	}
	function closeMenu() {
		ctx.classList.remove("show");
		ctxFor = null;
	}
	function showCtx(x, y) {
		ctx.classList.add("show");
		ctx.style.left = Math.max(8, Math.min(window.innerWidth - ctx.offsetWidth - 8, x)) + "px";
		ctx.style.top = Math.max(8, Math.min(window.innerHeight - ctx.offsetHeight - 8, y)) + "px";
	}
	/** Меню кнопки "надіслати" (як у Telegram): надіслати пізніше; позначки "терміново" і "потрібне підтвердження" */
	function openSendMenu(cmp, x, y) {
		if (!S.room || cmp.editing) return false;
		closeReactPicker();
		ctxFor = { send: cmp };
		const notes = S.room.type === "notes";
		const item = (kind, icon, label, on) => `<li><button class="dropdown-item d-flex align-items-center" data-ctx-send="${kind}"><i class="${icon} fa-fw me-2"></i><span class="me-3">${esc(label)}</span>${on ? '<i class="fa-solid fa-check text-primary ms-auto"></i>' : ""}</button></li>`;
		ctx.innerHTML = [
			item("later", "fa-regular fa-clock", t("send_later")),
			notes ? "" : '<li><hr class="dropdown-divider"></li>',
			notes ? "" : item("urgent", "fa-solid fa-circle-exclamation text-danger", t("urgent_toggle"), cmp.urgent),
			notes ? "" : item("ack", "fa-solid fa-circle-check text-success", t("ack_toggle"), cmp.ack),
		].join("");
		showCtx(x, y);
	}
	ctx.addEventListener("click", (e) => {
		if (!ctxFor) return;
		const sm = e.target.closest("[data-ctx-send]");
		if (sm && ctxFor.send) {
			const cmp = ctxFor.send;
			closeMenu();
			const kind = sm.dataset.ctxSend;
			if (kind === "later") return sendLater(cmp);
			cmp[kind] = !cmp[kind];
			if (cmp[kind]) notyf.open({ type: "info", message: kind === "urgent" ? t("urgent_hint", { n: C.urgent_per_day || 5 }) : t("ack_hint") });
			renderComposer(cmp);
			return cmp.input.focus();
		}
		const f = e.target.closest("[data-ctx-fmt]");
		if (f && ctxFor.format) {
			const cmp = ctxFor.format;
			closeMenu();
			return applyFormat(cmp, f.dataset.ctxFmt);
		}
		const { id, inThread } = ctxFor;
		const r = e.target.closest("[data-ctx-react]");
		if (r) {
			closeMenu();
			return react(id, r.dataset.ctxReact);
		}
		const b = e.target.closest("[data-ctx]");
		if (!b) return;
		closeMenu();
		const tg = S.ctxTarget || {};
		if (b.dataset.ctx === "download" && tg.file) return location.assign(tg.file + "?download=1");
		if (b.dataset.ctx === "copy_link" && tg.link) {
			if (navigator.clipboard) navigator.clipboard.writeText(tg.link).then(() => notyf.success(t("copied")));
			return;
		}
		// Повний вибір реакцій — біля самого повідомлення
		const anchor = (inThread ? tbox : box).querySelector(`.chat-msg[data-id="${id}"] .chat-bubble`) || b;
		runAct(b.dataset.ctx, id, inThread, anchor);
	});
	function onContext(e, inThread) {
		const msg = e.target.closest(".chat-msg");
		// Меню повідомлення — на будь-якому його місці (текст, фото, відео, файл, посилання); лише поля вводу — меню браузера
		if (!msg || e.target.closest("input, textarea")) return;
		e.preventDefault();
		const sel = window.getSelection();
		S.ctxSelection = sel && !sel.isCollapsed && msg.contains(sel.anchorNode) ? sel.toString() : "";
		S.ctxTarget = ctxTargetOf(e.target);
		openMenu(Number(msg.dataset.id), inThread, e.clientX, e.clientY);
	}
	/** На чому саме натиснули: файл (фото, відео, аудіо, документ) — "Завантажити", посилання — "Копіювати посилання" */
	function ctxTargetOf(el) {
		const media = el.closest("img, video, audio");
		const fileLink = el.closest(".chat-file a, .chat-imgs a");
		const file = (media && (media.currentSrc || media.getAttribute("src"))) || (fileLink && fileLink.getAttribute("href"));
		if (file && /^\/chat\/files\//.test(file.replace(location.origin, ""))) return { file: file.replace(location.origin, "").split("?")[0] };
		const a = el.closest(".chat-text a[href]");
		return a ? { link: a.href } : null;
	}
	box.addEventListener("contextmenu", (e) => onContext(e, false));
	tbox.addEventListener("contextmenu", (e) => onContext(e, true));
	// Довге натискання на телефоні — те саме меню, що й права кнопка
	[
		[box, false],
		[tbox, true],
	].forEach(([el, inThread]) =>
		longPress(
			el,
			(x, y, target) => {
				const msg = target.closest(".chat-msg");
				if (!msg) return false;
				S.ctxSelection = "";
				S.ctxTarget = ctxTargetOf(target);
				openMenu(Number(msg.dataset.id), inThread, x, y);
			},
			(target) => !!target.closest(".chat-msg") && !target.closest("button, input, textarea, label")
		)
	);
	document.addEventListener("mousedown", (e) => ctxFor && !ctx.contains(e.target) && closeMenu());
	document.addEventListener("keydown", (e) => e.key === "Escape" && ctxFor && closeMenu());
	window.addEventListener("resize", () => ctxFor && closeMenu());
	box.addEventListener("scroll", () => ctxFor && closeMenu());
	tbox.addEventListener("scroll", () => ctxFor && closeMenu());

	/** Хто поставив реакції — по кожному емодзі */
	function showReactions(m) {
		$("chat-readers-title").textContent = t("reactions_title");
		$("chat-readers-body").innerHTML = m.reactions
			.map((r) => `<div class="mb-3"><div class="fs-5 mb-1">${esc(r.emoji)} <small class="text-muted fs-6">${r.count}</small></div>${r.users.map((u) => `<div class="d-flex align-items-center gap-2 mb-2">${avatar(S.people.get(u) || { name: personName(u) }, "sm")}<span>${esc(personName(u))}</span></div>`).join("")}</div>`)
			.join("");
		bootstrap.Modal.getOrCreateInstance($("chat-readers")).show();
	}

	// ═══ ЗАКРІПЛЕНІ ═══════════════════════════════════════
	async function loadPins() {
		if (!S.room) return;
		const idRoom = S.room.id;
		try {
			const r = await api(`/api/chat/rooms/${idRoom}/pins/`);
			if (!S.room || S.room.id !== idRoom) return;
			S.pins = r.messages;
			S.pinIndex = 0;
			renderPins();
		} catch {
			S.pins = [];
			renderPins();
		}
	}
	function renderPins() {
		const bar = $("chat-pinbar");
		if (!S.pins.length) {
			bar.classList.add("d-none");
			return;
		}
		const m = S.pins[S.pinIndex % S.pins.length];
		const text = plain(m.body).slice(0, 160) || (m.files.length ? "📎 " + m.files[0].name : "");
		bar.innerHTML = `<i class="fa-solid fa-thumbtack text-primary"></i><button class="chat-pin-text" data-pin-goto="${m.id}"><strong>${esc(t("pinned"))}${S.pins.length > 1 ? ` ${(S.pinIndex % S.pins.length) + 1}/${S.pins.length}` : ""}</strong><span>${esc(text)}</span></button>${S.pins.length > 1 ? `<button class="btn btn-sm btn-light rounded-0" data-pin-list title="${esc(t("pinned_all"))}"><i class="fa-solid fa-list"></i></button>` : ""}`;
		bar.classList.remove("d-none");
	}
	$("chat-pinbar").addEventListener("click", (e) => {
		const g = e.target.closest("[data-pin-goto]");
		if (g) {
			gotoMessage(Number(g.dataset.pinGoto));
			// Наступний клік — до наступного закріпленого, як у месенджерах
			S.pinIndex = (S.pinIndex + 1) % S.pins.length;
			return renderPins();
		}
		if (e.target.closest("[data-pin-list]")) {
			$("chat-list-title").textContent = t("pinned_all");
			$("chat-list-body").innerHTML = `<div class="list-group rounded-0">${S.pins
				.map((m) => `<button class="list-group-item list-group-item-action" data-list-goto="${m.id}"><div class="d-flex justify-content-between small"><strong>${esc(m.author ? m.author.name : "")}</strong><span class="text-muted">${esc(F.full.format(new Date(m.date)))}</span></div><div class="text-truncate">${esc(plain(m.body).slice(0, 200)) || "📎"}</div></button>`)
				.join("")}</div>`;
			bootstrap.Modal.getOrCreateInstance($("chat-list")).show();
		}
	});

	// ═══ ПОЛЕ ВВОДУ (основне і в треді) ══════════════════

	function resetComposer(cmp) {
		cmp.uploads.forEach((u) => {
			if (u.xhr && !u.done) u.xhr.abort();
			if (u.thumb) window.URL.revokeObjectURL(u.thumb);
		});
		cmp.uploads = [];
		cmp.records = [];
		cmp.reply = cmp.editing = null;
		cmp.urgent = false;
		cmp.ack = false;
		cmp.map = new Map();
		cmp.input.value = "";
		stopRecording(cmp, false);
		hideMentions(cmp);
		autosize(cmp);
		renderUploads(cmp);
		renderComposer(cmp);
	}

	// Згадки: у полі "@Ім'я", у тексті для сервера — токен
	function toTokens(cmp, text) {
		let s = text;
		[...cmp.map.entries()]
			.sort((a, b) => b[0].length - a[0].length)
			.forEach(([display, token]) => {
				s = s.replace(new RegExp(`(^|[^\\p{L}\\p{N}_])${escRe(display)}(?![\\p{L}\\p{N}_])`, "gu"), (m, pre) => pre + token);
			});
		return s;
	}
	function fromTokens(cmp, body) {
		return String(body || "").replace(TOKEN, (m, name) => {
			cmp.map.set("@" + name, m);
			return "@" + name;
		});
	}

	// Висота поля — за текстом; смуга прокрутки — лише коли текст довший за максимум
	function autosize(cmp) {
		const max = cmp.thread ? 160 : 220;
		cmp.input.style.height = "auto";
		const h = cmp.input.scrollHeight + 2;
		cmp.input.style.height = Math.min(h, max) + "px";
		cmp.input.style.overflowY = h > max ? "auto" : "hidden";
		updateSend(cmp);
	}
	function renderComposer(cmp) {
		const m = cmp.reply || cmp.editing;
		if (m) {
			const author = m.author ? m.author.name : personName(m.id_user);
			cmp.ctx.innerHTML = `<i class="fa-solid ${cmp.editing ? "fa-pen" : "fa-reply"} text-primary"></i><div class="min-w-0 flex-grow-1"><div class="small fw-bold text-primary">${esc(cmp.editing ? t("editing") : t("reply_to", { name: author }))}</div><div class="small text-truncate">${esc(plain(m.body).slice(0, 140) || "📎")}</div></div><button class="btn-close btn-sm" data-ctx-close aria-label="${esc(t("cancel"))}"></button>`;
			cmp.ctx.classList.remove("d-none");
		} else cmp.ctx.classList.add("d-none");
		// У треді каналу оголошень відповідати може кожен (can.comment)
		const canPost = S.room && (cmp.thread ? S.room.can.post || S.room.can.comment : S.room.can.post);
		cmp.root.querySelector(".chat-write").classList.toggle("d-none", !canPost);
		const ro = cmp.root.querySelector(".chat-readonly");
		ro.classList.toggle("d-none", !!canPost);
		ro.textContent = S.room && S.room.archived ? t("readonly_archived") : t("readonly");
		// Під час правки — лише текст
		if (cmp.editing) cmp.urgent = cmp.ack = false;
		cmp.root.querySelectorAll("[data-poll], [data-checklist]").forEach((b) => b.closest("li").classList.toggle("d-none", !!cmp.editing));
		// Позначки наступного повідомлення (ставляться правою кнопкою на "надіслати"): терміново, потрібне підтвердження
		const flags = cmp.root.querySelector(".chat-flags");
		const flag = (kind, icon, label) => `<span class="badge rounded-0 chat-flag chat-flag-${kind}"><i class="${icon} me-1"></i>${esc(label)}<button type="button" class="btn-close btn-close-white ms-2" data-unflag="${kind}" aria-label="${esc(t("cancel"))}"></button></span>`;
		flags.innerHTML = (cmp.urgent ? flag("urgent", "fa-solid fa-circle-exclamation", t("urgent")) : "") + (cmp.ack ? flag("ack", "fa-solid fa-circle-check", t("ack_required")) : "");
		flags.classList.toggle("d-none", !canPost || !(cmp.urgent || cmp.ack));
		cmp.input.classList.toggle("chat-input-urgent", cmp.urgent);
		cmp.input.placeholder = cmp.urgent ? t("placeholder_urgent") : cmp.thread ? t("placeholder_thread") : t("placeholder");
		updateSend(cmp);
	}
	/**
	 * Як у Telegram: порожнє поле — кнопка голосового, є що надсилати — кнопка "надіслати".
	 * Без підтримки запису в браузері — завжди "надіслати".
	 */
	function updateSend(cmp) {
		const mic = cmp.root.querySelector(".chat-write .chat-mic");
		const filled = !!(cmp.editing || cmp.input.value.trim() || cmp.uploads.length || cmp.records.length);
		const voice = !!mic && !filled;
		if (mic) mic.classList.toggle("d-none", !voice);
		cmp.send.classList.toggle("d-none", voice);
	}
	function cancelContext(cmp) {
		if (cmp.editing) cmp.input.value = "";
		cmp.reply = cmp.editing = null;
		autosize(cmp);
		renderComposer(cmp);
	}

	function bindComposer(cmp) {
		cmp.ctx.addEventListener("click", (e) => e.target.closest("[data-ctx-close]") && cancelContext(cmp));
		cmp.input.addEventListener("input", () => {
			autosize(cmp);
			updateSend(cmp);
			if (!cmp.thread) {
				typing();
				scheduleDraft();
			}
			suggest(cmp);
		});
		cmp.input.addEventListener("click", () => suggest(cmp));
		cmp.input.addEventListener("blur", () => setTimeout(() => hideMentions(cmp), 150));
		// Права кнопка на виділеному тексті — форматування, як у Telegram
		cmp.input.addEventListener("contextmenu", (e) => {
			if (cmp.input.selectionStart === cmp.input.selectionEnd) return;
			e.preventDefault();
			openFormatMenu(cmp, e.clientX, e.clientY);
		});
		cmp.input.addEventListener("keydown", (e) => {
			// Ctrl+B, Ctrl+I, Ctrl+Shift+X (закреслений), Ctrl+Shift+M (моноширинний)
			if ((e.ctrlKey || e.metaKey) && !e.altKey) {
				const k = e.key.toLowerCase();
				const kind = !e.shiftKey && k === "b" ? "bold" : !e.shiftKey && k === "i" ? "italic" : e.shiftKey && k === "x" ? "strike" : e.shiftKey && k === "m" ? "code" : null;
				if (kind) {
					e.preventDefault();
					return format(cmp, kind);
				}
			}
			// Підказка "@" відкрита — стрілки, Enter і Tab керують нею
			if (cmp.items.length) {
				if (e.key === "ArrowDown" || e.key === "ArrowUp") {
					e.preventDefault();
					cmp.sel = (cmp.sel + (e.key === "ArrowDown" ? 1 : cmp.items.length - 1)) % cmp.items.length;
					return renderMentions(cmp);
				}
				if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) {
					e.preventDefault();
					return chooseMention(cmp, cmp.sel);
				}
				if (e.key === "Escape") {
					e.preventDefault();
					return hideMentions(cmp);
				}
			}
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				submit(cmp);
			} else if (e.key === "Escape" && (cmp.reply || cmp.editing)) {
				cancelContext(cmp);
			} else if (e.key === "ArrowUp" && !cmp.input.value) {
				// Стрілка вгору в порожньому полі — правити останнє своє
				const list = cmp.thread ? TH.replies : S.messages;
				const last = [...list].reverse().find((m) => m.id_user === ME && !m.deleted && m.type === "text");
				if (last) {
					e.preventDefault();
					cmp.editing = last;
					cmp.input.value = fromTokens(cmp, last.body || "");
					autosize(cmp);
					renderComposer(cmp);
				}
			}
		});
		cmp.send.addEventListener("click", () => {
			// Клік, що завершив довге натискання (меню вже відкрите), — не надсилання
			if (ctxFor && ctxFor.send === cmp) return;
			submit(cmp);
		});
		cmp.pop.addEventListener("mousedown", (e) => {
			const b = e.target.closest("[data-mi]");
			if (!b) return;
			e.preventDefault();
			chooseMention(cmp, Number(b.dataset.mi));
		});

		cmp.root.addEventListener("click", (e) => {
			const unflag = e.target.closest("[data-unflag]");
			if (unflag) {
				cmp[unflag.dataset.unflag] = false;
				return renderComposer(cmp);
			}
			if (e.target.closest("[data-poll]")) return makePoll(cmp);
			if (e.target.closest("[data-checklist]")) return makeChecklist(cmp);
			if (e.target.closest("[data-record]")) return pickRecord(cmp);
			if (e.target.closest("[data-voice]")) return toggleRecording(cmp);
			if (e.target.closest("[data-voice-cancel]")) return stopRecording(cmp, false);
			if (e.target.closest("[data-emoji]")) return toggleEmoji(cmp);
		});
		// Права кнопка (на телефоні — довге натискання) на "надіслати": надіслати пізніше, терміново, з підтвердженням
		cmp.send.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			openSendMenu(cmp, e.clientX, e.clientY);
		});
		longPress(cmp.send, (x, y) => openSendMenu(cmp, x, y));

		cmp.up.addEventListener("click", (e) => {
			const rec = e.target.closest("[data-unrec]");
			if (rec) {
				cmp.records = cmp.records.filter((r) => r.type + ":" + r.id !== rec.dataset.unrec);
				return renderUploads(cmp);
			}
			const b = e.target.closest("[data-unup]");
			if (!b) return;
			const i = cmp.uploads.findIndex((u) => u.key === b.dataset.unup);
			if (i >= 0) {
				if (cmp.uploads[i].xhr && !cmp.uploads[i].done) cmp.uploads[i].xhr.abort();
				if (cmp.uploads[i].thumb) window.URL.revokeObjectURL(cmp.uploads[i].thumb);
				cmp.uploads.splice(i, 1);
			}
			renderUploads(cmp);
		});
		// "Фото або відео" — стискаються й очищуються від метаданих; "Файл" — оригінал без змін, як вкладення
		cmp.root.querySelectorAll("input[type=file]").forEach((inp) =>
			inp.addEventListener("change", (e) => {
				addFiles(cmp, [...e.target.files], { asFile: inp.dataset.as === "file" });
				e.target.value = "";
			})
		);
		cmp.input.addEventListener("paste", (e) => {
			const items = [...((e.clipboardData && e.clipboardData.files) || [])];
			if (items.length) {
				e.preventDefault();
				addFiles(
					cmp,
					items.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `screenshot-${Date.now()}-${i + 1}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type })))
				);
			}
		});
	}

	// Форматування: обгорнути виділене
	const FMT = { bold: ["**", "**"], italic: ["_", "_"], strike: ["~~", "~~"], code: ["`", "`"] };
	// Меню форматування виділеного тексту (те саме вікно, що й контекстне меню повідомлення)
	function openFormatMenu(cmp, x, y) {
		closeReactPicker();
		ctxFor = { format: cmp };
		const item = (kind, icon, label, keys) => `<li><button class="dropdown-item d-flex align-items-center" data-ctx-fmt="${kind}"><i class="${icon} fa-fw me-2"></i><span class="me-4">${esc(label)}</span>${keys ? `<small class="text-muted ms-auto">${keys}</small>` : ""}</button></li>`;
		ctx.innerHTML = [
			`<li><button class="dropdown-item" data-ctx-fmt="cut"><i class="fa-solid fa-scissors fa-fw me-2"></i>${esc(t("cut"))}</button></li>`,
			`<li><button class="dropdown-item" data-ctx-fmt="copy"><i class="fa-regular fa-copy fa-fw me-2"></i>${esc(t("copy"))}</button></li>`,
			navigator.clipboard && navigator.clipboard.readText ? `<li><button class="dropdown-item" data-ctx-fmt="paste"><i class="fa-regular fa-paste fa-fw me-2"></i>${esc(t("paste"))}</button></li>` : "",
			'<li><hr class="dropdown-divider"></li>',
			item("bold", "fa-solid fa-bold", t("fmt_bold"), "Ctrl+B"),
			item("italic", "fa-solid fa-italic", t("fmt_italic"), "Ctrl+I"),
			item("strike", "fa-solid fa-strikethrough", t("fmt_strike"), "Ctrl+Shift+X"),
			item("code", "fa-solid fa-code", t("fmt_code"), "Ctrl+Shift+M"),
			item("quote", "fa-solid fa-quote-right", t("fmt_quote")),
			item("list", "fa-solid fa-list-ul", t("fmt_list")),
			'<li><hr class="dropdown-divider"></li>',
			item("clear", "fa-solid fa-text-slash", t("fmt_clear")),
		].join("");
		showCtx(x, y);
	}
	function applyFormat(cmp, kind) {
		const input = cmp.input;
		const { selectionStart: a, selectionEnd: z, value } = input;
		const sel = value.slice(a, z);
		if (kind === "copy" || kind === "cut") {
			if (navigator.clipboard) navigator.clipboard.writeText(sel);
			if (kind === "cut") input.setRangeText("", a, z, "end");
		} else if (kind === "paste") {
			navigator.clipboard
				.readText()
				.then((text) => {
					input.setRangeText(text, a, z, "end");
					input.focus();
					autosize(cmp);
					updateSend(cmp);
				})
				.catch(() => {});
			return;
		} else if (kind === "clear") {
			// Прибрати розмітку з виділеного
			input.setRangeText(
				sel
					.replace(/```\n?([\s\S]*?)\n?```/g, "$1")
					.replace(/\*\*([^*]+)\*\*/g, "$1")
					.replace(/~~([^~]+)~~/g, "$1")
					.replace(/`([^`]+)`/g, "$1")
					.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2")
					.replace(/^(?:> |- )/gm, ""),
				a,
				z,
				"select"
			);
		} else return format(cmp, kind);
		input.focus();
		autosize(cmp);
	}

	function format(cmp, kind) {
		const input = cmp.input;
		const { selectionStart: a, selectionEnd: z, value } = input;
		const sel = value.slice(a, z);
		let text;
		if (kind === "quote" || kind === "list") {
			const mark = kind === "quote" ? "> " : "- ";
			text = (sel || "")
				.split("\n")
				.map((l) => mark + l)
				.join("\n");
		} else if (kind === "code" && sel.includes("\n")) text = "```\n" + sel + "\n```";
		else text = FMT[kind][0] + sel + FMT[kind][1];
		// Без виділення: курсор після "> " / "- " або між знаками розмітки — щоб одразу писати
		input.setRangeText(text, a, z, "end");
		if (!sel && FMT[kind] && !(kind === "code" && sel.includes("\n"))) input.setSelectionRange(a + FMT[kind][0].length, a + FMT[kind][0].length);
		// Цитата / список у середині рядка — з нового рядка
		if ((kind === "quote" || kind === "list") && a > 0 && value[a - 1] !== "\n") {
			input.setRangeText("\n", a, a, "end");
			input.setSelectionRange(a + 1 + text.length, a + 1 + text.length);
		}
		input.focus();
		autosize(cmp);
	}


	// ─── Підказка "@" ───
	async function mentionData() {
		if (S.mentionData && S.mentionData.room === S.room.id) return S.mentionData;
		const idRoom = S.room.id;
		const r = await api(`/api/chat/rooms/${idRoom}/mentions/`);
		S.mentionData = Object.assign(r, { room: idRoom });
		rememberPeople(r.people);
		return S.mentionData;
	}
	const cleanName = (s) => String(s || "").replace(/[\]\n]/g, " ").trim().slice(0, 100);
	async function suggest(cmp) {
		if (!cmp.editing && suggestCommands(cmp)) return;
		cmp.cmd = false;
		const caret = cmp.input.selectionStart;
		const before = cmp.input.value.slice(0, caret);
		const m = before.match(/(?:^|\s)@([^\s@]{0,40})$/u);
		if (!m || !S.room || S.room.type === "notes") return hideMentions(cmp);
		cmp.at = caret - m[1].length - 1;
		let data;
		try {
			data = await mentionData();
		} catch {
			return hideMentions(cmp);
		}
		const q = m[1].toLowerCase();
		const hit = (name) => !q || name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || name.toLowerCase().includes(q);
		const items = [];
		if (data.all && hit(t("mention_all_name"))) items.push({ token: `@[${cleanName(t("mention_all_name"))}](all)`, label: t("mention_all_name"), sub: t("mention_all_hint"), icon: "fa-solid fa-users" });
		data.people.filter((p) => hit(p.name)).forEach((p) => items.push({ token: `@[${cleanName(p.name)}](u:${p.id})`, label: p.name, sub: p.position || "", person: p }));
		data.departments.filter((d) => hit(d.name)).forEach((d) => items.push({ token: `@[${cleanName(d.name)}](d:${d.id})`, label: d.name, sub: t("mention_department"), icon: "fa-solid fa-sitemap" }));
		data.offices.filter((o) => hit(o.name)).forEach((o) => items.push({ token: `@[${cleanName(o.name)}](o:${o.id})`, label: o.name, sub: t("mention_office"), icon: "fa-solid fa-building" }));
		cmp.items = items.slice(0, 8);
		cmp.sel = 0;
		renderMentions(cmp);
	}
	function renderMentions(cmp) {
		if (!cmp.items.length) return hideMentions(cmp);
		cmp.pop.innerHTML = cmp.items
			.map(
				(it, i) =>
					`<button type="button" class="chat-mi${i === cmp.sel ? " active" : ""}" data-mi="${i}">${it.person ? avatar(it.person, "sm") : `<span class="chat-ava chat-ava-icon sm"><i class="${it.icon}"></i></span>`}<span class="min-w-0"><span class="d-block text-truncate">${esc(it.label)}</span>${it.sub ? `<small class="text-muted d-block text-truncate">${esc(it.sub)}</small>` : ""}</span></button>`
			)
			.join("");
		cmp.pop.classList.remove("d-none");
	}
	function hideMentions(cmp) {
		cmp.items = [];
		cmp.pop.classList.add("d-none");
	}
	function chooseMention(cmp, i) {
		const it = cmp.items[i];
		if (!it) return;
		if (it.command) {
			cmp.input.value = "/" + it.command + " ";
			cmp.input.setSelectionRange(cmp.input.value.length, cmp.input.value.length);
			hideMentions(cmp);
			return cmp.input.focus();
		}
		const display = "@" + cleanName(it.label);
		const caret = cmp.input.selectionStart;
		cmp.input.setRangeText(display + " ", cmp.at, caret, "end");
		cmp.map.set(display, it.token);
		hideMentions(cmp);
		cmp.input.focus();
		autosize(cmp);
	}

	// "друкує…"
	let lastTypingSent = 0;
	function typing() {
		if (!S.room || !SOCK || Date.now() - lastTypingSent < 2500 || !MAIN.input.value.trim()) return;
		lastTypingSent = Date.now();
		SOCK.emit("chat:typing", { id_room: S.room.id });
	}
	function renderTyping() {
		const names = [...S.typing.keys()].map(personName);
		$("chat-typing").textContent = names.length ? (names.length > 2 ? t("typing_many", { n: names.length }) : t("typing", { names: names.join(", ") })) : "";
	}

	// Чернетка (основне поле): зберігаємо за 1 с після останньої зміни і при переході в інший чат
	function scheduleDraft() {
		clearTimeout(S.draftTimer);
		S.draftTimer = setTimeout(saveDraftNow, 1000);
	}
	function saveDraftNow() {
		clearTimeout(S.draftTimer);
		if (!S.room || MAIN.editing) return;
		const r = S.byId.get(S.room.id);
		const text = toTokens(MAIN, MAIN.input.value);
		if (!r || (r.draft || "") === text) return;
		r.draft = text || null;
		api(`/api/chat/rooms/${S.room.id}/draft/`, { text }).catch(() => {});
	}
	window.addEventListener("beforeunload", saveDraftNow);

	/** Дані для надсилання з поля; null — нічого надсилати або ще вантажаться файли */
	function collect(cmp) {
		const raw = cmp.input.value;
		if (cmp.uploads.some((u) => !u.done && !u.error)) {
			notyf.error(t("wait_uploads"));
			return null;
		}
		const files = cmp.uploads.filter((u) => u.done).map((u) => u.data.id);
		const records = cmp.records.map((r) => ({ type: r.type, id: r.id }));
		if (!raw.trim() && !files.length && !records.length) return null;
		const body = toTokens(cmp, raw);
		if (body.length > C.limits.body) {
			notyf.error(t("too_long", { n: C.limits.body }));
			return null;
		}
		return { body: body.trim() ? body : null, files, records, ack: cmp.ack, id_reply: cmp.reply ? cmp.reply.id : null, id_thread: cmp.thread ? TH.id : null, urgent: cmp.urgent, client_id: uuid() };
	}
	function clearAfterSend(cmp) {
		cmp.input.value = "";
		cmp.reply = cmp.editing = null;
		cmp.uploads.forEach((u) => u.thumb && window.URL.revokeObjectURL(u.thumb));
		cmp.uploads = [];
		cmp.records = [];
		cmp.urgent = false;
		cmp.ack = false;
		cmp.map = new Map();
		autosize(cmp);
		renderUploads(cmp);
		renderComposer(cmp);
	}

	async function submit(cmp) {
		if (!S.room || (cmp.thread && !TH.id)) return;
		if (cmp.rec) return stopRecording(cmp, true);
		// Команда ("/task …"); "//текст" — надіслати як звичайний текст, що починається з "/"
		if (!cmp.editing && !cmp.uploads.length && !cmp.records.length) {
			const raw = cmp.input.value.trim();
			if (raw.startsWith("//")) cmp.input.value = cmp.input.value.replace(/^\s*\//, "");
			else if (raw.startsWith("/")) {
				const parsed = parseCommand(raw);
				if (parsed) return runCommand(cmp, parsed);
			}
		}
		cmp.send.disabled = true;
		try {
			if (cmp.editing) {
				const body = toTokens(cmp, cmp.input.value);
				if (body.length > C.limits.body) return notyf.error(t("too_long", { n: C.limits.body }));
				upsertMessage((await api(`/api/chat/messages/${cmp.editing.id}/edit/`, { body })).message);
			} else {
				const data = collect(cmp);
				if (!data) return;
				const r = await api(`/api/chat/rooms/${S.room.id}/send/`, { data });
				onMessage(r.message);
				if (cmp.thread) scrollBottom(tbox);
				else scrollBottom();
			}
			clearAfterSend(cmp);
			renderRooms();
		} catch (e) {
			fail(e);
		} finally {
			cmp.send.disabled = false;
			cmp.input.focus();
		}
	}

	// ═══ ВІДКЛАДЕНЕ НАДСИЛАННЯ Й НАГАДУВАННЯ ════════════
	/**
	 * Вибір моменту в поясі людини. hint — функція (Date) → рядок під полем (наприклад, час у співрозмовника).
	 * Повертає { date, note } або null (скасовано).
	 */
	function askWhen({ title, ok, withNote = false, withNoReply = false, hint = null, presets }) {
		return new Promise((resolve) => {
			const modal = $("chat-when");
			const input = $("chat-when-at");
			const noteEl = $("chat-when-note");
			let done = false;
			$("chat-when-title").textContent = title;
			$("chat-when-ok").textContent = ok;
			$("chat-when-tz").textContent = TZ ? t("in_your_timezone", { tz: zoneCity(TZ) }) : "";
			noteEl.value = "";
			noteEl.closest(".mb-2").classList.toggle("d-none", !withNote);
			const noReply = $("chat-when-noreply");
			noReply.checked = false;
			noReply.closest(".form-check").classList.toggle("d-none", !withNoReply);
			const now = new Date();
			input.min = dateToWall(now);
			input.value = dateToWall(new Date(Math.ceil((now.getTime() + 3600e3) / 900e3) * 900e3));
			// Без минулих і без повторів (у неділю "завтра" і "у понеділок" — той самий момент)
			const list = presets.filter((p, i) => p.date && p.date.getTime() > now.getTime() + 60e3 && presets.findIndex((x) => x.date && x.date.getTime() === p.date.getTime()) === i);
			$("chat-when-presets").innerHTML = list.map((p, i) => `<button type="button" class="btn btn-sm btn-outline-secondary rounded-0" data-preset="${i}">${esc(p.label)}<small class="d-block text-muted">${esc(F.when.format(p.date))}</small></button>`).join("");
			const showHint = () => {
				const d = wallToDate(input.value);
				$("chat-when-hint").textContent = d && hint ? hint(d) : "";
			};
			showHint();
			input.oninput = showHint;
			const finish = (value) => {
				if (done) return;
				done = true;
				resolve(value);
				bootstrap.Modal.getOrCreateInstance(modal).hide();
			};
			$("chat-when-presets").onclick = (e) => {
				const b = e.target.closest("[data-preset]");
				if (b) finish({ date: list[Number(b.dataset.preset)].date, note: noteEl.value.trim() || null, noReply: noReply.checked });
			};
			$("chat-when-ok").onclick = () => {
				const d = wallToDate(input.value);
				if (!d || d.getTime() < Date.now() + 60e3) {
					input.classList.add("is-invalid");
					return;
				}
				input.classList.remove("is-invalid");
				finish({ date: d, note: noteEl.value.trim() || null, noReply: noReply.checked });
			};
			modal.addEventListener("hidden.bs.modal", () => finish(null), { once: true });
			bootstrap.Modal.getOrCreateInstance(modal).show();
		});
	}
	const nextMonday = () => {
		const wd = zoneParts(new Date(), TZ).wd;
		return wallAt(((8 - wd) % 7) || 7, 9);
	};

	// Час у адресатів на момент надсилання (особистий чат — співрозмовник; група — різні пояси учасників)
	function recipientsHint(date) {
		if (!S.room) return "";
		if (S.room.type === "direct") {
			const p = partnerOf(S.room);
			if (!p || !p.timezone || p.timezone === TZ) return "";
			return t("their_time", { name: p.name, time: timeAt(p.timezone, date, { weekday: "short", hour: "2-digit", minute: "2-digit" }) });
		}
		const zones = [...new Set(S.room.members.map((m) => (S.people.get(m.id) || {}).timezone).filter((z) => z && z !== TZ))].slice(0, 4);
		if (!zones.length) return "";
		return t("members_time", { list: zones.map((z) => zoneCity(z) + " " + timeAt(z, date, { hour: "2-digit", minute: "2-digit" })).join(" · ") });
	}

	async function sendLater(cmp) {
		if (!S.room || cmp.editing) return;
		if (cmp.ack) return notyf.error(t("later_no_ack"));
		const data = collect(cmp);
		if (!data) return notyf.error(t("later_empty"));
		const w = await askWhen({
			title: t("send_later"),
			ok: t("schedule"),
			hint: recipientsHint,
			presets: [
				{ label: t("in_1h"), date: new Date(Date.now() + 3600e3) },
				{ label: t("today_at", { time: "18:00" }), date: wallAt(0, 18) },
				{ label: t("tomorrow_at", { time: "09:00" }), date: wallAt(1, 9) },
				{ label: t("monday_at", { time: "09:00" }), date: nextMonday() },
			],
		});
		if (!w) return;
		try {
			data.send_at = w.date.toISOString();
			await api(`/api/chat/rooms/${S.room.id}/send/`, { data });
			clearAfterSend(cmp);
			if (!cmp.thread) saveDraftNow();
			notyf.success(t("scheduled_ok", { time: F.when.format(w.date) }));
			loadScheduled();
		} catch (e) {
			fail(e);
		}
	}

	async function loadScheduled() {
		if (!S.room) return;
		try {
			const r = await api(`/api/chat/rooms/${S.room.id}/scheduled/`);
			S.scheduled = r.scheduled;
		} catch {
			S.scheduled = [];
		}
		const b = $("chat-scheduled-btn");
		b.classList.toggle("d-none", !S.scheduled.length);
		b.querySelector("span").textContent = S.scheduled.length;
		b.classList.toggle("text-danger", S.scheduled.some((s) => s.status === "failed"));
	}
	function scheduledRow(s, withRoom) {
		const text = plain(s.body).slice(0, 200) || (s.files.length ? "📎 " + t("file") : "");
		const status = s.status === "failed" ? `<span class="text-danger">${esc(t("scheduled_failed_short"))}${s.error_text ? ": " + esc(s.error_text) : ""}</span>` : esc(F.when.format(new Date(s.send_at)));
		return `<div class="list-group-item d-flex gap-2 align-items-start"><div class="min-w-0 flex-grow-1"><div class="small text-muted">${withRoom && s.room_name ? esc(s.room_name) + " · " : ""}${status}${s.urgent ? ` · <span class="text-danger">${esc(t("urgent"))}</span>` : ""}${s.id_thread ? " · " + esc(t("in_thread")) : ""}</div><div class="text-truncate">${esc(text)}</div></div><button class="btn btn-sm btn-light rounded-0" data-send-now="${s.id}" title="${esc(t("send_now"))}"><i class="fa-solid fa-paper-plane"></i></button><button class="btn btn-sm btn-light rounded-0" data-resched="${s.id}" title="${esc(t("change_time"))}"><i class="fa-regular fa-clock"></i></button><button class="btn btn-sm btn-light rounded-0 text-danger" data-unsched="${s.id}" title="${esc(t("cancel"))}"><i class="fa-regular fa-trash-can"></i></button></div>`;
	}
	function showScheduled() {
		$("chat-list-title").textContent = t("scheduled_title");
		$("chat-list-body").innerHTML = S.scheduled.length ? `<div class="list-group rounded-0">${S.scheduled.map((s) => scheduledRow(s, false)).join("")}</div>` : `<div class="text-muted small">${esc(t("scheduled_none"))}</div>`;
		bootstrap.Modal.getOrCreateInstance($("chat-list")).show();
	}
	$("chat-scheduled-btn").addEventListener("click", showScheduled);

	// ─── Нагадування ───
	async function remindAbout(m) {
		const w = await askWhen({
			title: t("remind_me"),
			ok: t("remind_set"),
			withNote: true,
			// "Якщо не відповіли" — для власних повідомлень (чекаю відповіді)
			withNoReply: m.id_user === ME,
			presets: [
				{ label: t("in_20m"), date: new Date(Date.now() + 20 * 60e3) },
				{ label: t("in_1h"), date: new Date(Date.now() + 3600e3) },
				{ label: t("in_3h"), date: new Date(Date.now() + 3 * 3600e3) },
				{ label: t("tomorrow_at", { time: "09:00" }), date: wallAt(1, 9) },
				{ label: t("monday_at", { time: "09:00" }), date: nextMonday() },
			],
		});
		if (!w) return;
		try {
			await api(`/api/chat/messages/${m.id}/remind/`, { remind_at: w.date.toISOString(), note: w.note, if_no_reply: !!w.noReply });
			notyf.success(t("remind_ok", { time: F.when.format(w.date) }));
		} catch (e) {
			fail(e);
		}
	}
	async function showReminders() {
		try {
			const [rem, sch] = await Promise.all([api("/api/chat/reminders/"), api("/api/chat/scheduled/")]);
			const rows = rem.reminders
				.map(
					(x) =>
						`<div class="list-group-item d-flex gap-2 align-items-start"><button class="btn btn-link p-0 text-start text-reset text-decoration-none min-w-0 flex-grow-1" data-list-goto="${x.id_message}" data-room="${x.id_room}"><div class="small text-muted">${esc(F.when.format(new Date(x.remind_at)))}${x.room_name ? " · " + esc(x.room_name) : ""}</div>${x.note ? `<div class="fw-semibold text-truncate">${esc(x.note)}</div>` : ""}<div class="text-truncate small">${esc(String(x.body || "").slice(0, 200)) || (x.has_files ? "📎" : "")}</div></button><button class="btn btn-sm btn-light rounded-0 text-danger" data-unremind="${x.id}" title="${esc(t("cancel"))}"><i class="fa-regular fa-trash-can"></i></button></div>`
				)
				.join("");
			S.allScheduled = sch.scheduled;
			$("chat-list-title").textContent = t("reminders_title");
			$("chat-list-body").innerHTML =
				`<h6 class="small text-uppercase text-muted">${esc(t("reminders"))}</h6>` +
				(rows ? `<div class="list-group rounded-0 mb-3">${rows}</div>` : `<div class="text-muted small mb-3">${esc(t("reminders_none"))}</div>`) +
				`<h6 class="small text-uppercase text-muted">${esc(t("scheduled_title"))}</h6>` +
				(sch.scheduled.length ? `<div class="list-group rounded-0">${sch.scheduled.map((s) => scheduledRow(s, true)).join("")}</div>` : `<div class="text-muted small">${esc(t("scheduled_none"))}</div>`);
			bootstrap.Modal.getOrCreateInstance($("chat-list")).show();
		} catch (e) {
			fail(e);
		}
	}
	$("chat-list-body").addEventListener("click", async (e) => {
		const go = e.target.closest("[data-list-goto]");
		if (go) {
			bootstrap.Modal.getOrCreateInstance($("chat-list")).hide();
			const idRoom = go.dataset.room ? Number(go.dataset.room) : S.room && S.room.id;
			if (S.room && S.room.id === idRoom) return gotoMessage(Number(go.dataset.listGoto));
			return openRoom(idRoom, { around: Number(go.dataset.listGoto) });
		}
		try {
			const un = e.target.closest("[data-unremind]");
			if (un) {
				await api(`/api/chat/reminders/${un.dataset.unremind}/cancel/`);
				un.closest(".list-group-item").remove();
				return;
			}
			const sn = e.target.closest("[data-send-now]");
			if (sn) {
				sn.disabled = true;
				await api(`/api/chat/scheduled/${sn.dataset.sendNow}/send-now/`);
				sn.closest(".list-group-item").remove();
				notyf.success(t("sent_now"));
				return loadScheduled();
			}
			const us = e.target.closest("[data-unsched]");
			if (us) {
				if (!(await ask({ title: t("cancel"), text: t("confirm_unschedule"), ok: t("confirm_yes"), danger: true }))) return;
				await api(`/api/chat/scheduled/${us.dataset.unsched}/cancel/`);
				us.closest(".list-group-item").remove();
				return loadScheduled();
			}
			const rs = e.target.closest("[data-resched]");
			if (rs) {
				bootstrap.Modal.getOrCreateInstance($("chat-list")).hide();
				const w = await askWhen({ title: t("change_time"), ok: t("schedule"), hint: recipientsHint, presets: [{ label: t("in_1h"), date: new Date(Date.now() + 3600e3) }, { label: t("tomorrow_at", { time: "09:00" }), date: wallAt(1, 9) }] });
				if (!w) return;
				await api(`/api/chat/scheduled/${rs.dataset.resched}/reschedule/`, { send_at: w.date.toISOString() });
				notyf.success(t("scheduled_ok", { time: F.when.format(w.date) }));
				return loadScheduled();
			}
		} catch (err) {
			fail(err);
		}
	});

	// ═══ ЗАДАЧІ З ПОВІДОМЛЕНЬ ════════════════════════════
	/**
	 * Задача в календар: з повідомлення (m) або з чату (команда /task, m = null, title — текст команди).
	 * Виконавець — я або учасник чату; час — у моєму часовому поясі.
	 */
	function makeTask(m, title = "") {
		if (!S.room) return;
		const modal = $("chat-task");
		const form = $("chat-task-form");
		form.reset();
		const text = m ? (m.type === "event" ? eventTitle(m.data) : plain(m.body)) : title;
		form.title.value = (m ? text.split("\n")[0] : title).slice(0, 200);
		form.description.value = m && m.type !== "event" ? tokenPlain(m.body || "") : "";
		const people = S.room.members.filter((x) => x.id !== ME).map((x) => S.people.get(x.id) || x);
		form.id_user.innerHTML = `<option value="${ME}">${esc(t("task_me"))}</option>` + people.map((p) => `<option value="${p.id}">${esc(p.name || t("deleted_user"))}</option>`).join("");
		form.id_user.value = String(ME);
		// Якщо повідомлення адресоване одній людині (особистий чат) — пропонуємо її
		if (S.room.type === "direct" && m && m.id_user === ME && people[0]) form.id_user.value = String(people[0].id);
		const now = new Date();
		form.start.min = dateToWall(new Date(now.getTime() - 3600e3));
		form.start.value = dateToWall(wallAt(1, 9));
		const presets = [
			{ label: t("in_1h"), date: new Date(Math.ceil((now.getTime() + 3600e3) / 900e3) * 900e3) },
			{ label: t("today_at", { time: "18:00" }), date: wallAt(0, 18) },
			{ label: t("tomorrow_at", { time: "09:00" }), date: wallAt(1, 9) },
			{ label: t("monday_at", { time: "09:00" }), date: nextMonday() },
		].filter((p, i, a) => p.date.getTime() > now.getTime() && a.findIndex((x) => x.date.getTime() === p.date.getTime()) === i);
		$("chat-task-presets").innerHTML = presets.map((p) => `<button type="button" class="btn btn-sm btn-outline-secondary rounded-0" data-at="${esc(dateToWall(p.date))}">${esc(p.label)}</button>`).join("");
		$("chat-task-presets").onclick = (e) => {
			const b = e.target.closest("[data-at]");
			if (b) form.start.value = b.dataset.at;
		};
		$("chat-task-tz").textContent = TZ ? t("in_your_timezone", { tz: zoneCity(TZ) }) : "";
		form.onsubmit = async (e) => {
			e.preventDefault();
			const at = wallToDate(form.start.value);
			if (!form.title.value.trim()) return form.title.classList.add("is-invalid");
			if (!at) return form.start.classList.add("is-invalid");
			const btn = form.querySelector("[type=submit]");
			btn.disabled = true;
			try {
				const data = { title: form.title.value.trim(), id_user: Number(form.id_user.value), start: at.toISOString(), description: form.description.value.trim() || null };
				const r = await api(m ? `/api/chat/messages/${m.id}/task/` : `/api/chat/rooms/${S.room.id}/task/`, data);
				bootstrap.Modal.getOrCreateInstance(modal).hide();
				const n = notyf.success(t("task_ok", { time: F.when.format(at) }));
				// Свою задачу можна одразу відкрити в календарі
				if (data.id_user === ME && n && n.on) n.on("click", () => window.top.location.assign(r.url));
			} catch (err) {
				fail(err);
			} finally {
				btn.disabled = false;
			}
		};
		bootstrap.Modal.getOrCreateInstance(modal).show();
		setTimeout(() => form.title.focus(), 300);
	}

	// ═══ КАРТКИ ЗАПИСІВ: вибір і "обговорити з колегою" ═══
	let recordFor = null; // поле вводу, куди додаємо картку
	function pickRecord(cmp, q = "") {
		recordFor = cmp;
		$("chat-record-q").value = q;
		$("chat-record-list").innerHTML = `<div class="text-muted small p-2">${esc(t("record_search_hint"))}</div>`;
		bootstrap.Modal.getOrCreateInstance($("chat-record")).show();
		setTimeout(() => $("chat-record-q").focus(), 300);
		if (q) searchRecords();
	}
	let recordTimer = null;
	let recordFound = [];
	async function searchRecords() {
		const q = $("chat-record-q").value.trim();
		if (q.length < 2) return;
		try {
			recordFound = (await api("/api/chat/records/search/", { q })).records;
			$("chat-record-list").innerHTML = recordFound.length
				? recordFound.map((c, i) => `<button type="button" class="list-group-item list-group-item-action p-1" data-pick-rec="${i}">${cardHtml(Object.assign({}, c, { url: "#" })).replace(/^<a /, "<span ").replace(/<\/a>$/, "</span>")}</button>`).join("")
				: `<div class="text-muted small p-2">${esc(t("nothing_found"))}</div>`;
		} catch (e) {
			fail(e);
		}
	}
	$("chat-record-q").addEventListener("input", () => {
		clearTimeout(recordTimer);
		recordTimer = setTimeout(searchRecords, 300);
	});
	$("chat-record-list").addEventListener("click", (e) => {
		const b = e.target.closest("[data-pick-rec]");
		if (!b || !recordFor) return;
		e.preventDefault();
		const c = recordFound[Number(b.dataset.pickRec)];
		if (c && !recordFor.records.some((r) => r.type === c.type && r.id === c.id)) {
			if (recordFor.records.length >= 5) return notyf.error(t("records_max"));
			recordFor.records.push(c);
			renderUploads(recordFor);
		}
		bootstrap.Modal.getOrCreateInstance($("chat-record")).hide();
		recordFor.input.focus();
	});

	// Поділитися записом зі сторінки запису (кнопка "Обговорити" в шапці панелі чату → root.chatApi.share)
	async function shareRecord(rec) {
		pick.mode = "share";
		pick.record = rec;
		pick.selected = new Set();
		$("chat-pick-search").value = "";
		$("chat-pick-search").classList.remove("d-none");
		$("chat-pick-title").textContent = t("share_title");
		$("chat-pick-ok").textContent = t("send");
		$("chat-pick-ok").classList.remove("d-none");
		$("chat-pick-form").innerHTML = `<div id="${PFX}cp-record" class="mb-2"></div><textarea class="form-control rounded-0 mb-2" id="${PFX}cp-comment" rows="2" maxlength="${C.limits.body}" placeholder="${esc(t("share_comment"))}"></textarea>`;
		pick.list = S.rooms.filter((r) => !r.archived);
		renderPick();
		pickModal().show();
		try {
			const r = await api("/api/chat/records/search/", { q: String(rec.id) });
			const c = r.records.find((x) => x.type === rec.type && x.id === rec.id);
			$("cp-record").innerHTML = c ? cardHtml(c) : "";
		} catch {
			/* картка необов'язкова — поділитися можна й без попереднього перегляду */
		}
	}

	// ═══ ПОДІЇ СИСТЕМИ В КАНАЛІ (панель інформації) ══════
	async function renderSubscriptions() {
		const el = $("chat-info-subs");
		if (!el) return;
		const room = S.room;
		if (!room || room.type === "direct" || room.type === "notes") return (el.innerHTML = "");
		let r;
		try {
			r = await api(`/api/chat/rooms/${room.id}/subscriptions/`);
		} catch {
			return (el.innerHTML = "");
		}
		if (!S.room || S.room.id !== room.id) return;
		if (!r.can_edit && !r.subscriptions.length) return (el.innerHTML = "");
		const have = new Map(r.subscriptions.map((x) => [x.source, new Set(x.events)]));
		const sources = r.can_edit ? r.sources : r.subscriptions.map((x) => ({ source: x.source, events: x.events }));
		el.innerHTML =
			`<div class="small fw-semibold mb-1"><i class="fa-solid fa-bolt text-warning me-1"></i>${esc(t("events_title"))}</div>` +
			(r.can_edit ? `<div class="small text-muted mb-2">${esc(t("events_hint"))}</div>` : "") +
			sources
				.map(
					(src) =>
						`<details class="chat-subs mb-1"${have.has(src.source) ? " open" : ""}><summary>${esc(t("source_" + src.source))}${have.has(src.source) ? ` <span class="badge text-bg-primary rounded-pill">${have.get(src.source).size}</span>` : ""}</summary><div class="chat-subs-list" data-source="${src.source}">${src.events
							.map((ev) => `<label class="form-check small mb-0"><input class="form-check-input" type="checkbox" value="${ev}"${have.has(src.source) && have.get(src.source).has(ev) ? " checked" : ""}${r.can_edit ? "" : " disabled"}><span class="form-check-label">${esc(t("ev_" + src.source + "_" + ev))}</span></label>`)
							.join("")}${r.can_edit ? `<button class="btn btn-sm btn-outline-primary rounded-0 mt-1" data-subs-save="${src.source}">${esc(t("save"))}</button>` : ""}</div></details>`
				)
				.join("");
	}
	root.addEventListener("click", async (e) => {
		const b = e.target.closest("[data-subs-save]");
		if (!b || !S.room) return;
		const wrap = b.closest(".chat-subs-list");
		const list = [...wrap.querySelectorAll("input:checked")].map((x) => x.value);
		b.disabled = true;
		try {
			await api(`/api/chat/rooms/${S.room.id}/subscriptions/save/`, { source: wrap.dataset.source, events: list });
			notyf.success(t(list.length ? "events_saved" : "events_off"));
			renderSubscriptions();
		} catch (err) {
			fail(err);
		} finally {
			b.disabled = false;
		}
	});

	// ═══ КОМАНДИ ("/" на початку повідомлення) ══════════
	const hours = (arg) => {
		const h = parseFloat(String(arg || "").replace(",", "."));
		return h > 0 ? new Date(Date.now() + h * 3600e3).toISOString() : null;
	};
	const setStatus = async (status, arg, text) => {
		S.status = (await api("/api/chat/status/save/", { data: { status, text: text || null, until: hours(arg) } })).status;
		renderStatus();
		notyf.success(t("status_set", { status: t("status_" + status) }));
	};
	const COMMANDS = [
		{ name: "task", args: "task_args", run: (cmp, arg) => makeTask(null, arg) },
		{ name: "urgent", args: "text_args", run: (cmp, arg) => ((cmp.urgent = true), (cmp.input.value = arg), renderComposer(cmp), arg && submit(cmp)) },
		{ name: "later", args: "text_args", run: (cmp, arg) => ((cmp.input.value = arg), sendLater(cmp)) },
		{ name: "record", args: "record_args", run: (cmp, arg) => pickRecord(cmp, arg) },
		{ name: "away", args: "hours_args", run: (cmp, arg) => setStatus("away", arg) },
		{ name: "meeting", args: "hours_args", run: (cmp, arg) => setStatus("meeting", arg) },
		{ name: "available", args: "", run: () => setStatus("available") },
		{
			name: "mute",
			args: "hours_args",
			run: async (cmp, arg) => {
				const h = parseFloat(String(arg || "").replace(",", "."));
				await api(`/api/chat/rooms/${S.room.id}/settings/`, { data: { mute_minutes: h > 0 ? Math.round(h * 60) : -1 } });
				await loadRooms();
				renderNotifyMenu();
				notyf.success(t("muted_ok"));
			},
		},
		{
			name: "unmute",
			args: "",
			run: async () => {
				await api(`/api/chat/rooms/${S.room.id}/settings/`, { data: { mute_minutes: 0 } });
				await loadRooms();
				renderNotifyMenu();
				notyf.success(t("unmuted_ok"));
			},
		},
		{
			name: "search",
			args: "text_args",
			run: (cmp, arg) => {
				openSearch(S.room && S.room.id);
				const f = $("chat-search-form");
				f.q.value = arg;
				if (arg) runSearch(false);
			},
		},
		{ name: "mentions", args: "", run: () => openSearch(null, { mentions: true }) },
		{ name: "threads", args: "", run: () => showThreads() },
		{ name: "reminders", args: "", run: () => showReminders() },
		{ name: "notes", args: "", run: async () => openRoom((await api("/api/chat/rooms/notes/")).id) },
		{ name: "help", args: "", run: () => showHelp() },
	];
	function showHelp() {
		$("chat-list-title").textContent = t("commands");
		$("chat-list-body").innerHTML = `<div class="small text-muted mb-2">${esc(t("commands_hint"))}</div><table class="table table-sm small mb-0"><tbody>${COMMANDS.map((c) => `<tr><td class="text-nowrap"><code>/${c.name}</code>${c.args ? ` <span class="text-muted">${esc(t(c.args))}</span>` : ""}</td><td>${esc(t("cmd_" + c.name))}</td></tr>`).join("")}</tbody></table>`;
		bootstrap.Modal.getOrCreateInstance($("chat-list")).show();
	}
	// Рядок починається з "/команда"? "//" — надіслати як текст, що починається з "/"
	function parseCommand(text) {
		const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
		if (!m) return null;
		return { cmd: COMMANDS.find((c) => c.name === m[1]) || null, name: m[1], arg: (m[2] || "").trim() };
	}
	async function runCommand(cmp, parsed) {
		if (!parsed.cmd) return notyf.error(t("command_unknown", { name: parsed.name }));
		cmp.input.value = "";
		autosize(cmp);
		try {
			await parsed.cmd.run(cmp, parsed.arg);
		} catch (e) {
			fail(e);
		}
	}
	function suggestCommands(cmp) {
		const v = cmp.input.value;
		const m = /^\/([a-z]*)$/.exec(v.slice(0, cmp.input.selectionStart));
		if (!m || v.includes("\n")) return false;
		const list = COMMANDS.filter((c) => c.name.startsWith(m[1]));
		cmp.items = list.slice(0, 10).map((c) => ({ command: c.name, label: "/" + c.name + (c.args ? " " + t(c.args) : ""), sub: t("cmd_" + c.name), icon: "fa-solid fa-terminal" }));
		cmp.sel = 0;
		cmp.cmd = true;
		renderMentions(cmp);
		return true;
	}

	// ═══ ОПИТУВАННЯ, ЧЕКЛІСТИ, ПІДТВЕРДЖЕННЯ, РІШЕННЯ ════
	async function vote(id, idOption) {
		const m = findMessage(id);
		if (!m || !m.poll || m.poll.closed) return;
		// Один варіант — заміна (повторний клік по своєму — відкликати); кілька — перемкнути
		const mine = m.poll.options.filter((o) => o.mine).map((o) => o.id);
		let want;
		if (m.poll.multiple) want = mine.includes(idOption) ? mine.filter((x) => x !== idOption) : mine.concat(idOption);
		else want = mine.includes(idOption) ? [] : [idOption];
		try {
			m.poll = (await api(`/api/chat/messages/${id}/vote/`, { options: want })).poll;
			rerender(m);
		} catch (e) {
			fail(e);
		}
	}
	async function closePoll(id) {
		if (!(await ask({ title: t("poll_close"), text: t("poll_close_confirm"), ok: t("poll_close") }))) return;
		try {
			const m = findMessage(id);
			const r = await api(`/api/chat/messages/${id}/poll/close/`);
			if (m) {
				m.poll = r.poll;
				rerender(m);
			}
		} catch (e) {
			fail(e);
		}
	}
	const checkBusy = new Set();
	async function checkItem(id, idItem) {
		const m = findMessage(id);
		const item = m && m.checklist && m.checklist.find((i) => i.id === idItem);
		if (!item || checkBusy.has(idItem)) return;
		checkBusy.add(idItem);
		try {
			const r = await api(`/api/chat/messages/${id}/check/`, { id_item: idItem, done: !item.done });
			m.checklist = r.checklist;
			rerender(m);
		} catch (e) {
			fail(e);
		} finally {
			checkBusy.delete(idItem);
		}
	}
	async function doAck(id) {
		try {
			const m = findMessage(id);
			const r = await api(`/api/chat/messages/${id}/ack/`);
			if (m) {
				m.ack = r.ack;
				rerender(m);
			}
		} catch (e) {
			fail(e);
		}
	}
	async function showAcks(id) {
		try {
			const r = await api(`/api/chat/messages/${id}/acks/`);
			const row = (p) => `<div class="d-flex align-items-center gap-2 mb-2">${avatar(p, "sm")}<span class="flex-grow-1">${esc(p.name || t("deleted_user"))}</span>${p.date ? `<small class="text-muted">${esc(F.when.format(new Date(p.date)))}</small>` : ""}</div>`;
			$("chat-readers-title").textContent = t("ack_count_title");
			$("chat-readers-body").innerHTML = `<div class="small text-muted mb-2">${esc(t("ack_acked"))} (${r.acked.length})</div>${r.acked.map(row).join("") || "—"}<hr><div class="small text-muted mb-2">${esc(t("ack_pending"))} (${r.pending.length})</div>${r.pending.map(row).join("") || "—"}`;
			bootstrap.Modal.getOrCreateInstance($("chat-readers")).show();
		} catch (e) {
			fail(e);
		}
	}
	async function toggleDecision(m) {
		let note = null;
		if (!m.decision) {
			const a = await ask({ title: t("decision_mark"), ok: t("save"), fields: [{ name: "note", label: t("decision_note_prompt"), maxlength: 500 }] });
			if (!a) return;
			note = a.note;
		}
		try {
			const r = await api(`/api/chat/messages/${m.id}/decision/`, { value: !m.decision, note: note ? note.trim() : null });
			m.decision = r.decision;
			rerender(m);
			if (!$("chat-info").classList.contains("d-none") && S.infoTab === "decisions") renderInfoTab();
		} catch (e) {
			fail(e);
		}
	}

	// Створення: опитування і чекліст — окремі вікна, надсилаються одразу (у чат або тред того поля)
	let makeFor = null;
	function pollOptionRow(value = "") {
		return `<div class="input-group input-group-sm mb-1"><input type="text" class="form-control rounded-0" maxlength="300" value="${esc(value)}" placeholder="${esc(t("poll_option"))}"><button type="button" class="btn btn-outline-secondary rounded-0" data-opt-remove aria-label="${esc(t("delete"))}"><i class="fa-solid fa-xmark"></i></button></div>`;
	}
	function makePoll(cmp) {
		if (!S.room || !S.room.can.post) return;
		makeFor = cmp;
		const form = $("chat-poll-form");
		form.reset();
		form.question.value = cmp.input.value.trim().slice(0, 1000);
		$("chat-poll-options").innerHTML = pollOptionRow() + pollOptionRow();
		form.closes_at.min = dateToWall(new Date());
		bootstrap.Modal.getOrCreateInstance($("chat-poll")).show();
		setTimeout(() => form.question.focus(), 300);
	}
	$("chat-poll-add").addEventListener("click", () => {
		if ($("chat-poll-options").children.length >= 10) return notyf.error(t("poll_max"));
		$("chat-poll-options").insertAdjacentHTML("beforeend", pollOptionRow());
		$("chat-poll-options").lastElementChild.querySelector("input").focus();
	});
	$("chat-poll-options").addEventListener("click", (e) => {
		const b = e.target.closest("[data-opt-remove]");
		if (b && $("chat-poll-options").children.length > 2) b.closest(".input-group").remove();
	});
	$("chat-poll-form").addEventListener("submit", async (e) => {
		e.preventDefault();
		const form = e.target;
		const options = [...$("chat-poll-options").querySelectorAll("input")].map((x) => x.value.trim()).filter(Boolean);
		if (!form.question.value.trim()) return form.question.classList.add("is-invalid");
		if (options.length < 2 || new Set(options.map((x) => x.toLowerCase())).size !== options.length) return notyf.error(t("poll_options_invalid"));
		const closes = form.closes_at.value ? wallToDate(form.closes_at.value) : null;
		await sendSpecial(makeFor, { body: form.question.value.trim(), poll: { options, multiple: form.multiple.checked, anonymous: form.anonymous.checked, closes_at: closes ? closes.toISOString() : null } }, "#chat-poll");
	});
	function makeChecklist(cmp) {
		if (!S.room || !S.room.can.post) return;
		makeFor = cmp;
		const form = $("chat-checklist-form");
		form.reset();
		form.title.value = cmp.input.value.trim().split("\n")[0].slice(0, 300);
		bootstrap.Modal.getOrCreateInstance($("chat-checklist")).show();
		setTimeout(() => form.title.focus(), 300);
	}
	$("chat-checklist-form").addEventListener("submit", async (e) => {
		e.preventDefault();
		const form = e.target;
		const items = form.items.value.split("\n").map((x) => x.replace(/^\s*(?:[-*•]|\[\s?\]|\d+[.)])\s*/, "").trim()).filter(Boolean);
		if (!form.title.value.trim()) return form.title.classList.add("is-invalid");
		if (!items.length) return form.items.classList.add("is-invalid");
		if (items.length > 50) return notyf.error(t("checklist_max"));
		await sendSpecial(makeFor, { body: form.title.value.trim(), checklist: { items } }, "#chat-checklist");
	});
	async function sendSpecial(cmp, data, modal) {
		if (!S.room || !cmp) return;
		try {
			const payload = Object.assign({ files: [], records: [], ack: cmp.ack, id_thread: cmp.thread ? TH.id : null, client_id: uuid() }, data);
			const r = await api(`/api/chat/rooms/${S.room.id}/send/`, { data: payload });
			bootstrap.Modal.getOrCreateInstance(modal).hide();
			// Текст із поля став питанням / назвою — поле очищаємо
			clearAfterSend(cmp);
			onMessage(r.message);
			if (cmp.thread) scrollBottom(tbox);
			else scrollBottom();
		} catch (e) {
			fail(e);
		}
	}

	// Події: зміни опитувань, чеклістів, підтверджень і рішень
	function applyPoll(d) {
		const m = findMessage(d.id_message);
		if (!m || !m.poll) return;
		const old = new Map(m.poll.options.map((o) => [o.id, o.mine]));
		// "Мої" позначки: з переліку тих, хто голосував, або (анонімне) — ті, що вже знаємо
		const options = d.poll.options.map((o) => Object.assign({}, o, { mine: d.poll.anonymous ? !!old.get(o.id) : (o.voters || []).includes(ME) }));
		m.poll = Object.assign({}, d.poll, { options, mine: options.some((o) => o.mine) });
		rerender(m);
	}
	function applyChecklist(d) {
		const m = findMessage(d.id_message);
		if (!m) return;
		m.checklist = d.checklist;
		rerender(m);
	}
	function applyAck(d) {
		const m = findMessage(d.id_message);
		if (!m || !m.ack) return;
		m.ack = Object.assign({}, m.ack, { count: d.count, total: d.total, mine: m.ack.mine || d.id_user === ME });
		rerender(m);
	}
	function applyDecision(d) {
		const m = findMessage(d.id_message);
		if (m) {
			m.decision = d.decision;
			rerender(m);
		}
		if (S.room && S.room.id === d.id_room && !$("chat-info").classList.contains("d-none") && S.infoTab === "decisions") renderInfoTab();
	}

	// "Поки вас не було": коротко про непрочитане, коли його багато
	const CATCHUP_FROM = 8;
	async function showCatchup(idRoom, unread) {
		const bar = $("chat-catchup");
		bar.classList.add("d-none");
		if (unread < CATCHUP_FROM) return;
		let c;
		try {
			c = await api(`/api/chat/rooms/${idRoom}/catchup/`);
		} catch {
			return;
		}
		if (!S.room || S.room.id !== idRoom || !c.total) return;
		const who = c.authors.filter((a) => a.name).map((a) => `${a.name} (${a.count})`).join(", ");
		const chip = (n, key, go) => (n ? `<button class="btn btn-sm btn-light rounded-0"${go ? ` data-cu-goto="${go}"` : " disabled"}>${esc(t(key, { n }))}</button>` : "");
		bar.innerHTML = `<div class="d-flex align-items-start gap-2"><i class="fa-solid fa-mug-hot text-primary mt-1"></i><div class="flex-grow-1 min-w-0"><div class="small"><strong>${esc(t("catchup_title", { n: c.total }))}</strong>${who ? " — " + esc(who) : ""}</div><div class="d-flex flex-wrap gap-1 mt-1">${chip(c.mentions, "catchup_mentions", c.first_mention)}${chip(c.decisions, "catchup_decisions", c.first_decision)}${chip(c.acks, "catchup_acks")}${chip(c.polls, "catchup_polls")}${chip(c.urgent, "catchup_urgent")}${chip(c.events, "catchup_events")}${chip(c.files, "catchup_files")}${chip(c.links, "catchup_links")}</div></div><button class="btn btn-sm btn-primary rounded-0" data-cu-goto="${c.first_id}">${esc(t("catchup_read"))}</button><button class="btn-close btn-sm" data-cu-close aria-label="${esc(t("close"))}"></button></div>`;
		bar.classList.remove("d-none");
	}
	$("chat-catchup").addEventListener("click", (e) => {
		const g = e.target.closest("[data-cu-goto]");
		if (g) return gotoMessage(Number(g.dataset.cuGoto));
		if (e.target.closest("[data-cu-close]")) $("chat-catchup").classList.add("d-none");
	});

	// ═══ ГОЛОСОВІ ПОВІДОМЛЕННЯ ════════════════════════════
	const VOICE_MAX = 5 * 60; // с
	function voiceType() {
		if (!window.MediaRecorder) return null;
		return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((x) => MediaRecorder.isTypeSupported(x)) || "";
	}
	async function toggleRecording(cmp) {
		if (cmp.rec) return stopRecording(cmp, true);
		const type = voiceType();
		if (type === null || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return notyf.error(t("voice_unsupported"));
		let stream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			return notyf.error(t("voice_denied"));
		}
		const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
		const chunks = [];
		const state = { rec, stream, chunks, started: Date.now(), keep: false, timer: null };
		rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
		rec.onstop = () => {
			stream.getTracks().forEach((x) => x.stop());
			window.clearInterval(state.timer);
			if (!state.keep || !chunks.length) return;
			// Тип без кодеків — сервер віддає такий файл для відтворення прямо в чаті
			const mime = (rec.mimeType || type || "audio/webm").split(";")[0];
			const ext = mime === "audio/mp4" ? "m4a" : mime === "audio/ogg" ? "ogg" : "webm";
			const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
			addFiles(cmp, [new File(chunks, `voice-${stamp}.${ext}`, { type: mime })]);
		};
		rec.start(1000);
		cmp.rec = state;
		const bar = cmp.root.querySelector(".chat-rec");
		const tick = () => {
			const s = Math.floor((Date.now() - state.started) / 1000);
			bar.querySelector("span").textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`;
			if (s >= VOICE_MAX) stopRecording(cmp, true);
		};
		state.timer = window.setInterval(tick, 500);
		tick();
		bar.classList.remove("d-none");
		cmp.root.querySelector(".chat-mic").classList.add("active");
	}
	function stopRecording(cmp, keep) {
		const state = cmp.rec;
		if (!state) return;
		cmp.rec = null;
		state.keep = keep;
		if (state.rec.state !== "inactive") state.rec.stop();
		else state.stream.getTracks().forEach((x) => x.stop());
		cmp.root.querySelector(".chat-rec").classList.add("d-none");
		cmp.root.querySelector(".chat-mic").classList.remove("active");
	}

	// ═══ ФАЙЛИ ════════════════════════════════════════════
	function addFiles(cmp, list, { asFile = false } = {}) {
		if (!S.room || !(cmp.thread ? S.room.can.post || S.room.can.comment : S.room.can.post)) return;
		for (const file of list) {
			if (cmp.uploads.length >= C.limits.files) {
				notyf.error(t("too_many_files", { n: C.limits.files }));
				break;
			}
			if (file.size > C.limits.size) {
				notyf.error(t("file_too_big", { name: file.name, size: size(C.limits.size) }));
				continue;
			}
			// Дозволені типи — ті самі, що перевіряє сервер (він ще й звіряє вміст файлу з типом)
			const ext = (/\.([a-z0-9]{1,5})$/i.exec(file.name || "") || [])[1];
			if (C.limits.ext && !(ext && C.limits.ext.includes(ext.toLowerCase()))) {
				notyf.error(t("file_type_denied", { name: file.name }));
				continue;
			}
			const isImage = /^image\//.test(file.type);
			// Мініатюра в полі вводу, поки файл вантажиться
			const u = { key: uuid(), file, asFile, progress: 0, done: false, error: null, data: null, thumb: isImage && window.URL ? window.URL.createObjectURL(file) : null };
			cmp.uploads.push(u);
			upload(cmp, u, S.room.id);
		}
		renderUploads(cmp);
	}
	function upload(cmp, u, idRoom) {
		const fd = new FormData();
		// Поле — до файлу: сервер читає його раніше за сам файл
		fd.append("as_file", u.asFile ? "1" : "0");
		fd.append("file", u.file, u.file.name);
		const xhr = new XMLHttpRequest();
		u.xhr = xhr;
		xhr.open("POST", `/api/chat/rooms/${idRoom}/upload/`);
		xhr.responseType = "json";
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable) {
				u.progress = Math.round((e.loaded / e.total) * 100);
				renderUploads(cmp);
			}
		};
		xhr.onload = () => {
			const r = xhr.response || {};
			if (xhr.status === 200 && r.ok) {
				u.done = true;
				u.data = r.file;
			} else u.error = r.error || t("upload_failed");
			renderUploads(cmp);
		};
		xhr.onerror = () => {
			u.error = t("upload_failed");
			renderUploads(cmp);
		};
		xhr.send(fd);
	}
	function renderUploads(cmp) {
		cmp.up.innerHTML =
			cmp.records.map((r) => `<div class="chat-up chat-up-rec" title="${esc(r.title)}"><i class="${RECORD_ICON[r.type]}"></i><span class="text-truncate">${esc(r.title)}</span><button class="btn-close btn-sm" data-unrec="${r.type}:${r.id}" aria-label="${esc(t("delete"))}"></button></div>`).join("") +
			cmp.uploads
			.map(
				(u) => `<div class="chat-up${u.error ? " err" : ""}" data-key="${u.key}" title="${esc(u.error || u.file.name)}">
				${u.thumb && !u.asFile ? `<img class="chat-up-thumb" src="${esc(u.thumb)}" alt="">` : `<i class="fa-regular ${u.file.type.startsWith("image/") && !u.asFile ? "fa-image" : u.file.type.startsWith("audio/") ? "fa-file-audio" : "fa-file"}"></i>`}
				<span class="text-truncate">${esc(u.file.name)}</span>
				<small>${u.error ? esc(t("error")) : u.done ? esc(size(u.file.size)) : u.progress + "%"}</small>
				<button class="btn-close btn-sm" data-unup="${u.key}" aria-label="${esc(t("delete"))}"></button>
			</div>`
			)
			.join("");
	}
	// Перетягування файлів: у розмову — в основне поле, у панель треду — у поле треду
	function dropZone(area, overlay, cmp) {
		let depth = 0;
		area.addEventListener("dragenter", (e) => {
			if (![...(e.dataTransfer.types || [])].includes("Files")) return;
			depth++;
			overlay.classList.remove("d-none");
		});
		area.addEventListener("dragleave", () => {
			if (--depth <= 0) {
				depth = 0;
				overlay.classList.add("d-none");
			}
		});
		area.addEventListener("dragover", (e) => e.preventDefault());
		area.addEventListener("drop", (e) => {
			e.preventDefault();
			e.stopPropagation();
			depth = 0;
			overlay.classList.add("d-none");
			addFiles(cmp, [...e.dataTransfer.files]);
		});
	}
	dropZone($("chat-conv-inner"), $("chat-drop"), MAIN);
	dropZone($("chat-thread"), $("chat-thread-drop"), THC);
	bindComposer(MAIN);
	bindComposer(THC);

	// ═══ ТРЕДИ ════════════════════════════════════════════
	function renderThreadsBtn() {
		const b = $("chat-threads-badge");
		b.textContent = S.threadsUnread > 99 ? "99+" : String(S.threadsUnread);
		b.classList.toggle("d-none", !S.threadsUnread);
	}
	let threadsTimer = null;
	const refreshThreadsSoon = () => {
		clearTimeout(threadsTimer);
		threadsTimer = setTimeout(async () => {
			try {
				const r = await api("/api/chat/threads/");
				S.threadsUnread = r.unread_total;
				renderThreadsBtn();
				if (TH.mode === "list") renderThreadList(r.threads);
			} catch {
				/* наступного разу */
			}
		}, 500);
	};

	/**
	 * Тред відкривається на місці розмови на всю її ширину (як коментарі в Telegram), "назад" — до розмови.
	 * Позицію стрічки запам'ятовуємо: повернувшись, людина опиняється там, де була.
	 */
	function showThreadPane() {
		// У "Пульсі" інформація про канал завжди відкрита зліва
		if (MODE !== "pulse") $("chat-info").classList.add("d-none");
		if (!$("chat-app").classList.contains("has-thread")) S.convScroll = box.scrollTop;
		$("chat-thread").classList.remove("d-none");
		$("chat-app").classList.add("has-thread");
	}
	function closeThread() {
		TH.id = TH.root = null;
		TH.replies = [];
		TH.mode = null;
		resetComposer(THC);
		const was = $("chat-app").classList.contains("has-thread");
		$("chat-thread").classList.add("d-none");
		$("chat-app").classList.remove("has-thread");
		if (was && S.convScroll != null) {
			box.scrollTop = S.convScroll;
			markRead();
		}
	}
	$("chat-thread-close").addEventListener("click", closeThread);

	async function openThread(id, { focusId = null, focusInput = false, idRoom = null } = {}) {
		try {
			// З переліку тредів — спершу відкрити потрібний чат
			if (idRoom && (!S.room || S.room.id !== idRoom)) await openRoom(idRoom);
			const r = await api(`/api/chat/threads/${id}/`);
			if (TH.id !== id) resetComposer(THC);
			TH.id = id;
			TH.mode = "thread";
			TH.root = r.root;
			TH.replies = r.replies;
			TH.lastRead = r.last_read_id;
			TH.more = r.more;
			TH.following = r.following;
			rememberPeople([r.root.author].concat(r.replies.map((x) => x.author)).filter(Boolean));
			showThreadPane();
			renderThread({ keepScroll: false, focusId });
			renderComposer(THC);
			markThreadRead();
			if (focusInput || !focusId) THC.input.focus();
		} catch (e) {
			fail(e);
		}
	}
	function renderThreadHead() {
		$("chat-thread-title").textContent = TH.mode === "list" ? t("threads") : t("thread");
		$("chat-thread-sub").textContent = TH.mode === "thread" && S.room ? roomName(Object.assign({}, S.room, S.byId.get(S.room.id) || {}, S.room.type === "direct" ? { partner: partnerOf(S.room) } : {})) + " · " + t("thread_replies", { n: TH.replies.length }) : "";
		$("chat-thread-follow").classList.toggle("d-none", TH.mode !== "thread");
		$("chat-thread-follow").innerHTML = TH.following ? `<i class="fa-solid fa-bell me-1"></i>${esc(t("thread_following"))}` : `<i class="fa-regular fa-bell me-1"></i>${esc(t("thread_follow"))}`;
		$("chat-thread-composer").classList.toggle("d-none", TH.mode !== "thread");
	}
	function renderThread({ keepScroll = true, focusId = null } = {}) {
		if (TH.mode !== "thread" || !TH.root) return;
		renderThreadHead();
		const stick = atBottom(tbox);
		let html = `<div class="chat-thread-root">${messageHtml(TH.root, null, { inThread: true })}</div><div class="chat-thread-count">${esc(t("thread_replies", { n: TH.replies.length }))}</div>`;
		TH.replies.forEach((m, i) => (html += messageHtml(m, i ? TH.replies[i - 1] : TH.root, { inThread: true })));
		tbox.innerHTML = html;
		if (focusId) flash(tbox.querySelector(`.chat-msg[data-id="${focusId}"]`));
		else if (!keepScroll || stick) {
			scrollBottom(tbox);
			TH.stick = true;
		}
	}
	$("chat-thread-follow").addEventListener("click", async () => {
		try {
			await api(`/api/chat/threads/${TH.id}/follow/`, { value: !TH.following });
			TH.following = !TH.following;
			renderThreadHead();
		} catch (e) {
			fail(e);
		}
	});
	tbox.addEventListener("scroll", () => atBottom(tbox) && markThreadRead());

	let threadReadTimer = null;
	function markThreadRead() {
		if (TH.mode !== "thread" || !TH.id || !seen() || !atBottom(tbox)) return;
		const last = TH.replies.length ? TH.replies[TH.replies.length - 1].id : 0;
		if (!last || last <= TH.lastRead) return;
		clearTimeout(threadReadTimer);
		const id = TH.id;
		threadReadTimer = setTimeout(async () => {
			try {
				await api(`/api/chat/threads/${id}/read/`, { id_message: last });
				if (TH.id === id) TH.lastRead = last;
				refreshThreadsSoon();
			} catch {
				/* наступна спроба — при новій відповіді */
			}
		}, 300);
	}

	// Перелік моїх тредів
	async function showThreads() {
		try {
			const r = await api("/api/chat/threads/");
			TH.mode = "list";
			TH.id = TH.root = null;
			TH.replies = [];
			S.threadsUnread = r.unread_total;
			renderThreadsBtn();
			showThreadPane();
			renderThreadHead();
			renderThreadList(r.threads);
		} catch (e) {
			fail(e);
		}
	}
	function renderThreadList(list) {
		tbox.innerHTML = list.length
			? list
					.map((x) => {
						const room = S.byId.get(x.id_room);
						const first = x.root || {};
						const author = first.author ? first.author.name : "";
						return `<button class="chat-thread-item${x.unread ? " unread" : ""}" data-open-thread="${x.id_thread}" data-room="${x.id_room}"><div class="d-flex justify-content-between small"><span class="text-truncate">${esc(room ? roomName(room) : "")}</span><span class="text-muted">${esc(listTime(x.last_at))}</span></div><div class="text-truncate"><strong>${esc(author)}:</strong> ${esc(plain(first.body).slice(0, 140) || (first.files && first.files.length ? "📎" : ""))}</div><div class="small text-muted">${esc(t("thread_replies", { n: x.count }))}${x.unread ? ` · <span class="text-primary fw-semibold">${esc(t("thread_new", { n: x.unread }))}</span>` : ""}</div></button>`;
					})
					.join("")
			: `<div class="p-3 text-muted small text-center">${esc(t("threads_none"))}</div>`;
	}
	$("chat-threads-btn").addEventListener("click", showThreads);
	$("chat-reminders-btn").addEventListener("click", showReminders);

	// ═══ ПАНЕЛЬ ІНФОРМАЦІЇ ════════════════════════════════
	$("chat-info-toggle").addEventListener("click", () => {
		$("chat-info").classList.toggle("d-none");
		if (!$("chat-info").classList.contains("d-none")) {
			$("chat-thread").classList.add("d-none");
			$("chat-app").classList.remove("has-thread");
			renderInfo();
		}
	});
	$("chat-info-close").addEventListener("click", () => $("chat-info").classList.add("d-none"));

	/**
	 * Бічні панелі (інформація, тред). На широкому екрані — поруч із розмовою;
	 * вужче (і у вбудованій панелі, і в "Пульсі") — висувна панель поверх розмови з затемненням.
	 * pane-open на .chat-app вмикає затемнення; клік по ньому або Esc закривають панель.
	 */
	const syncPanes = () => $("chat-app").classList.toggle("pane-open", MODE !== "pulse" && !$("chat-info").classList.contains("d-none"));
	["chat-info", "chat-thread"].forEach((id) => new window.MutationObserver(syncPanes).observe($(id), { attributes: true, attributeFilter: ["class"] }));
	function closePanes() {
		if (MODE !== "pulse") $("chat-info").classList.add("d-none");
		if (!$("chat-thread").classList.contains("d-none")) closeThread();
	}
	$("chat-pane-backdrop").addEventListener("click", closePanes);
	document.addEventListener("keydown", (e) => {
		// Esc закриває панель, якщо не відкрите модальне вікно, вибір реакції чи підказка в полі вводу
		if (e.key !== "Escape" || document.querySelector(".modal.show") || popFor || MAIN.items.length || THC.items.length) return;
		if (MODE !== "page" && !root.contains(document.activeElement)) return;
		if (e.target.closest && e.target.closest(".chat-input") && (MAIN.reply || MAIN.editing || THC.reply || THC.editing)) return;
		if ($("chat-app").classList.contains("pane-open")) closePanes();
	});
	root.querySelectorAll("[data-info-tab]").forEach((b) =>
		b.addEventListener("click", () => {
			root.querySelectorAll("[data-info-tab]").forEach((x) => x.classList.toggle("active", x === b));
			S.infoTab = b.dataset.infoTab;
			renderInfoTab();
		})
	);

	function renderInfo() {
		const room = S.room;
		if (!room) return;
		// "Збережене": учасник лише ви — вкладки "Учасники" немає, одразу медіа
		const notes = room.type === "notes";
		const membersTab = root.querySelector('[data-info-tab="members"]');
		membersTab.closest("li").classList.toggle("d-none", notes);
		if (notes && S.infoTab === "members") S.infoTab = "media";
		root.querySelectorAll("[data-info-tab]").forEach((x) => x.classList.toggle("active", x.dataset.infoTab === S.infoTab));
		const r = S.byId.get(room.id) || {};
		const view = room.type === "direct" ? Object.assign({}, r, { partner: partnerOf(room) }) : Object.assign({}, room, r);
		const sub = room.type === "direct" ? statusLine(partnerOf(room)) : room.type === "notes" ? "" : t("members_count", { n: room.members.length });
		// Картка чату: аватар, назва, стан, опис — як профіль у месенджерах
		const parts = [
			`<div class="chat-info-profile">${roomAvatar(view).replace(/chat-ava(?=[ "])/g, "chat-ava lg")}<div class="fw-semibold mt-2">${esc(roomName(view))}</div>${sub ? `<div class="small text-muted">${esc(sub)}</div>` : ""}${room.description ? `<div class="small mt-2 text-break">${esc(room.description)}</div>` : ""}</div>`,
		];
		// Дії — кнопки з іконкою й підписом у сітці (не тягнуться в довгий ряд)
		const btn = (attr, icon, label, cls = "") => `<button class="chat-info-action ${cls}" ${attr}><i class="${icon}"></i><span>${esc(label)}</span></button>`;
		const actions = [];
		if (room.can.manage) {
			actions.push(btn("data-info=rename", "fa-solid fa-pen", t("rename")));
			actions.push(btn("data-info=add", "fa-solid fa-user-plus", t("add_members")));
			if (room.role === "owner") actions.push(btn("data-info=archive", room.archived ? "fa-solid fa-box-open" : "fa-solid fa-box-archive", room.archived ? t("unarchive") : t("archive")));
		}
		actions.push(btn('data-info="search"', "fa-solid fa-magnifying-glass", t("search")));
		if (room.can.leave) actions.push(btn("data-info=leave", "fa-solid fa-right-from-bracket", t("leave"), "text-danger"));
		if (room.type === "direct") actions.push(btn("data-info=hide", "fa-regular fa-eye-slash", t("hide_chat")));
		if (room.kind !== "manual") parts.push(`<div class="small text-muted px-3 pb-2"><i class="fa-solid fa-circle-info me-1"></i>${esc(t("auto_room_hint"))}</div>`);
		$("chat-info-body").innerHTML = `${parts.join("")}<div class="chat-info-actions">${actions.join("")}</div><div class="px-3 pb-2" id="${PFX}chat-info-subs"></div>`;
		renderInfoTab();
		renderSubscriptions();
	}
	async function renderInfoTab() {
		const room = S.room;
		const el = $("chat-info-tab");
		if (S.infoTab === "members") {
			el.innerHTML = room.members
				.map((m) => {
					const p = S.people.get(m.id) || m;
					const role = m.role === "owner" ? t("role_owner") : m.role === "admin" ? t("role_admin") : "";
					const manage =
						room.can.manage && m.id !== ME && m.role !== "owner"
							? `<div class="dropdown ms-auto"><button class="btn btn-sm btn-light rounded-0" data-bs-toggle="dropdown"><i class="fa-solid fa-ellipsis"></i></button><ul class="dropdown-menu dropdown-menu-end rounded-0">
						${room.role === "owner" ? `<li><button class="dropdown-item" data-role="${m.role === "admin" ? "member" : "admin"}" data-uid="${m.id}">${esc(m.role === "admin" ? t("make_member") : t("make_admin"))}</button></li>` : ""}
						<li><button class="dropdown-item text-danger" data-remove="${m.id}">${esc(t("remove_member"))}</button></li></ul></div>`
							: "";
					return `<div class="chat-member"><span class="chat-ava-wrap">${avatar(p, "sm")}${presenceDot(p)}</span><span class="min-w-0"><span class="d-block text-truncate">${esc(p.name || t("deleted_user"))}${role ? ` <small class="text-muted">· ${esc(role)}</small>` : ""}</span><small class="text-muted d-block text-truncate">${esc([p.position, statusLine(p)].filter(Boolean).join(" · "))}</small></span>${m.id !== ME && room.type !== "direct" ? `<button class="btn btn-sm btn-light rounded-0 ${manage ? "" : "ms-auto"}" data-dm="${m.id}" title="${esc(t("write"))}"><i class="fa-regular fa-comment"></i></button>` : ""}${manage}</div>`;
				})
				.join("");
			return;
		}
		el.innerHTML = `<div class="p-3 text-center"><span class="spinner-border spinner-border-sm"></span></div>`;
		if (S.infoTab === "decisions") {
			try {
				const r = await api(`/api/chat/rooms/${room.id}/decisions/`);
				el.innerHTML = r.messages.length
					? `<div class="list-group list-group-flush">${r.messages
							.map(
								(m) =>
									`<button class="list-group-item list-group-item-action small" data-dec-goto="${m.id}"><div class="d-flex justify-content-between"><strong>${esc(m.type === "event" ? t("system_events") : (m.author && m.author.name) || "")}</strong><span class="text-muted">${esc(F.short.format(new Date(m.date)))}</span></div>${m.decision && m.decision.note ? `<div class="fw-semibold">${esc(m.decision.note)}</div>` : ""}<div class="text-truncate text-muted">${esc(m.type === "event" ? eventTitle(m.data) : plain(m.body).slice(0, 160))}</div></button>`
							)
							.join("")}</div>`
					: `<div class="p-3 text-muted small">${esc(t("decisions_none"))}</div>`;
			} catch (e) {
				fail(e);
			}
			return;
		}
		try {
			const r = await api(`/api/chat/rooms/${room.id}/files/`, { kind: S.infoTab });
			if (S.infoTab === "media")
				el.innerHTML = r.files.length
					? `<div class="chat-media-grid">${r.files.map((f) => (f.mime.startsWith("image/") ? `<a href="${esc(f.url)}" data-view="${esc(f.url)}"><img src="${esc(f.url)}" alt="" loading="lazy"></a>` : `<a href="${esc(f.url)}" target="_blank" class="chat-media-video"><i class="fa-solid fa-play"></i></a>`)).join("")}</div>`
					: `<div class="p-3 text-muted small">${esc(t("no_files"))}</div>`;
			else el.innerHTML = r.files.length ? `<div class="p-2">${filesHtml(r.files)}</div>` : `<div class="p-3 text-muted small">${esc(t("no_files"))}</div>`;
		} catch (e) {
			fail(e);
		}
	}
	$("chat-info-tab").addEventListener("click", async (e) => {
		const view = e.target.closest("[data-view]");
		if (view) {
			e.preventDefault();
			return showImage(view.dataset.view);
		}
		const dm = e.target.closest("[data-dm]");
		if (dm) return openDirect(Number(dm.dataset.dm));
		const dg = e.target.closest("[data-dec-goto]");
		if (dg) return gotoMessage(Number(dg.dataset.decGoto));
		try {
			const role = e.target.closest("[data-role]");
			if (role) {
				await api(`/api/chat/rooms/${S.room.id}/members/${role.dataset.uid}/role/`, { role: role.dataset.role });
				return reloadRoom();
			}
			const rm = e.target.closest("[data-remove]");
			if (rm && (await ask({ title: t("remove_member"), text: t("confirm_remove", { name: personName(rm.dataset.remove) }), ok: t("remove_member"), danger: true }))) {
				await api(`/api/chat/rooms/${S.room.id}/members/${rm.dataset.remove}/remove/`);
				return reloadRoom();
			}
		} catch (err) {
			fail(err);
		}
	});
	$("chat-info-body").addEventListener("click", async (e) => {
		const b = e.target.closest("[data-info]");
		if (!b) return;
		const room = S.room;
		if (b.dataset.info === "search") return openSearch(room.id);
		try {
			if (b.dataset.info === "rename") {
				const a = await ask({
					title: t("rename"),
					ok: t("save"),
					fields: [
						{ name: "name", label: t("rename_prompt"), value: room.name || "", maxlength: 255, required: true },
						{ name: "description", label: t("description_prompt"), value: room.description || "", type: "textarea", maxlength: 1000 },
					],
				});
				if (!a) return;
				await api(`/api/chat/rooms/${room.id}/update/`, { data: { name: a.name.trim(), description: a.description.trim() || null } });
			} else if (b.dataset.info === "add") return pickPeople("add");
			else if (b.dataset.info === "archive") {
				if (!(await ask({ title: room.archived ? t("unarchive") : t("archive"), text: room.archived ? t("confirm_unarchive") : t("confirm_archive"), ok: room.archived ? t("unarchive") : t("archive") }))) return;
				await api(`/api/chat/rooms/${room.id}/archive/`, { value: !room.archived });
			} else if (b.dataset.info === "leave") {
				if (!(await ask({ title: t("leave"), text: t("confirm_leave"), ok: t("leave"), danger: true }))) return;
				await api(`/api/chat/rooms/${room.id}/leave/`);
				closeRoom();
				return loadRooms();
			} else if (b.dataset.info === "hide") {
				await api(`/api/chat/rooms/${room.id}/settings/`, { data: { hidden: true } });
				closeRoom();
				return loadRooms();
			}
			await reloadRoom();
		} catch (err) {
			fail(err);
		}
	});
	async function reloadRoom() {
		if (!S.room) return;
		try {
			const info = await api(`/api/chat/rooms/${S.room.id}/get/`);
			S.room = info.room;
			rememberPeople(info.room.members);
			S.mentionData = null;
			renderHead();
			renderComposer(MAIN);
			renderComposer(THC);
			renderMessages({ keepScroll: true });
			renderThread({ keepScroll: true });
			if (!$("chat-info").classList.contains("d-none")) renderInfo();
		} catch (e) {
			if (e && e.error) closeRoom();
		}
	}

	// ═══ ВИБІР ЛЮДЕЙ І ЧАТІВ (модальне вікно) ═════════════

	async function loadDirectory(q) {
		const r = await api("/api/chat/people/", { q });
		rememberPeople(r.people);
		return r.people;
	}

	async function pickPeople(mode) {
		pick.mode = mode;
		pick.selected = new Set();
		$("chat-pick-search").value = "";
		$("chat-pick-search").classList.remove("d-none");
		$("chat-pick-title").textContent = t("pick_title_" + mode);
		$("chat-pick-ok").textContent = mode === "direct" ? t("write") : mode === "add" ? t("add") : t("create");
		$("chat-pick-ok").classList.toggle("d-none", mode === "direct");
		$("chat-pick-form").innerHTML =
			mode === "group" || mode === "channel"
				? `<input class="form-control rounded-0 mb-2" id="${PFX}cp-name" maxlength="255" placeholder="${esc(t("room_name"))}">
				<textarea class="form-control rounded-0 mb-2" id="${PFX}cp-desc" rows="2" maxlength="1000" placeholder="${esc(t("room_description"))}"></textarea>
				${mode === "channel" ? `<div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" id="${PFX}cp-public" checked><label class="form-check-label" for="${PFX}cp-public">${esc(t("public_channel"))}</label></div>` : ""}
				<div class="small text-muted mb-1">${esc(t("pick_members"))}</div>`
				: "";
		try {
			pick.list = await loadDirectory("");
		} catch (e) {
			return fail(e);
		}
		renderPick();
		pickModal().show();
	}

	async function pickRooms(message) {
		pick.mode = "forward";
		pick.message = message;
		pick.selected = new Set();
		$("chat-pick-search").value = "";
		$("chat-pick-search").classList.remove("d-none");
		$("chat-pick-title").textContent = t("forward");
		$("chat-pick-ok").textContent = t("send");
		$("chat-pick-ok").classList.remove("d-none");
		$("chat-pick-form").innerHTML = `<textarea class="form-control rounded-0 mb-2" id="${PFX}cp-comment" rows="2" maxlength="${C.limits.body}" placeholder="${esc(t("forward_comment"))}"></textarea>`;
		pick.list = S.rooms.filter((r) => !r.archived);
		renderPick();
		pickModal().show();
	}

	async function pickBrowse() {
		pick.mode = "browse";
		$("chat-pick-title").textContent = t("browse_channels");
		$("chat-pick-ok").classList.add("d-none");
		$("chat-pick-form").innerHTML = "";
		$("chat-pick-search").value = "";
		try {
			pick.list = (await api("/api/chat/rooms/browse/", {})).rooms;
		} catch (e) {
			return fail(e);
		}
		renderPick();
		pickModal().show();
	}

	function renderPick() {
		const q = $("chat-pick-search").value.trim().toLowerCase();
		let html = "";
		if (pick.mode === "forward" || pick.mode === "share") {
			html = pick.list
				.filter((r) => !q || roomName(r).toLowerCase().includes(q))
				.map((r) => `<label class="list-group-item d-flex align-items-center gap-2"><input class="form-check-input m-0" type="checkbox" value="${r.id}" ${pick.selected.has(r.id) ? "checked" : ""}>${roomAvatar(r)}<span class="text-truncate">${esc(roomName(r))}</span></label>`)
				.join("");
		} else if (pick.mode === "browse") {
			html = pick.list
				.map((r) => `<button class="list-group-item list-group-item-action d-flex align-items-center gap-2" data-join="${r.id}"><span class="chat-ava chat-ava-icon"><i class="fa-solid fa-hashtag"></i></span><span class="min-w-0"><span class="d-block text-truncate">${esc(r.name)}</span><small class="text-muted">${esc(t("members_count", { n: r.members_count }))}${r.description ? " · " + esc(r.description) : ""}</small></span><span class="ms-auto btn btn-sm btn-outline-primary rounded-0">${esc(t("join"))}</span></button>`)
				.join("");
			if (!html) html = `<div class="text-muted small p-2">${esc(t("no_channels"))}</div>`;
		} else {
			const already = pick.mode === "add" && S.room ? new Set(S.room.members.map((m) => m.id)) : new Set();
			html = pick.list
				.filter((p) => !p.me && !already.has(p.id))
				.map((p) => {
					const sub = [p.position, p.department, p.office].filter(Boolean).join(" · ");
					const inner = `<span class="chat-ava-wrap">${avatar(p, "sm")}${presenceDot(p)}</span><span class="min-w-0"><span class="d-block text-truncate">${esc(p.name)}</span><small class="text-muted d-block text-truncate">${esc(sub || statusLine(p))}</small></span>`;
					return pick.mode === "direct"
						? `<button class="list-group-item list-group-item-action d-flex align-items-center gap-2" data-dm="${p.id}">${inner}</button>`
						: `<label class="list-group-item d-flex align-items-center gap-2"><input class="form-check-input m-0" type="checkbox" value="${p.id}" ${pick.selected.has(p.id) ? "checked" : ""}>${inner}</label>`;
				})
				.join("");
		}
		$("chat-pick-list").innerHTML = html || `<div class="text-muted small p-2">${esc(t("nothing_found"))}</div>`;
		$("chat-pick-count").textContent = pick.selected.size ? t("selected", { n: pick.selected.size }) : "";
	}

	let pickTimer;
	$("chat-pick-search").addEventListener("input", () => {
		clearTimeout(pickTimer);
		if (pick.mode === "forward" || pick.mode === "share") return renderPick();
		pickTimer = setTimeout(async () => {
			try {
				const q = $("chat-pick-search").value.trim();
				pick.list = pick.mode === "browse" ? (await api("/api/chat/rooms/browse/", { q })).rooms : await loadDirectory(q);
				renderPick();
			} catch (e) {
				fail(e);
			}
		}, 250);
	});
	$("chat-pick-list").addEventListener("change", (e) => {
		if (e.target.type !== "checkbox") return;
		const v = Number(e.target.value);
		if (e.target.checked) pick.selected.add(v);
		else pick.selected.delete(v);
		$("chat-pick-count").textContent = pick.selected.size ? t("selected", { n: pick.selected.size }) : "";
	});
	$("chat-pick-list").addEventListener("click", async (e) => {
		const dm = e.target.closest("[data-dm]");
		if (dm) {
			pickModal().hide();
			return openDirect(Number(dm.dataset.dm));
		}
		const j = e.target.closest("[data-join]");
		if (j) {
			try {
				await api(`/api/chat/rooms/${j.dataset.join}/join/`);
				pickModal().hide();
				await loadRooms();
				openRoom(Number(j.dataset.join));
			} catch (err) {
				fail(err);
			}
		}
	});
	$("chat-pick-ok").addEventListener("click", async () => {
		const btn = $("chat-pick-ok");
		btn.disabled = true;
		try {
			if (pick.mode === "group" || pick.mode === "channel") {
				const name = $("cp-name").value.trim();
				if (!name) {
					$("cp-name").classList.add("is-invalid");
					return;
				}
				const data = { type: pick.mode, name, description: $("cp-desc").value.trim() || null, members: [...pick.selected] };
				if (pick.mode === "channel") data.visibility = $("cp-public").checked ? "public" : "private";
				const r = await api("/api/chat/rooms/create/", { data });
				pickModal().hide();
				await loadRooms();
				openRoom(r.id);
			} else if (pick.mode === "add") {
				if (!pick.selected.size) return;
				await api(`/api/chat/rooms/${S.room.id}/members/add/`, { users: [...pick.selected] });
				pickModal().hide();
				reloadRoom();
			} else if (pick.mode === "share") {
				if (!pick.selected.size) return;
				await api("/api/chat/share/", { records: [{ type: pick.record.type, id: pick.record.id }], rooms: [...pick.selected], comment: $("cp-comment").value.trim() || null });
				pickModal().hide();
				notyf.success(t("shared"));
				loadRooms();
			} else if (pick.mode === "forward") {
				if (!pick.selected.size) return;
				await api(`/api/chat/messages/${pick.message.id}/forward/`, { rooms: [...pick.selected], comment: $("cp-comment").value });
				pickModal().hide();
				notyf.success(t("forwarded"));
				loadRooms();
			}
		} catch (e) {
			fail(e);
		} finally {
			btn.disabled = false;
		}
	});

	async function openDirect(idUser) {
		try {
			const r = await api("/api/chat/rooms/direct/", { id_user: idUser });
			await loadRooms();
			openRoom(r.id);
		} catch (e) {
			fail(e);
		}
	}

	// ═══ ПОШУК ════════════════════════════════════════════
	function openSearch(idRoom, { mentions = false } = {}) {
		const form = $("chat-search-form");
		form.reset();
		form.id_room.innerHTML = `<option value="">${esc(t("all_chats"))}</option>` + S.rooms.map((r) => `<option value="${r.id}">${esc(roomName(r))}</option>`).join("");
		form.id_room.value = idRoom ? String(idRoom) : "";
		const people = [...S.people.values()].filter((p) => p.name).sort((a, b) => a.name.localeCompare(b.name));
		form.id_user.innerHTML = `<option value="">${esc(t("any_author"))}</option>` + people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
		form.mentions_me.checked = mentions;
		$("chat-search-results").innerHTML = "";
		bootstrap.Modal.getOrCreateInstance($("chat-search")).show();
		if (mentions) runSearch(false);
		else setTimeout(() => form.q.focus(), 300);
	}
	let searchState = null;
	async function runSearch(more) {
		const form = $("chat-search-form");
		const f = {
			q: form.q.value.trim() || null,
			id_room: form.id_room.value ? Number(form.id_room.value) : null,
			id_user: form.id_user.value ? Number(form.id_user.value) : null,
			date_from: form.date_from.value || null,
			date_to: form.date_to.value || null,
			has_files: form.has_files.checked,
			has_links: form.has_links.checked,
			mentions_me: form.mentions_me.checked,
		};
		if (more && searchState) f.before = searchState.last;
		try {
			const r = await api("/api/chat/search/", f);
			const html = r.results
				.map(
					(m) => `<button class="list-group-item list-group-item-action" data-hit-room="${m.id_room}" data-hit="${m.id}">
					<div class="d-flex justify-content-between small"><strong>${esc(m.author ? m.author.name : "")}</strong><span class="text-muted">${esc((m.room ? (m.room.type === "direct" ? m.room.name : m.room.kind === "announcements" ? t("announcements") : m.room.type === "notes" ? t("notes") : m.room.name) : "") + (m.id_thread ? " · " + t("in_thread") : "") + " · " + F.full.format(new Date(m.date)))}</span></div>
					<div class="text-truncate">${esc(plain(m.body).slice(0, 200)) || (m.files.length ? "📎 " + esc(m.files.map((x) => x.name).join(", ")) : "")}</div>
				</button>`
				)
				.join("");
			const list = more ? $("chat-search-results").querySelector(".list-group") : null;
			if (list) list.insertAdjacentHTML("beforeend", html);
			else $("chat-search-results").innerHTML = r.results.length ? `<div class="list-group rounded-0">${html}</div>` : `<div class="text-muted small">${esc(t("nothing_found"))}</div>`;
			const old = $("chat-search-more");
			if (old) old.remove();
			if (r.more) $("chat-search-results").insertAdjacentHTML("beforeend", `<div class="text-center mt-2" id="${PFX}chat-search-more"><button class="btn btn-sm btn-light rounded-0">${esc(t("load_more"))}</button></div>`);
			searchState = { last: r.results.length ? r.results[r.results.length - 1].id : null };
		} catch (e) {
			fail(e);
		}
	}
	$("chat-search-form").addEventListener("submit", (e) => {
		e.preventDefault();
		runSearch(false);
	});
	$("chat-search-results").addEventListener("click", (e) => {
		if (e.target.closest(`#${PFX}chat-search-more`)) return runSearch(true);
		const hit = e.target.closest("[data-hit]");
		if (!hit) return;
		bootstrap.Modal.getOrCreateInstance($("chat-search")).hide();
		openRoom(Number(hit.dataset.hitRoom), { around: Number(hit.dataset.hit) });
	});
	$("chat-room-search").addEventListener("click", () => openSearch(S.room && S.room.id));

	// ═══ МЕНЮ "НОВИЙ" ═════════════════════════════════════
	root.querySelector(".chat-side-head").addEventListener("click", async (e) => {
		const b = e.target.closest("[data-new]");
		if (!b) return;
		const what = b.dataset.new;
		if (what === "direct" || what === "group" || what === "channel") return pickPeople(what);
		if (what === "browse") return pickBrowse();
		if (what === "search") return openSearch(null);
		if (what === "mentions") return openSearch(null, { mentions: true });
		if (what === "notify") {
			if (!("Notification" in window)) return notyf.error(t("desktop_unsupported"));
			const p = await Notification.requestPermission();
			notyf[p === "granted" ? "success" : "error"](p === "granted" ? t("desktop_on") : t("desktop_denied"));
			return;
		}
		if (what === "notes") {
			try {
				const r = await api("/api/chat/rooms/notes/");
				await loadRooms();
				openRoom(r.id);
			} catch (err) {
				fail(err);
			}
		}
	});
	$("chat-filter").addEventListener("input", () => (S.side === "people" ? renderPeople() : renderRooms()));
	$("chat-rooms").addEventListener("click", (e) => {
		const b = e.target.closest("[data-room]");
		if (b) openRoom(Number(b.dataset.room));
	});
	$("chat-back").addEventListener("click", closeRoom);

	// ═══ ПОДІЇ В РЕАЛЬНОМУ ЧАСІ ═══════════════════════════
	let roomsTimer = null;
	const reloadRoomsSoon = () => {
		clearTimeout(roomsTimer);
		roomsTimer = setTimeout(() => loadRooms().catch(() => {}), 300);
	};

	// Відповідь у треді: лічильник у першому повідомленні, панель треду, перелік тредів
	function onThreadMessage(m) {
		const first = S.messages.find((x) => x.id === m.id_thread);
		if (first && !S.messages.some((x) => x.id === m.id) && !TH.replies.some((x) => x.id === m.id)) {
			first.thread = { count: ((first.thread && first.thread.count) || 0) + 1, last_at: m.date };
			renderMessages({ keepScroll: true });
		}
		if (TH.mode === "thread" && TH.id === m.id_thread) {
			if (!TH.replies.some((x) => x.id === m.id)) {
				const stick = atBottom(tbox);
				TH.replies.push(m);
				if (TH.root) TH.root.thread = { count: TH.replies.length, last_at: m.date };
				renderThread({ keepScroll: true });
				if (stick || m.id_user === ME) {
					scrollBottom(tbox);
					markThreadRead();
				}
			}
			return;
		}
		if (m.id_user !== ME) refreshThreadsSoon();
	}

	function onMessage(m) {
		if (m.author) rememberPeople([m.author]);
		if (m.id_thread) return onThreadMessage(m);
		const r = S.byId.get(m.id_room);
		if (!r) return reloadRoomsSoon();
		r.last = { id: m.id, id_user: m.id_user, author: m.author ? m.author.name : null, type: m.type, body: m.body, data: m.data, has_files: !!(m.files && m.files.length), deleted: m.deleted, date: m.date };
		const open = S.room && S.room.id === m.id_room;
		if (m.id_user !== ME && m.type !== "system" && !(open && atBottom() && seen())) {
			r.unread += 1;
			if (m.mentioned) r.mentions = (r.mentions || 0) + 1;
		}
		if (m.id_user === ME) {
			r.last_read_id = Math.max(r.last_read_id, m.id);
			r.draft = null;
		}
		bumpRoom(r.id);
		if (open) {
			S.typing.delete(m.id_user);
			renderTyping();
			const stick = atBottom();
			if (!S.messages.some((x) => x.id === m.id) && !S.more.newer) S.messages.push(m);
			renderMessages({ keepScroll: true });
			if (stick || m.id_user === ME) {
				scrollBottom();
				markRead();
			} else if (m.id_user !== ME) {
				$("chat-jump").classList.remove("d-none");
				$("chat-jump-count").textContent = r.unread || "";
			}
			if (m.type === "system") reloadRoom();
		}
		renderRooms();
	}

	function bindSocket(sock) {
		// Подія приходить кожному учаснику, а "мене згадали" — лише з власного запиту; позначку беремо з chat:mention
		const mentionedIds = new Set();
		sock.on("chat:mention", (d) => {
			mentionedIds.add(d.id_message);
			if (mentionedIds.size > 500) mentionedIds.delete(mentionedIds.values().next().value);
			const m = findMessage(d.id_message);
			if (m && !m.mentioned) {
				m.mentioned = true;
				rerender(m);
			}
			const r = S.byId.get(d.id_room);
			if (r && !d.id_thread && !(S.room && S.room.id === d.id_room && atBottom() && seen())) {
				r.mentions = Math.max(r.mentions || 0, 1);
				renderRooms();
			}
		});
		sock.on("chat:message", (m) => {
			if (mentionedIds.has(m.id)) m.mentioned = true;
			// Чужі реакції й позначки приходять без "моїх" — для нового повідомлення їх ще немає
			onMessage(m);
		});
		sock.on("chat:message:update", (m) => {
			// Подію отримують усі учасники: позначка "мене згадали" й "мої реакції" тут — автора, не мої
			const own = findMessage(m.id);
			if (own) {
				m.mentioned = own.mentioned;
				m.reactions = (m.reactions || []).map((r) => Object.assign({}, r, { mine: r.users.includes(ME) }));
			} else m.mentioned = false;
			const r = S.byId.get(m.id_room);
			if (r && r.last && r.last.id === m.id) {
				r.last.body = m.body;
				r.last.deleted = m.deleted;
				renderRooms();
			}
			upsertMessage(m);
		});
		sock.on("chat:reaction", applyReactions);
		sock.on("chat:poll", applyPoll);
		sock.on("chat:checklist", applyChecklist);
		sock.on("chat:ack", applyAck);
		sock.on("chat:decision", applyDecision);
		sock.on("chat:pins", (d) => S.room && S.room.id === d.id_room && loadPins());
		sock.on("chat:thread:read", () => refreshThreadsSoon());
		sock.on("chat:scheduled", (d) => {
			if (d.status === "failed") notyf.error(t("scheduled_failed"));
			if (S.room && S.room.id === d.id_room) loadScheduled();
		});
		sock.on("chat:read", (d) => {
			if (d.id_user === ME) {
				const r = S.byId.get(d.id_room);
				if (r) {
					r.last_read_id = Math.max(r.last_read_id, d.last_read_id);
					if (r.last && r.last_read_id >= r.last.id) r.unread = r.mentions = 0;
					renderRooms();
				}
				return;
			}
			if (S.room && S.room.id === d.id_room) {
				const mem = S.room.members.find((x) => x.id === d.id_user);
				if (mem) {
					mem.last_read_id = d.last_read_id;
					renderMessages({ keepScroll: true });
				}
			}
		});
		sock.on("chat:typing", (d) => {
			if (!S.room || S.room.id !== d.id_room || d.id_user === ME) return;
			clearTimeout(S.typing.get(d.id_user));
			S.typing.set(
				d.id_user,
				setTimeout(() => {
					S.typing.delete(d.id_user);
					renderTyping();
				}, 4500)
			);
			renderTyping();
		});
		sock.on("chat:room", (d) => {
			reloadRoomsSoon();
			if (S.room && S.room.id === d.id) reloadRoom();
		});
		sock.on("chat:room:remove", (d) => {
			if (S.room && S.room.id === d.id) {
				closeRoom();
				notyf.error(t("removed_from_room"));
			}
			reloadRoomsSoon();
		});
		sock.on("chat:status", (d) => {
			const p = S.people.get(d.id_user);
			if (p) p.status = d.status;
			if (d.id_user === ME) {
				S.status = d.status;
				renderStatus();
			}
			if (S.dir) {
				const x = S.dir.find((q) => q.id === d.id_user);
				if (x) x.status = d.status;
			}
			renderRooms();
			renderPeople();
			if (S.room) {
				renderHead();
				if (!$("chat-info").classList.contains("d-none") && S.infoTab === "members") renderInfoTab();
			}
		});
		sock.on("users:online", (ids) => {
			S.online = new Set((ids || []).map(Number));
			// Сокет знає, хто в мережі зараз — прапорець online з довідника вже застарів
			if (S.dir) S.dir.forEach((p) => (p.online = false));
			S.people.forEach((p) => (p.online = false));
			renderRooms();
			renderPeople();
			if (S.room) renderHead();
		});
		// Після обриву зв'язку — дозавантажити пропущене
		sock.on("connect", () => {
			loadRooms().catch(() => {});
			if (S.room && S.messages.length) loadNewer();
			if (TH.mode === "thread" && TH.id) openThread(TH.id);
		});
	}

	// ═══ СТАРТ ════════════════════════════════════════════
	(async function run() {
		if (SOCK) bindSocket(SOCK);
		if (!("Notification" in window) || Notification.permission !== "default") {
			const b = $("chat-notify-perm");
			if (b) b.closest("li").remove();
		}
		if (voiceType() === null) root.querySelectorAll("[data-voice]").forEach((b) => b.remove());
		// "Файл" — усі дозволені типи; "Фото або відео" — лише фото й відео
		if (C.limits.ext) root.querySelectorAll('.chat-write input[data-as="file"]').forEach((i) => (i.accept = C.limits.ext.map((x) => "." + x).join(",")));
		try {
			await loadRooms();
		} catch (e) {
			return fail(e);
		}
		markReady();
		// Адреса ?room=…&message=… — лише для сторінки чату
		const q = new URLSearchParams(MODE === "page" ? location.search : "");
		const code = q.get("room");
		const msg = Number(q.get("message"));
		let room = null;
		if (code) {
			const known = S.rooms.find((r) => r.code === code);
			if (known) room = known.id;
			else {
				try {
					room = (await api("/api/chat/rooms/resolve/", { code })).id;
				} catch (e) {
					if (!C.pulse) fail(e);
				}
			}
		}
		// "Пульс компанії" (віджет на головній): одразу канал оголошень
		if (C.pulse) {
			const main = S.rooms.find((r) => r.kind === "announcements");
			if (main) {
				S.pulseRoom = main.id;
				$("chat-info").classList.remove("d-none");
				return openRoom(main.id, msg && room === main.id ? { around: msg } : {});
			}
			$("chat-empty").querySelector("p").textContent = t("pulse_none");
			return;
		}
		if (room) openRoom(room, msg ? { around: msg } : {});
	})();
	}

	// ═══ ЗАПУСК ═══════════════════════════════════════════
	// Сторінка чату й "Пульс" — одразу; панель справа — при першому відкритті (щоб не вантажити чат на кожній сторінці)
	function boot(root) {
		if (root.dataset.chatMounted) return Promise.resolve(root);
		root.dataset.chatMounted = "1";
		return loadConfig()
			.then((cfg) => {
				mount(root, cfg);
				return root;
			})
			.catch((e) => {
				root.dataset.chatMounted = "";
				sharedNotyf().error((e && e.error) || "Error");
				throw e;
			});
	}
	window.gcChat = { boot };
	function startAll() {
		document.querySelectorAll(".chat-root").forEach((root) => {
			if (root.dataset.chatMode !== "panel") return boot(root);
			const oc = root.closest(".offcanvas");
			if (oc) oc.addEventListener("show.bs.offcanvas", () => boot(root), { once: true });
		});
	}
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startAll);
	else startAll();
})();