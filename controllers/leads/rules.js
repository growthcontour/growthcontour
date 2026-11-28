"use strict";

/**
 * Правила етапів воронки (перевіряються на сервері при кожній зміні етапу чи статусу — з картки, канбану, створення):
 *   - обов'язкові поля для входу на етап: leads_pipeline_stages.required_fields — JSON-масив ключів із FIELDS
 *     (напр. ["value", "contact.phone"]); contact.any — телефон або email;
 *   - заборона повернення: lock_back = 1 — з цього етапу не можна перейти на етап з меншим порядком (sort);
 *   - програш: перехід на етап або статус з system_type = 'lost' вимагає причину програшу (id_loss_reason).
 * Помилки повертаються по полях ({ поле: текст }) + список missing — канбан за ним питає значення у вікні.
 */

const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;

/** Поля, які можна зробити обов'язковими для етапу */
const FIELDS = ["value", "expected_close_date", "id_source", "id_manager", "id_priority", "id_temperature", "id_qualification", "website", "note", "contact.name", "contact.phone", "contact.email", "contact.any", "contact.company", "contact.position"];

const parse = (v, def) => {
	if (v === null || v === undefined) return def;
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return def;
	}
};

/** Обов'язкові поля етапу (лише відомі ключі) */
const requiredOf = (stage) => (parse(stage && stage.required_fields, []) || []).filter((k) => FIELDS.includes(k));

/** Порожнє значення поля в стані ліда після змін */
function empty(state, key) {
	if (key === "contact.any") return !String(state.contact.phone || "").trim() && !String(state.contact.email || "").trim();
	if (key.startsWith("contact.")) return !String(state.contact[key.slice(8)] || "").trim();
	const v = state[key];
	if (key === "value") return !(Number(v) > 0);
	return v === null || v === undefined || String(v).trim() === "" || (key.startsWith("id_") && !Number(v));
}

/**
 * Перевірка змін ліда. lead — поточний запис (для нового — {}), values — нові значення (як у збереженні:
 * contact_info — об'єкт полів картки). t — переклад. conn — з'єднання транзакції (необов'язково).
 * Повертає { errors, missing } — порожні, якщо все гаразд.
 */
async function check(lead, values, t, conn) {
	const db = conn || pool;
	const errors = {};
	const missing = [];
	const has = (f) => Object.prototype.hasOwnProperty.call(values, f);
	const stageFrom = lead.id_stage ? Number(lead.id_stage) : null;
	const stageTo = has("id_stage") ? (values.id_stage ? Number(values.id_stage) : null) : stageFrom;
	const statusTo = has("id_status") ? Number(values.id_status) || null : Number(lead.id_status) || null;
	const stageChanged = stageTo !== stageFrom;
	const statusChanged = has("id_status") && statusTo !== (Number(lead.id_status) || null);
	if (!stageChanged && !statusChanged) return { errors, missing };

	const ids = [stageFrom, stageTo].filter(Boolean);
	const [stages] = ids.length ? await db.query(`SELECT id, id_pipeline, sort, system_type, lock_back, required_fields FROM \`${P}leads_pipeline_stages\` WHERE id IN (?)`, [ids]) : [[]];
	const from = stages.find((s) => s.id === stageFrom) || null;
	const to = stages.find((s) => s.id === stageTo) || null;

	// Стан ліда після змін
	const state = { ...lead, ...values };
	state.contact = has("contact_info") && values.contact_info && typeof values.contact_info === "object" ? values.contact_info : parse(lead.contact_info, {}) || {};

	if (stageChanged && to) {
		if (from && Number(from.lock_back) && Number(from.id_pipeline) === Number(to.id_pipeline) && Number(to.sort) < Number(from.sort) && !["won", "lost"].includes(to.system_type)) {
			errors.id_stage = t("leads.rules.e.lock_back");
		}
		for (const key of requiredOf(to)) {
			if (!empty(state, key)) continue;
			missing.push(key);
			errors[key] = t("leads.rules.e.required");
		}
	}
	// Програш — лише з причиною
	let lost = stageChanged && to && to.system_type === "lost";
	if (!lost && statusChanged && statusTo) {
		const [[st]] = await db.query(`SELECT system_type FROM \`${P}leads_settings_status\` WHERE id = ?`, [statusTo]);
		lost = !!st && st.system_type === "lost";
	}
	if (lost && empty(state, "id_loss_reason")) {
		missing.push("id_loss_reason");
		errors.id_loss_reason = t("leads.rules.e.loss_reason");
	}
	return { errors, missing };
}

/** Правила етапів воронки — для сторінки налаштувань і форм (позначка «обов'язкове») */
async function stagesOf(idPipeline, idLang) {
	const [rows] = await pool.query(
		`SELECT s.id, s.id_pipeline, COALESCE(sl.name, CONCAT('#', s.id)) AS name, s.color, s.system_type, s.sla_hours, s.lock_back, s.required_fields, s.is_active, s.sort
		   FROM \`${P}leads_pipeline_stages\` s
		   LEFT JOIN \`${P}leads_pipeline_stages_lang\` sl ON sl.id_stage = s.id AND sl.id_lang = ?
		  WHERE ${idPipeline ? "s.id_pipeline = ?" : "1 = 1"} ORDER BY s.id_pipeline, s.sort, s.id`,
		idPipeline ? [idLang, idPipeline] : [idLang]
	);
	return rows.map((r) => ({ ...r, required_fields: requiredOf(r) }));
}

/** Зберегти правила етапів однієї воронки: [{ id, sla_hours, lock_back, required_fields }] */
async function saveStages(idPipeline, list) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		for (const s of Array.isArray(list) ? list : []) {
			const id = parseInt(s.id, 10);
			if (!id) continue;
			const req = [...new Set((Array.isArray(s.required_fields) ? s.required_fields : []).filter((k) => FIELDS.includes(k)))];
			const hours = Math.max(0, Math.min(8760, parseInt(s.sla_hours, 10) || 0));
			await conn.query(`UPDATE \`${P}leads_pipeline_stages\` SET sla_hours = ?, lock_back = ?, required_fields = ?, date_edit = NOW() WHERE id = ? AND id_pipeline = ?`, [hours, s.lock_back ? 1 : 0, req.length ? JSON.stringify(req) : null, id, idPipeline]);
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	return { ok: true };
}

/** Назви полів правил мовою користувача: { "contact.phone": "Телефон", … } */
const labels = (t) => Object.fromEntries([...FIELDS, "id_loss_reason"].map((k) => [k, t(k === "id_loss_reason" ? "leads.view.f.id_loss_reason" : "leads.rules.f." + k)]));

module.exports = { FIELDS, labels, check, requiredOf, stagesOf, saveStages };