// controllers/orders/cartScheduler.js
// Planner: сканує кошики, ставить у чергу завдання на відправку з дедупом.
// НЕ відправляє. НЕ застосовує send-вікна (це робить worker).

const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
const logging = require("../../logging/logging");

const { kickCartSendWorker } = require("./cartSendWorker");

const P = configDatabase.prefix;
const TICK_MS = 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
// Без згоди не шлемо (як у топ-системах). Вимкнути для тестів: ABANDONED_CART_REQUIRE_CONSENT=0
const REQUIRE_CONSENT = process.env.ABANDONED_CART_REQUIRE_CONSENT !== "0";

let timer = null;
let running = false;

// Активні події з підключеним активним сервісом
async function loadActiveEvents() {
	const [rows] = await connection_pool.query(
		`SELECT e.id AS event_id, e.service_id, e.id_integration, e.store_id,
            e.delay_hours, e.delay_minutes,
            e.min_cart_amount, e.resend_mode, e.repeat_after_hours
     FROM \`${P}orders_abandoned_cart_events\` e
     JOIN \`${P}orders_abandoned_cart_services\` s ON s.id = e.service_id
     WHERE e.active = 1 AND s.is_connected = 1 AND s.active = 1`
	);
	return rows;
}

// attempt_no=1 — перша відправка для кожного придатного кошика
async function enqueueFirstAttempts(ev) {
	const consentClause = REQUIRE_CONSENT ? `AND JSON_EXTRACT(ac.cart, '$.customer.consent') = 1` : ``;

	const [r] = await connection_pool.query(
		`INSERT IGNORE INTO \`${P}orders_abandoned_cart_queue\`
       (cart_id, event_id, service_id, attempt_no, status, run_after, max_attempts, date_add, date_edit)
     SELECT ac.id, ?, ?, 1, 'pending',
            (ac.last_activity_at + INTERVAL ? HOUR + INTERVAL ? MINUTE),
            ?, NOW(), NOW()
     FROM \`${P}orders_abandoned_cart\` ac
     WHERE ac.status IN ('active','abandoned','notified')
       AND ac.total_amount >= ?
       AND (ac.last_activity_at + INTERVAL ? HOUR + INTERVAL ? MINUTE) <= NOW()
       AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(ac.cart, '$.customer.telephone')), '') <> ''
       AND (? IS NULL OR ac.id_integration <=> ?)
       AND (? IS NULL OR ac.store_id <=> ?)
       ${consentClause}`,
		[ev.event_id, ev.service_id, ev.delay_hours, ev.delay_minutes, DEFAULT_MAX_ATTEMPTS, ev.min_cart_amount, ev.delay_hours, ev.delay_minutes, ev.id_integration, ev.id_integration, ev.store_id, ev.store_id]
	);
	return r.affectedRows || 0;
}

// attempt_no=2 — повтор для resend_mode='once_repeat' після успішної першої відправки
async function enqueueRepeatAttempts(ev) {
	const [r] = await connection_pool.query(
		`INSERT IGNORE INTO \`${P}orders_abandoned_cart_queue\`
       (cart_id, event_id, service_id, attempt_no, status, run_after, max_attempts, date_add, date_edit)
     SELECT q1.cart_id, q1.event_id, q1.service_id, 2, 'pending',
            (q1.sent_at + INTERVAL ? HOUR),
            ?, NOW(), NOW()
     FROM \`${P}orders_abandoned_cart_queue\` q1
     JOIN \`${P}orders_abandoned_cart\` ac ON ac.id = q1.cart_id
     WHERE q1.event_id = ? AND q1.attempt_no = 1 AND q1.status = 'sent'
       AND q1.sent_at IS NOT NULL
       AND ac.status IN ('abandoned','notified')`,
		[ev.repeat_after_hours, DEFAULT_MAX_ATTEMPTS, ev.event_id]
	);
	return r.affectedRows || 0;
}

async function tick() {
	if (running) return;
	running = true;
	try {
		const events = await loadActiveEvents();
		let first = 0,
			repeat = 0;
		for (const ev of events) {
			first += await enqueueFirstAttempts(ev);
			if (ev.resend_mode === "once_repeat") repeat += await enqueueRepeatAttempts(ev);
		}
		if (first || repeat) {
			logging.info?.(`[cartScheduler] enqueued first=${first} repeat=${repeat}`);
			kickCartSendWorker();
		}
	} catch (e) {
		logging.error(e);
	} finally {
		running = false;
	}
}

function kickCartScheduler() {
	setImmediate(tick);
}

function startCartScheduler() {
	if (timer) return;
	timer = setInterval(tick, TICK_MS);
	tick(); // одразу при старті
}

module.exports = { startCartScheduler, kickCartScheduler };
