"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const bulk = require("../../../controllers/catalog/products/bulk");
const jobs = require("../../../controllers/catalog/products/bulk-jobs");
const settings = require("../../../controllers/catalog/products/settings");
const editLock = require("../../../controllers/catalog/products/edit-lock");
const warehousesCtl = require("../../../controllers/catalog/products/warehouses");
const bulkMedia = require("../../../controllers/catalog/products/bulk-media");
const { validateBulk, validateJob, FIELD_DEFS, VARIANT_FIELD_DEFS } = require("../../../validator/catalog/products/bulk");
const { getIO } = require("../../../controllers/socket/socket");

const L = "products.list";
const can = (req, slug, action) => auth.hasPermission(req, slug, action);
const langOf = (req) => req.user.id_lang || 1;
// Залишки міняються складськими документами: запуск — право проводити, відміна — право скасовувати документи
const permsOf = (req) => ({
	edit: can(req, L, "edit"),
	delete: can(req, L, "delete"),
	costEdit: can(req, "products.cost", "edit"),
	stockEdit: can(req, "products.stock", "edit"),
	stockDelete: can(req, "products.stock", "delete"),
});
const intId = (v) => {
	const n = parseInt(v, 10);
	return String(n) === String(v) && n > 0 ? n : null;
};
const FILTER_KEYS = ["search", "status", "type", "id_brand", "id_category", "stock", "price_from", "price_to", "quality", "issue", "publish", "channel"];

/** JSON-відповідь; помилки з кодом — перекладом, решта — «помилка сервера» з записом у журнал */
const handle = (fn) => async (req, res) => {
	try {
		res.json({ ok: true, ...(await fn(req)) });
	} catch (e) {
		if (!e.status) logging.error(e);
		const msg = e.status === 403 ? "catalog.common.forbidden" : e.status ? e.message : "catalog.common.server_error";
		res.status(e.status || 500).json({ ok: false, error: req.__(msg), errors: e.errors });
	}
};
const need = (action) => (req, res, next) => (can(req, L, action) ? next() : res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") }));
const forbiddenPage = (req, res) => res.status(403).render("pages/error/404", { message: req.__("catalog.common.forbidden"), error: { status: 403 } });
const badRequest = (errors) => Object.assign(new Error("catalog.common.validation_error"), { status: 400, errors });
const notFound = () => Object.assign(new Error("catalog.bulk_job.e_not_found"), { status: 404 });

/** Підпис поля для перегляду й звіту: «Ціна», «Категорії»… (невідоме — як є) */
const FIELD_KEYS = { id_brand: "catalog.products.f.brand", id_category_main: "catalog.products.f.category", categories: "catalog.bulk.a_categories" };
function fieldLabel(req, field) {
	const v = /^variant\.(\d+)\.(.+)$/.exec(field);
	const base = v ? v[2] : field;
	const key = FIELD_KEYS[base] || `catalog.products.f.${base}`;
	let t = req.__(key);
	if (t === key) t = req.__(`catalog.bulk_new.f_${base}`);
	const label = t === `catalog.bulk_new.f_${base}` ? base : t;
	return v ? `${req.__("catalog.history.variant")} #${v[1]}: ${label}` : label;
}

/** Значення для перегляду: статус, видимість, так / ні — словами; суми — без зайвих нулів (100.0000 → 100) */
function valueText(req, field, v) {
	if (v === null || v === undefined || v === "") return null;
	// Фото: знімок медіа — коротко «Фото: 5, головне — №1, ALT: …»
	if (field === "media" && typeof v === "object") {
		const s = bulkMedia.summary(v, langOf(req));
		return [`${req.__("catalog.history.media_photos")}: ${s.n}`, s.cover ? `${req.__("catalog.history.media_cover")} — №${s.cover}` : "", s.alt ? `ALT: ${s.alt}` : ""].filter(Boolean).join(", ");
	}
	const base = field.split(".").pop();
	// Поле варіанта: статус варіанта — так / ні, «коли немає» — зі значенням «як у товару»
	const isVariant = /^variant\.\d+\./.test(field);
	if (base === "status" && !isVariant) return req.__(`catalog.products.status.${v}`);
	if (base === "visibility") return req.__(`catalog.bulk.visibility_${v}`);
	const def = isVariant ? VARIANT_FIELD_DEFS[base] : FIELD_DEFS[base];
	if (base === "is_featured" || base === "price_auto" || (def && def.t === "bool")) return req.__(String(v) === "1" || v === true ? "catalog.bulk.featured_yes" : "catalog.bulk.featured_no");
	if (def && def.t === "enum") return req.__(`catalog.bulk_new.fv_${base}_${v}`);
	if (def && def.t === "date") return String(v).slice(0, 10);
	if (typeof v === "string" && /^-?\d+\.\d+$/.test(v)) return String(Number(v));
	// Довгі тексти (описи) — у перегляді лише початок, без розмітки
	if (typeof v === "string" && v.length > 300) return v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) + "…";
	return v;
}

/** Текст повідомлення звіту: «відкрито в картці», «змінено пізніше»…; невідоме — як є */
function messageText(req, m) {
	const key = `catalog.bulk_job.m_${String(m || "").replace(/\s+/g, "_")}`;
	const t = req.__(key);
	return t === key ? String(m || "") : t;
}

/** Коротко, що робить дія: «Ціна: +10 %, округлення до .99», «Статус: Активний»… */
function opText(req, op, refs) {
	const p = op.params || {};
	const name = req.__(`catalog.bulk.a_${op.action}`);
	let what = "";
	switch (op.action) {
		case "status":
			what = req.__(`catalog.products.status.${p.status}`);
			break;
		case "visibility":
			what = req.__(`catalog.bulk.visibility_${p.visibility}`);
			break;
		case "featured":
			what = req.__(p.value ? "catalog.bulk.featured_yes" : "catalog.bulk.featured_no");
			break;
		case "brand":
			what = p.id_brand ? (refs.brands.get(p.id_brand) || "#" + p.id_brand) : req.__("catalog.bulk.brand_none");
			break;
		case "categories":
			what = `${req.__(`catalog.bulk.cat_${p.op}`)}: ${(p.ids || []).map((id) => refs.categories.get(id) || "#" + id).join(", ")}`;
			break;
		case "price": {
			const v = p.op === "percent" ? `${p.value > 0 ? "+" : ""}${p.value} %` : p.op === "amount" ? `${p.value > 0 ? "+" : ""}${p.value}` : `= ${p.value}`;
			what = `${req.__(`catalog.bulk.field_${p.field}`)} ${v}${p.round && p.round !== "none" ? ", " + req.__(`catalog.bulk.round_${p.round}`) : ""}`;
			break;
		}
		case "formula":
			what = req.__(p.on ? "catalog.bulk.formula_on" : "catalog.bulk.formula_off");
			break;
		case "fixed_price":
			what = `${p.code}: ${req.__(`catalog.bulk.fx_${p.op}`)}${p.op === "percent" ? ` ${p.value} %` : ""}`;
			break;
		case "currency":
			what = `${p.code || req.__("catalog.bulk.cur_base")} (${req.__(`catalog.bulk.cur_${p.mode}`)})`;
			break;
		case "field": {
			const v = p.op === "clear" ? "" : ` ${valueText(req, p.field, typeof p.value === "boolean" ? (p.value ? "1" : "0") : p.value)}`;
			what = `${fieldLabel(req, p.field)} — ${req.__(`catalog.bulk_new.op_${p.op}`)}${p.op === "replace" ? ` «${p.find}» →` : ""}${v}`;
			break;
		}
		case "media": {
			if (p.op === "cover") what = `${req.__("catalog.bulk_new.media_cover")}: ${p.pick === "position" ? `№${p.position}` : req.__(`catalog.bulk_new.media_pick_${p.pick}`)}${p.move_first ? `, ${req.__("catalog.bulk_new.media_move_first_short")}` : ""}`;
			else if (p.op === "remove") what = `${req.__("catalog.bulk_new.media_remove")}: ${req.__(`catalog.bulk_new.media_what_${p.what}`)}${p.what === "keep_first" ? ` ${p.keep}` : ""}`;
			else what = `${p.field === "title" ? "title" : "ALT"} — ${p.clear ? req.__("catalog.bulk_new.op_clear") : `«${p.template}»`}${p.langs && p.langs.length ? ` (${p.langs.map((l) => refs.langs.get(l) || l).join(", ")})` : ""}${p.only_empty ? ` (${req.__("catalog.bulk_new.only_empty_short")})` : ""}`;
			break;
		}
		case "variant_field": {
			const v = p.op === "clear" ? "" : ` ${valueText(req, `variant.0.${p.field}`, typeof p.value === "boolean" ? (p.value ? "1" : "0") : p.value)}`;
			what = `${req.__(`catalog.bulk_new.vf_${p.field}`)} — ${req.__(`catalog.bulk_new.op_${p.op}`)}${p.op === "replace" ? ` «${p.find}» →` : ""}${v}${p.only_empty ? ` (${req.__("catalog.bulk_new.only_empty_short")})` : ""}`;
			break;
		}
		case "text":
			what = `${fieldLabel(req, p.field)}${p.langs && p.langs.length ? ` (${p.langs.map((l) => refs.langs.get(l) || l).join(", ")})` : ""} — ${req.__(`catalog.bulk_new.top_${p.op}`)}${p.find ? ` «${p.find}»` : ""}${p.op !== "clear" && p.value ? ` → «${p.value.slice(0, 60)}»` : ""}`;
			break;
		case "seo":
			what = `${fieldLabel(req, p.field)}: «${p.template}»${p.only_empty ? ` (${req.__("catalog.bulk_new.only_empty_short")})` : ""}`;
			break;
		case "attribute":
			what = `${refs.attributes.get(p.id_attribute) || "#" + p.id_attribute} — ${req.__(p.op === "remove" ? "catalog.bulk_new.attr_remove" : "catalog.bulk_new.attr_set")}`;
			break;
		case "stock": {
			const q = Number(p.qty);
			what = `${refs.warehouses.get(p.id_warehouse) || "#" + p.id_warehouse} — ${p.op === "set" ? `= ${q}` : `${q > 0 ? "+" : ""}${q}`}`;
			break;
		}
		case "codes":
			what = p.code === "ean" ? req.__("catalog.bulk_new.codes_ean") : `${req.__("catalog.bulk_new.codes_sku")}${p.template ? ` «${p.template}»` : ""}`;
			break;
		default:
			what = "";
	}
	return what ? `${name}: ${what}` : name;
}

/** Назви брендів і категорій, згаданих у діях (для opText) */
async function opRefs(jobsList, idLang) {
	const has = (actions) => jobsList.some((j) => (j.operations || []).some((op) => actions.includes(op.action)));
	const warehouses = has(["stock"]) ? new Map((await warehousesCtl.list()).map((w) => [w.id, w.name])) : new Map();
	if (!has(["brand", "categories", "text", "attribute", "media"])) return { brands: new Map(), categories: new Map(), attributes: new Map(), langs: new Map(), warehouses };
	const r = await jobs.refs(idLang);
	return {
		warehouses,
		brands: new Map(r.brands.map((b) => [b.id, b.name])),
		categories: new Map(r.categories.map((c) => [c.id, c.name])),
		attributes: new Map(r.attributes.map((a) => [a.id, a.name])),
		langs: new Map(r.languages.map((l) => [l.id, l.code])),
	};
}

// ═══ Масові дії зі списку товарів (позначені, одразу) ═══
router.post("/api/catalog/products/bulk/", auth.isAuthenticated, async (req, res) => {
	try {
		if (!can(req, L, "view")) return res.status(403).json({ ok: false, error: req.__("catalog.common.forbidden") });

		const { value, error } = validateBulk(req.body || {});
		if (error) return res.status(400).json({ ok: false, error: req.__("catalog.common.validation_error"), errors: error });

		const result = await bulk.apply(value, { idUser: req.user.userId, perms: permsOf(req), logError: (e) => logging.error(e) });

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

		res.json({ ok: true, summary: result.summary, report: result.report.map((r) => (r.message ? { ...r, message: req.__(r.message) } : r)) });
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({
			ok: false,
			error: e.status === 403 ? req.__("catalog.common.forbidden") : e.status ? req.__(e.message) : req.__("catalog.common.server_error"),
			errors: e.errors,
		});
	}
});

// ═══ Масове редагування через чергу: журнал, конструктор, одна зміна ═══

router.get("/catalog/bulk/", auth.isAuthenticated, (req, res) => {
	if (!can(req, L, "view")) return forbiddenPage(req, res);
	res.render("pages/catalog/products/bulk-jobs", {
		i18n: req,
		user: req.user,
		header: { navbar: "catalog", subnavbar: "products_bulk" },
		perms: permsOf(req),
	});
});

router.get("/catalog/bulk/new/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, L, "edit")) return forbiddenPage(req, res);
	try {
		const all = await settings.getAll();
		const r = await jobs.refs(langOf(req));
		// Фільтри можна передати з адреси: кнопка в списку товарів передає поточні фільтри списку
		const q = req.query || {};
		const filter = {};
		for (const k of FILTER_KEYS) filter[k] = typeof q[k] === "string" ? q[k].slice(0, 200) : "";
		res.render("pages/catalog/products/bulk-new", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_bulk" },
			perms: permsOf(req),
			categories: r.categories.map((c) => ({ id: c.id, label: "  ".repeat(c.depth) + c.name })),
			brands: r.brands,
			channels: r.channels,
			attributes: r.attributes,
			languages: r.languages,
			// Поля для дії «Поле товару» групами (тип, значення переліку, чи можна очистити)
			fieldGroups: ["main", "shipping", "stock", "price"].map((g) => ({ group: g, fields: Object.entries(FIELD_DEFS).filter(([, d]) => d.group === g).map(([k, d]) => ({ key: k, t: d.t, values: d.values || [], nullable: !!d.nullable })) })),
			// Поля варіантів (дія «Поле варіантів»)
			variantFields: Object.entries(VARIANT_FIELD_DEFS).map(([k, d]) => ({ key: k, t: d.t, values: d.values || [], nullable: !!d.nullable })),
			// Шаблони: збережені зміни, з яких можна почати нову
			templates: await jobs.templates(),
			skuPattern: (all.sku && all.sku.pattern) || "",
			currency: all.prices.base_currency,
			currencies: (all.currencies.list || []).filter((c) => c.active !== false).map((c) => c.code).filter((c) => c !== all.prices.base_currency),
			publishing: all.publishing.enabled,
			// Склади для дії «Залишки» (лише з правом проводити складські документи)
			warehouses: can(req, "products.stock", "edit") ? (await warehousesCtl.list()).map((w) => ({ id: w.id, name: w.name, is_default: !!w.is_default })) : [],
			filter,
			preview: jobs.PREVIEW,
		});
	} catch (e) {
		next(e);
	}
});

router.get("/catalog/bulk/:id/", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, L, "view")) return forbiddenPage(req, res);
	const id = intId(req.params.id);
	if (!id) return next();
	try {
		const job = await jobs.get(id, langOf(req));
		const refs = await opRefs([job], langOf(req));
		res.render("pages/catalog/products/bulk-job", {
			i18n: req,
			user: req.user,
			header: { navbar: "catalog", subnavbar: "products_bulk" },
			perms: permsOf(req),
			job,
			// Тексти дій — тут (з назвами брендів і категорій), шаблон лише підставляє
			opTexts: job.operations.map((op) => opText(req, op, refs)),
		});
	} catch (e) {
		if (e.status === 404) return next();
		next(e);
	}
});

/** Значення характеристики — для вибору в дії «Характеристика» */
router.post(
	"/api/catalog/bulk/attribute-values/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId((req.body || {}).id_attribute);
		if (!id) throw notFound();
		return { values: await jobs.attrValues(id, langOf(req)) };
	})
);

/** Скільки товарів у наборі (фільтр або список) — лічильник у конструкторі */
router.post(
	"/api/catalog/bulk/count/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const { value, error } = validateJob({ selection: (req.body || {}).selection, operations: [{ action: "featured", params: { value: 1 } }] });
		if (error) throw badRequest(error);
		const r = await jobs.resolve(value.selection);
		return { total: r.ids.length, not_found: r.not_found, not_found_count: r.not_found_count };
	})
);

/** Перегляд «було → стане» на перших товарах набору (нічого не зберігає) */
router.post(
	"/api/catalog/bulk/preview/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const { value, error } = validateJob(req.body || {});
		if (error) throw badRequest(error);
		const r = await jobs.preview(value, { idUser: req.user.userId, perms: permsOf(req) }, langOf(req));
		r.sample.forEach((row) => {
			if (row.message) row.message_text = messageText(req, row.message);
			(row.changes || []).forEach((c) => {
				if (!c.label) c.label = fieldLabel(req, c.field);
				if (c.lang_code) c.label += ` (${c.lang_code})`;
				c.old = valueText(req, c.field, c.old);
				c.new = valueText(req, c.field, c.new);
			});
		});
		return r;
	})
);

/** Запустити: у чергу */
router.post(
	"/api/catalog/bulk/jobs/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const { value, error } = validateJob(req.body || {});
		if (error) throw badRequest(error);
		const r = await jobs.create(value, { idUser: req.user.userId, perms: permsOf(req), locale: req.getLocale ? req.getLocale() : "uk" });
		audit.log(req, { action: "update", module: "products", entity: "bulk_job", id_entity: r.id, count: r.total, details: { operations: value.operations, selection: value.selection.mode } });
		return r;
	})
);

/** Журнал (Tabulator: page, size, status, kind) */
router.post(
	"/api/catalog/bulk/jobs/list/",
	auth.isAuthenticated,
	need("view"),
	handle(async (req) => {
		const r = await jobs.list(req.body || {});
		const refs = await opRefs(r.data, langOf(req));
		r.data.forEach((j) => (j.op_labels = (j.operations || []).map((op) => opText(req, op, refs))));
		return r;
	})
);

/** Одна зміна (стан і звіт) — оновлення сторінки зміни після завершення */
router.post(
	"/api/catalog/bulk/jobs/:id/",
	auth.isAuthenticated,
	need("view"),
	handle(async (req) => {
		const id = intId(req.params.id);
		if (!id) throw notFound();
		const job = await jobs.get(id, langOf(req));
		job.report.forEach((r) => {
			r.message_text = messageText(req, r.message);
			if (r.fields) r.fields_text = r.fields.map((f) => fieldLabel(req, f)).join(", ");
		});
		return { job };
	})
);

router.post(
	"/api/catalog/bulk/jobs/:id/cancel/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		if (!id) throw notFound();
		return jobs.cancel(id);
	})
);

/** Автоматична відміна в заданий час (або прибрати її): { revert_at: ISO | null } */
router.post(
	"/api/catalog/bulk/jobs/:id/revert-at/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		if (!id) throw notFound();
		const v = (req.body || {}).revert_at;
		if (v !== null && v !== undefined && v !== "") {
			const t = Date.parse(v);
			if (Number.isNaN(t) || t < Date.now() || t > Date.now() + 366 * 86400000) throw badRequest([{ field: "revert_at", message: "out of range" }]);
		}
		return jobs.setRevertAt(id, v ? new Date(v).toISOString() : null);
	})
);

/** «Створити таку саму»: набір і дії зміни — для конструктора */
router.post(
	"/api/catalog/bulk/jobs/:id/source/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		if (!id) throw notFound();
		return { source: await jobs.source(id) };
	})
);

/** Шаблон: зберегти зміну як шаблон (або прибрати) — { on: true | false } */
router.post(
	"/api/catalog/bulk/jobs/:id/template/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		if (!id) throw notFound();
		return jobs.setTemplate(id, !!(req.body || {}).on);
	})
);

/**
 * Звіт зміни в Excel: кожен змінений товар — по рядку на поле («було → стало»), далі пропущені й помилки.
 * Пишеться потоком — і на сотні тисяч рядків пам'яті не забирає.
 */
router.get("/catalog/bulk/:id/report.xlsx", auth.isAuthenticated, async (req, res, next) => {
	if (!can(req, L, "view")) return forbiddenPage(req, res);
	const id = intId(req.params.id);
	if (!id) return next();
	try {
		const job = await jobs.get(id, langOf(req));
		const ExcelJS = require("exceljs");
		const history = require("../../../controllers/catalog/products/history");
		res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
		res.setHeader("Content-Disposition", `attachment; filename="bulk-${job.id}.xlsx"`);
		res.setHeader("Cache-Control", "no-store");
		const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true, useSharedStrings: false });
		const ws = wb.addWorksheet(req.__("catalog.bulk_job.title") + " " + job.id);
		ws.columns = [
			{ header: "ID", key: "id", width: 10 },
			{ header: req.__("catalog.products.f.sku"), key: "sku", width: 18 },
			{ header: req.__("catalog.bulk_job.col_product"), key: "name", width: 40 },
			{ header: req.__("catalog.bulk_job.col_status"), key: "status", width: 14 },
			{ header: req.__("catalog.bulk_new.col_field"), key: "field", width: 28 },
			{ header: req.__("catalog.bulk_new.col_old"), key: "old", width: 40 },
			{ header: req.__("catalog.bulk_new.col_new"), key: "new", width: 40 },
			{ header: req.__("catalog.bulk_job.col_message"), key: "message", width: 40 },
		];
		ws.getRow(1).font = { bold: true };
		ws.getRow(1).commit();
		const text = (v) => {
			if (v === null || v === undefined) return "";
			if (typeof v === "object") return Array.isArray(v) ? v.join(", ") : v.preview || JSON.stringify(v);
			return String(v).slice(0, 32000);
		};
		// Змінені товари — з пакета історії цієї зміни (для відміни — з пакета зміни-джерела не беремо: її звіт окремий)
		if (job.kind === "edit" && job.batch) {
			const lines = (await history.batchLines(job.batch)).filter((l) => l.entity === "products");
			for (let i = 0; i < lines.length; i += 500) {
				const part = lines.slice(i, i + 500);
				const names = await jobs.names(part.map((l) => Number(l.id)), langOf(req));
				const rows = [];
				for (const l of part) {
					const ev = await history.eventAt("products", l.id, l.ts);
					const n = names.get(Number(l.id)) || {};
					for (const c of (ev && ev.changes) || []) {
						rows.push({ id: l.id, sku: n.sku || "", name: n.name || "", status: req.__("catalog.bulk_jobs.changed"), field: fieldLabel(req, c.field) + (c.lang ? ` (${c.lang})` : ""), old: text(c.old), new: text(c.new), message: "" });
					}
				}
				for (const r of rows) ws.addRow(r).commit();
			}
		}
		// Залишки: рухи проведення документів зміни — «було → стало» по складу й варіанту
		if (job.kind === "edit" && job.stock) {
			for await (const part of jobs.stockMovements(job.id)) {
				const names = await jobs.names([...new Set(part.map((m) => Number(m.id_product)))], langOf(req));
				for (const m of part) {
					const n = names.get(Number(m.id_product)) || {};
					ws.addRow({
						id: m.id_product,
						sku: n.sku || "",
						name: n.name || "",
						status: req.__("catalog.bulk_jobs.changed"),
						field: `${req.__("catalog.bulk.a_stock")}: ${m.warehouse}${m.id_variant ? ` · ${m.variant_sku || "#" + m.id_variant}` : ""}`,
						old: String(Number(m.qty_before)),
						new: String(Number(m.qty_after)),
						message: m.number,
					}).commit();
				}
			}
		}
		for (const r of job.report) {
			ws.addRow({
				id: r.id,
				sku: r.sku || "",
				name: r.name || "",
				status: req.__(r.status === "error" ? "catalog.bulk_jobs.errors" : "catalog.bulk_jobs.skipped"),
				field: (r.fields || []).map((f) => fieldLabel(req, f)).join(", "),
				old: "",
				new: "",
				message: [messageText(req, r.message), r.user_name].filter(Boolean).join(": "),
			}).commit();
		}
		ws.commit();
		await wb.commit();
	} catch (e) {
		if (e.status === 404) return next();
		logging.error(e);
		if (!res.headersSent) return next(e);
		res.end();
	}
});

router.post(
	"/api/catalog/bulk/jobs/:id/resume/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		if (!id) throw notFound();
		return jobs.resume(id);
	})
);

router.post(
	"/api/catalog/bulk/jobs/:id/revert/",
	auth.isAuthenticated,
	need("edit"),
	handle(async (req) => {
		const id = intId(req.params.id);
		if (!id) throw notFound();
		const r = await jobs.revert(id, { idUser: req.user.userId, perms: permsOf(req), locale: req.getLocale ? req.getLocale() : "uk" });
		audit.log(req, { action: "revert", module: "products", entity: "bulk_job", id_entity: id, details: { revert_job: r.id } });
		return r;
	})
);

module.exports = router;