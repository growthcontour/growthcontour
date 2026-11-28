"use strict";

/**
 * Згадки в повідомленнях. У тексті зберігаються як токени (їх ставить поле вводу через підказку «@»):
 *   @[Ім'я](u:12)  — людина      @[Відділ](d:5) — усі з відділу
 *   @[Офіс](o:3)   — усі з офісу  @[всі](all)    — усі учасники чату
 * Розгортаються лише до учасників цього чату. @всі — власник / адміністратор чату або право chat (edit).
 */
const { pool, T, httpErr, userName } = require("./common");

const TOKEN = /@\[([^\]\n]{1,100})\]\((?:(u|d|o):(\d{1,10})|(all))\)/g;

function parse(body) {
	const out = [];
	if (!body) return out;
	for (const m of String(body).matchAll(TOKEN)) out.push(m[4] ? { kind: "all" } : { kind: { u: "user", d: "department", o: "office" }[m[2]], id: Number(m[3]) });
	return out;
}

/** Хто згаданий: [{ id_user, kind }] — лише учасники чату, без автора */
async function expand(conn, room, uid, body, perms) {
	const refs = parse(body);
	if (!refs.length) return [];
	const [members] = await conn.query(`SELECT m.id_user, u.id_office, u.id_department FROM ${T.members} m JOIN ${T.users} u ON u.id = m.id_user AND u.active = 1 WHERE m.id_room = ?`, [room.id]);
	const out = new Map();
	const add = (id, kind) => {
		if (id !== uid && !out.has(id)) out.set(id, kind);
	};
	for (const r of refs) {
		if (r.kind === "all") {
			const allowed = room.role === "owner" || room.role === "admin" || room.type === "direct" || perms.mentionAll;
			if (!allowed) throw httpErr(403, "chat.errors.mention_all");
			members.forEach((m) => add(Number(m.id_user), "all"));
		} else if (r.kind === "user") {
			if (members.some((m) => Number(m.id_user) === r.id)) add(r.id, "user");
		} else if (r.kind === "department") {
			members.filter((m) => m.id_department === r.id).forEach((m) => add(Number(m.id_user), "department"));
		} else if (r.kind === "office") {
			members.filter((m) => m.id_office === r.id).forEach((m) => add(Number(m.id_user), "office"));
		}
	}
	return [...out].map(([id_user, kind]) => ({ id_user, kind }));
}

async function save(conn, idMessage, list) {
	await conn.query(`DELETE FROM ${T.mentions} WHERE id_message = ?`, [idMessage]);
	if (list.length) await conn.query(`INSERT INTO ${T.mentions} (id_message, id_user, kind) VALUES ?`, [list.map((x) => [idMessage, x.id_user, x.kind])]);
}

/** Підказка «@»: учасники чату, їхні відділи й офіси, «всі» */
async function suggestions(room, uid, perms) {
	const [rows] = await pool.query(
		`SELECT u.id, ${userName("u")} AS name, u.avatar, u.position, u.id_department, d.name AS department, u.id_office, o.name AS office
		   FROM ${T.members} m
		   JOIN ${T.users} u ON u.id = m.id_user AND u.active = 1
		   LEFT JOIN ${T.depts} d ON d.id = u.id_department
		   LEFT JOIN ${T.offices} o ON o.id = u.id_office
		  WHERE m.id_room = ? AND u.id <> ?
		  ORDER BY u.last_name, u.first_name`,
		[room.id, uid]
	);
	const depts = new Map();
	const offices = new Map();
	rows.forEach((r) => {
		if (r.id_department) depts.set(r.id_department, r.department);
		if (r.id_office) offices.set(r.id_office, r.office);
	});
	return {
		people: rows.map((r) => ({ id: Number(r.id), name: r.name, position: r.position, avatar: r.avatar ? `/uploads/users/${Number(r.id)}/${encodeURIComponent(r.avatar)}` : null })),
		departments: room.type === "direct" ? [] : [...depts].map(([id, name]) => ({ id, name })),
		offices: room.type === "direct" ? [] : [...offices].map(([id, name]) => ({ id, name })),
		all: room.type !== "direct" && (room.role === "owner" || room.role === "admin" || !!perms.mentionAll),
	};
}

/** Текст без токенів: «@Ім'я» (для сповіщень і прев'ю) */
const plain = (body) => String(body || "").replace(TOKEN, (m, name) => "@" + name);

module.exports = { parse, expand, save, suggestions, plain };