const fs = require("fs");
const i18n = require("i18n");

// ==============================
// 1. Допоміжні функції
// ==============================

/**
 * Рекурсивно об'єднує два об'єкти (source має пріоритет).
 * @param {Object} target - базовий об'єкт (мутується)
 * @param {Object} source - джерело
 * @returns {Object} оновлений target
 */
function deepMerge(target, source) {
	for (const key of Object.keys(source)) {
		const val = source[key];
		if (val && typeof val === "object" && !Array.isArray(val)) {
			target[key] = deepMerge(target[key] || {}, val);
		} else {
			target[key] = val; // перезаписуємо
		}
	}
	return target;
}

/**
 * Синхронно завантажує JSON-файл.
 * @param {string} filePath - абсолютний або відносний шлях
 * @returns {Object|null} розпарсений об'єкт або null (якщо файл відсутній чи пошкоджений)
 */
function loadJsonFile(filePath) {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * Завантажує всі файли локалізації для заданої мови та об'єднує їх.
 * @param {string} locale - код мови (наприклад, "en")
 * @param {string[]} filePaths - масив шляхів із плейсхолдером {locale}
 * @returns {Object} об'єднаний переклад
 */
function loadLocaleFiles(locale, filePaths) {
	let merged = {};
	for (const relativePath of filePaths) {
		const fullPath = relativePath.replace(/\{locale\}/g, locale);
		const data = loadJsonFile(fullPath);
		if (data) {
			// Останній завантажений файл перезаписує попередні
			merged = deepMerge(merged, data);
		}
	}
	return merged;
}

// ==============================
// 2. Список файлів локалізації (згруповано за категоріями)
// ==============================

const RELATIVE_FILE_PATHS = [
	// --- Основні файли ---
	"./locales/{locale}/{locale}.json",
	"./locales/{locale}/index/index.json",

	// --- Меню ---
	"./locales/{locale}/header.json",

	// --- Авторизація ---
	"./locales/{locale}/authorization/authorization.json",
	"./locales/{locale}/authorization/register.json",
	"./locales/{locale}/authorization/reset-password.json",

	// --- Замовлення ---
	"./locales/{locale}/orders/orders.json",
	"./locales/{locale}/orders/server/server.json",
	"./locales/{locale}/orders/rules/rules.json",
	"./locales/{locale}/orders/messages/messages.json",
	"./locales/{locale}/orders/new/new.json",
	"./locales/{locale}/orders/returns/returns.json",
	"./locales/{locale}/orders/statuses/statuses.json",
	"./locales/{locale}/orders/page/page.json",
	"./locales/{locale}/orders/print/print.json",
	"./locales/{locale}/analytics/analytics.json",
	"./locales/{locale}/reports/reports.json",
	"./locales/{locale}/dicts/dicts.json",
	"./locales/{locale}/orders/abandoned-cart/services/services.json",
	"./locales/{locale}/orders/abandoned-cart/abandoned-cart.json",
	"./locales/{locale}/orders/abandoned-cart/events/events.json",
	"./locales/{locale}/orders/abandoned-cart/report/report.json",
	"./locales/{locale}/orders/abandoned-cart/logs/logs.json",
	"./locales/{locale}/orders/abandoned-cart/dispatch/dispatch.json",
	"./locales/{locale}/orders/abandoned-cart/create/create.json",
	"./locales/{locale}/orders/tokens/tokens.json",
	"./locales/{locale}/orders/integrations/integrations.json",

	// --- Ліди та угоди ---
	"./locales/{locale}/leads/leads.json",
	"./locales/{locale}/leads/server/server.json",
	"./locales/{locale}/leads/list/list.json",
	"./locales/{locale}/leads/view.json",
	"./locales/{locale}/leads/settings/settings.json",
	"./locales/{locale}/deals/deals.json",
	"./locales/{locale}/deals/server/server.json",
	"./locales/{locale}/deals/list/list.json",
	"./locales/{locale}/deals/view/view.json",
	"./locales/{locale}/deals/settings/settings.json",
	"./locales/{locale}/customers/customers.json",

	// --- Клієнти ---
	"./locales/{locale}/clients/clients.json",
	"./locales/{locale}/clients/settings/settings.json",
	"./locales/{locale}/clients/list/list.json",
	"./locales/{locale}/clients/card/card.json",
	"./locales/{locale}/clients/duplicates/duplicates.json",
	"./locales/{locale}/clients/merge/merge.json",
	"./locales/{locale}/clients/import/import.json",

	// --- Користувачі ---
	"./locales/{locale}/users/users.json",
	"./locales/{locale}/users/profile.json",
	"./locales/{locale}/users/edit.json",
	"./locales/{locale}/users/groups.json",
	"./locales/{locale}/users/access.json",

	// --- Контакт-центр ---
	"./locales/{locale}/contact-center/telegram/edit.json",
	"./locales/{locale}/contact-center/telegram/settings.json",
	"./locales/{locale}/contact-center/chat.json",
	"./locales/{locale}/contact-center/channels.json",
	"./locales/{locale}/contact-center/webchat/view.json",
	"./locales/{locale}/contact-center/webchat/dialog.json",
	"./locales/{locale}/contact-center/webchat/site.json",
	"./locales/{locale}/contact-center/webchat/settings.json",
	"./locales/{locale}/contact-center/instagram/settings.json",
	"./locales/{locale}/contact-center/dialog.json",
	"./locales/{locale}/contact-center/comments.json",
	"./locales/{locale}/contact-center/social/common.json",
	"./locales/{locale}/contact-center/social/posts.json",
	"./locales/{locale}/contact-center/social/calendar.json",
	"./locales/{locale}/contact-center/social/snippets.json",
	"./locales/{locale}/contact-center/social/stats.json",
	"./locales/{locale}/contact-center/social/post.json",
	"./locales/{locale}/contact-center/social/accounts.json",

	// --- Налаштування ---
	"./locales/{locale}/settings/integration/integration.json",
	"./locales/{locale}/settings/system/system.json",

	// --- Розсилки ---
	"./locales/{locale}/mailing/mailing.json",
	"./locales/{locale}/mailing/campaigns/campaigns.json",
	"./locales/{locale}/mailing/campaign/campaign.json",
	"./locales/{locale}/mailing/contacts/contacts.json",
	"./locales/{locale}/mailing/contact/contact.json",
	"./locales/{locale}/mailing/import/import.json",
	"./locales/{locale}/mailing/report/report.json",
	"./locales/{locale}/mailing/templates/templates.json",
	"./locales/{locale}/mailing/editor/editor.json",
	"./locales/{locale}/mailing/automations/automations.json",
	"./locales/{locale}/mailing/settings/settings.json",
	"./locales/{locale}/modules/modules.json",

	// --- Каталог товарів ---
	"./locales/{locale}/catalog/products/products.json",
	"./locales/{locale}/catalog/products/settings.json",
	"./locales/{locale}/catalog/products/inventory.json",
	"./locales/{locale}/catalog/products/catalog.json",
	"./locales/{locale}/catalog/products/attributes.json",
	"./locales/{locale}/catalog/products/variants.json",
	"./locales/{locale}/catalog/products/options.json",
	"./locales/{locale}/catalog/products/extras.json",
	"./locales/{locale}/catalog/products/stock.json",
	"./locales/{locale}/catalog/products/bulk.json",
	"./locales/{locale}/catalog/products/import.json",
	"./locales/{locale}/catalog/products/maintenance.json",
	"./locales/{locale}/catalog/products/reservations.json",
	"./locales/{locale}/catalog/products/sync.json",
	"./locales/{locale}/catalog/products/languages.json",
	"./locales/{locale}/catalog/products/history.json",
	"./locales/{locale}/catalog/products/seo.json",
	"./locales/{locale}/catalog/products/pricing.json",
	"./locales/{locale}/catalog/products/reviews.json",
	"./locales/{locale}/catalog/products/order-stock.json",
	"./locales/{locale}/catalog/products/alerts.json",
	"./locales/{locale}/catalog/products/quality.json",
	"./locales/{locale}/catalog/products/site-import.json",
	"./locales/{locale}/catalog/products/brands.json",
	"./locales/{locale}/catalog/products/bundle.json",
	"./locales/{locale}/catalog/products/card.json",
	"./locales/{locale}/catalog/products/categories.json",
	"./locales/{locale}/catalog/products/customer-groups.json",
	"./locales/{locale}/catalog/products/downloads.json",
	"./locales/{locale}/catalog/products/overview.json",
	"./locales/{locale}/catalog/products/reorder.json",
	"./locales/{locale}/catalog/products/reports.json",
	"./locales/{locale}/catalog/products/stock-document.json",
	"./locales/{locale}/catalog/products/stock-documents.json",
	"./locales/{locale}/catalog/products/stock-movements.json",
	"./locales/{locale}/catalog/products/stock-overview.json",
	"./locales/{locale}/catalog/products/suppliers.json",
	"./locales/{locale}/catalog/products/warehouses.json",
];

// ==============================
// 3. Підтримувані мови
// ==============================

const LOCALES = [
    "en", // Англійська — базова, обов'язкова
    "uk", // Українська — домашній ринок
    "de", // Німецька — найбільший ринок ЄС
    "fr", // Французька — Франція, Бельгія, Швейцарія, Канада, Африка
    "es", // Іспанська — Іспанія + вся Латинська Америка
    "pt", // Португальська (бразильський варіант) — Бразилія
    "it", // Італійська
    "nl", // Нідерландська — Нідерланди, Бельгія
    "pl", // Польська — найближчий великий ринок для українського продукту
    "zh", // Китайська (спрощена)
    "ja", // Японська
    "ko", // Корейська
];

// ==============================
// 4. Побудова статичного каталогу
// ==============================

// Завантажуємо англійську базу один раз (вона буде основою для всіх мов)
const enBase = loadLocaleFiles("en", RELATIVE_FILE_PATHS);

const staticCatalog = {};

// Англійська – без змін
staticCatalog.en = enBase;

// Для решти мов: беремо enBase + перезаписуємо власними файлами
for (const locale of LOCALES) {
	if (locale === "en") continue;

	const localeData = loadLocaleFiles(locale, RELATIVE_FILE_PATHS);
	const merged = deepMerge({}, enBase); // клонуємо англійську
	deepMerge(merged, localeData); // додаємо/перезаписуємо поточною мовою
	staticCatalog[locale] = merged;
}

// ==============================
// 5. Конфігурація i18n
// ==============================

i18n.configure({
	staticCatalog,
	objectNotation: true,
	defaultLocale: "en",
	cookie: "lang",
	queryParameter: "lang",
});

module.exports = i18n;