"use strict";

/**
 * Робота з карткою ліда: активності, файли, конвертація.
 * Доступ перевіряє guard модуля (controllers/leads/access.js):
 *   списки — перегляд ліда; додавання/зміни/конвертація — редагування ліда.
 */

const express = require("express");
const router = express.Router();
const auth = require("../../controllers/authorization/authorization");
const i18n = require("../../config/i18n/i18n");
const logging = require("../../logging/logging");
const work = require("../../controllers/leads/work");

const LOCALE = process.env.APP_LOCALE || "uk";
const tSys = (phrase, vars) => i18n.__({ phrase, locale: LOCALE }, vars || {});
const uid = (req) => req.user.userId || req.user.id;
const leadId = (req) => parseInt(req.params.id, 10) || 0;

/** Помилка → відповідь: відомі (status) — з перекладом, інші — у журнал */
function fail(req, res, e) {
	if (e && e.status) return res.status(e.status).json({ message: req.__(e.message) });
	logging.error(e);
	return res.status(500).json({ message: req.__("leads.server.server") });
}

/* ═══ Активності ═══ */

router.post("/api/leads/:id/activities/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json(await work.activities(leadId(req)));
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/:id/activities/add/", auth.isAuthenticated, async (req, res) => {
	try {
		const id = await work.addActivity(leadId(req), req.body || {}, uid(req), req.ip);
		res.json({ ok: true, id });
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/:id/activities/:aid/status/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json(await work.setActivityStatus(leadId(req), parseInt(req.params.aid, 10) || 0, String((req.body || {}).status || "")));
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/:id/activities/:aid/delete/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json(await work.deleteActivity(leadId(req), parseInt(req.params.aid, 10) || 0, uid(req)));
	} catch (e) {
		fail(req, res, e);
	}
});

/* ═══ Файли ═══ */

router.post("/api/leads/:id/files/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json(await work.files(leadId(req)));
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/:id/files/upload/", auth.isAuthenticated, (req, res) => {
	work.upload(req, res, async (err) => {
		if (err) {
			if (req.file && req.file.path) require("fs").unlink(req.file.path, () => {});
			if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ message: req.__("leads.work.e.file_size") });
			if (err.status) return res.status(err.status).json({ message: req.__(err.message) });
			logging.error(err);
			return res.status(400).json({ message: req.__("leads.work.e.file_type") });
		}
		if (!req.file) return res.status(400).json({ message: req.__("leads.work.e.no_file") });
		try {
			const id = await work.addFile(leadId(req), req.file, String((req.body || {}).category || ""), uid(req), req.ip);
			res.json({ ok: true, id });
		} catch (e) {
			fail(req, res, e);
		}
	});
});

router.post("/api/leads/:id/files/:fid/delete/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json(await work.deleteFile(leadId(req), parseInt(req.params.fid, 10) || 0, uid(req), req.ip));
	} catch (e) {
		fail(req, res, e);
	}
});

router.get("/leads/:id/files/:fid/", auth.isAuthenticated, async (req, res) => {
	try {
		await work.serveFile(leadId(req), parseInt(req.params.fid, 10) || 0, res, req.query.download === "1");
	} catch (e) {
		if (!res.headersSent) res.status(e && e.status ? e.status : 500).type("text/plain").send(req.__(e && e.status ? e.message : "leads.server.server"));
		if (!(e && e.status)) logging.error(e);
	}
});

/* ═══ Конвертація ═══ */

router.post("/api/leads/:id/conversions/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json(await work.conversions(leadId(req)));
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/:id/convert/sources/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json(await work.orderSources());
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/:id/convert/:target/", auth.isAuthenticated, async (req, res) => {
	const id = leadId(req);
	try {
		let r;
		if (req.params.target === "client") r = await work.toClient(id, uid(req), req.ip);
		else if (req.params.target === "deal") r = await work.toDeal(id, uid(req), req.ip, tSys);
		else if (req.params.target === "order") r = await work.toOrder(id, req.body || {}, uid(req), req.ip, (k) => req.__(k));
		else return res.status(404).json({ message: req.__("leads.server.not_found") });
		require("../../controllers/common/audit").log(req, { action: "convert", module: "leads", entity: "lead", id_entity: id, count: 1 });
		res.json({ ok: true, ...r });
	} catch (e) {
		fail(req, res, e);
	}
});

/* ═══ Канбан воронки й масові дії списку ═══ */

const bulk = require("../../controllers/leads/bulk");

router.get("/leads/kanban/", auth.isAuthenticated, async (req, res) => {
	try {
		const pipelines = await bulk.pipelines(req.user.id_lang || 1);
		const want = parseInt(req.query.pipeline, 10);
		const current = pipelines.find((p) => p.id === want) || pipelines[0] || null;
		res.render("pages/leads/kanban", {
			i18n: req,
			user: req.user,
			header: { navbar: "leads" },
			pipelines,
			current,
			canAdd: auth.hasPermission(req, "leads.list", "add"),
			canEdit: auth.hasPermission(req, "leads.list", "edit"),
			labels: require("../../controllers/leads/rules").labels((k) => req.__(k)),
		});
	} catch (e) {
		logging.error(e);
		res.status(500).send(req.__("leads.server.server"));
	}
});

/** Фільтри канбану — ті самі, що в списку, крім воронки й етапу (їх задає дошка) */
const boardWhere = (req) => {
	const f = { ...(req.body || {}) };
	delete f.pipeline;
	delete f.stage;
	return bulk.leadsWhere(f, uid(req));
};

router.post("/api/leads/kanban/", auth.isAuthenticated, async (req, res) => {
	try {
		const idPipeline = parseInt((req.body || {}).pipeline, 10) || 0;
		if (!idPipeline) return res.status(400).json({ message: req.__("leads.server.bad_id") });
		res.json(await bulk.board(req, idPipeline, boardWhere(req)));
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/kanban/column/", auth.isAuthenticated, async (req, res) => {
	try {
		const b = req.body || {};
		const idPipeline = parseInt(b.pipeline, 10) || 0;
		const stage = parseInt(b.stage, 10) || 0;
		if (!idPipeline || !stage) return res.status(400).json({ message: req.__("leads.server.bad_id") });
		res.json(await bulk.board(req, idPipeline, boardWhere(req), { stage, offset: parseInt(b.offset, 10) || 0 }));
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/bulk/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json(await bulk.run(req, req.body || {}, (k, v) => req.__(k, v)));
	} catch (e) {
		fail(req, res, e);
	}
});

/* ═══ Дублікати й злиття ═══ */

const dupes = require("../../controllers/leads/dupes");
const pool = require("../../config/database/connection_pool");
const access = require("../../controllers/leads/access");
const P = require("../../config/config").get("configDatabase").prefix;

router.post("/api/leads/:id/duplicates/", auth.isAuthenticated, async (req, res) => {
	try {
		const [[lead]] = await pool.query(`SELECT id, contact_info, is_duplicate, id_duplicate_of, duplicate_method FROM \`${P}leads\` WHERE id = ? AND deleted_at IS NULL`, [leadId(req)]);
		if (!lead) return res.status(404).json({ message: req.__("leads.server.not_found") });
		const rows = await dupes.matches(lead, access.scope(req, "l"), req.user.id_lang || 1);
		res.json({ dismissed: lead.duplicate_method === "dismissed", of: lead.id_duplicate_of, rows });
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/:id/duplicates/dismiss/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json(await dupes.dismiss(leadId(req), uid(req), req.ip));
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/:id/merge/preview/", auth.isAuthenticated, async (req, res) => {
	try {
		res.json(await dupes.pair(req, leadId(req), parseInt((req.body || {}).other, 10) || 0));
	} catch (e) {
		fail(req, res, e);
	}
});

router.post("/api/leads/:id/merge/", auth.isAuthenticated, async (req, res) => {
	try {
		const b = req.body || {};
		res.json(await dupes.merge(req, leadId(req), parseInt(b.other, 10) || 0, b.pick, b.date_edit ? String(b.date_edit) : null));
	} catch (e) {
		fail(req, res, e);
	}
});

/* ═══ Новий лід вручну ═══ */

const creator = require("../../controllers/leads/create");

router.get("/leads/new/", auth.isAuthenticated, async (req, res) => {
	if (!auth.hasPermission(req, "leads.list", "add")) return res.status(403).send(req.__("leads.bulk.e.forbidden"));
	try {
		const d = await creator.formDicts(req.user.id_lang || 1);
		res.render("pages/leads/new", { i18n: req, user: req.user, header: { navbar: "leads" }, ...d, fields: require("../../controllers/leads/rules").FIELDS, pipelineId: parseInt(req.query.pipeline, 10) || 0 });
	} catch (e) {
		logging.error(e);
		res.status(500).send(req.__("leads.server.server"));
	}
});

router.post("/api/leads/create/", auth.isAuthenticated, async (req, res) => {
	if (!auth.hasPermission(req, "leads.list", "add")) return res.status(403).json({ message: req.__("leads.bulk.e.forbidden") });
	try {
		res.json(await creator.create(req, req.body || {}));
	} catch (e) {
		if (e && e.status === 400 && e.errors) return res.status(400).json({ message: req.__(e.message), errors: e.errors, missing: e.missing || [] });
		fail(req, res, e);
	}
});

router.post("/api/leads/similar/", auth.isAuthenticated, async (req, res) => {
	try {
		const b = req.body || {};
		res.json({ rows: await creator.similar(req, { phone: String(b.phone || "").slice(0, 64), email: String(b.email || "").slice(0, 255) }) });
	} catch (e) {
		fail(req, res, e);
	}
});

/* ═══ Скоринг: розклад балів ліда ═══ */

router.post("/api/leads/:id/score/", auth.isAuthenticated, async (req, res) => {
	try {
		const b = await require("../../controllers/leads/scoring").breakdown(leadId(req));
		if (!b) return res.status(404).json({ message: req.__("leads.server.not_found") });
		res.json({ auto: b.auto, fit: b.fit, activity: b.activity, items: b.items });
	} catch (e) {
		fail(req, res, e);
	}
});

/* ═══ Імпорт лідів з Excel / CSV ═══ */

const importer = require("../../controllers/leads/import");
const importUpload = require("multer")({ storage: require("multer").memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } }).single("file");
const canImport = (req) => auth.hasPermission(req, "leads.list", "add");
const importHandle = (fn) => async (req, res) => {
	if (!canImport(req)) return res.status(403).json({ message: req.__("leads.bulk.e.forbidden") });
	try {
		res.json(await fn(req));
	} catch (e) {
		if (e && e.status) return res.status(e.status).json({ message: req.__(e.message, e.params || {}) });
		logging.error(e);
		res.status(500).json({ message: req.__("leads.server.server") });
	}
};

router.get("/leads/import/", auth.isAuthenticated, async (req, res) => {
	if (!canImport(req)) return res.status(403).send(req.__("leads.bulk.e.forbidden"));
	try {
		const d = await creator.formDicts(req.user.id_lang || 1);
		res.render("pages/leads/import", { i18n: req, user: req.user, header: { navbar: "leads" }, ...d, targets: importer.TARGETS, recent: await importer.recent(uid(req)) });
	} catch (e) {
		logging.error(e);
		res.status(500).send(req.__("leads.server.server"));
	}
});

router.post(
	"/api/leads/import/upload/",
	auth.isAuthenticated,
	(req, res, next) =>
		importUpload(req, res, (err) => {
			if (err) return res.status(400).json({ message: req.__(err.code === "LIMIT_FILE_SIZE" ? "leads.import.e.big" : "leads.import.e.ext") });
			next();
		}),
	importHandle((req) => {
		if (!req.file) throw Object.assign(new Error("leads.work.e.no_file"), { status: 400 });
		return importer.upload(req.file.buffer, Buffer.from(req.file.originalname, "latin1").toString("utf8"), uid(req));
	})
);

router.post(
	"/api/leads/import/:iid/start/",
	auth.isAuthenticated,
	importHandle(async (req) => {
		const id = parseInt(req.params.iid, 10) || 0;
		const r = await importer.start(id, uid(req), req.body || {});
		require("../../controllers/common/audit").log(req, { action: "import", module: "leads", entity: "import", id_entity: id, count: r.total, details: { file: r.file_name } });
		return r;
	})
);
router.post("/api/leads/import/:iid/status/", auth.isAuthenticated, importHandle((req) => importer.status(parseInt(req.params.iid, 10) || 0, uid(req))));
router.post("/api/leads/import/:iid/cancel/", auth.isAuthenticated, importHandle((req) => importer.cancel(parseInt(req.params.iid, 10) || 0, uid(req))));

/* ═══ Збагачення ліда ═══ */

router.post("/api/leads/:id/enrich/", auth.isAuthenticated, async (req, res) => {
	try {
		const r = await require("../../controllers/leads/enrich").suggest(leadId(req));
		if (!r) return res.status(404).json({ message: req.__("leads.server.not_found") });
		res.json(r);
	} catch (e) {
		fail(req, res, e);
	}
});

module.exports = router;