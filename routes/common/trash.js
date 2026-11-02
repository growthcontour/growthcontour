const express = require("express");
const router = express.Router();

const authorizationControllers = require("../../controllers/authorization/authorization");
const logging = require("../../logging/logging");
const trash = require("../../controllers/common/trash");
const audit = require("../../controllers/common/audit");

// system.trash: view — бачити кошик; edit — відновлювати; delete — видаляти остаточно
const can = (req, a) => authorizationControllers.hasPermission(req, "system.trash", a);

const handle = (action, fn) => async (req, res) => {
	try {
		if (!can(req, action)) return res.status(403).json({ ok: false, error: "Немає доступу." });
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Помилка сервера." });
	}
};

router.get("/trash/", authorizationControllers.isAuthenticated, async (req, res) => {
	if (!can(req, "view")) return res.status(403).send("Немає доступу.");
	try {
		res.render("pages/trash/index", {
			i18n: req,
			user: req.user,
			header: { navbar: "users" },
			types: Object.entries(trash.TYPES).map(([key, t]) => ({ key, title: t.title, purge: t.purge })),
			counts: await trash.counts(),
			keepDays: trash.KEEP_DAYS,
			canRestore: can(req, "edit"),
			canPurge: can(req, "delete"),
		});
	} catch (e) {
		logging.error(e);
		res.status(500).send("Помилка сервера.");
	}
});

router.post("/api/trash/:type/list/", authorizationControllers.isAuthenticated, handle("view", (req) => trash.list(req.params.type, req.body || {})));

router.post(
	"/api/trash/:type/restore/",
	authorizationControllers.isAuthenticated,
	handle("edit", async (req) => {
		const id = parseInt((req.body || {}).id, 10);
		const r = await trash.restore(req.params.type, id);
		audit.log(req, { action: "restore", module: req.params.type, id_entity: id, count: 1 });
		return r;
	})
);

router.post(
	"/api/trash/:type/purge/",
	authorizationControllers.isAuthenticated,
	handle("delete", async (req) => {
		const id = parseInt((req.body || {}).id, 10);
		const r = await trash.purge(req.params.type, id);
		audit.log(req, { action: "purge", module: req.params.type, id_entity: id, count: 1 });
		return r;
	})
);

module.exports = router;