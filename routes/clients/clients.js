const express = require("express");
const router = express.Router();

// Controllers
const authorizationControllers = require("../../controllers/authorization/authorization");
// END Controllers

//Database connection
const connection = require("../../config/database/database");
//END Database connection

// Logging
const logging = require("../../logging/logging");
// END Logging

const { getIO } = require('../../controllers/socket/socket');
const io = getIO();


// GET
router.get("/clients/", authorizationControllers.isAuthenticated, (req, res) => {
    res.render("pages/clients/index", {
        i18n: req, // Передаємо об'єкт i18n
        user: req.user,
        header: {
            navbar: "clients"
        }
    });
});
// END GET

// POST

// END POST

module.exports = router;