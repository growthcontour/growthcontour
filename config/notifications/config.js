const config = require("../config");

module.exports = {
	prefix: config.get("configDatabase").prefix,

	// 'sync' — тільки MySQL, доставка інлайн (дефолт, працює будь-де)
	// 'bull' — BullMQ поверх Redis (масштаб)
	driver: process.env.NOTIFY_DRIVER || "sync",

	fanoutThreshold: Number(process.env.NOTIFY_FANOUT_THRESHOLD || 5000),
	channels: ["inapp", "telegram", "email", "webpush"],
	defaultTTLdays: 90,

	redis: {
		host: process.env.REDIS_HOST || "127.0.0.1",
		port: Number(process.env.REDIS_PORT || 6379),
		password: process.env.REDIS_PASSWORD || undefined,
		db: Number(process.env.REDIS_DB || 0),
	},

	// Ліміти зовнішніх API (per-channel). Telegram ~30/сек глобально, ~1/сек на чат.
	limits: {
		telegram: { max: 25, duration: 1000 }, // трохи нижче 30 для запасу
		email: { max: Number(process.env.MAIL_RATE_MAX || 10), duration: 1000 },
		webpush: { max: Number(process.env.WEBPUSH_RATE_MAX || 100), duration: 1000 },
	},
	// Ретраї
	retry: {
		attempts: 5,
		backoffMs: 3000, // експоненційний: 3s, 6s, 12s...
	},

	// Куди в UI падає подія за її типом. Ключ = event_type (або префікс до крапки).
	// Значення = id вкладки в offcanvas (chat|profile|personal|system).
	tabByType: {
		// Контакт-центр: обидва типи (new_conversation, new_message)
		// ловляться префіксом до крапки
		contact_center: "chat",
		"telegram.msg": "chat",
		"webchat.msg": "chat",
		profile: "profile",
		reminder: "personal", // нагадування про подію → Особисті
		personal: "personal",
		system: "system",
	},
	defaultTab: "personal",

	// Fallback-полер outbox (події, що не потрапили в чергу)
	outboxPollMs: Number(process.env.NOTIFY_OUTBOX_POLL_MS || 15000),
};
