"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { pipeline } = require("stream/promises");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const descriptions = require("./descriptions");
const downloads = require("./downloads");
const { FILE_RE } = require("../../../validator/catalog/products/downloads");

const P = config.get("configDatabase").prefix;
const REF = "deal";
const TOKEN_RE = /^(\d{1,10})-([A-Za-z0-9_-]{43})$/;

function httpErr(status, message, code) {
	return Object.assign(new Error(message), { status, code });
}

function secret() {
	const s = process.env.DOWNLOAD_LINK_SECRET || "";
	if (s.length < 32) throw httpErr(500, "DOWNLOAD_LINK_SECRET is not configured", "not_configured");
	return s;
}

const sign = (id, nonce) => crypto.createHmac("sha256", secret()).update(`${id}:${nonce}`).digest("base64url");
const newNonce = () => crypto.randomBytes(16).toString("hex");
const urlOf = (baseUrl, row) => `${baseUrl}/dl/${row.id}-${sign(row.id, row.nonce)}`;

function stateOf(l, dealWon) {
	if (l.revoked_at) return "revoked";
	if (!dealWon) return "inactive";
	if (Number(l.is_expired)) return "expired";
	if (l.max_downloads !== null && Number(l.downloads_count) >= Number(l.max_downloads)) return "exhausted";
	return "active";
}

async function dealOf(conn, idDeal, lock) {
	const [[deal]] = await conn.query(
		`SELECT d.id, s.stage_type FROM ${P}deals d LEFT JOIN ${P}deals_stage s ON s.id = d.id_stage
		  WHERE d.id = ? AND d.active = 1 ${lock ? "FOR UPDATE" : ""}`,
		[idDeal]
	);
	if (!deal) throw httpErr(404, "Deal not found");
	return deal;
}

/** Цифрові позиції угоди з файлами та посиланнями */
async function listForDeal(idDeal, idLang, baseUrl) {
	const deal = await dealOf(pool, idDeal, false);
	const won = deal.stage_type === "won";
	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;

	const [items] = await pool.query(
		`SELECT i.id, i.name, i.sku, i.qty, i.id_product, i.id_variant
		   FROM ${P}deals_item i
		   JOIN ${P}products p ON p.id = i.id_product AND p.type = 'digital'
		  WHERE i.id_deal = ? AND i.active = 1
		  ORDER BY i.sort_order, i.id`,
		[idDeal]
	);
	if (!items.length) return { won, items: [] };

	const [files] = await pool.query(
		`SELECT dl.id, dl.id_product, dl.id_variant, dl.original_name, dl.size, dl.version, dl.max_downloads, dl.expires_days,
		        COALESCE(
		          (SELECT NULLIF(d.name, '') FROM ${P}products_downloads_description d WHERE d.id_download = dl.id AND d.id_lang = ?),
		          (SELECT d.name FROM ${P}products_downloads_description d WHERE d.id_download = dl.id AND d.id_lang = ?),
		          dl.original_name) AS name
		   FROM ${P}products_downloads dl
		  WHERE dl.id_product IN (?)
		  ORDER BY dl.sort_order, dl.id`,
		[idLang, primary, [...new Set(items.map((i) => i.id_product))]]
	);
	const [links] = await pool.query(
		`SELECT l.*, (l.expires_at IS NOT NULL AND l.expires_at <= NOW()) AS is_expired
		   FROM ${P}products_download_links l
		  WHERE l.ref_type = ? AND l.ref_id = ?`,
		[REF, idDeal]
	);

	return {
		won,
		items: items.map((it) => ({
			id: it.id,
			name: it.name,
			sku: it.sku,
			files: files
				.filter((f) => f.id_product === it.id_product && (Number(f.id_variant) === 0 || Number(f.id_variant) === Number(it.id_variant)))
				.map((f) => {
					const l = links.find((x) => x.id_ref_item === it.id && x.id_download === f.id);
					return {
						id_download: f.id,
						name: f.name,
						original_name: f.original_name,
						size: f.size,
						version: f.version,
						link: l
							? {
									id: l.id,
									url: urlOf(baseUrl, l),
									state: stateOf(l, won),
									downloads_count: l.downloads_count,
									max_downloads: l.max_downloads,
									expires_at: l.expires_at,
									last_download_at: l.last_download_at,
									date_add: l.date_add,
							  }
							: null,
					};
				}),
		})),
	};
}

/** Створити посилання для всіх файлів позиції (наявні не чіпає) */
async function create(idDeal, idItem, idUser) {
	secret();
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const deal = await dealOf(conn, idDeal, true);
		if (deal.stage_type !== "won") throw httpErr(409, "Deal is not won", "deal_not_won");

		const [[item]] = await conn.query(
			`SELECT i.id, i.id_product, i.id_variant FROM ${P}deals_item i
			   JOIN ${P}products p ON p.id = i.id_product AND p.type = 'digital'
			  WHERE i.id = ? AND i.id_deal = ? AND i.active = 1`,
			[idItem, idDeal]
		);
		if (!item) throw httpErr(404, "Digital item not found", "item_not_found");

		const [files] = await conn.query(
			`SELECT id, max_downloads, expires_days FROM ${P}products_downloads WHERE id_product = ? AND id_variant IN (0, ?)`,
			[item.id_product, item.id_variant || 0]
		);
		if (!files.length) throw httpErr(400, "Product has no files", "no_files");

		let created = 0;
		for (const f of files) {
			const [r] = await conn.query(
				`INSERT IGNORE INTO ${P}products_download_links
				   (nonce, id_download, id_product, ref_type, ref_id, id_ref_item, max_downloads, expires_at, id_user_add)
				 VALUES (?, ?, ?, ?, ?, ?, ?, IF(? IS NULL, NULL, DATE_ADD(NOW(), INTERVAL ? DAY)), ?)`,
				[newNonce(), f.id, item.id_product, REF, idDeal, item.id, f.max_downloads, f.expires_days, f.expires_days, idUser]
			);
			created += r.affectedRows;
		}
		await conn.commit();
		return created;
	} catch (e) {
		await conn.rollback().catch(() => {});
		throw e;
	} finally {
		conn.release();
	}
}

/** Перевипустити: нова адреса, лічильник і строк — з нуля */
async function regenerate(idDeal, idLink) {
	secret();
	const deal = await dealOf(pool, idDeal, false);
	if (deal.stage_type !== "won") throw httpErr(409, "Deal is not won", "deal_not_won");
	const [r] = await pool.query(
		`UPDATE ${P}products_download_links l
		   JOIN ${P}products_downloads dl ON dl.id = l.id_download
		    SET l.nonce = ?, l.downloads_count = 0, l.revoked_at = NULL, l.id_user_revoked = NULL,
		        l.max_downloads = dl.max_downloads,
		        l.expires_at = IF(dl.expires_days IS NULL, NULL, DATE_ADD(NOW(), INTERVAL dl.expires_days DAY))
		  WHERE l.id = ? AND l.ref_type = ? AND l.ref_id = ?`,
		[newNonce(), idLink, REF, idDeal]
	);
	if (!r.affectedRows) throw httpErr(404, "Link not found");
}

async function revoke(idDeal, idLink, idUser) {
	const [r] = await pool.query(
		`UPDATE ${P}products_download_links SET revoked_at = NOW(), id_user_revoked = ?
		  WHERE id = ? AND ref_type = ? AND ref_id = ? AND revoked_at IS NULL`,
		[idUser, idLink, REF, idDeal]
	);
	if (!r.affectedRows) throw httpErr(404, "Link not found");
}

/**
 * Публічна видача файлу за токеном.
 * Помилки: 404 not_found (у т.ч. невірний підпис), 410 inactive/revoked/expired/exhausted
 */
async function serve(token, req, res) {
	const m = TOKEN_RE.exec(String(token || ""));
	if (!m) throw httpErr(404, "Not found", "not_found");
	const id = Number(m[1]);

	const [[l]] = await pool.query(
		`SELECT l.*, dl.file, dl.original_name, dl.mime, dl.size,
		        (l.expires_at IS NOT NULL AND l.expires_at <= NOW()) AS is_expired,
		        (SELECT s.stage_type FROM ${P}deals d JOIN ${P}deals_stage s ON s.id = d.id_stage WHERE d.id = l.ref_id AND d.active = 1) AS deal_stage
		   FROM ${P}products_download_links l
		   JOIN ${P}products_downloads dl ON dl.id = l.id_download
		  WHERE l.id = ?`,
		[id]
	);
	const expected = Buffer.from(l ? sign(l.id, l.nonce) : "x".repeat(43));
	const given = Buffer.from(m[2]);
	if (!l || expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) throw httpErr(404, "Not found", "not_found");

	const state = stateOf(l, l.ref_type !== REF || l.deal_stage === "won");
	if (state !== "active") throw httpErr(410, "Link is not active", state);

	if (!FILE_RE.test(l.file)) throw httpErr(404, "Not found", "not_found");
	const abs = path.join(downloads.STORAGE, l.file);
	await fsp.access(abs).catch(() => {
		throw httpErr(404, "File is missing", "not_found");
	});

	const isHead = req.method === "HEAD";
	if (!isHead) {
		const ip = String(req.ip || "").slice(0, 45);
		const [r] = await pool.query(
			`UPDATE ${P}products_download_links
			    SET downloads_count = downloads_count + 1, last_download_at = NOW(), last_ip = ?
			  WHERE id = ? AND revoked_at IS NULL
			    AND (expires_at IS NULL OR expires_at > NOW())
			    AND (max_downloads IS NULL OR downloads_count < max_downloads)`,
			[ip, l.id]
		);
		if (!r.affectedRows) throw httpErr(410, "Link is not active", "exhausted");
		await pool.query(`INSERT INTO ${P}products_download_log (id_link, ip, user_agent) VALUES (?, ?, ?)`, [l.id, ip, String(req.get("user-agent") || "").slice(0, 255)]);
	}

	res.setHeader("Content-Type", l.mime || "application/octet-stream");
	res.setHeader("Content-Length", l.size);
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
	res.setHeader("Cache-Control", "private, no-store");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("X-Robots-Tag", "noindex, nofollow");
	res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(l.original_name)}"; filename*=UTF-8''${encodeURIComponent(l.original_name)}`);
	if (isHead) return res.end();
	await pipeline(fs.createReadStream(abs), res);
}

module.exports = { listForDeal, create, regenerate, revoke, serve };