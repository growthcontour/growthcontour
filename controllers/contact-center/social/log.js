/**
 * Історія публікації: кожна дія користувача і результат черги.
 * Записи лише додаються — ні змінювати, ні видаляти їх інтерфейс не дозволяє.
 *
 * action:
 *   created, updated, submitted (на перевірку), approved, rejected, scheduled, publish_now, draft,
 *   canceled, retried, deleted — дії користувача;
 *   published, failed, retry_later, comment_done, comment_failed — результат черги (id_user = NULL).
 */
const pool = require("../../../config/database/connection_pool");
const logging = require("../../../logging/logging");
const { P } = require("./social");

const T = P + "social_post_log";

/** Записати подію. conn — якщо всередині транзакції. Помилка запису не ламає основну дію. */
async function add(conn, entry) {
	const db = conn || pool;
	try {
		await db.query(`INSERT INTO ${T} (id_post, id_target, id_user, action, note, details) VALUES (?, ?, ?, ?, ?, ?)`, [
			entry.id_post,
			entry.id_target || null,
			entry.id_user || null,
			String(entry.action).slice(0, 32),
			entry.note ? String(entry.note).slice(0, 1000) : null,
			entry.details ? JSON.stringify(entry.details) : null,
		]);
	} catch (e) {
		if (conn) throw e; // у транзакції — нехай відкотиться разом з дією
		logging.error(e);
	}
}

async function list(idPost) {
	const [rows] = await pool.query(
		`SELECT l.id, l.id_target, l.action, l.note, l.details, l.date_add,
		        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS user_name,
		        a.name AS account_name, a.network
		   FROM ${T} l
		   LEFT JOIN ${P}users u ON u.id = l.id_user
		   LEFT JOIN ${P}social_post_targets t ON t.id = l.id_target
		   LEFT JOIN ${P}social_accounts a ON a.id = t.id_account
		  WHERE l.id_post = ?
		  ORDER BY l.id DESC`,
		[idPost]
	);
	return rows;
}

module.exports = { add, list };