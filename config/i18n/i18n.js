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
	"./locales/{locale}/orders/abandoned-cart/services/services.json",
	"./locales/{locale}/orders/abandoned-cart/abandoned-cart.json",
	"./locales/{locale}/orders/tokens/tokens.json",
	"./locales/{locale}/orders/integrations/integrations.json",

	// --- Ліди та угоди ---
	"./locales/{locale}/leads/leads.json",
	"./locales/{locale}/deals/deals.json",

	// --- Користувачі ---
	"./locales/{locale}/users/users.json",

	// --- Контакт-центр ---
	"./locales/{locale}/contact-center/telegram/edit.json",
	"./locales/{locale}/contact-center/telegram/settings.json",
	"./locales/{locale}/contact-center/chat.json",
	"./locales/{locale}/contact-center/channels.json",
	"./locales/{locale}/contact-center/webchat/view.json",
	"./locales/{locale}/contact-center/instagram/settings.json",
	"./locales/{locale}/contact-center/dialog.json",

	// --- Налаштування ---
	"./locales/{locale}/settings/integration/integration.json",
];

// ==============================
// 3. Підтримувані мови
// ==============================

const LOCALES = [
	"en",
	"uk", // базові
	"de",
	"fr",
	"es",
	"it",
	"pt",
	"nl",
	"pl",
	"ro", // Європа
	"cs",
	"sv",
	"da",
	"no",
	"fi",
	"el",
	"hu",
	"bg",
	"sk",
	"hr",
	"sr",
	"tr",
	"zh",
	"ja",
	"ko",
	"hi",
	"bn",
	"id",
	"vi",
	"th", // світові
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
