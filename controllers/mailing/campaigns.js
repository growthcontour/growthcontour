"use strict";
/**
 * Адмінка: шаблони, контент листів, картинки редактора, кампанії (CRUD, тест, запуск, пауза, скасування), звіти.
 * Лише параметризований SQL; дозволені переходи статусів — явна таблиця.
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const model = require("./model");
const render = require("./render");
const sender = require("./sender");
const audience = require("./audience");

const { pool, T, err } = model;
const jsonOf = (v) => (typeof v === "string" ? JSON.parse(v) : v || null);

// ═══ ШАБЛОНИ ════════════════════════════════════════════
async function templates(q) {
	const where = ["t.deleted = 0"];
	const params = [];
	const s = String(q.search || "").trim();
	if (s.length >= 2) {
		where.push("t.name LIKE ?");
		params.push(`%${s.replace(/[%_\\]/g, "\\$&")}%`);
	}
	const w = where.join(" AND ");
	const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.templates} t WHERE ${w}`, params);
	const [rows] = await pool.query(
		`SELECT t.id, t.name, t.date_add, t.date_edit,
                (SELECT GROUP_CONCAT(c.id_lang) FROM ${T.contents} c WHERE c.owner_type = 'template' AND c.id_owner = t.id) AS langs
           FROM ${T.templates} t WHERE ${w} ORDER BY COALESCE(t.date_edit, t.date_add) DESC LIMIT ? OFFSET ?`,
		[...params, q.size, (q.page - 1) * q.size]
	);
	const total = Number(cnt.n) || 0;
	return { last_page: Math.max(1, Math.ceil(total / q.size)), last_row: total, data: rows };
}

async function template(id) {
	const [[t]] = await pool.query(`SELECT * FROM ${T.templates} WHERE id = ? AND deleted = 0`, [id]);
	if (!t) throw err(404, "not_found");
	t.contents = await contents("template", id);
	return t;
}

async function saveTemplate(id, d, idUser) {
	if (id) {
		const [r] = await pool.query(`UPDATE ${T.templates} SET name = ?, date_edit = UTC_TIMESTAMP() WHERE id = ? AND deleted = 0`, [d.name, id]);
		if (!r.affectedRows) throw err(404, "not_found");
		return { ok: true, id };
	}
	const [r] = await pool.query(`INSERT INTO ${T.templates} (name, id_user, date_add) VALUES (?, ?, UTC_TIMESTAMP())`, [d.name, idUser || null]);
	return { ok: true, id: r.insertId };
}

async function deleteTemplate(id, idUser) {
	await pool.query(`UPDATE ${T.templates} SET deleted = 1, date_deleted = UTC_TIMESTAMP(), id_user_deleted = ? WHERE id = ?`, [idUser || null, id]);
	return { ok: true };
}

async function copyContents(conn, fromType, fromId, toType, toId) {
	await conn.query(`DELETE FROM ${T.contents} WHERE owner_type = ? AND id_owner = ?`, [toType, toId]);
	await conn.query(
		`INSERT INTO ${T.contents} (owner_type, id_owner, id_lang, subject, preheader, editor, project, source, html, text, size_bytes, warnings, date_edit)
         SELECT ?, ?, id_lang, subject, preheader, editor, project, source, html, text, size_bytes, warnings, UTC_TIMESTAMP()
           FROM ${T.contents} WHERE owner_type = ? AND id_owner = ?`,
		[toType, toId, fromType, fromId]
	);
}

async function copyTemplate(id, idUser) {
	const t = await template(id);
	return model.withTx(async (conn) => {
		const [r] = await conn.query(`INSERT INTO ${T.templates} (name, id_user, date_add) VALUES (?, ?, UTC_TIMESTAMP())`, [String(t.name).slice(0, 240) + " (2)", idUser || null]);
		await copyContents(conn, "template", id, "template", r.insertId);
		return { ok: true, id: r.insertId };
	});
}

// ═══ КОНТЕНТ ════════════════════════════════════════════
async function contents(ownerType, idOwner) {
	const [rows] = await pool.query(
		`SELECT id, id_lang, subject, preheader, editor, source, html, size_bytes, warnings, date_edit
           FROM ${T.contents} WHERE owner_type = ? AND id_owner = ? ORDER BY id_lang`,
		[ownerType, idOwner]
	);
	return rows.map((r) => ({ ...r, warnings: jsonOf(r.warnings) || [] }));
}

/** Власник має існувати і бути редагованим (варіант — лише кампанії в чернетці) */
async function assertOwnerEditable(ownerType, idOwner) {
	if (ownerType === "template") {
		const [[t]] = await pool.query(`SELECT id FROM ${T.templates} WHERE id = ? AND deleted = 0`, [idOwner]);
		if (!t) throw err(404, "not_found");
		return null;
	}
	const [[v]] = await pool.query(
		`SELECT v.id, c.id AS id_campaign, c.status, c.type FROM ${T.variants} v INNER JOIN ${T.campaigns} c ON c.id = v.id_campaign AND c.deleted = 0 WHERE v.id = ?`,
		[idOwner]
	);
	if (!v) throw err(404, "not_found");
	// Листи автоматизацій редагуються завжди — зміни підхоплюють наступні листи
	if (v.status !== "draft" && v.type !== "automation") throw err(409, "campaign_not_editable");
	return v.id_campaign;
}

async function saveContent(d) {
	const idCampaign = await assertOwnerEditable(d.owner_type, d.id_owner);
	if (!(await model.languages()).has(d.id_lang)) throw err(400, "validation_error", { errors: [{ field: "id_lang", message: "invalid" }] });
	const c = await render.compileContent({ source: d.source });
	await pool.query(
		`INSERT INTO ${T.contents} (owner_type, id_owner, id_lang, subject, preheader, editor, project, source, html, text, size_bytes, warnings, date_edit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP()) AS n
         ON DUPLICATE KEY UPDATE subject = n.subject, preheader = n.preheader, editor = n.editor, project = n.project, source = n.source,
                                 html = n.html, text = n.text, size_bytes = n.size_bytes, warnings = n.warnings, date_edit = n.date_edit`,
		[d.owner_type, d.id_owner, d.id_lang, String(d.subject || "").replace(/[\r\n]+/g, " ").slice(0, 255), d.preheader || null, "html", null, d.source, c.html, c.text, c.size, JSON.stringify(c.warnings)]
	);
	if (d.owner_type === "template") await pool.query(`UPDATE ${T.templates} SET date_edit = UTC_TIMESTAMP() WHERE id = ?`, [d.id_owner]);
	if (idCampaign) render.clearCache(idCampaign);
	return { ok: true, size: c.size, warnings: c.warnings };
}

async function deleteContent(ownerType, idOwner, idLang) {
	await assertOwnerEditable(ownerType, idOwner);
	await pool.query(`DELETE FROM ${T.contents} WHERE owner_type = ? AND id_owner = ? AND id_lang = ?`, [ownerType, idOwner, idLang]);
	return { ok: true };
}

/** Превʼю/перевірка без збереження */
async function compile(d) {
	const c = await render.compileContent(d);
	return { ok: true, html: c.html, text: c.text, size: c.size, warnings: c.warnings };
}

// ═══ КАРТИНКИ РЕДАКТОРА (публічні: їх завантажують поштові клієнти) ═══
const IMAGE_DIR = path.join(__dirname, "..", "..", "assets", "mailing", "images");
fs.mkdirSync(IMAGE_DIR, { recursive: true, mode: 0o755 });
const IMAGE_SIG = [
	{ ext: ".jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
	{ ext: ".png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
	{ ext: ".gif", test: (b) => b.subarray(0, 6).toString("ascii") === "GIF87a" || b.subarray(0, 6).toString("ascii") === "GIF89a" },
	{ ext: ".webp", test: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
];

let imageUploader = null;
/** Multer у памʼять (≤ 5 МБ), тип визначається за вмістом, SVG заборонено (XSS) */
function imageUploadMiddleware(req, res, next) {
	if (!imageUploader) {
		const multer = require("multer");
		imageUploader = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5, parts: 6 } }).single("file");
	}
	imageUploader(req, res, (e) => (e ? res.status(400).json({ ok: false, error: e.code === "LIMIT_FILE_SIZE" ? "file_too_large" : "upload_failed" }) : next()));
}

async function saveImage(file) {
	if (!file || !file.buffer || file.buffer.length < 12) throw err(400, "file_required");
	const sig = IMAGE_SIG.find((s) => s.test(file.buffer));
	if (!sig) throw err(400, "image_invalid");
	// Імʼя = хеш вмісту: однакові картинки не дублюються
	const name = crypto.createHash("sha256").update(file.buffer).digest("hex").slice(0, 32) + sig.ext;
	const full = path.join(IMAGE_DIR, name);
	if (!fs.existsSync(full)) await fsp.writeFile(full, file.buffer, { mode: 0o644, flag: "wx" }).catch((e) => (e.code === "EEXIST" ? null : Promise.reject(e)));
	return { ok: true, url: `${render.publicBase()}/assets/mailing/images/${name}` };
}

// ═══ КАМПАНІЇ ═══════════════════════════════════════════
const CAMP_SORTS = { id: "c.id", name: "c.name", status: "c.status", date_add: "c.date_add", date_launched: "c.date_launched", cnt_sent: "c.cnt_sent" };
const CAMP_STATUSES = new Set(["draft", "scheduled", "preparing", "sending", "paused", "sent", "cancelled", "failed"]);

async function campaigns(q) {
	const where = ["c.deleted = 0", "c.type <> 'automation'"];
	const params = [];
	if (CAMP_STATUSES.has(q.status)) {
		where.push("c.status = ?");
		params.push(q.status);
	}
	const s = String(q.search || "").trim();
	if (s.length >= 2) {
		where.push("c.name LIKE ?");
		params.push(`%${s.replace(/[%_\\]/g, "\\$&")}%`);
	}
	const w = where.join(" AND ");
	const sort = Array.isArray(q.sort) && q.sort[0] && CAMP_SORTS[q.sort[0].field] ? `${CAMP_SORTS[q.sort[0].field]} ${q.sort[0].dir === "asc" ? "ASC" : "DESC"}` : "c.id DESC";
	const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.campaigns} c WHERE ${w}`, params);
	const [rows] = await pool.query(
		`SELECT c.id, c.name, c.type, c.status, c.send_mode, c.date_scheduled, c.date_launched, c.date_finished, c.last_error,
                c.cnt_total, c.cnt_sent, c.cnt_failed, c.cnt_skipped, c.cnt_bounced, c.cnt_opened_human, c.cnt_clicked,
                c.cnt_unsubscribed, c.cnt_complained, c.date_add, s.name AS sender_name
           FROM ${T.campaigns} c LEFT JOIN ${T.senders} s ON s.id = c.id_sender
          WHERE ${w} ORDER BY ${sort} LIMIT ? OFFSET ?`,
		[...params, q.size, (q.page - 1) * q.size]
	);
	const total = Number(cnt.n) || 0;
	return { last_page: Math.max(1, Math.ceil(total / q.size)), last_row: total, data: rows };
}

async function getCampaign(id) {
	const [[c]] = await pool.query(`SELECT * FROM ${T.campaigns} WHERE id = ? AND deleted = 0`, [id]);
	if (!c) throw err(404, "not_found");
	c.audience = jsonOf(c.audience) || { lists: [] };
	c.utm = jsonOf(c.utm);
	const [variants] = await pool.query(`SELECT * FROM ${T.variants} WHERE id_campaign = ? ORDER BY code`, [id]);
	for (const v of variants) v.contents = await contents("variant", v.id);
	c.variants = variants;
	return c;
}

/** Зберегти чернетку. Варіанти: синхронізуються з переданим списком (A завжди є). */
async function saveCampaign(id, d, idUser) {
	if (d.id_sender) {
		const s = await sender.getPublic(d.id_sender);
		if (!s) throw err(400, "validation_error", { errors: [{ field: "id_sender", message: "invalid" }] });
	}
	// Перевірка сегмента (білий список полів/операторів) ще на етапі чернетки
	if (d.audience && d.audience.segment) await audience.build({ ...d.audience, lists: [1] });

	const cols = {
		name: d.name,
		type: d.type,
		id_sender: d.id_sender || null,
		id_parent: d.type === "resend" ? d.id_parent || null : null,
		audience: JSON.stringify(d.audience || { lists: [] }),
		send_mode: d.send_mode,
		date_scheduled: d.send_mode === "now" ? null : d.date_scheduled ? String(d.date_scheduled).replace("T", " ").slice(0, 19) : null,
		ab_percent: d.type === "ab" ? d.ab_percent || 20 : null,
		ab_metric: d.type === "ab" ? d.ab_metric || "open" : null,
		ab_wait_minutes: d.type === "ab" ? d.ab_wait_minutes || 240 : null,
		track_opens: d.track_opens ? 1 : 0,
		track_clicks: d.track_clicks ? 1 : 0,
		utm: d.utm ? JSON.stringify(d.utm) : null,
		ignore_frequency_cap: d.ignore_frequency_cap ? 1 : 0,
	};
	const keys = Object.keys(cols); // фіксований набір колонок

	return model.withTx(async (conn) => {
		let cid = id;
		if (id) {
			const [[cur]] = await conn.query(`SELECT status, type FROM ${T.campaigns} WHERE id = ? AND deleted = 0 FOR UPDATE`, [id]);
			if (!cur) throw err(404, "not_found");
			if (cur.status !== "draft" || cur.type === "automation") throw err(409, "campaign_not_editable");
			await conn.query(`UPDATE ${T.campaigns} SET ${keys.map((k) => `\`${k}\` = ?`).join(", ")}, date_edit = UTC_TIMESTAMP() WHERE id = ?`, [...keys.map((k) => cols[k]), id]);
		} else {
			const [r] = await conn.query(`INSERT INTO ${T.campaigns} (${keys.map((k) => `\`${k}\``).join(", ")}, status, id_user, date_add) VALUES (${keys.map(() => "?").join(", ")}, 'draft', ?, UTC_TIMESTAMP())`, [...keys.map((k) => cols[k]), idUser || null]);
			cid = r.insertId;
		}

		const wanted = d.type === "ab" ? (d.variants && d.variants.length ? d.variants : [{ code: "A" }, { code: "B" }]) : [{ code: "A", from_name: (d.variants || []).find((v) => v.code === "A")?.from_name }];
		const codes = [...new Set(wanted.map((v) => v.code))];
		if (!codes.includes("A")) codes.unshift("A");
		for (const code of codes) {
			const v = wanted.find((x) => x.code === code) || {};
			await conn.query(
				`INSERT INTO ${T.variants} (id_campaign, code, from_name) VALUES (?, ?, ?) AS n ON DUPLICATE KEY UPDATE from_name = n.from_name`,
				[cid, code, v.from_name || null]
			);
		}
		// Видалені варіанти — разом з контентом
		const [old] = await conn.query(`SELECT id FROM ${T.variants} WHERE id_campaign = ? AND code NOT IN (?)`, [cid, codes]);
		if (old.length) {
			await conn.query(`DELETE FROM ${T.contents} WHERE owner_type = 'variant' AND id_owner IN (?)`, [old.map((r) => r.id)]);
			await conn.query(`DELETE FROM ${T.variants} WHERE id IN (?)`, [old.map((r) => r.id)]);
		}
		render.clearCache(cid);
		return { ok: true, id: cid };
	});
}

async function applyTemplate(idCampaign, idVariant, idTemplate) {
	await assertOwnerEditable("variant", idVariant);
	const [[t]] = await pool.query(`SELECT id FROM ${T.templates} WHERE id = ? AND deleted = 0`, [idTemplate]);
	if (!t) throw err(404, "not_found");
	await model.withTx((conn) => copyContents(conn, "template", idTemplate, "variant", idVariant));
	render.clearCache(idCampaign);
	return { ok: true };
}

async function copyCampaign(id, idUser) {
	const c = await getCampaign(id);
	if (c.type === "automation") throw err(409, "campaign_not_editable");
	return model.withTx(async (conn) => {
		const [r] = await conn.query(
			`INSERT INTO ${T.campaigns} (name, type, status, id_sender, audience, send_mode, ab_percent, ab_metric, ab_wait_minutes,
                                         track_opens, track_clicks, utm, ignore_frequency_cap, id_user, date_add)
             SELECT LEFT(CONCAT(name, ' (2)'), 255), IF(type = 'resend', 'regular', type), 'draft', id_sender, audience, 'now', ab_percent, ab_metric, ab_wait_minutes,
                    track_opens, track_clicks, utm, ignore_frequency_cap, ?, UTC_TIMESTAMP()
               FROM ${T.campaigns} WHERE id = ?`,
			[idUser || null, id]
		);
		for (const v of c.variants) {
			const [rv] = await conn.query(`INSERT INTO ${T.variants} (id_campaign, code, from_name) VALUES (?, ?, ?)`, [r.insertId, v.code, v.from_name]);
			await copyContents(conn, "variant", v.id, "variant", rv.insertId);
		}
		return { ok: true, id: r.insertId };
	});
}

/** «Повторити тим, хто не відкрив» — нова кампанія-чернетка з аудиторією від вихідної */
async function createResend(id, mode, idUser) {
	const c = await getCampaign(id);
	if (c.status !== "sent") throw err(409, "campaign_not_sent");
	const r = await copyCampaign(id, idUser);
	const aud = { ...c.audience, resend_of: id, resend_mode: mode === "not_clicked" ? "not_clicked" : "not_opened" };
	await pool.query(`UPDATE ${T.campaigns} SET type = 'resend', id_parent = ?, audience = ? WHERE id = ?`, [id, JSON.stringify(aud), r.id]);
	return r;
}

async function deleteCampaign(id, idUser) {
	const [r] = await pool.query(
		`UPDATE ${T.campaigns} SET deleted = 1, date_deleted = UTC_TIMESTAMP(), id_user_deleted = ?
          WHERE id = ? AND type <> 'automation' AND status IN ('draft','sent','cancelled','failed')`,
		[idUser || null, id]
	);
	if (!r.affectedRows) throw err(409, "campaign_active");
	return { ok: true };
}

// ─── ПЕРЕВІРКА ПЕРЕД ЗАПУСКОМ ───────────────────────────
async function checklist(c) {
	const problems = [];
	const s = await model.getSettings();
	if (!c.id_sender) problems.push("no_sender");
	else {
		const snd = await sender.getPublic(c.id_sender);
		if (!snd || !snd.active) problems.push("sender_inactive");
	}
	if (!c.audience || !model.ints(c.audience.lists).length) problems.push("no_lists");
	if (c.type === "ab") {
		if (c.variants.length < 2) problems.push("ab_variants");
		if (c.send_mode === "timezone") problems.push("ab_timezone");
	}
	for (const v of c.variants) {
		const def = v.contents.find((x) => x.id_lang === s.default_id_lang) || v.contents[0];
		if (!def) {
			problems.push("no_content:" + v.code);
			continue;
		}
		for (const x of v.contents) {
			if (!String(x.subject || "").trim()) problems.push(`no_subject:${v.code}:${x.id_lang}`);
			if (!x.html) problems.push(`no_html:${v.code}:${x.id_lang}`);
			if ((x.warnings || []).some((w) => w.level === "error")) problems.push(`content_errors:${v.code}:${x.id_lang}`);
		}
	}
	if (c.send_mode !== "now") {
		if (!c.date_scheduled) problems.push("no_date");
		else if (c.send_mode === "scheduled" && new Date(String(c.date_scheduled).replace(" ", "T") + "Z") < new Date(Date.now() - 60000)) problems.push("date_past");
	}
	let count = 0;
	if (!problems.includes("no_lists")) {
		count = await audience.count(c.audience);
		if (!count) problems.push("audience_empty");
	}
	return { ok: !problems.length, problems, count };
}

async function check(id) {
	return checklist(await getCampaign(id));
}

// ─── ТЕСТОВИЙ ЛИСТ ──────────────────────────────────────
async function sendTest(id, d) {
	const c = await getCampaign(id);
	const v = d.id_variant ? c.variants.find((x) => x.id === d.id_variant) : c.variants[0];
	if (!v) throw err(400, "validation_error", { errors: [{ field: "id_variant", message: "invalid" }] });
	const snd = c.id_sender ? await sender.get(c.id_sender) : null;
	if (!snd) throw err(400, "no_sender");

	let person = { first_name: "", last_name: "", fields: null, id_lang: d.id_lang || (await model.getSettings()).default_id_lang };
	if (d.id_contact) {
		const ct = await model.getContact(d.id_contact);
		if (ct && !ct.deleted) person = { first_name: ct.first_name, last_name: ct.last_name, fields: ct.fields, id_lang: d.id_lang || ct.id_lang };
	}
	// id = 0: токени недійсні, трекінг вимкнено — тестовий лист не впливає на статистику
	const camp = { id: c.id, name: c.name, track_opens: false, track_clicks: false, utm: c.utm };
	const sent = [];
	for (const to of d.emails) {
		const n = model.normalizeEmail(to);
		if (!n) continue;
		const mail = await render.buildMessage({ id: 0, id_variant: v.id, id_lang: person.id_lang, email: n.email, ...person }, camp, snd);
		await sender.send(snd, {
			from: { name: v.from_name || snd.from_name, address: snd.from_email },
			replyTo: snd.reply_to || undefined,
			to: n.email,
			subject: mail.subject,
			html: mail.html,
			text: mail.text,
			headers: { "X-GC-Test": "1" },
		});
		sent.push(n.email);
	}
	return { ok: true, sent };
}

// ─── СТАТУСИ ────────────────────────────────────────────
async function schedule(id, idUser) {
	const c = await getCampaign(id);
	if (c.status !== "draft" || c.type === "automation") throw err(409, "campaign_not_editable");
	const r = await checklist(c);
	if (!r.ok) throw err(400, "campaign_not_ready", { problems: r.problems });
	const [u] = await pool.query(`UPDATE ${T.campaigns} SET status = 'scheduled', id_user_launched = ?, last_error = NULL WHERE id = ? AND status = 'draft'`, [idUser || null, id]);
	if (!u.affectedRows) throw err(409, "campaign_not_editable");
	render.clearCache(id);
	return { ok: true, count: r.count };
}

/** scheduled → draft (поки відправка не почалась) */
async function unschedule(id) {
	const [r] = await pool.query(`UPDATE ${T.campaigns} SET status = 'draft' WHERE id = ? AND status = 'scheduled'`, [id]);
	if (!r.affectedRows) throw err(409, "campaign_wrong_status");
	return { ok: true };
}

async function pause(id) {
	const [r] = await pool.query(`UPDATE ${T.campaigns} SET status = 'paused' WHERE id = ? AND status IN ('preparing','sending')`, [id]);
	if (!r.affectedRows) throw err(409, "campaign_wrong_status");
	return { ok: true };
}

/** Продовжити: якщо розгортання не завершилось — знову 'preparing' (fanOut ідемпотентний) */
async function resume(id) {
	const [[c]] = await pool.query(`SELECT status, cnt_total FROM ${T.campaigns} WHERE id = ? AND deleted = 0`, [id]);
	if (!c || c.status !== "paused") throw err(409, "campaign_wrong_status");
	const [[m]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.messages} WHERE id_campaign = ?`, [id]);
	const next = Number(c.cnt_total) > 0 && Number(m.n) >= Number(c.cnt_total) ? "sending" : "preparing";
	await pool.query(`UPDATE ${T.campaigns} SET status = ?, last_error = NULL WHERE id = ? AND status = 'paused'`, [next, id]);
	return { ok: true, status: next };
}

async function cancel(id) {
	const [r] = await pool.query(`UPDATE ${T.campaigns} SET status = 'cancelled', date_finished = UTC_TIMESTAMP() WHERE id = ? AND status IN ('scheduled','preparing','sending','paused')`, [id]);
	if (!r.affectedRows) throw err(409, "campaign_wrong_status");
	await pool.query(`UPDATE ${T.messages} SET status = 'cancelled' WHERE id_campaign = ? AND status IN ('queued','waiting')`, [id]);
	return { ok: true };
}

// ═══ ЗВІТ ═══════════════════════════════════════════════
async function stats(id) {
	const c = await getCampaign(id);
	await require("./queue").recountStats([id]);
	const [[fresh]] = await pool.query(`SELECT * FROM ${T.campaigns} WHERE id = ?`, [id]);

	const [byVariant] = await pool.query(
		`SELECT m.id_variant, v.code, COUNT(*) AS total, SUM(m.status = 'sent') AS sent,
                SUM(m.date_first_open_human IS NOT NULL OR m.date_first_click IS NOT NULL) AS opened,
                SUM(m.date_first_click IS NOT NULL) AS clicked, SUM(m.date_unsubscribed IS NOT NULL) AS unsubscribed
           FROM ${T.messages} m LEFT JOIN ${T.variants} v ON v.id = m.id_variant
          WHERE m.id_campaign = ? GROUP BY m.id_variant, v.code ORDER BY v.code`,
		[id]
	);
	const [byStatus] = await pool.query(`SELECT status, skip_reason, COUNT(*) AS n FROM ${T.messages} WHERE id_campaign = ? GROUP BY status, skip_reason`, [id]);
	const [links] = await pool.query(`SELECT id, url, cnt_clicks, cnt_clicks_unique FROM ${T.links} WHERE id_campaign = ? ORDER BY cnt_clicks_unique DESC, id LIMIT 100`, [id]);
	const [devices] = await pool.query(
		`SELECT COALESCE(device, 'unknown') AS device, COUNT(DISTINCT id_message) AS n FROM ${T.events}
          WHERE id_campaign = ? AND type IN ('open','click') AND is_machine = 0 GROUP BY device ORDER BY n DESC`,
		[id]
	);
	const [clients] = await pool.query(
		`SELECT COALESCE(mail_client, 'unknown') AS mail_client, COUNT(DISTINCT id_message) AS n FROM ${T.events}
          WHERE id_campaign = ? AND type = 'open' GROUP BY mail_client ORDER BY n DESC LIMIT 20`,
		[id]
	);
	const [machine] = await pool.query(
		`SELECT machine_reason, COUNT(*) AS n FROM ${T.events} WHERE id_campaign = ? AND is_machine = 1 GROUP BY machine_reason`,
		[id]
	);
	// Відкриття/кліки по годинах за перші 7 днів після запуску
	const [timeline] = await pool.query(
		`SELECT DATE_FORMAT(date_add, '%Y-%m-%d %H:00:00') AS hour, type, COUNT(DISTINCT id_message) AS n
           FROM ${T.events}
          WHERE id_campaign = ? AND type IN ('open','click') AND is_machine = 0
            AND date_add < COALESCE(?, UTC_TIMESTAMP()) + INTERVAL 7 DAY
          GROUP BY hour, type ORDER BY hour`,
		[id, c.date_launched]
	);
	return { campaign: { ...fresh, audience: jsonOf(fresh.audience), utm: jsonOf(fresh.utm) }, by_variant: byVariant, by_status: byStatus, links, devices, clients, machine, timeline };
}

const REC_SORTS = { id: "m.id", email: "m.email", status: "m.status", date_sent: "m.date_sent", date_first_open_human: "m.date_first_open_human", date_first_click: "m.date_first_click", cnt_clicks: "m.cnt_clicks" };
const REC_FILTERS = {
	opened: "(m.date_first_open_human IS NOT NULL OR m.date_first_click IS NOT NULL)",
	not_opened: "(m.status = 'sent' AND m.date_first_open_human IS NULL AND m.date_first_click IS NULL)",
	clicked: "m.date_first_click IS NOT NULL",
	bounced: "m.bounce_type IS NOT NULL",
	unsubscribed: "m.date_unsubscribed IS NOT NULL",
	complained: "m.date_complained IS NOT NULL",
	failed: "m.status = 'failed'",
	skipped: "m.status = 'skipped'",
	queued: "m.status IN ('queued','sending','waiting')",
};

async function recipients(id, q) {
	const where = ["m.id_campaign = ?"];
	const params = [id];
	if (REC_FILTERS[q.filter]) where.push(REC_FILTERS[q.filter]);
	const s = String(q.search || "").trim().toLowerCase();
	if (s.length >= 2) {
		where.push("m.email LIKE ?");
		params.push(`%${s.replace(/[%_\\]/g, "\\$&")}%`);
	}
	const w = where.join(" AND ");
	const sort = Array.isArray(q.sort) && q.sort[0] && REC_SORTS[q.sort[0].field] ? `${REC_SORTS[q.sort[0].field]} ${q.sort[0].dir === "asc" ? "ASC" : "DESC"}` : "m.id ASC";
	const [[cnt]] = await pool.query(`SELECT COUNT(*) AS n FROM ${T.messages} m WHERE ${w}`, params);
	const [rows] = await pool.query(
		`SELECT m.id, m.id_contact, m.email, v.code AS variant, m.status, m.skip_reason, m.bounce_type, m.smtp_response, m.attempts,
                m.date_sent, m.date_first_open_human, m.cnt_opens, m.date_first_click, m.cnt_clicks, m.date_unsubscribed, m.date_complained
           FROM ${T.messages} m LEFT JOIN ${T.variants} v ON v.id = m.id_variant
          WHERE ${w} ORDER BY ${sort} LIMIT ? OFFSET ?`,
		[...params, q.size, (q.page - 1) * q.size]
	);
	const total = Number(cnt.n) || 0;
	return { last_page: Math.max(1, Math.ceil(total / q.size)), last_row: total, data: rows };
}

module.exports = {
	templates,
	template,
	saveTemplate,
	deleteTemplate,
	copyTemplate,
	contents,
	saveContent,
	deleteContent,
	compile,
	imageUploadMiddleware,
	saveImage,
	campaigns,
	getCampaign,
	saveCampaign,
	applyTemplate,
	copyCampaign,
	createResend,
	deleteCampaign,
	check,
	sendTest,
	schedule,
	unschedule,
	pause,
	resume,
	cancel,
	stats,
	recipients,
};