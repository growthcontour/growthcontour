/**
 * Instagram (Instagram API with Instagram Login, graph.instagram.com).
 *
 * Публікація двоетапна:
 *   1) контейнер: POST /{ig}/media (image_url / video_url, media_type, caption);
 *   2) коли контейнер у статусі FINISHED — POST /{ig}/media_publish.
 * Відео обробляється на боці Meta хвилини, тому стан (ID контейнерів) зберігається в цілі,
 * а черга повертається до неї пізніше (результат { wait }).
 *
 * Формати: post (фото / карусель до 10; відео в стрічку — це Reels), reel, story.
 */
const axios = require("axios");
const { t, PublishError, apiError } = require("./social");

const API = "https://graph.instagram.com/v23.0";
const WAIT_SEC = 20; // як часто перевіряти обробку відео
const MAX_WAIT_MIN = 30; // скільки максимум чекати обробку

const get = (url, params) => axios.get(API + url, { params, timeout: 30000 }).then((r) => r.data);
const post = (url, params) => axios.post(API + url, null, { params, timeout: 60000 }).then((r) => r.data);

/** Перевірка медіа до звернення до Meta — зрозуміла помилка замість невиразної від API */
function validate(job) {
	const media = job.media;
	const images = media.filter((m) => m.kind === "image");
	const videos = media.filter((m) => m.kind === "video");

	if (!media.length) throw new PublishError(t("contact_center.social.errors.ig_media_required"), false);
	if (job.format === "post" && media.length > 10) throw new PublishError(t("contact_center.social.errors.ig_carousel_max"), false);
	if ((job.format === "reel" || job.format === "story") && media.length > 1) throw new PublishError(t("contact_center.social.errors.one_media", { format: job.format }), false);
	if (job.format === "reel" && !videos.length) throw new PublishError(t("contact_center.social.errors.ig_reel_video"), false);

	for (const m of images) {
		if (m.size > 8 * 1024 * 1024) throw new PublishError(t("contact_center.social.errors.ig_image_size"), false);
		// Стрічка: співвідношення сторін від 4:5 до 1.91:1
		if (job.format === "post" && m.width && m.height) {
			const r = m.width / m.height;
			if (r < 0.8 - 0.005 || r > 1.91 + 0.005) throw new PublishError(t("contact_center.social.errors.ig_aspect", { w: m.width, h: m.height }), false);
		}
	}
	for (const m of videos) if (m.size > 1024 * 1024 * 1024) throw new PublishError(t("contact_center.social.errors.ig_video_size"), false);
}

/** Створити контейнер для одного медіа */
async function container(cred, m, extra) {
	const params = { access_token: cred.token, ...extra };
	if (m.kind === "image") params.image_url = m.url;
	else {
		params.video_url = m.url;
		if (!params.media_type) params.media_type = "VIDEO";
	}
	const d = await post(`/${cred.ig_user_id}/media`, params);
	return String(d.id);
}

/** Стан контейнера: FINISHED / IN_PROGRESS / ERROR / EXPIRED / PUBLISHED */
async function containerStatus(cred, id) {
	const d = await get(`/${id}`, { fields: "status_code,status", access_token: cred.token });
	return { code: d.status_code, text: d.status || "" };
}

async function publish(cred, job) {
	if (!cred.ig_user_id) throw new PublishError(t("contact_center.social.errors.ig_not_checked"), false);
	const state = job.state || {};

	try {
		// ── 1. Контейнери (один раз) ──
		if (!state.container) {
			validate(job);

			// Добовий ліміт публікацій (100 / 24 год) — не витрачаємо спробу, якщо вичерпано
			try {
				const lim = await get(`/${cred.ig_user_id}/content_publishing_limit`, { fields: "quota_usage,config", access_token: cred.token });
				const row = lim && lim.data && lim.data[0];
				if (row && row.config && row.quota_usage >= row.config.quota_total) throw new PublishError(t("contact_center.social.errors.ig_quota"), true);
			} catch (e) {
				if (e instanceof PublishError) throw e;
			}

			const caption = job.format === "story" ? undefined : job.text || undefined;
			const m = job.media;

			if (job.format === "story") {
				state.container = await container(cred, m[0], { media_type: "STORIES" });
			} else if (job.format === "reel" || (m.length === 1 && m[0].kind === "video")) {
				// Відео в стрічку Instagram публікується лише як Reels
				state.container = await container(cred, m[0], { media_type: "REELS", caption, share_to_feed: true });
			} else if (m.length === 1) {
				state.container = await container(cred, m[0], { caption });
			} else {
				state.children = [];
				for (const x of m) state.children.push(await container(cred, x, { is_carousel_item: true }));
				state.container = await post(`/${cred.ig_user_id}/media`, { access_token: cred.token, media_type: "CAROUSEL", children: state.children.join(","), caption }).then((d) => String(d.id));
			}
			state.started = Date.now();
		}

		// ── 2. Чекаємо обробку (відео, карусель з відео) ──
		const ids = [...(state.children || []), state.container];
		for (const id of ids) {
			const s = await containerStatus(cred, id);
			if (s.code === "ERROR" || s.code === "EXPIRED") throw new PublishError(t("contact_center.social.errors.ig_container", { status: s.code, text: s.text }), false);
			if (s.code !== "FINISHED" && s.code !== "PUBLISHED") {
				if (Date.now() - state.started > MAX_WAIT_MIN * 60000) throw new PublishError(t("contact_center.social.errors.ig_timeout"), false);
				return { wait: WAIT_SEC, state };
			}
		}

		// ── 3. Публікація ──
		const pub = await post(`/${cred.ig_user_id}/media_publish`, { creation_id: state.container, access_token: cred.token });
		const mediaId = String(pub.id);
		let permalink = null;
		try {
			permalink = (await get(`/${mediaId}`, { fields: "permalink", access_token: cred.token })).permalink || null;
		} catch (e) {
			// посилання не критичне
		}
		return { done: true, external_id: mediaId, permalink, state };
	} catch (e) {
		if (e instanceof PublishError) throw Object.assign(e, { state });
		throw Object.assign(apiError(e), { state });
	}
}

module.exports = { publish };
