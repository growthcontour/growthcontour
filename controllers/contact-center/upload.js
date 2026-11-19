const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const files = require("./files");

const P = config.get("configDatabase").prefix;

const MAX_SIZE = 50 * 1024 * 1024;

// Виконувані розширення не приймаємо — файл лежить під публічним URL
const BLOCKED = /\.(php|phtml|phar|js|mjs|cjs|html?|htm|svg|exe|sh|bat|cmd|com|scr|jar|py|pl|rb)$/i;

const storage = multer.diskStorage({
	// Тека визначається діалогом: <тип каналу>/<url_token>/manager
	destination: async function (req, file, cb) {
		try {
			const id = parseInt(req.params.id, 10);

			const [rows] = await connection_pool.query(
				`SELECT c.url_token, ch.type AS channel_type
                   FROM ${P}contact_center_conversations AS c
                   INNER JOIN ${P}contact_center_channels AS ch ON ch.id = c.id_channel
                  WHERE c.id = ? LIMIT 1`,
				[id]
			);

			if (!rows.length) return cb(new Error("Conversation not found"));

			const dir = path.join(files.UPLOAD_ROOT, files.conversationDir(rows[0].channel_type, rows[0].url_token, "manager"));

			await fs.promises.mkdir(dir, { recursive: true });
			cb(null, dir);
		} catch (error) {
			cb(error);
		}
	},

	// Ім'я генеруємо самі: оригінальне приходить від користувача
	filename: function (req, file, cb) {
		const ext = files.extFor(file.mimetype, file.originalname);
		cb(null, crypto.randomBytes(16).toString("hex") + ext);
	},
});

module.exports = multer({
	storage: storage,
	limits: { fileSize: MAX_SIZE, files: 1 },
	fileFilter: function (req, file, cb) {
		if (BLOCKED.test(String(file.originalname || ""))) {
			return cb(new Error("Тип файлу заборонено"));
		}
		cb(null, true);
	},
});
