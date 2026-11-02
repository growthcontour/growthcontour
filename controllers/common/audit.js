const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;

// Порогові значення: масові дії понад ці обсяги — сповіщення адміністраторам
const ALERT = { export: 500, bulk: 1000, import: 5000 };
const ADMIN_GROUP = 1;

const ipOf = (req) => (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "").replace(/^::ffff:/, "") || null;

/**
 * Записати дію в журнал. Ніколи не кидає помилку — журнал не має ламати бізнес-операцію.
 * a: { action, module, entity, id_entity, count, details }
 *   action — export | import | bulk | merge | merge_revert | settings_save | settings_delete | settings_sort | delete | ...
 */
async function log(req, a) {
	try {
		const u = req.user || {};
		const idUser = u.userId || u.id || null;
		const ua = String(req.headers["user-agent"] || "").slice(0, 255);
		await pool.query(
			`INSERT INTO ${P}audit_log (id_user, action, module, entity, id_entity, count, details, ip, user_agent, date_add)
             VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), INET6_ATON(?), ?, NOW(3))`,
			[idUser, String(a.action).slice(0, 32), String(a.module || "").slice(0, 32), a.entity ? String(a.entity).slice(0, 32) : null, a.id_entity || null, Number(a.count) || 0, JSON.stringify(a.details || {}), ipOf(req), ua]
		);

		const limit = ALERT[a.action];
		if (limit && Number(a.count) >= limit) alertAdmins(req, a, idUser);
	} catch (e) {
		console.error("[audit]", e.message);
	}
}

function alertAdmins(req, a, idUser) {
	const u = req.user || {};
	const who = [u.lastName || u.last_name, u.firstName || u.first_name].filter(Boolean).join(" ") || "#" + idUser;
	const what = { export: "експортував", bulk: "масово змінив", import: "імпортував" }[a.action] || a.action;
	require("../notifications/index")
		.notify({
			type: "system.audit",
			audience: { group: ADMIN_GROUP },
			channels: ["inapp"],
			payload: { title: "Масова дія: " + who, message: `${who} ${what} ${a.count} записів (${a.module})`, url: "/audit/" },
			key: "audit:" + a.action + ":" + idUser + ":" + Date.now(),
		})
		.catch((e) => console.error("[audit notify]", e.message));
}

/** Журнал з фільтрами і пагінацією за курсором */
async function list(o) {
	const limit = Math.min(Math.max(parseInt(o.limit, 10) || 50, 1), 200);
	const where = ["1 = 1"];
	const params = [];
	if (o.before_id) {
		where.push("a.id < ?");
		params.push(parseInt(o.before_id, 10));
	}
	if (o.id_user) {
		where.push("a.id_user = ?");
		params.push(parseInt(o.id_user, 10));
	}
	if (o.action) {
		where.push("a.action = ?");
		params.push(String(o.action));
	}
	if (o.module) {
		where.push("a.module = ?");
		params.push(String(o.module));
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(String(o.date_from || ""))) {
		where.push("a.date_add >= ?");
		params.push(o.date_from + " 00:00:00");
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(String(o.date_to || ""))) {
		where.push("a.date_add <= ?");
		params.push(o.date_to + " 23:59:59.999");
	}
	const [rows] = await pool.query(
		`SELECT a.id, a.id_user, a.action, a.module, a.entity, a.id_entity, a.count, a.details,
                INET6_NTOA(a.ip) AS ip, a.user_agent, a.date_add,
                NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS user_name
           FROM ${P}audit_log a
           LEFT JOIN ${P}users u ON u.id = a.id_user
          WHERE ${where.join(" AND ")}
          ORDER BY a.id DESC
          LIMIT ${limit + 1}`,
		params
	);
	const more = rows.length > limit;
	if (more) rows.pop();
	return { rows, has_more: more, next_before_id: more ? rows[rows.length - 1].id : null };
}

module.exports = { log, list, ALERT };