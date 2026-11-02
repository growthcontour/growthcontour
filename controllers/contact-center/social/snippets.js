/**
 * Шаблони тексту і групи хештегів для публікацій.
 *
 *   template — текст у форматі редактора (обмежений HTML, format.js); вставляється в спільний текст
 *              або в окремий текст мережі (для Instagram / Facebook / Viber — як простий текст);
 *   hashtags — набір хештегів «#тег #тег»; вставляється в текст або в перший коментар.
 *
 * Спільні для всіх користувачів з доступом до публікацій.
 */
const pool = require("../../../config/database/connection_pool");
const { P, httpErr, NETWORKS } = require("./social");
const format = require("./format");

const T = P + "social_snippets";
const KINDS = ["template", "hashtags"];
const MAX_TAGS = 30; // Instagram приймає не більше 30 хештегів у пості

/**
 * Хештеги з довільного вводу: «акція, #знижки  Київ» → «#акція #знижки #Київ».
 * Літери будь-якої мови, цифри і «_»; дублікати (без урахування регістру) прибираються.
 */
function normalizeTags(input) {
	const seen = new Set();
	const out = [];
	for (const raw of String(input || "").split(/[\s,;]+/)) {
		const tag = raw.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
		if (!tag || /^\d+$/.test(tag)) continue; // лише цифри Instagram хештегом не вважає
		const key = tag.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push("#" + tag);
	}
	return out;
}

async function list(q) {
	const where = ["s.deleted = 0"];
	const args = [];
	if (KINDS.includes(q.kind)) {
		where.push("s.kind = ?");
		args.push(q.kind);
	}
	if (q.q) {
		where.push("(s.name LIKE ? OR s.content LIKE ?)");
		const like = "%" + String(q.q).replace(/[\\%_]/g, "\\$&") + "%";
		args.push(like, like);
	}
	const [rows] = await pool.query(
		`SELECT s.id, s.kind, s.name, s.content, s.network, s.usage_count, s.date_used, s.date_upd,
		        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS user_name
		   FROM ${T} s LEFT JOIN ${P}users u ON u.id = COALESCE(s.id_user_edited, s.id_user)
		  WHERE ${where.join(" AND ")}
		  ORDER BY s.usage_count DESC, s.name ASC
		  LIMIT 500`,
		args
	);
	for (const r of rows) {
		r.preview = r.kind === "template" ? format.toPlain(r.content).slice(0, 300) : r.content;
		r.tags_count = r.kind === "hashtags" ? r.content.split(" ").filter(Boolean).length : null;
	}
	return rows;
}

async function save(id, b, idUser) {
	const kind = String(b.kind || "");
	if (!KINDS.includes(kind)) throw httpErr(400, "contact_center.social.errors.snippet_kind");
	const name = String(b.name || "").trim().slice(0, 255);
	if (!name) throw httpErr(400, "contact_center.social.errors.name_required");
	const network = NETWORKS.includes(b.network) ? b.network : null;

	let content;
	if (kind === "template") {
		content = format.clean(b.content);
		if (!format.toPlain(content)) throw httpErr(400, "contact_center.social.errors.snippet_empty");
		if (content.length > 60000) throw httpErr(400, "contact_center.social.errors.snippet_too_long");
	} else {
		const tags = normalizeTags(b.content);
		if (!tags.length) throw httpErr(400, "contact_center.social.errors.hashtags_empty");
		if (tags.length > MAX_TAGS) throw httpErr(400, "contact_center.social.errors.hashtags_max", { max: MAX_TAGS });
		content = tags.join(" ");
	}

	if (id) {
		const [r] = await pool.query(`UPDATE ${T} SET kind = ?, name = ?, content = ?, network = ?, id_user_edited = ? WHERE id = ? AND deleted = 0`, [kind, name, content, network, idUser || null, id]);
		if (!r.affectedRows) throw httpErr(404, "contact_center.social.errors.snippet_not_found");
	} else {
		const [r] = await pool.query(`INSERT INTO ${T} (kind, name, content, network, id_user) VALUES (?, ?, ?, ?, ?)`, [kind, name, content, network, idUser || null]);
		id = r.insertId;
	}
	return { id, content };
}

async function remove(id) {
	const [r] = await pool.query(`UPDATE ${T} SET deleted = 1 WHERE id = ? AND deleted = 0`, [id]);
	if (!r.affectedRows) throw httpErr(404, "contact_center.social.errors.snippet_not_found");
}

/** Відмітка використання — для сортування «найчастіші вгорі» */
async function used(id) {
	await pool.query(`UPDATE ${T} SET usage_count = usage_count + 1, date_used = NOW() WHERE id = ? AND deleted = 0`, [id]);
}

module.exports = { list, save, remove, used, normalizeTags, MAX_TAGS };