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
 *   rules      — [{ re, slug, action, ids?(req, m), lock? }], перше збігле правило вирішує
 *   lock       — { col, atCol, ttlHours, message(req, name) }: «взяти в роботу». Правило з lock: true
 *                відхиляє зміну (423), якщо запис у роботі в іншого користувача і час ще не минув
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

	/** Хто тримає запис у роботі (інший користувач, не прострочено): { id, name } або null */
	async function lockedBy(req, id) {
		const L = opts.lock;
		const n = parseInt(id, 10);
		if (!L || !n) return null;
		const [[r]] = await pool.query(
			`SELECT t.${L.col} AS id, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS name
			   FROM ${P}${opts.table} t
			   LEFT JOIN ${P}users u ON u.id = t.${L.col}
			  WHERE t.id = ? AND t.${L.col} IS NOT NULL AND t.${L.col} <> ? AND t.${L.atCol} > NOW() - INTERVAL ? HOUR`,
			[n, userOf(req), L.ttlHours]
		);
		return r || null;
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
					const ids = r.ids(req, m);
					if (!(await visible(req, ids))) return deny(req, res, 404, "Не знайдено.");
					if (r.lock && opts.lock) {
						for (const id of ids) {
							const h = await lockedBy(req, id);
							if (h) return deny(req, res, 423, opts.lock.message(req, h.name || "#" + h.id));
						}
					}
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

	return { can, seeAll, scope, visible, lockedBy, policy, guard };
}

module.exports = { createGuard, can };