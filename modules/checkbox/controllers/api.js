"use strict";

/**
 * Клієнт Checkbox API v1 (https://api.checkbox.in.ua/api/v1; тестовий — dev-api.checkbox.in.ua).
 * Авторизація: касир входить PIN-кодом з ліцензійним ключем каси (X-License-Key) → JWT (Bearer).
 * Токен зберігається в касі (зашифрований); на 401 — повторний вхід і один повтор запиту.
 * Гроші — у копійках, кількість — у тисячних (1 шт. = 1000).
 */
const { httpErr } = require("./common");

const BASE = { live: "https://api.checkbox.in.ua", test: "https://dev-api.checkbox.in.ua" };
const CLIENT = { "X-Client-Name": "Growth contour", "X-Client-Version": "1.0" };
let TIMEOUT = 30000;
const setTimeoutMs = (ms) => (TIMEOUT = Math.max(5000, Number(ms) || 30000));

/** Текст помилки Checkbox: message / detail (422 — список полів) */
function errorText(j, status) {
	if (!j) return "HTTP " + status;
	if (typeof j.message === "string" && j.message) return j.message;
	if (typeof j.detail === "string") return j.detail;
	if (Array.isArray(j.detail)) return j.detail.map((d) => [Array.isArray(d.loc) ? d.loc.slice(1).join(".") : "", d.msg].filter(Boolean).join(": ")).join("; ");
	return "HTTP " + status;
}

async function raw(reg, method, path, { body, token, license, binary } = {}) {
	const headers = { ...CLIENT, Accept: binary ? "*/*" : "application/json" };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	if (token) headers.Authorization = "Bearer " + token;
	if (license) headers["X-License-Key"] = reg.license;
	let res;
	try {
		res = await fetch((reg.test ? BASE.test : BASE.live) + "/api/v1" + path, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT),
		});
	} catch (e) {
		throw httpErr(502, "modules.checkbox.e.network", { msg: e.message });
	}
	if (binary && res.ok) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") || "" };
	const text = await res.text();
	let j = null;
	try {
		j = text ? JSON.parse(text) : {};
	} catch (e) {
		if (res.ok) return { status: res.status, text };
	}
	if (!res.ok) {
		const e = httpErr(res.status === 401 || res.status === 403 ? res.status : res.status >= 500 ? 502 : 400, "modules.checkbox.e.api", { msg: errorText(j, res.status) });
		e.http = res.status;
		e.body = j;
		throw e;
	}
	return { status: res.status, data: j };
}

/**
 * Клієнт каси. reg: { id, test, license, pin, token }; onToken(token) — зберегти новий JWT.
 * Методи повертають тіло відповіді (data), бінарні — { buffer, type }.
 */
function client(reg, onToken) {
	let token = reg.token || null;

	async function signin() {
		if (!reg.license || !reg.pin) throw httpErr(409, "modules.checkbox.e.no_credentials");
		let r;
		try {
			r = await raw(reg, "POST", "/cashier/signinPinCode", { body: { pin_code: String(reg.pin) }, license: true });
		} catch (e) {
			if (e.http === 401 || e.http === 403 || e.http === 422) throw httpErr(400, "modules.checkbox.e.signin", { msg: e.vars && e.vars.msg });
			throw e;
		}
		token = r.data && r.data.access_token;
		if (!token) throw httpErr(502, "modules.checkbox.e.bad_response");
		if (onToken) await onToken(token);
		return token;
	}

	async function call(method, path, opts = {}) {
		if (!token) await signin();
		try {
			return await raw(reg, method, path, { ...opts, token });
		} catch (e) {
			if (e.http !== 401) throw e;
			await signin();
			return raw(reg, method, path, { ...opts, token });
		}
	}
	const get = async (path, opts) => (await call("GET", path, opts)).data;
	const post = async (path, body, opts) => (await call("POST", path, { ...opts, body: body === undefined ? {} : body })).data;
	const put = async (path, body, opts) => (await call("PUT", path, { ...opts, body: body === undefined ? {} : body })).data;
	const del = async (path, opts) => (await call("DELETE", path, opts)).data;
	const L = { license: true };

	return {
		signin,
		/* Касир і каса */
		me: () => get("/cashier/me"),
		registerInfo: () => get("/cash-registers/info", L),
		taxes: () => get("/tax", L),
		pingTax: () => post("/cash-registers/ping-tax-service", {}, L),
		/* Зміни: відкриття / закриття асинхронні — стан дивимось через currentShift() */
		currentShift: () => get("/cashier/shift"),
		openShift: (body) => post("/shifts", body || {}, L),
		closeShift: () => post("/shifts/close", {}),
		/* Чеки: створення асинхронне (CREATED → DONE / ERROR) */
		sell: (body) => post("/receipts/sell", body),
		service: (body) => post("/receipts/service", body),
		receipt: (id) => get("/receipts/" + encodeURIComponent(id)),
		receiptFile: (id, kind) => call("GET", `/receipts/${encodeURIComponent(id)}/${kind}`, { binary: true }),
		sendEmail: (id, emails) => post(`/receipts/${encodeURIComponent(id)}/email`, emails),
		sendSms: (id, phone) => post(`/receipts/${encodeURIComponent(id)}/sms`, { phone }),
		/* Передплата / післяплата: ланцюжок чеків з одним набором товарів */
		prepay: (body) => post("/prepayment-receipts", body),
		afterpay: (rel, body) => post("/prepayment-receipts/" + encodeURIComponent(rel), body),
		chain: (rel) => get("/prepayment-receipts/" + encodeURIComponent(rel)),
		chainReturn: (rel, body) => post(`/prepayment-receipts/${encodeURIComponent(rel)}/return`, body || {}),
		/* Режим каси: онлайн / офлайн (Checkbox сам переходить в офлайн, коли мовчить ДПС), резерв офлайн-кодів */
		registerState: (id) => get("/cash-registers/" + encodeURIComponent(id)),
		askOfflineCodes: (count) => get(`/cash-registers/ask-offline-codes?count=${Number(count) || 1000}&sync=false`, L),
		goOffline: () => post("/cash-registers/go-offline", {}, L),
		goOnline: () => post("/cash-registers/go-online", {}, L),
		/* Вебхук каси: Checkbox шле чеки й зміни; у відповіді на встановлення — секретний ключ підпису */
		webhookSet: (url) => post("/webhook", { url }, L),
		webhookGet: () => get("/webhook", L),
		webhookDelete: () => del("/webhook", L),
		/* Звіти */
		xReport: () => post("/reports", undefined),
		/* Періодичний звіт (текст), список Z-звітів, офлайн-коди */
		periodical: (from, to) => call("GET", `/reports/periodical?from_date=${encodeURIComponent(from)}&to_date=${encodeURIComponent(to)}&width=42`, {}).then((r) => (r.text !== undefined ? r.text : JSON.stringify(r.data))),
		reports: (q) => get("/reports?" + new URLSearchParams(q).toString()),
		offlineCodesCount: () => get("/cash-registers/get-offline-codes-count", L),
		reportText: (id) => call("GET", `/reports/${encodeURIComponent(id)}/text`, {}).then((r) => (r.text !== undefined ? r.text : JSON.stringify(r.data))),
		/* ЕТТН: чек, який Checkbox видає сам, коли клієнт отримує посилку (Нова Пошта, «Контроль оплати») */
		ettnCreate: (body) => post("/ettn", body, L),
		ettnPrepay: (body) => post("/ettn/prepayment", body, L),
		ettnGet: (id) => get("/ettn/" + encodeURIComponent(id), L),
		ettnDelete: (id) => del("/ettn/" + encodeURIComponent(id), L),
		ettnFiscalize: (id) => put("/ettn/fiscalize-manually/" + encodeURIComponent(id), {}, L),
	};
}

module.exports = { client, setTimeoutMs };