"use strict";
/**
 * Адмінка розсилок. Сторінки — GET /mailing/..., дії — POST /api/mailing/...
 * Доступ: createGuard (авторизація + права за slug). Публічні адреси (routes/mailing/public.js) виключені.
 * Відповідь помилки: { ok:false, status:"error", error:<код>, message:<переклад>, errors?:[{field,message}] }
 */
const express = require("express");
const { createGuard } = require("../../controllers/common/accessGuard");
const logging = require("../../logging/logging");
const audit = require("../../controllers/common/audit");
const { v } = require("../../validator/mailing/mailing");

const model = require("../../controllers/mailing/model");
const sender = require("../../controllers/mailing/sender");
const audience = require("../../controllers/mailing/audience");
const contacts = require("../../controllers/mailing/contacts");
const campaigns = require("../../controllers/mailing/campaigns");
const importer = require("../../controllers/mailing/import");
const automations = require("../../controllers/mailing/automations");

const router = express.Router();

// Express 5: регулярки в шляхах не підтримуються — id перевіряємо тут.
// Не число → маршрут пропускається (напр. /senders/save не потрапить у /senders/:id)
for (const p of ["id", "variant", "run"]) {
	router.param(p, (req, res, next, val) => (/^[1-9][0-9]{0,9}$/.test(String(val)) ? next() : next("route")));
}

// ─── ДОСТУП ─────────────────────────────────────────────
const RES = {
	campaigns: "mailing.campaigns",
	automations: "mailing.campaigns",
	audience: "mailing.campaigns",
	templates: "mailing.templates",
	contacts: "mailing.contacts",
	lists: "mailing.contacts",
	fields: "mailing.contacts",
	suppressions: "mailing.contacts",
	import: "mailing.contacts",
	senders: "mailing.settings",
	settings: "mailing.settings",
};

const rules = [
	// Запуск/зупинка розсилки — окреме право
	{ re: /^\/api\/mailing\/campaigns\/\d+\/(schedule|unschedule|pause|resume|cancel)\/$/, slug: "mailing.send", action: "edit" },
	{ re: /^\/api\/mailing\/automations\/\d+\/(activate|pause|enroll)\/$/, slug: "mailing.send", action: "edit" },
	{ re: /^\/api\/mailing\/automations\/\d+\/runs\/\d+\/exit\/$/, slug: "mailing.campaigns", action: "edit" },
];
for (const [res, slug] of Object.entries(RES)) {
	rules.push({ re: new RegExp(`^\\/api\\/mailing\\/${res}\\/(.*\\/)?(delete|erase)\\/$`), slug, action: "delete" });
	rules.push({ re: new RegExp(`^\\/api\\/mailing\\/${res}\\/(.*\\/)?(save|copy|upload|start|cancel|test|dns|add|subscriptions|compile|apply-template|resend|unsuppress)\\/$`), slug, action: "edit" });
	rules.push({ re: new RegExp(`^\\/api\\/mailing\\/${res}\\/`), slug, action: "view" });
}
rules.push(
	{ re: /^\/mailing\/(contacts|import)\//, slug: "mailing.contacts", action: "view" },
	{ re: /^\/mailing\/templates\//, slug: "mailing.templates", action: "view" },
	{ re: /^\/mailing\/settings\//, slug: "mailing.settings", action: "view" },
	{ re: /^\/mailing\//, slug: "mailing.campaigns", action: "view" },
	// Контент і картинки — спільні для шаблонів і кампаній: право перевіряє editorAccess нижче
	{ re: /^\/api\/mailing\/(?!content\/|images\/)/, slug: "mailing.settings", action: "edit" } // невідомий API — найсуворіше право
);

const access = createGuard({
	match: /^\/(api\/)?mailing(\/|$)/,
	publicPaths: [/^\/mailing\/(open|click|view|unsubscribe|preferences|confirm)\//, /^\/api\/mailing\/(unsubscribe|preferences|confirm)\//, /^\/api\/mailing\/subscribe\/$/],
	allSlug: "mailing.campaigns",
	table: "mailing_campaigns",
	ownerCol: "id_user",
	rules,
});
router.use(access.guard);

// ─── ДОПОМІЖНЕ ──────────────────────────────────────────
const userOf = (req) => req.user.userId || req.user.id;
const idOf = (req, k = "id") => parseInt(req.params[k], 10);
const tr = (req, key, vars) => (typeof req.__ === "function" ? req.__(key, vars || {}) : key);

function fail(req, res, e) {
	if (!e.status) logging.error(e);
	const code = e.status ? e.message : "server_error";
	const p = e.payload || {};
	const body = { ok: false, status: "error", error: code, message: tr(req, "mailing.errors." + code) };
	if (Array.isArray(p.errors) && p.errors.length) body.errors = p.errors.map((x) => ({ field: x.field, message: tr(req, "mailing.validation." + x.message) }));
	if (Array.isArray(p.problems)) body.problems = p.problems;
	if (p.detail) body.detail = p.detail;
	res.status(e.status || 500).json(body);
}

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req, res));
	} catch (e) {
		fail(req, res, e);
	}
};

/** Валідація тіла; помилка → 400 зі списком полів */
function body(req, schema) {
	const r = v(schema, req.body || {});
	if (!r.valid) throw model.err(400, "validation_error", { errors: r.errors });
	return r.data;
}

const ctx = (req, source) => model.ctxFromReq(req, source);
const log = (req, action, entity, id, details) => audit.log(req, { action, module: "mailing", entity, id_entity: id || null, count: 1, details });

const page = (view, subnavbar, extra) => (req, res) =>
	res.render(
		"pages/mailing/" + view,
		{
			i18n: req,
			user: req.user,
			header: { navbar: "mailing", subnavbar },
			data: extra ? extra(req) : {},
		},
		(e, html) => {
		if (e) {
			logging.error(e);
			return res.status(500).send(tr(req, "mailing.errors.server_error"));
		}
		res.send(html);
		}
	);

// ═══ СТОРІНКИ ═══════════════════════════════════════════
router.get("/mailing/", page("index", "mailing_campaigns"));
router.get("/mailing/campaigns/:id/", page("campaign", "mailing_campaigns", (req) => ({ id: idOf(req) })));
router.get("/mailing/campaigns/:id/report/", page("report", "mailing_campaigns", (req) => ({ id: idOf(req) })));
router.get("/mailing/contacts/", page("contacts", "mailing_contacts"));
router.get("/mailing/contacts/:id/", page("contact", "mailing_contacts", (req) => ({ id: idOf(req) })));
router.get("/mailing/import/", page("import", "mailing_contacts"));
router.get("/mailing/templates/", page("templates", "mailing_templates"));
router.get("/mailing/templates/:id/", page("editor", "mailing_templates", (req) => ({ owner_type: "template", id_owner: idOf(req) })));
router.get("/mailing/campaigns/:id/variants/:variant/", page("editor", "mailing_campaigns", (req) => ({ owner_type: "variant", id_owner: idOf(req, "variant"), id_campaign: idOf(req) })));
router.get("/mailing/settings/", page("settings", "mailing_settings"));
router.get("/mailing/automations/", page("automations", "mailing_automations"));
router.get("/mailing/automations/:id/", page("automation", "mailing_automations", (req) => ({ id: idOf(req) })));

// Звіт імпорту — лише з авторизацією, як завантаження (не через статику)
router.get("/mailing/import/:id/report/", async (req, res) => {
	try {
		const f = await importer.reportFile(idOf(req));
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.download(f.full, f.name);
	} catch (e) {
		res.status(e.status || 500).send(tr(req, "mailing.errors." + (e.status ? e.message : "server_error")));
	}
});

// ═══ НАЛАШТУВАННЯ ═══════════════════════════════════════
router.post("/api/mailing/settings/", handle(() => model.getSettings(true)));
router.post(
	"/api/mailing/settings/save",
	handle(async (req) => {
		const d = body(req, "settings");
		if (d.default_timezone && !model.isValidTz(d.default_timezone)) throw model.err(400, "validation_error", { errors: [{ field: "default_timezone", message: "invalid" }] });
		if (d.default_id_lang && !(await model.languages()).has(d.default_id_lang)) throw model.err(400, "validation_error", { errors: [{ field: "default_id_lang", message: "invalid" }] });
		const r = await model.saveSettings(d);
		log(req, "update", "settings", null, Object.keys(d));
		return { ok: true, settings: r };
	})
);

// ═══ ВІДПРАВНИКИ ════════════════════════════════════════
router.post("/api/mailing/senders/list", handle(() => sender.list()));
router.post(
	"/api/mailing/senders/:id",
	handle(async (req) => {
		const s = await sender.getPublic(idOf(req));
		if (!s) throw model.err(404, "not_found");
		return s;
	})
);
router.post(
	"/api/mailing/senders/save",
	handle(async (req) => {
		const id = parseInt((req.body || {}).id, 10) || null;
		const r = await sender.save(id, body(req, "sender"));
		log(req, id ? "update" : "create", "sender", r.id);
		return r;
	})
);
router.post(
	"/api/mailing/senders/:id/delete",
	handle(async (req) => {
		const r = await sender.remove(idOf(req), userOf(req));
		log(req, "delete", "sender", idOf(req));
		return r;
	})
);
router.post(
	"/api/mailing/senders/:id/test",
	handle((req) => sender.test(idOf(req), body(req, "senderTest").to || null, typeof req.getLocale === "function" ? req.getLocale() : "en"))
);
router.post("/api/mailing/senders/:id/dns", handle((req) => sender.checkDns(idOf(req))));

// ═══ СПИСКИ ═════════════════════════════════════════════
router.post("/api/mailing/lists/list", handle((req) => model.lists(req.user.id_lang, { withCounts: true })));
router.post(
	"/api/mailing/lists/:id",
	handle(async (req) => {
		const l = await model.getList(idOf(req));
		if (!l) throw model.err(404, "not_found");
		return l;
	})
);
router.post(
	"/api/mailing/lists/save",
	handle(async (req) => {
		const id = parseInt((req.body || {}).id, 10) || null;
		const r = await model.saveList(id, body(req, "list"));
		log(req, id ? "update" : "create", "list", r.id);
		return r;
	})
);
router.post(
	"/api/mailing/lists/:id/delete",
	handle(async (req) => {
		const r = await model.deleteList(idOf(req), userOf(req));
		log(req, "delete", "list", idOf(req));
		return r;
	})
);

// ═══ ПОЛЯ ═══════════════════════════════════════════════
router.post("/api/mailing/fields/list", handle(() => model.fields()));
router.post(
	"/api/mailing/fields/save",
	handle(async (req) => {
		const d = body(req, "field");
		await model.ensureField(null, d.code, d.name, d.type);
		return { ok: true };
	})
);
router.post("/api/mailing/fields/:id/delete", handle((req) => model.deleteField(idOf(req))));

// ═══ КОНТАКТИ ═══════════════════════════════════════════
router.post("/api/mailing/contacts/list", handle((req) => contacts.list(body(req, "grid"))));
router.post("/api/mailing/contacts/:id", handle((req) => contacts.detail(idOf(req), req.user.id_lang)));
router.post(
	"/api/mailing/contacts/save",
	handle(async (req) => {
		const id = parseInt((req.body || {}).id, 10) || null;
		const r = await contacts.save(id, body(req, "contact"), ctx(req, "admin"));
		log(req, id ? "update" : "create", "contact", r.id);
		return r;
	})
);
router.post(
	"/api/mailing/contacts/:id/subscriptions",
	handle((req) => contacts.setSubscriptions(idOf(req), body(req, "subscriptions").lists, ctx(req, "admin")))
);
router.post(
	"/api/mailing/contacts/:id/delete",
	handle(async (req) => {
		const r = await model.deleteContact(idOf(req), userOf(req));
		log(req, "delete", "contact", idOf(req));
		return r;
	})
);
router.post(
	"/api/mailing/contacts/:id/erase",
	handle(async (req) => {
		const r = await model.eraseContact(idOf(req), ctx(req, "admin"));
		log(req, "erase", "contact", idOf(req));
		return r;
	})
);

// ═══ СТОП-ЛИСТ ══════════════════════════════════════════
router.post("/api/mailing/suppressions/list", handle((req) => contacts.suppressions(body(req, "grid"))));
router.post(
	"/api/mailing/suppressions/add",
	handle(async (req) => {
		const d = body(req, "suppression");
		const r = await model.suppress(null, { ...d, reason: "manual", id_user: userOf(req) });
		log(req, "create", "suppression", null, { type: d.type, value: r.value });
		return r;
	})
);
router.post(
	"/api/mailing/suppressions/:id/delete",
	handle(async (req) => {
		const r = await model.unsuppress(idOf(req), ctx(req, "admin"));
		log(req, "delete", "suppression", idOf(req));
		return r;
	})
);

// ═══ ІМПОРТ ═════════════════════════════════════════════
router.post(
	"/api/mailing/import/upload",
	importer.uploadMiddleware,
	handle(async (req) => {
		const r = await importer.register(req.file, userOf(req));
		log(req, "upload", "import", r.id);
		return r;
	})
);
router.post("/api/mailing/import/list", handle((req) => importer.list(body(req, "grid"))));
router.post("/api/mailing/import/:id", handle((req) => importer.status(idOf(req))));
router.post("/api/mailing/import/:id/preview", handle((req) => importer.preview(idOf(req))));
router.post(
	"/api/mailing/import/:id/start",
	handle(async (req) => {
		const r = await importer.start(idOf(req), req.body || {}, userOf(req)); // import.js валідує мапінг і опції сам
		log(req, "start", "import", idOf(req));
		return r;
	})
);
router.post("/api/mailing/import/:id/cancel", handle((req) => importer.cancel(idOf(req))));

// ═══ ШАБЛОНИ І КОНТЕНТ ══════════════════════════════════
router.post("/api/mailing/templates/list", handle((req) => campaigns.templates(body(req, "grid"))));
router.post("/api/mailing/templates/:id", handle((req) => campaigns.template(idOf(req))));
router.post(
	"/api/mailing/templates/save",
	handle(async (req) => {
		const id = parseInt((req.body || {}).id, 10) || null;
		const r = await campaigns.saveTemplate(id, body(req, "template"), userOf(req));
		log(req, id ? "update" : "create", "template", r.id);
		return r;
	})
);
router.post("/api/mailing/templates/:id/copy", handle((req) => campaigns.copyTemplate(idOf(req), userOf(req))));
router.post(
	"/api/mailing/templates/:id/delete",
	handle(async (req) => {
		const r = await campaigns.deleteTemplate(idOf(req), userOf(req));
		log(req, "delete", "template", idOf(req));
		return r;
	})
);

// Контент і картинки: шаблон → mailing.templates, кампанія → mailing.campaigns; без типу — будь-яке з двох
function editorAccess(req, res, next) {
	const ownerType = (req.body || {}).owner_type;
	const ok =
		ownerType === "template"
			? access.can(req, "mailing.templates", "edit")
			: ownerType === "variant"
			? access.can(req, "mailing.campaigns", "edit")
			: access.can(req, "mailing.templates", "edit") || access.can(req, "mailing.campaigns", "edit");
	if (!ok) return fail(req, res, model.err(403, "forbidden"));
	next();
}
const contentAccess = editorAccess;
router.post("/api/mailing/content/save", contentAccess, handle((req) => campaigns.saveContent(body(req, "content"))));
router.post(
	"/api/mailing/content/delete",
	contentAccess,
	handle((req) => {
		const b = req.body || {};
		const idOwner = parseInt(b.id_owner, 10);
		const idLang = parseInt(b.id_lang, 10);
		if (!["template", "variant"].includes(b.owner_type) || !idOwner || !idLang) throw model.err(400, "invalid_request");
		return campaigns.deleteContent(b.owner_type, idOwner, idLang);
	})
);
router.post("/api/mailing/content/compile", editorAccess, handle((req) => campaigns.compile(body(req, "compile"))));
router.post("/api/mailing/images/upload", editorAccess, campaigns.imageUploadMiddleware, handle((req) => campaigns.saveImage(req.file)));

// ═══ АУДИТОРІЯ ══════════════════════════════════════════
router.post(
	"/api/mailing/audience/count",
	handle(async (req) => {
		const a = body(req, "audience").audience;
		return { count: await audience.count(a), preview: await audience.preview(a, 10) };
	})
);
router.post("/api/mailing/audience/fields", handle(async () => ({ fields: Object.keys(audience.FIELDS).map((k) => ({ code: k, type: audience.FIELDS[k].type })), ops: audience.OPS, custom: await model.fields() })));

// ═══ КАМПАНІЇ ═══════════════════════════════════════════
router.post("/api/mailing/campaigns/list", handle((req) => campaigns.campaigns(body(req, "grid"))));
router.post("/api/mailing/campaigns/:id", handle((req) => campaigns.getCampaign(idOf(req))));
router.post(
	"/api/mailing/campaigns/save",
	handle(async (req) => {
		const id = parseInt((req.body || {}).id, 10) || null;
		const r = await campaigns.saveCampaign(id, body(req, "campaign"), userOf(req));
		log(req, id ? "update" : "create", "campaign", r.id);
		return r;
	})
);
router.post(
	"/api/mailing/campaigns/:id/apply-template",
	handle((req) => {
		const b = req.body || {};
		const idVariant = parseInt(b.id_variant, 10);
		const idTemplate = parseInt(b.id_template, 10);
		if (!idVariant || !idTemplate) throw model.err(400, "invalid_request");
		return campaigns.applyTemplate(idOf(req), idVariant, idTemplate);
	})
);
router.post("/api/mailing/campaigns/:id/copy", handle((req) => campaigns.copyCampaign(idOf(req), userOf(req))));
router.post("/api/mailing/campaigns/:id/resend", handle((req) => campaigns.createResend(idOf(req), (req.body || {}).mode, userOf(req))));
router.post(
	"/api/mailing/campaigns/:id/delete",
	handle(async (req) => {
		const r = await campaigns.deleteCampaign(idOf(req), userOf(req));
		log(req, "delete", "campaign", idOf(req));
		return r;
	})
);
router.post("/api/mailing/campaigns/:id/check", handle((req) => campaigns.check(idOf(req))));
router.post("/api/mailing/campaigns/:id/test", handle((req) => campaigns.sendTest(idOf(req), body(req, "testSend"))));
for (const action of ["schedule", "unschedule", "pause", "resume", "cancel"]) {
	router.post(
		`/api/mailing/campaigns/:id/${action}`,
		handle(async (req) => {
			const r = await campaigns[action](idOf(req), userOf(req));
			log(req, action, "campaign", idOf(req));
			return r;
		})
	);
}
router.post("/api/mailing/campaigns/:id/stats", handle((req) => campaigns.stats(idOf(req))));
router.post("/api/mailing/campaigns/:id/recipients", handle((req) => campaigns.recipients(idOf(req), body(req, "grid"))));

// ═══ АВТОМАТИЗАЦІЇ ══════════════════════════════════════
router.post("/api/mailing/automations/list", handle((req) => automations.list(body(req, "grid"))));
router.post("/api/mailing/automations/:id", handle((req) => automations.get(idOf(req))));
router.post(
	"/api/mailing/automations/save",
	handle(async (req) => {
		const id = parseInt((req.body || {}).id, 10) || null;
		const r = await automations.save(id, body(req, "automation"), userOf(req));
		log(req, id ? "update" : "create", "automation", r.id);
		return r;
	})
);
router.post("/api/mailing/automations/:id/copy", handle((req) => automations.copy(idOf(req), userOf(req))));
router.post(
	"/api/mailing/automations/:id/delete",
	handle(async (req) => {
		const r = await automations.remove(idOf(req), userOf(req));
		log(req, "delete", "automation", idOf(req));
		return r;
	})
);
for (const action of ["activate", "pause"]) {
	router.post(
		`/api/mailing/automations/:id/${action}`,
		handle(async (req) => {
			const r = await automations[action](idOf(req), userOf(req));
			log(req, action, "automation", idOf(req));
			return r;
		})
	);
}
router.post(
	"/api/mailing/automations/:id/enroll",
	handle(async (req) => {
		const r = await automations.enrollNow(idOf(req));
		log(req, "enroll", "automation", idOf(req), { count: r.count });
		return r;
	})
);
router.post("/api/mailing/automations/:id/stats", handle((req) => automations.stats(idOf(req))));
router.post("/api/mailing/automations/:id/runs", handle((req) => automations.runsList(idOf(req), body(req, "grid"))));
router.post("/api/mailing/automations/:id/runs/:run/exit", handle((req) => automations.exitRun(idOf(req), idOf(req, "run"))));

module.exports = router;