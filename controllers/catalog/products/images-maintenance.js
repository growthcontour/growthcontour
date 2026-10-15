"use strict";

const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const pool = require("../../../config/database/connection_pool");
const config = require("../../../config/config");
const settings = require("./settings");
const images = require("./images");

const P = config.get("configDatabase").prefix;
const LOCK_NAME = `${P}products_images_maintenance`.slice(0, 64);
const DIR_RE = /^[0-9a-f]{2}$/;
const CODE_RE = /^[a-z0-9_]{1,32}$/;
const EXT_FORMAT = { jpg: "jpeg", png: "png", webp: "webp", avif: "avif", gif: "gif" };
const TMP_MAX_AGE_MS = 60 * 60 * 1000;

function httpErr(status, message) {
	return Object.assign(new Error(message), { status });
}

/* ─── Стан фонової задачі (один процес) ─── */
const job = {
	running: false,
	type: null,
	dry_run: false,
	kinds: [],
	started_at: null,
	finished_at: null,
	total: 0,
	processed: 0,
	deleted: 0,
	regenerated: 0,
	freed_bytes: 0,
	errors: 0,
	last_error: null,
	samples: [],
};

const status = () => ({ ...job, samples: job.samples.slice(0, 50) });

function resetJob(type, opts) {
	Object.assign(job, {
		running: true,
		type,
		dry_run: !!opts.dryRun,
		kinds: opts.kinds,
		started_at: new Date().toISOString(),
		finished_at: null,
		total: 0,
		processed: 0,
		deleted: 0,
		regenerated: 0,
		freed_bytes: 0,
		errors: 0,
		last_error: null,
		samples: [],
	});
}

function fail(e, where) {
	job.errors++;
	job.last_error = `${where}: ${e.message}`;
	console.error("[images-maintenance]", where, e.message);
}

/* ─── Що використовується ─── */
async function referenced(kind) {
	const queries = {
		products: [
			`SELECT file AS f FROM ${P}products_media WHERE file IS NOT NULL`,
			`SELECT image AS f FROM ${P}products_attribute_values WHERE image IS NOT NULL`,
			`SELECT image AS f FROM ${P}products_option_values WHERE image IS NOT NULL`,
			`SELECT og_image AS f FROM ${P}products WHERE og_image IS NOT NULL`,
			`SELECT file AS f FROM ${P}products_reviews_media`,
		],
		categories: [
			`SELECT image AS f FROM ${P}products_categories WHERE image IS NOT NULL
			 UNION SELECT icon FROM ${P}products_categories WHERE icon IS NOT NULL
			 UNION SELECT banner FROM ${P}products_categories WHERE banner IS NOT NULL`,
		],
		brands: [`SELECT logo AS f FROM ${P}products_brands WHERE logo IS NOT NULL`],
	}[kind];
	const set = new Set();
	for (const sql of queries) {
		const [rows] = await pool.query(sql);
		for (const r of rows) set.add(r.f);
	}
	const [htmlRows] = await pool.query(require("./images").htmlRefSql("h.file AS f"), [kind]);
	for (const r of htmlRows) set.add(r.f);
	if (kind === "products") {
		const cfg = await settings.get("images");
		if (cfg.watermark && cfg.watermark.file) set.add(String(cfg.watermark.file));
	}
	return set;
}

/* ─── Обхід файлів ─── */
async function readdirSafe(dir) {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch (e) {
		if (e.code === "ENOENT") return [];
		throw e;
	}
}

/** Файли виду xx/<sha256>.<ext> у теці (основні або мініатюри); tmp-залишки окремо */
async function* hashedFiles(base) {
	for (const d of await readdirSafe(base)) {
		if (!d.isDirectory() || !DIR_RE.test(d.name)) continue;
		for (const f of await readdirSafe(path.join(base, d.name))) {
			if (!f.isFile()) continue;
			const rel = `${d.name}/${f.name}`;
			if (images.FILE_RE.test(rel)) yield { rel, abs: path.join(base, rel), tmp: false };
			else if (f.name.endsWith(".tmp")) yield { rel, abs: path.join(base, rel), tmp: true };
		}
	}
}

async function statSafe(p) {
	try {
		return await fs.stat(p);
	} catch (e) {
		if (e.code === "ENOENT") return null;
		throw e;
	}
}

async function removeFile(abs, dryRun) {
	const st = await statSafe(abs);
	if (!st) return 0;
	if (!dryRun) await fs.unlink(abs).catch((e) => e.code !== "ENOENT" && Promise.reject(e));
	return st.size;
}

async function dirSize(dir) {
	let total = 0;
	for (const e of await readdirSafe(dir)) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) total += await dirSize(p);
		else if (e.isFile()) total += (await statSafe(p))?.size || 0;
	}
	return total;
}

/* ─── Очищення одного виду ─── */
async function cleanupKind(kind, opts) {
	const base = path.join(images.ROOT, kind);
	const cacheBase = path.join(base, "cache");
	const minAge = Math.max(1, Number(opts.minAgeHours) || 24) * 3600 * 1000;
	const now = Date.now();
	const cfg = await settings.get("images");
	const codes = new Set(cfg.thumbnails.map((t) => t.code));
	const refs = await referenced(kind);
	const cacheDirs = (await readdirSafe(cacheBase)).filter((d) => d.isDirectory() && CODE_RE.test(d.name)).map((d) => d.name);

	const note = (what, rel, bytes) => {
		job.deleted++;
		job.freed_bytes += bytes;
		if (job.samples.length < 50) job.samples.push({ kind, what, file: rel, bytes });
	};

	// 1. Основні файли без посилань + їх мініатюри й оригінали
	for await (const f of hashedFiles(base)) {
		job.total++;
		try {
			const st = await statSafe(f.abs);
			if (!st) continue;
			const age = now - st.mtimeMs;
			if (f.tmp) {
				if (age > TMP_MAX_AGE_MS) note("tmp", f.rel, await removeFile(f.abs, opts.dryRun));
				continue;
			}
			if (refs.has(f.rel) || age < minAge) continue;

			let bytes = await removeFile(f.abs, opts.dryRun);
			for (const code of cacheDirs) bytes += await removeFile(path.join(cacheBase, code, f.rel), opts.dryRun);
			const hash = path.basename(f.rel).split(".")[0];
			for (const o of await readdirSafe(path.join(base, "original", hash.slice(0, 2)))) {
				if (o.isFile() && o.name.startsWith(hash + ".")) bytes += await removeFile(path.join(base, "original", hash.slice(0, 2), o.name), opts.dryRun);
			}
			note("orphan", f.rel, bytes);
		} catch (e) {
			fail(e, `${kind}/${f.rel}`);
		} finally {
			job.processed++;
		}
	}

	// 2. Мініатюри: розміри, яких більше немає в налаштуваннях, — цілими теками
	for (const code of cacheDirs) {
		if (codes.has(code)) continue;
		try {
			const dir = path.join(cacheBase, code);
			const bytes = await dirSize(dir);
			if (!opts.dryRun) await fs.rm(dir, { recursive: true, force: true });
			note("stale_size", `cache/${code}`, bytes);
		} catch (e) {
			fail(e, `${kind}/cache/${code}`);
		}
	}

	// 3. Мініатюри, чий основний файл уже зник
	for (const code of cacheDirs.filter((c) => codes.has(c))) {
		for await (const f of hashedFiles(path.join(cacheBase, code))) {
			job.total++;
			try {
				const st = await statSafe(f.abs);
				if (!st || now - st.mtimeMs < (f.tmp ? TMP_MAX_AGE_MS : minAge)) continue;
				if (f.tmp || !(await statSafe(path.join(base, f.rel)))) note(f.tmp ? "tmp" : "thumb", `cache/${code}/${f.rel}`, await removeFile(f.abs, opts.dryRun));
			} catch (e) {
				fail(e, `${kind}/cache/${code}/${f.rel}`);
			} finally {
				job.processed++;
			}
		}
	}
}

/* ─── Перегенерація мініатюр одного виду ─── */
async function regenerateKind(kind, opts) {
	const cfg = await settings.get("images");
	const thumbs = cfg.thumbnails.filter((t) => !opts.codes || !opts.codes.length || opts.codes.includes(t.code));
	if (!thumbs.length) return;
	const refs = [...(await referenced(kind))].filter((f) => images.FILE_RE.test(f));
	job.total += refs.length;

	for (const rel of refs) {
		try {
			const abs = images.absPath(kind, rel);
			const source = await fs.readFile(abs).catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)));
			if (!source) continue;
			const format = EXT_FORMAT[path.extname(rel).slice(1)];
			for (const t of thumbs) {
				if (!opts.dryRun) await images.makeThumbnail(kind, rel, source, t, format, cfg.quality, true);
				job.regenerated++;
			}
		} catch (e) {
			fail(e, `${kind}/${rel}`);
		} finally {
			job.processed++;
			// не блокуємо event loop на великих каталогах
			if (job.processed % 20 === 0) await new Promise((r) => setImmediate(r));
		}
	}
}

/* ─── Запуск з блокуванням ─── */
async function withLock(fn) {
	const conn = await pool.getConnection();
	try {
		const [[{ got }]] = await conn.query("SELECT GET_LOCK(?, 0) AS got", [LOCK_NAME]);
		if (Number(got) !== 1) throw httpErr(409, "Maintenance is already running");
		try {
			return await fn();
		} finally {
			await conn.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]).catch(() => {});
		}
	} finally {
		conn.release();
	}
}

async function execute(type, opts) {
	resetJob(type, opts);
	try {
		for (const kind of opts.kinds) {
			if (type === "cleanup") await cleanupKind(kind, opts);
			else await regenerateKind(kind, opts);
		}
	} catch (e) {
		fail(e, type);
	} finally {
		job.running = false;
		job.finished_at = new Date().toISOString();
	}
	return status();
}

function normalize(opts) {
	const kinds = (opts.kinds && opts.kinds.length ? opts.kinds : images.KINDS).filter((k) => images.KINDS.includes(k));
	if (!kinds.length) throw httpErr(400, "No kinds");
	return { ...opts, kinds };
}

/**
 * Запустити у фоні (з UI). Повертає стан одразу; 409 — якщо вже виконується.
 * type: cleanup | regenerate; opts: { kinds, codes, dryRun, minAgeHours }
 */
async function start(type, opts) {
	if (!["cleanup", "regenerate"].includes(type)) throw httpErr(400, "Unknown type");
	if (job.running) throw httpErr(409, "Maintenance is already running");
	const o = normalize(opts || {});

	// Блокування беремо до відповіді, щоб одразу повернути 409, якщо зайнято іншим інстансом
	let release;
	const locked = new Promise((resolve, reject) => {
		withLock(
			() =>
				new Promise((done) => {
					resolve();
					release = done;
				})
		).catch(reject);
	});
	await locked;
	job.running = true;
	execute(type, o).finally(() => release());
	return status();
}

/** Для крону: синхронно, повертає підсумок або null, якщо зайнято */
async function cleanupAll(opts) {
	try {
		return await withLock(() => execute("cleanup", normalize(opts || {})));
	} catch (e) {
		if (e.status === 409) return null;
		throw e;
	}
}

module.exports = { start, status, cleanupAll };