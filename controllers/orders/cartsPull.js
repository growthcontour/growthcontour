"use strict";

/**
 * Запуск обміну покинутими кошиками на сайтах PrestaShop (кожні 10 хвилин).
 * Система сама викликає дію модуля carts.run — на сайті cron не потрібен.
 * Беруться активні інтеграції PrestaShop з адресою API, у яких є чинний ключ із правом «кошики».
 * Помилка одного сайту не зупиняє інші.
 */
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const client = require("../catalog/products/sync-client");

const P = config.get("configDatabase").prefix;

let running = false;

async function tick() {
	if (running) return [];
	running = true;
	try {
		const [rows] = await pool.query(
			`SELECT i.id, i.name, i.callback_url, i.outbound_token
			   FROM ${P}settings_integrations i
			  WHERE i.status = 'active' AND i.platform = 'prestashop'
			    AND i.callback_url IS NOT NULL AND i.callback_url <> ''
			    AND EXISTS (SELECT 1 FROM ${P}settings_integrations_tokens t
			                 WHERE t.id_integration = i.id AND t.can_sync_carts = 1 AND t.status = 'active'
			                   AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > NOW()))`
		);
		const out = [];
		for (const integ of rows) {
			try {
				const r = await client.call(integ, "carts.run", {});
				const s = r.summary || {};
				if (s.sent || s.closed || s.recovered || s.failed) out.push({ id: integ.id, ...s });
			} catch (e) {
				out.push({ id: integ.id, error: String(e.message).slice(0, 200) });
			}
		}
		return out;
	} finally {
		running = false;
	}
}

module.exports = { tick };
