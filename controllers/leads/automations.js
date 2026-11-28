"use strict";

/**
 * Автоматизації лідів: «коли → якщо → зробити».
 *
 * Правило — leads_automations (назва — leads_automations_lang):
 *   trigger (JSON):  { event: "created" }                          — новий лід (будь-яке джерело);
 *                    { event: "stage_enter", id_stage }            — лід потрапив на етап;
 *                    { event: "status_change", id_status | null }  — змінився статус (null — будь-який);
 *                    { event: "idle", days, id_stage | null }      — лід без змін N днів (на етапі або будь-де).
 *   conditions (JSON) — ті самі, що в розподілі (controllers/leads/routing.js → matches): джерело, канал, воронка,
 *                    код номера, сума, дні тижня, час. Перевіряються в момент події.
 *   actions (JSON-масив), по черзі:
 *     task        { subject, body, due_hours }         — запланована задача відповідальному (з нагадуванням);
 *     notify      { to: manager|user|group, ref, text } — сповіщення в системі;
 *     set_manager { id_user, only_empty }              — відповідальний; або { rules: true } — за правилами розподілу;
 *     set_stage   { id_stage }, set_status { id_status } — перехід (з історією, вебхуками й наступними автоматизаціями);
 *     set_field   { field: id_priority|id_temperature|id_qualification|id_source, value };
 *     tag_add / tag_remove { id_tag };  comment { text } — запис в історії ліда.
 *   delay_min — затримка виконання.
 *
 * Виконання — черга в leads_automations_log (result pending → running → success / error / skipped, run_at):
 *   emit() ставить запис у чергу й одразу будить drain(); відкладені забирає фонова служба лідів щохвилини.
 *   Забір — SELECT … FOR UPDATE SKIP LOCKED (кілька процесів pm2 не виконають запис двічі).
 *   Перед виконанням: лід не в кошику, для stage_enter / status_change — лід досі на тому етапі / в тому статусі
 *   (переїхав — skipped). Ланцюжки (дія змінила етап → нова подія) — не глибше MAX_DEPTH.
 */

const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const i18n = require("../../config/i18n/i18n");

const P = config.get("configDatabase").prefix;
const LOCALE = process.env.APP_LOCALE || "uk";
const tSys = (phrase, vars) => i18n.__({ phrase, locale: LOCALE }, vars || {});
const TRIGGERS = ["created", "stage_enter", "status_change", "idle"];
const ACTIONS = ["task", "notify", "set_manager", "set_stage", "set_status", "set_field", "tag_add", "tag_remove", "comment"];
const FIELDS = ["id_priority", "id_temperature", "id_qualification", "id_source"];
const MAX_DEPTH = 3;
const BATCH = 20;

const parse = (v, def) => {
	if (v === null || v === undefined) return def;
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return def;
	}
};
const int = (v) => (parseInt(v, 10) > 0 ? parseInt(v, 10) : null);
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

/* ═══ Правила: читання й збереження ═══ */

async function list(idLang) {
	const [rows] = await pool.query(
		`SELECT a.id, a.trigger, a.conditions, a.actions, a.delay_min, a.is_active, a.sort, COALESCE(al.name, CONCAT('#', a.id)) AS name,
		        (SELECT COUNT(*) FROM \`${P}leads_automations_log\` g WHERE g.id_automation = a.id AND g.result = 'success') AS runs,
		        (SELECT MAX(g.date_add) FROM \`${P}leads_automations_log\` g WHERE g.id_automation = a.id AND g.result = 'success') AS last_run
		   FROM \`${P}leads_automations\` a
		   LEFT JOIN \`${P}leads_automations_lang\` al ON al.id_automation = a.id AND al.id_lang = ?
		  ORDER BY a.sort, a.id`,
		[Number(idLang) || 1]
	);
	return rows.map((r) => ({ ...r, trigger: parse(r.trigger, {}) || {}, conditions: parse(r.conditions, {}) || {}, actions: parse(r.actions, []) || [] }));
}

/** Дія з форми → чиста дія або null */
function cleanAction(a) {
	if (!a || !ACTIONS.includes(a.type)) return null;
	switch (a.type) {
		case "task":
			return str(a.subject, 500) ? { type: "task", subject: str(a.subject, 500), body: str(a.body, 5000), due_hours: Math.max(0, Math.min(8760, parseInt(a.due_hours, 10) || 0)) } : null;
		case "notify": {
			const to = ["manager", "user", "group"].includes(a.to) ? a.to : "manager";
			if (to !== "manager" && !int(a.ref)) return null;
			return str(a.text, 1000) ? { type: "notify", to, ref: to === "manager" ? null : int(a.ref), text: str(a.text, 1000) } : null;
		}
		case "set_manager":
			if (a.rules) return { type: "set_manager", rules: true };
			return int(a.id_user) ? { type: "set_manager", id_user: int(a.id_user), only_empty: !!a.only_empty } : null;
		case "set_stage":
			return int(a.id_stage) ? { type: "set_stage", id_stage: int(a.id_stage) } : null;
		case "set_status":
			return int(a.id_status) ? { type: "set_status", id_status: int(a.id_status) } : null;
		case "set_field":
			return FIELDS.includes(a.field) && int(a.value) ? { type: "set_field", field: a.field, value: int(a.value) } : null;
		case "tag_add":
		case "tag_remove":
			return int(a.id_tag) ? { type: a.type, id_tag: int(a.id_tag) } : null;
		case "comment":
			return str(a.text, 5000) ? { type: "comment", text: str(a.text, 5000) } : null;
	}
	return null;
}

async function save(b, idLang) {
	const errors = {};
	const name = str(b.name, 255);
	if (!name) errors.name = "leads.auto.e.name";
	const tr = b.trigger && typeof b.trigger === "object" ? b.trigger : {};
	const event = TRIGGERS.includes(tr.event) ? tr.event : null;
	if (!event) errors.trigger = "leads.auto.e.trigger";
	const trigger = { event };
	if (event === "stage_enter") {
		trigger.id_stage = int(tr.id_stage);
		if (!trigger.id_stage) errors.trigger = "leads.auto.e.stage";
	}
	if (event === "status_change") trigger.id_status = int(tr.id_status);
	if (event === "idle") {
		trigger.days = Math.max(1, Math.min(365, parseInt(tr.days, 10) || 0));
		trigger.id_stage = int(tr.id_stage);
		if (!parseInt(tr.days, 10)) errors.trigger = "leads.auto.e.days";
	}
	const actions = (Array.isArray(b.actions) ? b.actions : []).slice(0, 20).map(cleanAction).filter(Boolean);
	if (!actions.length) errors.actions = "leads.auto.e.actions";
	// Умови — у форматі розподілу (та сама перевірка)
	const { row: routed } = require("./routing").clean({ name: "x", assign_mode: "fixed", id_manager: 1, conditions: b.conditions || {} });
	if (Object.keys(errors).length) return { errors };
	const row = {
		trigger: JSON.stringify(trigger),
		conditions: routed.conditions,
		actions: JSON.stringify(actions),
		delay_min: event === "idle" ? 0 : Math.max(0, Math.min(525600, parseInt(b.delay_min, 10) || 0)),
		is_active: b.is_active ? 1 : 0,
		sort: Math.max(0, Math.min(100000, parseInt(b.sort, 10) || 0)),
	};
	const id = int(b.id);
	const conn = await pool.getConnection();
	let ruleId = id;
	try {
		await conn.beginTransaction();
		if (id) {
			const [r] = await conn.query(`UPDATE \`${P}leads_automations\` SET ?, date_edit = NOW() WHERE id = ?`, [row, id]);
			if (!r.affectedRows) throw Object.assign(new Error("leads.server.not_found"), { status: 404 });
		} else {
			const [r] = await conn.query(`INSERT INTO \`${P}leads_automations\` SET ?, date_add = NOW(), date_edit = NOW()`, [row]);
			ruleId = r.insertId;
		}
		await conn.query(`INSERT INTO \`${P}leads_automations_lang\` (id_automation, id_lang, name) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`, [ruleId, Number(idLang) || 1, name]);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	return { ok: true, id: ruleId };
}

async function remove(id) {
	// Відкладені виконання цього правила — скасовуються
	await pool.query(`UPDATE \`${P}leads_automations_log\` SET result = 'skipped', error = 'deleted' WHERE id_automation = ? AND result = 'pending'`, [id]);
	await pool.query(`DELETE FROM \`${P}leads_automations_lang\` WHERE id_automation = ?`, [id]);
	const [r] = await pool.query(`DELETE FROM \`${P}leads_automations\` WHERE id = ?`, [id]);
	return { ok: !!r.affectedRows };
}

/** Журнал виконань правила (останні) */
async function log(id) {
	const [rows] = await pool.query(
		`SELECT g.id, g.id_lead, g.result, g.error, g.run_at, g.date_add, l.title FROM \`${P}leads_automations_log\` g
		   LEFT JOIN \`${P}leads\` l ON l.id = g.id_lead WHERE g.id_automation = ? ORDER BY g.id DESC LIMIT 200`,
		[id]
	);
	return rows;
}

/* ═══ Події → черга ═══ */

async function loadLead(conn, idLead) {
	const [[l]] = await (conn || pool).query(
		`SELECT id, title, id_manager, id_source, id_pipeline, id_stage, id_status, capture_type, value, contact_info, deleted_at, date_edit FROM \`${P}leads\` WHERE id = ?`,
		[idLead]
	);
	if (l) l.contact = parse(l.contact_info, {}) || {};
	return l;
}

function triggerMatches(t, event, lead) {
	if (t.event !== event) return false;
	if (event === "stage_enter") return Number(t.id_stage) === Number(lead.id_stage);
	if (event === "status_change") return !t.id_status || Number(t.id_status) === Number(lead.id_status);
	return true;
}

/**
 * Подія ліда: created | stage_enter | status_change. Підходящі правила ставляться в чергу; без затримки — виконуються одразу.
 * opts.inline — виконати негайні тут же (збереження ліда чекає на них, щоб віддати сторінці актуальну версію ліда);
 * повертає кількість виконаних так правил. Помилки не зупиняють код, що викликав подію.
 */
async function emit(event, idLead, depth = 0, opts = {}) {
	try {
		if (depth > MAX_DEPTH) return 0;
		const lead = await loadLead(null, idLead);
		if (!lead || lead.deleted_at) return 0;
		const [rules] = await pool.query(`SELECT id, \`trigger\`, conditions, delay_min FROM \`${P}leads_automations\` WHERE is_active = 1 ORDER BY sort, id`);
		const now = new Date();
		const match = require("./routing").matches;
		const todo = rules.filter((r) => triggerMatches(parse(r.trigger, {}) || {}, event, lead) && match(parse(r.conditions, {}) || {}, lead, now));
		if (!todo.length) return 0;
		const trig = JSON.stringify({ event, id_stage: lead.id_stage, id_status: lead.id_status });
		const now2 = new Date();
		const ids = [];
		for (const r of todo) {
			const inline = opts.inline && !Number(r.delay_min);
			const [ins] = await pool.query(`INSERT INTO \`${P}leads_automations_log\` (id_automation, id_lead, result, run_at, locked_at, depth, trigger_data, date_add) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
				r.id,
				idLead,
				inline ? "running" : "pending",
				new Date(Date.now() + Number(r.delay_min || 0) * 60000),
				inline ? now2 : null,
				depth,
				trig,
				now2,
			]);
			if (inline) ids.push({ id: ins.insertId, id_automation: r.id, id_lead: idLead, depth });
		}
		for (const row of ids) await runOne(row);
		if (todo.some((r) => !Number(r.delay_min)) && !opts.inline) setImmediate(() => drain().catch((e) => logging.error(e)));
		return ids.length;
	} catch (e) {
		logging.error(e);
		return 0;
	}
}

/** Ліди без змін N днів (фонова служба, раз на 10 хв): один запуск правила на «версію» ліда (date_edit) */
async function scanIdle() {
	const [rules] = await pool.query(`SELECT id, \`trigger\`, conditions FROM \`${P}leads_automations\` WHERE is_active = 1 AND JSON_UNQUOTE(JSON_EXTRACT(\`trigger\`, '$.event')) = 'idle'`);
	const match = require("./routing").matches;
	for (const r of rules) {
		const t = parse(r.trigger, {}) || {};
		const days = Math.max(1, parseInt(t.days, 10) || 1);
		const [leads] = await pool.query(
			`SELECT l.id, l.title, l.id_manager, l.id_source, l.id_pipeline, l.id_stage, l.id_status, l.capture_type, l.value, l.contact_info, l.date_edit
			   FROM \`${P}leads\` l
			  WHERE l.deleted_at IS NULL AND l.is_converted = 0 AND l.date_edit < NOW() - INTERVAL ? DAY ${t.id_stage ? "AND l.id_stage = ?" : ""}
			    AND NOT EXISTS (SELECT 1 FROM \`${P}leads_settings_status\` st WHERE st.id = l.id_status AND st.system_type IN ('won', 'lost'))
			    AND NOT EXISTS (SELECT 1 FROM \`${P}leads_automations_log\` g WHERE g.id_automation = ? AND g.id_lead = l.id
			                     AND JSON_UNQUOTE(JSON_EXTRACT(g.trigger_data, '$.since')) = CAST(l.date_edit AS CHAR))
			  LIMIT 200`,
			t.id_stage ? [days, t.id_stage, r.id] : [days, r.id]
		);
		const now = new Date();
		const c = parse(r.conditions, {}) || {};
		const rows = leads.filter((l) => match(c, { ...l, contact: parse(l.contact_info, {}) || {} }, now));
		if (rows.length) {
			await pool.query(`INSERT INTO \`${P}leads_automations_log\` (id_automation, id_lead, result, run_at, depth, trigger_data, date_add) VALUES ?`, [
				rows.map((l) => [r.id, l.id, "pending", new Date(), 0, JSON.stringify({ event: "idle", since: String(l.date_edit) }), new Date()]),
			]);
		}
	}
}

/* ═══ Виконання ═══ */

let draining = false;
async function drain() {
	if (draining) return;
	draining = true;
	try {
		// Завислі (процес упав посеред виконання) — не повторюємо, щоб дії не задвоїлись
		await pool.query(`UPDATE \`${P}leads_automations_log\` SET result = 'error', error = 'interrupted' WHERE result = 'running' AND locked_at < NOW() - INTERVAL 10 MINUTE`);
		for (let round = 0; round < 50; round++) {
			const conn = await pool.getConnection();
			let rows;
			try {
				await conn.beginTransaction();
				[rows] = await conn.query(`SELECT id, id_automation, id_lead, depth, trigger_data FROM \`${P}leads_automations_log\` WHERE result = 'pending' AND run_at <= NOW() ORDER BY run_at, id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`);
				if (rows.length) await conn.query(`UPDATE \`${P}leads_automations_log\` SET result = 'running', locked_at = NOW() WHERE id IN (?)`, [rows.map((r) => r.id)]);
				await conn.commit();
			} catch (e) {
				await conn.rollback().catch(() => {});
				throw e;
			} finally {
				conn.release();
			}
			if (!rows.length) break;
			for (const row of rows) await runOne(row);
		}
	} finally {
		draining = false;
	}
}

async function finish(id, result, error, data) {
	await pool.query(`UPDATE \`${P}leads_automations_log\` SET result = ?, error = ?, actions_data = ? WHERE id = ?`, [result, error ? String(error).slice(0, 2000) : null, data ? JSON.stringify(data) : null, id]);
}

async function runOne(row) {
	try {
		const [[a]] = await pool.query(
			`SELECT a.id, a.trigger, a.actions, a.is_active, COALESCE(al.name, CONCAT('#', a.id)) AS name FROM \`${P}leads_automations\` a
			   LEFT JOIN \`${P}leads_automations_lang\` al ON al.id_automation = a.id AND al.id_lang = 1 WHERE a.id = ?`,
			[row.id_automation]
		);
		if (!a || !Number(a.is_active)) return finish(row.id, "skipped", "inactive");
		const lead = await loadLead(null, row.id_lead);
		if (!lead || lead.deleted_at) return finish(row.id, "skipped", "lead");
		const t = parse(a.trigger, {}) || {};
		if ((t.event === "stage_enter" || t.event === "status_change") && !triggerMatches(t, t.event, lead)) return finish(row.id, "skipped", "moved");
		const done = [];
		for (const act of parse(a.actions, []) || []) {
			try {
				done.push({ type: act.type, ok: true, ...(await doAction(act, lead, a, Number(row.depth) || 0)) });
			} catch (e) {
				done.push({ type: act.type, ok: false, error: String(e.message || e).slice(0, 300) });
				if (!e.status) logging.error(e);
			}
		}
		await pool.query(
			`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES (?, NULL, 'automation_fired', ?, NULL, NULL, ?, 'system', NULL, NOW())`,
			[lead.id, "automation:" + a.id, a.name]
		);
		const failed = done.filter((d) => !d.ok);
		return finish(row.id, failed.length ? "error" : "success", failed.map((d) => d.type + ": " + d.error).join("; ") || null, done);
	} catch (e) {
		logging.error(e);
		return finish(row.id, "error", e.message).catch(() => {});
	}
}

async function history(idLead, field, oldV, newV, comment) {
	await pool.query(
		`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES (?, NULL, 'field_change', ?, ?, ?, ?, 'system', NULL, NOW())`,
		[idLead, field, oldV == null ? "" : String(oldV), newV == null ? "" : String(newV), comment || null]
	);
}

/** Одна дія над лідом (lead — стан на момент запуску; після змін оновлюється на місці) */
async function doAction(act, lead, rule, depth) {
	const hooks = require("./webhooks");
	switch (act.type) {
		case "task": {
			const [r] = await pool.query(
				`INSERT INTO \`${P}leads_activities\` (id_lead, id_manager, type, direction, status, subject, body, duration_sec, scheduled_at, date_add, date_edit)
				 VALUES (?, ?, 'task', 'outbound', 'planned', ?, ?, 0, NOW() + INTERVAL ? HOUR, NOW(), NOW())`,
				[lead.id, lead.id_manager || null, act.subject, act.body || null, Number(act.due_hours) || 0]
			);
			await require("./reminders").schedule(r.insertId).catch((e) => logging.error(e));
			return { id_activity: r.insertId };
		}
		case "notify": {
			const audience = act.to === "manager" ? (lead.id_manager ? { user: Number(lead.id_manager) } : null) : act.to === "group" ? { group: Number(act.ref) } : { user: Number(act.ref) };
			if (!audience) return { skipped: "no_manager" };
			await require("../notifications").notify({
				type: "leads.automation",
				channels: ["inapp"],
				audience,
				priority: 6,
				payload: { title: rule.name, name: lead.title || "#" + lead.id, message: act.text, url: `/leads/${lead.id}/`, at: Date.now() },
			});
			return {};
		}
		case "set_manager": {
			if (act.rules) {
				const r = lead.id_manager ? null : await require("./routing").assign(lead.id);
				if (r && r.id_manager) lead.id_manager = r.id_manager;
				return { id_manager: r ? r.id_manager : null };
			}
			if (act.only_empty && lead.id_manager) return { skipped: "has_manager" };
			if (Number(lead.id_manager) === Number(act.id_user)) return {};
			const [[u]] = await pool.query(`SELECT id FROM \`${P}users\` WHERE id = ? AND active = 1`, [act.id_user]);
			if (!u) throw Object.assign(new Error("user"), { status: 400 });
			await pool.query(`UPDATE \`${P}leads\` SET id_manager = ?, date_edit = NOW() WHERE id = ?`, [act.id_user, lead.id]);
			await history(lead.id, "id_manager", lead.id_manager, act.id_user, rule.name);
			hooks.fire("lead.assigned", lead.id, { previous: { id_manager: lead.id_manager } });
			Promise.resolve(
				require("../notifications").notify({
					type: "leads.assigned",
					channels: ["inapp"],
					audience: { user: Number(act.id_user) },
					key: `leads_assigned_${lead.id}_${act.id_user}`,
					priority: 6,
					payload: { title: tSys("leads.view.n.assigned", { id: String(lead.id) }), name: lead.title || "#" + lead.id, message: rule.name, url: `/leads/${lead.id}/` },
				})
			).catch((e) => logging.error(e));
			lead.id_manager = act.id_user;
			return {};
		}
		case "set_stage": {
			if (Number(lead.id_stage) === Number(act.id_stage)) return {};
			const [[st]] = await pool.query(`SELECT id, id_pipeline FROM \`${P}leads_pipeline_stages\` WHERE id = ? AND is_active = 1`, [act.id_stage]);
			if (!st) throw Object.assign(new Error("stage"), { status: 400 });
			await pool.query(`UPDATE \`${P}leads\` SET id_stage = ?, id_pipeline = ?, date_edit = NOW() WHERE id = ?`, [st.id, st.id_pipeline, lead.id]);
			await history(lead.id, "id_stage", lead.id_stage, st.id, rule.name);
			hooks.fire("lead.stage_changed", lead.id, { previous: { id_stage: lead.id_stage } });
			lead.id_stage = st.id;
			lead.id_pipeline = st.id_pipeline;
			await require("./sla").arm(lead.id).catch((e) => logging.error(e));
			await emit("stage_enter", lead.id, depth + 1);
			return {};
		}
		case "set_status": {
			if (Number(lead.id_status) === Number(act.id_status)) return {};
			const [[st]] = await pool.query(`SELECT id FROM \`${P}leads_settings_status\` WHERE id = ? AND is_active = 1`, [act.id_status]);
			if (!st) throw Object.assign(new Error("status"), { status: 400 });
			await pool.query(`UPDATE \`${P}leads\` SET id_status = ?, date_edit = NOW() WHERE id = ?`, [st.id, lead.id]);
			await history(lead.id, "id_status", lead.id_status, st.id, rule.name);
			hooks.fire("lead.status_changed", lead.id, { previous: { id_status: lead.id_status } });
			lead.id_status = st.id;
			await emit("status_change", lead.id, depth + 1);
			return {};
		}
		case "set_field": {
			if (!FIELDS.includes(act.field)) throw Object.assign(new Error("field"), { status: 400 });
			const [[cur]] = await pool.query(`SELECT ${act.field} AS v FROM \`${P}leads\` WHERE id = ?`, [lead.id]);
			if (cur && Number(cur.v) === Number(act.value)) return {};
			await pool.query(`UPDATE \`${P}leads\` SET ${act.field} = ?, date_edit = NOW() WHERE id = ?`, [act.value, lead.id]);
			await history(lead.id, act.field, cur ? cur.v : null, act.value, rule.name);
			hooks.fire("lead.updated", lead.id, { changes: [act.field] });
			return {};
		}
		case "tag_add":
		case "tag_remove": {
			const [rel] = await pool.query(`SELECT id_tag FROM \`${P}leads_tags_rel\` WHERE id_lead = ? ORDER BY id_tag`, [lead.id]);
			const old = rel.map((r) => Number(r.id_tag));
			const has = old.includes(Number(act.id_tag));
			if ((act.type === "tag_add") === has) return {};
			if (act.type === "tag_add") await pool.query(`INSERT IGNORE INTO \`${P}leads_tags_rel\` (id_lead, id_tag) SELECT ?, id FROM \`${P}leads_tags\` WHERE id = ?`, [lead.id, act.id_tag]);
			else await pool.query(`DELETE FROM \`${P}leads_tags_rel\` WHERE id_lead = ? AND id_tag = ?`, [lead.id, act.id_tag]);
			const next = act.type === "tag_add" ? [...old, Number(act.id_tag)].sort((x, y) => x - y) : old.filter((x) => x !== Number(act.id_tag));
			await pool.query(`UPDATE \`${P}leads\` SET date_edit = NOW() WHERE id = ?`, [lead.id]);
			await history(lead.id, "tags", old.join(","), next.join(","), rule.name);
			hooks.fire("lead.updated", lead.id, { changes: ["tags"] });
			return {};
		}
		case "comment":
			await pool.query(
				`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES (?, NULL, 'comment', NULL, NULL, NULL, ?, 'system', NULL, NOW())`,
				[lead.id, act.text]
			);
			return {};
	}
	throw Object.assign(new Error("action"), { status: 400 });
}

module.exports = { TRIGGERS, ACTIONS, FIELDS, list, save, remove, log, emit, scanIdle, drain };