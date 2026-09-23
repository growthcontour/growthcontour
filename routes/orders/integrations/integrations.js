// =========================================================================
//  КЕРУВАННЯ ІНТЕГРАЦІЯМИ (адмінка, під isAuthenticated)
//  Сторінка + CRUD інтеграцій (магазинів/каналів).
//  Одна сутність-джерело на всю систему; токени посилаються на неї (id_integration).
//  Видалення — м'яке (status='disabled'), бо на інтеграцію посилаються замовлення й токени.
// =========================================================================
const express = require("express");
const router = express.Router();

// Controllers
const authorizationControllers = require("../../../controllers/authorization/authorization");
// END Controllers

// Database
const connection_pool = require("../../../config/database/connection_pool");
// END Database

// Configuration
const config = require("../../../config/config");
const configDatabase = config.get("configDatabase");
// END Configuration

// Logging
const logging = require("../../../logging/logging");
// END Logging

const p = configDatabase.prefix;

// ─────────────────────────────────────────────────────────────────────────
// Утиліти
// ─────────────────────────────────────────────────────────────────────────
const formatDate = (date) => {
	if (!date) return null;
	const d = new Date(date);
	const day = String(d.getDate()).padStart(2, "0");
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const year = d.getFullYear();
	const hours = String(d.getHours()).padStart(2, "0");
	const minutes = String(d.getMinutes()).padStart(2, "0");
	return `${hours}:${minutes} ${day}.${month}.${year}`;
};

// Нормалізація hex-кольору (#rgb / #rrggbb). Порожнє → null.
const cleanColor = (val, fallback = null) => {
	const s = String(val || "").trim();
	return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : fallback;
};

// Нормалізація URL: має починатись з http(s):// або бути порожнім
const cleanUrl = (val) => {
	const s = String(val || "").trim();
	if (!s) return null;
	return /^https?:\/\//i.test(s) ? s.slice(0, 512) : null;
};

const PLATFORMS = ["opencart", "woocommerce", "prestashop", "shopify", "amazon", "rozetka", "prom", "custom"];

// Перевірка/резолв стартового статусу.
//   Для custom — обовʼязковий і має існувати в orders_status.
//   Для решти — завжди null (статус визначається зв'язкою orders_status_map).
const resolveDefaultStatus = async (platform, rawVal) => {
	if (platform !== "custom") return { ok: true, value: null };
	const id = parseInt(rawVal, 10);
	if (!id) return { ok: false, message: "Для custom-інтеграції оберіть стартовий статус замовлення." };
	const [[st]] = await connection_pool.query(`SELECT id FROM \`${p}orders_status\` WHERE id = ? LIMIT 1`, [id]);
	if (!st) return { ok: false, message: "Обраний статус не існує." };
	return { ok: true, value: id };
};

// ─────────────────────────────────────────────────────────────────────────
// GET — сторінка інтеграцій
// ─────────────────────────────────────────────────────────────────────────
router.get("/orders/integrations/", authorizationControllers.isAuthenticated, (req, res) => {
	res.render("pages/orders/integrations/integrations", {
		i18n: req,
		user: req.user,
		header: { navbar: "orders" },
	});
});
// END GET

// ─────────────────────────────────────────────────────────────────────────
// POST — Список інтеграцій (для таблиці + для селекта у формі токена).
//   outbound_token не віддаємо повністю — лише ознаку наявності.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/integrations/list/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const [rows] = await connection_pool.query(
			`SELECT i.id, i.name, i.platform, i.default_status_id, i.base_url, i.callback_url,
              i.outbound_token, i.sync_orders_out, i.sync_status_out,
              i.color_text, i.color_background, i.status, i.note,
              i.date_add, i.date_edit,
              (SELECT COUNT(*) FROM \`${p}orders_tokens\` t
                 WHERE t.id_integration = i.id AND t.revoked_at IS NULL) AS tokens_count
       FROM \`${p}orders_integrations\` i
       ORDER BY i.id DESC`
		);

		const result = rows.map((r) => ({
			id: r.id,
			name: r.name,
			platform: r.platform,
			base_url: r.base_url,
			callback_url: r.callback_url,
			has_outbound_token: !!r.outbound_token,
			sync_orders_out: r.sync_orders_out,
			sync_status_out: r.sync_status_out,
			color_text: r.color_text,
			color_background: r.color_background,
			status: r.status,
			note: r.note,
			tokens_count: r.tokens_count,
			date_add: formatDate(r.date_add),
			date_edit: formatDate(r.date_edit),
		}));

		return res.status(200).json(result);
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});
// END Список інтеграцій

// ─────────────────────────────────────────────────────────────────────────
// POST — Деталі інтеграції (для модалки редагування).
//   outbound_token віддаємо повністю — він потрібен адмінові для звірки.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/integrations/get/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.body.id, 10);
	if (!id) return res.status(400).json({ message: "Невірний ID." });

	try {
		const [[i]] = await connection_pool.query(
			`SELECT id, name, platform, default_status_id, base_url, callback_url, outbound_token,
              sync_orders_out, sync_status_out, color_text, color_background,
              status, note
       FROM \`${p}orders_integrations\` WHERE id = ? LIMIT 1`,
			[id]
		);
		if (!i) return res.status(404).json({ message: "Інтеграцію не знайдено." });

		return res.status(200).json(i);
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});
// END Деталі інтеграції

// ─────────────────────────────────────────────────────────────────────────
// POST — Додавання інтеграції.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/integrations/add/", authorizationControllers.isAuthenticated, async (req, res) => {
	const b = req.body || {};
	const name = (b.name || "").toString().trim();
	if (!name) return res.status(400).json({ message: "Вкажіть назву інтеграції." });

	const platform = PLATFORMS.includes(b.platform) ? b.platform : null;

	const ds = await resolveDefaultStatus(platform, b.default_status_id);
	if (!ds.ok) return res.status(400).json({ message: ds.message });
	const default_status_id = ds.value;

	const base_url = cleanUrl(b.base_url);
	const callback_url = cleanUrl(b.callback_url);
	const outbound_token = (b.outbound_token || "").toString().trim().slice(0, 255) || null;
	const sync_orders_out = b.sync_orders_out ? 1 : 0;
	const sync_status_out = b.sync_status_out ? 1 : 0;
	const color_text = cleanColor(b.color_text, "#ffffff");
	const color_background = cleanColor(b.color_background, "#607d8b");
	const status = b.status === "disabled" ? "disabled" : "active";
	const note = (b.note || "").toString().slice(0, 999) || null;

	try {
		const [ins] = await connection_pool.query(
			`INSERT INTO \`${p}orders_integrations\`
        (name, platform, default_status_id, base_url, callback_url, outbound_token,
         sync_orders_out, sync_status_out, color_text, color_background,
         status, note, date_add, date_edit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
			[name, platform, default_status_id, base_url, callback_url, outbound_token, sync_orders_out, sync_status_out, color_text, color_background, status, note]
		);

		return res.status(200).json({ status: "success", id: ins.insertId });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});
// END Додавання інтеграції

// ─────────────────────────────────────────────────────────────────────────
// POST — Оновлення інтеграції.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/integrations/update/", authorizationControllers.isAuthenticated, async (req, res) => {
	const b = req.body || {};
	const id = parseInt(b.id, 10);
	if (!id) return res.status(400).json({ message: "Невірний ID." });

	const name = (b.name || "").toString().trim();
	if (!name) return res.status(400).json({ message: "Вкажіть назву інтеграції." });

	const platform = PLATFORMS.includes(b.platform) ? b.platform : null;

	const ds = await resolveDefaultStatus(platform, b.default_status_id);
	if (!ds.ok) return res.status(400).json({ message: ds.message });
	const default_status_id = ds.value;

	const base_url = cleanUrl(b.base_url);
	const callback_url = cleanUrl(b.callback_url);
	const outbound_token = (b.outbound_token || "").toString().trim().slice(0, 255) || null;
	const sync_orders_out = b.sync_orders_out ? 1 : 0;
	const sync_status_out = b.sync_status_out ? 1 : 0;
	const color_text = cleanColor(b.color_text, "#ffffff");
	const color_background = cleanColor(b.color_background, "#607d8b");
	const status = b.status === "disabled" ? "disabled" : "active";
	const note = (b.note || "").toString().slice(0, 999) || null;

	try {
		const [[cur]] = await connection_pool.query(`SELECT id FROM \`${p}orders_integrations\` WHERE id = ? LIMIT 1`, [id]);
		if (!cur) return res.status(404).json({ message: "Інтеграцію не знайдено." });

		await connection_pool.query(
			`UPDATE \`${p}orders_integrations\`
       SET name = ?, platform = ?, default_status_id = ?, base_url = ?, callback_url = ?, outbound_token = ?,
           sync_orders_out = ?, sync_status_out = ?, color_text = ?, color_background = ?,
           status = ?, note = ?, date_edit = NOW()
       WHERE id = ?`,
			[name, platform, default_status_id, base_url, callback_url, outbound_token, sync_orders_out, sync_status_out, color_text, color_background, status, note, id]
		);

		return res.status(200).json({ status: "success" });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});
// END Оновлення інтеграції

// ─────────────────────────────────────────────────────────────────────────
// POST — Видалення інтеграції.
//   Фізичний DELETE, якщо немає залежностей (токени/замовлення).
//   Якщо є — блокуємо (409) і повертаємо лічильники, щоб користувач
//   спершу відв'язав. Так уникаємо осиротілих джойнів.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/integrations/delete/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.body.id, 10);
	if (!id) return res.status(400).json({ message: "Невірний ID." });

	try {
		const [[cur]] = await connection_pool.query(`SELECT id FROM \`${p}orders_integrations\` WHERE id = ? LIMIT 1`, [id]);
		if (!cur) return res.status(404).json({ message: "Інтеграцію не знайдено." });

		// Залежності
		const [[{ tokens_count }]] = await connection_pool.query(`SELECT COUNT(*) AS tokens_count FROM \`${p}orders_tokens\` WHERE id_integration = ?`, [id]);
		const [[{ orders_count }]] = await connection_pool.query(`SELECT COUNT(*) AS orders_count FROM \`${p}orders\` WHERE id_integration = ?`, [id]);

		if (tokens_count > 0 || orders_count > 0) {
			return res.status(409).json({
				status: "blocked",
				tokens_count,
				orders_count,
				message: `Видалення заблоковано: на інтеграцію посилаються токени (${tokens_count}) або замовлення (${orders_count}). Спершу відв'яжіть їх.`,
			});
		}

		await connection_pool.query(`DELETE FROM \`${p}orders_integrations\` WHERE id = ?`, [id]);

		return res.status(200).json({ status: "success", message: "Інтеграцію видалено." });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});
// END Видалення інтеграції

module.exports = router;
