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

const { getIO } = require('../../controllers/socket/socket');
const io = getIO();


// GET
router.get("/leads", authorizationControllers.isAuthenticated, (req, res) => {
    res.render("pages/leads/index", {
        i18n: req, // Передаємо об'єкт i18n
        user: req.user,
        header: {
            navbar: "leads"
        }
    });
});

// GET — сторінка ліда
router.get("/leads/:id([0-9]+)/", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id      = parseInt(req.params.id);
        const id_lang = req.user.id_lang || 1;

        const [[lead]] = await connection_pool.query(`
            SELECT l.*,
                sl.name            AS status_name,
                s.color_text       AS status_color_text,
                s.color_background AS status_color_background,
                s.system_type      AS status_system_type,
                psl.name           AS stage_name,
                ps.color           AS stage_color,
                pl.name            AS pipeline_name,
                src_l.name         AS source_name
            FROM \`${configDatabase.prefix}leads\` l
            LEFT JOIN \`${configDatabase.prefix}leads_settings_status\` s       ON s.id = l.id_status
            LEFT JOIN \`${configDatabase.prefix}leads_settings_status_lang\` sl ON sl.id_status = s.id AND sl.id_lang = ?
            LEFT JOIN \`${configDatabase.prefix}leads_pipeline_stages\` ps      ON ps.id = l.id_stage
            LEFT JOIN \`${configDatabase.prefix}leads_pipeline_stages_lang\` psl ON psl.id_stage = ps.id AND psl.id_lang = ?
            LEFT JOIN \`${configDatabase.prefix}leads_pipelines_lang\` pl       ON pl.id_pipeline = l.id_pipeline AND pl.id_lang = ?
            LEFT JOIN \`${configDatabase.prefix}leads_sources\` src             ON src.id = l.id_source
            LEFT JOIN \`${configDatabase.prefix}leads_sources_lang\` src_l      ON src_l.id_source = src.id AND src_l.id_lang = ?
            WHERE l.id = ? AND l.deleted_at IS NULL
            LIMIT 1
        `, [id_lang, id_lang, id_lang, id_lang, id]);

        if (!lead) return res.status(404).send('Lead not found');

        // JSON поля — парсимо якщо рядок
        ['contact_info', 'utm', 'fingerprint', 'custom_fields'].forEach(f => {
            if (typeof lead[f] === 'string') {
                try { lead[f] = JSON.parse(lead[f]); } catch { lead[f] = {}; }
            }
            lead[f] = lead[f] || {};
        });

        // Статуси для select
        const [statuses] = await connection_pool.query(`
            SELECT s.id, s.color_text, s.color_background, s.system_type, sl.name
            FROM \`${configDatabase.prefix}leads_settings_status\` s
            LEFT JOIN \`${configDatabase.prefix}leads_settings_status_lang\` sl ON sl.id_status = s.id AND sl.id_lang = ?
            WHERE s.is_active = 1 ORDER BY s.sort
        `, [id_lang]);

        // Pipeline stages
        const [stages] = await connection_pool.query(`
            SELECT ps.id, ps.color, ps.probability, ps.system_type, psl.name
            FROM \`${configDatabase.prefix}leads_pipeline_stages\` ps
            LEFT JOIN \`${configDatabase.prefix}leads_pipeline_stages_lang\` psl ON psl.id_stage = ps.id AND psl.id_lang = ?
            WHERE ps.id_pipeline = ? AND ps.is_active = 1 ORDER BY ps.sort
        `, [id_lang, lead.id_pipeline || 0]);

        // Джерела
        const [sources] = await connection_pool.query(`
            SELECT src.id, sl.name
            FROM \`${configDatabase.prefix}leads_sources\` src
            LEFT JOIN \`${configDatabase.prefix}leads_sources_lang\` sl ON sl.id_source = src.id AND sl.id_lang = ?
            WHERE src.is_active = 1 ORDER BY src.sort
        `, [id_lang]);

        // Пріоритети
        const [priorities] = await connection_pool.query(`
            SELECT p.id, p.color_text, p.color_background, p.icon, pl.name
            FROM \`${configDatabase.prefix}leads_priorities\` p
            LEFT JOIN \`${configDatabase.prefix}leads_priorities_lang\` pl ON pl.id_priority = p.id AND pl.id_lang = ?
            WHERE p.is_active = 1 ORDER BY p.sort
        `, [id_lang]);

        // Температури
        const [temperatures] = await connection_pool.query(`
            SELECT t.id, t.slug, t.color_text, t.color_background, t.icon, tl.name
            FROM \`${configDatabase.prefix}leads_temperatures\` t
            LEFT JOIN \`${configDatabase.prefix}leads_temperatures_lang\` tl ON tl.id_temperature = t.id AND tl.id_lang = ?
            WHERE t.is_active = 1 ORDER BY t.sort
        `, [id_lang]);

        // Кваліфікації
        const [qualifications] = await connection_pool.query(`
            SELECT q.id, q.slug, q.color_text, q.color_background, q.icon, ql.name, ql.description
            FROM \`${configDatabase.prefix}leads_qualifications\` q
            LEFT JOIN \`${configDatabase.prefix}leads_qualifications_lang\` ql ON ql.id_qualification = q.id AND ql.id_lang = ?
            WHERE q.is_active = 1 ORDER BY q.sort
        `, [id_lang]);

        // Теги ліда
        const [tags] = await connection_pool.query(`
            SELECT t.id, t.color, tl.name
            FROM \`${configDatabase.prefix}leads_tags_rel\` tr
            JOIN \`${configDatabase.prefix}leads_tags\` t ON t.id = tr.id_tag
            JOIN \`${configDatabase.prefix}leads_tags_lang\` tl ON tl.id_tag = t.id AND tl.id_lang = ?
            WHERE tr.id_lead = ?
        `, [id_lang, id]);

        // Всі теги (для select)
        const [all_tags] = await connection_pool.query(`
            SELECT t.id, t.color, tl.name
            FROM \`${configDatabase.prefix}leads_tags\` t
            JOIN \`${configDatabase.prefix}leads_tags_lang\` tl ON tl.id_tag = t.id AND tl.id_lang = ?
            WHERE t.is_active = 1 ORDER BY t.sort
        `, [id_lang]);

        // Причини програшу
        const [loss_reasons] = await connection_pool.query(`
            SELECT r.id, rl.name
            FROM \`${configDatabase.prefix}leads_loss_reasons\` r
            LEFT JOIN \`${configDatabase.prefix}leads_loss_reasons_lang\` rl ON rl.id_reason = r.id AND rl.id_lang = ?
            WHERE r.is_active = 1 ORDER BY r.sort
        `, [id_lang]);

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
            loss_reasons
        });

    } catch (error) {
        console.error(error);
        logging.error(error);
        res.status(500).send('Server error');
    }
});

// PATCH — зберегти одне поле ліда
router.patch("/api/leads/:id([0-9]+)/field/", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id         = parseInt(req.params.id);
        const { field, value } = req.body;
        const id_manager = req.user.id;

        // Дозволені поля для оновлення
        const ALLOWED = [
            'title', 'note', 'value', 'id_priority', 'id_temperature', 'id_qualification',
            'id_status', 'id_stage', 'id_pipeline', 'id_source', 'id_manager',
            'lead_source', 'website', 'capture_type', 'capture_ref',
            'contact_info', 'utm', 'fingerprint', 'custom_fields',
            'expected_close_date', 'id_loss_reason', 'loss_note',
            'score_fit', 'score_activity'
        ];
        if (!ALLOWED.includes(field)) {
            return res.status(400).json({ error: 'Field not allowed' });
        }

        // Отримати старе значення для history
        const [[old]] = await connection_pool.query(
            `SELECT ?? FROM \`${configDatabase.prefix}leads\` WHERE id = ? LIMIT 1`,
            [field, id]
        );
        if (!old) return res.status(404).json({ error: 'Lead not found' });

        const jsonFields = ['contact_info', 'utm', 'fingerprint', 'custom_fields'];

        // Нормалізуємо старе значення для порівняння
        let value_old = old[field];
        if (jsonFields.includes(field) && typeof value_old === 'string') {
            try { value_old = JSON.parse(value_old); } catch { value_old = {}; }
        }

        // Порівнюємо — якщо нічого не змінилось, не пишемо
        const oldStr = typeof value_old === 'object' ? JSON.stringify(value_old) : String(value_old ?? '');
        const newStr = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
        if (oldStr === newStr) {
            return res.json({ ok: true, field, value, changed: false });
        }

        const dbValue = jsonFields.includes(field) ? JSON.stringify(value) : value;
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

        // Оновлюємо поле
        await connection_pool.query(
            `UPDATE \`${configDatabase.prefix}leads\` SET ?? = ?, date_edit = ? WHERE id = ?`,
            [field, dbValue, now, id]
        );

        // Перераховуємо score і grade
        if (field === 'score_fit' || field === 'score_activity') {
            const [[scores]] = await connection_pool.query(
                `SELECT score_fit, score_activity FROM \`${configDatabase.prefix}leads\` WHERE id = ?`, [id]
            );
            const total = (scores.score_fit || 0) + (scores.score_activity || 0);
            const grade = total >= 80 ? 'A' : total >= 60 ? 'B' : total >= 40 ? 'C' : 'D';
            await connection_pool.query(
                `UPDATE \`${configDatabase.prefix}leads\` SET score = ?, grade = ? WHERE id = ?`,
                [total, grade, id]
            );
        }

        // Пишемо в history
        await connection_pool.query(
            `INSERT INTO \`${configDatabase.prefix}leads_history\`
             (id_lead, id_manager, action_type, field_name, value_old, value_new, source, ip, date_add)
             VALUES (?, ?, 'field_change', ?, ?, ?, 'web', ?, ?)`,
            [id, id_manager, field, oldStr, newStr, req.ip, now]
        );

        res.json({ ok: true, field, value, changed: true });

    } catch (error) {
        console.error(error);
        logging.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST — отримати history ліда
router.post("/api/leads/:id([0-9]+)/history/", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id      = parseInt(req.params.id);
        const id_lang = req.user.id_lang || 1;

        const [rows] = await connection_pool.query(`
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
        `, [id_lang, id_lang, id_lang, id_lang, id]);

        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST — отримати активності ліда
router.post("/api/leads/:id([0-9]+)/activities/", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [rows] = await connection_pool.query(`
            SELECT a.*, CONCAT(u.first_name, ' ', u.last_name) AS manager_name
            FROM \`${configDatabase.prefix}leads_activities\` a
            LEFT JOIN \`${configDatabase.prefix}users\` u ON u.id = a.id_manager
            WHERE a.id_lead = ? AND a.deleted_at IS NULL
            ORDER BY a.date_add DESC
        `, [id]);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST — отримати файли ліда
router.post("/api/leads/:id([0-9]+)/files/", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [rows] = await connection_pool.query(`
            SELECT f.*, CONCAT(u.first_name, ' ', u.last_name) AS manager_name
            FROM \`${configDatabase.prefix}leads_files\` f
            LEFT JOIN \`${configDatabase.prefix}users\` u ON u.id = f.id_manager
            WHERE f.id_lead = ? AND f.deleted_at IS NULL
            ORDER BY f.date_add DESC
        `, [id]);
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get("/leads/settings/", authorizationControllers.isAuthenticated, (req, res) => {
    res.render("pages/leads/settings", {
        i18n: req, // Передаємо об'єкт i18n
        user: req.user,
        header: {
            navbar: "leads"
        }
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
        const val = typeof rows[0].value === 'string'
            ? JSON.parse(rows[0].value)
            : rows[0].value;
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
        const value   = JSON.stringify(req.body);
        const now     = new Date().toISOString().slice(0, 19).replace('T', ' ');
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

        const [rows] = await connection_pool.query(`
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

            WHERE l.deleted_at IS NULL

            ORDER BY l.date_add DESC
        `, [id_lang, id_lang, id_lang, id_lang]);

        // contact_info приходить як рядок — парсимо
        const result = rows.map(row => ({
            ...row,
            contact_info: typeof row.contact_info === 'string'
                ? JSON.parse(row.contact_info)
                : (row.contact_info || {}),
            tags: typeof row.tags === 'string'
                ? JSON.parse(row.tags)
                : (row.tags || [])
        }));

        res.json(result);

    } catch (error) {
        console.error(error);
        logging.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Додати лід
router.post("/api/leads/add/:token/", async (req, res) => {
    try {
        const token = req.params.token;
        const clientIp =  "8.8.8.8"; //req.ip; // або інший спосіб отримання IP-адреси, наприклад, через middleware

        // Перевірка наявності токену
        const [tokens] = await connection_pool.query("SELECT * FROM " + configDatabase.prefix + "leads_settings WHERE token = ?", [token]);
        if (tokens.length === 0) {
            return res.status(403).json({ error: "Invalid token" });
        }

        // Отримання дозволених IP-адрес
        const [ipSettings] = await connection_pool.query("SELECT ip FROM " + configDatabase.prefix + "leads_settings WHERE token = ?", [token]);

        let allowedIps = [];
        if (ipSettings.length > 0) {
            const ipsValue = ipSettings[0].ip; // Припускаємо, що значення зберігається в полі `ip`
            
            if (typeof ipsValue === 'string') {
                try {
                    const ipsArray = JSON.parse(ipsValue);
                    allowedIps = ipsArray.map(ipObj => ipObj.ip);
                } catch (parseError) {
                    console.error('Failed to parse IP settings:', parseError);
                    return res.status(400).json({ error: "Invalid IP settings format" });
                }
            } else if (Array.isArray(ipsValue)) {
                // Якщо значення є масивом, обробляємо його без парсингу JSON
                allowedIps = ipsValue.map(ipObj => ipObj.ip);
            } else {
                console.error('IP settings is not a string or array');
                return res.status(400).json({ error: "Invalid IP settings format" });
            }
        }
        // Перевірка дозволеного IP
        if (!allowedIps.includes(clientIp)) {
            return res.status(403).json({ error: "IP not allowed" });
        }

        // Отримати дані з тіла запиту
        const data = req.body;

        // Валідація даних
        const validation = validator_leads_add(data);
        if (!validation.valid) {
            return res.status(400).json({
                error: "Validation failed",
                details: validation.errors.map(err => ({
                    message: err.message,
                    path: err.instancePath
                }))
            });
        }

        // Доповнення даних за умови їх відсутності
        const title = data.title || "";
        const status = data.status || "1";
        const note = data.note || "";
        const value = data.value ? parseFloat(data.value).toFixed(2) : "0.00";
        const priority = data.priority || "1";
        const lead_source = data.lead_source || "";
        const website = data.website || "";
        const tags = data.tags || [];
        const contact_info = data.contact_info || {};
        const utm = data.utm || {};
        const custom_fields = data.custom_fields || {};
        // Дата додавання повідомлення
        let date_ob = new Date();
        let day = ("0" + date_ob.getDate()).slice(-2);
        let month = ("0" + (date_ob.getMonth() + 1)).slice(-2);
        let year = date_ob.getFullYear();
        let hours = ("0" + date_ob.getHours()).slice(-2); // Додаємо ведучий нуль для годин
        let minutes = date_ob.getMinutes();
        let seconds = date_ob.getSeconds();
        let date_add = year + "-" + month + "-" + day + " " + hours + ":" + minutes + ":" + seconds;
        // END Дата додавання повідомлення

        // Вставка даних в базу
        const [result] = await connection_pool.query("INSERT INTO " + configDatabase.prefix + "leads(title, status, note, value, priority, lead_source, website, tags, contact_info, utm, custom_fields, date_add, date_edit) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                title,
                status,
                note,
                value,
                priority,
                lead_source,
                website,
                JSON.stringify(tags),
                JSON.stringify(contact_info),
                JSON.stringify(utm),
                JSON.stringify(custom_fields),
                date_add,
                date_add
            ]
        );

        // Відповідь користувачеві
        res.status(201).json({ message: "Lead added successfully", lead_id: result.insertId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});
// END Додати лід

// END POST

module.exports = router;