"use strict";

const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

// Приймання інвайту (публічний) — захист від перебору токенів
const inviteAcceptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 хв
  max: 20,                  // 20 спроб з одного IP за вікно
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", message: "Too many attempts. Try again later." },
});

// GET сторінки інвайту (публічний)
const invitePageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Повторне надсилання — захист від засипання поштою
const resendInviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 год
  max: 10,                  // 10 листів з IP за годину
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", message: "Too many invites sent. Try again later." },
});

module.exports = {
  inviteAcceptLimiter,
  invitePageLimiter,
  resendInviteLimiter,
};