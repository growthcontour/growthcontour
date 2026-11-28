"use strict";

/**
 * Telegram Bot API для магазину: виклики методів і перевірка даних Mini App (initData).
 *
 * initData — рядок, який Telegram передає вітрині; підпис перевіряється ключем бота
 * (HMAC-SHA256 з ключем HMAC("WebAppData", token)), застарілі дані (auth_date) не приймаються.
 * Так вітрина знає справжнього користувача Telegram без власного входу.
 */

const crypto = require("crypto");
const axios = require("axios");

const API = "https://api.telegram.org";
const TIMEOUT_MS = 15000;
const INIT_MAX_AGE_SEC = 24 * 3600;

class TgError extends Error {
	constructor(method, code, description, parameters) {
		super(description || "Telegram API error");
		this.method = method;
		this.code = code;
		// 429 Too Many Requests: скільки секунд чекати
		this.retry_after = parameters && parameters.retry_after ? Number(parameters.retry_after) : null;
	}
}

/** Виклик методу Bot API; помилка Telegram → TgError з його описом */
async function call(token, method, body) {
	try {
		const r = await axios.post(`${API}/bot${token}/${method}`, body || {}, { timeout: TIMEOUT_MS, validateStatus: () => true });
		if (!r.data || !r.data.ok) throw new TgError(method, r.data && r.data.error_code, r.data && r.data.description, r.data && r.data.parameters);
		return r.data.result;
	} catch (e) {
		if (e instanceof TgError) throw e;
		throw new TgError(method, null, e.code === "ECONNABORTED" ? "timeout" : String(e.message || e).slice(0, 200));
	}
}

/** Перевірка initData Mini App. Повертає { user, auth_date, query_id, start_param } або null */
function verifyInitData(initData, token) {
	if (!initData || !token) return null;
	const params = new URLSearchParams(String(initData));
	const hash = params.get("hash");
	if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
	params.delete("hash");
	const check = [...params.entries()]
		.map(([k, v]) => `${k}=${v}`)
		.sort()
		.join("\n");
	const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
	const calc = crypto.createHmac("sha256", secret).update(check).digest("hex");
	if (!crypto.timingSafeEqual(Buffer.from(calc, "hex"), Buffer.from(hash.toLowerCase(), "hex"))) return null;
	const authDate = parseInt(params.get("auth_date"), 10) || 0;
	if (!authDate || Date.now() / 1000 - authDate > INIT_MAX_AGE_SEC) return null;
	let user = null;
	try {
		user = JSON.parse(params.get("user") || "null");
	} catch {
		return null;
	}
	if (!user || !user.id) return null;
	return { user, auth_date: authDate, query_id: params.get("query_id"), start_param: params.get("start_param") };
}

/** Безпечний HTML для повідомлень бота (parse_mode HTML) */
const html = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

module.exports = { call, verifyInitData, html, TgError };