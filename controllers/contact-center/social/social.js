/**
 * Спільне для модуля «Публікації в соцмережі».
 */
const crypto = require("crypto");
const path = require("path");
const config = require("../../../config/config");
const i18n = require("../../../config/i18n/i18n");

const P = config.get("configDatabase").prefix;

// Фонові тексти (черга, cron) — мова системи
const LOCALE = process.env.APP_LOCALE || "uk";
const t = (phrase, vars) => i18n.__({ phrase, locale: LOCALE }, vars || {});

/** Помилка з HTTP-статусом і ключем перекладу (роут перекладає через req.__) */
function httpErr(status, key, params) {
	return Object.assign(new Error(key), { status, params: params || {} });
}

/**
 * Помилка мережі під час публікації.
 * temporary = true → повторимо пізніше (мережа, ліміти, 5xx); false → публікація неможлива без змін.
 */
class PublishError extends Error {
	constructor(message, temporary) {
		super(message);
		this.temporary = !!temporary;
	}
}

/** Текст помилки з відповіді Graph / Telegram / Viber + чи тимчасова вона */
function apiError(e) {
	const r = e && e.response;
	const d = r && r.data;
	const msg = (d && d.error && (d.error.error_user_msg || d.error.message)) || (d && d.description) || (d && d.status_message) || (e && e.message) || "Unknown error";
	const code = d && d.error && d.error.code;
	const status = r ? r.status : 0;
	// Тимчасові: без відповіді (мережа), 429/5xx, коди Meta 1/2/4/17/32/341/613 (ліміти, збій сервісу), Telegram 429
	const temporary = !r || status === 429 || status >= 500 || [1, 2, 4, 17, 32, 341, 613].includes(Number(code)) || Boolean(d && d.parameters && d.parameters.retry_after);
	return new PublishError(String(msg).slice(0, 900), temporary);
}

/* ─── Підписані публічні посилання на медіа (Meta / Telegram / Viber забирають файл самі) ─── */

const SIGN_KEY = crypto.createHash("sha256").update("social-media:" + String(process.env.APP_ENCRYPTION_KEY || "")).digest();

function sign(id, exp, variant) {
	return crypto.createHmac("sha256", SIGN_KEY).update(`${id}.${exp}.${variant || ""}`).digest("hex").slice(0, 32);
}

/**
 * Публічна адреса файлу медіатеки, дійсна ttlHours годин.
 * variant: "" — оригінал, "viber" — зменшене фото (Viber приймає фото до 1 МБ).
 */
function mediaUrl(media, variant, ttlHours) {
	const base = String(config.get("configServer").url || "").replace(/\/+$/, "");
	const exp = Math.floor(Date.now() / 1000) + 3600 * (ttlHours || 24);
	const ext = media.kind === "image" ? ".jpg" : path.extname(media.path) || ".mp4";
	return `${base}/contact-center/social/public/${media.id}/${exp}/${sign(media.id, exp, variant)}${variant ? "/" + variant : ""}/file${ext}`;
}

function checkSign(id, exp, sig, variant) {
	if (Number(exp) < Date.now() / 1000) return false;
	const good = Buffer.from(sign(id, exp, variant));
	const got = Buffer.from(String(sig || ""));
	return got.length === good.length && crypto.timingSafeEqual(got, good);
}

// Як і вкладення контакт-центру — у assets/contact-center (controllers/contact-center/files.js)
const STORAGE_ROOT = path.join(process.cwd(), "assets", "contact-center", "social");

const NETWORKS = ["instagram", "facebook", "telegram", "viber"];

/** Які формати підтримує мережа */
const FORMATS = {
	instagram: ["post", "reel", "story"],
	facebook: ["post", "reel", "story"],
	telegram: ["post"],
	viber: ["post"],
};

/** Ліміти тексту (символи) */
const TEXT_LIMITS = { instagram: 2200, facebook: 63206, telegram: 4096, viber: 7000 };

module.exports = { P, t, httpErr, PublishError, apiError, mediaUrl, checkSign, STORAGE_ROOT, NETWORKS, FORMATS, TEXT_LIMITS };