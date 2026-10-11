const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const dict = require("./dictionaries");
const normalize = require("./normalize");
const matcher = require("./matcher");

const P = config.get("configDatabase").prefix;
const { BASE_CURRENCY } = require("../orders/currency");

// Формат, який очікує сторінка замовлення (сумісний зі старим API)
function toCompat(r) {
	return {
		id: r.id,
		kind: r.kind,
		display_name: r.display_name,
		firstname: r.first_name || null,
		lastname: r.last_name || null,
		email: r.email || null,
		phone: r.phone || null,
		company: r.kind === "organization" ? r.short_name || r.legal_name || null : null,
		type: r.kind,
		lifecycle: r.lifecycle_code || null,
		is_vip: r.lifecycle_code === "vip" ? 1 : 0,
		reward_points: 0,
		balance: 0,
		balance_currency: BASE_CURRENCY,
		orders_count: Number(r.orders_count) || 0,
		orders_valid_count: Number(r.orders_valid_count) || 0,
		total_spent: Number(r.revenue_base) || 0,
		id_default_group: null,
		group_name: r.price_group || null,
		status: r.status,
	};
}

async function briefMany(ids, conn) {
	const q = conn || pool;
	const list = [...new Set((ids || []).map(Number).filter(Boolean))];
	if (!list.length) return [];

	const phoneType = await dict.idOf("contact_types", "phone");
	const emailType = await dict.idOf("contact_types", "email");

	const [rows] = await q.query(
		`SELECT c.id, c.kind, c.display_name, c.status,
                p.first_name, p.last_name, o.legal_name, o.short_name,
                ls.code AS lifecycle_code,
                st.orders_count, st.orders_valid_count, st.revenue_base,
                com.price_group,
                (SELECT cp.value_normalized FROM ${P}clients_contact_points cp
                  WHERE cp.id_client = c.id AND cp.id_contact_type = ? ORDER BY cp.is_primary DESC, cp.id ASC LIMIT 1) AS phone,
                (SELECT cp.value_normalized FROM ${P}clients_contact_points cp
                  WHERE cp.id_client = c.id AND cp.id_contact_type = ? ORDER BY cp.is_primary DESC, cp.id ASC LIMIT 1) AS email
           FROM ${P}clients c
           LEFT JOIN ${P}clients_persons p ON p.id_client = c.id
           LEFT JOIN ${P}clients_organizations o ON o.id_client = c.id
           LEFT JOIN ${P}clients_lifecycle_stages ls ON ls.id = c.id_lifecycle
           LEFT JOIN ${P}clients_stats st ON st.id_client = c.id
           LEFT JOIN ${P}clients_commercial com ON com.id_client = c.id
          WHERE c.id IN (?)`,
		[phoneType, emailType, list]
	);

	const byId = new Map(rows.map((r) => [r.id, toCompat(r)]));
	return list.map((id) => byId.get(id)).filter(Boolean);
}

async function brief(id, conn) {
	const [r] = await briefMany([id], conn);
	return r || null;
}

/** Кандидати для непривʼязаного замовлення (за снапшотом) — зі скором і причинами */
async function candidatesFor({ email, phone, externalId, id_integration }, country, conn) {
	const contacts = [];
	const pt = await dict.byCode("contact_types", "phone");
	const et = await dict.byCode("contact_types", "email");
	if (phone && pt) {
		const n = normalize.phone(phone, country);
		if (n) contacts.push({ typeRow: pt, ...n });
	}
	if (email && et) {
		const n = normalize.email(email);
		if (n) contacts.push({ typeRow: et, ...n });
	}
	const externalIds = externalId && id_integration ? [{ system: "site", id_integration, external_id: String(externalId) }] : [];

	const { candidates } = await matcher.findMatches({ contacts, identifiers: [], externalIds }, conn);
	const briefs = await briefMany(
		candidates.map((c) => c.id_client),
		conn
	);

	return briefs.map((b) => {
		const m = candidates.find((c) => c.id_client === b.id);
		const score = m ? m.score : 0;
		return { ...b, score, reasons: m ? m.reasons : [], confidence: score >= 90 ? "high" : score >= 60 ? "medium" : "low" };
	});
}

/** Ручний пошук: ім'я, телефон, email, ідентифікатор */
/**
 * onlyUserId — якщо задано, лише клієнти цього менеджера або без менеджера
 * (для користувачів без права «Усі клієнти»).
 */
async function search(text, conn, onlyUserId) {
	const s = normalize.cleanText(text, 100);
	if (s.length < 2) return [];
	const like = `%${s}%`;
	const ph = normalize.phone(s);
	const exact = ph && ph.valid ? ph.normalized : null;
	const own = onlyUserId ? "AND (c.id_manager = ? OR c.id_manager IS NULL)" : "";

	const [rows] = await (conn || pool).query(
		`SELECT DISTINCT c.id, c.date_last_activity
           FROM ${P}clients c
           LEFT JOIN ${P}clients_contact_points cp ON cp.id_client = c.id
           LEFT JOIN ${P}clients_identifiers ci ON ci.id_client = c.id
          WHERE c.deleted_at IS NULL AND c.id_merged_into IS NULL AND (
                c.display_name LIKE ? OR cp.value LIKE ? OR cp.value_normalized LIKE ? OR ci.value_normalized LIKE ?
                OR (? IS NOT NULL AND cp.value_normalized = ?)
          ) ${own}
          ORDER BY c.date_last_activity DESC
          LIMIT 20`,
		onlyUserId ? [like, like, like, like, exact, exact, onlyUserId] : [like, like, like, like, exact, exact]
	);
	return briefMany(
		rows.map((r) => r.id),
		conn
	);
}

module.exports = { brief, briefMany, candidatesFor, search };
