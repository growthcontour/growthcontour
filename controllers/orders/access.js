const { createGuard } = require("../common/accessGuard");

/**
 * Права модуля замовлень:
 *   orders.list      — view: список і картки; edit: статус, привʼязка клієнта; delete: видаляти в кошик
 *   orders.all       — view: бачити всі замовлення (без нього — лише свої і без відповідального)
 *   orders.abandoned — view: покинуті кошики; edit: розсилки, сценарії, сервіси
 *   orders.settings  — edit: статуси, інтеграції, токени, налаштування
 */
const id = (req, m) => [m[1]];

// «Взяти в роботу»: поки замовлення в роботі в менеджера (не довше LOCK_TTL_HOURS), змінювати його може лише він
const LOCK_TTL_HOURS = 12;

const guard = createGuard({
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
		lock: { col: "locked_by", atCol: "locked_at", ttlHours: LOCK_TTL_HOURS, message: (req, name) => req.__("orders.lock.busy", { name }) },
		rules: [
			{ re: /^\/(api\/)?orders\/settings\//, slug: "orders.settings", action: "edit" },
			{ re: /^\/orders\/status\//, slug: "orders.settings", action: "edit" },
			{ re: /^\/api\/orders\/statuses\/(add|update|delete)\//, slug: "orders.settings", action: "edit" },
			{ re: /^\/api\/orders\/abandoned-cart\/(events-save|events-run|send-viber|services-connect|delete)\//, slug: "orders.abandoned", action: "edit" },
			{ re: /^\/(api\/)?orders\/abandoned-cart\//, slug: "orders.abandoned", action: "view" },
			{ re: /^\/(api\/)?orders\/(new|create)\/$/, slug: "orders.list", action: "edit" },
			{ re: /^\/api\/orders\/delete\/$/, slug: "orders.list", action: "delete", ids: (req) => [(req.body || {}).id], lock: true },
			{ re: /^\/api\/orders\/(\d+)\/(take|release)\/$/, slug: "orders.list", action: "edit", ids: id },
			{ re: /^\/api\/orders\/(\d+)\/(details|history|events|raw|stock|risk|messages|returns)\/$/, slug: "orders.list", action: "view", ids: id },
			{ re: /^\/api\/orders\/(\d+)\//, slug: "orders.list", action: "edit", ids: id, lock: true },
			{ re: /^\/orders\/(\d+)\//, slug: "orders.list", action: "view", ids: id },
			{ re: /^\/(api\/)?orders\//, slug: "orders.list", action: "view" },
		],
});

const BULK_MAX = 200;

/**
 * Масові дії: які з вибраних замовлень користувач може змінювати.
 * Лише видимі йому (orders.all або свої / без відповідального); взяті в роботу іншим — пропускаються, як і в картці.
 * Повертає { ok: [{ id, reference, id_user, status }], skipped: [{ id, reference?, reason }] }
 */
async function targets(req, rawIds) {
	const pool = require("../../config/database/connection_pool");
	const P = require("../../config/config").get("configDatabase").prefix;
	const ids = [...new Set((Array.isArray(rawIds) ? rawIds : []).map((v) => parseInt(v, 10)).filter((n) => n > 0))].slice(0, BULK_MAX);
	if (!ids.length) return { ok: [], skipped: [] };
	const sc = guard.scope(req, "o");
	const [rows] = await pool.query(
		`SELECT o.id, o.reference, o.id_user, o.status,
		        (o.locked_by IS NOT NULL AND o.locked_by <> ? AND o.locked_at > NOW() - INTERVAL ${LOCK_TTL_HOURS} HOUR) AS busy
		   FROM \`${P}orders\` o
		  WHERE o.id IN (?) AND o.deleted_at IS NULL${sc ? " AND " + sc.sql : ""}`,
		[req.user.userId, ids, ...(sc ? sc.params : [])]
	);
	const found = new Set(rows.map((r) => r.id));
	const skipped = ids.filter((id) => !found.has(id)).map((id) => ({ id, reason: "not_found" }));
	const ok = [];
	for (const r of rows) (Number(r.busy) ? skipped.push({ id: r.id, reference: r.reference, reason: "locked" }) : ok.push(r));
	return { ok, skipped };
}

module.exports = { ...guard, targets, LOCK_TTL_HOURS, BULK_MAX };