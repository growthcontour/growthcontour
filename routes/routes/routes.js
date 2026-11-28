"use strict";

const express = require("express");
const router = express.Router();

// ─── Контролери ──────────────────────────────────────────────────────────────
const authorizationControllers = require("../../controllers/authorization/authorization");

// ─── Логування ───────────────────────────────────────────────────────────────
const logging = require("../../logging/logging");

// ─── База ─────────────────────────────────────────────────────────────────────
const pool = require("../../config/database/connection_pool");
const P = require("../../config/config").get("configDatabase").prefix;

// ─── Socket.io ───────────────────────────────────────────────────────────────
const notifications = require("../../controllers/notifications/index");
const { getIO } = require("../../controllers/socket/socket");

// ── СИМУЛЯТОР: кожні 5с реальна подія через notify(). Прибрати в проді. ──
/*let simN = 0;
setInterval(async () => {
  console.log("123");
  simN++;
  try {
    await notifications.notify({
      type: "personal",
      audience: { user: 1 }, // id залогіненого юзера
      channels: ["inapp"],
      collapseKey: `sim:${simN}`,
      payload: {
        title: `Тест #${simN}`,
        message: `Симульоване о ${new Date().toLocaleTimeString()}`,
        url: "#",
        ts: Date.now(), // унікальність → не дедуплікується
      },
    });
  } catch (error) {
    logging.error(error);
  }
}, 5000);*/

// ─── GET / ───────────────────────────────────────────────────────────────────
// Головна: привітання з показниками дня, "Мій день", "Пульс компанії", непрочитане в чаті.
// Усе потрібне для першого показу рахується тут, щоб сторінка не "стрибала" після завантаження.
router.get("/", authorizationControllers.isAuthenticated, async (req, res) => {
  const uid = Number(req.user.userId);
  const can = (s, a = "view") => req.user.permissions?.[s]?.[a] === true;
  const home = { name: "", timezone: null, myDay: [], overdue: 0, today: 0, chat: null };
  try {
    const [[u]] = await pool.query(
      `SELECT u.first_name, COALESCE(u.timezone, o.timezone) AS timezone
         FROM \`${P}users\` u LEFT JOIN \`${P}company_offices\` o ON o.id = u.id_office WHERE u.id = ?`,
      [uid]
    );
    home.name = (u && u.first_name) || "";
    home.timezone = (u && u.timezone) || null;
  } catch (e) {
    logging.error("[home] user", e);
  }
  const tz = validTz(home.timezone);
  try {
    home.myDay = await require("../../controllers/calendar/links").myDay(uid, Number(req.user.id_lang) || 1, 30);
    const todayKey = dayKey(new Date(), tz);
    for (const e of home.myDay) {
      const k = dayKey(new Date(e.date_start), tz);
      e.overdue = e.all_day ? k < todayKey : new Date(e.date_start) < new Date();
      e.past_day = k < todayKey;
      if (e.overdue) home.overdue++;
      else home.today++;
    }
  } catch (e) {
    logging.error("[home] my day", e);
  }
  if (can("chat")) {
    try {
      const rooms = require("../../controllers/chat/rooms");
      const [list, total] = await Promise.all([rooms.list(uid), rooms.unreadTotal(uid)]);
      home.chat = {
        total,
        mentions: list.reduce((s, r) => s + (r.mentions || 0), 0),
        rooms: list.filter((r) => r.unread > 0).slice(0, 8),
      };
    } catch (e) {
      logging.error("[home] chat", e);
      home.chat = { total: 0, mentions: 0, rooms: [] };
    }
  }
  // Готові підписи для шаблону (час, дати, назви чатів) — у поясі користувача й мові інтерфейсу
  const loc = req.__("lang_iso");
  const fmt = (opts) => new Intl.DateTimeFormat(loc, Object.assign({ timeZone: tz }, opts));
  const fTime = fmt({ hour: "2-digit", minute: "2-digit" });
  const fShort = fmt({ day: "2-digit", month: "2-digit" });
  const fChat = fmt({ hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
  home.date_label = fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
  for (const e of home.myDay) {
    const time = e.all_day ? req.__("index.home.all_day") : fTime.format(new Date(e.date_start));
    e.time_label = e.past_day ? fShort.format(new Date(e.date_start)) + (e.all_day ? "" : " " + time) : time;
    e.links = (e.links || []).map((l) => ({ ...l, url: LINK_URL[l.type] ? LINK_URL[l.type] + l.id + "/" : null, icon: LINK_ICON[l.type] || "fa-link", label: l.name || "#" + l.id }));
  }
  if (home.chat) {
    home.chat.rooms = home.chat.rooms.map((r) => ({
      code: r.code,
      unread: r.unread > 99 ? "99+" : String(r.unread),
      name: r.type === "direct" ? (r.partner && r.partner.name) || "—" : r.type === "notes" ? req.__("header.chat.notes") : r.kind === "announcements" ? req.__("header.chat.announcements") : r.name || "—",
      last: (r.last ? (r.last.author && Number(r.last.id_user) !== uid && r.type !== "direct" ? r.last.author + ": " : "") + (r.last.body ? String(r.last.body).replace(/\s+/g, " ") : r.last.has_files ? "📎" : "") : "").slice(0, 140),
      time: r.last ? fChat.format(new Date(r.last.date)) : "",
    }));
    home.chat.total_label = home.chat.total > 99 ? "99+" : String(home.chat.total);
  }
  // Аналітика за 30 днів (з кешу аналітики): показники, динаміка, ТОП-5 товарів. Повна — на /analytics/
  if (can("analytics")) home.analytics = await homeAnalytics(req, loc).catch((e) => (logging.error("[home] analytics", e), null));
  // Привітання за часом доби користувача (його часовий пояс або офісу)
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(new Date()));
  home.part = hour < 5 ? "night" : hour < 12 ? "morning" : hour < 18 ? "day" : "evening";
  home.tz = tz;
  res.render("pages/index/index", {
    i18n: req,
    user: req.user,
    header: { navbar: "home" },
    home,
  });
});

/**
 * Короткий звіт продажів на головній: ті самі розділи кешу, що й сторінка /analytics/ (фільтр за замовчуванням — 30 днів,
 * усі сайти), тож відкриття головної не навантажує базу. Суми — у базовій валюті системи.
 */
async function homeAnalytics(req, loc) {
  const cache = require("../../controllers/analytics/cache");
  const lang = Number(req.user.id_lang) || 1;
  const [sum, top, ts, all] = await Promise.all([
    cache.get("summary", {}, { lang }),
    cache.get("top_products", {}, { lang }),
    cache.get("timeseries", {}, { lang }),
    require("../../controllers/catalog/products/settings").getAll(),
  ]);
  const base = (all.prices && all.prices.base_currency) || null;
  let money;
  try {
    if (!base) throw new Error("no base currency");
    money = new Intl.NumberFormat(loc, { style: "currency", currency: base, maximumFractionDigits: 0 });
  } catch (e) {
    money = new Intl.NumberFormat(loc, { maximumFractionDigits: 0 });
  }
  const num = new Intl.NumberFormat(loc, { maximumFractionDigits: 0 });
  const pct = new Intl.NumberFormat(loc, { maximumFractionDigits: 1, signDisplay: "exceptZero" });
  const s = sum.data;
  const kpi = (key, value, isMoney) => {
    const d = Number(s.delta[key]) || 0;
    return { key, value: isMoney ? money.format(Number(value) || 0) : num.format(Number(value) || 0), delta: pct.format(d) + "%", trend: d > 0 ? "up" : d < 0 ? "down" : "flat" };
  };
  const series = (ts.data.series || []).reduce((m, x) => ((m[x.metric] = x.data), m), {});
  const day = new Intl.DateTimeFormat(loc, { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const dayLong = new Intl.DateTimeFormat(loc, { day: "numeric", month: "long", timeZone: "UTC" });
  return {
    currency: base,
    period: { from: dayLong.format(new Date(s.period.date_from + "T00:00:00Z")), to: dayLong.format(new Date(s.period.date_to + "T00:00:00Z")) },
    kpi: [kpi("revenue", s.current.revenue, true), kpi("orders_valid", s.current.orders_valid), kpi("avg_check", s.current.avg_check, true), kpi("net_revenue", s.current.net_revenue, true)],
    top: (top.data.revenue || []).slice(0, 5).map((r) => ({ name: r.name || r.sku || "—", sku: r.sku, qty: num.format(r.qty), revenue: money.format(r.revenue) })),
    // Дані графіка — в атрибуті розмітки (ECharts малює їх без додаткового запиту)
    chart: JSON.stringify({
      x: (ts.data.xAxis || []).map((d) => day.format(new Date(d + "T00:00:00Z"))),
      revenue: series.revenue || [],
      orders: series.orders || [],
      names: { revenue: req.__("index.analytics.revenue"), orders: req.__("index.analytics.orders") },
      currency: base,
      locale: loc,
    }),
    any: (Number(s.current.orders_valid) || 0) > 0 || (series.orders || []).some((v) => v > 0),
  };
}

/** IANA-пояс або пояс сервера, якщо пояс не вказано чи він невідомий */
function validTz(tz) {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch (e) {
    return undefined;
  }
}
const LINK_URL = { client: "/clients/", lead: "/leads/", order: "/orders/" };
const LINK_ICON = { client: "fa-user", lead: "fa-bullseye", order: "fa-cart-shopping", deal: "fa-handshake", conversation: "fa-comments" };
const dayKey = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

// ─── GET /404 ─────────────────────────────────────────────────────────────────
router.get("/404/", authorizationControllers.isAuthenticated, (req, res) => {
  res.render("pages/error/404", {
    i18n: req,
    user: req.user,
    header: { navbar: "" },
  });
});

module.exports = router;