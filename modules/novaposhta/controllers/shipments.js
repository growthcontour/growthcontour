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
const ordersNotify = require("../../../controllers/orders/notify");
const { applyStatus, deriveOrderFlags } = require("../../../controllers/orders/statusFlags");
const { kickOutbox } = require("../../../controllers/orders/outboxProcessor");

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

// По батькові: -ович, -евич, -івна, -ївна, -овна, -ич, -на
const PATRONYMIC = /(ович|евич|євич|ич|івна|ївна|овна|евна|на)$/iu;

/**
 * Отримувач: з адреси доставки, інакше з клієнта.
 * Сайт часто пише ПІБ одним рядком в «Ім'я» («Макаренко Наталія Іванівна») — розкладаємо: прізвище, ім'я, по батькові.
 */
function recipientOf(address, order) {
	const c = json(order.client, {}) || {};
	let lastname = str((address && address.lastname) || c.lastname, 100);
	let firstname = str((address && address.firstname) || c.firstname, 100);
	let middlename = str(address && address.middlename, 100);
	if (!lastname && firstname && /\s/.test(firstname)) {
		const w = firstname.split(/\s+/).filter(Boolean);
		lastname = w[0];
		firstname = w[1] || null;
		if (!middlename && w[2] && PATRONYMIC.test(w[2])) middlename = w[2];
	}
	return {
		lastname: str(lastname, 100),
		firstname: str(firstname, 100),
		middlename: str(middlename, 100),
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
				street_ref: null,
				building: str((d.address && d.address.building) || (address && address.address_2), 64),
				flat: str(d.address && d.address.flat, 64),
		  }
		: { street: null, street_ref: null, building: null, flat: null };
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
	if (data.service === "address") {
		const a = data.address || {};
		if (!isRef(a.street_ref)) out.push(a.street ? "street_pick" : "street_missing");
		if (!a.building) out.push("building_missing");
	}
	if (!data.recipient || !data.recipient.lastname || !data.recipient.firstname) out.push("recipient_name");
	if (!data.recipient || !/^380\d{9}$/.test(String(data.recipient.phone || ""))) out.push("recipient_phone");
	if (data.point && data.point.type === "postomat" && data.point.max_weight && weight > data.point.max_weight) out.push("postomat_weight");
	if (!data.account_id) out.push("no_account");
	return out;
}

/** Вулиці міста — живий пошук у НП (довідник вулиць не зберігаємо: він величезний і потрібен рідко) */
async function streets(accountId, cityRef, q) {
	q = String(q || "").trim();
	if (!isRef(cityRef) || q.length < 2) return [];
	const acc = accountId ? await accounts.get(Number(accountId), true) : await accounts.forIntegration(0);
	if (!acc) throw httpErr(409, "modules.novaposhta.e.no_account");
	const { data } = await api.call(acc.api_key, "Address", "getStreet", { CityRef: cityRef, FindByString: q, Page: "1", Limit: "20" });
	return data.filter((r) => isRef(r.Ref)).map((r) => ({ ref: r.Ref, name: [r.StreetsType, r.Description].filter(Boolean).join(" ") }));
}

/** Вулиця з адреси замовлення: лише якщо НП знайшла рівно одну — інакше вибір за менеджером */
async function guessStreet(acc, data) {
	const a = data.address || {};
	if (data.service !== "address" || !acc || !data.city || !a.street) return;
	const q = String(a.street).replace(/^(вул\.?|вулиця|пров\.?|провулок|просп\.?|проспект|бульв\.?|бульвар|пл\.?|площа)\s+/iu, "").replace(/[,\s]+\d.*$/u, "").trim();
	const found = await streets(acc.id, data.city.ref, q).catch(() => []);
	if (found.length === 1) data.address = { ...a, street: found[0].name, street_ref: found[0].ref };
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
	// Адреса з сайту змінилась (оновлення замовлення: напр., відділення дописалось пізніше) — чернетку,
	// зібрану автоматично й не змінену вручну, будуємо заново з нової адреси
	const stale = address ? list.filter((s) => !s.tracking_number && (json(s.raw, {}) || {}).source === "order" && Number((json(s.raw, {}) || {}).addr_id) !== Number(address.id)) : [];
	if (stale.length) {
		await pool.query(`DELETE FROM ${P}orders_shipments WHERE id IN (?)`, [stale.map((s) => s.id)]);
		list = list.filter((s) => !stale.includes(s));
	}
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
			addr_id: Number(address.id),
		};
		await guessStreet(account, data);
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
		data.address = {
			street: str(b.address.street, 255),
			street_ref: isRef(b.address.street_ref) ? b.address.street_ref : null,
			building: str(b.address.building, 64),
			flat: str(b.address.flat, 64),
		};
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

// ─── ТТН ───

// Дата відправки для НП: сьогодні за Києвом, ДД.ММ.РРРР
const npDate = () => new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
// Коди статусів НП: доставлено / отримано — https://developers.novaposhta.ua (TrackingDocument)
const DELIVERED = [9, 10, 11];
const RETURNED = [102, 103, 108];

/** Відправлення з ТТН або без — з даними для дії (акаунт із ключем і відправником) */
async function ttnContext(idOrder, idShipment) {
	const s = await shipmentRow(idOrder, idShipment);
	const data = json(s.raw, {}) || {};
	if (!data.account_id) throw httpErr(400, "modules.novaposhta.e.no_account");
	const acc = await accounts.get(data.account_id, true);
	return { s, data, acc, snd: acc.settings.sender || {} };
}

/**
 * Створити ТТН: отримувач — приватна особа (НП створює або повертає наявного за ПІБ і телефоном),
 * відправка зі складу відправника акаунта на відділення / поштомат отримувача, наложений платіж — грошовий переказ.
 */
// Журнал замовлення: створення / видалення ТТН
const orderEvent = (idOrder, idUser, type, payload) =>
	pool.query(`INSERT INTO ${P}orders_events (id_order, id_user, type, payload, source, date_add) VALUES (?, ?, ?, ?, 'manual', NOW())`, [idOrder, idUser || null, type, JSON.stringify(payload)]);

async function createTtn(idOrder, idShipment, idUser) {
	const { s, data, acc, snd } = await ttnContext(idOrder, idShipment);
	if (s.tracking_number) throw httpErr(409, "modules.novaposhta.e.has_ttn");
	const weight = Number(s.weight) || DEFAULT_WEIGHT;
	const missing = check(data, weight);
	if (missing.length) throw httpErr(400, "modules.novaposhta.e.not_ready");
	if (!snd.counterparty_ref || !snd.contact_ref || !snd.phone || !snd.city_ref || !snd.warehouse_ref) throw httpErr(400, "modules.novaposhta.e.sender_incomplete");

	const r = data.recipient;
	const { data: cp } = await api.call(acc.api_key, "Counterparty", "save", {
		FirstName: r.firstname,
		MiddleName: r.middlename || "",
		LastName: r.lastname,
		Phone: r.phone,
		Email: "",
		CounterpartyType: "PrivatePerson",
		CounterpartyProperty: "Recipient",
	});
	const rc = cp[0] || {};
	const contact = rc.ContactPerson && Array.isArray(rc.ContactPerson.data) && rc.ContactPerson.data[0];
	if (!isRef(rc.Ref) || !contact || !isRef(contact.Ref)) throw httpErr(502, "modules.novaposhta.e.recipient_failed");

	// Кур'єр: адреса отримувача створюється в НП для контрагента (вулиця з довідника НП + будинок + квартира)
	let recipientAddress = data.point && data.point.ref;
	if (data.service === "address") {
		const { data: ad } = await api.call(acc.api_key, "Address", "save", {
			CounterpartyRef: rc.Ref,
			StreetRef: data.address.street_ref,
			BuildingNumber: data.address.building,
			Flat: data.address.flat || "",
		});
		recipientAddress = ad[0] && ad[0].Ref;
		if (!isRef(recipientAddress)) throw httpErr(502, "modules.novaposhta.e.address_failed");
	}

	const props = {
		PayerType: data.payer || "Recipient",
		PaymentMethod: data.payment_method || "Cash",
		DateTime: npDate(),
		CargoType: data.cargo_type || "Parcel",
		Weight: String(weight),
		ServiceType: data.service === "address" ? "WarehouseDoors" : "WarehouseWarehouse",
		SeatsAmount: String(data.seats || 1),
		Description: data.description || "Товари",
		Cost: String(Math.max(1, Math.round(Number(data.declared) || 1))),
		CitySender: snd.city_ref,
		Sender: snd.counterparty_ref,
		SenderAddress: snd.warehouse_ref,
		ContactSender: snd.contact_ref,
		SendersPhone: snd.phone,
		CityRecipient: data.city.ref,
		Recipient: rc.Ref,
		RecipientAddress: recipientAddress,
		ContactRecipient: contact.Ref,
		RecipientsPhone: r.phone,
		InfoRegClientBarcodes: String(idOrder),
	};
	// Поштомат: обов'язкові габарити місця (стандартна посилка 20×20×20 см, якщо інших даних немає)
	if (data.service === "postomat") {
		props.OptionsSeat = [{ volumetricVolume: "0.008", volumetricWidth: "20", volumetricLength: "20", volumetricHeight: "20", weight: String(weight) }];
	}
	if (Number(data.cod) > 0) props.BackwardDeliveryData = [{ PayerType: "Recipient", CargoType: "Money", RedeliveryString: String(Math.round(Number(data.cod) * 100) / 100) }];

	const { data: doc } = await api.call(acc.api_key, "InternetDocument", "save", props);
	const d = doc[0] || {};
	if (!d.IntDocNumber) throw httpErr(502, "modules.novaposhta.e.bad_response");

	data.ttn = { ref: d.Ref, number: String(d.IntDocNumber), cost: Number(d.CostOnSite) || 0, estimated: d.EstimatedDeliveryDate || null, recipient_ref: rc.Ref, created_at: new Date().toISOString() };
	delete data.review;
	await pool.query(`UPDATE ${P}orders_shipments SET tracking_number = ?, status = 'created', cost = ?, raw = ? WHERE id = ?`, [data.ttn.number, data.ttn.cost, JSON.stringify(data), s.id]);
	await orderEvent(idOrder, idUser, "ttn_created", { number: data.ttn.number, cost: data.ttn.cost, cod: Number(data.cod) || 0 });
	ordersNotify.fire(idOrder, "ttn", { number: data.ttn.number });
	return { shipment: publicShipment((await pool.query(`SELECT * FROM ${P}orders_shipments WHERE id = ?`, [s.id]))[0][0]) };
}

/** Видалити ТТН у НП (лише поки посилку не прийнято) — відправлення знову стає чернеткою */
async function deleteTtn(idOrder, idShipment, idUser) {
	const { s, data, acc } = await ttnContext(idOrder, idShipment);
	if (!s.tracking_number) throw httpErr(409, "modules.novaposhta.e.no_ttn");
	if (data.ttn && data.ttn.ref) await api.call(acc.api_key, "InternetDocument", "delete", { DocumentRefs: data.ttn.ref });
	await orderEvent(idOrder, idUser, "ttn_deleted", { number: s.tracking_number });
	delete data.ttn;
	delete data.track;
	delete data.registry; // НП прибирає видалену ТТН з реєстру сама
	data.review = check(data, Number(s.weight) || DEFAULT_WEIGHT);
	await pool.query(`UPDATE ${P}orders_shipments SET tracking_number = NULL, status = ?, shipped_at = NULL, delivered_at = NULL, raw = ? WHERE id = ?`, [data.review.length ? "review" : "draft", JSON.stringify(data), s.id]);
	return { ok: true };
}

const TRACK_BATCH = 100; // документів в одному запиті getStatusDocuments
const TRACK_DAYS = 60; // старші відправлення не відстежуємо автоматично

/**
 * Застосувати відповідь НП до відправлення: стан, дати, сповіщення
 * і статус замовлення за налаштуванням акаунта (лише при переході в новий стан).
 */
async function applyTrack(s, data, acc, t) {
	const code = Number(t.StatusCode) || 0;
	data.track = { code, text: t.Status || "", scheduled: t.ScheduledDeliveryDate || null, at: new Date().toISOString() };
	const status = DELIVERED.includes(code) ? "delivered" : RETURNED.includes(code) ? "returned" : code >= 4 ? "in_transit" : "created";
	await pool.query(
		`UPDATE ${P}orders_shipments SET status = ?, raw = ?,
		        shipped_at = IF(? AND shipped_at IS NULL, NOW(), shipped_at),
		        delivered_at = IF(? AND delivered_at IS NULL, NOW(), delivered_at)
		  WHERE id = ?`,
		[status, JSON.stringify(data), status !== "created" ? 1 : 0, status === "delivered" ? 1 : 0, s.id]
	);
	if (status !== s.status) {
		// Сповіщення — лише при переході в «доставлено» / «повернення», а не на кожне оновлення
		if (status === "delivered" || status === "returned") ordersNotify.fire(s.id_order, status, { number: s.tracking_number });
		await orderStatusFromTrack(s, acc, status, data.track.text);
	}
	return status;
}

/** Статус замовлення за станом посилки. Фінальний статус замовлення (виконано, скасовано…) не чіпаємо */
async function orderStatusFromTrack(s, acc, state, text) {
	const target = Number((acc.settings.status_map || {})[state]) || 0;
	if (!target) return;
	const conn = await pool.getConnection();
	let res = null;
	try {
		await conn.beginTransaction();
		const [[o]] = await conn.query(`SELECT status FROM ${P}orders WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [s.id_order]);
		const cur = o ? Number(o.status) : 0;
		if (cur && cur !== target && !(await deriveOrderFlags(cur).catch(() => ({}))).is_final) {
			res = await applyStatus(conn, s.id_order, target, {
				source: "system",
				comment: `${s.tracking_number}: ${text}`,
				extra: { via: CARRIER, number: s.tracking_number },
			});
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		console.error(`[novaposhta] order #${s.id_order} status:`, e.message);
		return;
	} finally {
		conn.release();
	}
	if (!res) return;
	kickOutbox();
	ordersNotify.fire(s.id_order, "status", { to: target });
	if (res.flags.is_paid && !res.was_paid) ordersNotify.fire(s.id_order, "paid");
}

/** Статус посилки з НП (телефон відправника — для повних даних) */
async function track(idOrder, idShipment) {
	const { s, data, acc, snd } = await ttnContext(idOrder, idShipment);
	if (!s.tracking_number) throw httpErr(409, "modules.novaposhta.e.no_ttn");
	const { data: res } = await api.call(acc.api_key, "TrackingDocument", "getStatusDocuments", { Documents: [{ DocumentNumber: s.tracking_number, Phone: snd.phone || "" }] });
	const status = await applyTrack(s, data, acc, res[0] || {});
	return { track: data.track, status };
}

/**
 * Автовідстеження за розкладом: усі ТТН у дорозі за останні TRACK_DAYS днів,
 * пачками по TRACK_BATCH на акаунт. Помилка одного акаунта не зупиняє інші.
 */
let tracking = false;
async function trackDue() {
	if (tracking) return;
	tracking = true;
	try {
		const [rows] = await pool.query(
			`SELECT s.* FROM ${P}orders_shipments s
			   JOIN ${P}orders o ON o.id = s.id_order AND o.deleted_at IS NULL
			  WHERE s.carrier = ? AND s.tracking_number IS NOT NULL AND s.status IN ('created', 'in_transit')
			    AND s.date_add > NOW() - INTERVAL ? DAY`,
			[CARRIER, TRACK_DAYS]
		);
		const byAccount = new Map();
		for (const s of rows) {
			const data = json(s.raw, {}) || {};
			if (!data.account_id) continue;
			if (!byAccount.has(data.account_id)) byAccount.set(data.account_id, []);
			byAccount.get(data.account_id).push({ s, data });
		}
		for (const [accountId, list] of byAccount) {
			try {
				const acc = await accounts.get(accountId, true);
				if (!acc.status) continue;
				const phone = (acc.settings.sender || {}).phone || "";
				for (let i = 0; i < list.length; i += TRACK_BATCH) {
					const part = list.slice(i, i + TRACK_BATCH);
					const { data: res } = await api.callRetry(acc.api_key, "TrackingDocument", "getStatusDocuments", {
						Documents: part.map(({ s }) => ({ DocumentNumber: s.tracking_number, Phone: phone })),
					});
					const byNumber = new Map(res.map((t) => [String(t.Number), t]));
					for (const { s, data } of part) {
						const t = byNumber.get(String(s.tracking_number));
						if (t) await applyTrack(s, data, acc, t).catch((e) => console.error(`[novaposhta] track ${s.tracking_number}:`, e.message));
					}
				}
			} catch (e) {
				console.error(`[novaposhta] track account #${accountId}:`, e.message);
			}
		}
	} finally {
		tracking = false;
	}
}

/** PDF накладної (A4) або наклейки 100×100 — через сервер, щоб ключ API не потрапляв у браузер */
async function printTtn(idOrder, idShipment, format) {
	const { s, acc } = await ttnContext(idOrder, idShipment);
	if (!s.tracking_number) throw httpErr(409, "modules.novaposhta.e.no_ttn");
	const kind = format === "100" ? "printMarking100x100" : "printDocument";
	const url = `https://my.novaposhta.ua/orders/${kind}/orders[]/${encodeURIComponent(s.tracking_number)}/type/pdf/apiKey/${encodeURIComponent(acc.api_key)}`;
	return { pdf: await npPdf(url), name: `TTN-${s.tracking_number}${format === "100" ? "-100x100" : ""}.pdf` };
}

/** PDF з кабінету НП (накладна, наклейка, реєстр) — через сервер, щоб ключ API не потрапляв у браузер */
async function npPdf(url) {
	let res;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(30000) });
	} catch (e) {
		throw httpErr(502, "modules.novaposhta.e.network", { msg: e.message });
	}
	const type = res.headers.get("content-type") || "";
	if (!res.ok || !type.includes("pdf")) throw httpErr(502, "modules.novaposhta.e.print_failed");
	return Buffer.from(await res.arrayBuffer());
}

// ─── Реєстри (ScanSheet): ТТН дня одним документом для передачі у відділення / кур'єру ───

/** ТТН акаунта, ще не включені в реєстр і не відправлені, + реєстри з НП */
async function registries(accountId) {
	const acc = await accounts.get(Number(accountId), true);
	const [rows] = await pool.query(
		`SELECT s.id, s.id_order, s.tracking_number, s.cost, s.raw, s.date_add, o.reference
		   FROM ${P}orders_shipments s
		   JOIN ${P}orders o ON o.id = s.id_order AND o.deleted_at IS NULL
		  WHERE s.carrier = ? AND s.status = 'created' AND s.tracking_number IS NOT NULL
		    AND JSON_EXTRACT(s.raw, '$.account_id') = ? AND JSON_EXTRACT(s.raw, '$.registry') IS NULL
		  ORDER BY s.id DESC`,
		[CARRIER, acc.id]
	);
	const { data: sheets } = await api.call(acc.api_key, "ScanSheet", "getScanSheetList", {});
	return {
		free: rows.map((r) => {
			const d = json(r.raw, {}) || {};
			return { id: Number(r.id), id_order: Number(r.id_order), reference: r.reference, number: r.tracking_number, cost: Number(r.cost), cod: Number(d.cod) || 0, recipient: d.recipient ? [d.recipient.lastname, d.recipient.firstname].filter(Boolean).join(" ") : "", city: d.city ? d.city.name : "", date_add: r.date_add };
		}),
		sheets: sheets.map((x) => ({ ref: x.Ref, number: x.Number, date: x.DateTime || x.Date || "", count: Number(x.Count) || null, printed: Number(x.Printed) === 1 })),
	};
}

/** Сформувати реєстр із вибраних ТТН (або додати їх до наявного реєстру sheet_ref) */
async function registryCreate(accountId, ids, sheetRef) {
	const acc = await accounts.get(Number(accountId), true);
	ids = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => n > 0))];
	if (!ids.length) throw httpErr(400, "modules.novaposhta.e.registry_empty");
	const [rows] = await pool.query(`SELECT * FROM ${P}orders_shipments WHERE id IN (?) AND carrier = ? AND tracking_number IS NOT NULL`, [ids, CARRIER]);
	const docs = rows.map((s) => ({ s, data: json(s.raw, {}) || {} })).filter(({ data }) => Number(data.account_id) === acc.id && data.ttn && isRef(data.ttn.ref));
	if (!docs.length) throw httpErr(400, "modules.novaposhta.e.registry_empty");

	const props = { DocumentRefs: docs.map(({ data }) => data.ttn.ref), Date: npDate() };
	if (isRef(sheetRef)) props.Ref = sheetRef;
	const { data: res } = await api.call(acc.api_key, "ScanSheet", "insertDocuments", props);
	const r = res[0] || {};
	const ref = r.Ref || (r.Data && r.Data.Ref);
	const number = r.Number || (r.Data && r.Data.Number) || "";
	if (!isRef(ref)) throw httpErr(502, "modules.novaposhta.e.bad_response");
	// ТТН, які НП відхилила, лишаються вільними (НП повертає їх у Errors / Warnings з номером або ref)
	const rejected = JSON.stringify([r.Errors || [], r.Warnings || []]);
	let added = 0;
	for (const { s, data } of docs) {
		if (rejected.includes(data.ttn.ref) || rejected.includes(s.tracking_number)) continue;
		data.registry = { ref, number: String(number) };
		await pool.query(`UPDATE ${P}orders_shipments SET raw = ? WHERE id = ?`, [JSON.stringify(data), s.id]);
		added++;
	}
	return { ref, number, added, rejected: docs.length - added };
}

/** Видалити реєстр у НП; ТТН з нього знову вільні */
async function registryDelete(accountId, sheetRef) {
	if (!isRef(sheetRef)) throw httpErr(400, "modules.novaposhta.e.registry_not_found");
	const acc = await accounts.get(Number(accountId), true);
	await api.call(acc.api_key, "ScanSheet", "deleteScanSheet", { ScanSheetRefs: [sheetRef] });
	await pool.query(
		`UPDATE ${P}orders_shipments SET raw = JSON_REMOVE(raw, '$.registry')
		  WHERE carrier = ? AND JSON_UNQUOTE(JSON_EXTRACT(raw, '$.registry.ref')) = ?`,
		[CARRIER, sheetRef]
	);
	return { ok: true };
}

async function registryPrint(accountId, sheetRef) {
	if (!isRef(sheetRef)) throw httpErr(400, "modules.novaposhta.e.registry_not_found");
	const acc = await accounts.get(Number(accountId), true);
	const url = `https://my.novaposhta.ua/scanSheet/printScanSheet/refs[]/${sheetRef}/type/pdf/apiKey/${encodeURIComponent(acc.api_key)}`;
	return { pdf: await npPdf(url), name: `registry-${sheetRef.slice(0, 8)}.pdf` };
}

/** Перебудувати чернетку з адреси замовлення (наприклад, після оновлення довідника) */
async function rebuild(idOrder, idShipment) {
	const s = await shipmentRow(idOrder, idShipment);
	if (s.tracking_number) throw httpErr(409, "modules.novaposhta.e.has_ttn");
	await pool.query(`DELETE FROM ${P}orders_shipments WHERE id = ?`, [s.id]);
	return forOrder(idOrder);
}

// ─── Масові дії зі списку замовлень ───

/**
 * ТТН для вибраних замовлень: чернетка відправлення з адреси (якщо ще немає) → ТТН, коли даних досить.
 * Замовлення з ТТН або з неповними даними пропускаються з причиною.
 */
async function bulkTtn(orders, idUser) {
	const out = { done: 0, skipped: [] };
	for (const o of orders) {
		try {
			const { shipments } = await forOrder(o.id);
			const s = shipments.find((x) => !x.tracking_number);
			if (!s) {
				out.skipped.push({ id: o.id, reference: o.reference, reason: shipments.length ? "has_ttn" : "not_ready" });
				continue;
			}
			if (s.status !== "draft") {
				out.skipped.push({ id: o.id, reference: o.reference, reason: "not_ready" });
				continue;
			}
			await createTtn(o.id, s.id, idUser);
			out.done++;
		} catch (e) {
			out.skipped.push({ id: o.id, reference: o.reference, reason: "error", message: e.status ? e.message : "server error" });
		}
	}
	return out;
}

/** ТТН вибраних замовлень, згруповані за акаунтом НП (один PDF на акаунт — ключ API свій) */
async function bulkPrintGroups(orderIds) {
	if (!orderIds.length) return [];
	const [rows] = await pool.query(`SELECT id_order, tracking_number, raw FROM ${P}orders_shipments WHERE id_order IN (?) AND carrier = ? AND tracking_number IS NOT NULL`, [orderIds, CARRIER]);
	const groups = new Map();
	for (const r of rows) {
		const acc = Number((json(r.raw, {}) || {}).account_id) || 0;
		if (!acc) continue;
		if (!groups.has(acc)) groups.set(acc, { account_id: acc, orders: [], numbers: [] });
		const g = groups.get(acc);
		g.orders.push(Number(r.id_order));
		g.numbers.push(String(r.tracking_number));
	}
	return [...groups.values()];
}

/** Один PDF на всі ТТН акаунта: накладні A4 або наклейки 100×100 */
async function bulkPrint(orderIds, accountId, format) {
	const g = (await bulkPrintGroups(orderIds)).find((x) => x.account_id === Number(accountId));
	if (!g) throw httpErr(404, "modules.novaposhta.e.no_ttn");
	const acc = await accounts.get(g.account_id, true);
	const kind = format === "100" ? "printMarking100x100" : "printDocument";
	const url = `https://my.novaposhta.ua/orders/${kind}/orders[]/${g.numbers.map(encodeURIComponent).join(",")}/type/pdf/apiKey/${encodeURIComponent(acc.api_key)}`;
	return { pdf: await npPdf(url), name: `TTN-${g.numbers.length}${format === "100" ? "-100x100" : ""}.pdf` };
}

module.exports = { bulkTtn, bulkPrintGroups, bulkPrint, registries, registryCreate, registryDelete, registryPrint, streets, forOrder, save, calc, rebuild, createTtn, deleteTtn, track, trackDue, printTtn, setDefaultWeight, CARRIER };