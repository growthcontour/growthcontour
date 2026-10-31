"use strict";

const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const prefix = config.get("configDatabase").prefix;
const notifications = require("../../controllers/notifications/index");
const logging = require("../../logging/logging");
const i18n = require("../../config/i18n/i18n");

const BATCH = 500;
const MAX_ATTEMPTS = 5;

async function tick() {
  try {
    const [rows] = await connection_pool.query(
      `SELECT q.id_event, q.id_user, q.kind, e.title, e.date_start, e.date_end, e.location
       FROM \`${prefix}calendar_reminder_queue\` q
       INNER JOIN \`${prefix}calendar_events\` e
               ON e.id = q.id_event AND e.active = 1 AND e.status <> 3
       INNER JOIN \`${prefix}calendar_event_users\` eu
               ON eu.id_event = q.id_event
              AND eu.id_user  = q.id_user
              AND eu.active   = 1
              AND eu.is_hidden = 0
       WHERE q.sent = 0
         AND q.date_fire <= NOW()
         AND q.date_fire >= DATE_SUB(NOW(), INTERVAL 1 DAY)
       ORDER BY q.date_fire
       LIMIT ?`,
      [BATCH]
    );

    if (!rows.length) return;

    const done = [];
    const failed = [];

    for (const r of rows) {
      const when = new Date(r.date_start).toLocaleTimeString("uk-UA", {
        hour: "2-digit",
        minute: "2-digit",
      });

      // kind 2 — подія починається зараз
      const head = r.kind === 2 ? i18n.__({ phrase: "index.calendar.notify.now", locale: "uk" }) + ": " : when + " — ";

      try {
        await notifications.notify({
          type: "reminder",
          audience: { user: r.id_user },
          channels: ["inapp"],
          payload: {
            title: r.title,
            message: r.location ? head + r.location : head.trim(),
            url: "/?event=" + r.id_event,
          },
          key: "cal:remind:" + r.id_event + ":u" + r.id_user + ":k" + r.kind,
          collapseKey: "cal:event:" + r.id_event + ":k" + r.kind,
          priority: r.kind === 2 ? 2 : 3,
          expiresAt: r.date_end,
        });

        done.push([r.id_event, r.id_user, r.kind]);
      } catch (err) {
        logging.error(err);
        failed.push([r.id_event, r.id_user, r.kind]);
      }
    }

    if (done.length) {
      await connection_pool.query(
        `UPDATE \`${prefix}calendar_reminder_queue\` SET sent = 1
         WHERE (id_event, id_user, kind) IN (${done.map(() => "(?,?,?)").join(",")})`,
        done.flat()
      );
    }

    // Невдалі — рахуємо спроби; після MAX_ATTEMPTS здаємось
    if (failed.length) {
      await connection_pool.query(
        `UPDATE \`${prefix}calendar_reminder_queue\`
         SET attempts = attempts + 1,
             sent = IF(attempts + 1 >= ${MAX_ATTEMPTS}, 1, 0)
         WHERE (id_event, id_user, kind) IN (${failed.map(() => "(?,?,?)").join(",")})`,
        failed.flat()
      );
    }
  } catch (error) {
    logging.error(error);
  }
}

async function cleanup() {
  try {
    // Прибираємо і відправлені, і прострочені (їх уже не надішлемо)
    const [res] = await connection_pool.query(
      `DELETE FROM \`${prefix}calendar_reminder_queue\`
       WHERE date_fire < DATE_SUB(NOW(), INTERVAL 1 DAY)
       LIMIT 10000`
    );

    if (res.affectedRows) {
      console.log("[calendar-reminder] очищено рядків:", res.affectedRows);
    }
  } catch (error) {
    logging.error(error);
  }
}

module.exports = { tick, cleanup };
