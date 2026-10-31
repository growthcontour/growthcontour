"use strict";

/**
 * Сповіщення про замовлення — правила на кожен сайт (інтеграцію).
 *
 * Налаштування: settings_integrations.notify (JSON) — події, умови, Telegram (токен зашифрований);
 * адресати — спільна таблиця notif_recipients (scope = "orders.site", scope_ref = id інтеграції),
 * доставка в систему (дзвіночок / push) — спільна notify(); Telegram — спільний клієнт notifications/channels/telegram.
 *
 * Замовлення без сайту (контакт-центр тощо) — за правилами першого активного джерела «Custom»
 * (там же налаштовуються ручні замовлення), тож і вони мають адресатів.
 *
 * Події: new — нове замовлення; status — перехід у вибрані статуси; unassigned — не взяли в роботу за N хв;
 *        paid — оплачено; ttn — створено ТТН; delivered — доставлено; returned — повернення посилки; refund — повернення коштів;
 *        rma — заявка на повернення / обмін (нова або зміна її стану).
 */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const crypto = require("../../helpers/crypto");
const recipients = require("../notifications/recipients");
const { notify } = require("../notifications/notify");
const telegram = require("../notifications/channels/telegram");
const i18n = require("../../config/i18n/i18n");
const LOCALE = process.env.APP_LOCALE || "uk";
const t = (phrase, vars) => i18n.__({ phrase, locale: LOCALE }, vars || {});

const P = config.get("configDatabase").prefix;
const SCOPE = "orders.site";
const EVENTS = ["new", "status", "unassigned", "paid", "ttn", "delivered", "returned", "refund", "rma"];
const ICONS = { new: "🛒", status: "🔄", unassigned: "⏰", paid: "💳", ttn: "📦", delivered: "✅", returned: "↩️", refund: "💸", rma: "🔁" };
// Стани заявки на повернення — підписи в orders.notify.rma.*
const RMA_STATUS = new Set(["new", "awaiting", "received", "checked", "refunded", "exchanged", "rejected", "closed", "canceled"]);
const json = (v) => {
	if (v && typeof v === "object") return v;
	try {
		return v ? JSON.parse(v) : {};
	} catch (e) {
		return {};
	}
};
const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/** Налаштування з бази → чистий вигляд (токен не віддаємо — лише ознаку й 4 останні символи) */
function normalize(raw) {
	const n = json(raw);
	const ev = n.events || {};
	const tg = n.tg || {};
	return {
		events: Object.fromEntries(EVENTS.map((k) => [k, !!ev[k]])),
		statuses: (Array.isArray(n.statuses) ? n.statuses : []).map(Number).filter((x) => x > 0),
		unassigned_min: Math.min(1440, Math.max(5, parseInt(n.unassigned_min, 10) || 15)),
		min_total: Math.max(0, Number(n.min_total) || 0),
		payment_contains: String(n.payment_contains || "").slice(0, 200),
		first_order: !!n.first_order,
		manager: !!n.manager,
		push: !!n.push,
		tg: {
			enabled: !!tg.enabled,
			chat_id: tg.chat_id ? String(tg.chat_id).slice(0, 64) : "",
			thread_id: tg.thread_id ? parseInt(tg.thread_id, 10) || null : null,
			has_token: !!tg.cipher,
			last4: tg.last4 || null,
		},
	};
}

async function rawOf(idIntegration, conn) {
	const [[r]] = await (conn || pool).query(`SELECT notify FROM ${P}settings_integrations WHERE id = ?`, [idIntegration]);
	return r ? json(r.notify) : null;
}

/** Для форми інтеграції: правила + адресати */
async function load(idIntegration, idLang) {
	return { ...normalize(await rawOf(idIntegration)), recipients: await recipients.list(SCOPE, idIntegration, idLang) };
}

/** Перевірка форми. Повертає текст помилки або null */
function validate(b, current) {
	const tg = (b && b.tg) || {};
	if (!tg.enabled) return null;
	const token = String(tg.token || "").trim();
	if (!token && !(current && current.tg && current.tg.cipher)) return "orders.integrations.notify.e_token";
	if (token && !telegram.TOKEN_RE.test(token)) return "orders.integrations.notify.e_token_format";
	if (!String(tg.chat_id || "").trim()) return "orders.integrations.notify.e_chat";
	return null;
}

/** Зберегти правила й адресатів (у транзакції збереження інтеграції). Токен шифрується; порожній — лишається старий */
async function save(conn, idIntegration, b) {
	b = b || {};
	const cur = (await rawOf(idIntegration, conn)) || {};
	const err = validate(b, cur);
	if (err) throw Object.assign(new Error(err), { status: 400, i18n: true });
	const tgIn = b.tg || {};
	const token = String(tgIn.token || "").trim();
	let tg = { ...(cur.tg || {}), enabled: !!tgIn.enabled, chat_id: String(tgIn.chat_id || "").trim() || null, thread_id: tgIn.thread_id ? parseInt(tgIn.thread_id, 10) || null : null };
	if (token) {
		const enc = crypto.encrypt(token);
		// Buffer'и шифру — у base64, щоб жити в JSON
		tg = { ...tg, cipher: enc.cipher.toString("base64"), iv: enc.iv.toString("base64"), tag: enc.tag.toString("base64"), last4: crypto.last4(token) };
	}
	const n = normalize({ ...b, tg: {} });
	const stored = { events: n.events, statuses: n.statuses, unassigned_min: n.unassigned_min, min_total: n.min_total, payment_contains: n.payment_contains, first_order: n.first_order, manager: n.manager, push: n.push, tg };
	await conn.query(`UPDATE ${P}settings_integrations SET notify = ? WHERE id = ?`, [JSON.stringify(stored), idIntegration]);
	await recipients.save(conn, SCOPE, idIntegration, Array.isArray(b.recipients) ? b.recipients : []);
}

function tokenOf(tg) {
	return tg && tg.cipher ? crypto.decrypt(Buffer.from(tg.cipher, "base64"), Buffer.from(tg.iv, "base64"), Buffer.from(tg.tag, "base64")) : null;
}

/** Тест Telegram з форми (незбережене має пріоритет) */
async function testTelegram(idIntegration, b) {
	const cur = (idIntegration && (await rawOf(idIntegration))) || {};
	const tg = (b && b.tg) || {};
	const token = String(tg.token || "").trim() || tokenOf(cur.tg);
	if (!token) return { ok: false, error: "orders.integrations.notify.e_token" };
	const me = await telegram.call(token, "getMe");
	if (!me.ok) return { ok: false, error: me.description || "getMe" };
	const chatId = String(tg.chat_id || (cur.tg && cur.tg.chat_id) || "").trim();
	if (chatId) {
		const params = { chat_id: chatId, text: t("orders.notify.test") };
		const th = parseInt(tg.thread_id || (cur.tg && cur.tg.thread_id), 10);
		if (th) params.message_thread_id = th;
		const sent = await telegram.call(token, "sendMessage", params);
		if (!sent.ok) return { ok: false, error: sent.description || "sendMessage" };
	}
	return { ok: true, bot: me.result.username || me.result.first_name };
}

/** Дані замовлення для тексту й умов */
async function orderInfo(idOrder) {
	const [[o]] = await pool.query(
		`SELECT o.id, o.id_integration, o.reference, o.total, o.currency_iso, o.custom_fields, o.client, o.id_client, o.id_user, o.status,
		        si.id AS notify_integration, si.name AS site, si.notify, sl.text AS status_name
		   FROM ${P}orders o
		   LEFT JOIN ${P}settings_integrations si ON si.id = COALESCE(o.id_integration,
		        (SELECT c.id FROM ${P}settings_integrations c WHERE c.platform = 'custom' AND c.status = 'active' ORDER BY c.id LIMIT 1))
		   LEFT JOIN ${P}orders_status_lang sl ON sl.id_status = o.status AND sl.id_lang = 1
		  WHERE o.id = ? AND o.deleted_at IS NULL`,
		[idOrder]
	);
	return o || null;
}

async function isFirstOrder(o) {
	if (!o.id_client) return true;
	const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}orders WHERE id_client = ? AND id <> ? AND deleted_at IS NULL`, [o.id_client, o.id]);
	return !Number(r.n);
}

/**
 * Подія замовлення → сповіщення за правилами сайту.
 * extra: { to } — новий статус (для status), { number } — ТТН, { amount } — повернення
 * Ніколи не кидає помилку: сповіщення не повинно ламати дію, яка його викликала.
 */
async function fire(idOrder, event, extra = {}) {
	// Повідомлення клієнту за шаблонами з тим самим тригером — незалежно від правил сповіщень команди
	require("./messages").onEvent(idOrder, event, extra);
	// Автоматичні правила «Коли → Якщо → Зробити»
	require("./rules").onEvent(idOrder, event, extra);
	try {
		if (!EVENTS.includes(event)) return;
		const o = await orderInfo(idOrder);
		if (!o || !o.notify_integration) return;
		const raw = json(o.notify);
		const cfg = normalize(raw);
		if (!cfg.events[event]) return;
		if (event === "status" && cfg.statuses.length && !cfg.statuses.includes(Number(extra.to || o.status))) return;

		// Умови правила
		const cf = json(o.custom_fields);
		if (cfg.min_total && Number(o.total) < cfg.min_total) return;
		if (cfg.payment_contains) {
			const pay = String(cf._payment_method || "").toLowerCase();
			const words = cfg.payment_contains.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
			if (words.length && !words.some((w) => pay.includes(w))) return;
		}
		if (cfg.first_order && event === "new" && !(await isFirstOrder(o))) return;

		const client = json(o.client);
		const who = [client.firstname, client.lastname].filter(Boolean).join(" ") || client.phone || "";
		const money = new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(o.total) || 0) + " " + (o.currency_iso || "");
		const title = `${ICONS[event]} ${o.site || ""} · ${o.reference}`;
		const detail = {
			new: `${who} · ${money}`,
			status: o.status_name || "",
			unassigned: `${who} · ${money}`,
			paid: money,
			ttn: extra.number ? t("orders.notify.ttn", { n: extra.number }) : "",
			delivered: extra.number ? t("orders.notify.ttn", { n: extra.number }) : "",
			returned: extra.number ? t("orders.notify.ttn", { n: extra.number }) : "",
			refund: extra.amount ? "−" + extra.amount : "",
			rma: [extra.number, RMA_STATUS.has(extra.status) ? t("orders.notify.rma." + extra.status) : null].filter(Boolean).join(" · "),
		}[event];
		const url = `/orders/${o.id}/`;
		const msg = {
			type: "orders." + event,
			channels: cfg.push ? ["inapp", "webpush"] : ["inapp"],
			collapseKey: `order_${o.id}_${event}`,
			key: `order_${o.id}_${event}_${extra.to || extra.number || extra.amount || ""}${extra.status ? "_" + extra.status : ""}`.slice(0, 64),
			priority: event === "new" || event === "unassigned" ? 7 : 5,
			payload: { title, name: o.site || "", message: detail, url, date: new Date().toISOString().slice(0, 19).replace("T", " ") },
		};

		await recipients.notifyScope(SCOPE, o.notify_integration, msg);
		if (cfg.manager && o.id_user) await notify({ ...msg, audience: { user: o.id_user } }).catch((e) => logging.error(e));

		// Спільний чат команди в Telegram
		if (cfg.tg.enabled && cfg.tg.chat_id) {
			const token = tokenOf(raw.tg);
			if (token) {
				const base = ((config.get("configServer") || {}).url || "").replace(/\/+$/, "");
				const params = { chat_id: cfg.tg.chat_id, text: `<b>${escHtml(title)}</b>\n${escHtml(detail)}\n\n<a href="${base}${url}">${escHtml(t("orders.notify.open"))}</a>`, parse_mode: "HTML", disable_web_page_preview: true };
				if (cfg.tg.thread_id) params.message_thread_id = cfg.tg.thread_id;
				const r = await telegram.call(token, "sendMessage", params);
				if (!r.ok) logging.error(new Error("orders notify telegram: " + (r.description || "error")));
			}
		}
	} catch (e) {
		logging.error(e);
	}
}

/** «Не взяли в роботу за N хвилин»: раз на хвилину; кожне замовлення — один раз (позначка в журналі подій) */
async function checkUnassigned() {
	try {
		const [sites] = await pool.query(`SELECT id, notify FROM ${P}settings_integrations WHERE notify IS NOT NULL`);
		// Замовлення без сайту — за правилами першого активного «Custom» (як у fire)
		const [[fallback]] = await pool.query(`SELECT id FROM ${P}settings_integrations WHERE platform = 'custom' AND status = 'active' ORDER BY id LIMIT 1`);
		for (const s of sites) {
			const cfg = normalize(s.notify);
			if (!cfg.events.unassigned) continue;
			const [rows] = await pool.query(
				`SELECT o.id FROM ${P}orders o
				  WHERE (o.id_integration = ? OR (o.id_integration IS NULL AND ?)) AND o.deleted_at IS NULL AND o.id_user IS NULL AND o.locked_by IS NULL
				    AND o.date_add < NOW() - INTERVAL ? MINUTE AND o.date_add > NOW() - INTERVAL 1 DAY
				    AND NOT EXISTS (SELECT 1 FROM ${P}orders_events e WHERE e.id_order = o.id AND e.type = 'notify_unassigned')
				  LIMIT 50`,
				[s.id, fallback && fallback.id === s.id ? 1 : 0, cfg.unassigned_min]
			);
			for (const r of rows) {
				await pool.query(`INSERT INTO ${P}orders_events (id_order, id_user, type, payload, source, date_add) VALUES (?, NULL, 'notify_unassigned', ?, 'manual', NOW())`, [r.id, JSON.stringify({ minutes: cfg.unassigned_min })]);
				await fire(r.id, "unassigned");
			}
		}
	} catch (e) {
		logging.error(e);
	}
}

let timer = null;
function start() {
	if (timer) return;
	timer = setInterval(checkUnassigned, 60 * 1000);
	timer.unref();
	require("./messages").start();
}

module.exports = { EVENTS, load, save, validate, testTelegram, fire, start, SCOPE };
