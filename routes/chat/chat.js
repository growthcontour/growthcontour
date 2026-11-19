"use strict";

/**
 * Чат компанії: сторінка /chat/?room=<код чату>, API /api/chat/..., файли /chat/files/<код файлу>.
 * Коди випадкові: з адреси не видно ні номер, ні кількість чатів чи файлів (доступ однаково перевіряється — лише учасникам).
 *
 * Права:
 *   chat               view — користуватися чатом; add — створювати групи й канали; edit — згадка @всі в будь-якому чаті;
 *                      delete — видаляти чужі повідомлення, закріплювати в автоматичних чатах
 *   chat.announcements add — писати в канал оголошень
 *   chat.analytics     view — сторінка аналітики чату (лише зведені цифри, без текстів)
 * Доступ до конкретного чату — лише учасникам (перевіряють контролери).
 */
const express = require("express");
const router = express.Router();
const { rateLimit } = require("express-rate-limit");

const auth = require("../../controllers/authorization/authorization");
const logging = require("../../logging/logging");
const rooms = require("../../controllers/chat/rooms");
const messages = require("../../controllers/chat/messages");
const files = require("../../controllers/chat/files");
const people = require("../../controllers/chat/people");
const schedule = require("../../controllers/chat/schedule");
const mentions = require("../../controllers/chat/mentions");
const notify = require("../../controllers/chat/notify");
const records = require("../../controllers/chat/records");
const interactive = require("../../controllers/chat/interactive");
const analytics = require("../../controllers/chat/analytics");
// Підписки каналів на події системи; підключає обробники подій замовлень при старті
const events = require("../../controllers/chat/events");
const { membership, canPost, canComment, httpErr } = require("../../controllers/chat/common");
const v = require("../../validator/chat/chat");

const can = (req, slug, action) => auth.hasPermission(req, slug, action);
const perms = (req) => ({ create: can(req, "chat", "add"), moderate: can(req, "chat", "delete"), mentionAll: can(req, "chat", "edit"), announce: can(req, "chat.announcements", "add") });
const me = (req) => Number(req.user.userId || req.user.id);

const id = (value) => {
	const n = parseInt(value, 10);
	if (!Number.isInteger(n) || n < 1 || String(n) !== String(value)) throw httpErr(404, "chat.errors.not_found");
	return n;
};
const valid = (res) => {
	if (!res.valid) throw httpErr(400, "chat.errors.validation", res.errors);
	return res.data;
};

const view = (req, res, next) => (can(req, "chat", "view") ? next() : res.status(403).json({ ok: false, error: req.__("chat.errors.forbidden") }));

const handle = (fn) => async (req, res) => {
	try {
		res.json({ ok: true, ...(await fn(req)) });
	} catch (e) {
		if (!e.status) logging.error("[chat]", e);
		res.status(e.status || 500).json({ ok: false, error: req.__(e.status ? e.message : "chat.errors.server"), errors: e.errors });
	}
};

// Надсилання: до 30 повідомлень за 10 с з однієї людини
const sendLimiter = rateLimit({
	windowMs: 10 * 1000,
	limit: 30,
	standardHeaders: true,
	legacyHeaders: false,
	keyGenerator: (req) => "chat:" + me(req),
	handler: (req, res) => res.status(429).json({ ok: false, error: req.__("chat.errors.too_fast") }),
});

// Реакції: до 30 за 10 с з однієї людини
const reactLimiter = rateLimit({
	windowMs: 10 * 1000,
	limit: 30,
	standardHeaders: true,
	legacyHeaders: false,
	keyGenerator: (req) => "chat-react:" + me(req),
	handler: (req, res) => res.status(429).json({ ok: false, error: req.__("chat.errors.too_fast") }),
});

const A = [auth.isAuthenticated, view];

// ═══ СТОРІНКА ═════════════════════════════════════════
router.get("/chat/", auth.isAuthenticated, (req, res) => {
	if (!can(req, "chat", "view")) return res.status(403).render("pages/error/404", { i18n: req, user: req.user });
	res.render("pages/chat/index", { i18n: req, user: req.user, header: { navbar: "chat", subnavbar: "" } });
});

/**
 * Налаштування й тексти для клієнта чату (/assets/js/chat/chat.js) — один запит на сторінку,
 * бо чат є і на сторінці /chat/, і в панелі справа, і в «Пульсі» на головній.
 * Часовий пояс і формати — людини (власні → офісу → мови інтерфейсу).
 */
router.post(
	"/api/chat/config/",
	...A,
	handle(async (req) => {
		const ctx = await require("../../controllers/company/people")
			.context(me(req))
			.catch(() => null);
		return {
			config: {
				me: me(req),
				perms: perms(req),
				limits: { body: v.MAX_BODY, files: v.MAX_FILES, size: files.MAX_SIZE, ext: Object.keys(files.ALLOWED), reactions: messages.MAX_REACTIONS, my_reactions: messages.MAX_MY_REACTIONS },
				timezone: (ctx && ctx.timezone) || null,
				locale: (ctx && ctx.locale) || null,
				hour12: ctx ? ctx.hour12 : null,
				lang: req.__("lang_iso"),
				urgent_per_day: notify.URGENT_PER_DAY,
				analytics: can(req, "chat.analytics", "view"),
			},
			texts: req.__("chat.ui"),
		};
	})
);

// ═══ АНАЛІТИКА ════════════════════════════════════════
const analyticsView = (req, res, next) => (can(req, "chat.analytics", "view") ? next() : res.status(403).json({ ok: false, error: req.__("chat.errors.forbidden") }));

// Сторінка: головні показники рендерить сервер, графіки й таблиці дозавантажуються за тим самим періодом
router.get("/chat/analytics/", auth.isAuthenticated, async (req, res) => {
	if (!can(req, "chat.analytics", "view")) return res.status(403).render("pages/error/404", { i18n: req, user: req.user });
	let data;
	try {
		// Неправильний період (задовгий, переплутані дати) — показуємо останні 30 днів
		data = await analytics.summary(req.query).catch((e) => (e.status ? analytics.summary({}) : Promise.reject(e)));
	} catch (e) {
		logging.error("[chat] analytics", e);
		return res.status(500).send(req.__("chat.errors.server"));
	}
	// Час подій на графіках — у поясі й форматі людини (профіль → офіс)
	const ctx = await require("../../controllers/company/people")
		.context(me(req))
		.catch(() => null);
	res.render("pages/chat/analytics", { i18n: req, user: req.user, header: { navbar: "chat", subnavbar: "" }, data, timezone: (ctx && ctx.timezone) || null, locale: (ctx && ctx.locale) || null });
});

router.post("/api/chat/analytics/hours/", auth.isAuthenticated, analyticsView, handle(async (req) => analytics.hours(req.body || {})));

router.post("/api/chat/analytics/rooms/", auth.isAuthenticated, analyticsView, handle(async (req) => analytics.rooms(req.body || {})));

router.post("/api/chat/analytics/people/", auth.isAuthenticated, analyticsView, handle(async (req) => analytics.people(req.body || {})));

// ═══ ЧАТИ ═════════════════════════════════════════════
router.post(
	"/api/chat/rooms/list/",
	...A,
	handle(async (req) => {
		const uid = me(req);
		const [list, total, status, th] = await Promise.all([rooms.list(uid), rooms.unreadTotal(uid), people.getStatus(uid), messages.threads(uid)]);
		return { rooms: list, unread_total: total, threads_unread: th.unread_total, me: { id: uid, status } };
	})
);

// Лічильник у шапці; quiet — «не турбувати» або неробочий час: сторінка не грає звук і не показує сповіщення (крім термінових)
router.post(
	"/api/chat/unread/",
	...A,
	handle(async (req) => {
		const uid = me(req);
		const [total, th, q] = await Promise.all([rooms.unreadTotal(uid), messages.threads(uid), notify.quiet(uid)]);
		return { total: total + th.unread_total, quiet: q.quiet, quiet_reason: q.reason };
	})
);

router.post("/api/chat/rooms/browse/", ...A, handle(async (req) => ({ rooms: await rooms.browse(me(req), (req.body || {}).q) })));

router.post("/api/chat/rooms/direct/", ...A, handle(async (req) => rooms.openDirect(me(req), id((req.body || {}).id_user))));

router.post("/api/chat/rooms/notes/", ...A, handle(async (req) => rooms.openNotes(me(req))));

router.post(
	"/api/chat/rooms/create/",
	...A,
	handle(async (req) => {
		if (!perms(req).create) throw httpErr(403, "chat.errors.forbidden");
		return rooms.create(me(req), valid(v.validateRoom((req.body || {}).data)));
	})
);

router.post("/api/chat/rooms/:id/get/", ...A, handle(async (req) => ({ room: await rooms.get(me(req), id(req.params.id), perms(req)) })));
// Адреса /chat/?room=<код> → чат (лише свій: чужий код — «не знайдено», як і неіснуючий)
router.post("/api/chat/rooms/resolve/", ...A, handle(async (req) => ({ id: await rooms.resolve(me(req), (req.body || {}).code) })));

router.post("/api/chat/rooms/:id/update/", ...A, handle(async (req) => rooms.update(me(req), id(req.params.id), valid(v.validateRoomEdit((req.body || {}).data)))));

router.post(
	"/api/chat/rooms/:id/members/add/",
	...A,
	handle(async (req) => {
		const list = Array.isArray((req.body || {}).users) ? req.body.users.slice(0, 1000).map(Number) : [];
		return rooms.addMembers(me(req), id(req.params.id), list);
	})
);

router.post("/api/chat/rooms/:id/members/:uid/remove/", ...A, handle(async (req) => rooms.removeMember(me(req), id(req.params.id), id(req.params.uid))));

router.post(
	"/api/chat/rooms/:id/members/:uid/role/",
	...A,
	handle(async (req) => {
		const role = (req.body || {}).role;
		if (role !== "admin" && role !== "member") throw httpErr(400, "chat.errors.validation", [{ field: "role", message: "invalid" }]);
		return rooms.setRole(me(req), id(req.params.id), id(req.params.uid), role);
	})
);

router.post("/api/chat/rooms/:id/leave/", ...A, handle(async (req) => rooms.removeMember(me(req), id(req.params.id), me(req))));

router.post("/api/chat/rooms/:id/join/", ...A, handle(async (req) => rooms.join(me(req), id(req.params.id))));

router.post("/api/chat/rooms/:id/settings/", ...A, handle(async (req) => rooms.settings(me(req), id(req.params.id), valid(v.validateSettings((req.body || {}).data)))));

router.post("/api/chat/rooms/:id/archive/", ...A, handle(async (req) => rooms.archive(me(req), id(req.params.id), !!(req.body || {}).value)));

// ═══ ПОВІДОМЛЕННЯ ═════════════════════════════════════
const optId = (value) => (value == null || value === "" ? null : id(value));

router.post(
	"/api/chat/rooms/:id/messages/",
	...A,
	handle(async (req) => {
		const b = req.body || {};
		return messages.history(me(req), id(req.params.id), { before: optId(b.before), after: optId(b.after), around: optId(b.around), limit: b.limit });
	})
);

// Надіслати зараз або (send_at) запланувати
router.post(
	"/api/chat/rooms/:id/send/",
	...A,
	sendLimiter,
	handle(async (req) => {
		const d = valid(v.validateMessage((req.body || {}).data));
		if (d.send_at) return schedule.create(me(req), id(req.params.id), d, perms(req));
		return { message: await messages.send(me(req), id(req.params.id), d, perms(req)) };
	})
);

router.post("/api/chat/rooms/:id/mentions/", ...A, handle(async (req) => mentions.suggestions(await membership(id(req.params.id), me(req)), me(req), perms(req))));

router.post("/api/chat/rooms/:id/pins/", ...A, handle(async (req) => messages.pins(me(req), id(req.params.id))));

// Заплановані: причину невдачі (ключ перекладу) перекладаємо мовою людини
const scheduledFor = async (req, idRoom) => {
	const r = await schedule.list(me(req), idRoom);
	r.scheduled.forEach((s) => (s.error_text = s.error ? req.__(s.error) : null));
	return r;
};

router.post("/api/chat/rooms/:id/scheduled/", ...A, handle(async (req) => scheduledFor(req, id(req.params.id))));

router.post("/api/chat/rooms/:id/read/", ...A, handle(async (req) => messages.read(me(req), id(req.params.id), id((req.body || {}).id_message))));

router.post("/api/chat/rooms/:id/draft/", ...A, handle(async (req) => messages.draft(me(req), id(req.params.id), (req.body || {}).text)));

router.post(
	"/api/chat/messages/:id/edit/",
	...A,
	handle(async (req) => {
		const d = valid(v.validateMessage({ body: (req.body || {}).body, files: [] }));
		return { message: await messages.edit(me(req), id(req.params.id), d.body, perms(req)) };
	})
);

router.post("/api/chat/messages/:id/delete/", ...A, handle(async (req) => ({ message: await messages.remove(me(req), id(req.params.id), perms(req)) })));

router.post(
	"/api/chat/messages/:id/forward/",
	...A,
	sendLimiter,
	handle(async (req) => {
		const b = req.body || {};
		const targets = Array.isArray(b.rooms) ? b.rooms.map((x) => id(x)) : [];
		if (!targets.length) throw httpErr(400, "chat.errors.validation", [{ field: "rooms", message: "empty" }]);
		const comment = typeof b.comment === "string" && b.comment.trim() ? valid(v.validateMessage({ body: b.comment, files: [] })).body : null;
		return { messages: await messages.forward(me(req), id(req.params.id), targets, comment, perms(req)) };
	})
);

router.post("/api/chat/messages/:id/readers/", ...A, handle(async (req) => messages.readers(me(req), id(req.params.id), Number((req.body || {}).after) || 0)));

router.post("/api/chat/messages/:id/react/", ...A, reactLimiter, handle(async (req) => messages.react(me(req), id(req.params.id), (req.body || {}).emoji)));

router.post("/api/chat/messages/:id/pin/", ...A, handle(async (req) => messages.pin(me(req), id(req.params.id), !!(req.body || {}).value, perms(req))));

router.post(
	"/api/chat/messages/:id/remind/",
	...A,
	handle(async (req) => {
		const d = valid(v.validateReminder(req.body || {}));
		return schedule.remind(me(req), id(req.params.id), d.remind_at, d.note, d.if_no_reply);
	})
);

// Задача з повідомлення (у календар виконавця)
router.post("/api/chat/messages/:id/task/", ...A, handle(async (req) => messages.task(me(req), id(req.params.id), valid(v.validateTask(req.body || {})))));

// Задача з чату без повідомлення (команда /task)
router.post("/api/chat/rooms/:id/task/", ...A, handle(async (req) => messages.task(me(req), null, valid(v.validateTask(req.body || {})), id(req.params.id))));

// ═══ ОПИТУВАННЯ, ЧЕКЛІСТИ, ПІДТВЕРДЖЕННЯ, РІШЕННЯ ════
router.post("/api/chat/messages/:id/vote/", ...A, handle(async (req) => interactive.vote(me(req), id(req.params.id), (req.body || {}).options)));

router.post("/api/chat/messages/:id/poll/close/", ...A, handle(async (req) => interactive.closePoll(me(req), id(req.params.id), perms(req))));

router.post("/api/chat/messages/:id/check/", ...A, handle(async (req) => interactive.check(me(req), id(req.params.id), id((req.body || {}).id_item), !!(req.body || {}).done)));

router.post("/api/chat/messages/:id/ack/", ...A, handle(async (req) => interactive.ack(me(req), id(req.params.id))));

router.post("/api/chat/messages/:id/acks/", ...A, handle(async (req) => interactive.acks(me(req), id(req.params.id))));

router.post(
	"/api/chat/messages/:id/decision/",
	...A,
	handle(async (req) => {
		const b = req.body || {};
		const note = typeof b.note === "string" ? b.note.trim().slice(0, 500) : null;
		return interactive.decide(me(req), id(req.params.id), !!b.value, note || null, perms(req));
	})
);

router.post("/api/chat/rooms/:id/decisions/", ...A, handle(async (req) => interactive.decisions(me(req), id(req.params.id))));

// «Поки вас не було»: що в непрочитаному
router.post("/api/chat/rooms/:id/catchup/", ...A, handle(async (req) => interactive.catchup(me(req), id(req.params.id))));

// ═══ ЗАПИСИ СИСТЕМИ: картки й «обговорити з колегою» ═
router.post("/api/chat/records/search/", ...A, handle(async (req) => ({ records: await records.search(me(req), (req.body || {}).q, req.user.id_lang || 1) })));

/**
 * Поділитися записом: у вибрані чати й особисті чати з людьми — повідомлення з карткою (і коментарем).
 * Поділитися можна лише записом, який людина бачить сама.
 */
router.post(
	"/api/chat/share/",
	...A,
	sendLimiter,
	handle(async (req) => {
		const b = req.body || {};
		const d = valid(v.validateMessage({ body: typeof b.comment === "string" ? b.comment : null, records: b.records, files: [] }));
		if (!d.records.length) throw httpErr(400, "chat.errors.validation", [{ field: "records", message: "empty" }]);
		const roomIds = new Set((Array.isArray(b.rooms) ? b.rooms : []).slice(0, 20).map((x) => id(x)));
		for (const u of (Array.isArray(b.users) ? b.users : []).slice(0, 20)) roomIds.add((await rooms.openDirect(me(req), id(u))).id);
		if (!roomIds.size) throw httpErr(400, "chat.errors.validation", [{ field: "rooms", message: "empty" }]);
		const sent = [];
		for (const idRoom of roomIds) sent.push(await messages.send(me(req), idRoom, Object.assign({}, d, { client_id: null }), perms(req)));
		return { messages: sent.map((m) => ({ id: m.id, id_room: m.id_room })) };
	})
);

// ═══ ПОДІЇ СИСТЕМИ В КАНАЛАХ ══════════════════════════
router.post("/api/chat/rooms/:id/subscriptions/", ...A, handle(async (req) => events.list(me(req), id(req.params.id), perms(req))));

router.post(
	"/api/chat/rooms/:id/subscriptions/save/",
	...A,
	handle(async (req) => {
		const d = valid(v.validateSubscription(req.body || {}));
		return events.save(me(req), id(req.params.id), d.source, d.events, perms(req));
	})
);

// ═══ ТРЕДИ ════════════════════════════════════════════
router.post("/api/chat/threads/", ...A, handle(async (req) => messages.threads(me(req))));

router.post("/api/chat/threads/:id/", ...A, handle(async (req) => messages.thread(me(req), id(req.params.id), { before: Number((req.body || {}).before) || null })));

router.post("/api/chat/threads/:id/read/", ...A, handle(async (req) => messages.threadRead(me(req), id(req.params.id), id((req.body || {}).id_message))));

router.post("/api/chat/threads/:id/follow/", ...A, handle(async (req) => messages.follow(me(req), id(req.params.id), !!(req.body || {}).value)));

// ═══ ЗАПЛАНОВАНІ Й НАГАДУВАННЯ ════════════════════════
router.post("/api/chat/scheduled/", ...A, handle(async (req) => scheduledFor(req, null)));

router.post("/api/chat/scheduled/:id/cancel/", ...A, handle(async (req) => schedule.cancel(me(req), id(req.params.id))));

router.post("/api/chat/scheduled/:id/send-now/", ...A, sendLimiter, handle(async (req) => schedule.sendNow(me(req), id(req.params.id))));

router.post(
	"/api/chat/scheduled/:id/reschedule/",
	...A,
	handle(async (req) => {
		const at = (req.body || {}).send_at;
		if (!v.isIso(at)) throw httpErr(400, "chat.errors.validation", [{ field: "send_at", message: "invalid" }]);
		return schedule.reschedule(me(req), id(req.params.id), at);
	})
);

router.post("/api/chat/reminders/", ...A, handle(async (req) => schedule.reminders(me(req))));

router.post("/api/chat/reminders/:id/cancel/", ...A, handle(async (req) => schedule.cancelReminder(me(req), id(req.params.id))));

router.post("/api/chat/search/", ...A, handle(async (req) => messages.search(me(req), valid(v.validateSearch(req.body || {})))));

// ═══ ФАЙЛИ ════════════════════════════════════════════
router.post(
	"/api/chat/rooms/:id/upload/",
	...A,
	sendLimiter,
	// Спершу — чи людина в чаті й може писати, і лише потім приймаємо файл
	async (req, res, next) => {
		try {
			const m = await membership(id(req.params.id), me(req));
			// Файли до відповіді в треді каналу оголошень теж можна (надсилання все одно перевіряє право)
			if (!canPost(m, perms(req)) && !canComment(m)) throw httpErr(403, "chat.errors.cannot_post");
			// Розмір із заголовка — ще до прийому файлу (точний розмір перевіряє multer)
			const length = Number(req.headers["content-length"] || 0);
			if (length > files.MAX_SIZE + 64 * 1024) throw httpErr(413, "chat.errors.file_too_big");
			next();
		} catch (e) {
			res.status(e.status || 500).json({ ok: false, error: req.__(e.status ? e.message : "chat.errors.server") });
		}
	},
	(req, res, next) =>
		files.upload(req, res, (err) => {
			if (!err) return next();
			const tooBig = err.code === "LIMIT_FILE_SIZE";
			res.status(tooBig ? 413 : err.status || 400).json({ ok: false, error: req.__(tooBig ? "chat.errors.file_too_big" : err.status ? err.message : "chat.errors.upload") });
		}),
	async (req, res) => {
		try {
			if (!req.file) throw httpErr(400, "chat.errors.upload");
			res.json({ ok: true, file: await files.register(me(req), id(req.params.id), req.file, { asFile: (req.body || {}).as_file === "1" }) });
		} catch (e) {
			files.discard(req.file);
			if (!e.status) logging.error("[chat] upload", e);
			res.status(e.status || 500).json({ ok: false, error: req.__(e.status ? e.message : "chat.errors.server") });
		}
	}
);

router.post("/api/chat/rooms/:id/files/", ...A, handle(async (req) => files.listRoom(me(req), id(req.params.id), { kind: (req.body || {}).kind, before: optId((req.body || {}).before) })));

router.get("/chat/files/:code", auth.isAuthenticated, async (req, res) => {
	try {
		if (!can(req, "chat", "view")) throw httpErr(404, "chat.errors.not_found");
		await files.serve(me(req), String(req.params.code), res, { download: req.query.download === "1" });
	} catch (e) {
		if (!e.status) logging.error("[chat] file", e);
		if (!res.headersSent) res.status(e.status || 500).end();
	}
});

// ═══ ЛЮДИ Й СТАТУС ════════════════════════════════════
router.post("/api/chat/people/", ...A, handle(async (req) => ({ people: await people.directory(me(req), (req.body || {}).q) })));

router.post("/api/chat/status/", ...A, handle(async (req) => ({ status: await people.getStatus(me(req)) })));

// Статус — лише зі стандартного переліку, без власного тексту
router.post(
	"/api/chat/status/save/",
	...A,
	handle(async (req) => {
		const d = valid(v.validateStatus((req.body || {}).data));
		d.text = null;
		return { status: await people.setStatus(me(req), d) };
	})
);

// ═══ ФОНОВІ ЗАВДАННЯ ══════════════════════════════════
rooms.startAutoSync();
setInterval(() => files.cleanupOrphans().catch((e) => logging.error("[chat] orphans", e)), 60 * 60 * 1000).unref();
setInterval(() => people.expireStatuses().catch((e) => logging.error("[chat] statuses", e)), 60 * 1000).unref();
// Раз на хвилину: повтори термінових, відкладені повідомлення, нагадування. Наступний запуск — лише після завершення попереднього
let ticking = false;
setInterval(async () => {
	if (ticking) return;
	ticking = true;
	try {
		await notify.urgentTick().catch((e) => logging.error("[chat] urgent", e));
		await schedule.sendDue().catch((e) => logging.error("[chat] scheduled", e));
		await schedule.remindDue().catch((e) => logging.error("[chat] reminders", e));
		await interactive.closeDue().catch((e) => logging.error("[chat] polls", e));
	} finally {
		ticking = false;
	}
}, 60 * 1000).unref();

module.exports = router;