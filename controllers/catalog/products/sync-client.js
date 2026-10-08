"use strict";

const crypto = require("crypto");

const TIMEOUT_MS = 30000;
const MAX_RESPONSE = 20 * 1024 * 1024;

function httpErr(status, message, code) {
	return Object.assign(new Error(message), { status, code });
}

/**
 * Виклик модуля магазину.
 * POST base_url, JSON { action, data }
 * Заголовки: Authorization: Bearer <token>, X-GC-Timestamp, X-GC-Signature: sha256=HMAC(token, ts + "." + body)
 * Відповідь: JSON { ok: true, ... } або { ok: false, error }
 */
async function call(integration, action, data) {
	const url = String(integration.base_url || "").trim();
	if (!/^https?:\/\/[^\s]+$/i.test(url)) throw httpErr(400, "Integration has no valid base_url", "no_url");
	const token = String(integration.outbound_token || "");
	if (token.length < 16) throw httpErr(400, "Integration has no outbound token (min 16 chars)", "no_token");

	const body = JSON.stringify({ action, data: data || {} });
	const ts = String(Math.floor(Date.now() / 1000));
	const signature = crypto.createHmac("sha256", token).update(ts + "." + body).digest("hex");

	let res;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"X-GC-Timestamp": ts,
				"X-GC-Signature": `sha256=${signature}`,
				"User-Agent": "GrowthContour-Sync/1.0",
			},
			body,
			redirect: "error",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (e) {
		throw httpErr(502, `Connection failed: ${e.name === "TimeoutError" ? "timeout" : e.message}`, "connect");
	}

	const length = Number(res.headers.get("content-length") || 0);
	if (length > MAX_RESPONSE) throw httpErr(502, "Response too large", "bad_response");
	const text = await res.text();
	if (text.length > MAX_RESPONSE) throw httpErr(502, "Response too large", "bad_response");

	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw httpErr(502, `Invalid JSON from shop (HTTP ${res.status}): ${text.slice(0, 200)}`, "bad_response");
	}
	if (!res.ok || !json || json.ok !== true) {
		throw httpErr(502, `Shop error (HTTP ${res.status}): ${String((json && json.error) || "unknown").slice(0, 300)}`, "shop_error");
	}
	return json;
}

module.exports = { call };