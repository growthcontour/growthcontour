"use strict";

/**
 * Ліди: масові дії зі списку та дані канбану воронки.
 *
 * Масові дії — над вибраними рядками списку (не більше однієї сторінки таблиці, до BULK_MAX):
 *   status — статус, manager — відповідальний (або «без відповідального»), tag_add / tag_remove — тег,
 *   delete — у кошик. Кожна змінена картка отримує рядок історії й вебхуки, як при збереженні вручну;
 *   новий відповідальний — одне зведене сповіщення на всю дію. Ліди поза зоною видимості користувача пропускаються.
 *
 * Канбан — колонки = етапи воронки; картки по COL_PAGE на колонку з догрузкою; лічильник і сума — по всьому етапу.
 *   Перетягування картки зберігається звичайним збереженням ліда (/api/leads/:id/save/), тож перевірки,
 *   історія, сповіщення, вебхуки й захист від одночасних змін — ті самі.
 */

const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const access = require("./access");

const P = config.get("configDatabase").prefix;
const BULK_MAX = 100;
const COL_PAGE = 30;
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const pad = (x) => String(x).padStart(2, "0");
const nowSql = () => {
	const d = new Date();
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const can = (req, slug, action) => req.user?.permissions?.[slug]?.[action] === true;

/** Умови фільтрів списку (аліас l). Повертає { sql, params } — рядок з «AND …» або порожній */
function leadsWhere(f, idUser) {
	const w = [];
	const params = [];
	const int = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
	const q = String(f.search || "").trim().slice(0, 100);
	if (q) {
		// Назва, ім'я, телефон, email, компанія; число — ще й номер ліда
		const like = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
		const digits = q.replace(/\D/g, "");
		w.push(`(l.title LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(l.contact_info, '$.name')) LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(l.contact_info, '$.email')) LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(l.contact_info, '$.company')) LIKE ?${digits.length >= 3 ? " OR REGEXP_REPLACE(JSON_UNQUOTE(JSON_EXTRACT(l.contact_info, '$.phone')), '[^0-9]', '') LIKE ?" : ""}${/^\d+$/.test(q) ? " OR l.id = ?" : ""})`);
		params.push(like, like, like, like);
		if (digits.length >= 3) params.push("%" + digits + "%");
		if (/^\d+$/.test(q)) params.push(Number(q));
	}
	for (const [key, col] of [["status", "l.id_status"], ["pipeline", "l.id_pipeline"], ["stage", "l.id_stage"], ["source", "l.id_source"], ["manager", "l.id_manager"]]) {
		const v = int(f[key]);
		if (v) {
			w.push(`${col} = ?`);
			params.push(v);
		}
	}
	if (f.manager === "none") w.push("l.id_manager IS NULL");
	if (["cold", "warm", "hot"].includes(f.temperature)) {
		w.push("l.temperature = ?");
		params.push(f.temperature);
	}
	if (["0", "1", "2", "3"].includes(String(f.priority))) {
		w.push("l.priority = ?");
		params.push(Number(f.priority));
	}
	if (int(f.tag)) {
		w.push(`EXISTS (SELECT 1 FROM \`${P}leads_tags_rel\` tr WHERE tr.id_lead = l.id AND tr.id_tag = ?)`);
		params.push(int(f.tag));
	}
	if (f.converted === "1" || f.converted === "0") {
		w.push("l.is_converted = ?");
		params.push(Number(f.converted));
	}
	if (f.duplicate === "1") w.push("l.is_duplicate = 1");
	// Відкриті ліди без запланованого наступного кроку (активності зі статусом «заплановано»)
	if (f.no_next === "1") {
		w.push(`l.is_converted = 0 AND NOT EXISTS (SELECT 1 FROM \`${P}leads_settings_status\` nst WHERE nst.id = l.id_status AND nst.system_type IN ('won', 'lost'))
		        AND NOT EXISTS (SELECT 1 FROM \`${P}leads_activities\` na WHERE na.id_lead = l.id AND na.status = 'planned' AND na.deleted_at IS NULL)`);
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(f.date_from || "")) {
		w.push("l.date_add >= ?");
		params.push(f.date_from + " 00:00:00");
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(f.date_to || "")) {
		w.push("l.date_add < DATE_ADD(?, INTERVAL 1 DAY)");
		params.push(f.date_to);
	}
	if (Number(f.mine) === 1 && idUser) {
		w.push("l.id_manager = ?");
		params.push(idUser);
	}
	return { sql: w.length ? " AND " + w.join(" AND ") : "", params };
}

/** Ліди з переданих id, які користувач бачить і які не в кошику */
async function visibleLeads(req, ids) {
	const sc = access.scope(req, "l");
	const [rows] = await pool.query(`SELECT l.id, l.title, l.id_status, l.id_manager FROM \`${P}leads\` l WHERE l.id IN (?) AND l.deleted_at IS NULL${sc ? " AND " + sc.sql : ""}`, [ids, ...(sc ? sc.params : [])]);
	return rows;
}

async function run(req, body, t) {
	const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((x) => parseInt(x, 10)).filter((x) => x > 0))];
	if (!ids.length) throw httpErr(400, "leads.bulk.e.none");
	if (ids.length > BULK_MAX) throw httpErr(400, "leads.bulk.e.too_many");
	const action = String(body.action || "");
	if (!["status", "manager", "tag_add", "tag_remove", "delete"].includes(action)) throw httpErr(400, "leads.bulk.e.action");
	if (action === "delete" ? !can(req, "leads.list", "delete") : !can(req, "leads.list", "edit")) throw httpErr(403, "leads.bulk.e.forbidden");

	const idUser = req.user.userId || req.user.id;
	const leads = await visibleLeads(req, ids);
	const skipped = ids.length - leads.length;
	if (!leads.length) return { ok: true, changed: 0, skipped };
	const hooks = require("./webhooks");
	const now = nowSql();

	if (action === "delete") {
		const trash = require("../common/trash");
		let n = 0;
		for (const l of leads) {
			try {
				await trash.softDelete("leads", l.id, idUser);
				hooks.fire("lead.deleted", l.id);
				n++;
			} catch (e) {
				if (!e.status) logging.error(e);
			}
		}
		require("../common/audit").log(req, { action: "delete", module: "leads", entity: "lead", id_entity: null, count: n });
		return { ok: true, changed: n, skipped: skipped + leads.length - n };
	}

	if (action === "status" || action === "manager") {
		const field = action === "status" ? "id_status" : "id_manager";
		let value;
		if (action === "status") {
			value = parseInt(body.value, 10) || 0;
			const [[s]] = await pool.query(`SELECT id FROM \`${P}leads_settings_status\` WHERE id = ?`, [value]);
			if (!s) throw httpErr(400, "leads.bulk.e.value");
		} else if (body.value === "none") value = null;
		else {
			value = parseInt(body.value, 10) || 0;
			const [[u]] = await pool.query(`SELECT id FROM \`${P}users\` WHERE id = ? AND active = 1`, [value]);
			if (!u) throw httpErr(400, "leads.bulk.e.value");
		}
		const todo = leads.filter((l) => String(l[field] ?? "") !== String(value ?? ""));
		if (!todo.length) return { ok: true, changed: 0, skipped: skipped + leads.length };
		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();
			await conn.query(`UPDATE \`${P}leads\` SET ${field} = ?, date_edit = ? WHERE id IN (?)`, [value, now, todo.map((l) => l.id)]);
			await conn.query(`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES ?`, [
				todo.map((l) => [l.id, idUser, "field_change", field, l[field] == null ? "" : String(l[field]), value == null ? "" : String(value), null, "web", req.ip, now]),
			]);
			await conn.commit();
		} catch (e) {
			await conn.rollback().catch(() => {});
			throw e;
		} finally {
			conn.release();
		}
		for (const l of todo) {
			hooks.fire("lead.updated", l.id, { changes: [field] });
			hooks.fire(action === "status" ? "lead.status_changed" : "lead.assigned", l.id, { previous: { [field]: l[field] } });
		}
		if (action === "manager" && value && Number(value) !== Number(idUser)) notifyAssigned(req, value, todo, t);
		if (action === "status") {
			const auto = require("./automations");
			for (const l of todo) await auto.emit("status_change", l.id);
		}
		require("../common/audit").log(req, { action: "update", module: "leads", entity: "lead", id_entity: null, count: todo.length });
		return { ok: true, changed: todo.length, skipped: skipped + leads.length - todo.length };
	}

	// Теги
	const idTag = parseInt(body.value, 10) || 0;
	const [[tag]] = await pool.query(`SELECT id FROM \`${P}leads_tags\` WHERE id = ?`, [idTag]);
	if (!tag) throw httpErr(400, "leads.bulk.e.value");
	const [rel] = await pool.query(`SELECT id_lead, id_tag FROM \`${P}leads_tags_rel\` WHERE id_lead IN (?) ORDER BY id_tag`, [leads.map((l) => l.id)]);
	const cur = new Map(leads.map((l) => [l.id, []]));
	rel.forEach((r) => cur.get(Number(r.id_lead)).push(Number(r.id_tag)));
	const add = action === "tag_add";
	const todo = leads.filter((l) => cur.get(l.id).includes(idTag) !== add);
	if (!todo.length) return { ok: true, changed: 0, skipped: skipped + leads.length };
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		if (add) await conn.query(`INSERT IGNORE INTO \`${P}leads_tags_rel\` (id_lead, id_tag) VALUES ?`, [todo.map((l) => [l.id, idTag])]);
		else await conn.query(`DELETE FROM \`${P}leads_tags_rel\` WHERE id_tag = ? AND id_lead IN (?)`, [idTag, todo.map((l) => l.id)]);
		await conn.query(`UPDATE \`${P}leads\` SET date_edit = ? WHERE id IN (?)`, [now, todo.map((l) => l.id)]);
		await conn.query(`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES ?`, [
			todo.map((l) => {
				const old = cur.get(l.id);
				const next = (add ? [...old, idTag] : old.filter((x) => x !== idTag)).sort((a, b) => a - b);
				return [l.id, idUser, "field_change", "tags", old.join(","), next.join(","), null, "web", req.ip, now];
			}),
		]);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	for (const l of todo) hooks.fire("lead.updated", l.id, { changes: ["tags"] });
	require("../common/audit").log(req, { action: "update", module: "leads", entity: "lead", id_entity: null, count: todo.length });
	return { ok: true, changed: todo.length, skipped: skipped + leads.length - todo.length };
}

/** Одне сповіщення новому відповідальному на всю масову дію */
function notifyAssigned(req, idUserTo, leads, t) {
	try {
		const who = [req.user.firstName, req.user.lastName].filter(Boolean).join(" ").trim() || "#" + (req.user.userId || req.user.id);
		const one = leads.length === 1 ? leads[0] : null;
		Promise.resolve(
			require("../notifications").notify({
				type: "leads.assigned",
				channels: ["inapp"],
				audience: { user: Number(idUserTo) },
				priority: 6,
				payload: {
					title: one ? t("leads.view.n.assigned", { id: String(one.id) }) : t("leads.bulk.n.assigned_many", { n: String(leads.length) }),
					name: one ? one.title || "#" + one.id : leads.map((l) => "#" + l.id).slice(0, 20).join(", "),
					message: t("leads.bulk.n.assigned_by", { who }),
					url: one ? `/leads/${one.id}/` : `/leads/?manager=${Number(idUserTo)}`,
				},
			})
		).catch((e) => logging.error(e));
	} catch (e) {
		logging.error(e);
	}
}

/* ═══ Канбан ═══ */

/** Воронки й етапи для перемикача канбану */
async function pipelines(idLang) {
	const [pl] = await pool.query(
		`SELECT p.id, COALESCE(pl.name, CONCAT('#', p.id)) AS name, p.is_default FROM \`${P}leads_pipelines\` p
		   LEFT JOIN \`${P}leads_pipelines_lang\` pl ON pl.id_pipeline = p.id AND pl.id_lang = ?
		  WHERE p.is_active = 1 ORDER BY p.is_default DESC, p.sort, p.id`,
		[idLang]
	);
	return pl;
}

async function stages(idPipeline, idLang) {
	const [rows] = await pool.query(
		`SELECT s.id, COALESCE(sl.name, CONCAT('#', s.id)) AS name, s.color, s.icon, s.system_type, s.probability, s.sla_hours, s.lock_back, s.sort
		   FROM \`${P}leads_pipeline_stages\` s
		   LEFT JOIN \`${P}leads_pipeline_stages_lang\` sl ON sl.id_stage = s.id AND sl.id_lang = ?
		  WHERE s.id_pipeline = ? AND s.is_active = 1 ORDER BY s.sort, s.id`,
		[idLang, idPipeline]
	);
	return rows;
}

const CARD_SQL = (idLang) => ({
	cols: `l.id, l.title, l.value, l.priority, l.temperature, l.score, l.grade, l.contact_info, l.id_stage, l.id_manager, l.is_converted, l.is_duplicate,
	       l.response_deadline, l.first_response_at, l.date_add, l.date_edit,
	       IF(l.first_response_at IS NULL AND l.is_converted = 0, TIMESTAMPDIFF(SECOND, NOW(), l.response_deadline), NULL) AS sla_left,
	       ${NEXT_SQL}, s.system_type AS status_system_type,
	       NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS manager_name,
	       s.color_text AS status_color_text, s.color_background AS status_color_background, sl.name AS status_name`,
	joins: `LEFT JOIN \`${P}users\` u ON u.id = l.id_manager
	        LEFT JOIN \`${P}leads_settings_status\` s ON s.id = l.id_status
	        LEFT JOIN \`${P}leads_settings_status_lang\` sl ON sl.id_status = s.id AND sl.id_lang = ${Number(idLang) || 1}`,
});

/** Наступний крок ліда: найближча запланована активність (час і скільки секунд лишилось — рахує сервер) */
const NEXT_SQL = `(SELECT MIN(na.scheduled_at) FROM \`${P}leads_activities\` na WHERE na.id_lead = l.id AND na.status = 'planned' AND na.deleted_at IS NULL) AS next_at,
	(SELECT TIMESTAMPDIFF(SECOND, NOW(), MIN(na.scheduled_at)) FROM \`${P}leads_activities\` na WHERE na.id_lead = l.id AND na.status = 'planned' AND na.deleted_at IS NULL) AS next_left,
	(SELECT COUNT(*) FROM \`${P}leads_activities\` na WHERE na.id_lead = l.id AND na.status = 'planned' AND na.deleted_at IS NULL) AS next_count`;

const card = (r) => ({ ...r, contact_info: typeof r.contact_info === "string" ? JSON.parse(r.contact_info || "{}") : r.contact_info || {} });

/**
 * Дані канбану. where — умови фільтрів списку (leadsWhere) для аліаса l.
 * Без stage — усі колонки воронки (по COL_PAGE карток); зі stage + offset — догрузка однієї колонки.
 */
async function board(req, idPipeline, where, opts = {}) {
	const idLang = req.user.id_lang || 1;
	const sc = access.scope(req, "l");
	const base = `l.deleted_at IS NULL AND l.id_pipeline = ?${sc ? " AND " + sc.sql : ""}${where.sql}`;
	const params = [idPipeline, ...(sc ? sc.params : []), ...where.params];
	const q = CARD_SQL(idLang);
	const order = "ORDER BY l.priority DESC, l.date_edit DESC, l.id DESC";

	if (opts.stage) {
		const [rows] = await pool.query(`SELECT ${q.cols} FROM \`${P}leads\` l ${q.joins} WHERE ${base} AND l.id_stage = ? ${order} LIMIT ? OFFSET ?`, [...params, opts.stage, COL_PAGE, Math.max(0, opts.offset || 0)]);
		return { cards: rows.map(card), page: COL_PAGE };
	}

	const st = await stages(idPipeline, idLang);
	const [agg] = await pool.query(`SELECT l.id_stage, COUNT(*) AS n, COALESCE(SUM(l.value), 0) AS total FROM \`${P}leads\` l WHERE ${base} GROUP BY l.id_stage`, params);
	const byStage = new Map(agg.map((a) => [String(a.id_stage), a]));
	// Перші картки кожної колонки одним запитом (вікно по етапу)
	const [rows] = st.length
		? await pool.query(
				`SELECT * FROM (SELECT ${q.cols}, ROW_NUMBER() OVER (PARTITION BY l.id_stage ${order}) AS rn FROM \`${P}leads\` l ${q.joins} WHERE ${base} AND l.id_stage IN (?)) x WHERE x.rn <= ? ORDER BY x.rn`,
				[...params, st.map((s) => s.id), COL_PAGE]
			)
		: [[]];
	const cols = st.map((s) => {
		const a = byStage.get(String(s.id));
		return { ...s, count: a ? Number(a.n) : 0, total: a ? Number(a.total) : 0, cards: [] };
	});
	const colById = new Map(cols.map((c) => [String(c.id), c]));
	rows.forEach((r) => {
		const c = colById.get(String(r.id_stage));
		if (c) c.cards.push(card(r));
	});
	// Ліди воронки без етапу або з етапом іншої/вимкненої воронки — окремо, щоб не «губились»
	const lost = agg.filter((a) => !colById.has(String(a.id_stage))).reduce((s, a) => s + Number(a.n), 0);
	return { columns: cols, page: COL_PAGE, unstaged: lost };
}

module.exports = { NEXT_SQL, leadsWhere, run, pipelines, stages, board, BULK_MAX, COL_PAGE };