const express = require("express");
const router = express.Router();
const multer = require("multer");

const authorizationControllers = require("../../controllers/authorization/authorization");
const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const dict = require("../../controllers/clients/dictionaries");
const clientsImport = require("../../controllers/clients/import");

const P = config.get("configDatabase").prefix;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

// Імпорт — лише для тих, хто може редагувати користувачів (адміністратори)
const canImport = (req) => authorizationControllers.hasPermission(req, "clients.import", "add");
const userOf = (req) => req.user.userId || req.user.id;

const handle = (fn) => async (req, res) => {
	try {
		if (!canImport(req)) return res.status(403).json({ ok: false, error: "Немає доступу." });
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Помилка сервера." });
	}
};

router.get("/clients/import/", authorizationControllers.isAuthenticated, async (req, res) => {
	if (!canImport(req)) return res.status(403).send("Немає доступу.");
	try {
		const idLang = req.user.id_lang;
		const [managers] = await connection_pool.query(`SELECT id, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM ${P}users WHERE active = 1 ORDER BY name`);
		res.render("pages/clients/import", {
			i18n: req,
			user: req.user,
			header: { navbar: "clients" },
			managers,
			tags: await dict.list("tags", idLang),
			lifecycle: await dict.list("lifecycle_stages", idLang),
			identifierTypes: await dict.list("identifier_types", idLang),
		});
	} catch (e) {
		logging.error(e);
		res.status(500).send("Помилка сервера.");
	}
});

router.post(
	"/api/clients/import/upload/",
	authorizationControllers.isAuthenticated,
	(req, res, next) =>
		upload.single("file")(req, res, (err) => {
			if (err) return res.status(400).json({ ok: false, error: err.code === "LIMIT_FILE_SIZE" ? "Файл більший за 20 МБ." : "Не вдалося прийняти файл." });
			next();
		}),
	handle((req) => {
		if (!req.file) throw Object.assign(new Error("Оберіть файл."), { status: 400 });
		return clientsImport.upload(req.file.buffer, Buffer.from(req.file.originalname, "latin1").toString("utf8"), userOf(req));
	})
);

const audit = require("../../controllers/common/audit");
router.post(
	"/api/clients/import/:id/start/",
	authorizationControllers.isAuthenticated,
	handle(async (req) => {
		const id = parseInt(req.params.id, 10);
		const r = await clientsImport.start(id, userOf(req), req.body || {});
		audit.log(req, { action: "import", module: "clients", entity: "import", id_entity: id, count: r.total, details: { file: r.file_name, options: (req.body || {}).options } });
		return r;
	})
);
router.post("/api/clients/import/:id/status/", authorizationControllers.isAuthenticated, handle((req) => clientsImport.status(parseInt(req.params.id, 10), userOf(req))));
router.post("/api/clients/import/:id/cancel/", authorizationControllers.isAuthenticated, handle((req) => clientsImport.cancel(parseInt(req.params.id, 10), userOf(req))));

module.exports = router;