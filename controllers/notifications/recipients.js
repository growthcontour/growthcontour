const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const { notify } = require("./notify");

const P = config.get("configDatabase").prefix;
const TABLE = P + "notif_recipients";

/**
 * Отримувачі з іменами — для UI налаштувань будь-якого модуля.
 * Групи повертаються як групи, не розгортаються.
 */
async function list(scope, scopeRef, idLang) {
	const lang = parseInt(idLang, 10) || 1;

	const [rows] = await connection_pool.query(
		`SELECT r.id, r.kind, r.ref, r.options,
                CASE r.kind
                    WHEN 'user'  THEN NULLIF(TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))), '')
                    WHEN 'group' THEN COALESCE(gl.name, gl_any.name)
                    ELSE r.ref
                END AS name
           FROM ${TABLE} AS r
           LEFT JOIN ${P}users AS u
                  ON r.kind = 'user' AND u.id = r.ref
           LEFT JOIN ${P}users_groups_lang AS gl
                  ON r.kind = 'group' AND gl.id_group = r.ref AND gl.id_lang = ?
           LEFT JOIN ${P}users_groups_lang AS gl_any
                  ON r.kind = 'group' AND gl_any.id_group = r.ref
          WHERE r.scope = ? AND r.scope_ref = ?
          ORDER BY r.kind, r.id`,
		[lang, scope, String(scopeRef)]
	);

	return rows.map(function (r) {
		let opts = {};
		try {
			opts = r.options ? (typeof r.options === "string" ? JSON.parse(r.options) : r.options) : {};
		} catch (e) {
			opts = {};
		}
		return { id: r.id, kind: r.kind, ref: String(r.ref), name: r.name, options: opts };
	});
}

/** Повна заміна списку. conn — щоб викликати всередині транзакції модуля. */
async function save(conn, scope, scopeRef, recipients) {
	const db = conn || connection_pool;

	await db.execute(`DELETE FROM ${TABLE} WHERE scope = ? AND scope_ref = ?`, [scope, String(scopeRef)]);

	if (!Array.isArray(recipients) || !recipients.length) return;

	for (const r of recipients) {
		if (["user", "group", "topic"].indexOf(r.kind) === -1) continue;

		const ref = String(r.ref || "").slice(0, 64);
		if (!ref) continue;

		// Усе, крім kind/ref, зберігаємо як прапорці модуля
		const options = {};
		Object.keys(r).forEach(function (k) {
			if (k !== "kind" && k !== "ref" && k !== "id" && k !== "name") options[k] = r[k];
		});

		await db.execute(
			`INSERT INTO ${TABLE} (scope, scope_ref, kind, ref, options)
             VALUES (?, ?, ?, ?, CAST(? AS JSON))
             ON DUPLICATE KEY UPDATE options = VALUES(options)`,
			[scope, String(scopeRef), r.kind, ref, JSON.stringify(options)]
		);
	}
}

/**
 * Розсилка всім отримувачам обʼєкта.
 * Групи передаються в notify() як є — dispatch.js сам їх резолвить.
 *
 * filter — необовʼязковий предикат по options, напр.
 *   (o) => o.on_new_message
 */
async function notifyScope(scope, scopeRef, payload, filter) {
	try {
		const rows = await list(scope, scopeRef);
		if (!rows.length) return 0;

		let sent = 0;

		for (const r of rows) {
			if (typeof filter === "function" && !filter(r.options || {})) continue;

			const audience = {};
			audience[r.kind] = r.ref;

			await notify(Object.assign({}, payload, { audience: audience })).catch(function (e) {
				logging.error(e);
			});

			sent++;
		}

		return sent;
	} catch (error) {
		console.error("notifyScope:", error.message);
		logging.error(error);
		return 0;
	}
}

module.exports = { list, save, notifyScope };