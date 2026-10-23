const crypto = require("crypto");
const dns = require("dns").promises;
const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
const logging = require("../../logging/logging");

const P = configDatabase.prefix;

const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

// req.ip враховує "trust proxy" (server.js) — підроблений X-Forwarded-For не пройде
const getClientIp = (req) => {
	const ip = req.ip || req.socket?.remoteAddress || "";
	return ip.replace(/^::ffff:/, "") || null;
};

// "https://www.Shop.com/path" → "shop.com"
const normHost = (s) => {
	s = String(s || "")
		.trim()
		.toLowerCase();
	if (!s) return "";
	try {
		if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = "http://" + s;
		return new URL(s).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
};

const getRequestHost = (req) => normHost(req.headers["origin"] || req.headers["referer"] || "") || null;

// Домен → IP (кеш 5 хв). Сервер магазину не надсилає Origin, тож домен перевіряємо за IP з'єднання
const dnsCache = new Map();
const resolveHost = async (host) => {
	const c = dnsCache.get(host);
	if (c && c.exp > Date.now()) return c.ips;
	let ips = [];
	try {
		ips = (await dns.lookup(host, { all: true })).map((a) => a.address.replace(/^::ffff:/, ""));
	} catch {
		/* домен не резолвиться */
	}
	dnsCache.set(host, { ips, exp: Date.now() + 5 * 60 * 1000 });
	return ips;
};

// off | any | all
const checkSource = async (mode, host, ip, domains, ips) => {
	if (mode === "off") return { ok: true };
	domains = (Array.isArray(domains) ? domains : []).map(normHost).filter(Boolean);
	ips = (Array.isArray(ips) ? ips : []).map((s) => String(s).trim()).filter(Boolean);
	const dSet = domains.length > 0,
		iSet = ips.length > 0;
	if (!dSet && !iSet) return { ok: true };

	let dOk = null;
	if (dSet) {
		dOk = !!(host && domains.includes(host));
		if (!dOk && ip) {
			for (const d of domains) {
				if ((await resolveHost(d)).includes(ip)) {
					dOk = true;
					break;
				}
			}
		}
	}
	const iOk = iSet ? !!(ip && ips.includes(ip)) : null;

	// «Обов'язково IP і домен»: обидва списки мають бути заповнені
	if (mode === "all" && (!dSet || !iSet)) return { ok: false, reason: "source_incomplete" };

	if (mode === "all") {
		if (dSet && !dOk) return { ok: false, reason: "domain_denied" };
		if (iSet && !iOk) return { ok: false, reason: "ip_denied" };
		return { ok: true };
	}
	if (dOk === true || iOk === true) return { ok: true };
	return { ok: false, reason: dSet ? "domain_denied" : "ip_denied" };
};

// Запис спроби в settings_integrations_tokens_log + лічильники токена
const logAttempt = async (data) => {
	const d = {
		id_token: null,
		prefix: null,
		ip: null,
		domain: null,
		method: "POST",
		endpoint: null,
		user_agent: null,
		result: "rejected",
		reject_reason: null,
		http_status: null,
		id_order: null,
		external_id: null,
		message: null,
		...data,
	};
	try {
		await connection_pool.query(
			`INSERT INTO \`${P}settings_integrations_tokens_log\`
        (id_token, prefix, ip, domain, method, endpoint, user_agent,
         result, reject_reason, http_status, id_order, external_id, message, date_add)
       VALUES (?, ?, INET6_ATON(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
			[d.id_token, d.prefix, d.ip, d.domain, d.method, d.endpoint, d.user_agent, d.result, d.reject_reason, d.http_status, d.id_order, d.external_id, (d.message || "").slice(0, 999)]
		);
		if (d.id_token) {
			await connection_pool.query(d.result === "success" ? `UPDATE \`${P}settings_integrations_tokens\` SET usage_count = usage_count + 1, last_used_at = NOW(), last_used_ip = INET6_ATON(?), last_used_domain = ? WHERE id = ?` : `UPDATE \`${P}settings_integrations_tokens\` SET error_count = error_count + 1 WHERE id = ?`, d.result === "success" ? [d.ip, d.domain, d.id_token] : [d.id_token]);
		}
	} catch (e) {
		logging.error(e);
	}
};

// Фабрика middleware: verifyOrderToken('can_create_orders')
const verifyOrderToken = (requiredScope) => async (req, res, next) => {
	const ip = getClientIp(req);
	const host = getRequestHost(req);
	const ua = (req.headers["user-agent"] || "").slice(0, 512);
	const endpoint = req.originalUrl;
	const externalId = req.body?.source?.external_id != null ? String(req.body.source.external_id) : null;

	const reject = async (status, reason, id_token = null, prefix = null) => {
		await logAttempt({ id_token, prefix, ip, domain: host, endpoint, user_agent: ua, result: "rejected", reject_reason: reason, http_status: status, external_id: externalId, message: `rejected: ${reason}` });
		return res.status(status).json({ status: "error", reason });
	};

	try {
		const auth = req.headers["authorization"] || "";
		const m = auth.match(/^Bearer\s+(.+)$/i);
		const raw = m ? m[1].trim() : null;
		if (!raw) return reject(401, "bad_token");

		const prefix = raw.slice(0, 12);
		const [[t]] = await connection_pool.query(
			`SELECT id, id_integration, environment, allowed_domains, allowed_ips, source_check_mode,
          can_create_orders, can_update_orders, can_update_status, can_create_clients, can_read,
          can_sync_carts, can_set_rates, can_import_products,
          status, expires_at, revoked_at
   FROM \`${P}settings_integrations_tokens\` WHERE token_hash = ? LIMIT 1`,
			[hashToken(raw)]
		);

		if (!t) return reject(401, "bad_token", null, prefix);
		if (t.revoked_at) return reject(403, "revoked", t.id, prefix);
		if (t.status === "disabled") return reject(403, "disabled", t.id, prefix);
		if (t.expires_at && new Date(t.expires_at) < new Date()) return reject(403, "expired", t.id, prefix);

		const src = await checkSource(t.source_check_mode, host, ip, t.allowed_domains, t.allowed_ips);
		if (!src.ok) return reject(403, src.reason, t.id, prefix);

		if (requiredScope && t[requiredScope] !== 1) return reject(403, "no_scope", t.id, prefix);

		req.orderToken = t;
		req.orderTokenPrefix = prefix;
		req.clientIp = ip;
		req.sourceHost = host;
		next();
	} catch (e) {
		logging.error(e);
		return res.status(500).json({ status: "error", message: "Помилка сервера." });
	}
};

module.exports = { verifyOrderToken, logAttempt, getClientIp, getRequestHost };
