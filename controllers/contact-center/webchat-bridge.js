const path = require("path");
const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const model = require("./model");
const realtime = require("./realtime");
const types = require("./channels/index");

// Корінь фізичного сховища веб-чату.
// __dirname = controllers/contact-center → два рівні вгору = корінь проєкту.
const WC_UPLOAD_DIR = path.join(process.cwd(), "assets", "web-chat-uploads");

const P = config.get("configDatabase").prefix;

// site_id → id_channel. Кеш, бо викликається на кожне повідомлення.
const channelCache = new Map();

async function channelBySite(siteId) {
	const cached = channelCache.get(siteId);
	if (cached && Date.now() - cached.at < 60000) return cached.value;

	try {
		const [rows] = await connection_pool.query(
			`SELECT w.id_channel, ch.name, ch.status
               FROM ${P}contact_center_channel_webchat AS w
               INNER JOIN ${P}contact_center_channels AS ch ON ch.id = w.id_channel
              WHERE w.site_id = ? AND ch.deleted = 0 LIMIT 1`,
			[siteId]
		);

		const value = rows.length ? rows[0] : null;
		channelCache.set(siteId, { at: Date.now(), value: value });
		return value;
	} catch (error) {
		logging.error(error);
		return null;
	}
}

/**
 * Дзеркалить повідомлення веб-чату в спільну схему контакт-центру.
 * Стара схема лишається джерелом правди для віджета — тут тільки копія
 * для спільного списку діалогів і спільної сторінки діалогу.
 *
 * roomId = "<siteId>_<visitorId>" — використовуємо його як external_id контакту,
 * бо він стабільний і однозначно ідентифікує відвідувача в межах сайту.
 */
async function mirror(siteId, roomId, direction, msg) {
	try {
		const channel = await channelBySite(siteId);
		if (!channel) {
			console.error("[WC mirror] канал не знайдено для site_id:", siteId);
			return null;
		}
		console.log("[WC mirror] site", siteId, "→ канал", channel.id_channel);

		const visitorId = String(roomId).slice(String(siteId).length + 1);

		// source_id з префіксом, щоб не конфліктувати з нумерацією інших каналів
		const sourceId = "wc_" + msg.id;

		const payload = {
			id_channel: channel.id_channel,
			contact: {
				external_id: roomId,
				name: visitorId,
				attributes: { site_id: siteId, visitor_id: visitorId },
			},
			source_thread_id: roomId,
			message: {
				source_id: sourceId,
				type: msg.attachment ? "media" : "text",
				subtype: msg.subtype || null,
				text: msg.text || null,
				// Рядок "YYYY-MM-DD HH:MM:SS" — той самий формат, що віддає MySQL,
				// інакше parseDate() на фронті отримає ISO і дасть Invalid Date
				date_add: new Date(msg.date_add || Date.now()).toISOString().slice(0, 19).replace("T", " "),
				attachments: msg.attachment ? [await buildAttachment(msg.attachment, roomId)] : [],
			},
		};

		// Вихідні від оператора дзеркалимо окремим шляхом
		if (direction === "out") {
			const conv = await ensureConversation(channel.id_channel, payload);
			if (!conv) return null;

			await model.addOutgoing({
				id_conversation: conv.id_conversation,
				id_manager: msg.id_manager || null,
				message: payload.message,
			});

			return conv;
		}

		const result = await model.addIncoming(payload);
		if (result.duplicate) return null;

		await emitToList(result, channel, payload.message);
		return result;
	} catch (error) {
		console.error("webchat mirror:", error.message);
		logging.error(error);
		return null;
	}
}

/**
 * Переносить веб-чатове вкладення у сховище CRM (стабільний /uploads-шлях).
 * Фолбек: якщо файл не знайдено — лишаємо підписаний URL (краще, ніж нічого).
 */
async function buildAttachment(att, roomId) {
	const type = att.kind === "image" ? "image" : "file";

	if (att.rel_path) {
		const abs = path.join(WC_UPLOAD_DIR, att.rel_path);
		const imported = await require("./files").importLocalFile(abs, "web-chat", roomId, att.name);
		if (imported) {
			return {
				type: type,
				path: imported.path, // стабільний /uploads/... — не протухає
				file_name: att.name || null,
				mime: att.mime || null,
				size: imported.size || att.size || null,
				source_type: "none",
			};
		}
	}

	// Фолбек — TTL-URL (як було)
	return {
		type: type,
		path: att.url || null,
		file_name: att.name || null,
		mime: att.mime || null,
		size: att.size || null,
		source_type: "none",
	};
}

// Для вихідних потрібен уже наявний діалог — створюємо через порожній прохід
async function ensureConversation(idChannel, payload) {
	const [rows] = await connection_pool.query(
		`SELECT c.id AS id_conversation
           FROM ${P}contact_center_conversations AS c
           INNER JOIN ${P}contact_center_contacts AS ct ON ct.id = c.id_contact
          WHERE ct.id_channel = ? AND ct.external_id = ?
            AND c.date_resolved IS NULL AND c.date_archived IS NULL
          LIMIT 1`,
		[idChannel, payload.contact.external_id]
	);

	return rows.length ? rows[0] : null;
}

// Подія в спільний список діалогів і у відкритий діалог.
// message має бути в тій самій формі, що віддає getMessages() —
// інакше фронт отримає неповний об'єкт і намалює порожню бульбашку.
async function emitToList(result, channel, msg) {
	const [rows] = await connection_pool.query(
		`SELECT c.id, c.url_token, c.id_manager,
                c.last_message_text, c.last_message_dir, c.date_last_message,
                ch.type AS channel, ch.name AS channel_name, ch.status AS channel_active,
                ct.name AS contact_name
           FROM ${P}contact_center_conversations AS c
           INNER JOIN ${P}contact_center_channels AS ch ON ch.id = c.id_channel
           INNER JOIN ${P}contact_center_contacts AS ct ON ct.id = c.id_contact
          WHERE c.id = ? LIMIT 1`,
		[result.id_conversation]
	);

	if (!rows.length) return;

	const r = rows[0];
	const meta = types.get(r.channel) || {};

	realtime.message({
		direction: "in",
		reopened: result.reopened,
		conversation: {
			id: r.id,
			url_token: r.url_token,
			channel: r.channel,
			channel_name: r.channel_name,
			channel_icon: meta.icon || "",
			channel_color: meta.color || "#6c757d",
			channel_active: Number(r.channel_active) === 1 ? 1 : 0,
			title: r.contact_name || "—",
			preview: r.last_message_text || "",
			preview_dir: r.last_message_dir || "in",
			last_at: r.date_last_message,
			count: 0,
			status: r.id_manager === null ? 0 : 1,
			id_manager: r.id_manager,
		},
		message: {
			id: result.id_message,
			direction: "in",
			type: msg.attachments && msg.attachments.length ? "media" : "text",
			subtype: msg.subtype || null,
			text: msg.text || null,
			status: "delivered",
			attachments: msg.attachments || [],
			date_add: msg.date_add,
		},
	});
}

/**
 * Клієнт веб-чату прочитав повідомлення.
 * lastReadId — ID у СТАРІЙ схемі, тому шукаємо дзеркало за source_id.
 */
async function markRead(siteId, roomId, lastReadId) {
	try {
		const channel = await channelBySite(siteId);
		if (!channel) return;

		const [rows] = await connection_pool.query(
			`SELECT m.id, m.id_conversation
               FROM ${P}contact_center_messages AS m
               INNER JOIN ${P}contact_center_conversations AS c ON c.id = m.id_conversation
              WHERE c.source_thread_id = ? AND c.id_channel = ?
                AND m.source_id = ?
              LIMIT 1`,
			[roomId, channel.id_channel, "wc_" + lastReadId]
		);

		if (!rows.length) return;

		const count = await model.markOutgoingRead(rows[0].id_conversation, rows[0].id);
		if (!count) return;

		realtime.readReceipt(rows[0].id_conversation, rows[0].id);
	} catch (error) {
		console.error("webchat markRead:", error.message);
	}
}

// roomId → id_conversation (кеш, бо typing шле часто)
const convCache = new Map();
async function convByRoom(siteId, roomId) {
	const cached = convCache.get(roomId);
	if (cached && Date.now() - cached.at < 60000) return cached.id;

	const channel = await channelBySite(siteId);
	if (!channel) return null;

	const [rows] = await connection_pool.query(
		`SELECT c.id
           FROM ${P}contact_center_conversations AS c
           INNER JOIN ${P}contact_center_contacts AS ct ON ct.id = c.id_contact
          WHERE ct.id_channel = ? AND ct.external_id = ? LIMIT 1`,
		[channel.id_channel, roomId]
	);

	const id = rows.length ? rows[0].id : null;
	if (id) convCache.set(roomId, { at: Date.now(), id });
	return id;
}

// Клієнт друкує → у CRM-socket відкритого діалогу
async function typing(siteId, roomId, text) {
	try {
		const id = await convByRoom(siteId, roomId);
		if (id) realtime.typing(id, text);
	} catch (e) {
		console.error("[WC typing]", e.message);
	}
}

// Онлайн/офлайн клієнта → у список і у відкритий діалог
async function presence(siteId, roomId, online) {
	try {
		const id = await convByRoom(siteId, roomId);
		if (id) realtime.presence(id, online);
	} catch (e) {
		console.error("[WC presence]", e.message);
	}
}

// Товар, який дивиться клієнт → у відкритий діалог
async function product(siteId, roomId, prod) {
	try {
		const id = await convByRoom(siteId, roomId);
		if (id) realtime.product(id, prod);
	} catch (e) {
		console.error("[WC product]", e.message);
	}
}

// id_conversation → { site_id, room_id } для веб-чат-каналу
async function webchatRefByConversation(idConversation) {
	const [rows] = await connection_pool.query(
		`SELECT ct.external_id, ch.type AS channel_type
           FROM ${P}contact_center_conversations AS c
           INNER JOIN ${P}contact_center_channels AS ch ON ch.id = c.id_channel
           INNER JOIN ${P}contact_center_contacts AS ct ON ct.id = c.id_contact
          WHERE c.id = ? LIMIT 1`,
		[idConversation]
	);
	const r = rows[0];
	if (!r || r.channel_type !== "webchat" || !r.external_id) return null;
	const roomId = r.external_id;
	const us = roomId.indexOf("_");
	return { site_id: us > -1 ? roomId.slice(0, us) : null, room_id: roomId };
}

// Товари діалогу (поточний + історія) для нової сторінки
async function productsForConversation(idConversation) {
	const ref = await webchatRefByConversation(idConversation);
	if (!ref || !ref.site_id) return { current: null, history: [] };
	const webchat = require("../../routes/contact-center/web-chat/web-chat");
	if (typeof webchat.getProductsForRoom !== "function") return { current: null, history: [] };
	return webchat.getProductsForRoom(ref.site_id, ref.room_id);
}

async function isConversationOnline(idConversation) {
	const ref = await webchatRefByConversation(idConversation);
	if (!ref) return false;
	const webchat = require("../../routes/contact-center/web-chat/web-chat");
	return typeof webchat.isRoomOnline === "function" ? webchat.isRoomOnline(ref.room_id) : false;
}

async function onlineConversationIds() {
	try {
		const webchat = require("../../routes/contact-center/web-chat/web-chat");
		if (typeof webchat.getOnlineRooms !== "function") return [];
		const rooms = webchat.getOnlineRooms();
		if (!rooms.length) return [];
		const ph = rooms.map(() => "?").join(",");
		const [rows] = await connection_pool.query(
			`SELECT c.id FROM ${P}contact_center_conversations AS c
               INNER JOIN ${P}contact_center_contacts AS ct ON ct.id = c.id_contact
              WHERE ct.external_id IN (${ph})`,
			rooms
		);
		return rows.map((r) => r.id);
	} catch (e) {
		return [];
	}
}

async function visitorInfoForConversation(idConversation) {
	const ref = await webchatRefByConversation(idConversation);
	if (!ref || !ref.site_id) return null;
	const webchat = require("../../routes/contact-center/web-chat/web-chat");
	if (typeof webchat.getVisitorInfo !== "function") return null;
	return webchat.getVisitorInfo(ref.site_id, ref.room_id);
}

// Жива поточна сторінка клієнта → у відкритий діалог
async function visitorPage(siteId, roomId, pageUrl) {
	try {
		const id = await convByRoom(siteId, roomId);
		if (id) realtime.visitorPage(id, pageUrl);
	} catch (e) {}
}

module.exports = { mirror, channelBySite, markRead, typing, presence, product, productsForConversation, isConversationOnline, onlineConversationIds, visitorInfoForConversation, visitorPage };
