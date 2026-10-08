"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const bulk = require("../../../controllers/catalog/products/bulk");
const editLock = require("../../../controllers/catalog/products/edit-lock");
const { validateBulk } = require("../../../validator/catalog/products/bulk");
const { getIO } = require("../../../controllers/socket/socket");

const L = "products.list";

router.post("/api/catalog/products/bulk/", auth.isAuthenticated, async (req, res) => {
	try {
		if (!auth.hasPermission(req, L, "view")) return res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") });

		const { value, error } = validateBulk(req.body || {});
		if (error) return res.status(400).json({ ok: false, error: req.__("catalog.common.validation_error"), errors: error });

		const result = await bulk.apply(value, {
			idUser: req.user.userId,
			perms: {
				edit: auth.hasPermission(req, L, "edit"),
				delete: auth.hasPermission(req, L, "delete"),
				costEdit: auth.hasPermission(req, "products.cost", "edit"),
			},
			logError: (e) => logging.error(e),
		});

		if (result.changedIds.length) {
			audit.log(req, {
				action: value.action === "delete" ? "delete" : "update",
				module: "products",
				entity: "product",
				count: result.changedIds.length,
				details: { bulk: value.action, params: value.params || {}, ids: result.changedIds.slice(0, 500) },
			});
			const io = getIO();
			if (io) {
				const event = value.action === "delete" ? "product:deleted" : "product:saved";
				for (const id of result.changedIds) io.to(editLock.room(id)).emit(event, { id, by: req.user.userId, bulk: true });
			}
		}

		res.json({ ok: true, summary: result.summary, report: result.report });
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({
			ok: false,
			error: e.status === 403 ? req.__("catalog.common.forbidden") : e.status ? e.message : req.__("catalog.common.server_error"),
			errors: e.errors,
		});
	}
});

module.exports = router;