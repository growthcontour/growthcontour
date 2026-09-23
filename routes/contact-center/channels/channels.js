const express = require("express");
const router = express.Router();

const authorizationControllers = require("../../../controllers/authorization/authorization");
const channelsControllers = require("../../../controllers/contact-center/channels/channels");

const isAuth = authorizationControllers.isAuthenticated;
const canView = authorizationControllers.checkPermission("contact_center.channels", "view");
const canAdd = authorizationControllers.checkPermission("contact_center.channels", "add");
const canEdit = authorizationControllers.checkPermission("contact_center.channels", "edit");
const canDelete = authorizationControllers.checkPermission("contact_center.channels", "delete");

// Сторінки
router.get("/contact-center/channels/", isAuth, canView, channelsControllers.page);
router.get("/contact-center/channels/:id/", isAuth, canView, channelsControllers.edit);

// API
router.post("/api/contact-center/channels/list/", isAuth, canView, channelsControllers.list);
router.post("/api/contact-center/channels/create/", isAuth, canAdd, channelsControllers.create);
router.post("/api/contact-center/channels/:id/update/", isAuth, canEdit, channelsControllers.update);
router.post("/api/contact-center/channels/:id/refresh/", isAuth, canEdit, channelsControllers.refresh);
router.post("/api/contact-center/channels/:id/status/", isAuth, canEdit, channelsControllers.status);
router.post("/api/contact-center/channels/:id/delete/", isAuth, canDelete, channelsControllers.remove);
router.post("/api/contact-center/channels/:id/notify/test-telegram/", isAuth, canEdit, channelsControllers.notifyTestTelegram);

module.exports = router;