"use strict";

const { Server } = require("socket.io");
const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const prefix = config.get("configDatabase").prefix;

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
    socket.on("user:online", async ({ userId }) => {
      if (!userId) return;
      userId = Number(userId);

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
    socket.on("heartbeat", ({ userId }) => {
      if (!userId) return;
      lastHeartbeat.set(Number(userId), Date.now());
    });

    socket.on("joinRoom", ({ room }) => socket.join(room));
    socket.on("room", (room) => {
      socket.join(room);
    });
    socket.on("getRooms", () => socket.emit("roomsList", Array.from(socket.rooms)));

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
