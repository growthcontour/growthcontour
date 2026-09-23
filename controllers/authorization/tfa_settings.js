/**
 * ===================================================================
 * ФАЙЛ: controllers/authorization/tfa_settings.js
 * ОПИС: Налаштування 2FA — узгоджено з helpers/tfa.js та crypto_tfa.js
 * ===================================================================
 */

const db = require("../../config/database/connection_pool");
const bcrypt = require("bcrypt");
const tfa = require("../../helpers/tfa");
const jwt = require("jsonwebtoken");
const { encryptSecret } = require("../../helpers/crypto_tfa");

// ─── Конфігурація ────────────────────────────────────────────────────────────
const config = require("../../config/config");
const configJWT = config.get("configJWT");
const configDatabase = config.get("configDatabase");
const prefix = configDatabase.prefix;
// ─── Конфігурація ────────────────────────────────────────────────────────────

const tfaSettingsControllers = {
	// Статус 2FA
	status: async (req, res) => {
		try {
			const userId = req.user.userId;
			const [rows] = await db.execute(`SELECT tfa_enabled FROM ${prefix}users WHERE id = ?`, [userId]);
			if (rows.length === 0) return res.status(404).json({ status: "error", message: "User not found" });
			const [[cnt]] = await db.execute(`SELECT COUNT(*) AS left_count FROM ${prefix}users_tfa_backup_codes WHERE id_user = ? AND used_at IS NULL`, [userId]);
			res.json({ status: "success", tfa_enabled: rows[0].tfa_enabled === 1, codes_left: cnt.left_count });
		} catch (error) {
			console.error("[TFA STATUS ERROR]:", error);
			res.status(500).json({ status: "error", message: "Server error" });
		}
	},

	// Ініціалізація: генерує секрет, шифрує його у pending, віддає QR
	init: async (req, res) => {
		try {
			const userId = req.user.userId;
			const { password } = req.body;
			if (!password) return res.status(400).json({ status: "invalid_password", message: "Потрібен пароль" });
			const [rows] = await db.execute(`SELECT email, password, tfa_enabled FROM ${prefix}users WHERE id = ?`, [userId]);
			if (rows.length === 0) return res.status(404).json({ status: "error", message: "User not found" });
			if (rows[0].tfa_enabled === 1) return res.status(400).json({ status: "error", message: "2FA вже увімкнено" });
			const passOk = await bcrypt.compare(password, rows[0].password);
			if (!passOk) return res.status(401).json({ status: "invalid_password", message: "Невірний пароль" });

			const secret = tfa.generateSecret();
			const otpauthUrl = tfa.buildOtpauthUrl(rows[0].email, secret);
			const qrDataUrl = await tfa.buildQrDataUrl(otpauthUrl);

			// У БД зберігаємо ЗАШИФРОВАНИЙ секрет як pending
			await db.execute(`UPDATE ${prefix}users SET tfa_secret_pending = ? WHERE id = ?`, [encryptSecret(secret), userId]);

			// Клієнту віддаємо plaintext-секрет лише для показу/ручного вводу і QR
			res.json({ status: "success", secret, qr: qrDataUrl });
		} catch (error) {
			console.error("[TFA INIT ERROR]:", error);
			res.status(500).json({ status: "error", message: "Server error" });
		}
	},

	// Підтвердження: перевіряє код проти pending-секрету, вмикає 2FA, видає backup-коди
	confirm: async (req, res) => {
		try {
			const userId = req.user.userId;
			const code = tfa.normalizeCode(req.body.code);
			if (!code) return res.status(400).json({ status: "error", message: "Code required" });

			const [rows] = await db.execute(`SELECT tfa_secret_pending FROM ${prefix}users WHERE id = ?`, [userId]);
			const pending = rows[0] && rows[0].tfa_secret_pending;
			if (!pending) return res.status(400).json({ status: "error", message: "No pending secret" });

			// Реальна перевірка TOTP (lastStep=0 — на етапі підтвердження anti-replay не потрібен)
			const result = tfa.verifyTotp(pending, code, 0);
			if (!result.ok) return res.status(400).json({ status: "invalid", message: "Invalid code" });

			// Вмикаємо 2FA: pending → secret, піднімаємо token_version (розлогінити інші сесії)
			await db.execute(
				`UPDATE ${prefix}users
				 SET tfa_secret = tfa_secret_pending, tfa_secret_pending = '',
				     tfa_enabled = 1, tfa_last_step = ?, token_version = token_version + 1
				 WHERE id = ?`,
				[result.step, userId]
			);

			// Поточна сесія користувача має лишитись живою: перевидаємо токен
			// з новою версією (інші сесії при цьому інвалідуються старою версією).
			const [[freshUser]] = await db.execute(`SELECT token_version FROM ${prefix}users WHERE id = ?`, [userId]);
			const newToken = jwt.sign(
				{
					userId: req.user.userId,
					email: req.user.email,
					firstName: req.user.firstName,
					lastName: req.user.lastName,
					type: "access",
					token_version: freshUser.token_version,
				},
				configJWT.jwt.jwt_secret,
				{ expiresIn: "24h" }
			);
			res.cookie("access_token", newToken, {
				httpOnly: true,
				secure: process.env.NODE_ENV === "production",
				sameSite: "strict",
				path: "/",
				maxAge: 24 * 60 * 60 * 1000,
			});

			// Генеруємо backup-коди (показуємо один раз)
			const codes = tfa.generateBackupCodes();
			await db.execute(`DELETE FROM ${prefix}users_tfa_backup_codes WHERE id_user = ?`, [userId]);
			const values = codes.map((c) => [userId, tfa.hashBackupCode(c)]);
			await db.query(`INSERT INTO ${prefix}users_tfa_backup_codes (id_user, code_hash) VALUES ?`, [values]);

			res.json({ status: "success", message: "2FA enabled", backup_codes: codes });
		} catch (error) {
			console.error("[TFA CONFIRM ERROR]:", error);
			res.status(500).json({ status: "error", message: "Server error" });
		}
	},

	// Вимкнення: ВИМАГАЄ пароль + діючий код 2FA (або backup)
	disable: async (req, res) => {
		try {
			const userId = req.user.userId;
			const { password } = req.body;
			const code = tfa.normalizeCode(req.body.code);
			if (!password || !code) return res.status(400).json({ status: "error", message: "Потрібні пароль і код 2FA" });

			const [rows] = await db.execute(`SELECT password, tfa_secret, tfa_last_step FROM ${prefix}users WHERE id = ?`, [userId]);
			if (rows.length === 0) return res.status(404).json({ status: "error", message: "User not found" });

			const ok = await bcrypt.compare(password, rows[0].password);
			if (!ok) return res.status(401).json({ status: "invalid_password", message: "Невірний пароль" });

			// Перевіряємо код (TOTP або backup)
			let codeOk = false;
			if (tfa.isValidBackupFormat(code)) {
				const [b] = await db.execute(`SELECT id FROM ${prefix}users_tfa_backup_codes WHERE id_user = ? AND code_hash = ? AND used_at IS NULL LIMIT 1`, [userId, tfa.hashBackupCode(code)]);
				codeOk = b.length > 0;
			} else {
				codeOk = tfa.verifyTotp(rows[0].tfa_secret, code, rows[0].tfa_last_step).ok;
			}
			if (!codeOk) return res.status(401).json({ status: "invalid", message: "Невірний код 2FA" });

			await db.execute(
				`UPDATE ${prefix}users
				 SET tfa_enabled = 0, tfa_secret = '', tfa_secret_pending = '',
				     tfa_last_step = 0, token_version = token_version + 1
				 WHERE id = ?`,
				[userId]
			);
			await db.execute(`DELETE FROM ${prefix}users_tfa_backup_codes WHERE id_user = ?`, [userId]);

			// Перевидаємо токен поточної сесії, щоб не розлогінити себе.
			const [[freshUser]] = await db.execute(`SELECT token_version FROM ${prefix}users WHERE id = ?`, [userId]);
			const newToken = jwt.sign(
				{
					userId: req.user.userId,
					email: req.user.email,
					firstName: req.user.firstName,
					lastName: req.user.lastName,
					type: "access",
					token_version: freshUser.token_version,
				},
				configJWT.jwt.jwt_secret,
				{ expiresIn: "24h" }
			);
			res.cookie("access_token", newToken, {
				httpOnly: true,
				secure: process.env.NODE_ENV === "production",
				sameSite: "strict",
				path: "/",
				maxAge: 24 * 60 * 60 * 1000,
			});

			res.json({ status: "success", message: "2FA disabled" });
		} catch (error) {
			console.error("[TFA DISABLE ERROR]:", error);
			res.status(500).json({ status: "error", message: "Server error" });
		}
	},

	// Перегенерація backup-кодів (вимагає діючий код 2FA)
	regenerateBackupCodes: async (req, res) => {
		try {
			const userId = req.user.userId;
			const code = tfa.normalizeCode(req.body.code);
			if (!code) return res.status(400).json({ status: "error", message: "Потрібен код 2FA" });

			const { password } = req.body;
			const [rows] = await db.execute(`SELECT password, tfa_secret, tfa_last_step, tfa_enabled FROM ${prefix}users WHERE id = ?`, [userId]);
			if (rows.length === 0 || rows[0].tfa_enabled !== 1) {
				return res.status(400).json({ status: "error", message: "2FA не увімкнено" });
			}
			if (password) {
				const passOk = await bcrypt.compare(password, rows[0].password);
				if (!passOk) return res.status(401).json({ status: "invalid_password", message: "Невірний пароль" });
			}
			if (!tfa.verifyTotp(rows[0].tfa_secret, code, rows[0].tfa_last_step).ok) {
				return res.status(401).json({ status: "invalid", message: "Невірний код 2FA" });
			}

			const codes = tfa.generateBackupCodes();
			await db.execute(`DELETE FROM ${prefix}users_tfa_backup_codes WHERE id_user = ?`, [userId]);
			const values = codes.map((c) => [userId, tfa.hashBackupCode(c)]);
			await db.query(`INSERT INTO ${prefix}users_tfa_backup_codes (id_user, code_hash) VALUES ?`, [values]);

			res.json({ status: "success", backup_codes: codes });
		} catch (error) {
			console.error("[TFA BACKUP ERROR]:", error);
			res.status(500).json({ status: "error", message: "Server error" });
		}
	},
};

module.exports = tfaSettingsControllers;
