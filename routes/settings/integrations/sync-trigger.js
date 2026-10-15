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
const syncAttributes = require("../../../controllers/catalog/products/sync-attributes");
const syncReviewsOut = require("../../../controllers/catalog/products/sync-reviews-out");
const syncCustomers = require("../../../controllers/catalog/products/sync-customers");
const assortment = require("../../../controllers/settings/integrations/assortment");

const ENTITIES = ["products", "categories", "attributes", "reviews", "customers"];
// Довідники раніше за товари; відгуки — після товарів (посилаються на них)
const ORDER = ["categories", "attributes", "products", "reviews", "customers"];

const RUNNERS = {
	categories: async (id, o) => runner.run(id, "categories", await syncCategories.source(id), o),
	products: (id, o) => runner.run(id, "products", syncProducts.source(id), o),
	attributes: (id, o) => runner.run(id, "attributes", syncAttributes.source(), o),
	// Спершу модерація і нові відгуки з сайту → CRM, потім усі відгуки CRM → сайт
	reviews: async (id, o) => {
		await reviews.pushModeration(id).catch(() => {});
		await reviews.pull(id).catch(() => {});
		return runner.run(id, "reviews", syncReviewsOut.source(id), o);
	},
	customers: (id, o) => runner.run(id, "customers", syncCustomers.source(id), o),
};

const running = new Set();

/**
 * Запустити обмін у фоні (з модуля, повтор помилок, вручну з системи).
 * Повертає { [entity]: { status: started | busy | not_supported } }.
 */
function startJobs(id, list, opts = {}) {
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
				await RUNNERS[e](id, opts);
			} catch (err) {
				if (err.code !== "busy") logging.error(err);
			} finally {
				running.delete(`${id}:${e}`);
			}
		}
	})();
	return result;
}

/** Крон: повтор товарів, які сайт не прийняв (наростаюча пауза — у черзі помилок) */
async function retryTick() {
	const ids = await assortment.dueRetries();
	for (const id of ids) startJobs(id, ["products"], { trigger: "retry" });
	return ids.length;
}
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

	const result = startJobs(id, list, { trigger: "module" });

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
module.exports.startJobs = startJobs;
module.exports.retryTick = retryTick;
