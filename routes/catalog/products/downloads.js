"use strict";

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const settings = require("../../../controllers/catalog/products/settings");
const downloads = require("../../../controllers/catalog/products/downloads");
const editLock = require("../../../controllers/catalog/products/edit-lock");
const { getIO } = require("../../../controllers/socket/socket");

const L = "products.list";
const can = (req, action) => auth.hasPermission(req, L, action);
const need = (action) => (req, res, next) => (can(req, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const intId = (v) => {
	const n = parseInt(v, 10);
	if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error("Invalid id"), { status: 400 });
	return n;
};
const langOf = (req) => req.user.id_lang || 1;

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("catalog.common.server_error"), errors: e.errors, code: e.code && !String(e.code).startsWith("ER_") ? e.code : undefined, version: e.version });
	}
};

// Потоковий запис на диск у тимчасову теку закритого сховища — файл не тримається в пам'яті
const upload = multer({
	storage: multer.diskStorage({
		destination: (req, file, cb) => downloads.ensureDirs().then(() => cb(null, downloads.TMP), cb),
		filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString("hex") + ".part"),
	}),
	limits: { fileSize: downloads.MAX_SIZE, files: 1 },
}).single("file");

router.get("/catalog/products/:id/downloads/", auth.isAuthenticated, async (req, res, next) => {
	if (!/^\d+$/.test(req.params.id)) return next();
	if (!can(req, "view")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
	try {
		const all = await settings.getAll();
		const descriptions = require("../../../controllers/catalog/products/descriptions");
		res.render("pages/catalog/products/downloads", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_list" },
			productId: parseInt(req.params.id, 10),
			perms: { edit: can(req, "edit") },
			languages: await descriptions.contentLanguages(),
			heartbeatSeconds: all.edit_lock.heartbeat_seconds,
		});
	} catch (e) {
		next(e);
	}
});

router.post("/api/catalog/products/:id/downloads/list/", auth.isAuthenticated, need("view"), handle(async (req) => ({ ok: true, ...(await downloads.list(intId(req.params.id), langOf(req))) })));

router.post("/api/catalog/products/:id/downloads/upload/", auth.isAuthenticated, need("edit"), (req, res) => {
	upload(req, res, async (err) => {
		if (err) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ ok: false, error: err.message });
		try {
			if (!req.file) return res.status(400).json({ ok: false, error: req.__("catalog.common.file_required") });
			// Ім'я файлу від браузера приходить у latin1 — відновлюємо UTF-8
			const name = Buffer.from(req.file.originalname, "latin1").toString("utf8");
			res.json({ ok: true, ...(await downloads.ingest(req.file.path, name, req.file.mimetype)) });
		} catch (e) {
			logging.error(e);
			res.status(500).json({ ok: false, error: req.__("catalog.common.server_error") });
		}
	});
});

router.post(
	"/api/catalog/products/:id/downloads/save/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		const r = await downloads.save(id, req.body, { idUser: req.user.userId, lockToken: req.body.lock_token, version: req.body.version });
		audit.log(req, { action: "update", module: "products", entity: "product_downloads", id_entity: id, count: r.saved });
		const io = getIO();
		if (io) io.to(editLock.room(id)).emit("product:saved", { id, version: r.version, by: req.user.userId });
		return { ok: true, version: r.version };
	})
);

router.get("/catalog/products/:id/downloads/:did/file/", auth.isAuthenticated, async (req, res) => {
	if (!can(req, "view")) return res.status(403).send(req.__("catalog.common.forbidden"));
	try {
		await downloads.stream(intId(req.params.id), intId(req.params.did), res);
		audit.log(req, { action: "export", module: "products", entity: "product_download", id_entity: parseInt(req.params.did, 10), count: 1 });
	} catch (e) {
		if (!e.status) logging.error(e);
		if (!res.headersSent) res.status(e.status || 500).send(e.status ? e.message : req.__("catalog.common.server_error"));
	}
});

module.exports = router;