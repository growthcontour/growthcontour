const { createGuard } = require("../common/accessGuard");

/**
 * Права модуля лідів:
 *   leads.list     — view: список і картки; add: створювати; edit: змінювати; delete: видаляти в кошик
 *   leads.all      — view: бачити всі ліди (без нього — лише свої і без відповідального)
 *   leads.settings — edit: налаштування модуля
 */
const id = (req, m) => [m[1]];

module.exports = createGuard({
	match: /^\/(api\/)?leads(\/|$)/,
	publicPaths: [/^\/api\/leads\/add\/[^/]+\/$/], // прийом лідів з сайтів за токеном
	allSlug: "leads.all",
	table: "leads",
	ownerCol: "id_manager",
	rules: [
		{ re: /^\/leads\/settings\//, slug: "leads.settings", action: "edit" },
		{ re: /^\/api\/leads\/ui-settings\//, slug: "leads.list", action: "view" },
		{ re: /^\/api\/leads\/(\d+)\/delete\/$/, slug: "leads.list", action: "delete", ids: id },
		{ re: /^\/api\/leads\/(\d+)\/(history|activities|files)\/$/, slug: "leads.list", action: "view", ids: id },
		{ re: /^\/api\/leads\/(\d+)\//, slug: "leads.list", action: "edit", ids: id },
		{ re: /^\/leads\/(\d+)\//, slug: "leads.list", action: "view", ids: id },
		{ re: /^\/(api\/)?leads\//, slug: "leads.list", action: "view" },
	],
});