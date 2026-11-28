"use strict";

/**
 * Канали, де можна написати клієнту системи: контакти контакт-центру, прив'язані до картки клієнта.
 * Для кнопки «Написати клієнту» (картка замовлення та ін.): список каналів і відкриття діалогу —
 * наявний активний діалог або новий, без повідомлення клієнту (пише менеджер).
 */

const crypto = require("crypto");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const types = require("./channels/index");

const P = config.get("configDatabase").prefix;

/** Контакти клієнта в активних каналах + активний діалог (якщо є) */
async function forClient(idClient) {
	if (!(idClient > 0)) return [];
	const [rows] = await pool.query(
		`SELECT ct.id AS id_contact, ct.name, ct.first_name, ct.last_name, ct.username, ct.blocked,
		        ch.id AS id_channel, ch.type AS channel, ch.name AS channel_name,
		        (SELECT cv.url_token FROM ${P}contact_center_conversations cv
		          WHERE cv.id_contact = ct.id AND cv.date_resolved IS NULL AND cv.date_archived IS NULL ORDER BY cv.id DESC LIMIT 1) AS url_token,
		        (SELECT MAX(cv.date_last_message) FROM ${P}contact_center_conversations cv WHERE cv.id_contact = ct.id) AS last_at
		   FROM ${P}contact_center_contacts ct
		   JOIN ${P}contact_center_channels ch ON ch.id = ct.id_channel AND ch.deleted = 0 AND ch.status = 1
		  WHERE ct.id_client = ?
		  ORDER BY last_at IS NULL, last_at DESC, ct.id DESC LIMIT 20`,
		[idClient]
	);
	return rows.map((r) => {
		const meta = types.get(r.channel) || {};
		return {
			id_contact: Number(r.id_contact),
			channel: r.channel,
			channel_name: r.channel_name,
			icon: meta.icon || "fa-solid fa-comments",
			color: meta.color || "#6c757d",
			name: r.name || [r.first_name, r.last_name].filter(Boolean).join(" ") || (r.username ? "@" + r.username : ""),
			blocked: !!Number(r.blocked),
			url_token: r.url_token || null,
			last_at: r.last_at,
		};
	});
}

/**
 * Відкрити діалог з контактом: активний — він самий; інакше новий (у черзі контакт-центру).
 * Клієнт має належати картці (idClient) — щоб не відкрити чужий контакт за підставленим id.
 */
async function open(idContact, idClient) {
	const [[ct]] = await pool.query(
		`SELECT ct.id, ct.id_channel, ct.external_id FROM ${P}contact_center_contacts ct
		   JOIN ${P}contact_center_channels ch ON ch.id = ct.id_channel AND ch.deleted = 0 AND ch.status = 1
		  WHERE ct.id = ? AND ct.id_client = ?`,
		[idContact, idClient]
	);
	if (!ct) return null;
	const [[cv]] = await pool.query(
		`SELECT url_token FROM ${P}contact_center_conversations WHERE id_contact = ? AND date_resolved IS NULL AND date_archived IS NULL ORDER BY id DESC LIMIT 1`,
		[ct.id]
	);
	if (cv) return cv.url_token;
	// Останній закритий діалог з потоком (source_thread_id) — новий діалог у тому ж потоці
	const [[last]] = await pool.query(`SELECT source_thread_id FROM ${P}contact_center_conversations WHERE id_contact = ? ORDER BY id DESC LIMIT 1`, [ct.id]);
	const token = crypto.randomBytes(16).toString("hex");
	await pool.query(`INSERT INTO ${P}contact_center_conversations (id_channel, id_contact, url_token, source_thread_id) VALUES (?, ?, ?, ?)`, [
		ct.id_channel,
		ct.id,
		token,
		(last && last.source_thread_id) || null,
	]);
	return token;
}

module.exports = { forClient, open };