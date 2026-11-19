"use strict";

/**
 * Аналітика чату компанії (сторінка /chat/analytics/, право chat.analytics).
 *
 * Лише зведені цифри: скільки пишуть, хто й де, як швидко відповідають. Тексту повідомлень тут немає,
 * особисті чати в переліку чатів — одним рядком (без того, хто з ким листується), нотатки не враховуються.
 * Період — дати YYYY-MM-DD за часом сервера бази (як і date_add повідомлень); розподіл за годинами
 * віддається погодинно в UTC, а сторінка розкладає його в часовому поясі людини.
 */
const { pool, T, httpErr, userName } = require("./common");

const MAX_DAYS = 366;
// Відповіддю вважаємо повідомлення іншої людини в тому ж чаті не пізніше ніж за 8 год після попереднього
const REPLY_MAX = 8 * 3600;
const FAST = 15 * 60;

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Період із запиту: { from, to, days, prevFrom, prevTo }; за замовчуванням — останні 30 днів */
function period(q = {}) {
	const re = /^\d{4}-\d{2}-\d{2}$/;
	const today = new Date();
	let to = re.test(q.to || "") ? new Date(q.to + "T00:00:00") : today;
	let from = re.test(q.from || "") ? new Date(q.from + "T00:00:00") : new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);
	if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) throw httpErr(400, "chat.errors.validation", [{ field: "from", message: "invalid" }]);
	if (from > to) [from, to] = [to, from];
	const days = Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 864e5) + 1;
	if (days > MAX_DAYS) throw httpErr(400, "chat.errors.analytics_period");
	const prevTo = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1);
	const prevFrom = new Date(prevTo.getFullYear(), prevTo.getMonth(), prevTo.getDate() - (days - 1));
	return { from: ymd(from), to: ymd(to), days, prevFrom: ymd(prevFrom), prevTo: ymd(prevTo) };
}

const IN_PERIOD = "x.date_add >= ? AND x.date_add < ? + INTERVAL 1 DAY AND x.deleted_at IS NULL AND r.type <> 'notes'";

async function totals(from, to) {
	const [[c]] = await pool.query(
		`SELECT SUM(x.type = 'text') AS messages,
		        COUNT(DISTINCT CASE WHEN x.type = 'text' THEN x.id_user END) AS people,
		        COUNT(DISTINCT CASE WHEN x.type = 'text' THEN x.id_room END) AS chats,
		        SUM(x.type = 'text' AND x.id_thread IS NOT NULL) AS thread_replies,
		        SUM(x.type = 'text' AND x.has_files = 1) AS files,
		        SUM(x.urgent) AS urgent,
		        SUM(x.type = 'event') AS events,
		        SUM(x.type = 'system' AND JSON_UNQUOTE(JSON_EXTRACT(x.data, '$.event')) = 'task') AS tasks
		   FROM ${T.messages} x JOIN ${T.rooms} r ON r.id = x.id_room
		  WHERE ${IN_PERIOD}`,
		[from, to]
	);
	const [[p]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.polls} p JOIN ${T.messages} x ON x.id = p.id_message JOIN ${T.rooms} r ON r.id = x.id_room WHERE ${IN_PERIOD}`, [from, to]);
	const [[d]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.decisions} d WHERE d.date_add >= ? AND d.date_add < ? + INTERVAL 1 DAY`, [from, to]);
	const resp = (await responses(from, to, "total"))[0] || {};
	const n = (v) => Number(v) || 0;
	return {
		messages: n(c.messages),
		people: n(c.people),
		chats: n(c.chats),
		thread_replies: n(c.thread_replies),
		files: n(c.files),
		urgent: n(c.urgent),
		events: n(c.events),
		tasks: n(c.tasks),
		polls: n(p.n),
		decisions: n(d.n),
		reply_avg: resp.n ? Math.round(n(resp.avg_s)) : null,
		reply_fast: resp.n ? Math.round((n(resp.fast) / n(resp.n)) * 100) : null,
		replies: n(resp.n),
	};
}

/**
 * Час відповіді: для кожного повідомлення стрічки (особисті чати й групи) — скільки минуло від попереднього
 * повідомлення іншої людини в тому ж чаті. by: total | room | user (хто відповідав).
 */
async function responses(from, to, by) {
	const group = by === "room" ? "t.id_room" : by === "user" ? "t.id_user" : null;
	const [rows] = await pool.query(
		`SELECT ${group ? group + " AS k," : ""} AVG(t.gap) AS avg_s, SUM(t.gap <= ${FAST}) AS fast, COUNT(*) AS n
		   FROM (SELECT x.id_room, x.id_user,
		                TIMESTAMPDIFF(SECOND, LAG(x.date_add) OVER w, x.date_add) AS gap,
		                LAG(x.id_user) OVER w AS prev_user
		           FROM ${T.messages} x JOIN ${T.rooms} r ON r.id = x.id_room
		          WHERE ${IN_PERIOD} AND x.type = 'text' AND x.id_thread IS NULL AND r.type IN ('direct', 'group')
		         WINDOW w AS (PARTITION BY x.id_room ORDER BY x.id)) t
		  WHERE t.prev_user IS NOT NULL AND t.prev_user <> t.id_user AND t.gap <= ${REPLY_MAX}
		  ${group ? "GROUP BY " + group : ""}`,
		[from, to]
	);
	return rows;
}

const delta = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : cur ? null : 0);

/** Головні показники з порівнянням із попереднім періодом такої ж довжини */
async function summary(q) {
	const p = period(q);
	const [cur, prev] = await Promise.all([totals(p.from, p.to), totals(p.prevFrom, p.prevTo)]);
	const d = {};
	["messages", "people", "chats", "thread_replies"].forEach((k) => (d[k] = delta(cur[k], prev[k])));
	// Час відповіді: менше — краще; знак показує зміну самого значення
	d.reply_avg = cur.reply_avg != null && prev.reply_avg ? delta(cur.reply_avg, prev.reply_avg) : null;
	return { period: p, current: cur, previous: prev, delta: d };
}

/** Повідомлення й події погодинно (UTC, Unix-час початку години) — сторінка розкладає по днях і годинах у своєму поясі */
async function hours(q) {
	const p = period(q);
	const [rows] = await pool.query(
		`SELECT FLOOR(UNIX_TIMESTAMP(x.date_add) / 3600) * 3600 AS h, SUM(x.type = 'text') AS messages, SUM(x.type = 'event') AS events
		   FROM ${T.messages} x JOIN ${T.rooms} r ON r.id = x.id_room
		  WHERE ${IN_PERIOD} AND x.type IN ('text', 'event')
		  GROUP BY h ORDER BY h`,
		[p.from, p.to]
	);
	return { period: p, hours: rows.map((r) => [Number(r.h), Number(r.messages) || 0, Number(r.events) || 0]) };
}

/** Чати: групи й канали поіменно, особисті — одним рядком */
async function rooms(q) {
	const p = period(q);
	const [rows] = await pool.query(
		`SELECT IF(r.type = 'direct', 0, r.id) AS id, MAX(r.type) AS type, MAX(r.kind) AS kind, MAX(r.name) AS name, MAX(r.code) AS code,
		        COUNT(DISTINCT r.id) AS rooms,
		        SUM(x.type = 'text') AS messages, COUNT(DISTINCT CASE WHEN x.type = 'text' THEN x.id_user END) AS people,
		        SUM(x.type = 'text' AND x.id_thread IS NOT NULL) AS thread_replies, SUM(x.type = 'event') AS events,
		        MAX(x.date_add) AS last_at
		   FROM ${T.messages} x JOIN ${T.rooms} r ON r.id = x.id_room
		  WHERE ${IN_PERIOD} AND x.type IN ('text', 'event')
		  GROUP BY IF(r.type = 'direct', 0, r.id)
		  ORDER BY messages DESC
		  LIMIT 500`,
		[p.from, p.to]
	);
	const ids = rows.filter((r) => r.id).map((r) => r.id);
	const members = new Map();
	if (ids.length) {
		const [m] = await pool.query(`SELECT id_room, COUNT(*) AS n FROM ${T.members} WHERE id_room IN (?) GROUP BY id_room`, [ids]);
		m.forEach((x) => members.set(x.id_room, Number(x.n)));
	}
	const resp = new Map((await responses(p.from, p.to, "room")).map((r) => [Number(r.k), r]));
	// Час відповіді особистих чатів — разом
	const direct = { s: 0, n: 0, fast: 0 };
	if (rows.some((r) => !r.id)) {
		const [dr] = await pool.query(`SELECT id FROM ${T.rooms} WHERE type = 'direct' AND id IN (?)`, [[...resp.keys(), 0]]);
		dr.forEach((x) => {
			const r = resp.get(Number(x.id));
			direct.s += Number(r.avg_s) * Number(r.n);
			direct.n += Number(r.n);
			direct.fast += Number(r.fast);
		});
	}
	return {
		period: p,
		rooms: rows.map((r) => {
			const rs = r.id ? resp.get(Number(r.id)) : direct.n ? { avg_s: direct.s / direct.n, fast: direct.fast, n: direct.n } : null;
			return {
				id: r.id || null,
				code: r.id ? r.code : null,
				type: r.id ? r.type : "direct",
				kind: r.id ? r.kind : "manual",
				name: r.id ? r.name : null,
				rooms: Number(r.rooms),
				members: r.id ? members.get(r.id) || 0 : null,
				messages: Number(r.messages) || 0,
				people: Number(r.people) || 0,
				thread_replies: Number(r.thread_replies) || 0,
				events: Number(r.events) || 0,
				last_at: r.last_at,
				reply_avg: rs && Number(rs.n) ? Math.round(Number(rs.avg_s)) : null,
				reply_fast: rs && Number(rs.n) ? Math.round((Number(rs.fast) / Number(rs.n)) * 100) : null,
			};
		}),
	};
}

/** Люди: скільки пишуть, у скількох чатах, реакції, як швидко відповідають */
async function people(q) {
	const p = period(q);
	const [rows] = await pool.query(
		`SELECT x.id_user, SUM(x.id_thread IS NULL) AS messages, SUM(x.id_thread IS NOT NULL) AS thread_replies,
		        COUNT(DISTINCT x.id_room) AS chats, SUM(x.has_files) AS files, MAX(x.date_add) AS last_at
		   FROM ${T.messages} x JOIN ${T.rooms} r ON r.id = x.id_room
		  WHERE ${IN_PERIOD} AND x.type = 'text' AND x.id_user IS NOT NULL
		  GROUP BY x.id_user
		  ORDER BY COUNT(*) DESC
		  LIMIT 1000`,
		[p.from, p.to]
	);
	if (!rows.length) return { period: p, people: [] };
	const ids = rows.map((r) => r.id_user);
	const [users] = await pool.query(
		`SELECT u.id, ${userName("u")} AS name, u.position, d.name AS department, o.name AS office
		   FROM ${T.users} u LEFT JOIN ${T.depts} d ON d.id = u.id_department LEFT JOIN ${T.offices} o ON o.id = u.id_office
		  WHERE u.id IN (?)`,
		[ids]
	);
	const who = new Map(users.map((u) => [Number(u.id), u]));
	const [reacts] = await pool.query(`SELECT id_user, COUNT(*) AS n FROM ${T.reactions} WHERE date_add >= ? AND date_add < ? + INTERVAL 1 DAY AND id_user IN (?) GROUP BY id_user`, [p.from, p.to, ids]);
	const rc = new Map(reacts.map((r) => [Number(r.id_user), Number(r.n)]));
	const resp = new Map((await responses(p.from, p.to, "user")).map((r) => [Number(r.k), r]));
	return {
		period: p,
		people: rows.map((r) => {
			const u = who.get(Number(r.id_user)) || {};
			const rs = resp.get(Number(r.id_user));
			return {
				id: Number(r.id_user),
				name: u.name || null,
				position: u.position || null,
				department: u.department || null,
				office: u.office || null,
				messages: Number(r.messages) || 0,
				thread_replies: Number(r.thread_replies) || 0,
				chats: Number(r.chats) || 0,
				files: Number(r.files) || 0,
				reactions: rc.get(Number(r.id_user)) || 0,
				last_at: r.last_at,
				reply_avg: rs && Number(rs.n) ? Math.round(Number(rs.avg_s)) : null,
				replies: rs ? Number(rs.n) : 0,
			};
		}),
	};
}

module.exports = { period, summary, hours, rooms, people };