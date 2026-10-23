"use strict";

/**
 * Імпорт товарів із сайту (модуль OpenCart 3) у систему.
 *
 * Режими:
 *  - dry   — тест без запису: зіставлення, перевірка всіма валідаторами картки, звіт «що буде зроблено»;
 *  - trial — пробний: реально імпортує перші N товарів (або вказані ID) і дає «Відкотити» все, що зробив;
 *  - full  — повний: увесь каталог порціями, з продовженням після зупинки.
 *
 * Зіставлення — ланцюжок правил у заданому порядку: зв'язок інтеграції → поле сайту ↔ поле системи (id, sku, model, ean, upc, mpn…).
 * Перше правило, що дало рівно один товар, — перемагає; кілька збігів = помилка «неоднозначно», товар не чіпаємо.
 */
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const logging = require("../../../logging/logging");
const i18n = require("../../../config/i18n/i18n");
const fs = require("fs");
const path = require("path");
const client = require("./sync-client");
const products = require("./products");
const categories = require("./categories");
const brands = require("./brands");
const attributes = require("./attributes");
const options = require("./options");
const slug = require("./slug");
const images = require("./images");
const languages = require("./languages");
const customerGroups = require("./customer-groups");
const settings = require("./settings");
const pricing = require("./pricing");
const sku = require("./sku");
const ean = require("./ean");
const stock = require("./stock");
const history = require("./history");
const descriptions = require("./descriptions");
const productOptions = require("./product-options");
const editLock = require("./edit-lock");
const quality = require("./quality");
const trash = require("../../common/trash");
const { validateCore, validateParts } = require("../../../validator/catalog/products/products");
const { validateDescriptions } = require("../../../validator/catalog/products/catalog");
const { validateProductOptions } = require("../../../validator/catalog/products/options");

const P = config.get("configDatabase").prefix;
const LOCALE = process.env.APP_LOCALE || "uk";

/*
 * Повідомлення звіту читаємо напряму з файлу перекладу (шлях від цього файлу, а не від робочої теки процесу),
 * тож вони не залежать від каталогу i18n. Немає мови — беремо українську; немає ключа — пробуємо i18n.
 */
let DICT = null;
function dict() {
	if (DICT) return DICT;
	for (const lang of [LOCALE, "uk"]) {
		try {
			const file = path.join(__dirname, "..", "..", "..", "locales", lang, "catalog", "products", "site-import.json");
			DICT = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")).catalog.site_import;
			return DICT;
		} catch (e) {
			logging.error(e);
		}
	}
	DICT = {};
	return DICT;
}
// {{x}} і {{{x}}} — як у mustache, але без HTML-екранування (звіт екранує сам)
const fill = (s, v) => String(s).replace(/\{\{\{?\s*(\w+)\s*\}?\}\}/g, (m, k) => (v[k] === undefined || v[k] === null ? "" : String(v[k])));
const t = (k, vars) => {
	const s = dict()[k];
	if (typeof s === "string") return fill(s, vars || {});
	const r = i18n.__({ phrase: `catalog.site_import.${k}`, locale: LOCALE }, vars || {});
	// Немає перекладу: для підписів полів — порожньо (покажемо як є), для решти — ключ
	return r === `catalog.site_import.${k}` && /^[fm]_/.test(k) ? "" : r;
};

const MODES = ["dry", "trial", "full"];
const SITE_FIELDS = ["id", "model", "sku", "ean", "upc", "mpn", "jan", "isbn"];
const CRM_FIELDS = ["id", "sku", "model", "ean", "upc", "mpn"];
const BATCH = 200; // товарів сайту за один запит (більше модуль не віддає)
const CONCURRENCY = 6; // товарів, що обробляються одночасно
const PHOTO_CONCURRENCY = 4; // фото одного товару, що завантажуються одночасно
const PREVIEW_MAX = 300; // повний «як буде в системі» зберігаємо лише для перших N товарів завдання
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const SKU_RE = /^[A-Za-z0-9_\-./]+$/;
const DEFAULT_MATCH = [{ site: "link" }, { site: "sku", crm: "sku" }, { site: "model", crm: "sku" }, { site: "ean", crm: "ean" }];

const running = new Map(); // id_job → { cancel: bool }

function httpErr(status, message, code) {
	const e = new Error(message);
	e.status = status;
	if (code) e.code = code;
	return e;
}

const clip = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const ocDate = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) && !String(v).startsWith("0000") ? String(v).slice(0, 10) : null);
const ocDateTime = (v) => (ocDate(v) ? `${ocDate(v)} 00:00:00` : null);
const key = (v) => String(v ?? "").trim().toLowerCase();

/* ═══ Опції ═══════════════════════════════════════════════════════════════ */

function normalizeOptions(mode, o = {}) {
	const bool = (v, d) => (v === undefined || v === null || v === "" ? d : v === true || v === 1 || v === "1" || v === "true");
	const pick = (v, list, d) => (list.includes(v) ? v : d);

	let match = Array.isArray(o.match) ? o.match : DEFAULT_MATCH;
	match = match
		.slice(0, 10)
		.map((r) => (r && r.site === "link" ? { site: "link" } : { site: String((r && r.site) || ""), crm: String((r && r.crm) || "") }))
		.filter((r) => r.site === "link" || (SITE_FIELDS.includes(r.site) && CRM_FIELDS.includes(r.crm)));
	// Однакові правила двічі — зайві
	match = match.filter((r, i) => match.findIndex((x) => x.site === r.site && x.crm === r.crm) === i);

	const ids = Array.isArray(o.ids) ? [...new Set(o.ids.map((x) => parseInt(x, 10)).filter((x) => x > 0))].slice(0, 500) : [];
	const maxLimit = mode === "trial" ? 500 : 10000000;
	const defLimit = mode === "trial" ? 20 : 0;
	let limit = parseInt(o.limit, 10);
	limit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, maxLimit) : defLimit;

	const langs = {};
	if (o.langs && typeof o.langs === "object") for (const [c, id] of Object.entries(o.langs)) if (parseInt(id, 10) > 0) langs[String(c)] = parseInt(id, 10);
	const groups = {};
	if (o.groups && typeof o.groups === "object") {
		for (const [g, id] of Object.entries(o.groups)) {
			const v = parseInt(id, 10);
			if (parseInt(g, 10) > 0 && Number.isInteger(v) && v >= -1) groups[parseInt(g, 10)] = v; // -1 — не переносити ціни цієї групи
		}
	}

	return {
		limit,
		ids,
		match,
		sku_from: pick(o.sku_from, ["sku", "model", "none"], "sku"),
		on_new: pick(o.on_new, ["create", "skip"], "create"),
		on_match: pick(o.on_match, ["link", "update"], "link"),
		// Що оновлювати у знайдених товарах: ціна / залишок / статус і вміст (назви й описи, коди, виробник, категорії, фото, атрибути, опції)
		update: Object.fromEntries(
			["price", "stock", "status", "names", "codes", "brand", "categories", "images", "attributes", "options"].map((k) => [k, bool(o.update && o.update[k], false)])
		),
		// Вміст: fill — лише порожнє, overwrite — замінити даними сайту
		content_mode: pick(o.content_mode, ["fill", "overwrite"], "fill"),
		status_new: pick(o.status_new, ["draft", "active", "site"], "draft"),
		categories: pick(o.categories, ["path", "match", "none"], "path"),
		brands: pick(o.brands, ["create", "match", "none"], "create"),
		images: bool(o.images, true),
		attributes: pick(o.attributes, ["create", "match", "none"], "create"),
		options: pick(o.options, ["create", "match", "none"], "create"),
		related: bool(o.related, true),
		id_warehouse: parseInt(o.id_warehouse, 10) > 0 ? parseInt(o.id_warehouse, 10) : null,
		langs,
		groups,
		link_site: bool(o.link_site, true),
	};
}

/* ═══ Довідники системи для модуля (вибір у формі) ═════════════════════════ */

async function systemOptions() {
	const [langs, groups, [whs], stockCfg, cx] = await Promise.all([
		languages.active(),
		customerGroups.options(),
		pool.query(`SELECT id, code, name FROM ${P}products_warehouses WHERE deleted_at IS NULL AND status = 1 ORDER BY sort_order, id`),
		settings.get("stock"),
		pricing.currencyCtx(),
	]);
	return {
		languages: langs.map((l) => ({ id: l.id, code: l.code, name: l.name, is_primary: l.is_primary })),
		customer_groups: groups.map((g) => ({ id: Number(g.id), name: g.name, is_default: Number(g.is_default) })),
		warehouses: whs.map((w) => ({ id: Number(w.id), code: w.code, name: w.name })),
		id_default_warehouse: stockCfg && stockCfg.id_default_warehouse ? Number(stockCfg.id_default_warehouse) : null,
		base_currency: cx.base,
		currencies: [cx.base, ...cx.list.map((c) => c.code)],
		match_site_fields: SITE_FIELDS,
		match_crm_fields: CRM_FIELDS,
		default_match: DEFAULT_MATCH,
	};
}

/** Інтеграції, з яких можна імпортувати (активні, з адресою API й ключем) */
async function integrations() {
	const [rows] = await pool.query(
		`SELECT id, name, platform, base_url FROM ${P}settings_integrations
		  WHERE status = 'active' AND callback_url IS NOT NULL AND callback_url <> '' AND CHAR_LENGTH(COALESCE(outbound_token, '')) >= 16
		  ORDER BY name`
	);
	return rows.map((r) => ({ id: Number(r.id), name: r.name, platform: r.platform, base_url: r.base_url }));
}

/** Мови, групи покупців і кількість товарів сайту (export.meta модуля) — для форми */
async function siteMeta(idIntegration) {
	const integ = await integrationRow(idIntegration);
	const m = await client.call(integ, "export.meta", {});
	return {
		languages: m.languages || [],
		customer_groups: m.customer_groups || [],
		default_customer_group: m.default_customer_group || null,
		currency: m.currency || null,
		products: (m.counts && m.counts.products) || 0,
	};
}

/* ═══ Завдання ════════════════════════════════════════════════════════════ */

async function integrationRow(id) {
	const [[row]] = await pool.query(`SELECT id, name, platform, base_url, callback_url, outbound_token, status FROM ${P}settings_integrations WHERE id = ?`, [id]);
	if (!row) throw httpErr(404, t("integration_not_found"));
	if (row.status !== "active") throw httpErr(409, t("integration_disabled"));
	return row;
}

const parseJson = (s, d) => {
	try {
		return s ? JSON.parse(s) : d;
	} catch {
		return d;
	}
};

function publicJob(j) {
	if (!j) return null;
	return {
		id: Number(j.id),
		mode: j.mode,
		source: j.source || "manual",
		status: j.status,
		options: parseJson(j.options, {}),
		total: Number(j.total),
		processed: Number(j.processed),
		created: Number(j.created),
		linked: Number(j.linked),
		updated: Number(j.updated),
		skipped: Number(j.skipped),
		errors: Number(j.errors),
		warnings: Number(j.warnings),
		cursor_after: Number(j.cursor_after),
		message: j.message,
		date_add: j.date_add,
		date_start: j.date_start,
		date_end: j.date_end,
		heartbeat: j.heartbeat,
		can_rollback: j.mode !== "dry" && ["done", "failed", "cancelled", "interrupted"].includes(j.status),
		can_resume: j.mode !== "dry" && ["failed", "cancelled", "interrupted"].includes(j.status),
	};
}

async function jobRow(idIntegration, idJob) {
	const [[j]] = await pool.query(`SELECT * FROM ${P}products_import_jobs WHERE id = ? AND id_integration = ?`, [idJob, idIntegration]);
	if (!j) throw httpErr(404, t("job_not_found"));
	return j;
}

/** Статус: конкретне завдання або останні 10 */
async function status(idIntegration, idJob) {
	// Завдання «running»/«queued», яких немає в пам'яті цього процесу, — перервані (перезапуск сервера)
	const alive = [...running.keys()];
	await pool.query(
		`UPDATE ${P}products_import_jobs SET status = 'interrupted', message = ?
		  WHERE id_integration = ? AND status IN ('queued','running','rolling_back') AND heartbeat < NOW() - INTERVAL 2 MINUTE${alive.length ? " AND id NOT IN (?)" : ""}`,
		alive.length ? [t("interrupted"), idIntegration, alive] : [t("interrupted"), idIntegration]
	);
	const [rows] = await pool.query(`SELECT * FROM ${P}products_import_jobs WHERE id_integration = ? ORDER BY id DESC LIMIT 10`, [idIntegration]);
	const jobs = rows.map(publicJob);
	const current = idJob ? publicJob(await jobRow(idIntegration, idJob)) : jobs[0] || null;
	return { job: current, jobs };
}

/** Рядки звіту: фільтр за дією, пошук, сторінки */
async function items(idIntegration, idJob, q = {}) {
	await jobRow(idIntegration, idJob);
	const page = Math.max(1, parseInt(q.page, 10) || 1);
	const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));
	const where = ["id_job = ?"];
	const args = [idJob];
	if (["create", "link", "update", "skip", "error"].includes(q.action)) {
		where.push("action = ?");
		args.push(q.action);
	}
	if (q.warnings === true || q.warnings === "1") where.push("warnings IS NOT NULL");
	if (q.search) {
		where.push("(external_sku LIKE ? OR name LIKE ? OR external_id = ?)");
		const like = "%" + String(q.search).replace(/[\\%_]/g, "\\$&") + "%";
		args.push(like, like, parseInt(q.search, 10) || 0);
	}
	const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products_import_items WHERE ${where.join(" AND ")}`, args);
	const [rows] = await pool.query(
		`SELECT id, external_id, external_sku, name, action, matched_by, id_product, message, warnings, preview
		   FROM ${P}products_import_items WHERE ${where.join(" AND ")} ORDER BY id LIMIT ? OFFSET ?`,
		[...args, limit, (page - 1) * limit]
	);
	return {
		total: Number(n),
		page,
		pages: Math.max(1, Math.ceil(Number(n) / limit)),
		items: rows.map((r) => ({ ...r, warnings: parseJson(r.warnings, null), preview: parseJson(r.preview, null) })),
	};
}

async function start(idIntegration, body = {}, idUser = null, source = "manual") {
	const integ = await integrationRow(idIntegration);
	const [[busy]] = await pool.query(`SELECT id FROM ${P}products_import_jobs WHERE id_integration = ? AND status IN ('queued','running','rolling_back') LIMIT 1`, [idIntegration]);
	if (busy && running.has(Number(busy.id))) throw httpErr(409, t("busy", { id: busy.id }), "busy");
	if (busy) await pool.query(`UPDATE ${P}products_import_jobs SET status = 'interrupted' WHERE id = ?`, [busy.id]);

	let idJob;
	if (body.resume_id) {
		const j = await jobRow(idIntegration, parseInt(body.resume_id, 10));
		if (!publicJob(j).can_resume) throw httpErr(409, t("not_resumable"), "not_resumable");
		idJob = Number(j.id);
		await pool.query(`UPDATE ${P}products_import_jobs SET status = 'queued', message = NULL, date_end = NULL WHERE id = ?`, [idJob]);
	} else {
		const mode = MODES.includes(body.mode) ? body.mode : "dry";
		const opts = normalizeOptions(mode, body.options || {});
		if (!opts.match.length) throw httpErr(400, t("no_rules"), "invalid");
		const [r] = await pool.query(
			`INSERT INTO ${P}products_import_jobs (id_integration, mode, source, status, options, id_user, date_add, heartbeat) VALUES (?, ?, ?, 'queued', ?, ?, NOW(), NOW())`,
			[idIntegration, mode, ["manual", "module", "schedule"].includes(source) ? source : "manual", JSON.stringify(opts), idUser]
		);
		idJob = r.insertId;
	}

	const state = { cancel: false };
	running.set(idJob, state);
	run(integ, idJob, state)
		.catch(async (e) => {
			logging.error(e);
			await pool.query(`UPDATE ${P}products_import_jobs SET status = 'failed', message = ?, date_end = NOW() WHERE id = ?`, [String(e.message).slice(0, 1000), idJob]).catch(() => {});
		})
		.finally(() => running.delete(idJob));
	return { id: idJob };
}

async function cancel(idIntegration, idJob) {
	const j = await jobRow(idIntegration, idJob);
	const st = running.get(Number(j.id));
	if (st) st.cancel = true;
	else if (["queued", "running"].includes(j.status)) await pool.query(`UPDATE ${P}products_import_jobs SET status = 'cancelled', date_end = NOW() WHERE id = ?`, [j.id]);
	return { ok: true };
}

/* ═══ Виконання ═══════════════════════════════════════════════════════════ */

async function run(integ, idJob, state) {
	const [[job]] = await pool.query(`SELECT * FROM ${P}products_import_jobs WHERE id = ?`, [idJob]);
	const opts = parseJson(job.options, {});
	const mode = job.mode;
	const write = mode !== "dry";
	const idUser = job.id_user ? Number(job.id_user) : null;

	await pool.query(`UPDATE ${P}products_import_jobs SET status = 'running', date_start = COALESCE(date_start, NOW()), heartbeat = NOW() WHERE id = ?`, [idJob]);

	const meta = await client.call(integ, "export.meta", {});
	const ctx = await buildContext(integ, idJob, opts, meta, write, idUser);
	ctx.refs = parseJson(job.created_refs, {});

	if (!Number(job.total)) {
		const total = opts.ids.length ? opts.ids.length : opts.limit ? Math.min(opts.limit, num(meta.counts && meta.counts.products)) : num(meta.counts && meta.counts.products);
		await pool.query(`UPDATE ${P}products_import_jobs SET total = ? WHERE id = ?`, [total, idJob]);
	}

	let after = Number(job.cursor_after) || 0;
	let processed = Number(job.processed) || 0;
	const idsQueue = opts.ids.filter((x) => x > after).sort((a, b) => a - b);

	for (;;) {
		if (state.cancel) {
			await pool.query(`UPDATE ${P}products_import_jobs SET status = 'cancelled', date_end = NOW(), heartbeat = NOW() WHERE id = ?`, [idJob]);
			return;
		}
		let size = BATCH;
		if (opts.limit && !opts.ids.length) size = Math.min(BATCH, opts.limit - processed);
		if (size <= 0) break;

		let r;
		if (opts.ids.length) {
			const chunk = idsQueue.splice(0, BATCH);
			if (!chunk.length) break;
			r = await client.call(integ, "export.products", { ids: chunk });
			r.next_after = chunk[chunk.length - 1];
		} else {
			r = await client.call(integ, "export.products", { after_id: after, limit: size });
		}
		const list = Array.isArray(r.items) ? r.items : [];
		ctx.dict = r.dict || {};
		if (ctx.siteDict) mergeDict(ctx, ctx.dict);

		if (list.length) {
			const matches = await matchBatch(integ.id, list, opts.match, ctx);
			// Кілька товарів одночасно: довідники (категорії, бренди, атрибути, опції) створюються по черзі — див. serial()
			let next = 0;
			const worker = async () => {
				while (next < list.length && !state.cancel) {
					const it = list[next++];
					after = Math.max(after, Number(it.id));
					const preview = processed < PREVIEW_MAX;
					await processItem(ctx, it, matches.get(Number(it.id)), preview);
					processed++;
					if (processed % 20 === 0) await pool.query(`UPDATE ${P}products_import_jobs SET heartbeat = NOW() WHERE id = ?`, [idJob]);
				}
			};
			await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
			await flushSiteLinks(ctx);
		}
		if (!state.cancel) after = Math.max(after, Number(r.next_after) || after);

		await pool.query(
			`UPDATE ${P}products_import_jobs SET cursor_after = ?, processed = ?, created = created + ?, linked = linked + ?, updated = updated + ?,
			        skipped = skipped + ?, errors = errors + ?, warnings = warnings + ?, heartbeat = NOW() WHERE id = ?`,
			[after, processed, ctx.cnt.create, ctx.cnt.link, ctx.cnt.update, ctx.cnt.skip, ctx.cnt.error, ctx.cnt.warn, idJob]
		);
		ctx.cnt = newCounters();

		if (!opts.ids.length && (r.done || !list.length)) break;
	}

	if (state.cancel) {
		await pool.query(`UPDATE ${P}products_import_jobs SET status = 'cancelled', date_end = NOW() WHERE id = ?`, [idJob]);
		return;
	}
	await linkRelated(ctx);
	await pool.query(`UPDATE ${P}products_import_jobs SET status = 'done', date_end = NOW(), heartbeat = NOW() WHERE id = ?`, [idJob]);
}

/**
 * Довідники створюються строго по черзі: паралельні товари не створять дві однакові категорії / бренди / атрибути.
 * Знайдене вже кешоване, тож черга коротка.
 */
function serial(ctx, fn) {
	const p = (ctx.dictLock || Promise.resolve()).then(fn, fn);
	ctx.dictLock = p.catch(() => {});
	return p;
}

const newCounters = () => ({ create: 0, link: 0, update: 0, skip: 0, error: 0, warn: 0 });

/** Усе, що потрібно для перетворення товарів сайту: мови, групи, валюта, склад, дерево категорій сайту, бренди */
async function buildContext(integ, idJob, opts, meta, write, idUser) {
	const langs = await languages.active();
	const primary = langs[0];
	LANG_CODES = new Map(langs.map((l) => [Number(l.id), l.code]));
	const byCode = new Map(langs.map((l) => [key(l.code), l.id]));
	const alias = { ua: "uk", "uk-ua": "uk", "ru-ru": "ru", "en-gb": "en", "en-us": "en" };

	// Мова сайту → мова системи: вибір користувача, точний код, псевдонім, перші 2 літери
	const langMap = {};
	for (const l of meta.languages || []) {
		const c = key(l.code);
		const chosen = opts.langs[l.code];
		const id = chosen || byCode.get(c) || byCode.get(alias[c]) || byCode.get(c.slice(0, 2)) || (alias[c.slice(0, 2)] && byCode.get(alias[c.slice(0, 2)]));
		if (id) langMap[l.code] = id;
	}
	if (!Object.keys(langMap).length) throw httpErr(400, t("no_langs"), "langs");

	// Групи покупців: стандартна група сайту → «усі» (0), решта — як вибрано; без вибору — за назвою
	const groups = await customerGroups.options();
	const gByName = new Map(groups.map((g) => [key(g.name), Number(g.id)]));
	const groupMap = {};
	for (const g of meta.customer_groups || []) {
		if (opts.groups[g.id] !== undefined) groupMap[g.id] = opts.groups[g.id];
		else if (Number(g.id) === Number(meta.default_customer_group)) groupMap[g.id] = 0;
		else if (gByName.has(key(g.name))) groupMap[g.id] = gByName.get(key(g.name));
	}

	const cx = await pricing.currencyCtx();
	const siteCur = String(meta.currency || "").toUpperCase();
	if (siteCur && !cx.has(siteCur)) throw httpErr(400, t("currency", { code: siteCur }), "currency");

	const stockCfg = await settings.get("stock");
	const idWarehouse = opts.id_warehouse || (stockCfg && stockCfg.id_default_warehouse) || null;

	const ctx = {
		integ,
		idJob,
		opts,
		meta,
		write,
		idUser,
		langs,
		primary,
		langMap,
		groupMap,
		priceCurrency: siteCur && siteCur !== cx.base ? siteCur : null,
		idWarehouse: idWarehouse ? Number(idWarehouse) : null,
		cnt: newCounters(),
		siteLinks: [],
		photoCache: new Map(),
		linkedCats: new Set(),
		drySkus: new Map(), // тест: SKU, що вже «зайняті» попередніми товарами цього завдання
		dict: {},
	};

	// Категорії сайту — увесь список (для шляхів «Батько / Дитина»)
	ctx.siteCats = new Map();
	if (opts.categories !== "none") {
		let afterCat = 0;
		for (let guard = 0; guard < 1000; guard++) {
			const r = await client.call(integ, "export.categories", { after: afterCat, limit: 1000 });
			for (const c of r.items || []) ctx.siteCats.set(Number(c.id), c);
			if (!r.more) break;
			afterCat = Number(r.next) || afterCat;
		}
		await loadCrmCategories(ctx);
	}
	ctx.siteBrands = new Map();
	if (opts.brands !== "none") {
		const r = await client.call(integ, "export.manufacturers", {});
		for (const m of r.items || []) ctx.siteBrands.set(Number(m.id), m);
		await loadCrmBrands(ctx);
	}
	if (opts.attributes !== "none" || opts.options !== "none") await loadCrmDictionaries(ctx);
	ctx.createdCats = new Map(); // шлях → id (створені цим завданням або «буде створено» в тесті)
	return ctx;
}

/** Назва запису сайту мовою, що відповідає основній мові системи (або перша наявна) */
function siteName(ctx, descs) {
	if (!descs) return "";
	for (const [code, id] of Object.entries(ctx.langMap)) if (id === ctx.primary.id && descs[code] && descs[code].name) return descs[code].name;
	const first = Object.values(descs).find((d) => d && d.name);
	return first ? first.name : "";
}

/* ─── Категорії: «шлях назв» основною мовою ─── */

async function loadCrmCategories(ctx) {
	const [rows] = await pool.query(
		`SELECT c.id, c.id_parent, d.name FROM ${P}products_categories c
		   LEFT JOIN ${P}products_categories_description d ON d.id_category = c.id AND d.id_lang = ?`,
		[ctx.primary.id]
	);
	const byId = new Map(rows.map((r) => [Number(r.id), r]));
	const pathOf = (id, depth = 0) => {
		const r = byId.get(id);
		if (!r || depth > 50) return "";
		const parent = r.id_parent ? pathOf(Number(r.id_parent), depth + 1) : "";
		return (parent ? parent + " / " : "") + key(r.name);
	};
	ctx.crmCatByPath = new Map();
	for (const id of byId.keys()) {
		const p = pathOf(id);
		if (p && !ctx.crmCatByPath.has(p)) ctx.crmCatByPath.set(p, id);
	}
}

function siteCatPath(ctx, id, depth = 0) {
	const c = ctx.siteCats.get(Number(id));
	if (!c || depth > 50) return [];
	const parent = c.parent_id ? siteCatPath(ctx, c.parent_id, depth + 1) : [];
	return [...parent, c];
}

/**
 * Категорія сайту → id категорії системи. Шукаємо за повним шляхом назв; режим «path» створює відсутні
 * (разом із батьками). У тесті нічого не створюємо: повертаємо 0 = «буде створено».
 * null — категорію не перенесено.
 */
function mapCategory(ctx, siteId, warn) {
	return serial(ctx, () => mapCategoryRaw(ctx, siteId, warn));
}
async function mapCategoryRaw(ctx, siteId, warn) {
	const chain = siteCatPath(ctx, siteId);
	if (!chain.length) {
		warn(t("w_cat_missing", { id: siteId }));
		return null;
	}
	const label = chain.map((x) => siteName(ctx, x.descriptions)).join(" / ");
	let parentId = null;
	let pathKey = "";
	for (const c of chain) {
		const name = siteName(ctx, c.descriptions);
		pathKey = (pathKey ? pathKey + " / " : "") + key(name);
		let id = ctx.crmCatByPath.get(pathKey) || ctx.createdCats.get(pathKey) || null;
		if (!id) {
			if (ctx.opts.categories !== "path") {
				warn(t("w_cat_not_found", { name: label }));
				return null;
			}
			if (!ctx.write) {
				warn(t("w_cat_create", { name: label }));
				return 0;
			}
			const descriptions = {};
			for (const [code, d] of Object.entries(c.descriptions || {})) {
				const idLang = ctx.langMap[code];
				if (!idLang || descriptions[idLang]) continue;
				descriptions[idLang] = {
					name: clip(d.name, 255),
					h1: clip(d.h1, 255),
					description: d.description || null,
					meta_title: clip(d.meta_title, 255),
					meta_description: clip(d.meta_description, 512),
					meta_keywords: clip(d.meta_keyword, 512),
					slug: clip(c.seo && c.seo[code], 191),
				};
			}
			if (!descriptions[ctx.primary.id] || !descriptions[ctx.primary.id].name) descriptions[ctx.primary.id] = { ...(descriptions[ctx.primary.id] || {}), name: clip(name || `#${c.id}`, 255) };
			const res = await categories.save(0, { id_parent: parentId, status: !!Number(c.status), sort_order: Math.round(num(c.sort_order)), descriptions }, { idUser: ctx.idUser });
			id = res.id;
			ctx.createdCats.set(pathKey, id);
			await addRef(ctx, "categories", id);
		}
		// Зв'язок на сайті — і для створених, і для знайдених (обмін категорій не створить дублів)
		if (ctx.write && ctx.opts.link_site && !ctx.linkedCats.has(Number(c.id))) {
			ctx.linkedCats.add(Number(c.id));
			ctx.siteLinks.push({ entity: "category", crm_id: id, oc_id: Number(c.id) });
		}
		parentId = id;
	}
	return parentId;
}

/** Що створило завдання (категорії, бренди) — для відкату. Пишемо одразу, щоб не загубити при збої */
async function addRef(ctx, kind, id) {
	ctx.refs[kind] = ctx.refs[kind] || [];
	ctx.refs[kind].push(id);
	await pool.query(`UPDATE ${P}products_import_jobs SET created_refs = ? WHERE id = ?`, [JSON.stringify(ctx.refs), ctx.idJob]);
}

/* ─── Бренди: за назвою (будь-якою мовою) ─── */

async function loadCrmBrands(ctx) {
	const [rows] = await pool.query(
		`SELECT b.id, d.name FROM ${P}products_brands b JOIN ${P}products_brands_description d ON d.id_brand = b.id WHERE b.deleted_at IS NULL`
	);
	ctx.crmBrandByName = new Map();
	for (const r of rows) if (r.name && !ctx.crmBrandByName.has(key(r.name))) ctx.crmBrandByName.set(key(r.name), Number(r.id));
}

function mapBrand(ctx, siteId, warn) {
	return serial(ctx, () => mapBrandRaw(ctx, siteId, warn));
}
async function mapBrandRaw(ctx, siteId, warn) {
	if (!siteId || ctx.opts.brands === "none") return null;
	const m = ctx.siteBrands.get(Number(siteId));
	if (!m || !m.name) return null;
	const k = key(m.name);
	let id = ctx.crmBrandByName.get(k);
	if (id) return id;
	if (ctx.opts.brands !== "create") {
		warn(t("w_brand_not_found", { name: m.name }));
		return null;
	}
	if (!ctx.write) {
		warn(t("w_brand_create", { name: m.name }));
		return 0;
	}
	const res = await brands.save(0, { status: true, sort_order: num(m.sort_order), descriptions: { [ctx.primary.id]: { name: clip(m.name, 255), slug: clip(Object.values(m.seo || {})[0], 191) } } }, { idUser: ctx.idUser });
	id = res.id;
	ctx.crmBrandByName.set(k, id);
	await addRef(ctx, "brands", id);
	return id;
}

/* ─── Фото: лише з хоста сайту (захист від SSRF), кеш у межах завдання ─── */

const bareHost = (h) => String(h || "").toLowerCase().replace(/^www\./, "");

async function fetchPhoto(ctx, url) {
	if (ctx.photoCache.has(url)) return ctx.photoCache.get(url);
	let file = null;
	try {
		const u = new URL(String(url));
		const base = new URL(ctx.integ.base_url || ctx.integ.callback_url);
		if (["https:", "http:"].includes(u.protocol) && bareHost(u.hostname) === bareHost(base.hostname)) {
			const res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(20000) });
			if (res.ok && Number(res.headers.get("content-length") || 0) <= MAX_PHOTO_BYTES) {
				const buf = Buffer.from(await res.arrayBuffer());
				if (buf.length && buf.length <= MAX_PHOTO_BYTES) file = (await images.processUpload("products", buf, { watermark: false })).file;
			}
		}
	} catch {
		file = null;
	}
	ctx.photoCache.set(url, file);
	if (ctx.photoCache.size > 2000) ctx.photoCache.delete(ctx.photoCache.keys().next().value);
	return file;
}

/* ═══ Зіставлення порції ══════════════════════════════════════════════════ */

/**
 * Для кожного товару сайту: { id_product, id_variant, by } | { error } | undefined (не знайдено).
 * На кожне правило — один запит на всю порцію.
 */
async function matchBatch(idIntegration, list, rules, ctx) {
	const out = new Map();
	let pending = list.slice();
	for (const r of rules) {
		if (!pending.length) break;
		const found = new Map(); // значення (lower) → [{id_product,id_variant}]
		const valOf = (it) => (r.site === "link" || r.site === "id" ? String(it.id) : key(it[r.site]));
		const vals = [...new Set(pending.map(valOf).filter((v) => v !== ""))];
		if (!vals.length) continue;
		const add = (v, row) => {
			const k = key(v);
			if (!found.has(k)) found.set(k, []);
			const arr = found.get(k);
			if (!arr.some((x) => x.id_product === Number(row.id_product) && x.id_variant === Number(row.id_variant))) arr.push({ id_product: Number(row.id_product), id_variant: Number(row.id_variant) });
		};

		if (r.site === "link") {
			const [rows] = await pool.query(
				`SELECT l.external_id AS v, l.id_product, l.id_variant FROM ${P}products_external_links l
				   JOIN ${P}products p ON p.id = l.id_product AND p.deleted_at IS NULL
				  WHERE l.id_integration = ? AND l.external_variant_id = '' AND l.external_id IN (?)`,
				[idIntegration, vals]
			);
			rows.forEach((x) => add(x.v, x));
		} else if (r.crm === "id") {
			const ids = vals.map((v) => parseInt(v, 10)).filter((v) => v > 0);
			if (ids.length) {
				const [rows] = await pool.query(`SELECT id AS v, id AS id_product, 0 AS id_variant FROM ${P}products WHERE deleted_at IS NULL AND id IN (?)`, [ids]);
				rows.forEach((x) => add(x.v, x));
			}
		} else {
			const col = r.crm; // з білого списку CRM_FIELDS
			const [rows] = await pool.query(`SELECT ${col} AS v, id AS id_product, 0 AS id_variant FROM ${P}products WHERE deleted_at IS NULL AND ${col} IN (?)`, [vals]);
			rows.forEach((x) => add(x.v, x));
			if (["sku", "ean", "mpn"].includes(col)) {
				const [vrows] = await pool.query(
					`SELECT v.${col} AS v, v.id_product, v.id AS id_variant FROM ${P}products_variants v
					   JOIN ${P}products p ON p.id = v.id_product AND p.deleted_at IS NULL WHERE v.${col} IN (?)`,
					[vals]
				);
				vrows.forEach((x) => add(x.v, x));
			}
		}

		const by = r.site === "link" ? "link" : `${r.site}→${r.crm}`;
		const next = [];
		for (const it of pending) {
			const v = valOf(it);
			const hits = v !== "" ? found.get(key(v)) : null;
			if (!hits || !hits.length) next.push(it);
			else if (hits.length > 1) out.set(Number(it.id), { error: t("ambiguous", { by, n: hits.length, ids: hits.map((h) => "#" + h.id_product).join(", ") }), by });
			else out.set(Number(it.id), { ...hits[0], by });
		}
		pending = next;
	}
	return out;
}

/* ═══ Один товар ══════════════════════════════════════════════════════════ */

async function processItem(ctx, it, match, keepPreview) {
	const warnings = [];
	const warn = (m) => warnings.length < 30 && warnings.push(m);
	const extId = Number(it.id);
	const name = siteName(ctx, it.descriptions) || `#${extId}`;
	const extSku = clip(ctx.opts.sku_from === "model" ? it.model : it.sku || it.model, 128);
	const row = { action: "skip", matched_by: null, id_product: null, message: null, preview: null, before: null, linkNew: false, related: null };

	try {
		if (match && match.error) {
			row.action = "error";
			row.matched_by = match.by;
			row.message = match.error;
		} else if (match) {
			row.matched_by = match.by;
			row.id_product = match.id_product;
			const linkRes = await linkProduct(ctx, it, match, extSku);
			row.linkNew = !!linkRes.isNew;
			if (linkRes.conflict) {
				row.action = "error";
				row.message = linkRes.conflict;
			} else if (ctx.opts.on_match === "update") {
				const u = ctx.opts.update;
				const upd = u.price || u.stock || u.status ? await updateMatched(ctx, it, match, warn) : { changed: [], before: null };
				const cnt = wantsContent(ctx.opts) ? await updateContent(ctx, it, match, warn) : { changed: [], snapshot: null };
				const all = [...upd.changed, ...cnt.changed];
				row.action = all.length ? "update" : "link";
				row.message = all.length ? all.join("; ") : linkRes.message;
				if (upd.before || cnt.snapshot) row.before = { ...(upd.before || {}), ...(cnt.snapshot ? { content: cnt.snapshot } : {}) };
			} else {
				row.action = "link";
				row.message = linkRes.message;
			}
		} else if (ctx.opts.on_new === "skip") {
			row.action = "skip";
			row.message = t("skip_new");
		} else {
			const body = await buildBody(ctx, it, warn);
			if (keepPreview) row.preview = previewOf(body, ctx);
			if (ctx.opts.related && body._related.length) row.related = body._related.slice(0, 500).map(Number);
			if (!ctx.write) {
				const errs = await dryValidate(ctx, body, it);
				row.action = errs.length ? "error" : "create";
				row.message = errs.length ? errs.join("; ") : t("create_ok");
			} else {
				const { _images, _catsPending, _brandPending, _extId, _related, _dictPending, ...saveBody } = body;
				const res = await products.save(0, saveBody, { idUser: ctx.idUser, perms: { cost: false, stock: true }, source: "import" });
				row.action = "create";
				row.id_product = res.id;
				row.linkNew = !!(await linkProduct(ctx, it, { id_product: res.id, id_variant: 0 }, extSku)).isNew;
			}
		}
	} catch (e) {
		row.action = "error";
		row.message = errText(e);
	}

	ctx.cnt[row.action]++;
	if (warnings.length) ctx.cnt.warn++;
	await pool.query(
		`INSERT INTO ${P}products_import_items (id_job, external_id, external_sku, name, action, matched_by, id_product, link_new, message, warnings, preview, before_state, related)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE external_sku = VALUES(external_sku), name = VALUES(name), action = VALUES(action), matched_by = VALUES(matched_by),
		   id_product = VALUES(id_product), link_new = GREATEST(link_new, VALUES(link_new)), message = VALUES(message), warnings = VALUES(warnings),
		   preview = VALUES(preview), before_state = COALESCE(before_state, VALUES(before_state)), related = VALUES(related)`,
		[
			ctx.idJob,
			extId,
			extSku,
			clip(name, 255),
			row.action,
			row.matched_by,
			row.id_product,
			row.linkNew ? 1 : 0,
			clip(row.message, 2000),
			warnings.length ? JSON.stringify(warnings) : null,
			row.preview ? JSON.stringify(row.preview) : null,
			row.before ? JSON.stringify(row.before) : null,
			row.related ? JSON.stringify(row.related) : null,
		]
	);
}

/** Помилки валідації картки → зрозумілий текст: «Назва (uk): обов'язкове поле» */
let LANG_CODES = null;
function fieldLabel(field) {
	const f = String(field || "");
	const m = f.match(/^descriptions\.(\d+)\.(\w+)$/);
	if (m) {
		const code = LANG_CODES && LANG_CODES.get(Number(m[1]));
		return `${t("f_" + m[2]) || m[2]} (${code || m[1]})`;
	}
	const top = f.split(".")[0];
	return t("f_" + top) || f;
}
function messageLabel(msg) {
	const s = String(msg || "");
	let m;
	if (s === "required") return t("m_required");
	if ((m = s.match(/more than (\d+) characters/))) return t("m_too_long", { n: m[1] });
	if (/must match pattern/.test(s)) return t("m_format");
	if (/check digit/.test(s)) return t("m_check_digit");
	if (/already exists/.test(s)) return t("m_exists");
	if (/not found/.test(s)) return t("m_not_found");
	if (/must be (integer|number)/.test(s)) return t("m_number");
	return s;
}
function errText(e) {
	const list = e && (e.errors || (e.details && e.details.errors));
	if (Array.isArray(list) && list.length) return t("e_validation", { list: list.map((x) => `${fieldLabel(x.field)}: ${messageLabel(x.message)}`).join("; ") });
	if (e && e.code === "version_conflict") return t("e_conflict");
	return (e && e.message) || String(e);
}

/** Зв'язок товар системи ↔ товар сайту. У тесті — лише перевірка конфліктів */
async function linkProduct(ctx, it, match, extSku) {
	const extId = String(it.id);
	const [[byExt]] = await pool.query(`SELECT id_product, id_variant FROM ${P}products_external_links WHERE id_integration = ? AND external_id = ? AND external_variant_id = ''`, [ctx.integ.id, extId]);
	if (byExt && (Number(byExt.id_product) !== match.id_product || Number(byExt.id_variant) !== match.id_variant)) {
		return { conflict: t("conflict_ext", { id: byExt.id_product }) };
	}
	const [[byLocal]] = await pool.query(`SELECT external_id FROM ${P}products_external_links WHERE id_integration = ? AND id_product = ? AND id_variant = ?`, [ctx.integ.id, match.id_product, match.id_variant]);
	if (byLocal && String(byLocal.external_id) !== extId) {
		return { conflict: t("conflict_local", { id: match.id_product, ext: byLocal.external_id }) };
	}
	const v = { id: match.id_product, by: match.by || "" };
	if (byExt) return { message: t("already_linked", v) };
	if (!ctx.write) return { message: t("will_link", v) };
	const [r] = await pool.query(
		`INSERT IGNORE INTO ${P}products_external_links (id_product, id_variant, id_integration, external_id, external_variant_id, external_sku) VALUES (?, ?, ?, ?, '', ?)`,
		[match.id_product, match.id_variant, ctx.integ.id, extId, clip(extSku, 64)]
	);
	if (r.affectedRows && ctx.opts.link_site && !match.id_variant) ctx.siteLinks.push({ entity: "product", crm_id: match.id_product, oc_id: Number(it.id) });
	return { message: t("linked", v), isNew: r.affectedRows > 0 };
}

async function flushSiteLinks(ctx) {
	if (!ctx.write || !ctx.siteLinks.length) return;
	const items = ctx.siteLinks.splice(0);
	try {
		await client.call(ctx.integ, "export.link", { items });
	} catch (e) {
		logging.error(e);
	}
}

/** Оновлення знайденого товару: ціна / залишок / статус. Попередні значення — для відкату */
async function updateMatched(ctx, it, match, warn) {
	const changed = [];
	const [[p]] = await pool.query(`SELECT id, price, status, price_auto, price_currency FROM ${P}products WHERE id = ?`, [match.id_product]);
	const before = { price: p ? Number(p.price) : null, status: p ? p.status : null, stock: null };
	if (!p) return { changed, before: null };
	if (match.id_variant) {
		warn(t("w_variant"));
		return { changed, before: null };
	}

	const cx = await pricing.currencyCtx();
	const price = ctx.priceCurrency ? cx.price(num(it.price), ctx.priceCurrency) : Math.round(num(it.price) * 100) / 100;
	const st = Number(it.status) ? "active" : "draft";
	const wantPrice = ctx.opts.update.price && !Number(p.price_auto) && Number(p.price) !== price;
	if (ctx.opts.update.price && Number(p.price_auto)) warn(t("w_formula"));
	const wantStatus = ctx.opts.update.status && p.status !== "archived" && p.status !== st;
	let wantStock = false;
	if (ctx.opts.update.stock) {
		if (!ctx.idWarehouse) warn(t("w_no_wh_update"));
		else {
			const [[s]] = await pool.query(`SELECT on_hand FROM ${P}products_stock WHERE id_product = ? AND id_variant = 0 AND id_warehouse = ?`, [p.id, ctx.idWarehouse]);
			before.stock = s ? Number(s.on_hand) : 0;
			wantStock = before.stock !== num(it.quantity);
		}
	}
	if (wantPrice) changed.push(t("ch_price", { old: before.price, new: price }));
	if (wantStatus) changed.push(t("ch_status", { old: before.status, new: st }));
	if (wantStock) changed.push(t("ch_stock", { old: before.stock, new: num(it.quantity) }));
	if (!ctx.write || !changed.length) return { changed, before };

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		if (wantPrice || wantStatus) {
			const sets = [];
			const args = [];
			if (wantPrice) {
				sets.push("price = ?", "price_currency = NULL", "price_cur = NULL");
				args.push(price);
			}
			if (wantStatus) {
				sets.push("status = ?");
				args.push(st);
			}
			await conn.query(`UPDATE ${P}products SET ${sets.join(", ")}, version = version + 1, id_user_edit = ? WHERE id = ?`, [...args, ctx.idUser, p.id]);
		}
		if (wantStock) {
			await stock.setQty(conn, { idProduct: p.id, idWarehouse: ctx.idWarehouse, qty: num(it.quantity), type: "adjustment", refType: "import", refId: ctx.idJob, idUser: ctx.idUser, comment: `Import from site #${ctx.integ.id}` });
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	const hist = [];
	if (wantPrice) hist.push({ field: "price", old: before.price, new: price });
	if (wantStatus) hist.push({ field: "status", old: before.status, new: st });
	if (wantStock) hist.push({ field: "stock", old: before.stock, new: num(it.quantity) });
	await history.record("products", p.id, { user: ctx.idUser, source: "import", action: "update", changes: hist, meta: { import_job: ctx.idJob } }).catch(() => {});
	return { changed, before };
}

/* ═══ Оновлення вмісту знайдених товарів ═══════════════════════════════════ */

const CONTENT_KEYS = ["names", "codes", "brand", "categories", "images", "attributes", "options"];
const DESC_FIELDS = ["name", "h1", "description", "meta_title", "meta_description", "meta_keywords", "tags", "slug"];
const CODE_FIELDS = ["model", "mpn", "ean", "upc", "jan", "isbn"];
const empty = (v) => v === null || v === undefined || String(v).trim() === "";

const wantsContent = (o) => o.on_match === "update" && o.update && CONTENT_KEYS.some((k) => o.update[k]);

/** Рядки атрибутів товару в системі: id атрибутів, що вже заповнені */
async function productAttrIds(db, id) {
	const [rows] = await db.query(
		`SELECT id_attribute FROM ${P}products_to_attributes WHERE id_product = ? UNION SELECT id_attribute FROM ${P}products_to_attributes_text WHERE id_product = ?`,
		[id, id]
	);
	return new Set(rows.map((r) => Number(r.id_attribute)));
}

/** Записати один атрибут товару (як у картці): попередні значення цього атрибута замінюються */
async function writeAttribute(conn, id, a, langIds, order) {
	const [[def]] = await conn.query(`SELECT id, type, is_translatable FROM ${P}products_attributes WHERE id = ?`, [a.id_attribute]);
	if (!def) return;
	await conn.query(`DELETE FROM ${P}products_to_attributes WHERE id_product = ? AND id_attribute = ?`, [id, a.id_attribute]);
	await conn.query(`DELETE FROM ${P}products_to_attributes_text WHERE id_product = ? AND id_attribute = ?`, [id, a.id_attribute]);
	if (ATTR_VALUE_TYPES.includes(def.type)) {
		for (const vid of def.type === "multiselect" ? a.value_ids || [] : (a.value_ids || []).slice(0, 1)) {
			await conn.query(`INSERT INTO ${P}products_to_attributes (id_product, id_attribute, id_attribute_value, sort_order) VALUES (?, ?, ?, ?)`, [id, a.id_attribute, vid, order]);
		}
	} else if (["integer", "decimal", "boolean"].includes(def.type)) {
		if (a.number !== undefined && a.number !== null) await conn.query(`INSERT INTO ${P}products_to_attributes (id_product, id_attribute, value_number, sort_order) VALUES (?, ?, ?, ?)`, [id, a.id_attribute, a.number, order]);
	} else if (def.type === "date") {
		if (a.date) await conn.query(`INSERT INTO ${P}products_to_attributes (id_product, id_attribute, value_date, sort_order) VALUES (?, ?, ?, ?)`, [id, a.id_attribute, a.date, order]);
	} else {
		const langs = Number(def.is_translatable) ? langIds : [0];
		for (const lang of langs) {
			const v = a.text && a.text[lang] != null ? String(a.text[lang]).trim() : "";
			if (v) await conn.query(`INSERT INTO ${P}products_to_attributes_text (id_product, id_attribute, id_lang, value) VALUES (?, ?, ?, ?)`, [id, a.id_attribute, lang, v.slice(0, 65535)]);
		}
	}
}

/** Знімок того, що змінюємо (для відкату) */
async function contentSnapshot(db, id, keys) {
	const snap = {};
	const [[p]] = await db.query(`SELECT ${CODE_FIELDS.join(", ")}, id_brand, id_category_main, slug_shared FROM ${P}products WHERE id = ?`, [id]);
	if (keys.names) snap.descriptions = await descriptions.load("products", id, db);
	if (keys.codes) snap.codes = Object.fromEntries(CODE_FIELDS.map((f) => [f, p[f]]));
	if (keys.brand) snap.id_brand = p.id_brand;
	if (keys.categories) {
		const [c] = await db.query(`SELECT id_category FROM ${P}products_to_categories WHERE id_product = ?`, [id]);
		snap.categories = c.map((r) => Number(r.id_category));
		snap.id_category_main = p.id_category_main;
	}
	if (keys.images) {
		const [m] = await db.query(`SELECT file, hash, mime, is_cover, sort_order FROM ${P}products_media WHERE id_product = ? AND type = 'image' ORDER BY sort_order, id`, [id]);
		snap.media = m;
	}
	if (keys.attributes) {
		const [a] = await db.query(`SELECT id_attribute, id_attribute_value, value_number, value_date, sort_order FROM ${P}products_to_attributes WHERE id_product = ?`, [id]);
		const [tx] = await db.query(`SELECT id_attribute, id_lang, value FROM ${P}products_to_attributes_text WHERE id_product = ?`, [id]);
		snap.attributes = { rows: a, texts: tx };
	}
	if (keys.options) snap.options = await productOptions.load(id, db);
	return snap;
}

/**
 * Оновити вміст знайденого товару даними сайту. Режим: fill — лише порожнє, overwrite — замінити.
 * Фото в режимі overwrite замінюються набором сайту; атрибути — лише ті, що прийшли з сайту; категорії — додаються.
 */
async function updateContent(ctx, it, match, warn) {
	const id = match.id_product;
	const u = ctx.opts.update;
	const fill = ctx.opts.content_mode !== "overwrite";
	const changed = [];
	const keys = Object.fromEntries(CONTENT_KEYS.map((k) => [k, !!u[k]]));
	if (match.id_variant) return { changed, snapshot: null };

	const h = await editLock.holder(id);
	if (h) throw httpErr(409, t("locked", { user: h.user_name || "#" + h.id_user }));

	const body = await buildBody(ctx, it, warn, { images: keys.images, categories: keys.categories, brand: keys.brand, attributes: keys.attributes, options: keys.options });
	const [[p]] = await pool.query(`SELECT id, ${CODE_FIELDS.join(", ")}, id_brand, id_category_main, slug_shared FROM ${P}products WHERE id = ? AND deleted_at IS NULL`, [id]);
	if (!p) return { changed, snapshot: null };
	const langIds = ctx.langs.map((l) => l.id);
	const plan = {};

	// Назви, описи, мета, SEO
	if (keys.names) {
		const cur = await descriptions.load("products", id);
		const merged = {};
		for (const l of langIds) merged[l] = { ...(cur[l] || {}) };
		let n = 0;
		for (const [lang, row] of Object.entries(body.descriptions)) {
			const tgt = merged[lang] || (merged[lang] = {});
			for (const f of DESC_FIELDS) {
				if (empty(row[f])) continue;
				if (fill && !empty(tgt[f])) continue;
				if (String(tgt[f] ?? "") === String(row[f])) continue;
				// SEO-адресу не перезаписуємо пустим і не чіпаємо, якщо адреса спільна для мов
				if (f === "slug" && Number(p.slug_shared)) continue;
				tgt[f] = row[f];
				n++;
			}
		}
		if (n) {
			const vd = validateDescriptions("products", merged, langIds);
			if (!vd.valid) throw httpErr(400, vd.errors.map((e) => `${e.field} ${e.message}`).join("; "));
			plan.descriptions = vd.data;
			changed.push(t("ch_names", { n }));
		}
	}
	// Коди (крім артикулу — за ним шукаємо)
	if (keys.codes) {
		const sets = {};
		for (const f of CODE_FIELDS) {
			const v = body.data[f];
			if (empty(v) || (fill && !empty(p[f])) || String(p[f] ?? "") === String(v)) continue;
			sets[f] = v;
		}
		if (sets.ean && !ean.isValid(sets.ean)) delete sets.ean;
		if (Object.keys(sets).length) {
			plan.codes = sets;
			changed.push(t("ch_codes", { list: Object.keys(sets).join(", ") }));
		}
	}
	if (keys.brand && body.data.id_brand && (!fill || !p.id_brand) && Number(p.id_brand) !== body.data.id_brand) {
		plan.id_brand = body.data.id_brand;
		changed.push(t("ch_brand"));
	}
	if (keys.categories && body.categories.length) {
		const [c] = await pool.query(`SELECT id_category FROM ${P}products_to_categories WHERE id_product = ?`, [id]);
		const have = new Set(c.map((r) => Number(r.id_category)));
		const add = fill && have.size ? [] : body.categories.filter((x) => !have.has(x));
		if (add.length) {
			plan.categories = add;
			changed.push(t("ch_categories", { n: add.length }));
		}
		if (!p.id_category_main && (body.data.id_category_main || body.categories[0])) plan.id_category_main = body.data.id_category_main || body.categories[0];
	}
	if (keys.images && body._images) {
		const [[m]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products_media WHERE id_product = ? AND type = 'image'`, [id]);
		if (!(fill && Number(m.n))) {
			if (ctx.write && !body.media.length) warn(t("w_photos_none"));
			else {
				plan.media = body.media;
				changed.push(t("ch_images", { n: body._images }));
			}
		}
	}
	if (keys.attributes && (body.attributes.length || body._dictPending)) {
		const have = await productAttrIds(pool, id);
		const list = fill ? body.attributes.filter((a) => !have.has(a.id_attribute)) : body.attributes;
		if (list.length) {
			plan.attributes = list;
			changed.push(t("ch_attributes", { n: list.length }));
		} else if (!ctx.write && body._dictPending) changed.push(t("ch_attributes", { n: body._dictPending }));
	}
	if (keys.options && body.options.length) {
		const [[o]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products_to_options WHERE id_product = ?`, [id]);
		if (!(fill && Number(o.n))) {
			const vo = validateProductOptions({ options: body.options.map((x) => ({ ...x, values: x.values.map((v) => ({ ...v, price_currency: ctx.priceCurrency })) })) }, langIds);
			if (!vo.valid) throw httpErr(400, vo.errors.map((e) => `${e.field} ${e.message}`).join("; "));
			plan.options = vo.data.options;
			changed.push(t("ch_options", { n: plan.options.length }));
		}
	}

	if (!ctx.write || !changed.length) return { changed, snapshot: null };

	const snapshot = await contentSnapshot(pool, id, keys);
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		if (plan.descriptions) await descriptions.save(conn, "products", id, plan.descriptions, { sharedSlug: !!Number(p.slug_shared), primaryLang: ctx.primary.id });
		const sets = { ...(plan.codes || {}) };
		if (plan.id_brand) sets.id_brand = plan.id_brand;
		if (plan.id_category_main) sets.id_category_main = plan.id_category_main;
		const cols = Object.keys(sets);
		await conn.query(`UPDATE ${P}products SET ${cols.map((c) => `${c} = ?, `).join("")}version = version + 1, id_user_edit = ? WHERE id = ?`, [...cols.map((c) => sets[c]), ctx.idUser, id]);
		if (plan.categories) await conn.query(`INSERT IGNORE INTO ${P}products_to_categories (id_product, id_category) VALUES ?`, [plan.categories.map((c) => [id, c])]);
		if (plan.media) {
			// Старі файли не видаляємо — відкат може їх повернути; осиротілі прибирає обслуговування фото
			await conn.query(`DELETE FROM ${P}products_media WHERE id_product = ? AND type = 'image'`, [id]);
			for (const [i, m] of plan.media.entries()) {
				const hash = m.file.split("/")[1].split(".")[0];
				await conn.query(`INSERT INTO ${P}products_media (id_product, type, file, hash, mime, is_cover, sort_order) VALUES (?, 'image', ?, ?, ?, ?, ?)`, [id, m.file, hash, "image/" + (m.file.endsWith(".jpg") ? "jpeg" : m.file.split(".").pop()), i === 0 ? 1 : 0, i]);
			}
		}
		if (plan.attributes) {
			const [[mx]] = await conn.query(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM ${P}products_to_attributes WHERE id_product = ?`, [id]);
			let order = Number(mx.m) + 1;
			for (const a of plan.attributes) await writeAttribute(conn, id, a, langIds, order++);
		}
		if (plan.options) {
			const cur = await productOptions.load(id, conn);
			pricing.convertOptions({ options: plan.options }, null, await pricing.currencyCtx());
			await productOptions.save(conn, id, { options: plan.options, customization: cur.customization });
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	await history.record("products", id, { user: ctx.idUser, source: "import", action: "update", changes: changed.map((c) => ({ field: "import", old: null, new: c })), meta: { import_job: ctx.idJob } }).catch(() => {});
	quality.recalc([id]).catch(() => {});
	return { changed, snapshot };
}

/** Відкат вмісту зі знімка */
async function restoreContent(conn, id, s, ctx) {
	if (s.descriptions) {
		const langIds = ctx.langIds;
		const vd = validateDescriptions("products", s.descriptions, langIds);
		if (vd.valid) {
			const [[p]] = await conn.query(`SELECT slug_shared FROM ${P}products WHERE id = ?`, [id]);
			await descriptions.save(conn, "products", id, vd.data, { sharedSlug: !!Number(p && p.slug_shared), primaryLang: langIds[0] });
		}
	}
	const sets = { ...(s.codes || {}) };
	if ("id_brand" in s) sets.id_brand = s.id_brand;
	if ("id_category_main" in s) sets.id_category_main = s.id_category_main;
	const cols = Object.keys(sets);
	await conn.query(`UPDATE ${P}products SET ${cols.map((c) => `${c} = ?, `).join("")}version = version + 1 WHERE id = ?`, [...cols.map((c) => sets[c]), id]);
	if (s.categories) {
		await conn.query(`DELETE FROM ${P}products_to_categories WHERE id_product = ?`, [id]);
		if (s.categories.length) await conn.query(`INSERT IGNORE INTO ${P}products_to_categories (id_product, id_category) SELECT ?, id FROM ${P}products_categories WHERE id IN (?)`, [id, s.categories]);
	}
	if (s.media) {
		await conn.query(`DELETE FROM ${P}products_media WHERE id_product = ? AND type = 'image'`, [id]);
		for (const m of s.media) await conn.query(`INSERT INTO ${P}products_media (id_product, type, file, hash, mime, is_cover, sort_order) VALUES (?, 'image', ?, ?, ?, ?, ?)`, [id, m.file, m.hash, m.mime, m.is_cover, m.sort_order]);
	}
	if (s.attributes) {
		await conn.query(`DELETE FROM ${P}products_to_attributes WHERE id_product = ?`, [id]);
		await conn.query(`DELETE FROM ${P}products_to_attributes_text WHERE id_product = ?`, [id]);
		for (const r of s.attributes.rows) {
			await conn.query(`INSERT IGNORE INTO ${P}products_to_attributes (id_product, id_attribute, id_attribute_value, value_number, value_date, sort_order) VALUES (?, ?, ?, ?, ?, ?)`, [id, r.id_attribute, r.id_attribute_value, r.value_number, r.value_date ? String(r.value_date).slice(0, 10) : null, r.sort_order]);
		}
		for (const r of s.attributes.texts) await conn.query(`INSERT IGNORE INTO ${P}products_to_attributes_text (id_product, id_attribute, id_lang, value) VALUES (?, ?, ?, ?)`, [id, r.id_attribute, r.id_lang, r.value]);
	}
	if (s.options) await productOptions.save(conn, id, s.options);
}

/* ─── Товар сайту → тіло products.save ─── */

function unitOf(text, map) {
	const t = key(text).replace(/\./g, "");
	for (const [u, list] of Object.entries(map)) if (list.includes(t)) return u;
	return null;
}
const WEIGHT_UNITS = { kg: ["kg", "кг"], g: ["g", "г", "гр"], lb: ["lb", "lbs", "фунт"], oz: ["oz", "унц"] };
const LENGTH_UNITS = { cm: ["cm", "см"], mm: ["mm", "мм"], m: ["m", "м"], in: ["in", "inch", "дюйм"] };

async function buildBody(ctx, it, warn, need = {}) {
	const o = ctx.opts;
	let skuVal = o.sku_from === "none" ? null : String((o.sku_from === "model" ? it.model : it.sku) || "").trim() || null;
	if (skuVal && (!SKU_RE.test(skuVal) || skuVal.length > 64)) {
		warn(t("w_sku", { sku: skuVal }));
		skuVal = null;
	}
	const code = (v, re, check) => {
		const s = String(v || "").trim();
		if (!s) return null;
		if (!re.test(s) || (check && !check(s))) {
			warn(t("w_code", { code: s }));
			return null;
		}
		return s;
	};

	const status = o.status_new === "site" ? (Number(it.status) ? "active" : "draft") : o.status_new;
	const weightUnit = unitOf(ctx.meta.weight_units && ctx.meta.weight_units[it.weight_class_id], WEIGHT_UNITS);
	const lengthUnit = unitOf(ctx.meta.length_units && ctx.meta.length_units[it.length_class_id], LENGTH_UNITS);

	const data = {
		type: "simple",
		status,
		sku: skuVal,
		model: clip(String(it.model || "").trim() || null, 128),
		mpn: clip(String(it.mpn || "").trim() || null, 64),
		ean: code(it.ean, /^(\d{8}|\d{12,14})$/, ean.isValid),
		upc: code(it.upc, /^\d{12}$/),
		jan: code(it.jan, /^(\d{8}|\d{13})$/),
		isbn: code(it.isbn, /^(97[89])?\d{9}[\dX]$/),
		price: Math.max(0, num(it.price)),
		price_currency: ctx.priceCurrency,
		points_price: num(it.points) > 0 ? Math.round(num(it.points)) : null,
		subtract_stock: !!Number(it.subtract),
		min_qty: num(it.minimum) > 0 ? num(it.minimum) : 1,
		requires_shipping: it.shipping === undefined ? true : !!Number(it.shipping),
		available_date: ocDate(it.date_available),
		weight: num(it.weight) > 0 ? num(it.weight) : null,
		weight_unit: num(it.weight) > 0 ? weightUnit : null,
		length: num(it.length) > 0 ? num(it.length) : null,
		width: num(it.width) > 0 ? num(it.width) : null,
		height: num(it.height) > 0 ? num(it.height) : null,
		length_unit: num(it.length) + num(it.width) + num(it.height) > 0 ? lengthUnit : null,
		sort_order: Math.round(num(it.sort_order)),
		internal_note: t("note", { site: ctx.integ.name || "", id: it.id }),
	};
	if (num(it.weight) > 0 && !weightUnit) warn(t("w_weight"));

	const brand = need.brand === false ? null : await mapBrand(ctx, it.manufacturer_id, warn);
	data.id_brand = brand || null;

	// Описи: мова сайту → мова системи
	const descriptions = {};
	for (const [codeL, d] of Object.entries(it.descriptions || {})) {
		const idLang = ctx.langMap[codeL];
		if (!idLang || descriptions[idLang]) continue;
		descriptions[idLang] = {
			name: clip(d.name, 255),
			h1: clip(d.h1, 255),
			description: d.description || null,
			meta_title: clip(d.meta_title, 255),
			meta_description: clip(d.meta_description, 512),
			meta_keywords: clip(d.meta_keyword, 512),
			tags: clip(d.tag, 512),
			slug: clip(it.seo && it.seo[codeL], 191),
		};
	}

	// Назва обов'язкова основною мовою: немає — беремо з іншої мови сайту, далі модель / SKU / ID.
	// Мова, де є опис чи мета, але без назви, — теж отримує назву (інакше картка не прийме)
	const anyName = Object.values(descriptions).map((d) => d.name).find((n) => !empty(n));
	const fallbackName = anyName || clip(String(it.model || it.sku || "").trim(), 255) || `#${it.id}`;
	if (!descriptions[ctx.primary.id] || empty(descriptions[ctx.primary.id].name)) {
		descriptions[ctx.primary.id] = { ...(descriptions[ctx.primary.id] || {}), name: fallbackName };
		warn(t("w_name_fallback", { name: fallbackName }));
	}
	for (const d of Object.values(descriptions)) if (empty(d.name)) d.name = descriptions[ctx.primary.id].name;

	// Категорії
	const cats = [];
	let catsPending = 0; // тест: «буде створено»
	if (o.categories !== "none" && need.categories !== false) {
		for (const c of it.categories || []) {
			const id = await mapCategory(ctx, c, warn);
			if (id === 0) catsPending++;
			else if (id && !cats.includes(id)) cats.push(id);
		}
		if (it.main_category_id) {
			const main = await mapCategory(ctx, it.main_category_id, () => {});
			if (main) data.id_category_main = main;
		}
	}

	// Фото: головне + додаткові
	const urls = [...new Set([it.image, ...(it.images || [])].filter(Boolean))].slice(0, 100);
	const media = [];
	if (o.images && ctx.write && need.images !== false) {
		const files = new Array(urls.length);
		let k = 0;
		const dl = async () => {
			while (k < urls.length) {
				const i = k++;
				files[i] = await fetchPhoto(ctx, urls[i]);
			}
		};
		await Promise.all(Array.from({ length: Math.min(PHOTO_CONCURRENCY, urls.length) }, dl));
		files.forEach((f, i) => {
			if (f && !media.some((m) => m.file === f)) media.push({ file: f, is_cover: media.length === 0 });
			else if (!f) warn(t("w_photo", { url: urls[i] }));
		});
	}

	// Акції й знижки від кількості: групи сайту → групи системи
	const prices = [];
	const group = (g) => {
		const v = ctx.groupMap[g];
		if (v === undefined) {
			warn(t("w_group", { id: g }));
			return null;
		}
		return v < 0 ? null : v;
	};
	for (const s of it.specials || []) {
		const g = group(s.customer_group_id);
		if (g === null) continue;
		prices.push({ kind: "special", id_customer_group: g, min_qty: 1, reduction_type: "new_price", value: Math.max(0, num(s.price)), priority: Math.round(num(s.priority)), date_start: ocDateTime(s.date_start), date_end: ocDateTime(s.date_end) });
	}
	for (const s of it.discounts || []) {
		const g = group(s.customer_group_id);
		if (g === null) continue;
		prices.push({ kind: "tier", id_customer_group: g, min_qty: num(s.quantity) > 0 ? num(s.quantity) : 1, reduction_type: "new_price", value: Math.max(0, num(s.price)), priority: Math.round(num(s.priority)), date_start: ocDateTime(s.date_start), date_end: ocDateTime(s.date_end) });
	}
	const rewards = [];
	for (const r of it.rewards || []) {
		const g = ctx.groupMap[r.customer_group_id];
		if (g !== undefined && g >= 0 && num(r.points) > 0 && !rewards.some((x) => x.id_customer_group === g)) rewards.push({ id_customer_group: g, points: Math.round(num(r.points)) });
	}

	const stockRows = ctx.idWarehouse ? [{ id_warehouse: ctx.idWarehouse, on_hand: num(it.quantity) }] : [];
	if (!ctx.idWarehouse) warn(t("w_no_wh"));
	const attrs = ctx.siteDict && need.attributes !== false ? await buildAttributes(ctx, it, warn) : { list: [], pending: 0 };
	const opts2 = ctx.siteDict && need.options !== false ? await buildOptions(ctx, it, warn) : { list: [], pending: 0 };

	return { data, descriptions, categories: cats, media, prices, rewards, stock: stockRows, attributes: attrs.list, options: opts2.list, _images: urls.length, _related: it.related || [], _dictPending: attrs.pending + opts2.pending, _catsPending: catsPending, _brandPending: brand === 0, _extId: Number(it.id) };
}

/** Тест без запису: усі перевірки картки + обов'язкові поля + унікальність SKU / EAN */
async function dryValidate(ctx, body) {
	const langIds = ctx.langs.map((l) => l.id);
	const out = [];
	const vc = validateCore({ ...body.data });
	const vp = validateParts({ ...body, media: [] });
	const vd = validateDescriptions("products", body.descriptions, langIds);
	const vo = validateProductOptions(body, langIds);
	for (const v of [vc, vp, vd, vo]) if (!v.valid) v.errors.forEach((e) => out.push(`${fieldLabel(e.field || e.instancePath || "")}: ${messageLabel(e.message)}`));
	if (vc.valid && vd.valid) {
		const media = body._images && ctx.opts.images ? [{}] : [];
		// Категорії, які «буде створено», рахуються як наявні
		const cats = body.categories.length || body._catsPending ? [1] : [];
		const req = await products.checkRequired({ ...vc.data, id_brand: vc.data.id_brand || (body._brandPending ? 1 : null) }, { categories: cats, media }, vd.data, ctx.primary.id);
		req.forEach((e) => out.push(`${fieldLabel(e.field)}: ${messageLabel(e.message)}`));
		if (vc.data.sku) {
			const k = key(vc.data.sku);
			if (!(await sku.isFree(vc.data.sku, {}, pool))) out.push(t("e_sku_exists", { sku: vc.data.sku }));
			else if (ctx.drySkus.has(k)) out.push(t("e_sku_repeat", { sku: vc.data.sku, id: ctx.drySkus.get(k) }));
			else ctx.drySkus.set(k, body._extId);
		}
	}
	return out;
}

/** Компактний вигляд «як буде в системі» для звіту */
function previewOf(body, ctx) {
	const d = body.data;
	const desc = {};
	for (const l of ctx.langs) {
		const x = body.descriptions[l.id];
		if (x) desc[l.code] = { name: x.name, slug: x.slug, meta_title: x.meta_title, description: x.description ? String(x.description).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : null };
	}
	return {
		status: d.status,
		sku: d.sku,
		model: d.model,
		ean: d.ean,
		price: d.price,
		price_currency: d.price_currency,
		id_brand: d.id_brand,
		categories: body.categories,
		images: body._images,
		stock: body.stock.length ? body.stock[0].on_hand : null,
		weight: d.weight ? `${d.weight} ${d.weight_unit || ""}`.trim() : null,
		prices: body.prices.length,
		attributes: body.attributes.length + (body._dictPending ? ` (+${body._dictPending})` : ""),
		options: body.options.length,
		related: body._related.length,
		descriptions: desc,
	};
}

/* ═══ Етап 2: атрибути, опції, пов'язані ═══════════════════════════════════ */

const ATTR_VALUE_TYPES = ["select", "multiselect", "color"];
const OPT_VALUE_TYPES = ["select", "radio", "checkbox", "color"];
// Тип опції OpenCart → тип опції системи
const OC_OPTION_TYPE = { select: "select", radio: "radio", checkbox: "checkbox", image: "radio", text: "text", textarea: "textarea", file: "file", date: "date", time: "time", datetime: "datetime" };
const TRUE_RE = /^(1|так|да|yes|true|є|есть|\+)$/i;

/** Назви сайту { code: name } → { idLang: { name } }; основна мова — обов'язково (перша наявна назва) */
function namesOf(ctx, src) {
	const out = {};
	for (const [code, name] of Object.entries(src || {})) {
		const idLang = ctx.langMap[code];
		const v = String(name || "").trim().slice(0, 255);
		if (idLang && v && !out[idLang]) out[idLang] = { name: v };
	}
	if (!out[ctx.primary.id]) {
		const first = Object.values(src || {}).map((x) => String(x || "").trim()).find(Boolean);
		if (first) out[ctx.primary.id] = { name: first.slice(0, 255) };
	}
	return out;
}
const primaryName = (ctx, names) => (names[ctx.primary.id] ? names[ctx.primary.id].name : "");

/** Довідники системи: атрибути, групи, опції та їхні значення (назва основною мовою → id) */
async function loadCrmDictionaries(ctx) {
	const lang = ctx.primary.id;
	const [attrs] = await pool.query(
		`SELECT a.id, a.type, a.is_translatable, d.name FROM ${P}products_attributes a
		   LEFT JOIN ${P}products_attributes_description d ON d.id_attribute = a.id AND d.id_lang = ?`,
		[lang]
	);
	ctx.crmAttrByName = new Map();
	for (const a of attrs) if (a.name && !ctx.crmAttrByName.has(key(a.name))) ctx.crmAttrByName.set(key(a.name), { id: Number(a.id), type: a.type, is_translatable: Number(a.is_translatable) });

	const [groups] = await pool.query(
		`SELECT g.id, d.name FROM ${P}products_attribute_groups g LEFT JOIN ${P}products_attribute_groups_description d ON d.id_attribute_group = g.id AND d.id_lang = ?`,
		[lang]
	);
	ctx.crmGroupByName = new Map();
	for (const g of groups) if (g.name && !ctx.crmGroupByName.has(key(g.name))) ctx.crmGroupByName.set(key(g.name), Number(g.id));

	const [opts] = await pool.query(
		`SELECT o.id, o.type, d.name FROM ${P}products_options o LEFT JOIN ${P}products_options_description d ON d.id_option = o.id AND d.id_lang = ?`,
		[lang]
	);
	// Ключ: назва + «зі значеннями / без» — select і text з однаковою назвою — різні опції
	ctx.crmOptByName = new Map();
	for (const o of opts) {
		if (!o.name) continue;
		const k = key(o.name) + "|" + (OPT_VALUE_TYPES.includes(o.type) ? "v" : "n");
		if (!ctx.crmOptByName.has(k)) ctx.crmOptByName.set(k, { id: Number(o.id), type: o.type });
	}
	ctx.attrValues = new Map(); // id атрибута → Map(назва → id значення)
	ctx.optValues = new Map(); // id опції → Map(назва → id значення)
	ctx.siteAttrMap = new Map(); // id атрибута сайту → { id, type, is_translatable } | 0 (буде створено) | null
	ctx.siteOptMap = new Map(); // id опції сайту → { id, type } | 0 | null
	ctx.siteDict = { attributes: new Map(), attribute_groups: new Map(), options: new Map(), option_values: new Map() };
}

/** Словник порції від сайту — накопичуємо (наступні порції посилаються на ті самі атрибути/опції) */
function mergeDict(ctx, dict) {
	for (const k of Object.keys(ctx.siteDict)) for (const x of (dict && dict[k]) || []) ctx.siteDict[k].set(Number(x.id), x);
}

async function valuesOf(table, idCol, owner, ownerId, lang) {
	const [rows] = await pool.query(
		`SELECT v.id, d.name FROM ${P}${table} v LEFT JOIN ${P}${table}_description d ON d.${idCol} = v.id AND d.id_lang = ? WHERE v.${owner} = ?`,
		[lang, ownerId]
	);
	const m = new Map();
	for (const r of rows) if (r.name && !m.has(key(r.name))) m.set(key(r.name), Number(r.id));
	return m;
}

async function insertNames(conn, table, idCol, id, names, withSlug) {
	for (const [lang, row] of Object.entries(names)) {
		if (!row || !row.name) continue;
		const cols = withSlug ? "(" + idCol + ", id_lang, name, slug)" : "(" + idCol + ", id_lang, name)";
		const vals = withSlug ? [id, Number(lang), row.name, slug.slugify(row.name, { transliteration: "uk", max_length: 120 }) || null] : [id, Number(lang), row.name];
		await conn.query(`INSERT INTO ${P}${table} ${cols} VALUES (${vals.map(() => "?").join(", ")}) ON DUPLICATE KEY UPDATE name = VALUES(name)`, vals);
	}
}

/** Значення атрибута за назвою; немає — створити (у тесті: 0 = «буде створено») */
function attrValueId(ctx, attr, names, warn) {
	return serial(ctx, () => attrValueIdRaw(ctx, attr, names, warn));
}
async function attrValueIdRaw(ctx, attr, names, warn) {
	if (!ctx.attrValues.has(attr.id)) ctx.attrValues.set(attr.id, await valuesOf("products_attribute_values", "id_attribute_value", "id_attribute", attr.id, ctx.primary.id));
	const m = ctx.attrValues.get(attr.id);
	const k = key(primaryName(ctx, names));
	if (!k) return null;
	if (m.has(k)) return m.get(k);
	if (ctx.opts.attributes !== "create") {
		warn(t("w_attr_value_missing", { name: primaryName(ctx, names) }));
		return null;
	}
	if (!ctx.write) {
		m.set(k, 0);
		return 0;
	}
	const base = (slug.slugify(primaryName(ctx, names), { transliteration: "uk", max_length: 50 }) || "value").toLowerCase().replace(/[^a-z0-9_\-]/g, "") || "value";
	const [taken] = await pool.query(`SELECT code FROM ${P}products_attribute_values WHERE id_attribute = ? AND (code = ? OR code LIKE ?)`, [attr.id, base, base + "\\_%"]);
	const codes = new Set(taken.map((r) => r.code));
	let code = base;
	for (let n = 2; codes.has(code); n++) code = `${base}_${n}`;
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [r] = await conn.query(`INSERT INTO ${P}products_attribute_values (id_attribute, code, color_hex, sort_order) VALUES (?, ?, ?, ?)`, [attr.id, code, attr.type === "color" ? "#999999" : null, m.size]);
		await insertNames(conn, "products_attribute_values_description", "id_attribute_value", r.insertId, names, true);
		await conn.commit();
		m.set(k, r.insertId);
		await addRef(ctx, "attribute_values", r.insertId);
		return r.insertId;
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

/** Атрибут сайту → атрибут системи (за назвою основною мовою); немає — створити текстовий у групі з тією ж назвою */
function mapAttribute(ctx, siteId, warn) {
	return serial(ctx, () => mapAttributeRaw(ctx, siteId, warn));
}
async function mapAttributeRaw(ctx, siteId, warn) {
	if (ctx.siteAttrMap.has(siteId)) return ctx.siteAttrMap.get(siteId);
	const sa = ctx.siteDict.attributes.get(siteId);
	let res = null;
	if (sa) {
		const names = namesOf(ctx, sa.names);
		const k = key(primaryName(ctx, names));
		res = (k && ctx.crmAttrByName.get(k)) || null;
		if (!res && k) {
			if (ctx.opts.attributes !== "create") warn(t("w_attr_missing", { name: primaryName(ctx, names) }));
			else if (!ctx.write) {
				warn(t("w_attr_create", { name: primaryName(ctx, names) }));
				res = 0;
			} else {
				let idGroup = null;
				const sg = ctx.siteDict.attribute_groups.get(Number(sa.group_id));
				if (sg) {
					const gNames = namesOf(ctx, sg.names);
					const gk = key(primaryName(ctx, gNames));
					idGroup = gk ? ctx.crmGroupByName.get(gk) || null : null;
					if (!idGroup && gk) {
						idGroup = (await attributes.saveGroup(0, { sort_order: Math.round(num(sg.sort_order)), names: gNames })).id;
						ctx.crmGroupByName.set(gk, idGroup);
						await addRef(ctx, "attribute_groups", idGroup);
					}
				}
				const id = (await attributes.saveAttribute(0, { type: "text", id_attribute_group: idGroup, is_translatable: true, is_visible_on_card: true, sort_order: Math.round(num(sa.sort_order)), names, values: [] })).id;
				res = { id, type: "text", is_translatable: 1 };
				ctx.crmAttrByName.set(k, res);
				await addRef(ctx, "attributes", id);
			}
		}
	}
	ctx.siteAttrMap.set(siteId, res);
	return res;
}

/** Атрибути товару сайту → parts.attributes картки з урахуванням типу атрибута системи */
async function buildAttributes(ctx, it, warn) {
	const out = [];
	let pending = 0;
	if (ctx.opts.attributes === "none") return { list: out, pending };
	const seen = new Set();
	for (const a of it.attributes || []) {
		const attr = await mapAttribute(ctx, Number(a.attribute_id), warn);
		if (attr === 0) {
			pending++;
			continue;
		}
		if (!attr || seen.has(attr.id)) continue;
		seen.add(attr.id);
		// Тексти сайту за мовами системи
		const byLang = {};
		for (const [code, v] of Object.entries(a.texts || {})) {
			const idLang = ctx.langMap[code];
			const s = String(v || "").trim();
			if (idLang && s && byLang[idLang] === undefined) byLang[idLang] = s;
		}
		const main = byLang[ctx.primary.id] !== undefined ? byLang[ctx.primary.id] : Object.values(byLang)[0];
		if (main === undefined) continue;

		if (attr.type === "text" || attr.type === "textarea") {
			out.push({ id_attribute: attr.id, text: attr.is_translatable ? byLang : { 0: main } });
		} else if (attr.type === "integer" || attr.type === "decimal") {
			const n = Number(String(main).replace(",", ".").replace(/[^\d.\-]/g, ""));
			if (!Number.isFinite(n) || String(main).trim() === "") warn(t("w_attr_number", { value: main }));
			else out.push({ id_attribute: attr.id, number: attr.type === "integer" ? Math.round(n) : n });
		} else if (attr.type === "boolean") {
			out.push({ id_attribute: attr.id, number: TRUE_RE.test(main) ? 1 : 0 });
		} else if (attr.type === "date") {
			const d = ocDate(main);
			if (d) out.push({ id_attribute: attr.id, date: d });
			else warn(t("w_attr_date", { value: main }));
		} else if (ATTR_VALUE_TYPES.includes(attr.type)) {
			// Значення довідника; для multiselect сайт зазвичай пише через кому
			const parts = attr.type === "multiselect" ? String(main).split(/\s*[,;]\s*/).filter(Boolean) : [main];
			const ids = [];
			for (let i = 0; i < parts.length; i++) {
				const names = { [ctx.primary.id]: { name: parts[i].slice(0, 255) } };
				if (attr.type !== "multiselect") for (const [l, v] of Object.entries(byLang)) if (Number(l) !== ctx.primary.id) names[l] = { name: String(v).slice(0, 255) };
				const id = await attrValueId(ctx, attr, names, warn);
				if (id === 0) pending++;
				else if (id && !ids.includes(id)) ids.push(id);
			}
			if (ids.length) out.push({ id_attribute: attr.id, value_ids: ids });
		}
	}
	return { list: out, pending };
}

/** Опція сайту → опція системи (назва + «зі значеннями / без»); немає — створити того ж типу */
function mapOption(ctx, siteId, warn) {
	return serial(ctx, () => mapOptionRaw(ctx, siteId, warn));
}
async function mapOptionRaw(ctx, siteId, warn) {
	if (ctx.siteOptMap.has(siteId)) return ctx.siteOptMap.get(siteId);
	const so = ctx.siteDict.options.get(siteId);
	let res = null;
	if (so) {
		const type = OC_OPTION_TYPE[so.type] || "select";
		const names = namesOf(ctx, so.names);
		const k = key(primaryName(ctx, names)) + "|" + (OPT_VALUE_TYPES.includes(type) ? "v" : "n");
		res = (primaryName(ctx, names) && ctx.crmOptByName.get(k)) || null;
		if (!res && primaryName(ctx, names)) {
			if (ctx.opts.options !== "create") warn(t("w_opt_missing", { name: primaryName(ctx, names) }));
			else if (!ctx.write) {
				warn(t("w_opt_create", { name: primaryName(ctx, names) }));
				res = 0;
			} else {
				const id = (await options.save(0, { type, sort_order: Math.round(num(so.sort_order)), names, values: [] })).id;
				res = { id, type };
				ctx.crmOptByName.set(k, res);
				await addRef(ctx, "options", id);
			}
		}
	}
	ctx.siteOptMap.set(siteId, res);
	return res;
}

function optValueId(ctx, opt, siteValueId, warn) {
	return serial(ctx, () => optValueIdRaw(ctx, opt, siteValueId, warn));
}
async function optValueIdRaw(ctx, opt, siteValueId, warn) {
	const sv = ctx.siteDict.option_values.get(Number(siteValueId));
	if (!sv) return null;
	const names = namesOf(ctx, sv.names);
	const k = key(primaryName(ctx, names));
	if (!k) return null;
	if (!ctx.optValues.has(opt.id)) ctx.optValues.set(opt.id, await valuesOf("products_option_values", "id_option_value", "id_option", opt.id, ctx.primary.id));
	const m = ctx.optValues.get(opt.id);
	if (m.has(k)) return m.get(k);
	if (ctx.opts.options !== "create") {
		warn(t("w_opt_value_missing", { name: primaryName(ctx, names) }));
		return null;
	}
	if (!ctx.write) {
		m.set(k, 0);
		return 0;
	}
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [r] = await conn.query(`INSERT INTO ${P}products_option_values (id_option, color_hex, sort_order) VALUES (?, ?, ?)`, [opt.id, opt.type === "color" ? "#999999" : null, Math.round(num(sv.sort_order))]);
		await insertNames(conn, "products_option_values_description", "id_option_value", r.insertId, names, false);
		await conn.commit();
		m.set(k, r.insertId);
		await addRef(ctx, "option_values", r.insertId);
		return r.insertId;
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

/** Опції товару сайту → body.options картки: надбавки до ціни / ваги / балів зі знаком, залишок значення */
async function buildOptions(ctx, it, warn) {
	const out = [];
	let pending = 0;
	if (ctx.opts.options === "none") return { list: out, pending };
	for (const o of it.options || []) {
		const opt = await mapOption(ctx, Number(o.option_id), warn);
		if (opt === 0) {
			pending++;
			continue;
		}
		if (!opt) continue;
		if (out.some((x) => x.id_option === opt.id)) {
			warn(t("w_opt_duplicate", { id: o.option_id }));
			continue;
		}
		if (!OPT_VALUE_TYPES.includes(opt.type)) {
			out.push({ id_option: opt.id, is_required: !!Number(o.required), default_value: clip(o.value, 255) || null, values: [] });
			continue;
		}
		const values = [];
		for (const v of o.values || []) {
			const id = await optValueId(ctx, opt, v.option_value_id, warn);
			if (id === 0) {
				pending++;
				continue;
			}
			if (!id || values.some((x) => x.id_option_value === id)) continue;
			values.push({
				id_option_value: id,
				price_mode: "fixed",
				price: num(v.price),
				points: Math.round(num(v.points)),
				weight: num(v.weight),
				quantity: Math.max(0, num(v.quantity)),
				subtract_stock: !!Number(v.subtract),
				is_default: false,
			});
		}
		if (values.length) out.push({ id_option: opt.id, is_required: !!Number(o.required), default_value: null, values });
		else if ((o.values || []).length && !pending) warn(t("w_opt_no_values", { id: o.option_id }));
	}
	return { list: out, pending };
}

/** Після імпорту: пов'язані товари сайту → пов'язані в системі (лише для створених цим завданням, через зв'язки інтеграції) */
async function linkRelated(ctx) {
	if (!ctx.write || ctx.opts.related === false) return;
	let lastId = 0;
	for (;;) {
		const [rows] = await pool.query(
			`SELECT id, id_product, related FROM ${P}products_import_items
			  WHERE id_job = ? AND action = 'create' AND id_product IS NOT NULL AND related IS NOT NULL AND id > ? ORDER BY id LIMIT 500`,
			[ctx.idJob, lastId]
		);
		if (!rows.length) break;
		lastId = Number(rows[rows.length - 1].id);
		const ext = [...new Set(rows.flatMap((r) => parseJson(r.related, []).map(String)))];
		const byExt = new Map();
		for (let i = 0; i < ext.length; i += 1000) {
			const [links] = await pool.query(
				`SELECT l.external_id, l.id_product FROM ${P}products_external_links l JOIN ${P}products p ON p.id = l.id_product AND p.deleted_at IS NULL
				  WHERE l.id_integration = ? AND l.external_variant_id = '' AND l.external_id IN (?)`,
				[ctx.integ.id, ext.slice(i, i + 1000)]
			);
			links.forEach((l) => byExt.set(String(l.external_id), Number(l.id_product)));
		}
		const ins = [];
		for (const r of rows) {
			parseJson(r.related, []).forEach((e, i) => {
				const id = byExt.get(String(e));
				if (id && id !== Number(r.id_product)) ins.push([Number(r.id_product), id, "related", i]);
			});
		}
		if (ins.length) await pool.query(`INSERT IGNORE INTO ${P}products_related (id_product, id_related, type, sort_order) VALUES ?`, [ins]);
	}
}

/** Відкат довідників етапу 2: лише створені цим завданням і ніде більше не вжиті */
async function rollbackDictionaries(refs, createdProducts, stats) {
	if (createdProducts.length) {
		for (let i = 0; i < createdProducts.length; i += 1000) {
			const ids = createdProducts.slice(i, i + 1000);
			await pool.query(`DELETE FROM ${P}products_to_attributes WHERE id_product IN (?)`, [ids]);
			await pool.query(`DELETE FROM ${P}products_to_attributes_text WHERE id_product IN (?)`, [ids]);
			await pool.query(`DELETE FROM ${P}products_to_options WHERE id_product IN (?)`, [ids]);
			await pool.query(`DELETE FROM ${P}products_related WHERE id_product IN (?) OR id_related IN (?)`, [ids, ids]);
		}
	}
	const tryDelete = async (list, usedSql, delSql, statKey) => {
		for (const id of [...(list || [])].reverse()) {
			try {
				const [[u]] = await pool.query(usedSql, Array(usedSql.split("?").length - 1).fill(id));
				if (Number(u.n)) continue;
				await pool.query(delSql, [id]);
				stats[statKey] = (stats[statKey] || 0) + 1;
			} catch (e) {
				stats.errors.push(`${statKey} #${id}: ${e.message}`);
			}
		}
	};
	await tryDelete(
		refs.attribute_values,
		`SELECT (SELECT COUNT(*) FROM ${P}products_to_attributes WHERE id_attribute_value = ?) + (SELECT COUNT(*) FROM ${P}products_variant_values WHERE id_attribute_value = ?) AS n`,
		`DELETE FROM ${P}products_attribute_values WHERE id = ?`,
		"attribute_values"
	);
	await tryDelete(refs.option_values, `SELECT COUNT(*) AS n FROM ${P}products_to_option_values WHERE id_option_value = ?`, `DELETE FROM ${P}products_option_values WHERE id = ?`, "option_values");
	await tryDelete(
		refs.attributes,
		`SELECT (SELECT COUNT(*) FROM ${P}products_to_attributes WHERE id_attribute = ?) + (SELECT COUNT(*) FROM ${P}products_to_attributes_text WHERE id_attribute = ?)
		      + (SELECT COUNT(*) FROM ${P}products_attribute_values WHERE id_attribute = ?) AS n`,
		`DELETE FROM ${P}products_attributes WHERE id = ?`,
		"attributes"
	);
	await tryDelete(refs.attribute_groups, `SELECT COUNT(*) AS n FROM ${P}products_attributes WHERE id_attribute_group = ?`, `DELETE FROM ${P}products_attribute_groups WHERE id = ?`, "attribute_groups");
	await tryDelete(refs.options, `SELECT COUNT(*) AS n FROM ${P}products_to_options WHERE id_option = ?`, `DELETE FROM ${P}products_options WHERE id = ?`, "options");
}

/* ═══ Імпорт за розкладом ═════════════════════════════════════════════════ */

const SCHEDULE_HOURS = [0, 1, 3, 6, 12, 24]; // 0 — вимкнено, 24 — щодня в указаний час
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Розклад інтеграції: інтервал, час (для щоденного), збережені налаштування, останній і наступний запуск */
async function getSchedule(idIntegration) {
	const [[r]] = await pool.query(
		`SELECT import_schedule_hours AS hours, TIME_FORMAT(import_schedule_at, '%H:%i') AS at, import_schedule_options AS options, import_schedule_last AS last,
		        CASE
		          WHEN import_schedule_hours = 0 THEN NULL
		          WHEN import_schedule_hours = 24 THEN
		            IF(import_schedule_last IS NOT NULL AND import_schedule_last >= TIMESTAMP(CURDATE(), import_schedule_at),
		               TIMESTAMP(CURDATE() + INTERVAL 1 DAY, import_schedule_at),
		               IF(CURTIME() >= import_schedule_at, NOW(), TIMESTAMP(CURDATE(), import_schedule_at)))
		          ELSE GREATEST(COALESCE(import_schedule_last + INTERVAL import_schedule_hours HOUR, NOW()), NOW())
		        END AS next
		   FROM ${P}settings_integrations WHERE id = ?`,
		[idIntegration]
	);
	if (!r) throw httpErr(404, t("integration_not_found"));
	return { hours: Number(r.hours) || 0, at: r.at || "03:00", options: parseJson(r.options, null), last: r.last, next: r.next };
}

async function saveSchedule(idIntegration, body = {}) {
	await integrationRow(idIntegration);
	const hours = SCHEDULE_HOURS.includes(parseInt(body.hours, 10)) ? parseInt(body.hours, 10) : 0;
	const at = TIME_RE.test(String(body.at || "")) ? String(body.at) : "03:00";
	// За розкладом — завжди повний прохід усіма товарами сайту
	const opts = { ...normalizeOptions("full", body.options || {}), limit: 0, ids: [] };
	if (hours && !opts.match.length) throw httpErr(400, t("no_rules"), "invalid");
	await pool.query(
		`UPDATE ${P}settings_integrations SET import_schedule_hours = ?, import_schedule_at = ?, import_schedule_options = ? WHERE id = ?`,
		[hours, `${at}:00`, JSON.stringify(opts), idIntegration]
	);
	return getSchedule(idIntegration);
}

/** Щохвилини: запустити повний імпорт для інтеграцій, яким настав час. Зайнята інтеграція — спробуємо наступної хвилини */
async function scheduleTick() {
	const [due] = await pool.query(
		`SELECT id, import_schedule_options AS options FROM ${P}settings_integrations
		  WHERE status = 'active' AND import_schedule_hours > 0 AND import_schedule_options IS NOT NULL
		    AND (
		      (import_schedule_hours < 24 AND (import_schedule_last IS NULL OR import_schedule_last <= NOW() - INTERVAL import_schedule_hours HOUR))
		      OR (import_schedule_hours = 24 AND CURTIME() >= import_schedule_at
		          AND (import_schedule_last IS NULL OR import_schedule_last < TIMESTAMP(CURDATE(), import_schedule_at)))
		    )`
	);
	const started = [];
	for (const r of due) {
		try {
			const res = await start(Number(r.id), { mode: "full", options: parseJson(r.options, {}) }, null, "schedule");
			await pool.query(`UPDATE ${P}settings_integrations SET import_schedule_last = NOW() WHERE id = ?`, [r.id]);
			started.push({ id_integration: Number(r.id), id_job: res.id });
		} catch (e) {
			if (e.code !== "busy") {
				logging.error(e);
				// Помилка налаштувань (валюта, мови) не повинна повторюватись щохвилини
				await pool.query(`UPDATE ${P}settings_integrations SET import_schedule_last = NOW() WHERE id = ?`, [r.id]).catch(() => {});
			}
		}
	}
	return started;
}

/* ═══ Відкат пробного / повного імпорту ═══════════════════════════════════ */

/** Запуск відкату у фоні (на великому імпорті триває довго): статус rolling_back → rolled_back */
async function rollback(idIntegration, idJob, idUser = null) {
	const j = await jobRow(idIntegration, idJob);
	if (!publicJob(j).can_rollback) throw httpErr(409, t("not_rollbackable"), "not_rollbackable");
	if (running.size && [...running.keys()].some((id) => id !== Number(j.id))) {
		const [[other]] = await pool.query(`SELECT id FROM ${P}products_import_jobs WHERE id_integration = ? AND id IN (?)`, [idIntegration, [...running.keys()]]);
		if (other) throw httpErr(409, t("busy", { id: other.id }), "busy");
	}
	const integ = await integrationRow(idIntegration);
	await pool.query(`UPDATE ${P}products_import_jobs SET status = 'rolling_back', heartbeat = NOW() WHERE id = ?`, [j.id]);
	const state = { cancel: false };
	running.set(Number(j.id), state);
	doRollback(integ, j, idUser)
		.catch(async (e) => {
			logging.error(e);
			await pool.query(`UPDATE ${P}products_import_jobs SET status = 'failed', message = ? WHERE id = ?`, [t("rollback_failed", { msg: e.message }).slice(0, 1000), j.id]).catch(() => {});
		})
		.finally(() => running.delete(Number(j.id)));
	return { started: true };
}

async function doRollback(integ, j, idUser) {
	const idIntegration = Number(integ.id);
	const idJob = Number(j.id);
	const stats = { products: 0, restored: 0, links: 0, categories: 0, brands: 0, errors: [] };
	const siteUnlink = [];

	// 1. Створені товари → у кошик
	const [created] = await pool.query(
		`SELECT i.id_product FROM ${P}products_import_items i JOIN ${P}products p ON p.id = i.id_product AND p.deleted_at IS NULL
		  WHERE i.id_job = ? AND i.action = 'create'`,
		[idJob]
	);
	for (const r of created) {
		try {
			await trash.softDelete("products", Number(r.id_product), idUser);
			await history.record("products", Number(r.id_product), { user: idUser, source: "import", action: "delete", meta: { import_job: Number(idJob), rollback: true } }).catch(() => {});
			stats.products++;
			siteUnlink.push({ entity: "product", crm_id: Number(r.id_product) });
		} catch (e) {
			stats.errors.push(`#${r.id_product}: ${e.message}`);
		}
	}

	// 2. Оновлені товари → попередні ціна / статус / залишок
	const [upd] = await pool.query(`SELECT id_product, before_state FROM ${P}products_import_items WHERE id_job = ? AND action = 'update' AND before_state IS NOT NULL`, [idJob]);
	const langIds = (await languages.active()).map((l) => l.id);
	const opts = parseJson(j.options, {});
	for (const r of upd) {
		const b = parseJson(r.before_state, null);
		if (!b) continue;
		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();
			if (opts.update && opts.update.price && b.price !== null && b.price !== undefined) await conn.query(`UPDATE ${P}products SET price = ?, version = version + 1 WHERE id = ? AND price_auto = 0`, [b.price, r.id_product]);
			if (opts.update && opts.update.status && b.status) await conn.query(`UPDATE ${P}products SET status = ?, version = version + 1 WHERE id = ?`, [b.status, r.id_product]);
			if (b.content) await restoreContent(conn, Number(r.id_product), b.content, { langIds });
			if (opts.update && opts.update.stock && b.stock !== null && b.stock !== undefined && opts.id_warehouse !== undefined) {
				const stockCfg = await settings.get("stock");
				const wh = opts.id_warehouse || (stockCfg && stockCfg.id_default_warehouse);
				if (wh) await stock.setQty(conn, { idProduct: Number(r.id_product), idWarehouse: Number(wh), qty: b.stock, type: "adjustment", refType: "import", refId: Number(idJob), idUser, comment: `Import #${idJob} rollback` });
			}
			await conn.commit();
			stats.restored++;
		} catch (e) {
			await conn.rollback().catch(() => {});
			stats.errors.push(`#${r.id_product}: ${e.message}`);
		} finally {
			conn.release();
		}
	}

	// 3. Зв'язки, створені завданням
	const [links] = await pool.query(`SELECT id_product, external_id FROM ${P}products_import_items WHERE id_job = ? AND link_new = 1 AND id_product IS NOT NULL`, [idJob]);
	for (let i = 0; i < links.length; i += 500) {
		const part = links.slice(i, i + 500);
		const [r] = await pool.query(
			`DELETE FROM ${P}products_external_links WHERE id_integration = ? AND external_variant_id = '' AND (id_product, external_id) IN (?)`,
			[idIntegration, part.map((l) => [Number(l.id_product), String(l.external_id)])]
		);
		stats.links += r.affectedRows;
	}
	for (const l of links) if (!siteUnlink.some((x) => x.entity === "product" && x.crm_id === Number(l.id_product))) siteUnlink.push({ entity: "product", crm_id: Number(l.id_product) });

	// 4. Створені категорії (від дітей до батьків; лише без товарів і підкатегорій) і бренди (лише без товарів)
	const refs = parseJson(j.created_refs, {});
	for (const idCat of [...(refs.categories || [])].reverse()) {
		const [[used]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products_to_categories pc JOIN ${P}products p ON p.id = pc.id_product AND p.deleted_at IS NULL WHERE pc.id_category = ?`, [idCat]);
		if (Number(used.n)) continue;
		try {
			await categories.remove(Number(idCat));
			stats.categories++;
			siteUnlink.push({ entity: "category", crm_id: Number(idCat) });
		} catch (e) {
			stats.errors.push(`category #${idCat}: ${e.message}`);
		}
	}
	for (const idBrand of refs.brands || []) {
		const [[used]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}products WHERE id_brand = ? AND deleted_at IS NULL`, [idBrand]);
		if (Number(used.n)) continue;
		try {
			await trash.softDelete("product_brands", Number(idBrand), idUser);
			stats.brands++;
		} catch (e) {
			stats.errors.push(`brand #${idBrand}: ${e.message}`);
		}
	}

	// 4а. Атрибути / опції / значення, створені завданням (зв'язки створених товарів з ними прибираються)
	const [allCreated] = await pool.query(`SELECT id_product FROM ${P}products_import_items WHERE id_job = ? AND action = 'create' AND id_product IS NOT NULL`, [idJob]);
	await rollbackDictionaries(refs, allCreated.map((r) => Number(r.id_product)), stats);

	// 5. Прибрати зв'язки на сайті (щоб обмін не вважав товари сайту «своїми»)
	for (let i = 0; i < siteUnlink.length; i += 500) {
		try {
			await client.call(integ, "export.unlink", { items: siteUnlink.slice(i, i + 500) });
		} catch (e) {
			stats.errors.push(`site: ${e.message}`);
		}
	}

	await pool.query(`UPDATE ${P}products_import_jobs SET status = 'rolled_back', message = ? WHERE id = ?`, [JSON.stringify(stats).slice(0, 1000), idJob]);
	return stats;
}

module.exports = { integrations, siteMeta, getSchedule, saveSchedule, scheduleTick, systemOptions, start, status, items, cancel, rollback, normalizeOptions, MODES };
