/**
 * Публікації: створення, редагування, окремий текст для мереж, перший коментар,
 * погодження, планування, скасування, повтор. Кожна дія пишеться в історію (log.js).
 *
 * Текст:
 *   спільний текст        — обмежений HTML з редактора (format.js);
 *   окремий текст мережі  — у «рідному» форматі мережі: Telegram — HTML, Instagram / Facebook / Viber — простий текст.
 *                           NULL — використовується спільний, перетворений під мережу.
 * Перший коментар — простий текст: спільний або окремий для мережі (Instagram, Facebook, Telegram).
 */
const pool = require("../../../config/database/connection_pool");
const { P, httpErr, FORMATS, TEXT_LIMITS, NETWORKS } = require("./social");
const format = require("./format");
const log = require("./log");

const T_POSTS = P + "social_posts";
const T_MEDIA = P + "social_post_media";
const T_TARGETS = P + "social_post_targets";
const T_VARIANTS = P + "social_post_variants";
const T_ACC = P + "social_accounts";

// Перший коментар: де можливий і ліміт довжини
const COMMENT_NETWORKS = { instagram: 2200, facebook: 8000, telegram: 4096 };
// Формати, під якими коментар можливий (у сторіс коментарів немає)
const COMMENT_FORMATS = ["post", "reel"];

// Instagram: не більше 30 хештегів у тексті й у коментарі
const IG_MAX_TAGS = 30;
const countTags = (s) => (String(s || "").match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length;

const SORTS = { id: "p.id", publish_at: "p.publish_at", status: "p.status", date_add: "p.date_add" };

/** Простий текст з поля вводу: лише нормалізація переносів і прибирання керівних символів */
const plainInput = (v) =>
	String(v == null ? "" : v)
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
		.trim();

/** Текст для мережі: окремий (у форматі мережі) або спільний, перетворений під мережу */
function resolveText(network, variantText, commonHtml) {
	if (variantText !== null && variantText !== undefined) return network === "telegram" ? format.toTelegram(variantText) : variantText;
	return network === "telegram" ? format.toTelegram(commonHtml) : format.toPlain(commonHtml);
}

/** Видимий текст мережі (для лімітів і підпису Telegram — без тегів) */
function resolvePlain(network, variantText, commonHtml) {
	if (variantText !== null && variantText !== undefined) return network === "telegram" ? format.toPlain(variantText) : variantText;
	return format.toPlain(commonHtml);
}

async function list(q) {
	const page = Math.max(1, parseInt(q.page, 10) || 1);
	const size = Math.min(100, Math.max(1, parseInt(q.size, 10) || 20));
	const where = ["p.deleted = 0"];
	const args = [];
	if (q.status) {
		where.push("p.status = ?");
		args.push(String(q.status));
	}
	if (q.id_account) {
		where.push(`EXISTS (SELECT 1 FROM ${T_TARGETS} x WHERE x.id_post = p.id AND x.id_account = ?)`);
		args.push(parseInt(q.id_account, 10) || 0);
	}
	if (q.from) {
		where.push("p.publish_at >= ?");
		args.push(new Date(String(q.from)));
	}
	if (q.to) {
		where.push("p.publish_at < ?");
		args.push(new Date(String(q.to)));
	}
	if (q.q) {
		where.push("(p.title LIKE ? OR p.text LIKE ?)");
		const like = "%" + String(q.q).replace(/[\\%_]/g, "\\$&") + "%";
		args.push(like, like);
	}
	const s = (Array.isArray(q.sort) && q.sort[0]) || {};
	const order = (SORTS[s.field] || "COALESCE(p.publish_at, p.date_add)") + (s.dir === "asc" ? " ASC" : " DESC");

	const w = where.join(" AND ");
	const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T_POSTS} p WHERE ${w}`, args);
	const [rows] = await pool.query(
		`SELECT p.id, p.title, LEFT(p.text, 2000) AS text, p.status, p.publish_at, p.date_add,
		        (SELECT m.id_media FROM ${T_MEDIA} m WHERE m.id_post = p.id ORDER BY m.sort_order LIMIT 1) AS cover,
		        (SELECT COUNT(*) FROM ${T_MEDIA} m WHERE m.id_post = p.id) AS media_count
		   FROM ${T_POSTS} p WHERE ${w} ORDER BY ${order}, p.id DESC LIMIT ? OFFSET ?`,
		[...args, size, (page - 1) * size]
	);
	if (rows.length) {
		const [tg] = await pool.query(
			`SELECT t.id, t.id_post, t.format, t.status, t.error, t.permalink, t.comment_status, a.network, a.name
			   FROM ${T_TARGETS} t JOIN ${T_ACC} a ON a.id = t.id_account WHERE t.id_post IN (?) ORDER BY a.network, a.name`,
			[rows.map((r) => r.id)]
		);
		for (const r of rows) {
			r.targets = tg.filter((x) => x.id_post === r.id);
			r.text = format.toPlain(r.text).slice(0, 200);
		}
	}
	return { last_page: Math.max(1, Math.ceil(n / size)), data: rows };
}

async function get(id) {
	const [[p]] = await pool.query(
		`SELECT p.*, NULLIF(TRIM(CONCAT_WS(' ', ur.first_name, ur.last_name)), '') AS review_user_name
		   FROM ${T_POSTS} p LEFT JOIN ${P}users ur ON ur.id = p.id_user_review
		  WHERE p.id = ? AND p.deleted = 0`,
		[id]
	);
	if (!p) throw httpErr(404, "contact_center.social.errors.post_not_found");
	const [media] = await pool.query(
		`SELECT m.id, m.kind, m.width, m.height, m.size, m.original_name FROM ${T_MEDIA} pm JOIN ${P}social_media m ON m.id = pm.id_media WHERE pm.id_post = ? ORDER BY pm.sort_order`,
		[id]
	);
	const [targets] = await pool.query(
		`SELECT t.id, t.id_account, t.format, t.status, t.attempts, t.error, t.permalink, t.external_id, t.date_published,
		        t.comment_status, t.comment_error, a.network, a.name,
		        s.likes, s.comments, s.shares, s.saves, s.reach, s.views, s.date_fetched AS stats_at
		   FROM ${T_TARGETS} t JOIN ${T_ACC} a ON a.id = t.id_account
		   LEFT JOIN ${P}social_post_stats s ON s.id_target = t.id
		  WHERE t.id_post = ? ORDER BY a.network, a.name`,
		[id]
	);
	const [variants] = await pool.query(`SELECT network, text, first_comment FROM ${T_VARIANTS} WHERE id_post = ?`, [id]);
	return { ...p, media, targets, variants: Object.fromEntries(variants.map((v) => [v.network, { text: v.text, first_comment: v.first_comment }])) };
}

/** Чи можна змінювати публікацію: жодна ціль ще не публікується і не опублікована */
function editable(post) {
	return !post.targets.some((x) => ["processing", "waiting", "published"].includes(x.status));
}

/** Перевірка й нормалізація даних редактора */
async function normalize(b) {
	const title = String(b.title || "").trim().slice(0, 255) || null;
	const text = format.clean(b.text);
	const firstComment = plainInput(b.first_comment) || null;
	const mediaIds = [...new Set((Array.isArray(b.media) ? b.media : []).map(Number).filter((n) => n > 0))].slice(0, 10);

	// Окремі тексти мереж (null — спільний)
	const variants = {};
	const vin = b.variants && typeof b.variants === "object" ? b.variants : {};
	for (const net of NETWORKS) {
		const v = vin[net] || {};
		const vt = v.text === null || v.text === undefined ? null : net === "telegram" ? format.clean(v.text) : plainInput(v.text);
		const vc = v.first_comment === null || v.first_comment === undefined ? null : plainInput(v.first_comment);
		if (vt !== null || vc !== null) variants[net] = { text: vt, first_comment: vc };
	}

	// Цілі: акаунт × формат
	const targetsIn = Array.isArray(b.targets) ? b.targets : [];
	const ids = targetsIn.map((x) => parseInt(x.id_account, 10)).filter((n) => n > 0);
	const [accs] = ids.length ? await pool.query(`SELECT id, network, name FROM ${T_ACC} WHERE deleted = 0 AND id IN (?)`, [ids]) : [[]];
	const targets = [];
	const seen = new Set();
	for (const x of targetsIn) {
		const acc = accs.find((a) => a.id === parseInt(x.id_account, 10));
		if (!acc) continue;
		const fmt = FORMATS[acc.network].includes(x.format) ? x.format : null;
		if (!fmt) throw httpErr(400, "contact_center.social.errors.format_bad", { network: acc.name, format: String(x.format) });
		const key = acc.id + ":" + fmt;
		if (seen.has(key)) continue;
		seen.add(key);
		targets.push({ id_account: acc.id, network: acc.network, name: acc.name, format: fmt });
	}

	// Ліміти тексту і коментаря — для кожної мережі, куди публікуємо
	for (const net of new Set(targets.map((x) => x.network))) {
		const v = variants[net] || {};
		const name = targets.find((x) => x.network === net).name;
		if (resolvePlain(net, v.text, text).length > TEXT_LIMITS[net]) throw httpErr(400, "contact_center.social.errors.text_too_long", { network: name, max: TEXT_LIMITS[net] });
		const c = v.first_comment !== null && v.first_comment !== undefined ? v.first_comment : firstComment;
		if (c && COMMENT_NETWORKS[net] && c.length > COMMENT_NETWORKS[net]) throw httpErr(400, "contact_center.social.errors.comment_too_long", { network: name, max: COMMENT_NETWORKS[net] });
		// Instagram відхиляє пост або коментар, у якому понад 30 хештегів
		if (net === "instagram" && (countTags(resolvePlain(net, v.text, text)) > IG_MAX_TAGS || countTags(c) > IG_MAX_TAGS)) throw httpErr(400, "contact_center.social.errors.hashtags_max_ig", { network: name, max: IG_MAX_TAGS });
	}

	return { title, text, firstComment, mediaIds, variants, targets };
}

/** Перевірки перед плануванням / перевіркою (для чернетки не потрібні) */
function assertPublishable(d) {
	if (!d.targets.length) throw httpErr(400, "contact_center.social.errors.targets_required");
	for (const t of d.targets) {
		const v = d.variants[t.network] || {};
		if (!resolvePlain(t.network, v.text, d.text).trim() && !d.mediaIds.length) throw httpErr(400, "contact_center.social.errors.text_or_media_for", { network: t.name });
	}
}

function parseDate(v) {
	if (!v) return null;
	const d = new Date(String(v));
	return isNaN(d) ? null : d;
}

/**
 * Зберегти публікацію.
 * action:
 *   draft    — чернетка;
 *   review   — на перевірку (погоджує інший користувач);
 *   schedule — на дату publish_at;
 *   now      — опублікувати якнайшвидше.
 */
async function save(id, b, idUser) {
	const action = ["draft", "review", "schedule", "now"].includes(b.action) ? b.action : "draft";
	const d = await normalize(b);

	let publishAt = parseDate(b.publish_at);
	if (action === "schedule") {
		if (!publishAt) throw httpErr(400, "contact_center.social.errors.publish_at_required");
		if (publishAt.getTime() < Date.now() - 60000) throw httpErr(400, "contact_center.social.errors.publish_at_past");
	} else if (action === "now") publishAt = new Date();
	if (action !== "draft") assertPublishable(d);

	const status = { draft: "draft", review: "review", schedule: "scheduled", now: "scheduled" }[action];
	const conn = await pool.getConnection();
	let created = false;
	try {
		await conn.beginTransaction();
		if (id) {
			const [[cur]] = await conn.query(`SELECT id FROM ${T_POSTS} WHERE id = ? AND deleted = 0 FOR UPDATE`, [id]);
			if (!cur) throw httpErr(404, "contact_center.social.errors.post_not_found");
			const [[busy]] = await conn.query(`SELECT COUNT(*) AS n FROM ${T_TARGETS} WHERE id_post = ? AND status IN ('processing','waiting','published')`, [id]);
			if (busy.n) throw httpErr(409, "contact_center.social.errors.post_locked");
			// На перевірку — фіксуємо, хто відправив; будь-яка інша дія знімає попереднє погодження
			const review = status === "review";
			await conn.query(
				`UPDATE ${T_POSTS} SET title = ?, text = ?, first_comment = ?, status = ?, publish_at = ?, id_user_edited = ?,
				        id_user_review = ?, date_review = ?, id_user_approved = NULL, date_approved = NULL
				  WHERE id = ?`,
				[d.title, d.text, d.firstComment, status, publishAt, idUser || null, review ? idUser || null : null, review ? new Date() : null, id]
			);
			await conn.query(`DELETE FROM ${T_MEDIA} WHERE id_post = ?`, [id]);
			await conn.query(`DELETE FROM ${T_TARGETS} WHERE id_post = ?`, [id]);
			await conn.query(`DELETE FROM ${T_VARIANTS} WHERE id_post = ?`, [id]);
		} else {
			const review = status === "review";
			const [r] = await conn.query(
				`INSERT INTO ${T_POSTS} (title, text, first_comment, status, publish_at, id_user, id_user_review, date_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[d.title, d.text, d.firstComment, status, publishAt, idUser || null, review ? idUser || null : null, review ? new Date() : null]
			);
			id = r.insertId;
			created = true;
		}
		if (d.mediaIds.length) await conn.query(`INSERT INTO ${T_MEDIA} (id_post, id_media, sort_order) VALUES ?`, [d.mediaIds.map((m, i) => [id, m, i])]);
		if (d.targets.length) await conn.query(`INSERT INTO ${T_TARGETS} (id_post, id_account, format) VALUES ?`, [d.targets.map((x) => [id, x.id_account, x.format])]);
		const vrows = Object.entries(d.variants).map(([net, v]) => [id, net, v.text, v.first_comment]);
		if (vrows.length) await conn.query(`INSERT INTO ${T_VARIANTS} (id_post, network, text, first_comment) VALUES ?`, [vrows]);

		await log.add(conn, {
			id_post: id,
			id_user: idUser,
			action: created ? "created" : "updated",
			details: { targets: d.targets.map((x) => x.name + " · " + x.format), media: d.mediaIds.length, own_text: Object.keys(d.variants).filter((k) => d.variants[k].text !== null) },
		});
		if (action !== "draft") {
			const act = { review: "submitted", schedule: "scheduled", now: "publish_now" }[action];
			await log.add(conn, { id_post: id, id_user: idUser, action: act, details: publishAt ? { publish_at: publishAt.toISOString() } : null });
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}

	// «Опублікувати зараз» — не чекаємо хвилину до cron
	if (action === "now") setImmediate(() => require("./publisher").run().catch(() => {}));
	return { id };
}

/** Погодити: «На перевірці» → «Заплановано» (на свій час або одразу, якщо час минув) */
async function approve(id, idUser) {
	const conn = await pool.getConnection();
	let publishNow = false;
	try {
		await conn.beginTransaction();
		const [[p]] = await conn.query(`SELECT id, status, publish_at, id_user_review FROM ${T_POSTS} WHERE id = ? AND deleted = 0 FOR UPDATE`, [id]);
		if (!p) throw httpErr(404, "contact_center.social.errors.post_not_found");
		if (p.status !== "review") throw httpErr(409, "contact_center.social.errors.not_in_review");
		// Погоджує інша людина, не та, що відправила на перевірку
		if (p.id_user_review && Number(p.id_user_review) === Number(idUser)) throw httpErr(403, "contact_center.social.errors.approve_self");
		publishNow = !p.publish_at || new Date(p.publish_at).getTime() <= Date.now();
		await conn.query(
			`UPDATE ${T_POSTS} SET status = 'scheduled', publish_at = IF(publish_at IS NULL OR publish_at < NOW(), NOW(), publish_at), id_user_approved = ?, date_approved = NOW() WHERE id = ?`,
			[idUser || null, id]
		);
		await log.add(conn, { id_post: id, id_user: idUser, action: "approved", details: publishNow ? { publish_now: true } : { publish_at: new Date(p.publish_at).toISOString() } });
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
	if (publishNow) setImmediate(() => require("./publisher").run().catch(() => {}));
}

/** Повернути на доопрацювання — коментар обов'язковий */
async function reject(id, idUser, note) {
	note = plainInput(note);
	if (!note) throw httpErr(400, "contact_center.social.errors.reject_note_required");
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [[p]] = await conn.query(`SELECT id, status FROM ${T_POSTS} WHERE id = ? AND deleted = 0 FOR UPDATE`, [id]);
		if (!p) throw httpErr(404, "contact_center.social.errors.post_not_found");
		if (p.status !== "review") throw httpErr(409, "contact_center.social.errors.not_in_review");
		await conn.query(`UPDATE ${T_POSTS} SET status = 'draft' WHERE id = ?`, [id]);
		await log.add(conn, { id_post: id, id_user: idUser, action: "rejected", note });
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
}

/**
 * Календар: публікації з датою в проміжку [start, end).
 * FullCalendar передає start/end з часовим поясом браузера (ISO 8601).
 */
async function calendar(q) {
	const start = parseDate(q.start);
	const end = parseDate(q.end);
	if (!start || !end || end <= start || end - start > 100 * 86400000) throw httpErr(400, "contact_center.social.errors.bad_range");
	const where = ["p.deleted = 0", "p.publish_at >= ?", "p.publish_at < ?"];
	const args = [start, end];
	if (q.id_account) {
		where.push(`EXISTS (SELECT 1 FROM ${T_TARGETS} x WHERE x.id_post = p.id AND x.id_account = ?)`);
		args.push(parseInt(q.id_account, 10) || 0);
	}
	if (q.status) {
		where.push("p.status = ?");
		args.push(String(q.status));
	}
	const [rows] = await pool.query(
		`SELECT p.id, p.title, LEFT(p.text, 2000) AS text, p.status, p.publish_at,
		        (SELECT m.id_media FROM ${T_MEDIA} m WHERE m.id_post = p.id ORDER BY m.sort_order LIMIT 1) AS cover
		   FROM ${T_POSTS} p WHERE ${where.join(" AND ")} ORDER BY p.publish_at LIMIT 1000`,
		args
	);
	if (!rows.length) return [];
	const [tg] = await pool.query(
		`SELECT t.id_post, t.format, t.status, a.network, a.name FROM ${T_TARGETS} t JOIN ${T_ACC} a ON a.id = t.id_account WHERE t.id_post IN (?) ORDER BY a.network, a.name`,
		[rows.map((r) => r.id)]
	);
	return rows.map((r) => {
		const targets = tg.filter((x) => x.id_post === r.id);
		return {
			id: r.id,
			title: r.title || format.toPlain(r.text).slice(0, 80),
			status: r.status,
			publish_at: r.publish_at,
			cover: r.cover,
			networks: [...new Set(targets.map((x) => x.network))],
			targets: targets.map((x) => ({ network: x.network, name: x.name, format: x.format, status: x.status })),
			// Перенести можна те, що ще не почало публікуватися
			movable: ["draft", "review", "scheduled"].includes(r.status) && !targets.some((x) => ["processing", "waiting", "published"].includes(x.status)),
		};
	});
}

/** Перенести публікацію на інший час (з календаря) */
async function reschedule(id, publishAt, idUser) {
	const at = parseDate(publishAt);
	if (!at) throw httpErr(400, "contact_center.social.errors.publish_at_required");
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [[p]] = await conn.query(`SELECT id, status, publish_at FROM ${T_POSTS} WHERE id = ? AND deleted = 0 FOR UPDATE`, [id]);
		if (!p) throw httpErr(404, "contact_center.social.errors.post_not_found");
		if (!["draft", "review", "scheduled"].includes(p.status)) throw httpErr(409, "contact_center.social.errors.post_locked");
		const [[busy]] = await conn.query(`SELECT COUNT(*) AS n FROM ${T_TARGETS} WHERE id_post = ? AND status IN ('processing','waiting','published')`, [id]);
		if (busy.n) throw httpErr(409, "contact_center.social.errors.post_locked");
		// Заплановане і на перевірці — лише в майбутнє (інакше опублікується одразу, чого при перетягуванні не чекають)
		if (p.status !== "draft" && at.getTime() < Date.now() + 60000) throw httpErr(400, "contact_center.social.errors.publish_at_past");
		await conn.query(`UPDATE ${T_POSTS} SET publish_at = ?, id_user_edited = ? WHERE id = ?`, [at, idUser || null, id]);
		await log.add(conn, { id_post: id, id_user: idUser, action: "rescheduled", details: { from: p.publish_at ? new Date(p.publish_at).toISOString() : null, to: at.toISOString() } });
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
}

/** Скасувати: цілі, що ще не почали публікуватися */
async function cancel(id, idUser) {
	const p = await get(id);
	await pool.query(`UPDATE ${T_TARGETS} SET status = 'canceled' WHERE id_post = ? AND status = 'pending'`, [id]);
	if (p.status === "review" || p.status === "draft") await pool.query(`UPDATE ${T_POSTS} SET status = 'canceled' WHERE id = ?`, [id]);
	await log.add(null, { id_post: id, id_user: idUser, action: "canceled" });
	await require("./publisher").refreshPostStatus(p.id);
}

/** Повторити помилкові цілі (або одну) */
async function retry(id, idTarget, idUser) {
	await get(id);
	const args = [id];
	let extra = "";
	if (idTarget) {
		extra = " AND id = ?";
		args.push(idTarget);
	}
	const [r] = await pool.query(
		`UPDATE ${T_TARGETS} SET status = 'pending', attempts = 0, error = NULL, next_attempt_at = NULL, state = NULL, lock_token = NULL, locked_until = NULL
		  WHERE id_post = ? AND status IN ('failed','canceled')${extra}`,
		args
	);
	if (!r.affectedRows) return;
	await pool.query(`UPDATE ${T_POSTS} SET status = 'scheduled', publish_at = LEAST(COALESCE(publish_at, NOW()), NOW()) WHERE id = ?`, [id]);
	await log.add(null, { id_post: id, id_target: idTarget || null, id_user: idUser, action: "retried" });
	setImmediate(() => require("./publisher").run().catch(() => {}));
}

async function remove(id, idUser) {
	const p = await get(id);
	if (p.targets.some((x) => x.status === "processing" || x.status === "waiting")) throw httpErr(409, "contact_center.social.errors.post_locked");
	await pool.query(`UPDATE ${T_POSTS} SET deleted = 1 WHERE id = ?`, [id]);
	await pool.query(`UPDATE ${T_TARGETS} SET status = 'canceled' WHERE id_post = ? AND status = 'pending'`, [id]);
	await log.add(null, { id_post: id, id_user: idUser, action: "deleted" });
}

module.exports = { list, calendar, reschedule, get, save, approve, reject, cancel, retry, remove, editable, resolveText, resolvePlain, COMMENT_NETWORKS, COMMENT_FORMATS };