"use strict";

/**
 * Чат компанії: події в реальному часі (socket.io).
 * Кожне з'єднання користувача сервер сам додає в кімнату io_chat_<id> — клієнт обрати чужу не може.
 * Події: chat:message, chat:message:update, chat:read, chat:typing, chat:room, chat:room:remove, chat:status
 */
const { pool, T } = require("./common");
const logging = require("../../logging/logging");

const personal = (uid) => `io_chat_${Number(uid)}`;

function io() {
	try {
		return require("../socket/socket").getIO();
	} catch {
		return null;
	}
}

function emitToUsers(uids, event, data) {
	const server = io();
	if (!server) return;
	const rooms = [...new Set(uids.map(Number))].map(personal);
	if (rooms.length) server.to(rooms).emit(event, data);
}

// Учасники чату — короткий кеш: «друкує…» приходить часто, а склад змінюється рідко
const CACHE_MS = 15000;
const membersCache = new Map();

async function roomMembers(idRoom) {
	const hit = membersCache.get(idRoom);
	if (hit && hit.at > Date.now() - CACHE_MS) return hit.ids;
	const [rows] = await pool.query(`SELECT id_user FROM ${T.members} WHERE id_room = ?`, [idRoom]);
	const ids = rows.map((r) => Number(r.id_user));
	membersCache.set(idRoom, { at: Date.now(), ids });
	if (membersCache.size > 5000) membersCache.delete(membersCache.keys().next().value);
	return ids;
}

const forget = (idRoom) => membersCache.delete(Number(idRoom));

async function emitToRoom(idRoom, event, data, { except = null } = {}) {
	const ids = await roomMembers(Number(idRoom));
	emitToUsers(
		ids.filter((u) => u !== except),
		event,
		data
	);
}

function bindSocket(server, socket) {
	const uid = socket.data && socket.data.userId;
	if (!uid) return;
	socket.join(personal(uid));

	// «друкує…» — не частіше ніж раз на 2 с для одного чату
	const lastTyping = new Map();
	socket.on("chat:typing", async (payload) => {
		try {
			const idRoom = Number(payload && payload.id_room);
			if (!Number.isInteger(idRoom) || idRoom < 1) return;
			const now = Date.now();
			if ((lastTyping.get(idRoom) || 0) > now - 2000) return;
			lastTyping.set(idRoom, now);
			if (lastTyping.size > 200) lastTyping.delete(lastTyping.keys().next().value);
			const ids = await roomMembers(idRoom);
			if (!ids.includes(uid)) return;
			emitToUsers(
				ids.filter((u) => u !== uid),
				"chat:typing",
				{ id_room: idRoom, id_user: uid }
			);
		} catch (e) {
			logging.error("[chat:typing]", e);
		}
	});
}

module.exports = { emitToUsers, emitToRoom, roomMembers, forget, bindSocket, personal };