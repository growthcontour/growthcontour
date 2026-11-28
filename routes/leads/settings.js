"use strict";

/**
 * Налаштування лідів: правила етапів воронок (обов'язкові поля, заборона повернення, час на першу відповідь),
 * розподіл нових лідів між менеджерами, отримувачі сповіщень модуля, автоматизації, скоринг.
 * Доступ — guard модуля: /leads/settings/ і /api/leads/settings/ — право leads.settings (edit).
 */

const express = require("express");
const router = express.Router();
const auth = require("../../controllers/authorization/authorization");
const logging = require("../../logging/logging");
const rules = require("../../controllers/leads/rules");
const bulk = require("../../controllers/leads/bulk");

router.get("/leads/settings/stages/", auth.isAuthenticated, async (req, res) => {
	try {
		const pipelines = await bulk.pipelines(req.user.id_lang || 1);
		const want = parseInt(req.query.pipeline, 10);
		const current = pipelines.find((p) => p.id === want) || pipelines[0] || null;
		res.render("pages/leads/settings/stages", { i18n: req, user: req.user, header: { navbar: "leads" }, pipelines, current, fields: rules.FIELDS, labels: rules.labels((k) => req.__(k)) });
	} catch (e) {
		logging.error(e);
		res.status(500).send(req.__("leads.server.server"));
	}
});

router.post("/api/leads/settings/stages/", auth.isAuthenticated, async (req, res) => {
	try {
		const id = parseInt((req.body || {}).pipeline, 10) || 0;
		res.json({ rows: id ? await rules.stagesOf(id, req.user.id_lang || 1) : [] });
	} catch (e) {
		logging.error(e);
		res.status(500).json({ message: req.__("leads.server.server") });
	}
});

router.post("/api/leads/settings/stages/save/", auth.isAuthenticated, async (req, res) => {
	try {
		const b = req.body || {};
		const id = parseInt(b.pipeline, 10) || 0;
		if (!id) return res.status(400).json({ message: req.__("leads.server.bad_id") });
		await rules.saveStages(id, b.stages);
		require("../../controllers/common/audit").log(req, { action: "update", module: "leads", entity: "stage_rules", id_entity: id, count: 1 });
		res.json({ ok: true });
	} catch (e) {
		logging.error(e);
		res.status(500).json({ message: req.__("leads.server.server") });
	}
});

/* ═══ Розподіл лідів ═══ */

const routing = require("../../controllers/leads/routing");
const fail = (req, res, e) => {
	if (e && e.status) return res.status(e.status).json({ message: req.__(e.message) });
	logging.error(e);
	return res.status(500).json({ message: req.__("leads.server.server") });
};

router.get("/leads/settings/routing/", auth.isAuthenticated, async (req, res) => {
	try {
		const d = await require("../../controllers/leads/create").formDicts(req.user.id_lang || 1);
		const groups = await routing.groups(req.user.id_lang || 1);
		res.render("pages/leads/settings/routing", { i18n: req, user: req.user, header: { navbar: "leads" }, pipelines: d.pipelines, stages: d.stages, sources: d.sources, managers: d.managers, groups, modes: routing.MODES, capture: routing.CAPTURE });
	} catch (e) {
		logging.error(e);
		res.status(500).send(req.__("leads.server.server"));
	}
});

router.post("/api/leads/settings/routing/list/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json({ rows: await routing.list(req.user.id_lang || 1) });
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/settings/routing/save/", auth.isAuthenticated, async (req, res) => {
	try {
		const r = await routing.save(req.body || {}, req.user.id_lang || 1);
		if (r.errors) {
			const errors = Object.fromEntries(Object.entries(r.errors).map(([k, v]) => [k, req.__(v)]));
			return res.status(400).json({ message: req.__("leads.view.e.check"), errors });
		}
		require("../../controllers/common/audit").log(req, { action: "update", module: "leads", entity: "routing_rule", id_entity: r.id, count: 1 });
		res.json(r);
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/settings/routing/delete/", auth.isAuthenticated, async (req, res) => {
	try {
		const id = parseInt((req.body || {}).id, 10) || 0;
		const r = await routing.remove(id);
		require("../../controllers/common/audit").log(req, { action: "delete", module: "leads", entity: "routing_rule", id_entity: id, count: 1 });
		res.json(r);
	} catch (e) {
		fail(req, res, e);
	}
});

/* ═══ Отримувачі сповіщень ═══ */

router.get("/leads/settings/notify/", auth.isAuthenticated, async (req, res) => {
	try {
		const [groups, d] = await Promise.all([routing.groups(req.user.id_lang || 1), require("../../controllers/leads/create").formDicts(req.user.id_lang || 1)]);
		res.render("pages/leads/settings/notify", { i18n: req, user: req.user, header: { navbar: "leads" }, events: routing.EVENTS, groups, managers: d.managers });
	} catch (e) {
		logging.error(e);
		res.status(500).send(req.__("leads.server.server"));
	}
});

router.post("/api/leads/settings/notify/recipients/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json({ rows: await routing.getRecipients(req.user.id_lang || 1) });
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/settings/notify/save/", auth.isAuthenticated, async (req, res) => {
	try {
		const r = await routing.saveRecipients(req.body || {});
		require("../../controllers/common/audit").log(req, { action: "update", module: "leads", entity: "notify_recipients", id_entity: null, count: 1 });
		res.json(r);
	} catch (e) {
		fail(req, res, e);
	}
});

/* ═══ Автоматизації ═══ */

const automations = require("../../controllers/leads/automations");

router.get("/leads/settings/automations/", auth.isAuthenticated, async (req, res) => {
	try {
		const idLang = req.user.id_lang || 1;
		const [d, groups] = await Promise.all([require("../../controllers/leads/create").formDicts(idLang), routing.groups(idLang)]);
		res.render("pages/leads/settings/automations", { i18n: req, user: req.user, header: { navbar: "leads" }, ...d, groups, triggers: automations.TRIGGERS, actions: automations.ACTIONS, setFields: automations.FIELDS, capture: routing.CAPTURE });
	} catch (e) {
		logging.error(e);
		res.status(500).send(req.__("leads.server.server"));
	}
});

router.post("/api/leads/settings/automations/list/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json({ rows: await automations.list(req.user.id_lang || 1) });
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/settings/automations/save/", auth.isAuthenticated, async (req, res) => {
	try {
		const r = await automations.save(req.body || {}, req.user.id_lang || 1);
		if (r.errors) {
			const errors = Object.fromEntries(Object.entries(r.errors).map(([k, v]) => [k, req.__(v)]));
			return res.status(400).json({ message: req.__("leads.view.e.check"), errors });
		}
		require("../../controllers/common/audit").log(req, { action: "update", module: "leads", entity: "automation", id_entity: r.id, count: 1 });
		res.json(r);
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/settings/automations/delete/", auth.isAuthenticated, async (req, res) => {
	try {
		const id = parseInt((req.body || {}).id, 10) || 0;
		const r = await automations.remove(id);
		require("../../controllers/common/audit").log(req, { action: "delete", module: "leads", entity: "automation", id_entity: id, count: 1 });
		res.json(r);
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/settings/automations/log/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json({ rows: await automations.log(parseInt((req.body || {}).id, 10) || 0) });
	} catch (e) {
		fail(req, res, e);
	}
});

/* ═══ Скоринг ═══ */

const scoring = require("../../controllers/leads/scoring");

router.get("/leads/settings/scoring/", auth.isAuthenticated, async (req, res) => {
	try {
		const d = await require("../../controllers/leads/create").formDicts(req.user.id_lang || 1);
		res.render("pages/leads/settings/scoring", {
			i18n: req,
			user: req.user,
			header: { navbar: "leads" },
			...d,
			filled: scoring.FILLED,
			inFields: scoring.IN_FIELDS,
			utm: scoring.UTM,
			actTypes: scoring.ACT_TYPES,
			capture: routing.CAPTURE,
		});
	} catch (e) {
		logging.error(e);
		res.status(500).send(req.__("leads.server.server"));
	}
});

router.post("/api/leads/settings/scoring/list/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json({ rows: await scoring.list(req.user.id_lang || 1) });
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/settings/scoring/save/", auth.isAuthenticated, async (req, res) => {
	try {
		const r = await scoring.save(req.body || {}, req.user.id_lang || 1);
		if (r.errors) {
			const errors = Object.fromEntries(Object.entries(r.errors).map(([k, v]) => [k, req.__(v)]));
			return res.status(400).json({ message: req.__("leads.view.e.check"), errors });
		}
		require("../../controllers/common/audit").log(req, { action: "update", module: "leads", entity: "score_rule", id_entity: r.id, count: 1 });
		res.json(r);
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/settings/scoring/delete/", auth.isAuthenticated, async (req, res) => {
	try {
		const id = parseInt((req.body || {}).id, 10) || 0;
		const r = await scoring.remove(id);
		require("../../controllers/common/audit").log(req, { action: "delete", module: "leads", entity: "score_rule", id_entity: id, count: 1 });
		res.json(r);
	} catch (e) {
		fail(req, res, e);
	}
});

module.exports = router;