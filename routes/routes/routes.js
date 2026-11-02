"use strict";

const express = require("express");
const router = express.Router();

// ─── Контролери ──────────────────────────────────────────────────────────────
const authorizationControllers = require("../../controllers/authorization/authorization");

// ─── Логування ───────────────────────────────────────────────────────────────
const logging = require("../../logging/logging");

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
router.get("/", authorizationControllers.isAuthenticated, async (req, res) => {
  res.render("pages/index/index", {
    i18n: req,
    user: req.user,
    header: { navbar: "home" },
  });
  // Демо-нотифікацію прибрано: вона плодила нову подію на кожен рефреш.
});

// ─── GET /404 ─────────────────────────────────────────────────────────────────
router.get("/404/", authorizationControllers.isAuthenticated, (req, res) => {
  res.render("pages/error/404", {
    i18n: req,
    user: req.user,
    header: { navbar: "" },
  });
});

module.exports = router;
