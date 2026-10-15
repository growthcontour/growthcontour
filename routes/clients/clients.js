const express = require("express");
const router = express.Router();

const authorizationControllers = require("../../controllers/authorization/authorization");
const connection_pool = require("../../config/database/connection_pool");
const config = require("../../config/config");
const logging = require("../../logging/logging");
const dict = require("../../controllers/clients/dictionaries");
const normalize = require("../../controllers/clients/normalize");
const audit = require("../../controllers/common/audit");

const P = config.get("configDatabase").prefix;

let BASE_CURRENCY = "USD";
try {
	BASE_CURRENCY = require("../../controllers/orders/currency").BASE_CURRENCY || BASE_CURRENCY;
} catch (e) {}

const formatDate = (date) => {
	if (!date) return null;
	const d = new Date(date);
	const pad = (n) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
};

const pickDict = (r) => ({
	id: r.id,
	code: r.code,
	name: r.name,
	short_name: r.short_name || null,
	kind: r.kind || null,
	color_text: r.color_text || null,
	color_background: r.color_background || null,
	icon: r.icon || null,
});

// ─────────────────────────────────────────────
// Сторінки
// ─────────────────────────────────────────────
const rfm = require("../../controllers/clients/rfm");
const rfmOf = (code) => {
	const s = code && rfm.SEG_BY_CODE[code];
	return s ? { code: s.code, name: s.name, color: s.color, icon: s.icon } : null;
};

router.get("/clients/", authorizationControllers.isAuthenticated, (req, res) => {
	res.render("pages/clients/index", {
		i18n: req,
		user: req.user,
		header: { navbar: "clients" },
		segments: rfm.SEGMENTS.map((s) => ({ code: s.code, name: s.name })),
	});
});

// Ручний перерахунок RFM і «Втрачених» (адміністратор)
router.get("/api/clients/rfm/recalc/", authorizationControllers.isAuthenticated, async (req, res) => {
	if (!authorizationControllers.hasPermission(req, "clients.settings", "edit")) return res.status(403).json({ ok: false });
	try {
		res.json({ ok: true, ...(await rfm.nightly()) });
	} catch (e) {
		logging.error(e);
		res.status(500).json({ ok: false, error: e.message });
	}
});

router.get("/clients/duplicates/", authorizationControllers.isAuthenticated, (req, res) => {
	res.render("pages/clients/duplicates", {
		i18n: req,
		user: req.user,
		header: { navbar: "clients" },
	});
});

// Зведення по клієнту для порівняння перед злиттям
async function mergeSummary(id, idLang) {
	const [[c]] = await connection_pool.query(
		`SELECT c.*, st.orders_count, st.orders_valid_count, st.revenue_base, st.leads_count,
                NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS manager_name,
                (SELECT COUNT(*) FROM ${P}clients_addresses WHERE id_client = c.id) AS addresses_count,
                (SELECT COUNT(*) FROM ${P}clients_relationships WHERE id_client_from = c.id OR id_client_to = c.id) AS relationships_count,
                (SELECT COUNT(*) FROM ${P}contact_center_contacts WHERE id_client = c.id) AS chats_count
           FROM ${P}clients c
           LEFT JOIN ${P}clients_stats st ON st.id_client = c.id
           LEFT JOIN ${P}users u ON u.id = c.id_manager
          WHERE c.id = ? LIMIT 1`,
		[id]
	);
	if (!c || c.deleted_at) return null;

	const [contacts] = await connection_pool.query(`SELECT id_contact_type, value_normalized, is_primary FROM ${P}clients_contact_points WHERE id_client = ? ORDER BY id_contact_type, is_primary DESC, id`, [id]);
	const [idents] = await connection_pool.query(`SELECT id_identifier_type, value FROM ${P}clients_identifiers WHERE id_client = ? ORDER BY id`, [id]);

	const L = async (k) => new Map((await dict.list(k, idLang, { activeOnly: false })).map((r) => [r.id, r]));
	const [dContact, dIdent, dStage, dLegal] = await Promise.all(["contact_types", "identifier_types", "lifecycle_stages", "legal_types"].map(L));

	return {
		id: c.id,
		kind: c.kind,
		merged_into: c.id_merged_into,
		display_name: c.display_name,
		status: c.status,
		legal: (dLegal.get(c.id_legal_type) || {}).name || null,
		lifecycle: dStage.get(c.id_lifecycle) ? pickDict(dStage.get(c.id_lifecycle)) : null,
		manager_name: c.manager_name,
		country: c.country,
		source: c.source,
		date_add: formatDate(c.date_add),
		date_last_activity: formatDate(c.date_last_activity),
		orders_valid_count: Number(c.orders_valid_count) || 0,
		orders_count: Number(c.orders_count) || 0,
		revenue_base: Number(c.revenue_base || 0).toFixed(2),
		leads_count: Number(c.leads_count) || 0,
		addresses_count: Number(c.addresses_count) || 0,
		relationships_count: Number(c.relationships_count) || 0,
		chats_count: Number(c.chats_count) || 0,
		contacts: contacts.map((x) => {
			const t = dContact.get(x.id_contact_type) || {};
			return { type: t.name || t.code, icon: t.icon, color: t.color_background, value: x.value_normalized, primary: !!x.is_primary };
		}),
		identifiers: idents.map((x) => ({ type: (dIdent.get(x.id_identifier_type) || {}).name || "", value: x.value })),
	};
}

router.get("/clients/merge/", authorizationControllers.isAuthenticated, async (req, res) => {
	const a = parseInt(req.query.a, 10);
	const b = parseInt(req.query.b, 10);
	if (!a || !b || a === b) return res.redirect("/clients/duplicates/");

	try {
		const [sa, sb] = await Promise.all([mergeSummary(a, req.user.id_lang), mergeSummary(b, req.user.id_lang)]);
		if (!sa || !sb) return res.status(404).send("Клієнта не знайдено.");
		if (sa.merged_into || sb.merged_into) return res.redirect(`/clients/${sa.merged_into || sb.merged_into}/`);

		// Кого залишити за замовчуванням: більше замовлень, за рівності — старший запис
		const winner = sa.orders_valid_count !== sb.orders_valid_count ? (sa.orders_valid_count > sb.orders_valid_count ? sa.id : sb.id) : Math.min(sa.id, sb.id);

		res.render("pages/clients/merge", {
			i18n: req,
			user: req.user,
			header: { navbar: "clients" },
			data: { a: sa, b: sb, winner, base_currency: BASE_CURRENCY },
		});
	} catch (e) {
		logging.error(e);
		res.status(500).send("Помилка сервера.");
	}
});

// ─────────────────────────────────────────────
// Довідники для фільтрів
// ─────────────────────────────────────────────
router.post("/api/clients/list-filters/", authorizationControllers.isAuthenticated, async (req, res) => {
	const idLang = req.user.id_lang;
	try {
		const [lifecycle, legal, tags] = await Promise.all([dict.list("lifecycle_stages", idLang), dict.list("legal_types", idLang), dict.list("tags", idLang)]);

		const [managers] = await connection_pool.query(
			`SELECT DISTINCT u.id, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS name
               FROM ${P}clients c
               INNER JOIN ${P}users u ON u.id = c.id_manager
              WHERE c.deleted_at IS NULL
              ORDER BY name`
		);
		const [countries] = await connection_pool.query(`SELECT DISTINCT country FROM ${P}clients WHERE country IS NOT NULL AND deleted_at IS NULL ORDER BY country`);
		const [[dupCnt]] = await connection_pool.query(
			`SELECT COUNT(*) AS n
               FROM ${P}clients_duplicate_candidates d
               INNER JOIN ${P}clients a ON a.id = d.id_client_a AND a.deleted_at IS NULL AND a.id_merged_into IS NULL
               INNER JOIN ${P}clients b ON b.id = d.id_client_b AND b.deleted_at IS NULL AND b.id_merged_into IS NULL
              WHERE d.status = 'pending'`
		);

		let baseCurrency = BASE_CURRENCY;
		try {
			baseCurrency = require("../../controllers/orders/currency").BASE_CURRENCY || baseCurrency;
		} catch (e) {}

		res.json({
			lifecycle: lifecycle.map(pickDict),
			legal_types: legal.map(pickDict),
			tags: tags.map(pickDict),
			managers,
			countries: countries.map((r) => r.country),
			base_currency: baseCurrency,
			duplicates: Number(dupCnt.n) || 0,
		});
	} catch (e) {
		logging.error(e);
		res.status(500).json({ message: "Помилка сервера." });
	}
});

// ─────────────────────────────────────────────
// Список (серверна пагінація, сортування, фільтри)
// ─────────────────────────────────────────────
const SORTS = {
	id: "c.id",
	display_name: "c.display_name",
	orders_valid_count: "st.orders_valid_count",
	revenue_base: "st.revenue_base",
	last_order_at: "st.last_order_at",
	date_last_activity: "c.date_last_activity",
	date_add: "c.date_add",
	next_event_at: "next_event_at IS NULL, next_event_at",
};

// Найближча незавершена подія клієнта (прострочені теж — вони найраніші)
const NEXT_EVENT_SQL = `(SELECT MIN(e.date_start) FROM ${P}calendar_event_links l
    INNER JOIN ${P}calendar_events e ON e.id = l.id_event AND e.active = 1 AND e.status = 1
    WHERE l.ref_type = 'client' AND l.id_ref = c.id)`;

// Умови фільтра списку — спільні для списку, масових дій і експорту
function buildClientWhere(b, req) {
	const where = ["c.deleted_at IS NULL", "c.id_merged_into IS NULL"];
	const params = [];

	// Без права «усі клієнти» — лише свої і без менеджера
	const sc = req ? require("../../controllers/clients/access").scope(req) : null;
	if (sc) {
		where.push(sc.sql);
		params.push(...sc.params);
	}

	if (["person", "organization", "group"].includes(b.kind)) {
		where.push("c.kind = ?");
		params.push(b.kind);
	}
	if (b.id_lifecycle) {
		where.push("c.id_lifecycle = ?");
		params.push(parseInt(b.id_lifecycle, 10));
	}
	if (b.id_legal_type) {
		where.push("c.id_legal_type = ?");
		params.push(parseInt(b.id_legal_type, 10));
	}
	if (b.id_manager === "none") {
		where.push("c.id_manager IS NULL");
	} else if (b.id_manager) {
		where.push("c.id_manager = ?");
		params.push(parseInt(b.id_manager, 10));
	}
	if (b.country) {
		where.push("c.country = ?");
		params.push(String(b.country).slice(0, 2));
	}
	if (b.id_tag) {
		where.push(`EXISTS (SELECT 1 FROM ${P}clients_tag_links tl WHERE tl.id_client = c.id AND tl.id_tag = ?)`);
		params.push(parseInt(b.id_tag, 10));
	}
	if (b.has_orders === "1") where.push("COALESCE(st.orders_valid_count, 0) > 0");
	if (b.has_orders === "0") where.push("COALESCE(st.orders_valid_count, 0) = 0");
	if (b.rfm_segment && rfm.SEG_BY_CODE[b.rfm_segment]) {
		where.push("st.rfm_segment = ?");
		params.push(b.rfm_segment);
	}
	if (b.next_event === "none") where.push(`${NEXT_EVENT_SQL} IS NULL`);
	if (b.next_event === "planned") where.push(`${NEXT_EVENT_SQL} >= NOW()`);
	if (b.next_event === "overdue") where.push(`${NEXT_EVENT_SQL} < NOW()`);

	const s = normalize.cleanText(b.search || "", 100);
	if (s.length >= 2) {
		const like = `%${s}%`;
		const ph = normalize.phone(s);
		const exact = ph && ph.valid ? ph.normalized : "";
		const conds = ["c.display_name LIKE ?", `EXISTS (SELECT 1 FROM ${P}clients_contact_points cp WHERE cp.id_client = c.id AND (cp.value LIKE ? OR cp.value_normalized LIKE ? OR cp.value_normalized = ?))`, `EXISTS (SELECT 1 FROM ${P}clients_identifiers ci WHERE ci.id_client = c.id AND ci.value_normalized LIKE ?)`];
		params.push(like, like, like, exact, like);
		if (/^\d+$/.test(s)) {
			conds.push("c.id = ?");
			params.push(parseInt(s, 10));
		}
		where.push("(" + conds.join(" OR ") + ")");
	}
	return { where, params };
}

router.post("/api/clients/list/", authorizationControllers.isAuthenticated, async (req, res) => {
	const b = req.body || {};
	const idLang = req.user.id_lang;
	const page = Math.max(1, parseInt(b.page, 10) || 1);
	const size = Math.min(100, Math.max(1, parseInt(b.size, 10) || 20));
	const { where, params } = buildClientWhere(b, req);

	const sort0 = Array.isArray(b.sort) && b.sort[0] ? b.sort[0] : null;
	const orderBy = sort0 && SORTS[sort0.field] ? `${SORTS[sort0.field]} ${sort0.dir === "asc" ? "ASC" : "DESC"}, c.id DESC` : "c.date_last_activity DESC, c.id DESC";

	try {
		const [[cnt]] = await connection_pool.query(
			`SELECT COUNT(*) AS n
               FROM ${P}clients c
               LEFT JOIN ${P}clients_stats st ON st.id_client = c.id
              WHERE ${where.join(" AND ")}`,
			params
		);
		const total = Number(cnt.n) || 0;

		const phoneType = await dict.idOf("contact_types", "phone");
		const emailType = await dict.idOf("contact_types", "email");

		const [rows] = await connection_pool.query(
			`SELECT c.id, c.kind, c.display_name, c.status, c.id_legal_type, c.id_lifecycle, c.country, c.source,
                    c.date_add, c.date_last_activity,
                    st.orders_count, st.orders_valid_count, st.revenue_base, st.last_order_at, st.leads_count, st.rfm_segment,
                    st.rfm_r, st.rfm_f, st.rfm_m,
                    NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS manager_name,
                    (SELECT cp.value_normalized FROM ${P}clients_contact_points cp
                      WHERE cp.id_client = c.id AND cp.id_contact_type = ? ORDER BY cp.is_primary DESC, cp.id ASC LIMIT 1) AS phone,
                    (SELECT cp.value_normalized FROM ${P}clients_contact_points cp
                      WHERE cp.id_client = c.id AND cp.id_contact_type = ? ORDER BY cp.is_primary DESC, cp.id ASC LIMIT 1) AS email,
                                        (SELECT GROUP_CONCAT(tl.id_tag) FROM ${P}clients_tag_links tl WHERE tl.id_client = c.id) AS tag_ids,
                    ${NEXT_EVENT_SQL} AS next_event_at
               FROM ${P}clients c
               LEFT JOIN ${P}clients_stats st ON st.id_client = c.id
               LEFT JOIN ${P}users u ON u.id = c.id_manager
              WHERE ${where.join(" AND ")}
              ORDER BY ${orderBy}
              LIMIT ? OFFSET ?`,
			[phoneType, emailType, ...params, size, (page - 1) * size]
		);

		// Переклади довідників мовою менеджера
		const [lifecycle, legal, tags] = await Promise.all([dict.list("lifecycle_stages", idLang, { activeOnly: false }), dict.list("legal_types", idLang, { activeOnly: false }), dict.list("tags", idLang, { activeOnly: false })]);
		const lcMap = new Map(lifecycle.map((r) => [r.id, pickDict(r)]));
		const lgMap = new Map(legal.map((r) => [r.id, pickDict(r)]));
		const tgMap = new Map(tags.map((r) => [r.id, pickDict(r)]));

		const data = rows.map((r) => ({
			id: r.id,
			kind: r.kind,
			display_name: r.display_name,
			status: r.status,
			country: r.country,
			source: r.source,
			legal_type: lgMap.get(r.id_legal_type) || null,
			lifecycle: lcMap.get(r.id_lifecycle) || null,
			tags: String(r.tag_ids || "")
				.split(",")
				.filter(Boolean)
				.map((id) => tgMap.get(Number(id)))
				.filter(Boolean),
			phone: r.phone,
			email: r.email,
			manager_name: r.manager_name,
			orders_count: Number(r.orders_count) || 0,
			orders_valid_count: Number(r.orders_valid_count) || 0,
			revenue_base: Number(r.revenue_base || 0).toFixed(2),
			leads_count: Number(r.leads_count) || 0,
			last_order_at: formatDate(r.last_order_at),
			date_last_activity: formatDate(r.date_last_activity),
			date_add: formatDate(r.date_add),
			next_event_at: formatDate(r.next_event_at),
			rfm: rfmOf(r.rfm_segment),
			rfm_score: r.rfm_r ? `${r.rfm_r}${r.rfm_f}${r.rfm_m}` : null,
			next_event_overdue: !!(r.next_event_at && new Date(r.next_event_at) < new Date()),
		}));

		res.json({ last_page: Math.max(1, Math.ceil(total / size)), last_row: total, data });
	} catch (e) {
		logging.error(e);
		res.status(500).json({ message: "Помилка сервера." });
	}
});

// ─────────────────────────────────────────────
// Картка клієнта
// ─────────────────────────────────────────────
function contactUrl(t, v) {
	if (!t || !t.url_template || !v) return null;
	if (t.code === "website") return /^https?:\/\//i.test(v) ? v : "https://" + v;
	let val = v;
	if (t.code === "whatsapp") val = v.replace(/^\+/, "");
	else if (t.code !== "phone" && t.code !== "email") val = encodeURIComponent(v);
	return t.url_template.replace("{value}", val);
}

router.get("/clients/:id/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).send("Невірний ID клієнта.");
	const idLang = req.user.id_lang;

	try {
		const [[c]] = await connection_pool.query(
			`SELECT c.*,
                    NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS manager_name,
                    lg.name AS lang_name
               FROM ${P}clients c
               LEFT JOIN ${P}users u ON u.id = c.id_manager
               LEFT JOIN ${P}languages lg ON lg.id = c.id_lang
              WHERE c.id = ? LIMIT 1`,
			[id]
		);
		if (!c || c.deleted_at) return res.status(404).send("Клієнта не знайдено.");

		// Злитий запис → на актуального клієнта
		if (c.id_merged_into) return res.redirect(`/clients/${c.id_merged_into}/?merged_from=${c.id}`);

		const q = (sql, p) => connection_pool.query(sql, p).then(([r]) => r);
		const [persons, orgs, contacts, identifiers, addresses, rels, roles, tagLinks, statsRows, commercial, externals, dups] = await Promise.all([
			q(`SELECT * FROM ${P}clients_persons WHERE id_client = ?`, [id]),
			q(`SELECT * FROM ${P}clients_organizations WHERE id_client = ?`, [id]),
			q(`SELECT * FROM ${P}clients_contact_points WHERE id_client = ? ORDER BY id_contact_type, is_primary DESC, id`, [id]),
			q(`SELECT * FROM ${P}clients_identifiers WHERE id_client = ? ORDER BY id`, [id]),
			q(`SELECT * FROM ${P}clients_addresses WHERE id_client = ? ORDER BY is_default DESC, id DESC`, [id]),
			q(
				`SELECT r.*, cf.display_name AS from_name, cf.kind AS from_kind, ct.display_name AS to_name, ct.kind AS to_kind
                   FROM ${P}clients_relationships r
                   INNER JOIN ${P}clients cf ON cf.id = r.id_client_from
                   INNER JOIN ${P}clients ct ON ct.id = r.id_client_to
                  WHERE r.id_client_from = ? OR r.id_client_to = ?
                  ORDER BY (r.valid_to IS NULL) DESC, r.is_primary DESC, r.id`,
				[id, id]
			),
			q(`SELECT * FROM ${P}clients_roles WHERE id_client = ? AND status = 'active'`, [id]),
			q(`SELECT id_tag FROM ${P}clients_tag_links WHERE id_client = ?`, [id]),
			q(`SELECT * FROM ${P}clients_stats WHERE id_client = ?`, [id]),
			q(`SELECT * FROM ${P}clients_commercial WHERE id_client = ?`, [id]),
			q(
				`SELECT e.*, i.name AS integration_name
                   FROM ${P}clients_external_ids e
                   LEFT JOIN ${P}settings_integrations i ON i.id = e.id_integration
                  WHERE e.id_client = ? ORDER BY e.id`,
				[id]
			),
			q(
				`SELECT d.id, d.score, d.reasons,
                        IF(d.id_client_a = ?, d.id_client_b, d.id_client_a) AS other_id, o.display_name AS other_name
                   FROM ${P}clients_duplicate_candidates d
                   INNER JOIN ${P}clients o ON o.id = IF(d.id_client_a = ?, d.id_client_b, d.id_client_a)
                  WHERE d.status = 'pending' AND (d.id_client_a = ? OR d.id_client_b = ?)
                  ORDER BY d.score DESC`,
				[id, id, id, id]
			),
		]);

		// Довідники мовою менеджера
		const keys = ["contact_types", "identifier_types", "address_types", "relationship_types", "role_types", "lifecycle_stages", "legal_types", "tags"];
		const maps = await Promise.all(keys.map(async (k) => new Map((await dict.list(k, idLang, { activeOnly: false })).map((r) => [r.id, r]))));
		const [dContact, dIdent, dAddr, dRel, dRole, dStage, dLegal, dTag] = maps;

		// Дані для форм редагування
		const pad2 = (n) => String(n).padStart(2, "0");
		const ymd = (v) => (!v ? "" : v instanceof Date ? `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}` : String(v).slice(0, 10));
		const [users] = await connection_pool.query(`SELECT id, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM ${P}users WHERE active = 1 ORDER BY name`);
		const langs = await dict.languages();

		const [merges] = await connection_pool.query(
			`SELECT m.id, m.id_client_loser, m.date_add, m.reverted_at,
                    JSON_UNQUOTE(JSON_EXTRACT(m.snapshot, '$.loser.client.display_name')) AS loser_name,
                    NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS user_name
               FROM ${P}clients_merges m
               LEFT JOIN ${P}users u ON u.id = m.id_user
              WHERE m.id_client_winner = ?
              ORDER BY m.id DESC LIMIT 20`,
			[id]
		);

		const form = {
			kind: c.kind,
			id_legal_type: c.id_legal_type,
			id_lifecycle: c.id_lifecycle,
			status: c.status,
			country: c.country || "",
			timezone: c.timezone || "",
			id_lang: c.id_lang,
			id_manager: c.id_manager,
			note: c.note || "",
			tags: tagLinks.map((r) => r.id_tag),
			person: persons[0] ? { ...persons[0], birth_date: ymd(persons[0].birth_date) } : {},
			organization: orgs[0] ? { ...orgs[0], registration_date: ymd(orgs[0].registration_date) } : {},
		};
		const options = {
			legal_types: [...dLegal.values()].filter((x) => x.kind === c.kind && Number(x.active) === 1).map(pickDict),
			lifecycle: [...dStage.values()].filter((x) => Number(x.active) === 1).map(pickDict),
			tags: [...dTag.values()].filter((x) => Number(x.active) === 1).map(pickDict),
			contact_types: [...dContact.values()].filter((x) => Number(x.active) === 1).map(pickDict),
			address_types: [...dAddr.values()].filter((x) => Number(x.active) === 1).map(pickDict),
			identifier_types: [...dIdent.values()].filter((x) => Number(x.active) === 1 && (x.applies_kind === "all" || x.applies_kind === c.kind)).map((x) => ({ ...pickDict(x), country: x.country || null })),
			// Тип зв'язку з боку цього клієнта: "out" — клієнт є from, "in" — клієнт є to
			relationships: [...dRel.values()]
				.filter((x) => Number(x.active) === 1)
				.flatMap((x) => {
					const out = [];
					if (x.from_kind === "all" || x.from_kind === c.kind) out.push({ value: x.id + ":out", name: x.name, target_kind: x.to_kind });
					if (!Number(x.is_symmetric) && (x.to_kind === "all" || x.to_kind === c.kind)) out.push({ value: x.id + ":in", name: x.reverse_name || x.name, target_kind: x.from_kind });
					return out;
				}),
			languages: langs.list,
			managers: users,
		};

		res.render("pages/clients/page", {
			i18n: req,
			user: req.user,
			header: { navbar: "clients" },
			data: {
				client: {
					...c,
					date_add_text: formatDate(c.date_add),
					date_first_contact_text: formatDate(c.date_first_contact),
					date_last_activity_text: formatDate(c.date_last_activity),
				},
				person: persons[0] || null,
				organization: orgs[0] || null,
				legal_type: dLegal.get(c.id_legal_type) || null,
				lifecycle: dStage.get(c.id_lifecycle) || null,
				contacts: contacts.map((r) => {
					const t = dContact.get(r.id_contact_type) || {};
					return { ...r, type: t, url: contactUrl(t, r.value_normalized) };
				}),
				identifiers: identifiers.map((r) => ({ ...r, type: dIdent.get(r.id_identifier_type) || {} })),
				addresses: addresses.map((r) => ({ ...r, type: dAddr.get(r.id_address_type) || {} })),
				relationships: rels.map((r) => {
					const t = dRel.get(r.id_relationship_type) || {};
					const out = r.id_client_from === id;
					return {
						id: r.id,
						label: out ? t.name : t.reverse_name || t.name,
						other_id: out ? r.id_client_to : r.id_client_from,
						other_name: out ? r.to_name : r.from_name,
						other_kind: out ? r.to_kind : r.from_kind,
						title: r.title,
						is_primary: r.is_primary,
						active: !r.valid_to,
						valid_from: ymd(r.valid_from),
						valid_to: ymd(r.valid_to),
						note: r.note,
						type: t,
					};
				}),
				roles: roles.map((r) => dRole.get(r.id_role_type)).filter(Boolean),
				tags: tagLinks.map((r) => dTag.get(r.id_tag)).filter(Boolean),
				stats: statsRows[0] || null,
				rfm: rfmOf(statsRows[0] && statsRows[0].rfm_segment),
				commercial: commercial[0] || null,
				externals,
				duplicates: dups,
				base_currency: BASE_CURRENCY,
				merged_from: parseInt(req.query.merged_from, 10) || null,
				form,
				options,
				merges: merges.map((m) => ({ ...m, date_add: formatDate(m.date_add), reverted_at: formatDate(m.reverted_at) })),
				just_merged: parseInt(req.query.merged, 10) || null,
			},
		});
	} catch (e) {
		logging.error(e);
		res.status(500).send("Помилка сервера.");
	}
});

// Єдина стрічка історії: замовлення, ліди, діалоги
router.post("/api/clients/:id/timeline/", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = parseInt(req.params.id, 10);
	if (!id) return res.status(400).json({ message: "Невірний ID." });
	const idLang = req.user.id_lang;

	try {
		const [orders] = await connection_pool.query(
			`SELECT o.id, o.reference, o.external_number, o.total, o.currency_iso, o.source_channel,
                    COALESCE(o.date_order, o.date_add) AS dt,
                    o.id_client, o.id_client_recipient, o.id_client_org,
                    osl.text AS status_name, os.color_text, os.color_background, os.icon,
                    i.name AS integration_name
               FROM ${P}orders o
               LEFT JOIN ${P}orders_status os ON os.id = o.status
               LEFT JOIN ${P}orders_status_lang osl ON osl.id_status = os.id AND osl.id_lang = ?
               LEFT JOIN ${P}settings_integrations i ON i.id = o.id_integration
              WHERE (o.id_client = ? OR o.id_client_recipient = ? OR o.id_client_org = ?) AND o.deleted_at IS NULL
              ORDER BY dt DESC LIMIT 200`,
			[idLang, id, id, id]
		);

		const [leads] = await connection_pool.query(
			`SELECT l.id, l.title, l.value, l.is_converted, l.date_add AS dt,
                    sl.name AS status_name, s.color_text, s.color_background,
                    psl.name AS stage_name, ps.color AS stage_color
               FROM ${P}leads l
               LEFT JOIN ${P}leads_settings_status s ON s.id = l.id_status
               LEFT JOIN ${P}leads_settings_status_lang sl ON sl.id_status = s.id AND sl.id_lang = ?
               LEFT JOIN ${P}leads_pipeline_stages ps ON ps.id = l.id_stage
               LEFT JOIN ${P}leads_pipeline_stages_lang psl ON psl.id_stage = ps.id AND psl.id_lang = ?
              WHERE (l.id_client = ? OR l.id_client_org = ?) AND l.deleted_at IS NULL
              ORDER BY l.date_add DESC LIMIT 200`,
			[idLang, idLang, id, id]
		);

		const [chats] = await connection_pool.query(
			`SELECT cv.id, cv.url_token, cv.status, cv.last_message_text, cv.last_message_dir, cv.messages_count,
                    COALESCE(cv.date_last_message, cv.date_add) AS dt,
                    ch.type AS channel_type, ch.name AS channel_name
               FROM ${P}contact_center_contacts ct
               INNER JOIN ${P}contact_center_conversations cv ON cv.id_contact = ct.id
               INNER JOIN ${P}contact_center_channels ch ON ch.id = cv.id_channel
              WHERE ct.id_client = ?
              ORDER BY dt DESC LIMIT 200`,
			[id]
		);

		const items = [
			...orders.map((o) => ({
				type: "order",
				id: o.id,
				dt: o.dt,
				title: o.reference + (o.external_number ? " · " + o.external_number : ""),
				role: o.id_client === id ? "buyer" : o.id_client_recipient === id ? "recipient" : "company",
				amount: Number(o.total || 0).toFixed(2),
				currency: o.currency_iso,
				status: { name: o.status_name, color_text: o.color_text, color_background: o.color_background, icon: o.icon },
				source: o.integration_name || (o.source_channel === "contact-center" ? "Контакт-центр" : o.source_channel),
			})),
			...leads.map((l) => ({
				type: "lead",
				id: l.id,
				dt: l.dt,
				title: l.title,
				amount: Number(l.value || 0) ? Number(l.value).toFixed(2) : null,
				converted: !!l.is_converted,
				status: { name: l.status_name, color_text: l.color_text, color_background: l.color_background },
				stage: l.stage_name ? { name: l.stage_name, color: l.stage_color } : null,
			})),
			...chats.map((cv) => ({
				type: "chat",
				id: cv.id,
				dt: cv.dt,
				url_token: cv.url_token,
				title: cv.channel_name,
				channel_type: cv.channel_type,
				last_text: cv.last_message_text,
				last_dir: cv.last_message_dir,
				messages_count: cv.messages_count,
				conv_status: cv.status,
			})),
		]
			.sort((a, b) => new Date(b.dt) - new Date(a.dt))
			.map((x) => ({ ...x, dt_text: formatDate(x.dt) }));

		res.json({ items, counts: { order: orders.length, lead: leads.length, chat: chats.length } });
	} catch (e) {
		logging.error(e);
		res.status(500).json({ message: "Помилка сервера." });
	}
});

// ─────────────────────────────────────────────
// Редагування картки
// ─────────────────────────────────────────────
const editor = require("../../controllers/clients/editor");

// Спільна обгортка: помилки з кодом (400/404/409) віддаємо як є, решту — 500
const handle = (fn) => async (req, res) => {
	try {
		res.json(await fn(req));
	} catch (e) {
		if (!e.status) logging.error(e);
		res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Помилка сервера.", ...(e.payload || {}) });
	}
};
const idOf = (req) => parseInt(req.params.id, 10);
const cpOf = (req) => parseInt(req.params.cp, 10);
const userOf = (req) => req.user.userId || req.user.id;
const clientsHistory = require("../../controllers/clients/history");
// Хто / звідки / IP для історії змін
const ctxOf = (req) => clientsHistory.ctxFromReq(req, "manual");

// Людські назви для вкладки «Зміни»
const HIST_FIELD = {
	display_name: "Назва",
	id_lifecycle: "Стадія",
	id_legal_type: "Правова форма",
	id_manager: "Менеджер",
	id_lang: "Мова",
	country: "Країна",
	timezone: "Часовий пояс",
	currency: "Валюта",
	status: "Статус",
	note: "Нотатка",
	kind: "Тип",
	last_name: "Прізвище",
	first_name: "Імʼя",
	middle_name: "По батькові",
	gender: "Стать",
	birth_date: "Дата народження",
	job_title: "Посада",
	trade_name: "Торгова назва",
	legal_name: "Юридична назва",
	short_name: "Коротка назва",
	industry: "Галузь",
	website: "Сайт",
	employees_count: "Працівників",
	registration_date: "Дата реєстрації",
	value: "Значення",
	is_valid: "Валідний",
	label: "Мітка",
	is_primary: "Основний",
	marketing_consent: "Згода на розсилки",
	recipient_name: "Отримувач",
	recipient_phone: "Телефон отримувача",
	region: "Регіон",
	city: "Місто",
	street: "Вулиця",
	building: "Будинок",
	apartment: "Квартира",
	address_line: "Адреса",
	postcode: "Індекс",
	carrier_code: "Перевізник",
	carrier_point_name: "Відділення",
	comment: "Коментар",
	is_default: "Основна",
	id_address_type: "Тип адреси",
	is_verified: "Перевірено",
	title: "Посада / роль",
	valid_from: "Діє з",
	valid_to: "Діє до",
	price_group: "Цінова група",
	discount_percent: "Знижка, %",
	credit_limit: "Кредитний ліміт",
	payment_terms_days: "Відстрочка, днів",
	default_payment_method: "Спосіб оплати",
	vat_payer: "Платник ПДВ",
	event_status: "Статус події",
	is_pinned: "Закріплено",
	buyer: "Покупець",
	recipient: "Отримувач",
	org: "Компанія",
	merged_from: "Злито з",
	merged_into: "Злито в",
	refs: "Перенесено звʼязки",
};
const HIST_DICT_FIELD = { id_lifecycle: "lifecycle_stages", id_legal_type: "legal_types", id_manager: "users", id_lang: "languages", id_address_type: "address_types" };
const HIST_DICT_ENTITY = { tag: "tags", role: "role_types", contact: "contact_types", identifier: "identifier_types", address: "address_types", relationship: "relationship_types" };
const HIST_BOOL = ["is_pinned", "is_valid", "is_primary", "marketing_consent", "is_default", "is_verified", "vat_payer"];
const HIST_VALUE = {
	"gender:male": "чоловіча",
	"gender:female": "жіноча",
	"gender:other": "інша",
	"gender:unknown": "не вказано",
	"status:active": "активний",
	"status:blocked": "заблокований",
	"status:archived": "архів",
	"kind:person": "фізособа",
	"kind:organization": "організація",
	"kind:group": "група",
	"event_status:1": "заплановано",
	"event_status:2": "виконано",
	"event_status:3": "скасовано",
	"label:personal": "особистий",
	"label:work": "робочий",
	"label:other": "інший",
};

router.post(
	"/api/clients/:id/profile/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.updateProfile(idOf(req), req.body || {}, ctxOf(req)))
);
router.post(
	"/api/clients/:id/tags/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.setTags(idOf(req), (req.body || {}).tags, ctxOf(req)))
);
router.post(
	"/api/clients/:id/contacts/add/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.addContact(idOf(req), req.body || {}, ctxOf(req)))
);
router.post(
	"/api/clients/:id/contacts/:cp/update/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.updateContact(idOf(req), cpOf(req), req.body || {}, ctxOf(req)))
);
router.post(
	"/api/clients/:id/contacts/:cp/delete/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.deleteContact(idOf(req), cpOf(req), ctxOf(req)))
);
router.post(
	"/api/clients/:id/contacts/:cp/primary/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.setPrimaryContact(idOf(req), cpOf(req), ctxOf(req)))
);

const subOf = (req) => parseInt(req.params.sub, 10);

router.post(
	"/api/clients/:id/addresses/add/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.saveAddress(idOf(req), null, req.body || {}, ctxOf(req)))
);
router.post(
	"/api/clients/:id/addresses/:sub/update/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.saveAddress(idOf(req), subOf(req), req.body || {}, ctxOf(req)))
);
router.post(
	"/api/clients/:id/addresses/:sub/delete/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.deleteAddress(idOf(req), subOf(req), ctxOf(req)))
);
router.post(
	"/api/clients/:id/addresses/:sub/default/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.setDefaultAddress(idOf(req), subOf(req), ctxOf(req)))
);

router.post(
	"/api/clients/:id/identifiers/add/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.saveIdentifier(idOf(req), null, req.body || {}, ctxOf(req)))
);
router.post(
	"/api/clients/:id/identifiers/:sub/update/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.saveIdentifier(idOf(req), subOf(req), req.body || {}, ctxOf(req)))
);
router.post(
	"/api/clients/:id/identifiers/:sub/delete/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.deleteIdentifier(idOf(req), subOf(req), ctxOf(req)))
);

router.post(
	"/api/clients/:id/relationships/add/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.addRelationship(idOf(req), req.body || {}, ctxOf(req)))
);
router.post(
	"/api/clients/:id/relationships/:sub/update/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.updateRelationship(idOf(req), subOf(req), req.body || {}, ctxOf(req)))
);
router.post(
	"/api/clients/:id/relationships/:sub/end/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.endRelationship(idOf(req), subOf(req), ctxOf(req)))
);
router.post(
	"/api/clients/:id/relationships/:sub/delete/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.deleteRelationship(idOf(req), subOf(req), ctxOf(req)))
);

router.post(
	"/api/clients/:id/commercial/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.saveCommercial(idOf(req), req.body || {}, ctxOf(req)))
);

// Пошук клієнтів (для вибору в зв'язках)
router.post(
	"/api/clients/search/",
	authorizationControllers.isAuthenticated,
	handle((req) => require("../../controllers/clients/queries").search((req.body || {}).q || ""))
);

// Створення вручну
router.post(
	"/api/clients/create/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.createClient(req.body || {}, ctxOf(req), !!(req.body || {}).force))
);

// Дублі
router.post(
	"/api/clients/duplicates/list/",
	authorizationControllers.isAuthenticated,
	handle(async () => {
		const [rows] = await connection_pool.query(
			`SELECT d.id, d.id_client_a, d.id_client_b, d.score, d.reasons, d.date_add
               FROM ${P}clients_duplicate_candidates d
               INNER JOIN ${P}clients a ON a.id = d.id_client_a AND a.deleted_at IS NULL AND a.id_merged_into IS NULL
               INNER JOIN ${P}clients b ON b.id = d.id_client_b AND b.deleted_at IS NULL AND b.id_merged_into IS NULL
              WHERE d.status = 'pending'
              ORDER BY d.score DESC, d.id DESC
              LIMIT 500`
		);
		const briefs = await require("../../controllers/clients/queries").briefMany(rows.flatMap((r) => [r.id_client_a, r.id_client_b]));
		const map = new Map(briefs.map((x) => [x.id, x]));
		return rows.map((r) => ({
			id: r.id,
			score: r.score,
			reasons: typeof r.reasons === "string" ? JSON.parse(r.reasons) : r.reasons || [],
			date_add: formatDate(r.date_add),
			a: map.get(r.id_client_a),
			b: map.get(r.id_client_b),
		}));
	})
);
router.post(
	"/api/clients/duplicates/:id/dismiss/",
	authorizationControllers.isAuthenticated,
	handle((req) => editor.dismissDuplicate(idOf(req), ctxOf(req)))
);

// Злиття і відкат
const mergeErr = (e) => {
	if (/^clients\.(merge|revert)/.test(e.message)) {
		const x = new Error(e.message.replace(/^clients\.\w+:\s*/, ""));
		x.status = 400;
		return x;
	}
	return e;
};
router.post(
	"/api/clients/merge/",
	authorizationControllers.isAuthenticated,
	handle(async (req) => {
		const b = req.body || {};
		try {
			const r = await require("../../controllers/clients/merge").mergeClients(parseInt(b.winner, 10), parseInt(b.loser, 10), { history: ctxOf(req) });
			audit.log(req, { action: "merge", module: "clients", entity: "client", id_entity: parseInt(b.winner, 10), count: 1, details: { winner: b.winner, loser: b.loser, id_merge: r.id_merge } });
			return { ok: true, id_merge: r.id_merge };
		} catch (e) {
			throw mergeErr(e);
		}
	})
);
router.post(
	"/api/clients/merges/:id/revert/",
	authorizationControllers.isAuthenticated,
	handle(async (req) => {
		try {
			const r = await require("../../controllers/clients/merge").revertMerge(idOf(req), { history: ctxOf(req) });
			audit.log(req, { action: "merge_revert", module: "clients", entity: "merge", id_entity: idOf(req), count: 1 });
			return r;
		} catch (e) {
			throw mergeErr(e);
		}
	})
);

// Власні поля картки
const clientFields = require("../../controllers/clients/fields");
router.post(
	"/api/clients/:id/fields/",
	authorizationControllers.isAuthenticated,
	handle((req) => clientFields.forClient(idOf(req), req.user.id_lang))
);
router.post(
	"/api/clients/:id/fields/save/",
	authorizationControllers.isAuthenticated,
	handle((req) => clientFields.saveForClient(idOf(req), req.body || {}, ctxOf(req), req.user.id_lang))
);

// Стрічка нотаток
const clientNotes = require("../../controllers/clients/notes");
const noteOf = (req) => parseInt(req.params.note, 10);
const isAdminReq = (req) => authorizationControllers.hasPermission(req, "clients.list", "delete");
router.post(
	"/api/clients/:id/notes/",
	authorizationControllers.isAuthenticated,
	handle((req) => clientNotes.list(idOf(req), userOf(req), req.body || {}))
);
router.post(
	"/api/clients/:id/notes/add/",
	authorizationControllers.isAuthenticated,
	handle((req) => clientNotes.add(idOf(req), req.body || {}, ctxOf(req)))
);
router.post(
	"/api/clients/:id/notes/:note/edit/",
	authorizationControllers.isAuthenticated,
	handle((req) => clientNotes.update(idOf(req), noteOf(req), req.body || {}, ctxOf(req)))
);
router.post(
	"/api/clients/:id/notes/:note/delete/",
	authorizationControllers.isAuthenticated,
	handle((req) => clientNotes.remove(idOf(req), noteOf(req), ctxOf(req), isAdminReq(req)))
);
router.post(
	"/api/clients/:id/notes/:note/pin/",
	authorizationControllers.isAuthenticated,
	handle((req) => clientNotes.pin(idOf(req), noteOf(req), !!(req.body || {}).pinned, ctxOf(req)))
);

// Масові дії та експорт: { ids: [..] } або { all: true, filters: {...} }
const clientsBulk = require("../../controllers/clients/bulk");
// І «усі за фільтром», і виділені — завжди в межах того, що користувач бачить
const bulkTargets = (b, req) => {
	const f = buildClientWhere(b.all ? b.filters || {} : {}, req);
	if (!b.all) {
		const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => parseInt(x, 10)).filter(Boolean);
		if (!ids.length) throw Object.assign(new Error("Не обрано жодного клієнта."), { status: 400 });
		f.where.push("c.id IN (?)");
		f.params.push(ids);
	}
	return clientsBulk.resolveTargets(null, f);
};

router.post(
	"/api/clients/bulk/",
	authorizationControllers.isAuthenticated,
	handle(async (req) => {
		const b = req.body || {};
		const ids = await bulkTargets(b, req);
		const r = await clientsBulk.apply(String(b.action || ""), ids, b.value, clientsHistory.ctxFromReq(req, "manual"));
		audit.log(req, { action: "bulk", module: "clients", count: r.changed, details: { op: b.action, value: b.value, selected: ids.length, mode: b.all ? "filter" : "selected" } });
		return r;
	})
);

router.post("/api/clients/export/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const b = req.body || {};
		const ids = await bulkTargets(b, req);
		audit.log(req, { action: "export", module: "clients", count: ids.length, details: { mode: b.all ? "filter" : "selected", filters: b.all ? b.filters : undefined } });
		await clientsBulk.exportCsv(ids, req.user.id_lang, res);
	} catch (e) {
		if (!e.status) logging.error(e);
		if (!res.headersSent) res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Помилка сервера." });
		else res.end();
	}
});

// Видалення клієнта — у кошик (30 днів на відновлення)
router.post(
	"/api/clients/:id/delete/",
	authorizationControllers.isAuthenticated,
	handle(async (req) => {
		const id = idOf(req);
		const r = await require("../../controllers/common/trash").softDelete("clients", id, userOf(req));
		await clientsHistory.write(null, ctxOf(req), [{ id_client: id, action: "removed", entity: "client", id_entity: id }]);
		audit.log(req, { action: "delete", module: "clients", entity: "client", id_entity: id, count: 1 });
		return r;
	})
);

// Історія змін картки: фільтри + курсор (before_id)
router.post(
	"/api/clients/:id/history/",
	authorizationControllers.isAuthenticated,
	handle(async (req) => {
		const r = await clientsHistory.list(idOf(req), req.body || {});
		const idLang = req.user.id_lang;

		// id → назва: довідники, менеджери, мови
		const need = (k) => r.rows.some((x) => HIST_DICT_FIELD[x.field] === k || HIST_DICT_ENTITY[x.entity] === k);
		const maps = {};
		for (const k of ["lifecycle_stages", "legal_types", "tags", "role_types", "contact_types", "identifier_types", "address_types", "relationship_types"]) {
			if (!need(k)) continue;
			const rows = await dict.list(k, idLang, { activeOnly: false });
			maps[k] = new Map();
			for (const d of rows) {
				maps[k].set(String(d.id), d.name);
				if (d.code) maps[k].set(String(d.code), d.name);
			}
		}
		if (r.rows.some((x) => x.field === "id_manager")) {
			const [u] = await connection_pool.query(`SELECT id, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM ${P}users`);
			maps.users = new Map(u.map((x) => [String(x.id), x.name || "#" + x.id]));
		}
		if (r.rows.some((x) => x.field === "id_lang")) {
			const [l] = await connection_pool.query(`SELECT id, name FROM ${P}languages`);
			maps.languages = new Map(l.map((x) => [String(x.id), x.name]));
		}

		const text = (x, v) => {
			if (v === null || v === undefined) return null;
			const k = HIST_DICT_FIELD[x.field] || (["tag", "role"].includes(x.entity) ? HIST_DICT_ENTITY[x.entity] : null);
			if (k && maps[k]) return maps[k].get(String(v)) || v;
			if (HIST_BOOL.includes(x.field)) return String(v) === "1" ? "так" : "ні";
			return HIST_VALUE[x.field + ":" + v] || v;
		};

		r.rows = r.rows.map((x) => {
			// Для контакту/реквізиту/адреси/зв'язку field — це тип
			const typeDict = ["contact", "identifier", "address", "relationship", "external_id"].includes(x.entity) && !HIST_FIELD[x.field] ? HIST_DICT_ENTITY[x.entity] : null;
			return {
				...x,
				field_text: typeDict && maps[typeDict] ? maps[typeDict].get(String(x.field)) || x.field : HIST_FIELD[x.field] || x.field,
				old_text: text(x, x.value_old),
				new_text: text(x, x.value_new),
			};
		});
		return r;
	})
);

router.get("/api/clients/recalc-stats/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const clients = await require("../../controllers/clients/stats").recalcAll();

		let analytics = "skipped";
		try {
			const [[r]] = await connection_pool.query(`SELECT MIN(date_order_day) AS d_from, MAX(date_order_day) AS d_to FROM ${P}orders WHERE deleted_at IS NULL`);
			if (r && r.d_from) {
				await require("../../cron/analytics/rebuildStats").rebuildRange(r.d_from, r.d_to);
				analytics = "rebuilt";
			}
		} catch (e) {
			analytics = "error: " + e.message;
		}

		res.json({ clients, analytics });
	} catch (e) {
		logging.error(e);
		res.status(500).json({ error: e.message });
	}
});

// ─────────────────────────────────────────────
router.get("/api/clients/backfill/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const result = await require("../../controllers/clients/backfill").run();
		res.json(result);
	} catch (e) {
		logging.error(e);
		res.status(500).json({ error: e.message, sql: e.sqlMessage || null });
	}
});

module.exports = router;
