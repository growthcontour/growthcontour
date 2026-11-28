"use strict";

/**
 * Чат компанії: опитування, чеклісти, підтвердження ознайомлення, рішення, «поки вас не було».
 *
 * Опитування й чекліст — звичайне текстове повідомлення (body — питання / назва) з data.kind = poll | checklist;
 * варіанти й пункти — у chat_items, голоси — у chat_votes, параметри опитування — у chat_polls.
 * Підтвердження — data.ack = true: кожен учасник, крім автора, натискає «Ознайомлений(-а)» (chat_acks).
 * Рішення — позначка на будь-якому повідомленні (chat_decisions): журнал рішень чату.
 * Зміни приходять подіями chat:poll, chat:checklist, chat:ack, chat:decision без «моїх» позначок —
 * їх клієнт знає зі своїх відповідей API (анонімне опитування не розкриває, хто як голосував).
 */
const { pool, T, httpErr, membership, userName } = require("./common");
const realtime = require("./realtime");

const MAX_OPTIONS = 10;
const MAX_ITEMS = 50;

const parse = (v) => {
	if (v == null || typeof v === "object") return v;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
};
const iso = (s) => (s ? String(s).replace(" ", "T") + "Z" : null);

/** Після вставки повідомлення: варіанти опитування або пункти чекліста (у транзакції надсилання) */
async function create(conn, idMessage, d) {
	if (d.poll) {
		await conn.query(`INSERT INTO ${T.polls} (id_message, multiple, anonymous, closes_at, closed) VALUES (?, ?, ?, ?, 0)`, [
			idMessage,
			Number(!!d.poll.multiple),
			Number(!!d.poll.anonymous),
			d.poll.closes_at ? new Date(d.poll.closes_at).toISOString().slice(0, 19).replace("T", " ") : null,
		]);
		await conn.query(`INSERT INTO ${T.items} (id_message, kind, sort, text) VALUES ?`, [d.poll.options.map((text, i) => [idMessage, "option", i, text])]);
	}
	if (d.checklist) await conn.query(`INSERT INTO ${T.items} (id_message, kind, sort, text) VALUES ?`, [d.checklist.items.map((text, i) => [idMessage, "check", i, text])]);
}

/** Прибрати все інтерактивне з видаленого повідомлення */
async function purge(conn, idMessage) {
	for (const t of [T.votes, T.items, T.polls, T.acks, T.decisions]) await conn.query(`DELETE FROM ${t} WHERE id_message = ?`, [idMessage]);
}

// ─── Дані для показу ───

function pollView(p, options, votes, uid) {
	const closed = !!p.closed || (!!p.closes_at && new Date(iso(p.closes_at)) <= new Date());
	const voters = new Set(votes.map((v) => Number(v.id_user)));
	return {
		multiple: !!p.multiple,
		anonymous: !!p.anonymous,
		closes_at: iso(p.closes_at),
		closed,
		total: voters.size,
		mine: uid ? voters.has(uid) : false,
		options: options.map((o) => {
			const by = votes.filter((v) => Number(v.id_option) === Number(o.id)).map((v) => Number(v.id_user));
			return { id: Number(o.id), text: o.text, count: by.length, mine: uid ? by.includes(uid) : false, voters: p.anonymous ? [] : by };
		}),
	};
}

/**
 * Інтерактивні частини для повідомлень: Map id → { poll?, checklist?, ack?, decision? }.
 * rows — рядки chat_messages (id, id_room, id_user, data, deleted_at); uid — глядач.
 */
async function decorate(rows, uid) {
	const out = new Map();
	const live = rows.filter((r) => !r.deleted_at);
	if (!live.length) return out;
	const get = (id) => out.get(id) || (out.set(id, {}), out.get(id));
	const kinds = new Map();
	live.forEach((r) => {
		const d = parse(r.data) || {};
		if (d.kind === "poll" || d.kind === "checklist" || d.ack) kinds.set(Number(r.id), { kind: d.kind, ack: !!d.ack, row: r });
	});
	const ids = [...kinds.keys()];
	if (ids.length) {
		const pollIds = ids.filter((id) => kinds.get(id).kind === "poll");
		const checkIds = ids.filter((id) => kinds.get(id).kind === "checklist");
		const ackIds = ids.filter((id) => kinds.get(id).ack);
		if (pollIds.length) {
			const [polls] = await pool.query(`SELECT id_message, multiple, anonymous, DATE_FORMAT(closes_at, '%Y-%m-%d %H:%i:%s') AS closes_at, closed FROM ${T.polls} WHERE id_message IN (?)`, [pollIds]);
			const [opts] = await pool.query(`SELECT id, id_message, text FROM ${T.items} WHERE kind = 'option' AND id_message IN (?) ORDER BY sort, id`, [pollIds]);
			const [votes] = await pool.query(`SELECT id_message, id_option, id_user FROM ${T.votes} WHERE id_message IN (?)`, [pollIds]);
			polls.forEach((p) => {
				const id = Number(p.id_message);
				get(id).poll = pollView(
					p,
					opts.filter((o) => Number(o.id_message) === id),
					votes.filter((v) => Number(v.id_message) === id),
					uid
				);
			});
		}
		if (checkIds.length) {
			const [items] = await pool.query(
				`SELECT i.id, i.id_message, i.text, i.done_by, i.done_at, ${userName("u")} AS done_name
				   FROM ${T.items} i LEFT JOIN ${T.users} u ON u.id = i.done_by
				  WHERE i.kind = 'check' AND i.id_message IN (?) ORDER BY i.sort, i.id`,
				[checkIds]
			);
			checkIds.forEach((id) => {
				get(id).checklist = items.filter((i) => Number(i.id_message) === id).map((i) => ({ id: Number(i.id), text: i.text, done: !!i.done_by, done_by: i.done_by ? Number(i.done_by) : null, done_name: i.done_by ? i.done_name : null, done_at: i.done_at }));
			});
		}
		if (ackIds.length) {
			const [ackRows] = await pool.query(`SELECT id_message, COUNT(*) AS n, SUM(id_user = ?) AS mine FROM ${T.acks} WHERE id_message IN (?) GROUP BY id_message`, [uid || 0, ackIds]);
			const byId = new Map(ackRows.map((a) => [Number(a.id_message), a]));
			for (const id of ackIds) {
				const row = kinds.get(id).row;
				// Скільки має підтвердити: учасники чату, крім автора
				const [[m]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.members} WHERE id_room = ? AND NOT (id_user <=> ?)`, [row.id_room, row.id_user]);
				const a = byId.get(id);
				get(id).ack = { count: a ? Number(a.n) : 0, total: Number(m.n), mine: a ? Number(a.mine) > 0 : false };
			}
		}
	}
	const [dec] = await pool.query(`SELECT id_message, id_user, note, date_add FROM ${T.decisions} WHERE id_message IN (?)`, [live.map((r) => r.id)]);
	dec.forEach((x) => (get(Number(x.id_message)).decision = { by: Number(x.id_user), note: x.note, date: x.date_add }));
	return out;
}

// ─── Дії ───

/** Повідомлення з перевіркою, що людина — учасник чату; kind — очікуваний data.kind */
async function message(uid, idMsg, kind, conn = pool) {
	const [[row]] = await conn.query(`SELECT id, id_room, id_thread, id_user, type, data, deleted_at FROM ${T.messages} WHERE id = ?`, [idMsg]);
	if (!row || row.deleted_at) throw httpErr(404, "chat.errors.not_found");
	const m = await membership(row.id_room, uid, { conn });
	const d = parse(row.data) || {};
	if (kind === "ack" ? !d.ack : kind && d.kind !== kind) throw httpErr(404, "chat.errors.not_found");
	return { row, m, d };
}

async function pollOf(idMsg, uid) {
	return (await decorate([{ id: idMsg, data: JSON.stringify({ kind: "poll" }), deleted_at: null }], uid)).get(idMsg).poll;
}
function emitPoll(row, poll) {
	// Без «моїх» позначок: подія одна для всіх
	const shared = Object.assign({}, poll, { mine: undefined, options: poll.options.map((o) => Object.assign({}, o, { mine: undefined })) });
	return realtime.emitToRoom(row.id_room, "chat:poll", { id_message: Number(row.id), id_room: row.id_room, id_thread: row.id_thread, poll: shared });
}

/** Голос: options — id варіантів (порожньо — відкликати голос). Один варіант, якщо опитування не з кількома */
async function vote(uid, idMsg, options) {
	const { row, m } = await message(uid, idMsg, "poll");
	if (m.archived) throw httpErr(403, "chat.errors.cannot_post");
	const [[p]] = await pool.query(`SELECT multiple, closed, closes_at <= UTC_TIMESTAMP() AS expired FROM ${T.polls} WHERE id_message = ?`, [idMsg]);
	if (!p) throw httpErr(404, "chat.errors.not_found");
	if (p.closed || Number(p.expired) === 1) throw httpErr(400, "chat.errors.poll_closed");
	const want = [...new Set((Array.isArray(options) ? options : []).map(Number).filter((x) => x > 0))];
	if (!p.multiple && want.length > 1) throw httpErr(400, "chat.errors.validation", [{ field: "options", message: "one" }]);
	if (want.length) {
		const [ok] = await pool.query(`SELECT id FROM ${T.items} WHERE kind = 'option' AND id_message = ? AND id IN (?)`, [idMsg, want]);
		if (ok.length !== want.length) throw httpErr(400, "chat.errors.validation", [{ field: "options", message: "not found" }]);
	}
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		await conn.query(`DELETE FROM ${T.votes} WHERE id_message = ? AND id_user = ?`, [idMsg, uid]);
		if (want.length) await conn.query(`INSERT INTO ${T.votes} (id_message, id_option, id_user, date_add) VALUES ?`, [want.map((o) => [idMsg, o, uid, new Date()])]);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	const poll = await pollOf(idMsg, uid);
	await emitPoll(row, poll);
	return { poll };
}

/** Завершити опитування: автор або модератор чату */
async function closePoll(uid, idMsg, perms) {
	const { row, m } = await message(uid, idMsg, "poll");
	const mod = perms.moderate || m.role === "owner" || m.role === "admin";
	if (Number(row.id_user) !== uid && !mod) throw httpErr(403, "chat.errors.forbidden");
	await pool.query(`UPDATE ${T.polls} SET closed = 1 WHERE id_message = ?`, [idMsg]);
	const poll = await pollOf(idMsg, uid);
	await emitPoll(row, poll);
	return { poll };
}

/** Опитування, у яких минув час: завершити й повідомити (раз на хвилину) */
async function closeDue() {
	const [rows] = await pool.query(`SELECT p.id_message, m.id_room, m.id_thread FROM ${T.polls} p JOIN ${T.messages} m ON m.id = p.id_message WHERE p.closed = 0 AND p.closes_at <= UTC_TIMESTAMP() LIMIT 100`);
	for (const r of rows) {
		await pool.query(`UPDATE ${T.polls} SET closed = 1 WHERE id_message = ?`, [r.id_message]);
		await emitPoll({ id: r.id_message, id_room: r.id_room, id_thread: r.id_thread }, await pollOf(Number(r.id_message), 0));
	}
	return rows.length;
}

/** Пункт чекліста: виконано / не виконано. Відмічати може будь-хто з учасників (крім архівного чату) */
async function check(uid, idMsg, idItem, done) {
	const { row, m } = await message(uid, idMsg, "checklist");
	if (m.archived) throw httpErr(403, "chat.errors.cannot_post");
	const [r] = await pool.query(
		`UPDATE ${T.items} SET done_by = ?, done_at = ? WHERE id = ? AND id_message = ? AND kind = 'check'`,
		[done ? uid : null, done ? new Date() : null, idItem, idMsg]
	);
	if (!r.affectedRows) throw httpErr(404, "chat.errors.not_found");
	const checklist = (await decorate([{ id: idMsg, data: JSON.stringify({ kind: "checklist" }), deleted_at: null }], uid)).get(idMsg).checklist;
	await realtime.emitToRoom(row.id_room, "chat:checklist", { id_message: idMsg, id_room: row.id_room, id_thread: row.id_thread, checklist });
	return { checklist };
}

/** «Ознайомлений(-а)»: автор підтверджувати не може; повтор нічого не змінює */
async function ack(uid, idMsg) {
	const { row } = await message(uid, idMsg, "ack");
	if (Number(row.id_user) === uid) throw httpErr(400, "chat.errors.validation");
	await pool.query(`INSERT IGNORE INTO ${T.acks} (id_message, id_user, date_add) VALUES (?, ?, NOW())`, [idMsg, uid]);
	const info = (await decorate([row], uid)).get(idMsg).ack;
	await realtime.emitToRoom(row.id_room, "chat:ack", { id_message: idMsg, id_room: row.id_room, id_thread: row.id_thread, count: info.count, total: info.total, id_user: uid });
	return { ack: info };
}

/** Хто підтвердив і хто ще ні */
async function acks(uid, idMsg) {
	const { row } = await message(uid, idMsg, "ack");
	const [rows] = await pool.query(
		`SELECT m.id_user, a.date_add FROM ${T.members} m LEFT JOIN ${T.acks} a ON a.id_message = ? AND a.id_user = m.id_user
		  WHERE m.id_room = ? AND NOT (m.id_user <=> ?)`,
		[idMsg, row.id_room, row.id_user]
	);
	const who = await require("./rooms").people(rows.map((r) => r.id_user));
	const out = { acked: [], pending: [] };
	rows.forEach((r) => (r.date_add ? out.acked : out.pending).push(Object.assign({}, who.get(Number(r.id_user)) || { id: Number(r.id_user) }, { date: r.date_add })));
	return out;
}

/**
 * Позначити рішенням / зняти. Може автор повідомлення, власник чи адміністратор чату, модератор;
 * в особистому чаті й нотатках — будь-хто з учасників.
 */
async function decide(uid, idMsg, value, note, perms) {
	const { row, m } = await message(uid, idMsg, null);
	if (row.type !== "text" && row.type !== "event") throw httpErr(404, "chat.errors.not_found");
	if (m.archived) throw httpErr(403, "chat.errors.cannot_post");
	const allowedTo = m.type === "direct" || m.type === "notes" || Number(row.id_user) === uid || m.role === "owner" || m.role === "admin" || perms.moderate;
	if (!allowedTo) throw httpErr(403, "chat.errors.forbidden");
	const rooms = require("./rooms");
	const sys = await rooms.tx(async (conn) => {
		if (!value) {
			await conn.query(`DELETE FROM ${T.decisions} WHERE id_message = ?`, [idMsg]);
			return null;
		}
		const [r] = await conn.query(
			`INSERT INTO ${T.decisions} (id_message, id_room, id_user, note, date_add) VALUES (?, ?, ?, ?, NOW())
			 ON DUPLICATE KEY UPDATE note = VALUES(note)`,
			[idMsg, row.id_room, uid, note || null]
		);
		// Нове рішення — запис у стрічці (зміна примітки — без нього)
		return r.affectedRows === 1 ? rooms.systemMessage(conn, row.id_room, { event: "decision", by: uid, id_message: idMsg }) : null;
	});
	const decision = value ? { by: uid, note: note || null, date: new Date() } : null;
	await realtime.emitToRoom(row.id_room, "chat:decision", { id_message: idMsg, id_room: row.id_room, id_thread: row.id_thread, decision });
	if (sys) await realtime.emitToRoom(row.id_room, "chat:message", await require("./messages").getOne(uid, sys));
	return { decision };
}

/** Журнал рішень чату (новіші — першими) */
async function decisions(uid, idRoom) {
	await membership(idRoom, uid);
	const [ids] = await pool.query(`SELECT id_message FROM ${T.decisions} WHERE id_room = ? ORDER BY date_add DESC LIMIT 200`, [idRoom]);
	if (!ids.length) return { messages: [] };
	const list = await Promise.all(ids.map((x) => require("./messages").getOne(uid, Number(x.id_message)).catch(() => null)));
	return { messages: list.filter((x) => x && !x.deleted) };
}

/**
 * «Поки вас не було»: що є в непрочитаному (стрічка чату, без тредів).
 * Повертає лічильники і перших авторів — щоб людина вирішила, читати все чи перейти до важливого.
 */
async function catchup(uid, idRoom) {
	const m = await membership(idRoom, uid);
	const since = Number(m.last_read_id);
	const base = `FROM ${T.messages} x WHERE x.id_room = ? AND x.id_thread IS NULL AND x.id > ? AND x.deleted_at IS NULL AND x.type <> 'system' AND NOT (x.id_user <=> ?)`;
	const p = [idRoom, since, uid];
	const [[c]] = await pool.query(
		`SELECT COUNT(*) AS total, SUM(x.has_files) AS files, SUM(x.has_links) AS links, SUM(x.type = 'event') AS events, SUM(x.urgent) AS urgent,
		        SUM(JSON_UNQUOTE(JSON_EXTRACT(x.data, '$.kind')) = 'poll') AS polls,
		        SUM(JSON_UNQUOTE(JSON_EXTRACT(x.data, '$.ack')) = 'true' AND NOT EXISTS (SELECT 1 FROM ${T.acks} a WHERE a.id_message = x.id AND a.id_user = ?)) AS acks,
		        MIN(x.id) AS first_id
		   ${base}`,
		[uid, ...p]
	);
	const [[mn]] = await pool.query(`SELECT COUNT(*) AS n, MIN(x.id) AS first_id ${base} AND EXISTS (SELECT 1 FROM ${T.mentions} mm WHERE mm.id_message = x.id AND mm.id_user = ?)`, [...p, uid]);
	const [[dc]] = await pool.query(`SELECT COUNT(*) AS n, MIN(x.id) AS first_id ${base} AND EXISTS (SELECT 1 FROM ${T.decisions} d WHERE d.id_message = x.id)`, p);
	const [authors] = await pool.query(`SELECT x.id_user, COUNT(*) AS n ${base} AND x.id_user IS NOT NULL GROUP BY x.id_user ORDER BY n DESC LIMIT 3`, p);
	const who = await require("./rooms").people(authors.map((a) => a.id_user));
	const n = (v) => Number(v) || 0;
	return {
		total: n(c.total),
		first_id: c.first_id ? Number(c.first_id) : null,
		files: n(c.files),
		links: n(c.links),
		events: n(c.events),
		urgent: n(c.urgent),
		polls: n(c.polls),
		acks: n(c.acks),
		mentions: n(mn.n),
		first_mention: mn.first_id ? Number(mn.first_id) : null,
		decisions: n(dc.n),
		first_decision: dc.first_id ? Number(dc.first_id) : null,
		authors: authors.map((a) => ({ name: (who.get(Number(a.id_user)) || {}).name || null, count: n(a.n) })),
	};
}

module.exports = { MAX_OPTIONS, MAX_ITEMS, create, purge, decorate, vote, closePoll, closeDue, check, ack, acks, decide, decisions, catchup };