/**
 * Контакт-центр → Коментарі: коментарі під постами Instagram і Facebook-сторінки.
 *
 * Звідки приходять:
 *   • вебхук (одразу): Instagram — поле «comments» об'єкта instagram; Facebook — поле «feed» об'єкта page;
 *   • синхронізація (кожні 30 хв і кнопкою): останні пости й коментарі до них через Graph API —
 *     підстраховка, якщо вебхук не дійшов або коментар з'явився до підключення.
 *
 * Дії (токен каналу контакт-центру):
 *   відповісти        Instagram POST /{comment}/replies;   Facebook POST /{comment}/comments
 *   приховати/показати Instagram POST /{comment}?hide=;    Facebook POST /{comment}?is_hidden=
 *   видалити          DELETE /{comment}
 *   в особисті        POST /me/messages { recipient: { comment_id } } — один раз, протягом 7 днів;
 *                     повідомлення з'явиться в діалозі контакт-центру через echo.
 */
const axios = require("axios");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const cryptoHelper = require("../../helpers/crypto");

const P = config.get("configDatabase").prefix;
const T = P + "contact_center_comments";
const T_CH = P + "contact_center_channels";

const API = { instagram: "https://graph.instagram.com/v23.0", facebook: "https://graph.facebook.com/v23.0" };
const SYNC_MEDIA = 25; // скільки останніх постів перевіряти при синхронізації
const SYNC_COMMENTS = 50; // коментарів на пост

/** Помилка з ключем перекладу — роут перекладає через req.__ */
const httpErr = (status, key, params) => Object.assign(new Error(key), { status, params: params || {} });

/** Текст помилки Graph API */
function graphMessage(e) {
	const d = e && e.response && e.response.data;
	return String((d && d.error && (d.error.error_user_msg || d.error.message)) || (e && e.message) || "Graph API error").slice(0, 500);
}

/** Токен і ID акаунта з каналу контакт-центру */
async function channelCred(idChannel) {
	const [[ch]] = await pool.query(`SELECT id, type, status FROM ${T_CH} WHERE id = ? AND deleted = 0`, [idChannel]);
	if (!ch || (ch.type !== "instagram" && ch.type !== "facebook")) throw httpErr(404, "contact_center.comments.errors.channel_not_found");
	if (ch.type === "instagram") {
		const [[r]] = await pool.query(`SELECT token_cipher, token_iv, token_tag, ig_user_id FROM ${P}contact_center_channel_instagram WHERE id_channel = ? LIMIT 1`, [idChannel]);
		const token = r && cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag);
		if (!token || !r.ig_user_id) throw httpErr(400, "contact_center.comments.errors.channel_not_ready");
		return { network: "instagram", token, owner: String(r.ig_user_id), id_channel: idChannel };
	}
	const [[r]] = await pool.query(`SELECT token_cipher, token_iv, token_tag, page_id FROM ${P}contact_center_channel_facebook WHERE id_channel = ? LIMIT 1`, [idChannel]);
	const token = r && cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag);
	if (!token || !r.page_id) throw httpErr(400, "contact_center.comments.errors.channel_not_ready");
	return { network: "facebook", token, owner: String(r.page_id), id_channel: idChannel };
}

/**
 * Зберегти / оновити коментар (з вебхука або синхронізації).
 * Статус уже оброблених коментарів не скидається.
 */
async function upsert(c) {
	if (!c.external_id) return;
	const isOwn = c.author_id && c.owner && String(c.author_id) === String(c.owner) ? 1 : 0;
	await pool.query(
		`INSERT INTO ${T} (id_channel, network, external_id, parent_external_id, media_id, media_permalink, media_caption, media_thumb,
		                   author_id, author_name, author_username, text, is_own, status, is_hidden, date_add)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AS n
		 ON DUPLICATE KEY UPDATE
		   text = COALESCE(n.text, ${T}.text),
		   media_permalink = COALESCE(n.media_permalink, ${T}.media_permalink),
		   media_caption = COALESCE(n.media_caption, ${T}.media_caption),
		   media_thumb = COALESCE(n.media_thumb, ${T}.media_thumb),
		   author_name = COALESCE(n.author_name, ${T}.author_name),
		   author_username = COALESCE(n.author_username, ${T}.author_username),
		   is_hidden = n.is_hidden`,
		[
			c.id_channel,
			c.network,
			String(c.external_id),
			c.parent_external_id ? String(c.parent_external_id) : null,
			c.media_id ? String(c.media_id) : null,
			c.media_permalink || null,
			c.media_caption ? String(c.media_caption).slice(0, 500) : null,
			c.media_thumb || null,
			c.author_id ? String(c.author_id) : null,
			c.author_name || null,
			c.author_username || null,
			c.text === undefined ? null : c.text,
			isOwn,
			isOwn ? "answered" : "new",
			c.is_hidden ? 1 : 0,
			c.date_add ? new Date(c.date_add) : new Date(),
		]
	);
	// Наша відповідь у гілці — батьківський коментар вважається опрацьованим
	if (isOwn && c.parent_external_id) {
		await pool.query(`UPDATE ${T} SET status = 'answered' WHERE network = ? AND external_id = ? AND status = 'new'`, [c.network, String(c.parent_external_id)]);
	}
}

/* ─── Вебхуки ─── */

/** Instagram: entry.changes[] з field = "comments" */
async function onInstagramChange(idChannel, owner, change) {
	if (!change || change.field !== "comments" || !change.value) return;
	const v = change.value;
	await upsert({
		id_channel: idChannel,
		network: "instagram",
		owner,
		external_id: v.id,
		parent_external_id: v.parent_id || null,
		media_id: v.media && v.media.id,
		author_id: v.from && v.from.id,
		author_username: v.from && v.from.username,
		text: v.text,
		date_add: new Date(),
	});
}

/** Facebook: entry.changes[] з field = "feed", item = "comment" */
async function onFacebookChange(idChannel, owner, change) {
	if (!change || change.field !== "feed" || !change.value || change.value.item !== "comment") return;
	const v = change.value;
	if (v.verb === "remove") {
		await pool.query(`UPDATE ${T} SET status = 'deleted' WHERE network = 'facebook' AND external_id = ?`, [String(v.comment_id)]);
		return;
	}
	if (v.verb === "hide" || v.verb === "unhide") {
		await pool.query(`UPDATE ${T} SET is_hidden = ? WHERE network = 'facebook' AND external_id = ?`, [v.verb === "hide" ? 1 : 0, String(v.comment_id)]);
		return;
	}
	await upsert({
		id_channel: idChannel,
		network: "facebook",
		owner,
		external_id: v.comment_id,
		// parent_id — пост для коментаря першого рівня, коментар — для відповіді
		parent_external_id: v.parent_id && v.parent_id !== v.post_id ? v.parent_id : null,
		media_id: v.post_id,
		author_id: v.from && v.from.id,
		author_name: v.from && v.from.name,
		text: v.message,
		date_add: v.created_time ? new Date(Number(v.created_time) * 1000) : new Date(),
	});
}

/* ─── Синхронізація ─── */

async function syncInstagram(cred) {
	const api = API.instagram;
	const media = (await axios.get(`${api}/${cred.owner}/media`, { params: { fields: "id,caption,permalink,thumbnail_url,media_url,media_type,comments_count", limit: SYNC_MEDIA, access_token: cred.token }, timeout: 30000 })).data.data || [];
	let n = 0;
	for (const m of media) {
		if (!m.comments_count) continue;
		const thumb = m.media_type === "VIDEO" ? m.thumbnail_url : m.media_url;
		const comments =
			(await axios.get(`${api}/${m.id}/comments`, { params: { fields: "id,text,timestamp,hidden,from{id,username},replies{id,text,timestamp,hidden,from{id,username}}", limit: SYNC_COMMENTS, access_token: cred.token }, timeout: 30000 })).data.data || [];
		const base = { id_channel: cred.id_channel, network: "instagram", owner: cred.owner, media_id: m.id, media_permalink: m.permalink, media_caption: m.caption, media_thumb: thumb };
		for (const c of comments) {
			await upsert({ ...base, external_id: c.id, author_id: c.from && c.from.id, author_username: c.from && c.from.username, text: c.text, is_hidden: c.hidden, date_add: c.timestamp });
			n++;
			for (const r of (c.replies && c.replies.data) || []) {
				await upsert({ ...base, external_id: r.id, parent_external_id: c.id, author_id: r.from && r.from.id, author_username: r.from && r.from.username, text: r.text, is_hidden: r.hidden, date_add: r.timestamp });
				n++;
			}
		}
		// Дані поста для коментарів, що прийшли вебхуком (там лише ID)
		await pool.query(`UPDATE ${T} SET media_permalink = ?, media_caption = ?, media_thumb = ? WHERE network = 'instagram' AND media_id = ?`, [m.permalink || null, m.caption ? String(m.caption).slice(0, 500) : null, thumb || null, m.id]);
	}
	return n;
}

async function syncFacebook(cred) {
	const api = API.facebook;
	const posts =
		(await axios.get(`${api}/${cred.owner}/posts`, {
			params: { fields: "id,message,permalink_url,full_picture,comments.limit(" + SYNC_COMMENTS + "){id,message,created_time,is_hidden,from,comments{id,message,created_time,is_hidden,from}}", limit: SYNC_MEDIA, access_token: cred.token },
			timeout: 30000,
		})).data.data || [];
	let n = 0;
	for (const p of posts) {
		const base = { id_channel: cred.id_channel, network: "facebook", owner: cred.owner, media_id: p.id, media_permalink: p.permalink_url, media_caption: p.message, media_thumb: p.full_picture };
		for (const c of (p.comments && p.comments.data) || []) {
			await upsert({ ...base, external_id: c.id, author_id: c.from && c.from.id, author_name: c.from && c.from.name, text: c.message, is_hidden: c.is_hidden, date_add: c.created_time });
			n++;
			for (const r of (c.comments && c.comments.data) || []) {
				await upsert({ ...base, external_id: r.id, parent_external_id: c.id, author_id: r.from && r.from.id, author_name: r.from && r.from.name, text: r.message, is_hidden: r.is_hidden, date_add: r.created_time });
				n++;
			}
		}
		await pool.query(`UPDATE ${T} SET media_permalink = ?, media_caption = ?, media_thumb = ? WHERE network = 'facebook' AND media_id = ?`, [p.permalink_url || null, p.message ? String(p.message).slice(0, 500) : null, p.full_picture || null, p.id]);
	}
	return n;
}

/** Синхронізувати всі активні канали Instagram і Facebook (або один) */
async function sync(idChannel) {
	const [chs] = await pool.query(`SELECT id FROM ${T_CH} WHERE deleted = 0 AND status = 1 AND type IN ('instagram','facebook')${idChannel ? " AND id = ?" : ""}`, idChannel ? [idChannel] : []);
	const result = { channels: 0, comments: 0, errors: [] };
	for (const ch of chs) {
		try {
			const cred = await channelCred(ch.id);
			result.comments += await (cred.network === "instagram" ? syncInstagram : syncFacebook)(cred);
			result.channels++;
		} catch (e) {
			const msg = e.status ? e.message : graphMessage(e);
			result.errors.push({ id_channel: ch.id, error: msg });
			logging.warn(`[comments] синхронізація каналу #${ch.id}: ${msg}`);
		}
	}
	return result;
}

let syncing = false;
async function syncTick() {
	if (syncing) return;
	syncing = true;
	try {
		await sync(null);
	} catch (e) {
		logging.error(e);
	} finally {
		syncing = false;
	}
}

/* ─── Список ─── */

async function list(q) {
	const page = Math.max(1, parseInt(q.page, 10) || 1);
	const size = Math.min(100, Math.max(1, parseInt(q.size, 10) || 25));
	// Верхній рівень — коментарі клієнтів; відповіді показуються гілкою під ними
	const where = ["c.parent_external_id IS NULL", "c.is_own = 0"];
	const args = [];
	if (["new", "answered", "hidden", "deleted"].includes(q.status)) {
		if (q.status === "hidden") where.push("c.is_hidden = 1 AND c.status <> 'deleted'");
		else {
			where.push("c.status = ?");
			args.push(q.status);
		}
	} else where.push("c.status <> 'deleted'");
	if (q.id_channel) {
		where.push("c.id_channel = ?");
		args.push(parseInt(q.id_channel, 10) || 0);
	}
	if (q.q) {
		where.push("(c.text LIKE ? OR c.author_name LIKE ? OR c.author_username LIKE ?)");
		const like = "%" + String(q.q).replace(/[\\%_]/g, "\\$&") + "%";
		args.push(like, like, like);
	}
	const w = where.join(" AND ");
	const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T} c WHERE ${w}`, args);
	const [rows] = await pool.query(
		`SELECT c.*, ch.name AS channel_name,
		        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS action_user
		   FROM ${T} c
		   JOIN ${T_CH} ch ON ch.id = c.id_channel
		   LEFT JOIN ${P}users u ON u.id = c.id_user_action
		  WHERE ${w} ORDER BY c.date_add DESC, c.id DESC LIMIT ? OFFSET ?`,
		[...args, size, (page - 1) * size]
	);
	if (rows.length) {
		const [replies] = await pool.query(
			`SELECT id, network, external_id, parent_external_id, author_name, author_username, text, is_own, is_hidden, status, date_add
			   FROM ${T} WHERE parent_external_id IN (?) AND status <> 'deleted' ORDER BY date_add`,
			[rows.map((r) => r.external_id)]
		);
		for (const r of rows) r.replies = replies.filter((x) => x.parent_external_id === r.external_id && x.network === r.network);
	}
	return { last_page: Math.max(1, Math.ceil(n / size)), data: rows };
}

/** Лічильник нових — для меню */
async function countNew() {
	const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T} WHERE status = 'new' AND is_own = 0 AND parent_external_id IS NULL`);
	return Number(n);
}

/* ─── Дії ─── */

async function getRow(id) {
	const [[r]] = await pool.query(`SELECT * FROM ${T} WHERE id = ?`, [id]);
	if (!r) throw httpErr(404, "contact_center.comments.errors.not_found");
	return r;
}

async function call(method, cred, path, params) {
	try {
		const url = API[cred.network] + path;
		const r = await axios({ method, url, params: { ...params, access_token: cred.token }, timeout: 30000 });
		return r.data;
	} catch (e) {
		throw httpErr(400, "contact_center.comments.errors.api", { error: graphMessage(e) });
	}
}

const plain = (v) =>
	String(v == null ? "" : v)
		.replace(/\r\n?/g, "\n")
		.trim();

async function reply(id, text, idUser) {
	text = plain(text);
	if (!text) throw httpErr(400, "contact_center.comments.errors.text_required");
	const c = await getRow(id);
	if (c.status === "deleted") throw httpErr(409, "contact_center.comments.errors.deleted");
	const cred = await channelCred(c.id_channel);
	const d = c.network === "instagram" ? await call("post", cred, `/${c.external_id}/replies`, { message: text }) : await call("post", cred, `/${c.external_id}/comments`, { message: text });
	await upsert({ id_channel: c.id_channel, network: c.network, owner: cred.owner, external_id: d.id, parent_external_id: c.external_id, media_id: c.media_id, author_id: cred.owner, text, date_add: new Date() });
	await pool.query(`UPDATE ${T} SET status = 'answered', id_user_action = ?, date_action = NOW() WHERE id = ?`, [idUser || null, id]);
	return { id: d.id };
}

async function setHidden(id, hidden, idUser) {
	const c = await getRow(id);
	const cred = await channelCred(c.id_channel);
	if (c.network === "instagram") await call("post", cred, `/${c.external_id}`, { hide: hidden ? "true" : "false" });
	else await call("post", cred, `/${c.external_id}`, { is_hidden: hidden ? "true" : "false" });
	await pool.query(`UPDATE ${T} SET is_hidden = ?, id_user_action = ?, date_action = NOW() WHERE id = ?`, [hidden ? 1 : 0, idUser || null, id]);
}

async function remove(id, idUser) {
	const c = await getRow(id);
	const cred = await channelCred(c.id_channel);
	await call("delete", cred, `/${c.external_id}`, {});
	await pool.query(`UPDATE ${T} SET status = 'deleted', id_user_action = ?, date_action = NOW() WHERE id = ?`, [idUser || null, id]);
}

/** Відповідь в особисті (Direct / Messenger) на коментар — один раз, не пізніше 7 днів */
async function privateReply(id, text, idUser) {
	text = plain(text);
	if (!text) throw httpErr(400, "contact_center.comments.errors.text_required");
	const c = await getRow(id);
	if (c.private_replied) throw httpErr(409, "contact_center.comments.errors.private_once");
	if (Date.now() - new Date(c.date_add).getTime() > 7 * 86400000) throw httpErr(409, "contact_center.comments.errors.private_expired");
	const cred = await channelCred(c.id_channel);
	try {
		const url = c.network === "instagram" ? `${API.instagram}/me/messages` : `${API.facebook}/${cred.owner}/messages`;
		await axios.post(url, { recipient: { comment_id: c.external_id }, message: { text } }, { params: { access_token: cred.token }, timeout: 30000 });
	} catch (e) {
		throw httpErr(400, "contact_center.comments.errors.api", { error: graphMessage(e) });
	}
	await pool.query(`UPDATE ${T} SET private_replied = 1, status = IF(status = 'new', 'answered', status), id_user_action = ?, date_action = NOW() WHERE id = ?`, [idUser || null, id]);
}

/** Позначити опрацьованим без відповіді (або повернути в нові) */
async function setStatus(id, status, idUser) {
	if (!["new", "answered"].includes(status)) throw httpErr(400, "contact_center.comments.errors.bad_status");
	await getRow(id);
	await pool.query(`UPDATE ${T} SET status = ?, id_user_action = ?, date_action = NOW() WHERE id = ? AND status <> 'deleted'`, [status, idUser || null, id]);
}

async function channels() {
	const [rows] = await pool.query(`SELECT id, type, name FROM ${T_CH} WHERE deleted = 0 AND type IN ('instagram','facebook') ORDER BY type, name`);
	return rows;
}

module.exports = { onInstagramChange, onFacebookChange, sync, syncTick, list, countNew, reply, setHidden, remove, privateReply, setStatus, channels };