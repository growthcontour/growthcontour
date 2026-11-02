/**
 * Viber-канал (Channels Post API: https://chatapi.viber.com/pa/post).
 * Відправник — суперадмін каналу (визначається при перевірці акаунта).
 *
 *  лише текст → type: text;
 *  фото       → type: picture (зменшене до 1600 px, щоб вкластися в 1 МБ), підпис до 768 символів;
 *  відео      → type: video (до 200 МБ, потрібен розмір файлу).
 * Альбомів у Viber немає: кожне медіа — окремий пост, текст — підписом першого або окремим постом.
 */
const axios = require("axios");
const { t, PublishError, apiError } = require("./social");

const CAPTION_MAX = 768;

async function publish(cred, job) {
	if (job.format !== "post") throw new PublishError(t("contact_center.social.errors.format_unsupported", { format: job.format, network: "Viber" }), false);
	if (!cred.target) throw new PublishError(t("contact_center.social.errors.viber_not_checked"), false);

	const send = async (body) => {
		const d = (await axios.post("https://chatapi.viber.com/pa/post", { from: cred.target, ...body }, { headers: { "X-Viber-Auth-Token": cred.token }, timeout: 60000 })).data;
		if (Number(d.status) !== 0) throw new PublishError("Viber: " + (d.status_message || "status " + d.status), [5, 6, 12].includes(Number(d.status)));
		return String(d.message_token);
	};

	const text = job.text || "";
	const m = job.media;
	try {
		if (!m.length) {
			if (!text.trim()) throw new PublishError(t("contact_center.social.errors.text_or_media"), false);
			return { done: true, external_id: await send({ type: "text", text }) };
		}

		const captionFits = text.length <= CAPTION_MAX;
		let first = null;
		for (let i = 0; i < m.length; i++) {
			const x = m[i];
			const caption = i === 0 && captionFits && text ? text : undefined;
			let token;
			if (x.kind === "image") token = await send({ type: "picture", media: x.url_viber || x.url, text: caption || "" });
			else {
				if (x.size > 200 * 1024 * 1024) throw new PublishError(t("contact_center.social.errors.viber_video_size"), false);
				token = await send({ type: "video", media: x.url, size: Number(x.size) });
				if (caption) await send({ type: "text", text: caption });
			}
			if (!first) first = token;
		}
		if (!captionFits && text) await send({ type: "text", text });
		return { done: true, external_id: first };
	} catch (e) {
		if (e instanceof PublishError) throw e;
		throw apiError(e);
	}
}

module.exports = { publish };
