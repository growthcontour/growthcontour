"use strict";

// Склад у картці замовлення: зіставлення позицій з каталогом, склад відвантаження, резерв/списання.
// Доступ до /api/orders/:id/... перевіряє controllers/orders/access.js (orders.list + власник).
const express = require("express");
const router = express.Router();

const auth = require("../../controllers/authorization/authorization");
const logging = require("../../logging/logging");
const orderStock = require("../../controllers/catalog/products/order-stock");

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
const userId = (req) => req.user.userId || req.user.id;
const langOf = (req) => req.user.id_lang || 1;

router.post("/api/orders/:id/stock/", auth.isAuthenticated, handle(async (req) => ({ ok: true, ...(await orderStock.info(id(req.params.id), langOf(req))) })));

router.post(
	"/api/orders/:id/stock/map/",
	auth.isAuthenticated,
	handle(async (req) => {
		const b = req.body || {};
		const r = await orderStock.mapItem(id(req.params.id), id(b.id_item), { id_product: b.id_product, id_variant: b.id_variant, remember: !!b.remember }, userId(req));
		return { ok: true, ...r };
	})
);

router.post(
	"/api/orders/:id/stock/warehouse/",
	auth.isAuthenticated,
	handle(async (req) => {
		const w = (req.body || {}).id_warehouse;
		const r = await orderStock.setWarehouse(id(req.params.id), w ? id(w) : null, userId(req));
		return { ok: true, ...r };
	})
);

router.post("/api/orders/:id/stock/resync/", auth.isAuthenticated, handle(async (req) => ({ ok: true, ...(await orderStock.resync(id(req.params.id), userId(req))) })));

module.exports = router;