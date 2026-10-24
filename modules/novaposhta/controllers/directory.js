"use strict";

/**
 * Довідники НП у системі: області, міста, відділення й поштомати.
 * Синхронізація з API (раз на N годин або кнопкою), пошук для картки замовлення, зіставлення назв і номерів з ref.
 */
const { pool, P, httpErr, isRef, str } = require("./common");
const api = require("./api");

let running = null;

async function syncState() {
	const [rows] = await pool.query(`SELECT k, started_at, finished_at, total, message FROM ${P}np_sync`);
	const out = {};
	rows.forEach((r) => (out[r.k] = r));
	const [[c]] = await pool.query(
		`SELECT (SELECT COUNT(*) FROM ${P}np_areas) AS areas, (SELECT COUNT(*) FROM ${P}np_cities) AS cities,
		        (SELECT COUNT(*) FROM ${P}np_warehouses) AS warehouses, (SELECT COUNT(*) FROM ${P}np_warehouses WHERE type = 'postomat') AS postomats`
	);
	return { running: !!running, state: out.directory || null, counts: c };
}

async function apiKey() {
	const [[a]] = await pool.query(`SELECT api_key FROM ${P}np_accounts WHERE status = 1 ORDER BY is_default DESC, id LIMIT 1`);
	if (!a) throw httpErr(409, "modules.novaposhta.e.no_account");
	return a.api_key;
}

// Поштомат — окремий тип: до нього інші обмеження (вага, розміри, без наложеного платежу понад ліміт)
const warehouseType = (w) => (String(w.CategoryOfWarehouse || "") === "Postomat" ? "postomat" : "warehouse");

// Запис відділень у довідник (спільний для повної синхронізації й дозавантаження одного відділення)
async function saveWarehouses(rows, stamp) {
	const ok = rows.filter((w) => isRef(w.Ref) && isRef(w.CityRef));
	if (!ok.length) return 0;
	await pool.query(
		`INSERT INTO ${P}np_warehouses (ref, city_ref, number, type, name, name_ru, short_address, max_weight, status, seen) VALUES ?
		 ON DUPLICATE KEY UPDATE city_ref = VALUES(city_ref), number = VALUES(number), type = VALUES(type), name = VALUES(name), name_ru = VALUES(name_ru),
		   short_address = VALUES(short_address), max_weight = VALUES(max_weight), status = VALUES(status), seen = VALUES(seen)`,
		[ok.map((w) => [w.Ref, w.CityRef, Math.max(0, parseInt(w.Number, 10) || 0), warehouseType(w), str(w.Description, 512) || "—", str(w.DescriptionRu, 512), str(w.ShortAddress, 512), Math.max(0, parseInt(w.TotalMaxWeightAllowed, 10) || 0), str(w.WarehouseStatus, 32), stamp])]
	);
	return ok.length;
}

/** Повна синхронізація (у фоні). Те, чого більше немає в НП, видаляється після успішного проходу */
function sync() {
	if (running) return { started: false, running: true };
	running = (async () => {
		const key = await apiKey();
		const started = new Date();
		const stamp = started.toISOString().slice(0, 19).replace("T", " ");
		await pool.query(
			`INSERT INTO ${P}np_sync (k, started_at, finished_at, total, message) VALUES ('directory', ?, NULL, 0, NULL)
			 ON DUPLICATE KEY UPDATE started_at = VALUES(started_at), finished_at = NULL, message = NULL`,
			[stamp]
		);
		let total = 0;
		try {
			// Області
			const { data: areas } = await api.call(key, "Address", "getAreas");
			const areaName = new Map(areas.map((a) => [a.Ref, a.Description]));
			if (areas.length) {
				await pool.query(
					`INSERT INTO ${P}np_areas (ref, name, name_ru, seen) VALUES ? ON DUPLICATE KEY UPDATE name = VALUES(name), name_ru = VALUES(name_ru), seen = VALUES(seen)`,
					[areas.map((a) => [a.Ref, str(a.Description, 100) || "—", str(a.DescriptionRu, 100), stamp])]
				);
			}
			// Міста
			await api.callAll(key, "Address", "getCities", {}, 500, async (rows) => {
				if (!rows.length) return;
				total += rows.length;
				await pool.query(
					`INSERT INTO ${P}np_cities (ref, name, name_ru, area_ref, area, type, seen) VALUES ?
					 ON DUPLICATE KEY UPDATE name = VALUES(name), name_ru = VALUES(name_ru), area_ref = VALUES(area_ref), area = VALUES(area), type = VALUES(type), seen = VALUES(seen)`,
					[rows.map((c) => [c.Ref, str(c.Description, 200) || "—", str(c.DescriptionRu, 200), isRef(c.Area) ? c.Area : null, str(areaName.get(c.Area) || c.AreaDescription, 100), str(c.SettlementTypeDescription, 50), stamp])]
				);
			});
			// Відділення й поштомати
			await api.callAll(key, "Address", "getWarehouses", {}, 500, async (rows) => {
				total += await saveWarehouses(rows, stamp);
			});
			// Прибрати зниклі (лише після повного успішного проходу)
			await pool.query(`DELETE FROM ${P}np_warehouses WHERE seen < ?`, [stamp]);
			await pool.query(`DELETE FROM ${P}np_cities WHERE seen < ? AND ref NOT IN (SELECT city_ref FROM ${P}np_warehouses)`, [stamp]);
			await pool.query(`UPDATE ${P}np_sync SET finished_at = NOW(), total = ?, message = NULL WHERE k = 'directory'`, [total]);
		} catch (e) {
			await pool.query(`UPDATE ${P}np_sync SET finished_at = NOW(), total = ?, message = ? WHERE k = 'directory'`, [total, String(e.vars && e.vars.msg ? e.vars.msg : e.message).slice(0, 1000)]);
			throw e;
		}
	})()
		.catch((e) => console.error("[novaposhta] directory sync:", e.message))
		.finally(() => (running = null));
	return { started: true };
}

/** Чи час оновити довідник (порожній або старший за N годин) */
async function syncIfDue(hours) {
	const [[s]] = await pool.query(`SELECT finished_at, message FROM ${P}np_sync WHERE k = 'directory'`);
	const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${P}np_warehouses`);
	const [[{ acc }]] = await pool.query(`SELECT COUNT(*) AS acc FROM ${P}np_accounts WHERE status = 1`);
	if (!Number(acc)) return null;
	const age = s && s.finished_at ? (Date.now() - new Date(s.finished_at).getTime()) / 3600000 : Infinity;
	// Порожній, застарів — оновити; минула синхронізація з помилкою — повтор через годину, а не через добу
	if (!Number(n) || age >= hours || (s && s.message && age >= 1)) return sync();
	return null;
}

/* ─── Пошук ─── */

const like = (s) => String(s).replace(/[\\%_]/g, "\\$&");

async function cities(q) {
	q = String(q || "").trim();
	if (q.length < 2) return [];
	const [rows] = await pool.query(
		`SELECT c.ref, c.name, c.name_ru, c.area, c.type,
		        (SELECT COUNT(*) FROM ${P}np_warehouses w WHERE w.city_ref = c.ref) AS warehouses
		   FROM ${P}np_cities c
		  WHERE c.name LIKE ? OR c.name_ru LIKE ?
		  ORDER BY (c.name = ? OR c.name_ru = ?) DESC, warehouses DESC, CHAR_LENGTH(c.name), c.name
		  LIMIT 20`,
		[like(q) + "%", like(q) + "%", q, q]
	);
	return rows.map((r) => ({ ...r, warehouses: Number(r.warehouses) }));
}

async function warehouses(cityRef, q, type) {
	if (!isRef(cityRef)) return [];
	q = String(q || "").trim();
	const where = ["city_ref = ?"];
	const args = [cityRef];
	if (type === "postomat") where.push("type = 'postomat'");
	else if (type === "warehouse") where.push("type <> 'postomat'");
	if (/^\d+$/.test(q)) {
		where.push("(number = ? OR name LIKE ?)");
		args.push(Number(q), "%" + like(q) + "%");
	} else if (q) {
		where.push("(name LIKE ? OR short_address LIKE ?)");
		args.push("%" + like(q) + "%", "%" + like(q) + "%");
	}
	const [rows] = await pool.query(`SELECT ref, number, type, name, short_address, max_weight, status FROM ${P}np_warehouses WHERE ${where.join(" AND ")} ORDER BY number LIMIT 100`, args);
	return rows;
}

async function city(ref) {
	if (!isRef(ref)) return null;
	const [[r]] = await pool.query(`SELECT ref, name, name_ru, area_ref, area FROM ${P}np_cities WHERE ref = ?`, [ref]);
	return r || null;
}

async function warehouse(ref) {
	if (!isRef(ref)) return null;
	const [[r]] = await pool.query(`SELECT ref, city_ref, number, type, name, max_weight FROM ${P}np_warehouses WHERE ref = ?`, [ref]);
	if (r) return r;
	// Немає в довіднику (нове відділення або довідник ще не повний) — беремо з НП і дописуємо
	try {
		const { data } = await api.call(await apiKey(), "Address", "getWarehouses", { Ref: ref });
		if (!(await saveWarehouses(data, new Date().toISOString().slice(0, 19).replace("T", " ")))) return null;
		const [[w]] = await pool.query(`SELECT ref, city_ref, number, type, name, max_weight FROM ${P}np_warehouses WHERE ref = ?`, [ref]);
		return w || null;
	} catch (e) {
		return null;
	}
}

/** Місто за назвою: однозначний збіг (укр / рос); у дужках область — «Абрикосівка (Хмельницька обл.)» */
async function cityByName(name, area) {
	name = String(name || "").trim();
	if (!name) return null;
	const [rows] = await pool.query(`SELECT ref, name, area FROM ${P}np_cities WHERE name = ? OR name_ru = ? LIMIT 10`, [name, name]);
	if (rows.length === 1) return rows[0];
	if (rows.length > 1 && area) {
		const a = String(area).toLowerCase().slice(0, 5);
		const hit = rows.filter((r) => String(r.area || "").toLowerCase().startsWith(a));
		if (hit.length === 1) return hit[0];
	}
	// Найбільше місто з такою назвою — лише якщо в нього є відділення, а в інших немає
	if (rows.length > 1) {
		const [w] = await pool.query(`SELECT city_ref, COUNT(*) AS n FROM ${P}np_warehouses WHERE city_ref IN (?) GROUP BY city_ref`, [rows.map((r) => r.ref)]);
		if (w.length === 1) return rows.find((r) => r.ref === w[0].city_ref) || null;
	}
	return null;
}

/** Відділення за номером у місті */
async function warehouseByNumber(cityRef, number) {
	if (!isRef(cityRef) || !(Number(number) > 0)) return null;
	const [rows] = await pool.query(`SELECT ref, city_ref, number, type, name FROM ${P}np_warehouses WHERE city_ref = ? AND number = ? LIMIT 2`, [cityRef, Number(number)]);
	return rows.length === 1 ? rows[0] : null;
}

module.exports = { sync, syncIfDue, syncState, cities, warehouses, city, warehouse, cityByName, warehouseByNumber };
