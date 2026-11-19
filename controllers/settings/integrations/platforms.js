"use strict";

/**
 * Реєстр платформ інтеграцій: які поля показує форма і що вміє інтеграція.
 * fields.*: "required" | "optional" | false
 * caps: orders, statuses, carts, catalog, reviews
 */

// OpenCart 2.3 і 3.0 мають однаковий маршрут модуля
const OC_ENDPOINT = "{base_url}/index.php?route=extension/module/growthcontour/receive";

const SHOP_FIELDS = { base_url: "required", callback_url: "optional", outbound_token: "optional", default_status: false };

const PLATFORMS = {
	opencart: {
		label: "OpenCart",
		versions: ["2.3", "3.0"],
		callback_template: OC_ENDPOINT,
		fields: { base_url: "required", callback_url: "required", outbound_token: "required", default_status: false },
		caps: ["orders", "statuses", "carts", "catalog", "reviews"],
		// Мінімальна версія модуля сайту; нижча — «модуль застарів» у стані сайтів (null — не перевіряти).
		// З цієї версії — частковий обмін, автообмін за змінами, перевірка розбіжностей, захист від масового зникнення
		module_min: "2.0.0",
	},
	prestashop: {
		label: "PrestaShop",
		versions: ["1.7"],
		callback_template: "{base_url}/index.php?fc=module&module=growthcontour&controller=api",
		fields: { base_url: "required", callback_url: "required", outbound_token: "required", default_status: false },
		caps: ["orders", "statuses", "carts", "catalog", "reviews"],
		module_min: "2.0.0",
	},
	woocommerce: { label: "WooCommerce", fields: SHOP_FIELDS, caps: ["orders", "statuses"] },
	shopify: { label: "Shopify", fields: SHOP_FIELDS, caps: ["orders", "statuses"] },
	rozetka: { label: "Rozetka", fields: SHOP_FIELDS, caps: ["orders", "statuses"] },
	prom: { label: "Prom", fields: SHOP_FIELDS, caps: ["orders", "statuses"] },
	amazon: { label: "Amazon", fields: SHOP_FIELDS, caps: ["orders", "statuses"] },
	custom: {
		label: "Custom",
		fields: { base_url: "optional", callback_url: false, outbound_token: false, default_status: "required" },
		caps: ["orders"],
	},
};

const get = (key) => (Object.prototype.hasOwnProperty.call(PLATFORMS, key) ? PLATFORMS[key] : null);
const publicList = () => PLATFORMS;

module.exports = { get, publicList };