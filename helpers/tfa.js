"use strict";

const crypto = require("crypto");
const { authenticator } = require("otplib");
const QRCode = require("qrcode");
const { encryptSecret, decryptSecret } = require("./crypto_tfa");

const config = require("../config/config");
const tfaConfig = config.get("configTFA");

const STEP = Number(tfaConfig.tfa.step) || 30;
const WINDOW = Number(tfaConfig.tfa.window) || 1;
const ISSUER = tfaConfig.tfa.issuer || "Growth contour";
const BACKUP_COUNT = Number(tfaConfig.tfa.backup_codes_count) || 10;

// Окремий ключ для HMAC backup-кодів — виводимо з enc_key,
// щоб не використовувати один і той самий матеріал для шифрування і хешування
const BACKUP_HMAC_KEY = crypto
  .createHash("sha256")
  .update("backup-codes|" + tfaConfig.tfa.enc_key)
  .digest();

authenticator.options = { step: STEP, window: WINDOW, digits: 6 };

function generateSecret() {
  return authenticator.generateSecret(20); // 160 біт
}

function buildOtpauthUrl(email, secret) {
  return authenticator.keyuri(email, ISSUER, secret);
}

async function buildQrDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: "M", margin: 1 });
}

function normalizeCode(raw) {
  return String(raw || "")
    .replace(/[\s-]/g, "")
    .toUpperCase();
}

function isValidCodeFormat(raw) {
  return /^\d{6}$/.test(normalizeCode(raw));
}

function currentStep() {
  return Math.floor(Date.now() / 1000 / STEP);
}

/**
 * Перевірка TOTP з anti-replay.
 * @returns {{ok: boolean, step: number|null}}
 */
function verifyTotp(encSecret, code, lastStep) {
  const secret = decryptSecret(encSecret);
  if (!secret) return { ok: false, step: null };

  const clean = normalizeCode(code);
  if (!/^\d{6}$/.test(clean)) return { ok: false, step: null };

  const now = currentStep();

  // Перебираємо вікно вручну, щоб дізнатись КОНКРЕТНИЙ step
  for (let offset = -WINDOW; offset <= WINDOW; offset++) {
    const step = now + offset;

    // anti-replay: цей крок вже використано
    if (step <= Number(lastStep || 0)) continue;

    const expected = authenticator.generate(secret, step * STEP * 1000);

    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) {
      return { ok: true, step };
    }
  }

  return { ok: false, step: null };
}

// ─── Backup-коди ─────────────────────────────────────────────────────────────

function generateBackupCodes(count = BACKUP_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(16).toString("base64url").replace(/[-_]/g, "").toUpperCase().slice(0, 10);
    codes.push(raw);
  }
  return codes;
}

function hashBackupCode(code) {
  return crypto.createHmac("sha256", BACKUP_HMAC_KEY).update(normalizeCode(code)).digest("hex");
}

function isValidBackupFormat(raw) {
  return /^[A-Z0-9]{10}$/.test(normalizeCode(raw));
}

module.exports = {
  generateSecret,
  buildOtpauthUrl,
  buildQrDataUrl,
  normalizeCode,
  isValidCodeFormat,
  verifyTotp,
  generateBackupCodes,
  hashBackupCode,
  isValidBackupFormat,
  STEP,
};
