const crypto = require("crypto");
const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");

const P = config.get("configDatabase").prefix;

const T_CONTACTS = P + "contact_center_contacts";
const T_CONVS = P + "contact_center_conversations";
const T_MESSAGES = P + "contact_center_messages";
const T_ATTACH = P + "contact_center_attachments";
const T_UNREAD = P + "contact_center_unread";
const T_CHANNELS = P + "contact_center_channels";

// Канонічні типи — те, що дозволено писати в БД
const MESSAGE_TYPES = ["text", "media", "location", "contact", "sticker", "poll", "system", "event"];
const ATTACH_TYPES = ["image", "video", "audio", "file", "sticker"];

// ─────────────────────────────────────────────────────────────
// Допоміжне
// ─────────────────────────────────────────────────────────────

// Короткий прев'ю-текст для списку чатів.
// Якщо тексту немає — описуємо тип вкладення, щоб рядок не був порожнім.
function buildPreview(type, subtype, text, attachments) {
	const clean = String(text || "")
		.replace(/\s+/g, " ")
		.trim();
	if (clean) return clean.slice(0, 255);

	if (type === "location") return "📍";
	if (type === "contact") return "👤";
	if (type === "poll") return "📊";
	if (type === "sticker") return "🙂";

	const first = (attachments && attachments[0]) || null;
	if (!first) return null;

	if (first.type === "image") return "🖼";
	if (first.type === "video") return first.subtype === "video_note" ? "⭕" : "🎬";
	if (first.type === "audio") return first.subtype === "voice" ? "🎤" : "🎵";
	if (first.type === "file") return "📎 " + String(first.file_name || "").slice(0, 200);

	return "📎";
}

function toJson(value) {
	if (value == null) return null;
	return JSON.stringify(value);
}

// ─────────────────────────────────────────────────────────────
// Контакти
// ─────────────────────────────────────────────────────────────

/**
 * Знаходить або створює контакт у межах каналу.
 * Гонки вирішуються на рівні БД через UNIQUE(id_channel, external_id):
 * INSERT ... ON DUPLICATE KEY UPDATE повертає id існуючого рядка.
 * Порожні значення не перетирають уже збережені (COALESCE + NULLIF).
 */
async function findOrCreateContact(conn, data) {
	const name = data.name || [data.first_name, data.last_name].filter(Boolean).join(" ") || null;

	const [r] = await conn.execute(
		`INSERT INTO ${T_CONTACTS}
            (id_channel, external_id, name, first_name, last_name, username,
             avatar, phone, email, lang, attributes, date_last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
            id = LAST_INSERT_ID(id),
            name       = COALESCE(NULLIF(VALUES(name), ''), name),
            first_name = COALESCE(NULLIF(VALUES(first_name), ''), first_name),
            last_name  = COALESCE(NULLIF(VALUES(last_name), ''), last_name),
            username   = COALESCE(NULLIF(VALUES(username), ''), username),
            avatar     = COALESCE(NULLIF(VALUES(avatar), ''), avatar),
            phone      = COALESCE(NULLIF(VALUES(phone), ''), phone),
            email      = COALESCE(NULLIF(VALUES(email), ''), email),
            lang       = COALESCE(NULLIF(VALUES(lang), ''), lang),
            date_last_seen = NOW()`,
		[data.id_channel, String(data.external_id), name, data.first_name || null, data.last_name || null, data.username || null, data.avatar || null, data.phone || null, data.email || null, data.lang || null, toJson(data.attributes)]
	);

	return r.insertId;
}

// ─────────────────────────────────────────────────────────────
// Діалоги
// ─────────────────────────────────────────────────────────────

/**
 * Знаходить активний діалог контакту або створює новий.
 * Активний = date_resolved IS NULL AND date_archived IS NULL.
 * Це та сама умова, що в UNIQUE-ключі uniq_contact_active.
 */
async function findOrCreateConversation(conn, data) {
	const [rows] = await conn.execute(
		`SELECT id, url_token, status, id_manager
         FROM ${T_CONVS}
         WHERE id_contact = ? AND date_resolved IS NULL AND date_archived IS NULL
         LIMIT 1`,
		[data.id_contact]
	);

	if (rows.length) return rows[0];

	const urlToken = crypto.randomBytes(16).toString("hex");

	const [r] = await conn.execute(
		`INSERT INTO ${T_CONVS} (id_channel, id_contact, url_token, source_thread_id)
         VALUES (?, ?, ?, ?)`,
		[data.id_channel, data.id_contact, urlToken, data.source_thread_id || null]
	);

	return { id: r.insertId, url_token: urlToken, status: "open", id_manager: null };
}

/**
 * Реанімація діалогу: клієнт написав у закритий/архівний тред.
 * Знімає дати закриття, щоб діалог знову став активним.
 */
async function reopenConversation(conn, idConversation) {
	await conn.execute(
		`UPDATE ${T_CONVS}
         SET status = 'open', date_resolved = NULL, date_archived = NULL
         WHERE id = ? AND status <> 'open'`,
		[idConversation]
	);
}

// ─────────────────────────────────────────────────────────────
// Вкладення
// ─────────────────────────────────────────────────────────────

/**
 * Пише рядки вкладень. Локальні файли (веб-чат) одразу done,
 * зовнішні (telegram/instagram/facebook/discord) — pending для воркера.
 */
async function insertAttachments(conn, ctx, attachments) {
	if (!attachments || !attachments.length) return { count: 0, pendingIds: [] };

	let order = 0;
	const pendingIds = [];

	for (const a of attachments) {
		const type = ATTACH_TYPES.indexOf(a.type) === -1 ? "file" : a.type;
		const sourceType = a.source_type || "none";

		// Файл уже в нас (веб-чат, або відправка менеджером) — качати нічого
		const status = a.path ? "done" : sourceType === "none" ? "skipped" : "pending";

		const [r] = await conn.execute(
			`INSERT INTO ${T_ATTACH}
                (id_message, id_conversation, id_channel, type, subtype, sort_order,
                 path, thumb_path, file_name, mime, size,
                 width, height, duration,
                 source_type, source_ref, source_expires,
                 status, date_next_try)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[ctx.id_message, ctx.id_conversation, ctx.id_channel, type, a.subtype || null, order++, a.path || null, a.thumb_path || null, a.file_name || null, a.mime || null, a.size || null, a.width || null, a.height || null, a.duration || null, sourceType, a.source_ref || null, a.source_expires || null, status, status === "pending" ? new Date() : null]
		);

		if (status === "pending") pendingIds.push(r.insertId);
	}

	return { count: order, pendingIds: pendingIds };
}

// ─────────────────────────────────────────────────────────────
// Повідомлення
// ─────────────────────────────────────────────────────────────

/**
 * Оновлює денормалізовані поля діалогу після нового повідомлення.
 * Перевірка id_last_message захищає від того, що повідомлення,
 * яке прийшло із запізненням, перетре свіжіший прев'ю.
 */
async function touchConversation(conn, idConversation, msg) {
	await conn.execute(
		`UPDATE ${T_CONVS}
         SET id_last_message   = ?,
             last_message_text = ?,
             last_message_type = ?,
             last_message_dir  = ?,
             date_last_message = ?,
             date_last_inbound = IF(? = 'in', ?, date_last_inbound),
             date_first_reply  = IF(? = 'out' AND date_first_reply IS NULL, ?, date_first_reply),
             messages_count    = messages_count + 1
         WHERE id = ? AND (id_last_message IS NULL OR id_last_message < ?)`,
		[msg.id, msg.preview, msg.type, msg.direction, msg.date_add, msg.direction, msg.date_add, msg.direction, msg.date_add, idConversation, msg.id]
	);
}

/**
 * Вхідне повідомлення від клієнта.
 *
 * Приймає вже нормалізований об'єкт — нормалізацію робить адаптер каналу.
 * Повертає { duplicate: true } якщо це повтор вебхука.
 *
 * Обов'язкові: id_channel, contact{external_id}, message{type}
 */
async function addIncoming(payload) {
	const conn = await connection_pool.getConnection();

	try {
		await conn.beginTransaction();

		const idContact = await findOrCreateContact(conn, Object.assign({ id_channel: payload.id_channel }, payload.contact));

		const conv = await findOrCreateConversation(conn, {
			id_channel: payload.id_channel,
			id_contact: idContact,
			source_thread_id: payload.source_thread_id,
		});

		// Клієнт написав у закритий діалог — відкриваємо знову
		if (conv.status !== "open") await reopenConversation(conn, conv.id);

		const m = payload.message || {};
		const type = MESSAGE_TYPES.indexOf(m.type) === -1 ? "text" : m.type;
		const attachments = m.attachments || [];
		const dateAdd = m.date_add || new Date();

		// Reply: клієнт відповів на конкретне повідомлення.
		// Знаходимо наше повідомлення по source_id (mid оригіналу) → внутрішній id.
		let idReplyTo = null;
		let replyText = null;
		if (m.reply_to_source_id) {
			const [rt] = await conn.execute(`SELECT id, text FROM ${T_MESSAGES} WHERE id_channel = ? AND source_id = ? LIMIT 1`, [payload.id_channel, String(m.reply_to_source_id)]);
			if (rt.length) {
				idReplyTo = rt[0].id;
				replyText = rt[0].text;
			}
		}

		let result;
		try {
			[result] = await conn.execute(
				`INSERT INTO ${T_MESSAGES}
                    (id_conversation, id_channel, direction, source_id,
                     type, subtype, text, id_reply_to, lat, lng, attributes,
                     status, has_attachments, date_add)
                 VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?)`,
				[conv.id, payload.id_channel, m.source_id || null, type, m.subtype || null, m.text || null, idReplyTo, m.lat || null, m.lng || null, toJson(m.attributes), attachments.length ? 1 : 0, dateAdd]
			);
		} catch (e) {
			// Повтор вебхука — uniq_conv_source
			if (e.code === "ER_DUP_ENTRY") {
				await conn.rollback();
				return { duplicate: true, id_conversation: conv.id };
			}
			throw e;
		}

		const idMessage = result.insertId;

		const attInfo = await insertAttachments(conn, { id_message: idMessage, id_conversation: conv.id, id_channel: payload.id_channel }, attachments);

		const preview = buildPreview(type, m.subtype, m.text, attachments);

		await touchConversation(conn, conv.id, {
			id: idMessage,
			preview: preview,
			type: type,
			direction: "in",
			date_add: dateAdd,
		});

		// Непрочитане: якщо діалог уже за кимось закріплений — рахуємо йому,
		// інакше лічильник з'явиться в момент призначення менеджера.
		if (conv.id_manager) {
			await conn.execute(
				`INSERT INTO ${T_UNREAD} (id_conversation, id_manager, count)
                 VALUES (?, ?, 1)
                 ON DUPLICATE KEY UPDATE count = count + 1`,
				[conv.id, conv.id_manager]
			);
		}

		await conn.commit();

		// Кожне вкладення — окреме завдання черги, поставлене ПІСЛЯ коміту.
		// Адресне за id → без гонок «побачити pending у моменті».
		if (attInfo.pendingIds.length) {
			const attQueue = require("./attachments-queue");
			for (const attId of attInfo.pendingIds) {
				attQueue.enqueueAttachment(attId).catch(function (e) {
					console.error("[cc-att-enqueue]", e && e.message);
				});
			}
		}

		return {
			duplicate: false,
			id_message: idMessage,
			id_conversation: conv.id,
			id_contact: idContact,
			url_token: conv.url_token,
			id_manager: conv.id_manager,
			reopened: conv.status !== "open",
			reply_text: replyText,
		};
	} catch (error) {
		await conn.rollback();
		throw error;
	} finally {
		conn.release();
	}
}

/**
 * Вихідне повідомлення від менеджера.
 *
 * Пишеться зі status='pending' ДО відправки в канал — щоб воно одразу
 * з'явилося в інтерфейсі, а збій відправки був видимим станом, а не втратою.
 * Після відповіді API викликається markSent / markFailed.
 */
async function addOutgoing(payload) {
	const conn = await connection_pool.getConnection();

	try {
		await conn.beginTransaction();

		const [convRows] = await conn.execute(`SELECT id, id_channel FROM ${T_CONVS} WHERE id = ? LIMIT 1`, [payload.id_conversation]);
		if (!convRows.length) throw new Error("Conversation not found");

		const conv = convRows[0];
		const m = payload.message || {};
		const type = MESSAGE_TYPES.indexOf(m.type) === -1 ? "text" : m.type;
		const attachments = m.attachments || [];
		const dateAdd = new Date();

		const [result] = await conn.execute(
			`INSERT INTO ${T_MESSAGES}
                (id_conversation, id_channel, direction, id_manager,
                 type, subtype, text, id_reply_to, attributes,
                 status, has_attachments, date_add)
             VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
			[conv.id, conv.id_channel, payload.id_manager || null, type, m.subtype || null, m.text || null, m.id_reply_to || null, toJson(m.attributes), attachments.length ? 1 : 0, dateAdd]
		);

		const idMessage = result.insertId;

		const attInfo = await insertAttachments(conn, { id_message: idMessage, id_conversation: conv.id, id_channel: conv.id_channel }, attachments);

		await touchConversation(conn, conv.id, {
			id: idMessage,
			preview: buildPreview(type, m.subtype, m.text, attachments),
			type: type,
			direction: "out",
			date_add: dateAdd,
		});

		await conn.commit();

		if (attInfo && attInfo.pendingIds.length) {
			const attQueue = require("./attachments-queue");
			for (const attId of attInfo.pendingIds) {
				attQueue.enqueueAttachment(attId).catch(function (e) {
					console.error("[cc-att-enqueue]", e && e.message);
				});
			}
		}

		return { id_message: idMessage, id_conversation: conv.id, id_channel: conv.id_channel, date_add: dateAdd };
	} catch (error) {
		await conn.rollback();
		throw error;
	} finally {
		conn.release();
	}
}

/** Канал прийняв повідомлення — фіксуємо його ID на боці каналу. */
async function markSent(idMessage, sourceId) {
	await connection_pool.execute(`UPDATE ${T_MESSAGES} SET status = 'sent', source_id = ?, error = NULL WHERE id = ?`, [sourceId || null, idMessage]);
}

/** Канал відхилив повідомлення — лишаємо його в стрічці з позначкою помилки. */
async function markFailed(idMessage, error) {
	await connection_pool.execute(`UPDATE ${T_MESSAGES} SET status = 'failed', error = ? WHERE id = ?`, [String(error || "").slice(0, 500), idMessage]);
}

// ─────────────────────────────────────────────────────────────
// Читання
// ─────────────────────────────────────────────────────────────

/** Менеджер відкрив діалог — обнуляємо його лічильник. */
async function markRead(idConversation, idManager) {
	await connection_pool.execute(
		`INSERT INTO ${T_UNREAD} (id_conversation, id_manager, count, id_last_read_message)
         SELECT ?, ?, 0, MAX(id) FROM ${T_MESSAGES} WHERE id_conversation = ?
         ON DUPLICATE KEY UPDATE count = 0, id_last_read_message = VALUES(id_last_read_message)`,
		[idConversation, idManager, idConversation]
	);
}

/** Призначення менеджера. Лічильник непрочитаних заводиться тут. */
async function assignManager(idConversation, idManager) {
	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		await conn.execute(`UPDATE ${T_CONVS} SET id_manager = ? WHERE id = ?`, [idManager, idConversation]);

		if (idManager) {
			await conn.execute(
				`INSERT INTO ${T_UNREAD} (id_conversation, id_manager, count)
                 VALUES (?, ?, 0)
                 ON DUPLICATE KEY UPDATE count = count`,
				[idConversation, idManager]
			);
		}

		await conn.commit();
	} catch (error) {
		await conn.rollback();
		throw error;
	} finally {
		conn.release();
	}
}

/** Зміна статусу діалогу. Дати закриття керують UNIQUE-ключем активності. */
async function setStatus(idConversation, status) {
	const map = {
		open: "status = 'open', date_resolved = NULL, date_archived = NULL",
		pending: "status = 'pending'",
		resolved: "status = 'resolved', date_resolved = NOW(), date_archived = NULL",
		archived: "status = 'archived', date_archived = NOW()",
	};

	if (!map[status]) throw new Error("Unknown status: " + status);

	await connection_pool.execute(`UPDATE ${T_CONVS} SET ${map[status]} WHERE id = ?`, [idConversation]);
}

// ─────────────────────────────────────────────────────────────
// Читання стрічки
// ─────────────────────────────────────────────────────────────

/**
 * Діалог із контактом і каналом — усе, що потрібно сторінці.
 * Пошук по url_token, а не по id: у посиланні внутрішній ID не світиться.
 */
async function getConversationByToken(token) {
	const [rows] = await connection_pool.query(
		`SELECT c.*,
                ct.name AS contact_name, ct.username AS contact_username,
                ct.avatar AS contact_avatar, ct.phone AS contact_phone,
                ct.email AS contact_email, ct.external_id AS contact_external_id,
                ch.type AS channel_type, ch.name AS channel_name,
                ch.status AS channel_active, ch.is_configured AS channel_configured
         FROM ${T_CONVS} AS c
         INNER JOIN ${T_CONTACTS} AS ct ON ct.id = c.id_contact
         INNER JOIN ${T_CHANNELS} AS ch ON ch.id = c.id_channel
         WHERE c.url_token = ? AND ch.deleted = 0
         LIMIT 1`,
		[token]
	);

	return rows[0] || null;
}

/**
 * Сторінка повідомлень. Курсор — id, бо він монотонний у межах діалогу.
 * before=null → найсвіжіші. Повертає у хронологічному порядку.
 */
async function getMessages(idConversation, before, limit) {
	const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

	const params = [idConversation];
	let where = "";

	if (before) {
		where = " AND m.id < ?";
		params.push(parseInt(before, 10));
	}

	const [rows] = await connection_pool.query(
		`SELECT m.id, m.direction, m.id_manager, m.source_id, m.type, m.subtype,
                m.text, m.reaction, m.id_reply_to, m.lat, m.lng, m.status, m.error,
                m.has_attachments, m.date_add, m.date_edited, m.date_deleted,
                rm.text AS reply_text, rm.direction AS reply_dir, rm.type AS reply_type,
                NULLIF(TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))), '') AS manager_name,
                u.avatar AS manager_avatar
         FROM ${T_MESSAGES} AS m
         LEFT JOIN ${P}users AS u ON u.id = m.id_manager
         LEFT JOIN ${T_MESSAGES} AS rm ON rm.id = m.id_reply_to
         WHERE m.id_conversation = ? ${where}
         ORDER BY m.id DESC
         LIMIT ${lim}`,
		params
	);

	rows.reverse();

	if (!rows.length) return { messages: [], hasMore: false };

	// Вкладення одним запитом на всю сторінку — без N+1
	const ids = rows.filter((r) => r.has_attachments).map((r) => r.id);

	if (ids.length) {
		const [atts] = await connection_pool.query(
			`SELECT id, id_message, type, subtype, sort_order,
                    path, thumb_path, file_name, mime, size,
                    width, height, duration, status
             FROM ${T_ATTACH}
             WHERE id_message IN (${ids.map(() => "?").join(",")})
             ORDER BY id_message, sort_order`,
			ids
		);

		const byMessage = {};
		atts.forEach(function (a) {
			if (!byMessage[a.id_message]) byMessage[a.id_message] = [];
			byMessage[a.id_message].push(a);
		});

		rows.forEach(function (r) {
			r.attachments = byMessage[r.id] || [];
		});
	}

	rows.forEach(function (r) {
		if (!r.attachments) r.attachments = [];
	});

	return { messages: rows, hasMore: rows.length === lim };
}

/**
 * Медіатека діалогу — усі вкладення, згруповані за типом.
 * Джерело — contact_center_attachments (канало-агностично).
 * Тільки завантажені (status='done', є path).
 */
async function getMedia(idConversation) {
	const [rows] = await connection_pool.execute(
		`SELECT id, type, path, thumb_path, file_name, mime, size, duration, date_add
           FROM ${T_ATTACH}
          WHERE id_conversation = ? AND status = 'done' AND path IS NOT NULL
          ORDER BY id DESC`,
		[idConversation]
	);

	const out = { image: [], video: [], audio: [], voice: [], file: [] };

	for (const a of rows) {
		// Голосові — audio з subtype 'voice'; але subtype не тягнемо,
		// тож розділяємо просто: audio → в audio. Якщо треба voice окремо —
		// додай subtype у SELECT. Поки audio і voice разом в audio.
		const bucket = a.type === "sticker" ? "image" : out[a.type] ? a.type : "file";
		out[bucket].push({
			id: a.id,
			type: a.type,
			path: a.path,
			thumb_path: a.thumb_path,
			file_name: a.file_name,
			mime: a.mime,
			size: a.size,
			duration: a.duration,
			date_add: a.date_add,
		});
	}

	return out;
}

/**
 * Клієнт прочитав вихідні повідомлення до вказаного ID.
 * Канали, які не повідомляють про прочитання (Telegram), це не викликають —
 * там статус лишається 'sent'.
 */
async function markOutgoingRead(idConversation, upToMessageId) {
	const [r] = await connection_pool.execute(
		`UPDATE ${T_MESSAGES}
            SET status = 'read'
          WHERE id_conversation = ? AND direction = 'out'
            AND id <= ? AND status IN ('sent','delivered')`,
		[idConversation, upToMessageId]
	);

	return r.affectedRows;
}

/**
 * Прочитання по source_id (mid) — для каналів, що шлють read з ID повідомлення
 * (Instagram). Позначає read вказане повідомлення і всі старіші вихідні до нього.
 */
async function markOutgoingReadBySourceId(idChannel, sourceId) {
	// Знаходимо наше повідомлення по source_id
	const [rows] = await connection_pool.execute(`SELECT id, id_conversation FROM ${T_MESSAGES} WHERE id_channel = ? AND source_id = ? AND direction = 'out' LIMIT 1`, [idChannel, String(sourceId)]);

	if (!rows.length) return { affected: 0, id_conversation: null };

	const msg = rows[0];

	const [r] = await connection_pool.execute(
		`UPDATE ${T_MESSAGES}
            SET status = 'read'
          WHERE id_conversation = ? AND direction = 'out'
            AND id <= ? AND status IN ('sent','delivered')`,
		[msg.id_conversation, msg.id]
	);

	return { affected: r.affectedRows, id_conversation: msg.id_conversation, up_to_id: msg.id };
}

/**
 * Ставить / прибирає реакцію на повідомлення по source_id (mid).
 * action='react' → зберігаємо emoji; 'unreact' → очищаємо.
 */
async function setMessageReaction(idChannel, sourceId, action, emoji) {
	const [rows] = await connection_pool.execute(`SELECT id, id_conversation FROM ${T_MESSAGES} WHERE id_channel = ? AND source_id = ? LIMIT 1`, [idChannel, String(sourceId)]);

	if (!rows.length) return { affected: 0, id_conversation: null, id_message: null };

	const msg = rows[0];
	const value = action === "unreact" ? null : emoji || "❤️";

	await connection_pool.execute(`UPDATE ${T_MESSAGES} SET reaction = ? WHERE id = ?`, [value, msg.id]);

	return { affected: 1, id_conversation: msg.id_conversation, id_message: msg.id, reaction: value };
}

/**
 * Повне видалення діалогу. FK-каскади стирають messages/attachments/unread
 * автоматично — тут видаляємо conversation і чистимо файли з диску.
 * Повертає звʼязок для веб-чату (щоб чистити стару схему).
 */
async function deleteConversation(idConversation) {
	const fs = require("fs");
	const path = require("path");

	const [atts] = await connection_pool.query(`SELECT path FROM ${T_ATTACH} WHERE id_conversation = ? AND path IS NOT NULL`, [idConversation]);

	const [convRows] = await connection_pool.query(
		`SELECT ch.type AS channel_type, ct.external_id
           FROM ${T_CONVS} AS c
           INNER JOIN ${T_CHANNELS} AS ch ON ch.id = c.id_channel
           INNER JOIN ${T_CONTACTS} AS ct ON ct.id = c.id_contact
          WHERE c.id = ? LIMIT 1`,
		[idConversation]
	);
	const conv = convRows[0] || null;

	// Сповіщення діалогу (notif_inbox по collapse_key) — до видалення conversation
	try {
		await require("./notifications").deleteConversationNotifications(idConversation);
	} catch (e) {
		console.error("[cc-delete notif]", e.message);
	}

	// Сповіщення діалогу (notif_inbox по collapse_key) — до видалення conversation
	try {
		await require("./notifications").deleteConversationNotifications(idConversation);
	} catch (e) {
		console.error("[cc-delete notif]", e.message);
	}

	// Видалення conversation → messages/attachments/unread підуть каскадом (FK ON DELETE CASCADE)
	await connection_pool.query(`DELETE FROM ${T_CONVS} WHERE id = ?`, [idConversation]);

	// Файли з диску — після видалення рядків
	const UPLOAD_ROOT = path.join(process.cwd(), "assets", "contact-center");
	for (const a of atts) {
		try {
			if (!a.path) continue;
			const rel = String(a.path).replace(/^\/assets\/contact-center\//, "");
			const abs = path.join(UPLOAD_ROOT, rel);
			if (abs.startsWith(path.resolve(UPLOAD_ROOT) + path.sep) && fs.existsSync(abs)) fs.unlinkSync(abs);
		} catch (e) {
			console.error("[cc-delete file]", e.message);
		}
	}

	if (conv && conv.channel_type === "webchat" && conv.external_id) {
		const roomId = conv.external_id;
		const us = roomId.indexOf("_");
		return { channel_type: "webchat", room_id: roomId, site_id: us > -1 ? roomId.slice(0, us) : null };
	}

	return { channel_type: conv ? conv.channel_type : null };
}

module.exports = {
	markOutgoingRead,
	markOutgoingReadBySourceId,
	setMessageReaction,
	getConversationByToken,
	getMessages,
	deleteConversation,
	getMedia,
	findOrCreateContact,
	findOrCreateConversation,
	addIncoming,
	addOutgoing,
	markSent,
	markFailed,
	markRead,
	assignManager,
	setStatus,
	buildPreview,
	tables: { contacts: T_CONTACTS, conversations: T_CONVS, messages: T_MESSAGES, attachments: T_ATTACH, unread: T_UNREAD, channels: T_CHANNELS },
};
