"use strict";

/**
 * Каси Checkbox: ліцензійний ключ каси + PIN касира (обидва зашифровані), прив'язка до магазинів, налаштування.
 * Кілька кас — для кількох ФОП / магазинів. Для замовлення каса береться за магазином, інакше — за замовчуванням.
 */
const { pool, P, T, httpErr, str, json, phone380 } = require("./common");
const cryptoHelper = require("../../../helpers/crypto");
const { notify } = require("../../../controllers/notifications/notify");
const i18n = require("../../../config/i18n/i18n");
const api = require("./api");

const DEFAULTS = {
	tax_codes: [], // коди податкових ставок каси для товарів (порожньо — без податку, наприклад ФОП без ПДВ)
	shipping_tax_codes: [], // ставки для рядка доставки
	shipping_name: "", // назва рядка доставки в чеку (початкове значення — з перекладу на сторінці каси)
	header: "", // текст над чеком
	footer: "", // текст під чеком
	send_email: true, // надсилати чек на email клієнта
	send_sms: false, // надсилати чек SMS / Viber (платна послуга Checkbox)
	auto_shift: true, // відкривати зміну автоматично, коли потрібно видати чек
	shift_close: "23:50", // час автоматичного закриття зміни (Z-звіт) — передається Checkbox при відкритті
	cashless_label: "", // назва безготівкової оплати за замовчуванням (наприклад, «Платіж через інтегратора MONOBANK»)
	ettn_sender_phone: "", // телефон відправника в Новій Пошті (для ЕТТН)
	ettn_auto: false, // автоматично створювати ЕТТН для ТТН з накладеним платежем
	ettn_sms: true, // при отриманні посилки Checkbox надсилає чек SMS на телефон з ТТН
	auto_monobank: false, // чек автоматично при оплаті через Monobank (якщо банк не фіскалізує сам)
	monobank_label: "", // назва оплати в чеку для Monobank
	auto_statuses: [], // чек автоматично при переході замовлення в ці статуси
	auto_payment: "CASHLESS", // тип оплати для чеків за статусом
	auto_return: false, // чек повернення автоматично при поверненні в замовленні
	notify_users: [], // кому сповіщення: помилки фіскалізації, зміна відкрита понад 20 год, мало офлайн-кодів
};

const codes = (v) =>
	[...new Set((Array.isArray(v) ? v : String(v || "").split(/[\s,;]+/)).map((x) => String(x).trim()).filter((x) => /^[\w-]{1,8}$/.test(x)))].slice(0, 5);
const time = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || "")) ? String(v) : d);

function settingsOf(raw) {
	const s = { ...DEFAULTS, ...(json(raw, {}) || {}) };
	return { ...s, tax_codes: codes(s.tax_codes), shipping_tax_codes: codes(s.shipping_tax_codes) };
}

function cleanSettings(s) {
	s = s && typeof s === "object" ? s : {};
	return {
		tax_codes: codes(s.tax_codes),
		shipping_tax_codes: codes(s.shipping_tax_codes),
		shipping_name: str(s.shipping_name, 128) || "",
		header: str(s.header, 500) || "",
		footer: str(s.footer, 500) || "",
		send_email: s.send_email !== false,
		send_sms: !!s.send_sms,
		auto_shift: s.auto_shift !== false,
		shift_close: time(s.shift_close, DEFAULTS.shift_close),
		cashless_label: str(s.cashless_label, 128) || "",
		ettn_sender_phone: phone380(s.ettn_sender_phone) || "",
		ettn_auto: !!s.ettn_auto,
		ettn_sms: s.ettn_sms !== false,
		auto_monobank: !!s.auto_monobank,
		monobank_label: str(s.monobank_label, 128) || "",
		auto_statuses: [...new Set((Array.isArray(s.auto_statuses) ? s.auto_statuses : []).map(Number).filter((n) => n > 0))].slice(0, 20),
		auto_payment: s.auto_payment === "CASH" ? "CASH" : "CASHLESS",
		auto_return: !!s.auto_return,
		notify_users: [...new Set((Array.isArray(s.notify_users) ? s.notify_users : []).map(Number).filter((n) => n > 0))].slice(0, 50),
	};
}

function publicRow(r) {
	return {
		id: Number(r.id),
		name: r.name,
		test: !!r.test,
		license: r.license_last4 ? "••••" + r.license_last4 : "",
		has_pin: !!r.pin_cipher,
		cash_register_id: r.cash_register_id,
		fiscal_number: r.fiscal_number,
		cashier_name: r.cashier_name,
		status: Number(r.status),
		is_default: Number(r.is_default),
		settings: settingsOf(r.settings),
		integrations: (json(r.integrations, []) || []).map(Number),
		webhook: !!r.webhook_at,
	};
}

const dec = (r, k) => cryptoHelper.decrypt(r[k + "_cipher"], r[k + "_iv"], r[k + "_tag"]);

/** Клієнт API каси: новий JWT зберігається в касі */
function clientOf(r) {
	const license = dec(r, "license");
	const pin = dec(r, "pin");
	if (!license || !pin) throw httpErr(409, "modules.checkbox.e.no_credentials");
	return api.client({ id: r.id, test: !!r.test, license, pin, token: dec(r, "token") }, async (token) => {
		const e = cryptoHelper.encrypt(token);
		await pool.query(`UPDATE ${T.registers} SET token_cipher = ?, token_iv = ?, token_tag = ?, token_at = NOW() WHERE id = ?`, [e.cipher, e.iv, e.tag, r.id]);
	});
}

async function list() {
	const [rows] = await pool.query(`SELECT * FROM ${T.registers} ORDER BY is_default DESC, name`);
	return rows.map(publicRow);
}

/** Каса з клієнтом API — для серверного коду */
async function get(id) {
	const [[r]] = await pool.query(`SELECT * FROM ${T.registers} WHERE id = ?`, [id]);
	if (!r) throw httpErr(404, "modules.checkbox.e.register_not_found");
	return { ...publicRow(r), api: clientOf(r) };
}

/** Каса для магазину: прив'язана до інтеграції → за замовчуванням → перша активна */
async function forIntegration(idIntegration) {
	const [rows] = await pool.query(`SELECT * FROM ${T.registers} WHERE status = 1 ORDER BY is_default DESC, id`);
	const own = rows.find((r) => (json(r.integrations, []) || []).map(Number).includes(Number(idIntegration)));
	const r = own || rows[0];
	return r ? { ...publicRow(r), api: clientOf(r) } : null;
}

/**
 * Зберегти касу. Новий ключ / PIN перевіряються входом касира; з каси беруться фіскальний номер і ім'я касира.
 * Порожні ключ і PIN у формі існуючої каси — «не змінювати».
 */
async function save(id, b) {
	const name = str(b.name, 128);
	if (!name) throw httpErr(400, "modules.checkbox.e.name_required");
	let license = str(b.license, 128);
	let pin = str(b.pin, 32);
	const test = b.test ? 1 : 0;
	let cur = null;
	if (id) {
		const [[r]] = await pool.query(`SELECT * FROM ${T.registers} WHERE id = ?`, [id]);
		if (!r) throw httpErr(404, "modules.checkbox.e.register_not_found");
		cur = r;
	} else if (!license || !pin) throw httpErr(400, "modules.checkbox.e.credentials_required");

	const settings = cleanSettings(b.settings);
	const integrations = JSON.stringify([...new Set((Array.isArray(b.integrations) ? b.integrations : []).map(Number).filter((n) => n > 0))]);

	// Перевірка доступу: при новому ключі, PIN або зміні сервера (тест / бойовий)
	let info = null;
	const changed = !cur || license || pin || Number(cur.test) !== test;
	if (changed) {
		license = license || dec(cur, "license");
		pin = pin || dec(cur, "pin");
		if (!license || !pin) throw httpErr(400, "modules.checkbox.e.credentials_required");
		const c = api.client({ test, license, pin });
		await c.signin();
		const [me, reg] = await Promise.all([c.me().catch(() => ({})), c.registerInfo()]);
		info = {
			cash_register_id: str(reg.id, 64),
			fiscal_number: str(reg.fiscal_number, 64),
			cashier_name: str(me.full_name || [me.last_name, me.first_name].filter(Boolean).join(" "), 255),
		};
	}

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		if (b.is_default) await conn.query(`UPDATE ${T.registers} SET is_default = 0`);
		const base = [name, test, b.status ? 1 : 0, b.is_default ? 1 : 0, JSON.stringify(settings), integrations];
		if (id) await conn.query(`UPDATE ${T.registers} SET name = ?, test = ?, status = ?, is_default = ?, settings = ?, integrations = ?, date_edit = NOW() WHERE id = ?`, [...base, id]);
		else {
			const [r] = await conn.query(`INSERT INTO ${T.registers} (name, test, status, is_default, settings, integrations, date_add, date_edit) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`, base);
			id = r.insertId;
		}
		if (changed) {
			const l = cryptoHelper.encrypt(license);
			const p = cryptoHelper.encrypt(pin);
			// Новий ключ / PIN — старий токен недійсний
			await conn.query(
				`UPDATE ${T.registers} SET license_cipher = ?, license_iv = ?, license_tag = ?, license_last4 = ?, pin_cipher = ?, pin_iv = ?, pin_tag = ?,
				        token_cipher = NULL, token_iv = NULL, token_tag = NULL, token_at = NULL, cash_register_id = ?, fiscal_number = ?, cashier_name = ? WHERE id = ?`,
				[l.cipher, l.iv, l.tag, cryptoHelper.last4(license), p.cipher, p.iv, p.tag, info.cash_register_id, info.fiscal_number, info.cashier_name, id]
			);
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	} finally {
		conn.release();
	}
	// Вебхук: після зміни ключа / сервера — заново (новий секрет); якщо ще не підключено — теж
	const [[cur2]] = await pool.query(`SELECT webhook_at FROM ${T.registers} WHERE id = ?`, [id]);
	if (changed || !cur2.webhook_at) await setupWebhook(id).catch((e) => console.error(`[checkbox] webhook register #${id}:`, e.vars && e.vars.msg ? e.vars.msg : e.message));
	const [[row]] = await pool.query(`SELECT * FROM ${T.registers} WHERE id = ?`, [id]);
	return publicRow(row);
}

async function remove(id) {
	// Каса більше не потрібна — вебхук у Checkbox прибираємо (не критично, якщо не вдалося)
	await get(id)
		.then((reg) => reg.api.webhookDelete())
		.catch(() => null);
	await pool.query(`UPDATE ${T.registers} SET webhook_cipher = NULL, webhook_iv = NULL, webhook_tag = NULL, webhook_at = NULL WHERE id = ?`, [id]);
	const [[used]] = await pool.query(`SELECT (SELECT COUNT(*) FROM ${T.receipts} WHERE id_register = ?) + (SELECT COUNT(*) FROM ${T.ettn} WHERE id_register = ?) AS n`, [id, id]);
	// Є чеки — лише вимикаємо: історія й посилання на чеки лишаються
	if (Number(used.n)) {
		await pool.query(`UPDATE ${T.registers} SET status = 0, is_default = 0, date_edit = NOW() WHERE id = ?`, [id]);
		return { disabled: true };
	}
	await pool.query(`DELETE FROM ${T.registers} WHERE id = ?`, [id]);
	return { deleted: true };
}

/** Податкові ставки каси з Checkbox — для підказки в налаштуваннях */
async function taxes(id) {
	const reg = await get(id);
	const all = await reg.api.taxes();
	return {
		taxes: (Array.isArray(all) ? all : []).map((t) => ({ code: t.code, label: t.label, symbol: t.symbol, rate: t.rate, included: !!t.included, no_vat: !!t.no_vat })),
	};
}

/* ───────────────────────── Зміни й звіти ───────────────────────── */

/**
 * Зміни каси. Відкриття й закриття в Checkbox асинхронні: CREATED → OPENING → OPENED, CLOSING → CLOSED.
 * ensureOpen() — перед видачею чека: якщо зміни немає й у касі увімкнено «автовідкриття», відкриваємо й чекаємо OPENED.
 * При відкритті передаємо час автозакриття (налаштування каси) — Checkbox сам закриє зміну з Z-звітом.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TZ = "Europe/Kyiv";

async function event(reg, type, payload, idUser) {
	await pool.query(`INSERT INTO ${T.events} (id_register, id_order, type, payload, id_user, date_add) VALUES (?, NULL, ?, ?, ?, NOW())`, [reg.id, type, payload ? JSON.stringify(payload) : null, idUser || null]);
}

/** Сьогоднішній час HH:MM за Києвом → ISO з поясом; минув — null */
function closeAt(hhmm) {
	if (!/^\d{2}:\d{2}$/.test(String(hhmm || ""))) return null;
	const now = new Date();
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", timeZoneName: "shortOffset" }).formatToParts(now).map((p) => [p.type, p.value]));
	const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(parts.timeZoneName || "");
	const off = m ? `${m[1]}${m[2].padStart(2, "0")}:${m[3] || "00"}` : "+02:00";
	const at = new Date(`${parts.year}-${parts.month}-${parts.day}T${hhmm}:00${off}`);
	return at.getTime() > now.getTime() + 5 * 60 * 1000 ? at.toISOString() : null;
}

function pub(s) {
	if (!s || !s.id) return null;
	return {
		id: s.id,
		serial: s.serial,
		status: s.status,
		opened_at: s.opened_at || null,
		closed_at: s.closed_at || null,
		balance: s.balance ? Number(s.balance.balance || 0) / 100 : null,
		sales: s.balance ? Number(s.balance.sell_receipts_count || 0) : null,
	};
}

/** Поточна зміна касира (null — закрита) */
async function current(reg) {
	const s = await reg.api.currentShift().catch((e) => {
		// Немає зміни — Checkbox відповідає 404 / порожньо
		if (e.http === 404) return null;
		throw e;
	});
	return pub(s);
}

async function waitStatus(reg, want, tries = 15) {
	for (let i = 0; i < tries; i++) {
		const s = await current(reg);
		if (want === "OPENED" ? s && s.status === "OPENED" : !s || s.status === "CLOSED") return s;
		await sleep(1000);
	}
	return current(reg);
}

async function open(reg, idUser) {
	const cur = await current(reg);
	if (cur && (cur.status === "OPENED" || cur.status === "OPENING" || cur.status === "CREATED")) return { shift: cur.status === "OPENED" ? cur : await waitStatus(reg, "OPENED") };
	const at = closeAt(reg.settings.shift_close);
	await reg.api.openShift(at ? { auto_close_at: at } : {});
	const s = await waitStatus(reg, "OPENED");
	await event(reg, "shift_open", { serial: s && s.serial, auto_close_at: at }, idUser);
	if (!s || s.status !== "OPENED") throw httpErr(502, "modules.checkbox.e.shift_not_opened");
	return { shift: s };
}

async function close(reg, idUser) {
	const cur = await current(reg);
	if (!cur) throw httpErr(409, "modules.checkbox.e.no_shift");
	await reg.api.closeShift();
	const s = await waitStatus(reg, "CLOSED");
	await event(reg, "shift_close", { serial: cur.serial }, idUser);
	return { shift: s };
}

/** Перед чеком: відкрита зміна або автовідкриття */
async function ensureOpen(reg, idUser) {
	const cur = await current(reg);
	if (cur && cur.status === "OPENED") return cur;
	if (!reg.settings.auto_shift) throw httpErr(409, "modules.checkbox.e.no_shift");
	return (await open(reg, idUser)).shift;
}

/** X-звіт (без закриття зміни): текст для перегляду й друку */
async function xReport(reg, idUser) {
	const cur = await current(reg);
	if (!cur || cur.status !== "OPENED") throw httpErr(409, "modules.checkbox.e.no_shift");
	const r = await reg.api.xReport();
	await event(reg, "x_report", { id: r.id, serial: r.serial }, idUser);
	return { text: await reg.api.reportText(r.id) };
}

/* ───────────────────────── Звіти каси (Checkbox) ───────────────────────── */

const isoDay = (v, end) => {
	const d = /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null;
	if (!d) throw httpErr(400, "modules.checkbox.e.dates");
	return `${d}T${end ? "23:59:59" : "00:00:00"}`;
};

/** Періодичний звіт за дати (текст для перегляду й друку) */
async function periodical(id, from, to) {
	const reg = await get(id);
	return { text: await reg.api.periodical(isoDay(from), isoDay(to, true)) };
}

/** Z-звіти за дати: номер, дата, суми продажів і повернень */
async function zReports(id, from, to) {
	const reg = await get(id);
	const r = await reg.api.reports({ from_date: isoDay(from), to_date: isoDay(to, true), is_z_report: "true", desc: "true", limit: "100" });
	const sum = (pays) => (Array.isArray(pays) ? pays : []).reduce((a, p) => a + (Number(p.sell_sum) || 0), 0) / 100;
	const ret = (pays) => (Array.isArray(pays) ? pays : []).reduce((a, p) => a + (Number(p.return_sum) || 0), 0) / 100;
	return {
		rows: (r.results || []).map((z) => ({
			id: z.id,
			serial: z.serial,
			fiscal_code: z.fiscal_code || null,
			date: z.created_at,
			sell: sum(z.payments),
			returns: ret(z.payments),
			sell_count: Number(z.sell_receipts_count) || 0,
			return_count: Number(z.return_receipts_count) || 0,
		})),
	};
}

async function reportText(id, reportId) {
	const reg = await get(id);
	return { text: await reg.api.reportText(String(reportId)) };
}

/* ───────────────────────── Вебхук Checkbox ───────────────────────── */

const APP_URL = String(require("../../../config/config").get("configServer").url || "").replace(/\/+$/, "");
const webhookUrl = (id) => `${APP_URL}/api/module/checkbox/webhook/?r=${Number(id)}`;

/** Підключити вебхук каси: Checkbox повертає секретний ключ, яким підписує кожен запит */
async function setupWebhook(id) {
	if (!APP_URL) throw httpErr(500, "modules.checkbox.e.no_app_url");
	const reg = await get(id);
	const r = await reg.api.webhookSet(webhookUrl(id));
	if (!r || !r.key) throw httpErr(502, "modules.checkbox.e.bad_response");
	const e = cryptoHelper.encrypt(String(r.key));
	await pool.query(`UPDATE ${T.registers} SET webhook_cipher = ?, webhook_iv = ?, webhook_tag = ?, webhook_at = NOW() WHERE id = ?`, [e.cipher, e.iv, e.tag, id]);
	await event(reg, "webhook_set", { url: webhookUrl(id) });
	return { webhook: true };
}

/** Стан вебхука в Checkbox: адреса, остання помилка доставки */
async function webhookInfo(id) {
	const reg = await get(id);
	const r = await reg.api.webhookGet().catch((e) => (e.http === 404 ? null : Promise.reject(e)));
	return { info: r ? { url: r.url, last_error_date: r.last_error_date || null, last_error_message: r.last_error_message || null } : null };
}

/** Секретний ключ вебхука каси (null — не підключено) */
async function webhookKey(id) {
	const [[r]] = await pool.query(`SELECT webhook_cipher, webhook_iv, webhook_tag FROM ${T.registers} WHERE id = ?`, [id]);
	return r ? cryptoHelper.decrypt(r.webhook_cipher, r.webhook_iv, r.webhook_tag) : null;
}

/* ───────────────────────── Сповіщення команді ───────────────────────── */

const t = (phrase, vars) => i18n.__({ phrase, locale: process.env.APP_LOCALE || "uk" }, vars || {});

/**
 * Сповіщення адресатам каси (налаштування «Кому сповіщення») + менеджеру замовлення, якщо подія про замовлення.
 * key — захист від повторів (одна подія — одне сповіщення).
 */
async function alert(reg, kind, message, opts = {}) {
	const to = new Set((reg.settings.notify_users || []).map(Number));
	let url = "/modules/checkbox/receipts/";
	let title = `🧾 ${t("modules.checkbox.notify." + kind)} · ${reg.name}`;
	if (opts.idOrder) {
		const [[o]] = await pool.query(`SELECT id, reference, id_user FROM ${P}orders WHERE id = ?`, [opts.idOrder]);
		if (o) {
			if (o.id_user) to.add(Number(o.id_user));
			url = `/orders/${o.id}/`;
			title = `🧾 ${t("modules.checkbox.notify." + kind)} · ${o.reference || "#" + o.id}`;
		}
	}
	for (const user of to) {
		await notify({
			type: "modules.checkbox." + kind,
			audience: { user },
			channels: ["inapp", "webpush"],
			key: String(opts.key || `checkbox_${kind}_${reg.id}_${Date.now()}`).slice(0, 64),
			collapseKey: `checkbox_${kind}_${reg.id}`,
			priority: kind === "error" ? 7 : 6,
			payload: { title, name: "Checkbox", message: String(message || "").slice(0, 500), url, date: new Date().toISOString().slice(0, 19).replace("T", " ") },
		}).catch((e) => console.error("[checkbox] notify:", e.message));
	}
}

/** Помилка фіскалізації (чек, ЕТТН) — менеджеру замовлення й адресатам каси */
async function alertError(idRegister, idOrder, message, key) {
	const reg = await get(idRegister).catch(() => null);
	if (reg) await alert(reg, "error", message, { idOrder, key });
}

/**
 * Щогодини: зміна відкрита понад 20 год (Checkbox / ДПС обмежують зміну 24 год) і запас офлайн-кодів.
 * Попередження — раз на зміну / раз на добу (позначки в журналі каси).
 */
async function monitor() {
	const [rows] = await pool.query(`SELECT id FROM ${T.registers} WHERE status = 1`);
	for (const r of rows) {
		try {
			const reg = await get(r.id);
			const s = await current(reg);
			if (s && s.status === "OPENED" && s.opened_at && Date.now() - new Date(s.opened_at).getTime() > 20 * 3600 * 1000) {
				const [[w]] = await pool.query(`SELECT id FROM ${T.events} WHERE id_register = ? AND type = 'shift_warned' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.shift')) = ?`, [reg.id, String(s.id)]);
				if (!w) {
					await event(reg, "shift_warned", { shift: s.id, serial: s.serial });
					await alert(reg, "shift_long", t("modules.checkbox.notify.shift_long_text", { serial: s.serial, since: new Date(s.opened_at).toLocaleString("uk-UA") }), { key: `checkbox_shift_${s.id}` });
				}
			}
			const m = reg.cash_register_id ? await reg.api.registerState(reg.cash_register_id).catch(() => null) : null;
			const offline = !!(m && m.offline_mode);
			// Каса в офлайні не з нашої волі (ДПС не відповідає) — попередження раз на добу: офлайн дозволено до 36 год
			if (offline && !m.stay_offline) {
				const [[w]] = await pool.query(`SELECT id FROM ${T.events} WHERE id_register = ? AND type = 'offline_warned' AND date_add > NOW() - INTERVAL 1 DAY`, [reg.id]);
				if (!w) {
					await event(reg, "offline_warned", null);
					await alert(reg, "offline", t("modules.checkbox.notify.offline_text"), { key: `checkbox_offline_${reg.id}_${new Date().toISOString().slice(0, 10)}` });
				}
			}
			const c = await reg.api.offlineCodesCount().catch(() => null);
			// Каса онлайн, а кодів мало — поповнюємо запас сами (ДПС видає до 5000), щоб автоматичний офлайн Checkbox мав коди
			if (c && !offline && Number(c.minimal) > 0 && Number(c.available) < Number(c.minimal)) {
				await reg.api.askOfflineCodes(Math.min(5000, Math.max(Number(c.default) || 1000, Number(c.minimal) * 2))).catch((e) => console.error(`[checkbox] ask codes #${reg.id}:`, e.message));
				await event(reg, "codes_asked", { available: c.available, minimal: c.minimal });
			} else if (c && Number(c.minimal) > 0 && Number(c.available) < Number(c.minimal)) {
				const [[w]] = await pool.query(`SELECT id FROM ${T.events} WHERE id_register = ? AND type = 'offline_codes_warned' AND date_add > NOW() - INTERVAL 1 DAY`, [reg.id]);
				if (!w) {
					await event(reg, "offline_codes_warned", { available: c.available, minimal: c.minimal });
					await alert(reg, "offline_codes", t("modules.checkbox.notify.offline_codes_text", { available: c.available, minimal: c.minimal }), { key: `checkbox_codes_${reg.id}_${new Date().toISOString().slice(0, 10)}` });
				}
			}
		} catch (e) {
			console.error(`[checkbox] monitor register #${r.id}:`, e.vars && e.vars.msg ? e.vars.msg : e.message);
		}
	}
}

/* ───────────────────────── Режим каси: онлайн / офлайн ───────────────────────── */

/**
 * Стан каси в Checkbox: офлайн-режим (stay_offline — перехід зробили ми, інакше Checkbox перейшов сам, бо мовчить ДПС),
 * запас офлайн-кодів, чи повертаємо касу в онлайн.
 */
async function mode(id) {
	const reg = await get(id);
	const [[r]] = await pool.query(`SELECT online_pending FROM ${T.registers} WHERE id = ?`, [id]);
	const m = reg.cash_register_id ? await reg.api.registerState(reg.cash_register_id) : {};
	const c = await reg.api.offlineCodesCount().catch(() => null);
	return {
		mode: {
			offline: !!m.offline_mode,
			manual: !!m.stay_offline,
			going_online: !!(r && r.online_pending),
			codes: c ? { available: Number(c.available) || 0, minimal: Number(c.minimal) || 0 } : null,
		},
	};
}

/**
 * Перейти в офлайн вручну (наприклад, проблеми з ДПС, які Checkbox ще не помітив).
 * Дату й код підставляє Checkbox — так не порушиться порядок транзакцій (невірна дата «ламає» касу).
 */
async function goOffline(id, idUser) {
	const reg = await get(id);
	await reg.api.goOffline();
	await pool.query(`UPDATE ${T.registers} SET online_pending = NULL, online_try = NULL WHERE id = ?`, [id]);
	await event(reg, "go_offline", null, idUser);
	return mode(id);
}

/** Повернути в онлайн: Checkbox досилає офлайн-чеки в ДПС; запит повторюється раз на 2 хв, доки каса не стане онлайн */
async function goOnline(id, idUser) {
	const reg = await get(id);
	await pool.query(`UPDATE ${T.registers} SET online_pending = NOW() WHERE id = ?`, [id]);
	await event(reg, "go_online", null, idUser);
	await onlineTick(id);
	return mode(id);
}

/** Щохвилини: каси, які повертаємо в онлайн. Обмеження Checkbox — 1 запит go-online на 2 хв для каси */
async function onlineTick(onlyId) {
	const [rows] = await pool.query(
		`SELECT id FROM ${T.registers} WHERE online_pending IS NOT NULL AND (online_try IS NULL OR online_try < NOW() - INTERVAL 2 MINUTE)${onlyId ? " AND id = " + Number(onlyId) : ""}`
	);
	for (const r of rows) {
		try {
			const reg = await get(r.id);
			const m = await reg.api.registerState(reg.cash_register_id);
			if (!m.offline_mode) {
				await pool.query(`UPDATE ${T.registers} SET online_pending = NULL, online_try = NULL WHERE id = ?`, [r.id]);
				await event(reg, "online", null);
				continue;
			}
			await pool.query(`UPDATE ${T.registers} SET online_try = NOW() WHERE id = ?`, [r.id]);
			await reg.api.goOnline();
		} catch (e) {
			console.error(`[checkbox] go-online #${r.id}:`, e.vars && e.vars.msg ? e.vars.msg : e.message);
		}
	}
}

/** Вручну: попросити в ДПС офлайн-коди (лише онлайн) */
async function askCodes(id, idUser) {
	const reg = await get(id);
	const c = await reg.api.offlineCodesCount().catch(() => ({}));
	await reg.api.askOfflineCodes(Math.min(5000, Number(c.default) || 1000));
	await event(reg, "codes_asked", { manual: true }, idUser);
	return mode(id);
}

/** Користувачі для вибору адресатів сповіщень */
async function users() {
	const [rows] = await pool.query(`SELECT id, TRIM(CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, ''))) AS name FROM ${P}users ORDER BY first_name, last_name`);
	return rows.map((u) => ({ id: Number(u.id), name: u.name || "#" + u.id }));
}

module.exports = {
	list,
	get,
	forIntegration,
	save,
	remove,
	taxes,
	settingsOf,
	periodical,
	zReports,
	reportText,
	alertError,
	monitor,
	setupWebhook,
	mode,
	goOffline,
	goOnline,
	onlineTick,
	askCodes,
	webhookInfo,
	webhookKey,
	users,
	shifts: { current, open, close, ensureOpen, xReport },
};