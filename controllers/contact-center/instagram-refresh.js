const axios = require("axios");
const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const cryptoHelper = require("../../helpers/crypto");

const P = config.get("configDatabase").prefix;
const TABLE = P + "contact_center_channel_instagram";
const CHANNELS = P + "contact_center_channels";

const GRAPH = "https://graph.instagram.com";

// Оновлюємо токен, якщо від останнього refresh минуло більше цієї межі.
// Токен живе 60 днів; 30 днів дає великий запас і не смикає API щодня даремно.
const REFRESH_AFTER_DAYS = 30;

/**
 * Оновлює один токен по id_channel. Повертає { ok, error, expires_in }.
 * Використовується і кроном, і кнопкою у формі.
 */
async function refreshOne(idChannel) {
	const [rows] = await connection_pool.query(`SELECT token_cipher, token_iv, token_tag, token_type FROM ${TABLE} WHERE id_channel = ? AND date_deleted IS NULL LIMIT 1`, [idChannel]);

	const r = rows[0];
	if (!r) return { ok: false, error: "Канал не знайдено" };

	const token = cryptoHelper.decrypt(r.token_cipher, r.token_iv, r.token_tag);
	if (!token) return { ok: false, error: "Токен не задано" };

	try {
		const response = await axios.get(`${GRAPH}/refresh_access_token`, {
			params: { grant_type: "ig_refresh_token", access_token: token },
			timeout: 15000,
		});

		const data = response.data || {};
		if (!data.access_token) return { ok: false, error: "Instagram не повернув новий токен" };

		const enc = cryptoHelper.encrypt(data.access_token);
		const expiresIn = Number(data.expires_in) || 0;

		await connection_pool.query(
			`UPDATE ${TABLE}
                SET token_cipher = ?, token_iv = ?, token_tag = ?,
                    token_type = 'long_lived',
                    date_token_refresh = NOW(),
                    date_token_expires = DATE_ADD(NOW(), INTERVAL ? SECOND)
              WHERE id_channel = ?`,
			[enc.cipher, enc.iv, enc.tag, expiresIn, idChannel]
		);

		return { ok: true, expires_in: expiresIn };
	} catch (e) {
		const msg = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
		return { ok: false, error: String(msg).slice(0, 500) };
	}
}

/**
 * Проходить по всіх активних каналах, чий токен пора оновити.
 * Викликається кроном раз на добу.
 */
async function refreshTokens() {
	try {
		const [rows] = await connection_pool.query(
			`SELECT ig.id_channel, ig.date_token_refresh
               FROM ${TABLE} AS ig
               INNER JOIN ${CHANNELS} AS ch ON ch.id = ig.id_channel
              WHERE ig.date_deleted IS NULL
                AND ch.deleted = 0
                AND ig.token_type = 'long_lived'
                AND (
                     ig.date_token_refresh IS NULL
                     OR ig.date_token_refresh < DATE_SUB(NOW(), INTERVAL ? DAY)
                    )`,
			[REFRESH_AFTER_DAYS]
		);

		if (!rows.length) {
			console.log("[ig-refresh] немає каналів для оновлення");
			return { total: 0, ok: 0, failed: 0 };
		}

		let ok = 0;
		let failed = 0;

		for (const row of rows) {
			// Токен молодший за 24 год Instagram відмовиться оновлювати —
			// але такі канали й не потраплять сюди (щойно створені мають свіжий refresh).
			const res = await refreshOne(row.id_channel);
			if (res.ok) {
				ok++;
				console.log("[ig-refresh] канал " + row.id_channel + " оновлено, дій ще " + Math.round((res.expires_in || 0) / 86400) + " днів");
			} else {
				failed++;
				console.warn("[ig-refresh] канал " + row.id_channel + " помилка: " + res.error);
			}
		}

		return { total: rows.length, ok: ok, failed: failed };
	} catch (error) {
		logging.error(error);
		return { total: 0, ok: 0, failed: 0, error: error.message };
	}
}

module.exports = { refreshTokens, refreshOne };