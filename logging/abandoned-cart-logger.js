// logging/abandoned-cart-logger.js
// JSONL-аудит покинутих кошиків. Кожен рядок — одна самодостатня подія.
// Денна ротація: abandoned-cart-YYYY-MM-DD.jsonl. Синхронний append (рядки цілісні).

const fs = require("fs");
const path = require("path");

const LOG_DIR = process.env.ABANDONED_CART_LOG_DIR || path.join(__dirname, "../logs/abandoned-cart");
const RETENTION_DAYS = parseInt(process.env.ABANDONED_CART_LOG_RETENTION_DAYS || "90", 10);

function ensureDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}
ensureDir();

function dayStamp(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function fileFor(d = new Date()) {
  return path.join(LOG_DIR, `abandoned-cart-${dayStamp(d)}.jsonl`);
}

// Прибрати несеріалізовне/циклічне, обрізати надто довгі рядки
function safeClone(obj, maxStr = 8000) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v == null) return v;
    if (typeof v === "string") return v.length > maxStr ? v.slice(0, maxStr) + "…[truncated]" : v;
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "bigint") return v.toString();
    if (typeof v !== "object") return String(v);
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v)) out[k] = walk(v[k]);
    return out;
  };
  return walk(obj);
}

function writeLine(record) {
  try {
    ensureDir();
    fs.appendFileSync(fileFor(), JSON.stringify(record) + "\n", "utf8");
  } catch (e) {
    // логер не має ронити основний потік
    try {
      console.error("[abandoned-cart-logger] write failed:", e.message);
    } catch {}
  }
}

// Основний API: багата подія довільного типу
function event(type, payload = {}) {
  const rec = {
    ts: new Date().toISOString(),
    type, // 'send' | 'enqueue' | 'skip' | 'status' | ...
    ...safeClone(payload),
  };
  writeLine(rec);
  return rec;
}

// Зворотна сумісність зі старими викликами log(provider, status, data)
function log(provider, status, data = {}) {
  return event("send", { provider, result: status, ...data });
}

// ── Читання для звіту ────────────────────────────────────────────────
function listLogFiles() {
  ensureDir();
  return fs
    .readdirSync(LOG_DIR)
    .filter((f) => /^abandoned-cart-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
}

function fileDate(f) {
  const m = f.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Прочитати події за діапазон дат (включно), з фільтрами. limit — стеля рядків.
function readEvents({ from, to, type, correlation_id, cart_id, event_id, limit = 1000 } = {}) {
  const files = listLogFiles().filter((f) => {
    const d = fileDate(f);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });

  const out = [];
  for (const f of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(LOG_DIR, f), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (type && rec.type !== type) continue;
      if (correlation_id && rec.correlation_id !== correlation_id) continue;
      if (cart_id != null && rec.cart_id !== cart_id) continue;
      if (event_id != null && rec.event_id !== event_id) continue;
      out.push(rec);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// Ретенція: прибрати файли, старші за RETENTION_DAYS
function cleanupOldLogs() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 864e5);
  const cutStr = dayStamp(cutoff);
  for (const f of listLogFiles()) {
    if (fileDate(f) < cutStr) {
      try {
        fs.unlinkSync(path.join(LOG_DIR, f));
      } catch {}
    }
  }
}

// Самозапуск ретенції: одразу при завантаженні модуля + раз на добу.
// unref() — щоб таймер не тримав процес живим під час завершення.
cleanupOldLogs();
const _retentionTimer = setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000);
if (_retentionTimer.unref) _retentionTimer.unref();

module.exports = { event, log, readEvents, listLogFiles, cleanupOldLogs, LOG_DIR };
