"use strict";

/**
 * Записи системи в чаті: картки замовлень, лідів, клієнтів, угод.
 *
 * У повідомленні зберігаються лише посилання { type, id } (data.records і таблиця chat_records для пошуку обговорень).
 * Картку кожен бачить зі своїми правами: немає доступу до запису — лише «запис #id недоступний», без назви й сум.
 * Посилання на сторінки записів у тексті (/orders/15/ або повна адреса цієї системи) стають картками самі.
 */
const config = require("../../config/config");
const { pool, P, T, permissions, allowed } = require("./common");
const logging = require("../../logging/logging");

const MAX = 5;

/**
 * Типи записів. list / all — права списку й «бачити всі»; owner — відповідальний (без «усіх» видно свої й без відповідального).
 * Угоди окремих прав не мають — їх бачать усі, хто працює в системі.
 */
const TYPES = {
	order: {
		path: "orders",
		url: (id) => `/orders/${id}/`,
		list: "orders.list",
		all: "orders.all",
		owner: "id_user",
		sql: `SELECT o.id, o.reference AS title, o.total AS amount, o.currency_iso AS currency, o.id_user AS owner, o.date_add,
		             sl.text AS status, NULLIF(TRIM(CONCAT_WS(' ', JSON_UNQUOTE(JSON_EXTRACT(o.client, '$.firstname')), JSON_UNQUOTE(JSON_EXTRACT(o.client, '$.lastname')))), '') AS sub
		        FROM ${P}orders o
		        LEFT JOIN ${P}orders_status_lang sl ON sl.id_status = o.status AND sl.id_lang = ?
		       WHERE o.id IN (?) AND o.deleted_at IS NULL`,
	},
	lead: {
		path: "leads",
		url: (id) => `/leads/${id}/`,
		list: "leads.list",
		all: "leads.all",
		owner: "id_manager",
		sql: `SELECT l.id, l.title AS title, NULL AS amount, NULL AS currency, l.id_manager AS owner, l.date_add,
		             sl.name AS status, cl.display_name AS sub
		        FROM ${P}leads l
		        LEFT JOIN ${P}leads_settings_status_lang sl ON sl.id_status = l.id_status AND sl.id_lang = ?
		        LEFT JOIN ${P}clients cl ON cl.id = l.id_client
		       WHERE l.id IN (?) AND l.deleted_at IS NULL`,
	},
	client: {
		path: "clients",
		url: (id) => `/clients/${id}/`,
		list: "clients.list",
		all: "clients.all",
		owner: "id_manager",
		// Злитий клієнт — показуємо того, в кого злили (посилання веде туди ж)
		sql: `SELECT c.id, c.display_name AS title, NULL AS amount, NULL AS currency, c.id_manager AS owner, c.date_add,
		             NULL AS status, NULL AS sub
		        FROM ${P}clients c
		       WHERE ? > 0 AND c.id IN (?) AND c.deleted_at IS NULL`,
	},
	deal: {
		path: "deals",
		url: (id) => `/deals/${id}`,
		list: null,
		all: null,
		owner: "id_user",
		sql: `SELECT d.id, d.title, d.amount_final AS amount, d.amount_currency AS currency, d.id_user AS owner, d.date_add,
		             sl.name AS status, NULL AS sub
		        FROM ${P}deals d
		        LEFT JOIN ${P}deals_stage_lang sl ON sl.id_stage = d.id_stage AND sl.id_lang = ?
		       WHERE d.id IN (?) AND d.active = 1`,
	},
};
const BY_PATH = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v.path, k]));

/** Перелік { type, id } без повторів і сміття */
function clean(list) {
	const out = [];
	const seen = new Set();
	for (const r of Array.isArray(list) ? list : []) {
		const type = String((r && r.type) || "");
		const id = parseInt(r && r.id, 10);
		if (!TYPES[type] || !(id > 0) || id > 4294967295) continue;
		const k = type + ":" + id;
		if (seen.has(k)) continue;
		seen.add(k);
		out.push({ type, id });
		if (out.length >= MAX) break;
	}
	return out;
}

// Адреса цієї системи (configServer.url) — повні посилання на неї теж стають картками
let ownHost = null;
try {
	ownHost = new URL((config.get("configServer") || {}).url || "").host || null;
} catch {
	ownHost = null;
}

/** Посилання на записи в тексті: /orders/15/, https://<ця система>/leads/7/ */
function detect(body) {
	if (!body) return [];
	const out = [];
	const re = /(^|[\s(<])((?:https?:\/\/([^\s/<>]+))?\/(orders|leads|clients|deals)\/(\d{1,10})(?=[/?#\s).,;!>]|$))/g;
	let m;
	while ((m = re.exec(String(body)))) {
		if (m[3] && m[3] !== ownHost) continue;
		out.push({ type: BY_PATH[m[4]], id: Number(m[5]) });
	}
	return clean(out);
}

/** Чи бачить людина запис: право списку і (усі або свій / без відповідального) */
function visibleTo(perms, def, row, uid) {
	if (def.list && !allowed(perms, def.list)) return false;
	if (!def.all || allowed(perms, def.all)) return true;
	return row.owner == null || Number(row.owner) === Number(uid);
}

/** Дані записів (без прав): Map "type:id" → рядок з owner_name; відсутні — не потрапляють */
async function load(list, idLang = 1) {
	const out = new Map();
	const byType = {};
	list.forEach((r) => TYPES[r.type] && Number(r.id) > 0 && (byType[r.type] = byType[r.type] || new Set()).add(Number(r.id)));
	for (const [type, set] of Object.entries(byType)) {
		const def = TYPES[type];
		const [rows] = await pool.query(def.sql, [idLang, [...set].slice(0, 200)]);
		const owners = [...new Set(rows.map((r) => r.owner).filter(Boolean))];
		const names = new Map();
		if (owners.length) {
			const [u] = await pool.query(`SELECT id, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM ${T.users} WHERE id IN (?)`, [owners]);
			u.forEach((x) => names.set(Number(x.id), x.name));
		}
		rows.forEach((r) => out.set(type + ":" + Number(r.id), Object.assign({}, r, { owner_name: r.owner ? names.get(Number(r.owner)) || null : null })));
	}
	return out;
}

/** Картки одного глядача з уже завантажених даних */
function view(perms, uid, loaded, list) {
	const out = new Map();
	for (const x of list) {
		const def = TYPES[x.type];
		if (!def) continue;
		const id = Number(x.id);
		const key = x.type + ":" + id;
		if (out.has(key)) continue;
		const r = loaded.get(key);
		if (def.list && !allowed(perms, def.list)) out.set(key, { type: x.type, id, denied: true });
		else if (!r) out.set(key, { type: x.type, id, missing: true });
		else if (!visibleTo(perms, def, r, uid)) out.set(key, { type: x.type, id, denied: true });
		else
			out.set(key, {
				type: x.type,
				id,
				url: def.url(id),
				title: r.title || "#" + id,
				sub: r.sub || null,
				status: r.status || null,
				amount: r.amount == null ? null : Number(r.amount),
				currency: r.currency || null,
				owner_name: r.owner_name,
			});
	}
	return out;
}

/**
 * Картки для глядача: Map "type:id" → { type, id, url, title, sub, status, amount, currency, owner_name },
 * без доступу — { type, id, denied: true }, видалений запис — { type, id, missing: true }.
 */
async function cards(uid, list, idLang = 1) {
	if (!list.length) return new Map();
	return view(await permissions(uid), uid, await load(list, idLang), list);
}

/** Картки для багатьох глядачів одразу (подія в каналі): дані читаються один раз. Map uid → Map карток */
async function cardsMany(uids, list, idLang = 1) {
	const out = new Map();
	if (!list.length) return out;
	const loaded = await load(list, idLang);
	for (const uid of uids) out.set(Number(uid), view(await permissions(uid), uid, loaded, list));
	return out;
}

/** Чи бачить людина всі ці записи (поділитися можна лише тим, що бачиш сам) */
async function canSee(uid, list) {
	const map = await cards(uid, list);
	return list.every((r) => {
		const c = map.get(r.type + ":" + r.id);
		return c && !c.denied && !c.missing;
	});
}

/** Пошук записів для картки: лише ті, що людина бачить */
async function search(uid, q, idLang = 1) {
	const s = String(q || "").trim().slice(0, 100);
	if (s.length < 2) return [];
	const perms = await permissions(uid);
	const like = "%" + s.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
	const num = /^\d{1,10}$/.test(s) ? Number(s) : 0;
	const found = [];
	const scoped = (def, alias) => (def.all && !allowed(perms, def.all) ? { sql: ` AND (${alias}.${def.owner} = ? OR ${alias}.${def.owner} IS NULL)`, params: [uid] } : { sql: "", params: [] });
	const run = async (type, sql, params) => {
		const def = TYPES[type];
		if (def.list && !allowed(perms, def.list)) return;
		// Помилка в одному типі записів не ламає пошук по інших (і видна в журналі)
		try {
			const [rows] = await pool.query(sql, params);
			rows.forEach((r) => found.push({ type, id: Number(r.id) }));
		} catch (e) {
			logging.error(`[chat] records.search ${type}`, e);
		}
	};
	let sc = scoped(TYPES.order, "o");
	await run("order", `SELECT o.id FROM ${P}orders o WHERE o.deleted_at IS NULL AND (o.reference LIKE ? OR o.external_number LIKE ? OR o.id = ?)${sc.sql} ORDER BY o.id DESC LIMIT 6`, [like, like, num, ...sc.params]);
	sc = scoped(TYPES.lead, "l");
	await run("lead", `SELECT l.id FROM ${P}leads l WHERE l.deleted_at IS NULL AND (l.title LIKE ? OR l.id = ?)${sc.sql} ORDER BY l.id DESC LIMIT 6`, [like, num, ...sc.params]);
	// Клієнтів шукаємо тим самим пошуком, що й у модулі клієнтів (ім'я, телефон, email, ідентифікатори)
	if (allowed(perms, TYPES.client.list)) {
		const own = allowed(perms, TYPES.client.all) ? null : uid;
		try {
			const list = await require("../clients/queries").search(s, null, own);
			list.slice(0, 6).forEach((c) => found.push({ type: "client", id: Number(c.id) }));
		} catch (e) {
			logging.error("[chat] records.search client", e);
		}
	}
	await run("deal", `SELECT d.id FROM ${P}deals d WHERE d.active = 1 AND (d.title LIKE ? OR d.id = ?) ORDER BY d.id DESC LIMIT 6`, [like, num]);
	const map = await cards(uid, found, idLang);
	return found.map((r) => map.get(r.type + ":" + r.id)).filter((c) => c && !c.denied && !c.missing);
}

/** Зберегти зв'язки повідомлення із записами (для «обговорень запису») */
async function save(conn, idMessage, list) {
	await conn.query(`DELETE FROM ${T.records} WHERE id_message = ?`, [idMessage]);
	if (list.length) await conn.query(`INSERT IGNORE INTO ${T.records} (id_message, ref_type, id_ref) VALUES ?`, [list.map((r) => [idMessage, r.type, r.id])]);
}

/** Об'єднати явні записи (картка з поля вводу) і знайдені в тексті */
const merge = (explicit, body) => clean([...(explicit || []), ...detect(body)]);

module.exports = { TYPES, MAX, clean, detect, cards, cardsMany, canSee, search, save, merge };