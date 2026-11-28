const pool = require("../../../config/database/connection_pool");
const logging = require("../../../logging/logging");
const cfg = require("../../../config/notifications/config");
const wp = require("../../../helpers/webpush");

const P = cfg.prefix;
const TABLE = P + "manager_push_subs";

// Канал доставки web-push. Адресат — усі підписки менеджера (job.userId).
// Контракт як у решти каналів: { skipped } | { ok } | throw (для retry).
async function send(job) {
	if (!wp.ready) return { skipped: true }; // VAPID не налаштовано — тихо пропускаємо

	const userId = job.userId;
	if (!userId) return { skipped: true };

	const [subs] = await pool.query(`SELECT id, endpoint, p256dh, auth FROM ${TABLE} WHERE id_manager = ?`, [userId]);
	if (!subs.length) return { skipped: true }; // менеджер не підписаний у жодному браузері

	const pl = job.payload || {};
	const payload = {
		title: pl.title || "CRM",
		body: pl.body || pl.message || "",
		url: pl.url || "/",
		tag: pl.tag || pl.collapseKey,
		icon: pl.icon,
	};

	const dead = [];
	let anyOk = false;
	let lastTransientErr = null;

	for (const s of subs) {
		const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
		const res = await wp.send(sub, payload);
		if (res.ok) {
			anyOk = true;
		} else if (res.gone) {
			dead.push(s.id); // 404/410 — підписка мертва
		} else {
			lastTransientErr = res.error; // тимчасова помилка push-сервісу
		}
	}

	// Прибираємо мертві підписки (не блокуючи результат доставки)
	if (dead.length) {
		await pool.query(`DELETE FROM ${TABLE} WHERE id IN (?)`, [dead]).catch((e) => logging.error(e));
	}

	// Оновлюємо date_last_ok для живих — корисно для майбутнього прибирання неактивних
	if (anyOk) {
		await pool.query(`UPDATE ${TABLE} SET date_last_ok = NOW() WHERE id_manager = ?`, [userId]).catch(() => {});
		return { ok: true };
	}

	// Жодна не доставилась. Якщо була тимчасова помилка — кидаємо (retry).
	// Якщо всі були "мертві" — це не помилка, а skipped.
	if (lastTransientErr) throw new Error("webpush: " + lastTransientErr);
	return { skipped: true };
}

module.exports = { send };