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
		console.log("[ModuleManager] Initialized");
	}

	/**
	 * Завантаження всіх модулів з папки /modules
	 * @param {boolean} autoEnable - Автоматично активувати модулі при завантаженні
	 */
	async loadAllModules(autoEnable = false) {
		if (!fs.existsSync(this.modulesPath)) {
			console.log("[ModuleManager] Modules directory does not exist. Creating...");
			fs.mkdirSync(this.modulesPath, { recursive: true });
			return;
		}

		const moduleDirs = fs.readdirSync(this.modulesPath);

		for (const dirName of moduleDirs) {
			const moduleDir = path.join(this.modulesPath, dirName);

			// Пропускаємо якщо це не директорія
			if (!fs.statSync(moduleDir).isDirectory()) {
				continue;
			}

			// Перевіряємо наявність module.json
			const configPath = path.join(moduleDir, "module.json");
			if (!fs.existsSync(configPath)) {
				console.warn(`[ModuleManager] Skipping ${dirName}: no module.json found`);
				continue;
			}

			try {
				console.log(`[ModuleManager] Loading module from ${dirName}...`);
				this.loadModule(dirName, moduleDir, configPath);

				// Автоматична активація якщо потрібно
				if (autoEnable) {
					console.log(`[ModuleManager] Auto-enabling module: ${dirName}`);
					await this.enableModule(dirName);
				}
			} catch (error) {
				console.error(`[ModuleManager] Error loading module ${dirName}:`, error.message);
				console.error(error.stack);
			}
		}

		console.log(`[ModuleManager] Loaded ${this.modules.size} modules`);
		console.log(`[ModuleManager] Current hooks registry keys:`, Object.keys(this.hooksRegistry));
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
		const initialHooks = moduleInstance.getHooks ? moduleInstance.getHooks() : 'NO_METHOD';
		console.log(`[ModuleManager] Instance created for ${config.name}. Initial hooks:`, initialHooks);

		// Зберігаємо модуль
		this.modules.set(config.name, {
			instance: moduleInstance,
			config: config,
			path: moduleDir,
			isEnabled: false,
		});

		console.log(`[ModuleManager] Loaded module: ${config.name} v${config.version}`);
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
			result.push({
				name: name,
				version: moduleData.config.version,
				description: moduleData.config.description,
				author: moduleData.config.author,
				isEnabled: moduleData.isEnabled,
				hasConfig: moduleData.config.hasConfig || false,
			});
		});

		return result;
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