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

// Друковані документи: /orders/:id/print/invoice/ — рахунок, /orders/:id/print/delivery/ — видаткова накладна (право — orders.list view)
const documents = require("../../controllers/orders/documents");
router.get("/orders/:id/print/:type/", auth.isAuthenticated, async (req, res, next) => {
	try {
		const doc = await documents.load(id(req.params.id), String(req.params.type), langOf(req), { shippingLabel: req.__("orders.print.shipping") });
		res.render("pages/orders/print", { i18n: req, doc });
	} catch (e) {
		if (e.status === 404 || e.status === 400) return res.status(404).send(req.__("orders.print.not_found"));
		next(e);
	}
});

// Повернення: форма (позиції, скільки ще можна повернути), оформити, скасувати. Право — orders.list edit (access.js)
const refunds = require("../../controllers/orders/refunds");
router.post("/api/orders/:id/refunds/form/", auth.isAuthenticated, handle(async (req) => ({ ok: true, ...(await refunds.form(id(req.params.id))) })));
router.post("/api/orders/:id/refunds/create/", auth.isAuthenticated, handle(async (req) => ({ ok: true, ...(await refunds.create(id(req.params.id), req.body || {}, userId(req))) })));
router.post("/api/orders/:id/refunds/:rid/delete/", auth.isAuthenticated, handle(async (req) => ({ ok: true, ...(await refunds.remove(id(req.params.id), id(req.params.rid), userId(req))) })));

module.exports = router;