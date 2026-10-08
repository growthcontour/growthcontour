const express = require("express");
const router = express.Router();

// Controllers
const authorizationControllers = require("../../../controllers/authorization/authorization");
// END Controllers

//Database connection
const connection = require("../../../config/database/database");
const connection_pool = require("../../../config/database/connection_pool");
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
router.get("/settings/integration/", authorizationControllers.isAuthenticated, (req, res) => {
    res.render("pages/settings/integration/index", {
        i18n: req, // Передаємо об'єкт i18n
        user: req.user,
        header: {
            navbar: "integration",
        }
    });
});
// END GET

// POST
router.post("/api/integration/integration-list/", authorizationControllers.isAuthenticated, async (req, res) => {
    try {
        const [rows] = await connection_pool.query("SELECT ??, ??, ??, ?? FROM ??",["id", "url", "system", "status", `${configDatabase.prefix}integrations`]);

        if (!rows.length) {
            return res.status(404).json({ message: "Замовлення не знайдено." });
        }

        return res.status(200).json(rows);

    } catch (error) {
        logging.error(error);
        console.log(error);
        return res.status(500).json({ message: "Помилка сервера." });
    }
});
// END POST

module.exports = router;