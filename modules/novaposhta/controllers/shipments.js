"use strict";

/**
 * Відправлення НП у замовленні (таблиця orders_shipments, carrier = 'novaposhta').
 * Чернетка створюється з адреси доставки замовлення (city_ref / warehouse_ref / meta.delivery від сайту);
 * чого сайт не передав — шукаємо в довіднику (назва міста, номер відділення). Неоднозначне — стан «review».
 * Дані відправлення — у raw (JSON): тип, отримувач, місто, точка, адреса, вага, місця, оголошена вартість, наложений платіж.
 */
const { pool, P, httpErr, isRef, str, num, json } = require("./common");
const directory = require("./directory");
const accounts = require("./accounts");
const api = require("./api");

const CARRIER = "novaposhta";
const SERVICES = ["warehouse", "postomat", "address"];
let DEFAULT_WEIGHT = 0.5;
const setDefaultWeight = (kg) => (DEFAULT_WEIGHT = Math.max(0.1, Number(kg) || 0.5));

const KG = { kg: 1, g: 0.001, lb: 0.453592, oz: 0.0283495 };

async function loadOrder(idOrder) {
	const [[o]] = await pool.query(
		`SELECT id, id_integration, total, total_products, total_shipping, currency_iso, custom_fields, client, is_paid FROM ${P}orders WHERE id = ?`,
		[idOrder]
	);
	if (!o) throw httpErr(404, "modules.novaposhta.e.order_not_found");
	const [[a]] = await pool.query(`SELECT * FROM ${P}orders_addresses WHERE id_order = ? AND type = 'shipping' ORDER BY id LIMIT 1`, [idOrder]);
	return { order: o, address: a || null };
}

/** Вага замовлення з товарів каталогу (кг); немає ваги — значення акаунта / модуля */
async function orderWeight(idOrder, fallback) {
	const [rows] = await pool.query(
		`SELECT i.quantity, p.weight, p.weight_unit FROM ${P}orders_items i LEFT JOIN ${P}products p ON p.id = i.id_product WHERE i.id_order = ? AND (i.type IS NULL OR i.type <> 'service')`,
		[idOrder]
	);
	let kg = 0;
	let unknown = 0;
	for (const r of rows) {
		const w = Number(r.weight);
		if (w > 0) kg += w * (KG[r.weight_unit] || 1) * (Number(r.quantity) || 1);
		else unknown += Number(r.quantity) || 1;
	}
	if (!kg) return Math.max(0.1, Number(fallback) || DEFAULT_WEIGHT);
	return Math.round(kg * 1000) / 1000;
}

/** Телефон для НП: 380XXXXXXXXX (з 0XXXXXXXXX, +380…, 80…) */
function normPhone(v) {
	let d = String(v || "").replace(/\D/g, "");
	if (/^0\d{9}$/.test(d)) d = "38" + d;
	else if (/^80\d{9}$/.test(d)) d = "3" + d;
	return d ? d.slice(0, 15) : null;
}

const isCod = (order, keywords) => {
	const cf = json(order.custom_fields, {}) || {};
	const pay = String(cf._payment_method || "").toLowerCase();
	return !!pay && String(keywords || "")
		.split(",")
		.map((x) => x.trim().toLowerCase())
		.filter(Boolean)
		.some((k) => pay.includes(k));
};

/** Отримувач: з адреси доставки; по батькові — якщо сайт передав */
function recipientOf(address, order) {
	const c = json(order.client, {}) || {};
	return {
		lastname: str((address && address.lastname) || c.lastname, 100),
		firstname: str((address && address.firstname) || c.firstname, 100),
		middlename: str(address && address.middlename, 100),
		phone: normPhone((address && address.phone) || c.phone),
	};
}

/**
 * Точка доставки з адреси замовлення. Порядок: ref від сайту (якщо є в довіднику) → місто за назвою → відділення за номером.
 * Повертає { service, city, point, address, found_by[], review[] }
 */
async function resolveFromAddress(address) {
	const meta = json(address && address.meta, {}) || {};
	const d = meta.delivery || {};
	const p = d.point || {};
	const review = [];
	const how = [];
	let service = SERVICES.includes(d.service) ? d.service : address && (address.warehouse_ref || address.warehouse) ? "warehouse" : "address";

	let city = null;
	const cityRef = (p.city && p.city.ref) || (address && address.city_ref);
	if (isRef(cityRef)) {
		city = await directory.city(cityRef);
		if (city) how.push("city:site");
	}
	if (!city) {
		const name = (p.city && p.city.name) || (address && address.city);
		city = await directory.cityByName(name, (p.area && p.area.name) || (address && address.region));
		if (city) how.push("city:name");
		else review.push(name ? "city_ambiguous" : "city_missing");
	}

	let point = null;
	if (service !== "address") {
		const ref = (p.warehouse && p.warehouse.ref) || (address && address.warehouse_ref);
		if (isRef(ref)) {
			point = await directory.warehouse(ref);
			if (point) how.push("point:site");
		}
		if (!point && city) {
			let n = p.warehouse && p.warehouse.number;
			if (!n) {
				const m = String((p.warehouse && p.warehouse.name) || (address && (address.warehouse || address.address_1)) || "").match(/№\s*(\d+)/u);
				n = m ? m[1] : null;
			}
			if (n) {
				point = await directory.warehouseByNumber(city.ref, n);
				if (point) how.push("point:number");
			}
		}
		if (point) {
			if (!city || city.ref !== point.city_ref) city = await directory.city(point.city_ref);
			service = point.type === "postomat" ? "postomat" : "warehouse";
		} else review.push("point_missing");
	}

	const addr = service === "address"
		? {
				street: str((d.address && d.address.street) || (address && address.address_1), 255),
				building: str((d.address && d.address.building) || (address && address.address_2), 64),
				flat: str(d.address && d.address.flat, 64),
		  }
		: { street: null, building: null, flat: null };
	if (service === "address" && !addr.street) review.push("street_missing");

	return {
		service,
		city: city ? { ref: city.ref, name: city.name, area: city.area || null } : null,
		point: point ? { ref: point.ref, number: Number(point.number), name: point.name, type: point.type, max_weight: Number(point.max_weight) || 0 } : null,
		address: addr,
		found_by: how,
		review,
	};
}

/** Чого бракує для ТТН (коди → тексти в перекладах modules.novaposhta.review.*) */
function check(data, weight) {
	const out = [];
	if (!data.city) out.push("city_missing");
	if (data.service !== "address" && !data.point) out.push("point_missing");
	if (data.service === "address" && !(data.address && data.address.street)) out.push("street_missing");
	if (!data.recipient || !data.recipient.lastname || !data.recipient.firstname) out.push("recipient_name");
	if (!data.recipient || !/^380\d{9}$/.test(String(data.recipient.phone || ""))) out.push("recipient_phone");
	if (data.point && data.point.type === "postomat" && data.point.max_weight && weight > data.point.max_weight) out.push("postomat_weight");
	if (!data.account_id) out.push("no_account");
	return out;
}

function publicShipment(s) {
	return {
		id: Number(s.id),
		carrier: s.carrier,
		tracking_number: s.tracking_number,
		status: s.status,
		cost: Number(s.cost),
		weight: s.weight === null ? null : Number(s.weight),
		data: json(s.raw, {}) || {},
		date_add: s.date_add,
	};
}

/** Відправлення НП замовлення; немає — створити чернетку з адреси доставки */
async function forOrder(idOrder) {
	const { order, address } = await loadOrder(idOrder);
	const [rows] = await pool.query(`SELECT * FROM ${P}orders_shipments WHERE id_order = ? AND carrier = ? ORDER BY id`, [idOrder, CARRIER]);
	let list = rows;
	const accs = await accounts.list();
	if (!list.length && address && accs.length) {
		const account = await accounts.forIntegration(order.id_integration);
		const r = await resolveFromAddress(address);
		const st = account ? account.settings : accounts.DEFAULTS;
		const weight = await orderWeight(idOrder, st.default_weight);
		const declared = st.declared_from_total ? Math.round(Number(order.total_products || order.total) * 100) / 100 : 0;
		const data = {
			v: 1,
			account_id: account ? account.id : null,
			service: r.service,
			recipient: recipientOf(address, order),
			city: r.city,
			point: r.point,
			address: r.address,
			seats: 1,
			declared,
			cod: isCod(order, st.cod_keywords) && !Number(order.is_paid) ? Math.round(Number(order.total) * 100) / 100 : 0,
			payer: st.payer,
			payment_method: st.payment_method,
			cargo_type: st.cargo_type,
			description: st.description,
			found_by: r.found_by,
			source: "order",
		};
		// Неоднозначне з адреси (місто з кількома збігами тощо) + чого бракує для ТТН
		data.review = [...new Set([...r.review.filter((c) => c === "city_ambiguous"), ...check(data, weight)])];
		await pool.query(
			`INSERT INTO ${P}orders_shipments (id_order, carrier, tracking_number, status, cost, weight, raw, date_add) VALUES (?, ?, NULL, ?, 0, ?, ?, NOW())`,
			[idOrder, CARRIER, data.review.length ? "review" : "draft", weight, JSON.stringify(data)]
		);
		[list] = await pool.query(`SELECT * FROM ${P}orders_shipments WHERE id_order = ? AND carrier = ? ORDER BY id`, [idOrder, CARRIER]);
	}
	return { shipments: list.map(publicShipment), accounts: accs.filter((a) => a.status).map((a) => ({ id: a.id, name: a.name })), has_accounts: accs.length > 0 };
}

async function shipmentRow(idOrder, idShipment) {
	const [[s]] = await pool.query(`SELECT * FROM ${P}orders_shipments WHERE id = ? AND id_order = ? AND carrier = ?`, [idShipment, idOrder, CARRIER]);
	if (!s) throw httpErr(404, "modules.novaposhta.e.shipment_not_found");
	return s;
}

/** Зберегти зміни відправлення (поки ТТН не створено). Місто й відділення — лише з довідника */
async function save(idOrder, idShipment, b) {
	const s = await shipmentRow(idOrder, idShipment);
	if (s.tracking_number) throw httpErr(409, "modules.novaposhta.e.has_ttn");
	b = b || {};
	const data = json(s.raw, {}) || {};
	const review = [];
	if (b.account_id !== undefined) {
		const acc = Number(b.account_id) ? await accounts.get(Number(b.account_id)) : null;
		data.account_id = acc ? acc.id : null;
	}
	if (SERVICES.includes(b.service)) data.service = b.service;

	if (b.city_ref !== undefined) {
		const c = await directory.city(b.city_ref);
		data.city = c ? { ref: c.ref, name: c.name, area: c.area || null } : null;
		if (data.point && c && data.point.ref) {
			const w = await directory.warehouse(data.point.ref);
			if (!w || w.city_ref !== c.ref) data.point = null;
		}
	}
	if (b.point_ref !== undefined) {
		const w = b.point_ref ? await directory.warehouse(b.point_ref) : null;
		if (b.point_ref && !w) throw httpErr(400, "modules.novaposhta.e.point_not_found");
		data.point = w ? { ref: w.ref, number: Number(w.number), name: w.name, type: w.type, max_weight: Number(w.max_weight) || 0 } : null;
		if (w) {
			if (!data.city || data.city.ref !== w.city_ref) {
				const c = await directory.city(w.city_ref);
				data.city = c ? { ref: c.ref, name: c.name, area: c.area || null } : data.city;
			}
			data.service = w.type === "postomat" ? "postomat" : "warehouse";
		}
	}
	if (b.address && typeof b.address === "object") {
		data.address = { street: str(b.address.street, 255), building: str(b.address.building, 64), flat: str(b.address.flat, 64) };
	}
	if (b.recipient && typeof b.recipient === "object") {
		data.recipient = {
			lastname: str(b.recipient.lastname, 100),
			firstname: str(b.recipient.firstname, 100),
			middlename: str(b.recipient.middlename, 100),
			phone: normPhone(b.recipient.phone),
		};
	}
	for (const k of ["seats"]) if (b[k] !== undefined) data[k] = Math.max(1, Math.min(100, parseInt(b[k], 10) || 1));
	for (const k of ["declared", "cod"]) if (b[k] !== undefined) data[k] = Math.max(0, Math.round(num(b[k]) * 100) / 100);
	if (b.description !== undefined) data.description = str(b.description, 100);
	if (["Recipient", "Sender"].includes(b.payer)) data.payer = b.payer;
	let weight = s.weight === null ? null : Number(s.weight);
	if (b.weight !== undefined) weight = Math.max(0.1, Math.min(1000, num(b.weight) || 0.1));

	review.push(...check(data, weight));
	data.review = review;
	data.source = "manual";
	delete data.calc;

	await pool.query(`UPDATE ${P}orders_shipments SET status = ?, weight = ?, raw = ? WHERE id = ?`, [review.length ? "review" : "draft", weight, JSON.stringify(data), s.id]);
	return publicShipment((await pool.query(`SELECT * FROM ${P}orders_shipments WHERE id = ?`, [s.id]))[0][0]);
}

/** Розрахунок вартості доставки через НП (місто відправника — з акаунта) */
async function calc(idOrder, idShipment) {
	const s = await shipmentRow(idOrder, idShipment);
	const data = json(s.raw, {}) || {};
	if (!data.account_id) throw httpErr(400, "modules.novaposhta.e.no_account");
	const acc = await accounts.get(data.account_id, true);
	const snd = acc.settings.sender || {};
	if (!snd.city_ref) throw httpErr(400, "modules.novaposhta.e.sender_city");
	if (!data.city) throw httpErr(400, "modules.novaposhta.e.city_missing");
	const serviceType = (snd.warehouse_ref ? "Warehouse" : "Doors") + (data.service === "address" ? "Doors" : data.service === "postomat" ? "Postomat" : "Warehouse");
	const props = {
		CitySender: snd.city_ref,
		CityRecipient: data.city.ref,
		Weight: String(Number(s.weight) || DEFAULT_WEIGHT),
		ServiceType: serviceType,
		Cost: String(Math.max(1, Math.round(Number(data.declared) || 1))),
		CargoType: data.cargo_type || "Parcel",
		SeatsAmount: String(data.seats || 1),
	};
	if (Number(data.cod) > 0) props.RedeliveryCalculate = { CargoType: "Money", Amount: String(Math.round(Number(data.cod))) };
	const { data: res } = await api.call(acc.api_key, "InternetDocument", "getDocumentPrice", props);
	const r = res[0] || {};
	const cost = Math.round((Number(r.Cost) || 0) * 100) / 100;
	data.calc = { cost, cost_redelivery: Number(r.CostRedelivery) || 0, service_type: serviceType, at: new Date().toISOString() };
	await pool.query(`UPDATE ${P}orders_shipments SET cost = ?, raw = ? WHERE id = ?`, [cost, JSON.stringify(data), s.id]);
	return { calc: data.calc };
}

/** Перебудувати чернетку з адреси замовлення (наприклад, після оновлення довідника) */
async function rebuild(idOrder, idShipment) {
	const s = await shipmentRow(idOrder, idShipment);
	if (s.tracking_number) throw httpErr(409, "modules.novaposhta.e.has_ttn");
	await pool.query(`DELETE FROM ${P}orders_shipments WHERE id = ?`, [s.id]);
	return forOrder(idOrder);
}

module.exports = { forOrder, save, calc, rebuild, setDefaultWeight, CARRIER };
