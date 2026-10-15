const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const dict = require("./dictionaries");
const history = require("./history");

const P = config.get("configDatabase").prefix;

// Через скільки днів без покупки клієнт вважається втраченим
const CHURN_DAYS = 180;

/**
 * Сегменти RFM (класична схема). Порядок перевірки важливий — перший збіг виграє.
 * r/f/m — бали 1..5 (5 — найкраще: давно не купував = 1).
 */
const SEGMENTS = [
	{ code: "champions", name: "Чемпіони", color: "#16a085", icon: "fa-solid fa-trophy", test: (r, f, m) => r >= 4 && f >= 4 && m >= 4 },
	{ code: "loyal", name: "Лояльні", color: "#27ae60", icon: "fa-solid fa-heart", test: (r, f) => r >= 3 && f >= 4 },
	{ code: "new", name: "Нові", color: "#3498db", icon: "fa-solid fa-seedling", test: (r, f) => r >= 4 && f <= 1 },
	{ code: "potential", name: "Перспективні", color: "#5dade2", icon: "fa-solid fa-arrow-trend-up", test: (r, f) => r >= 4 && f <= 3 },
	{ code: "cant_lose", name: "Не можна втратити", color: "#c0392b", icon: "fa-solid fa-triangle-exclamation", test: (r, f, m) => r <= 2 && f >= 4 && m >= 4 },
	{ code: "at_risk", name: "Під загрозою", color: "#e67e22", icon: "fa-solid fa-hourglass-half", test: (r, f) => r <= 2 && f >= 3 },
	{ code: "need_attention", name: "Потребують уваги", color: "#f1c40f", icon: "fa-solid fa-bell", test: (r) => r === 3 },
	{ code: "hibernating", name: "Сплячі", color: "#95a5a6", icon: "fa-solid fa-moon", test: (r, f) => r === 2 && f <= 2 },
	{ code: "lost", name: "Втрачені", color: "#7f8c8d", icon: "fa-solid fa-user-slash", test: () => true },
];
const SEG_BY_CODE = Object.fromEntries(SEGMENTS.map((s) => [s.code, s]));

function segmentOf(r, f, m) {
	return SEGMENTS.find((s) => s.test(r, f, m)).code;
}

/**
 * Перерахунок RFM для всіх покупців. Бали — квінтилі (NTILE) серед клієнтів з валідними замовленнями,
 * тож шкала сама підлаштовується під магазин (для одного 5 замовлень — багато, для іншого — мало).
 */
async function recalcRfm() {
	const [rows] = await pool.query(
		`SELECT id_client,
                NTILE(5) OVER (ORDER BY last_order_at ASC, id_client) AS r,
                NTILE(5) OVER (ORDER BY orders_valid_count ASC, id_client) AS f,
                NTILE(5) OVER (ORDER BY revenue_base ASC, id_client) AS m
           FROM ${P}clients_stats
          WHERE orders_valid_count > 0 AND last_order_at IS NOT NULL`
	);

	// Порціями, щоб не тримати великі транзакції
	const CHUNK = 500;
	for (let i = 0; i < rows.length; i += CHUNK) {
		const part = rows.slice(i, i + CHUNK);
		const vals = [];
		for (const x of part) vals.push(x.id_client, x.r, x.f, x.m, segmentOf(Number(x.r), Number(x.f), Number(x.m)));
		await pool.query(
			`INSERT INTO ${P}clients_stats (id_client, rfm_r, rfm_f, rfm_m, rfm_segment, rfm_at, date_recalc)
             VALUES ${part.map(() => "(?, ?, ?, ?, ?, NOW(), NOW())").join(", ")}
             ON DUPLICATE KEY UPDATE rfm_r = VALUES(rfm_r), rfm_f = VALUES(rfm_f), rfm_m = VALUES(rfm_m),
                rfm_segment = VALUES(rfm_segment), rfm_at = NOW()`,
			vals
		);
	}

	// Хто більше не покупець (замовлення скасовані) — без сегмента
	await pool.query(`UPDATE ${P}clients_stats SET rfm_r = NULL, rfm_f = NULL, rfm_m = NULL, rfm_segment = NULL, rfm_at = NOW() WHERE orders_valid_count = 0 AND rfm_segment IS NOT NULL`);
	return rows.length;
}

/**
 * Стадія «Втрачений» (churned): покупці без покупок CHURN_DAYS днів.
 * Стадія «лише вгору» тут не діє — це свідоме зниження, тому окремий запит і запис в історію.
 */
async function markChurned() {
	const churned = await dict.idOf("lifecycle_stages", "churned");
	if (!churned) return 0;
	const buyers = ["customer", "repeat_customer", "vip"];
	const ids = (await Promise.all(buyers.map((c) => dict.idOf("lifecycle_stages", c)))).filter(Boolean);
	if (!ids.length) return 0;

	const [rows] = await pool.query(
		`SELECT c.id, c.id_lifecycle
           FROM ${P}clients c
           INNER JOIN ${P}clients_stats st ON st.id_client = c.id
          WHERE c.deleted_at IS NULL AND c.id_merged_into IS NULL
            AND c.id_lifecycle IN (?)
            AND st.last_order_at < NOW() - INTERVAL ? DAY
          LIMIT 5000`,
		[ids, CHURN_DAYS]
	);
	if (!rows.length) return 0;

	await pool.query(`UPDATE ${P}clients SET id_lifecycle = ?, date_edit = NOW() WHERE id IN (?)`, [churned, rows.map((r) => r.id)]);
	await history.write(
		null,
		history.ctxSystem("system", "churn:" + CHURN_DAYS + "d"),
		rows.map((r) => ({ id_client: r.id, action: "updated", entity: "client", id_entity: r.id, field: "id_lifecycle", value_old: r.id_lifecycle, value_new: churned }))
	);
	return rows.length;
}

/**
 * Повернення з «Втраченого», коли клієнт знову купив (викликається з stats.recalc).
 * Повертає true, якщо стадію змінено.
 */
async function unchurn(q, idClient, validOrders, lastOrderAt) {
	if (!validOrders || !lastOrderAt) return false;
	if (new Date(lastOrderAt) < new Date(Date.now() - CHURN_DAYS * 86400000)) return false;
	const churned = await dict.idOf("lifecycle_stages", "churned");
	if (!churned) return false;
	const target = await dict.idOf("lifecycle_stages", validOrders >= 2 ? "repeat_customer" : "customer");
	if (!target) return false;
	const [r] = await q.query(`UPDATE ${P}clients SET id_lifecycle = ?, date_edit = NOW() WHERE id = ? AND id_lifecycle = ?`, [target, idClient, churned]);
	if (!r.affectedRows) return false;
	await history.write(q, history.ctxSystem("system", "returned"), [{ id_client: idClient, action: "updated", entity: "client", id_entity: idClient, field: "id_lifecycle", value_old: churned, value_new: target }]);
	return true;
}

/** Нічна задача */
async function nightly() {
	const n = await recalcRfm();
	const lost = await markChurned();
	return { rfm: n, churned: lost };
}

module.exports = { CHURN_DAYS, SEGMENTS, SEG_BY_CODE, segmentOf, recalcRfm, markChurned, unchurn, nightly };