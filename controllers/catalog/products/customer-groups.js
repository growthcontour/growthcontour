"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const languages = require("./languages");
const { validateGroup } = require("../../../validator/catalog/products/customer-groups");

const P = config.get("configDatabase").prefix;

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

// Де використовується група (перед видаленням)
const USAGE = [
	["products_prices", "prices"],
	["products_rewards", "rewards"],
	["products_to_customer_groups", "visibility"],
];

let cache = null;
let cacheAt = 0;
function invalidate() {
	cache = null;
}

/** Активні групи для select-ів: [{ id, code, name, is_default, discount_percent }] (кеш 60 с) */
async function options() {
	if (cache && Date.now() - cacheAt < 60000) return cache;
	const [rows] = await pool.query(
		`SELECT id, code, name, is_default, discount_percent FROM ${P}products_customer_groups WHERE status = 1 ORDER BY is_default DESC, sort_order, id`
	);
	cache = rows.map((r) => ({ ...r, discount_percent: Number(r.discount_percent) }));
	cacheAt = Date.now();
	return cache;
}

async function list() {
	const counts = USAGE.map(([t]) => `(SELECT COUNT(DISTINCT id_product) FROM ${P}${t} x WHERE x.id_customer_group = g.id) AS cnt_${t}`).join(", ");
	const [rows] = await pool.query(`SELECT g.*, ${counts} FROM ${P}products_customer_groups g ORDER BY g.is_default DESC, g.sort_order, g.id`);
	return rows.map((r) => {
		const out = { ...r, discount_percent: Number(r.discount_percent), products: 0 };
		for (const [t] of USAGE) {
			out.products = Math.max(out.products, Number(r[`cnt_${t}`]));
			delete out[`cnt_${t}`];
		}
		return out;
	});
}

async function get(id) {
	const [[row]] = await pool.query(`SELECT * FROM ${P}products_customer_groups WHERE id = ?`, [id]);
	if (!row) throw httpErr(404, "Not found");
	const [descs] = await pool.query(`SELECT id_lang, name, description FROM ${P}products_customer_groups_description WHERE id_customer_group = ?`, [id]);
	row.descriptions = {};
	descs.forEach((d) => (row.descriptions[d.id_lang] = { name: d.name, description: d.description }));
	return row;
}

async function save(id, body) {
	const langIds = (await languages.active()).map((l) => l.id);
	const v = validateGroup(body, langIds);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);
	const d = v.data;

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		if (id) {
			const [[cur]] = await conn.query(`SELECT is_default FROM ${P}products_customer_groups WHERE id = ? FOR UPDATE`, [id]);
			if (!cur) throw httpErr(404, "Not found");
			if (cur.is_default && !d.status) throw httpErr(409, "Default group cannot be disabled", [{ field: "status", message: "default group" }]);
		}
		const cols = ["code", "name", "discount_percent", "price_display", "min_order_amount", "requires_approval", "status", "sort_order"];
		const values = cols.map((c) => (typeof d[c] === "boolean" ? Number(d[c]) : d[c]));
		if (id) {
			await conn.query(`UPDATE ${P}products_customer_groups SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...values, id]);
		} else {
			const [r] = await conn.query(`INSERT INTO ${P}products_customer_groups (${cols.join(", ")}) VALUES (?)`, [values]);
			id = r.insertId;
		}
		for (const [idLang, row] of Object.entries(d.descriptions)) {
			if (!row) {
				await conn.query(`DELETE FROM ${P}products_customer_groups_description WHERE id_customer_group = ? AND id_lang = ?`, [id, idLang]);
				continue;
			}
			await conn.query(
				`INSERT INTO ${P}products_customer_groups_description (id_customer_group, id_lang, name, description) VALUES (?, ?, ?, ?)
				 ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)`,
				[id, idLang, row.name, row.description]
			);
		}
		await conn.commit();
		invalidate();
		return { id };
	} catch (e) {
		await conn.rollback();
		if (e.code === "ER_DUP_ENTRY") throw httpErr(409, "Code already exists", [{ field: "code", message: "already exists" }]);
		throw e;
	} finally {
		conn.release();
	}
}

async function setDefault(id) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [[g]] = await conn.query(`SELECT id, status FROM ${P}products_customer_groups WHERE id = ? FOR UPDATE`, [id]);
		if (!g) throw httpErr(404, "Not found");
		if (!g.status) throw httpErr(409, "Inactive group cannot be default");
		// Спочатку зняти прапорець — унікальний індекс default_flag не дозволяє двох основних
		await conn.query(`UPDATE ${P}products_customer_groups SET is_default = 0 WHERE is_default = 1`);
		await conn.query(`UPDATE ${P}products_customer_groups SET is_default = 1 WHERE id = ?`, [id]);
		await conn.commit();
		invalidate();
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
}

async function remove(id) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [[g]] = await conn.query(`SELECT is_default FROM ${P}products_customer_groups WHERE id = ? FOR UPDATE`, [id]);
		if (!g) throw httpErr(404, "Not found");
		if (g.is_default) throw httpErr(409, "Default group cannot be deleted");
		for (const [t, what] of USAGE) {
			const [[u]] = await conn.query(`SELECT COUNT(*) AS n FROM ${P}${t} WHERE id_customer_group = ?`, [id]);
			if (Number(u.n)) throw httpErr(409, `Group is used: ${what} (${u.n})`, [{ field: what, message: String(u.n) }]);
		}
		await conn.query(`DELETE FROM ${P}products_customer_groups_description WHERE id_customer_group = ?`, [id]);
		await conn.query(`DELETE FROM ${P}products_customer_groups WHERE id = ?`, [id]);
		await conn.commit();
		invalidate();
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
}

/** Перевірка, що всі id груп існують (0 = «усі групи» — дозволено там, де допустимо) */
async function assertIds(conn, ids, field, allowZero = true) {
	const list = [...new Set(ids.filter((x) => !(allowZero && x === 0)))];
	if (!list.length) return;
	const [rows] = await conn.query(`SELECT id FROM ${P}products_customer_groups WHERE id IN (?)`, [list]);
	if (rows.length !== list.length) throw httpErr(400, "Validation failed", [{ field, message: "customer group not found" }]);
}

module.exports = { options, list, get, save, setDefault, remove, assertIds, invalidate };