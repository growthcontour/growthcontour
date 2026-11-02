"use strict";

/**
 * Універсальний редактор довідників за схемою бази (для лідів, угод та інших модулів).
 *
 * Модуль описує лише перелік довідників: { key: { table, title, usage?, children? } } —
 * усе інше редактор читає з бази (SHOW COLUMNS): які поля є, їх типи, переклади (<table>_lang), сортування, активність, кольори.
 * Так сторінка налаштувань не ламається, коли в таблицю додали колонку: нове поле з'являється у формі саме.
 *
 *   - Переклади: таблиця <table>_lang (id_lang + ключ на запис, напр. id_stage) — поля перекладу редагуються для кожної мови.
 *   - Посилання на інший довідник того ж модуля (id_pipeline → pipelines) — випадний список.
 *   - children: { table, fk, name, sort?, active? } — варіанти списку (напр. для власних полів), рядок = варіант,
 *     наявні зберігають id за позицією, зайві вимикаються (використані) або видаляються.
 *   - usage: { table, col } — захист від видалення того, що використовується (без нього — помилка зовнішнього ключа = те саме).
 */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;
const SKIP = /^(id|date_add|date_edit|date_upd|created_at|updated_at|deleted_at|id_user_add|id_user_edit|created_by|updated_by)$/;
const SORT_COLS = ["sort", "sort_order", "position"];
const ACTIVE_COLS = ["active", "is_active"];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const httpErr = (status, message) => Object.assign(new Error(message), { status });

const colsCache = new Map();
async function columns(table) {
	if (!colsCache.has(table)) {
		try {
			const [rows] = await pool.query(`SHOW COLUMNS FROM \`${P}${table}\``);
			colsCache.set(table, rows);
		} catch (e) {
			if (e.code !== "ER_NO_SUCH_TABLE") throw e;
			colsCache.set(table, null);
		}
	}
	return colsCache.get(table);
}

/** Тип поля форми з типу колонки MySQL */
function kindOf(c) {
	const t = String(c.Type).toLowerCase();
	if (/^color_/.test(c.Field)) return { type: "color" };
	if (t === "tinyint(1)" || /^(is_|has_|show_|can_)/.test(c.Field)) return { type: "bool" };
	if (/^enum\(/.test(t)) return { type: "select", options: t.slice(5, -1).split(",").map((x) => x.trim().replace(/^'|'$/g, "")) };
	if (/int|decimal|float|double/.test(t)) return { type: "number", step: /decimal|float|double/.test(t) ? "any" : "1" };
	if (/^date$/.test(t)) return { type: "date" };
	if (/text/.test(t)) return { type: "textarea" };
	if (/json/.test(t)) return { type: "json" };
	const m = /varchar\((\d+)\)/.exec(t);
	return { type: "text", max: m ? Number(m[1]) : 255 };
}

function createEditor({ dicts, langs: getLangs }) {
	const meta = (key) => {
		const d = dicts[key];
		if (!d) throw httpErr(404, "Unknown dictionary");
		return d;
	};
	// Довідник, на який посилається колонка id_xxx (за назвою таблиці: id_pipeline → *_pipeline / *_pipelines)
	const refOf = (col) => {
		const m = /^id_(\w+)$/.exec(col);
		if (!m) return null;
		return Object.keys(dicts).find((k) => dicts[k].table.endsWith("_" + m[1]) || dicts[k].table.endsWith("_" + m[1] + "s")) || null;
	};

	/** Схема довідника: поля основної таблиці й перекладу, службові колонки */
	async function schema(key) {
		const d = meta(key);
		const main = await columns(d.table);
		if (!main) return null;
		const lang = await columns(d.table + "_lang");
		const fk = lang ? (lang.find((c) => /^id_/.test(c.Field) && c.Field !== "id_lang") || {}).Field : null;
		const names = new Set(main.map((c) => c.Field));
		const sort = SORT_COLS.find((c) => names.has(c)) || null;
		const active = ACTIVE_COLS.find((c) => names.has(c)) || null;
		const fields = main
			.filter((c) => !SKIP.test(c.Field) && c.Field !== sort && c.Field !== active && c.Field !== "is_system")
			.map((c) => {
				const ref = refOf(c.Field);
				return { name: c.Field, ...(ref && ref !== key ? { type: "ref", ref } : kindOf(c)), required: c.Null === "NO" && c.Default === null && !/auto_increment/.test(c.Extra) };
			})
			.filter((f) => f.type !== "json");
		const langFields = lang ? lang.filter((c) => !["id", "id_lang", fk].includes(c.Field)).map((c) => ({ name: c.Field, ...kindOf(c) })) : [];
		return { key, table: d.table, fk, sort, active, system: names.has("is_system"), fields, lang: langFields, children: d.children || null };
	}

	async function describe() {
		const out = [];
		for (const key of Object.keys(dicts)) {
			const s = await schema(key);
			if (s) out.push({ key, title: dicts[key].title, ...s, table: undefined });
		}
		return out;
	}

	/** Записи з перекладами всіма мовами, кількістю використань і варіантами */
	async function list(key) {
		const d = meta(key);
		const s = await schema(key);
		if (!s) return [];
		const [rows] = await pool.query(`SELECT * FROM \`${P}${d.table}\` ORDER BY ${s.sort ? `\`${s.sort}\`, ` : ""}id`);
		const byId = new Map(rows.map((r) => [r.id, { ...r, i18n: {}, used: 0 }]));
		if (s.fk) {
			const [trs] = await pool.query(`SELECT * FROM \`${P}${d.table}_lang\``);
			for (const t of trs) {
				const r = byId.get(t[s.fk]);
				if (!r) continue;
				const { id, id_lang, [s.fk]: _, ...f } = t;
				r.i18n[id_lang] = f;
			}
		}
		if (d.usage) {
			const [used] = await pool.query(`SELECT \`${d.usage.col}\` AS id, COUNT(*) AS n FROM \`${P}${d.usage.table}\` WHERE \`${d.usage.col}\` IS NOT NULL GROUP BY \`${d.usage.col}\``).catch(() => [[]]);
			for (const u of used) if (byId.has(Number(u.id))) byId.get(Number(u.id)).used = Number(u.n);
		}
		if (d.children) {
			const c = d.children;
			const [opts] = await pool.query(`SELECT * FROM \`${P}${c.table}\` WHERE \`${c.fk}\` IN (?) ${c.active ? `AND \`${c.active}\` = 1` : ""} ORDER BY ${c.sort ? `\`${c.sort}\`, ` : ""}id`, [rows.length ? rows.map((r) => r.id) : [0]]);
			for (const o of opts) {
				const r = byId.get(o[c.fk]);
				if (r) (r.options = r.options || []).push(o[c.name]);
			}
		}
		return [...byId.values()];
	}

	/** Значення поля з форми → значення для бази за типом */
	function value(f, v) {
		if (f.type === "bool") return v === true || v === 1 || v === "1" || v === "on" ? 1 : 0;
		if (f.type === "number" || f.type === "ref") {
			if (v === "" || v === null || v === undefined) return null;
			const n = Number(v);
			if (!Number.isFinite(n)) throw httpErr(400, `${f.name}: number expected`);
			return n;
		}
		if (f.type === "color") return COLOR_RE.test(v || "") ? v : null;
		if (f.type === "select") return f.options.includes(v) ? v : f.options[0];
		if (f.type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : null;
		const s = String(v == null ? "" : v).trim();
		return s ? s.slice(0, f.max || 65535) : null;
	}

	async function save(key, id, b) {
		const d = meta(key);
		const s = await schema(key);
		if (!s) throw httpErr(404, "Table is missing");
		const langs = await getLangs();
		b = b || {};
		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();
			let cur = null;
			if (id) {
				[[cur]] = await conn.query(`SELECT * FROM \`${P}${d.table}\` WHERE id = ? FOR UPDATE`, [id]);
				if (!cur) throw httpErr(404, "Not found");
			}
			const isSystem = cur && Number(cur.is_system) === 1;
			const set = {};
			for (const f of s.fields) {
				if (isSystem && f.name === "code") continue; // на код системного запису спирається логіка
				if (!(f.name in b)) continue;
				const v = value(f, b[f.name]);
				if (v === null && f.required && !cur) throw httpErr(400, `${f.name}: required`);
				set[f.name] = v;
			}
			if (s.active) set[s.active] = b.active === false || b.active === 0 || b.active === "0" ? 0 : 1;
			if (cur) {
				if (Object.keys(set).length) await conn.query(`UPDATE \`${P}${d.table}\` SET ? WHERE id = ?`, [set, id]);
			} else {
				if (s.sort) {
					const [[mx]] = await conn.query(`SELECT COALESCE(MAX(\`${s.sort}\`), 0) + 10 AS v FROM \`${P}${d.table}\``);
					set[s.sort] = mx.v;
				}
				const cols = new Set((await columns(d.table)).map((c) => c.Field));
				if (cols.has("date_add")) set.date_add = new Date();
				if (cols.has("date_edit")) set.date_edit = new Date();
				const [ins] = await conn.query(`INSERT INTO \`${P}${d.table}\` SET ?`, [set]);
				id = ins.insertId;
			}
			if (cur && (await columns(d.table)).some((c) => c.Field === "date_edit")) await conn.query(`UPDATE \`${P}${d.table}\` SET date_edit = NOW() WHERE id = ?`, [id]);

			// Переклади: перша мова обов'язкова для текстових полів, яких вимагає таблиця
			if (s.fk) {
				const i18n = b.i18n || {};
				for (const l of langs) {
					const src = i18n[l.id] || {};
					const row = {};
					for (const f of s.lang) row[f.name] = value(f, src[f.name]);
					const [[ex]] = await conn.query(`SELECT id FROM \`${P}${d.table}_lang\` WHERE \`${s.fk}\` = ? AND id_lang = ? LIMIT 1`, [id, l.id]);
					if (ex) await conn.query(`UPDATE \`${P}${d.table}_lang\` SET ? WHERE id = ?`, [row, ex.id]);
					else await conn.query(`INSERT INTO \`${P}${d.table}_lang\` SET ?`, [{ ...row, [s.fk]: id, id_lang: l.id }]);
				}
			}

			if (d.children && Array.isArray(b.options)) await syncChildren(conn, d.children, id, b.options);
			await conn.commit();
			return { id };
		} catch (e) {
			await conn.rollback().catch(() => {});
			if (e.code === "ER_DUP_ENTRY") throw httpErr(409, "Duplicate value");
			if (e.code === "ER_BAD_NULL_ERROR" || e.code === "ER_NO_DEFAULT_FOR_FIELD") throw httpErr(400, e.sqlMessage || e.message);
			throw e;
		} finally {
			conn.release();
		}
	}

	async function syncChildren(conn, c, parentId, lines) {
		const names = lines.map((x) => String(x || "").trim().slice(0, 255)).filter(Boolean);
		const [cur] = await conn.query(`SELECT id FROM \`${P}${c.table}\` WHERE \`${c.fk}\` = ? ORDER BY ${c.sort ? `\`${c.sort}\`, ` : ""}id`, [parentId]);
		const cols = new Set((await columns(c.table)).map((x) => x.Field));
		for (let i = 0; i < names.length; i++) {
			const row = { [c.name]: names[i], ...(c.sort ? { [c.sort]: i } : {}), ...(c.active ? { [c.active]: 1 } : {}) };
			if (cur[i]) await conn.query(`UPDATE \`${P}${c.table}\` SET ?${cols.has("date_edit") ? ", date_edit = NOW()" : ""} WHERE id = ?`, [row, cur[i].id]);
			else await conn.query(`INSERT INTO \`${P}${c.table}\` SET ?`, [{ ...row, [c.fk]: parentId, ...(cols.has("date_add") ? { date_add: new Date() } : {}), ...(cols.has("date_edit") ? { date_edit: new Date() } : {}) }]);
		}
		for (const extra of cur.slice(names.length)) {
			// Зайві: вимикаємо (значення могли посилатися), а без колонки активності — видаляємо
			if (c.active) await conn.query(`UPDATE \`${P}${c.table}\` SET \`${c.active}\` = 0 WHERE id = ?`, [extra.id]);
			else await conn.query(`DELETE FROM \`${P}${c.table}\` WHERE id = ?`, [extra.id]);
		}
	}

	async function remove(key, id) {
		const d = meta(key);
		const s = await schema(key);
		const [[cur]] = await pool.query(`SELECT * FROM \`${P}${d.table}\` WHERE id = ?`, [id]);
		if (!cur) throw httpErr(404, "Not found");
		if (Number(cur.is_system) === 1) throw httpErr(400, "system");
		if (d.usage) {
			const [[u]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${P}${d.usage.table}\` WHERE \`${d.usage.col}\` = ?`, [id]).catch(() => [[{ n: 0 }]]);
			if (Number(u.n) > 0) throw httpErr(409, "used:" + u.n);
		}
		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();
			if (s.fk) await conn.query(`DELETE FROM \`${P}${d.table}_lang\` WHERE \`${s.fk}\` = ?`, [id]);
			if (d.children) await conn.query(`DELETE FROM \`${P}${d.children.table}\` WHERE \`${d.children.fk}\` = ?`, [id]);
			await conn.query(`DELETE FROM \`${P}${d.table}\` WHERE id = ?`, [id]);
			await conn.commit();
		} catch (e) {
			await conn.rollback().catch(() => {});
			if (e.code === "ER_ROW_IS_REFERENCED_2" || e.code === "ER_ROW_IS_REFERENCED") throw httpErr(409, "used");
			throw e;
		} finally {
			conn.release();
		}
		return { ok: true };
	}

	async function sort(key, ids) {
		const d = meta(key);
		const s = await schema(key);
		if (!s || !s.sort) return { ok: true };
		const list = (Array.isArray(ids) ? ids : []).map((x) => parseInt(x, 10)).filter(Boolean);
		if (!list.length) return { ok: true };
		const params = [];
		list.forEach((id, i) => params.push(id, (i + 1) * 10));
		await pool.query(`UPDATE \`${P}${d.table}\` SET \`${s.sort}\` = CASE id ${list.map(() => "WHEN ? THEN ?").join(" ")} ELSE \`${s.sort}\` END WHERE id IN (?)`, [...params, list]);
		return { ok: true };
	}

	return { describe, list, save, remove, sort, dicts };
}

/** Мови контенту (перша — основна) */
async function languages() {
	const [rows] = await pool.query(`SELECT id, name, iso FROM ${P}languages ORDER BY id`).catch(() => [[{ id: 1, name: "Українська", iso: "uk" }]]);
	return rows;
}

module.exports = { createEditor, languages };