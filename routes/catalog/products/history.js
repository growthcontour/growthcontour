"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const history = require("../../../controllers/catalog/products/history");
const languages = require("../../../controllers/catalog/products/languages");
const { COST_FIELDS } = require("../../../controllers/catalog/products/products");

const P = config.get("configDatabase").prefix;
const SECRET_FIELDS = [...COST_FIELDS, "supplier_price"];

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error") });
	}
};

router.post(
	"/api/catalog/products/:id/history/",
	auth.isAuthenticated,
	(req, res, next) => (auth.hasPermission(req, "products.list", "view") ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") })),
	handle(async (req) => {
		if (!/^\d+$/.test(req.params.id)) throw Object.assign(new Error("Invalid id"), { status: 400 });
		const id = parseInt(req.params.id, 10);
		const b = req.body || {};
		const offset = Math.max(parseInt(b.offset, 10) || 0, 0);
		const limit = Math.min(Math.max(parseInt(b.limit, 10) || 30, 1), 100);

		const canCost = auth.hasPermission(req, "products.cost", "view");
		const langs = new Map((await languages.active()).map((l) => [l.id, l.iso]));
		const label = (f) => {
			const base = f.startsWith("variant.") ? f.split(".").slice(2).join(".") : f;
			const key = `catalog.products.f.${base}`;
			const t = req.__(key);
			return t === key ? f : f.startsWith("variant.") ? `${req.__("catalog.history.variant")} #${f.split(".")[1]}: ${t}` : t;
		};
		const hidden = (f) => !canCost && SECRET_FIELDS.some((s) => f === s || f.endsWith("." + s));

		const r = await history.read("products", id, { offset, limit });
		const rows = r.rows.map((ev) => ({
			...ev,
			changes: (ev.changes || []).filter((c) => !hidden(c.field)).map((c) => ({ ...c, label: label(c.field), lang_code: c.lang ? langs.get(c.lang) || "#" + c.lang : null })),
		}));

		let lowest = null;
		if (offset === 0) {
			const [[p]] = await pool.query(`SELECT price FROM ${P}products WHERE id = ?`, [id]);
			if (p) lowest = await history.lowestPrice("products", id, 30, p.price);
		}
		return { ok: true, rows, has_more: r.has_more, lowest_price_30d: lowest };
	})
);

module.exports = router;