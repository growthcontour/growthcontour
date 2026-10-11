"use strict";

// Запуск обміну з модуля магазину: POST /api/integrations/v1/sync/ { entity }
// Працює у фоні; прогрес, скасування й продовження модуль бачить у себе.
const express = require("express");
const router = express.Router();

const logging = require("../../../logging/logging");
const { verifyOrderToken, logAttempt } = require("../../../controllers/orders/tokenAuth");
const sync = require("../../../controllers/catalog/products/sync");
const reviews = require("../../../controllers/catalog/products/reviews");
const runner = require("../../../controllers/catalog/products/sync-runner");
const syncCategories = require("../../../controllers/catalog/products/sync-categories");
const syncProducts = require("../../../controllers/catalog/products/sync-products");

const ENTITIES = ["products", "categories", "attributes", "reviews"];
const ORDER = ["categories", "attributes", "products", "reviews"]; // категорії раніше за товари

const RUNNERS = {
	categories: async (id) => runner.run(id, "categories", await syncCategories.source()),
	products: (id) => runner.run(id, "products", syncProducts.source()),
	reviews: async (id) => {
		await reviews.pushModeration(id);
		return reviews.pull(id);
	},
};

const running = new Set();

router.post("/api/integrations/v1/sync/", verifyOrderToken("can_read"), async (req, res) => {
	const t = req.orderToken;
	const id = Number(t.id_integration);
	const entity = String((req.body || {}).entity || "");
	const list = entity === "all" ? ENTITIES : ENTITIES.includes(entity) ? [entity] : null;
	if (!list) return res.status(422).json({ ok: false, error: "unknown entity" });

	try {
		await sync.ping(id);
	} catch (e) {
		return res.json({ ok: false, error: `CRM → магазин (інтеграція #${id}): ${e.message}` });
	}

	const result = {};
	const jobs = [];
	for (const e of ORDER.filter((x) => list.includes(x))) {
		if (!RUNNERS[e]) {
			result[e] = { status: "not_supported" };
			continue;
		}
		if (running.has(`${id}:${e}`)) {
			result[e] = { status: "busy" };
			continue;
		}
		running.add(`${id}:${e}`);
		result[e] = { status: "started" };
		jobs.push(e);
	}

	(async () => {
		for (const e of jobs) {
			try {
				await RUNNERS[e](id);
			} catch (err) {
				if (err.code !== "busy") logging.error(err);
			} finally {
				running.delete(`${id}:${e}`);
			}
		}
	})();

	await logAttempt({
		id_token: t.id,
		prefix: req.orderTokenPrefix,
		ip: req.clientIp,
		domain: req.sourceHost,
		endpoint: req.originalUrl,
		result: "success",
		http_status: 202,
		message: `catalog sync: ${entity}`,
	});
	res.json({ ok: true, result });
});

module.exports = router;