"use strict";

/**
 * Повідомлення клієнту по замовленню (Viber, з резервним SMS) через підключені сервіси SMSClub
 * (той самий довідник сервісів, що й у покинутих кошиках: orders_abandoned_cart_services).
 *
 * Шаблони (orders_message_templates): текст зі змінними, сервіс, тригер — подія замовлення
 * (нове, перехід у статус, ТТН, доставлено, повернення) або лише вручну; обмеження за сайтами.
 * Черга й журнал (orders_messages): повтори з паузою, «тихі години» (не надсилаємо вночі),
 * автоматичний шаблон — не частіше одного разу на замовлення.
 */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const smsclub = require("./providers/smsclub");
const { readServiceConfig, normalizePhone } = require("./serviceConfig");

const P = config.get("configDatabase").prefix;
const PROVIDERS = ["smsclub_viber", "smsclub_viber2"];
const TRIGGERS = ["new", "status", "ttn", "delivered", "returned"];
const MAX_ATTEMPTS = 5;
const QUIET = { from: 9, to: 21 }; // година за Києвом: автоматичні — лише в цьому вікні
const TICK_MS = 20 * 1000;

const json = (v, d) => {
	if (v && typeof v === "object") return v;
	try {
		return v ? JSON.parse(v) : d;
	} catch {
		return d;
	}
};
const httpErr = (status, message) => Object.assign(new Error(message), { status });

/* ─── Шаблони ─── */

async function services() {
	const [rows] = await pool.query(
		`SELECT id, name, provider, is_default FROM ${P}orders_abandoned_cart_services
		  WHERE provider IN (?) AND is_connected = 1 AND active = 1 ORDER BY is_default DESC, sort_order, id`,
		[PROVIDERS]
	);
	return rows;
}

function publicTemplate(t) {
	return { ...t, trigger_statuses: json(t.trigger_statuses, []).map(Number), integrations: json(t.integrations, []).map(Number), status: Number(t.status) };
}

async function templates() {
	const [rows] = await pool.query(`SELECT * FROM ${P}orders_message_templates ORDER BY sort_order, id`);
	return rows.map(publicTemplate);
}

async function saveTemplate(id, b) {
	const name = String(b.name || "").trim().slice(0, 128);
	const text = String(b.text || "").trim().slice(0, 1000);
	if (!name || !text) throw httpErr(400, "orders.messages.e_required");
	const trigger = TRIGGERS.includes(b.trigger_event) ? b.trigger_event : null;
	const ints = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => n > 0))];
	const row = [
		name,
		text,
		parseInt(b.id_service, 10) || null,
		trigger,
		JSON.stringify(trigger === "status" ? ints(b.trigger_statuses) : []),
		JSON.stringify(ints(b.integrations)),
		b.status === undefined || Number(b.status) ? 1 : 0,
	];
	if (id) {
		await pool.query(
			`UPDATE ${P}orders_message_templates SET name = ?, text = ?, id_service = ?, trigger_event = ?, trigger_statuses = ?, integrations = ?, status = ?, date_edit = NOW() WHERE id = ?`,
			[...row, id]
		);
		return id;
	}
	const [r] = await pool.query(
		`INSERT INTO ${P}orders_message_templates (name, text, id_service, trigger_event, trigger_statuses, integrations, status, date_add, date_edit) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
		row
	);
	return r.insertId;
}

async function deleteTemplate(id) {
	await pool.query(`DELETE FROM ${P}orders_message_templates WHERE id = ?`, [id]);
}

/* ─── Змінні ─── */

/** Дані замовлення для підстановки: {order.number} {client.name} {total} {ttn} {ttn_url} {status} {site} {items} … */
async function vars(idOrder) {
	const [[o]] = await pool.query(
		`SELECT o.id, o.reference, o.total, o.currency_iso, o.client, o.id_integration, si.name AS site, sl.text AS status_name
		   FROM ${P}orders o
		   LEFT JOIN ${P}settings_integrations si ON si.id = o.id_integration
		   LEFT JOIN ${P}orders_status_lang sl ON sl.id_status = o.status AND sl.id_lang = 1
		  WHERE o.id = ? AND o.deleted_at IS NULL`,
		[idOrder]
	);
	if (!o) return null;
	const [[s]] = await pool.query(`SELECT tracking_number FROM ${P}orders_shipments WHERE id_order = ? AND tracking_number IS NOT NULL ORDER BY id DESC LIMIT 1`, [idOrder]);
	const [items] = await pool.query(`SELECT name, quantity FROM ${P}orders_items WHERE id_order = ? ORDER BY id LIMIT 10`, [idOrder]);
	const c = json(o.client, {});
	const ttn = s ? s.tracking_number : "";
	return {
		order: o,
		phone: c.phone || "",
		map: {
			"order.number": o.reference || "#" + o.id,
			"client.name": [c.firstname, c.lastname].filter(Boolean).join(" "),
			"client.firstname": c.firstname || "",
			total: new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(o.total) || 0),
			currency: o.currency_iso || "",
			status: o.status_name || "",
			site: o.site || "",
			ttn,
			ttn_url: ttn ? `https://novaposhta.ua/tracking/?cargo_number=${encodeURIComponent(ttn)}` : "",
			items: items.map((i) => `${i.name} × ${Number(i.quantity)}`).join(", "),
		},
	};
}

const render = (text, map) => String(text).replace(/\{([a-z_.]+)\}/gi, (m, k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m));

/** Попередній перегляд: шаблон або текст на даних замовлення */
async function preview(idOrder, text) {
	const v = await vars(idOrder);
	if (!v) throw httpErr(404, "orders.messages.e_order");
	return { text: render(text, v.map), phone: normalizePhone(v.phone) };
}

/* ─── Черга ─── */

// Хвилин до початку «вікна» (за Києвом); 0 — уже можна
function quietWait(now = new Date()) {
	const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", hour12: false }).format(now).split(":").map(Number);
	if (h >= QUIET.from && h < QUIET.to) return 0;
	return (h >= QUIET.to ? 24 - h + QUIET.from : QUIET.from - h) * 60 - m;
}

/**
 * Поставити повідомлення в чергу. o: { idOrder, text, idTemplate, idService, source: manual | auto, idUser }
 * Ручне — одразу; автоматичне — у «вікні» й один раз на шаблон для замовлення.
 */
async function enqueue(o) {
	const v = await vars(o.idOrder);
	if (!v) throw httpErr(404, "orders.messages.e_order");
	const srv = await services();
	const service = srv.find((s) => s.id === Number(o.idService)) || srv[0];
	if (!service) throw httpErr(409, "orders.messages.e_service");
	if (o.source === "auto" && o.idTemplate) {
		const [[dup]] = await pool.query(`SELECT id FROM ${P}orders_messages WHERE id_order = ? AND id_template = ? AND source = 'auto' AND status <> 'failed' LIMIT 1`, [o.idOrder, o.idTemplate]);
		if (dup) return null;
	}
	const text = render(o.text, v.map).trim();
	if (!text) throw httpErr(400, "orders.messages.e_required");
	const phone = normalizePhone(v.phone);
	const wait = o.source === "auto" ? quietWait() : 0;
	const [r] = await pool.query(
		`INSERT INTO ${P}orders_messages (id_order, id_template, id_service, phone, text, source, status, attempts, next_at, last_error, id_user, date_add)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NOW())`,
		[o.idOrder, o.idTemplate || null, service.id, phone, text, o.source || "manual", phone ? "pending" : "failed", new Date(Date.now() + wait * 60000), phone ? null : "invalid phone", o.idUser || null]
	);
	if (phone) kick();
	return r.insertId;
}

/** Подія замовлення → шаблони з таким тригером (викликається зі сповіщень після commit) */
async function onEvent(idOrder, event, extra = {}) {
	try {
		if (!TRIGGERS.includes(event)) return;
		const [[o]] = await pool.query(`SELECT id_integration, status FROM ${P}orders WHERE id = ? AND deleted_at IS NULL`, [idOrder]);
		if (!o) return;
		const [rows] = await pool.query(`SELECT * FROM ${P}orders_message_templates WHERE status = 1 AND trigger_event = ?`, [event]);
		for (const t of rows.map(publicTemplate)) {
			if (t.integrations.length && !t.integrations.includes(Number(o.id_integration))) continue;
			if (event === "status" && !t.trigger_statuses.includes(Number(extra.to || o.status))) continue;
			await enqueue({ idOrder, text: t.text, idTemplate: t.id, idService: t.id_service, source: "auto" }).catch((e) => !e.status && logging.error(e));
		}
	} catch (e) {
		logging.error(e);
	}
}

async function list(idOrder) {
	const [rows] = await pool.query(
		`SELECT m.id, m.text, m.phone, m.source, m.status, m.attempts, m.last_error, m.date_add, m.sent_at, m.next_at,
		        t.name AS template, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS user_name
		   FROM ${P}orders_messages m
		   LEFT JOIN ${P}orders_message_templates t ON t.id = m.id_template
		   LEFT JOIN ${P}users u ON u.id = m.id_user
		  WHERE m.id_order = ? ORDER BY m.id DESC LIMIT 100`,
		[idOrder]
	);
	return rows;
}

/* ─── Відправка ─── */

async function sendOne(m) {
	const [[s]] = await pool.query(`SELECT config, config_fields, provider FROM ${P}orders_abandoned_cart_services WHERE id = ?`, [m.id_service]);
	const fail = (err, retriable) =>
		pool.query(
			`UPDATE ${P}orders_messages SET status = IF(? AND attempts + 1 < ?, 'pending', 'failed'),
			        attempts = attempts + 1, locked_at = NULL, last_error = ?, next_at = ? WHERE id = ?`,
			[retriable ? 1 : 0, MAX_ATTEMPTS, String(err).slice(0, 500), new Date(Date.now() + Math.min(3600, 60 * 2 ** m.attempts) * 1000), m.id]
		);
	if (!s || !PROVIDERS.includes(s.provider)) return fail("service unavailable", false);
	const cfg = readServiceConfig(s);
	// Резервне SMS тим самим текстом, якщо в сервісі задано SMS-відправника; без кнопок і картинок кошика
	const result = await smsclub.send({ ...cfg, button_txt: "", button_url: "", picture_url: "", message_sms: cfg.sender_sms ? m.text : "" }, { phones: [m.phone], message: m.text });
	if (result.ok) {
		await pool.query(`UPDATE ${P}orders_messages SET status = 'sent', attempts = attempts + 1, sent_at = NOW(), locked_at = NULL, last_error = NULL, provider_ids = ? WHERE id = ?`, [
			JSON.stringify((result.messages || []).map((x) => x.id)),
			m.id,
		]);
	} else await fail(result.message || result.code, result.retriable);
}

let running = false;
async function tick() {
	if (running) return;
	running = true;
	try {
		// Завислі «в роботі» (процес упав) — повернути в чергу
		await pool.query(`UPDATE ${P}orders_messages SET status = 'pending', locked_at = NULL WHERE status = 'processing' AND locked_at < ?`, [new Date(Date.now() - 5 * 60000)]);
		for (let loop = 0; loop < 10; loop++) {
			const [rows] = await pool.query(`SELECT * FROM ${P}orders_messages WHERE status = 'pending' AND next_at <= ? ORDER BY next_at, id LIMIT 20`, [new Date()]);
			if (!rows.length) break;
			for (const m of rows) {
				// Захоплення рядка: інший процес сервера його вже не візьме
				const [c] = await pool.query(`UPDATE ${P}orders_messages SET status = 'processing', locked_at = ? WHERE id = ? AND status = 'pending'`, [new Date(), m.id]);
				if (!c.affectedRows) continue;
				await sendOne(m).catch((e) => {
					logging.error(e);
					return pool.query(`UPDATE ${P}orders_messages SET status = 'pending', locked_at = NULL, attempts = attempts + 1, last_error = ? WHERE id = ?`, [String(e.message).slice(0, 500), m.id]);
				});
			}
		}
	} catch (e) {
		logging.error(e);
	} finally {
		running = false;
	}
}

let timer = null;
const kick = () => setImmediate(tick);
function start() {
	if (timer) return;
	timer = setInterval(tick, TICK_MS);
	timer.unref();
}

module.exports = { TRIGGERS, services, templates, saveTemplate, deleteTemplate, preview, enqueue, onEvent, list, start };