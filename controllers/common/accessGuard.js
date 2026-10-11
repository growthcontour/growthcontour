const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;

const can = (req, slug, action = "view") => req.user?.permissions?.[slug]?.[action] === true;
const userOf = (req) => req.user.userId || req.user.id;

/**
 * Фабрика політики доступу модуля.
 * opts: {
 *   match      — RegExp шляхів модуля (напр. /^\/(api\/)?orders(\/|$)/)
 *   publicPaths— RegExp[] шляхів без входу (вебхуки, прийом з сайтів за токеном)
 *   allSlug    — право «бачити всі записи» (без нього — лише свої і без відповідального)
 *   table, ownerCol — таблиця і колонка відповідального для перевірки видимості
 *   rules      — [{ re, slug, action, ids?(req, m) }], перше збігле правило вирішує
 * }
 */
function createGuard(opts) {
	const seeAll = (req) => can(req, opts.allSlug, "view");

	/** Умова видимості для SQL: alias — псевдонім таблиці у запиті */
	function scope(req, alias) {
		if (seeAll(req)) return null;
		return { sql: `(${alias}.${opts.ownerCol} = ? OR ${alias}.${opts.ownerCol} IS NULL)`, params: [userOf(req)] };
	}

	async function visible(req, ids) {
		const list = [...new Set(ids.map((x) => parseInt(x, 10)).filter(Boolean))];
		if (!list.length || seeAll(req)) return true;
		const [rows] = await pool.query(`SELECT id FROM ${P}${opts.table} WHERE id IN (?) AND (${opts.ownerCol} = ? OR ${opts.ownerCol} IS NULL)`, [list, userOf(req)]);
		return rows.length === list.length;
	}

	function deny(req, res, status, msg) {
		const api = req.originalUrl.startsWith("/api/") || req.xhr || (req.headers.accept || "").includes("json");
		return api ? res.status(status).json({ ok: false, error: msg }) : res.status(status).send(msg);
	}

	async function policy(req, res, next) {
		const raw = req.originalUrl.split("?")[0];
		const p = raw.endsWith("/") ? raw : raw + "/";
		for (const r of opts.rules) {
			const m = p.match(r.re);
			if (!m) continue;
			if (!can(req, r.slug, r.action)) return deny(req, res, 403, "Немає доступу.");
			if (r.ids) {
				try {
					if (!(await visible(req, r.ids(req, m)))) return deny(req, res, 404, "Не знайдено.");
				} catch (e) {
					return next(e);
				}
			}
			return next();
		}
		return next();
	}

	function guard(req, res, next) {
		const raw = req.originalUrl.split("?")[0];
		if (!opts.match.test(raw)) return next();
		const p = raw.endsWith("/") ? raw : raw + "/";
		if ((opts.publicPaths || []).some((re) => re.test(p))) return next();
		const auth = require("../authorization/authorization");
		return auth.isAuthenticated(req, res, () => policy(req, res, next));
	}

	return { can, seeAll, scope, visible, policy, guard };
}

module.exports = { createGuard, can };