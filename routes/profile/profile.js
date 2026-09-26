const express = require("express");
const crypto = require("crypto");
const router = express.Router();

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
router.get("/profile/", authorizationControllers.isAuthenticated, (req, res) => {
    res.render("pages/profile/index", {
        i18n: req, // Передаємо об'єкт i18n
        user: req.user,
        header: {
            navbar: "profile"
        }
    });
});
// END GET

// POST
router.post("/api/profile/list-users/", authorizationControllers.isAuthenticated, (req, res) => {

    if (!["127.0.0.1", "::1"].includes(req.ip.replace("::ffff:", ""))) {
        return res.status(403).json({ message: "Forbidden: Access denied" });
    }

    // Відправка повідомлення в базу
    connection.query("SELECT " + configDatabase.prefix + "users.id, " + configDatabase.prefix + "users.first_name, " + configDatabase.prefix + "users.last_name, " + configDatabase.prefix + "users.patronymic, " + configDatabase.prefix + "users.email, " + configDatabase.prefix + "users.gender, " + configDatabase.prefix + "users.lang, " + configDatabase.prefix + "users.groups, " + configDatabase.prefix + "users.active, " + configDatabase.prefix + "users.tfa, " + configDatabase.prefix + "users_groups.name AS group_name, " + configDatabase.prefix + "users_groups.note AS group_none FROM " + configDatabase.prefix + "users LEFT JOIN " + configDatabase.prefix + "users_groups ON " + configDatabase.prefix + "users_groups.id = " + configDatabase.prefix + "users.groups", function (error, result) {
        if (error) {
            console.log(error);
            logging.error(error);
        }

        res.send(result);
    });

});
// END POST

module.exports = router;