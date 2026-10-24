"use strict";

const express = require("express");
const router = express.Router();
const path = require("path");
const fsp = require("fs/promises");
const multer = require("multer");
const sharp = require("sharp");
const crypto = require("crypto");
const validator = require("validator");
const bcryptjs = require("bcryptjs");

// ─── Контролери ──────────────────────────────────────────────────────────────
const authorizationControllers = require("../../controllers/authorization/authorization");

// ─── Mail ────────────────────────────────────────────────────────────────────
const { sendInviteEmail, sendAccountActivatedEmail, sendEmailChangeConfirm, sendEmailChangeNotice } = require("../../controllers/mail/mail");

// ─── БД ──────────────────────────────────────────────────────────────────────
const connection_pool = require("../../config/database/connection_pool");

// ─── Конфігурація ────────────────────────────────────────────────────────────
const config = require("../../config/config");
const configDatabase = config.get("configDatabase");
const prefix = configDatabase.prefix;

// Час життя запрошення — з конфіга (config/config/invite.json)
const configInvite = config.get("configInvite");
const INVITE_TTL_MS = configInvite.ttl_hours * 60 * 60 * 1000;

// Хеш токена для зберігання в БД (сирий токен — лише в листі)
function hashToken(raw) {
	return crypto.createHash("sha256").update(raw).digest("hex");
}

// Валідатор
const validate = require("../../validator/users/edit");
const bcrypt = require("bcrypt");
const { rateLimit } = require("express-rate-limit");
const userSessions = require("../../helpers/user_sessions");

// ─── Сторінка користувача: спільні перевірки ────────────────────────────────
// Власник профілю — завжди; інші — users.list (view — перегляд, edit — зміни).
const AVATAR_ROOT = path.join(__dirname, "..", "..", "public", "uploads", "users");
const AVATAR_SIZE = 256;

const avatarUpload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 5 * 1024 * 1024, files: 1 },
	fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif|avif)$/.test(file.mimetype)),
});

const profileTargetId = (req) => (/^\d+$/.test(req.params.id) ? Number(req.params.id) : null);
const profileIsSelf = (req, id) => Number(req.user.id) === id;
const profileCanView = (req, id) => profileIsSelf(req, id) || authorizationControllers.hasPermission(req, "users.list", "view");
const profileCanManage = (req, id) => profileIsSelf(req, id) || authorizationControllers.hasPermission(req, "users.list", "edit");

function profileGuard(check) {
	return (req, res, next) => {
		const id = profileTargetId(req);
		if (!id) return res.status(404).json({ status: "error", message: "Not found" });
		if (!check(req, id)) return res.status(403).json({ status: "error", message: "Forbidden" });
		req.targetId = id;
		next();
	};
}

// Перебір поточного пароля: 5 невдалих спроб за 15 хв на користувача (успішні не рахуються)
const passwordChangeLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 5,
	skipSuccessfulRequests: true,
	standardHeaders: true,
	legacyHeaders: false,
	keyGenerator: (req) => "pwd:" + req.user.id,
	handler: (req, res) =>
		res.status(429).json({
			status: "error",
			errors: [{ field: "password-current", message: req.__("users.edit.password_rate_limited") }],
		}),
});
const validateAdd = require("../../validator/users/add");
const { inviteAcceptLimiter, invitePageLimiter, resendInviteLimiter } = require("../../middlewares/rate-limiters");
// END Валідатор

// ─── Логування ───────────────────────────────────────────────────────────────
const logging = require("../../logging/logging");

// ─── GET /users ───────────────────────────────────────────────────────────────
router.get("/users/", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.list", "view"), (req, res) => {
	res.render("pages/users/index", {
		i18n: req,
		user: req.user,
		header: { navbar: "users", subnavbar: "users" },
	});
});

// ─── Власна сторінка користувача ─────────────────────────────────────────────
router.get("/users/profile/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id = Number(req.user.id);
		const id_lang = req.user.id_lang || 1;

		const [[targetUser]] = await connection_pool.query(
			`SELECT id, email, first_name, last_name, patronymic, phone, birthday, gender, avatar,
			        id_lang, active, tfa_enabled, failed_login_attempts, locked_until, id_created_by,
			        date_last_login, date_online_since, date_last_seen, date_add, date_edit
			 FROM \`${prefix}users\`
			 WHERE id = ?
			 LIMIT 1`,
			[id]
		);
		if (!targetUser) return res.redirect("/logout/");

		const [groups] = await connection_pool.query(
			`SELECT g.id, gl.name
			 FROM \`${prefix}users_to_groups\` ug
			 JOIN \`${prefix}users_groups\` g ON g.id = ug.id_group
			 LEFT JOIN \`${prefix}users_groups_lang\` gl ON gl.id_group = g.id AND gl.id_lang = ?
			 WHERE ug.id_user = ?
			 ORDER BY g.id ASC`,
			[id_lang, id]
		);

		return res.render("pages/users/view", {
			i18n: req,
			user: req.user,
			targetUser,
			groups,
			isSelf: true,
			canManage: true,
			canEditUser: authorizationControllers.hasPermission(req, "users.list", "edit"),
			canViewList: authorizationControllers.hasPermission(req, "users.list", "view"),
			header: { navbar: "profile", subnavbar: "profile" },
		});
	} catch (error) {
		logging.error("[users/profile]", error);
		return res.status(500).render("pages/error/404", { i18n: req, user: req.user });
	}
});

// ─── Сторінка іншого користувача ─────────────────────────────────────────────
router.get("/users/:id/", authorizationControllers.isAuthenticated, async (req, res, next) => {
	if (!/^\d+$/.test(req.params.id)) return next(); // /users/access, /users/groups → далі

	const id = Number(req.params.id);
	if (id === Number(req.user.id)) return res.redirect("/users/profile/");

	if (!authorizationControllers.hasPermission(req, "users.list", "view")) {
		return res.status(403).render("pages/error/404", { i18n: req, user: req.user });
	}

	try {
		const id_lang = req.user.id_lang || 1;

		const [[targetUser]] = await connection_pool.query(
			`SELECT id, email, first_name, last_name, patronymic, phone, birthday, gender, avatar,
			        id_lang, active, tfa_enabled, failed_login_attempts, locked_until, id_created_by,
			        date_last_login, date_online_since, date_last_seen, date_add, date_edit
			 FROM \`${prefix}users\`
			 WHERE id = ?
			 LIMIT 1`,
			[id]
		);
		if (!targetUser) return res.status(404).render("pages/error/404", { i18n: req, user: req.user });

		const [groups] = await connection_pool.query(
			`SELECT g.id, gl.name
			 FROM \`${prefix}users_to_groups\` ug
			 JOIN \`${prefix}users_groups\` g ON g.id = ug.id_group
			 LEFT JOIN \`${prefix}users_groups_lang\` gl ON gl.id_group = g.id AND gl.id_lang = ?
			 WHERE ug.id_user = ?
			 ORDER BY g.id ASC`,
			[id_lang, id]
		);

		return res.render("pages/users/view", {
			i18n: req,
			user: req.user,
			targetUser,
			groups,
			isSelf: false,
			canManage: authorizationControllers.hasPermission(req, "users.list", "edit"),
			canEditUser: authorizationControllers.hasPermission(req, "users.list", "edit"),
			canViewList: true,
			header: { navbar: "users", subnavbar: "users" },
		});
	} catch (error) {
		logging.error("[users/:id]", error);
		return res.status(500).render("pages/error/404", { i18n: req, user: req.user });
	}
});

// ─── Редагування власного профілю ────────────────────────────────────────────
router.get("/users/profile/edit", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id = Number(req.user.id);
		const id_lang = req.user.id_lang || 1;

		const [[targetUser]] = await connection_pool.query(
			`SELECT id, email, first_name, last_name, patronymic, phone, birthday, gender, avatar, id_lang, active, tfa_enabled
			 FROM \`${prefix}users\`
			 WHERE id = ?
			 LIMIT 1`,
			[id]
		);
		if (!targetUser) return res.redirect("/logout/");

		const [allGroups] = await connection_pool.query(
			`SELECT g.id, gl.name
			 FROM \`${prefix}users_groups\` g
			 LEFT JOIN \`${prefix}users_groups_lang\` gl ON gl.id_group = g.id AND gl.id_lang = ?
			 WHERE g.active = 1
			 ORDER BY g.id ASC`,
			[id_lang]
		);

		const [userGroupRows] = await connection_pool.query(`SELECT id_group FROM \`${prefix}users_to_groups\` WHERE id_user = ?`, [id]);

		return res.render("pages/users/edit", {
			i18n: req,
			user: req.user,
			targetUser,
			allGroups,
			userGroupIds: userGroupRows.map((r) => r.id_group),
			isSelf: true,
			canManage: true,
			canEditGroups: false,
			emailStatus: ["confirmed", "invalid"].includes(req.query.email) ? req.query.email : null,
			canResetTfa: false,
			header: { navbar: "profile", subnavbar: "profile" },
		});
	} catch (error) {
		logging.error("[users/profile/edit]", error);
		return res.status(500).render("pages/error/404", { i18n: req, user: req.user });
	}
});

// ─── Редагування іншого користувача ──────────────────────────────────────────
router.get("/users/:id/edit", authorizationControllers.isAuthenticated, async (req, res, next) => {
	if (!/^\d+$/.test(req.params.id)) return next();

	const id = Number(req.params.id);
	if (id === Number(req.user.id)) return res.redirect("/users/profile/edit");

	if (!authorizationControllers.hasPermission(req, "users.list", "view")) {
		return res.status(403).render("pages/error/404", { i18n: req, user: req.user });
	}

	try {
		const id_lang = req.user.id_lang || 1;

		const [[targetUser]] = await connection_pool.query(
			`SELECT id, email, first_name, last_name, patronymic, phone, birthday, gender, avatar, id_lang, active, tfa_enabled
			 FROM \`${prefix}users\`
			 WHERE id = ?
			 LIMIT 1`,
			[id]
		);
		if (!targetUser) return res.status(404).render("pages/error/404", { i18n: req, user: req.user });

		const [allGroups] = await connection_pool.query(
			`SELECT g.id, gl.name
			 FROM \`${prefix}users_groups\` g
			 LEFT JOIN \`${prefix}users_groups_lang\` gl ON gl.id_group = g.id AND gl.id_lang = ?
			 WHERE g.active = 1
			 ORDER BY g.id ASC`,
			[id_lang]
		);

		const [userGroupRows] = await connection_pool.query(`SELECT id_group FROM \`${prefix}users_to_groups\` WHERE id_user = ?`, [id]);

		return res.render("pages/users/edit", {
			i18n: req,
			user: req.user,
			targetUser,
			allGroups,
			userGroupIds: userGroupRows.map((r) => r.id_group),
			isSelf: false,
			emailStatus: null,
			canManage: authorizationControllers.hasPermission(req, "users.list", "edit"),
			canEditGroups: authorizationControllers.hasPermission(req, "users.list", "edit"),
			canResetTfa: authorizationControllers.hasPermission(req, "users.list", "edit"),
			header: { navbar: "users", subnavbar: "users" },
		});
	} catch (error) {
		logging.error("[users/:id/edit]", error);
		return res.status(500).render("pages/error/404", { i18n: req, user: req.user });
	}
});



router.post("/api/users/access/list", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.list", "view"), async (req, res) => {
	try {
		const [groups] = await connection_pool.query(
			`SELECT g.id, gl.name, gl.note
             FROM \`${prefix}users_groups\` g
             LEFT JOIN \`${prefix}users_groups_lang\` gl ON gl.id_group = g.id
             WHERE gl.id_lang = ?
             ORDER BY g.id ASC`,
			[req.user.id_lang || 1]
		);

		const [pages] = await connection_pool.query(
			`SELECT pp.id, pp.slug, pp.parent_id, pp.sort_order, ppl.name
             FROM \`${prefix}users_permissions_pages\` pp
             LEFT JOIN \`${prefix}users_permissions_pages_lang\` ppl ON ppl.id_page = pp.id
             WHERE ppl.id_lang = ?
             ORDER BY pp.sort_order ASC`,
			[req.user.id_lang || 1]
		);

		const [permissions] = await connection_pool.query(
			`SELECT id_group, id_page, can_view, can_add, can_edit, can_delete
             FROM \`${prefix}users_groups_permissions\``
		);

		const permissionsMap = {};
		for (const perm of permissions) {
			if (!permissionsMap[perm.id_group]) {
				permissionsMap[perm.id_group] = {};
			}
			permissionsMap[perm.id_group][perm.id_page] = {
				view: perm.can_view === 1,
				add: perm.can_add === 1,
				edit: perm.can_edit === 1,
				delete: perm.can_delete === 1,
			};
		}

		return res.json({
			status: "success",
			data: { groups, pages, permissions: permissionsMap },
		});
	} catch (error) {
		logging.error("[api/users/access/list]", error);
		return res.status(500).json({ status: "error" });
	}
});

router.post("/api/users/delete", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.list", "delete"), async (req, res) => {
	try {
		const id_user = parseInt(req.body.id_user);

		if (!id_user) {
			return res.status(422).json({ status: "error", message: "ID is required" });
		}

		const [[user]] = await connection_pool.query(`SELECT id FROM \`${prefix}users\` WHERE id = ? LIMIT 1`, [id_user]);

		if (!user) {
			return res.status(404).json({ status: "error", message: "User not found" });
		}

		// ── Не можна видалити самого себе ────────────────────────────────
		if (id_user === req.user.id) {
			return res.status(403).json({ status: "error", message: "Cannot delete yourself" });
		}

		// ── Захист останнього активного адміністратора (група 1) ─────────
		const [[isAdmin]] = await connection_pool.query(
			`SELECT 1 AS ok FROM \`${prefix}users_to_groups\`
              WHERE id_user = ? AND id_group = 1 LIMIT 1`,
			[id_user]
		);
		if (isAdmin) {
			const [[adminCount]] = await connection_pool.query(
				`SELECT COUNT(*) AS cnt
                FROM \`${prefix}users_to_groups\` utg
                JOIN \`${prefix}users\` u ON u.id = utg.id_user
                WHERE utg.id_group = 1 AND u.active = 1`
			);
			if (adminCount.cnt <= 1) {
				return res.status(403).json({ status: "error", message: "Cannot delete the last administrator" });
			}
		}

		await connection_pool.query(`DELETE FROM \`${prefix}users_to_groups\` WHERE id_user = ?`, [id_user]).catch((err) => {
			logging.error("[api/users/delete] users_to_groups", err);
		});

		await connection_pool.query(`DELETE FROM \`${prefix}users_login_log\` WHERE id_user = ?`, [id_user]).catch((err) => {
			logging.error("[api/users/delete] users_login_log", err);
		});

		// ── Прибираємо інвайт, якщо був ──────────────────────────────────
		await connection_pool.query(`DELETE FROM \`${prefix}users_invites\` WHERE email = (SELECT email FROM \`${prefix}users\` WHERE id = ?)`, [id_user]).catch(() => {});

		await connection_pool.query(`DELETE FROM \`${prefix}users\` WHERE id = ?`, [id_user]);

		return res.json({ status: "success", message: "User deleted" });
	} catch (error) {
		logging.error("[api/users/delete]", error);
		return res.status(500).json({ status: "error", message: error.message || "Server error" });
	}
});

router.post("/api/users/access/save", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.list", "edit"), async (req, res) => {
	try {
		const id_group = parseInt(req.body.id_group);
		const id_page = parseInt(req.body.id_page);
		const action = (req.body.action || "").trim();
		const value = req.body.value === 1 || req.body.value === true || req.body.value === "1";

		if (!id_group || !id_page) {
			return res.status(422).json({ status: "error", message: "Missing parameters" });
		}

		if (id_group === 1) {
			return res.status(403).json({ status: "error", message: "Cannot modify administrator permissions" });
		}

		const allowedActions = ["view", "add", "edit", "delete"];
		if (!allowedActions.includes(action)) {
			return res.status(400).json({ status: "error", message: "Invalid action" });
		}

		const [existing] = await connection_pool.query(
			`SELECT id_group, id_page FROM \`${prefix}users_groups_permissions\`
             WHERE id_group = ? AND id_page = ?`,
			[id_group, id_page]
		);

		if (existing.length > 0) {
			await connection_pool.query(
				`UPDATE \`${prefix}users_groups_permissions\`
                 SET can_${action} = ?
                 WHERE id_group = ? AND id_page = ?`,
				[value ? 1 : 0, id_group, id_page]
			);
		} else {
			await connection_pool.query(
				`INSERT INTO \`${prefix}users_groups_permissions\`
                 (id_group, id_page, can_${action})
                 VALUES (?, ?, ?)`,
				[id_group, id_page, value ? 1 : 0]
			);
		}

		return res.json({ status: "success" });
	} catch (error) {
		logging.error("[api/users/access/save]", error);
		return res.status(500).json({ status: "error" });
	}
});

// ═════════════════════════════════════════════════════════════════════════════
// ГРУПИ ТА ПРАВА ДОСТУПУ
// ═════════════════════════════════════════════════════════════════════════════

// ─── Сторінка груп ───────────────────────────────────────────────────────────
router.get("/users/groups", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.groups", "view"), async (req, res) => {
	try {
		const [groups] = await connection_pool.query(
			`SELECT g.id, g.active, gl.name, gl.note, COUNT(ug.id_user) AS users_count
			 FROM \`${prefix}users_groups\` g
			 LEFT JOIN \`${prefix}users_groups_lang\` gl ON gl.id_group = g.id AND gl.id_lang = ?
			 LEFT JOIN \`${prefix}users_to_groups\` ug ON ug.id_group = g.id
			 GROUP BY g.id, g.active, gl.name, gl.note
			 ORDER BY g.id ASC`,
			[req.user.id_lang || 1]
		);

		return res.render("pages/users/groups", {
			i18n: req,
			user: req.user,
			groups,
			canAdd: authorizationControllers.hasPermission(req, "users.groups", "add"),
			canEdit: authorizationControllers.hasPermission(req, "users.groups", "edit"),
			canDelete: authorizationControllers.hasPermission(req, "users.groups", "delete"),
			header: { navbar: "users", subnavbar: "groups" },
		});
	} catch (error) {
		logging.error("[users/groups]", error);
		return res.status(500).render("pages/error/404", { i18n: req, user: req.user });
	}
});

// ─── Дані групи для модалки редагування ──────────────────────────────────────
router.post("/api/users/groups/:id/get", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.groups", "view"), async (req, res) => {
	try {
		const id = Number(req.params.id);
		const [[group]] = await connection_pool.query(`SELECT id, active FROM \`${prefix}users_groups\` WHERE id = ? LIMIT 1`, [id]);
		if (!group) return res.status(404).json({ status: "error", message: req.__("users.groups.not_found") });

		const [names] = await connection_pool.query(`SELECT id_lang, name, note FROM \`${prefix}users_groups_lang\` WHERE id_group = ?`, [id]);

		return res.json({ status: "success", data: { id: group.id, active: group.active, names } });
	} catch (error) {
		logging.error("[api/users/groups/:id/get]", error);
		return res.status(500).json({ status: "error", message: req.__("users.groups.error_network") });
	}
});

// ─── Створення / редагування групи ───────────────────────────────────────────
router.post("/api/users/groups/save", authorizationControllers.isAuthenticated, async (req, res) => {
	const id = Number(req.body.id) || null;

	if (!authorizationControllers.hasPermission(req, "users.groups", id ? "edit" : "add")) {
		return res.status(403).json({ status: "error", message: req.__("users.groups.forbidden") });
	}

	const active = req.body.active === true ? 1 : 0;
	const langIds = (res.locals.languages || []).map((l) => l.id);
	const names = (Array.isArray(req.body.names) ? req.body.names : [])
		.map((n) => ({
			id_lang: Number(n && n.id_lang),
			name: String((n && n.name) || "").trim().slice(0, 100),
			note: String((n && n.note) || "").trim().slice(0, 500) || null,
		}))
		.filter((n) => langIds.includes(n.id_lang));

	if (!names.some((n) => n.name)) {
		return res.status(422).json({ status: "error", message: req.__("users.groups.name_required") });
	}
	if (id === 1 && !active) {
		return res.status(422).json({ status: "error", message: req.__("users.groups.admin_cannot_disable") });
	}

	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		let groupId = id;
		if (id) {
			const [r] = await conn.query(`UPDATE \`${prefix}users_groups\` SET active = ?, date_edit = NOW() WHERE id = ?`, [active, id]);
			if (!r.affectedRows) {
				await conn.rollback();
				return res.status(404).json({ status: "error", message: req.__("users.groups.not_found") });
			}
		} else {
			const [r] = await conn.query(`INSERT INTO \`${prefix}users_groups\` (active, id_created_by, date_add, date_edit) VALUES (?, ?, NOW(), NOW())`, [active, req.user.id]);
			groupId = r.insertId;
		}

		// Порожня назва для мови — беремо першу заповнену, щоб група не була безіменною
		const fallback = names.find((n) => n.name).name;
		for (const n of names) {
			await conn.query(
				`INSERT INTO \`${prefix}users_groups_lang\` (id_group, id_lang, name, note)
				 VALUES (?, ?, ?, ?)
				 ON DUPLICATE KEY UPDATE name = VALUES(name), note = VALUES(note)`,
				[groupId, n.id_lang, n.name || fallback, n.note]
			);
		}

		await conn.commit();
		return res.json({ status: "success", id: groupId, message: req.__("users.groups.saved") });
	} catch (error) {
		await conn.rollback();
		logging.error("[api/users/groups/save]", error);
		return res.status(500).json({ status: "error", message: req.__("users.groups.error_network") });
	} finally {
		conn.release();
	}
});

// ─── Видалення групи ─────────────────────────────────────────────────────────
router.post("/api/users/groups/:id/delete", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.groups", "delete"), async (req, res) => {
	try {
		const id = Number(req.params.id);
		if (id === 1) {
			return res.status(403).json({ status: "error", message: req.__("users.groups.admin_cannot_delete") });
		}

		const [[usage]] = await connection_pool.query(`SELECT COUNT(*) AS cnt FROM \`${prefix}users_to_groups\` WHERE id_group = ?`, [id]);
		if (usage.cnt > 0) {
			return res.status(409).json({ status: "error", message: req.__("users.groups.has_users", { count: usage.cnt }) });
		}

		// Назви та права групи видаляються каскадно (FK ON DELETE CASCADE)
		const [r] = await connection_pool.query(`DELETE FROM \`${prefix}users_groups\` WHERE id = ?`, [id]);
		if (!r.affectedRows) return res.status(404).json({ status: "error", message: req.__("users.groups.not_found") });

		// Інвайти, що ще чекають, більше не призначать неіснуючу групу
		await connection_pool.query(`UPDATE \`${prefix}users_invites\` SET id_group = NULL WHERE id_group = ? AND status = 0`, [id]);

		return res.json({ status: "success", message: req.__("users.groups.deleted") });
	} catch (error) {
		logging.error("[api/users/groups/:id/delete]", error);
		return res.status(500).json({ status: "error", message: req.__("users.groups.error_network") });
	}
});

// ─── Сторінка прав доступу групи ─────────────────────────────────────────────
router.get("/users/access", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.groups", "view"), async (req, res) => {
	try {
		const id_lang = req.user.id_lang || 1;

		const [groups] = await connection_pool.query(
			`SELECT g.id, g.active, gl.name
			 FROM \`${prefix}users_groups\` g
			 LEFT JOIN \`${prefix}users_groups_lang\` gl ON gl.id_group = g.id AND gl.id_lang = ?
			 ORDER BY g.id ASC`,
			[id_lang]
		);

		const selectedGroup = groups.find((g) => g.id === Number(req.query.group)) || groups[0] || null;

		const [pages] = await connection_pool.query(
			`SELECT pp.id, pp.slug, pp.parent_id, COALESCE(pl.name, pp.slug) AS name,
			        COALESCE(gp.can_view, 0) AS can_view, COALESCE(gp.can_add, 0) AS can_add,
			        COALESCE(gp.can_edit, 0) AS can_edit, COALESCE(gp.can_delete, 0) AS can_delete
			 FROM \`${prefix}users_permissions_pages\` pp
			 LEFT JOIN \`${prefix}users_permissions_pages_lang\` pl ON pl.id_page = pp.id AND pl.id_lang = ?
			 LEFT JOIN \`${prefix}users_groups_permissions\` gp ON gp.id_page = pp.id AND gp.id_group = ?
			 ORDER BY pp.sort_order ASC, pp.id ASC`,
			[id_lang, selectedGroup ? selectedGroup.id : 0]
		);

		// Розділ з підсторінками — заголовок; сторінка без підсторінок — рядок із правами
		const toRow = (p, child) => ({ id: p.id, slug: p.slug, name: p.name, child, view: p.can_view, add: p.can_add, edit: p.can_edit, delete: p.can_delete });
		const rows = [];
		pages
			.filter((p) => p.parent_id === null)
			.forEach((root) => {
				const children = pages.filter((p) => p.parent_id === root.id);
				if (children.length) {
					rows.push({ header: true, name: root.name });
					children.forEach((c) => rows.push(toRow(c, true)));
				} else {
					rows.push(toRow(root, false));
				}
			});

		// Права адміністратора та власної групи (якщо ти не адміністратор) не змінюються
		const [own] = await connection_pool.query(`SELECT id_group FROM \`${prefix}users_to_groups\` WHERE id_user = ?`, [req.user.id]);
		const ownIds = own.map((r) => r.id_group);
		const locked = !selectedGroup || selectedGroup.id === 1 || (ownIds.includes(selectedGroup.id) && !ownIds.includes(1));

		return res.render("pages/users/access", {
			i18n: req,
			user: req.user,
			groups,
			selectedGroup,
			rows,
			locked,
			canEdit: authorizationControllers.hasPermission(req, "users.groups", "edit"),
			header: { navbar: "users", subnavbar: "access" },
		});
	} catch (error) {
		logging.error("[users/access]", error);
		return res.status(500).render("pages/error/404", { i18n: req, user: req.user });
	}
});

// ─── Зміна одного права ──────────────────────────────────────────────────────
router.post("/api/users/access/save", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.groups", "edit"), async (req, res) => {
	try {
		const id_group = Number(req.body.id_group);
		const id_page = Number(req.body.id_page);
		const action = String(req.body.action || "");
		const value = req.body.value === true;

		if (!Number.isInteger(id_group) || !Number.isInteger(id_page) || !["view", "add", "edit", "delete"].includes(action)) {
			return res.status(422).json({ status: "error", message: req.__("users.access.save_error") });
		}
		if (id_group === 1) {
			return res.status(403).json({ status: "error", message: req.__("users.access.admin_locked") });
		}

		// Захист від самопідвищення прав: свою групу може змінювати лише адміністратор
		const [own] = await connection_pool.query(`SELECT id_group FROM \`${prefix}users_to_groups\` WHERE id_user = ?`, [req.user.id]);
		const ownIds = own.map((r) => r.id_group);
		if (ownIds.includes(id_group) && !ownIds.includes(1)) {
			return res.status(403).json({ status: "error", message: req.__("users.access.own_group_locked") });
		}

		const [[group]] = await connection_pool.query(`SELECT id FROM \`${prefix}users_groups\` WHERE id = ? LIMIT 1`, [id_group]);
		const [[page]] = await connection_pool.query(`SELECT id FROM \`${prefix}users_permissions_pages\` WHERE id = ? LIMIT 1`, [id_page]);
		if (!group || !page) {
			return res.status(404).json({ status: "error", message: req.__("users.access.save_error") });
		}

		const [[current]] = await connection_pool.query(
			`SELECT can_view AS view, can_add AS \`add\`, can_edit AS edit, can_delete AS \`delete\`
			 FROM \`${prefix}users_groups_permissions\`
			 WHERE id_group = ? AND id_page = ?`,
			[id_group, id_page]
		);

		// Залежності: без перегляду інші дії не мають сенсу
		const state = Object.assign({ view: 0, add: 0, edit: 0, delete: 0 }, current);
		state[action] = value ? 1 : 0;
		if (action !== "view" && value) state.view = 1;
		if (action === "view" && !value) state.add = state.edit = state.delete = 0;

		await connection_pool.query(
			`INSERT INTO \`${prefix}users_groups_permissions\` (id_group, id_page, can_view, can_add, can_edit, can_delete)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE can_view = VALUES(can_view), can_add = VALUES(can_add), can_edit = VALUES(can_edit), can_delete = VALUES(can_delete)`,
			[id_group, id_page, state.view, state.add, state.edit, state.delete]
		);

		return res.json({ status: "success", data: state });
	} catch (error) {
		logging.error("[api/users/access/save]", error);
		return res.status(500).json({ status: "error", message: req.__("users.access.save_error") });
	}
});

// ─── POST /api/users/list-users ──────────────────────────────────────────────
router.post("/api/users/list-users/", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.list", "view"), async (req, res) => {
	try {
		const id_lang = req.user.id_lang || 1;

		const [users] = await connection_pool.query(
			`SELECT
                    u.id,
                    u.first_name,
                    u.last_name,
                    u.patronymic,
                    u.email,
                    u.phone,
                    u.gender,
                    u.avatar,
                    u.id_lang,
                    u.active,
                    u.tfa_enabled,
                    u.date_last_login,
                    u.date_last_seen,
                    u.date_add,
                    GROUP_CONCAT(
                        gl.name
                        ORDER BY gl.name
                        SEPARATOR ', '
                    ) AS \`groups\`,
                    CASE
                      WHEN u.active <> 3 THEN NULL
                      WHEN MAX(i.expires_at) IS NOT NULL
                           AND MAX(i.expires_at) > NOW()
                           AND MAX(i.status) = 0
                        THEN 'valid'
                      ELSE 'expired'
                    END AS invite_state
                 FROM \`${prefix}users\` u
                 LEFT JOIN \`${prefix}users_to_groups\`   utg ON utg.id_user  = u.id
                 LEFT JOIN \`${prefix}users_groups\`      ug  ON ug.id        = utg.id_group
                 LEFT JOIN \`${prefix}users_groups_lang\` gl  ON gl.id_group  = utg.id_group
                                                             AND gl.id_lang   = ?
                 LEFT JOIN \`${prefix}users_invites\`     i   ON i.email       = u.email
                 GROUP BY u.id
                 ORDER BY u.id ASC`,
			[id_lang]
		);

		return res.json({ status: "success", data: users });
	} catch (error) {
		logging.error("[api/users/list-users]", error);
		return res.status(500).json({ status: "error" });
	}
});

// ─── POST /api/users/online-list ─────────────────────────────────────────────
router.post("/api/users/online-list", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.list", "view"), async (req, res) => {
	try {
		const { isUserOnline } = require("../../controllers/socket/socket");
		const id_lang = req.user.id_lang || 1;

		const [users] = await connection_pool.query(
			`SELECT
                    u.id,
                    u.first_name,
                    u.last_name,
                    u.avatar,
                    u.active,
                    u.date_online_since,
                    u.date_last_seen,
                    GROUP_CONCAT(
                        gl.name
                        ORDER BY gl.name
                        SEPARATOR ', '
                    ) AS \`groups\`
                 FROM \`${prefix}users\` u
                 LEFT JOIN \`${prefix}users_to_groups\`   utg ON utg.id_user  = u.id
                 LEFT JOIN \`${prefix}users_groups\`      ug  ON ug.id        = utg.id_group
                 LEFT JOIN \`${prefix}users_groups_lang\` gl  ON gl.id_group  = utg.id_group
                                                             AND gl.id_lang   = ?
                 WHERE u.active IN (1, 3)
                 GROUP BY u.id
                 ORDER BY u.id ASC`,
			[id_lang]
		);

		const result = users.map((u) => ({
			id: u.id,
			first_name: u.first_name,
			last_name: u.last_name,
			avatar: u.avatar,
			groups: u.groups,
			active: u.active,
			online: isUserOnline(u.id),
			date_online_since: u.date_online_since,
			date_last_seen: u.date_last_seen,
		}));

		return res.json({ status: "success", data: result });
	} catch (error) {
		logging.error("[api/users/online-list]", error);
		return res.status(500).json({ status: "error" });
	}
});

// ─── POST /api/users/groups/list ─────────────────────────────────────────────
router.post("/api/users/groups/list", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.list", "view"), async (req, res) => {
	try {
		const id_lang = req.user.id_lang || 1;

		const [groups] = await connection_pool.query(
			`SELECT
                    g.id,
                    g.active,
                    g.date_add,
                    gl.name,
                    gl.note
                 FROM \`${prefix}users_groups\` g
                 LEFT JOIN \`${prefix}users_groups_lang\` gl ON gl.id_group = g.id
                                                            AND gl.id_lang  = ?
                 WHERE g.active = 1
                 ORDER BY g.id ASC`,
			[id_lang]
		);

		return res.json({ status: "success", data: groups });
	} catch (error) {
		logging.error("[api/users/groups/list]", error);
		return res.status(500).json({ status: "error" });
	}
});

// ─── POST /api/users/invite ───────────────────────────────────────────────────
router.post("/api/users/invite", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.list", "add"), async (req, res) => {
	try {
		const email = (req.body.email || "").trim().toLowerCase();
		const id_group = parseInt(req.body.id_group) || null;

		if (!email || !validator.isEmail(email)) {
			return res.status(422).json({
				status: "error",
				errors: [{ field: "email", msg: req.__("users.add.email_invalid") }],
			});
		}

		const [[existingUser]] = await connection_pool.query(`SELECT id, active FROM \`${prefix}users\` WHERE email = ? LIMIT 1`, [email]);

		// Активний або заблокований — не можна запросити (нейтральне повідомлення)
		if (existingUser && (existingUser.active === 1 || existingUser.active === 2)) {
			return res.status(409).json({
				status: "error",
				errors: [{ field: "email", msg: req.__("users.invite.cannot_invite") }],
			});
		}

		const [[existingInvite]] = await connection_pool.query(
			`SELECT id, status, expires_at FROM \`${prefix}users_invites\`
                    WHERE email = ? LIMIT 1`,
			[email]
		);

		// Вже завершив реєстрацію
		if (existingInvite?.status === 1) {
			return res.status(409).json({
				status: "error",
				errors: [{ field: "email", msg: req.__("users.invite.cannot_invite") }],
			});
		}

		// Інвайт вже відправлений і ще діє — не відправляємо повторно
		if (existingInvite?.status === 0 && new Date(existingInvite.expires_at) > new Date()) {
			return res.status(409).json({
				status: "error",
				errors: [{ field: "email", msg: req.__("users.invite.already_sent") }],
			});
		}

		const token = crypto.randomBytes(48).toString("hex");
		const tokenHash = hashToken(token);
		const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

		if (existingInvite) {
			await connection_pool.query(
				`UPDATE \`${prefix}users_invites\`
                     SET token         = ?,
                         id_group      = ?,
                         id_created_by = ?,
                         status        = 0,
                         expires_at    = ?
                     WHERE email = ?`,
				[tokenHash, id_group, req.user.id, expiresAt, email]
			);
		} else {
			await connection_pool.query(`INSERT INTO \`${prefix}users\` (email, active) VALUES (?, 3)`, [email]);

			await connection_pool.query(
				`INSERT INTO \`${prefix}users_invites\`
                     (email, token, id_group, id_created_by, expires_at)
                     VALUES (?, ?, ?, ?, ?)`,
				[email, tokenHash, id_group, req.user.id, expiresAt]
			);
		}

		await sendInviteEmail(email, token, req.user);

		return res.json({ status: "success" });
	} catch (error) {
		logging.error("[api/users/invite]", error);
		return res.status(500).json({ status: "error" });
	}
});

// ─── POST /api/users/add ──────────────────────────────────────────────────────
router.post("/api/users/add", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.list", "add"), async (req, res) => {
	const useInvite = req.body.send_email == 1;

	const body = {
		last_name: (req.body.last_name || "").trim(),
		first_name: (req.body.first_name || "").trim(),
		patronymic: (req.body.patronymic || "").trim(),
		email: (req.body.email || "").trim().toLowerCase(),
		password: (req.body.password || "").trim(),
		id_group: parseInt(req.body.id_group) || null,
	};

	const { valid, errors } = validateAdd(body, req.__, { requirePassword: !useInvite });
	if (!valid) {
		return res.status(422).json({ status: "error", errors });
	}

	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		const [[existing]] = await conn.query(`SELECT id, active FROM \`${prefix}users\` WHERE email = ? LIMIT 1`, [body.email]);

		if (existing && (existing.active === 1 || existing.active === 2)) {
			await conn.rollback();
			return res.status(409).json({
				status: "error",
				errors: [{ field: "email", msg: req.__("users.add.email_exists") }],
			});
		}

		if (useInvite) {
			// ── Гілка "підтвердження профілю" ───────────────────────────────
			const token = crypto.randomBytes(48).toString("hex");
			const tokenHash = hashToken(token);
			const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

			let id_user;
			if (existing) {
				await conn.query(
					`UPDATE \`${prefix}users\`
                  SET last_name = ?, first_name = ?, patronymic = ?, active = 3
                  WHERE id = ?`,
					[body.last_name, body.first_name, body.patronymic, existing.id]
				);
				id_user = existing.id;
			} else {
				const [result] = await conn.query(
					`INSERT INTO \`${prefix}users\`
                  (last_name, first_name, patronymic, email, active)
                  VALUES (?, ?, ?, ?, 3)`,
					[body.last_name, body.first_name, body.patronymic, body.email]
				);
				id_user = result.insertId;
			}

			await conn.query(
				`INSERT INTO \`${prefix}users_invites\`
                (email, token, id_group, id_created_by, status, expires_at)
                VALUES (?, ?, ?, ?, 0, ?)
                ON DUPLICATE KEY UPDATE
                    token         = VALUES(token),
                    id_group      = VALUES(id_group),
                    id_created_by = VALUES(id_created_by),
                    status        = 0,
                    date_accepted = NULL,
                    expires_at    = VALUES(expires_at)`,
				[body.email, tokenHash, body.id_group, req.user.id, expiresAt]
			);

			await conn.commit();

			await sendInviteEmail(body.email, token, req.user).catch((err) => {
				logging.error("[api/users/add] sendInviteEmail", err);
			});

			return res.json({ status: "success" });
		}

		// ── Гілка "адмін ставить пароль одразу" ──────────────────────────
		const hash = await bcryptjs.hash(body.password, 12);

		let id_user;
		if (existing) {
			await conn.query(
				`UPDATE \`${prefix}users\`
                SET last_name = ?, first_name = ?, patronymic = ?,
                    password = ?, active = 1, token_version = token_version + 1
                WHERE id = ?`,
				[body.last_name, body.first_name, body.patronymic, hash, existing.id]
			);
			id_user = existing.id;

			await conn.query(`DELETE FROM \`${prefix}users_invites\` WHERE email = ?`, [body.email]);
		} else {
			const [result] = await conn.query(
				`INSERT INTO \`${prefix}users\`
                (last_name, first_name, patronymic, email, password, active)
                VALUES (?, ?, ?, ?, ?, 1)`,
				[body.last_name, body.first_name, body.patronymic, body.email, hash]
			);
			id_user = result.insertId;
		}

		if (body.id_group) {
			await conn.query(`INSERT IGNORE INTO \`${prefix}users_to_groups\` (id_user, id_group) VALUES (?, ?)`, [id_user, body.id_group]);
		}

		await conn.commit();
		return res.json({ status: "success" });
	} catch (error) {
		await conn.rollback();
		logging.error("[api/users/add]", error);
		return res.status(500).json({ status: "error" });
	} finally {
		conn.release();
	}
});

// Скидання пароля на сторінці користувача
router.post("/api/users/:id/update-password", authorizationControllers.isAuthenticated, passwordChangeLimiter, async (req, res) => {
	const fail = (field, key) => res.status(422).json({ status: "error", errors: [{ field, message: req.__(key) }] });

	try {
		const id = parseInt(req.params.id);

		// Змінити можна лише власний пароль
		if (Number(req.user.id) !== id) {
			return res.status(403).json({ status: "error", message: "forbidden" });
		}

		const { valid, errors } = validate.password(req.body);
		if (!valid) {
			const fieldMap = { current_password: "password-current", new_password: "password-new", confirm_password: "password-confirm" };
			const e = errors[0];
			const name = (e.instancePath || "").replace("/", "") || e.params?.missingProperty;
			const key = e.keyword === "minLength" && name === "new_password" ? "users.add.password_min" : e.keyword === "maxLength" ? "users.add.password_max" : "users.add.password_required";
			return fail(fieldMap[name] || "password-new", key);
		}

		const { current_password, new_password, confirm_password } = req.body;

		// bcrypt враховує лише перші 72 байти (кирилиця = 2 байти на символ)
		if (Buffer.byteLength(new_password, "utf8") > 72) return fail("password-new", "users.edit.password_too_long");
		if (new_password !== confirm_password) return fail("password-confirm", "users.edit.password_mismatch");

		const [[u]] = await connection_pool.query(`SELECT password, email FROM \`${prefix}users\` WHERE id = ? LIMIT 1`, [id]);
		if (!u) return res.status(404).json({ status: "error", message: "not_found" });

		if (!(await bcrypt.compare(current_password, u.password))) return fail("password-current", "users.edit.password_wrong");
		if (await bcrypt.compare(new_password, u.password)) return fail("password-new", "users.edit.password_same");

		const np = new_password.toLowerCase();
		const email = String(u.email || "").toLowerCase();
		if (np === email || np === email.split("@")[0]) return fail("password-new", "users.edit.password_like_email");

		const hash = await bcrypt.hash(new_password, 12);
		await connection_pool.query(
			`UPDATE \`${prefix}users\`
			 SET password = ?, reset_token = NULL, reset_token_expires = NULL, date_edit = NOW()
			 WHERE id = ?`,
			[hash, id]
		);

		// Закриваємо всі інші сесії, поточну залишаємо
		const closed = await userSessions.revokeAllSessions(id, req.user.sid, id);

		await connection_pool
			.query(
				`INSERT INTO \`${prefix}users_security_events\` (id_user, ip_address, event_type, user_agent, details, created_at)
				 VALUES (?, ?, 'password_changed', ?, ?, NOW())`,
				[id, (req.ip || "").replace(/^::ffff:/, ""), String(req.headers["user-agent"] || "").slice(0, 512), JSON.stringify({ sessions_closed: closed })]
			)
			.catch((err) => logging.error("[update-password] security_event", err));

		return res.json({
			status: "success",
			message: closed > 0 ? req.__("users.edit.password_changed_sessions", { count: closed }) : req.__("users.edit.password_changed"),
		});
	} catch (error) {
		logging.error("[api/users/:id/update-password]", error);
		return res.status(500).json({ status: "error" });
	}
});
// END Скидання пароля на сторінці користувача

// ─── POST /api/users/:id/resend-invite ────────────────────────────────────────
router.post("/api/users/:id/resend-invite", resendInviteLimiter, authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.list", "add"), async (req, res) => {
	const conn = await connection_pool.getConnection();
	try {
		const id = parseInt(req.params.id);

		await conn.beginTransaction();

		const [[u]] = await conn.query(`SELECT id, email, active FROM \`${prefix}users\` WHERE id = ? LIMIT 1 FOR UPDATE`, [id]);
		if (!u) {
			await conn.rollback();
			return res.status(404).json({ status: "error", message: req.__("users.invite.not_found") });
		}
		if (u.active !== 3) {
			await conn.rollback();
			return res.status(409).json({ status: "error", message: req.__("users.invite.not_pending") });
		}

		const token = crypto.randomBytes(48).toString("hex");
		const tokenHash = hashToken(token);
		const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

		await conn.query(
			`INSERT INTO \`${prefix}users_invites\`
              (email, token, id_created_by, status, expires_at)
              VALUES (?, ?, ?, 0, ?)
              ON DUPLICATE KEY UPDATE
                  token         = VALUES(token),
                  id_created_by = VALUES(id_created_by),
                  status        = 0,
                  date_accepted = NULL,
                  expires_at    = VALUES(expires_at)`,
			[u.email, tokenHash, req.user.id, expiresAt]
		);

		await conn.commit();

		await sendInviteEmail(u.email, token, req.user).catch((err) => {
			logging.error("[api/users/:id/resend-invite] sendInviteEmail", err);
		});

		return res.json({ status: "success" });
	} catch (error) {
		await conn.rollback();
		logging.error("[api/users/:id/resend-invite]", error);
		return res.status(500).json({ status: "error" });
	} finally {
		conn.release();
	}
});

// ─── GET /invite/:token — сторінка підтвердження (публічна) ────────────────────
router.get("/invite/:token", invitePageLimiter, async (req, res) => {
	try {
		const token = req.params.token;
		const tokenHash = hashToken(token);

		const [[invite]] = await connection_pool.query(
			`SELECT i.id AS invite_id, i.status, i.expires_at,
              u.first_name, u.last_name, u.patronymic, u.email
       FROM \`${prefix}users_invites\` i
       JOIN \`${prefix}users\` u ON u.email = i.email
       WHERE i.token = ? LIMIT 1`,
			[tokenHash]
		);

		// Єдине узагальнене повідомлення — не розкриваємо причину (перебір токенів)
		if (!invite || invite.status !== 0 || new Date(invite.expires_at) < new Date()) {
			return res.status(410).render("pages/users/invite-invalid", { i18n: req });
		}

		return res.render("pages/users/invite-accept", {
			i18n: req,
			token,
			profile: {
				first_name: invite.first_name,
				last_name: invite.last_name,
				patronymic: invite.patronymic,
				email: invite.email,
			},
		});
	} catch (error) {
		logging.error("[GET /invite/:token]", error);
		return res.status(500).render("pages/500", { i18n: req });
	}
});

// ─── POST /api/invite/accept — прийняття інвайту (публічний) ───────────────────
router.post("/api/invite/accept", inviteAcceptLimiter, async (req, res) => {
	const token = (req.body.token || "").trim();
	const tokenHash = hashToken(token);
	const password = (req.body.password || "").trim();
	const confirm = (req.body.confirm_password || "").trim();

	const errors = [];
	if (!password) errors.push({ field: "password", msg: req.__("users.add.password_required") });
	else if (password.length < 8) errors.push({ field: "password", msg: req.__("users.add.password_min") });
	else if (password.length > 128) errors.push({ field: "password", msg: req.__("users.add.password_max") });

	if (password && password !== confirm) {
		errors.push({ field: "confirm_password", msg: req.__("users.edit.password_mismatch") });
	}
	if (errors.length) return res.status(422).json({ status: "error", errors });

	const conn = await connection_pool.getConnection();
	try {
		await conn.beginTransaction();

		const [[invite]] = await conn.query(
			`SELECT i.id AS invite_id, i.status, i.expires_at, i.id_group,
              u.id AS user_id, u.email
       FROM \`${prefix}users_invites\` i
       JOIN \`${prefix}users\` u ON u.email = i.email
       WHERE i.token = ? LIMIT 1 FOR UPDATE`,
			[tokenHash]
		);

		if (!invite || invite.status !== 0 || new Date(invite.expires_at) < new Date()) {
			await conn.rollback();
			return res.status(410).json({ status: "error", message: req.__("users.invite.invalid_or_expired") });
		}

		const hash = await bcryptjs.hash(password, 12);

		await conn.query(
			`UPDATE \`${prefix}users\`
       SET password = ?, active = 1, token_version = token_version + 1
       WHERE id = ?`,
			[hash, invite.user_id]
		);

		if (invite.id_group) {
			await conn.query(`INSERT IGNORE INTO \`${prefix}users_to_groups\` (id_user, id_group) VALUES (?, ?)`, [invite.user_id, invite.id_group]);
		}

		await conn.query(
			`UPDATE \`${prefix}users_invites\`
       SET status = 1, date_accepted = NOW()
       WHERE id = ?`,
			[invite.invite_id]
		);

		await conn.commit();

		// Лист про активацію — поза транзакцією, без пароля
		await sendAccountActivatedEmail(invite.email, req.user).catch((err) => {
			logging.error("[api/invite/accept] sendAccountActivatedEmail", err);
		});

		return res.json({ status: "success", url: "/login" });
	} catch (error) {
		await conn.rollback();
		logging.error("[api/invite/accept]", error);
		return res.status(500).json({ status: "error" });
	} finally {
		conn.release();
	}
});

// PATCH /api/users/me/lang
router.patch("/api/users/me/lang", authorizationControllers.isAuthenticated, async (req, res) => {
	const userId = req.user.id;
	const id_lang = parseInt(req.body.id_lang, 10);

	if (!id_lang) {
		return res.status(400).json({ message: "Невірний ID мови." });
	}

	const p = configDatabase.prefix;

	try {
		// Перевірка, що мова існує та активна, і отримуємо її ISO-код
		const [langRows] = await connection_pool.query(`SELECT id, iso FROM \`${p}languages\` WHERE id = ? AND active = 1`, [id_lang]);

		if (langRows.length === 0) {
			return res.status(400).json({ message: "Мова не знайдена або неактивна." });
		}

		const langIso = langRows[0].iso;

		// Оновлюємо мову користувача
		const [result] = await connection_pool.query(`UPDATE \`${p}users\` SET id_lang = ? WHERE id = ?`, [id_lang, userId]);

		if (result.affectedRows === 0) {
			return res.status(404).json({ message: "Користувача не знайдено." });
		}

		// ВАЖЛИВО: оновлюємо cookie i18n, щоб сторінка після перезавантаження відобразила нову мову
		res.cookie("lang", langIso, {
			maxAge: 30 * 24 * 60 * 60 * 1000, // 30 днів
			httpOnly: false,
			path: "/",
			sameSite: "Lax",
		});

		return res.status(200).json({ success: true, message: "Мову оновлено." });
	} catch (error) {
		logging.error(error);
		console.error("Error updating user language:", error.message);
		return res.status(500).json({ message: "Помилка сервера." });
	}
});

// ═════════════════════════════════════════════════════════════════════════════
// СТОРІНКА КОРИСТУВАЧА: журнал входів, сесії, аватар, скидання 2FA
// ═════════════════════════════════════════════════════════════════════════════

// Перевірка сесії (викликається вкладкою по сокет-сигналу)
router.get("/api/me/session-check", authorizationControllers.isAuthenticated, (req, res) => res.json({ status: "success" }));

// ─── Журнал входів ──────────────────────────────────────────────────────────
router.post("/api/users/:id/login-log", authorizationControllers.isAuthenticated, profileGuard(profileCanView), async (req, res) => {
	try {
		const [log] = await connection_pool.query(
			`SELECT id, ip, country, city, user_agent, device, status, reason, date_add
			 FROM \`${prefix}users_login_log\`
			 WHERE id_user = ?
			 ORDER BY date_add DESC
			 LIMIT 500`,
			[req.targetId]
		);
		return res.json({ status: "success", data: log });
	} catch (error) {
		logging.error("[api/users/:id/login-log]", error);
		return res.status(500).json({ status: "error" });
	}
});

// ─── Активні сесії ──────────────────────────────────────────────────────────
router.post("/api/users/:id/sessions", authorizationControllers.isAuthenticated, profileGuard(profileCanView), async (req, res) => {
	try {
		const rows = await userSessions.listSessions(req.targetId);
		const data = rows.map((s) => ({
			id: s.id,
			ip: s.ip_address,
			...userSessions.describeUA(s.user_agent),
			device: userSessions.parseDevice(s.user_agent),
			user_agent: s.user_agent,
			created_at: s.created_at,
			last_activity: s.last_activity,
			expires_at: s.expires_at,
			current: s.sid === req.user.sid,
		}));
		return res.json({ status: "success", data, canManage: profileCanManage(req, req.targetId) });
	} catch (error) {
		logging.error("[api/users/:id/sessions]", error);
		return res.status(500).json({ status: "error" });
	}
});

router.post("/api/users/:id/sessions/:sessionId/revoke", authorizationControllers.isAuthenticated, profileGuard(profileCanManage), async (req, res) => {
	try {
		const sessionId = Number(req.params.sessionId);
		if (!sessionId) return res.status(422).json({ status: "error" });
		const n = await userSessions.revokeSession(req.targetId, sessionId, req.user.id);
		return res.json({ status: "success", revoked: n });
	} catch (error) {
		logging.error("[api/users/:id/sessions/revoke]", error);
		return res.status(500).json({ status: "error" });
	}
});

// Свій профіль — всі, крім поточної; чужий — всі
router.post("/api/users/:id/sessions/revoke-all", authorizationControllers.isAuthenticated, profileGuard(profileCanManage), async (req, res) => {
	try {
		const except = profileIsSelf(req, req.targetId) ? req.user.sid : null;
		const n = await userSessions.revokeAllSessions(req.targetId, except, req.user.id);
		return res.json({ status: "success", revoked: n });
	} catch (error) {
		logging.error("[api/users/:id/sessions/revoke-all]", error);
		return res.status(500).json({ status: "error" });
	}
});

// ─── Аватар ─────────────────────────────────────────────────────────────────
async function removeOldAvatar(id, filename) {
	if (!filename || filename.includes("/") || filename.includes("..")) return;
	await fsp.unlink(path.join(AVATAR_ROOT, String(id), filename)).catch(() => {});
}

router.post(
	"/api/users/:id/avatar",
	authorizationControllers.isAuthenticated,
	profileGuard(profileCanManage),
	(req, res, next) =>
		avatarUpload.single("avatar")(req, res, (err) => {
			if (err) return res.status(413).json({ status: "error", message: err.code === "LIMIT_FILE_SIZE" ? "max 5MB" : "upload error" });
			next();
		}),
	async (req, res) => {
		try {
			if (!req.file) return res.status(422).json({ status: "error", message: "invalid file" });

			let out;
			try {
				out = await sharp(req.file.buffer, { limitInputPixels: 40e6 }).rotate().resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "attention" }).webp({ quality: 82 }).toBuffer();
			} catch (e) {
				return res.status(422).json({ status: "error", message: "invalid image" });
			}

			const dir = path.join(AVATAR_ROOT, String(req.targetId));
			await fsp.mkdir(dir, { recursive: true });
			const filename = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}.webp`;
			await fsp.writeFile(path.join(dir, filename), out);

			const [[row]] = await connection_pool.query(`SELECT avatar FROM \`${prefix}users\` WHERE id = ?`, [req.targetId]);
			await connection_pool.query(`UPDATE \`${prefix}users\` SET avatar = ?, date_edit = NOW() WHERE id = ?`, [filename, req.targetId]);
			await removeOldAvatar(req.targetId, row && row.avatar);

			return res.json({ status: "success", url: `/uploads/users/${req.targetId}/${filename}` });
		} catch (error) {
			logging.error("[api/users/:id/avatar]", error);
			return res.status(500).json({ status: "error" });
		}
	}
);

router.post("/api/users/:id/avatar/delete", authorizationControllers.isAuthenticated, profileGuard(profileCanManage), async (req, res) => {
	try {
		const [[row]] = await connection_pool.query(`SELECT avatar FROM \`${prefix}users\` WHERE id = ?`, [req.targetId]);
		await connection_pool.query(`UPDATE \`${prefix}users\` SET avatar = NULL, date_edit = NOW() WHERE id = ?`, [req.targetId]);
		await removeOldAvatar(req.targetId, row && row.avatar);
		return res.json({ status: "success" });
	} catch (error) {
		logging.error("[api/users/:id/avatar/delete]", error);
		return res.status(500).json({ status: "error" });
	}
});

// ─── Скидання 2FA адміністратором (користувач втратив телефон і коди) ───────
// Лише для чужого профілю: свій вимикається через /api/tfa/disable з кодом.
router.post("/api/users/:id/tfa/reset", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id = profileTargetId(req);
		if (!id) return res.status(404).json({ status: "error" });
		if (profileIsSelf(req, id) || !authorizationControllers.hasPermission(req, "users.list", "edit")) {
			return res.status(403).json({ status: "error", message: "Forbidden" });
		}

		const [r] = await connection_pool.query(
			`UPDATE \`${prefix}users\`
			 SET tfa_enabled = 0, tfa_secret = '', tfa_secret_pending = '', tfa_last_step = 0,
			     tfa_failed_attempts = 0, tfa_locked_until = NULL, date_edit = NOW()
			 WHERE id = ? AND tfa_enabled = 1`,
			[id]
		);
		if (!r.affectedRows) return res.status(409).json({ status: "error", message: "2FA not enabled" });

		await connection_pool.query(`DELETE FROM \`${prefix}users_tfa_backup_codes\` WHERE id_user = ?`, [id]);

		// Усі сесії користувача закриваємо: хто б не мав доступ, має увійти заново
		const closed = await userSessions.revokeAllSessions(id, null, req.user.id);

		await connection_pool
			.query(
				`INSERT INTO \`${prefix}users_security_events\` (id_user, ip_address, event_type, user_agent, details, created_at)
				 VALUES (?, ?, '2fa_disabled', ?, ?, NOW())`,
				[id, (req.ip || "").replace(/^::ffff:/, ""), String(req.headers["user-agent"] || "").slice(0, 512), JSON.stringify({ reset_by_admin: req.user.id, sessions_closed: closed })]
			)
			.catch((err) => logging.error("[tfa/reset] security_event", err));

		return res.json({ status: "success", message: req.__("users.edit.tfa_admin_reset_done") });
	} catch (error) {
		logging.error("[api/users/:id/tfa/reset]", error);
		return res.status(500).json({ status: "error" });
	}
});

// ─── Збереження основної інформації (свій профіль або з правом users.list edit) ─
// Зміна власного email: потрібен поточний пароль, а сама зміна відбувається лише
// після підтвердження з нової адреси. Стара адреса отримує повідомлення.
router.post("/api/users/:id/basic", authorizationControllers.isAuthenticated, profileGuard(profileCanManage), async (req, res) => {
	try {
		const data = {
			last_name: String(req.body.last_name ?? "").trim(),
			first_name: String(req.body.first_name ?? "").trim(),
			patronymic: String(req.body.patronymic ?? "").trim(),
			email: String(req.body.email ?? "").trim().toLowerCase(),
			phone: String(req.body.phone ?? "").trim(),
			birthday: req.body.birthday || null,
			gender: Number(req.body.gender) || 0,
		};

		const { valid } = validate.basic(data);
		if (!valid || !data.last_name || !data.first_name) {
			return res.status(422).json({ status: "error", message: req.__("users.edit.error_fields") });
		}

		const [[current]] = await connection_pool.query(`SELECT email, password FROM \`${prefix}users\` WHERE id = ? LIMIT 1`, [req.targetId]);
		if (!current) return res.status(404).json({ status: "error", message: req.__("users.edit.error_fields") });

		const isSelf = Number(req.user.id) === req.targetId;
		const emailChanged = data.email !== String(current.email).toLowerCase();

		if (emailChanged) {
			const [dup] = await connection_pool.query(`SELECT id FROM \`${prefix}users\` WHERE email = ? AND id <> ? LIMIT 1`, [data.email, req.targetId]);
			if (dup.length) {
				return res.status(422).json({ status: "error", message: req.__("users.edit.email_taken") });
			}
			if (isSelf) {
				const password = String(req.body.current_password || "");
				if (!password || !(await bcrypt.compare(password, current.password))) {
					return res.status(422).json({ status: "error", field: "email-password", message: req.__("users.edit.password_wrong") });
				}
			}
		}

		// Власний email не змінюється одразу — лише після підтвердження
		const newEmail = emailChanged && isSelf ? current.email : data.email;

		await connection_pool.query(
			`UPDATE \`${prefix}users\`
			 SET last_name = ?, first_name = ?, patronymic = ?, email = ?, phone = ?, birthday = ?, gender = ?, date_edit = NOW()
			 WHERE id = ?`,
			[data.last_name, data.first_name, data.patronymic, newEmail, data.phone, data.birthday, data.gender, req.targetId]
		);

		if (!emailChanged) {
			return res.json({ status: "success", message: req.__("users.edit.saved") });
		}

		const ip = (req.ip || "").replace(/^::ffff:/, "");
		const ua = String(req.headers["user-agent"] || "").slice(0, 512);

		if (isSelf) {
			const token = crypto.randomBytes(32).toString("hex");
			await connection_pool.query(`DELETE FROM \`${prefix}users_email_changes\` WHERE id_user = ?`, [req.targetId]);
			await connection_pool.query(
				`INSERT INTO \`${prefix}users_email_changes\` (id_user, new_email, token_hash, expires_at, date_add)
				 VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR), NOW())`,
				[req.targetId, data.email, hashToken(token)]
			);
			await connection_pool
				.query(
					`INSERT INTO \`${prefix}users_security_events\` (id_user, ip_address, event_type, user_agent, details, created_at)
					 VALUES (?, ?, 'email_change_requested', ?, ?, NOW())`,
					[req.targetId, ip, ua, JSON.stringify({ new_email: data.email })]
				)
				.catch((err) => logging.error("[basic] security_event", err));

			sendEmailChangeConfirm(data.email, token).catch((err) => logging.error("[basic] sendEmailChangeConfirm", err));
			sendEmailChangeNotice(current.email, data.email).catch((err) => logging.error("[basic] sendEmailChangeNotice", err));

			return res.json({ status: "success", message: req.__("users.edit.email_confirm_sent", { email: data.email }) });
		}

		// Email змінив адміністратор — фіксуємо й повідомляємо стару адресу
		await connection_pool
			.query(
				`INSERT INTO \`${prefix}users_security_events\` (id_user, ip_address, event_type, user_agent, details, created_at)
				 VALUES (?, ?, 'email_changed', ?, ?, NOW())`,
				[req.targetId, ip, ua, JSON.stringify({ old_email: current.email, new_email: data.email, changed_by: req.user.id })]
			)
			.catch((err) => logging.error("[basic] security_event", err));
		sendEmailChangeNotice(current.email, data.email).catch((err) => logging.error("[basic] sendEmailChangeNotice", err));

		return res.json({ status: "success", message: req.__("users.edit.saved") });
	} catch (error) {
		logging.error("[api/users/:id/basic]", error);
		return res.status(500).json({ status: "error", message: req.__("users.edit.error_network") });
	}
});

// ─── Підтвердження нового email за посиланням з листа ───────────────────────
router.get("/users/email/confirm/:token", invitePageLimiter, async (req, res) => {
	try {
		const [[change]] = await connection_pool.query(
			`SELECT id, id_user, new_email FROM \`${prefix}users_email_changes\`
			 WHERE token_hash = ? AND expires_at > NOW()
			 LIMIT 1`,
			[hashToken(String(req.params.token || ""))]
		);
		if (!change) return res.redirect("/users/profile/edit?email=invalid");

		// Поки лист чекав, адресу міг зайняти хтось інший
		const [dup] = await connection_pool.query(`SELECT id FROM \`${prefix}users\` WHERE email = ? AND id <> ? LIMIT 1`, [change.new_email, change.id_user]);
		if (dup.length) {
			await connection_pool.query(`DELETE FROM \`${prefix}users_email_changes\` WHERE id = ?`, [change.id]);
			return res.redirect("/users/profile/edit?email=invalid");
		}

		const [[old]] = await connection_pool.query(`SELECT email FROM \`${prefix}users\` WHERE id = ? LIMIT 1`, [change.id_user]);
		await connection_pool.query(`UPDATE \`${prefix}users\` SET email = ?, date_edit = NOW() WHERE id = ?`, [change.new_email, change.id_user]);
		await connection_pool.query(`DELETE FROM \`${prefix}users_email_changes\` WHERE id_user = ?`, [change.id_user]);

		await connection_pool
			.query(
				`INSERT INTO \`${prefix}users_security_events\` (id_user, ip_address, event_type, user_agent, details, created_at)
				 VALUES (?, ?, 'email_changed', ?, ?, NOW())`,
				[change.id_user, (req.ip || "").replace(/^::ffff:/, ""), String(req.headers["user-agent"] || "").slice(0, 512), JSON.stringify({ old_email: old && old.email, new_email: change.new_email })]
			)
			.catch((err) => logging.error("[email/confirm] security_event", err));

		return res.redirect("/users/profile/edit?email=confirmed");
	} catch (error) {
		logging.error("[users/email/confirm]", error);
		return res.redirect("/users/profile/edit?email=invalid");
	}
});

// ─── Збереження груп (лише з правом users.list edit) ─────────────────────────
router.post(
	"/api/users/:id/groups",
	authorizationControllers.isAuthenticated,
	profileGuard((req) => authorizationControllers.hasPermission(req, "users.list", "edit")),
	async (req, res) => {
		const groups = [...new Set((Array.isArray(req.body.groups) ? req.body.groups : []).map(Number))];
		if (!validate.groups({ groups }).valid) {
			return res.status(422).json({ status: "error", message: req.__("users.edit.error_fields") });
		}

		// Власні групи змінювати не можна (інакше можна видати собі будь-які права)
		if (Number(req.user.id) === req.targetId) {
			return res.status(403).json({ status: "error", message: req.__("users.edit.groups_own_forbidden") });
		}

		// Призначати або знімати групу адміністратора може лише адміністратор
		const [[actorIsAdmin]] = await connection_pool.query(`SELECT COUNT(*) AS cnt FROM \`${prefix}users_to_groups\` WHERE id_user = ? AND id_group = 1`, [req.user.id]);
		if (!actorIsAdmin.cnt) {
			const [[targetIsAdmin]] = await connection_pool.query(`SELECT COUNT(*) AS cnt FROM \`${prefix}users_to_groups\` WHERE id_user = ? AND id_group = 1`, [req.targetId]);
			if (groups.includes(1) || targetIsAdmin.cnt) {
				return res.status(403).json({ status: "error", message: req.__("users.edit.groups_admin_forbidden") });
			}
		}

		const conn = await connection_pool.getConnection();
		try {
			await conn.beginTransaction();
			await conn.query(`DELETE FROM \`${prefix}users_to_groups\` WHERE id_user = ?`, [req.targetId]);
			if (groups.length) {
				await conn.query(
					`INSERT INTO \`${prefix}users_to_groups\` (id_user, id_group)
					 SELECT ?, id FROM \`${prefix}users_groups\` WHERE id IN (?) AND active = 1`,
					[req.targetId, groups]
				);
			}
			await conn.commit();
			return res.json({ status: "success", message: req.__("users.edit.saved") });
		} catch (error) {
			await conn.rollback();
			logging.error("[api/users/:id/groups]", error);
			return res.status(500).json({ status: "error", message: req.__("users.edit.error_network") });
		} finally {
			conn.release();
		}
	}
);

module.exports = router;
