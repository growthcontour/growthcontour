/**
 * Акаунти для публікацій: Instagram, Facebook-сторінка, Telegram-канал, Viber-канал.
 *
 * Токен береться:
 *  - з каналу контакт-центру (id_channel) — Instagram, Facebook, Telegram-бот;
 *  - або зберігається в акаунті (власний Telegram-бот, токен Viber-каналу).
 */
const axios = require("axios");
const pool = require("../../../config/database/connection_pool");
const cryptoHelper = require("../../../helpers/crypto");
const { P, httpErr, apiError, NETWORKS } = require("./social");

const T = P + "social_accounts";
const IG = "https://graph.instagram.com/v23.0";
const FB = "https://graph.facebook.com/v23.0";

// Дозволи, потрібні для кожної мережі (показуються на сторінці акаунтів)
const PERMISSIONS = {
	instagram: [
		{ scope: "instagram_business_basic", use: "basic" },
		{ scope: "instagram_business_content_publish", use: "publish" },
		{ scope: "instagram_business_manage_comments", use: "comments" },
		{ scope: "instagram_business_manage_insights", use: "stats" },
		{ scope: "instagram_business_manage_messages", use: "messages" },
	],
	facebook: [
		{ scope: "pages_show_list", use: "basic" },
		{ scope: "pages_read_engagement", use: "basic" },
		{ scope: "pages_manage_posts", use: "publish" },
		{ scope: "pages_read_user_content", use: "comments" },
		{ scope: "pages_manage_engagement", use: "comments" },
		{ scope: "read_insights", use: "stats" },
		{ scope: "pages_messaging", use: "messages" },
	],
	telegram: [
		{ scope: "can_post_messages", use: "publish" },
		{ scope: "can_edit_messages", use: "edit" },
		{ scope: "can_delete_messages", use: "delete" },
	],
	viber: [{ scope: "superadmin", use: "publish" }],
};

// Таблиця каналу контакт-центру для кожної мережі (Viber у контакт-центрі не канал — лише власний токен)
const CC_TABLE = { instagram: "contact_center_channel_instagram", facebook: "contact_center_channel_facebook", telegram: "contact_center_channel_telegram" };

const pub = (r) => ({
	id: r.id,
	network: r.network,
	name: r.name,
	id_channel: r.id_channel,
	channel_name: r.channel_name || null,
	has_token: !!r.token_cipher,
	target: r.target,
	external_id: r.external_id,
	external_name: r.external_name,
	external_username: r.external_username,
	external_picture: r.external_picture,
	scopes: r.scopes ? String(r.scopes).split(",").filter(Boolean) : null,
	status: Number(r.status),
	last_check: r.last_check,
	last_error: r.last_error,
});

async function list() {
	const [rows] = await pool.query(
		`SELECT a.*, ch.name AS channel_name FROM ${T} a
		   LEFT JOIN ${P}contact_center_channels ch ON ch.id = a.id_channel
		  WHERE a.deleted = 0 ORDER BY a.network, a.name`
	);
	return rows.map(pub);
}

async function getRow(id) {
	const [[r]] = await pool.query(`SELECT * FROM ${T} WHERE id = ? AND deleted = 0`, [id]);
	if (!r) throw httpErr(404, "contact_center.social.errors.account_not_found");
	return r;
}

/** Канали контакт-центру, з яких можна взяти токен */
async function channelsFor() {
	const [rows] = await pool.query(`SELECT id, type, name FROM ${P}contact_center_channels WHERE deleted = 0 AND type IN ('instagram','facebook','telegram') ORDER BY type, name`);
	return rows;
}

async function save(id, b, idUser) {
	const network = String(b.network || "");
	if (!NETWORKS.includes(network)) throw httpErr(400, "contact_center.social.errors.bad_network");
	const name = String(b.name || "").trim().slice(0, 255);
	if (!name) throw httpErr(400, "contact_center.social.errors.name_required");

	const idChannel = parseInt(b.id_channel, 10) || null;
	const token = String(b.token || "").trim();
	let target = String(b.target || "").trim() || null;

	if (idChannel && !CC_TABLE[network]) throw httpErr(400, "contact_center.social.errors.bad_network");
	if (idChannel) {
		const [[ch]] = await pool.query(`SELECT type FROM ${P}contact_center_channels WHERE id = ? AND deleted = 0`, [idChannel]);
		if (!ch || ch.type !== network) throw httpErr(400, "contact_center.social.errors.channel_mismatch");
	}
	if (network === "telegram" && !target) throw httpErr(400, "contact_center.social.errors.target_required");
	if (network === "telegram" && !/^(@[A-Za-z0-9_]{4,}|-?\d{5,})$/.test(target)) throw httpErr(400, "contact_center.social.errors.target_bad");
	if (network === "viber") target = null;

	let row = null;
	if (id) row = await getRow(id);
	const hasToken = token || (row && row.token_cipher && !idChannel);
	if (!idChannel && !hasToken) throw httpErr(400, "contact_center.social.errors.token_required");

	const enc = token ? cryptoHelper.encrypt(token) : null;
	if (id) {
		// Токен: канал контакт-центру → власний токен не потрібен; новий токен → замінити; порожньо → залишити
		const tokenSql = idChannel ? ", token_cipher = NULL, token_iv = NULL, token_tag = NULL" : enc ? ", token_cipher = ?, token_iv = ?, token_tag = ?" : "";
		const status = b.status === false || b.status === 0 || b.status === "0" ? 0 : 1;
		await pool.query(`UPDATE ${T} SET network = ?, name = ?, id_channel = ?, target = ?, status = ?${tokenSql} WHERE id = ?`, [
			network, name, idChannel, target, status, ...(!idChannel && enc ? [enc.cipher, enc.iv, enc.tag] : []), id,
		]);
	} else {
		const [r] = await pool.query(`INSERT INTO ${T} (network, name, id_channel, target, token_cipher, token_iv, token_tag, id_user) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
			network,
			name,
			idChannel,
			target,
			enc && enc.cipher,
			enc && enc.iv,
			enc && enc.tag,
			idUser || null,
		]);
		id = r.insertId;
	}
	// Одразу перевіряємо підключення — результат видно в списку
	const check = await checkAccount(id);
	return { id, check };
}

async function remove(id) {
	await getRow(id);
	await pool.query(`UPDATE ${T} SET deleted = 1, status = 0 WHERE id = ?`, [id]);
}

/**
 * Дані для запитів до мережі: токен, ціль, додаткові поля каналу.
 * { network, token, target, ig_user_id?, page_id?, app_id?, app_secret? }
 */
async function credentials(idAccount) {
	const r = await getRow(idAccount);
	const c = { id: r.id, network: r.network, name: r.name, target: r.target, external_id: r.external_id, external_username: r.external_username, token: null };

	if (r.id_channel && CC_TABLE[r.network]) {
		const tbl = P + CC_TABLE[r.network];
		const extra = { instagram: ", ig_user_id", facebook: ", page_id, app_id, app_secret_cipher, app_secret_iv, app_secret_tag", telegram: "" }[r.network];
		const [[ch]] = await pool.query(`SELECT token_cipher, token_iv, token_tag${extra} FROM ${tbl} WHERE id_channel = ? LIMIT 1`, [r.id_channel]);
		if (ch) {
			c.token = cryptoHelper.decrypt(ch.token_cipher, ch.token_iv, ch.token_tag);
			if (ch.ig_user_id) c.ig_user_id = String(ch.ig_user_id);
			if (ch.page_id) c.page_id = String(ch.page_id);
			if (ch.app_id) c.app_id = String(ch.app_id);
			if (ch.app_secret_cipher) c.app_secret = cryptoHelper.decrypt(ch.app_secret_cipher, ch.app_secret_iv, ch.app_secret_tag);
		}
	} else {
		c.token = cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag);
	}
	// Власний токен (без каналу) — ID акаунта / сторінки беремо з останньої перевірки
	if (r.network === "instagram" && !c.ig_user_id) c.ig_user_id = r.external_id;
	if (r.network === "facebook" && !c.page_id) c.page_id = r.external_id;
	if (!c.token) throw httpErr(400, "contact_center.social.errors.token_missing");
	return c;
}

/**
 * Перевірка акаунта: хто це (назва, фото), які дозволи надано.
 * Результат пишеться в акаунт і повертається.
 */
async function checkAccount(id) {
	let info = { external_id: null, external_name: null, external_username: null, external_picture: null, scopes: null };
	let error = null;
	try {
		const c = await credentials(id);
		info = await ({ instagram: checkInstagram, facebook: checkFacebook, telegram: checkTelegram, viber: checkViber }[c.network])(c);
	} catch (e) {
		error = e.status ? e.message : apiError(e).message;
	}
	await pool.query(
		`UPDATE ${T} SET external_id = COALESCE(?, external_id), external_name = COALESCE(?, external_name), external_username = COALESCE(?, external_username),
		        external_picture = COALESCE(?, external_picture), scopes = ?, last_check = NOW(), last_error = ? WHERE id = ?`,
		[info.external_id, info.external_name, info.external_username, info.external_picture, info.scopes ? info.scopes.join(",") : null, error, id]
	);
	return { ok: !error, error, ...info };
}

async function checkInstagram(c) {
	const d = (await axios.get(`${IG}/me`, { params: { fields: "user_id,username,name,profile_picture_url", access_token: c.token }, timeout: 15000 })).data;
	// Instagram Login не віддає список дозволів токена — перевіряємо доступ до публікацій запитом ліміту
	const scopes = ["instagram_business_basic"];
	try {
		await axios.get(`${IG}/${d.user_id || d.id}/content_publishing_limit`, { params: { fields: "quota_usage", access_token: c.token }, timeout: 15000 });
		scopes.push("instagram_business_content_publish");
	} catch (e) {
		// немає дозволу на публікацію
	}
	return { external_id: String(d.user_id || d.id), external_name: d.name || d.username, external_username: d.username || null, external_picture: d.profile_picture_url || null, scopes };
}

async function checkFacebook(c) {
	const d = (await axios.get(`${FB}/me`, { params: { fields: "id,name,username,picture{url}", access_token: c.token }, timeout: 15000 })).data;
	let scopes = null;
	// Список дозволів токена — лише з токеном додатку (App ID + App Secret з каналу Facebook)
	if (c.app_id && c.app_secret) {
		try {
			const dt = (await axios.get(`${FB}/debug_token`, { params: { input_token: c.token, access_token: c.app_id + "|" + c.app_secret }, timeout: 15000 })).data;
			scopes = (dt && dt.data && dt.data.scopes) || null;
		} catch (e) {
			// без списку дозволів
		}
	}
	return { external_id: String(d.id), external_name: d.name, external_username: d.username || null, external_picture: d.picture && d.picture.data ? d.picture.data.url : null, scopes };
}

async function checkTelegram(c) {
	const api = (m, params) => axios.get(`https://api.telegram.org/bot${c.token}/${m}`, { params, timeout: 15000 }).then((r) => r.data.result);
	const me = await api("getMe");
	const chat = await api("getChat", { chat_id: c.target });
	const member = await api("getChatMember", { chat_id: c.target, user_id: me.id });
	if (member.status !== "administrator" && member.status !== "creator") throw httpErr(400, "contact_center.social.errors.tg_not_admin");
	const scopes = ["can_post_messages", "can_edit_messages", "can_delete_messages"].filter((k) => member.status === "creator" || member[k]);
	return { external_id: String(chat.id), external_name: chat.title || chat.username, external_username: chat.username || null, external_picture: null, scopes };
}

async function checkViber(c) {
	const d = (await axios.post("https://chatapi.viber.com/pa/get_account_info", {}, { headers: { "X-Viber-Auth-Token": c.token }, timeout: 15000 })).data;
	if (Number(d.status) !== 0) throw Object.assign(new Error(d.status_message || "Viber error"), { status: 400 });
	const admin = (d.members || []).find((m) => m.role === "superadmin");
	if (!admin) throw httpErr(400, "contact_center.social.errors.viber_no_superadmin");
	// Відправник постів — суперадмін каналу
	await pool.query(`UPDATE ${T} SET target = ? WHERE id = ?`, [admin.id, c.id]);
	return { external_id: String(d.id), external_name: d.name, external_username: d.uri || null, external_picture: d.icon || null, scopes: ["superadmin"] };
}

module.exports = { PERMISSIONS, list, getRow, channelsFor, save, remove, credentials, checkAccount };