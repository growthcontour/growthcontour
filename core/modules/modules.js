/**
 * =====================================================
 * БАЗОВИЙ КЛАС МОДУЛЯ (BaseModule.js)
 * =====================================================
 * Всі модулі повинні наслідуватися від цього класу.
 * Забезпечує стандартні методи для життєвого циклу модуля.
 * =====================================================
 */

class BaseModule {
    /**
     * Конструктор базового модуля
     * @param {Object} moduleConfig - Конфігурація з module.json
     */
    constructor(moduleConfig) {
        this.config = moduleConfig;
        this.name = moduleConfig.name;
        this.version = moduleConfig.version;
        this.description = moduleConfig.description;
        this.author = moduleConfig.author;
        this.isEnabled = false;

        // Реєстри хуків та маршрутів для цього модуля
        this.hooks = {};
        this.routes = [];
    }

    /**
     * Метод встановлення модуля
     * Викликається один раз при першій установці
     * Може бути перевизначений у дочірніх класах
     * @returns {Promise<boolean>}
     */
    async install() {
        console.log(`[Module] ${this.name}: installed`);
        return true;
    }

    /**
     * Метод видалення модуля
     * Викликається при видаленні модуля
     * Може бути перевизначений у дочірніх класах
     * @returns {Promise<boolean>}
     */
    async uninstall() {
        console.log(`[Module] ${this.name}: uninstalled`);
        return true;
    }

    /**
     * Метод активації модуля
     * Викликається при включенні модуля
     * Може бути перевизначений у дочірніх класах
     * @returns {Promise<boolean>}
     */
    async enable() {
        console.log(`[Module] ${this.name}: enabled`);
        this.isEnabled = true;
        return true;
    }

    /**
     * Метод деактивації модуля
     * Викликається при виключенні модуля
     * Може бути перевизначений у дочірніх класах
     * @returns {Promise<boolean>}
     */
    async disable() {
        console.log(`[Module] ${this.name}: disabled`);
        this.isEnabled = false;
        return true;
    }

    /**
     * Реєстрація хука
     * @param {string} hookName - Назва хука (наприклад, 'displayOrderTop')
     * @param {Function} callback - Функція, яка буде викликана
     */
    registerHook(hookName, callback) {
        if (!this.hooks[hookName]) {
            this.hooks[hookName] = [];
        }
        this.hooks[hookName].push(callback);
        console.log(`[Module] ${this.name}: registered hook "${hookName}"`);
    }

    /**
     * Отримання всіх хуків модуля
     * @returns {Object}
     */
    getHooks() {
        return this.hooks;
    }

    /**
     * Реєстрація маршруту
     * @param {Object} route - Об'єкт маршруту { method, path, handler }
     */
    registerRoute(route) {
        this.routes.push(route);
        console.log(`[Module] ${this.name}: registered route ${route.method.toUpperCase()} ${route.path}`);
    }

    /**
     * Отримання всіх маршрутів модуля
     * @returns {Array}
     */
    getRoutes() {
        return this.routes;
    }

    /**
     * Отримання конфігурації модуля
     * @returns {Object}
     */
    getConfig() {
        return this.config;
    }

    /**
     * Отримання шляху до директорії модуля
     * @returns {string}
     */
    getLocalPath() {
        return this.config.localPath || '';
    }
}

module.exports = BaseModule;
