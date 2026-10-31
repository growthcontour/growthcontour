/**
 * Перший коментар під опублікованим постом.
 *
 *   Instagram — POST /{media-id}/comments (дозвіл instagram_business_manage_comments);
 *   Facebook  — POST /{post-id}/comments (дозвіл pages_manage_engagement);
 *   Telegram  — коментарі каналу живуть у прив'язаній групі обговорень. Telegram сам пересилає пост у групу
 *               (повідомлення з is_automatic_forward), і коментар — це відповідь на це пересилання.
 *               ID пересланого повідомлення приходить лише в оновленні бота, тому:
 *                 • бот із каналу контакт-центру — оновлення приходить у його вебхук (onTelegramUpdate);
 *                 • власний бот без вебхука — читаємо getUpdates у tick().
 *               Бот має бути учасником (краще адміністратором) групи обговорень.
 *   Viber     — API каналів коментарів не має; сторіс — без коментарів.
 *
 * Стан у цілі: comment_status none → pending → done | failed; comment_due — коли пробувати.
 */
const axios = require("axios");
const pool = require("../../../config/database/connection_pool");
const logging = require("../../../logging/logging");
const accounts = require("./accounts");
const log = require("./log");
const { P, t, apiError } = require("./social");

const T_TARGETS = P + "social_post_targets";
const T_POSTS = P + "social_posts";
const T_VARIANTS = P + "social_post_variants";
const T_ACC = P + "social_accounts";

const IG = "https://graph.instagram.com/v23.0";
const FB = "https://graph.facebook.com/v23.0";
const MAX_ATTEMPTS = 3;
const TG_WAIT_MIN = 10; // скільки чекати пересилання поста в групу обговорень

const tgApi = (token, method, body) => axios.post(`https://api.telegram.org/bot${token}/${method}`, body || {}, { timeout: 30000 }).then((r) => r.data.result);

/** Текст коментаря для цілі: окремий для мережі або спільний */
async function commentText(idPost, network) {
	const [[p]] = await pool.query(`SELECT first_comment FROM ${T_POSTS} WHERE id = ?`, [idPost]);
	const [[v]] = await pool.query(`SELECT first_comment FROM ${T_VARIANTS} WHERE id_post = ? AND network = ?`, [idPost, network]);
	const c = v && v.first_comment !== null ? v.first_comment : p && p.first_comment;
	return c && String(c).trim() ? String(c).trim() : null;
}

const parseState = (s) => {
	try {
		return s ? (typeof s === "string" ? JSON.parse(s) : s) : {};
	} catch (e) {
		return {};
	}
};

async function setState(id, state) {
	await pool.query(`UPDATE ${T_TARGETS} SET state = ? WHERE id = ?`, [JSON.stringify(state), id]);
}

async function fail(tg, message) {
	await pool.query(`UPDATE ${T_TARGETS} SET comment_status = 'failed', comment_error = ?, comment_due = NULL WHERE id = ?`, [String(message).slice(0, 1000), tg.id]);
	await log.add(null, { id_post: tg.id_post, id_target: tg.id, action: "comment_failed", note: message });
	logging.warn(`[social] перший коментар не додано: ціль #${tg.id}: ${message}`);
}

async function done(tg, commentId) {
	await pool.query(`UPDATE ${T_TARGETS} SET comment_status = 'done', comment_id = ?, comment_error = NULL, comment_due = NULL WHERE id = ?`, [commentId ? String(commentId) : null, tg.id]);
	await log.add(null, { id_post: tg.id_post, id_target: tg.id, action: "comment_done" });
}

/**
 * Після успішної публікації: поставити перший коментар у чергу (якщо він є і мережа його підтримує).
 * Telegram: одразу перевіряємо, чи в каналу є група обговорень.
 */
async function schedule(tg, cred) {
	const { COMMENT_NETWORKS, COMMENT_FORMATS } = require("./posts");
	if (!COMMENT_NETWORKS[cred.network] || !COMMENT_FORMATS.includes(tg.format)) return;
	if (!(await commentText(tg.id_post, cred.network))) return;

	if (cred.network === "telegram") {
		try {
			const chat = await tgApi(cred.token, "getChat", { chat_id: cred.target });
			if (!chat.linked_chat_id) return fail(tg, t("contact_center.social.errors.tg_no_discussion"));
			const state = parseState(tg.state);
			state.tg_group = chat.linked_chat_id;
			await setState(tg.id, state);
		} catch (e) {
			return fail(tg, apiError(e).message);
		}
	}
	// Instagram / Facebook — через кілька секунд (пост має з'явитися в API), Telegram — коли прийде пересилання
	await pool.query(`UPDATE ${T_TARGETS} SET comment_status = 'pending', comment_error = NULL, comment_due = NOW() + INTERVAL 10 SECOND WHERE id = ?`, [tg.id]);
}

/** Надіслати коментар для однієї цілі */
async function send(tg) {
	const cred = await accounts.credentials(tg.id_account);
	const text = await commentText(tg.id_post, cred.network);
	if (!text) return done(tg, null);
	const state = parseState(tg.state);

	if (cred.network === "instagram") {
		const d = (await axios.post(`${IG}/${tg.external_id}/comments`, null, { params: { message: text, access_token: cred.token }, timeout: 30000 })).data;
		return done(tg, d.id);
	}
	if (cred.network === "facebook") {
		const d = (await axios.post(`${FB}/${tg.external_id}/comments`, null, { params: { message: text, access_token: cred.token }, timeout: 30000 })).data;
		return done(tg, d.id);
	}
	if (cred.network === "telegram") {
		if (!state.tg_forward) {
			// Ще не знаємо ID пересланого повідомлення в групі — чекаємо
			if (Date.now() - new Date(tg.date_published).getTime() > TG_WAIT_MIN * 60000) return fail(tg, t("contact_center.social.errors.tg_no_forward"));
			await pool.query(`UPDATE ${T_TARGETS} SET comment_due = NOW() + INTERVAL 30 SECOND WHERE id = ?`, [tg.id]);
			return;
		}
		const m = await tgApi(cred.token, "sendMessage", { chat_id: state.tg_forward.chat_id, text, reply_parameters: { message_id: state.tg_forward.message_id } });
		return done(tg, m.message_id);
	}
}

/**
 * Оновлення Telegram (з вебхука контакт-центру або getUpdates власного бота):
 * пост каналу автоматично переслано в групу обговорень → запам'ятати ID і надіслати коментар.
 */
async function onTelegramUpdate(update) {
	const msg = update && update.message;
	if (!msg || !msg.is_automatic_forward) return false;
	const origin = msg.forward_origin || {};
	const channelId = origin.chat ? origin.chat.id : msg.sender_chat && msg.sender_chat.id;
	const postId = origin.message_id || msg.forward_from_message_id;
	if (!channelId || !postId) return false;

	const [rows] = await pool.query(
		`SELECT t.* FROM ${T_TARGETS} t JOIN ${T_ACC} a ON a.id = t.id_account
		  WHERE a.network = 'telegram' AND a.external_id = ? AND t.external_id = ? AND t.comment_status = 'pending' LIMIT 1`,
		[String(channelId), String(postId)]
	);
	if (!rows.length) return false;
	const tg = rows[0];
	const state = parseState(tg.state);
	state.tg_forward = { chat_id: msg.chat.id, message_id: msg.message_id };
	await pool.query(`UPDATE ${T_TARGETS} SET state = ?, comment_due = NOW() WHERE id = ?`, [JSON.stringify(state), tg.id]);
	setImmediate(() => tick().catch((e) => logging.error(e)));
	return true;
}

/** Власні Telegram-боти без вебхука: читаємо оновлення, щоб знайти пересилання постів у групу */
async function pollOwnTelegramBots() {
	const [accs] = await pool.query(
		`SELECT DISTINCT a.id, a.tg_update_offset FROM ${T_TARGETS} t JOIN ${T_ACC} a ON a.id = t.id_account
		  WHERE t.comment_status = 'pending' AND a.network = 'telegram' AND a.id_channel IS NULL AND a.deleted = 0`
	);
	for (const a of accs) {
		try {
			const cred = await accounts.credentials(a.id);
			const updates = await tgApi(cred.token, "getUpdates", { offset: a.tg_update_offset || undefined, timeout: 0, allowed_updates: ["message"] });
			let next = a.tg_update_offset;
			for (const u of updates) {
				await onTelegramUpdate(u);
				next = u.update_id + 1;
			}
			if (next !== a.tg_update_offset) await pool.query(`UPDATE ${T_ACC} SET tg_update_offset = ? WHERE id = ?`, [next, a.id]);
		} catch (e) {
			// 409 — у бота є вебхук (його оновлення читає інша система): коментар у групу неможливий
			const err = apiError(e);
			if (e.response && e.response.status === 409) {
				const [pend] = await pool.query(`SELECT t.* FROM ${T_TARGETS} t WHERE t.id_account = ? AND t.comment_status = 'pending'`, [a.id]);
				for (const tg of pend) await fail(tg, t("contact_center.social.errors.tg_webhook_busy"));
			} else logging.warn(`[social] getUpdates акаунта #${a.id}: ${err.message}`);
		}
	}
}

let running = false;

/** Викликається з черги публікацій щохвилини */
async function tick() {
	if (running) return;
	running = true;
	try {
		await pollOwnTelegramBots();
		const [rows] = await pool.query(`SELECT * FROM ${T_TARGETS} WHERE comment_status = 'pending' AND comment_due <= NOW() ORDER BY comment_due LIMIT 20`);
		for (const tg of rows) {
			try {
				await send(tg);
			} catch (e) {
				const err = e.status ? { message: t(e.message, e.params), temporary: false } : apiError(e);
				const state = parseState(tg.state);
				state.comment_attempts = (state.comment_attempts || 0) + 1;
				if (err.temporary && state.comment_attempts < MAX_ATTEMPTS) {
					await pool.query(`UPDATE ${T_TARGETS} SET state = ?, comment_due = NOW() + INTERVAL 5 MINUTE, comment_error = ? WHERE id = ?`, [JSON.stringify(state), err.message.slice(0, 1000), tg.id]);
				} else {
					await setState(tg.id, state);
					await fail(tg, err.message);
				}
			}
		}
	} finally {
		running = false;
	}
}

module.exports = { schedule, tick, onTelegramUpdate };