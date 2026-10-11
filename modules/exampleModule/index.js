/**
 * =====================================================
 * ПРИКЛАД МОДУЛЯ (exampleModule)
 * =====================================================
 * Демонструє:
 * - Наслідування від BaseModule
 * - Реєстрацію хуків для додавання контенту в шаблони
 * - Реєстрацію маршрутів для обробки GET/POST запитів
 * =====================================================
 */

const BaseModule = require('../../core/modules/modules');

console.log("#############");

class ExampleModule extends BaseModule {
    /**
     * Конструктор модуля
     * @param {Object} config - Конфігурація з module.json
     */
    constructor(config) {
        super(config);

        // Реєструємо хуки при створенні модуля
        this._registerHooks();

        // Реєструємо маршрути при створенні модуля
        this._registerRoutes();
    }

    /**
     * Реєстрація хуків
     */
    _registerHooks() {
        // Хук для додавання контенту на сторінку замовлень
        this.registerHook('displayOrderTop', (params) => {
            return `
                <!-- Content from exampleModule -->
                <div class="module-content" style="background: #f0f0f0; padding: 15px; margin: 10px 0; border-radius: 5px;">
                    <h3>📦 Модуль приклад: ${this.config.version}</h3>
                    <p>Цей текст додано модулем через хук displayOrderTop</p>
                    <p>Налаштування: ${this.config.config.setting1}111111111</p>
                </div>
            `;
        });

        // Хук для додавання CSS
        this.registerHook('displayHeader', (params) => {
            return `
                <style>
                    .module-custom-style {
                        color: #2ecc71;
                        font-weight: bold;
                    }
                </style>
            `;
        });

        // Хук для додавання JS перед закриваючим body
        this.registerHook('displayFooter', (params) => {
            return `
                <script>
                    console.log('[exampleModule] Module loaded on frontend!');
                    // Додаємо клас до всіх елементів з певним класом
                    document.querySelectorAll('.order-item').forEach(el => {
                        el.classList.add('module-custom-style');
                    });
                </script>
            `;
        });
    }

    /**
     * Реєстрація маршрутів
     */
    _registerRoutes() {
        const controller = require('./controllers/exampleController');

        // GET запит - використовуємо контролер
        this.registerRoute({
            method: 'GET',
            path: '/test',
            handler: async (req, res) => {
                const result = await controller.getTest(req, res);
                res.json(result);
            }
        });

        // POST запит - використовуємо контролер
        this.registerRoute({
            method: 'POST',
            path: '/submit',
            handler: async (req, res) => {
                const result = await controller.postSubmit(req, res);
                res.json(result);
            }
        });

        // Ще один GET запит для прикладу - використовуємо контролер
        this.registerRoute({
            method: 'GET',
            path: '/status',
            handler: async (req, res) => {
                const result = await controller.getStatus(req, res);
                res.json(result);
            }
        });
    }

    /**
     * Метод встановлення модуля
     */
    async install() {
        console.log(`[ExampleModule] Installing...`);

        // Тут можна створити таблиці в БД, додати налаштування тощо
        // Наприклад:
        // await db.query('CREATE TABLE IF NOT EXISTS ...');

        return await super.install();
    }

    /**
     * Метод видалення модуля
     */
    async uninstall() {
        console.log(`[ExampleModule] Uninstalling...`);

        // Тут можна видалити таблиці, налаштування тощо
        // Наприклад:
        // await db.query('DROP TABLE IF EXISTS ...');

        return await super.uninstall();
    }

    /**
     * Метод активації модуля
     */
    async enable() {
        console.log(`[ExampleModule] Enabling...`);

        // Додаткові дії при активації

        return await super.enable();
    }

    /**
     * Метод деактивації модуля
     */
    async disable() {
        console.log(`[ExampleModule] Disabling...`);

        // Додаткові дії при деактивації

        return await super.disable();
    }
}

module.exports = ExampleModule;
