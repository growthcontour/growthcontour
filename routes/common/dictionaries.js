"use strict";

/**
 * Налаштування довідників модулів (клієнти, ліди, угоди) — одна сторінка й один API на всі модулі.
 * Поля форм редактор бере зі схеми бази (controllers/common/dictEditor.js); тут — лише перелік довідників і права.
 *
 *   GET  /clients/settings/, /leads/settings/, /deals/settings/
 *   POST /api/<module>/settings/dicts/                — опис довідників
 *   POST /api/<module>/settings/dicts/:key/list|save|delete|sort/
 */
const express = require("express");
const router = express.Router();

const auth = require("../../controllers/authorization/authorization");
const logging = require("../../logging/logging").child("dictionaries");
const audit = require("../../controllers/common/audit");
const { createEditor } = require("../../controllers/common/dictEditor");

const langs = async () => (await require("../../controllers/clients/dictionaries").languages()).list;

/**
 * Клієнти: свій контролер довідників (controllers/clients/settings) зі своїм форматом —
 * адаптер приводить його до формату спільної сторінки (поля, переклади, варіанти списків кожною мовою).
 */
function clientsEditor() {
	const cs = require("../../controllers/clients/settings");
	const typeOf = (f) => (f.type === "bool" ? { type: "bool" } : f.type === "select" ? { type: "select", options: f.options } : { type: "text", max: f.max || 255 });
	return {
		async describe() {
			return (await cs.describe()).map((d) => ({
				key: d.key,
				fk: "id",
				sort: "sort",
				active: "active",
				system: d.hasSystem,
				fields: [
					{ name: "code", type: "text", max: 32 },
					...d.fields.map((f) => ({ name: f.name, required: !!f.required, ...typeOf(f) })),
					...(d.hasColors ? [{ name: "color_text", type: "color" }, { name: "color_background", type: "color" }] : []),
					...(d.hasIcon ? [{ name: "icon", type: "text", max: 64 }] : []),
				],
				lang: d.lang.map((f) => ({ name: f.name, required: !!f.required, type: "text", max: 255 })),
				children: d.hasOptions ? { i18n: true } : null,
			}));
		},
		async list(key) {
			const rows = await cs.listRows(key);
			// Варіанти: [{ i18n: { idLang: name } }] → { idLang: [name, …] }
			return rows.map((r) => {
				if (!r.options) return r;
				const byLang = {};
				r.options.filter((o) => Number(o.active) !== 0).forEach((o) => Object.entries(o.i18n || {}).forEach(([l, n]) => (byLang[l] = byLang[l] || []).push(n)));
				return { ...r, options: byLang };
			});
		},
		save: (key, id, b) => cs.saveRow(key, id, b),
		remove: (key, id) => cs.deleteRow(key, id),
		sort: (key, ids) => cs.sortRows(key, ids),
	};
}

const MODULES = {
	clients: {
		slug: "clients.settings",
		viewAction: "edit", // довідники клієнтів — лише для тих, хто їх редагує
		back: "/clients/",
		editor: clientsEditor(),
	},
	leads: {
		slug: "leads.settings",
		back: "/leads/",
		editor: createEditor({
			langs,
			dicts: {
				statuses: { table: "leads_settings_status", usage: { table: "leads", col: "id_status" } },
				pipelines: { table: "leads_pipelines", usage: { table: "leads", col: "id_pipeline" } },
				stages: { table: "leads_pipeline_stages", usage: { table: "leads", col: "id_stage" } },
				sources: { table: "leads_sources", usage: { table: "leads", col: "id_source" } },
				tags: { table: "leads_tags", usage: { table: "leads_tags_rel", col: "id_tag" } },
				temperatures: { table: "leads_temperatures", usage: { table: "leads", col: "id_temperature" } },
				qualifications: { table: "leads_qualifications", usage: { table: "leads", col: "id_qualification" } },
				priorities: { table: "leads_priorities", usage: { table: "leads", col: "id_priority" } },
				loss_reasons: { table: "leads_loss_reasons", usage: { table: "leads", col: "id_reason" } },
			},
		}),
	},
	deals: {
		slug: "deals.settings",
		back: "/deals",
		editor: createEditor({
			langs,
			dicts: {
				custom_fields: { table: "deals_custom_field", usage: { table: "deals_custom_field_value", col: "id_custom_field" }, children: { table: "deals_custom_field_option", fk: "id_custom_field", name: "name", sort: "sort_order", active: "active" } },
				pipelines: { table: "deals_pipeline", usage: { table: "deals", col: "id_pipeline" } },
				stages: { table: "deals_stage", usage: { table: "deals", col: "id_stage" } },
				types: { table: "deals_type", usage: { table: "deals", col: "id_deal_type" } },
				sources: { table: "deals_source", usage: { table: "deals", col: "id_source" } },
				lost_reasons: { table: "deals_lost_reason", usage: { table: "deals", col: "id_lost_reason" } },
				item_types: { table: "deals_item_type" },
				units: { table: "deals_unit" },
				taxes: { table: "deals_tax" },
				activity_types: { table: "deals_activity_type", usage: { table: "deals_activity", col: "id_activity_type" } },
				file_categories: { table: "deals_file_category" },
				quote_statuses: { table: "deals_quote_status" },
				invoice_statuses: { table: "deals_invoice_status" },
				contract_types: { table: "deals_contract_type" },
				contract_statuses: { table: "deals_contract_status" },
				calendar_event_types: { table: "deals_calendar_event_type" },
			},
		}),
	},
};

const modOf = (req) => {
	const m = MODULES[req.params.module];
	if (!m) throw Object.assign(new Error("Not found"), { status: 404 });
	return m;
};
const id = (v) => {
	const n = parseInt(v, 10);
	return n > 0 ? n : null;
};
// Перегляд — view, зміни — edit права налаштувань модуля
const need = (action) => (req, res, next) => {
	const m = MODULES[req.params.module];
	if (!m) return res.status(404).json({ ok: false });
	const act = action === "view" && m.viewAction ? m.viewAction : action;
	return auth.hasPermission(req, m.slug, act) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") });
};
const handle = (fn) => async (req, res) => {
	try {
		res.json({ ok: true, ...(await fn(req)) });
	} catch (e) {
		if (!e.status) logging.error(e);
		const params = { ...(e.params || {}) };
		if (params.field) params.field = req.__("dicts.f." + params.field);
		const msg = e.status ? (/^used/.test(e.message) ? req.__("dicts.e_used", { n: e.message.split(":")[1] || "" }) : e.message === "system" ? req.__("dicts.e_system") : req.__(e.message, params)) : req.__("catalog.common.server_error");
		res.status(e.status || 500).json({ ok: false, error: msg });
	}
};

router.get(["/clients/settings/", "/leads/settings/", "/deals/settings/"], auth.isAuthenticated, async (req, res, next) => {
	const module = req.path.split("/")[1];
	const m = MODULES[module];
	if (!m) return next();
	if (!auth.hasPermission(req, m.slug, m.viewAction || "view") && !auth.hasPermission(req, m.slug, "edit")) return res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden") });
	try {
		const dicts = await m.editor.describe();
		const languages = await langs();
		// відкритий довідник — з ?d=, інакше перший
		const cur = dicts.find((d) => d.key === String(req.query.d || "")) || dicts[0] || null;
		// варіанти для полів-посилань (id → назва основною мовою)
		const deflang = languages.length ? languages[0].id : 1;
		const nameof = (r) => {
			const t = (r.i18n && r.i18n[deflang]) || {};
			return t.name || t.title || t.label || r.name || r.title || r.label || r.code || "#" + r.id;
		};
		const refs = {};
		for (const f of cur ? cur.fields.filter((x) => x.type === "ref") : []) {
			if (!refs[f.ref]) refs[f.ref] = (await m.editor.list(f.ref)).map((r) => ({ id: r.id, label: nameof(r) }));
		}
		res.render("pages/common/dictionaries", {
			i18n: req,
			user: req.user,
			header: { navbar: module },
			module,
			back: m.back,
			canEdit: auth.hasPermission(req, m.slug, "edit"),
			dicts,
			cur,
			refs,
			langs: languages,
		});
	} catch (e) {
		next(e);
	}
});

router.post("/api/:module/settings/dicts/", auth.isAuthenticated, need("view"), handle(async (req) => ({ dicts: await modOf(req).editor.describe() })));
router.post("/api/:module/settings/dicts/:key/list/", auth.isAuthenticated, need("view"), handle(async (req) => ({ rows: await modOf(req).editor.list(req.params.key) })));
router.post(
	"/api/:module/settings/dicts/:key/save/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const b = req.body || {};
		const r = await modOf(req).editor.save(req.params.key, id(b.id), b);
		audit.log(req, { action: b.id ? "update" : "create", module: req.params.module, entity: "dict:" + req.params.key, id_entity: r.id, count: 1 });
		return r;
	})
);
router.post(
	"/api/:module/settings/dicts/:key/delete/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const r = await modOf(req).editor.remove(req.params.key, id((req.body || {}).id));
		audit.log(req, { action: "delete", module: req.params.module, entity: "dict:" + req.params.key, id_entity: id((req.body || {}).id), count: 1 });
		return r;
	})
);
router.post("/api/:module/settings/dicts/:key/sort/", auth.isAuthenticated, need("edit"), handle(async (req) => modOf(req).editor.sort(req.params.key, (req.body || {}).ids)));

module.exports = router;