const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const dict = require("./dictionaries");
const history = require("./history");
const { loadOptions } = require("./settings");

const P = config.get("configDatabase").prefix;

function httpErr(status, message) {
	const e = new Error(message);
	e.status = status;
	return e;
}

const pickName = (i18n, idLang, defLang) => (i18n && (i18n[idLang] || i18n[defLang] || Object.values(i18n).find(Boolean))) || "";

/** Поля, що стосуються клієнта (за його kind), перекладені, з варіантами і значеннями */
async function forClient(idClient, idLang) {
	const [[c]] = await pool.query(`SELECT id, kind FROM ${P}clients WHERE id = ? LIMIT 1`, [idClient]);
	if (!c) throw httpErr(404, "Клієнта не знайдено.");

	const defs = await dict.list("field_defs", idLang, { activeOnly: true, kind: c.kind });
	if (!defs.length) return { fields: [] };

	const { defaultLangId } = await dict.languages();
	const opts = await loadOptions(defs.map((d) => d.id));
	const [vals] = await pool.query(`SELECT * FROM ${P}clients_field_values WHERE id_client = ?`, [idClient]);
	const byField = new Map(vals.map((v) => [v.id_field, v]));

	return {
		fields: defs.map((d) => {
			const v = byField.get(d.id) || {};
			const options = (opts[d.id] || []).map((o) => ({ id: o.id, active: Number(o.active) === 1, name: pickName(o.i18n, idLang, defaultLangId) }));
			return {
				id: d.id,
				code: d.code,
				type: d.field_type,
				name: d.name,
				placeholder: d.placeholder || "",
				required: Number(d.is_required) === 1,
				options,
				value: valueOf(d.field_type, v),
				text: textOf(d.field_type, v, options),
			};
		}),
	};
}

// Сире значення для форми
function valueOf(type, v) {
	switch (type) {
		case "number":
			return v.value_number != null ? Number(v.value_number) : null;
		case "date":
			return v.value_date ? fmtDate(v.value_date) : null;
		case "boolean":
			return v.value_number != null ? Number(v.value_number) === 1 : null;
		case "select":
			return v.id_option || null;
		case "multiselect":
			return parseJson(v.value_json) || [];
		default:
			return v.value_text || null;
	}
}

// Людський текст для картки та історії
function textOf(type, v, options) {
	const val = valueOf(type, v);
	if (val === null || val === undefined || (Array.isArray(val) && !val.length)) return null;
	if (type === "boolean") return val ? "так" : "ні";
	if (type === "select") return (options.find((o) => o.id === val) || {}).name || null;
	if (type === "multiselect")
		return (
			options
				.filter((o) => val.includes(o.id))
				.map((o) => o.name)
				.join(", ") || null
		);
	return String(val);
}

function fmtDate(d) {
	if (typeof d === "string") return d.slice(0, 10);
	const p = (n) => String(n).padStart(2, "0");
	return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function parseJson(x) {
	if (x == null) return null;
	if (typeof x !== "string") return x;
	try {
		return JSON.parse(x);
	} catch (e) {
		return null;
	}
}

/**
 * Зберегти значення: body.values = { idField: value }.
 * Порожнє значення видаляє рядок. Кожна зміна — в історію (текстом, не id).
 */
async function saveForClient(idClient, body, h, idLang) {
	const input = (body && body.values) || {};
	const { fields } = await forClient(idClient, idLang);
	const hc = h && h.batch ? h : history.ctx({ id_user: h });

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		await conn.query(`SELECT id FROM ${P}clients WHERE id = ? FOR UPDATE`, [idClient]);

		const log = [];
		for (const f of fields) {
			if (!(String(f.id) in input)) continue;
			const raw = input[f.id];
			const row = { value_text: null, value_number: null, value_date: null, id_option: null, value_json: null };
			let empty = raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && !raw.length);

			if (!empty) {
				switch (f.type) {
					case "number": {
						const n = Number(String(raw).replace(",", "."));
						if (!isFinite(n)) throw httpErr(400, `«${f.name}»: введіть число.`);
						row.value_number = n;
						break;
					}
					case "date":
						if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) throw httpErr(400, `«${f.name}»: невірна дата.`);
						row.value_date = raw;
						break;
					case "boolean":
						row.value_number = raw === true || raw === 1 || raw === "1" ? 1 : 0;
						break;
					case "select": {
						const id = parseInt(raw, 10);
						if (!f.options.some((o) => o.id === id)) throw httpErr(400, `«${f.name}»: невідомий варіант.`);
						row.id_option = id;
						break;
					}
					case "multiselect": {
						const ids = [...new Set((Array.isArray(raw) ? raw : [raw]).map((x) => parseInt(x, 10)))].filter((id) => f.options.some((o) => o.id === id));
						if (!ids.length) empty = true;
						else row.value_json = JSON.stringify(ids);
						break;
					}
					case "email":
						if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(raw).trim())) throw httpErr(400, `«${f.name}»: невірний email.`);
						row.value_text = String(raw).trim().toLowerCase().slice(0, 255);
						break;
					case "url": {
						const u = String(raw).trim();
						if (!/^https?:\/\/\S+$/i.test(u)) throw httpErr(400, `«${f.name}»: посилання має починатися з http:// або https://`);
						row.value_text = u.slice(0, 2000);
						break;
					}
					case "textarea":
						row.value_text = String(raw).trim().slice(0, 10000);
						break;
					default:
						row.value_text = String(raw).trim().slice(0, 1000);
				}
			}
			if (empty && f.required) throw httpErr(400, `Заповніть «${f.name}».`);

			const newText = empty ? null : textOf(f.type, { ...row, value_json: row.value_json }, f.options);
			if (newText === f.text) continue;

			if (empty) {
				await conn.query(`DELETE FROM ${P}clients_field_values WHERE id_client = ? AND id_field = ?`, [idClient, f.id]);
			} else {
				await conn.query(
					`INSERT INTO ${P}clients_field_values (id_client, id_field, value_text, value_number, value_date, id_option, value_json, date_edit)
                     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
                     ON DUPLICATE KEY UPDATE value_text = VALUES(value_text), value_number = VALUES(value_number), value_date = VALUES(value_date),
                        id_option = VALUES(id_option), value_json = VALUES(value_json), date_edit = NOW()`,
					[idClient, f.id, row.value_text, row.value_number, row.value_date, row.id_option, row.value_json]
				);
			}
			log.push({ id_client: idClient, action: "updated", entity: "field", id_entity: f.id, field: f.name.slice(0, 64), value_old: f.text, value_new: newText });
		}

		if (log.length) {
			await conn.query(`UPDATE ${P}clients SET date_edit = NOW(), id_user_edit = ? WHERE id = ?`, [hc.id_user, idClient]);
			await history.write(conn, hc, log);
		}
		await conn.commit();
		return { ok: true, changed: log.length };
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

module.exports = { forClient, saveForClient };
