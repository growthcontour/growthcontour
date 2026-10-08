const express = require("express");
const crypto = require("crypto");
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp'); // Для оптимізації та видалення метаданих (встановіть: npm install sharp)
const router = express.Router();

// Налаштування multer для тимчасового зберігання
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB макс
    fileFilter: (req, file, cb) => {
        // Перевірка MIME типу
        if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png' || file.mimetype === 'image/jpg') {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type'), false);
        }
    }
});

// Controllers
const authorizationControllers = require("../../controllers/authorization/authorization");
// END Controllers

//Database connection
const connection = require("../../config/database/database");
//END Database connection

// Configuration
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
// END Configuration

// Logging
const logging = require("../../logging/logging");
// END Logging

const { getIO } = require('../../controllers/socket/socket');
const io = getIO();


// GET
router.get("/customers/", authorizationControllers.isAuthenticated, (req, res) => {
    res.render("pages/customers/index", {
        i18n: req,
        user: req.user,
        header: {
            navbar: "customers"
        }
    });
});

// ── Сторінки клієнта ─────────────────────────────────────────────

// ── Головна сторінка клієнта /customers/:id ───────────────────────
router.get('/customers/:id', authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id = req.params.id;
        const p = configDatabase.prefix;
        const id_lang = req.user.lang === 'uk' ? 2 : 1;

        // Основні дані - ВСІ поля з таблиці
        const [[customer]] = await connection.promise().query(`
            SELECT
                id, uid, external_id, external_source,
                type, first_name, last_name, middle_name,
                gender, birthday, age,
                segment, blacklisted, blacklist_reason, blacklisted_at,
                payment_discipline, credit_limit,
                do_not_call, do_not_email, do_not_sms,
                preferred_contact, preferred_contact_time,
                source, assigned_to, language,
                timezone, currency,
                referral_code, referred_by_id,
                is_new, lead_id, deal_id, quote_id,
                social_telegram, social_instagram,
                social_viber, social_whatsapp, social_facebook, social_tiktok,
                pref_delivery_method, pref_delivery_city, pref_delivery_warehouse,
                notes, tags,
                created_at, updated_at
            FROM \`${p}customers\`
            WHERE id = ? AND deleted_at IS NULL
            LIMIT 1
        `, [id]);

        if (!customer) return res.status(404).render('pages/404', { i18n: req, user: req.user, header: {} });

        // Основний телефон та email
        const [[phone_row]] = await connection.promise().query(`
            SELECT value FROM \`${p}customer_contacts\`
            WHERE customer_id = ? AND type = 'phone' AND is_primary = 1 LIMIT 1
        `, [id]);
        const [[email_row]] = await connection.promise().query(`
            SELECT value FROM \`${p}customer_contacts\`
            WHERE customer_id = ? AND type = 'email' AND is_primary = 1 LIMIT 1
        `, [id]);

        customer.phone = phone_row ? phone_row.value : null;
        customer.email = email_row ? email_row.value : null;

        // Групи
        const [groups] = await connection.promise().query(`
            SELECT g.id, g.color_text, g.color_background, g.icon, gl.text
            FROM \`${p}customers_to_groups\` ctg
            JOIN \`${p}customers_groups\` g ON g.id = ctg.group_id AND g.active = 1
            JOIN \`${p}customers_groups_lang\` gl ON gl.id_group = g.id AND gl.id_lang = ?
            WHERE ctg.client_id = ?
            ORDER BY g.sort
        `, [id_lang, id]);

        // Лояльність (коротко для sidebar)
        const [[loyalty]] = await connection.promise().query(`
            SELECT
                loy.points_balance,
                lld.color  AS level_color,
                lll.name   AS level_name
            FROM \`${p}customer_loyalty\` loy
            LEFT JOIN \`${p}customer_loyalty_levels_dict\` lld ON lld.id = loy.id_level
            LEFT JOIN \`${p}customer_loyalty_levels_dict_lang\` lll
                ON lll.id_level = lld.id AND lll.id_lang = ?
            WHERE loy.customer_id = ?
            LIMIT 1
        `, [id_lang, id]);

        // Аналітика (коротко)
        const [[analytics]] = await connection.promise().query(`
            SELECT total_orders, total_spent, churn_risk_level, last_order_at
            FROM \`${p}customer_analytics\`
            WHERE customer_id = ? LIMIT 1
        `, [id]);

        res.render('pages/customers/view', {
            i18n: req,
            user: req.user,
            header: { navbar: 'customers' },
            customer,
            groups: groups || [],
            loyalty: loyalty || null,
            analytics: analytics || null,
        });

    } catch (err) {
        console.error(err);
        logging.error(err);
        res.status(500).render('pages/500', { i18n: req, user: req.user, header: {} });
    }
});
// END GET

// POST
router.post("/api/customers/customers-list/", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id_lang = req.user.lang === "uk" ? 2 : 1;
        const p = configDatabase.prefix;

        const query = `
                SELECT
                    c.id,
                    c.uid,
                    c.type,
                    c.first_name,
                    c.last_name,
                    c.middle_name,
                    c.gender,
                    c.birthday,
                    c.segment,
                    c.blacklisted,
                    c.assigned_to,
                    c.created_at,

                    -- Основний телефон з customer_contacts
                    ph.value AS phone,
                    -- Основний email з customer_contacts
                    em.value AS email,

                    -- Групи (всі через GROUP_CONCAT)
                    GROUP_CONCAT(gl.text        ORDER BY g.sort SEPARATOR ',') AS groups_name,
                    GROUP_CONCAT(g.color_text   ORDER BY g.sort SEPARATOR ',') AS groups_color_text,
                    GROUP_CONCAT(g.color_background ORDER BY g.sort SEPARATOR ',') AS groups_color_background,
                    GROUP_CONCAT(g.icon         ORDER BY g.sort SEPARATOR ',') AS groups_icon,

                    -- Лояльність
                    loy.points_balance,
                    lld.code                                                   AS loyalty_level_code,
                    lll.name                                                   AS loyalty_level_name,
                    lld.color                                                  AS loyalty_level_color,

                    -- Аналітика
                    an.total_orders,
                    an.total_spent,
                    an.churn_risk_level

                FROM ${p}customers c

                -- Основний телефон
                LEFT JOIN ${p}customer_contacts ph
                    ON ph.customer_id = c.id AND ph.type = 'phone' AND ph.is_primary = 1
                -- Основний email
                LEFT JOIN ${p}customer_contacts em
                    ON em.customer_id = c.id AND em.type = 'email' AND em.is_primary = 1

                -- Групи
                LEFT JOIN ${p}customers_to_groups ctg
                    ON ctg.client_id = c.id
                LEFT JOIN ${p}customers_groups g
                    ON g.id = ctg.group_id AND g.active = 1
                LEFT JOIN ${p}customers_groups_lang gl
                    ON gl.id_group = g.id AND gl.id_lang = ?

                -- Лояльність
                LEFT JOIN ${p}customer_loyalty loy
                    ON loy.customer_id = c.id
                LEFT JOIN ${p}customer_loyalty_levels_dict lld
                    ON lld.id = loy.id_level
                LEFT JOIN ${p}customer_loyalty_levels_dict_lang lll
                    ON lll.id_level = lld.id AND lll.id_lang = ?

                -- Аналітика
                LEFT JOIN ${p}customer_analytics an
                    ON an.customer_id = c.id

                WHERE c.deleted_at IS NULL

                GROUP BY
                    c.id, c.uid, c.type, c.first_name, c.last_name, c.middle_name,
                    c.gender, c.birthday, c.segment, c.blacklisted,
                    c.assigned_to, c.created_at,
                    ph.value, em.value,
                    loy.points_balance, lld.code, lll.name, lld.color,
                    an.total_orders, an.total_spent, an.churn_risk_level

                ORDER BY c.created_at DESC
            `;

        const [result] = await connection.promise().query(query, [id_lang, id_lang]);
        res.json(result);
    } catch (error) {
        console.error(error);
        logging.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/api/customers/:id/data", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id = req.params.id;
        const id_lang = req.user.lang === "uk" ? 2 : 1;
        const p = configDatabase.prefix;

        // 1. Основні дані клієнта
        const [[customer]] = await connection.promise().query(`
                SELECT * FROM ${p}customers
                WHERE id = ? AND deleted_at IS NULL
                LIMIT 1
            `, [id]);

        if (!customer) return res.status(404).json({ error: "Customer not found" });

        // 2. Групи
        const [groups] = await connection.promise().query(`
                SELECT g.id, g.color_text, g.color_background, g.icon, gl.text
                FROM ${p}customers_to_groups ctg
                JOIN ${p}customers_groups g      ON g.id = ctg.group_id AND g.active = 1
                JOIN ${p}customers_groups_lang gl ON gl.id_group = g.id AND gl.id_lang = ?
                WHERE ctg.client_id = ?
                ORDER BY g.sort
            `, [id_lang, id]);

        // 3. Контакти
        const [contacts] = await connection.promise().query(`
                SELECT cc.*, cld.code AS label_code, clang.name AS label_name
                FROM ${p}customer_contacts cc
                LEFT JOIN ${p}contact_label_dict cld      ON cld.id = cc.id_label
                LEFT JOIN ${p}contact_label_dict_lang clang
                    ON clang.id_label = cld.id AND clang.id_lang = ?
                WHERE cc.customer_id = ?
                ORDER BY cc.is_primary DESC, cc.type, cc.id
            `, [id_lang, id]);

        // 4. Адреси
        const [addresses] = await connection.promise().query(`
                SELECT ca.*, cal.label, cal.delivery_instructions AS instructions_translated
                FROM ${p}customer_addresses ca
                LEFT JOIN ${p}customer_addresses_lang cal
                    ON cal.id_address = ca.id AND cal.id_lang = ?
                WHERE ca.customer_id = ? AND ca.deleted_at IS NULL
                ORDER BY ca.is_default DESC, ca.id
            `, [id_lang, id]);

        // 5. Лояльність
        const [[loyalty_raw]] = await connection.promise().query(`
                SELECT
                    loy.*,
                    lld.code  AS level_code,
                    lld.color AS level_color,
                    lll.name  AS level_name,
                    nl.code   AS next_level_code,
                    nll.name  AS next_level_name
                FROM ${p}customer_loyalty loy
                LEFT JOIN ${p}customer_loyalty_levels_dict lld   ON lld.id = loy.id_level
                LEFT JOIN ${p}customer_loyalty_levels_dict_lang lll
                    ON lll.id_level = lld.id AND lll.id_lang = ?
                LEFT JOIN ${p}customer_loyalty_levels_dict nl    ON nl.id = loy.id_next_level
                LEFT JOIN ${p}customer_loyalty_levels_dict_lang nll
                    ON nll.id_level = nl.id AND nll.id_lang = ?
                WHERE loy.customer_id = ?
                LIMIT 1
            `, [id_lang, id_lang, id]);

        // Прогрес до наступного рівня (%)
        let loyalty = loyalty_raw || null;
        if (loyalty) {
            const earned = loyalty.points_earned_total || 0;
            const need = loyalty.points_to_next_level || 0;
            loyalty.progress_pct = need > 0
                ? Math.min(100, Math.round((earned % (earned + need)) / (earned + need) * 100))
                : 100;
        }

        // 6. Аналітика
        const [[analytics]] = await connection.promise().query(`
                SELECT * FROM ${p}customer_analytics
                WHERE customer_id = ? LIMIT 1
            `, [id]);

        // 7. Нотатки
        const [notes] = await connection.promise().query(`
                SELECT * FROM ${p}customer_notes
                WHERE customer_id = ? AND deleted_at IS NULL
                ORDER BY is_pinned DESC, created_at DESC
            `, [id]);

        res.json({ customer, groups, contacts, addresses, loyalty, analytics: analytics || null, notes });

    } catch (err) {
        console.error(err);
        logging.error(err);
        res.status(500).json({ error: "Internal server error" });
    }
}
);

// ── Update customer ───────────────────────────────────────────────
router.post("/api/customers/:id/update", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id = req.params.id;
        const p = configDatabase.prefix;
        const allowed = [
            "first_name", "last_name", "middle_name",
            "gender", "birthday", "type", "language", "notes",
            "segment", "payment_discipline", "credit_limit", "assigned_to",
            "blacklisted", "do_not_call", "do_not_email", "do_not_sms",
            "social_telegram", "social_instagram", "social_viber",
            "social_whatsapp", "social_facebook",
            "preferred_contact", "preferred_contact_time",
        ];

        // Фільтруємо тільки дозволені поля
        const fields = {};
        allowed.forEach(k => { if (req.body[k] !== undefined) fields[k] = req.body[k] || null; });

        if (!Object.keys(fields).length)
            return res.status(400).json({ error: "No fields to update" });

        const sets = Object.keys(fields).map(k => `\`${k}\` = ?`).join(', ');
        const vals = [...Object.values(fields), id];

        await connection.promise().query(
            `UPDATE ${p}customers SET ${sets} WHERE id = ?`,
            vals
        );

        res.json({ success: true });

    } catch (err) {
        console.error(err);
        logging.error(err);
        res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/api/customers/:id/activity-log", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const customer_id = req.params.id;
        const p = configDatabase.prefix;

        const {
            page = 1,
            limit = 20,
            action_type = null,   // фільтр по типу дії
            field_name = null,   // фільтр по полю
        } = req.body;

        const offset = (parseInt(page) - 1) * parseInt(limit);
        const params = [customer_id];
        let where = 'WHERE cal.customer_id = ?';

        if (action_type) {
            where += ' AND cal.action_type = ?';
            params.push(action_type);
        }
        if (field_name) {
            where += ' AND cal.field_name = ?';
            params.push(field_name);
        }

        // Загальна кількість для пагінації
        const [[{ total }]] = await connection.promise().query(`
                SELECT COUNT(*) AS total
                FROM \`${p}customer_activity_log\` cal
                ${where}
            `, params);

        // Самі записи + дані менеджера
        const [rows] = await connection.promise().query(`
                SELECT
                    cal.id,
                    cal.action_type,
                    cal.field_name,
                    cal.old_value,
                    cal.new_value,
                    cal.description,
                    cal.ip_address,
                    cal.created_at,

                    -- Менеджер snapshot
                    cal.user_name,
                    cal.user_id,

                    -- Актуальне фото менеджера (може бути NULL якщо видалений)
                    u.avatar,
                    CONCAT(u.first_name, ' ', u.last_name) AS user_full_name

                FROM \`${p}customer_activity_log\` cal
                LEFT JOIN \`${p}users\` u ON u.id = cal.user_id
                ${where}
                ORDER BY cal.created_at DESC
                LIMIT ? OFFSET ?
            `, [...params, parseInt(limit), offset]);

        res.json({
            total,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(total / limit),
            rows,
        });

    } catch (err) {
        console.error(err);
        logging.error(err);
        res.status(500).json({ error: "Internal server error" });
    }
});

router.post('/api/customers/:id/contacts', authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id = req.params.id;
        const id_lang = req.user.lang === 'uk' ? 2 : 1;

        const [rows] = await connection.promise().query(`
                SELECT
                    cc.id,
                    cc.type,
                    cc.value,
                    cc.is_primary,
                    cc.is_verified,
                    cc.do_not_use,
                    cc.note,
                    cld.code   AS label_code,
                    clang.name AS label_name
                FROM \`${configDatabase.prefix}customer_contacts\` cc
                LEFT JOIN \`${configDatabase.prefix}contact_label_dict\` cld
                    ON cld.id = cc.id_label
                LEFT JOIN \`${configDatabase.prefix}contact_label_dict_lang\` clang
                    ON clang.id_label = cld.id AND clang.id_lang = ?
                WHERE cc.customer_id = ?
                ORDER BY cc.is_primary DESC, cc.type, cc.id
            `, [id_lang, id]);

        res.json(rows);
    } catch (err) {
        console.error(err);
        logging.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST - завантаження аватара
router.post("/api/customers/:id/upload-avatar",
    authorizationControllers.isAuthenticated,
    upload.single('avatar'),
    async (req, res) => {
        try {
            const customerId = req.params.id;

            if (!req.file) {
                return res.status(400).json({ error: "No file uploaded" });
            }

            // ПРАВИЛЬНИЙ ШЛЯХ - від кореня проекту
            // Якщо файл в папці routes, то піднімаємось на 2 рівні
            const projectRoot = path.join(__dirname, '..', '..');
            const avatarDir = path.join(projectRoot, 'assets', 'images', 'customers', 'avatars');

            console.log('Project root:', projectRoot);
            console.log('Avatar directory:', avatarDir);

            // Створюємо директорію рекурсивно
            if (!fs.existsSync(avatarDir)) {
                fs.mkdirSync(avatarDir, { recursive: true });
                console.log('Directory created');
            }

            // Перевірка сигнатури файлу
            const buffer = req.file.buffer;
            const fileHeader = buffer.toString('hex', 0, 4);
            const isValidJPEG = fileHeader.startsWith('ffd8ff');
            const isValidPNG = fileHeader.startsWith('89504e47');

            if (!isValidJPEG && !isValidPNG) {
                return res.status(400).json({ error: "Invalid file format" });
            }

            // Перевірка через Sharp
            try {
                await sharp(buffer).metadata();
            } catch (err) {
                return res.status(400).json({ error: "Invalid image file" });
            }

            // Шлях для збереження
            const outputPath = path.join(avatarDir, `${customerId}.jpg`);
            console.log('Output path:', outputPath);

            // Обробка та збереження
            await sharp(buffer)
                .resize(256, 256, {
                    fit: 'cover',
                    position: 'center',
                    withoutEnlargement: true
                })
                .jpeg({
                    quality: 80,
                    mozjpeg: true,
                    force: true
                })
                .toFile(outputPath);

            // Перевіряємо чи файл створився
            if (fs.existsSync(outputPath)) {
                console.log('File created successfully');
                res.json({ success: true });
            } else {
                throw new Error('File was not created');
            }

        } catch (err) {
            console.error('Upload error:', err);
            logging.error(err);
            res.status(500).json({ error: "Failed to upload avatar: " + err.message });
        }
    }
);

// POST - отримання аватара (перевіряє чи є файл)
router.post("/api/customers/:id/avatar", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const customerId = req.params.id;

        // Той самий правильний шлях
        const projectRoot = path.join(__dirname, '..', '..');
        const avatarPath = path.join(projectRoot, 'assets', 'images', 'customers', 'avatars', `${customerId}.jpg`);

        if (fs.existsSync(avatarPath)) {
            res.json({ exists: true });
        } else {
            res.json({ exists: false });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// END POST

module.exports = router;