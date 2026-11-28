<div align="center">
<a href="https://u24.gov.ua/" target="_blank">
  <img src="https://skyneuron.com/united24.svg" alt="UNITED24"/>
</a>
<hr>
<img src="assets/images/logo/logo.png" alt="Growth Contour logo"/>

**An open-source, modular, real-time sales & customer engagement platform — a complete pipeline core plus much, much more.**

Built with Node.js · Express 5 · MySQL · Redis · Socket.IO

[![Node.js](https://img.shields.io/badge/Node.js-≥20.12-339933?style=flat-square&logo=node.js&logoColor=white)](#-requirements)
[![Express 5](https://img.shields.io/badge/Express-5.2-000000?style=flat-square&logo=express&logoColor=white)](#-tech-stack)
[![MySQL 8](https://img.shields.io/badge/MySQL-8.x-4479A1?style=flat-square&logo=mysql&logoColor=white)](#-requirements)
[![Redis + BullMQ](https://img.shields.io/badge/Redis%20%2B%20BullMQ-queues-DC382D?style=flat-square&logo=redis&logoColor=white)](#-background-jobs--cron-tasks)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-realtime-010101?style=flat-square&logo=socketdotio&logoColor=white)](#-realtime-engine-socketio)
[![Languages](https://img.shields.io/badge/UI%20locales-12-blueviolet?style=flat-square)](#-internationalization)
[![Dependencies](https://img.shields.io/badge/dependencies-45-informational?style=flat-square)](package.json)
[![code style: commonjs](https://img.shields.io/badge/code_style-CommonJS-lightgrey?style=flat-square)](#-development-guide)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](#-contributing)

</div>

---

## 📖 Table of Contents

- [At a Glance](#-at-a-glance)
- [Overview](#-overview)
- [Why Growth Contour?](#-why-growth-contour)
- [Key Features](#-key-features)
- [Tech Stack](#-tech-stack)
- [Architecture](#-architecture)
- [Project Structure](#-project-structure)
- [Modules](#-modules-plugin-system)
- [Requirements](#-requirements)
- [Installation & Quick Start](#-installation--quick-start)
- [Configuration (.env reference)](#-configuration-env-reference)
- [Database](#-database)
- [API Surface Overview](#-api-surface-overview)
- [Shop Integrations](#-shop-integrations)
- [Real-Time Engine (Socket.IO)](#-real-time-engine-socketio)
- [Background Jobs & Cron Tasks](#-background-jobs--cron-tasks)
- [Security Model](#-security-model)
- [Internationalization](#-internationalization)
- [Deployment](#-deployment)
- [Upgrading](#-upgrading)
- [Development Guide](#-development-guide)
- [Troubleshooting](#-troubleshooting)
- [FAQ](#-faq)
- [Roadmap](#-roadmap)
- [Contributing](#-contributing)
- [Code of Conduct](#-code-of-conduct)
- [Acknowledgments](#-acknowledgments)
- [License](#-license)

---

## 📊 At a Glance

| | |
|---|---|
| 💾 **Runtime** | Node.js ≥ 20.12 (22 LTS recommended) · Express 5 · CommonJS |
| 🗄 **Data layer** | MySQL 8 (`mysql2` connection pool, configurable table prefix) |
| ⚙️ **Queues & cache** | Redis + BullMQ (inbox / outbox / cart / attachment / report workers) |
| 🔌 **Live updates** | Socket.IO (agent workspace, chat widget, notifications) |
| 🧩 **Extensibility** | Drop-in module system with lifecycle hooks & hot-reload (Telegram Shop, product feeds, currency rates shipped) |
| 🌍 **Locales** | 12 languages, English as the base locale, Ukrainian maintained first-hand |
| 🔐 **Auth** | JWT + refresh tokens, TOTP 2FA, RBAC permission matrix |
| 🛡 **Hardening** | helmet CSP, layered rate limiting, encrypted secrets, webhook signatures |
| 📮 **Channels** | Telegram · Instagram Direct · Facebook Messenger · Viber · Web Chat · Email |
| 📣 **Social** | Scheduled publishing to Instagram, Facebook, Telegram & Viber channels; comment moderation; post analytics |
| 📦 **Commerce** | Orders, abandoned carts, promo codes, product catalog, multi-warehouse stock, suppliers, returns, OpenCart & PrestaShop modules, Telegram storefront |
| ⏰ **Automation** | node-cron schedulers (Europe/Kyiv) + BullMQ repeatable jobs |
| 📈 **Observability** | pino logs (app / error / http), grouped error store, request & SQL metrics, built-in System page |
| 🚀 **Installation** | Zero-touch: fill five values in `.env`, start — schema, dictionaries and the first administrator are created automatically |
| 📄 **License** | MIT — free for commercial and non-commercial use |

---

## 🌟 Overview

**Growth Contour** is a full-featured, self-hosted business platform that goes well beyond the classic pipeline-tool category. It ships a complete sales suite (leads, deals, clients, orders) and an e-commerce back office (catalog, stock, suppliers, returns), and layers on top of it an omni-channel **Contact Center** (Telegram, Instagram, Facebook Messenger, Viber, embedded Web Chat), **social media publishing and comment moderation**, **email campaigns**, **abandoned-cart recovery automation**, real-time collaboration, and a pluggable **module system** that lets you extend the platform without touching the core.

The entire backend is a single Node.js application (Express 5) rendering server-side EJS views, backed by MySQL, with Redis + BullMQ powering queues and Socket.IO delivering live updates to agents and visitors alike.

### What makes it different

- 🔌 **Extensible by design** — drop-in modules with hooks, routes, controllers, and hot-reload support.
- 💬 **True omni-channel inbox** — one conversation view for Telegram, Instagram Direct, Facebook Messenger, Viber, and your website's chat widget; messages sent straight from Instagram/Facebook show up in the same thread.
- 📣 **Social publishing built in** — plan, approve and publish posts, Reels and stories to Instagram, Facebook, Telegram and Viber channels from one editor, with per-network text, first comments, a calendar and post analytics.
- 🛒 **Cart-recovery pipeline** — token-authenticated ingestion API for external shops (CMS/marketplaces) plus scheduled Viber/SMS campaigns via SMSclub.
- 🔐 **Security-first defaults** — JWT auth, TOTP 2FA with encrypted secrets and backup codes, RBAC permissions, rate limiting, CSP/HSTS headers, encrypted-at-rest integration tokens.
- 🌍 **12 locales**, one JSON dictionary per page, English as the base locale.

---

## 🎯 Why Growth Contour?

Most open-source platforms stop at "leads and pipelines". Growth Contour was built for teams whose revenue leaks happen **outside** the sales board — in unanswered Instagram DMs, Telegram chats, and carts abandoned on the shop at 2 a.m. It ships those recovery loops as first-class features, not paid plugins:

| Challenge | How Growth Contour answers it |
|---|---|
| Messages scattered across messengers | One unified inbox: Telegram, Instagram Direct, Facebook Messenger, Viber + your website's chat widget |
| Social media handled in five different apps | Posts, approvals, a content calendar, comment replies and post analytics in one place |
| Abandoned carts silently lost | Token-authenticated ingestion API + scheduled Viber/SMS recovery campaigns (SMSclub adapter) |
| SaaS products get expensive per seat | Self-hosted, unlimited seats, MIT-licensed |
| Custom workflows don't fit anyone | Pluggable module system with hooks, routes and hot-reload — extend without forking |
| Data sovereignty matters | Your MySQL, your Redis, your server. No third-party analytics, no phone-home |
| Teams work across languages | 12 locales, one dictionary per page, English base with automatic fallback |

**Who it's for:** e-commerce operators, agencies and service businesses that want an omni-channel sales hub they fully own — and developers who want a readable, extension-friendly Node.js codebase instead of a black box.

---

## ✨ Key Features

### Sales Pipeline (Core Module)
| Area | Capabilities |
|---|---|
| **Leads** | Lead board & list views, activity history, file attachments, per-user UI settings, public lead-capture form endpoint (`POST /api/leads/add/:token/`) |
| **Deals** | Deal cards with line items, quotes, contracts, invoices, acts, tasks and activities |
| **Customers** | Customer profiles, contact lists, activity log, avatars, matching engine for inbound orders |
| **Users & Access** | User management, user groups, granular permission matrix (`checkPermission(resource, action)`), online presence list |
| **Profile** | Personal account settings and 2FA configuration |

### Orders & Integrations
- Order board with configurable statuses (CRUD on statuses, filters, list endpoints); status names per language, delivered to shops in the shop's own language.
- **Promo codes** — percentage or fixed discounts, usage limits per code and per customer, validity windows, minimum order amount, code templates and bulk issue of unique child codes from a parent code. Applied on storefronts and in manually created orders (checked against the order source, currency, products/categories and the selected customer; usage is recorded in the order transaction).
- **Shop modules** for OpenCart 2.3 / 3.0 and PrestaShop 1.7 / 8 — see [Shop Integrations](#-shop-integrations).
- **Integration registry** — manage connections to external systems (`/orders/integrations/`).
- **API tokens** — generate/revoke scoped tokens (SHA-256 hashed at rest) used by external CMS/marketplaces to push orders and carts into the platform; usage and error counters tracked per token, with domain/IP binding.

### Abandoned Cart Recovery
- Ingestion endpoints: `receive`, `recover`, `reconcile`, `close` (token-authenticated, per-endpoint rate limits).
- Event-based campaign engine (create/edit/list recovery events, run manually or on schedule).
- Dispatch center with per-cart detail views and reporting.
- Recovery links for end customers.
- Viber bulk sending through the built-in **SMSclub provider adapter** (retry-aware error mapping, lifetime clamping for single vs. bulk messages).
- Inbox/outbox/cart processors with **crash recovery on startup** — unfinished queue work is re-enqueued automatically.

### Telegram Shop (module `telegramshop`)
- A Telegram bot plus a **Mini App storefront** built directly on the platform catalog — prices, stock, variants and images come from the catalog, nothing is exported anywhere.
- Checkout inside Telegram: contact details, delivery (Nova Poshta city/warehouse lookup when the delivery module is installed), payment methods including Telegram Payments with a currency check.
- Delivery prices per method: fixed, by cart weight, carrier tariffs (paid on receipt), or **Nova Poshta calculation** (`getDocumentPrice` with the sender city of the Nova Poshta account, the buyer's city, cart weight and declared value; either shown as an estimate paid on receipt or added to the order total with the shop as payer); free-from threshold for any mode. Products without weight are counted with the account's default weight, and the shop settings warn about storefront products without weight.
- Cash on delivery: optional shop fee (fixed + % of goods) as a separate order line; the Nova Poshta money-transfer commission is shown to the buyer as an estimate.
- Orders land in the regular order board; "Write to the client" opens the conversation in the contact center in the same bot.
- Carts in the Mini App are mirrored into abandoned-cart recovery; back-in-stock subscriptions; one-tap reorder; product sharing links.
- **Broadcasts** to bot subscribers with audience filters, scheduling and delivery statistics.

### Contact Center
- Unified conversation model across channels.
- Channel management UI: create, edit, refresh, enable/disable, test-notify.
- **Telegram** bot channel (webhook-based, secret-protected URL).
- **Instagram** (Meta Graph API v21): webhook signature verification against raw body, long-lived token auto-refresh cron.
- **Viber** bot (webhook mounted at `/viber/webhook/`).
- **Web Chat widget** embeddable on any site: iframe frame (`/chat/frame.html`), config endpoint, file upload/download with signed URLs, its own service worker, and optional browser push for visitors.
- Media/attachment processing queue (BullMQ) with image handling via `sharp`.

### Social Publishing (Contact Center → Posts)
- **Accounts:** Instagram, Facebook Page, Telegram channel (bot) and Viber channel. Tokens are reused from contact-center channels or stored separately (encrypted) — e.g. a dedicated Telegram bot per channel. A permissions panel shows which Meta scopes each feature needs and which the token actually has.
- **Editor:** one shared text in a rich editor plus a **fully independent text per network** in that network's native format (Telegram HTML, plain text for Instagram/Facebook/Viber), with an exact per-network preview, character and hashtag limits (Instagram ≤ 30), templates and saved hashtag groups.
- **Formats:** posts, carousels (up to 10), Reels and stories where the network supports them; media library with JPEG normalisation (`sharp`), signed public URLs for Meta/Telegram/Viber to fetch.
- **First comment** right after publishing — Instagram, Facebook, and Telegram (reply in the channel's discussion group).
- **Approval flow:** "Send for review" → a different manager approves or returns it with a note; every action lands in an append-only post history.
- **Queue:** per-minute publisher with `SELECT … FOR UPDATE SKIP LOCKED` claiming (safe across several pm2 processes), Instagram container polling for video processing, retry with back-off for transient errors.
- **Calendar** (month / week / list) with drag-and-drop rescheduling, **post analytics** (likes, comments, shares, saves, reach, views, ER) and a **best-time heat map** per account.

### Comments (Contact Center → Comments)
- Comments under Instagram and Facebook posts arrive via webhooks (`comments`, `feed`) and a 30-minute sync safety net.
- Reply publicly, reply privately in Direct/Messenger (once, within 7 days — enforced), hide/unhide, delete, mark as handled; replies shown as threads with the post preview.

### Catalog, Stock & Suppliers
- Products with variants, options, attributes, bundles, downloadable files, multi-language SEO, image maintenance and a data-quality score.
- Multi-warehouse stock, stock documents and movements, reservations with auto-expiry, reorder points and suppliers, stock reports.
- Two-way sync with connected shops (OpenCart module), site import, product reviews sync, price rules and currency-rate providers, low-stock and price alerts.

### Clients
- Unified client cards linked to orders, leads, deals and chat contacts; duplicate detection and merge; CSV import; nightly **RFM** segmentation; automatic tasks (lead without reaction, repeat purchase, lost client).

### Mailing
- Email campaigns with a template editor, contact lists and import, automations, unsubscribe/tracking links (signed), per-campaign reports, IMAP processing and a background sending worker.

### Reports & Audit
- Background report generation (XLSX) with a job queue and retention; analytics cache with pre-aggregated statistics.
- Audit log of user actions, a trash bin with scheduled purge, saved filters, shared dictionaries.

### System (Settings → System)
- Live server, database, queue and job status; grouped error list (mark resolved / ignored / delete); log viewer with download; request and SQL performance metrics, slow-query log and per-request trace.

### Notifications
- Multi-channel dispatch: **in-app**, **email (SMTP)**, **Telegram**, **Web Push (VAPID)**.
- Queue-backed delivery workers (BullMQ + Redis).
- Calendar reminders: minute-by-minute tick cron + daily queue cleanup.
- Notification center API (list, mark seen, delete).

### Real-Time & Productivity
- Socket.IO server: room join/leave, heartbeat, online/offline presence.
- Dashboard with **calendar/scheduler** (events CRUD, reschedule, respond, hide, pending counts).
- **Analytics module**: summary KPIs, time series, status breakdown, channel breakdown, top products, conversion funnel, abandoned-cart stats, integration health — with pre-aggregated statistics rebuilt hourly (7-day window) and nightly (45-day backfill).

### Platform
- Module/plugin system with lifecycle API and template hooks.
- i18n with 12 locales, one dictionary per page, English fallback and automatic language negotiation.
- Invite links and password-reset links with configurable TTL.
- Zero-touch installation and start-up checks (`ensure-env.js`): `.env` template with placeholders, generated secrets and table prefix, MySQL checks, automatic schema install and first administrator, quiet console after start.

---

## 🧱 Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 20.12 (uses `process.loadEnvFile`); 22 LTS recommended |
| Web framework | Express 5 |
| Views | EJS (+ `html-minifier` for production output) |
| Database | MySQL 8.0+ (`mysql2` promise pool, connection diagnostics); MariaDB is not supported |
| Cache / Queues | Redis (`ioredis`, `node-cache`) + **BullMQ** workers |
| Realtime | Socket.IO 4 |
| Auth | JWT (access + refresh), bcrypt password hashing, TOTP 2FA (`otplib`/`otpauth`, QR via `qrcode`) |
| Security middleware | `helmet` (CSP, HSTS…), `cors` allow-list, `express-rate-limit`, cookie-parser, `express-session` |
| Messaging integrations | `node-telegram-bot-api`, `viber-bot`, Meta Graph API (Instagram Login, Facebook Pages, Messenger), Viber Channels Post API, SMSclub (Viber/SMS), SMTP via `nodemailer`, IMAP via `imapflow` |
| Rich text | `sanitize-html` (server-side whitelist for post HTML), custom contenteditable editor |
| Spreadsheets | `exceljs` (reports, imports) |
| Push notifications | `web-push` (VAPID keys) |
| Validation | `ajv` + `ajv-formats`, `validator`, `jsonschema`, `libphonenumber-js` (phone normalization) |
| Files | `multer` uploads, `file-type` sniffing, `sharp` image processing, `mime` |
| Scheduling | `node-cron` (Europe/Kyiv timezone) |
| Logging | `pino` with daily files per category (`app`, `error`, `http`), console capture, grouped error store, metrics |
| HTTP client | `axios` |
| Config | `config` package with env-driven defaults; `.env` bootstrap and installer in `ensure-env.js` |
| Process manager | pm2 (fork or cluster mode) or systemd |

---

## 🏗 Architecture

```
                       ┌───────────────────────────────────────────┐
   Browser (EJS UI)    │              server.js                    │
   Chat widget         │  ┌─────────────────────────────────────┐  │
   External CMS/API    │  │ Middleware chain                    │  │
        │              │  │ helmet → cors → sessions → i18n →  │  │
        ▼              │  │ module hooks → auth → routers      │  │
 ┌──────────────┐      │  └─────────────────────────────────────┘  │
 │  Nginx /     ├──────┤                                           │
 │  Cloudflare  │      │  Routes ──► Controllers ──► MySQL (pool)  │
 └──────────────┘      │        │                                  │
                       │        ├──► Socket.IO (presence, realtime)│
                       │        ├──► BullMQ queues ◄── Redis       │
                       │        ├──► Cron (analytics, reminders,   │
                       │        │        IG token refresh)         │
                       │        └──► ModuleManager (/modules/*)    │
                       └───────────────────────────────────────────┘
```

Request flow highlights:

1. **`ensure-env.js`** runs before anything else (first line of `server.js`) — creates/patches `.env`, checks MySQL, installs `database.sql` and the first administrator on a fresh database, then loads `.env` via `process.loadEnvFile`.
2. **`config/config.js`** exposes typed config blocks (`configServer`, `configDatabase`, `configJWT`, `configTFA`, `configMail`, …) and hard-fails at boot if any required secret is missing.
3. **ModuleManager** registers a synchronous hooks middleware (so `res.locals.hook()` works in every template), then asynchronously loads and auto-enables all modules from `/modules`.
4. Route groups are mounted per domain (authorization first, then protected app routes), followed by JSON/HTML-aware error and 404 handlers.
5. On listen, the server **recovers persisted order/cart queues** and schedules all cron jobs.

### 🔄 Abandoned-cart lifecycle

The recovery pipeline is the heart of the orders module. External shops push cart events into Growth Contour, which turns them into campaigns and messages:

```
External shop / CMS                    Growth Contour
      │                                       │
      │  POST /api/orders/abandoned-cart/     │
      │      receive ────────────────────────►│ ① token check (SHA-256 hash,
      │  (cart snapshot + customer contact)   │    domain/IP binding) + rate limit
      │                                       │ ② event stored → BullMQ cart-inbox queue
      │                                       │
      │                            campaign   │ ③ scheduled/manual event run matches the
      │                           engine ────►│    cart to recovery rules & templates
      │                                       │
      │        Viber / SMS message            │ ④ dispatch via SMSclub provider adapter
      │  customer ◄──── with recovery link ───│    (retry-aware, lifetime clamping)
      │                                       │
      │  POST …/recover (link clicked) ──────►│ ⑤ status → recovered
      │  POST …/reconcile (order completed) ─►│ ⑥ revenue attributed to the campaign
      │  POST …/close (campaign ended) ──────►│ ⑦ cart closed; reports updated
      ▼                                       ▼
   Analytics: conversion funnel, recovery rate, integration health
```

Every stage is observable: per-token usage/error counters, dispatch center with per-cart detail views, and dedicated abandoned-cart logging (`logging/abandoned-cart-logger.js`).

---

## 📂 Project Structure

```
.
├── server.js               # App bootstrap: middleware, routes, cron, startup
├── ensure-env.js           # start: .env (secrets, prefix), MySQL check, database install, first administrator
├── package.json
├── config/
│   ├── config.js           # Central config (env-driven defaults + validation)
│   ├── database/           # MySQL promise pool (TCP or unix socket) + diagnostics
│   ├── redis/              # Redis connector
│   ├── i18n/               # i18n setup, deep-merge locale loader
│   ├── mail/               # Mail templates config
│   └── notifications/      # Notification channel config
├── core/
│   └── modules/            # ModuleManager: load/enable/disable/hot-reload, hook registry
├── modules/                # Pluggable modules (see Modules section)
│   └── exampleModule/      # Reference implementation
├── routes/                 # Express routers, grouped by feature
│   ├── administrator/      #   login/logout, TFA, admin leads
│   ├── analytics/          #   dashboard analytics APIs
│   ├── catalog/            #   brands
│   ├── clients/            #   clients directory
│   ├── contact-center/     #   channels, webhooks (TG/IG/FB), web-chat, viber,
│   │   └── social/         #   posts, accounts, calendar, templates, stats, media
│   ├── common/             #   audit log, trash, saved filters, dictionaries
│   ├── mailing/            #   campaigns, templates, contacts, public unsubscribe
│   ├── reports/            #   background reports
│   ├── customers/          #   customer CRUD APIs
│   ├── deals/              #   deals + items/quotes/contracts/invoices/acts/tasks
│   ├── index/              #   dashboard, calendar/scheduler APIs
│   ├── leads/              #   leads, activities, files, UI settings, public capture
│   ├── modules/            #   module lifecycle REST API
│   ├── notifications/      #   notification center
│   ├── orders/             #   orders, statuses, tokens, integrations, receiver,
│   │   └── abandoned-cart/ #   carts, events, services, dispatch, reports, recover links
│   ├── profile/            #   user profile
│   ├── settings/           #   integrations, API tokens, system monitor
│   └── users/              #   users, groups, permission matrix, online list
├── controllers/            # Business logic
│   ├── authorization/      #   auth flows, TFA settings
│   ├── contact-center/     #   conversations, channels (telegram/instagram/facebook/webchat),
│   │   │                   #   comments, uploads, files, realtime, IG token refresh, attachments queue
│   │   └── social/         #   publisher queue, network adapters (instagram/facebook/telegram/viber),
│   │                       #   format (HTML → network), first comment, approvals log, stats, snippets
│   ├── catalog/products/   #   catalog, stock, pricing, sync, imports, reviews, alerts
│   ├── clients/            #   client cards, matching, duplicates, RFM
│   ├── mailing/            #   campaigns, rendering, sending worker, IMAP events
│   ├── automation/         #   auto-tasks
│   ├── common/             #   audit, trash, system monitor
│   ├── mail/               #   SMTP sender
│   ├── notifications/      #   dispatcher, channels (email/inapp/telegram/webpush),
│   │                       #   BullMQ queue + worker, recipients, redis bridge
│   ├── orders/             #   inbox/outbox/cart processors, scheduler, poller,
│   │   └── providers/      #   SMSclub adapter
│   └── socket/             #   Socket.IO setup, presence, rooms
├── middlewares/            # CORS allow-list, language negotiation, rate limiters
├── validator/              # JSON schemas (AJV/jsonschema) per entity
├── helpers/                # crypto (token encryption), TFA helpers, webpush
├── utils/                  # email utilities
├── logging/                # pino logger + feature-specific loggers
├── cron/                   # analytics rebuild, media processing, calendar reminders
├── locales/                # 12 locale folders, one JSON file per page
├── views/                  # EJS: pages/, partials/, emails/templates/
├── assets/                 # css/js/images/mp3, sw-push.js (service worker),
│   └── contact-center/     #   chat attachments and the social media library (generated)
└── public/uploads/         # Contact-center attachments (served sandboxed at /uploads)
```

---

## 🔌 Modules (Plugin System)

The platform ships with a lightweight extension framework in `core/modules/`. Any folder inside `/modules` that contains a `module.json` is treated as a module.

**Integrity check on load.** Before a module is required, the manager verifies that `module.json` belongs to this folder (`"name"` equals the folder name), that `index.js` exists and that every relative `require()` in the module's files points to an existing file. A file copied into the wrong module, or a module copied only partly, is reported with the file, the line and the missing path (`Module novaposhta is incomplete or contains files of another module: … index.js:23 requires "./controllers/shops" — not found`) and the module is skipped — the rest of the system starts normally.

### Anatomy of a module

```
modules/exampleModule/
├── module.json             # manifest: name, version, description, author, config
├── index.js                # entry point: class extending BaseModule
└── controllers/…           # module business logic
```

`module.json` example:

```json
{
  "name": "exampleModule",
  "version": "1.0.0",
  "description": "Example module demonstrating the module system",
  "author": "Your Name",
  "hasConfig": true,
  "config": { "setting1": "value1", "setting2": "value2" }
}
```

### Writing a module — 60-second tour

A module is a class that extends `BaseModule` (`core/modules/modules.js`). In the constructor you register **hooks** (content injected into core pages) and **routes** (REST endpoints):

```js
const BaseModule = require('../../core/modules/modules');

class ExampleModule extends BaseModule {
    constructor(config) {
        super(config);
        this._registerHooks();
        this._registerRoutes();
    }

    _registerHooks() {
        // Inject an HTML banner at the top of the orders page
        this.registerHook('displayOrderTop', () => `<h3>📦 ${this.config.version}</h3>`);
        // Inject CSS into <head>, JS before </body>
        this.registerHook('displayHeader', () => `<style>.x { color: green }</style>`);
        this.registerHook('displayFooter', () => `<script>console.log('hi')</script>`);
    }

    _registerRoutes() {
        this.registerRoute({
            method: 'GET',
            path: '/status',                       // → GET /api/module/exampleModule/status
            handler: async (req, res) => res.json({ ok: true }),
        });
    }

    async install()   { /* create tables, seed settings… */ return super.install(); }
    async uninstall() { /* drop tables… */                 return super.uninstall(); }
    async enable()    { return super.enable(); }
    async disable()   { return super.disable(); }
}

module.exports = ExampleModule;
```

Key mechanics:

- **Route namespacing** — every registered route is mounted under `/api/module/<moduleName><path>`, so modules can never collide with core routes or each other.
- **Safe dispatch** — handlers are wrapped in try/catch and automatically return `403` if the module has been disabled at runtime; a throwing module cannot crash the request pipeline.
- **Lifecycle overrides** — `install()` / `uninstall()` are the right place for schema migrations; `enable()` / `disable()` for runtime wiring. The base class tracks status and persists it.

### Module lifecycle API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/modules/` | List installed modules with status |
| `GET` | `/api/modules/:name` | Module details |
| `POST` | `/api/modules/:name/install` | Install |
| `POST` | `/api/modules/:name/enable` | Enable (registers routes & hooks) |
| `POST` | `/api/modules/:name/disable` | Disable (un-registers its hooks/routes) |
| `POST` | `/api/modules/:name/reload` | **Hot reload without restarting the server** |
| `POST` | `/api/modules/:name/uninstall` | Uninstall |

### Template hooks

`ModuleManager.hooksMiddleware()` injects a `hook(name, params)` helper into `res.locals`, so EJS templates expose named attachment points (`displayHeader`, `displayOrderTop`, `displayFooter`, …) that any enabled module can fill — enabling UI extension without editing core views. Hook callbacks run sequentially per hook name; a failing callback is logged and skipped, never rendered as an error page.

> Modules load asynchronously at startup; a failing module never brings down the core.

### Shipped modules

| Module | What it does |
|---|---|
| `telegramshop` | Telegram bot + Mini App storefront on the platform catalog, checkout, orders into the order board, broadcasts |
| `feeds` | Product feeds generated from the catalog: Google Merchant Center, Prom.ua (YML) |
| `currencyRates` | Exchange-rate providers for the currency dictionary: National Bank of Ukraine, PrivatBank (cash and card), Monobank |
| `exampleModule` | Reference implementation of hooks, routes and lifecycle |

Delivery and payment modules (for example Nova Poshta and Monobank acquiring with monobank "Pay in parts" installments: applications from the order card, signed callbacks, store confirmation of hand-over, scheduled state polling) are distributed separately: copy the module folder into `modules/` and restart — a module that is new to the system is installed and enabled automatically.

---

## 📋 Requirements

- **Node.js ≥ 20.12** (the app uses `process.loadEnvFile`; earlier versions will not start). Node.js 22 LTS is recommended.
- **MySQL 8.0 or newer** with an **empty database** in `utf8mb4` and a user with full privileges on it. MariaDB is not supported — the installer refuses to run on it.
- **Redis** (default `127.0.0.1:6379`) — required for BullMQ queues, notification workers, caching
- **pm2** (`npm i -g pm2`) or systemd to keep the process running
- A reverse proxy (**Nginx/Cloudflare**) for TLS termination in production
- Outbound HTTPS access for Telegram / Instagram / Viber / SMSclub APIs (as needed)

---

## 🚀 Installation & Quick Start

Installation is **zero-touch**: you never import SQL by hand and never create the first user yourself. You fill five values in `.env`, start the system, and it does the rest.

```bash
# 1. Clone and install dependencies
git clone https://github.com/<your-org>/growth-contour.git
cd growth-contour
npm ci            # or: npm install

# 2. Create an EMPTY MySQL 8 database and a user with full privileges on it
mysql -u root -p <<'SQL'
CREATE DATABASE growth_contour CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'gc'@'localhost' IDENTIFIED BY 'a-strong-password';
GRANT ALL PRIVILEGES ON growth_contour.* TO 'gc'@'localhost';
SQL

# 3. Start once — the system creates .env and stops
pm2 start server.js --name growthcontour --stop-exit-codes 78
```

Console output of the first start:

```
Growth Contour

✔ .env created · secrets generated, table prefix k4m9x2qa_
! Replace every __REQUIRED__ value in .env, then start the system again:
  APP_URL, DB_USER, DB_PASSWORD, DB_NAME, ADMIN_EMAIL
```

```bash
# 4. Replace every __REQUIRED__ placeholder in .env
nano .env
#   APP_URL=https://crm.example.com
#   DB_USER=gc
#   DB_PASSWORD=a-strong-password
#   DB_NAME=growth_contour
#   ADMIN_EMAIL=admin@example.com

# 5. Start again — the database is installed and the administrator is created
pm2 restart growthcontour
pm2 logs growthcontour --lines 30
```

```
Growth Contour

✔ Configuration · .env                         3 ms
✔ MySQL 8.0.46 · growth_contour                41 ms
✔ Database installed · 523 tables              6.8 s
✔ Administrator · admin@example.com
  Password: 8JSQTefeRZ4WFBHHJ3Ju
  Save this password and change it after the first sign-in — it is not shown again.
✔ Access gate · the browser asks for it before the sign-in page
  Login: g3f9a1c   Password: q7Hk2mPz…   (GATE_USERS in .env)
✔ Modules · 4

System is up and running · https://crm.example.com · port 3000 · production · 9.4 s
```

6. Open `APP_URL` (or `http://localhost:3000/login/`), sign in with `ADMIN_EMAIL` and the printed password, then change the password in **Profile**.
7. Save the process list so pm2 restores it after a reboot: `pm2 save && pm2 startup`.

Every later start prints the same steps without the installation lines, and then the console stays quiet — only errors are printed, everything else goes to `logs/`.

> 💡 Without pm2: `node server.js` or `npm start` behave exactly the same. `--stop-exit-codes 78` only tells pm2 not to restart the process in a loop while the configuration is incomplete.

### 🧭 What happens on every start

`ensure-env.js` is the first line of `server.js`. It runs on **every** start, in this order, and decides on its own whether this is a fresh installation or a normal start:

| # | Check | Result |
|---|---|---|
| 1 | `.env` does not exist | Created atomically (temporary file + hard link, mode `0600`) from the built-in template. Secrets, the VAPID key pair and `DB_PREFIX` are generated; values you must provide are set to `__REQUIRED__`. The list of those keys is printed and the process exits with code **78**. |
| 2 | `.env` exists, new keys were introduced by an upgrade | Only the missing keys are appended (secrets are generated), under a lock file (`.env.lock`) so parallel pm2 processes never append twice. **Existing values are never changed.** |
| 3 | `__REQUIRED__` is still present (except `ADMIN_EMAIL`, see 7) | The missing keys are listed; exit code **78**. |
| 4 | MySQL connection | Access denied, unknown database or unknown host → explanation and exit code **78**. MySQL not reachable yet (connection refused / timeout, e.g. during a server reboot) → exit code **1**, so the process manager retries. |
| 5 | MySQL version | MySQL 8.0+ is required; older versions and MariaDB → exit code **78**. |
| 6 | Tables with `DB_PREFIX` exist and at least one user exists | The system is installed — the schema is checked (see below), then normal start. |
| 7 | No tables with `DB_PREFIX` | **Installation:** `ADMIN_EMAIL` must be set and valid; `database.sql` is executed with the table prefix replaced; the first administrator is created in the **Administrator** group (id `1`) with a generated 20-character password (bcrypt, cost 12), printed once. |
| 8 | Tables exist but there are no users | **Schema imported manually:** if every table of `database.sql` and the dictionaries (languages, user groups, permission pages) are present, only the first administrator is created. If tables or dictionaries are missing (an interrupted import), nothing is overwritten or dropped: drop the tables with that prefix and start again; exit code **78**. |

**Schema check.** On every start of an installed system (and after a manual import) the database is compared with `database.sql`: every table, every column (type, `NULL` / `NOT NULL`, default), every index and every foreign key. Extra objects in the database — tables of modules, your own columns — are not errors.

| Difference | `SCHEMA_CHECK=strict` (default) | `warn` | `off` |
|---|---|---|---|
| Missing table, column, index or foreign key; wrong column type; wrong `NULL` / `NOT NULL` | stop, exit code **78** | reported, start | not checked |
| Different default, index columns or uniqueness, foreign-key target | reported, start | reported, start | not checked |

The console shows the first differences; the full list is written to `logs/schema-check.log`. The check reads `information_schema` with three queries and takes well under a second on a full schema.

```
✖ Schema · 3 differences from database.sql
  column gc_users.phone is missing
  column gc_orders.total: type decimal(10,2), expected decimal(15,4)
  index gc_orders.idx_status is missing
  Full report: /opt/growth-contour/logs/schema-check.log
  Apply the release migration (see README → Upgrading) or fix the listed objects
  SCHEMA_CHECK=warn in .env starts the system anyway
```

Then the regular boot continues: configuration, Redis, modules, routes, schedulers, HTTP server. The last line, `System is up and running`, is printed once the HTTP server listens and all modules are loaded.

**Safety guarantees**

- The database part runs in a short-lived child process (`node ensure-env.js --db`), so `server.js` stays strictly sequential: nothing touches the database before it is ready.
- Installation runs under a MySQL named lock (`GET_LOCK`), so in pm2 cluster mode exactly one process installs and the others wait and then see an installed database.
- The table prefix is replaced **only in identifiers inside backticks** (`` `prefix_ ``), never in data.
- The prefix in `database.sql` is read from its header line `table prefix: …` (`prefix_` if absent).
- The administrator password is never written to `.env` or to the log files.
- In pm2 cluster mode the start-up steps are printed by instance `0` only; errors are printed by every instance.

### 🚦 Exit codes

| Code | Meaning | What to do |
|---|---|---|
| `0` | Normal shutdown (`SIGINT` / `SIGTERM`) | — |
| `1` | Runtime error or a temporary problem (MySQL not reachable yet, uncaught exception) | The process manager restarts the process; check `pm2 logs` / `logs/error` |
| `78` | Configuration error (`EX_CONFIG`): `.env` incomplete, MySQL access denied, unknown database, unsupported MySQL, interrupted installation | Fix the cause shown in the console, then `pm2 restart growthcontour`. pm2 with `--stop-exit-codes 78` and systemd with `RestartPreventExitStatus=78` wait instead of restarting in a loop |

### 🔐 Access gate

A second login/password that the browser asks for **before** the sign-in page — like an `.htpasswd` in front of the system. Bots and password guessing never reach the sign-in form.

- Generated on installation: `GATE_ENABLED=true` and one access in `GATE_USERS` (`login:password`), printed once next to the administrator password and kept in `.env`.
- More accesses: `GATE_USERS=login1:password1,login2:password2`, then restart. Removing an access or changing a password signs that browser out of the gate.
- What it covers: the sign-in page, 2FA, sign-out, invitations, email confirmation and every page or API that needs an employee session.
- What it never covers: shop APIs (`/api/orders/receive/` …), webhooks (Telegram, Meta, Viber, payments), the website chat widget, the Telegram storefront, mailing links, abandoned-cart recovery links and token downloads — they work without it.
- After the browser passes the gate once, a signed `HttpOnly` cookie (`gc_gate`, 30 days) keeps AJAX, file downloads and Socket.IO working without repeating the prompt.
- Existing installations: when the keys are appended on upgrade, the gate is added **switched off** (`GATE_ENABLED=false`) so a running system is not locked unexpectedly; switch it on in `.env` and restart.

### 📄 The `.env` file

- **Never commit `.env`.** It holds the secrets that sign sessions and encrypt 2FA secrets and integration tokens; anyone with it can forge sessions or decrypt tokens. `.env` must be listed in `.gitignore`.
- The repository ships **`.env.example`** — the same template the installer writes, with placeholders and defaults but without secrets. You may copy it to `.env` and fill it in before the first start; missing secrets and the prefix are then generated and appended automatically.
- Values you provide: `APP_URL`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `ADMIN_EMAIL` (and `DB_HOST` / `DB_PORT` if MySQL is not on `127.0.0.1:3306`). Everything else has working defaults.
- `DB_PASSWORD` may be intentionally empty (for example unix-socket authentication): remove the placeholder and leave the value empty.
- `ADMIN_EMAIL` is used **only for installation**; on an installed system it is not checked, so it does not block existing instances after an upgrade.
- Values are read with `process.loadEnvFile`; variables already set in the process environment take precedence.
- Back up `.env` together with the database: losing the generated secrets logs everyone out, breaks 2FA and makes encrypted tokens unreadable.

### 🐳 Alternative: bring up the data tier with Docker

If you don't have MySQL/Redis installed locally yet, this one-liner starts both (the app itself still runs with `npm start`):

```bash
docker run -d --name gc-mysql -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=growth_contour mysql:8

docker run -d --name gc-redis -p 6379:6379 redis:7 --save 60 1

# then point .env at them:
#   DB_HOST=127.0.0.1  DB_PORT=3306  DB_USER=root  DB_PASSWORD=root  DB_NAME=growth_contour
```

Then start the system as described above — the empty `growth_contour` database is installed automatically on the first start.

For development, `nodemon` is available as a dependency:

```bash
npx nodemon server.js
```

### ✅ Verify your installation

```bash
curl -I http://localhost:3000/login/        # → HTTP 200
node -e "process.loadEnvFile(); console.log('env OK')"   # .env parses cleanly
redis-cli ping                              # → PONG (queue backend alive)
mysql -u"$DB_USER" -p -e "SHOW TABLES LIKE '<DB_PREFIX>%';"  # schema installed
```

If all four checks pass, log in at `http://localhost:3000/login/` and you're ready to go.

---

## ⚙️ Configuration (.env reference)

All runtime configuration lives in `.env` (auto-created by `ensure-env.js`; template: `.env.example`). Existing values are **never overwritten** — missing fields are appended on next run. Keys marked **required** are created as `__REQUIRED__` and must be filled before the system starts.

### 🔑 System secrets (auto-generated — do not touch)

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Access-JWT signing key. Changing it logs everyone out. |
| `JWT_REFRESH_SECRET` | Refresh-JWT signing key (separate from access). |
| `TFA_ENC_KEY` | AES encryption of 2FA secrets stored in DB (32 bytes hex). |
| `APP_ENCRYPTION_KEY` | Encryption of integration/channel tokens at rest. |
| `WEBCHAT_FILE_SECRET` | Signing of web-chat attachment download links. |
| `SESSION_SECRET` | `express-session` server session signing. |
| `TELEGRAM_TOKEN_KEY` | Key for encrypting Telegram bot tokens entered in the admin panel. |

> ⚠️ Losing these keys means: all sessions invalidated, 2FA broken, and encrypted tokens unreadable. Back up `.env` securely.

### 🖥 Server

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `production` | `production` enables secure cookies; `development` shows error details |
| `PORT` | `3000` | HTTP listen port |
| `APP_URL` | **required** | Public HTTPS URL of the system (links in notifications, webhooks, media for social networks) |
| `CORS_ORIGINS` | — | Comma-separated allow-list of CORS origins |

### 🔑 JWT & 2FA tuning (optional)

| Variable | Default | Description |
|---|---|---|
| `JWT_EXPIRES` | `7d` | Config-level access-token lifetime (the login flow issues a 24 h access token) |
| `JWT_EXPIRES_REMEMBER` | `30d` | Access-token lifetime when "remember me" is checked |
| `JWT_COOKIE_EXPIRING` | `90` | Cookie expiry window in days |
| `TFA_ISSUER` | `Growth contour` | Issuer name shown in authenticator apps / QR provisioning URI |
| `TFA_STEP` | `30` | TOTP time step in seconds (RFC 6238) |
| `TFA_WINDOW` | `1` | Allowed verification window (± steps) |
| `TFA_BACKUP_COUNT` | `10` | Number of one-time backup codes generated per enrollment |

### 🗄 Database

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | `127.0.0.1` | MySQL host — a path starting with `/` is treated as a **unix socket** |
| `DB_PORT` | `3306` | MySQL port (ignored for socket connections) |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | **required** | Credentials of an empty MySQL 8 database (`DB_PASSWORD` may be left empty for socket authentication) |
| `DB_PREFIX` | generated (`k4m9x2qa_`) | Table name prefix used across all queries. Do not change after installation |
| `SCHEMA_CHECK` | `strict` | Schema check against `database.sql` on every start: `strict` stops on missing objects or wrong column types, `warn` only reports, `off` skips |

### 🔐 Access gate

| Variable | Default | Description |
|---|---|---|
| `GATE_ENABLED` | `true` (new install), `false` (added on upgrade) | Ask for an extra login/password before the sign-in page |
| `GATE_USERS` | generated | Accesses `login:password`, comma-separated |

### 👤 Administrator

| Variable | Default | Description |
|---|---|---|
| `ADMIN_EMAIL` | — (required for installation) | First administrator, created on installation in the Administrator group with the language `id = 1` (like every new user); the generated password is printed once |

### 🔗 Access / invitations

| Variable | Default | Description |
|---|---|---|
| `INVITE_TTL_HOURS` | `72` | Invitation link lifetime |
| `RESET_TTL_MINUTES` | `30` | Password-reset link lifetime |

### 🧠 Redis & notification engine

| Variable | Default | Description |
|---|---|---|
| `NOTIFY_DRIVER` | `sync` | `sync` = MySQL-backed inline delivery (works anywhere, no Redis needed); `bull` = BullMQ workers over Redis (recommended at scale) |
| `REDIS_HOST` / `REDIS_PORT` | `127.0.0.1` / `6379` | Redis endpoint used by the BullMQ notification driver |
| `REDIS_PASSWORD` | — | Auth password (omit if none) |
| `REDIS_DB` | `0` | Redis logical database index |
| `NOTIFY_FANOUT_THRESHOLD` | `5000` | Recipient count above which fan-out is deferred/batched |
| `NOTIFY_OUTBOX_POLL_MS` | `15000` | Outbox fallback poller interval (events that missed the queue) |
| `MAIL_RATE_MAX` | `10` | Max e-mails per second through the SMTP sender |
| `WEBPUSH_RATE_MAX` | `100` | Max web-push messages per second |

> Notification retries: 5 attempts with exponential backoff starting at 3 s. Per-channel API limits are built in (Telegram is capped slightly below its official ~30 msg/s).

### 🛒 Abandoned cart & order pipeline

| Variable | Default | Description |
|---|---|---|
| `ABANDONED_CART_TZ` | `Europe/Kyiv` | Business timezone for send windows & schedules |
| `ABANDONED_CART_REQUIRE_CONSENT` | `1` | Only message carts whose customer consented (`0` disables — testing only) |
| `CART_RL_MAX` | `20` | Cart ingestion requests per window, per token |
| `CART_RL_WINDOW_MS` | — | Rate-limit window for ingestion endpoints |
| `CART_RL_MAX_RECONCILE` | `60` | Separate (higher) limit for `/reconcile` callbacks |
| `RECOVER_RL_MAX` | `30` | Recovery-link click rate limit |
| `RECOVER_RL_WINDOW_MS` | — | Recovery-link rate-limit window |
| `CART_RETENTION_DAYS` | `30` | Age after which open carts expire |
| `CART_PURGE_DAYS` | `90` | Age after which closed carts are purged from DB |
| `CART_MAINT_INTERVAL_MIN` | `60` | Maintenance sweep interval (expire + purge) |
| `SERVICE_CONFIG_KEY` | — | Encryption key for per-service provider settings stored in DB |
| `RECOVERY_SITE_FALLBACK` | — | Fallback shop base URL for recovery links (per-integration `base_url` wins) |
| `ABANDONED_CART_LOG_DIR` | — | Dedicated log directory for the abandoned-cart logger |
| `ABANDONED_CART_LOG_RETENTION_DAYS` | — | Log file retention for that logger |

### 📸 Instagram (Meta App level, shared across accounts)

| Variable | Description |
|---|---|
| `IG_APP_ID`, `IG_APP_SECRET` | Meta App credentials |
| `IG_REDIRECT_URI` | OAuth redirect URI |
| `IG_VERIFY_TOKEN` | Webhook verify token |
| `IG_GRAPH_VERSION` | Graph API version (default `v21.0`) |
| `IG_PUBLIC_BASE` | Public base URL for proxied IG media |

### ✉️ Mail (SMTP)

| Variable | Default | Description |
|---|---|---|
| `MAIL_HOST` | — | e.g. `smtp.gmail.com` |
| `MAIL_PORT` | `587` | `587` (STARTTLS) or `465` (SSL) |
| `MAIL_USER`, `MAIL_PASS`, `MAIL_FROM` | — | Credentials and From address |

### 📘 Facebook Messenger & social publishing

No `.env` variables: Page tokens, App ID / App Secret and webhook verify tokens are stored **per channel / per account** (encrypted with `APP_ENCRYPTION_KEY`) and entered in the UI. `APP_URL` **must** be a public HTTPS URL — Meta, Telegram and Viber download post media from signed links under it, and Telegram notification links need an absolute address.

| Variable | Default | Description |
|---|---|---|
| `DOWNLOAD_LINK_SECRET` | auto | Signing of customer download links for digital products |

### 🧾 Logging & monitoring

| Variable | Default | Description |
|---|---|---|
| `LOG_DIR` | `./logs` | Root of `logs/app`, `logs/error`, `logs/http` (one file per day) |
| `LOG_LEVEL` | `info` | Minimal level written to `logs/app` |
| `LOG_STDOUT_LEVEL` | `error` | Minimal level printed to the console (`pm2 logs`) after start; `info` for diagnostics |
| `LOG_RETENTION_DAYS` / `LOG_ERROR_RETENTION_DAYS` / `LOG_HTTP_RETENTION_DAYS` | `30` / `90` / `14` | Retention per category |
| `LOG_SLOW_REQUEST_MS` / `LOG_SLOW_SQL_MS` | `1500` / `1000` | Thresholds for the slow-request and slow-SQL logs |
| `HISTORY_DIR` | `./logs` | Change history (NDJSON) for products, categories, brands |

### 📊 Analytics & reports

| Variable | Default | Description |
|---|---|---|
| `ANALYTICS_CACHE_TTL_MIN` | `60` | Cache lifetime for non-standard analytics filters |
| `ANALYTICS_CONCURRENCY` | `2` | Parallel analytics computations |
| `REPORTS_DIR` | `./storage/reports` | Generated report files (not public) |
| `REPORTS_CONCURRENCY` / `REPORTS_RETENTION_DAYS` | `1` / `30` | Report workers and file retention |

### 📧 Mailing (campaigns)

| Variable | Default | Description |
|---|---|---|
| `MAILING_TOKEN_SECRET` | auto | Signing of unsubscribe / tracking links |
| `MAILING_PUBLIC_URL` | `APP_URL` | Public base URL for those links |
| `MAILING_WORKER` | `1` | `1` — this process sends; `0` — a separate worker does |
| `MAILING_BATCH_SIZE` | `50` | Messages taken from the queue per tick |

### 👥 Clients

| Variable | Default | Description |
|---|---|---|
| `CLIENTS_DEFAULT_COUNTRY` | `US` | ISO-2 country for phone numbers entered without an international code |

### 🔔 Web Push (VAPID)

| Variable | Description |
|---|---|
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | One EC P-256 keypair — regenerate both together or neither |
| `VAPID_SUBJECT` | Contact URI for the push service (`mailto:` or `https:`) |

---

## 🗄 Database

- Access goes through a single **`mysql2` promise pool** (`config/database/connection_pool.js`) with `connectionLimit: 50`, queue limit 500, keep-alive enabled, and `dateStrings: true`.
- Pool diagnostics (acquire/release/enqueue/connection events) are emitted to the structured logger — useful for spotting saturation.
- All table names are built from `DB_PREFIX`, allowing multiple instances to share one schema.
- Both TCP and unix-socket transports are supported (auto-detected from `DB_HOST`).

### 🧩 Domain model at a glance

| Area | Core entities & relationships |
|---|---|
| Pipeline | **Leads** → activity history, files, notes; convertible context for **Deals** |
| Deals | Deal ⇄ **line items**, **quotes**, **contracts**, **invoices**, **acts**, **tasks**, activities |
| People | **Customers** (profiles, contacts, avatars, activity log) ⇄ orders ⇄ carts; **Clients** directory |
| Access | **Users** ⇄ user groups ⇄ permission matrix (resource × action); online presence |
| Orders | Orders ⇄ configurable statuses ⇄ integrations ⇄ **API tokens** (SHA-256 hash, domain/IP binding, usage/error counters) |
| Carts | Cart events ⇄ recovery **campaigns/events** ⇄ dispatch records ⇄ reports; consent flags & retention windows |
| Conversations | Contact-center conversations ⇄ channels (Telegram / Instagram / Facebook / Viber / Web Chat) ⇄ messages ⇄ attachments; post comments (Instagram / Facebook) |
| Social | Accounts ⇄ posts ⇄ per-network variants ⇄ targets (account × format, queue state, result) ⇄ media library; post history log, templates, stats |
| Notifications | Notification outbox ⇄ per-user subscriptions ⇄ delivery attempts (in-app / email / Telegram / web push) |
| Scheduling | Calendar events ⇄ responses, reminders, per-user visibility |
| Catalog | Products, variants, options, attributes, categories, brands ⇄ warehouses, stock documents & movements, reservations ⇄ suppliers |

### 📦 Installation file `database.sql`

- Contains the **complete structure** (all tables, indexes and foreign keys, `CREATE TABLE IF NOT EXISTS`) and the **dictionaries** (languages, currencies, order statuses, payment and delivery methods, lead and deal stages, client and company dictionaries, user groups, the permission pages and full rights for the Administrator group).
- Contains **no users, no customers, no orders and no personal data**. The first administrator is created by the installer.
- Table names use a placeholder prefix, declared in the header line `table prefix: prefix_`; the installer replaces it with `DB_PREFIX` from `.env`.
- Dates in dictionaries are set to the moment of installation (`NOW()`); references to users are `NULL`.
- The file is generated by the maintainers from the reference database with the schema-diff tool, which also produces upgrade migrations (see [Upgrading](#-upgrading)).
- **Do not import it manually** — the installer does it, under a lock, with the right prefix.

### 🧩 Table prefix

- Generated on the first start: a letter followed by seven random letters or digits and `_` (for example `k4m9x2qa_`), like OpenCart does, using `crypto.randomInt`.
- Several instances can share one MySQL database with different prefixes.
- **Do not change `DB_PREFIX` after installation** — the system would see an empty database and install a new one next to the old tables.

---

## 🧭 API Surface Overview

All authenticated UI/API routes require a valid JWT cookie/session unless noted. Representative endpoints:

### Authentication & 2FA
```
GET  /login/                                  Login page
POST /login/                                  Login (rate-limited by IP and by account)
POST /login/tfa/                              Second-factor verification
GET|POST /logout/                             Sign out
GET  /api/tfa/status                          2FA status
POST /api/tfa/init | confirm | disable        2FA enrollment flow
POST /api/tfa/backup-codes/regenerate         New backup codes
```

### Leads / Deals / Customers / Users
```
GET  /leads, /leads/:id                       Lead views
POST /api/leads/list|add/:token|history|activities|files|ui-settings/*
GET  /deals, /deals/:id
POST /api/deals/deals-list, /api/deals/:id/{items,quotes,contracts,invoices,acts,activities,tasks}
GET  /customers/ ; POST /api/customers/{customers-list,:id/data,:id/update,:id/activity-log,:id/contacts,:id/upload-avatar}
GET  /users/, /users/groups, /users/access
POST /api/users/{list-users,online-list,delete,access/save,…}
```

### Orders & integrations
```
GET  /orders/, /orders/status, /orders/settings, /orders/:id/, /orders/clients/:id/
POST /api/orders/{statuses/list,get,add,update,delete,orders-list,list-filters,:id_order/products-list}
GET  /orders/tokens/ , /orders/integrations/  Token & integration management UIs
POST /api/orders/{tokens,integrations}/{list,get,add,update,delete,generate,revoke}
External ingestion uses scoped API tokens (hashed with SHA-256, domain/IP-bound).
```

### Abandoned cart
```
GET  /orders/abandoned-cart/{,event,event/create,event/:id,services,dispatch}
POST /api/orders/abandoned-cart/{abandoned-cart-list,events-save,events-list,services-all,send-viber,events-run,dispatch-list,dispatch-detail}
POST /api/orders/abandoned-cart/{receive,recover,reconcile,close}   ← token-authenticated, rate-limited
```

### Contact center
```
GET  /contact-center/channels/, /contact-center/channels/:id/
POST /api/contact-center/channels/{list,create,:id/update,:id/refresh,:id/status,:id/delete,:id/notify/test-telegram}
POST /api/contact-center/push/{vapid-key,subscribe,unsubscribe}     Manager browser push
POST /api/contact-center/webhook/telegram/:secret/                  Telegram webhook
GET|POST /api/contact-center/webhook/instagram                      IG webhook: messages, echoes, comments (raw-body signature check)
GET|POST /api/contact-center/webhook/facebook                       Messenger + Page feed webhook (raw-body signature check)
GET  /contact-center/comments/ ; POST /api/contact-center/comments/{list,count,sync,:id/{reply,private,hide,unhide,status,delete}}
ANY  /viber/webhook/*                                               Viber bot webhook
GET  /chat/frame.html, /chat/config, /chat/widget.js, /chat/chat-sw.js, /chat/file/*
POST /chat/upload, /chat/push/{subscribe,unsubscribe}               Visitor widget endpoints
```

### Social publishing
```
GET  /contact-center/social/{,new/,:id/,calendar/,accounts/,snippets/,stats/}
POST /api/contact-center/social/posts/{list,calendar,save,:id/{get,approve,reject,reschedule,cancel,retry,delete,history}}
POST /api/contact-center/social/{accounts,snippets,media,stats}/*
GET  /contact-center/social/public/:id/:exp/:sig/[variant/]file.ext     Signed media for Meta / Telegram / Viber (no login)
```

#### Embedding the Web Chat widget on your site

The contact center ships a drop-in visitor chat widget. Paste this snippet into any website:

```html
<!-- Growth Contour web chat -->
<script>
  window.GC_CHAT = { url: "https://your-instance.example.com", primaryColor: "#2563eb" };
</script>
<script async src="https://your-instance.example.com/chat/widget.js"></script>
```

What you get out of the box:

| Capability | How |
|---|---|
| **1-line embed** | Single `<script>` tag — the widget creates its own iframe (`/chat/frame.html`) and never collides with host-page CSS/JS |
| **File sharing** | Visitors upload attachments (`POST /chat/upload`); downloads go through signed URLs (`WEBCHAT_FILE_SECRET`), media is processed in the BullMQ attachment queue (`sharp`) |
| **Offline visitor push** | Browser notifications for visitors even when the tab is closed — via `/chat/push/subscribe` + the widget's own service worker (`/chat/chat-sw.js`) |
| **Agent hand-off** | Conversations land in the unified inbox with presence-aware routing (Socket.IO rooms per conversation) |
| **Theming** | Colors and greeting configured per channel in the admin UI; served to the widget by `/chat/config` |

### Analytics, notifications, misc
```
GET  /analytics/ ; POST /api/analytics/{summary,timeseries,statuses,channels,top-products,funnel,abandoned-carts,integration-health,integrations}
POST /api/notifications/{list,seen,delete,delete/contact-center}
POST /api/calendar/events{,/list,/add,/:eventId,/:eventId/edit,/:eventId/reschedule,/:eventId/delete,/:eventId/respond,/:eventId/hide}
GET  /clients/, /catalog/…, /mailing/…, /reports/, /audit/, /trash/, /settings/{integrations,tokens,system}/
*    /api/modules/*                                                  Module lifecycle (see above)
```

---

## 🛍 Shop Integrations

Shops are connected in **Settings → Integrations**. Each connection has a platform, a site URL, the site's callback URL and token, and a system token that the site uses to call the platform.

### Supported platforms

| Platform | Versions | Orders | Statuses | Abandoned carts | Catalog sync | Reviews |
|---|---|---|---|---|---|---|
| OpenCart | 2.3, 3.0 (incl. ocStore) | ✅ | ✅ | ✅ | ✅ | ✅ |
| PrestaShop | 1.7 (1.7.0 – 1.7.8), 8 (8.0 – 8.2) | ✅ | ✅ | planned | planned | planned |
| Telegram | `telegramshop` module | ✅ | — | ✅ | reads the catalog directly | — |
| WooCommerce, Shopify, Rozetka, Prom, Amazon | — | ✅ via API | ✅ | — | — | — |
| Custom | any | ✅ via API | — | — | — | — |

Capabilities per platform are declared in `controllers/settings/integrations/platforms.js`; the platform only sends a site what its module reports as supported (`ping` → `features`), and marks sites whose module is older than `module_min`.

### Exchange protocol

All shop modules speak the same protocol, so the platform core has no per-platform code paths:

| Direction | Endpoint | Purpose |
|---|---|---|
| Site → platform | `POST {APP_URL}/api/orders/receive/` | New order or order change: a normalized envelope (client, addresses, items, totals, payments, delivery, discounts, notes, raw data). Bearer = system token. |
| Site → platform | `POST {APP_URL}/api/orders/statuses/pull/` | Status list for the status mapping, in the language passed as `lang` (ISO code) or `id_lang`; falls back to the default language. |
| Site → platform | `POST {APP_URL}/api/orders/abandoned-cart/receive/` · `recover` · `reconcile` · `close` | Abandoned-cart events (OpenCart, Telegram). |
| Platform → site | Site callback URL (`action` in JSON body) | `ping`, status changes, order updates, catalog and review sync jobs. Bearer = the site's token; optional HMAC signature `X-GC-Signature` + `X-GC-Timestamp` (5-minute window). |

Outgoing requests are queued (outbox) with retries and crash recovery, so a site that is temporarily down never loses an update.

### OpenCart module

- Repository: `growthcontour/opencart-3.x` (OpenCart 3.0 / ocStore) and the 2.3 build.
- Orders and status history, status mapping both ways, abandoned carts (tracker, cron, reconcile, restore links), two-way catalog sync (categories, products, options, attributes, manufacturers, reviews, customers) with partial and automatic exchange.
- Callback URL: `{site}/index.php?route=extension/module/growthcontour/receive`.

### PrestaShop modules

- Two builds of the same module `growthcontour`: **1.7** (PHP 5.6+) and **8** (PHP 7.2.5+). They are not interchangeable — each declares its own `ps_versions_compliancy`.
- Install: **Modules → Module Manager → Upload a module**, then **Configure**.
- Settings: platform URL, system token, integration id → **Check connection**; copy the shown callback URL and site token into the integration in the platform.
- Orders are sent on creation and on every status change (hook `actionOrderStatusPostUpdate`) and on edits in the back office (`actionOrderEdited`); numbers are `PS-<id>`, customers `PS-CUST-<id>`; real payments from the order are passed; a failure never breaks the checkout and is written to the module log.
- Status changes from the platform are applied without e-mailing the customer; the comment is stored as a private order message.
- Back-office tools: diagnostics, "send one order", "send all orders" with progress, exchange log (last 1,000 entries), token rotation with a grace period for the old token.
- Callback URL: `{site}/index.php?fc=module&module=growthcontour&controller=api`.
- **Abandoned carts** (module 2.2.0+, tab *Abandoned carts*): a cart without an order that has not changed for the threshold (default 60 min, not older than 168 h, optional minimum amount, contact and newsletter-consent filters) is sent to the platform; emptied or expired carts are closed; an order placed from the cart (hook `actionValidateOrder`) closes it as recovered and links order `PS-<id>`. The platform calls the module action `carts.run` every 10 minutes for active PrestaShop integrations that have a callback URL and an active token with *Abandoned carts* permission; an hourly reconciliation closes carts the site no longer has. If the platform cannot reach the site, call the module's cron URL (shown in the tab) every 10 minutes. The recovery link restores the products, including combinations, into the customer's cart (`controller=restore`).
- **Catalog from the platform** (module 2.3.0+, tab *Catalog*; the platform is the master): categories → `Category`, product characteristics → features (`Feature`, product-specific values), products → `Product`, variants → real combinations (`AttributeGroup`/attribute values/`Combination`) with their own reference, EAN, price impact, weight impact and stock (`StockAvailable`), images (downloaded only from the platform host), brand → `Manufacturer`. Changed products reach the site within a minute (partial exchange); a full exchange with reconciliation runs nightly; the module tab can start a full exchange, stop it, or force an overwrite. Per section: create / update, matching existing records (categories and features by name, products by reference, or only linked ones), the *missing in the platform* policy (keep / out of stock / disable / delete, limited per full exchange by the platform), the fields updated in existing products, and whether platform prices include tax. Products imported from the site are already linked. Product options (choices without their own stock) have no PrestaShop equivalent and are not sent. Orders placed on the site go to the platform, which updates stock and sends it back to the site and other channels (Telegram shop).
- **Delivery** (module 2.4.0+, tab *Delivery*): every order carries the parsed delivery — service, type (branch / parcel locker / address), city and branch with Nova Poshta references — in the shipping address (`city_ref`, `warehouse_ref`, `meta.delivery`), so the Nova Poshta module prepares the waybill draft. The module does not depend on the delivery module used on the site: it snapshots the delivery address, the carrier (name, module) and rows of delivery-module tables for the cart/order (`id_cart` / `id_order`), plus delivery-related cookie and POST fields at checkout. JSON rules (matched by carrier name/module/reference) define the service and where each value comes from; references are detected automatically from key names, unknown UUIDs are sent as `candidates` and checked by the platform against the Nova Poshta directory; the city and branch are otherwise found by name and `№` number. The tab can test rules on any order before saving.

---

## ⚡ Real-Time Engine (Socket.IO)

Socket.IO rides on the same HTTP server and powers live collaboration:

| Event | Direction | Purpose |
|---|---|---|
| `user:online` | client → server | Mark a user online; broadcasts presence to the team list |
| `heartbeat` | client → server | Keep-alive so idle tabs don't get falsely marked offline |
| `joinRoom` / `room` | client → server | Subscribe to a conversation/deal room for live message fan-out |
| `getRooms` → `roomsList` | request/response | Introspect a socket's current subscriptions |
| `disconnect` | server-side async | Flip presence to offline, clean up stale rooms |

Rooms are used by the Contact Center (new-message fan-out per conversation), the notification center, and the online-users list (`/api/users/online-list`). Browser push for agents and chat visitors is delivered separately via **Web Push (VAPID)** — see `assets/js/sw-push.js`.

---

## ⏰ Background Jobs & Cron Tasks

| Schedule (Europe/Kyiv) | Job | Source |
|---|---|---|
| +10 s after startup, then `5 * * * *` | Rebuild analytics aggregates, 7-day window | `cron/analytics/rebuildStats.js` |
| `20 3 * * *` | Deep analytics rebuild, 45-day backfill | same |
| `* * * * *` | Calendar reminder tick | `cron/notifications/calendar-reminder-cron.js` |
| `10 4 * * *` | Calendar reminder queue cleanup | same |
| `* * * * *` | Social publishing queue + first comments | `controllers/contact-center/social/publisher.js` |
| `*/15 * * * *` | Post statistics (Instagram, Facebook) | `controllers/contact-center/social/stats.js` |
| `3-59/10 * * * *` | Abandoned-cart exchange on PrestaShop sites (`carts.run`) | `controllers/orders/cartsPull.js` |
| `7,37 * * * *` | Comment sync (Instagram, Facebook) | `controllers/contact-center/comments.js` |
| `30 4 * * *` | Refresh long-lived Instagram tokens | `controllers/contact-center/instagram-refresh.js` |
| `*/5 * * * *` | Auto-tasks (lead without reaction, repeat purchase, lost client) | `controllers/automation/autotasks.js` |
| `40 3 * * *` | Client RFM segmentation | `controllers/clients/rfm.js` |
| `20 4 * * *` | Trash purge | `controllers/common/trash.js` |
| `35 4 * * *` | API-token log pruning | `controllers/orders/tokenAuth.js` |
| `* * * * *`, `*/5`, `40 3` | Shop sync: auto, retry, nightly | `routes/settings/integrations/sync-trigger.js` |
| `*/5 * * * *` | Push product changes to shops | `controllers/catalog/products/sync.js` |
| `* * * * *` | Scheduled product publishing, site import, price rules, reservation expiry | `controllers/catalog/products/*` |
| `7 * * * *` | Currency-rate providers | `controllers/catalog/products/pricing.js` |
| `3-59/10 * * * *` | Stock and price alerts | `controllers/catalog/products/alerts.js` |
| `*/10 * * * *` | Product reviews sync | `controllers/catalog/products/reviews.js` |
| `*/15 * * * *` | Order stock retry | `controllers/catalog/products/order-stock.js` |
| `50 2 * * *` / `40 3 * * *` | Data-quality recalculation / image cleanup | `controllers/catalog/products/{quality,images-maintenance}.js` |

All schedulers guard against overlapping runs with in-flight flags; the social publisher additionally claims work with row locks, so several pm2 processes never publish the same post twice.

**Queue processors (BullMQ + Redis):**
- Orders **inbox** and **outbox** processors — incoming/outgoing order sync.
- **Cart inbox** processor — abandoned-cart event ingestion pipeline.
- **Notification queue + worker** — async multi-channel delivery (email, Telegram, web push, in-app).
- **Attachments queue** — contact-center media processing (downloads, image transforms via `sharp`).

**Crash resilience:** on every boot the server calls `recoverOnStartup()`, `recoverOutboxOnStartup()`, and `recoverCartInboxOnStartup()` to re-enqueue interrupted work. Overlapping cron runs are guarded by in-flight flags.

### 🪣 Notification delivery pipeline

The same event that lights up an agent's badge can also send an e-mail, a Telegram message and a browser push — with retries and rate budgets per channel:

```
business code ──► notify(event)                       controllers/notifications/notify.js
                      │
                      ▼
              outbox row (MySQL)  ◄──────────────────── source of truth, survives crashes
                      │
        ┌─────────────┴──────────────┐
        │ driver = "sync"            │ driver = "bull" (NOTIFY_DRIVER)
        ▼                            ▼
  inline fan-out               BullMQ queue (Redis) ──► worker
        │                            │
        ▼                            ▼
   channels/*.js  ◄── in-app · email (SMTP) · telegram · web-push (VAPID)
        │
        ├─ per-channel token-bucket limits (MAIL_RATE_MAX, WEBPUSH_RATE_MAX, Telegram <30/s)
        ├─ 5 retry attempts, exponential backoff from 3 s
        ├─ bulk fan-out batched above NOTIFY_FANOUT_THRESHOLD recipients
        └─ fallback poller rescues missed events every NOTIFY_OUTBOX_POLL_MS
```

Routing is config-driven (`config/notifications/config.js`): each event type maps to an offcanvas tab in the UI (`chat` / `profile` / `personal` / `system`), so notifications land exactly where users expect them.

---

## 🔐 Security Model

Implemented layers (see `server.js` and `middlewares/`):

- **Transport & headers** — `helmet` with a strict Content-Security-Policy (allow-listed CDNs for Bootstrap/jQuery/Tabulator/Socket.IO), HSTS, `X-Frame-Options`, etc. `trust proxy` limited to a single hop.
- **Authentication** — JWT access + refresh tokens with separate secrets and configurable expiry (`JWT_EXPIRES=7d`, remember-me `30d`); root route verifies the cookie and redirects unauthenticated users to `/login/`.
- **Two-factor authentication** — TOTP (RFC 6238, configurable step/window), issuer branding, **AES-encrypted secrets at rest** (`TFA_ENC_KEY`), one-time backup codes.
- **Authorization (RBAC)** — `isAuthenticated` + `checkPermission(resource, action)` guards on routes; per-group permission matrix editable in the UI; template-level `res.locals.can` checks.
- **Sessions** — server-side `express-session`, `HttpOnly`, `SameSite=Strict`, `Secure` in production, 10-minute idle window.
- **Rate limiting (layered)** — see the table below. A **global API limiter** (`middlewares/api-limiter.js`) covers every route that touches the database: 1,000 requests / 15 min, keyed by authenticated user id (IP fallback for anonymous traffic), with standard `RateLimit` headers. Static assets, Socket.IO polling and inbound channel webhooks are intentionally exempt. Dedicated stricter limiters (`middlewares/rate-limiters.js`) protect login (per IP **and** per account), TFA operations, public invite endpoints (page 60 req/15 min, acceptance 20 req/15 min against token brute-forcing, re-send 10 emails/IP/hour), and each cart-ingestion endpoint.

#### 🚦 Rate-limiting strategy at a glance

| Layer | Scope | Limit | Key | Rationale |
|---|---|---|---|---|
| Global API limiter | All DB-backed routes | 1 000 / 15 min | user id → IP fallback | Stops runaway clients & DB resource exhaustion (satisfies CodeQL `js/missing-rate-limiting`) |
| Login limiter | `POST /login`, token refresh | strict, per IP **and** per account | IP / username | Credential stuffing protection |
| TFA limiter | Enroll / verify / backup codes | strict | session + IP | Brute-force protection on OTP window |
| Invite limiter | Public invite pages & re-send | 60 · 20 / 15 min; 10 e-mails/h | IP | Token guessing protection |
| Cart ingestion | Shop-facing REST API | per integration token | token hash | Fair-use between connected shops |
| Exempt | Static assets, Socket.IO polling, inbound webhooks | — | — | High-frequency, non-DB or third-party traffic |

All limiters return standards-track `RateLimit-*` headers so clients can self-throttle.
- **Upload safety** — attachments served from `/uploads` with `nosniff`, sandboxed CSP, forced-download headers; content type verified with `file-type` (magic bytes, not extension); web-chat file links are signed (`WEBCHAT_FILE_SECRET`).
- **Token hygiene** — external API tokens stored only as SHA-256 hashes; channel/integration tokens encrypted with `APP_ENCRYPTION_KEY`; usage/error counters and domain/IP binding per token.
- **Webhook integrity** — Instagram and Facebook webhooks validated against the **raw request body** signature (Meta HMAC, per-channel App Secret); Telegram webhooks protected by a per-channel secret in the URL path.
- **Signed media links** — social media files are fetched by Meta/Telegram/Viber through short-lived HMAC-signed URLs; the media library itself is never listed publicly.
- **Rich-text whitelist** — post HTML is sanitised server-side (`sanitize-html`) to a fixed tag set before storage and converted per network on publish.
- **Input validation** — schema-based validation (`ajv`, `jsonschema`, `validator`) for all mutating endpoints; phone numbers normalized with `libphonenumber-js`.
- **Payload limits** — JSON bodies capped at 300 kB; response compression enabled.
- **Error handling** — generic error responses in production; stack traces only when `NODE_ENV=development`.

### 🔒 Secrets & key rotation cheat-sheet

| If you rotate… | Consequence |
|---|---|
| `JWT_SECRET` / `SESSION_SECRET` | All users logged out immediately (sessions + access cookies invalid) |
| `JWT_REFRESH_SECRET` | All refresh tokens invalid — everyone must re-login |
| `TFA_ENC_KEY` | ⚠️ Stored 2FA secrets become unreadable — **all users lose TOTP** unless re-enrolled |
| `APP_ENCRYPTION_KEY` | ⚠️ Encrypted integration/channel tokens (Instagram, Facebook, Telegram, Viber, SMSclub) can no longer be decrypted, and signed social media links change |
| `WEBCHAT_FILE_SECRET` | Existing signed chat attachment links break (new uploads unaffected) |
| `TELEGRAM_TOKEN_KEY` | Saved Telegram bot tokens must be re-entered in the admin panel |

**Best practice:** keep a versioned, encrypted backup of `.env`; regenerate VAPID keys as a *pair* (`VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` + matching `VAPID_SUBJECT`).

---

## 🌍 Internationalization

- Engine: `i18n` package with a custom loader (`config/i18n/i18n.js`) that loads an explicit list of JSON files and deep-merges them.
- **English is the base locale:** for every other language the loader first loads English, then overrides it with that language's files, so a missing key falls back to English instead of showing a raw key.
- **Supported locales (12):** `de`, `en`, `es`, `fr`, `it`, `ja`, `ko`, `nl`, `pl`, `pt`, `uk`, `zh`.
- **One language per user.** The single source is `users.id_lang` → the `languages` table (new users get `id = 1`, English). For signed-in employees the page texts (the `lang` cookie / i18n locale) always follow it, and data in the database (status names, dictionaries) is read in the same language; switching the language applies to both immediately, without signing in again. Before sign-in the locale comes from the `lang` cookie or `?lang=`.
- **One dictionary per page.** Each page has its own file (`locales/<locale>/<module>/<page>.json`) with a block `module.page` that starts with `title` and `breadcrumb` (`home`, parent links, `current`), followed by the page's texts. Shared texts live in `common.json` of the module.
- **Rules for code:**
  - EJS prints text only inline: `<%= i18n.__('module.page.key') %>` — also inside `<script>` blocks; no translation objects passed to JS via `JSON.stringify`, no `const t = (k) => …` helpers.
  - Server code throws error **keys** (`httpErr(400, "module.errors.key", params)`); routes translate them with `req.__(key, params)`. Background jobs use the system locale (`APP_LOCALE`, default `uk`).
  - Parameters use mustache: `{{name}}`.
- **Adding a language:** copy `locales/en/` to `locales/<code>/`, translate values only (never keys or placeholders), and add nothing to code. A checker script and translation rules for contributors are kept in `TRANSLATION_GUIDE.md`.

---

## 🚢 Deployment

Recommended production topology: **Nginx (TLS) → Node.js (this app, pm2) → MySQL 8 + Redis**.

### Checklist

1. `NODE_ENV=production`, a public HTTPS `APP_URL`, `CORS_ORIGINS` if other origins call the API.
2. The reverse proxy passes `X-Forwarded-For` / `X-Forwarded-Proto` (the app trusts exactly **one** proxy hop) and supports WebSockets (Socket.IO).
3. Redis with persistence (AOF or RDB) — queues and notification reliability depend on it.
4. Webhooks (Telegram, Instagram, Facebook, Viber) point at the public HTTPS URL.
5. Backups of the database, `.env` and uploaded files are scheduled (see below).
6. The process manager does not restart on exit code `78`.

### pm2

```bash
npm i -g pm2

# fork mode (one process)
pm2 start server.js --name growthcontour --stop-exit-codes 78

# or cluster mode (one process per CPU core)
pm2 start server.js --name growthcontour -i max --stop-exit-codes 78

pm2 save                 # remember the process list
pm2 startup              # start pm2 on boot (prints a command to run as root)

pm2 install pm2-logrotate   # rotate pm2's own stdout/stderr files
pm2 logs growthcontour      # start-up steps and errors
pm2 restart growthcontour   # after .env changes or an upgrade
```

In cluster mode installation, cron jobs with row locks and queue workers are safe across processes; start-up output comes from instance `0`.

### systemd

```ini
# /etc/systemd/system/growthcontour.service
[Unit]
Description=Growth Contour
After=network.target mysql.service redis-server.service

[Service]
Type=simple
User=gc
WorkingDirectory=/opt/growth-contour
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
# configuration errors (exit code 78) wait for a fix instead of restarting in a loop
RestartPreventExitStatus=78
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now growthcontour
journalctl -u growthcontour -f
```

`.env` is read by the app itself, so `EnvironmentFile=` is not needed.

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name crm.example.com;

    ssl_certificate     /etc/letsencrypt/live/crm.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/crm.example.com/privkey.pem;

    client_max_body_size 50m;          # attachments, imports, media library

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        # Socket.IO
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 120s;
        # webhook signatures are computed over the raw body
        proxy_request_buffering off;
    }
}

server {
    listen 80;
    server_name crm.example.com;
    return 301 https://$host$request_uri;
}
```

### 💾 Backups & restore

| What | Why | How |
|---|---|---|
| MySQL database | All business data | `mysqldump --single-transaction --routines --triggers -u gc -p growth_contour \| gzip > gc-$(date +%F).sql.gz` |
| `.env` | Secrets: sessions, 2FA, encrypted tokens, signed links | Copy to an encrypted, versioned location |
| `public/uploads/`, `assets/contact-center/` | Chat attachments, social media library | `rsync` / snapshot |
| `storage/reports/` | Generated reports (optional, can be regenerated) | `rsync` |
| `logs/` | Optional | Usually not backed up |

**Restore:** restore `.env` first, then the database dump into an empty database with the same name and the same `DB_PREFIX`, then the files, then `pm2 restart growthcontour`. Because the tables and users exist, the installer is skipped automatically.

### 🧹 Reinstall from scratch

1. `pm2 stop growthcontour`
2. Drop the tables with your prefix (or drop and recreate the database).
3. Keep `.env` (or delete it to also regenerate secrets and the prefix — all sessions and encrypted tokens are lost then).
4. `pm2 restart growthcontour` — the installer runs again and prints a new administrator password.

---

## ⬆️ Upgrading

```bash
pm2 stop growthcontour
# 1. back up the database and .env (see Backups)
git pull                    # or unpack the new release over the old one
npm ci
# 2. apply the release's migration SQL, if the release ships one
mysql -u gc -p growth_contour < migration.sql
pm2 restart growthcontour
```

- **Configuration:** keys introduced by the new release are appended to `.env` automatically on start (with generated secrets where applicable); your values are never changed.
- **Database:** releases that change the schema ship a migration generated by the schema-diff tool from the reference database. It adds new tables and columns, adjusts types, indexes and foreign keys, renames what was renamed, updates dictionaries without touching your own entries, and grants the Administrator group the rights to new pages. It never touches users, customers, orders or other business data. Read the warnings at the top of the file and always back up first.
- **Modules:** copy updated module folders into `modules/`; modules are loaded and enabled on start.
- **Shop modules:** update the OpenCart / PrestaShop module on each site when a release raises the minimum module version — **Settings → Integrations** shows sites whose module is out of date.

---

## 🛠 Development Guide

### Code style & conventions

The codebase follows a strict, predictable layering — new features should too:

```
routes/<domain>/   → thin Express routers: path definitions + auth/permission guards only
controllers/<domain>/ → business logic: validation results, SQL via the shared pool, responses
validator/<domain>/   → AJV / jsonschema request schemas (one file per mutating endpoint group)
locales/<lang>/<domain>/ → translations for that domain
views/pages/<domain>/    → EJS pages; assets live in assets/{css,js}/<domain>
```

Other conventions: `"use strict";` at file top, CommonJS `require`, MySQL table names always built from `DB_PREFIX`, all timestamps handled as strings (`dateStrings: true`) with `Europe/Kyiv` cron scheduling.

### Adding a translation key

1. Add the key to `locales/en/<domain>/…json` (source of truth).
2. Add it to the other locales you maintain — missing keys fall back gracefully.
3. No restart tricks needed: dictionaries are deep-merged at boot (`config/i18n/i18n.js`).

### Adding an API token integration (shop side)

1. In Growth Contour: **Orders → Integrations** — register the external system; **Orders → Tokens** — generate a scoped API token (shown once; only its SHA-256 hash is stored). Optionally bind the token to source domains/IPs.
2. In your shop/CMS: call `POST /api/orders/abandoned-cart/receive` with the token header on cart events, then `recover` / `reconcile` / `close` as the customer moves through the funnel.
3. Watch per-token usage/error counters in the tokens UI to debug payloads.

### Where to look for…

| You want to… | Start here |
|---|---|
| Understand boot order & middleware | `server.js` (top → bottom), `ensure-env.js` |
| Change password/JWT/TFA behavior | `controllers/authorization/`, `helpers/crypto_tfa.js`, `helpers/tfa.js` |
| Tune queue/cron reliability | `controllers/orders/` processors, `cron/*` |
| Extend the UI without touching core views | Module hooks — see [Modules](#-modules-plugin-system) |
| Add a messaging channel | `controllers/contact-center/channels/types/` (copy the Facebook or Telegram type: `load`, `validate`, `save`, `send`, `normalize`) |
| Add a social network for publishing | `controllers/contact-center/social/` — an adapter with `publish(cred, job)` returning `{ done }` or `{ wait }`, plus an entry in `NETWORKS` / `FORMATS` |
| Add a notification channel | `controllers/notifications/channels/` |
| Debug slow DB | Pool diagnostics emitted by `config/database/connection_pool.js` |

### Local stack tips

- Run Redis locally with persistence enabled (`redis-server --save 60 1`) so BullMQ jobs survive restarts during development.
- Point webhooks at a tunnel (ngrok/cloudflared) when testing Instagram, Facebook or Telegram callbacks, and set `APP_URL` to the tunnel URL so signed media links are reachable.
- Meta apps in development mode deliver webhooks only for people with a role in the app — test from an admin/tester account.
- `NODE_ENV=development` surfaces stack traces in error pages — never expose this mode publicly.

---

## 🩺 Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `! Replace every __REQUIRED__ value in .env …` and the process stops | Expected on the first start — fill the listed keys and restart |
| `✖ MySQL · Access denied for user …` | Wrong `DB_USER` / `DB_PASSWORD`, or the user has no privileges on `DB_NAME` |
| `✖ MySQL · Database "…" does not exist` | Create the empty database first (`utf8mb4`) or fix `DB_NAME` |
| `✖ MySQL · Cannot connect to MySQL …` | MySQL is down or `DB_HOST` / `DB_PORT` is wrong; the process manager keeps retrying (exit code 1) |
| `✖ MySQL · Server version … MariaDB` | MariaDB is not supported — use MySQL 8.0+ |
| `✖ Schema · N differences from database.sql` | The database does not match the code: apply the release migration (an upgrade without it) or fix the objects listed in `logs/schema-check.log`; `SCHEMA_CHECK=warn` starts anyway |
| `✖ Database · … the schema is incomplete: …` | The tables with this prefix were imported only partly — drop them and start again; the system installs `database.sql` itself |
| pm2 restarts the process every second | Start pm2 with `--stop-exit-codes 78`, or check `pm2 logs` for the configuration error |
| Lost the administrator password printed on installation | Use **Forgot password** on the sign-in page (SMTP must be configured), or reinstall an empty system |
| `[config] missing auto-generated secret: …` at boot | `.env` is missing secrets — run `node ensure-env.js` |
| Server fails with `process.loadEnvFile is not a function` | Upgrade to **Node.js 20.12+** (22 LTS recommended) |
| Jobs don't run / notifications stuck | Redis not running at `127.0.0.1:6379` or firewalled — check `logs/error` |
| Orders/carts disappear after restart crash | Check startup logs for `recover…` messages; verify Redis persistence |
| Instagram webhook rejects (hub.challenge fails) | `IG_VERIFY_TOKEN` mismatch, or a proxy buffering the raw body (signature is computed over raw bytes) |
| Everyone logged out / 2FA errors after deploy | Secrets in `.env` were regenerated — restore the previous `.env` from backup |
| Static chat attachments blocked | Files must be under `public/uploads/`; CSP sandbox headers intentionally prevent inline execution |
| Locale not switching | Verify the files listed in `config/i18n/i18n.js` exist for that locale and are valid JSON; missing files are skipped silently |
| Page shows raw keys like `contact_center.x.title` | The page's JSON file is missing or not registered in `config/i18n/i18n.js` |
| Facebook / Instagram webhook: nothing in logs | Webhook field not subscribed in the Meta app (Page: `messages`, `feed`…; Instagram: `messages`, `comments`), or the channel is inactive. Check `pm2 logs --raw \| grep fb-` |
| Messages from customers don't arrive, but your own do | The Meta app is in Standard Access — only app roles are delivered until App Review grants Advanced Access |
| Social post fails: media cannot be fetched | `APP_URL` is not public HTTPS, or a proxy blocks `/contact-center/social/public/…` |
| Telegram first comment never appears | The channel has no linked discussion group, or the bot is not an admin of that group |
| Console shows only errors | default `LOG_STDOUT_LEVEL=error`; set `info` for everything |

### 🩺 Self-check endpoints & log lines to watch

| Signal | Where | Meaning |
|---|---|---|
| `System is up and running · … · port …` | stdout | HTTP server is listening, modules loaded (`✔ Modules · N`) |
| `recover…` messages right after boot | `logs/app` | Queue crash-recovery re-enqueued pending order/cart work |
| `[analytics]` entries | `logs/app` | Aggregate rebuild cadence & duration |
| `{ pool: "promise", evt: "acquire", active: N }` | structured log (pino) | MySQL pool saturation — rising `active` near 50 means scale up or slow queries down |
| `HTTP 429` + `RateLimit-*` headers | any API response | Client exceeded its limiter budget (expected for abuse, tune env vars if legitimate traffic hits it) |

---

## ❓ FAQ

**Do I need to import `database.sql` myself?**
No. The installer does it on the first start against an empty database, with your table prefix. If you did import it manually (with the prefix from `.env`), the system checks that the schema is complete and creates the first administrator.

**Can I choose the table prefix?**
Yes — set `DB_PREFIX` in `.env` before the first start. If you leave the generated one, it is a random 8-character prefix. Never change it after installation.

**Should `.env` be committed to git?**
No. Commit `.env.example` (template without secrets) and keep `.env` out of the repository and in your backups.

**Where are the logs?**
`logs/app` (everything), `logs/error` (errors only), `logs/http` (slow and failed requests, slow SQL) — one file per day, retention configurable. The console (`pm2 logs`) shows the start-up steps and errors only; set `LOG_STDOUT_LEVEL=info` to see everything. The **System** page shows grouped errors, logs and performance metrics in the UI.

**How do I run several instances on one server?**
Separate folders, separate `.env` files with different `PORT` (and either different databases or different `DB_PREFIX` in one database), separate pm2 names.

**Can it run without Redis?**
The notification engine can (`NOTIFY_DRIVER=sync`); BullMQ-based queues need Redis, so production setups should run Redis.

**Is the console output colored under pm2?**
Yes — colors are used in a terminal and under pm2; set `NO_COLOR=1` to disable them or `FORCE_COLOR=1` to force them.

**How do I disable a module?**
In **Settings → Modules**, or remove its folder from `modules/` and restart.

---

## 🗺 Roadmap

Ideas under consideration:

- [ ] Migrations applied automatically on start (versioned, with rollback)
- [ ] Automated tests (unit for validators/processors and network adapters, integration for order and publishing pipelines)
- [ ] Email in the contact center (SMTP/IMAP, Gmail & Outlook OAuth) and a unified client timeline
- [ ] Payment links (LiqPay, WayForPay) from chats and orders
- [ ] PrestaShop modules: abandoned carts, catalog sync, delivery; PrestaShop 9 build
- [ ] Automatic Nova Poshta status notifications to customers
- [ ] Quick replies, conversation routing and SLA in the contact center
- [ ] Company feed (internal news, announcements, @mentions)
- [ ] WhatsApp Business channel
- [ ] Docker Compose quick-start stack (app + MySQL + Redis + Nginx)

Done recently ✅

- Zero-touch installation: `.env` template, generated table prefix, automatic schema install and first administrator, quiet colored start-up output.
- PrestaShop 1.7 and 8 modules (orders, statuses, exchange log).
- Telegram Shop module with broadcasts; promo codes.

- Facebook Messenger channel; messages sent directly from Instagram/Facebook appear in the conversation.
- Comment moderation for Instagram and Facebook posts.
- Social publishing: per-network texts, first comment, approvals with history, calendar, templates & hashtag groups, post analytics and best time.
- System page: grouped errors, logs, performance metrics; console logging level configurable.
- Per-page locale files with English fallback.
- MIT licensing; layered rate limiting.

---

## 🤝 Contributing

Contributions are welcome — this project lives by them!

1. **Fork & branch** — create a feature branch (`git checkout -b feature/amazing-feature`) from the latest default branch.
2. **Match the structure** — routes → controllers → pool queries; request schemas in `validator/`; translations in `locales/` (at minimum add English keys). New UI extension should prefer **module hooks** over editing core views.
3. **Test locally** — run with MySQL + Redis up; verify login/2FA, module loading, and queue recovery on restart still behave.
4. **One concern per PR** — describe the problem, the approach, and any config/schema impact. Reference related issues (`Fixes #123`).
5. **Keep history tidy** — rebase/squash noisy commits before requesting review.

Bug reports and feature requests go through [GitHub Issues](../../issues). For larger design changes, open an issue first so we can agree on scope before you invest time.

### 🧭 Good first issues

Looking for a way in? The best starter tasks are: translation improvements (any of the 12 locales), documentation fixes, validator schema coverage, and small UX polish in `views/pages/`.

---

## 📜 Code of Conduct

We aim for a welcoming, respectful community. Be kind, assume good intent, critique code (not people), and keep discussions on-topic. Report unacceptable behavior by opening an issue tagged `moderation`.

---

## 🙏 Acknowledgments

Built on the shoulders of excellent open-source projects:

[Node.js](https://nodejs.org) · [Express](https://expressjs.com) · [MySQL](https://www.mysql.com) · [Redis](https://redis.io) · [BullMQ](https://bullmq.io) · [Socket.IO](https://socket.io) · [EJS](https://ejs.co) · [Bootstrap](https://getbootstrap.com) · [Tabulator](https://tabulator.info) · [sharp](https://sharp.pixelplumbing.com) · [helmet](https://helmetjs.github.io) · [node-cron](https://github.com/kelektiv/node-cron) · [Meta Graph API](https://developers.facebook.com/docs/graph-api), [Telegram Bot API](https://core.telegram.org/bots/api), [Viber Business API](https://developers.viber.com) and [SMSclub](https://smsclub.pro) for messaging integrations — and every contributor who files an issue, translates a string, or ships a patch. 💚

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for the full text.

© 2025–2026 Growth Contour contributors

In short (and this is a human-readable summary, not a replacement for the license text):

| ✅ You may | ⚠️ Conditions | ❌ Not liable for |
|---|---|---|
| Use commercially & privately | Keep the copyright + license notice in copies/substantial portions | Warranty of any kind — software ships **"as is"** |
| Modify, merge, refactor | Same as above | Damages arising from use |
| Distribute, sublicense, sell | Same as above | — |
| Use in SaaS / closed products | Attribution preserved in redistributed source | — |

Because it's MIT, you can freely embed Growth Contour in proprietary products without open-sourcing your changes — attribution in source copies is the only requirement.

---

<div align="center">

**Growth Contour** — built for teams that grow. 📈

If this project helps you, consider giving it a ⭐ on GitHub!

</div>