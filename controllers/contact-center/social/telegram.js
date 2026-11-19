/**
 * Telegram-канал через бота (бот — адміністратор каналу з правом публікації).
 *
 *  лише текст      → sendMessage (до 4096 символів);
 *  одне фото/відео → sendPhoto / sendVideo, підпис до 1024 символів;
 *  2–10 медіа      → sendMediaGroup (альбом), підпис на першому.
 * Довший за 1024 текст іде окремим повідомленням після медіа.
 * Сторіс і Reels для ботів немає: reel публікується як звичайне відео.
 */
const axios = require("axios");
const { t, PublishError, apiError } = require("./social");

const CAPTION_MAX = 1024;

async function publish(cred, job) {
	if (job.format === "story") throw new PublishError(t("contact_center.social.errors.format_unsupported", { format: "story", network: "Telegram" }), false);

	const call = (method, body) => axios.post(`https://api.telegram.org/bot${cred.token}/${method}`, body, { timeout: 120000 }).then((r) => r.data.result);
	const chat = cred.target;
	const text = job.text || "";
	const m = job.media;
	const captionFits = (job.plain !== undefined ? job.plain : text).length <= CAPTION_MAX;
	const caption = captionFits && text ? text : undefined;

	try {
		let first;
		if (!m.length) {
			if (!text.trim()) throw new PublishError(t("contact_center.social.errors.text_or_media"), false);
			first = await call("sendMessage", { chat_id: chat, text, parse_mode: "HTML" });
		} else if (m.length > 10) {
			throw new PublishError(t("contact_center.social.errors.tg_album_max"), false);
		} else if (m.length === 1) {
			const x = m[0];
			first = await call(x.kind === "image" ? "sendPhoto" : "sendVideo", { chat_id: chat, [x.kind === "image" ? "photo" : "video"]: x.url, caption, parse_mode: caption ? "HTML" : undefined, supports_streaming: x.kind === "video" ? true : undefined });
		} else {
			const media = m.map((x, i) => ({ type: x.kind === "image" ? "photo" : "video", media: x.url, caption: i === 0 ? caption : undefined, parse_mode: i === 0 && caption ? "HTML" : undefined }));
			first = (await call("sendMediaGroup", { chat_id: chat, media }))[0];
		}
		if (m.length && !captionFits && text) await call("sendMessage", { chat_id: chat, text, parse_mode: "HTML" });

		const msgId = String(first.message_id);
		const username = cred.external_username;
		return { done: true, external_id: msgId, permalink: username ? `https://t.me/${username}/${msgId}` : null };
	} catch (e) {
		if (e instanceof PublishError) throw e;
		throw apiError(e);
	}
}

module.exports = { publish };