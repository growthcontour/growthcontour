"use strict";

/**
 * Відгуки CRM → магазин.
 * На сайт іде відгук, якщо:
 *  - він прийшов із цього ж сайту (оригінал — передаємо модерацію й відповідь), або
 *  - сайт вибрано у відгуку (products_reviews_sites) і настав час публікації, або
 *  - сайт прибрали з відгуку (state = 'remove') — тоді передаємо deleted.
 * Відповідь сайту (results: crm_id → oc_id) зберігаємо, щоб наступний pull не створив дубль.
 */
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const assortment = require("../../settings/integrations/assortment");

const P = config.get("configDatabase").prefix;

// Відгук бере участь в обміні з сайтом (параметр: id сайту)
const ELIGIBLE = `r.id_product IS NOT NULL AND (
	r.id_integration = ?
	OR (t.id_review IS NOT NULL AND (t.state = 'remove' OR t.publish_at <= NOW()))
)`;

const sqlDate = (v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace("T", " ") : String(v || ""));

function source(idIntegration) {
	let assort = null;
	// crm_id → { state, rev } цілі на момент відправки
	const sent = new Map();
	const init = async () => {
		if (!assort) assort = await assortment.resolver(idIntegration);
	};
	const publishedOf = async (rows) => {
		const st = await assort.products([...new Set(rows.map((r) => r.id_product))]);
		// Прибрання з сайту передаємо завжди, навіть якщо товар уже не публікується
		return rows.filter((r) => r.t_state === "remove" || st.get(Number(r.id_product)).published);
	};

	return {
		BATCH: 200,
		start: 0,
		resume: (crmId) => Number(crmId) || 0,
		count: async () => {
			await init();
			const [rows] = await pool.query(
				`SELECT r.id_product, t.state AS t_state, COUNT(*) AS n
				   FROM ${P}products_reviews r
				   LEFT JOIN ${P}products_reviews_sites t ON t.id_review = r.id AND t.id_integration = ?
				  WHERE ${ELIGIBLE}
				  GROUP BY r.id_product, t.state`,
				[idIntegration, idIntegration]
			);
			return (await publishedOf(rows)).reduce((s, r) => s + Number(r.n), 0);
		},
		batch: async (after, size) => {
			const [rows] = await pool.query(
				`SELECT r.id, r.id_product, r.id_integration, r.external_id, r.rating, r.author_name, r.title, r.body, r.pros, r.cons,
				        r.status, r.reply, r.reply_at, r.deleted_at, r.date_add, t.state AS t_state, t.rev AS t_rev, t.external_id AS t_external_id
				   FROM ${P}products_reviews r
				   LEFT JOIN ${P}products_reviews_sites t ON t.id_review = r.id AND t.id_integration = ?
				  WHERE r.id > ? AND ${ELIGIBLE}
				  ORDER BY r.id LIMIT ?`,
				[idIntegration, after, idIntegration, size]
			);
			if (!rows.length) return { items: [], next: after };
			await init();

			const list = await publishedOf(rows);
			const next = rows[rows.length - 1].id;
			if (!list.length) return { items: [], next, more: rows.length === size };

			const items = list.map((r) => {
				const own = Number(r.id_integration) === Number(idIntegration);
				const removing = !own && r.t_state === "remove";
				if (!own && r.t_state) sent.set(Number(r.id), { state: r.t_state, rev: Number(r.t_rev) });
				const text = [
					r.title ? String(r.title).trim() : "",
					r.body ? String(r.body).trim() : "",
					r.pros ? `+ ${String(r.pros).trim()}` : "",
					r.cons ? `− ${String(r.cons).trim()}` : "",
				]
					.filter(Boolean)
					.join("\n\n");
				const ocId = own ? r.external_id : r.t_external_id;
				const deleted = !!r.deleted_at || removing;
				return {
					crm_id: Number(r.id),
					product_crm_id: Number(r.id_product),
					oc_id: /^\d+$/.test(String(ocId || "")) ? Number(ocId) : null,
					// Оригінал із цього сайту: deleted лише вимикає його. Інакше deleted прибирає відгук із сайту
					own,
					author: r.author_name || "—",
					text,
					rating: Math.min(5, Math.max(1, Number(r.rating) || 5)),
					status: r.status === "approved" && !deleted ? 1 : 0,
					deleted,
					reply: r.reply || null,
					reply_date: r.reply_at ? sqlDate(r.reply_at) : null,
					date_add: sqlDate(r.date_add),
				};
			});
			return { items, next };
		},
		/** Результат сайту: зберегти oc_id; позначити відправленим, прибраним або помилку */
		afterBatch: async (items, results) => {
			// Модуль сайту повертає crm_id (нові версії) або ref
			const byId = new Map(results.filter((x) => x && (x.crm_id || x.ref)).map((x) => [Number(x.crm_id || x.ref), x]));
			const removed = [];
			for (const it of items) {
				const s = sent.get(it.crm_id);
				if (!s) continue;
				sent.delete(it.crm_id);
				// Модуль без results — вважаємо прийнятим
				const res = byId.get(it.crm_id) || (results.length ? null : { ok: true });
				if (!res || res.ok === false) {
					const msg = res ? String(res.error || res.message || "error").slice(0, 500) : "no result";
					await pool.query(
						`UPDATE ${P}products_reviews_sites SET state = IF(state = 'remove', 'remove', 'error'), last_error = ?, attempt_at = NOW()
						  WHERE id_review = ? AND id_integration = ?`,
						[msg, it.crm_id, idIntegration]
					);
					continue;
				}
				if (s.state === "remove") {
					// rev — якщо сайт тим часом повернули у відгук, рядок не видаляємо
					const [d] = await pool.query(`DELETE FROM ${P}products_reviews_sites WHERE id_review = ? AND id_integration = ? AND state = 'remove' AND rev = ?`, [it.crm_id, idIntegration, s.rev]);
					if (d.affectedRows) removed.push(it.crm_id);
					continue;
				}
				const ocId = res.oc_id || res.id || res.external_id;
				// Якщо відгук змінили під час відправки (rev інший) — лишаємо 'wait', наступний запуск відправить знову
				await pool.query(
					`UPDATE ${P}products_reviews_sites
					    SET state = IF(rev = ?, 'sent', state), sent_at = NOW(), attempt_at = NOW(), last_error = NULL, external_id = COALESCE(?, external_id)
					  WHERE id_review = ? AND id_integration = ? AND state <> 'remove'`,
					[s.rev, /^\d+$/.test(String(ocId || "")) ? String(ocId) : null, it.crm_id, idIntegration]
				);
			}
			// Видалені в CRM власні відгуки: коли всі сайти підтвердили прибирання — видаляємо остаточно
			if (removed.length) await require("./reviews").purgeRemoved(removed);
		},
	};
}

/** Сайти, де зараз є що опублікувати, оновити чи прибрати (для крону) */
async function dueIntegrations() {
	const [rows] = await pool.query(
		`SELECT DISTINCT t.id_integration
		   FROM ${P}products_reviews_sites t
		   JOIN ${P}settings_integrations i ON i.id = t.id_integration AND i.status = 'active'
		  WHERE (t.state = 'wait' AND t.publish_at <= NOW())
		     OR (t.state = 'remove' AND (t.attempt_at IS NULL OR t.attempt_at < NOW() - INTERVAL 15 MINUTE))
		     OR (t.state = 'error' AND (t.attempt_at IS NULL OR t.attempt_at < NOW() - INTERVAL 15 MINUTE))`
	);
	return rows.map((r) => Number(r.id_integration));
}

module.exports = { source, dueIntegrations };