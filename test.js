#!/usr/bin/env node
"use strict";

/**
 * schema-diff.js
 * ------------------------------------------------------------------
 * Порівнює структуру двох баз MySQL:
 *   source — еталон (демо, нова версія)
 *   target — база клієнта (стара версія)
 * і генерує ОДИН .sql файл, який доводить target до стану source:
 *   • нові таблиці (CREATE TABLE IF NOT EXISTS)
 *   • нові колонки (ADD COLUMN у правильному порядку FIRST/AFTER)
 *   • змінені колонки (MODIFY COLUMN)
 *   • змінені характеристики таблиці (ENGINE / DEFAULT CHARSET / COLLATE)
 *   • нові / змінені індекси
 *   • нові / змінені зовнішні ключі (з очищенням «сиріт» перед додаванням)
 *   • дані довідників (за списком у конфігу; режими insert-missing/upsert/replace-all)
 *   • ignoreTables — таблиці, для яких дані генеруються як INSERT IGNORE INTO
 *     (структура — нові колонки / зміни / видалення — при цьому ВСЕ ОДНО відстежується)
 *
 * Скрипт ЛИШЕ ЧИТАЄ обидві бази. Нічого не змінює.
 * Результат — файл міграції, який ти переглядаєш і застосовуєш сам (після бекапу).
 *
 * Запуск (один самодостатній JS-файл, жодних JSON-конфігів):
 *   node schema-diff.js [--out migration.sql]
 * Усі доступи та налаштування — у об'єкті CONFIG нижче в цьому файлі.
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

// ─── КОНФІГ (усе в цьому файлі) ────────────────────────────────────
// Заповни своїми даними.
const CONFIG = {
	source: {
		socketPath: "/var/run/mysqld/mysqld.sock",
		host: "localhost",
		port: 3306,
		user: "",
		password: "",
		database: "",
		prefix: "",
	},
	target: {
		socketPath: "/var/run/mysqld/mysqld.sock",
		host: "localhost",
		port: 3306,
		user: "",
		password: "",
		database: "",
		prefix: "",
	},
	options: {
		modifyColumns: true,
		dropExtraColumns: false,
		dropExtraIndexes: false,
		dropExtraForeignKeys: false,
		fixOrphans: true,
		includeTables: [],
		excludeTables: [],
		// Таблиці, які НЕ переносимо як звичайні довідники:
		// структура (нові колонки, зміни, порядок, індекси, FK) — відстежується,
		// але рядки-дані в SQL-файл не пишуться взагалі.
		skipTables: ["*_sessions"],
		// Таблиці, чиї дані переносяться як INSERT IGNORE INTO
		// (не перезаписують те, що клієнт відредагував у своєму UI;
		//  дописують лише відсутні рядки). Структура при цьому порівнюється повністю.
		ignoreTables: [
			"clients_legal_types",
			"clients_legal_types_lang",
			"clients_identifier_types",
			"clients_identifier_types_lang",
			"clients_contact_types",
			"clients_contact_types_lang",
			"clients_address_types",
			"clients_address_types_lang",
			"clients_relationship_types",
			"clients_relationship_types_lang",
			"clients_role_types",
			"clients_role_types_lang",
			"clients_lifecycle_stages",
			"clients_lifecycle_stages_lang",
		],
	},
	data: {
		// Шаблони назв таблиць (без префікса), для яких генерувати блоки даних.
		// Режим "auto": ignoreTables → insert-ignore, skipTables → без даних,
		// решта — upsert (доводить довідник до еталонного стану).
		"clients_legal_types*": "auto",
		"clients_identifier_types*": "auto",
		"clients_contact_types*": "auto",
		"clients_address_types*": "auto",
		"clients_relationship_types*": "auto",
		"clients_role_types*": "auto",
		"clients_lifecycle_stages*": "auto",
		// Приклади явних режимів:
		// "some_table": "insert-missing", // INSERT IGNORE INTO (те саме, що ignoreTables)
		// "other_table": "upsert",        // ON DUPLICATE KEY UPDATE
		// "third_table": "replace-all",   // DELETE + INSERT
	},
	output: null, // напр. "migration.sql"; null = migration_<timestamp>.sql
};

// ─── Аргументи ─────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name, def) {
	const i = argv.indexOf("--" + name);
	if (i === -1) return def;
	const next = argv[i + 1];
	return next && !next.startsWith("--") ? next : true;
}
function stamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Конфіг — завжди вбудований CONFIG у цьому файлі (без зовнішніх JSON).
const cfg = CONFIG;

const OPT = Object.assign(
	{
		modifyColumns: true,
		dropExtraColumns: false,
		dropExtraIndexes: false,
		dropExtraForeignKeys: false,
		fixOrphans: true,
		includeTables: [],
		excludeTables: [],
		skipTables: [],
		ignoreTables: [],
	},
	cfg.options || {}
);
const OUT = path.resolve(String(arg("out", cfg.output || `migration_${stamp()}.sql`)));

const SP = cfg.source.prefix || "";
const TP = cfg.target.prefix || "";

// ─── Хелпери ───────────────────────────────────────────────────────
const q = (name) => "`" + String(name).replace(/`/g, "``") + "`";

function wildcard(pattern) {
	return new RegExp("^" + String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
}
function matchAny(name, patterns) {
	return (patterns || []).some((p) => wildcard(p).test(name));
}

// Префікс еталона → префікс цілі у всіх ідентифікаторах у лапках
function rewrite(sql) {
	if (!SP || SP === TP) return sql;
	return sql.split("`" + SP).join("`" + TP);
}

// Нормалізація визначення для порівняння
function norm(s) {
	return String(s)
		.replace(/\s+/g, " ")
		.replace(/\b(tinyint|smallint|mediumint|int|bigint)\(\d+\)/gi, (m, t) => (m.toLowerCase() === "tinyint(1)" ? "tinyint(1)" : t.toLowerCase()))
		.replace(/ CHARACTER SET \w+/gi, "")
		.replace(/ COLLATE \w+/gi, "")
		.replace(/ COMMENT '(?:[^'\\]|\\.|'')*'/gi, "")
		.replace(/DEFAULT '(-?\d+(?:\.\d+)?)'/g, "DEFAULT $1")
		.replace(/ USING BTREE/gi, "")
		.trim()
		.toLowerCase();
}

// Витягнути значення опції з рядка "OPTION=value ..." з хвоста CREATE TABLE
function tableOpt(hay, re) {
	const m = hay.match(re);
	return m ? m[1] : null;
}

// Розбір SHOW CREATE TABLE на колонки, індекси, FK, CHECK та опції таблиці
function parseCreate(sql) {
	const lines = sql.split("\n");
	let end = lines.length - 1;
	for (let i = 1; i < lines.length; i++) {
		if (/^\)/.test(lines[i])) {
			end = i;
			break;
		}
	}
	const res = { columns: new Map(), order: [], indexes: new Map(), fks: new Map(), checks: [], opts: {} };

	for (const raw of lines.slice(1, end)) {
		const line = raw.trim().replace(/,$/, "");
		let m;
		if ((m = line.match(/^`((?:[^`]|``)+)`\s/))) {
			const name = m[1].replace(/``/g, "`");
			res.columns.set(name, { def: line, nullable: !/\bNOT NULL\b/i.test(line) });
			res.order.push(name);
		} else if (/^PRIMARY KEY/i.test(line)) {
			res.indexes.set("PRIMARY", { def: line, columns: cols(line) });
		} else if ((m = line.match(/^(?:UNIQUE |FULLTEXT |SPATIAL )?KEY `([^`]+)`/i))) {
			res.indexes.set(m[1], { def: line, columns: cols(line) });
		} else if ((m = line.match(/^CONSTRAINT `([^`]+)` FOREIGN KEY \(([^)]+)\) REFERENCES `([^`]+)` \(([^)]+)\)/i))) {
			res.fks.set(m[1], {
				def: line,
				columns: splitCols(m[2]),
				refTable: m[3],
				refColumns: splitCols(m[4]),
			});
		} else if (/^CONSTRAINT `[^`]+` CHECK/i.test(line)) {
			res.checks.push(line);
		}
	}

	// Рядок після ")" — характеристики таблиці (ENGINE=... ROW_FORMAT=...)
	const tail = lines.slice(end + 1).join(" ").trim().replace(/;+$/, "");
	res.opts = {
		engine: tableOpt(tail, /ENGINE=(\w+)/i),
		charset: tableOpt(tail, /DEFAULT CHARSET=(\w+)/i),
		collate: tableOpt(tail, /COLLATE=(\w+)/i),
		rowFormat: tableOpt(tail, /ROW_FORMAT=(\w+)/i),
	};
	return res;
}
function splitCols(s) {
	return String(s)
		.split(",")
		.map((x) => x.trim().replace(/^`|`$/g, "").replace(/\(\d+\)$/, "").replace(/`\(\d+\)$/, ""));
}
function cols(line) {
	const m = line.match(/\((.+)\)/);
	return m ? splitCols(m[1]) : [];
}

// Значення → SQL-літерал
function lit(v) {
	if (v === null || v === undefined) return "NULL";
	if (Buffer.isBuffer(v)) return v.length ? "X'" + v.toString("hex") + "'" : "''";
	if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
	if (typeof v === "boolean") return v ? "1" : "0";
	if (v instanceof Date) {
		const p = (n) => String(n).padStart(2, "0");
		return `'${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}'`;
	}
	if (typeof v === "object") return mysql.escape(JSON.stringify(v));
	return mysql.escape(String(v));
}

async function connect(c) {
	const conn = await mysql.createConnection({
		host: c.socketPath ? undefined : c.host || "localhost",
		port: c.socketPath ? undefined : c.port || 3306,
		socketPath: c.socketPath || undefined,
		user: c.user,
		password: c.password,
		database: c.database,
		charset: "utf8mb4",
		dateStrings: true,
		multipleStatements: false,
		supportBigNumbers: true,
		bigNumberStrings: true,
	});
	return conn;
}

async function listTables(db, prefix) {
	const like = prefix.replace(/[\\%_]/g, "\\$&") + "%";
	const [rows] = await db.query("SHOW FULL TABLES LIKE ?", [like]);
	return rows
		.filter((r) => Object.values(r)[1] === "BASE TABLE")
		.map((r) => Object.values(r)[0])
		.filter((n) => n.startsWith(prefix))
		.map((n) => n.slice(prefix.length));
}

async function showCreate(db, table) {
	const [[r]] = await db.query("SHOW CREATE TABLE " + q(table));
	return r["Create Table"];
}

// ─── Основна логіка ────────────────────────────────────────────────
(async function main() {
	const src = await connect(cfg.source);
	const tgt = await connect(cfg.target);

	const [[sv]] = await src.query("SELECT VERSION() AS v");
	const [[tv]] = await tgt.query("SELECT VERSION() AS v");

	const report = { newTables: [], addColumns: 0, modifyColumns: 0, tableOpts: 0, indexes: 0, fks: 0, dataTables: 0, dataRows: 0, warnings: [], extras: [] };

	const out = {
		dropFks: [],
		createTables: [],
		alterColumns: [],
		indexes: [],
		data: [],
		orphans: [],
		addFks: [],
		drops: [],
	};

	let srcTables = await listTables(src, SP);
	const tgtTables = new Set(await listTables(tgt, TP));

	if (OPT.includeTables.length) srcTables = srcTables.filter((t) => matchAny(t, OPT.includeTables));
	if (OPT.excludeTables.length) srcTables = srcTables.filter((t) => !matchAny(t, OPT.excludeTables));

	const srcSet = new Set(srcTables);
	for (const t of tgtTables) {
		if (!srcSet.has(t) && !matchAny(t, OPT.excludeTables)) report.extras.push(`Таблиця ${TP}${t} є лише в цілі (не чіпається)`);
	}

	for (const name of srcTables) {
		const full = TP + name;
		const sCreate = rewrite(await showCreate(src, SP + name));

		// ── Нова таблиця ──
		if (!tgtTables.has(name)) {
			const create = sCreate.replace(/^CREATE TABLE /, "CREATE TABLE IF NOT EXISTS ").replace(/ AUTO_INCREMENT=\d+/, "");
			out.createTables.push(`-- Нова таблиця\n${create};`);
			report.newTables.push(full);
			continue;
		}

		const S = parseCreate(sCreate);
		const T = parseCreate(await showCreate(tgt, full));
		const droppedFks = new Set();

		const dropFksOnColumns = (colNames) => {
			for (const [fkName, fk] of T.fks) {
				if (droppedFks.has(fkName)) continue;
				if (fk.columns.some((c) => colNames.includes(c))) {
					out.dropFks.push(`ALTER TABLE ${q(full)} DROP FOREIGN KEY ${q(fkName)};`);
					droppedFks.add(fkName);
				}
			}
		};

		// ── Колонки ──
		S.order.forEach((col, i) => {
			const sc = S.columns.get(col);
			const tc = T.columns.get(col);
			const pos = i === 0 ? "FIRST" : "AFTER " + q(S.order[i - 1]);
			if (!tc) {
				out.alterColumns.push(`ALTER TABLE ${q(full)} ADD COLUMN ${sc.def} ${pos};`);
				report.addColumns++;
			} else if (norm(sc.def) !== norm(tc.def)) {
				if (OPT.modifyColumns) {
					dropFksOnColumns([col]);
					out.alterColumns.push(`-- було: ${tc.def}\nALTER TABLE ${q(full)} MODIFY COLUMN ${sc.def};`);
					report.modifyColumns++;
				} else {
					report.warnings.push(`${full}.${col} відрізняється (modifyColumns вимкнено): «${tc.def}» → «${sc.def}»`);
				}
			}
		});
		for (const col of T.order) {
			if (S.columns.has(col)) continue;
			if (OPT.dropExtraColumns) {
				dropFksOnColumns([col]);
				out.drops.push(`ALTER TABLE ${q(full)} DROP COLUMN ${q(col)};`);
			} else {
				report.extras.push(`Колонка ${full}.${col} є лише в цілі (не видаляється)`);
			}
		}

		// ── Індекси ──
		for (const [key, si] of S.indexes) {
			const ti = T.indexes.get(key);
			if (!ti) {
				out.indexes.push(`ALTER TABLE ${q(full)} ADD ${si.def};`);
				report.indexes++;
			} else if (norm(si.def) !== norm(ti.def)) {
				dropFksOnColumns(ti.columns);
				const drop = key === "PRIMARY" ? "DROP PRIMARY KEY" : "DROP INDEX " + q(key);
				out.indexes.push(`-- було: ${ti.def}\nALTER TABLE ${q(full)} ${drop}, ADD ${si.def};`);
				report.indexes++;
			}
		}
		for (const [key, ti] of T.indexes) {
			if (S.indexes.has(key)) continue;
			if (OPT.dropExtraIndexes && key !== "PRIMARY") {
				dropFksOnColumns(ti.columns);
				out.drops.push(`ALTER TABLE ${q(full)} DROP INDEX ${q(key)};`);
			} else {
				report.extras.push(`Індекс ${full}.${key} є лише в цілі (не видаляється)`);
			}
		}

		// ── Характеристики таблиці (ENGINE / CHARSET / COLLATE / ROW_FORMAT) ──
		{
			const sets = [];
			if (S.opts.engine && T.opts.engine && S.opts.engine.toLowerCase() !== T.opts.engine.toLowerCase()) sets.push("ENGINE = " + S.opts.engine);
			if (S.opts.charset && T.opts.charset && S.opts.charset.toLowerCase() !== T.opts.charset.toLowerCase()) sets.push("DEFAULT CHARSET = " + S.opts.charset);
			if (S.opts.collate && T.opts.collate && S.opts.collate.toLowerCase() !== T.opts.collate.toLowerCase()) sets.push("COLLATE = " + S.opts.collate);
			if (S.opts.rowFormat && T.opts.rowFormat && S.opts.rowFormat.toLowerCase() !== T.opts.rowFormat.toLowerCase()) sets.push("ROW_FORMAT = " + S.opts.rowFormat);
			if (sets.length) {
				out.tableOpts = out.tableOpts || [];
				out.tableOpts.push(`ALTER TABLE ${q(full)} ${sets.join(", ")};`);
				report.tableOpts += sets.length;
			}
		}

		// ── Зовнішні ключі ──
		for (const [fkName, sf] of S.fks) {
			const tf = T.fks.get(fkName);
			const needAdd = !tf || droppedFks.has(fkName) || norm(sf.def) !== norm(tf.def);
			if (!needAdd) continue;

			if (tf && !droppedFks.has(fkName)) {
				out.dropFks.push(`ALTER TABLE ${q(full)} DROP FOREIGN KEY ${q(fkName)};`);
				droppedFks.add(fkName);
			}

			if (OPT.fixOrphans && sf.columns.length === 1 && sf.refColumns.length === 1) {
				const c = sf.columns[0];
				const colInfo = S.columns.get(c);
				const refTable = sf.refTable;
				if (colInfo && colInfo.nullable) {
					out.orphans.push(
						`-- ${full}.${c} → ${refTable}.${sf.refColumns[0]}: посилання на неіснуючі записи стають NULL\n` +
							`UPDATE ${q(full)} ch LEFT JOIN ${q(refTable)} pr ON pr.${q(sf.refColumns[0])} = ch.${q(c)} SET ch.${q(c)} = NULL WHERE ch.${q(c)} IS NOT NULL AND pr.${q(sf.refColumns[0])} IS NULL;`
					);
				} else {
					out.orphans.push(
						`-- УВАГА: ${full}.${c} NOT NULL — «сироти» не обнуляються автоматично. Перевірка:\n` +
							`-- SELECT COUNT(*) FROM ${q(full)} ch LEFT JOIN ${q(refTable)} pr ON pr.${q(sf.refColumns[0])} = ch.${q(c)} WHERE pr.${q(sf.refColumns[0])} IS NULL;`
					);
					report.warnings.push(`FK ${fkName}: колонка ${full}.${c} NOT NULL — перевір «сиріт» вручну перед застосуванням`);
				}
			} else if (sf.columns.length > 1) {
				report.warnings.push(`FK ${fkName} складений — «сиріт» перевір вручну`);
			}

			out.addFks.push(`ALTER TABLE ${q(full)} ADD ${sf.def};`);
			report.fks++;
		}
		for (const [fkName] of T.fks) {
			if (S.fks.has(fkName) || droppedFks.has(fkName)) continue;
			if (OPT.dropExtraForeignKeys) {
				out.dropFks.push(`ALTER TABLE ${q(full)} DROP FOREIGN KEY ${q(fkName)};`);
			} else {
				report.extras.push(`FK ${full}.${fkName} є лише в цілі (не видаляється)`);
			}
		}

		if (S.checks.length !== T.checks.length) report.warnings.push(`${full}: відрізняються CHECK-обмеження — перевір вручну`);
	}

	// ── Дані довідників ──
	const dataRules = Object.entries(cfg.data || {});
	const srcAll = await listTables(src, SP);
	for (const [pattern, modeRaw] of dataRules) {
		const matched = srcAll.filter((t) => wildcard(pattern).test(t));
		if (!matched.length) report.warnings.push(`data: у еталоні немає таблиць за шаблоном ${pattern}`);

		for (const name of matched) {
			// Визначаємо режим: skipTables — не переносимо дані взагалі;
			// ignoreTables — INSERT IGNORE INTO; інакше — режим із cfg.data
			// ("auto" для решти = upsert).
			if (matchAny(name, OPT.skipTables)) {
				report.extras.push(`Дані ${TP}${name}: пропущено (skipTables) — структуру все одно перевірено`);
				continue;
			}
			let mode = String(modeRaw);
			if (mode === "auto") mode = matchAny(name, OPT.ignoreTables) ? "insert-ignore" : "upsert";
			else if (mode === "insert-missing") mode = "insert-ignore"; // стара назва = новій
			if (!["insert-ignore", "upsert", "replace-all"].includes(mode)) {
				report.warnings.push(`data: невідомий режим «${modeRaw}» для ${pattern}`);
				continue;
			}

			const full = TP + name;
			const [colsInfo] = await src.query("SHOW FULL COLUMNS FROM " + q(SP + name));
			const colsIns = colsInfo.filter((c) => !/GENERATED/i.test(c.Extra || "")).map((c) => c.Field);
			const pk = colsInfo.filter((c) => c.Key === "PRI").map((c) => c.Field);

			const [rows] = await src.query(`SELECT ${colsIns.map(q).join(", ")} FROM ${q(SP + name)}${pk.length ? " ORDER BY " + pk.map(q).join(", ") : ""}`);
			report.dataTables++;
			report.dataRows += rows.length;

			const block = [`-- Дані: ${full} (${rows.length} рядків, режим ${mode})`];
			if (mode === "replace-all") block.push(`DELETE FROM ${q(full)};`);
			if (!rows.length) {
				out.data.push(block.join("\n"));
				continue;
			}

			const head = `INSERT ${mode === "insert-ignore" ? "IGNORE " : ""}INTO ${q(full)} (${colsIns.map(q).join(", ")}) VALUES`;
			const tail = mode === "upsert" ? " ON DUPLICATE KEY UPDATE " + colsIns.filter((c) => !pk.includes(c)).map((c) => `${q(c)} = VALUES(${q(c)})`).join(", ") : "";
			for (let i = 0; i < rows.length; i += 200) {
				const chunk = rows.slice(i, i + 200).map((r) => "(" + colsIns.map((c) => lit(r[c])).join(", ") + ")");
				block.push(`${head}\n${chunk.join(",\n")}${tail};`);
			}
			out.data.push(block.join("\n"));
		}
	}

	await src.end();
	await tgt.end();

	// ── Складання файлу ──
	const sections = [
		["1. Зняття зовнішніх ключів, що заважають змінам", out.dropFks],
		["2. Нові таблиці", out.createTables],
		["3. Колонки", out.alterColumns],
		["4. Індекси", out.indexes],
		["5. Характеристики таблиць", out.tableOpts || []],
		["6. Дані довідників", out.data],
		["7. Очищення посилань на неіснуючі записи", out.orphans],
		["8. Зовнішні ключі", out.addFks],
		["9. Видалення зайвого", out.drops],
	];

	const header = [
		"-- ================================================================",
		"-- Міграція структури бази",
		`-- Згенеровано: ${new Date().toISOString()}`,
		`-- Еталон: ${cfg.source.database} (префікс ${SP || "—"}), MySQL ${sv.v}`,
		`-- Ціль:   ${cfg.target.database} (префікс ${TP || "—"}), MySQL ${tv.v}`,
		"-- ",
		`-- Нових таблиць: ${report.newTables.length}`,
		`-- Нових колонок: ${report.addColumns}, змінених колонок: ${report.modifyColumns}`,
		`-- Індексів: ${report.indexes}, зовнішніх ключів: ${report.fks}, властивостей таблиць: ${report.tableOpts}`,
		`-- Таблиць з даними: ${report.dataTables}, рядків: ${report.dataRows}`,
		"-- ",
		`-- ignoreTables (дані як INSERT IGNORE INTO, структура порівнюється): ${(OPT.ignoreTables || []).length ? (OPT.ignoreTables || []).join(", ") : "—"} (шаблони)`,
		`-- skipTables (дані не переносяться, структура порівнюється): ${(OPT.skipTables || []).length ? (OPT.skipTables || []).join(", ") : "—"} (шаблони)`,
		"-- ",
		"-- ПЕРЕД ЗАСТОСУВАННЯМ ЗРОБИ ПОВНИЙ БЕКАП БАЗИ ЦІЛІ.",
		"-- ================================================================",
		"",
	];
	if (report.warnings.length) {
		header.push("-- ПОПЕРЕДЖЕННЯ:");
		report.warnings.forEach((w) => header.push("--   ! " + w));
		header.push("");
	}
	if (report.extras.length) {
		header.push("-- Є ЛИШЕ В ЦІЛІ / ПРОПУЩЕНО (для інформації):");
		report.extras.forEach((w) => header.push("--   · " + w));
		header.push("");
	}

	const body = [
		"SET NAMES utf8mb4;",
		"SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;",
		"SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
		"",
	];
	for (const [title, list] of sections) {
		if (!list.length) continue;
		body.push("-- ────────────────────────────────────────────────────────────────");
		body.push("-- " + title);
		body.push("-- ────────────────────────────────────────────────────────────────");
		body.push(list.join("\n\n"));
		body.push("");
	}
	body.push("SET SQL_MODE = @OLD_SQL_MODE;");
	body.push("SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;");
	body.push("");

	fs.writeFileSync(OUT, header.join("\n") + "\n" + body.join("\n"), "utf8");

	// ── Звіт у консоль ──
	console.log("\n✔ Міграцію згенеровано: " + OUT);
	console.log(`  Еталон MySQL ${sv.v} → ціль MySQL ${tv.v}`);
	if (sv.v.split(".")[0] !== tv.v.split(".")[0]) console.log("  ! Різні основні версії MySQL — уважно перевір файл.");
	console.log(`  Нових таблиць: ${report.newTables.length}`);
	console.log(`  Колонок: +${report.addColumns}, змінено ${report.modifyColumns}`);
	console.log(`  Індексів: ${report.indexes}, FK: ${report.fks}, властивостей таблиць: ${report.tableOpts}`);
	console.log(`  Дані: ${report.dataTables} табл., ${report.dataRows} рядків`);
	if (report.warnings.length) console.log(`  Попереджень: ${report.warnings.length} (див. початок файлу)`);
	if (report.extras.length) console.log(`  Лише в цілі / пропущено: ${report.extras.length} (не чіпаються, див. початок файлу)`);
	console.log("");
})().catch((e) => {
	console.error("✖ Помилка:", e.message);
	process.exit(1);
});
