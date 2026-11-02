/**
 * Статистика опублікованих постів і «найкращий час для публікації».
 *
 * Збір (tick, кожні 15 хв): Instagram і Facebook. Telegram і Viber показників для ботів / API каналів не віддають.
 *   Instagram: /{media-id}?fields=like_count,comments_count — дозволу instagram_business_basic достатньо;
 *              /{media-id}/insights — охоплення, перегляди, збереження, поширення (instagram_business_manage_insights).
 *   Facebook:  /{post-id}?fields=reactions.summary,comments.summary,shares — pages_read_engagement;
 *              /{post-id}/insights — охоплення (read_insights).
 * Назви метрик Meta з часом змінює, тому insights запитуються по одній, а недоступні просто пропускаються.
 *
 * Як часто оновлювати: перша доба — щогодини, до 7 днів — кожні 6 год, до 30 днів — раз на добу, потім — ні.
 *
 * Найкращий час: для кожного акаунта — середня залученість (вподобання + коментарі + поширення + збереження)
 * постів, опублікованих у певний день тижня і годину, відносно середньої по акаунту (індекс > 1 — краще звичайного).
 */
const axios = require("axios");
const pool = require("../../../config/database/connection_pool");
const logging = require("../../../logging/logging");
const accounts = require("./accounts");
const { P, t, httpErr, apiError } = require("./social");

const T_STATS = P + "social_post_stats";
const T_TARGETS = P + "social_post_targets";
const T_POSTS = P + "social_posts";
const T_ACC = P + "social_accounts";

const IG = "https://graph.instagram.com/v23.0";
const FB = "https://graph.facebook.com/v23.0";
const NETWORKS = ["instagram", "facebook"];
const BATCH = 30;
const MIN_POSTS = 8; // менше — «найкращий час» не показуємо, бо це вже не статистика

const get = (url, params) => axios.get(url, { params, timeout: 20000 }).then((r) => r.data);

/** Insights по одній метриці: недоступна (формат, дозвіл, застаріла назва) — null */
async function insights(base, id, token, metrics, extra) {
	const out = {};
	for (const m of metrics) {
		try {
			const d = await get(`${base}/${id}/insights`, { metric: m, access_token: token, ...(extra || {}) });
			const row = d && d.data && d.data[0];
			const v = row && (row.total_value ? row.total_value.value : row.values && row.values[0] ? row.values[0].value : null);
			out[m] = typeof v === "number" ? v : null;
		} catch (e) {
			out[m] = null;
		}
	}
	return out;
}

async function fetchInstagram(cred, tg) {
	const base = await get(`${IG}/${tg.external_id}`, { fields: "like_count,comments_count,media_product_type", access_token: cred.token });
	const ins = await insights(IG, tg.external_id, cred.token, ["reach", "views", "saved", "shares", "total_interactions"]);
	return {
		likes: num(base.like_count),
		comments: num(base.comments_count),
		shares: num(ins.shares),
		saves: num(ins.saved),
		reach: num(ins.reach),
		views: num(ins.views),
		interactions: num(ins.total_interactions),
		raw: { base, insights: ins },
	};
}

async function fetchFacebook(cred, tg) {
	const id = tg.external_id;
	let base;
	try {
		base = await get(`${FB}/${id}`, { fields: "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares", access_token: cred.token });
	} catch (e) {
		// Відео / фото без допису: реакції як «likes»
		base = await get(`${FB}/${id}`, { fields: "likes.summary(total_count).limit(0),comments.summary(total_count).limit(0)", access_token: cred.token });
	}
	const ins = await insights(FB, id, cred.token, ["post_impressions_unique", "post_media_view"]);
	const count = (x) => (x && x.summary ? x.summary.total_count : null);
	return {
		likes: num(count(base.reactions) ?? count(base.likes)),
		comments: num(count(base.comments)),
		shares: num(base.shares ? base.shares.count : 0),
		saves: null,
		reach: num(ins.post_impressions_unique),
		views: num(ins.post_media_view),
		interactions: null,
		raw: { base, insights: ins },
	};
}

const num = (v) => (typeof v === "number" && isFinite(v) && v >= 0 ? Math.round(v) : null);

/** Коли наступного разу оновлювати: залежить від віку поста */
function nextFetch(datePublished) {
	const age = Date.now() - new Date(datePublished).getTime();
	const H = 3600000;
	if (age < 24 * H) return new Date(Date.now() + H);
	if (age < 7 * 24 * H) return new Date(Date.now() + 6 * H);
	if (age < 30 * 24 * H) return new Date(Date.now() + 24 * H);
	return null; // старші за 30 днів — більше не оновлюємо
}

/** Оновити статистику однієї цілі */
async function refreshTarget(idTarget) {
	const [[tg]] = await pool.query(
		`SELECT t.*, a.network FROM ${T_TARGETS} t JOIN ${T_ACC} a ON a.id = t.id_account WHERE t.id = ?`,
		[idTarget]
	);
	if (!tg) throw httpErr(404, "contact_center.social.errors.post_not_found");
	if (tg.status !== "published" || !tg.external_id || !NETWORKS.includes(tg.network) || tg.format === "story") throw httpErr(400, "contact_center.social.errors.stats_unsupported");

	let row;
	let error = null;
	try {
		const cred = await accounts.credentials(tg.id_account);
		row = await (tg.network === "instagram" ? fetchInstagram : fetchFacebook)(cred, tg);
	} catch (e) {
		error = e.status ? t(e.message, e.params) : apiError(e).message;
		row = { likes: null, comments: null, shares: null, saves: null, reach: null, views: null, interactions: null, raw: null };
	}
	const next = nextFetch(tg.date_published);
	if (error) {
		// Помилка: попередні показники лишаються, записуємо лише текст помилки і час наступної спроби
		await pool.query(
			`INSERT INTO ${T_STATS} (id_target, error, date_fetched, next_fetch) VALUES (?, ?, NOW(), ?)
			 ON DUPLICATE KEY UPDATE error = ?, date_fetched = NOW(), next_fetch = ?`,
			[idTarget, error, next, error, next]
		);
	} else {
		const vals = [row.likes, row.comments, row.shares, row.saves, row.reach, row.views, row.interactions, JSON.stringify(row.raw)];
		await pool.query(
			`INSERT INTO ${T_STATS} (id_target, likes, comments, shares, saves, reach, views, interactions, raw, error, date_fetched, next_fetch)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NOW(), ?)
			 ON DUPLICATE KEY UPDATE likes = ?, comments = ?, shares = ?, saves = ?, reach = ?, views = ?, interactions = ?, raw = ?,
			                         error = NULL, date_fetched = NOW(), next_fetch = ?`,
			[idTarget, ...vals, next, ...vals, next]
		);
	}
	return { error };
}

let running = false;

/** Cron: оновити статистику постів, яким настав час */
async function tick() {
	if (running) return;
	running = true;
	try {
		const [rows] = await pool.query(
			`SELECT t.id FROM ${T_TARGETS} t
			   JOIN ${T_ACC} a ON a.id = t.id_account
			   LEFT JOIN ${T_STATS} s ON s.id_target = t.id
			  WHERE t.status = 'published' AND t.external_id IS NOT NULL AND t.format <> 'story'
			    AND a.network IN ('instagram','facebook') AND a.deleted = 0
			    AND t.date_published > NOW() - INTERVAL 30 DAY
			    AND (s.id_target IS NULL OR s.next_fetch <= NOW())
			  ORDER BY s.date_fetched IS NOT NULL, s.next_fetch
			  LIMIT ${BATCH}`
		);
		for (const r of rows) {
			try {
				await refreshTarget(r.id);
			} catch (e) {
				logging.warn(`[social] статистика цілі #${r.id}: ${e.message}`);
			}
		}
	} catch (e) {
		logging.error(e);
	} finally {
		running = false;
	}
}

/** Залученість одного поста: усе, що мережа віддала */
const ENGAGEMENT_SQL = "(COALESCE(s.likes,0) + COALESCE(s.comments,0) + COALESCE(s.shares,0) + COALESCE(s.saves,0))";

/** Таблиця статистики (Tabulator remote) */
async function list(q) {
	const page = Math.max(1, parseInt(q.page, 10) || 1);
	const size = Math.min(100, Math.max(1, parseInt(q.size, 10) || 20));
	const where = ["t.status = 'published'", "p.deleted = 0", "a.network IN ('instagram','facebook')"];
	const args = [];
	if (q.id_account) {
		where.push("t.id_account = ?");
		args.push(parseInt(q.id_account, 10) || 0);
	}
	const days = Math.min(365, Math.max(1, parseInt(q.days, 10) || 30));
	where.push(`t.date_published > NOW() - INTERVAL ${days} DAY`);
	const SORT = { date_published: "t.date_published", likes: "s.likes", comments: "s.comments", shares: "s.shares", saves: "s.saves", reach: "s.reach", views: "s.views", engagement: "engagement", er: "er" };
	const sq = (Array.isArray(q.sort) && q.sort[0]) || {};
	const order = (SORT[sq.field] || "t.date_published") + (sq.dir === "asc" ? " ASC" : " DESC");
	const w = where.join(" AND ");

	const from = `FROM ${T_TARGETS} t JOIN ${T_POSTS} p ON p.id = t.id_post JOIN ${T_ACC} a ON a.id = t.id_account LEFT JOIN ${T_STATS} s ON s.id_target = t.id`;
	const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n ${from} WHERE ${w}`, args);
	const [rows] = await pool.query(
		`SELECT t.id, t.id_post, t.format, t.permalink, t.date_published, p.title, LEFT(p.text, 300) AS text, a.network, a.name AS account,
		        s.likes, s.comments, s.shares, s.saves, s.reach, s.views, s.error, s.date_fetched,
		        ${ENGAGEMENT_SQL} AS engagement,
		        IF(s.reach > 0, ROUND(${ENGAGEMENT_SQL} / s.reach * 100, 2), NULL) AS er
		   ${from} WHERE ${w} ORDER BY ${order}, t.id DESC LIMIT ? OFFSET ?`,
		[...args, size, (page - 1) * size]
	);
	const format = require("./format");
	for (const r of rows) r.text = r.title || format.toPlain(r.text).slice(0, 120);
	return { last_page: Math.max(1, Math.ceil(n / size)), data: rows };
}

/** Підсумки за період: кількість постів і суми показників */
async function summary(q) {
	const days = Math.min(365, Math.max(1, parseInt(q.days, 10) || 30));
	const args = [];
	let acc = "";
	if (q.id_account) {
		acc = " AND t.id_account = ?";
		args.push(parseInt(q.id_account, 10) || 0);
	}
	const [[r]] = await pool.query(
		`SELECT COUNT(*) AS posts, SUM(s.likes) AS likes, SUM(s.comments) AS comments, SUM(s.shares) AS shares, SUM(s.saves) AS saves,
		        SUM(s.reach) AS reach, SUM(s.views) AS views, ROUND(AVG(${ENGAGEMENT_SQL}), 1) AS avg_engagement
		   FROM ${T_TARGETS} t JOIN ${T_POSTS} p ON p.id = t.id_post JOIN ${T_ACC} a ON a.id = t.id_account LEFT JOIN ${T_STATS} s ON s.id_target = t.id
		  WHERE t.status = 'published' AND p.deleted = 0 AND a.network IN ('instagram','facebook') AND t.date_published > NOW() - INTERVAL ${days} DAY${acc}`,
		args
	);
	return r;
}

/**
 * Найкращий час для акаунта за останні 90 днів.
 * Повертає сітку 7×24 (день тижня 0 = понеділок) з індексом (середня залученість слоту / середня по акаунту)
 * і кількістю постів у слоті, та топ-слоти, де щонайменше 2 пости.
 * Час — за часовим поясом сервера бази (той самий, що й publish_at).
 */
async function bestTime(idAccount) {
	const [rows] = await pool.query(
		`SELECT WEEKDAY(t.date_published) AS dow, HOUR(t.date_published) AS hour, ${ENGAGEMENT_SQL} AS engagement
		   FROM ${T_TARGETS} t JOIN ${T_STATS} s ON s.id_target = t.id JOIN ${T_POSTS} p ON p.id = t.id_post
		  WHERE t.id_account = ? AND t.status = 'published' AND p.deleted = 0 AND t.format <> 'story' AND s.error IS NULL
		    AND t.date_published > NOW() - INTERVAL 90 DAY
		    -- свіжі пости ще набирають реакції — не порівнюємо їх зі старими
		    AND t.date_published < NOW() - INTERVAL 1 DAY`,
		[idAccount]
	);
	if (rows.length < MIN_POSTS) return { enough: false, posts: rows.length, min: MIN_POSTS, grid: [], top: [] };

	const avg = rows.reduce((s, r) => s + Number(r.engagement), 0) / rows.length || 1;
	const cells = new Map();
	for (const r of rows) {
		const key = r.dow + ":" + r.hour;
		const c = cells.get(key) || { dow: r.dow, hour: r.hour, sum: 0, posts: 0 };
		c.sum += Number(r.engagement);
		c.posts++;
		cells.set(key, c);
	}
	const grid = [...cells.values()].map((c) => ({ dow: c.dow, hour: c.hour, posts: c.posts, index: Math.round((c.sum / c.posts / avg) * 100) / 100 }));
	const top = grid
		.filter((c) => c.posts >= 2)
		.sort((a, b) => b.index - a.index || b.posts - a.posts)
		.slice(0, 3);
	return { enough: true, posts: rows.length, avg: Math.round(avg * 10) / 10, grid, top };
}

/** Найближчий майбутній час найкращого слоту акаунта (для кнопки в редакторі) */
async function nextBestSlot(idAccount) {
	const bt = await bestTime(idAccount);
	if (!bt.enough || !bt.top.length) return { enough: false, posts: bt.posts, min: MIN_POSTS };
	const now = new Date();
	let best = null;
	for (const slot of bt.top) {
		// JS: 0 = неділя; WEEKDAY: 0 = понеділок
		const jsDow = (slot.dow + 1) % 7;
		const d = new Date(now);
		d.setHours(slot.hour, 0, 0, 0);
		let add = (jsDow - d.getDay() + 7) % 7;
		if (add === 0 && d <= now) add = 7;
		d.setDate(d.getDate() + add);
		if (!best || d < best.at) best = { at: d, slot };
	}
	return { enough: true, at: best.at.toISOString(), slot: best.slot };
}

module.exports = { tick, refreshTarget, list, summary, bestTime, nextBestSlot, MIN_POSTS };