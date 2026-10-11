/**
 * =====================================================
 * ГОЛОВНИЙ ФАЙЛ ДОДАТКУ (server.js)
 * =====================================================
 * Відповідає за:
 * - Ініціалізацію Express додатку
 * - Налаштування middleware
 * - Підключення маршрутів
 * - Запуск HTTP сервера
 * - Планування cron-задач
 * =====================================================
 */

// Генерація ключів
require("./ensure-env").ensureEnv();
// END Генерація ключів

// ─── ІМПОРТ ЗАЛЕЖНОСТЕЙ ────────────────────────────────
const express = require("express");
const http = require("http");
const path = require("path");
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const compression = require("compression");
const cron = require("node-cron");

const helmet = require("helmet");
const session = require("express-session");

// Внутрішні модулі
const i18n = require("./config/i18n/i18n");
const loadLanguages = require("./middlewares/languages");
const corsHandler = require("./middlewares/cors/cors");

// Система модулів
const moduleManager = require("./core/modules/modules-manager.js");

// ─── ІНІЦІАЛІЗАЦІЯ EXPRESS ДОДАТКУ ────────────────────
const app = express();

// Довіряємо ЛИШЕ довіреному проксі (Nginx/Cloudflare перед додатком).
app.set("trust proxy", 1);

// Захисні HTTP-заголовки (CSP, HSTS, X-Frame-Options тощо).
app.use(
	helmet({
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'self'"],
				scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "https://code.jquery.com", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://cdn.socket.io", "'unsafe-inline'"],
				styleSrc: ["'self'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://unpkg.com", "https://fonts.googleapis.com", "'unsafe-inline'"],
				fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com", "data:"],
				// https: — листи розсилки містять картинки з будь-яких доменів (превʼю/редактор)
				imgSrc: ["'self'", "data:", "blob:", "https:"],
				mediaSrc: ["'self'", "blob:"],
				connectSrc: ["'self'", "ws:", "wss:", "https://cdn.jsdelivr.net", "https://cdn.socket.io"],
				frameSrc: ["'self'", "blob:", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://player.vimeo.com"],
			},
		},
	})
);

// ─── СТВОРЕННЯ HTTP СЕРВЕРА ───────────────────────────
const server = http.createServer(app);

// ─── ІНІЦІАЛІЗАЦІЯ SOCKET.IO ──────────────────────────
const { setupSocketIO, getIO } = require("./controllers/socket/socket");
const io = setupSocketIO(server);

// ─── ІНІЦІАЛІЗАЦІЯ VIBER БОТА ─────────────────────────
const viber_bot = require("./routes/contact-center/viber/viber");
app.use("/viber/webhook/", viber_bot.middleware());

// ─── ЗАВАНТАЖЕННЯ КОНФІГУРАЦІЇ ────────────────────────
const config = require("./config/config");
const configServer = config.get("configServer");

// ═══════════════════════════════════════════════════════
// НАЛАШТУВАННЯ БАЗОВИХ MIDDLEWARE
// ═══════════════════════════════════════════════════════

// ─── ПАРСИНГ ТІЛА ЗАПИТУ ──────────────────────────────
app.use(bodyParser.urlencoded({ extended: false }));
// Сире тіло лише для IG-вебхука — потрібне для перевірки підпису Meta.
// Обов'язково ДО bodyParser.json(), інакше req.body стане об'єктом і підпис не зійдеться.
app.use("/api/contact-center/webhook/instagram", express.raw({ type: "*/*" }));

app.use(express.json({ limit: "300kb" }));

// ─── СТИСНЕННЯ ВІДПОВІДЕЙ ─────────────────────────────
app.use(compression());

// ─── СТАТИЧНІ ФАЙЛИ ──────────────────────────────────
const assetsPath = path.join(__dirname, "assets");

// Імпорти розсилки (персональні дані) і звіти — ніколи не віддаються статикою.
// Шлях декодується і нормалізується, щоб %2F, ./ та \ не обходили перевірку.
app.use("/assets", (req, res, next) => {
	let p;
	try {
		p = path.posix.normalize(decodeURIComponent(req.path).replace(/\\/g, "/")).toLowerCase();
	} catch (e) {
		return res.status(400).end();
	}
	if (/^\/mailing\/(imports|reports)(\/|$)/.test(p)) return res.status(404).end();
	next();
});
app.use("/assets", express.static(assetsPath));

// Service worker для web-push має віддаватись із кореня, щоб мати scope "/"
app.get("/sw-push.js", (req, res) => {
	res.set("Content-Type", "application/javascript; charset=utf-8");
	res.set("Service-Worker-Allowed", "/");
	res.set("Cache-Control", "no-cache");
	res.sendFile(path.join(assetsPath, "js", "sw-push.js"));
});

// Вкладення контакт-центру
app.use(
	"/uploads",
	express.static(path.join(__dirname, "public", "uploads"), {
		maxAge: "7d",
		// Файли приходять від сторонніх користувачів — віддаємо як завантаження,
		// а не виконуємо в контексті домену
		setHeaders: function (res) {
			res.setHeader("X-Content-Type-Options", "nosniff");
			res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
		},
	})
);

// ─── COOKIES ТА CORS ─────────────────────────────────
app.use(cookieParser());

app.use(corsHandler);

// Серверні сесії
app.use(
	session({
		secret: process.env.SESSION_SECRET,
		name: "sid",
		resave: false,
		saveUninitialized: false,
		cookie: {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "strict",
			maxAge: 10 * 60 * 1000,
		},
	})
);

// ─── НАЛАШТУВАННЯ ШАБЛОНІЗАТОРА ──────────────────────
app.set("view engine", "ejs");

// ═══════════════════════════════════════════════════════
// ІНІЦІАЛІЗАЦІЯ СИСТЕМИ МОДУЛІВ
// ВАЖЛИВО: Middleware реєструється СИНХРОННО, щоб hook() був доступний у шаблонах
// ═══════════════════════════════════════════════════════

// 1. Ініціалізуємо менеджер
moduleManager.init(app);

// 2. Реєструємо middleware для хуків ОДРАЗУ (щоб res.locals.hook існував завжди)
app.use(moduleManager.hooksMiddleware());

// 3. Сторінка й API керування модулями підключаються разом з іншими маршрутами (після i18n)

// 4. Асинхронно завантажуємо ТА АКТИВУЄМО всі модулі у фоні
(async () => {
	try {
		console.log("[ModuleManager] Starting async module loading...");
		await moduleManager.loadAllModules(true); // true = авто-активація
		console.log("[ModuleManager] All modules loaded and enabled.");
	} catch (error) {
		console.error("[ModuleManager] Critical error during startup:", error);
		// Не вбиваємо процес, якщо модулі не завантажились, щоб CRM працювала
	}
})();

// ═══════════════════════════════════════════════════════
// НАЛАШТУВАННЯ ІНТЕРНАЦІОНАЛІЗАЦІЇ ТА ЛОКАЛІЗАЦІЇ
// ═══════════════════════════════════════════════════════

app.use(i18n.init);
app.use(loadLanguages);

// ═══════════════════════════════════════════════════════
// НАЛАШТУВАННЯ ПРАВ ДОСТУПУ
// ═══════════════════════════════════════════════════════

app.use((req, res, next) => {
	res.locals.can = () => false;
	next();
});

// ═══════════════════════════════════════════════════════
// ПІДКЛЮЧЕННЯ МАРШРУТІВ
// ═══════════════════════════════════════════════════════

// ─── РОЗСИЛКИ: публічні ендпоінти (відписка, трекінг) — БЕЗ авторизації ─
app.use("/", require("./routes/mailing/public"));

// ─── АВТОРИЗАЦІЯ (ПЕРШОЮ — до всіх захищених роутів!) ─
app.use("/", require("./routes/administrator/authorization/login/login"));

// ─── КОРІНЬ: редирект залежно від автентифікації ─────
const jwtRoot = require("jsonwebtoken");
const cfgRoot = require("./config/config").get("configJWT");

app.get("/", (req, res, next) => {
	const token = req.cookies?.access_token;
	if (!token) return res.redirect("/login/");
	try {
		jwtRoot.verify(token, cfgRoot.jwt.jwt_secret);
		return next();
	} catch {
		res.clearCookie("access_token");
		return res.redirect("/login/");
	}
});

// ─── ГОЛОВНА СТОРІНКА ────────────────────────────────
app.use("/", require("./routes/routes/routes"));
app.use("/", require("./routes/index/index"));

// ─── ЗАМОВЛЕННЯ ──────────────────────────────────────
app.use("/", require("./routes/orders/orders"));

const { recoverOnStartup } = require("./controllers/orders/inboxProcessor");
const { recoverOutboxOnStartup } = require("./controllers/orders/outboxProcessor");
const { recoverCartInboxOnStartup } = require("./controllers/orders/cartInboxProcessor");

// ─── ПОКИНУТІ КОШИКИ ─────────────────────────────────
app.use("/", require("./routes/customers/customers"));
app.use("/", require("./routes/orders/abandoned-cart/abandoned-cart"));
app.use("/", require("./routes/orders/abandoned-cart/services/services"));
app.use("/", require("./routes/orders/abandoned-cart/report/report"));
app.use("/", require("./routes/orders/abandoned-cart/dispatch/dispatch"));
app.use("/", require("./routes/orders/abandoned-cart/recover-link/recover-link"));

// ─── АНАЛІТИКА ───────────────────────────────────────
app.use("/", require("./routes/analytics/index/analytics"));

// ─── КАТАЛОГ ────────────────────────────────────────
app.use("/", require("./routes/catalog/products/settings"));
app.use("/", require("./routes/catalog/products/images"));
app.use("/", require("./routes/catalog/products/languages"));
app.use("/", require("./routes/catalog/products/warehouses"));
app.use("/", require("./routes/catalog/products/stock"));
app.use("/", require("./routes/catalog/products/reservations"));
app.use("/", require("./routes/catalog/products/media"));
app.use("/", require("./routes/catalog/products/categories"));
app.use("/", require("./routes/catalog/products/attributes"));
app.use("/", require("./routes/catalog/products/options"));
app.use("/", require("./routes/catalog/products/variants"));
app.use("/", require("./routes/catalog/products/bundles"));
app.use("/", require("./routes/catalog/products/downloads"));
app.use("/", require("./routes/catalog/products/import"));
app.use("/", require("./routes/catalog/products/bulk"));
app.use("/", require("./routes/catalog/products/picker"));
app.use("/", require("./routes/catalog/products/download-links"));
app.use("/", require("./routes/catalog/products/history"));
app.use("/", require("./routes/catalog/products/seo"));
app.use("/", require("./routes/catalog/products/sync"));
app.use("/", require("./routes/catalog/products/customer-groups"));
app.use("/", require("./routes/catalog/products/reviews"));
app.use("/", require("./routes/orders/stock"));
app.use("/", require("./routes/catalog/products/alerts"));
app.use("/", require("./routes/catalog/products/quality"));
app.use("/", require("./routes/catalog/products/products"));

// ─── КОНТАКТ-ЦЕНТР ──────────────────────────────────
app.use("/", require("./routes/contact-center/contact-center"));
app.use("/", require("./routes/contact-center/channels/channels"));
app.use("/", require("./routes/contact-center/web-chat/web-chat"));
app.use("/", require("./routes/contact-center/webhooks/webhooks"));

// ─── CRM МОДУЛІ ─────────────────────────────────────
app.use("/", require("./routes/leads/leads"));
app.use("/", require("./routes/deals/deals"));
app.use("/", require("./routes/users/users"));
app.use("/", require("./routes/profile/profile"));

// ─── НАЛАШТУВАННЯ ТА ІНТЕГРАЦІЇ ─────────────────────
app.use("/", require("./routes/notifications/notifications"));
// Права модуля клієнтів — одна політика для всіх його роутів
app.use(require("./controllers/clients/access").guard);
app.use(require("./controllers/leads/access").guard);
app.use(require("./controllers/orders/access").guard);
app.use("/", require("./routes/common/saved-filters"));
app.use("/", require("./routes/common/audit"));
app.use("/", require("./routes/common/trash"));
app.use("/", require("./routes/clients/settings"));
app.use("/", require("./routes/clients/import"));
app.use("/", require("./routes/clients/clients"));

// Налаштування
app.use("/", require("./routes/settings/integrations/integrations"));
app.use("/", require("./routes/settings/tokens/tokens"));
app.use("/", require("./routes/settings/integrations/sync-trigger"));
app.use("/", require("./routes/settings/email/email"));

// ─── РОЗСИЛКИ ───────────────────────────────────────
app.use("/", require("./routes/mailing/mailing"));
app.use("/", require("./routes/modules/modules"));

// ─── МАРШРУТИ МОДУЛІВ (після всіх маршрутів ядра, до 404) ─
app.use(moduleManager.router);

// ═══════════════════════════════════════════════════════
// ОБРОБКА ПОМИЛОК
// ═══════════════════════════════════════════════════════

app.use((err, req, res, next) => {
	console.error("Помилка:", err);

	if (req.xhr || (req.headers.accept || "").indexOf("json") > -1) {
		return res.status(err.status || 500).json({ status: "error", message: "Internal server error" });
	}

	res.status(err.status || 500);
	res.render(
		"pages/error/404",
		{
			message: err.message,
			error: process.env.NODE_ENV === "development" ? err : {},
		},
		(renderErr, html) => {
			if (renderErr) {
				console.error("[ERROR PAGE RENDER FAILED]:", renderErr.message);
				return res.status(err.status || 500).send("Internal Server Error");
			}
			res.send(html);
		}
	);
});

app.use((req, res) => {
	if (req.xhr || (req.headers.accept || "").indexOf("json") > -1) {
		return res.status(404).json({ status: "error", message: "Not found" });
	}
	res.status(404).render("pages/error/404", { message: "Сторінку не знайдено", error: { status: 404 } }, (renderErr, html) => {
		if (renderErr) return res.status(404).send("Not Found");
		res.send(html);
	});
});

// ═══════════════════════════════════════════════════════
// НАЛАШТУВАННЯ CRON-ЗАДАЧ ТА АВТОМАТИЗАЦІЇ
// ═══════════════════════════════════════════════════════

const { rebuild, verify } = require("./cron/analytics/rebuildStats");
const { tick: calendarReminderTick, cleanup: calendarReminderCleanup } = require("./cron/notifications/calendar-reminder-cron");

// ═══════════════════════════════════════════════════════
// ЗАПУСК СЕРВЕРА
// ═══════════════════════════════════════════════════════

server.listen(configServer.port, () => {
	console.log("Сайт запущений.\nПорт: " + configServer.port);

	// ─── ВІДНОВЛЕННЯ ЧЕРГ ПРИ ЗАПУСКУ ─────────────────
	recoverOnStartup();
	require("./controllers/clients/import")
		.recoverOnStartup()
		.catch((e) => console.error("[clients-import recover]", e));
	recoverOutboxOnStartup();
	recoverCartInboxOnStartup();

	// ─── РОЗСИЛКИ: воркер черги (MySQL, без Redis) ─────
	if (process.env.MAILING_WORKER !== "0") {
		require("./controllers/mailing/queue").start();
	}

	// ─── АВТОМАТИЗАЦІЯ АНАЛІТИКИ ─────────────────────
	let isAnalyticsRunning = false;

	const runAnalytics = (days, label) => {
		if (isAnalyticsRunning) {
			return console.log(`[analytics] ${label}: пропущено, ще виконується`);
		}

		isAnalyticsRunning = true;
		const startTime = Date.now();

		rebuild(days)
			.then(() => {
				const duration = Math.round((Date.now() - startTime) / 1000);
				console.log(`[analytics] ${label}: готово за ${duration}с`);
			})
			.catch((err) => {
				console.error(`[analytics] ${label}:`, err);
			})
			.finally(() => {
				isAnalyticsRunning = false;
			});
	};

	setTimeout(() => runAnalytics(7, "startup"), 10000);

	cron.schedule("5 * * * *", () => runAnalytics(7, "hourly"), {
		timezone: "Europe/Kyiv",
	});

	cron.schedule("20 3 * * *", () => runAnalytics(45, "daily"), {
		timezone: "Europe/Kyiv",
	});

	// ─── НАГАДУВАННЯ КАЛЕНДАРЯ ───────────────────────
	let isReminderRunning = false;

	cron.schedule(
		"* * * * *",
		async () => {
			if (isReminderRunning) {
				return console.log("[calendar-reminder] пропущено, ще виконується");
			}

			isReminderRunning = true;
			try {
				await calendarReminderTick();
			} catch (err) {
				console.error("[calendar-reminder]", err);
			} finally {
				isReminderRunning = false;
			}
		},
		{
			timezone: "Europe/Kyiv",
		}
	);

	// Кожні 5 хвилин — автозадачі (лід без реакції, повторна покупка, втрачений клієнт)
	cron.schedule(
		"*/5 * * * *",
		() =>
			require("./controllers/automation/autotasks")
				.tick()
				.then((r) => {
					if (r && Object.values(r).some((n) => n > 0)) console.log("[autotasks]", r);
				})
				.catch((e) => console.error("[autotasks]", e)),
		{
			timezone: "Europe/Kyiv",
		}
	);

	// Щодня о 04:20 — остаточне прибирання кошика (старше 30 днів)
	cron.schedule(
		"20 4 * * *",
		() =>
			require("./controllers/common/trash")
				.purgeOld()
				.then((r) => console.log("[trash purge]", r))
				.catch((e) => console.error("[trash purge]", e)),
		{
			timezone: "Europe/Kyiv",
		}
	);

	// Щодня о 03:40 — RFM-сегменти клієнтів і стадія «Втрачений»
	cron.schedule(
		"40 3 * * *",
		() =>
			require("./controllers/clients/rfm")
				.nightly()
				.then((r) => console.log("[clients-rfm]", r))
				.catch((e) => console.error("[clients-rfm]", e)),
		{
			timezone: "Europe/Kyiv",
		}
	);

	// ─── ЗНЯТТЯ ПРОСТРОЧЕНИХ РЕЗЕРВІВ ТОВАРІВ ────────
	let isReservationsRunning = false;
	cron.schedule(
		"* * * * *",
		async () => {
			if (isReservationsRunning) return;
			isReservationsRunning = true;
			try {
				const n = await require("./controllers/catalog/products/reservations").expireDue();
				if (n) console.log(`[reservations] знято прострочених резервів: ${n}`);
			} catch (err) {
				console.error("[reservations]", err);
			} finally {
				isReservationsRunning = false;
			}
		},
		{ timezone: "Europe/Kyiv" }
	);

	// ─── СИНХРОНІЗАЦІЯ ТОВАРІВ З МАГАЗИНАМИ (кожні 5 хвилин) ───
	let isProductSyncRunning = false;
	cron.schedule(
		"*/5 * * * *",
		async () => {
			if (isProductSyncRunning) return;
			isProductSyncRunning = true;
			try {
				await require("./controllers/catalog/products/sync").pushAll();
			} catch (err) {
				console.error("[sync]", err);
			} finally {
				isProductSyncRunning = false;
			}
		},
		{ timezone: "Europe/Kyiv" }
	);

	// ─── ЯКІСТЬ КАТАЛОГУ: ПОВНИЙ ПЕРЕРАХУНОК (щоночі 02:50) ───
	cron.schedule(
		"50 2 * * *",
		async () => {
			try {
				const r = await require("./controllers/catalog/products/quality").recalcAll();
				if (r && r.total) console.log(`[quality] перераховано ${r.total} товарів`);
			} catch (err) {
				console.error("[quality]", err);
			}
		},
		{ timezone: "Europe/Kyiv" }
	);

	// ─── СПОВІЩЕННЯ КАТАЛОГУ (кожні 10 хвилин) ───
	cron.schedule(
		"3-59/10 * * * *",
		async () => {
			try {
				await require("./controllers/catalog/products/alerts").runAll();
			} catch (err) {
				console.error("[catalog-alerts]", err);
			}
		},
		{ timezone: "Europe/Kyiv" }
	);

	// ─── СКЛАД ЗАМОВЛЕНЬ: ПОВТОР ПІСЛЯ НЕСТАЧІ (кожні 15 хвилин) ───
	cron.schedule(
		"*/15 * * * *",
		async () => {
			try {
				await require("./controllers/catalog/products/order-stock").retryPending();
			} catch (err) {
				console.error("[order-stock retry]", err);
			}
		},
		{ timezone: "Europe/Kyiv" }
	);

	// ─── ОБМІН ВІДГУКАМИ З МАГАЗИНАМИ (кожні 10 хвилин) ───
	cron.schedule(
		"*/10 * * * *",
		async () => {
			try {
				await require("./controllers/catalog/products/reviews").syncAll();
			} catch (err) {
				console.error("[reviews-sync]", err);
			}
		},
		{ timezone: "Europe/Kyiv" }
	);

	// ─── ЗАПЛАНОВАНІ ЦІНИ (щохвилини) ───
	cron.schedule(
		"* * * * *",
		async () => {
			try {
				const r = await require("./controllers/catalog/products/pricing").runDue();
				if (r && (r.applied || r.reverted || r.failed)) console.log(`[price-schedule] застосовано ${r.applied}, повернуто ${r.reverted}, помилок ${r.failed}`);
			} catch (err) {
				console.error("[price-schedule]", err);
			}
		},
		{ timezone: "Europe/Kyiv" }
	);

	// ─── ОЧИЩЕННЯ НЕВИКОРИСТАНИХ ЗОБРАЖЕНЬ КАТАЛОГУ (щоночі 03:40) ───
	cron.schedule(
		"40 3 * * *",
		async () => {
			try {
				const r = await require("./controllers/catalog/products/images-maintenance").cleanupAll({ dryRun: false, minAgeHours: 24 });
				if (r) console.log(`[images] очищення: видалено ${r.deleted}, звільнено ${r.freed_bytes} B, помилок ${r.errors}`);
			} catch (err) {
				console.error("[images] очищення", err);
			}
		},
		{ timezone: "Europe/Kyiv" }
	);

	// Щодня о 04:30 — продовження long-lived IG-токенів (нова схема).
	cron.schedule(
		"30 4 * * *",
		() =>
			require("./controllers/contact-center/instagram-refresh")
				.refreshTokens()
				.catch((e) => console.error("[ig-refresh]", e)),
		{
			timezone: "Europe/Kyiv",
		}
	);

	cron.schedule(
		"10 4 * * *",
		async () => {
			try {
				await calendarReminderCleanup();
				console.log("[calendar-reminder] чистка черги готова");
			} catch (err) {
				console.error("[calendar-reminder cleanup]", err);
			}
		},
		{
			timezone: "Europe/Kyiv",
		}
	);
});
