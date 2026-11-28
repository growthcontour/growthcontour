"use strict";

/**
 * Захисний вхід (як htpasswd): браузер питає окремий логін і пароль ще до сторінки входу в систему.
 *
 * Налаштування — у .env (ensure-env.js): GATE_ENABLED=true|false, GATE_USERS=логін:пароль,логін2:пароль2.
 *
 * Де діє — лише там, де працюють співробітники:
 *  - вхід, 2FA, вихід, запрошення, підтвердження email (gate.entrance у server.js);
 *  - кожен запит, що вимагає сесії співробітника (authorization.isAuthenticated викликає gate.check).
 * Публічне не зачіпається ніколи: API сайтів, вебхуки, віджет чату, вітрина Telegram, посилання з розсилок,
 * відновлення кошика, завантаження за токеном — вони не проходять через isAuthenticated.
 *
 * Після успішного Basic-входу ставиться cookie gc_gate (HMAC, 30 днів): AJAX, завантаження файлів і Socket.IO
 * не залежать від того, чи браузер повторює заголовок Authorization. Зміна GATE_USERS (видалили доступ
 * чи змінили пароль) робить усі видані cookie недійсними.
 */

const crypto = require("crypto");
const { gateAccounts } = require("../ensure-env");

const COOKIE = "gc_gate";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REALM = "Growth Contour";

// Налаштування читаються один раз при запуску (зміна .env — через перезапуск, як і решта конфігурації)
const cfg = gateAccounts();
const enabled = cfg.enabled && cfg.users.length > 0;
// Ключ підпису cookie: секрет сесій + поточний список доступів (змінили список — старі cookie недійсні)
const key = crypto
	.createHash("sha256")
	.update(String(process.env.SESSION_SECRET || process.env.JWT_SECRET || "") + "|" + cfg.users.map((u) => u.login + ":" + u.password).join(","))
	.digest();

const sign = (payload) => crypto.createHmac("sha256", key).update(payload).digest("base64url");

/** Порівняння за сталий час (довжини різні — false без витоку часу на вміст) */
function same(a, b) {
	const x = Buffer.from(String(a));
	const y = Buffer.from(String(b));
	if (x.length !== y.length) {
		crypto.timingSafeEqual(x, x);
		return false;
	}
	return crypto.timingSafeEqual(x, y);
}

/** Логін із заголовка Authorization: Basic, якщо логін і пароль правильні; інакше null */
function fromHeader(req) {
	const h = String(req.headers.authorization || "");
	if (!/^basic\s+/i.test(h)) return null;
	let decoded = "";
	try {
		decoded = Buffer.from(h.replace(/^basic\s+/i, ""), "base64").toString("utf8");
	} catch {
		return null;
	}
	const i = decoded.indexOf(":");
	if (i < 1) return null;
	const login = decoded.slice(0, i);
	const password = decoded.slice(i + 1);
	let hit = null;
	// Перебираємо всі доступи без раннього виходу — час відповіді не підказує, який логін існує
	for (const u of cfg.users) {
		if (same(u.login, login) & same(u.password, password)) hit = u.login;
	}
	return hit;
}

/** Логін із cookie gc_gate, якщо підпис правильний і строк не минув */
function fromCookie(req) {
	const v = req.cookies && req.cookies[COOKIE];
	if (!v || typeof v !== "string") return null;
	const parts = v.split(".");
	if (parts.length !== 3) return null;
	const [login, exp, sig] = parts;
	if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
	if (!same(sig, sign(login + "." + exp))) return null;
	return cfg.users.some((u) => u.login === Buffer.from(login, "base64url").toString("utf8")) ? login : null;
}

function setCookie(req, res, login) {
	const exp = Date.now() + TTL_MS;
	const l = Buffer.from(login, "utf8").toString("base64url");
	res.cookie(COOKIE, `${l}.${exp}.${sign(l + "." + exp)}`, {
		maxAge: TTL_MS,
		httpOnly: true,
		secure: req.secure || process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
	});
}

/**
 * Пропущено через захисний вхід? true — так (або вхід вимкнено); false — відповідь 401 уже надіслано.
 */
function check(req, res) {
	if (!enabled || req.gatePassed) return true;
	if (fromCookie(req)) {
		req.gatePassed = true;
		return true;
	}
	const login = fromHeader(req);
	if (login) {
		setCookie(req, res, login);
		req.gatePassed = true;
		return true;
	}
	res.set("WWW-Authenticate", `Basic realm="${REALM}", charset="UTF-8"`);
	res.set("Cache-Control", "no-store");
	if (req.xhr || (req.headers.accept || "").includes("json")) {
		res.status(401).json({ status: "error", message: "Access gate: authentication required" });
	} else {
		res.status(401).type("text/plain").send("Authentication required");
	}
	return false;
}

/** Middleware: next() лише після захисного входу */
function middleware(req, res, next) {
	if (check(req, res)) next();
}

/** Шляхи входу співробітників (без сесії), які теж закриває захисний вхід */
const ENTRANCE = [/^\/$/, /^\/login\//, /^\/logout\//, /^\/invite\//, /^\/users\/email\/confirm\//];

/** Middleware для app.use: закриває лише шляхи входу, решту пропускає без змін */
function entrance(req, res, next) {
	if (!enabled || !ENTRANCE.some((re) => re.test(req.path))) return next();
	if (check(req, res)) next();
}

module.exports = { enabled, check, middleware, entrance };