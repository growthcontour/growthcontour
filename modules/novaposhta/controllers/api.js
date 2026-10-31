"use strict";

/**
 * Клієнт API Нової пошти v2.0: https://api.novaposhta.ua/v2.0/json/
 * Повертає { data, info }; помилки НП (success: false) — виняток із текстом помилок НП.
 */
const { httpErr } = require("./common");

const URL = "https://api.novaposhta.ua/v2.0/json/";
let TIMEOUT = 30000;
const setTimeoutMs = (ms) => (TIMEOUT = Math.max(5000, Number(ms) || 30000));

async function call(apiKey, modelName, calledMethod, methodProperties = {}) {
	let res;
	try {
		res = await fetch(URL, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ apiKey: apiKey || "", modelName, calledMethod, methodProperties }),
			signal: AbortSignal.timeout(TIMEOUT),
		});
	} catch (e) {
		throw httpErr(502, "modules.novaposhta.e.network", { msg: e.message });
	}
	if (!res.ok) throw httpErr(502, "modules.novaposhta.e.http", { code: res.status });
	let j;
	try {
		j = await res.json();
	} catch (e) {
		throw httpErr(502, "modules.novaposhta.e.bad_response");
	}
	if (!j.success) {
		const list = [...(j.errors || []), ...(Array.isArray(j.warnings) ? j.warnings : [])].filter(Boolean);
		throw httpErr(400, "modules.novaposhta.e.api", { msg: list.join("; ") || "—" });
	}
	return { data: Array.isArray(j.data) ? j.data : [], info: j.info || {} };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Запит із паузою між сторінками й повтором при «To many requests» / збої мережі.
 * НП обмежує частоту запитів: без пауз довідник (~40 тис. відділень) обривається на півдорозі.
 */
async function callRetry(apiKey, modelName, calledMethod, props) {
	for (let attempt = 0; ; attempt++) {
		try {
			const r = await call(apiKey, modelName, calledMethod, props);
			await sleep(300);
			return r;
		} catch (e) {
			const msg = String((e.vars && e.vars.msg) || e.message || "");
			const retry = /many requests|ліміт|limit/i.test(msg) || e.message === "modules.novaposhta.e.network" || e.message === "modules.novaposhta.e.http";
			if (!retry || attempt >= 6) throw e;
			await sleep(Math.min(60000, 2000 * 2 ** attempt)); // 2, 4, 8, 16, 32, 60 с
		}
	}
}

/** Усі сторінки методу зі сторінковим доступом (Page / Limit) */
async function callAll(apiKey, modelName, calledMethod, props = {}, limit = 500, onPage) {
	const out = [];
	for (let page = 1; page <= 2000; page++) {
		const { data, info } = await callRetry(apiKey, modelName, calledMethod, { ...props, Page: String(page), Limit: String(limit) });
		if (onPage) await onPage(data);
		else out.push(...data);
		// НП інколи віддає неповну сторінку посеред списку — орієнтуємось на totalCount, якщо він є
		const total = Number(info.totalCount) || 0;
		if (!data.length || (total ? page * limit >= total : data.length < limit)) break;
	}
	return out;
}

module.exports = { call, callRetry, callAll, setTimeoutMs };