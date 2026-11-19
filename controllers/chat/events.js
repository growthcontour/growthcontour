"use strict";

/**
 * Події системи в каналах чату: канал підписується на джерело, і кожна подія приходить у нього повідомленням-подією
 * (type = event), яке можна обговорити в треді, поставити реакцію, нагадування чи задачу.
 *
 * Джерела:
 *   orders  — події замовлень (core/modules/orders: new, status, paid, ttn, delivered, returned, refund, rma, unassigned);
 *             у повідомленні — картка замовлення, яку кожен бачить зі своїми правами.
 *   catalog — системні сповіщення каталогу (залишки, ціни, синхронізації…): текст сповіщення як є.
 * Підписати канал може власник / адміністратор (автоматичний канал — модератор чату) з правом джерела.
 */
const { pool, P, T, httpErr, membership, permissions, allowed } = require("./common");
const realtime = require("./realtime");
const logging = require("../../logging/logging");
const i18n = require("../../config/i18n/i18n");

const LOCALE = process.env.APP_LOCALE || "uk";
const t = (phrase, vars) => i18n.__({ phrase, locale: LOCALE }, vars || {});

const SOURCES = {
	orders: { perm: ["orders.all", "view"], events: ["new", "status", "paid", "unassigned", "ttn", "delivered", "returned", "refund", "rma"] },
	catalog: { perm: ["products.list", "view"], events: ["low_stock", "out_of_stock", "price_schedule", "order_stock", "reviews", "sync", "sites", "exchange"] },
};
const MAX_PER_ROOM = 10;

const parse = (v) => {
	if (v == null || typeof v === "object") return v;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
};

/** Хто може змінювати підписки чату */
function canEdit(m, perms) {
	if (m.type === "direct" || m.type === "notes" || m.archived) return false;
	return m.kind === "manual" ? m.role === "owner" || m.role === "admin" : !!perms.moderate;
}

/** Джерела, які людина може підключити (за її правами) */
async function available(uid) {
	const p = await permissions(uid);
	return Object.entries(SOURCES)
		.filter(([, s]) => allowed(p, s.perm[0], s.perm[1]))
		.map(([source, s]) => ({ source, events: s.events }));
}

async function list(uid, idRoom, perms) {
	const m = await membership(idRoom, uid);
	const [rows] = await pool.query(`SELECT id, source, events, id_user, date_add FROM ${T.subs} WHERE id_room = ? ORDER BY id`, [idRoom]);
	return {
		subscriptions: rows.map((r) => ({ id: Number(r.id), source: r.source, events: parse(r.events) || [], id_user: r.id_user, date_add: r.date_add })),
		can_edit: canEdit(m, perms),
		sources: canEdit(m, perms) ? await available(uid) : [],
	};
}

/** Додати або змінити підписку (одна на джерело в чаті). events — підмножина подій джерела */
async function save(uid, idRoom, source, events, perms) {
	const m = await membership(idRoom, uid);
	if (!canEdit(m, perms)) throw httpErr(403, "chat.errors.forbidden");
	const src = SOURCES[source];
	if (!src) throw httpErr(400, "chat.errors.validation", [{ field: "source", message: "unknown" }]);
	if (!allowed(await permissions(uid), src.perm[0], src.perm[1])) throw httpErr(403, "chat.errors.forbidden");
	const ev = [...new Set((Array.isArray(events) ? events : []).filter((e) => src.events.includes(e)))];
	if (!ev.length) {
		await pool.query(`DELETE FROM ${T.subs} WHERE id_room = ? AND source = ?`, [idRoom, source]);
		return list(uid, idRoom, perms);
	}
	const [[n]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.subs} WHERE id_room = ? AND source <> ?`, [idRoom, source]);
	if (Number(n.n) >= MAX_PER_ROOM) throw httpErr(400, "chat.errors.validation");
	await pool.query(
		`INSERT INTO ${T.subs} (id_room, source, events, id_user, date_add) VALUES (?, ?, ?, ?, NOW())
		 ON DUPLICATE KEY UPDATE events = VALUES(events), id_user = VALUES(id_user)`,
		[idRoom, source, JSON.stringify(ev), uid]
	);
	return list(uid, idRoom, perms);
}

/** Чати, підписані на подію джерела (не архівні) */
async function roomsFor(source, event) {
	const [rows] = await pool.query(
		`SELECT s.id_room FROM ${T.subs} s JOIN ${T.rooms} r ON r.id = s.id_room AND r.archived = 0
		  WHERE s.source = ? AND JSON_CONTAINS(s.events, JSON_QUOTE(?))`,
		[source, event]
	);
	return rows.map((r) => r.id_room);
}

/**
 * Опублікувати подію в чат. data: { source, ev, title?, message?, url?, extra? }, records — картки.
 * Як і звичайне повідомлення: стрічка, лічильник непрочитаних, web-push за налаштуваннями учасника.
 */
async function post(idRoom, data, records = []) {
	const messages = require("./messages");
	const recs = require("./records");
	const rooms = require("./rooms");
	const recList = recs.clean(records);
	const id = await rooms.tx(async (conn) => {
		const [r] = await conn.query(`INSERT INTO ${T.messages} (id_room, id_user, type, data, date_add) VALUES (?, NULL, 'event', ?, NOW(3))`, [idRoom, JSON.stringify(Object.assign({}, data, { records: recList }))]);
		await conn.query(`UPDATE ${T.rooms} SET last_message_id = ?, last_message_at = NOW(3) WHERE id = ?`, [r.insertId, idRoom]);
		await conn.query(`UPDATE ${T.members} SET hidden = 0 WHERE id_room = ? AND hidden = 1`, [idRoom]);
		await recs.save(conn, r.insertId, recList);
		return r.insertId;
	});
	// Подію кожен отримує зі своїми правами на картки (broadcast розсилає кожному власну)
	const ids = await realtime.roomMembers(idRoom);
	if (!ids.length) return id;
	const msg = await messages.getOne(ids[0], id);
	await messages.broadcast(idRoom, "chat:message", msg);
	const [[room]] = await pool.query(`SELECT id, type, kind, name FROM ${T.rooms} WHERE id = ?`, [idRoom]);
	// У web-push — лише назва події, без даних запису (адресат може не мати доступу до нього)
	const push = Object.assign({}, msg, { id_user: 0, records: [], body: data.title || t("chat.events." + data.source + "." + data.ev) });
	if (room) require("./notify").onMessage(room, push, {}).catch((e) => logging.error("[chat] event notify", e));
	return id;
}

async function publish(source, event, data, records) {
	try {
		const rooms = await roomsFor(source, event);
		for (const idRoom of rooms) await post(idRoom, Object.assign({ source, ev: event }, data), records);
	} catch (e) {
		logging.error("[chat] events " + source + "." + event, e);
	}
}

// ─── Замовлення: точки розширення ядра (без правок модуля замовлень) ───
function bindOrders() {
	let ext;
	try {
		ext = require("../../core/modules/orders");
	} catch {
		return;
	}
	for (const ev of SOURCES.orders.events) {
		ext.on("chat", ev, async (idOrder, extra) => {
			// Що саме змінилось — лише нечутливі значення події (новий статус, номер відправлення, стан повернення)
			const keep = {};
			["to", "number", "status"].forEach((k) => extra && extra[k] != null && (keep[k] = String(extra[k]).slice(0, 64)));
			if (ev === "status" && keep.to) {
				const [[s]] = await pool.query(`SELECT text FROM ${P}orders_status_lang WHERE id_status = ? AND id_lang = 1`, [keep.to]);
				if (s) keep.status_name = s.text;
			}
			await publish("orders", ev, { extra: keep }, [{ type: "order", id: idOrder }]);
		});
	}
}

/**
 * Сповіщення з notif_recipients (notifyScope) — для джерел, що не мають власних точок розширення.
 * scope → джерело; подія — остання частина типу сповіщення (system.catalog.low_stock → low_stock).
 */
const SCOPES = { "catalog.alerts": "catalog" };
function fromScope(scope, scopeRef, payload) {
	const source = SCOPES[scope];
	if (!source || !payload || !payload.type) return;
	const ev = String(payload.type).split(".").pop();
	if (!SOURCES[source].events.includes(ev)) return;
	const p = payload.payload || {};
	// Лише відносні посилання всередині системи
	const url = typeof p.url === "string" && /^\/(?!\/)[^\s"'<>]*$/.test(p.url) ? p.url : null;
	setImmediate(() => publish(source, ev, { title: String(p.title || "").slice(0, 255), message: String(p.message || "").slice(0, 2000), url }, []));
}

bindOrders();

module.exports = { SOURCES, list, save, available, post, publish, fromScope };