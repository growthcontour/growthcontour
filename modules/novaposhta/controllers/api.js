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

/** Усі сторінки методу зі сторінковим доступом (Page / Limit) */
async function callAll(apiKey, modelName, calledMethod, props = {}, limit = 500, onPage) {
	const out = [];
	for (let page = 1; page <= 2000; page++) {
		const { data, info } = await call(apiKey, modelName, calledMethod, { ...props, Page: String(page), Limit: String(limit) });
		if (onPage) await onPage(data);
		else out.push(...data);
		const total = Number(info.totalCount) || 0;
		if (!data.length || data.length < limit || (total && page * limit >= total)) break;
	}
	return out;
}

module.exports = { call, callAll, setTimeoutMs };
