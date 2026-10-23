const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const normalize = require("./normalize");
const dict = require("./dictionaries");
const service = require("./service");
const matcher = require("./matcher");
const history = require("./history");

const P = config.get("configDatabase").prefix;

const STATUSES = ["active", "blocked", "archived"];
const GENDERS = ["unknown", "male", "female", "other"];
const LABELS = ["personal", "work", "other"];

function httpErr(status, message) {
	const e = new Error(message);
	e.status = status;
	return e;
}
const t = (v, max) => normalize.cleanText(v, max);
const intOrNull = (v) => (v === null || v === undefined || v === "" ? null : parseInt(v, 10) || null);
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? v : null);

async function lockClient(conn, id) {
	const [[c]] = await conn.query(`SELECT id, kind, country FROM ${P}clients WHERE id = ? AND deleted_at IS NULL AND id_merged_into IS NULL FOR UPDATE`, [id]);
	if (!c) throw httpErr(404, "Клієнта не знайдено.");
	return c;
}

// Контекст історії: готовий з роуту або просто id користувача
const H = (h) => (h && h.batch ? h : history.ctx({ id_user: h }));

async function one(conn, table, id) {
	const [[r]] = await conn.query(`SELECT * FROM ${P}${table} WHERE id = ? LIMIT 1`, [id]);
	return r || null;
}
const row = (action, idClient, entity, idEntity, field, oldV, newV) => ({ id_client: idClient, action, entity, id_entity: idEntity, field, value_old: oldV, value_new: newV });
const diffRows = (idClient, entity, idEntity, before, after, fields) => history.diff(before, after, fields).map((ch) => ({ id_client: idClient, action: "updated", entity, id_entity: idEntity, ...ch }));

const CP_FIELDS = ["value", "country", "is_valid", "label", "is_primary", "marketing_consent"];
const ADDR_FIELDS = ["id_address_type", "recipient_name", "recipient_phone", "country", "region", "city", "street", "building", "apartment", "address_line", "postcode", "carrier_code", "carrier_point_name", "comment", "is_default"];
const IDENT_FIELDS = ["value", "country", "is_verified"];
const REL_FIELDS = ["title", "is_primary", "valid_from", "valid_to", "note"];
const COM_FIELDS = ["price_group", "discount_percent", "credit_limit", "payment_terms_days", "currency", "default_payment_method", "vat_payer"];

async function tx(fn) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const r = await fn(conn);
		await conn.commit();
		return r;
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

// ─────────────────────────────────────────────
// Профіль
// ─────────────────────────────────────────────
async function updateProfile(id, b, h) {
	const hc = H(h);
	const idUser = hc.id_user;
	return tx(async (conn) => {
		const c = await lockClient(conn, id);
		const before = await service.snapshot(conn, id);
		const [[noteBefore]] = await conn.query(`SELECT note FROM ${P}clients WHERE id = ?`, [id]);

		let idLegal = intOrNull(b.id_legal_type);
		if (idLegal) {
			const lt = await dict.byId("legal_types", idLegal);
			if (!lt || lt.kind !== c.kind) throw httpErr(400, "Правова форма не відповідає типу клієнта.");
		}
		let idLife = intOrNull(b.id_lifecycle);
		if (idLife && !(await dict.byId("lifecycle_stages", idLife))) throw httpErr(400, "Невідома стадія.");

		const status = STATUSES.includes(b.status) ? b.status : "active";
		const country = normalize.country(b.country);

		let timezone = t(b.timezone, 64) || null;
		if (timezone) {
			try {
				new Intl.DateTimeFormat("en", { timeZone: timezone });
			} catch (e) {
				throw httpErr(400, "Невідомий часовий пояс.");
			}
		}

		const idManager = intOrNull(b.id_manager);
		if (idManager) {
			const [[u]] = await conn.query(`SELECT id FROM ${P}users WHERE id = ? LIMIT 1`, [idManager]);
			if (!u) throw httpErr(400, "Менеджера не знайдено.");
		}

		await conn.query(
			`UPDATE ${P}clients SET
                id_legal_type = ?, id_lifecycle = ?, status = ?, country = ?, timezone = ?,
                id_lang = ?, id_manager = ?, note = ?, id_user_edit = ?, date_edit = NOW()
             WHERE id = ?`,
			[idLegal, idLife, status, country, timezone, intOrNull(b.id_lang), idManager, t(b.note, 5000) || null, idUser || null, id]
		);

		if (c.kind === "person") {
			const p = b.person || {};
			const gender = GENDERS.includes(p.gender) ? p.gender : "unknown";
			await conn.query(
				`INSERT INTO ${P}clients_persons (id_client, last_name, first_name, middle_name, gender, birth_date, job_title, trade_name)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    last_name = VALUES(last_name), first_name = VALUES(first_name), middle_name = VALUES(middle_name),
                    gender = VALUES(gender), birth_date = VALUES(birth_date), job_title = VALUES(job_title), trade_name = VALUES(trade_name)`,
				[id, t(p.last_name), t(p.first_name), t(p.middle_name), gender, dateOrNull(p.birth_date), t(p.job_title), t(p.trade_name)]
			);
		} else if (c.kind === "organization") {
			const o = b.organization || {};
			const emp = intOrNull(o.employees_count);
			await conn.query(
				`INSERT INTO ${P}clients_organizations (id_client, legal_name, short_name, industry, website, employees_count, registration_date, country)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    legal_name = VALUES(legal_name), short_name = VALUES(short_name), industry = VALUES(industry),
                    website = VALUES(website), employees_count = VALUES(employees_count),
                    registration_date = VALUES(registration_date), country = VALUES(country)`,
				[id, t(o.legal_name, 500), t(o.short_name), t(o.industry), t(o.website), emp && emp > 0 ? emp : null, dateOrNull(o.registration_date), country]
			);
		}

		await service.refreshDisplayName(conn, id);

		const after = await service.snapshot(conn, id);
		const [[noteAfter]] = await conn.query(`SELECT note FROM ${P}clients WHERE id = ?`, [id]);
		await history.write(conn, hc, [...service.snapshotDiff(id, before, after), ...diffRows(id, "client", id, noteBefore, noteAfter, ["note"])]);
		return { ok: true };
	});
}

// ─────────────────────────────────────────────
// Теги
// ─────────────────────────────────────────────
async function setTags(id, tagIds, h) {
	const hc = H(h);
	const idUser = hc.id_user;
	const ids = [...new Set((Array.isArray(tagIds) ? tagIds : []).map((x) => parseInt(x, 10)).filter(Boolean))];
	return tx(async (conn) => {
		await lockClient(conn, id);
		const [prev] = await conn.query(`SELECT id_tag FROM ${P}clients_tag_links WHERE id_client = ?`, [id]);
		if (ids.length) {
			await conn.query(`DELETE FROM ${P}clients_tag_links WHERE id_client = ? AND id_tag NOT IN (?)`, [id, ids]);
			for (const idTag of ids) {
				if (!(await dict.byId("tags", idTag))) continue;
				await conn.query(`INSERT IGNORE INTO ${P}clients_tag_links (id_client, id_tag, id_user, date_add) VALUES (?, ?, ?, NOW())`, [id, idTag, idUser || null]);
			}
		} else {
			await conn.query(`DELETE FROM ${P}clients_tag_links WHERE id_client = ?`, [id]);
		}
		const [next] = await conn.query(`SELECT id_tag FROM ${P}clients_tag_links WHERE id_client = ?`, [id]);
		const was = new Set(prev.map((r) => r.id_tag));
		const now = new Set(next.map((r) => r.id_tag));
		await history.write(conn, hc, [
			...[...now].filter((x) => !was.has(x)).map((x) => row("added", id, "tag", x, null, null, x)),
			...[...was].filter((x) => !now.has(x)).map((x) => row("removed", id, "tag", x, null, x, null)),
		]);
		return { ok: true };
	});
}

// ─────────────────────────────────────────────
// Контакти
// ─────────────────────────────────────────────
async function prepareContact(typeRow, value, country) {
	const n = normalize.contact(typeRow, value, country);
	if (!n) throw httpErr(400, "Вкажіть значення.");
	if (typeRow.code === "email" && !n.valid) throw httpErr(400, "Невірний email.");
	return n;
}

// Хто ще має цей контакт (для попередження й кандидатів у дублі)
async function othersWith(conn, id, typeRow, normalized) {
	if (Number(typeRow.use_for_dedup) === 0) return [];
	const [rows] = await conn.query(
		`SELECT DISTINCT cp.id_client, c.display_name
           FROM ${P}clients_contact_points cp
           INNER JOIN ${P}clients c ON c.id = cp.id_client
          WHERE cp.id_contact_type = ? AND cp.value_normalized = ? AND cp.id_client <> ?
            AND c.deleted_at IS NULL AND c.id_merged_into IS NULL`,
		[typeRow.id, normalized, id]
	);
	return rows;
}

async function addContact(id, b, h) {
	const hc = H(h);
	const typeRow = await dict.byId("contact_types", b.id_contact_type);
	if (!typeRow || Number(typeRow.active) !== 1) throw httpErr(400, "Невідомий тип контакту.");

	return tx(async (conn) => {
		const c = await lockClient(conn, id);
		const n = await prepareContact(typeRow, b.value, c.country);

		const [[same]] = await conn.query(`SELECT id FROM ${P}clients_contact_points WHERE id_client = ? AND id_contact_type = ? AND value_normalized = ? LIMIT 1`, [id, typeRow.id, n.normalized]);
		if (same) throw httpErr(409, "Такий контакт у клієнта вже є.");

		const [[prim]] = await conn.query(`SELECT COUNT(*) AS n FROM ${P}clients_contact_points WHERE id_client = ? AND id_contact_type = ? AND is_primary = 1`, [id, typeRow.id]);
		const makePrimary = b.is_primary ? 1 : Number(prim.n) === 0 ? 1 : 0;
		if (makePrimary && Number(prim.n) > 0) {
			await conn.query(`UPDATE ${P}clients_contact_points SET is_primary = 0 WHERE id_client = ? AND id_contact_type = ?`, [id, typeRow.id]);
		}

		const consent = b.marketing_consent ? 1 : 0;
		const [ins] = await conn.query(
			`INSERT INTO ${P}clients_contact_points
                (id_client, id_contact_type, value, value_normalized, country, is_valid, label, is_primary,
                 marketing_consent, consent_date, source, date_add, date_edit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', NOW(), NOW())`,
			[id, typeRow.id, n.value, n.normalized, n.country || null, n.valid ? 1 : 0, LABELS.includes(b.label) ? b.label : "personal", makePrimary, consent, consent ? new Date() : null]
		);

		const others = await othersWith(conn, id, typeRow, n.normalized);
		if (others.length) {
			await matcher.saveCandidates(
				conn,
				id,
				others.map((o) => ({ id_client: o.id_client, score: 90, reasons: ["same_" + typeRow.code] }))
			);
		}

		await conn.query(`UPDATE ${P}clients SET date_edit = NOW() WHERE id = ?`, [id]);
		const log = [row("added", id, "contact", ins.insertId, typeRow.code, null, n.value)];
		if (makePrimary && Number(prim.n) > 0) log.push(row("updated", id, "contact", ins.insertId, "is_primary", 0, 1));
		await history.write(conn, hc, log);
		return { ok: true, id: ins.insertId, valid: !!n.valid, duplicates: others };
	});
}

async function updateContact(id, idCp, b, h) {
	const hc = H(h);
	return tx(async (conn) => {
		const c = await lockClient(conn, id);
		const [[cp]] = await conn.query(`SELECT * FROM ${P}clients_contact_points WHERE id = ? AND id_client = ? FOR UPDATE`, [idCp, id]);
		if (!cp) throw httpErr(404, "Контакт не знайдено.");
		const typeRow = await dict.byId("contact_types", cp.id_contact_type);

		const n = await prepareContact(typeRow, b.value, c.country);
		if (n.normalized !== cp.value_normalized) {
			const [[same]] = await conn.query(`SELECT id FROM ${P}clients_contact_points WHERE id_client = ? AND id_contact_type = ? AND value_normalized = ? AND id <> ? LIMIT 1`, [id, cp.id_contact_type, n.normalized, idCp]);
			if (same) throw httpErr(409, "Такий контакт у клієнта вже є.");
		}

		const consent = b.marketing_consent ? 1 : 0;
		await conn.query(
			`UPDATE ${P}clients_contact_points SET
                value = ?, value_normalized = ?, country = ?, is_valid = ?, label = ?,
                marketing_consent = ?, consent_date = IF(? = 1 AND marketing_consent = 0, NOW(), IF(? = 0, NULL, consent_date)),
                date_edit = NOW()
             WHERE id = ?`,
			[n.value, n.normalized, n.country || null, n.valid ? 1 : 0, LABELS.includes(b.label) ? b.label : cp.label, consent, consent, consent, idCp]
		);

		await history.write(conn, hc, diffRows(id, "contact", idCp, cp, await one(conn, "clients_contact_points", idCp), CP_FIELDS));

		const others = n.normalized !== cp.value_normalized ? await othersWith(conn, id, typeRow, n.normalized) : [];
		if (others.length) {
			await matcher.saveCandidates(
				conn,
				id,
				others.map((o) => ({ id_client: o.id_client, score: 90, reasons: ["same_" + typeRow.code] }))
			);
		}
		return { ok: true, valid: !!n.valid, duplicates: others };
	});
}

async function deleteContact(id, idCp, h) {
	const hc = H(h);
	return tx(async (conn) => {
		await lockClient(conn, id);
		const [[cp]] = await conn.query(`SELECT id, id_contact_type, is_primary, value FROM ${P}clients_contact_points WHERE id = ? AND id_client = ?`, [idCp, id]);
		if (!cp) throw httpErr(404, "Контакт не знайдено.");
		await conn.query(`DELETE FROM ${P}clients_contact_points WHERE id = ?`, [idCp]);

		// Основний видалено → основним стає найстаріший контакт цього типу
		if (Number(cp.is_primary) === 1) {
			await conn.query(`UPDATE ${P}clients_contact_points SET is_primary = 1 WHERE id_client = ? AND id_contact_type = ? ORDER BY id ASC LIMIT 1`, [id, cp.id_contact_type]);
		}
		const typeRow = await dict.byId("contact_types", cp.id_contact_type);
		await history.write(conn, hc, [row("removed", id, "contact", idCp, typeRow ? typeRow.code : String(cp.id_contact_type), cp.value, null)]);
		return { ok: true };
	});
}

async function setPrimaryContact(id, idCp, h) {
	const hc = H(h);
	return tx(async (conn) => {
		await lockClient(conn, id);
		const [[cp]] = await conn.query(`SELECT id, id_contact_type, is_primary FROM ${P}clients_contact_points WHERE id = ? AND id_client = ?`, [idCp, id]);
		if (!cp) throw httpErr(404, "Контакт не знайдено.");
		if (Number(cp.is_primary) !== 1) await history.write(conn, hc, [row("updated", id, "contact", idCp, "is_primary", 0, 1)]);
		await conn.query(`UPDATE ${P}clients_contact_points SET is_primary = IF(id = ?, 1, 0) WHERE id_client = ? AND id_contact_type = ?`, [idCp, id, cp.id_contact_type]);
		return { ok: true };
	});
}

// ─────────────────────────────────────────────
// Адреси
// ─────────────────────────────────────────────
function prepareAddress(b, clientCountry) {
	const a = {
		recipient_name: t(b.recipient_name),
		recipient_phone: t(b.recipient_phone, 64),
		country: normalize.country(b.country) || clientCountry || null,
		region: t(b.region),
		city: t(b.city),
		street: t(b.street),
		building: t(b.building, 64),
		apartment: t(b.apartment, 64),
		address_line: t(b.address_line, 500),
		postcode: t(b.postcode, 16),
		carrier_code: t(b.carrier_code, 32) || null,
		carrier_city_ref: t(b.carrier_city_ref, 64) || null,
		carrier_point_ref: t(b.carrier_point_ref, 64) || null,
		carrier_point_name: t(b.carrier_point_name),
		comment: t(b.comment, 500),
	};
	if (!a.city && !a.street && !a.address_line && !a.carrier_point_ref && !a.carrier_point_name) {
		throw httpErr(400, "Вкажіть місто, адресу або пункт видачі.");
	}
	return a;
}

// У кожного типу адрес має бути рівно одна основна
async function fixAddressDefaults(conn, id) {
	const [types] = await conn.query(`SELECT id_address_type, MIN(id) AS first_id FROM ${P}clients_addresses WHERE id_client = ? GROUP BY id_address_type HAVING SUM(is_default) = 0`, [id]);
	for (const r of types) await conn.query(`UPDATE ${P}clients_addresses SET is_default = 1 WHERE id = ?`, [r.first_id]);
}

async function saveAddress(id, idAddr, b, h) {
	const hc = H(h);
	const typeRow = await dict.byId("address_types", b.id_address_type);
	if (!typeRow) throw httpErr(400, "Невідомий тип адреси.");

	return tx(async (conn) => {
		const c = await lockClient(conn, id);
		const a = prepareAddress(b, c.country);
		const isNew = !idAddr;
		const before = idAddr ? await one(conn, "clients_addresses", idAddr) : null;

		if (idAddr) {
			const [[ex]] = await conn.query(`SELECT id FROM ${P}clients_addresses WHERE id = ? AND id_client = ?`, [idAddr, id]);
			if (!ex) throw httpErr(404, "Адресу не знайдено.");
			await conn.query(`UPDATE ${P}clients_addresses SET ?, id_address_type = ?, date_edit = NOW() WHERE id = ?`, [a, typeRow.id, idAddr]);
		} else {
			const [ins] = await conn.query(`INSERT INTO ${P}clients_addresses SET ?, id_client = ?, id_address_type = ?, is_default = 0, date_add = NOW(), date_edit = NOW()`, [a, id, typeRow.id]);
			idAddr = ins.insertId;
		}

		if (b.is_default) {
			await conn.query(`UPDATE ${P}clients_addresses SET is_default = IF(id = ?, 1, 0) WHERE id_client = ? AND id_address_type = ?`, [idAddr, id, typeRow.id]);
		}
		await fixAddressDefaults(conn, id);

		const after = await one(conn, "clients_addresses", idAddr);
		await history.write(conn, hc, isNew ? [row("added", id, "address", idAddr, String(typeRow.id), null, service.addressText(after))] : diffRows(id, "address", idAddr, before, after, ADDR_FIELDS));
		return { ok: true, id: idAddr };
	});
}

async function deleteAddress(id, idAddr, h) {
	const hc = H(h);
	return tx(async (conn) => {
		await lockClient(conn, id);
		const old = await one(conn, "clients_addresses", idAddr);
		const [r] = await conn.query(`DELETE FROM ${P}clients_addresses WHERE id = ? AND id_client = ?`, [idAddr, id]);
		if (!r.affectedRows) throw httpErr(404, "Адресу не знайдено.");
		await fixAddressDefaults(conn, id);
		await history.write(conn, hc, [row("removed", id, "address", idAddr, String(old.id_address_type), service.addressText(old), null)]);
		return { ok: true };
	});
}

async function setDefaultAddress(id, idAddr, h) {
	const hc = H(h);
	return tx(async (conn) => {
		await lockClient(conn, id);
		const [[a]] = await conn.query(`SELECT id_address_type, is_default FROM ${P}clients_addresses WHERE id = ? AND id_client = ?`, [idAddr, id]);
		if (!a) throw httpErr(404, "Адресу не знайдено.");
		if (Number(a.is_default) !== 1) await history.write(conn, hc, [row("updated", id, "address", idAddr, "is_default", 0, 1)]);
		await conn.query(`UPDATE ${P}clients_addresses SET is_default = IF(id = ?, 1, 0) WHERE id_client = ? AND id_address_type = ?`, [idAddr, id, a.id_address_type]);
		return { ok: true };
	});
}

// ─────────────────────────────────────────────
// Реквізити (ідентифікатори)
// ─────────────────────────────────────────────
async function saveIdentifier(id, idIdent, b, h) {
	const hc = H(h);
	return tx(async (conn) => {
		const c = await lockClient(conn, id);
		const isNew = !idIdent;
		const before = idIdent ? await one(conn, "clients_identifiers", idIdent) : null;

		let typeRow;
		if (idIdent) {
			const [[ex]] = await conn.query(`SELECT * FROM ${P}clients_identifiers WHERE id = ? AND id_client = ? FOR UPDATE`, [idIdent, id]);
			if (!ex) throw httpErr(404, "Реквізит не знайдено.");
			typeRow = await dict.byId("identifier_types", ex.id_identifier_type);
		} else {
			typeRow = await dict.byId("identifier_types", b.id_identifier_type);
			if (!typeRow || Number(typeRow.active) !== 1) throw httpErr(400, "Невідомий тип реквізиту.");
			if (typeRow.applies_kind !== "all" && typeRow.applies_kind !== c.kind) throw httpErr(400, "Цей тип реквізиту не застосовується до такого клієнта.");
		}

		const n = normalize.identifier(typeRow, b.value);
		if (!n) throw httpErr(400, "Вкажіть номер.");
		if (!n.valid) throw httpErr(400, "Невірний формат номера.");

		const [[same]] = await conn.query(`SELECT id FROM ${P}clients_identifiers WHERE id_client = ? AND id_identifier_type = ? AND value_normalized = ? AND id <> ? LIMIT 1`, [id, typeRow.id, n.normalized, idIdent || 0]);
		if (same) throw httpErr(409, "Такий реквізит у клієнта вже є.");

		const country = normalize.country(b.country) || typeRow.country || c.country || null;
		const verified = b.is_verified ? 1 : 0;

		if (idIdent) {
			await conn.query(`UPDATE ${P}clients_identifiers SET value = ?, value_normalized = ?, country = ?, is_verified = ? WHERE id = ?`, [n.value, n.normalized, country, verified, idIdent]);
		} else {
			const [ins] = await conn.query(`INSERT INTO ${P}clients_identifiers (id_client, id_identifier_type, value, value_normalized, country, is_verified, date_add) VALUES (?, ?, ?, ?, ?, ?, NOW())`, [id, typeRow.id, n.value, n.normalized, country, verified]);
			idIdent = ins.insertId;
		}
		await history.write(conn, hc, isNew ? [row("added", id, "identifier", idIdent, typeRow.code, null, n.value)] : diffRows(id, "identifier", idIdent, before, await one(conn, "clients_identifiers", idIdent), IDENT_FIELDS));

		// Унікальний номер в іншого клієнта — майже напевно той самий клієнт
		let others = [];
		if (Number(typeRow.is_unique) === 1) {
			[others] = await conn.query(
				`SELECT DISTINCT ci.id_client, c.display_name
                   FROM ${P}clients_identifiers ci
                   INNER JOIN ${P}clients c ON c.id = ci.id_client
                  WHERE ci.id_identifier_type = ? AND ci.value_normalized = ? AND ci.id_client <> ?
                    AND c.deleted_at IS NULL AND c.id_merged_into IS NULL`,
				[typeRow.id, n.normalized, id]
			);
			if (others.length) {
				await matcher.saveCandidates(
					conn,
					id,
					others.map((o) => ({ id_client: o.id_client, score: 100, reasons: ["same_" + typeRow.code] }))
				);
			}
		}
		return { ok: true, id: idIdent, duplicates: others };
	});
}

async function deleteIdentifier(id, idIdent, h) {
	const hc = H(h);
	return tx(async (conn) => {
		await lockClient(conn, id);
		const old = await one(conn, "clients_identifiers", idIdent);
		const [r] = await conn.query(`DELETE FROM ${P}clients_identifiers WHERE id = ? AND id_client = ?`, [idIdent, id]);
		if (!r.affectedRows) throw httpErr(404, "Реквізит не знайдено.");
		const typeRow = await dict.byId("identifier_types", old.id_identifier_type);
		await history.write(conn, hc, [row("removed", id, "identifier", idIdent, typeRow ? typeRow.code : String(old.id_identifier_type), old.value, null)]);
		return { ok: true };
	});
}

// ─────────────────────────────────────────────
// Зв'язки між клієнтами
// ─────────────────────────────────────────────
const kindFits = (need, kind) => need === "all" || need === kind;

// Зв'язок видно в історії обох клієнтів; value — «тип:від→до»
const relText = (r) => r.id_relationship_type + ":" + r.id_client_from + "→" + r.id_client_to;
const bothSides = (r, fn) => [r.id_client_from, r.id_client_to].flatMap((idc) => fn(idc));

async function addRelationship(id, b, h) {
	const hc = H(h);
	// rel = "<id типу>:out" (цей клієнт — from) або "<id типу>:in" (цей клієнт — to)
	const [typeId, dir] = String(b.rel || "").split(":");
	const typeRow = await dict.byId("relationship_types", typeId);
	if (!typeRow || Number(typeRow.active) !== 1 || !["out", "in"].includes(dir)) throw httpErr(400, "Невідомий тип зв'язку.");

	const idOther = parseInt(b.id_other, 10);
	if (!idOther) throw httpErr(400, "Оберіть клієнта.");
	if (idOther === id) throw httpErr(400, "Клієнт не може бути пов'язаний сам із собою.");

	return tx(async (conn) => {
		const c = await lockClient(conn, id);
		const [[o]] = await conn.query(`SELECT id, kind FROM ${P}clients WHERE id = ? AND deleted_at IS NULL AND id_merged_into IS NULL`, [idOther]);
		if (!o) throw httpErr(404, "Пов'язаного клієнта не знайдено.");

		const from = dir === "out" ? c : o;
		const to = dir === "out" ? o : c;
		if (!kindFits(typeRow.from_kind, from.kind) || !kindFits(typeRow.to_kind, to.kind)) {
			throw httpErr(400, "Цей тип зв'язку не підходить для обраних клієнтів.");
		}

		const [[dup]] = await conn.query(
			`SELECT id FROM ${P}clients_relationships
              WHERE id_relationship_type = ? AND valid_to IS NULL
                AND ((id_client_from = ? AND id_client_to = ?) OR (? = 1 AND id_client_from = ? AND id_client_to = ?))
              LIMIT 1`,
			[typeRow.id, from.id, to.id, Number(typeRow.is_symmetric) ? 1 : 0, to.id, from.id]
		);
		if (dup) throw httpErr(409, "Такий зв'язок уже існує.");

		const isPrimary = b.is_primary ? 1 : 0;
		if (isPrimary) {
			await conn.query(`UPDATE ${P}clients_relationships SET is_primary = 0 WHERE id_client_to = ? AND id_relationship_type = ?`, [to.id, typeRow.id]);
		}
		const [ins] = await conn.query(
			`INSERT INTO ${P}clients_relationships
                (id_client_from, id_client_to, id_relationship_type, title, is_primary, valid_from, valid_to, note, date_add, date_edit)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NOW(), NOW())`,
			[from.id, to.id, typeRow.id, t(b.title), isPrimary, dateOrNull(b.valid_from), t(b.note, 500)]
		);
		const nr = await one(conn, "clients_relationships", ins.insertId);
		await history.write(conn, hc, bothSides(nr, (idc) => [row("added", idc, "relationship", nr.id, String(nr.id_relationship_type), null, relText(nr))]));
		return { ok: true, id: ins.insertId };
	});
}

async function updateRelationship(id, idRel, b, h) {
	const hc = H(h);
	return tx(async (conn) => {
		await lockClient(conn, id);
		const [[r]] = await conn.query(`SELECT * FROM ${P}clients_relationships WHERE id = ? AND (id_client_from = ? OR id_client_to = ?) FOR UPDATE`, [idRel, id, id]);
		if (!r) throw httpErr(404, "Зв'язок не знайдено.");

		const validFrom = dateOrNull(b.valid_from);
		const validTo = dateOrNull(b.valid_to);
		if (validFrom && validTo && validTo < validFrom) throw httpErr(400, "Дата завершення раніша за дату початку.");

		const isPrimary = b.is_primary ? 1 : 0;
		if (isPrimary) {
			await conn.query(`UPDATE ${P}clients_relationships SET is_primary = 0 WHERE id_client_to = ? AND id_relationship_type = ? AND id <> ?`, [r.id_client_to, r.id_relationship_type, idRel]);
		}
		await conn.query(`UPDATE ${P}clients_relationships SET title = ?, is_primary = ?, valid_from = ?, valid_to = ?, note = ?, date_edit = NOW() WHERE id = ?`, [t(b.title), isPrimary, validFrom, validTo, t(b.note, 500), idRel]);
		const after = await one(conn, "clients_relationships", idRel);
		await history.write(conn, hc, bothSides(r, (idc) => diffRows(idc, "relationship", idRel, r, after, REL_FIELDS)));
		return { ok: true };
	});
}

// Завершити зв'язок сьогоднішньою датою (лишається в історії)
async function endRelationship(id, idRel, h) {
	const hc = H(h);
	return tx(async (conn) => {
		await lockClient(conn, id);
		const before = await one(conn, "clients_relationships", idRel);
		const [r] = await conn.query(
			`UPDATE ${P}clients_relationships SET valid_to = CURDATE(), is_primary = 0, date_edit = NOW()
              WHERE id = ? AND (id_client_from = ? OR id_client_to = ?) AND valid_to IS NULL`,
			[idRel, id, id]
		);
		if (!r.affectedRows) throw httpErr(404, "Активний зв'язок не знайдено.");
		const after = await one(conn, "clients_relationships", idRel);
		await history.write(conn, hc, bothSides(before, (idc) => diffRows(idc, "relationship", idRel, before, after, REL_FIELDS)));
		return { ok: true };
	});
}

async function deleteRelationship(id, idRel, h) {
	const hc = H(h);
	return tx(async (conn) => {
		await lockClient(conn, id);
		const old = await one(conn, "clients_relationships", idRel);
		const [r] = await conn.query(`DELETE FROM ${P}clients_relationships WHERE id = ? AND (id_client_from = ? OR id_client_to = ?)`, [idRel, id, id]);
		if (!r.affectedRows) throw httpErr(404, "Зв'язок не знайдено.");
		await history.write(conn, hc, bothSides(old, (idc) => [row("removed", idc, "relationship", idRel, String(old.id_relationship_type), relText(old), null)]));
		return { ok: true };
	});
}

// ─────────────────────────────────────────────
// Комерційні умови
// ─────────────────────────────────────────────
async function saveCommercial(id, b, h) {
	const hc = H(h);
	const num = (v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(String(v).replace(",", ".")));

	const discount = num(b.discount_percent) || 0;
	if (isNaN(discount) || discount < 0 || discount > 100) throw httpErr(400, "Знижка має бути від 0 до 100%.");
	const credit = num(b.credit_limit);
	if (credit !== null && (isNaN(credit) || credit < 0)) throw httpErr(400, "Невірний кредитний ліміт.");
	const terms = Math.max(0, Math.min(3650, parseInt(b.payment_terms_days, 10) || 0));
	const currency = /^[A-Z]{3}$/.test(String(b.currency || "").toUpperCase()) ? String(b.currency).toUpperCase() : null;

	return tx(async (conn) => {
		await lockClient(conn, id);
		const [[before]] = await conn.query(`SELECT * FROM ${P}clients_commercial WHERE id_client = ?`, [id]);
		await conn.query(
			`INSERT INTO ${P}clients_commercial
                (id_client, price_group, discount_percent, credit_limit, payment_terms_days, currency, default_payment_method, vat_payer, date_edit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE
                price_group = VALUES(price_group), discount_percent = VALUES(discount_percent), credit_limit = VALUES(credit_limit),
                payment_terms_days = VALUES(payment_terms_days), currency = VALUES(currency),
                default_payment_method = VALUES(default_payment_method), vat_payer = VALUES(vat_payer), date_edit = NOW()`,
			[id, t(b.price_group, 64), discount, credit, terms, currency, t(b.default_payment_method, 64), b.vat_payer ? 1 : 0]
		);
		const [[after]] = await conn.query(`SELECT * FROM ${P}clients_commercial WHERE id_client = ?`, [id]);
		await history.write(conn, hc, diffRows(id, "commercial", id, before, after, COM_FIELDS));
		return { ok: true };
	});
}

// ─────────────────────────────────────────────
// Створення клієнта вручну
// ─────────────────────────────────────────────
async function createClient(b, h, force) {
	const hc = H(h);
	const idUser = hc.id_user;
	const kind = ["person", "organization", "group"].includes(b.kind) ? b.kind : "person";

	let legalCode;
	const idLegal = intOrNull(b.id_legal_type);
	if (idLegal) {
		const lt = await dict.byId("legal_types", idLegal);
		if (!lt || lt.kind !== kind) throw httpErr(400, "Правова форма не відповідає типу клієнта.");
		legalCode = lt.code;
	}

	const person = kind === "person" ? { first_name: t(b.first_name), last_name: t(b.last_name), middle_name: t(b.middle_name) } : null;
	const name = t(b.name, 500);
	if (kind === "person" && !person.first_name && !person.last_name && !b.phone && !b.email) throw httpErr(400, "Вкажіть імʼя або контакт.");
	if (kind !== "person" && !name) throw httpErr(400, "Вкажіть назву.");

	const country = normalize.country(b.country);

	// Перевірка на дублі до створення (якщо менеджер не підтвердив свідомо)
	if (!force) {
		const found = (await require("./queries").candidatesFor({ email: b.email, phone: b.phone }, country)).filter((x) => x.score >= 90);
		if (found.length) {
			const e = httpErr(409, "Клієнт із такими контактами вже існує.");
			e.payload = { exists: found };
			throw e;
		}
	}

	const r = await service.resolveClient(
		{
			kind,
			legalTypeCode: legalCode,
			name: kind === "person" ? undefined : name,
			person,
			organization: kind === "organization" ? { legal_name: name } : undefined,
			contacts: [
				{ type: "phone", value: b.phone },
				{ type: "email", value: b.email },
			],
			country,
			source: "manual",
			idUser,
			idManager: intOrNull(b.id_manager) || idUser,
		},
		{ forceNew: true, history: hc }
	);
	if (!r.id_client) throw httpErr(400, "Недостатньо даних для створення клієнта.");
	return { ok: true, id_client: r.id_client };
}

// Пара — точно не дубль, більше не пропонувати
async function dismissDuplicate(idCandidate, h) {
	const hc = H(h);
	const [r] = await pool.query(`UPDATE ${P}clients_duplicate_candidates SET status = 'dismissed', id_user_resolved = ?, date_resolved = NOW() WHERE id = ? AND status = 'pending'`, [hc.id_user, idCandidate]);
	if (!r.affectedRows) throw httpErr(404, "Пару не знайдено або вже оброблено.");
	const [[p]] = await pool.query(`SELECT id_client_a, id_client_b FROM ${P}clients_duplicate_candidates WHERE id = ?`, [idCandidate]);
	if (p) {
		await history.write(null, hc, [row("dismissed", p.id_client_a, "duplicate", p.id_client_b, null, null, p.id_client_b), row("dismissed", p.id_client_b, "duplicate", p.id_client_a, null, null, p.id_client_a)]);
	}
	return { ok: true };
}

module.exports = {
	createClient,
	dismissDuplicate,
	updateProfile,
	setTags,
	addContact,
	updateContact,
	deleteContact,
	setPrimaryContact,
	saveAddress,
	deleteAddress,
	setDefaultAddress,
	saveIdentifier,
	deleteIdentifier,
	addRelationship,
	updateRelationship,
	endRelationship,
	deleteRelationship,
	saveCommercial,
};
