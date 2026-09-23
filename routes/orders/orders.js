const express = require("express");
const crypto = require("crypto");
const { parsePhoneNumberFromString } = require("libphonenumber-js");
const router = express.Router();

// Controllers
const authorizationControllers = require("../../controllers/authorization/authorization");
const rebuildStats = require("../../cron/analytics/rebuildStats");
const { verifyOrderToken, logAttempt } = require("../../controllers/orders/tokenAuth");
const { kickWorker } = require("../../controllers/orders/inboxProcessor");
const { emitToOutbox } = require("../../controllers/orders/emitOutbox");
const { kickOutbox } = require("../../controllers/orders/outboxProcessor");
const { normalizePhone, recalcClientStats } = require("../../controllers/orders/clientMatch");
const { invalidateStatusFlags, deriveOrderFlags } = require("../../controllers/orders/statusFlags");
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
// Пошук кандидатів-клієнтів за контактом, зі скорингом впевненості.
//   email + phone збігаються   → 100 (🟢 auto-suggest)
//   лише email АБО лише phone   → 60  (🟡 показати, хай підтвердить)
//   лише схоже імʼя             → 30  (🔴 обережно)
//   ненормалізований телефон    → бал по телефону знижений (−20)
// defaultCountry — ISO-2 з адреси/замовлення, для нормалізації локального номера.
// ─────────────────────────────────────────────────────────────────────────
const findClientCandidates = async ({ email, phone, firstname, lastname }, defaultCountry = null) => {
	const p = configDatabase.prefix;
	const cleanEmail = (email || "").trim().toLowerCase();
	const ph = normalizePhone(phone, defaultCountry); // { e164, normalized } | null
	const e164 = ph ? ph.e164 : null;
	const fname = (firstname || "").trim();
	const lname = (lastname || "").trim();

	// Немає жодного сигналу — нема кого шукати
	if (!cleanEmail && !e164 && !(fname && lname)) return [];

	// Збираємо OR-умови під кожен наявний сигнал
	const conds = [];
	const params = [];
	if (cleanEmail) {
		conds.push("LOWER(c.email) = ?");
		params.push(cleanEmail);
	}
	if (e164) {
		conds.push("c.phone = ?");
		params.push(e164);
	}
	if (fname && lname) {
		conds.push("(c.firstname = ? AND c.lastname = ?)");
		params.push(fname, lname);
	}

	const [rows] = await connection_pool.query(
		`SELECT c.id, c.firstname, c.lastname, c.display_name, c.email, c.phone,
            c.company, c.type, c.is_vip, c.reward_points, c.balance, c.balance_currency,
            c.orders_count, c.total_spent, c.id_default_group,
            g.name AS group_name
     FROM \`${p}orders_clients\` c
     LEFT JOIN \`${p}orders_clients_groups\` g ON g.id = c.id_default_group
     WHERE c.deleted_at IS NULL AND (${conds.join(" OR ")})
     LIMIT 20`,
		params
	);

	// Скоринг + причини збігу
	return rows
		.map((c) => {
			let score = 0;
			const reasons = [];
			const emailMatch = cleanEmail && (c.email || "").toLowerCase() === cleanEmail;
			const phoneMatch = e164 && c.phone === e164;
			const nameMatch = fname && lname && c.firstname === fname && c.lastname === lname;

			if (emailMatch) {
				score += 50;
				reasons.push("email");
			}
			if (phoneMatch) {
				score += ph.normalized ? 50 : 30;
				reasons.push("phone");
			}
			if (nameMatch) {
				score += 30;
				reasons.push("name");
			}

			let confidence = "low";
			if (score >= 90) confidence = "high";
			else if (score >= 50) confidence = "medium";

			return { ...c, score, confidence, reasons };
		})
		.sort((a, b) => b.score - a.score);
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

// Сторінка клієнтів у розрізі замовлень
router.get("/orders/clients/", authorizationControllers.isAuthenticated, (req, res) => {
	res.render("pages/orders/clients", {
		i18n: req,
		user: req.user,
		header: { navbar: "orders" },
	});
});

// Сторінка налаштувань замовлень
router.get("/orders/settings/", authorizationControllers.isAuthenticated, (req, res) => {
	res.render("pages/orders/settings", {
		i18n: req,
		user: req.user,
		header: { navbar: "orders" },
	});
});

// ─────────────────────────────────────────────────────────────────────────
// Сторінка замовлення — ЯДРО тягнемо серверно (сторінка одразу з даними),
// важкі списки підвантажує фронт ліниво зі спінером.
// ─────────────────────────────────────────────────────────────────────────
router.get("/orders/:id([0-9]+)/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).send("Невірний ID замовлення.");

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
              opl.text AS payment_name
       FROM \`${configDatabase.prefix}orders\` o
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

		if (!orderRows.length) return res.status(404).send("Замовлення не знайдено.");
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

		res.render("pages/orders/page", {
			i18n: req,
			user: req.user,
			header: { navbar: "orders" },
			order, // client / custom_fields вже розпарсені драйвером як обʼєкти
			statuses, // для випадайки зміни статусу
			addresses, // billing / shipping
		});
	} catch (error) {
		logging.error(error);
		return res.status(500).send("Помилка сервера.");
	}
});

// Сторінка конкретного клієнта
router.get("/orders/clients/:id([0-9]+)/", authorizationControllers.isAuthenticated, (req, res) => {
	res.render("pages/orders/clients/page", {
		i18n: req,
		user: req.user,
		header: { navbar: "orders" },
	});
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
		return res.status(500).json({ message: "Помилка сервера." });
	}
});
// END Список статусів

// Отримання одного статусу замовлення (для модалки редагування)
router.post("/api/orders/statuses/get/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.body.id, 10);
	if (!id) return res.status(400).json({ message: "Невірний ID." });

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
			return res.status(404).json({ message: "Статус не знайдено." });
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
		return res.status(500).json({ message: "Помилка сервера." });
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
			errors: [{ field: "count_in_revenue", msg: "Негативний статус не може враховуватись у виручці." }],
		});
	}

	// 2. Кожна прислана мова має бути заповнена
	const emptyLangs = Object.entries(names)
		.filter(([, text]) => !text || text.trim().length === 0)
		.map(([id_lang]) => parseInt(id_lang, 10));

	if (emptyLangs.length > 0) {
		return res.status(400).json({
			status: "error",
			errors: emptyLangs.map((id_lang) => ({ field: "names", id_lang, msg: "Заповніть назву." })),
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
		return res.status(500).json({ message: "Помилка сервера." });
	} finally {
		conn.release();
	}
});
// END Додавання статусу

// Оновлення статусу замовлення
router.post("/api/orders/statuses/update/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.body.id, 10);
	if (!id) return res.status(400).json({ message: "Невірний ID." });

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
			errors: emptyLangs.map((id_lang) => ({ field: "names", id_lang, msg: "Заповніть назву." })),
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
				errors: [{ field: "count_in_revenue", msg: "Негативний статус не може враховуватись у виручці." }],
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
		return res.status(500).json({ message: "Помилка сервера." });
	} finally {
		conn.release();
	}
});
// END Оновлення статусу

// М'яке видалення замовлення (soft delete)
router.post("/api/orders/delete/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.body.id, 10);
	if (!id || isNaN(id)) {
		return res.status(400).json({ message: "Невірний ID замовлення." });
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
			return res.status(404).json({ message: "Замовлення не знайдено або вже видалене." });
		}

		const order = rows[0];

		// 2. М'яке видалення
		await conn.query(
			`UPDATE \`${configDatabase.prefix}orders\`
       SET deleted_at = NOW(), date_edit = NOW()
       WHERE id = ?`,
			[id]
		);

		// 3. Логуємо подію
		await conn.query(
			`INSERT INTO \`${configDatabase.prefix}orders_events\`
       (id_order, id_user, type, payload, source, date_add)
       VALUES (?, ?, ?, ?, ?, NOW())`,
			[id, req.user?.id || null, "deleted", JSON.stringify({ reason: "soft_delete", deleted_at: new Date().toISOString() }), "manual"]
		);

		// 4. Оновлюємо агрегати клієнта ПОВНІСТЮ (перерахунок)
		if (order.id_client && order.id_client > 0) {
			await conn.query(
				`UPDATE \`${configDatabase.prefix}orders_clients\` c
         SET
           orders_count = (
             SELECT COUNT(*)
             FROM \`${configDatabase.prefix}orders\` o
             WHERE o.id_client = c.id AND o.deleted_at IS NULL
           ),
           orders_valid_count = (
             SELECT COUNT(*)
             FROM \`${configDatabase.prefix}orders\` o
             JOIN \`${configDatabase.prefix}orders_status\` s ON s.id = o.status
             WHERE o.id_client = c.id AND o.deleted_at IS NULL AND s.count_in_revenue = 1
           ),
           total_spent = COALESCE((
             SELECT SUM(o.total_base)
             FROM \`${configDatabase.prefix}orders\` o
             JOIN \`${configDatabase.prefix}orders_status\` s ON s.id = o.status
             WHERE o.id_client = c.id AND o.deleted_at IS NULL AND s.count_in_revenue = 1
           ), 0),
           avg_order_value = CASE
             WHEN orders_count > 0 THEN total_spent / orders_count
             ELSE 0
           END,
           first_order_at = (
             SELECT MIN(o.date_order)
             FROM \`${configDatabase.prefix}orders\` o
             WHERE o.id_client = c.id AND o.deleted_at IS NULL
           ),
           last_order_at = (
             SELECT MAX(o.date_order)
             FROM \`${configDatabase.prefix}orders\` o
             WHERE o.id_client = c.id AND o.deleted_at IS NULL
           ),
           date_edit = NOW()
         WHERE c.id = ?`,
				[order.id_client]
			);
		}

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
				message: "Замовлення видалено, але статистику не вдалося оновити. Перерахуйте її вручну.",
				id: id,
			});
		}

		return res.status(200).json({
			status: "success",
			message: "Замовлення видалено (soft delete), статистику перераховано.",
			id: id,
		});
	} catch (error) {
		await conn.rollback();
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера при видаленні замовлення." });
	} finally {
		conn.release();
	}
});

// Видалення статусу замовлення (основний запис + назви)
router.post("/api/orders/statuses/delete/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.body.id, 10);
	if (!id) return res.status(400).json({ message: "Невірний ID." });

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
				message: `Статус використовують ${used.cnt} замовлень. Спочатку переведіть їх в інший статус.`,
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
		return res.status(500).json({ message: "Помилка сервера." });
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

	try {
		const [rows] = await connection_pool.query(
			`SELECT
          o.id, o.id_integration, o.source_channel, o.reference, o.external_number,
          o.total, o.currency_iso, o.financial_status, o.fulfillment_status,
          o.is_paid, o.is_shipped, o.is_canceled, o.id_client,
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
          opl.text AS payment_name
       FROM \`${p}orders\` o
       LEFT JOIN \`${p}orders_integrations\` i ON i.id = o.id_integration
       LEFT JOIN \`${p}orders_currency\` oc ON oc.id = o.currency
       LEFT JOIN \`${p}orders_status\` os ON os.id = o.status
       LEFT JOIN \`${p}orders_status_lang\` osl ON osl.id_status = os.id AND osl.id_lang = ?
       LEFT JOIN \`${p}orders_delivery\` od ON od.id = o.delivery
       LEFT JOIN \`${p}orders_delivery_lang\` odl ON odl.id_delivery = od.id AND odl.id_lang = ?
       LEFT JOIN \`${p}orders_payment\` op ON op.id = o.payment
       LEFT JOIN \`${p}orders_payment_lang\` opl ON opl.id_payment = op.id AND opl.id_lang = ?
       WHERE ${where.join(" AND ")}
       ORDER BY o.id DESC`,
			params
		);

		const result = rows.map((row) => ({
			id: row.id,
			id_integration: row.id_integration,
			integration_name: row.integration_name,
			integration_color_text: row.integration_color_text,
			integration_color_background: row.integration_color_background,
			source_channel: row.source_channel,
			reference: row.reference,
			external_number: row.external_number,
			total: Number(row.total).toFixed(2),
			currency_iso: row.currency_iso,
			currency_iso_code: row.currency_iso_code,
			financial_status: row.financial_status,
			fulfillment_status: row.fulfillment_status,
			is_paid: row.is_paid,
			is_shipped: row.is_shipped,
			is_canceled: row.is_canceled,
			id_client: row.id_client,
			status_name: row.status_name,
			status_color_text: row.status_color_text,
			status_color_background: row.status_color_background,
			status_icon: row.status_icon,
			delivery_name: row.delivery_name,
			delivery_color_text: row.delivery_color_text,
			delivery_color_background: row.delivery_color_background,
			payment_name: row.payment_name,
			payment_color_text: row.payment_color_text,
			payment_color_background: row.payment_color_background,
			date_add: formatDate(row.date_add),
			date_edit: formatDate(row.date_edit),
		}));

		return res.status(200).json(result);
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});
// END Отримання списку замовлень

// Довідники для панелі фільтрів списку замовлень
router.post("/api/orders/list-filters/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id_lang = req.user.id_lang;
	const p = configDatabase.prefix;
	try {
		const [statuses, currencies, channels] = await Promise.all([
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
		]);

		return res.status(200).json({
			statuses,
			currencies,
			channels,
			financial_statuses: ["pending", "authorized", "paid", "partially_paid", "partially_refunded", "refunded", "voided"],
			fulfillment_statuses: ["unfulfilled", "partial", "fulfilled", "returned"],
		});
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});
// END Довідники фільтрів

// Список товарів конкретного замовлення (читає з нормалізованої orders_items)
router.post("/orders/:id_order/products-list/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id_order = parseInt(req.params.id_order, 10);
	if (!id_order) return res.status(400).json({ message: "Невірний ID." });

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
		return res.status(500).json({ message: "Помилка сервера." });
	}
});
// END Товари замовлення

// Дані клієнта конкретного замовлення:
// — снапшот (client JSON) віддаємо завжди;
// — якщо прив'язаний → жива картка клієнта;
// — якщо ні → одразу кандидати-збіги по снапшоту (авто-suggest).
router.post("/orders/:id_order/client/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id_order = parseInt(req.params.id_order, 10);
	if (!id_order) return res.status(400).json({ message: "Невірний ID." });
	const p = configDatabase.prefix;

	try {
		const [rows] = await connection_pool.query(`SELECT id_client, client FROM \`${p}orders\` WHERE id = ? LIMIT 1`, [id_order]);
		if (!rows.length) return res.status(404).json({ message: "Замовлення не знайдено." });

		const snapshot = rows[0].client || {};
		const id_client = rows[0].id_client;

		// Прив'язаний клієнт → жива картка
		if (id_client) {
			const [[client]] = await connection_pool.query(
				`SELECT c.id, c.display_name, c.firstname, c.lastname, c.email, c.phone, c.company,
                c.type, c.is_vip, c.reward_points, c.balance, c.balance_currency,
                c.orders_count, c.total_spent, c.id_default_group, g.name AS group_name
         FROM \`${p}orders_clients\` c
         LEFT JOIN \`${p}orders_clients_groups\` g ON g.id = c.id_default_group
         WHERE c.id = ? AND c.deleted_at IS NULL LIMIT 1`,
				[id_client]
			);

			// Клієнта могли видалити — тоді трактуємо як непривʼязане
			if (client) {
				return res.status(200).json({ linked: true, snapshot, client });
			}
		}

		// Не прив'язаний → шукаємо кандидатів по снапшоту.
		// Країну для нормалізації телефону беремо з адреси доставки замовлення.
		const [[addr]] = await connection_pool.query(
			`SELECT country FROM \`${p}orders_addresses\`
       WHERE id_order = ? ORDER BY (type='shipping') DESC LIMIT 1`,
			[id_order]
		);

		const candidates = await findClientCandidates(
			{
				email: snapshot.email,
				phone: snapshot.phone,
				firstname: snapshot.firstname,
				lastname: snapshot.lastname,
			},
			addr ? addr.country : null
		);

		return res.status(200).json({ linked: false, snapshot, candidates });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
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
	if (!id_order || !id_client) return res.status(400).json({ message: "Невірні дані." });

	const p = configDatabase.prefix;
	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		const [[order]] = await conn.query(`SELECT id_client FROM \`${p}orders\` WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`, [id_order]);
		if (!order) {
			await conn.rollback();
			return res.status(404).json({ message: "Замовлення не знайдено." });
		}

		const [[client]] = await conn.query(`SELECT id FROM \`${p}orders_clients\` WHERE id = ? AND deleted_at IS NULL LIMIT 1`, [id_client]);
		if (!client) {
			await conn.rollback();
			return res.status(404).json({ message: "Клієнта не знайдено." });
		}

		const prev_client = order.id_client; // могло бути прив'язано до іншого

		await conn.query(`UPDATE \`${p}orders\` SET id_client = ?, date_edit = NOW() WHERE id = ?`, [id_client, id_order]);

		// Перерахунок кешу: нового клієнта — завжди; попереднього — якщо був і інший
		await recalcClientStats(conn, id_client);
		if (prev_client && prev_client !== id_client) await recalcClientStats(conn, prev_client);

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
		return res.status(500).json({ message: "Помилка сервера." });
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
	if (!id_order) return res.status(400).json({ message: "Невірний ID." });

	const p = configDatabase.prefix;
	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		const [[order]] = await conn.query(`SELECT id_client FROM \`${p}orders\` WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`, [id_order]);
		if (!order) {
			await conn.rollback();
			return res.status(404).json({ message: "Замовлення не знайдено." });
		}

		const prev_client = order.id_client;
		if (!prev_client) {
			await conn.rollback();
			return res.status(400).json({ message: "Клієнта не привʼязано." });
		}

		await conn.query(`UPDATE \`${p}orders\` SET id_client = 0, date_edit = NOW() WHERE id = ?`, [id_order]);
		await recalcClientStats(conn, prev_client);

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
		return res.status(500).json({ message: "Помилка сервера." });
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
	if (!id_order) return res.status(400).json({ message: "Невірний ID." });

	const p = configDatabase.prefix;
	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		const [[order]] = await conn.query(`SELECT id_client, client FROM \`${p}orders\` WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`, [id_order]);
		if (!order) {
			await conn.rollback();
			return res.status(404).json({ message: "Замовлення не знайдено." });
		}
		if (order.id_client) {
			await conn.rollback();
			return res.status(400).json({ message: "Клієнта вже привʼязано." });
		}

		const snap = order.client || {};

		// Країна з адреси — для нормалізації телефону
		const [[addr]] = await conn.query(`SELECT country FROM \`${p}orders_addresses\` WHERE id_order = ? ORDER BY (type='shipping') DESC LIMIT 1`, [id_order]);
		const ph = normalizePhone(snap.phone, addr ? addr.country : null);
		const e164 = ph ? ph.e164 : null;
		const cleanEmail = (snap.email || "").trim().toLowerCase() || null;

		// Перевірка на дубль перед створенням (щоб не плодити клієнтів)
		if (cleanEmail || e164) {
			const dupConds = [];
			const dupParams = [];
			if (cleanEmail) {
				dupConds.push("LOWER(email) = ?");
				dupParams.push(cleanEmail);
			}
			if (e164) {
				dupConds.push("phone = ?");
				dupParams.push(e164);
			}
			const [dups] = await conn.query(
				`SELECT id, display_name, email, phone FROM \`${p}orders_clients\`
         WHERE deleted_at IS NULL AND (${dupConds.join(" OR ")}) LIMIT 5`,
				dupParams
			);
			if (dups.length) {
				await conn.rollback();
				return res.status(409).json({ message: "Клієнт із таким контактом уже існує.", candidates: dups });
			}
		}

		const display = [snap.firstname, snap.lastname].filter(Boolean).join(" ") || cleanEmail || e164 || "Без імені";
		const defaultGroup = snap.company ? 1 : 1; // поки роздріб; групу змінять вручну

		const [ins] = await conn.query(
			`INSERT INTO \`${p}orders_clients\`
        (source_channel, firstname, lastname, display_name, email, phone,
         is_company, company, vat_number, id_default_group, type,
         date_add, date_edit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'customer', NOW(), NOW())`,
			["manual", snap.firstname || null, snap.lastname || null, display, cleanEmail, e164, snap.company ? 1 : 0, snap.company || null, snap.vat || null, defaultGroup]
		);
		const id_client = ins.insertId;

		// Прив'язка + перерахунок + подія
		await conn.query(`UPDATE \`${p}orders\` SET id_client = ?, date_edit = NOW() WHERE id = ?`, [id_client, id_order]);
		await recalcClientStats(conn, id_client);
		await conn.query(
			`INSERT INTO \`${p}orders_events\` (id_order, id_user, type, payload, source, date_add)
       VALUES (?, ?, 'client_created', ?, 'manual', NOW())`,
			[id_order, req.user.id, JSON.stringify({ id_client })]
		);

		await conn.commit();
		return res.status(200).json({ status: "success", id_client });
	} catch (error) {
		await conn.rollback();
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
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
	const q = (req.body.q || "").toString().trim();
	if (q.length < 2) return res.status(200).json([]); // короткий запит — не шукаємо
	const p = configDatabase.prefix;

	try {
		const like = `%${q}%`;
		// Якщо схоже на телефон — пробуємо ще й нормалізований варіант
		const ph = normalizePhone(q);
		const phoneExact = ph ? ph.e164 : null;

		const [rows] = await connection_pool.query(
			`SELECT c.id, c.display_name, c.firstname, c.lastname, c.email, c.phone, c.company,
              c.type, c.is_vip, c.reward_points, c.orders_count, c.total_spent,
              g.name AS group_name
       FROM \`${p}orders_clients\` c
       LEFT JOIN \`${p}orders_clients_groups\` g ON g.id = c.id_default_group
       WHERE c.deleted_at IS NULL AND (
             c.display_name LIKE ? OR c.firstname LIKE ? OR c.lastname LIKE ?
          OR c.email LIKE ? OR c.phone LIKE ? OR c.company LIKE ?
          OR (? IS NOT NULL AND c.phone = ?)
       )
       ORDER BY c.last_order_at DESC
       LIMIT 20`,
			[like, like, like, like, like, like, phoneExact, phoneExact]
		);

		return res.status(200).json(rows);
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});
// END Ручний пошук клієнта

// ─────────────────────────────────────────────────────────────────────────
// POST — API: НАЛАШТУВАННЯ / ТОКЕНИ
// ─────────────────────────────────────────────────────────────────────────

// Список IP конкретного токена налаштувань
// (раніше тут була помилкова копія products-list з неіснуючим req.params.id_order)
router.post("/api/orders/settings/token/:id_token/ip-list/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id_token = parseInt(req.params.id_token, 10);
	if (!id_token) return res.status(400).json({ message: "Невірний ID токена." });

	try {
		const [rows] = await connection_pool.query(`SELECT ip_list FROM \`${configDatabase.prefix}orders_settings_tokens\` WHERE id = ? LIMIT 1`, [id_token]);

		if (!rows.length) return res.status(404).json({ message: "Токен не знайдено." });

		// ip_list — колонка типу JSON, драйвер уже повертає її розпарсеною.
		return res.status(200).json(rows[0].ip_list);
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});
// END Список IP токена

// Генерація унікального токена для налаштувань замовлень
// (виправлено URL: було "gemerator" → стало "generator")
router.post("/api/orders/settings/token/generator/", authorizationControllers.isAuthenticated, async (req, res) => {
	const generateToken = () => crypto.randomBytes(16).toString("hex").toLowerCase();

	try {
		let token;
		let isUnique = false;

		// Генеруємо, доки не отримаємо унікальний (без рекурсії — простий цикл)
		while (!isUnique) {
			token = generateToken();
			const [rows] = await connection_pool.query(`SELECT COUNT(*) AS count FROM \`${configDatabase.prefix}orders_settings_tokens\` WHERE token = ?`, [token]);
			isUnique = rows[0].count === 0;
		}

		return res.status(200).json({ token });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});
// END Генерація токена

// ─────────────────────────────────────────────────────────────────────────
// Деталі замовлення (ліниво): товари+суми, оплати, відправлення, повернення,
// документи, збори — одним запитом, щоб показати зі спінером після відкриття.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/:id/details/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ message: "Невірний ID." });

	const p = configDatabase.prefix;
	try {
		const [items, totals, payments, shipments, refunds, documents, fees] = await Promise.all([connection_pool.query(`SELECT * FROM \`${p}orders_items\` WHERE id_order = ? ORDER BY id ASC`, [id]).then(([r]) => r), connection_pool.query(`SELECT * FROM \`${p}orders_totals\` WHERE id_order = ? ORDER BY sort_order ASC`, [id]).then(([r]) => r), connection_pool.query(`SELECT * FROM \`${p}orders_payments\` WHERE id_order = ? ORDER BY id ASC`, [id]).then(([r]) => r), connection_pool.query(`SELECT * FROM \`${p}orders_shipments\` WHERE id_order = ? ORDER BY id ASC`, [id]).then(([r]) => r), connection_pool.query(`SELECT * FROM \`${p}orders_refunds\` WHERE id_order = ? ORDER BY id ASC`, [id]).then(([r]) => r), connection_pool.query(`SELECT * FROM \`${p}orders_documents\` WHERE id_order = ? ORDER BY id ASC`, [id]).then(([r]) => r), connection_pool.query(`SELECT * FROM \`${p}orders_fees\` WHERE id_order = ? ORDER BY id ASC`, [id]).then(([r]) => r)]);
		return res.status(200).json({ items, totals, payments, shipments, refunds, documents, fees });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
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
	if (!id || !id_status) return res.status(400).json({ message: "Невірні дані." });

	const p = configDatabase.prefix;
	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		// Блокуємо рядок замовлення на час транзакції
		const [[order]] = await conn.query(`SELECT status FROM \`${p}orders\` WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`, [id]);
		if (!order) {
			await conn.rollback();
			return res.status(404).json({ message: "Замовлення не знайдено." });
		}

		// Прапорці нового статусу (щоб синхронізувати is_paid/is_shipped)
		let flags;
		try {
			flags = await deriveOrderFlags(id_status);
		} catch {
			await conn.rollback();
			return res.status(400).json({ message: "Статус не існує." });
		}

		const id_status_old = order.status;

		await conn.query(
			`UPDATE \`${p}orders\`
       SET status = ?, is_paid = ?, is_shipped = ?, is_canceled = ?, date_edit = NOW()
       WHERE id = ?`,
			[id_status, flags.is_paid, flags.is_shipped, flags.is_canceled, id]
		);

		// Історія статусів (детальна: старий → новий, хто, коментар, чи повідомляли)
		await conn.query(
			`INSERT INTO \`${p}orders_status_history\`
        (id_order, id_status, id_status_old, id_user, source, comment, notified, date_add)
       VALUES (?, ?, ?, ?, 'manual', ?, ?, NOW())`,
			[id, id_status, id_status_old, req.user.id, comment, notify]
		);

		// Журнал подій (широкий аудит)
		await conn.query(
			`INSERT INTO \`${p}orders_events\`
        (id_order, id_user, type, payload, source, date_add)
       VALUES (?, ?, 'status_change', ?, 'manual', NOW())`,
			[id, req.user.id, JSON.stringify({ before: id_status_old, after: id_status, comment, notify })]
		);

		// CRM→сайт: ручна зміна статусу → у чергу вихідних (origin=crm)
		await emitToOutbox(conn, {
			id_order: id,
			event_type: "status_change",
			data: { id_status, id_status_old, comment: comment || null },
		});

		await conn.commit();

		kickOutbox();

		// TODO(next): якщо notify — поставити email клієнту в чергу
		// TODO(next): io.emit("order:status", { id, id_status }) — realtime

		return res.status(200).json({ status: "success", id_status, id_status_old });
	} catch (error) {
		await conn.rollback();
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	} finally {
		conn.release();
	}
});

// ─────────────────────────────────────────────────────────────────────────
// Історія статусів (для таба) — старий→новий, хто, коментар, повідомлення.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/:id/history/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ message: "Невірний ID." });
	const id_lang = req.user.id_lang;
	const p = configDatabase.prefix;

	try {
		const [rows] = await connection_pool.query(
			`SELECT h.id, h.id_status, h.id_status_old, h.source, h.comment, h.notified, h.date_add, h.id_user,
              snew.text AS status_name,
              sold.text AS status_old_name
       FROM \`${p}orders_status_history\` h
       LEFT JOIN \`${p}orders_status_lang\` snew ON snew.id_status = h.id_status AND snew.id_lang = ?
       LEFT JOIN \`${p}orders_status_lang\` sold ON sold.id_status = h.id_status_old AND sold.id_lang = ?
       WHERE h.id_order = ?
       ORDER BY h.id DESC`,
			[id_lang, id_lang, id]
		);
		return res.status(200).json(rows.map((r) => ({ ...r, date_add: formatDate(r.date_add) })));
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});

// ─────────────────────────────────────────────────────────────────────────
// Журнал подій (для таба) — усі події замовлення.
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/:id/events/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ message: "Невірний ID." });
	const p = configDatabase.prefix;
	try {
		const [rows] = await connection_pool.query(
			`SELECT id, id_user, type, payload, source, date_add
       FROM \`${p}orders_events\` WHERE id_order = ? ORDER BY id DESC`,
			[id]
		);
		return res.status(200).json(rows.map((r) => ({ ...r, date_add: formatDate(r.date_add) })));
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});

// ─────────────────────────────────────────────────────────────────────────
// Сирий payload від джерела (для таба Raw).
// ─────────────────────────────────────────────────────────────────────────
router.post("/api/orders/:id/raw/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ message: "Невірний ID." });
	const p = configDatabase.prefix;
	try {
		const [rows] = await connection_pool.query(`SELECT payload, received_at FROM \`${p}orders_raw\` WHERE id_order = ? LIMIT 1`, [id]);
		if (!rows.length) return res.status(200).json({ payload: null });
		return res.status(200).json({ payload: rows[0].payload, received_at: formatDate(rows[0].received_at) });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: "Помилка сервера." });
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

	try {
		// Прокидаємо скоуп у payload, щоб воркер знав, чи можна створювати клієнтів
		const bodyToQueue = { ...body, __can_create_clients: token.can_create_clients === 1 ? 1 : 0 };

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
			await logAttempt({
				id_token: token.id,
				prefix: req.orderTokenPrefix,
				ip: req.clientIp,
				domain: req.sourceHost,
				endpoint: req.originalUrl,
				result: "success",
				http_status: 200,
				external_id,
				message: "duplicate — already queued",
			});
			return res.status(200).json({ status: "duplicate", message: "Замовлення вже прийнято." });
		}
		logging.error(error);
		return res.status(500).json({ status: "error", message: "Помилка сервера." });
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
		return res.status(400).json({ status: "error", message: "Токен не прив'язаний до інтеграції." });
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
		return res.status(500).json({ status: "error", message: "Помилка сервера." });
	}
});
// END Прийом швидких замовлень

// POST /api/orders/statuses/pull/ — віддає список статусів CRM для звʼязування
// на боці CMS (OpenCart). Захищено токеном зі скоупом can_read.
// Мову можна передати в body.id_lang; дефолт — 2 (uk).
router.post("/api/orders/statuses/pull/", verifyOrderToken("can_read"), async (req, res) => {
	const P = configDatabase.prefix;
	const token = req.orderToken;
	const id_lang = parseInt(req.body?.id_lang, 10) || 2;

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
		return res.status(500).json({ status: "error", message: "Помилка сервера." });
	}
});
// END Віддача статусів для CMS

const { findMatchTx, createClientTx, normalizePhone: normPhone } = require("../../controllers/orders/clientMatch");

// POST /api/clients/receive/ — приймає одного клієнта з CMS (для синку бази клієнтів).
// Дедуплікація: external_id → email → phone. Скоуп can_create_clients.
router.post("/api/clients/receive/", verifyOrderToken("can_create_clients"), async (req, res) => {
	const P = configDatabase.prefix;
	const token = req.orderToken;
	const c = req.body?.client || req.body || {};
	const id_integration = token.id_integration || null;
	const externalId = c.external_client_id || c.external_id || null;

	if (!c.email && !c.phone && !externalId) {
		return res.status(422).json({ status: "error", reason: "bad_payload", message: "Потрібен email, phone або external_id." });
	}

	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		const match = await findMatchTx(conn, {
			email: c.email,
			phone: c.phone,
			id_integration,
			externalId,
			defaultCountry: c.country || null,
		});

		if (match) {
			// Оновлюємо контакти й проставляємо external_id, якщо його бракувало
			const ph = normPhone(c.phone, c.country || null);
			await conn.query(
				`UPDATE \`${P}orders_clients\`
         SET external_id = COALESCE(external_id, ?), id_integration = COALESCE(id_integration, ?),
             email = COALESCE(email, ?), phone = COALESCE(phone, ?), date_edit = NOW()
         WHERE id = ?`,
				[externalId != null ? String(externalId) : null, id_integration, (c.email || "").trim().toLowerCase() || null, ph ? ph.e164 : null, match.id]
			);
			await conn.commit();
			return res.status(200).json({ status: "matched", id_client: match.id, matched_by: match.matched_by });
		}

		const id_client = await createClientTx(conn, {
			snapshot: c,
			address: c.address || null,
			id_integration,
			externalId,
			sourceChannel: c.source_channel || "web",
			defaultCountry: c.country || null,
		});
		await conn.commit();
		return res.status(201).json({ status: "created", id_client });
	} catch (error) {
		await conn.rollback();
		if (error && error.code === "ER_DUP_ENTRY") {
			return res.status(200).json({ status: "duplicate", message: "Клієнт уже існує." });
		}
		logging.error(error);
		return res.status(500).json({ status: "error", message: "Помилка сервера." });
	} finally {
		conn.release();
	}
});
// END Синк клієнта

// END POST

module.exports = router;
