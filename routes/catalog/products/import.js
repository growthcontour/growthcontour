"use strict";

const express = require("express");
const os = require("os");
const path = require("path");
const multer = require("multer");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const ctrl = require("../../../controllers/catalog/products/import-export");

const S = "products.import";
const can = (req, action) => auth.hasPermission(req, S, action);

const upload = multer({
	dest: os.tmpdir(),
	limits: { fileSize: 20 * 1024 * 1024, files: 1 },
	fileFilter: (req, file, cb) => {
		const ok = [".csv", ".txt", ".xlsx"].includes(path.extname(file.originalname).toLowerCase());
		cb(ok ? null : Object.assign(new Error("unsupported"), { status: 400, code: "unsupported" }), ok);
	},
});

const fail = (req, res, e) => {
	if (!e.status) logging.error(e);
	if (res.headersSent) return res.end();
	res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error") });
};

// ═══ СТОРІНКА ══════════════════════════════════════════
router.get("/catalog/products/import/", auth.isAuthenticated, (req, res) => {
	if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	res.render("pages/catalog/products/import", {
		i18n: req,
		user: req.user,
		header: { navbar: "catalog", subnavbar: "products_import" },
		perms: { view: true, add: can(req, "add"), edit: can(req, "edit") },
		maxRows: ctrl.MAX_ROWS,
	});
});

// ═══ API ═══════════════════════════════════════════════
const needView = (req, res, next) => (can(req, "view") ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));

router.get("/api/catalog/products/export/", auth.isAuthenticated, needView, (req, res) => ctrl.exportFile(req, res).catch((e) => fail(req, res, e)));
router.get("/api/catalog/products/import/template/", auth.isAuthenticated, needView, (req, res) => ctrl.template(req, res).catch((e) => fail(req, res, e)));

router.post(
	"/api/catalog/products/import/",
	auth.isAuthenticated,
	needView,
	(req, res, next) =>
		upload.single("file")(req, res, (err) => {
			if (!err) return next();
			const message = err.code === "LIMIT_FILE_SIZE" ? req.__("catalog.import.file_too_large") : req.__("catalog.import.file_unsupported");
			res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ ok: false, error: message });
		}),
	(req, res) => ctrl.importFile(req, res).catch((e) => fail(req, res, e))
);

module.exports = router;