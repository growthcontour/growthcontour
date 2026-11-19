"use strict";

/**
 * Чат компанії: чати та учасники.
 *   direct  — особистий чат двох людей (один на пару, direct_key)
 *   notes   — нотатки, чат із собою (один на людину)
 *   group   — закрита група; channel — канал (public — видно всім, можна приєднатись)
 * Автоматичні канали (kind): офіс, відділ, оголошення — склад рахується зі структури компанії (syncAll / syncUser).
 */
const { pool, T, httpErr, userName, avatarUrl, membership, canManage, canPost, canComment, activeUsers } = require("./common");
const realtime = require("./realtime");
const logging = require("../../logging/logging");

const AUTO_LOCK = `${T.rooms}_auto_sync`;
const ANNOUNCEMENTS_REF = 0;

function online(id) {
	try {
		return require("../socket/socket").isUserOnline(id);
	} catch {
		return false;
	}
}

/** Системне повідомлення в чат (створено, додано, перейменовано …). Повертає id */
async function systemMessage(conn, idRoom, data) {
	const [r] = await conn.query(`INSERT INTO ${T.messages} (id_room, id_user, type, data, date_add) VALUES (?, NULL, 'system', ?, NOW(3))`, [idRoom, JSON.stringify(data)]);
	await conn.query(`UPDATE ${T.rooms} SET last_message_id = ?, last_message_at = NOW(3) WHERE id = ?`, [r.insertId, idRoom]);
	return r.insertId;
}

async function tx(fn) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const out = await fn(conn);
		await conn.commit();
		return out;
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
}

const parse = (v) => {
	if (v == null || typeof v === "object") return v;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
};

/** Статуси людей (лише чинні: until у майбутньому або без строку) */
async function statuses(ids) {
	if (!ids.length) return new Map();
	const [rows] = await pool.query(`SELECT id_user, status, text, until FROM ${T.status} WHERE id_user IN (?) AND (until IS NULL OR until > NOW())`, [ids]);
	return new Map(rows.map((r) => [Number(r.id_user), { status: r.status, text: r.text, until: r.until }]));
}

/** Короткі дані про людей для списків: ім'я, аватар, посада, онлайн, статус */
async function people(ids) {
	const uids = [...new Set(ids.map(Number))].filter(Boolean);
	if (!uids.length) return new Map();
	const [rows] = await pool.query(
		`SELECT u.id, ${userName("u")} AS name, u.avatar, u.position, u.active, u.date_last_seen, u.timezone, o.timezone AS office_timezone
		   FROM ${T.users} u LEFT JOIN ${T.offices} o ON o.id = u.id_office
		  WHERE u.id IN (?)`,
		[uids]
	);
	const st = await statuses(uids);
	return new Map(
		rows.map((u) => [
			Number(u.id),
			{
				id: Number(u.id),
				name: u.name,
				avatar: avatarUrl(u.id, u.avatar),
				position: u.position,
				active: Number(u.active) === 1,
				online: online(u.id),
				last_seen: u.date_last_seen,
				timezone: u.timezone || u.office_timezone || null,
				status: st.get(Number(u.id)) || null,
			},
		])
	);
}

/** Список чатів користувача: останнє повідомлення, непрочитані, чернетка */
// «Збережене» (нотатки собі) є в кожного — створюємо при першому зверненні після запуску
const notesReady = new Set();
async function list(uid) {
	await syncUser(uid).catch((e) => logging.error("[chat] syncUser", e));
	if (!notesReady.has(uid)) {
		await openNotes(uid)
			.then(() => notesReady.add(uid))
			.catch((e) => logging.error("[chat] notes", e));
	}
	const [rows] = await pool.query(
		`SELECT r.id, r.code, r.type, r.kind, r.id_ref, r.name, r.description, r.visibility, r.post_policy, r.color, r.archived,
		        r.last_message_at, r.date_add,
		        m.role, m.last_read_id, m.notify, m.muted_until, m.pinned, m.draft, m.draft_at,
		        lm.id AS lm_id, lm.id_user AS lm_user, lm.type AS lm_type, LEFT(lm.body, 200) AS lm_body, lm.data AS lm_data,
		        lm.has_files AS lm_files, lm.deleted_at AS lm_deleted, lm.date_add AS lm_date,
		        (SELECT COUNT(*) FROM ${T.messages} x
		          WHERE x.id_room = r.id AND x.id_thread IS NULL AND x.id > m.last_read_id AND x.type <> 'system' AND NOT (x.id_user <=> ?) AND x.deleted_at IS NULL) AS unread,
		        (SELECT COUNT(*) FROM ${T.mentions} mn JOIN ${T.messages} x ON x.id = mn.id_message
		          WHERE mn.id_user = m.id_user AND x.id_room = r.id AND x.id_thread IS NULL AND x.id > m.last_read_id AND x.deleted_at IS NULL) AS mentions,
		        (SELECT COUNT(*) FROM ${T.members} y WHERE y.id_room = r.id) AS members_count
		   FROM ${T.members} m
		   JOIN ${T.rooms} r ON r.id = m.id_room
		   LEFT JOIN ${T.messages} lm ON lm.id = r.last_message_id
		  WHERE m.id_user = ? AND m.hidden = 0
		  ORDER BY r.type = 'notes' DESC, m.pinned DESC, COALESCE(r.last_message_at, r.date_add) DESC`,
		[uid, uid]
	);

	// Співрозмовник в особистих чатах
	const directIds = rows.filter((r) => r.type === "direct").map((r) => r.id);
	const partner = new Map();
	if (directIds.length) {
		const [p] = await pool.query(`SELECT id_room, id_user FROM ${T.members} WHERE id_room IN (?) AND id_user <> ?`, [directIds, uid]);
		p.forEach((x) => partner.set(x.id_room, Number(x.id_user)));
	}
	const who = await people([...partner.values(), ...rows.map((r) => r.lm_user).filter(Boolean)]);

	return rows.map((r) => ({
		id: r.id,
		code: r.code,
		type: r.type,
		kind: r.kind,
		name: r.name,
		description: r.description,
		visibility: r.visibility,
		post_policy: r.post_policy,
		color: r.color,
		archived: !!r.archived,
		role: r.role,
		notify: r.notify,
		muted_until: r.muted_until,
		pinned: !!r.pinned,
		draft: r.draft,
		unread: Number(r.unread),
		mentions: Number(r.mentions),
		members_count: Number(r.members_count),
		last_read_id: Number(r.last_read_id),
		activity_at: r.last_message_at || r.date_add,
		partner: r.type === "direct" ? who.get(partner.get(r.id)) || null : null,
		last: r.lm_id
			? {
					id: Number(r.lm_id),
					id_user: r.lm_user,
					author: r.lm_user ? (who.get(Number(r.lm_user)) || {}).name || null : null,
					type: r.lm_type,
					body: r.lm_deleted ? null : r.lm_body,
					data: parse(r.lm_data),
					has_files: !!r.lm_files,
					deleted: !!r.lm_deleted,
					date: r.lm_date,
				}
			: null,
	}));
}

/**
 * Сумарно непрочитаних у стрічках чатів (лічильник у шапці). Вимкнені чати не рахуються, відповіді тредів — окремо.
 * Рахуються повідомлення людей і події системи (type = event), службові записи (type = system) — ні.
 */
async function unreadTotal(uid) {
	const [[r]] = await pool.query(
		`SELECT COUNT(*) AS n
		   FROM ${T.members} m
		   JOIN ${T.messages} x ON x.id_room = m.id_room AND x.id_thread IS NULL AND x.id > m.last_read_id
		  WHERE m.id_user = ? AND x.type <> 'system' AND NOT (x.id_user <=> ?) AND x.deleted_at IS NULL
		    AND m.notify <> 'none' AND (m.muted_until IS NULL OR m.muted_until < NOW())`,
		[uid, uid]
	);
	return Number(r.n);
}

/** Чат з учасниками */
async function get(uid, idRoom, perms) {
	const m = await membership(idRoom, uid);
	const [[room]] = await pool.query(`SELECT id, code, type, kind, id_ref, name, description, visibility, post_policy, color, archived, id_owner, date_add FROM ${T.rooms} WHERE id = ?`, [idRoom]);
	const [mem] = await pool.query(`SELECT id_user, role, last_read_id, joined_at FROM ${T.members} WHERE id_room = ? ORDER BY FIELD(role, 'owner', 'admin', 'member'), joined_at`, [idRoom]);
	const who = await people(mem.map((x) => x.id_user));
	return {
		...room,
		archived: !!room.archived,
		role: m.role,
		notify: m.notify,
		muted_until: m.muted_until,
		can: { manage: canManage(m), post: canPost(m, perms), comment: canPost(m, perms) || canComment(m), leave: m.kind === "manual" && (m.type === "group" || m.type === "channel") },
		members: mem.map((x) => ({ ...(who.get(Number(x.id_user)) || { id: Number(x.id_user) }), role: x.role, last_read_id: Number(x.last_read_id), joined_at: x.joined_at })),
	};
}

/** Код чату з адреси → id; лише для учасника (інакше — «не знайдено», як для неіснуючого) */
async function resolve(uid, code) {
	if (typeof code !== "string" || !/^[0-9a-f]{16}$/.test(code)) throw httpErr(404, "chat.errors.not_found");
	const [[r]] = await pool.query(`SELECT r.id FROM ${T.rooms} r JOIN ${T.members} m ON m.id_room = r.id AND m.id_user = ? WHERE r.code = ?`, [uid, code]);
	if (!r) throw httpErr(404, "chat.errors.not_found");
	return Number(r.id);
}

/** Особистий чат із людиною: знайти або створити */
async function openDirect(uid, other) {
	if (other === uid) return openNotes(uid);
	const [ok] = await activeUsers([other]);
	if (!ok) throw httpErr(404, "chat.errors.user_not_found");
	const key = `d:${Math.min(uid, other)}:${Math.max(uid, other)}`;
	return tx(async (conn) => {
		const [r] = await conn.query(
			`INSERT INTO ${T.rooms} (type, kind, direct_key, visibility, date_add, date_edit) VALUES ('direct', 'manual', ?, 'private', NOW(), NOW())
			 ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
			[key]
		);
		const id = r.insertId;
		await conn.query(`INSERT IGNORE INTO ${T.members} (id_room, id_user, role, joined_at) VALUES (?, ?, 'member', NOW()), (?, ?, 'member', NOW())`, [id, uid, id, other]);
		await conn.query(`UPDATE ${T.members} SET hidden = 0 WHERE id_room = ? AND id_user = ?`, [id, uid]);
		realtime.forget(id);
		return { id };
	});
}

/** Нотатки — чат із собою */
async function openNotes(uid) {
	return tx(async (conn) => {
		const [r] = await conn.query(
			`INSERT INTO ${T.rooms} (type, kind, direct_key, visibility, date_add, date_edit) VALUES ('notes', 'manual', ?, 'private', NOW(), NOW())
			 ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
			[`n:${uid}`]
		);
		await conn.query(`INSERT IGNORE INTO ${T.members} (id_room, id_user, role, joined_at) VALUES (?, ?, 'owner', NOW())`, [r.insertId, uid]);
		await conn.query(`UPDATE ${T.members} SET hidden = 0 WHERE id_room = ? AND id_user = ?`, [r.insertId, uid]);
		return { id: r.insertId };
	});
}

/** Нова група або канал */
async function create(uid, d) {
	const members = (await activeUsers(d.members)).filter((x) => x !== uid);
	const out = await tx(async (conn) => {
		const [r] = await conn.query(
			`INSERT INTO ${T.rooms} (type, kind, name, description, visibility, color, id_owner, date_add, date_edit)
			 VALUES (?, 'manual', ?, ?, ?, ?, ?, NOW(), NOW())`,
			[d.type, d.name, d.description, d.type === "channel" ? d.visibility : "private", d.color, uid]
		);
		const id = r.insertId;
		const values = [[id, uid, "owner"], ...members.map((u) => [id, u, "member"])];
		await conn.query(`INSERT INTO ${T.members} (id_room, id_user, role, joined_at) VALUES ${values.map(() => "(?, ?, ?, NOW())").join(", ")}`, values.flat());
		await systemMessage(conn, id, { event: "created", by: uid });
		return { id };
	});
	realtime.emitToUsers([uid, ...members], "chat:room", { id: out.id });
	return out;
}

/** Назва, опис, видимість, колір. Лише власник і адміністратори ручних груп / каналів */
async function update(uid, idRoom, d) {
	const out = await tx(async (conn) => {
		const m = await membership(idRoom, uid, { conn, lock: true });
		if (!canManage(m)) throw httpErr(403, "chat.errors.forbidden");
		const set = [];
		const vals = [];
		for (const k of ["name", "description", "color"]) {
			if (d[k] !== undefined) {
				set.push(`${k} = ?`);
				vals.push(d[k]);
			}
		}
		if (d.visibility !== undefined && m.type === "channel") {
			set.push("visibility = ?");
			vals.push(d.visibility);
		}
		if (!set.length) return { id: idRoom };
		await conn.query(`UPDATE ${T.rooms} SET ${set.join(", ")}, date_edit = NOW() WHERE id = ?`, [...vals, idRoom]);
		if (d.name !== undefined && d.name !== m.name) await systemMessage(conn, idRoom, { event: "renamed", by: uid, name: d.name });
		return { id: idRoom };
	});
	await realtime.emitToRoom(idRoom, "chat:room", { id: idRoom });
	return out;
}

async function addMembers(uid, idRoom, ids) {
	const added = await tx(async (conn) => {
		const m = await membership(idRoom, uid, { conn, lock: true });
		if (!canManage(m)) throw httpErr(403, "chat.errors.forbidden");
		const users = await activeUsers(ids, conn);
		if (!users.length) return [];
		const [exist] = await conn.query(`SELECT id_user FROM ${T.members} WHERE id_room = ? AND id_user IN (?)`, [idRoom, users]);
		const have = new Set(exist.map((x) => Number(x.id_user)));
		const fresh = users.filter((u) => !have.has(u));
		if (!fresh.length) return [];
		await conn.query(`INSERT INTO ${T.members} (id_room, id_user, role, joined_at) VALUES ${fresh.map(() => "(?, ?, 'member', NOW())").join(", ")}`, fresh.flatMap((u) => [idRoom, u]));
		// Нові учасники не отримують «непрочитаними» всю історію
		await conn.query(`UPDATE ${T.members} m JOIN ${T.rooms} r ON r.id = m.id_room SET m.last_read_id = COALESCE(r.last_message_id, 0) WHERE m.id_room = ? AND m.id_user IN (?)`, [idRoom, fresh]);
		await systemMessage(conn, idRoom, { event: "added", by: uid, users: fresh });
		return fresh;
	});
	realtime.forget(idRoom);
	if (added.length) {
		realtime.emitToUsers(added, "chat:room", { id: idRoom });
		await realtime.emitToRoom(idRoom, "chat:room", { id: idRoom });
	}
	return { added };
}

async function removeMember(uid, idRoom, idUser) {
	await tx(async (conn) => {
		const m = await membership(idRoom, uid, { conn, lock: true });
		if (idUser !== uid && !canManage(m)) throw httpErr(403, "chat.errors.forbidden");
		if (m.kind !== "manual" || !(m.type === "group" || m.type === "channel")) throw httpErr(403, "chat.errors.auto_room");
		const [[target]] = await conn.query(`SELECT role FROM ${T.members} WHERE id_room = ? AND id_user = ?`, [idRoom, idUser]);
		if (!target) throw httpErr(404, "chat.errors.not_found");
		if (target.role === "owner" && idUser !== uid) throw httpErr(403, "chat.errors.owner_cannot_be_removed");
		await conn.query(`DELETE FROM ${T.members} WHERE id_room = ? AND id_user = ?`, [idRoom, idUser]);

		// Власник вийшов — права переходять адміністратору або найдавнішому учаснику; нікого нема — чат в архів
		if (target.role === "owner") {
			const [[next]] = await conn.query(`SELECT id_user FROM ${T.members} WHERE id_room = ? ORDER BY FIELD(role, 'admin', 'member'), joined_at LIMIT 1`, [idRoom]);
			if (next) {
				await conn.query(`UPDATE ${T.members} SET role = 'owner' WHERE id_room = ? AND id_user = ?`, [idRoom, next.id_user]);
				await conn.query(`UPDATE ${T.rooms} SET id_owner = ? WHERE id = ?`, [next.id_user, idRoom]);
			} else {
				await conn.query(`UPDATE ${T.rooms} SET archived = 1, id_owner = NULL WHERE id = ?`, [idRoom]);
			}
		}
		await systemMessage(conn, idRoom, idUser === uid ? { event: "left", user: uid } : { event: "removed", by: uid, user: idUser });
	});
	realtime.forget(idRoom);
	realtime.emitToUsers([idUser], "chat:room:remove", { id: idRoom });
	await realtime.emitToRoom(idRoom, "chat:room", { id: idRoom });
	return { ok: true };
}

/** Адміністратор / учасник. Лише власник */
async function setRole(uid, idRoom, idUser, role) {
	await tx(async (conn) => {
		const m = await membership(idRoom, uid, { conn, lock: true });
		if (m.role !== "owner" || !canManage(m)) throw httpErr(403, "chat.errors.forbidden");
		if (idUser === uid) throw httpErr(400, "chat.errors.validation");
		const [r] = await conn.query(`UPDATE ${T.members} SET role = ? WHERE id_room = ? AND id_user = ? AND role <> 'owner'`, [role, idRoom, idUser]);
		if (!r.affectedRows) throw httpErr(404, "chat.errors.not_found");
	});
	await realtime.emitToRoom(idRoom, "chat:room", { id: idRoom });
	return { ok: true };
}

/** Відкриті канали, у яких людини ще нема */
async function browse(uid, q) {
	const search = String(q || "").trim().slice(0, 100);
	const params = [uid];
	let where = "";
	if (search) {
		where = "AND (r.name LIKE ? OR r.description LIKE ?)";
		const like = `%${search.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
		params.push(like, like);
	}
	const [rows] = await pool.query(
		`SELECT r.id, r.name, r.description, r.color, (SELECT COUNT(*) FROM ${T.members} y WHERE y.id_room = r.id) AS members_count
		   FROM ${T.rooms} r
		  WHERE r.type = 'channel' AND r.visibility = 'public' AND r.archived = 0 AND r.kind = 'manual'
		    AND NOT EXISTS (SELECT 1 FROM ${T.members} m WHERE m.id_room = r.id AND m.id_user = ?) ${where}
		  ORDER BY members_count DESC, r.name LIMIT 100`,
		params
	);
	return rows;
}

async function join(uid, idRoom) {
	await tx(async (conn) => {
		const [[r]] = await conn.query(`SELECT id, type, visibility, archived, kind, last_message_id FROM ${T.rooms} WHERE id = ? FOR UPDATE`, [idRoom]);
		if (!r || r.type !== "channel" || r.visibility !== "public" || r.archived || r.kind !== "manual") throw httpErr(404, "chat.errors.not_found");
		const [ins] = await conn.query(`INSERT IGNORE INTO ${T.members} (id_room, id_user, role, last_read_id, joined_at) VALUES (?, ?, 'member', ?, NOW())`, [idRoom, uid, r.last_message_id || 0]);
		if (ins.affectedRows) await systemMessage(conn, idRoom, { event: "joined", user: uid });
	});
	realtime.forget(idRoom);
	await realtime.emitToRoom(idRoom, "chat:room", { id: idRoom });
	return { id: idRoom };
}

/** Особисті налаштування чату: сповіщення, «не турбувати на час», закріплення, приховати */
async function settings(uid, idRoom, d) {
	const m = await membership(idRoom, uid);
	// «Збережене» (як у Telegram): завжди перше в списку, сповіщень немає — налаштовувати нічого
	if (m.type === "notes") throw httpErr(400, "chat.errors.validation");
	const set = [];
	const vals = [];
	if (d.notify !== undefined) {
		set.push("notify = ?");
		vals.push(d.notify);
	}
	if (d.mute_minutes !== undefined) {
		if (d.mute_minutes === 0) set.push("muted_until = NULL");
		else if (d.mute_minutes === -1) set.push("muted_until = '9999-12-31 00:00:00'");
		else {
			set.push("muted_until = NOW() + INTERVAL ? MINUTE");
			vals.push(d.mute_minutes);
		}
	}
	if (d.pinned !== undefined) {
		set.push("pinned = ?");
		vals.push(Number(d.pinned));
	}
	// Приховати можна лише особистий чат — групу чи канал покидають
	if (d.hidden !== undefined) {
		if (m.type !== "direct" && d.hidden) throw httpErr(400, "chat.errors.validation");
		set.push("hidden = ?");
		vals.push(Number(d.hidden));
	}
	if (set.length) await pool.query(`UPDATE ${T.members} SET ${set.join(", ")} WHERE id_room = ? AND id_user = ?`, [...vals, idRoom, uid]);
	realtime.emitToUsers([uid], "chat:room", { id: idRoom });
	return { ok: true };
}

/** В архів (лише власник ручної групи / каналу): історія лишається, писати не можна */
async function archive(uid, idRoom, value) {
	await tx(async (conn) => {
		const m = await membership(idRoom, uid, { conn, lock: true });
		if (m.role !== "owner" || !canManage(m)) throw httpErr(403, "chat.errors.forbidden");
		await conn.query(`UPDATE ${T.rooms} SET archived = ?, date_edit = NOW() WHERE id = ?`, [Number(value), idRoom]);
		await systemMessage(conn, idRoom, { event: value ? "archived" : "unarchived", by: uid });
	});
	await realtime.emitToRoom(idRoom, "chat:room", { id: idRoom });
	return { ok: true };
}

// ═══ АВТОМАТИЧНІ КАНАЛИ ════════════════════════════════

/** Створити / оновити автоматичний канал. Повертає id */
async function ensureAuto(conn, kind, idRef, name, archived) {
	const [r] = await conn.query(
		`INSERT INTO ${T.rooms} (type, kind, id_ref, name, visibility, post_policy, archived, date_add, date_edit)
		 VALUES ('channel', ?, ?, ?, 'private', 'all', ?, NOW(), NOW())
		 ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id),
		                         date_edit = IF(name <=> VALUES(name) AND archived <=> VALUES(archived), date_edit, NOW()),
		                         name = VALUES(name), archived = VALUES(archived)`,
		[kind, idRef, name, Number(archived)]
	);
	return r.insertId;
}

/** Привести склад автоматичного каналу до потрібного. Повертає { added, removed } */
async function setAutoMembers(conn, idRoom, want) {
	const [cur] = await conn.query(`SELECT id_user FROM ${T.members} WHERE id_room = ?`, [idRoom]);
	const have = new Set(cur.map((x) => Number(x.id_user)));
	const wantSet = new Set(want);
	const added = want.filter((u) => !have.has(u));
	const removed = [...have].filter((u) => !wantSet.has(u));
	if (added.length) {
		await conn.query(
			`INSERT IGNORE INTO ${T.members} (id_room, id_user, role, last_read_id, joined_at)
			 SELECT ?, u.id, 'member', COALESCE((SELECT last_message_id FROM ${T.rooms} WHERE id = ?), 0), NOW() FROM ${T.users} u WHERE u.id IN (?)`,
			[idRoom, idRoom, added]
		);
	}
	if (removed.length) await conn.query(`DELETE FROM ${T.members} WHERE id_room = ? AND id_user IN (?)`, [idRoom, removed]);
	return { added, removed };
}

/** Повна синхронізація всіх автоматичних каналів зі структурою компанії */
async function syncAll() {
	const conn = await pool.getConnection();
	const changes = [];
	try {
		const [[lock]] = await conn.query(`SELECT GET_LOCK(?, 0) AS ok`, [AUTO_LOCK]);
		if (!lock || Number(lock.ok) !== 1) return { skipped: true };
		try {
			const [users] = await conn.query(`SELECT id, id_office, id_department FROM ${T.users} WHERE active = 1`);
			const [offices] = await conn.query(`SELECT id, name, status FROM ${T.offices}`);
			const [depts] = await conn.query(`SELECT id, name, status, id_head FROM ${T.depts}`);

			const jobs = [
				{ kind: "announcements", ref: ANNOUNCEMENTS_REF, name: null, archived: false, want: users.map((u) => Number(u.id)) },
				...offices.map((o) => ({ kind: "office", ref: o.id, name: o.name, archived: !o.status, want: o.status ? users.filter((u) => u.id_office === o.id).map((u) => Number(u.id)) : [] })),
				...depts.map((d) => {
					const want = d.status ? users.filter((u) => u.id_department === d.id).map((u) => Number(u.id)) : [];
					if (d.status && d.id_head && users.some((u) => u.id === d.id_head) && !want.includes(Number(d.id_head))) want.push(Number(d.id_head));
					return { kind: "department", ref: d.id, name: d.name, archived: !d.status, want };
				}),
			];

			for (const j of jobs) {
				await conn.beginTransaction();
				try {
					const id = await ensureAuto(conn, j.kind, j.ref, j.name, j.archived);
					const diff = await setAutoMembers(conn, id, j.want);
					await conn.commit();
					if (diff.added.length || diff.removed.length) changes.push({ id, ...diff });
				} catch (e) {
					await conn.rollback();
					logging.error("[chat] sync", j.kind, j.ref, e);
				}
			}

			// Офіс / відділ видалено — канал лишається в архіві з історією, без учасників
			const [orphans] = await conn.query(
				`SELECT r.id FROM ${T.rooms} r
				  WHERE (r.kind = 'office' AND NOT EXISTS (SELECT 1 FROM ${T.offices} o WHERE o.id = r.id_ref))
				     OR (r.kind = 'department' AND NOT EXISTS (SELECT 1 FROM ${T.depts} d WHERE d.id = r.id_ref))`
			);
			for (const o of orphans) {
				await conn.query(`UPDATE ${T.rooms} SET archived = 1 WHERE id = ? AND archived = 0`, [o.id]);
				const diff = await setAutoMembers(conn, o.id, []);
				if (diff.removed.length) changes.push({ id: o.id, ...diff });
			}
		} finally {
			await conn.query(`SELECT RELEASE_LOCK(?)`, [AUTO_LOCK]).catch(() => {});
		}
	} finally {
		conn.release();
	}

	for (const c of changes) {
		realtime.forget(c.id);
		if (c.added.length) realtime.emitToUsers(c.added, "chat:room", { id: c.id });
		if (c.removed.length) realtime.emitToUsers(c.removed, "chat:room:remove", { id: c.id });
	}
	return { changed: changes.length };
}

/** Швидка перевірка для однієї людини (при відкритті чату): її офіс, відділ, оголошення */
async function syncUser(uid) {
	const [[u]] = await pool.query(`SELECT id, active, id_office, id_department FROM ${T.users} WHERE id = ?`, [uid]);
	if (!u || Number(u.active) !== 1) return;
	const want = new Set();
	const [rooms] = await pool.query(
		`SELECT r.id, r.kind, r.id_ref, r.archived FROM ${T.rooms} r
		  WHERE (r.kind = 'announcements')
		     OR (r.kind = 'office' AND r.id_ref = ?)
		     OR (r.kind = 'department' AND (r.id_ref = ? OR r.id_ref IN (SELECT d.id FROM ${T.depts} d WHERE d.id_head = ? AND d.status = 1)))`,
		[u.id_office || 0, u.id_department || 0, uid]
	);
	// Канали ще не створені (новий офіс, перший запуск) — повна синхронізація
	const needOffice = u.id_office && !rooms.some((r) => r.kind === "office" && r.id_ref === u.id_office);
	const needDept = u.id_department && !rooms.some((r) => r.kind === "department" && r.id_ref === u.id_department);
	if (!rooms.some((r) => r.kind === "announcements") || needOffice || needDept) return syncAll();
	rooms.filter((r) => !r.archived).forEach((r) => want.add(r.id));

	const [mine] = await pool.query(`SELECT m.id_room FROM ${T.members} m JOIN ${T.rooms} r ON r.id = m.id_room WHERE m.id_user = ? AND r.kind IN ('office', 'department', 'announcements')`, [uid]);
	const have = new Set(mine.map((x) => x.id_room));
	if ([...want].every((id) => have.has(id)) && [...have].every((id) => want.has(id))) return;
	// Розбіжність (людину перевели, звільнили з відділу тощо) — повна синхронізація, щоб врахувати й керівників відділів
	return syncAll();
}

let timer = null;
/** Фонова синхронізація: за 15 с після запуску і далі кожні 10 хв */
function startAutoSync() {
	if (timer) return;
	const run = () => syncAll().catch((e) => logging.error("[chat] syncAll", e));
	setTimeout(run, 15000).unref();
	timer = setInterval(run, 10 * 60 * 1000);
	timer.unref();
}

module.exports = { list, unreadTotal, get, resolve, people, statuses, openDirect, openNotes, create, update, addMembers, removeMember, setRole, browse, join, settings, archive, syncAll, syncUser, startAutoSync, systemMessage, tx };