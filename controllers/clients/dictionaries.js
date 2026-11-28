const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;

// Ключ довідника → таблиця і поле зв'язку в _lang
const DICTS = {
	legal_types: { table: "clients_legal_types", fk: "id_legal_type" },
	identifier_types: { table: "clients_identifier_types", fk: "id_identifier_type" },
	contact_types: { table: "clients_contact_types", fk: "id_contact_type" },
	address_types: { table: "clients_address_types", fk: "id_address_type" },
	relationship_types: { table: "clients_relationship_types", fk: "id_relationship_type" },
	role_types: { table: "clients_role_types", fk: "id_role_type" },
	lifecycle_stages: { table: "clients_lifecycle_stages", fk: "id_stage" },
	tags: { table: "clients_tags", fk: "id_tag" },
	field_defs: { table: "clients_field_defs", fk: "id_field" },
};

const TTL_MS = 60 * 1000;
let cache = null;
let loadedAt = 0;
let loading = null;

async function loadAll() {
	const [langs] = await pool.query(`SELECT id, iso, name FROM ${P}languages WHERE active = 1 ORDER BY sort, id`);
	const out = {
		langs,
		defaultLangId: langs.length ? langs[0].id : 1,
		dicts: {},
	};

	for (const [key, d] of Object.entries(DICTS)) {
		const [rows] = await pool.query(`SELECT * FROM ${P}${d.table} ORDER BY sort, id`);
		const [trs] = await pool.query(`SELECT * FROM ${P}${d.table}_lang`);

		const byId = new Map();
		const byCode = new Map();
		rows.forEach((r) => {
			r.i18n = {};
			byId.set(r.id, r);
			if (r.code) byCode.set(r.code, r);
		});
		trs.forEach((t) => {
			const r = byId.get(t[d.fk]);
			if (!r) return;
			const { id, id_lang, [d.fk]: _omit, ...fields } = t;
			r.i18n[id_lang] = fields;
		});

		out.dicts[key] = { rows, byId, byCode };
	}
	return out;
}

async function ensure() {
	if (cache && Date.now() - loadedAt < TTL_MS) return cache;
	if (!loading) {
		loading = loadAll()
			.then((c) => {
				cache = c;
				loadedAt = Date.now();
				loading = null;
				return c;
			})
			.catch((e) => {
				loading = null;
				throw e;
			});
	}
	return loading;
}

// Скинути кеш (після редагування довідника в адмінці)
function invalidate() {
	cache = null;
	loadedAt = 0;
}

// Переклад поля з запасним варіантом: мова → мова за замовчуванням → будь-яка
function translate(c, row, idLang, field) {
	const f = field || "name";
	const i18n = (row && row.i18n) || {};
	if (i18n[idLang] && i18n[idLang][f]) return i18n[idLang][f];
	if (i18n[c.defaultLangId] && i18n[c.defaultLangId][f]) return i18n[c.defaultLangId][f];
	const any = Object.values(i18n).find((x) => x && x[f]);
	return any ? any[f] : row && row.code ? row.code : "";
}

// Рядок довідника без i18n, але з перекладеними полями для конкретної мови
function localize(c, row, idLang) {
	if (!row) return null;
	const { i18n, ...base } = row;
	const out = { ...base };
	const sample = Object.values(i18n || {})[0] || {};
	Object.keys(sample).forEach((f) => {
		out[f] = translate(c, row, idLang, f);
	});
	if (!("name" in out)) out.name = translate(c, row, idLang, "name");
	return out;
}

async function byCode(key, code) {
	const c = await ensure();
	const d = c.dicts[key];
	return d ? d.byCode.get(code) || null : null;
}

async function byId(key, id) {
	const c = await ensure();
	const d = c.dicts[key];
	return d ? d.byId.get(Number(id)) || null : null;
}

async function idOf(key, code) {
	const r = await byCode(key, code);
	return r ? r.id : null;
}

/**
 * Список для інтерфейсу (select, фільтри), перекладений на мову idLang.
 * opts.activeOnly (true), opts.kind ('person' | 'organization' | 'group'), opts.country ('UA', 'PL'...)
 */
async function list(key, idLang, opts) {
	const o = Object.assign({ activeOnly: true }, opts || {});
	const c = await ensure();
	const d = c.dicts[key];
	if (!d) return [];

	return d.rows
		.filter((r) => !o.activeOnly || r.active === undefined || Number(r.active) === 1)
		.filter((r) => {
			if (!o.kind) return true;
			if (r.kind) return r.kind === o.kind;
			if (r.applies_kind) return r.applies_kind === "all" || r.applies_kind === o.kind;
			if (r.from_kind) return r.from_kind === "all" || r.from_kind === o.kind;
			return true;
		})
		.filter((r) => {
			if (!o.country || !("country" in r)) return true;
			return !r.country || r.country === o.country;
		})
		.map((r) => localize(c, r, idLang));
}

async function languages() {
	const c = await ensure();
	return { list: c.langs, defaultLangId: c.defaultLangId };
}

module.exports = { DICTS, ensure, invalidate, byCode, byId, idOf, list, languages, translate: async (row, idLang, field) => translate(await ensure(), row, idLang, field) };