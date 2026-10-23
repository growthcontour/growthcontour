const { createGuard } = require("../common/accessGuard");

/**
 * Права модуля замовлень:
 *   orders.list      — view: список і картки; edit: статус, привʼязка клієнта; delete: видаляти в кошик
 *   orders.all       — view: бачити всі замовлення (без нього — лише свої і без відповідального)
 *   orders.abandoned — view: покинуті кошики; edit: розсилки, сценарії, сервіси
 *   orders.settings  — edit: статуси, інтеграції, токени, налаштування
 */
const id = (req, m) => [m[1]];

module.exports = createGuard({
	match: /^\/(api\/)?orders(\/|$)/,
	// Прийом з сайтів і маркетплейсів за токеном — без входу
	publicPaths: [
		/^\/api\/orders\/receive\/(quick\/)?$/,
		/^\/api\/orders\/statuses\/pull\/$/,
		/^\/api\/orders\/abandoned-cart\/(receive|recover|reconcile|close|recover-verify)\/$/,
	],
	allSlug: "orders.all",
	table: "orders",
	ownerCol: "id_user",
	rules: [
		{ re: /^\/(api\/)?orders\/settings\//, slug: "orders.settings", action: "edit" },
		{ re: /^\/orders\/status\//, slug: "orders.settings", action: "edit" },
		{ re: /^\/api\/orders\/statuses\/(add|update|delete)\//, slug: "orders.settings", action: "edit" },
		{ re: /^\/api\/orders\/abandoned-cart\/(events-save|events-run|send-viber|services-connect|delete)\//, slug: "orders.abandoned", action: "edit" },
		{ re: /^\/(api\/)?orders\/abandoned-cart\//, slug: "orders.abandoned", action: "view" },
		{ re: /^\/api\/orders\/delete\/$/, slug: "orders.list", action: "delete", ids: (req) => [(req.body || {}).id] },
		{ re: /^\/api\/orders\/(\d+)\/(details|history|events|raw|stock)\/$/, slug: "orders.list", action: "view", ids: id },
		{ re: /^\/api\/orders\/(\d+)\//, slug: "orders.list", action: "edit", ids: id },
		{ re: /^\/orders\/(\d+)\//, slug: "orders.list", action: "view", ids: id },
		{ re: /^\/(api\/)?orders\//, slug: "orders.list", action: "view" },
	],
});