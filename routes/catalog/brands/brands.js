const express = require("express");
const crypto = require("crypto");
const router = express.Router();

// Controllers
const authorizationControllers = require("../../../controllers/authorization/authorization");
// END Controllers

//Database connection
const connection = require("../../../config/database/database");
//END Database connection   

// Configuration
const config = require("../../../config/config");
const configDatabase = config.get("configDatabase");
// END Configuration

// Logging
const logging = require("../../../logging/logging");
// END Logging

const { getIO } = require('../../../controllers/socket/socket');
const io = getIO();


// GET
router.get("/brands/", authorizationControllers.isAuthenticated, (req, res) => {
    res.render("pages/catalog/brands/index", {
        i18n: req,
        user: req.user,
        header: {
            navbar: "brands"
        }
    });
});

router.get("/brands/:id/", authorizationControllers.isAuthenticated, (req, res) => {
    res.render("pages/brands/page", {
        i18n: req,
        user: req.user,
        header: {
            navbar: "brands"
        }
    });
});
// END GET

// POST
router.post("/api/brands/brands-list/", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const id_lang = req.user.lang === 'uk' ? 2 : 1;

        const query = `
            SELECT 
                c.id,
                c.first_name,
                c.last_name,
                c.patronymic,
                c.email,
                c.phone,
                c.gender,
                c.newsletter,
                c.date_add,
                c.date_edit,
                GROUP_CONCAT(gl.text ORDER BY g.id SEPARATOR ', ') AS groups_name,
                GROUP_CONCAT(g.color_text ORDER BY g.id SEPARATOR ',') AS groups_color_text,
                GROUP_CONCAT(g.color_background ORDER BY g.id SEPARATOR ',') AS groups_color_background,
                GROUP_CONCAT(g.icon ORDER BY g.id SEPARATOR ',') AS groups_icon
            FROM ${configDatabase.prefix}brands c
            LEFT JOIN ${configDatabase.prefix}brands_to_groups ctg ON ctg.client_id = c.id
            LEFT JOIN ${configDatabase.prefix}brands_groups g ON g.id = ctg.group_id
            LEFT JOIN ${configDatabase.prefix}brands_groups_lang gl 
                ON gl.id_group = g.id 
                AND gl.id_lang = ?
            GROUP BY c.id
            ORDER BY c.date_add DESC
        `;

        const [result] = await connection.promise().query(query, [id_lang]);

        res.json(result);

    } catch (error) {
        console.error(error);
        logging.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
});
// END POST

module.exports = router;