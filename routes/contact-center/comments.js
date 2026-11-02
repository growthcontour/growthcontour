/**
 * Контакт-центр → Коментарі (Instagram, Facebook).
 * Право: contact_center.comments (view — бачити, edit — відповідати / приховувати / в особисті, delete — видаляти).
 */
const express = require("express");
const router = express.Router();

const auth = require("../../controllers/authorization/authorization");
const logging = require("../../logging/logging");
const audit = require("../../controllers/common/audit");
const comments = require("../../controllers/contact-center/comments");

const SLUG = "contact_center.comments";
const isAuth = auth.isAuthenticated;
const can = (action) => auth.checkPermission(SLUG, action);
const userId = (req) => req.user.userId || req.user.id;

const handle = (fn) => async (req, res) => {
	try {
		res.json({ ok: true, ...(await fn(req)) });
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? req.__(e.message, e.params || {}) : req.__("contact_center.comments.errors.server") });
	}
};

router.get("/contact-center/comments/", isAuth, can("view"), async (req, res) => {
	res.render("pages/contact-center/comments/index", {
		i18n: res,
		user: req.user,
		header: { navbar: "contact-center" },
		data: {
			channels: await comments.channels(),
			perms: { edit: auth.hasPermission(req, SLUG, "edit"), delete: auth.hasPermission(req, SLUG, "delete") },
		},
	});
});

// Tabulator remote — { last_page, data } без обгортки
router.post("/api/contact-center/comments/list/", isAuth, can("view"), async (req, res) => {
	try {
		res.json(await comments.list(req.body || {}));
	} catch (e) {
		logging.error(e);
		res.status(500).json({ last_page: 1, data: [] });
	}
});
router.post("/api/contact-center/comments/count/", isAuth, can("view"), handle(async () => ({ count: await comments.countNew() })));
router.post("/api/contact-center/comments/sync/", isAuth, can("view"), handle(async (req) => ({ result: await comments.sync(parseInt((req.body || {}).id_channel, 10) || null) })));

const act = (name, fn, perm) =>
	router.post(
		`/api/contact-center/comments/:id/${name}/`,
		isAuth,
		can(perm || "edit"),
		handle(async (req) => {
			const id = parseInt(req.params.id, 10);
			const r = await fn(id, req.body || {}, userId(req));
			audit.log(req, { action: "comment_" + name, module: "contact_center", entity: "contact_center_comments", id_entity: id });
			return r || {};
		})
	);

act("reply", (id, b, u) => comments.reply(id, b.text, u));
act("private", (id, b, u) => comments.privateReply(id, b.text, u));
act("hide", (id, b, u) => comments.setHidden(id, true, u));
act("unhide", (id, b, u) => comments.setHidden(id, false, u));
act("status", (id, b, u) => comments.setStatus(id, String(b.status), u));
act("delete", (id, b, u) => comments.remove(id, u), "delete");

module.exports = router;