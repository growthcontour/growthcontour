const express = require("express");
const crypto = require("crypto");
const { parsePhoneNumberFromString } = require("libphonenumber-js");
const router = express.Router();

// Controllers
const authorizationControllers = require("../../controllers/authorization/authorization");
const rebuildStats = require("../../cron/analytics/rebuildStats");
const { verifyOrderToken, logAttempt } = require("../../controllers/orders/tokenAuth");
const { kickWorker, orderReference } = require("../../controllers/orders/inboxProcessor");
const ordersAccess = require("../../controllers/orders/access");
const ordersNotify = require("../../controllers/orders/notify");
const { kickOutbox } = require("../../controllers/orders/outboxProcessor");
const clientsService = require("../../controllers/clients/service");
const clientsHistory = require("../../controllers/clients/history");
// Менеджер змінює привʼязку замовлення → історія картки клієнта (з IP і номером замовлення)
const orderLinkCtx = (req, idOrder) => Object.assign(clientsHistory.ctxFromReq(req, "manual"), { source_ref: String(idOrder) });
const clientsStats = require("../../controllers/clients/stats");
const clientsQueries = require("../../controllers/clients/queries");
const { invalidateStatusFlags, deriveOrderFlags, applyStatus } = require("../../controllers/orders/statusFlags");
const orderStock = require("../../controllers/catalog/products/order-stock");
// END Controllers

// Database connection (єдиний promise-стиль для всіх роутів)
const connection_pool = require("../../config/database/connection_pool");
// END Database connection

// Configuration
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
// END Configuration

// Logging
const logging = require("../../logging/logging");
// END Logging

// Validator
const statusValidator = require("../../validator/orders/statuses");
const receiveValidator = require("../../validator/orders/receive");
const receiveQuickValidator = require("../../validator/orders/receiveQuick");
// END Validator

const { getIO } = require("../../controllers/socket/socket");
const io = getIO();

// ─────────────────────────────────────────────────────────────────────────
// Утиліта форматування дати "HH:MM DD.MM.YYYY" (спільна для роутів нижче)
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

// ─────────────────────────────────────────────────────────────────────────
// GET — рендер сторінок
// ─────────────────────────────────────────────────────────────────────────

// Сторінка списку замовлень
router.get("/orders/", authorizationControllers.isAuthenticated, (req, res) => {
	res.render("pages/orders/index", {
		i18n: req,
		user: req.user,
		header: { navbar: "orders" },
	});
});

// Сторінка статусів замовлень (таблиця + модалки додавання/редагування)
router.get("/orders/status", authorizationControllers.isAuthenticated, (req, res) => {
	res.render("pages/orders/status", {
		i18n: req,
		user: req.user,
		header: { navbar: "orders-status" },
	});
});

// ─────────────────────────────────────────────────────────────────────────
// Ручне замовлення: сторінка й створення. Джерело — інтеграція «Custom»
// (префікс номера, стартовий статус, правила сповіщень); на сайт таке замовлення не передається.
// ─────────────────────────────────────────────────────────────────────────
const manualSources = async () => {
	const [rows] = await connection_pool.query(
		`SELECT id, name, order_prefix, default_status_id FROM \`${configDatabase.prefix}settings_integrations\`
		  WHERE platform = 'custom' AND status = 'active' ORDER BY id`
	);
	return rows;
};

router.get("/orders/new/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const [sources, cx] = await Promise.all([manualSources(), require("../../controllers/catalog/products/pricing").currencyCtx()]);
		res.render("pages/orders/new", {
			i18n: req,
			user: req.user,
			header: { navbar: "orders" },
			sources,
			currencies: [cx.base, ...cx.list.map((c) => c.code)],
		});
	} catch (error) {
		logging.error(error);
		res.status(500).send(req.__("orders.errors.server"));
	}
});

// Пошук товарів для ручного замовлення (право на замовлення, а не на каталог)
router.post("/api/orders/products/search/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const rows = await require("../../controllers/catalog/products/products").search((req.body || {}).q, req.user.id_lang, 0);
		res.json({ ok: true, rows: rows.map((r) => ({ id: r.id, sku: r.sku, name: r.name, price: Number(r.price) || 0 })) });
	} catch (error) {
		logging.error(error);
		res.status(500).json({ ok: false, message: req.__("orders.errors.server") });
	}
});

router.post("/api/orders/create/", authorizationControllers.isAuthenticated, async (req, res) => {
	const b = req.body || {};
	const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
	const money = (v) => Math.max(0, Math.round((Number(String(v ?? "").replace(",", ".")) || 0) * 100) / 100);

	const sources = await manualSources();
	const source = sources.find((s) => s.id === Number(b.id_integration));
	if (!source) return res.status(400).json({ message: req.__("orders.new.e_source") });

	const items = (Array.isArray(b.items) ? b.items : [])
		.map((it) => {
			const name = str(it.name, 255);
			const quantity = Math.max(1, Math.min(100000, parseInt(it.quantity, 10) || 1));
			const unit_price = money(it.price);
			return name ? { name, sku: str(it.sku, 120) || null, quantity, unit_price, total: Math.round(unit_price * quantity * 100) / 100 } : null;
		})
		.filter(Boolean);
	if (!items.length) return res.status(400).json({ message: req.__("orders.new.e_items") });

	const c = b.client || {};
	const client = { firstname: str(c.firstname, 100) || null, lastname: str(c.lastname, 100) || null, phone: str(c.phone, 32) || null, email: str(c.email, 120) || null };
	if (!client.phone && !client.email) return res.status(400).json({ message: req.__("orders.new.e_contact") });

	const d = b.delivery || {};
	const shipping = money(d.cost);
	const discount = money(b.discount);
	const totalProducts = Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100;
	const total = Math.max(0, Math.round((totalProducts + shipping - discount) * 100) / 100);

	const body = {
		source: { external_id: "man_" + crypto.randomBytes(12).toString("hex"), channel: "manual" },
		currency: { iso: str(b.currency, 3).toUpperCase() || undefined },
		client,
		items,
		summary: { total_products: totalProducts, total_shipping: shipping, total_discount: discount, total },
		totals: [
			{ code: "sub_total", title: req.__("orders.new.subtotal"), value: totalProducts },
			...(shipping ? [{ code: "shipping", title: req.__("orders.new.shipping"), value: shipping }] : []),
			...(discount ? [{ code: "discount", title: req.__("orders.new.discount"), value: -discount }] : []),
			{ code: "total", title: req.__("orders.new.total"), value: total },
		],
		addresses: [
			{
				type: "shipping",
				firstname: client.firstname,
				lastname: client.lastname,
				phone: client.phone,
				email: client.email,
				city: str(d.city, 128) || null,
				warehouse: str(d.warehouse, 255) || null,
				address_1: str(d.address, 255) || null,
			},
		],
		delivery: { method_title: str(d.method, 128) || null },
		payment: { method_title: str(b.payment, 128) || null },
		note: str(b.note, 999) || null,
		__id_integration: source.id,
		__can_create_clients: 1,
		__user: req.user.userId,
	};

	const conn = await connection_pool.getConnection();
	let id;
	try {
		await conn.beginTransaction();
		id = await require("../../controllers/orders/inboxProcessor").createOrderFromPayload(conn, body);
		// Хто створив — той і відповідальний
		await conn.query(`UPDATE \`${configDatabase.prefix}orders\` SET id_user = ? WHERE id = ?`, [req.user.userId, id]);
		await conn.commit();
	} catch (error) {
		await conn.rollback().catch(() => {});
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	} finally {
		conn.release();
	}
	ordersNotify.fire(id, "new");
	require("../../controllers/common/audit").log(req, { action: "create", module: "orders", entity: "order", id_entity: id, count: 1 });
	return res.status(200).json({ status: "success", id });
});

// ─────────────────────────────────────────────────────────────────────────
// Сторінка замовлення — ЯДРО тягнемо серверно (сторінка одразу з даними),
// важкі списки підвантажує фронт ліниво зі спінером.
// ─────────────────────────────────────────────────────────────────────────
router.get("/orders/:id/", authorizationControllers.isAuthenticated, async (req, res, next) => {
	// Не номер (abandoned-cart, settings…) — сторінки інших маршрутів, зареєстрованих пізніше
	if (!/^\d+$/.test(req.params.id)) return next();
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).send(req.__("orders.errors.bad_order_id"));

	const id_lang = req.user.id_lang;

	try {
		// Ядро замовлення + назви довідників потрібною мовою + IP у текст
		const [orderRows] = await connection_pool.query(
			`SELECT o.*,
              INET6_NTOA(o.ip) AS ip_text,
              oc.currency_iso_code,
              osl.text AS status_name,
              os.color_text AS status_color_text,
              os.color_background AS status_color_background,
              os.icon AS status_icon,
              odl.text AS delivery_name,
              opl.text AS payment_name,
              o.locked_at > NOW() - INTERVAL ${ordersAccess.LOCK_TTL_HOURS} HOUR AS lock_live,
              NULLIF(TRIM(CONCAT_WS(' ', lu.first_name, lu.last_name)), '') AS locked_name,
              si.name AS integration_name,
              si.base_url AS integration_url,
              si.color_text AS integration_color_text,
              si.color_background AS integration_color_background
       FROM \`${configDatabase.prefix}orders\` o
       LEFT JOIN \`${configDatabase.prefix}settings_integrations\` si ON si.id = o.id_integration
       LEFT JOIN \`${configDatabase.prefix}users\` lu ON lu.id = o.locked_by
       LEFT JOIN \`${configDatabase.prefix}orders_currency\` oc ON oc.id = o.currency
       LEFT JOIN \`${configDatabase.prefix}orders_status\` os ON os.id = o.status
       LEFT JOIN \`${configDatabase.prefix}orders_status_lang\` osl ON osl.id_status = os.id AND osl.id_lang = ?
       LEFT JOIN \`${configDatabase.prefix}orders_delivery\` od ON od.id = o.delivery
       LEFT JOIN \`${configDatabase.prefix}orders_delivery_lang\` odl ON odl.id_delivery = od.id AND odl.id_lang = ?
       LEFT JOIN \`${configDatabase.prefix}orders_payment\` op ON op.id = o.payment
       LEFT JOIN \`${configDatabase.prefix}orders_payment_lang\` opl ON opl.id_payment = op.id AND opl.id_lang = ?
       WHERE o.id = ? AND o.deleted_at IS NULL
       LIMIT 1`,
			[id_lang, id_lang, id_lang, id]
		);

		if (!orderRows.length) return res.status(404).send(req.__("orders.errors.order_not_found"));
		const order = orderRows[0];

		// Список статусів для випадайки + адреси — паралельно
		const [statuses, addresses] = await Promise.all([
			connection_pool
				.query(
					`SELECT s.id, s.color_text, s.color_background, s.icon, sl.text AS name
           FROM \`${configDatabase.prefix}orders_status\` s
           LEFT JOIN \`${configDatabase.prefix}orders_status_lang\` sl
             ON sl.id_status = s.id AND sl.id_lang = ?
           ORDER BY s.id ASC`,
					[id_lang]
				)
				.then(([r]) => r),
			connection_pool.query(`SELECT * FROM \`${configDatabase.prefix}orders_addresses\` WHERE id_order = ?`, [id]).then(([r]) => r),
		]);

		// Якщо замовлення створене з контакт-центру — резолвимо діалог для кнопки «Відкрити чат»
		let ccConversation = null;
		try {
			const cf = order.custom_fields || {};
			const convId = cf.cc_conversation ? parseInt(cf.cc_conversation, 10) : null;
			if (convId) {
				const [[conv]] = await connection_pool.query(`SELECT url_token FROM \`${configDatabase.prefix}contact_center_conversations\` WHERE id = ? LIMIT 1`, [convId]);
				if (conv && conv.url_token) ccConversation = { id: convId, url_token: conv.url_token };
			}
		} catch (e) {}

		res.render("pages/orders/page", {
			i18n: req,
			user: req.user,
			header: { navbar: "orders" },
			order,
			statuses,
			addresses,
			ccConversation, // {id, url_token} | null
			me: req.user.userId || req.user.id,
		});
	} catch (error) {
		logging.error(error);
		return res.status(500).send(req.__("orders.errors.server"));
	}
});

// END GET

// ─────────────────────────────────────────────────────────────────────────
// POST — API: СТАТУСИ
// ─────────────────────────────────────────────────────────────────────────

// Список усіх статусів замовлень (для таблиці Tabulator)
router.post("/api/orders/statuses/list/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id_lang = req.user.id_lang; // 1 = en, 2 = uk

	try {
		const [rows] = await connection_pool.query(
			`
            SELECT
                s.id,
                s.color_text,
                s.color_background,
                s.icon,
                s.date_add,
                s.date_edit,
                sl.text
            FROM \`${configDatabase.prefix}orders_status\` s
            LEFT JOIN \`${configDatabase.prefix}orders_status_lang\` sl
                ON sl.id_status = s.id AND sl.id_lang = ?
            ORDER BY s.id ASC
        `,
			[id_lang]
		);

		const result = rows.map((row) => ({
			id: row.id,
			color_text: row.color_text,
			color_background: row.color_background,
			icon: row.icon,
			text: row.text,
			date_add: formatDate(row.date_add),
			date_edit: formatDate(row.date_edit),
		}));

		return res.status(200).json(result);
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	}
});
// END Список статусів

// Отримання одного статусу замовлення (для модалки редагування)
router.post("/api/orders/statuses/get/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.body.id, 10);
	if (!id) return res.status(400).json({ message: req.__("orders.errors.bad_id") });

	try {
		const [rows] = await connection_pool.query(
			`
            SELECT
                s.id,
                s.color_text,
                s.color_background,
                s.icon,
                s.id_template,
                s.logable,
                s.invoice,
                s.hidden,
                s.send_email,
                s.pdf_invoice,
                s.pdf_delivery,
                s.shipped,
                s.paid,
                s.delivery,
                s.count_in_revenue,
                s.is_final,
                s.is_negative
            FROM \`${configDatabase.prefix}orders_status\` s
            WHERE s.id = ?
            LIMIT 1
        `,
			[id]
		);

		if (!rows.length) {
			return res.status(404).json({ message: req.__("orders.errors.status_not_found") });
		}

		const [langRows] = await connection_pool.query(
			`
            SELECT id_lang, text
            FROM \`${configDatabase.prefix}orders_status_lang\`
            WHERE id_status = ?
        `,
			[id]
		);

		// Рядки мов → об'єкт { id_lang: text }. Не хардкодимо 1/2 —
		// фронт бере потрібні по data-id-lang, тож нова мова підвантажиться сама.
		const names = {};
		langRows.forEach((row) => {
			names[row.id_lang] = row.text;
		});

		const s = rows[0];

		const result = {
			id: s.id,
			color_text: s.color_text,
			color_background: s.color_background,
			icon: s.icon,
			id_template: s.id_template,
			logable: s.logable,
			invoice: s.invoice,
			hidden: s.hidden,
			send_email: s.send_email,
			pdf_invoice: s.pdf_invoice,
			pdf_delivery: s.pdf_delivery,
			shipped: s.shipped,
			paid: s.paid,
			delivery: s.delivery,
			count_in_revenue: s.count_in_revenue,
			is_final: s.is_final,
			is_negative: s.is_negative,
			names: names,
		};

		return res.status(200).json(result);
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	}
});
// END Отримання одного статусу

// Додавання нового статусу замовлення
router.post("/api/orders/statuses/add/", authorizationControllers.isAuthenticated, async (req, res) => {
	// 1. Схемна валідація
	const check = statusValidator.status(req.body);
	if (!check.valid) {
		return res.status(400).json({
			status: "error",
			errors: check.errors.map((e) => ({
				field: e.instancePath.replace(/^\//, "").split("/")[0] || (e.params && e.params.missingProperty) || "",
				msg: e.message,
			})),
		});
	}

	const { color_text, color_background, icon, id_template, logable, invoice, hidden, send_email, pdf_invoice, pdf_delivery, shipped, paid, delivery, count_in_revenue, is_final, is_negative, names } = req.body;

	const bit = (v) => (v === 1 || v === true || v === "1" || v === "on" ? 1 : 0);

	// Негативний статус не може одночасно формувати виручку
	if (bit(is_negative) === 1 && bit(count_in_revenue) === 1) {
		return res.status(400).json({
			status: "error",
			errors: [{ field: "count_in_revenue", msg: req.__("orders.errors.negative_in_revenue") }],
		});
	}

	// 2. Кожна прислана мова має бути заповнена
	const emptyLangs = Object.entries(names)
		.filter(([, text]) => !text || text.trim().length === 0)
		.map(([id_lang]) => parseInt(id_lang, 10));

	if (emptyLangs.length > 0) {
		return res.status(400).json({
			status: "error",
			errors: emptyLangs.map((id_lang) => ({ field: "names", id_lang, msg: req.__("orders.errors.name_required") })),
		});
	}

	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		const [result] = await conn.query(
			`INSERT INTO \`${configDatabase.prefix}orders_status\`
                (color_text, color_background, icon, id_template,
                 logable, invoice, hidden, send_email,
                 pdf_invoice, pdf_delivery, shipped, paid, delivery,
                 count_in_revenue, is_final, is_negative,
                 date_add, date_edit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
			[color_text, color_background, icon || "", id_template ? parseInt(id_template, 10) : null, logable, invoice, hidden, send_email, pdf_invoice, pdf_delivery, shipped, paid, delivery, bit(count_in_revenue), bit(is_final), bit(is_negative)]
		);

		const id = result.insertId;

		const ins = `INSERT INTO \`${configDatabase.prefix}orders_status_lang\`
                     (id_status, id_lang, text) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE text = VALUES(text)`;
		for (const [id_lang, text] of Object.entries(names)) {
			await conn.query(ins, [id, parseInt(id_lang, 10), text || ""]);
		}

		await conn.commit();

		// Новий статус має одразу стати відомим воркеру inbox —
		// інакше замовлення з ним впаде на deriveOrderFlags("Невідомий статус").
		invalidateStatusFlags();

		return res.status(200).json({ status: "success", id: id });
	} catch (error) {
		await conn.rollback();
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	} finally {
		conn.release();
	}
});
// END Додавання статусу

// Оновлення статусу замовлення
router.post("/api/orders/statuses/update/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.body.id, 10);
	if (!id) return res.status(400).json({ message: req.__("orders.errors.bad_id") });

	const check = statusValidator.status(req.body);
	if (!check.valid) {
		return res.status(400).json({
			status: "error",
			errors: check.errors.map((e) => ({
				field: e.instancePath.replace(/^\//, "").split("/")[0] || (e.params && e.params.missingProperty) || "",
				msg: e.message,
			})),
		});
	}

	const { color_text, color_background, icon, id_template, logable, invoice, hidden, send_email, pdf_invoice, pdf_delivery, shipped, paid, delivery, count_in_revenue, is_final, is_negative, names } = req.body;

	const emptyLangs = Object.entries(names)
		.filter(([, text]) => !text || text.trim().length === 0)
		.map(([id_lang]) => parseInt(id_lang, 10));

	if (emptyLangs.length > 0) {
		return res.status(400).json({
			status: "error",
			errors: emptyLangs.map((id_lang) => ({ field: "names", id_lang, msg: req.__("orders.errors.name_required") })),
		});
	}

	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		const bit = (v) => (v === 1 || v === true || v === "1" || v === "on" ? 1 : 0);

		await conn.query(
			`UPDATE \`${configDatabase.prefix}orders_status\`
             SET color_text = ?, color_background = ?, icon = ?, id_template = ?,
                 logable = ?, invoice = ?, hidden = ?, send_email = ?,
                 pdf_invoice = ?, pdf_delivery = ?, shipped = ?, paid = ?, delivery = ?,
                 count_in_revenue = ?, is_final = ?, is_negative = ?,
                 date_edit = NOW()
             WHERE id = ?`,
			[color_text, color_background, icon || "", id_template ? parseInt(id_template, 10) : null, logable, invoice, hidden, send_email, pdf_invoice, pdf_delivery, shipped, paid, delivery, bit(count_in_revenue), bit(is_final), bit(is_negative), id]
		);

		// Негативний статус (скасування/повернення) не може одночасно
		// рахуватись у виручці — інакше агрегати суперечитимуть самі собі.
		if (bit(is_negative) === 1 && bit(count_in_revenue) === 1) {
			await conn.rollback();
			return res.status(400).json({
				status: "error",
				errors: [{ field: "count_in_revenue", msg: req.__("orders.errors.negative_in_revenue") }],
			});
		}

		// UPSERT назв: якщо мови ще немає в БД — вставляємо, інакше оновлюємо.
		// (раніше був лише UPDATE — нова мова не додавалась)
		const upsert = `INSERT INTO \`${configDatabase.prefix}orders_status_lang\`
                        (id_status, id_lang, text) VALUES (?, ?, ?)
                    ON DUPLICATE KEY UPDATE text = VALUES(text)`;
		for (const [id_lang, text] of Object.entries(names)) {
			await conn.query(upsert, [id, parseInt(id_lang, 10), text || ""]);
		}

		// Прапорці замовлень — похідні від статусу. Якщо адмін змінив paid/shipped/
		// is_negative, наявні замовлення в цьому статусі треба привести у відповідність.
		await conn.query(
			`UPDATE \`${configDatabase.prefix}orders\` o
          JOIN \`${configDatabase.prefix}orders_status\` st ON st.id = o.status
           SET o.is_canceled = st.is_negative,
               o.is_paid     = st.paid,
               o.is_shipped  = st.shipped,
               o.date_edit   = NOW()
         WHERE o.status = ? AND o.deleted_at IS NULL
           AND (o.is_canceled <> st.is_negative
             OR o.is_paid     <> st.paid
             OR o.is_shipped  <> st.shipped)`,
			[id]
		);

		await conn.commit();

		// Скидаємо кеш прапорців — інакше inboxProcessor підхопить зміни
		// лише через 5 хвилин.
		invalidateStatusFlags();

		return res.status(200).json({ status: "success", recalc_required: true });
	} catch (error) {
		await conn.rollback();
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	} finally {
		conn.release();
	}
});
// END Оновлення статусу

// М'яке видалення замовлення (soft delete)
router.post("/api/orders/delete/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.body.id, 10);
	if (!id || isNaN(id)) {
		return res.status(400).json({ message: req.__("orders.errors.bad_order_id") });
	}

	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		// 1. Перевіряємо, чи існує замовлення та чи не видалене вже
		const [rows] = await conn.query(
			`SELECT id, date_order_day, id_client, total_base, status, is_paid, is_canceled, id_integration
       FROM \`${configDatabase.prefix}orders\`
       WHERE id = ? AND deleted_at IS NULL`,
			[id]
		);

		if (rows.length === 0) {
			await conn.rollback();
			return res.status(404).json({ message: req.__("orders.errors.order_not_found_or_deleted") });
		}

		const order = rows[0];

		// 2. М'яке видалення
		await conn.query(
			`UPDATE \`${configDatabase.prefix}orders\`
       SET deleted_at = NOW(), id_user_deleted = ?, date_edit = NOW()
       WHERE id = ?`,
			[req.user?.userId || req.user?.id || null, id]
		);
		require("../../controllers/common/audit").log(req, { action: "delete", module: "orders", entity: "order", id_entity: id, count: 1 });

		// 3. Логуємо подію
		await conn.query(
			`INSERT INTO \`${configDatabase.prefix}orders_events\`
       (id_order, id_user, type, payload, source, date_add)
       VALUES (?, ?, ?, ?, ?, NOW())`,
			[id, req.user?.id || null, "deleted", JSON.stringify({ reason: "soft_delete", deleted_at: new Date().toISOString() }), "manual"]
		);

		// Склад: зняти резерви видаленого замовлення
		await orderStock.releaseOnDelete(conn, id, req.user?.userId || req.user?.id || null);

		// 4. Перерахунок статистики клієнтів замовлення
		await clientsStats.recalcForOrder(conn, id);

		// Фіксуємо транзакцію (видалення та оновлення клієнта)
		await conn.commit();

		// 5. Перераховуємо статистику за день через rebuildStats (поза транзакцією)
		const day = order.date_order_day || new Date().toISOString().slice(0, 10);
		try {
			await rebuildStats.rebuildRange(day, day);
			logging.info(`[delete-order] Статистику за день ${day} перераховано після видалення замовлення #${id}`);
		} catch (statsError) {
			// Якщо перерахунок статистики впав – логуємо, але відповідь повертаємо успішну,
			// оскільки саме видалення вже виконано. Статистику можна перерахувати вручну.
			logging.error(`[delete-order] Не вдалося перерахувати статистику за день ${day}: ${statsError.message}`);
			// Повертаємо попередження, але не блокуємо успіх.
			return res.status(200).json({
				status: "success",
				message: req.__("orders.errors.deleted_stats_failed"),
				id: id,
			});
		}

		return res.status(200).json({
			status: "success",
			message: req.__("orders.errors.deleted_ok"),
			id: id,
		});
	} catch (error) {
		await conn.rollback();
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.delete_failed") });
	} finally {
		conn.release();
	}
});

// Видалення статусу замовлення (основний запис + назви)
router.post("/api/orders/statuses/delete/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.body.id, 10);
	if (!id) return res.status(400).json({ message: req.__("orders.errors.bad_id") });

	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		// Статус, яким користуються замовлення, видаляти не можна:
		// вони випадуть з JOIN у звітах, а deriveOrderFlags почне кидати помилку.
		const [[used]] = await conn.query(
			`SELECT COUNT(*) AS cnt FROM \`${configDatabase.prefix}orders\`
        WHERE status = ? AND deleted_at IS NULL`,
			[id]
		);
		if (used.cnt > 0) {
			await conn.rollback();
			return res.status(409).json({
				status: "error",
				message: req.__("orders.errors.status_in_use", { n: used.cnt }),
			});
		}

		// Мапінги зі сторонніх джерел теж мають зникнути, інакше resolveStatusId
		// поверне id неіснуючого статусу.
		await conn.query(`DELETE FROM \`${configDatabase.prefix}orders_status_map\` WHERE id_status = ?`, [id]);
		await conn.query(`DELETE FROM \`${configDatabase.prefix}orders_status_lang\` WHERE id_status = ?`, [id]);
		await conn.query(`DELETE FROM \`${configDatabase.prefix}orders_status\` WHERE id = ?`, [id]);

		await conn.commit();

		invalidateStatusFlags();

		return res.status(200).json({ status: "success" });
	} catch (error) {
		await conn.rollback();
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	} finally {
		conn.release();
	}
});
// END Видалення статусу

// ─────────────────────────────────────────────────────────────────────────
// POST — API: ЗАМОВЛЕННЯ
// ─────────────────────────────────────────────────────────────────────────

// Отримання списку замовлень (для таблиці Tabulator) з фільтрами
router.post("/api/orders/orders-list/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id_lang = req.user.id_lang; // 1 = en, 2 = uk
	const p = configDatabase.prefix;

	// ── Фільтри (усі опційні) ──
	const f = req.body || {};
	const where = ["o.deleted_at IS NULL"];
	const params = [id_lang, id_lang, id_lang]; // три id_lang для JOIN-ів нижче

	// Без права «усі замовлення» — лише свої і без відповідального
	const orderScope = require("../../controllers/orders/access").scope(req, "o");
	if (orderScope) {
		where.push(orderScope.sql);
		params.push(...orderScope.params);
	}

	if (f.status) {
		where.push("o.status = ?");
		params.push(parseInt(f.status, 10));
	}
	if (f.financial_status) {
		where.push("o.financial_status = ?");
		params.push(String(f.financial_status));
	}
	if (f.fulfillment_status) {
		where.push("o.fulfillment_status = ?");
		params.push(String(f.fulfillment_status));
	}
	if (f.source_channel) {
		where.push("o.source_channel = ?");
		params.push(String(f.source_channel));
	}
	if (f.id_integration) {
		where.push("o.id_integration = ?");
		params.push(parseInt(f.id_integration, 10));
	}
	// «Мої» — замовлення, де я відповідальний
	if (f.mine) {
		where.push("o.id_user = ?");
		params.push(req.user.userId || req.user.id);
	}
	if (f.currency) {
		where.push("o.currency = ?");
		params.push(parseInt(f.currency, 10));
	}
	if (f.date_from) {
		where.push("o.date_add >= ?");
		params.push(String(f.date_from) + " 00:00:00");
	}
	if (f.date_to) {
		where.push("o.date_add <= ?");
		params.push(String(f.date_to) + " 23:59:59");
	}
	if (f.search && String(f.search).trim().length >= 2) {
		const like = `%${String(f.search).trim()}%`;
		where.push(`(o.reference LIKE ? OR o.external_number LIKE ?
                 OR JSON_EXTRACT(o.client, '$.phone') LIKE ?
                 OR JSON_EXTRACT(o.client, '$.email') LIKE ?
                 OR JSON_EXTRACT(o.client, '$.lastname') LIKE ?)`);
		params.push(like, like, like, like, like);
	}

	// Сторінка й сортування — на сервері (Tabulator, remote): у браузер іде лише поточна сторінка
	const size = Math.min(100, Math.max(10, parseInt(f.size, 10) || 20));
	const page = Math.max(1, parseInt(f.page, 10) || 1);
	const SORT = { id: "o.id", total: "o.total", date_add: "o.date_add" };
	const s0 = Array.isArray(f.sort) && f.sort[0] ? f.sort[0] : {};
	const orderBy = `${SORT[s0.field] || "o.id"} ${s0.dir === "asc" ? "ASC" : "DESC"}${SORT[s0.field] && s0.field !== "id" ? ", o.id DESC" : ""}`;
	// Фільтри — лише по колонках orders, тож лічильник рахується без JOIN-ів
	const filterParams = params.slice(3);

	try {
		const [[{ total }]] = await connection_pool.query(`SELECT COUNT(*) AS total FROM \`${p}orders\` o WHERE ${where.join(" AND ")}`, filterParams);
		const [rows] = await connection_pool.query(
			`SELECT
          o.id, o.id_integration, o.source_channel, o.reference, o.external_number,
          o.total, o.currency_iso, o.financial_status, o.fulfillment_status,
          o.is_paid, o.is_shipped, o.is_canceled, o.id_client, o.id_user, o.locked_by,
          o.date_add, o.date_edit,
          i.name AS integration_name,
          i.color_text AS integration_color_text,
          i.color_background AS integration_color_background,
          oc.currency_iso_code,
          os.color_text AS status_color_text,
          os.color_background AS status_color_background,
          os.icon AS status_icon,
          osl.text AS status_name,
          od.color_text AS delivery_color_text,
          od.color_background AS delivery_color_background,
          odl.text AS delivery_name,
          op.color_text AS payment_color_text,
          op.color_background AS payment_color_background,
          opl.text AS payment_name,
          JSON_UNQUOTE(JSON_EXTRACT(o.custom_fields, '$._delivery_method')) AS delivery_method,
          JSON_UNQUOTE(JSON_EXTRACT(o.custom_fields, '$._payment_method')) AS payment_method,
          NULLIF(TRIM(CONCAT_WS(' ', mu.first_name, mu.last_name)), '') AS manager_name
       FROM (SELECT o.id FROM \`${p}orders\` o WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT ? OFFSET ?) pg
       JOIN \`${p}orders\` o ON o.id = pg.id
       LEFT JOIN \`${p}settings_integrations\` i ON i.id = o.id_integration
       LEFT JOIN \`${p}orders_currency\` oc ON oc.id = o.currency
       LEFT JOIN \`${p}orders_status\` os ON os.id = o.status
       LEFT JOIN \`${p}orders_status_lang\` osl ON osl.id_status = os.id AND osl.id_lang = ?
       LEFT JOIN \`${p}orders_delivery\` od ON od.id = o.delivery
       LEFT JOIN \`${p}orders_delivery_lang\` odl ON odl.id_delivery = od.id AND odl.id_lang = ?
       LEFT JOIN \`${p}orders_payment\` op ON op.id = o.payment
       LEFT JOIN \`${p}orders_payment_lang\` opl ON opl.id_payment = op.id AND opl.id_lang = ?
       LEFT JOIN \`${p}users\` mu ON mu.id = o.id_user
       ORDER BY ${orderBy}`,
			[...filterParams, size, (page - 1) * size, id_lang, id_lang, id_lang]
		);

		const clean = (v) => (v && v !== "null" ? v : null);
		const data = rows.map((row) => ({
			id: row.id,
			id_integration: row.id_integration,
			integration_name: row.integration_name,
			integration_color_text: row.integration_color_text,
			integration_color_background: row.integration_color_background,
			source_channel: row.source_channel,
			reference: row.reference,
			external_number: row.external_number,
			total: Number(row.total),
			currency_iso: row.currency_iso,
			currency_iso_code: row.currency_iso_code,
			financial_status: row.financial_status,
			fulfillment_status: row.fulfillment_status,
			is_paid: row.is_paid,
			is_shipped: row.is_shipped,
			is_canceled: row.is_canceled,
			id_client: row.id_client,
			manager_name: row.manager_name,
			locked: !!row.locked_by,
			status_name: row.status_name,
			status_color_text: row.status_color_text,
			status_color_background: row.status_color_background,
			status_icon: row.status_icon,
			delivery_name: row.delivery_name,
			delivery_color_text: row.delivery_color_text,
			delivery_color_background: row.delivery_color_background,
			delivery_method: clean(row.delivery_method),
			payment_name: row.payment_name,
			payment_method: clean(row.payment_method),
			payment_color_text: row.payment_color_text,
			payment_color_background: row.payment_color_background,
			date_add: formatDate(row.date_add),
			date_edit: formatDate(row.date_edit),
		}));

		return res.status(200).json({ last_page: Math.max(1, Math.ceil(Number(total) / size)), total: Number(total), data });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	}
});
// END Отримання списку замовлень

// Довідники для панелі фільтрів списку замовлень
router.post("/api/orders/list-filters/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id_lang = req.user.id_lang;
	const p = configDatabase.prefix;
	try {
		const [statuses, currencies, channels, integrations, managers] = await Promise.all([
			connection_pool
				.query(
					`SELECT s.id, sl.text AS name FROM \`${p}orders_status\` s
           LEFT JOIN \`${p}orders_status_lang\` sl ON sl.id_status = s.id AND sl.id_lang = ?
           ORDER BY s.id ASC`,
					[id_lang]
				)
				.then(([r]) => r),
			connection_pool.query(`SELECT id, currency_iso_code FROM \`${p}orders_currency\` ORDER BY id ASC`).then(([r]) => r),
			// Канали — беремо реально наявні в замовленнях (distinct)
			connection_pool
				.query(
					`SELECT DISTINCT source_channel FROM \`${p}orders\`
                WHERE source_channel IS NOT NULL AND deleted_at IS NULL ORDER BY source_channel`
				)
				.then(([r]) => r.map((x) => x.source_channel)),
			connection_pool.query(`SELECT id, name FROM \`${p}settings_integrations\` ORDER BY name`).then(([r]) => r),
			// Менеджери — для масового призначення відповідального
			connection_pool.query(`SELECT id, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM \`${p}users\` WHERE active = 1 ORDER BY first_name, last_name`).then(([r]) => r),
		]);

		return res.status(200).json({
			statuses,
			currencies,
			channels,
			integrations,
			managers,
			financial_statuses: ["pending", "authorized", "paid", "partially_paid", "partially_refunded", "refunded", "voided"],
			fulfillment_statuses: ["unfulfilled", "partial", "fulfilled", "returned"],
		});
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	}
});
// END Довідники фільтрів

// ─────────────────────────────────────────────────────────────────────────
// Масові дії зі списку: статус, відповідальний. Лише видимі користувачу замовлення;
// взяті в роботу іншим менеджером — пропускаються (як і в картці).
// ─────────────────────────────────────────────────────────────────────────

router.post("/api/orders/bulk/", authorizationControllers.isAuthenticated, async (req, res) => {
	if (!authorizationControllers.hasPermission(req, "orders.list", "edit")) return res.status(403).json({ message: req.__("catalog.common.forbidden") });
	const b = req.body || {};
	const me = req.user.userId;
	const p = configDatabase.prefix;
	try {
		const { ok, skipped } = await ordersAccess.targets(req, b.ids);
		let done = 0;

		if (b.action === "status") {
			const idStatus = parseInt(b.id_status, 10);
			try {
				await deriveOrderFlags(idStatus);
			} catch {
				return res.status(400).json({ message: req.__("orders.errors.status_missing") });
			}
			const comment = String(b.comment || "").slice(0, 999);
			for (const r of ok) {
				if (Number(r.status) === idStatus) continue;
				const conn = await connection_pool.getConnection();
				let result = null;
				try {
					await conn.beginTransaction();
					result = await applyStatus(conn, r.id, idStatus, { idUser: me, source: "manual", comment, extra: { bulk: true } });
					await conn.commit();
				} catch (e) {
					await conn.rollback().catch(() => {});
					logging.error(e);
					skipped.push({ id: r.id, reference: r.reference, reason: "error" });
					continue;
				} finally {
					conn.release();
				}
				if (!result) continue;
				done++;
				ordersNotify.fire(r.id, "status", { to: idStatus });
				if (result.flags.is_paid && !result.was_paid) ordersNotify.fire(r.id, "paid");
			}
			if (done) kickOutbox();
		} else if (b.action === "manager") {
			const idManager = parseInt(b.id_manager, 10) || null;
			let toName = null;
			if (idManager) {
				const [[u]] = await connection_pool.query(`SELECT NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM \`${p}users\` WHERE id = ? AND active = 1`, [idManager]);
				if (!u) return res.status(400).json({ message: req.__("orders.errors.user_not_found") });
				toName = u.name;
			}
			const change = ok.filter((r) => (r.id_user || null) !== idManager);
			if (change.length) {
				const [names] = await connection_pool.query(`SELECT id, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM \`${p}users\` WHERE id IN (?)`, [[0, ...change.map((r) => r.id_user || 0)]]);
				const nameOf = new Map(names.map((u) => [u.id, u.name]));
				await connection_pool.query(`UPDATE \`${p}orders\` SET id_user = ?, date_edit = NOW() WHERE id IN (?)`, [idManager, change.map((r) => r.id)]);
				await connection_pool.query(`INSERT INTO \`${p}orders_events\` (id_order, id_user, type, payload, source, date_add) VALUES ?`, [
					change.map((r) => [r.id, me, "assigned", JSON.stringify({ from: r.id_user || null, from_name: nameOf.get(r.id_user) || null, to: idManager, to_name: toName, bulk: true }), "manual", new Date()]),
				]);
			}
			done = change.length;
		} else return res.status(400).json({ message: req.__("orders.errors.unknown_action") });

		require("../../controllers/common/audit").log(req, { action: "bulk_" + b.action, module: "orders", entity: "order", count: done, details: { skipped: skipped.length } });
		return res.status(200).json({ status: "success", done, skipped });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	}
});

// ─────────────────────────────────────────────────────────────────────────
// Об'єднання замовлень: позиції інших переносяться в найстаріше (основне), суми додаються,
// доставка рахується одна (основного). Приєднані — у кошик з позначкою, резерви знімаються й ставляться заново.
// Умови: той самий клієнт (картка або телефон), одна валюта, без ТТН, не відправлені й не скасовані.
// ─────────────────────────────────────────────────────────────────────────
const ITEM_COLS = "external_product_id, sku, name, type, quantity, unit_price, unit_price_wt, discount, tax_rate, total, total_base, attributes, meta, id_product, id_variant, map_source";
const phoneKey = (client) => {
	try {
		const c = typeof client === "string" ? JSON.parse(client) : client || {};
		const d = String(c.phone || "").replace(/\D/g, "");
		return d.length >= 9 ? d.slice(-9) : null;
	} catch {
		return null;
	}
};

router.post("/api/orders/merge/", authorizationControllers.isAuthenticated, async (req, res) => {
	if (!authorizationControllers.hasPermission(req, "orders.list", "edit")) return res.status(403).json({ message: req.__("catalog.common.forbidden") });
	const p = configDatabase.prefix;
	const me = req.user.userId;
	const T = (k, v) => req.__("orders.merge." + k, v || {});

	const { ok, skipped } = await ordersAccess.targets(req, (req.body || {}).ids);
	if (skipped.length) return res.status(400).json({ message: T("e_access", { refs: skipped.map((s) => s.reference || "#" + s.id).join(", ") }) });
	if (ok.length < 2) return res.status(400).json({ message: T("e_two") });

	const conn = await connection_pool.getConnection();
	let target = null;
	let absorbed = [];
	try {
		await conn.beginTransaction();
		const [rows] = await conn.query(
			`SELECT o.*, (SELECT COUNT(*) FROM \`${p}orders_shipments\` s WHERE s.id_order = o.id AND s.tracking_number IS NOT NULL) AS ttn
			   FROM \`${p}orders\` o WHERE o.id IN (?) AND o.deleted_at IS NULL ORDER BY o.date_add, o.id FOR UPDATE`,
			[ok.map((r) => r.id)]
		);
		const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
		if (rows.length < 2) throw fail(T("e_two"));
		for (const r of rows) {
			if (Number(r.ttn) || Number(r.is_shipped)) throw fail(T("e_shipped", { ref: r.reference }));
			if (Number(r.is_canceled)) throw fail(T("e_canceled", { ref: r.reference }));
		}
		if (new Set(rows.map((r) => r.currency_iso)).size > 1) throw fail(T("e_currency"));
		// Той самий клієнт: одна картка або один телефон
		const sameCard = rows.every((r) => r.id_client && r.id_client === rows[0].id_client);
		const phones = rows.map((r) => phoneKey(r.client));
		if (!sameCard && !(phones[0] && phones.every((x) => x === phones[0]))) throw fail(T("e_client"));

		[target, ...absorbed] = rows;
		const ids = absorbed.map((r) => r.id);

		// Позиції — копії в основне (зі зіставленням з каталогом)
		await conn.query(`INSERT INTO \`${p}orders_items\` (id_order, ${ITEM_COLS}) SELECT ?, ${ITEM_COLS} FROM \`${p}orders_items\` WHERE id_order IN (?) ORDER BY id_order, id`, [target.id, ids]);

		// Суми: товари, знижки, оплати додаються; доставка — лише основного
		const sum = (f) => absorbed.reduce((s, r) => s + (Number(r[f]) || 0), 0);
		const add = { products: sum("total_products"), discount: sum("total_discount"), paid: sum("total_paid"), total: absorbed.reduce((s, r) => s + (Number(r.total) || 0) - (Number(r.total_shipping) || 0), 0) };
		const rate = Number(target.currency_rate) || 1;
		const total = Number(target.total) + add.total;
		const paid = Number(target.total_paid) + add.paid;
		const discount = Number(target.total_discount) + add.discount;
		await conn.query(
			`UPDATE \`${p}orders\` SET total_products = total_products + ?, total_discount = ?, total_paid = ?, total = ?,
			        total_base = ?, total_paid_base = ?, total_discount_base = ?, date_edit = NOW() WHERE id = ?`,
			[add.products, discount, paid, total, Math.round(total * rate * 100) / 100, Math.round(paid * rate * 100) / 100, Math.round(discount * rate * 100) / 100, target.id]
		);
		// Рядки підсумків основного (як їх показує картка)
		await conn.query(`UPDATE \`${p}orders_totals\` SET value = value + ? WHERE id_order = ? AND code = 'sub_total'`, [add.products, target.id]);
		await conn.query(`UPDATE \`${p}orders_totals\` SET value = ? WHERE id_order = ? AND code = 'total'`, [total, target.id]);
		// Коментарі приєднаних — до основного
		const notes = absorbed.filter((r) => r.note).map((r) => `${r.reference}: ${r.note}`);
		if (notes.length) await conn.query(`UPDATE \`${p}orders\` SET note = CONCAT_WS('\\n', NULLIF(note, ''), ?) WHERE id = ?`, [notes.join("\n").slice(0, 2000), target.id]);

		// Приєднані — у кошик (як видалення): резерви знімаються
		await conn.query(`UPDATE \`${p}orders\` SET deleted_at = NOW(), id_user_deleted = ?, date_edit = NOW() WHERE id IN (?)`, [me, ids]);
		for (const r of absorbed) {
			await orderStock.releaseOnDelete(conn, r.id, me);
			await conn.query(`INSERT INTO \`${p}orders_events\` (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, 'merged_into', ?, 'manual', NOW())`, [r.id, me, JSON.stringify({ id: target.id, reference: target.reference })]);
		}
		await conn.query(`INSERT INTO \`${p}orders_events\` (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, 'merged', ?, 'manual', NOW())`, [
			target.id,
			me,
			JSON.stringify({ orders: absorbed.map((r) => ({ id: r.id, reference: r.reference })), added_total: add.total }),
		]);

		// Резерв основного за новим складом позицій; статистика клієнтів
		await orderStock.afterItems(conn, target.id, null);
		for (const r of rows) await clientsStats.recalcForOrder(conn, r.id);
		await conn.commit();
	} catch (error) {
		await conn.rollback().catch(() => {});
		if (error.status) return res.status(error.status).json({ message: error.message });
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	} finally {
		conn.release();
	}

	// Аналітика за дні приєднаних замовлень (поза транзакцією, як і при видаленні)
	const days = [...new Set(absorbed.map((r) => r.date_order_day).filter(Boolean).map((d) => new Date(d).toISOString().slice(0, 10)))];
	for (const d of days) await rebuildStats.rebuildRange(d, d).catch((e) => logging.error(e));
	require("../../controllers/common/audit").log(req, { action: "merge", module: "orders", entity: "order", id_entity: target.id, count: absorbed.length + 1, details: { merged: absorbed.map((r) => r.id) } });
	return res.status(200).json({ status: "success", id: target.id, merged: absorbed.length });
});

// Ризик клієнта: невикуп, чорний список, дублі (картка показує банер)
router.post("/api/orders/:id/risk/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id = parseInt(req.params.id, 10);
		const risk = id ? await require("../../controllers/clients/risk").forOrder(id) : null;
		if (!risk) return res.status(404).json({ message: req.__("orders.errors.not_found") });
		return res.status(200).json({ ok: true, risk });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	}
});

// ─────────────────────────────────────────────────────────────────────────
// Повідомлення клієнту (Viber / SMS через SMSClub): шаблони, журнал замовлення, ручна відправка
// ─────────────────────────────────────────────────────────────────────────
const orderMessages = require("../../controllers/orders/messages");
const msgFail = (req, res, e) => {
	if (e.status) return res.status(e.status).json({ message: req.__(e.message) });
	logging.error(e);
	return res.status(500).json({ message: req.__("orders.errors.server") });
};

router.get("/orders/settings/messages/", authorizationControllers.isAuthenticated, (req, res) => {
	res.render("pages/orders/messages", { i18n: req, user: req.user, header: { navbar: "orders" }, triggers: orderMessages.TRIGGERS });
});

router.post("/api/orders/settings/messages/list/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const p = configDatabase.prefix;
		const [templates, services, [statuses], [integrations]] = await Promise.all([
			orderMessages.templates(),
			orderMessages.services(),
			connection_pool.query(`SELECT s.id, sl.text AS name FROM \`${p}orders_status\` s LEFT JOIN \`${p}orders_status_lang\` sl ON sl.id_status = s.id AND sl.id_lang = ? ORDER BY s.id`, [req.user.id_lang]),
			connection_pool.query(`SELECT id, name FROM \`${p}settings_integrations\` ORDER BY name`),
		]);
		res.json({ templates, services, statuses, integrations });
	} catch (e) {
		msgFail(req, res, e);
	}
});

router.post("/api/orders/settings/messages/save/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		res.json({ status: "success", id: await orderMessages.saveTemplate(parseInt((req.body || {}).id, 10) || null, req.body || {}) });
	} catch (e) {
		msgFail(req, res, e);
	}
});

router.post("/api/orders/settings/messages/delete/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		await orderMessages.deleteTemplate(parseInt((req.body || {}).id, 10) || 0);
		res.json({ status: "success" });
	} catch (e) {
		msgFail(req, res, e);
	}
});

// Журнал повідомлень замовлення + активні шаблони й сервіси для ручної відправки
router.post("/api/orders/:id/messages/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id = parseInt(req.params.id, 10);
		const [rows, templates, services] = await Promise.all([orderMessages.list(id), orderMessages.templates(), orderMessages.services()]);
		res.json({ rows, templates: templates.filter((t) => t.status).map((t) => ({ id: t.id, name: t.name, text: t.text, id_service: t.id_service })), services: services.map((s) => ({ id: s.id, name: s.name })) });
	} catch (e) {
		msgFail(req, res, e);
	}
});

router.post("/api/orders/:id/messages/preview/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		res.json(await orderMessages.preview(parseInt(req.params.id, 10), String((req.body || {}).text || "")));
	} catch (e) {
		msgFail(req, res, e);
	}
});

router.post("/api/orders/:id/messages/send/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const b = req.body || {};
		const id = await orderMessages.enqueue({ idOrder: parseInt(req.params.id, 10), text: String(b.text || ""), idTemplate: parseInt(b.id_template, 10) || null, idService: parseInt(b.id_service, 10) || null, source: "manual", idUser: req.user.userId });
		res.json({ status: "success", id });
	} catch (e) {
		msgFail(req, res, e);
	}
});

// ─────────────────────────────────────────────────────────────────────────
// Автоматичні правила замовлень (візуальний редактор «Коли → Якщо → Зробити»)
// ─────────────────────────────────────────────────────────────────────────
const orderRules = require("../../controllers/orders/rules");

router.get("/orders/settings/rules/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const p = configDatabase.prefix;
		const [[statuses], [integrations], [users], [templates]] = await Promise.all([
			connection_pool.query(`SELECT s.id, sl.text AS name FROM \`${p}orders_status\` s LEFT JOIN \`${p}orders_status_lang\` sl ON sl.id_status = s.id AND sl.id_lang = ? ORDER BY s.id`, [req.user.id_lang]),
			connection_pool.query(`SELECT id, name FROM \`${p}settings_integrations\` ORDER BY name`),
			connection_pool.query(`SELECT id, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM \`${p}users\` WHERE active = 1 ORDER BY first_name, last_name`),
			connection_pool.query(`SELECT id, name FROM \`${p}orders_message_templates\` WHERE status = 1 ORDER BY sort_order, id`).catch(() => [[]]),
		]);
		res.render("pages/orders/rules", {
			i18n: req,
			user: req.user,
			header: { navbar: "orders" },
			statuses,
			integrations,
			users,
			templates,
			events: orderRules.EVENTS,
			conditions: orderRules.CONDITIONS,
			actions: orderRules.ACTIONS,
		});
	} catch (error) {
		logging.error(error);
		res.status(500).send(req.__("orders.errors.server"));
	}
});

const rulesFail = (req, res, e) => {
	if (e.status) return res.status(e.status).json({ message: req.__(e.message) });
	logging.error(e);
	return res.status(500).json({ message: req.__("orders.errors.server") });
};

router.post("/api/orders/settings/rules/list/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		res.json({ rows: await orderRules.list() });
	} catch (e) {
		rulesFail(req, res, e);
	}
});

router.post("/api/orders/settings/rules/save/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const b = req.body || {};
		const id = await orderRules.save(parseInt(b.id, 10) || null, b);
		require("../../controllers/common/audit").log(req, { action: "save", module: "orders", entity: "rule", id_entity: id, count: 1 });
		res.json({ status: "success", id });
	} catch (e) {
		rulesFail(req, res, e);
	}
});

router.post("/api/orders/settings/rules/delete/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		await orderRules.remove(parseInt((req.body || {}).id, 10) || 0);
		res.json({ status: "success" });
	} catch (e) {
		rulesFail(req, res, e);
	}
});

router.post("/api/orders/settings/rules/:id/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ message: req.__("orders.errors.bad_id") });
		const [rule, log] = await Promise.all([orderRules.get(id), orderRules.log(id)]);
		res.json({ rule, log });
	} catch (e) {
		rulesFail(req, res, e);
	}
});

// Список товарів конкретного замовлення (читає з нормалізованої orders_items)
router.post("/orders/:id_order/products-list/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id_order = parseInt(req.params.id_order, 10);
	if (!id_order) return res.status(400).json({ message: req.__("orders.errors.bad_id") });

	try {
		const [rows] = await connection_pool.query(
			`SELECT id, id_product, external_product_id, sku, name, type,
                    quantity, unit_price, unit_price_wt, discount, tax_rate, total,
                    attributes, meta
             FROM \`${configDatabase.prefix}orders_items\`
             WHERE id_order = ?
             ORDER BY id ASC`,
			[id_order]
		);

		return res.status(200).json(rows); // порожнє замовлення → []
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	}
});
// END Товари замовлення

// Дані клієнта конкретного замовлення:
router.post("/orders/:id_order/client/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id_order = parseInt(req.params.id_order, 10);
	if (!id_order) return res.status(400).json({ message: req.__("orders.errors.bad_id") });
	const p = configDatabase.prefix;

	try {
		const [rows] = await connection_pool.query(`SELECT id_client, id_integration, client FROM \`${p}orders\` WHERE id = ? LIMIT 1`, [id_order]);
		if (!rows.length) return res.status(404).json({ message: req.__("orders.errors.order_not_found") });

		const snapshot = rows[0].client || {};
		const id_client = rows[0].id_client;

		if (id_client) {
			const client = await clientsQueries.brief(id_client);
			if (client) return res.status(200).json({ linked: true, snapshot, client });
		}

		const [[addr]] = await connection_pool.query(`SELECT country FROM \`${p}orders_addresses\` WHERE id_order = ? ORDER BY (type='shipping') DESC LIMIT 1`, [id_order]);

		const candidates = await clientsQueries.candidatesFor({ email: snapshot.email, phone: snapshot.phone, externalId: snapshot.external_client_id, id_integration: rows[0].id_integration }, addr ? addr.country : null);

		return res.status(200).json({ linked: false, snapshot, candidates });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	}
});
// END Дані клієнта

// ─────────────────────────────────────────────────────────────────────────
// Прив'язати наявного клієнта до замовлення.
//   Проставляє id_client, перераховує кеш клієнта, пише подію — у транзакції.
//   Снапшот (client JSON) НЕ чіпаємо — це історичний контакт.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/:id/client/link/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id_order = parseInt(req.params.id, 10);
	const id_client = parseInt(req.body.id_client, 10);
	if (!id_order || !id_client) return res.status(400).json({ message: req.__("orders.errors.bad_data") });

	const p = configDatabase.prefix;
	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		const [[order]] = await conn.query(`SELECT id_client FROM \`${p}orders\` WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`, [id_order]);
		if (!order) {
			await conn.rollback();
			return res.status(404).json({ message: req.__("orders.errors.order_not_found") });
		}

		const [[client]] = await conn.query(`SELECT id FROM \`${p}clients\` WHERE id = ? AND deleted_at IS NULL AND id_merged_into IS NULL LIMIT 1`, [id_client]);
		if (!client) {
			await conn.rollback();
			return res.status(404).json({ message: req.__("orders.errors.client_not_found") });
		}

		const prev_client = order.id_client;
		await conn.query(`UPDATE \`${p}orders\` SET id_client = ?, date_edit = NOW() WHERE id = ?`, [id_client, id_order]);
		await clientsHistory.linked(conn, orderLinkCtx(req, id_order), "order", id_order, id_client, prev_client, "buyer", await orderReference(conn, id_order));

		await clientsStats.recalc(conn, id_client);
		if (prev_client && prev_client !== id_client) await clientsStats.recalc(conn, prev_client);

		await conn.query(
			`INSERT INTO \`${p}orders_events\` (id_order, id_user, type, payload, source, date_add)
       VALUES (?, ?, 'client_linked', ?, 'manual', NOW())`,
			[id_order, req.user.id, JSON.stringify({ id_client, prev_client: prev_client || null })]
		);

		await conn.commit();
		return res.status(200).json({ status: "success", id_client });
	} catch (error) {
		await conn.rollback();
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	} finally {
		conn.release();
	}
});
// END Прив'язати клієнта

// ─────────────────────────────────────────────────────────────────────────
// Відв'язати клієнта від замовлення (id_client → 0).
//   Снапшот лишається; кеш колишнього клієнта перераховуємо; подія.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/:id/client/unlink/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id_order = parseInt(req.params.id, 10);
	if (!id_order) return res.status(400).json({ message: req.__("orders.errors.bad_id") });

	const p = configDatabase.prefix;
	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		const [[order]] = await conn.query(`SELECT id_client FROM \`${p}orders\` WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`, [id_order]);
		if (!order) {
			await conn.rollback();
			return res.status(404).json({ message: req.__("orders.errors.order_not_found") });
		}

		const prev_client = order.id_client;
		if (!prev_client) {
			await conn.rollback();
			return res.status(400).json({ message: req.__("orders.errors.client_not_linked") });
		}

		await conn.query(`UPDATE \`${p}orders\` SET id_client = NULL, date_edit = NOW() WHERE id = ?`, [id_order]);
		await clientsHistory.linked(conn, orderLinkCtx(req, id_order), "order", id_order, null, prev_client, "buyer", await orderReference(conn, id_order));
		await clientsStats.recalc(conn, prev_client);

		await conn.query(
			`INSERT INTO \`${p}orders_events\` (id_order, id_user, type, payload, source, date_add)
       VALUES (?, ?, 'client_unlinked', ?, 'manual', NOW())`,
			[id_order, req.user.id, JSON.stringify({ prev_client })]
		);

		await conn.commit();
		return res.status(200).json({ status: "success" });
	} catch (error) {
		await conn.rollback();
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	} finally {
		conn.release();
	}
});
// END Відв'язати клієнта

// ─────────────────────────────────────────────────────────────────────────
// Створити клієнта зі снапшоту замовлення й одразу прив'язати.
//   Захист від дубля: якщо email/phone уже існує — 409 з кандидатами.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/:id/client/create/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id_order = parseInt(req.params.id, 10);
	if (!id_order) return res.status(400).json({ message: req.__("orders.errors.bad_id") });

	const p = configDatabase.prefix;
	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		const [[order]] = await conn.query(`SELECT id_client, client FROM \`${p}orders\` WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`, [id_order]);
		if (!order) {
			await conn.rollback();
			return res.status(404).json({ message: req.__("orders.errors.order_not_found") });
		}
		if (order.id_client) {
			await conn.rollback();
			return res.status(400).json({ message: req.__("orders.errors.client_already_linked") });
		}

		const snap = order.client || {};
		const [[addr]] = await conn.query(`SELECT country FROM \`${p}orders_addresses\` WHERE id_order = ? ORDER BY (type='shipping') DESC LIMIT 1`, [id_order]);

		const r = await clientsService.resolveClient(
			{
				kind: "person",
				person: { first_name: snap.firstname, last_name: snap.lastname },
				contacts: [
					{ type: "phone", value: snap.phone },
					{ type: "email", value: snap.email },
				],
				country: addr ? addr.country : null,
				roles: ["customer"],
				lifecycleCode: "prospect",
				source: "order",
				sourceRef: String(id_order),
				idUser: req.user.userId || req.user.id,
			},
			{ conn, createIfMissing: true, history: orderLinkCtx(req, id_order) }
		);

		if (!r.id_client) {
			await conn.rollback();
			return res.status(400).json({ message: req.__("orders.errors.not_enough_client_data") });
		}

		await conn.query(`UPDATE \`${p}orders\` SET id_client = ?, date_edit = NOW() WHERE id = ?`, [r.id_client, id_order]);
		await clientsHistory.linked(conn, orderLinkCtx(req, id_order), "order", id_order, r.id_client, null, "buyer", await orderReference(conn, id_order));
		await clientsStats.recalc(conn, r.id_client);
		await conn.query(
			`INSERT INTO \`${p}orders_events\` (id_order, id_user, type, payload, source, date_add)
       VALUES (?, ?, ?, ?, 'manual', NOW())`,
			[id_order, req.user.id, r.created ? "client_created" : "client_linked", JSON.stringify({ id_client: r.id_client, score: r.score })]
		);

		await conn.commit();
		return res.status(200).json({ status: "success", id_client: r.id_client, created: r.created });
	} catch (error) {
		await conn.rollback();
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	} finally {
		conn.release();
	}
});
// END Створити клієнта

// ─────────────────────────────────────────────────────────────────────────
// Ручний пошук клієнта (для випадку, коли автозбіг хибний / порожній).
//   Шукає за імʼям, email, телефоном, компанією.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/clients/search/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const access = require("../../controllers/clients/access");
		const rows = await clientsQueries.search(req.body.q || "", null, access.seeAll(req) ? null : req.user.userId || req.user.id);
		return res.status(200).json(rows);
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	}
});
// END Ручний пошук клієнта

// ─────────────────────────────────────────────────────────────────────────
// Деталі замовлення (ліниво): товари+суми, оплати, відправлення, повернення,
// документи, збори — одним запитом, щоб показати зі спінером після відкриття.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/:id/details/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ message: req.__("orders.errors.bad_id") });

	const p = configDatabase.prefix;
	try {
		const [items, totals, payments, shipments, refunds, documents, fees, discounts] = await Promise.all([connection_pool.query(`SELECT * FROM \`${p}orders_items\` WHERE id_order = ? ORDER BY id ASC`, [id]).then(([r]) => r), connection_pool.query(`SELECT * FROM \`${p}orders_totals\` WHERE id_order = ? ORDER BY sort_order ASC`, [id]).then(([r]) => r), connection_pool.query(`SELECT * FROM \`${p}orders_payments\` WHERE id_order = ? ORDER BY id ASC`, [id]).then(([r]) => r), connection_pool.query(`SELECT * FROM \`${p}orders_shipments\` WHERE id_order = ? ORDER BY id ASC`, [id]).then(([r]) => r), connection_pool.query(`SELECT * FROM \`${p}orders_refunds\` WHERE id_order = ? ORDER BY id ASC`, [id]).then(([r]) => r), connection_pool.query(`SELECT * FROM \`${p}orders_documents\` WHERE id_order = ? ORDER BY id ASC`, [id]).then(([r]) => r), connection_pool.query(`SELECT * FROM \`${p}orders_fees\` WHERE id_order = ? ORDER BY id ASC`, [id]).then(([r]) => r), connection_pool.query(`SELECT code, name, type, value FROM \`${p}orders_discounts\` WHERE id_order = ? ORDER BY id ASC`, [id]).then(([r]) => r)]);
		return res.status(200).json({ items, totals, payments, shipments, refunds, documents, fees, discounts });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	}
});

// ─────────────────────────────────────────────────────────────────────────
// Взяти в роботу / звільнити. Поки замовлення в роботі, змінювати його може лише цей менеджер
// (перевірка — controllers/orders/access.js, правила з lock). Перехопити чуже — право orders.settings.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/:id/take/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.params.id, 10);
	const me = req.user.userId || req.user.id;
	const p = configDatabase.prefix;
	try {
		const holder = await ordersAccess.lockedBy(req, id);
		if (holder && !((req.body || {}).force && ordersAccess.can(req, "orders.settings", "edit"))) {
			return res.status(423).json({ ok: false, error: req.__("orders.lock.busy", { name: holder.name || "#" + holder.id }) });
		}
		const [r] = await connection_pool.query(`UPDATE \`${p}orders\` SET id_user = ?, locked_by = ?, locked_at = NOW() WHERE id = ? AND deleted_at IS NULL`, [me, me, id]);
		if (!r.affectedRows) return res.status(404).json({ ok: false, error: req.__("orders.errors.order_not_found") });
		await connection_pool.query(`INSERT INTO \`${p}orders_events\` (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, 'taken', ?, 'manual', NOW())`, [id, me, JSON.stringify({ from: holder ? holder.id : null, from_name: holder ? holder.name : null })]);
		return res.json({ ok: true });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ ok: false, error: req.__("orders.errors.server") });
	}
});

router.post("/api/orders/:id/release/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.params.id, 10);
	const me = req.user.userId || req.user.id;
	const p = configDatabase.prefix;
	try {
		const admin = ordersAccess.can(req, "orders.settings", "edit") ? 1 : 0;
		const [r] = await connection_pool.query(`UPDATE \`${p}orders\` SET locked_by = NULL, locked_at = NULL WHERE id = ? AND locked_by IS NOT NULL AND (locked_by = ? OR ?)`, [id, me, admin]);
		if (r.affectedRows) await connection_pool.query(`INSERT INTO \`${p}orders_events\` (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, 'released', NULL, 'manual', NOW())`, [id, me]);
		return res.json({ ok: true });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ ok: false, error: req.__("orders.errors.server") });
	}
});

// ─────────────────────────────────────────────────────────────────────────
// Зміна статусу (стиль OpenCart): оновлює замовлення + пише в історію + подію.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/:id/status/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.params.id, 10);
	const id_status = parseInt(req.body.id_status, 10);
	const comment = (req.body.comment || "").toString().slice(0, 999);
	const notify = req.body.notify ? 1 : 0;
	if (!id || !id_status) return res.status(400).json({ message: req.__("orders.errors.bad_data") });
	try {
		await deriveOrderFlags(id_status);
	} catch {
		return res.status(400).json({ message: req.__("orders.errors.status_missing") });
	}

	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		const result = await applyStatus(conn, id, id_status, { idUser: req.user.id, source: "manual", comment, notify });
		if (!result) {
			await conn.rollback();
			return res.status(404).json({ message: req.__("orders.errors.order_not_found") });
		}
		const { id_status_old, flags } = result;

		await conn.commit();

		kickOutbox();

		// Сповіщення команди за правилами сайту (після commit)
		if (id_status !== id_status_old) ordersNotify.fire(id, "status", { to: id_status });
		if (flags.is_paid && !result.was_paid) ordersNotify.fire(id, "paid");

		// TODO(next): якщо notify — поставити email клієнту в чергу
		// TODO(next): io.emit("order:status", { id, id_status }) — realtime

		return res.status(200).json({ status: "success", id_status, id_status_old });
	} catch (error) {
		await conn.rollback();
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	} finally {
		conn.release();
	}
});

// ─────────────────────────────────────────────────────────────────────────
// Історія статусів (для таба) — старий→новий, хто, коментар, повідомлення.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/:id/history/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ message: req.__("orders.errors.bad_id") });
	const id_lang = req.user.id_lang;
	const p = configDatabase.prefix;

	try {
		const [rows] = await connection_pool.query(
			`SELECT h.id, h.id_status, h.id_status_old, h.source, h.comment, h.notified, h.date_add, h.id_user,
              snew.text AS status_name,
              sold.text AS status_old_name,
              NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS user_name
       FROM \`${p}orders_status_history\` h
       LEFT JOIN \`${p}users\` u ON u.id = h.id_user
       LEFT JOIN \`${p}orders_status_lang\` snew ON snew.id_status = h.id_status AND snew.id_lang = ?
       LEFT JOIN \`${p}orders_status_lang\` sold ON sold.id_status = h.id_status_old AND sold.id_lang = ?
       WHERE h.id_order = ?
       ORDER BY h.id DESC`,
			[id_lang, id_lang, id]
		);
		return res.status(200).json(rows.map((r) => ({ ...r, date_add: formatDate(r.date_add) })));
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	}
});

// ─────────────────────────────────────────────────────────────────────────
// Журнал подій (для таба) — усі події замовлення.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/:id/events/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ message: req.__("orders.errors.bad_id") });
	const p = configDatabase.prefix;
	try {
		const [rows] = await connection_pool.query(
			`SELECT e.id, e.id_user, e.type, e.payload, e.source, e.date_add,
              NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS user_name
       FROM \`${p}orders_events\` e
       LEFT JOIN \`${p}users\` u ON u.id = e.id_user
       WHERE e.id_order = ? ORDER BY e.id DESC`,
			[id]
		);
		return res.status(200).json(rows.map((r) => ({ ...r, date_add: formatDate(r.date_add) })));
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	}
});

// ─────────────────────────────────────────────────────────────────────────
// Сирий payload від джерела (для таба Raw).
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/:id/raw/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ message: req.__("orders.errors.bad_id") });
	const p = configDatabase.prefix;
	try {
		const [rows] = await connection_pool.query(`SELECT payload, received_at FROM \`${p}orders_raw\` WHERE id_order = ? LIMIT 1`, [id]);
		if (!rows.length) return res.status(200).json({ payload: null });
		return res.status(200).json({ payload: rows[0].payload, received_at: formatDate(rows[0].received_at) });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: req.__("orders.errors.server") });
	}
});

// POST /api/orders/receive/ — приймає webhook, кладе в чергу, миттєво відповідає 202.
// Обробку одразу штовхає подієво (kickWorker), без опитування за годинником.
router.post("/api/orders/receive/", verifyOrderToken("can_create_orders"), async (req, res) => {
	const P = configDatabase.prefix;
	const token = req.orderToken;
	const body = req.body || {};

	const check = receiveValidator.receive(body);
	if (!check.valid) {
		await logAttempt({
			id_token: token.id,
			prefix: req.orderTokenPrefix,
			ip: req.clientIp,
			domain: req.sourceHost,
			endpoint: req.originalUrl,
			result: "rejected",
			reject_reason: "bad_payload",
			http_status: 422,
			external_id: body?.source?.external_id != null ? String(body.source.external_id) : null,
			message: "schema validation failed",
		});
		return res.status(422).json({
			status: "error",
			reason: "bad_payload",
			errors: check.errors.map((e) => ({ field: e.instancePath || (e.params && e.params.missingProperty) || "", msg: e.message })),
		});
	}

	const external_id = String(body.source.external_id);
	const id_integration = token.id_integration || null;

	// Прокидаємо скоуп у payload, щоб воркер знав, чи можна створювати клієнтів
	const bodyToQueue = { ...body, __can_create_clients: token.can_create_clients === 1 ? 1 : 0 };

	try {
		const [ins] = await connection_pool.query(
			`INSERT INTO \`${P}orders_inbox\`
        (id_token, id_integration, external_id, payload, status, ip, received_at)
       VALUES (?, ?, ?, ?, 'pending', INET6_ATON(?), NOW())`,
			[token.id, id_integration, external_id, JSON.stringify(bodyToQueue), req.clientIp]
		);

		await logAttempt({
			id_token: token.id,
			prefix: req.orderTokenPrefix,
			ip: req.clientIp,
			domain: req.sourceHost,
			endpoint: req.originalUrl,
			result: "success",
			http_status: 202,
			external_id,
			message: `queued inbox#${ins.insertId}`,
		});

		kickWorker(); // ← подієвий запуск обробки

		return res.status(202).json({ status: "queued", inbox_id: ins.insertId });
	} catch (error) {
		if (error && error.code === "ER_DUP_ENTRY") {
			// Повторна передача: якщо раніше не вдалося створити замовлення (failed) або його видалили — ставимо в чергу знову з новими даними
			const [[prev]] = await connection_pool.query(
				`SELECT i.id, i.status, i.id_order, i.last_error, o.id AS order_exists
				   FROM \`${P}orders_inbox\` i
				   LEFT JOIN \`${P}orders\` o ON o.id = i.id_order AND o.deleted_at IS NULL
				  WHERE i.external_id = ? AND (i.id_token = ? OR i.id_integration <=> ?)
				  ORDER BY i.id DESC LIMIT 1`,
				[external_id, token.id, id_integration]
			);
			// Повторна передача того самого замовлення — це оновлення з сайту (наприклад, відділення НП
			// дописалося після створення): нові дані йдуть у ту саму чергу, воркер оновить замовлення (upsert за sync_hash).
			// Ще не оброблене (pending) — просто підміняємо payload свіжішим.
			if (prev && prev.status === "pending") {
				await connection_pool.query(`UPDATE \`${P}orders_inbox\` SET payload = ?, received_at = NOW() WHERE id = ? AND status = 'pending'`, [JSON.stringify(bodyToQueue), prev.id]);
			}
			const retry = prev && (prev.status === "failed" || prev.status === "done");
			if (retry) {
				await connection_pool.query(`UPDATE \`${P}orders_inbox\` SET payload = ?, status = 'pending', attempts = 0, locked_at = NULL, last_error = NULL, id_order = NULL, received_at = NOW() WHERE id = ?`, [JSON.stringify(bodyToQueue), prev.id]);
				kickWorker();
			}
			const message = !retry ? req.__("orders.errors.already_queued") : prev.status === "done" && prev.order_exists ? req.__("orders.errors.update_queued", { id: prev.id_order }) : req.__("orders.errors.requeued", { error: prev.last_error || req.__("orders.errors.order_not_found_lc") });
			await logAttempt({
				id_token: token.id,
				prefix: req.orderTokenPrefix,
				ip: req.clientIp,
				domain: req.sourceHost,
				endpoint: req.originalUrl,
				result: "success",
				http_status: retry ? 202 : 200,
				id_order: prev && prev.order_exists ? prev.id_order : null,
				external_id,
				message: retry ? `requeued inbox#${prev.id}` : `duplicate inbox#${prev ? prev.id : "?"} (${prev ? prev.status : "?"})`,
			});
			return res.status(retry ? 202 : 200).json({ status: retry ? "queued" : "duplicate", message, inbox_id: prev ? prev.id : null, id_order: prev && prev.order_exists ? prev.id_order : null });
		}
		logging.error(error);
		return res.status(500).json({ status: "error", message: req.__("orders.errors.server") });
	}
});
// END Прийом замовлень

// POST /api/orders/receive/quick/ — ШВИДКЕ замовлення ("Купити в 1 клік").
//   Форма шле лише client + items (+ customer_comment, utm).
//   external_id/канал проставляє CRM. Без дедуплікації — кожна заявка окрема.
router.post("/api/orders/receive/quick/", verifyOrderToken("can_create_orders"), async (req, res) => {
	const P = configDatabase.prefix;
	const token = req.orderToken;
	const body = req.body || {};

	const check = receiveQuickValidator.receiveQuick(body);
	if (!check.valid) {
		await logAttempt({
			id_token: token.id,
			prefix: req.orderTokenPrefix,
			ip: req.clientIp,
			domain: req.sourceHost,
			endpoint: req.originalUrl,
			result: "rejected",
			reject_reason: "bad_payload",
			http_status: 422,
			message: "quick schema validation failed",
		});
		return res.status(422).json({
			status: "error",
			reason: "bad_payload",
			errors: check.errors.map((e) => ({ field: e.instancePath || (e.params && e.params.missingProperty) || "", msg: e.message })),
		});
	}

	const id_integration = token.id_integration || null;
	if (!id_integration) {
		return res.status(400).json({ status: "error", message: req.__("orders.errors.token_no_integration") });
	}

	const client = body.client || {};
	const items = Array.isArray(body.items) ? body.items : [];

	try {
		// Кожна заявка — окреме замовлення. Захист від дублів робиться на сайті.
		const external_id = "1c_" + crypto.randomBytes(16).toString("hex");

		// Повний конверт для воркера — те, що очікує createOrderFromPayload
		const envelope = {
			source: { external_id },
			client: {
				firstname: client.firstname || null,
				lastname: client.lastname || null,
				phone: client.phone || null,
				email: client.email || null,
			},

			items: items.map((it) => {
				const quantity = Number(it.quantity) || 1;
				const unit_price = it.unit_price != null ? Number(it.unit_price) : 0;
				return {
					name: it.name,
					external_product_id: it.external_product_id != null ? it.external_product_id : null,
					sku: it.sku || null,
					quantity,
					unit_price,
					// якщо total не передали — рахуємо unit_price * quantity
					total: it.total != null ? Number(it.total) : unit_price * quantity,
				};
			}),

			note: body.customer_comment || null,
			custom_fields: body.utm && typeof body.utm === "object" ? { utm: body.utm } : {},
			__id_integration: id_integration,
			__can_create_clients: token.can_create_clients === 1 ? 1 : 0,
		};

		const [ins] = await connection_pool.query(
			`INSERT INTO \`${P}orders_inbox\`
        (id_token, id_integration, external_id, payload, status, ip, received_at)
       VALUES (?, ?, ?, ?, 'pending', INET6_ATON(?), NOW())`,
			[token.id, id_integration, external_id, JSON.stringify(envelope), req.clientIp]
		);

		await logAttempt({
			id_token: token.id,
			prefix: req.orderTokenPrefix,
			ip: req.clientIp,
			domain: req.sourceHost,
			endpoint: req.originalUrl,
			result: "success",
			http_status: 202,
			external_id,
			message: `quick queued inbox#${ins.insertId}`,
		});

		kickWorker();
		return res.status(202).json({ status: "queued", inbox_id: ins.insertId });
	} catch (error) {
		logging.error(error);
		console.log(error);
		return res.status(500).json({ status: "error", message: req.__("orders.errors.server") });
	}
});
// END Прийом швидких замовлень

// POST /api/orders/statuses/pull/ — віддає список статусів CRM для звʼязування
// на боці CMS (OpenCart). Захищено токеном зі скоупом can_read.
// Мову можна передати в body.id_lang; дефолт — 1 (en).
router.post("/api/orders/statuses/pull/", verifyOrderToken("can_read"), async (req, res) => {
	const P = configDatabase.prefix;
	const token = req.orderToken;
	const id_lang = parseInt(req.body?.id_lang, 10) || 1;

	try {
		const [rows] = await connection_pool.query(
			`SELECT s.id, s.color_text, s.color_background, s.icon,
              sl.text AS name
       FROM \`${P}orders_status\` s
       LEFT JOIN \`${P}orders_status_lang\` sl
         ON sl.id_status = s.id AND sl.id_lang = ?
       ORDER BY s.id ASC`,
			[id_lang]
		);

		const statuses = rows.map((r) => ({
			id: r.id,
			name: r.name || `#${r.id}`,
			color_text: r.color_text,
			color_background: r.color_background,
			icon: r.icon,
		}));

		await logAttempt({
			id_token: token.id,
			prefix: req.orderTokenPrefix,
			ip: req.clientIp,
			domain: req.sourceHost,
			endpoint: req.originalUrl,
			result: "success",
			http_status: 200,
			message: `pulled ${statuses.length} statuses`,
		});

		return res.status(200).json({ status: "success", statuses });
	} catch (error) {
		logging.error(error);
		await logAttempt({
			id_token: token.id,
			prefix: req.orderTokenPrefix,
			ip: req.clientIp,
			domain: req.sourceHost,
			endpoint: req.originalUrl,
			result: "rejected",
			reject_reason: "server_error",
			http_status: 500,
			message: String(error.message || error).slice(0, 999),
		});
		return res.status(500).json({ status: "error", message: req.__("orders.errors.server") });
	}
});
// END Віддача статусів для CMS

// POST /api/clients/receive/ — приймає одного клієнта з CMS (для синку бази клієнтів).
// Дедуплікація: external_id → email → phone. Скоуп can_create_clients.
router.post("/api/clients/receive/", verifyOrderToken("can_create_clients"), async (req, res) => {
	const token = req.orderToken;
	const c = req.body?.client || req.body || {};
	const id_integration = token.id_integration || null;
	const externalId = c.external_client_id || c.external_id || null;

	if (!c.email && !c.phone && !externalId) {
		return res.status(422).json({ status: "error", reason: "bad_payload", message: req.__("orders.errors.need_contact") });
	}

	const a = c.address || null;
	try {
		const r = await clientsService.resolveClient({
			kind: "person",
			person: { first_name: c.firstname, last_name: c.lastname },
			contacts: [
				{ type: "phone", value: c.phone },
				{ type: "email", value: c.email },
			],
			externalIds: externalId && id_integration ? [{ system: "site", id_integration, external_id: String(externalId) }] : [],
			addresses: a
				? [
						{
							type: "shipping",
							country: a.country || c.country || null,
							region: a.region,
							city: a.city,
							address_line: [a.address_1, a.address_2].filter(Boolean).join(", "),
							postcode: a.postcode,
							carrier_city_ref: a.city_ref || null,
							carrier_point_ref: a.warehouse_ref || null,
							carrier_point_name: a.warehouse || "",
						},
					]
				: [],
			country: c.country || null,
			roles: ["customer"],
			source: "site_sync",
			sourceRef: externalId ? String(externalId) : "",
		});

		return res.status(r.created ? 201 : 200).json({ status: r.created ? "created" : "matched", id_client: r.id_client, score: r.score });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ status: "error", message: req.__("orders.errors.server") });
	}
});
// END Синк клієнта

// END POST

module.exports = router;