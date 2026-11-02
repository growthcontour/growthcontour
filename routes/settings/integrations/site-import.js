"use strict";

// Імпорт товарів із сайту в систему — виклики з модуля магазину (вкладка «Імпорт у систему»).
// Токен інтеграції з правом can_import_products. Усі запити — POST з JSON.
const express = require("express");
const router = express.Router();

const pool = require("../../../config/database/connection_pool");
const P = require("../../../config/config").get("configDatabase").prefix;
const logging = require("../../../logging/logging");
const { verifyOrderToken, logAttempt } = require("../../../controllers/orders/tokenAuth");
const siteImport = require("../../../controllers/catalog/products/site-import");

const auth = verifyOrderToken("can_import_products");

// Від імені того, хто створив токен (історія товарів, «хто додав»)
async function tokenUser(t) {
	const [[row]] = await pool.query(`SELECT id_user FROM ${P}settings_integrations_tokens WHERE id = ?`, [t.id]);
	return row && row.id_user ? Number(row.id_user) : null;
}

function fail(res, e) {
	if (!e.status || e.status >= 500) logging.error(e);
	res.status(e.status && e.status < 500 ? e.status : 500).json({ ok: false, error: e.status && e.status < 500 ? e.message : "Server error", code: e.code || null });
}

const idOf = (req) => parseInt((req.body || {}).id, 10) || 0;

router.post("/api/integrations/v1/import/options/", auth, async (req, res) => {
	try {
		res.json({ ok: true, ...(await siteImport.systemOptions()) });
	} catch (e) {
		fail(res, e);
	}
});

router.post("/api/integrations/v1/import/start/", auth, async (req, res) => {
	const t = req.orderToken;
	try {
		const b = req.body || {};
		const r = await siteImport.start(Number(t.id_integration), { mode: b.mode, options: b.options, resume_id: b.resume_id }, await tokenUser(t), "module");
		await logAttempt({
			id_token: t.id,
			prefix: req.orderTokenPrefix,
			ip: req.clientIp,
			domain: req.sourceHost,
			endpoint: req.originalUrl,
			result: "success",
			http_status: 200,
			message: `site import #${r.id}: ${b.resume_id ? "resume" : b.mode}`,
		});
		res.json({ ok: true, ...r });
	} catch (e) {
		fail(res, e);
	}
});

router.post("/api/integrations/v1/import/status/", auth, async (req, res) => {
	try {
		res.json({ ok: true, ...(await siteImport.status(Number(req.orderToken.id_integration), idOf(req) || null)) });
	} catch (e) {
		fail(res, e);
	}
});

router.post("/api/integrations/v1/import/items/", auth, async (req, res) => {
	try {
		const b = req.body || {};
		res.json({ ok: true, ...(await siteImport.items(Number(req.orderToken.id_integration), idOf(req), { action: b.action, search: b.search, warnings: b.warnings, page: b.page, limit: b.limit })) });
	} catch (e) {
		fail(res, e);
	}
});

router.post("/api/integrations/v1/import/cancel/", auth, async (req, res) => {
	try {
		res.json({ ok: true, ...(await siteImport.cancel(Number(req.orderToken.id_integration), idOf(req))) });
	} catch (e) {
		fail(res, e);
	}
});

router.post("/api/integrations/v1/import/rollback/", auth, async (req, res) => {
	const t = req.orderToken;
	try {
		res.json({ ok: true, ...(await siteImport.rollback(Number(t.id_integration), idOf(req), await tokenUser(t))) });
	} catch (e) {
		fail(res, e);
	}
});

module.exports = router;
