const crypto = require("crypto");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const normalize = require("./normalize");
const dict = require("./dictionaries");
const matcher = require("./matcher");
const history = require("./history");

const P = config.get("configDatabase").prefix;
const LOCK_TIMEOUT_SEC = 5;
const MAX_LOCKS = 10;

const KINDS = ["person", "organization", "group"];
const LABELS = ["personal", "work", "other"];

// ─────────────────────────────────────────────
// Підготовка: нормалізація всього, що прийшло
// ─────────────────────────────────────────────
async function prepare(input) {
	const kind = KINDS.includes(input.kind) ? input.kind : "person";

	const rawAddresses = Array.isArray(input.addresses) ? input.addresses : input.address ? [input.address] : [];
	const countryHint = normalize.country(input.country) || normalize.country(rawAddresses[0] && rawAddresses[0].country);

	// Канали зв'язку
	const contacts = [];
	for (const c of input.contacts || []) {
		if (!c || !c.type || c.value == null || String(c.value).trim() === "") continue;
		const typeRow = await dict.byCode("contact_types", c.type);
		if (!typeRow) continue;
		const n = normalize.contact(typeRow, c.value, countryHint);
		if (!n) continue;
		if (contacts.some((x) => x.typeRow.id === typeRow.id && x.normalized === n.normalized)) continue;
		contacts.push({
			typeRow,
			...n,
			label: LABELS.includes(c.label) ? c.label : "personal",
			marketing_consent: c.marketing_consent ? 1 : 0,
		});
	}

	// Ідентифікатори
	const identifiers = [];
	for (const i of input.identifiers || []) {
		if (!i || !i.type || !i.value) continue;
		const typeRow = await dict.byCode("identifier_types", i.type);
		if (!typeRow) continue;
		const n = normalize.identifier(typeRow, i.value);
		if (!n) continue;
		if (identifiers.some((x) => x.typeRow.id === typeRow.id && x.normalized === n.normalized)) continue;
		identifiers.push({ typeRow, ...n, country: normalize.country(i.country) || typeRow.country || countryHint || null });
	}

	// Зовнішні id (0 = без інтеграції)
	const externalIds = (input.externalIds || [])
		.filter((e) => e && e.system && e.external_id != null && String(e.external_id) !== "")
		.map((e) => ({
			system: String(e.system).slice(0, 32),
			id_integration: Number(e.id_integration) || 0,
			external_id: String(e.external_id).slice(0, 191),
		}));

	// Адреси
	const addresses = [];
	for (const a of rawAddresses) {
		if (!a) continue;
		const typeRow = await dict.byCode("address_types", a.type || "shipping");
		if (!typeRow) continue;
		const t = (v, max) => normalize.cleanText(v, max);
		const addr = {
			id_address_type: typeRow.id,
			recipient_name: t(a.recipient_name, 255),
			recipient_phone: t(a.recipient_phone, 64),
			country: normalize.country(a.country) || countryHint || null,
			region: t(a.region, 255),
			city: t(a.city, 255),
			street: t(a.street, 255),
			building: t(a.building, 64),
			apartment: t(a.apartment, 64),
			address_line: t(a.address_line, 500),
			postcode: t(a.postcode, 16),
			carrier_code: a.carrier_code ? t(a.carrier_code, 32) : null,
			carrier_city_ref: a.carrier_city_ref ? t(a.carrier_city_ref, 64) : null,
			carrier_point_ref: a.carrier_point_ref ? t(a.carrier_point_ref, 64) : null,
			carrier_point_name: t(a.carrier_point_name, 255),
			comment: t(a.comment, 500),
			is_default: a.is_default ? 1 : 0,
		};
		// Порожня адреса нам не потрібна
		if (!addr.city && !addr.street && !addr.address_line && !addr.carrier_point_ref) continue;
		addresses.push(addr);
	}

	// Ролі
	const roleIds = [];
	for (const code of input.roles || []) {
		const id = await dict.idOf("role_types", code);
		if (id && !roleIds.includes(id)) roleIds.push(id);
	}

	// Правова форма (за замовчуванням: фізособа для людини)
	const legalCode = input.legalTypeCode || (kind === "person" ? "individual" : null);
	const id_legal_type = legalCode ? await dict.idOf("legal_types", legalCode) : null;

	// Стадія
	const lifecycleRow = input.lifecycleCode ? await dict.byCode("lifecycle_stages", input.lifecycleCode) : null;

	// Людина / організація
	const t = (v, max) => normalize.cleanText(v, max);
	const src = input.person || {};
	const person =
		kind === "person"
			? {
					first_name: t(src.first_name || (!src.last_name ? input.name : ""), 255),
					last_name: t(src.last_name, 255),
					middle_name: t(src.middle_name, 255),
					gender: ["male", "female", "other"].includes(src.gender) ? src.gender : "unknown",
					birth_date: /^\d{4}-\d{2}-\d{2}$/.test(String(src.birth_date || "")) ? src.birth_date : null,
					job_title: t(src.job_title, 255),
					trade_name: t(src.trade_name, 255),
				}
			: null;

	const so = input.organization || {};
	const organization =
		kind === "organization"
			? {
					legal_name: t(so.legal_name || input.name, 500),
					short_name: t(so.short_name, 255),
					industry: t(so.industry, 255),
					website: t(so.website, 255),
					country: normalize.country(so.country) || countryHint || null,
				}
			: null;

	// Країна клієнта: явна → з адреси → з першого валідного телефону
	const phoneCountry = (contacts.find((c) => c.typeRow.normalize === "phone" && c.valid && c.country) || {}).country || null;

	return {
		kind,
		id_legal_type,
		person,
		organization,
		display_name: normalize.displayName(kind, person, organization, input.name),
		contacts,
		identifiers,
		externalIds,
		addresses,
		roleIds,
		lifecycleRow,
		country: countryHint || phoneCountry,
		timezone: input.timezone ? t(input.timezone, 64) : null,
		currency: /^[A-Z]{3}$/.test(String(input.currency || "").toUpperCase()) ? String(input.currency).toUpperCase() : null,
		id_lang: Number(input.idLang) || null,
		id_manager: Number(input.idManager) || null,
		id_user: Number(input.idUser) || null,
		source: t(input.source || "manual", 32),
		source_ref: t(input.sourceRef != null ? String(input.sourceRef) : "", 255),
	};
}

function hasAnything(d) {
	return d.contacts.length || d.identifiers.length || d.externalIds.length || d.display_name;
}

// Ключі блокування: по одному на кожен нормалізований контакт/ідентифікатор/зовнішній id
function lockKeys(d) {
	const raw = [...d.contacts.map((c) => "c:" + c.typeRow.id + ":" + c.normalized), ...d.identifiers.filter((i) => Number(i.typeRow.is_unique) === 1).map((i) => "i:" + i.typeRow.id + ":" + i.normalized), ...d.externalIds.map((e) => "e:" + e.system + ":" + e.id_integration + ":" + e.external_id)];
	const keys = [...new Set(raw)].map(
		(k) =>
			"cl_" +
			crypto
				.createHash("sha1")
				.update(P + k)
				.digest("hex")
	);
	return keys.sort().slice(0, MAX_LOCKS);
}

// ─────────────────────────────────────────────
// Запис підтаблиць (спільне для create і attach)
// ─────────────────────────────────────────────
async function insertContacts(conn, idClient, d, log) {
	if (!d.contacts.length) return;
	const [existing] = await conn.query(`SELECT id_contact_type, MAX(is_primary) AS has_primary FROM ${P}clients_contact_points WHERE id_client = ? GROUP BY id_contact_type`, [idClient]);
	const hasPrimary = new Set(existing.filter((r) => Number(r.has_primary) === 1).map((r) => r.id_contact_type));

	for (const c of d.contacts) {
		const primary = hasPrimary.has(c.typeRow.id) ? 0 : 1;
		const [res] = await conn.query(
			`INSERT IGNORE INTO ${P}clients_contact_points
                (id_client, id_contact_type, value, value_normalized, country, is_valid, label, is_primary,
                 marketing_consent, consent_date, source, date_add, date_edit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
			[idClient, c.typeRow.id, c.value, c.normalized, c.country || null, c.valid ? 1 : 0, c.label, primary, c.marketing_consent, c.marketing_consent ? new Date() : null, d.source]
		);
		if (res.affectedRows && primary) hasPrimary.add(c.typeRow.id);
		if (res.affectedRows) log.push({ id_client: idClient, action: "added", entity: "contact", id_entity: res.insertId, field: c.typeRow.code, value_new: c.value });
	}
}

async function insertIdentifiers(conn, idClient, d, log) {
	for (const i of d.identifiers) {
		const [[ex]] = await conn.query(`SELECT id FROM ${P}clients_identifiers WHERE id_client = ? AND id_identifier_type = ? AND value_normalized = ? LIMIT 1`, [idClient, i.typeRow.id, i.normalized]);
		if (ex) continue;
		const [res] = await conn.query(
			`INSERT INTO ${P}clients_identifiers (id_client, id_identifier_type, value, value_normalized, country, is_verified, date_add)
             VALUES (?, ?, ?, ?, ?, 0, NOW())`,
			[idClient, i.typeRow.id, i.value, i.normalized, i.country]
		);
		log.push({ id_client: idClient, action: "added", entity: "identifier", id_entity: res.insertId, field: i.typeRow.code, value_new: i.value });
	}
}

async function insertExternalIds(conn, idClient, d, log) {
	for (const e of d.externalIds) {
		// Унікальний ключ глобальний: якщо id вже належить іншому клієнту — не перехоплюємо
		const [res] = await conn.query(
			`INSERT IGNORE INTO ${P}clients_external_ids (id_client, \`system\`, id_integration, external_id, date_add)
             VALUES (?, ?, ?, ?, NOW())`,
			[idClient, e.system, e.id_integration, e.external_id]
		);
		if (res.affectedRows) {
			log.push({ id_client: idClient, action: "added", entity: "external_id", id_entity: res.insertId, field: e.system, value_new: (e.id_integration ? e.id_integration + ":" : "") + e.external_id });
		}
	}
}

async function insertAddresses(conn, idClient, d, log) {
	for (const a of d.addresses) {
		const [[ex]] = await conn.query(
			`SELECT id FROM ${P}clients_addresses
              WHERE id_client = ? AND id_address_type = ?
                AND city = ? AND street = ? AND building = ? AND apartment = ?
                AND COALESCE(carrier_point_ref, '') = ?
              LIMIT 1`,
			[idClient, a.id_address_type, a.city, a.street, a.building, a.apartment, a.carrier_point_ref || ""]
		);
		if (ex) continue;

		// Перша адреса цього типу стає адресою за замовчуванням
		const [[cnt]] = await conn.query(`SELECT COUNT(*) AS n FROM ${P}clients_addresses WHERE id_client = ? AND id_address_type = ?`, [idClient, a.id_address_type]);
		const isDefault = a.is_default || Number(cnt.n) === 0 ? 1 : 0;
		if (isDefault && Number(cnt.n) > 0) {
			await conn.query(`UPDATE ${P}clients_addresses SET is_default = 0 WHERE id_client = ? AND id_address_type = ?`, [idClient, a.id_address_type]);
		}

		const [res] = await conn.query(
			`INSERT INTO ${P}clients_addresses
                (id_client, id_address_type, recipient_name, recipient_phone, country, region, city, street, building, apartment,
                 address_line, postcode, carrier_code, carrier_city_ref, carrier_point_ref, carrier_point_name, comment, is_default, date_add, date_edit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
			[idClient, a.id_address_type, a.recipient_name, a.recipient_phone, a.country, a.region, a.city, a.street, a.building, a.apartment, a.address_line, a.postcode, a.carrier_code, a.carrier_city_ref, a.carrier_point_ref, a.carrier_point_name, a.comment, isDefault]
		);
		log.push({ id_client: idClient, action: "added", entity: "address", id_entity: res.insertId, field: String(a.id_address_type), value_new: addressText(a) });
	}
}

async function insertRoles(conn, idClient, d, log) {
	for (const idRole of d.roleIds) {
		const [res] = await conn.query(`INSERT IGNORE INTO ${P}clients_roles (id_client, id_role_type, status, since) VALUES (?, ?, 'active', NOW())`, [idClient, idRole]);
		if (res.affectedRows) log.push({ id_client: idClient, action: "added", entity: "role", id_entity: idRole, value_new: idRole });
	}
}

async function writeChildren(conn, idClient, d, log) {
	await insertContacts(conn, idClient, d, log);
	await insertIdentifiers(conn, idClient, d, log);
	await insertExternalIds(conn, idClient, d, log);
	await insertAddresses(conn, idClient, d, log);
	await insertRoles(conn, idClient, d, log);
}

// Адреса одним рядком для історії
function addressText(a) {
	return [a.country, a.region, a.city, a.address_line || [a.street, a.building].filter(Boolean).join(" "), a.apartment ? "кв. " + a.apartment : "", a.carrier_point_name, a.postcode]
		.filter((x) => x && String(x).trim())
		.join(", ");
}

// Стан клієнта для порівняння «до / після»
const CLIENT_FIELDS = ["display_name", "id_lifecycle", "id_legal_type", "id_manager", "id_lang", "country", "timezone", "currency", "status"];
const PERSON_FIELDS = ["last_name", "first_name", "middle_name", "gender", "birth_date", "job_title", "trade_name"];
const ORG_FIELDS = ["legal_name", "short_name", "industry", "website", "employees_count", "registration_date", "country"];

async function snapshot(conn, idClient) {
	const [[client]] = await conn.query(`SELECT ${CLIENT_FIELDS.join(", ")} FROM ${P}clients WHERE id = ? LIMIT 1`, [idClient]);
	const [[person]] = await conn.query(`SELECT ${PERSON_FIELDS.join(", ")} FROM ${P}clients_persons WHERE id_client = ? LIMIT 1`, [idClient]);
	const [[org]] = await conn.query(`SELECT ${ORG_FIELDS.join(", ")} FROM ${P}clients_organizations WHERE id_client = ? LIMIT 1`, [idClient]);
	return { client: client || null, person: person || null, org: org || null };
}

// Різниця двох знімків → рядки історії
function snapshotDiff(idClient, before, after) {
	const out = [];
	const add = (entity, b, a, fields) => {
		if (!a && !b) return;
		for (const ch of history.diff(b, a, fields)) out.push({ id_client: idClient, action: "updated", entity, id_entity: idClient, ...ch });
	};
	add("client", before.client, after.client, CLIENT_FIELDS);
	add("person", before.person, after.person, PERSON_FIELDS);
	add("organization", before.org, after.org, ORG_FIELDS);
	return out;
}

// ─────────────────────────────────────────────
// Стадія: лише вгору (лід не «понижує» клієнта)
// ─────────────────────────────────────────────
async function upgradeLifecycleInConn(conn, idClient, stageRow) {
	if (!stageRow) return;
	const [[cur]] = await conn.query(`SELECT s.sort FROM ${P}clients c LEFT JOIN ${P}clients_lifecycle_stages s ON s.id = c.id_lifecycle WHERE c.id = ? LIMIT 1`, [idClient]);
	if (cur && cur.sort != null && Number(cur.sort) >= Number(stageRow.sort)) return;
	const [[old]] = await conn.query(`SELECT id_lifecycle FROM ${P}clients WHERE id = ? LIMIT 1`, [idClient]);
	await conn.query(`UPDATE ${P}clients SET id_lifecycle = ?, date_edit = NOW() WHERE id = ?`, [stageRow.id, idClient]);
	return { id_client: idClient, action: "updated", entity: "client", id_entity: idClient, field: "id_lifecycle", value_old: old ? old.id_lifecycle : null, value_new: stageRow.id };
}

// ─────────────────────────────────────────────
// Створення нового клієнта
// ─────────────────────────────────────────────
async function create(conn, d, log) {
	const [res] = await conn.query(
		`INSERT INTO ${P}clients
            (kind, id_legal_type, display_name, status, id_lifecycle, id_manager, source, source_ref,
             id_lang, country, timezone, currency, date_first_contact, date_last_activity, id_user_add, date_add, date_edit)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, NOW(), NOW())`,
		[d.kind, d.id_legal_type, d.display_name, d.lifecycleRow ? d.lifecycleRow.id : null, d.id_manager, d.source, d.source_ref, d.id_lang, d.country, d.timezone, d.currency, d.id_user]
	);
	const idClient = res.insertId;

	if (d.person) {
		const p = d.person;
		await conn.query(
			`INSERT INTO ${P}clients_persons (id_client, last_name, first_name, middle_name, gender, birth_date, job_title, trade_name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[idClient, p.last_name, p.first_name, p.middle_name, p.gender, p.birth_date, p.job_title, p.trade_name]
		);
	}
	if (d.organization) {
		const o = d.organization;
		await conn.query(
			`INSERT INTO ${P}clients_organizations (id_client, legal_name, short_name, industry, website, country)
             VALUES (?, ?, ?, ?, ?, ?)`,
			[idClient, o.legal_name, o.short_name, o.industry, o.website, o.country]
		);
	}

	log.push(
		{ id_client: idClient, action: "created", entity: "client", id_entity: idClient, field: "display_name", value_new: d.display_name },
		...history.rowsOf("added", idClient, "client", idClient, { kind: d.kind, id_legal_type: d.id_legal_type, id_lifecycle: d.lifecycleRow ? d.lifecycleRow.id : null, id_manager: d.id_manager, country: d.country, timezone: d.timezone, currency: d.currency, id_lang: d.id_lang }, ["kind", "id_legal_type", "id_lifecycle", "id_manager", "country", "timezone", "currency", "id_lang"])
	);
	if (d.person) log.push(...history.rowsOf("added", idClient, "person", idClient, d.person, PERSON_FIELDS.filter((f) => f !== "gender" || d.person.gender !== "unknown")));
	if (d.organization) log.push(...history.rowsOf("added", idClient, "organization", idClient, d.organization, ORG_FIELDS));

	await writeChildren(conn, idClient, d, log);
	return idClient;
}

// ─────────────────────────────────────────────
// Дописування до наявного (порожні поля заповнюємо, заповнені не чіпаємо)
// ─────────────────────────────────────────────
async function attach(conn, idClient, d, log) {
	const before = await snapshot(conn, idClient);
	await conn.query(
		`UPDATE ${P}clients SET
            country = COALESCE(country, ?),
            timezone = COALESCE(timezone, ?),
            currency = COALESCE(currency, ?),
            id_lang = COALESCE(id_lang, ?),
            id_manager = COALESCE(id_manager, ?),
            date_last_activity = NOW(),
            date_edit = NOW(),
            id_user_edit = COALESCE(?, id_user_edit)
         WHERE id = ?`,
		[d.country, d.timezone, d.currency, d.id_lang, d.id_manager, d.id_user, idClient]
	);

	const [[client]] = await conn.query(`SELECT kind FROM ${P}clients WHERE id = ? LIMIT 1`, [idClient]);

	if (client.kind === "person" && d.person) {
		const p = d.person;
		await conn.query(
			`INSERT INTO ${P}clients_persons (id_client, last_name, first_name, middle_name, gender, birth_date, job_title, trade_name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                last_name   = IF(last_name   = '', VALUES(last_name),   last_name),
                first_name  = IF(first_name  = '', VALUES(first_name),  first_name),
                middle_name = IF(middle_name = '', VALUES(middle_name), middle_name),
                gender      = IF(gender = 'unknown', VALUES(gender), gender),
                birth_date  = COALESCE(birth_date, VALUES(birth_date)),
                job_title   = IF(job_title   = '', VALUES(job_title),   job_title),
                trade_name  = IF(trade_name  = '', VALUES(trade_name),  trade_name)`,
			[idClient, p.last_name, p.first_name, p.middle_name, p.gender, p.birth_date, p.job_title, p.trade_name]
		);
	}
	if (client.kind === "organization" && d.organization) {
		const o = d.organization;
		await conn.query(
			`INSERT INTO ${P}clients_organizations (id_client, legal_name, short_name, industry, website, country)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                legal_name = IF(legal_name = '', VALUES(legal_name), legal_name),
                short_name = IF(short_name = '', VALUES(short_name), short_name),
                industry   = IF(industry   = '', VALUES(industry),   industry),
                website    = IF(website    = '', VALUES(website),    website),
                country    = COALESCE(country, VALUES(country))`,
			[idClient, o.legal_name, o.short_name, o.industry, o.website, o.country]
		);
	}

	await writeChildren(conn, idClient, d, log);
	await upgradeLifecycleInConn(conn, idClient, d.lifecycleRow);
	await refreshDisplayName(conn, idClient);

	// Дописані порожні поля (стадія й імʼя потрапляють сюди ж)
	log.push(...snapshotDiff(idClient, before, await snapshot(conn, idClient)));
}

// Перерахувати display_name з актуальних даних людини/організації
async function refreshDisplayName(conn, idClient) {
	const [[c]] = await conn.query(
		`SELECT c.kind, c.display_name,
                p.first_name, p.middle_name, p.last_name, p.trade_name,
                o.legal_name, o.short_name
           FROM ${P}clients c
           LEFT JOIN ${P}clients_persons p ON p.id_client = c.id
           LEFT JOIN ${P}clients_organizations o ON o.id_client = c.id
          WHERE c.id = ? LIMIT 1`,
		[idClient]
	);
	if (!c) return;
	const name = normalize.displayName(c.kind, c, c, c.display_name);
	if (name && name !== c.display_name) {
		await conn.query(`UPDATE ${P}clients SET display_name = ? WHERE id = ?`, [name, idClient]);
	}
}

// ─────────────────────────────────────────────
// ГОЛОВНА ФУНКЦІЯ
// ─────────────────────────────────────────────
/**
 * Знайти або створити клієнта за всім, що відомо.
 *
 * input: {
 *   kind: 'person' | 'organization' | 'group',
 *   name, person: {...}, organization: {...},
 *   legalTypeCode, country, timezone, currency, idLang,
 *   contacts:    [{ type: 'phone'|'email'|'telegram'..., value, label, marketing_consent }],
 *   identifiers: [{ type: 'edrpou'|'ipn'|'tax_id'..., value, country }],
 *   externalIds: [{ system: 'opencart'|'telegram'|'webchat'..., id_integration, external_id }],
 *   addresses:   [{ type: 'shipping'|'billing'..., country, city, street, carrier_code, carrier_point_ref, ... }],
 *   roles: ['customer'], lifecycleCode: 'customer',
 *   source: 'order'|'lead'|'chat'|'import'|'manual', sourceRef, idManager, idUser
 * }
 * opts: { conn (транзакція викликача), createIfMissing (true) }
 *
 * Повертає { id_client, created, score, candidates }
 */
async function resolveClient(input, opts) {
	const o = Object.assign({ createIfMissing: true }, opts || {});
	const d = await prepare(input || {});

	const ownConn = !o.conn;
	const conn = o.conn || (await pool.getConnection());
	const locks = lockKeys(d);
	const taken = [];

	try {
		for (const k of locks) {
			const [[r]] = await conn.query("SELECT GET_LOCK(?, ?) AS ok", [k, LOCK_TIMEOUT_SEC]);
			if (!r || Number(r.ok) !== 1) throw new Error("clients.resolveClient: lock timeout");
			taken.push(k);
		}

		if (ownConn) await conn.beginTransaction();

		const { best, candidates } = await matcher.findMatches({ contacts: d.contacts, identifiers: d.identifiers.filter((i) => i.valid), externalIds: d.externalIds }, conn);

		let idClient = null;
		let created = false;
		const log = [];

		if (best && !o.forceNew) {
			idClient = best.id_client;
			await attach(conn, idClient, d, log);
		} else if ((o.createIfMissing || o.forceNew) && hasAnything(d)) {
			idClient = await create(conn, d, log);
			created = true;
		}

		if (idClient) await matcher.saveCandidates(conn, idClient, candidates);

		// Історія: хто/звідки — з контексту викликача, інакше з source/sourceRef запиту
		const h = o.history || history.ctxSystem(d.source, d.source_ref, d.id_user);
		await history.write(conn, h, log);
		if (ownConn) await conn.commit();

		return { id_client: idClient, created, score: best ? best.score : 0, candidates };
	} catch (e) {
		if (ownConn) await conn.rollback().catch(() => {});
		throw e;
	} finally {
		for (const k of taken) await conn.query("SELECT RELEASE_LOCK(?)", [k]).catch(() => {});
		if (ownConn) conn.release();
	}
}

/** Підняти стадію клієнта (напр. після оплаченого замовлення → customer). Лише вгору. */
async function upgradeLifecycle(idClient, stageCode, conn, h) {
	const row = await dict.byCode("lifecycle_stages", stageCode);
	const ch = await upgradeLifecycleInConn(conn || pool, idClient, row);
	if (ch) await history.write(conn || pool, h || history.ctxSystem("system"), [ch]);
}

/** Позначити активність клієнта (нове повідомлення, замовлення...) */
async function touch(idClient, conn) {
	await (conn || pool).query(`UPDATE ${P}clients SET date_last_activity = NOW() WHERE id = ?`, [idClient]);
}

module.exports = { resolveClient, upgradeLifecycle, touch, refreshDisplayName, snapshot, snapshotDiff, addressText, PERSON_FIELDS, ORG_FIELDS };
