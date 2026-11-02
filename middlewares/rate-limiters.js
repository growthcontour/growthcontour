"use strict";

const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const cfgJWT = require("../config/config").get("configJWT");

function isAuthenticated(req) {
	try {
		const token = req.cookies && req.cookies.access_token;
		if (!token) return false;
		jwt.verify(token, cfgJWT.jwt.jwt_secret);
		return true;
	} catch {
		return false;
	}
}

const EXCLUDED_PREFIXES = [
	"/api/contact-center/webhook/",
	"/viber/webhook/",
	"/api/integrations/v1/sync/",
	"/api/orders/abandoned-cart/receive/",
	"/api/orders/abandoned-cart/recover/",
	"/chat/",
];

const extraFromEnv = (process.env.RATE_LIMIT_EXCLUDE || "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

const ALL_EXCLUDED = EXCLUDED_PREFIXES.concat(extraFromEnv);

function isExcludedPath(p) {
	return ALL_EXCLUDED.some(
		(prefix) => p === prefix || p.startsWith(prefix) || p === prefix.replace(/\/$/, "")
	);
}

function shouldSkip(req) {
	if (isExcludedPath(req.path)) return true;
	const url = req.originalUrl ? req.originalUrl.split("?")[0] : "";
	return url !== "" && isExcludedPath(url);
}

const GUEST_MAX = Number(process.env.RATE_LIMIT_MAX) || 300;
const AUTH_MAX = Number(process.env.RATE_LIMIT_MAX_AUTH) || 3000;

const globalApiLimiter = rateLimit({
	windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
	limit: (req, res) => (isAuthenticated(req) ? AUTH_MAX : GUEST_MAX),
	standardHeaders: "draft-7",
	legacyHeaders: false,
	keyGenerator: (req) => {
		if (isAuthenticated(req)) {
			try {
				const decoded = jwt.verify(req.cookies.access_token, cfgJWT.jwt.jwt_secret);
				return `auth:${decoded.id || decoded.sub || decoded.uid || ipKeyGenerator(req.ip)}`;
			} catch {
				/* unreachable */
			}
		}
		return `guest:${ipKeyGenerator(req.ip)}`;
	},
	skip: shouldSkip,
	message: { status: "error", message: "Too many requests. Try again later." },
});

const inviteAcceptLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 20,
	standardHeaders: true,
	legacyHeaders: false,
	message: { status: "error", message: "Too many attempts. Try again later." },
});

const invitePageLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 60,
	standardHeaders: true,
	legacyHeaders: false,
});

const resendInviteLimiter = rateLimit({
	windowMs: 60 * 60 * 1000,
	max: 10,
	standardHeaders: true,
	legacyHeaders: false,
	message: { status: "error", message: "Too many invites sent. Try again later." },
});

module.exports = {
	inviteAcceptLimiter,
	invitePageLimiter,
	resendInviteLimiter,
	globalApiLimiter,
};