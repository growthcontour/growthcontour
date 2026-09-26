/**
 * =====================================================
 * МАРШРУТИ ДЛЯ КЕРУВАННЯ МОДУЛЯМИ
 * =====================================================
 * Надає API для:
 * - Отримання списку модулів
 * - Активації/деактивації модулів
 * - Перезавантаження модулів
 * =====================================================
 */

const express = require("express");
const router = express.Router();
const modulesController = require("../../controllers/modules/modulesController");

/**
 * GET /api/modules/
 * Отримати список всіх модулів
 */
router.get("/", (req, res) => {
	try {
		const modules = modulesController.getAllModules();
		res.json({
			success: true,
			data: modules,
		});
	} catch (error) {
		console.error("[Modules API] Error getting modules:", error.message);
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

/**
 * GET /api/modules/:name
 * Отримати інформацію про конкретний модуль
 */
router.get("/:name", (req, res) => {
	try {
		const module = modulesController.getModule(req.params.name);

		if (!module) {
			return res.status(404).json({
				success: false,
				error: "Module not found",
			});
		}

		res.json({
			success: true,
			data: module,
		});
	} catch (error) {
		console.error("[Modules API] Error getting module:", error.message);
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

/**
 * POST /api/modules/:name/enable
 * Активувати модуль
 */
router.post("/:name/enable", async (req, res) => {
	try {
		await modulesController.enableModule(req.params.name);
		res.json({
			success: true,
			message: `Module ${req.params.name} enabled`,
		});
	} catch (error) {
		console.error("[Modules API] Error enabling module:", error.message);
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

/**
 * POST /api/modules/:name/disable
 * Деактивувати модуль
 */
router.post("/:name/disable", async (req, res) => {
	try {
		await modulesController.disableModule(req.params.name);
		res.json({
			success: true,
			message: `Module ${req.params.name} disabled`,
		});
	} catch (error) {
		console.error("[Modules API] Error disabling module:", error.message);
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

/**
 * POST /api/modules/:name/reload
 * Перезавантажити модуль (гаряче оновлення)
 */
router.post("/:name/reload", async (req, res) => {
	try {
		await modulesController.reloadModule(req.params.name);
		res.json({
			success: true,
			message: `Module ${req.params.name} reloaded`,
		});
	} catch (error) {
		console.error("[Modules API] Error reloading module:", error.message);
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

/**
 * POST /api/modules/:name/install
 * Встановити модуль
 */
router.post("/:name/install", async (req, res) => {
	try {
		await modulesController.installModule(req.params.name);
		res.json({
			success: true,
			message: `Module ${req.params.name} installed`,
		});
	} catch (error) {
		console.error("[Modules API] Error installing module:", error.message);
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

/**
 * POST /api/modules/:name/uninstall
 * Видалити модуль
 */
router.post("/:name/uninstall", async (req, res) => {
	try {
		await modulesController.uninstallModule(req.params.name);
		res.json({
			success: true,
			message: `Module ${req.params.name} uninstalled`,
		});
	} catch (error) {
		console.error("[Modules API] Error uninstalling module:", error.message);
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

module.exports = router;
