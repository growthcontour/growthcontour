"use strict";

/**
 * Розсилки покупцям ботів магазинів (розділ «Розсилки → Telegram»).
 *
 * Аудиторія — покупці, які запускали бота й не зупинили його (Telegram дозволяє писати лише їм), з фільтрами:
 * магазини, сегмент (усі / купували / не купували / неактивні N днів / з незавершеним кошиком), мова Telegram.
 * Повідомлення — текст (HTML Telegram), фото, кнопка: магазин / кошик / товар (відкриває вітрину) або посилання.
 * Відправка — чергою, до 25 повідомлень на секунду на бота (ліміт Telegram ~30), з паузою на 429 (retry_after).
 * {promo} у тексті — персональний одноразовий промокод кожному адресату (копія промокоду-шаблону з «Замовлення → Промокоди»).
 * Статистика — доставлено, не доставлено, зупинили бота, переходи за кнопкою, замовлення за 3 дні після розсилки.
 */

const crypto = require("crypto");
const { pool, P, T, httpErr, str, json, appUrl, APP_URL } = require("./common");
const tg = require("./telegram");

const SEGMENTS = ["all", "buyers", "no_orders", "inactive", "cart"];
const TARGETS = ["shop", "cart", "product", "url"];
const STATUSES = ["draft", "scheduled", "preparing", "sending", "paused", "sent", "cancelled", "failed"];
const PER_SECOND = 25;
const MAX_ATTEMPTS = 3;
const ATTRIBUTION_HOURS = 72;

const sign = (id) => crypto.createHmac("sha256", String(process.env.APP_ENCRYPTION_KEY || "growthcontour")).update("tgb:" + id).digest("hex").slice(0, 16);

// ── Текст: лише теги, які приймає Telegram (parse_mode HTML); решта — як текст ──
const ALLOWED = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "code", "pre", "blockquote", "tg-spoiler"]);
function cleanHtml(src) {
	const s = String(src || "").replace(/\r\n?/g, "\n");
	let out = "";
	const re = /<\s*(\/?)\s*([a-z-]+)([^>]*)>/gi;
	let last = 0;
	let m;
	const esc = (x) => x.replace(/&(?!(amp|lt|gt|quot|#\d+);)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	while ((m = re.exec(s))) {
		out += esc(s.slice(last, m.index));
		last = re.lastIndex;
		const close = !!m[1];
		const tag = m[2].toLowerCase();
		if (ALLOWED.has(tag)) out += close ? `</${tag}>` : `<${tag}>`;
		else if (tag === "a") {
			if (close) out += "</a>";
			else {
				const href = (/href\s*=\s*["']([^"']+)["']/i.exec(m[3]) || [])[1] || "";
				out += /^https?:\/\//i.test(href) ? `<a href="${href.replace(/"/g, "&quot;")}">` : "<a>";
			}
		} else out += esc(m[0]);
	}
	out += esc(s.slice(last));
	return out;
}
const plainLen = (html) => String(html || "").replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot);/g, "x").length;

/** Нормалізація даних форми */
function clean(d) {
	const a = d.audience || {};
	const m = d.message || {};
	const b = m.button || {};
	const target = TARGETS.includes(b.target) ? b.target : "shop";
	return {
		name: str(d.name, 255),
		audience: {
			shops: [...new Set((Array.isArray(a.shops) ? a.shops : []).map((x) => parseInt(x, 10)).filter((x) => x > 0))].slice(0, 50),
			segment: SEGMENTS.includes(a.segment) ? a.segment : "all",
			days: Math.max(1, Math.min(365, parseInt(a.days, 10) || 30)),
			langs: [...new Set((Array.isArray(a.langs) ? a.langs : []).map((x) => String(x).toLowerCase().slice(0, 2)).filter((x) => /^[a-z]{2}$/.test(x)))].slice(0, 20),
		},
		message: {
			// Текст зберігається як ввели; очищення під Telegram — при відправці
			text: str(m.text, 8000),
			photo: /^https?:\/\//i.test(String(m.photo || "")) ? str(m.photo, 1000) : "",
			promo_template: parseInt(m.promo_template, 10) || null,
			button: {
				text: str(b.text, 64),
				target,
				product: target === "product" ? parseInt(b.product, 10) || null : null,
				url: target === "url" && /^https?:\/\//i.test(String(b.url || "")) ? str(b.url, 1000) : "",
			},
		},
		date_scheduled: d.date_scheduled && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(d.date_scheduled) ? String(d.date_scheduled).replace("T", " ").slice(0, 16) + ":00" : null,
	};
}

function shape(r) {
	return {
		id: Number(r.id),
		name: r.name,
		status: r.status,
		audience: json(r.audience, {}),
		message: json(r.message, {}),
		date_scheduled: r.date_scheduled,
		cnt_total: Number(r.cnt_total),
		cnt_sent: Number(r.cnt_sent),
		cnt_failed: Number(r.cnt_failed),
		cnt_blocked: Number(r.cnt_blocked),
		cnt_clicked: Number(r.cnt_clicked),
		cnt_orders: Number(r.cnt_orders),
		sum_orders: Number(r.sum_orders),
		last_error: r.last_error,
		date_launched: r.date_launched,
		date_finished: r.date_finished,
		date_add: r.date_add,
		editable: ["draft", "scheduled", "failed"].includes(r.status),
	};
}

async function list(q = {}) {
	const where = ["b.deleted = 0"];
	const params = [];
	if (q.status && STATUSES.includes(q.status)) {
		where.push("b.status = ?");
		params.push(q.status);
	}
	if (q.search) {
		where.push("b.name LIKE ?");
		params.push(`%${String(q.search).slice(0, 100).replace(/[\\%_]/g, (x) => "\\" + x)}%`);
	}
	const [rows] = await pool.query(`SELECT b.* FROM ${T.broadcasts} b WHERE ${where.join(" AND ")} ORDER BY b.id DESC LIMIT 500`, params);
	return rows.map(shape);
}

async function get(id) {
	const [[r]] = await pool.query(`SELECT * FROM ${T.broadcasts} WHERE id = ? AND deleted = 0`, [id]);
	if (!r) throw httpErr(404, "modules.telegramshop.bc.e_not_found");
	return shape(r);
}

async function save(id, d, idUser) {
	const c = clean(d);
	if (!c.name) throw httpErr(400, "modules.telegramshop.bc.e_name");
	if (id) {
		const cur = await get(id);
		if (!cur.editable) throw httpErr(409, "modules.telegramshop.bc.e_locked");
		await pool.query(`UPDATE ${T.broadcasts} SET name = ?, audience = ?, message = ?, date_scheduled = ?, status = IF(status = 'failed', 'draft', status), date_edit = NOW() WHERE id = ?`, [
			c.name,
			JSON.stringify(c.audience),
			JSON.stringify(c.message),
			c.date_scheduled,
			id,
		]);
		return get(id);
	}
	const [r] = await pool.query(`INSERT INTO ${T.broadcasts} (name, status, audience, message, date_scheduled, id_user, date_add) VALUES (?, 'draft', ?, ?, ?, ?, NOW())`, [
		c.name,
		JSON.stringify(c.audience),
		JSON.stringify(c.message),
		c.date_scheduled,
		idUser || null,
	]);
	return get(r.insertId);
}

async function copy(id, idUser) {
	const b = await get(id);
	return save(null, { name: `${b.name} (копія)`.slice(0, 255), audience: b.audience, message: { ...b.message, photo_file_id: undefined }, date_scheduled: null }, idUser);
}

async function remove(id) {
	const b = await get(id);
	if (["preparing", "sending"].includes(b.status)) throw httpErr(409, "modules.telegramshop.bc.e_running");
	await pool.query(`UPDATE ${T.broadcasts} SET deleted = 1, date_edit = NOW() WHERE id = ?`, [id]);
	await pool.query(`UPDATE ${T.bmessages} SET status = 'cancelled' WHERE id_broadcast = ? AND status = 'queued'`, [id]);
	return {};
}

// ── Аудиторія ──
function audienceSql(a) {
	const where = ["c.is_blocked = 0", "c.started_at IS NOT NULL", "s.status = 'active'", "s.bot_id IS NOT NULL"];
	const params = [];
	if (a.shops && a.shops.length) {
		where.push("c.id_shop IN (?)");
		params.push(a.shops);
	}
	const ord = `EXISTS (SELECT 1 FROM ${T.orders} o WHERE o.id_customer = c.id`;
	if (a.segment === "buyers") where.push(ord + ")");
	if (a.segment === "no_orders") where.push("NOT " + ord + ")");
	if (a.segment === "inactive") {
		where.push(`NOT ${ord} AND o.date_add > NOW() - INTERVAL ? DAY)`, "COALESCE(c.last_seen_at, c.date_add) < NOW() - INTERVAL ? DAY");
		params.push(a.days, a.days);
	}
	if (a.segment === "cart") where.push("c.cart IS NOT NULL");
	if (a.langs && a.langs.length) {
		where.push("LEFT(COALESCE(c.language_code, ''), 2) IN (?)");
		params.push(a.langs);
	}
	return { from: `FROM ${T.customers} c JOIN ${T.shops} s ON s.id = c.id_shop`, where: where.join(" AND "), params };
}

async function count(audience) {
	const q = audienceSql(clean({ audience }).audience);
	const [[r]] = await pool.query(`SELECT COUNT(*) AS n ${q.from} WHERE ${q.where}`, q.params);
	const [langs] = await pool.query(`SELECT LEFT(COALESCE(c.language_code, ''), 2) AS lang, COUNT(*) AS n ${q.from} WHERE ${q.where} GROUP BY lang ORDER BY n DESC LIMIT 10`, q.params);
	return { count: Number(r.n), langs: langs.map((l) => ({ lang: l.lang || "—", n: Number(l.n) })) };
}

/** Перевірка перед запуском */
async function checklist(b) {
	const problems = [];
	const m = b.message || {};
	const len = plainLen(cleanHtml(m.text));
	if (!len && !m.photo) problems.push("no_text");
	if (m.photo && len > 1024) problems.push("caption_long");
	if (!m.photo && len > 4096) problems.push("text_long");
	const btn = m.button || {};
	if (btn.text && btn.target === "product" && !btn.product) problems.push("no_product");
	if (btn.text && btn.target === "url" && !btn.url) problems.push("no_url");
	if (/\{promo\}/.test(m.text || "")) {
		if (!m.promo_template) problems.push("no_promo");
		else if (!(await promoLib().templates()).some((t) => Number(t.id) === Number(m.promo_template))) problems.push("promo_inactive");
	}
	if (b.date_scheduled && new Date(String(b.date_scheduled).replace(" ", "T") + "Z") < new Date(Date.now() - 60000)) problems.push("date_past");
	const { count: n } = await count(b.audience || {});
	if (!n) problems.push("audience_empty");
	return { ok: !problems.length, problems, count: n };
}

async function check(id) {
	return checklist(await get(id));
}

/** Запустити (зараз або на дату) */
async function launch(id, idUser) {
	const b = await get(id);
	if (!["draft", "failed"].includes(b.status)) throw httpErr(409, "modules.telegramshop.bc.e_locked");
	const ch = await checklist(b);
	if (!ch.ok) throw Object.assign(httpErr(409, "modules.telegramshop.bc.e_check"), { fields: ch.problems });
	await pool.query(`UPDATE ${T.broadcasts} SET status = 'scheduled', id_user_launched = ?, last_error = NULL, date_edit = NOW() WHERE id = ?`, [idUser || null, id]);
	kick();
	return get(id);
}
async function unschedule(id) {
	await pool.query(`UPDATE ${T.broadcasts} SET status = 'draft' WHERE id = ? AND status = 'scheduled'`, [id]);
	return get(id);
}
async function pause(id) {
	await pool.query(`UPDATE ${T.broadcasts} SET status = 'paused' WHERE id = ? AND status = 'sending'`, [id]);
	return get(id);
}
async function resume(id) {
	await pool.query(`UPDATE ${T.broadcasts} SET status = 'sending' WHERE id = ? AND status = 'paused'`, [id]);
	kick();
	return get(id);
}
async function cancel(id) {
	await pool.query(`UPDATE ${T.broadcasts} SET status = 'cancelled', date_finished = NOW() WHERE id = ? AND status IN ('scheduled','preparing','sending','paused')`, [id]);
	await pool.query(`UPDATE ${T.bmessages} SET status = 'cancelled' WHERE id_broadcast = ? AND status = 'queued'`, [id]);
	await recount([id]);
	return get(id);
}

// ── Повідомлення ──
function buttonFor(shop, b, idMessage) {
	const btn = b.message.button || {};
	if (!btn.text) return null;
	if (btn.target === "url") {
		const url = idMessage ? `${APP_URL}/api/module/telegramshop/r/${idMessage}/${sign(idMessage)}/` : btn.url;
		return { inline_keyboard: [[{ text: btn.text, url }]] };
	}
	const hash = btn.target === "cart" ? "cart" : btn.target === "product" && btn.product ? "product/" + btn.product : "";
	const url = appUrl(shop.slug) + (idMessage ? `?b=${idMessage}.${sign(idMessage)}` : "") + (hash ? "#" + hash : "");
	return { inline_keyboard: [[{ text: btn.text, web_app: { url } }]] };
}

const promoLib = () => require("../../../controllers/orders/promo");

const personal = (html, c, promo) =>
	String(html || "")
		.replace(/\{promo\}/g, promo ? `<code>${tg.html(promo)}</code>` : "")
		.replace(/\{first_name\}/g, tg.html(c.first_name || ""))
		.replace(/\{last_name\}/g, tg.html(c.last_name || ""))
		.replace(/\{username\}/g, tg.html(c.username ? "@" + c.username : ""));

/** Надіслати одне повідомлення розсилки */
async function deliver(shop, b, customer, idMessage) {
	const m = b.message;
	// Персональний промокод: видається один раз на адресата (повторна спроба — той самий код)
	let promo = customer.promo_code || null;
	if (!promo && m.promo_template && /\{promo\}/.test(m.text || "")) {
		promo = await promoLib().issue(m.promo_template, `tg:${shop.id}:${customer.tg_user_id}`);
		if (idMessage) await pool.query(`UPDATE ${T.bmessages} SET promo_code = ? WHERE id = ?`, [promo, idMessage]);
	}
	const text = cleanHtml(personal(m.text, customer, promo));
	const markup = buttonFor(shop, b, idMessage);
	const extra = { parse_mode: "HTML", ...(markup ? { reply_markup: markup } : {}) };
	if (m.photo) {
		const res = await tg.call(shop.token, "sendPhoto", { chat_id: customer.tg_user_id, photo: m.photo_file_id || m.photo, caption: text || undefined, ...extra });
		// Фото завантажили в Telegram один раз — далі за file_id (швидше, без повторного завантаження)
		if (!m.photo_file_id && res && Array.isArray(res.photo) && res.photo.length) {
			m.photo_file_id = res.photo[res.photo.length - 1].file_id;
			await pool.query(`UPDATE ${T.broadcasts} SET message = JSON_SET(message, '$.photo_file_id', ?) WHERE id = ?`, [m.photo_file_id, b.id]).catch(() => {});
		}
		return res;
	}
	return tg.call(shop.token, "sendMessage", { chat_id: customer.tg_user_id, text, disable_web_page_preview: true, ...extra });
}

/** Тест: одному покупцю магазину (за @username або id Telegram) */
async function sendTest(id, d) {
	const b = await get(id);
	const who = String(d.to || "").trim().replace(/^@/, "");
	if (!who) throw httpErr(400, "modules.telegramshop.bc.e_test_to");
	const shopsIds = b.audience.shops && b.audience.shops.length ? b.audience.shops : null;
	const [[c]] = await pool.query(
		`SELECT c.*, s.slug FROM ${T.customers} c JOIN ${T.shops} s ON s.id = c.id_shop
		  WHERE (c.username = ? OR c.tg_user_id = ?) ${shopsIds ? "AND c.id_shop IN (?)" : ""} AND c.is_blocked = 0 AND s.bot_id IS NOT NULL
		  ORDER BY c.last_seen_at DESC LIMIT 1`,
		[who, /^\d+$/.test(who) ? who : -1, ...(shopsIds ? [shopsIds] : [])]
	);
	if (!c) throw httpErr(404, "modules.telegramshop.bc.e_test_nobody");
	const shop = await require("./shops").bySlug(c.slug);
	try {
		await deliver(shop, b, c, null);
	} catch (e) {
		throw httpErr(502, "modules.telegramshop.bc.e_test_failed", { error: String(e.message).slice(0, 200) });
	}
	return { sent: true, to: c.username ? "@" + c.username : String(c.tg_user_id), shop: shop.name };
}

// ── Черга ──
/** Підготовка: адресати → черга (повторний запуск не дублює — унікальність broadcast+customer) */
async function fanOut(b) {
	await pool.query(`UPDATE ${T.broadcasts} SET status = 'preparing', date_launched = COALESCE(date_launched, NOW()) WHERE id = ? AND status = 'scheduled'`, [b.id]);
	const q = audienceSql(b.audience);
	await pool.query(
		`INSERT IGNORE INTO ${T.bmessages} (id_broadcast, id_shop, id_customer, tg_user_id, status, date_next_attempt)
		 SELECT ?, c.id_shop, c.id, c.tg_user_id, 'queued', NOW() ${q.from} WHERE ${q.where}`,
		[b.id, ...q.params]
	);
	const [[n]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.bmessages} WHERE id_broadcast = ?`, [b.id]);
	await pool.query(`UPDATE ${T.broadcasts} SET cnt_total = ?, status = IF(? = 0, 'sent', 'sending'), date_finished = IF(? = 0, NOW(), NULL) WHERE id = ? AND status = 'preparing'`, [
		n.n,
		n.n,
		n.n,
		b.id,
	]);
}

async function startDue() {
	const [rows] = await pool.query(`SELECT * FROM ${T.broadcasts} WHERE deleted = 0 AND status = 'scheduled' AND (date_scheduled IS NULL OR date_scheduled <= UTC_TIMESTAMP()) LIMIT 5`);
	for (const r of rows) {
		try {
			await fanOut(shape(r));
		} catch (e) {
			console.error("[telegramshop] broadcast fan-out:", e.message);
			await pool.query(`UPDATE ${T.broadcasts} SET status = 'failed', last_error = ? WHERE id = ?`, [String(e.message).slice(0, 1000), r.id]);
		}
	}
}

const pausedBots = new Map(); // id_shop → до коли пауза (429)
const cache = new Map(); // кеш розсилок і магазинів на один прохід

/** Прохід черги: кожен бот — до PER_SECOND повідомлень */
async function sendBatch() {
	const [shopsDue] = await pool.query(
		`SELECT DISTINCT m.id_shop FROM ${T.bmessages} m JOIN ${T.broadcasts} b ON b.id = m.id_broadcast AND b.status = 'sending'
		  WHERE m.status = 'queued' AND m.date_next_attempt <= NOW() LIMIT 50`
	);
	cache.clear();
	await Promise.all(
		shopsDue.map(async ({ id_shop }) => {
			if ((pausedBots.get(id_shop) || 0) > Date.now()) return;
			const [rows] = await pool.query(
				`SELECT m.*, c.first_name, c.last_name, c.username, m.promo_code FROM ${T.bmessages} m
				   JOIN ${T.broadcasts} b ON b.id = m.id_broadcast AND b.status = 'sending'
				   JOIN ${T.customers} c ON c.id = m.id_customer
				  WHERE m.id_shop = ? AND m.status = 'queued' AND m.date_next_attempt <= NOW() ORDER BY m.id LIMIT ?`,
				[id_shop, PER_SECOND]
			);
			if (!rows.length) return;
			const [[s]] = await pool.query(`SELECT slug FROM ${T.shops} WHERE id = ?`, [id_shop]);
			const shop = s ? await require("./shops").bySlug(s.slug) : null;
			for (const m of rows) {
				if (!shop || !shop.token) {
					await pool.query(`UPDATE ${T.bmessages} SET status = 'failed', error = 'bot_disconnected' WHERE id = ?`, [m.id]);
					continue;
				}
				if (!cache.has(m.id_broadcast)) cache.set(m.id_broadcast, await get(m.id_broadcast).catch(() => null));
				const b = cache.get(m.id_broadcast);
				if (!b || b.status !== "sending") continue;
				// Захоплення рядка: кілька процесів (pm2 cluster) не надішлють те саме двічі
				const [claim] = await pool.query(`UPDATE ${T.bmessages} SET date_next_attempt = NOW() + INTERVAL 2 MINUTE WHERE id = ? AND status = 'queued' AND date_next_attempt <= NOW()`, [m.id]);
				if (!claim.affectedRows) continue;
				const started = Date.now();
				try {
					await deliver(shop, b, m, m.id);
					await pool.query(`UPDATE ${T.bmessages} SET status = 'sent', date_sent = NOW(), attempts = attempts + 1, error = NULL WHERE id = ?`, [m.id]);
				} catch (e) {
					const code = e.code || 0;
					if (code === 429) {
						const wait = Math.max(1, Number(e.retry_after || (e.parameters && e.parameters.retry_after)) || 5);
						pausedBots.set(id_shop, Date.now() + wait * 1000);
						await pool.query(`UPDATE ${T.bmessages} SET date_next_attempt = NOW() + INTERVAL ? SECOND WHERE id = ?`, [wait, m.id]);
						return;
					}
					if (code === 403) {
						await pool.query(`UPDATE ${T.bmessages} SET status = 'blocked', attempts = attempts + 1, error = ? WHERE id = ?`, [String(e.message).slice(0, 255), m.id]);
						await pool.query(`UPDATE ${T.customers} SET is_blocked = 1 WHERE id = ?`, [m.id_customer]);
					} else {
						const fatal = code === 400 || m.attempts + 1 >= MAX_ATTEMPTS;
						await pool.query(`UPDATE ${T.bmessages} SET status = IF(?, 'failed', 'queued'), attempts = attempts + 1, error = ?, date_next_attempt = NOW() + INTERVAL 1 MINUTE WHERE id = ?`, [
							fatal ? 1 : 0,
							String(e.message).slice(0, 255),
							m.id,
						]);
					}
				}
				// Рівномірно в межах секунди
				const spent = Date.now() - started;
				if (spent < 1000 / PER_SECOND) await new Promise((r) => setTimeout(r, 1000 / PER_SECOND - spent));
			}
		})
	);
}

/** Лічильники й завершення */
async function recount(ids) {
	for (const id of ids) {
		await pool.query(
			`UPDATE ${T.broadcasts} b SET
			   cnt_sent = (SELECT COUNT(*) FROM ${T.bmessages} m WHERE m.id_broadcast = b.id AND m.status = 'sent'),
			   cnt_failed = (SELECT COUNT(*) FROM ${T.bmessages} m WHERE m.id_broadcast = b.id AND m.status = 'failed'),
			   cnt_blocked = (SELECT COUNT(*) FROM ${T.bmessages} m WHERE m.id_broadcast = b.id AND m.status = 'blocked'),
			   cnt_clicked = (SELECT COUNT(*) FROM ${T.bmessages} m WHERE m.id_broadcast = b.id AND m.date_clicked IS NOT NULL),
			   cnt_orders = (SELECT COUNT(DISTINCT o.id_order) FROM ${T.bmessages} m JOIN ${T.orders} o ON o.id_customer = m.id_customer
			                  WHERE m.id_broadcast = b.id AND m.status = 'sent' AND o.date_add BETWEEN m.date_sent AND m.date_sent + INTERVAL ${ATTRIBUTION_HOURS} HOUR),
			   sum_orders = COALESCE((SELECT SUM(x.total_base) FROM (SELECT DISTINCT od.id, od.total_base FROM ${T.bmessages} m JOIN ${T.orders} o ON o.id_customer = m.id_customer
			                  JOIN ${P}orders od ON od.id = o.id_order AND od.deleted_at IS NULL AND od.is_canceled = 0
			                  WHERE m.id_broadcast = ? AND m.status = 'sent' AND o.date_add BETWEEN m.date_sent AND m.date_sent + INTERVAL ${ATTRIBUTION_HOURS} HOUR) x), 0),
			   date_edit = date_edit
			 WHERE b.id = ?`,
			[id, id]
		);
	}
	await pool.query(
		`UPDATE ${T.broadcasts} b SET status = 'sent', date_finished = NOW()
		  WHERE b.status = 'sending' AND NOT EXISTS (SELECT 1 FROM ${T.bmessages} m WHERE m.id_broadcast = b.id AND m.status = 'queued')`
	);
}

async function refreshStats() {
	const [rows] = await pool.query(
		`SELECT id FROM ${T.broadcasts} WHERE deleted = 0 AND (status IN ('sending','paused') OR (status = 'sent' AND date_finished > NOW() - INTERVAL ${ATTRIBUTION_HOURS + 24} HOUR))`
	);
	await recount(rows.map((r) => r.id));
}

/** Перехід за кнопкою: з вітрини (?b=<id>.<sig>) або через посилання-перенаправлення */
async function click(token, tgUserId) {
	const m = /^(\d+)\.([a-f0-9]{16})$/.exec(String(token || ""));
	if (!m || sign(m[1]) !== m[2]) return false;
	const [r] = await pool.query(`UPDATE ${T.bmessages} SET date_clicked = COALESCE(date_clicked, NOW()) WHERE id = ? ${tgUserId ? "AND tg_user_id = ?" : ""}`, [
		Number(m[1]),
		...(tgUserId ? [tgUserId] : []),
	]);
	return r.affectedRows > 0;
}
async function redirect(id, sig) {
	if (sign(id) !== sig) return null;
	await click(`${id}.${sig}`, null);
	const [[r]] = await pool.query(`SELECT b.message FROM ${T.bmessages} m JOIN ${T.broadcasts} b ON b.id = m.id_broadcast WHERE m.id = ?`, [id]);
	const msg = json(r && r.message, {});
	return (msg.button && msg.button.url) || null;
}

/** Адресати розсилки (для звіту) */
async function recipients(id, q = {}) {
	const where = ["m.id_broadcast = ?"];
	const params = [id];
	if (["queued", "sent", "failed", "blocked", "cancelled"].includes(q.status)) {
		where.push("m.status = ?");
		params.push(q.status);
	}
	if (q.clicked) where.push("m.date_clicked IS NOT NULL");
	const [rows] = await pool.query(
		`SELECT m.id, m.status, m.error, m.date_sent, m.date_clicked, m.tg_user_id, m.promo_code, c.username, c.first_name, c.last_name, c.id_client, s.name AS shop
		   FROM ${T.bmessages} m JOIN ${T.customers} c ON c.id = m.id_customer JOIN ${T.shops} s ON s.id = m.id_shop
		  WHERE ${where.join(" AND ")} ORDER BY m.id LIMIT 1000`,
		params
	);
	return rows;
}

// ── Фоновий процес ──
let busy = false;
let timer = null;
async function loop() {
	if (busy) return;
	busy = true;
	try {
		await startDue();
		await sendBatch();
	} catch (e) {
		console.error("[telegramshop] broadcasts:", e.message);
	} finally {
		busy = false;
	}
}
function kick() {
	setImmediate(loop);
}
let statsTimer = null;
function start() {
	if (timer) return;
	// Скинути «завислу» підготовку після рестарту
	pool.query(`UPDATE ${T.broadcasts} SET status = 'scheduled' WHERE status = 'preparing'`).catch(() => {});
	timer = setInterval(loop, 1000);
	timer.unref();
	statsTimer = setInterval(() => refreshStats().catch((e) => console.error("[telegramshop] broadcast stats:", e.message)), 30 * 1000);
	statsTimer.unref();
}
function stop() {
	clearInterval(timer);
	clearInterval(statsTimer);
	timer = statsTimer = null;
}

const promoTemplates = () => promoLib().templates();

module.exports = { promoTemplates, SEGMENTS, TARGETS, list, get, save, copy, remove, count, check, launch, unschedule, pause, resume, cancel, sendTest, recipients, recount, click, redirect, start, stop, cleanHtml };