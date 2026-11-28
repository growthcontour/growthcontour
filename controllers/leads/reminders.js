"use strict";

/**
 * Нагадування про заплановані активності ліда (дзвінок, зустріч, задача…).
 *
 * Черга — leads_reminders (id_activity → активність): на кожну заплановану активність з часом — одне нагадування
 * за LEAD_MIN хвилин до початку (якщо до початку менше — одразу в час активності).
 *   schedule(idActivity) — після створення / зміни / повернення в «заплановано» (старе нагадування замінюється);
 *   cancel(idActivity)   — активність виконана, скасована, видалена.
 * Фонова служба лідів щохвилини надсилає ті, що настали (status pending → sent), — відповідальному за активність,
 * або відповідальному за лід. Якщо активність вже не запланована — нагадування скасовується без надсилання.
 */

const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const i18n = require("../../config/i18n/i18n");

const P = config.get("configDatabase").prefix;
const LOCALE = process.env.APP_LOCALE || "uk";
const tSys = (phrase, vars) => i18n.__({ phrase, locale: LOCALE }, vars || {});
const LEAD_MIN = 15;

async function cancel(idActivity) {
	await pool.query(`UPDATE \`${P}leads_reminders\` SET status = 'cancelled', date_edit = NOW() WHERE id_activity = ? AND status = 'pending'`, [idActivity]);
}

async function schedule(idActivity) {
	await cancel(idActivity);
	const [[a]] = await pool.query(
		`SELECT a.id, a.id_lead, a.id_manager, a.subject, a.scheduled_at, l.id_manager AS lead_manager
		   FROM \`${P}leads_activities\` a JOIN \`${P}leads\` l ON l.id = a.id_lead
		  WHERE a.id = ? AND a.status = 'planned' AND a.deleted_at IS NULL AND a.scheduled_at IS NOT NULL AND l.deleted_at IS NULL`,
		[idActivity]
	);
	if (!a) return null;
	const [r] = await pool.query(
		`INSERT INTO \`${P}leads_reminders\` (id_lead, id_activity, id_manager, text, remind_at, status, date_add, date_edit)
		 VALUES (?, ?, ?, ?, GREATEST(NOW(), ? - INTERVAL ${LEAD_MIN} MINUTE), 'pending', NOW(), NOW())`,
		[a.id_lead, a.id, a.id_manager || a.lead_manager || null, String(a.subject || "").slice(0, 1000), a.scheduled_at]
	);
	return r.insertId;
}

/** Надіслати нагадування, час яких настав (фонова служба) */
async function tick() {
	const [rows] = await pool.query(
		`SELECT r.id, r.id_lead, r.id_manager, r.text, a.status AS act_status, a.deleted_at AS act_deleted, a.scheduled_at, a.type, l.title, l.deleted_at AS lead_deleted, l.id_manager AS lead_manager
		   FROM \`${P}leads_reminders\` r
		   LEFT JOIN \`${P}leads_activities\` a ON a.id = r.id_activity
		   LEFT JOIN \`${P}leads\` l ON l.id = r.id_lead
		  WHERE r.status = 'pending' AND r.remind_at <= NOW()
		  ORDER BY r.remind_at LIMIT 200`
	);
	for (const r of rows) {
		const stale = r.act_status !== "planned" || r.act_deleted || r.lead_deleted;
		const to = r.id_manager || r.lead_manager;
		// Позначаємо до надсилання: інший процес цей рядок вже не візьме
		const [u] = await pool.query(`UPDATE \`${P}leads_reminders\` SET status = ?, sent_at = ${stale ? "NULL" : "NOW()"}, date_edit = NOW() WHERE id = ? AND status = 'pending'`, [stale || !to ? "cancelled" : "sent", r.id]);
		if (!u.affectedRows || stale || !to) continue;
		Promise.resolve(
			require("../notifications").notify({
				type: "leads.reminder",
				channels: ["inapp"],
				audience: { user: Number(to) },
				key: `leads_reminder_${r.id}`,
				priority: 7,
				payload: {
					title: tSys("leads.reminders.n.title", { time: String(r.scheduled_at || "").slice(11, 16) }),
					name: r.text || tSys("leads.work.type." + (r.type || "task")),
					message: r.title || "#" + r.id_lead,
					url: `/leads/${r.id_lead}/`,
				},
			})
		).catch((e) => logging.error(e));
	}
}

module.exports = { schedule, cancel, tick, LEAD_MIN };