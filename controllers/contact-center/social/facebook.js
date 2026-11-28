/**
 * Facebook-сторінка (Graph API, токен сторінки).
 *
 *  post:  лише текст → /feed; одне фото → /photos; кілька фото → /photos (published=false) + /feed з attached_media;
 *         відео → /videos (file_url).
 *  reel:  відео → /videos (Facebook показує вертикальне відео як Reels).
 *  story: фото → /photos (published=false) + /photo_stories. Відео-сторіс через API потребують
 *         окремого завантаження частинами — поки не підтримуються.
 */
const axios = require("axios");
const { t, PublishError, apiError } = require("./social");

const API = "https://graph.facebook.com/v23.0";
const post = (url, params) => axios.post(API + url, null, { params, timeout: 120000 }).then((r) => r.data);
const get = (url, params) => axios.get(API + url, { params, timeout: 30000 }).then((r) => r.data);

async function permalinkOf(cred, id) {
	try {
		return (await get(`/${id}`, { fields: "permalink_url", access_token: cred.token })).permalink_url || null;
	} catch (e) {
		return null;
	}
}

async function publish(cred, job) {
	const page = cred.page_id || cred.external_id;
	if (!page) throw new PublishError(t("contact_center.social.errors.fb_not_checked"), false);
	const tk = cred.token;
	const m = job.media;
	const images = m.filter((x) => x.kind === "image");
	const videos = m.filter((x) => x.kind === "video");
	const text = job.text || "";

	try {
		let id;

		if (job.format === "story") {
			if (m.length !== 1) throw new PublishError(t("contact_center.social.errors.one_media", { format: "story" }), false);
			if (videos.length) throw new PublishError(t("contact_center.social.errors.fb_story_video"), false);
			const photo = await post(`/${page}/photos`, { url: images[0].url, published: false, access_token: tk });
			id = String((await post(`/${page}/photo_stories`, { photo_id: photo.id, access_token: tk })).post_id);
		} else if (videos.length) {
			if (m.length > 1) throw new PublishError(t("contact_center.social.errors.fb_video_mix"), false);
			const v = await post(`/${page}/videos`, { file_url: videos[0].url, description: text || undefined, access_token: tk });
			id = String(v.id);
		} else if (images.length === 1) {
			const p = await post(`/${page}/photos`, { url: images[0].url, caption: text || undefined, access_token: tk });
			id = String(p.post_id || p.id);
		} else if (images.length > 1) {
			if (images.length > 30) throw new PublishError(t("contact_center.social.errors.fb_photos_max"), false);
			const params = { message: text || undefined, access_token: tk };
			for (let i = 0; i < images.length; i++) {
				const p = await post(`/${page}/photos`, { url: images[i].url, published: false, access_token: tk });
				params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: p.id });
			}
			id = String((await post(`/${page}/feed`, params)).id);
		} else {
			if (!text.trim()) throw new PublishError(t("contact_center.social.errors.text_or_media"), false);
			id = String((await post(`/${page}/feed`, { message: text, access_token: tk })).id);
		}

		return { done: true, external_id: id, permalink: await permalinkOf(cred, id) };
	} catch (e) {
		if (e instanceof PublishError) throw e;
		throw apiError(e);
	}
}

module.exports = { publish };
