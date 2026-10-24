"use strict";

const express = require("express");
const multer = require("multer");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const images = require("../../../controllers/catalog/products/images");

// Хто може вантажити в яку теку: треба право додавати або редагувати відповідний розділ
const KIND_SLUG = { products: "products.list", categories: "products.categories", brands: "products.brands" };

// Жорстка межа multer; точний ліміт з налаштувань перевіряє images.processUpload
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } }).single("file");

router.post("/api/catalog/products/images/:kind/upload/", auth.isAuthenticated, (req, res) => {
	const kind = String(req.params.kind);
	const slug = KIND_SLUG[kind];
	if (!slug) return res.status(404).json({ ok: false, error: "Unknown kind" });
	if (!auth.hasPermission(req, slug, "add") && !auth.hasPermission(req, slug, "edit")) {
		return res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") });
	}
	upload(req, res, async (err) => {
		if (err) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ ok: false, error: err.message });
		try {
			if (!req.file) return res.status(400).json({ ok: false, error: req.__("catalog.common.file_required") });
			const r = await images.processUpload(kind, req.file.buffer);
			res.json({ ok: true, file: r.file, url: images.url(kind, r.file, "medium"), width: r.width, height: r.height });
		} catch (e) {
			if (!e.status) logging.error(e);
			res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error") });
		}
	});
});

module.exports = router;