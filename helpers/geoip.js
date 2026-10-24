/**
 * helpers/geoip.js
 * Єдина точка геолокації IP. Код входу знає лише lookup(ip).
 * Зараз провайдера немає, тож функція повертає порожні значення.
 * Пізніше інтеграція (ip2location BIN / MaxMind / API) реєструє себе через setProvider().
 */
const net = require("net");

const EMPTY = Object.freeze({ country: "", city: "" });

// Провайдер: async (ip) => ({ country, city }) | null
let provider = null;

function setProvider(fn) {
	provider = typeof fn === "function" ? fn : null;
}

// Локальні, приватні й службові адреси не шукаємо
function isPublicIp(ip) {
	if (!ip || !net.isIP(ip)) return false;
	if (ip.startsWith("::ffff:")) ip = ip.slice(7);
	return !(
		/^(10\.|127\.|0\.|169\.254\.|192\.168\.)/.test(ip) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
		/^(::1$|fc|fd|fe80:)/i.test(ip)
	);
}

/** Завжди повертає { country, city }, ніколи не кидає помилок */
async function lookup(ip) {
	if (!provider || !isPublicIp(ip)) return EMPTY;
	try {
		const r = (await provider(ip.replace(/^::ffff:/, ""))) || {};
		return {
			country: String(r.country || "").toUpperCase().slice(0, 2),
			city: String(r.city || "").slice(0, 100),
		};
	} catch (err) {
		console.error("[GEOIP ERROR]:", err.message);
		return EMPTY;
	}
}

module.exports = { lookup, setProvider, isPublicIp };