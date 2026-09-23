const crypto = require("crypto");

// Нормалізуємо ключ довільної довжини до 32 байт для AES-256
const KEY = crypto.createHash("sha256").update(String(process.env.APP_ENCRYPTION_KEY)).digest();

module.exports = {
	// Повертає { cipher, iv, tag } — Buffer'и під колонки VARBINARY
	encrypt(plain) {
		if (plain == null || plain === "") return { cipher: null, iv: null, tag: null };

		const iv = crypto.randomBytes(12);
		const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
		const cipher = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);

		return { cipher: cipher, iv: iv, tag: c.getAuthTag() };
	},

	// Повертає рядок або null, якщо дані пошкоджені / ключ змінився
	decrypt(cipher, iv, tag) {
		if (!cipher || !iv || !tag) return null;

		try {
			const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
			d.setAuthTag(tag);
			return Buffer.concat([d.update(cipher), d.final()]).toString("utf8");
		} catch (e) {
			return null;
		}
	},

	last4(str) {
		const s = String(str || "");
		return s.length >= 4 ? s.slice(-4) : null;
	},

	random(bytes) {
		return crypto.randomBytes(bytes).toString("hex");
	},
};