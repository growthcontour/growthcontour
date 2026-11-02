/**
 * helpers/user_sessions.js
 * Сесії користувачів (окремий рядок на кожен вхід) + журнал входів.
 */
const crypto = require("crypto");
const db = require("../config/database/connection_pool");
const config = require("../config/config");
const prefix = config.get("configDatabase").prefix;
const geoip = require("./geoip");

// 0 desktop, 1 mobile, 2 tablet
function parseDevice(ua = "") {
	if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(ua)) return 2;
	if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua)) return 1;
	return 0;
}

// "Chrome · Windows"
function describeUA(ua = "") {
	const browser = /edg\//i.test(ua) ? "Edge" : /opr\/|opera/i.test(ua) ? "Opera" : /firefox\//i.test(ua) ? "Firefox" : /chrome\//i.test(ua) ? "Chrome" : /safari\//i.test(ua) ? "Safari" : "Browser";
	const os = /windows/i.test(ua) ? "Windows" : /iphone|ipad|ipod/i.test(ua) ? "iOS" : /android/i.test(ua) ? "Android" : /mac os x/i.test(ua) ? "macOS" : /linux/i.test(ua) ? "Linux" : "—";
	return { browser, os };
}

/** Створює сесію в межах транзакції conn, повертає sid для JWT */
async function createSession(conn, { userId, ip, userAgent, fingerprint, ttlHours }) {
	const sid = crypto.randomUUID();
	const ua = String(userAgent || "").slice(0, 512);
	await conn.execute(
		`INSERT INTO ${prefix}users_sessions
		 (sid, id_user, ip_address, user_agent, device_fingerprint, created_at, last_activity, expires_at, is_valid)
		 VALUES (?, ?, ?, ?, ?, NOW(), NOW(), DATE_ADD(NOW(), INTERVAL ? HOUR), 1)`,
		[sid, userId, String(ip || "").slice(0, 45), ua, fingerprint, Number(ttlHours) || 24]
	);
	await conn.execute(`UPDATE ${prefix}users SET last_device_type = ? WHERE id = ?`, [parseDevice(ua), userId]);
	return sid;
}

/** Запис у журнал входів (помилки не ламають вхід) */
async function writeLoginLog({ userId, ip, userAgent, success, reason = "" }) {
	if (!userId) return;
	const ua = String(userAgent || "").slice(0, 512);
	try {
		const geo = await geoip.lookup(ip);
		await db.execute(
			`INSERT INTO ${prefix}users_login_log (id_user, ip, country, city, user_agent, device, status, reason, date_add)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
			[userId, String(ip || "").slice(0, 45), geo.country, geo.city, ua, parseDevice(ua), success ? 1 : 0, reason || ""]
		);
	} catch (err) {
		console.error("[LOGIN LOG ERROR]:", err.message);
	}
}

/** last_activity — не частіше ніж раз на хвилину */
function touchSession(sessionId) {
	db.execute(
		`UPDATE ${prefix}users_sessions SET last_activity = NOW()
		 WHERE id = ? AND (last_activity IS NULL OR last_activity < NOW() - INTERVAL 1 MINUTE)`,
		[sessionId]
	).catch(() => {});
}

async function listSessions(userId) {
	const [rows] = await db.execute(
		`SELECT id, sid, ip_address, user_agent, created_at, last_activity, expires_at
		 FROM ${prefix}users_sessions
		 WHERE id_user = ? AND is_valid = 1 AND expires_at > NOW()
		 ORDER BY last_activity DESC`,
		[userId]
	);
	return rows;
}

async function revokeSession(userId, sessionId, byUserId) {
	const [r] = await db.execute(
		`UPDATE ${prefix}users_sessions SET is_valid = 0, revoked_at = NOW(), revoked_by = ?
		 WHERE id = ? AND id_user = ? AND is_valid = 1`,
		[byUserId || null, sessionId, userId]
	);
	if (r.affectedRows) notifyUser(userId);
	return r.affectedRows;
}

/** Закрити всі сесії, крім exceptSid (null = всі) */
async function revokeAllSessions(userId, exceptSid, byUserId) {
	const [r] = await db.execute(
		`UPDATE ${prefix}users_sessions SET is_valid = 0, revoked_at = NOW(), revoked_by = ?
		 WHERE id_user = ? AND is_valid = 1 AND (? IS NULL OR sid <> ?)`,
		[byUserId || null, userId, exceptSid || null, exceptSid || null]
	);
	if (r.affectedRows) notifyUser(userId);
	return r.affectedRows;
}

async function revokeBySid(sid) {
	if (!sid) return;
	await db.execute(`UPDATE ${prefix}users_sessions SET is_valid = 0, revoked_at = NOW() WHERE sid = ? AND is_valid = 1`, [sid]).catch(() => {});
}

/** Сигнал вкладкам користувача "перевір свою сесію" */
function notifyUser(userId) {
	try {
		const { getIO } = require("../controllers/socket/socket");
		const io = getIO();
		if (io) io.to(`io_user_session_${userId}`).emit(`io_user_session_${userId}`, { type: "check" });
	} catch (e) {}
}

module.exports = {
	parseDevice,
	describeUA,
	createSession,
	writeLoginLog,
	touchSession,
	listSessions,
	revokeSession,
	revokeAllSessions,
	revokeBySid,
	notifyUser,
};
