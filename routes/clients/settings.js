const express = require("express");
const router = express.Router();

const authorizationControllers = require("../../controllers/authorization/authorization");
const logging = require("../../logging/logging");
const dict = require("../../controllers/clients/dictionaries");
const settings = require("../../controllers/clients/settings");

// Доступ: лише адміністратори (право редагувати користувачів)
const isAdmin = (req) => authorizationControllers.hasPermission(req, "clients.settings", "edit");

const guard = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ ok: false, error: "Немає доступу." }));

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Помилка сервера." });
	}
};

router.get("/clients/settings/", authorizationControllers.isAuthenticated, async (req, res) => {
	if (!isAdmin(req)) return res.status(403).send("Немає доступу.");
	try {
		res.render("pages/clients/settings", {
			i18n: req,
			user: req.user,
			header: { navbar: "clients" },
			dicts: await settings.describe(),
			langs: (await dict.languages()).list,
		});
	} catch (e) {
		logging.error(e);
		res.status(500).send("Помилка сервера.");
	}
});

router.post(
	"/api/clients/settings/:key/list/",
	authorizationControllers.isAuthenticated,
	guard,
	handle((req) => settings.listRows(req.params.key).then((rows) => ({ rows })))
);

const audit = require("../../controllers/common/audit");

router.post(
	"/api/clients/settings/:key/save/",
	authorizationControllers.isAuthenticated,
	guard,
	handle(async (req) => {
		const b = req.body || {};
		const r = await settings.saveRow(req.params.key, parseInt(b.id, 10) || null, b);
		audit.log(req, { action: "settings_save", module: "clients", entity: req.params.key, id_entity: r.id, count: 1, details: { code: b.code, created: !b.id } });
		return r;
	})
);

router.post(
	"/api/clients/settings/:key/delete/",
	authorizationControllers.isAuthenticated,
	guard,
	handle(async (req) => {
		const id = parseInt((req.body || {}).id, 10);
		const r = await settings.deleteRow(req.params.key, id);
		audit.log(req, { action: "settings_delete", module: "clients", entity: req.params.key, id_entity: id, count: 1 });
		return r;
	})
);

router.post(
	"/api/clients/settings/:key/sort/",
	authorizationControllers.isAuthenticated,
	guard,
	handle(async (req) => {
		const r = await settings.sortRows(req.params.key, (req.body || {}).ids);
		audit.log(req, { action: "settings_sort", module: "clients", entity: req.params.key, count: ((req.body || {}).ids || []).length });
		return r;
	})
);

module.exports = router;
