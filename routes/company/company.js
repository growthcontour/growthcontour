"use strict";

/**
 * Структура компанії: сторінка /company/ (офіси, відділи, люди)
 * і картка «Робота та регіон» у профілі користувача.
 *
 * Права:
 *   company.structure — view: сторінка й списки; add / edit / delete: офіси та відділи
 *   users.list edit   — офіс, відділ, посада, керівник користувача
 *   свій профіль або users.list edit — часовий пояс і формати
 */
const express = require("express");
const router = express.Router();

const auth = require("../../controllers/authorization/authorization");
const logging = require("../../logging/logging");
const audit = require("../../controllers/common/audit");
const offices = require("../../controllers/company/offices");
const departments = require("../../controllers/company/departments");
const people = require("../../controllers/company/people");

// Автоматичні канали чату (офіси, відділи) — склад рахується зі структури; після змін оновлюємо одразу
const syncChat = () =>
	require("../../controllers/chat/rooms")
		.syncAll()
		.catch((e) => logging.error("[company] chat sync", e));

const S = "company.structure";
const can = (req, slug, action) => auth.hasPermission(req, slug, action);
const need = (slug, action) => (req, res, next) => (can(req, slug, action) ? next() : res.status(403).json({ ok: false, error: req.__("company.errors.forbidden") }));
const needSave = (req, res, next) => need(S, req.body && req.body.id ? "edit" : "add")(req, res, next);

const id = (v) => {
	const n = parseInt(v, 10);
	if (!Number.isInteger(n) || n < 1 || String(n) !== String(v)) throw Object.assign(new Error("company.errors.not_found"), { status: 404 });
	return n;
};
// Фільтр: число ≥ 0 (0 — «не вказано») або undefined
const optInt = (v) => (v === undefined || v === null || v === "" ? undefined : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
const me = (req) => Number(req.user.userId || req.user.id);

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error("[company]", e);
		res.status(e.status || 500).json({ ok: false, error: req.__(e.status ? e.message : "company.errors.server"), errors: e.errors });
	}
};

// ═══ СТОРІНКА ═════════════════════════════════════════
router.get("/company/", auth.isAuthenticated, (req, res) => {
	if (!can(req, S, "view")) return res.status(403).render("pages/error/404", { i18n: req, user: req.user });
	res.render("pages/company/index", {
		i18n: req,
		user: req.user,
		header: { navbar: "users", subnavbar: "company" },
		perms: { add: can(req, S, "add"), edit: can(req, S, "edit"), delete: can(req, S, "delete"), users: can(req, "users.list", "view") },
	});
});

// ═══ ОФІСИ ════════════════════════════════════════════
router.post("/api/company/offices/list/", auth.isAuthenticated, need(S, "view"), handle(async (req) => ({ ok: true, rows: await offices.list({ archived: !!(req.body || {}).archived }) })));

router.post("/api/company/offices/:id/get/", auth.isAuthenticated, need(S, "view"), handle(async (req) => ({ ok: true, row: await offices.get(id(req.params.id)) })));

router.post(
	"/api/company/offices/save/",
	auth.isAuthenticated,
	needSave,
	handle(async (req) => {
		const oid = req.body.id ? id(req.body.id) : null;
		const r = await offices.save(oid, req.body.data, me(req));
		audit.log(req, { action: oid ? "update" : "create", module: "company", entity: "office", id_entity: r.id, count: 1 });
		syncChat();
		return { ok: true, id: r.id };
	})
);

router.post(
	"/api/company/offices/:id/delete/",
	auth.isAuthenticated,
	need(S, "delete"),
	handle(async (req) => {
		const oid = id(req.params.id);
		await offices.remove(oid);
		audit.log(req, { action: "delete", module: "company", entity: "office", id_entity: oid, count: 1 });
		syncChat();
		return { ok: true };
	})
);

// ═══ ВІДДІЛИ ══════════════════════════════════════════
router.post("/api/company/departments/list/", auth.isAuthenticated, need(S, "view"), handle(async (req) => ({ ok: true, rows: await departments.list({ archived: !!(req.body || {}).archived }) })));

router.post("/api/company/departments/:id/get/", auth.isAuthenticated, need(S, "view"), handle(async (req) => ({ ok: true, row: await departments.get(id(req.params.id)) })));

router.post(
	"/api/company/departments/save/",
	auth.isAuthenticated,
	needSave,
	handle(async (req) => {
		const did = req.body.id ? id(req.body.id) : null;
		const r = await departments.save(did, req.body.data, me(req));
		audit.log(req, { action: did ? "update" : "create", module: "company", entity: "department", id_entity: r.id, count: 1 });
		syncChat();
		return { ok: true, id: r.id };
	})
);

router.post(
	"/api/company/departments/:id/delete/",
	auth.isAuthenticated,
	need(S, "delete"),
	handle(async (req) => {
		const did = id(req.params.id);
		await departments.remove(did);
		audit.log(req, { action: "delete", module: "company", entity: "department", id_entity: did, count: 1 });
		syncChat();
		return { ok: true };
	})
);

// ═══ ЛЮДИ ═════════════════════════════════════════════
router.post(
	"/api/company/people/list/",
	auth.isAuthenticated,
	need(S, "view"),
	handle(async (req) => {
		const b = req.body || {};
		return { ok: true, rows: await people.list({ id_office: optInt(b.id_office), id_department: optInt(b.id_department), search: b.search, inactive: !!b.inactive }) };
	})
);

// Довідники для форм сторінки (офіси й відділи для фільтрів, люди для керівника відділу)
router.post(
	"/api/company/options/",
	auth.isAuthenticated,
	need(S, "view"),
	handle(async () => {
		const [o, d, u] = await Promise.all([offices.options(), departments.options(), people.options()]);
		return { ok: true, offices: o, departments: d, users: u };
	})
);

// ═══ ПРОФІЛЬ КОРИСТУВАЧА: «Робота та регіон» ══════════
const targetId = (req) => id(req.params.id);
const isSelf = (req, uid) => me(req) === uid;

router.post(
	"/api/company/users/:id/profile/",
	auth.isAuthenticated,
	handle(async (req) => {
		const uid = targetId(req);
		if (!isSelf(req, uid) && !can(req, "users.list", "view")) throw Object.assign(new Error("company.errors.forbidden"), { status: 403 });
		const r = await people.profile(uid);
		return { ok: true, ...r, can: { work: can(req, "users.list", "edit"), regional: isSelf(req, uid) || can(req, "users.list", "edit") } };
	})
);

router.post(
	"/api/company/users/:id/work/save/",
	auth.isAuthenticated,
	need("users.list", "edit"),
	handle(async (req) => {
		const uid = targetId(req);
		const r = await people.saveWork(uid, req.body.data);
		audit.log(req, { action: "update", module: "company", entity: "user_work", id_entity: uid, count: 1, details: r.changed });
		syncChat();
		return { ok: true };
	})
);

router.post(
	"/api/company/users/:id/regional/save/",
	auth.isAuthenticated,
	handle(async (req) => {
		const uid = targetId(req);
		if (!isSelf(req, uid) && !can(req, "users.list", "edit")) throw Object.assign(new Error("company.errors.forbidden"), { status: 403 });
		await people.saveRegional(uid, req.body.data);
		return { ok: true };
	})
);

module.exports = router;