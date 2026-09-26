const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, ".env");

// ─────────────────────────────────────────────────────────────
//  BLOCK DEFINITIONS
//  Each block: { title, header (multiline comment), fields: [] }
//  Field: { key, value | gen, comment }
// ─────────────────────────────────────────────────────────────

// VAPID keypair for Web Push — generated once per run, shared by both fields.
let _vapidPair = null;
function vapidPair() {
	if (_vapidPair) return _vapidPair;
	const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const jwk = privateKey.export({ format: "jwk" });
	const pub = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
	_vapidPair = { publicKey: pub, privateKey: jwk.d };
	return _vapidPair;
}

const BLOCKS = [
	{
		title: "SYSTEM SECRETS (auto-generated, DO NOT TOUCH)",
		header: ["Loss or change = all users logged out, 2FA breaks,", "encrypted tokens become unreadable."],
		fields: [
			{ key: "JWT_SECRET", gen: () => crypto.randomBytes(64).toString("hex"), comment: "Access-JWT signing key. Change = everyone logged out." },
			{ key: "JWT_REFRESH_SECRET", gen: () => crypto.randomBytes(64).toString("hex"), comment: "Refresh-JWT signing key. Separate from access." },
			{ key: "TFA_ENC_KEY", gen: () => crypto.randomBytes(32).toString("hex"), comment: "Encryption of 2FA secrets in DB (32 bytes hex)." },
			{ key: "APP_ENCRYPTION_KEY", gen: () => crypto.randomBytes(32).toString("hex"), comment: "Encryption of integration tokens in DB." },
			{ key: "WEBCHAT_FILE_SECRET", gen: () => crypto.randomBytes(48).toString("hex"), comment: "Signing of web-chat file links." },
			{ key: "SESSION_SECRET", gen: () => crypto.randomBytes(48).toString("hex"), comment: "Server session signing (express-session)." },
		],
	},

	{
		title: "SERVER",
		header: ["General application server settings."],
		fields: [
			{ key: "NODE_ENV", value: "production", comment: "Mode: production or development" },
			{ key: "PORT", value: "3000", comment: "Port the app listens on" },
			{ key: "APP_URL", value: "", comment: "Public URL of the system" },
			{ key: "CORS_ORIGINS", value: "", comment: "Allowed CORS origins, comma-separated" },
		],
	},

	{
		title: "DATABASE",
		header: ["MySQL connection credentials."],
		fields: [
			{ key: "DB_HOST", value: "127.0.0.1", comment: "MySQL host (or unix socket path, e.g. /var/run/mysqld/mysqld.sock)" },
			{ key: "DB_PORT", value: "3306", comment: "MySQL port" },
			{ key: "DB_USER", value: "", comment: "MySQL user" },
			{ key: "DB_PASSWORD", value: "", comment: "MySQL password" },
			{ key: "DB_NAME", value: "", comment: "MySQL database name" },
			{ key: "DB_PREFIX", value: "gc_", comment: "Table prefix" },
		],
	},

	{
		title: "ACCESS / INVITATIONS",
		header: ["Lifetime of invitation and password-reset links."],
		fields: [
			{ key: "INVITE_TTL_HOURS", value: "72", comment: "Invitation link TTL, hours" },
			{ key: "RESET_TTL_MINUTES", value: "30", comment: "Password reset link TTL, minutes" },
		],
	},

	{
		title: "TELEGRAM",
		header: ["Encryption key for bot tokens (NOT a bot token itself).", "Actual bot tokens are entered in the admin panel and encrypted with this key."],
		fields: [{ key: "TELEGRAM_TOKEN_KEY", gen: () => crypto.randomBytes(32).toString("hex"), comment: "Bot token encryption key." }],
	},

	{
		title: "INSTAGRAM (Meta App level, shared across accounts)",
		header: ["Meta App credentials used for Instagram integration."],
		fields: [
			{ key: "IG_APP_ID", value: "", comment: "Meta App ID" },
			{ key: "IG_APP_SECRET", value: "", comment: "Meta App Secret" },
			{ key: "IG_REDIRECT_URI", value: "", comment: "OAuth redirect URI" },
			{ key: "IG_VERIFY_TOKEN", value: "", comment: "Webhook verify token" },
			{ key: "IG_GRAPH_VERSION", value: "v21.0", comment: "Graph API version" },
			{ key: "IG_PUBLIC_BASE", value: "", comment: "Public base URL for IG assets" },
		],
	},

	{
		title: "MAIL (SMTP)",
		header: ["Outgoing mail server settings."],
		fields: [
			{ key: "MAIL_HOST", value: "", comment: "SMTP server, e.g. smtp.gmail.com" },
			{ key: "MAIL_PORT", value: "587", comment: "SMTP port (587 or 465)" },
			{ key: "MAIL_USER", value: "", comment: "SMTP login (email)" },
			{ key: "MAIL_PASS", value: "", comment: "SMTP password or app-password" },
			{ key: "MAIL_FROM", value: "", comment: "From address" },
		],
	},

	{
		title: "WEB PUSH (VAPID)",
		header: ["Browser push notifications for managers.", "Public/Private are one EC P-256 keypair — regenerate BOTH together or neither."],
		fields: [
			{ key: "VAPID_PUBLIC_KEY", gen: () => vapidPair().publicKey, comment: "VAPID public key (used by browser as applicationServerKey)." },
			{ key: "VAPID_PRIVATE_KEY", gen: () => vapidPair().privateKey, comment: "VAPID private key. Keep secret." },
			{ key: "VAPID_SUBJECT", value: "mailto:support@growthcontour.com", comment: "Contact URI for push service (mailto: or https:)." },
		],
	},
];

const HEADER_LINE = "# ═══════════════════════════════════════════════════════";
const SUB_LINE = "# ───";

// ─────────────────────────────────────────────────────────────

function parseExistingKeys() {
	if (!fs.existsSync(ENV_PATH)) return new Set();
	const text = fs.readFileSync(ENV_PATH, "utf8");
	const keys = new Set();
	for (const line of text.split("\n")) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
		if (m) keys.add(m[1]);
	}
	return keys;
}

function renderBlock(block, existing) {
	const lines = [];
	lines.push(SUB_LINE + " " + block.title.toUpperCase() + " " + SUB_LINE.replace(/─/g, "─"));
	// Build a proper separator line matching the title width
	const sep = "# " + "─".repeat(Math.max(4, 56 - block.title.length)) + " " + block.title.toUpperCase();
	lines.length = 0;
	lines.push(`# ─── ${block.title.toUpperCase()} ${"─".repeat(Math.max(2, 50 - block.title.length))}`);

	if (block.header && block.header.length) {
		for (const h of block.header) lines.push("# " + h);
	}

	for (const f of block.fields) {
		if (existing.has(f.key)) continue;
		lines.push("");
		if (f.comment) lines.push("# " + f.comment);
		const val = f.gen ? f.gen() : (f.value ?? "");
		lines.push(`${f.key}=${val}`);
	}
	return lines.join("\n");
}

function renderFullFile() {
	const out = [];
	out.push(HEADER_LINE);
	out.push("#  GROWTH CONTOUR — all system credentials live in this file");
	out.push(HEADER_LINE);
	out.push("");
	out.push("# This file is auto-generated. Missing fields will be appended on next run.");
	out.push("# Existing values are never overwritten.");
	out.push("");

	for (const block of BLOCKS) {
		out.push(renderBlock(block, new Set()));
		out.push("");
	}
	return (
		out
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trimEnd() + "\n"
	);
}

function ensureEnv() {
	const exists = fs.existsSync(ENV_PATH);
	const existing = parseExistingKeys();

	if (!exists) {
		fs.writeFileSync(ENV_PATH, renderFullFile(), { mode: 0o600 });
		fs.chmodSync(ENV_PATH, 0o600);
		console.log("[env] created full .env");
		process.loadEnvFile(ENV_PATH);
		return;
	}

	// Incremental: append only missing fields, grouped by block
	const chunks = [];
	for (const block of BLOCKS) {
		const missing = block.fields.filter((f) => !existing.has(f.key));
		if (!missing.length) continue;
		const sub = { ...block, fields: missing };
		chunks.push(renderBlock(sub, existing));
	}

	if (chunks.length) {
		const text = "\n\n" + chunks.join("\n\n") + "\n";
		fs.appendFileSync(ENV_PATH, text, { mode: 0o600 });
		fs.chmodSync(ENV_PATH, 0o600);
		console.log(`[env] appended missing fields`);
	} else {
		console.log("[env] all fields present");
	}

	process.loadEnvFile(ENV_PATH);
}

module.exports = { ensureEnv };
if (require.main === module) ensureEnv();
