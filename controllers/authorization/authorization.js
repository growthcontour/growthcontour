/**
 * ===================================================================
 * ФАЙЛ: controllers/authorization/authorization.js
 * ОПИС: Головний контролер авторизації (Login, Register, 2FA, Password Reset)
 * ВЕРСІЯ: 4.0 (MAX SECURITY + LEGACY SUPPORT)
 * ЗАХИСТ: 12 рівнів реалізовано в методі login()
 * ===================================================================
 */

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const db = require("../../config/database/connection_pool");
const config = require("../../config/config");
const { jwt: jwtCfg } = config.get("configJWT");
const { validateLoginInput } = require("../../validator/authorization/login"); // Новий AJV валідатор

// ─── Конфігурація БД ─────────────────────────────────────────────────────────
const prefix = config.get("configDatabase").prefix;

// Константи безпеки
const SALT_ROUNDS = 12;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 хвилин блокування
const JWT_EXPIRES_IN = "24h";
const REFRESH_EXPIRES_IN = "90d";

// ---------------------------------------------------------------------
// ДОПОМІЖНІ ФУНКЦІЇ БЕЗПЕКИ
// ---------------------------------------------------------------------

/**
 * Отримує реальну IP клієнта (враховує проксі Cloudflare/Nginx)
 */
const getClientIP = (req) => {
	const forwarded = req.headers["x-forwarded-for"];
	if (forwarded) return forwarded.split(",")[0].trim();
	return req.socket.remoteAddress || req.ip || "unknown";
};

/**
 * Генерує унікальний відбиток пристрою (Fingerprint)
 */
const getDeviceFingerprint = (req) => {
	const ua = req.headers["user-agent"] || "unknown";
	const ip = getClientIP(req);
	return crypto.createHash("sha256").update(`${ip}|${ua}`).digest("hex").substring(0, 32);
};

/**
 * Логує події безпеки в БД (для аудиту та детекту атак)
 */
const logSecurityEvent = async (userId, ip, eventType, details, userAgent) => {
	try {
		await db.execute(
			`
      INSERT INTO ${prefix}users_security_events 
      (id_user, ip_address, event_type, user_agent, details, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())
    `,
			[userId, ip, eventType, userAgent, JSON.stringify(details)]
		);
	} catch (err) {
		console.error("[SECURITY LOG ERROR]:", err.message);
	}
};

// Використовуємо ту саму перевірку, що й tfa_settings.js — єдине джерело істини.
const tfa = require("../../helpers/tfa");

/**
 * Перевірка TOTP-коду при вході.
 * secretStored — зашифрований секрет із БД (поле tfa_secret).
 * lastStep — значення tfa_last_step користувача (захист від reuse коду).
 * Повертає { ok, step }.
 */
const verifyTOTP = (secretStored, token, lastStep = 0) => {
	if (!secretStored || !token) return { ok: false };
	return tfa.verifyTotp(secretStored, tfa.normalizeCode(token), lastStep);
};

// ---------------------------------------------------------------------
// ОСНОВНІ МЕТОДИ КОНТРОЛЕРА
// ---------------------------------------------------------------------

const authorizationControllers = {
	/**
	 * ---------------------------------------------------------------
	 * МЕТОД: LOGIN (Максимальний захист)
	 * ---------------------------------------------------------------
	 * Реалізовані захисти:
	 * 1. AJV Валідація вхідних даних
	 * 2. Race Condition Protection (FOR UPDATE)
	 * 3. Enumeration Attack Protection (універсальні помилки)
	 * 4. Brute-force Protection (блокування акаунту)
	 * 5. Constant-time password comparison (bcrypt)
	 * 6. 2FA перевірка
	 * 7. Session Hygiene (скидання лічильників)
	 * 8. Device Tracking (збереження сесії)
	 * 9. Secure JWT Generation
	 * 10. Secure Cookies (HttpOnly, SameSite=strict)
	 * 11. Security Logging
	 * 12. Transaction Safety
	 */
	login: async (req, res) => {
		const clientIP = getClientIP(req);
		const userAgent = req.headers["user-agent"] || "unknown";
		const deviceFingerprint = getDeviceFingerprint(req);

		let connection;
		let tfaStepUsed = null; // крок TOTP для anti-replay; лишається null при вході без TOTP

		try {
			// КРОК 1: Валідація вхідних даних через AJV
			const validation = validateLoginInput(req.body);
			if (!validation.valid) {
				await logSecurityEvent(null, clientIP, "invalid_request", validation.errors, userAgent);
				// Для API: повертаємо errors із полем field, щоб фронт підсвітив конкретні інпути.
				if (req.xhr || req.headers.accept.indexOf("json") > -1) {
					return res.status(400).json({
						status: "error",
						message: "Invalid input data",
						errors: validation.errors, // [{ field: "email", message, keyword }, ...]
					});
				}

				// Для форми
				return res.render("pages/administrator/authorization/login/login", {
					error: "Некоректні дані форми",
					email: req.body.email || "",
					status: null,
				});
			}

			const { email, password, two_factor_code, remember_me } = req.body;
			const normalizedEmail = email.toLowerCase().trim();

			// КРОК 2: Початок транзакції та блокування рядка (Race Condition)
			connection = await db.getConnection();
			await connection.beginTransaction();

			const [lockRows] = await connection.execute(
				`
					SELECT id, failed_login_attempts, locked_until, active 
					FROM ${prefix}users 
					WHERE email = ? 
					FOR UPDATE
				`,
				[normalizedEmail]
			);

			// КРОК 3: Захист від Enumeration (якщо юзера немає)
			if (lockRows.length === 0) {
				await new Promise((r) => setTimeout(r, 200)); // Імітація затримки обчислень
				await connection.rollback();
				await logSecurityEvent(null, clientIP, "login_failed_unknown_user", { email: normalizedEmail }, userAgent);

				const msg = "Невірний email або пароль";
				if (req.xhr || req.headers.accept.indexOf("json") > -1) {
					return res.status(401).json({ status: "invalid", message: msg });
				}
				return res.render("pages/administrator/authorization/login/login", {
					error: msg,
					email: normalizedEmail,
					status: null,
				});
			}

			const user = lockRows[0];

			// КРОК 4: Перевірка блокування (Brute-force)
			if (user.locked_until && new Date(user.locked_until) > new Date()) {
				await connection.rollback();
				const remainingTime = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
				await logSecurityEvent(user.id, clientIP, "login_blocked", { remaining_minutes: remainingTime }, userAgent);

				const msg = `Акаунт заблоковано на ${remainingTime} хв.`;
				if (req.xhr || req.headers.accept.indexOf("json") > -1) {
					return res.status(423).json({ status: "locked", message: msg, errors: [{ field: "locked", minutes: remainingTime }] });
				}
				return res.render("pages/administrator/authorization/login/login", {
					error: msg,
					email: normalizedEmail,
					status: "locked",
					message: msg,
				});
			}

			// КРОК 5: Перевірка активності акаунту
			if (user.active !== 1) {
				await connection.rollback();
				await logSecurityEvent(user.id, clientIP, "login_inactive", { status_code: user.active }, userAgent);

				const msg = "Акаунт неактивний або заблокований адміністратором";

				if (req.xhr || req.headers.accept.indexOf("json") > -1) {
					return res.status(401).json({ status: "invalid", message: msg, errors: [{ field: "account_not_active" }] });
				}

				return res.render("pages/administrator/authorization/login/login", {
					error: msg,
					email: normalizedEmail,
					status: null,
				});
			}

			// КРОК 6: Отримання повних даних користувача
			const [userRows] = await connection.execute(
				`
					SELECT id, email, password, first_name, last_name, id_lang, tfa_enabled, tfa_secret, tfa_last_step, token_version
					FROM ${prefix}users 
					WHERE id = ?
				`,
				[user.id]
			);

			const fullUser = userRows[0];

			// КРОК 7: Перевірка пароля (bcrypt)
			const isPasswordValid = await bcrypt.compare(password, fullUser.password);

			if (!isPasswordValid) {
				const newFailedCount = user.failed_login_attempts + 1;
				const shouldLock = newFailedCount >= LOCKOUT_THRESHOLD;

				await connection.execute(
					`
					UPDATE ${prefix}users 
					SET failed_login_attempts = ?, locked_until = ?, date_edit = NOW()
					WHERE id = ?
					`,
					[newFailedCount, shouldLock ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null, fullUser.id]
				);

				await connection.commit();
				await logSecurityEvent(fullUser.id, clientIP, "login_failed_invalid_password", { attempt: newFailedCount }, userAgent);

				const msg = "Невірний email або пароль";

				if (req.xhr || req.headers.accept.indexOf("json") > -1) {
					return res.status(401).json({ status: "invalid", message: msg });
				}

				return res.render("pages/administrator/authorization/login/login", {
					error: msg,
					email: normalizedEmail,
					status: null,
				});
			}

			// КРОК 8: Перевірка 2FA
			if (fullUser.tfa_enabled) {
				if (!two_factor_code) {
					await connection.rollback();

					// Пароль вірний — фіксуємо проміжний стан у серверній сесії.
					// Пароль клієнту НЕ повертаємо; другий крок піде на /login/tfa/.
					req.session.pending_tfa = {
						userId: fullUser.id,
						createdAt: Date.now(),
					};

					if (req.xhr || req.headers.accept.indexOf("json") > -1) {
						return res.status(200).json({
							status: "tfa_required",
							message: "Потрібен код 2FA",
						});
					}
					return res.render("pages/administrator/authorization/login/login", {
						status: "tfa_required",
						email: normalizedEmail,
						error: null,
					});
				}

				const isBackup = req.body.backup === "true" || req.body.backup === true;
				let tfaOk = false;

				if (isBackup) {
					// Вхід за одноразовим резервним кодом
					const rawBackup = tfa.normalizeCode(two_factor_code);
					if (tfa.isValidBackupFormat(rawBackup)) {
						const codeHash = tfa.hashBackupCode(rawBackup);
						const [bRows] = await connection.execute(
							`SELECT id FROM ${prefix}users_tfa_backup_codes
							 WHERE id_user = ? AND code_hash = ? AND used_at IS NULL
							 LIMIT 1 FOR UPDATE`,
							[fullUser.id, codeHash]
						);
						if (bRows.length > 0) {
							tfaOk = true;
							// Гасимо використаний код у цій же транзакції
							await connection.execute(`UPDATE ${prefix}users_tfa_backup_codes SET used_at = NOW() WHERE id = ?`, [bRows[0].id]);
						}
					}
				} else {
					const totpResult = verifyTOTP(fullUser.tfa_secret, two_factor_code, fullUser.tfa_last_step);
					if (totpResult.ok) {
						tfaOk = true;
						tfaStepUsed = totpResult.step;
					}
				}

				if (!tfaOk) {
					await connection.rollback();
					await logSecurityEvent(fullUser.id, clientIP, "login_failed_invalid_2fa", { backup: isBackup }, userAgent);
					const msg = "Невірний код 2FA";
					if (req.xhr || req.headers.accept.indexOf("json") > -1) {
						return res.status(401).json({ status: "invalid", message: msg });
					}
					return res.render("pages/administrator/authorization/login/login", {
						error: msg,
						email: normalizedEmail,
						status: "tfa_required",
					});
				}
			}

			// КРОК 9: Успішний вхід - оновлення даних.
			// tfaStepUsed фіксуємо тільки якщо вхід був за TOTP (не backup) — anti-replay.
			await connection.execute(
				`
					UPDATE ${prefix}users 
					SET failed_login_attempts = 0, locked_until = NULL,
						last_login_ip = ?, date_last_login = NOW(),
						tfa_last_step = ${tfaStepUsed !== null ? "GREATEST(tfa_last_step, ?)" : "tfa_last_step"},
						token_version = token_version + 1, date_edit = NOW()
					WHERE id = ?
				`,
				tfaStepUsed !== null ? [clientIP, tfaStepUsed, fullUser.id] : [clientIP, fullUser.id]
			);

			// КРОК 10: Збереження сесії в БД
			const expiresAt = remember_me ? "DATE_ADD(NOW(), INTERVAL 30 DAY)" : "DATE_ADD(NOW(), INTERVAL 24 HOUR)";
			await connection.execute(
				`
					INSERT INTO ${prefix}users_sessions 
					(id_user, ip_address, user_agent, device_fingerprint, created_at, expires_at, is_valid)
					VALUES (?, ?, ?, ?, NOW(), ${expiresAt}, 1)
					ON DUPLICATE KEY UPDATE last_activity = NOW(), ip_address = VALUES(ip_address), is_valid = 1
				`,
				[fullUser.id, clientIP, userAgent, deviceFingerprint]
			);

			await connection.commit();

			// КРОК 11: Генерація JWT токенів
			const accessTokenPayload = {
				userId: fullUser.id,
				email: fullUser.email,
				firstName: fullUser.first_name,
				lastName: fullUser.last_name,
				type: "access",
				id_lang: fullUser.id_lang || 1,
				jti: crypto.randomUUID(),
				iat: Math.floor(Date.now() / 1000),
				token_version: fullUser.token_version + 1,
			};

			const refreshTokenPayload = {
				userId: fullUser.id,
				type: "refresh",
				jti: crypto.randomUUID(),
				iat: Math.floor(Date.now() / 1000),
			};

			const accessToken = jwt.sign(accessTokenPayload, jwtCfg.jwt_secret, { expiresIn: JWT_EXPIRES_IN });
			const refreshToken = jwt.sign(refreshTokenPayload, jwtCfg.jwt_refresh_secret, { expiresIn: REFRESH_EXPIRES_IN });

			// КРОК 12: Встановлення безпечних Cookie
			const cookieOptions = {
				httpOnly: true,
				secure: process.env.NODE_ENV === "production",
				sameSite: "strict",
				path: "/",
				maxAge: remember_me ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000,
			};

			res.cookie("access_token", accessToken, cookieOptions);
			res.cookie("refresh_token", refreshToken, { ...cookieOptions, maxAge: 90 * 24 * 60 * 60 * 1000 });

			await logSecurityEvent(fullUser.id, clientIP, "login_success", { device: deviceFingerprint }, userAgent);

			// Відповідь клієнту
			if (req.xhr || req.headers.accept.indexOf("json") > -1) {
				return res.json({
					status: "success",
					url: "/",
					message: "Login successful",
					data: {
						user: { id: fullUser.id, email: fullUser.email },
						tokens: { access_token: accessToken, refresh_token: refreshToken },
					},
				});
			}

			return res.redirect("/");
		} catch (error) {
			if (connection) await connection.rollback();
			console.error("[LOGIN CRITICAL ERROR]:", error);
			await logSecurityEvent(null, clientIP, "login_system_error", { error: error.message }, userAgent);

			if (req.xhr || req.headers.accept.indexOf("json") > -1) {
				return res.status(500).json({ status: "error", message: "Internal server error" });
			}
			return res.render("pages/administrator/authorization/login/login", {
				error: "Внутрішня помилка сервера. Спробуйте пізніше.",
				email: req.body?.email || "",
				status: null,
			});
		} finally {
			if (connection) connection.release();
		}
	},

	/**
	 * ---------------------------------------------------------------
	 * МЕТОД: REGISTER (Реєстрація) - Збережено стару логіку
	 * ---------------------------------------------------------------
	 */
	register: async (req, res) => {
		// Тут залишається ваша стара логіка реєстрації
		// Можна додати валідацію через validateLoginInput якщо потрібно
		try {
			const { email, password, first_name, last_name } = req.body;

			// Базова валідація
			if (!email || !password || !first_name) {
				return res.status(400).json({ status: "error", message: "Всі поля обов'язкові" });
			}

			const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

			// Перевірка наявності email
			const [existing] = await db.execute(`SELECT id FROM ${prefix}users WHERE email = ?`, [email]);
			if (existing.length > 0) {
				return res.status(400).json({ status: "error", message: "Email вже зайнятий" });
			}

			// Створення користувача
			await db.execute(
				`
					INSERT INTO ${prefix}users (email, password, first_name, last_name, active, date_add, date_edit)
					VALUES (?, ?, ?, ?, 1, NOW(), NOW())
				`,
				[email, hashedPassword, first_name, last_name]
			);

			res.json({ status: "success", message: "Реєстрація успішна" });
		} catch (error) {
			console.error("[REGISTER ERROR]:", error);
			res.status(500).json({ status: "error", message: "Помилка реєстрації" });
		}
	},

	/**
	 * ---------------------------------------------------------------
	 * МЕТОД: forgotPassword (Скидання паролю) - Збережено стару логіку
	 * ---------------------------------------------------------------
	 */
	forgotPassword: async (req, res) => {
		// Ваша стара логіка скидання паролю
		try {
			const { email } = req.body;
			if (!email) return res.status(400).json({ status: "error", message: "Email обов'язковий" });

			const token = crypto.randomBytes(32).toString("hex");
			const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
			const expires = new Date(Date.now() + 3600000); // 1 година

			// У БД зберігаємо лише ХЕШ. Витік БД не дасть валідних токенів скидання.
			await db.execute(
				`
					UPDATE ${prefix}users 
					SET reset_token = ?, reset_token_expires = ? 
					WHERE email = ?
				`,
				[tokenHash, expires, email]
			);

			// У листі надсилаємо СИРИЙ token (не хеш):
			// await sendEmail(email, `.../reset?token=${token}`);

			// Тут має бути відправка email з посиланням
			// await sendEmail(...)

			// Защита від enumeration: завжди повертаємо успіх
			res.json({ status: "success", message: "Якщо email існує, ви отримаєте лист для скидання паролю" });
		} catch (error) {
			console.error("[FORGOT PASSWORD ERROR]:", error);
			res.status(500).json({ status: "error", message: "Помилка сервера" });
		}
	},

	/**
	 * ---------------------------------------------------------------
	 * МЕТОД: resetPassword (Встановлення нового паролю) - Збережено
	 * ---------------------------------------------------------------
	 */
	resetPassword: async (req, res) => {
		// Ваша стара логіка встановлення нового паролю
		try {
			const { token, password } = req.body;
			if (!token || !password) return res.status(400).json({ status: "error", message: "Всі поля обов'язкові" });

			// Мінімальна перевірка складності (AJV login-схема вимагає 8+; тримаємо консистентно).
			if (typeof password !== "string" || password.length < 8 || password.length > 128) {
				return res.status(400).json({ status: "error", message: "Пароль має містити від 8 до 128 символів" });
			}

			const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
			const [users] = await db.execute(
				`
					SELECT id FROM ${prefix}users 
					WHERE reset_token = ? AND reset_token_expires > NOW()
				`,
				[tokenHash]
			);

			if (users.length === 0) {
				return res.status(400).json({ status: "error", message: "Токен недійсний або прострочений" });
			}

			const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
			await db.execute(
				`
					UPDATE ${prefix}users 
					SET password = ?, reset_token = NULL, reset_token_expires = NULL, date_edit = NOW()
					WHERE id = ?
				`,
				[hashedPassword, users[0].id]
			);

			res.json({ status: "success", message: "Пароль успішно змінено" });
		} catch (error) {
			console.error("[RESET PASSWORD ERROR]:", error);
			res.status(500).json({ status: "error", message: "Помилка сервера" });
		}
	},

	/**
	 * Фабрика middleware перевірки прав доступу.
	 * Використання: checkPermission("users.list", "view")
	 * daction: view | add | edit | delete
	 * Має стояти ПІСЛЯ isAuthenticated (потребує req.user).
	 */
	checkPermission: (slug, action = "view") => {
		const columnByAction = {
			view: "can_view",
			add: "can_add",
			edit: "can_edit",
			delete: "can_delete",
		};
		const column = columnByAction[action] || "can_view";

		return async (req, res, next) => {
			try {
				if (!req.user || !req.user.userId) {
					return res.status(401).json({ status: "error", message: "Unauthorized" });
				}

				// Чи має користувач у якійсь зі своїх груп потрібний доступ до сторінки за slug.
				const [rows] = await db.execute(
					`SELECT 1
					 FROM ${prefix}users_to_groups utg
					 JOIN ${prefix}users_groups_permissions ugp ON ugp.id_group = utg.id_group
					 JOIN ${prefix}users_permissions_pages upp ON upp.id = ugp.id_page
					 WHERE utg.id_user = ? AND upp.slug = ? AND ugp.${column} = 1
					 LIMIT 1`,
					[req.user.userId, slug]
				);

				if (rows.length === 0) {
					return res.status(403).json({ status: "error", message: "Forbidden" });
				}

				next();
			} catch (error) {
				console.error("[CHECK PERMISSION ERROR]:", error);
				return res.status(500).json({ status: "error", message: "Internal server error" });
			}
		};
	},

	hasPermission: (req, slug, action = "view") => {
		return req.user?.permissions?.[slug]?.[action] === true;
	},

	/**
	 * Другий крок входу: перевірка коду 2FA.
	 * userId береться ВИКЛЮЧНО з серверної сесії (pending_tfa),
	 * а не з клієнта — пароль на цьому кроці не фігурує.
	 */
	loginTfa: async (req, res) => {
		const clientIP = getClientIP(req);
		const userAgent = req.headers["user-agent"] || "unknown";
		const deviceFingerprint = getDeviceFingerprint(req);

		const pending = req.session && req.session.pending_tfa;
		// Проміжний стан живе обмежено (5 хв) — інакше вважаємо challenge простроченим.
		if (!pending || Date.now() - pending.createdAt > 5 * 60 * 1000) {
			if (req.session) delete req.session.pending_tfa;
			return res.status(440).json({ status: "challenge_expired", message: "Сесія входу спливла" });
		}

		const { two_factor_code, backup } = req.body;
		if (!two_factor_code) {
			return res.status(400).json({ status: "error", message: "Потрібен код 2FA" });
		}

		let connection;
		try {
			connection = await db.getConnection();
			await connection.beginTransaction();

			const [rows] = await connection.execute(
				`SELECT id, email, first_name, last_name, id_lang, tfa_secret, tfa_last_step,
						tfa_failed_attempts, tfa_locked_until, token_version, active
				 FROM ${prefix}users WHERE id = ? FOR UPDATE`,
				[pending.userId]
			);
			if (rows.length === 0 || rows[0].active !== 1) {
				await connection.rollback();
				delete req.session.pending_tfa;
				return res.status(401).json({ status: "error", message: "Unauthorized" });
			}
			const user = rows[0];

			// Блокування 2FA після серії невдалих кодів (окреме від парольного).
			if (user.tfa_locked_until && new Date(user.tfa_locked_until) > new Date()) {
				await connection.rollback();
				const mins = Math.ceil((new Date(user.tfa_locked_until) - new Date()) / 60000);
				return res.status(423).json({ status: "locked", errors: [{ minutes: mins }] });
			}

			const isBackup = backup === "true" || backup === true;
			let tfaOk = false;
			let tfaStepUsed = null;

			if (isBackup) {
				const raw = tfa.normalizeCode(two_factor_code);
				if (tfa.isValidBackupFormat(raw)) {
					const [b] = await connection.execute(
						`SELECT id FROM ${prefix}users_tfa_backup_codes
						 WHERE id_user = ? AND code_hash = ? AND used_at IS NULL LIMIT 1 FOR UPDATE`,
						[user.id, tfa.hashBackupCode(raw)]
					);
					if (b.length > 0) {
						tfaOk = true;
						await connection.execute(`UPDATE ${prefix}users_tfa_backup_codes SET used_at = NOW() WHERE id = ?`, [b[0].id]);
					}
				}
			} else {
				const r = verifyTOTP(user.tfa_secret, two_factor_code, user.tfa_last_step);
				if (r.ok) {
					tfaOk = true;
					tfaStepUsed = r.step;
				}
			}

			if (!tfaOk) {
				const failed = user.tfa_failed_attempts + 1;
				const lock = failed >= LOCKOUT_THRESHOLD;
				await connection.execute(
					`UPDATE ${prefix}users
					 SET tfa_failed_attempts = ?, tfa_locked_until = ?
					 WHERE id = ?`,
					[failed, lock ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null, user.id]
				);
				await connection.commit();
				await logSecurityEvent(user.id, clientIP, "login_failed_invalid_2fa", { backup: isBackup }, userAgent);
				return res.status(401).json({ status: "invalid", message: "Невірний код 2FA" });
			}

			// Успіх: скидаємо лічильники, фіксуємо TOTP-крок, піднімаємо версію токенів.
			await connection.execute(
				`UPDATE ${prefix}users
				 SET failed_login_attempts = 0, locked_until = NULL,
					 tfa_failed_attempts = 0, tfa_locked_until = NULL,
					 last_login_ip = ?, date_last_login = NOW(),
					 tfa_last_step = ${tfaStepUsed !== null ? "GREATEST(tfa_last_step, ?)" : "tfa_last_step"},
					 token_version = token_version + 1, date_edit = NOW()
				 WHERE id = ?`,
				tfaStepUsed !== null ? [clientIP, tfaStepUsed, user.id] : [clientIP, user.id]
			);

			await connection.execute(
				`INSERT INTO ${prefix}users_sessions
				 (id_user, ip_address, user_agent, device_fingerprint, created_at, expires_at, is_valid)
				 VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 24 HOUR), 1)
				 ON DUPLICATE KEY UPDATE last_activity = NOW(), ip_address = VALUES(ip_address), is_valid = 1`,
				[user.id, clientIP, userAgent, deviceFingerprint]
			);

			await connection.commit();

			const accessToken = jwt.sign(
				{
					userId: user.id,
					email: user.email,
					firstName: user.first_name,
					lastName: user.last_name,
					type: "access",
					id_lang: user.id_lang || 1,
					jti: crypto.randomUUID(),
					token_version: user.token_version + 1,
				},
				jwtCfg.jwt_secret,
				{ expiresIn: JWT_EXPIRES_IN }
			);

			const cookieOptions = {
				httpOnly: true,
				secure: process.env.NODE_ENV === "production",
				sameSite: "strict",
				path: "/",
				maxAge: 24 * 60 * 60 * 1000,
			};
			res.cookie("access_token", accessToken, cookieOptions);

			// Проміжний стан більше не потрібен.
			delete req.session.pending_tfa;

			await logSecurityEvent(user.id, clientIP, "login_success", { via: "2fa" }, userAgent);
			return res.json({ status: "success", url: "/" });
		} catch (error) {
			if (connection) await connection.rollback();
			console.error("[LOGIN TFA ERROR]:", error);
			return res.status(500).json({ status: "error", message: "Internal server error" });
		} finally {
			if (connection) connection.release();
		}
	},

	/**
	 * ---------------------------------------------------------------
	 * МЕТОДИ 2FA (TFA Settings) - Збережено стару логіку
	 * ---------------------------------------------------------------
	 * Ці методи викликаються з routes через tfaSettingsControllers
	 * Переконайтеся, що вони експортовані або винесені в окремий файл
	 */
	isAuthenticated: async (req, res, next) => {
		// Браузерний перехід → redirect на /login/. API/AJAX → JSON 401.
		const denyAuth = (msg) => {
			if (req.xhr || (req.headers.accept || "").indexOf("json") > -1) {
				return res.status(401).json({ status: "error", message: msg });
			}
			return res.redirect("/login/");
		};

		const token = req.cookies.access_token;
		if (!token) return denyAuth("Unauthorized");

		try {
			const decoded = jwt.verify(token, jwtCfg.jwt_secret);

			// Звірка token_version: інвалідує старі токени після зміни пароля,
			// вимкнення 2FA чи примусового виходу з усіх пристроїв.
			const [rows] = await db.execute(`SELECT token_version FROM ${prefix}users WHERE id = ?`, [decoded.userId]);
			if (rows.length === 0 || rows[0].token_version !== decoded.token_version) {
				res.clearCookie("access_token");
				return denyAuth("Token revoked");
			}

			// Для сумісності з усіма роутами й шаблонами, де використовується user.id:
			// додаємо id як аліас до userId з токена.
			decoded.id = decoded.userId;
			req.user = decoded;
			// Робимо користувача доступним у всіх EJS-шаблонах як `user`.
			res.locals.user = decoded;

			// Матриця прав один раз на запит: slug -> {view,add,edit,delete}.
			const [permRows] = await db.execute(
				`SELECT upp.slug,
						MAX(ugp.can_view)   AS can_view,
						MAX(ugp.can_add)    AS can_add,
						MAX(ugp.can_edit)   AS can_edit,
						MAX(ugp.can_delete) AS can_delete
				 FROM ${prefix}users_to_groups utg
				 JOIN ${prefix}users_groups_permissions ugp ON ugp.id_group = utg.id_group
				 JOIN ${prefix}users_permissions_pages upp ON upp.id = ugp.id_page
				 WHERE utg.id_user = ?
				 GROUP BY upp.slug`,
				[decoded.userId]
			);
			const perms = {};
			for (const r of permRows) {
				perms[r.slug] = {
					view: r.can_view === 1,
					add: r.can_add === 1,
					edit: r.can_edit === 1,
					delete: r.can_delete === 1,
				};
			}
			req.user.permissions = perms;
			res.locals.can = (s, a = "view") => req.user.permissions?.[s]?.[a] === true;

			next();
		} catch (err) {
			res.clearCookie("access_token");
			return denyAuth("Invalid token");
		}
	},
};

module.exports = authorizationControllers;
