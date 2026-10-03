"use strict";

const crypto = require("crypto");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const descriptions = require("./descriptions");
const bundles = require("./bundles");
const client = require("./sync-client");

const P = config.get("configDatabase").prefix;
const PUSH_BATCH = 100;
const PULL_LIMIT = 500;
const PULL_MAX_PAGES = 400;

function httpErr(status, message, code) {
	return Object.assign(new Error(message), { status, code });
}

const DEFAULTS = { enabled: 0, push_price: 1, push_stock: 1, push_status: 1, warehouses: [] };

/* ─── Інтеграції та налаштування ─── */
async function integration(id) {
	const [[row]] = await pool.query(`SELECT id, name, platform, base_url, outbound_token, status FROM ${P}orders_integrations WHERE id = ?`, [id]);
	if (!row) throw httpErr(404, "Integration not found");
	return row;
}

async function getSettings(id) {
	const [[row]] = await pool.query(`SELECT * FROM ${P}products_sync_settings WHERE id_integration = ?`, [id]);
	if (!row) return { ...DEFAULTS };
	const wh = typeof row.warehouses === "string" ? JSON.parse(row.warehouses) : row.warehouses;
	return {
		enabled: Number(row.enabled),
		push_price: Number(row.push_price),
		push_stock: Number(row.push_stock),
		push_status: Number(row.push_status),
		warehouses: Array.isArray(wh) ? wh.map(Number).filter((n) => n > 0) : [],
	};
}

async function saveSettings(id, s) {
	await integration(id);
	const v = {
		enabled: s.enabled ? 1 : 0,
		push_price: s.push_price ? 1 : 0,
		push_stock: s.push_stock ? 1 : 0,
		push_status: s.push_status ? 1 : 0,
		warehouses: Array.isArray(s.warehouses) ? [...new Set(s.warehouses.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [],
	};
	await pool.query(
		`INSERT INTO ${P}products_sync_settings (id_integration, enabled, push_price, push_stock, push_status, warehouses)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), push_price = VALUES(push_price), push_stock = VALUES(push_stock),
		                         push_status = VALUES(push_status), warehouses = VALUES(warehouses)`,
		[id, v.enabled, v.push_price, v.push_stock, v.push_status, JSON.stringify(v.warehouses)]
	);
	// Змінилися поля чи склади — наступна відправка має бути повною
	await pool.query(`UPDATE ${P}products_external_links SET sync_hash = NULL WHERE id_integration = ?`, [id]);
	return v;
}

async function listIntegrations() {
	const [rows] = await pool.query(
		`SELECT i.id, i.name, i.platform, i.base_url, i.status,
		        (i.outbound_token IS NOT NULL AND CHAR_LENGTH(i.outbound_token) >= 16) AS has_token,
		        COALESCE(s.enabled, 0) AS sync_enabled,
		        (SELECT COUNT(*) FROM ${P}products_external_links l WHERE l.id_integration = i.id) AS links,
		        (SELECT COUNT(*) FROM ${P}products_external_links l WHERE l.id_integration = i.id AND l.last_error IS NOT NULL) AS link_errors,
		        (SELECT MAX(g.date_add) FROM ${P}products_sync_log g WHERE g.id_integration = i.id AND g.action = 'push') AS last_push
		   FROM ${P}orders_integrations i
		   LEFT JOIN ${P}products_sync_settings s ON s.id_integration = i.id
		  ORDER BY i.name`
	);
	return rows;
}

async function writeLog(idIntegration, action, trigger, stats, idUser, started) {
	await pool
		.query(
			`INSERT INTO ${P}products_sync_log (id_integration, action, \`trigger\`, total, sent, ok, errors, message, duration_ms, id_user)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[idIntegration, action, trigger, stats.total || 0, stats.sent || 0, stats.ok || 0, stats.errors || 0, stats.message ? String(stats.message).slice(0, 1024) : null, Date.now() - started, idUser || null]
		)
		.catch((e) => console.error("[sync] log", e.message));
}

async function logList(idIntegration) {
	const [rows] = await pool.query(
		`SELECT g.*, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS user_name
		   FROM ${P}products_sync_log g LEFT JOIN ${P}users u ON u.id = g.id_user
		  WHERE g.id_integration = ? ORDER BY g.id DESC LIMIT 50`,
		[idIntegration]
	);
	return rows;
}

/* ─── Блокування на інтеграцію ─── */
async function withLock(idIntegration, fn) {
	const conn = await pool.getConnection();
	const name = `${P}products_sync_${idIntegration}`.slice(0, 64);
	try {
		const [[{ got }]] = await conn.query("SELECT GET_LOCK(?, 0) AS got", [name]);
		if (Number(got) !== 1) throw httpErr(409, "Synchronization is already running", "busy");
		try {
			return await fn();
		} finally {
			await conn.query("SELECT RELEASE_LOCK(?)", [name]).catch(() => {});
		}
	} finally {
		conn.release();
	}
}

/* ─── Зв'язки ─── */
async function links(idIntegration, q, idLang) {
	const size = Math.min(Math.max(parseInt(q.size, 10) || 50, 1), 500);
	const page = Math.max(parseInt(q.page, 10) || 1, 1);
	const where = ["l.id_integration = ?"];
	const params = [idIntegration];
	const search = String(q.search || "").trim().slice(0, 100);
	if (search) {
		const like = "%" + search.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
		where.push(`(p.sku LIKE ? OR v.sku LIKE ? OR l.external_id = ? OR l.external_sku LIKE ?
		             OR EXISTS (SELECT 1 FROM ${P}products_description d WHERE d.id_product = p.id AND d.name LIKE ?))`);
		params.push(like, like, search, like, like);
	}
	if (q.errors === 1 || q.errors === "1" || q.errors === true) where.push("l.last_error IS NOT NULL");

	const langs = await descriptions.contentLanguages();
	const primary = langs[0] ? langs[0].id : idLang;
	const from = `FROM ${P}products_external_links l
		JOIN ${P}products p ON p.id = l.id_product
		LEFT JOIN ${P}products_variants v ON v.id = l.id_variant AND l.id_variant > 0`;
	const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(" AND ")}`, params);
	const [rows] = await pool.query(
		`SELECT l.id, l.id_product, l.id_variant, l.external_id, l.external_variant_id, l.external_sku, l.last_sync_at, l.last_error,
		        COALESCE(v.sku, p.sku) AS sku, p.status, p.deleted_at,
		        COALESCE(
		          (SELECT NULLIF(d.name, '') FROM ${P}products_description d WHERE d.id_product = p.id AND d.id_lang = ?),
		          (SELECT d.name FROM ${P}products_description d WHERE d.id_product = p.id AND d.id_lang = ?),
		          CONCAT('#', p.id)) AS name
		   ${from}
		  WHERE ${where.join(" AND ")}
		  ORDER BY (l.last_error IS NULL), l.id DESC
		  LIMIT ? OFFSET ?`,
		[idLang, primary, ...params, size, (page - 1) * size]
	);
	return { last_page: Math.max(Math.ceil(total / size), 1), last_row: total, data: rows };
}

/** Знайти товар/варіант CRM за артикулом */
async function findBySku(db, sku) {
	const [[v]] = await db.query(
		`SELECT v.id_product, v.id AS id_variant FROM ${P}products_variants v JOIN ${P}products p ON p.id = v.id_product AND p.deleted_at IS NULL WHERE v.sku = ?`,
		[sku]
	);
	if (v) return v;
	const [[p]] = await db.query(`SELECT id AS id_product, 0 AS id_variant FROM ${P}products WHERE sku = ? AND deleted_at IS NULL`, [sku]);
	return p || null;
}

async function linkManual(idIntegration, b) {
	await integration(idIntegration);
	const sku = String(b.sku || "").trim();
	const externalId = String(b.external_id || "").trim();
	const externalVariantId = String(b.external_variant_id || "").trim();
	if (!sku || !externalId || externalId.length > 64 || externalVariantId.length > 64) throw httpErr(400, "sku and external_id are required", "invalid");
	const local = await findBySku(pool, sku);
	if (!local) throw httpErr(404, "Product with this SKU not found", "sku_not_found");
	try {
		await pool.query(
			`INSERT INTO ${P}products_external_links (id_product, id_variant, id_integration, external_id, external_variant_id, external_sku)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[local.id_product, local.id_variant, idIntegration, externalId, externalVariantId, sku]
		);
	} catch (e) {
		if (e.code === "ER_DUP_ENTRY") throw httpErr(409, "Already linked", "duplicate");
		throw e;
	}
}

async function unlink(idIntegration, idLink) {
	const [r] = await pool.query(`DELETE FROM ${P}products_external_links WHERE id = ? AND id_integration = ?`, [idLink, idIntegration]);
	if (!r.affectedRows) throw httpErr(404, "Link not found");
}

/* ─── Зіставлення каталогу магазину за артикулом ─── */
async function pullAndMatch(idIntegration, opts, idUser) {
	const integ = await integration(idIntegration);
	const started = Date.now();
	return withLock(idIntegration, async () => {
		const stats = { total: 0, matched: 0, created: 0, already: 0, no_sku: 0, not_found: 0, conflicts: 0 };
		const unmatched = [];
		const conflicts = [];
		try {
			// Мапи CRM: SKU → товар/варіант (без урахування регістру)
			const [prods] = await pool.query(`SELECT id, sku FROM ${P}products WHERE deleted_at IS NULL AND sku IS NOT NULL AND sku <> ''`);
			const [vars] = await pool.query(
				`SELECT v.id, v.id_product, v.sku FROM ${P}products_variants v JOIN ${P}products p ON p.id = v.id_product AND p.deleted_at IS NULL
				  WHERE v.sku IS NOT NULL AND v.sku <> ''`
			);
			const bySku = new Map();
			for (const p of prods) bySku.set(p.sku.trim().toLowerCase(), { id_product: p.id, id_variant: 0 });
			for (const v of vars) bySku.set(v.sku.trim().toLowerCase(), { id_product: v.id_product, id_variant: v.id });

			const [existing] = await pool.query(`SELECT id_product, id_variant, external_id, external_variant_id FROM ${P}products_external_links WHERE id_integration = ?`, [idIntegration]);
			const extKeys = new Set(existing.map((e) => `${e.external_id}|${e.external_variant_id}`));
			const localKeys = new Map(existing.map((e) => [`${e.id_product}|${e.id_variant}`, `${e.external_id}|${e.external_variant_id}`]));

			const toInsert = [];
			for (let page = 1; page <= PULL_MAX_PAGES; page++) {
				const r = await client.call(integ, "catalog.list", { page, limit: PULL_LIMIT });
				const items = Array.isArray(r.items) ? r.items : [];
				for (const it of items) {
					stats.total++;
					const externalId = String(it.id ?? "").trim().slice(0, 64);
					const externalVariantId = it.variant_id === null || it.variant_id === undefined ? "" : String(it.variant_id).trim().slice(0, 64);
					const sku = String(it.sku || "").trim();
					if (!externalId) continue;
					const extKey = `${externalId}|${externalVariantId}`;
					if (extKeys.has(extKey)) {
						stats.already++;
						continue;
					}
					if (!sku) {
						stats.no_sku++;
						if (unmatched.length < 200) unmatched.push({ external_id: externalId, external_variant_id: externalVariantId, sku: "", name: String(it.name || "").slice(0, 255) });
						continue;
					}
					const local = bySku.get(sku.toLowerCase());
					if (!local) {
						stats.not_found++;
						if (unmatched.length < 200) unmatched.push({ external_id: externalId, external_variant_id: externalVariantId, sku, name: String(it.name || "").slice(0, 255) });
						continue;
					}
					const localKey = `${local.id_product}|${local.id_variant}`;
					if (localKeys.has(localKey) && localKeys.get(localKey) !== extKey) {
						stats.conflicts++;
						if (conflicts.length < 200) conflicts.push({ sku, external_id: externalId, external_variant_id: externalVariantId, linked_to: localKeys.get(localKey) });
						continue;
					}
					stats.matched++;
					extKeys.add(extKey);
					localKeys.set(localKey, extKey);
					toInsert.push([local.id_product, local.id_variant, idIntegration, externalId, externalVariantId, sku.slice(0, 64)]);
				}
				const pages = parseInt(r.pages, 10);
				if (!items.length || (Number.isInteger(pages) && page >= pages)) break;
			}

			if (opts.apply && toInsert.length) {
				for (let i = 0; i < toInsert.length; i += 500) {
					const [res] = await pool.query(
						`INSERT IGNORE INTO ${P}products_external_links (id_product, id_variant, id_integration, external_id, external_variant_id, external_sku) VALUES ?`,
						[toInsert.slice(i, i + 500)]
					);
					stats.created += res.affectedRows;
				}
			}
			await writeLog(idIntegration, "match", "manual", { total: stats.total, ok: stats.created, errors: stats.not_found + stats.conflicts, message: JSON.stringify({ ...stats, apply: !!opts.apply }) }, idUser, started);
			return { stats, unmatched, conflicts, apply: !!opts.apply };
		} catch (e) {
			await writeLog(idIntegration, "match", "manual", { total: stats.total, errors: 1, message: e.message }, idUser, started);
			throw e;
		}
	});
}

/* ─── Стан для відправки ─── */
async function buildPayloads(rows, settings) {
	if (!rows.length) return [];
	const productIds = [...new Set(rows.map((r) => r.id_product))];

	// Залишки: available по продаваних складах (або обраних)
	const whFilter = settings.warehouses.length ? "AND w.id IN (?)" : "";
	const [stockRows] = await pool.query(
		`SELECT s.id_product, s.id_variant, SUM(s.available) AS qty
		   FROM ${P}products_stock s
		   JOIN ${P}products_warehouses w ON w.id = s.id_warehouse AND w.deleted_at IS NULL AND w.status = 1 AND w.is_sellable = 1 ${whFilter}
		  WHERE s.id_product IN (?)
		  GROUP BY s.id_product, s.id_variant`,
		settings.warehouses.length ? [settings.warehouses, productIds] : [productIds]
	);
	const stockMap = new Map(stockRows.map((s) => [`${s.id_product}|${s.id_variant}`, Number(s.qty)]));

	const bundleCache = new Map();
	const out = [];
	for (const r of rows) {
		const item = { ref: r.id, id: r.external_id, variant_id: r.external_variant_id || null, sku: r.variant_sku || r.sku };
		const isVariant = Number(r.id_variant) > 0;

		if (settings.push_price) {
			let price = Number(r.price);
			let compare = r.compare_at_price === null ? null : Number(r.compare_at_price);
			if (isVariant) {
				price = r.price_mode === "fixed" ? Number(r.v_price) : Number(r.price) + Number(r.v_price || 0);
				if (r.v_compare_at_price !== null) compare = Number(r.v_compare_at_price);
			}
			item.price = Math.round(price * 10000) / 10000;
			item.compare_at_price = compare === null || compare <= price ? null : Math.round(compare * 10000) / 10000;
		}
		if (settings.push_stock) {
			if (!Number(r.track_inventory) || ["service", "digital"].includes(r.type)) {
				item.track = false;
				item.quantity = null;
			} else if (r.type === "bundle" && r.pack_stock_mode !== "pack") {
				if (!bundleCache.has(r.id_product)) {
					bundleCache.set(r.id_product, await bundles.bundleAvailability(pool, { id: r.id_product, track_inventory: r.track_inventory, pack_stock_mode: r.pack_stock_mode }));
				}
				const q = bundleCache.get(r.id_product);
				item.track = q !== null;
				item.quantity = q === null ? null : Math.max(0, Math.floor(q));
			} else {
				item.track = true;
				item.quantity = Math.max(0, Math.floor(stockMap.get(`${r.id_product}|${isVariant ? r.id_variant : 0}`) || 0));
			}
		}
		if (settings.push_status) {
			item.status = r.status === "active" && !r.deleted_at && (!isVariant || Number(r.v_status) === 1) ? 1 : 0;
		}
		const { ref, ...state } = item;
		item._hash = crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex");
		out.push(item);
	}
	return out;
}

/**
 * Відправити зміни в магазин. force — ігнорувати sync_hash (повна відправка).
 * trigger: manual | cron
 */
async function push(idIntegration, opts, idUser) {
	const integ = await integration(idIntegration);
	const settings = await getSettings(idIntegration);
	if (opts.trigger === "cron" && (!settings.enabled || Number(integ.status) !== 1)) return null;
	if (!settings.push_price && !settings.push_stock && !settings.push_status) throw httpErr(400, "Nothing to push", "nothing");
	const started = Date.now();

	return withLock(idIntegration, async () => {
		const stats = { total: 0, sent: 0, ok: 0, errors: 0, message: null };
		let lastId = 0;
		try {
			for (;;) {
				const [rows] = await pool.query(
					`SELECT l.id, l.id_product, l.id_variant, l.external_id, l.external_variant_id, l.sync_hash,
					        p.id AS product_id, p.type, p.status, p.deleted_at, p.sku, p.price, p.compare_at_price, p.track_inventory, p.pack_stock_mode,
					        v.sku AS variant_sku, v.price_mode, v.price AS v_price, v.compare_at_price AS v_compare_at_price, v.status AS v_status
					   FROM ${P}products_external_links l
					   JOIN ${P}products p ON p.id = l.id_product
					   LEFT JOIN ${P}products_variants v ON v.id = l.id_variant AND l.id_variant > 0
					  WHERE l.id_integration = ? AND l.id > ?
					  ORDER BY l.id LIMIT 500`,
					[idIntegration, lastId]
				);
				if (!rows.length) break;
				lastId = rows[rows.length - 1].id;
				stats.total += rows.length;

				const payloads = await buildPayloads(rows, settings);
				const changed = payloads.filter((it, i) => opts.force || rows[i].sync_hash !== it._hash);

				for (let i = 0; i < changed.length; i += PUSH_BATCH) {
					const batch = changed.slice(i, i + PUSH_BATCH);
					stats.sent += batch.length;
					let results;
					try {
						const r = await client.call(integ, "products.update", { items: batch.map(({ _hash, ...it }) => it) });
						results = new Map((Array.isArray(r.results) ? r.results : []).map((x) => [Number(x.ref), x]));
					} catch (e) {
						// Збій пакета: позначаємо всі рядки пакета, хеш не оновлюємо — повториться наступного разу
						stats.errors += batch.length;
						stats.message = e.message;
						await pool.query(`UPDATE ${P}products_external_links SET last_error = ? WHERE id IN (?)`, [e.message.slice(0, 512), batch.map((b) => b.ref)]);
						if (e.code === "connect" || e.code === "no_url" || e.code === "no_token") throw e;
						continue;
					}
					for (const it of batch) {
						const res = results.get(it.ref);
						if (res && res.ok) {
							stats.ok++;
							await pool.query(`UPDATE ${P}products_external_links SET sync_hash = ?, last_sync_at = NOW(), last_error = NULL WHERE id = ?`, [it._hash, it.ref]);
						} else {
							stats.errors++;
							const msg = String((res && res.error) || "no result for item").slice(0, 512);
							await pool.query(`UPDATE ${P}products_external_links SET last_error = ? WHERE id = ?`, [msg, it.ref]);
						}
					}
				}
			}
		} catch (e) {
			stats.message = e.message;
			if (opts.trigger !== "cron") {
				await writeLog(idIntegration, "push", opts.trigger || "manual", stats, idUser, started);
				throw e;
			}
		}
		if (stats.sent || stats.errors || opts.trigger !== "cron") await writeLog(idIntegration, "push", opts.trigger || "manual", stats, idUser, started);
		return stats;
	});
}

/** Крон: усі ввімкнені інтеграції по черзі */
async function pushAll() {
	const [rows] = await pool.query(
		`SELECT s.id_integration FROM ${P}products_sync_settings s JOIN ${P}orders_integrations i ON i.id = s.id_integration AND i.status = 1 WHERE s.enabled = 1`
	);
	for (const r of rows) {
		try {
			await push(r.id_integration, { trigger: "cron" });
		} catch (e) {
			if (e.code !== "busy") console.error("[sync] push", r.id_integration, e.message);
		}
	}
}

/** Перевірка зв'язку з модулем магазину */
async function ping(idIntegration) {
	const integ = await integration(idIntegration);
	const r = await client.call(integ, "ping", {});
	return { platform: r.platform || null, version: r.version || null, shop: r.shop || null };
}

module.exports = { listIntegrations, getSettings, saveSettings, links, linkManual, unlink, pullAndMatch, push, pushAll, ping, logList };