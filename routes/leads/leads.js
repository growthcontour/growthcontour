const express = require("express");
const router = express.Router();

// Controllers
const authorizationControllers = require("../../controllers/authorization/authorization");
// END Controllers

//Database connection
const connection = require("../../config/database/database");
const connection_pool = require("../../config/database/connection_pool");
//END Database connection

// Logging
const logging = require("../../logging/logging");
// END Logging

// Configuration
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
// END Configuration

//  Validator
// END Validator

const { getIO } = require("../../controllers/socket/socket");
const io = getIO();

// GET
router.get("/leads", authorizationControllers.isAuthenticated, (req, res) => {
	res.render("pages/leads/index", {
		i18n: req, // Передаємо об'єкт i18n
		user: req.user,
		canAdd: authorizationControllers.hasPermission(req, "leads.list", "add"),
		canEdit: authorizationControllers.hasPermission(req, "leads.list", "edit"),
		canDelete: authorizationControllers.hasPermission(req, "leads.list", "delete"),
		bulkMax: require("../../controllers/leads/bulk").BULK_MAX,
		header: {
			navbar: "leads",
		},
	});
});

// GET — сторінка ліда
router.get("/leads/:id/", authorizationControllers.isAuthenticated, async (req, res, next) => {
	// Не номер (settings тощо) — це інша сторінка, її маршрут нижче
	if (!/^\d+$/.test(req.params.id)) return next();
	try {
		const id = parseInt(req.params.id);
		const id_lang = req.user.id_lang || 1;

		const [[lead]] = await connection_pool.query(
			`
            SELECT l.*,
                sl.name            AS status_name,
                s.color_text       AS status_color_text,
                s.color_background AS status_color_background,
                s.system_type      AS status_system_type,
                psl.name           AS stage_name,
                ps.color           AS stage_color,
                pl.name            AS pipeline_name,
				src_l.name         AS source_name,
                cl.display_name    AS client_name,
                clo.display_name   AS client_org_name,
                TIMESTAMPDIFF(SECOND, NOW(), l.response_deadline) AS sla_left,
                TIMESTAMPDIFF(SECOND, l.date_add, l.first_response_at) AS response_sec
            FROM \`${configDatabase.prefix}leads\` l
            LEFT JOIN \`${configDatabase.prefix}leads_settings_status\` s       ON s.id = l.id_status
            LEFT JOIN \`${configDatabase.prefix}leads_settings_status_lang\` sl ON sl.id_status = s.id AND sl.id_lang = ?
            LEFT JOIN \`${configDatabase.prefix}leads_pipeline_stages\` ps      ON ps.id = l.id_stage
            LEFT JOIN \`${configDatabase.prefix}leads_pipeline_stages_lang\` psl ON psl.id_stage = ps.id AND psl.id_lang = ?
            LEFT JOIN \`${configDatabase.prefix}leads_pipelines_lang\` pl       ON pl.id_pipeline = l.id_pipeline AND pl.id_lang = ?
            LEFT JOIN \`${configDatabase.prefix}leads_sources\` src             ON src.id = l.id_source
            LEFT JOIN \`${configDatabase.prefix}leads_sources_lang\` src_l      ON src_l.id_source = src.id AND src_l.id_lang = ?
            LEFT JOIN \`${configDatabase.prefix}clients\` cl                    ON cl.id = l.id_client
            LEFT JOIN \`${configDatabase.prefix}clients\` clo                   ON clo.id = l.id_client_org
            WHERE l.id = ? AND l.deleted_at IS NULL
            LIMIT 1
        `,
			[id_lang, id_lang, id_lang, id_lang, id]
		);

		if (!lead) return res.status(404).send("Lead not found");

		// JSON поля — парсимо якщо рядок
		["contact_info", "utm", "fingerprint", "custom_fields"].forEach((f) => {
			if (typeof lead[f] === "string") {
				try {
					lead[f] = JSON.parse(lead[f]);
				} catch {
					lead[f] = {};
				}
			}
			lead[f] = lead[f] || {};
		});

		// Статуси для select
		const [statuses] = await connection_pool.query(
			`
            SELECT s.id, s.color_text, s.color_background, s.icon, s.system_type, sl.name
            FROM \`${configDatabase.prefix}leads_settings_status\` s
            LEFT JOIN \`${configDatabase.prefix}leads_settings_status_lang\` sl ON sl.id_status = s.id AND sl.id_lang = ?
            WHERE s.is_active = 1 ORDER BY s.sort
        `,
			[id_lang]
		);

		// Pipeline stages
		const [stages] = await connection_pool.query(
			`
            SELECT ps.id, ps.color, ps.icon, ps.probability, ps.system_type, psl.name
            FROM \`${configDatabase.prefix}leads_pipeline_stages\` ps
            LEFT JOIN \`${configDatabase.prefix}leads_pipeline_stages_lang\` psl ON psl.id_stage = ps.id AND psl.id_lang = ?
            WHERE ps.id_pipeline = ? AND ps.is_active = 1 ORDER BY ps.sort
        `,
			[id_lang, lead.id_pipeline || 0]
		);

		// Джерела
		const [sources] = await connection_pool.query(
			`
            SELECT src.id, sl.name
            FROM \`${configDatabase.prefix}leads_sources\` src
            LEFT JOIN \`${configDatabase.prefix}leads_sources_lang\` sl ON sl.id_source = src.id AND sl.id_lang = ?
            WHERE src.is_active = 1 ORDER BY src.sort
        `,
			[id_lang]
		);

		// Пріоритети
		const [priorities] = await connection_pool.query(
			`
            SELECT p.id, p.color_text, p.color_background, p.icon, pl.name
            FROM \`${configDatabase.prefix}leads_priorities\` p
            LEFT JOIN \`${configDatabase.prefix}leads_priorities_lang\` pl ON pl.id_priority = p.id AND pl.id_lang = ?
            WHERE p.is_active = 1 ORDER BY p.sort
        `,
			[id_lang]
		);

		// Температури
		const [temperatures] = await connection_pool.query(
			`
            SELECT t.id, t.slug, t.color_text, t.color_background, t.icon, tl.name
            FROM \`${configDatabase.prefix}leads_temperatures\` t
            LEFT JOIN \`${configDatabase.prefix}leads_temperatures_lang\` tl ON tl.id_temperature = t.id AND tl.id_lang = ?
            WHERE t.is_active = 1 ORDER BY t.sort
        `,
			[id_lang]
		);

		// Кваліфікації
		const [qualifications] = await connection_pool.query(
			`
            SELECT q.id, q.slug, q.color_text, q.color_background, q.icon, ql.name, ql.description
            FROM \`${configDatabase.prefix}leads_qualifications\` q
            LEFT JOIN \`${configDatabase.prefix}leads_qualifications_lang\` ql ON ql.id_qualification = q.id AND ql.id_lang = ?
            WHERE q.is_active = 1 ORDER BY q.sort
        `,
			[id_lang]
		);

		// Теги ліда
		const [tags] = await connection_pool.query(
			`
            SELECT t.id, t.color, tl.name
            FROM \`${configDatabase.prefix}leads_tags_rel\` tr
            JOIN \`${configDatabase.prefix}leads_tags\` t ON t.id = tr.id_tag
            JOIN \`${configDatabase.prefix}leads_tags_lang\` tl ON tl.id_tag = t.id AND tl.id_lang = ?
            WHERE tr.id_lead = ?
        `,
			[id_lang, id]
		);

		// Всі теги (для select)
		const [all_tags] = await connection_pool.query(
			`
            SELECT t.id, t.color, tl.name
            FROM \`${configDatabase.prefix}leads_tags\` t
            JOIN \`${configDatabase.prefix}leads_tags_lang\` tl ON tl.id_tag = t.id AND tl.id_lang = ?
            WHERE t.is_active = 1 ORDER BY t.sort
        `,
			[id_lang]
		);

		// Причини програшу
		const [loss_reasons] = await connection_pool.query(
			`
            SELECT r.id, rl.name
            FROM \`${configDatabase.prefix}leads_loss_reasons\` r
            LEFT JOIN \`${configDatabase.prefix}leads_loss_reasons_lang\` rl ON rl.id_reason = r.id AND rl.id_lang = ?
            WHERE r.is_active = 1 ORDER BY r.sort
        `,
			[id_lang]
		);

		// Відповідальні (активні користувачі)
		const [managers] = await connection_pool.query(`SELECT id, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM \`${configDatabase.prefix}users\` WHERE active = 1 OR id = ? ORDER BY first_name, last_name`, [lead.id_manager || 0]);

		res.render("pages/leads/view", {
			i18n: req,
			user: req.user,
			header: { navbar: "leads" },
			canEdit: authorizationControllers.hasPermission(req, "leads.list", "edit"),
			canDelete: authorizationControllers.hasPermission(req, "leads.list", "delete"),
			scoreAuto: await require("../../controllers/leads/scoring").autoTypes(),
			managers,
			maxFileSize: require("../../controllers/chat/files").MAX_SIZE,
			lead,
			statuses,
			stages,
			sources,
			priorities,
			temperatures,
			qualifications,
			tags,
			all_tags,
			loss_reasons,
		});
	} catch (error) {
		console.error(error);
		logging.error(error);
		res.status(500).send("Server error");
	}
});

/**
 * Збереження картки ліда кнопкою «Зберегти» (режим редагування): усі змінені поля — одним запитом, в одній транзакції.
 * Тіло: { date_edit: «стан, який редагували», force?: true, changes: { поле: значення, ... }, tags?: [id, ...] }
 * Хтось інший зберіг лід після відкриття форми (date_edit не збігається) → 409, без force нічого не пишеться.
 * Відповідь: { ok, changed: [поля], date_edit, score, grade, client }.
 */
const LEAD_SAVE = {
	title: { t: "str", max: 500, required: true },
	note: { t: "text", max: 65000 },
	value: { t: "num", min: 0, max: 99999999999 },
	website: { t: "str", max: 255 },
	expected_close_date: { t: "date", nullable: true },
	loss_note: { t: "text", max: 65000, nullable: true },
	score_fit: { t: "int", min: 0, max: 100 },
	score_activity: { t: "int", min: 0, max: 100 },
	id_status: { t: "ref", table: "leads_settings_status", required: true },
	id_stage: { t: "ref", table: "leads_pipeline_stages", nullable: true },
	id_priority: { t: "ref", table: "leads_priorities", nullable: true },
	id_temperature: { t: "ref", table: "leads_temperatures", nullable: true },
	id_qualification: { t: "ref", table: "leads_qualifications", nullable: true },
	id_source: { t: "ref", table: "leads_sources", nullable: true },
	id_loss_reason: { t: "ref", table: "leads_loss_reasons", nullable: true },
	id_manager: { t: "ref", table: "users", nullable: true },
	contact_info: { t: "contact" },
};
const CONTACT_KEYS = ["name", "phone", "email", "company", "position"];

/** Значення поля з форми → значення для бази; помилка → { error } */
function leadValue(field, v) {
	const d = LEAD_SAVE[field];
	const empty = v === null || v === undefined || String(v).trim() === "";
	if (d.t === "contact") {
		const src = v && typeof v === "object" ? v : {};
		const out = {};
		for (const k of CONTACT_KEYS) {
			const x = String(src[k] ?? "").trim();
			if (x.length > 255) return { error: "too_long" };
			if (x) out[k] = x;
		}
		if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) return { error: "email" };
		if (out.phone && !/^[\d\s()+\-.]{5,32}$/.test(out.phone)) return { error: "phone" };
		return { value: out };
	}
	if (empty) {
		if (d.required) return { error: "required" };
		if (d.nullable) return { value: null };
		return { value: d.t === "num" || d.t === "int" ? 0 : "" };
	}
	const str = String(v).trim();
	if (d.t === "str" || d.t === "text") return str.length > d.max ? { error: "too_long" } : { value: str };
	if (d.t === "date") return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(Date.parse(str)) ? { value: str } : { error: "date" };
	const n = Number(str.replace(",", "."));
	if (!Number.isFinite(n)) return { error: "number" };
	if (d.t === "ref") return Number.isInteger(n) && n > 0 ? { value: n } : { error: "number" };
	if (d.t === "int" && !Number.isInteger(n)) return { error: "number" };
	if (n < d.min || n > d.max) return { error: "range" };
	return { value: d.t === "num" ? Math.round(n * 10000) / 10000 : n };
}

/** Значення для порівняння й історії: рядок (числа — без зайвих нулів, JSON — канонічний) */
function leadStr(field, v) {
	if (v === null || v === undefined) return "";
	const d = LEAD_SAVE[field];
	if (d && d.t === "contact") {
		const o = typeof v === "string" ? JSON.parse(v || "{}") : v || {};
		return JSON.stringify(Object.fromEntries(CONTACT_KEYS.filter((k) => o[k]).map((k) => [k, String(o[k])])));
	}
	if (d && (d.t === "num" || d.t === "int" || d.t === "ref")) return String(Number(v));
	if (d && d.t === "date") return String(v).slice(0, 10);
	return String(v);
}

router.post("/api/leads/:id/save/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ message: req.__("leads.server.bad_id") });
	const b = req.body || {};
	const changes = b.changes && typeof b.changes === "object" ? b.changes : {};
	const idUser = req.user.userId || req.user.id;
	const P = configDatabase.prefix;

	// Перевірка значень до транзакції: помилки — по полях, щоб форма показала їх біля поля
	const values = {};
	const errors = {};
	for (const [field, raw] of Object.entries(changes)) {
		if (!LEAD_SAVE[field]) continue;
		const r = leadValue(field, raw);
		if (r.error) errors[field] = req.__("leads.view.e." + r.error);
		else values[field] = r.value;
	}
	const tags = Array.isArray(b.tags) ? [...new Set(b.tags.map(Number).filter((x) => Number.isInteger(x) && x > 0))] : null;
	if (Object.keys(errors).length) return res.status(400).json({ message: req.__("leads.view.e.check"), errors });

	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();
		const [[lead]] = await conn.query(`SELECT * FROM \`${P}leads\` WHERE id = ? AND deleted_at IS NULL FOR UPDATE`, [id]);
		if (!lead) {
			await conn.rollback();
			return res.status(404).json({ message: req.__("leads.server.not_found") });
		}
		// Хтось зберіг лід, поки його редагували
		if (!b.force && String(b.date_edit || "") !== String(lead.date_edit)) {
			const [[last]] = await conn.query(
				`SELECT h.date_add, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS who
				   FROM \`${P}leads_history\` h LEFT JOIN \`${P}users\` u ON u.id = h.id_manager
				  WHERE h.id_lead = ? ORDER BY h.id DESC LIMIT 1`,
				[id]
			);
			await conn.rollback();
			return res.status(409).json({ conflict: true, who: last ? last.who : null, at: lead.date_edit });
		}

		// Посилання на довідники мають існувати; етап — лише з воронки ліда
		for (const [field, v] of Object.entries(values)) {
			const d = LEAD_SAVE[field];
			if (d.t !== "ref" || v === null) continue;
			const [[row]] = await conn.query(`SELECT * FROM \`${P}${d.table}\` WHERE id = ? LIMIT 1`, [v]);
			if (!row || (field === "id_stage" && lead.id_pipeline && Number(row.id_pipeline) !== Number(lead.id_pipeline))) errors[field] = req.__("leads.view.e.ref");
		}
		// Правила етапів: обов'язкові поля, заборона повернення, причина програшу (controllers/leads/rules.js)
		const rules = Object.keys(errors).length ? { errors: {}, missing: [] } : await require("../../controllers/leads/rules").check(lead, values, (k) => req.__(k), conn);
		Object.assign(errors, rules.errors);
		if (Object.keys(errors).length) {
			await conn.rollback();
			return res.status(400).json({ message: req.__(rules.missing.length || rules.errors.id_stage ? "leads.rules.e.check" : "leads.view.e.check"), errors, missing: rules.missing });
		}

		const now = new Date();
		const pad = (x) => String(x).padStart(2, "0");
		const nowSql = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
		const set = {};
		const history = [];
		for (const [field, v] of Object.entries(values)) {
			const oldS = leadStr(field, lead[field]);
			const newS = leadStr(field, v);
			if (oldS === newS) continue;
			if (LEAD_SAVE[field].t === "contact") {
				// Інші ключі контактів (з форм сайтів, месенджери) не губляться — міняються лише поля картки
				const prev = typeof lead.contact_info === "string" ? JSON.parse(lead.contact_info || "{}") : lead.contact_info || {};
				const merged = Object.fromEntries(Object.entries(prev).filter(([k]) => !CONTACT_KEYS.includes(k)));
				set[field] = JSON.stringify({ ...merged, ...v });
			} else set[field] = v;
			history.push([id, idUser, "field_change", field, oldS, newS, null, "web", req.ip, nowSql]);
		}
		// Текстові дублікати довідників (список і фільтри читають їх): температура й кваліфікація — slug
		for (const [field, col, table] of [["id_temperature", "temperature", "leads_temperatures"], ["id_qualification", "qualification", "leads_qualifications"]]) {
			if (set[field] === undefined || set[field] === null) continue;
			const [[r]] = await conn.query(`SELECT slug FROM \`${P}${table}\` WHERE id = ?`, [set[field]]);
			if (r && r.slug) set[col] = r.slug;
		}
		// Складові, що рахуються правилами скорингу, вручну не змінюються (controllers/leads/scoring.js)
		const scoreAuto = await require("../../controllers/leads/scoring").autoTypes();
		if (scoreAuto.fit) delete set.score_fit;
		if (scoreAuto.activity) delete set.score_activity;
		if (set.score_fit !== undefined || set.score_activity !== undefined) {
			const total = Number(set.score_fit ?? lead.score_fit ?? 0) + Number(set.score_activity ?? lead.score_activity ?? 0);
			set.score = total;
			set.grade = total >= 80 ? "A" : total >= 60 ? "B" : total >= 40 ? "C" : "D";
		}

		// Теги: повний набір із форми
		let tagsChanged = false;
		if (tags) {
			const [cur] = await conn.query(`SELECT id_tag FROM \`${P}leads_tags_rel\` WHERE id_lead = ? ORDER BY id_tag`, [id]);
			const oldT = cur.map((r) => Number(r.id_tag)).sort((x, y) => x - y);
			const [okRows] = tags.length ? await conn.query(`SELECT id FROM \`${P}leads_tags\` WHERE id IN (?)`, [tags]) : [[]];
			const newT = okRows.map((r) => Number(r.id)).sort((x, y) => x - y);
			if (oldT.join(",") !== newT.join(",")) {
				tagsChanged = true;
				await conn.query(`DELETE FROM \`${P}leads_tags_rel\` WHERE id_lead = ?`, [id]);
				if (newT.length) await conn.query(`INSERT INTO \`${P}leads_tags_rel\` (id_lead, id_tag) VALUES ?`, [newT.map((t) => [id, t])]);
				history.push([id, idUser, "field_change", "tags", oldT.join(","), newT.join(","), null, "web", req.ip, nowSql]);
			}
		}

		if (!history.length) {
			await conn.rollback();
			return res.json({ ok: true, changed: [], date_edit: lead.date_edit });
		}
		set.date_edit = nowSql;
		await conn.query(`UPDATE \`${P}leads\` SET ? WHERE id = ?`, [set, id]);
		await conn.query(`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES ?`, [history]);
		await conn.commit();

		const changed = history.map((h) => h[3]);
		// Після коміту: контакти → перепривʼязка до картки клієнта; сповіщення відповідальним
		if (set.contact_info !== undefined) {
			try {
				await require("../../controllers/clients/links").linkLead(id, idUser);
				// Нові контакти — перевірка на дублікати заново (фонова служба лідів)
				await require("../../controllers/leads/dupes").recheck(id);
			} catch (e) {
				logging.error(e);
			}
		}
		// Новий етап до першої відповіді — час на відповідь за новим етапом
		if (set.id_stage !== undefined) {
			try {
				await require("../../controllers/leads/sla").arm(id);
			} catch (e) {
				logging.error(e);
			}
		}
		notifyLeadSaved(req, lead, set, changed, idUser);
		// Вебхуки: зміна ліда + окремі події статусу, етапу, відповідального
		const hooks = require("../../controllers/leads/webhooks");
		hooks.fire("lead.updated", id, { changes: changed });
		if (set.id_status !== undefined) hooks.fire("lead.status_changed", id, { previous: { id_status: lead.id_status } });
		if (set.id_stage !== undefined) hooks.fire("lead.stage_changed", id, { previous: { id_stage: lead.id_stage } });
		if (set.id_manager !== undefined) hooks.fire("lead.assigned", id, { previous: { id_manager: lead.id_manager } });

		// Автоматизації етапу / статусу: негайні виконуються тут, щоб сторінка отримала актуальну версію ліда
		let automated = 0;
		const auto = require("../../controllers/leads/automations");
		if (set.id_stage !== undefined) automated += await auto.emit("stage_enter", id, 0, { inline: true });
		if (set.id_status !== undefined) automated += await auto.emit("status_change", id, 0, { inline: true });
		// Скоринг за правилами — одразу, щоб сторінка показала нові бали
		await require("../../controllers/leads/scoring").recalc(id);

		const [[after]] = await connection_pool.query(
			`SELECT l.score, l.grade, l.score_fit, l.score_activity, l.date_edit, l.id_client, l.id_client_org, cl.display_name AS client_name, clo.display_name AS client_org_name
			   FROM \`${P}leads\` l
			   LEFT JOIN \`${P}clients\` cl ON cl.id = l.id_client
			   LEFT JOIN \`${P}clients\` clo ON clo.id = l.id_client_org
			  WHERE l.id = ?`,
			[id]
		);
		return res.json({ ok: true, changed, automated, tags_changed: tagsChanged, date_edit: after.date_edit, score: after.score, grade: after.grade, score_fit: after.score_fit, score_activity: after.score_activity, client: { id: after.id_client, name: after.client_name, id_org: after.id_client_org, org_name: after.client_org_name } });
	} catch (error) {
		await conn.rollback().catch(() => {});
		logging.error(error);
		return res.status(500).json({ message: req.__("leads.server.server") });
	} finally {
		conn.release();
	}
});

/**
 * Сповіщення про збереження ліда (ядро сповіщень, дзвіночок): відповідальному менеджеру
 * (і попередньому, якщо відповідального змінили). Хто зберіг — сам не отримує: бачить повідомлення на сторінці.
 */
function notifyLeadSaved(req, lead, set, changed, idUser) {
	try {
		const who = [lead.id_manager, set.id_manager].map(Number).filter((u, i, a) => u && u !== Number(idUser) && a.indexOf(u) === i);
		if (!who.length) return;
		const name = NULLIF_NAME(req.user);
		const labels = changed.map((f) => req.__("leads.view.f." + f));
		const { notify } = require("../../controllers/notifications");
		for (const u of who) {
			const assigned = set.id_manager !== undefined && Number(set.id_manager) === u;
			Promise.resolve(
				notify({
					type: assigned ? "leads.assigned" : "leads.updated",
					channels: ["inapp"],
					audience: { user: u },
					priority: assigned ? 6 : 4,
					payload: {
						title: req.__(assigned ? "leads.view.n.assigned" : "leads.view.n.updated", { id: String(lead.id) }),
						name: set.title || lead.title || "#" + lead.id,
						message: req.__("leads.view.n.message", { who: name, fields: labels.join(", ") }),
						url: `/leads/${lead.id}/`,
					},
				})
			).catch((e) => logging.error(e));
		}
	} catch (e) {
		logging.error(e);
	}
}
const NULLIF_NAME = (u) => [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || "#" + u.userId;

// PATCH — зберегти одне поле ліда
router.patch("/api/leads/:id/field/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const { field, value } = req.body;
		const id_manager = req.user.id;

		// Дозволені поля для оновлення
		const ALLOWED = ["title", "note", "value", "id_priority", "id_temperature", "id_qualification", "id_status", "id_stage", "id_pipeline", "id_source", "id_manager", "lead_source", "website", "capture_type", "capture_ref", "contact_info", "utm", "fingerprint", "custom_fields", "expected_close_date", "id_loss_reason", "loss_note", "score_fit", "score_activity"];
		if (!ALLOWED.includes(field)) {
			return res.status(400).json({ error: "Field not allowed" });
		}

		// Отримати старе значення для history
		const [[old]] = await connection_pool.query(`SELECT ?? FROM \`${configDatabase.prefix}leads\` WHERE id = ? LIMIT 1`, [field, id]);
		if (!old) return res.status(404).json({ error: "Lead not found" });

		const jsonFields = ["contact_info", "utm", "fingerprint", "custom_fields"];

		// Нормалізуємо старе значення для порівняння
		let value_old = old[field];
		if (jsonFields.includes(field) && typeof value_old === "string") {
			try {
				value_old = JSON.parse(value_old);
			} catch {
				value_old = {};
			}
		}

		// Порівнюємо — якщо нічого не змінилось, не пишемо
		const oldStr = typeof value_old === "object" ? JSON.stringify(value_old) : String(value_old ?? "");
		const newStr = typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
		if (oldStr === newStr) {
			return res.json({ ok: true, field, value, changed: false });
		}

		const dbValue = jsonFields.includes(field) ? JSON.stringify(value) : value;
		const now = new Date().toISOString().slice(0, 19).replace("T", " ");

		// Оновлюємо поле
		await connection_pool.query(`UPDATE \`${configDatabase.prefix}leads\` SET ?? = ?, date_edit = ? WHERE id = ?`, [field, dbValue, now, id]);

		// Перераховуємо score і grade
		if (field === "score_fit" || field === "score_activity") {
			const [[scores]] = await connection_pool.query(`SELECT score_fit, score_activity FROM \`${configDatabase.prefix}leads\` WHERE id = ?`, [id]);
			const total = (scores.score_fit || 0) + (scores.score_activity || 0);
			const grade = total >= 80 ? "A" : total >= 60 ? "B" : total >= 40 ? "C" : "D";
			await connection_pool.query(`UPDATE \`${configDatabase.prefix}leads\` SET score = ?, grade = ? WHERE id = ?`, [total, grade, id]);
		}

		// Пишемо в history
		await connection_pool.query(
			`INSERT INTO \`${configDatabase.prefix}leads_history\`
             (id_lead, id_manager, action_type, field_name, value_old, value_new, source, ip, date_add)
             VALUES (?, ?, 'field_change', ?, ?, ?, 'web', ?, ?)`,
			[id, id_manager, field, oldStr, newStr, req.ip, now]
		);

		// Контакти ліда змінились → перепривʼязати до картки клієнта
		if (field === "contact_info") {
			try {
				await require("../../controllers/clients/links").linkLead(id, req.user.userId || req.user.id);
			} catch (e) {
				logging.error(e);
			}
		}

		res.json({ ok: true, field, value, changed: true });
	} catch (error) {
		console.error(error);
		logging.error(error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

// POST — отримати history ліда
// Ризик клієнта: невикуп, чорний список, дублі (картка показує банер)
router.post("/api/leads/:id/risk/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id = parseInt(req.params.id, 10);
		const risk = id ? await require("../../controllers/clients/risk").forLead(id) : null;
		if (!risk) return res.status(404).json({ message: req.__("leads.server.not_found") });
		return res.status(200).json({ ok: true, risk });
	} catch (error) {
		logging.error(error);
		return res.status(500).json({ message: req.__("leads.server.server") });
	}
});

router.post("/api/leads/:id/history/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const id_lang = req.user.id_lang || 1;

		const [rows] = await connection_pool.query(
			`
            SELECT
                h.*,
                CONCAT(u.first_name, ' ', u.last_name) AS manager_name,
                -- Для id_status — підтягуємо назву статусу
                sl_old.name  AS status_old_name,
                sl_new.name  AS status_new_name,
                -- Для id_stage — підтягуємо назву кроку
                psl_old.name AS stage_old_name,
                psl_new.name AS stage_new_name
            FROM \`${configDatabase.prefix}leads_history\` h
            LEFT JOIN \`${configDatabase.prefix}users\` u
                ON u.id = h.id_manager
            -- Назва старого статусу
            LEFT JOIN \`${configDatabase.prefix}leads_settings_status_lang\` sl_old
                ON h.field_name = 'id_status'
                AND sl_old.id_status = h.value_old
                AND sl_old.id_lang = ?
            -- Назва нового статусу
            LEFT JOIN \`${configDatabase.prefix}leads_settings_status_lang\` sl_new
                ON h.field_name = 'id_status'
                AND sl_new.id_status = h.value_new
                AND sl_new.id_lang = ?
            -- Назва старого stage
            LEFT JOIN \`${configDatabase.prefix}leads_pipeline_stages_lang\` psl_old
                ON h.field_name = 'id_stage'
                AND psl_old.id_stage = h.value_old
                AND psl_old.id_lang = ?
            -- Назва нового stage
            LEFT JOIN \`${configDatabase.prefix}leads_pipeline_stages_lang\` psl_new
                ON h.field_name = 'id_stage'
                AND psl_new.id_stage = h.value_new
                AND psl_new.id_lang = ?
            WHERE h.id_lead = ?
            ORDER BY h.date_add DESC
        `,
			[id_lang, id_lang, id_lang, id_lang, id]
		);

		res.json(rows);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

// Сторінка налаштувань лідів (довідники) — routes/common/dictionaries.js
// END GET

// Отримати налаштування таблиці користувача
router.post("/api/leads/ui-settings/get/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id_user = req.user.id;
		const [rows] = await connection_pool.query(
			`SELECT value FROM \`${configDatabase.prefix}users_ui_settings\`
             WHERE id_user = ? AND \`key\` = 'leads_table' LIMIT 1`,
			[id_user]
		);
		if (rows.length === 0) return res.json(null);
		const val = typeof rows[0].value === "string" ? JSON.parse(rows[0].value) : rows[0].value;
		res.json(val);
	} catch (error) {
		console.error(error);
		logging.error(error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

// Зберегти налаштування таблиці користувача
router.post("/api/leads/ui-settings/save/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id_user = req.user.id;
		const value = JSON.stringify(req.body);
		const now = new Date().toISOString().slice(0, 19).replace("T", " ");
		await connection_pool.query(
			`INSERT INTO \`${configDatabase.prefix}users_ui_settings\`
                (id_user, \`key\`, value, date_add, date_edit)
             VALUES (?, 'leads_table', ?, ?, ?)
             ON DUPLICATE KEY UPDATE value = VALUES(value), date_edit = VALUES(date_edit)`,
			[id_user, value, now, now]
		);
		res.json({ ok: true });
	} catch (error) {
		console.error(error);
		logging.error(error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

// Список лідів
/**
 * Список лідів: фільтри, сортування й сторінки рахує сервер (у браузер — лише поточна сторінка).
 * Тіло (Tabulator remote): page, size, sort: [{ field, dir }], + фільтри (див. leadsWhere).
 */
const LIST_SORT = { id: "l.id", title: "l.title", value: "l.value", priority: "l.priority", score: "l.score", date_add: "l.date_add", status_name: "sl.name", stage_name: "psl.name", source_name: "src_l.name", next_at: "next_at" };

const { leadsWhere } = require("../../controllers/leads/bulk");

router.post("/api/leads/list/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const P = configDatabase.prefix;
		const b = req.body || {};
		const id_lang = req.user.id_lang || 1;
		const leadScope = require("../../controllers/leads/access").scope(req, "l");
		const f = leadsWhere(b, req.user.userId || req.user.id);
		const size = [10, 20, 50, 100].includes(Number(b.size)) ? Number(b.size) : 20;
		const page = Math.max(1, parseInt(b.page, 10) || 1);
		const s = Array.isArray(b.sort) && b.sort[0] ? b.sort[0] : { field: "date_add", dir: "desc" };
		const order = `${LIST_SORT[s.field] || "l.date_add"} ${s.dir === "asc" ? "ASC" : "DESC"}, l.id DESC`;

		const joins = `
            LEFT JOIN \`${P}leads_settings_status\` s ON s.id = l.id_status
            LEFT JOIN \`${P}leads_settings_status_lang\` sl ON sl.id_status = s.id AND sl.id_lang = ?
            LEFT JOIN \`${P}leads_pipeline_stages\` ps ON ps.id = l.id_stage
            LEFT JOIN \`${P}leads_pipeline_stages_lang\` psl ON psl.id_stage = ps.id AND psl.id_lang = ?
            LEFT JOIN \`${P}leads_sources\` src ON src.id = l.id_source
            LEFT JOIN \`${P}leads_sources_lang\` src_l ON src_l.id_source = src.id AND src_l.id_lang = ?`;
		const where = `WHERE l.deleted_at IS NULL ${leadScope ? "AND " + leadScope.sql : ""}${f.sql}`;
		const whereParams = [...(leadScope ? leadScope.params : []), ...f.params];

		const [[{ total }]] = await connection_pool.query(`SELECT COUNT(*) AS total FROM \`${P}leads\` l ${where}`, whereParams);
		const [rows] = await connection_pool.query(
			`SELECT
                l.id, l.title, l.value, l.priority, l.temperature, l.qualification, l.score, l.grade, l.website, l.capture_type,
                l.is_converted, l.is_duplicate, l.contact_info, l.date_add, l.date_edit,
                IF(l.first_response_at IS NULL AND l.is_converted = 0, TIMESTAMPDIFF(SECOND, NOW(), l.response_deadline), NULL) AS sla_left,
                ${require("../../controllers/leads/bulk").NEXT_SQL},
                s.color_text AS status_color_text, s.color_background AS status_color_background, s.icon AS status_icon,
                s.system_type AS status_system_type, sl.name AS status_name,
                ps.color AS stage_color, psl.name AS stage_name, ps.probability AS stage_probability,
                src_l.name AS source_name,
                (SELECT JSON_ARRAYAGG(JSON_OBJECT('name', tl.name, 'color', t.color))
                   FROM \`${P}leads_tags_rel\` tr
                   JOIN \`${P}leads_tags\` t ON t.id = tr.id_tag
                   JOIN \`${P}leads_tags_lang\` tl ON tl.id_tag = t.id AND tl.id_lang = ?
                  WHERE tr.id_lead = l.id) AS tags
             FROM \`${P}leads\` l
             ${joins}
             ${where}
             ORDER BY ${order}
             LIMIT ? OFFSET ?`,
			[id_lang, id_lang, id_lang, id_lang, ...whereParams, size, (page - 1) * size]
		);

		// JSON-колонки можуть прийти рядком — парсимо
		const data = rows.map((row) => ({
			...row,
			contact_info: typeof row.contact_info === "string" ? JSON.parse(row.contact_info) : row.contact_info || {},
			tags: typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags || [],
		}));
		res.json({ data, total, last_page: Math.max(1, Math.ceil(total / size)) });
	} catch (error) {
		logging.error(error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

/** Варіанти випадних списків фільтра лідів */
router.post("/api/leads/list-filters/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const P = configDatabase.prefix;
		const idLang = req.user.id_lang || 1;
		const dict = (table, fk, extra = "") =>
			connection_pool.query(`SELECT d.id, COALESCE(dl.name, CONCAT('#', d.id)) AS name${extra} FROM \`${P}${table}\` d LEFT JOIN \`${P}${table}_lang\` dl ON dl.${fk} = d.id AND dl.id_lang = ? ORDER BY d.id`, [idLang]).then(([r]) => r);
		const [statuses, pipelines, stages, sources, tags, managers, loss_reasons, priorities, temperatures, qualifications] = await Promise.all([
			dict("leads_settings_status", "id_status"),
			dict("leads_pipelines", "id_pipeline"),
			dict("leads_pipeline_stages", "id_stage", ", d.id_pipeline"),
			dict("leads_sources", "id_source"),
			dict("leads_tags", "id_tag"),
			connection_pool.query(`SELECT id, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM \`${P}users\` WHERE active = 1 ORDER BY first_name, last_name`).then(([r]) => r),
			dict("leads_loss_reasons", "id_reason"),
			dict("leads_priorities", "id_priority"),
			dict("leads_temperatures", "id_temperature"),
			dict("leads_qualifications", "id_qualification"),
		]);
		res.json({ statuses, pipelines, stages, sources, tags, managers, loss_reasons, priorities, temperatures, qualifications });
	} catch (error) {
		logging.error(error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

// Прийом лідів із сайтів за ключем — routes/leads/intake.js (/api/leads/v1/intake/, старий /api/leads/add/:token/)

// Видалення ліда — у кошик (30 днів на відновлення)
router.post("/api/leads/:id/delete/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ ok: false, error: req.__("leads.server.bad_id") });
		await require("../../controllers/common/trash").softDelete("leads", id, req.user.userId || req.user.id);
		require("../../controllers/common/audit").log(req, { action: "delete", module: "leads", entity: "lead", id_entity: id, count: 1 });
		require("../../controllers/leads/webhooks").fire("lead.deleted", id);
		res.json({ ok: true });
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : req.__("leads.server.server") });
	}
});

// END POST

module.exports = router;