"use strict";

/**
 * Чат компанії: повідомлення.
 *   стрічка чату, треди, надсилання (згадки, термінові), редагування, видалення, пересилання,
 *   прочитання, «хто прочитав», реакції, закріплені, чернетки, пошук.
 * Відповіді в треді (id_thread) у загальну стрічку не потрапляють і не рахуються як непрочитані чату —
 * про них знають учасники треду (chat_threads).
 */
const { pool, T, httpErr, userName, membership, roomLink, canPost, canComment } = require("./common");
const rooms = require("./rooms");
const files = require("./files");
const realtime = require("./realtime");
const mentions = require("./mentions");
const notify = require("./notify");
const records = require("./records");
const interactive = require("./interactive");
const logging = require("../../logging/logging");

const PAGE = 50;
// Реакції: різних емодзі на повідомленні / своїх на одному повідомленні
const MAX_REACTIONS = 10;
const MAX_MY_REACTIONS = 3;
const LINK_RE = /\bhttps?:\/\/[^\s<>"']+/i;
// Реакція — один емодзі (з модифікаторами й ZWJ), до 32 байтів
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Emoji_Component}‍️\p{Regional_Indicator}]*$/u;

const parse = (v) => {
	if (v == null || typeof v === "object") return v;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
};

// data без службового (records віддаємо картками окремо)
function publicData(d) {
	if (!d || typeof d !== "object") return d;
	const out = Object.assign({}, d);
	delete out.records;
	delete out.attached;
	return Object.keys(out).length ? out : null;
}
// Повідомлення, з якими можна працювати (реакції, тред, нагадування, задача): текст і подія системи
const ACTIVE = new Set(["text", "event"]);

const SELECT = `SELECT m.id, m.id_room, m.id_thread, m.id_user, m.type, m.body, m.data, m.id_reply, m.id_forward, m.has_files,
                       m.thread_count, m.thread_last_at, m.urgent, m.edited_at, m.deleted_at, m.date_add
                  FROM ${T.messages} m`;

/** Повідомлення у вигляді для клієнта: файли, цитата, автор, реакції, згадка мене, закріплене, тред */
async function hydrate(rows, uid) {
	if (!rows.length) return [];
	const ids = rows.map((r) => r.id);
	const replyIds = [...new Set(rows.map((r) => r.id_reply).filter(Boolean))];
	const [fileRows, replyRows, reactRows, mentionRows, pinRows] = await Promise.all([
		files.forMessages(ids),
		replyIds.length ? pool.query(`SELECT id, id_user, LEFT(body, 300) AS body, has_files, deleted_at FROM ${T.messages} WHERE id IN (?)`, [replyIds]).then((r) => r[0]) : [],
		pool.query(`SELECT id_message, emoji, id_user FROM ${T.reactions} WHERE id_message IN (?) ORDER BY date_add`, [ids]).then((r) => r[0]),
		pool.query(`SELECT id_message FROM ${T.mentions} WHERE id_message IN (?) AND id_user = ?`, [ids, uid || 0]).then((r) => r[0]),
		pool.query(`SELECT id_message FROM ${T.pins} WHERE id_message IN (?)`, [ids]).then((r) => r[0]),
	]);
	const authors = await rooms.people([...rows.map((r) => r.id_user), ...replyRows.map((r) => r.id_user)].filter(Boolean));
	const replies = new Map(
		replyRows.map((r) => [
			Number(r.id),
			{ id: Number(r.id), id_user: r.id_user, author: r.id_user ? (authors.get(Number(r.id_user)) || {}).name || null : null, body: r.deleted_at ? null : r.body, has_files: !!r.has_files, deleted: !!r.deleted_at },
		])
	);
	const reactions = new Map();
	reactRows.forEach((r) => {
		const k = Number(r.id_message);
		if (!reactions.has(k)) reactions.set(k, new Map());
		const byEmoji = reactions.get(k);
		if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
		byEmoji.get(r.emoji).push(Number(r.id_user));
	});
	const mentioned = new Set(mentionRows.map((r) => Number(r.id_message)));
	// Картки записів — з правами глядача
	const refs = [];
	rows.forEach((r) => {
		const d = r.deleted_at ? null : parse(r.data);
		if (d && Array.isArray(d.records)) refs.push(...d.records);
	});
	const cardMap = refs.length ? await records.cards(uid, refs) : new Map();
	// Опитування, чеклісти, підтвердження, рішення
	const extra = await interactive.decorate(rows, uid);
	const pinned = new Set(pinRows.map((r) => Number(r.id_message)));

	return rows.map((r) => {
		const deleted = !!r.deleted_at;
		const a = r.id_user ? authors.get(Number(r.id_user)) : null;
		const re = reactions.get(Number(r.id));
		return {
			id: Number(r.id),
			id_room: r.id_room,
			id_thread: r.id_thread ? Number(r.id_thread) : null,
			id_user: r.id_user,
			author: a ? { id: a.id, name: a.name, avatar: a.avatar } : null,
			type: r.type,
			body: deleted ? null : r.body,
			data: deleted ? null : publicData(parse(r.data)),
			records: deleted ? [] : ((parse(r.data) || {}).records || []).map((x) => cardMap.get(x.type + ":" + x.id) || { type: x.type, id: x.id, missing: true }),
			reply: r.id_reply ? replies.get(Number(r.id_reply)) || { id: Number(r.id_reply), deleted: true } : null,
			forwarded: !!r.id_forward,
			files: deleted ? [] : fileRows.get(Number(r.id)) || [],
			reactions: deleted || !re ? [] : [...re].map(([emoji, users]) => ({ emoji, count: users.length, mine: users.includes(uid), users })),
			thread: r.thread_count ? { count: Number(r.thread_count), last_at: r.thread_last_at } : null,
			urgent: !!r.urgent,
			mentioned: mentioned.has(Number(r.id)),
			pinned: pinned.has(Number(r.id)),
			edited_at: r.edited_at,
			deleted,
			date: r.date_add,
			poll: (extra.get(Number(r.id)) || {}).poll || null,
			checklist: (extra.get(Number(r.id)) || {}).checklist || null,
			ack: (extra.get(Number(r.id)) || {}).ack || null,
			decision: (extra.get(Number(r.id)) || {}).decision || null,
		};
	});
}

/**
 * Розіслати повідомлення учасникам. Без карток — одна подія на всіх;
 * з картками записів — кожному власну (картку кожен бачить зі своїми правами).
 */
async function broadcast(idRoom, event, msg) {
	const refs = (msg.records || []).map((r) => ({ type: r.type, id: r.id }));
	if (!refs.length) return realtime.emitToRoom(idRoom, event, msg);
	const ids = await realtime.roomMembers(idRoom);
	const per = await records.cardsMany(ids, refs);
	for (const u of ids) {
		const v = per.get(u) || new Map();
		realtime.emitToUsers([u], event, Object.assign({}, msg, { records: refs.map((r) => v.get(r.type + ":" + r.id) || { type: r.type, id: r.id, missing: true }) }));
	}
}

/**
 * Стрічка чату (без відповідей у тредах). before / after / around — як у сторінках.
 * around на відповідь у треді — показуємо перше повідомлення треду і повертаємо open_thread.
 */
async function history(uid, idRoom, { before, after, around, limit } = {}) {
	const m = await membership(idRoom, uid);
	const n = Math.min(Math.max(parseInt(limit, 10) || PAGE, 1), 100);
	const MAIN = "m.id_room = ? AND m.id_thread IS NULL";
	let rows;
	let more = { older: false, newer: false };
	let openThread = null;
	if (around) {
		const [[target]] = await pool.query(`SELECT id_thread FROM ${T.messages} WHERE id = ? AND id_room = ?`, [around, idRoom]);
		if (target && target.id_thread) {
			openThread = { id_thread: Number(target.id_thread), id_message: around };
			around = Number(target.id_thread);
		}
		const half = Math.floor(n / 2);
		const [older] = await pool.query(`${SELECT} WHERE ${MAIN} AND m.id <= ? ORDER BY m.id DESC LIMIT ?`, [idRoom, around, half + 1]);
		const [newer] = await pool.query(`${SELECT} WHERE ${MAIN} AND m.id > ? ORDER BY m.id ASC LIMIT ?`, [idRoom, around, half + 1]);
		more = { older: older.length > half, newer: newer.length > half };
		rows = older.slice(0, half).reverse().concat(newer.slice(0, half));
	} else if (after) {
		const [r] = await pool.query(`${SELECT} WHERE ${MAIN} AND m.id > ? ORDER BY m.id ASC LIMIT ?`, [idRoom, after, n + 1]);
		more.newer = r.length > n;
		rows = r.slice(0, n);
	} else {
		const [r] = await pool.query(`${SELECT} WHERE ${MAIN} ${before ? "AND m.id < ?" : ""} ORDER BY m.id DESC LIMIT ?`, before ? [idRoom, before, n + 1] : [idRoom, n + 1]);
		more.older = r.length > n;
		rows = r.slice(0, n).reverse();
	}
	return { messages: await hydrate(rows, uid), more, last_read_id: Number(m.last_read_id), open_thread: openThread };
}

/** Тред: перше повідомлення й відповіді (до 200 останніх) */
/**
 * Тред: перше повідомлення й відповіді сторінками по PAGE (останні). before — старіші за цей id
 * (дозавантаження при прокрутці вгору, як у стрічці чату).
 */
async function thread(uid, idThread, { before = null } = {}) {
	const [[root]] = await pool.query(`${SELECT} WHERE m.id = ?`, [idThread]);
	if (!root || root.id_thread) throw httpErr(404, "chat.errors.not_found");
	await membership(root.id_room, uid);
	const [replies] = await pool.query(`${SELECT} WHERE m.id_thread = ? ${before ? "AND m.id < ?" : ""} ORDER BY m.id DESC LIMIT ?`, before ? [idThread, before, PAGE + 1] : [idThread, PAGE + 1]);
	const [[me]] = await pool.query(`SELECT last_read_id FROM ${T.threads} WHERE id_thread = ? AND id_user = ?`, [idThread, uid]);
	const list = await hydrate([root, ...replies.slice(0, PAGE).reverse()], uid);
	return { root: list[0], replies: list.slice(1), more: replies.length > PAGE, last_read_id: me ? Number(me.last_read_id) : 0, following: !!me };
}

/** Одне повідомлення (з перевіркою доступу) */
async function getOne(uid, idMsg) {
	const [[row]] = await pool.query(`${SELECT} WHERE m.id = ?`, [idMsg]);
	if (!row) throw httpErr(404, "chat.errors.not_found");
	await membership(row.id_room, uid);
	return (await hydrate([row], uid))[0];
}

/**
 * Надіслати. client_id — повтор після обриву зв'язку не створить дубль.
 * Файли — завантажені в цей чат цим користувачем і ще не надіслані.
 * d.id_thread — відповідь у треді; d.urgent — термінове (ліміт на добу).
 */
async function send(uid, idRoom, d, perms, { forwardOf = null } = {}) {
	const result = await rooms.tx(async (conn) => {
		const m = await membership(idRoom, uid, { conn, lock: true });
		// Відповідь у треді каналу оголошень — кожному; решта — за правом писати в чат
		if (!canPost(m, perms) && !(d.id_thread && canComment(m))) throw httpErr(403, "chat.errors.cannot_post");

		if (d.client_id) {
			const [[dup]] = await conn.query(`SELECT id FROM ${T.messages} WHERE id_user = ? AND client_id = ?`, [uid, d.client_id]);
			if (dup) return { id: Number(dup.id), duplicate: true };
		}
		const idThread = d.id_thread || null;
		if (idThread) {
			const [[root]] = await conn.query(`SELECT id, id_thread, type, deleted_at FROM ${T.messages} WHERE id = ? AND id_room = ? FOR UPDATE`, [idThread, idRoom]);
			if (!root || root.id_thread || !ACTIVE.has(root.type)) throw httpErr(400, "chat.errors.validation", [{ field: "id_thread", message: "not found" }]);
		}
		if (d.id_reply) {
			const [[rep]] = await conn.query(`SELECT id FROM ${T.messages} WHERE id = ? AND id_room = ?`, [d.id_reply, idRoom]);
			if (!rep) throw httpErr(400, "chat.errors.validation", [{ field: "id_reply", message: "not found" }]);
		}
		if (d.files.length && !forwardOf) {
			const [own] = await conn.query(`SELECT id FROM ${T.files} WHERE id IN (?) AND id_room = ? AND id_user = ? AND id_message IS NULL FOR UPDATE`, [d.files, idRoom, uid]);
			if (own.length !== d.files.length) throw httpErr(400, "chat.errors.validation", [{ field: "files", message: "not found" }]);
		}
		const urgent = !!d.urgent && m.type !== "notes";
		if (urgent && (await notify.urgentLeft(uid, conn)) < 1) throw httpErr(429, "chat.errors.urgent_limit");
		const mentioned = await mentions.expand(conn, m, uid, d.body, perms);

		const recs = records.merge(d.records, d.body);
		// Явно додані картки — лише ті записи, які автор бачить сам (посилання в тексті кожен і так бачить зі своїми правами)
		if (d.records && d.records.length && !(await records.canSee(uid, records.clean(d.records)))) throw httpErr(403, "chat.errors.record_denied");
		// attached — додані вручну (лишаються після правки тексту), records — усі картки разом зі знайденими в тексті
		const attached = records.clean(d.records);
		// Опитування / чекліст / «потрібне підтвердження» (у нотатках підтверджувати нікому)
		const kind = d.poll ? "poll" : d.checklist ? "checklist" : null;
		const ack = !!d.ack && m.type !== "notes";
		const parts = Object.assign({}, forwardOf ? { forward: forwardOf } : {}, recs.length ? { records: recs } : {}, attached.length ? { attached } : {}, kind ? { kind } : {}, ack ? { ack: true } : {});
		const data = Object.keys(parts).length ? parts : null;
		const [r] = await conn.query(
			`INSERT INTO ${T.messages} (id_room, id_thread, id_user, type, body, data, id_reply, id_forward, has_files, has_links, urgent, client_id, date_add)
			 VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`,
			[idRoom, idThread, uid, d.body, data ? JSON.stringify(data) : null, d.id_reply, forwardOf ? forwardOf.id : null, Number(d.files.length > 0), Number(LINK_RE.test(d.body || "")), Number(urgent), d.client_id]
		);
		const id = r.insertId;
		if (d.files.length) {
			if (forwardOf) await files.copyTo(conn, d.files, idRoom, id, uid);
			else await conn.query(`UPDATE ${T.files} SET id_message = ? WHERE id IN (?)`, [id, d.files]);
		}
		await mentions.save(conn, id, mentioned);
		if (recs.length) await records.save(conn, id, recs);
		if (kind) await interactive.create(conn, id, d);

		let threadUsers = null;
		if (idThread) {
			await conn.query(`UPDATE ${T.messages} SET thread_count = thread_count + 1, thread_last_at = NOW(3) WHERE id = ?`, [idThread]);
			// Учасники треду: автор першого повідомлення, хто відповідає, кого згадали
			const [[root]] = await conn.query(`SELECT id_user FROM ${T.messages} WHERE id = ?`, [idThread]);
			const join = [...new Set([uid, root && root.id_user, ...mentioned.map((x) => x.id_user)].filter(Boolean).map(Number))];
			await conn.query(`INSERT IGNORE INTO ${T.threads} (id_thread, id_user, last_read_id, date_add) VALUES ${join.map(() => "(?, ?, 0, NOW())").join(", ")}`, join.flatMap((u) => [idThread, u]));
			await conn.query(`UPDATE ${T.threads} SET last_read_id = GREATEST(last_read_id, ?) WHERE id_thread = ? AND id_user = ?`, [id, idThread, uid]);
			const [tu] = await conn.query(`SELECT id_user FROM ${T.threads} WHERE id_thread = ?`, [idThread]);
			threadUsers = new Set(tu.map((x) => Number(x.id_user)));
		} else {
			await conn.query(`UPDATE ${T.rooms} SET last_message_id = ?, last_message_at = NOW(3) WHERE id = ?`, [id, idRoom]);
			// Автор прочитав своє; прихований особистий чат знову з'являється в списку
			await conn.query(`UPDATE ${T.members} SET last_read_id = GREATEST(last_read_id, ?), draft = NULL, draft_at = NULL WHERE id_room = ? AND id_user = ?`, [id, idRoom, uid]);
			await conn.query(`UPDATE ${T.members} SET hidden = 0 WHERE id_room = ? AND hidden = 1`, [idRoom]);
		}

		if (urgent) {
			const [mem] = await conn.query(`SELECT id_user FROM ${T.members} WHERE id_room = ? AND id_user <> ?`, [idRoom, uid]);
			const to = mem.map((x) => Number(x.id_user)).filter((u) => !threadUsers || threadUsers.has(u) || mentioned.some((x) => x.id_user === u));
			await notify.scheduleUrgent(conn, id, to);
		}
		// Підтвердження потрібне від усіх — сповіщаємо всіх, як згаданих (у список згадок не записуємо)
		let pushTo = new Set(mentioned.map((x) => x.id_user));
		if (ack) {
			const [all] = await conn.query(`SELECT id_user FROM ${T.members} WHERE id_room = ? AND id_user <> ?`, [idRoom, uid]);
			pushTo = new Set([...pushTo, ...all.map((x) => Number(x.id_user))]);
		}
		return { id, room: m, mentioned: new Set(mentioned.map((x) => x.id_user)), personal: mentioned.filter((x) => x.kind === "user").map((x) => x.id_user), pushTo, threadUsers };
	});

	const msg = await getOne(uid, result.id);
	if (result.duplicate) return msg;

	await broadcast(idRoom, "chat:message", msg);
	if (result.mentioned.size) realtime.emitToUsers([...result.mentioned], "chat:mention", { id_room: idRoom, id_message: msg.id, id_thread: msg.id_thread });
	notify.onMessage(result.room, msg, { mentioned: result.pushTo, thread: result.threadUsers }).catch((e) => logging.error("[chat] notify", e));
	notify.mentionInbox(result.room, msg, result.personal).catch((e) => logging.error("[chat] mention inbox", e));
	return msg;
}

/** Правка тексту — лише свого і не видаленого. Згадки перераховуються (нові згадки сповіщення не надсилають) */
async function edit(uid, idMsg, body, perms) {
	const out = await rooms.tx(async (conn) => {
		const [[row]] = await conn.query(`SELECT id, id_room, id_user, type, data, deleted_at, has_files FROM ${T.messages} WHERE id = ? FOR UPDATE`, [idMsg]);
		if (!row) throw httpErr(404, "chat.errors.not_found");
		const m = await membership(row.id_room, uid, { conn });
		if (Number(row.id_user) !== uid || row.type !== "text" || row.deleted_at) throw httpErr(403, "chat.errors.forbidden");
		if (!body && !row.has_files) throw httpErr(400, "chat.errors.validation", [{ field: "body", message: "empty" }]);
		await mentions.save(conn, idMsg, await mentions.expand(conn, m, uid, body, perms));
		// Картки: додані вручну лишаються, знайдені в тексті — за новим текстом
		const data = parse(row.data) || {};
		const recs = records.merge(data.attached, body);
		if (recs.length) data.records = recs;
		else delete data.records;
		await records.save(conn, idMsg, recs);
		await conn.query(`UPDATE ${T.messages} SET body = ?, data = ?, has_links = ?, edited_at = NOW(3) WHERE id = ?`, [body, Object.keys(data).length ? JSON.stringify(data) : null, Number(LINK_RE.test(body || "")), idMsg]);
		return row;
	});
	const msg = await getOne(uid, idMsg);
	await broadcast(out.id_room, "chat:message:update", msg);
	return msg;
}

/** Модератор чату: право chat (delete) або власник / адміністратор ручної групи чи каналу */
const moderates = (m, perms) => perms.moderate || ((m.type === "group" || m.type === "channel") && m.kind === "manual" && (m.role === "owner" || m.role === "admin"));

/**
 * Видалення: своє — завжди; чуже — модератору. Текст, файли, реакції, згадки, закріплення прибираються,
 * у стрічці лишається «повідомлення видалено». Відповіді треду лишаються.
 */
async function remove(uid, idMsg, perms) {
	const out = await rooms.tx(async (conn) => {
		const [[row]] = await conn.query(`SELECT id, id_room, id_user, type, deleted_at FROM ${T.messages} WHERE id = ? FOR UPDATE`, [idMsg]);
		if (!row) throw httpErr(404, "chat.errors.not_found");
		const m = await membership(row.id_room, uid, { conn });
		if (row.deleted_at) return { row, paths: [] };
		// Своє текстове — автор; будь-яке (і подію системи) — модератор
		const own = row.type === "text" && Number(row.id_user) === uid;
		if (!ACTIVE.has(row.type) || (!own && !moderates(m, perms))) throw httpErr(403, "chat.errors.forbidden");
		// urgent лишається: видалене термінове рахується в добовому ліміті (інакше ліміт обходиться видаленням)
		await conn.query(`UPDATE ${T.messages} SET body = NULL, data = NULL, has_files = 0, has_links = 0, deleted_at = NOW(3), id_user_deleted = ? WHERE id = ?`, [uid, idMsg]);
		await conn.query(`DELETE FROM ${T.records} WHERE id_message = ?`, [idMsg]);
		await interactive.purge(conn, idMsg);
		await conn.query(`DELETE FROM ${T.reactions} WHERE id_message = ?`, [idMsg]);
		await conn.query(`DELETE FROM ${T.mentions} WHERE id_message = ?`, [idMsg]);
		await conn.query(`DELETE FROM ${T.pins} WHERE id_message = ?`, [idMsg]);
		await conn.query(`UPDATE ${T.urgent} SET done = 1 WHERE id_message = ?`, [idMsg]);
		const paths = await files.detach(conn, idMsg);
		return { row, paths };
	});
	files.unlinkUnused(out.paths).catch((e) => logging.error("[chat] unlink", e));
	const msg = await getOne(uid, idMsg);
	await broadcast(out.row.id_room, "chat:message:update", msg);
	return msg;
}

/** Переслати в інші чати (де людина може писати). Текст і файли копіюються, згадки — ні (це вже не адресні згадки) */
async function forward(uid, idMsg, idRooms, comment, perms) {
	const src = await getOne(uid, idMsg);
	if (src.deleted || src.type !== "text") throw httpErr(400, "chat.errors.validation");
	const [[origin]] = await pool.query(`SELECT r.type, r.name FROM ${T.rooms} r WHERE r.id = ?`, [src.id_room]);
	// Звідки: назву групи / каналу показуємо, особистий чат — ні (це чужа приватна розмова)
	const forwardOf = { id: src.id, from_user: src.id_user, from_name: src.author ? src.author.name : null, from_room: origin && (origin.type === "group" || origin.type === "channel") ? origin.name : null, date: src.date };
	const body = src.body ? mentions.plain(src.body) : null;
	// Картки, які людина бачить, пересилаються разом із текстом
	const fwdRecords = (src.records || []).filter((r) => !r.denied && !r.missing).map((r) => ({ type: r.type, id: r.id }));
	const sent = [];
	for (const idRoom of [...new Set(idRooms)].slice(0, 20)) {
		if (comment) sent.push(await send(uid, idRoom, { body: comment, files: [], id_reply: null, client_id: null }, perms));
		sent.push(await send(uid, idRoom, { body, files: src.files.map((f) => f.id), records: fwdRecords, id_reply: null, client_id: null }, perms, { forwardOf }));
	}
	return sent;
}

/** Прочитано до id включно (стрічка чату). Сповіщаємо інших (галочки) і власні вкладки (лічильник) */
async function read(uid, idRoom, idMsg) {
	await membership(idRoom, uid);
	const [r] = await pool.query(
		`UPDATE ${T.members} SET last_read_id = LEAST(GREATEST(last_read_id, ?), COALESCE((SELECT last_message_id FROM ${T.rooms} WHERE id = ?), 0))
		  WHERE id_room = ? AND id_user = ? AND last_read_id < ?`,
		[idMsg, idRoom, idRoom, uid, idMsg]
	);
	if (r.affectedRows) {
		const [[m]] = await pool.query(`SELECT last_read_id FROM ${T.members} WHERE id_room = ? AND id_user = ?`, [idRoom, uid]);
		await realtime.emitToRoom(idRoom, "chat:read", { id_room: idRoom, id_user: uid, last_read_id: Number(m.last_read_id) });
		await notify.urgentRead(uid, Number(m.last_read_id), { idRoom });
	}
	return { ok: true };
}

/** Прочитано в треді */
async function threadRead(uid, idThread, idMsg) {
	const [[root]] = await pool.query(`SELECT id_room FROM ${T.messages} WHERE id = ? AND id_thread IS NULL`, [idThread]);
	if (!root) throw httpErr(404, "chat.errors.not_found");
	await membership(root.id_room, uid);
	const [[last]] = await pool.query(`SELECT MAX(id) AS id FROM ${T.messages} WHERE id_thread = ?`, [idThread]);
	const upTo = Math.min(idMsg, Number((last && last.id) || 0));
	const [r] = await pool.query(`UPDATE ${T.threads} SET last_read_id = ? WHERE id_thread = ? AND id_user = ? AND last_read_id < ?`, [upTo, idThread, uid, upTo]);
	if (r.affectedRows) {
		realtime.emitToUsers([uid], "chat:thread:read", { id_thread: idThread, last_read_id: upTo });
		await notify.urgentRead(uid, upTo, { idThread });
	}
	return { ok: true };
}

/** Стежити / не стежити за тредом */
async function follow(uid, idThread, value) {
	const [[root]] = await pool.query(`SELECT id_room FROM ${T.messages} WHERE id = ? AND id_thread IS NULL`, [idThread]);
	if (!root) throw httpErr(404, "chat.errors.not_found");
	await membership(root.id_room, uid);
	if (value) {
		await pool.query(`INSERT IGNORE INTO ${T.threads} (id_thread, id_user, last_read_id, date_add) SELECT ?, ?, COALESCE(MAX(id), 0), NOW() FROM ${T.messages} WHERE id_thread = ?`, [idThread, uid, idThread]);
	} else {
		await pool.query(`DELETE FROM ${T.threads} WHERE id_thread = ? AND id_user = ?`, [idThread, uid]);
	}
	return { ok: true };
}

/** Мої треди з непрочитаними відповідями */
async function threads(uid) {
	const [rows] = await pool.query(
		`SELECT t.id_thread, t.last_read_id, m.id_room, m.thread_count, m.thread_last_at,
		        (SELECT COUNT(*) FROM ${T.messages} x WHERE x.id_thread = t.id_thread AND x.id > t.last_read_id AND x.id_user <> ? AND x.deleted_at IS NULL) AS unread
		   FROM ${T.threads} t
		   JOIN ${T.messages} m ON m.id = t.id_thread
		   JOIN ${T.members} mem ON mem.id_room = m.id_room AND mem.id_user = t.id_user
		  WHERE t.id_user = ?
		  ORDER BY m.thread_last_at DESC
		  LIMIT 50`,
		[uid, uid]
	);
	if (!rows.length) return { threads: [], unread_total: 0 };
	const [roots] = await pool.query(`${SELECT} WHERE m.id IN (?)`, [rows.map((r) => r.id_thread)]);
	const byId = new Map((await hydrate(roots, uid)).map((x) => [x.id, x]));
	const list = rows.map((r) => ({ id_thread: Number(r.id_thread), id_room: r.id_room, unread: Number(r.unread), count: Number(r.thread_count), last_at: r.thread_last_at, root: byId.get(Number(r.id_thread)) || null }));
	return { threads: list, unread_total: list.reduce((s, x) => s + x.unread, 0) };
}

/** Хто прочитав повідомлення (крім автора). Для відповіді в треді — учасники треду */
/**
 * Хто прочитав (крім автора): лише ті, хто прочитав, — сторінками по 100 (у великих каналах їх тисячі);
 * скільки ще не прочитали — числом. Для відповіді в треді — учасники треду. after — id людини, з якої продовжити.
 */
const READERS_PAGE = 100;
async function readers(uid, idMsg, after = 0) {
	const msg = await getOne(uid, idMsg);
	const [table, key, ref] = msg.id_thread ? [T.threads, "id_thread", msg.id_thread] : [T.members, "id_room", msg.id_room];
	const [[c]] = await pool.query(
		`SELECT SUM(last_read_id >= ?) AS read_n, SUM(last_read_id < ?) AS unread_n FROM ${table} WHERE ${key} = ? AND NOT (id_user <=> ?)`,
		[msg.id, msg.id, ref, msg.id_user]
	);
	const [rows] = await pool.query(
		`SELECT id_user FROM ${table} WHERE ${key} = ? AND NOT (id_user <=> ?) AND last_read_id >= ? AND id_user > ? ORDER BY id_user LIMIT ?`,
		[ref, msg.id_user, msg.id, Number(after) || 0, READERS_PAGE + 1]
	);
	const page = rows.slice(0, READERS_PAGE);
	const who = await rooms.people(page.map((r) => r.id_user));
	return {
		read: page.map((r) => who.get(Number(r.id_user)) || { id: Number(r.id_user) }),
		read_count: Number(c.read_n) || 0,
		unread_count: Number(c.unread_n) || 0,
		next: rows.length > READERS_PAGE ? Number(page[page.length - 1].id_user) : null,
	};
}

/** Реакція: поставити або зняти. Не більше 20 різних емодзі на повідомлення */
/**
 * Реакція: поставити / зняти. На повідомленні — до MAX_REACTIONS різних емодзі;
 * від однієї людини — до MAX_MY_REACTIONS (нова понад ліміт замінює найстаршу свою, як у Telegram).
 * Повідомлення блокується на час зміни — паралельні запити не обійдуть ліміти.
 */
async function react(uid, idMsg, emoji) {
	if (typeof emoji !== "string" || Buffer.byteLength(emoji) > 32 || !EMOJI_RE.test(emoji)) throw httpErr(400, "chat.errors.validation", [{ field: "emoji", message: "invalid" }]);
	const row = await rooms.tx(async (conn) => {
		const [[msg]] = await conn.query(`SELECT id, id_room, type, deleted_at FROM ${T.messages} WHERE id = ? FOR UPDATE`, [idMsg]);
		if (!msg || msg.deleted_at || !ACTIVE.has(msg.type)) throw httpErr(404, "chat.errors.not_found");
		const m = await membership(msg.id_room, uid, { conn });
		if (m.archived) throw httpErr(403, "chat.errors.cannot_post");
		const [del] = await conn.query(`DELETE FROM ${T.reactions} WHERE id_message = ? AND id_user = ? AND emoji = ?`, [idMsg, uid, emoji]);
		if (del.affectedRows) return msg;
		const [[n]] = await conn.query(`SELECT COUNT(DISTINCT emoji) AS kinds, COALESCE(SUM(emoji = ?), 0) AS same FROM ${T.reactions} WHERE id_message = ?`, [emoji, idMsg]);
		if (!Number(n.same) && Number(n.kinds) >= MAX_REACTIONS) throw httpErr(400, "chat.errors.too_many_reactions");
		const [mine] = await conn.query(`SELECT emoji FROM ${T.reactions} WHERE id_message = ? AND id_user = ? ORDER BY date_add, emoji`, [idMsg, uid]);
		if (mine.length >= MAX_MY_REACTIONS) {
			const drop = mine.slice(0, mine.length - MAX_MY_REACTIONS + 1).map((r) => r.emoji);
			await conn.query(`DELETE FROM ${T.reactions} WHERE id_message = ? AND id_user = ? AND emoji IN (?)`, [idMsg, uid, drop]);
		}
		await conn.query(`INSERT IGNORE INTO ${T.reactions} (id_message, id_user, emoji, date_add) VALUES (?, ?, ?, NOW())`, [idMsg, uid, emoji]);
		return msg;
	});
	const msg = await getOne(uid, idMsg);
	await realtime.emitToRoom(row.id_room, "chat:reaction", { id_message: idMsg, id_room: row.id_room, id_thread: msg.id_thread, reactions: msg.reactions.map((r) => ({ emoji: r.emoji, count: r.count, users: r.users })) });
	return { reactions: msg.reactions };
}

/** Хто може закріплювати: особистий чат і нотатки — будь-хто; група / канал — власник і адміністратори; автоматичні — модератори */
const canPin = (m, perms) => m.type === "direct" || m.type === "notes" || (m.kind === "manual" ? m.role === "owner" || m.role === "admin" : perms.moderate);

async function pin(uid, idMsg, value, perms) {
	const out = await rooms.tx(async (conn) => {
		const [[row]] = await conn.query(`SELECT id, id_room, id_thread, type, deleted_at FROM ${T.messages} WHERE id = ?`, [idMsg]);
		if (!row || row.deleted_at || !ACTIVE.has(row.type) || row.id_thread) throw httpErr(404, "chat.errors.not_found");
		const m = await membership(row.id_room, uid, { conn });
		if (!canPin(m, perms)) throw httpErr(403, "chat.errors.forbidden");
		if (value) {
			const [[n]] = await conn.query(`SELECT COUNT(*) AS n FROM ${T.pins} WHERE id_room = ?`, [row.id_room]);
			if (Number(n.n) >= 50) throw httpErr(400, "chat.errors.too_many_pins");
			const [ins] = await conn.query(`INSERT IGNORE INTO ${T.pins} (id_room, id_message, id_user, date_add) VALUES (?, ?, ?, NOW())`, [row.id_room, idMsg, uid]);
			if (ins.affectedRows) row.sys = await rooms.systemMessage(conn, row.id_room, { event: "pinned", by: uid, id_message: idMsg });
		} else {
			const [del] = await conn.query(`DELETE FROM ${T.pins} WHERE id_room = ? AND id_message = ?`, [row.id_room, idMsg]);
			// Відкріплення теж видно в історії чату
			if (del.affectedRows) row.sys = await rooms.systemMessage(conn, row.id_room, { event: "unpinned", by: uid, id_message: idMsg });
		}
		return row;
	});
	const msg = await getOne(uid, idMsg);
	await broadcast(out.id_room, "chat:message:update", msg);
	if (out.sys) await realtime.emitToRoom(out.id_room, "chat:message", await getOne(uid, out.sys));
	await realtime.emitToRoom(out.id_room, "chat:pins", { id_room: out.id_room });
	return { ok: true };
}

/** Закріплені повідомлення чату (новіші — першими) */
async function pins(uid, idRoom) {
	await membership(idRoom, uid);
	const [rows] = await pool.query(`${SELECT} JOIN ${T.pins} p ON p.id_message = m.id WHERE p.id_room = ? ORDER BY p.date_add DESC`, [idRoom]);
	return { messages: await hydrate(rows, uid) };
}

/**
 * Задача з повідомлення: подія календаря виконавця (controllers/calendar/tasks) з текстом повідомлення,
 * посиланням на нього і прив'язками до записів із карток. Виконавець — сам автор або учасник цього чату.
 * У чаті — системне повідомлення «створив задачу для …», виконавцю — сповіщення.
 * Без повідомлення (команда /task) — задача з чату idRoom.
 * t: { title, id_user, start: Date, description }
 */
async function task(uid, idMsg, t, idRoom = null) {
	let src;
	if (idMsg) {
		src = await getOne(uid, idMsg);
		if (src.deleted || !ACTIVE.has(src.type)) throw httpErr(404, "chat.errors.not_found");
	} else {
		const m = await membership(idRoom, uid);
		if (m.archived) throw httpErr(403, "chat.errors.cannot_post");
		src = { id: null, id_room: idRoom, body: null, records: [] };
	}
	const assignee = Number(t.id_user) || uid;
	if (assignee !== uid) {
		const [[mem]] = await pool.query(
			`SELECT m.id_user FROM ${T.members} m JOIN ${T.users} u ON u.id = m.id_user AND u.active = 1 WHERE m.id_room = ? AND m.id_user = ?`,
			[src.id_room, assignee]
		);
		if (!mem) throw httpErr(400, "chat.errors.validation", [{ field: "id_user", message: "not a member" }]);
	}
	const [[rc]] = await pool.query(`SELECT code FROM ${T.rooms} WHERE id = ?`, [src.id_room]);
	const link = roomLink(rc && rc.code, src.id);
	const text = t.description != null ? t.description : mentions.plain(src.body || "");
	const description = [text, link].filter(Boolean).join("\n\n");
	// Прив'язки — лише записи, які бачить автор задачі
	const links = (src.records || []).filter((r) => !r.denied && !r.missing).map((r) => ({ type: r.type, id: r.id }));
	const { createTask } = require("../calendar/tasks");
	const out = await rooms.tx(async (conn) => {
		const idEvent = await createTask({ idUser: assignee, title: t.title, description, start: t.start, durationMin: 30, priority: 2, reminderMinutes: 15, links }, conn);
		const sys = await rooms.systemMessage(conn, src.id_room, { event: "task", by: uid, user: assignee, id_message: src.id, title: String(t.title).slice(0, 255) });
		return { idEvent, sys };
	});
	await realtime.emitToRoom(src.id_room, "chat:message", await getOne(uid, out.sys));
	if (assignee !== uid) {
		const { notify: pushNotify } = require("../notifications");
		const i18n = require("../../config/i18n/i18n");
		const locale = process.env.APP_LOCALE || "uk";
		const [[who]] = await pool.query(`SELECT ${userName("u")} AS name FROM ${T.users} u WHERE u.id = ?`, [uid]);
		pushNotify({
			type: "personal.calendar",
			audience: { user: assignee },
			channels: ["inapp", "webpush"],
			key: `chat:task:${out.idEvent}`,
			payload: { title: i18n.__({ phrase: "chat.task.assigned", locale }, { name: (who && who.name) || "" }), message: String(t.title).slice(0, 255), url: "/?event=" + out.idEvent },
		}).catch((e) => logging.error("[chat] task notify", e));
	}
	return { id_event: out.idEvent, url: "/?event=" + out.idEvent };
}

/** Чернетка поля вводу (окремо для кожного чату) */
async function draft(uid, idRoom, text) {
	await membership(idRoom, uid);
	const value = text && String(text).trim() ? String(text).slice(0, 10000) : null;
	await pool.query(`UPDATE ${T.members} SET draft = ?, draft_at = IF(? IS NULL, NULL, NOW()) WHERE id_room = ? AND id_user = ?`, [value, value, idRoom, uid]);
	return { ok: true };
}

/**
 * Пошук по чатах людини. q — повнотекстово (ngram, будь-якою мовою);
 * фільтри: чат, автор, дати, файли, посилання, «мене згадали». before — наступна сторінка.
 */
async function search(uid, f) {
	const where = ["mem.id_user = ?", "m.deleted_at IS NULL", "m.type = 'text'"];
	const params = [uid];
	const q = String(f.q || "").trim();
	if (q) {
		// Кожне слово — обов'язкове; фраза в лапках — як є. Індекс ngram ріже текст на пари символів — слово з одного символу ним не знайти
		const terms = (q.match(/"[^"]+"|\S+/g) || [])
			.slice(0, 10)
			.map((t) => t.replace(/["+\-<>()~*@]/g, " ").trim())
			.filter((t) => [...t].length >= 2)
			.map((t) => `+"${t}"`);
		if (terms.length) {
			where.push("MATCH(m.body) AGAINST(? IN BOOLEAN MODE)");
			params.push(terms.join(" "));
		} else {
			where.push("m.body LIKE ?");
			params.push(`%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
		}
	}
	if (f.id_room) {
		where.push("m.id_room = ?");
		params.push(f.id_room);
	}
	if (f.id_user) {
		where.push("m.id_user = ?");
		params.push(f.id_user);
	}
	if (f.date_from) {
		where.push("m.date_add >= ?");
		params.push(f.date_from + " 00:00:00");
	}
	if (f.date_to) {
		where.push("m.date_add < ? + INTERVAL 1 DAY");
		params.push(f.date_to);
	}
	if (f.has_files) where.push("m.has_files = 1");
	if (f.has_links) where.push("m.has_links = 1");
	if (f.mentions_me) {
		where.push(`EXISTS (SELECT 1 FROM ${T.mentions} mn WHERE mn.id_message = m.id AND mn.id_user = ?)`);
		params.push(uid);
	}
	if (f.before) {
		where.push("m.id < ?");
		params.push(f.before);
	}
	if (where.length === 3) throw httpErr(400, "chat.errors.search_empty");

	const [rows] = await pool.query(`${SELECT} JOIN ${T.members} mem ON mem.id_room = m.id_room WHERE ${where.join(" AND ")} ORDER BY m.id DESC LIMIT 51`, params);
	const list = await hydrate(rows.slice(0, 50), uid);
	const roomIds = [...new Set(list.map((x) => x.id_room))];
	const names = new Map();
	if (roomIds.length) {
		const [rr] = await pool.query(
			`SELECT r.id, r.type, r.kind, r.name,
			        (SELECT ${userName("u")} FROM ${T.members} x JOIN ${T.users} u ON u.id = x.id_user WHERE x.id_room = r.id AND x.id_user <> ? LIMIT 1) AS partner
			   FROM ${T.rooms} r WHERE r.id IN (?)`,
			[uid, roomIds]
		);
		rr.forEach((r) => names.set(r.id, { type: r.type, kind: r.kind, name: r.type === "direct" ? r.partner : r.name }));
	}
	return { results: list.map((x) => ({ ...x, room: names.get(x.id_room) || null })), more: rows.length > 50 };
}

module.exports = { broadcast, task, history, thread, getOne, send, edit, remove, forward, read, threadRead, follow, threads, readers, react, pin, pins, draft, search, PAGE, MAX_REACTIONS, MAX_MY_REACTIONS };