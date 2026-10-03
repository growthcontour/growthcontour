"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const picker = require("../../../controllers/catalog/products/picker");

const L = "products.list";

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error") });
	}
};
const need = (req, res, next) =>
	auth.hasPermission(req, L, "view") ? next() : res.status(403).json({ ok: false, code: "forbidden", error: req.__("catalog.common.forbidden") });
const permsOf = (req) => ({ cost: auth.hasPermission(req, "products.cost", "view") });
const langOf = (req) => req.user.id_lang || 1;

router.post(
	"/api/catalog/products/picker/search/",
	auth.isAuthenticated,
	need,
	handle(async (req) => ({ ok: true, rows: await picker.search((req.body || {}).search, langOf(req), permsOf(req)) }))
);

router.post(
	"/api/catalog/products/picker/:id/",
	auth.isAuthenticated,
	need,
	handle(async (req) => {
		if (!/^\d+$/.test(req.params.id)) throw Object.assign(new Error("Invalid id"), { status: 400 });
		return { ok: true, row: await picker.get(parseInt(req.params.id, 10), langOf(req), permsOf(req)) };
	})
);

module.exports = router;