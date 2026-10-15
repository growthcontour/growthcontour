const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const service = require("./service");
const stats = require("./stats");
const history = require("./history");

const P = config.get("configDatabase").prefix;

// Таблиці інших модулів, що посилаються на клієнта. Первинний ключ — `id`.
// Заповнимо, коли додамо id_client у замовлення, ліди й чати.
const REF_TABLES = [
	{ table: "orders", column: "id_client" },
	{ table: "orders", column: "id_client_recipient" },
	{ table: "orders", column: "id_client_org" },
	{ table: "leads", column: "id_client" },
	{ table: "leads", column: "id_client_org" },
	{ table: "contact_center_contacts", column: "id_client" },
	{ table: "clients_notes", column: "id_client" },
	// Події календаря: IGNORE — у переможця вже може бути та сама подія
	{ table: "calendar_event_links", column: "id_ref", where: "ref_type = 'client'", ignore: true },
];

// ─── Хелпери ───────────────────────────────────
function pad(n) {
	return String(n).padStart(2, "0");
}
function toSqlDate(v) {
	const d = new Date(v);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
// Рядок зі знімка (JSON) → значення, які можна вставити назад у MySQL
function toRow(r) {
	const out = {};
	for (const [k, v] of Object.entries(r || {})) {
		if (v === null || v === undefined) out[k] = null;
		else if (v instanceof Date) out[k] = toSqlDate(v);
		else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) out[k] = toSqlDate(v);
		else if (typeof v === "object") out[k] = JSON.stringify(v);
		else out[k] = v;
	}
	return out;
}
function whereOf(obj) {
	const keys = Object.keys(obj);
	return { sql: keys.map((k) => "`" + k + "` = ?").join(" AND "), params: keys.map((k) => obj[k]) };
}
async function rows(conn, table, where, params) {
	const [r] = await conn.query(`SELECT * FROM ${P}${table} WHERE ${where}`, params);
	return r;
}

// ─────────────────────────────────────────────
// ЗЛИТТЯ
// ─────────────────────────────────────────────
/**
 * Злити loserId у winnerId. Повертає { id_merge }.
 * opts: { idUser } або { history: ctx }
 */
async function mergeClients(winnerId, loserId, opts) {
	const o = opts || {};
	const hc = o.history ? history.fork(o.history, { source: "merge" }) : history.ctx({ id_user: o.idUser, source: "merge" });
	const log = [];
	const W = Number(winnerId);
	const L = Number(loserId);
	if (!W || !L || W === L) throw new Error("clients.merge: невірні id");

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();

		const [cl] = await conn.query(`SELECT * FROM ${P}clients WHERE id IN (?, ?) FOR UPDATE`, [W, L]);
		const w = cl.find((c) => c.id === W);
		const l = cl.find((c) => c.id === L);
		if (!w || !l) throw new Error("clients.merge: клієнта не знайдено");
		if (w.id_merged_into || l.id_merged_into) throw new Error("clients.merge: один із клієнтів уже злитий");
		if (w.deleted_at || l.deleted_at) throw new Error("clients.merge: один із клієнтів видалений");
		const winnerBefore = await service.snapshot(conn, W);
		// Що саме перейшло від переможеного: у переможця «додано», у переможеного «прибрано»
		const moved = (entity, id, field, value) => log.push({ id_client: W, action: "added", entity, id_entity: id, field, value_new: value }, { id_client: L, action: "removed", entity, id_entity: id, field, value_old: value });
		const ctypes = {};
		const code = async (dictName, idType) => {
			const k = dictName + idType;
			if (!(k in ctypes)) ctypes[k] = ((await require("./dictionaries").byId(dictName, idType)) || {}).code || String(idType);
			return ctypes[k];
		};

		// Журнал для відкату
		const snap = {
			winner: {
				client: w,
				person: (await rows(conn, "clients_persons", "id_client = ?", [W]))[0] || null,
				organization: (await rows(conn, "clients_organizations", "id_client = ?", [W]))[0] || null,
			},
			loser: { client: l },
			moved: [], // { table, where, set } — відкат: UPDATE table SET set WHERE where
			deleted: [], // { table, row }         — відкат: INSERT row
			added: [], // { table, where }       — відкат: DELETE WHERE where
			refs: [], // { table, column, ids }
		};
		const move = async (table, where, set, back) => {
			const wh = whereOf(where);
			await conn.query(`UPDATE ${P}${table} SET ? WHERE ${wh.sql}`, [set, ...wh.params]);
			snap.moved.push({ table, where: back.where, set: back.set });
		};
		const drop = async (table, where, row) => {
			const wh = whereOf(where);
			await conn.query(`DELETE FROM ${P}${table} WHERE ${wh.sql}`, wh.params);
			snap.deleted.push({ table, row });
		};

		// 1. Канали зв'язку
		const wcp = await rows(conn, "clients_contact_points", "id_client = ?", [W]);
		for (const r of await rows(conn, "clients_contact_points", "id_client = ?", [L])) {
			if (wcp.some((x) => x.id_contact_type === r.id_contact_type && x.value_normalized === r.value_normalized)) {
				await drop("clients_contact_points", { id: r.id }, r);
			} else {
				const hasPrimary = wcp.some((x) => x.id_contact_type === r.id_contact_type && Number(x.is_primary) === 1);
				const primary = hasPrimary ? 0 : r.is_primary;
				await move("clients_contact_points", { id: r.id }, { id_client: W, is_primary: primary }, { where: { id: r.id }, set: { id_client: L, is_primary: r.is_primary } });
				moved("contact", r.id, await code("contact_types", r.id_contact_type), r.value);
				wcp.push({ ...r, id_client: W, is_primary: primary });
			}
		}

		// 2. Ідентифікатори
		const wid = await rows(conn, "clients_identifiers", "id_client = ?", [W]);
		for (const r of await rows(conn, "clients_identifiers", "id_client = ?", [L])) {
			if (wid.some((x) => x.id_identifier_type === r.id_identifier_type && x.value_normalized === r.value_normalized)) {
				await drop("clients_identifiers", { id: r.id }, r);
			} else {
				await move("clients_identifiers", { id: r.id }, { id_client: W }, { where: { id: r.id }, set: { id_client: L } });
				moved("identifier", r.id, await code("identifier_types", r.id_identifier_type), r.value);
			}
		}

		// 3. Адреси
		const wad = await rows(conn, "clients_addresses", "id_client = ?", [W]);
		for (const r of await rows(conn, "clients_addresses", "id_client = ?", [L])) {
			const same = wad.some((x) => x.id_address_type === r.id_address_type && x.city === r.city && x.street === r.street && x.building === r.building && x.apartment === r.apartment && (x.carrier_point_ref || "") === (r.carrier_point_ref || ""));
			if (same) {
				await drop("clients_addresses", { id: r.id }, r);
			} else {
				const hasDefault = wad.some((x) => x.id_address_type === r.id_address_type && Number(x.is_default) === 1);
				const def = hasDefault ? 0 : r.is_default;
				await move("clients_addresses", { id: r.id }, { id_client: W, is_default: def }, { where: { id: r.id }, set: { id_client: L, is_default: r.is_default } });
				moved("address", r.id, String(r.id_address_type), service.addressText(r));
				wad.push({ ...r, is_default: def });
			}
		}

		// 4. Зовнішні id (глобально унікальні — конфліктів нема)
		for (const r of await rows(conn, "clients_external_ids", "id_client = ?", [L])) {
			await move("clients_external_ids", { id: r.id }, { id_client: W }, { where: { id: r.id }, set: { id_client: L } });
			moved("external_id", r.id, r.system, (r.id_integration ? r.id_integration + ":" : "") + r.external_id);
		}

		// 5. Зв'язки (зв'язок «сам із собою» після злиття прибираємо)
		for (const r of await rows(conn, "clients_relationships", "id_client_from = ? OR id_client_to = ?", [L, L])) {
			const from = r.id_client_from === L ? W : r.id_client_from;
			const to = r.id_client_to === L ? W : r.id_client_to;
			if (from === to) {
				await drop("clients_relationships", { id: r.id }, r);
			} else {
				await move("clients_relationships", { id: r.id }, { id_client_from: from, id_client_to: to }, { where: { id: r.id }, set: { id_client_from: r.id_client_from, id_client_to: r.id_client_to } });
			}
		}

		// 6. Ролі й теги (первинний ключ id_client + id_*)
		for (const [table, key] of [
			["clients_roles", "id_role_type"],
			["clients_tag_links", "id_tag"],
		]) {
			for (const r of await rows(conn, table, "id_client = ?", [L])) {
				const copy = { ...toRow(r), id_client: W };
				const [res] = await conn.query(`INSERT IGNORE INTO ${P}${table} SET ?`, [copy]);
				if (res.affectedRows) snap.added.push({ table, where: { id_client: W, [key]: r[key] } });
				await drop(table, { id_client: L, [key]: r[key] }, r);
			}
		}

		// 7. Власні поля (значення переможця має пріоритет)
		const wfv = await rows(conn, "clients_field_values", "id_client = ?", [W]);
		for (const r of await rows(conn, "clients_field_values", "id_client = ?", [L])) {
			if (wfv.some((x) => x.id_field === r.id_field)) {
				await drop("clients_field_values", { id_client: L, id_field: r.id_field }, r);
			} else {
				await move("clients_field_values", { id_client: L, id_field: r.id_field }, { id_client: W }, { where: { id_client: W, id_field: r.id_field }, set: { id_client: L } });
			}
		}

		// 8. Комерційні умови (умови переможця мають пріоритет)
		const [lcom] = await rows(conn, "clients_commercial", "id_client = ?", [L]);
		if (lcom) {
			const [wcom] = await rows(conn, "clients_commercial", "id_client = ?", [W]);
			if (wcom) await drop("clients_commercial", { id_client: L }, lcom);
			else await move("clients_commercial", { id_client: L }, { id_client: W }, { where: { id_client: W }, set: { id_client: L } });
		}

		// 9. Дані людини / організації: заповнюємо порожні поля переможця
		const [lp] = await rows(conn, "clients_persons", "id_client = ?", [L]);
		if (lp && w.kind === "person") {
			if (snap.winner.person) {
				await conn.query(
					`UPDATE ${P}clients_persons SET
                        last_name   = IF(last_name   = '', ?, last_name),
                        first_name  = IF(first_name  = '', ?, first_name),
                        middle_name = IF(middle_name = '', ?, middle_name),
                        gender      = IF(gender = 'unknown', ?, gender),
                        birth_date  = COALESCE(birth_date, ?),
                        job_title   = IF(job_title   = '', ?, job_title),
                        trade_name  = IF(trade_name  = '', ?, trade_name)
                     WHERE id_client = ?`,
					[lp.last_name, lp.first_name, lp.middle_name, lp.gender, lp.birth_date, lp.job_title, lp.trade_name, W]
				);
			} else {
				await move("clients_persons", { id_client: L }, { id_client: W }, { where: { id_client: W }, set: { id_client: L } });
			}
		}
		const [lo] = await rows(conn, "clients_organizations", "id_client = ?", [L]);
		if (lo && w.kind === "organization") {
			if (snap.winner.organization) {
				await conn.query(
					`UPDATE ${P}clients_organizations SET
                        legal_name = IF(legal_name = '', ?, legal_name),
                        short_name = IF(short_name = '', ?, short_name),
                        industry   = IF(industry   = '', ?, industry),
                        website    = IF(website    = '', ?, website),
                        employees_count = COALESCE(employees_count, ?),
                        annual_revenue  = COALESCE(annual_revenue, ?),
                        registration_date = COALESCE(registration_date, ?),
                        country = COALESCE(country, ?)
                     WHERE id_client = ?`,
					[lo.legal_name, lo.short_name, lo.industry, lo.website, lo.employees_count, lo.annual_revenue, lo.registration_date, lo.country, W]
				);
			} else {
				await move("clients_organizations", { id_client: L }, { id_client: W }, { where: { id_client: W }, set: { id_client: L } });
			}
		}

		// 10. Сам запис переможця: вища стадія, раніший перший контакт, нотатки разом
		let idLifecycle = w.id_lifecycle;
		if (l.id_lifecycle && l.id_lifecycle !== w.id_lifecycle) {
			const [st] = await conn.query(`SELECT id, sort FROM ${P}clients_lifecycle_stages WHERE id IN (?)`, [[w.id_lifecycle || 0, l.id_lifecycle]]);
			const sw = st.find((s) => s.id === w.id_lifecycle);
			const sl = st.find((s) => s.id === l.id_lifecycle);
			if (sl && (!sw || Number(sl.sort) > Number(sw.sort))) idLifecycle = l.id_lifecycle;
		}
		await conn.query(
			`UPDATE ${P}clients SET
                id_lifecycle = ?,
                id_legal_type = COALESCE(id_legal_type, ?),
                id_manager = COALESCE(id_manager, ?),
                id_lang = COALESCE(id_lang, ?),
                country = COALESCE(country, ?),
                timezone = COALESCE(timezone, ?),
                currency = COALESCE(currency, ?),
                score = GREATEST(score, ?),
                date_first_contact = LEAST(COALESCE(date_first_contact, ?), COALESCE(?, date_first_contact)),
                date_last_activity = GREATEST(COALESCE(date_last_activity, ?), COALESCE(?, date_last_activity)),
                note = NULLIF(CONCAT_WS('\n', NULLIF(note, ''), NULLIF(?, '')), ''),
                id_user_edit = ?,
                date_edit = NOW()
             WHERE id = ?`,
			[idLifecycle, l.id_legal_type, l.id_manager, l.id_lang, l.country, l.timezone, l.currency, l.score, l.date_first_contact, l.date_first_contact, l.date_last_activity, l.date_last_activity, l.note || "", hc.id_user, W]
		);

		// 11. Переможений стає архівним записом
		await conn.query(`UPDATE ${P}clients SET id_merged_into = ?, status = 'archived', date_edit = NOW() WHERE id = ?`, [W, L]);

		// 12. Замовлення, ліди, чати інших модулів
		for (const ref of REF_TABLES) {
			try {
				const extra = ref.where ? " AND " + ref.where : "";
				const [ids] = await conn.query(`SELECT id FROM ${P}${ref.table} WHERE \`${ref.column}\` = ?${extra}`, [L]);
				if (!ids.length) continue;
				await conn.query(`UPDATE ${ref.ignore ? "IGNORE " : ""}${P}${ref.table} SET \`${ref.column}\` = ? WHERE \`${ref.column}\` = ?${extra}`, [W, L]);
				snap.refs.push({ table: ref.table, column: ref.column, ids: ids.map((r) => r.id) });
			} catch (e) {
				if (e.code !== "ER_BAD_FIELD_ERROR" && e.code !== "ER_NO_SUCH_TABLE") throw e;
			}
		}

		// 13. Кандидати в дублі
		const a = Math.min(W, L);
		const b = Math.max(W, L);
		await conn.query(`UPDATE ${P}clients_duplicate_candidates SET status = 'merged', id_user_resolved = ?, date_resolved = NOW() WHERE id_client_a = ? AND id_client_b = ?`, [hc.id_user, a, b]);
		await conn.query(`DELETE FROM ${P}clients_duplicate_candidates WHERE status = 'pending' AND (id_client_a = ? OR id_client_b = ?)`, [L, L]);

		// 14. Журнал
		const [ins] = await conn.query(`INSERT INTO ${P}clients_merges (id_client_winner, id_client_loser, snapshot, id_user, date_add) VALUES (?, ?, CAST(? AS JSON), ?, NOW())`, [W, L, JSON.stringify(snap), hc.id_user]);

		await service.refreshDisplayName(conn, W);
		await stats.recalc(conn, W);

		// 15. Історія обох карток (source_ref = номер злиття, для відкату з історії)
		hc.source_ref = String(ins.insertId);
		const refsCount = snap.refs.reduce((n, r) => n + r.ids.length, 0);
		await history.write(conn, hc, [{ id_client: W, action: "merged", entity: "client", id_entity: ins.insertId, field: "merged_from", value_old: l.display_name, value_new: L }, { id_client: L, action: "merged", entity: "client", id_entity: ins.insertId, field: "merged_into", value_old: w.display_name, value_new: W }, ...log, ...(refsCount ? [{ id_client: W, action: "added", entity: "links", id_entity: ins.insertId, field: "refs", value_new: snap.refs.map((r) => r.table + "." + r.column + ":" + r.ids.length).join(", ") }] : []), ...service.snapshotDiff(W, winnerBefore, await service.snapshot(conn, W))]);
		await conn.commit();
		return { id_merge: ins.insertId };
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

// ─────────────────────────────────────────────
// ВІДКАТ
// ─────────────────────────────────────────────
/**
 * Скасувати злиття. Дані, додані переможцю ПІСЛЯ злиття, лишаються в нього.
 * opts: { idUser } або { history: ctx }
 */
async function revertMerge(idMerge, opts) {
	const o = opts || {};
	const hc = o.history ? history.fork(o.history, { source: "merge", source_ref: String(idMerge) }) : history.ctx({ id_user: o.idUser, source: "merge", source_ref: String(idMerge) });
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();

		const [[m]] = await conn.query(`SELECT * FROM ${P}clients_merges WHERE id = ? FOR UPDATE`, [idMerge]);
		if (!m) throw new Error("clients.revert: злиття не знайдено");
		if (m.reverted_at) throw new Error("clients.revert: злиття вже скасовано");

		const W = m.id_client_winner;
		const L = m.id_client_loser;
		const s = typeof m.snapshot === "string" ? JSON.parse(m.snapshot) : m.snapshot;

		const [[lc]] = await conn.query(`SELECT id_merged_into FROM ${P}clients WHERE id = ? FOR UPDATE`, [L]);
		if (!lc || lc.id_merged_into !== W) throw new Error("clients.revert: запис уже змінено, відкат неможливий");
		const winnerBefore = await service.snapshot(conn, W);

		// Повертаємо перенесені рядки (у зворотному порядку)
		for (const mv of [...s.moved].reverse()) {
			const wh = whereOf(mv.where);
			await conn.query(`UPDATE ${P}${mv.table} SET ? WHERE ${wh.sql}`, [mv.set, ...wh.params]);
		}
		// Прибираємо ролі/теги, які злиття додало переможцю
		for (const ad of s.added) {
			const wh = whereOf(ad.where);
			await conn.query(`DELETE FROM ${P}${ad.table} WHERE ${wh.sql}`, wh.params);
		}
		// Відновлюємо видалені дублі переможеного
		for (const dl of s.deleted) {
			await conn.query(`INSERT IGNORE INTO ${P}${dl.table} SET ?`, [toRow(dl.row)]);
		}

		// Дані людини/організації переможця — до стану «до злиття»
		if (s.winner.person) {
			const { id_client, ...fields } = toRow(s.winner.person);
			await conn.query(`UPDATE ${P}clients_persons SET ? WHERE id_client = ?`, [fields, W]);
		}
		if (s.winner.organization) {
			const { id_client, ...fields } = toRow(s.winner.organization);
			await conn.query(`UPDATE ${P}clients_organizations SET ? WHERE id_client = ?`, [fields, W]);
		}

		// Запис переможця (активність після злиття не чіпаємо)
		const wc = toRow(s.winner.client);
		await conn.query(
			`UPDATE ${P}clients SET id_lifecycle = ?, id_legal_type = ?, id_manager = ?, id_lang = ?, country = ?, timezone = ?,
                currency = ?, score = ?, date_first_contact = ?, note = ?, date_edit = NOW() WHERE id = ?`,
			[wc.id_lifecycle, wc.id_legal_type, wc.id_manager, wc.id_lang, wc.country, wc.timezone, wc.currency, wc.score, wc.date_first_contact, wc.note, W]
		);

		// Переможений знову активний
		await conn.query(`UPDATE ${P}clients SET id_merged_into = NULL, status = ?, date_edit = NOW() WHERE id = ?`, [s.loser.client.status || "active", L]);

		// Замовлення, ліди, чати — назад
		for (const ref of s.refs || []) {
			if (!ref.ids || !ref.ids.length) continue;
			await conn.query(`UPDATE ${P}${ref.table} SET \`${ref.column}\` = ? WHERE id IN (?) AND \`${ref.column}\` = ?`, [L, ref.ids, W]);
		}

		// Ця пара — точно не дубль, більше не пропонуємо
		const a = Math.min(W, L);
		const b = Math.max(W, L);
		await conn.query(
			`INSERT INTO ${P}clients_duplicate_candidates (id_client_a, id_client_b, score, reasons, status, id_user_resolved, date_add, date_resolved)
             VALUES (?, ?, 0, CAST('["reverted_merge"]' AS JSON), 'dismissed', ?, NOW(), NOW())
             ON DUPLICATE KEY UPDATE status = 'dismissed', id_user_resolved = VALUES(id_user_resolved), date_resolved = NOW()`,
			[a, b, hc.id_user]
		);

		await conn.query(`UPDATE ${P}clients_merges SET reverted_at = NOW(), id_user_reverted = ? WHERE id = ?`, [hc.id_user, idMerge]);

		await service.refreshDisplayName(conn, W);
		await service.refreshDisplayName(conn, L);
		await stats.recalc(conn, W);
		await stats.recalc(conn, L);

		// Історія: що повернулось переможеному
		// Дзеркало записів злиття: що переходило L → W, тепер W → L
		const [was] = await conn.query(
			`SELECT entity, id_entity, field, value_old FROM ${P}clients_history
              WHERE id_client = ? AND source = 'merge' AND source_ref = ? AND action = 'removed'`,
			[L, String(idMerge)]
		);
		const back = was.flatMap((r) => [
			{ id_client: L, action: "added", entity: r.entity, id_entity: r.id_entity, field: r.field, value_new: r.value_old },
			{ id_client: W, action: "removed", entity: r.entity, id_entity: r.id_entity, field: r.field, value_old: r.value_old },
		]);
		await history.write(conn, hc, [{ id_client: W, action: "merge_reverted", entity: "client", id_entity: idMerge, field: "merged_from", value_old: L }, { id_client: L, action: "merge_reverted", entity: "client", id_entity: idMerge, field: "merged_into", value_old: W }, ...back, ...service.snapshotDiff(W, winnerBefore, await service.snapshot(conn, W))]);
		await conn.commit();
		return { ok: true };
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

module.exports = { REF_TABLES, mergeClients, revertMerge };
