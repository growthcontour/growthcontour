/**
 * =====================================================
 * КОНТРОЛЕР ДЛЯ КЕРУВАННЯ МОДУЛЯМИ
 * =====================================================
 * Відповідає за бізнес-логіку керування модулями:
 * - Отримання списку модулів
 * - Активація/деактивація модулів
 * - Перезавантаження модулів
 * - Встановлення/видалення модулів
 * =====================================================
 */

const moduleManager = require('../../core/modules/modules-manager.js');

class ModulesController {
    /**
     * Отримати список всіх модулів
     * @returns {Array}
     */
    getAllModules() {
        return moduleManager.getAllModules();
    }

    /**
     * Отримати інформацію про конкретний модуль
     * @param {string} moduleName - Назва модуля
     * @returns {Object|null}
     */
    getModule(moduleName) {
        return moduleManager.getModule(moduleName);
    }

    /**
     * Активувати модуль
     * @param {string} moduleName - Назва модуля
     * @returns {Promise<Object>}
     */
    async enableModule(moduleName) {
        await moduleManager.enableModule(moduleName);
        return {
            success: true,
            message: `Module ${moduleName} enabled`
        };
    }

    /**
     * Деактивувати модуль
     * @param {string} moduleName - Назва модуля
     * @returns {Promise<Object>}
     */
    async disableModule(moduleName) {
        await moduleManager.disableModule(moduleName);
        return {
            success: true,
            message: `Module ${moduleName} disabled`
        };
    }

    /**
     * Перезавантажити модуль (гаряче оновлення)
     * @param {string} moduleName - Назва модуля
     * @returns {Promise<Object>}
     */
    async reloadModule(moduleName) {
        await moduleManager.reloadModule(moduleName);
        return {
            success: true,
            message: `Module ${moduleName} reloaded`
        };
    }

    /**
     * Встановити модуль
     * @param {string} moduleName - Назва модуля
     * @returns {Promise<Object>}
     */
    async installModule(moduleName) {
        const moduleData = moduleManager.getModule(moduleName);

        if (!moduleData) {
            throw new Error('Module not found');
        }

        const moduleInstance = moduleManager.modules.get(moduleName).instance;
        await moduleInstance.install();

        return {
            success: true,
            message: `Module ${moduleName} installed`
        };
    }

    /**
     * Видалити модуль
     * @param {string} moduleName - Назва модуля
     * @returns {Promise<Object>}
     */
    async uninstallModule(moduleName) {
        const moduleData = moduleManager.getModule(moduleName);

        if (!moduleData) {
            throw new Error('Module not found');
        }

        // Спочатку деактивуємо якщо активний
        if (moduleData.isEnabled) {
            await moduleManager.disableModule(moduleName);
        }

        const moduleInstance = moduleManager.modules.get(moduleName).instance;
        await moduleInstance.uninstall();

        return {
            success: true,
            message: `Module ${moduleName} uninstalled`
        };
    }
}

module.exports = new ModulesController();
