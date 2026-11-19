/**
 * Контакт-центр → Публікації в соцмережі.
 * Право: contact_center.social (view — бачити, add — створювати, edit — змінювати й публікувати, delete — видаляти).
 */
const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const accounts = require("../../../controllers/contact-center/social/accounts");
const media = require("../../../controllers/contact-center/social/media");
const posts = require("../../../controllers/contact-center/social/posts");
const postLog = require("../../../controllers/contact-center/social/log");
const snippets = require("../../../controllers/contact-center/social/snippets");
const stats = require("../../../controllers/contact-center/social/stats");
const { FORMATS, TEXT_LIMITS } = require("../../../controllers/contact-center/social/social");

const SLUG = "contact_center.social";
const isAuth = auth.isAuthenticated;
const can = (action) => auth.checkPermission(SLUG, action);
const userId = (req) => req.user.userId || req.user.id;
const perms = (req) => ({ add: auth.hasPermission(req, SLUG, "add"), edit: auth.hasPermission(req, SLUG, "edit"), delete: auth.hasPermission(req, SLUG, "delete") });

// JSON-відповідь; помилка з ключем перекладу → текст мовою користувача
const handle = (fn) => async (req, res) => {
	try {
		res.json({ ok: true, ...(await fn(req, res)) });
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? req.__(e.message, e.params || {}) : req.__("contact_center.social.errors.server") });
	}
};
// Tabulator remote чекає { last_page, data } без обгортки
const raw = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		logging.error(e);
		res.status(500).json({ last_page: 1, data: [] });
	}
};

/* ─── Сторінки ─── */

router.get("/contact-center/social/", isAuth, can("view"), async (req, res) => {
	res.render("pages/contact-center/social/index", { i18n: res, user: req.user, header: { navbar: "contact-center" }, data: { accounts: await accounts.list(), perms: perms(req) } });
});

router.get("/contact-center/social/accounts/", isAuth, can("view"), async (req, res) => {
	res.render("pages/contact-center/social/accounts", {
		i18n: res,
		user: req.user,
		header: { navbar: "contact-center" },
		data: { channels: await accounts.channelsFor(), permissions: accounts.PERMISSIONS, perms: perms(req) },
	});
});

router.get("/contact-center/social/calendar/", isAuth, can("view"), async (req, res) => {
	res.render("pages/contact-center/social/calendar", { i18n: res, user: req.user, header: { navbar: "contact-center" }, data: { accounts: await accounts.list(), perms: perms(req) } });
});

router.get("/contact-center/social/snippets/", isAuth, can("view"), (req, res) => {
	res.render("pages/contact-center/social/snippets", { i18n: res, user: req.user, header: { navbar: "contact-center" }, data: { perms: perms(req), maxTags: snippets.MAX_TAGS } });
});

router.get("/contact-center/social/stats/", isAuth, can("view"), async (req, res) => {
	const accs = (await accounts.list()).filter((a) => a.network === "instagram" || a.network === "facebook");
	res.render("pages/contact-center/social/stats", { i18n: res, user: req.user, header: { navbar: "contact-center" }, data: { accounts: accs, minPosts: stats.MIN_POSTS, perms: perms(req) } });
});

router.get(["/contact-center/social/new/", "/contact-center/social/:id/"], isAuth, can("view"), async (req, res, next) => {
	try {
		if (req.params.id && !/^\d+$/.test(req.params.id)) return next();
		const id = parseInt(req.params.id, 10) || null;
		const post = id ? await posts.get(id) : null;
		const history = id ? await postLog.list(id) : [];
		res.render("pages/contact-center/social/edit", {
			i18n: res,
			user: req.user,
			header: { navbar: "contact-center" },
			data: {
				post,
				history,
				// нова публікація з календаря: ?at=2026-11-02t10:00:00.000z
				defaultAt: !post && req.query.at && !isNaN(new Date(String(req.query.at))) ? new Date(String(req.query.at)).toISOString() : null,
				editable: !post || posts.editable(post),
				// Погодити може інший користувач з правом редагування — не той, хто відправив на перевірку
				canApprove: !!post && post.status === "review" && auth.hasPermission(req, SLUG, "edit") && Number(post.id_user_review) !== Number(userId(req)),
				accounts: (await accounts.list()).filter((a) => a.status === 1),
				formats: FORMATS,
				limits: TEXT_LIMITS,
				commentNetworks: posts.COMMENT_NETWORKS,
				commentFormats: posts.COMMENT_FORMATS,
				perms: perms(req),
			},
		});
	} catch (e) {
		if (e.status === 404) return next();
		throw e;
	}
});

/* ─── Публікації ─── */

router.post("/api/contact-center/social/posts/list/", isAuth, can("view"), raw((req) => posts.list(req.body || {})));
router.post("/api/contact-center/social/posts/calendar/", isAuth, can("view"), handle(async (req) => ({ data: await posts.calendar(req.body || {}) })));
router.post(
	"/api/contact-center/social/posts/:id/reschedule/",
	isAuth,
	can("edit"),
	handle(async (req) => {
		const id = parseInt(req.params.id, 10);
		await posts.reschedule(id, (req.body || {}).publish_at, userId(req));
		audit.log(req, { action: "reschedule", module: "social", entity: "social_posts", id_entity: id });
		return {};
	})
);
router.post("/api/contact-center/social/posts/:id/get/", isAuth, can("view"), handle(async (req) => ({ post: await posts.get(parseInt(req.params.id, 10)) })));

router.post(
	"/api/contact-center/social/posts/save/",
	isAuth,
	can("add"),
	handle(async (req) => {
		const b = req.body || {};
		const id = parseInt(b.id, 10) || null;
		if (id && !auth.hasPermission(req, SLUG, "edit")) throw Object.assign(new Error("contact_center.social.errors.forbidden"), { status: 403 });
		const r = await posts.save(id, b, userId(req));
		audit.log(req, { action: id ? "update" : "create", module: "social", entity: "social_posts", id_entity: r.id });
		return r;
	})
);

router.post("/api/contact-center/social/posts/:id/cancel/", isAuth, can("edit"), handle(async (req) => (await posts.cancel(parseInt(req.params.id, 10), userId(req)), {})));
router.post("/api/contact-center/social/posts/:id/retry/", isAuth, can("edit"), handle(async (req) => (await posts.retry(parseInt(req.params.id, 10), parseInt((req.body || {}).id_target, 10) || null, userId(req)), {})));

// Погодження: інший користувач з правом редагування підтверджує або повертає з коментарем
router.post(
	"/api/contact-center/social/posts/:id/approve/",
	isAuth,
	can("edit"),
	handle(async (req) => {
		const id = parseInt(req.params.id, 10);
		await posts.approve(id, userId(req));
		audit.log(req, { action: "approve", module: "social", entity: "social_posts", id_entity: id });
		return {};
	})
);
router.post(
	"/api/contact-center/social/posts/:id/reject/",
	isAuth,
	can("edit"),
	handle(async (req) => {
		const id = parseInt(req.params.id, 10);
		await posts.reject(id, userId(req), (req.body || {}).note);
		audit.log(req, { action: "reject", module: "social", entity: "social_posts", id_entity: id });
		return {};
	})
);
router.post("/api/contact-center/social/posts/:id/history/", isAuth, can("view"), handle(async (req) => ({ data: await postLog.list(parseInt(req.params.id, 10)) })));
router.post(
	"/api/contact-center/social/posts/:id/delete/",
	isAuth,
	can("delete"),
	handle(async (req) => {
		const id = parseInt(req.params.id, 10);
		await posts.remove(id, userId(req));
		audit.log(req, { action: "delete", module: "social", entity: "social_posts", id_entity: id });
		return {};
	})
);

/* ─── Шаблони і хештеги ─── */

router.post("/api/contact-center/social/snippets/list/", isAuth, can("view"), handle(async (req) => ({ data: await snippets.list(req.body || {}) })));
router.post(
	"/api/contact-center/social/snippets/save/",
	isAuth,
	can("edit"),
	handle(async (req) => {
		const b = req.body || {};
		const r = await snippets.save(parseInt(b.id, 10) || null, b, userId(req));
		audit.log(req, { action: b.id ? "update" : "create", module: "social", entity: "social_snippets", id_entity: r.id });
		return r;
	})
);
router.post(
	"/api/contact-center/social/snippets/:id/delete/",
	isAuth,
	can("delete"),
	handle(async (req) => {
		const id = parseInt(req.params.id, 10);
		await snippets.remove(id);
		audit.log(req, { action: "delete", module: "social", entity: "social_snippets", id_entity: id });
		return {};
	})
);
router.post("/api/contact-center/social/snippets/:id/used/", isAuth, can("view"), handle(async (req) => (await snippets.used(parseInt(req.params.id, 10)), {})));

/* ─── Статистика ─── */

router.post("/api/contact-center/social/stats/list/", isAuth, can("view"), raw((req) => stats.list(req.body || {})));
router.post("/api/contact-center/social/stats/summary/", isAuth, can("view"), handle(async (req) => ({ data: await stats.summary(req.body || {}) })));
router.post("/api/contact-center/social/stats/best-time/", isAuth, can("view"), handle(async (req) => ({ data: await stats.bestTime(parseInt((req.body || {}).id_account, 10) || 0) })));
router.post("/api/contact-center/social/stats/next-best/", isAuth, can("view"), handle(async (req) => ({ data: await stats.nextBestSlot(parseInt((req.body || {}).id_account, 10) || 0) })));
router.post("/api/contact-center/social/stats/:id/refresh/", isAuth, can("view"), handle(async (req) => await stats.refreshTarget(parseInt(req.params.id, 10))));

/* ─── Акаунти ─── */

router.post("/api/contact-center/social/accounts/list/", isAuth, can("view"), handle(async () => ({ data: await accounts.list() })));
router.post(
	"/api/contact-center/social/accounts/save/",
	isAuth,
	can("edit"),
	handle(async (req) => {
		const b = req.body || {};
		const r = await accounts.save(parseInt(b.id, 10) || null, b, userId(req));
		audit.log(req, { action: b.id ? "update" : "create", module: "social", entity: "social_accounts", id_entity: r.id });
		return r;
	})
);
router.post("/api/contact-center/social/accounts/:id/check/", isAuth, can("view"), handle(async (req) => ({ check: await accounts.checkAccount(parseInt(req.params.id, 10)) })));
router.post("/api/contact-center/social/accounts/:id/delete/", isAuth, can("delete"), handle(async (req) => (await accounts.remove(parseInt(req.params.id, 10)), {})));

/* ─── Медіатека ─── */

router.post("/api/contact-center/social/media/list/", isAuth, can("view"), raw((req) => media.list(req.body || {})));
router.post("/api/contact-center/social/media/upload/", isAuth, can("add"), (req, res) => {
	media.upload.array("files", 10)(req, res, async (err) => {
		if (err) {
			const msg = err.code === "LIMIT_FILE_SIZE" ? req.__("contact_center.social.errors.file_too_big") : err.status ? req.__(err.message, err.params || {}) : err.message;
			return res.status(400).json({ ok: false, error: msg });
		}
		const out = [];
		const errors = [];
		for (const f of req.files || []) {
			try {
				out.push(await media.ingest(f, userId(req)));
			} catch (e) {
				if (!e.status) logging.error(e);
				errors.push(f.originalname + ": " + (e.status ? req.__(e.message, e.params || {}) : req.__("contact_center.social.errors.media_process")));
			}
		}
		res.status(out.length || !errors.length ? 200 : 400).json({ ok: out.length > 0 || !errors.length, items: out, errors, error: errors.join("; ") || undefined });
	});
});
router.post("/api/contact-center/social/media/:id/delete/", isAuth, can("delete"), handle(async (req) => (await media.remove(parseInt(req.params.id, 10)), {})));
router.get("/contact-center/social/media/:id/thumb/", isAuth, can("view"), (req, res) => media.thumb(req, res).catch(() => res.sendStatus(404)));
router.get("/contact-center/social/media/:id/file/", isAuth, can("view"), (req, res) => media.file(req, res).catch(() => res.sendStatus(404)));

// Публічна віддача за підписом — для Meta / Telegram / Viber (без входу в систему)
router.get(["/contact-center/social/public/:id/:exp/:sig/:file", "/contact-center/social/public/:id/:exp/:sig/:variant/:file"], (req, res) => media.publicFile(req, res).catch(() => res.sendStatus(404)));

module.exports = router;