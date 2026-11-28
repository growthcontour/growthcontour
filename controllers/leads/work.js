"use strict";

/**
 * Робота з лідом: активності, файли, конвертація.
 *
 * Активності (leads_activities): дзвінок, лист, зустріч, задача, нотатка, месенджер… — заплановані й виконані.
 *   Перша виконана дія менеджера фіксує «першу відповідь» ліда (first_response_at).
 * Файли (leads_files): перевірка вмісту за першими байтами (як у чаті), сховище storage/leads/РРРР/ММ,
 *   віддача лише через маршрут з перевіркою доступу до ліда.
 * Конвертація (leads_conversions): у клієнта, угоду або замовлення. Лід позначається конвертованим,
 *   статус і етап — «виграно» (якщо такі є), у журналі конвертацій — знімок ліда.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const chatFiles = require("../chat/files");

const P = config.get("configDatabase").prefix;
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const parse = (v, def) => {
	if (v === null || v === undefined) return def;
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return def;
	}
};

/* ═══ Історія ліда ═══ */

async function history(conn, idLead, idUser, action, field, oldV, newV, comment, ip) {
	await (conn || pool).query(
		`INSERT INTO \`${P}leads_history\` (id_lead, id_manager, action_type, field_name, value_old, value_new, comment, source, ip, date_add) VALUES (?, ?, ?, ?, ?, ?, ?, 'web', ?, NOW())`,
		[idLead, idUser || null, action, field, oldV, newV, comment ? String(comment).slice(0, 5000) : null, ip || null]
	);
}

/* ═══ Активності ═══ */

const ACT_TYPES = ["call", "email", "meeting", "task", "note", "whatsapp", "telegram", "viber", "sms", "demo", "other"];
const ACT_STATUS = ["planned", "done", "cancelled", "missed"];
const HIST_ACTION = { call: "call_logged", meeting: "meeting_logged", email: "email_sent", task: "task_created" };

async function activities(idLead) {
	const [rows] = await pool.query(
		`SELECT a.id, a.type, a.direction, a.status, a.subject, a.body, a.duration_sec, a.scheduled_at, a.done_at, a.date_add, a.id_manager,
		        NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS manager_name
		   FROM \`${P}leads_activities\` a LEFT JOIN \`${P}users\` u ON u.id = a.id_manager
		  WHERE a.id_lead = ? AND a.deleted_at IS NULL
		  ORDER BY (a.status = 'planned') DESC, COALESCE(a.scheduled_at, a.done_at, a.date_add) DESC, a.id DESC`,
		[idLead]
	);
	return rows;
}

/** Тіло форми → поля активності або помилка */
function activityValues(b) {
	const type = ACT_TYPES.includes(b.type) ? b.type : null;
	if (!type) throw httpErr(400, "leads.work.e.type");
	const status = ACT_STATUS.includes(b.status) ? b.status : "planned";
	const subject = String(b.subject || "").trim().slice(0, 500);
	const body = String(b.body || "").trim().slice(0, 20000);
	if (!subject && !body) throw httpErr(400, "leads.work.e.subject");
	const when = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(b.scheduled_at || "")) ? String(b.scheduled_at).replace("T", " ").slice(0, 16) + ":00" : null;
	if (status === "planned" && !when) throw httpErr(400, "leads.work.e.when");
	return {
		type,
		status,
		subject,
		body: body || null,
		direction: b.direction === "inbound" ? "inbound" : "outbound",
		duration_sec: Math.min(86400, Math.max(0, Math.round(Number(b.duration_min || 0) * 60) || 0)),
		scheduled_at: when,
	};
}

async function addActivity(idLead, b, idUser, ip) {
	const v = activityValues(b);
	const [r] = await pool.query(
		`INSERT INTO \`${P}leads_activities\` (id_lead, id_manager, type, direction, status, subject, body, duration_sec, scheduled_at, done_at, date_add, date_edit)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${v.status === "done" ? "NOW()" : "NULL"}, NOW(), NOW())`,
		[idLead, idUser, v.type, v.direction, v.status, v.subject, v.body, v.duration_sec, v.scheduled_at]
	);
	await history(null, idLead, idUser, HIST_ACTION[v.type] || "comment", null, null, null, [v.subject, v.body].filter(Boolean).join("\n"), ip);
	if (v.status === "done") await firstResponse(idLead, v);
	else if (v.status === "planned") await require("./reminders").schedule(r.insertId).catch((e) => logging.error(e));
	await require("./scoring").recalc(idLead);
	return r.insertId;
}

/** Статус активності: виконано / скасовано / пропущено (і назад у «заплановано») */
async function setActivityStatus(idLead, idAct, status) {
	if (!ACT_STATUS.includes(status)) throw httpErr(400, "leads.work.e.status");
	const [[a]] = await pool.query(`SELECT id, type, direction, status FROM \`${P}leads_activities\` WHERE id = ? AND id_lead = ? AND deleted_at IS NULL`, [idAct, idLead]);
	if (!a) throw httpErr(404, "leads.server.not_found");
	await pool.query(`UPDATE \`${P}leads_activities\` SET status = ?, done_at = ${status === "done" ? "COALESCE(done_at, NOW())" : "NULL"}, date_edit = NOW() WHERE id = ?`, [status, idAct]);
	if (status === "done") await firstResponse(idLead, a);
	// Нагадування: повернули в «заплановано» — знову; інакше — скасувати
	const rem = require("./reminders");
	await (status === "planned" ? rem.schedule(idAct) : rem.cancel(idAct)).catch((e) => logging.error(e));
	await require("./scoring").recalc(idLead);
	return { ok: true };
}

async function deleteActivity(idLead, idAct, idUser) {
	const [r] = await pool.query(`UPDATE \`${P}leads_activities\` SET deleted_at = NOW(), id_deleted_by = ? WHERE id = ? AND id_lead = ? AND deleted_at IS NULL`, [idUser, idAct, idLead]);
	if (!r.affectedRows) throw httpErr(404, "leads.server.not_found");
	await require("./reminders").cancel(idAct).catch((e) => logging.error(e));
	await require("./scoring").recalc(idLead);
	return { ok: true };
}

/** Перша виконана дія менеджера до клієнта (не нотатка й не вхідна) — «перша відповідь» ліда */
async function firstResponse(idLead, a) {
	if (a.type === "note" || a.direction === "inbound") return;
	await pool.query(`UPDATE \`${P}leads\` SET first_response_at = NOW() WHERE id = ? AND first_response_at IS NULL`, [idLead]);
}

/* ═══ Файли ═══ */

const ROOT = path.join(process.cwd(), "storage", "leads");
const MAX_SIZE = chatFiles.MAX_SIZE;
const CATEGORIES = ["document", "contract", "invoice", "photo", "other"];

const upload = multer({
	storage: multer.diskStorage({
		destination(req, file, cb) {
			const now = new Date();
			const dir = path.join(ROOT, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"));
			fsp.mkdir(dir, { recursive: true, mode: 0o750 }).then(
				() => cb(null, dir),
				(e) => cb(e)
			);
		},
		filename(req, file, cb) {
			cb(null, crypto.randomBytes(16).toString("hex"));
		},
	}),
	limits: { fileSize: MAX_SIZE, files: 1, fields: 3, fieldSize: 256, parts: 4, headerPairs: 50 },
	fileFilter(req, file, cb) {
		if (!chatFiles.ALLOWED[chatFiles.extOf(chatFiles.cleanName(file.originalname))]) return cb(httpErr(400, "leads.work.e.file_type"));
		cb(null, true);
	},
}).single("file");

async function files(idLead) {
	const [rows] = await pool.query(
		`SELECT f.id, f.category, f.name, f.mime, f.size, f.date_add, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS manager_name
		   FROM \`${P}leads_files\` f LEFT JOIN \`${P}users\` u ON u.id = f.id_manager
		  WHERE f.id_lead = ? AND f.deleted_at IS NULL ORDER BY f.id DESC`,
		[idLead]
	);
	return rows;
}

/** Щойно записаний файл: вміст має відповідати розширенню (інакше — видалити) */
async function addFile(idLead, file, category, idUser, ip) {
	try {
		const name = chatFiles.cleanName(file.originalname);
		const rule = chatFiles.ALLOWED[chatFiles.extOf(name)];
		const fh = await fsp.open(file.path, "r");
		const buf = Buffer.alloc(8192);
		const { bytesRead } = await fh.read(buf, 0, 8192, 0);
		await fh.close();
		const sig = chatFiles.sniff(buf.subarray(0, bytesRead));
		if (!rule || !file.size || !sig || !rule.sig.includes(sig)) throw httpErr(400, "leads.work.e.file_type");
		const rel = path.relative(ROOT, file.path).split(path.sep).join("/");
		const [r] = await pool.query(
			`INSERT INTO \`${P}leads_files\` (id_lead, id_manager, category, name, path, mime, size, date_add, date_edit) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
			[idLead, idUser, CATEGORIES.includes(category) ? category : "other", name, rel, rule.mime, file.size]
		);
		await history(null, idLead, idUser, "file_attached", null, null, name, null, ip);
		return r.insertId;
	} catch (e) {
		await fsp.unlink(file.path).catch(() => {});
		throw e;
	}
}

async function deleteFile(idLead, idFile, idUser, ip) {
	const [[f]] = await pool.query(`SELECT id, name FROM \`${P}leads_files\` WHERE id = ? AND id_lead = ? AND deleted_at IS NULL`, [idFile, idLead]);
	if (!f) throw httpErr(404, "leads.server.not_found");
	// М'яко: файл лишається на диску (лід може бути відновлено з кошика)
	await pool.query(`UPDATE \`${P}leads_files\` SET deleted_at = NOW(), id_deleted_by = ? WHERE id = ?`, [idUser, idFile]);
	await history(null, idLead, idUser, "file_deleted", null, f.name, null, null, ip);
	return { ok: true };
}

const INLINE = /^(image\/(jpeg|png|gif|webp|avif)|application\/pdf|video\/(mp4|webm)|audio\/(mpeg|ogg|mp4|webm|wav))$/;
/** Віддати файл ліда (доступ до ліда перевіряє guard модуля) */
async function serveFile(idLead, idFile, res, download) {
	const [[f]] = await pool.query(`SELECT name, mime, path FROM \`${P}leads_files\` WHERE id = ? AND id_lead = ? AND deleted_at IS NULL`, [idFile, idLead]);
	if (!f) throw httpErr(404, "leads.server.not_found");
	const abs = path.resolve(ROOT, String(f.path));
	if (!abs.startsWith(ROOT + path.sep)) throw httpErr(404, "leads.server.not_found");
	try {
		await fsp.access(abs, fs.constants.R_OK);
	} catch {
		throw httpErr(404, "leads.server.not_found");
	}
	const inline = !download && INLINE.test(f.mime);
	const ascii = String(f.name).replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "file";
	res.setHeader("Content-Type", inline ? f.mime : "application/octet-stream");
	res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Content-Security-Policy", f.mime === "application/pdf" && inline ? "frame-ancestors 'self'" : "default-src 'none'; img-src 'self'; media-src 'self'; sandbox");
	res.setHeader("Cache-Control", "private, max-age=3600");
	await new Promise((resolve) => res.sendFile(abs, { dotfiles: "deny" }, () => resolve()));
}

/* ═══ Конвертація ═══ */

async function conversions(idLead) {
	const [rows] = await pool.query(
		`SELECT c.id, c.converted_to, c.converted_id, c.date_add, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS manager_name,
		        CASE c.converted_to
		          WHEN 'deal' THEN (SELECT COALESCE(deal_number, title) FROM \`${P}deals\` WHERE id = c.converted_id)
		          WHEN 'order' THEN (SELECT COALESCE(reference, CONCAT('#', id)) FROM \`${P}orders\` WHERE id = c.converted_id)
		          WHEN 'client' THEN (SELECT display_name FROM \`${P}clients\` WHERE id = c.converted_id)
		        END AS label
		   FROM \`${P}leads_conversions\` c LEFT JOIN \`${P}users\` u ON u.id = c.id_manager
		  WHERE c.id_lead = ? ORDER BY c.id DESC`,
		[idLead]
	);
	return rows;
}

async function loadLead(idLead) {
	const [[l]] = await pool.query(`SELECT * FROM \`${P}leads\` WHERE id = ? AND deleted_at IS NULL`, [idLead]);
	if (!l) throw httpErr(404, "leads.server.not_found");
	l.contact_info = parse(l.contact_info, {}) || {};
	return l;
}

/** Після конвертації: позначка, статус і етап «виграно», журнал конвертацій, історія, вебхук */
async function markConverted(l, to, idTarget, idUser, ip) {
	const [[won]] = await pool.query(`SELECT id FROM \`${P}leads_settings_status\` WHERE system_type = 'won' AND is_active = 1 ORDER BY sort LIMIT 1`);
	const [[wonStage]] = l.id_pipeline ? await pool.query(`SELECT id FROM \`${P}leads_pipeline_stages\` WHERE id_pipeline = ? AND system_type = 'won' AND is_active = 1 ORDER BY sort LIMIT 1`, [l.id_pipeline]) : [[null]];
	const set = { is_converted: 1 };
	if (won && Number(l.id_status) !== Number(won.id)) set.id_status = won.id;
	if (wonStage && Number(l.id_stage) !== Number(wonStage.id)) set.id_stage = wonStage.id;
	await pool.query(`UPDATE \`${P}leads\` SET ?, converted_at = COALESCE(converted_at, NOW()), date_edit = NOW() WHERE id = ?`, [set, l.id]);
	const snapshot = { title: l.title, value: Number(l.value), contact: l.contact_info, id_status: l.id_status, id_stage: l.id_stage, id_manager: l.id_manager };
	await pool.query(`INSERT INTO \`${P}leads_conversions\` (id_lead, id_manager, converted_to, converted_id, snapshot, date_add) VALUES (?, ?, ?, ?, ?, NOW())`, [l.id, idUser, to, idTarget, JSON.stringify(snapshot)]);
	await history(null, l.id, idUser, "converted", "converted_to", null, `${to}:${idTarget}`, null, ip);
	if (set.id_status) await history(null, l.id, idUser, "field_change", "id_status", String(l.id_status || ""), String(set.id_status), null, ip);
	if (set.id_stage) await history(null, l.id, idUser, "field_change", "id_stage", String(l.id_stage || ""), String(set.id_stage), null, ip);
	require("./webhooks").fire("lead.converted", l.id, { converted_to: to, converted_id: idTarget });
}

/** У клієнта: знайти за телефоном / email або створити картку й прив'язати лід */
async function toClient(idLead, idUser, ip) {
	const l = await loadLead(idLead);
	if (!l.contact_info.phone && !l.contact_info.email && !l.contact_info.name) throw httpErr(400, "leads.work.e.no_contact");
	const idClient = await require("../clients/links").linkLead(idLead, idUser);
	if (!idClient) throw httpErr(400, "leads.work.e.no_contact");
	await markConverted(l, "client", idClient, idUser, ip);
	return { id: idClient, url: `/clients/${idClient}/` };
}

/** В угоду: перша воронка й етап угод, сума, опис, відповідальний; клієнт — прив'язується до ліда */
async function toDeal(idLead, idUser, ip, tSys) {
	const l = await loadLead(idLead);
	try {
		await require("../clients/links").linkLead(idLead, idUser);
	} catch (e) {
		logging.error(e);
	}
	const [[pipeline]] = await pool.query(`SELECT id FROM \`${P}deals_pipeline\` WHERE active = 1 ORDER BY sort_order LIMIT 1`);
	if (!pipeline) throw httpErr(400, "deals.server.no_pipeline");
	const [[stage]] = await pool.query(`SELECT id, probability FROM \`${P}deals_stage\` WHERE id_pipeline = ? AND active = 1 ORDER BY sort_order LIMIT 1`, [pipeline.id]);
	if (!stage) throw httpErr(400, "deals.server.no_stage");
	const prefix = tSys("deals.server.number_prefix");
	const year = new Date().getFullYear();
	const [[last]] = await pool.query(`SELECT deal_number FROM \`${P}deals\` WHERE deal_number LIKE ? ORDER BY id DESC LIMIT 1`, [`${prefix}-${year}-%`]);
	const next = last && last.deal_number ? (parseInt(last.deal_number.split("-")[2], 10) || 0) + 1 : 1;
	const amount = Math.round(Number(l.value || 0) * 100) / 100;
	const currency = await require("../orders/currency").getBase();
	const manager = l.id_manager || idUser;
	const [r] = await pool.query(
		`INSERT INTO \`${P}deals\`
		   (id_pipeline, id_stage, id_lead, id_user, id_user_creator, title, description, amount, amount_final, amount_base, amount_currency,
		    probability, amount_weighted, deal_number, date_close_plan, forecast_category, active, date_add, date_edit)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pipeline', 1, NOW(), NOW())`,
		[pipeline.id, stage.id, l.id, manager, idUser, String(l.title || "").slice(0, 500) || tSys("deals.server.new_deal"), l.note || null, amount, amount, amount, currency, stage.probability, Math.round((amount * stage.probability) / 100 * 100) / 100, `${prefix}-${year}-${String(next).padStart(4, "0")}`, l.expected_close_date || null]
	);
	await pool.query(`INSERT INTO \`${P}deals_audit_log\` (id_user, user_name, user_ip, entity_type, id_entity, action, description, date_add) VALUES (?, '', ?, 'deal', ?, 'create', ?, NOW())`, [idUser, ip, r.insertId, `Lead #${l.id}`]).catch((e) => logging.error(e));
	await markConverted(l, "deal", r.insertId, idUser, ip);
	return { id: r.insertId, url: `/deals/${r.insertId}/` };
}

/** Джерела ручних замовлень (як на /orders/new/) */
async function orderSources() {
	const [rows] = await pool.query(`SELECT id, name FROM \`${P}settings_integrations\` WHERE platform = 'custom' AND status = 'active' ORDER BY id`);
	return rows;
}

/** У замовлення: позиції з форми, покупець — з контактів ліда; створення — тим самим кодом, що й ручне замовлення */
async function toOrder(idLead, b, idUser, ip, t) {
	const l = await loadLead(idLead);
	const sources = await orderSources();
	const source = sources.find((s) => s.id === Number(b.id_integration));
	if (!source) throw httpErr(400, "orders.new.e_source");
	const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
	const money = (v) => Math.max(0, Math.round((Number(String(v ?? "").replace(",", ".")) || 0) * 100) / 100);
	const items = (Array.isArray(b.items) ? b.items : [])
		.slice(0, 200)
		.map((it) => {
			const name = str(it.name, 255);
			const quantity = Math.max(1, Math.min(100000, parseInt(it.quantity, 10) || 1));
			const unit_price = money(it.price);
			return name ? { name, sku: str(it.sku, 120) || null, quantity, unit_price, total: Math.round(unit_price * quantity * 100) / 100 } : null;
		})
		.filter(Boolean);
	if (!items.length) throw httpErr(400, "orders.new.e_items");
	const ci = l.contact_info;
	const parts = String(ci.name || "").trim().split(/\s+/);
	const client = { firstname: parts[0] || null, lastname: parts.slice(1).join(" ") || null, phone: str(ci.phone, 32) || null, email: str(ci.email, 120) || null };
	if (!client.phone && !client.email) throw httpErr(400, "orders.new.e_contact");
	const total = Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100;
	const body = {
		source: { external_id: "lead_" + l.id + "_" + crypto.randomBytes(6).toString("hex"), channel: "manual" },
		client,
		items,
		summary: { total_products: total, total_shipping: 0, total_discount: 0, total },
		totals: [
			{ code: "sub_total", title: t("orders.new.subtotal"), value: total },
			{ code: "total", title: t("orders.new.total"), value: total },
		],
		addresses: [{ type: "shipping", firstname: client.firstname, lastname: client.lastname, phone: client.phone, email: client.email }],
		note: str(b.note, 999) || null,
		__id_integration: source.id,
		__can_create_clients: 1,
		__user: idUser,
	};
	const conn = await pool.getConnection();
	let id;
	try {
		await conn.beginTransaction();
		id = await require("../orders/inboxProcessor").createOrderFromPayload(conn, body);
		await conn.query(`UPDATE \`${P}orders\` SET id_user = ? WHERE id = ?`, [l.id_manager || idUser, id]);
		await conn.commit();
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
	try {
		require("../orders/notify").fire(id, "new");
	} catch (e) {
		logging.error(e);
	}
	await markConverted(l, "order", id, idUser, ip);
	return { id, url: `/orders/${id}/` };
}

module.exports = {
	ACT_TYPES,
	ACT_STATUS,
	activities,
	addActivity,
	setActivityStatus,
	deleteActivity,
	upload,
	files,
	addFile,
	deleteFile,
	serveFile,
	conversions,
	orderSources,
	toClient,
	toDeal,
	toOrder,
	CATEGORIES,
};