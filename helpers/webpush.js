const webpush = require("web-push");

const PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

let ready = false;
if (PUBLIC && PRIVATE) {
	webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);
	ready = true;
}

module.exports = {
	ready: ready,
	publicKey: PUBLIC,

	// sub = { endpoint, keys: { p256dh, auth } }
	// Повертає { ok:true } | { ok:false, gone:true } (підписка мертва) | { ok:false, error }
	async send(sub, payload) {
		try {
			await webpush.sendNotification(sub, JSON.stringify(payload));
			return { ok: true };
		} catch (e) {
			const code = e.statusCode;
			if (code === 404 || code === 410) return { ok: false, gone: true };
			return { ok: false, error: e.message };
		}
	},
};