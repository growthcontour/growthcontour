"use strict";
/**
 * Адмінка: контакти, стоп-лист, списки (з лічильниками), поля.
 * Лише параметризований SQL; сортування — лише з білого списку.
 */
const model = require("./model");

const { pool, T, err, P } = model;

const SORTS = {
	id: "mc.id",
	email: "mc.email",
	date_add: "mc.date_add",
	date_last_open: "mc.date_last_open",
	date_last_click: "mc.date_last_click",
	date_last_sent: "mc.date_last_sent",
	status: "mc.status",
};
const STATUSES = new Set(["active", "unsubscribed", "bounced", "complained", "cleaned"]);
const likeEsc = (v) => String(v ?? "").replace(/[%_\\]/g, "\\$&");

function orderBy(sort, map, def) {
	const s = Array.isArray(sort) && sort[0];
	return s && map[s.field] ? `${map[s.field]} ${s.dir === "asc" ? "ASC" : "DESC"}, mc.id DESC` : def;
}

// ─── КОНТАКТИ ───────────────────────────────────────────
async function list(q) {
	const where = ["mc.deleted = 0"];
	const params = [];
	if (STATUSES.has(q.status)) {
		where.push("mc.status = ?");
		params.push(q.status);
	}
	if (q.id_list) {
		where.push(`EXISTS (SELECT 1 FROM ${T.subs} s WHERE s.id_contact = mc.id AND s.id_list = ? AND s.status = 'subscribed')`);
		params.push(q.id_list);
	}
	if (q.id_import) {
		where.push("mc.id_import = ?");
		params.push(q.id_import);
	}
	if (/^[a-z_]{1,32}$/.test(q.source || "")) {
		where.push("mc.source = ?");
		params.push(q.source);
	}
	const s = String(q.search || "").trim();
	if (s.length >= 2) {
		const like = `%${likeEsc(s)}%`;
		where.push("(mc.email LIKE ? OR mc.first_name LIKE ? OR mc.last_name LIKE ?)");
		params.push(like.toLowerCase(), like, like);
	}
	const w = where.join(" AND ");
	const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.contacts} mc WHERE ${w}`, params);
	const total = Number(cnt.n) || 0;
	const [rows] = await pool.query(
		`SELECT mc.id, mc.email, mc.first_name, mc.last_name, mc.status, mc.source, mc.id_lang, mc.country, mc.id_client, mc.is_role,
                mc.date_add, mc.date_last_sent, mc.date_last_open, mc.date_last_click,
                c.display_name AS client_name,
                (SELECT GROUP_CONCAT(s.id_list) FROM ${T.subs} s WHERE s.id_contact = mc.id AND s.status = 'subscribed') AS list_ids
           FROM ${T.contacts} mc
           LEFT JOIN ${P}clients c ON c.id = mc.id_client
          WHERE ${w}
          ORDER BY ${orderBy(q.sort, SORTS, "mc.id DESC")}
          LIMIT ? OFFSET ?`,
		[...params, q.size, (q.page - 1) * q.size]
	);
	return {
		last_page: Math.max(1, Math.ceil(total / q.size)),
		last_row: total,
		data: rows.map((r) => ({ ...r, list_ids: String(r.list_ids || "").split(",").filter(Boolean).map(Number) })),
	};
}

async function detail(id, idLang) {
	const c = await model.getContact(id);
	if (!c || c.deleted) throw err(404, "not_found");
	const [messages] = await pool.query(
		`SELECT m.id, m.id_campaign, cp.name AS campaign_name, m.status, m.skip_reason, m.bounce_type, m.date_sent,
                m.date_first_open_human, m.date_first_click, m.cnt_opens, m.cnt_clicks, m.date_unsubscribed, m.date_complained
           FROM ${T.messages} m
           INNER JOIN ${T.campaigns} cp ON cp.id = m.id_campaign
          WHERE m.id_contact = ?
          ORDER BY m.id DESC LIMIT 100`,
		[id]
	);
	const [consents] = await pool.query(
		`SELECT id, id_list, action, source, ip, id_user, note, date_add FROM ${T.consents} WHERE id_contact = ? ORDER BY id DESC LIMIT 100`,
		[id]
	);
	const [supp] = await pool.query(`SELECT id, reason, date_add FROM ${T.supp} WHERE (type = 'email' AND value = ?) OR (type = 'domain' AND value = ?)`, [c.email, c.email_domain]);
	return {
		contact: { ...c, fields: typeof c.fields === "string" ? JSON.parse(c.fields) : c.fields || {} },
		subscriptions: await model.contactSubscriptions(id, idLang),
		messages,
		consents: consents.map((r) => ({ ...r, ip: model.binToIp(r.ip) })),
		suppressions: supp,
	};
}

/** Ручне додавання/редагування. Відписаних НЕ підписує (force=false). */
async function save(idContact, d, ctx) {
	if (d.timezone && !model.isValidTz(d.timezone)) throw err(400, "validation_error", { errors: [{ field: "timezone", message: "invalid" }] });
	if (d.id_lang && !(await model.languages()).has(d.id_lang)) throw err(400, "validation_error", { errors: [{ field: "id_lang", message: "invalid" }] });
	const known = new Set((await model.fields()).map((f) => f.code));
	const fields = {};
	for (const [k, val] of Object.entries(d.fields || {})) if (known.has(k) && val !== null && val !== "") fields[k] = String(val).slice(0, 1000);

	const n = model.normalizeEmail(d.email);
	if (!n) throw err(400, "validation_error", { errors: [{ field: "email", message: "invalid" }] });
	if (await model.isSuppressed(n.email, n.domain)) throw err(409, "email_suppressed");

	return model.withTx(async (conn) => {
		if (idContact) {
			const cur = await model.getContact(idContact, conn);
			if (!cur || cur.deleted) throw err(404, "not_found");
			if (cur.email !== n.email) {
				const dup = await model.getContactByEmail(n.email, conn);
				if (dup && dup.id !== idContact) throw err(409, "email_exists", { errors: [{ field: "email", message: "email_exists" }] });
				await conn.query(`UPDATE ${T.contacts} SET email = ?, email_domain = ? WHERE id = ?`, [n.email, n.domain, idContact]);
			}
		}
		const r = await model.upsertContact(conn, { ...d, email: n.email, fields, source: "manual" }, { updateExisting: true });
		const results = {};
		for (const idL of model.ints(d.lists)) {
			results[idL] = await model.subscribe(conn, r.id, idL, { source: "manual", double_optin: false, force: false, ctx: { ...ctx, source: "admin" } });
		}
		return { ok: true, id: r.id, created: r.created, subscriptions: results };
	});
}

/** Встановити набір списків контакту (адмін). Відписаних не повертає. */
async function setSubscriptions(id, lists, ctx) {
	const c = await model.getContact(id);
	if (!c || c.deleted) throw err(404, "not_found");
	const wanted = new Set(model.ints(lists));
	const cur = await model.contactSubscriptions(id, c.id_lang);
	const res = {};
	await model.withTx(async (conn) => {
		for (const l of cur) {
			if (wanted.has(Number(l.id)) && l.status !== "subscribed") {
				res[l.id] = await model.subscribe(conn, id, l.id, { source: "manual", double_optin: false, force: false, ctx: { ...ctx, source: "admin" } });
			} else if (!wanted.has(Number(l.id)) && (l.status === "subscribed" || l.status === "pending")) {
				await model.unsubscribe(conn, id, { id_list: l.id, ctx: { ...ctx, source: "admin" } });
				res[l.id] = "removed";
			}
		}
	});
	return { ok: true, result: res };
}

// ─── СТОП-ЛИСТ ──────────────────────────────────────────
const SUPP_SORTS = { id: "x.id", value: "x.value", reason: "x.reason", date_add: "x.date_add" };

async function suppressions(q) {
	const where = ["1 = 1"];
	const params = [];
	if (["hard_bounce", "complaint", "unsubscribe_all", "manual", "invalid"].includes(q.status)) {
		where.push("x.reason = ?");
		params.push(q.status);
	}
	const s = String(q.search || "").trim().toLowerCase();
	if (s.length >= 2) {
		where.push("x.value LIKE ?");
		params.push(`%${likeEsc(s)}%`);
	}
	const w = where.join(" AND ");
	const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.supp} x WHERE ${w}`, params);
	const sort = Array.isArray(q.sort) && q.sort[0] && SUPP_SORTS[q.sort[0].field] ? `${SUPP_SORTS[q.sort[0].field]} ${q.sort[0].dir === "asc" ? "ASC" : "DESC"}` : "x.id DESC";
	const [rows] = await pool.query(`SELECT x.id, x.type, x.value, x.reason, x.note, x.id_user, x.date_add FROM ${T.supp} x WHERE ${w} ORDER BY ${sort} LIMIT ? OFFSET ?`, [...params, q.size, (q.page - 1) * q.size]);
	const total = Number(cnt.n) || 0;
	return { last_page: Math.max(1, Math.ceil(total / q.size)), last_row: total, data: rows };
}

module.exports = { list, detail, save, setSubscriptions, suppressions };