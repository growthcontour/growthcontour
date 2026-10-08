"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("./settings");
const descriptions = require("./descriptions");
const stock = require("./stock");
const sku = require("./sku");
const ean = require("./ean");
const editLock = require("./edit-lock");
const history = require("./history");
const audit = require("../../common/audit");
const { hasPermission } = require("../../authorization/authorization");
const logging = require("../../../logging/logging");
const { COLUMNS, LANG_COLUMNS, COST_COLUMNS, normalizeRow, validateOptions, cellText } = require("../../../validator/catalog/products/import");

const P = config.get("configDatabase").prefix;
const MAX_ROWS = 10000;
const EXPORT_BATCH = 500;

/* ===================== ЕКСПОРТ ===================== */

async function exportColumns(req, langs) {
	const canCost = await hasPermission(req, "products.cost", "view");
	const base = Object.keys(COLUMNS).filter((c) => canCost || !COST_COLUMNS.includes(c));
	const lang = [];
	for (const l of langs) for (const f of LANG_COLUMNS) lang.push(`${f}_${l.iso}`);
	return [...base, ...lang];
}

/** CSV-екранування за RFC 4180 + захист від formula injection у Excel */
function csvCell(v) {
	if (v === null || v === undefined) return "";
	let s = String(v);
	if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
	return /[";\r\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function xlsxValue(v) {
	if (v === null || v === undefined) return null;
	if (typeof v === "string" && /^[=+\-@]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) return "'" + v;
	return v;
}

async function* productRows(filters, langs, idWarehouse) {
	let lastId = 0;
	for (;;) {
		const where = ["p.deleted_at IS NULL", "p.id > ?"];
		const params = [lastId];
		if (filters.status) {
			where.push("p.status = ?");
			params.push(filters.status);
		}
		if (filters.id_category) {
			where.push(`EXISTS (SELECT 1 FROM ${P}products_to_categories pc JOIN ${P}products_categories_path cp ON cp.id_category = pc.id_category
			            WHERE pc.id_product = p.id AND cp.id_path = ?)`);
			params.push(filters.id_category);
		}
		const [rows] = await pool.query(
			`SELECT p.*, b.code AS brand_code,
			        (SELECT GROUP_CONCAT(pc.id_category ORDER BY pc.id_category = p.id_category_main DESC, pc.id_category SEPARATOR ',')
			           FROM ${P}products_to_categories pc WHERE pc.id_product = p.id) AS category_ids,
			        (SELECT s.on_hand FROM ${P}products_stock s WHERE s.id_product = p.id AND s.id_variant = 0 AND s.id_warehouse = ?) AS qty
			   FROM ${P}products p
			   LEFT JOIN ${P}products_brands b ON b.id = p.id_brand
			  WHERE ${where.join(" AND ")}
			  ORDER BY p.id LIMIT ${EXPORT_BATCH}`,
			[idWarehouse, ...params]
		);
		if (!rows.length) return;
		const ids = rows.map((r) => r.id);
		const [descRows] = await pool.query(`SELECT id_product, id_lang, ${LANG_COLUMNS.join(", ")} FROM ${P}products_description WHERE id_product IN (?) AND id_lang IN (?)`, [ids, langs.map((l) => l.id)]);
		const byProduct = new Map();
		for (const d of descRows) {
			if (!byProduct.has(d.id_product)) byProduct.set(d.id_product, {});
			byProduct.get(d.id_product)[d.id_lang] = d;
		}
		for (const r of rows) {
			const out = { ...r, qty: r.qty === null ? 0 : r.qty };
			const desc = byProduct.get(r.id) || {};
			for (const l of langs) for (const f of LANG_COLUMNS) out[`${f}_${l.iso}`] = desc[l.id] ? desc[l.id][f] : null;
			yield out;
		}
		lastId = rows[rows.length - 1].id;
	}
}

async function exportFile(req, res) {
	const format = req.query.format === "csv" ? "csv" : "xlsx";
	const filters = {
		status: ["draft", "active", "archived"].includes(req.query.status) ? req.query.status : null,
		id_category: /^\d+$/.test(String(req.query.id_category || "")) ? Number(req.query.id_category) : null,
	};
	const langs = await descriptions.contentLanguages();
	const columns = await exportColumns(req, langs);
	const { id_default_warehouse: idWarehouse } = await settings.get("stock");
	const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
	const filename = `products_${stamp}.${format}`;

	res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
	res.setHeader("Cache-Control", "no-store");
	let count = 0;

	if (format === "csv") {
		res.setHeader("Content-Type", "text/csv; charset=utf-8");
		res.write("\uFEFF" + columns.join(";") + "\r\n");
		for await (const row of productRows(filters, langs, idWarehouse)) {
			const line = columns.map((c) => csvCell(row[c])).join(";") + "\r\n";
			if (!res.write(line)) await new Promise((r) => res.once("drain", r));
			count++;
		}
		res.end();
	} else {
		res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
		const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true, useSharedStrings: false });
		const ws = wb.addWorksheet("products", { views: [{ state: "frozen", ySplit: 1 }] });
		ws.columns = columns.map((c) => ({ header: c, key: c, width: c.startsWith("description") ? 60 : Math.max(12, c.length + 2) }));
		ws.getRow(1).font = { bold: true };
		ws.getRow(1).commit();
		for await (const row of productRows(filters, langs, idWarehouse)) {
			const values = {};
			for (const c of columns) values[c] = xlsxValue(row[c]);
			ws.addRow(values).commit();
			count++;
		}
		ws.commit();
		await wb.commit();
	}

	audit.log(req, { action: "export", module: "products", entity: "product", count, details: { format, ...filters } });
}

/** Порожній шаблон з заголовками (той самий набір колонок) */
async function template(req, res) {
	const langs = await descriptions.contentLanguages();
	const columns = await exportColumns(req, langs);
	const wb = new ExcelJS.Workbook();
	const ws = wb.addWorksheet("products", { views: [{ state: "frozen", ySplit: 1 }] });
	ws.columns = columns.map((c) => ({ header: c, key: c, width: Math.max(12, c.length + 2) }));
	ws.getRow(1).font = { bold: true };
	res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
	res.setHeader("Content-Disposition", 'attachment; filename="products_template.xlsx"');
	await wb.xlsx.write(res);
	res.end();
}

/* ===================== ЧИТАННЯ ФАЙЛУ ===================== */

/** Розділювач CSV визначаємо за першим рядком */
function detectDelimiter(firstLine) {
	const counts = { ";": 0, ",": 0, "\t": 0 };
	let quoted = false;
	for (const ch of firstLine) {
		if (ch === '"') quoted = !quoted;
		else if (!quoted && ch in counts) counts[ch]++;
	}
	return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/** Потоковий парсер CSV (RFC 4180: лапки, "" всередині, переноси рядків у полях) */
async function* readCsv(file) {
	const stream = fs.createReadStream(file, { encoding: "utf8" });
	let delimiter = null;
	let field = "";
	let row = [];
	let quoted = false;
	let pendingQuote = false;
	let first = true;

	for await (let chunk of stream) {
		if (first) {
			chunk = chunk.replace(/^\uFEFF/, "");
			delimiter = detectDelimiter(chunk.split(/\r?\n/)[0]);
			first = false;
		}
		for (let i = 0; i < chunk.length; i++) {
			const ch = chunk[i];
			if (pendingQuote) {
				pendingQuote = false;
				if (ch === '"') {
					field += '"';
					continue;
				}
				quoted = false;
			}
			if (quoted) {
				if (ch === '"') pendingQuote = true;
				else field += ch;
				continue;
			}
			if (ch === '"' && field === "") quoted = true;
			else if (ch === delimiter) {
				row.push(field);
				field = "";
			} else if (ch === "\n") {
				row.push(field.replace(/\r$/, ""));
				yield row;
				row = [];
				field = "";
			} else field += ch;
		}
	}
	if (field !== "" || row.length) {
		row.push(field.replace(/\r$/, ""));
		yield row;
	}
}

async function* readXlsx(file) {
	const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, { sharedStrings: "cache", hyperlinks: "ignore", styles: "ignore", worksheets: "emit" });
	for await (const ws of reader) {
		for await (const r of ws) {
			const values = r.values.slice(1).map((v) => (v === undefined ? "" : v));
			yield values;
		}
		return; // лише перший аркуш
	}
}

/** Читає файл → { header, rows: [{ line, raw }] } з лімітом рядків */
async function readFile(file, originalName) {
	const ext = path.extname(originalName || "").toLowerCase();
	const iter = ext === ".csv" || ext === ".txt" ? readCsv(file) : readXlsx(file);
	let header = null;
	const rows = [];
	let line = 0;
	for await (const values of iter) {
		line++;
		if (!header) {
			header = values.map((h) => cellText(h).toLowerCase());
			continue;
		}
		if (values.every((v) => cellText(v) === "")) continue;
		if (rows.length >= MAX_ROWS) throw Object.assign(new Error(`Too many rows (max ${MAX_ROWS})`), { status: 413 });
		const raw = {};
		header.forEach((h, i) => {
			if (h) raw[h] = values[i] === undefined ? "" : values[i];
		});
		rows.push({ line, raw });
	}
	if (!header) throw Object.assign(new Error("Empty file"), { status: 400 });
	return { header, rows };
}

/* ===================== ІМПОРТ ===================== */

const PRODUCT_FIELDS = Object.keys(COLUMNS).filter((c) => !["id", "uuid", "brand_code", "category_ids", "qty"].includes(c));

async function resolveBrand(conn, code, cache) {
	if (cache.has(code)) return cache.get(code);
	const [[b]] = await conn.query(`SELECT id FROM ${P}products_brands WHERE code = ? AND deleted_at IS NULL`, [code]);
	const id = b ? b.id : null;
	cache.set(code, id);
	return id;
}

async function findExisting(conn, data, matchBy) {
	if (matchBy === "id") {
		if (!data.id) return null;
		const [[r]] = await conn.query(`SELECT id, sku, type FROM ${P}products WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [data.id]);
		return r || null;
	}
	if (!data.sku) return null;
	const [[r]] = await conn.query(`SELECT id, sku, type FROM ${P}products WHERE sku = ? AND deleted_at IS NULL FOR UPDATE`, [data.sku]);
	return r || null;
}

async function importRow(req, ctx, item) {
	const { data, errors } = normalizeRow(item.raw, ctx.langs, ctx.opts.empty_clears);
	if (errors.length) return { status: "error", errors };

	if (!ctx.canCost) for (const c of COST_COLUMNS) delete data[c];
	if (data.ean && !ean.isValid(data.ean)) return { status: "error", errors: [{ field: "ean", message: "invalid check digit" }] };

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const existing = await findExisting(conn, data, ctx.opts.match_by);
		const [[beforeRow]] = existing ? await conn.query(`SELECT * FROM ${P}products WHERE id = ?`, [existing.id]) : [[null]];
		const beforeDesc = existing ? await descriptions.load("products", existing.id, conn) : {};
		const [beforeCatRows] = existing ? await conn.query(`SELECT id_category FROM ${P}products_to_categories WHERE id_product = ?`, [existing.id]) : [[]];

		if (existing && ctx.opts.mode === "create") throw rowErr("exists", "product already exists");
		if (!existing && ctx.opts.mode === "update") throw rowErr(ctx.opts.match_by, "product not found");
		if (existing && !ctx.canEdit) throw rowErr("row", "no permission to edit");
		if (!existing && !ctx.canAdd) throw rowErr("row", "no permission to add");

		if (existing) {
			const lock = await editLock.holder(existing.id, conn);
			if (lock) throw rowErr("lock", `locked: ${lock.user_name || "#" + lock.id_user}`, "skipped");
		}

		const values = {};
		for (const f of PRODUCT_FIELDS) if (f in data) values[f] = data[f];

		if ("brand_code" in data) {
			const idBrand = await resolveBrand(conn, data.brand_code, ctx.brandCache);
			if (!idBrand) throw rowErr("brand_code", "brand not found");
			values.id_brand = idBrand;
		}
		if (data.category_ids) {
			const [cats] = await conn.query(`SELECT id FROM ${P}products_categories WHERE id IN (?)`, [data.category_ids]);
			const found = new Set(cats.map((c) => c.id));
			const missing = data.category_ids.filter((id) => !found.has(id));
			if (missing.length) throw rowErr("category_ids", "categories not found: " + missing.join(","));
			values.id_category_main = data.category_ids[0];
		}
		if (values.type && existing && existing.type === "variable") throw rowErr("type", "variable product type cannot be changed by import");
		if (values.sku && !(await sku.isFree(values.sku, { excludeProductId: existing ? existing.id : undefined }, conn))) throw rowErr("sku", "sku already in use");

		let id;
		if (existing) {
			id = existing.id;
			const keys = Object.keys(values);
			await conn.query(`UPDATE ${P}products SET ${keys.map((k) => `\`${k}\` = ?`).join(", ")}${keys.length ? ", " : ""}version = version + 1, id_user_edit = ? WHERE id = ?`, [...keys.map((k) => values[k]), req.user.userId, id]);
		} else {
			const primary = ctx.langs[0];
			if (!data.descriptions || !data.descriptions[primary.id] || !data.descriptions[primary.id].name) throw rowErr(`name_${primary.iso}`, "required for new product");
			if (!values.type) values.type = "simple";
			if (!values.id_attribute_set && ctx.defaultAttributeSet) values.id_attribute_set = ctx.defaultAttributeSet;
			const keys = Object.keys(values);
			const [ins] = await conn.query(
				`INSERT INTO ${P}products (uuid, ${keys.map((k) => `\`${k}\``).join(", ")}${keys.length ? ", " : ""}id_user_add, id_user_edit)
				 VALUES (?, ${keys.map(() => "?").join(", ")}${keys.length ? ", " : ""}?, ?)`,
				[data.uuid || crypto.randomUUID(), ...keys.map((k) => values[k]), req.user.userId, req.user.userId]
			);
			id = ins.insertId;
			if (!values.sku) {
				const generated = await sku.generateForProduct({ id, categoryId: values.id_category_main }, conn);
				await conn.query(`UPDATE ${P}products SET sku = ? WHERE id = ?`, [generated, id]);
			}
		}

		if (data.category_ids) {
			await conn.query(`DELETE FROM ${P}products_to_categories WHERE id_product = ? AND id_category NOT IN (?)`, [id, data.category_ids]);
			await conn.query(`INSERT IGNORE INTO ${P}products_to_categories (id_product, id_category) VALUES ?`, [data.category_ids.map((c) => [id, c])]);
		}

		if (data.descriptions) {
			const current = existing ? await descriptions.load("products", id, conn) : {};
			const merged = {};
			for (const [idLang, d] of Object.entries(data.descriptions)) {
				const base = current[idLang] || {};
				const row = { ...base, ...d };
				if (!row.name) throw rowErr(`name_${ctx.langs.find((l) => l.id === Number(idLang)).iso}`, "required");
				if (d.slug === undefined && !current[idLang]) row.slug = null;
				for (const f of ctx.descFields) if (row[f] === undefined) row[f] = null;
				merged[idLang] = row;
			}
			const [[flag]] = await conn.query(`SELECT slug_shared FROM ${P}products WHERE id = ?`, [id]);
			await descriptions.save(conn, "products", id, merged, { sharedSlug: Number(flag.slug_shared) === 1, primaryLang: ctx.langs[0].id });
		}

		if (data.qty !== undefined) {
			const [[p]] = await conn.query(`SELECT type, track_inventory FROM ${P}products WHERE id = ?`, [id]);
			if (p.type === "variable") throw rowErr("qty", "set stock per variant");
			if (p.track_inventory) {
				await stock.setQty(conn, {
					idProduct: id,
					idWarehouse: ctx.idWarehouse,
					qty: data.qty,
					type: "inventory",
					refType: "import",
					refId: ctx.importRef,
					idUser: req.user.userId,
					comment: `import line ${item.line}`,
				});
			}
		}

		let changes = [];
		if (!ctx.opts.dry_run && existing) {
			const [[afterRow]] = await conn.query(`SELECT * FROM ${P}products WHERE id = ?`, [id]);
			const afterDesc = data.descriptions ? await descriptions.load("products", id, conn) : beforeDesc;
			changes = [...history.rowChanges(beforeRow, afterRow), ...history.descChanges(beforeDesc, afterDesc)];
			if (data.category_ids) changes.push(...history.listChange("categories", beforeCatRows.map((r) => r.id_category), data.category_ids));
		}
		if (ctx.opts.dry_run) await conn.rollback();
		else await conn.commit();
		if (!ctx.opts.dry_run) {
			await history.record("products", id, { user: req.user.userId, source: "import", action: existing ? "update" : "create", changes, meta: { line: item.line } });
		}
		return { status: existing ? "updated" : "created", id };
	} catch (err) {
		await conn.rollback().catch(() => {});
		if (err.rowError) return { status: err.rowStatus, errors: [{ field: err.field, message: err.message }] };
		if (err.code === "ER_DUP_ENTRY") return { status: "error", errors: [{ field: "row", message: "duplicate value (sku / slug / uuid)" }] };
		if (err.status && err.status < 500) return { status: "error", errors: Array.isArray(err.errors) ? err.errors : [{ field: "row", message: err.message }] };
		logging.error(err);
		return { status: "error", errors: [{ field: "row", message: "server error" }] };
	} finally {
		conn.release();
	}
}

function rowErr(field, message, status = "error") {
	return Object.assign(new Error(message), { rowError: true, field, rowStatus: status });
}

async function importFile(req, res) {
	const file = req.file;
	if (!file) return res.status(400).json({ ok: false, error: req.__("catalog.import.file_required") });

	try {
		const { value: opts, error } = validateOptions(req.body);
		if (error) return res.status(400).json({ ok: false, error: req.__("catalog.common.validation_error"), errors: error });

		const { header, rows } = await readFile(file.path, file.originalname);
		const langs = await descriptions.contentLanguages();
		const known = new Set([...Object.keys(COLUMNS), ...langs.flatMap((l) => LANG_COLUMNS.map((f) => `${f}_${l.iso}`))]);
		const unknown = header.filter((h) => h && !known.has(h));
		if (!header.includes(opts.match_by)) return res.status(400).json({ ok: false, error: req.__("catalog.import.column_required").replace("%s", opts.match_by) });

		const { DESCRIPTION_FIELDS } = require("../../../validator/catalog/products/catalog");
		const ctx = {
			opts,
			langs,
			canAdd: await hasPermission(req, "products.import", "add"),
			canEdit: await hasPermission(req, "products.import", "edit"),
			canCost: await hasPermission(req, "products.cost", "edit"),
			idWarehouse: (await settings.get("stock")).id_default_warehouse,
			defaultAttributeSet: (await settings.get("card")).id_default_attribute_set || null,
			descFields: Object.keys(DESCRIPTION_FIELDS.products),
			brandCache: new Map(),
			importRef: null,
		};

		const summary = { total: rows.length, created: 0, updated: 0, skipped: 0, error: 0 };
		const report = [];
		const seen = new Set();
		for (const item of rows) {
			const key = cellText(item.raw[opts.match_by]);
			if (key && seen.has(key)) {
				summary.error++;
				report.push({ line: item.line, key, status: "error", errors: [{ field: opts.match_by, message: "duplicate in file" }] });
				continue;
			}
			if (key) seen.add(key);
			const r = await importRow(req, ctx, item);
			summary[r.status]++;
			if (r.status === "error" || r.status === "skipped") report.push({ line: item.line, key, ...r });
		}

		if (!opts.dry_run) {
			audit.log(req, { action: "import", module: "products", entity: "product", count: summary.created + summary.updated, details: { ...summary, file: file.originalname, mode: opts.mode } });
		}
		res.json({ ok: true, dry_run: opts.dry_run, summary, unknown_columns: unknown, report: report.slice(0, 1000) });
	} finally {
		fs.promises.unlink(file.path).catch(() => {});
	}
}

module.exports = { exportFile, template, importFile, MAX_ROWS };
