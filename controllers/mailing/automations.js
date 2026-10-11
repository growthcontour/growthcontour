"use strict";
/**
 * Автоматизації (ланцюжки листів): welcome, день народження, повернення неактивних, ручний запуск.
 *
 * Модель:
 *  - automation  — тригер + фільтр входу (audience) + мета (goal) + кроки
 *  - step        — email | wait | condition; email-крок = прихована кампанія type='automation'
 *                  (той самий редактор, черга, трекінг, відписка і звіт, що й у звичайних кампаній)
 *  - run         — проходження контакту по ланцюжку (id_step — наступний крок, date_next — коли)
 *
 * Лист кроку кладеться в mailing_messages з ref_key = 'r<id run>' — повторний вхід дає новий лист,
 * а повтор того самого кроку в межах одного проходження неможливий (унікальний ключ).
 *
 * Структуру (кроки, тригер, аудиторію) можна змінювати лише в чернетці або на паузі.
 * Вміст листів — завжди (зміни підхоплюються наступними листами).
 */
const model = require("./model");
const audience = require("./audience");
const sender = require("./sender");
const render = require("./render");

const { pool, P, T, err, ints } = model;
const A = {
	autos: `${P}mailing_automations`,
	steps: `${P}mailing_automation_steps`,
	runs: `${P}mailing_automation_runs`,
};
const jsonOf = (v) => (typeof v === "string" ? JSON.parse(v) : v || null);

const TRIGGERS = ["list_subscribe", "date_field", "inactive", "manual"];
const DAILY = ["date_field", "inactive"];
const ENROLL_LIMIT = 5000; // за один прохід на автоматизацію
const RUN_BATCH = 500; // проходжень за один тік
const MAX_STEPS = 30;

// Статус прихованих кампаній кроків відповідає статусу автоматизації
const CAMPAIGN_STATUS = { draft: "draft", active: "sending", paused: "paused" };

// ═══ ЧИТАННЯ ════════════════════════════════════════════
async function list(q) {
	const where = ["a.deleted = 0"];
	const params = [];
	if (q.search) {
		where.push("a.name LIKE ?");
		params.push("%" + String(q.search).replace(/[%_\\]/g, "\\$&") + "%");
	}
	if (["draft", "active", "paused"].includes(q.status)) {
		where.push("a.status = ?");
		params.push(q.status);
	}
	const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n FROM ${A.autos} a WHERE ${where.join(" AND ")}`, params);
	const size = q.size || 20;
	const page = q.page || 1;
	const [rows] = await pool.query(
		`SELECT a.id, a.name, a.status, a.trigger_type, a.date_activated, a.date_add,
                (SELECT COUNT(*) FROM ${A.steps} s WHERE s.id_automation = a.id AND s.deleted = 0) AS cnt_steps,
                (SELECT COUNT(*) FROM ${A.runs} r WHERE r.id_automation = a.id) AS cnt_entered,
                (SELECT COUNT(*) FROM ${A.runs} r WHERE r.id_automation = a.id AND r.status = 'active') AS cnt_active,
                (SELECT COALESCE(SUM(c.cnt_sent), 0) FROM ${T.campaigns} c WHERE c.id_automation = a.id AND c.type = 'automation') AS cnt_sent
           FROM ${A.autos} a
          WHERE ${where.join(" AND ")}
          ORDER BY a.id DESC
          LIMIT ? OFFSET ?`,
		[...params, size, (page - 1) * size]
	);
	const total = Number(cnt.n) || 0;
	return { data: rows, last_page: Math.max(1, Math.ceil(total / size)), last_row: total };
}

async function steps(idAutomation, conn = pool) {
	const [rows] = await conn.query(
		`SELECT s.id, s.sort_order, s.type, s.config, s.id_campaign, v.id AS id_variant
           FROM ${A.steps} s
           LEFT JOIN ${T.variants} v ON v.id_campaign = s.id_campaign AND v.code = 'A'
          WHERE s.id_automation = ? AND s.deleted = 0
          ORDER BY s.sort_order, s.id`,
		[idAutomation]
	);
	return rows.map((r) => ({ ...r, config: jsonOf(r.config) || {} }));
}

async function get(id) {
	const [[a]] = await pool.query(`SELECT * FROM ${A.autos} WHERE id = ? AND deleted = 0`, [id]);
	if (!a) throw err(404, "not_found");
	a.trigger_config = jsonOf(a.trigger_config) || {};
	a.audience = jsonOf(a.audience) || { lists: [] };
	a.goal = jsonOf(a.goal);
	a.utm = jsonOf(a.utm);
	a.steps = await steps(id);
	// Чи є вміст у листів (для чекліста в інтерфейсі)
	const vIds = a.steps.filter((s) => s.id_variant).map((s) => s.id_variant);
	const langs = new Map();
	if (vIds.length) {
		const [rows] = await pool.query(`SELECT id_owner, GROUP_CONCAT(id_lang) AS langs, MAX(subject) AS subject FROM ${T.contents} WHERE owner_type = 'variant' AND id_owner IN (?) GROUP BY id_owner`, [vIds]);
		for (const r of rows) langs.set(Number(r.id_owner), r);
	}
	for (const s of a.steps) {
		const c = langs.get(Number(s.id_variant));
		s.langs = c ? String(c.langs).split(",").map(Number) : [];
		s.subject = c ? c.subject : null;
	}
	return a;
}

// ═══ ЗБЕРЕЖЕННЯ ═════════════════════════════════════════
/** Нормалізація тригера: лише відомі ключі, числа в межах */
async function normTrigger(type, cfg) {
	const c = cfg || {};
	if (type === "list_subscribe") {
		const idList = parseInt(c.id_list, 10) || null;
		if (idList && !(await model.getList(idList))) throw err(400, "validation_error", { errors: [{ field: "trigger.id_list", message: "invalid" }] });
		return { id_list: idList };
	}
	if (type === "date_field") {
		const code = String(c.field || "");
		if (code) {
			const [[f]] = await pool.query(`SELECT code FROM ${T.fields} WHERE code = ? AND type = 'date'`, [code]);
			if (!f || !/^[a-z][a-z0-9_]{0,63}$/.test(f.code)) throw err(400, "validation_error", { errors: [{ field: "trigger.field", message: "invalid" }] });
		}
		return { field: code || null, offset_days: Math.max(-60, Math.min(60, parseInt(c.offset_days, 10) || 0)), hour: Math.max(0, Math.min(23, parseInt(c.hour, 10) || 10)) };
	}
	if (type === "inactive") {
		return { days: Math.max(7, Math.min(3650, parseInt(c.days, 10) || 90)), hour: Math.max(0, Math.min(23, parseInt(c.hour, 10) || 10)) };
	}
	return {};
}

/** Нормалізація кроку; condition.ref — індекс email-кроку в новому списку (а не id: нові кроки ще без id) */
function normStep(s, i, all) {
	const type = s.type;
	if (type === "wait") {
		const unit = ["minutes", "hours", "days"].includes(s.config && s.config.unit) ? s.config.unit : "days";
		const max = { minutes: 60 * 24 * 7, hours: 24 * 90, days: 365 }[unit];
		return { type, config: { amount: Math.max(1, Math.min(max, parseInt(s.config && s.config.amount, 10) || 1)), unit } };
	}
	if (type === "condition") {
		const c = s.config || {};
		const check = ["opened", "clicked", "segment"].includes(c.check) ? c.check : "opened";
		const cfg = { check, if_true: c.if_true === "exit" ? "exit" : "continue", if_false: c.if_false === "continue" ? "continue" : "exit" };
		if (check === "segment") cfg.segment = c.segment && typeof c.segment === "object" ? c.segment : null;
		else {
			// Посилання лише на email-крок ВИЩЕ умови
			let ref = parseInt(c.ref_index, 10);
			if (!(ref >= 0 && ref < i && all[ref].type === "email")) {
				ref = -1;
				for (let k = i - 1; k >= 0; k--) if (all[k].type === "email") { ref = k; break; }
			}
			if (ref < 0) throw err(400, "validation_error", { errors: [{ field: `steps.${i}`, message: "condition_no_email" }] });
			cfg.ref_index = ref;
		}
		return { type, config: cfg };
	}
	return { type: "email", config: {} };
}

async function save(id, d, idUser) {
	if (d.id_sender && !(await sender.getPublic(d.id_sender))) throw err(400, "validation_error", { errors: [{ field: "id_sender", message: "invalid" }] });
	const trigger = await normTrigger(d.trigger_type, d.trigger_config);
	const aud = { lists: ints((d.audience || {}).lists), exclude_lists: ints((d.audience || {}).exclude_lists), exclude_role: !!(d.audience || {}).exclude_role, segment: (d.audience || {}).segment || null };
	// Сегменти перевіряються білим списком audience.js ще до збереження
	if (aud.segment) await audience.build({ ...aud, lists: [1] });
	if (d.goal) await audience.build({ lists: [1], segment: d.goal });

	const input = (d.steps || []).slice(0, MAX_STEPS);
	const norm = input.map((s, i) => normStep(s, i, input));
	// Повторний вхід: для дня народження — не частіше ніж раз на ~рік
	let reentry = !!d.allow_reentry;
	let reentryDays = Math.max(0, Math.min(3650, parseInt(d.reentry_days, 10) || 0));
	if (d.trigger_type === "date_field") {
		reentry = true;
		reentryDays = Math.max(300, reentryDays);
	}

	const cols = {
		name: d.name,
		trigger_type: d.trigger_type,
		trigger_config: JSON.stringify(trigger),
		audience: JSON.stringify(aud),
		goal: d.goal ? JSON.stringify(d.goal) : null,
		id_sender: d.id_sender || null,
		track_opens: d.track_opens ? 1 : 0,
		track_clicks: d.track_clicks ? 1 : 0,
		utm: d.utm ? JSON.stringify(d.utm) : null,
		include_existing: d.include_existing ? 1 : 0,
		allow_reentry: reentry ? 1 : 0,
		reentry_days: reentryDays,
	};
	const keys = Object.keys(cols); // фіксований набір колонок

	const r = await model.withTx(async (conn) => {
		let aid = id;
		let status = "draft";
		if (id) {
			const [[cur]] = await conn.query(`SELECT status FROM ${A.autos} WHERE id = ? AND deleted = 0 FOR UPDATE`, [id]);
			if (!cur) throw err(404, "not_found");
			if (cur.status === "active") throw err(409, "automation_active");
			status = cur.status;
			await conn.query(`UPDATE ${A.autos} SET ${keys.map((k) => `\`${k}\` = ?`).join(", ")}, date_edit = UTC_TIMESTAMP() WHERE id = ?`, [...keys.map((k) => cols[k]), id]);
		} else {
			const [ins] = await conn.query(`INSERT INTO ${A.autos} (${keys.map((k) => `\`${k}\``).join(", ")}, status, id_user, date_add) VALUES (${keys.map(() => "?").join(", ")}, 'draft', ?, UTC_TIMESTAMP())`, [...keys.map((k) => cols[k]), idUser || null]);
			aid = ins.insertId;
		}

		// ─── Синхронізація кроків ───
		const old = await steps(aid, conn);
		const oldById = new Map(old.map((s) => [s.id, s]));
		const keep = new Set();
		const finalIds = [];
		for (let i = 0; i < norm.length; i++) {
			const s = norm[i];
			const reqId = parseInt(input[i].id, 10) || 0;
			const prev = oldById.get(reqId);
			let sid;
			let idCampaign = null;
			if (prev && prev.type === s.type && !keep.has(prev.id)) {
				sid = prev.id;
				idCampaign = prev.id_campaign;
			} else {
				const [ins] = await conn.query(`INSERT INTO ${A.steps} (id_automation, sort_order, type, config, date_add) VALUES (?, ?, ?, NULL, UTC_TIMESTAMP())`, [aid, i, s.type]);
				sid = ins.insertId;
			}
			keep.add(sid);
			finalIds.push(sid);
			if (s.type === "email") idCampaign = await ensureStepCampaign(conn, aid, sid, idCampaign, d.name, i + 1, cols, status, input[i].copy_from);
			await conn.query(`UPDATE ${A.steps} SET sort_order = ?, id_campaign = ? WHERE id = ?`, [i, idCampaign, sid]);
		}
		// Умови: індекс email-кроку → id кроку
		for (let i = 0; i < norm.length; i++) {
			const cfg = { ...norm[i].config };
			if (norm[i].type === "condition" && cfg.ref_index != null) {
				cfg.ref_step = finalIds[cfg.ref_index];
				delete cfg.ref_index;
			}
			await conn.query(`UPDATE ${A.steps} SET config = ? WHERE id = ?`, [JSON.stringify(cfg), finalIds[i]]);
		}

		// Видалені кроки: проходження, що стояли на них, переходять на наступний збережений крок старого порядку
		const removed = old.filter((s) => !keep.has(s.id));
		for (const s of removed) {
			const pos = old.indexOf(s);
			const next = old.slice(pos + 1).find((x) => keep.has(x.id));
			if (next) await conn.query(`UPDATE ${A.runs} SET id_step = ? WHERE id_automation = ? AND status = 'active' AND id_step = ?`, [next.id, aid, s.id]);
			else await conn.query(`UPDATE ${A.runs} SET status = 'completed', id_step = NULL, date_end = UTC_TIMESTAMP() WHERE id_automation = ? AND status = 'active' AND id_step = ?`, [aid, s.id]);
			await conn.query(`UPDATE ${A.steps} SET deleted = 1 WHERE id = ?`, [s.id]);
			if (s.id_campaign) {
				await conn.query(`UPDATE ${T.campaigns} SET status = 'cancelled', deleted = 1, date_deleted = UTC_TIMESTAMP(), id_user_deleted = ? WHERE id = ? AND type = 'automation'`, [idUser || null, s.id_campaign]);
				await conn.query(`UPDATE ${T.messages} SET status = 'cancelled' WHERE id_campaign = ? AND status IN ('queued','waiting')`, [s.id_campaign]);
			}
		}
		return { ok: true, id: aid };
	});
	clearCaches(r.id).catch(() => {});
	return r;
}

/** Прихована кампанія email-кроку: налаштування відправки дублюються з автоматизації */
async function ensureStepCampaign(conn, aid, sid, idCampaign, name, n, cols, status, copyFromVariant) {
	const cname = String(name).slice(0, 240) + " · #" + n;
	if (idCampaign) {
		await conn.query(
			`UPDATE ${T.campaigns} SET name = ?, id_sender = ?, track_opens = ?, track_clicks = ?, utm = ?, date_edit = UTC_TIMESTAMP()
              WHERE id = ? AND type = 'automation'`,
			[cname, cols.id_sender, cols.track_opens, cols.track_clicks, cols.utm, idCampaign]
		);
		return idCampaign;
	}
	const [c] = await conn.query(
		`INSERT INTO ${T.campaigns} (name, type, status, id_sender, id_automation, audience, send_mode, track_opens, track_clicks, utm, ignore_frequency_cap, date_add)
         VALUES (?, 'automation', ?, ?, ?, NULL, 'now', ?, ?, ?, 1, UTC_TIMESTAMP())`,
		[cname, CAMPAIGN_STATUS[status] || "draft", cols.id_sender, aid, cols.track_opens, cols.track_clicks, cols.utm]
	);
	const [v] = await conn.query(`INSERT INTO ${T.variants} (id_campaign, code) VALUES (?, 'A')`, [c.insertId]);
	// Копія вмісту з іншого кроку цієї ж автоматизації (кнопка «дублювати крок»)
	const from = parseInt(copyFromVariant, 10);
	if (from > 0) {
		await conn.query(
			`INSERT INTO ${T.contents} (owner_type, id_owner, id_lang, subject, preheader, editor, project, source, html, text, size_bytes, warnings, date_edit)
             SELECT 'variant', ?, x.id_lang, x.subject, x.preheader, x.editor, x.project, x.source, x.html, x.text, x.size_bytes, x.warnings, UTC_TIMESTAMP()
               FROM ${T.contents} x
               INNER JOIN ${T.variants} xv ON xv.id = x.id_owner
               INNER JOIN ${T.campaigns} xc ON xc.id = xv.id_campaign AND xc.id_automation = ?
              WHERE x.owner_type = 'variant' AND x.id_owner = ?`,
			[v.insertId, aid, from]
		);
	}
	return c.insertId;
}

async function clearCaches(aid) {
	const [rows] = await pool.query(`SELECT id FROM ${T.campaigns} WHERE id_automation = ? AND type = 'automation'`, [aid]);
	for (const r of rows) render.clearCache(r.id);
}

async function copy(id, idUser) {
	const a = await get(id);
	const input = a.steps.map((s) => {
		const cfg = { ...s.config };
		if (s.type === "condition" && cfg.ref_step) cfg.ref_index = a.steps.findIndex((x) => x.id === cfg.ref_step);
		return { type: s.type, config: cfg, copy_from: s.id_variant || null };
	});
	// copy_from перевіряється по id_automation — тож копіюємо вміст окремо, після створення
	const r = await save(
		null,
		{
			name: String(a.name).slice(0, 250) + " (2)",
			trigger_type: a.trigger_type,
			trigger_config: a.trigger_config,
			audience: a.audience,
			goal: a.goal,
			id_sender: a.id_sender,
			track_opens: !!a.track_opens,
			track_clicks: !!a.track_clicks,
			utm: a.utm,
			include_existing: !!a.include_existing,
			allow_reentry: !!a.allow_reentry,
			reentry_days: a.reentry_days,
			steps: input.map((s) => ({ type: s.type, config: s.config })),
		},
		idUser
	);
	const fresh = await steps(r.id);
	await model.withTx(async (conn) => {
		for (let i = 0; i < fresh.length; i++) {
			const from = input[i] && input[i].copy_from;
			if (!from || !fresh[i].id_variant) continue;
			await conn.query(
				`INSERT INTO ${T.contents} (owner_type, id_owner, id_lang, subject, preheader, editor, project, source, html, text, size_bytes, warnings, date_edit)
                 SELECT 'variant', ?, id_lang, subject, preheader, editor, project, source, html, text, size_bytes, warnings, UTC_TIMESTAMP()
                   FROM ${T.contents} WHERE owner_type = 'variant' AND id_owner = ?`,
				[fresh[i].id_variant, from]
			);
		}
	});
	return r;
}

async function remove(id, idUser) {
	return model.withTx(async (conn) => {
		const [[a]] = await conn.query(`SELECT status FROM ${A.autos} WHERE id = ? AND deleted = 0 FOR UPDATE`, [id]);
		if (!a) throw err(404, "not_found");
		if (a.status === "active") throw err(409, "automation_active");
		await conn.query(`UPDATE ${A.autos} SET deleted = 1, date_deleted = UTC_TIMESTAMP(), id_user_deleted = ? WHERE id = ?`, [idUser || null, id]);
		await conn.query(`UPDATE ${A.runs} SET status = 'exited', exit_reason = 'deleted', id_step = NULL, date_end = UTC_TIMESTAMP() WHERE id_automation = ? AND status = 'active'`, [id]);
		const [camps] = await conn.query(`SELECT id FROM ${T.campaigns} WHERE id_automation = ? AND type = 'automation'`, [id]);
		if (camps.length) {
			const cids = camps.map((c) => c.id);
			await conn.query(`UPDATE ${T.campaigns} SET status = 'cancelled', deleted = 1, date_deleted = UTC_TIMESTAMP(), id_user_deleted = ? WHERE id IN (?)`, [idUser || null, cids]);
			await conn.query(`UPDATE ${T.messages} SET status = 'cancelled' WHERE id_campaign IN (?) AND status IN ('queued','waiting')`, [cids]);
		}
		return { ok: true };
	});
}

// ═══ ЗАПУСК / ПАУЗА ═════════════════════════════════════
async function checklist(a) {
	const problems = [];
	if (!a.id_sender) problems.push("no_sender");
	else {
		const s = await sender.getPublic(a.id_sender);
		if (!s || !s.active) problems.push("sender_inactive");
	}
	const t = a.trigger_config || {};
	if (a.trigger_type === "list_subscribe" && !t.id_list) problems.push("trigger_no_list");
	if (a.trigger_type === "date_field" && !t.field) problems.push("trigger_no_field");
	if (a.trigger_type !== "list_subscribe" && !ints(a.audience && a.audience.lists).length) problems.push("no_lists");
	const emails = a.steps.filter((s) => s.type === "email");
	if (!emails.length) problems.push("no_email_steps");
	if (emails.some((s) => !s.langs || !s.langs.length)) problems.push("no_content");
	return { ok: !problems.length, problems };
}

async function setCampaignsStatus(conn, aid, status) {
	await conn.query(
		`UPDATE ${T.campaigns} SET status = ?, date_launched = IF(? = 'sending', COALESCE(date_launched, UTC_TIMESTAMP()), date_launched), last_error = NULL
          WHERE id_automation = ? AND type = 'automation' AND deleted = 0`,
		[status, status, aid]
	);
}

async function activate(id, idUser) {
	const a = await get(id);
	if (a.status === "active") return { ok: true };
	const r = await checklist(a);
	if (!r.ok) throw err(400, "automation_not_ready", { problems: r.problems });
	await model.withTx(async (conn) => {
		const [u] = await conn.query(
			`UPDATE ${A.autos}
                SET status = 'active', date_activated = COALESCE(date_activated, UTC_TIMESTAMP()),
                    date_trigger_from = COALESCE(date_trigger_from, IF(include_existing = 1, '1970-01-01 00:00:00', UTC_TIMESTAMP())),
                    id_user_activated = ?
              WHERE id = ? AND status IN ('draft','paused') AND deleted = 0`,
			[idUser || null, id]
		);
		if (!u.affectedRows) throw err(409, "automation_wrong_status");
		await setCampaignsStatus(conn, id, "sending");
	});
	await clearCaches(id);
	return { ok: true };
}

async function pause(id) {
	await model.withTx(async (conn) => {
		const [u] = await conn.query(`UPDATE ${A.autos} SET status = 'paused' WHERE id = ? AND status = 'active' AND deleted = 0`, [id]);
		if (!u.affectedRows) throw err(409, "automation_wrong_status");
		await setCampaignsStatus(conn, id, "paused");
	});
	return { ok: true };
}

/** Ручний запуск: усі, хто зараз відповідає аудиторії (тригер manual) */
async function enrollNow(id) {
	const a = await get(id);
	if (a.status !== "active") throw err(409, "automation_wrong_status");
	if (a.trigger_type !== "manual") throw err(409, "automation_wrong_status");
	let total = 0;
	for (let i = 0; i < 200; i++) {
		const n = await enroll(a, null);
		total += n;
		if (n < ENROLL_LIMIT) break;
	}
	return { ok: true, count: total };
}

/** Зупинити проходження одного контакту (зі сторінки звіту) */
async function exitRun(idAutomation, idRun) {
	const [r] = await pool.query(
		`UPDATE ${A.runs} SET status = 'exited', exit_reason = 'manual', id_step = NULL, date_end = UTC_TIMESTAMP() WHERE id = ? AND id_automation = ? AND status = 'active'`,
		[idRun, idAutomation]
	);
	if (!r.affectedRows) throw err(409, "automation_wrong_status");
	return { ok: true };
}

// ═══ ВХІД У ЛАНЦЮЖОК ════════════════════════════════════
/** Сьогоднішня дата (MM-DD) у поясі за замовчуванням зі зсувом; 29.02 — святкуємо 28.02 у невисокосні роки */
function anniversaryKeys(tz, offsetDays) {
	const now = new Date(Date.now() + model.tzOffsetMin(tz, new Date()) * 60000);
	// Подія через offset днів: лист сьогодні, якщо подія = сьогодні + (−offset)
	const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - offsetDays * 86400000);
	const md = target.toISOString().slice(5, 10);
	const y = target.getUTCFullYear();
	const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
	return md === "02-28" && !leap ? [md, "02-29"] : [md];
}

/** Час щоденного запуску (година в поясі за замовчуванням) уже настав, а сьогодні ще не запускали */
function dailyDue(a, tz) {
	const hour = parseInt((a.trigger_config || {}).hour, 10) || 0;
	const local = new Date(Date.now() + model.tzOffsetMin(tz, new Date()) * 60000).toISOString().slice(0, 10);
	const due = model.zonedToUtc(`${local} ${String(hour).padStart(2, "0")}:00:00`, tz);
	const nowSql = model.toSql(new Date());
	if (nowSql < due) return false;
	const last = a.date_last_enroll ? String(a.date_last_enroll).slice(0, 19) : null; // dateStrings: true
	return !last || last < due;
}

/**
 * Вхід контактів одним INSERT … SELECT. Аудиторія — через audience.build (білий список, параметри,
 * відписані/стоп-лист відсікаються завжди). Повертає кількість нових проходжень.
 */
async function enroll(a, tz) {
	if (!a.steps.length) return 0;
	const t = a.trigger_config || {};
	const lists = ints(a.audience.lists);
	if (a.trigger_type === "list_subscribe" && t.id_list && !lists.includes(t.id_list)) lists.push(t.id_list);
	if (!lists.length) return 0;
	const q = await audience.build({ ...a.audience, lists, ignore_sunset: true });

	let trig = "1 = 1";
	let tp = [];
	if (a.trigger_type === "list_subscribe") {
		trig = `EXISTS (SELECT 1 FROM ${T.subs} ts WHERE ts.id_contact = mc.id AND ts.id_list = ? AND ts.status = 'subscribed'
                          AND COALESCE(ts.date_confirmed, ts.date_subscribed) >= ?)`;
		tp = [t.id_list, a.date_trigger_from || model.toSql(new Date())]; // dateStrings: true — рядок UTC
	} else if (a.trigger_type === "date_field") {
		if (!/^[a-z][a-z0-9_]{0,63}$/.test(String(t.field || ""))) return 0;
		// code перевірено регуляркою і наявністю в mailing_fields — безпечно в JSON-шляху. Без CAST: криві дати просто не збігаються
		const raw = `JSON_UNQUOTE(JSON_EXTRACT(mc.fields, '$.${t.field}'))`;
		trig = `${raw} REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}' AND SUBSTRING(${raw}, 6, 5) IN (?)`;
		tp = [anniversaryKeys(tz, parseInt(t.offset_days, 10) || 0)];
	} else if (a.trigger_type === "inactive") {
		trig = `GREATEST(mc.date_add, COALESCE(mc.date_last_open, mc.date_add), COALESCE(mc.date_last_click, mc.date_add)) < UTC_TIMESTAMP() - INTERVAL ? DAY
                AND mc.date_last_sent IS NOT NULL`;
		tp = [Math.max(7, parseInt(t.days, 10) || 90)];
	}

	const reentry = a.allow_reentry ? `r.status = 'active' OR r.date_start >= UTC_TIMESTAMP() - INTERVAL ? DAY` : "1 = 1";
	const rp = a.allow_reentry ? [Math.max(0, parseInt(a.reentry_days, 10) || 0)] : [];

	const [r] = await pool.query(
		`INSERT INTO ${A.runs} (id_automation, id_contact, id_step, status, date_next, date_start)
         SELECT ?, mc.id, ?, 'active', UTC_TIMESTAMP(), UTC_TIMESTAMP()
         ${q.from}
         WHERE ${q.where} AND (${trig})
           AND NOT EXISTS (SELECT 1 FROM ${A.runs} r WHERE r.id_automation = ? AND r.id_contact = mc.id AND (${reentry}))
         LIMIT ?`,
		[a.id, a.steps[0].id, ...q.params, ...tp, a.id, ...rp, ENROLL_LIMIT]
	);
	return r.affectedRows || 0;
}

async function enrollAll() {
	const [rows] = await pool.query(`SELECT id FROM ${A.autos} WHERE status = 'active' AND deleted = 0 AND trigger_type IN ('list_subscribe','date_field','inactive')`);
	if (!rows.length) return;
	const s = await model.getSettings();
	for (const row of rows) {
		try {
			const a = await get(row.id);
			if (DAILY.includes(a.trigger_type)) {
				if (!dailyDue(a, s.default_timezone)) continue;
				let n;
				do n = await enroll(a, s.default_timezone);
				while (n >= ENROLL_LIMIT);
			} else await enroll(a, s.default_timezone);
			await pool.query(`UPDATE ${A.autos} SET date_last_enroll = UTC_TIMESTAMP() WHERE id = ?`, [a.id]);
		} catch (e) {
			console.error("[mailing:automation-enroll]", row.id, e.message);
		}
	}
}

// ═══ ВИКОНАННЯ КРОКІВ ═══════════════════════════════════
/** Хто з ids досі відповідає аудиторії (і, якщо передано segment, — сегменту) */
async function matching(a, idsList, segment) {
	if (!idsList.length) return new Set();
	const t = a.trigger_config || {};
	const lists = ints(a.audience.lists);
	if (t.id_list && !lists.includes(t.id_list)) lists.push(t.id_list);
	if (!lists.length) return new Set();
	const q = await audience.build({ ...a.audience, lists, ignore_sunset: true, segment: segment || a.audience.segment });
	const [rows] = await pool.query(`SELECT mc.id ${q.from} WHERE ${q.where} AND mc.id IN (?)`, [...q.params, idsList]);
	return new Set(rows.map((r) => Number(r.id)));
}

async function endRun(id, status, reason) {
	await pool.query(`UPDATE ${A.runs} SET status = ?, exit_reason = ?, id_step = NULL, date_next = NULL, date_end = UTC_TIMESTAMP() WHERE id = ? AND status = 'active'`, [status, reason || null, id]);
}

async function enqueueEmail(run, a, step) {
	if (!step.id_campaign || !step.id_variant) return;
	await pool.query(
		`INSERT IGNORE INTO ${T.messages}
            (id_campaign, id_variant, id_contact, id_sender, ref_key, email, email_domain, id_lang, status, date_next_attempt, date_add)
         SELECT ?, ?, mc.id, ?, ?, mc.email, mc.email_domain, mc.id_lang, 'queued', UTC_TIMESTAMP(), UTC_TIMESTAMP()
           FROM ${T.contacts} mc WHERE mc.id = ? AND mc.deleted = 0`,
		[step.id_campaign, step.id_variant, a.id_sender, "r" + run.id, run.id_contact]
	);
}

async function evaluate(run, a, step, byId) {
	const c = step.config || {};
	if (c.check === "segment") {
		if (!c.segment) return true;
		return (await matching(a, [run.id_contact], c.segment)).has(Number(run.id_contact));
	}
	const ref = byId.get(c.ref_step);
	if (!ref || !ref.id_campaign) return false;
	const cond = c.check === "clicked" ? "date_first_click IS NOT NULL" : "(date_first_open_human IS NOT NULL OR date_first_click IS NOT NULL)";
	const [[m]] = await pool.query(`SELECT 1 AS ok FROM ${T.messages} WHERE id_campaign = ? AND id_contact = ? AND ref_key = ? AND ${cond} LIMIT 1`, [ref.id_campaign, run.id_contact, "r" + run.id]);
	return !!m;
}

const WAIT_MIN = { minutes: 1, hours: 60, days: 1440 };

async function advance(run, a, list, byId) {
	let idx = list.findIndex((s) => s.id === Number(run.id_step));
	if (idx < 0) return endRun(run.id, "completed", null);
	for (let guard = 0; guard <= MAX_STEPS; guard++) {
		const st = list[idx];
		if (!st) return endRun(run.id, "completed", null);
		if (st.type === "email") {
			await enqueueEmail(run, a, st);
			idx++;
			continue;
		}
		if (st.type === "condition") {
			const yes = await evaluate(run, a, st, byId);
			if ((yes ? st.config.if_true : st.config.if_false) === "exit") return endRun(run.id, "exited", "condition");
			idx++;
			continue;
		}
		// wait: наступний крок — через затримку; очікування в кінці ланцюжка нічого не дає
		const next = list[idx + 1];
		if (!next) return endRun(run.id, "completed", null);
		const minutes = Math.max(1, (parseInt(st.config.amount, 10) || 1) * (WAIT_MIN[st.config.unit] || 1440));
		await pool.query(`UPDATE ${A.runs} SET id_step = ?, date_next = UTC_TIMESTAMP() + INTERVAL ? MINUTE WHERE id = ? AND status = 'active'`, [next.id, minutes, run.id]);
		return;
	}
	return endRun(run.id, "completed", null);
}

let runBusy = false;
async function runDue() {
	if (runBusy) return;
	runBusy = true;
	try {
		const [due] = await pool.query(
			`SELECT r.id, r.id_automation, r.id_contact, r.id_step
               FROM ${A.runs} r
               INNER JOIN ${A.autos} a ON a.id = r.id_automation AND a.status = 'active' AND a.deleted = 0
              WHERE r.status = 'active' AND r.date_next <= UTC_TIMESTAMP()
              ORDER BY r.date_next
              LIMIT ?`,
			[RUN_BATCH]
		);
		if (!due.length) return;
		const byAuto = new Map();
		for (const r of due) {
			if (!byAuto.has(r.id_automation)) byAuto.set(r.id_automation, []);
			byAuto.get(r.id_automation).push(r);
		}
		for (const [aid, runs] of byAuto) {
			const a = await get(aid);
			const byId = new Map(a.steps.map((s) => [s.id, s]));
			const contactIds = [...new Set(runs.map((r) => Number(r.id_contact)))];
			// Вихід: відписався / потрапив у стоп-лист / вже не відповідає фільтру; мета досягнута
			const still = await matching(a, contactIds);
			const goal = a.goal ? await matching(a, contactIds, a.goal) : new Set();
			for (const run of runs) {
				try {
					if (!still.has(Number(run.id_contact))) await endRun(run.id, "exited", "audience");
					else if (goal.has(Number(run.id_contact))) await endRun(run.id, "exited", "goal");
					else await advance(run, a, a.steps, byId);
				} catch (e) {
					console.error("[mailing:automation-run]", run.id, e.message);
					// Не крутити зламане проходження кожні 10 секунд
					await pool.query(`UPDATE ${A.runs} SET date_next = UTC_TIMESTAMP() + INTERVAL 15 MINUTE WHERE id = ?`, [run.id]).catch(() => {});
				}
			}
		}
	} finally {
		runBusy = false;
	}
}

// ═══ ЗВІТ ═══════════════════════════════════════════════
async function stats(id) {
	const a = await get(id);
	await require("./queue").recountStats(a.steps.filter((s) => s.id_campaign).map((s) => s.id_campaign));
	const [[runs]] = await pool.query(
		`SELECT COUNT(*) AS entered, SUM(status = 'active') AS active, SUM(status = 'completed') AS completed,
                SUM(status = 'exited' AND exit_reason = 'goal') AS goal, SUM(status = 'exited' AND exit_reason <> 'goal') AS exited
           FROM ${A.runs} WHERE id_automation = ?`,
		[id]
	);
	const [waiting] = await pool.query(`SELECT id_step, COUNT(*) AS n FROM ${A.runs} WHERE id_automation = ? AND status = 'active' GROUP BY id_step`, [id]);
	const cids = a.steps.filter((s) => s.id_campaign).map((s) => s.id_campaign);
	const camp = new Map();
	if (cids.length) {
		const [rows] = await pool.query(`SELECT id, cnt_total, cnt_sent, cnt_failed, cnt_skipped, cnt_bounced, cnt_opened_human, cnt_clicked, cnt_unsubscribed, cnt_complained FROM ${T.campaigns} WHERE id IN (?)`, [cids]);
		for (const r of rows) camp.set(Number(r.id), r);
	}
	return {
		runs: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, Number(v) || 0])),
		steps: a.steps.map((s) => ({ id: s.id, waiting: Number((waiting.find((w) => Number(w.id_step) === s.id) || {}).n) || 0, campaign: s.id_campaign ? camp.get(Number(s.id_campaign)) || null : null })),
	};
}

async function runsList(id, q) {
	const where = ["r.id_automation = ?"];
	const params = [id];
	if (["active", "completed", "exited"].includes(q.status)) {
		where.push("r.status = ?");
		params.push(q.status);
	}
	if (q.search) {
		where.push("mc.email LIKE ?");
		params.push("%" + String(q.search).replace(/[%_\\]/g, "\\$&") + "%");
	}
	const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n FROM ${A.runs} r INNER JOIN ${T.contacts} mc ON mc.id = r.id_contact WHERE ${where.join(" AND ")}`, params);
	const size = q.size || 20;
	const page = q.page || 1;
	const [rows] = await pool.query(
		`SELECT r.id, r.id_contact, mc.email, r.id_step, r.status, r.exit_reason, r.date_next, r.date_start, r.date_end
           FROM ${A.runs} r INNER JOIN ${T.contacts} mc ON mc.id = r.id_contact
          WHERE ${where.join(" AND ")}
          ORDER BY r.id DESC LIMIT ? OFFSET ?`,
		[...params, size, (page - 1) * size]
	);
	const total = Number(cnt.n) || 0;
	return { data: rows, last_page: Math.max(1, Math.ceil(total / size)), last_row: total };
}

module.exports = { TRIGGERS, list, get, save, copy, remove, checklist, activate, pause, enrollNow, exitRun, enrollAll, runDue, stats, runsList };