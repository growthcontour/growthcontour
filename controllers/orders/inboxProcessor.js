const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
const logging = require("../../logging/logging");
const crypto = require("crypto");

const { findMatchTx, createClientTx, recalcClientStats } = require("./clientMatch");
const { resolveRate, toBase, BASE_CURRENCY } = require("./currency");
const { deriveOrderFlags } = require("./statusFlags");

const P = configDatabase.prefix;

// Дефолти — узгодь зі своїми довідниками
const DEFAULT_STATUS_ID = 1;
const DEFAULT_DELIVERY_ID = 1;
const DEFAULT_PAYMENT_ID = 1;
const DEFAULT_LANG_ID = 2;
const MAX_ATTEMPTS = 5;
const BATCH = 10;
const STALE_MIN = 10;
const RETRY_DELAY_MS = 15000;

const FINANCIAL = ["pending", "authorized", "paid", "partially_paid", "partially_refunded", "refunded", "voided"];
const FULFILLMENT = ["unfulfilled", "partial", "fulfilled", "returned"];
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const toDbDateTime = (v) => {
	if (!v) return null;
	const d = new Date(v);
	return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace("T", " ");
};

// Збірка похідних значень із конверта (спільна для create та update)
const deriveOrderValues = (body) => {
	const items = Array.isArray(body.items) ? body.items : [];
	const itemsSum = round4(items.reduce((s, it) => s + (Number(it.total) || 0), 0));
	const sum = body.summary || {};
	const total_products = round4(sum.total_products != null ? sum.total_products : itemsSum);
	const total = round4(sum.total != null ? sum.total : total_products);

	const financial_status = FINANCIAL.includes(body.status?.financial_status) ? body.status.financial_status : "pending";
	const fulfillment_status = FULFILLMENT.includes(body.status?.fulfillment_status) ? body.status.fulfillment_status : "unfulfilled";

	const custom_fields = {
		...(body.custom_fields && typeof body.custom_fields === "object" ? body.custom_fields : {}),
		_payment_method: body.payment?.method_title || body.payment?.method_code || null,
		_delivery_method: body.delivery?.method_title || body.delivery?.method_code || null,
	};

	return {
		items,
		itemsSum,
		sum,
		total_products,
		total,
		financial_status,
		fulfillment_status,
		custom_fields,
		total_discount: round4(sum.total_discount),
		total_shipping: round4(sum.total_shipping),
		total_wrapping: round4(sum.total_wrapping),
		total_tax: round4(sum.total_tax),
		total_tips: round4(sum.total_tips),
		total_paid: round4(sum.total_paid),
	};
};

// Хеш стану джерела для echo-захисту: враховує лише те, чим володіє джерело
const computeSyncHash = (body) => {
	const v = deriveOrderValues(body);
	const shape = {
		items: (v.items || []).map((it) => ({
			p: it.external_product_id,
			s: it.sku,
			q: Number(it.quantity) || 0,
			u: round4(it.unit_price),
			t: round4(it.total),
		})),
		fin: v.financial_status,
		ful: v.fulfillment_status,
		ext_status: body.status?.external_status ?? null,
		totals: { p: v.total_products, d: v.total_discount, s: v.total_shipping, t: v.total, paid: v.total_paid },
		addr: (Array.isArray(body.addresses) ? body.addresses : []).map((a) => ({
			ty: a.type,
			c: a.city,
			w: a.warehouse,
			a1: a.address_1,
			ph: a.phone,
		})),
		note: body.note || null,
	};
	return crypto.createHash("sha256").update(JSON.stringify(shape)).digest("hex");
};

// Резолв сирого статусу джерела → id_status CRM через orders_status_map
const resolveStatusId = async (conn, id_integration, externalStatus) => {
	if (externalStatus == null || externalStatus === "") return null;
	const [[row]] = await conn.query(
		`SELECT id_status FROM \`${P}orders_status_map\`
     WHERE external_status = ? AND direction IN ('in','both')
       AND (id_integration <=> ? OR id_integration IS NULL)
     ORDER BY (id_integration IS NOT NULL) DESC LIMIT 1`,
		[String(externalStatus), id_integration]
	);
	return row ? row.id_status : null;
};

// Вставка дочірніх рядків замовлення (items, totals, addresses).
// Використовується і при створенні, і при оновленні (після очистки старих).
const insertOrderChildren = async (conn, orderId, body, rate = 1) => {
	const items = Array.isArray(body.items) ? body.items : [];
	for (const it of items) {
		await conn.query(
			`INSERT INTO \`${P}orders_items\`
        (id_order, external_product_id, sku, name, type, quantity,
         unit_price, unit_price_wt, discount, tax_rate, total, total_base, attributes, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[orderId, it.external_product_id != null ? String(it.external_product_id) : null, it.sku || null, it.name || "—", it.type || "product", Number(it.quantity) || 0, round4(it.unit_price), round4(it.unit_price_wt != null ? it.unit_price_wt : it.unit_price), round4(it.discount), Number(it.tax_rate) || 0, round4(it.total), toBase(it.total, rate), it.attributes && typeof it.attributes === "object" ? JSON.stringify(it.attributes) : null, it.meta && typeof it.meta === "object" ? JSON.stringify(it.meta) : null]
		);
	}

	let so = 1;
	for (const t of Array.isArray(body.totals) ? body.totals : []) {
		await conn.query(`INSERT INTO \`${P}orders_totals\` (id_order, code, title, value, sort_order) VALUES (?, ?, ?, ?, ?)`, [orderId, (t.code || "").slice(0, 32), (t.title || "").slice(0, 255), round4(t.value), t.sort_order != null ? t.sort_order : so++]);
	}

	for (const a of Array.isArray(body.addresses) ? body.addresses : []) {
		await conn.query(
			`INSERT INTO \`${P}orders_addresses\`
        (id_order, type, firstname, lastname, middlename, company, phone, email,
         country, region, city, city_ref, address_1, address_2, warehouse, warehouse_ref, postcode, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[orderId, a.type === "billing" ? "billing" : "shipping", a.firstname || null, a.lastname || null, a.middlename || null, a.company || null, a.phone || null, a.email || null, a.country || null, a.region || null, a.city || null, a.city_ref || null, a.address_1 || null, a.address_2 || null, a.warehouse || null, a.warehouse_ref || null, a.postcode || null, a.meta && typeof a.meta === "object" ? JSON.stringify(a.meta) : null]
		);
	}

	// Оплати
	for (const p of Array.isArray(body.payments) ? body.payments : []) {
		const st = ["pending", "authorized", "paid", "failed", "refunded", "partially_refunded"].includes(p.status) ? p.status : "pending";
		await conn.query(
			`INSERT INTO \`${P}orders_payments\`
        (id_order, id_payment, transaction_id, amount, currency_iso, status, paid_at, raw, date_add)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NOW())`,
			[orderId, p.transaction_id || null, round4(p.amount), (p.currency_iso || body.currency?.iso || "UAH").toUpperCase().slice(0, 3), st, toDbDateTime(p.paid_at), p.raw && typeof p.raw === "object" ? JSON.stringify(p.raw) : null]
		);
	}

	// Збори / комісії
	for (const f of Array.isArray(body.fees) ? body.fees : []) {
		await conn.query(
			`INSERT INTO \`${P}orders_fees\` (id_order, type, title, amount, date_add)
       VALUES (?, ?, ?, ?, NOW())`,
			[orderId, (f.type || "other").slice(0, 64), f.title || null, round4(f.amount)]
		);
	}

	// Знижки
	for (const d of Array.isArray(body.discounts) ? body.discounts : []) {
		await conn.query(
			`INSERT INTO \`${P}orders_discounts\` (id_order, code, name, type, value, date_add)
       VALUES (?, ?, ?, ?, ?, NOW())`,
			[orderId, d.code || null, d.name || d.title || null, d.type || null, round4(d.value)]
		);
	}
};

// ─── Оновлення існуючого замовлення (upsert-гілка) ────────────────────────
// Оновлює ЛИШЕ те, чим володіє джерело: суми, статуси, note, склад/адреси.
// НЕ чіпає: id_client, снапшот client, нотатки, документи, повернення.
const updateOrderFromPayload = async (conn, orderId, body, ctx) => {
	const { id_integration, external_id, syncHash } = ctx;
	const v = deriveOrderValues(body);

	// 1) Поточний стан (для порівняння статусу й конфліктів)
	const [[cur]] = await conn.query(`SELECT status, external_updated_at FROM \`${P}orders\` WHERE id = ? LIMIT 1`, [orderId]);

	// 2) Резолв статусу джерела → id_status CRM (якщо передано і змаплено)
	let newStatusId = null;
	const externalStatus = body.status?.external_status ?? null;
	if (externalStatus != null) {
		newStatusId = await resolveStatusId(conn, id_integration, externalStatus);
	}

	// 3) Конфлікт статусу: якщо на джерелі зміна старіша за наш останній апдейт —
	//    статус НЕ чіпаємо (last-write-wins за часом джерела).
	const extUpdatedAt = toDbDateTime(body.status?.external_updated_at) || null;
	let applyStatus = newStatusId != null && newStatusId !== cur.status;
	if (applyStatus && extUpdatedAt && cur.external_updated_at) {
		if (new Date(extUpdatedAt) < new Date(cur.external_updated_at)) applyStatus = false;
	}

	// 4) Оновлення ядра — тільки поля джерела; revision++
	const rate = await resolveRate(body.currency?.iso, body.currency?.rate);

	// Прапорці — похідні від СТАТУСУ, а не від financial/fulfillment джерела.
	// Якщо статус не змінюється — беремо похідні від поточного статусу.
	const flags = await deriveOrderFlags(applyStatus ? newStatusId : cur.status);

	await conn.query(
		`UPDATE \`${P}orders\` SET
       financial_status = ?, fulfillment_status = ?,
       is_paid = ?, is_shipped = ?, is_canceled = ?,
       currency_iso = ?, currency_rate = ?, base_currency = ?,
       total_products = ?, total_discount = ?, total_shipping = ?, total_wrapping = ?,
       total_tax = ?, total_tips = ?, total = ?, total_paid = ?,
       total_base = ?, total_paid_base = ?, total_discount_base = ?,
       custom_fields = ?, note = ?,
       ${applyStatus ? "status = ?," : ""}
       sync_hash = ?, external_updated_at = ?, revision = revision + 1, date_edit = NOW()
     WHERE id = ?`,
		[v.financial_status, v.fulfillment_status, flags.is_paid, flags.is_shipped, flags.is_canceled, (body.currency?.iso || BASE_CURRENCY).toUpperCase().slice(0, 3), rate, BASE_CURRENCY, v.total_products, v.total_discount, v.total_shipping, v.total_wrapping, v.total_tax, v.total_tips, v.total, v.total_paid, toBase(v.total, rate), toBase(v.total_paid, rate), toBase(v.total_discount, rate), JSON.stringify(v.custom_fields), body.note || null, ...(applyStatus ? [newStatusId] : []), syncHash, extUpdatedAt, orderId]
	);

	// 5) Історія статусу (лише якщо статус реально змінився)
	if (applyStatus) {
		// Скільки часу замовлення пробуло в попередньому статусі
		const [[prevH]] = await conn.query(
			`SELECT date_add FROM \`${P}orders_status_history\`
        WHERE id_order = ? ORDER BY date_add DESC, id DESC LIMIT 1`,
			[orderId]
		);
		const [[ord]] = await conn.query(`SELECT date_add FROM \`${P}orders\` WHERE id = ? LIMIT 1`, [orderId]);
		const since = prevH ? prevH.date_add : ord ? ord.date_add : null;

		await conn.query(
			`INSERT INTO \`${P}orders_status_history\`
        (id_order, id_status, id_status_old, duration_sec, id_user, source, comment, notified, date_add)
       VALUES (?, ?, ?, ?, NULL, 'webhook', ?, 0, NOW())`,
			[orderId, newStatusId, cur.status, since ? Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000)) : null, `external: ${externalStatus}`]
		);
	}

	// 6) Заміна дочірніх даних джерела: видалити старі → вставити нові
	await conn.query(`DELETE FROM \`${P}orders_items\` WHERE id_order = ?`, [orderId]);
	await conn.query(`DELETE FROM \`${P}orders_totals\` WHERE id_order = ?`, [orderId]);
	await conn.query(`DELETE FROM \`${P}orders_addresses\` WHERE id_order = ?`, [orderId]);
	await conn.query(`DELETE FROM \`${P}orders_payments\` WHERE id_order = ?`, [orderId]);
	await conn.query(`DELETE FROM \`${P}orders_fees\` WHERE id_order = ?`, [orderId]);
	await conn.query(`DELETE FROM \`${P}orders_discounts\` WHERE id_order = ?`, [orderId]);
	await insertOrderChildren(conn, orderId, body, rate);

	// 7) Сирий payload — перезаписуємо останній стан джерела
	await conn.query(
		`INSERT INTO \`${P}orders_raw\` (id_order, payload, received_at) VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE payload = VALUES(payload), received_at = NOW()`,
		[orderId, JSON.stringify(body)]
	);

	// 8) Подія оновлення
	await conn.query(
		`INSERT INTO \`${P}orders_events\` (id_order, id_user, type, payload, source, date_add)
     VALUES (?, NULL, 'updated', ?, 'webhook', NOW())`,
		[
			orderId,
			JSON.stringify({
				via: "webhook",
				external_id,
				status_applied: applyStatus ? newStatusId : null,
				external_status: externalStatus,
			}),
		]
	);

	return orderId;
};

// ─── Створення замовлення з конверта (уся вставка в одній транзакції) ─────
const createOrderFromPayload = async (conn, body) => {
	const src = body.source || {};
	const external_id = String(src.external_id);

	// Пріоритет: те, що поставив воркер із рядка inbox → payload джерела.
	// NULL більше не допускаємо — інакше замовлення випадає з розрізу по сайтах.
	const id_integration = body.__id_integration ?? (src.id_integration ? Number(src.id_integration) : null) ?? null;

	// id_integration = NULL легітимне ЛИШЕ для внутрішніх замовлень CRM (source.channel='contact-center').
	// Для зовнішніх джерел відсутність інтеграції — помилка (замовлення випало б із розрізу по сайтах).
	const isInternal = src.channel === "contact-center";
	if (!id_integration && !isInternal) {
		throw new Error(`Не визначено id_integration для замовлення ${external_id}`);
	}

	const syncHash = computeSyncHash(body);

	const [[exists]] = await conn.query(
		`SELECT id, sync_hash FROM \`${P}orders\`
     WHERE external_id = ? AND id_integration <=> ? AND deleted_at IS NULL
     LIMIT 1 FOR UPDATE`,
		[external_id, id_integration]
	);

	// Замовлення вже існує → оновлення (upsert), а не дубль
	if (exists) {
		// Echo/повтор: стан не змінився з минулого синку — виходимо тихо
		if (exists.sync_hash && exists.sync_hash === syncHash) return exists.id;
		await updateOrderFromPayload(conn, exists.id, body, { id_integration, external_id, syncHash });
		return exists.id;
	}

	const currencyIso = (body.currency?.iso || BASE_CURRENCY).toUpperCase().slice(0, 3);
	const [[cur]] = await conn.query(`SELECT id FROM \`${P}orders_currency\` WHERE currency_iso_code = ? LIMIT 1`, [currencyIso]);
	const currencyId = cur ? cur.id : 1;

	// Курс до базової: сайт часто шле rate=1 для будь-якої валюти — це заглушка,
	// тому підстраховуємось довідником.
	const rate = await resolveRate(currencyIso, body.currency?.rate);

	const c = body.client || {};
	const snapshot = {
		firstname: c.firstname || null,
		lastname: c.lastname || null,
		email: c.email || null,
		phone: c.phone || null,
		company: c.company || null,
		vat: c.vat || null,
	};

	const v = deriveOrderValues(body);
	const { items, itemsSum, financial_status, fulfillment_status, custom_fields, total_products, total } = v;

	// Стартовий статус:
	//   1) custom-інтеграція з заданим default_status_id → завжди він (запит ігнорується);
	//   2) інакше → DEFAULT_STATUS_ID (звичайні інтеграції отримають реальний статус
	//      пізніше через orders_status_map при синхронізації).
	let startStatusId = DEFAULT_STATUS_ID;
	if (id_integration) {
		const [[integ]] = await conn.query(`SELECT platform, default_status_id FROM \`${P}orders_integrations\` WHERE id = ? LIMIT 1`, [id_integration]);
		if (integ && integ.platform === "custom" && integ.default_status_id) {
			startStatusId = integ.default_status_id;
		}
	}
	// Внутрішні замовлення CRM стартують з дефолтного статусу (DEFAULT_STATUS_ID).

	const initFlags = await deriveOrderFlags(startStatusId);

	const [ins] = await conn.query(
		`INSERT INTO \`${P}orders\`
      (id_integration, external_id, external_number, external_cart_id, secure_key,
       reference, source_channel, id_client, client, status,
       financial_status, fulfillment_status, is_paid, is_shipped, is_canceled,
       currency, currency_iso, currency_rate, base_currency, id_lang,
       total_products, total_discount, total_shipping, total_wrapping,
       total_tax, total_tips, total, total_paid, total_refunded, total_fees,
       total_base, total_paid_base, total_refunded_base, total_fees_base, total_discount_base,
       delivery, payment, is_gift, gift_message, custom_fields, note,
       sync_hash, external_updated_at, revision,
       date_add, date_edit, date_order)
     VALUES (?, ?, ?, ?, ?, '', ?, 0, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0,
             ?, ?, 0, 0, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW(), ?)`,
		[id_integration, external_id, src.external_number || null, src.external_cart_id || null, src.secure_key || null, src.channel || "web", JSON.stringify(snapshot), startStatusId, financial_status, fulfillment_status, initFlags.is_paid, initFlags.is_shipped, initFlags.is_canceled, currencyId, currencyIso, rate, BASE_CURRENCY, DEFAULT_LANG_ID, total_products, v.total_discount, v.total_shipping, v.total_wrapping, v.total_tax, v.total_tips, total, v.total_paid, toBase(total, rate), toBase(v.total_paid, rate), toBase(v.total_discount, rate), DEFAULT_DELIVERY_ID, DEFAULT_PAYMENT_ID, body.is_gift ? 1 : 0, body.gift_message || null, JSON.stringify(custom_fields), body.note || null, syncHash, toDbDateTime(body.status?.external_updated_at) || null, toDbDateTime(src.date_order)]
	);

	const orderId = ins.insertId;
	await conn.query(`UPDATE \`${P}orders\` SET reference = ? WHERE id = ?`, ["CRM-" + String(orderId).padStart(6, "0"), orderId]);

	await insertOrderChildren(conn, orderId, body, rate);

	// ─── Матчинг / створення клієнта ──────────────────────────────────────
	const addresses = Array.isArray(body.addresses) ? body.addresses : [];
	const shipAddr = addresses.find((a) => a.type === "shipping") || addresses[0] || null;
	const defaultCountry = shipAddr ? shipAddr.country : null;
	const externalClientId = c.external_client_id || null;
	const canCreate = body.__can_create_clients === 1;

	let id_client = 0;
	let clientAction = null;

	const match = await findMatchTx(conn, {
		email: c.email,
		phone: c.phone,
		id_integration,
		externalId: externalClientId,
		defaultCountry,
	});

	if (match) {
		id_client = match.id;
		clientAction = { action: "linked", matched_by: match.matched_by };
	} else if (canCreate && (c.email || c.phone || c.firstname)) {
		id_client = await createClientTx(conn, {
			snapshot: c,
			address: shipAddr,
			id_integration,
			externalId: externalClientId,
			sourceChannel: src.channel || "web",
			defaultCountry,
		});
		clientAction = { action: "created" };
	}

	if (id_client) {
		await conn.query(`UPDATE \`${P}orders\` SET id_client = ? WHERE id = ?`, [id_client, orderId]);
		await recalcClientStats(conn, id_client);
		await conn.query(
			`INSERT INTO \`${P}orders_events\` (id_order, id_user, type, payload, source, date_add)
       VALUES (?, NULL, ?, ?, 'webhook', NOW())`,
			[orderId, clientAction.action === "created" ? "client_created" : "client_linked", JSON.stringify({ id_client, ...clientAction })]
		);
	}

	await conn.query(
		`INSERT INTO \`${P}orders_raw\` (id_order, payload, received_at) VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE payload = VALUES(payload), received_at = NOW()`,
		[orderId, JSON.stringify(body)]
	);

	await conn.query(
		`INSERT INTO \`${P}orders_events\` (id_order, id_user, type, payload, source, date_add)
     VALUES (?, NULL, 'created', ?, 'webhook', NOW())`,
		[orderId, JSON.stringify({ via: "webhook", external_id, items_sum: itemsSum, total_products })]
	);

	return orderId;
};

// ─── Обробка однієї пачки. Повертає { count, hadRetryable } ───────────────
const processInbox = async () => {
	await connection_pool.query(
		`UPDATE \`${P}orders_inbox\`
     SET status = 'pending', locked_at = NULL
     WHERE status = 'processing' AND locked_at < (NOW() - INTERVAL ? MINUTE)`,
		[STALE_MIN]
	);

	const conn = await connection_pool.getConnection();
	let batch = [];
	try {
		await conn.beginTransaction();
		const [rows] = await conn.query(
			`SELECT id, id_integration, payload FROM \`${P}orders_inbox\`
       WHERE status = 'pending' AND attempts < ?
       ORDER BY id ASC LIMIT ?
       FOR UPDATE SKIP LOCKED`,
			[MAX_ATTEMPTS, BATCH]
		);
		if (rows.length) {
			await conn.query(`UPDATE \`${P}orders_inbox\` SET status = 'processing', locked_at = NOW() WHERE id IN (?)`, [rows.map((r) => r.id)]);
			batch = rows;
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		logging.error(e);
		return { count: 0, hadRetryable: false };
	} finally {
		conn.release();
	}

	let hadRetryable = false;

	for (const row of batch) {
		const c = await connection_pool.getConnection();
		try {
			await c.beginTransaction();
			const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
			if (row.id_integration) payload.__id_integration = row.id_integration;
			const orderId = await createOrderFromPayload(c, payload);
			await c.query(`UPDATE \`${P}orders_inbox\` SET status = 'done', id_order = ?, processed_at = NOW(), last_error = NULL WHERE id = ?`, [orderId, row.id]);
			await c.commit();
		} catch (err) {
			await c.rollback();
			logging.error(err);
			hadRetryable = true;
			await connection_pool.query(
				`UPDATE \`${P}orders_inbox\`
         SET attempts = attempts + 1,
             status = IF(attempts + 1 >= ?, 'failed', 'pending'),
             locked_at = NULL,
             last_error = ?
         WHERE id = ?`,
				[MAX_ATTEMPTS, String(err.message || err).slice(0, 999), row.id]
			);
		} finally {
			c.release();
		}
	}

	return { count: batch.length, hadRetryable };
};

// ─── Подієвий воркер (без polling за годинником) ─────────────────────────
let running = false;
let queued = false;
let retryTimer = null;

const kickWorker = () => {
	if (running) {
		queued = true;
		return;
	}
	running = true;
	setImmediate(drain);
};

async function drain() {
	try {
		const { count, hadRetryable } = await processInbox();
		if (count === BATCH) {
			setImmediate(drain);
			return;
		} // ще є → продовжуємо
		if (hadRetryable && !retryTimer) {
			retryTimer = setTimeout(() => {
				retryTimer = null;
				kickWorker();
			}, RETRY_DELAY_MS);
		}
	} catch (e) {
		logging.error(e);
	}
	running = false;
	if (queued) {
		queued = false;
		kickWorker();
	}
}

// Одноразово на старті: підняти зависле після можливого рестарту
const recoverOnStartup = async () => {
	try {
		await connection_pool.query(`UPDATE \`${P}orders_inbox\` SET status = 'pending', locked_at = NULL WHERE status = 'processing'`);
		kickWorker();
		logging.info?.("Inbox recovered on startup");
	} catch (e) {
		logging.error(e);
	}
};

module.exports = { processInbox, kickWorker, recoverOnStartup, createOrderFromPayload };
