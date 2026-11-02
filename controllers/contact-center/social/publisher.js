/**
 * Черга публікацій.
 *
 * run() викликається cron-ом щохвилини (і одразу після «Опублікувати зараз»):
 *  1) захоплює до BATCH цілей, у яких настав час: UPDATE … SET lock_token — атомарно,
 *     тож два процеси pm2 не опублікують одне й те саме;
 *  2) публікує кожну через адаптер мережі;
 *  3) результат: published / waiting (Instagram обробляє відео) / повтор пізніше / failed;
 *  4) перераховує статус публікації.
 *
 * Зависле захоплення (процес упав) звільняється після LOCK_MIN хвилин.
 */
const crypto = require("crypto");
const pool = require("../../../config/database/connection_pool");
const logging = require("../../../logging/logging");
const accounts = require("./accounts");
const media = require("./media");
const { P, t, PublishError, mediaUrl } = require("./social");
const firstComment = require("./first-comment");
const log = require("./log");

const T_POSTS = P + "social_posts";
const T_TARGETS = P + "social_post_targets";
const T_PM = P + "social_post_media";
const T_VARIANTS = P + "social_post_variants";

const NETWORKS = {
	instagram: require("./instagram"),
	facebook: require("./facebook"),
	telegram: require("./telegram"),
	viber: require("./viber"),
};

const BATCH = 10;
const LOCK_MIN = 10;
const MAX_ATTEMPTS = 5;
const BACKOFF_MIN = [1, 5, 15, 60, 180]; // затримка перед повтором тимчасової помилки

let running = false;

async function claim() {
	const token = crypto.randomBytes(16).toString("hex");
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		// SKIP LOCKED: інший процес уже взяв ці рядки — пропускаємо їх, а не чекаємо
		const [ids] = await conn.query(
			`SELECT t.id FROM ${T_TARGETS} t JOIN ${T_POSTS} p ON p.id = t.id_post
			  WHERE p.deleted = 0 AND p.status IN ('scheduled','publishing') AND p.publish_at <= NOW()
			    AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= NOW())
			    AND ( (t.status IN ('pending','waiting') AND (t.locked_until IS NULL OR t.locked_until < NOW()))
			       OR (t.status = 'processing' AND t.locked_until < NOW()) )
			  ORDER BY p.publish_at, t.id
			  LIMIT ${BATCH}
			  FOR UPDATE OF t SKIP LOCKED`
		);
		if (ids.length) {
			await conn.query(
				`UPDATE ${T_TARGETS} SET lock_token = ?, locked_until = NOW() + INTERVAL ${LOCK_MIN} MINUTE, status = IF(status = 'waiting', 'waiting', 'processing') WHERE id IN (?)`,
				[token, ids.map((r) => r.id)]
			);
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
	const [rows] = await pool.query(`SELECT * FROM ${T_TARGETS} WHERE lock_token = ?`, [token]);
	return rows;
}

/** Медіа публікації з публічними посиланнями */
async function mediaFor(idPost) {
	const [ids] = await pool.query(`SELECT id_media FROM ${T_PM} WHERE id_post = ? ORDER BY sort_order`, [idPost]);
	const rows = await media.byIds(ids.map((r) => r.id_media));
	// Порядок — як у публікації
	return ids
		.map((r) => rows.find((m) => m.id === r.id_media))
		.filter(Boolean)
		.map((m) => ({ id: m.id, kind: m.kind, mime: m.mime, size: Number(m.size), width: m.width, height: m.height, url: mediaUrl(m, "", 24), url_viber: m.kind === "image" ? mediaUrl(m, "viber", 24) : null }));
}

async function processTarget(tg) {
	const [[post]] = await pool.query(`SELECT id, text, status FROM ${T_POSTS} WHERE id = ?`, [tg.id_post]);
	const { resolveText, resolvePlain } = require("./posts");
	let state = null;
	try {
		state = tg.state ? (typeof tg.state === "string" ? JSON.parse(tg.state) : tg.state) : null;
	} catch (e) {
		state = null;
	}

	try {
		if (post.status === "scheduled") await pool.query(`UPDATE ${T_POSTS} SET status = 'publishing' WHERE id = ? AND status = 'scheduled'`, [post.id]);
		const cred = await accounts.credentials(tg.id_account);
		const adapter = NETWORKS[cred.network];
		// Текст мережі: окремий (у форматі мережі) або спільний, перетворений під мережу (posts.resolveText)
		const [[variant]] = await pool.query(`SELECT text FROM ${T_VARIANTS} WHERE id_post = ? AND network = ?`, [post.id, cred.network]);
		const vText = variant ? variant.text : null;
		const job = {
			format: tg.format,
			text: resolveText(cred.network, vText, post.text || ""),
			plain: resolvePlain(cred.network, vText, post.text || ""),
			media: await mediaFor(post.id),
			state,
		};
		const res = await adapter.publish(cred, job);

		if (res.wait) {
			// Instagram ще обробляє відео — повернемось пізніше, захоплення знімаємо
			await pool.query(`UPDATE ${T_TARGETS} SET status = 'waiting', state = ?, next_attempt_at = NOW() + INTERVAL ? SECOND, lock_token = NULL, locked_until = NULL WHERE id = ?`, [
				JSON.stringify(res.state || state || {}),
				res.wait,
				tg.id,
			]);
			return;
		}
		await pool.query(
			`UPDATE ${T_TARGETS} SET status = 'published', external_id = ?, permalink = ?, error = NULL, state = ?, date_published = NOW(), lock_token = NULL, locked_until = NULL WHERE id = ?`,
			[res.external_id || null, res.permalink || null, res.state ? JSON.stringify(res.state) : null, tg.id]
		);
		logging.info(`[social] опубліковано: публікація #${post.id}, ціль #${tg.id} (${cred.network}/${tg.format}) → ${res.permalink || res.external_id}`);
		await log.add(null, { id_post: post.id, id_target: tg.id, action: "published", details: { permalink: res.permalink || null, external_id: res.external_id || null } });
		// Перший коментар — окремою чергою (first-comment.js)
		const [[fresh]] = await pool.query(`SELECT * FROM ${T_TARGETS} WHERE id = ?`, [tg.id]);
		await firstComment.schedule(fresh, cred).catch((e) => logging.error(e));
	} catch (e) {
		// Помилка з ключем перекладу (httpErr) — перекладаємо мовою системи
		const pe = e instanceof PublishError ? e : new PublishError(e.status ? t(e.message, e.params) : String(e.message || e), !e.status);
		const attempts = tg.attempts + 1;
		const retry = pe.temporary && attempts < MAX_ATTEMPTS;
		const keepState = e.state || state;
		await pool.query(
			`UPDATE ${T_TARGETS} SET status = ?, attempts = ?, error = ?, state = ?, next_attempt_at = ${retry ? "NOW() + INTERVAL ? MINUTE" : "NULL"}, lock_token = NULL, locked_until = NULL WHERE id = ?`,
			[retry ? (keepState && keepState.container ? "waiting" : "pending") : "failed", attempts, String(pe.message).slice(0, 1000), keepState ? JSON.stringify(keepState) : null, ...(retry ? [BACKOFF_MIN[attempts - 1] || 60] : []), tg.id]
		);
		logging.warn(`[social] ${retry ? "повтор пізніше" : "помилка"}: публікація #${tg.id_post}, ціль #${tg.id}: ${pe.message}`);
		await log.add(null, { id_post: tg.id_post, id_target: tg.id, action: retry ? "retry_later" : "failed", note: pe.message, details: { attempt: attempts } });
	}
}

/** Статус публікації за станом її цілей */
async function refreshPostStatus(idPost) {
	const [rows] = await pool.query(`SELECT status, COUNT(*) AS n FROM ${T_TARGETS} WHERE id_post = ? GROUP BY status`, [idPost]);
	const c = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
	const total = rows.reduce((s, r) => s + Number(r.n), 0);
	const active = (c.pending || 0) + (c.processing || 0) + (c.waiting || 0);
	const [[p]] = await pool.query(`SELECT status FROM ${T_POSTS} WHERE id = ?`, [idPost]);
	// Чернетку і публікацію на перевірці черга не чіпає
	if (!p || p.status === "draft" || p.status === "review") return;

	let status;
	if (!total || (c.canceled || 0) === total) status = "canceled";
	else if (active) status = c.published || c.failed || c.processing || c.waiting ? "publishing" : p.status === "publishing" ? "publishing" : "scheduled";
	else if ((c.published || 0) && !(c.failed || 0)) status = "published";
	else if (c.published) status = "partial";
	else status = "failed";
	await pool.query(`UPDATE ${T_POSTS} SET status = ? WHERE id = ?`, [status, idPost]);
}

async function run() {
	if (running) return;
	running = true;
	try {
		for (let round = 0; round < 10; round++) {
			const batch = await claim();
			if (!batch.length) break;
			for (const tg of batch) await processTarget(tg);
			for (const idPost of new Set(batch.map((x) => x.id_post))) await refreshPostStatus(idPost);
			if (batch.length < BATCH) break;
		}
	} catch (e) {
		logging.error(e);
	} finally {
		running = false;
	}
	// Перші коментарі — після публікацій
	await firstComment.tick().catch((e) => logging.error(e));
}

module.exports = { run, refreshPostStatus };