"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("./settings");
const stock = require("./stock");

const P = config.get("configDatabase").prefix;

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

/**
 * Зарезервувати товар під замовлення/угоду (в межах транзакції викликача).
 * o: { idProduct, idVariant=0, idWarehouse, qty, refType, refId, idUser, ttlMinutes? }
 * Повторний виклик для того самого ref-рядка замінює кількість резерву.
 */
async function reserve(conn, o) {
	const cfg = await settings.get("stock");
	const qty = Number(o.qty);
	if (!(qty > 0)) throw httpErr(400, "Reservation qty must be > 0");
	const idVariant = o.idVariant || 0;
	const ttl = o.ttlMinutes ?? cfg.reservation_ttl_minutes;

	const [[existing]] = await conn.query(
		`SELECT id, qty FROM ${P}products_stock_reservations
		  WHERE ref_type = ? AND ref_id = ? AND id_product = ? AND id_variant = ? AND id_warehouse = ? FOR UPDATE`,
		[o.refType, o.refId, o.idProduct, idVariant, o.idWarehouse]
	);
	const delta = qty - (existing ? Number(existing.qty) : 0);

	if (delta > 0) {
		const [[s]] = await conn.query(
			`SELECT on_hand - reserved AS available FROM ${P}products_stock WHERE id_product = ? AND id_variant = ? AND id_warehouse = ? FOR UPDATE`,
			[o.idProduct, idVariant, o.idWarehouse]
		);
		if (!cfg.allow_negative && (!s || Number(s.available) + 1e-9 < delta)) {
			throw httpErr(409, "Insufficient stock to reserve", [{ field: "qty", message: "not enough available stock" }]);
		}
	}
	if (delta !== 0) {
		await stock.adjust(conn, { idProduct: o.idProduct, idVariant, idWarehouse: o.idWarehouse, field: "reserved", delta, type: delta > 0 ? "reserve" : "unreserve", refType: o.refType, refId: o.refId, idUser: o.idUser });
	}
	const expires = ttl > 0 ? new Date(Date.now() + ttl * 60000) : null;
	await conn.query(
		`INSERT INTO ${P}products_stock_reservations (id_product, id_variant, id_warehouse, qty, ref_type, ref_id, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE qty = VALUES(qty), expires_at = VALUES(expires_at)`,
		[o.idProduct, idVariant, o.idWarehouse, qty, o.refType, o.refId, expires]
	);
}

/** Зняти всі резерви документа (замовлення/угоди) */
async function release(conn, refType, refId, idUser) {
	const [rows] = await conn.query(
		`SELECT * FROM ${P}products_stock_reservations WHERE ref_type = ? AND ref_id = ? ORDER BY id_product, id_variant, id_warehouse FOR UPDATE`,
		[refType, refId]
	);
	for (const r of rows) {
		await stock.adjust(conn, { idProduct: r.id_product, idVariant: r.id_variant, idWarehouse: r.id_warehouse, field: "reserved", delta: -Number(r.qty), type: "unreserve", refType, refId, idUser });
	}
	if (rows.length) await conn.query(`DELETE FROM ${P}products_stock_reservations WHERE ref_type = ? AND ref_id = ?`, [refType, refId]);
	return rows.length;
}

/** Крон: зняти прострочені резерви (по одному документу на транзакцію) */
async function expireDue() {
	const [refs] = await pool.query(
		`SELECT DISTINCT ref_type, ref_id FROM ${P}products_stock_reservations WHERE expires_at IS NOT NULL AND expires_at <= NOW() LIMIT 500`
	);
	let released = 0;
	for (const ref of refs) {
		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();
			const [rows] = await conn.query(
				`SELECT * FROM ${P}products_stock_reservations
				  WHERE ref_type = ? AND ref_id = ? AND expires_at IS NOT NULL AND expires_at <= NOW()
				  ORDER BY id_product, id_variant, id_warehouse FOR UPDATE`,
				[ref.ref_type, ref.ref_id]
			);
			for (const r of rows) {
				await stock.adjust(conn, { idProduct: r.id_product, idVariant: r.id_variant, idWarehouse: r.id_warehouse, field: "reserved", delta: -Number(r.qty), type: "unreserve", refType: r.ref_type, refId: r.ref_id, comment: "Reservation expired" });
				await conn.query(`DELETE FROM ${P}products_stock_reservations WHERE id = ?`, [r.id]);
				released++;
			}
			await conn.commit();
		} catch (e) {
			await conn.rollback().catch(() => {});
			console.error("[reservations] expire", ref.ref_type, ref.ref_id, e.message);
		} finally {
			conn.release();
		}
	}
	return released;
}

const LIST_SORT = {
	date_add: "r.date_add",
	expires_at: "r.expires_at",
	qty: "r.qty",
	name: "name",
	warehouse: "w.name",
};

const likeOf = (s) => "%" + s.replace(/[\\%_]/g, (m) => "\\" + m) + "%";

/** Список резервів для UI (Tabulator remote: page, size, sort, filters) */
async function list(q, idLang, primaryLang) {
	const size = Math.min(Math.max(parseInt(q.size, 10) || 50, 1), 500);
	const page = Math.max(parseInt(q.page, 10) || 1, 1);
	const where = ["1 = 1"];
	const params = [];

	if (parseInt(q.id_warehouse, 10) > 0) {
		where.push("r.id_warehouse = ?");
		params.push(parseInt(q.id_warehouse, 10));
	}
	if (/^[a-z_]{1,32}$/.test(q.ref_type || "")) {
		where.push("r.ref_type = ?");
		params.push(q.ref_type);
	}
	if (q.expired === true || q.expired === "1" || q.expired === 1) where.push("r.expires_at IS NOT NULL AND r.expires_at <= NOW()");
	if (parseInt(q.id_product, 10) > 0) {
		where.push("r.id_product = ?");
		params.push(parseInt(q.id_product, 10));
	}
	const search = String(q.search || "").trim().slice(0, 100);
	if (search) {
		const like = likeOf(search);
		where.push(`(p.sku LIKE ? OR v.sku LIKE ? OR EXISTS (SELECT 1 FROM ${P}products_description d WHERE d.id_product = p.id AND d.name LIKE ?))`);
		params.push(like, like, like);
	}

	const sorter = Array.isArray(q.sort) && q.sort[0] ? q.sort[0] : null;
	const orderCol = sorter && LIST_SORT[sorter.field] ? LIST_SORT[sorter.field] : "r.date_add";
	const orderDir = sorter && String(sorter.dir).toLowerCase() === "asc" ? "ASC" : "DESC";

	const from = `
		FROM ${P}products_stock_reservations r
		JOIN ${P}products p ON p.id = r.id_product
		JOIN ${P}products_warehouses w ON w.id = r.id_warehouse
		LEFT JOIN ${P}products_variants v ON v.id = r.id_variant AND r.id_variant > 0`;

	const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(" AND ")}`, params);
	const [rows] = await pool.query(
		`SELECT r.id, r.id_product, r.id_variant, r.id_warehouse, r.qty, r.ref_type, r.ref_id, r.expires_at, r.date_add,
		        (r.expires_at IS NOT NULL AND r.expires_at <= NOW()) AS is_expired,
		        COALESCE(v.sku, p.sku) AS sku, w.name AS warehouse,
		        COALESCE(
		          (SELECT NULLIF(d.name, '') FROM ${P}products_description d WHERE d.id_product = p.id AND d.id_lang = ?),
		          (SELECT d.name FROM ${P}products_description d WHERE d.id_product = p.id AND d.id_lang = ?),
		          CONCAT('#', p.id)) AS name,
		        (SELECT GROUP_CONCAT(COALESCE(NULLIF(vd.name, ''), vdp.name, av.code) ORDER BY ax.sort_order SEPARATOR ' / ')
		           FROM ${P}products_variant_values vv
		           JOIN ${P}products_attribute_values av ON av.id = vv.id_attribute_value
		           LEFT JOIN ${P}products_variant_axes ax ON ax.id_product = r.id_product AND ax.id_attribute = vv.id_attribute
		           LEFT JOIN ${P}products_attribute_values_description vd  ON vd.id_attribute_value = vv.id_attribute_value AND vd.id_lang = ?
		           LEFT JOIN ${P}products_attribute_values_description vdp ON vdp.id_attribute_value = vv.id_attribute_value AND vdp.id_lang = ?
		          WHERE vv.id_variant = r.id_variant) AS variant_label,
		        (SELECT s.on_hand FROM ${P}products_stock s WHERE s.id_product = r.id_product AND s.id_variant = r.id_variant AND s.id_warehouse = r.id_warehouse) AS on_hand,
		        (SELECT s.available FROM ${P}products_stock s WHERE s.id_product = r.id_product AND s.id_variant = r.id_variant AND s.id_warehouse = r.id_warehouse) AS available
		   ${from}
		  WHERE ${where.join(" AND ")}
		  ORDER BY ${orderCol} ${orderDir}, r.id DESC
		  LIMIT ? OFFSET ?`,
		[idLang, primaryLang, idLang, primaryLang, ...params, size, (page - 1) * size]
	);
	return { last_page: Math.max(Math.ceil(total / size), 1), last_row: total, data: rows };
}

/** Ручне зняття одного резерву */
async function releaseOne(id, idUser, comment) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [[r]] = await conn.query(`SELECT * FROM ${P}products_stock_reservations WHERE id = ? FOR UPDATE`, [id]);
		if (!r) throw httpErr(404, "Reservation not found");
		await stock.adjust(conn, {
			idProduct: r.id_product,
			idVariant: r.id_variant,
			idWarehouse: r.id_warehouse,
			field: "reserved",
			delta: -Number(r.qty),
			type: "unreserve",
			refType: r.ref_type,
			refId: r.ref_id,
			idUser,
			comment: comment || "Manual release",
		});
		await conn.query(`DELETE FROM ${P}products_stock_reservations WHERE id = ?`, [id]);
		await conn.commit();
		return { id_product: r.id_product, ref_type: r.ref_type, ref_id: r.ref_id, qty: r.qty };
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

/** Ручне зняття всіх резервів документа (угоди / замовлення) */
async function releaseRef(refType, refId, idUser) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const n = await release(conn, refType, refId, idUser);
		await conn.commit();
		return n;
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

module.exports = { reserve, release, expireDue, list, releaseOne, releaseRef };