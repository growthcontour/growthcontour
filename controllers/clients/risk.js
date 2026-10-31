"use strict";

/**
 * Ризик клієнта: невикуп посилок, скасування, чорний список (статус картки «заблокований»),
 * дублі — інші картки з тим самим телефоном / email, свіжі замовлення й ліди того ж клієнта.
 * Одна оцінка для картки замовлення, ліда й клієнта: { level: ok | warn | high, buyout, reasons[] }.
 */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const normalize = require("./normalize");
const dict = require("./dictionaries");

const P = config.get("configDatabase").prefix;

// Пороги: невикуп рахуємо від посилок із результатом (отримано / повернуто)
const BUYOUT_MIN_PARCELS = 2;
const BUYOUT_HIGH = 0.5; // викуп нижче — високий ризик
const BUYOUT_WARN = 0.8; // нижче — увага
const CANCEL_MIN = 3; // скасованих замовлень і більше половини від усіх — увага
const RECENT_ORDER_HOURS = 48;
const RECENT_LEAD_DAYS = 7;

const json = (v) => {
	if (v && typeof v === "object") return v;
	try {
		return v ? JSON.parse(v) : {};
	} catch {
		return {};
	}
};
// Останні 9 цифр — однаково для +380…, 380…, 0…
const phoneTail = (v) => {
	const d = String(v || "").replace(/\D/g, "");
	return d.length >= 9 ? d.slice(-9) : null;
};
const PHONE_SQL = (expr) => `RIGHT(REGEXP_REPLACE(COALESCE(${expr}, ''), '[^0-9]', ''), 9)`;

/** Посилки й скасування клієнта (за карткою) */
async function clientHistory(idClient) {
	if (!idClient) return null;
	const [[r]] = await pool.query(
		`SELECT COUNT(DISTINCT o.id) AS orders,
		        COUNT(DISTINCT IF(o.is_canceled = 1, o.id, NULL)) AS canceled,
		        COUNT(DISTINCT IF(s.status = 'delivered', s.id, NULL)) AS delivered,
		        COUNT(DISTINCT IF(s.status = 'returned', s.id, NULL)) AS returned
		   FROM ${P}orders o
		   LEFT JOIN ${P}orders_shipments s ON s.id_order = o.id AND s.tracking_number IS NOT NULL
		  WHERE (o.id_client = ? OR o.id_client_org = ?) AND o.deleted_at IS NULL`,
		[idClient, idClient]
	);
	return { orders: Number(r.orders) || 0, canceled: Number(r.canceled) || 0, delivered: Number(r.delivered) || 0, returned: Number(r.returned) || 0 };
}

/**
 * Оцінка за даними: idClient (картка), phone / email (із замовлення чи ліда), exclude: { order, lead, client } — поточний запис.
 */
async function assess({ idClient = null, phone = null, email = null, exclude = {} }) {
	const reasons = [];
	const add = (level, code, vars = {}, links = []) => reasons.push({ level, code, vars, links });
	const tail = phoneTail(phone);
	const ph = phone ? normalize.phone(phone) : null;
	const mail = email ? String(email).trim().toLowerCase() : null;

	// Картка: чорний список
	if (idClient) {
		const [[c]] = await pool.query(`SELECT status FROM ${P}clients WHERE id = ?`, [idClient]);
		if (c && c.status === "blocked") add("high", "blocked");
	}

	// Невикуп і скасування
	const h = await clientHistory(idClient);
	let buyout = null;
	if (h) {
		const parcels = h.delivered + h.returned;
		buyout = { delivered: h.delivered, returned: h.returned, rate: parcels ? Math.round((h.delivered / parcels) * 100) : null };
		if (parcels >= BUYOUT_MIN_PARCELS && h.delivered / parcels < BUYOUT_HIGH) add("high", "buyout_low", { rate: buyout.rate, returned: h.returned, parcels });
		else if (parcels >= BUYOUT_MIN_PARCELS && h.delivered / parcels < BUYOUT_WARN) add("warn", "buyout_mid", { rate: buyout.rate, returned: h.returned, parcels });
		else if (h.returned && parcels < BUYOUT_MIN_PARCELS) add("warn", "returned", { returned: h.returned });
		if (h.canceled >= CANCEL_MIN && h.canceled * 2 >= h.orders) add("warn", "canceled", { canceled: h.canceled, orders: h.orders });
	}

	// Інші картки з тим самим телефоном / email: можливі дублі; заблокована — високий ризик
	if (ph || mail) {
		const [phoneType, emailType] = await Promise.all([dict.idOf("contact_types", "phone"), dict.idOf("contact_types", "email")]);
		const cond = [];
		const args = [];
		if (ph && ph.normalized) (cond.push("(cp.id_contact_type = ? AND cp.value_normalized = ?)"), args.push(phoneType, ph.normalized));
		if (mail) (cond.push("(cp.id_contact_type = ? AND cp.value_normalized = ?)"), args.push(emailType, mail));
		if (cond.length) {
			const [others] = await pool.query(
				`SELECT DISTINCT c.id, c.display_name, c.status FROM ${P}clients_contact_points cp
				   JOIN ${P}clients c ON c.id = cp.id_client AND c.deleted_at IS NULL AND c.id_merged_into IS NULL
				  WHERE (${cond.join(" OR ")}) AND c.id <> ? LIMIT 10`,
				[...args, idClient || exclude.client || 0]
			);
			const link = (c) => ({ href: `/clients/${c.id}/`, label: c.display_name || "#" + c.id });
			const blocked = others.filter((c) => c.status === "blocked");
			if (blocked.length) add("high", "blocked_other", {}, blocked.map(link));
			const rest = others.filter((c) => c.status !== "blocked");
			if (rest.length) add("warn", "dup_client", { n: rest.length }, rest.map(link));
		}
	}

	// Свіжі незакриті замовлення того ж клієнта / телефону — можливий дубль
	if (idClient || tail) {
		const [rows] = await pool.query(
			`SELECT o.id, o.reference FROM ${P}orders o
			  WHERE o.deleted_at IS NULL AND o.is_canceled = 0 AND o.id <> ? AND o.date_add > NOW() - INTERVAL ${RECENT_ORDER_HOURS} HOUR
			    AND (${idClient ? "o.id_client = ? OR " : ""}${tail ? `${PHONE_SQL("JSON_UNQUOTE(JSON_EXTRACT(o.client, '$.phone'))")} = ?` : "0"})
			  ORDER BY o.id DESC LIMIT 10`,
			[exclude.order || 0, ...(idClient ? [idClient] : []), ...(tail ? [tail] : [])]
		);
		if (rows.length) add("warn", "dup_order", { n: rows.length, hours: RECENT_ORDER_HOURS }, rows.map((o) => ({ href: `/orders/${o.id}/`, label: o.reference || "#" + o.id })));
	}

	// Відкриті ліди того ж клієнта / телефону за тиждень
	if (idClient || tail) {
		const [rows] = await pool.query(
			`SELECT l.id, l.title FROM ${P}leads l
			  WHERE l.deleted_at IS NULL AND l.is_converted = 0 AND l.id <> ? AND l.date_add > NOW() - INTERVAL ${RECENT_LEAD_DAYS} DAY
			    AND (${idClient ? "l.id_client = ? OR " : ""}${tail ? `${PHONE_SQL("JSON_UNQUOTE(JSON_EXTRACT(l.contact_info, '$.phone'))")} = ?` : "0"})
			  ORDER BY l.id DESC LIMIT 10`,
			[exclude.lead || 0, ...(idClient ? [idClient] : []), ...(tail ? [tail] : [])]
		);
		if (rows.length) add("warn", "dup_lead", { n: rows.length, days: RECENT_LEAD_DAYS }, rows.map((l) => ({ href: `/leads/${l.id}/`, label: l.title || "#" + l.id })));
	}

	const level = reasons.some((r) => r.level === "high") ? "high" : reasons.length ? "warn" : "ok";
	return { level, buyout, history: h, reasons };
}

async function forOrder(id) {
	const [[o]] = await pool.query(`SELECT id, id_client, client FROM ${P}orders WHERE id = ?`, [id]);
	if (!o) return null;
	const c = json(o.client);
	return assess({ idClient: o.id_client, phone: c.phone, email: c.email, exclude: { order: o.id } });
}

async function forLead(id) {
	const [[l]] = await pool.query(`SELECT id, id_client, contact_info FROM ${P}leads WHERE id = ?`, [id]);
	if (!l) return null;
	const c = json(l.contact_info);
	return assess({ idClient: l.id_client, phone: c.phone, email: c.email, exclude: { lead: l.id } });
}

async function forClient(id) {
	const [phoneType, emailType] = await Promise.all([dict.idOf("contact_types", "phone"), dict.idOf("contact_types", "email")]);
	const [[c]] = await pool.query(
		`SELECT c.id,
		        (SELECT value_normalized FROM ${P}clients_contact_points WHERE id_client = c.id AND id_contact_type = ? ORDER BY is_primary DESC, id LIMIT 1) AS phone,
		        (SELECT value_normalized FROM ${P}clients_contact_points WHERE id_client = c.id AND id_contact_type = ? ORDER BY is_primary DESC, id LIMIT 1) AS email
		   FROM ${P}clients c WHERE c.id = ?`,
		[phoneType, emailType, id]
	);
	if (!c) return null;
	return assess({ idClient: c.id, phone: c.phone, email: c.email, exclude: { client: c.id } });
}

module.exports = { assess, forOrder, forLead, forClient, clientHistory };
