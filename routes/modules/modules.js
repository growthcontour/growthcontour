/**
 * =====================================================
 * МОДУЛІ: СТОРІНКА + API КЕРУВАННЯ
 * =====================================================
 * GET  /modules/                    — сторінка зі списком модулів
 * GET  /api/modules/                — список модулів
 * GET  /api/modules/:name           — інформація про модуль
 * POST /api/modules/:name/enable    — увімкнути
 * POST /api/modules/:name/disable   — вимкнути
 * POST /api/modules/:name/reload    — перезавантажити
 * POST /api/modules/:name/install   — встановити
 * POST /api/modules/:name/uninstall — видалити дані модуля
 * Сторінки самих модулів (/modules/<name>/...) реєструє менеджер модулів.
 * =====================================================
 */

const express = require("express");
const router = express.Router();
const modulesController = require("../../controllers/modules/modulesController");
const moduleManager = require("../../core/modules/modules-manager");
const auth = require("../../controllers/authorization/authorization");

// Право settings.modules: GET — view; enable/disable/reload/install — edit; uninstall — delete
const SLUG = "settings.modules";

// ═══ СТОРІНКА ═══════════════════════════════════════════

router.get("/modules/", auth.isAuthenticated, (req, res) => {
	if (!auth.hasPermission(req, SLUG, "view")) return res.status(403).render("pages/error/404", { message: req.__("settings_modules.forbidden"), error: { status: 403 } });
	res.render("pages/modules/index", {
		i18n: req,
		user: req.user,
		header: { navbar: "modules", subnavbar: "modules" },
		perms: { edit: auth.hasPermission(req, SLUG, "edit"), delete: auth.hasPermission(req, SLUG, "delete") },
		// Назва й опис модуля мовою користувача — з перекладу самого модуля (modules/<name>/locales)
		modulesI18n: moduleManager.getAllModules().map((m) => {
			const tr = (k) => {
				const key = `modules.${m.name}.${k}`;
				const v = req.__(key);
				return v && v !== key ? v : null;
			};
			return { name: m.name, title: tr("title"), description: tr("description") };
		}),
	});
});

// ═══ API ═════════════════════════════════════════════════

// Перевірка доступу — лише для /api/modules (роутер змонтовано на "/")
router.use("/api/modules", auth.isAuthenticated, (req, res, next) => {
	const action = req.method === "GET" ? "view" : /\/uninstall\/?$/.test(req.path) ? "delete" : "edit";
	if (!auth.hasPermission(req, SLUG, action)) return res.status(403).json({ success: false, error: "Forbidden" });
	next();
});

const fail = (res, where, error) => {
	console.error(`[Modules API] Error ${where}:`, error.message);
	res.status(500).json({ success: false, error: error.message });
};

/**
 * GET /api/modules/
 * Отримати список всіх модулів
 */
router.get("/api/modules/", (req, res) => {
	try {
		res.json({ success: true, data: modulesController.getAllModules() });
	} catch (error) {
		fail(res, "getting modules", error);
	}
});

/**
 * GET /api/modules/:name
 * Отримати інформацію про конкретний модуль
 */
router.get("/api/modules/:name", (req, res) => {
	try {
		const module = modulesController.getModule(req.params.name);
		if (!module) return res.status(404).json({ success: false, error: "Module not found" });
		res.json({ success: true, data: module });
	} catch (error) {
		fail(res, "getting module", error);
	}
});

/**
 * POST /api/modules/:name/enable
 * Активувати модуль
 */
router.post("/api/modules/:name/enable", async (req, res) => {
	try {
		await modulesController.enableModule(req.params.name);
		res.json({ success: true, message: `Module ${req.params.name} enabled` });
	} catch (error) {
		fail(res, "enabling module", error);
	}
});

/**
 * POST /api/modules/:name/disable
 * Деактивувати модуль
 */
router.post("/api/modules/:name/disable", async (req, res) => {
	try {
		await modulesController.disableModule(req.params.name);
		res.json({ success: true, message: `Module ${req.params.name} disabled` });
	} catch (error) {
		fail(res, "disabling module", error);
	}
});

/**
 * POST /api/modules/:name/reload
 * Перезавантажити модуль (гаряче оновлення)
 */
router.post("/api/modules/:name/reload", async (req, res) => {
	try {
		await modulesController.reloadModule(req.params.name);
		res.json({ success: true, message: `Module ${req.params.name} reloaded` });
	} catch (error) {
		fail(res, "reloading module", error);
	}
});

/**
 * POST /api/modules/:name/install
 * Встановити модуль
 */
router.post("/api/modules/:name/install", async (req, res) => {
	try {
		await modulesController.installModule(req.params.name);
		res.json({ success: true, message: `Module ${req.params.name} installed` });
	} catch (error) {
		fail(res, "installing module", error);
	}
});

/**
 * POST /api/modules/:name/uninstall
 * Видалити дані модуля
 */
router.post("/api/modules/:name/uninstall", async (req, res) => {
	try {
		await modulesController.uninstallModule(req.params.name);
		res.json({ success: true, message: `Module ${req.params.name} uninstalled` });
	} catch (error) {
		fail(res, "uninstalling module", error);
	}
});

module.exports = router;