"use strict";

/**
 * Звіти по лідах (каталог звітів — controllers/reports/definitions.js, формуються у фоні — jobs.js).
 *
 * Усі — за лідами, створеними в періоді (date_add), без кошика; видимість — scope "leads":
 * без права leads.all автор бачить лише свої ліди й ліди без відповідального.
 *   leads_funnel   — воронка: скільки лідів дійшло до кожного етапу, конверсія між етапами, середній час на етапі;
 *   leads_sources  — джерела: ліди, виграні, програні, конверсія, сума виграних, швидкість першої відповіді;
 *   leads_managers — менеджери: ліди, перша відповідь (середня, вчасно / прострочено), активності, виграні, без кроку;
 *   leads_loss     — причини програшу: кількість, частка, сума;
 *   leads_register — реєстр лідів з контактами, етапом, статусом, балами, відповіддю (вивантаження в Excel / CSV).
 *
 * «Виграно» — статус system_type = won або лід конвертований; «програно» — статус або етап system_type = lost.
 * Шлях лідом етапами — з історії (field_change id_stage) + етап, з якого лід почав, і поточний.
 */

const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;
const MAX_ROWS = 200000;
const MONEY = "#,##0.00";
const PCT = "0.00";
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (a, b) => (b ? r2((a / b) * 100) : 0);
const avg = (list) => (list.length ? r2(list.reduce((s, x) => s + x, 0) / list.length) : "");
const json = (v, d = {}) => {
	if (v && typeof v === "object") return v;
	try {
		return v ? JSON.parse(v) : d;
	} catch {
		return d;
	}
};

const PERIOD = { name: "period", type: "period", required: true };
const PIPELINE = { name: "pipeline", type: "pipeline" };
const MANAGER = { name: "manager", type: "manager" };

/** Ліди періоду (l): дата створення, воронка, менеджер, видимість */
function leadWhere(p, ctx) {
	const w = ["l.deleted_at IS NULL", "l.date_add >= ?", "l.date_add < DATE_ADD(?, INTERVAL 1 DAY)"];
	const params = [p.date_from + " 00:00:00", p.date_to];
	if (p.pipeline) {
		w.push("l.id_pipeline = ?");
		params.push(p.pipeline);
	}
	if (p.manager) {
		w.push("l.id_manager = ?");
		params.push(p.manager);
	}
	if (!ctx.scopeAll) {
		w.push("(l.id_manager = ? OR l.id_manager IS NULL)");
		params.push(ctx.idUser);
	}
	return { sql: w.join(" AND "), params };
}

/** Ліди періоду з підсумковими ознаками: виграно / програно, перша відповідь, порушення часу відповіді */
async function leadsOf(p, ctx, extraCols = "") {
	const w = leadWhere(p, ctx);
	const [rows] = await pool.query(
		`SELECT l.id, l.id_source, l.id_manager, l.id_pipeline, l.id_stage, l.id_loss_reason, l.value, l.is_converted, l.date_add,
		        st.system_type AS status_type, ps.system_type AS stage_type,
		        TIMESTAMPDIFF(MINUTE, l.date_add, l.first_response_at) AS response_min,
		        (l.first_response_at IS NOT NULL AND l.response_deadline IS NOT NULL AND l.first_response_at > l.response_deadline)
		          OR (l.first_response_at IS NULL AND l.response_deadline IS NOT NULL AND l.response_deadline < NOW()) AS sla_late,
		        l.response_deadline IS NOT NULL AS sla_tracked
		        ${extraCols}
		   FROM \`${P}leads\` l
		   LEFT JOIN \`${P}leads_settings_status\` st ON st.id = l.id_status
		   LEFT JOIN \`${P}leads_pipeline_stages\` ps ON ps.id = l.id_stage
		  WHERE ${w.sql}
		  ORDER BY l.id LIMIT ${MAX_ROWS}`,
		w.params
	);
	return rows.map((r) => ({
		...r,
		won: r.status_type === "won" || Number(r.is_converted) === 1,
		lost: !(r.status_type === "won" || Number(r.is_converted) === 1) && (r.status_type === "lost" || r.stage_type === "lost"),
		response_min: r.response_min === null ? null : Math.max(0, Number(r.response_min)),
	}));
}

async function dictNames(table, fk, idLang) {
	const [rows] = await pool.query(`SELECT d.id, COALESCE(dl.name, CONCAT('#', d.id)) AS name FROM \`${P}${table}\` d LEFT JOIN \`${P}${table}_lang\` dl ON dl.${fk} = d.id AND dl.id_lang = ?`, [idLang]);
	return new Map(rows.map((r) => [Number(r.id), r.name]));
}
async function userNames() {
	const [rows] = await pool.query(`SELECT id, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM \`${P}users\``);
	return new Map(rows.map((r) => [Number(r.id), r.name || "#" + r.id]));
}

/* ─── Воронка ─── */

async function funnel(p, ctx) {
	const leads = await leadsOf(p, ctx);
	const [stages] = await pool.query(
		`SELECT s.id, s.id_pipeline, s.sort, s.system_type, COALESCE(sl.name, CONCAT('#', s.id)) AS name, COALESCE(pl.name, CONCAT('#', s.id_pipeline)) AS pipeline
		   FROM \`${P}leads_pipeline_stages\` s
		   LEFT JOIN \`${P}leads_pipeline_stages_lang\` sl ON sl.id_stage = s.id AND sl.id_lang = ?
		   LEFT JOIN \`${P}leads_pipelines_lang\` pl ON pl.id_pipeline = s.id_pipeline AND pl.id_lang = ?
		  ${p.pipeline ? "WHERE s.id_pipeline = ?" : ""}
		  ORDER BY s.id_pipeline, s.sort, s.id`,
		p.pipeline ? [ctx.idLang, ctx.idLang, p.pipeline] : [ctx.idLang, ctx.idLang]
	);
	const byId = new Map(stages.map((s) => [Number(s.id), s]));
	// Історія етапів лідів періоду: шлях і час входу на кожен етап
	const hist = new Map();
	const ids = leads.map((l) => l.id);
	for (let i = 0; i < ids.length; i += 5000) {
		const [h] = await pool.query(
			`SELECT id_lead, value_old, value_new, date_add FROM \`${P}leads_history\` WHERE id_lead IN (?) AND field_name = 'id_stage' AND action_type = 'field_change' ORDER BY id_lead, date_add, id`,
			[ids.slice(i, i + 5000)]
		);
		h.forEach((r) => {
			if (!hist.has(r.id_lead)) hist.set(r.id_lead, []);
			hist.get(r.id_lead).push(r);
		});
	}
	const reached = new Map(); // stage id → кількість лідів, що дійшли
	const timeIn = new Map(); // stage id → [години]
	const add = (m, k, v) => (m.has(k) ? m.get(k).push(v) : m.set(k, [v]));
	for (const l of leads) {
		const h = hist.get(l.id) || [];
		// Шлях: початковий етап (до першої зміни) → кожна зміна
		const path = [];
		const first = h.length ? Number(h[0].value_old) || null : Number(l.id_stage) || null;
		if (first) path.push({ id: first, at: new Date(String(l.date_add).replace(" ", "T")) });
		h.forEach((r) => Number(r.value_new) && path.push({ id: Number(r.value_new), at: new Date(String(r.date_add).replace(" ", "T")) }));
		for (let i = 0; i < path.length - 1; i++) add(timeIn, path[i].id, Math.max(0, (path[i + 1].at - path[i].at) / 3600000));
		// Дійшов до етапу = був на ньому або на будь-якому пізнішому звичайному етапі тієї ж воронки (виграно — пройшов усі)
		const visited = path.map((x) => byId.get(x.id)).filter(Boolean);
		if (!visited.length) continue;
		const pipe = visited[visited.length - 1].id_pipeline;
		const regular = stages.filter((s) => s.id_pipeline === pipe && s.system_type === "regular");
		const maxSort = l.won ? Infinity : Math.max(...visited.filter((s) => s.id_pipeline === pipe && s.system_type === "regular").map((s) => s.sort), -Infinity);
		regular.filter((s) => s.sort <= maxSort).forEach((s) => reached.set(s.id, (reached.get(s.id) || 0) + 1));
		// Етапи «виграно» / «програно» — кожен лід рахується раз
		new Set(visited.filter((s) => s.system_type !== "regular" && s.id_pipeline === pipe).map((s) => s.id)).forEach((id) => reached.set(id, (reached.get(id) || 0) + 1));
	}
	const total = leads.length;
	const rows = [];
	let prev = null;
	let prevPipe = null;
	for (const s of stages) {
		if (s.id_pipeline !== prevPipe) prev = null;
		prevPipe = s.id_pipeline;
		const n = reached.get(s.id) || 0;
		const t = timeIn.get(s.id) || [];
		const nowIn = leads.filter((l) => Number(l.id_stage) === Number(s.id)).length;
		rows.push({ pipeline: s.pipeline, stage: s.name, reached: n, of_total: pct(n, total), from_prev: s.system_type === "regular" && prev !== null ? pct(n, prev) : "", now_in: nowIn, avg_hours: avg(t) });
		if (s.system_type === "regular") prev = n;
	}
	return {
		sheets: [{ key: "l_funnel", columns: [["pipeline", 22], ["stage", 26], ["reached", 12], ["of_total", 12, PCT], ["from_prev", 14, PCT], ["now_in", 12], ["avg_hours", 14]], rows }],
	};
}

/* ─── Джерела ─── */

async function sources(p, ctx) {
	const leads = await leadsOf(p, ctx);
	const names = await dictNames("leads_sources", "id_source", ctx.idLang);
	const groups = new Map();
	for (const l of leads) {
		const k = l.id_source ? Number(l.id_source) : 0;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(l);
	}
	const rows = [...groups.entries()]
		.map(([k, list]) => {
			const won = list.filter((l) => l.won);
			const resp = list.map((l) => l.response_min).filter((x) => x !== null);
			const tracked = list.filter((l) => Number(l.sla_tracked));
			return {
				source: k ? names.get(k) || "#" + k : "—",
				leads: list.length,
				won: won.length,
				lost: list.filter((l) => l.lost).length,
				win_rate: pct(won.length, list.length),
				won_value: r2(won.reduce((s, l) => s + Number(l.value || 0), 0)),
				avg_value: avg(list.map((l) => Number(l.value || 0))),
				response_avg_min: avg(resp),
				sla_late_pct: pct(tracked.filter((l) => Number(l.sla_late)).length, tracked.length),
			};
		})
		.sort((a, b) => b.leads - a.leads);
	return {
		sheets: [
			{
				key: "l_sources",
				columns: [["source", 26], ["leads", 10], ["won", 10], ["lost", 10], ["win_rate", 12, PCT], ["won_value", 16, MONEY], ["avg_value", 14, MONEY], ["response_avg_min", 16], ["sla_late_pct", 14, PCT]],
				rows,
				totals: ["leads", "won", "lost", "won_value"],
			},
		],
	};
}

/* ─── Менеджери ─── */

async function managers(p, ctx) {
	const leads = await leadsOf(p, ctx, `, (SELECT COUNT(*) FROM \`${P}leads_activities\` na WHERE na.id_lead = l.id AND na.status = 'planned' AND na.deleted_at IS NULL) AS planned`);
	const names = await userNames();
	// Виконані активності менеджерів у періоді (за датою виконання) — по типах
	const actW = ["a.deleted_at IS NULL", "a.status = 'done'", "a.done_at >= ?", "a.done_at < DATE_ADD(?, INTERVAL 1 DAY)", "l.deleted_at IS NULL"];
	const actP = [p.date_from + " 00:00:00", p.date_to];
	if (p.pipeline) actW.push("l.id_pipeline = ?"), actP.push(p.pipeline);
	if (p.manager) actW.push("a.id_manager = ?"), actP.push(p.manager);
	if (!ctx.scopeAll) actW.push("(l.id_manager = ? OR l.id_manager IS NULL)"), actP.push(ctx.idUser);
	const [acts] = await pool.query(
		`SELECT a.id_manager, a.type, COUNT(*) AS n FROM \`${P}leads_activities\` a JOIN \`${P}leads\` l ON l.id = a.id_lead WHERE ${actW.join(" AND ")} GROUP BY a.id_manager, a.type`,
		actP
	);
	const actBy = new Map();
	acts.forEach((a) => {
		const k = a.id_manager ? Number(a.id_manager) : 0;
		if (!actBy.has(k)) actBy.set(k, {});
		actBy.get(k)[a.type] = Number(a.n);
	});
	const groups = new Map();
	for (const l of leads) {
		const k = l.id_manager ? Number(l.id_manager) : 0;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(l);
	}
	[...actBy.keys()].forEach((k) => !groups.has(k) && groups.set(k, []));
	const rows = [...groups.entries()]
		.map(([k, list]) => {
			const won = list.filter((l) => l.won);
			const lost = list.filter((l) => l.lost);
			const open = list.filter((l) => !l.won && !l.lost);
			const tracked = list.filter((l) => Number(l.sla_tracked));
			const late = tracked.filter((l) => Number(l.sla_late)).length;
			const a = actBy.get(k) || {};
			const sum = (types) => types.reduce((s, t) => s + (a[t] || 0), 0);
			return {
				manager: k ? names.get(k) || "#" + k : "—",
				leads: list.length,
				response_avg_min: avg(list.map((l) => l.response_min).filter((x) => x !== null)),
				sla_ok: tracked.length - late,
				sla_late: late,
				calls: sum(["call"]),
				meetings: sum(["meeting", "demo"]),
				messages: sum(["email", "whatsapp", "telegram", "viber", "sms"]),
				tasks: sum(["task", "other", "note"]),
				won: won.length,
				lost: lost.length,
				win_rate: pct(won.length, list.length),
				won_value: r2(won.reduce((s, l) => s + Number(l.value || 0), 0)),
				open: open.length,
				no_next: open.filter((l) => !Number(l.planned)).length,
			};
		})
		.sort((x, y) => y.leads - x.leads);
	return {
		sheets: [
			{
				key: "l_managers",
				columns: [["manager", 24], ["leads", 9], ["response_avg_min", 14], ["sla_ok", 10], ["sla_late", 10], ["calls", 9], ["meetings", 9], ["messages", 10], ["tasks", 9], ["won", 9], ["lost", 9], ["win_rate", 10, PCT], ["won_value", 14, MONEY], ["open", 9], ["no_next", 12]],
				rows,
				totals: ["leads", "sla_ok", "sla_late", "calls", "meetings", "messages", "tasks", "won", "lost", "won_value", "open", "no_next"],
			},
		],
	};
}

/* ─── Причини програшу ─── */

async function loss(p, ctx) {
	const leads = (await leadsOf(p, ctx)).filter((l) => l.lost);
	const names = await dictNames("leads_loss_reasons", "id_reason", ctx.idLang);
	const groups = new Map();
	leads.forEach((l) => {
		const k = l.id_loss_reason ? Number(l.id_loss_reason) : 0;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(l);
	});
	const rows = [...groups.entries()]
		.map(([k, list]) => ({ reason: k ? names.get(k) || "#" + k : "—", lost: list.length, share: pct(list.length, leads.length), lost_value: r2(list.reduce((s, l) => s + Number(l.value || 0), 0)) }))
		.sort((a, b) => b.lost - a.lost);
	return { sheets: [{ key: "l_loss", columns: [["reason", 34], ["lost", 10], ["share", 10, PCT], ["lost_value", 16, MONEY]], rows, totals: ["lost", "lost_value"] }] };
}

/* ─── Реєстр ─── */

async function register(p, ctx) {
	const w = leadWhere(p, ctx);
	const L = ctx.idLang;
	const [rows] = await pool.query(
		`SELECT l.id, l.title, l.value, l.contact_info, l.score, l.grade, l.date_add, l.first_response_at, l.response_deadline, l.is_converted, l.capture_type,
		        sl.name AS status, psl.name AS stage, pl.name AS pipeline, srcl.name AS source, lrl.name AS loss_reason,
		        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS manager,
		        (SELECT GROUP_CONCAT(tl.name ORDER BY tl.name SEPARATOR ', ') FROM \`${P}leads_tags_rel\` tr JOIN \`${P}leads_tags_lang\` tl ON tl.id_tag = tr.id_tag AND tl.id_lang = ? WHERE tr.id_lead = l.id) AS tags,
		        (SELECT MIN(na.scheduled_at) FROM \`${P}leads_activities\` na WHERE na.id_lead = l.id AND na.status = 'planned' AND na.deleted_at IS NULL) AS next_at,
		        TIMESTAMPDIFF(MINUTE, l.date_add, l.first_response_at) AS response_min,
		        JSON_UNQUOTE(JSON_EXTRACT(l.utm, '$.utm_source')) AS utm_source, JSON_UNQUOTE(JSON_EXTRACT(l.utm, '$.utm_campaign')) AS utm_campaign
		   FROM \`${P}leads\` l
		   LEFT JOIN \`${P}leads_settings_status_lang\` sl ON sl.id_status = l.id_status AND sl.id_lang = ?
		   LEFT JOIN \`${P}leads_pipeline_stages_lang\` psl ON psl.id_stage = l.id_stage AND psl.id_lang = ?
		   LEFT JOIN \`${P}leads_pipelines_lang\` pl ON pl.id_pipeline = l.id_pipeline AND pl.id_lang = ?
		   LEFT JOIN \`${P}leads_sources_lang\` srcl ON srcl.id_source = l.id_source AND srcl.id_lang = ?
		   LEFT JOIN \`${P}leads_loss_reasons_lang\` lrl ON lrl.id_reason = l.id_loss_reason AND lrl.id_lang = ?
		   LEFT JOIN \`${P}users\` u ON u.id = l.id_manager
		  WHERE ${w.sql}
		  ORDER BY l.id DESC LIMIT ${MAX_ROWS}`,
		[L, L, L, L, L, L, ...w.params]
	);
	return {
		sheets: [
			{
				key: "l_register",
				columns: [["id", 8], ["date_add", 18], ["title", 30], ["contact_name", 22], ["phone", 16], ["email", 24], ["company", 20], ["value", 12, MONEY], ["pipeline", 16], ["stage", 18], ["status", 16], ["source", 16], ["manager", 20], ["tags", 20], ["score", 8], ["grade", 7], ["response_min", 12], ["next_at", 18], ["loss_reason", 20], ["utm_source", 14], ["utm_campaign", 16], ["converted", 10]],
				rows: rows.map((r) => {
					const c = json(r.contact_info);
					return { ...r, contact_name: c.name || "", phone: c.phone || "", email: c.email || "", company: c.company || "", value: r2(r.value), response_min: r.response_min === null ? "" : Math.max(0, Number(r.response_min)), next_at: r.next_at || "", converted: Number(r.is_converted) ? "✓" : "", tags: r.tags || "", stage: r.stage || "", status: r.status || "", source: r.source || "", manager: r.manager || "", loss_reason: r.loss_reason || "", pipeline: r.pipeline || "", utm_source: r.utm_source || "", utm_campaign: r.utm_campaign || "" };
				}),
				totals: ["value"],
			},
		],
	};
}

const PERM = ["leads.list", "view"];
const REPORTS = [
	{ key: "leads_funnel", group: "leads", perm: PERM, scope: "leads", params: [PERIOD, PIPELINE, MANAGER], run: funnel },
	{ key: "leads_sources", group: "leads", perm: PERM, scope: "leads", params: [PERIOD, PIPELINE, MANAGER], run: sources },
	{ key: "leads_managers", group: "leads", perm: PERM, scope: "leads", params: [PERIOD, PIPELINE, MANAGER], run: managers },
	{ key: "leads_loss", group: "leads", perm: PERM, scope: "leads", params: [PERIOD, PIPELINE, MANAGER], run: loss },
	{ key: "leads_register", group: "leads", perm: PERM, scope: "leads", params: [PERIOD, PIPELINE, MANAGER], run: register },
];

module.exports = { REPORTS };