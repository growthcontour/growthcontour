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
	// o.ids — частковий обмін лише цих товарів (автообмін за змінами, повтор помилок, нічна перевірка)
	products: (id, o) => runner.run(id, "products", o && o.ids ? syncProducts.partialSource(id, o.ids) : syncProducts.source(id), o),
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

/* ─── Автообмін за змінами (без ручного запуску й розкладу модуля) ─────────── */

const pool = require("../../../config/database/connection_pool");
const P = require("../../../config/config").get("configDatabase").prefix;
const platforms = require("../../../controllers/settings/integrations/platforms");
const PARTIAL_MAX = 5000;

const verCmp = (a, b) => {
	const x = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
	const y = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
	return 0;
};
/** Модуль сайту вміє частковий обмін (версія з перевірки стану сайту не нижча за мінімальну) */
function supportsPartial(integ) {
	const pl = platforms.get(integ.platform) || {};
	return !!(pl.module_min && integ.health_version && verCmp(integ.health_version, pl.module_min) >= 0);
}

async function autoIntegrations() {
	const catalogIds = new Set((await assortment.catalogIntegrations()).map((i) => i.id));
	const [rows] = await pool.query(
		`SELECT id, platform, health_version, sync_auto_at, sync_auto_movement, sync_full_at, NOW() AS now,
		        (SELECT COALESCE(MAX(id), 0) FROM ${P}products_stock_movements) AS movement
		   FROM ${P}settings_integrations WHERE status = 'active'`
	);
	return rows.filter((r) => catalogIds.has(r.id) && supportsPartial(r));
}

/**
 * Крон щохвилини: для кожного сайту з новим модулем — повний обмін, якщо змінились правила (sync_full_at),
 * інакше частковий: лише товари, змінені з минулого разу (з перекриттям 60 с на транзакції, що закрились пізніше).
 */
async function autoTick() {
	const out = { full: 0, partial: 0 };
	for (const r of await autoIntegrations()) {
		if (running.has(`${r.id}:products`) || running.has(`${r.id}:categories`)) continue;
		const mark = () => pool.query(`UPDATE ${P}settings_integrations SET sync_auto_at = ?, sync_auto_movement = ? WHERE id = ?`, [r.now, r.movement, r.id]);
		if (!r.sync_auto_at) {
			await mark();
			continue;
		}
		if (r.sync_full_at && new Date(r.sync_full_at) <= new Date(new Date(r.now).getTime() - 60000)) {
			await pool.query(`UPDATE ${P}settings_integrations SET sync_full_at = NULL WHERE id = ? AND sync_full_at <= ?`, [r.id, r.sync_full_at]);
			await mark();
			startJobs(r.id, ["categories", "products"], { trigger: "auto" });
			out.full++;
			continue;
		}
		const since = new Date(new Date(r.sync_auto_at).getTime() - 60000);
		const ids = await syncProducts.changedSince(r.id, since, Number(r.sync_auto_movement) || 0, PARTIAL_MAX + 1);
		await mark();
		if (!ids.length) continue;
		startJobs(r.id, ["products"], ids.length > PARTIAL_MAX ? { trigger: "auto" } : { trigger: "auto", ids });
		out.partial++;
	}
	return out;
}

/** Крон щоночі: повний обмін (з прибиранням відсутніх під захистом) і перевірка розбіжностей */
async function nightly() {
	const out = [];
	for (const r of await autoIntegrations()) {
		try {
			const rec = await syncProducts.reconcile(r.id);
			if (rec && rec.fix.length && !running.has(`${r.id}:products`)) startJobs(r.id, ["products"], { trigger: "reconcile", ids: rec.fix });
			await pool.query(`UPDATE ${P}settings_integrations SET sync_full_at = COALESCE(sync_full_at, NOW()) WHERE id = ?`, [r.id]);
			out.push({ id: r.id, ...(rec || {}), fix: rec ? rec.fix.length : 0 });
		} catch (e) {
			logging.error(e);
		}
	}
	return out;
}

/** Крон: повтор товарів, які сайт не прийняв (наростаюча пауза — у черзі помилок) */
async function retryTick() {
	const ids = await assortment.dueRetries();
	const partial = new Set((await autoIntegrations()).map((r) => r.id));
	for (const id of ids) {
		// Новий модуль — лише відхилені товари; старий — повний обмін (модуль пропускає незмінене за відбитком)
		if (partial.has(id)) {
			const items = await assortment.retryItems(id);
			if (items.length) startJobs(id, ["products"], { trigger: "retry", ids: items });
		} else startJobs(id, ["products"], { trigger: "retry" });
	}
	return ids.length;
}

// Курси валют від модуля (НБУ, банк, власний сервіс): { rates: [{ code, rate }], source }
// rate — скільки базової валюти системи за 1 одиницю валюти. Далі — як ручна зміна: журнал, поріг, перерахунок цін
router.post("/api/integrations/v1/currency/rates/", verifyOrderToken("can_set_rates"), async (req, res) => {
	const b = req.body || {};
	const source = /^[a-z0-9_]{1,32}$/.test(String(b.source || "")) ? String(b.source) : "api";
	try {
		const r = await require("../../../controllers/catalog/products/pricing").setRates(Array.isArray(b.rates) ? b.rates : [], { source });
		await logAttempt({
			id_token: req.orderToken.id,
			prefix: req.orderTokenPrefix,
			ip: req.clientIp,
			domain: req.sourceHost,
			endpoint: req.originalUrl,
			result: "success",
			http_status: 200,
			message: `currency rates: ${r.changed.join(", ") || "no changes"}`,
		});
		res.json({ ok: true, changed: r.changed, held: r.held || [], recalculated: r.recalculated, pending: r.pending });
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "server error" });
	}
});

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
module.exports.autoTick = autoTick;
module.exports.nightly = nightly;
