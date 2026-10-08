"use strict";
/**
 * Воркер розсилок на MySQL (без Redis).
 * - tick (1 с): забирає пачки листів (FOR UPDATE SKIP LOCKED), рахує ліміти, відправляє
 * - scheduler (15 с): старт запланованих кампаній, A/B-переможець, завершення, статистика, відновлення
 *
 * Ліміти швидкості тримаються в пам'яті процесу → воркер має працювати в ОДНОМУ процесі
 * (у решти MAILING_WORKER=0).
 */
const os = require("os");
const model = require("./model");
const audience = require("./audience");
const render = require("./render");
const sender = require("./sender");

const { pool, T } = model;

const WORKER = `${os.hostname()}:${process.pid}`.slice(0, 64);
const BATCH = () => Math.max(1, Math.min(500, parseInt(process.env.MAILING_BATCH_SIZE, 10) || 50));
const STALE_MIN = 10;
const RETRY_MIN = [5, 15, 60, 180, 360];
const MAX_ATTEMPTS = 5;
const jsonOf = (v) => (typeof v === "string" ? JSON.parse(v) : v || null);

// ─── ЛІМІТИ ШВИДКОСТІ ───────────────────────────────────
class Bucket {
	constructor(perMin) {
		this.tokens = null;
		this.set(perMin);
	}
	set(perMin) {
		this.rate = Math.max(1, perMin) / 60000;
		this.cap = Math.max(1, Math.ceil(perMin / 6)); // запас на ~10 секунд
		if (this.tokens === null) {
			this.tokens = this.cap;
			this.at = Date.now();
		}
	}
	take(n) {
		const now = Date.now();
		this.tokens = Math.min(this.cap, this.tokens + (now - this.at) * this.rate);
		this.at = now;
		const got = Math.max(0, Math.min(n, Math.floor(this.tokens)));
		this.tokens -= got;
		return got;
	}
	give(n) {
		this.tokens = Math.min(this.cap, this.tokens + n);
	}
}

const senderBuckets = new Map();
const domainBuckets = new Map();
const domainPausedUntil = new Map();
const daily = new Map();

function bucketOf(map, key, perMin) {
	let b = map.get(key);
	if (!b) {
		b = new Bucket(perMin);
		map.set(key, b);
	} else b.set(perMin);
	return b;
}

async function dailyLeft(s) {
	const lim = sender.effectiveDailyLimit(s);
	if (!lim) return Infinity;
	const day = new Date().toISOString().slice(0, 10);
	let d = daily.get(s.id);
	if (!d || d.day !== day) {
		const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.messages} WHERE id_sender = ? AND date_sent >= ?`, [s.id, day + " 00:00:00"]);
		d = { day, n: Number(r.n) || 0 };
		daily.set(s.id, d);
	}
	return Math.max(0, lim - d.n);
}

// ─── ЗМІНИ СТАТУСУ ──────────────────────────────────────
const release = (id, delaySec, attempt = false, response = null) =>
	pool.query(
		`UPDATE ${T.messages}
            SET status = 'queued', locked_by = NULL, date_locked = NULL,
                attempts = attempts + ?, smtp_response = COALESCE(?, smtp_response),
                date_next_attempt = UTC_TIMESTAMP() + INTERVAL ? SECOND
          WHERE id = ?`,
		[attempt ? 1 : 0, response ? String(response).slice(0, 512) : null, Math.max(0, delaySec), id]
	);

const finish = (id, status, extra = {}) =>
	pool.query(
		`UPDATE ${T.messages}
            SET status = ?, skip_reason = ?, smtp_response = COALESCE(?, smtp_response), bounce_type = COALESCE(?, bounce_type),
                attempts = attempts + ?, locked_by = NULL, date_locked = NULL
          WHERE id = ?`,
		[status, extra.skip_reason || null, extra.response ? String(extra.response).slice(0, 512) : null, extra.bounce_type || null, extra.attempt ? 1 : 0, id]
	);

// ─── ЗАБРАТИ ПАЧКУ ──────────────────────────────────────
async function claim(idSender, n) {
	return model.withTx(async (conn) => {
		const [rows] = await conn.query(
			`SELECT m.id
               FROM ${T.messages} m
               INNER JOIN ${T.campaigns} c ON c.id = m.id_campaign AND c.status = 'sending'
              WHERE m.id_sender = ? AND m.status = 'queued' AND m.date_next_attempt <= UTC_TIMESTAMP()
              ORDER BY m.date_next_attempt, m.id
              LIMIT ?
              FOR UPDATE OF m SKIP LOCKED`,
			[idSender, n]
		);
		if (!rows.length) return [];
		const ids = rows.map((r) => r.id);
		await conn.query(`UPDATE ${T.messages} SET status = 'sending', locked_by = ?, date_locked = UTC_TIMESTAMP() WHERE id IN (?)`, [WORKER, ids]);
		return ids;
	});
}

async function loadBatch(ids) {
	const [rows] = await pool.query(
		`SELECT m.*, mc.status AS contact_status, mc.deleted AS contact_deleted, mc.first_name, mc.last_name, mc.fields,
                c.name AS campaign_name, c.type AS campaign_type, c.track_opens, c.track_clicks, c.utm, c.ignore_frequency_cap,
                v.from_name AS variant_from_name,
                (EXISTS (SELECT 1 FROM ${T.supp} x WHERE x.type = 'email' AND x.value = m.email)
                 OR EXISTS (SELECT 1 FROM ${T.supp} x WHERE x.type = 'domain' AND x.value = m.email_domain)) AS suppressed
           FROM ${T.messages} m
           INNER JOIN ${T.contacts} mc ON mc.id = m.id_contact
           INNER JOIN ${T.campaigns} c ON c.id = m.id_campaign
           LEFT JOIN ${T.variants} v ON v.id = m.id_variant
          WHERE m.id IN (?)
          ORDER BY m.id`,
		[ids]
	);
	return rows;
}

// ─── ОДИН ЛИСТ ──────────────────────────────────────────
async function processOne(s, m, settings) {
	if (m.contact_deleted || m.contact_status !== "active" || Number(m.suppressed)) {
		return finish(m.id, "skipped", { skip_reason: Number(m.suppressed) ? "suppressed" : "unsubscribed" });
	}

	const dk = s.id + "|" + m.email_domain;
	if ((domainPausedUntil.get(dk) || 0) > Date.now()) return release(m.id, 60);
	const limits = jsonOf(s.domain_limits) || {};
	if (limits[m.email_domain] && !bucketOf(domainBuckets, dk, limits[m.email_domain]).take(1)) return release(m.id, 15);

	const cap = settings.frequency_cap || {};
	if (cap.count > 0 && !m.ignore_frequency_cap && m.campaign_type !== "automation") {
		const [[r]] = await pool.query(
			`SELECT COUNT(*) AS n FROM ${T.messages}
              WHERE id_contact = ? AND status = 'sent' AND id_campaign <> ? AND date_sent >= UTC_TIMESTAMP() - INTERVAL ? DAY`,
			[m.id_contact, m.id_campaign, Math.max(1, cap.days || 7)]
		);
		if (Number(r.n) >= cap.count) return finish(m.id, "skipped", { skip_reason: "frequency_cap" });
	}

	const campaign = { id: m.id_campaign, name: m.campaign_name, track_opens: !!m.track_opens, track_clicks: !!m.track_clicks, utm: m.utm };
	let mail;
	try {
		mail = await render.buildMessage(m, campaign, s);
	} catch (e) {
		console.error("[mailing:render]", m.id, e.message);
		return finish(m.id, "failed", { response: "render: " + e.message, attempt: true });
	}

	try {
		const info = await sender.send(s, {
			from: { name: m.variant_from_name || s.from_name, address: s.from_email },
			replyTo: s.reply_to || undefined,
			to: m.email,
			subject: mail.subject,
			html: mail.html,
			text: mail.text,
			messageId: mail.messageId,
			headers: mail.headers,
			envelope: { from: mail.envelopeFrom, to: m.email },
		});
		await pool.query(
			`UPDATE ${T.messages}
                SET status = 'sent', attempts = attempts + 1, message_id = ?, smtp_response = ?, date_sent = UTC_TIMESTAMP(),
                    locked_by = NULL, date_locked = NULL
              WHERE id = ?`,
			[String(info.messageId || mail.messageId).slice(0, 255), String(info.response || "").slice(0, 512), m.id]
		);
		await pool.query(`UPDATE ${T.contacts} SET date_last_sent = UTC_TIMESTAMP() WHERE id = ?`, [m.id_contact]);
		const d = daily.get(s.id);
		if (d) d.n++;
	} catch (e) {
		return handleSendError(s, m, e);
	}
}

async function handleSendError(s, m, e) {
	const kind = sender.classify(e);
	const resp = String(e.response || e.message || e.code || "error");

	if (kind === "hard") {
		await finish(m.id, "bounced", { bounce_type: "hard", response: resp, attempt: true });
		await model.suppress(null, { type: "email", value: m.email, reason: "hard_bounce", id_message: m.id, note: resp.slice(0, 200) }).catch(() => {});
		await pool.query(`INSERT INTO ${T.events} (id_message, id_campaign, id_contact, type, meta, date_add) VALUES (?, ?, ?, 'bounce', ?, UTC_TIMESTAMP(3))`, [m.id, m.id_campaign, m.id_contact, JSON.stringify({ bounce: "hard", code: e.responseCode || null, diagnostic: resp.slice(0, 500), stage: "smtp" })]);
		return;
	}

	if (kind === "soft" || kind === "blocked") {
		const attempts = (Number(m.attempts) || 0) + 1;
		if (attempts >= MAX_ATTEMPTS) return finish(m.id, "failed", { response: resp, attempt: true });
		return release(m.id, RETRY_MIN[attempts - 1] * 60, true, resp);
	}

	if (kind === "throttle") {
		domainPausedUntil.set(s.id + "|" + m.email_domain, Date.now() + 5 * 60000);
		return release(m.id, 5 * 60, false, resp);
	}

	if (kind === "auth") {
		await release(m.id, 60, false, resp);
		await pool.query(`UPDATE ${T.campaigns} SET status = 'paused', last_error = ? WHERE id_sender = ? AND status = 'sending'`, ["smtp_auth: " + resp.slice(0, 900), s.id]);
		sender.closeTransport(s.id);
		console.error("[mailing] SMTP auth failed, campaigns paused. Sender:", s.id);
		return "stop";
	}

	// transient: проблема з'єднання — не вина отримувача
	await release(m.id, 120, false, resp);
	sender.closeTransport(s.id);
	return "stop";
}

async function runPool(items, n, fn) {
	let i = 0;
	let stop = false;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (!stop && i < items.length) {
				const it = items[i++];
				try {
					if ((await fn(it)) === "stop") stop = true;
				} catch (e) {
					console.error("[mailing:process]", it.id, e.message);
				}
			}
		})
	);
}

// ─── TICK ───────────────────────────────────────────────
let tickBusy = false;

async function tick() {
	if (tickBusy) return;
	tickBusy = true;
	try {
		const [senders] = await pool.query(
			`SELECT s.* FROM ${T.senders} s
              WHERE s.active = 1 AND s.deleted = 0
                AND EXISTS (SELECT 1 FROM ${T.messages} m INNER JOIN ${T.campaigns} c ON c.id = m.id_campaign AND c.status = 'sending'
                             WHERE m.id_sender = s.id AND m.status = 'queued' AND m.date_next_attempt <= UTC_TIMESTAMP())`
		);
		if (!senders.length) return;
		const settings = await model.getSettings();

		for (const s of senders) {
			const bucket = bucketOf(senderBuckets, s.id, s.rate_per_minute);
			const left = await dailyLeft(s);
			const want = bucket.take(Math.min(BATCH(), left));
			if (!want) continue;

			const ids = await claim(s.id, want);
			if (ids.length < want) bucket.give(want - ids.length);
			if (!ids.length) continue;

			try {
				const rows = await loadBatch(ids);
				await runPool(rows, Math.max(1, s.smtp_max_connections || 3), (m) => processOne(s, m, settings));
			} finally {
				// Усе, що лишилось заблокованим (зупинка через помилку з'єднання тощо), — назад у чергу
				await pool.query(`UPDATE ${T.messages} SET status = 'queued', locked_by = NULL, date_locked = NULL WHERE id IN (?) AND status = 'sending' AND locked_by = ?`, [ids, WORKER]);
			}
		}
	} finally {
		tickBusy = false;
	}
}

// ─── ПЛАНУВАЛЬНИК ───────────────────────────────────────
const preparing = new Set();

async function startDue() {
	// timezone: локальний час отримувача; найраніший пояс UTC+14 → готуємо за 14 год
	const [rows] = await pool.query(
		`SELECT id FROM ${T.campaigns}
          WHERE deleted = 0 AND type <> 'automation'
            AND (status = 'preparing'
                 OR (status = 'scheduled' AND (
                        send_mode = 'now' OR date_scheduled IS NULL
                        OR (send_mode = 'scheduled' AND date_scheduled <= UTC_TIMESTAMP() + INTERVAL 5 MINUTE)
                        OR (send_mode = 'timezone' AND date_scheduled <= UTC_TIMESTAMP() + INTERVAL 14 HOUR))))
          LIMIT 10`
	);
	for (const r of rows) {
		if (preparing.has(r.id)) continue;
		preparing.add(r.id);
		audience
			.fanOut(r.id)
			.catch(async (e) => {
				console.error("[mailing:fanout]", r.id, e.message);
				await pool.query(`UPDATE ${T.campaigns} SET status = 'failed', last_error = ? WHERE id = ? AND status = 'preparing'`, [String(e.message).slice(0, 1000), r.id]);
			})
			.finally(() => preparing.delete(r.id));
	}
}

async function decideAb() {
	const [rows] = await pool.query(
		`SELECT c.id, c.ab_metric
           FROM ${T.campaigns} c
          WHERE c.status = 'sending' AND c.type = 'ab' AND c.id_variant_winner IS NULL
            AND EXISTS (SELECT 1 FROM ${T.messages} m WHERE m.id_campaign = c.id AND m.status = 'waiting')
            AND NOT EXISTS (SELECT 1 FROM ${T.messages} m WHERE m.id_campaign = c.id AND m.status IN ('queued','sending') AND m.id_variant IS NOT NULL)
            AND COALESCE((SELECT MAX(m.date_sent) FROM ${T.messages} m WHERE m.id_campaign = c.id), c.date_launched)
                <= UTC_TIMESTAMP() - INTERVAL COALESCE(c.ab_wait_minutes, 240) MINUTE`
	);
	for (const c of rows) {
		const [stats] = await pool.query(
			`SELECT id_variant, COUNT(*) AS sent,
                    SUM(date_first_open_human IS NOT NULL OR date_first_click IS NOT NULL) AS opens,
                    SUM(date_first_click IS NOT NULL) AS clicks
               FROM ${T.messages}
              WHERE id_campaign = ? AND status = 'sent' AND id_variant IS NOT NULL
              GROUP BY id_variant ORDER BY id_variant`,
			[c.id]
		);
		let winner = null;
		let best = -1;
		for (const v of stats) {
			const rate = Number(v.sent) ? Number(c.ab_metric === "click" ? v.clicks : v.opens) / Number(v.sent) : 0;
			if (rate > best) {
				best = rate;
				winner = v.id_variant;
			}
		}
		if (!winner) {
			const [[v]] = await pool.query(`SELECT id FROM ${T.variants} WHERE id_campaign = ? ORDER BY code LIMIT 1`, [c.id]);
			winner = v && v.id;
		}
		if (!winner) continue;
		const [r] = await pool.query(`UPDATE ${T.campaigns} SET id_variant_winner = ?, date_ab_decided = UTC_TIMESTAMP() WHERE id = ? AND id_variant_winner IS NULL`, [winner, c.id]);
		if (r.affectedRows) {
			await pool.query(`UPDATE ${T.messages} SET id_variant = ?, status = 'queued', date_next_attempt = UTC_TIMESTAMP() WHERE id_campaign = ? AND status = 'waiting'`, [winner, c.id]);
		}
	}
}

async function finishDone() {
	await pool.query(
		`UPDATE ${T.campaigns} c
            SET c.status = 'sent', c.date_finished = UTC_TIMESTAMP()
          WHERE c.status = 'sending' AND c.type <> 'automation'
            AND NOT EXISTS (SELECT 1 FROM ${T.messages} m WHERE m.id_campaign = c.id AND m.status IN ('queued','sending','waiting'))`
	);
}

async function recountStats(ids) {
	const list = model.ints(ids);
	if (!list.length) return;
	await pool.query(
		`UPDATE ${T.campaigns} c
          INNER JOIN (
                SELECT id_campaign,
                       COUNT(*) AS total,
                       SUM(status = 'sent') AS sent,
                       SUM(status = 'failed') AS failed,
                       SUM(status = 'skipped') AS skipped,
                       SUM(bounce_type IS NOT NULL) AS bounced,
                       SUM(date_first_open IS NOT NULL) AS opened,
                       SUM(date_first_open_human IS NOT NULL OR date_first_click IS NOT NULL) AS opened_human,
                       SUM(date_first_click IS NOT NULL) AS clicked,
                       SUM(date_complained IS NOT NULL) AS complained,
                       SUM(date_unsubscribed IS NOT NULL) AS unsubscribed
                  FROM ${T.messages}
                 WHERE id_campaign IN (?)
                 GROUP BY id_campaign
          ) x ON x.id_campaign = c.id
            SET c.cnt_total = x.total, c.cnt_sent = x.sent, c.cnt_failed = x.failed, c.cnt_skipped = x.skipped,
                c.cnt_bounced = x.bounced, c.cnt_opened = x.opened, c.cnt_opened_human = x.opened_human,
                c.cnt_clicked = x.clicked, c.cnt_complained = x.complained, c.cnt_unsubscribed = x.unsubscribed,
                c.date_stats = UTC_TIMESTAMP()`,
		[list]
	);
}

async function refreshStats() {
	const [rows] = await pool.query(
		`SELECT id FROM ${T.campaigns}
          WHERE deleted = 0
            AND (status IN ('sending','paused') OR date_finished >= UTC_TIMESTAMP() - INTERVAL 30 DAY)
            AND (date_stats IS NULL OR date_stats < UTC_TIMESTAMP() - INTERVAL IF(status = 'sending', 15, 600) SECOND)
          ORDER BY date_stats IS NULL DESC, date_stats
          LIMIT 20`
	);
	await recountStats(rows.map((r) => r.id));
}

/** Повернути листи, що зависли в 'sending' (процес впав посеред відправки) */
async function recoverStale() {
	const [r] = await pool.query(
		`UPDATE ${T.messages} SET status = 'queued', locked_by = NULL, date_locked = NULL
          WHERE status = 'sending' AND date_locked < UTC_TIMESTAMP() - INTERVAL ? MINUTE`,
		[STALE_MIN]
	);
	if (r.affectedRows) console.log(`[mailing] recovered ${r.affectedRows} stale messages`);
}

let schedBusy = false;
async function scheduler() {
	if (schedBusy) return;
	schedBusy = true;
	try {
		await recoverStale();
		await startDue();
		await decideAb();
		await finishDone();
		await refreshStats();
	} finally {
		schedBusy = false;
	}
}

// ─── СТАРТ ──────────────────────────────────────────────
const periodic = []; // інші частини розсилки додають сюди свої задачі: { name, everyMs, fn }
let started = false;

function every(name, ms, fn) {
	let busy = false;
	setInterval(async () => {
		if (busy) return;
		busy = true;
		try {
			await fn();
		} catch (e) {
			console.error(`[mailing:${name}]`, e.message);
		} finally {
			busy = false;
		}
	}, ms);
}

function start() {
	if (started) return;
	started = true;
	if (!process.env.MAILING_TOKEN_SECRET) {
		console.error("[mailing] MAILING_TOKEN_SECRET is missing — worker disabled");
		return;
	}
	require("./import")
		.recover()
		.catch((e) => console.error("[mailing:import-recover]", e.message));
	every("tick", 1000, tick);
	every("scheduler", 15000, scheduler);
	every("clients-sync", 30 * 60000, () => model.syncFromClients());
	every("imports", 3000, () => require("./import").tick());
	every("imports-cleanup", 60 * 60000, () => require("./import").cleanup());
	for (const p of periodic) every(p.name, p.everyMs, p.fn);
	console.log(`[mailing] worker started (${WORKER})`);
}

module.exports = { start, tick, scheduler, recountStats, decideAb, periodic, WORKER };
