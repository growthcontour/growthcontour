<div align="center">

<img src="assets/images/logo/logo.png" alt="Growth Contour logo"/>

# 🚀 Growth Contour

**An open-source, modular, real-time sales & customer engagement platform — a complete pipeline core plus much, much more.**

Built with Node.js · Express 5 · MySQL · Redis · Socket.IO

[![Node.js](https://img.shields.io/badge/Node.js-≥20.6-339933?style=flat-square&logo=node.js&logoColor=white)](#-requirements)
[![Express 5](https://img.shields.io/badge/Express-5.2-000000?style=flat-square&logo=express&logoColor=white)](#-tech-stack)
[![MySQL 8](https://img.shields.io/badge/MySQL-8.x-4479A1?style=flat-square&logo=mysql&logoColor=white)](#-requirements)
[![Redis + BullMQ](https://img.shields.io/badge/Redis%20%2B%20BullMQ-queues-DC382D?style=flat-square&logo=redis&logoColor=white)](#-background-jobs--cron-tasks)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-realtime-010101?style=flat-square&logo=socketdotio&logoColor=white)](#-realtime-engine-socketio)
[![Languages](https://img.shields.io/badge/UI%20locales-20-blueviolet?style=flat-square)](#-internationalization)
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
- [Real-Time Engine (Socket.IO)](#-real-time-engine-socketio)
- [Background Jobs & Cron Tasks](#-background-jobs--cron-tasks)
- [Security Model](#-security-model)
- [Internationalization](#-internationalization)
- [Deployment](#-deployment)
- [Development Guide](#-development-guide)
- [Troubleshooting](#-troubleshooting)
- [Roadmap](#-roadmap)
- [Contributing](#-contributing)
- [Code of Conduct](#-code-of-conduct)
- [Acknowledgments](#-acknowledgments)
- [License](#-license)

---

## 📊 At a Glance

| | |
|---|---|
| 💾 **Runtime** | Node.js ≥ 20.6 · Express 5 · CommonJS |
| 🗄 **Data layer** | MySQL 8 (`mysql2` connection pool, `gc_` table prefix) |
| ⚙️ **Queues & cache** | Redis + BullMQ (inbox / outbox / cart / attachment workers) |
| 🔌 **Live updates** | Socket.IO (agent workspace, chat widget, notifications) |
| 🧩 **Extensibility** | Drop-in module system with lifecycle hooks & hot-reload |
| 🌍 **Locales** | 20 languages shipped out of the box |
| 🔐 **Auth** | JWT + refresh tokens, TOTP 2FA, RBAC permission matrix |
| 🛡 **Hardening** | helmet CSP, layered rate limiting, encrypted secrets, webhook signatures |
| 📮 **Channels** | Telegram · Instagram Direct · Viber · Web Chat · Email (SMTP) |
| ⏰ **Automation** | node-cron schedulers (Europe/Kyiv) + BullMQ repeatable jobs |
| 📄 **License** | MIT — free for commercial and non-commercial use |

---

## 🌟 Overview

**Growth Contour** is a full-featured, self-hosted business platform that goes well beyond the classic pipeline-tool category. It ships a complete sales suite (leads, deals, customers, orders) **and** layers on top of it an omni-channel **Contact Center** (Telegram, Instagram, Viber, embedded Web Chat), **abandoned-cart recovery automation**, real-time collaboration, and a pluggable **module system** that lets you extend the platform without touching the core.

The entire backend is a single Node.js application (Express 5) rendering server-side EJS views, backed by MySQL, with Redis + BullMQ powering queues and Socket.IO delivering live updates to agents and visitors alike.

### What makes it different

- 🔌 **Extensible by design** — drop-in modules with hooks, routes, controllers, and hot-reload support.
- 💬 **True omni-channel inbox** — one conversation view for Telegram, Instagram Direct, Viber, and your website's chat widget.
- 🛒 **Cart-recovery pipeline** — token-authenticated ingestion API for external shops (CMS/marketplaces) plus scheduled Viber/SMS campaigns via SMSclub.
- 🔐 **Security-first defaults** — JWT auth, TOTP 2FA with encrypted secrets and backup codes, RBAC permissions, rate limiting, CSP/HSTS headers, encrypted-at-rest integration tokens.
- 🌍 **20 locales** out of the box.

---

## 🎯 Why Growth Contour?

Most open-source platforms stop at "leads and pipelines". Growth Contour was built for teams whose revenue leaks happen **outside** the sales board — in unanswered Instagram DMs, Telegram chats, and carts abandoned on the shop at 2 a.m. It ships those recovery loops as first-class features, not paid plugins:

| Challenge | How Growth Contour answers it |
|---|---|
| Messages scattered across messengers | One unified inbox: Telegram, Instagram Direct, Viber + your website's chat widget |
| Abandoned carts silently lost | Token-authenticated ingestion API + scheduled Viber/SMS recovery campaigns (SMSclub adapter) |
| SaaS products get expensive per seat | Self-hosted, unlimited seats, MIT-licensed |
| Custom workflows don't fit anyone | Pluggable module system with hooks, routes and hot-reload — extend without forking |
| Data sovereignty matters | Your MySQL, your Redis, your server. No third-party analytics, no phone-home |
| Teams work across languages | 20 locales out of the box, feature-scoped translation dictionaries |

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
- Order board with configurable statuses (CRUD on statuses, filters, list endpoints).
- **Integration registry** — manage connections to external systems (`/orders/integrations/`).
- **API tokens** — generate/revoke scoped tokens (SHA-256 hashed at rest) used by external CMS/marketplaces to push orders and carts into the platform; usage and error counters tracked per token, with domain/IP binding.

### Abandoned Cart Recovery
- Ingestion endpoints: `receive`, `recover`, `reconcile`, `close` (token-authenticated, per-endpoint rate limits).
- Event-based campaign engine (create/edit/list recovery events, run manually or on schedule).
- Dispatch center with per-cart detail views and reporting.
- Recovery links for end customers.
- Viber bulk sending through the built-in **SMSclub provider adapter** (retry-aware error mapping, lifetime clamping for single vs. bulk messages).
- Inbox/outbox/cart processors with **crash recovery on startup** — unfinished queue work is re-enqueued automatically.

### Contact Center
- Unified conversation model across channels.
- Channel management UI: create, edit, refresh, enable/disable, test-notify.
- **Telegram** bot channel (webhook-based, secret-protected URL).
- **Instagram** (Meta Graph API v21): webhook signature verification against raw body, long-lived token auto-refresh cron.
- **Viber** bot (webhook mounted at `/viber/webhook/`).
- **Web Chat widget** embeddable on any site: iframe frame (`/chat/frame.html`), config endpoint, file upload/download with signed URLs, its own service worker, and optional browser push for visitors.
- Media/attachment processing queue (BullMQ) with image handling via `sharp`.

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
- i18n with 20 locales and automatic language negotiation.
- Invite links and password-reset links with configurable TTL.
- Auto-generated `.env` secrets bootstrap (`ensure-env.js`).

---

## 🧱 Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 20 (uses `process.loadEnvFile`) |
| Web framework | Express 5 |
| Views | EJS (+ `html-minifier` for production output) |
| Database | MySQL 8 (`mysql2` promise pool, connection diagnostics) |
| Cache / Queues | Redis (`ioredis`, `node-cache`) + **BullMQ** workers |
| Realtime | Socket.IO 4 |
| Auth | JWT (access + refresh), bcrypt password hashing, TOTP 2FA (`otplib`/`otpauth`, QR via `qrcode`) |
| Security middleware | `helmet` (CSP, HSTS…), `cors` allow-list, `express-rate-limit`, cookie-parser, `express-session` |
| Messaging integrations | `node-telegram-bot-api`, `viber-bot`, Meta Graph API (Instagram), SMSclub (Viber/SMS), SMTP via `nodemailer` |
| Push notifications | `web-push` (VAPID keys) |
| Validation | `ajv` + `ajv-formats`, `validator`, `jsonschema`, `libphonenumber-js` (phone normalization) |
| Files | `multer` uploads, `file-type` sniffing, `sharp` image processing, `mime` |
| Scheduling | `node-cron` (Europe/Kyiv timezone) |
| Logging | `pino` + custom logger wrapper |
| HTTP client | `axios` |
| Config | `config` package with env-driven defaults |

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

1. **`ensure-env.js`** runs before anything else (`prestart` hook) — creates/patches `.env` with cryptographically strong secrets, then loads it via `process.loadEnvFile`.
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
├── ensure-env.js           # .env generator/bootstrapper (secrets, blocks, docs)
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
│   ├── contact-center/     #   channels, webhooks (TG/IG), web-chat, viber
│   ├── customers/          #   customer CRUD APIs
│   ├── deals/              #   deals + items/quotes/contracts/invoices/acts/tasks
│   ├── index/              #   dashboard, calendar/scheduler APIs
│   ├── leads/              #   leads, activities, files, UI settings, public capture
│   ├── modules/            #   module lifecycle REST API
│   ├── notifications/      #   notification center
│   ├── orders/             #   orders, statuses, tokens, integrations, receiver,
│   │   └── abandoned-cart/ #   carts, events, services, dispatch, reports, recover links
│   ├── profile/            #   user profile
│   ├── settings/           #   email + integration settings
│   └── users/              #   users, groups, permission matrix, online list
├── controllers/            # Business logic
│   ├── authorization/      #   auth flows, TFA settings
│   ├── contact-center/     #   conversations, channels (telegram/instagram/webchat),
│   │                       #   uploads, files, realtime, IG token refresh, attachments queue
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
├── locales/                # 20 translation folders (JSON)
├── views/                  # EJS: pages/, partials/, emails/templates/
├── assets/                 # css/js/images/mp3, sw-push.js (service worker)
└── public/uploads/         # Contact-center attachments (served sandboxed at /uploads)
```

---

## 🔌 Modules (Plugin System)

The platform ships with a lightweight extension framework in `core/modules/`. Any folder inside `/modules` that contains a `module.json` is treated as a module.

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

---

## 📋 Requirements

- **Node.js ≥ 20** (the app uses `process.loadEnvFile`; earlier versions will not start)
- **MySQL 8.x** (or MariaDB with JSON support)
- **Redis** (default `127.0.0.1:6379`) — required for BullMQ queues, notification workers, caching
- A reverse proxy (**Nginx/Cloudflare**) for TLS termination in production
- Outbound HTTPS access for Telegram / Instagram / Viber / SMSclub APIs (as needed)

---

## 🚀 Installation & Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/<your-org>/growth-contour.git
cd growth-contour

# 2. Install dependencies
npm install

# 3. Bootstrap configuration
#    The `prestart` script runs ensure-env.js automatically:
#    - creates ./.env (mode 0600) with strong random secrets
#      (JWT_SECRET, JWT_REFRESH_SECRET, TFA_ENC_KEY, APP_ENCRYPTION_KEY,
#       WEBCHAT_FILE_SECRET, SESSION_SECRET, TELEGRAM_TOKEN_KEY, VAPID keypair)
#    - never overwrites existing values; appends newly introduced fields on upgrade
npm run prestart

# 4. Fill in credentials in .env
#    Required: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME
#    Optional: SMTP, Instagram/Meta app, CORS_ORIGINS, APP_URL …

# 5. Create the database schema
#    (import your SQL dump / migrations into the target MySQL database;
#     table prefix is controlled by DB_PREFIX, default "gc_")

# 6. Start the server
npm start
# → "Сайт запущений. Порт: 3000"
```

### 🐳 Alternative: bring up the data tier with Docker

If you don't have MySQL/Redis installed locally yet, this one-liner starts both (the app itself still runs with `npm start`):

```bash
docker run -d --name gc-mysql -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=growth_contour mysql:8

docker run -d --name gc-redis -p 6379:6379 redis:7 --save 60 1

# then point .env at them:
#   DB_HOST=127.0.0.1  DB_PORT=3306  DB_USER=root  DB_PASSWORD=root  DB_NAME=growth_contour
```

Open `http://localhost:3000/login/` and sign in with your initial administrator account.

For development, `nodemon` is available as a dependency:

```bash
npx nodemon server.js
```

### ✅ Verify your installation

```bash
curl -I http://localhost:3000/login/        # → HTTP 200
node -e "process.loadEnvFile(); console.log('env OK')"   # .env parses cleanly
redis-cli ping                              # → PONG (queue backend alive)
mysql -u"$DB_USER" -p -e "SHOW TABLES LIKE 'gc_%';"      # schema imported
```

If all four checks pass, log in at `http://localhost:3000/login/` and you're ready to go.

---

## ⚙️ Configuration (.env reference)

All runtime configuration lives in `.env` (auto-created by `ensure-env.js`). Existing values are **never overwritten** — missing fields are appended on next run.

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
| `APP_URL` | — | Public URL of the system |
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
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | — | Credentials |
| `DB_PREFIX` | `gc_` | Table name prefix used across all queries |

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
| Conversations | Contact-center conversations ⇄ channels (Telegram / Instagram / Viber / Web Chat) ⇄ messages ⇄ attachments |
| Notifications | Notification outbox ⇄ per-user subscriptions ⇄ delivery attempts (in-app / email / Telegram / web push) |
| Scheduling | Calendar events ⇄ responses, reminders, per-user visibility |
| Catalog | Brands & product references used by deal line items and cart reconciliation |

> 📦 This repository contains the application code only. Import your SQL schema dump into the target database before first start.

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
GET|POST /api/contact-center/webhook/instagram                      IG webhook (raw-body signature check)
ANY  /viber/webhook/*                                               Viber bot webhook
GET  /chat/frame.html, /chat/config, /chat/widget.js, /chat/chat-sw.js, /chat/file/*
POST /chat/upload, /chat/push/{subscribe,unsubscribe}               Visitor widget endpoints
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
GET  /brands/, /clients/, /profile/, /settings/email/, /settings/integration/
*    /api/modules/*                                                  Module lifecycle (see above)
```

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
| +10 s after startup, then `5 * * * *` (hourly) | Rebuild analytics aggregates, 7-day window | `cron/analytics/rebuildStats.js` |
| `20 3 * * *` (daily 03:20) | Deep analytics rebuild, 45-day backfill | same |
| `* * * * *` (every minute) | Calendar reminder tick — dispatch due reminders | `cron/notifications/calendar-reminder-cron.js` |
| `10 4 * * *` (daily 04:10) | Calendar reminder queue cleanup | same |
| `30 4 * * *` (daily 04:30) | Refresh long-lived Instagram access tokens | `controllers/contact-center/instagram-refresh.js` |

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
- **Webhook integrity** — Instagram webhooks validated against the **raw request body** signature (Meta HMAC); Telegram webhooks protected by a per-channel secret in the URL path.
- **Input validation** — schema-based validation (`ajv`, `jsonschema`, `validator`) for all mutating endpoints; phone numbers normalized with `libphonenumber-js`.
- **Payload limits** — JSON bodies capped at 300 kB; response compression enabled.
- **Error handling** — generic error responses in production; stack traces only when `NODE_ENV=development`.

### 🔒 Secrets & key rotation cheat-sheet

| If you rotate… | Consequence |
|---|---|
| `JWT_SECRET` / `SESSION_SECRET` | All users logged out immediately (sessions + access cookies invalid) |
| `JWT_REFRESH_SECRET` | All refresh tokens invalid — everyone must re-login |
| `TFA_ENC_KEY` | ⚠️ Stored 2FA secrets become unreadable — **all users lose TOTP** unless re-enrolled |
| `APP_ENCRYPTION_KEY` | ⚠️ Encrypted integration/channel tokens (Instagram, Telegram, SMSclub) can no longer be decrypted |
| `WEBCHAT_FILE_SECRET` | Existing signed chat attachment links break (new uploads unaffected) |
| `TELEGRAM_TOKEN_KEY` | Saved Telegram bot tokens must be re-entered in the admin panel |

**Best practice:** keep a versioned, encrypted backup of `.env`; regenerate VAPID keys as a *pair* (`VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` + matching `VAPID_SUBJECT`).

---

## 🌍 Internationalization

- Engine: `i18n` package with a custom loader (`config/i18n/i18n.js`) that recursively merges JSON dictionaries.
- Language negotiation middleware selects the locale per user/request.
- **Supported locales (20):** `az`, `cs`, `de`, `en`, `es`, `es-419`, `et`, `fi`, `fr`, `hy`, `it`, `kk`, `lv`, `nl`, `no`, `pl`, `pt-BR`, `sv`, `tr`, `uk`.
- Each locale is a **folder** (`locales/<locale>/`) containing a root dictionary (`<locale>.json`) plus per-domain dictionaries (`authorization/`, `contact-center/`, `deals/`, `header.json`, `leads/`, `orders/`, `users/`). The loader deep-merges all of them at startup, so translations stay organized per feature area.
- To add a language, copy the `locales/en/` structure to `locales/<new-locale>/` and translate — no code changes required.

---

## 🚢 Deployment

Recommended production topology: **Nginx (TLS) → Node (this app) → MySQL + Redis**.

1. Set `NODE_ENV=production`, `APP_URL`, `CORS_ORIGINS`, and DB/Redis credentials in `.env`.
2. Ensure the reverse proxy sends `X-Forwarded-For` correctly (the app trusts exactly one proxy hop).
3. Run under a process manager, e.g. **systemd**:

   ```ini
   [Service]
   WorkingDirectory=/opt/growth-contour
   ExecStart=/usr/bin/node server.js
   Restart=always
   EnvironmentFile=/opt/growth-contour/.env
   User=gc
   ```

4. Register the webhook callbacks for Telegram / Instagram / Viber pointing at your public HTTPS URL (`IG_REDIRECT_URI`, webhook verify tokens, etc.).
5. Keep Redis persistent (AOF/RDB) — BullMQ queues and notification reliability depend on it.
6. Back up the MySQL database **and the `.env` file** (losing secrets invalidates sessions, 2FA, and encrypted tokens).

Health check tip: the app logs pool acquire/release events and job timings — pipe stdout into your log aggregator.

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
| Add a messaging channel | `controllers/contact-center/` (copy the Telegram or Viber adapter shape) |
| Add a notification channel | `controllers/notifications/channels/` |
| Debug slow DB | Pool diagnostics emitted by `config/database/connection_pool.js` |

### Local stack tips

- Run Redis locally with persistence enabled (`redis-server --save 60 1`) so BullMQ jobs survive restarts during development.
- Point `IG_PUBLIC_BASE`/webhooks at a tunnel (ngrok/cloudflared) when testing Instagram or Telegram callbacks.
- `NODE_ENV=development` surfaces stack traces in error pages — never expose this mode publicly.

---

## 🩺 Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `[config] відсутній авто-секрет: …` at boot | `.env` missing secrets — run `node ensure-env.js` (or `npm run prestart`) |
| Server fails on Node 18 with `process.loadEnvFile is not a function` | Upgrade to **Node 20+** |
| `Connected to Redis` never appears / jobs don't run | Redis not running at `127.0.0.1:6379` or firewalled |
| Orders/carts disappear after restart crash | Check startup logs for `recover…` messages; verify Redis persistence |
| Instagram webhook rejects (hub.challenge fails) | `IG_VERIFY_TOKEN` mismatch, or a proxy buffering the raw body (signature is computed over raw bytes) |
| Everyone logged out / 2FA errors after deploy | Secrets in `.env` were regenerated — restore the previous `.env` from backup |
| Static chat attachments blocked | Files must be under `public/uploads/`; CSP sandbox headers intentionally prevent inline execution |
| Locale not switching | Verify `locales/<code>/translation.json` exists and is valid JSON |

### 🩺 Self-check endpoints & log lines to watch

| Signal | Where | Meaning |
|---|---|---|
| `Сайт запущений. Порт: …` | stdout | HTTP server is listening |
| `[ModuleManager] All modules loaded and enabled.` | stdout | Plugin system healthy |
| `recover…` messages right after boot | stdout | Queue crash-recovery re-enqueued pending order/cart work |
| `[analytics] hourly: готово за Nс` | stdout | Aggregate rebuild cadence & duration |
| `{ pool: "promise", evt: "acquire", active: N }` | structured log (pino) | MySQL pool saturation — rising `active` near 50 means scale up or slow queries down |
| `HTTP 429` + `RateLimit-*` headers | any API response | Client exceeded its limiter budget (expected for abuse, tune env vars if legitimate traffic hits it) |

---

## 🗺 Roadmap

Ideas under consideration:

- [ ] Published SQL migration tooling (`up`/`down`) instead of raw dumps
- [ ] Package split: move `nodemon` to `devDependencies`
- [ ] Automated tests (unit for validators/processors, integration for order pipelines)
- [ ] More order providers alongside SMSclub (pluggable adapter interface already in place)
- [ ] Docker Compose quick-start stack (app + MySQL + Redis + Nginx)
- [ ] WhatsApp Business channel in the Contact Center
- [ ] Public module registry / curated module examples

Done recently ✅

- MIT licensing adopted — full text in [`LICENSE`](LICENSE).
- `engines.node >= 20.6.0` declared in `package.json`.
- Layered rate limiting hardened across all DB-backed routes (global API limiter + per-feature limiters), resolving CodeQL `js/missing-rate-limiting` alerts.

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

Looking for a way in? The best starter tasks are: translation improvements (any of the 20 locales), documentation fixes, validator schema coverage, and small UX polish in `views/pages/`.

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

© 2025 Growth Contour contributors

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
