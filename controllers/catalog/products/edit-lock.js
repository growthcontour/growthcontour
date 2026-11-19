"use strict";

const crypto = require("crypto");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("./settings");

const P = config.get("configDatabase").prefix;
const SLUG = "products.list";
const room = (id) => `io_product_${id}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpErr(status, message, extra) {
	return Object.assign(new Error(message), { status }, extra || {});
}

async function hasPermission(userId, action) {
	const column = { view: "can_view", edit: "can_edit" }[action];
	const [rows] = await pool.query(
		`SELECT 1 FROM ${P}users_to_groups utg
		   JOIN ${P}users_groups_permissions ugp ON ugp.id_group = utg.id_group
		   JOIN ${P}users_permissions_pages upp ON upp.id = ugp.id_page
		  WHERE utg.id_user = ? AND upp.slug = ? AND ugp.${column} = 1 LIMIT 1`,
		[userId, SLUG]
	);
	return rows.length > 0;
}

/** Хто зараз тримає активний lock (або null) */
async function holder(idProduct, conn) {
	const [[row]] = await (conn || pool).query(
		`SELECT l.id_user, l.lock_token, l.socket_id, l.date_add,
		        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS user_name
		   FROM ${P}products_edit_locks l
		   LEFT JOIN ${P}users u ON u.id = l.id_user
		  WHERE l.id_product = ? AND l.expires_at > NOW(3)`,
		[idProduct]
	);
	return row || null;
}

const publicHolder = (h) => (h ? { id_user: h.id_user, user_name: h.user_name, since: h.date_add } : null);

/**
 * Взяти lock. force — перехопити чужий (потрібне право edit; перевіряє викликач).
 * Повертає { ok, holder?, taken_from? }.
 */
async function acquire(idProduct, idUser, token, socketId, force) {
	const { ttl_seconds } = await settings.get("edit_lock");
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [[product]] = await conn.query(`SELECT id FROM ${P}products WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [idProduct]);
		if (!product) throw httpErr(404, "Not found");

		const current = await holder(idProduct, conn);
		if (current && current.lock_token !== token && !force) {
			await conn.rollback();
			return { ok: false, holder: publicHolder(current) };
		}
		await conn.query(
			`INSERT INTO ${P}products_edit_locks (id_product, lock_token, id_user, socket_id, expires_at)
			 VALUES (?, ?, ?, ?, NOW(3) + INTERVAL ? SECOND)
			 ON DUPLICATE KEY UPDATE lock_token = VALUES(lock_token), id_user = VALUES(id_user), socket_id = VALUES(socket_id),
			                         expires_at = VALUES(expires_at),
			                         date_add = IF(lock_token = VALUES(lock_token), date_add, NOW(3))`,
			[idProduct, token, idUser, socketId || null, ttl_seconds]
		);
		await conn.commit();
		const takenFrom = current && current.lock_token !== token ? current : null;
		return { ok: true, taken_from: takenFrom };
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

async function heartbeat(idProduct, token) {
	const { ttl_seconds } = await settings.get("edit_lock");
	const [r] = await pool.query(
		`UPDATE ${P}products_edit_locks SET expires_at = NOW(3) + INTERVAL ? SECOND
		  WHERE id_product = ? AND lock_token = ? AND expires_at > NOW(3)`,
		[ttl_seconds, idProduct, token]
	);
	return r.affectedRows === 1;
}

async function release(idProduct, token) {
	const [r] = await pool.query(`DELETE FROM ${P}products_edit_locks WHERE id_product = ? AND lock_token = ?`, [idProduct, token]);
	return r.affectedRows === 1;
}

async function releaseBySocket(socketId) {
	const [rows] = await pool.query(`SELECT id_product FROM ${P}products_edit_locks WHERE socket_id = ?`, [socketId]);
	if (rows.length) await pool.query(`DELETE FROM ${P}products_edit_locks WHERE socket_id = ?`, [socketId]);
	return rows.map((r) => r.id_product);
}

/** Для збереження: lock має належати цій вкладці й бути живим */
async function assertHeld(conn, idProduct, token, idUser) {
	if (!token || !UUID_RE.test(token)) throw httpErr(423, "Edit lock required", { code: "lock_required" });
	const [[row]] = await conn.query(
		`SELECT id_user FROM ${P}products_edit_locks WHERE id_product = ? AND lock_token = ? AND expires_at > NOW(3) FOR UPDATE`,
		[idProduct, token]
	);
	if (!row || row.id_user !== idUser) throw httpErr(423, "Edit lock lost", { code: "lock_lost" });
}

async function broadcast(io, idProduct) {
	if (!io) return;
	io.to(room(idProduct)).emit("product:lock:state", { id: idProduct, holder: publicHolder(await holder(idProduct)) });
}

/** Socket.IO: події блокування. Викликається з controllers/socket/socket.js для кожного з'єднання. */
function bindSocket(io, socket) {
	const parseId = (v) => {
		const n = parseInt(v, 10);
		return Number.isInteger(n) && n > 0 ? n : null;
	};
	const reply = (cb, data) => typeof cb === "function" && cb(data);

	// Підписка на стан lock (і для read-only переглядачів)
	socket.on("product:watch", async (p, cb) => {
		try {
			const id = parseId(p && p.id);
			if (!id || !(await hasPermission(socket.data.userId, "view"))) return reply(cb, { ok: false, error: "forbidden" });
			socket.join(room(id));
			reply(cb, { ok: true, holder: publicHolder(await holder(id)) });
		} catch (e) {
			reply(cb, { ok: false, error: "server_error" });
		}
	});

	socket.on("product:lock", async (p, cb) => {
		try {
			const id = parseId(p && p.id);
			const token = String((p && p.token) || "");
			if (!id || !UUID_RE.test(token)) return reply(cb, { ok: false, error: "bad_request" });
			if (!(await hasPermission(socket.data.userId, "edit"))) return reply(cb, { ok: false, error: "forbidden" });
			const r = await acquire(id, socket.data.userId, token, socket.id, p.force === true);
			socket.join(room(id));
			if (r.ok && r.taken_from && r.taken_from.socket_id) {
				io.to(r.taken_from.socket_id).emit("product:lock:lost", { id, by: socket.data.userId });
			}
			await broadcast(io, id);
			reply(cb, r.ok ? { ok: true } : { ok: false, error: "locked", holder: r.holder });
		} catch (e) {
			reply(cb, { ok: false, error: e.status === 404 ? "not_found" : "server_error" });
		}
	});

	socket.on("product:heartbeat", async (p, cb) => {
		try {
			const id = parseId(p && p.id);
			const ok = id ? await heartbeat(id, String((p && p.token) || "")) : false;
			reply(cb, { ok });
		} catch (e) {
			reply(cb, { ok: false });
		}
	});

	socket.on("product:unlock", async (p, cb) => {
		try {
			const id = parseId(p && p.id);
			if (id && (await release(id, String((p && p.token) || "")))) await broadcast(io, id);
			reply(cb, { ok: true });
		} catch (e) {
			reply(cb, { ok: false });
		}
	});

	socket.on("disconnect", async () => {
		try {
			const ids = await releaseBySocket(socket.id);
			for (const id of ids) await broadcast(io, id);
		} catch (e) {}
	});
}

module.exports = { acquire, heartbeat, release, releaseBySocket, assertHeld, holder, publicHolder, broadcast, bindSocket, room, newToken: () => crypto.randomUUID() };