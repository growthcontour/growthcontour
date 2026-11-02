"use strict";

const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const logging = require("../../../logging/logging");
const audit = require("../../../controllers/common/audit");
const links = require("../../../controllers/catalog/products/download-links");

const intId = (v) => {
	if (!/^\d+$/.test(String(v))) throw Object.assign(new Error("Invalid id"), { status: 400 });
	return parseInt(v, 10);
};

// Публічна адреса — з APP_URL (.env): заголовку Host від клієнта не довіряємо
const baseUrlOf = (req) => {
	const appUrl = String(process.env.APP_URL || "").trim().replace(/\/+$/, "");
	if (/^https?:\/\/[^\s/]+/i.test(appUrl)) return appUrl;
	return `${req.protocol}://${req.get("host")}`;
};

const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status || e.status >= 500) logging.error(e);
		res.status(e.status || 500).json({ ok: false, code: e.code, error: e.status && e.status < 500 ? e.message : req.__("catalog.common.server_error") });
	}
};

// ═══ УГОДА: керування посиланнями ══════════════════════
router.post(
	"/api/deals/:id/download-links/",
	auth.isAuthenticated,
	handle(async (req) => ({ ok: true, ...(await links.listForDeal(intId(req.params.id), req.user.id_lang || 1, baseUrlOf(req))) }))
);

router.post(
	"/api/deals/:id/download-links/create/",
	auth.isAuthenticated,
	handle(async (req) => {
		const idDeal = intId(req.params.id);
		const idItem = intId((req.body || {}).id_item);
		const created = await links.create(idDeal, idItem, req.user.userId);
		audit.log(req, { action: "create", module: "products", entity: "download_link", count: created, details: { deal: idDeal, item: idItem } });
		return { ok: true, created };
	})
);

router.post(
	"/api/deals/:id/download-links/:linkId/regenerate/",
	auth.isAuthenticated,
	handle(async (req) => {
		const idDeal = intId(req.params.id);
		const idLink = intId(req.params.linkId);
		await links.regenerate(idDeal, idLink);
		audit.log(req, { action: "update", module: "products", entity: "download_link", id_entity: idLink, count: 1, details: { deal: idDeal, regenerate: true } });
		return { ok: true };
	})
);

router.post(
	"/api/deals/:id/download-links/:linkId/revoke/",
	auth.isAuthenticated,
	handle(async (req) => {
		const idDeal = intId(req.params.id);
		const idLink = intId(req.params.linkId);
		await links.revoke(idDeal, idLink, req.user.userId);
		audit.log(req, { action: "update", module: "products", entity: "download_link", id_entity: idLink, count: 1, details: { deal: idDeal, revoke: true } });
		return { ok: true };
	})
);

// ═══ ПУБЛІЧНА ВИДАЧА ═══════════════════════════════════
// Простий ліміт частоти на IP (в межах процесу) — захист від перебору токенів
const HITS = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_HITS = 30;
setInterval(() => {
	const now = Date.now();
	for (const [ip, h] of HITS) if (h.reset < now) HITS.delete(ip);
}, WINDOW_MS).unref();

function throttle(req, res, next) {
	const ip = req.ip || "unknown";
	const now = Date.now();
	const h = HITS.get(ip);
	if (!h || h.reset < now) HITS.set(ip, { count: 1, reset: now + WINDOW_MS });
	else if (++h.count > MAX_HITS) {
		res.setHeader("Retry-After", Math.ceil((h.reset - now) / 1000));
		return res.status(429).type("text/plain; charset=utf-8").send(req.__("deals.links.public_too_many"));
	}
	next();
}

const PUBLIC_MESSAGE = {
	not_found: "deals.links.public_not_found",
	revoked: "deals.links.public_revoked",
	expired: "deals.links.public_expired",
	exhausted: "deals.links.public_exhausted",
	inactive: "deals.links.public_inactive",
};

router.get("/dl/:token", throttle, async (req, res) => {
	try {
		await links.serve(req.params.token, req, res);
	} catch (e) {
		if (!e.status || e.status >= 500) logging.error(e);
		if (res.headersSent) return res.destroy();
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Robots-Tag", "noindex, nofollow");
		res.status(e.status && e.status < 500 ? e.status : 500)
			.type("text/plain; charset=utf-8")
			.send(req.__(PUBLIC_MESSAGE[e.code] || "deals.links.public_error"));
	}
});

module.exports = router;