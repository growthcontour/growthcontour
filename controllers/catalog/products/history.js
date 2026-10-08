"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");

const P = config.get("configDatabase").prefix;
const ROOT = path.resolve(process.env.HISTORY_DIR || path.join(__dirname, "..", "..", "..", "logs"));
const ENTITIES = new Set(["products", "categories", "brands"]);
const ROTATE_BYTES = 8 * 1024 * 1024;
const MAX_VALUE = 2000;
const IGNORED = new Set([
	"id", "uuid", "version", "date_add", "date_edit", "id_user_add", "id_user_edit",
	"viewed", "sales_count", "rating_avg", "reviews_count", "deleted_at", "id_user_deleted",
]);

/* ─── Шляхи ─── */
function dirOf(entity, id) {
	if (!ENTITIES.has(entity)) throw new Error("history: unknown entity " + entity);
	const n = Number(id);
	if (!Number.isInteger(n) || n < 1) throw new Error("history: invalid id");
	return path.join(ROOT, entity, String(Math.floor(n / 1000)));
}
const currentFile = (entity, id) => path.join(dirOf(entity, id), `${Number(id)}.ndjson`);

/* ─── Нормалізація значень ─── */
function norm(v) {
	if (v === undefined || v === null || v === "") return null;
	if (v instanceof Date) return v.toISOString();
	if (typeof v === "boolean") return v ? "1" : "0";
	if (Array.isArray(v) || typeof v === "object") return JSON.stringify(v);
	return String(v);
}

/** Довгі значення — відбиток замість повного тексту */
function compact(v) {
	if (typeof v !== "string" || v.length <= MAX_VALUE) return v;
	return { len: v.length, sha256: crypto.createHash("sha256").update(v).digest("hex"), preview: v.slice(0, 200) };
}

/** Зміни між двома рядками таблиці (службові поля ігноруються) */
function rowChanges(before, after, opts = {}) {
	if (!before || !after) return [];
	const out = [];
	for (const k of Object.keys(after)) {
		if (IGNORED.has(k) || (opts.ignore && opts.ignore.includes(k))) continue;
		const a = norm(before[k]);
		const b = norm(after[k]);
		if (a !== b) out.push({ field: k, old: compact(a), new: compact(b) });
	}
	return out;
}

/** Зміни описів: { [id_lang]: {field: value} } */
function descChanges(before, after) {
	const out = [];
	const langs = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
	for (const lang of langs) {
		const a = (before || {})[lang] || {};
		const b = (after || {})[lang] || {};
		const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
		for (const f of fields) {
			const x = norm(a[f]);
			const y = norm(b[f]);
			if (x !== y) out.push({ field: f, lang: Number(lang), old: compact(x), new: compact(y) });
		}
	}
	return out;
}

/** Зміна списку id (категорії тощо) */
function listChange(field, before, after) {
	const a = [...new Set((before || []).map(Number))].sort((x, y) => x - y);
	const b = [...new Set((after || []).map(Number))].sort((x, y) => x - y);
	return a.join(",") === b.join(",") ? [] : [{ field, old: a, new: b }];
}

/** Повний набір змін товару для картки */
function productChanges({ before, after, beforeDesc, afterDesc, beforeCats, afterCats }) {
	return [...rowChanges(before, after), ...descChanges(beforeDesc, afterDesc), ...listChange("categories", beforeCats, afterCats)];
}

/* ─── Автор ─── */
const userCache = new Map();
async function userName(idUser) {
	if (!idUser) return null;
	const hit = userCache.get(idUser);
	if (hit && hit.exp > Date.now()) return hit.name;
	const [[u]] = await pool.query(`SELECT NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM ${P}users WHERE id = ?`, [idUser]);
	const name = u ? u.name : null;
	userCache.set(idUser, { name, exp: Date.now() + 10 * 60 * 1000 });
	return name;
}

/* ─── Запис ─── */
// Послідовний запис у межах процесу для одного файлу (ротація не перетинається з дописуванням)
const queues = new Map();

async function appendLine(file, line) {
	await fsp.mkdir(path.dirname(file), { recursive: true });
	const st = await fsp.stat(file).catch(() => null);
	if (st && st.size >= ROTATE_BYTES) {
		const rotated = file.replace(/\.ndjson$/, `.${Date.now()}.ndjson`);
		await fsp.rename(file, rotated).catch((e) => e.code !== "ENOENT" && Promise.reject(e));
	}
	const fh = await fsp.open(file, "a", 0o640);
	try {
		await fh.write(line); // один write з O_APPEND — атомарне дописування
		await fh.datasync();
	} finally {
		await fh.close();
	}
}

/**
 * Записати подію. Не кидає помилок (історія не повинна ламати основну операцію).
 * ev: { user, source, action, changes, meta }
 *   source: card | bulk | import | copy | trash | sync | api
 *   action: create | update | delete | restore
 */
async function record(entity, id, ev) {
	try {
		const changes = Array.isArray(ev.changes) ? ev.changes : [];
		if (ev.action === "update" && !changes.length) return;
		const line =
			JSON.stringify({
				ts: new Date().toISOString(),
				id: Number(id),
				user: ev.user ? { id: Number(ev.user), name: await userName(Number(ev.user)) } : null,
				source: ev.source || "card",
				action: ev.action || "update",
				changes,
				meta: ev.meta || undefined,
			}) + "\n";
		const file = currentFile(entity, id);
		const prev = queues.get(file) || Promise.resolve();
		const next = prev.then(() => appendLine(file, line));
		queues.set(file, next.catch(() => {}));
		await next;
		if (queues.get(file) === next) queues.delete(file);
	} catch (e) {
		console.error("[history] write", entity, id, e.message);
	}
}

/* ─── Читання ─── */
async function filesOf(entity, id) {
	const dir = dirOf(entity, id);
	const n = Number(id);
	const names = await fsp.readdir(dir).catch((e) => (e.code === "ENOENT" ? [] : Promise.reject(e)));
	const re = new RegExp(`^${n}\\.(\\d+)\\.ndjson$`);
	const rotated = names
		.map((f) => ({ f, m: re.exec(f) }))
		.filter((x) => x.m)
		.sort((a, b) => Number(b.m[1]) - Number(a.m[1]))
		.map((x) => path.join(dir, x.f));
	const current = names.includes(`${n}.ndjson`) ? [path.join(dir, `${n}.ndjson`)] : [];
	return [...current, ...rotated];
}

/** Події від нових до старих; stop(ev) === true — припинити читання */
async function* events(entity, id) {
	for (const file of await filesOf(entity, id)) {
		const text = await fsp.readFile(file, "utf8").catch((e) => (e.code === "ENOENT" ? "" : Promise.reject(e)));
		const lines = text.split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			if (!lines[i]) continue;
			try {
				yield JSON.parse(lines[i]);
			} catch {
				// пошкоджений рядок (обірваний запис) пропускаємо
			}
		}
	}
}

async function read(entity, id, { offset = 0, limit = 50 } = {}) {
	const rows = [];
	let skipped = 0;
	for await (const ev of events(entity, id)) {
		if (skipped < offset) {
			skipped++;
			continue;
		}
		rows.push(ev);
		if (rows.length > limit) break;
	}
	return { rows: rows.slice(0, limit), has_more: rows.length > limit };
}

/**
 * Найнижча ціна за останні N днів (директива Omnibus): поточна + усі значення поля в межах вікна.
 * Повертає число або null, якщо ціна не відома.
 */
async function lowestPrice(entity, id, days, currentPrice, field = "price") {
	const since = Date.now() - days * 86400000;
	const values = [];
	if (currentPrice !== null && currentPrice !== undefined) values.push(Number(currentPrice));
	for await (const ev of events(entity, id)) {
		if (Date.parse(ev.ts) < since) {
			// ціна, що діяла на початок вікна: «нове» значення найсвіжішої зміни до вікна
			const c = (ev.changes || []).find((x) => x.field === field && !x.lang);
			if (c && c.new !== null) {
				values.push(Number(c.new));
				break;
			}
			continue;
		}
		for (const c of ev.changes || []) {
			if (c.field !== field || c.lang) continue;
			if (c.old !== null && typeof c.old !== "object") values.push(Number(c.old));
			if (c.new !== null && typeof c.new !== "object") values.push(Number(c.new));
		}
	}
	const valid = values.filter((v) => Number.isFinite(v));
	return valid.length ? Math.min(...valid) : null;
}

module.exports = { ROOT, record, read, lowestPrice, rowChanges, descChanges, listChange, productChanges };