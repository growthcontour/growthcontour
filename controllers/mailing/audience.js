"use strict";
/**
 * Аудиторія: сегменти (конструктор правил → безпечний SQL), підрахунок, превʼю,
 * розгортання кампанії в чергу (fan-out).
 *
 * audience JSON:
 * {
 *   lists: [1,2],                  — обовʼязково: тільки підписані на ці списки
 *   exclude_lists: [3],
 *   exclude_campaigns: [10],       — не слати тим, хто вже отримав ці кампанії
 *   resend_of: 15, resend_mode: "not_opened" | "not_clicked",
 *   exclude_role: true,            — без info@, sales@ ...
 *   segment: { match: "all"|"any", rules: [ {field, op, value}, {match, rules:[...]} ] }
 * }
 *
 * Безпека: назви полів і операторів — лише з білих списків нижче; значення — лише через параметри.
 */
const model = require("./model");

const { pool, P, T, err, ints } = model;

const FIELDS = {
	email_domain: { type: "text", sql: "mc.email_domain" },
	country: { type: "text", sql: "COALESCE(mc.country, c.country)" },
	id_lang: { type: "number", sql: "mc.id_lang" },
	source: { type: "text", sql: "mc.source" },
	is_role: { type: "bool", sql: "mc.is_role" },
	date_add: { type: "date", sql: "mc.date_add" },
	last_open: { type: "date", sql: "mc.date_last_open" },
	last_click: { type: "date", sql: "mc.date_last_click" },
	last_sent: { type: "date", sql: "mc.date_last_sent" },

	has_client: { type: "bool", sql: "(c.id IS NOT NULL)" },
	rfm_segment: { type: "text", sql: "st.rfm_segment" },
	id_lifecycle: { type: "number", sql: "c.id_lifecycle" },
	id_manager: { type: "number", sql: "c.id_manager" },
	client_kind: { type: "text", sql: "c.kind" },

	tag: { type: "tag" },
	campaign_received: { type: "campaign", cond: "m.status = 'sent'" },
	campaign_opened: { type: "campaign", cond: "m.date_first_open_human IS NOT NULL OR m.date_first_click IS NOT NULL" },
	campaign_clicked: { type: "campaign", cond: "m.date_first_click IS NOT NULL" },
};

const OPS = {
	text: ["eq", "neq", "in", "nin", "contains", "starts", "empty", "not_empty"],
	number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "empty", "not_empty"],
	date: ["before", "after", "between", "days_ago_gt", "days_ago_lt", "empty", "not_empty"],
	bool: ["is_true", "is_false"],
	tag: ["has", "not_has"],
	campaign: ["yes", "no"],
};

const isDate = (v) => /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(String(v || ""));
const num = (v) => {
	const n = Number(v);
	if (!Number.isFinite(n)) throw err(400, "segment_bad_value");
	return n;
};
const likeEsc = (v) => String(v ?? "").replace(/[%_\\]/g, "\\$&");

/** Опис поля: стандартне або власне (field.<code>) */
function fieldOf(name) {
	if (Object.prototype.hasOwnProperty.call(FIELDS, name)) return FIELDS[name];
	const m = /^field\.([a-z][a-z0-9_]{0,63})$/.exec(String(name || ""));
	if (!m) return null;
	// code перевірено регуляркою — вставляти в JSON-шлях безпечно
	return { type: "custom", code: m[1], raw: `JSON_UNQUOTE(JSON_EXTRACT(mc.fields, '$.${m[1]}'))` };
}

function compileRule(r, customTypes) {
	let f = fieldOf(r && r.field);
	if (!f) throw err(400, "segment_bad_field");
	const op = String(r.op || "");
	const v = r.value;

	if (f.type === "custom") {
		if (!customTypes.has(f.code)) throw err(400, "segment_bad_field");
		const tp = customTypes.get(f.code);
		const sql = tp === "number" ? `CAST(${f.raw} AS DECIMAL(20,4))` : tp === "date" ? `CAST(${f.raw} AS DATETIME)` : tp === "bool" ? `(${f.raw} IN ('1','true','yes'))` : f.raw;
		f = { type: tp, sql };
	}

	if (!OPS[f.type] || !OPS[f.type].includes(op)) throw err(400, "segment_bad_op");

	switch (f.type) {
		case "text": {
			if (op === "eq") return { sql: `${f.sql} = ?`, params: [String(v ?? "").slice(0, 255)] };
			if (op === "neq") return { sql: `(${f.sql} IS NULL OR ${f.sql} <> ?)`, params: [String(v ?? "").slice(0, 255)] };
			if (op === "in" || op === "nin") {
				const arr = (Array.isArray(v) ? v : String(v || "").split(","))
					.map((x) => String(x).trim().slice(0, 255))
					.filter(Boolean)
					.slice(0, 500);
				if (!arr.length) throw err(400, "segment_bad_value");
				return op === "in" ? { sql: `${f.sql} IN (?)`, params: [arr] } : { sql: `(${f.sql} IS NULL OR ${f.sql} NOT IN (?))`, params: [arr] };
			}
			if (op === "contains") return { sql: `${f.sql} LIKE ?`, params: [`%${likeEsc(v).slice(0, 255)}%`] };
			if (op === "starts") return { sql: `${f.sql} LIKE ?`, params: [`${likeEsc(v).slice(0, 255)}%`] };
			if (op === "empty") return { sql: `(${f.sql} IS NULL OR ${f.sql} = '')`, params: [] };
			return { sql: `(${f.sql} IS NOT NULL AND ${f.sql} <> '')`, params: [] };
		}

		case "number": {
			const map = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
			if (map[op]) return { sql: `${f.sql} ${map[op]} ?`, params: [num(v)] };
			if (op === "between") return { sql: `${f.sql} BETWEEN ? AND ?`, params: [num(v && v[0]), num(v && v[1])] };
			return { sql: op === "empty" ? `${f.sql} IS NULL` : `${f.sql} IS NOT NULL`, params: [] };
		}

		case "date": {
			if (op === "before" || op === "after") {
				if (!isDate(v)) throw err(400, "segment_bad_value");
				return { sql: `${f.sql} ${op === "before" ? "<" : ">="} ?`, params: [v] };
			}
			if (op === "between") {
				if (!Array.isArray(v) || !isDate(v[0]) || !isDate(v[1])) throw err(400, "segment_bad_value");
				return { sql: `${f.sql} BETWEEN ? AND ?`, params: [v[0], v[1]] };
			}
			const days = Math.min(36500, Math.max(0, parseInt(v, 10) || 0));
			// «Понад N днів тому» включає «ніколи» — для «не відкривав 90 днів»
			if (op === "days_ago_gt") return { sql: `(${f.sql} IS NULL OR ${f.sql} < UTC_TIMESTAMP() - INTERVAL ? DAY)`, params: [days] };
			if (op === "days_ago_lt") return { sql: `${f.sql} >= UTC_TIMESTAMP() - INTERVAL ? DAY`, params: [days] };
			return { sql: op === "empty" ? `${f.sql} IS NULL` : `${f.sql} IS NOT NULL`, params: [] };
		}

		case "bool":
			return { sql: op === "is_true" ? `${f.sql} = 1` : `(${f.sql} = 0 OR ${f.sql} IS NULL)`, params: [] };

		case "tag": {
			const ids = ints(v).slice(0, 200);
			if (!ids.length) throw err(400, "segment_bad_value");
			const q = `EXISTS (SELECT 1 FROM ${P}clients_tag_links tl WHERE tl.id_client = c.id AND tl.id_tag IN (?))`;
			return { sql: op === "has" ? q : `NOT ${q}`, params: [ids] };
		}

		case "campaign": {
			const ids = ints(v).slice(0, 200);
			if (!ids.length) throw err(400, "segment_bad_value");
			const q = `EXISTS (SELECT 1 FROM ${T.messages} m WHERE m.id_contact = mc.id AND m.id_campaign IN (?) AND (${f.cond}))`;
			return { sql: op === "yes" ? q : `NOT ${q}`, params: [ids] };
		}
	}
	throw err(400, "segment_bad_field");
}

function compileGroup(g, customTypes, depth = 0) {
	if (!g || !Array.isArray(g.rules) || !g.rules.length) return null;
	if (depth > 3) throw err(400, "segment_too_deep");
	if (g.rules.length > 50) throw err(400, "segment_too_many_rules");
	const parts = [];
	const params = [];
	for (const r of g.rules) {
		const x = r && Array.isArray(r.rules) ? compileGroup(r, customTypes, depth + 1) : compileRule(r, customTypes);
		if (!x) continue;
		parts.push(`(${x.sql})`);
		params.push(...x.params);
	}
	if (!parts.length) return null;
	return { sql: parts.join(g.match === "any" ? " OR " : " AND "), params };
}

async function customFieldTypes() {
	const [rows] = await pool.query(`SELECT code, type FROM ${T.fields}`);
	return new Map(rows.map((r) => [r.code, r.type]));
}

const FROM = `FROM ${T.contacts} mc
         LEFT JOIN ${P}clients c ON c.id = mc.id_client AND c.deleted_at IS NULL
         LEFT JOIN ${P}clients_stats st ON st.id_client = c.id`;

/** → {from, where, params}. Відписані, bounce, стоп-лист відсікаються ЗАВЖДИ. */
async function build(audience) {
	const a = audience || {};
	const lists = ints(a.lists);
	if (!lists.length) throw err(400, "audience_no_lists");

	const where = ["mc.deleted = 0", "mc.status = 'active'"];
	const params = [];

	where.push(`EXISTS (SELECT 1 FROM ${T.subs} s WHERE s.id_contact = mc.id AND s.status = 'subscribed' AND s.id_list IN (?))`);
	params.push(lists);

	const exLists = ints(a.exclude_lists);
	if (exLists.length) {
		where.push(`NOT EXISTS (SELECT 1 FROM ${T.subs} s WHERE s.id_contact = mc.id AND s.status = 'subscribed' AND s.id_list IN (?))`);
		params.push(exLists);
	}

	where.push(`NOT EXISTS (SELECT 1 FROM ${T.supp} x WHERE x.type = 'email' AND x.value = mc.email)`);
	where.push(`NOT EXISTS (SELECT 1 FROM ${T.supp} x WHERE x.type = 'domain' AND x.value = mc.email_domain)`);

	const exCamp = ints(a.exclude_campaigns);
	if (exCamp.length) {
		where.push(`NOT EXISTS (SELECT 1 FROM ${T.messages} m WHERE m.id_contact = mc.id AND m.id_campaign IN (?) AND m.status = 'sent')`);
		params.push(exCamp);
	}

	const resendOf = parseInt(a.resend_of, 10);
	if (resendOf > 0) {
		const cond = a.resend_mode === "not_clicked" ? "m.date_first_click IS NULL" : "m.date_first_open_human IS NULL AND m.date_first_click IS NULL";
		where.push(`EXISTS (SELECT 1 FROM ${T.messages} m WHERE m.id_contact = mc.id AND m.id_campaign = ? AND m.status = 'sent' AND ${cond})`);
		params.push(resendOf);
	}

	if (a.exclude_role) where.push("mc.is_role = 0");

	// Sunset: давно неактивних не чіпаємо (новачків — ні: дивимось на дату додавання)
	const s = await model.getSettings();
	const sunset = parseInt(s.sunset_days, 10) || 0;
	if (sunset > 0 && !a.ignore_sunset) {
		where.push(`(mc.date_add >= UTC_TIMESTAMP() - INTERVAL ? DAY
                  OR GREATEST(COALESCE(mc.date_last_open, '1970-01-01'), COALESCE(mc.date_last_click, '1970-01-01')) >= UTC_TIMESTAMP() - INTERVAL ? DAY)`);
		params.push(sunset, sunset);
	}

	const seg = compileGroup(a.segment, await customFieldTypes());
	if (seg) {
		where.push(`(${seg.sql})`);
		params.push(...seg.params);
	}

	return { from: FROM, where: where.join(" AND "), params };
}

async function count(audience) {
	const q = await build(audience);
	const [[r]] = await pool.query(`SELECT COUNT(*) AS n ${q.from} WHERE ${q.where}`, q.params);
	return Number(r.n) || 0;
}

async function preview(audience, limit = 20) {
	const q = await build(audience);
	const [rows] = await pool.query(
		`SELECT mc.id, mc.email, mc.first_name, mc.last_name, mc.id_lang, mc.country, mc.id_client, c.display_name AS client_name
         ${q.from} WHERE ${q.where} ORDER BY mc.id DESC LIMIT ?`,
		[...q.params, Math.min(100, Math.max(1, parseInt(limit, 10) || 20))]
	);
	return rows;
}

/**
 * Розгорнути кампанію в чергу: по рядку на отримувача.
 * Ідемпотентно (INSERT IGNORE + унікальний ключ): після падіння просто запускається знову.
 * Аудиторія фіксується в момент старту відправки, а не в момент натискання «Запланувати».
 */
async function fanOut(idCampaign) {
	const [[c]] = await pool.query(`SELECT * FROM ${T.campaigns} WHERE id = ? AND deleted = 0`, [idCampaign]);
	if (!c || !["scheduled", "preparing"].includes(c.status)) return { skipped: true };
	if (!c.id_sender) throw err(400, "campaign_no_sender");

	await pool.query(`UPDATE ${T.campaigns} SET status = 'preparing', date_launched = COALESCE(date_launched, UTC_TIMESTAMP()) WHERE id = ? AND status IN ('scheduled','preparing')`, [c.id]);

	const [variants] = await pool.query(`SELECT id FROM ${T.variants} WHERE id_campaign = ? ORDER BY code`, [c.id]);
	if (!variants.length) throw err(400, "campaign_no_content");
	const vIds = variants.map((v) => Number(v.id)).filter((x) => Number.isInteger(x) && x > 0);
	const audience = typeof c.audience === "string" ? JSON.parse(c.audience) : c.audience;
	const q = await build(audience);
	const s = await model.getSettings();

	// Детермінований розподіл: той самий контакт завжди в тій самій групі.
	// У SQL вставляються ЛИШЕ цілі числа з БД (id кампанії, id варіантів, відсоток).
	const cid = Number(c.id);
	const key = `CRC32(CONCAT(${cid}, '-', mc.id))`;
	let variantSql = String(vIds[0]);
	let statusSql = `'queued'`;
	if (c.type === "ab" && vIds.length > 1) {
		const pick = `ELT(1 + FLOOR(${key} / 100) % ${vIds.length}, ${vIds.join(",")})`;
		const pct = Math.min(100, Math.max(0, parseInt(c.ab_percent, 10) || 0));
		if (pct > 0 && pct < 100) {
			const inTest = `(${key} % 100) < ${pct}`;
			variantSql = `IF(${inTest}, ${pick}, NULL)`;
			statusSql = `IF(${inTest}, 'queued', 'waiting')`;
		} else {
			variantSql = pick;
		}
	}

	let timeSql = "UTC_TIMESTAMP()";
	let tParams = [];
	if (c.send_mode === "timezone" && c.date_scheduled) {
		// date_scheduled = локальний час отримувача; без tz-таблиць MySQL — пояс за замовчуванням
		const fallback = model.zonedToUtc(c.date_scheduled, s.default_timezone);
		timeSql = `GREATEST(UTC_TIMESTAMP(), COALESCE(CONVERT_TZ(?, mc.timezone, '+00:00'), CONVERT_TZ(?, c.timezone, '+00:00'), ?))`;
		tParams = [c.date_scheduled, c.date_scheduled, fallback];
	} else if (c.send_mode === "scheduled" && c.date_scheduled) {
		timeSql = "GREATEST(UTC_TIMESTAMP(), ?)";
		tParams = [c.date_scheduled];
	}

	const [[range]] = await pool.query(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM ${T.contacts}`);
	const STEP = 5000;
	if (range.lo) {
		for (let from = Number(range.lo); from <= Number(range.hi); from += STEP) {
			const [[st]] = await pool.query(`SELECT status FROM ${T.campaigns} WHERE id = ?`, [cid]);
			if (!st || st.status !== "preparing") return { stopped: st ? st.status : "deleted" };
			await pool.query(
				`INSERT IGNORE INTO ${T.messages}
                    (id_campaign, id_variant, id_contact, id_sender, ref_key, email, email_domain, id_lang, status, date_next_attempt, date_add)
                 SELECT ?, ${variantSql}, mc.id, ?, '', mc.email, mc.email_domain, mc.id_lang, ${statusSql}, ${timeSql}, UTC_TIMESTAMP()
                 ${q.from}
                 WHERE ${q.where} AND mc.id BETWEEN ? AND ?`,
				[cid, c.id_sender, ...tParams, ...q.params, from, from + STEP - 1]
			);
		}
	}

	const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.messages} WHERE id_campaign = ?`, [cid]);
	const total = Number(cnt.n) || 0;
	await pool.query(
		`UPDATE ${T.campaigns}
            SET cnt_total = ?, status = IF(? = 0, 'sent', 'sending'), date_finished = IF(? = 0, UTC_TIMESTAMP(), NULL)
          WHERE id = ? AND status = 'preparing'`,
		[total, total, total, cid]
	);
	return { total };
}

module.exports = { FIELDS, OPS, build, count, preview, fanOut };