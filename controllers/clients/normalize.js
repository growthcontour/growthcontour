const { parsePhoneNumberFromString } = require("libphonenumber-js/max");

// Країна за замовчуванням для номерів без міжнародного коду
const DEFAULT_COUNTRY = String(process.env.CLIENTS_DEFAULT_COUNTRY || "UA").toUpperCase();

function country(c) {
	const s = String(c || "").trim().toUpperCase();
	return /^[A-Z]{2}$/.test(s) ? s : null;
}

// Прибирає зайві пробіли, невидимі символи, обрізає довжину
function cleanText(s, max) {
	return String(s == null ? "" : s)
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max || 255);
}

/**
 * Телефон → E.164.
 * countryHint — країна, якщо номер без коду (з адреси, сайту, мови).
 * Повертає { value, normalized, country, valid, formatted } або null.
 */
function phone(input, countryHint) {
	const raw = cleanText(input, 64);
	if (!raw) return null;

	const s = raw.replace(/^00/, "+"); // 0048... → +48...
	const hint = country(countryHint) || DEFAULT_COUNTRY;
	const p = parsePhoneNumberFromString(s, hint);

	if (p && p.isValid()) {
		return { value: raw, normalized: p.number, country: p.country || null, valid: true, formatted: p.formatInternational() };
	}

	// Не вдалося розпізнати: зберігаємо лише цифри (для пошуку дублів), позначаємо як невалідний
	const digits = s.replace(/\D/g, "");
	if (digits.length < 6) return null;
	return { value: raw, normalized: digits, country: null, valid: false, formatted: raw };
}

/** Email → нижній регістр. Повертає { value, normalized, valid } або null. */
function email(input) {
	const raw = cleanText(input, 255);
	if (!raw) return null;
	const n = raw.toLowerCase();
	return { value: raw, normalized: n, valid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(n) };
}

/** Нікнейм месенджера/соцмережі: @user, t.me/user, instagram.com/user → user */
function handle(input) {
	const raw = cleanText(input, 255);
	if (!raw) return null;
	const n = raw
		.replace(/^https?:\/\/(www\.)?(t\.me|telegram\.me|instagram\.com)\//i, "")
		.replace(/^@/, "")
		.replace(/[/?#].*$/, "")
		.toLowerCase();
	if (!n) return null;
	return { value: raw, normalized: n, valid: /^[a-z0-9_.]{2,64}$/.test(n) };
}

/** Сайт → домен без протоколу, www і слеша в кінці */
function website(input) {
	const raw = cleanText(input, 255);
	if (!raw) return null;
	const n = raw.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
	return { value: raw, normalized: n, valid: /^[a-z0-9.-]+\.[a-z]{2,}/.test(n) };
}

/**
 * Універсальна нормалізація каналу зв'язку за рядком довідника clients_contact_types.
 * typeRow: { code, normalize }
 */
function contact(typeRow, input, countryHint) {
	const code = typeRow && typeRow.code;
	if (code === "website") return website(input);
	if (code === "telegram" || code === "instagram") return handle(input);

	switch (typeRow && typeRow.normalize) {
		case "phone":
			return phone(input, countryHint); // phone, viber, whatsapp
		case "email":
			return email(input);
		case "lower": {
			const raw = cleanText(input, 255);
			return raw ? { value: raw, normalized: raw.toLowerCase(), valid: true } : null;
		}
		default: {
			const raw = cleanText(input, 255);
			return raw ? { value: raw, normalized: raw, valid: true } : null;
		}
	}
}

/**
 * Ідентифікатор (ЄДРПОУ, NIP, VAT...) → без пробілів/дефісів/крапок, верхній регістр.
 * typeRow: { validation_regex }
 */
function identifier(typeRow, input) {
	const raw = cleanText(input, 64);
	if (!raw) return null;
	const n = raw.replace(/[\s\-./]/g, "").toUpperCase();
	let valid = true;
	if (typeRow && typeRow.validation_regex) {
		try {
			valid = new RegExp(typeRow.validation_regex).test(n);
		} catch (e) {
			valid = true; // кривий regex у довіднику не блокує збереження
		}
	}
	return { value: raw, normalized: n, valid };
}

/**
 * Готове ім'я для списків.
 * person: { first_name, middle_name, last_name, trade_name }, org: { short_name, legal_name }
 */
function displayName(kind, person, org, fallback) {
	if (kind === "organization") {
		const o = org || {};
		return cleanText(o.short_name || o.legal_name || fallback || "", 500);
	}
	const p = person || {};
	const full = [p.first_name, p.middle_name, p.last_name].map((x) => cleanText(x)).filter(Boolean).join(" ");
	const name = full || cleanText(fallback || "", 500);
	// ФОП з торговою назвою: «Іван Петренко (Кава&Co)»
	return p.trade_name ? cleanText(name + " (" + cleanText(p.trade_name) + ")", 500) : name;
}

module.exports = { DEFAULT_COUNTRY, country, cleanText, phone, email, handle, website, contact, identifier, displayName };