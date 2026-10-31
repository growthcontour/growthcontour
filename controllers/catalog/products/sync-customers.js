"use strict";

// Клієнти CRM → магазин: ім'я, контакти, згода на розсилку, адреси. Об'єднані дублікати не передаються.
const pool = require("../../../config/database/connection_pool");
const i18n = require("../../../config/i18n/i18n");
const LOCALE = process.env.APP_LOCALE || "uk";
const t = (phrase, vars) => i18n.__({ phrase, locale: LOCALE }, vars || {});
const config = require("../../../config/config");
const dict = require("../../clients/dictionaries");

const P = config.get("configDatabase").prefix;
const INACTIVE = ["blocked", "archived", "inactive", "deleted"];

const group = (rows, key) => {
	const m = new Map();
	for (const r of rows) {
		if (!m.has(r[key])) m.set(r[key], []);
		m.get(r[key]).push(r);
	}
	return m;
};

function source(idIntegration) {
	let phoneType = null;
	let emailType = null;
	const init = async () => {
		if (phoneType === null) {
			phoneType = (await dict.idOf("contact_types", "phone")) || 0;
			emailType = (await dict.idOf("contact_types", "email")) || 0;
		}
	};

	return {
		BATCH: 200,
		start: 0,
		resume: (crmId) => Number(crmId) || 0,
		count: async () => {
			const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}clients WHERE id_merged_into IS NULL`);
			return Number(r.n);
		},
		batch: async (after, size) => {
			await init();
			const [rows] = await pool.query(
				`SELECT c.id, c.kind, c.display_name, c.status, c.deleted_at, c.country, p.first_name, p.last_name, o.legal_name, o.short_name
				   FROM ${P}clients c
				   LEFT JOIN ${P}clients_persons p ON p.id_client = c.id
				   LEFT JOIN ${P}clients_organizations o ON o.id_client = c.id
				  WHERE c.id > ? AND c.id_merged_into IS NULL
				  ORDER BY c.id LIMIT ?`,
				[after, size]
			);
			if (!rows.length) return { items: [], next: after };

			const ids = rows.map((r) => r.id);
			const [[contacts], [addresses], [externals]] = await Promise.all([
				pool.query(
					`SELECT id_client, id_contact_type, value, value_normalized, is_valid, marketing_consent
					   FROM ${P}clients_contact_points WHERE id_client IN (?) ORDER BY is_primary DESC, id`,
					[ids]
				),
				pool.query(
					`SELECT id_client, recipient_name, country, region, city, street, building, apartment, address_line, postcode
					   FROM ${P}clients_addresses WHERE id_client IN (?) ORDER BY is_default DESC, id`,
					[ids]
				),
				// Покупець уже відомий сайту (прийшов із замовленням) — прив'язуємо до нього, без дубля
				pool.query(
					`SELECT id_client, external_id FROM ${P}clients_external_ids
					  WHERE \`system\` = 'site' AND id_integration = ? AND id_client IN (?) ORDER BY id DESC`,
					[idIntegration, ids]
				),
			]);

			const siteIdOf = new Map();
			for (const e of externals) {
				const num = String(e.external_id).match(/(\d+)$/);
				if (!siteIdOf.has(e.id_client) && num) siteIdOf.set(e.id_client, Number(num[1]));
			}

			const contactValue = (c) => (c ? String(Number(c.is_valid) === 1 ? c.value_normalized || c.value : c.value || "") : "");
			const contactsOf = group(contacts, "id_client");
			const addrOf = group(addresses, "id_client");

			const items = rows.map((r) => {
				const cps = contactsOf.get(r.id) || [];
				const email = cps.find((c) => c.id_contact_type === emailType);
				const phone = cps.find((c) => c.id_contact_type === phoneType);
				const company = r.short_name || r.legal_name || "";
				const firstname = r.first_name || (r.kind === "organization" ? company : "") || r.display_name || "";
				const lastname = r.last_name || "";

				return {
					crm_id: Number(r.id),
					oc_id: siteIdOf.get(r.id) || null,
					firstname,
					lastname,
					email: contactValue(email).toLowerCase(),
					telephone: contactValue(phone),
					newsletter: email && Number(email.marketing_consent) === 1 ? 1 : 0,
					status: r.deleted_at || INACTIVE.includes(String(r.status || "").toLowerCase()) ? 0 : 1,
					deleted: !!r.deleted_at,
					addresses: (addrOf.get(r.id) || []).map((a) => {
						const line = a.address_line || [a.street, a.building].filter(Boolean).join(", ");
						const [fn, ...ln] = String(a.recipient_name || "").trim().split(/\s+/);
						return {
							firstname: fn || firstname,
							lastname: ln.join(" ") || lastname,
							company,
							address_1: line,
							address_2: a.apartment ? t("catalog.common.apartment", { n: a.apartment }) : "",
							city: a.city || "",
							postcode: a.postcode || "",
							country: String(a.country || r.country || "").toUpperCase(),
							region: a.region || "",
						};
					}),
				};
			});
			return { items, next: rows[rows.length - 1].id };
		},

		// ID покупця на сайті → «Зовнішні ID» клієнта (і для зіставлення замовлень із сайту)
		afterBatch: async (items, results, idInteg) => {
			// Той самий формат, що й у замовленнях сайту: OC-CUST-15 / PS-CUST-15
			const [[integ]] = await pool.query(`SELECT platform FROM ${P}settings_integrations WHERE id = ?`, [idInteg]);
			const prefix = { opencart: "OC-CUST-", prestashop: "PS-CUST-" }[integ && integ.platform] || "";
			const rows = results.filter((x) => x.ok && x.id && x.ref).map((x) => [Number(x.ref), "site", Number(idInteg), prefix + String(x.id)]);
			if (!rows.length) return;
			await pool.query(
				`INSERT IGNORE INTO ${P}clients_external_ids (id_client, \`system\`, id_integration, external_id, date_add)
				 SELECT v.id_client, v.sys, v.id_integration, v.external_id, NOW()
				   FROM (${rows.map(() => "SELECT ? AS id_client, ? AS sys, ? AS id_integration, ? AS external_id").join(" UNION ALL ")}) v
				   JOIN ${P}clients c ON c.id = v.id_client`,
				rows.flat()
			);
		},
	};
}

module.exports = { source };