const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const history = require("./history");

const P = config.get("configDatabase").prefix;
const MAX_BODY = 10000;
const MAX_MENTIONS = 20;

function httpErr(status, message) {
	const e = new Error(message);
	e.status = status;
	return e;
}

const preview = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 300);

/** Нотатки клієнта: закріплені зверху, далі нові. Курсор before_id для «Показати ще». */
async function list(idClient, idUser, opts) {
	const o = opts || {};
	const limit = Math.min(Math.max(parseInt(o.limit, 10) || 20, 1), 100);
	const before = parseInt(o.before_id, 10) || 0;

	const [pinned] = before
		? [[]]
		: await pool.query(
				`SELECT n.*, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS author
                   FROM ${P}clients_notes n LEFT JOIN ${P}users u ON u.id = n.id_user
                  WHERE n.id_client = ? AND n.deleted_at IS NULL AND n.is_pinned = 1
                  ORDER BY n.date_pinned DESC, n.id DESC`,
				[idClient]
		  );

	const [rows] = await pool.query(
		`SELECT n.*, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS author
           FROM ${P}clients_notes n LEFT JOIN ${P}users u ON u.id = n.id_user
          WHERE n.id_client = ? AND n.deleted_at IS NULL AND n.is_pinned = 0 ${before ? "AND n.id < ?" : ""}
          ORDER BY n.id DESC
          LIMIT ${limit + 1}`,
		before ? [idClient, before] : [idClient]
	);
	const hasMore = rows.length > limit;
	if (hasMore) rows.pop();

	const map = (n) => ({
		id: n.id,
		body: n.body,
		is_pinned: Number(n.is_pinned) === 1,
		author: n.author || (n.id_user ? "#" + n.id_user : "Система"),
		is_mine: n.id_user === idUser,
		edited: !!n.date_edit && String(n.date_edit) !== String(n.date_add),
		date_add: n.date_add,
	});
	return { pinned: pinned.map(map), rows: rows.map(map), has_more: hasMore, next_before_id: hasMore ? rows[rows.length - 1].id : null };
}

// Згадані користувачі: лише активні й лише ті, чиє @імʼя справді є в тексті
async function resolveMentions(conn, body, ids) {
	const list = [...new Set((Array.isArray(ids) ? ids : []).map((x) => parseInt(x, 10)).filter(Boolean))].slice(0, MAX_MENTIONS);
	if (!list.length) return [];
	const [users] = await conn.query(`SELECT id, NULLIF(TRIM(CONCAT_WS(' ', last_name, first_name)), '') AS n1, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS n2 FROM ${P}users WHERE id IN (?) AND active = 1`, [list]);
	return users.filter((u) => (u.n1 && body.includes("@" + u.n1)) || (u.n2 && body.includes("@" + u.n2))).map((u) => u.id);
}

async function notifyMentions(userIds, h, idClient, clientName, body) {
	if (!userIds.length) return;
	const notifications = require("../notifications/index");
	for (const uid of userIds) {
		if (uid === h.id_user) continue;
		notifications
			.notify({
				type: "personal.mention",
				audience: { user: uid },
				channels: ["inapp"],
				payload: {
					title: (h.user_name || "Колега") + " згадав вас: " + (clientName || "клієнт #" + idClient),
					message: preview(body).slice(0, 200),
					url: "/clients/" + idClient + "/#notes",
				},
				key: "mention:client:" + idClient + ":" + h.batch + ":u" + uid,
			})
			.catch((e) => console.error("notify mention:", e.message));
	}
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

async function loadNote(conn, idClient, idNote) {
	const [[n]] = await conn.query(`SELECT * FROM ${P}clients_notes WHERE id = ? AND id_client = ? AND deleted_at IS NULL FOR UPDATE`, [idNote, idClient]);
	if (!n) throw httpErr(404, "Нотатку не знайдено.");
	return n;
}

/** Додати нотатку. b: { body, mentions: [idUser] } */
async function add(idClient, b, h) {
	const body = String((b && b.body) || "").trim().slice(0, MAX_BODY);
	if (!body) throw httpErr(400, "Напишіть текст нотатки.");

	let clientName = null;
	let mentions = [];
	const r = await tx(async (conn) => {
		const [[c]] = await conn.query(`SELECT id, display_name FROM ${P}clients WHERE id = ? AND deleted_at IS NULL AND id_merged_into IS NULL FOR UPDATE`, [idClient]);
		if (!c) throw httpErr(404, "Клієнта не знайдено.");
		clientName = c.display_name;
		mentions = await resolveMentions(conn, body, b.mentions);

		const [ins] = await conn.query(
			`INSERT INTO ${P}clients_notes (id_client, id_user, body, mentions, is_pinned, date_add, date_edit)
             VALUES (?, ?, ?, CAST(? AS JSON), 0, NOW(), NOW())`,
			[idClient, h.id_user, body, JSON.stringify(mentions)]
		);
		await conn.query(`UPDATE ${P}clients SET date_last_activity = NOW() WHERE id = ?`, [idClient]);
		await history.write(conn, h, [{ id_client: idClient, action: "added", entity: "note", id_entity: ins.insertId, value_new: preview(body) }]);
		return { ok: true, id: ins.insertId };
	});
	notifyMentions(mentions, h, idClient, clientName, body);
	return r;
}

/** Редагувати — лише автор */
async function update(idClient, idNote, b, h) {
	const body = String((b && b.body) || "").trim().slice(0, MAX_BODY);
	if (!body) throw httpErr(400, "Напишіть текст нотатки.");

	let fresh = [];
	const r = await tx(async (conn) => {
		const n = await loadNote(conn, idClient, idNote);
		if (n.id_user !== h.id_user) throw httpErr(403, "Редагувати може лише автор.");
		if (n.body === body) return { ok: true };

		const mentions = await resolveMentions(conn, body, b.mentions);
		const old = Array.isArray(n.mentions) ? n.mentions : JSON.parse(n.mentions || "[]");
		fresh = mentions.filter((x) => !old.includes(x));

		await conn.query(`UPDATE ${P}clients_notes SET body = ?, mentions = CAST(? AS JSON), date_edit = NOW() WHERE id = ?`, [body, JSON.stringify(mentions), idNote]);
		await history.write(conn, h, [{ id_client: idClient, action: "updated", entity: "note", id_entity: idNote, value_old: preview(n.body), value_new: preview(body) }]);
		return { ok: true };
	});
	if (fresh.length) {
		const [[c]] = await pool.query(`SELECT display_name FROM ${P}clients WHERE id = ?`, [idClient]);
		notifyMentions(fresh, h, idClient, c && c.display_name, body);
	}
	return r;
}

/** Видалити (м'яко) — автор або адміністратор */
async function remove(idClient, idNote, h, isAdmin) {
	return tx(async (conn) => {
		const n = await loadNote(conn, idClient, idNote);
		if (n.id_user !== h.id_user && !isAdmin) throw httpErr(403, "Видалити може лише автор.");
		await conn.query(`UPDATE ${P}clients_notes SET deleted_at = NOW(), id_user_deleted = ? WHERE id = ?`, [h.id_user, idNote]);
		await history.write(conn, h, [{ id_client: idClient, action: "removed", entity: "note", id_entity: idNote, value_old: preview(n.body) }]);
		return { ok: true };
	});
}

/** Закріпити / відкріпити — будь-хто з доступом до картки */
async function pin(idClient, idNote, pinned, h) {
	return tx(async (conn) => {
		const n = await loadNote(conn, idClient, idNote);
		const v = pinned ? 1 : 0;
		if (Number(n.is_pinned) === v) return { ok: true };
		await conn.query(`UPDATE ${P}clients_notes SET is_pinned = ?, date_pinned = IF(? = 1, NOW(), NULL) WHERE id = ?`, [v, v, idNote]);
		await history.write(conn, h, [{ id_client: idClient, action: "updated", entity: "note", id_entity: idNote, field: "is_pinned", value_old: n.is_pinned, value_new: v }]);
		return { ok: true };
	});
}

module.exports = { list, add, update, remove, pin };