/**
 * =====================================================
 * КОНТРОЛЕР МОДУЛЯ exampleModule
 * =====================================================
 * Приклад контролера для модуля
 * =====================================================
 */

class ExampleModuleController {
    /**
     * GET /api/module/exampleModule/test
     * Обробник GET запиту
     */
    async getTest(req, res) {
        return {
            success: true,
            message: 'GET запит оброблено модулем exampleModule',
            moduleInfo: {
                name: 'exampleModule',
                version: '1.0.0'
            }
        };
    }

    /**
     * POST /api/module/exampleModule/submit
     * Обробник POST запиту
     */
    async postSubmit(req, res) {
        const data = req.body;

        return {
            success: true,
            message: 'POST запит оброблено модулем exampleModule',
            receivedData: data,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * GET /api/module/exampleModule/status
     * Отримати статус модуля
     */
    async getStatus(req, res) {
        return {
            moduleName: 'exampleModule',
            isEnabled: true,
            uptime: process.uptime(),
            hooksRegistered: 3,
            routesRegistered: 3
        };
    }
}

module.exports = new ExampleModuleController();
