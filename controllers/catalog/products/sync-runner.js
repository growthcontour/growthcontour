"use strict";

// Загальний фоновий обмін CRM → магазин: sync.begin → пакети → sync.end.
// Прогрес, скасування й продовження веде модуль на своєму боці.
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const client = require("./sync-client");

const P = config.get("configDatabase").prefix;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpErr(status, message) {
	return Object.assign(new Error(message), { status });
}

async function integration(id) {
	const [[row]] = await pool.query(`SELECT id, base_url, callback_url, outbound_token, status FROM ${P}settings_integrations WHERE id = ?`, [id]);
	if (!row) throw httpErr(404, "Integration not found");
	if (row.status !== "active") throw httpErr(400, "Integration is disabled");
	return row;
}

// Обрив зв'язку / битий JSON — до 3 спроб; помилку магазину не повторюємо
async function call(integ, action, data) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await client.call(integ, action, data);
		} catch (e) {
			if (attempt >= 3 || !["connect", "bad_response"].includes(e.code)) throw e;
			await sleep(3000 * attempt);
		}
	}
}

/**
 * source: { BATCH, start, resume(lastCrmId) → cursor, count() → n, batch(cursor, size) → { items, next } }
 */
async function run(idIntegration, entity, source) {
	const integ = await integration(idIntegration);
	const total = await source.count();
	const begin = await call(integ, "sync.begin", { entity, total });
	const job = String(begin.job || "");
	if (!job) throw httpErr(502, "Shop did not start the job");

	const size = Math.min(Math.max(parseInt(begin.batch_size, 10) || source.BATCH, 1), 500);
	let cursor = begin.resume_after ? source.resume(begin.resume_after) : source.start;

	try {
		for (;;) {
			const { items, next } = await source.batch(cursor, size);
			if (!items.length) break;
			cursor = next;
			const r = await call(integ, `${entity}.sync`, { job, items });
			if (r.cancel) {
				await call(integ, "sync.end", { entity, job, cancelled: true });
				return { cancelled: true };
			}
		}
		await call(integ, "sync.end", { entity, job });
		return { ok: true };
	} catch (e) {
		await client.call(integ, "sync.end", { entity, job, error: String(e.message || e).slice(0, 300) }).catch(() => {});
		throw e;
	}
}

module.exports = { run };