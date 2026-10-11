/**
 * =====================================================
 * МЕНЕДЖЕР МОДУЛІВ (ModuleManager.js)
 * =====================================================
 * Відповідає за:
 * - Завантаження модулів з папки /modules
 * - Активацію/деактивацію модулів
 * - Реєстрацію хуків та маршрутів
 * - Гаряче перезавантаження модулів без перезапуску сервера
 * =====================================================
 */

const fs = require("fs");
const path = require("path");

class ModuleManager {
	constructor() {
		this.modulesPath = path.join(__dirname, "..", "..", "modules");
		this.modules = new Map(); // Зберігаємо екземпляри модулів
		this.hooksRegistry = {}; // Глобальний реєстр хуків
		this.app = null; // Express додаток
	}

	/**
	 * Ініціалізація менеджера модулів
	 * @param {Object} app - Express додаток
	 */
	init(app) {
		this.app = app;
		// Єдиний роутер для всіх маршрутів модулів. Монтується в server.js ПЕРЕД обробниками 404/помилок,
		// бо модулі завантажуються асинхронно — маршрути, додані прямо в app пізніше, опинились би після 404.
		this.router = require("express").Router();
		this.mounted = new Set(); // "get /api/module/x/y" — вже зареєстровані в Express
		console.log("[ModuleManager] Initialized");
	}

	/* ═══ СТАН МОДУЛІВ (увімкнено / встановлено) — переживає перезапуск ═══ */

	/** Таблиця стану створюється ядром автоматично: нові модулі не потребують SQL */
	async ensureStateTable() {
		if (this.stateReady) return;
		const pool = require("../../config/database/connection_pool");
		const P = require("../../config/config").get("configDatabase").prefix;
		await pool.query(
			`CREATE TABLE IF NOT EXISTS ${P}modules_state (
			  name VARCHAR(64) NOT NULL,
			  enabled TINYINT(1) NOT NULL DEFAULT 1,
			  installed_at DATETIME NULL,
			  version VARCHAR(32) NULL,
			  date_upd DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			  PRIMARY KEY (name)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
		);
		this.stateReady = true;
	}

	async loadState() {
		await this.ensureStateTable();
		const pool = require("../../config/database/connection_pool");
		const P = require("../../config/config").get("configDatabase").prefix;
		const [rows] = await pool.query(`SELECT name, enabled, installed_at, version FROM ${P}modules_state`);
		return new Map(rows.map((r) => [r.name, r]));
	}

	async saveState(moduleName, patch) {
		await this.ensureStateTable();
		const pool = require("../../config/database/connection_pool");
		const P = require("../../config/config").get("configDatabase").prefix;
		const enabled = patch.enabled === undefined ? null : patch.enabled ? 1 : 0;
		await pool.query(
			`INSERT INTO ${P}modules_state (name, enabled, installed_at, version) VALUES (?, COALESCE(?, 1), IF(?, NOW(), NULL), ?)
			 ON DUPLICATE KEY UPDATE enabled = COALESCE(?, enabled), installed_at = IF(?, NOW(), installed_at), version = COALESCE(?, version)`,
			[moduleName, enabled, patch.installed ? 1 : 0, patch.version || null, enabled, patch.installed ? 1 : 0, patch.version || null]
		);
	}

	/** Після uninstall(): наступне завантаження знову викличе install() */
	async clearInstalled(moduleName) {
		await this.ensureStateTable();
		const pool = require("../../config/database/connection_pool");
		const P = require("../../config/config").get("configDatabase").prefix;
		await pool.query(`UPDATE ${P}modules_state SET installed_at = NULL, enabled = 0 WHERE name = ?`, [moduleName]);
	}

	/**
	 * Завантаження всіх модулів з папки /modules.
	 * Новий модуль (немає в modules_state): install() один раз і увімкнення — «скопіював теку — працює».
	 * Вимкнений адміністратором модуль після перезапуску лишається вимкненим.
	 * @param {boolean} autoEnable - Активувати модулі відповідно до збереженого стану
	 */
	async loadAllModules(autoEnable = false) {
		if (!fs.existsSync(this.modulesPath)) {
			console.log("[ModuleManager] Modules directory does not exist. Creating...");
			fs.mkdirSync(this.modulesPath, { recursive: true });
			return;
		}

		let state = new Map();
		try {
			state = await this.loadState();
		} catch (e) {
			console.error("[ModuleManager] Cannot read modules state, enabling all:", e.message);
		}

		for (const dirName of fs.readdirSync(this.modulesPath)) {
			const moduleDir = path.join(this.modulesPath, dirName);
			if (!fs.statSync(moduleDir).isDirectory()) continue;

			const configPath = path.join(moduleDir, "module.json");
			if (!fs.existsSync(configPath)) {
				console.warn(`[ModuleManager] Skipping ${dirName}: no module.json found`);
				continue;
			}

			try {
				console.log(`[ModuleManager] Loading module from ${dirName}...`);
				const name = this.loadModule(dirName, moduleDir, configPath);
				if (!autoEnable) continue;

				const s = state.get(name);
				const moduleData = this.modules.get(name);
				if (!s || !s.installed_at) {
					await moduleData.instance.install();
					await this.saveState(name, { installed: true, version: moduleData.config.version }).catch((e) => console.error("[ModuleManager] state", e.message));
				}
				if (s && !Number(s.enabled)) {
					console.log(`[ModuleManager] Module ${name} is disabled by administrator`);
					continue;
				}
				await this.enableModule(name);
			} catch (error) {
				console.error(`[ModuleManager] Error loading module ${dirName}:`, error.message);
				console.error(error.stack);
			}
		}

		console.log(`[ModuleManager] Loaded ${this.modules.size} modules`);
	}

	/**
	 * Завантаження конкретного модуля
	 * @param {string} dirName - Назва директорії модуля
	 * @param {string} moduleDir - Повний шлях до директорії модуля
	 * @param {string} configPath - Шлях до module.json
	 */
	loadModule(dirName, moduleDir, configPath) {
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

		// Додаємо шлях до конфігурації
		config.localPath = moduleDir;

		// Переклади модуля: modules/<name>/locales/<locale>.json — без правок ядра
		this.loadModuleLocales(config.name, moduleDir);

		// Очищаємо кеш модуля для гарячого перезавантаження
		const mainFilePath = path.join(moduleDir, "index.js");
		if (fs.existsSync(mainFilePath)) {
			delete require.cache[require.resolve(mainFilePath)];
		}

		// Імпортуємо клас модуля
		const ModuleClass = require(mainFilePath);

		// Створюємо екземпляр модуля
		const moduleInstance = new ModuleClass(config);

		// Діагностика: перевіримо, чи є хуки одразу після створення
		const initialHooks = moduleInstance.getHooks ? moduleInstance.getHooks() : "NO_METHOD";
		console.log(`[ModuleManager] Instance created for ${config.name}. Initial hooks:`, initialHooks);

		// Зберігаємо модуль
		this.modules.set(config.name, {
			instance: moduleInstance,
			config: config,
			path: moduleDir,
			isEnabled: false,
		});

		console.log(`[ModuleManager] Loaded module: ${config.name} v${config.version}`);
		return config.name;
	}

	/**
	 * Переклади модуля з теки modules/<name>/locales/<locale>.json додаються в каталог i18n.
	 * Простір modules.<name> модуль може перезаписувати (оновлення при reload),
	 * решту ключів — лише додавати, якщо їх ще немає (модуль не може зламати переклади ядра).
	 * @param {string} moduleName
	 * @param {string} moduleDir
	 */
	loadModuleLocales(moduleName, moduleDir) {
		const dir = path.join(moduleDir, "locales");
		if (!fs.existsSync(dir)) return;

		const i18n = require("../../config/i18n/i18n");
		const own = `modules.${moduleName}`;

		const merge = (target, src, keyPath) => {
			for (const [k, v] of Object.entries(src)) {
				const p = keyPath ? `${keyPath}.${k}` : k;
				const ownZone = p === own || p.startsWith(own + ".") || own.startsWith(p + ".");
				if (v && typeof v === "object" && !Array.isArray(v)) {
					if (target[k] !== undefined && (typeof target[k] !== "object" || target[k] === null)) {
						console.warn(`[ModuleManager] ${moduleName}: locale key "${p}" conflicts with core, skipped`);
						continue;
					}
					target[k] = target[k] || {};
					merge(target[k], v, p);
				} else if (target[k] === undefined || ownZone) {
					target[k] = v;
				} else {
					console.warn(`[ModuleManager] ${moduleName}: locale key "${p}" already exists in core, skipped`);
				}
			}
		};

		for (const file of fs.readdirSync(dir)) {
			const m = /^([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\.json$/.exec(file);
			if (!m) continue;
			const catalog = i18n.getCatalog(m[1]);
			if (!catalog) {
				console.warn(`[ModuleManager] ${moduleName}: locale "${m[1]}" is not configured in i18n, skipped`);
				continue;
			}
			try {
				merge(catalog, JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")), "");
				console.log(`[ModuleManager] ${moduleName}: locale ${m[1]} loaded`);
			} catch (e) {
				console.error(`[ModuleManager] ${moduleName}: invalid locale file ${file}:`, e.message);
			}
		}
	}

	/**
	 * Активація модуля
	 * @param {string} moduleName - Назва модуля
	 */
	async enableModule(moduleName) {
		const moduleData = this.modules.get(moduleName);

		if (!moduleData) {
			throw new Error(`Module ${moduleName} not found`);
		}

		if (moduleData.isEnabled) {
			console.log(`[ModuleManager] Module ${moduleName} is already enabled`);
			return;
		}

		try {
			console.log(`[ModuleManager] Enabling module: ${moduleName}...`);

			// Викликаємо метод enable модуля
			await moduleData.instance.enable();

			// Реєструємо хуки
			console.log(`[ModuleManager] Registering hooks for ${moduleName}...`);
			this.registerModuleHooks(moduleName);

			// Реєструємо маршрути
			console.log(`[ModuleManager] Registering routes for ${moduleName}...`);
			this.registerModuleRoutes(moduleName);

			moduleData.isEnabled = true;
			console.log(`[ModuleManager] Module ${moduleName} enabled successfully`);
			console.log(`[ModuleManager] Hooks registry after enable:`, Object.keys(this.hooksRegistry));
		} catch (error) {
			console.error(`[ModuleManager] Error enabling module ${moduleName}:`, error.message);
			console.error(error.stack);
			throw error;
		}
	}

	/**
	 * Деактивація модуля
	 * @param {string} moduleName - Назва модуля
	 */
	async disableModule(moduleName) {
		const moduleData = this.modules.get(moduleName);

		if (!moduleData) {
			throw new Error(`Module ${moduleName} not found`);
		}

		if (!moduleData.isEnabled) {
			console.log(`[ModuleManager] Module ${moduleName} is already disabled`);
			return;
		}

		try {
			// Викликаємо метод disable модуля
			await moduleData.instance.disable();

			// Видаляємо хуки
			this.unregisterModuleHooks(moduleName);

			// Примітка: маршрути не можна видалити з Express динамічно
			// Тому вони залишаються зареєстрованими, але обробник може перевіряти статус

			moduleData.isEnabled = false;
			console.log(`[ModuleManager] Module ${moduleName} disabled successfully`);
		} catch (error) {
			console.error(`[ModuleManager] Error disabling module ${moduleName}:`, error.message);
			throw error;
		}
	}

	/**
	 * Реєстрація хуків модуля в глобальному реєстрі
	 * @param {string} moduleName - Назва модуля
	 */
	registerModuleHooks(moduleName) {
		const moduleData = this.modules.get(moduleName);

		if (!moduleData || !moduleData.instance) {
			console.error("[ModuleManager] Cannot register hooks for " + moduleName + ": module not found");
			return;
		}

		const hooks = moduleData.instance.getHooks();

		// ВАЖЛИВА ДІАГНОСТИКА
		console.log(`[ModuleManager] DEBUG: Getting hooks for ${moduleName}`);
		console.log(`[ModuleManager] DEBUG: Raw hooks object:`, hooks);
		console.log(`[ModuleManager] DEBUG: Keys in hooks:`, Object.keys(hooks));
		console.log(`[ModuleManager] DEBUG: Is hooks empty?`, Object.keys(hooks).length === 0);

		if (!hooks || Object.keys(hooks).length === 0) {
			console.error(`[ModuleManager] WARNING: No hooks found for module ${moduleName}! Check _registerHooks in module.`);
			return;
		}

		let hooksRegisteredCount = 0;

		Object.keys(hooks).forEach((hookName) => {
			if (!this.hooksRegistry[hookName]) {
				this.hooksRegistry[hookName] = [];
			}

			const callbacks = hooks[hookName];
			if (Array.isArray(callbacks)) {
				callbacks.forEach((callback) => {
					this.hooksRegistry[hookName].push({
						moduleName,
						callback,
					});
					hooksRegisteredCount++;
				});
			} else {
				console.error(`[ModuleManager] Warning: Hook ${hookName} is not an array in module ${moduleName}`);
			}
		});

		console.log(`[ModuleManager] Registered ${hooksRegisteredCount} hook callbacks for module ${moduleName}`);
	}

	/**
	 * Видалення хуків модуля з глобального реєстру
	 * @param {string} moduleName - Назва модуля
	 */
	unregisterModuleHooks(moduleName) {
		let removedCount = 0;
		Object.keys(this.hooksRegistry).forEach((hookName) => {
			const initialLength = this.hooksRegistry[hookName].length;
			this.hooksRegistry[hookName] = this.hooksRegistry[hookName].filter((hook) => hook.moduleName !== moduleName);
			const removed = initialLength - this.hooksRegistry[hookName].length;
			removedCount += removed;

			// Видаляємо порожні масиви
			if (this.hooksRegistry[hookName].length === 0) {
				delete this.hooksRegistry[hookName];
			}
		});

		console.log(`[ModuleManager] Unregistered ${removedCount} hooks for module ${moduleName}`);
	}

	/**
	 * Реєстрація маршрутів модуля в Express
	 * @param {string} moduleName - Назва модуля
	 */
	registerModuleRoutes(moduleName) {
		const moduleData = this.modules.get(moduleName);
		const routes = moduleData.instance.getRoutes();
		const moduleInstance = moduleData.instance;

		if (!routes || routes.length === 0) {
			console.log(`[ModuleManager] No routes to register for ${moduleName}`);
			return;
		}

		routes.forEach((route) => {
			const fullPath = `/api/module/${moduleName}${route.path}`;

			// Обгортаємо обробник у try-catch для безпеки
			const safeHandler = async (req, res, next) => {
				try {
					// Перевіряємо чи активний модуль
					if (!moduleData.isEnabled) {
						return res.status(403).json({
							error: `Module ${moduleName} is disabled`,
						});
					}

					await route.handler.call(moduleInstance, req, res, next);
				} catch (error) {
					console.error(`[Module ${moduleName}] Route error:`, error.message);
					next(error);
				}
			};

			// Реєструємо маршрут в Express
			const method = route.method.toLowerCase();
			if (this.app[method]) {
				this.app[method](fullPath, safeHandler);
				console.log(`[ModuleManager] Registered route: ${method.toUpperCase()} ${fullPath}`);
			} else {
				console.error(`[ModuleManager] Invalid HTTP method: ${method} for module ${moduleName}`);
			}
		});
	}

	registerModuleRoutes(moduleName) {
		const moduleData = this.modules.get(moduleName);
		const routes = moduleData.instance.getRoutes();

		// Таблиця маршрутів поточного екземпляра: після reload обробник бере новий екземпляр, без повторної реєстрації
		moduleData.routeTable = new Map();

		if (!routes || routes.length === 0) {
			console.log(`[ModuleManager] No routes to register for ${moduleName}`);
			return;
		}

		// Запуск middleware маршруту (напр. isAuthenticated): true — викликано next(), false — middleware вже відповів
		const runMiddleware = (mw, req, res) =>
			new Promise((resolve, reject) => {
				let called = false;
				const next = (err) => {
					called = true;
					return err ? reject(err) : resolve(true);
				};
				Promise.resolve(mw(req, res, next))
					.then(() => {
						if (!called) resolve(false);
					})
					.catch(reject);
			});

		routes.forEach((route) => {
			const method = String(route.method || "").toLowerCase();
			if (!["get", "post", "put", "patch", "delete"].includes(method)) {
				console.error(`[ModuleManager] Invalid HTTP method: ${method} for module ${moduleName}`);
				return;
			}
			// page: true — сторінка /modules/<name>/...; інакше API /api/module/<name>/...
			const fullPath = (route.page ? `/modules/${moduleName}` : `/api/module/${moduleName}`) + route.path;
			const key = `${method} ${fullPath}`;
			moduleData.routeTable.set(key, route);

			if (this.mounted.has(key)) return;
			this.mounted.add(key);

			this.router[method](fullPath, async (req, res, next) => {
				const current = this.modules.get(moduleName);
				const r = current && current.routeTable && current.routeTable.get(key);
				if (!current || !current.isEnabled || !r) {
					return res.status(current && !current.isEnabled ? 403 : 404).json({ error: `Module ${moduleName} is disabled or route not found` });
				}
				try {
					for (const mw of r.middlewares || []) {
						if (!(await runMiddleware(mw, req, res))) return;
					}
					await r.handler.call(current.instance, req, res, next);
				} catch (error) {
					console.error(`[Module ${moduleName}] Route error:`, error.message);
					next(error);
				}
			});
			console.log(`[ModuleManager] Registered route: ${method.toUpperCase()} ${fullPath}`);
		});
	}

	/**
	 * Отримання списку всіх хуків для виклику в шаблоні
	 * @param {string} hookName - Назва хука
	 * @param {Object} params - Параметри для передачі в хук
	 * @returns {Promise<Array>} - Масив результатів від всіх модулів
	 */
	async execHook(hookName, params = {}) {
		if (!this.hooksRegistry[hookName]) {
			return [];
		}

		const results = [];

		for (const hook of this.hooksRegistry[hookName]) {
			try {
				// Перевіряємо чи активний модуль
				const moduleData = this.modules.get(hook.moduleName);
				if (!moduleData || !moduleData.isEnabled) {
					continue;
				}

				const result = await hook.callback.call(moduleData.instance, params);
				if (result !== null && result !== undefined) {
					results.push(result);
				}
			} catch (error) {
				console.error(`[ModuleManager] Error executing hook ${hookName} in ${hook.moduleName}:`, error.message);
			}
		}

		return results;
	}

	/**
	 * Middleware для використання хуків в EJS шаблонах
	 */
	hooksMiddleware() {
		return (req, res, next) => {
			// Додаємо функцію hook в локальні змінні шаблону
			res.locals.hook = (hookName, params = {}) => {
				// Тихий лог, щоб не засмічувати консоль при кожному рендері, якщо треба увімкніть
				// console.log(`[HOOK CALL] Template requested hook: "${hookName}"`);

				if (!this.hooksRegistry[hookName]) {
					// console.log(`[HOOK CALL] No hooks found for "${hookName}". Available:`, Object.keys(this.hooksRegistry));
					return "";
				}

				const results = [];

				for (const hook of this.hooksRegistry[hookName]) {
					try {
						const moduleData = this.modules.get(hook.moduleName);

						if (!moduleData) {
							console.error(`[HOOK CALL] Module ${hook.moduleName} not found in manager`);
							continue;
						}

						if (!moduleData.isEnabled) {
							console.log(`[HOOK CALL] Module ${hook.moduleName} is disabled`);
							continue;
						}

						// Викликаємо хук синхронно
						const result = hook.callback.call(moduleData.instance, params);

						if (result && typeof result.then === "function") {
							console.error(`[HOOK CALL] Hook ${hookName} returned a Promise (should be sync)`);
							continue;
						}

						if (result !== null && result !== undefined) {
							results.push(result);
						}
					} catch (error) {
						console.error(`[HOOK CALL] Error in ${hook.moduleName}:`, error.message);
					}
				}

				return results.join("\n");
			};
			next();
		};
	}

	/**
	 * Перезавантаження модуля (гаряче оновлення)
	 * @param {string} moduleName - Назва модуля
	 */
	async reloadModule(moduleName) {
		const moduleData = this.modules.get(moduleName);

		if (!moduleData) {
			throw new Error(`Module ${moduleName} not found`);
		}

		const wasEnabled = moduleData.isEnabled;

		// Вимикаємо модуль
		if (wasEnabled) {
			await this.disableModule(moduleName);
		}

		// Перечитуємо переклади модуля
		this.loadModuleLocales(moduleName, moduleData.path);

		// Перезавантажуємо файл модуля
		const mainFilePath = path.join(moduleData.path, "index.js");
		delete require.cache[require.resolve(mainFilePath)];

		// Створюємо новий екземпляр
		const ModuleClass = require(mainFilePath);
		moduleData.instance = new ModuleClass(moduleData.config);

		// Вмикаємо назад якщо був активний
		if (wasEnabled) {
			await this.enableModule(moduleName);
		}

		console.log(`[ModuleManager] Reloaded module ${moduleName}`);
	}

	/**
	 * Отримання інформації про всі модулі
	 * @returns {Array}
	 */
	getAllModules() {
		const result = [];

		this.modules.forEach((moduleData, name) => {
			const c = moduleData.config;
			// Сторінка налаштувань: явно з module.json (settings_url) або сторінка модуля GET "/" (page: true)
			const hasPage = (moduleData.instance.getRoutes() || []).some((r) => r.page && String(r.method).toLowerCase() === "get" && r.path === "/");
			result.push({
				name: name,
				version: c.version,
				description: c.description,
				author: c.author,
				icon: c.icon || null,
				isEnabled: moduleData.isEnabled,
				hasConfig: c.hasConfig || false,
				settingsUrl: c.settings_url || (hasPage ? `/modules/${name}/` : null),
			});
		});

		return result.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Отримання інформації про конкретний модуль
	 * @param {string} moduleName - Назва модуля
	 * @returns {Object|null}
	 */
	getModule(moduleName) {
		const moduleData = this.modules.get(moduleName);

		if (!moduleData) {
			return null;
		}

		return {
			name: moduleName,
			version: moduleData.config.version,
			description: moduleData.config.description,
			author: moduleData.config.author,
			isEnabled: moduleData.isEnabled,
			config: moduleData.config,
		};
	}
}

// Створюємо singleton екземпляр
const moduleManager = new ModuleManager();

module.exports = moduleManager;
