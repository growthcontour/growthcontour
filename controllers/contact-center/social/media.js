/**
 * Медіатека публікацій.
 * Фото нормалізуються в JPEG (Instagram приймає лише JPEG), відео зберігаються як є (MP4 / MOV).
 * Файли лежать поза публічною текою; мережам віддаються за підписаним тимчасовим посиланням.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const sharp = require("sharp");
const pool = require("../../../config/database/connection_pool");
const { P, httpErr, STORAGE_ROOT, checkSign } = require("./social");

const T = P + "social_media";
const TMP = path.join(STORAGE_ROOT, "tmp");

const MAX_IMAGE = 30 * 1024 * 1024; // вхідне фото (після обробки — до 8 МБ JPEG)
const MAX_VIDEO = 1024 * 1024 * 1024; // Instagram Reels — до 1 ГБ
const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const VIDEO_MIME = ["video/mp4", "video/quicktime"];

const upload = multer({
	storage: multer.diskStorage({
		destination: (req, file, cb) => fs.promises.mkdir(TMP, { recursive: true }).then(() => cb(null, TMP), cb),
		filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString("hex")),
	}),
	limits: { fileSize: MAX_VIDEO, files: 10 },
	fileFilter: (req, file, cb) => (IMAGE_MIME.includes(file.mimetype) || VIDEO_MIME.includes(file.mimetype) ? cb(null, true) : cb(httpErr(400, "contact_center.social.errors.media_type"))),
});

function sha256File(file) {
	return new Promise((resolve, reject) => {
		const h = crypto.createHash("sha256");
		fs.createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
	});
}

/** Тека за місяцем: 2026/10 */
function monthDir() {
	const d = new Date();
	return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Обробити завантажений multer-файл → рядок медіатеки */
async function ingest(file, idUser) {
	try {
		const isImage = IMAGE_MIME.includes(file.mimetype);
		if (isImage && file.size > MAX_IMAGE) throw httpErr(400, "contact_center.social.errors.image_too_big", { mb: MAX_IMAGE / 1048576 });

		const rel = monthDir();
		await fs.promises.mkdir(path.join(STORAGE_ROOT, rel), { recursive: true });
		const name = crypto.randomBytes(16).toString("hex");
		let row;

		if (isImage) {
			// Поворот за EXIF, sRGB, без метаданих; довга сторона ≤ 4096 (обмеження Meta)
			const out = path.join(rel, name + ".jpg");
			const info = await sharp(file.path, { failOn: "error" })
				.rotate()
				.resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true })
				.flatten({ background: "#ffffff" })
				.jpeg({ quality: 90, mozjpeg: true })
				.toFile(path.join(STORAGE_ROOT, out));
			row = { kind: "image", path: out, mime: "image/jpeg", size: info.size, width: info.width, height: info.height };
		} else {
			const ext = file.mimetype === "video/quicktime" ? ".mov" : ".mp4";
			const out = path.join(rel, name + ext);
			await fs.promises.rename(file.path, path.join(STORAGE_ROOT, out));
			row = { kind: "video", path: out, mime: file.mimetype, size: file.size, width: null, height: null };
		}

		row.sha256 = await sha256File(path.join(STORAGE_ROOT, row.path));
		const [r] = await pool.query(`INSERT INTO ${T} (kind, path, original_name, mime, size, width, height, sha256, id_user) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
			row.kind,
			row.path,
			String(file.originalname || "").slice(0, 255),
			row.mime,
			row.size,
			row.width,
			row.height,
			row.sha256,
			idUser || null,
		]);
		return { id: r.insertId, ...row, original_name: file.originalname };
	} finally {
		fs.promises.unlink(file.path).catch(() => {});
	}
}

async function list(q) {
	const page = Math.max(1, parseInt(q.page, 10) || 1);
	const size = Math.min(100, Math.max(1, parseInt(q.size, 10) || 40));
	const where = ["deleted = 0"];
	const args = [];
	if (q.kind === "image" || q.kind === "video") {
		where.push("kind = ?");
		args.push(q.kind);
	}
	const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T} WHERE ${where.join(" AND ")}`, args);
	const [rows] = await pool.query(`SELECT id, kind, original_name, mime, size, width, height, date_add FROM ${T} WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`, [...args, size, (page - 1) * size]);
	return { last_page: Math.max(1, Math.ceil(n / size)), data: rows };
}

async function get(id) {
	const [[r]] = await pool.query(`SELECT * FROM ${T} WHERE id = ? AND deleted = 0`, [id]);
	if (!r) throw httpErr(404, "contact_center.social.errors.media_not_found");
	return r;
}

async function byIds(ids) {
	if (!ids.length) return [];
	const [rows] = await pool.query(`SELECT * FROM ${T} WHERE id IN (?) AND deleted = 0`, [ids]);
	return rows;
}

async function remove(id) {
	// Медіа, що вже в публікаціях, не видаляємо фізично — лише ховаємо з медіатеки
	await pool.query(`UPDATE ${T} SET deleted = 1 WHERE id = ?`, [id]);
}

/** Мініатюра для інтерфейсу (лише фото) */
async function thumb(req, res) {
	const m = await get(parseInt(req.params.id, 10));
	const file = path.join(STORAGE_ROOT, m.path);
	if (m.kind !== "image") return res.sendStatus(404);
	res.set("Cache-Control", "private, max-age=86400");
	res.type("image/jpeg");
	sharp(file).resize({ width: 320, height: 320, fit: "cover" }).jpeg({ quality: 75 }).pipe(res);
}

/** Повний файл для інтерфейсу (перегляд відео / фото) */
async function file(req, res) {
	const m = await get(parseInt(req.params.id, 10));
	res.set("Cache-Control", "private, max-age=86400");
	res.sendFile(path.join(STORAGE_ROOT, m.path), { headers: { "Content-Type": m.mime } });
}

/**
 * Публічна віддача за підписом: /social/media/:id/:exp/:sig[/:variant]/file.ext
 * Підтримує Range (Meta та Telegram качають відео частинами).
 */
async function publicFile(req, res) {
	const id = parseInt(req.params.id, 10);
	const variant = req.params.variant || "";
	if (!id || !checkSign(id, req.params.exp, req.params.sig, variant)) return res.sendStatus(403);

	let m;
	try {
		m = await get(id);
	} catch (e) {
		return res.sendStatus(404);
	}
	const full = path.join(STORAGE_ROOT, m.path);
	res.set("Cache-Control", "public, max-age=3600");
	res.set("X-Content-Type-Options", "nosniff");

	// Viber: фото до 1 МБ — зменшуємо до 1600 px, якість 80
	if (variant === "viber" && m.kind === "image") {
		res.type("image/jpeg");
		return sharp(full).resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).pipe(res);
	}
	return res.sendFile(full, { headers: { "Content-Type": m.mime }, acceptRanges: true });
}

module.exports = { upload, ingest, list, get, byIds, remove, thumb, file, publicFile, STORAGE_ROOT };
