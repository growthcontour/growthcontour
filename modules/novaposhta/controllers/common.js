"use strict";

const pool = require("../../../config/database/connection_pool");
const P = require("../../../config/config").get("configDatabase").prefix;

/** Помилка з HTTP-статусом. message — ключ перекладу (modules.novaposhta.e.*) або текст від API НП */
function httpErr(status, message, vars) {
	const e = new Error(message);
	e.status = status;
	if (vars) e.vars = vars;
	return e;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRef = (v) => typeof v === "string" && UUID_RE.test(v);
const str = (v, n) => (v === null || v === undefined ? null : String(v).trim().slice(0, n) || null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const json = (v, d) => {
	if (v && typeof v === "object") return v;
	try {
		return v ? JSON.parse(v) : d;
	} catch (e) {
		return d;
	}
};

module.exports = { pool, P, httpErr, isRef, str, num, json, UUID_RE };
