"use strict";

/**
 * Чат компанії: файли.
 *
 * Захист:
 *  - приймаються лише дозволені типи (перелік ALLOWED за розширенням), і вміст файлу має відповідати типу —
 *    перевіряємо перші байти (сигнатуру); файл «фото.jpg», усередині якого PHP чи HTML, не приймається;
 *  - тип (MIME) визначає сервер, а не браузер;
 *  - на диску файл лежить поза публічними теками (storage/chat/<рік>/<місяць>/) під випадковим іменем БЕЗ розширення —
 *    навіть якщо теку колись відкриють вебсерверу, виконати там нічого не вийде;
 *  - фото (як у Telegram — «надіслати як фото») перекодовуються (sharp): прибираються ВСІ метадані (EXIF, GPS, XMP, ICC-профілі
 *    інших програм, коментарі) і все, що дописано до зображення; поворот за EXIF застосовується; зменшуються до 2560 px
 *    по більшій стороні; JPEG (з прозорістю — WebP). Хто хоче зберегти оригінал — надсилає «як файл»:
 *    тоді файл лишається байт у байт і показується як вкладення для завантаження;
 *  - віддаються лише учасникам чату за випадковим кодом /chat/files/<code> (номер файлу й ім'я в адресі не видно),
 *    з nosniff і CSP sandbox; показуються в браузері лише фото, відео, аудіо й PDF, решта — лише завантаження;
 *  - ім'я файлу очищається від шляхів, керівних і «невидимих» символів (зокрема підміни напрямку тексту «gpj.exe»);
 *  - ліміт розміру одного файлу.
 * Пересланий файл — новий запис (з новим кодом) на той самий файл на диску;
 * з диска файл видаляється, коли на нього не лишилось жодного запису.
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const { pool, T, httpErr, membership } = require("./common");
const logging = require("../../logging/logging");

const ROOT = path.join(process.cwd(), "storage", "chat");
const MAX_SIZE = 50 * 1024 * 1024;
const MAX_PIXELS = 50e6; // 50 Мп на вході
const PHOTO_SIDE = 2560; // фото: більша сторона після стиснення
const PHOTO_QUALITY = 85;
const ORPHAN_HOURS = 24;
const CODE_RE = /^[0-9a-f]{32}$/;

/**
 * Дозволені розширення: sig — які сигнатури вмісту підходять (див. sniff), mime — з яким типом файл віддається,
 * audio — тип, якщо в тому самому контейнері звук (голосові повідомлення webm / mp4).
 */
const ALLOWED = {
	// Фото (перекодовуються)
	jpg: { sig: ["jpeg"], mime: "image/jpeg" },
	jpeg: { sig: ["jpeg"], mime: "image/jpeg" },
	png: { sig: ["png"], mime: "image/png" },
	gif: { sig: ["gif"], mime: "image/gif" },
	webp: { sig: ["webp"], mime: "image/webp" },
	avif: { sig: ["avif"], mime: "image/avif" },
	heic: { sig: ["heic"], mime: "image/heic" },
	heif: { sig: ["heic"], mime: "image/heif" },
	// Відео й аудіо
	mp4: { sig: ["mp4"], mime: "video/mp4", audio: "audio/mp4" },
	m4v: { sig: ["mp4"], mime: "video/mp4" },
	mov: { sig: ["mp4", "mov"], mime: "video/quicktime" },
	webm: { sig: ["webm"], mime: "video/webm", audio: "audio/webm" },
	mkv: { sig: ["webm"], mime: "video/x-matroska" },
	mp3: { sig: ["mp3"], mime: "audio/mpeg" },
	m4a: { sig: ["mp4"], mime: "audio/mp4" },
	aac: { sig: ["aac"], mime: "audio/aac" },
	ogg: { sig: ["ogg"], mime: "audio/ogg" },
	oga: { sig: ["ogg"], mime: "audio/ogg" },
	opus: { sig: ["ogg"], mime: "audio/ogg" },
	wav: { sig: ["wav"], mime: "audio/wav" },
	// Документи
	pdf: { sig: ["pdf"], mime: "application/pdf" },
	doc: { sig: ["cfb"], mime: "application/msword" },
	xls: { sig: ["cfb"], mime: "application/vnd.ms-excel" },
	ppt: { sig: ["cfb"], mime: "application/vnd.ms-powerpoint" },
	docx: { sig: ["zip"], mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
	xlsx: { sig: ["zip"], mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
	pptx: { sig: ["zip"], mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
	odt: { sig: ["zip"], mime: "application/vnd.oasis.opendocument.text" },
	ods: { sig: ["zip"], mime: "application/vnd.oasis.opendocument.spreadsheet" },
	odp: { sig: ["zip"], mime: "application/vnd.oasis.opendocument.presentation" },
	rtf: { sig: ["rtf"], mime: "application/rtf" },
	txt: { sig: ["text"], mime: "text/plain" },
	csv: { sig: ["text"], mime: "text/csv" },
	tsv: { sig: ["text"], mime: "text/tab-separated-values" },
	json: { sig: ["text"], mime: "application/json" },
	xml: { sig: ["text"], mime: "application/xml" },
	md: { sig: ["text"], mime: "text/markdown" },
	log: { sig: ["text"], mime: "text/plain" },
	// Архіви
	zip: { sig: ["zip"], mime: "application/zip" },
	rar: { sig: ["rar"], mime: "application/vnd.rar" },
	"7z": { sig: ["7z"], mime: "application/x-7z-compressed" },
	gz: { sig: ["gz"], mime: "application/gzip" },
	tgz: { sig: ["gz"], mime: "application/gzip" },
	tar: { sig: ["tar"], mime: "application/x-tar" },
};

// Показуються в браузері; решта — лише завантаження
const INLINE = /^(image\/(jpeg|png|gif|webp|avif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|ogg|mp4|webm|wav|aac)|application\/pdf)$/;
// Що можна надіслати «як фото» (стиснути й очистити); решта зображень — лише «як файл»
const PHOTO = new Set(["jpeg", "png", "webp", "gif", "avif"]);

const extOf = (name) => {
	const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || ""));
	return m ? m[1].toLowerCase() : "";
};

/** Ім'я файлу від браузера (multer декодує latin1) → UTF-8, без шляхів, керівних і «невидимих» символів */
function cleanName(name) {
	let n = String(name || "");
	// Перекодовуємо лише справжній latin1 (символ понад U+00FF означає, що ім'я вже в Unicode)
	if (!/[^\u0000-\u00FF]/.test(n)) {
		const utf = Buffer.from(n, "latin1").toString("utf8");
		if (!utf.includes("\uFFFD")) n = utf;
	}
	n = n
		.replace(/\\/g, "/")
		.split("/")
		.pop()
		// керівні, підміна напрямку тексту, нульової ширини, BOM
		.replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "")
		.replace(/[<>:"|?*]/g, "_")
		.replace(/\s+/g, " ")
		.replace(/^[.\s]+|[.\s]+$/g, "");
	if (!n) n = "file";
	// Довге ім'я — обрізаємо, розширення лишаємо
	if (n.length > 200) {
		const ext = extOf(n);
		n = n.slice(0, 200 - (ext ? ext.length + 1 : 0)).trim() + (ext ? "." + ext : "");
	}
	return n;
}

/** Текст: без нульових байтів (або UTF-16 з BOM) і без коду для сервера чи браузера */
function isText(b) {
	const utf16 = b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff));
	if (!utf16 && b.includes(0)) return false;
	const s = (utf16 && b[0] === 0xff ? b.toString("utf16le") : b.toString("latin1")).replace(/\u0000/g, "").toLowerCase();
	return !/<\?php|<\?=|<script|<html|<iframe|<svg|<object|<embed/.test(s);
}

/** Що це насправді — за першими байтами */
function sniff(b) {
	if (!b || !b.length) return null;
	const at = (off, bytes) => b.length >= off + bytes.length && bytes.every((x, i) => b[off + i] === x);
	const ascii = (off, s) => b.length >= off + s.length && b.toString("latin1", off, off + s.length) === s;
	if (at(0, [0xff, 0xd8, 0xff])) return "jpeg";
	if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
	if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "gif";
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
	if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "wav";
	if (ascii(4, "ftyp")) {
		const brand = b.toString("latin1", 8, 12);
		if (/^(avif|avis)$/.test(brand)) return "avif";
		if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return "heic";
		if (brand === "qt  ") return "mov";
		return "mp4";
	}
	if (at(0, [0x1a, 0x45, 0xdf, 0xa3])) return "webm";
	if (ascii(0, "OggS")) return "ogg";
	if (ascii(0, "ID3") || (b.length > 1 && b[0] === 0xff && (b[1] & 0xe6) === 0xe2)) return "mp3";
	if (b.length > 1 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return "aac";
	if (ascii(0, "%PDF-")) return "pdf";
	if (at(0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "cfb";
	if (at(0, [0x50, 0x4b, 0x03, 0x04]) || at(0, [0x50, 0x4b, 0x05, 0x06])) return "zip";
	if (ascii(0, "Rar!\x1a\x07")) return "rar";
	if (at(0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7z";
	if (at(0, [0x1f, 0x8b])) return "gz";
	if (ascii(257, "ustar")) return "tar";
	if (ascii(0, "{\\rtf")) return "rtf";
	return isText(b) ? "text" : null;
}

async function head(file, n = 8192) {
	const fh = await fsp.open(file, "r");
	try {
		const buf = Buffer.alloc(n);
		const { bytesRead } = await fh.read(buf, 0, n, 0);
		return buf.subarray(0, bytesRead);
	} finally {
		await fh.close();
	}
}

const storage = multer.diskStorage({
	destination(req, file, cb) {
		const now = new Date();
		const dir = path.join(ROOT, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"));
		fsp.mkdir(dir, { recursive: true, mode: 0o750 }).then(
			() => cb(null, dir),
			(e) => cb(e)
		);
	},
	// Випадкове ім'я без розширення
	filename(req, file, cb) {
		cb(null, crypto.randomBytes(16).toString("hex"));
	},
});

const upload = multer({
	storage,
	limits: { fileSize: MAX_SIZE, files: 1, fields: 5, fieldSize: 1024, parts: 6, headerPairs: 50 },
	fileFilter(req, file, cb) {
		// Попередня перевірка за розширенням (щоб не приймати зайвого); вміст перевіряє check() після запису
		if (!ALLOWED[extOf(cleanName(file.originalname))]) return cb(Object.assign(new Error("chat.errors.file_type"), { status: 400 }));
		cb(null, true);
	},
}).single("file");

/**
 * Стиснути й очистити фото: усі метадані геть, поворот за EXIF, до PHOTO_SIDE px по більшій стороні.
 * Анімований GIF лишається GIF (без метаданих); прозорі PNG / WebP → WebP; решта → JPEG.
 * Повертає { ext, mime, size, width, height }.
 */
async function photo(file, sig) {
	const sharp = require("sharp");
	const tmp = file.path + ".tmp";
	try {
		const meta = await sharp(file.path, { limitInputPixels: MAX_PIXELS }).metadata();
		const fmt = meta.format === "heif" ? "avif" : meta.format;
		if (fmt !== sig) throw new Error("format");
		const animated = (meta.pages || 1) > 1;
		let img = sharp(file.path, { limitInputPixels: MAX_PIXELS, animated });
		// Поворот за EXIF «впікається» в пікселі (для анімації не застосовний)
		if (!animated) img = img.rotate();
		img = img.resize({ width: PHOTO_SIDE, height: PHOTO_SIDE, fit: "inside", withoutEnlargement: true });
		let out;
		if (animated && sig === "gif") out = { fmt: "gif", ext: "gif", mime: "image/gif", opts: {} };
		else if (animated || meta.hasAlpha) out = { fmt: "webp", ext: "webp", mime: "image/webp", opts: { quality: PHOTO_QUALITY } };
		else out = { fmt: "jpeg", ext: "jpg", mime: "image/jpeg", opts: { quality: PHOTO_QUALITY, mozjpeg: true } };
		// Без withMetadata(): у результат не потрапляє жодних метаданих
		const info = await img.toFormat(out.fmt, out.opts).toFile(tmp);
		await fsp.rename(tmp, file.path);
		return { ext: out.ext, mime: out.mime, size: info.size, width: info.width || null, height: animated && meta.pageHeight && meta.width ? Math.round((info.width * meta.pageHeight) / meta.width) : info.height || null };
	} catch (e) {
		await fsp.unlink(tmp).catch(() => {});
		if (e && /pixel limit/i.test(String(e.message))) throw httpErr(400, "chat.errors.image_too_big");
		throw httpErr(400, "chat.errors.file_type");
	}
}

/**
 * Перевірити щойно записаний файл: вміст відповідає розширенню.
 * asFile = false і це фото — стиснути й очистити (photo); asFile = true — лишити як є, показувати як вкладення.
 * Повертає { name, mime, size, width, height, asFile }.
 */
async function check(file, asFile) {
	let name = cleanName(file.originalname);
	const rule = ALLOWED[extOf(name)];
	if (!rule || !file.size) throw httpErr(400, "chat.errors.file_type");
	const sig = sniff(await head(file.path));
	if (!sig || !rule.sig.includes(sig)) throw httpErr(400, "chat.errors.file_type");
	// Звук чи відео в тому самому контейнері (webm / mp4) — за тим, що заявив браузер; обидва варіанти безпечні
	const mime = rule.audio && /^audio\//.test(String(file.mimetype || "")) ? rule.audio : rule.mime;
	if (asFile || !PHOTO.has(sig)) return { name, mime, size: file.size, width: null, height: null, asFile: !!asFile || sig === "heic" };
	const p = await photo(file, sig);
	// Розширення в імені — за новим форматом
	name = name.replace(/\.[a-z0-9]{1,5}$/i, "") + "." + p.ext;
	return { name, mime: p.mime, size: p.size, width: p.width, height: p.height, asFile: false };
}

/** Записати завантажений файл. Перевірка, що людина в чаті й може писати, — у маршруті до завантаження */
async function register(uid, idRoom, file, { asFile = false } = {}) {
	const f = await check(file, asFile);
	const rel = path.relative(ROOT, file.path).split(path.sep).join("/");
	const [r] = await pool.query(`INSERT INTO ${T.files} (id_room, id_user, name, mime, size, path, width, height, as_file, date_add) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`, [
		idRoom,
		uid,
		f.name,
		f.mime,
		f.size,
		rel,
		f.width,
		f.height,
		Number(f.asFile),
	]);
	const [[row]] = await pool.query(`SELECT id, code, name, mime, size, width, height, as_file FROM ${T.files} WHERE id = ?`, [r.insertId]);
	return shape(row);
}

function shape(f) {
	return {
		id: Number(f.id),
		name: String(f.name),
		mime: f.mime,
		size: Number(f.size),
		width: f.width,
		height: f.height,
		url: `/chat/files/${f.code}`,
		// Надіслане «як файл» — вкладення для завантаження, навіть якщо це фото чи відео
		inline: !Number(f.as_file) && INLINE.test(f.mime),
	};
}

/** Файли повідомлень: Map<id повідомлення, файли[]> */
async function forMessages(ids) {
	const out = new Map();
	if (!ids.length) return out;
	const [rows] = await pool.query(`SELECT id, code, id_message, name, mime, size, width, height, as_file FROM ${T.files} WHERE id_message IN (?) ORDER BY id`, [ids]);
	rows.forEach((r) => {
		const k = Number(r.id_message);
		if (!out.has(k)) out.set(k, []);
		out.get(k).push(shape(r));
	});
	return out;
}

/** Пересилання: нові записи (код у кожного свій — ставить база) на ті самі файли на диску */
async function copyTo(conn, ids, idRoom, idMessage, uid) {
	if (!ids.length) return;
	await conn.query(
		`INSERT INTO ${T.files} (id_room, id_message, id_user, name, mime, size, path, width, height, as_file, date_add)
		 SELECT ?, ?, ?, name, mime, size, path, width, height, as_file, NOW() FROM ${T.files} WHERE id IN (?) ORDER BY id`,
		[idRoom, idMessage, uid, ids]
	);
}

/** Відв'язати файли видаленого повідомлення. Повертає шляхи — перевірити, чи ще потрібні */
async function detach(conn, idMessage) {
	const [rows] = await conn.query(`SELECT path FROM ${T.files} WHERE id_message = ?`, [idMessage]);
	if (rows.length) await conn.query(`DELETE FROM ${T.files} WHERE id_message = ?`, [idMessage]);
	return rows.map((r) => r.path);
}

/** Абсолютний шлях лише всередині storage/chat */
function inRoot(rel) {
	const abs = path.resolve(ROOT, String(rel || ""));
	return abs.startsWith(ROOT + path.sep) ? abs : null;
}

/** Видалити з диска файли, на які не лишилось записів */
async function unlinkUnused(paths) {
	const list = [...new Set(paths)];
	if (!list.length) return;
	const [used] = await pool.query(`SELECT DISTINCT path FROM ${T.files} WHERE path IN (?)`, [list]);
	const keep = new Set(used.map((r) => r.path));
	for (const p of list) {
		if (keep.has(p)) continue;
		const abs = inRoot(p);
		if (!abs) continue;
		await fsp.unlink(abs).catch((e) => e.code !== "ENOENT" && logging.error("[chat] unlink", e));
	}
}

/** Content-Disposition: ASCII-запас для старих клієнтів + повне ім'я в UTF-8 */
function disposition(type, name) {
	const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "file";
	const utf = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
	return `${type}; filename="${ascii}"; filename*=UTF-8''${utf}`;
}

/** Віддати файл учаснику чату за кодом */
async function serve(uid, code, res, { download = false } = {}) {
	if (!CODE_RE.test(String(code))) throw httpErr(404, "chat.errors.not_found");
	const [[f]] = await pool.query(`SELECT id, id_room, id_message, id_user, name, mime, path, as_file FROM ${T.files} WHERE code = ?`, [code]);
	if (!f) throw httpErr(404, "chat.errors.not_found");
	// Ще не надісланий файл бачить лише той, хто його завантажив
	if (!f.id_message && Number(f.id_user) !== uid) throw httpErr(404, "chat.errors.not_found");
	await membership(f.id_room, uid);
	const abs = inRoot(f.path);
	if (!abs) throw httpErr(404, "chat.errors.not_found");
	try {
		await fsp.access(abs, fs.constants.R_OK);
	} catch {
		throw httpErr(404, "chat.errors.not_found");
	}
	const inline = !download && !Number(f.as_file) && INLINE.test(f.mime);
	const pdf = inline && f.mime === "application/pdf";
	res.setHeader("Content-Type", inline ? f.mime : "application/octet-stream");
	res.setHeader("Content-Disposition", disposition(inline ? "inline" : "attachment", String(f.name)));
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
	// Файл не може виконати скрипти від імені сайту. PDF — без sandbox: інакше вбудований переглядач браузера його не покаже
	res.setHeader("Content-Security-Policy", pdf ? "frame-ancestors 'self'" : "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
	res.setHeader("Cache-Control", "private, max-age=86400");
	await new Promise((resolve) =>
		res.sendFile(abs, { dotfiles: "deny", lastModified: false }, (err) => {
			if (err && !res.headersSent) res.status(err.statusCode || 404).end();
			resolve();
		})
	);
}

/** Файли чату (вкладка «Файли»): media — фото й відео, docs — решта */
async function listRoom(uid, idRoom, { kind, before } = {}) {
	await membership(idRoom, uid);
	const where = ["f.id_room = ?", "f.id_message IS NOT NULL"];
	const params = [idRoom];
	if (kind === "media") where.push("f.as_file = 0 AND (f.mime LIKE 'image/%' OR f.mime LIKE 'video/%')");
	if (kind === "docs") where.push("(f.as_file = 1 OR (f.mime NOT LIKE 'image/%' AND f.mime NOT LIKE 'video/%'))");
	if (before) {
		where.push("f.id < ?");
		params.push(before);
	}
	const [rows] = await pool.query(
		`SELECT f.id, f.code, f.id_message, f.id_user, f.name, f.mime, f.size, f.width, f.height, f.as_file, f.date_add
		   FROM ${T.files} f WHERE ${where.join(" AND ")} ORDER BY f.id DESC LIMIT 61`,
		params
	);
	return { files: rows.slice(0, 60).map((r) => ({ ...shape(r), id_message: Number(r.id_message), id_user: r.id_user, date: r.date_add })), more: rows.length > 60 };
}

/** Завантажені, але так і не надіслані файли — прибрати через добу */
async function cleanupOrphans() {
	// Файли відкладених повідомлень не чіпаємо — вони прив'яжуться під час надсилання
	const [rows] = await pool.query(
		`SELECT f.id, f.path FROM ${T.files} f
		  WHERE f.id_message IS NULL AND f.date_add < NOW() - INTERVAL ? HOUR
		    AND NOT EXISTS (SELECT 1 FROM ${T.scheduled} s WHERE s.status = 'wait' AND s.id_user = f.id_user AND JSON_CONTAINS(s.files, CAST(f.id AS JSON)))
		  LIMIT 500`,
		[ORPHAN_HOURS]
	);
	if (!rows.length) return 0;
	await pool.query(`DELETE FROM ${T.files} WHERE id IN (?)`, [rows.map((r) => r.id)]);
	await unlinkUnused(rows.map((r) => r.path));
	return rows.length;
}

/** Видалити щойно завантажений файл (помилка після multer — файл не має лишитись на диску) */
const discard = (file) => file && file.path && fsp.unlink(file.path).catch(() => {});

module.exports = { upload, register, forMessages, copyTo, detach, unlinkUnused, serve, listRoom, cleanupOrphans, discard, sniff, cleanName, extOf, MAX_SIZE, ROOT, ALLOWED };