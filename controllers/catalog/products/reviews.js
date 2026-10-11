"use strict";

/**
 * Відгуки про товари: модерація, відповіді магазину, фото, агрегати рейтингу
 * та двобічний обмін з магазинами (reviews.list ← магазин, reviews.update → магазин).
 */
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const images = require("./images");
const languages = require("./languages");
const client = require("./sync-client");
const { validateReview, validateModeration, trimOrNull, STATUSES } = require("../../../validator/catalog/products/reviews");

const P = config.get("configDatabase").prefix;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

function httpErr(status, message, errors) {
	return Object.assign(new Error(message), { status, errors });
}

async function tx(fn) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const r = await fn(conn);
		await conn.commit();
		return r;
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
}

/** Перерахунок rating_avg / reviews_count товару (лише схвалені). Не змінює version — це статистика */
async function recalc(conn, idProducts) {
	const ids = [...new Set((Array.isArray(idProducts) ? idProducts : [idProducts]).filter(Boolean).map(Number))];
	for (const id of ids) {
		await conn.query(
			`UPDATE ${P}products p
			    SET p.rating_avg = (SELECT ROUND(AVG(r.rating), 2) FROM ${P}products_reviews r WHERE r.id_product = p.id AND r.status = 'approved'),
			        p.reviews_count = (SELECT COUNT(*) FROM ${P}products_reviews r WHERE r.id_product = p.id AND r.status = 'approved')
			  WHERE p.id = ?`,
			[id]
		);
	}
}

async function setMedia(conn, idReview, files) {
	const [old] = await conn.query(`SELECT file FROM ${P}products_reviews_media WHERE id_review = ?`, [idReview]);
	await conn.query(`DELETE FROM ${P}products_reviews_media WHERE id_review = ?`, [idReview]);
	if (files.length) await conn.query(`INSERT INTO ${P}products_reviews_media (id_review, file, sort_order) VALUES ?`, [files.map((f, i) => [idReview, f, i])]);
	return old.map((o) => o.file).filter((f) => !files.includes(f));
}

/* ═══ СПИСОК ═══ */

const SORTS = { date_add: "r.date_add", rating: "r.rating", status: "r.status", id: "r.id" };

async function list(q, idLang) {
	const page = Math.max(1, parseInt(q.page, 10) || 1);
	const size = Math.min(200, Math.max(10, parseInt(q.size, 10) || 50));
	const where = ["r.deleted_at IS NULL"];
	const params = [];
	const add = (sql, ...vals) => {
		where.push(sql);
		params.push(...vals);
	};
	if (q.status && STATUSES.includes(q.status)) add("r.status = ?", q.status);
	if (q.rating && /^[1-5]$/.test(String(q.rating))) add("r.rating = ?", Number(q.rating));
	if (q.id_product && /^\d+$/.test(String(q.id_product))) add("r.id_product = ?", Number(q.id_product));
	if (q.source === "crm") add("r.id_integration IS NULL");
	else if (q.source && /^\d+$/.test(String(q.source))) add("r.id_integration = ?", Number(q.source));
	if (q.unmatched) where.push("r.id_product IS NULL");
	if (q.no_reply) where.push("r.reply IS NULL");
	const s = String(q.search || "").trim().slice(0, 100);
	if (s) {
		const like = "%" + s.replace(/[\\%_]/g, "\\$&") + "%";
		where.push("(r.author_name LIKE ? OR r.author_email LIKE ? OR r.title LIKE ? OR r.body LIKE ?)");
		params.push(like, like, like, like);
	}
	const sortCol = SORTS[q.sort] || "r.date_add";
	const dir = q.dir === "asc" ? "ASC" : "DESC";

	const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${P}products_reviews r WHERE ${where.join(" AND ")}`, params);
	const [rows] = await pool.query(
		`SELECT r.id, r.id_product, r.id_variant, r.id_integration, r.external_id, r.external_product_id, r.rating, r.title,
		        LEFT(r.body, 300) AS body, r.author_name, r.author_email, r.verified_purchase, r.status, r.reply IS NOT NULL AS has_reply,
		        r.need_push, r.date_add, p.sku, i.name AS integration_name,
		        COALESCE(NULLIF(d.name, ''), (SELECT d2.name FROM ${P}products_description d2 WHERE d2.id_product = r.id_product ORDER BY d2.id_lang LIMIT 1)) AS product_name,
		        (SELECT COUNT(*) FROM ${P}products_reviews_media m WHERE m.id_review = r.id) AS photos
		   FROM ${P}products_reviews r
		   LEFT JOIN ${P}products p ON p.id = r.id_product
		   LEFT JOIN ${P}products_description d ON d.id_product = r.id_product AND d.id_lang = ?
		   LEFT JOIN ${P}settings_integrations i ON i.id = r.id_integration
		  WHERE ${where.join(" AND ")}
		  ORDER BY ${sortCol} ${dir}, r.id DESC
		  LIMIT ? OFFSET ?`,
		[idLang, ...params, size, (page - 1) * size]
	);
	const [[counts]] = await pool.query(
		`SELECT SUM(status = 'pending') AS pending, SUM(status = 'approved') AS approved, SUM(status = 'rejected') AS rejected, SUM(status = 'spam') AS spam,
		        SUM(id_product IS NULL) AS unmatched
		   FROM ${P}products_reviews WHERE deleted_at IS NULL`
	);
	return { ok: true, data: rows, last_page: Math.max(1, Math.ceil(Number(total) / size)), total: Number(total), counts };
}

async function get(id) {
	const [[row]] = await pool.query(
		`SELECT r.*, i.name AS integration_name, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS reply_user
		   FROM ${P}products_reviews r
		   LEFT JOIN ${P}settings_integrations i ON i.id = r.id_integration
		   LEFT JOIN ${P}users u ON u.id = r.id_user_reply
		  WHERE r.id = ?`,
		[id]
	);
	if (!row) throw httpErr(404, "Not found");
	delete row.ip;
	const [media] = await pool.query(`SELECT file FROM ${P}products_reviews_media WHERE id_review = ? ORDER BY sort_order, id`, [id]);
	row.media = media.map((m) => ({ file: m.file, url: images.url("products", m.file, "medium"), url_large: images.url("products", m.file, "large") }));
	return row;
}

/* ═══ ЗАПИС ═══ */

/** Створення/редагування в CRM. Відгуки з магазину: автор, оцінка і текст лишаються як у магазині */
async function save(id, body, ctx) {
	const v = validateReview(body);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);
	const d = v.data;
	let removed = [];
	const result = await tx(async (conn) => {
		const [[p]] = await conn.query(`SELECT id FROM ${P}products WHERE id = ? AND deleted_at IS NULL`, [d.id_product]);
		if (!p) throw httpErr(400, "Validation failed", [{ field: "id_product", message: "product not found" }]);
		if (d.id_variant) {
			const [[vr]] = await conn.query(`SELECT id FROM ${P}products_variants WHERE id = ? AND id_product = ?`, [d.id_variant, d.id_product]);
			if (!vr) throw httpErr(400, "Validation failed", [{ field: "id_variant", message: "variant not found" }]);
		}
		let before = null;
		if (id) {
			[[before]] = await conn.query(`SELECT * FROM ${P}products_reviews WHERE id = ? FOR UPDATE`, [id]);
			if (!before) throw httpErr(404, "Not found");
		}
		const external = before && before.id_integration;
		const replyChanged = (before ? before.reply : null) !== d.reply;
		const cols = {
			id_product: d.id_product,
			id_variant: d.id_variant,
			id_lang: d.id_lang,
			status: d.status,
			reply: d.reply,
			...(replyChanged ? { reply_at: d.reply ? new Date() : null, id_user_reply: d.reply ? ctx.idUser : null } : {}),
			...(external
				? {}
				: {
						rating: d.rating,
						author_name: d.author_name,
						author_email: d.author_email,
						title: d.title,
						body: d.body,
						pros: d.pros,
						cons: d.cons,
						verified_purchase: Number(d.verified_purchase),
						...(d.date_add ? { date_add: d.date_add } : {}),
					}),
			...(before && before.status !== d.status ? { moderated_at: new Date(), id_user_moderated: ctx.idUser } : {}),
			...(external && (replyChanged || before.status !== d.status) ? { need_push: 1 } : {}),
		};
		const keys = Object.keys(cols);
		if (id) {
			await conn.query(`UPDATE ${P}products_reviews SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => cols[k]), id]);
		} else {
			const [r] = await conn.query(`INSERT INTO ${P}products_reviews (${keys.join(", ")}, id_user_add) VALUES (?)`, [[...keys.map((k) => cols[k]), ctx.idUser]]);
			id = r.insertId;
		}
		removed = await setMedia(conn, id, d.media);
		await recalc(conn, [d.id_product, before && before.id_product]);
		return { id };
	});
	for (const f of removed) await images.removeIfUnused("products", f).catch(() => {});
	return result;
}

async function moderate(body, ctx) {
	const v = validateModeration(body);
	if (!v.valid) throw httpErr(400, "Validation failed", v.errors);
	const { ids, status } = v.data;
	return tx(async (conn) => {
		const [rows] = await conn.query(`SELECT id, id_product FROM ${P}products_reviews WHERE id IN (?) FOR UPDATE`, [ids]);
		await conn.query(
			`UPDATE ${P}products_reviews
			    SET need_push = IF(id_integration IS NULL, 0, IF(status <> ?, 1, need_push)),
			        moderated_at = IF(status <> ?, NOW(), moderated_at), id_user_moderated = IF(status <> ?, ?, id_user_moderated), status = ?
			  WHERE id IN (?)`,
			[status, status, status, ctx.idUser, status, ids]
		);
		await recalc(conn, rows.map((r) => r.id_product));
		return { updated: rows.length };
	});
}

async function remove(ids) {
	if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every((x) => Number.isInteger(x) && x > 0)) throw httpErr(400, "Invalid ids");
	const files = [];
	const r = await tx(async (conn) => {
		const [rows] = await conn.query(`SELECT id, id_product, id_integration, external_id FROM ${P}products_reviews WHERE id IN (?) FOR UPDATE`, [ids]);
		const [media] = await conn.query(`SELECT file FROM ${P}products_reviews_media WHERE id_review IN (?)`, [ids]);
		media.forEach((m) => files.push(m.file));
		// Відгуки з магазину не видаляємо фізично, інакше наступний pull поверне їх знову — ховаємо як rejected + deleted
		const ext = rows.filter((x) => x.id_integration).map((x) => x.id);
		const own = rows.filter((x) => !x.id_integration).map((x) => x.id);
		if (ext.length) await conn.query(`UPDATE ${P}products_reviews SET status = 'rejected', deleted_at = NOW(), need_push = 1 WHERE id IN (?)`, [ext]);
		if (own.length) {
			await conn.query(`DELETE FROM ${P}products_reviews_media WHERE id_review IN (?)`, [own]);
			await conn.query(`DELETE FROM ${P}products_reviews WHERE id IN (?)`, [own]);
		}
		await recalc(conn, rows.map((x) => x.id_product));
		return { deleted: rows.length };
	});
	for (const f of files) await images.removeIfUnused("products", f).catch(() => {});
	return r;
}

/* ═══ ОБМІН З МАГАЗИНОМ ═══ */

/** Завантажити фото з магазину. Лише з хоста інтеграції (захист від SSRF) */
async function fetchPhoto(integ, url) {
	let u;
	try {
		u = new URL(String(url));
	} catch {
		return null;
	}
	if (!integ.base_url) return null;
	const base = new URL(integ.base_url);
	if (!["https:", "http:"].includes(u.protocol) || u.hostname !== base.hostname) return null;
	try {
		const res = await fetch(u, { redirect: "error", signal: AbortSignal.timeout(15000) });
		if (!res.ok) return null;
		if (Number(res.headers.get("content-length") || 0) > MAX_PHOTO_BYTES) return null;
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > MAX_PHOTO_BYTES) return null;
		const r = await images.processUpload("products", buf, { watermark: false });
		return r.file;
	} catch {
		return null;
	}
}

const toDt = (v) => {
	const d = v ? new Date(v) : null;
	return d && !isNaN(d) ? d : new Date();
};

/** Один pull: reviews.list з курсором. Повертає статистику */
async function pull(idIntegration) {
	const [[integ]] = await pool.query(`SELECT id, name, base_url, callback_url, outbound_token, status FROM ${P}settings_integrations WHERE id = ?`, [idIntegration]);
	if (!integ || integ.status !== "active") throw httpErr(404, "Integration not found or disabled");
	const [[state]] = await pool.query(`SELECT cursor_value FROM ${P}products_reviews_sync WHERE id_integration = ?`, [idIntegration]);
	let cursor = state ? state.cursor_value : null;

	const langs = await languages.active();
	const langByIso = new Map(langs.map((l) => [l.iso, l.id]));
	const stats = { received: 0, created: 0, updated: 0, unmatched: 0 };

	for (let page = 0; page < 50; page++) {
		const res = await client.call(integ, "reviews.list", { cursor, limit: 200 });
		const items = Array.isArray(res.items) ? res.items.slice(0, 500) : [];
		stats.received += items.length;

		for (const it of items) {
			const externalId = String(it.external_id || "").slice(0, 64);
			const rating = parseInt(it.rating, 10);
			if (!externalId || !(rating >= 1 && rating <= 5)) continue;

			const extProduct = String(it.external_product_id || "").slice(0, 64);
			const [[link]] = extProduct
				? await pool.query(
						`SELECT id_product, id_variant FROM ${P}products_external_links WHERE id_integration = ? AND external_id = ?
						  ORDER BY (external_variant_id = ?) DESC LIMIT 1`,
						[idIntegration, extProduct, String(it.external_variant_id || "")]
					)
				: [[null]];
			if (!link) stats.unmatched++;

			const iso = String(it.lang || "").toLowerCase();
			const row = {
				id_product: link ? link.id_product : null,
				id_variant: link ? link.id_variant : 0,
				external_product_id: extProduct || null,
				id_lang: langByIso.get(iso) || langByIso.get(iso.split("-")[0]) || null,
				rating,
				author_name: (trimOrNull(it.author_name) || "—").slice(0, 128),
				author_email: (trimOrNull(it.author_email) || "").slice(0, 191) || null,
				title: (trimOrNull(it.title) || "").slice(0, 255) || null,
				body: (trimOrNull(it.text) || "").slice(0, 10000) || null,
				pros: (trimOrNull(it.pros) || "").slice(0, 2000) || null,
				cons: (trimOrNull(it.cons) || "").slice(0, 2000) || null,
				verified_purchase: it.verified ? 1 : 0,
				date_add: toDt(it.date_add),
			};
			const shopStatus = STATUSES.includes(it.status) ? it.status : "pending";

			const [[existing]] = await pool.query(`SELECT id, id_product, need_push FROM ${P}products_reviews WHERE id_integration = ? AND external_id = ?`, [idIntegration, externalId]);
			let idReview;
			await tx(async (conn) => {
				if (existing) {
					idReview = existing.id;
					// Модерація й відповідь з CRM, ще не відправлені в магазин, мають пріоритет
					const keys = Object.keys(row).filter((k) => !(k === "id_product" && existing.id_product && !row.id_product));
					await conn.query(`UPDATE ${P}products_reviews SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => row[k]), idReview]);
					stats.updated++;
				} else {
					const reply = (trimOrNull(it.reply) || "").slice(0, 5000) || null;
					const keys = [...Object.keys(row), "id_integration", "external_id", "status", "reply", "reply_at"];
					const vals = [...Object.values(row), idIntegration, externalId, shopStatus, reply, reply ? toDt(it.reply_date) : null];
					const [r] = await conn.query(`INSERT INTO ${P}products_reviews (${keys.join(", ")}) VALUES (?)`, [vals]);
					idReview = r.insertId;
					stats.created++;
				}
				await recalc(conn, [row.id_product, existing && existing.id_product]);
			});

			// Фото — лише для нових (щоб не вантажити повторно на кожному pull)
			if (!existing && Array.isArray(it.photos) && it.photos.length) {
				const files = [];
				for (const url of it.photos.slice(0, 10)) {
					const f = await fetchPhoto(integ, url);
					if (f && !files.includes(f)) files.push(f);
				}
				if (files.length) await tx((conn) => setMedia(conn, idReview, files));
			}
		}

		if (res.next_cursor !== undefined && res.next_cursor !== null) cursor = String(res.next_cursor).slice(0, 255);
		await pool.query(
			`INSERT INTO ${P}products_reviews_sync (id_integration, cursor_value, last_pull, last_error) VALUES (?, ?, NOW(), NULL)
			 ON DUPLICATE KEY UPDATE cursor_value = VALUES(cursor_value), last_pull = NOW(), last_error = NULL`,
			[idIntegration, cursor]
		);
		if (!res.has_more || !items.length) break;
	}
	return stats;
}

/** Відправити в магазин модерацію/відповіді (need_push = 1) */
async function pushModeration(idIntegration) {
	const [[integ]] = await pool.query(`SELECT id, base_url, callback_url, outbound_token, status FROM ${P}settings_integrations WHERE id = ?`, [idIntegration]);
	if (!integ || integ.status !== "active") return { sent: 0 };
	let sent = 0;
	for (;;) {
		const [rows] = await pool.query(
			`SELECT id, external_id, status, reply, reply_at, deleted_at FROM ${P}products_reviews WHERE id_integration = ? AND need_push = 1 ORDER BY id LIMIT 200`,
			[idIntegration]
		);
		if (!rows.length) break;
		await client.call(integ, "reviews.update", {
			items: rows.map((r) => ({ external_id: r.external_id, status: r.status, deleted: !!r.deleted_at, reply: r.reply, reply_date: r.reply_at })),
		});
		// Скидаємо прапорець лише для тих, що не змінились під час відправки
		for (const r of rows) {
			await pool.query(`UPDATE ${P}products_reviews SET need_push = 0 WHERE id = ? AND status = ? AND reply <=> ? AND deleted_at <=> ?`, [r.id, r.status, r.reply, r.deleted_at]);
		}
		sent += rows.length;
		if (rows.length < 200) break;
	}
	return { sent };
}

let running = false;

/** Cron: для інтеграцій з увімкненим pull_reviews — спочатку відправити модерацію, потім забрати нові */
async function syncAll() {
	if (running) return [];
	running = true;
	const out = [];
	try {
		const [rows] = await pool.query(
			`SELECT s.id_integration FROM ${P}products_sync_settings s JOIN ${P}settings_integrations i ON i.id = s.id_integration AND i.status = 'active'
			  WHERE s.enabled = 1 AND s.pull_reviews = 1`
		);
		for (const { id_integration: id } of rows) {
			try {
				const pushed = await pushModeration(id);
				const pulled = await pull(id);
				out.push({ id, ...pushed, ...pulled });
			} catch (e) {
				console.error("[reviews-sync]", id, e.message);
				await pool
					.query(
						`INSERT INTO ${P}products_reviews_sync (id_integration, last_error) VALUES (?, ?) ON DUPLICATE KEY UPDATE last_error = VALUES(last_error)`,
						[id, String(e.message).slice(0, 1024)]
					)
					.catch(() => {});
			}
		}
		return out;
	} finally {
		running = false;
	}
}

async function syncState() {
	const [rows] = await pool.query(
		`SELECT i.id, i.name, s.pull_reviews, rs.last_pull, rs.last_error,
		        (SELECT COUNT(*) FROM ${P}products_reviews r WHERE r.id_integration = i.id AND r.need_push = 1) AS queued
		   FROM ${P}settings_integrations i
		   JOIN ${P}products_sync_settings s ON s.id_integration = i.id
		   LEFT JOIN ${P}products_reviews_sync rs ON rs.id_integration = i.id
		  WHERE s.pull_reviews = 1`
	);
	return rows;
}

/** Ручне зіставлення відгуку без товару (товар у магазині ще не був прив'язаний) */
async function assignProduct(id, idProduct) {
	return tx(async (conn) => {
		const [[r]] = await conn.query(`SELECT id, id_product FROM ${P}products_reviews WHERE id = ? FOR UPDATE`, [id]);
		if (!r) throw httpErr(404, "Not found");
		const [[p]] = await conn.query(`SELECT id FROM ${P}products WHERE id = ? AND deleted_at IS NULL`, [idProduct]);
		if (!p) throw httpErr(400, "Validation failed", [{ field: "id_product", message: "product not found" }]);
		await conn.query(`UPDATE ${P}products_reviews SET id_product = ?, id_variant = 0 WHERE id = ?`, [idProduct, id]);
		await recalc(conn, [idProduct, r.id_product]);
		return { ok: true };
	});
}

module.exports = { list, get, save, moderate, remove, recalc, pull, pushModeration, syncAll, syncState, assignProduct };