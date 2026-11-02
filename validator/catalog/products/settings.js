"use strict";

const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, removeAdditional: "all", useDefaults: true, coerceTypes: true });

const CODE = { type: "string", pattern: "^[a-z0-9_]{1,32}$" };
const CURRENCY = { type: "string", pattern: "^[A-Z]{3}$" };

const SCHEMAS = {
	sku: {
		type: "object",
		additionalProperties: false,
		properties: {
			auto: { type: "boolean", default: false },
			// Токени: {PREFIX} {SEQ:n} {ID:n} {BRAND} {CAT} {YYYY} {YY} {MM} {RAND:n}
			pattern: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_\\-./{}:]+$", default: "{PREFIX}-{SEQ:6}" },
			prefix: { type: "string", maxLength: 16, pattern: "^[A-Za-z0-9_\\-]*$", default: "GC" },
			variant_pattern: { type: "string", minLength: 1, maxLength: 64, default: "{PARENT}-{AXES}" },
			regenerate_on_change: { type: "boolean", default: false },
		},
	},
	ean: {
		type: "object",
		additionalProperties: false,
		properties: {
			auto: { type: "boolean", default: false },
			// 200–299 — діапазон GS1 для внутрішнього використання магазином
			internal_prefix: { type: "string", pattern: "^2[0-9]{2}$", default: "200" },
		},
	},
	slug: {
		type: "object",
		additionalProperties: false,
		properties: {
			auto: { type: "boolean", default: true },
			transliteration: { enum: ["uk", "ru", "none"], default: "uk" },
			max_length: { type: "integer", minimum: 20, maximum: 191, default: 120 },
		},
	},
	images: {
		type: "object",
		additionalProperties: false,
		properties: {
			format: { enum: ["webp", "avif", "jpeg", "original"], default: "webp" },
			quality: { type: "integer", minimum: 30, maximum: 100, default: 82 },
			max_width: { type: "integer", minimum: 200, maximum: 8000, default: 2400 },
			max_height: { type: "integer", minimum: 200, maximum: 8000, default: 2400 },
			keep_original: { type: "boolean", default: false },
			strip_metadata: { type: "boolean", default: true },
			max_file_mb: { type: "integer", minimum: 1, maximum: 50, default: 20 },
			allowed_mime: {
				type: "array",
				uniqueItems: true,
				items: { enum: ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "image/heif", "image/tiff"] },
				default: ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"],
			},
			thumbnails: {
				type: "array",
				maxItems: 10,
				items: {
					type: "object",
					additionalProperties: false,
					required: ["code", "width", "height"],
					properties: {
						code: CODE,
						width: { type: "integer", minimum: 16, maximum: 4000 },
						height: { type: "integer", minimum: 16, maximum: 4000 },
						fit: { enum: ["contain", "cover", "inside"], default: "contain" },
					},
				},
				default: [
					{ code: "small", width: 150, height: 150, fit: "contain" },
					{ code: "medium", width: 500, height: 500, fit: "contain" },
					{ code: "large", width: 1200, height: 1200, fit: "inside" },
				],
			},
			watermark: {
				type: "object",
				additionalProperties: false,
				properties: {
					enabled: { type: "boolean", default: false },
					file: { type: ["string", "null"], pattern: "^[A-Za-z0-9_\\-./]+\\.(png|webp)$", default: null },
					position: { enum: ["center", "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"], default: "southeast" },
					opacity: { type: "number", minimum: 0.05, maximum: 1, default: 0.5 },
					scale: { type: "number", minimum: 0.05, maximum: 1, default: 0.25 },
				},
				default: {},
			},
		},
	},
	stock: {
		type: "object",
		additionalProperties: false,
		properties: {
			multi_warehouse: { type: "boolean", default: true },
			id_default_warehouse: { type: "integer", minimum: 1, default: 1 },
			write_off_strategy: { enum: ["priority", "fifo", "fefo"], default: "priority" },
			// Собівартість із надходжень: manual — лише вручну; last — ціна останнього надходження; average — середньозважена
			cost_method: { enum: ["manual", "last", "average"], default: "manual" },
			reserve_on: { enum: ["order_create", "order_paid", "never"], default: "order_create" },
			reservation_ttl_minutes: { type: "integer", minimum: 0, maximum: 43200, default: 60 },
			allow_negative: { type: "boolean", default: false },
			track_batches: { type: "boolean", default: false },
			track_serials: { type: "boolean", default: false },
			default_out_of_stock_action: { enum: ["deny", "backorder", "preorder"], default: "deny" },
			auto_digital_links: { type: "boolean", default: true },
		},
	},
	prices: {
		type: "object",
		additionalProperties: false,
		properties: {
			base_currency: { ...CURRENCY, default: "UAH" },
			prices_include_tax: { type: "boolean", default: true },
			rounding: { type: "integer", minimum: 0, maximum: 4, default: 2 },
			show_compare_at: { type: "boolean", default: true },
		},
	},
	rewards: {
		type: "object",
		additionalProperties: false,
		properties: {
			enabled: { type: "boolean", default: false },
			point_value: { type: "number", minimum: 0, default: 1 },
			auto_mode: { enum: ["none", "percent"], default: "none" },
			auto_percent: { type: "number", minimum: 0, maximum: 100, default: 0 },
			accrue_on_status: { type: ["integer", "null"], default: null },
		},
	},
	units: {
		type: "object",
		additionalProperties: false,
		properties: {
			weight: { enum: ["kg", "g", "lb", "oz"], default: "kg" },
			length: { enum: ["cm", "mm", "m", "in"], default: "cm" },
		},
	},
	card: {
		type: "object",
		additionalProperties: false,
		properties: {
			default_status: { enum: ["draft", "active"], default: "draft" },
			id_default_attribute_set: { type: ["integer", "null"], default: null },
			required_fields: { type: "array", uniqueItems: true, items: { enum: ["name", "sku", "price", "category", "brand", "image", "description"] }, default: ["name"] },
			per_page: { type: "integer", minimum: 10, maximum: 500, default: 50 },
		},
	},
	seo: {
		type: "object",
		additionalProperties: false,
		properties: {
			title_max: { type: "integer", minimum: 30, maximum: 120, default: 60 },
			description_max: { type: "integer", minimum: 70, maximum: 320, default: 160 },
			// Шаблони: {token}; [ … ] — фрагмент зникає, якщо хоч один токен у ньому порожній
			templates: {
				type: "array",
				maxItems: 300,
				items: {
					type: "object",
					additionalProperties: false,
					required: ["entity", "lang"],
					properties: {
						entity: { enum: ["products", "categories", "brands"] },
						lang: { type: "string", pattern: "^(\\*|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$" },
						meta_title: { type: "string", maxLength: 255, default: "" },
						meta_description: { type: "string", maxLength: 512, default: "" },
						og_title: { type: "string", maxLength: 255, default: "" },
						og_description: { type: "string", maxLength: 512, default: "" },
					},
				},
				default: [
					{ entity: "products", lang: "*", meta_title: "{name}[ — {brand}]", meta_description: "{name}[. {short_description}]", og_title: "", og_description: "" },
					{ entity: "categories", lang: "*", meta_title: "{name}", meta_description: "{name}[. {description}]", og_title: "", og_description: "" },
					{ entity: "brands", lang: "*", meta_title: "{name}", meta_description: "{name}[. {description}]", og_title: "", og_description: "" },
				],
			},
		},
	},
	publishing: {
		type: "object",
		additionalProperties: false,
		properties: {
			// Увімкнено — зміни товару йдуть на сайти лише після кнопки «Опублікувати»
			enabled: { type: "boolean", default: false },
			// Ціна й статус — одразу, без публікації (залишок іде одразу завжди)
			live_price: { type: "boolean", default: true },
			live_status: { type: "boolean", default: true },
			// Момент увімкнення (ставить сервер): старіші товари без знімка йдуть як є, поки знімаються
			enabled_at: { type: ["string", "null"], maxLength: 40, default: null },
		},
	},
	// Довідник валют (розділ «Валюти»). Курс — скільки базової валюти (prices.base_currency) за 1 одиницю.
	// Зберігається лише через API валют (журнал, перерахунок цін), не загальною формою налаштувань.
	currencies: {
		type: "object",
		additionalProperties: false,
		properties: {
			list: {
				type: "array",
				maxItems: 30,
				default: [],
				items: {
					type: "object",
					additionalProperties: false,
					required: ["code"],
					properties: {
						code: CURRENCY,
						name: { type: "string", maxLength: 64, default: "" },
						symbol: { type: "string", maxLength: 8, default: "" },
						rate: { type: "number", exclusiveMinimum: 0, maximum: 1000000000, default: 1 },
						// Корекція курсу, %: «комерційний» курс = курс × (1 + корекція / 100)
						correction: { type: "number", minimum: -50, maximum: 100, default: 0 },
						// Перераховувати ціни лише якщо курс змінився більше ніж на N %
						threshold: { type: "number", minimum: 0, maximum: 50, default: 0 },
						// Ціни лише ростуть: курс упав — продажні ціни не знижуються
						only_up: { type: "boolean", default: false },
						// Округлення продажної ціни: крок і «закінчення» (крок 100, мінус 1 → …99)
						round: { enum: ["none", "up", "nearest", "down"], default: "none" },
						step: { type: "number", minimum: 0.01, maximum: 100000, default: 1 },
						minus: { type: "number", minimum: 0, maximum: 100000, default: 0 },
						// auto — перераховувати одразу; confirm — після перегляду й кнопки
						apply: { enum: ["auto", "confirm"], default: "auto" },
						// Джерело курсу: manual або ключ модуля курсів; резервне — якщо основне не відповіло або не має цієї валюти
						provider: { type: "string", pattern: "^[a-z0-9_]{1,32}$", default: "manual" },
						fallback: { type: "string", pattern: "^[a-z0-9_]{0,32}$", default: "" },
						// Захист від помилкового курсу: курс від модуля змінився більше ніж на N % — не застосовувати, чекати підтвердження (0 — вимкнено)
						max_jump: { type: "number", minimum: 0, maximum: 100, default: 0 },
						// Неактивна — не пропонується для нових цін; наявні ціни в ній працюють і перераховуються
						active: { type: "boolean", default: true },
						// Курс вводиться за 1 / 10 / 100 / 1000 одиниць (для «дрібних» валют); зберігається завжди за 1
						units: { enum: [1, 10, 100, 1000], default: 1 },
						// Попередження «курс застарів», якщо не оновлювався стільки годин (0 — без попередження)
						stale_hours: { type: "integer", minimum: 0, maximum: 2160, default: 0 },
						// Відображення сум: символ перед / після, знаків після коми
						symbol_pos: { enum: ["before", "after"], default: "after" },
						decimals: { type: "integer", minimum: 0, maximum: 4, default: 2 },
						// Курс, затриманий захистом (ставить сервер)
						suggested_rate: { type: ["number", "null"], default: null },
						suggested_source: { type: ["string", "null"], maxLength: 32, default: null },
						suggested_at: { type: ["string", "null"], maxLength: 40, default: null },
						// Службові (ставить сервер)
						applied_rate: { type: ["number", "null"], default: null },
						applied_at: { type: ["string", "null"], maxLength: 40, default: null },
						updated_at: { type: ["string", "null"], maxLength: 40, default: null },
						pending: { type: "boolean", default: false },
					},
				},
			},
			// Відображення сум в основній валюті
			base_format: {
				type: "object",
				additionalProperties: false,
				default: {},
				properties: {
					symbol: { type: "string", maxLength: 8, default: "" },
					symbol_pos: { enum: ["before", "after"], default: "after" },
					decimals: { type: "integer", minimum: 0, maximum: 4, default: 2 },
				},
			},
			// Журнал змін курсу (новіші — першими)
			log: {
				type: "array",
				maxItems: 500,
				default: [],
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						code: CURRENCY,
						rate: { type: "number" },
						prev: { type: ["number", "null"], default: null },
						source: { type: "string", maxLength: 32, default: "manual" },
						at: { type: "string", maxLength: 40 },
						// Курс затримано захистом від стрибка (не застосовано)
						held: { type: "boolean", default: false },
						user: { type: ["integer", "null"], default: null },
					},
				},
			},
		},
	},
	// Ціна за формулою: собівартість × (1 + націнка %) з округленням. Націнка — перше правило, що підійшло
	// (бренди / категорії з підкатегоріями / постачальники), інакше — за замовчуванням. Діє для товарів із позначкою «Ціна за формулою»
	price_formula: {
		type: "object",
		additionalProperties: false,
		properties: {
			default_markup: { type: ["number", "null"], minimum: -99, maximum: 10000, default: null },
			round: { enum: ["none", "up", "nearest", "down"], default: "none" },
			step: { type: "number", minimum: 0.01, maximum: 100000, default: 1 },
			minus: { type: "number", minimum: 0, maximum: 100000, default: 0 },
			// Стара ціна = ціна + N % (null — не чіпати)
			compare_markup: { type: ["number", "null"], minimum: 0, maximum: 10000, default: null },
			rules: {
				type: "array",
				maxItems: 200,
				default: [],
				items: {
					type: "object",
					additionalProperties: false,
					required: ["markup"],
					properties: {
						brands: { type: "array", maxItems: 500, default: [], items: { type: "integer", minimum: 1 } },
						categories: { type: "array", maxItems: 500, default: [], items: { type: "integer", minimum: 1 } },
						suppliers: { type: "array", maxItems: 500, default: [], items: { type: "integer", minimum: 1 } },
						markup: { type: "number", minimum: -99, maximum: 10000 },
					},
				},
			},
		},
	},
	// Реквізити продавця для друкованих документів замовлення (рахунок, видаткова накладна)
	documents: {
		type: "object",
		additionalProperties: false,
		properties: {
			seller_name: { type: "string", maxLength: 255, default: "" },
			seller_code: { type: "string", maxLength: 32, default: "" },
			seller_address: { type: "string", maxLength: 500, default: "" },
			seller_phone: { type: "string", maxLength: 64, default: "" },
			seller_iban: { type: "string", maxLength: 64, default: "" },
			seller_bank: { type: "string", maxLength: 255, default: "" },
			vat_payer: { type: "boolean", default: false },
			signer: { type: "string", maxLength: 128, default: "" },
			invoice_days: { type: "integer", minimum: 0, maximum: 365, default: 3 },
			invoice_note: { type: "string", maxLength: 1000, default: "" },
		},
	},
	edit_lock: {
		type: "object",
		additionalProperties: false,
		properties: {
			ttl_seconds: { type: "integer", minimum: 30, maximum: 600, default: 60 },
			heartbeat_seconds: { type: "integer", minimum: 5, maximum: 120, default: 20 },
		},
	},
};

const validators = Object.fromEntries(Object.entries(SCHEMAS).map(([k, s]) => [k, ajv.compile(s)]));

/** Дефолти кожного блоку — з самих схем, щоб не було двох джерел правди */
const DEFAULTS = Object.fromEntries(
	Object.keys(SCHEMAS).map((k) => {
		const obj = {};
		validators[k](obj);
		return [k, obj];
	})
);

function validateSetting(key, value) {
	const v = validators[key];
	if (!v) return { valid: false, errors: [{ field: "key", message: "Unknown settings block" }] };
	const data = JSON.parse(JSON.stringify(value || {}));
	if (!v(data)) {
		return {
			valid: false,
			errors: v.errors.map((e) => ({ field: (e.instancePath || "").replace(/^\//, "").replace(/\//g, ".") || e.params.missingProperty || key, message: e.message, keyword: e.keyword })),
		};
	}
	// Перехресні перевірки
	if (key === "edit_lock" && data.heartbeat_seconds * 2 > data.ttl_seconds) {
		return { valid: false, errors: [{ field: "heartbeat_seconds", message: "must be at most half of ttl_seconds" }] };
	}
	if (key === "seo") {
		const keys = data.templates.map((t) => t.entity + "|" + t.lang.toLowerCase());
		if (new Set(keys).size !== keys.length) return { valid: false, errors: [{ field: "templates", message: "duplicate entity + language" }] };
	}
	if (key === "images") {
		const codes = data.thumbnails.map((t) => t.code);
		if (new Set(codes).size !== codes.length) return { valid: false, errors: [{ field: "thumbnails", message: "duplicate code" }] };
	}
	return { valid: true, data };
}

module.exports = { KEYS: Object.keys(SCHEMAS), DEFAULTS, validateSetting };
