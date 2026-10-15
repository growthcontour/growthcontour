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
	"published_data", "published_version", "published_at", "id_user_published",
	"quality_score", "quality_issues", "quality_at",
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

/**
 * Сторінка історії для картки: події з підписами полів і мовами, без прихованих полів.
 * o: { offset, limit, t(key) → переклад, langs: [{id, iso}], secret: [поля, які не показувати], price: поточна ціна }
 */
async function cardPage(entity, id, o) {
	const iso = new Map((o.langs || []).map((l) => [l.id, String(l.iso).toUpperCase()]));
	const label = (f) => {
		const base = f.startsWith("variant.") ? f.split(".").slice(2).join(".") : f;
		const key = `catalog.products.f.${base}`;
		const t = o.t(key);
		return t === key ? f : f.startsWith("variant.") ? `${o.t("catalog.history.variant")} #${f.split(".")[1]}: ${t}` : t;
	};
	const hidden = (f) => (o.secret || []).some((s) => f === s || f.endsWith("." + s));
	const r = await read(entity, id, { offset: o.offset || 0, limit: o.limit || 30 });
	const rows = r.rows.map((ev) => ({
		...ev,
		changes: (ev.changes || []).filter((c) => !hidden(c.field)).map((c) => ({ ...c, label: label(c.field), lang_code: c.lang ? iso.get(c.lang) || "#" + c.lang : null })),
	}));
	const lowest = !o.offset && o.price !== undefined && o.price !== null ? await lowestPrice(entity, id, 30, o.price) : null;
	return { rows, has_more: r.has_more, lowest_price_30d: lowest };
}

/* ─── Повернення змін ─── */
const httpErr = (status, message, code) => Object.assign(new Error(message), { status, code });

// Значення з історії (рядок / ISO-дата / null) → значення для БД
function dbValue(v, sample) {
	if (v === null || v === undefined) return null;
	if (sample instanceof Date && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v);
	return v;
}

/** Що з події можна повернути: скорочені (довгі) значення — ні */
function revertable(c) {
	const full = (v) => v === null || typeof v !== "object" || Array.isArray(v);
	return full(c.old) && full(c.new);
}

/**
 * Повернути товар до стану перед подією ts (значення «old» кожної зміни події).
 * Повертає { reverted, skipped } — skipped: поля, які повернути не можна (довгі тексти, невідомі поля).
 */
async function revertProduct(id, ts, idUser) {
	let ev = null;
	for await (const e of events("products", id)) {
		if (e.ts === ts) {
			ev = e;
			break;
		}
	}
	if (!ev) throw httpErr(404, "History event not found");
	if (ev.action !== "update" || !(ev.changes || []).length) throw httpErr(400, "Only changes can be reverted", "not_revertable");

	const editLock = require("./edit-lock");
	const conn = await pool.getConnection();
	const applied = [];
	const skipped = [];
	try {
		await conn.beginTransaction();
		const [[row]] = await conn.query(`SELECT * FROM ${P}products WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [id]);
		if (!row) throw httpErr(404, "Product not found");
		const h = await editLock.holder(id, conn);
		if (h && h.id_user !== idUser) throw httpErr(423, "Locked", "locked");

		const cols = {};
		for (const c of ev.changes) {
			if (!revertable(c)) {
				skipped.push(c.field);
				continue;
			}
			const vm = /^variant\.(\d+)\.([a-z_]+)$/.exec(c.field);
			if (c.field === "categories" && !c.lang) {
				const ids = (c.old || []).map(Number).filter((n) => n > 0);
				const [[cur]] = await conn.query(`SELECT GROUP_CONCAT(id_category ORDER BY id_category) AS ids FROM ${P}products_to_categories WHERE id_product = ?`, [id]);
				await conn.query(`DELETE FROM ${P}products_to_categories WHERE id_product = ?`, [id]);
				if (ids.length) {
					const [ok] = await conn.query(`SELECT id FROM ${P}products_categories WHERE id IN (?)`, [ids]);
					if (ok.length) await conn.query(`INSERT INTO ${P}products_to_categories (id_product, id_category) VALUES ?`, [ok.map((r) => [id, r.id])]);
				}
				applied.push({ field: "categories", old: cur && cur.ids ? cur.ids.split(",").map(Number) : [], new: ids });
			} else if (c.lang) {
				const [[d]] = await conn.query(`SELECT * FROM ${P}products_description WHERE id_product = ? AND id_lang = ?`, [id, c.lang]);
				if (!d || !Object.prototype.hasOwnProperty.call(d, c.field) || ["id", "id_product", "id_lang"].includes(c.field)) {
					skipped.push(c.field);
					continue;
				}
				await conn.query(`UPDATE ${P}products_description SET \`${c.field}\` = ? WHERE id_product = ? AND id_lang = ?`, [c.old, id, c.lang]);
				applied.push({ field: c.field, lang: c.lang, old: compact(norm(d[c.field])), new: compact(c.old) });
			} else if (vm) {
				const [[v]] = await conn.query(`SELECT * FROM ${P}products_variants WHERE id = ? AND id_product = ?`, [vm[1], id]);
				if (!v || !Object.prototype.hasOwnProperty.call(v, vm[2]) || IGNORED.has(vm[2])) {
					skipped.push(c.field);
					continue;
				}
				await conn.query(`UPDATE ${P}products_variants SET \`${vm[2]}\` = ? WHERE id = ?`, [dbValue(c.old, v[vm[2]]), v.id]);
				applied.push({ field: c.field, old: norm(v[vm[2]]), new: c.old });
			} else if (Object.prototype.hasOwnProperty.call(row, c.field) && !IGNORED.has(c.field)) {
				cols[c.field] = dbValue(c.old, row[c.field]);
				applied.push({ field: c.field, old: compact(norm(row[c.field])), new: compact(c.old) });
			} else skipped.push(c.field);
		}
		if (!applied.length) throw httpErr(400, "Nothing to revert", "not_revertable");

		const keys = Object.keys(cols);
		await conn.query(
			`UPDATE ${P}products SET ${keys.map((k) => `\`${k}\` = ?, `).join("")}version = version + 1, id_user_edit = ? WHERE id = ?`,
			[...keys.map((k) => cols[k]), idUser || null, id]
		);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		if (e.code === "ER_DUP_ENTRY") throw httpErr(409, "Value is already used by another product (slug / SKU)", "duplicate");
		throw e;
	} finally {
		conn.release();
	}
	await record("products", id, { user: idUser, source: "revert", action: "update", changes: applied, meta: { reverted: ts } });
	return { reverted: applied.length, skipped };
}

module.exports = { ROOT, record, read, lowestPrice, rowChanges, descChanges, listChange, productChanges, revertProduct, cardPage };