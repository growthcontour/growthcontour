"use strict";

/** Чат компанії: спільне — таблиці, помилки, доступ до чату */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;

const T = {
	rooms: `${P}chat_rooms`,
	members: `${P}chat_members`,
	messages: `${P}chat_messages`,
	files: `${P}chat_files`,
	status: `${P}chat_user_status`,
	threads: `${P}chat_threads`,
	reactions: `${P}chat_reactions`,
	mentions: `${P}chat_mentions`,
	pins: `${P}chat_pins`,
	scheduled: `${P}chat_scheduled`,
	reminders: `${P}chat_reminders`,
	urgent: `${P}chat_urgent`,
	records: `${P}chat_records`,
	subs: `${P}chat_subscriptions`,
	polls: `${P}chat_polls`,
	items: `${P}chat_items`,
	votes: `${P}chat_votes`,
	acks: `${P}chat_acks`,
	decisions: `${P}chat_decisions`,
	users: `${P}users`,
	offices: `${P}company_offices`,
	depts: `${P}company_departments`,
};

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

/** Ім'я користувача для SQL: «Ім'я Прізвище», інакше email */
const userName = (a) => `COALESCE(NULLIF(TRIM(CONCAT_WS(' ', ${a}.first_name, ${a}.last_name)), ''), ${a}.email)`;

const avatarUrl = (id, file) => (file ? `/uploads/users/${Number(id)}/${encodeURIComponent(file)}` : null);

/**
 * Учасник чату або 404 (чужий чат не видаємо навіть фактом існування).
 * conn — щоб читати в тій самій транзакції; lock — FOR UPDATE.
 */
async function membership(idRoom, idUser, { conn = pool, lock = false } = {}) {
	const [[row]] = await conn.query(
		`SELECT r.id, r.code, r.type, r.kind, r.id_ref, r.name, r.visibility, r.post_policy, r.archived, r.id_owner,
		        m.role, m.last_read_id, m.notify, m.muted_until
		   FROM ${T.rooms} r
		   JOIN ${T.members} m ON m.id_room = r.id AND m.id_user = ?
		  WHERE r.id = ? ${lock ? "FOR UPDATE" : ""}`,
		[idUser, idRoom]
	);
	if (!row) throw httpErr(404, "chat.errors.not_found");
	return row;
}

/** Посилання на чат / повідомлення: у адресі — випадковий код чату, а не його номер */
const roomLink = (code, idMessage = null) => `/chat/?room=${encodeURIComponent(String(code || ""))}${idMessage ? "&message=" + Number(idMessage) : ""}`;

/** Хто може керувати чатом (назва, учасники): власник і адміністратори групи / каналу */
const canManage = (m) => (m.type === "group" || m.type === "channel") && m.kind === "manual" && (m.role === "owner" || m.role === "admin");

/**
 * Хто може писати. Канал оголошень — лише з правом chat.announcements (add);
 * канал із post_policy = admins — лише власник і адміністратори; архівний — ніхто.
 */
function canPost(m, perms) {
	if (m.archived) return false;
	if (m.kind === "announcements") return !!perms.announce;
	if (m.post_policy === "admins") return m.role === "owner" || m.role === "admin";
	return true;
}

/**
 * Коментувати (відповідати в треді) у каналі оголошень може кожен учасник —
 * писати нові оголошення лише з правом chat.announcements. Так канал оголошень стає «пульсом компанії».
 */
const canComment = (m) => !m.archived && m.kind === "announcements";

/** Активні користувачі (active = 1) з переліку */
async function activeUsers(ids, conn = pool) {
	const list = [...new Set(ids.map(Number).filter((x) => Number.isInteger(x) && x > 0))];
	if (!list.length) return [];
	const [rows] = await conn.query(`SELECT id FROM ${T.users} WHERE id IN (?) AND active = 1`, [list]);
	return rows.map((r) => Number(r.id));
}

/**
 * Права людини (як req.user.permissions): { slug: { view, add, edit, delete } }.
 * Потрібні там, де немає запиту: картки записів для кожного глядача, відкладене надсилання, події системи.
 * Короткий кеш — права змінюються рідко, а картки показуються часто.
 */
const PERM_TTL = 30000;
const permCache = new Map();
async function permissions(uid) {
	const id = Number(uid);
	const hit = permCache.get(id);
	if (hit && hit.at > Date.now() - PERM_TTL) return hit.perms;
	const [rows] = await pool.query(
		`SELECT p.slug, MAX(g.can_view) AS v, MAX(g.can_add) AS a, MAX(g.can_edit) AS e, MAX(g.can_delete) AS d
		   FROM ${P}users_to_groups ug
		   JOIN ${P}users_groups_permissions g ON g.id_group = ug.id_group
		   JOIN ${P}users_permissions_pages p ON p.id = g.id_page
		  WHERE ug.id_user = ?
		  GROUP BY p.slug`,
		[id]
	);
	const perms = {};
	rows.forEach((r) => (perms[r.slug] = { view: Number(r.v) === 1, add: Number(r.a) === 1, edit: Number(r.e) === 1, delete: Number(r.d) === 1 }));
	if (permCache.size > 2000) permCache.clear();
	permCache.set(id, { at: Date.now(), perms });
	return perms;
}
const allowed = (perms, slug, action = "view") => !!(perms && perms[slug] && perms[slug][action]);

/** Права в чаті (те саме, що perms(req) у маршрутах) — з прав людини */
const chatPerms = (perms) => ({
	view: allowed(perms, "chat"),
	create: allowed(perms, "chat", "add"),
	moderate: allowed(perms, "chat", "delete"),
	mentionAll: allowed(perms, "chat", "edit"),
	announce: allowed(perms, "chat.announcements", "add"),
});

module.exports = { pool, P, T, httpErr, userName, avatarUrl, membership, roomLink, canManage, canPost, canComment, activeUsers, permissions, allowed, chatPerms };