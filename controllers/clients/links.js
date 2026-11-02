const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const { resolveClient } = require("./service");
const stats = require("./stats");
const history = require("./history");

const P = config.get("configDatabase").prefix;

const parse = (v) => (v == null ? null : typeof v === "string" ? JSON.parse(v) : v);

async function loadContact(idContact) {
	const [[ct]] = await pool.query(
		`SELECT ct.id, ct.id_client, ct.external_id, ct.name, ct.first_name, ct.last_name,
                ct.username, ct.phone, ct.email, ct.timezone, ch.type AS channel_type
           FROM ${P}contact_center_contacts ct
           INNER JOIN ${P}contact_center_channels ch ON ch.id = ct.id_channel
          WHERE ct.id = ? LIMIT 1`,
		[idContact]
	);
	return ct || null;
}

/**
 * Прив'язати контакт чату до картки клієнта.
 * opts.force — повторно пройти resolveClient навіть для вже прив'язаного (з'явився телефон/email)
 * opts.extra — { name, phone, email } з форми або від менеджера
 */
async function linkChatContact(idContact, opts) {
	const o = opts || {};
	const x = o.extra || {};
	const ct = await loadContact(idContact);
	if (!ct) return null;

	// Уже прив'язаний і нових даних нема — лише позначаємо активність
	if (ct.id_client && !o.force) {
		await pool.query(`UPDATE ${P}clients SET date_last_activity = NOW() WHERE id = ?`, [ct.id_client]);
		return ct.id_client;
	}

	const contacts = [
		{ type: "phone", value: ct.phone },
		{ type: "email", value: ct.email },
		{ type: "phone", value: x.phone },
		{ type: "email", value: x.email },
	];
	const externalIds = [];

	if (ct.channel_type === "telegram" || ct.channel_type === "instagram") {
		externalIds.push({ system: ct.channel_type, external_id: ct.external_id });
		if (ct.username) contacts.push({ type: ct.channel_type, value: ct.username });
	} else if (ct.channel_type === "webchat") {
		// Анонімного відвідувача в клієнти не перетворюємо
		if (!ct.phone && !ct.email && !x.phone && !x.email) return ct.id_client || null;
		externalIds.push({ system: "webchat", external_id: ct.external_id });
	} else if (ct.channel_type) {
		externalIds.push({ system: ct.channel_type, external_id: ct.external_id });
	}

	const r = await resolveClient(
		{
			kind: "person",
			name: x.name || ct.name,
			person: { first_name: ct.first_name, last_name: ct.last_name },
			contacts,
			externalIds,
			timezone: ct.timezone,
			lifecycleCode: "subscriber",
			source: "chat",
			sourceRef: String(ct.id),
		},
		{ createIfMissing: true, history: o.history }
	);

	if (r.id_client && r.id_client !== ct.id_client) {
		await pool.query(`UPDATE ${P}contact_center_contacts SET id_client = ? WHERE id = ?`, [r.id_client, ct.id]);
		await history.linked(null, o.history || history.ctxSystem("chat", ct.id), "chat_contact", ct.id, r.id_client, ct.id_client, ct.channel_type, [ct.channel_type, ct.username || ct.name].filter(Boolean).join(": "));
	}
	return r.id_client;
}

/** Відвідувач веб-чату залишив контакти у формі */
async function linkWebchatVisitor({ siteId, roomId, name, phone, email }) {
	const [[ct]] = await pool.query(
		`SELECT ct.id
           FROM ${P}contact_center_contacts ct
           INNER JOIN ${P}contact_center_channel_webchat w ON w.id_channel = ct.id_channel
          WHERE w.site_id = ? AND ct.external_id = ? LIMIT 1`,
		[siteId, roomId]
	);

	if (ct) {
		// Контакт чату отримує телефон/email, якщо їх ще не було
		await pool.query(
			`UPDATE ${P}contact_center_contacts SET
                phone = COALESCE(NULLIF(phone, ''), ?),
                email = COALESCE(NULLIF(email, ''), ?),
                name  = COALESCE(NULLIF(name, ''), ?)
             WHERE id = ?`,
			[phone || null, email || null, name || null, ct.id]
		);
		return linkChatContact(ct.id, { force: true, extra: { name, phone, email } });
	}

	// Діалог ще не віддзеркалився в CRM — прив'язуємо лише за даними форми
	const r = await resolveClient(
		{
			kind: "person",
			name,
			contacts: [
				{ type: "phone", value: phone },
				{ type: "email", value: email },
			],
			externalIds: [{ system: "webchat", external_id: roomId }],
			lifecycleCode: "lead",
			source: "chat",
			sourceRef: roomId,
		},
		{ createIfMissing: true }
	);
	return r.id_client;
}

/** Менеджер створює щось із діалогу: контакт чату + те, що менеджер ввів */
async function linkFromConversation(idConversation, extra, idUser) {
	const x = extra || {};
	const [[cv]] = await pool.query(`SELECT id_contact FROM ${P}contact_center_conversations WHERE id = ? LIMIT 1`, [idConversation]);
	if (!cv) return null;
	const h = history.ctxSystem("chat", "conv:" + idConversation, idUser);

	let idClient = await linkChatContact(cv.id_contact, { force: true, extra: x, history: h });

	// Анонімний веб-чат, але менеджер ввів хоча б ім'я — створюємо картку свідомо
	if (!idClient && (x.name || x.phone || x.email)) {
		const r = await resolveClient(
			{
				kind: "person",
				name: x.name,
				contacts: [
					{ type: "phone", value: x.phone },
					{ type: "email", value: x.email },
				],
				source: "chat",
				sourceRef: String(idConversation),
			},
			{ createIfMissing: true, history: h }
		);
		idClient = r.id_client;
		if (idClient) {
			await pool.query(`UPDATE ${P}contact_center_contacts SET id_client = ? WHERE id = ?`, [idClient, cv.id_contact]);
			await history.linked(null, h, "chat_contact", cv.id_contact, idClient, null, "webchat", x.name || null);
		}
	}
	return idClient;
}

/** Прив'язати лід за його contact_info (створення або зміна контактів у картці ліда) */
async function linkLead(idLead, idUser) {
	const [[l]] = await pool.query(`SELECT id, id_client, contact_info, id_manager FROM ${P}leads WHERE id = ? LIMIT 1`, [idLead]);
	if (!l) return null;

	const ci = parse(l.contact_info) || {};
	if (!ci.phone && !ci.email && !ci.name) return l.id_client || null;

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
			idUser,
		},
		{ createIfMissing: true }
	);

	if (r.id_client && r.id_client !== l.id_client) {
		await pool.query(`UPDATE ${P}leads SET id_client = ? WHERE id = ?`, [r.id_client, l.id]);
		await history.linked(null, history.ctxSystem("lead", l.id, idUser), "lead", l.id, r.id_client, l.id_client, "buyer", ci.name || null);
		await stats.recalc(null, r.id_client);
		if (l.id_client) await stats.recalc(null, l.id_client);
	}
	return r.id_client;
}

module.exports = { linkChatContact, linkWebchatVisitor, linkFromConversation, linkLead };