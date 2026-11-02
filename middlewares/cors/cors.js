/**
 * CORS Handler Middleware
 * Технічно правильна реалізація з різними політиками для різних маршрутів
 */

const cors = require('cors');

// 1. Політика для ВІДЖЕТІВ (Chat Widget)
// Дозволяє будь-якому сайту завантажувати widget.js та робити запити до /chat/*
const widgetCors = cors({
    origin: true, // Дозволяємо всім (або можна перевіряти whitelist сайтів клієнтів)
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
});

// Middleware спеціально для віддачі статичних файлів віджета (widget.js)
// Додає необхідні заголовки CORP та COOP
const widgetResourceHandler = (req, res, next) => {
    // Якщо це запит до файлу віджета
    if (req.path.includes('widget.js') || req.path.startsWith('/chat/widget')) {
        // Важливо для CORP: дозволяємо використання ресурсу з будь-якого походження
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); // Або 'unsafe-none' якщо виникають проблеми з ізоляцією
    }
    next();
};

// 2. Політика для ЗАХИЩЕНИХ API (Замовлення, Токени)
// Тут CORS не потрібен, якщо запити йдуть сервер-сервер, або він суворий
const apiCors = cors({
    origin: function (origin, callback) {
        // Якщо немає origin (сервер-сервер запити) - пропускаємо
        if (!origin) return callback(null, true);

        const allowedOrigins = process.env.CORS_ORIGINS 
            ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
            : [];
        
        // Перевірка по домену
        const isAllowed = allowedOrigins.some(allowed => {
            try {
                const urlObj = new URL(origin);
                const allowedObj = new URL(allowed);
                return urlObj.hostname === allowedObj.hostname;
            } catch (e) {
                return false;
            }
        });

        callback(null, isAllowed);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Site-Token', 'X-Requested-With']
});

// 3. Головна функція middleware
const corsHandler = (req, res, next) => {
    const path = req.path;

    // --- ГРУПА 1: Віджети та публічні чати ---
    // Шляхи: /chat/, /widget.js, /api/widget/
    if (path.startsWith('/chat/') || path.includes('widget.js') || path.startsWith('/api/widget/')) {
        // Спочатку ставимо заголовки ресурсів, потім обробляємо CORS
        widgetResourceHandler(req, res, () => {
            widgetCors(req, res, next);
        });
        return;
    }

    // --- ГРУПА 2: Системні API (Замовлення, Інтеграції) ---
    // Шляхи: /api/orders/, /viber/, /instagram/, /telegram/
    // Тут ми або вимикаємо CORS (якщо це webhook), або ставимо суворий
    if (
        path.startsWith('/api/orders/') || 
        path.startsWith('/viber/') || 
        path.startsWith('/instagram/') || 
        path.startsWith('/telegram/') ||
        path.startsWith('/webhooks/')
    ) {
        // Для вебхуків краще не ставити CORS взагалі, або дуже суворо
        // Але якщо з цих шляхів браузер робить запити з токеном - використаємо apiCors
        // Якщо це виключно сервер-сервер (вебхуки), то просто next()
        
        // Припускаємо, що /api/orders/statuses/pull може викликатися з браузера з токеном
        if (path.startsWith('/api/orders/')) {
             return apiCors(req, res, next);
        }
        
        // Для вебхуків месенджерів CORS часто не потрібен, але щоб уникнути помилок при перевірці:
        return next(); 
    }

    // --- ГРУПА 3: Всі інші запити (Адмінка, API CRM) ---
    // Використовуємо сувору політику з env змінної
    return apiCors(req, res, next);
};

module.exports = corsHandler;