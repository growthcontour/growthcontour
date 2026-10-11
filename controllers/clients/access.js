const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;

/**
 * Права модуля клієнтів (slug у users_permissions_pages):
 *   clients.list     — view: бачити список і картки; add: створювати; edit: редагувати, масові дії
 *   clients.all      — view: бачити всіх клієнтів (без нього — лише своїх і без менеджера)
 *   clients.merge    — view: сторінка дублів; edit: зливати й скасовувати злиття
 *   clients.export   — view: експорт у CSV
 *   clients.import   — add: імпорт
 *   clients.settings — edit: довідники, перерахунки, службові дії
 */
const can = (req, slug, action = "view") => req.user?.permissions?.[slug]?.[action] === true;
const seeAll = (req) => can(req, "clients.all", "view");
const userOf = (req) => req.user.userId || req.user.id;

/** Умова видимості для SQL (alias таблиці клієнтів — c) */
function scope(req) {
	if (seeAll(req)) return null;
	return { sql: "(c.id_manager = ? OR c.id_manager IS NULL)", params: [userOf(req)] };
}

/** Чи бачить користувач цих клієнтів (усіх із переліку) */
async function visible(req, ids) {
	const list = [...new Set(ids.map((x) => parseInt(x, 10)).filter(Boolean))];
	if (!list.length || seeAll(req)) return true;
	const [rows] = await pool.query(`SELECT id FROM ${P}clients WHERE id IN (?) AND (id_manager = ? OR id_manager IS NULL)`, [list, userOf(req)]);
	return rows.length === list.length;
}

/**
 * Політика доступу: перше правило, що збіглося з шляхом, вирішує.
 * ids(req) — клієнти, яких стосується запит (для перевірки видимості).
 */
const RULES = [
	{ re: /^\/(api\/)?clients\/settings\//, slug: "clients.settings", action: "edit" },
	{ re: /^\/api\/clients\/(rfm\/recalc|recalc-stats|backfill)\//, slug: "clients.settings", action: "edit" },
	{ re: /^\/(api\/)?clients\/import\//, slug: "clients.import", action: "add" },
	{ re: /^\/api\/clients\/export\//, slug: "clients.export", action: "view" },
	{ re: /^\/api\/clients\/bulk\//, slug: "clients.list", action: "edit" },
	{ re: /^\/api\/clients\/create\//, slug: "clients.list", action: "add" },
	{ re: /^\/api\/clients\/merge\//, slug: "clients.merge", action: "edit", ids: (req) => [(req.body || {}).winner, (req.body || {}).loser] },
	{ re: /^\/api\/clients\/merges\//, slug: "clients.merge", action: "edit" },
	{ re: /^\/clients\/merge\//, slug: "clients.merge", action: "view", ids: (req) => [req.query.a, req.query.b] },
	{ re: /^\/(api\/)?clients\/duplicates\//, slug: "clients.merge", action: "view" },
	{ re: /^\/api\/clients\/(\d+)\/delete\/$/, slug: "clients.list", action: "delete", ids: (req, m) => [m[1]] },
	// Картка: читання й нотатки — з правом перегляду, решта змін — з правом редагування
	{ re: /^\/api\/clients\/(\d+)\/(timeline|history|fields|notes)\/$/, slug: "clients.list", action: "view", ids: (req, m) => [m[1]] },
	{ re: /^\/api\/clients\/(\d+)\/notes\//, slug: "clients.list", action: "view", ids: (req, m) => [m[1]] },
	{ re: /^\/api\/clients\/(\d+)\//, slug: "clients.list", action: "edit", ids: (req, m) => [m[1]] },
	{ re: /^\/clients\/(\d+)\//, slug: "clients.list", action: "view", ids: (req, m) => [m[1]] },
	{ re: /^\/(api\/)?clients\//, slug: "clients.list", action: "view" },
];

function deny(req, res, status, msg) {
	const api = req.originalUrl.startsWith("/api/") || req.xhr || (req.headers.accept || "").includes("json");
	return api ? res.status(status).json({ ok: false, error: msg }) : res.status(status).send(msg);
}

async function policy(req, res, next) {
	const raw = req.originalUrl.split("?")[0];
	const p = raw.endsWith("/") ? raw : raw + "/";
	for (const r of RULES) {
		const m = p.match(r.re);
		if (!m) continue;
		if (!can(req, r.slug, r.action)) return deny(req, res, 403, "Немає доступу.");
		if (r.ids) {
			try {
				if (!(await visible(req, r.ids(req, m)))) return deny(req, res, 404, "Клієнта не знайдено.");
			} catch (e) {
				return next(e);
			}
		}
		return next();
	}
	return next();
}

/**
 * Підключається один раз у server.js: app.use(clientsAccess.guard).
 * Для шляхів модуля клієнтів — автентифікація + політика; решту пропускає.
 */
function guard(req, res, next) {
	const raw = req.originalUrl.split("?")[0];
	if (!/^\/(api\/)?clients(\/|$)/.test(raw)) return next();
	// Прийом клієнтів із сайтів за токеном — без входу (перевірку робить verifyOrderToken)
	if (/^\/api\/clients\/receive\/?$/.test(raw)) return next();
	const auth = require("../authorization/authorization");
	return auth.isAuthenticated(req, res, () => policy(req, res, next));
}

module.exports = { can, seeAll, scope, visible, policy, guard };