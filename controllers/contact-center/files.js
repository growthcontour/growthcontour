const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");

const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const realtime = require("./realtime");

const P = config.get("configDatabase").prefix;
const T_ATTACH = P + "contact_center_attachments";

// Куди складаємо файли і як їх віддаємо
// Файли лежать поруч зі статикою: assets роздається в server.js
const UPLOAD_ROOT = path.join(process.cwd(), "assets", "contact-center");
const PUBLIC_PREFIX = "/assets/contact-center";

/**
 * Шлях діалогу: <тип каналу>/<url_token>/<client|manager>
 * url_token унікальний і непрозорий — файли одного діалогу лежать разом,
 * а внутрішні ID у шляху не світяться.
 */
function conversationDir(channelType, urlToken, side) {
	return path.join(String(channelType || "unknown"), String(urlToken), side === "manager" ? "manager" : "client");
}

const MAX_SIZE = 50 * 1024 * 1024;
const MAX_ATTEMPTS = 5;

// Розширення беремо з MIME, а не з імені файлу — ім'я приходить від клієнта
const MIME_EXT = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"video/mp4": ".mp4",
	"video/quicktime": ".mov",
	"audio/mpeg": ".mp3",
	"audio/ogg": ".ogg",
	"audio/mp4": ".m4a",
	"application/pdf": ".pdf",
	"application/zip": ".zip",
};

function extFor(mime, fileName) {
	if (MIME_EXT[mime]) return MIME_EXT[mime];
	const ext = path.extname(String(fileName || "")).toLowerCase();
	return /^\.[a-z0-9]{1,6}$/.test(ext) ? ext : ".bin";
}

/**
 * Завантажує одне вкладення до себе.
 * source_type визначає, як дістати файл:
 *   telegram_file_id → getFile, потім CDN бота
 *   url              → пряме завантаження (з Bearer для Meta CDN)
 */
async function fetchAttachment(att) {
	let url = null;
	const headers = {};

	if (att.source_type === "telegram_file_id") {
		const token = await resolveTelegramToken(att.id_channel);
		if (!token) throw new Error("Telegram token unavailable");

		const meta = await axios.get(`https://api.telegram.org/bot${token}/getFile`, {
			params: { file_id: att.source_ref },
			timeout: 15000,
		});

		if (!meta.data || !meta.data.ok) throw new Error("getFile failed");
		url = `https://api.telegram.org/file/bot${token}/${meta.data.result.file_path}`;
	} else if (att.source_type === "url") {
		url = att.source_ref;

		// Meta CDN віддає медіа лише з токеном застосунку
		if (/(fbsbx|fbcdn|cdninstagram)\.com/.test(url)) {
			const token = await resolveInstagramToken(att.id_channel);
			if (token) headers.Authorization = "Bearer " + token;
		}
	} else {
		throw new Error("Unsupported source_type: " + att.source_type);
	}

	const response = await axios.get(url, {
		responseType: "arraybuffer",
		headers: headers,
		timeout: 60000,
		maxContentLength: MAX_SIZE,
		maxBodyLength: MAX_SIZE,
	});

	return {
		buffer: Buffer.from(response.data),
		mime: String(response.headers["content-type"] || "").split(";")[0] || att.mime || "application/octet-stream",
	};
}

// Токени дістаються ліниво, щоб не тягнути адаптери в цей модуль циклічно
async function resolveTelegramToken(idChannel) {
	const cryptoHelper = require("../../helpers/crypto");
	const [rows] = await connection_pool.query(`SELECT token_cipher, token_iv, token_tag FROM ${P}contact_center_channel_telegram WHERE id_channel = ? LIMIT 1`, [idChannel]);
	const r = rows[0];
	return r ? cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag) : null;
}

async function resolveInstagramToken(idChannel) {
	const cryptoHelper = require("../../helpers/crypto");
	const [rows] = await connection_pool.query(`SELECT token_cipher, token_iv, token_tag FROM ${P}contact_center_channel_instagram WHERE id_channel = ? LIMIT 1`, [idChannel]);
	const r = rows[0];
	return r ? cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag) : null;
}

/**
 * Обробляє одне вкладення: качає, зберігає, оновлює рядок, шле подію.
 * Дедуплікація за sha256: той самий файл не зберігається двічі.
 */
async function processAttachment(att) {
	try {
		await connection_pool.query(`UPDATE ${T_ATTACH} SET status = 'processing', attempts = attempts + 1 WHERE id = ?`, [att.id]);

		const file = await fetchAttachment(att);
		const sha = crypto.createHash("sha256").update(file.buffer).digest("hex");

		// Дедуплікація в межах одного діалогу: той самий файл, переданий двічі,
		// не зберігається повторно. Глобальну дедуплікацію не робимо —
		// файли розкладені по теках діалогів, і чужий шлях тут недоречний.
		const [dup] = await connection_pool.query(`SELECT path FROM ${T_ATTACH} WHERE sha256 = ? AND id_conversation = ? AND status = 'done' AND path IS NOT NULL LIMIT 1`, [sha, att.id_conversation]);

		let publicPath;

		if (dup.length) {
			publicPath = dup[0].path;
		} else {
			const dir = conversationDir(att.channel_type, att.url_token, "client");
			const absDir = path.join(UPLOAD_ROOT, dir);
			await fs.promises.mkdir(absDir, { recursive: true });

			const fileName = sha.slice(0, 32) + extFor(file.mime, att.file_name);
			await fs.promises.writeFile(path.join(absDir, fileName), file.buffer);

			publicPath = PUBLIC_PREFIX + "/" + dir.replace(/\\/g, "/") + "/" + fileName;
		}

		await connection_pool.query(
			`UPDATE ${T_ATTACH}
             SET status = 'done', path = ?, mime = ?, size = ?, sha256 = ?, error = NULL
             WHERE id = ?`,
			[publicPath, file.mime, file.buffer.length, sha, att.id]
		);

		realtime.attachmentReady(att.id_conversation, att.id_message, att.sort_order, {
			id: att.id,
			type: att.type,
			subtype: att.subtype,
			path: publicPath,
			thumb_path: null,
			file_name: att.file_name,
			mime: file.mime,
			size: file.buffer.length,
			status: "done",
		});

		return true;
	} catch (error) {
		const attempts = (att.attempts | 0) + 1;
		const failed = attempts >= MAX_ATTEMPTS;

		// Експоненційна затримка: 1, 2, 4, 8 хвилин
		const delayMin = Math.pow(2, attempts - 1);

		await connection_pool.query(
			`UPDATE ${T_ATTACH}
             SET status = ?, error = ?, date_next_try = DATE_ADD(NOW(), INTERVAL ? MINUTE)
             WHERE id = ?`,
			[failed ? "failed" : "pending", String(error.message || error).slice(0, 500), delayMin, att.id]
		);

		console.error("attachment download:", att.id, error.message);
		return false;
	}
}

/** Один прохід черги. Викликається одразу після вебхука і за розкладом. */
async function processQueue(limit) {
	const lim = Math.min(parseInt(limit, 10) || 10, 50);

	try {
		const [rows] = await connection_pool.query(
			`SELECT a.id, a.id_message, a.id_conversation, a.id_channel, a.type, a.subtype,
                    a.sort_order, a.file_name, a.mime, a.source_type, a.source_ref, a.attempts,
                    c.url_token, ch.type AS channel_type
             FROM ${T_ATTACH} AS a
             INNER JOIN ${P}contact_center_conversations AS c ON c.id = a.id_conversation
             INNER JOIN ${P}contact_center_channels AS ch ON ch.id = a.id_channel
             WHERE a.status = 'pending'
               AND (a.date_next_try IS NULL OR a.date_next_try <= NOW())
             ORDER BY a.id ASC
             LIMIT ${lim}`
		);

		for (const att of rows) {
			await processAttachment(att);
		}

		return rows.length;
	} catch (error) {
		logging.error(error);
		return 0;
	}
}

/** Обробляє одне вкладення по id. Викликається воркером черги cc:attachments. */
async function processOne(attachmentId) {
	const [rows] = await connection_pool.query(
		`SELECT a.id, a.id_message, a.id_conversation, a.id_channel, a.type, a.subtype,
                a.sort_order, a.file_name, a.mime, a.source_type, a.source_ref, a.attempts, a.status,
                c.url_token, ch.type AS channel_type
         FROM ${T_ATTACH} AS a
         INNER JOIN ${P}contact_center_conversations AS c ON c.id = a.id_conversation
         INNER JOIN ${P}contact_center_channels AS ch ON ch.id = a.id_channel
         WHERE a.id = ? LIMIT 1`,
		[attachmentId]
	);

	const att = rows[0];
	if (!att) return false;
	// Вже оброблене або не потребує завантаження — пропускаємо (ідемпотентність)
	if (att.status === "done" || att.status === "skipped") return true;

	const ok = await processAttachment(att);
	// Кидаємо помилку, щоб BullMQ зробив ретрай згідно backoff
	if (!ok) throw new Error("attachment " + attachmentId + " download failed");
	return true;
}

/**
 * Завантажує аватар за URL у сховище, повертає публічний шлях.
 * Використовується адаптерами (Telegram: URL містить токен, показувати не можна).
 */
async function downloadAvatar(url, nameKey, ext) {
	const path = require("path");
	const fs = require("fs");

	try {
		const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 15000, maxContentLength: 10 * 1024 * 1024 });

		const dir = path.join(UPLOAD_ROOT, "avatars");
		fs.mkdirSync(dir, { recursive: true });

		const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : "jpg";
		const fileName = String(nameKey).replace(/[^a-z0-9_]/gi, "") + "_" + Date.now() + "." + safeExt;
		const full = path.join(dir, fileName);

		fs.writeFileSync(full, Buffer.from(resp.data));

		return PUBLIC_PREFIX + "/avatars/" + fileName;
	} catch (e) {
		return null;
	}
}

/**
 * Переносить уже наявний локальний файл (напр. веб-чату) у сховище CRM.
 * Обидва стореджі локальні — копіюємо на диску, без мережі.
 * Повертає публічний шлях (/uploads/...) або null.
 */
async function importLocalFile(absSourcePath, channelType, urlToken, fileName) {
	const fsp = require("fs");
	const pathMod = require("path");

	try {
		if (!absSourcePath || !fsp.existsSync(absSourcePath)) return null;

		const relDir = path.join(String(channelType), String(urlToken));
		const destDir = pathMod.join(UPLOAD_ROOT, relDir);
		fsp.mkdirSync(destDir, { recursive: true });

		const ext = (pathMod.extname(absSourcePath) || "").toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin";
		const name = require("crypto").randomBytes(16).toString("hex") + ext;
		const destAbs = pathMod.join(destDir, name);

		fsp.copyFileSync(absSourcePath, destAbs);

		const stat = fsp.statSync(destAbs);
		const publicPath = PUBLIC_PREFIX + "/" + relDir.replace(/\\/g, "/") + "/" + name;

		return { path: publicPath, size: stat.size };
	} catch (e) {
		console.error("importLocalFile:", e.message);
		return null;
	}
}

module.exports = { processQueue, importLocalFile, processAttachment, processOne, downloadAvatar, conversationDir, extFor, UPLOAD_ROOT, PUBLIC_PREFIX };
