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
const validator_leads_add = require("../../validator/leads/add");
// END Validator

const { getIO } = require("../../controllers/socket/socket");
const io = getIO();

// GET
router.get("/leads", authorizationControllers.isAuthenticated, (req, res) => {
	res.render("pages/leads/index", {
		i18n: req, // Передаємо об'єкт i18n
		user: req.user,
		header: {
			navbar: "leads",
		},
	});
});

// GET — сторінка ліда
router.get("/leads/:id/", authorizationControllers.isAuthenticated, async (req, res) => {
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
                clo.display_name   AS client_org_name
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
            SELECT s.id, s.color_text, s.color_background, s.system_type, sl.name
            FROM \`${configDatabase.prefix}leads_settings_status\` s
            LEFT JOIN \`${configDatabase.prefix}leads_settings_status_lang\` sl ON sl.id_status = s.id AND sl.id_lang = ?
            WHERE s.is_active = 1 ORDER BY s.sort
        `,
			[id_lang]
		);

		// Pipeline stages
		const [stages] = await connection_pool.query(
			`
            SELECT ps.id, ps.color, ps.probability, ps.system_type, psl.name
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

		res.render("pages/leads/view", {
			i18n: req,
			user: req.user,
			header: { navbar: "leads" },
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

// POST — отримати активності ліда
router.post("/api/leads/:id/activities/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const [rows] = await connection_pool.query(
			`
            SELECT a.*, CONCAT(u.first_name, ' ', u.last_name) AS manager_name
            FROM \`${configDatabase.prefix}leads_activities\` a
            LEFT JOIN \`${configDatabase.prefix}users\` u ON u.id = a.id_manager
            WHERE a.id_lead = ? AND a.deleted_at IS NULL
            ORDER BY a.date_add DESC
        `,
			[id]
		);
		res.json(rows);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

// POST — отримати файли ліда
router.post("/api/leads/:id/files/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const [rows] = await connection_pool.query(
			`
            SELECT f.*, CONCAT(u.first_name, ' ', u.last_name) AS manager_name
            FROM \`${configDatabase.prefix}leads_files\` f
            LEFT JOIN \`${configDatabase.prefix}users\` u ON u.id = f.id_manager
            WHERE f.id_lead = ? AND f.deleted_at IS NULL
            ORDER BY f.date_add DESC
        `,
			[id]
		);
		res.json(rows);
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

router.get("/leads/settings/", authorizationControllers.isAuthenticated, (req, res) => {
	res.render("pages/leads/settings", {
		i18n: req, // Передаємо об'єкт i18n
		user: req.user,
		header: {
			navbar: "leads",
		},
	});
});
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
router.post("/api/leads/list/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id_lang = req.user.id_lang || 1;
		const leadScope = require("../../controllers/leads/access").scope(req, "l");

		const [rows] = await connection_pool.query(
			`
            SELECT
                l.id,
                l.title,
                l.value,
                l.priority,
                l.temperature,
                l.qualification,
                l.score,
                l.grade,
                l.website,
                l.capture_type,
                l.is_converted,
                l.is_duplicate,
                l.contact_info,
                l.date_add,
                l.date_edit,

                -- Статус
                s.color_text       AS status_color_text,
                s.color_background AS status_color_background,
                s.icon             AS status_icon,
                s.system_type      AS status_system_type,
                sl.name            AS status_name,

                -- Pipeline stage
                ps.color           AS stage_color,
                psl.name           AS stage_name,
                ps.probability     AS stage_probability,

                -- Джерело
                src_l.name         AS source_name,

                -- Теги (JSON масив)
                (
                    SELECT JSON_ARRAYAGG(
                        JSON_OBJECT(
                            'name',  tl.name,
                            'color', t.color
                        )
                    )
                    FROM \`${configDatabase.prefix}leads_tags_rel\` tr
                    JOIN \`${configDatabase.prefix}leads_tags\` t      ON t.id = tr.id_tag
                    JOIN \`${configDatabase.prefix}leads_tags_lang\` tl ON tl.id_tag = t.id AND tl.id_lang = ?
                    WHERE tr.id_lead = l.id
                ) AS tags

            FROM \`${configDatabase.prefix}leads\` l

            LEFT JOIN \`${configDatabase.prefix}leads_settings_status\` s
                ON s.id = l.id_status

            LEFT JOIN \`${configDatabase.prefix}leads_settings_status_lang\` sl
                ON sl.id_status = s.id AND sl.id_lang = ?

            LEFT JOIN \`${configDatabase.prefix}leads_pipeline_stages\` ps
                ON ps.id = l.id_stage

            LEFT JOIN \`${configDatabase.prefix}leads_pipeline_stages_lang\` psl
                ON psl.id_stage = ps.id AND psl.id_lang = ?

            LEFT JOIN \`${configDatabase.prefix}leads_sources\` src
                ON src.id = l.id_source

            LEFT JOIN \`${configDatabase.prefix}leads_sources_lang\` src_l
                ON src_l.id_source = src.id AND src_l.id_lang = ?

            WHERE l.deleted_at IS NULL ${leadScope ? "AND " + leadScope.sql : ""}

            ORDER BY l.date_add DESC
        `,
			[id_lang, id_lang, id_lang, id_lang, ...(leadScope ? leadScope.params : [])]
		);

		// contact_info приходить як рядок — парсимо
		const result = rows.map((row) => ({
			...row,
			contact_info: typeof row.contact_info === "string" ? JSON.parse(row.contact_info) : row.contact_info || {},
			tags: typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags || [],
		}));

		res.json(result);
	} catch (error) {
		console.error(error);
		logging.error(error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});

// Додати лід (зовнішні сайти/форми за токеном)
router.post("/api/leads/add/:token/", async (req, res) => {
	const P = configDatabase.prefix;
	try {
		const token = req.params.token;
		// Реальний IP клієнта: req.ip враховує "trust proxy" (server.js), без префікса IPv6-mapped
		const clientIp = (req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");

		const [tokens] = await connection_pool.query(`SELECT ip FROM \`${P}leads_settings\` WHERE token = ? LIMIT 1`, [token]);
		if (!tokens.length) return res.status(403).json({ error: "Invalid token" });

		let allowedIps = [];
		const ipsValue = tokens[0].ip;
		try {
			const arr = typeof ipsValue === "string" ? JSON.parse(ipsValue) : ipsValue;
			allowedIps = Array.isArray(arr) ? arr.map((x) => (x && x.ip ? String(x.ip) : String(x))) : [];
		} catch (e) {
			return res.status(400).json({ error: "Invalid IP settings format" });
		}
		if (!allowedIps.includes(clientIp)) {
			return res.status(403).json({ error: "IP not allowed", ip: clientIp });
		}

		const data = req.body || {};
		const validation = validator_leads_add(data);
		if (!validation.valid) {
			return res.status(400).json({
				error: "Validation failed",
				details: validation.errors.map((err) => ({ message: err.message, path: err.instancePath })),
			});
		}

		const ci = data.contact_info && typeof data.contact_info === "object" ? data.contact_info : {};
		const title = data.title || "Заявка: " + (ci.name || ci.phone || ci.email || "без імені");
		const value = data.value ? Number(parseFloat(data.value).toFixed(2)) : 0;
		const id_status = parseInt(data.status, 10) || 1;
		const priority = parseInt(data.priority, 10) || 1;
		const custom_fields = Object.assign({}, data.custom_fields || {}, Array.isArray(data.tags) && data.tags.length ? { _tags: data.tags } : {});

		// Пайплайн 1 і його перша активна стадія — як для лідів із веб-чату
		const LEAD_PIPELINE = 1;
		const [[stg]] = await connection_pool.query(`SELECT id FROM \`${P}leads_pipeline_stages\` WHERE id_pipeline = ? AND is_active = 1 ORDER BY sort ASC LIMIT 1`, [LEAD_PIPELINE]);

		const [result] = await connection_pool.query(
			`INSERT INTO \`${P}leads\`
                (title, note, value, id_pipeline, id_stage, id_status, priority, lead_source, website,
                 capture_type, capture_ref, contact_info, utm, custom_fields, date_add, date_edit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), NOW(), NOW())`,
			[title, data.note || "", value, LEAD_PIPELINE, stg ? stg.id : null, id_status, priority, data.lead_source || "", data.website || "", token.slice(0, 8), JSON.stringify(ci), JSON.stringify(data.utm || {}), JSON.stringify(custom_fields)]
		);

		// Прив'язка до картки клієнта
		let idClient = null;
		try {
			idClient = await require("../../controllers/clients/links").linkLead(result.insertId);
		} catch (e) {
			logging.error(e);
		}

		res.status(201).json({ message: "Lead added successfully", lead_id: result.insertId, id_client: idClient });
	} catch (error) {
		console.error(error);
		logging.error(error);
		res.status(500).json({ error: "Internal Server Error" });
	}
});
// END Додати лід

// Видалення ліда — у кошик (30 днів на відновлення)
router.post("/api/leads/:id/delete/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id = parseInt(req.params.id, 10);
		if (!id) return res.status(400).json({ ok: false, error: "Невірний ID." });
		await require("../../controllers/common/trash").softDelete("leads", id, req.user.userId || req.user.id);
		require("../../controllers/common/audit").log(req, { action: "delete", module: "leads", entity: "lead", id_entity: id, count: 1 });
		res.json({ ok: true });
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Помилка сервера." });
	}
});

// END POST

module.exports = router;
