# Translating Growth contour into English (en)

You will create the English locale files for a Node.js/Express + EJS web app called **Growth contour** (business management system: orders, clients, leads, deals, catalog, mailing, contact center).

The **source of truth is Ukrainian**: `locales/uk/`. Your job is to produce `locales/en/` that mirrors it **exactly**, with every value translated into English.

English is the **base language** of the app: for every other language the app first loads English, then overrides it with that language's files. Any key missing in `en` shows up as a raw key (e.g. `catalog.products.title`) for English users and for every language that has no own file.

---

## 1. What to produce

For **every** file `locales/uk/<path>.json` create `locales/en/<path>.json`:

- the same relative path and file name (`locales/uk/catalog/products/brands.json` → `locales/en/catalog/products/brands.json`);
- the same JSON structure: same keys, same nesting, same key order;
- only the **values** are translated.

Exception — the root file: `locales/uk/uk.json` → `locales/en/en.json` (the file name is the language code).

Some `locales/en/` files already exist (`header.json`, `en.json`, `orders/orders.json`, `orders/tokens/tokens.json`, `deals/deals.json`, `leads/leads.json`, `users/users.json`, `contact-center/chat.json`, `contact-center/webchat/view.json`, `authorization/*.json`). They are outdated: **rebuild them from the Ukrainian file** in the same way. Drop keys that no longer exist in the uk file. Existing good English wording may be reused.

The list of all locale files the app loads is in `config/i18n/i18n.js` (array of `"./locales/{locale}/..."` paths). Every one of them must exist in `en`. Do **not** edit `i18n.js`.

## 2. Hard rules — do not break

1. **Never rename, add, remove or reorder keys.** Only values change.
2. **Never translate key names**, even when they look like words (`"t": { "dodaty_uhodu": "Add deal" }` — the key `dodaty_uhodu` stays as is).
3. **Keep placeholders exactly as they are**, including their names and braces:
   - `{{n}}`, `{{name}}`, `{{id}}`, `{{max}}`, `{{field}}`, `{{label}}`, `{{error}}`, `{{ref}}` … (mustache, filled by the server);
   - `{n}`, `{name}`, `{field}`, `{row}`, `{error}`, `{loser}`, `{winner}`, `{value}` (single braces, filled in JS);
   - `%n`, `%s` and similar.

   You may move a placeholder within the sentence to fit English grammar, but never change or drop it.
4. **Keep HTML inside values** (`<b>`, `<a href="...">`, `<br>`, `<strong>`) exactly, translate only the visible text. Do not change URLs.
5. **Valid JSON**: UTF-8, double quotes, no trailing commas, tab indentation (same as the uk files).
6. Use **straight double quotes only as JSON delimiters**. Inside text avoid `'` and `"`: these texts are inserted into JavaScript strings and HTML and get escaped. Use typographic characters instead: `’` (apostrophe, e.g. `don’t`, `client’s`) and `“ ”` for quotes. Do not use `&`, `<`, `>` as plain text: write “and”, avoid arrows like `->` (use `→`).
7. Do not translate:
   - the brand **Growth contour** (and never call the system “CRM” in UI texts);
   - technical identifiers and codes that appear in values: `SKU`, `EAN`, `ID`, `API`, `URL`, `SMTP`, `IMAP`, `DKIM`, `E.164`, `ISO-2`, `RFM`, `CSV`, `XLSX`, `UTF-8`, `Telegram`, `Viber`, `Instagram`, `Facebook`, `Font Awesome`, `OpenCart`, `Nova Poshta`, etc.;
   - example values in placeholders: `+1 555 123 4567`, `name@example.com`, `Europe/Kyiv`, `wholesale`, `invoice`, `novaposhta`, `UA`, `US`.
8. Special values:
   - `lang_iso` → `"en"`, `lang_name` → `"English"` (in `locales/en/index/index.json` and `locales/en/en.json`);
   - `orders.print.words.*` (amount in words for Ukrainian invoices): **keep the Ukrainian text unchanged** — it is a legal format for UAH invoices;
   - `deals.server.number_prefix` (`"УГ"`) → use `"DL"`;
   - comma-separated word lists stay comma-separated with the same number of items.

## 3. Style

- Plain, short, professional UI English (US spelling): “Save”, “Cancel”, “Delete”, “Add”, “Edit”, “Search”, “Settings”.
- Titles and buttons: sentence case (“Order statuses”, “Add product”), not Title Case.
- Keep the length close to the original — labels sit in buttons, table headers and badges.
- Keep the meaning, not word-by-word structure. Be consistent: one term = one translation across all files.
- Keep end punctuation as in the source (sentence with a period → period; label without a period → without).

### Glossary (use these)

| Ukrainian | English |
|---|---|
| Головна | Home |
| Замовлення | Orders (menu/page) / Order (single) |
| Клієнт, Клієнти | Client, Clients |
| Покупці | Customers |
| Лід, Ліди | Lead, Leads |
| Угода, Угоди | Deal, Deals |
| Каталог, Товар | Catalog, Product |
| Склад, Залишок | Warehouse, Stock |
| Постачальник | Supplier |
| Розсилки, Кампанія | Mailing, Campaign |
| Контакт-центр, Діалог | Contact center, Dialog |
| Покинутий кошик | Abandoned cart |
| Кошик (видалене) | Trash |
| Реквізити | Identifiers (company codes) / Legal details |
| ЄДРПОУ / ІПН / ПДВ | EDRPOU / IPN / VAT |
| ТТН | Waybill (TTN) |
| Стадія (клієнта) | Lifecycle stage |
| Воронка, Етап | Pipeline, Stage |
| Менеджер | Manager |
| Довідник | Dictionary |
| Журнал дій | Activity log |
| Налаштування | Settings |
| Хлібні крихти | breadcrumbs (not shown in UI) |
| Злиття (клієнтів) | Merge |
| Можливі дублі | Possible duplicates |
| Повернення / обмін | Return / exchange |
| Виручка | Revenue |
| Середній чек | Average order value |

## 4. Structure you will see

Every page has its own block with `title` and `breadcrumb` first, e.g.

```json
{
	"orders": {
		"statuses": {
			"title": "Order statuses",
			"breadcrumb": {
				"home": "Home",
				"orders": "Orders",
				"current": "Order statuses"
			},
			...
		}
	}
}
```

Blocks named `t` contain page texts with transliterated keys (`"vydalyty": "Видалити"` → `"vydalyty": "Delete"`). Translate values, keep keys.

Blocks `errors`, `server`, `notify`, `providers` are server messages (API errors, notifications, SMS provider responses) — translate them like UI messages.

## 5. Order of work and checks

Work file by file. After each file check:

1. The en file parses as JSON.
2. The set of keys (all nested paths) is identical to the uk file — no missing, no extra.
3. Every placeholder present in a uk value is present in the en value (`{{...}}`, `{...}`, `%...`).
4. No Cyrillic left, except `orders.print.words.*`.
5. No `'` or `"` inside values (use `’` and `“ ”`).

A quick checker (Node.js), run from the project root:

```js
// node check-en.js
const fs = require("fs"), path = require("path");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".json") ? [path.join(d, e.name)] : []));
const flat = (o, p = "", r = {}) => { for (const [k, v] of Object.entries(o)) (v && typeof v === "object" ? flat(v, p + k + ".", r) : (r[p + k] = String(v))); return r; };
const ph = (s) => (s.match(/\{\{\w+\}\}|\{\w+\}|%\w/g) || []).sort().join(",");
let bad = 0;
for (const uf of walk("locales/uk")) {
  const rel = path.relative("locales/uk", uf).replace(/^uk\.json$/, "en.json");
  const ef = path.join("locales/en", rel);
  if (!fs.existsSync(ef)) { console.log("MISSING FILE", ef); bad++; continue; }
  let u, e;
  try { u = flat(JSON.parse(fs.readFileSync(uf, "utf8"))); e = flat(JSON.parse(fs.readFileSync(ef, "utf8"))); } catch (x) { console.log("BAD JSON", ef, x.message); bad++; continue; }
  for (const k of Object.keys(u)) {
    if (!(k in e)) { console.log("MISSING KEY", ef, k); bad++; continue; }
    if (ph(u[k]) !== ph(e[k])) { console.log("PLACEHOLDER", ef, k); bad++; }
    if (/[Ѐ-ӿ]/.test(e[k]) && !k.startsWith("orders.print.words")) { console.log("CYRILLIC", ef, k); bad++; }
    if (/['"]/.test(e[k])) { console.log("QUOTE", ef, k); bad++; }
  }
  for (const k of Object.keys(e)) if (!(k in u)) { console.log("EXTRA KEY", ef, k); bad++; }
}
console.log(bad ? bad + " problems" : "OK");
```

Deliver the files with their full path from the project root (`locales/en/...`), one complete file each.