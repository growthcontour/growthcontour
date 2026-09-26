/**
 * ===================================================================
 * ФАЙЛ: routes/administrator/authorization/login/login.js
 * ОПИС: Маршрути авторизації (Login, 2FA, Logout, 2FA-налаштування)
 * ===================================================================
 */

const express = require("express");
const router = express.Router();
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const jwt = require("jsonwebtoken");

const authorizationControllers = require("../../../../controllers/authorization/authorization");
const tfaSettingsControllers = require("../../../../controllers/authorization/tfa_settings");

const config = require("../../../../config/config");
const jwtConfig = config.get("configJWT");

const i18n = require("../../../../config/i18n/i18n");

// ─── RATE LIMITERS ────────────────────────────────────────────────
const loginLimiterByIp = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 20,
	standardHeaders: true,
	legacyHeaders: false,
	keyGenerator: (req) => ipKeyGenerator(req.ip),
	handler: (req, res) => {
		const locale = req.cookies?.lang || "uk";
		const message = i18n.__({ phrase: "authorization.error.authorization_blocked", locale }, { minutes: 15, seconds: 0 });
		res.status(429).json({
			status: "rate_limited",
			message: message,
			errors: [{ field: "rate", minutes: 15 }],
		});
	},
});

const loginLimiterByAccount = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 5,
	standardHeaders: true,
	legacyHeaders: false,
	keyGenerator: (req) => (req.body.email ? String(req.body.email).toLowerCase().trim() : ipKeyGenerator(req.ip)),
	skip: (req) => !req.body.email,
	handler: (req, res) => {
		const locale = req.cookies?.lang || "uk";
		// Реальний час до розблокування з rate-limiter'а.
		const msLeft = req.rateLimit?.resetTime ? req.rateLimit.resetTime.getTime() - Date.now() : 15 * 60 * 1000;
		const totalSeconds = Math.max(0, Math.ceil(msLeft / 1000));
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;

		const message = i18n.__({ phrase: "authorization.error.authorization_blocked", locale }, { minutes, seconds });

		res.status(429).json({
			status: "rate_limited",
			message: message,
			errors: [{ field: "rate", minutes, seconds }],
		});
	},
});

const tfaSettingsLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 10,
	standardHeaders: true,
	legacyHeaders: false,
	handler: (req, res) => res.status(429).json({ status: "rate_limited", errors: [{ field: "rate", minutes: 15 }] }),
});

// ─── Якщо вже залогінений — на головну ────────────────────────────
function redirectIfAuthenticated(req, res, next) {
	const token = req.cookies?.access_token;
	if (!token) return next();
	try {
		jwt.verify(token, jwtConfig.jwt.jwt_secret);
		return res.redirect("/");
	} catch {
		res.clearCookie("access_token");
		return next();
	}
}

// ─── GET /login — форма входу ─────────────────────────────────────
router.get("/login/", redirectIfAuthenticated, (req, res) => {
	res.render("pages/administrator/authorization/login/login", {
		i18n: req,
		error: null,
		message: null,
		status: null,
		email: "",
	});
});

// ─── POST /login — крок 1 (пароль) ────────────────────────────────
router.post("/login/", loginLimiterByIp, loginLimiterByAccount, authorizationControllers.login);

// ─── POST /login/tfa — крок 2 (код 2FA) ───────────────────────────
router.post("/login/tfa/", loginLimiterByIp, authorizationControllers.loginTfa);

// ─── GET/POST /logout — вихід із системи ──────────────────────────
function doLogout(req, res) {
	res.clearCookie("access_token");
	res.clearCookie("refresh_token");
	if (req.session) {
		req.session.destroy(() => res.redirect("/login/"));
	} else {
		res.redirect("/login/");
	}
}
router.get("/logout/", doLogout);
router.post("/logout/", doLogout);

// ─── 2FA API (потребує авторизації) ───────────────────────────────
router.get("/api/tfa/status", authorizationControllers.isAuthenticated, tfaSettingsControllers.status);
router.post("/api/tfa/init", tfaSettingsLimiter, authorizationControllers.isAuthenticated, tfaSettingsControllers.init);
router.post("/api/tfa/confirm", tfaSettingsLimiter, authorizationControllers.isAuthenticated, tfaSettingsControllers.confirm);
router.post("/api/tfa/disable", tfaSettingsLimiter, authorizationControllers.isAuthenticated, tfaSettingsControllers.disable);
router.post("/api/tfa/backup-codes/regenerate", tfaSettingsLimiter, authorizationControllers.isAuthenticated, tfaSettingsControllers.regenerateBackupCodes);

module.exports = router;
