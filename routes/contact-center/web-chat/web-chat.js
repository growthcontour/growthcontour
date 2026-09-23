"use strict";

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const webpush = require("web-push");
const router = express.Router();

// ─── Спільні залежності CRM ──────────────────────────────────────────────────
const connection_pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const logging = require("../../../logging/logging");
const authorizationControllers = require("../../../controllers/authorization/authorization");
const notifications = require("../../../controllers/notifications/index");
const ccBridge = require("../../../controllers/contact-center/webchat-bridge");

const prefix = config.get("configDatabase").prefix;

// ─── Константи таблиць (спільна база CRM, префікс 8ydnb966_) ──────────────────
const TABLE = `\`${prefix}web_chat_messages\``;
const SESSIONS = `\`${prefix}web_chat_sessions\``;
const SITES = `\`${prefix}web_chat_sites\``;
const LEADS = `\`${prefix}web_chat_leads\``;
const VMETA = `\`${prefix}web_chat_visitor_meta\``;
const NOTIF_READS = `\`${prefix}notification_reads\``;
const NOTIF = `\`${prefix}notifications\``;
const OREADS = `\`${prefix}web_chat_operator_reads\``;
const CREADS = `\`${prefix}web_chat_client_reads\``;
const PUSHSUBS = `\`${prefix}web_chat_push_subs\``;
const CONV = `\`${prefix}web_chat_conversations\``;
const VPRODUCTS = `\`${prefix}web_chat_visitor_products\``;

// pool — псевдонім, щоб перенесений код чату (pool.execute/query/getConnection) працював без правок
const pool = connection_pool;

// ─── Секрети/конфіг чату (з config CRM, не з .env) ───────────────────────────
// TODO: винести значення у config-json. Поки читаємо з configServer з фолбеком.
const cfgServer = config.get("configServer") || {};
function hostFromUrl(u) {
	try {
		return new URL(u).hostname.toLowerCase();
	} catch {
		return "";
	}
}
const OUR_HOST =
	cfgServer.webChatHost ||
	cfgServer.host ||
	(function () {
		try {
			return new URL(process.env.APP_URL).hostname.toLowerCase();
		} catch {
			return "";
		}
	})();
const FILE_SIGN_SECRET = cfgServer.webChatFileSecret || "";
const VAPID_PUBLIC = cfgServer.webChatVapidPublic || "";
const VAPID_PRIVATE = cfgServer.webChatVapidPrivate || "";
const TG_TOKEN = cfgServer.webChatTgToken || "";
const TG_CHAT_ID = Number(cfgServer.webChatTgChatId) || 0;
const TG_THREAD_ID = Number(cfgServer.webChatTgThreadId) || 0;

if (VAPID_PUBLIC && VAPID_PRIVATE) {
	try {
		webpush.setVapidDetails(cfgServer.webChatVapidSubject || `mailto:admin@${OUR_HOST}`, VAPID_PUBLIC, VAPID_PRIVATE);
	} catch (e) {
		console.error("[web-chat] VAPID:", e.message);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
//  ХЕЛПЕРИ (без БД)
// ═══════════════════════════════════════════════════════════════════════════

const MAX_TEXT_LEN = 4000;
const WC_UPLOAD_DIR = path.join(process.cwd(), "assets", "web-chat-uploads");
const FILE_URL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const ALLOWED_TYPES = {
	"image/jpeg": { ext: "jpg", kind: "image" },
	"image/png": { ext: "png", kind: "image" },
	"image/webp": { ext: "webp", kind: "image" },
	"image/gif": { ext: "gif", kind: "image" },
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { ext: "xlsx", kind: "file" },
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": { ext: "docx", kind: "file" },
};

// Генерація непрозорого url-токена (32 hex = 128 біт). Тільки [0-9a-f].
function genUrlToken() {
	return crypto.randomBytes(16).toString("hex");
}

// Єдине створення розмови. Токен ставиться лише при першій вставці (при дублі не чіпається).
// Ретрай на випадок дуже рідкісної колізії унікального індексу.
async function ensureConversation(siteId, roomId) {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await pool.execute(
				`INSERT INTO ${CONV} (site_id, room_id, url_token, status) VALUES (?, ?, ?, 'open')
                 ON DUPLICATE KEY UPDATE id = id`,
				[siteId, roomId, genUrlToken()]
			);
			return;
		} catch (e) {
			if (e && e.code === "ER_DUP_ENTRY" && attempt < 2) continue; // колізія токена — новий
			throw e;
		}
	}
}

// Кеш незмінних url-токенів (roomId → token), щоб не бити в БД на кожну подію.
const urlTokenCache = new Map();
async function getUrlToken(siteId, roomId) {
	const cached = urlTokenCache.get(roomId);
	if (cached) return cached;
	try {
		const [rows] = await pool.execute(`SELECT url_token FROM ${CONV} WHERE site_id = ? AND room_id = ? LIMIT 1`, [siteId, roomId]);
		const tok = rows.length ? rows[0].url_token : null;
		if (tok) urlTokenCache.set(roomId, tok);
		return tok || "";
	} catch (e) {
		console.error("getUrlToken:", e.message);
		return "";
	}
}

const UID_RE = /^[a-f0-9]{64}$/;
function newUid() {
	return crypto.randomBytes(32).toString("hex");
}

function roomIdOf(siteId, visitorId) {
	return `${siteId}_${visitorId}`;
}
function roomBelongsToSite(roomId, siteId) {
	return typeof roomId === "string" && !!siteId && roomId.startsWith(siteId + "_");
}

function cleanText(text) {
	if (typeof text !== "string") return null;
	const t = text.trim().slice(0, MAX_TEXT_LEN);
	return t.length ? t : null;
}

function esc(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseCookies(header) {
	const out = {};
	if (!header) return out;
	header.split(";").forEach((p) => {
		const i = p.indexOf("=");
		if (i > -1) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
	});
	return out;
}

function hostOf(urlStr) {
	try {
		return new URL(urlStr).hostname.toLowerCase();
	} catch {
		return null;
	}
}

// Точне співпадіння домену. Для піддоменів — явний запис "*.example.com".
function matchDomain(host, list) {
	if (!host) return false;
	return list.some((d) => {
		if (d.startsWith("*.")) return host === d.slice(2) || host.endsWith(d.slice(1));
		return host === d;
	});
}

function safeColor(c) {
	const s = String(c || "").trim();
	return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : "#007fff";
}

function safeUrl(u) {
	const s = String(u || "").trim();
	return /^https?:\/\//i.test(s) ? s.slice(0, 600) : "";
}

// ── Підпис файлів (HMAC + TTL) ──
function signPath(relPath, exp) {
	return crypto
		.createHmac("sha256", FILE_SIGN_SECRET)
		.update(relPath + "|" + exp)
		.digest("hex");
}
function signFileUrl(relPath) {
	const exp = Date.now() + FILE_URL_TTL_MS;
	const sig = signPath(relPath, exp);
	return `/chat/file/${relPath}?exp=${exp}&sig=${sig}`;
}
function verifyFileSig(relPath, exp, sig) {
	const expNum = Number(exp);
	if (!expNum || Date.now() > expNum) return false;
	const expected = signPath(relPath, String(exp));
	const a = Buffer.from(sig || "", "hex");
	const b = Buffer.from(expected, "hex");
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function absFileUrl(relPath) {
	return `https://${OUR_HOST}` + signFileUrl(relPath);
}

// ── Тікет на завантаження ──
const UPLOAD_TICKET_TTL_MS = 6 * 60 * 60 * 1000;
function makeUploadTicket(uid, siteId) {
	const exp = Date.now() + UPLOAD_TICKET_TTL_MS;
	const sig = crypto
		.createHmac("sha256", FILE_SIGN_SECRET)
		.update("upl|" + uid + "|" + siteId + "|" + exp)
		.digest("hex");
	return exp + "." + sig;
}
function verifyUploadTicket(ticket, uid, siteId) {
	const s = String(ticket || "");
	const dot = s.indexOf(".");
	if (dot < 1) return false;
	const exp = Number(s.slice(0, dot));
	const sig = s.slice(dot + 1);
	if (!exp || Date.now() > exp) return false;
	const expected = crypto
		.createHmac("sha256", FILE_SIGN_SECRET)
		.update("upl|" + uid + "|" + siteId + "|" + exp)
		.digest("hex");
	const a = Buffer.from(sig, "hex");
	const b = Buffer.from(expected, "hex");
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeRelPath(relPath) {
	const s = String(relPath || "");
	if (s.includes("..") || s.includes("\\") || s.startsWith("/")) return null;
	if (!/^[A-Za-z0-9_\-]+\/\d{4}-\d{2}\/[a-f0-9]{32}\.[a-z0-9]+$/.test(s)) return null;
	return s;
}

// ── Санітайзери ──
function sanitizeAttachment(a) {
	if (!a || typeof a !== "object") return null;
	const rel = safeRelPath(a.path);
	if (!rel) return null;
	const kind = a.kind === "image" || a.kind === "file" ? a.kind : "file";
	const clip = (v, n) => String(v == null ? "" : v).slice(0, n);
	return { path: rel, name: clip(a.name, 200), size: Number(a.size) || 0, mime: clip(a.mime, 120), kind };
}

function sanitizeProduct(p) {
	if (!p || typeof p !== "object") return null;
	const clip = (v, n) => String(v == null ? "" : v).slice(0, n);
	const av = ["in", "out", "preorder", "backorder"].includes(p.availability) ? p.availability : "";

	const out = {
		name: clip(p.name, 200),
		url: safeUrl(p.url),
		sku: clip(p.sku, 80),
		gtin: clip(p.gtin, 20),
		image: safeUrl(p.image),
		description: clip(p.description, 500),
		price: clip(p.price, 40),
		currency: clip(p.currency, 10),
		availability: av,
		inventory: clip(p.inventory, 12),
		brand: clip(p.brand, 120),
		rating: clip(p.rating, 8),
		reviewCount: clip(p.reviewCount, 10),
	};

	if (!out.name) return null;
	return out;
}

function productKeyOf(p) {
	if (p.sku) return String(p.sku).slice(0, 255);
	const u = String(p.url || "").trim();
	if (!u) return "";
	try {
		const url = new URL(u);
		return (url.origin + url.pathname).slice(0, 255);
	} catch {
		return u.slice(0, 255);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
//  БАЗА ДАНИХ
// ═══════════════════════════════════════════════════════════════════════════

async function getOrCreateVisitor(uid, siteId) {
	const [rows] = await pool.execute(`SELECT visitor_id FROM ${SESSIONS} WHERE uid = ? AND site_id = ? LIMIT 1`, [uid, siteId]);
	if (rows.length) {
		pool.execute(`UPDATE ${SESSIONS} SET last_seen = NOW(3) WHERE uid = ? AND site_id = ?`, [uid, siteId]).catch(() => {});
		return rows[0].visitor_id;
	}
	const visitorId = "v_" + crypto.randomBytes(9).toString("hex");
	await pool.execute(`INSERT IGNORE INTO ${SESSIONS} (uid, site_id, visitor_id) VALUES (?, ?, ?)`, [uid, siteId, visitorId]);
	const [again] = await pool.execute(`SELECT visitor_id FROM ${SESSIONS} WHERE uid = ? AND site_id = ? LIMIT 1`, [uid, siteId]);
	return again.length ? again[0].visitor_id : visitorId;
}

async function saveMessage({ siteId, idChat, sender, managerId = null, text, type = "text", clientTs = null, attachment = null, meta = null }) {
	const payload = { text };
	if (attachment) payload.attachment = attachment;
	if (meta && typeof meta === "object") Object.assign(payload, meta);
	const [res] = await pool.execute(
		`INSERT INTO ${TABLE} (site_id, id_chat, sender, manager_id, message, type, client_ts)
         VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?)`,
		[siteId, idChat, sender, managerId, JSON.stringify(payload), type, clientTs]
	);
	return res.insertId;
}

async function saveClientMessage({ siteId, idChat, text, clientTs, clientMsgId, attachment = null }) {
	const payload = attachment ? { text, attachment } : { text };
	const [res] = await pool.execute(
		`INSERT INTO ${TABLE} (site_id, id_chat, sender, message, type, client_ts, client_msg_id)
         VALUES (?, ?, 'client', CAST(? AS JSON), 'text', ?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
		[siteId, idChat, JSON.stringify(payload), clientTs, clientMsgId]
	);
	return { id: res.insertId, isNew: res.affectedRows === 1 };
}

function mapRow(r) {
	const msg = typeof r.message === "string" ? JSON.parse(r.message) : r.message;
	const out = {
		id: r.id,
		from: r.sender,
		text: (msg && msg.text) || "",
		type: r.type,
		clientMsgId: r.client_msg_id || null,
		timestamp: r.date_add,
		editedAt: r.edited_at || null,
		deletedAt: r.deleted_at || null,
	};
	if (msg && msg.attachment && msg.attachment.path) {
		const a = msg.attachment;
		out.attachment = { url: signFileUrl(a.path), name: a.name || "", size: a.size || 0, mime: a.mime || "", kind: a.kind || "file" };
	}
	if (msg && msg.trigger) out.trigger = msg.trigger;
	if (msg && msg.formId) out.formId = msg.formId;
	return out;
}

async function getHistory(siteId, idChat, afterId = 0, limit = 500) {
	const lim = Math.min(parseInt(limit, 10) || 500, 1000);
	const [rows] = await pool.query(
		`SELECT id, sender, manager_id, message, type, client_ts, client_msg_id, date_add, edited_at, deleted_at
           FROM ${TABLE} WHERE site_id = ? AND id_chat = ? AND id > ?
          ORDER BY id ASC LIMIT ${lim}`,
		[siteId, idChat, afterId]
	);
	return rows.map(mapRow);
}

async function getActiveChatsForSites(siteIds) {
	if (!siteIds || !siteIds.length) return [];
	const placeholders = siteIds.map(() => "?").join(",");
	const [rows] = await pool.query(
		`SELECT m.site_id, m.id_chat, MAX(m.id) AS last_id, MAX(m.date_add) AS last_date,
                MAX(COALESCE(c.client_wrote,0)) AS client_wrote,
                MAX(CASE WHEN c.joined_at IS NOT NULL THEN 1 ELSE 0 END) AS operator_joined,
                MAX(c.url_token) AS url_token
           FROM ${TABLE} m
           LEFT JOIN ${CONV} c ON c.site_id = m.site_id AND c.room_id = m.id_chat
          WHERE m.site_id IN (${placeholders})
          GROUP BY m.site_id, m.id_chat
          ORDER BY last_date DESC LIMIT 500`,
		[...siteIds]
	);
	return rows.map((r) => ({
		roomId: r.id_chat,
		siteId: r.site_id,
		lastId: r.last_id,
		lastDate: r.last_date,
		urlToken: r.url_token || "",
		empty: !(Number(r.client_wrote) === 1 || Number(r.operator_joined) === 1),
	}));
}

async function getUnreadCounts(operatorId, siteIds) {
	if (!siteIds || !siteIds.length) return {};
	const placeholders = siteIds.map(() => "?").join(",");
	const [rows] = await pool.query(
		`SELECT m.id_chat AS roomId, COUNT(*) AS cnt
           FROM ${TABLE} m
           LEFT JOIN ${OREADS} r ON r.operator_id = ? AND r.room_id = m.id_chat
          WHERE m.site_id IN (${placeholders}) AND m.sender = 'client' AND m.id > COALESCE(r.last_read_id, 0)
          GROUP BY m.id_chat`,
		[operatorId, ...siteIds]
	);
	const out = {};
	rows.forEach((r) => {
		out[r.roomId] = Number(r.cnt) || 0;
	});
	return out;
}

async function markChatRead(operatorId, siteId, roomId) {
	const [[row]] = await pool.query(`SELECT MAX(id) AS maxId FROM ${TABLE} WHERE site_id = ? AND id_chat = ?`, [siteId, roomId]);
	const maxId = row && row.maxId ? row.maxId : 0;
	await pool.execute(
		`INSERT INTO ${OREADS} (operator_id, room_id, site_id, last_read_id) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE last_read_id = GREATEST(last_read_id, VALUES(last_read_id))`,
		[operatorId, roomId, siteId, maxId]
	);
	return maxId;
}

async function saveClientRead(siteId, roomId, lastReadId) {
	await pool.execute(
		`INSERT INTO ${CREADS} (room_id, site_id, last_read_id) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE last_read_id = GREATEST(last_read_id, VALUES(last_read_id))`,
		[roomId, siteId, lastReadId]
	);
}

// До якого ID операторv прочитали повідомлення клієнта.
// Береться максимум по всіх операторах: якщо прочитав хоч один — прочитано.
async function getOperatorLastRead(siteId, roomId) {
	const [rows] = await pool.execute(`SELECT MAX(last_read_id) AS last FROM ${OREADS} WHERE room_id = ? AND site_id = ? LIMIT 1`, [roomId, siteId]);
	return rows.length && rows[0].last ? Number(rows[0].last) : 0;
}

async function getClientLastRead(siteId, roomId) {
	const [rows] = await pool.execute(`SELECT last_read_id FROM ${CREADS} WHERE room_id = ? AND site_id = ? LIMIT 1`, [roomId, siteId]);
	return rows.length ? Number(rows[0].last_read_id) || 0 : 0;
}

// ── Конференції / стан розмови ──
async function getConversation(siteId, roomId) {
	const [rows] = await pool.execute(
		`SELECT status, operator_id, joined_at, closed_at, rating, rating_comment, rated_at, client_wrote
           FROM ${CONV} WHERE site_id = ? AND room_id = ? LIMIT 1`,
		[siteId, roomId]
	);
	return rows.length ? rows[0] : null;
}

async function joinConversation(siteId, roomId, operatorId) {
	await ensureConversation(siteId, roomId);
	const [res] = await pool.execute(
		`UPDATE ${CONV} SET operator_id = ?, joined_at = COALESCE(joined_at, NOW(3)), status = 'open'
          WHERE site_id = ? AND room_id = ? AND operator_id IS NULL AND status = 'open'`,
		[operatorId, siteId, roomId]
	);
	const conv = await getConversation(siteId, roomId);
	return { conv, claimedNow: res.affectedRows > 0 };
}

async function closeConversation(siteId, roomId, operatorId) {
	const [res] = await pool.execute(
		`UPDATE ${CONV} SET status = 'closed', closed_at = NOW(3), operator_id = NULL
          WHERE site_id = ? AND room_id = ? AND status = 'open' AND operator_id = ?`,
		[siteId, roomId, operatorId]
	);
	return res.affectedRows > 0;
}

async function releaseConversation(siteId, roomId, operatorId) {
	await pool.execute(`UPDATE ${CONV} SET operator_id = NULL WHERE site_id = ? AND room_id = ? AND operator_id = ? AND status = 'open'`, [siteId, roomId, operatorId]);
}

async function reopenIfClosed(siteId, roomId) {
	const [res] = await pool.execute(
		`UPDATE ${CONV} SET status = 'open', operator_id = NULL, closed_at = NULL, offline_ack_at = NULL
          WHERE site_id = ? AND room_id = ? AND status IN ('closed','archived')`,
		[siteId, roomId]
	);
	return res.affectedRows > 0;
}

async function archiveConversation(siteId, roomId) {
	const [res] = await pool.execute(
		`UPDATE ${CONV} SET status = 'archived', operator_id = NULL
          WHERE site_id = ? AND room_id = ? AND status IN ('open','closed')`,
		[siteId, roomId]
	);
	return res.affectedRows > 0;
}

async function claimOfflineNotice(siteId, roomId) {
	await pool.execute(`INSERT INTO ${CONV} (site_id, room_id, status) VALUES (?, ?, 'open') ON DUPLICATE KEY UPDATE id = id`, [siteId, roomId]);
	const [res] = await pool.execute(`UPDATE ${CONV} SET offline_ack_at = NOW(3) WHERE site_id = ? AND room_id = ? AND offline_ack_at IS NULL`, [siteId, roomId]);
	return res.affectedRows > 0;
}

async function markClientWrote(siteId, roomId) {
	await pool.execute(
		`INSERT INTO ${CONV} (site_id, room_id, url_token, status, client_wrote) VALUES (?, ?, ?, 'open', 1)
         ON DUPLICATE KEY UPDATE client_wrote = 1`,
		[siteId, roomId, genUrlToken()]
	);
}

async function rateConversation(siteId, roomId, rating, comment) {
	const [res] = await pool.execute(
		`UPDATE ${CONV} SET rating = ?, rating_comment = ?, rated_at = NOW(3)
          WHERE site_id = ? AND room_id = ? AND status = 'closed' AND joined_at IS NOT NULL AND rated_at IS NULL`,
		[rating, comment, siteId, roomId]
	);
	return res.affectedRows > 0;
}

// ── Редагування/видалення ──
async function getMessageRow(siteId, roomId, id) {
	const [rows] = await pool.execute(`SELECT id, site_id, id_chat, sender, type, deleted_at FROM ${TABLE} WHERE site_id = ? AND id_chat = ? AND id = ? LIMIT 1`, [siteId, roomId, id]);
	return rows.length ? rows[0] : null;
}
async function softDeleteMessage(siteId, roomId, id) {
	await pool.execute(`UPDATE ${TABLE} SET deleted_at = NOW(3) WHERE site_id = ? AND id_chat = ? AND id = ? AND deleted_at IS NULL`, [siteId, roomId, id]);
}
async function editMessage(siteId, roomId, id, text) {
	await pool.execute(`UPDATE ${TABLE} SET message = JSON_SET(message, '$.text', ?), edited_at = NOW(3) WHERE site_id = ? AND id_chat = ? AND id = ? AND deleted_at IS NULL`, [text, siteId, roomId, id]);
}

// ── Сайти / домени (кеш 60с) ──
let sitesCache = { at: 0, map: new Map() };
async function getSites() {
	if (Date.now() - sitesCache.at < 60000 && sitesCache.map.size) return sitesCache.map;
	const [rows] = await pool.query(`SELECT site_id, domains FROM ${SITES} WHERE active = 1`);
	const map = new Map();
	rows.forEach((r) =>
		map.set(
			r.site_id,
			String(r.domains)
				.split(",")
				.map((d) => d.trim().toLowerCase())
				.filter(Boolean)
		)
	);
	sitesCache = { at: Date.now(), map };
	return map;
}

async function getAllSites() {
	const [rows] = await pool.query(`SELECT site_id, domains FROM ${SITES} WHERE active = 1`);
	return rows.map((r) => ({ siteId: r.site_id, domains: r.domains }));
}

async function domainAllowedForSite(siteId, host) {
	if (!siteId || !host) return false;
	const sites = await getSites();
	const domains = sites.get(siteId);
	return !!domains && matchDomain(host, domains);
}

// ── Ліди ──
function validEmail(s) {
	return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.length <= 200;
}
function validPhone(s) {
	if (typeof s !== "string") return false;
	return /^[+\d][\d\s()\-]{6,19}$/.test(s.trim());
}

async function saveLead({ siteId, roomId, visitorId, name, email, phone, trigger, pageUrl, formId, answers }) {
	const [res] = await pool.execute(
		`INSERT INTO ${LEADS} (site_id, room_id, visitor_id, name, email, phone, \`trigger\`, page_url, form_id, answers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
		[siteId, roomId, visitorId, name || null, email || null, phone || null, trigger || null, pageUrl || null, formId || null, JSON.stringify(answers || {})]
	);
	return res.insertId;
}

async function hasLead(siteId, roomId) {
	const [rows] = await pool.execute(`SELECT 1 FROM ${LEADS} WHERE site_id = ? AND room_id = ? LIMIT 1`, [siteId, roomId]);
	return rows.length > 0;
}

async function hasLeadPrompt(siteId, roomId) {
	const [rows] = await pool.execute(`SELECT 1 FROM ${TABLE} WHERE site_id = ? AND id_chat = ? AND type = 'lead_prompt' AND deleted_at IS NULL LIMIT 1`, [siteId, roomId]);
	return rows.length > 0;
}

async function getLeadsForRoom(siteId, roomId) {
	const [rows] = await pool.execute(
		`SELECT id, name, email, phone, \`trigger\`, form_id, answers, date_add
           FROM ${LEADS} WHERE site_id = ? AND room_id = ? ORDER BY id DESC`,
		[siteId, roomId]
	);
	return rows.map((r) => ({
		...r,
		answers: r.answers ? (typeof r.answers === "string" ? JSON.parse(r.answers) : r.answers) : null,
	}));
}

// ── Візитна мета ──
async function saveVisitorMeta(siteId, visitorId, data) {
	await pool.execute(
		`INSERT INTO ${VMETA} (site_id, visitor_id, data, first_data)
         VALUES (?, ?, CAST(? AS JSON), CAST(? AS JSON))
         ON DUPLICATE KEY UPDATE data = CAST(? AS JSON), first_data = COALESCE(first_data, CAST(? AS JSON))`,
		[siteId, visitorId, JSON.stringify(data), JSON.stringify(data), JSON.stringify(data), JSON.stringify(data)]
	);
}

async function getVisitorMeta(siteId, visitorId) {
	const [rows] = await pool.execute(`SELECT data, first_data, first_seen FROM ${VMETA} WHERE site_id = ? AND visitor_id = ? LIMIT 1`, [siteId, visitorId]);
	if (!rows.length) return null;
	const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
	return {
		data: parse(rows[0].data),
		firstData: rows[0].first_data ? parse(rows[0].first_data) : null,
		firstSeen: rows[0].first_seen,
	};
}

async function getFirstEventTime(siteId, roomId) {
	const [rows] = await pool.execute(`SELECT date_add FROM ${TABLE} WHERE site_id = ? AND id_chat = ? ORDER BY id ASC LIMIT 1`, [siteId, roomId]);
	return rows.length ? rows[0].date_add : null;
}

// ── Товари (перегляди) ──
async function upsertProductView(siteId, visitorId, product) {
	const key = productKeyOf(product);
	if (!key) return;
	await pool.execute(
		`INSERT INTO ${VPRODUCTS} (site_id, visitor_id, product_key, product)
         VALUES (?, ?, ?, CAST(? AS JSON))
         ON DUPLICATE KEY UPDATE product = CAST(? AS JSON), views = views + 1, last_viewed = NOW(3)`,
		[siteId, visitorId, key, JSON.stringify(product), JSON.stringify(product)]
	);
}

async function getProductHistory(siteId, visitorId, cursor = null, limit = 20) {
	const lim = Math.min(parseInt(limit, 10) || 20, 50);
	let rows;
	if (cursor) {
		[rows] = await pool.query(
			`SELECT id, product, views, first_viewed, last_viewed FROM ${VPRODUCTS}
              WHERE site_id = ? AND visitor_id = ? AND last_viewed < ?
              ORDER BY last_viewed DESC, id DESC LIMIT ${lim}`,
			[siteId, visitorId, cursor]
		);
	} else {
		[rows] = await pool.query(
			`SELECT id, product, views, first_viewed, last_viewed FROM ${VPRODUCTS}
              WHERE site_id = ? AND visitor_id = ?
              ORDER BY last_viewed DESC, id DESC LIMIT ${lim}`,
			[siteId, visitorId]
		);
	}
	return rows.map((r) => ({
		product: typeof r.product === "string" ? JSON.parse(r.product) : r.product,
		views: r.views,
		firstViewed: r.first_viewed,
		lastViewed: r.last_viewed,
	}));
}

// ── Push ──
async function savePushSub(operatorId, sub, userAgent) {
	if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return false;
	await pool.execute(
		`INSERT INTO ${PUSHSUBS} (operator_id, endpoint, p256dh, auth, user_agent)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE operator_id = VALUES(operator_id), p256dh = VALUES(p256dh), auth = VALUES(auth), user_agent = VALUES(user_agent)`,
		[operatorId, String(sub.endpoint).slice(0, 500), String(sub.keys.p256dh).slice(0, 255), String(sub.keys.auth).slice(0, 255), String(userAgent || "").slice(0, 300)]
	);
	return true;
}
async function deletePushSub(endpoint) {
	await pool.execute(`DELETE FROM ${PUSHSUBS} WHERE endpoint = ?`, [String(endpoint).slice(0, 500)]);
}
async function sendPushToOperator(operatorId, payload) {
	const [rows] = await pool.execute(`SELECT endpoint, p256dh, auth FROM ${PUSHSUBS} WHERE operator_id = ?`, [operatorId]);
	if (!rows.length) return;
	const data = JSON.stringify(payload);
	await Promise.all(
		rows.map(async (r) => {
			const subscription = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
			try {
				await webpush.sendNotification(subscription, data);
			} catch (e) {
				if (e.statusCode === 404 || e.statusCode === 410) await deletePushSub(r.endpoint).catch(() => {});
				else console.error("push send:", e.statusCode || e.message);
			}
		})
	);
}

// ── Видалення чату ──
async function deleteChat(siteId, roomId) {
	const visitorId = roomId.slice(siteId.length + 1);
	try {
		const [frows] = await pool.query(`SELECT message FROM ${TABLE} WHERE site_id = ? AND id_chat = ?`, [siteId, roomId]);
		frows.forEach((r) => {
			try {
				const m = typeof r.message === "string" ? JSON.parse(r.message) : r.message;
				const p = m && m.attachment && m.attachment.path;
				const rel = p ? safeRelPath(p) : null;
				if (rel) {
					const abs = path.join(WC_UPLOAD_DIR, rel);
					if (abs.startsWith(path.resolve(WC_UPLOAD_DIR) + path.sep) && fs.existsSync(abs)) fs.unlinkSync(abs);
				}
			} catch {}
		});
	} catch (e) {
		console.error("deleteChat files:", e.message);
	}

	await pool.execute(`DELETE FROM ${TABLE} WHERE site_id = ? AND id_chat = ?`, [siteId, roomId]);
	await pool.execute(`DELETE FROM ${VMETA} WHERE site_id = ? AND visitor_id = ?`, [siteId, visitorId]);
	await pool.execute(`DELETE FROM ${SESSIONS} WHERE site_id = ? AND visitor_id = ?`, [siteId, visitorId]);
	await pool.execute(`DELETE FROM ${VPRODUCTS} WHERE site_id = ? AND visitor_id = ?`, [siteId, visitorId]);
	await pool.execute(`DELETE FROM ${OREADS} WHERE site_id = ? AND room_id = ?`, [siteId, roomId]);
	await pool.execute(`DELETE FROM ${LEADS} WHERE site_id = ? AND room_id = ?`, [siteId, roomId]);
	await pool.execute(`DELETE FROM ${CONV} WHERE site_id = ? AND room_id = ?`, [siteId, roomId]);
}

// ── canModifyMessage (гейт редагування) ──
function canModifyMessage(socket, row) {
	const d = socket.data || {};
	if (d.role !== "operator") return false;
	if (!row) return false;
	if (row.sender !== "operator") return false;
	if (row.type !== "text") return false;
	if (row.deleted_at) return false;
	return true;
}

// ═══════════════════════════════════════════════════════════════════════════
//  КОНФІГ ВІДЖЕТА
// ═══════════════════════════════════════════════════════════════════════════

const FIELD_TYPES = ["text", "email", "tel", "textarea", "select", "choice", "checkbox", "hidden"];
const CONTACT_FIELD_TYPES = ["email", "tel"];
const POSITIONS = ["left", "right"];
const FORCE_MODES = ["auto", "online", "offline"];

function isObj(v) {
	return v && typeof v === "object" && !Array.isArray(v);
}
function isNum(v) {
	return typeof v === "number" && isFinite(v);
}
function isInt(v) {
	return isNum(v) && Math.floor(v) === v;
}
function isStr(v) {
	return typeof v === "string";
}
function isNonEmptyStr(v) {
	return isStr(v) && v.trim().length > 0;
}
function isHexColor(v) {
	return isStr(v) && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
}
function isDateYMD(v) {
	return isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
function isValidTZ(v) {
	if (!isNonEmptyStr(v)) return false;
	try {
		new Intl.DateTimeFormat("en-GB", { timeZone: v });
		return true;
	} catch {
		return false;
	}
}
function isLocaleMap(v) {
	return isObj(v);
}

function pickText(node, locale, primary) {
	if (!isObj(node)) return "";
	if (isNonEmptyStr(node[locale])) return node[locale];
	if (isNonEmptyStr(node[primary])) return node[primary];
	for (const k of Object.keys(node)) if (isNonEmptyStr(node[k])) return node[k];
	return "";
}
function pickLocale(cfg, lang) {
	const loc = (cfg && cfg.locales) || {};
	const enabled = Array.isArray(loc.enabled) ? loc.enabled : [];
	const primary = loc.primary || enabled[0] || "en";
	const wanted = String(lang || "")
		.toLowerCase()
		.split(/[-_]/)[0];
	return enabled.includes(wanted) ? wanted : primary;
}

function collectFormRefs(cfg) {
	const refs = [];
	const t = cfg.triggers || {};
	const push = (cond, path, formId) => {
		if (cond) refs.push({ path, formId });
	};
	["working", "offline"].forEach((g) => {
		const a = (t.autoForm || {})[g] || {};
		push(a.enabled, `triggers.autoForm.${g}.formId`, a.formId);
		const f = (t.onFirstMessage || {})[g] || {};
		push(f.enabled, `triggers.onFirstMessage.${g}.formId`, f.formId);
	});
	const ot = t.onOperatorTimeout || {};
	push(ot.enabled, "triggers.onOperatorTimeout.formId", ot.formId);
	const ac = t.afterClose || {};
	push((ac.form || {}).enabled, "triggers.afterClose.form.formId", (ac.form || {}).formId);
	const pc = (cfg.behavior || {}).preChatForm || {};
	push(pc.enabled, "behavior.preChatForm.formId", pc.formId);
	return refs;
}

function validateConfig(cfg) {
	const errors = [];
	const warnings = [];
	const E = (path, code, message, locale) => errors.push(locale ? { path, code, message, locale } : { path, code, message });
	const W = (path, code, message) => warnings.push({ path, code, message });

	if (!isObj(cfg)) return { ok: false, errors: [{ path: "", code: "bad_type", message: "Конфіг має бути обʼєктом." }], warnings: [] };

	if (!isInt(cfg.version) || cfg.version < 1) E("version", "required", "version має бути цілим числом ≥ 1.");

	const loc = cfg.locales;
	let enabled = [];
	let primary = null;
	if (!isObj(loc)) E("locales", "required", "Відсутній блок locales.");
	else {
		if (!Array.isArray(loc.enabled) || loc.enabled.length === 0) E("locales.enabled", "required", "Має бути хоча б одна мова.");
		else if (loc.enabled.some((x) => !isNonEmptyStr(x))) E("locales.enabled", "bad_type", "Коди мов мають бути рядками.");
		else if (new Set(loc.enabled).size !== loc.enabled.length) E("locales.enabled", "duplicate", "Коди мов не мають повторюватися.");
		else enabled = loc.enabled.slice();
		if (!isNonEmptyStr(loc.primary)) E("locales.primary", "required", "Не задано головну мову.");
		else if (enabled.length && !enabled.includes(loc.primary)) E("locales.primary", "primary_not_enabled", "Головна мова має бути серед активних.");
		else primary = loc.primary;
	}

	const hours = cfg.hours;
	if (!isObj(hours)) E("hours", "required", "Відсутній блок hours.");
	else {
		if (!isValidTZ(hours.timezone)) E("hours.timezone", "bad_timezone", "Невалідний часовий пояс (IANA).");
		if (!isObj(hours.schedule)) E("hours.schedule", "required", "Відсутній розклад годин.");
		else {
			for (let d = 1; d <= 7; d++) {
				const day = hours.schedule[String(d)];
				if (day === undefined) continue;
				if (!Array.isArray(day)) {
					E(`hours.schedule.${d}`, "bad_type", "День має бути масивом інтервалів.");
					continue;
				}
				day.forEach((iv, i) => {
					if (!Array.isArray(iv) || iv.length !== 2 || !isNum(iv[0]) || !isNum(iv[1])) E(`hours.schedule.${d}[${i}]`, "bad_range", "Інтервал має бути [початок, кінець].");
					else if (!(iv[0] >= 0 && iv[0] < iv[1] && iv[1] <= 24)) E(`hours.schedule.${d}[${i}]`, "bad_range", "Має бути 0 ≤ початок < кінець ≤ 24.");
				});
			}
		}
		if (hours.holidays !== undefined) {
			if (!Array.isArray(hours.holidays)) E("hours.holidays", "bad_type", "holidays має бути масивом дат.");
			else
				hours.holidays.forEach((x, i) => {
					if (!isDateYMD(x)) E(`hours.holidays[${i}]`, "bad_date", "Дата у форматі YYYY-MM-DD.");
				});
		}
		if (hours.force !== undefined && !FORCE_MODES.includes(hours.force)) E("hours.force", "bad_enum", `force має бути одним із: ${FORCE_MODES.join(", ")}.`);
	}

	const requireLocaleMap = (node, path) => {
		if (!isLocaleMap(node)) {
			E(path, "required", "Відсутній текст.");
			return;
		}
		if (primary && !isNonEmptyStr(node[primary])) E(path, "required", "Немає тексту головною мовою.", primary);
		enabled.forEach((lc) => {
			if (lc === primary) return;
			if (!isNonEmptyStr(node[lc])) E(path, "missing_locale", `Немає перекладу для "${lc}".`, lc);
		});
	};

	const g = cfg.greeting;
	if (isObj(g) && g.enabled) {
		requireLocaleMap(g.working, "greeting.working");
		requireLocaleMap(g.offline, "greeting.offline");
		requireLocaleMap(g.offlineAck, "greeting.offlineAck");
		if (g.autoOpenDelaySec !== undefined && (!isNum(g.autoOpenDelaySec) || g.autoOpenDelaySec < 0)) E("greeting.autoOpenDelaySec", "bad_range", "autoOpenDelaySec має бути ≥ 0.");
	}

	const forms = cfg.forms;
	const formIds = new Set();
	if (forms !== undefined) {
		if (!isObj(forms)) E("forms", "bad_type", "forms має бути обʼєктом-словником.");
		else {
			Object.keys(forms).forEach((fid) => {
				formIds.add(fid);
				const f = forms[fid];
				const base = `forms.${fid}`;
				if (!isObj(f)) {
					E(base, "bad_type", "Форма має бути обʼєктом.");
					return;
				}
				if (!Array.isArray(f.fields) || f.fields.length === 0) E(`${base}.fields`, "required", "Форма має містити хоча б одне поле.");
				else {
					const names = new Set();
					f.fields.forEach((fld, i) => {
						const fb = `${base}.fields[${i}]`;
						if (!isObj(fld)) {
							E(fb, "bad_type", "Поле має бути обʼєктом.");
							return;
						}
						if (!isNonEmptyStr(fld.name)) E(`${fb}.name`, "required", "Поле має мати name.");
						else if (names.has(fld.name)) E(`${fb}.name`, "duplicate", `Дубль поля "${fld.name}".`);
						else names.add(fld.name);
						if (!FIELD_TYPES.includes(fld.type)) E(`${fb}.type`, "bad_enum", `type має бути одним із: ${FIELD_TYPES.join(", ")}.`);
						requireLocaleMap(fld.label, `${fb}.label`);
						if (fld.type === "select" || fld.type === "choice") {
							if (!Array.isArray(fld.options) || fld.options.length === 0) E(`${fb}.options`, "required", "Для select/choice потрібні options.");
							else
								fld.options.forEach((op, oi) => {
									if (!isObj(op) || !isNonEmptyStr(op.value)) E(`${fb}.options[${oi}].value`, "required", "Опція має мати value.");
									requireLocaleMap(op && op.label, `${fb}.options[${oi}].label`);
								});
						}
					});
					if (f.requireAnyOf !== undefined) {
						if (!Array.isArray(f.requireAnyOf)) E(`${base}.requireAnyOf`, "bad_type", "requireAnyOf має бути масивом.");
						else
							f.requireAnyOf.forEach((n, i) => {
								if (!names.has(n)) E(`${base}.requireAnyOf[${i}]`, "unknown_field", `Поле "${n}" не існує у формі.`);
							});
					}
					if (f.target === "lead") {
						const hasContact = f.fields.some((x) => CONTACT_FIELD_TYPES.includes(x.type)) || (Array.isArray(f.requireAnyOf) && f.requireAnyOf.length > 0);
						if (!hasContact) E(`${base}`, "lead_form_no_contact", "Форма-лід має містити email/tel або requireAnyOf.");
					}
				}
				["submitLabel", "dismissLabel", "successText", "intro"].forEach((k) => {
					if (f[k] !== undefined) requireLocaleMap(f[k], `${base}.${k}`);
				});
			});
		}
	}

	const t = cfg.triggers || {};
	const checkTrigger = (node, path, opt) => {
		const o = opt || {};
		if (!isObj(node) || !node.enabled) return;
		if (node.afterSec !== undefined || o.needAfterSecPositive) {
			if (!isNum(node.afterSec) || node.afterSec < 0) E(`${path}.afterSec`, "bad_range", "afterSec має бути ≥ 0.");
			else if (o.needAfterSecPositive && node.afterSec <= 0) E(`${path}.afterSec`, "bad_range", "afterSec має бути > 0.");
		}
		if (node.message !== undefined) requireLocaleMap(node.message, `${path}.message`);
		else E(`${path}.message`, "required", "Потрібен текст message.");
	};
	["working", "offline"].forEach((gk) => {
		if (isObj(t.autoForm)) checkTrigger(t.autoForm[gk], `triggers.autoForm.${gk}`);
		if (isObj(t.onFirstMessage)) checkTrigger(t.onFirstMessage[gk], `triggers.onFirstMessage.${gk}`);
	});
	if (isObj(t.onOperatorTimeout)) checkTrigger(t.onOperatorTimeout, "triggers.onOperatorTimeout", { needAfterSecPositive: true });
	if (isObj(t.afterClose)) {
		if (isObj(t.afterClose.review) && t.afterClose.review.enabled) requireLocaleMap(t.afterClose.review.message, "triggers.afterClose.review.message");
		if (isObj(t.afterClose.form) && t.afterClose.form.enabled) checkTrigger(t.afterClose.form, "triggers.afterClose.form");
	}

	collectFormRefs(cfg).forEach(({ path, formId }) => {
		if (!isNonEmptyStr(formId)) E(path, "required", "Не вказано formId.");
		else if (!formIds.has(formId)) E(path, "unknown_form_ref", `Форма "${formId}" не існує.`);
	});

	const ap = cfg.appearance;
	if (isObj(ap)) {
		if (ap.brandColor !== undefined && !isHexColor(ap.brandColor)) E("appearance.brandColor", "bad_color", "brandColor має бути hex-кольором.");
		if (ap.position !== undefined && !POSITIONS.includes(ap.position)) E("appearance.position", "bad_enum", `position: ${POSITIONS.join(" | ")}.`);
		["headerTitle", "headerSubtitle", "launcherText"].forEach((k) => {
			if (ap[k] !== undefined) requireLocaleMap(ap[k], `appearance.${k}`);
		});
	}
	const bh = cfg.behavior;
	if (isObj(bh) && isObj(bh.uploads) && bh.uploads.enabled) {
		if (bh.uploads.maxMb !== undefined && (!isNum(bh.uploads.maxMb) || bh.uploads.maxMb <= 0)) E("behavior.uploads.maxMb", "bad_range", "maxMb має бути > 0.");
	}

	const usedForms = new Set(collectFormRefs(cfg).map((r) => r.formId));
	formIds.forEach((fid) => {
		if (!usedForms.has(fid)) W(`forms.${fid}`, "unused_form", "Форма не використовується жодним тригером.");
	});

	return { ok: errors.length === 0, errors, warnings };
}

// ── Читання / запис конфіга (кеш 60с) ──
let widgetCfgCache = { at: 0, map: new Map() };
function bustWidgetCfg(siteId) {
	if (siteId) widgetCfgCache.map.delete(siteId);
	else widgetCfgCache = { at: 0, map: new Map() };
}

async function getWidgetConfig(siteId) {
	const cached = widgetCfgCache.map.get(siteId);
	if (cached && Date.now() - cached.at < 60000) return cached.cfg;
	let cfg = null;
	try {
		const [rows] = await pool.execute(`SELECT config FROM ${SITES} WHERE site_id = ? AND active = 1 LIMIT 1`, [siteId]);
		if (rows.length && rows[0].config != null) {
			cfg = typeof rows[0].config === "string" ? JSON.parse(rows[0].config) : rows[0].config;
		}
	} catch (e) {
		console.error("getWidgetConfig parse:", e.message);
		cfg = null;
	}
	widgetCfgCache.map.set(siteId, { at: Date.now(), cfg });
	return cfg;
}

async function saveWidgetConfig(siteId, cfg) {
	const result = validateConfig(cfg);
	if (!result.ok) return result;
	await pool.execute(`UPDATE ${SITES} SET config = CAST(? AS JSON) WHERE site_id = ?`, [JSON.stringify(cfg), siteId]);
	bustWidgetCfg(siteId);
	return result;
}

// ── Похідні налаштування для бойового коду ──
async function getSiteConfig(siteId) {
	const cfg = await getWidgetConfig(siteId);
	const timeoutTrig = cfg && cfg.triggers && cfg.triggers.onOperatorTimeout;
	return {
		productCard: !!(cfg.productCard && cfg.productCard.enabled),
		brandColor: safeColor(cfg && cfg.appearance && cfg.appearance.brandColor),
		leadTimeoutSec: timeoutTrig && timeoutTrig.enabled ? Number(timeoutTrig.afterSec) || 0 : 0,
		config: cfg || {},
	};
}

// Отримувачі живуть у notif_subscriptions на рівні каналу контакт-центру —
// одне джерело правди для всіх каналів, не дублюємо їх у config сайту.
async function getNotifyTopic(siteId) {
	try {
		const [rows] = await pool.query(`SELECT id_channel FROM ${prefix}contact_center_channel_webchat WHERE site_id = ? LIMIT 1`, [siteId]);
		return rows.length ? "contact_center.channel." + rows[0].id_channel : null;
	} catch (e) {
		console.error("getNotifyTopic:", e.message);
		return null;
	}
}

// ── Години роботи з конфіга ──
async function isWorkingNowSite(siteId) {
	const cfg = await getWidgetConfig(siteId);
	const hours = cfg && cfg.hours;
	if (!hours) {
		console.error("isWorkingNowSite: no config for site", siteId);
		return false;
	}

	if (hours.force === "online") return true;
	if (hours.force === "offline") return false;

	const tz = hours.timezone || "Europe/Kyiv";
	try {
		const fmt = new Intl.DateTimeFormat("en-GB", {
			timeZone: tz,
			weekday: "short",
			hour: "numeric",
			minute: "numeric",
			hour12: false,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
		const parts = fmt.formatToParts(new Date());
		const get = (ty) => (parts.find((p) => p.type === ty) || {}).value;
		const ymd = `${get("year")}-${get("month")}-${get("day")}`;
		if (Array.isArray(hours.holidays) && hours.holidays.includes(ymd)) return false;
		const wdMap = { Mon: "1", Tue: "2", Wed: "3", Thu: "4", Fri: "5", Sat: "6", Sun: "7" };
		const wd = wdMap[get("weekday")];
		let hour = parseInt(get("hour"), 10);
		if (hour === 24) hour = 0;
		const minute = parseInt(get("minute"), 10) || 0;
		const nowH = hour + minute / 60;
		const day = (hours.schedule || {})[wd];
		if (!Array.isArray(day)) return false;
		return day.some((iv) => Array.isArray(iv) && iv.length === 2 && nowH >= iv[0] && nowH < iv[1]);
	} catch (e) {
		console.error("isWorkingNowSite error:", e.message);
		return true;
	}
}

// ── Безпечна проєкція конфіга для клієнта ──
async function publicConfigFor(siteId, lang) {
	const cfg = await getWidgetConfig(siteId);
	if (!cfg) return null;
	const locale = pickLocale(cfg, lang);
	const primary = cfg.locales && cfg.locales.primary;
	const T = (node) => pickText(node, locale, primary);
	const ap = cfg.appearance || {};
	const g = cfg.greeting || {};
	const workingNow = await isWorkingNowSite(siteId);
	const greetingState =
		g && g.enabled
			? {
					enabled: true,
					autoOpen: !!g.autoOpen,
					working: workingNow,
					text: T(workingNow ? g.working : g.offline) || "",
				}
			: { enabled: false };

	const forms = {};
	if (cfg.forms && typeof cfg.forms === "object") {
		for (const [fid, f] of Object.entries(cfg.forms)) {
			if (!f || !Array.isArray(f.fields)) continue;
			forms[fid] = {
				intro: T(f.intro),
				submitLabel: T(f.submitLabel) || "Надіслати",
				dismissLabel: f.dismissLabel !== undefined ? T(f.dismissLabel) : "",
				successText: T(f.successText),
				requireAnyOf: Array.isArray(f.requireAnyOf) ? f.requireAnyOf.slice() : [],
				fields: f.fields.map((fld) => ({
					name: fld.name,
					type: fld.type,
					label: T(fld.label),
					required: !!fld.required,
					options: Array.isArray(fld.options) ? fld.options.map((op) => ({ value: op.value, label: T(op.label) })) : undefined,
				})),
			};
		}
	}

	return {
		locale,
		brandColor: safeColor(ap.brandColor),
		position: ap.position === "left" ? "left" : "right",
		header: { title: T(ap.headerTitle), subtitle: T(ap.headerSubtitle) },
		greeting: {
			enabled: !!g.enabled,
			autoOpen: g.enabled ? g.autoOpen !== false : false,
			autoOpenDelaySec: Math.max(0, Number(g.autoOpenDelaySec) || 0),
			working: workingNow,
			text: g.enabled ? T(workingNow ? g.working : g.offline) || "" : "",
			desktop: {
				autoOpen: g.desktop && typeof g.desktop.autoOpen === "boolean" ? g.desktop.autoOpen : g.autoOpen !== false,
				sound: g.desktop && typeof g.desktop.sound === "boolean" ? g.desktop.sound : true,
			},
			mobile: {
				autoOpen: g.mobile && typeof g.mobile.autoOpen === "boolean" ? g.mobile.autoOpen : g.autoOpen !== false,
				sound: g.mobile && typeof g.mobile.sound === "boolean" ? g.mobile.sound : false,
			},
		},
		forms,
		strings: {
			sendFailed: T((cfg.strings || {}).sendFailed),
			leadNeedContact: T((cfg.strings || {}).leadNeedContact),
			rateLimited: T((cfg.strings || {}).rateLimited),
		},
		ui: {
			inputPlaceholder: T((cfg.ui || {}).inputPlaceholder),
			leadDismissed: T((cfg.ui || {}).leadDismissed),
			leadDone: T((cfg.ui || {}).leadDone),
		},
	};
}

// ── Валідація значень форми (сервер не довіряє клієнту) ──
function validateFormValues(formDef, raw) {
	if (!formDef || !Array.isArray(formDef.fields)) return { ok: false, code: "unknown_form" };
	const input = raw && typeof raw === "object" ? raw : {};
	const values = {};
	for (const fld of formDef.fields) {
		let v = input[fld.name];
		v = v == null ? "" : String(v).trim().slice(0, 2000);
		if (fld.type === "email" && v && !validEmail(v)) return { ok: false, code: "bad_email" };
		if (fld.type === "tel" && v && !validPhone(v)) return { ok: false, code: "bad_phone" };
		if ((fld.type === "select" || fld.type === "choice") && v) {
			const opts = Array.isArray(fld.options) ? fld.options.map((o) => String(o.value)) : [];
			if (!opts.includes(v)) return { ok: false, code: "bad_option" };
		}
		if (fld.type === "checkbox") v = v === "true" || v === "1" || v === "on" ? "true" : "";
		if (fld.required && !v) return { ok: false, code: "required_missing" };
		if (v) values[fld.name] = v;
	}
	if (Array.isArray(formDef.requireAnyOf) && formDef.requireAnyOf.length) {
		const any = formDef.requireAnyOf.some((n) => values[n]);
		if (!any) return { ok: false, code: "need_contact" };
	}
	return { ok: true, values };
}

function extractKnownFields(formDef, values) {
	const out = { name: "", email: "", phone: "" };
	for (const fld of formDef.fields || []) {
		const v = values[fld.name];
		if (!v) continue;
		if (fld.type === "email" && !out.email) out.email = v;
		else if (fld.type === "tel" && !out.phone) out.phone = v;
		else if (fld.name === "name" && !out.name) out.name = v;
	}
	return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  PRESENCE / RATE-LIMIT / TELEGRAM
// ═══════════════════════════════════════════════════════════════════════════

const RL = { msgPerMin: 20, joinPerIpPerMin: 10, connPerIp: 20, typingMs: 1500 };

const ipConns = new Map();
const ipJoins = new Map();
const onlineClients = new Map(); // roomId → к-ть активних сокетів клієнта
const releaseTimers = new Map(); // `${siteId}|${roomId}` → timeout
const RELEASE_GRACE_MS = 30 * 1000;
const visitorProduct = new Map(); // roomId → товар (presence)

const BAN = { failsPerWindow: 20, windowMs: 10 * 60 * 1000, banMs: 30 * 60 * 1000 };
const ipFails = new Map();
const ipBanned = new Map();

function isBanned(ip) {
	const until = ipBanned.get(ip);
	if (!until) return false;
	if (Date.now() > until) {
		ipBanned.delete(ip);
		return false;
	}
	return true;
}
function noteFail(ip) {
	if (!ip || ip === "unknown") return;
	const now = Date.now();
	let e = ipFails.get(ip);
	if (!e || now > e.resetAt) {
		e = { count: 0, resetAt: now + BAN.windowMs };
		ipFails.set(ip, e);
	}
	e.count++;
	if (e.count >= BAN.failsPerWindow) {
		ipBanned.set(ip, now + BAN.banMs);
		ipFails.delete(ip);
		console.warn("web-chat IP banned:", ip);
	}
}
function hitLimit(map, key, limit, windowMs = 60000) {
	const now = Date.now();
	let e = map.get(key);
	if (!e || now > e.resetAt) {
		e = { count: 0, resetAt: now + windowMs };
		map.set(key, e);
	}
	e.count++;
	return e.count > limit;
}
function ipOf(socket) {
	const fwd = socket.handshake.headers["x-forwarded-for"];
	if (fwd) {
		const parts = String(fwd).split(",");
		return parts[parts.length - 1].trim() || socket.handshake.address || "unknown";
	}
	return socket.handshake.address || "unknown";
}
function clientIpFromReq(req) {
	const fwd = req && req.headers && req.headers["x-forwarded-for"];
	if (fwd) {
		const p = String(fwd).split(",");
		return p[p.length - 1].trim() || (req.socket && req.socket.remoteAddress) || "unknown";
	}
	return (req && req.socket && req.socket.remoteAddress) || "unknown";
}

setInterval(() => {
	const now = Date.now();
	for (const [k, v] of ipJoins) if (now > v.resetAt) ipJoins.delete(k);
	for (const [k, v] of ipConns) if (v <= 0) ipConns.delete(k);
	for (const [k, v] of ipFails) if (now > v.resetAt) ipFails.delete(k);
	for (const [k, until] of ipBanned) if (now > until) ipBanned.delete(k);
}, 60000);

// ── Presence операторів (хто онлайн / хто володіє чатом) ──
function isOperatorOnline(operatorId) {
	if (!io) return false;
	for (const [, s] of io.sockets) {
		const d = s.data || {};
		if (d.role === "operator" && d.operatorId === operatorId) return true;
	}
	return false;
}
function isOperatorOwnerOnline(siteId, roomId, operatorId) {
	if (!io) return false;
	for (const [, s] of io.sockets) {
		const sd = s.data || {};
		if (sd.role === "operator" && Number(sd.operatorId) === Number(operatorId) && sd.ownedRooms && sd.ownedRooms.has(roomId) && (sd.sites || []).includes(siteId)) return true;
	}
	return false;
}

// ── Лід: тайм-аут-тригер ──
async function armLeadTimeout(socket) {
	const d = socket.data || {};
	if (d.role !== "client" || !d.roomId) return;
	if (d.leadShownTimeout) return;
	if (d.leadDone) return;
	const cfg = await getSiteConfig(d.siteId);
	const sec = cfg.leadTimeoutSec | 0;
	const working = await isWorkingNowSite(d.siteId);
	if (sec <= 0) return;
	if (!working) return;
	clearLeadTimeout(socket);
	d.leadTimer = setTimeout(async () => {
		if (!socket.connected) return;
		d.leadShownTimeout = true;
		try {
			await sendLeadPrompt(d.siteId, d.roomId, "timeout", d.lang);
		} catch (e) {
			console.error("lead prompt:", e.message);
		}
	}, sec * 1000);
}
function clearLeadTimeout(socket) {
	const d = socket.data || {};
	if (d.leadTimer) {
		clearTimeout(d.leadTimer);
		d.leadTimer = null;
	}
}

// ── Лід-форми як повідомлення ──
async function sendLeadPrompt(siteId, roomId, trigger, lang, source) {
	const tr = trigger === "offline" ? "offline" : "timeout";
	if (await hasLead(siteId, roomId)) return;
	if (await hasLeadPrompt(siteId, roomId)) return;
	const cfg = await getWidgetConfig(siteId);
	const T = cfg && cfg.triggers;
	let trig;
	if (source === "autoForm") trig = T && T.autoForm && (tr === "offline" ? T.autoForm.offline : T.autoForm.working);
	else if (source === "onFirstMessageWorking") trig = T && T.onFirstMessage && T.onFirstMessage.working;
	else trig = tr === "offline" ? T && T.onFirstMessage && T.onFirstMessage.offline : T && T.onOperatorTimeout;
	const primary = cfg && cfg.locales && cfg.locales.primary;
	const title = trig ? pickText(trig.message, pickLocale(cfg, lang), primary) : "";
	if (!title) return;
	const formId = (trig && trig.formId) || "contact";
	const id = await saveMessage({ siteId, idChat: roomId, sender: "operator", managerId: 0, text: title, type: "lead_prompt", meta: { trigger: tr, formId } });
	io.to(roomId).emit("client:message", { id, text: title, leadPrompt: true, trigger: tr, formId, timestamp: new Date().toISOString() });
	io.to(`operators_${siteId}`).emit("operator:message", { roomId, siteId, message: { id, from: "operator", text: title, type: "lead_prompt" } });
}

async function scheduleOfflineLead(siteId, roomId, lang) {
	const cfg = await getWidgetConfig(siteId);
	const trig = cfg && cfg.triggers && cfg.triggers.onFirstMessage && cfg.triggers.onFirstMessage.offline;
	if (!trig || !trig.enabled) return;
	const delayMs = Math.max(0, Number(trig.afterSec) || 0) * 1000;
	setTimeout(() => {
		sendLeadPrompt(siteId, roomId, "offline", lang).catch((e) => console.error("offline lead:", e.message));
	}, delayMs);
}

async function scheduleFirstMessageForm(siteId, roomId, lang) {
	const cfg = await getWidgetConfig(siteId);
	const trig = cfg && cfg.triggers && cfg.triggers.onFirstMessage && cfg.triggers.onFirstMessage.working;
	if (!trig || !trig.enabled) return;
	const delayMs = Math.max(0, Number(trig.afterSec) || 0) * 1000;
	setTimeout(() => {
		sendLeadPrompt(siteId, roomId, "timeout", lang, "onFirstMessageWorking").catch((e) => console.error("firstMessage form:", e.message));
	}, delayMs);
}

async function scheduleAutoForm(socket, siteId, roomId, lang) {
	const cfg = await getWidgetConfig(siteId);
	const af = cfg && cfg.triggers && cfg.triggers.autoForm;
	if (!af) return;
	const working = await isWorkingNowSite(siteId);
	const node = working ? af.working : af.offline;
	if (!node || !node.enabled) return;
	const delayMs = Math.max(0, Number(node.afterSec) || 0) * 1000;
	const trig = working ? "timeout" : "offline";
	setTimeout(() => {
		if (!socket.connected) return;
		sendLeadPrompt(siteId, roomId, trig, lang, "autoForm").catch((e) => console.error("autoForm:", e.message));
	}, delayMs);
}

// ── Telegram-сповіщення чату (опційно) ──
async function sendTelegram(text) {
	if (!TG_TOKEN) return;
	try {
		const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: TG_CHAT_ID, message_thread_id: TG_THREAD_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
		});
		if (!res.ok) console.error("telegram http", res.status);
	} catch (e) {
		console.error("telegram error:", e.message);
	}
}

// ─── Namespace-хендлер (заповнимо наступними кроками) ─────────────────────────
let io = null; // namespace /webchat (встановлюється в bindSocket)

function bindSocket(nsp) {
	io = nsp;

	// ── Middleware: бан/ліміт з'єднань на IP ──
	nsp.use((socket, next) => {
		const ip = ipOf(socket);
		if (isBanned(ip)) return next(new Error("forbidden"));
		const n = (ipConns.get(ip) || 0) + 1;
		if (n > RL.connPerIp) {
			noteFail(ip);
			return next(new Error("too many connections"));
		}
		ipConns.set(ip, n);
		socket.data = { ip };
		next();
	});

	nsp.on("connection", (socket) => {
		// ─────────── КЛІЄНТ ───────────
		socket.on("client:join", async ({ siteId, fallbackUid, lang, meta } = {}) => {
			if (!siteId || typeof siteId !== "string" || siteId.length > 190) return;
			const ip = socket.data.ip;
			const sites = await getSites();
			if (!sites.has(siteId)) return socket.disconnect(true);
			if (hitLimit(ipJoins, ip, RL.joinPerIpPerMin)) return socket.disconnect(true);

			const cookies = parseCookies(socket.handshake.headers.cookie);
			let uid = UID_RE.test(cookies.lc_uid || "") ? cookies.lc_uid : null;
			let issuedUid;
			if (!uid) {
				if (UID_RE.test(fallbackUid || "")) uid = fallbackUid;
				else {
					uid = newUid();
					issuedUid = uid;
				}
			}

			try {
				const visitorId = await getOrCreateVisitor(uid, siteId);
				const roomId = roomIdOf(siteId, visitorId);

				socket.join(roomId);
				const wasOffline = (onlineClients.get(roomId) || 0) === 0;
				onlineClients.set(roomId, (onlineClients.get(roomId) || 0) + 1);
				if (wasOffline) ccBridge.presence(siteId, roomId, true).catch(() => {});

				visitorProduct.delete(roomId);
				io.to(`operators_${siteId}`).emit("operator:visitor_product", { roomId, siteId, product: null });
				ccBridge.product(siteId, roomId, null).catch(() => {});

				Object.assign(socket.data, {
					role: "client",
					siteId,
					visitorId,
					roomId,
					uid,
					msgs: null,
					lastTyping: 0,
					lang: typeof lang === "string" ? lang.slice(0, 10) : "",
				});

				const h = socket.handshake.headers;
				const clientMeta = meta && typeof meta === "object" ? meta : {};
				const clip = (v, n) => String(v || "").slice(0, n);
				const fullMeta = {
					ip,
					userAgent: clip(h["user-agent"], 400),
					acceptLang: clip(h["accept-language"], 200),
					serverTime: new Date().toISOString(),
					pageUrl: clip(clientMeta.pageUrl, 500),
					referrer: clip(clientMeta.referrer, 500),
					utm: {
						source: clip(clientMeta.utm_source, 120),
						medium: clip(clientMeta.utm_medium, 120),
						campaign: clip(clientMeta.utm_campaign, 200),
						term: clip(clientMeta.utm_term, 200),
						content: clip(clientMeta.utm_content, 200),
						gclid: clip(clientMeta.gclid, 200),
						fbclid: clip(clientMeta.fbclid, 200),
					},
					lang: socket.data.lang,
					languages: clip(clientMeta.languages, 200),
					timezone: clip(clientMeta.timezone, 60),
					screen: clip(clientMeta.screen, 40),
					viewport: clip(clientMeta.viewport, 40),
					pixelRatio: clip(clientMeta.pixelRatio, 10),
					platform: clip(clientMeta.platform, 60),
					cores: clip(clientMeta.cores, 10),
					memory: clip(clientMeta.memory, 10),
					touch: clip(clientMeta.touch, 10),
					connection: clip(clientMeta.connection, 40),
				};
				saveVisitorMeta(siteId, visitorId, fullMeta).catch((e) => console.error("meta save:", e.message));

				io.to(`operators_${siteId}`).emit("operator:visitor_page", { roomId, siteId, pageUrl: fullMeta.pageUrl, at: Date.now() });
				ccBridge.visitorPage(siteId, roomId, fullMeta.pageUrl).catch(() => {});

				const leadAlready = await hasLead(siteId, roomId).catch(() => false);
				socket.data.leadDone = leadAlready;
				const convNow = await getConversation(siteId, roomId).catch(() => null);
				const ratedAlready = !!(convNow && convNow.rated_at != null);
				const publicCfg = await publicConfigFor(siteId, socket.data.lang).catch(() => null);

				const opLastRead = await getOperatorLastRead(siteId, roomId).catch(() => 0);
				socket.emit("client:ready", { issuedUid, leadAlready, rated: ratedAlready, uploadTicket: makeUploadTicket(uid, siteId), config: publicCfg, operatorLastReadId: opLastRead });
				socket.emit("client:history", await getHistory(siteId, roomId));
				io.to(`operators_${siteId}`).emit("operator:new_visitor", { roomId, visitorId, siteId });
				scheduleAutoForm(socket, siteId, roomId, socket.data.lang).catch((e) => console.error("autoForm sched:", e.message));
			} catch (e) {
				console.error("client:join error:", e.message);
				socket.emit("client:error", { code: "join_failed" });
			}
		});

		socket.on("client:message", async ({ text, timestamp, clientMsgId, attachment } = {}) => {
			const d = socket.data || {};
			console.log("[WC] client:message від", d.role, "room:", d.roomId, "site:", d.siteId);
			if (d.role !== "client" || !d.roomId) return;

			const now = Date.now();
			if (!d.msgs || now > d.msgs.resetAt) d.msgs = { count: 0, resetAt: now + 60000 };
			if (++d.msgs.count > RL.msgPerMin) return socket.emit("client:error", { code: "rate_limited", clientMsgId });

			const clean = cleanText(text) || "";
			const att = sanitizeAttachment(attachment);
			if (!clean && !att) return;
			const cmid = /^[a-f0-9-]{36}$/.test(clientMsgId || "") ? clientMsgId : null;
			if (!cmid) {
				noteFail(d.ip);
				return socket.emit("client:error", { code: "bad_id" });
			}

			try {
				const { id, isNew } = await saveClientMessage({ siteId: d.siteId, idChat: d.roomId, text: clean, clientTs: Number(timestamp) || null, clientMsgId: cmid, attachment: att });
				console.log("[WC] client:message saved id=" + id + " isNew=" + isNew + " site=" + d.siteId + " room=" + d.roomId);
				socket.emit("client:ack", { clientMsgId: cmid, id });
				if (isNew) {
					markClientWrote(d.siteId, d.roomId).catch((e) => console.error("client_wrote:", e.message));
					const reopened = await reopenIfClosed(d.siteId, d.roomId).catch(() => false);
					if (reopened) io.to(`operators_${d.siteId}`).emit("operator:conv_state", { roomId: d.roomId, siteId: d.siteId, status: "open", operatorId: null });

					const attOut = att ? { url: signFileUrl(att.path), rel_path: att.path, name: att.name, size: att.size, mime: att.mime, kind: att.kind } : null;

					let _domain = d.siteId;
					try {
						const [drows] = await pool.query(`SELECT domains FROM ${SITES} WHERE site_id = ? LIMIT 1`, [d.siteId]);
						if (drows.length && drows[0].domains) _domain = String(drows[0].domains).split(/[,\s]+/)[0] || d.siteId;
					} catch (e) {}
					const _urlToken = await getUrlToken(d.siteId, d.roomId);
					console.log("[WC] emit operator:message → operators_" + d.siteId, "room:", d.roomId, "isNew:", isNew);
					io.to(`operators_${d.siteId}`).emit("operator:message", { roomId: d.roomId, siteId: d.siteId, domain: _domain, urlToken: _urlToken, message: { id, from: "client", text: clean, attachment: attOut } });
					armLeadTimeout(socket).catch(() => {});

					// Дзеркалимо у спільну схему контакт-центру, щоб діалог
					// з'явився у загальному списку поряд з Telegram
					ccBridge.mirror(d.siteId, d.roomId, "in", { id, text: clean, attachment: attOut, date_add: new Date() }).catch((e) => console.error("[WC mirror] FAIL:", e.message));

					// Єдине сховище нотифікацій: одна подія на повідомлення клієнта (спільна).
					// Персональне прочитання — через notification_reads. type=3 (webchat).
					(async () => {
						try {
							const shortId = String(d.roomId).split("_v_")[1] || d.roomId;
							let domain = "web";
							try {
								const [srows] = await pool.query(`SELECT domains FROM ${SITES} WHERE site_id = ? LIMIT 1`, [d.siteId]);
								if (srows.length && srows[0].domains) domain = String(srows[0].domains).split(/[,\s]+/)[0] || "web";
							} catch (e) {}

							const notifData = {
								channel: "webchat",
								chat_id: d.roomId,
								site_id: d.siteId,
								url_token: await getUrlToken(d.siteId, d.roomId),
								name: domain + " · " + String(shortId).slice(0, 6),
								message: (clean || "").slice(0, 500),
								last_at: new Date().toISOString().slice(0, 19).replace("T", " "),
							};

							// Адресна розсилка обраним отримувачам (config.notifyRecipients)
							const topic = await getNotifyTopic(d.siteId);
							if (topic) {
								// лічильник непрочитаних клієнтських повідомлень по чату
								let unreadCnt = 1;
								try {
									const [[uc]] = await pool.query(
										`SELECT COUNT(*) AS cnt FROM ${TABLE} m
                                         LEFT JOIN ${OREADS} r ON r.room_id = m.id_chat
                                         WHERE m.site_id = ? AND m.id_chat = ? AND m.sender = 'client'
                                           AND m.id > COALESCE((SELECT MAX(last_read_id) FROM ${OREADS} WHERE room_id = m.id_chat), 0)`,
										[d.siteId, d.roomId]
									);
									unreadCnt = uc && uc.cnt ? Number(uc.cnt) : 1;
								} catch (e) {
									console.error("wc unread count:", e.message);
								}

								const basePayload = {
									title: notifData.name,
									message: notifData.message,
									url: `/contact-center/webchat/${notifData.url_token}/`,
									chat_id: d.roomId,
									channel: "webchat",
									date: notifData.last_at,
									count: unreadCnt,
								};
								notifications
									.notify({
										type: "webchat.msg",
										audience: { topic: topic },
										channels: ["inapp"],
										collapseKey: `webchat:${d.roomId}`,
										payload: basePayload,
									})
									.catch((e) => console.error("notify topic:", e.message));
							}
						} catch (e) {
							console.error("notifications insert (webchat):", e.message);
						}
					})();

					(async () => {
						try {
							if (!isOperatorOnline(0)) {
								await sendPushToOperator(0, { title: "Нове повідомлення", body: clean.slice(0, 120), roomId: d.roomId, siteId: d.siteId });
							}
						} catch (e) {
							console.error("push notify:", e.message);
						}
					})();

					const offWorking = await isWorkingNowSite(d.siteId);
					if (!offWorking) {
						const offCfg = await getWidgetConfig(d.siteId);
						const offLocale = pickLocale(offCfg, d.lang);
						const offPrimary = offCfg && offCfg.locales && offCfg.locales.primary;
						const offText = offCfg && offCfg.greeting ? pickText(offCfg.greeting.offlineAck, offLocale, offPrimary) : "";
						// offlineAck = разове ПІДТВЕРДЖЕННЯ на перше повідомлення клієнта в офлайн.
						// Це подія-відповідь → лишається в історії (дата коректна: момент повідомлення).
						if (offText && (await claimOfflineNotice(d.siteId, d.roomId))) {
							const offId = await saveMessage({ siteId: d.siteId, idChat: d.roomId, sender: "operator", managerId: 0, text: offText, type: "offline_notice" });
							io.to(d.roomId).emit("client:message", { id: offId, text: offText, system: true, timestamp: new Date().toISOString() });
							io.to(`operators_${d.siteId}`).emit("operator:message", { roomId: d.roomId, siteId: d.siteId, message: { id: offId, from: "operator", text: offText, type: "offline_notice" } });
							await scheduleOfflineLead(d.siteId, d.roomId, d.lang);
						}
					}

					if (isNew) {
						(async () => {
							if (await isWorkingNowSite(d.siteId)) await scheduleFirstMessageForm(d.siteId, d.roomId, d.lang);
						})().catch((e) => console.error("firstMessage sched:", e.message));
					}

					if (TG_TOKEN) {
						const tgCaption = `💬 <b>Нове повідомлення</b>\n🌐 <code>${esc(d.siteId)}</code>\n👤 <code>${esc(d.visitorId)}</code>\n` + (clean ? `🗨 ${esc(clean)}` : "");
						sendTelegram(tgCaption);
					}
				}
			} catch (e) {
				console.error("client:message error:", e.message);
				socket.emit("client:error", { code: "send_failed", clientMsgId: cmid });
			}
		});

		socket.on("client:preview", ({ text } = {}) => {
			const d = socket.data || {};
			if (d.role !== "client" || !d.roomId) return;
			const preview = String(text || "").slice(0, 500);
			io.to(`operators_${d.siteId}`).emit("operator:preview", { roomId: d.roomId, siteId: d.siteId, text: preview });
			ccBridge.typing(d.siteId, d.roomId, preview);
		});

		socket.on("client:read", async ({ lastReadId } = {}) => {
			const d = socket.data || {};
			if (d.role !== "client" || !d.roomId) return;
			const id = parseInt(lastReadId, 10);
			if (!id || id <= 0) return;
			try {
				await saveClientRead(d.siteId, d.roomId, id);
				io.to(`operators_${d.siteId}`).emit("operator:read_receipt", { roomId: d.roomId, siteId: d.siteId, lastReadId: id });

				// Дзеркалимо у спільну схему — галочка на новій сторінці діалогу
				ccBridge.markRead(d.siteId, d.roomId, id).catch((e) => console.error("[WC read mirror]", e.message));
			} catch (e) {
				console.error("client:read error:", e.message);
			}
		});

		socket.on("client:product", ({ product } = {}) => {
			const d = socket.data || {};
			if (d.role !== "client" || !d.roomId) return;
			const clean = sanitizeProduct(product);
			if (clean) visitorProduct.set(d.roomId, clean);
			else visitorProduct.delete(d.roomId);
			io.to(`operators_${d.siteId}`).emit("operator:visitor_product", { roomId: d.roomId, siteId: d.siteId, product: clean });

			// У нову CRM: current = товар або null (клієнт вийшов з товару)
			ccBridge.product(d.siteId, d.roomId, clean).catch(() => {});

			if (clean) {
				upsertProductView(d.siteId, d.visitorId, clean).catch((e) => console.error("product view:", e.message));
				io.to(`operators_${d.siteId}`).emit("operator:product_history_update", { roomId: d.roomId, siteId: d.siteId, item: { product: clean, views: null, lastViewed: new Date().toISOString() } });
			}
		});

		socket.on("typing", () => {
			const d = socket.data || {};
			if (d.role !== "client" || !d.roomId) return;
			const now = Date.now();
			if (d.lastTyping && now - d.lastTyping < RL.typingMs) return;
			d.lastTyping = now;
			socket.to(d.roomId).emit("typing", { role: "client" });
		});

		// ─────────── КЛІЄНТ: лід і оцінка ───────────
		socket.on("client:lead", async ({ formId, values, trigger } = {}) => {
			const d = socket.data || {};
			if (d.role !== "client" || !d.roomId) return;
			d.leadCount = (d.leadCount || 0) + 1;
			if (d.leadCount > 3) return socket.emit("client:lead_result", { ok: false, code: "too_many" });
			const tr = trigger === "offline" || trigger === "timeout" ? trigger : null;
			try {
				const cfg = await getWidgetConfig(d.siteId);
				const fid = String(formId || "contact");
				const formDef = cfg && cfg.forms && cfg.forms[fid];
				if (!formDef) return socket.emit("client:lead_result", { ok: false, code: "unknown_form" });
				const chk = validateFormValues(formDef, values);
				if (!chk.ok) return socket.emit("client:lead_result", { ok: false, code: chk.code });
				const known = extractKnownFields(formDef, chk.values);
				const pageUrl = (visitorProduct.get(d.roomId) && visitorProduct.get(d.roomId).url) || "";
				const id = await saveLead({ siteId: d.siteId, roomId: d.roomId, visitorId: d.visitorId, name: known.name, email: known.email, phone: known.phone, trigger: tr, pageUrl, formId: fid, answers: chk.values });
				d.leadDone = true;
				try {
					const meta = await getVisitorMeta(d.siteId, d.visitorId);
					const data = meta && meta.data ? meta.data : {};
					data.lead = { ...known, answers: chk.values, formId: fid, at: new Date().toISOString() };
					await saveVisitorMeta(d.siteId, d.visitorId, data);
				} catch (e) {
					console.error("lead meta:", e.message);
				}
				io.to(`operators_${d.siteId}`).emit("operator:lead", { roomId: d.roomId, siteId: d.siteId, lead: { id, ...known, trigger: tr, formId: fid, answers: chk.values } });
				if (TG_TOKEN) {
					const lines = Object.entries(chk.values)
						.map(([k, v]) => `• <b>${esc(k)}</b>: ${esc(v)}`)
						.join("\n");
					sendTelegram(`📇 <b>Новий лід</b>\n🌐 <code>${esc(d.siteId)}</code>\n` + (lines ? lines + "\n" : "") + `👥 <code>${esc(d.visitorId)}</code>`);
				}
				const parts = Object.values(chk.values);
				const confirmText = "Ви залишили дані: " + parts.join(", ") + ". Ми звʼяжемось із вами.";
				const confirmId = await saveMessage({ siteId: d.siteId, idChat: d.roomId, sender: "operator", managerId: 0, text: confirmText, type: "lead_confirm" });
				io.to(d.roomId).emit("client:message", { id: confirmId, text: confirmText, system: true, timestamp: new Date().toISOString() });
				io.to(`operators_${d.siteId}`).emit("operator:message", { roomId: d.roomId, siteId: d.siteId, message: { id: confirmId, from: "operator", text: confirmText, type: "lead_confirm" } });
				socket.emit("client:lead_result", { ok: true });
			} catch (e) {
				console.error("client:lead error:", e.message);
				socket.emit("client:lead_result", { ok: false, code: "save_failed" });
			}
		});

		socket.on("client:rate", async ({ score, comment } = {}) => {
			const d = socket.data || {};
			if (d.role !== "client" || !d.roomId) return;
			const rating = score === 1 || score === "1" || score === "up" ? 1 : score === 0 || score === "0" || score === "down" ? 0 : null;
			if (rating === null) return;
			const cmt = typeof comment === "string" && comment.trim() ? comment.trim().slice(0, 1000) : null;
			try {
				const ok = await rateConversation(d.siteId, d.roomId, rating, cmt);
				if (!ok) return socket.emit("client:rate_result", { ok: false, code: "not_allowed" });
				io.to(d.roomId).emit("client:csat_done", {});
				const label = (rating ? "👍 Позитивна оцінка" : "👎 Негативна оцінка") + (cmt ? ": " + cmt : "");
				const sysId = await saveMessage({ siteId: d.siteId, idChat: d.roomId, sender: "operator", managerId: 0, text: label, type: "csat_result" });
				io.to(`operators_${d.siteId}`).emit("operator:message", { roomId: d.roomId, siteId: d.siteId, message: { id: sysId, from: "operator", text: label, type: "csat_result" } });
				io.to(`operators_${d.siteId}`).emit("operator:conv_rated", { roomId: d.roomId, siteId: d.siteId, rating, comment: cmt || "" });
				socket.emit("client:rate_result", { ok: true });
			} catch (e) {
				console.error("client:rate error:", e.message);
				socket.emit("client:rate_result", { ok: false, code: "save_failed" });
			}
		});

		// ─────────── ОПЕРАТОР ───────────
		socket.on("operator:join", async () => {
			// 1. Беремо токен із handshake (клієнт передає його при io(...))
			const token = (socket.handshake.auth && socket.handshake.auth.token) || "";
			if (!token) return socket.disconnect(true);

			// 2. Перевіряємо токен. Замініть на ваш метод із authorizationControllers.
			//    Приклад (підлаштуйте під ваш API):
			let claims = null;
			try {
				claims = authorizationControllers.verifyToken(token);
			} catch (e) {
				claims = null;
			}
			if (!claims || !claims.userId) return socket.disconnect(true);

			// 3. Перевіряємо, що це саме оператор (або адмін) — залежно від ваших ролей
			//    Наприклад: if (!["operator", "admin", "owner"].includes(claims.role)) return socket.disconnect(true);

			const opId = Number(claims.userId);
			if (!opId) return socket.disconnect(true);

			socket.data = Object.assign(socket.data || {}, { role: "operator", sites: [], operatorId: opId });
			try {
				const sites = await getAllSites();
				socket.data.sites = sites.map((s) => s.siteId);
				socket.data.ownedRooms = new Set();
				try {
					const ph = socket.data.sites.map(() => "?").join(",");
					if (ph) {
						const [owned] = await pool.query(`SELECT site_id, room_id FROM ${CONV} WHERE status = 'open' AND operator_id = ? AND site_id IN (${ph})`, [opId, ...socket.data.sites]);
						owned.forEach((r) => {
							socket.data.ownedRooms.add(r.room_id);
							const key = r.site_id + "|" + r.room_id;
							clearTimeout(releaseTimers.get(key));
							releaseTimers.delete(key);
						});
					}
				} catch (e) {
					console.error("restore owned rooms:", e.message);
				}

				sites.forEach((s) => socket.join(`operators_${s.siteId}`));
				const domainBySite = new Map(sites.map((s) => [s.siteId, s.domains]));
				const all = await getActiveChatsForSites(socket.data.sites);
				all.forEach((c) => {
					c.domain = domainBySite.get(c.siteId);
				});
				socket.emit("operator:sites", sites);
				const onlineList = [...onlineClients.keys()].filter((rid) => socket.data.sites.some((sid) => rid.startsWith(sid + "_")));
				socket.emit("operator:online_list", onlineList);
				socket.emit("operator:active_chats", all);
				const unread = await getUnreadCounts(opId, socket.data.sites);
				socket.emit("operator:unread_counts", unread);
			} catch (e) {
				console.error("operator:join error:", e.message);
			}
		});

		socket.on("operator:open_chat", async ({ roomId, siteId } = {}) => {
			const d = socket.data || {};
			if (d.role !== "operator" || !d.sites || !d.sites.includes(siteId) || !roomBelongsToSite(roomId, siteId)) return;
			try {
				const opMaxRead = await markChatRead(d.operatorId, siteId, roomId).catch(() => 0);
				socket.emit("operator:unread_update", { roomId, count: 0 });

				// Клієнту — щоб намалював галочку «прочитано»
				if (opMaxRead) io.to(roomId).emit("client:read_receipt", { lastReadId: opMaxRead });
				// позначаємо всі нотифікації цього чату прочитаними для цього менеджера
				try {
					await pool.query(
						`INSERT IGNORE INTO ${NOTIF_READS} (notification_id, manager_id)
                         SELECT n.id, ? FROM ${NOTIF} AS n
                         WHERE n.type = 3 AND JSON_UNQUOTE(JSON_EXTRACT(n.data, '$.chat_id')) = ?`,
						[d.operatorId, roomId]
					);
				} catch (e) {
					console.error("notif read (webchat):", e.message);
				}
				// сповістити всі з'єднання цього оператора (список в інших вкладках)
				for (const [, s] of io.sockets) {
					const sd = s.data || {};
					if (sd.role === "operator" && Number(sd.operatorId) === Number(d.operatorId)) {
						s.emit("operator:unread_update", { roomId, count: 0 });
						s.emit("operator:notif_read", { channel: "webchat", chatId: roomId });
					}
				}

				const conv = await getConversation(siteId, roomId).catch(() => null);
				socket.emit("operator:conv_state", { roomId, siteId, status: conv ? conv.status : "open", operatorId: conv && conv.operator_id != null ? Number(conv.operator_id) : null, rating: conv ? conv.rating : null, ratingComment: conv ? conv.rating_comment || "" : "" });
				const visitorId = roomId.slice(siteId.length + 1);
				const [history, meta, firstAt] = await Promise.all([getHistory(siteId, roomId), getVisitorMeta(siteId, visitorId), getFirstEventTime(siteId, roomId)]);
				socket.emit("operator:chat_history", { roomId, history, meta: meta ? meta.data : null, firstData: meta ? meta.firstData : null, firstSeen: meta ? meta.firstSeen : null, firstEventAt: firstAt });
				socket.emit("operator:visitor_product", { roomId, siteId, product: visitorProduct.get(roomId) || null });
				const prodHistory = await getProductHistory(siteId, visitorId, null, 20);
				socket.emit("operator:product_history", { roomId, siteId, items: prodHistory, nextCursor: prodHistory.length === 20 ? prodHistory[prodHistory.length - 1].lastViewed : null });
				const leads = await getLeadsForRoom(siteId, roomId);
				socket.emit("operator:leads", { roomId, siteId, leads });
				const clientLastRead = await getClientLastRead(siteId, roomId);
				socket.emit("operator:read_receipt", { roomId, siteId, lastReadId: clientLastRead });

				const cfgForms = await getWidgetConfig(siteId);
				const primaryLoc = cfgForms && cfgForms.locales && cfgForms.locales.primary;
				socket.emit("operator:forms", {
					roomId,
					siteId,
					forms:
						cfgForms && cfgForms.forms
							? Object.entries(cfgForms.forms).map(([id, f]) => ({
									id,
									label: pickText(f.intro, primaryLoc, primaryLoc) || id,
									fields: Array.isArray(f.fields) ? f.fields.map((fl) => ({ name: fl.name, type: fl.type, label: pickText(fl.label, primaryLoc, primaryLoc) || fl.name })) : [],
								}))
							: [],
				});
			} catch (e) {
				console.error("operator:open_chat error:", e.message);
			}
		});

		socket.on("operator:send_form", async ({ roomId, siteId, formId } = {}) => {
			const d = socket.data || {};
			if (d.role !== "operator" || !d.sites || !d.sites.includes(siteId) || !roomBelongsToSite(roomId, siteId)) return;
			try {
				const cfg = await getWidgetConfig(siteId);
				const fid = String(formId || "contact");
				const formDef = cfg && cfg.forms && cfg.forms[fid];
				if (!formDef) return;
				// мова клієнта: беремо з активного клієнтського сокета цієї кімнати
				let lang = "";
				for (const [, s] of io.sockets) {
					const sd = s.data || {};
					if (sd.role === "client" && sd.roomId === roomId) {
						lang = sd.lang || "";
						break;
					}
				}
				const primary = cfg.locales && cfg.locales.primary;
				const title = pickText(formDef.intro, pickLocale(cfg, lang), primary) || "";
				const id = await saveMessage({ siteId, idChat: roomId, sender: "operator", managerId: 0, text: title, type: "lead_prompt", meta: { trigger: "manual", formId: fid } });
				io.to(roomId).emit("client:message", { id, text: title, leadPrompt: true, trigger: "manual", formId: fid, timestamp: new Date().toISOString() });
				io.to(`operators_${siteId}`).emit("operator:message", { roomId, siteId, message: { id, from: "operator", text: title, type: "lead_prompt" } });
			} catch (e) {
				console.error("operator:send_form error:", e.message);
			}
		});

		socket.on("operator:join_chat", async ({ roomId, siteId } = {}) => {
			const d = socket.data || {};
			if (d.role !== "operator" || !d.sites || !d.sites.includes(siteId) || !roomBelongsToSite(roomId, siteId)) return;
			try {
				const { conv, claimedNow } = await joinConversation(siteId, roomId, d.operatorId);
				const owner = conv && conv.operator_id != null ? Number(conv.operator_id) : null;
				const iOwn = owner != null && owner === Number(d.operatorId);
				d.ownedRooms = d.ownedRooms || new Set();
				if (iOwn) d.ownedRooms.add(roomId);
				if (claimedNow) {
					const text = "Оператор приєднався до розмови";
					const sysId = await saveMessage({ siteId, idChat: roomId, sender: "operator", managerId: 0, text, type: "op_joined" });
					io.to(roomId).emit("client:message", { id: sysId, text, system: true, type: "op_joined", timestamp: new Date().toISOString() });
					io.to(`operators_${siteId}`).emit("operator:message", { roomId, siteId, message: { id: sysId, from: "operator", text, type: "op_joined" } });
					for (const [, s] of io.sockets) {
						const sd = s.data || {};
						if (sd.role === "client" && sd.roomId === roomId) clearLeadTimeout(s);
					}
				}
				io.to(`operators_${siteId}`).emit("operator:conv_state", { roomId, siteId, status: conv ? conv.status : "open", operatorId: owner });
			} catch (e) {
				console.error("operator:join_chat error:", e.message);
			}
		});

		socket.on("operator:close_chat", async ({ roomId, siteId } = {}) => {
			const d = socket.data || {};
			if (d.role !== "operator" || !d.sites || !d.sites.includes(siteId) || !roomBelongsToSite(roomId, siteId)) return;
			try {
				const ok = await closeConversation(siteId, roomId, d.operatorId);
				if (!ok) return;
				if (d.ownedRooms) d.ownedRooms.delete(roomId);
				const text = "Діалог завершено";
				const sysId = await saveMessage({ siteId, idChat: roomId, sender: "operator", managerId: 0, text, type: "chat_closed" });
				io.to(roomId).emit("client:message", { id: sysId, text, system: true, type: "chat_closed", timestamp: new Date().toISOString() });
				io.to(`operators_${siteId}`).emit("operator:message", { roomId, siteId, message: { id: sysId, from: "operator", text, type: "chat_closed" } });
				io.to(`operators_${siteId}`).emit("operator:conv_state", { roomId, siteId, status: "closed", operatorId: null });
				try {
					const cfg = await getWidgetConfig(siteId);
					const rv = cfg && cfg.triggers && cfg.triggers.afterClose && cfg.triggers.afterClose.review;
					if (rv && rv.enabled) {
						const conv2 = await getConversation(siteId, roomId).catch(() => null);
						if (!conv2 || conv2.rated_at == null) {
							let lang = "";
							for (const [, s] of io.sockets) {
								const sd = s.data || {};
								if (sd.role === "client" && sd.roomId === roomId) {
									lang = sd.lang || "";
									break;
								}
							}
							const primary = cfg.locales && cfg.locales.primary;
							const msg = pickText(rv.message, pickLocale(cfg, lang), primary);
							if (msg) {
								const csatId = await saveMessage({ siteId, idChat: roomId, sender: "operator", managerId: 0, text: msg, type: "csat_prompt" });
								io.to(roomId).emit("client:message", { id: csatId, text: msg, csat: true, timestamp: new Date().toISOString() });
							}
						}
					}
				} catch (e) {
					console.error("afterClose review:", e.message);
				}
			} catch (e) {
				console.error("operator:close_chat error:", e.message);
			}
		});

		socket.on("operator:archive_chat", async ({ roomId, siteId } = {}) => {
			const d = socket.data || {};
			if (d.role !== "operator" || !d.sites || !d.sites.includes(siteId) || !roomBelongsToSite(roomId, siteId)) return;
			try {
				const ok = await archiveConversation(siteId, roomId);
				if (!ok) return;
				if (d.ownedRooms) d.ownedRooms.delete(roomId);
				io.to(`operators_${siteId}`).emit("operator:conv_state", { roomId, siteId, status: "archived", operatorId: null });
			} catch (e) {
				console.error("operator:archive_chat error:", e.message);
			}
		});

		socket.on("operator:message", async ({ roomId, siteId, text, managerId = null, attachment } = {}) => {
			const d = socket.data || {};
			if (d.role !== "operator" || !d.sites || !d.sites.includes(siteId) || !roomBelongsToSite(roomId, siteId)) return;
			const clean = cleanText(text) || "";
			const att = sanitizeAttachment(attachment);
			if (!clean && !att) return;
			const conv = await getConversation(siteId, roomId).catch(() => null);
			if (!conv || conv.status !== "open" || conv.operator_id == null || Number(conv.operator_id) !== Number(d.operatorId)) {
				return socket.emit("operator:cannot_send", { roomId, reason: !conv || conv.operator_id == null ? "not_joined" : conv.status !== "open" ? "closed" : "other_operator" });
			}
			try {
				const id = await saveMessage({ siteId, idChat: roomId, sender: "operator", managerId, text: clean, attachment: att });
				const attOut = att ? { url: signFileUrl(att.path), rel_path: att.path, name: att.name, size: att.size, mime: att.mime, kind: att.kind } : null;
				const ts = new Date().toISOString();
				io.to(roomId).emit("client:message", { id, text: clean, attachment: attOut, timestamp: ts });
				for (const [, s] of io.sockets) {
					const sd = s.data || {};
					if (sd.role === "client" && sd.roomId === roomId) clearLeadTimeout(s);
				}
				io.to(`operators_${siteId}`).emit("operator:message", { roomId, siteId, message: { id, from: "operator", text: clean, type: "text", attachment: attOut }, senderId: socket.id });

				ccBridge.mirror(siteId, roomId, "out", { id, text: clean, attachment: attOut, id_manager: d.operatorId, date_add: new Date() }).catch(() => {});
			} catch (e) {
				console.error("operator:message error:", e.message);
			}
		});

		socket.on("operator:mark_read", async ({ roomId, siteId } = {}) => {
			const d = socket.data || {};
			if (d.role !== "operator" || !d.sites || !d.sites.includes(siteId) || !roomBelongsToSite(roomId, siteId)) return;
			try {
				await markChatRead(d.operatorId, siteId, roomId);
				// позначаємо ВСІ нотифікації цього чату прочитаними (включно з новими)
				await pool.query(
					`INSERT IGNORE INTO ${NOTIF_READS} (notification_id, manager_id)
                     SELECT n.id, ? FROM ${NOTIF} AS n
                     WHERE n.type = 3 AND JSON_UNQUOTE(JSON_EXTRACT(n.data, '$.chat_id')) = ?`,
					[d.operatorId, roomId]
				);
				socket.emit("operator:unread_update", { roomId, count: 0 });
				for (const [, s] of io.sockets) {
					const sd = s.data || {};
					if (sd.role === "operator" && Number(sd.operatorId) === Number(d.operatorId)) {
						s.emit("operator:notif_read", { channel: "webchat", chatId: roomId });
					}
				}
			} catch (e) {
				console.error("operator:mark_read error:", e.message);
			}
		});

		socket.on("operator:load_product_history", async ({ roomId, siteId, cursor } = {}) => {
			const d = socket.data || {};
			if (d.role !== "operator" || !d.sites || !d.sites.includes(siteId) || !roomBelongsToSite(roomId, siteId)) return;
			try {
				const visitorId = roomId.split("_").slice(1).join("_");
				const cur = typeof cursor === "string" && cursor ? cursor : null;
				const history = await getProductHistory(siteId, visitorId, cur, 20);
				socket.emit("operator:product_history", { roomId, siteId, items: history, nextCursor: history.length === 20 ? history[history.length - 1].lastViewed : null, append: true });
			} catch (e) {
				console.error("operator:load_product_history error:", e.message);
			}
		});

		socket.on("operator:delete_chat", async ({ roomId, siteId } = {}) => {
			const d = socket.data || {};
			if (d.role !== "operator" || !d.sites || !d.sites.includes(siteId) || !roomBelongsToSite(roomId, siteId)) return;
			try {
				await deleteChat(siteId, roomId);
				io.to(`operators_${siteId}`).emit("operator:chat_deleted", { roomId, siteId });
			} catch (e) {
				console.error("operator:delete_chat error:", e.message);
			}
		});

		socket.on("operator:delete_message", async ({ roomId, siteId, id } = {}) => {
			const d = socket.data || {};
			if (d.role !== "operator" || !d.sites || !d.sites.includes(siteId) || !roomBelongsToSite(roomId, siteId)) return;
			const msgId = parseInt(id, 10);
			if (!msgId) return;
			try {
				const row = await getMessageRow(siteId, roomId, msgId);
				if (!canModifyMessage(socket, row)) return;
				await softDeleteMessage(siteId, roomId, msgId);
				io.to(roomId).emit("client:message_deleted", { id: msgId });
				io.to(`operators_${siteId}`).emit("operator:message_deleted", { roomId, siteId, id: msgId });
			} catch (e) {
				console.error("operator:delete_message error:", e.message);
			}
		});

		socket.on("operator:edit_message", async ({ roomId, siteId, id, text } = {}) => {
			const d = socket.data || {};
			if (d.role !== "operator" || !d.sites || !d.sites.includes(siteId) || !roomBelongsToSite(roomId, siteId)) return;
			const msgId = parseInt(id, 10);
			if (!msgId) return;
			const clean = cleanText(text);
			if (!clean) return;
			try {
				const row = await getMessageRow(siteId, roomId, msgId);
				if (!canModifyMessage(socket, row)) return;
				await editMessage(siteId, roomId, msgId, clean);
				io.to(roomId).emit("client:message_edited", { id: msgId, text: clean });
				io.to(`operators_${siteId}`).emit("operator:message_edited", { roomId, siteId, id: msgId, text: clean });
			} catch (e) {
				console.error("operator:edit_message error:", e.message);
			}
		});

		socket.on("operator:typing", ({ roomId, siteId } = {}) => {
			const d = socket.data || {};
			if (d.role !== "operator" || !d.sites || !d.sites.includes(siteId) || !roomBelongsToSite(roomId, siteId)) return;
			socket.to(roomId).emit("typing", { role: "operator" });
		});

		socket.on("disconnect", () => {
			const d = socket.data || {};
			clearLeadTimeout(socket);
			const n = (ipConns.get(d.ip) || 1) - 1;
			ipConns.set(d.ip, n);

			if (d.role === "operator" && d.ownedRooms && d.ownedRooms.size) {
				for (const rid of d.ownedRooms) {
					const sid = (d.sites || []).find((s) => rid.startsWith(s + "_"));
					if (!sid) continue;
					const key = sid + "|" + rid;
					const opId = d.operatorId;
					clearTimeout(releaseTimers.get(key));
					const t = setTimeout(() => {
						releaseTimers.delete(key);
						if (isOperatorOwnerOnline(sid, rid, opId)) return;
						releaseConversation(sid, rid, opId)
							.then(() => io.to(`operators_${sid}`).emit("operator:conv_state", { roomId: rid, siteId: sid, status: "open", operatorId: null }))
							.catch(() => {});
					}, RELEASE_GRACE_MS);
					releaseTimers.set(key, t);
				}
			}

			if (d.role === "client" && d.roomId) {
				const cnt = (onlineClients.get(d.roomId) || 1) - 1;
				if (cnt <= 0) {
					onlineClients.delete(d.roomId);
					visitorProduct.delete(d.roomId);
					io.to(`operators_${d.siteId}`).emit("operator:visitor_left", { roomId: d.roomId });
					ccBridge.presence(d.siteId, d.roomId, false).catch(() => {});
				} else onlineClients.set(d.roomId, cnt);
			}
		});
	});
}

// ─── HTTP-маршрути чату (заповнимо пізніше: frame, upload, config, file, push) ─
// router.get("/chat/frame.html", ...) — наступні кроки

// ═══════════════════════════════════════════════════════════════════════════
//  HTTP-МАРШРУТИ
// ═══════════════════════════════════════════════════════════════════════════

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}
function ym() {
	const d = new Date();
	return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

// magic-bytes перевірка
function sniffKind(buf) {
	if (!buf || buf.length < 4) return null;
	const b = buf;
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
	if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "zip";
	return null;
}
function contentMatchesDeclared(declaredMime, buf) {
	const sniff = sniffKind(buf);
	if (!sniff) return false;
	const meta = ALLOWED_TYPES[declaredMime];
	if (!meta) return false;
	if (meta.kind === "image") return sniff === declaredMime;
	if (meta.kind === "file") return sniff === "zip";
	return false;
}

const FRAME_PATH = path.join(__dirname, "frame.html");
let FRAME_TPL = null;
function getFrameTpl() {
	if (FRAME_TPL === null) FRAME_TPL = fs.readFileSync(FRAME_PATH, "utf8");
	return FRAME_TPL;
}

const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

// ── frame.html ──
router.get("/chat/frame.html", async (req, res) => {
	const ip = clientIpFromReq(req);
	if (isBanned(ip)) return res.status(403).type("html").send("<p>Forbidden.</p>");
	const siteId = String(req.query.siteId || "");
	const refHost = hostOf(req.headers.referer || "");
	let allowed = false;
	try {
		allowed = await domainAllowedForSite(siteId, refHost);
	} catch {}
	if (!allowed) return res.status(403).type("html").send("<p>Chat is not available on this domain.</p>");

	const cookies = parseCookies(req.headers.cookie);
	if (!UID_RE.test(cookies.lc_uid || "")) {
		res.cookie("lc_uid", newUid(), { httpOnly: true, secure: true, sameSite: "none", path: "/", partitioned: true, maxAge: 365 * 24 * 60 * 60 * 1000 });
	}
	const cfg = await getSiteConfig(siteId);
	const html = getFrameTpl()
		.replace(/__HOST_ORIGIN__/g, `https://${refHost}`)
		.replace(/__SITE_ID__/g, JSON.stringify(siteId))
		.replace(/__BRAND_COLOR__/g, safeColor(cfg.brandColor))
		.replace(/__OUR_HOST__/g, OUR_HOST);
	res.set("Cache-Control", "no-store");
	res.set("Content-Security-Policy", `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss://${OUR_HOST}; frame-ancestors https://${refHost}`);
	res.type("html").send(html);
});

// ── config (loader) ──
router.get("/chat/config", async (req, res) => {
	const origin = req.headers.origin || "";
	res.set("Access-Control-Allow-Origin", origin || "*");
	res.set("Vary", "Origin");
	res.set("Cache-Control", "no-store");
	const siteId = String(req.query.siteId || "");
	let allowed = false,
		productCard = false,
		leadTimeoutSec = 0,
		brandColor = "#007fff",
		extraButtons = { enabled: false, items: [] };
	try {
		allowed = await domainAllowedForSite(siteId, hostOf(origin));
		if (allowed) {
			const cfg = await getSiteConfig(siteId);
			productCard = cfg.productCard;
			leadTimeoutSec = cfg.leadTimeoutSec;
			brandColor = cfg.brandColor;

			// extraButtons живе у JSON-колонці config → appearance.extraButtons
			// Якщо getSiteConfig уже повертає розпарсений config — беремо звідти.
			// Якщо ні — треба додати читання колонки config у самій getSiteConfig (див. нижче).
			const eb = (cfg.config && cfg.config.appearance && cfg.config.appearance.extraButtons) || null;
			if (eb && typeof eb === "object") {
				extraButtons = {
					enabled: eb.enabled !== false,
					items: Array.isArray(eb.items) ? eb.items : [],
				};
			}
		}
	} catch {}
	res.json({ allowed, productCard, leadTimeoutSec, brandColor, extraButtons });
});

// ── upload ──
router.post("/chat/upload", (req, res) => {
	uploadMem.single("file")(req, res, async (err) => {
		if (err) return res.status(400).json({ ok: false, error: err.code === "LIMIT_FILE_SIZE" ? "file_too_large" : "upload_error" });
		try {
			const ip = clientIpFromReq(req);
			if (isBanned(ip)) return res.status(403).json({ ok: false, error: "forbidden" });
			if (hitLimit(ipJoins, "up_" + ip, 30)) {
				noteFail(ip);
				return res.status(429).json({ ok: false, error: "rate_limited" });
			}

			// авторизація: клієнт з валідним lc_uid + upload-тікет + дозволений домен-реферер
			const cookies = parseCookies(req.headers.cookie);
			const uid = cookies.lc_uid;
			const siteId = String(req.query.siteId || "");
			const role = String(req.query.role || "");
			if (!siteId) {
				noteFail(ip);
				return res.status(403).json({ ok: false, error: "forbidden" });
			}

			let auth = null;
			const refHost = hostOf(req.headers.referer || "") || hostOf(req.headers.origin || "");
			const fromOurFrame = !refHost || refHost === OUR_HOST || refHost === "www." + OUR_HOST;
			const sites = await getSites().catch(() => new Map());
			if (role === "operator") {
				// операторський аплоуд — поки за наявністю сайту (JWT-гейт додамо з фронтом)
				if (fromOurFrame && sites.has(siteId)) auth = { siteId };
			} else if (UID_RE.test(uid || "") && verifyUploadTicket(req.headers["x-upload-ticket"], uid, siteId) && fromOurFrame && sites.has(siteId)) {
				const visitorId = await getOrCreateVisitor(uid, siteId).catch(() => null);
				if (visitorId) auth = { siteId };
			}
			if (!auth) {
				console.log(
					"[WC upload 403]",
					JSON.stringify({
						role: role,
						uid_ok: UID_RE.test(uid || ""),
						ticket_ok: verifyUploadTicket(req.headers["x-upload-ticket"], uid, siteId),
						refHost: hostOf(req.headers.referer || ""),
						OUR_HOST: OUR_HOST,
						fromOurFrame: fromOurFrame,
						site_known: sites.has(siteId),
					})
				);
				noteFail(ip);
				return res.status(403).json({ ok: false, error: "forbidden" });
			}

			const file = req.file;
			if (!file || !file.buffer) return res.status(400).json({ ok: false, error: "no_file" });
			const declared = file.mimetype;
			const meta = ALLOWED_TYPES[declared];
			if (!meta) return res.status(415).json({ ok: false, error: "type_not_allowed" });
			if (!contentMatchesDeclared(declared, file.buffer)) return res.status(415).json({ ok: false, error: "content_mismatch" });

			const token = crypto.randomBytes(16).toString("hex");
			const absDir = path.join(WC_UPLOAD_DIR, auth.siteId, ym());
			ensureDir(absDir);
			const fname = token + "." + meta.ext;
			fs.writeFileSync(path.join(absDir, fname), file.buffer);
			const relPath = `${auth.siteId}/${ym()}/${fname}`;

			res.json({ ok: true, path: relPath, url: signFileUrl(relPath), name: String(file.originalname || "").slice(0, 200), size: file.size, mime: declared, kind: meta.kind });
		} catch (e) {
			console.error("upload error:", e.message);
			res.status(500).json({ ok: false, error: "server_error" });
		}
	});
});

// ── file (підписаний) ──
router.get("/chat/file/*rest", (req, res) => {
	const raw = req.params.rest;
	const relPath = safeRelPath(Array.isArray(raw) ? raw.join("/") : raw);
	if (!relPath) return res.status(400).send("bad path");
	if (!verifyFileSig(relPath, req.query.exp, req.query.sig)) return res.status(403).send("forbidden");
	const absPath = path.join(WC_UPLOAD_DIR, relPath);
	if (!absPath.startsWith(path.resolve(WC_UPLOAD_DIR) + path.sep)) return res.status(400).send("bad path");
	if (!fs.existsSync(absPath)) return res.status(404).send("not found");
	const ext = path.extname(absPath).slice(1).toLowerCase();
	const isImage = ["jpg", "png", "webp", "gif"].includes(ext);
	const mimeByExt = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
	res.set("X-Content-Type-Options", "nosniff");
	res.set("Content-Type", mimeByExt[ext] || "application/octet-stream");
	res.set("Content-Disposition", isImage ? "inline" : "attachment");
	res.set("Cache-Control", "private, max-age=86400");
	res.sendFile(absPath);
});

// ── push ──
router.post("/chat/push/subscribe", express.json({ limit: "16kb" }), async (req, res) => {
	try {
		const ok = await savePushSub(0, req.body && req.body.subscription, req.headers["user-agent"]);
		res.json({ ok: !!ok });
	} catch (e) {
		console.error("push subscribe:", e.message);
		res.status(500).json({ ok: false });
	}
});
router.post("/chat/push/unsubscribe", express.json({ limit: "16kb" }), async (req, res) => {
	try {
		const ep = req.body && req.body.endpoint;
		if (ep) await deletePushSub(ep);
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ ok: false });
	}
});
router.get("/chat/push/key", (req, res) => {
	res.set("Cache-Control", "no-store");
	res.json({ key: VAPID_PUBLIC });
});

// ── Статика: loader і service worker ──
router.get("/chat/widget.js", (req, res) => {
	const origin = req.headers.origin || "";
	res.set("Access-Control-Allow-Origin", origin || "*");
	res.set("Vary", "Origin");
	res.set("Content-Type", "application/javascript; charset=utf-8");
	res.set("Cache-Control", "public, max-age=300");
	res.sendFile(path.join(__dirname, "widget.js"));
});

router.get("/chat/chat-sw.js", (req, res) => {
	res.set("Content-Type", "application/javascript; charset=utf-8");
	res.set("Service-Worker-Allowed", "/"); // дозволяє root-scope, навіть якщо SW не в корені
	res.set("Cache-Control", "no-store");
	res.sendFile(path.join(__dirname, "chat-sw.js"));
});

/**
 * Відправка повідомлення з нової сторінки діалогу контакт-центру.
 * Пише в стару схему (щоб віджет бачив історію) і шле подію клієнту.
 * Повертає { ok, id, error }.
 */
async function sendFromCrm(siteId, roomId, text, managerId) {
	if (!io) return { ok: false, error: "Socket веб-чату не ініціалізовано" };

	const clean = cleanText(text);
	if (!clean) return { ok: false, error: "Порожнє повідомлення" };

	try {
		// Оператор має володіти діалогом — правило те саме, що в socket-обробнику
		await ensureConversation(siteId, roomId);
		await pool.execute(
			`UPDATE ${CONV} SET operator_id = COALESCE(operator_id, ?), joined_at = COALESCE(joined_at, NOW(3)), status = 'open'
              WHERE site_id = ? AND room_id = ?`,
			[managerId || 0, siteId, roomId]
		);

		const id = await saveMessage({ siteId, idChat: roomId, sender: "operator", managerId: managerId || null, text: clean });

		const ts = new Date().toISOString();
		io.to(roomId).emit("client:message", { id, text: clean, timestamp: ts });
		io.to(`operators_${siteId}`).emit("operator:message", { roomId, siteId, message: { id, from: "operator", text: clean, type: "text" } });

		return { ok: true, id: id };
	} catch (e) {
		console.error("sendFromCrm:", e.message);
		return { ok: false, error: e.message };
	}
}

/**
 * Менеджер відкрив діалог у новому інтерфейсі контакт-центру.
 * Позначає чат прочитаним у старій схемі і повідомляє клієнта,
 * щоб у віджеті зʼявилася галочка «прочитано».
 */
async function markReadFromCrm(siteId, roomId, managerId) {
	if (!io) return { ok: false, error: "Socket веб-чату не ініціалізовано" };

	try {
		// markChatRead бере MAX(id) по всьому чату, включно з щойно
		// доданим повідомленням клієнта — саме це й потрібно
		const maxId = await markChatRead(managerId || 0, siteId, roomId);
		if (!maxId) return { ok: true, lastReadId: 0 };

		// Клієнту — щоб перемалював галочки у віджеті
		io.to(roomId).emit("client:read_receipt", { lastReadId: maxId });

		// Іншим операторам — щоб лічильник зник і в старому інтерфейсі
		io.to(`operators_${siteId}`).emit("operator:unread_update", { roomId, count: 0 });

		return { ok: true, lastReadId: maxId };
	} catch (e) {
		console.error("markReadFromCrm:", e.message);
		return { ok: false, error: e.message };
	}
}

module.exports = router;
module.exports.bindSocket = bindSocket;
module.exports.sendFromCrm = sendFromCrm;
module.exports.markReadFromCrm = markReadFromCrm;
module.exports.validateConfig = validateConfig;
module.exports.bustWidgetCfg = bustWidgetCfg;
module.exports.deleteChatExternal = async function (siteId, roomId) {
	await deleteChat(siteId, roomId);
	if (io) io.to(`operators_${siteId}`).emit("operator:chat_deleted", { roomId, siteId });
};
module.exports.isRoomOnline = function (roomId) {
	return (onlineClients.get(roomId) || 0) > 0;
};
module.exports.getOnlineRooms = function () {
	return [...onlineClients.keys()];
};
module.exports.getProductsForRoom = async function (siteId, roomId) {
	const visitorId = String(roomId).slice(String(siteId).length + 1);
	let history = [];
	try {
		history = await getProductHistory(siteId, visitorId, null, 50);
	} catch (e) {}
	return { current: visitorProduct.get(roomId) || null, history: history };
};
module.exports.getVisitorInfo = async function (siteId, roomId) {
	const visitorId = String(roomId).slice(String(siteId).length + 1);
	try {
		const meta = await getVisitorMeta(siteId, visitorId);
		return meta ? meta.data : null;
	} catch (e) {
		return null;
	}
};

// Синхронізація активності сайту веб-чату зі статусом каналу контакт-центру.
// Канал вимкнено → віджет не показується (getSites бере лише active=1).
module.exports.setSiteActiveByChannel = async function (idChannel, active) {
	try {
		const [rows] = await pool.query(`SELECT site_id FROM ${prefix}contact_center_channel_webchat WHERE id_channel = ? LIMIT 1`, [idChannel]);
		if (!rows.length || !rows[0].site_id) return;
		await pool.execute(`UPDATE ${SITES} SET active = ? WHERE site_id = ?`, [active ? 1 : 0, rows[0].site_id]);
		// скидаємо кеш сайтів, щоб зміна діяла одразу, а не за 60с
		sitesCache = { at: 0, map: new Map() };
	} catch (e) {
		console.error("setSiteActiveByChannel:", e.message);
	}
};
