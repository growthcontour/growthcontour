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

// ============================================================
// КАЛЕНДАР УГОДИ
// ============================================================

// Допоміжна функція: SQL-умова видимості події для конкретного користувача
// visibility_type: private / all / custom
function calendarVisibilitySql(userId) {
    return `
        (
            ce.visibility_type = 'all'
            OR (ce.visibility_type = 'private' AND ce.id_user_creator = ${userId})
            OR (ce.visibility_type = 'custom' AND ce.id IN (
                SELECT id_event FROM \`${configDatabase.prefix}deals_calendar_event_users\` WHERE id_user = ${userId}
            ))
        )
    `;
}

// GET
router.get("/deals", authorizationControllers.isAuthenticated, (req, res) => {
    res.render("pages/deals/index", {
        i18n: req,
        user: req.user,
        header: {
            navbar: "deals"
        }
    });
});

router.get("/deals/:id", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const p = configDatabase.prefix;
        const id = parseInt(req.params.id);

        if (!id) return res.status(404).send("Not found");

        // Запускаємо одразу все, що не залежить від результату головного запиту
        const [
            [[deal]],
            [dealCompanies],
            [dealContacts],
            [[lastActivity]],
            [units],
            [taxes],
            [activityTypes],
            [activityOutcomes],
            [users],
            [lostReasons],
            [itemTypes],
            [dealItems],
        ] = await Promise.all([
            connection_pool.query(`
                SELECT
                    d.*,
                    sl.name                  AS stage_name,
                    s.color_background       AS stage_color_background,
                    s.color_text             AS stage_color_text,
                    s.stage_type,
                    s.probability            AS stage_probability,
                    pl.name                  AS pipeline_name,
                    pip.color                AS pipeline_color,
                    tl.name                  AS deal_type_name,
                    srcl.name                AS source_name,
                    lrl.name                 AS lost_reason_name,
                    c.name                   AS company_name,
                    c.city                   AS company_city,
                    c.phone_main             AS company_phone,
                    c.email_main             AS company_email,
                    CONCAT_WS(' ', con.last_name, con.first_name, con.middle_name) AS contact_name,
                    con.phone_main           AS contact_phone,
                    con.email_main           AS contact_email,
                    con.position             AS contact_position,
                    CONCAT_WS(' ', u.last_name, u.first_name) AS user_name,
                    comp.name                AS competitor_name
                FROM \`${p}deals\` d
                LEFT JOIN \`${p}deals_stage\`            s    ON s.id              = d.id_stage
                LEFT JOIN \`${p}deals_stage_lang\`        sl   ON sl.id_stage       = d.id_stage        AND sl.id_lang = 1
                LEFT JOIN \`${p}deals_pipeline\`           pip  ON pip.id            = d.id_pipeline
                LEFT JOIN \`${p}deals_pipeline_lang\`      pl   ON pl.id_pipeline    = d.id_pipeline     AND pl.id_lang = 1
                LEFT JOIN \`${p}deals_type_lang\`          tl   ON tl.id_deal_type   = d.id_deal_type    AND tl.id_lang = 1
                LEFT JOIN \`${p}deals_source_lang\`        srcl ON srcl.id_source    = d.id_source       AND srcl.id_lang = 1
                LEFT JOIN \`${p}deals_lost_reason_lang\`   lrl  ON lrl.id_lost_reason= d.id_lost_reason  AND lrl.id_lang = 1
                LEFT JOIN \`${p}companies\`                c    ON c.id              = d.id_company
                LEFT JOIN \`${p}contacts\`                 con  ON con.id            = d.id_contact
                LEFT JOIN \`${p}users\`                    u    ON u.id              = d.id_user
                LEFT JOIN \`${p}companies\`                comp ON comp.id           = d.id_competitor
                WHERE d.id = ? AND d.active = 1
                LIMIT 1
            `, [id]),

            connection_pool.query(`
                SELECT
                    dm.id, dm.id_company, dm.role, dm.is_primary,
                    c.name AS company_name
                FROM \`${p}deals_companies_map\` dm
                LEFT JOIN \`${p}companies\` c ON c.id = dm.id_company
                WHERE dm.id_deal = ?
                ORDER BY dm.is_primary DESC
            `, [id]),

            connection_pool.query(`
                SELECT
                    dm.id, dm.id_contact, dm.is_primary,
                    CONCAT_WS(' ', con.last_name, con.first_name) AS contact_name,
                    rl.name AS role_name
                FROM \`${p}deals_contacts_map\` dm
                LEFT JOIN \`${p}contacts\`          con ON con.id    = dm.id_contact
                LEFT JOIN \`${p}contacts_role_lang\` rl  ON rl.id_role = dm.id_role AND rl.id_lang = 1
                WHERE dm.id_deal = ?
                ORDER BY dm.is_primary DESC
            `, [id]),

            connection_pool.query(`
                SELECT
                    a.id, a.subject, a.result, a.date_plan, a.status,
                    tl.name  AS type_name,
                    t.color  AS type_color,
                    t.icon   AS type_icon
                FROM \`${p}deals_activity\` a
                LEFT JOIN \`${p}deals_activity_type\`      t  ON t.id              = a.id_activity_type
                LEFT JOIN \`${p}deals_activity_type_lang\` tl ON tl.id_activity_type = a.id_activity_type AND tl.id_lang = 1
                WHERE a.id_deal = ? AND a.active = 1
                ORDER BY a.date_plan DESC
                LIMIT 1
            `, [id]),

            connection_pool.query(`
                SELECT u.id, ul.name, ul.name_short
                FROM \`${p}deals_unit\` u
                LEFT JOIN \`${p}deals_unit_lang\` ul ON ul.id_unit = u.id AND ul.id_lang = 1
                WHERE u.active = 1 ORDER BY u.sort_order
            `),

            connection_pool.query(`
                SELECT t.id, t.rate, tl.name
                FROM \`${p}deals_tax\` t
                LEFT JOIN \`${p}deals_tax_lang\` tl ON tl.id_tax = t.id AND tl.id_lang = 1
                WHERE t.active = 1 ORDER BY t.sort_order
            `),

            connection_pool.query(`
                SELECT t.id, t.color, t.icon, tl.name
                FROM \`${p}deals_activity_type\` t
                LEFT JOIN \`${p}deals_activity_type_lang\` tl ON tl.id_activity_type = t.id AND tl.id_lang = 1
                WHERE t.active = 1 ORDER BY t.sort_order
            `),

            connection_pool.query(`
                SELECT o.id, o.id_activity_type, ol.name
                FROM \`${p}deals_activity_outcome\` o
                LEFT JOIN \`${p}deals_activity_outcome_lang\` ol ON ol.id_outcome = o.id AND ol.id_lang = 1
                WHERE o.active = 1 ORDER BY o.sort_order
            `),

            connection_pool.query(`
                SELECT id, first_name, last_name
                FROM \`${p}users\`
                WHERE active = 1 ORDER BY last_name
            `),

            connection_pool.query(`
                SELECT l.id, ll.name
                FROM \`${p}deals_lost_reason\` l
                LEFT JOIN \`${p}deals_lost_reason_lang\` ll ON ll.id_lost_reason = l.id AND ll.id_lang = 1
                WHERE l.active = 1 ORDER BY l.sort_order
            `),

            connection_pool.query(`
                SELECT t.id, tl.name
                FROM \`${p}deals_item_type\` t
                LEFT JOIN \`${p}deals_item_type_lang\` tl ON tl.id_item_type = t.id AND tl.id_lang = 1
                WHERE t.active = 1 ORDER BY t.sort_order
            `),

            connection_pool.query(`
                SELECT
                    i.*,
                    ul.name_short AS unit_short,
                    tl.name       AS tax_name
                FROM \`${p}deals_item\` i
                LEFT JOIN \`${p}deals_unit_lang\` ul ON ul.id_unit = i.id_unit AND ul.id_lang = 1
                LEFT JOIN \`${p}deals_tax_lang\`  tl ON tl.id_tax  = i.id_tax  AND tl.id_lang = 1
                WHERE i.id_deal = ? AND i.active = 1
                ORDER BY i.sort_order
            `, [id]),
        ]);

        if (!deal) return res.status(404).send("Угода не знайдена");

        // Залежить від deal.id_pipeline — окремо, після Promise.all
        const [stages] = await connection_pool.query(`
            SELECT
                s.id, s.stage_type, s.probability,
                s.color_background, s.color_text,
                sl.name
            FROM \`${p}deals_stage\` s
            LEFT JOIN \`${p}deals_stage_lang\` sl ON sl.id_stage = s.id AND sl.id_lang = 1
            WHERE s.id_pipeline = ? AND s.active = 1
            ORDER BY s.sort_order
        `, [deal.id_pipeline]);

        res.render("pages/deals/view", {
            i18n: res,
            user: req.user,
            header: { navbar: "deals" },
            data: {
                deal,
                stages,
                companies: dealCompanies,
                contacts: dealContacts,
                lastActivity: lastActivity || null,
                units,
                taxes,
                activityTypes,
                activityOutcomes,
                users,
                lostReasons,
                itemTypes,
                items: dealItems,
            }
        });

    } catch (error) {
        console.error("Error rendering deal page:", error);
        res.status(500).send("Internal Server Error");
    }
});

router.post("/api/deals/deals-list", async (req, res) => {
    try {
        const p = configDatabase.prefix;

        const [rows] = await connection_pool.query(`
            SELECT
                -- Основні поля угоди
                d.id,
                d.title,
                d.deal_number,
                d.amount_final,
                d.amount_currency,
                d.probability,
                d.forecast_category,
                d.date_close_plan,
                d.date_next_action,
                d.is_rotting,
                d.rotting_days,
                d.date_add,
                d.date_edit,

                -- Стадія
                d.id_stage,
                sl.name                 AS stage_name,
                s.color_background      AS stage_color_background,
                s.color_text            AS stage_color_text,
                s.stage_type,
                s.probability           AS stage_probability,

                -- Воронка
                d.id_pipeline,
                pl.name                 AS pipeline_name,
                pip.color               AS pipeline_color,

                -- Тип угоди
                tl.name                 AS deal_type_name,

                -- Джерело
                srcl.name               AS source_name,

                -- Компанія
                d.id_company,
                c.name                  AS company_name,

                -- Основний контакт
                d.id_contact,
                CONCAT_WS(' ',
                    con.last_name,
                    con.first_name,
                    con.middle_name
                )                       AS contact_name,
                con.phone_main          AS contact_phone,
                con.email_main          AS contact_email,

                -- Відповідальний менеджер
                d.id_user,
                CONCAT_WS(' ',
                    u.last_name,
                    u.first_name
                )                       AS user_name,

                -- Конкурент
                comp.name               AS competitor_name

            FROM \`${p}deals\` d

            -- Стадія
            LEFT JOIN \`${p}deals_stage\` s
                ON s.id = d.id_stage
            LEFT JOIN \`${p}deals_stage_lang\` sl
                ON sl.id_stage = d.id_stage
                AND sl.id_lang = 1

            -- Воронка
            LEFT JOIN \`${p}deals_pipeline\` pip
                ON pip.id = d.id_pipeline
            LEFT JOIN \`${p}deals_pipeline_lang\` pl
                ON pl.id_pipeline = d.id_pipeline
                AND pl.id_lang = 1

            -- Тип угоди
            LEFT JOIN \`${p}deals_type\` t
                ON t.id = d.id_deal_type
            LEFT JOIN \`${p}deals_type_lang\` tl
                ON tl.id_deal_type = d.id_deal_type
                AND tl.id_lang = 1

            -- Джерело
            LEFT JOIN \`${p}deals_source\` src
                ON src.id = d.id_source
            LEFT JOIN \`${p}deals_source_lang\` srcl
                ON srcl.id_source = d.id_source
                AND srcl.id_lang = 1

            -- Компанія
            LEFT JOIN \`${p}companies\` c
                ON c.id = d.id_company

            -- Контакт
            LEFT JOIN \`${p}contacts\` con
                ON con.id = d.id_contact

            -- Менеджер
            LEFT JOIN \`${p}users\` u
                ON u.id = d.id_user

            -- Конкурент
            LEFT JOIN \`${p}companies\` comp
                ON comp.id = d.id_competitor

            WHERE d.active = 1

            ORDER BY d.date_add DESC
        `);

        res.status(200).json(rows);

    } catch (error) {
        console.error("Помилка при виконанні запиту deals-list:", error);
        res.status(500).json({ error: "Помилка сервера" });
    }
});

const p = configDatabase.prefix;

// ============================================================
// ПОЗИЦІЇ УГОДИ
// ============================================================
router.post("/api/deals/:id/items", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [items] = await connection_pool.query(`
            SELECT
                i.*,
                itl.name      AS item_type_name,
                ul.name_short AS unit_short,
                tl.name       AS tax_name
            FROM \`${p}deals_item\` i
            LEFT JOIN \`${p}deals_item_type_lang\` itl ON itl.id_item_type = i.id_item_type AND itl.id_lang = 1
            LEFT JOIN \`${p}deals_unit_lang\`       ul  ON ul.id_unit       = i.id_unit      AND ul.id_lang  = 1
            LEFT JOIN \`${p}deals_tax_lang\`         tl  ON tl.id_tax        = i.id_tax       AND tl.id_lang  = 1
            WHERE i.id_deal = ? AND i.active = 1
            ORDER BY i.sort_order
        `, [id]);
        res.json(items);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// КП
// ============================================================
router.post("/api/deals/:id/quotes", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [quotes] = await connection_pool.query(`
            SELECT
                q.*,
                sl.name                  AS status_name,
                s.color_background       AS status_bg,
                s.color_text             AS status_text,
                CONCAT_WS(' ', u.last_name, u.first_name) AS user_name
            FROM \`${p}deals_quote\` q
            LEFT JOIN \`${p}deals_quote_status\`      s  ON s.id              = q.id_quote_status
            LEFT JOIN \`${p}deals_quote_status_lang\` sl ON sl.id_quote_status = q.id_quote_status AND sl.id_lang = 1
            LEFT JOIN \`${p}users\`                   u  ON u.id              = q.id_user
            WHERE q.id_deal = ? AND q.active = 1
            ORDER BY q.date_add DESC
        `, [id]);
        res.json(quotes);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// ДОГОВОРИ
// ============================================================
router.post("/api/deals/:id/contracts", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [contracts] = await connection_pool.query(`
            SELECT
                c.*,
                sl.name                     AS status_name,
                s.color_background          AS status_bg,
                s.color_text                AS status_text,
                tl.name                     AS type_name,
                CONCAT_WS(' ', u.last_name, u.first_name) AS user_name
            FROM \`${p}deals_contract\` c
            LEFT JOIN \`${p}deals_contract_status\`      s  ON s.id                 = c.id_contract_status
            LEFT JOIN \`${p}deals_contract_status_lang\` sl ON sl.id_contract_status = c.id_contract_status AND sl.id_lang = 1
            LEFT JOIN \`${p}deals_contract_type_lang\`   tl ON tl.id_contract_type  = c.id_contract_type   AND tl.id_lang = 1
            LEFT JOIN \`${p}users\`                      u  ON u.id                 = c.id_user
            WHERE c.id_deal = ? AND c.active = 1
            ORDER BY c.date_add DESC
        `, [id]);
        res.json(contracts);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// РАХУНКИ
// ============================================================
router.post("/api/deals/:id/invoices", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [invoices] = await connection_pool.query(`
            SELECT
                i.*,
                sl.name                     AS status_name,
                s.color_background          AS status_bg,
                s.color_text                AS status_text,
                CONCAT_WS(' ', u.last_name, u.first_name) AS user_name
            FROM \`${p}deals_invoice\` i
            LEFT JOIN \`${p}deals_invoice_status\`      s  ON s.id                 = i.id_invoice_status
            LEFT JOIN \`${p}deals_invoice_status_lang\` sl ON sl.id_invoice_status = i.id_invoice_status AND sl.id_lang = 1
            LEFT JOIN \`${p}users\`                     u  ON u.id                 = i.id_user
            WHERE i.id_deal = ? AND i.active = 1
            ORDER BY i.date_add DESC
        `, [id]);
        res.json(invoices);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// АКТИ
// ============================================================
router.post("/api/deals/:id/acts", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [acts] = await connection_pool.query(`
            SELECT
                a.*,
                sl.name                  AS status_name,
                s.color_background       AS status_bg,
                s.color_text             AS status_text,
                CONCAT_WS(' ', u.last_name, u.first_name) AS user_name
            FROM \`${p}deals_act\` a
            LEFT JOIN \`${p}deals_act_status\`      s  ON s.id             = a.id_act_status
            LEFT JOIN \`${p}deals_act_status_lang\` sl ON sl.id_act_status = a.id_act_status AND sl.id_lang = 1
            LEFT JOIN \`${p}users\`                 u  ON u.id             = a.id_user
            WHERE a.id_deal = ? AND a.active = 1
            ORDER BY a.date_add DESC
        `, [id]);
        res.json(acts);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// АКТИВНОСТІ
// ============================================================
router.post("/api/deals/:id/activities", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [tasks] = await connection_pool.query(`
            SELECT
                t.*,
                CONCAT_WS(' ', u.last_name, u.first_name)  AS user_name,
                CONCAT_WS(' ', uc.last_name, uc.first_name) AS creator_name
            FROM \`${p}deals_task\` t
            LEFT JOIN \`${p}users\` u  ON u.id  = t.id_user
            LEFT JOIN \`${p}users\` uc ON uc.id = t.id_user_creator
            WHERE t.id_deal = ? AND t.active = 1
            ORDER BY t.priority DESC, t.date_due ASC
        `, [id]);
        res.json(tasks);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// ЗАВДАННЯ
// ============================================================
router.post("/api/deals/:id/tasks", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [tasks] = await connection_pool.query(`
            SELECT
                t.*,
                CONCAT_WS(' ', u.last_name, u.first_name) AS user_name,
                CONCAT_WS(' ', uc.last_name, uc.first_name) AS creator_name
            FROM \`${p}deals_task\` t
            LEFT JOIN \`${p}users\` u ON u.id = t.id_user
            LEFT JOIN \`${p}users\` uc ON uc.id = t.id_user_creator
            WHERE t.id_deal = ? AND t.active = 1
            ORDER BY t.priority DESC, t.date_due ASC
        `, [id]);

        // Виправлення: повертаємо масив напряму, а не об'єкт { tasks }
        res.json(tasks);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// ФАЙЛИ
// ============================================================
router.post("/api/deals/:id/files", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [files] = await connection_pool.query(`
            SELECT
                f.*,
                cl.name                  AS category_name,
                CONCAT_WS(' ', u.last_name, u.first_name) AS user_name
            FROM \`${p}deals_file\` f
            LEFT JOIN \`${p}deals_file_category\`      c  ON c.id          = f.id_category
            LEFT JOIN \`${p}deals_file_category_lang\` cl ON cl.id_category = f.id_category AND cl.id_lang = 1
            LEFT JOIN \`${p}users\`                    u  ON u.id          = f.id_user
            WHERE f.id_deal = ? AND f.active = 1
            ORDER BY f.date_add DESC
        `, [id]);
        res.json(files);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// ІСТОРІЯ ЗМІН
// ============================================================
router.post("/api/deals/:id/history", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id   = parseInt(req.params.id);
        const lang = req.getLocale() === 'uk' ? 1 : 2;

        const [history] = await connection_pool.query(`
            SELECT
                l.*,
                CONCAT_WS(' ', u.last_name, u.first_name) AS user_name,

                -- Переклад action (зі статичного i18n — передамо окремо)
                -- Переклад entity_type (зі статичного i18n — передамо окремо)
                -- Переклад field_name (зі статичного i18n — передамо окремо)

                -- Динамічні значення: стадії
                sl_old.name   AS stage_old_name,
                sl_new.name   AS stage_new_name,

                -- Динамічні значення: причина програшу
                lrl_old.name  AS lost_reason_old_name,
                lrl_new.name  AS lost_reason_new_name,

                -- Динамічні значення: менеджер
                CONCAT_WS(' ', u_old.last_name, u_old.first_name) AS user_old_name,
                CONCAT_WS(' ', u_new.last_name, u_new.first_name) AS user_new_name

            FROM \`${p}deals_audit_log\` l
            LEFT JOIN \`${p}users\` u ON u.id = l.id_user

            -- Стадії old/new
            LEFT JOIN \`${p}deals_stage_lang\` sl_old
                ON sl_old.id_stage = l.value_old AND l.field_name = 'id_stage' AND sl_old.id_lang = ?
            LEFT JOIN \`${p}deals_stage_lang\` sl_new
                ON sl_new.id_stage = l.value_new AND l.field_name = 'id_stage' AND sl_new.id_lang = ?

            -- Причина програшу old/new
            LEFT JOIN \`${p}deals_lost_reason_lang\` lrl_old
                ON lrl_old.id_lost_reason = l.value_old AND l.field_name = 'id_lost_reason' AND lrl_old.id_lang = ?
            LEFT JOIN \`${p}deals_lost_reason_lang\` lrl_new
                ON lrl_new.id_lost_reason = l.value_new AND l.field_name = 'id_lost_reason' AND lrl_new.id_lang = ?

            -- Менеджер old/new
            LEFT JOIN \`${p}users\` u_old
                ON u_old.id = l.value_old AND l.field_name = 'id_user'
            LEFT JOIN \`${p}users\` u_new
                ON u_new.id = l.value_new AND l.field_name = 'id_user'

            WHERE l.id_entity = ?
              AND l.entity_type IN ('deal','quote','contract','invoice','act','activity','task')
            ORDER BY l.date_add DESC
            LIMIT 200
        `, [lang, lang, lang, lang, id]);

        // Переклади статичних полів через i18n
        const t = (key) => req.__(key) || key;

        const result = history.map(row => {
            // Визначаємо value_old_label і value_new_label
            let value_old_label = row.value_old;
            let value_new_label = row.value_new;

            if (row.field_name === 'id_stage') {
                value_old_label = row.stage_old_name     || row.value_old;
                value_new_label = row.stage_new_name     || row.value_new;
            } else if (row.field_name === 'id_lost_reason') {
                value_old_label = row.lost_reason_old_name || row.value_old;
                value_new_label = row.lost_reason_new_name || row.value_new;
            } else if (row.field_name === 'id_user') {
                value_old_label = row.user_old_name      || row.value_old;
                value_new_label = row.user_new_name      || row.value_new;
            } else if (row.field_name === 'probability') {
                value_old_label = row.value_old ? row.value_old + '%' : null;
                value_new_label = row.value_new ? row.value_new + '%' : null;
            }

            return {
                ...row,
                action_label:      t('audit.action.' + row.action),
                entity_label:      t('audit.entity.' + row.entity_type),
                field_label:       row.field_name ? t('audit.field.' + row.field_name) : null,
                value_old_label,
                value_new_label,
            };
        });

        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// ЗМІНА СТАДІЇ
// ============================================================
router.post("/api/deals/:id/stage", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const stageId = parseInt(req.body.id_stage);
        const userId = req.user.id;
        const dateCloseFact = req.body.date_close_fact || null;
        const idLostReason = req.body.id_lost_reason || null;
        const competitorName = req.body.competitor_name || null;
        const note = req.body.note || null;

        // Поточна угода
        const [[deal]] = await connection_pool.query(
            `SELECT id_stage, probability, date_stage_changed, date_add FROM \`${p}deals\` WHERE id = ? LIMIT 1`,
            [id]
        );
        if (!deal) return res.status(404).json({ error: "Not found" });

        // Тип і ймовірність нової стадії
        const [[stage]] = await connection_pool.query(
            `SELECT stage_type, probability FROM \`${p}deals_stage\` WHERE id = ? LIMIT 1`,
            [stageId]
        );
        if (!stage) return res.status(404).json({ error: "Stage not found" });

        // Визначаємо нову ймовірність
        let newProbability;
        if (stage.stage_type === 'won') newProbability = 100;
        else if (stage.stage_type === 'lost') newProbability = 0;
        else if (stage.stage_type === 'canceled') newProbability = 0;
        else newProbability = stage.probability;

        // Додаткові поля залежно від типу стадії
        let extraFields = '';
        let extraValues = [];

        if (stage.stage_type === 'won') {
            extraFields = ', date_close_fact = ?';
            extraValues = [dateCloseFact || new Date()];
        } else if (stage.stage_type === 'lost') {
            extraFields = ', id_lost_reason = ?, competitor_name = COALESCE(?, competitor_name)';
            extraValues = [idLostReason, competitorName];
        }

        // Тривалість на поточній стадії
        const now = new Date();
        const fromDate = deal.date_stage_changed ? new Date(deal.date_stage_changed) : new Date(deal.date_add);
        const days = Math.floor((now - fromDate) / 86400000);

        // Оновлюємо угоду
        await connection_pool.query(`
            UPDATE \`${p}deals\`
            SET id_stage_prev        = id_stage,
                id_stage             = ?,
                probability          = ?,
                probability_override = 0,
                amount_weighted      = amount_final * ? / 100,
                date_stage_changed   = NOW(),
                date_edit            = NOW()
                ${extraFields}
            WHERE id = ?
        `, [stageId, newProbability, newProbability, ...extraValues, id]);

        // Історія стадій
        await connection_pool.query(`
            INSERT INTO \`${p}deals_stage_history\`
                (id_deal, id_stage_from, id_stage_to, id_user, duration_days, note, date_add)
            VALUES (?, ?, ?, ?, ?, ?, NOW())
        `, [id, deal.id_stage, stageId, userId, days, note]);

        // Audit log — стадія
        await connection_pool.query(`
            INSERT INTO \`${p}deals_audit_log\`
                (id_user, user_name, user_ip, entity_type, id_entity, action, field_name, value_old, value_new, description, date_add)
            VALUES (?, ?, ?, 'deal', ?, 'stage_change', 'id_stage', ?, ?, ?, NOW())
        `, [
            userId,
            req.user.last_name + ' ' + req.user.first_name,
            req.ip,
            id,
            deal.id_stage,
            stageId,
            note
        ]);

        // Audit log — ймовірність (тільки якщо змінилась)
        if (deal.probability !== newProbability) {
            await connection_pool.query(`
                INSERT INTO \`${p}deals_audit_log\`
                    (id_user, user_name, user_ip, entity_type, id_entity, action, field_name, value_old, value_new, description, date_add)
                VALUES (?, ?, ?, 'deal', ?, 'update', 'probability', ?, ?, 'Автоматично від стадії', NOW())
            `, [
                userId,
                req.user.last_name + ' ' + req.user.first_name,
                req.ip,
                id,
                deal.probability,
                newProbability
            ]);
        }

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});


// ============================================================
// ПОЗИЦІЇ УГОДИ
// ============================================================

// Додати позицію
router.post("/api/deals/:id/items/add", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id_deal = parseInt(req.params.id);
        const {
            item_type, id_product, ref_type, id_ref,
            id_unit, id_tax,
            name, description, sku,
            qty, price, price_currency,
            discount, discount_type,
            tax_rate, tax_included,
            cost_price,
            billing_period, billing_cycles,
            date_from, date_to,
            sort_order
        } = req.body;

        const qtyF = parseFloat(qty) || 1;
        const priceF = parseFloat(price) || 0;
        const discountF = parseFloat(discount) || 0;

        const discount_amount = discount_type == 1
            ? discountF
            : priceF * qtyF * discountF / 100;

        const amount = (priceF * qtyF) - discount_amount;
        const tax_amount = tax_included == 1
            ? amount - amount / (1 + parseFloat(tax_rate || 0) / 100)
            : amount * parseFloat(tax_rate || 0) / 100;
        const amount_total = tax_included == 1 ? amount : amount + tax_amount;

        const costPriceF = parseFloat(cost_price) || 0;
        const margin_amount = amount_total - (costPriceF * qtyF);
        const margin_percent = amount_total > 0
            ? parseFloat(((margin_amount / amount_total) * 100).toFixed(2))
            : 0;

        await connection_pool.query(`
            INSERT INTO \`${p}deals_item\`
                (id_deal, id_item_type, id_product, ref_type, id_ref,
                 id_unit, id_tax, name, description, sku,
                 qty, price, price_currency,
                 discount, discount_type, discount_amount,
                 tax_rate, tax_included, tax_amount,
                 amount, amount_total,
                 cost_price, margin_amount, margin_percent,
                 billing_period, billing_cycles, date_from, date_to,
                 sort_order, active, date_add, date_edit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())
        `, [
            id_deal, item_type || 8, id_product || null, ref_type || null, id_ref || null,
            id_unit || null, id_tax || null, name, description || null, sku || null,
            qtyF, priceF, price_currency || 'UAH',
            discountF, discount_type || 0, discount_amount,
            parseFloat(tax_rate || 0), tax_included == 1 ? 1 : 0, tax_amount,
            amount, amount_total,
            costPriceF, margin_amount, margin_percent,
            billing_period || null, billing_cycles || null, date_from || null, date_to || null,
            sort_order || 0
        ]);

        await connection_pool.query(`
            UPDATE \`${p}deals\` SET
                amount_gross    = (SELECT COALESCE(SUM(price * qty),     0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                amount          = (SELECT COALESCE(SUM(amount),          0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                discount_amount = (SELECT COALESCE(SUM(discount_amount), 0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                tax_amount      = (SELECT COALESCE(SUM(tax_amount),      0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                amount_final    = (SELECT COALESCE(SUM(amount_total),    0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                amount_weighted = (SELECT COALESCE(SUM(amount_total),    0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1) * probability / 100,
                margin_amount   = (SELECT COALESCE(SUM(margin_amount),   0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                margin_percent  = CASE
                    WHEN (SELECT COALESCE(SUM(amount_total), 0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1) > 0
                    THEN ROUND(
                        (SELECT COALESCE(SUM(margin_amount), 0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1) /
                        (SELECT COALESCE(SUM(amount_total),  0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1) * 100, 2)
                    ELSE 0
                END,
                date_edit = NOW()
            WHERE id = ?
        `, [id_deal, id_deal, id_deal, id_deal, id_deal, id_deal, id_deal, id_deal, id_deal, id_deal, id_deal]);

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// Редагувати позицію
router.post("/api/deals/:id/items/:itemId/edit", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const itemId = parseInt(req.params.itemId);
        const id_deal = parseInt(req.params.id);
        const {
            item_type, id_product, ref_type, id_ref,
            id_unit, id_tax,
            name, description, sku,
            qty, price, price_currency,
            discount, discount_type,
            tax_rate, tax_included,
            cost_price,
            billing_period, billing_cycles,
            date_from, date_to,
            sort_order
        } = req.body;

        const qtyF = parseFloat(qty) || 1;
        const priceF = parseFloat(price) || 0;
        const discountF = parseFloat(discount) || 0;

        const discount_amount = discount_type == 1
            ? discountF
            : priceF * qtyF * discountF / 100;

        const amount = (priceF * qtyF) - discount_amount;
        const tax_amount = tax_included == 1
            ? amount - amount / (1 + parseFloat(tax_rate || 0) / 100)
            : amount * parseFloat(tax_rate || 0) / 100;
        const amount_total = tax_included == 1 ? amount : amount + tax_amount;

        const costPriceF = parseFloat(cost_price) || 0;
        const margin_amount = amount_total - (costPriceF * qtyF);
        const margin_percent = amount_total > 0
            ? parseFloat(((margin_amount / amount_total) * 100).toFixed(2))
            : 0;

        await connection_pool.query(`
            UPDATE \`${p}deals_item\` SET
                id_item_type = ?, id_product = ?, ref_type = ?, id_ref = ?,
                id_unit = ?, id_tax = ?,
                name = ?, description = ?, sku = ?,
                qty = ?, price = ?, price_currency = ?,
                discount = ?, discount_type = ?, discount_amount = ?,
                tax_rate = ?, tax_included = ?, tax_amount = ?,
                amount = ?, amount_total = ?,
                cost_price = ?, margin_amount = ?, margin_percent = ?,
                billing_period = ?, billing_cycles = ?,
                date_from = ?, date_to = ?,
                sort_order = ?, date_edit = NOW()
            WHERE id = ?
        `, [
            item_type || 8, id_product || null, ref_type || null, id_ref || null,
            id_unit || null, id_tax || null,
            name, description || null, sku || null,
            qtyF, priceF, price_currency || 'UAH',
            discountF, discount_type || 0, discount_amount,
            parseFloat(tax_rate || 0), tax_included == 1 ? 1 : 0, tax_amount,
            amount, amount_total,
            costPriceF, margin_amount, margin_percent,
            billing_period || null, billing_cycles || null,
            date_from || null, date_to || null,
            sort_order || 0,
            itemId
        ]);

        await connection_pool.query(`
            UPDATE \`${p}deals\` SET
                amount_gross    = (SELECT COALESCE(SUM(price * qty),     0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                amount          = (SELECT COALESCE(SUM(amount),          0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                discount_amount = (SELECT COALESCE(SUM(discount_amount), 0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                tax_amount      = (SELECT COALESCE(SUM(tax_amount),      0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                amount_final    = (SELECT COALESCE(SUM(amount_total),    0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                amount_weighted = (SELECT COALESCE(SUM(amount_total),    0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1) * probability / 100,
                margin_amount   = (SELECT COALESCE(SUM(margin_amount),   0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                margin_percent  = CASE
                    WHEN (SELECT COALESCE(SUM(amount_total), 0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1) > 0
                    THEN ROUND(
                        (SELECT COALESCE(SUM(margin_amount), 0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1) /
                        (SELECT COALESCE(SUM(amount_total),  0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1) * 100, 2)
                    ELSE 0
                END,
                date_edit = NOW()
            WHERE id = ?
        `, [id_deal, id_deal, id_deal, id_deal, id_deal, id_deal, id_deal, id_deal, id_deal, id_deal, id_deal]);

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// Видалити позицію
router.post("/api/deals/:id/items/:itemId/delete", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const itemId = parseInt(req.params.itemId);
        const id_deal = parseInt(req.params.id);

        await connection_pool.query(
            `UPDATE \`${p}deals_item\` SET active = 0, date_edit = NOW() WHERE id = ?`,
            [itemId]
        );

        await connection_pool.query(`
            UPDATE \`${p}deals\` SET
                amount_gross    = (SELECT COALESCE(SUM(price * qty),     0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                amount          = (SELECT COALESCE(SUM(amount),          0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                discount_amount = (SELECT COALESCE(SUM(discount_amount), 0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                tax_amount      = (SELECT COALESCE(SUM(tax_amount),      0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                amount_final    = (SELECT COALESCE(SUM(amount_total),    0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                amount_weighted = (SELECT COALESCE(SUM(amount_total),    0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1) * probability / 100,
                margin_amount   = (SELECT COALESCE(SUM(margin_amount),   0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1),
                margin_percent  = CASE
                    WHEN (SELECT COALESCE(SUM(amount_total), 0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1) > 0
                    THEN ROUND(
                        (SELECT COALESCE(SUM(margin_amount), 0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1) /
                        (SELECT COALESCE(SUM(amount_total),  0) FROM \`${p}deals_item\` WHERE id_deal = ? AND active = 1) * 100, 2)
                    ELSE 0
                END,
                date_edit = NOW()
            WHERE id = ?
        `, [id_deal, id_deal, id_deal, id_deal, id_deal, id_deal, id_deal, id_deal, id_deal, id_deal, id_deal]);

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// АКТИВНОСТІ
// ============================================================

// Додати активність
router.post("/api/deals/:id/activities/add", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id_deal = parseInt(req.params.id);
        const userId = req.user.id;
        const {
            id_activity_type, id_outcome,
            id_contact,
            subject, description, result, next_step,
            date_plan, duration_minutes,
            location, location_url,
            reminder, reminder_minutes,
            status, priority, is_private
        } = req.body;

        await connection_pool.query(`
            INSERT INTO \`${p}deals_activity\`
                (id_activity_type, id_outcome,
                 id_deal, id_company, id_contact,
                 id_user, id_user_creator,
                 subject, description, result, next_step,
                 date_plan, duration_minutes,
                 location, location_url,
                 reminder, reminder_minutes, reminder_sent,
                 status, priority, is_private,
                 active, date_add, date_edit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, NOW(), NOW())
        `, [
            id_activity_type, id_outcome || null,
            id_deal, req.body.id_company || null, id_contact || null,
            userId, userId,
            subject || null, description || null, result || null, next_step || null,
            date_plan, duration_minutes || null,
            location || null, location_url || null,
            reminder ? 1 : 0, reminder_minutes || null,
            status || 'planned', priority || 2, is_private ? 1 : 0
        ]);

        // Audit log
        await connection_pool.query(`
            INSERT INTO \`${p}deals_audit_log\`
                (id_user, user_name, user_ip, entity_type, id_entity, action, description, date_add)
            VALUES (?, ?, ?, 'deal', ?, 'create', 'Додано активність', NOW())
        `, [userId, req.user.last_name + ' ' + req.user.first_name, req.ip, id_deal]);

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// Редагувати активність
router.post("/api/deals/:id/activities/:actId/edit", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const actId = parseInt(req.params.actId);
        const {
            id_activity_type, id_outcome,
            id_contact,
            subject, description, result, next_step,
            date_plan, duration_minutes,
            location, location_url,
            reminder, reminder_minutes,
            status, priority, is_private
        } = req.body;

        await connection_pool.query(`
            UPDATE \`${p}deals_activity\` SET
                id_activity_type = ?, id_outcome = ?,
                id_contact       = ?,
                subject          = ?, description    = ?,
                result           = ?, next_step      = ?,
                date_plan        = ?, duration_minutes = ?,
                location         = ?, location_url   = ?,
                reminder         = ?, reminder_minutes = ?,
                status           = ?, priority        = ?,
                is_private       = ?, date_edit       = NOW()
            WHERE id = ?
        `, [
            id_activity_type, id_outcome || null,
            id_contact || null,
            subject || null, description || null,
            result || null, next_step || null,
            date_plan, duration_minutes || null,
            location || null, location_url || null,
            reminder ? 1 : 0, reminder_minutes || null,
            status || 'planned', priority || 2,
            is_private ? 1 : 0,
            actId
        ]);

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// Видалити активність
router.post("/api/deals/:id/activities/:actId/delete", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const actId = parseInt(req.params.actId);
        await connection_pool.query(
            `UPDATE \`${p}deals_activity\` SET active = 0, date_edit = NOW() WHERE id = ?`,
            [actId]
        );
        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});


// ============================================================
// ЗАВДАННЯ
// ============================================================

// Додати завдання
router.post("/api/deals/:id/tasks/add", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id_deal = parseInt(req.params.id);
        const userId = req.user.id;
        const {
            id_user, title, description,
            date_start, date_due,
            estimated_minutes,
            status, priority,
            is_private
        } = req.body;

        await connection_pool.query(`
            INSERT INTO \`${p}deals_task\`
                (id_deal, id_user, id_user_creator,
                 title, description,
                 date_start, date_due,
                 estimated_minutes,
                 status, priority, progress,
                 is_private, active, date_add, date_edit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, NOW(), NOW())
        `, [
            id_deal, id_user || userId, userId,
            title, description || null,
            date_start || null, date_due || null,
            estimated_minutes || null,
            status || 'new', priority || 2,
            is_private ? 1 : 0
        ]);

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// Редагувати завдання
router.post("/api/deals/:id/tasks/:taskId/edit", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const taskId = parseInt(req.params.taskId);
        const {
            id_user, title, description,
            date_start, date_due,
            estimated_minutes, actual_minutes,
            status, priority, progress,
            is_private
        } = req.body;

        await connection_pool.query(`
            UPDATE \`${p}deals_task\` SET
                id_user           = ?,
                title             = ?, description       = ?,
                date_start        = ?, date_due          = ?,
                estimated_minutes = ?, actual_minutes    = ?,
                status            = ?, priority          = ?,
                progress          = ?, is_private        = ?,
                date_edit         = NOW()
            WHERE id = ?
        `, [
            id_user || null,
            title, description || null,
            date_start || null, date_due || null,
            estimated_minutes || null, actual_minutes || null,
            status || 'new', priority || 2,
            progress || 0, is_private ? 1 : 0,
            taskId
        ]);

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// Виконати / скасувати завдання (toggle)
router.post("/api/deals/:id/tasks/:taskId/toggle", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const taskId = parseInt(req.params.taskId);
        const done = req.body.done == 1 || req.body.done === true;

        await connection_pool.query(`
            UPDATE \`${p}deals_task\` SET
                status    = ?,
                date_done = ?,
                progress  = ?,
                date_edit = NOW()
            WHERE id = ?
        `, [
            done ? 'done' : 'new',
            done ? new Date() : null,
            done ? 100 : 0,
            taskId
        ]);

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// Видалити завдання
router.post("/api/deals/:id/tasks/:taskId/delete", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const taskId = parseInt(req.params.taskId);
        await connection_pool.query(
            `UPDATE \`${p}deals_task\` SET active = 0, date_edit = NOW() WHERE id = ?`,
            [taskId]
        );
        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});


// ============================================================
// ФАЙЛИ
// ============================================================

// Завантажити файл
router.post("/api/deals/:id/files/upload", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id_deal = parseInt(req.params.id);
        const userId = req.user.id;
        const {
            id_category, file_path, file_name,
            file_ext, file_size, file_mime, file_hash,
            title, description, is_public
        } = req.body;

        await connection_pool.query(`
            INSERT INTO \`${p}deals_file\`
                (entity_type, id_entity, id_deal,
                 id_category, file_path, file_name,
                 file_ext, file_size, file_mime, file_hash,
                 version, title, description, is_public,
                 id_user, download_count,
                 active, date_add, date_edit)
            VALUES ('deal', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, 1, NOW(), NOW())
        `, [
            id_deal, id_deal,
            id_category || null, file_path, file_name,
            file_ext || null, file_size || null, file_mime || null, file_hash || null,
            title || null, description || null, is_public ? 1 : 0,
            userId
        ]);

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// Видалити файл
router.post("/api/deals/:id/files/:fileId/delete", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const fileId = parseInt(req.params.fileId);
        await connection_pool.query(
            `UPDATE \`${p}deals_file\` SET active = 0, date_edit = NOW() WHERE id = ?`,
            [fileId]
        );
        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// Ручна зміна ймовірності
router.post("/api/deals/:id/probability", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id             = parseInt(req.params.id);
        const userId         = req.user.id;
        const newProbability = parseInt(req.body.probability);

        if (isNaN(newProbability) || newProbability < 0 || newProbability > 100) {
            return res.status(400).json({ error: "Невірне значення" });
        }

        // Поточне значення
        const [[deal]] = await connection_pool.query(
            `SELECT probability FROM \`${p}deals\` WHERE id = ? LIMIT 1`, [id]
        );
        if (!deal) return res.status(404).json({ error: "Not found" });

        // Якщо не змінилось — нічого не робимо
        if (deal.probability === newProbability) {
            return res.json({ ok: true, changed: false });
        }

        // Оновлюємо
        await connection_pool.query(`
            UPDATE \`${p}deals\` SET
                probability          = ?,
                probability_override = 1,
                amount_weighted      = amount_final * ? / 100,
                date_edit            = NOW()
            WHERE id = ?
        `, [newProbability, newProbability, id]);

        // Audit log
        await connection_pool.query(`
            INSERT INTO \`${p}deals_audit_log\`
                (id_user, user_name, user_ip, entity_type, id_entity, action, field_name, value_old, value_new, description, date_add)
            VALUES (?, ?, ?, 'deal', ?, 'update', 'probability', ?, ?, 'Змінено вручну', NOW())
        `, [
            userId,
            req.user.last_name + ' ' + req.user.first_name,
            req.ip,
            id,
            deal.probability,
            newProbability
        ]);

        res.json({ ok: true, changed: true, probability: newProbability });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// КАСТОМНІ ПОЛЯ — список з значеннями для угоди
// ============================================================
router.post("/api/deals/:id/custom-fields", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id_deal = parseInt(req.params.id);

        const [[deal]] = await connection_pool.query(
            `SELECT id_pipeline FROM \`${p}deals\` WHERE id = ? LIMIT 1`,
            [id_deal]
        );
        if (!deal) return res.status(404).json({ error: "Not found" });

        const [fields] = await connection_pool.query(`
            SELECT
                f.id,
                f.field_type,
                f.field_key,
                f.label,
                f.placeholder,
                f.hint,
                f.is_required,
                f.is_unique,
                f.default_value,
                f.icon,
                f.sort_order,
                f.id_group,

                -- Значення
                v.id         AS value_id,
                v.value_text,
                v.value_int,
                v.value_decimal,
                v.value_date,
                v.value_datetime,
                v.value_json

            FROM \`${p}deals_custom_field\` f
            LEFT JOIN \`${p}deals_custom_field_value\` v
                ON v.id_custom_field = f.id AND v.id_deal = ?

            WHERE f.active = 1
              AND f.show_in_card = 1
              AND (f.id_pipeline IS NULL OR f.id_pipeline = ?)

            ORDER BY f.sort_order, f.id
        `, [id_deal, deal.id_pipeline]);

        // Визначаємо value для відображення
        const result = await Promise.all(fields.map(async f => {
            let value = null;

            switch (f.field_type) {
                case 'checkbox':
                    value = f.value_int;
                    break;
                case 'number':
                case 'decimal':
                    value = f.value_decimal;
                    break;
                case 'date':
                    value = f.value_date;
                    break;
                case 'datetime':
                    value = f.value_datetime;
                    break;
                case 'multiselect':
                case 'tags':
                    value = f.value_json;
                    break;
                default:
                    value = f.value_text;
            }

            // Варіанти для select/radio/multiselect
            let options = [];
            if (['select', 'multiselect', 'radio'].includes(f.field_type)) {
                const [opts] = await connection_pool.query(`
                    SELECT o.id, o.name, o.sort_order
                    FROM \`${p}deals_custom_field_option\` o
                    WHERE o.id_custom_field = ? AND o.active = 1
                    ORDER BY o.sort_order
                `, [f.id]);
                options = opts;
            }

            return {
                ...f,
                value: value ?? f.default_value ?? null,
                options
            };
        }));

        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// СТВОРИТИ НОВУ УГОДУ (порожню) — миттєвий редирект на /deals/:id
// ============================================================
router.post("/api/deals/add", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const userId = req.user.id;

        // Перша воронка за sort_order
        const [[pipeline]] = await connection_pool.query(
            `SELECT id FROM \`${p}deals_pipeline\` WHERE active = 1 ORDER BY sort_order LIMIT 1`
        );
        if (!pipeline) return res.status(400).json({ error: "Немає жодної активної воронки" });

        // Перша стадія цієї воронки
        const [[stage]] = await connection_pool.query(
            `SELECT id, probability FROM \`${p}deals_stage\` WHERE id_pipeline = ? AND active = 1 ORDER BY sort_order LIMIT 1`,
            [pipeline.id]
        );
        if (!stage) return res.status(400).json({ error: "Немає жодної стадії у воронці" });

        // Генеруємо номер угоди УГ-2026-0001
        const year = new Date().getFullYear();
        const [[lastDeal]] = await connection_pool.query(
            `SELECT deal_number FROM \`${p}deals\`
             WHERE deal_number LIKE ? ORDER BY id DESC LIMIT 1`,
            [`УГ-${year}-%`]
        );
        let nextNum = 1;
        if (lastDeal && lastDeal.deal_number) {
            const parts = lastDeal.deal_number.split('-');
            nextNum = (parseInt(parts[2]) || 0) + 1;
        }
        const dealNumber = `УГ-${year}-${String(nextNum).padStart(4, '0')}`;

        // Створюємо угоду
        const [result] = await connection_pool.query(`
            INSERT INTO \`${p}deals\`
                (id_pipeline, id_stage, id_user, id_user_creator,
                 title, deal_number, probability,
                 amount_currency, forecast_category,
                 active, date_add, date_edit)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'UAH', 'pipeline', 1, NOW(), NOW())
        `, [
            pipeline.id, stage.id, userId, userId,
            'Нова угода', dealNumber, stage.probability
        ]);

        const id_deal = result.insertId;

        // Audit log
        await connection_pool.query(`
            INSERT INTO \`${p}deals_audit_log\`
                (id_user, user_name, user_ip, entity_type, id_entity, action, description, date_add)
            VALUES (?, ?, ?, 'deal', ?, 'create', 'Угода створена', NOW())
        `, [
            userId,
            req.user.last_name + ' ' + req.user.first_name,
            req.ip,
            id_deal
        ]);

        res.json({ ok: true, id: id_deal });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// КАСТОМНІ ПОЛЯ — зберегти значення
// ============================================================
router.post("/api/deals/:id/custom-fields/:fieldId/save", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id_deal   = parseInt(req.params.id);
        const id_field  = parseInt(req.params.fieldId);
        const userId    = req.user.id;
        const { field_type, value } = req.body;

        // Визначаємо в яку колонку зберігати
        let value_text     = null;
        let value_int      = null;
        let value_decimal  = null;
        let value_date     = null;
        let value_datetime = null;
        let value_json     = null;

        switch (field_type) {
            case 'checkbox':
                value_int = value == 1 ? 1 : 0;
                break;
            case 'number':
                value_decimal = parseFloat(value) || null;
                break;
            case 'decimal':
                value_decimal = parseFloat(value) || null;
                break;
            case 'date':
                value_date = value || null;
                break;
            case 'datetime':
                value_datetime = value || null;
                break;
            case 'multiselect':
            case 'tags':
                value_json = value || null;
                break;
            default:
                value_text = value || null;
        }

        // Перевіряємо чи є вже запис
        const [[existing]] = await connection_pool.query(
            `SELECT id FROM \`${p}deals_custom_field_value\` WHERE id_custom_field = ? AND id_deal = ? LIMIT 1`,
            [id_field, id_deal]
        );

        if (existing) {
            // Оновлюємо
            await connection_pool.query(`
                UPDATE \`${p}deals_custom_field_value\` SET
                    value_text     = ?,
                    value_int      = ?,
                    value_decimal  = ?,
                    value_date     = ?,
                    value_datetime = ?,
                    value_json     = ?,
                    date_edit      = NOW()
                WHERE id_custom_field = ? AND id_deal = ?
            `, [value_text, value_int, value_decimal, value_date, value_datetime, value_json, id_field, id_deal]);
        } else {
            // Створюємо новий запис
            await connection_pool.query(`
                INSERT INTO \`${p}deals_custom_field_value\`
                    (id_custom_field, id_deal, value_text, value_int, value_decimal, value_date, value_datetime, value_json, date_add, date_edit)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
            `, [id_field, id_deal, value_text, value_int, value_decimal, value_date, value_datetime, value_json]);
        }

        // Audit log
        await connection_pool.query(`
            INSERT INTO \`${p}deals_audit_log\`
                (id_user, user_name, user_ip, entity_type, id_entity, action, field_name, value_new, description, date_add)
            VALUES (?, ?, ?, 'deal', ?, 'update', ?, ?, 'Оновлено кастомне поле', NOW())
        `, [
            userId,
            req.user.last_name + ' ' + req.user.first_name,
            req.ip,
            id_deal,
            'custom_field_' + id_field,
            value
        ]);

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// КАСТОМНІ ПОЛЯ — видалити значення
// ============================================================
router.post("/api/deals/:id/custom-fields/:fieldId/delete", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id_deal  = parseInt(req.params.id);
        const id_field = parseInt(req.params.fieldId);
        const userId   = req.user.id;

        await connection_pool.query(
            `DELETE FROM \`${p}deals_custom_field_value\` WHERE id_custom_field = ? AND id_deal = ?`,
            [id_field, id_deal]
        );

        // Audit log
        await connection_pool.query(`
            INSERT INTO \`${p}deals_audit_log\`
                (id_user, user_name, user_ip, entity_type, id_entity, action, field_name, description, date_add)
            VALUES (?, ?, ?, 'deal', ?, 'delete', ?, 'Видалено значення кастомного поля', NOW())
        `, [
            userId,
            req.user.last_name + ' ' + req.user.first_name,
            req.ip,
            id_deal,
            'custom_field_' + id_field
        ]);

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// КАСТОМНІ ПОЛЯ — додати нове поле
// ============================================================
router.post("/api/deals/custom-fields/add", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const {
            field_type, field_key, label,
            placeholder, hint,
            icon, id_pipeline, default_value, sort_order,
            is_required, is_unique, show_in_list, show_in_kanban,
            options
        } = req.body;

        if (!label)      return res.json({ ok: false, error: 'Вкажіть назву поля' });
        if (!field_type) return res.json({ ok: false, error: 'Оберіть тип поля' });

        // Генеруємо field_key якщо не вказано
        let key = field_key ? field_key.trim() : '';
        if (!key) {
            const [[last]] = await connection_pool.query(
                `SELECT MAX(id) AS max_id FROM \`${p}deals_custom_field\``
            );
            key = 'field_' + ((last.max_id || 0) + 1);
        }

        // Перевірка унікальності ключа
        if (field_key) {
            const [[existing]] = await connection_pool.query(
                `SELECT id FROM \`${p}deals_custom_field\` WHERE field_key = ? LIMIT 1`,
                [key]
            );
            if (existing) return res.json({ ok: false, error: 'Поле з таким ключем вже існує' });
        }

        const [result] = await connection_pool.query(`
            INSERT INTO \`${p}deals_custom_field\`
                (field_type, field_key, label, placeholder, hint,
                 id_pipeline, is_required, is_unique,
                 default_value, icon,
                 show_in_list, show_in_card, show_in_kanban,
                 active, sort_order, date_add, date_edit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, NOW(), NOW())
        `, [
            field_type, key, label,
            placeholder || null, hint || null,
            id_pipeline || null,
            is_required || 0, is_unique || 0,
            default_value || null,
            icon || null,
            show_in_list || 0,
            show_in_kanban || 0,
            sort_order || 0
        ]);

        const id_field = result.insertId;

        // Зберігаємо варіанти
        const opts = JSON.parse(options || '[]');
        for (let i = 0; i < opts.length; i++) {
            await connection_pool.query(`
                INSERT INTO \`${p}deals_custom_field_option\`
                    (id_custom_field, name, sort_order, active, date_add, date_edit)
                VALUES (?, ?, ?, 1, NOW(), NOW())
            `, [id_field, opts[i].name, i]);
        }

        res.json({ ok: true, id: id_field });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});
// ============================================================
// КАСТОМНІ ПОЛЯ — редагувати поле
// ============================================================
router.post("/api/deals/custom-fields/:fieldId/edit", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const fieldId = parseInt(req.params.fieldId);
        const {
            field_key, label, hint,
            icon, id_pipeline, default_value, sort_order,
            is_required, is_unique, show_in_list, show_in_kanban,
            options
        } = req.body;

        if (!label) return res.json({ ok: false, error: 'Вкажіть назву поля' });

        // Перевірка унікальності ключа (якщо змінився)
        if (field_key) {
            const [[existing]] = await connection_pool.query(
                `SELECT id FROM \`${p}deals_custom_field\` WHERE field_key = ? AND id != ? LIMIT 1`,
                [field_key, fieldId]
            );
            if (existing) return res.json({ ok: false, error: 'Поле з таким ключем вже існує' });
        }

        // Оновлюємо поле
        await connection_pool.query(`
            UPDATE \`${p}deals_custom_field\` SET
                field_key      = ?,
                label          = ?,
                hint           = ?,
                icon           = ?,
                id_pipeline    = ?,
                default_value  = ?,
                sort_order     = ?,
                is_required    = ?,
                is_unique      = ?,
                show_in_list   = ?,
                show_in_kanban = ?,
                date_edit      = NOW()
            WHERE id = ?
        `, [
            field_key   || null,
            label,
            hint        || null,
            icon        || null,
            id_pipeline || null,
            default_value || null,
            sort_order  || 0,
            is_required  || 0,
            is_unique    || 0,
            show_in_list || 0,
            show_in_kanban || 0,
            fieldId
        ]);

        // Оновлюємо варіанти — видаляємо старі і додаємо нові
        const opts = JSON.parse(options || '[]');

        if (opts.length > 0) {
            // Отримуємо існуючі варіанти
            const [existingOpts] = await connection_pool.query(
                `SELECT id FROM \`${p}deals_custom_field_option\` WHERE id_custom_field = ? AND active = 1 ORDER BY sort_order`,
                [fieldId]
            );

            // Деактивуємо всі старі
            await connection_pool.query(
                `UPDATE \`${p}deals_custom_field_option\` SET active = 0, date_edit = NOW() WHERE id_custom_field = ?`,
                [fieldId]
            );

            // Додаємо нові
            for (let i = 0; i < opts.length; i++) {
                await connection_pool.query(`
                    INSERT INTO \`${p}deals_custom_field_option\`
                        (id_custom_field, name, value, sort_order, active, date_add, date_edit)
                    VALUES (?, ?, ?, ?, 1, NOW(), NOW())
                `, [fieldId, opts[i].name, opts[i].value || opts[i].name, i]);
            }
        }

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// КАСТОМНІ ПОЛЯ — видалити поле повністю
// ============================================================
router.post("/api/deals/custom-fields/:fieldId/delete", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const fieldId = parseInt(req.params.fieldId);

        // Деактивуємо поле
        await connection_pool.query(
            `UPDATE \`${p}deals_custom_field\` SET active = 0, date_edit = NOW() WHERE id = ?`,
            [fieldId]
        );

        // Деактивуємо варіанти
        await connection_pool.query(
            `UPDATE \`${p}deals_custom_field_option\` SET active = 0, date_edit = NOW() WHERE id_custom_field = ?`,
            [fieldId]
        );

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ============================================================
// КАЛЕНДАР УГОДИ
// ============================================================

// ------------------------------------------------------------
// Події для FullCalendar (у видимому діапазоні дат)
// ------------------------------------------------------------
router.post("/api/deals/:id/calendar/events", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const p = configDatabase.prefix;
        const id_deal = parseInt(req.params.id);
        const userId = req.user.id;
        const { start, end } = req.body;

        const [events] = await connection_pool.query(`
            SELECT
                ce.id,
                ce.title,
                ce.description,
                ce.date_start,
                ce.date_end,
                ce.all_day,
                ce.priority,
                ce.status,
                ce.visibility_type,
                ce.reminder,
                ce.reminder_minutes,
                ce.id_event_type,
                ce.id_user_creator,
                et.code                  AS type_code,
                et.icon                  AS type_icon,
                et.color                 AS type_color,
                etl.name                 AS type_name,
                CONCAT_WS(' ', uc.last_name, uc.first_name) AS creator_name
            FROM \`${p}deals_calendar_events\` ce
            LEFT JOIN \`${p}deals_calendar_event_type\`      et  ON et.id  = ce.id_event_type
            LEFT JOIN \`${p}deals_calendar_event_type_lang\` etl ON etl.id_event_type = ce.id_event_type AND etl.id_lang = 1
            LEFT JOIN \`${p}users\`                          uc  ON uc.id  = ce.id_user_creator
            WHERE ce.id_deal = ?
              AND ce.active = 1
              AND ce.date_start <= ?
              AND ce.date_end   >= ?
              AND ${calendarVisibilitySql(userId)}
            ORDER BY ce.date_start ASC
        `, [id_deal, end, start]);

        // Формат, який розуміє FullCalendar напряму
        const formatted = events.map(e => ({
            id: e.id,
            title: e.title,
            start: e.date_start,
            end: e.date_end,
            allDay: !!e.all_day,
            backgroundColor: e.type_color || '#6c757d',
            borderColor: e.type_color || '#6c757d',
            extendedProps: {
                description: e.description,
                status: e.status,
                priority: e.priority,
                visibility_type: e.visibility_type,
                type_name: e.type_name,
                type_icon: e.type_icon,
                creator_name: e.creator_name,
                reminder: e.reminder,
                reminder_minutes: e.reminder_minutes,
                id_event_type: e.id_event_type
            }
        }));

        res.json(formatted);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ------------------------------------------------------------
// Повний список подій для Tabulator (таб "Календар")
// ------------------------------------------------------------
router.post("/api/deals/:id/calendar/events/list", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const p = configDatabase.prefix;
        const id_deal = parseInt(req.params.id);
        const userId = req.user.id;

        const [events] = await connection_pool.query(`
            SELECT
                ce.*,
                etl.name                 AS type_name,
                et.icon                  AS type_icon,
                et.color                 AS type_color,
                CONCAT_WS(' ', uc.last_name, uc.first_name) AS creator_name,
                (
                    SELECT GROUP_CONCAT(CONCAT_WS(' ', u2.last_name, u2.first_name) SEPARATOR ', ')
                    FROM \`${p}deals_calendar_event_users\` ceu
                    LEFT JOIN \`${p}users\` u2 ON u2.id = ceu.id_user
                    WHERE ceu.id_event = ce.id
                ) AS custom_users_names
            FROM \`${p}deals_calendar_events\` ce
            LEFT JOIN \`${p}deals_calendar_event_type\`      et  ON et.id = ce.id_event_type
            LEFT JOIN \`${p}deals_calendar_event_type_lang\` etl ON etl.id_event_type = ce.id_event_type AND etl.id_lang = 1
            LEFT JOIN \`${p}users\`                          uc  ON uc.id = ce.id_user_creator
            WHERE ce.id_deal = ?
              AND ce.active = 1
              AND ${calendarVisibilitySql(userId)}
            ORDER BY ce.date_start DESC
        `, [id_deal]);

        res.json(events);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ------------------------------------------------------------
// Отримати одну подію (для відкриття модалки редагування)
// ------------------------------------------------------------
router.post("/api/deals/:id/calendar/events/:eventId", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const p = configDatabase.prefix;
        const eventId = parseInt(req.params.eventId);

        const [[event]] = await connection_pool.query(`
            SELECT * FROM \`${p}deals_calendar_events\` WHERE id = ? AND active = 1
        `, [eventId]);

        if (!event) return res.status(404).json({ error: "Not found" });

        const [customUsers] = await connection_pool.query(`
            SELECT id_user FROM \`${p}deals_calendar_event_users\` WHERE id_event = ?
        `, [eventId]);

        event.custom_user_ids = customUsers.map(u => u.id_user);

        res.json(event);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ------------------------------------------------------------
// Додати подію
// ------------------------------------------------------------
router.post("/api/deals/:id/calendar/events/add", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const p = configDatabase.prefix;
        const id_deal = parseInt(req.params.id);
        const userId = req.user.id;
        const {
            id_event_type, title, description,
            date_start, date_end, all_day,
            priority, status,
            visibility_type, custom_user_ids,
            reminder, reminder_minutes
        } = req.body;

        if (!title || !date_start || !date_end) {
            return res.status(400).json({ error: "Заповніть обов'язкові поля" });
        }

        const [result] = await connection_pool.query(`
            INSERT INTO \`${p}deals_calendar_events\`
                (id_deal, id_event_type, title, description,
                 date_start, date_end, all_day,
                 priority, status, visibility_type,
                 reminder, reminder_minutes,
                 id_user_creator, active, date_add, date_edit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())
        `, [
            id_deal, id_event_type || null, title, description || null,
            date_start, date_end, all_day ? 1 : 0,
            priority || 2, status || 'planned', visibility_type || 'all',
            reminder ? 1 : 0, reminder_minutes || 30,
            userId
        ]);

        const eventId = result.insertId;

        // Якщо visibility_type === 'custom' — записуємо учасників
        if (visibility_type === 'custom' && Array.isArray(custom_user_ids) && custom_user_ids.length) {
            const values = custom_user_ids.map(uid => [eventId, parseInt(uid)]);
            await connection_pool.query(`
                INSERT INTO \`${p}deals_calendar_event_users\` (id_event, id_user, reminder_sent, date_add)
                VALUES ${values.map(() => '(?, ?, 0, NOW())').join(', ')}
            `, values.flat());
        }

        // Audit log
        await connection_pool.query(`
            INSERT INTO \`${p}deals_audit_log\`
                (id_user, user_name, user_ip, entity_type, id_entity, action, description, date_add)
            VALUES (?, ?, ?, 'deal', ?, 'create', 'Додано подію календаря', NOW())
        `, [userId, req.user.last_name + ' ' + req.user.first_name, req.ip, id_deal]);

        res.json({ ok: true, id: eventId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ------------------------------------------------------------
// Редагувати подію
// ------------------------------------------------------------
router.post("/api/deals/:id/calendar/events/:eventId/edit", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const p = configDatabase.prefix;
        const eventId = parseInt(req.params.eventId);
        const userId = req.user.id;
        const {
            id_event_type, title, description,
            date_start, date_end, all_day,
            priority, status,
            visibility_type, custom_user_ids,
            reminder, reminder_minutes
        } = req.body;

        if (!title || !date_start || !date_end) {
            return res.status(400).json({ error: "Заповніть обов'язкові поля" });
        }

        await connection_pool.query(`
            UPDATE \`${p}deals_calendar_events\` SET
                id_event_type    = ?,
                title            = ?,
                description      = ?,
                date_start       = ?,
                date_end         = ?,
                all_day          = ?,
                priority         = ?,
                status           = ?,
                visibility_type  = ?,
                reminder         = ?,
                reminder_minutes = ?,
                date_edit        = NOW()
            WHERE id = ?
        `, [
            id_event_type || null, title, description || null,
            date_start, date_end, all_day ? 1 : 0,
            priority || 2, status || 'planned', visibility_type || 'all',
            reminder ? 1 : 0, reminder_minutes || 30,
            eventId
        ]);

        // Завжди перебудовуємо список учасників: видалити старе, вставити нове
        await connection_pool.query(`
            DELETE FROM \`${p}deals_calendar_event_users\` WHERE id_event = ?
        `, [eventId]);

        if (visibility_type === 'custom' && Array.isArray(custom_user_ids) && custom_user_ids.length) {
            const values = custom_user_ids.map(uid => [eventId, parseInt(uid)]);
            await connection_pool.query(`
                INSERT INTO \`${p}deals_calendar_event_users\` (id_event, id_user, reminder_sent, date_add)
                VALUES ${values.map(() => '(?, ?, 0, NOW())').join(', ')}
            `, values.flat());
        }

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ------------------------------------------------------------
// Перенесення/зміна тривалості події (drag&drop / resize у FullCalendar)
// ------------------------------------------------------------
router.post("/api/deals/:id/calendar/events/:eventId/reschedule", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const p = configDatabase.prefix;
        const eventId = parseInt(req.params.eventId);
        const { date_start, date_end } = req.body;

        if (!date_start || !date_end) {
            return res.status(400).json({ error: "Дати обов'язкові" });
        }

        await connection_pool.query(`
            UPDATE \`${p}deals_calendar_events\`
            SET date_start = ?, date_end = ?, date_edit = NOW()
            WHERE id = ?
        `, [date_start, date_end, eventId]);

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ------------------------------------------------------------
// Видалити подію (soft delete)
// ------------------------------------------------------------
router.post("/api/deals/:id/calendar/events/:eventId/delete", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const p = configDatabase.prefix;
        const eventId = parseInt(req.params.eventId);

        await connection_pool.query(`
            UPDATE \`${p}deals_calendar_events\` SET active = 0, date_edit = NOW() WHERE id = ?
        `, [eventId]);

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// ------------------------------------------------------------
// Типи подій календаря (для select у модалці)
// ------------------------------------------------------------
router.post("/api/deals/:id/calendar/event-types", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const p = configDatabase.prefix;

        const [types] = await connection_pool.query(`
            SELECT t.id, t.color, t.icon, tl.name
            FROM \`${p}deals_calendar_event_type\` t
            LEFT JOIN \`${p}deals_calendar_event_type_lang\` tl
                ON tl.id_event_type = t.id AND tl.id_lang = 1
            WHERE t.active = 1
            ORDER BY t.sort_order
        `);

        res.json(types);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error" });
    }
});

// END POST

module.exports = router;