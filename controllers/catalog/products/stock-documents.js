"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("./settings");
const descriptions = require("./descriptions");
const stock = require("./stock");
const { nextSequence } = require("./sku");
const { validateDocument } = require("../../../validator/catalog/products/stock-documents");

const P = config.get("configDatabase").prefix;
const PREFIX = { receipt: "RCV", transfer: "TRF", writeoff: "WOF", inventory: "INV", return: "RET", adjustment: "ADJ" };
const REF = "stock_document";

function httpErr(status, message, errors, extra) {
	return Object.assign(new Error(message), { status, errors }, extra || {});
}

async function tx(fn) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const r = await fn(conn);
		await conn.commit();
		return r;
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

const likeOf = (s) => "%" + String(s).replace(/[\\%_]/g, "\\$&") + "%";

// ═══ СПИСОК ════════════════════════════════════════════
async function list(q) {
	const size = Math.min(Math.max(parseInt(q.size, 10) || 50, 1), 200);
	const page = Math.max(parseInt(q.page, 10) || 1, 1);
	const where = ["1 = 1"];
	const params = [];
	if (PREFIX[q.type]) {
		where.push("d.type = ?");
		params.push(q.type);
	}
	if (["draft", "posted", "cancelled"].includes(q.status)) {
		where.push("d.status = ?");
		params.push(q.status);
	}
	if (parseInt(q.id_warehouse, 10) > 0) {
		where.push("(d.id_warehouse = ? OR d.id_warehouse_to = ?)");
		params.push(parseInt(q.id_warehouse, 10), parseInt(q.id_warehouse, 10));
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(q.date_from || "")) {
		where.push("d.date_document >= ?");
		params.push(q.date_from);
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(q.date_to || "")) {
		where.push("d.date_document <= ?");
		params.push(q.date_to);
	}
	if (String(q.search || "").trim()) {
		where.push("(d.number LIKE ? OR d.external_number LIKE ? OR d.comment LIKE ?)");
		const like = likeOf(String(q.search).trim());
		params.push(like, like, like);
	}
	const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${P}products_stock_documents d WHERE ${where.join(" AND ")}`, params);
	const [rows] = await pool.query(
		`SELECT d.id, d.number, d.type, d.status, d.date_document, d.date_posted, d.external_number,
		        w.code AS warehouse, wt.code AS warehouse_to, s.name AS supplier,
		        (SELECT COUNT(*) FROM ${P}products_stock_documents_items i WHERE i.id_document = d.id) AS lines_count,
		        (SELECT COALESCE(SUM(ABS(i.qty)), 0) FROM ${P}products_stock_documents_items i WHERE i.id_document = d.id) AS qty_total,
		        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS author
		   FROM ${P}products_stock_documents d
		   JOIN ${P}products_warehouses w ON w.id = d.id_warehouse
		   LEFT JOIN ${P}products_warehouses wt ON wt.id = d.id_warehouse_to
		   LEFT JOIN ${P}products_suppliers s ON s.id = d.id_supplier
		   LEFT JOIN ${P}users u ON u.id = d.id_user_add
		  WHERE ${where.join(" AND ")}
		  ORDER BY d.date_document DESC, d.id DESC
		  LIMIT ? OFFSET ?`,
		[...params, size, (page - 1) * size]
	);
	return { last_page: Math.max(Math.ceil(total / size), 1), last_row: total, data: rows };
}

// ═══ ЧИТАННЯ ═══════════════════════════════════════════
async function get(id, idLang, perms) {
	const [[doc]] = await pool.query(
		`SELECT d.*, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS author,
		        NULLIF(TRIM(CONCAT_WS(' ', up.first_name, up.last_name)), '') AS posted_by
		   FROM ${P}products_stock_documents d
		   LEFT JOIN ${P}users u ON u.id = d.id_user_add
		   LEFT JOIN ${P}users up ON up.id = d.id_user_posted
		  WHERE d.id = ?`,
		[id]
	);
	if (!doc) throw httpErr(404, "Not found");
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const [items] = await pool.query(
		`SELECT i.id_product, i.id_variant, i.id_location, i.batch_no, i.expiry_date, i.qty, i.qty_expected, ${perms.cost ? "i.cost_price," : ""} i.serials,
		        p.sku, p.type AS product_type, v.sku AS variant_sku,
		        COALESCE(NULLIF(pd.name, ''), pdp.name, CONCAT('#', p.id)) AS name,
		        (SELECT GROUP_CONCAT(COALESCE(NULLIF(vd.name, ''), vdp.name, av.code) ORDER BY ax.sort_order SEPARATOR ' / ')
		           FROM ${P}products_variant_values vv
		           JOIN ${P}products_attribute_values av ON av.id = vv.id_attribute_value
		           LEFT JOIN ${P}products_variant_axes ax ON ax.id_product = v.id_product AND ax.id_attribute = vv.id_attribute
		           LEFT JOIN ${P}products_attribute_values_description vd  ON vd.id_attribute_value = vv.id_attribute_value AND vd.id_lang = ?
		           LEFT JOIN ${P}products_attribute_values_description vdp ON vdp.id_attribute_value = vv.id_attribute_value AND vdp.id_lang = ?
		          WHERE vv.id_variant = v.id) AS variant_label,
		        (SELECT s.on_hand FROM ${P}products_stock s WHERE s.id_product = i.id_product AND s.id_variant = i.id_variant AND s.id_warehouse = ?) AS current_on_hand
		   FROM ${P}products_stock_documents_items i
		   JOIN ${P}products p ON p.id = i.id_product
		   LEFT JOIN ${P}products_variants v ON v.id = i.id_variant
		   LEFT JOIN ${P}products_description pd  ON pd.id_product = p.id AND pd.id_lang = ?
		   LEFT JOIN ${P}products_description pdp ON pdp.id_product = p.id AND pdp.id_lang = ?
		  WHERE i.id_document = ?
		  ORDER BY i.id`,
		[idLang, primary, doc.id_warehouse, idLang, primary, id]
	);
	return {
		...doc,
		items: items.map((it) => ({ ...it, serials: typeof it.serials === "string" ? JSON.parse(it.serials) : it.serials || [] })),
	};
}

// ═══ ЧЕРНЕТКА ══════════════════════════════════════════
async function assertRefs(conn, h, list) {
	const [whs] = await conn.query(`SELECT id, status FROM ${P}products_warehouses WHERE id IN (?) AND deleted_at IS NULL`, [[h.id_warehouse, h.id_warehouse_to].filter(Boolean)]);
	const active = new Set(whs.filter((w) => Number(w.status) === 1).map((w) => w.id));
	if (!active.has(h.id_warehouse)) throw httpErr(400, "Validation failed", [{ field: "header.id_warehouse", message: "warehouse not found or inactive" }]);
	if (h.id_warehouse_to && !active.has(h.id_warehouse_to)) throw httpErr(400, "Validation failed", [{ field: "header.id_warehouse_to", message: "warehouse not found or inactive" }]);
	if (h.id_supplier) {
		const [[s]] = await conn.query(`SELECT id FROM ${P}products_suppliers WHERE id = ? AND deleted_at IS NULL`, [h.id_supplier]);
		if (!s) throw httpErr(400, "Validation failed", [{ field: "header.id_supplier", message: "supplier not found" }]);
	}
	if (!list.length) return;

	const ids = [...new Set(list.map((i) => i.id_product))];
	const [products] = await conn.query(`SELECT id, type, track_inventory, deleted_at FROM ${P}products WHERE id IN (?)`, [ids]);
	const byId = new Map(products.map((p) => [p.id, p]));
	const variantIds = [...new Set(list.map((i) => i.id_variant).filter(Boolean))];
	const variantOwner = new Map();
	if (variantIds.length) {
		const [vs] = await conn.query(`SELECT id, id_product FROM ${P}products_variants WHERE id IN (?)`, [variantIds]);
		vs.forEach((v) => variantOwner.set(v.id, v.id_product));
	}
	const targetWh = h.id_warehouse_to || h.id_warehouse;
	const locIds = [...new Set(list.map((i) => i.id_location).filter(Boolean))];
	const validLocs = new Set();
	if (locIds.length) {
		const [ls] = await conn.query(`SELECT id FROM ${P}products_warehouse_locations WHERE id IN (?) AND id_warehouse = ?`, [locIds, targetWh]);
		ls.forEach((l) => validLocs.add(l.id));
	}

	list.forEach((it, i) => {
		const f = `items.${i}`;
		const p = byId.get(it.id_product);
		if (!p || p.deleted_at) throw httpErr(400, "Validation failed", [{ field: f, message: "product not found" }]);
		if (!Number(p.track_inventory)) throw httpErr(400, "Validation failed", [{ field: f, message: "product does not track inventory" }]);
		if (["service", "digital", "gift_card"].includes(p.type)) throw httpErr(400, "Validation failed", [{ field: f, message: "product has no physical stock" }]);
		if (p.type === "variable" && !it.id_variant) throw httpErr(400, "Validation failed", [{ field: f, message: "select a variant" }]);
		if (it.id_variant && variantOwner.get(it.id_variant) !== it.id_product) throw httpErr(400, "Validation failed", [{ field: f, message: "variant does not belong to product" }]);
		if (it.id_location && !validLocs.has(it.id_location)) throw httpErr(400, "Validation failed", [{ field: `${f}.id_location`, message: "location does not belong to warehouse" }]);
	});
}

async function saveDraft(id, body, ctx) {
	const v = validateDocument(body);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);
	const h = v.header;

	return tx(async (conn) => {
		await assertRefs(conn, h, v.items);
		let oldCost = new Map();

		if (id) {
			const [[cur]] = await conn.query(`SELECT * FROM ${P}products_stock_documents WHERE id = ? FOR UPDATE`, [id]);
			if (!cur) throw httpErr(404, "Not found");
			if (cur.status !== "draft") throw httpErr(409, "Only draft documents can be edited");
			if (Number(body.version) !== Number(cur.version)) throw httpErr(409, "Document was changed by someone else", null, { code: "version_conflict", version: cur.version });
			if (cur.type !== h.type) throw httpErr(400, "Validation failed", [{ field: "header.type", message: "type cannot be changed" }]);
			if (!ctx.perms.cost) {
				const [old] = await conn.query(`SELECT id_product, id_variant, batch_no, cost_price FROM ${P}products_stock_documents_items WHERE id_document = ?`, [id]);
				oldCost = new Map(old.map((o) => [`${o.id_product}:${o.id_variant}:${o.batch_no || ""}`, o.cost_price]));
			}
			await conn.query(
				`UPDATE ${P}products_stock_documents
				    SET id_warehouse = ?, id_warehouse_to = ?, id_supplier = ?, external_number = ?, currency = ?, comment = ?, date_document = ?, version = version + 1
				  WHERE id = ?`,
				[h.id_warehouse, h.id_warehouse_to, h.id_supplier, h.external_number, h.currency, h.comment, h.date_document, id]
			);
			await conn.query(`DELETE FROM ${P}products_stock_documents_items WHERE id_document = ?`, [id]);
		} else {
			const seq = await nextSequence("stock_" + h.type, conn);
			const number = `${PREFIX[h.type]}-${h.date_document.slice(0, 4)}-${String(seq).padStart(6, "0")}`;
			const [r] = await conn.query(
				`INSERT INTO ${P}products_stock_documents (number, type, status, id_warehouse, id_warehouse_to, id_supplier, external_number, currency, comment, id_user_add, date_document)
				 VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
				[number, h.type, h.id_warehouse, h.id_warehouse_to, h.id_supplier, h.external_number, h.currency, h.comment, ctx.idUser, h.date_document]
			);
			id = r.insertId;
		}

		if (v.items.length) {
			await conn.query(
				`INSERT INTO ${P}products_stock_documents_items (id_document, id_product, id_variant, id_location, batch_no, expiry_date, qty, cost_price, serials) VALUES ?`,
				[
					v.items.map((it) => {
						const cost = ctx.perms.cost ? it.cost_price : oldCost.get(`${it.id_product}:${it.id_variant}:${it.batch_no || ""}`) ?? null;
						return [id, it.id_product, it.id_variant, it.id_location, it.batch_no, it.expiry_date, it.qty, cost, it.serials.length ? JSON.stringify(it.serials) : null];
					}),
				]
			);
		}
		const [[{ version }]] = await conn.query(`SELECT version FROM ${P}products_stock_documents WHERE id = ?`, [id]);
		return { id, version };
	});
}

async function removeDraft(id) {
	return tx(async (conn) => {
		const [[cur]] = await conn.query(`SELECT status FROM ${P}products_stock_documents WHERE id = ? FOR UPDATE`, [id]);
		if (!cur) throw httpErr(404, "Not found");
		if (cur.status !== "draft") throw httpErr(409, "Only draft documents can be deleted — cancel posted documents instead");
		await conn.query(`DELETE FROM ${P}products_stock_documents WHERE id = ?`, [id]);
		return { ok: true };
	});
}

// ═══ ПАРТІЇ ТА СЕРІЙНИКИ ═══════════════════════════════
async function batchIn(conn, it, idWarehouse, qty) {
	await conn.query(
		`INSERT INTO ${P}products_stock_batches (id_product, id_variant, id_warehouse, batch_no, expiry_date, qty, cost_price)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty), expiry_date = COALESCE(VALUES(expiry_date), expiry_date), cost_price = COALESCE(VALUES(cost_price), cost_price)`,
		[it.id_product, it.id_variant, idWarehouse, it.batch_no, it.expiry_date, qty, it.cost_price]
	);
	const [[b]] = await conn.query(`SELECT id FROM ${P}products_stock_batches WHERE id_product = ? AND id_variant = ? AND id_warehouse = ? AND batch_no = ?`, [it.id_product, it.id_variant, idWarehouse, it.batch_no]);
	return b.id;
}

async function batchOut(conn, it, idWarehouse, qty, field) {
	const [[b]] = await conn.query(
		`SELECT id, qty FROM ${P}products_stock_batches WHERE id_product = ? AND id_variant = ? AND id_warehouse = ? AND batch_no = ? FOR UPDATE`,
		[it.id_product, it.id_variant, idWarehouse, it.batch_no]
	);
	if (!b || Number(b.qty) + 1e-9 < qty) throw httpErr(409, "Insufficient batch quantity", [{ field, message: `batch ${it.batch_no}: not enough quantity` }]);
	await conn.query(`UPDATE ${P}products_stock_batches SET qty = qty - ? WHERE id = ?`, [qty, b.id]);
	return b.id;
}

async function serialsIn(conn, it, idWarehouse, idBatch, field) {
	for (const s of it.serials) {
		try {
			await conn.query(
				`INSERT INTO ${P}products_stock_serials (id_product, id_variant, id_warehouse, id_batch, serial, status) VALUES (?, ?, ?, ?, ?, 'in_stock')`,
				[it.id_product, it.id_variant, idWarehouse, idBatch, s]
			);
		} catch (e) {
			if (e.code === "ER_DUP_ENTRY") throw httpErr(409, "Serial number already exists", [{ field, message: `serial ${s} already registered` }]);
			throw e;
		}
	}
}

async function serialsMove(conn, it, fromWh, toWh, newStatus, field) {
	const [rows] = await conn.query(
		`SELECT id, serial FROM ${P}products_stock_serials WHERE id_product = ? AND serial IN (?) AND id_warehouse = ? AND status = 'in_stock' FOR UPDATE`,
		[it.id_product, it.serials, fromWh]
	);
	if (rows.length !== it.serials.length) {
		const ok = new Set(rows.map((r) => r.serial));
		throw httpErr(409, "Serial numbers not available", [{ field, message: `not in stock: ${it.serials.filter((s) => !ok.has(s)).join(", ")}` }]);
	}
	await conn.query(`UPDATE ${P}products_stock_serials SET id_warehouse = ?, status = ? WHERE id IN (?)`, [toWh, newStatus, rows.map((r) => r.id)]);
}

// ═══ ПРОВЕДЕННЯ ════════════════════════════════════════
async function post(id, body, ctx) {
	const cfg = await settings.get("stock");
	return tx(async (conn) => {
		const [[doc]] = await conn.query(`SELECT * FROM ${P}products_stock_documents WHERE id = ? FOR UPDATE`, [id]);
		if (!doc) throw httpErr(404, "Not found");
		if (doc.status !== "draft") throw httpErr(409, "Document is already posted or cancelled");
		if (Number(body.version) !== Number(doc.version)) throw httpErr(409, "Document was changed by someone else", null, { code: "version_conflict", version: doc.version });

		const [rawItems] = await conn.query(`SELECT * FROM ${P}products_stock_documents_items WHERE id_document = ?`, [id]);
		if (!rawItems.length) throw httpErr(400, "Document has no lines");
		const items = rawItems
			.map((it) => ({ ...it, qty: Number(it.qty), serials: typeof it.serials === "string" ? JSON.parse(it.serials) : it.serials || [] }))
			// Стабільний порядок блокування рядків залишку — захист від deadlock між паралельними проведеннями
			.sort((a, b) => a.id_product - b.id_product || a.id_variant - b.id_variant || a.id - b.id);

		await assertRefs(conn, { id_warehouse: doc.id_warehouse, id_warehouse_to: doc.id_warehouse_to, id_supplier: doc.id_supplier }, items);

		const base = { refType: REF, refId: id, idUser: ctx.idUser, comment: doc.number };
		for (const [i, it] of items.entries()) {
			const f = `items.${i}`;
			const useBatch = cfg.track_batches && it.batch_no;
			const useSerials = cfg.track_serials && it.serials.length;
			const common = { ...base, idProduct: it.id_product, idVariant: it.id_variant };

			if (doc.type === "receipt" || doc.type === "return") {
				const idBatch = useBatch ? await batchIn(conn, it, doc.id_warehouse, it.qty) : null;
				if (useSerials) await serialsIn(conn, it, doc.id_warehouse, idBatch, f);
				await stock.adjust(conn, { ...common, idWarehouse: doc.id_warehouse, delta: it.qty, type: doc.type, costPrice: it.cost_price, idBatch });
			} else if (doc.type === "writeoff") {
				const idBatch = useBatch ? await batchOut(conn, it, doc.id_warehouse, it.qty, f) : null;
				if (useSerials) await serialsMove(conn, it, doc.id_warehouse, doc.id_warehouse, "written_off", f);
				await stock.adjust(conn, { ...common, idWarehouse: doc.id_warehouse, delta: -it.qty, type: "writeoff", idBatch });
			} else if (doc.type === "transfer") {
				if (useBatch) {
					await batchOut(conn, it, doc.id_warehouse, it.qty, f);
					await batchIn(conn, it, doc.id_warehouse_to, it.qty);
				}
				if (useSerials) await serialsMove(conn, it, doc.id_warehouse, doc.id_warehouse_to, "in_stock", f);
				await stock.adjust(conn, { ...common, idWarehouse: doc.id_warehouse, delta: -it.qty, type: "transfer_out" });
				await stock.adjust(conn, { ...common, idWarehouse: doc.id_warehouse_to, delta: it.qty, type: "transfer_in" });
			} else if (doc.type === "adjustment") {
				await stock.adjust(conn, { ...common, idWarehouse: doc.id_warehouse, delta: it.qty, type: "adjustment" });
			} else if (doc.type === "inventory") {
				const [[cur]] = await conn.query(`SELECT on_hand FROM ${P}products_stock WHERE id_product = ? AND id_variant = ? AND id_warehouse = ?`, [it.id_product, it.id_variant, doc.id_warehouse]);
				await conn.query(`UPDATE ${P}products_stock_documents_items SET qty_expected = ? WHERE id = ?`, [cur ? cur.on_hand : 0, it.id]);
				await stock.setQty(conn, { ...common, idWarehouse: doc.id_warehouse, qty: it.qty, type: "inventory" });
			}

			// Комірка зберігається на рядку залишку складу-отримувача
			if (it.id_location) {
				await conn.query(
					`UPDATE ${P}products_stock SET id_location = ? WHERE id_product = ? AND id_variant = ? AND id_warehouse = ?`,
					[it.id_location, it.id_product, it.id_variant, doc.id_warehouse_to || doc.id_warehouse]
				);
			}
		}

		await conn.query(`UPDATE ${P}products_stock_documents SET status = 'posted', date_posted = NOW(), id_user_posted = ?, version = version + 1 WHERE id = ?`, [ctx.idUser, id]);
		return { ok: true };
	});
}

// ═══ СКАСУВАННЯ (СТОРНУВАННЯ) ══════════════════════════
async function cancel(id, body, ctx) {
	const cfg = await settings.get("stock");
	return tx(async (conn) => {
		const [[doc]] = await conn.query(`SELECT * FROM ${P}products_stock_documents WHERE id = ? FOR UPDATE`, [id]);
		if (!doc) throw httpErr(404, "Not found");
		if (doc.status !== "posted") throw httpErr(409, "Only posted documents can be cancelled");
		if (Number(body.version) !== Number(doc.version)) throw httpErr(409, "Document was changed by someone else", null, { code: "version_conflict", version: doc.version });

		// Сторнуємо саме ті рухи, що створило проведення (у зворотному порядку)
		const [moves] = await conn.query(
			`SELECT * FROM ${P}products_stock_movements WHERE ref_type = ? AND ref_id = ? AND qty_before IS NOT NULL ORDER BY id DESC`,
			[REF, id]
		);
		const original = moves.filter((m) => !String(m.comment || "").startsWith("REVERSAL"));
		for (const m of original.sort((a, b) => a.id_product - b.id_product || a.id_variant - b.id_variant || b.id - a.id)) {
			await stock.adjust(conn, {
				idProduct: m.id_product,
				idVariant: m.id_variant,
				idWarehouse: m.id_warehouse,
				field: m.field,
				delta: -Number(m.qty),
				type: m.type,
				idBatch: m.id_batch,
				refType: REF,
				refId: id,
				idUser: ctx.idUser,
				comment: "REVERSAL " + doc.number,
			});
		}

		// Партії та серійники — у вихідний стан
		const [rawItems] = await conn.query(`SELECT * FROM ${P}products_stock_documents_items WHERE id_document = ?`, [id]);
		for (const [i, raw] of rawItems.entries()) {
			const it = { ...raw, qty: Number(raw.qty), serials: typeof raw.serials === "string" ? JSON.parse(raw.serials) : raw.serials || [] };
			const f = `items.${i}`;
			if (cfg.track_batches && it.batch_no) {
				if (doc.type === "receipt" || doc.type === "return") await batchOut(conn, it, doc.id_warehouse, it.qty, f);
				if (doc.type === "writeoff") await batchIn(conn, it, doc.id_warehouse, it.qty);
				if (doc.type === "transfer") {
					await batchOut(conn, it, doc.id_warehouse_to, it.qty, f);
					await batchIn(conn, it, doc.id_warehouse, it.qty);
				}
			}
			if (cfg.track_serials && it.serials.length) {
				if (doc.type === "receipt" || doc.type === "return") {
					const [r] = await conn.query(
						`DELETE FROM ${P}products_stock_serials WHERE id_product = ? AND serial IN (?) AND id_warehouse = ? AND status = 'in_stock'`,
						[it.id_product, it.serials, doc.id_warehouse]
					);
					if (r.affectedRows !== it.serials.length) throw httpErr(409, "Some serial numbers were already sold or moved", [{ field: f, message: "serials are not in stock anymore" }]);
				}
				if (doc.type === "writeoff") {
					await conn.query(`UPDATE ${P}products_stock_serials SET status = 'in_stock' WHERE id_product = ? AND serial IN (?) AND status = 'written_off'`, [it.id_product, it.serials]);
				}
				if (doc.type === "transfer") await serialsMove(conn, it, doc.id_warehouse_to, doc.id_warehouse, "in_stock", f);
			}
		}

		await conn.query(`UPDATE ${P}products_stock_documents SET status = 'cancelled', version = version + 1 WHERE id = ?`, [id]);
		return { ok: true };
	});
}

// ═══ ЖУРНАЛ РУХУ ═══════════════════════════════════════
const MOVE_TYPES = ["receipt", "sale", "return", "transfer_in", "transfer_out", "adjustment", "writeoff", "inventory", "reserve", "unreserve", "bundle_assembly", "bundle_disassembly"];

async function movements(q, idLang, perms) {
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const size = Math.min(Math.max(parseInt(q.size, 10) || 100, 1), 500);
	const page = Math.max(parseInt(q.page, 10) || 1, 1);
	const where = ["1 = 1"];
	const params = [];
	if (parseInt(q.id_product, 10) > 0) {
		where.push("m.id_product = ?");
		params.push(parseInt(q.id_product, 10));
	}
	if (parseInt(q.id_warehouse, 10) > 0) {
		where.push("m.id_warehouse = ?");
		params.push(parseInt(q.id_warehouse, 10));
	}
	if (MOVE_TYPES.includes(q.type)) {
		where.push("m.type = ?");
		params.push(q.type);
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(q.date_from || "")) {
		where.push("m.date_add >= ?");
		params.push(q.date_from + " 00:00:00");
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(q.date_to || "")) {
		where.push("m.date_add <= ?");
		params.push(q.date_to + " 23:59:59.999");
	}
	if (String(q.search || "").trim()) {
		const like = likeOf(String(q.search).trim());
		where.push(`(p.sku LIKE ? OR EXISTS (SELECT 1 FROM ${P}products_description x WHERE x.id_product = m.id_product AND x.name LIKE ?))`);
		params.push(like, like);
	}

	const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${P}products_stock_movements m JOIN ${P}products p ON p.id = m.id_product WHERE ${where.join(" AND ")}`, params);
	const [rows] = await pool.query(
		`SELECT m.id, m.id_product, m.id_variant, m.type, m.field, m.qty, m.qty_before, m.qty_after, ${perms.cost ? "m.cost_price," : ""}
		        m.ref_type, m.ref_id, m.comment, m.date_add,
		        p.sku, v.sku AS variant_sku, w.code AS warehouse,
		        COALESCE(NULLIF(d.name, ''), dp.name, CONCAT('#', p.id)) AS name,
		        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS user_name,
		        sd.number AS document_number
		   FROM ${P}products_stock_movements m
		   JOIN ${P}products p ON p.id = m.id_product
		   LEFT JOIN ${P}products_variants v ON v.id = m.id_variant
		   JOIN ${P}products_warehouses w ON w.id = m.id_warehouse
		   LEFT JOIN ${P}products_description d  ON d.id_product = p.id AND d.id_lang = ?
		   LEFT JOIN ${P}products_description dp ON dp.id_product = p.id AND dp.id_lang = ?
		   LEFT JOIN ${P}users u ON u.id = m.id_user
		   LEFT JOIN ${P}products_stock_documents sd ON m.ref_type = '${REF}' AND sd.id = m.ref_id
		  WHERE ${where.join(" AND ")}
		  ORDER BY m.id DESC
		  LIMIT ? OFFSET ?`,
		[idLang, primary, ...params, size, (page - 1) * size]
	);
	return { last_page: Math.max(Math.ceil(total / size), 1), last_row: total, data: rows };
}

module.exports = { PREFIX, list, get, saveDraft, removeDraft, post, cancel, movements, MOVE_TYPES };