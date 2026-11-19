"use strict";

const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, removeAdditional: true, coerceTypes: false });

const MAX_IDS = 1000;
const MONEY_MAX = 99999999999;

const schema = {
	type: "object",
	required: ["ids", "action"],
	properties: {
		ids: { type: "array", minItems: 1, maxItems: MAX_IDS, uniqueItems: true, items: { type: "integer", minimum: 1 } },
		action: { enum: ["status", "visibility", "featured", "brand", "categories", "price", "compare_from_price", "currency", "formula", "fixed_price", "delete"] },
		params: { type: "object" },
	},
	additionalProperties: false,
	allOf: [
		{
			if: { properties: { action: { const: "status" } } },
			then: { properties: { params: { type: "object", required: ["status"], properties: { status: { enum: ["draft", "active", "archived"] } }, additionalProperties: false } }, required: ["params"] },
		},
		{
			if: { properties: { action: { const: "visibility" } } },
			then: { properties: { params: { type: "object", required: ["visibility"], properties: { visibility: { enum: ["all", "catalog", "search", "none"] } }, additionalProperties: false } }, required: ["params"] },
		},
		{
			if: { properties: { action: { const: "featured" } } },
			then: { properties: { params: { type: "object", required: ["value"], properties: { value: { enum: [0, 1] } }, additionalProperties: false } }, required: ["params"] },
		},
		{
			if: { properties: { action: { const: "brand" } } },
			then: { properties: { params: { type: "object", required: ["id_brand"], properties: { id_brand: { type: ["integer", "null"], minimum: 1 } }, additionalProperties: false } }, required: ["params"] },
		},
		{
			if: { properties: { action: { const: "categories" } } },
			then: {
				required: ["params"],
				properties: {
					params: {
						type: "object",
						required: ["op", "ids"],
						properties: {
							op: { enum: ["add", "remove", "replace"] },
							ids: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "integer", minimum: 1 } },
							set_main: { type: "boolean" },
						},
						additionalProperties: false,
					},
				},
			},
		},
		{
			if: { properties: { action: { const: "price" } } },
			then: {
				required: ["params"],
				properties: {
					params: {
						type: "object",
						required: ["field", "op", "value"],
						properties: {
							field: { enum: ["price", "compare_at_price", "cost_price", "wholesale_price"] },
							op: { enum: ["set", "percent", "amount"] },
							value: { type: "number", minimum: -MONEY_MAX, maximum: MONEY_MAX },
							round: { enum: ["none", "0", "1", "2", "99", "9"] },
							variants: { type: "boolean" },
						},
						additionalProperties: false,
					},
				},
			},
		},
		{
			// Ціна за формулою (собівартість + націнка): on — увімкнути й порахувати, off — вимкнути
			if: { properties: { action: { const: "formula" } } },
			then: { required: ["params"], properties: { params: { type: "object", required: ["on"], properties: { on: { type: "boolean" }, variants: { type: "boolean" } }, additionalProperties: false } } },
		},
		{
			// Фіксовані ціни сайтів у валюті: convert — з поточної ціни за курсом, percent — змінити наявні, clear — прибрати
			if: { properties: { action: { const: "fixed_price" } } },
			then: {
				required: ["params"],
				properties: {
					params: {
						type: "object",
						required: ["code", "op"],
						properties: {
							code: { type: "string", pattern: "^[A-Z]{3}$" },
							op: { enum: ["convert", "percent", "clear"] },
							value: { type: "number", minimum: -99, maximum: 1000 },
						},
						additionalProperties: false,
					},
				},
			},
		},
		{
			// Валюта цін: group — яка група цін; code — валюта (базова або null — без валюти);
			// convert — перерахувати суми за курсом (базова ціна майже не зміниться); keep — ті самі числа вважати сумами в новій валюті
			if: { properties: { action: { const: "currency" } } },
			then: {
				required: ["params"],
				properties: {
					params: {
						type: "object",
						required: ["group", "code", "mode"],
						properties: {
							group: { enum: ["price", "cost", "wholesale"] },
							code: { type: ["string", "null"], pattern: "^[A-Z]{3}$" },
							mode: { enum: ["convert", "keep"] },
							variants: { type: "boolean" },
							options: { type: "boolean" },
						},
						additionalProperties: false,
					},
				},
			},
		},
		{
			if: { properties: { action: { const: "compare_from_price" } } },
			then: { properties: { params: { type: "object", properties: { variants: { type: "boolean" } }, additionalProperties: false } } },
		},
	],
};

const validate = ajv.compile(schema);

function validateBulk(body) {
	if (!validate(body)) {
		return { error: validate.errors.filter((e) => e.keyword !== "if").map((e) => ({ field: e.instancePath.replace(/^\//, "").replace(/\//g, ".") || e.params.missingProperty || "body", message: e.message })) };
	}
	const v = body;
	if (v.action === "fixed_price" && v.params.op === "percent" && typeof v.params.value !== "number") return { error: [{ field: "params.value", message: "required" }] };
	if (v.action === "price") {
		const p = v.params;
		if (p.op === "set" && p.value < 0) return { error: [{ field: "params.value", message: "must be >= 0" }] };
		if (p.op === "percent" && (p.value < -100 || p.value > 10000)) return { error: [{ field: "params.value", message: "percent out of range" }] };
		if (!p.round) p.round = "none";
		if (p.variants === undefined) p.variants = true;
	}
	if (v.action === "compare_from_price") v.params = { variants: true, ...(v.params || {}) };
	if (v.action === "currency") v.params = { variants: true, options: true, ...v.params };
	return { value: v };
}

/* ─── Дії лише масового редагування (через чергу): поле товару, тексти, SEO за шаблоном, характеристика, коди ─── */

/**
 * Поля товару для дії «Поле товару»: тип і межі — ті самі, що в картці товару (validator/catalog/products/products.js).
 * t: num | int | bool | enum | str | date; nullable — можна очистити; gt0 — лише більше нуля.
 */
const MONEY = 99999999999;
const FIELD_DEFS = {
	// Доставка й габарити
	requires_shipping: { t: "bool", group: "shipping" },
	weight: { t: "num", min: 0, max: 99999999, nullable: true, group: "shipping" },
	weight_unit: { t: "enum", values: ["kg", "g", "lb", "oz"], nullable: true, group: "shipping" },
	length: { t: "num", min: 0, max: 99999999, nullable: true, group: "shipping" },
	width: { t: "num", min: 0, max: 99999999, nullable: true, group: "shipping" },
	height: { t: "num", min: 0, max: 99999999, nullable: true, group: "shipping" },
	length_unit: { t: "enum", values: ["cm", "mm", "m", "in"], nullable: true, group: "shipping" },
	shipping_class: { t: "str", max: 64, nullable: true, group: "shipping" },
	additional_shipping_cost: { t: "num", min: 0, max: MONEY, nullable: true, group: "shipping" },
	delivery_time_type: { t: "enum", values: ["none", "default", "custom"], group: "shipping" },
	hs_code: { t: "str", max: 16, pattern: "^[0-9.]{4,16}$", nullable: true, group: "shipping" },
	country_of_origin: { t: "str", max: 2, pattern: "^[A-Z]{2}$", nullable: true, group: "shipping" },
	// Залишки й замовлення
	track_inventory: { t: "bool", group: "stock" },
	subtract_stock: { t: "bool", group: "stock" },
	min_qty: { t: "num", min: 0, gt0: true, max: 999999999, group: "stock" },
	max_qty: { t: "num", min: 0, max: 999999999, nullable: true, group: "stock" },
	qty_step: { t: "num", min: 0, gt0: true, max: 999999999, group: "stock" },
	low_stock_threshold: { t: "num", min: 0, max: 999999999, nullable: true, group: "stock" },
	low_stock_alert: { t: "bool", group: "stock" },
	out_of_stock_action: { t: "enum", values: ["default", "deny", "backorder", "preorder"], group: "stock" },
	available_date: { t: "date", nullable: true, group: "stock" },
	preorder_release_date: { t: "date", nullable: true, group: "stock" },
	sold_individually: { t: "bool", group: "stock" },
	available_for_order: { t: "bool", group: "stock" },
	// Ціна на вітрині
	show_price: { t: "bool", group: "price" },
	price_on_request: { t: "bool", group: "price" },
	on_sale_flag: { t: "bool", group: "price" },
	unit_price: { t: "num", min: 0, max: MONEY, nullable: true, group: "price" },
	unit_price_unit: { t: "str", max: 16, nullable: true, group: "price" },
	unit_price_base: { t: "num", min: 0, max: 999999999, nullable: true, group: "price" },
	ecotax: { t: "num", min: 0, max: MONEY, nullable: true, group: "price" },
	points_price: { t: "int", min: 0, max: 2147483647, nullable: true, group: "price" },
	// Основне
	model: { t: "str", max: 128, nullable: true, group: "main" },
	mpn: { t: "str", max: 64, nullable: true, group: "main" },
	vendor: { t: "str", max: 128, nullable: true, group: "main" },
	product_type_label: { t: "str", max: 128, nullable: true, group: "main" },
	item_condition: { t: "enum", values: ["new", "used", "refurbished"], group: "main" },
	show_condition: { t: "bool", group: "main" },
	online_only: { t: "bool", group: "main" },
	age_restriction: { t: "int", min: 0, max: 99, nullable: true, group: "main" },
	allow_gift_wrap: { t: "bool", group: "main" },
	sort_order: { t: "int", min: -2147483648, max: 2147483647, group: "main" },
	robots_index: { t: "bool", group: "main" },
	robots_follow: { t: "bool", group: "main" },
};
/**
 * Поля варіантів для дії «Поле варіантів» (у кожного варіанта варіативного товару).
 * Ціни варіантів тут немає: її міняє дія «Ціна» з позначкою «і варіанти» (з валютами й режимом «± до ціни»).
 */
const VARIANT_FIELD_DEFS = {
	status: { t: "bool", group: "main" },
	sort_order: { t: "int", min: -2147483648, max: 2147483647, group: "main" },
	mpn: { t: "str", max: 64, nullable: true, group: "main" },
	weight_impact: { t: "num", min: -99999999, max: 99999999, nullable: true, group: "shipping" },
	length: { t: "num", min: 0, max: 99999999, nullable: true, group: "shipping" },
	width: { t: "num", min: 0, max: 99999999, nullable: true, group: "shipping" },
	height: { t: "num", min: 0, max: 99999999, nullable: true, group: "shipping" },
	min_qty: { t: "num", min: 0, gt0: true, max: 999999999, nullable: true, group: "stock" },
	low_stock_threshold: { t: "num", min: 0, max: 999999999, nullable: true, group: "stock" },
	out_of_stock_action: { t: "enum", values: ["inherit", "deny", "backorder", "preorder"], group: "stock" },
	available_date: { t: "date", nullable: true, group: "stock" },
	points_price: { t: "int", min: 0, max: 2147483647, nullable: true, group: "price" },
};
// Які операції має кожен тип поля
const FIELD_OPS = { num: ["set", "percent", "amount", "clear"], int: ["set", "amount", "clear"], bool: ["set"], enum: ["set", "clear"], str: ["set", "clear", "prepend", "append", "replace"], date: ["set", "clear"] };

// Тексти товару (переклади): поле → найбільша довжина (як у картці); адреса (slug) і canonical тут не змінюються
const TEXT_FIELDS = {
	name: 255,
	h1: 255,
	short_description: 65535,
	description: 16777215,
	meta_title: 255,
	meta_description: 512,
	meta_keywords: 512,
	tags: 512,
	search_keywords: 512,
	text_in_stock: 255,
	text_out_of_stock: 255,
	delivery_text_in_stock: 255,
	delivery_text_out_stock: 255,
	unit_label: 32,
	og_title: 255,
	og_description: 512,
};
const SEO_FIELDS = ["meta_title", "meta_description", "meta_keywords", "h1", "og_title", "og_description"];
const langs = { type: "array", maxItems: 50, uniqueItems: true, items: { type: "integer", minimum: 1 } };

const opSchemas = {
	variant_field: {
		type: "object",
		required: ["field", "op"],
		properties: {
			field: { enum: Object.keys(VARIANT_FIELD_DEFS) },
			op: { enum: ["set", "percent", "amount", "clear", "prepend", "append", "replace"] },
			value: { type: ["string", "number", "boolean", "null"], maxLength: 255 },
			find: { type: "string", minLength: 1, maxLength: 255 },
			only_empty: { type: "boolean" },
		},
		additionalProperties: false,
	},
	field: {
		type: "object",
		required: ["field", "op"],
		properties: {
			field: { enum: Object.keys(FIELD_DEFS) },
			op: { enum: ["set", "percent", "amount", "clear", "prepend", "append", "replace"] },
			value: { type: ["string", "number", "boolean", "null"], maxLength: 255 },
			find: { type: "string", minLength: 1, maxLength: 255 },
		},
		additionalProperties: false,
	},
	text: {
		type: "object",
		required: ["field", "op"],
		properties: {
			field: { enum: Object.keys(TEXT_FIELDS) },
			langs,
			op: { enum: ["set", "clear", "prepend", "append", "replace", "regex"] },
			value: { type: "string", maxLength: 65535 },
			find: { type: "string", minLength: 1, maxLength: 500 },
			case_sensitive: { type: "boolean" },
		},
		additionalProperties: false,
	},
	seo: {
		type: "object",
		required: ["field", "template"],
		properties: {
			field: { enum: SEO_FIELDS },
			langs,
			template: { type: "string", minLength: 1, maxLength: 1000 },
			only_empty: { type: "boolean" },
		},
		additionalProperties: false,
	},
	// Фото: cover — головне (перше / останнє / на позиції), remove — прибрати, alt — ALT або title за шаблоном
	media: {
		type: "object",
		required: ["op"],
		properties: {
			op: { enum: ["cover", "remove", "alt"] },
			pick: { enum: ["first", "last", "position"] },
			position: { type: "integer", minimum: 1, maximum: 1000 },
			move_first: { type: "boolean" },
			what: { enum: ["all", "except_cover", "keep_first", "duplicates"] },
			keep: { type: "integer", minimum: 1, maximum: 1000 },
			field: { enum: ["alt", "title"] },
			langs,
			template: { type: "string", maxLength: 1000 },
			clear: { type: "boolean" },
			only_empty: { type: "boolean" },
		},
		additionalProperties: false,
	},
	attribute: {
		type: "object",
		required: ["id_attribute", "op"],
		properties: {
			id_attribute: { type: "integer", minimum: 1 },
			op: { enum: ["set", "remove"] },
			value_ids: { type: "array", maxItems: 500, uniqueItems: true, items: { type: "integer", minimum: 1 } },
			number: { type: ["number", "null"] },
			date: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
			text: { type: ["string", "null"], maxLength: 65535 },
			only_empty: { type: "boolean" },
		},
		additionalProperties: false,
	},
	codes: {
		type: "object",
		required: ["code"],
		properties: {
			code: { enum: ["sku", "ean"] },
			template: { type: "string", maxLength: 128 },
			only_empty: { type: "boolean" },
		},
		additionalProperties: false,
	},
	// Залишки на складі — через складський документ: set — інвентаризація (стане рівно qty), add — коригування (±qty)
	stock: {
		type: "object",
		required: ["id_warehouse", "op", "qty"],
		properties: {
			id_warehouse: { type: "integer", minimum: 1 },
			op: { enum: ["set", "add"] },
			qty: { type: "number", minimum: -999999999, maximum: 999999999 },
		},
		additionalProperties: false,
	},
};
const opValidators = Object.fromEntries(Object.entries(opSchemas).map(([k, v]) => [k, ajv.compile(v)]));
const JOB_ONLY = Object.keys(opSchemas);

/** Регулярний вираз від людини: компілюється й не має вкладених повторів (захист від «зависання» на катастрофічному переборі) */
function safeRegex(src, flags) {
	if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(src)) return null;
	try {
		return new RegExp(src, flags);
	} catch {
		return null;
	}
}

/** Перевірити параметри дії «Поле товару» за типом поля */
function checkField(p, defs = FIELD_DEFS) {
	const def = defs[p.field];
	const err = (message) => ({ error: [{ field: "params.value", message }] });
	if (!FIELD_OPS[def.t].includes(p.op)) return { error: [{ field: "params.op", message: "not allowed for this field" }] };
	if (p.op === "clear") {
		if (!def.nullable) return { error: [{ field: "params.op", message: "field cannot be empty" }] };
		return { value: { field: p.field, op: "clear" } };
	}
	if (p.op === "replace" && !p.find) return { error: [{ field: "params.find", message: "required" }] };
	const v = p.value;
	if (def.t === "bool") {
		if (typeof v !== "boolean") return err("must be boolean");
	} else if (def.t === "num" || def.t === "int") {
		if (typeof v !== "number" || !Number.isFinite(v)) return err("must be number");
		if (def.t === "int" && !Number.isInteger(v)) return err("must be integer");
		if (p.op === "set" && (v < def.min || v > def.max || (def.gt0 && v <= 0))) return err("out of range");
		if (p.op === "percent" && (v < -100 || v > 10000)) return err("percent out of range");
		if (p.op === "amount" && Math.abs(v) > def.max) return err("out of range");
	} else if (def.t === "enum") {
		if (!def.values.includes(v)) return err("unknown value");
	} else if (def.t === "date") {
		if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) return err("must be date");
	} else {
		if (typeof v !== "string" || v.length > def.max) return err("too long");
		if (p.op === "set" && def.pattern && !new RegExp(def.pattern).test(v)) return err("invalid format");
	}
	return { value: { field: p.field, op: p.op, value: v, ...(p.op === "replace" ? { find: p.find } : {}) } };
}

/** Дія масового редагування, якої немає серед масових дій списку */
function validateJobOp(action, params) {
	const v = opValidators[action];
	if (!v(params || {})) return { error: v.errors.map((e) => ({ field: ("params" + e.instancePath.replace(/\//g, ".")).replace(/\.$/, "") || "params", message: e.message })) };
	const p = params;
	if (action === "field") return checkField(p);
	if (action === "variant_field") {
		const r = checkField(p, VARIANT_FIELD_DEFS);
		// «Лише де порожньо» — для встановлення значення
		if (r.value && p.op === "set" && p.only_empty) r.value.only_empty = true;
		return r;
	}
	if (action === "text") {
		if (["set", "prepend", "append"].includes(p.op) && typeof p.value !== "string") return { error: [{ field: "params.value", message: "required" }] };
		if (["replace", "regex"].includes(p.op) && !p.find) return { error: [{ field: "params.find", message: "required" }] };
		if (p.op === "regex" && !safeRegex(p.find, "g")) return { error: [{ field: "params.find", message: "invalid regular expression" }] };
		if (p.op === "clear" && p.field === "name") return { error: [{ field: "params.op", message: "name cannot be empty" }] };
		if (p.value !== undefined && p.value.length > TEXT_FIELDS[p.field]) return { error: [{ field: "params.value", message: "too long" }] };
		return { value: { field: p.field, langs: p.langs || [], op: p.op, value: p.value || "", find: p.find || "", case_sensitive: !!p.case_sensitive } };
	}
	if (action === "seo") return { value: { field: p.field, langs: p.langs || [], template: p.template, only_empty: p.only_empty !== false } };
	if (action === "attribute") return { value: { ...p, only_empty: !!p.only_empty } };
	if (action === "media") {
		const bad = (field, message) => ({ error: [{ field: `params.${field}`, message }] });
		if (p.op === "cover") {
			const pick = p.pick || "first";
			if (pick === "position" && !p.position) return bad("position", "required");
			return { value: { op: "cover", pick, ...(pick === "position" ? { position: p.position } : {}), move_first: !!p.move_first } };
		}
		if (p.op === "remove") {
			if (!p.what) return bad("what", "required");
			if (p.what === "keep_first" && !p.keep) return bad("keep", "required");
			return { value: { op: "remove", what: p.what, ...(p.what === "keep_first" ? { keep: p.keep } : {}) } };
		}
		const template = String(p.template || "").trim();
		if (!p.clear && !template) return bad("template", "required");
		return { value: { op: "alt", field: p.field || "alt", langs: p.langs || [], ...(p.clear ? { clear: true } : { template }), only_empty: !p.clear && p.only_empty !== false } };
	}
	if (action === "codes") {
		if (p.code === "ean") return { value: { code: "ean", only_empty: true } };
		return { value: { code: "sku", template: (p.template || "").trim(), only_empty: p.only_empty !== false } };
	}
	if (action === "stock") {
		const qty = Math.round(p.qty * 1000) / 1000;
		if (p.op === "set" && qty < 0) return { error: [{ field: "params.qty", message: "must be >= 0" }] };
		if (p.op === "add" && qty === 0) return { error: [{ field: "params.qty", message: "must not be 0" }] };
		return { value: { id_warehouse: p.id_warehouse, op: p.op, qty } };
	}
	return { value: p };
}

/* ─── Масове редагування через чергу: вибір товарів + кілька дій по черзі ─── */
const MAX_OPS = 10;
const MAX_LIST = 100000; // рядків у вставленому списку артикулів / ID / EAN
const FILTER_KEYS = ["search", "status", "type", "id_brand", "id_category", "stock", "price_from", "price_to", "quality", "issue", "publish", "channel"];

const jobSchema = {
	type: "object",
	required: ["selection", "operations"],
	properties: {
		title: { type: "string", maxLength: 255 },
		// Розклад: запустити не раніше; автоматично відмінити в цей час (ISO з поясом, напр. 2026-12-01T08:00:00.000Z)
		run_at: { type: ["string", "null"], maxLength: 40 },
		revert_at: { type: ["string", "null"], maxLength: 40 },
		selection: {
			type: "object",
			required: ["mode"],
			properties: {
				mode: { enum: ["filter", "list", "ids"] },
				filter: { type: "object", additionalProperties: { type: ["string", "number"], maxLength: 200 } },
				list: { type: "string", maxLength: 4000000 },
				ids: { type: "array", maxItems: MAX_LIST, uniqueItems: true, items: { type: "integer", minimum: 1 } },
			},
			additionalProperties: false,
		},
		operations: { type: "array", minItems: 1, maxItems: MAX_OPS, items: { type: "object", required: ["action"], properties: { action: { type: "string" }, params: { type: "object" } }, additionalProperties: false } },
	},
	additionalProperties: false,
};
const validateJobShape = ajv.compile(jobSchema);

/**
 * Масова зміна: { title?, selection: { mode: filter | list | ids, filter?, list?, ids? }, operations: [{ action, params }] }.
 * Кожна дія перевіряється тією самою схемою, що й дія зі списку товарів (видалення тут немає — для нього є кошик).
 */
function validateJob(body) {
	if (!validateJobShape(body)) {
		return { error: validateJobShape.errors.map((e) => ({ field: e.instancePath.replace(/^\//, "").replace(/\//g, ".") || e.params.missingProperty || "body", message: e.message })) };
	}
	const sel = body.selection;
	if (sel.mode === "filter") {
		const f = {};
		for (const k of FILTER_KEYS) if (sel.filter && sel.filter[k] !== undefined && sel.filter[k] !== "") f[k] = String(sel.filter[k]);
		sel.filter = f;
	}
	if (sel.mode === "list" && !String(sel.list || "").trim()) return { error: [{ field: "selection.list", message: "required" }] };
	if (sel.mode === "ids" && !(sel.ids || []).length) return { error: [{ field: "selection.ids", message: "required" }] };
	const operations = [];
	for (let i = 0; i < body.operations.length; i++) {
		const op = body.operations[i];
		if (op.action === "delete") return { error: [{ field: `operations.${i}.action`, message: "not allowed" }] };
		if (JOB_ONLY.includes(op.action)) {
			const r = validateJobOp(op.action, op.params);
			if (r.error) return { error: r.error.map((e) => ({ ...e, field: `operations.${i}.${e.field}` })) };
			operations.push({ action: op.action, params: r.value });
			continue;
		}
		const r = validateBulk({ ids: [1], action: op.action, params: op.params });
		if (r.error) return { error: r.error.map((e) => ({ ...e, field: `operations.${i}.${e.field}` })) };
		operations.push({ action: r.value.action, params: r.value.params || {} });
	}
	// Залишки — окремим документом складу: у зміні лише ця одна дія
	if (operations.length > 1 && operations.some((o) => o.action === "stock")) return { error: [{ field: "operations", message: "stock must be the only action" }] };
	// Час: дійсний, у майбутньому (не далі року); відміна — пізніше за запуск
	const time = (v, field) => {
		if (v === null || v === undefined || v === "") return { value: null };
		const t = Date.parse(v);
		if (Number.isNaN(t)) return { error: [{ field, message: "invalid date" }] };
		if (t < Date.now() - 60000 || t > Date.now() + 366 * 86400000) return { error: [{ field, message: "out of range" }] };
		return { value: new Date(t).toISOString() };
	};
	const run = time(body.run_at, "run_at");
	if (run.error) return run;
	const rev = time(body.revert_at, "revert_at");
	if (rev.error) return rev;
	if (rev.value && Date.parse(rev.value) <= Date.parse(run.value || new Date().toISOString())) return { error: [{ field: "revert_at", message: "must be after start" }] };
	return { value: { title: String(body.title || "").trim(), selection: sel, operations, run_at: run.value, revert_at: rev.value } };
}

module.exports = { validateBulk, validateJob, safeRegex, FIELD_DEFS, VARIANT_FIELD_DEFS, FIELD_OPS, TEXT_FIELDS, SEO_FIELDS, MAX_IDS, MAX_OPS };