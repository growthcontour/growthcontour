const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

/**
 * Утиліти для роботи з електронною поштою
 */
const emailUtils = {
    /**
     * Отримує HTML-шаблон для електронного листа
     * @param {string} templateName - Назва шаблону (без розширення)
     * @param {Object} data - Дані для підстановки в шаблон
     * @returns {string} - HTML-код листа
     */
    getEmailTemplate: function(templateName, data = {}) {
        try {
            // Шлях до шаблону
            const templatePath = path.join(__dirname, '..', 'views', 'emails', 'templates', `${templateName}.html`);
            
            // Перевіряємо, чи існує шаблон
            if (!fs.existsSync(templatePath)) {
                throw new Error(`Шаблон ${templateName}.html не знайдено`);
            }
            
            // Читаємо шаблон
            const template = fs.readFileSync(templatePath, 'utf8');
            
            // Компілюємо шаблон з даними
            const compiledTemplate = ejs.render(template, data);
            
            // Перевіряємо, чи успішно отримано шаблон
            if (!compiledTemplate) {
                throw new Error('Помилка при компіляції шаблону');
            }
            
            return compiledTemplate;
        } catch (error) {
            console.error(`Помилка при отриманні шаблону електронного листа: ${error.message}`);
            // Повертаємо простий текстовий шаблон у випадку помилки
            return `
                <html>
                    <body>
                        <h1>Скидання паролю</h1>
                        <p>Для скидання паролю перейдіть за посиланням: <a href="${data.resetURL}">${data.resetURL}</a></p>
                        <p>Посилання дійсне протягом 1 години.</p>
                        <p>Якщо ви не запитували скидання паролю, проігноруйте цей лист.</p>
                        <p>З повагою, SkyNeuron</p>
                    </body>
                </html>
            `;
        }
    }
};

module.exports = emailUtils;