// controllers/orders/serviceConfig.js
const crypto = require("crypto");

// типи полів, що вважаються секретами (не віддаються на фронт, шифруються на спокої)
const SECRET_TYPES = new Set(["password"]);

// ключ шифрування: 32 байти у hex через env. Порожній → plaintext (demo-режим)
const SECRET_KEY = process.env.SERVICE_CONFIG_KEY || "";

function encryptSecret(plain) {
  if (!SECRET_KEY) return String(plain); // fallback без шифрування
  const key = Buffer.from(SECRET_KEY, "hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "enc:v1:" + Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptSecret(stored) {
  if (typeof stored !== "string" || !stored.startsWith("enc:v1:")) return stored;
  if (!SECRET_KEY) return stored;
  const raw = Buffer.from(stored.slice(7), "base64");
  const key = Buffer.from(SECRET_KEY, "hex");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function normalizeSchema(raw) {
  if (raw && Array.isArray(raw.groups)) return raw;
  if (Array.isArray(raw)) return { groups: [{ id: "general", label: "", fields: raw }] };
  return { groups: [] };
}

function flattenSchema(schema) {
  const out = [];
  for (const g of schema.groups || []) for (const f of g.fields || []) out.push(f);
  return out;
}

// config може бути легасі-масивом [{key,value}] або чистим об'єктом {key:value}
function configToObject(rawConfig) {
  const parsed = parseJson(rawConfig, {});
  if (Array.isArray(parsed)) {
    const o = {};
    for (const it of parsed) if (it && it.key != null) o[it.key] = it.value;
    return o;
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

// готовий до використання конфіг сервісу {key:value} з розшифрованими секретами.
// row повинен містити .config та .config_fields
function readServiceConfig(row) {
  const stored = configToObject(row.config);
  const schema = normalizeSchema(parseJson(row.config_fields, []));
  const out = {};
  for (const f of flattenSchema(schema)) {
    let v = stored[f.key];
    if (v === undefined) v = f.default ?? "";
    if (SECRET_TYPES.has(f.type)) v = decryptSecret(v);
    out[f.key] = v;
  }
  for (const k of Object.keys(stored)) if (!(k in out)) out[k] = stored[k]; // extra keys
  return out;
}

// нормалізація UA-номера → 380XXXXXXXXX; null якщо неможливо
function normalizePhone(raw) {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 && d.startsWith("0"))
    d = "38" + d; // 0XXXXXXXXX
  else if (d.length === 9)
    d = "380" + d; // XXXXXXXXX
  else if (d.length === 11 && d.startsWith("80")) d = "3" + d; // 80XXXXXXXXX
  if (!/^380\d{9}$/.test(d)) return null;
  return d;
}

module.exports = {
  SECRET_TYPES,
  encryptSecret,
  decryptSecret,
  parseJson,
  normalizeSchema,
  flattenSchema,
  configToObject,
  readServiceConfig,
  normalizePhone,
};
