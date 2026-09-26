const cfg = require("../../config/notifications/config");
const logging = require("../../logging/logging");
const pool = require("../../config/database/connection_pool");

if (cfg.driver !== "bull") {
	console.log("[notif worker] driver != bull — воркер не потрібен (sync-режим).");
	process.exit(0);
}

const { Worker } = require("bullmq");
const { connection } = require("./redis");
const dispatch = require("./dispatch");
const channels = require("./channels");

const P = cfg.prefix;

// 1) Воркер диспетчера: резолвить аудиторію, матеріалізує, розкидає send-job
const dispatchWorker = new Worker("notif:dispatch", async (job) => dispatch.dispatchEvent(job.data.eventId), { connection, concurrency: 8 });

// 2) Воркери каналів з rate-limit
function channelWorker(channel, limiter, concurrency) {
	return new Worker(`notif:send:${channel}`, async (job) => channels.deliver(channel, job.data), {
		connection,
		concurrency: concurrency || 10,
		limiter, // { max, duration } — глобальний ліміт каналу
	});
}

const inappWorker = channelWorker("inapp", null, 20);
const telegramWorker = channelWorker("telegram", cfg.limits.telegram, 5);
const emailWorker = channelWorker("email", cfg.limits.email, 5);
const webpushWorker = channelWorker("webpush", cfg.limits.webpush, 10);

// Воркер завантаження вкладень контакт-центру
const files = require("../contact-center/files");
const ccAttachmentsWorker = new Worker("cc:attachments", async (job) => files.processOne(job.data.attachmentId), { connection, concurrency: 5 });

// Логи помилок по всіх воркерах
[dispatchWorker, inappWorker, telegramWorker, emailWorker, webpushWorker, ccAttachmentsWorker].forEach((w) => {
	w.on("failed", (job, err) => {
		logging.error({ queue: w.name, jobId: job && job.id, err: err && err.message });
	});
});

// 3) FALLBACK-ПОЛЕР OUTBOX: події, що не потрапили в чергу (Redis лежав у notify())
async function pollOutbox() {
	try {
		const [rows] = await pool.query(
			`SELECT id FROM ${P}notif_events
        WHERE dispatched = 0
        ORDER BY id ASC
        LIMIT 200`
		);
		for (const r of rows) {
			await dispatch.dispatchEvent(r.id).catch((e) => logging.error(e));
		}
	} catch (e) {
		logging.error(e);
	} finally {
		setTimeout(pollOutbox, cfg.outboxPollMs);
	}
}
pollOutbox();

console.log("[notif worker] запущено (bull). Черги: dispatch, inapp, telegram, email, webpush.");

// Акуратне завершення
async function shutdown() {
	await Promise.allSettled([dispatchWorker.close(), inappWorker.close(), telegramWorker.close(), emailWorker.close(), webpushWorker.close(), ccAttachmentsWorker.close()]);
	process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
