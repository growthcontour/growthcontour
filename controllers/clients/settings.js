const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const dict = require("./dictionaries");

const P = config.get("configDatabase").prefix;

const KINDS = [
	["person", "Фізособа"],
	["organization", "Організація"],
	["group", "Група"],
];
const KINDS_ALL = [["all", "Усі"], ...KINDS];

/**
 * Опис довідників для універсального редактора.
 * fields — поля основної таблиці (крім code/sort/active/is_system), lang — поля перекладу,
 * usage — де використовується (захист від видалення).
 * Нове поле або новий довідник додається тут — редактор підхопить сам.
 */
const SETTINGS = {
	lifecycle_stages: {
		title: "Стадії",
		fields: [{ name: "is_customer", label: "Вже покупець", type: "bool" }],
		lang: [{ name: "name", label: "Назва", required: true }],
		usage: { table: "clients", col: "id_lifecycle" },
	},
	tags: {
		title: "Теги",
		fields: [],
		lang: [
			{ name: "name", label: "Назва", required: true },
			{ name: "description", label: "Опис" },
		],
		usage: { table: "clients_tag_links", col: "id_tag" },
	},
	legal_types: {
		title: "Правові форми",
		fields: [
			{ name: "kind", label: "Тип клієнта", type: "select", options: KINDS, required: true },
			{ name: "required_identifiers", label: "Обовʼязкові реквізити (коди через кому)", type: "text", max: 255 },
		],
		lang: [
			{ name: "name", label: "Назва", required: true },
			{ name: "short_name", label: "Коротка назва" },
		],
		usage: { table: "clients", col: "id_legal_type" },
	},
	identifier_types: {
		title: "Типи реквізитів",
		fields: [
			{ name: "applies_kind", label: "Для кого", type: "select", options: KINDS_ALL, required: true },
			{ name: "country", label: "Країна (ISO-2, порожньо = усі)", type: "country" },
			{ name: "validation_regex", label: "Регулярний вираз перевірки", type: "regex", max: 255 },
			{ name: "is_unique", label: "Унікальний (однаковий номер = той самий клієнт)", type: "bool" },
		],
		lang: [{ name: "name", label: "Назва", required: true }],
		usage: { table: "clients_identifiers", col: "id_identifier_type" },
	},
	contact_types: {
		title: "Типи контактів",
		fields: [
			{
				name: "normalize",
				label: "Нормалізація",
				type: "select",
				options: [
					["none", "Без змін"],
					["phone", "Телефон (E.164)"],
					["email", "Email"],
					["username", "Нікнейм"],
					["url", "Посилання"],
				],
				system: true,
			},
			{ name: "url_template", label: "Шаблон посилання ({value})", type: "text", max: 255 },
			{ name: "use_for_dedup", label: "Шукати дублі за цим контактом", type: "bool", system: true },
		],
		lang: [{ name: "name", label: "Назва", required: true }],
		usage: { table: "clients_contact_points", col: "id_contact_type" },
	},
	address_types: {
		title: "Типи адрес",
		fields: [],
		lang: [{ name: "name", label: "Назва", required: true }],
		usage: { table: "clients_addresses", col: "id_address_type" },
	},
	relationship_types: {
		title: "Типи звʼязків",
		fields: [
			{ name: "from_kind", label: "Від кого", type: "select", options: KINDS_ALL, required: true },
			{ name: "to_kind", label: "До кого", type: "select", options: KINDS_ALL, required: true },
			{ name: "is_symmetric", label: "Симетричний (однаковий в обидва боки)", type: "bool" },
		],
		lang: [
			{ name: "name", label: "Назва (прямий напрям)", required: true },
			{ name: "reverse_name", label: "Назва (зворотний напрям)" },
		],
		usage: { table: "clients_relationships", col: "id_relationship_type" },
	},
	field_defs: {
		title: "Власні поля",
		fields: [
			{
				name: "field_type",
				label: "Тип поля",
				type: "select",
				required: true,
				options: [
					["text", "Текст"],
					["textarea", "Багаторядковий текст"],
					["number", "Число"],
					["date", "Дата"],
					["boolean", "Так / ні"],
					["select", "Список (один)"],
					["multiselect", "Список (кілька)"],
					["url", "Посилання"],
					["email", "Email"],
					["phone", "Телефон"],
				],
			},
			{ name: "applies_kind", label: "Для кого", type: "select", options: KINDS_ALL, required: true },
			{ name: "is_required", label: "Обовʼязкове", type: "bool" },
		],
		lang: [
			{ name: "name", label: "Назва", required: true },
			{ name: "placeholder", label: "Підказка" },
		],
		usage: { table: "clients_field_values", col: "id_field" },
		options: true,
	},
	role_types: {
		title: "Ролі",
		fields: [],
		lang: [{ name: "name", label: "Назва", required: true }],
		usage: { table: "clients_roles", col: "id_role_type" },
	},
};

function httpErr(status, message) {
	const e = new Error(message);
	e.status = status;
	return e;
}

// Колонки таблиць: редагуємо лише ті поля, що реально існують (різні версії схеми)
const colsCache = new Map();
async function columns(table) {
	if (!colsCache.has(table)) {
		const [rows] = await pool.query(`SHOW COLUMNS FROM ${P}${table}`);
		colsCache.set(table, new Set(rows.map((r) => r.Field)));
	}
	return colsCache.get(table);
}

function meta(key) {
	const s = SETTINGS[key];
	const d = dict.DICTS[key];
	if (!s || !d) throw httpErr(404, "Невідомий довідник.");
	return { s, d };
}

/** Опис для сторінки: поля, яких немає в БД, прибрано */
async function describe() {
	const out = [];
	for (const [key, s] of Object.entries(SETTINGS)) {
		const d = dict.DICTS[key];
		if (!d) continue;
		const cols = await columns(d.table);
		const lcols = await columns(d.table + "_lang");
		out.push({
			key,
			title: s.title,
			hasColors: cols.has("color_text") && cols.has("color_background"),
			hasIcon: cols.has("icon"),
			hasSystem: cols.has("is_system"),
			hasOptions: !!s.options,
			fields: s.fields.filter((f) => cols.has(f.name)),
			lang: s.lang.filter((f) => lcols.has(f.name)),
		});
	}
	return out;
}

/** Усі записи довідника з перекладами всіма мовами і кількістю використань */
async function listRows(key) {
	const { s, d } = meta(key);
	const [rows] = await pool.query(`SELECT * FROM ${P}${d.table} ORDER BY sort, id`);
	const [trs] = await pool.query(`SELECT * FROM ${P}${d.table}_lang`);
	const [used] = await pool.query(`SELECT \`${s.usage.col}\` AS id, COUNT(*) AS n FROM ${P}${s.usage.table} WHERE \`${s.usage.col}\` IS NOT NULL GROUP BY \`${s.usage.col}\``);
	const usedMap = new Map(used.map((u) => [Number(u.id), Number(u.n)]));

	const byId = new Map(rows.map((r) => [r.id, { ...r, i18n: {}, used: usedMap.get(r.id) || 0 }]));
	for (const t of trs) {
		const r = byId.get(t[d.fk]);
		if (!r) continue;
		const { id, id_lang, [d.fk]: _omit, ...fields } = t;
		r.i18n[id_lang] = fields;
	}
	const out = [...byId.values()];
	if (s.options) {
		const opts = await loadOptions(out.map((r) => r.id));
		for (const r of out) r.options = opts[r.id] || [];
	}
	return out;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const CODE_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** Створити (id = null) або оновити запис */
async function saveRow(key, id, b) {
	const { s, d } = meta(key);
	const cols = await columns(d.table);
	const lcols = await columns(d.table + "_lang");
	const langs = (await dict.languages()).list;

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();

		let cur = null;
		if (id) {
			[[cur]] = await conn.query(`SELECT * FROM ${P}${d.table} WHERE id = ? FOR UPDATE`, [id]);
			if (!cur) throw httpErr(404, "Запис не знайдено.");
		}
		const isSystem = cur && Number(cur.is_system) === 1;

		const set = {};

		// Код: у системних записах незмінний — на нього спирається логіка. Порожній — генеруємо
		const code =
			String(b.code || "")
				.trim()
				.toLowerCase() || (cur ? cur.code : "c_" + Date.now().toString(36));
		if (!isSystem) {
			if (!CODE_RE.test(code)) throw httpErr(400, "Код: латиниця, цифри, _ (до 32 символів), починається з літери.");
			const [[dup]] = await conn.query(`SELECT id FROM ${P}${d.table} WHERE code = ? AND id <> ? LIMIT 1`, [code, id || 0]);
			if (dup) throw httpErr(409, "Такий код уже існує.");
			set.code = code;
		}

		for (const f of s.fields) {
			if (!cols.has(f.name)) continue;
			if (isSystem && f.system) continue;
			let v = b[f.name];
			if (f.type === "bool") v = v === true || v === 1 || v === "1" ? 1 : 0;
			else if (f.type === "select") {
				v = String(v || "");
				if (!f.options.some((o) => o[0] === v)) throw httpErr(400, `Поле «${f.label}»: невірне значення.`);
			} else if (f.type === "country") {
				v = String(v || "")
					.trim()
					.toUpperCase();
				if (v && !/^[A-Z]{2}$/.test(v)) throw httpErr(400, "Країна: 2 літери ISO.");
				v = v || null;
			} else if (f.type === "regex") {
				v = String(v || "")
					.trim()
					.slice(0, f.max || 255);
				if (v) {
					try {
						new RegExp(v);
					} catch (e) {
						throw httpErr(400, "Невірний регулярний вираз.");
					}
				}
				v = v || null;
			} else {
				v =
					String(v || "")
						.trim()
						.slice(0, f.max || 255) || null;
			}
			set[f.name] = v;
		}

		if (cols.has("color_text")) set.color_text = COLOR_RE.test(b.color_text || "") ? b.color_text : "#ffffff";
		if (cols.has("color_background")) set.color_background = COLOR_RE.test(b.color_background || "") ? b.color_background : "#6c757d";
		if (cols.has("icon"))
			set.icon = String(b.icon || "")
				.trim()
				.replace(/[^a-z0-9 \-]/gi, "")
				.slice(0, 64);
		if (cols.has("active")) set.active = b.active === false || b.active === 0 || b.active === "0" ? 0 : 1;

		// Переклади: обовʼязкове поле — хоча б мовою за замовчуванням
		const i18n = b.i18n || {};
		const defLang = langs.length ? langs[0].id : 1;
		for (const f of s.lang) {
			if (f.required && lcols.has(f.name) && !String((i18n[defLang] || {})[f.name] || "").trim()) {
				throw httpErr(400, `Заповніть «${f.label}» мовою за замовчуванням (${langs[0] ? langs[0].name : "1"}).`);
			}
		}

		if (cur) {
			if (cols.has("date_edit")) set.date_edit = new Date();
			await conn.query(`UPDATE ${P}${d.table} SET ? WHERE id = ?`, [set, id]);
		} else {
			const [[mx]] = await conn.query(`SELECT COALESCE(MAX(sort), 0) + 10 AS s FROM ${P}${d.table}`);
			set.sort = mx.s;
			if (cols.has("is_system")) set.is_system = 0;
			if (cols.has("date_add")) set.date_add = new Date();
			if (cols.has("date_edit")) set.date_edit = new Date();
			const [ins] = await conn.query(`INSERT INTO ${P}${d.table} SET ?`, [set]);
			id = ins.insertId;
		}

		for (const l of langs) {
			const src = i18n[l.id] || {};
			const row = {};
			for (const f of s.lang)
				if (lcols.has(f.name))
					row[f.name] = String(src[f.name] || "")
						.trim()
						.slice(0, 255);
			const [[ex]] = await conn.query(`SELECT id FROM ${P}${d.table}_lang WHERE \`${d.fk}\` = ? AND id_lang = ? LIMIT 1`, [id, l.id]);
			if (ex) await conn.query(`UPDATE ${P}${d.table}_lang SET ? WHERE id = ?`, [row, ex.id]);
			else await conn.query(`INSERT INTO ${P}${d.table}_lang SET ?`, [{ ...row, [d.fk]: id, id_lang: l.id }]);
		}

		if (s.options && b.options) await syncOptions(conn, id, b.options, langs);

		await conn.commit();
		dict.invalidate();
		return { ok: true, id };
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

/** Видалити: системні й ті, що використовуються, — ні (лише вимкнути) */
async function deleteRow(key, id) {
	const { s, d } = meta(key);
	const [[cur]] = await pool.query(`SELECT * FROM ${P}${d.table} WHERE id = ?`, [id]);
	if (!cur) throw httpErr(404, "Запис не знайдено.");
	if (Number(cur.is_system) === 1) throw httpErr(400, "Системний запис не можна видалити — його можна вимкнути.");
	const [[u]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}${s.usage.table} WHERE \`${s.usage.col}\` = ?`, [id]);
	if (Number(u.n) > 0) throw httpErr(400, `Використовується: ${u.n}. Видалити не можна — вимкніть запис.`);

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		await conn.query(`DELETE FROM ${P}${d.table}_lang WHERE \`${d.fk}\` = ?`, [id]);
		await conn.query(`DELETE FROM ${P}${d.table} WHERE id = ?`, [id]);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	dict.invalidate();
	return { ok: true };
}

/** Порядок після перетягування: ids у новому порядку */
async function sortRows(key, ids) {
	const { d } = meta(key);
	const list = (Array.isArray(ids) ? ids : []).map((x) => parseInt(x, 10)).filter(Boolean);
	if (!list.length) return { ok: true };
	const cases = list.map(() => "WHEN ? THEN ?").join(" ");
	const params = [];
	list.forEach((id, i) => params.push(id, (i + 1) * 10));
	await pool.query(`UPDATE ${P}${d.table} SET sort = CASE id ${cases} ELSE sort END WHERE id IN (?)`, [...params, list]);
	dict.invalidate();
	return { ok: true };
}

// ─── Варіанти для полів-списків (select / multiselect) ───────────────────
/** { idField: [{ id, sort, active, i18n: { idLang: name } }] } */
async function loadOptions(fieldIds) {
	const out = {};
	if (!fieldIds.length) return out;
	const [opts] = await pool.query(`SELECT * FROM ${P}clients_field_options WHERE id_field IN (?) ORDER BY sort, id`, [fieldIds]);
	if (!opts.length) return out;
	const [trs] = await pool.query(`SELECT id_option, id_lang, name FROM ${P}clients_field_options_lang WHERE id_option IN (?)`, [opts.map((o) => o.id)]);
	const byId = new Map(opts.map((o) => [o.id, { id: o.id, sort: o.sort, active: o.active, i18n: {} }]));
	for (const t of trs) if (byId.has(t.id_option)) byId.get(t.id_option).i18n[t.id_lang] = t.name;
	for (const o of opts) (out[o.id_field] = out[o.id_field] || []).push(byId.get(o.id));
	return out;
}

/**
 * options: { idLang: ["Варіант 1", "Варіант 2", ...] } — рядок N у кожній мові = той самий варіант.
 * Наявні варіанти зберігають id за позицією (значення клієнтів не губляться).
 * Зайві: використані — вимикаються, невикористані — видаляються.
 */
async function syncOptions(conn, idField, options, langs) {
	const defLang = langs.length ? langs[0].id : 1;
	const clean = (a) => (Array.isArray(a) ? a : String(a || "").split("\n")).map((x) => String(x).trim().slice(0, 255));
	const base = clean(options[defLang]).filter(Boolean);
	const count = base.length;

	const [cur] = await conn.query(`SELECT id FROM ${P}clients_field_options WHERE id_field = ? ORDER BY sort, id`, [idField]);

	for (let i = 0; i < count; i++) {
		let idOpt = cur[i] ? cur[i].id : null;
		if (idOpt) {
			await conn.query(`UPDATE ${P}clients_field_options SET sort = ?, active = 1 WHERE id = ?`, [(i + 1) * 10, idOpt]);
		} else {
			const [ins] = await conn.query(`INSERT INTO ${P}clients_field_options (id_field, sort, active) VALUES (?, ?, 1)`, [idField, (i + 1) * 10]);
			idOpt = ins.insertId;
		}
		for (const l of langs) {
			const lines = l.id === defLang ? base : clean(options[l.id]);
			const name = lines[i] || "";
			await conn.query(
				`INSERT INTO ${P}clients_field_options_lang (id_option, id_lang, name) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE name = VALUES(name)`,
				[idOpt, l.id, name]
			);
		}
	}

	for (const extra of cur.slice(count)) {
		const [[u]] = await conn.query(
			`SELECT COUNT(*) AS n FROM ${P}clients_field_values
              WHERE id_field = ? AND (id_option = ? OR JSON_CONTAINS(COALESCE(value_json, JSON_ARRAY()), CAST(? AS JSON)))`,
			[idField, extra.id, String(extra.id)]
		);
		if (Number(u.n) > 0) await conn.query(`UPDATE ${P}clients_field_options SET active = 0 WHERE id = ?`, [extra.id]);
		else await conn.query(`DELETE FROM ${P}clients_field_options WHERE id = ?`, [extra.id]);
	}
}

module.exports = { SETTINGS, describe, listRows, saveRow, deleteRow, sortRows, loadOptions };
