"use strict";
const crypto = require("crypto");

const config = require("../config/config");
const tfaConfig = config.get("configTFA");

// enc_key = 64 hex-символи (32 байти). Згенерувати:
// node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const KEY_HEX = tfaConfig.tfa.enc_key || "";
const KEY = Buffer.from(KEY_HEX, "hex");

if (KEY.length !== 32) {
	throw new Error("[tfa] enc_key must be 32 bytes (64 hex chars)");
}

function encryptSecret(plain) {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
	const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

function decryptSecret(payload) {
	if (!payload) return null;
	const parts = String(payload).split(".");
	if (parts.length !== 4 || parts[0] !== "v1") return null;
	try {
		const iv = Buffer.from(parts[1], "base64url");
		const tag = Buffer.from(parts[2], "base64url");
		const enc = Buffer.from(parts[3], "base64url");
		const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
		d.setAuthTag(tag);
		return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
	} catch {
		return null;
	}
}

module.exports = { encryptSecret, decryptSecret };
