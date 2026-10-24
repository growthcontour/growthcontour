"use strict";

/**
 * Акаунти НП: кілька ключів API (кілька ФОП / магазинів). У кожного — відправник і умови за замовчуванням,
 * і список магазинів (інтеграцій), для яких він підставляється в нові відправлення.
 */
const { pool, P, httpErr, isRef, str, num, json } = require("./common");
const api = require("./api");

const PAYERS = ["Recipient", "Sender"];
const PAYMENT = ["Cash", "NonCash"];
const CARGO = ["Parcel", "Cargo", "Documents"];

const DEFAULTS = {
	sender: { counterparty_ref: null, counterparty: null, contact_ref: null, contact: null, phone: null, city_ref: null, city: null, warehouse_ref: null, warehouse: null },
	payer: "Recipient",
	payment_method: "Cash",
	cargo_type: "Parcel",
	description: "Товари",
	default_weight: 0.5,
	// Наложений платіж: якщо назва чи код оплати замовлення містить одне з цих слів
	cod_keywords: "наложен, накладен, післяплат, при отриманні, cod",
	declared_from_total: true,
};

const mask = (k) => (k ? String(k).slice(0, 4) + "…" + String(k).slice(-4) : "");

function publicRow(r, withKey) {
	return {
		id: Number(r.id),
		name: r.name,
		api_key: withKey ? r.api_key : mask(r.api_key),
		status: Number(r.status),
		is_default: Number(r.is_default),
		settings: { ...DEFAULTS, ...json(r.settings, {}), sender: { ...DEFAULTS.sender, ...((json(r.settings, {}) || {}).sender || {}) } },
		integrations: (json(r.integrations, []) || []).map(Number),
	};
}

async function list() {
	const [rows] = await pool.query(`SELECT * FROM ${P}np_accounts ORDER BY is_default DESC, name`);
	return rows.map((r) => publicRow(r));
}

async function get(id, withKey) {
	const [[r]] = await pool.query(`SELECT * FROM ${P}np_accounts WHERE id = ?`, [id]);
	if (!r) throw httpErr(404, "modules.novaposhta.e.account_not_found");
	return publicRow(r, withKey);
}

/** Акаунт для магазину: прив'язаний до інтеграції → за замовчуванням → перший активний */
async function forIntegration(idIntegration) {
	const [rows] = await pool.query(`SELECT * FROM ${P}np_accounts WHERE status = 1 ORDER BY is_default DESC, id`);
	const own = rows.find((r) => (json(r.integrations, []) || []).map(Number).includes(Number(idIntegration)));
	const r = own || rows[0];
	return r ? publicRow(r, true) : null;
}

function cleanSettings(s) {
	s = s && typeof s === "object" ? s : {};
	const snd = s.sender && typeof s.sender === "object" ? s.sender : {};
	return {
		sender: {
			counterparty_ref: isRef(snd.counterparty_ref) ? snd.counterparty_ref : null,
			counterparty: str(snd.counterparty, 255),
			contact_ref: isRef(snd.contact_ref) ? snd.contact_ref : null,
			contact: str(snd.contact, 255),
			phone: str(String(snd.phone || "").replace(/[^\d+]/g, ""), 20),
			city_ref: isRef(snd.city_ref) ? snd.city_ref : null,
			city: str(snd.city, 200),
			warehouse_ref: isRef(snd.warehouse_ref) ? snd.warehouse_ref : null,
			warehouse: str(snd.warehouse, 512),
		},
		payer: PAYERS.includes(s.payer) ? s.payer : DEFAULTS.payer,
		payment_method: PAYMENT.includes(s.payment_method) ? s.payment_method : DEFAULTS.payment_method,
		cargo_type: CARGO.includes(s.cargo_type) ? s.cargo_type : DEFAULTS.cargo_type,
		description: str(s.description, 100) || DEFAULTS.description,
		default_weight: Math.min(1000, Math.max(0.1, num(s.default_weight) || DEFAULTS.default_weight)),
		cod_keywords: str(s.cod_keywords, 500) || DEFAULTS.cod_keywords,
		declared_from_total: s.declared_from_total === undefined ? true : !!s.declared_from_total,
	};
}

/** Зберегти. Новий ключ (або змінений) перевіряється запитом до НП */
async function save(id, body) {
	body = body || {};
	const name = str(body.name, 128);
	if (!name) throw httpErr(400, "modules.novaposhta.e.name_required");
	let key = str(body.api_key, 64);
	let cur = null;
	if (id) cur = await get(id, true);
	if (!key || key.includes("…")) key = cur ? cur.api_key : null;
	if (!key) throw httpErr(400, "modules.novaposhta.e.key_required");
	if (!cur || cur.api_key !== key) await api.call(key, "Counterparty", "getCounterparties", { CounterpartyProperty: "Sender", Page: "1" });

	const settings = cleanSettings(body.settings);
	const integrations = Array.isArray(body.integrations) ? [...new Set(body.integrations.map(Number).filter((n) => n > 0))] : [];
	const isDefault = body.is_default ? 1 : 0;
	const status = body.status === undefined ? 1 : body.status ? 1 : 0;

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		if (isDefault) await conn.query(`UPDATE ${P}np_accounts SET is_default = 0`);
		// Магазин — лише в одному акаунті
		if (integrations.length) {
			const [others] = await conn.query(`SELECT id, integrations FROM ${P}np_accounts WHERE id <> ?`, [id || 0]);
			for (const o of others) {
				const list = (json(o.integrations, []) || []).map(Number);
				const left = list.filter((x) => !integrations.includes(x));
				if (left.length !== list.length) await conn.query(`UPDATE ${P}np_accounts SET integrations = ? WHERE id = ?`, [JSON.stringify(left), o.id]);
			}
		}
		if (id) {
			await conn.query(`UPDATE ${P}np_accounts SET name = ?, api_key = ?, status = ?, is_default = ?, settings = ?, integrations = ?, date_edit = NOW() WHERE id = ?`, [name, key, status, isDefault, JSON.stringify(settings), JSON.stringify(integrations), id]);
		} else {
			const [r] = await conn.query(
				`INSERT INTO ${P}np_accounts (name, api_key, status, is_default, settings, integrations, date_add, date_edit) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
				[name, key, status, isDefault, JSON.stringify(settings), JSON.stringify(integrations)]
			);
			id = r.insertId;
		}
		// Перший акаунт — за замовчуванням
		const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM ${P}np_accounts WHERE is_default = 1`);
		if (!Number(n)) await conn.query(`UPDATE ${P}np_accounts SET is_default = 1 WHERE id = ?`, [id]);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	return get(id);
}

async function remove(id) {
	const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}orders_shipments WHERE carrier = 'novaposhta' AND tracking_number IS NOT NULL AND JSON_EXTRACT(raw, '$.account_id') = ?`, [id]);
	if (Number(n)) throw httpErr(409, "modules.novaposhta.e.account_in_use", { n });
	await pool.query(`DELETE FROM ${P}np_accounts WHERE id = ?`, [id]);
	return { ok: true };
}

/**
 * Відправники з НП для форми акаунта: контрагенти-відправники та їхні контактні особи (з телефонами).
 * key — новий ключ із форми (ще не збережений) або ключ збереженого акаунта
 */
async function senders(id, keyFromForm) {
	let key = str(keyFromForm, 64);
	if (!key || key.includes("…")) key = id ? (await get(id, true)).api_key : null;
	if (!key) throw httpErr(400, "modules.novaposhta.e.key_required");
	const { data } = await api.call(key, "Counterparty", "getCounterparties", { CounterpartyProperty: "Sender", Page: "1" });
	const out = [];
	for (const c of data.slice(0, 20)) {
		let contacts = [];
		try {
			contacts = (await api.call(key, "Counterparty", "getCounterpartyContactPersons", { Ref: c.Ref, Page: "1" })).data;
		} catch (e) {
			contacts = [];
		}
		out.push({
			counterparty_ref: c.Ref,
			counterparty: [c.OwnershipFormDescription, c.Description].filter(Boolean).join(" "),
			city_ref: isRef(c.City) && c.City !== "00000000-0000-0000-0000-000000000000" ? c.City : null,
			city: c.CityDescription || null,
			contacts: contacts.map((p) => ({ contact_ref: p.Ref, contact: p.Description, phone: p.Phones || null })),
		});
	}
	return out;
}

module.exports = { list, get, save, remove, senders, forIntegration, DEFAULTS };
