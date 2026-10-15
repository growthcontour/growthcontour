"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const groups = require("../../../controllers/catalog/products/customer-groups");
const pricing = require("../../../controllers/catalog/products/pricing");
const languages = require("../../../controllers/catalog/products/languages");

const can = (req, slug, action) => auth.hasPermission(req, slug, action);
const need = (slug, action) => (req, res, next) => (can(req, slug, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const id = (v) => {
	const n = parseInt(v, 10);
	if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error("Invalid id"), { status: 400 });
	return n;
};
const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error"), errors: e.errors });
	}
};

// Групи клієнтів — частина налаштувань каталогу
const S = "products.settings";
const L = "products.list";

// ═══ ГРУПИ КЛІЄНТІВ ════════════════════════════════════
router.get("/catalog/settings/customer-groups/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, S, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	try {
		res.render("pages/catalog/products/customer-groups", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_customer_groups" },
			perms: { edit: can(req, S, "edit") },
			languages: await languages.active(),
		});
	} catch (e) {
		next(e);
	}
});

router.post("/api/catalog/products/customer-groups/list/", auth.isAuthenticated, need(S, "view"), handle(async () => ({ ok: true, rows: await groups.list() })));

router.post(
	"/api/catalog/products/customer-groups/options/",
	auth.isAuthenticated,
	(req, res, next) => (can(req, S, "view") || can(req, L, "view") ? next() : res.status(403).json({ ok: false })),
	handle(async () => ({ ok: true, rows: await groups.options() }))
);

router.post("/api/catalog/products/customer-groups/:id/get/", auth.isAuthenticated, need(S, "view"), handle(async (req) => ({ ok: true, row: await groups.get(id(req.params.id)) })));

router.post(
	"/api/catalog/products/customer-groups/save/",
	auth.isAuthenticated,
	need(S, "edit"),
	handle(async (req) => {
		const gid = req.body.id ? id(req.body.id) : null;
		const r = await groups.save(gid, req.body.data);
		audit.log(req, { action: gid ? "update" : "create", module: "products", entity: "customer_group", id_entity: r.id, count: 1 });
		return { ok: true, id: r.id };
	})
);

router.post(
	"/api/catalog/products/customer-groups/:id/default/",
	auth.isAuthenticated,
	need(S, "edit"),
	handle(async (req) => {
		const gid = id(req.params.id);
		await groups.setDefault(gid);
		audit.log(req, { action: "settings_save", module: "products", entity: "customer_group.default", id_entity: gid, count: 1 });
		return { ok: true };
	})
);

router.post(
	"/api/catalog/products/customer-groups/:id/delete/",
	auth.isAuthenticated,
	need(S, "edit"),
	handle(async (req) => {
		const gid = id(req.params.id);
		await groups.remove(gid);
		audit.log(req, { action: "delete", module: "products", entity: "customer_group", id_entity: gid, count: 1 });
		return { ok: true };
	})
);

// ═══ ЕФЕКТИВНА ЦІНА ════════════════════════════════════
router.post(
	"/api/catalog/products/:id/price/",
	auth.isAuthenticated,
	need(L, "view"),
	handle(async (req) => {
		const b = req.body || {};
		const qty = Number(b.qty) > 0 ? Number(b.qty) : 1;
		const at = b.at && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(b.at) ? String(b.at).replace("T", " ") : null;
		const row = await pricing.resolve({
			idProduct: id(req.params.id),
			idVariant: b.id_variant ? id(b.id_variant) : 0,
			idGroup: b.id_customer_group ? id(b.id_customer_group) : null,
			qty,
			at,
		});
		return { ok: true, row };
	})
);

// ═══ ЗАПЛАНОВАНІ ЦІНИ ══════════════════════════════════
router.post("/api/catalog/products/:id/price-schedule/list/", auth.isAuthenticated, need(L, "view"), handle(async (req) => ({ ok: true, rows: await pricing.listSchedule(id(req.params.id)) })));

router.post(
	"/api/catalog/products/:id/price-schedule/save/",
	auth.isAuthenticated,
	need(L, "edit"),
	handle(async (req) => {
		const pid = id(req.params.id);
		const r = await pricing.createSchedule(pid, req.body.data, { idUser: req.user.userId || req.user.id });
		audit.log(req, { action: "create", module: "products", entity: "price_schedule", id_entity: r.id, count: 1, details: { id_product: pid } });
		return { ok: true, id: r.id };
	})
);

router.post(
	"/api/catalog/products/:id/price-schedule/:sid/cancel/",
	auth.isAuthenticated,
	need(L, "edit"),
	handle(async (req) => {
		const pid = id(req.params.id);
		const sid = id(req.params.sid);
		const r = await pricing.cancelSchedule(pid, sid);
		audit.log(req, { action: "update", module: "products", entity: "price_schedule", id_entity: sid, count: 1, details: { id_product: pid, canceled: r.canceled } });
		return { ok: true, ...r };
	})
);

module.exports = router;