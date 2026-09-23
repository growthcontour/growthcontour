"use strict";

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const validator = require("validator");
const bcryptjs = require("bcryptjs");

// ─── Контролери ──────────────────────────────────────────────────────────────
const authorizationControllers = require("../../controllers/authorization/authorization");

// ─── Mail ────────────────────────────────────────────────────────────────────
const { sendInviteEmail, sendAccountActivatedEmail } = require("../../controllers/mail/mail");

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
const validateAdd = require("../../validator/users/add");
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

router.get("/users/:id([0-9]+)/", authorizationControllers.isAuthenticated, async (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const id_lang = req.user.id_lang || 1;

		const [[targetUser]] = await connection_pool.query(
			`SELECT
                    id, email,
                    first_name, last_name, patronymic,
                    phone, birthday, gender, avatar,
                    id_lang, active, tfa_enabled,
                    failed_login_attempts, locked_until,
                    id_created_by,
                    date_last_login, date_online_since, date_last_seen,
                    date_add, date_edit
                 FROM \`${prefix}users\`
                 WHERE id = ?
                 LIMIT 1`,
			[id]
		);

		if (!targetUser) {
			return res.status(404).render("pages/404", { i18n: req, user: req.user });
		}

		const [groups] = await connection_pool.query(
			`SELECT g.id, gl.name
                 FROM \`${prefix}users_to_groups\` ug
                 JOIN \`${prefix}users_groups\` g ON g.id = ug.id_group
                 LEFT JOIN \`${prefix}users_groups_lang\` gl
                        ON gl.id_group = g.id AND gl.id_lang = ?
                 WHERE ug.id_user = ?
                 ORDER BY g.id ASC`,
			[id_lang, id]
		);

		return res.render("pages/users/view", {
			i18n: req,
			user: req.user,
			targetUser,
			groups,
			header: { navbar: "users", subnavbar: "users" },
		});
	} catch (error) {
		logging.error("[users/:id/view]", error);
		return res.status(500).render("pages/500", { i18n: req, user: req.user });
	}
});

router.get("/users/:id([0-9]+)/edit", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.list", "view"), async (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const id_lang = req.user.id_lang || 1;

		const [[targetUser]] = await connection_pool.query(
			`SELECT id, email, first_name, last_name, patronymic, phone, birthday, gender, avatar, id_lang, active, tfa_enabled
             FROM \`${prefix}users\` WHERE id = ? LIMIT 1`,
			[id]
		);
		if (!targetUser) return res.status(404).render("pages/404", { i18n: req, user: req.user });

		const [allGroups] = await connection_pool.query(
			`SELECT g.id, gl.name
             FROM \`${prefix}users_groups\` g
             LEFT JOIN \`${prefix}users_groups_lang\` gl ON gl.id_group = g.id AND gl.id_lang = ?
             WHERE g.active = 1 ORDER BY g.id ASC`,
			[id_lang]
		);

		const [userGroupRows] = await connection_pool.query(`SELECT id_group FROM \`${prefix}users_to_groups\` WHERE id_user = ?`, [id]);

		res.render("pages/users/edit", {
			i18n: req,
			user: req.user,
			targetUser,
			allGroups,
			userGroupIds: userGroupRows.map((r) => r.id_group),
			header: { navbar: "users", subnavbar: "users" },
			isSelf: Number(targetUser.id) === Number(req.user.id),
			canResetTfa: authorizationControllers.hasPermission(req, "users.list", "edit"),
		});
	} catch (error) {
		logging.error("[users/:id/edit]", error);
    console.error("[users/:id/edit] РЕАЛЬНА ПОМИЛКА:", error);
		return res.status(500).render("pages/500", { i18n: req, user: req.user });
	}
});

// ─── GET /users/access ───────────────────────────────────────────────────────
router.get("/users/access", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.list", "view"), (req, res) => {
	res.render("pages/users/access", {
		i18n: req,
		user: req.user,
		header: { navbar: "users", subnavbar: "access" },
	});
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

// Сторінка груп
router.get("/users/groups", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.groups", "view"), async (req, res) => {
	try {
		const id_lang = req.user.id_lang || 1;

		const [groups] = await connection_pool.query(
			`SELECT g.id, g.active, gl.name
             FROM \`${prefix}users_groups\` g
             LEFT JOIN \`${prefix}users_groups_lang\` gl
                    ON gl.id_group = g.id AND gl.id_lang = ?
             ORDER BY g.id ASC`,
			[id_lang]
		);

		return res.render("pages/users/groups", {
			i18n: req,
			user: req.user,
			groups,
			header: { navbar: "users", subnavbar: "groups" },
		});
	} catch (error) {
		logging.error("[users/groups]", error);
		return res.status(500).render("pages/500", { i18n: req, user: req.user });
	}
});

router.get("/users/groups/:id([0-9]+)/permissions", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.groups", "view"), async (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const id_lang = req.user.id_lang || 1;

		const [[group]] = await connection_pool.query(
			`SELECT g.id, g.active, gl.name
             FROM \`${prefix}users_groups\` g
             LEFT JOIN \`${prefix}users_groups_lang\` gl
                    ON gl.id_group = g.id AND gl.id_lang = ?
             WHERE g.id = ?
             LIMIT 1`,
			[id_lang, id]
		);

		if (!group) {
			return res.redirect("/404");
		}

		const [pages] = await connection_pool.query(
			`SELECT
                pp.id,
                pp.slug,
                pp.parent_id,
                pp.sort_order,
                pl.name,
                COALESCE(gp.can_view,   0) AS can_view,
                COALESCE(gp.can_add,    0) AS can_add,
                COALESCE(gp.can_edit,   0) AS can_edit,
                COALESCE(gp.can_delete, 0) AS can_delete
             FROM \`${prefix}users_permissions_pages\` pp
             LEFT JOIN \`${prefix}users_permissions_pages_lang\` pl
                    ON pl.id_page = pp.id AND pl.id_lang = ?
             LEFT JOIN \`${prefix}users_groups_permissions\` gp
                    ON gp.id_page = pp.id AND gp.id_group = ?
             ORDER BY pp.sort_order ASC, pp.id ASC`,
			[id_lang, id]
		);

		const tree = pages
			.filter((p) => p.parent_id === null)
			.map((parent) => ({
				...parent,
				children: pages.filter((p) => p.parent_id === parent.id),
			}));

		return res.render("pages/users/group-permissions", {
			i18n: req,
			user: req.user,
			group,
			tree,
			header: { navbar: "users", subnavbar: "groups" },
		});
	} catch (error) {
		logging.error("[users/groups/:id/permissions]", error);
		return res.status(500).render("pages/500", { i18n: req, user: req.user });
	}
});

router.post("/api/users/groups/:id([0-9]+)/permissions/toggle", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.groups", "edit"), async (req, res) => {
	try {
		const id_group = parseInt(req.params.id);
		const id_page = parseInt(req.body.id_page);
		const action = req.body.action;

		if (id_group === 1) {
			return res.status(403).json({ status: "error", message: "Cannot modify administrator permissions" });
		}

		const allowed = ["can_view", "can_add", "can_edit", "can_delete"];
		if (!allowed.includes(action)) {
			return res.status(422).json({ status: "error", message: "Invalid action" });
		}

		if (!id_page || isNaN(id_page)) {
			return res.status(422).json({ status: "error", message: "Invalid id_page" });
		}

		const [[group]] = await connection_pool.query(`SELECT id FROM \`${prefix}users_groups\` WHERE id = ? LIMIT 1`, [id_group]);

		if (!group) {
			return res.status(404).json({ status: "error", message: "Group not found" });
		}

		const [[page]] = await connection_pool.query(
			`SELECT id FROM \`${prefix}users_permissions_pages\`
                 WHERE id = ? AND parent_id IS NOT NULL LIMIT 1`,
			[id_page]
		);

		if (!page) {
			return res.status(404).json({ status: "error", message: "Page not found" });
		}

		const [[current]] = await connection_pool.query(
			`SELECT \`${action}\` AS val
                 FROM \`${prefix}users_groups_permissions\`
                 WHERE id_group = ? AND id_page = ?
                 LIMIT 1`,
			[id_group, id_page]
		);

		const newValue = current ? (current.val === 1 ? 0 : 1) : 1;

		await connection_pool.query(
			`INSERT INTO \`${prefix}users_groups_permissions\`
                    (id_group, id_page, can_view, can_add, can_edit, can_delete)
                 VALUES (?, ?, 0, 0, 0, 0)
                 ON DUPLICATE KEY UPDATE \`${action}\` = ?`,
			[id_group, id_page, newValue]
		);

		return res.json({ status: "success", action, value: newValue });
	} catch (error) {
		logging.error("[api/users/groups/:id/permissions/toggle]", error);
		return res.status(500).json({ status: "error", message: error.message });
	}
});
// END Сторінка груп

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

router.post("/api/users/:id([0-9]+)/login-log", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.list", "view"), async (req, res) => {
	try {
		const id = parseInt(req.params.id);

		const [log] = await connection_pool.query(
			`SELECT id, ip, country, city, user_agent, device, status, date_add
                 FROM \`${prefix}users_login_log\`
                 WHERE id_user = ?
                 ORDER BY date_add DESC
                 LIMIT 500`,
			[id]
		);

		return res.json({ status: "success", data: log });
	} catch (error) {
		logging.error("[api/users/:id/login-log]", error);
		return res.status(500).json({ status: "error" });
	}
});

// Скидання пароля на сторінці користувача
router.post("/api/users/:id([0-9]+)/update-password", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.list", "edit"), async (req, res) => {
	try {
		const id = parseInt(req.params.id);

		if (req.user.id !== id) {
			return res.status(403).json({ status: "error", message: "forbidden" });
		}

		const { valid, errors } = validate.password(req.body);
		if (!valid) return res.status(400).json({ status: "error", errors });

		const { current_password, new_password, confirm_password } = req.body;

		if (new_password !== confirm_password) {
			return res.json({
				status: "error",
				errors: [{ field: "password-confirm", message: req.__("users.edit.password_mismatch") }],
			});
		}

		const [[u]] = await connection_pool.query(`SELECT password FROM \`${prefix}users\` WHERE id = ? LIMIT 1`, [id]);
		if (!u) return res.status(404).json({ status: "error", message: "not_found" });

		const match = await bcryptjs.compare(current_password, u.password);
		if (!match) {
			return res.json({
				status: "error",
				errors: [{ field: "password-current", message: req.__("users.edit.password_wrong") }],
			});
		}

		const sameAsOld = await bcryptjs.compare(new_password, u.password);
		if (sameAsOld) {
			return res.json({
				status: "error",
				errors: [{ field: "password-new", message: req.__("users.edit.password_same") }],
			});
		}

		const hash = await bcryptjs.hash(new_password, 12);
		await connection_pool.query(`UPDATE \`${prefix}users\` SET password = ?, token_version = token_version + 1 WHERE id = ?`, [hash, id]);

		return res.json({ status: "success", message: req.__("users.edit.password_changed") });
	} catch (error) {
		logging.error("[api/users/:id/update-password]", error);
		return res.status(500).json({ status: "error" });
	}
});
// END Скидання пароля на сторінці користувача

// ─── POST /api/users/:id/resend-invite ────────────────────────────────────────
router.post("/api/users/:id([0-9]+)/resend-invite", authorizationControllers.isAuthenticated, authorizationControllers.checkPermission("users.list", "add"), async (req, res) => {
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
router.get("/invite/:token", async (req, res) => {
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
router.post("/api/invite/accept", async (req, res) => {
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

module.exports = router;
