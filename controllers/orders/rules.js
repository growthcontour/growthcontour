"use strict";

/**
 * Автоматичні правила замовлень: «Коли → Якщо → Зробити».
 * Схема малюється у візуальному редакторі (Drawflow): вузол-тригер, далі умови й дії, з'єднані стрілками.
 * Зберігаємо і схему редактора (graph — щоб відкрити як було), і скомпільоване дерево (compiled — для виконання).
 *
 * Виконання — з подій замовлення (ті самі, що й сповіщення: notify.fire після commit).
 * Умова, що не виконалась, зупиняє свою гілку; дії виконуються по черзі; кожен запуск — у журналі правила.
 * Захист від зациклення: зміна статусу правилом запускає правила ще не більше ніж на MAX_DEPTH рівнів.
 */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");

const P = config.get("configDatabase").prefix;
const EVENTS = ["new", "status", "paid", "ttn", "delivered", "returned"];
const CONDITIONS = ["cond_site", "cond_status", "cond_total", "cond_payment", "cond_delivery", "cond_risk", "cond_first"];
const ACTIONS = ["act_status", "act_manager", "act_message", "act_note"];
const MAX_DEPTH = 2;
const MAX_NODES = 50;

const json = (v, d) => {
	if (v && typeof v === "object") return v;
	try {
		return v ? JSON.parse(v) : d;
	} catch {
		return d;
	}
};
const httpErr = (status, message) => Object.assign(new Error(message), { status });

/* ─── Компіляція схеми редактора ─── */

/**
 * Drawflow export → { trigger: { event, status }, nodes: { id: { type, data, next: [id] } } }.
 * Рівно один тригер; від нього досяжні лише умови й дії; цикли й «висячі» вузли — помилка.
 */
function compile(graph) {
	const raw = (((graph || {}).drawflow || {}).Home || {}).data || {};
	const nodes = Object.values(raw);
	if (!nodes.length || nodes.length > MAX_NODES) throw httpErr(400, "orders.rules.e_empty");
	const triggers = nodes.filter((n) => n.name === "trigger");
	if (triggers.length !== 1) throw httpErr(400, "orders.rules.e_trigger");
	const t = triggers[0];
	const event = String((t.data || {}).event || "");
	if (!EVENTS.includes(event)) throw httpErr(400, "orders.rules.e_event");

	const out = {};
	const next = (n) => Object.values(n.outputs || {}).flatMap((o) => (o.connections || []).map((c) => String(c.node)));
	const visit = (id, path) => {
		if (path.includes(id)) throw httpErr(400, "orders.rules.e_cycle");
		const n = raw[id];
		if (!n || ![...CONDITIONS, ...ACTIONS].includes(n.name)) throw httpErr(400, "orders.rules.e_node");
		if (out[id]) return;
		out[id] = { type: n.name, data: n.data || {}, next: next(n) };
		out[id].next.forEach((x) => visit(x, [...path, id]));
	};
	const first = next(t);
	if (!first.length) throw httpErr(400, "orders.rules.e_actions");
	first.forEach((x) => visit(x, []));
	if (!Object.values(out).some((n) => ACTIONS.includes(n.type))) throw httpErr(400, "orders.rules.e_actions");
	if (Object.keys(out).length !== nodes.length - 1) throw httpErr(400, "orders.rules.e_orphan");
	return { trigger: { event, status: parseInt((t.data || {}).status, 10) || null }, start: first, nodes: out };
}

/* ─── Збереження ─── */

async function list() {
	const [rows] = await pool.query(
		`SELECT r.id, r.name, r.status, r.trigger_event, r.date_edit,
		        (SELECT COUNT(*) FROM ${P}orders_rules_log l WHERE l.id_rule = r.id) AS runs,
		        (SELECT MAX(date_add) FROM ${P}orders_rules_log l WHERE l.id_rule = r.id) AS last_run
		   FROM ${P}orders_rules r ORDER BY r.id`
	);
	return rows;
}

async function get(id) {
	const [[r]] = await pool.query(`SELECT id, name, status, graph FROM ${P}orders_rules WHERE id = ?`, [id]);
	if (!r) throw httpErr(404, "orders.rules.e_not_found");
	return { ...r, graph: json(r.graph, null) };
}

async function save(id, b) {
	const name = String(b.name || "").trim().slice(0, 128);
	if (!name) throw httpErr(400, "orders.rules.e_name");
	const compiled = compile(b.graph);
	const row = [name, b.status === undefined || Number(b.status) ? 1 : 0, compiled.trigger.event, JSON.stringify(b.graph), JSON.stringify(compiled)];
	if (id) {
		await pool.query(`UPDATE ${P}orders_rules SET name = ?, status = ?, trigger_event = ?, graph = ?, compiled = ?, date_edit = NOW() WHERE id = ?`, [...row, id]);
		return id;
	}
	const [r] = await pool.query(`INSERT INTO ${P}orders_rules (name, status, trigger_event, graph, compiled, date_add, date_edit) VALUES (?, ?, ?, ?, ?, NOW(), NOW())`, row);
	return r.insertId;
}

async function remove(id) {
	await pool.query(`DELETE FROM ${P}orders_rules_log WHERE id_rule = ?`, [id]);
	await pool.query(`DELETE FROM ${P}orders_rules WHERE id = ?`, [id]);
}

async function log(id, limit = 50) {
	const [rows] = await pool.query(
		`SELECT l.id, l.id_order, o.reference, l.result, l.actions, l.error, l.date_add
		   FROM ${P}orders_rules_log l LEFT JOIN ${P}orders o ON o.id = l.id_order
		  WHERE l.id_rule = ? ORDER BY l.id DESC LIMIT ?`,
		[id, limit]
	);
	return rows.map((r) => ({ ...r, actions: json(r.actions, []) }));
}

/* ─── Виконання ─── */

async function orderOf(id) {
	const [[o]] = await pool.query(`SELECT * FROM ${P}orders WHERE id = ? AND deleted_at IS NULL`, [id]);
	return o || null;
}

async function check(node, o) {
	const d = node.data || {};
	const cf = json(o.custom_fields, {});
	const has = (v, needle) => String(v || "").toLowerCase().includes(String(needle || "").trim().toLowerCase());
	switch (node.type) {
		case "cond_site":
			return Number(d.site) === Number(o.id_integration);
		case "cond_status":
			return Number(d.status) === Number(o.status);
		case "cond_total": {
			const v = Number(d.value) || 0;
			return d.op === "lte" ? Number(o.total) <= v : Number(o.total) >= v;
		}
		case "cond_payment":
			return !!String(d.text || "").trim() && has(cf._payment_method, d.text);
		case "cond_delivery":
			return !!String(d.text || "").trim() && has(cf._delivery_method, d.text);
		case "cond_risk": {
			const r = await require("../clients/risk").forOrder(o.id);
			const rank = { ok: 0, warn: 1, high: 2 };
			return !!r && rank[r.level] >= rank[d.level === "high" ? "high" : "warn"];
		}
		case "cond_first": {
			if (!o.id_client) return true;
			const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}orders WHERE id_client = ? AND id <> ? AND deleted_at IS NULL`, [o.id_client, o.id]);
			return !Number(r.n);
		}
	}
	return false;
}

async function act(node, o, depth, idRule) {
	const d = node.data || {};
	const notify = require("./notify");
	switch (node.type) {
		case "act_status": {
			const to = parseInt(d.status, 10);
			if (!to || Number(o.status) === to) return "skip";
			const { applyStatus } = require("./statusFlags");
			const conn = await pool.getConnection();
			let r;
			try {
				await conn.beginTransaction();
				r = await applyStatus(conn, o.id, to, { source: "system", comment: "rule #" + idRule, extra: { rule: idRule } });
				await conn.commit();
			} catch (e) {
				await conn.rollback().catch(() => {});
				throw e;
			} finally {
				conn.release();
			}
			if (!r) return "skip";
			o.status = to;
			require("./outboxProcessor").kickOutbox();
			notify.fire(o.id, "status", { to, depth: depth + 1 });
			if (r.flags.is_paid && !r.was_paid) notify.fire(o.id, "paid", { depth: depth + 1 });
			return "ok";
		}
		case "act_manager": {
			const to = parseInt(d.user, 10) || null;
			if ((o.id_user || null) === to) return "skip";
			await pool.query(`UPDATE ${P}orders SET id_user = ?, date_edit = NOW() WHERE id = ?`, [to, o.id]);
			await pool.query(`INSERT INTO ${P}orders_events (id_order, id_user, type, payload, source, date_add) VALUES (?, NULL, 'assigned', ?, 'system', NOW())`, [o.id, JSON.stringify({ from: o.id_user || null, to, rule: idRule })]);
			o.id_user = to;
			return "ok";
		}
		case "act_message": {
			const [[t]] = await pool.query(`SELECT id, text, id_service FROM ${P}orders_message_templates WHERE id = ? AND status = 1`, [parseInt(d.template, 10) || 0]);
			if (!t) return "skip";
			const id = await require("./messages").enqueue({ idOrder: o.id, text: t.text, idTemplate: t.id, idService: t.id_service, source: "auto" });
			return id ? "ok" : "skip";
		}
		case "act_note": {
			const text = String(d.text || "").trim().slice(0, 500);
			if (!text) return "skip";
			await pool.query(`UPDATE ${P}orders SET note = CONCAT_WS('\\n', NULLIF(note, ''), ?), date_edit = NOW() WHERE id = ?`, [text, o.id]);
			return "ok";
		}
	}
	return "skip";
}

/** Пройти схему від тригера: умова — фільтр гілки, дія — виконати й іти далі */
async function run(rule, o, depth) {
	const c = rule.compiled;
	const done = [];
	const seen = new Set(); // вузол, до якого ведуть дві гілки, виконується один раз
	const walk = async (ids) => {
		for (const id of ids) {
			const n = c.nodes[id];
			if (!n || seen.has(id)) continue;
			seen.add(id);
			if (CONDITIONS.includes(n.type)) {
				if (await check(n, o)) await walk(n.next);
				continue;
			}
			let res;
			try {
				res = await act(n, o, depth, rule.id);
			} catch (e) {
				res = "error";
				logging.error(e);
			}
			done.push({ node: id, type: n.type, result: res });
			await walk(n.next);
		}
	};
	await walk(c.start);
	return done;
}

/** Подія замовлення → правила з таким тригером (викликається зі сповіщень після commit) */
async function onEvent(idOrder, event, extra = {}) {
	try {
		if (!EVENTS.includes(event)) return;
		const depth = Number(extra.depth) || 0;
		if (depth > MAX_DEPTH) return;
		const [rules] = await pool.query(`SELECT id, compiled FROM ${P}orders_rules WHERE status = 1 AND trigger_event = ? ORDER BY id`, [event]);
		if (!rules.length) return;
		const o = await orderOf(idOrder);
		if (!o) return;
		for (const r of rules) {
			const rule = { id: r.id, compiled: json(r.compiled, null) };
			if (!rule.compiled) continue;
			if (event === "status" && rule.compiled.trigger.status && rule.compiled.trigger.status !== Number(extra.to || o.status)) continue;
			let actions = [];
			let error = null;
			try {
				actions = await run(rule, o, depth);
			} catch (e) {
				error = String(e.message).slice(0, 500);
				logging.error(e);
			}
			// У журнал — лише запуски, де дійшло до дій або сталася помилка
			if (actions.length || error) {
				await pool.query(`INSERT INTO ${P}orders_rules_log (id_rule, id_order, result, actions, error, date_add) VALUES (?, ?, ?, ?, ?, NOW())`, [
					r.id,
					idOrder,
					error ? "error" : actions.some((a) => a.result === "error") ? "partial" : "ok",
					JSON.stringify(actions),
					error,
				]);
			}
		}
	} catch (e) {
		logging.error(e);
	}
}

module.exports = { EVENTS, CONDITIONS, ACTIONS, compile, list, get, save, remove, log, onEvent };