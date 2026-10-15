"use strict";

// Загальний фоновий обмін CRM → магазин: sync.begin → пакети → sync.end.
// Прогрес, скасування й продовження веде модуль на своєму боці.
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const client = require("./sync-client");
const { writeLog } = require("./sync");

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
async function run(idIntegration, entity, source, opts = {}) {
	const started = Date.now();
	const stats = { total: 0, sent: 0, ok: 0, errors: 0, message: null };
	const log = () => writeLog(idIntegration, entity, opts.trigger || "module", stats, opts.idUser || null, started);
	const integ = await integration(idIntegration);
	const total = await source.count();
	stats.total = total;
	let begin;
	try {
		begin = await call(integ, "sync.begin", { entity, total });
	} catch (e) {
		stats.message = String(e.message || e);
		await log();
		throw e;
	}
	const job = String(begin.job || "");
	if (!job) {
		stats.message = "Shop did not start the job";
		await log();
		throw httpErr(502, stats.message);
	}

	const size = Math.min(Math.max(parseInt(begin.batch_size, 10) || source.BATCH, 1), 500);
	let cursor = begin.resume_after ? source.resume(begin.resume_after) : source.start;

	try {
		for (;;) {
			const { items, next, more } = await source.batch(cursor, size);
			if (!items.length) {
				// Пакет повністю відсіяно асортиментом — йдемо далі, поки є що переглядати
				if (!more) break;
				cursor = next;
				continue;
			}
			cursor = next;
			stats.sent += items.length;
			const r = await call(integ, `${entity}.sync`, { job, items });
			const results = Array.isArray(r.results) ? r.results : [];
			// Помилки по окремих записах: рахуємо й лишаємо перше повідомлення з номером запису
			const bad = results.filter((x) => x && x.ok === false);
			stats.errors += bad.length;
			stats.ok += results.length ? results.length - bad.length : items.length;
			if (bad.length && !stats.message) stats.message = `#${bad[0].crm_id || bad[0].ref || "?"}: ${String(bad[0].error || bad[0].message || "error").slice(0, 300)}`;
			if (source.afterBatch) await source.afterBatch(items, results, integ.id);
			if (r.cancel) {
				await call(integ, "sync.end", { entity, job, cancelled: true });
				stats.message = stats.message || "cancelled";
				await log();
				return { cancelled: true };
			}
		}
		await call(integ, "sync.end", { entity, job });
		await log();
		return { ok: true, stats };
	} catch (e) {
		await client.call(integ, "sync.end", { entity, job, error: String(e.message || e).slice(0, 300) }).catch(() => {});
		stats.message = String(e.message || e).slice(0, 1000);
		await log();
		throw e;
	}
}

module.exports = { run };