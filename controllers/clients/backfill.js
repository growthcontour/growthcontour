const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const { resolveClient } = require("./service");
const stats = require("./stats");

const P = config.get("configDatabase").prefix;

const parse = (v) => (v == null ? null : typeof v === "string" ? JSON.parse(v) : v);

// ─── Замовлення ────────────────────────────────
async function backfillOrders(log) {
	const { resolveOrderClients } = require("../orders/inboxProcessor");
	const [orders] = await pool.query(
		`SELECT o.id, o.id_integration, o.external_id, o.source_channel, o.client, r.payload
           FROM ${P}orders o
           LEFT JOIN ${P}orders_raw r ON r.id_order = o.id
          WHERE o.id_client IS NULL AND o.deleted_at IS NULL
          ORDER BY o.id ASC`
	);

	for (const o of orders) {
		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();

			const body = parse(o.payload) || { client: {}, addresses: [] };
			if (!Array.isArray(body.addresses) || !body.addresses.length) {
				const [addrs] = await conn.query(`SELECT * FROM ${P}orders_addresses WHERE id_order = ?`, [o.id]);
				body.addresses = addrs;
			}
			const c = { ...(parse(o.client) || {}), ...(body.client || {}) };
			const shipAddr = body.addresses.find((a) => a.type === "shipping") || body.addresses[0] || null;

			const cr = await resolveOrderClients(conn, {
				body,
				c,
				shipAddr,
				id_integration: o.id_integration,
				isInternal: o.source_channel === "contact-center",
				canCreate: true,
				external_id: o.external_id,
			});

			if (cr.id_client || cr.id_client_recipient || cr.id_client_org) {
				await conn.query(`UPDATE ${P}orders SET id_client = ?, id_client_recipient = ?, id_client_org = ? WHERE id = ?`, [cr.id_client, cr.id_client_recipient, cr.id_client_org, o.id]);
				await stats.recalcForOrder(conn, o.id);
				log.orders.linked++;
				if (cr.created) log.orders.new_clients++;
			} else {
				log.orders.skipped++;
			}
			await conn.commit();
		} catch (e) {
			await conn.rollback().catch(() => {});
			log.errors.push({ type: "order", id: o.id, error: e.sqlMessage || e.message });
		} finally {
			conn.release();
		}
	}
}

// ─── Ліди ──────────────────────────────────────
async function backfillLeads(log) {
	const [leads] = await pool.query(
		`SELECT id, contact_info, id_manager
           FROM ${P}leads
          WHERE id_client IS NULL AND deleted_at IS NULL
          ORDER BY id ASC`
	);

	for (const l of leads) {
		const ci = parse(l.contact_info) || {};
		if (!ci.phone && !ci.email && !ci.name) {
			log.leads.skipped++;
			continue;
		}
		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();
			const r = await resolveClient(
				{
					kind: "person",
					name: ci.name,
					contacts: [
						{ type: "phone", value: ci.phone },
						{ type: "email", value: ci.email },
					],
					lifecycleCode: "lead",
					source: "lead",
					sourceRef: String(l.id),
					idManager: l.id_manager,
				},
				{ conn, createIfMissing: true }
			);
			if (r.id_client) {
				await conn.query(`UPDATE ${P}leads SET id_client = ? WHERE id = ?`, [r.id_client, l.id]);
				await stats.recalc(conn, r.id_client);
				log.leads.linked++;
				if (r.created) log.leads.new_clients++;
			} else {
				log.leads.skipped++;
			}
			await conn.commit();
		} catch (e) {
			await conn.rollback().catch(() => {});
			log.errors.push({ type: "lead", id: l.id, error: e.sqlMessage || e.message });
		} finally {
			conn.release();
		}
	}
}

// ─── Контакти чатів ────────────────────────────
async function backfillChatContacts(log) {
	const [rows] = await pool.query(
		`SELECT ct.id, ct.external_id, ct.name, ct.first_name, ct.last_name, ct.username,
                ct.phone, ct.email, ct.timezone, ch.type AS channel_type
           FROM ${P}contact_center_contacts ct
           INNER JOIN ${P}contact_center_channels ch ON ch.id = ct.id_channel
          WHERE ct.id_client IS NULL
          ORDER BY ct.id ASC`
	);

	for (const ct of rows) {
		const contacts = [
			{ type: "phone", value: ct.phone },
			{ type: "email", value: ct.email },
		];
		const externalIds = [];

		if (ct.channel_type === "telegram") {
			externalIds.push({ system: "telegram", external_id: ct.external_id });
			if (ct.username) contacts.push({ type: "telegram", value: ct.username });
		} else if (ct.channel_type === "instagram") {
			externalIds.push({ system: "instagram", external_id: ct.external_id });
			if (ct.username) contacts.push({ type: "instagram", value: ct.username });
		} else if (ct.channel_type === "webchat") {
			// Анонімних відвідувачів у клієнти не перетворюємо
			if (!ct.phone && !ct.email) {
				log.chats.skipped++;
				continue;
			}
			externalIds.push({ system: "webchat", external_id: ct.external_id });
		}

		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();
			const r = await resolveClient(
				{
					kind: "person",
					name: ct.name,
					person: { first_name: ct.first_name, last_name: ct.last_name },
					contacts,
					externalIds,
					timezone: ct.timezone,
					lifecycleCode: "subscriber",
					source: "chat",
					sourceRef: String(ct.id),
				},
				{ conn, createIfMissing: true }
			);
			if (r.id_client) {
				await conn.query(`UPDATE ${P}contact_center_contacts SET id_client = ? WHERE id = ?`, [r.id_client, ct.id]);
				log.chats.linked++;
				if (r.created) log.chats.new_clients++;
			} else {
				log.chats.skipped++;
			}
			await conn.commit();
		} catch (e) {
			await conn.rollback().catch(() => {});
			log.errors.push({ type: "chat", id: ct.id, error: e.sqlMessage || e.message });
		} finally {
			conn.release();
		}
	}
}

async function run() {
	const log = {
		orders: { linked: 0, new_clients: 0, skipped: 0 },
		leads: { linked: 0, new_clients: 0, skipped: 0 },
		chats: { linked: 0, new_clients: 0, skipped: 0 },
		errors: [],
	};
	// Порядок важливий: спершу замовлення (найповніші дані), потім ліди й чати
	await backfillOrders(log);
	await backfillLeads(log);
	await backfillChatContacts(log);

	const [[t]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}clients WHERE id_merged_into IS NULL AND deleted_at IS NULL`);
	const [[d]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}clients_duplicate_candidates WHERE status = 'pending'`);
	log.total_clients = t.n;
	log.possible_duplicates = d.n;
	return log;
}

module.exports = { run };