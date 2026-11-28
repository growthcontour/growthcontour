"use strict";

/**
 * Масове редагування товарів через чергу (таблиця products_bulk_jobs): і черга, і журнал масових змін.
 *
 * Людина відбирає товари (фільтри списку товарів або вставлений список артикулів / ID / EAN), задає дії по черзі,
 * дивиться перегляд «було → стане» і запускає. Набір товарів фіксується в момент запуску (інакше фільтр
 * «ціна < 100» разом із «+10 %» ловив би ті самі товари знову). Обробник бере по одній зміні, товари — шматками
 * з паузою (не навантажує базу), після кожного шматка зберігає курсор і лічильники та шле прогрес у сокет.
 * Перезапуск сервера чи падіння: зміна, що давно не подавала ознак життя, продовжується з курсора.
 *
 * Самі дії — ті самі, що в масових діях списку (bulk.js: prepare / runOps), історія — та сама (history.js:
 * пакет змін), відміна — той самий відкат пакета (лише поля, яких відтоді не чіпали), але теж через чергу й з прогресом.
 */
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const i18n = require("../../../config/i18n/i18n");
const logging = require("../../../logging/logging");
const bulk = require("./bulk");
const history = require("./history");
const editLock = require("./edit-lock");
const descriptions = require("./descriptions");
const bulkStock = require("./bulk-stock");

const P = config.get("configDatabase").prefix;
const T = `${P}products_bulk_jobs`;
const CHUNK = Math.max(1, parseInt(process.env.BULK_CHUNK, 10) || 50); // товарів за крок
const PAUSE_MS = Math.max(0, parseInt(process.env.BULK_PAUSE_MS, 10) || 200); // пауза між кроками
const STALE_MIN = 3; // без ознак життя стільки хвилин — обробник вважається зупиненим, зміну продовжує інший
const PREVIEW = 20;
const REPORT_MAX = 5000; // записів у звіті (пропущені, помилки)
const ROOM = "catalog:bulk";

const httpErr = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (v, def) => {
	if (v === null || v === undefined) return def;
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return def;
	}
};

/* ─── Відбір товарів ─── */

/** Токени вставленого списку: рядки, коми, крапки з комою, табуляція */
function tokens(text) {
	return [
		...new Set(
			String(text || "")
				.split(/[\r\n,;\t]+/)
				.map((s) => s.trim())
				.filter(Boolean)
		),
	];
}

/**
 * Набір товарів: { ids (за зростанням), not_found: перші невідомі рядки списку, not_found_count }.
 * filter — ті самі умови, що в списку товарів; list — артикули, EAN, ID (і артикули / EAN варіантів → їхній товар); ids — готові.
 */
async function resolve(selection) {
	if (selection.mode === "filter") {
		const { where, params } = await require("./products").filterWhere(selection.filter || {});
		const [rows] = await pool.query(`SELECT p.id FROM ${P}products p WHERE ${where.join(" AND ")} ORDER BY p.id`, params);
		return { ids: rows.map((r) => Number(r.id)), not_found: [], not_found_count: 0 };
	}
	if (selection.mode === "ids") {
		const found = new Set();
		const ids = selection.ids || [];
		for (let i = 0; i < ids.length; i += 1000) {
			const [rows] = await pool.query(`SELECT id FROM ${P}products WHERE deleted_at IS NULL AND id IN (?)`, [ids.slice(i, i + 1000)]);
			rows.forEach((r) => found.add(Number(r.id)));
		}
		const missing = ids.filter((id) => !found.has(id));
		return { ids: [...found].sort((a, b) => a - b), not_found: missing.slice(0, 50).map(String), not_found_count: missing.length };
	}
	// list
	const words = tokens(selection.list);
	const found = new Set();
	const matched = new Set();
	for (let i = 0; i < words.length; i += 1000) {
		const part = words.slice(i, i + 1000);
		const nums = part.filter((t) => /^\d{1,10}$/.test(t)).map(Number);
		const [rows] = await pool.query(
			`SELECT id, sku, ean FROM ${P}products WHERE deleted_at IS NULL AND (sku IN (?) OR ean IN (?)${nums.length ? " OR id IN (?)" : ""})`,
			nums.length ? [part, part, nums] : [part, part]
		);
		const [vars] = await pool.query(
			`SELECT v.id_product AS id, v.sku, v.ean FROM ${P}products_variants v JOIN ${P}products p ON p.id = v.id_product AND p.deleted_at IS NULL
			  WHERE v.sku IN (?) OR v.ean IN (?)`,
			[part, part]
		);
		for (const r of [...rows, ...vars]) {
			found.add(Number(r.id));
			if (r.sku) matched.add(String(r.sku));
			if (r.ean) matched.add(String(r.ean));
		}
		for (const r of rows) matched.add(String(r.id));
	}
	const missing = words.filter((t) => !matched.has(t));
	return { ids: [...found].sort((a, b) => a - b), not_found: missing.slice(0, 50), not_found_count: missing.length };
}

/* ─── Перегляд «було → стане» ─── */

/** Підписи значень, які людина інакше бачила б як номери: бренд, категорії, головна категорія */
async function humanize(rows, idLang) {
	const brands = new Set();
	const cats = new Set();
	for (const r of rows)
		for (const c of r.changes || []) {
			if (c.field === "id_brand") [c.old, c.new].forEach((v) => v && brands.add(Number(v)));
			if (c.field === "id_category_main") [c.old, c.new].forEach((v) => v && cats.add(Number(v)));
			if (c.field === "categories") [...(c.old || []), ...(c.new || [])].forEach((v) => cats.add(Number(v)));
		}
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const names = async (table, key, ids) => {
		if (!ids.size) return new Map();
		const [x] = await pool.query(
			`SELECT a.${key} AS id, COALESCE(NULLIF(b.name, ''), a.name) AS name FROM ${P}${table} a
			   LEFT JOIN ${P}${table} b ON b.${key} = a.${key} AND b.id_lang = ?
			  WHERE a.id_lang = ? AND a.${key} IN (?)`,
			[idLang, primary, [...ids]]
		);
		return new Map(x.map((r) => [Number(r.id), r.name]));
	};
	const bn = await names("products_brands_description", "id_brand", brands);
	const cn = await names("products_categories_description", "id_category", cats);
	const one = (map, v) => (v === null || v === undefined || v === "" ? null : map.get(Number(v)) || "#" + v);
	// Характеристики: назва характеристики — підписом поля, значення — словами
	const attrIds = new Set();
	const valIds = new Set();
	for (const r of rows)
		for (const c of r.changes || [])
			if (c.attr) {
				attrIds.add(Number(c.field.split(".")[1]));
				[c.old, c.new].forEach((sn) => (sn && sn.value_ids ? sn.value_ids : []).forEach((v) => valIds.add(v)));
			}
	const an = await names("products_attributes_description", "id_attribute", attrIds);
	const vn = await names("products_attribute_values_description", "id_attribute_value", valIds);
	const snapText = (sn) => {
		if (!sn) return null;
		if (sn.value_ids.length) return sn.value_ids.map((v) => one(vn, v)).join(", ");
		if (sn.number !== null) return String(sn.number);
		if (sn.date) return sn.date;
		const t = Object.values(sn.text || {});
		return t.length ? t[0] : null;
	};
	const langCode = new Map(langs.map((l) => [Number(l.id), String(l.code || l.iso || l.id).toUpperCase()]));
	for (const r of rows)
		for (const c of r.changes || []) {
			if (c.attr) Object.assign(c, { label: one(an, c.field.split(".")[1]), old: snapText(c.old), new: snapText(c.new) });
			if (c.lang) c.lang_code = langCode.get(Number(c.lang)) || String(c.lang);
			if (c.field === "id_brand") Object.assign(c, { old: one(bn, c.old), new: one(bn, c.new) });
			if (c.field === "id_category_main") Object.assign(c, { old: one(cn, c.old), new: one(cn, c.new) });
			if (c.field === "categories") Object.assign(c, { old: (c.old || []).map((v) => one(cn, v)).join(", "), new: (c.new || []).map((v) => one(cn, v)).join(", ") });
		}
}

/** Назви й артикули товарів для перегляду та звіту */
async function productNames(ids, idLang) {
	if (!ids.length) return new Map();
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const [rows] = await pool.query(
		`SELECT p.id, p.sku, COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', p.id)) AS name
		   FROM ${P}products p
		   LEFT JOIN ${P}products_description d ON d.id_product = p.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_description dp ON dp.id_product = p.id AND dp.id_lang = ?
		  WHERE p.id IN (?)`,
		[idLang, primary, ids]
	);
	return new Map(rows.map((r) => [Number(r.id), r]));
}

/**
 * Перегляд: перші PREVIEW товарів набору — той самий код, що й застосування, у транзакції з відкатом.
 * Тому перегляд точно збігається з тим, що буде (окрім товарів, які хтось змінить до запуску).
 */
async function preview(input, ctx, idLang) {
	const stockOp = bulkStock.stockOp(input.operations);
	if (!stockOp) for (const op of input.operations) await bulk.prepare(op.action, op.params, ctx);
	const sel = await resolve(input.selection);
	const sample = sel.ids.slice(0, PREVIEW);
	const names = await productNames(sample, idLang);
	const rows = [];
	// Залишки: «було → стане» по складу (і по кожному варіанту) — з тих самих розрахунків, що й документи
	if (stockOp) {
		for (const r of await bulkStock.preview(sample, stockOp.params, ctx)) {
			const n = names.get(Number(r.id)) || {};
			rows.push({ ...r, sku: n.sku || null, name: n.name || "#" + r.id });
		}
		return { total: sel.ids.length, not_found: sel.not_found, not_found_count: sel.not_found_count, sample: rows, shown: sample.length };
	}
	for (const id of sample) {
		const base = { id, sku: (names.get(id) || {}).sku || null, name: (names.get(id) || {}).name || "#" + id };
		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();
			const [[product]] = await conn.query(`SELECT * FROM ${P}products WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [id]);
			if (!product) {
				rows.push({ ...base, status: "error", message: "not found" });
				continue;
			}
			const h = await editLock.holder(id, conn);
			if (h) {
				rows.push({ ...base, status: "skipped", message: "locked", user_name: h.user_name });
				continue;
			}
			const changes = await bulk.runOps(conn, product, input.operations, ctx);
			rows.push({ ...base, status: changes.length ? "changed" : "unchanged", changes });
		} catch (e) {
			if (e.status) rows.push({ ...base, status: "error", message: e.message });
			else {
				logging.error(e);
				rows.push({ ...base, status: "error", message: "server error" });
			}
		} finally {
			// Перегляд нічого не зберігає
			await conn.rollback().catch(() => {});
			conn.release();
		}
	}
	await humanize(rows, idLang);
	return { total: sel.ids.length, not_found: sel.not_found, not_found_count: sel.not_found_count, sample: rows, shown: sample.length };
}

/* ─── Довідники для сторінки (фільтри й дії) ─── */

/** Категорії деревом (з відступом за глибиною), усі активні бренди, сайти з обміном каталогу */
async function refs(idLang) {
	const tree = await require("./categories").tree(idLang, { counts: false });
	const categories = [];
	const walk = (parent, depth) =>
		tree
			.filter((c) => (c.id_parent || null) === parent)
			.forEach((c) => {
				categories.push({ id: c.id, name: c.name, depth });
				walk(c.id, depth + 1);
			});
	walk(null, 0);
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const [brands] = await pool.query(
		`SELECT b.id, COALESCE(NULLIF(d.name, ''), NULLIF(dp.name, ''), b.code, CONCAT('#', b.id)) AS name
		   FROM ${P}products_brands b
		   LEFT JOIN ${P}products_brands_description d ON d.id_brand = b.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_brands_description dp ON dp.id_brand = b.id AND dp.id_lang = ?
		  WHERE b.deleted_at IS NULL
		  ORDER BY name`,
		[idLang, primary]
	);
	const channels = await require("../../settings/integrations/assortment").catalogIntegrations();
	// Характеристики (без значень — значення вибраної підвантажуються окремо: їх може бути тисячі)
	const [attributes] = await pool.query(
		`SELECT a.id, a.type, a.is_translatable, COALESCE(NULLIF(d.name, ''), NULLIF(dp.name, ''), a.code) AS name
		   FROM ${P}products_attributes a
		   LEFT JOIN ${P}products_attributes_description d ON d.id_attribute = a.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_attributes_description dp ON dp.id_attribute = a.id AND dp.id_lang = ?
		  ORDER BY name`,
		[idLang, primary]
	);
	return {
		categories,
		brands,
		channels: channels.map((c) => ({ id: c.id, name: c.name })),
		attributes: attributes.map((a) => ({ id: a.id, type: a.type, name: a.name })),
		languages: langs.map((l) => ({ id: Number(l.id), code: String(l.code || l.iso || "").toUpperCase(), name: l.native_name || l.name })),
	};
}

/** Значення характеристики (для вибору в дії «Характеристика») */
async function attrValues(idAttribute, idLang) {
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const [rows] = await pool.query(
		`SELECT v.id, COALESCE(NULLIF(d.name, ''), NULLIF(dp.name, ''), v.code) AS name
		   FROM ${P}products_attribute_values v
		   LEFT JOIN ${P}products_attribute_values_description d ON d.id_attribute_value = v.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_attribute_values_description dp ON dp.id_attribute_value = v.id AND dp.id_lang = ?
		  WHERE v.id_attribute = ?
		  ORDER BY v.sort_order, v.id`,
		[idLang, primary, idAttribute]
	);
	return rows;
}

/* ─── Запуск, журнал, відміна ─── */

/** ISO-час від браузера → рядок UTC для DATETIME (час у базі для розкладу — UTC, порівнюється з UTC_TIMESTAMP()) */
const utc = (iso) => (iso ? new Date(iso).toISOString().slice(0, 19).replace("T", " ") : null);

/**
 * Поставити масову зміну в чергу. ctx: { idUser, perms, locale }.
 * input.run_at — запустити не раніше (розклад); input.revert_at — автоматично відмінити в цей час (кінець акції).
 */
async function create(input, ctx) {
	const stockOp = bulkStock.stockOp(input.operations);
	if (stockOp) await bulkStock.prepare(stockOp.params, ctx);
	else for (const op of input.operations) await bulk.prepare(op.action, op.params, ctx);
	const sel = await resolve(input.selection);
	if (!sel.ids.length) throw httpErr(400, "catalog.bulk_new.e_empty");
	const [r] = await pool.query(
		`INSERT INTO ${T} (kind, status, run_at, revert_at, title, selection, ids, operations, perms, total, id_user, locale, date_add)
		 VALUES ('edit', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
		[
			utc(input.run_at),
			utc(input.revert_at),
			input.title || null,
			JSON.stringify(input.selection.mode === "list" ? { mode: "list", count: tokens(input.selection.list).length } : input.selection),
			JSON.stringify(sel.ids),
			JSON.stringify(input.operations),
			JSON.stringify(ctx.perms),
			sel.ids.length,
			ctx.idUser,
			String(ctx.locale || "uk").slice(0, 8),
		]
	);
	kick();
	return { id: r.insertId, total: sel.ids.length };
}

const SELECT = `j.id, j.kind, j.status,
	DATE_FORMAT(j.run_at, '%Y-%m-%dT%H:%i:%sZ') AS run_at, DATE_FORMAT(j.revert_at, '%Y-%m-%dT%H:%i:%sZ') AS revert_at,
	(j.run_at IS NOT NULL AND j.run_at > UTC_TIMESTAMP()) AS scheduled, j.title, j.selection, j.operations, j.total, j.processed, j.changed, j.unchanged, j.skipped, j.errors,
	j.batch, j.id_source, j.id_reverted_by, j.is_template, j.cancel_requested, j.error, j.id_user, j.date_add, j.started_at, j.finished_at,
	NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS user_name,
	rv.status AS revert_status`;
const FROM = `${T} j LEFT JOIN ${P}users u ON u.id = j.id_user LEFT JOIN ${T} rv ON rv.id = j.id_reverted_by`;

function shape(j) {
	const operations = parse(j.operations, []);
	const stock = !!bulkStock.stockOp(operations);
	return {
		...j,
		selection: parse(j.selection, null),
		operations,
		stock,
		cancel_requested: !!j.cancel_requested,
		is_template: !!Number(j.is_template),
		scheduled: !!Number(j.scheduled) && j.status === "queued",
		can_cancel: ["queued", "running"].includes(j.status),
		// Упала з помилкою (база, мережа) — продовжити з того самого товару
		can_resume: j.status === "failed" && Number(j.processed) < Number(j.total) && !(j.kind === "edit" && j.id_reverted_by),
		// Відмінити можна завершену (або зупинену) зміну, яка щось змінила й ще не відмінена
		// Залишки — без пакета історії: відміна скасовує складські документи зміни
		can_revert: j.kind === "edit" && ["done", "cancelled", "failed"].includes(j.status) && (stock || !!j.batch) && !j.id_reverted_by && Number(j.changed) > 0,
	};
}

/** Журнал масових змін (Tabulator: page, size) */
async function list(f = {}) {
	const size = Math.min(Math.max(parseInt(f.size, 10) || 20, 1), 100);
	const page = Math.max(parseInt(f.page, 10) || 1, 1);
	const where = ["1 = 1"];
	const params = [];
	if (["queued", "running", "done", "failed", "cancelled"].includes(f.status)) {
		where.push("j.status = ?");
		params.push(f.status);
	}
	if (["edit", "revert"].includes(f.kind)) {
		where.push("j.kind = ?");
		params.push(f.kind);
	}
	if (f.kind === "template") where.push("j.kind = 'edit' AND j.is_template = 1");
	const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T} j WHERE ${where.join(" AND ")}`, params);
	const [rows] = await pool.query(`SELECT ${SELECT} FROM ${FROM} WHERE ${where.join(" AND ")} ORDER BY j.id DESC LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]);
	return { last_page: Math.max(1, Math.ceil(n / size)), last_row: Number(n), data: rows.map(shape) };
}

/** Одна зміна зі звітом */
async function get(id, idLang) {
	const [[j]] = await pool.query(`SELECT ${SELECT}, j.report FROM ${FROM} WHERE j.id = ?`, [id]);
	if (!j) throw httpErr(404, "catalog.bulk_job.e_not_found");
	const report = parse(j.report, []);
	const names = await productNames([...new Set(report.map((r) => Number(r.id)).filter(Boolean))].slice(0, REPORT_MAX), idLang);
	delete j.report;
	const shaped = shape(j);
	// Залишки: документи зміни (для відміни — документи зміни-джерела)
	if (shaped.stock) shaped.documents = await bulkStock.documents(j.id);
	return { ...shaped, report: report.map((r) => ({ ...r, sku: (names.get(Number(r.id)) || {}).sku || null, name: (names.get(Number(r.id)) || {}).name || "#" + r.id })) };
}

/** Зупинити: у черзі — одразу, в роботі — після поточного товару */
async function cancel(id) {
	const [q] = await pool.query(`UPDATE ${T} SET status = 'cancelled', finished_at = NOW() WHERE id = ? AND status = 'queued'`, [id]);
	if (q.affectedRows) {
		emit({ id, status: "cancelled" });
		return { status: "cancelled" };
	}
	const [r] = await pool.query(`UPDATE ${T} SET cancel_requested = 1 WHERE id = ? AND status = 'running'`, [id]);
	if (!r.affectedRows) throw httpErr(409, "catalog.bulk_job.e_not_running");
	return { status: "running", cancel_requested: true };
}

/** Продовжити зміну, що впала з помилкою: з наступного необробленого товару (курсор у базі) */
async function resume(id) {
	const [r] = await pool.query(
		`UPDATE ${T} SET status = 'queued', error = NULL, finished_at = NULL, cancel_requested = 0 WHERE id = ? AND status = 'failed' AND processed < total AND (kind = 'revert' OR id_reverted_by IS NULL)`,
		[id]
	);
	if (!r.affectedRows) throw httpErr(409, "catalog.bulk_job.e_cannot_resume");
	// Відміна, що впала, звільнила зміну-джерело — займаємо її знову
	const [[j]] = await pool.query(`SELECT kind, id_source FROM ${T} WHERE id = ?`, [id]);
	if (j.kind === "revert") {
		const [u] = await pool.query(`UPDATE ${T} SET id_reverted_by = ? WHERE id = ? AND id_reverted_by IS NULL`, [id, j.id_source]);
		if (!u.affectedRows) {
			await pool.query(`UPDATE ${T} SET status = 'failed' WHERE id = ?`, [id]);
			throw httpErr(409, "catalog.bulk_job.e_cannot_resume");
		}
	}
	kick();
	emit({ id, status: "queued" });
	return { status: "queued" };
}

/** Відмінити зміну цілком — окремою зміною в черзі. Повертає id відміни */
async function revert(id, ctx) {
	const [[j]] = await pool.query(`SELECT * FROM ${T} WHERE id = ?`, [id]);
	if (!j) throw httpErr(404, "catalog.bulk_job.e_not_found");
	const sj = shape(j);
	if (!sj.can_revert) throw httpErr(409, "catalog.bulk_job.e_cannot_revert");
	// Залишки: відміна = скасування документів, на це потрібне окреме право
	if (sj.stock && !(ctx.perms && ctx.perms.stockDelete)) throw httpErr(403, "Forbidden");
	const items = sj.stock
		? await bulkStock.documents(j.id)
		: await history.batchItems(j.batch).catch((e) => {
				throw e.code === "reverted" ? httpErr(409, "catalog.bulk_job.e_cannot_revert") : e;
			});
	if (!items.length) throw httpErr(409, "catalog.bulk_job.e_cannot_revert");
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [r] = await conn.query(
			`INSERT INTO ${T} (kind, status, title, total, id_source, perms, id_user, locale, date_add) VALUES ('revert', 'queued', ?, ?, ?, ?, ?, ?, NOW())`,
			[j.title, items.length, j.id, JSON.stringify(ctx.perms), ctx.idUser, String(ctx.locale || "uk").slice(0, 8)]
		);
		// Атомарно: двічі одну зміну не відміняють навіть із двох вкладок
		const [u] = await conn.query(`UPDATE ${T} SET id_reverted_by = ? WHERE id = ? AND id_reverted_by IS NULL`, [r.insertId, j.id]);
		if (!u.affectedRows) throw httpErr(409, "catalog.bulk_job.e_cannot_revert");
		await conn.commit();
		kick();
		return { id: r.insertId };
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

/* ─── Обробник ─── */

function emit(data) {
	try {
		const io = require("../../socket/socket").getIO();
		if (io) io.to(ROOM).emit("catalog:bulk", data);
	} catch {
		/* сокет недоступний — прогрес видно після оновлення сторінки */
	}
}

function emitProduct(id, by) {
	try {
		const io = require("../../socket/socket").getIO();
		if (io) io.to(editLock.room(id)).emit("product:saved", { id, by, bulk: true });
	} catch {
		/* відкритих карток немає */
	}
}

/** Взяти зміну: найстаріша в черзі або та, чий обробник давно мовчить (впав / перезапуск) */
async function claim() {
	const conn = await pool.getConnection();
	try {
		const [r] = await conn.query(
			`UPDATE ${T} SET status = 'running', started_at = COALESCE(started_at, NOW()), heartbeat_at = NOW(), id = LAST_INSERT_ID(id)
			  WHERE (status = 'queued' AND (run_at IS NULL OR run_at <= UTC_TIMESTAMP()))
			     OR (status = 'running' AND heartbeat_at < NOW() - INTERVAL ? MINUTE)
			  ORDER BY id LIMIT 1`,
			[STALE_MIN]
		);
		if (!r.affectedRows) return null;
		const [[j]] = await conn.query(`SELECT * FROM ${T} WHERE id = LAST_INSERT_ID()`);
		return j || null;
	} finally {
		conn.release();
	}
}

/** Лічильники й курсор — у рядок зміни (conn — та сама транзакція, що й зміна товару) */
function cursorSql(state, processed) {
	return [`UPDATE ${T} SET processed = ?, changed = ?, unchanged = ?, skipped = ?, errors = ? WHERE id = ?`, [processed, state.c.changed, state.c.unchanged, state.c.skipped, state.c.errors, state.id]];
}

/**
 * Один товар: усі дії в одній транзакції; відкрита картка — пропуск.
 * Курсор (processed) зберігається в ТІЙ САМІЙ транзакції, що й зміна товару: після падіння сервера зміна
 * продовжується рівно з наступного товару — «+10 %» ніколи не застосується до товару двічі.
 */
async function editProduct(id, ops, ctx, state, processed) {
	const conn = await pool.getConnection();
	const skip = async (status, message, extra) => {
		await conn.rollback();
		state.c[status === "skipped" ? "skipped" : "errors"]++;
		state.report.push({ id, status, message, ...(extra || {}) });
		await pool.query(...cursorSql(state, processed));
	};
	try {
		await conn.beginTransaction();
		const [[product]] = await conn.query(`SELECT * FROM ${P}products WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [id]);
		if (!product) return await skip("error", "not_found");
		const h = await editLock.holder(id, conn);
		if (h) return await skip("skipped", "locked", { user_name: h.user_name });
		const changes = await bulk.runOps(conn, product, ops, ctx);
		state.c[changes.length ? "changed" : "unchanged"]++;
		await conn.query(...cursorSql(state, processed));
		await conn.commit();
		if (!changes.length) return;
		await history.record("products", id, { user: ctx.idUser, source: "bulk", action: "update", changes, meta: { job: state.id }, batch: await state.batch() });
		emitProduct(id, ctx.idUser);
	} catch (e) {
		await conn.rollback().catch(() => {});
		// Транзакцію відкочено — лічильник «змінено / без змін» міг уже збільшитись, повертаємо з бази
		const [[cur]] = await pool.query(`SELECT changed, unchanged FROM ${T} WHERE id = ?`, [state.id]);
		state.c.changed = Number(cur.changed);
		state.c.unchanged = Number(cur.unchanged);
		state.c.errors++;
		state.report.push({ id, status: "error", message: e.status ? e.message : "server_error" });
		if (!e.status) logging.error(e);
		await pool.query(...cursorSql(state, processed)).catch((x) => logging.error(x));
	} finally {
		conn.release();
	}
}

/** Крок: звіт і «серцебиття» в базу, прогрес у сокет. Повертає, чи попросили зупинитись */
async function saveStep(j, state, processed) {
	await pool.query(`UPDATE ${T} SET report = ?, heartbeat_at = NOW() WHERE id = ?`, [JSON.stringify(state.report.slice(0, REPORT_MAX)), j.id]);
	emit({ id: j.id, kind: j.kind, status: "running", total: Number(j.total), processed, ...state.c });
	const [[x]] = await pool.query(`SELECT cancel_requested FROM ${T} WHERE id = ?`, [j.id]);
	return !!(x && x.cancel_requested);
}

/** Хуки для обробки залишків: курсор і лічильники — у зміну, крок — прогрес і «зупинити» */
const stockHooks = (j, state) => ({
	saveCursor: (processed) => pool.query(...cursorSql(state, processed)),
	step: async (processed) => {
		const stop = await saveStep(j, state, processed);
		if (!stop && PAUSE_MS && processed < Number(j.total)) await sleep(PAUSE_MS);
		return stop;
	},
});

async function runEdit(j, state) {
	const ops = parse(j.operations, []);
	if (bulkStock.stockOp(ops)) return bulkStock.run(j, state, stockHooks(j, state));
	const ids = parse(j.ids, []);
	const ctx = { idUser: Number(j.id_user), perms: parse(j.perms, {}) };
	// Права й довідники — ще раз: між запуском і обробкою бренд могли видалити
	for (const op of ops) await bulk.prepare(op.action, op.params || {}, ctx);
	// Пакет історії — при першій реальній зміні; id одразу в зміну, щоб після перезапуску писати в той самий
	let batchPromise = j.batch ? Promise.resolve(j.batch) : null;
	state.batch = () =>
		batchPromise ||
		(batchPromise = history.newBatch({ source: "bulk", user: ctx.idUser, title: j.title || "bulk", meta: { job: j.id, operations: ops } }).then(async (b) => {
			await pool.query(`UPDATE ${T} SET batch = ? WHERE id = ?`, [b, j.id]);
			return b;
		}));
	for (let i = Number(j.processed); i < ids.length; i++) {
		await editProduct(Number(ids[i]), ops, ctx, state, i + 1);
		// Крок: кожні CHUNK товарів — прогрес, перевірка «зупинити», пауза для бази
		if ((i + 1) % CHUNK === 0 || i + 1 === ids.length) {
			if (await saveStep(j, state, i + 1)) return "cancelled";
			if (PAUSE_MS && i + 1 < ids.length) await sleep(PAUSE_MS);
		}
	}
	return "done";
}

async function runRevert(j, state) {
	const [[src]] = await pool.query(`SELECT id, batch, operations FROM ${T} WHERE id = ?`, [j.id_source]);
	if (src && bulkStock.stockOp(parse(src.operations, []))) return bulkStock.revert(j, src, state, stockHooks(j, state));
	if (!src || !src.batch) throw new Error("Source job has no history batch");
	let items;
	try {
		items = await history.batchItems(src.batch);
	} catch (e) {
		// Уже позначено відкоченим (обробник упав після останнього кроку) — завершуємо
		if (e.code === "reverted") return "done";
		throw e;
	}
	const release = history.revertLock(src.batch);
	try {
		const idUser = Number(j.id_user);
		for (let i = Number(j.processed); i < items.length; i++) {
			const it = items[i];
			const res = { reverted: 0, deleted: 0, restored: 0, skipped: [] };
			await history.revertItem(it, idUser, src.batch, res);
			const s = res.skipped[0];
			// Усі поля змінено пізніше — нічого повертати: це пропуск, а не помилка
			if (s && (s.error === "not_revertable" || s.error === "locked")) {
				state.c.skipped++;
				state.report.push({ id: it.id, status: "skipped", message: s.error });
			} else if (s && s.error) {
				state.c.errors++;
				state.report.push({ id: it.id, status: "error", message: String(s.error) });
			} else {
				state.c.changed++;
				// Поля, змінені вже після масової зміни, не чіпаємо — показуємо у звіті
				if (s && s.fields) {
					state.c.skipped++;
					state.report.push({ id: it.id, status: "skipped", message: "changed_later", fields: s.fields });
				}
				emitProduct(it.id, idUser);
			}
			await pool.query(...cursorSql(state, i + 1));
			if ((i + 1) % CHUNK === 0 || i + 1 === items.length) {
				if (await saveStep(j, state, i + 1)) return "cancelled";
				if (PAUSE_MS && i + 1 < items.length) await sleep(PAUSE_MS);
			}
		}
		// Повністю відкочено — пакет позначається (в «Історії змін» теж видно відміну)
		await history.markReverted(src.batch, idUser, { reverted: state.c.changed, deleted: 0, restored: 0, skipped: state.report });
	} finally {
		release();
	}
	return "done";
}

async function process1(j) {
	const state = {
		id: j.id,
		c: { changed: Number(j.changed), unchanged: Number(j.unchanged), skipped: Number(j.skipped), errors: Number(j.errors) },
		report: parse(j.report, []),
	};
	let status = "failed";
	let error = null;
	try {
		status = j.kind === "revert" ? await runRevert(j, state) : await runEdit(j, state);
	} catch (e) {
		error = String(e.message || e).slice(0, 1000);
		logging.error(e);
	}
	await pool.query(`UPDATE ${T} SET status = ?, error = ?, finished_at = NOW(), heartbeat_at = NULL WHERE id = ?`, [status, error, j.id]).catch((e) => logging.error(e));
	// Відміну зупинили чи вона впала — зміну можна відмінити знову (уже повернуті поля пропустяться самі)
	if (j.kind === "revert" && status !== "done") await pool.query(`UPDATE ${T} SET id_reverted_by = NULL WHERE id = ? AND id_reverted_by = ?`, [j.id_source, j.id]).catch((e) => logging.error(e));
	emit({ id: j.id, kind: j.kind, status, total: Number(j.total), processed: status === "done" ? Number(j.total) : undefined, ...state.c });
	notifyAuthor(j, status, state.c);
}

/** Автору — у дзвіночок (через ядро сповіщень) */
function notifyAuthor(j, status, c) {
	try {
		const locale = j.locale || "uk";
		const t = (phrase, vars) => i18n.__({ phrase, locale }, vars || {});
		const { notify } = require("../../notifications");
		Promise.resolve(
			notify({
				type: "catalog.bulk_" + status,
				channels: ["inapp"],
				audience: { user: Number(j.id_user) },
				key: `catalog_bulk_${j.id}_${status}`,
				priority: status === "failed" ? 6 : 4,
				payload: {
					title: t(`catalog.bulk_job.n_${j.kind}_${status}`),
					name: j.title || t("catalog.bulk_job.n_name", { id: String(j.id) }),
					message: t("catalog.bulk_job.n_counts", { changed: String(c.changed), skipped: String(c.skipped), errors: String(c.errors) }),
					url: `/catalog/bulk/${j.id}/`,
				},
			})
		).catch((e) => logging.error(e));
	} catch (e) {
		logging.error(e);
	}
}

/* По одній зміні за раз на процес: масова зміна — фонова робота, не має забирати всю базу */
let busy = false;
let timer = null;

async function tick() {
	if (busy) return;
	busy = true;
	try {
		for (;;) {
			let j;
			try {
				j = await claim();
			} catch (e) {
				if (e.code !== "ER_NO_SUCH_TABLE") logging.error(e);
				return;
			}
			if (!j) break;
			await process1(j);
		}
		await autoReverts();
	} finally {
		busy = false;
	}
}

/**
 * Автоматична відміна в заданий час (кінець акції): зміна, у якої настав revert_at, ставиться на відміну.
 * Час знімається атомарно до постановки — двічі (з двох процесів) не відміниться.
 * Якщо зміна ще виконується — чекаємо її завершення; нічого не змінила — відміняти нічого, час просто знімається.
 */
async function autoReverts() {
	const [rows] = await pool.query(
		`SELECT id, id_user, perms, locale, status, changed, batch, operations, id_reverted_by FROM ${T}
		  WHERE kind = 'edit' AND revert_at IS NOT NULL AND revert_at <= UTC_TIMESTAMP() AND status IN ('done', 'cancelled', 'failed')
		  ORDER BY revert_at LIMIT 20`
	);
	for (const j of rows) {
		const [u] = await pool.query(`UPDATE ${T} SET revert_at = NULL WHERE id = ? AND revert_at IS NOT NULL`, [j.id]);
		if (!u.affectedRows || j.id_reverted_by || !(j.batch || bulkStock.stockOp(parse(j.operations, []))) || !Number(j.changed)) continue;
		try {
			await revert(j.id, { idUser: Number(j.id_user), perms: parse(j.perms, {}), locale: j.locale });
		} catch (e) {
			logging.error(e);
		}
	}
}

/** Задати або прибрати час автоматичної відміни вже запущеної / завершеної зміни */
async function setRevertAt(id, iso) {
	const [r] = await pool.query(`UPDATE ${T} SET revert_at = ? WHERE id = ? AND kind = 'edit' AND id_reverted_by IS NULL`, [utc(iso), id]);
	if (!r.affectedRows) throw httpErr(409, "catalog.bulk_job.e_cannot_revert");
	return { revert_at: iso || null };
}

/** Дані зміни для «Створити таку саму»: набір (фільтр або зафіксовані id) і дії */
async function source(id) {
	const [[j]] = await pool.query(`SELECT id, kind, title, selection, ids, operations FROM ${T} WHERE id = ?`, [id]);
	if (!j || j.kind !== "edit") throw httpErr(404, "catalog.bulk_job.e_not_found");
	const sel = parse(j.selection, {}) || {};
	return {
		title: j.title,
		operations: parse(j.operations, []),
		selection: sel.mode === "filter" ? { mode: "filter", filter: sel.filter || {} } : { mode: "list", list: parse(j.ids, []).join("\n") },
	};
}

/** Шаблони — для вибору в конструкторі (найновіші спершу) */
async function templates() {
	const [rows] = await pool.query(`SELECT id, title, operations FROM ${T} WHERE kind = 'edit' AND is_template = 1 ORDER BY id DESC LIMIT 200`);
	return rows.map((r) => ({ id: r.id, title: r.title || "", ops: parse(r.operations, []).length }));
}

/** Зберегти зміну як шаблон або прибрати з шаблонів */
async function setTemplate(id, on) {
	const [r] = await pool.query(`UPDATE ${T} SET is_template = ? WHERE id = ? AND kind = 'edit'`, [on ? 1 : 0, id]);
	if (!r.affectedRows) throw httpErr(404, "catalog.bulk_job.e_not_found");
	return { is_template: on };
}

function kick() {
	setImmediate(() => tick().catch((e) => logging.error(e)));
}

/** Старт: опитування раз на 15 с (зміни з іншого процесу, зупинені обробники) */
function start() {
	if (timer) return;
	timer = setInterval(kick, 15000);
	timer.unref();
	kick();
}

module.exports = { templates, setTemplate, stockMovements: bulkStock.movements, names: productNames, refs, attrValues, resolve, preview, create, list, get, cancel, resume, revert, setRevertAt, source, start, kick, ROOM, PREVIEW };