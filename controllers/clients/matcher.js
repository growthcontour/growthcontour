const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;

const SCORE = {
	external: 100,
	identifier: 100,
	email: 90,
	phone: 90,
	handle: 85,
	other: 70,
	phone_invalid: 60,
};
const AUTO_MATCH = 90; // від цього — точно той самий клієнт
const REVIEW = 60; // від цього — можливий дубль, на перевірку

function contactScore(c) {
	const t = c.typeRow;
	if (t.code === "email") return c.valid ? SCORE.email : SCORE.other;
	if (t.normalize === "phone") return c.valid ? SCORE.phone : SCORE.phone_invalid;
	if (t.code === "telegram" || t.code === "instagram") return SCORE.handle;
	return SCORE.other;
}

// Проходить ланцюжок злиття: id → актуальний id (до 5 кроків)
async function followMerged(q, ids) {
	const map = new Map(ids.map((id) => [Number(id), Number(id)]));
	let pending = [...new Set(ids.map(Number))];

	for (let hop = 0; hop < 5 && pending.length; hop++) {
		const [rows] = await q.query(`SELECT id, id_merged_into FROM ${P}clients WHERE id IN (?)`, [pending]);
		const next = [];
		rows.forEach((r) => {
			if (!r.id_merged_into) return;
			for (const [orig, cur] of map) if (cur === r.id) map.set(orig, r.id_merged_into);
			next.push(r.id_merged_into);
		});
		pending = next;
	}
	return map;
}

/**
 * Пошук наявного клієнта.
 * input.contacts:    [{ typeRow, normalized, valid }]         — з normalize.contact()
 * input.identifiers: [{ typeRow, normalized, valid }]         — з normalize.identifier()
 * input.externalIds: [{ system, id_integration, external_id }] — id_integration: 0 якщо нема
 * Повертає { best, candidates }. best — лише якщо скор ≥ AUTO_MATCH.
 */
async function findMatches(input, conn) {
	const q = conn || pool;
	const hits = [];

	// Канали зв'язку
	const contacts = (input.contacts || []).filter((c) => c && c.normalized && c.typeRow && Number(c.typeRow.use_for_dedup) !== 0);
	if (contacts.length) {
		const where = contacts.map(() => "(id_contact_type = ? AND value_normalized = ?)").join(" OR ");
		const params = contacts.flatMap((c) => [c.typeRow.id, c.normalized]);
		const [rows] = await q.query(`SELECT id_client, id_contact_type, value_normalized FROM ${P}clients_contact_points WHERE ${where} LIMIT 200`, params);
		rows.forEach((r) => {
			const c = contacts.find((x) => x.typeRow.id === r.id_contact_type && x.normalized === r.value_normalized);
			if (c) hits.push({ id_client: r.id_client, score: contactScore(c), reason: "same_" + c.typeRow.code });
		});
	}

	// Ідентифікатори — лише ті, що позначені як унікальні
	const idents = (input.identifiers || []).filter((i) => i && i.normalized && i.typeRow && Number(i.typeRow.is_unique) === 1);
	if (idents.length) {
		const where = idents.map(() => "(id_identifier_type = ? AND value_normalized = ?)").join(" OR ");
		const params = idents.flatMap((i) => [i.typeRow.id, i.normalized]);
		const [rows] = await q.query(`SELECT id_client, id_identifier_type FROM ${P}clients_identifiers WHERE ${where} LIMIT 50`, params);
		rows.forEach((r) => {
			const i = idents.find((x) => x.typeRow.id === r.id_identifier_type);
			hits.push({ id_client: r.id_client, score: SCORE.identifier, reason: "same_" + (i ? i.typeRow.code : "identifier") });
		});
	}

	// Зовнішні id
	const exts = (input.externalIds || []).filter((e) => e && e.system && e.external_id);
	if (exts.length) {
		const where = exts.map(() => "(`system` = ? AND id_integration = ? AND external_id = ?)").join(" OR ");
		const params = exts.flatMap((e) => [e.system, Number(e.id_integration) || 0, String(e.external_id)]);
		const [rows] = await q.query(`SELECT id_client, \`system\` FROM ${P}clients_external_ids WHERE ${where} LIMIT 50`, params);
		rows.forEach((r) => hits.push({ id_client: r.id_client, score: SCORE.external, reason: "same_external_" + r.system }));
	}

	if (!hits.length) return { best: null, candidates: [] };

	// Злиті записи → актуальні
	const merged = await followMerged(q, hits.map((h) => h.id_client));

	// Групуємо по клієнту: максимальний скор + бонус за кожен додатковий збіг
	const agg = new Map();
	hits.forEach((h) => {
		const id = merged.get(Number(h.id_client)) || Number(h.id_client);
		const a = agg.get(id) || { id_client: id, max: 0, reasons: new Set() };
		a.max = Math.max(a.max, h.score);
		a.reasons.add(h.reason);
		agg.set(id, a);
	});

	// Прибираємо видалених
	const [alive] = await q.query(`SELECT id FROM ${P}clients WHERE id IN (?) AND deleted_at IS NULL`, [[...agg.keys()]]);
	const aliveSet = new Set(alive.map((r) => r.id));

	const candidates = [...agg.values()]
		.filter((a) => aliveSet.has(a.id_client))
		.map((a) => ({
			id_client: a.id_client,
			score: Math.min(100, a.max + 5 * (a.reasons.size - 1)),
			reasons: [...a.reasons],
		}))
		.sort((x, y) => y.score - x.score);

	const best = candidates.length && candidates[0].score >= AUTO_MATCH ? candidates[0] : null;
	return { best, candidates };
}

/**
 * Записати можливі дублі для перевірки менеджером.
 * idClient — клієнт, з яким працюємо; candidates — з findMatches (крім нього самого).
 * Пари, які менеджер уже відхилив (dismissed), не воскрешаються.
 */
async function saveCandidates(conn, idClient, candidates) {
	const q = conn || pool;
	const list = (candidates || []).filter((c) => c.id_client !== idClient && c.score >= REVIEW);
	for (const c of list) {
		const a = Math.min(idClient, c.id_client);
		const b = Math.max(idClient, c.id_client);
		await q.query(
			`INSERT INTO ${P}clients_duplicate_candidates (id_client_a, id_client_b, score, reasons, status, date_add)
             VALUES (?, ?, ?, CAST(? AS JSON), 'pending', NOW())
             ON DUPLICATE KEY UPDATE
                score = IF(status = 'pending', GREATEST(score, VALUES(score)), score),
                reasons = IF(status = 'pending', VALUES(reasons), reasons)`,
			[a, b, c.score, JSON.stringify(c.reasons)]
		);
	}
}

module.exports = { SCORE, AUTO_MATCH, REVIEW, findMatches, saveCandidates };