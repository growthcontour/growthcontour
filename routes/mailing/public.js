"use strict";
/**
 * Публічні ендпоінти розсилки (БЕЗ авторизації). Доступ — лише через підписані токени.
 * Тексти — тільки з locales/{iso}/mailing/mailing.json, мовою отримувача.
 *
 * GET  /mailing/open/:file                 піксель відкриття
 * GET  /mailing/click/:token               клік → редірект (лише на URL з mailing_links)
 * GET  /mailing/view/:token                веб-версія листа
 * GET  /mailing/unsubscribe/:token         сторінка відписки/налаштувань (за листом)
 * POST /api/mailing/unsubscribe/:token     дія + RFC 8058 one-click
 * GET  /mailing/preferences/:token         сторінка налаштувань (за контактом)
 * POST /api/mailing/preferences/:token     дія
 * GET  /mailing/confirm/:token             сторінка підтвердження підписки
 * POST /api/mailing/confirm/:token         підтвердження
 * POST /api/mailing/subscribe              форма підписки з сайту
 */
const express = require("express");
const model = require("../../controllers/mailing/model");
const render = require("../../controllers/mailing/render");
const events = require("../../controllers/mailing/events");
const sender = require("../../controllers/mailing/sender");

const router = express.Router();
const { pool, T } = model;

const TOKEN_RE = /^[A-Za-z0-9_-]{4,64}\.[A-Za-z0-9_-]{16}$/;
const LIST_CODE_RE = /^[a-z0-9_-]{1,64}$/;
const STATES = new Set(["prefs", "confirm", "confirmed", "subscribed", "check_email", "invalid", "blocked", "consent_required", "invalid_email", "invalid_list", "error"]);
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

// ─── RATE LIMIT (пам'ять процесу, з межею розміру) ──────
function limiter(windowMs, max) {
	const hits = new Map();
	setInterval(() => {
		const now = Date.now();
		for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
	}, windowMs).unref();
	return (req, res, next) => {
		const k = req.ip || "?";
		const now = Date.now();
		if (hits.size > 100000) hits.clear();
		let h = hits.get(k);
		if (!h || h.reset < now) {
			h = { n: 0, reset: now + windowMs };
			hits.set(k, h);
		}
		if (++h.n > max) {
			res.setHeader("Retry-After", Math.ceil((h.reset - now) / 1000));
			return res.status(429).type("text/plain").send("Too many requests");
		}
		next();
	};
}

const lim = {
	track: limiter(60000, 600),
	page: limiter(60000, 60),
	action: limiter(60000, 20),
	subscribe: limiter(10 * 60000, 10),
};

function secureHeaders(res) {
	res.setHeader("Cache-Control", "no-store, max-age=0");
	res.setHeader("X-Robots-Tag", "noindex, nofollow");
	res.setHeader("Referrer-Policy", "no-referrer");
}

const tokenOf = (req, kind) => {
	const t = String(req.params.token || "");
	return TOKEN_RE.test(t) ? render.verify(t, kind) : null;
};

const metaOf = (req) => ({ ip: req.ip, ua: String(req.headers["user-agent"] || "").slice(0, 512), method: req.method });
const ctxOf = (req, source) => ({ source, ip: req.ip, user_agent: String(req.headers["user-agent"] || "").slice(0, 512) });

const maskEmail = (e) => {
	const [l, d] = String(e || "").split("@");
	if (!d || !l) return "";
	return (l.length <= 2 ? l[0] + "*" : l[0] + "*".repeat(Math.min(6, l.length - 2)) + l.slice(-1)) + "@" + d;
};

// ─── МОВА ───────────────────────────────────────────────
// Відомий отримувач → його мова; інакше — мова з i18n.init (cookie/query/браузер), далі en
async function localeFor(req, idLang) {
	if (idLang) return model.localeOf(idLang);
	const l = typeof req.getLocale === "function" ? req.getLocale() : null;
	return l || "en";
}

const tr = (locale) => (key, vars) => model.t(locale, "mailing.public." + key, vars);

async function page(req, res, idLang, state, data = {}, status = 200) {
	const s = STATES.has(state) ? state : "error";
	const locale = await localeFor(req, idLang).catch(() => "en");
	res.status(status).render("pages/mailing/public", { t: tr(locale), lang: locale, state: s, data }, (e, html) => {
		if (e) {
			console.error("[mailing:public]", e.message);
			return res.status(500).type("text/plain").send("Error");
		}
		res.send(html);
	});
}

// ─── ВІДКРИТТЯ ──────────────────────────────────────────
router.get("/mailing/open/:file", lim.track, (req, res) => {
	secureHeaders(res);
	const t = String(req.params.file || "").replace(/\.gif$/i, "");
	const v = TOKEN_RE.test(t) ? render.verify(t, "o") : null;
	if (v) events.recordOpen(v.id, metaOf(req)).catch((e) => console.error("[mailing:open]", e.message));
	res.type("image/gif").send(GIF);
});

// ─── КЛІК ───────────────────────────────────────────────
router.all("/mailing/click/:token", lim.track, async (req, res) => {
	if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).end();
	secureHeaders(res);
	const v = tokenOf(req, "c");
	if (!v || !v.extra) return page(req, res, null, "invalid", {}, 404);
	try {
		const target = await events.recordClick(v.id, v.extra, metaOf(req));
		if (!target) return page(req, res, null, "invalid", {}, 404);
		return res.redirect(302, target);
	} catch (e) {
		console.error("[mailing:click]", e.message);
		return page(req, res, null, "error", {}, 500);
	}
});

// ─── НАЛАШТУВАННЯ / ВІДПИСКА ────────────────────────────
async function resolveByMessage(req) {
	const v = tokenOf(req, "u");
	if (!v) return null;
	const [[m]] = await pool.query(`SELECT id, id_contact FROM ${T.messages} WHERE id = ?`, [v.id]);
	if (!m) return null;
	const c = await model.getContact(m.id_contact);
	return c ? { contact: c, id_message: m.id } : null;
}

async function resolveByContact(req) {
	const v = tokenOf(req, "p");
	if (!v) return null;
	const c = await model.getContact(v.id);
	return c ? { contact: c, id_message: null } : null;
}

async function prefsData(c, extra = {}) {
	const subs = (await model.contactSubscriptions(c.id, c.id_lang)).filter((l) => Number(l.is_public) === 1);
	return {
		email: maskEmail(c.email),
		lists: subs.map((l) => ({ id: l.id, name: l.name, description: l.description, checked: l.status === "subscribed" || l.status === "pending" })),
		unsubscribed: c.status === "unsubscribed",
		blocked: ["bounced", "complained", "cleaned"].includes(c.status),
		...extra,
	};
}

/**
 * kind: unsubscribe (токен листа) | preferences (токен контакту)
 * GET  /mailing/{kind}/:token      — сторінка
 * GET  /api/mailing/{kind}/:token  — поштові програми відкривають List-Unsubscribe через GET → на сторінку
 * POST /api/mailing/{kind}/:token  — дія (one-click / збереження / відписка від усього)
 */
function prefsRoutes(kind, resolve) {
	const actionOf = (req) => `/api/mailing/${kind}/${req.params.token}`;

	router.get(`/mailing/${kind}/:token`, lim.page, async (req, res) => {
		secureHeaders(res);
		try {
			const r = await resolve(req);
			if (!r || r.contact.deleted) return page(req, res, null, "invalid", {}, 404);
			page(req, res, r.contact.id_lang, "prefs", await prefsData(r.contact, { action: actionOf(req) }));
		} catch (e) {
			console.error("[mailing:prefs]", e.message);
			page(req, res, null, "error", {}, 500);
		}
	});

	router.get(`/api/mailing/${kind}/:token`, lim.page, (req, res) => {
		secureHeaders(res);
		const t = String(req.params.token || "");
		if (!TOKEN_RE.test(t)) return page(req, res, null, "invalid", {}, 404);
		res.redirect(303, `/mailing/${kind}/${t}`);
	});

	router.post(`/api/mailing/${kind}/:token`, lim.action, async (req, res) => {
		secureHeaders(res);
		const b = req.body || {};
		try {
			const r = await resolve(req);

			// RFC 8058: поштовий сервіс шле POST з тілом List-Unsubscribe=One-Click
			if (b["List-Unsubscribe"] === "One-Click") {
				if (!r) return res.status(400).type("text/plain").send("Invalid");
				if (!r.contact.deleted) await model.unsubscribe(null, r.contact.id, { id_message: r.id_message, ctx: ctxOf(req, "one_click") });
				return res.status(200).type("text/plain").send("OK");
			}

			if (!r || r.contact.deleted) return page(req, res, null, "invalid", {}, 404);
			const c = r.contact;
			const action = String(b.action || "");
			const base = { action: actionOf(req) };

			if (action === "unsubscribe_all") {
				await model.unsubscribe(null, c.id, { id_message: r.id_message, ctx: ctxOf(req, "preference_center") });
				return page(req, res, c.id_lang, "prefs", await prefsData(await model.getContact(c.id), { ...base, notice: "unsubscribed" }));
			}

			if (action === "save") {
				const wanted = new Set(model.ints(b.lists));
				const publicLists = (await model.contactSubscriptions(c.id, c.id_lang)).filter((l) => Number(l.is_public) === 1);
				let blocked = false;
				await model.withTx(async (conn) => {
					for (const l of publicLists) {
						if (wanted.has(Number(l.id))) {
							if (l.status === "subscribed") continue;
							// Токен з листа доводить володіння скринькою → підтвердження не потрібне
							const st = await model.subscribe(conn, c.id, l.id, { source: "preference_center", double_optin: false, force: true, ctx: ctxOf(req, "preference_center") });
							if (st === "blocked") blocked = true;
						} else if (l.status === "subscribed" || l.status === "pending") {
							await model.unsubscribe(conn, c.id, { id_list: l.id, id_message: r.id_message, ctx: ctxOf(req, "preference_center") });
						}
					}
				});
				return page(req, res, c.id_lang, "prefs", await prefsData(await model.getContact(c.id), { ...base, notice: blocked ? "blocked" : "saved" }));
			}

			return page(req, res, c.id_lang, "error", {}, 400);
		} catch (e) {
			console.error("[mailing:prefs:post]", e.message);
			page(req, res, null, "error", {}, 500);
		}
	});
}

prefsRoutes("unsubscribe", resolveByMessage);
prefsRoutes("preferences", resolveByContact);

// ─── ПІДТВЕРДЖЕННЯ ПІДПИСКИ ─────────────────────────────
// GET лише показує кнопку: сканери пошти відкривають посилання, але не натискають кнопки
router.get("/mailing/confirm/:token", lim.page, async (req, res) => {
	secureHeaders(res);
	const v = tokenOf(req, "d");
	const c = v ? await model.getContact(v.id).catch(() => null) : null;
	if (!c || c.deleted) return page(req, res, null, "invalid", {}, 404);
	page(req, res, c.id_lang, "confirm", { email: maskEmail(c.email), action: `/api/mailing/confirm/${req.params.token}` });
});

router.post("/api/mailing/confirm/:token", lim.action, async (req, res) => {
	secureHeaders(res);
	try {
		const v = tokenOf(req, "d");
		const c = v ? await model.getContact(v.id) : null;
		if (!c || c.deleted) return page(req, res, null, "invalid", {}, 404);
		const r = await model.confirm(c.id, v.extra || null, ctxOf(req, "double_optin"));
		page(req, res, c.id_lang, r.confirmed ? "confirmed" : "invalid", {}, r.confirmed ? 200 : 410);
	} catch (e) {
		console.error("[mailing:confirm]", e.message);
		page(req, res, null, "error", {}, 500);
	}
});

// ─── ВЕБ-ВЕРСІЯ ─────────────────────────────────────────
router.get("/mailing/view/:token", lim.page, async (req, res) => {
	secureHeaders(res);
	try {
		const v = tokenOf(req, "v");
		const m = v ? await events.loadMessageFull(v.id) : null;
		if (!m || m.contact_deleted || !["sent", "bounced"].includes(m.status)) return page(req, res, null, "invalid", {}, 404);
		const s = await sender.get(m.id_sender);
		if (!s) return page(req, res, null, "invalid", {}, 404);

		const mail = await render.buildMessage(m, { id: m.id_campaign, name: m.campaign_name, track_opens: !!m.track_opens, track_clicks: !!m.track_clicks, utm: m.utm }, s);
		// Без пікселя: перегляд у браузері не рахується відкриттям
		const html = mail.html.replace(/<img\b[^>]*\/mailing\/open\/[^>]*>/gi, "");

		// Окрема жорстка CSP: жодних скриптів, форм, фреймів; сторінка в пісочниці
		res.setHeader("Content-Security-Policy", "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https:; font-src https: data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation");
		res.type("html").send(html);
	} catch (e) {
		console.error("[mailing:web]", e.message);
		page(req, res, null, "error", {}, 500);
	}
});

// ─── ФОРМА ПІДПИСКИ З САЙТУ ─────────────────────────────
const allowedReturnHosts = () =>
	String(process.env.CORS_ORIGINS || "")
		.split(",")
		.map((o) => {
			try {
				return new URL(o.trim()).host;
			} catch (e) {
				return null;
			}
		})
		.filter(Boolean);

function safeReturnUrl(raw) {
	try {
		const u = new URL(String(raw || ""));
		if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
		return allowedReturnHosts().includes(u.host) ? u.href : null;
	} catch (e) {
		return null;
	}
}

router.post("/api/mailing/subscribe", lim.subscribe, async (req, res) => {
	secureHeaders(res);
	const b = req.body || {};
	const wantsJson = req.xhr || String(req.headers.accept || "").includes("application/json");

	// lang у формі — iso-код (uk, en, pl ...). Невідомий → мова з налаштувань розсилки
	const s = await model.getSettings().catch(() => model.SETTINGS_DEFAULT);
	const idLang = (await model.idLangOfIso(b.lang).catch(() => null)) || s.default_id_lang;

	const done = async (state, status = 200) => {
		if (wantsJson) {
			const locale = await model.localeOf(idLang).catch(() => "en");
			return res.status(status).json({ ok: status < 400, state, message: model.t(locale, "mailing.public." + state) });
		}
		const ret = status < 400 ? safeReturnUrl(b.return_url) : null;
		if (ret) {
			const u = new URL(ret);
			u.searchParams.set("subscription", state);
			return res.redirect(303, u.href);
		}
		return page(req, res, idLang, state, {}, status);
	};

	try {
		// Пастка для ботів: поле приховане від людей. Відповідаємо «успіхом», нічого не роблячи.
		if (b.website) return done("check_email");
		if (!b.consent) return done("consent_required", 400);

		const n = model.normalizeEmail(b.email);
		if (!n) return done("invalid_email", 400);

		const codes = (Array.isArray(b.lists) ? b.lists : [b.lists || b.list])
			.map((x) => String(x || "").trim().toLowerCase())
			.filter((x) => LIST_CODE_RE.test(x))
			.slice(0, 10);
		if (!codes.length) return done("invalid_list", 400);

		const [lists] = await pool.query(`SELECT id, double_optin FROM ${T.lists} WHERE code IN (?) AND is_public = 1 AND active = 1 AND deleted = 0`, [codes]);
		if (!lists.length) return done("invalid_list", 400);

		// Ліміт листів-підтверджень на адресу; відповідь однакова — без розкриття
		if (!events.allowEmailAttempt(n.email)) return done("check_email");

		const ctx = ctxOf(req, "form");
		const r = await model.withTx(async (conn) => {
			const c = await model.upsertContact(conn, { email: n.email, first_name: b.first_name, last_name: b.last_name, id_lang: idLang, source: "form" }, { updateExisting: false });
			let needConfirm = false;
			for (const l of lists) {
				// Існуючу адресу (могла бути відписана) підписуємо лише через підтвердження власником
				const st = await model.subscribe(conn, c.id, l.id, { source: "form", double_optin: !!l.double_optin || !c.created, force: true, ctx });
				if (st === "pending") needConfirm = true;
			}
			return { id: c.id, needConfirm, created: c.created };
		});

		if (r.needConfirm) {
			events.sendConfirmation(r.id).catch((e) => console.error("[mailing:confirm-send]", e.message));
			return done("check_email");
		}
		return done(r.created ? "subscribed" : "check_email");
	} catch (e) {
		console.error("[mailing:subscribe]", e.message);
		return done("error", 500);
	}
});

module.exports = router;