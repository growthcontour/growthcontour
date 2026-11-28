"use strict";

/**
 * Фонова служба лідів (раз на хвилину, один процес — MySQL GET_LOCK):
 *
 * 1. Час першої відповіді (SLA). Етап воронки має «годин на реакцію» (leads_pipeline_stages.sla_hours, 0 — без контролю).
 *    - Новий лід (з будь-якого джерела) без дедлайну отримує response_deadline = зараз + години етапу.
 *      Лише ліди, створені за останню добу, — старі ліди при запуску не «прострочуються» гуртом.
 *    - Зміна етапу до першої відповіді — дедлайн рахується заново за новим етапом (arm()).
 *    - Відповідь — перша виконана вихідна активність (controllers/leads/work.js → first_response_at).
 *    - Нагадування відповідальному незадовго до дедлайну (чверть часу етапу, не більше 30 хв),
 *      порушення — коли дедлайн минув. Обидва — сповіщенням ядра і рядком історії ліда
 *      (sla_warning / sla_breach; value_new = дедлайн, тож для кожного дедлайну — лише раз).
 *    - Закриті ліди (статус won/lost або конвертовані) не контролюються.
 * 2. Розподіл і сповіщення для нових лідів з чату й контакт-центру — controllers/leads/routing.js.
 * 3. Автоматизації (controllers/leads/automations.js) і нагадування про активності (controllers/leads/reminders.js).
 * 4. Скоринг за правилами: змінені ліди і згасання балів активності (controllers/leads/scoring.js).
 * 5. Дублікати: нові ліди і ліди зі зміненими контактами (duplicate_method IS NULL, зміна за останню добу —
 *    без перевірки всієї старої бази при запуску) — controllers/leads/dupes.js.
 */

const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const i18n = require("../../config/i18n/i18n");

const P = config.get("configDatabase").prefix;
const LOCALE = process.env.APP_LOCALE || "uk";
const tSys = (phrase, vars) => i18n.__({ phrase, locale: LOCALE }, vars || {});
const TICK_MS = 60 * 1000;
const BATCH = 200;

const OPEN = `l.deleted_at IS NULL AND l.first_response_at IS NULL AND l.is_converted = 0
	AND NOT EXISTS (SELECT 1 FROM \`${P}leads_settings_status\` st WHERE st.id = l.id_status AND st.system_type IN ('won', 'lost'))`;

/** Дедлайн за поточним етапом (виклик після зміни етапу); без відповіді — лише для відкритих лідів */
async function arm(idLead) {
	await pool.query(
		`UPDATE \`${P}leads\` l LEFT JOIN \`${P}leads_pipeline_stages\` s ON s.id = l.id_stage
		    SET l.response_deadline = IF(s.sla_hours > 0, NOW() + INTERVAL s.sla_hours HOUR, NULL)
		  WHERE l.id = ? AND l.first_response_at IS NULL`,
		[idLead]
	);
}

/** Нові ліди без дедлайну — дедлайн за етапом */
async function armNew() {
	await pool.query(
		`UPDATE \`${P}leads\` l JOIN \`${P}leads_pipeline_stages\` s ON s.id = l.id_stage
		    SET l.response_deadline = NOW() + INTERVAL s.sla_hours HOUR
		  WHERE l.response_deadline IS NULL AND s.sla_hours > 0 AND l.date_add > NOW() - INTERVAL 1 DAY AND ${OPEN}`
	);
}

/** Відповідальному — сповіщення (без відповідального — лише історія і позначка в списку) */
function send(l, kind) {
	if (!l.id_manager) return;
	Promise.resolve(
		require("../notifications").notify({
			type: kind === "breach" ? "leads.sla_breach" : "leads.sla_warning",
			channels: ["inapp"],
			audience: { user: Number(l.id_manager) },
			key: `leads_${kind}_${l.id}_${String(l.response_deadline).replace(/\D/g, "")}`,
			priority: kind === "breach" ? 8 : 6,
			payload: {
				title: tSys(kind === "breach" ? "leads.sla.n.breach" : "leads.sla.n.warning", { id: String(l.id) }),
				name: l.title || "#" + l.id,
				message: tSys(kind === "breach" ? "leads.sla.n.breach_text" : "leads.sla.n.warning_text", { deadline: String(l.response_deadline).slice(0, 16), min: String(Math.max(1, Math.round(Number(l.left_sec || 0) / 60))) }),
				url: `/leads/${l.id}/`,
			},
		})
	).catch((e) => logging.error(e));
}

async function scan(kind) {
	const action = kind === "breach" ? "sla_breach" : "sla_warning";
	// Нагадування — коли лишилось менше чверті часу етапу (не більше 30 хв); порушення — дедлайн минув (не старше доби)
	const when =
		kind === "breach"
			? "l.response_deadline <= NOW() AND l.response_deadline > NOW() - INTERVAL 1 DAY"
			: "l.response_deadline > NOW() AND l.response_deadline <= NOW() + INTERVAL LEAST(30, GREATEST(1, COALESCE(s.sla_hours, 1)) * 15) MINUTE";
	const [rows] = await pool.query(
		`SELECT l.id, l.title, l.id_manager, l.response_deadline, TIMESTAMPDIFF(SECOND, NOW(), l.response_deadline) AS left_sec
		   FROM \`${P}leads\` l LEFT JOIN \`${P}leads_pipeline_stages\` s ON s.id = l.id_stage
		  WHERE ${when} AND ${OPEN}
		    AND NOT EXISTS (SELECT 1 FROM \`${P}leads_history\` h WHERE h.id_lead = l.id AND h.action_type = ? AND h.value_new = CAST(l.response_deadline AS CHAR))
		  LIMIT ${BATCH}`,
		[action]
	);
	for (const l of rows) {
		await pool.query(
			`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES (?, NULL, ?, 'response_deadline', NULL, ?, NULL, 'system', NULL, NOW())`,
			[l.id, action, String(l.response_deadline)]
		);
		send(l, kind);
		if (kind === "breach") require("./routing").onBreach(l);
	}
	return rows.length;
}

/**
 * Нові ліди з інших джерел (чат, контакт-центр): розподіл і сповіщення отримувачам — як для форм і створення вручну.
 * Форми сайтів і створення вручну викликають routing.onNew самі; повтор тут не дублює сповіщень (ключ події) і не
 * перепризначає (лише ліди без відповідального). seen — щоб не перевіряти той самий лід щохвилини.
 */
const seen = new Set();
async function routeNew() {
	const [rows] = await pool.query(
		`SELECT id FROM \`${P}leads\` WHERE deleted_at IS NULL AND date_add > NOW() - INTERVAL 1 DAY AND capture_type NOT IN ('api', 'manual') ORDER BY id DESC LIMIT ${BATCH}`
	);
	const routing = require("./routing");
	for (const r of rows) {
		if (seen.has(r.id)) continue;
		seen.add(r.id);
		await routing.onNew(r.id);
	}
	if (seen.size > 20000) seen.clear();
}

async function dupes() {
	const [rows] = await pool.query(`SELECT id FROM \`${P}leads\` WHERE duplicate_method IS NULL AND deleted_at IS NULL AND date_edit > NOW() - INTERVAL 1 DAY ORDER BY id LIMIT ${BATCH}`);
	const d = require("./dupes");
	for (const r of rows) {
		try {
			await d.check(r.id);
		} catch (e) {
			logging.error(e);
		}
	}
}

let running = false;
let lastIdle = 0;
async function tick() {
	if (running) return;
	running = true;
	const conn = await pool.getConnection();
	try {
		const [[lock]] = await conn.query(`SELECT GET_LOCK(?, 0) AS ok`, [P + "leads_watch"]);
		if (!lock || !Number(lock.ok)) return;
		try {
			await routeNew();
			await armNew();
			// Автоматизації: відкладені й ті, що не встигли виконатись; «без змін N днів» — раз на 10 хв
			const auto = require("./automations");
			if (Date.now() - lastIdle >= 10 * 60 * 1000) {
				lastIdle = Date.now();
				await auto.scanIdle().catch((e) => logging.error(e));
			}
			await auto.drain().catch((e) => logging.error(e));
			await require("./reminders").tick().catch((e) => logging.error(e));
			await require("./scoring").tick().catch((e) => logging.error(e));
			await scan("warning");
			await scan("breach");
			await dupes();
		} finally {
			await conn.query(`SELECT RELEASE_LOCK(?)`, [P + "leads_watch"]);
		}
	} catch (e) {
		logging.error(e);
	} finally {
		conn.release();
		running = false;
	}
}

let timer = null;
function start() {
	if (timer) return;
	timer = setInterval(tick, TICK_MS);
	if (timer.unref) timer.unref();
	setTimeout(tick, 15 * 1000).unref?.();
}

module.exports = { start, tick, arm };