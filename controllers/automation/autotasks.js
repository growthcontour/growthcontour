const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const dict = require("../clients/dictionaries");
const history = require("../clients/history");
const { createTask } = require("../calendar/tasks");

const P = config.get("configDatabase").prefix;
const BATCH = 200;

/**
 * Автозадачі. Налаштування — у таблиці automation_rules (вмикається/вимикається без коду).
 * Ідемпотентність — automation_log (UNIQUE rule + ref_key): одна задача на випадок, навіть якщо крон
 * запуститься двічі або паралельно на двох серверах.
 */

async function rules() {
	const [rows] = await pool.query(`SELECT * FROM ${P}automation_rules WHERE active = 1`);
	return Object.fromEntries(rows.map((r) => [r.code, r]));
}

// Бронюємо «слот» до створення задачі: якщо вже є — пропускаємо
async function claim(conn, rule, c) {
	const [r] = await conn.query(`INSERT IGNORE INTO ${P}automation_log (rule, ref_key, ref_type, id_ref, date_add) VALUES (?, ?, ?, ?, NOW())`, [rule, c.ref_key, c.ref_type, c.id_ref]);
	return r.affectedRows === 1;
}

const render = (tpl, vars) => String(tpl || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));

// Сьогодні о HH:MM (або через 5 хв, якщо цей час уже минув)
function atTodayOrNow(hhmm) {
	const [h, m] = String(hhmm || "10:00").split(":").map(Number);
	const d = new Date();
	d.setHours(h || 10, m || 0, 0, 0);
	return d < new Date() ? new Date(Date.now() + 5 * 60000) : d;
}

async function run(rule, candidates, build) {
	let created = 0;
	for (const c of candidates) {
		const conn = await pool.getConnection();
		try {
			await conn.beginTransaction();
			if (!(await claim(conn, rule.code, c))) {
				await conn.rollback();
				continue;
			}
			const t = build(c);
			const idEvent = await createTask(
				{
					idUser: c.id_user,
					title: t.title,
					description: t.description || null,
					start: t.start,
					durationMin: 15,
					idEventType: rule.id_event_type || null,
					priority: rule.priority || 2,
					reminderMinutes: null,
					links: t.links,
				},
				conn
			);
			await conn.query(`UPDATE ${P}automation_log SET id_event = ? WHERE rule = ? AND ref_key = ?`, [idEvent, rule.code, c.ref_key]);

			// Історія клієнта: автозадача створена
			for (const l of t.links.filter((x) => x.type === "client")) {
				await history.linked(conn, history.ctxSystem("system", "auto:" + rule.code), "event", idEvent, l.id, null, null, t.title);
			}
			await conn.commit();
			created++;
		} catch (e) {
			await conn.rollback().catch(() => {});
			console.error("[autotasks]", rule.code, c.ref_key, e.message);
		} finally {
			conn.release();
		}
	}
	return created;
}

/**
 * 1. Новий лід без реакції: створений понад N хв тому (але не раніше доби), не конвертований,
 *    не закритий і без жодної прив'язаної події. Задача — відповідальному за лід.
 */
async function leadNoReaction(rule) {
	const minutes = Math.max(1, Number(rule.delay_value) || 15);
	const [rows] = await pool.query(
		`SELECT l.id AS id_ref, 'lead' AS ref_type, CONCAT('lead:', l.id) AS ref_key, l.id_manager AS id_user, l.title, l.id_client
           FROM ${P}leads l
           LEFT JOIN ${P}leads_settings_status s ON s.id = l.id_status
          WHERE l.deleted_at IS NULL AND COALESCE(l.is_converted, 0) = 0
            AND l.id_manager IS NOT NULL
            AND (s.system_type IS NULL OR s.system_type NOT IN ('won', 'lost'))
            AND l.date_add <= NOW() - INTERVAL ? MINUTE
            AND l.date_add >= NOW() - INTERVAL 1 DAY
            AND NOT EXISTS (SELECT 1 FROM ${P}calendar_event_links el WHERE el.ref_type = 'lead' AND el.id_ref = l.id)
            AND NOT EXISTS (SELECT 1 FROM ${P}automation_log a WHERE a.rule = ? AND a.ref_key = CONCAT('lead:', l.id))
          LIMIT ${BATCH}`,
		[minutes, rule.code]
	);
	return run(rule, rows, (c) => ({
		title: render(rule.title || "Звʼязатися з лідом: {title}", { title: c.title || "#" + c.id_ref }),
		description: `Лід без реакції понад ${minutes} хв.`,
		start: new Date(),
		links: [{ type: "lead", id: c.id_ref }, ...(c.id_client ? [{ type: "client", id: c.id_client }] : [])],
	}));
}

/**
 * 2. Повторна покупка: через N днів після останньої валідної покупки, якщо нових замовлень не було.
 *    Вікно — 3 дні, щоб пропуск крону не губив клієнтів. Задача — менеджеру клієнта.
 */
async function reorder(rule) {
	const days = Math.max(1, Number(rule.delay_value) || 30);
	const [rows] = await pool.query(
		`SELECT c.id AS id_client, c.id AS id_ref, 'client' AS ref_type, c.id_manager AS id_user, c.display_name,
                CONCAT('client:', c.id, ':', DATE_FORMAT(st.last_order_at, '%Y%m%d%H%i')) AS ref_key
           FROM ${P}clients_stats st
           INNER JOIN ${P}clients c ON c.id = st.id_client
          WHERE c.deleted_at IS NULL AND c.id_merged_into IS NULL AND c.id_manager IS NOT NULL
            AND st.orders_valid_count > 0
            AND st.last_order_at <= NOW() - INTERVAL ? DAY
            AND st.last_order_at >  NOW() - INTERVAL ? DAY
          LIMIT ${BATCH}`,
		[days, days + 3]
	);
	// Ключ = клієнт + час останньої покупки: після нової покупки задача знову можлива
	return run(rule, rows, (c) => ({
		title: render(rule.title || "Запропонувати повторну покупку: {name}", { name: c.display_name }),
		description: `Минуло ${days} дн. від останньої покупки.`,
		start: atTodayOrNow(rule.time_of_day),
		links: [{ type: "client", id: c.id_client }],
	}));
}

/**
 * 3. Клієнт став «Втраченим»: задача повернути. Раз на кожне потрапляння в стадію
 *    (ключ — запис історії про зміну стадії).
 */
async function churned(rule) {
	const churnedId = await dict.idOf("lifecycle_stages", "churned");
	if (!churnedId) return 0;
	const [rows] = await pool.query(
		`SELECT c.id AS id_client, c.id AS id_ref, 'client' AS ref_type, c.id_manager AS id_user, c.display_name,
                CONCAT('churn:', MAX(h.id)) AS ref_key
           FROM ${P}clients c
           INNER JOIN ${P}clients_history h
                   ON h.id_client = c.id AND h.field = 'id_lifecycle' AND h.value_new = ? AND h.date_add >= NOW() - INTERVAL 7 DAY
          WHERE c.deleted_at IS NULL AND c.id_merged_into IS NULL AND c.id_manager IS NOT NULL AND c.id_lifecycle = ?
          GROUP BY c.id, c.id_manager, c.display_name
          LIMIT ${BATCH}`,
		[String(churnedId), churnedId]
	);
	return run(rule, rows, (c) => ({
		title: render(rule.title || "Повернути клієнта: {name}", { name: c.display_name }),
		description: "Клієнт перейшов у стадію «Втрачений».",
		start: atTodayOrNow(rule.time_of_day),
		links: [{ type: "client", id: c.id_client }],
	}));
}

const HANDLERS = { lead_no_reaction: leadNoReaction, client_reorder: reorder, client_churned: churned };

let running = false;
async function tick() {
	if (running) return { skipped: true };
	running = true;
	try {
		const rs = await rules();
		const out = {};
		for (const [code, fn] of Object.entries(HANDLERS)) {
			if (!rs[code]) continue;
			out[code] = await fn(rs[code]);
		}
		return out;
	} finally {
		running = false;
	}
}

module.exports = { tick, HANDLERS };