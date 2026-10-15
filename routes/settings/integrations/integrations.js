"use strict";
// =========================================================================
//  НАЛАШТУВАННЯ → ІНТЕГРАЦІЇ
//  Сторінка + CRUD. Поля й можливості — з реєстру платформ.
//  Права: orders.settings (edit). Список доступний усім залогіненим —
//  його читають інші сторінки (токени, кошики, відгуки).
// =========================================================================
const express = require("express");
const router = express.Router();

const auth = require("../../../controllers/authorization/authorization");
const connection_pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const logging = require("../../../logging/logging");
const platforms = require("../../../controllers/settings/integrations/platforms");
const assortment = require("../../../controllers/settings/integrations/assortment");
const REQUIRED_CODES = require("../../../controllers/catalog/products/quality").RULES.map((r) => r.code);

const p = config.get("configDatabase").prefix;

const SLUG = "orders.settings";
const can = (req, action) => auth.hasPermission(req, SLUG, action);
const need = (action) => (req, res, next) => (can(req, action) ? next() : res.status(403).json({ message: "Недостатньо прав." }));

// ─── Утиліти ──────────────────────────────────────────────────────────────
const formatDate = (date) => {
	if (!date) return null;
	const d = new Date(date);
	const pad = (n) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
};

const cleanColor = (val, fallback) => {
	const s = String(val || "").trim();
	return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : fallback;
};

const cleanUrl = (val, max = 512) => {
	const s = String(val || "")
		.trim()
		.replace(/\/+$/, "");
	if (!s || s.length > max) return null;
	try {
		const u = new URL(s);
		return ["http:", "https:"].includes(u.protocol) ? s : null;
	} catch {
		return null;
	}
};

// Дані, що посилаються на інтеграцію: видалення блокується.
// Токени не блокують — видаляються каскадно (FK ON DELETE CASCADE).
const DEPENDENTS = [
	["orders", "замовлення"],
	["orders_abandoned_cart", "покинуті кошики"],
	["orders_abandoned_cart_events", "події розсилок"],
	["products_external_links", "зв'язки товарів"],
	["products_reviews", "відгуки"],
];

/** Валідація тіла за реєстром платформ */
async function readBody(b) {
	const key = String(b.platform || "");
	const pl = platforms.get(key);
	if (!pl) return { error: "Оберіть платформу." };

	const name = String(b.name || "")
		.trim()
		.slice(0, 255);
	if (!name) return { error: "Вкажіть назву інтеграції." };

	const f = pl.fields;

	let platform_version = null;
	if (pl.versions) {
		platform_version = pl.versions.includes(String(b.platform_version)) ? String(b.platform_version) : null;
		if (!platform_version) return { error: "Оберіть версію платформи." };
	}

	const base_url = f.base_url ? cleanUrl(b.base_url, 255) : null;
	if (f.base_url === "required" && !base_url) return { error: "Вкажіть коректну адресу сайту (https://…)." };

	const callback_url = f.callback_url ? cleanUrl(b.callback_url) : null;
	if (f.callback_url === "required" && !callback_url) return { error: "Вкажіть API endpoint модуля." };

	let outbound_token = null;
	if (f.outbound_token) {
		const t = String(b.outbound_token || "").trim();
		if (t && !/^[A-Za-z0-9_-]{32,255}$/.test(t)) return { error: "Ключ доступу: 32–255 символів (латиниця, цифри, _ -)." };
		outbound_token = t || null;
		if (f.outbound_token === "required" && !outbound_token) return { error: "Згенеруйте ключ доступу." };
	}

	let default_status_id = null;
	if (f.default_status) {
		const id = parseInt(b.default_status_id, 10);
		if (id) {
			const [[st]] = await connection_pool.query(`SELECT id FROM \`${p}orders_status\` WHERE id = ? LIMIT 1`, [id]);
			if (!st) return { error: "Обраний статус не існує." };
			default_status_id = id;
		}
		if (f.default_status === "required" && !default_status_id) return { error: "Оберіть стартовий статус замовлення." };
	}

	// Вихідна синхронізація можлива лише за наявності endpoint
	const outOk = pl.caps.includes("orders") && !!callback_url;

	return {
		data: {
			name,
			platform: key,
			platform_version,
			base_url,
			callback_url,
			outbound_token,
			default_status_id,
			sync_orders_out: outOk && b.sync_orders_out ? 1 : 0,
			sync_status_out: outOk && b.sync_status_out ? 1 : 0,
			color_text: cleanColor(b.color_text, "#ffffff"),
			color_background: cleanColor(b.color_background, "#607d8b"),
			status: b.status === "disabled" ? "disabled" : "active",
			assortment_mode: pl.caps.includes("catalog") && b.assortment_mode === "selected" ? "selected" : "all",
			price_rule: pl.caps.includes("catalog") ? JSON.stringify(assortment.normRule(b.price_rule)) : null,
			stock_rule: pl.caps.includes("catalog") ? JSON.stringify(assortment.normStock(b.stock_rule)) : null,
			content_rule: pl.caps.includes("catalog") ? JSON.stringify(assortment.normContent(b.content_rule)) : null,
			// Куди слати листи про проблеми сайту (не відповідає, ключ, версія модуля, відхилені товари)
			alert_emails:
				String(b.alert_emails || "")
					.split(/[,;\s]+/)
					.map((s) => s.trim())
					.filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))
					.slice(0, 10)
					.join(", ") || null,
			// Що обов'язково для публікації на цей сайт — коди правил оцінки якості
			required_fields: pl.caps.includes("catalog") && Array.isArray(b.required_fields) ? JSON.stringify([...new Set(b.required_fields.filter((c) => REQUIRED_CODES.includes(c)))]) : null,
			note:
				String(b.note || "")
					.trim()
					.slice(0, 999) || null,
		},
	};
}

// ─── GET — сторінка ───────────────────────────────────────────────────────
router.get("/settings/integrations/", auth.isAuthenticated, async (req, res) => {
	if (!can(req, "edit")) {
		return res.status(403).render("pages/error/404", { message: "Недостатньо прав.", error: { status: 403 } });
	}
	// Продавані склади — для вибору «склади сайту»
	const [warehouses] = await connection_pool.query(`SELECT id, code, name FROM \`${p}products_warehouses\` WHERE deleted_at IS NULL AND status = 1 AND is_sellable = 1 ORDER BY sort_order, id`).catch(() => [[]]);
	// Бренди й категорії (основною мовою) — для умовних правил цін
	const [[lang]] = await connection_pool.query(`SELECT id FROM \`${p}products_languages\` WHERE status = 1 ORDER BY is_primary DESC, sort_order, id LIMIT 1`).catch(() => [[null]]);
	const idLang = lang ? lang.id : 1;
	const [priceBrands] = await connection_pool.query(`SELECT b.id, COALESCE(NULLIF(d.name, ''), CONCAT('#', b.id)) AS name FROM \`${p}products_brands\` b LEFT JOIN \`${p}products_brands_description\` d ON d.id_brand = b.id AND d.id_lang = ? WHERE b.deleted_at IS NULL ORDER BY name LIMIT 2000`, [idLang]).catch(() => [[]]);
	const [priceCategories] = await connection_pool
		.query(
			`SELECT c.id, GROUP_CONCAT(COALESCE(NULLIF(d.name, ''), CONCAT('#', pp.id_ancestor)) ORDER BY pp.depth DESC SEPARATOR ' › ') AS name
			   FROM \`${p}products_categories\` c
			   JOIN \`${p}products_categories_path\` pp ON pp.id_category = c.id
			   LEFT JOIN \`${p}products_categories_description\` d ON d.id_category = pp.id_ancestor AND d.id_lang = ?
			  GROUP BY c.id ORDER BY name LIMIT 3000`,
			[idLang]
		)
		.catch(() => [[]]);
	res.render("pages/settings/integrations/index", {
		requiredCodes: REQUIRED_CODES,
		priceBrands,
		priceCategories,
		contentLanguages: await connection_pool
			.query(`SELECT code, LOWER(code) AS iso FROM \`${p}products_languages\` WHERE status = 1 ORDER BY is_primary DESC, sort_order, id`)
			.then(([r]) => r)
			.catch(() => []),
		warehouses,
		i18n: req,
		user: req.user,
		header: { navbar: "settings", subnavbar: "integrations" },
		platforms: platforms.publicList(),
	});
});

// ─── POST — список (outbound_token не віддаємо) ───────────────────────────
router.post("/api/settings/integrations/list/", auth.isAuthenticated, async (req, res) => {
	try {
		const [rows] = await connection_pool.query(
			`SELECT i.id, i.name, i.platform, i.platform_version, i.base_url, i.callback_url,
			        i.outbound_token IS NOT NULL AS has_outbound_token,
			        i.sync_orders_out, i.sync_status_out, i.color_text, i.color_background,
			        i.status, i.note, i.date_add, i.date_edit, i.health_state, i.health_message, i.health_version, i.health_at,
			        (SELECT COUNT(*) FROM \`${p}settings_integrations_tokens\` t
			          WHERE t.id_integration = i.id AND t.revoked_at IS NULL) AS tokens_count
			   FROM \`${p}settings_integrations\` i
			  ORDER BY i.id DESC`
		);
		return res.status(200).json(
			rows.map((r) => ({
				...r,
				has_outbound_token: !!Number(r.has_outbound_token),
				date_add: formatDate(r.date_add),
				date_edit: formatDate(r.date_edit),
				health_at: r.health_at ? formatDate(r.health_at) : null,
			}))
		);
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});

// ─── POST — деталі (для форми) ────────────────────────────────────────────
router.post("/api/settings/integrations/get/", auth.isAuthenticated, need("edit"), async (req, res) => {
	const id = parseInt(req.body.id, 10);
	if (!id) return res.status(400).json({ message: "Невірний ID." });
	try {
		const [[i]] = await connection_pool.query(
			`SELECT id, name, platform, platform_version, default_status_id, base_url, callback_url, outbound_token,
			        sync_orders_out, sync_status_out, color_text, color_background, status, assortment_mode, price_rule, stock_rule, content_rule, required_fields, alert_emails, note
			   FROM \`${p}settings_integrations\` WHERE id = ? LIMIT 1`,
			[id]
		);
		if (!i) return res.status(404).json({ message: "Інтеграцію не знайдено." });
		i.price_rule = assortment.normRule(i.price_rule);
		i.stock_rule = assortment.normStock(i.stock_rule);
		i.content_rule = assortment.normContent(i.content_rule);
		try {
			i.required_fields = i.required_fields ? (typeof i.required_fields === "string" ? JSON.parse(i.required_fields) : i.required_fields) : [];
		} catch (e) {
			i.required_fields = [];
		}
		return res.status(200).json(i);
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});

// ─── POST — додавання ─────────────────────────────────────────────────────
router.post("/api/settings/integrations/add/", auth.isAuthenticated, need("edit"), async (req, res) => {
	try {
		const r = await readBody(req.body || {});
		if (r.error) return res.status(400).json({ message: r.error });
		const d = r.data;
		const [ins] = await connection_pool.query(
			`INSERT INTO \`${p}settings_integrations\`
			   (name, platform, platform_version, default_status_id, base_url, callback_url, outbound_token,
			    sync_orders_out, sync_status_out, color_text, color_background, status, assortment_mode, price_rule, stock_rule, content_rule, required_fields, alert_emails, note, date_add, date_edit)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
			[d.name, d.platform, d.platform_version, d.default_status_id, d.base_url, d.callback_url, d.outbound_token, d.sync_orders_out, d.sync_status_out, d.color_text, d.color_background, d.status, d.assortment_mode, d.price_rule, d.stock_rule, d.content_rule, d.required_fields, d.alert_emails, d.note]
		);
		return res.status(200).json({ status: "success", id: ins.insertId });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});

// ─── POST — оновлення ─────────────────────────────────────────────────────
router.post("/api/settings/integrations/update/", auth.isAuthenticated, need("edit"), async (req, res) => {
	const id = parseInt((req.body || {}).id, 10);
	if (!id) return res.status(400).json({ message: "Невірний ID." });
	try {
		const [[cur]] = await connection_pool.query(`SELECT id FROM \`${p}settings_integrations\` WHERE id = ? LIMIT 1`, [id]);
		if (!cur) return res.status(404).json({ message: "Інтеграцію не знайдено." });

		const r = await readBody(req.body || {});
		if (r.error) return res.status(400).json({ message: r.error });
		const d = r.data;

		await connection_pool.query(
			`UPDATE \`${p}settings_integrations\`
			    SET name = ?, platform = ?, platform_version = ?, default_status_id = ?, base_url = ?, callback_url = ?,
			        outbound_token = ?, sync_orders_out = ?, sync_status_out = ?, color_text = ?, color_background = ?,
			        status = ?, assortment_mode = ?, price_rule = ?, stock_rule = ?, content_rule = ?, required_fields = ?, alert_emails = ?, note = ?, date_edit = NOW()
			  WHERE id = ?`,
			[d.name, d.platform, d.platform_version, d.default_status_id, d.base_url, d.callback_url, d.outbound_token, d.sync_orders_out, d.sync_status_out, d.color_text, d.color_background, d.status, d.assortment_mode, d.price_rule, d.stock_rule, d.content_rule, d.required_fields, d.alert_emails, d.note, id]
		);
		return res.status(200).json({ status: "success" });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});

// ─── POST — видалення ─────────────────────────────────────────────────────
router.post("/api/settings/integrations/delete/", auth.isAuthenticated, need("edit"), async (req, res) => {
	const id = parseInt((req.body || {}).id, 10);
	if (!id) return res.status(400).json({ message: "Невірний ID." });

	const conn = await connection_pool.getConnection();
	try {
		const [[cur]] = await conn.query(`SELECT id FROM \`${p}settings_integrations\` WHERE id = ? LIMIT 1`, [id]);
		if (!cur) return res.status(404).json({ message: "Інтеграцію не знайдено." });

		const blocked = [];
		for (const [table, label] of DEPENDENTS) {
			const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${p}${table}\` WHERE id_integration = ?`, [id]);
			if (Number(n) > 0) blocked.push(`${label} (${n})`);
		}
		if (blocked.length) {
			return res.status(409).json({
				status: "blocked",
				message: `Видалення заблоковано: на інтеграцію посилаються ${blocked.join(", ")}. Вимкніть її замість видалення.`,
			});
		}

		await conn.beginTransaction();
		await conn.query(`DELETE FROM \`${p}orders_status_map\` WHERE id_integration = ?`, [id]);
		await conn.query(`DELETE FROM \`${p}products_sync_settings\` WHERE id_integration = ?`, [id]);
		await conn.query(`DELETE FROM \`${p}products_sync_log\` WHERE id_integration = ?`, [id]);
		await conn.query(`DELETE FROM \`${p}products_reviews_sync\` WHERE id_integration = ?`, [id]);
		await conn.query(`DELETE FROM \`${p}settings_integrations\` WHERE id = ?`, [id]); // токени — каскадом
		await conn.commit();

		return res.status(200).json({ status: "success", message: "Інтеграцію видалено." });
	} catch (error) {
		await conn.rollback().catch(() => {});
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	} finally {
		conn.release();
	}
});

// ─── АСОРТИМЕНТ: що з каталогу йде на кожен сайт ─────────────────────────
// Права беруться з розділу, звідки редагують: товар — products.list, категорія — products.categories
const ASSORT_SLUG = { product: "products.list", category: "products.categories" };

router.post("/api/settings/integrations/assortment/get/", auth.isAuthenticated, async (req, res) => {
	const b = req.body || {};
	const slug = ASSORT_SLUG[b.entity];
	const id = parseInt(b.id, 10);
	if (!slug || !id) return res.status(400).json({ ok: false, message: "Невірні параметри." });
	if (!auth.hasPermission(req, slug, "view")) return res.status(403).json({ ok: false, message: "Недостатньо прав." });
	try {
		return res.json({ ok: true, rows: await assortment.forEntity(b.entity, id) });
	} catch (error) {
		if (!error.status) logging.error(error);
		return res.status(error.status || 500).json({ ok: false, message: error.status ? error.message : "Помилка сервера." });
	}
});

router.post("/api/settings/integrations/assortment/integrations/", auth.isAuthenticated, async (req, res) => {
	if (!auth.hasPermission(req, ASSORT_SLUG.product, "view")) return res.status(403).json({ ok: false, message: "Недостатньо прав." });
	try {
		const rows = await assortment.catalogIntegrations();
		return res.json({ ok: true, rows: rows.map((r) => ({ id: r.id, name: r.name, active: r.status === "active", assortment_mode: r.assortment_mode })) });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ ok: false, message: "Помилка сервера." });
	}
});

router.post("/api/settings/integrations/assortment/counts/", auth.isAuthenticated, async (req, res) => {
	if (!auth.hasPermission(req, ASSORT_SLUG.product, "view") && !can(req, "edit")) return res.status(403).json({ ok: false, message: "Недостатньо прав." });
	try {
		// Останній обмін каталогу по кожному сайту — для колонки «Синхронізація»
		const [last] = await connection_pool.query(
			`SELECT g.id_integration, g.action, g.date_add, g.errors, g.message
			   FROM \`${p}products_sync_log\` g
			   JOIN (SELECT id_integration, MAX(id) AS id FROM \`${p}products_sync_log\` GROUP BY id_integration) m ON m.id = g.id`
		);
		const sync = Object.fromEntries(last.map((r) => [r.id_integration, { action: r.action, at: r.date_add, errors: Number(r.errors) || 0, message: r.message }]));
		return res.json({ ok: true, ...(await assortment.counts()), sync });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ ok: false, message: "Помилка сервера." });
	}
});

// Стан сайту: перевірити зараз
router.post("/api/settings/integrations/health/check/", auth.isAuthenticated, need("edit"), async (req, res) => {
	const id = parseInt((req.body || {}).id, 10);
	if (!id) return res.status(400).json({ ok: false, message: "Невірний ID." });
	try {
		const [[integ]] = await connection_pool.query(`SELECT id, name, platform, alert_emails FROM \`${p}settings_integrations\` WHERE id = ?`, [id]);
		if (!integ) return res.status(404).json({ ok: false, message: "Інтеграцію не знайдено." });
		const r = await require("../../../controllers/catalog/products/alerts").checkSite(integ);
		return res.json({ ok: true, state: r.problem || "ok", message: r.message, version: r.version });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ ok: false, message: "Помилка сервера." });
	}
});

// Черга помилок: товари, які сайт не прийняв
router.post("/api/settings/integrations/assortment/errors/", auth.isAuthenticated, async (req, res) => {
	const idIntegration = parseInt((req.body || {}).id_integration, 10);
	if (!idIntegration) return res.status(400).json({ ok: false, message: "Невірні параметри." });
	if (!auth.hasPermission(req, ASSORT_SLUG.product, "view") && !can(req, "edit")) return res.status(403).json({ ok: false, message: "Недостатньо прав." });
	try {
		return res.json({ ok: true, rows: await assortment.errorsList(idIntegration, req.user.id_lang), max: assortment.MAX_ATTEMPTS });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ ok: false, message: "Помилка сервера." });
	}
});

// «Спробувати знову»: ids — вибрані товари, порожньо — усі; обмін стартує одразу
router.post("/api/settings/integrations/assortment/retry/", auth.isAuthenticated, async (req, res) => {
	const b = req.body || {};
	const idIntegration = parseInt(b.id_integration, 10);
	if (!idIntegration) return res.status(400).json({ ok: false, message: "Невірні параметри." });
	if (!auth.hasPermission(req, ASSORT_SLUG.product, "edit") && !can(req, "edit")) return res.status(403).json({ ok: false, message: "Недостатньо прав." });
	try {
		const n = await assortment.retryNow(idIntegration, Array.isArray(b.ids) ? b.ids : []);
		const result = require("./sync-trigger").startJobs(idIntegration, ["products"], { trigger: "retry", idUser: req.user.userId || req.user.id });
		return res.json({ ok: true, queued: n, status: result.products ? result.products.status : "not_supported" });
	} catch (error) {
		if (!error.status) logging.error(error);
		return res.status(error.status || 500).json({ ok: false, message: error.status ? error.message : "Помилка сервера." });
	}
});

// Значення товару для сайту: ціна, назва мовами
router.post("/api/settings/integrations/assortment/overrides/", auth.isAuthenticated, async (req, res) => {
	const b = req.body || {};
	const idIntegration = parseInt(b.id_integration, 10);
	const id = parseInt(b.id, 10);
	if (!idIntegration || !id) return res.status(400).json({ ok: false, message: "Невірні параметри." });
	if (!auth.hasPermission(req, ASSORT_SLUG.product, "edit")) return res.status(403).json({ ok: false, message: "Недостатньо прав." });
	try {
		const overrides = await assortment.setOverrides(idIntegration, id, b.overrides, req.user.userId || req.user.id);
		return res.json({ ok: true, overrides });
	} catch (error) {
		if (!error.status) logging.error(error);
		return res.status(error.status || 500).json({ ok: false, message: error.status ? error.message : "Помилка сервера." });
	}
});

router.post("/api/settings/integrations/assortment/set/", auth.isAuthenticated, async (req, res) => {
	const b = req.body || {};
	const slug = ASSORT_SLUG[b.entity];
	const idIntegration = parseInt(b.id_integration, 10);
	if (!slug || !idIntegration) return res.status(400).json({ ok: false, message: "Невірні параметри." });
	if (!auth.hasPermission(req, slug, "edit")) return res.status(403).json({ ok: false, message: "Недостатньо прав." });
	try {
		const mode = b.mode === "include" || b.mode === "exclude" ? b.mode : null;
		const r = await assortment.set(b.entity, Array.isArray(b.ids) ? b.ids : [b.id], idIntegration, mode, req.user.userId || req.user.id);
		return res.json({ ok: true, ...r });
	} catch (error) {
		if (!error.status) logging.error(error);
		return res.status(error.status || 500).json({ ok: false, message: error.status ? error.message : "Помилка сервера." });
	}
});

module.exports = router;
