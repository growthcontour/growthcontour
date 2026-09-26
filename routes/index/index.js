const express = require("express");
const router = express.Router();

// Controllers
const authorizationControllers = require("../../controllers/authorization/authorization");
// END Controllers

// Database connection
const connection = require("../../config/database/database");
const connection_pool = require("../../config/database/connection_pool");
// END Database connection

// Logging
const logging = require("../../logging/logging");
// END Logging

// Configuration
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
// END Configuration

// Validator
const validator_calendar = require("../../validator/index/calendar");
// END Validator

// Notifications
const notifications = require("../../controllers/notifications/index");
// END Notifications

const { getIO } = require("../../controllers/socket/socket");

const p = configDatabase.prefix;
// ============================================================
// КОНСТАНТИ КАЛЕНДАРЯ
// ============================================================

const CAL_RANGE_FLOOR_DAYS = 60; // запас на довгі події (відпустки тощо)
const CAL_MAX_PARTICIPANTS = 100;
const CAL_MAX_EVENTS = 1000; // стеля вибірки на один діапазон

const CAL_STATUS = { planned: 1, done: 2, canceled: 3 };
const CAL_RESPONSE = { pending: 0, accepted: 1, declined: 2, maybe: 3 };

// ============================================================
// ДОПОМІЖНІ ФУНКЦІЇ
// ============================================================

// Мова інтерфейсу -> id_lang
function langId(req) {
  return req.getLocale() === "uk" ? 1 : 2;
}

// Унікальні id учасників; автор присутній завжди
function normalizeParticipants(rawIds, ownerId) {
  const set = new Set([ownerId]);
  if (Array.isArray(rawIds)) {
    for (const raw of rawIds) {
      const uid = parseInt(raw);
      if (Number.isInteger(uid) && uid > 0) set.add(uid);
    }
  }
  return Array.from(set).slice(0, CAL_MAX_PARTICIPANTS);
}

// Батчева вставка учасників (fan-out) — один INSERT на всіх
async function insertParticipants(conn, eventId, userIds, ownerId, ev, prevResponses) {
  if (!userIds.length) return;

  const rows = userIds.map((uid) => [uid, ev.date_start, eventId, ev.date_end, uid === ownerId ? 1 : 0, uid === ownerId ? CAL_RESPONSE.accepted : (prevResponses?.get(uid) ?? CAL_RESPONSE.pending), 0, 1]);

  await conn.query(
    `INSERT INTO \`${p}calendar_event_users\`
            (id_user, date_start, id_event, date_end, is_owner, response, is_hidden, active, date_add)
         VALUES ${rows.map(() => "(?,?,?,?,?,?,?,?,NOW())").join(",")}`,
    rows.flat()
  );
}

// Перебудова черги нагадувань для події
// kind 1 — попереднє (за reminder_minutes), kind 2 — у момент початку
async function rebuildReminders(conn, eventId, userIds, ev) {
  await conn.query(`DELETE FROM \`${p}calendar_reminder_queue\` WHERE id_event = ?`, [eventId]);

  if (ev.status === CAL_STATUS.canceled) return;

  // notify_scope = none -> нагадувань немає взагалі
  if (ev.notify_scope === CAL_NOTIFY.none) return;

  const startMs = Date.parse(ev.date_start);
  const now = Date.now();
  const rows = [];

  // Попереднє нагадування — тільки якщо обрано і момент ще не минув
  if (ev.reminder_minutes !== null && ev.reminder_minutes !== undefined && ev.reminder_minutes > 0) {
    const preMs = startMs - ev.reminder_minutes * 60000;
    if (preMs > now) {
      const pre = new Date(preMs);
      for (const uid of userIds) rows.push([eventId, uid, 1, pre]);
    }
  }

  // Нагадування в момент початку — завжди, якщо подія ще попереду
  if (startMs > now) {
    const start = new Date(startMs);
    for (const uid of userIds) rows.push([eventId, uid, 2, start]);
  }

  if (!rows.length) return;

  await conn.query(
    `INSERT INTO \`${p}calendar_reminder_queue\` (id_event, id_user, kind, date_fire, sent, attempts)
         VALUES ${rows.map(() => "(?,?,?,?,0,0)").join(",")}
     ON DUPLICATE KEY UPDATE date_fire = VALUES(date_fire), sent = 0, attempts = 0`,
    rows.flat()
  );
}

// ------------------------------------------------------------
// КОНСТАНТИ ВИДИМОСТІ
// ------------------------------------------------------------
const CAL_VISIBILITY = { private: 1, busy: 2, team: 3, company: 4 };
const CAL_NOTIFY = { none: 0, me: 1, participants: 2, team: 3, company: 4 };

// Максимум користувачів у company-розсилці за один раз
const CAL_NOTIFY_COMPANY_LIMIT = 5000;

// ------------------------------------------------------------
// Чи має право користувач на широку розсилку
// company-розсилка = сповіщення всім, тому лише для адміністраторів
// ------------------------------------------------------------
function canBroadcast(req) {
  return req.user?.permissions?.["users.list"]?.edit === true;
}

// Зрізаємо notify_scope до дозволеного рівня
function clampNotifyScope(req, scope) {
  if (scope >= CAL_NOTIFY.team && !canBroadcast(req)) {
    return CAL_NOTIFY.participants;
  }
  return scope;
}

// ------------------------------------------------------------
// Приведення рядка БД до формату FullCalendar
// isMine — чи є користувач учасником події
// ------------------------------------------------------------
function toCalendarEvent(e, isMine, req) {
  // Рівень busy для чужої події: показуємо лише факт зайнятості
  const masked = !isMine && e.visibility === CAL_VISIBILITY.busy;

  return {
    id: e.id,
    title: masked ? req.__("index.calendar.busy") : e.title,
    start: e.date_start,
    end: e.date_end,
    allDay: !!e.all_day,
    editable: !!e.is_owner,
    // Відсутність (відпустка) — фоновим шаром, не перекриває сітку
    display: e.is_absence && !isMine ? "background" : "auto",
    backgroundColor: masked ? "#adb5bd" : e.type_color || "#6c757d",
    borderColor: masked ? "#adb5bd" : e.type_color || "#6c757d",
    extendedProps: {
      status: e.status,
      priority: e.priority,
      location: masked ? null : e.location,
      description: masked ? null : e.description,
      is_shared: !!e.is_shared,
      participants_cnt: e.participants_cnt,
      is_owner: !!e.is_owner,
      is_mine: isMine,
      response: e.response !== undefined ? e.response : null,
      visibility: e.visibility,
      is_absence: !!e.is_absence,
      type_name: masked ? null : e.type_name,
      type_icon: masked ? "fa-solid fa-lock" : e.type_icon,
      id_event_type: e.id_event_type,
      owner_name: e.owner_name || null,
    },
  };
}

// ------------------------------------------------------------
// Кому надсилати сповіщення за notify_scope
// Повертає масив id користувачів
// ------------------------------------------------------------
async function resolveNotifyTargets(scope, userIds, authorId) {
  if (scope === CAL_NOTIFY.none) return [];
  if (scope === CAL_NOTIFY.me) return []; // автору не надсилаємо, у нього є нагадування

  if (scope === CAL_NOTIFY.participants) {
    return userIds.filter((uid) => uid !== authorId);
  }

  // team поки збігається з company (відділів немає)
  if (scope >= CAL_NOTIFY.team) {
    const [rows] = await connection_pool.query(`SELECT id FROM \`${p}users\` WHERE active = 1 AND id <> ? LIMIT ?`, [authorId, CAL_NOTIFY_COMPANY_LIMIT]);
    return rows.map((r) => r.id);
  }

  return [];
}

// ------------------------------------------------------------
// Сповіщення про подію
// kind: "invited" | "updated" | "deleted"
// ------------------------------------------------------------
async function notifyEventUsers(kind, eventId, targets, authorId, req, title, dateStart) {
  if (!targets.length) return;

  const authorName = req.user.last_name + " " + req.user.first_name;
  const locale = req.getLocale() === "uk" ? "uk-UA" : "en-US";

  let message = authorName;
  if (dateStart) {
    message +=
      " · " +
      new Date(dateStart).toLocaleString(locale, {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
  }

  const head = req.__("index.calendar.notify." + kind);
  const stamp = Date.now();

  // Порціями по 200 — щоб не покласти чергу тисячею паралельних викликів
  const CHUNK = 200;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const slice = targets.slice(i, i + CHUNK);

    await Promise.all(
      slice.map((uid) =>
        notifications
          .notify({
            type: "personal.calendar",
            audience: { user: uid },
            channels: ["inapp"],
            payload: {
              title: head + ": " + title,
              message: message,
              url: "/?event=" + eventId,
            },
            key: "cal:" + kind + ":" + eventId + ":u" + uid + ":" + stamp,
            collapseKey: "cal:event:" + eventId,
          })
          .catch((err) => console.error("notify calendar:", err.message))
      )
    );
  }
}

// ============================================================
// GET — СТОРІНКИ
// ============================================================

// ============================================================
// КАЛЕНДАР — ЧИТАННЯ
// ============================================================

// ------------------------------------------------------------
// Події у видимому діапазоні (FullCalendar)
// ------------------------------------------------------------
router.post("/api/calendar/events", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const lang = langId(req);

    const check = validator_calendar.range(req.body);
    if (!check.valid) {
      return res.status(400).json({ error: "Вкажіть діапазон", details: check.errors });
    }
    const { start, end, show_company, show_busy } = check.data;

    // Нижня межа обов'язкова: без неї range scan піде від початку часів
    const floor = new Date(Date.parse(start) - CAL_RANGE_FLOOR_DAYS * 86400000);

    // ── ДЖЕРЕЛО A: мої події (fan-out) ────────────────────────
    const mineQuery = connection_pool.query(
      `
      SELECT
          e.id, e.title, e.description, e.location,
          e.date_start, e.date_end, e.all_day,
          e.priority, e.status, e.is_shared, e.participants_cnt,
          e.visibility, e.id_event_type, e.id_user_creator,
          eu.is_owner, eu.response,
          et.icon       AS type_icon,
          et.color      AS type_color,
          et.is_absence AS is_absence,
          etl.name      AS type_name
      FROM \`${p}calendar_event_users\` eu
      INNER JOIN \`${p}calendar_events\` e
          ON e.id = eu.id_event AND e.active = 1
      LEFT JOIN \`${p}calendar_event_type\` et
          ON et.id = e.id_event_type
      LEFT JOIN \`${p}calendar_event_type_lang\` etl
          ON etl.id_event_type = e.id_event_type AND etl.id_lang = ?
      WHERE eu.id_user     = ?
        AND eu.date_start >= ?
        AND eu.date_start <  ?
        AND eu.date_end   >= ?
        AND eu.active      = 1
        AND eu.is_hidden   = 0
      ORDER BY eu.date_start ASC
      LIMIT ${CAL_MAX_EVENTS}
      `,
      [lang, userId, floor, end, start]
    );

    // ── ДЖЕРЕЛО B: видимі чужі події ──────────────────────────
    // Рівні: 4-company завжди, 2-busy — за налаштуванням користувача
    const levels = [];
    if (show_company) levels.push(CAL_VISIBILITY.company);
    if (show_busy) levels.push(CAL_VISIBILITY.busy);

    const othersQuery = levels.length
      ? connection_pool.query(
          `
      SELECT
          e.id, e.title, e.description, e.location,
          e.date_start, e.date_end, e.all_day,
          e.priority, e.status, e.is_shared, e.participants_cnt,
          e.visibility, e.id_event_type, e.id_user_creator,
          0 AS is_owner,
          et.icon       AS type_icon,
          et.color      AS type_color,
          et.is_absence AS is_absence,
          etl.name      AS type_name,
          CONCAT_WS(' ', u.last_name, u.first_name) AS owner_name
      FROM \`${p}calendar_events\` e
      LEFT JOIN \`${p}calendar_event_type\` et
          ON et.id = e.id_event_type
      LEFT JOIN \`${p}calendar_event_type_lang\` etl
          ON etl.id_event_type = e.id_event_type AND etl.id_lang = ?
      LEFT JOIN \`${p}users\` u
          ON u.id = e.id_user_creator
      WHERE e.visibility IN (${levels.map(() => "?").join(",")})
        AND e.active      = 1
        AND e.status     <> ${CAL_STATUS.canceled}
        AND e.date_start >= ?
        AND e.date_start <  ?
        AND e.date_end   >= ?
        AND e.id_user_creator <> ?
        AND e.id NOT IN (
            SELECT id_event FROM \`${p}calendar_hidden_events\` WHERE id_user = ?
        )
      ORDER BY e.date_start ASC
      LIMIT ${CAL_MAX_EVENTS}
      `,
          [lang, ...levels, floor, end, start, userId, userId]
        )
      : Promise.resolve([[]]);

    const [[mine], [others]] = await Promise.all([mineQuery, othersQuery]);

    // Мої події мають пріоритет: якщо я учасник company-події,
    // вона вже є в джерелі A з повними деталями
    const mineIds = new Set(mine.map((e) => e.id));

    const result = mine.map((e) => toCalendarEvent(e, true, req));

    for (const e of others) {
      if (!mineIds.has(e.id)) {
        result.push(toCalendarEvent(e, false, req));
      }
    }

    res.json(result);
  } catch (error) {
    console.error("calendar/events:", error);
    res.status(500).json({ error: "Server error" });
  }
});
// ------------------------------------------------------------
// Список подій для Tabulator
// ------------------------------------------------------------
router.post("/api/calendar/events/list", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const from = req.body.from || new Date();
    const limit = Math.min(parseInt(req.body.limit) || 200, 500);

    const [events] = await connection_pool.query(
      `
            SELECT
                e.id, e.title, e.description, e.location,
                e.date_start, e.date_end, e.all_day,
                e.priority, e.status, e.is_shared, e.participants_cnt,
                e.id_event_type, e.reminder_minutes, e.id_user_creator,
                eu.is_owner, eu.response,
                etl.name AS type_name,
                et.icon  AS type_icon,
                et.color AS type_color,
                CONCAT_WS(' ', uc.last_name, uc.first_name) AS creator_name
            FROM \`${p}calendar_event_users\` eu
            INNER JOIN \`${p}calendar_events\` e
                ON e.id = eu.id_event AND e.active = 1
            LEFT JOIN \`${p}calendar_event_type\` et
                ON et.id = e.id_event_type
            LEFT JOIN \`${p}calendar_event_type_lang\` etl
                ON etl.id_event_type = e.id_event_type AND etl.id_lang = ?
            LEFT JOIN \`${p}users\` uc
                ON uc.id = e.id_user_creator
            WHERE eu.id_user     = ?
              AND eu.date_start >= ?
              AND eu.active      = 1
              AND eu.is_hidden   = 0
            ORDER BY eu.date_start ASC
            LIMIT ?
        `,
      [langId(req), userId, from, limit]
    );

    res.json(events);
  } catch (error) {
    console.error("calendar/events/list:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------------------------------------------------
// Одна подія з учасниками
// ------------------------------------------------------------
router.post("/api/calendar/events/:eventId", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const eventId = parseInt(req.params.eventId);
    if (!eventId) return res.status(400).json({ error: "Bad request" });

    const [[event]] = await connection_pool.query(
      `
            SELECT
                e.*,
                etl.name AS type_name,
                et.icon  AS type_icon,
                et.color AS type_color,
                CONCAT_WS(' ', uc.last_name, uc.first_name) AS creator_name
            FROM \`${p}calendar_events\` e
            LEFT JOIN \`${p}calendar_event_type\` et
                ON et.id = e.id_event_type
            LEFT JOIN \`${p}calendar_event_type_lang\` etl
                ON etl.id_event_type = e.id_event_type AND etl.id_lang = ?
            LEFT JOIN \`${p}users\` uc
                ON uc.id = e.id_user_creator
            WHERE e.id = ? AND e.active = 1
            LIMIT 1
        `,
      [langId(req), eventId]
    );

    if (!event) return res.status(404).json({ error: "Not found" });

    const [participants] = await connection_pool.query(
      `
            SELECT
                eu.id_user, eu.is_owner, eu.response,
                CONCAT_WS(' ', u.last_name, u.first_name) AS user_name
            FROM \`${p}calendar_event_users\` eu
            LEFT JOIN \`${p}users\` u ON u.id = eu.id_user
            WHERE eu.id_event = ? AND eu.active = 1
            ORDER BY eu.is_owner DESC
        `,
      [eventId]
    );

    // Доступ мають лише учасники
    const me = participants.find((x) => x.id_user === userId);

    // Не учасник — доступ лише якщо подія видима
    if (!me) {
      if (event.visibility < CAL_VISIBILITY.busy) {
        return res.status(403).json({ error: "Немає доступу" });
      }

      // Рівень busy — віддаємо мінімум
      if (event.visibility === CAL_VISIBILITY.busy) {
        return res.json({
          id: event.id,
          title: req.__("index.calendar.busy"),
          date_start: event.date_start,
          date_end: event.date_end,
          all_day: event.all_day,
          is_owner: false,
          is_mine: false,
          readonly: true,
          masked: true,
        });
      }

      // Рівень company — повні деталі, але без редагування
      event.participants = [];
      event.participant_ids = [];
      event.is_owner = false;
      event.is_mine = false;
      event.readonly = true;
      return res.json(event);
    }

    event.participants = participants;
    event.participant_ids = participants.map((x) => x.id_user);
    event.is_owner = !!me.is_owner;
    event.is_mine = true;
    event.my_response = me.response;
    event.readonly = false;

    res.json(event);
  } catch (error) {
    console.error("calendar/events/:id:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
// КАЛЕНДАР — ЗАПИС
// ============================================================

// ------------------------------------------------------------
// Створити подію
// ------------------------------------------------------------
router.post("/api/calendar/events/add", authorizationControllers.isAuthenticated, async (req, res) => {
  const check = validator_calendar.event(req.body);
  if (!check.valid) {
    return res.status(400).json({ error: "Невірні дані", details: check.errors });
  }
  const ev = check.data;

  const conn = await connection_pool.getConnection();
  try {
    const userId = req.user.id;
    const userIds = normalizeParticipants(ev.participant_ids, userId);
    const isShared = userIds.length > 1 ? 1 : 0;

    await conn.beginTransaction();

    const [result] = await conn.query(
      `
            INSERT INTO \`${p}calendar_events\`
                (id_user_creator, id_event_type, title, description, location, location_url,
                 date_start, date_end, all_day, tz_offset,
                 priority, status, is_shared, visibility, notify_scope, is_busy,
                 participants_cnt, reminder_minutes, id_ref_type, id_ref,
                 active, date_add, date_edit)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NOW(),NOW())
        `,
      [userId, ev.id_event_type, ev.title, ev.description, ev.location, ev.location_url, ev.date_start, ev.date_end, ev.all_day, ev.tz_offset, ev.priority, ev.status, isShared, ev.visibility, ev.notify_scope, ev.is_busy, userIds.length, ev.reminder_minutes, ev.id_ref_type, ev.id_ref]
    );

    const eventId = result.insertId;

    await insertParticipants(conn, eventId, userIds, userId, ev, null);
    await rebuildReminders(conn, eventId, userIds, ev);

    await conn.commit();

    res.json({ ok: true, id: eventId });

    // Сповіщення — після відповіді, не блокуємо клієнта
    const targets = await resolveNotifyTargets(ev.notify_scope, userIds, userId);
    notifyEventUsers("invited", eventId, targets, userId, req, ev.title, ev.date_start);
  } catch (error) {
    await conn.rollback();
    console.error("calendar/events/add:", error);
    res.status(500).json({ error: "Server error" });
  } finally {
    conn.release();
  }
});

// ------------------------------------------------------------
// Редагувати подію (лише автор)
// ------------------------------------------------------------
router.post("/api/calendar/events/:eventId/edit", authorizationControllers.isAuthenticated, async (req, res) => {
  const eventId = parseInt(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Bad request" });

  const check = validator_calendar.event(req.body);
  if (!check.valid) {
    return res.status(400).json({ error: "Невірні дані", details: check.errors });
  }
  const ev = check.data;

  const conn = await connection_pool.getConnection();
  try {
    const userId = req.user.id;

    await conn.beginTransaction();

    const [[current]] = await conn.query(
      `SELECT id_user_creator FROM \`${p}calendar_events\`
             WHERE id = ? AND active = 1 FOR UPDATE`,
      [eventId]
    );
    if (!current) {
      await conn.rollback();
      return res.status(404).json({ error: "Not found" });
    }
    if (current.id_user_creator !== userId) {
      await conn.rollback();
      return res.status(403).json({ error: "Редагувати може лише автор" });
    }

    // Зберігаємо відповіді тих, хто залишиться в події
    const [oldRows] = await conn.query(`SELECT id_user, response FROM \`${p}calendar_event_users\` WHERE id_event = ?`, [eventId]);
    const prevResponses = new Map(oldRows.map((r) => [r.id_user, r.response]));

    const userIds = normalizeParticipants(ev.participant_ids, userId);
    const isShared = userIds.length > 1 ? 1 : 0;

    ev.notify_scope = clampNotifyScope(req, ev.notify_scope);

    await conn.query(
      `
            UPDATE \`${p}calendar_events\` SET
                id_event_type    = ?,
                title            = ?,
                description      = ?,
                location         = ?,
                location_url     = ?,
                date_start       = ?,
                date_end         = ?,
                all_day          = ?,
                tz_offset        = ?,
                priority         = ?,
                status           = ?,
                is_shared        = ?,
                visibility       = ?,
                notify_scope     = ?,
                is_busy          = ?,
                participants_cnt = ?,
                reminder_minutes = ?,
                date_edit        = NOW()
            WHERE id = ?
        `,
      [ev.id_event_type, ev.title, ev.description, ev.location, ev.location_url, ev.date_start, ev.date_end, ev.all_day, ev.tz_offset, ev.priority, ev.status, isShared, ev.visibility, ev.notify_scope, ev.is_busy, userIds.length, ev.reminder_minutes, eventId]
    );

    // date_start входить у PRIMARY KEY -> тільки DELETE + INSERT
    await conn.query(`DELETE FROM \`${p}calendar_event_users\` WHERE id_event = ?`, [eventId]);
    await insertParticipants(conn, eventId, userIds, userId, ev, prevResponses);
    await rebuildReminders(conn, eventId, userIds, ev);

    await conn.commit();

    res.json({ ok: true });

    // Нові учасники отримують запрошення, решта — повідомлення про зміну
    const oldIds = new Set(oldRows.map((r) => r.id_user));
    const fresh = userIds.filter((uid) => !oldIds.has(uid) && uid !== userId);

    if (fresh.length) {
      notifyEventUsers("invited", eventId, fresh, userId, req, ev.title, ev.date_start);
    }

    // Про зміну — усім за notify_scope, окрім щойно запрошених
    const freshSet = new Set(fresh);
    const targets = (await resolveNotifyTargets(ev.notify_scope, userIds, userId)).filter((uid) => !freshSet.has(uid));

    if (targets.length) {
      notifyEventUsers("updated", eventId, targets, userId, req, ev.title, ev.date_start);
    }
  } catch (error) {
    await conn.rollback();
    console.error("calendar/events/edit:", error);
    res.status(500).json({ error: "Server error" });
  } finally {
    conn.release();
  }
});

// ------------------------------------------------------------
// Перенесення / зміна тривалості (drag & drop, resize)
// ------------------------------------------------------------
router.post("/api/calendar/events/:eventId/reschedule", authorizationControllers.isAuthenticated, async (req, res) => {
  const eventId = parseInt(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Bad request" });

  const check = validator_calendar.reschedule(req.body);
  if (!check.valid) {
    return res.status(400).json({ error: "Невірні дані", details: check.errors });
  }
  const { date_start, date_end } = check.data;

  const conn = await connection_pool.getConnection();
  try {
    const userId = req.user.id;

    await conn.beginTransaction();

    const [[current]] = await conn.query(
      `SELECT id_user_creator, reminder_minutes, status, title, notify_scope
             FROM \`${p}calendar_events\`
             WHERE id = ? AND active = 1 FOR UPDATE`,
      [eventId]
    );
    if (!current) {
      await conn.rollback();
      return res.status(404).json({ error: "Not found" });
    }
    if (current.id_user_creator !== userId) {
      await conn.rollback();
      return res.status(403).json({ error: "Переносити може лише автор" });
    }

    await conn.query(
      `
            UPDATE \`${p}calendar_events\`
            SET date_start = ?, date_end = ?, date_edit = NOW()
            WHERE id = ?
        `,
      [date_start, date_end, eventId]
    );

    const [rows] = await conn.query(`SELECT id_user, response FROM \`${p}calendar_event_users\` WHERE id_event = ?`, [eventId]);
    const prevResponses = new Map(rows.map((r) => [r.id_user, r.response]));
    const userIds = rows.map((r) => r.id_user);

    const ev = {
      date_start,
      date_end,
      reminder_minutes: current.reminder_minutes,
      status: current.status,
      notify_scope: current.notify_scope,
    };

    await conn.query(`DELETE FROM \`${p}calendar_event_users\` WHERE id_event = ?`, [eventId]);
    await insertParticipants(conn, eventId, userIds, userId, ev, prevResponses);
    await rebuildReminders(conn, eventId, userIds, ev);

    await conn.commit();

    res.json({ ok: true });

    const targets = await resolveNotifyTargets(current.notify_scope, userIds, userId);
    notifyEventUsers("updated", eventId, targets, userId, req, current.title, date_start);
  } catch (error) {
    await conn.rollback();
    console.error("calendar/events/reschedule:", error);
    res.status(500).json({ error: "Server error" });
  } finally {
    conn.release();
  }
});

// ------------------------------------------------------------
// Видалити подію (soft delete, лише автор)
// ------------------------------------------------------------
router.post("/api/calendar/events/:eventId/delete", authorizationControllers.isAuthenticated, async (req, res) => {
  const eventId = parseInt(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Bad request" });

  const conn = await connection_pool.getConnection();
  try {
    const userId = req.user.id;

    await conn.beginTransaction();

    const [[current]] = await conn.query(
      `SELECT id_user_creator, title, notify_scope FROM \`${p}calendar_events\`
             WHERE id = ? AND active = 1 FOR UPDATE`,
      [eventId]
    );
    if (!current) {
      await conn.rollback();
      return res.status(404).json({ error: "Not found" });
    }
    if (current.id_user_creator !== userId) {
      await conn.rollback();
      return res.status(403).json({ error: "Видаляти може лише автор" });
    }

    const [rows] = await conn.query(`SELECT id_user FROM \`${p}calendar_event_users\` WHERE id_event = ?`, [eventId]);

    // Прибираємо приховування — подія зникає в усіх
    await conn.query(`DELETE FROM \`${p}calendar_hidden_events\` WHERE id_event = ?`, [eventId]);

    await conn.query(`UPDATE \`${p}calendar_events\` SET active = 0, date_edit = NOW() WHERE id = ?`, [eventId]);
    await conn.query(`UPDATE \`${p}calendar_event_users\` SET active = 0 WHERE id_event = ?`, [eventId]);
    await conn.query(`DELETE FROM \`${p}calendar_reminder_queue\` WHERE id_event = ?`, [eventId]);

    await conn.commit();

    res.json({ ok: true });

    const targets = await resolveNotifyTargets(
      current.notify_scope,
      rows.map((r) => r.id_user),
      userId
    );
    notifyEventUsers("deleted", eventId, targets, userId, req, current.title, null);
  } catch (error) {
    await conn.rollback();
    console.error("calendar/events/delete:", error);
    res.status(500).json({ error: "Server error" });
  } finally {
    conn.release();
  }
});

// ============================================================
// КАЛЕНДАР — УЧАСНИК
// ============================================================

// ------------------------------------------------------------
// Відповідь на запрошення
// ------------------------------------------------------------
router.post("/api/calendar/events/:eventId/respond", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const eventId = parseInt(req.params.eventId);
    if (!eventId) return res.status(400).json({ error: "Bad request" });

    const check = validator_calendar.respond(req.body);
    if (!check.valid) return res.status(400).json({ error: "Bad request" });
    const response = check.data.response;

    const [result] = await connection_pool.query(
      `
            UPDATE \`${p}calendar_event_users\`
            SET response = ?
            WHERE id_event = ? AND id_user = ? AND is_owner = 0 AND active = 1
        `,
      [response, eventId, userId]
    );

    if (!result.affectedRows) return res.status(404).json({ error: "Not found" });

    // Повідомляємо автора
    res.json({ ok: true, response });

    // Повідомляємо автора про відповідь
    const [[owner]] = await connection_pool.query(`SELECT id_user_creator, title FROM \`${p}calendar_events\` WHERE id = ? LIMIT 1`, [eventId]);

    if (owner && owner.id_user_creator !== userId) {
      const userName = req.user.last_name + " " + req.user.first_name;
      notifications
        .notify({
          type: "personal.calendar",
          audience: { user: owner.id_user_creator },
          channels: ["inapp"],
          payload: {
            title: owner.title,
            message: userName + " — " + req.__("index.calendar.response." + response),
            url: "/?event=" + eventId,
          },
          key: "cal:resp:" + eventId + ":u" + userId + ":" + response,
          collapseKey: "cal:event:" + eventId,
        })
        .catch((err) => console.error("notify calendar respond:", err.message));
    }
  } catch (error) {
    console.error("calendar/events/respond:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------------------------------------------------
// Приховати / повернути чужу подію у своєму календарі
// ------------------------------------------------------------
router.post("/api/calendar/events/:eventId/hide", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const eventId = parseInt(req.params.eventId);
    const hidden = req.body.hidden ? 1 : 0;
    if (!eventId) return res.status(400).json({ error: "Bad request" });

    // Спершу пробуємо як учасника
    const [asParticipant] = await connection_pool.query(
      `UPDATE \`${p}calendar_event_users\`
       SET is_hidden = ?
       WHERE id_event = ? AND id_user = ? AND is_owner = 0 AND active = 1`,
      [hidden, eventId, userId]
    );

    if (asParticipant.affectedRows) {
      // Приховав — прибираємо нагадування; повернув — черга перебудується
      // лише при наступному редагуванні події, тому ставимо назад вручну
      if (hidden) {
        await connection_pool.query(
          `UPDATE \`${p}calendar_reminder_queue\` SET sent = 1
           WHERE id_event = ? AND id_user = ?`,
          [eventId, userId]
        );
      }
      return res.json({ ok: true });
    }

    // Не учасник — значить бачить подію через видимість
    if (hidden) {
      await connection_pool.query(
        `INSERT IGNORE INTO \`${p}calendar_hidden_events\` (id_user, id_event, date_add)
         VALUES (?, ?, NOW())`,
        [userId, eventId]
      );
    } else {
      await connection_pool.query(`DELETE FROM \`${p}calendar_hidden_events\` WHERE id_user = ? AND id_event = ?`, [userId, eventId]);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("calendar/events/hide:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------------------------------------------------
// Лічильник запрошень без відповіді (бейдж у хедері)
// ------------------------------------------------------------
router.post("/api/calendar/pending-count", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const [[row]] = await connection_pool.query(
      `
            SELECT COUNT(*) AS cnt
            FROM \`${p}calendar_event_users\`
            WHERE id_user    = ?
              AND response   = 0
              AND date_start >= NOW()
              AND active     = 1
        `,
      [req.user.id]
    );

    res.json({ count: row.cnt });
  } catch (error) {
    console.error("calendar/pending-count:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
// КАЛЕНДАР — ДОВІДНИКИ
// ============================================================

// ------------------------------------------------------------
// Типи подій
// ------------------------------------------------------------
router.post("/api/calendar/event-types", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const [types] = await connection_pool.query(
      `
            SELECT t.id, t.code, t.color, t.icon,
              t.is_absence, t.default_visibility,
              tl.name
            FROM \`${p}calendar_event_type\` t
            LEFT JOIN \`${p}calendar_event_type_lang\` tl
                ON tl.id_event_type = t.id AND tl.id_lang = ?
            WHERE t.active = 1
            ORDER BY t.sort_order
        `,
      [langId(req)]
    );

    res.json(types);
  } catch (error) {
    console.error("calendar/event-types:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------------------------------------------------
// Пошук користувачів для селектора учасників
// ------------------------------------------------------------
router.post("/api/calendar/users/search", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const q = (req.body.q || "").trim();
    if (q.length < 2) return res.json([]);

    // Префіксний пошук — використовує індекс. '%q%' зробив би full scan.
    const like = `${q}%`;

    const [users] = await connection_pool.query(
      `
            SELECT
                id, first_name, last_name,
                CONCAT_WS(' ', last_name, first_name) AS user_name
            FROM \`${p}users\`
            WHERE active = 1
              AND (last_name LIKE ? OR first_name LIKE ?)
            ORDER BY last_name
            LIMIT 20
        `,
      [like, like]
    );

    res.json(users);
  } catch (error) {
    console.error("calendar/users/search:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------------------------------------------------
// Налаштування календаря користувача
// ------------------------------------------------------------
router.post("/api/calendar/settings", authorizationControllers.isAuthenticated, async (req, res) => {
  try {
    const [[settings]] = await connection_pool.query(`SELECT * FROM \`${p}calendar_user_settings\` WHERE id_user = ? LIMIT 1`, [req.user.id]);

    res.json(
      settings || {
        id_user: req.user.id,
        default_view: "dayGridMonth",
        first_day: 1,
        work_time_start: "09:00:00",
        work_time_end: "18:00:00",
        default_reminder: 30,
        notify_email: 1,
        notify_push: 1,
        auto_accept: 0,
        show_company: 1,
        show_busy: 0,
        default_visibility: 1,
      }
    );
  } catch (error) {
    console.error("calendar/settings:", error);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/api/calendar/settings/save", authorizationControllers.isAuthenticated, async (req, res) => {
  const check = validator_calendar.settings(req.body);
  if (!check.valid) {
    return res.status(400).json({ error: "Невірні дані", details: check.errors });
  }
  const s = check.data;

  try {
    await connection_pool.query(
      `INSERT INTO \`${p}calendar_user_settings\`
          (id_user, default_view, first_day,
           work_time_start, work_time_end, default_reminder,
           notify_email, notify_push, auto_accept,
           show_company, show_busy, default_visibility, date_edit)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE
          default_view       = VALUES(default_view),
          first_day          = VALUES(first_day),
          work_time_start    = VALUES(work_time_start),
          work_time_end      = VALUES(work_time_end),
          default_reminder   = VALUES(default_reminder),
          notify_email       = VALUES(notify_email),
          notify_push        = VALUES(notify_push),
          auto_accept        = VALUES(auto_accept),
          show_company       = VALUES(show_company),
          show_busy          = VALUES(show_busy),
          default_visibility = VALUES(default_visibility),
          date_edit          = NOW()`,
      [req.user.id, s.default_view, s.first_day, s.work_time_start, s.work_time_end, s.default_reminder, s.notify_email, s.notify_push, s.auto_accept, s.show_company, s.show_busy, s.default_visibility]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error("calendar/settings/save:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// END POST

module.exports = router;
