"use strict";

const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const editLock = require("./edit-lock");

const P = config.get("configDatabase").prefix;

function httpErr(status, message, errors, extra) {
	return Object.assign(new Error(message), { status, errors }, extra || {});
}

/**
 * Зміна частини товару (комплект, файли тощо) з тими самими гарантіями, що й у карточці:
 * рядок товару заблоковано, lock цієї вкладки живий, версія збігається; після змін версія +1.
 * fn(conn, product) повертає об'єкт результату; afterCommit — дії після коміту (видалення файлів).
 */
async function mutate(idProduct, ctx, fn) {
	const conn = await pool.getConnection();
	let result;
	try {
		await conn.beginTransaction();
		const [[product]] = await conn.query(`SELECT * FROM ${P}products WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [idProduct]);
		if (!product) throw httpErr(404, "Not found");
		await editLock.assertHeld(conn, idProduct, ctx.lockToken, ctx.idUser);
		if (Number(ctx.version) !== Number(product.version)) {
			throw httpErr(409, "Product was changed by someone else", null, { code: "version_conflict", version: product.version });
		}
		result = (await fn(conn, product)) || {};
		await conn.query(`UPDATE ${P}products SET version = version + 1, id_user_edit = ? WHERE id = ?`, [ctx.idUser, idProduct]);
		const [[{ version }]] = await conn.query(`SELECT version FROM ${P}products WHERE id = ?`, [idProduct]);
		await conn.commit();
		result.version = version;
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	if (typeof result.afterCommit === "function") {
		await result.afterCommit().catch((e) => console.error("[product-mutate] afterCommit", e.message));
		delete result.afterCommit;
	}
	return result;
}

module.exports = { mutate, httpErr };