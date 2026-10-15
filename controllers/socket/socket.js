"use strict";

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const prefix = config.get("configDatabase").prefix;
const { jwt: jwtCfg } = config.get("configJWT");

// Кімнати, прив'язані до конкретного користувача: зайти можна лише у свою
const PERSONAL_ROOM = /^(io_manager_notifications_|io_user_session_|io_manager_)(\d+)$/;

function canJoinRoom(socket, room) {
	if (typeof room !== "string" || !room || room.length > 100) return false;
	const m = room.match(PERSONAL_ROOM);
	return m ? Number(m[2]) === socket.data.userId : true;
}

// Та сама перевірка, що в isAuthenticated: підпис JWT + жива сесія + token_version + активний акаунт
async function authenticateSocket(socket, next) {
	try {
		const match = String(socket.handshake.headers.cookie || "").match(/(?:^|;\s*)access_token=([^;]+)/);
		if (!match) return next(new Error("unauthorized"));

		const decoded = jwt.verify(decodeURIComponent(match[1]), jwtCfg.jwt_secret);
		const [rows] = await connection_pool.query(
			`SELECT u.token_version, u.active, s.id AS session_id
       FROM \`${prefix}users\` u
       LEFT JOIN \`${prefix}users_sessions\` s
              ON s.sid = ? AND s.id_user = u.id AND s.is_valid = 1 AND s.expires_at > NOW()
       WHERE u.id = ?`,
			[decoded.sid || "", decoded.userId]
		);
		if (!rows.length || rows[0].token_version !== decoded.token_version || !rows[0].session_id || rows[0].active !== 1) {
			return next(new Error("unauthorized"));
		}

		socket.data.userId = Number(decoded.userId);
		next();
	} catch (err) {
		next(new Error("unauthorized"));
	}
}

let ioInstance;

// Map<userId, Set<socketId>>
const onlineUsers = new Map();
// Map<socketId, userId>
const socketToUser = new Map();
// Map<userId, timestamp>
const lastHeartbeat = new Map();

const HEARTBEAT_INTERVAL = 30000; // Клієнт відправляє кожні 30 сек
const HEARTBEAT_TIMEOUT = 35000; // Сервер чекає 35 сек перед офлайн

function addOnlineUser(userId, socketId) {
	const isFirst = !onlineUsers.has(userId);
	if (isFirst) onlineUsers.set(userId, new Set());
	onlineUsers.get(userId).add(socketId);
	return isFirst;
}

function removeOnlineUser(userId, socketId) {
	if (!onlineUsers.has(userId)) return true;
	const sockets = onlineUsers.get(userId);
	sockets.delete(socketId);
	if (sockets.size === 0) {
		onlineUsers.delete(userId);
		return true;
	}
	return false;
}

function isUserOnline(userId) {
	return onlineUsers.has(Number(userId));
}

function getOnlineUserIds() {
	return Array.from(onlineUsers.keys());
}

function broadcastOnlineUsers() {
	if (!ioInstance) return;
	// Розсилаємо завжди — клієнт оновить і онлайн і офлайн дані
	ioInstance.emit("users:online", getOnlineUserIds());
}

async function setUserOffline(userId) {
	onlineUsers.delete(userId);
	lastHeartbeat.delete(userId);

	try {
		await connection_pool.query(
			`UPDATE \`${prefix}users\`
             SET date_last_seen    = NOW(),
                 date_online_since = NULL
             WHERE id = ?`,
			[userId]
		);
	} catch (err) {}

	broadcastOnlineUsers();
}

function setupSocketIO(server) {
	ioInstance = new Server(server, {
		cors: { origin: "*", methods: ["GET", "POST"] },
	});

	// Основний простір (CRM) — лише для залогінених. /webchat має власну логіку.
	ioInstance.use(authenticateSocket);

	// ── Тік кожні 30 секунд ───────────────────────────────────────────────────
	// 1. Перевіряємо heartbeat timeout
	// 2. Розсилаємо users:online всім — клієнт оновить час онлайн і офлайн
	setInterval(async () => {
		const now = Date.now();

		for (const [userId, lastTime] of lastHeartbeat.entries()) {
			if (now - lastTime > HEARTBEAT_TIMEOUT) {
				await setUserOffline(userId);
			}
		}

		// Розсилаємо завжди — навіть якщо всі офлайн
		// Це змушує клієнт зробити запит до БД і оновити дати
		broadcastOnlineUsers();
	}, HEARTBEAT_INTERVAL);

	ioInstance.on("connection", (socket) => {
		// ── Юзер онлайн ───────────────────────────────────────────────────────
		socket.on("user:online", async () => {
			const userId = socket.data.userId;

			const isFirst = addOnlineUser(userId, socket.id);
			socketToUser.set(socket.id, userId);
			lastHeartbeat.set(userId, Date.now());

			if (isFirst) {
				try {
					await connection_pool.query(
						`UPDATE \`${prefix}users\`
                         SET date_last_login   = NOW(),
                             date_online_since = COALESCE(date_online_since, NOW())
                         WHERE id = ?`,
						[userId]
					);
				} catch (err) {}
			}

			broadcastOnlineUsers();
		});

		// ── Heartbeat від клієнта ─────────────────────────────────────────────
		socket.on("heartbeat", () => {
			lastHeartbeat.set(socket.data.userId, Date.now());
		});

		socket.on("joinRoom", (payload) => {
			const room = payload && payload.room;
			if (canJoinRoom(socket, room)) socket.join(room);
		});
		socket.on("room", (room) => {
			if (canJoinRoom(socket, room)) socket.join(room);
		});

		socket.on("getRooms", () => socket.emit("roomsList", Array.from(socket.rooms)));

		// ── Живе блокування редагування товарів ─────────────────────────────
		require("../catalog/products/edit-lock").bindSocket(ioInstance, socket);

		// ── Відключення ───────────────────────────────────────────────────────
		socket.on("disconnect", async () => {
			const userId = socketToUser.get(socket.id);
			if (!userId) return;

			socketToUser.delete(socket.id);
			const wentOffline = removeOnlineUser(userId, socket.id);

			if (wentOffline) {
				// Одразу записуємо date_last_seen — час виходу точний
				// date_online_since НЕ скидаємо — це зробить heartbeat timeout
				// При оновленні сторінки юзер повернеться і COALESCE збереже час
				try {
					await connection_pool.query(
						`UPDATE \`${prefix}users\`
                         SET date_last_seen = NOW()
                         WHERE id = ?`,
						[userId]
					);
				} catch (err) {}
			}

			broadcastOnlineUsers();
		});
	});

	// ── Web-chat namespace (ізольований від CRM-io) ───────────────────────────
	// Клієнти віджета з чужих сайтів живуть тут, окремо від операторських подій CRM.
	try {
		const webChat = require("../../routes/contact-center/web-chat/web-chat");
		if (webChat && typeof webChat.bindSocket === "function") {
			webChat.bindSocket(ioInstance.of("/webchat"));
		}
	} catch (err) {}

	return ioInstance;
}

module.exports = {
	setupSocketIO,
	getIO: () => ioInstance,
	isUserOnline,
	getOnlineUserIds,
};
