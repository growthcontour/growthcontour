-- ================================================================
-- Чиста установка системи (структура + довідники)
-- Згенеровано: 2026-11-27T00:00:34.954Z
-- Структура й довідники еталона; префікс таблиць: prefix_
-- Таблиць: 555, довідників з даними: 138, рядків: 2310
-- Дати створення записів — момент установки (NOW()).
-- Користувачів немає: адміністратора (група 1) створює система при першому запуску з ADMIN_EMAIL у .env.
-- Установка: заповни .env і запусти систему — файл імпортується автоматично (вручну не імпортувати).
-- ================================================================

SET NAMES utf8mb4;
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;
SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';

-- ── 1. Таблиці ──
CREATE TABLE IF NOT EXISTS `prefix_analytics_cache` (
  `cache_key` char(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `params` json DEFAULT NULL,
  `payload` longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `built_at` datetime NOT NULL,
  `ms` int unsigned NOT NULL DEFAULT '0' COMMENT 'скільки рахувалось',
  PRIMARY KEY (`cache_key`),
  KEY `idx_built` (`built_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_audit_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_user` int unsigned DEFAULT NULL,
  `action` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'export / import / bulk / merge / merge_revert / settings_save / settings_delete / settings_sort',
  `module` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `entity` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_entity` bigint unsigned DEFAULT NULL,
  `count` int unsigned NOT NULL DEFAULT '0' COMMENT 'Скільки записів зачепила дія',
  `details` json DEFAULT NULL,
  `ip` varbinary(16) DEFAULT NULL,
  `user_agent` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_date` (`date_add`),
  KEY `idx_user_date` (`id_user`,`date_add`),
  KEY `idx_action_date` (`action`,`date_add`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_automation_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `rule` varchar(48) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ref_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Унікальний ключ випадку: lead:7, client:5:202609301200, churn:123',
  `ref_type` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_ref` bigint unsigned NOT NULL,
  `id_event` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rule_key` (`rule`,`ref_key`),
  KEY `idx_ref` (`ref_type`,`id_ref`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_automation_rules` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(48) COLLATE utf8mb4_unicode_ci NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `delay_value` int NOT NULL DEFAULT '0' COMMENT 'Хвилини (lead_no_reaction) або дні (client_reorder)',
  `time_of_day` char(5) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '10:00' COMMENT 'Час задачі для денних правил',
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Шаблон: {title}, {name}',
  `id_event_type` tinyint unsigned DEFAULT NULL,
  `priority` tinyint unsigned NOT NULL DEFAULT '2',
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_calendar_event_links` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_event` int unsigned NOT NULL,
  `ref_type` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'client / lead / order / deal / conversation',
  `id_ref` bigint unsigned NOT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_link` (`id_event`,`ref_type`,`id_ref`),
  KEY `idx_ref` (`ref_type`,`id_ref`,`id_event`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_calendar_event_type` (
  `id` tinyint unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(50) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  `icon` varchar(100) CHARACTER SET ascii COLLATE ascii_general_ci DEFAULT NULL,
  `color` char(7) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL DEFAULT '#007bff',
  `is_system` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'системний тип — не можна видалити',
  `is_absence` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1-відсутність (відпустка/лікарняний): рендериться фоновою смугою',
  `default_visibility` tinyint unsigned NOT NULL DEFAULT '1' COMMENT 'видимість за замовчуванням для цього типу',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` tinyint unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Типи подій особистого календаря';

CREATE TABLE IF NOT EXISTS `prefix_calendar_event_type_lang` (
  `id_event_type` tinyint unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id_event_type`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Переклади типів подій';

CREATE TABLE IF NOT EXISTS `prefix_calendar_event_users` (
  `id_user` int unsigned NOT NULL,
  `date_start` datetime NOT NULL COMMENT 'денормалізація з events',
  `id_event` bigint unsigned NOT NULL,
  `date_end` datetime NOT NULL COMMENT 'денормалізація з events',
  `is_owner` tinyint(1) NOT NULL DEFAULT '0',
  `response` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '0-очікує 1-прийнято 2-відхилено 3-можливо',
  `is_hidden` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'учасник прибрав подію зі свого календаря',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id_user`,`date_start`,`id_event`),
  KEY `idx_event` (`id_event`),
  KEY `idx_pending` (`id_user`,`response`,`date_start`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Учасники подій календаря (fan-out)'
/*!50100 PARTITION BY KEY (id_user)
PARTITIONS 64 */;

CREATE TABLE IF NOT EXISTS `prefix_calendar_events` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_user_creator` int unsigned NOT NULL,
  `id_event_type` tinyint unsigned DEFAULT NULL,
  `title` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `location` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `location_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_start` datetime NOT NULL,
  `date_end` datetime NOT NULL,
  `all_day` tinyint(1) NOT NULL DEFAULT '0',
  `tz_offset` smallint NOT NULL DEFAULT '0' COMMENT 'зсув таймзони автора у хвилинах на момент створення',
  `priority` tinyint unsigned NOT NULL DEFAULT '2' COMMENT '1-низький 2-середній 3-високий 4-критичний',
  `status` tinyint unsigned NOT NULL DEFAULT '1' COMMENT '1-planned 2-done 3-canceled',
  `is_shared` tinyint(1) NOT NULL DEFAULT '0' COMMENT '0-лише автор, 1-є інші учасники',
  `visibility` tinyint unsigned NOT NULL DEFAULT '1' COMMENT '1-private 2-busy 3-team(резерв) 4-company',
  `notify_scope` tinyint unsigned NOT NULL DEFAULT '2' COMMENT '0-none 1-me 2-participants 3-team(резерв) 4-company',
  `is_busy` tinyint(1) NOT NULL DEFAULT '1' COMMENT '1-час зайнятий (впливає на Free/Busy), 0-вільний',
  `participants_cnt` smallint unsigned NOT NULL DEFAULT '1' COMMENT 'денормалізований лічильник, разом з автором',
  `reminder_minutes` smallint unsigned DEFAULT NULL COMMENT 'NULL = без нагадування',
  `id_ref_type` tinyint unsigned DEFAULT NULL COMMENT 'зв''язок із сутністю CRM: 1-deal 2-company 3-contact 4-lead',
  `id_ref` int unsigned DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_creator` (`id_user_creator`,`active`,`date_start`),
  KEY `idx_ref` (`id_ref_type`,`id_ref`),
  KEY `idx_visibility_range` (`visibility`,`active`,`date_start`,`date_end`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Події особистого календаря'
/*!50100 PARTITION BY KEY (id)
PARTITIONS 16 */;

CREATE TABLE IF NOT EXISTS `prefix_calendar_hidden_events` (
  `id_user` int unsigned NOT NULL,
  `id_event` bigint unsigned NOT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id_user`,`id_event`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Чужі видимі події, які користувач сховав у себе';

CREATE TABLE IF NOT EXISTS `prefix_calendar_reminder_queue` (
  `id_event` bigint unsigned NOT NULL,
  `id_user` int unsigned NOT NULL,
  `kind` tinyint unsigned NOT NULL DEFAULT '1' COMMENT '1-попереднє (за N хв) 2-у момент початку',
  `date_fire` datetime NOT NULL COMMENT 'date_start - reminder_minutes',
  `sent` tinyint(1) NOT NULL DEFAULT '0',
  `attempts` tinyint unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id_event`,`id_user`,`kind`),
  KEY `idx_fire` (`sent`,`date_fire`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Черга нагадувань — тільки майбутні, старі чистяться';

CREATE TABLE IF NOT EXISTS `prefix_calendar_user_settings` (
  `id_user` int unsigned NOT NULL,
  `default_view` varchar(20) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL DEFAULT 'dayGridMonth',
  `first_day` tinyint unsigned NOT NULL DEFAULT '1' COMMENT '0-нд 1-пн',
  `work_time_start` time NOT NULL DEFAULT '09:00:00',
  `work_time_end` time NOT NULL DEFAULT '18:00:00',
  `default_reminder` smallint unsigned DEFAULT '30',
  `notify_email` tinyint(1) NOT NULL DEFAULT '1',
  `notify_push` tinyint(1) NOT NULL DEFAULT '1',
  `auto_accept` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'автоприйняття запрошень',
  `show_company` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'показувати події рівня "вся компанія"',
  `show_busy` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'показувати шар зайнятості колег',
  `default_visibility` tinyint unsigned NOT NULL DEFAULT '1' COMMENT 'видимість нових подій за замовчуванням',
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id_user`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Персональні налаштування календаря';

CREATE TABLE IF NOT EXISTS `prefix_catalog_brands` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `logo_url` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `banner_url` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `website` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_name` (`name`),
  KEY `idx_active` (`active`),
  KEY `idx_sort` (`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_catalog_brands_lang` (
  `id` int NOT NULL AUTO_INCREMENT,
  `id_brand` int NOT NULL,
  `id_lang` int NOT NULL,
  `short_description` varchar(999) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `meta_title` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `meta_description` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_brand_lang` (`id_brand`,`id_lang`),
  KEY `idx_brand` (`id_brand`),
  KEY `idx_lang` (`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_catalog_currency` (
  `id` int NOT NULL AUTO_INCREMENT,
  `iso_code` char(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `iso_code_num` char(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_plural` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `symbol` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `symbol_native` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `symbol_position` tinyint(1) NOT NULL DEFAULT '0',
  `symbol_spacer` tinyint(1) NOT NULL DEFAULT '0',
  `decimal_digits` tinyint unsigned NOT NULL DEFAULT '2',
  `decimal_separator` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '.',
  `thousand_separator` char(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT ',',
  `rounding` decimal(5,2) NOT NULL DEFAULT '0.00',
  `conversion_rate` decimal(13,6) NOT NULL DEFAULT '1.000000',
  `rate_updated_at` datetime DEFAULT NULL,
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_iso_code` (`iso_code`),
  UNIQUE KEY `uq_iso_code_num` (`iso_code_num`),
  KEY `idx_active` (`active`),
  KEY `idx_default` (`is_default`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_catalog_lang` (
  `id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(5) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_native` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `locale` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `encoding` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `flag_url` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `url_prefix` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_format` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'Y-m-d',
  `date_format_full` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'Y-m-d H:i:s',
  `decimal_separator` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '.',
  `thousand_separator` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT ',',
  `is_rtl` tinyint(1) NOT NULL DEFAULT '0',
  `default` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`),
  UNIQUE KEY `uq_locale` (`locale`),
  UNIQUE KEY `uq_url_prefix` (`url_prefix`),
  KEY `idx_active` (`active`),
  KEY `idx_default` (`default`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_catalog_stock_status` (
  `id` int NOT NULL AUTO_INCREMENT,
  `color_background` varchar(7) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#000000',
  `color_text` varchar(7) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_active` (`active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_catalog_stock_status_lang` (
  `id` int NOT NULL AUTO_INCREMENT,
  `id_stock_status` int NOT NULL,
  `id_lang` int NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_status_lang` (`id_stock_status`,`id_lang`),
  KEY `idx_status` (`id_stock_status`),
  KEY `idx_lang` (`id_lang`),
  CONSTRAINT `fk_stock_status_lang_lang` FOREIGN KEY (`id_lang`) REFERENCES `prefix_catalog_lang` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_stock_status_lang_status` FOREIGN KEY (`id_stock_status`) REFERENCES `prefix_catalog_stock_status` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_acks` (
  `id_message` bigint unsigned NOT NULL,
  `id_user` int unsigned NOT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id_message`,`id_user`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_decisions` (
  `id_message` bigint unsigned NOT NULL,
  `id_room` int unsigned NOT NULL,
  `id_user` int unsigned NOT NULL,
  `note` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id_message`),
  KEY `idx_room` (`id_room`,`date_add`),
  CONSTRAINT `fk_chat_decisions_room` FOREIGN KEY (`id_room`) REFERENCES `prefix_chat_rooms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_files` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `code` char(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT (lower(hex(random_bytes(16)))),
  `id_room` int unsigned NOT NULL,
  `id_message` bigint unsigned DEFAULT NULL,
  `id_user` int unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mime` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `size` bigint unsigned NOT NULL,
  `path` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'відносно storage/chat',
  `width` int unsigned DEFAULT NULL,
  `height` int unsigned DEFAULT NULL,
  `as_file` tinyint(1) NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`),
  KEY `idx_message` (`id_message`),
  KEY `idx_room` (`id_room`,`id`),
  KEY `idx_orphans` (`id_message`,`date_add`),
  KEY `idx_path` (`path`),
  CONSTRAINT `fk_chat_files_room` FOREIGN KEY (`id_room`) REFERENCES `prefix_chat_rooms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_items` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_message` bigint unsigned NOT NULL,
  `kind` enum('option','check') COLLATE utf8mb4_unicode_ci NOT NULL,
  `sort` tinyint unsigned NOT NULL DEFAULT '0',
  `text` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `done_by` int unsigned DEFAULT NULL,
  `done_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_message` (`id_message`,`kind`,`sort`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_members` (
  `id_room` int unsigned NOT NULL,
  `id_user` int unsigned NOT NULL,
  `role` enum('owner','admin','member') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'member',
  `last_read_id` bigint unsigned NOT NULL DEFAULT '0',
  `notify` enum('all','mentions','none') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'all',
  `muted_until` datetime DEFAULT NULL,
  `pinned` tinyint(1) NOT NULL DEFAULT '0',
  `hidden` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'особистий чат прибрано зі списку; повертається з новим повідомленням',
  `draft` text COLLATE utf8mb4_unicode_ci,
  `draft_at` datetime DEFAULT NULL,
  `joined_at` datetime NOT NULL,
  PRIMARY KEY (`id_room`,`id_user`),
  KEY `idx_user` (`id_user`,`hidden`),
  CONSTRAINT `fk_chat_members_room` FOREIGN KEY (`id_room`) REFERENCES `prefix_chat_rooms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_mentions` (
  `id_message` bigint unsigned NOT NULL,
  `id_user` int unsigned NOT NULL,
  `kind` enum('user','department','office','all') COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id_message`,`id_user`),
  KEY `idx_user` (`id_user`,`id_message`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_messages` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_room` int unsigned NOT NULL,
  `id_thread` bigint unsigned DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL COMMENT 'NULL — системне повідомлення',
  `type` enum('text','system','event') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'text',
  `body` text COLLATE utf8mb4_unicode_ci,
  `data` json DEFAULT NULL COMMENT 'system: {event, ...}; forward: {from_user, from_name, from_room, date}',
  `id_reply` bigint unsigned DEFAULT NULL,
  `id_forward` bigint unsigned DEFAULT NULL,
  `has_files` tinyint(1) NOT NULL DEFAULT '0',
  `has_links` tinyint(1) NOT NULL DEFAULT '0',
  `edited_at` datetime(3) DEFAULT NULL,
  `deleted_at` datetime(3) DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  `client_id` char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ідентифікатор від браузера — повторна відправка не створює дубль',
  `date_add` datetime(3) NOT NULL,
  `thread_count` int unsigned NOT NULL DEFAULT '0',
  `thread_last_at` datetime(3) DEFAULT NULL,
  `urgent` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_client` (`id_user`,`client_id`),
  KEY `idx_room` (`id_room`,`id`),
  KEY `idx_user` (`id_user`,`id`),
  KEY `idx_thread` (`id_thread`,`id`),
  KEY `idx_room_main` (`id_room`,`id_thread`,`id`),
  FULLTEXT KEY `ft_body` (`body`) /*!50100 WITH PARSER `ngram` */ ,
  CONSTRAINT `fk_chat_messages_room` FOREIGN KEY (`id_room`) REFERENCES `prefix_chat_rooms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_pins` (
  `id_room` int unsigned NOT NULL,
  `id_message` bigint unsigned NOT NULL,
  `id_user` int unsigned NOT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id_room`,`id_message`),
  CONSTRAINT `fk_chat_pins_room` FOREIGN KEY (`id_room`) REFERENCES `prefix_chat_rooms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_polls` (
  `id_message` bigint unsigned NOT NULL,
  `multiple` tinyint(1) NOT NULL DEFAULT '0',
  `anonymous` tinyint(1) NOT NULL DEFAULT '0',
  `closes_at` datetime DEFAULT NULL COMMENT 'UTC',
  `closed` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id_message`),
  KEY `idx_due` (`closed`,`closes_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_reactions` (
  `id_message` bigint unsigned NOT NULL,
  `id_user` int unsigned NOT NULL,
  `emoji` varchar(32) COLLATE utf8mb4_bin NOT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id_message`,`id_user`,`emoji`),
  KEY `idx_message` (`id_message`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `prefix_chat_records` (
  `id_message` bigint unsigned NOT NULL,
  `ref_type` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'order | lead | client | deal',
  `id_ref` int unsigned NOT NULL,
  PRIMARY KEY (`id_message`,`ref_type`,`id_ref`),
  KEY `idx_ref` (`ref_type`,`id_ref`,`id_message`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_reminders` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_user` int unsigned NOT NULL,
  `id_message` bigint unsigned NOT NULL,
  `remind_at` datetime NOT NULL COMMENT 'UTC',
  `note` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `if_no_reply` tinyint(1) NOT NULL DEFAULT '0',
  `done` tinyint(1) NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_due` (`done`,`remind_at`),
  KEY `idx_user` (`id_user`,`done`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_rooms` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` char(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT (lower(hex(random_bytes(8)))),
  `type` enum('direct','group','channel','notes') COLLATE utf8mb4_unicode_ci NOT NULL,
  `kind` enum('manual','office','department','announcements') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual',
  `id_ref` int unsigned DEFAULT NULL,
  `direct_key` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `description` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `visibility` enum('public','private') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'private' COMMENT 'public — канал видно всім і можна приєднатись самому',
  `post_policy` enum('all','admins') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'all',
  `color` char(7) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_owner` int unsigned DEFAULT NULL,
  `last_message_id` bigint unsigned DEFAULT NULL,
  `last_message_at` datetime(3) DEFAULT NULL,
  `archived` tinyint(1) NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`),
  UNIQUE KEY `uq_direct` (`direct_key`),
  UNIQUE KEY `uq_auto` (`kind`,`id_ref`),
  KEY `idx_public` (`type`,`visibility`,`archived`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_scheduled` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_room` int unsigned NOT NULL,
  `id_user` int unsigned NOT NULL,
  `body` text COLLATE utf8mb4_unicode_ci,
  `files` json DEFAULT NULL,
  `records` json DEFAULT NULL,
  `id_reply` bigint unsigned DEFAULT NULL,
  `id_thread` bigint unsigned DEFAULT NULL,
  `urgent` tinyint(1) NOT NULL DEFAULT '0',
  `send_at` datetime NOT NULL COMMENT 'UTC',
  `status` enum('wait','sent','failed','cancelled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'wait',
  `id_message` bigint unsigned DEFAULT NULL,
  `error` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_due` (`status`,`send_at`),
  KEY `idx_user` (`id_user`,`status`),
  KEY `fk_chat_scheduled_room` (`id_room`),
  CONSTRAINT `fk_chat_scheduled_room` FOREIGN KEY (`id_room`) REFERENCES `prefix_chat_rooms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_subscriptions` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_room` int unsigned NOT NULL,
  `source` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `events` json NOT NULL,
  `id_user` int unsigned DEFAULT NULL COMMENT 'хто налаштував',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_room_source` (`id_room`,`source`),
  KEY `idx_source` (`source`),
  CONSTRAINT `fk_chat_subscriptions_room` FOREIGN KEY (`id_room`) REFERENCES `prefix_chat_rooms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_threads` (
  `id_thread` bigint unsigned NOT NULL,
  `id_user` int unsigned NOT NULL,
  `last_read_id` bigint unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id_thread`,`id_user`),
  KEY `idx_user` (`id_user`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_urgent` (
  `id_message` bigint unsigned NOT NULL,
  `id_user` int unsigned NOT NULL,
  `attempts` tinyint unsigned NOT NULL DEFAULT '0',
  `next_at` datetime NOT NULL COMMENT 'UTC',
  `done` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id_message`,`id_user`),
  KEY `idx_due` (`done`,`next_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_user_status` (
  `id_user` int unsigned NOT NULL,
  `status` enum('available','away','meeting','vacation','dnd') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'available',
  `text` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `until` datetime DEFAULT NULL COMMENT 'після цього часу статус повертається в available',
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id_user`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_chat_votes` (
  `id_message` bigint unsigned NOT NULL,
  `id_option` bigint unsigned NOT NULL,
  `id_user` int unsigned NOT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id_option`,`id_user`),
  KEY `idx_message_user` (`id_message`,`id_user`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `kind` enum('person','organization','group') COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_legal_type` int unsigned DEFAULT NULL,
  `display_name` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Готове імʼя для списків/пошуку (підтримує код)',
  `status` enum('active','blocked','archived') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `id_lifecycle` int unsigned DEFAULT NULL,
  `id_manager` int unsigned DEFAULT NULL COMMENT 'Відповідальний (users.id)',
  `source` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual' COMMENT 'order / lead / chat / import / manual / api',
  `source_ref` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Уточнення джерела (id замовлення, діалогу...)',
  `id_lang` int DEFAULT NULL COMMENT 'Мова спілкування',
  `country` char(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `timezone` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `currency` char(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `score` smallint NOT NULL DEFAULT '0',
  `note` text COLLATE utf8mb4_unicode_ci,
  `id_merged_into` int unsigned DEFAULT NULL COMMENT 'Злитий у цей запис (не NULL = запис-архів)',
  `date_first_contact` datetime DEFAULT NULL,
  `date_last_activity` datetime DEFAULT NULL,
  `id_user_add` int unsigned DEFAULT NULL,
  `id_user_edit` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  `deleted_at` datetime DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_kind_status` (`kind`,`status`,`deleted_at`),
  KEY `idx_display_name` (`display_name`(100)),
  KEY `idx_manager` (`id_manager`),
  KEY `idx_lifecycle` (`id_lifecycle`),
  KEY `idx_merged` (`id_merged_into`),
  KEY `idx_last_activity` (`date_last_activity`),
  KEY `fk_cl_legal_type` (`id_legal_type`),
  KEY `idx_country` (`country`),
  KEY `idx_deleted` (`deleted_at`),
  CONSTRAINT `fk_cl_legal_type` FOREIGN KEY (`id_legal_type`) REFERENCES `prefix_clients_legal_types` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cl_lifecycle` FOREIGN KEY (`id_lifecycle`) REFERENCES `prefix_clients_lifecycle_stages` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cl_merged_into` FOREIGN KEY (`id_merged_into`) REFERENCES `prefix_clients` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_address_types` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `icon` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `sort` int NOT NULL DEFAULT '0',
  `is_system` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_address_types_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_address_type` int unsigned NOT NULL,
  `id_lang` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_item_lang` (`id_address_type`,`id_lang`),
  CONSTRAINT `fk_cl_address_types_lang` FOREIGN KEY (`id_address_type`) REFERENCES `prefix_clients_address_types` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_addresses` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_client` int unsigned NOT NULL,
  `id_address_type` int unsigned NOT NULL,
  `recipient_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Якщо отримувач інший',
  `recipient_phone` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `country` char(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `region` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `city` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `street` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `building` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `apartment` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `address_line` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Вільний рядок для країн з іншою структурою адрес',
  `postcode` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `carrier_code` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'novaposhta / ukrposhta / meest / inpost / dhl ...',
  `carrier_city_ref` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `carrier_point_ref` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Відділення / поштомат / пункт видачі',
  `carrier_point_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `lat` decimal(10,7) DEFAULT NULL,
  `lng` decimal(10,7) DEFAULT NULL,
  `comment` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_client_type` (`id_client`,`id_address_type`),
  KEY `idx_city` (`city`(50)),
  KEY `fk_cl_addresses_type` (`id_address_type`),
  CONSTRAINT `fk_cl_addresses_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cl_addresses_type` FOREIGN KEY (`id_address_type`) REFERENCES `prefix_clients_address_types` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_commercial` (
  `id_client` int unsigned NOT NULL,
  `price_group` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `discount_percent` decimal(5,2) NOT NULL DEFAULT '0.00',
  `credit_limit` decimal(15,2) DEFAULT NULL,
  `payment_terms_days` smallint unsigned NOT NULL DEFAULT '0',
  `currency` char(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `default_payment_method` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `vat_payer` tinyint(1) NOT NULL DEFAULT '0',
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id_client`),
  CONSTRAINT `fk_cl_commercial_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_contact_points` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_client` int unsigned NOT NULL,
  `id_contact_type` int unsigned NOT NULL,
  `value` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Як ввели: +38 (068) 000-00-00',
  `value_normalized` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Для пошуку: +380680000000 (E.164), email у нижньому регістрі',
  `country` char(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Країна номера (для телефонів)',
  `is_valid` tinyint(1) NOT NULL DEFAULT '1' COMMENT '0 = не пройшов перевірку формату',
  `label` enum('personal','work','other') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'personal',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0',
  `is_verified` tinyint(1) NOT NULL DEFAULT '0',
  `marketing_consent` tinyint(1) NOT NULL DEFAULT '0',
  `consent_date` datetime DEFAULT NULL,
  `source` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_client_value` (`id_client`,`id_contact_type`,`value_normalized`),
  KEY `idx_lookup` (`id_contact_type`,`value_normalized`),
  CONSTRAINT `fk_cl_contact_points_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cl_contact_points_type` FOREIGN KEY (`id_contact_type`) REFERENCES `prefix_clients_contact_types` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_contact_types` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `normalize` enum('phone','email','lower','none') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'none' COMMENT 'Як нормалізувати для пошуку дублів',
  `url_template` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Напр. https://t.me/{value}',
  `color_text` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `color_background` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#6c757d',
  `icon` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `use_for_dedup` tinyint(1) NOT NULL DEFAULT '1',
  `sort` int NOT NULL DEFAULT '0',
  `is_system` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_contact_types_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_contact_type` int unsigned NOT NULL,
  `id_lang` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_item_lang` (`id_contact_type`,`id_lang`),
  CONSTRAINT `fk_cl_contact_types_lang` FOREIGN KEY (`id_contact_type`) REFERENCES `prefix_clients_contact_types` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_duplicate_candidates` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_client_a` int unsigned NOT NULL COMMENT 'Завжди менший id',
  `id_client_b` int unsigned NOT NULL COMMENT 'Завжди більший id',
  `score` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '0..100 впевненість',
  `reasons` json DEFAULT NULL COMMENT '["same_phone","same_edrpou","similar_name"]',
  `status` enum('pending','merged','dismissed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `id_user_resolved` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_resolved` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pair` (`id_client_a`,`id_client_b`),
  KEY `idx_status_score` (`status`,`score`),
  KEY `fk_cl_dup_b` (`id_client_b`),
  CONSTRAINT `fk_cl_dup_a` FOREIGN KEY (`id_client_a`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cl_dup_b` FOREIGN KEY (`id_client_b`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_external_ids` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_client` int unsigned NOT NULL,
  `system` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'opencart / telegram / instagram / webchat / 1c ...',
  `id_integration` int NOT NULL DEFAULT '0' COMMENT 'orders_integrations.id; 0 = без інтеграції (telegram, webchat...)',
  `external_id` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_external` (`system`,`id_integration`,`external_id`),
  KEY `idx_client` (`id_client`),
  CONSTRAINT `fk_cl_external_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_field_defs` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `field_type` enum('text','textarea','number','date','boolean','select','multiselect','url','email','phone') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'text',
  `applies_kind` enum('all','person','organization','group') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'all',
  `is_required` tinyint(1) NOT NULL DEFAULT '0',
  `sort` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_field_defs_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_field` int unsigned NOT NULL,
  `id_lang` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `placeholder` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_item_lang` (`id_field`,`id_lang`),
  CONSTRAINT `fk_cl_field_defs_lang` FOREIGN KEY (`id_field`) REFERENCES `prefix_clients_field_defs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_field_options` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_field` int unsigned NOT NULL,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `color_text` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `color_background` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#6c757d',
  `sort` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_field_code` (`id_field`,`code`),
  CONSTRAINT `fk_cl_field_options_field` FOREIGN KEY (`id_field`) REFERENCES `prefix_clients_field_defs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_field_options_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_option` int unsigned NOT NULL,
  `id_lang` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_item_lang` (`id_option`,`id_lang`),
  CONSTRAINT `fk_cl_field_options_lang` FOREIGN KEY (`id_option`) REFERENCES `prefix_clients_field_options` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_field_values` (
  `id_client` int unsigned NOT NULL,
  `id_field` int unsigned NOT NULL,
  `value_text` text COLLATE utf8mb4_unicode_ci,
  `value_number` decimal(20,6) DEFAULT NULL,
  `value_date` date DEFAULT NULL,
  `id_option` int unsigned DEFAULT NULL COMMENT 'Для select',
  `value_json` json DEFAULT NULL COMMENT 'Для multiselect: масив id опцій',
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id_client`,`id_field`),
  KEY `idx_field_option` (`id_field`,`id_option`),
  KEY `idx_field_number` (`id_field`,`value_number`),
  KEY `idx_field_date` (`id_field`,`value_date`),
  KEY `fk_cl_field_values_option` (`id_option`),
  CONSTRAINT `fk_cl_field_values_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cl_field_values_field` FOREIGN KEY (`id_field`) REFERENCES `prefix_clients_field_defs` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cl_field_values_option` FOREIGN KEY (`id_option`) REFERENCES `prefix_clients_field_options` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_history` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_client` int unsigned NOT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `user_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `source` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual',
  `source_ref` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `action` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `entity` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_entity` bigint unsigned DEFAULT NULL,
  `field` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `value_old` text COLLATE utf8mb4_unicode_ci,
  `value_new` text COLLATE utf8mb4_unicode_ci,
  `batch` char(12) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ip` varbinary(16) DEFAULT NULL,
  `date_add` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_client` (`id_client`,`id`),
  KEY `idx_client_field` (`id_client`,`field`,`date_add`),
  KEY `idx_source` (`source`,`source_ref`),
  KEY `idx_batch` (`batch`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_identifier_types` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `applies_kind` enum('all','person','organization','group') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'all',
  `country` char(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'NULL = для всіх країн',
  `validation_regex` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_unique` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = однаковий номер означає того самого клієнта (дедуплікація)',
  `sort` int NOT NULL DEFAULT '0',
  `is_system` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`),
  KEY `idx_country` (`country`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_identifier_types_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_identifier_type` int unsigned NOT NULL,
  `id_lang` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_item_lang` (`id_identifier_type`,`id_lang`),
  CONSTRAINT `fk_cl_identifier_types_lang` FOREIGN KEY (`id_identifier_type`) REFERENCES `prefix_clients_identifier_types` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_identifiers` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_client` int unsigned NOT NULL,
  `id_identifier_type` int unsigned NOT NULL,
  `value` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `value_normalized` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Без пробілів/дефісів, верхній регістр',
  `country` char(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_verified` tinyint(1) NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_client` (`id_client`),
  KEY `idx_lookup` (`id_identifier_type`,`value_normalized`),
  CONSTRAINT `fk_cl_identifiers_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cl_identifiers_type` FOREIGN KEY (`id_identifier_type`) REFERENCES `prefix_clients_identifier_types` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_imports` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_user` int unsigned NOT NULL,
  `file_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `file_path` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` enum('uploaded','running','done','failed','canceled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'uploaded',
  `headers` json DEFAULT NULL,
  `mapping` json DEFAULT NULL,
  `options` json DEFAULT NULL,
  `total` int unsigned NOT NULL DEFAULT '0',
  `processed` int unsigned NOT NULL DEFAULT '0',
  `created` int unsigned NOT NULL DEFAULT '0',
  `matched` int unsigned NOT NULL DEFAULT '0',
  `skipped` int unsigned NOT NULL DEFAULT '0',
  `errors` json DEFAULT NULL,
  `error` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  `date_start` datetime DEFAULT NULL,
  `date_end` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user` (`id_user`,`id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_legal_types` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `kind` enum('person','organization','group') COLLATE utf8mb4_unicode_ci NOT NULL,
  `country` char(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'NULL = для всіх країн',
  `code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `color_text` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `color_background` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#6c757d',
  `icon` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `required_identifiers` json DEFAULT NULL COMMENT 'Коди обовʼязкових ідентифікаторів, напр. ["edrpou"]',
  `sort` int NOT NULL DEFAULT '0',
  `is_system` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Системний — не видаляється',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`),
  KEY `idx_kind` (`kind`,`active`,`sort`),
  KEY `idx_country` (`country`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_legal_types_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_legal_type` int unsigned NOT NULL,
  `id_lang` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `short_name` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_item_lang` (`id_legal_type`,`id_lang`),
  CONSTRAINT `fk_cl_legal_types_lang` FOREIGN KEY (`id_legal_type`) REFERENCES `prefix_clients_legal_types` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_lifecycle_stages` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `is_customer` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = вже купував',
  `color_text` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `color_background` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#6c757d',
  `icon` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `sort` int NOT NULL DEFAULT '0',
  `is_system` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_lifecycle_stages_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_stage` int unsigned NOT NULL,
  `id_lang` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_item_lang` (`id_stage`,`id_lang`),
  CONSTRAINT `fk_cl_lifecycle_stages_lang` FOREIGN KEY (`id_stage`) REFERENCES `prefix_clients_lifecycle_stages` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_merges` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_client_winner` int unsigned NOT NULL COMMENT 'Лишився',
  `id_client_loser` int unsigned NOT NULL COMMENT 'Злитий (запис лишається з id_merged_into)',
  `snapshot` json NOT NULL COMMENT 'Повний знімок злитого запису + що куди перенесено',
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `reverted_at` datetime DEFAULT NULL,
  `id_user_reverted` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_winner` (`id_client_winner`),
  KEY `idx_loser` (`id_client_loser`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_notes` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_client` int unsigned NOT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `body` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `mentions` json DEFAULT NULL COMMENT 'id згаданих користувачів',
  `is_pinned` tinyint(1) NOT NULL DEFAULT '0',
  `date_pinned` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  `deleted_at` datetime DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_client_feed` (`id_client`,`deleted_at`,`is_pinned`,`id`),
  CONSTRAINT `fk_clients_notes_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_organizations` (
  `id_client` int unsigned NOT NULL,
  `legal_name` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `short_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `industry` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `employees_count` int unsigned DEFAULT NULL,
  `annual_revenue` decimal(15,2) DEFAULT NULL,
  `website` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `registration_date` date DEFAULT NULL,
  `country` char(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id_client`),
  KEY `idx_legal_name` (`legal_name`(100)),
  CONSTRAINT `fk_cl_orgs_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_persons` (
  `id_client` int unsigned NOT NULL,
  `last_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `first_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `middle_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `gender` enum('unknown','male','female','other') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'unknown',
  `birth_date` date DEFAULT NULL,
  `job_title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `trade_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Для ФОП: торгова назва',
  PRIMARY KEY (`id_client`),
  KEY `idx_names` (`last_name`(50),`first_name`(50)),
  KEY `idx_birth` (`birth_date`),
  CONSTRAINT `fk_cl_persons_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_relationship_types` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `from_kind` enum('all','person','organization','group') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'all',
  `to_kind` enum('all','person','organization','group') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'all',
  `is_symmetric` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = однаковий в обидва боки (родич)',
  `color_text` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `color_background` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#6c757d',
  `icon` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `sort` int NOT NULL DEFAULT '0',
  `is_system` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_relationship_types_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_relationship_type` int unsigned NOT NULL,
  `id_lang` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Читається від from: «Працює в»',
  `reverse_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Читається від to: «Працівник»',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_item_lang` (`id_relationship_type`,`id_lang`),
  CONSTRAINT `fk_cl_relationship_types_lang` FOREIGN KEY (`id_relationship_type`) REFERENCES `prefix_clients_relationship_types` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_relationships` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_client_from` int unsigned NOT NULL,
  `id_client_to` int unsigned NOT NULL,
  `id_relationship_type` int unsigned NOT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Посада/уточнення: «Комерційний директор»',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Головна контактна особа',
  `valid_from` date DEFAULT NULL,
  `valid_to` date DEFAULT NULL COMMENT 'NULL = діє зараз',
  `note` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_from` (`id_client_from`,`valid_to`),
  KEY `idx_to` (`id_client_to`,`valid_to`),
  KEY `fk_cl_rel_type` (`id_relationship_type`),
  CONSTRAINT `fk_cl_rel_from` FOREIGN KEY (`id_client_from`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cl_rel_to` FOREIGN KEY (`id_client_to`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cl_rel_type` FOREIGN KEY (`id_relationship_type`) REFERENCES `prefix_clients_relationship_types` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_role_types` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `color_text` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `color_background` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#6c757d',
  `icon` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `sort` int NOT NULL DEFAULT '0',
  `is_system` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_role_types_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_role_type` int unsigned NOT NULL,
  `id_lang` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_item_lang` (`id_role_type`,`id_lang`),
  CONSTRAINT `fk_cl_role_types_lang` FOREIGN KEY (`id_role_type`) REFERENCES `prefix_clients_role_types` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_roles` (
  `id_client` int unsigned NOT NULL,
  `id_role_type` int unsigned NOT NULL,
  `status` enum('active','inactive') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `since` datetime NOT NULL,
  PRIMARY KEY (`id_client`,`id_role_type`),
  KEY `idx_role` (`id_role_type`,`status`),
  CONSTRAINT `fk_cl_roles_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cl_roles_type` FOREIGN KEY (`id_role_type`) REFERENCES `prefix_clients_role_types` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_stats` (
  `id_client` int unsigned NOT NULL,
  `orders_count` int unsigned NOT NULL DEFAULT '0',
  `orders_valid_count` int unsigned NOT NULL DEFAULT '0' COMMENT 'Замовлення зі статусом count_in_revenue',
  `revenue_base` decimal(15,4) NOT NULL DEFAULT '0.0000' COMMENT 'Виручка в базовій валюті',
  `avg_order_base` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `first_order_at` datetime DEFAULT NULL,
  `last_order_at` datetime DEFAULT NULL,
  `leads_count` int unsigned NOT NULL DEFAULT '0',
  `last_lead_at` datetime DEFAULT NULL,
  `date_recalc` datetime NOT NULL,
  `rfm_r` tinyint unsigned DEFAULT NULL COMMENT 'Давність 1-5 (5 = купив нещодавно)',
  `rfm_f` tinyint unsigned DEFAULT NULL COMMENT 'Частота 1-5',
  `rfm_m` tinyint unsigned DEFAULT NULL COMMENT 'Сума 1-5',
  `rfm_segment` varchar(24) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `rfm_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id_client`),
  KEY `idx_revenue` (`revenue_base`),
  KEY `idx_last_order` (`last_order_at`),
  KEY `idx_rfm_segment` (`rfm_segment`),
  CONSTRAINT `fk_cl_stats_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_tag_links` (
  `id_client` int unsigned NOT NULL,
  `id_tag` int unsigned NOT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id_client`,`id_tag`),
  KEY `idx_tag` (`id_tag`),
  CONSTRAINT `fk_cl_tag_links_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_clients` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cl_tag_links_tag` FOREIGN KEY (`id_tag`) REFERENCES `prefix_clients_tags` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_tags` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `color_text` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `color_background` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#6c757d',
  `icon` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `sort` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_clients_tags_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_tag` int unsigned NOT NULL,
  `id_lang` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_item_lang` (`id_tag`,`id_lang`),
  CONSTRAINT `fk_cl_tags_lang` FOREIGN KEY (`id_tag`) REFERENCES `prefix_clients_tags` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_company_type` int unsigned DEFAULT NULL COMMENT 'FK → companies_type',
  `id_company_status` int unsigned DEFAULT NULL COMMENT 'FK → companies_status',
  `id_industry` int unsigned DEFAULT NULL COMMENT 'FK → companies_industry',
  `id_legal_form` int unsigned DEFAULT NULL COMMENT 'FK → companies_legal_form',
  `id_segment` int unsigned DEFAULT NULL COMMENT 'FK → companies_segment',
  `id_source` int unsigned DEFAULT NULL COMMENT 'FK → companies_source',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users (відповідальний менеджер)',
  `id_team` int unsigned DEFAULT NULL COMMENT 'FK → teams',
  `name` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Назва компанії (робоча)',
  `name_full` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Повна юридична назва',
  `name_short` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Коротка назва / бренд',
  `edrpou` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ЄДРПОУ (8 цифр)',
  `ipn` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ІПН / ПДВ номер',
  `vat_number` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Номер платника ПДВ',
  `registration_number` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Реєстраційний номер (для нерезидентів)',
  `registration_date` date DEFAULT NULL COMMENT 'Дата державної реєстрації',
  `country_registration` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Країна реєстрації',
  `address_legal` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Юридична адреса',
  `address_actual` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Фактична адреса',
  `address_post` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Поштова адреса',
  `city` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Місто',
  `region` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Область / регіон',
  `country` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Країна',
  `zip` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Поштовий індекс',
  `website` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Сайт',
  `email_main` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Головний email компанії',
  `phone_main` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Головний телефон',
  `employees_count` tinyint unsigned DEFAULT NULL COMMENT '1=до 10, 2=10-50, 3=50-250, 4=250+',
  `annual_revenue` decimal(18,2) DEFAULT NULL COMMENT 'Річний оборот',
  `annual_revenue_currency` char(3) COLLATE utf8mb4_unicode_ci DEFAULT 'UAH' COMMENT 'Валюта обороту',
  `founded_year` year DEFAULT NULL COMMENT 'Рік заснування',
  `logo` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Шлях до логотипу',
  `description` text COLLATE utf8mb4_unicode_ci COMMENT 'Загальний опис / нотатки',
  `notes` text COLLATE utf8mb4_unicode_ci COMMENT 'Внутрішні нотатки менеджера',
  `date_first_contact` date DEFAULT NULL COMMENT 'Дата першого контакту',
  `date_last_activity` datetime DEFAULT NULL COMMENT 'Дата останньої активності (авто)',
  `active` tinyint(1) NOT NULL DEFAULT '1' COMMENT '1=активна, 0=видалена',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL COMMENT 'Дата створення запису',
  `date_edit` datetime NOT NULL COMMENT 'Дата останнього редагування',
  PRIMARY KEY (`id`),
  KEY `idx_type` (`id_company_type`),
  KEY `idx_status` (`id_company_status`),
  KEY `idx_industry` (`id_industry`),
  KEY `idx_segment` (`id_segment`),
  KEY `idx_user` (`id_user`),
  KEY `idx_country` (`country`),
  KEY `idx_edrpou` (`edrpou`),
  KEY `idx_active` (`active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Головна таблиця компаній CRM';

CREATE TABLE IF NOT EXISTS `prefix_companies_bank` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `name` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Назва банку',
  `name_short` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Коротка назва: ПриватБанк, Mono...',
  `mfo` varchar(10) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'МФО банку (6 цифр, UA)',
  `swift` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'SWIFT / BIC код',
  `country` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Країна банку',
  `city` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Місто головного офісу',
  `address` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Адреса банку',
  `phone` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Телефон банку',
  `website` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Сайт банку',
  `logo` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Логотип банку',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_mfo` (`mfo`),
  KEY `idx_swift` (`swift`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Довідник банків';

CREATE TABLE IF NOT EXISTS `prefix_companies_bank_account_type` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Типи банківських рахунків';

CREATE TABLE IF NOT EXISTS `prefix_companies_bank_account_type_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_bank_account_type` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_bank_account_type_lang` (`id_bank_account_type`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies_bank_accounts` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_company` int unsigned NOT NULL COMMENT 'FK → companies',
  `id_bank` int unsigned DEFAULT NULL COMMENT 'FK → companies_bank (довідник)',
  `id_bank_account_type` int unsigned DEFAULT NULL COMMENT 'FK → companies_bank_account_type',
  `iban` varchar(34) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'IBAN (UA + 27 цифр)',
  `account_number` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Номер рахунку (старий формат або для не-UA)',
  `currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UAH' COMMENT 'Валюта рахунку: UAH, USD, EUR...',
  `bank_name` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Назва банку вручну (якщо немає в довіднику)',
  `bank_mfo` varchar(10) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'МФО вручну',
  `bank_swift` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'SWIFT вручну',
  `bank_address` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Адреса банку вручну',
  `bank_correspondent` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Банк-кореспондент (для міжнародних платежів)',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = основний рахунок',
  `note` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Примітка (напр. "тільки для USD платежів")',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_company` (`id_company`),
  KEY `idx_bank` (`id_bank`),
  KEY `idx_iban` (`iban`),
  KEY `idx_currency` (`currency`),
  KEY `idx_primary` (`id_company`,`is_primary`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Банківські рахунки компаній';

CREATE TABLE IF NOT EXISTS `prefix_companies_custom_field` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_custom_field_group` int unsigned DEFAULT NULL COMMENT 'FK → companies_custom_field_group',
  `field_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'text|textarea|number|decimal|date|datetime|checkbox|select|multiselect|url|email|phone|file',
  `field_key` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Системний ключ поля (латиниця, унікальний): license_number, next_audit_date',
  `is_required` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = обов''язкове поле',
  `is_unique` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = значення унікальне серед всіх компаній',
  `min_length` int unsigned DEFAULT NULL COMMENT 'Мінімальна довжина (для text/textarea)',
  `max_length` int unsigned DEFAULT NULL COMMENT 'Максимальна довжина (для text/textarea)',
  `min_value` decimal(18,4) DEFAULT NULL COMMENT 'Мінімальне значення (для number/decimal)',
  `max_value` decimal(18,4) DEFAULT NULL COMMENT 'Максимальне значення (для number/decimal)',
  `regex` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Regexp для валідації (опційно)',
  `default_value` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Значення за замовчуванням',
  `show_in_list` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = показувати колонку в списку компаній',
  `show_in_card` tinyint(1) NOT NULL DEFAULT '1' COMMENT '1 = показувати в картці компанії',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_field_key` (`field_key`),
  KEY `idx_group` (`id_custom_field_group`),
  KEY `idx_field_type` (`field_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Опис кастомних полів компаній';

CREATE TABLE IF NOT EXISTS `prefix_companies_custom_field_group` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Групи кастомних полів (для відображення в картці)';

CREATE TABLE IF NOT EXISTS `prefix_companies_custom_field_group_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_custom_field_group` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Назва групи',
  `description` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Опис групи',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cfg_lang` (`id_custom_field_group`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies_custom_field_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_custom_field` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `label` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Підпис поля в інтерфейсі',
  `placeholder` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Placeholder в інпуті',
  `hint` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Підказка під полем',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cf_lang` (`id_custom_field`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies_custom_field_option` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_custom_field` int unsigned NOT NULL COMMENT 'FK → companies_custom_field',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_field` (`id_custom_field`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Варіанти вибору для кастомних полів типу select/multiselect';

CREATE TABLE IF NOT EXISTS `prefix_companies_custom_field_option_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_custom_field_option` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Назва варіанту',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cfo_lang` (`id_custom_field_option`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies_custom_field_value` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_company` int unsigned NOT NULL COMMENT 'FK → companies',
  `id_custom_field` int unsigned NOT NULL COMMENT 'FK → companies_custom_field',
  `value_text` text COLLATE utf8mb4_unicode_ci COMMENT 'Значення для text/textarea/url/email/phone/file/multiselect',
  `value_int` int DEFAULT NULL COMMENT 'Значення для number/checkbox/select',
  `value_decimal` decimal(18,4) DEFAULT NULL COMMENT 'Значення для decimal',
  `value_date` date DEFAULT NULL COMMENT 'Значення для date',
  `value_datetime` datetime DEFAULT NULL COMMENT 'Значення для datetime',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_company_field` (`id_company`,`id_custom_field`),
  KEY `idx_company` (`id_company`),
  KEY `idx_custom_field` (`id_custom_field`),
  KEY `idx_value_int` (`value_int`),
  KEY `idx_value_date` (`value_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Значення кастомних полів для компаній (EAV)';

CREATE TABLE IF NOT EXISTS `prefix_companies_email_type` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Типи email-ів компанії';

CREATE TABLE IF NOT EXISTS `prefix_companies_email_type_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_email_type` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_email_type_lang` (`id_email_type`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies_emails` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_company` int unsigned NOT NULL COMMENT 'FK → companies',
  `id_email_type` int unsigned DEFAULT NULL COMMENT 'FK → companies_email_type',
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Email адреса',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = головний (показується в списку)',
  `subscribed` tinyint(1) NOT NULL DEFAULT '1' COMMENT '1 = підписаний на розсилку',
  `bounced` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = email не доставляється (bounce)',
  `note` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Примітка',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_company` (`id_company`),
  KEY `idx_email` (`email`),
  KEY `idx_primary` (`id_company`,`is_primary`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Email-и компаній (один до багатьох)';

CREATE TABLE IF NOT EXISTS `prefix_companies_industry` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'КВЕД або власний код',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Галузі: торгівля, виробництво, IT, логістика...';

CREATE TABLE IF NOT EXISTS `prefix_companies_industry_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_industry` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_industry_lang` (`id_industry`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies_legal_form` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ТОВ, ФОП, ПАТ...',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Орг.-правові форми: ТОВ, ФОП, ПАТ, ДП...';

CREATE TABLE IF NOT EXISTS `prefix_companies_legal_form_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_legal_form` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_legal_form_lang` (`id_legal_form`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies_phone_type` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Типи телефонів компанії';

CREATE TABLE IF NOT EXISTS `prefix_companies_phone_type_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_phone_type` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_phone_type_lang` (`id_phone_type`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies_phones` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_company` int unsigned NOT NULL COMMENT 'FK → companies',
  `id_phone_type` int unsigned DEFAULT NULL COMMENT 'FK → companies_phone_type',
  `phone` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Номер телефону',
  `phone_clean` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Номер без символів для пошуку (тільки цифри)',
  `country_code` varchar(5) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Код країни: +380, +1...',
  `extension` varchar(10) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Внутрішній номер (доб.)',
  `viber` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Є Viber на цьому номері',
  `whatsapp` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Є WhatsApp на цьому номері',
  `telegram` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Є Telegram на цьому номері',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = головний (показується в списку)',
  `note` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Примітка до номера',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_company` (`id_company`),
  KEY `idx_phone` (`phone_clean`),
  KEY `idx_primary` (`id_company`,`is_primary`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Телефони компаній (один до багатьох)';

CREATE TABLE IF NOT EXISTS `prefix_companies_segment` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `color_background` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#000000',
  `color_text` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Сегменти клієнтів: A, B, C або VIP, Standard...';

CREATE TABLE IF NOT EXISTS `prefix_companies_segment_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_segment` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_segment_lang` (`id_segment`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies_social_type` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Системна назва: linkedin, facebook, telegram...',
  `icon` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'CSS клас іконки або шлях до SVG',
  `color` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#000000' COMMENT 'Фірмовий колір мережі',
  `url_pattern` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Шаблон URL: https://t.me/{handle}',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Типи соцмереж і месенджерів з іконками та кольорами';

CREATE TABLE IF NOT EXISTS `prefix_companies_social_type_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_social_type` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_social_type_lang` (`id_social_type`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies_socials` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_company` int unsigned NOT NULL COMMENT 'FK → companies',
  `id_social_type` int unsigned NOT NULL COMMENT 'FK → companies_social_type',
  `handle` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Username / нікнейм (@company)',
  `url` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Повний URL сторінки',
  `phone` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Номер для Viber/WhatsApp (якщо застосовно)',
  `followers` int unsigned DEFAULT NULL COMMENT 'Кількість підписників (опційно)',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = основний акаунт цього типу',
  `note` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Примітка',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_company` (`id_company`),
  KEY `idx_social_type` (`id_social_type`),
  KEY `idx_handle` (`handle`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Соціальні мережі та месенджери компаній';

CREATE TABLE IF NOT EXISTS `prefix_companies_source` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Джерела: сайт, виставка, холодний дзвінок, реферал...';

CREATE TABLE IF NOT EXISTS `prefix_companies_source_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_source` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_source_lang` (`id_source`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies_status` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `color_background` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#000000',
  `color_text` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Статуси: активна, потенційна, неактивна, заблокована';

CREATE TABLE IF NOT EXISTS `prefix_companies_status_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_company_status` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_status_lang` (`id_company_status`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies_tag` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_tag_category` int unsigned DEFAULT NULL COMMENT 'FK → companies_tag_category (опційно)',
  `color_background` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#e9ecef' COMMENT 'Колір фону бейджа',
  `color_text` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#212529' COMMENT 'Колір тексту бейджа',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_category` (`id_tag_category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Довідник тегів для компаній';

CREATE TABLE IF NOT EXISTS `prefix_companies_tag_category` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `color` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#6c757d' COMMENT 'Колір категорії',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Категорії тегів для групування';

CREATE TABLE IF NOT EXISTS `prefix_companies_tag_category_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_tag_category` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tag_category_lang` (`id_tag_category`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies_tag_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_tag` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Назва тегу',
  `description` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Опис тегу (підказка при наведенні)',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tag_lang` (`id_tag`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies_tags_map` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_company` int unsigned NOT NULL COMMENT 'FK → companies',
  `id_tag` int unsigned NOT NULL COMMENT 'FK → companies_tag',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users (хто поставив тег)',
  `date_add` datetime NOT NULL COMMENT 'Коли поставлено тег',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_company_tag` (`id_company`,`id_tag`),
  KEY `idx_company` (`id_company`),
  KEY `idx_tag` (`id_tag`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Прив''язка тегів до компаній (many-to-many)';

CREATE TABLE IF NOT EXISTS `prefix_companies_type` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Типи компаній: клієнт, постачальник, партнер...';

CREATE TABLE IF NOT EXISTS `prefix_companies_type_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_company_type` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_type_lang` (`id_company_type`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_companies_websites` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_company` int unsigned NOT NULL COMMENT 'FK → companies',
  `url` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'URL сайту',
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Назва / підпис (Основний сайт, Лендінг...)',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = головний сайт',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_company` (`id_company`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Сайти та URL компаній';

CREATE TABLE IF NOT EXISTS `prefix_company_departments` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_parent` int unsigned DEFAULT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `code` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `description` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_head` int unsigned DEFAULT NULL COMMENT 'керівник — користувач',
  `status` tinyint(1) NOT NULL DEFAULT '1' COMMENT '1 — активний, 0 — в архіві',
  `sort_order` int NOT NULL DEFAULT '0',
  `id_user_add` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`),
  KEY `idx_parent` (`id_parent`,`sort_order`),
  KEY `idx_head` (`id_head`),
  CONSTRAINT `fk_company_departments_parent` FOREIGN KEY (`id_parent`) REFERENCES `prefix_company_departments` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_company_departments_offices` (
  `id_department` int unsigned NOT NULL,
  `id_office` int unsigned NOT NULL,
  PRIMARY KEY (`id_department`,`id_office`),
  KEY `idx_office` (`id_office`),
  CONSTRAINT `fk_company_do_department` FOREIGN KEY (`id_department`) REFERENCES `prefix_company_departments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_company_do_office` FOREIGN KEY (`id_office`) REFERENCES `prefix_company_offices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_company_offices` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `code` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `country` char(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ISO 3166-1 alpha-2',
  `city` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `address` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `postcode` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'E.164',
  `email` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `timezone` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'IANA, напр. Europe/Kyiv, Asia/Kolkata, America/New_York',
  `work_hours` json NOT NULL COMMENT '{"1":[["09:00","18:00"]], … "7":[]} — 1 = понеділок, до 3 проміжків на день',
  `status` tinyint(1) NOT NULL DEFAULT '1' COMMENT '1 — активний, 0 — в архіві',
  `sort_order` int NOT NULL DEFAULT '0',
  `id_user_add` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`),
  KEY `idx_status` (`status`,`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_company_offices_holidays` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_office` int unsigned NOT NULL,
  `date` date NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `recurring` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_office_date` (`id_office`,`date`),
  CONSTRAINT `fk_company_holidays_office` FOREIGN KEY (`id_office`) REFERENCES `prefix_company_offices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contact_center_attachments` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_message` bigint unsigned NOT NULL,
  `id_conversation` bigint unsigned NOT NULL,
  `id_channel` int unsigned NOT NULL,
  `type` enum('image','video','audio','file','sticker') COLLATE utf8mb4_unicode_ci NOT NULL,
  `subtype` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sort_order` tinyint unsigned NOT NULL DEFAULT '0',
  `path` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `thumb_path` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `file_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `mime` varchar(127) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `size` bigint unsigned DEFAULT NULL,
  `sha256` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `width` smallint unsigned DEFAULT NULL,
  `height` smallint unsigned DEFAULT NULL,
  `duration` int unsigned DEFAULT NULL,
  `waveform` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `source_type` enum('none','url','telegram_file_id') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'none',
  `source_ref` text COLLATE utf8mb4_unicode_ci,
  `source_expires` datetime DEFAULT NULL,
  `status` enum('pending','processing','done','failed','skipped') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `attempts` tinyint unsigned NOT NULL DEFAULT '0',
  `error` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_next_try` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_message` (`id_message`,`sort_order`),
  KEY `idx_conv_type` (`id_conversation`,`type`,`id`),
  KEY `idx_queue` (`status`,`date_next_try`,`id`),
  KEY `idx_sha256` (`sha256`),
  KEY `fk_cc_att_channel` (`id_channel`),
  CONSTRAINT `fk_cc_att_channel` FOREIGN KEY (`id_channel`) REFERENCES `prefix_contact_center_channels` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_cc_att_conv` FOREIGN KEY (`id_conversation`) REFERENCES `prefix_contact_center_conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_cc_att_msg` FOREIGN KEY (`id_message`) REFERENCES `prefix_contact_center_messages` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contact_center_channel_facebook` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_channel` int unsigned NOT NULL,
  `page_id` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `page_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `page_picture` text COLLATE utf8mb4_unicode_ci,
  `app_id` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `verify_token` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `token_cipher` blob,
  `token_iv` varbinary(32) DEFAULT NULL,
  `token_tag` varbinary(32) DEFAULT NULL,
  `app_secret_cipher` blob,
  `app_secret_iv` varbinary(32) DEFAULT NULL,
  `app_secret_tag` varbinary(32) DEFAULT NULL,
  `connection_error` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_connected` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_channel` (`id_channel`),
  KEY `idx_page` (`page_id`),
  KEY `idx_verify` (`verify_token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contact_center_channel_instagram` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_channel` int unsigned NOT NULL,
  `ig_user_id` bigint unsigned DEFAULT NULL,
  `ig_username` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ig_account_type` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ig_profile_picture` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `token_cipher` varbinary(2048) NOT NULL,
  `token_iv` varbinary(16) NOT NULL,
  `token_tag` varbinary(16) NOT NULL,
  `token_type` enum('short_lived','long_lived') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'long_lived',
  `date_token_expires` datetime DEFAULT NULL,
  `date_token_refresh` datetime DEFAULT NULL,
  `app_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `app_secret_cipher` varbinary(512) DEFAULT NULL,
  `app_secret_iv` varbinary(16) DEFAULT NULL,
  `app_secret_tag` varbinary(16) DEFAULT NULL,
  `verify_token` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `date_deleted` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_channel` (`id_channel`),
  UNIQUE KEY `uniq_ig_user` (`ig_user_id`,`date_deleted`),
  KEY `idx_token_expires` (`date_token_expires`),
  CONSTRAINT `fk_cc_ig_channel` FOREIGN KEY (`id_channel`) REFERENCES `prefix_contact_center_channels` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contact_center_channel_notifications` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_channel` int unsigned NOT NULL,
  `push_enabled` tinyint(1) NOT NULL DEFAULT '0',
  `tg_enabled` tinyint(1) NOT NULL DEFAULT '0',
  `tg_bot_token_cipher` varbinary(255) DEFAULT NULL,
  `tg_bot_token_iv` varbinary(64) DEFAULT NULL,
  `tg_bot_token_tag` varbinary(64) DEFAULT NULL,
  `tg_bot_token_last4` varchar(8) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `tg_bot_id` bigint unsigned DEFAULT NULL,
  `tg_bot_username` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `tg_chat_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `tg_use_thread` tinyint(1) NOT NULL DEFAULT '0',
  `tg_thread_id` bigint DEFAULT NULL,
  `date_add` datetime DEFAULT NULL,
  `date_update` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_channel` (`id_channel`),
  CONSTRAINT `fk_cc_notif_channel` FOREIGN KEY (`id_channel`) REFERENCES `prefix_contact_center_channels` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contact_center_channel_telegram` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_channel` int unsigned NOT NULL,
  `bot_id` bigint unsigned DEFAULT NULL,
  `bot_username` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `bot_first_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `token_cipher` varbinary(512) NOT NULL,
  `token_iv` varbinary(16) NOT NULL,
  `token_tag` varbinary(16) NOT NULL,
  `token_last4` char(4) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `webhook_secret` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `webhook_url` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `webhook_set` tinyint unsigned NOT NULL DEFAULT '0',
  `date_webhook_set` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `date_deleted` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_channel` (`id_channel`),
  UNIQUE KEY `uniq_webhook_secret` (`webhook_secret`),
  UNIQUE KEY `uniq_bot_id` (`bot_id`,`date_deleted`),
  CONSTRAINT `fk_cc_tg_channel` FOREIGN KEY (`id_channel`) REFERENCES `prefix_contact_center_channels` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contact_center_channel_webchat` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_channel` int unsigned NOT NULL,
  `site_id` varchar(190) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `allowed_origins` text COLLATE utf8mb4_unicode_ci,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `date_deleted` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_channel` (`id_channel`),
  UNIQUE KEY `uniq_site_id` (`site_id`),
  CONSTRAINT `fk_cc_wc_channel` FOREIGN KEY (`id_channel`) REFERENCES `prefix_contact_center_channels` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contact_center_channels` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `type` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` tinyint unsigned NOT NULL DEFAULT '0',
  `is_configured` tinyint unsigned NOT NULL DEFAULT '0',
  `connection_status` enum('unknown','ok','error') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'unknown',
  `connection_error` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_checked` datetime DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `id_user` int unsigned DEFAULT NULL,
  `id_user_edited` int unsigned DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted` tinyint unsigned NOT NULL DEFAULT '0',
  `date_deleted` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_type_deleted_status` (`type`,`deleted`),
  KEY `idx_deleted_sort` (`deleted`,`sort_order`,`id`),
  KEY `idx_id_user` (`id_user`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contact_center_comments` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_channel` int unsigned NOT NULL,
  `network` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `external_id` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `parent_external_id` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `media_id` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `media_permalink` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `media_caption` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `media_thumb` text COLLATE utf8mb4_unicode_ci,
  `author_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `author_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `author_username` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `text` text COLLATE utf8mb4_unicode_ci,
  `is_own` tinyint(1) NOT NULL DEFAULT '0',
  `status` enum('new','answered','hidden','deleted') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'new',
  `is_hidden` tinyint(1) NOT NULL DEFAULT '0',
  `private_replied` tinyint(1) NOT NULL DEFAULT '0',
  `id_user_action` int unsigned DEFAULT NULL,
  `date_action` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_sync` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_network_external` (`network`,`external_id`),
  KEY `idx_list` (`status`,`date_add`),
  KEY `idx_channel` (`id_channel`,`date_add`),
  KEY `idx_parent` (`parent_external_id`),
  KEY `idx_media` (`media_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contact_center_contacts` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_channel` int unsigned NOT NULL,
  `external_id` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `first_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `username` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `avatar` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `lang` varchar(8) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `timezone` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `blocked` tinyint unsigned NOT NULL DEFAULT '0',
  `attributes` json DEFAULT NULL,
  `id_client` int unsigned DEFAULT NULL COMMENT 'clients.id',
  `date_last_seen` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_channel_external` (`id_channel`,`external_id`),
  KEY `idx_name` (`name`),
  KEY `idx_username` (`username`),
  KEY `idx_phone` (`phone`),
  KEY `idx_email` (`email`),
  KEY `idx_client` (`id_client`),
  CONSTRAINT `fk_cc_contact_channel` FOREIGN KEY (`id_channel`) REFERENCES `prefix_contact_center_channels` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_cc_contacts_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_clients` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contact_center_conversations` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_channel` int unsigned NOT NULL,
  `id_contact` bigint unsigned NOT NULL,
  `status` enum('open','pending','resolved','archived') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'open',
  `id_manager` int unsigned DEFAULT NULL,
  `priority` tinyint unsigned NOT NULL DEFAULT '0',
  `url_token` char(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `source_thread_id` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_last_message` bigint unsigned DEFAULT NULL,
  `last_message_text` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_message_type` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_message_dir` enum('in','out') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_last_message` datetime(3) DEFAULT NULL,
  `date_last_inbound` datetime(3) DEFAULT NULL,
  `date_first_reply` datetime(3) DEFAULT NULL,
  `messages_count` int unsigned NOT NULL DEFAULT '0',
  `date_resolved` datetime DEFAULT NULL,
  `date_archived` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_url_token` (`url_token`),
  UNIQUE KEY `uniq_contact_active` (`id_contact`,`date_resolved`,`date_archived`),
  KEY `idx_status_last` (`status`,`date_last_message`,`id`),
  KEY `idx_manager_status` (`id_manager`,`status`,`date_last_message`),
  KEY `idx_channel_status` (`id_channel`,`status`,`date_last_message`),
  KEY `idx_thread` (`id_channel`,`source_thread_id`),
  CONSTRAINT `fk_cc_conv_channel` FOREIGN KEY (`id_channel`) REFERENCES `prefix_contact_center_channels` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_cc_conv_contact` FOREIGN KEY (`id_contact`) REFERENCES `prefix_contact_center_contacts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contact_center_messages` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_conversation` bigint unsigned NOT NULL,
  `id_channel` int unsigned NOT NULL,
  `direction` enum('in','out') COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_manager` int unsigned DEFAULT NULL,
  `source_id` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `type` enum('text','media','location','contact','sticker','poll','system','event') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'text',
  `subtype` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `text` mediumtext COLLATE utf8mb4_unicode_ci,
  `id_reply_to` bigint unsigned DEFAULT NULL,
  `lat` decimal(10,7) DEFAULT NULL,
  `lng` decimal(10,7) DEFAULT NULL,
  `attributes` json DEFAULT NULL,
  `status` enum('pending','sent','delivered','read','failed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'sent',
  `reaction` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `error` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `has_attachments` tinyint unsigned NOT NULL DEFAULT '0',
  `date_add` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `date_edited` datetime(3) DEFAULT NULL,
  `date_deleted` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_conv_source` (`id_conversation`,`source_id`),
  KEY `idx_conv_id` (`id_conversation`,`id`),
  KEY `idx_conv_date` (`id_conversation`,`date_add`),
  KEY `idx_channel_date` (`id_channel`,`date_add`),
  KEY `idx_reply` (`id_reply_to`),
  KEY `idx_status_pending` (`status`,`date_add`),
  KEY `idx_channel_source` (`id_channel`,`source_id`),
  CONSTRAINT `fk_cc_msg_channel` FOREIGN KEY (`id_channel`) REFERENCES `prefix_contact_center_channels` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_cc_msg_conv` FOREIGN KEY (`id_conversation`) REFERENCES `prefix_contact_center_conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_cc_msg_reply` FOREIGN KEY (`id_reply_to`) REFERENCES `prefix_contact_center_messages` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contact_center_unread` (
  `id_conversation` bigint unsigned NOT NULL,
  `id_manager` int unsigned NOT NULL,
  `count` int unsigned NOT NULL DEFAULT '0',
  `id_last_read_message` bigint unsigned DEFAULT NULL,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id_conversation`,`id_manager`),
  KEY `idx_manager_count` (`id_manager`,`count`),
  CONSTRAINT `fk_cc_unread_conv` FOREIGN KEY (`id_conversation`) REFERENCES `prefix_contact_center_conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contact_label_dict` (
  `id` smallint unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'work, home, personal, wife...',
  `sort` tinyint unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contact_label_dict_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_label` smallint unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_label_lang` (`id_label`,`id_lang`),
  CONSTRAINT `fk_clabel_lang` FOREIGN KEY (`id_label`) REFERENCES `prefix_contact_label_dict` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contacts` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_contact_status` int unsigned DEFAULT NULL COMMENT 'FK → contacts_status',
  `id_source` int unsigned DEFAULT NULL COMMENT 'FK → contacts_source',
  `id_salutation` int unsigned DEFAULT NULL COMMENT 'FK → contacts_salutation',
  `id_segment` int unsigned DEFAULT NULL COMMENT 'FK → contacts_segment',
  `id_company` int unsigned DEFAULT NULL COMMENT 'FK → companies (основна компанія)',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users (відповідальний менеджер)',
  `id_team` int unsigned DEFAULT NULL COMMENT 'FK → teams',
  `last_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Прізвище',
  `first_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Ім''я (обов''язкове)',
  `middle_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'По батькові',
  `full_name` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Повне ім''я (авто або вручну)',
  `position` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Посада',
  `department` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Відділ',
  `gender` tinyint(1) DEFAULT NULL COMMENT '0=чоловік, 1=жінка, NULL=не вказано',
  `birthday` date DEFAULT NULL COMMENT 'Дата народження',
  `language` varchar(10) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Мова спілкування: uk, en, pl...',
  `nationality` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Громадянство',
  `photo` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Шлях до фото',
  `phone_main` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Головний телефон (з contacts_phones)',
  `email_main` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Головний email (з contacts_emails)',
  `address` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Адреса',
  `city` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Місто',
  `region` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Область / регіон',
  `country` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Країна',
  `zip` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Поштовий індекс',
  `description` text COLLATE utf8mb4_unicode_ci COMMENT 'Загальний опис',
  `notes` text COLLATE utf8mb4_unicode_ci COMMENT 'Внутрішні нотатки менеджера',
  `gdpr_consent` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = надав згоду на обробку даних',
  `gdpr_consent_date` datetime DEFAULT NULL COMMENT 'Дата надання згоди',
  `subscribed` tinyint(1) NOT NULL DEFAULT '1' COMMENT '1 = підписаний на розсилку',
  `unsubscribed_date` datetime DEFAULT NULL COMMENT 'Дата відписки',
  `date_first_contact` date DEFAULT NULL COMMENT 'Дата першого контакту',
  `date_last_activity` datetime DEFAULT NULL COMMENT 'Дата останньої активності (авто)',
  `date_birthday_next` date DEFAULT NULL COMMENT 'Наступний день народження (для нагадувань)',
  `active` tinyint(1) NOT NULL DEFAULT '1' COMMENT '1=активний, 0=видалений',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL COMMENT 'Дата створення',
  `date_edit` datetime NOT NULL COMMENT 'Дата редагування',
  PRIMARY KEY (`id`),
  KEY `idx_status` (`id_contact_status`),
  KEY `idx_company` (`id_company`),
  KEY `idx_segment` (`id_segment`),
  KEY `idx_user` (`id_user`),
  KEY `idx_last_name` (`last_name`),
  KEY `idx_email` (`email_main`),
  KEY `idx_phone` (`phone_main`),
  KEY `idx_birthday` (`date_birthday_next`),
  KEY `idx_active` (`active`),
  KEY `idx_last_activity` (`date_last_activity`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Головна таблиця контактів CRM';

CREATE TABLE IF NOT EXISTS `prefix_contacts_address_type` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Типи адрес контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_address_type_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_address_type` int unsigned NOT NULL COMMENT 'FK → contacts_address_type',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_addr_type_lang` (`id_address_type`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contacts_addresses` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_contact` int unsigned NOT NULL COMMENT 'FK → contacts',
  `id_address_type` int unsigned DEFAULT NULL COMMENT 'FK → contacts_address_type',
  `address` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Вулиця, будинок, квартира',
  `city` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Місто',
  `region` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Область / регіон',
  `country` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Країна',
  `zip` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Поштовий індекс',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = основна адреса',
  `note` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_contact` (`id_contact`),
  KEY `idx_city` (`city`),
  KEY `idx_country` (`country`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Адреси контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_audit_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users',
  `user_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Ім''я (знімок на момент дії)',
  `user_ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'IP адреса',
  `entity_type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'contact/phone/email/social/tag/file/note/company_map',
  `id_entity` int unsigned NOT NULL COMMENT 'ID запису',
  `id_contact` int unsigned NOT NULL COMMENT 'FK → contacts (для швидкої вибірки)',
  `action` enum('create','update','delete','restore','view','export','merge','tag_add','tag_remove','company_link','company_unlink') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Тип дії',
  `field_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Яке поле змінилось',
  `value_old` text COLLATE utf8mb4_unicode_ci COMMENT 'Старе значення',
  `value_new` text COLLATE utf8mb4_unicode_ci COMMENT 'Нове значення',
  `description` text COLLATE utf8mb4_unicode_ci COMMENT 'Опис дії (для складних змін)',
  `date_add` datetime NOT NULL COMMENT 'Дата і час дії',
  PRIMARY KEY (`id`),
  KEY `idx_contact` (`id_contact`),
  KEY `idx_entity` (`entity_type`,`id_entity`),
  KEY `idx_user` (`id_user`),
  KEY `idx_action` (`action`),
  KEY `idx_date` (`date_add`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Журнал всіх змін контактів (audit log)';

CREATE TABLE IF NOT EXISTS `prefix_contacts_companies_map` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_contact` int unsigned NOT NULL COMMENT 'FK → contacts',
  `id_company` int unsigned NOT NULL COMMENT 'FK → companies',
  `id_role` int unsigned DEFAULT NULL COMMENT 'FK → contacts_role (роль саме в цій компанії)',
  `position` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Посада в цій компанії',
  `department` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Відділ в цій компанії',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = основна компанія контакта',
  `date_from` date DEFAULT NULL COMMENT 'Дата початку роботи в компанії',
  `date_to` date DEFAULT NULL COMMENT 'Дата закінчення (NULL = працює зараз)',
  `note` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Примітка щодо зв''язку',
  `active` tinyint(1) NOT NULL DEFAULT '1' COMMENT '1 = актуальний зв''язок',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contact_company` (`id_contact`,`id_company`),
  KEY `idx_contact` (`id_contact`),
  KEY `idx_company` (`id_company`),
  KEY `idx_role` (`id_role`),
  KEY `idx_primary` (`id_contact`,`is_primary`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Зв''язок контактів з компаніями (many-to-many)';

CREATE TABLE IF NOT EXISTS `prefix_contacts_custom_field` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_custom_field_group` int unsigned DEFAULT NULL COMMENT 'FK → contacts_custom_field_group',
  `field_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'text|textarea|number|decimal|date|datetime|checkbox|select|multiselect|url|email|phone|file',
  `field_key` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Системний ключ (унікальний, латиниця)',
  `is_required` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = обов''язкове поле',
  `is_unique` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = унікальне серед контактів',
  `min_length` int unsigned DEFAULT NULL COMMENT 'Мін. довжина (text/textarea)',
  `max_length` int unsigned DEFAULT NULL COMMENT 'Макс. довжина (text/textarea)',
  `min_value` decimal(18,4) DEFAULT NULL COMMENT 'Мін. значення (number/decimal)',
  `max_value` decimal(18,4) DEFAULT NULL COMMENT 'Макс. значення (number/decimal)',
  `regex` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Regexp для валідації',
  `default_value` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Значення за замовчуванням',
  `show_in_list` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = показувати колонку в списку',
  `show_in_card` tinyint(1) NOT NULL DEFAULT '1' COMMENT '1 = показувати в картці',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_field_key` (`field_key`),
  KEY `idx_group` (`id_custom_field_group`),
  KEY `idx_field_type` (`field_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Кастомні поля контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_custom_field_group` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Групи кастомних полів контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_custom_field_group_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_custom_field_group` int unsigned NOT NULL COMMENT 'FK → contacts_custom_field_group',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Назва групи',
  `description` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ccfg_lang` (`id_custom_field_group`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contacts_custom_field_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_custom_field` int unsigned NOT NULL COMMENT 'FK → contacts_custom_field',
  `id_lang` smallint unsigned NOT NULL,
  `label` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Підпис поля в інтерфейсі',
  `placeholder` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Placeholder в інпуті',
  `hint` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Підказка під полем',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ccf_lang` (`id_custom_field`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contacts_custom_field_option` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_custom_field` int unsigned NOT NULL COMMENT 'FK → contacts_custom_field',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_field` (`id_custom_field`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Варіанти вибору для кастомних полів контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_custom_field_option_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_custom_field_option` int unsigned NOT NULL COMMENT 'FK → contacts_custom_field_option',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ccfo_lang` (`id_custom_field_option`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contacts_custom_field_value` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_contact` int unsigned NOT NULL COMMENT 'FK → contacts',
  `id_custom_field` int unsigned NOT NULL COMMENT 'FK → contacts_custom_field',
  `value_text` text COLLATE utf8mb4_unicode_ci COMMENT 'text/textarea/url/email/phone/file/multiselect',
  `value_int` int DEFAULT NULL COMMENT 'number/checkbox/select',
  `value_decimal` decimal(18,4) DEFAULT NULL COMMENT 'decimal',
  `value_date` date DEFAULT NULL COMMENT 'date',
  `value_datetime` datetime DEFAULT NULL COMMENT 'datetime',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contact_field` (`id_contact`,`id_custom_field`),
  KEY `idx_contact` (`id_contact`),
  KEY `idx_custom_field` (`id_custom_field`),
  KEY `idx_value_int` (`value_int`),
  KEY `idx_value_date` (`value_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Значення кастомних полів контактів (EAV)';

CREATE TABLE IF NOT EXISTS `prefix_contacts_emails` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_contact` int unsigned NOT NULL COMMENT 'FK → contacts',
  `id_email_type` int unsigned DEFAULT NULL COMMENT 'FK → companies_email_type (спільний довідник)',
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Email адреса',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = головний (показується в списку)',
  `subscribed` tinyint(1) NOT NULL DEFAULT '1' COMMENT '1 = підписаний на розсилку',
  `bounced` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = email не доставляється (bounce)',
  `bounce_reason` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Причина bounce (hard/soft/spam)',
  `verified` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = email підтверджений',
  `note` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Примітка: робочий, особистий...',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_contact` (`id_contact`),
  KEY `idx_email` (`email`),
  KEY `idx_primary` (`id_contact`,`is_primary`),
  KEY `idx_subscribed` (`subscribed`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Email-и контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_file_category` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Категорії файлів контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_file_category_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_category` int unsigned NOT NULL COMMENT 'FK → contacts_file_category',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cfc_lang` (`id_category`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contacts_files` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_contact` int unsigned NOT NULL COMMENT 'FK → contacts',
  `id_category` int unsigned DEFAULT NULL COMMENT 'FK → contacts_file_category',
  `file_path` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Шлях до файлу',
  `file_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Оригінальна назва',
  `file_ext` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Розширення: pdf, docx...',
  `file_size` int unsigned DEFAULT NULL COMMENT 'Розмір в байтах',
  `file_mime` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'MIME тип',
  `file_hash` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'SHA256 для дедуплікації',
  `version` tinyint unsigned NOT NULL DEFAULT '1' COMMENT 'Версія файлу',
  `id_file_parent` int unsigned DEFAULT NULL COMMENT 'FK → contacts_files (попередня версія)',
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Назва / підпис',
  `description` text COLLATE utf8mb4_unicode_ci COMMENT 'Опис',
  `is_public` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = видно контакту (кабінет)',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users (хто завантажив)',
  `download_count` int unsigned NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_contact` (`id_contact`),
  KEY `idx_category` (`id_category`),
  KEY `idx_hash` (`file_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Файли та документи контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_merge_log` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_contact_master` int unsigned NOT NULL COMMENT 'FK → contacts (залишений)',
  `id_contact_merged` int unsigned NOT NULL COMMENT 'FK → contacts (злитий / видалений)',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users (хто злив)',
  `merged_data` json DEFAULT NULL COMMENT 'JSON знімок злитого контакта до видалення',
  `note` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Примітка до злиття',
  `date_add` datetime NOT NULL COMMENT 'Дата злиття',
  PRIMARY KEY (`id`),
  KEY `idx_master` (`id_contact_master`),
  KEY `idx_merged` (`id_contact_merged`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Журнал злиття дублікатів контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_notes` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_contact` int unsigned NOT NULL COMMENT 'FK → contacts',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users (хто додав)',
  `note` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Текст нотатки',
  `is_pinned` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = закріплена нотатка',
  `is_private` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = видно тільки автору',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_contact` (`id_contact`),
  KEY `idx_user` (`id_user`),
  KEY `idx_pinned` (`id_contact`,`is_pinned`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Нотатки контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_phones` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_contact` int unsigned NOT NULL COMMENT 'FK → contacts',
  `id_phone_type` int unsigned DEFAULT NULL COMMENT 'FK → companies_phone_type (спільний довідник)',
  `phone` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Номер телефону',
  `phone_clean` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Тільки цифри для пошуку',
  `country_code` varchar(5) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Код країни: +380, +1...',
  `extension` varchar(10) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Внутрішній номер (доб.)',
  `viber` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = є Viber на цьому номері',
  `whatsapp` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = є WhatsApp',
  `telegram` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = є Telegram',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = головний (показується в списку)',
  `note` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Примітка: робочий, особистий...',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_contact` (`id_contact`),
  KEY `idx_phone` (`phone_clean`),
  KEY `idx_primary` (`id_contact`,`is_primary`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Телефони контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_role` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Ролі контакта в компанії';

CREATE TABLE IF NOT EXISTS `prefix_contacts_role_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_role` int unsigned NOT NULL COMMENT 'FK → contacts_role',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contact_role_lang` (`id_role`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contacts_salutation` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Звернення: Пан, Пані, Др., Проф.';

CREATE TABLE IF NOT EXISTS `prefix_contacts_salutation_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_salutation` int unsigned NOT NULL COMMENT 'FK → contacts_salutation',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_salutation_lang` (`id_salutation`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contacts_segment` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `color_background` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#000000',
  `color_text` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Сегменти контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_segment_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_segment` int unsigned NOT NULL COMMENT 'FK → contacts_segment',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contact_segment_lang` (`id_segment`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contacts_socials` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_contact` int unsigned NOT NULL COMMENT 'FK → contacts',
  `id_social_type` int unsigned NOT NULL COMMENT 'FK → companies_social_type (спільний довідник)',
  `handle` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Username / нікнейм (@name)',
  `url` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Повний URL профілю',
  `phone` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Номер для Viber/WhatsApp',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = основний акаунт цього типу',
  `note` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Примітка',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_contact` (`id_contact`),
  KEY `idx_social_type` (`id_social_type`),
  KEY `idx_handle` (`handle`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Соцмережі та месенджери контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_source` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Джерела контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_source_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_source` int unsigned NOT NULL COMMENT 'FK → contacts_source',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contact_source_lang` (`id_source`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contacts_status` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `color_background` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#000000',
  `color_text` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Статуси контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_status_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_contact_status` int unsigned NOT NULL COMMENT 'FK → contacts_status',
  `id_lang` smallint unsigned NOT NULL COMMENT 'FK → languages',
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contact_status_lang` (`id_contact_status`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contacts_tag` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_tag_category` int unsigned DEFAULT NULL COMMENT 'FK → contacts_tag_category',
  `color_background` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#e9ecef',
  `color_text` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#212529',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_category` (`id_tag_category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Довідник тегів контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_tag_category` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `color` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#6c757d' COMMENT 'Колір категорії',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Категорії тегів контактів';

CREATE TABLE IF NOT EXISTS `prefix_contacts_tag_category_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_tag_category` int unsigned NOT NULL COMMENT 'FK → contacts_tag_category',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ctc_lang` (`id_tag_category`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contacts_tag_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_tag` int unsigned NOT NULL COMMENT 'FK → contacts_tag',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ct_lang` (`id_tag`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_contacts_tags_map` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_contact` int unsigned NOT NULL COMMENT 'FK → contacts',
  `id_tag` int unsigned NOT NULL COMMENT 'FK → contacts_tag',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users (хто поставив тег)',
  `date_add` datetime NOT NULL COMMENT 'Коли поставлено тег',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contact_tag` (`id_contact`,`id_tag`),
  KEY `idx_contact` (`id_contact`),
  KEY `idx_tag` (`id_tag`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Прив''язка тегів до контактів (many-to-many)';

CREATE TABLE IF NOT EXISTS `prefix_contacts_websites` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_contact` int unsigned NOT NULL COMMENT 'FK → contacts',
  `url` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'URL',
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Назва / підпис (Портфоліо, Блог...)',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = головний сайт',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_contact` (`id_contact`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Сайти та URL контактів';

CREATE TABLE IF NOT EXISTS `prefix_currencies` (
  `id` smallint unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `iso` char(3) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'ISO 4217: UAH, USD, EUR, PLN...',
  `symbol` varchar(5) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Символ: ₴, $, €',
  `symbol_pos` tinyint(1) NOT NULL DEFAULT '0' COMMENT '0 = перед сумою, 1 = після',
  `rate` decimal(18,6) NOT NULL DEFAULT '1.000000' COMMENT 'Курс відносно базової валюти',
  `rate_updated` datetime DEFAULT NULL COMMENT 'Коли оновлено курс',
  `is_base` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = базова валюта системи',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_iso` (`iso`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Довідник валют';

CREATE TABLE IF NOT EXISTS `prefix_currencies_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_currency` smallint unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Українська гривня / US Dollar...',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_currency_lang` (`id_currency`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_activity_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `customer_id` int unsigned NOT NULL,
  `user_id` int unsigned DEFAULT NULL,
  `user_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `action_type` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `field_name` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `old_value` text COLLATE utf8mb4_unicode_ci,
  `new_value` text COLLATE utf8mb4_unicode_ci,
  `description` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ip_address` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_customer` (`customer_id`,`created_at`),
  KEY `idx_action` (`customer_id`,`action_type`),
  KEY `idx_field` (`customer_id`,`field_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_addresses` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `customer_id` int unsigned NOT NULL,
  `type` enum('billing','shipping','home','work','other') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'shipping',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `country` char(2) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UA',
  `region` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `city` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `district` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `street` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `building` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `apartment` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `zip` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `recipient_name` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `recipient_phone` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `entrance` varchar(10) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `floor` tinyint DEFAULT NULL,
  `intercom_code` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `carrier` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'nova_poshta, ukrposhta, meest',
  `np_warehouse_ref` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'UUID відділення з API НП',
  `np_warehouse_num` varchar(10) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `np_warehouse_address` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `lat` decimal(10,7) DEFAULT NULL,
  `lon` decimal(10,7) DEFAULT NULL,
  `use_count` smallint unsigned NOT NULL DEFAULT '0',
  `last_used_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_customer` (`customer_id`),
  KEY `idx_type` (`type`),
  KEY `idx_default` (`customer_id`,`is_default`),
  CONSTRAINT `fk_addr_customer` FOREIGN KEY (`customer_id`) REFERENCES `prefix_customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_addresses_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_address` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `label` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Дача / Country house',
  `delivery_instructions` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_addr_lang` (`id_address`,`id_lang`),
  CONSTRAINT `fk_addrlang` FOREIGN KEY (`id_address`) REFERENCES `prefix_customer_addresses` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_analytics` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `customer_id` int unsigned NOT NULL,
  `total_orders` smallint unsigned NOT NULL DEFAULT '0',
  `total_spent` decimal(14,2) NOT NULL DEFAULT '0.00',
  `average_order_value` decimal(12,2) NOT NULL DEFAULT '0.00',
  `max_order_value` decimal(12,2) NOT NULL DEFAULT '0.00',
  `total_returned` decimal(12,2) NOT NULL DEFAULT '0.00',
  `total_cancelled` smallint unsigned NOT NULL DEFAULT '0',
  `first_order_at` datetime DEFAULT NULL,
  `last_order_at` datetime DEFAULT NULL,
  `days_since_last_order` smallint DEFAULT NULL,
  `avg_days_between_orders` smallint DEFAULT NULL,
  `predicted_ltv` decimal(14,2) DEFAULT NULL,
  `repeat_probability` decimal(5,4) DEFAULT NULL COMMENT '0.0000 – 1.0000',
  `churn_risk` decimal(5,4) DEFAULT NULL,
  `churn_risk_level` enum('low','medium','high') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `rfm_recency` tinyint DEFAULT NULL COMMENT '1–5',
  `rfm_frequency` tinyint DEFAULT NULL,
  `rfm_monetary` tinyint DEFAULT NULL,
  `rfm_score` varchar(5) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '555, 312',
  `rfm_segment` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Champions, At Risk, Lost',
  `top_categories` json DEFAULT NULL,
  `top_brands` json DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_customer` (`customer_id`),
  KEY `idx_churn_risk` (`churn_risk_level`),
  KEY `idx_total_spent` (`total_spent`),
  KEY `idx_rfm_segment` (`rfm_segment`),
  CONSTRAINT `fk_analytics_customer` FOREIGN KEY (`customer_id`) REFERENCES `prefix_customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_companies` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `customer_id` int unsigned NOT NULL,
  `is_primary` tinyint(1) NOT NULL DEFAULT '1',
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `edrpou` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `vat_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ІПН / номер ПДВ',
  `website` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `contact_person` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `position` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `legal_address` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `bank_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `bank_account` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'IBAN UA...',
  `bank_mfo` varchar(10) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_customer` (`customer_id`),
  KEY `idx_edrpou` (`edrpou`),
  KEY `idx_vat_id` (`vat_id`),
  CONSTRAINT `fk_company_customer` FOREIGN KEY (`customer_id`) REFERENCES `prefix_customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_consent` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `customer_id` int unsigned NOT NULL,
  `terms_accepted` tinyint(1) NOT NULL DEFAULT '0',
  `personal_data_processing` tinyint(1) NOT NULL DEFAULT '0',
  `marketing_emails` tinyint(1) NOT NULL DEFAULT '0',
  `marketing_sms` tinyint(1) NOT NULL DEFAULT '0',
  `marketing_push` tinyint(1) NOT NULL DEFAULT '0',
  `marketing_phone` tinyint(1) NOT NULL DEFAULT '0',
  `marketing_viber` tinyint(1) NOT NULL DEFAULT '0',
  `accepted_at` datetime DEFAULT NULL,
  `ip_address_at_consent` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `consent_source` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'website_checkout, call_center',
  `consent_version` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'версія документу політики',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_customer` (`customer_id`),
  CONSTRAINT `fk_consent_customer` FOREIGN KEY (`customer_id`) REFERENCES `prefix_customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_consent_log` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `customer_id` int unsigned NOT NULL,
  `field` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'marketing_emails, marketing_sms...',
  `old_value` tinyint(1) DEFAULT NULL,
  `new_value` tinyint(1) NOT NULL,
  `changed_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `changed_by` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'customer, manager_007, system',
  `ip_address` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `source` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_customer` (`customer_id`),
  KEY `idx_changed` (`changed_at`),
  CONSTRAINT `fk_clog_customer` FOREIGN KEY (`customer_id`) REFERENCES `prefix_customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_contacts` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `customer_id` int unsigned NOT NULL,
  `type` enum('phone','email','fax','other') COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '+380671234567 або user@mail.com',
  `id_label` smallint unsigned DEFAULT NULL COMMENT 'FK → 8ydnb966_contact_label_dict',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0',
  `is_verified` tinyint(1) NOT NULL DEFAULT '0',
  `verified_at` datetime DEFAULT NULL,
  `do_not_use` tinyint(1) NOT NULL DEFAULT '0',
  `note` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_customer` (`customer_id`),
  KEY `idx_value` (`value`),
  KEY `idx_type` (`type`),
  KEY `idx_primary` (`customer_id`,`type`,`is_primary`),
  KEY `fk_contact_label` (`id_label`),
  CONSTRAINT `fk_contact_customer` FOREIGN KEY (`customer_id`) REFERENCES `prefix_customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_contact_label` FOREIGN KEY (`id_label`) REFERENCES `prefix_contact_label_dict` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_custom_field_defs` (
  `id` smallint unsigned NOT NULL AUTO_INCREMENT,
  `field_key` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'системний ключ: preferred_contact_time',
  `field_type` enum('text','number','date','boolean','select','multiselect','url') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'text',
  `is_required` tinyint(1) NOT NULL DEFAULT '0',
  `is_visible` tinyint(1) NOT NULL DEFAULT '1',
  `sort` tinyint unsigned NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_field_key` (`field_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_custom_field_defs_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_field_def` smallint unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Зручний час дзвінка',
  `description` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `placeholder` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_field_lang` (`id_field_def`,`id_lang`),
  KEY `idx_lang` (`id_lang`),
  CONSTRAINT `fk_cfd_lang` FOREIGN KEY (`id_field_def`) REFERENCES `prefix_customer_custom_field_defs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_custom_fields` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `customer_id` int unsigned NOT NULL,
  `id_field_def` smallint unsigned NOT NULL,
  `field_value` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cust_field` (`customer_id`,`id_field_def`),
  KEY `idx_field_def` (`id_field_def`),
  CONSTRAINT `fk_cf_customer` FOREIGN KEY (`customer_id`) REFERENCES `prefix_customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cf_def` FOREIGN KEY (`id_field_def`) REFERENCES `prefix_customer_custom_field_defs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_loyalty` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `customer_id` int unsigned NOT NULL,
  `id_level` smallint unsigned DEFAULT NULL COMMENT 'FK → loyalty_levels_dict',
  `id_next_level` smallint unsigned DEFAULT NULL,
  `points_balance` int NOT NULL DEFAULT '0',
  `points_earned_total` int NOT NULL DEFAULT '0',
  `points_spent_total` int NOT NULL DEFAULT '0',
  `points_expired_total` int NOT NULL DEFAULT '0',
  `points_to_next_level` int DEFAULT NULL,
  `level_achieved_at` datetime DEFAULT NULL,
  `level_expires_at` datetime DEFAULT NULL,
  `cashback_balance` decimal(10,2) NOT NULL DEFAULT '0.00',
  `cashback_earned_total` decimal(10,2) NOT NULL DEFAULT '0.00',
  `cashback_spent_total` decimal(10,2) NOT NULL DEFAULT '0.00',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_customer` (`customer_id`),
  KEY `idx_level` (`id_level`),
  CONSTRAINT `fk_loyalty_customer` FOREIGN KEY (`customer_id`) REFERENCES `prefix_customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_loyalty_level` FOREIGN KEY (`id_level`) REFERENCES `prefix_customer_loyalty_levels_dict` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_loyalty_levels_dict` (
  `id` smallint unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'bronze, silver, gold, platinum',
  `color` varchar(7) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `points_required` int unsigned NOT NULL DEFAULT '0' COMMENT 'мін. балів для рівня',
  `sort` tinyint unsigned NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_loyalty_levels_dict_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_level` smallint unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_level_lang` (`id_level`,`id_lang`),
  KEY `idx_lang` (`id_lang`),
  CONSTRAINT `fk_loydict_lang` FOREIGN KEY (`id_level`) REFERENCES `prefix_customer_loyalty_levels_dict` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_loyalty_log` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `customer_id` int unsigned NOT NULL,
  `type` enum('earn','spend','expire','adjust','refund','cashback_earn','cashback_spend') COLLATE utf8mb4_unicode_ci NOT NULL,
  `points` int NOT NULL DEFAULT '0',
  `cashback` decimal(10,2) NOT NULL DEFAULT '0.00',
  `balance_after` int NOT NULL DEFAULT '0',
  `reason` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ref_type` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'order, return, promo, manual',
  `ref_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ORD-2026-000123',
  `created_by` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_customer` (`customer_id`),
  KEY `idx_ref` (`ref_type`,`ref_id`),
  KEY `idx_type` (`type`),
  KEY `idx_created` (`created_at`),
  CONSTRAINT `fk_llog_customer` FOREIGN KEY (`customer_id`) REFERENCES `prefix_customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_merge_log` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `master_id` int unsigned NOT NULL COMMENT 'клієнт що залишився',
  `merged_id` int unsigned NOT NULL COMMENT 'клієнт що поглинутий',
  `merged_uid` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'зберігаємо uid для аудиту',
  `merged_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `merged_by` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `reason` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_master` (`master_id`),
  KEY `idx_merged` (`merged_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customer_notes` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `customer_id` int unsigned NOT NULL,
  `body` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `is_pinned` tinyint(1) NOT NULL DEFAULT '0',
  `visibility` enum('internal','team','public') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'internal',
  `author_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `author_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_customer` (`customer_id`),
  KEY `idx_pinned` (`customer_id`,`is_pinned`),
  CONSTRAINT `fk_note_customer` FOREIGN KEY (`customer_id`) REFERENCES `prefix_customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customers` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `uid` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'CUST-4521',
  `external_id` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `external_source` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'prestashop, website, import',
  `type` enum('individual','company') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'individual',
  `first_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `middle_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `gender` enum('male','female','other') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `birthday` date DEFAULT NULL,
  `age` tinyint unsigned DEFAULT NULL COMMENT 'денормалізовано, оновлює крон/тригер',
  `language` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'uk',
  `timezone` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'Europe/Kyiv',
  `currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UAH',
  `preferred_contact` enum('phone','email','telegram','viber','whatsapp') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `preferred_contact_time` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `do_not_call` tinyint(1) NOT NULL DEFAULT '0',
  `do_not_email` tinyint(1) NOT NULL DEFAULT '0',
  `do_not_sms` tinyint(1) NOT NULL DEFAULT '0',
  `source` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'instagram, google, referral',
  `referral_code` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'власний реф. код клієнта',
  `referred_by_id` int unsigned DEFAULT NULL,
  `segment` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payment_discipline` enum('good','average','bad') COLLATE utf8mb4_unicode_ci DEFAULT 'good',
  `credit_limit` decimal(12,2) NOT NULL DEFAULT '0.00',
  `blacklisted` tinyint(1) NOT NULL DEFAULT '0',
  `blacklist_reason` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `blacklisted_at` datetime DEFAULT NULL,
  `is_new` tinyint(1) NOT NULL DEFAULT '1',
  `lead_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `deal_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `quote_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `assigned_to` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `social_telegram` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `social_instagram` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `social_viber` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `social_whatsapp` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `social_facebook` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `social_tiktok` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `pref_delivery_method` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `pref_delivery_warehouse` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `pref_delivery_city` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `tags` json DEFAULT NULL COMMENT '["vip","wholesale"]',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` datetime DEFAULT NULL COMMENT 'soft delete',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_uid` (`uid`),
  UNIQUE KEY `uq_external` (`external_source`,`external_id`),
  KEY `idx_type` (`type`),
  KEY `idx_segment` (`segment`),
  KEY `idx_blacklisted` (`blacklisted`),
  KEY `idx_assigned_to` (`assigned_to`),
  KEY `idx_referred_by` (`referred_by_id`),
  KEY `idx_source` (`source`),
  KEY `idx_created_at` (`created_at`),
  KEY `idx_deleted_at` (`deleted_at`),
  CONSTRAINT `fk_cust_referred` FOREIGN KEY (`referred_by_id`) REFERENCES `prefix_customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customers_groups` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `color_text` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#000000',
  `color_background` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `icon` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `sort` tinyint unsigned NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customers_groups_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_group` int unsigned NOT NULL,
  `id_lang` int unsigned NOT NULL,
  `text` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'назва групи цією мовою',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_group_lang` (`id_group`,`id_lang`),
  KEY `idx_lang` (`id_lang`),
  CONSTRAINT `fk_cgroup_lang` FOREIGN KEY (`id_group`) REFERENCES `prefix_customers_groups` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_customers_to_groups` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `client_id` int unsigned NOT NULL,
  `group_id` int unsigned NOT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_client_group` (`client_id`,`group_id`),
  KEY `idx_group` (`group_id`),
  CONSTRAINT `fk_c2g_client` FOREIGN KEY (`client_id`) REFERENCES `prefix_customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_c2g_group` FOREIGN KEY (`group_id`) REFERENCES `prefix_customers_groups` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_pipeline` int unsigned NOT NULL COMMENT 'FK → deals_pipeline',
  `id_stage` int unsigned NOT NULL COMMENT 'FK → deals_stage',
  `id_stage_prev` int unsigned DEFAULT NULL COMMENT 'Попередня стадія',
  `id_deal_type` int unsigned DEFAULT NULL COMMENT 'FK → deals_type',
  `id_source` int unsigned DEFAULT NULL COMMENT 'FK → deals_source',
  `id_lost_reason` int unsigned DEFAULT NULL COMMENT 'FK → deals_lost_reason',
  `id_company` int unsigned DEFAULT NULL COMMENT 'FK → companies',
  `id_contact` int unsigned DEFAULT NULL COMMENT 'FK → contacts',
  `id_lead` int unsigned DEFAULT NULL COMMENT 'FK → leads',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users (менеджер)',
  `id_user_creator` int unsigned DEFAULT NULL COMMENT 'FK → users (хто створив)',
  `id_team` int unsigned DEFAULT NULL COMMENT 'FK → teams',
  `title` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Назва угоди',
  `description` text COLLATE utf8mb4_unicode_ci COMMENT 'Опис',
  `notes` text COLLATE utf8mb4_unicode_ci COMMENT 'Внутрішні нотатки',
  `amount` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Сума угоди',
  `amount_gross` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Сума до знижки (price * qty з позицій)',
  `amount_currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UAH' COMMENT 'Валюта',
  `amount_base` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Сума в базовій валюті',
  `discount` decimal(10,2) NOT NULL DEFAULT '0.00' COMMENT 'Знижка',
  `discount_type` tinyint(1) NOT NULL DEFAULT '0' COMMENT '0=%, 1=фікс.сума',
  `discount_amount` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Загальна сума знижки (авто з позицій)',
  `tax_amount` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Сума ПДВ',
  `amount_final` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Фінальна сума',
  `probability` tinyint unsigned NOT NULL DEFAULT '0' COMMENT 'Ймовірність %',
  `probability_override` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = менеджер змінив вручну, 0 = автоматично від стадії',
  `amount_weighted` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Зважена сума (amount * probability/100)',
  `margin_amount` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Маржа (amount - cost_price * qty)',
  `margin_percent` decimal(6,2) NOT NULL DEFAULT '0.00' COMMENT 'Маржа %',
  `forecast_category` enum('pipeline','best_case','commit','closed','omitted') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pipeline' COMMENT 'Категорія прогнозу',
  `date_close_plan` date DEFAULT NULL COMMENT 'Планова дата закриття',
  `date_close_fact` date DEFAULT NULL COMMENT 'Фактична дата закриття',
  `date_next_action` datetime DEFAULT NULL COMMENT 'Дата наступної дії',
  `date_stage_changed` datetime DEFAULT NULL COMMENT 'Коли змінилась стадія',
  `id_competitor` int unsigned DEFAULT NULL COMMENT 'FK → companies (конкурент)',
  `competitor_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Конкурент вручну',
  `deal_number` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Номер угоди (авто)',
  `external_id` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ID в ERP/1С',
  `is_rotting` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = угода протухає',
  `rotting_days` smallint NOT NULL DEFAULT '0' COMMENT 'Днів без активності',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deal_number` (`deal_number`),
  KEY `idx_pipeline` (`id_pipeline`),
  KEY `idx_stage` (`id_stage`),
  KEY `idx_company` (`id_company`),
  KEY `idx_contact` (`id_contact`),
  KEY `idx_user` (`id_user`),
  KEY `idx_date_close` (`date_close_plan`),
  KEY `idx_amount` (`amount_final`),
  KEY `idx_forecast` (`forecast_category`),
  KEY `idx_active` (`active`),
  KEY `idx_external_id` (`external_id`),
  KEY `idx_active_date_add` (`active`,`date_add`),
  KEY `idx_id_stage` (`id_stage`),
  KEY `idx_id_pipeline` (`id_pipeline`),
  KEY `idx_id_deal_type` (`id_deal_type`),
  KEY `idx_id_source` (`id_source`),
  KEY `idx_id_company` (`id_company`),
  KEY `idx_id_contact` (`id_contact`),
  KEY `idx_id_user` (`id_user`),
  KEY `idx_id_competitor` (`id_competitor`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Головна таблиця угод CRM';

CREATE TABLE IF NOT EXISTS `prefix_deals_act` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_deal` int unsigned DEFAULT NULL COMMENT 'FK → deals',
  `id_contract` int unsigned DEFAULT NULL COMMENT 'FK → deals_contract',
  `id_invoice` int unsigned DEFAULT NULL COMMENT 'FK → deals_invoice',
  `id_company` int unsigned DEFAULT NULL COMMENT 'FK → companies',
  `id_contact` int unsigned DEFAULT NULL COMMENT 'FK → contacts',
  `id_act_status` int unsigned NOT NULL COMMENT 'FK → deals_act_status',
  `id_user` int unsigned DEFAULT NULL,
  `act_number` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Номер: АКТ-2026-0001',
  `date_act` date NOT NULL,
  `date_signed` date DEFAULT NULL,
  `currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UAH',
  `amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `tax_amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `amount_total` decimal(18,2) NOT NULL DEFAULT '0.00',
  `subject` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `file_pdf` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_act_number` (`act_number`),
  KEY `idx_deal` (`id_deal`),
  KEY `idx_contract` (`id_contract`),
  KEY `idx_company` (`id_company`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Акти виконаних робіт';

CREATE TABLE IF NOT EXISTS `prefix_deals_act_item` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_act` int unsigned NOT NULL COMMENT 'FK → deals_act',
  `id_product` int unsigned DEFAULT NULL COMMENT 'FK → зовнішня таблиця товарів',
  `id_unit` int unsigned DEFAULT NULL,
  `name` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `qty` decimal(10,3) NOT NULL DEFAULT '1.000',
  `price` decimal(18,2) NOT NULL DEFAULT '0.00',
  `tax_rate` decimal(6,2) NOT NULL DEFAULT '0.00',
  `tax_amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `amount_total` decimal(18,2) NOT NULL DEFAULT '0.00',
  `sort_order` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_act` (`id_act`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Позиції актів';

CREATE TABLE IF NOT EXISTS `prefix_deals_act_status` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `color_background` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#000000',
  `color_text` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_act_status_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_act_status` int unsigned NOT NULL COMMENT 'FK → deals_act_status',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_as_lang` (`id_act_status`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_activity` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_activity_type` int unsigned NOT NULL COMMENT 'FK → deals_activity_type',
  `id_outcome` int unsigned DEFAULT NULL COMMENT 'FK → deals_activity_outcome',
  `id_deal` int unsigned DEFAULT NULL COMMENT 'FK → deals',
  `id_company` int unsigned DEFAULT NULL COMMENT 'FK → companies',
  `id_contact` int unsigned DEFAULT NULL COMMENT 'FK → contacts',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users (відповідальний)',
  `id_user_creator` int unsigned DEFAULT NULL COMMENT 'FK → users (хто створив)',
  `subject` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `result` text COLLATE utf8mb4_unicode_ci,
  `next_step` text COLLATE utf8mb4_unicode_ci,
  `date_plan` datetime NOT NULL,
  `date_start` datetime DEFAULT NULL,
  `date_end` datetime DEFAULT NULL,
  `duration_minutes` smallint unsigned DEFAULT NULL,
  `timezone` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `location` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `location_url` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Zoom/Meet посилання',
  `reminder` tinyint(1) NOT NULL DEFAULT '0',
  `reminder_minutes` smallint unsigned DEFAULT NULL,
  `reminder_sent` tinyint(1) NOT NULL DEFAULT '0',
  `status` enum('planned','in_progress','done','canceled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'planned',
  `is_overdue` tinyint(1) NOT NULL DEFAULT '0',
  `priority` tinyint unsigned NOT NULL DEFAULT '2' COMMENT '1=низький..4=критичний',
  `is_private` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_type` (`id_activity_type`),
  KEY `idx_deal` (`id_deal`),
  KEY `idx_company` (`id_company`),
  KEY `idx_contact` (`id_contact`),
  KEY `idx_user` (`id_user`),
  KEY `idx_date_plan` (`date_plan`),
  KEY `idx_status` (`status`),
  KEY `idx_active_deal` (`id_deal`,`active`,`date_plan`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Активності угод (дзвінки, зустрічі, листи, нотатки...)';

CREATE TABLE IF NOT EXISTS `prefix_deals_activity_outcome` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_activity_type` int unsigned DEFAULT NULL COMMENT 'NULL = для всіх типів',
  `color_background` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#e9ecef',
  `color_text` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#212529',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_type` (`id_activity_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_activity_outcome_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_outcome` int unsigned NOT NULL COMMENT 'FK → deals_activity_outcome',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ao_lang` (`id_outcome`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_activity_participant` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_activity` int unsigned NOT NULL COMMENT 'FK → deals_activity',
  `participant_type` enum('user','contact') COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_participant` int unsigned NOT NULL,
  `status` enum('invited','accepted','declined','attended') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'invited',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_activity_participant` (`id_activity`,`participant_type`,`id_participant`),
  KEY `idx_activity` (`id_activity`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Учасники активностей';

CREATE TABLE IF NOT EXISTS `prefix_deals_activity_type` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'call/meeting/email/note...',
  `icon` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `color` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#007bff',
  `has_duration` tinyint(1) NOT NULL DEFAULT '0',
  `has_location` tinyint(1) NOT NULL DEFAULT '0',
  `has_outcome` tinyint(1) NOT NULL DEFAULT '1',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Типи активностей';

CREATE TABLE IF NOT EXISTS `prefix_deals_activity_type_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_activity_type` int unsigned NOT NULL COMMENT 'FK → deals_activity_type',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_at_lang` (`id_activity_type`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_audit_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users',
  `user_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Ім''я (знімок)',
  `user_ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `entity_type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'deal/quote/contract/invoice/act/activity/task',
  `id_entity` int unsigned NOT NULL,
  `action` enum('create','update','delete','restore','view','export','stage_change','status_change') COLLATE utf8mb4_unicode_ci NOT NULL,
  `field_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `value_old` text COLLATE utf8mb4_unicode_ci,
  `value_new` text COLLATE utf8mb4_unicode_ci,
  `description` text COLLATE utf8mb4_unicode_ci,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_entity` (`entity_type`,`id_entity`),
  KEY `idx_user` (`id_user`),
  KEY `idx_action` (`action`),
  KEY `idx_date` (`date_add`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Журнал всіх змін угод (audit log)';

CREATE TABLE IF NOT EXISTS `prefix_deals_calendar_event_type` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'meeting/call/reminder/deadline/vacation...',
  `icon` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `color` varchar(7) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#007bff',
  `has_location` tinyint(1) NOT NULL DEFAULT '1',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Типи подій календаря угод';

CREATE TABLE IF NOT EXISTS `prefix_deals_calendar_event_type_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_event_type` int unsigned NOT NULL COMMENT 'FK -> deals_calendar_event_type',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_type_lang` (`id_event_type`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_calendar_event_users` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_event` int unsigned NOT NULL,
  `id_user` int unsigned NOT NULL,
  `reminder_sent` tinyint(1) NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_event_user` (`id_event`,`id_user`),
  KEY `idx_event` (`id_event`),
  KEY `idx_user` (`id_user`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Учасники подій календаря (custom-видимість)';

CREATE TABLE IF NOT EXISTS `prefix_deals_calendar_events` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_deal` int unsigned NOT NULL,
  `id_event_type` int unsigned DEFAULT NULL COMMENT 'FK -> deals_calendar_event_type',
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `date_start` datetime NOT NULL,
  `date_end` datetime NOT NULL,
  `all_day` tinyint(1) NOT NULL DEFAULT '0',
  `priority` tinyint unsigned NOT NULL DEFAULT '2' COMMENT '1-низький 2-середній 3-високий 4-критичний',
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'planned' COMMENT 'planned/done/canceled',
  `visibility_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'all' COMMENT 'private/all/custom',
  `reminder` tinyint(1) NOT NULL DEFAULT '0',
  `reminder_minutes` int DEFAULT '30',
  `id_user_creator` int unsigned NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_deal` (`id_deal`),
  KEY `idx_date_start` (`date_start`),
  KEY `idx_event_type` (`id_event_type`),
  KEY `idx_creator` (`id_user_creator`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Події календаря по угодах';

CREATE TABLE IF NOT EXISTS `prefix_deals_companies_map` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_deal` int unsigned NOT NULL COMMENT 'FK → deals',
  `id_company` int unsigned NOT NULL COMMENT 'FK → companies',
  `role` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Роль компанії в угоді',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deal_company` (`id_deal`,`id_company`),
  KEY `idx_deal` (`id_deal`),
  KEY `idx_company` (`id_company`),
  KEY `idx_id_deal` (`id_deal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Компанії прив''язані до угоди (many-to-many)';

CREATE TABLE IF NOT EXISTS `prefix_deals_contacts_map` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_deal` int unsigned NOT NULL COMMENT 'FK → deals',
  `id_contact` int unsigned NOT NULL COMMENT 'FK → contacts',
  `id_role` int unsigned DEFAULT NULL COMMENT 'FK → contacts_role',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deal_contact` (`id_deal`,`id_contact`),
  KEY `idx_deal` (`id_deal`),
  KEY `idx_contact` (`id_contact`),
  KEY `idx_id_deal` (`id_deal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Контакти прив''язані до угоди (many-to-many)';

CREATE TABLE IF NOT EXISTS `prefix_deals_contract` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_deal` int unsigned DEFAULT NULL COMMENT 'FK → deals',
  `id_quote` int unsigned DEFAULT NULL COMMENT 'FK → deals_quote',
  `id_company` int unsigned DEFAULT NULL COMMENT 'FK → companies',
  `id_contact` int unsigned DEFAULT NULL COMMENT 'FK → contacts',
  `id_contract_status` int unsigned NOT NULL COMMENT 'FK → deals_contract_status',
  `id_contract_type` int unsigned DEFAULT NULL COMMENT 'FK → deals_contract_type',
  `id_template` int unsigned DEFAULT NULL COMMENT 'FK → deals_doc_template',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users',
  `id_contract_parent` int unsigned DEFAULT NULL COMMENT 'FK → deals_contract (для доп.угод)',
  `contract_number` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Номер: ДОГ-2026-0001',
  `external_number` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Номер договору клієнта',
  `date_contract` date NOT NULL,
  `date_start` date DEFAULT NULL,
  `date_end` date DEFAULT NULL,
  `date_signed_us` date DEFAULT NULL,
  `date_signed_client` date DEFAULT NULL,
  `date_terminated` date DEFAULT NULL,
  `auto_renew` tinyint(1) NOT NULL DEFAULT '0',
  `renew_days_before` tinyint unsigned DEFAULT NULL COMMENT 'Нагадати за N днів',
  `currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UAH',
  `amount_total` decimal(18,2) NOT NULL DEFAULT '0.00',
  `payment_terms` text COLLATE utf8mb4_unicode_ci,
  `delivery_terms` text COLLATE utf8mb4_unicode_ci,
  `signed_by_us` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `signed_by_client` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `signatory_basis` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'На підставі чого підписує',
  `subject` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Предмет договору',
  `notes` text COLLATE utf8mb4_unicode_ci,
  `internal_notes` text COLLATE utf8mb4_unicode_ci,
  `file_pdf` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_contract_number` (`contract_number`),
  KEY `idx_deal` (`id_deal`),
  KEY `idx_company` (`id_company`),
  KEY `idx_status` (`id_contract_status`),
  KEY `idx_date_end` (`date_end`),
  KEY `idx_auto_renew` (`auto_renew`,`date_end`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Договори';

CREATE TABLE IF NOT EXISTS `prefix_deals_contract_file` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_contract` int unsigned NOT NULL COMMENT 'FK → deals_contract',
  `file_path` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `file_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `file_size` int unsigned DEFAULT NULL,
  `file_type` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `description` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_contract` (`id_contract`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Файли договорів';

CREATE TABLE IF NOT EXISTS `prefix_deals_contract_status` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `color_background` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#000000',
  `color_text` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_contract_status_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_contract_status` int unsigned NOT NULL COMMENT 'FK → deals_contract_status',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cs_lang` (`id_contract_status`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_contract_type` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_contract_type_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_contract_type` int unsigned NOT NULL COMMENT 'FK → deals_contract_type',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ct_lang` (`id_contract_type`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_custom_field` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_group` int unsigned DEFAULT NULL COMMENT 'FK → deals_custom_field_group',
  `field_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'text|textarea|number|decimal|date|datetime|checkbox|select|multiselect|url|email|phone|file',
  `field_key` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `label` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Назва поля',
  `placeholder` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `hint` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_pipeline` int unsigned DEFAULT NULL COMMENT 'FK → deals_pipeline (NULL = для всіх)',
  `is_required` tinyint(1) NOT NULL DEFAULT '0',
  `is_unique` tinyint(1) NOT NULL DEFAULT '0',
  `default_value` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `icon` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'FA іконка',
  `show_in_list` tinyint(1) NOT NULL DEFAULT '0',
  `show_in_card` tinyint(1) NOT NULL DEFAULT '1',
  `show_in_kanban` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_field_key` (`field_key`),
  KEY `idx_pipeline` (`id_pipeline`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Кастомні поля угод';

CREATE TABLE IF NOT EXISTS `prefix_deals_custom_field_group` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `sort_order` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_custom_field_group_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_group` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_custom_field_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_custom_field` int unsigned NOT NULL COMMENT 'FK → deals_custom_field',
  `id_lang` smallint unsigned NOT NULL,
  `label` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `placeholder` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `hint` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_dcf_lang` (`id_custom_field`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_custom_field_option` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_custom_field` int unsigned NOT NULL COMMENT 'FK → deals_custom_field',
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Назва варіанту',
  `value` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Значення (якщо відрізняється від назви)',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_field` (`id_custom_field`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_custom_field_value` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_deal` int unsigned NOT NULL COMMENT 'FK → deals',
  `id_custom_field` int unsigned NOT NULL COMMENT 'FK → deals_custom_field',
  `value_text` text COLLATE utf8mb4_unicode_ci,
  `value_int` int DEFAULT NULL,
  `value_decimal` decimal(18,4) DEFAULT NULL,
  `value_date` date DEFAULT NULL,
  `value_datetime` datetime DEFAULT NULL,
  `value_json` json DEFAULT NULL COMMENT 'Для multiselect, tags',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deal_field` (`id_deal`,`id_custom_field`),
  KEY `idx_deal` (`id_deal`),
  KEY `idx_custom_field` (`id_custom_field`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Значення кастомних полів угод (EAV)';

CREATE TABLE IF NOT EXISTS `prefix_deals_doc_counter` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `doc_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'quote / contract / invoice / act',
  `year` year NOT NULL,
  `counter` int unsigned NOT NULL DEFAULT '0',
  `prefix` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `padding` tinyint NOT NULL DEFAULT '4' COMMENT 'Довжина: 0001',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_doc_type_year` (`doc_type`,`year`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Лічильники авто-нумерації документів';

CREATE TABLE IF NOT EXISTS `prefix_deals_doc_template` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `doc_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'quote / contract / invoice / act',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_doc_type` (`doc_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Шаблони документів (HTML → PDF)';

CREATE TABLE IF NOT EXISTS `prefix_deals_doc_template_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_template` int unsigned NOT NULL COMMENT 'FK → deals_doc_template',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `body` longtext COLLATE utf8mb4_unicode_ci COMMENT 'HTML з {змінними}',
  `css` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tmpl_lang` (`id_template`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_file` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `entity_type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'deal/quote/contract/invoice/act/activity/task',
  `id_entity` int unsigned NOT NULL COMMENT 'ID запису',
  `id_deal` int unsigned DEFAULT NULL COMMENT 'FK → deals (для швидкої вибірки)',
  `id_company` int unsigned DEFAULT NULL COMMENT 'FK → companies',
  `id_category` int unsigned DEFAULT NULL COMMENT 'FK → deals_file_category',
  `file_path` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `file_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `file_ext` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `file_size` int unsigned DEFAULT NULL,
  `file_mime` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `file_hash` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'SHA256 для дедуплікації',
  `version` tinyint unsigned NOT NULL DEFAULT '1',
  `id_file_parent` int unsigned DEFAULT NULL COMMENT 'FK → deals_file (попередня версія)',
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `is_public` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = видно клієнту',
  `id_user` int unsigned DEFAULT NULL,
  `download_count` int unsigned NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_entity` (`entity_type`,`id_entity`),
  KEY `idx_deal` (`id_deal`),
  KEY `idx_company` (`id_company`),
  KEY `idx_category` (`id_category`),
  KEY `idx_hash` (`file_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Файли та документи угод';

CREATE TABLE IF NOT EXISTS `prefix_deals_file_category` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_file_category_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_category` int unsigned NOT NULL COMMENT 'FK → deals_file_category',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_dfc_lang` (`id_category`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_invoice` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_deal` int unsigned DEFAULT NULL COMMENT 'FK → deals',
  `id_quote` int unsigned DEFAULT NULL COMMENT 'FK → deals_quote',
  `id_contract` int unsigned DEFAULT NULL COMMENT 'FK → deals_contract',
  `id_company` int unsigned DEFAULT NULL COMMENT 'FK → companies',
  `id_contact` int unsigned DEFAULT NULL COMMENT 'FK → contacts',
  `id_invoice_status` int unsigned NOT NULL COMMENT 'FK → deals_invoice_status',
  `id_template` int unsigned DEFAULT NULL COMMENT 'FK → deals_doc_template',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users',
  `id_bank_account` int unsigned DEFAULT NULL COMMENT 'FK → companies_bank_accounts (наш рахунок)',
  `invoice_number` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Номер: РАХ-2026-0001',
  `invoice_type` enum('invoice','prepayment','correction','credit_note') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'invoice',
  `date_invoice` date NOT NULL,
  `date_due` date DEFAULT NULL COMMENT 'Дата оплати (план)',
  `date_paid` date DEFAULT NULL COMMENT 'Дата оплати (факт)',
  `date_sent` datetime DEFAULT NULL,
  `currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UAH',
  `amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `discount_amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `tax_amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `amount_total` decimal(18,2) NOT NULL DEFAULT '0.00',
  `amount_paid` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Сплачено',
  `amount_due` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Залишок',
  `payer_name` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Назва платника (знімок)',
  `payer_edrpou` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payer_ipn` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payer_address` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payer_iban` varchar(34) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payer_bank` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payer_mfo` varchar(10) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payment_terms` text COLLATE utf8mb4_unicode_ci,
  `purpose` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Призначення платежу',
  `notes` text COLLATE utf8mb4_unicode_ci,
  `internal_notes` text COLLATE utf8mb4_unicode_ci,
  `reminder_sent` tinyint(1) NOT NULL DEFAULT '0',
  `reminder_date` datetime DEFAULT NULL,
  `file_pdf` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_invoice_number` (`invoice_number`),
  KEY `idx_deal` (`id_deal`),
  KEY `idx_company` (`id_company`),
  KEY `idx_status` (`id_invoice_status`),
  KEY `idx_date_due` (`date_due`),
  KEY `idx_overdue` (`id_invoice_status`,`date_due`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Рахунки на оплату';

CREATE TABLE IF NOT EXISTS `prefix_deals_invoice_item` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_invoice` int unsigned NOT NULL COMMENT 'FK → deals_invoice',
  `id_product` int unsigned DEFAULT NULL COMMENT 'FK → зовнішня таблиця товарів',
  `id_unit` int unsigned DEFAULT NULL,
  `id_tax` int unsigned DEFAULT NULL,
  `name` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `sku` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `qty` decimal(10,3) NOT NULL DEFAULT '1.000',
  `price` decimal(18,2) NOT NULL DEFAULT '0.00',
  `discount` decimal(10,2) NOT NULL DEFAULT '0.00',
  `discount_type` tinyint(1) NOT NULL DEFAULT '0',
  `discount_amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `tax_rate` decimal(6,2) NOT NULL DEFAULT '0.00',
  `tax_included` tinyint(1) NOT NULL DEFAULT '0',
  `tax_amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `amount_total` decimal(18,2) NOT NULL DEFAULT '0.00',
  `sort_order` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_invoice` (`id_invoice`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Позиції рахунків';

CREATE TABLE IF NOT EXISTS `prefix_deals_invoice_status` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `color_background` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#000000',
  `color_text` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_invoice_status_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_invoice_status` int unsigned NOT NULL COMMENT 'FK → deals_invoice_status',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_is_lang` (`id_invoice_status`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_item` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_deal` int unsigned NOT NULL COMMENT 'FK → deals',
  `id_item_type` int unsigned DEFAULT NULL COMMENT 'FK → deals_item_type',
  `id_product` int unsigned DEFAULT NULL COMMENT 'FK → зовнішня таблиця товарів (заповнюється якщо item_type=product)',
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `id_warehouse` int unsigned DEFAULT NULL,
  `ref_type` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Таблиця-джерело: products, services, works... (NULL = вручну)',
  `id_ref` int unsigned DEFAULT NULL COMMENT 'ID запису в таблиці ref_type (NULL = вручну)',
  `id_unit` int unsigned DEFAULT NULL COMMENT 'FK → deals_unit',
  `id_tax` int unsigned DEFAULT NULL COMMENT 'FK → deals_tax',
  `name` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Назва позиції',
  `description` text COLLATE utf8mb4_unicode_ci COMMENT 'Опис',
  `sku` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Артикул (якщо є)',
  `qty` decimal(10,3) NOT NULL DEFAULT '1.000' COMMENT 'Кількість',
  `price` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Ціна за одиницю (до знижки)',
  `price_currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UAH' COMMENT 'Валюта',
  `discount` decimal(10,2) NOT NULL DEFAULT '0.00' COMMENT 'Знижка',
  `discount_type` tinyint(1) NOT NULL DEFAULT '0' COMMENT '0=%, 1=фіксована сума',
  `discount_amount` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Сума знижки (авто)',
  `tax_rate` decimal(6,2) NOT NULL DEFAULT '0.00' COMMENT 'Ставка ПДВ %',
  `tax_included` tinyint(1) NOT NULL DEFAULT '0' COMMENT '0=ПДВ зверху, 1=включено в ціну',
  `tax_amount` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Сума ПДВ (авто)',
  `amount` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Сума без ПДВ: (price-discount)*qty',
  `amount_total` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Сума з ПДВ',
  `cost_price` decimal(18,2) DEFAULT NULL COMMENT 'Собівартість за одиницю',
  `margin_amount` decimal(18,2) DEFAULT NULL COMMENT 'Маржа',
  `margin_percent` decimal(6,2) DEFAULT NULL COMMENT 'Маржа %',
  `billing_period` enum('once','daily','weekly','monthly','quarterly','yearly') COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Період тарифікації (для підписок, оренди)',
  `billing_cycles` smallint unsigned DEFAULT NULL COMMENT 'Кількість циклів (0=безкінечно)',
  `date_from` date DEFAULT NULL COMMENT 'Дата початку (послуга/оренда/навчання)',
  `date_to` date DEFAULT NULL COMMENT 'Дата закінчення',
  `sort_order` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_deal` (`id_deal`),
  KEY `idx_product` (`id_product`),
  KEY `idx_ref` (`ref_type`,`id_ref`),
  KEY `idx_item_type` (`id_item_type`),
  KEY `idx_active_deal` (`id_deal`,`active`),
  KEY `idx_product_variant` (`id_product`,`id_variant`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Позиції угоди (товари, послуги, роботи, підписки, оренда, навчання, довільні)';

CREATE TABLE IF NOT EXISTS `prefix_deals_item_type` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Системний код: product, service...',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Типи позицій угоди';

CREATE TABLE IF NOT EXISTS `prefix_deals_item_type_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_item_type` int unsigned NOT NULL COMMENT 'FK → deals_item_type',
  `id_lang` smallint unsigned NOT NULL COMMENT 'FK → languages',
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_item_type_lang` (`id_item_type`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_lost_reason` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Причини програшу угод';

CREATE TABLE IF NOT EXISTS `prefix_deals_lost_reason_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_lost_reason` int unsigned NOT NULL COMMENT 'FK → deals_lost_reason',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_lost_reason_lang` (`id_lost_reason`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_payment` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_invoice` int unsigned NOT NULL COMMENT 'FK → deals_invoice',
  `id_deal` int unsigned DEFAULT NULL COMMENT 'FK → deals',
  `id_company` int unsigned DEFAULT NULL COMMENT 'FK → companies',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users',
  `amount` decimal(18,2) NOT NULL,
  `currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UAH',
  `amount_base` decimal(18,2) NOT NULL DEFAULT '0.00',
  `exchange_rate` decimal(18,6) NOT NULL DEFAULT '1.000000',
  `payment_method` enum('bank_transfer','cash','card','crypto','barter','other') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'bank_transfer',
  `transaction_id` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payment_reference` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Призначення платежу',
  `bank_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_payment` date NOT NULL,
  `date_confirmed` datetime DEFAULT NULL,
  `status` enum('pending','confirmed','failed','refunded') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `is_refund` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = повернення',
  `id_payment_parent` int unsigned DEFAULT NULL COMMENT 'FK → deals_payment (для повернень)',
  `notes` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_invoice` (`id_invoice`),
  KEY `idx_deal` (`id_deal`),
  KEY `idx_company` (`id_company`),
  KEY `idx_date` (`date_payment`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Платежі по рахунках';

CREATE TABLE IF NOT EXISTS `prefix_deals_pipeline` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `color` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#007bff' COMMENT 'Колір воронки в інтерфейсі',
  `is_default` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = воронка за замовчуванням',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Воронки продажів';

CREATE TABLE IF NOT EXISTS `prefix_deals_pipeline_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_pipeline` int unsigned NOT NULL COMMENT 'FK → deals_pipeline',
  `id_lang` smallint unsigned NOT NULL COMMENT 'FK → languages',
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pipeline_lang` (`id_pipeline`,`id_lang`),
  KEY `idx_pipeline_lang` (`id_pipeline`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_quote` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_deal` int unsigned DEFAULT NULL COMMENT 'FK → deals',
  `id_company` int unsigned DEFAULT NULL COMMENT 'FK → companies',
  `id_contact` int unsigned DEFAULT NULL COMMENT 'FK → contacts',
  `id_quote_status` int unsigned NOT NULL COMMENT 'FK → deals_quote_status',
  `id_template` int unsigned DEFAULT NULL COMMENT 'FK → deals_doc_template',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users',
  `id_user_creator` int unsigned DEFAULT NULL COMMENT 'FK → users',
  `id_quote_parent` int unsigned DEFAULT NULL COMMENT 'FK → deals_quote (попередня версія)',
  `quote_number` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Номер КП: КП-2026-0001',
  `version` tinyint unsigned NOT NULL DEFAULT '1',
  `date_quote` date NOT NULL,
  `date_valid` date DEFAULT NULL COMMENT 'Дійсне до',
  `date_sent` datetime DEFAULT NULL,
  `date_viewed` datetime DEFAULT NULL,
  `date_accepted` datetime DEFAULT NULL,
  `date_declined` datetime DEFAULT NULL,
  `currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UAH',
  `amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `discount` decimal(10,2) NOT NULL DEFAULT '0.00',
  `discount_type` tinyint(1) NOT NULL DEFAULT '0',
  `discount_amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `tax_amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `amount_total` decimal(18,2) NOT NULL DEFAULT '0.00',
  `payment_terms` text COLLATE utf8mb4_unicode_ci,
  `delivery_terms` text COLLATE utf8mb4_unicode_ci,
  `warranty_terms` text COLLATE utf8mb4_unicode_ci,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `internal_notes` text COLLATE utf8mb4_unicode_ci,
  `footer_text` text COLLATE utf8mb4_unicode_ci,
  `sign_token` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Токен для онлайн-підписання',
  `sign_token_expires` datetime DEFAULT NULL,
  `signed_by` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `signed_ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_signed` datetime DEFAULT NULL,
  `file_pdf` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_quote_number` (`quote_number`),
  KEY `idx_deal` (`id_deal`),
  KEY `idx_company` (`id_company`),
  KEY `idx_status` (`id_quote_status`),
  KEY `idx_valid` (`date_valid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Комерційні пропозиції (КП)';

CREATE TABLE IF NOT EXISTS `prefix_deals_quote_item` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_quote` int unsigned NOT NULL COMMENT 'FK → deals_quote',
  `id_product` int unsigned DEFAULT NULL COMMENT 'FK → зовнішня таблиця товарів',
  `id_unit` int unsigned DEFAULT NULL,
  `id_tax` int unsigned DEFAULT NULL,
  `name` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `sku` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `qty` decimal(10,3) NOT NULL DEFAULT '1.000',
  `price` decimal(18,2) NOT NULL DEFAULT '0.00',
  `discount` decimal(10,2) NOT NULL DEFAULT '0.00',
  `discount_type` tinyint(1) NOT NULL DEFAULT '0',
  `discount_amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `tax_rate` decimal(6,2) NOT NULL DEFAULT '0.00',
  `tax_included` tinyint(1) NOT NULL DEFAULT '0',
  `tax_amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `amount` decimal(18,2) NOT NULL DEFAULT '0.00',
  `amount_total` decimal(18,2) NOT NULL DEFAULT '0.00',
  `sort_order` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_quote` (`id_quote`),
  KEY `idx_product` (`id_product`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Позиції КП';

CREATE TABLE IF NOT EXISTS `prefix_deals_quote_status` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `color_background` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#000000',
  `color_text` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_quote_status_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_quote_status` int unsigned NOT NULL COMMENT 'FK → deals_quote_status',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_qs_lang` (`id_quote_status`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_source` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Джерела угод';

CREATE TABLE IF NOT EXISTS `prefix_deals_source_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_source` int unsigned NOT NULL COMMENT 'FK → deals_source',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deal_source_lang` (`id_source`,`id_lang`),
  KEY `idx_source_lang` (`id_source`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_stage` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_pipeline` int unsigned NOT NULL COMMENT 'FK → deals_pipeline',
  `stage_type` enum('open','won','lost','canceled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'open' COMMENT 'Тип: open/won/lost/canceled',
  `probability` tinyint unsigned NOT NULL DEFAULT '0' COMMENT 'Ймовірність закриття %',
  `color_background` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#e9ecef',
  `color_text` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#212529',
  `is_default` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = початкова стадія воронки',
  `rotting_days` tinyint unsigned DEFAULT NULL COMMENT 'Днів без активності → угода протухає',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_pipeline` (`id_pipeline`),
  KEY `idx_pipeline_active` (`id_pipeline`,`active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Стадії воронок продажів';

CREATE TABLE IF NOT EXISTS `prefix_deals_stage_history` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_deal` int unsigned NOT NULL COMMENT 'FK → deals',
  `id_stage_from` int unsigned DEFAULT NULL COMMENT 'FK → deals_stage (звідки)',
  `id_stage_to` int unsigned NOT NULL COMMENT 'FK → deals_stage (куди)',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users',
  `duration_days` int DEFAULT NULL COMMENT 'Днів у попередній стадії',
  `note` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_deal` (`id_deal`),
  KEY `idx_stage` (`id_stage_to`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Історія переходів між стадіями угоди';

CREATE TABLE IF NOT EXISTS `prefix_deals_stage_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_stage` int unsigned NOT NULL COMMENT 'FK → deals_stage',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_stage_lang` (`id_stage`,`id_lang`),
  KEY `idx_stage_lang` (`id_stage`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_task` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `id_deal` int unsigned DEFAULT NULL COMMENT 'FK → deals',
  `id_company` int unsigned DEFAULT NULL COMMENT 'FK → companies',
  `id_contact` int unsigned DEFAULT NULL COMMENT 'FK → contacts',
  `id_activity` int unsigned DEFAULT NULL COMMENT 'FK → deals_activity',
  `id_user` int unsigned DEFAULT NULL COMMENT 'FK → users (виконавець)',
  `id_user_creator` int unsigned DEFAULT NULL COMMENT 'FK → users (постановник)',
  `id_user_observer` int unsigned DEFAULT NULL COMMENT 'FK → users (спостерігач)',
  `title` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `result` text COLLATE utf8mb4_unicode_ci,
  `date_start` datetime DEFAULT NULL,
  `date_due` datetime DEFAULT NULL,
  `date_done` datetime DEFAULT NULL,
  `estimated_minutes` smallint unsigned DEFAULT NULL,
  `actual_minutes` smallint unsigned DEFAULT NULL,
  `status` enum('new','in_progress','on_hold','done','canceled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'new',
  `priority` tinyint unsigned NOT NULL DEFAULT '2',
  `progress` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '% виконання',
  `is_recurring` tinyint(1) NOT NULL DEFAULT '0',
  `recur_type` enum('daily','weekly','monthly','yearly') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `recur_interval` tinyint unsigned DEFAULT NULL,
  `recur_end_date` date DEFAULT NULL,
  `id_task_parent` int unsigned DEFAULT NULL COMMENT 'FK → deals_task (батьківське)',
  `id_task_blocked_by` int unsigned DEFAULT NULL COMMENT 'FK → deals_task (блокується)',
  `is_private` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_deal` (`id_deal`),
  KEY `idx_company` (`id_company`),
  KEY `idx_user` (`id_user`),
  KEY `idx_status` (`status`),
  KEY `idx_due` (`date_due`),
  KEY `idx_parent` (`id_task_parent`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Завдання';

CREATE TABLE IF NOT EXISTS `prefix_deals_task_checklist` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_task` int unsigned NOT NULL COMMENT 'FK → deals_task',
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `is_done` tinyint(1) NOT NULL DEFAULT '0',
  `id_user` int unsigned DEFAULT NULL,
  `date_done` datetime DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_task` (`id_task`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Чеклісти завдань';

CREATE TABLE IF NOT EXISTS `prefix_deals_tax` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `rate` decimal(6,2) NOT NULL DEFAULT '0.00' COMMENT 'Ставка %',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Ставки ПДВ для позицій угод';

CREATE TABLE IF NOT EXISTS `prefix_deals_tax_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_tax` int unsigned NOT NULL COMMENT 'FK → deals_tax',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tax_lang` (`id_tax`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_total` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_deal` int unsigned NOT NULL COMMENT 'FK → deals',
  `currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL,
  `amount` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Сума без ПДВ',
  `discount_amount` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Загальна знижка',
  `tax_amount` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'ПДВ',
  `amount_total` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Сума з ПДВ',
  `amount_base` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT 'Еквівалент в базовій валюті',
  `margin_amount` decimal(18,2) DEFAULT NULL,
  `margin_percent` decimal(6,2) DEFAULT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deal_currency` (`id_deal`,`currency`),
  KEY `idx_deal` (`id_deal`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Підсумки угоди по валютах (авто-розраховуються)';

CREATE TABLE IF NOT EXISTS `prefix_deals_type` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Типи угод';

CREATE TABLE IF NOT EXISTS `prefix_deals_type_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_deal_type` int unsigned NOT NULL COMMENT 'FK → deals_type',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deal_type_lang` (`id_deal_type`,`id_lang`),
  KEY `idx_type_lang` (`id_deal_type`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_deals_unit` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Одиниці виміру позицій угод';

CREATE TABLE IF NOT EXISTS `prefix_deals_unit_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_unit` int unsigned NOT NULL COMMENT 'FK → deals_unit',
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Штука, Година, Місяць...',
  `name_short` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'шт, год, міс...',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_unit_lang` (`id_unit`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_feeds` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `format` enum('google','prom') COLLATE utf8mb4_unicode_ci NOT NULL,
  `token` char(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `id_lang` int unsigned DEFAULT NULL,
  `currency` char(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `base_url` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `url_template` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_integration` int unsigned DEFAULT NULL,
  `image_size` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `utm` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `interval_hours` smallint unsigned NOT NULL DEFAULT '6',
  `filters` json DEFAULT NULL,
  `shop` json DEFAULT NULL,
  `last_generated_at` datetime DEFAULT NULL,
  `last_duration_ms` int unsigned DEFAULT NULL,
  `items` int unsigned DEFAULT NULL,
  `skipped` int unsigned DEFAULT NULL,
  `file_size` bigint unsigned DEFAULT NULL,
  `last_error` varchar(1024) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `report` json DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_upd` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_token` (`token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_languages` (
  `id` smallint unsigned NOT NULL AUTO_INCREMENT,
  `iso` varchar(5) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'uk, en, pl...',
  `locale` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'BCP 47: uk-UA, en-US',
  `name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `native_name` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `direction` enum('ltr','rtl') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'ltr',
  `fallback_id` smallint unsigned DEFAULT NULL,
  `active` tinyint unsigned NOT NULL DEFAULT '1',
  `is_default` tinyint unsigned DEFAULT NULL,
  `sort` smallint unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_iso` (`iso`),
  UNIQUE KEY `uq_default` (`is_default`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `title` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `note` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `id_pipeline` int unsigned DEFAULT NULL,
  `id_stage` int unsigned DEFAULT NULL,
  `id_status` int unsigned NOT NULL DEFAULT '0',
  `temperature` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'cold',
  `id_temperature` int unsigned DEFAULT NULL,
  `qualification` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'unqualified',
  `id_qualification` int unsigned DEFAULT NULL,
  `priority` tinyint unsigned NOT NULL DEFAULT '1',
  `id_priority` int unsigned DEFAULT NULL,
  `id_manager` int unsigned DEFAULT NULL,
  `id_client` int unsigned DEFAULT NULL COMMENT 'clients.id — хто залишив запит',
  `id_client_org` int unsigned DEFAULT NULL COMMENT 'clients.id — компанія, якщо запит від організації',
  `id_team` int unsigned DEFAULT NULL,
  `id_source` int unsigned DEFAULT NULL,
  `lead_source` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `website` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `capture_type` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual',
  `capture_ref` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `contact_info` json DEFAULT NULL,
  `utm` json DEFAULT NULL,
  `fingerprint` json DEFAULT NULL,
  `custom_fields` json DEFAULT NULL,
  `products` json DEFAULT NULL,
  `score_fit` smallint NOT NULL DEFAULT '0',
  `score_activity` smallint NOT NULL DEFAULT '0',
  `score` smallint NOT NULL DEFAULT '0',
  `grade` varchar(1) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'D',
  `score_decay_at` datetime DEFAULT NULL,
  `score_at` datetime DEFAULT NULL,
  `expected_close_date` date DEFAULT NULL,
  `response_deadline` datetime DEFAULT NULL,
  `first_response_at` datetime DEFAULT NULL,
  `id_loss_reason` int unsigned DEFAULT NULL,
  `loss_note` text COLLATE utf8mb4_unicode_ci,
  `is_converted` tinyint unsigned NOT NULL DEFAULT '0',
  `converted_at` datetime DEFAULT NULL,
  `is_duplicate` tinyint unsigned NOT NULL DEFAULT '0',
  `id_duplicate_of` int unsigned DEFAULT NULL,
  `duplicate_method` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `deleted_at` datetime DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  `id_deleted_by` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_pipeline_stage` (`id_pipeline`,`id_stage`),
  KEY `idx_status` (`id_status`),
  KEY `idx_manager` (`id_manager`),
  KEY `idx_score` (`score`),
  KEY `idx_deleted` (`deleted_at`),
  KEY `idx_converted` (`is_converted`),
  KEY `idx_date_add` (`date_add`),
  KEY `idx_client` (`id_client`,`date_add`),
  KEY `idx_client_org` (`id_client_org`),
  KEY `idx_score_queue` (`score_at`),
  CONSTRAINT `fk_leads_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_clients` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_leads_client_org` FOREIGN KEY (`id_client_org`) REFERENCES `prefix_clients` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_activities` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_lead` int unsigned NOT NULL,
  `id_manager` int unsigned DEFAULT NULL,
  `type` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `direction` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'outbound',
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'planned',
  `subject` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `body` text COLLATE utf8mb4_unicode_ci,
  `duration_sec` int unsigned NOT NULL DEFAULT '0',
  `record_url` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_outcome` int unsigned DEFAULT NULL,
  `scheduled_at` datetime DEFAULT NULL,
  `done_at` datetime DEFAULT NULL,
  `repeat` json DEFAULT NULL,
  `deleted_at` datetime DEFAULT NULL,
  `id_deleted_by` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lead` (`id_lead`),
  KEY `idx_manager` (`id_manager`),
  KEY `idx_scheduled` (`scheduled_at`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_activity_outcomes` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `activity_type` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `color` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#cccccc',
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_type` (`activity_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_activity_outcomes_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_outcome` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_outcome_lang` (`id_outcome`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_api_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_token` int unsigned DEFAULT NULL,
  `prefix` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ip` varbinary(16) DEFAULT NULL,
  `domain` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `user_agent` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `result` enum('success','duplicate','spam','rejected') COLLATE utf8mb4_unicode_ci NOT NULL,
  `reject_reason` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `http_status` smallint unsigned DEFAULT NULL,
  `id_lead` int unsigned DEFAULT NULL,
  `payload` json DEFAULT NULL COMMENT 'що прийшло (обрізано), для розбору',
  `message` varchar(999) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_token` (`id_token`,`id`),
  KEY `idx_result_date` (`result`,`date_add`),
  KEY `idx_lead` (`id_lead`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_api_tokens` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `prefix` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `token_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `last4` varchar(4) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `allowed_domains` json DEFAULT NULL,
  `allowed_ips` json DEFAULT NULL,
  `source_check_mode` enum('any','all','off') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'any',
  `id_source` int unsigned DEFAULT NULL,
  `id_status` int unsigned DEFAULT NULL,
  `id_pipeline` int unsigned DEFAULT NULL,
  `id_stage` int unsigned DEFAULT NULL,
  `id_priority` int unsigned DEFAULT NULL,
  `id_manager` int unsigned DEFAULT NULL,
  `tags` json DEFAULT NULL,
  `field_map` json DEFAULT NULL,
  `dedupe_hours` smallint unsigned NOT NULL DEFAULT '24',
  `rate_limit` smallint unsigned NOT NULL DEFAULT '30' COMMENT 'запитів за хвилину з одного IP',
  `honeypot` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'приховане поле форми: заповнене — спам',
  `notify_manager` tinyint unsigned NOT NULL DEFAULT '1',
  `success_redirect` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'для звичайних HTML-форм',
  `note` varchar(999) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `expires_at` date DEFAULT NULL,
  `revoked_at` datetime DEFAULT NULL,
  `revoked_by` int unsigned DEFAULT NULL,
  `revoked_reason` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `usage_count` int unsigned NOT NULL DEFAULT '0',
  `error_count` int unsigned NOT NULL DEFAULT '0',
  `last_used_at` datetime DEFAULT NULL,
  `last_used_ip` varbinary(16) DEFAULT NULL,
  `last_used_domain` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL COMMENT 'хто створив',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_token_hash` (`token_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_automations` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `trigger` json NOT NULL,
  `conditions` json DEFAULT NULL,
  `actions` json NOT NULL,
  `delay_min` int unsigned NOT NULL DEFAULT '0',
  `priority` int unsigned NOT NULL DEFAULT '0',
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_automations_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_automation` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_automation_lang` (`id_automation`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_automations_log` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_automation` int unsigned NOT NULL,
  `id_lead` int unsigned NOT NULL,
  `result` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'success',
  `run_at` datetime DEFAULT NULL,
  `locked_at` datetime DEFAULT NULL,
  `depth` tinyint unsigned NOT NULL DEFAULT '0',
  `error` text COLLATE utf8mb4_unicode_ci,
  `trigger_data` json DEFAULT NULL,
  `actions_data` json DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lead` (`id_lead`),
  KEY `idx_automation` (`id_automation`),
  KEY `idx_queue` (`result`,`run_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_conversions` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_lead` int unsigned NOT NULL,
  `id_manager` int unsigned DEFAULT NULL,
  `converted_to` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `converted_id` int unsigned DEFAULT NULL,
  `snapshot` json NOT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lead` (`id_lead`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_custom_fields` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `type` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_pipeline` int unsigned DEFAULT NULL,
  `options` json DEFAULT NULL,
  `min_value` decimal(15,4) DEFAULT NULL,
  `max_value` decimal(15,4) DEFAULT NULL,
  `visibility` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'all',
  `is_required` tinyint unsigned NOT NULL DEFAULT '0',
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_pipeline` (`id_pipeline`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_custom_fields_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_field` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `hint` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_field_lang` (`id_field`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_custom_fields_stage` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_field` int unsigned NOT NULL,
  `id_stage` int unsigned NOT NULL,
  `is_required` tinyint unsigned NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_field_stage` (`id_field`,`id_stage`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_duplicates` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_lead` int unsigned NOT NULL,
  `id_lead_orig` int unsigned NOT NULL,
  `method` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `id_manager` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lead` (`id_lead`),
  KEY `idx_orig` (`id_lead_orig`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_email_templates` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_email_templates_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_template` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `subject` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `body` text COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_template_lang` (`id_template`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_files` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_lead` int unsigned NOT NULL,
  `id_manager` int unsigned DEFAULT NULL,
  `category` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'other',
  `name` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `path` varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `mime` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `size` int unsigned NOT NULL DEFAULT '0',
  `deleted_at` datetime DEFAULT NULL,
  `id_deleted_by` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lead` (`id_lead`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_history` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_lead` int unsigned NOT NULL,
  `id_manager` int unsigned DEFAULT NULL,
  `action_type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `field_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `value_old` text COLLATE utf8mb4_unicode_ci,
  `value_new` text COLLATE utf8mb4_unicode_ci,
  `comment` text COLLATE utf8mb4_unicode_ci,
  `is_pinned` tinyint unsigned NOT NULL DEFAULT '0',
  `source` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'web',
  `ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lead` (`id_lead`),
  KEY `idx_action` (`action_type`),
  KEY `idx_manager` (`id_manager`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_imports` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_user` int unsigned NOT NULL,
  `file_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `file_path` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` enum('uploaded','running','done','failed','canceled') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'uploaded',
  `headers` json DEFAULT NULL,
  `mapping` json DEFAULT NULL,
  `options` json DEFAULT NULL,
  `total` int unsigned NOT NULL DEFAULT '0',
  `processed` int unsigned NOT NULL DEFAULT '0',
  `created` int unsigned NOT NULL DEFAULT '0',
  `matched` int unsigned NOT NULL DEFAULT '0',
  `skipped` int unsigned NOT NULL DEFAULT '0',
  `errors` json DEFAULT NULL,
  `error` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  `date_start` datetime DEFAULT NULL,
  `date_end` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user` (`id_user`,`id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_loss_reasons` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_loss_reasons_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_reason` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reason_lang` (`id_reason`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_pipeline_stages` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_pipeline` int unsigned NOT NULL,
  `color` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#cccccc',
  `icon` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `system_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'regular',
  `probability` tinyint unsigned NOT NULL DEFAULT '0',
  `sla_hours` smallint unsigned NOT NULL DEFAULT '0',
  `required_fields` json DEFAULT NULL,
  `auto_actions` json DEFAULT NULL,
  `lock_back` tinyint unsigned NOT NULL DEFAULT '0',
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_pipeline` (`id_pipeline`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_pipeline_stages_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_stage` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_stage_lang` (`id_stage`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_pipelines` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `is_default` tinyint unsigned NOT NULL DEFAULT '0',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_pipelines_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_pipeline` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pipeline_lang` (`id_pipeline`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_priorities` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `color_text` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `color_background` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#6c757d',
  `icon` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_priorities_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_priority` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_priority_lang` (`id_priority`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_qualifications` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `slug` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `color_text` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `color_background` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#6c757d',
  `icon` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_qualifications_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_qualification` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_qual_lang` (`id_qualification`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_reminders` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_lead` int unsigned NOT NULL,
  `id_activity` int unsigned DEFAULT NULL,
  `id_manager` int unsigned DEFAULT NULL,
  `id_team` int unsigned DEFAULT NULL,
  `text` varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `remind_at` datetime NOT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `sent_at` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lead` (`id_lead`),
  KEY `idx_remind_at` (`remind_at`),
  KEY `idx_status` (`status`),
  KEY `idx_activity` (`id_activity`),
  KEY `idx_queue` (`status`,`remind_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_routing_rules` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `conditions` json NOT NULL,
  `id_pipeline` int unsigned DEFAULT NULL,
  `id_stage` int unsigned DEFAULT NULL,
  `id_manager` int unsigned DEFAULT NULL,
  `id_team` int unsigned DEFAULT NULL,
  `assign_mode` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'fixed',
  `priority` int unsigned NOT NULL DEFAULT '0',
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_routing_rules_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_rule` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_routing_lang` (`id_rule`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_score_log` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_lead` int unsigned NOT NULL,
  `id_rule` int unsigned DEFAULT NULL,
  `id_manager` int unsigned DEFAULT NULL,
  `score_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'fit',
  `delta` smallint NOT NULL DEFAULT '0',
  `score_after` smallint NOT NULL DEFAULT '0',
  `reason` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lead` (`id_lead`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_score_rules` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `score_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'fit',
  `condition` json NOT NULL,
  `score_delta` smallint NOT NULL DEFAULT '0',
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_score_rules_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_rule` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rule_lang` (`id_rule`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_segments` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `rules` json NOT NULL,
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_segments_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_segment` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_segment_lang` (`id_segment`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_segments_rel` (
  `id_segment` int unsigned NOT NULL,
  `id_lead` int unsigned NOT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id_segment`,`id_lead`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_settings_status` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `color_text` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `color_background` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#999999',
  `icon` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `note` varchar(999) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `system_type` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `is_default` tinyint unsigned NOT NULL DEFAULT '0',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_settings_status_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_status` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_status_lang` (`id_status`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_sla_log` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_lead` int unsigned NOT NULL,
  `id_sla_rule` int unsigned DEFAULT NULL,
  `breach_type` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `deadline_at` datetime NOT NULL,
  `breached_at` datetime NOT NULL,
  `overdue_min` int unsigned NOT NULL DEFAULT '0',
  `id_manager` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lead` (`id_lead`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_sla_rules` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_pipeline` int unsigned DEFAULT NULL,
  `id_stage` int unsigned DEFAULT NULL,
  `response_hours` smallint unsigned NOT NULL DEFAULT '0',
  `stage_hours` smallint unsigned NOT NULL DEFAULT '0',
  `breach_actions` json DEFAULT NULL,
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_pipeline` (`id_pipeline`),
  KEY `idx_stage` (`id_stage`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_sla_rules_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_sla_rule` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sla_rule_lang` (`id_sla_rule`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_sources` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_sources_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_source` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_source_lang` (`id_source`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_tags` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `color` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#cccccc',
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_tags_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_tag` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tag_lang` (`id_tag`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_tags_rel` (
  `id_lead` int unsigned NOT NULL,
  `id_tag` int unsigned NOT NULL,
  PRIMARY KEY (`id_lead`,`id_tag`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_temperatures` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `slug` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `color_text` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `color_background` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#6c757d',
  `icon` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `sort` int unsigned NOT NULL DEFAULT '0',
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_temperatures_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_temperature` int unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_temp_lang` (`id_temperature`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_webhooks` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `url` varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL,
  `events` json NOT NULL,
  `method` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'POST',
  `headers` json DEFAULT NULL,
  `secret` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `note` varchar(999) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `last_status` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_sent_at` datetime DEFAULT NULL,
  `fail_count` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_leads_webhooks_log` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_webhook` int unsigned NOT NULL,
  `id_lead` int unsigned DEFAULT NULL,
  `event` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `payload` json DEFAULT NULL,
  `response_code` smallint unsigned DEFAULT NULL,
  `response_body` text COLLATE utf8mb4_unicode_ci,
  `error` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `result` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `attempt` tinyint unsigned NOT NULL DEFAULT '1',
  `next_attempt_at` datetime DEFAULT NULL,
  `locked_at` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_sent` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_webhook` (`id_webhook`),
  KEY `idx_lead` (`id_lead`),
  KEY `idx_result` (`result`),
  KEY `idx_queue` (`result`,`next_attempt_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_mail_accounts` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Назва акаунту',
  `description` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Опис призначення',
  `is_default` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Акаунт за замовчуванням',
  `is_enabled` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'Відправлення увімкнено',
  `driver` enum('smtp','sendmail','mailgun','ses') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'smtp',
  `host` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `port` smallint unsigned NOT NULL DEFAULT '587',
  `encryption` enum('tls','ssl','none') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'tls',
  `verify_ssl` tinyint(1) NOT NULL DEFAULT '1',
  `timeout` smallint unsigned NOT NULL DEFAULT '30' COMMENT 'Секунди',
  `username` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `password` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Зберігати зашифрованим',
  `from_email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `from_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `reply_to` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `bounce_address` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Return-Path',
  `log_enabled` tinyint(1) NOT NULL DEFAULT '1',
  `log_level` enum('all','errors') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'all',
  `log_retention` smallint unsigned NOT NULL DEFAULT '30' COMMENT 'Днів',
  `queue_enabled` tinyint(1) NOT NULL DEFAULT '0',
  `retry_count` tinyint unsigned NOT NULL DEFAULT '3',
  `retry_delay` smallint unsigned NOT NULL DEFAULT '60' COMMENT 'Секунди',
  `rate_per_hour` smallint unsigned NOT NULL DEFAULT '500',
  `send_delay_ms` smallint unsigned NOT NULL DEFAULT '100' COMMENT 'Мс між листами',
  `charset` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'utf-8',
  `content_type` enum('text/html','text/plain','both') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'text/html',
  `connection_status` tinyint(1) DEFAULT NULL COMMENT '1=OK, 0=Помилка, NULL=не перевірялось',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_enabled` (`is_enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Поштові акаунти CRM';

CREATE TABLE IF NOT EXISTS `prefix_mailing_automation_runs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_automation` int unsigned NOT NULL,
  `id_contact` int unsigned NOT NULL,
  `id_step` int unsigned DEFAULT NULL,
  `status` enum('active','completed','exited') NOT NULL DEFAULT 'active',
  `exit_reason` varchar(32) DEFAULT NULL COMMENT 'audience|goal|condition|manual|deleted',
  `date_next` datetime DEFAULT NULL,
  `date_start` datetime NOT NULL,
  `date_end` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_due` (`status`,`date_next`),
  KEY `idx_automation_contact` (`id_automation`,`id_contact`,`status`),
  KEY `idx_automation_status` (`id_automation`,`status`,`id_step`),
  KEY `fk_mar_contact` (`id_contact`),
  CONSTRAINT `fk_mar_automation` FOREIGN KEY (`id_automation`) REFERENCES `prefix_mailing_automations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mar_contact` FOREIGN KEY (`id_contact`) REFERENCES `prefix_mailing_contacts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_automation_steps` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_automation` int unsigned NOT NULL,
  `sort_order` smallint unsigned NOT NULL DEFAULT '0',
  `type` enum('email','wait','condition') NOT NULL,
  `config` json DEFAULT NULL COMMENT 'wait {amount, unit} | condition {check, ref_step, segment, if_true, if_false}',
  `id_campaign` int unsigned DEFAULT NULL COMMENT 'email: прихована кампанія type=automation',
  `deleted` tinyint(1) NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_automation` (`id_automation`,`deleted`,`sort_order`),
  CONSTRAINT `fk_mas_automation` FOREIGN KEY (`id_automation`) REFERENCES `prefix_mailing_automations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_automations` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `status` enum('draft','active','paused') NOT NULL DEFAULT 'draft',
  `trigger_type` enum('list_subscribe','date_field','inactive','manual') NOT NULL DEFAULT 'list_subscribe',
  `trigger_config` json DEFAULT NULL COMMENT 'list_subscribe {id_list} | date_field {field, offset_days, hour} | inactive {days, hour}',
  `audience` json DEFAULT NULL COMMENT 'Фільтр входу: {lists, exclude_lists, exclude_role, segment}',
  `goal` json DEFAULT NULL COMMENT 'Сегмент мети: контакт, що потрапив у нього, виходить з ланцюжка',
  `id_sender` int unsigned DEFAULT NULL,
  `track_opens` tinyint(1) NOT NULL DEFAULT '1',
  `track_clicks` tinyint(1) NOT NULL DEFAULT '1',
  `utm` json DEFAULT NULL,
  `include_existing` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'list_subscribe: також ті, хто підписався до запуску',
  `allow_reentry` tinyint(1) NOT NULL DEFAULT '0',
  `reentry_days` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Мінімум днів між входами',
  `date_trigger_from` datetime DEFAULT NULL COMMENT 'UTC; list_subscribe: підписки, починаючи з цієї дати',
  `date_last_enroll` datetime DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `id_user_activated` int unsigned DEFAULT NULL,
  `date_activated` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime DEFAULT NULL,
  `deleted` tinyint(1) NOT NULL DEFAULT '0',
  `date_deleted` datetime DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_status` (`status`,`deleted`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_campaign_variants` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_campaign` int unsigned NOT NULL,
  `code` char(1) NOT NULL DEFAULT 'A',
  `from_name` varchar(128) DEFAULT NULL COMMENT 'Перевизначення відправника для A/B',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_campaign_code` (`id_campaign`,`code`),
  CONSTRAINT `fk_mcv_campaign` FOREIGN KEY (`id_campaign`) REFERENCES `prefix_mailing_campaigns` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_campaigns` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `type` enum('regular','ab','resend','automation') NOT NULL DEFAULT 'regular',
  `status` enum('draft','scheduled','preparing','sending','paused','sent','cancelled','failed') NOT NULL DEFAULT 'draft',
  `id_sender` int unsigned DEFAULT NULL,
  `id_parent` int unsigned DEFAULT NULL COMMENT 'Для resend — вихідна кампанія',
  `id_automation` int unsigned DEFAULT NULL,
  `audience` json DEFAULT NULL COMMENT '{lists:[], segment:{...}, exclude_lists:[], exclude_campaigns:[]}',
  `send_mode` enum('now','scheduled','timezone') NOT NULL DEFAULT 'now',
  `date_scheduled` datetime DEFAULT NULL COMMENT 'UTC; для timezone — локальний час отримувача',
  `ab_percent` tinyint unsigned DEFAULT NULL COMMENT '% аудиторії на тест',
  `ab_metric` enum('open','click') DEFAULT NULL,
  `ab_wait_minutes` int unsigned DEFAULT NULL,
  `id_variant_winner` int unsigned DEFAULT NULL,
  `date_ab_decided` datetime DEFAULT NULL,
  `track_opens` tinyint(1) NOT NULL DEFAULT '1',
  `track_clicks` tinyint(1) NOT NULL DEFAULT '1',
  `utm` json DEFAULT NULL COMMENT '{source,medium,campaign,content}',
  `ignore_frequency_cap` tinyint(1) NOT NULL DEFAULT '0',
  `cnt_total` int unsigned NOT NULL DEFAULT '0',
  `cnt_sent` int unsigned NOT NULL DEFAULT '0',
  `cnt_failed` int unsigned NOT NULL DEFAULT '0',
  `cnt_skipped` int unsigned NOT NULL DEFAULT '0',
  `cnt_bounced` int unsigned NOT NULL DEFAULT '0',
  `cnt_opened` int unsigned NOT NULL DEFAULT '0',
  `cnt_opened_human` int unsigned NOT NULL DEFAULT '0',
  `cnt_clicked` int unsigned NOT NULL DEFAULT '0',
  `cnt_complained` int unsigned NOT NULL DEFAULT '0',
  `cnt_unsubscribed` int unsigned NOT NULL DEFAULT '0',
  `id_user` int unsigned DEFAULT NULL,
  `id_user_launched` int unsigned DEFAULT NULL,
  `date_launched` datetime DEFAULT NULL,
  `date_finished` datetime DEFAULT NULL,
  `date_stats` datetime DEFAULT NULL,
  `last_error` varchar(1024) DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime DEFAULT NULL,
  `deleted` tinyint(1) NOT NULL DEFAULT '0',
  `date_deleted` datetime DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_status_sched` (`status`,`date_scheduled`),
  KEY `idx_parent` (`id_parent`),
  KEY `idx_automation` (`id_automation`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_consents` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_contact` int unsigned NOT NULL,
  `id_list` int unsigned DEFAULT NULL,
  `action` enum('subscribe','confirm','unsubscribe','unsubscribe_all','resubscribe','import','erase') NOT NULL,
  `source` varchar(64) NOT NULL COMMENT 'form|import:{id}|one_click|preference_center|mailto|manual|admin',
  `ip` varbinary(16) DEFAULT NULL,
  `user_agent` varchar(512) DEFAULT NULL,
  `id_message` bigint unsigned DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `note` varchar(512) DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_contact` (`id_contact`,`date_add`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_contacts` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `email` varchar(254) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  `email_domain` varchar(253) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  `id_client` int unsigned DEFAULT NULL,
  `first_name` varchar(128) DEFAULT NULL,
  `last_name` varchar(128) DEFAULT NULL,
  `id_lang` tinyint unsigned NOT NULL DEFAULT '1',
  `timezone` varchar(64) DEFAULT NULL,
  `country` char(2) DEFAULT NULL,
  `status` enum('active','unsubscribed','bounced','complained','cleaned') NOT NULL DEFAULT 'active',
  `fields` json DEFAULT NULL COMMENT 'Довільні поля з імпорту, ключі = mailing_fields.code',
  `is_role` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'info@, sales@ ...',
  `source` varchar(32) NOT NULL DEFAULT 'manual' COMMENT 'manual|import|form|client|api',
  `id_import` int unsigned DEFAULT NULL,
  `soft_bounces` tinyint unsigned NOT NULL DEFAULT '0',
  `date_last_sent` datetime DEFAULT NULL,
  `date_last_open` datetime DEFAULT NULL COMMENT 'Тільки реальні (не машинні) відкриття',
  `date_last_click` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime DEFAULT NULL,
  `deleted` tinyint(1) NOT NULL DEFAULT '0',
  `date_deleted` datetime DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_email` (`email`),
  KEY `idx_client` (`id_client`),
  KEY `idx_status` (`status`,`deleted`),
  KEY `idx_domain` (`email_domain`),
  KEY `idx_engagement` (`date_last_open`,`date_last_click`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_contents` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `owner_type` enum('template','variant') NOT NULL,
  `id_owner` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `subject` varchar(255) NOT NULL DEFAULT '',
  `preheader` varchar(255) DEFAULT NULL,
  `editor` enum('visual','html') NOT NULL DEFAULT 'visual',
  `project` json DEFAULT NULL COMMENT 'Стан GrapesJS',
  `source` mediumtext COMMENT 'MJML (visual) або вставлений HTML',
  `html` mediumtext COMMENT 'Скомпільований, очищений, CSS інлайн',
  `text` mediumtext,
  `size_bytes` int unsigned NOT NULL DEFAULT '0',
  `warnings` json DEFAULT NULL COMMENT 'Результат валідації',
  `date_edit` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_owner_lang` (`owner_type`,`id_owner`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_domains` (
  `domain` varchar(253) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  `mx_ok` tinyint(1) NOT NULL,
  `disposable` tinyint(1) NOT NULL DEFAULT '0',
  `date_check` datetime NOT NULL,
  PRIMARY KEY (`domain`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_events` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_message` bigint unsigned DEFAULT NULL,
  `id_campaign` int unsigned DEFAULT NULL,
  `id_contact` int unsigned DEFAULT NULL,
  `type` enum('open','click','bounce','complaint','unsubscribe','reply') NOT NULL,
  `id_link` int unsigned DEFAULT NULL,
  `is_machine` tinyint(1) NOT NULL DEFAULT '0',
  `machine_reason` varchar(32) DEFAULT NULL COMMENT 'apple_mpp|proxy|scanner_fast|scanner_ip|head|all_links',
  `ip` varbinary(16) DEFAULT NULL,
  `user_agent` varchar(512) DEFAULT NULL,
  `device` varchar(16) DEFAULT NULL COMMENT 'desktop|mobile|tablet',
  `mail_client` varchar(32) DEFAULT NULL COMMENT 'gmail|apple_mail|outlook|...',
  `country` char(2) DEFAULT NULL,
  `meta` json DEFAULT NULL COMMENT 'bounce: {code, status, diagnostic}',
  `date_add` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_campaign_type` (`id_campaign`,`type`,`is_machine`),
  KEY `idx_contact` (`id_contact`,`date_add`),
  KEY `idx_message` (`id_message`,`type`,`date_add`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_fields` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL COMMENT 'Ключ у contacts.fields і merge-тег {{code}}',
  `name` varchar(128) NOT NULL,
  `type` enum('text','number','date','bool') NOT NULL DEFAULT 'text',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_imports` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_user` int unsigned DEFAULT NULL,
  `file_name` varchar(255) NOT NULL,
  `file_path` varchar(512) NOT NULL,
  `status` enum('uploaded','queued','processing','done','failed','cancelled') NOT NULL DEFAULT 'uploaded',
  `mapping` json DEFAULT NULL COMMENT '{колонка_файлу: поле}',
  `options` json DEFAULT NULL COMMENT '{lists:[], consent_source, update_existing, create_clients, id_lang}',
  `rows_total` int unsigned NOT NULL DEFAULT '0',
  `rows_processed` int unsigned NOT NULL DEFAULT '0',
  `cnt_created` int unsigned NOT NULL DEFAULT '0',
  `cnt_updated` int unsigned NOT NULL DEFAULT '0',
  `cnt_skipped` int unsigned NOT NULL DEFAULT '0',
  `cnt_invalid` int unsigned NOT NULL DEFAULT '0',
  `cnt_suppressed` int unsigned NOT NULL DEFAULT '0',
  `errors_path` varchar(512) DEFAULT NULL COMMENT 'CSV з відхиленими рядками',
  `error_message` varchar(1024) DEFAULT NULL,
  `locked_by` varchar(64) DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_start` datetime DEFAULT NULL,
  `date_finish` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_links` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_campaign` int unsigned NOT NULL,
  `url_hash` binary(20) NOT NULL COMMENT 'SHA1(url)',
  `url` text NOT NULL,
  `cnt_clicks` int unsigned NOT NULL DEFAULT '0',
  `cnt_clicks_unique` int unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_campaign_url` (`id_campaign`,`url_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_lists` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) NOT NULL,
  `is_public` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'Показувати в preference center',
  `double_optin` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime DEFAULT NULL,
  `deleted` tinyint(1) NOT NULL DEFAULT '0',
  `date_deleted` datetime DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_lists_lang` (
  `id_list` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `name` varchar(128) NOT NULL,
  `description` varchar(512) DEFAULT NULL,
  PRIMARY KEY (`id_list`,`id_lang`),
  CONSTRAINT `fk_mll_list` FOREIGN KEY (`id_list`) REFERENCES `prefix_mailing_lists` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_messages` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_campaign` int unsigned NOT NULL,
  `id_variant` int unsigned DEFAULT NULL COMMENT 'NULL = ще не призначено (A/B: решта аудиторії чекає переможця)',
  `id_contact` int unsigned NOT NULL,
  `id_sender` int unsigned NOT NULL,
  `ref_key` varchar(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL DEFAULT '' COMMENT 'Для автоматизацій: дозволяє кілька листів одній людині в межах кампанії',
  `email` varchar(254) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  `email_domain` varchar(253) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `status` enum('waiting','queued','sending','sent','failed','bounced','skipped','cancelled') NOT NULL DEFAULT 'queued',
  `skip_reason` varchar(32) DEFAULT NULL COMMENT 'suppressed|unsubscribed|frequency_cap|invalid|duplicate',
  `attempts` tinyint unsigned NOT NULL DEFAULT '0',
  `date_next_attempt` datetime NOT NULL,
  `locked_by` varchar(64) DEFAULT NULL,
  `date_locked` datetime DEFAULT NULL,
  `message_id` varchar(255) CHARACTER SET ascii COLLATE ascii_general_ci DEFAULT NULL COMMENT 'SMTP Message-ID',
  `smtp_response` varchar(512) DEFAULT NULL,
  `bounce_type` enum('soft','hard') DEFAULT NULL,
  `date_sent` datetime DEFAULT NULL,
  `date_first_open` datetime DEFAULT NULL,
  `date_first_open_human` datetime DEFAULT NULL,
  `cnt_opens` smallint unsigned NOT NULL DEFAULT '0',
  `date_first_click` datetime DEFAULT NULL,
  `cnt_clicks` smallint unsigned NOT NULL DEFAULT '0',
  `date_unsubscribed` datetime DEFAULT NULL,
  `date_complained` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_campaign_contact` (`id_campaign`,`id_contact`,`ref_key`),
  KEY `idx_queue` (`status`,`date_next_attempt`),
  KEY `idx_campaign_status` (`id_campaign`,`status`),
  KEY `idx_contact_sent` (`id_contact`,`date_sent`),
  KEY `idx_message_id` (`message_id`),
  KEY `idx_sender_sent` (`id_sender`,`date_sent`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_senders` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(128) NOT NULL COMMENT 'Внутрішня назва',
  `provider` varchar(32) NOT NULL DEFAULT 'smtp',
  `from_name` varchar(128) NOT NULL,
  `from_email` varchar(254) NOT NULL,
  `reply_to` varchar(254) DEFAULT NULL,
  `company_address` varchar(512) DEFAULT NULL COMMENT 'Фізична адреса у футері (вимога законів про розсилки)',
  `smtp_host` varchar(255) NOT NULL,
  `smtp_port` smallint unsigned NOT NULL DEFAULT '587',
  `smtp_secure` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = SSL (465), 0 = STARTTLS',
  `smtp_user` varchar(255) NOT NULL,
  `smtp_pass_enc` varbinary(1024) NOT NULL,
  `smtp_max_connections` tinyint unsigned NOT NULL DEFAULT '3',
  `bounce_address` varchar(254) DEFAULT NULL COMMENT 'bounce@domain → VERP bounce+{token}@domain',
  `dkim_selector` varchar(63) DEFAULT NULL,
  `imap_host` varchar(255) DEFAULT NULL,
  `imap_port` smallint unsigned DEFAULT '993',
  `imap_user` varchar(255) DEFAULT NULL,
  `imap_pass_enc` varbinary(1024) DEFAULT NULL,
  `imap_mailbox` varchar(128) NOT NULL DEFAULT 'INBOX',
  `rate_per_minute` int unsigned NOT NULL DEFAULT '60',
  `daily_limit` int unsigned NOT NULL DEFAULT '0' COMMENT '0 = без ліміту',
  `warmup_start` date DEFAULT NULL COMMENT 'Якщо задано — денний ліміт росте поступово',
  `domain_limits` json DEFAULT NULL COMMENT '{"gmail.com":30,"outlook.com":20} — листів/хв на домен',
  `dns_check` json DEFAULT NULL COMMENT 'Останній результат SPF/DKIM/DMARC',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime DEFAULT NULL,
  `deleted` tinyint(1) NOT NULL DEFAULT '0',
  `date_deleted` datetime DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_settings` (
  `key` varchar(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  `value` json NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_subscriptions` (
  `id_contact` int unsigned NOT NULL,
  `id_list` int unsigned NOT NULL,
  `status` enum('pending','subscribed','unsubscribed') NOT NULL,
  `source` varchar(32) NOT NULL DEFAULT 'manual',
  `date_subscribed` datetime DEFAULT NULL,
  `date_confirmed` datetime DEFAULT NULL,
  `date_unsubscribed` datetime DEFAULT NULL,
  PRIMARY KEY (`id_contact`,`id_list`),
  KEY `idx_list_status` (`id_list`,`status`),
  CONSTRAINT `fk_ms_contact` FOREIGN KEY (`id_contact`) REFERENCES `prefix_mailing_contacts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ms_list` FOREIGN KEY (`id_list`) REFERENCES `prefix_mailing_lists` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_suppressions` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `type` enum('email','domain') NOT NULL,
  `value` varchar(254) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  `reason` enum('hard_bounce','complaint','unsubscribe_all','manual','invalid') NOT NULL,
  `id_message` bigint unsigned DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `note` varchar(512) DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_type_value` (`type`,`value`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_mailing_templates` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime DEFAULT NULL,
  `deleted` tinyint(1) NOT NULL DEFAULT '0',
  `date_deleted` datetime DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `prefix_manager_push_subs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `id_manager` int unsigned NOT NULL,
  `endpoint` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `p256dh` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `auth` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_agent` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime DEFAULT NULL,
  `date_last_ok` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_endpoint` (`endpoint`),
  KEY `k_manager` (`id_manager`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_checkbox_chains` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_order` int unsigned NOT NULL,
  `id_register` int unsigned NOT NULL,
  `relation_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'номер ланцюжка в Checkbox (наш custom_relation_id)',
  `status` varchar(24) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'PARTIAL_PAID' COMMENT 'PARTIAL_PAID, FULL_PAID, CANCELLED, PARTIAL_CANCELLED',
  `total` int NOT NULL DEFAULT '0' COMMENT 'копійки — сума товарів ланцюжка',
  `paid` int NOT NULL DEFAULT '0',
  `left_to_pay` int NOT NULL DEFAULT '0',
  `raw` json DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_relation` (`relation_id`),
  KEY `idx_order` (`id_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_checkbox_ettn` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_order` int unsigned NOT NULL,
  `id_register` int unsigned NOT NULL,
  `id_shipment` int unsigned DEFAULT NULL,
  `ttn` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ettn_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'id замовлення ЕТТН у Checkbox',
  `status` varchar(24) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'CREATED',
  `total` int NOT NULL DEFAULT '0' COMMENT 'копійки — має дорівнювати сумі контролю оплати в ТТН',
  `receipt_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'чек, виданий Checkbox при отриманні',
  `return_receipt_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `error` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `raw` json DEFAULT NULL,
  `last_check` datetime DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ttn` (`ttn`),
  KEY `idx_order` (`id_order`),
  KEY `idx_open` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_checkbox_events` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_register` int unsigned DEFAULT NULL,
  `id_order` int unsigned DEFAULT NULL,
  `type` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'shift_open, shift_close, receipt, return, ettn, x_report, error …',
  `payload` json DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_register` (`id_register`,`id`),
  KEY `idx_order` (`id_order`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_checkbox_receipts` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_order` int unsigned DEFAULT NULL,
  `id_register` int unsigned NOT NULL,
  `receipt_id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'UUID чека (задаємо самі — повтор запиту не створить другий чек)',
  `type` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'SELL, RETURN, SERVICE_IN, SERVICE_OUT',
  `chain` varchar(8) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'pre — чек передплати; after — чек післяплати; NULL — звичайний',
  `id_chain` int unsigned DEFAULT NULL,
  `status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'CREATED',
  `total` int NOT NULL DEFAULT '0' COMMENT 'копійки',
  `payment_type` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'CASH, CASHLESS',
  `serial` int unsigned DEFAULT NULL,
  `fiscal_code` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `fiscal_date` datetime DEFAULT NULL,
  `tax_url` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `related_id` int unsigned DEFAULT NULL COMMENT 'чек продажу, до якого повернення',
  `id_refund` int unsigned DEFAULT NULL COMMENT 'orders_refunds.id',
  `source` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual' COMMENT 'manual, auto, ettn, service',
  `error` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payload` json DEFAULT NULL COMMENT 'що відправлено в Checkbox',
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_receipt` (`receipt_id`),
  KEY `idx_order` (`id_order`),
  KEY `idx_open` (`status`,`date_add`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_checkbox_registers` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `test` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 — тестовий сервер dev-api.checkbox.in.ua',
  `license_cipher` varbinary(512) DEFAULT NULL,
  `license_iv` varbinary(16) DEFAULT NULL,
  `license_tag` varbinary(16) DEFAULT NULL,
  `license_last4` char(4) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `pin_cipher` varbinary(128) DEFAULT NULL,
  `pin_iv` varbinary(16) DEFAULT NULL,
  `pin_tag` varbinary(16) DEFAULT NULL,
  `token_cipher` varbinary(4096) DEFAULT NULL COMMENT 'JWT касира, оновлюється при 401',
  `token_iv` varbinary(16) DEFAULT NULL,
  `token_tag` varbinary(16) DEFAULT NULL,
  `token_at` datetime DEFAULT NULL,
  `webhook_cipher` varbinary(256) DEFAULT NULL,
  `webhook_iv` varbinary(16) DEFAULT NULL,
  `webhook_tag` varbinary(16) DEFAULT NULL,
  `webhook_at` datetime DEFAULT NULL COMMENT 'коли підключено вебхук',
  `online_pending` datetime DEFAULT NULL COMMENT 'з якого часу повертаємо касу в онлайн',
  `online_try` datetime DEFAULT NULL COMMENT 'останній запит go-online',
  `cash_register_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `fiscal_number` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `cashier_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `settings` json DEFAULT NULL COMMENT 'податки, доставка чека, зміни, ЕТТН, тексти',
  `integrations` json DEFAULT NULL COMMENT 'id інтеграцій (магазинів), для яких каса за замовчуванням',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_monobank_accounts` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `token_cipher` varbinary(512) DEFAULT NULL,
  `token_iv` varbinary(16) DEFAULT NULL,
  `token_tag` varbinary(16) DEFAULT NULL,
  `token_last4` char(4) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `merchant_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `merchant_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `settings` json DEFAULT NULL COMMENT 'тип оплати, термін дії, статуси замовлення, призначення платежу',
  `integrations` json DEFAULT NULL COMMENT 'id інтеграцій (магазинів), для яких акаунт за замовчуванням',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_monobank_cards` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_account` int unsigned NOT NULL,
  `id_client` int unsigned DEFAULT NULL,
  `wallet_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `token_cipher` varbinary(512) NOT NULL,
  `token_iv` varbinary(16) NOT NULL,
  `token_tag` varbinary(16) NOT NULL,
  `token_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'SHA-256 токена — унікальність без розшифрування',
  `masked_pan` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `country` varchar(8) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'created' COMMENT 'new, created, failed, deleted',
  `id_invoice` int unsigned DEFAULT NULL COMMENT 'рахунок, під час оплати якого збережено',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_token` (`id_account`,`token_hash`),
  KEY `idx_wallet` (`id_account`,`wallet_id`),
  KEY `idx_client` (`id_client`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_monobank_events` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_invoice` int unsigned DEFAULT NULL,
  `id_order` int unsigned DEFAULT NULL,
  `type` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'created, copied, webhook, reconcile, finalized, removed, error',
  `status` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payload` json DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_invoice` (`id_invoice`,`id`),
  KEY `idx_order` (`id_order`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_monobank_invoices` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_order` int unsigned NOT NULL,
  `id_account` int unsigned NOT NULL,
  `source` enum('link','statement','qr','wallet') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'link',
  `qr_id` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'QR-каса, на яку виставлено суму',
  `invoice_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `page_url` varchar(512) COLLATE utf8mb4_unicode_ci NOT NULL,
  `amount` int unsigned NOT NULL COMMENT 'копійки',
  `final_amount` int unsigned DEFAULT NULL COMMENT 'копійки, фактично списано',
  `ccy` smallint unsigned NOT NULL DEFAULT '980',
  `payment_type` enum('debit','hold','verification') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'debit',
  `status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'created',
  `failure_reason` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payment_info` json DEFAULT NULL COMMENT 'картка, спосіб оплати, банк, RRN, код авторизації',
  `fee` int unsigned DEFAULT NULL COMMENT 'комісія еквайрингу, копійки',
  `basket` json DEFAULT NULL COMMENT 'склад чека, як передано в Monobank',
  `modified_at` datetime(3) DEFAULT NULL COMMENT 'modifiedDate від Monobank — захист від старих вебхуків',
  `expires_at` datetime DEFAULT NULL,
  `hold_until` datetime DEFAULT NULL COMMENT 'кінець холду (9 днів), далі банк сам знімає блокування',
  `paid_at` datetime DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_invoice` (`invoice_id`),
  KEY `idx_order` (`id_order`),
  KEY `idx_open` (`status`,`date_add`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_monobank_qr` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_account` int unsigned NOT NULL,
  `qr_id` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `short_qr_id` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `amount_type` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'merchant — суму ставить магазин; client — вводить клієнт; fix — фіксована',
  `page_url` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `name` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'назва каси в системі (наприклад, «Офіс»)',
  `active` tinyint(1) NOT NULL DEFAULT '1' COMMENT '0 — каси вже немає в банку',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_qr` (`id_account`,`qr_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_monobank_refunds` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_invoice` int unsigned NOT NULL,
  `id_order` int unsigned NOT NULL,
  `id_refund` int unsigned DEFAULT NULL COMMENT 'orders_refunds.id; NULL — скасування холду',
  `ext_ref` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `amount` int unsigned NOT NULL COMMENT 'копійки',
  `status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'processing' COMMENT 'processing, success, failure',
  `items` json DEFAULT NULL COMMENT 'позиції для фіскального чека повернення',
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ext` (`id_invoice`,`ext_ref`),
  KEY `idx_order` (`id_order`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_monobank_statement` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_account` int unsigned NOT NULL,
  `invoice_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `date` datetime NOT NULL COMMENT 'дата фінансової операції',
  `amount` int unsigned NOT NULL COMMENT 'копійки',
  `refunded` int unsigned NOT NULL DEFAULT '0' COMMENT 'сума повернень із cancelList, копійки',
  `profit_amount` int unsigned DEFAULT NULL COMMENT 'до зарахування після розрахунку банку, копійки',
  `ccy` smallint unsigned NOT NULL DEFAULT '980',
  `masked_pan` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `reference` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `destination` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `approval_code` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `rrn` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payment_scheme` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'full, bnpl_parts_4, bnpl_later_30',
  `short_qr_id` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `cancel_list` json DEFAULT NULL,
  `id_order` int unsigned DEFAULT NULL,
  `id_invoice` int unsigned DEFAULT NULL,
  `match_type` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'invoice — посилання системи; auto — за номером і сумою; manual — вручну; none — відв’язано вручну',
  `id_user` int unsigned DEFAULT NULL COMMENT 'хто прив’язав / відв’язав',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_invoice` (`id_account`,`invoice_id`),
  KEY `idx_date` (`date`),
  KEY `idx_order` (`id_order`),
  KEY `idx_unmatched` (`match_type`,`status`,`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_monobank_sync` (
  `id_account` int unsigned NOT NULL,
  `synced_from` datetime DEFAULT NULL COMMENT 'з якої дати виписка завантажена',
  `synced_to` datetime DEFAULT NULL COMMENT 'до якої дати виписка завантажена',
  `started_at` datetime DEFAULT NULL,
  `finished_at` datetime DEFAULT NULL,
  `total` int unsigned NOT NULL DEFAULT '0',
  `message` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id_account`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_state` (
  `name` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `installed_at` datetime DEFAULT NULL,
  `version` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_upd` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_telegram_shop_broadcast_messages` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_broadcast` int unsigned NOT NULL,
  `id_shop` int unsigned NOT NULL,
  `id_customer` int unsigned NOT NULL,
  `tg_user_id` bigint NOT NULL,
  `status` enum('queued','sent','failed','blocked','cancelled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'queued',
  `attempts` tinyint unsigned NOT NULL DEFAULT '0',
  `date_next_attempt` datetime NOT NULL,
  `error` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_sent` datetime DEFAULT NULL,
  `date_clicked` datetime DEFAULT NULL,
  `promo_code` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'персональний промокод адресата',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_bc` (`id_broadcast`,`id_customer`),
  KEY `idx_queue` (`status`,`date_next_attempt`),
  KEY `idx_customer` (`id_customer`,`date_sent`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_telegram_shop_broadcasts` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('draft','scheduled','preparing','sending','paused','sent','cancelled','failed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'draft',
  `audience` json DEFAULT NULL COMMENT '{shops:[], segment, days, langs:[]}',
  `message` json DEFAULT NULL COMMENT '{text, photo, button:{text, target, product, url}}',
  `date_scheduled` datetime DEFAULT NULL COMMENT 'UTC',
  `cnt_total` int unsigned NOT NULL DEFAULT '0',
  `cnt_sent` int unsigned NOT NULL DEFAULT '0',
  `cnt_failed` int unsigned NOT NULL DEFAULT '0',
  `cnt_blocked` int unsigned NOT NULL DEFAULT '0',
  `cnt_clicked` int unsigned NOT NULL DEFAULT '0',
  `cnt_orders` int unsigned NOT NULL DEFAULT '0',
  `sum_orders` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `last_error` varchar(1024) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `id_user_launched` int unsigned DEFAULT NULL,
  `date_launched` datetime DEFAULT NULL,
  `date_finished` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime DEFAULT NULL,
  `deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_status` (`status`,`date_scheduled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_telegram_shop_customers` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_shop` int unsigned NOT NULL,
  `tg_user_id` bigint unsigned NOT NULL,
  `username` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `first_name` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_name` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `language_code` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_client` int unsigned DEFAULT NULL,
  `is_blocked` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'клієнт зупинив бота — повідомлення не надсилаються',
  `started_at` datetime DEFAULT NULL,
  `last_seen_at` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `cart` json DEFAULT NULL COMMENT 'кошик вітрини: [{id, variant, qty}]',
  `cart_at` datetime DEFAULT NULL COMMENT 'коли кошик востаннє змінювався',
  `cart_reminded_at` datetime DEFAULT NULL COMMENT 'коли нагадали про цей кошик',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shop_user` (`id_shop`,`tg_user_id`),
  KEY `idx_client` (`id_client`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_telegram_shop_orders` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_shop` int unsigned NOT NULL,
  `id_customer` int unsigned NOT NULL,
  `id_order` int unsigned NOT NULL,
  `payment` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `delivery` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_status` int DEFAULT NULL COMMENT 'останній статус, про який повідомили клієнта',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_order` (`id_order`),
  KEY `idx_customer` (`id_customer`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_telegram_shop_shops` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `slug` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'публічний ідентифікатор у посиланнях вітрини й вебхука',
  `id_integration` int DEFAULT NULL COMMENT 'канал продажу: асортимент, ціни, залишки, джерело замовлень',
  `status` enum('draft','active','disabled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'draft',
  `bot_id` bigint unsigned DEFAULT NULL,
  `bot_username` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `token_cipher` varbinary(512) DEFAULT NULL,
  `token_iv` varbinary(16) DEFAULT NULL,
  `token_tag` varbinary(16) DEFAULT NULL,
  `token_last4` varchar(4) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `webhook_secret` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `webhook_ok` tinyint(1) NOT NULL DEFAULT '0',
  `webhook_error` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `settings` json DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_slug` (`slug`),
  KEY `idx_integration` (`id_integration`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_modules_telegram_shop_watch` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_shop` int unsigned NOT NULL,
  `id_customer` int unsigned NOT NULL,
  `id_product` int unsigned NOT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_watch` (`id_customer`,`id_product`,`id_variant`),
  KEY `idx_shop` (`id_shop`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_notif_delivery` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `event_id` bigint NOT NULL,
  `user_id` bigint NOT NULL,
  `channel` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('pending','sent','delivered','failed','bounced','skipped') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `attempts` int NOT NULL DEFAULT '0',
  `last_error` text COLLATE utf8mb4_unicode_ci,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_event_user_channel` (`event_id`,`user_id`,`channel`),
  KEY `idx_status` (`channel`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_notif_events` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `event_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `event_type` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `audience_type` enum('user','group','topic','broadcast') COLLATE utf8mb4_unicode_ci NOT NULL,
  `audience_ref` varchar(190) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `channels` json NOT NULL,
  `priority` tinyint NOT NULL DEFAULT '5',
  `collapse_key` varchar(190) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `payload` json NOT NULL,
  `materialized` tinyint NOT NULL DEFAULT '0',
  `dispatched` tinyint NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expires_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_event_key` (`event_key`),
  KEY `idx_dispatch` (`dispatched`,`id`),
  KEY `idx_audience` (`audience_type`,`audience_ref`,`id`),
  KEY `idx_type_time` (`event_type`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_notif_inbox` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `event_id` bigint NOT NULL,
  `user_id` bigint NOT NULL,
  `collapse_key` varchar(190) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `seen_at` datetime(3) DEFAULT NULL,
  `read_at` datetime(3) DEFAULT NULL,
  `archived_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_event_user` (`event_id`,`user_id`),
  KEY `idx_user_unread` (`user_id`,`read_at`,`id`),
  KEY `idx_user_collapse` (`user_id`,`collapse_key`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_notif_preferences` (
  `user_id` bigint NOT NULL,
  `channel` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `event_type` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `enabled` tinyint NOT NULL DEFAULT '1',
  `quiet_start` time DEFAULT NULL,
  `quiet_end` time DEFAULT NULL,
  `tz` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`user_id`,`channel`,`event_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_notif_read_state` (
  `user_id` bigint NOT NULL,
  `topic` varchar(190) COLLATE utf8mb4_unicode_ci NOT NULL,
  `last_read_event_id` bigint NOT NULL DEFAULT '0',
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`user_id`,`topic`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_notif_recipients` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `scope` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `scope_ref` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `kind` enum('user','group','topic') COLLATE utf8mb4_unicode_ci NOT NULL,
  `ref` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `options` json DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_scope_audience` (`scope`,`scope_ref`,`kind`,`ref`),
  KEY `idx_scope` (`scope`,`scope_ref`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_notif_subscriptions` (
  `user_id` bigint NOT NULL,
  `topic` varchar(190) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`user_id`,`topic`),
  KEY `idx_topic` (`topic`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_notification_reads` (
  `notification_id` int NOT NULL,
  `manager_id` int NOT NULL,
  `read_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`notification_id`,`manager_id`),
  KEY `idx_manager` (`manager_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_notifications` (
  `id` int NOT NULL AUTO_INCREMENT,
  `type` int NOT NULL,
  `data` json NOT NULL,
  `is_read` int NOT NULL,
  `groups` int NOT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_type` (`type`),
  KEY `idx_date` (`date_add`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_np_accounts` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `api_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `settings` json DEFAULT NULL COMMENT 'відправник, платник, тип вантажу, опис, вага за замовчуванням, наложений платіж',
  `integrations` json DEFAULT NULL COMMENT 'id інтеграцій (магазинів), для яких акаунт за замовчуванням',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_np_areas` (
  `ref` char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_ru` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `seen` datetime NOT NULL,
  PRIMARY KEY (`ref`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_np_cities` (
  `ref` char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_ru` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `area_ref` char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `area` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `type` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `seen` datetime NOT NULL,
  PRIMARY KEY (`ref`),
  KEY `idx_name` (`name`(30)),
  KEY `idx_name_ru` (`name_ru`(30))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_np_sync` (
  `k` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `started_at` datetime DEFAULT NULL,
  `finished_at` datetime DEFAULT NULL,
  `total` int unsigned NOT NULL DEFAULT '0',
  `message` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_np_warehouses` (
  `ref` char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `city_ref` char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `number` int unsigned NOT NULL DEFAULT '0',
  `type` enum('warehouse','postomat','cargo') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'warehouse',
  `name` varchar(512) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_ru` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `short_address` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `max_weight` int unsigned NOT NULL DEFAULT '0',
  `status` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `seen` datetime NOT NULL,
  PRIMARY KEY (`ref`),
  KEY `idx_city` (`city_ref`,`number`),
  KEY `idx_number` (`number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_integration` int DEFAULT NULL,
  `external_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ID замовлення в CMS/маркетплейсі',
  `external_number` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Людський номер у джерелі',
  `external_cart_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `secure_key` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `reference` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Внутрішній номер CRM',
  `source_channel` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'web/phone/marketplace/instagram',
  `id_client` int unsigned DEFAULT NULL COMMENT 'clients.id — покупець',
  `id_client_recipient` int unsigned DEFAULT NULL COMMENT 'clients.id — отримувач, якщо інший',
  `id_client_org` int unsigned DEFAULT NULL COMMENT 'clients.id — компанія-покупець (B2B)',
  `client` json NOT NULL,
  `status` int NOT NULL COMMENT 'FK orders_status (поточний)',
  `financial_status` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending' COMMENT 'pending/authorized/paid/partially_paid/partially_refunded/refunded/voided',
  `fulfillment_status` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'unfulfilled' COMMENT 'unfulfilled/partial/fulfilled/returned',
  `is_paid` tinyint(1) NOT NULL DEFAULT '0',
  `is_shipped` tinyint(1) NOT NULL DEFAULT '0',
  `is_canceled` tinyint(1) NOT NULL DEFAULT '0',
  `currency` int NOT NULL COMMENT 'FK orders_currency',
  `currency_iso` char(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'USD',
  `currency_rate` decimal(20,10) NOT NULL DEFAULT '1.0000000000' COMMENT 'Курс до базової на момент',
  `id_lang` int NOT NULL DEFAULT '1',
  `total_products` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_discount` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_discount_base` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_shipping` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_wrapping` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_tax` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_tips` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total` decimal(15,4) NOT NULL DEFAULT '0.0000' COMMENT 'Підсумок до сплати',
  `total_base` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_paid` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_paid_base` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_refunded` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_refunded_base` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_fees` decimal(15,4) NOT NULL DEFAULT '0.0000' COMMENT 'Комісії маркетплейсу',
  `total_fees_base` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `delivery` int DEFAULT NULL COMMENT 'FK orders_delivery',
  `payment` int DEFAULT NULL COMMENT 'FK orders_payment',
  `is_gift` tinyint(1) NOT NULL DEFAULT '0',
  `gift_message` varchar(999) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `custom_fields` json DEFAULT NULL,
  `note` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `ip` varbinary(16) DEFAULT NULL COMMENT 'INET6_ATON',
  `user_agent` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_user` int DEFAULT NULL COMMENT 'Відповідальний менеджер',
  `locked_by` int unsigned DEFAULT NULL,
  `locked_at` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  `date_order` datetime DEFAULT NULL COMMENT 'Дата в джерелі (може ≠ date_add)',
  `deleted_at` datetime DEFAULT NULL COMMENT 'Soft delete',
  `id_user_deleted` int unsigned DEFAULT NULL,
  `revision` int NOT NULL DEFAULT '0' COMMENT 'Лічильник змін (монотонний)',
  `sync_hash` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Хеш останнього синхронізованого стану джерела (echo-захист)',
  `external_updated_at` datetime DEFAULT NULL COMMENT 'Мітка часу зміни на боці джерела (для конфліктів статусу)',
  `date_order_day` date GENERATED ALWAYS AS (cast(coalesce(`date_order`,`date_add`) as date)) STORED,
  `base_currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'USD',
  `id_warehouse` int unsigned DEFAULT NULL,
  `stock_state` enum('none','ok','warning','error') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'none',
  `stock_message` text COLLATE utf8mb4_unicode_ci,
  `stock_synced_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_source_order` (`id_integration`,`external_id`),
  KEY `idx_status` (`status`),
  KEY `idx_financial` (`financial_status`),
  KEY `idx_fulfillment` (`fulfillment_status`),
  KEY `idx_client` (`id_client`),
  KEY `idx_reference` (`reference`),
  KEY `idx_date_add` (`date_add`),
  KEY `idx_deleted` (`deleted_at`),
  KEY `idx_date_status` (`date_add`,`status`),
  KEY `idx_status_date` (`status`,`date_add`),
  KEY `idx_client_date` (`id_client`,`date_add`),
  KEY `idx_is_paid_date` (`is_paid`,`date_add`),
  KEY `idx_financial_status` (`financial_status`,`date_add`),
  KEY `idx_stat_day` (`date_order_day`,`id_integration`),
  KEY `idx_stat_int_day` (`id_integration`,`date_order_day`,`status`),
  KEY `fk_order_payment_method` (`payment`),
  KEY `idx_client_recipient` (`id_client_recipient`),
  KEY `idx_client_org` (`id_client_org`),
  KEY `idx_stock_state` (`stock_state`,`stock_synced_at`),
  KEY `idx_locked_by` (`locked_by`),
  KEY `idx_list` (`deleted_at`,`id`),
  KEY `idx_list_date` (`deleted_at`,`date_add`),
  KEY `idx_list_status` (`deleted_at`,`status`,`id`),
  KEY `idx_list_site` (`id_integration`,`deleted_at`,`id`),
  KEY `idx_list_user` (`id_user`,`deleted_at`,`id`),
  KEY `idx_client_day` (`id_client`,`date_order_day`),
  CONSTRAINT `fk_order_payment_method` FOREIGN KEY (`payment`) REFERENCES `prefix_orders_payment` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_orders_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_clients` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_orders_client_org` FOREIGN KEY (`id_client_org`) REFERENCES `prefix_clients` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_orders_client_recipient` FOREIGN KEY (`id_client_recipient`) REFERENCES `prefix_clients` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_abandoned_cart` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `store_id` int unsigned NOT NULL,
  `id_integration` int unsigned DEFAULT NULL,
  `id_customer` int unsigned DEFAULT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_client` int unsigned DEFAULT NULL,
  `id_order` int unsigned DEFAULT NULL COMMENT 'Відновлене замовлення (без FK — гаряча таблиця)',
  `session_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `external_cart_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `currency` char(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UAH',
  `total_amount` decimal(12,4) NOT NULL DEFAULT '0.0000',
  `items_count` int unsigned NOT NULL DEFAULT '0',
  `sync_hash` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'sha256 знімка — echo-suppression',
  `status` enum('active','abandoned','notified','recovered','expired') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `cart` json NOT NULL,
  `utm_source` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `utm_medium` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `utm_campaign` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ip` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `user_agent` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `first_seen_at` datetime NOT NULL,
  `last_activity_at` datetime NOT NULL,
  `recovered_at` datetime DEFAULT NULL,
  `reconciled_at` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_store_session` (`store_id`,`session_id`),
  KEY `idx_customer` (`id_customer`),
  KEY `idx_last_activity` (`last_activity_at`),
  KEY `idx_total` (`total_amount`),
  KEY `idx_status` (`status`),
  KEY `idx_integration` (`id_integration`),
  KEY `idx_client` (`id_client`),
  KEY `idx_order` (`id_order`),
  KEY `idx_status_activity` (`status`,`last_activity_at`),
  KEY `idx_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_abandoned_cart_events` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `service_id` int unsigned NOT NULL,
  `id_integration` int unsigned DEFAULT NULL COMMENT 'NULL = усі сайти; інакше — конкретне джерело',
  `store_id` int unsigned DEFAULT NULL COMMENT 'NULL = будь-який стор джерела',
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `delay_hours` int unsigned NOT NULL DEFAULT '24',
  `send_time_from` time DEFAULT '09:00:00' COMMENT 'Початок вікна відправлення',
  `send_time_to` time DEFAULT '20:00:00' COMMENT 'Кінець вікна відправлення',
  `send_slot_1` time DEFAULT '10:00:00' COMMENT 'Перший час відправлення',
  `send_slot_2` time DEFAULT NULL COMMENT 'Другий час (необовʼязково)',
  `send_days` tinyint unsigned NOT NULL DEFAULT '127' COMMENT 'Бітмаска днів Пн..Нд (127=всі)',
  `delay_minutes` int unsigned NOT NULL DEFAULT '0' COMMENT 'Додаткова затримка у хвилинах',
  `resend_mode` enum('once','once_repeat') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'once' COMMENT 'once=1 меседж, once_repeat=1+повтор',
  `repeat_after_hours` int unsigned NOT NULL DEFAULT '24' COMMENT 'Через скільки годин повтор',
  `min_cart_amount` decimal(12,4) NOT NULL DEFAULT '0.0000' COMMENT 'Мін. сума кошика для відправлення',
  `message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_service` (`service_id`),
  KEY `idx_active` (`active`),
  KEY `idx_event_source` (`id_integration`,`store_id`),
  CONSTRAINT `fk_event_service` FOREIGN KEY (`service_id`) REFERENCES `prefix_orders_abandoned_cart_services` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_abandoned_cart_inbox` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_token` int unsigned NOT NULL,
  `id_integration` int unsigned DEFAULT NULL,
  `external_id` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'session_id кошика на джерелі',
  `payload` json NOT NULL,
  `status` enum('pending','processing','done','failed') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `attempts` tinyint unsigned NOT NULL DEFAULT '0',
  `id_cart` int unsigned DEFAULT NULL COMMENT 'Заповнюється воркером після upsert',
  `ip` varbinary(16) DEFAULT NULL,
  `last_error` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `locked_at` datetime DEFAULT NULL,
  `received_at` datetime NOT NULL,
  `processed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_pick` (`status`,`attempts`,`id`),
  KEY `idx_locked` (`locked_at`),
  KEY `idx_integration` (`id_integration`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_abandoned_cart_log` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `cart_id` int unsigned NOT NULL,
  `event_id` int unsigned NOT NULL,
  `attempt_no` tinyint unsigned NOT NULL DEFAULT '1',
  `source` enum('auto','manual') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'auto',
  `service_id` int unsigned DEFAULT NULL,
  `channel` tinyint unsigned DEFAULT NULL,
  `recipient` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `recovery_token` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` tinyint NOT NULL DEFAULT '0',
  `http_status` smallint unsigned DEFAULT NULL,
  `request` json DEFAULT NULL,
  `error` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `response` json DEFAULT NULL,
  `sent_at` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_status` (`status`),
  KEY `idx_cart` (`cart_id`),
  KEY `idx_event` (`event_id`),
  KEY `idx_sent_at` (`sent_at`),
  CONSTRAINT `fk_log_cart` FOREIGN KEY (`cart_id`) REFERENCES `prefix_orders_abandoned_cart` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_log_event` FOREIGN KEY (`event_id`) REFERENCES `prefix_orders_abandoned_cart_events` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_abandoned_cart_queue` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `cart_id` int unsigned NOT NULL,
  `event_id` int unsigned NOT NULL,
  `service_id` int unsigned NOT NULL,
  `attempt_no` tinyint unsigned NOT NULL DEFAULT '1' COMMENT '1=перше, 2=повтор (once_repeat)',
  `status` enum('pending','processing','sent','failed','skipped','canceled') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `run_after` datetime NOT NULL COMMENT 'Не відправляти раніше цього моменту',
  `attempts` tinyint unsigned NOT NULL DEFAULT '0' COMMENT 'Лічильник спроб відправки (ретраї воркера)',
  `max_attempts` tinyint unsigned NOT NULL DEFAULT '3',
  `locked_at` datetime DEFAULT NULL,
  `locked_by` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `recipient` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Снапшот номера на момент відправки',
  `provider_message_ids` json DEFAULT NULL COMMENT 'id повідомлень від SMSclub',
  `correlation_id` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'UUID однієї відправки — зшивання log/JSONL/status',
  `last_error` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `sent_at` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  `delivery_status` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Головний статус доставки (Delivered/Sent/...)',
  `delivery_extra` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'additionalStatus (Read/Blocked/...)',
  `delivery_final` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = термінальний статус, більше не опитувати',
  `delivery_checked_at` datetime DEFAULT NULL,
  `status_attempts` smallint unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_task` (`cart_id`,`event_id`,`attempt_no`),
  KEY `idx_pick` (`status`,`run_after`,`id`),
  KEY `idx_cart` (`cart_id`),
  KEY `idx_event` (`event_id`),
  KEY `idx_locked` (`locked_at`),
  KEY `idx_delivery_poll` (`status`,`delivery_final`,`delivery_checked_at`),
  CONSTRAINT `fk_queue_cart` FOREIGN KEY (`cart_id`) REFERENCES `prefix_orders_abandoned_cart` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_queue_event` FOREIGN KEY (`event_id`) REFERENCES `prefix_orders_abandoned_cart_events` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_abandoned_cart_recovery` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `cart_id` int unsigned NOT NULL,
  `token` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_integration` int unsigned DEFAULT NULL,
  `store_id` int unsigned DEFAULT NULL,
  `session_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `clicks` int unsigned NOT NULL DEFAULT '0' COMMENT 'Скільки разів перейшли',
  `first_click_at` datetime DEFAULT NULL,
  `last_click_at` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_token` (`token`),
  UNIQUE KEY `uq_cart` (`cart_id`),
  KEY `idx_cart` (`cart_id`),
  CONSTRAINT `fk_recovery_cart` FOREIGN KEY (`cart_id`) REFERENCES `prefix_orders_abandoned_cart` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_abandoned_cart_services` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `channel` tinyint unsigned NOT NULL DEFAULT '1',
  `provider` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `logo_url` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `config_fields` json DEFAULT NULL,
  `config` json DEFAULT NULL,
  `is_connected` tinyint(1) NOT NULL DEFAULT '0',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_provider` (`provider`),
  KEY `idx_channel` (`channel`),
  KEY `idx_connected` (`is_connected`),
  KEY `idx_active` (`active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_addresses` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_order` bigint unsigned NOT NULL,
  `type` enum('billing','shipping') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'shipping',
  `firstname` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `lastname` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `middlename` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `company` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `email` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `country` varchar(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `region` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `city` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `city_ref` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `address_1` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `address_2` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `warehouse` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `warehouse_ref` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `postcode` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `meta` json DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order` (`id_order`),
  KEY `idx_type` (`id_order`,`type`),
  KEY `idx_country_city` (`country`,`city`),
  CONSTRAINT `fk_addr_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_clients` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_integration` int DEFAULT NULL COMMENT 'Звідки прийшов (CMS/маркетплейс)',
  `external_id` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ID клієнта в джерелі',
  `source_channel` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'web/phone/marketplace/instagram/manual',
  `social_title` enum('mr','mrs','ms','other') COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Звертання (PrestaShop social_title)',
  `firstname` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `lastname` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `middlename` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'По батькові',
  `display_name` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Готове відображуване імʼя (кеш)',
  `email` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Основний email (для дедуплікації)',
  `phone` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Основний телефон, нормалізований E.164',
  `phones` json DEFAULT NULL COMMENT 'Додаткові телефони [{"phone":"","note":""}]',
  `emails` json DEFAULT NULL COMMENT 'Додаткові email',
  `messengers` json DEFAULT NULL COMMENT '{"telegram":"","viber":"","whatsapp":"","instagram":""}',
  `website` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `gender` enum('male','female','other') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `birthday` date DEFAULT NULL,
  `id_lang` int NOT NULL DEFAULT '2' COMMENT 'Мова спілкування',
  `country` varchar(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ISO 3166 основної країни',
  `city` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Основне місто (кеш з адрес)',
  `timezone` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_company` tinyint(1) NOT NULL DEFAULT '0',
  `company` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `company_code` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ЄДРПОУ / ІПН',
  `vat_number` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ПДВ / VAT',
  `position` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Посада контактної особи',
  `company_details` json DEFAULT NULL COMMENT 'Банк, IBAN, юр.адреса тощо',
  `id_default_group` int NOT NULL DEFAULT '1',
  `type` enum('lead','customer','wholesale','vip','partner') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'customer',
  `status` tinyint(1) NOT NULL DEFAULT '1' COMMENT '1=активний, 0=вимкнений',
  `is_vip` tinyint(1) NOT NULL DEFAULT '0',
  `is_blacklisted` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Чорний список',
  `blacklist_reason` varchar(999) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_manager` int DEFAULT NULL COMMENT 'Відповідальний менеджер',
  `newsletter` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Згода на email-розсилку',
  `newsletter_date` datetime DEFAULT NULL,
  `opt_in_sms` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Згода на SMS',
  `opt_in_calls` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Згода на дзвінки',
  `opt_in_partners` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Реклама партнерів (PrestaShop optin)',
  `gdpr_consent` tinyint(1) NOT NULL DEFAULT '0',
  `gdpr_consent_date` datetime DEFAULT NULL,
  `acquisition_source` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Як залучили (google/instagram/friend)',
  `utm_first` json DEFAULT NULL COMMENT 'UTM першого контакту',
  `referrer_id` bigint unsigned DEFAULT NULL COMMENT 'Хто привів (реферал/спонсор)',
  `reward_points` int NOT NULL DEFAULT '0' COMMENT 'Бонусні бали (кеш SUM rewards)',
  `balance` decimal(15,4) NOT NULL DEFAULT '0.0000' COMMENT 'Грошовий стор-кредит (кеш SUM transactions)',
  `balance_currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UAH',
  `credit_limit` decimal(15,4) NOT NULL DEFAULT '0.0000' COMMENT 'Кредитний ліміт для B2B-постоплати',
  `orders_count` int NOT NULL DEFAULT '0',
  `orders_valid_count` int NOT NULL DEFAULT '0' COMMENT 'Підтверджені замовлення',
  `total_spent` decimal(15,4) NOT NULL DEFAULT '0.0000' COMMENT 'LTV',
  `avg_order_value` decimal(15,4) NOT NULL DEFAULT '0.0000' COMMENT 'Середній чек',
  `first_order_at` datetime DEFAULT NULL,
  `last_order_at` datetime DEFAULT NULL,
  `last_activity_at` datetime DEFAULT NULL COMMENT 'Остання активність будь-де',
  `custom_fields` json DEFAULT NULL COMMENT 'Довільні поля клієнта',
  `tags` json DEFAULT NULL COMMENT 'Теги ["опт","борг"]',
  `note` longtext COLLATE utf8mb4_unicode_ci COMMENT 'Внутрішня нотатка менеджера',
  `avatar` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ip` varbinary(16) DEFAULT NULL COMMENT 'IP реєстрації (INET6_ATON)',
  `password_hash` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Якщо є вхід у кабінет',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  `deleted_at` datetime DEFAULT NULL COMMENT 'Soft delete',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_source` (`id_integration`,`external_id`),
  KEY `idx_email` (`email`),
  KEY `idx_phone` (`phone`),
  KEY `idx_group` (`id_default_group`),
  KEY `idx_type` (`type`),
  KEY `idx_manager` (`id_manager`),
  KEY `idx_status` (`status`),
  KEY `idx_deleted` (`deleted_at`),
  KEY `idx_last_order` (`last_order_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_clients_addresses` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_client` bigint unsigned NOT NULL,
  `alias` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Назва адреси (Дім/Офіс)',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `type` enum('billing','shipping','both') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'both',
  `firstname` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `lastname` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `middlename` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `company` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `country` varchar(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `region` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `city` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `city_ref` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ID міста у службі доставки',
  `address_1` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `address_2` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `warehouse` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '№ відділення/поштомат',
  `warehouse_ref` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `postcode` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `meta` json DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_client` (`id_client`),
  CONSTRAINT `fk_caddr_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_orders_clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_clients_group_map` (
  `id_client` bigint unsigned NOT NULL,
  `id_group` int NOT NULL,
  PRIMARY KEY (`id_client`,`id_group`),
  KEY `idx_group` (`id_group`),
  CONSTRAINT `fk_cgmap_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_orders_clients` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cgmap_group` FOREIGN KEY (`id_group`) REFERENCES `prefix_orders_clients_groups` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_clients_groups` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `discount_percent` decimal(5,2) NOT NULL DEFAULT '0.00' COMMENT 'Знижка на весь магазин для групи',
  `tax_exempt` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Звільнення від податку (B2B)',
  `color_text` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `color_background` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#6c757d',
  `is_default` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Група за замовчуванням для нових',
  `is_system` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Вбудована, не можна видалити',
  `note` varchar(999) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_clients_rewards` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_client` bigint unsigned NOT NULL,
  `id_order` bigint unsigned DEFAULT NULL COMMENT 'Замовлення-джерело (якщо є)',
  `points` int NOT NULL COMMENT '+нарахування / −списання',
  `description` varchar(999) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Причина',
  `id_user` int DEFAULT NULL COMMENT 'Хто нарахував (NULL=система)',
  `expires_at` datetime DEFAULT NULL COMMENT 'Термін дії балів',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_client` (`id_client`),
  KEY `idx_order` (`id_order`),
  CONSTRAINT `fk_reward_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_orders_clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_clients_transactions` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_client` bigint unsigned NOT NULL,
  `id_order` bigint unsigned DEFAULT NULL,
  `amount` decimal(15,4) NOT NULL COMMENT '+поповнення / −списання',
  `currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UAH',
  `description` varchar(999) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_user` int DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_client` (`id_client`),
  KEY `idx_order` (`id_order`),
  CONSTRAINT `fk_trans_client` FOREIGN KEY (`id_client`) REFERENCES `prefix_orders_clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_currency` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `symbol` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `currency_iso_code` varchar(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `rate` decimal(20,10) NOT NULL DEFAULT '1.0000000000' COMMENT 'Курс до базової',
  `is_base` tinyint(1) NOT NULL DEFAULT '0',
  `date_edit` datetime DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_delivery` (
  `id` int NOT NULL AUTO_INCREMENT,
  `color_text` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `color_background` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  `icon` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_delivery_lang` (
  `id` int NOT NULL AUTO_INCREMENT,
  `id_delivery` int NOT NULL,
  `id_lang` int NOT NULL,
  `title` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `text` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_delivery` (`id_delivery`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_discounts` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_order` bigint unsigned NOT NULL,
  `code` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `type` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `value` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order` (`id_order`),
  KEY `idx_code` (`code`),
  CONSTRAINT `fk_disc_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_documents` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_order` bigint unsigned NOT NULL,
  `type` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'invoice/delivery_slip/credit_slip/label',
  `id_ref` bigint unsigned DEFAULT NULL,
  `number` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `file_path` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order` (`id_order`),
  KEY `idx_type` (`id_order`,`type`),
  CONSTRAINT `fk_doc_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_events` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_order` bigint unsigned NOT NULL,
  `id_user` int DEFAULT NULL,
  `type` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `payload` json DEFAULT NULL,
  `source` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order` (`id_order`),
  KEY `idx_type` (`type`),
  KEY `idx_dedup` (`id_order`,`type`,`date_add`),
  CONSTRAINT `fk_events_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_fees` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_order` bigint unsigned NOT NULL,
  `type` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `amount` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order` (`id_order`),
  CONSTRAINT `fk_fees_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_inbox` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_token` bigint unsigned DEFAULT NULL COMMENT 'Яким токеном прийнято',
  `id_integration` int DEFAULT NULL,
  `external_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ID у джерелі (для дедуплікації)',
  `payload` json NOT NULL COMMENT 'Сирий конверт як прийшов',
  `status` enum('pending','processing','done','failed') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `attempts` int NOT NULL DEFAULT '0',
  `last_error` varchar(999) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_order` bigint unsigned DEFAULT NULL COMMENT 'Створене замовлення (коли done)',
  `ip` varbinary(16) DEFAULT NULL,
  `received_at` datetime NOT NULL,
  `locked_at` datetime DEFAULT NULL COMMENT 'Коли воркер узяв у роботу (для реклейму зависань)',
  `processed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inbox_source` (`id_integration`,`external_id`),
  KEY `idx_status` (`status`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_invoices` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_order` bigint unsigned NOT NULL,
  `number` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `number_prefix` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `note` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `shop_address` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `total_products_tax_excl` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_products_tax_incl` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_discount_tax_excl` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_discount_tax_incl` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_shipping_tax_excl` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_shipping_tax_incl` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_wrapping_tax_excl` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_wrapping_tax_incl` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_paid_tax_excl` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_paid_tax_incl` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order` (`id_order`),
  KEY `idx_number` (`number`),
  CONSTRAINT `fk_inv_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_invoices_tax` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_invoice` bigint unsigned NOT NULL,
  `type` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'products',
  `rate` decimal(6,4) NOT NULL DEFAULT '0.0000',
  `amount` decimal(15,4) NOT NULL DEFAULT '0.0000',
  PRIMARY KEY (`id`),
  KEY `idx_invoice` (`id_invoice`),
  CONSTRAINT `fk_invtax_invoice` FOREIGN KEY (`id_invoice`) REFERENCES `prefix_orders_invoices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_items` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_order` bigint unsigned NOT NULL,
  `id_product` bigint unsigned DEFAULT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `map_source` enum('manual','link','sku') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `external_product_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sku` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `name` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'product',
  `quantity` decimal(12,3) NOT NULL DEFAULT '1.000',
  `unit_price` decimal(15,4) NOT NULL DEFAULT '0.0000' COMMENT 'За од. без податку',
  `unit_price_wt` decimal(15,4) NOT NULL DEFAULT '0.0000' COMMENT 'За од. з податком',
  `discount` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `tax_rate` decimal(6,4) NOT NULL DEFAULT '0.0000' COMMENT '0.2000 = 20%',
  `total` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `total_base` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `attributes` json DEFAULT NULL,
  `meta` json DEFAULT NULL,
  `cost_price` decimal(15,4) DEFAULT NULL COMMENT 'Собівартість за од. на момент продажу',
  PRIMARY KEY (`id`),
  KEY `idx_order` (`id_order`),
  KEY `idx_product` (`id_product`),
  KEY `idx_sku` (`sku`),
  KEY `idx_product_order` (`id_product`,`id_order`),
  KEY `idx_sku_order` (`sku`,`id_order`),
  KEY `idx_catalog_product` (`id_product`,`id_variant`),
  CONSTRAINT `fk_items_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_message_templates` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `text` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_service` int unsigned DEFAULT NULL COMMENT 'orders_abandoned_cart_services.id; NULL — сервіс за замовчуванням',
  `trigger_event` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'new | status | ttn | delivered | returned; NULL — лише вручну',
  `trigger_statuses` json DEFAULT NULL,
  `integrations` json DEFAULT NULL COMMENT 'порожньо — усі сайти',
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_trigger` (`status`,`trigger_event`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_messages` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_order` int unsigned NOT NULL,
  `id_template` int unsigned DEFAULT NULL,
  `id_service` int unsigned NOT NULL,
  `phone` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `text` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `source` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual' COMMENT 'manual | auto',
  `status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending' COMMENT 'pending | processing | sent | failed',
  `attempts` tinyint unsigned NOT NULL DEFAULT '0',
  `next_at` datetime NOT NULL,
  `locked_at` datetime DEFAULT NULL,
  `provider_ids` json DEFAULT NULL,
  `last_error` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `sent_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order` (`id_order`),
  KEY `idx_queue` (`status`,`next_at`),
  KEY `idx_auto` (`id_order`,`id_template`,`source`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_meta` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_order` bigint unsigned NOT NULL,
  `meta_key` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `meta_value` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  KEY `idx_order_key` (`id_order`,`meta_key`),
  CONSTRAINT `fk_meta_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_notes` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_order` bigint unsigned NOT NULL,
  `id_user` int DEFAULT NULL,
  `is_private` tinyint(1) NOT NULL DEFAULT '1',
  `text` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order` (`id_order`),
  CONSTRAINT `fk_notes_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_outbox` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_integration` int NOT NULL COMMENT 'Куди слати (FK orders_integrations)',
  `id_order` bigint unsigned NOT NULL,
  `external_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ID замовлення в джерелі (щоб сайт знайшов своє)',
  `event_type` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'status_change / order_updated',
  `payload` json NOT NULL COMMENT 'Що саме змінилось (готове до відправлення)',
  `status` enum('pending','processing','done','failed') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `attempts` int NOT NULL DEFAULT '0',
  `last_error` varchar(999) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `http_status` int DEFAULT NULL COMMENT 'Код відповіді сайту',
  `date_add` datetime NOT NULL,
  `locked_at` datetime DEFAULT NULL,
  `processed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_status` (`status`,`id`),
  KEY `idx_order` (`id_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_payment` (
  `id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL COMMENT 'cash/cod/liqpay/wayforpay/bank_invoice',
  `color_text` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#ffffff',
  `color_background` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#6c757d',
  `icon` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `is_online` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Проходить через платіжний шлюз',
  `is_prepaid` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Передоплата до відвантаження',
  `is_cod` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Накладений платіж',
  `is_system` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Вбудований, не видаляється',
  `id_status_default` int DEFAULT NULL COMMENT 'FK orders_status — стартовий статус для методу',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`),
  KEY `idx_status_default` (`id_status_default`),
  KEY `idx_active_sort` (`active`,`sort_order`),
  CONSTRAINT `fk_paymethod_status` FOREIGN KEY (`id_status_default`) REFERENCES `prefix_orders_status` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_payment_gateway` (
  `id` int NOT NULL AUTO_INCREMENT,
  `id_payment` int NOT NULL COMMENT 'FK orders_payment',
  `id_integration` int DEFAULT NULL COMMENT 'null = для всіх сайтів',
  `driver` varchar(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL COMMENT 'liqpay/wayforpay — адаптер у коді',
  `is_test` tinyint(1) NOT NULL DEFAULT '0',
  `public_key` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `secret_key` varbinary(512) DEFAULT NULL COMMENT 'Зашифровано (AES) — НЕ plaintext',
  `webhook_secret` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `extra_config` json DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_gateway` (`id_integration`,`driver`,`is_test`),
  KEY `idx_payment` (`id_payment`),
  CONSTRAINT `fk_gateway_method` FOREIGN KEY (`id_payment`) REFERENCES `prefix_orders_payment` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_payment_inbox` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `driver` varchar(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL COMMENT 'liqpay/wayforpay',
  `id_integration` int DEFAULT NULL,
  `id_gateway` int DEFAULT NULL COMMENT 'Яким конфігом прийнято (після резолву)',
  `external_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'transaction_id/orderReference — дедуплікація',
  `id_order` bigint unsigned DEFAULT NULL COMMENT 'Резолв замовлення',
  `signature_valid` tinyint(1) DEFAULT NULL COMMENT 'Результат перевірки підпису',
  `payload` json NOT NULL COMMENT 'Сирий callback',
  `headers` json DEFAULT NULL COMMENT 'HTTP-заголовки',
  `status` enum('pending','processing','done','failed','rejected') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `attempts` int NOT NULL DEFAULT '0',
  `last_error` varchar(999) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_payment_txn` bigint unsigned DEFAULT NULL COMMENT 'Створена/оновлена транзакція',
  `ip` varbinary(16) DEFAULT NULL,
  `received_at` datetime NOT NULL,
  `locked_at` datetime DEFAULT NULL,
  `processed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pay_inbox` (`driver`,`external_id`),
  KEY `idx_pick` (`status`,`attempts`,`id`),
  KEY `idx_locked` (`locked_at`),
  KEY `idx_order` (`id_order`),
  KEY `idx_gateway` (`id_gateway`),
  KEY `fk_payinbox_txn` (`id_payment_txn`),
  CONSTRAINT `fk_payinbox_gateway` FOREIGN KEY (`id_gateway`) REFERENCES `prefix_orders_payment_gateway` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payinbox_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payinbox_txn` FOREIGN KEY (`id_payment_txn`) REFERENCES `prefix_orders_payments` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_payment_lang` (
  `id` int NOT NULL AUTO_INCREMENT,
  `id_payment` int NOT NULL,
  `id_lang` int NOT NULL,
  `text` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payment_lang` (`id_payment`,`id_lang`),
  KEY `idx_payment` (`id_payment`,`id_lang`),
  CONSTRAINT `fk_paylang_method` FOREIGN KEY (`id_payment`) REFERENCES `prefix_orders_payment` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_payment_map` (
  `id` int NOT NULL AUTO_INCREMENT,
  `id_integration` int DEFAULT NULL COMMENT 'null = загальний',
  `external_code` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'method_code з джерела',
  `external_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'method_title як прийшов (дебаг)',
  `id_payment` int DEFAULT NULL COMMENT 'FK orders_payment; NULL = потребує ручного мапінгу',
  `direction` enum('in','out','both') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'both',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pay_map` (`id_integration`,`external_code`,`direction`),
  KEY `idx_payment` (`id_payment`),
  CONSTRAINT `fk_paymap_method` FOREIGN KEY (`id_payment`) REFERENCES `prefix_orders_payment` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_payment_status_map` (
  `id` int NOT NULL AUTO_INCREMENT,
  `driver` varchar(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  `gateway_status` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'success/Approved/wait_accept...',
  `crm_status` enum('pending','authorized','paid','failed','refunded','partially_refunded') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_gw_status` (`driver`,`gateway_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_payments` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_order` bigint unsigned NOT NULL,
  `id_integration` int DEFAULT NULL,
  `id_payment` int DEFAULT NULL,
  `id_payment_method` int DEFAULT NULL COMMENT 'FK orders_payment (метод)',
  `id_gateway` int DEFAULT NULL COMMENT 'FK orders_payment_gateway',
  `driver` varchar(64) CHARACTER SET ascii COLLATE ascii_general_ci DEFAULT NULL COMMENT 'Драйвер (для дедуплікації)',
  `transaction_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `token` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Рекурентний токен картки',
  `signature_valid` tinyint(1) DEFAULT NULL COMMENT 'Чи пройшла криптоперевірка підпису',
  `amount` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `amount_base` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `currency_iso` char(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UAH',
  `id_currency` int DEFAULT NULL COMMENT 'FK orders_currency',
  `status` enum('pending','authorized','paid','failed','refunded','partially_refunded') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `gateway_status` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Сирий статус шлюзу',
  `paid_at` datetime DEFAULT NULL,
  `raw` json DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_txn_dedup` (`driver`,`transaction_id`),
  KEY `idx_order` (`id_order`),
  KEY `idx_transaction` (`transaction_id`),
  KEY `idx_paid_at` (`paid_at`),
  KEY `idx_method` (`id_payment_method`),
  KEY `idx_gateway` (`id_gateway`),
  KEY `idx_order_status` (`id_order`,`status`),
  KEY `fk_pay_currency` (`id_currency`),
  CONSTRAINT `fk_pay_currency` FOREIGN KEY (`id_currency`) REFERENCES `prefix_orders_currency` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pay_gateway` FOREIGN KEY (`id_gateway`) REFERENCES `prefix_orders_payment_gateway` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pay_method` FOREIGN KEY (`id_payment_method`) REFERENCES `prefix_orders_payment` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pay_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_raw` (
  `id_order` bigint unsigned NOT NULL,
  `payload` json NOT NULL,
  `received_at` datetime NOT NULL,
  PRIMARY KEY (`id_order`),
  CONSTRAINT `fk_raw_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_refunds` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_order` bigint unsigned NOT NULL,
  `number` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `reason` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `amount` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `amount_base` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `shipping_refunded` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `restock` tinyint(1) NOT NULL DEFAULT '0',
  `items` json DEFAULT NULL,
  `id_user` int DEFAULT NULL,
  `transaction_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `raw` json DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order` (`id_order`),
  KEY `idx_date_add` (`date_add`),
  CONSTRAINT `fk_refund_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_refunds_items` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_refund` bigint unsigned NOT NULL,
  `id_order_item` bigint unsigned DEFAULT NULL,
  `quantity` decimal(12,3) NOT NULL DEFAULT '0.000',
  `amount` decimal(15,4) NOT NULL DEFAULT '0.0000',
  PRIMARY KEY (`id`),
  KEY `idx_refund` (`id_refund`),
  KEY `idx_order_item` (`id_order_item`),
  CONSTRAINT `fk_refitem_refund` FOREIGN KEY (`id_refund`) REFERENCES `prefix_orders_refunds` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_returns` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_order` int unsigned NOT NULL,
  `number` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` enum('return','exchange') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'return',
  `status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'new',
  `reason` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `comment` text COLLATE utf8mb4_unicode_ci,
  `items` json NOT NULL,
  `ttn` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_refund` int unsigned DEFAULT NULL,
  `id_exchange_order` int unsigned DEFAULT NULL,
  `amount` decimal(15,4) NOT NULL DEFAULT '0.0000' COMMENT 'повернено клієнту',
  `amount_due` decimal(15,4) NOT NULL DEFAULT '0.0000' COMMENT 'доплата клієнта за обміном',
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order` (`id_order`),
  KEY `idx_status` (`status`,`date_add`),
  KEY `idx_refund` (`id_refund`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_rules` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `trigger_event` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `graph` json NOT NULL COMMENT 'схема редактора (Drawflow)',
  `compiled` json NOT NULL COMMENT 'дерево для виконання',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_trigger` (`status`,`trigger_event`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_rules_log` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_rule` int unsigned NOT NULL,
  `id_order` int unsigned NOT NULL,
  `result` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'ok | partial | error',
  `actions` json DEFAULT NULL,
  `error` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_rule` (`id_rule`,`id`),
  KEY `idx_order` (`id_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_shipments` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_order` bigint unsigned NOT NULL,
  `carrier` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `tracking_number` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `cost` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `weight` decimal(12,3) DEFAULT NULL,
  `shipped_at` datetime DEFAULT NULL,
  `delivered_at` datetime DEFAULT NULL,
  `items` json DEFAULT NULL,
  `raw` json DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order` (`id_order`),
  KEY `idx_tracking` (`tracking_number`),
  CONSTRAINT `fk_ship_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_stats_cash_daily` (
  `day` date NOT NULL,
  `id_integration` int NOT NULL DEFAULT '0',
  `paid_base` decimal(18,4) NOT NULL DEFAULT '0.0000',
  `refunded_base` decimal(18,4) NOT NULL DEFAULT '0.0000',
  `payments_count` int NOT NULL DEFAULT '0',
  `refunds_count` int NOT NULL DEFAULT '0',
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`day`,`id_integration`),
  KEY `idx_int_day` (`id_integration`,`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_stats_daily` (
  `day` date NOT NULL,
  `id_integration` int NOT NULL DEFAULT '0',
  `orders_count` int NOT NULL DEFAULT '0',
  `orders_valid` int NOT NULL DEFAULT '0',
  `orders_confirmed` int NOT NULL DEFAULT '0',
  `orders_canceled` int NOT NULL DEFAULT '0',
  `revenue_gross_base` decimal(18,4) NOT NULL DEFAULT '0.0000',
  `revenue_confirmed_base` decimal(18,4) NOT NULL DEFAULT '0.0000',
  `refunded_base` decimal(18,4) NOT NULL DEFAULT '0.0000',
  `fees_base` decimal(18,4) NOT NULL DEFAULT '0.0000',
  `discount_base` decimal(18,4) NOT NULL DEFAULT '0.0000',
  `shipping_base` decimal(18,4) NOT NULL DEFAULT '0.0000',
  `items_qty` decimal(18,3) NOT NULL DEFAULT '0.000',
  `new_clients` int NOT NULL DEFAULT '0',
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`day`,`id_integration`),
  KEY `idx_int_day` (`id_integration`,`day`),
  KEY `idx_day` (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_stats_daily_channel` (
  `day` date NOT NULL,
  `id_integration` int NOT NULL DEFAULT '0',
  `source_channel` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `orders_count` int NOT NULL DEFAULT '0',
  `revenue_base` decimal(18,4) NOT NULL DEFAULT '0.0000',
  PRIMARY KEY (`day`,`id_integration`,`source_channel`),
  KEY `idx_int_day` (`id_integration`,`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_stats_daily_product` (
  `day` date NOT NULL,
  `id_integration` int NOT NULL DEFAULT '0',
  `sku` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `name` varchar(512) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `qty` decimal(18,3) NOT NULL DEFAULT '0.000',
  `revenue_base` decimal(18,4) NOT NULL DEFAULT '0.0000',
  PRIMARY KEY (`day`,`id_integration`,`sku`),
  KEY `idx_int_day_rev` (`id_integration`,`day`,`revenue_base`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_stats_daily_status` (
  `day` date NOT NULL,
  `id_integration` int NOT NULL DEFAULT '0',
  `id_status` int NOT NULL,
  `orders_count` int NOT NULL DEFAULT '0',
  `revenue_base` decimal(18,4) NOT NULL DEFAULT '0.0000',
  PRIMARY KEY (`day`,`id_integration`,`id_status`),
  KEY `idx_int_day` (`id_integration`,`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_status` (
  `id` int NOT NULL AUTO_INCREMENT,
  `color_text` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `color_background` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `icon` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  `logable` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Вважати замовлення підтвердженим',
  `count_in_revenue` tinyint(1) NOT NULL DEFAULT '0',
  `is_final` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Термінальний статус — далі не рухається',
  `is_negative` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Скасування/повернення/фрод — виключати з виручки',
  `invoice` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Дозволити перегляд/завантаження PDF рахунку',
  `hidden` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Приховати статус у замовленнях клієнта',
  `send_email` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Надсилати email при зміні статусу',
  `pdf_invoice` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Додати PDF-рахунок до email',
  `pdf_delivery` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Додати транспортну PDF-накладну до email',
  `shipped` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Позначити замовлення як доставлене',
  `paid` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Позначити замовлення як оплачене',
  `delivery` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Показати PDF про доставку',
  `id_template` int DEFAULT NULL COMMENT 'FK на шаблон листа',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_status_history` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_order` bigint unsigned NOT NULL,
  `id_status` int NOT NULL,
  `id_status_old` int DEFAULT NULL,
  `duration_sec` int unsigned DEFAULT NULL COMMENT 'Скільки секунд замовлення пробуло у ПОПЕРЕДНЬОМУ статусі',
  `id_user` int DEFAULT NULL,
  `source` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual',
  `comment` varchar(999) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `notified` tinyint(1) NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_order` (`id_order`),
  KEY `idx_order_date` (`id_order`,`date_add`),
  CONSTRAINT `fk_hist_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_status_lang` (
  `id` int NOT NULL AUTO_INCREMENT,
  `id_status` int NOT NULL,
  `id_lang` int NOT NULL,
  `text` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_status_lang` (`id_status`,`id_lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_status_map` (
  `id` int NOT NULL AUTO_INCREMENT,
  `id_integration` int DEFAULT NULL COMMENT 'Для якої інтеграції (null = загальна)',
  `external_status` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Сирий статус джерела (код або id)',
  `id_status` int NOT NULL COMMENT 'FK orders_status — внутрішній статус CRM',
  `direction` enum('in','out','both') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'both' COMMENT 'in=сайт→CRM, out=CRM→сайт',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_map` (`id_integration`,`external_status`,`direction`),
  KEY `idx_status` (`id_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_orders_totals` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_order` bigint unsigned NOT NULL,
  `code` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_order` (`id_order`),
  CONSTRAINT `fk_totals_order` FOREIGN KEY (`id_order`) REFERENCES `prefix_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'стабільний ID для API/синку',
  `version` int unsigned NOT NULL DEFAULT '1' COMMENT 'оптимістичне блокування при збереженні',
  `type` enum('simple','variable','bundle','digital','service','gift_card') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'simple',
  `status` enum('draft','active','archived') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'draft',
  `visibility` enum('all','catalog','search','none') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'all',
  `published_at` datetime DEFAULT NULL,
  `unpublished_at` datetime DEFAULT NULL,
  `redirect_type` enum('none','301_product','302_product','301_category','302_category','404','410') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'none',
  `redirect_target_id` int unsigned DEFAULT NULL,
  `slug_shared` tinyint(1) NOT NULL DEFAULT '0',
  `robots_index` tinyint(1) NOT NULL DEFAULT '1',
  `robots_follow` tinyint(1) NOT NULL DEFAULT '1',
  `og_image` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sku` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `model` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `mpn` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ean` varchar(14) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'EAN-8/13, GTIN-14',
  `upc` varchar(12) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `jan` varchar(13) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `isbn` varchar(17) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_brand` int unsigned DEFAULT NULL,
  `id_supplier` int unsigned DEFAULT NULL COMMENT 'постачальник за замовчуванням',
  `id_category_main` int unsigned DEFAULT NULL,
  `id_attribute_set` int unsigned DEFAULT NULL,
  `id_tax_class` int unsigned DEFAULT NULL,
  `product_type_label` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Shopify product_type',
  `vendor` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `item_condition` enum('new','used','refurbished') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'new',
  `show_condition` tinyint(1) NOT NULL DEFAULT '0',
  `is_featured` tinyint(1) NOT NULL DEFAULT '0',
  `on_sale_flag` tinyint(1) NOT NULL DEFAULT '0',
  `online_only` tinyint(1) NOT NULL DEFAULT '0',
  `age_restriction` tinyint unsigned DEFAULT NULL,
  `layout_template` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `price` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `compare_at_price` decimal(15,4) DEFAULT NULL COMMENT 'стара ціна',
  `cost_price` decimal(15,4) DEFAULT NULL COMMENT 'собівартість',
  `wholesale_price` decimal(15,4) DEFAULT NULL,
  `unit_price` decimal(15,4) DEFAULT NULL COMMENT 'ціна за одиницю виміру',
  `unit_price_unit` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'kg, l, m, m2…',
  `unit_price_base` decimal(15,3) DEFAULT NULL COMMENT 'база: 1 кг, 100 г…',
  `ecotax` decimal(15,4) DEFAULT NULL,
  `points_price` int unsigned DEFAULT NULL COMMENT 'ціна в бонусних балах (OpenCart points)',
  `show_price` tinyint(1) NOT NULL DEFAULT '1',
  `price_on_request` tinyint(1) NOT NULL DEFAULT '0',
  `available_for_order` tinyint(1) NOT NULL DEFAULT '1',
  `track_inventory` tinyint(1) NOT NULL DEFAULT '1',
  `subtract_stock` tinyint(1) NOT NULL DEFAULT '1',
  `min_qty` decimal(15,3) NOT NULL DEFAULT '1.000',
  `max_qty` decimal(15,3) DEFAULT NULL,
  `qty_step` decimal(15,3) NOT NULL DEFAULT '1.000',
  `low_stock_threshold` decimal(15,3) DEFAULT NULL,
  `low_stock_alert` tinyint(1) NOT NULL DEFAULT '0',
  `out_of_stock_action` enum('default','deny','backorder','preorder') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'default',
  `id_stock_status` int unsigned DEFAULT NULL COMMENT 'текст при відсутності',
  `available_date` date DEFAULT NULL,
  `preorder_release_date` date DEFAULT NULL,
  `sold_individually` tinyint(1) NOT NULL DEFAULT '0',
  `pack_stock_mode` enum('pack','components','both') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'components' COMMENT 'для bundle',
  `requires_shipping` tinyint(1) NOT NULL DEFAULT '1',
  `weight` decimal(12,4) DEFAULT NULL,
  `weight_unit` varchar(8) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'kg, g, lb, oz',
  `length` decimal(12,4) DEFAULT NULL,
  `width` decimal(12,4) DEFAULT NULL,
  `height` decimal(12,4) DEFAULT NULL,
  `length_unit` varchar(8) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'cm, mm, m, in',
  `shipping_class` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `additional_shipping_cost` decimal(15,4) DEFAULT NULL,
  `delivery_time_type` enum('none','default','custom') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'default',
  `hs_code` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'митний код',
  `country_of_origin` char(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `gift_card_value` decimal(15,4) DEFAULT NULL,
  `gift_card_expiry_days` smallint unsigned DEFAULT NULL,
  `allow_gift_wrap` tinyint(1) NOT NULL DEFAULT '0',
  `viewed` int unsigned NOT NULL DEFAULT '0',
  `sales_count` int unsigned NOT NULL DEFAULT '0',
  `rating_avg` decimal(3,2) DEFAULT NULL,
  `reviews_count` int unsigned NOT NULL DEFAULT '0',
  `internal_note` text COLLATE utf8mb4_unicode_ci,
  `sort_order` int NOT NULL DEFAULT '0',
  `id_user_add` int unsigned DEFAULT NULL,
  `id_user_edit` int unsigned DEFAULT NULL,
  `id_source_product` int unsigned DEFAULT NULL COMMENT 'з якого товару скопійовано',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` datetime DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  `quality_score` tinyint unsigned DEFAULT NULL,
  `quality_issues` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `quality_at` datetime DEFAULT NULL,
  `published_data` longtext COLLATE utf8mb4_unicode_ci,
  `published_version` int unsigned DEFAULT NULL,
  `sync_published_at` datetime DEFAULT NULL,
  `id_user_published` int unsigned DEFAULT NULL,
  `sync_publish_at` datetime DEFAULT NULL,
  `sync_unpublish_at` datetime DEFAULT NULL,
  `price_currency` char(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `price_cur` decimal(15,4) DEFAULT NULL,
  `compare_cur` decimal(15,4) DEFAULT NULL,
  `cost_currency` char(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `cost_cur` decimal(15,4) DEFAULT NULL,
  `wholesale_currency` char(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `wholesale_cur` decimal(15,4) DEFAULT NULL,
  `price_fixed` varchar(2000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `price_auto` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_uuid` (`uuid`),
  UNIQUE KEY `uq_sku` (`sku`),
  KEY `idx_ean` (`ean`),
  KEY `idx_mpn` (`mpn`),
  KEY `idx_model` (`model`),
  KEY `idx_list` (`deleted_at`,`status`,`date_add`),
  KEY `idx_brand` (`id_brand`),
  KEY `idx_supplier` (`id_supplier`),
  KEY `idx_category_main` (`id_category_main`),
  KEY `idx_type` (`type`),
  KEY `fk_8yd_p_attrset` (`id_attribute_set`),
  KEY `fk_8yd_p_tax` (`id_tax_class`),
  KEY `fk_8yd_p_ss` (`id_stock_status`),
  KEY `fk_8yd_p_source` (`id_source_product`),
  KEY `idx_quality` (`quality_score`),
  KEY `idx_sync_publish_at` (`sync_publish_at`),
  KEY `idx_sync_unpublish_at` (`sync_unpublish_at`),
  KEY `idx_date_edit` (`date_edit`),
  KEY `idx_sync_published_at` (`sync_published_at`),
  KEY `idx_price_currency` (`price_currency`),
  KEY `idx_cost_currency` (`cost_currency`),
  KEY `idx_wholesale_currency` (`wholesale_currency`),
  KEY `idx_price_auto` (`price_auto`),
  CONSTRAINT `fk_8yd_p_attrset` FOREIGN KEY (`id_attribute_set`) REFERENCES `prefix_products_attribute_sets` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_8yd_p_brand` FOREIGN KEY (`id_brand`) REFERENCES `prefix_products_brands` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_8yd_p_category` FOREIGN KEY (`id_category_main`) REFERENCES `prefix_products_categories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_8yd_p_source` FOREIGN KEY (`id_source_product`) REFERENCES `prefix_products` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_8yd_p_ss` FOREIGN KEY (`id_stock_status`) REFERENCES `prefix_products_stock_statuses` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_8yd_p_supplier` FOREIGN KEY (`id_supplier`) REFERENCES `prefix_products_suppliers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_8yd_p_tax` FOREIGN KEY (`id_tax_class`) REFERENCES `prefix_products_tax_classes` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_alerts_state` (
  `kind` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ref_a` bigint unsigned NOT NULL,
  `ref_b` bigint unsigned NOT NULL DEFAULT '0',
  `ref_c` bigint unsigned NOT NULL DEFAULT '0',
  `notified_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`kind`,`ref_a`,`ref_b`,`ref_c`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_attachments` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `file` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `original_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mime` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `size` int unsigned NOT NULL,
  `hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_hash` (`hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_attachments_description` (
  `id_attachment` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id_attachment`,`id_lang`),
  CONSTRAINT `fk_8yd_patd_att` FOREIGN KEY (`id_attachment`) REFERENCES `prefix_products_attachments` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_attribute_groups` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_attribute_groups_description` (
  `id_attribute_group` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id_attribute_group`,`id_lang`),
  CONSTRAINT `fk_8yd_pagd_g` FOREIGN KEY (`id_attribute_group`) REFERENCES `prefix_products_attribute_groups` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_attribute_sets` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_attribute_sets_items` (
  `id_attribute_set` int unsigned NOT NULL,
  `id_attribute` int unsigned NOT NULL,
  `is_required` tinyint(1) NOT NULL DEFAULT '0',
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id_attribute_set`,`id_attribute`),
  KEY `idx_attr` (`id_attribute`),
  CONSTRAINT `fk_8yd_pasi_attr` FOREIGN KEY (`id_attribute`) REFERENCES `prefix_products_attributes` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_pasi_set` FOREIGN KEY (`id_attribute_set`) REFERENCES `prefix_products_attribute_sets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_attribute_values` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_attribute` int unsigned NOT NULL,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `color_hex` char(7) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `image` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_attr_code` (`id_attribute`,`code`),
  KEY `idx_attr` (`id_attribute`,`sort_order`),
  CONSTRAINT `fk_8yd_pav_attr` FOREIGN KEY (`id_attribute`) REFERENCES `prefix_products_attributes` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_attribute_values_description` (
  `id_attribute_value` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `slug` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'для SEO-фільтрів',
  PRIMARY KEY (`id_attribute_value`,`id_lang`),
  KEY `idx_name` (`id_lang`,`name`),
  CONSTRAINT `fk_8yd_pavd_val` FOREIGN KEY (`id_attribute_value`) REFERENCES `prefix_products_attribute_values` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_attributes` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_attribute_group` int unsigned DEFAULT NULL,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` enum('select','multiselect','text','textarea','integer','decimal','boolean','date','color') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'select',
  `unit` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'кг, мм, Вт…',
  `is_translatable` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'для text/textarea',
  `is_filterable` tinyint(1) NOT NULL DEFAULT '0',
  `is_comparable` tinyint(1) NOT NULL DEFAULT '0',
  `is_visible_on_card` tinyint(1) NOT NULL DEFAULT '1',
  `is_variant_axis` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'може бути віссю варіантів (колір, розмір)',
  `is_required` tinyint(1) NOT NULL DEFAULT '0',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`),
  KEY `idx_group` (`id_attribute_group`,`sort_order`),
  CONSTRAINT `fk_8yd_pa_group` FOREIGN KEY (`id_attribute_group`) REFERENCES `prefix_products_attribute_groups` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_attributes_description` (
  `id_attribute` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `hint` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id_attribute`,`id_lang`),
  CONSTRAINT `fk_8yd_pad_attr` FOREIGN KEY (`id_attribute`) REFERENCES `prefix_products_attributes` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_brands` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `logo` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `website` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `country` char(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ISO 3166-1 alpha-2',
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` datetime DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  `slug_shared` tinyint(1) NOT NULL DEFAULT '0',
  `robots_index` tinyint(1) NOT NULL DEFAULT '1',
  `robots_follow` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`),
  KEY `idx_status` (`deleted_at`,`status`,`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_brands_description` (
  `id_brand` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` mediumtext COLLATE utf8mb4_unicode_ci,
  `meta_title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `meta_description` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `slug` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `og_title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `og_description` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `canonical_url` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id_brand`,`id_lang`),
  UNIQUE KEY `uq_slug` (`id_lang`,`slug`),
  KEY `idx_name` (`id_lang`,`name`),
  CONSTRAINT `fk_8yd_pbd_brand` FOREIGN KEY (`id_brand`) REFERENCES `prefix_products_brands` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_bulk_jobs` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `kind` enum('edit','revert') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'edit',
  `is_template` tinyint(1) NOT NULL DEFAULT '0',
  `status` enum('queued','running','done','failed','cancelled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'queued',
  `run_at` datetime DEFAULT NULL COMMENT 'UTC: запустити не раніше',
  `revert_at` datetime DEFAULT NULL COMMENT 'UTC: автоматично відмінити в цей час',
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `selection` json DEFAULT NULL COMMENT 'як відібрано товари: фільтр або список (для показу в журналі)',
  `ids` mediumtext COLLATE utf8mb4_unicode_ci COMMENT 'JSON: id товарів, зафіксовані при запуску',
  `operations` json DEFAULT NULL COMMENT 'дії по черзі: [{action, params}]',
  `perms` json DEFAULT NULL COMMENT 'права автора на момент запуску (собівартість тощо)',
  `total` int unsigned NOT NULL DEFAULT '0',
  `processed` int unsigned NOT NULL DEFAULT '0' COMMENT 'курсор: скільки вже оброблено',
  `changed` int unsigned NOT NULL DEFAULT '0',
  `unchanged` int unsigned NOT NULL DEFAULT '0',
  `skipped` int unsigned NOT NULL DEFAULT '0',
  `errors` int unsigned NOT NULL DEFAULT '0',
  `report` mediumtext COLLATE utf8mb4_unicode_ci COMMENT 'JSON: пропущені й помилки [{id, status, message, ...}]',
  `batch` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'пакет історії змін — для відміни цілком',
  `id_source` int unsigned DEFAULT NULL COMMENT 'kind=revert: яку зміну відміняємо',
  `id_reverted_by` int unsigned DEFAULT NULL COMMENT 'kind=edit: відміна цієї зміни',
  `cancel_requested` tinyint(1) NOT NULL DEFAULT '0',
  `error` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_user` int unsigned NOT NULL,
  `locale` varchar(8) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'uk',
  `date_add` datetime NOT NULL,
  `started_at` datetime DEFAULT NULL,
  `heartbeat_at` datetime DEFAULT NULL,
  `finished_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_status` (`status`,`id`),
  KEY `idx_user` (`id_user`,`id`),
  KEY `idx_source` (`id_source`),
  KEY `idx_run` (`status`,`run_at`),
  KEY `idx_revert_at` (`revert_at`),
  KEY `idx_template` (`is_template`,`kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_bundle_items` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_bundle` int unsigned NOT NULL,
  `id_product` int unsigned NOT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `qty` decimal(15,3) NOT NULL DEFAULT '1.000',
  `is_optional` tinyint(1) NOT NULL DEFAULT '0',
  `price_override` decimal(15,4) DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_item` (`id_bundle`,`id_product`,`id_variant`),
  KEY `idx_component` (`id_product`,`id_variant`),
  CONSTRAINT `fk_8yd_pbi_bundle` FOREIGN KEY (`id_bundle`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_pbi_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_categories` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_parent` int unsigned DEFAULT NULL,
  `image` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `icon` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `banner` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `show_in_menu` tinyint(1) NOT NULL DEFAULT '1',
  `menu_columns` tinyint unsigned NOT NULL DEFAULT '1',
  `is_filterable` tinyint(1) NOT NULL DEFAULT '1',
  `default_sort` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `layout_template` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` datetime DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  `slug_shared` tinyint(1) NOT NULL DEFAULT '0',
  `robots_index` tinyint(1) NOT NULL DEFAULT '1',
  `robots_follow` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  KEY `idx_parent` (`id_parent`,`sort_order`),
  KEY `idx_active` (`deleted_at`,`status`),
  CONSTRAINT `fk_8yd_pc_parent` FOREIGN KEY (`id_parent`) REFERENCES `prefix_products_categories` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_categories_description` (
  `id_category` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `h1` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `description` mediumtext COLLATE utf8mb4_unicode_ci,
  `description_bottom` mediumtext COLLATE utf8mb4_unicode_ci,
  `meta_title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `meta_description` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `meta_keywords` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `slug` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `og_title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `og_description` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `canonical_url` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id_category`,`id_lang`),
  UNIQUE KEY `uq_slug` (`id_lang`,`slug`),
  KEY `idx_name` (`id_lang`,`name`),
  CONSTRAINT `fk_8yd_pcd_cat` FOREIGN KEY (`id_category`) REFERENCES `prefix_products_categories` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_categories_path` (
  `id_category` int unsigned NOT NULL,
  `id_ancestor` int unsigned NOT NULL,
  `depth` smallint unsigned NOT NULL,
  PRIMARY KEY (`id_category`,`id_ancestor`),
  KEY `idx_ancestor` (`id_ancestor`,`depth`),
  CONSTRAINT `fk_8yd_pcp_anc` FOREIGN KEY (`id_ancestor`) REFERENCES `prefix_products_categories` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_pcp_cat` FOREIGN KEY (`id_category`) REFERENCES `prefix_products_categories` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_categories_to_customer_groups` (
  `id_category` int unsigned NOT NULL,
  `id_customer_group` int unsigned NOT NULL,
  PRIMARY KEY (`id_category`,`id_customer_group`),
  CONSTRAINT `fk_8yd_pccg_cat` FOREIGN KEY (`id_category`) REFERENCES `prefix_products_categories` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_customer_groups` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `discount_percent` decimal(5,2) NOT NULL DEFAULT '0.00',
  `price_display` enum('tax_incl','tax_excl') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'tax_incl',
  `min_order_amount` decimal(15,4) DEFAULT NULL,
  `requires_approval` tinyint(1) NOT NULL DEFAULT '0',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `default_flag` tinyint GENERATED ALWAYS AS (if((`is_default` = 1),1,NULL)) STORED,
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_upd` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`),
  UNIQUE KEY `uq_default` (`default_flag`),
  CONSTRAINT `chk_cg_discount` CHECK ((`discount_percent` between 0 and 100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_customer_groups_description` (
  `id_customer_group` int unsigned NOT NULL,
  `id_lang` int unsigned NOT NULL,
  `name` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `description` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id_customer_group`,`id_lang`),
  CONSTRAINT `fk_cgd_group` FOREIGN KEY (`id_customer_group`) REFERENCES `prefix_products_customer_groups` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_customization_fields` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned NOT NULL,
  `type` enum('text','file') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'text',
  `is_required` tinyint(1) NOT NULL DEFAULT '0',
  `max_length` smallint unsigned DEFAULT NULL,
  `price` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_product` (`id_product`),
  CONSTRAINT `fk_8yd_pcf_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_customization_fields_description` (
  `id_customization_field` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `label` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `placeholder` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id_customization_field`,`id_lang`),
  CONSTRAINT `fk_8yd_pcfd_cf` FOREIGN KEY (`id_customization_field`) REFERENCES `prefix_products_customization_fields` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_description` (
  `id_product` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `h1` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `short_description` text COLLATE utf8mb4_unicode_ci,
  `description` mediumtext COLLATE utf8mb4_unicode_ci,
  `meta_title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `meta_description` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `meta_keywords` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `slug` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `tags` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'через кому',
  `search_keywords` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'синоніми для внутрішнього пошуку',
  `text_in_stock` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `text_out_of_stock` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `delivery_text_in_stock` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `delivery_text_out_stock` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `unit_label` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'шт., уп., комплект',
  `og_title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `og_description` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `canonical_url` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `name_key` varchar(255) COLLATE utf8mb4_unicode_ci GENERATED ALWAYS AS (lower(trim(`name`))) STORED,
  PRIMARY KEY (`id_product`,`id_lang`),
  UNIQUE KEY `uq_slug` (`id_lang`,`slug`),
  KEY `idx_name` (`id_lang`,`name`),
  KEY `idx_name_key` (`id_lang`,`name_key`(191)),
  FULLTEXT KEY `ft_search` (`name`,`search_keywords`,`tags`),
  CONSTRAINT `fk_8yd_pd_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_download_links` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `nonce` char(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'випадкове значення; токен = HMAC(secret, id:nonce)',
  `id_download` int unsigned NOT NULL,
  `id_product` int unsigned NOT NULL,
  `ref_type` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'deal, order',
  `ref_id` int unsigned NOT NULL,
  `id_ref_item` int unsigned NOT NULL DEFAULT '0' COMMENT 'позиція документа',
  `max_downloads` smallint unsigned DEFAULT NULL,
  `downloads_count` smallint unsigned NOT NULL DEFAULT '0',
  `expires_at` datetime DEFAULT NULL,
  `revoked_at` datetime DEFAULT NULL,
  `id_user_revoked` int unsigned DEFAULT NULL,
  `last_download_at` datetime DEFAULT NULL,
  `last_ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_user_add` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_item_download` (`ref_type`,`ref_id`,`id_ref_item`,`id_download`),
  KEY `idx_ref` (`ref_type`,`ref_id`),
  KEY `fk_8yd_pdlk_download` (`id_download`),
  KEY `fk_8yd_pdlk_product` (`id_product`),
  CONSTRAINT `fk_8yd_pdlk_download` FOREIGN KEY (`id_download`) REFERENCES `prefix_products_downloads` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_pdlk_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_download_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_link` int unsigned NOT NULL,
  `ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `user_agent` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_link` (`id_link`,`date_add`),
  CONSTRAINT `fk_8yd_pdlg_link` FOREIGN KEY (`id_link`) REFERENCES `prefix_products_download_links` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_downloads` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned NOT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `file` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'поза public — віддається лише через підписане посилання',
  `original_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mime` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `size` bigint unsigned NOT NULL,
  `hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `version` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `max_downloads` smallint unsigned DEFAULT NULL COMMENT 'NULL = без обмеження',
  `expires_days` smallint unsigned DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_product` (`id_product`,`id_variant`),
  CONSTRAINT `fk_8yd_pdl_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_downloads_description` (
  `id_download` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id_download`,`id_lang`),
  CONSTRAINT `fk_8yd_pdld_dl` FOREIGN KEY (`id_download`) REFERENCES `prefix_products_downloads` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_duplicates_ignored` (
  `id_a` int unsigned NOT NULL,
  `id_b` int unsigned NOT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id_a`,`id_b`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_edit_locks` (
  `id_product` int unsigned NOT NULL,
  `lock_token` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'UUID вкладки',
  `id_user` int unsigned NOT NULL,
  `socket_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `expires_at` datetime(3) NOT NULL,
  `date_add` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id_product`),
  KEY `idx_expires` (`expires_at`),
  KEY `idx_socket` (`socket_id`),
  CONSTRAINT `fk_8yd_pel2_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_external_links` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned NOT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `id_integration` int unsigned NOT NULL,
  `external_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `external_variant_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `external_sku` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sync_hash` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'хеш останнього відправленого стану',
  `last_sync_at` datetime DEFAULT NULL,
  `last_error` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_local` (`id_integration`,`id_product`,`id_variant`),
  UNIQUE KEY `uq_external` (`id_integration`,`external_id`,`external_variant_id`),
  KEY `idx_product` (`id_product`),
  CONSTRAINT `fk_8yd_pel_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_html_images` (
  `entity` enum('products','categories','brands') COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_entity` int unsigned NOT NULL,
  `id_lang` int unsigned NOT NULL,
  `kind` enum('products','categories','brands') COLLATE utf8mb4_unicode_ci NOT NULL,
  `file` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`entity`,`id_entity`,`id_lang`,`kind`,`file`),
  KEY `idx_file` (`kind`,`file`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_import_items` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_job` int unsigned NOT NULL,
  `external_id` int unsigned NOT NULL COMMENT 'product_id на сайті',
  `external_sku` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `action` enum('create','link','update','skip','error') COLLATE utf8mb4_unicode_ci NOT NULL,
  `matched_by` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'правило, що спрацювало: link, sku→sku…',
  `id_product` int unsigned DEFAULT NULL,
  `link_new` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'зв''язок створено цим завданням',
  `message` varchar(2000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `warnings` text COLLATE utf8mb4_unicode_ci COMMENT 'JSON',
  `preview` mediumtext COLLATE utf8mb4_unicode_ci COMMENT 'JSON: як товар потрапить у систему (перші 300)',
  `before_state` mediumtext COLLATE utf8mb4_unicode_ci,
  `related` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_job_external` (`id_job`,`external_id`),
  KEY `idx_job_action` (`id_job`,`action`),
  CONSTRAINT `fk_import_items_job` FOREIGN KEY (`id_job`) REFERENCES `prefix_products_import_jobs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_import_jobs` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_integration` int unsigned NOT NULL,
  `mode` enum('dry','trial','full') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'dry' COMMENT 'dry — тест без запису, trial — пробний із відкатом, full — повний',
  `source` enum('manual','module','schedule') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual',
  `status` enum('queued','running','done','failed','cancelled','interrupted','rolling_back','rolled_back') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'queued',
  `options` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'JSON: правила зіставлення та що переносити',
  `created_refs` text COLLATE utf8mb4_unicode_ci COMMENT 'JSON: створені категорії / бренди (для відкату)',
  `cursor_after` int unsigned NOT NULL DEFAULT '0' COMMENT 'останній оброблений product_id сайту (продовження)',
  `total` int unsigned NOT NULL DEFAULT '0',
  `processed` int unsigned NOT NULL DEFAULT '0',
  `created` int unsigned NOT NULL DEFAULT '0',
  `linked` int unsigned NOT NULL DEFAULT '0',
  `updated` int unsigned NOT NULL DEFAULT '0',
  `skipped` int unsigned NOT NULL DEFAULT '0',
  `errors` int unsigned NOT NULL DEFAULT '0',
  `warnings` int unsigned NOT NULL DEFAULT '0',
  `message` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_start` datetime DEFAULT NULL,
  `date_end` datetime DEFAULT NULL,
  `heartbeat` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_integration` (`id_integration`,`id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_languages` (
  `id` tinyint unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'BCP 47: uk, en, ar, pt-BR, zh-Hans',
  `name` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'назва англійською',
  `native_name` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'назва мовою оригіналу',
  `direction` enum('ltr','rtl') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'ltr',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0',
  `primary_flag` tinyint GENERATED ALWAYS AS (if((`is_primary` = 1),1,NULL)) STORED COMMENT 'гарантує одну основну мову',
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`),
  UNIQUE KEY `uq_primary` (`primary_flag`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_media` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned NOT NULL,
  `type` enum('image','video','external_video','model_3d') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'image',
  `file` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'відносний шлях у public/images/products',
  `url` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'YouTube/Vimeo для external_video',
  `hash` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'sha256 оригіналу — дедуп',
  `mime` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `width` int unsigned DEFAULT NULL,
  `height` int unsigned DEFAULT NULL,
  `size` int unsigned DEFAULT NULL COMMENT 'байти',
  `is_cover` tinyint(1) NOT NULL DEFAULT '0',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_product` (`id_product`,`sort_order`),
  KEY `idx_hash` (`hash`),
  CONSTRAINT `fk_8yd_pm_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_media_description` (
  `id_media` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `alt` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id_media`,`id_lang`),
  CONSTRAINT `fk_8yd_pmd_media` FOREIGN KEY (`id_media`) REFERENCES `prefix_products_media` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_metafields` (
  `id_product` int unsigned NOT NULL,
  `id_definition` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '0 = не перекладається',
  `value` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id_product`,`id_definition`,`id_lang`),
  KEY `idx_definition` (`id_definition`),
  CONSTRAINT `fk_8yd_pmf_def` FOREIGN KEY (`id_definition`) REFERENCES `prefix_products_metafields_definitions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_pmf_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_metafields_definitions` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `namespace` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'custom',
  `code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` enum('text','textarea','richtext','integer','decimal','boolean','date','datetime','url','json','color','product_ref','file') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'text',
  `is_translatable` tinyint(1) NOT NULL DEFAULT '0',
  `validation` json DEFAULT NULL COMMENT '{min,max,regex,choices}',
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ns_code` (`namespace`,`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_option_values` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_option` int unsigned NOT NULL,
  `image` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `color_hex` char(7) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_option` (`id_option`,`sort_order`),
  CONSTRAINT `fk_8yd_pov_opt` FOREIGN KEY (`id_option`) REFERENCES `prefix_products_options` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_option_values_description` (
  `id_option_value` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id_option_value`,`id_lang`),
  CONSTRAINT `fk_8yd_povd_val` FOREIGN KEY (`id_option_value`) REFERENCES `prefix_products_option_values` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_options` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` enum('select','radio','checkbox','color','text','textarea','number','file','date','time','datetime') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'select',
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_options_description` (
  `id_option` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id_option`,`id_lang`),
  CONSTRAINT `fk_8yd_pod_opt` FOREIGN KEY (`id_option`) REFERENCES `prefix_products_options` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_price_schedule` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned NOT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `field` enum('price','compare_at_price') COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` decimal(15,4) DEFAULT NULL,
  `set_compare_at` tinyint(1) NOT NULL DEFAULT '0',
  `run_at` datetime NOT NULL,
  `revert_at` datetime DEFAULT NULL,
  `status` enum('pending','applied','reverted','canceled','failed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `old_price` decimal(15,4) DEFAULT NULL,
  `old_compare_at` decimal(15,4) DEFAULT NULL,
  `applied_at` datetime DEFAULT NULL,
  `reverted_at` datetime DEFAULT NULL,
  `error` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `comment` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `currency` char(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_run` (`status`,`run_at`),
  KEY `idx_revert` (`status`,`revert_at`),
  KEY `idx_product` (`id_product`,`id_variant`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_prices` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned NOT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `kind` enum('special','tier') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'special',
  `id_customer_group` int unsigned NOT NULL DEFAULT '0' COMMENT '0 = усі',
  `id_store` int unsigned NOT NULL DEFAULT '0' COMMENT '0 = усі',
  `currency` char(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'NULL = базова',
  `min_qty` decimal(15,3) NOT NULL DEFAULT '1.000',
  `reduction_type` enum('new_price','fixed','percent') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'new_price',
  `value` decimal(15,4) NOT NULL,
  `priority` int NOT NULL DEFAULT '0',
  `date_start` datetime DEFAULT NULL,
  `date_end` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `value_cur` decimal(15,4) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lookup` (`id_product`,`id_variant`,`id_customer_group`,`min_qty`),
  KEY `idx_dates` (`date_start`,`date_end`),
  KEY `idx_currency` (`currency`),
  CONSTRAINT `fk_8yd_ppr_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_related` (
  `id_product` int unsigned NOT NULL,
  `id_related` int unsigned NOT NULL,
  `type` enum('related','upsell','crosssell','accessory') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'related',
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id_product`,`id_related`,`type`),
  KEY `idx_related` (`id_related`),
  CONSTRAINT `fk_8yd_prl_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_prl_related` FOREIGN KEY (`id_related`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_reviews` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned DEFAULT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `id_client` int unsigned DEFAULT NULL,
  `id_lang` int unsigned DEFAULT NULL,
  `id_integration` int unsigned DEFAULT NULL,
  `external_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `external_product_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `rating` tinyint unsigned NOT NULL,
  `author_name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `author_email` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `body` text COLLATE utf8mb4_unicode_ci,
  `pros` text COLLATE utf8mb4_unicode_ci,
  `cons` text COLLATE utf8mb4_unicode_ci,
  `verified_purchase` tinyint(1) NOT NULL DEFAULT '0',
  `status` enum('pending','approved','rejected','spam') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `reply` text COLLATE utf8mb4_unicode_ci,
  `reply_at` datetime DEFAULT NULL,
  `id_user_reply` int unsigned DEFAULT NULL,
  `need_push` tinyint(1) NOT NULL DEFAULT '0',
  `moderated_at` datetime DEFAULT NULL,
  `id_user_moderated` int unsigned DEFAULT NULL,
  `id_user_add` int unsigned DEFAULT NULL,
  `ip` varbinary(16) DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_upd` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` datetime DEFAULT NULL,
  `source` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual',
  `source_url` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_external` (`id_integration`,`external_id`),
  KEY `idx_product` (`id_product`,`status`),
  KEY `idx_status` (`status`,`date_add`),
  KEY `idx_push` (`id_integration`,`need_push`),
  KEY `idx_client` (`id_client`),
  KEY `idx_source` (`source`),
  CONSTRAINT `chk_review_rating` CHECK ((`rating` between 1 and 5))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_reviews_media` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_review` bigint unsigned NOT NULL,
  `file` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_review` (`id_review`),
  KEY `idx_file` (`file`),
  CONSTRAINT `fk_review_media` FOREIGN KEY (`id_review`) REFERENCES `prefix_products_reviews` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_reviews_sites` (
  `id_review` int unsigned NOT NULL,
  `id_integration` int unsigned NOT NULL,
  `publish_at` datetime NOT NULL,
  `state` enum('wait','sent','error','remove') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'wait',
  `rev` int unsigned NOT NULL DEFAULT '1',
  `external_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sent_at` datetime DEFAULT NULL,
  `attempt_at` datetime DEFAULT NULL,
  `last_error` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id_review`,`id_integration`),
  KEY `idx_due` (`id_integration`,`state`,`publish_at`),
  KEY `idx_ext` (`id_integration`,`external_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_reviews_sync` (
  `id_integration` int unsigned NOT NULL,
  `cursor_value` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_pull` datetime DEFAULT NULL,
  `last_error` varchar(1024) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id_integration`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_rewards` (
  `id_product` int unsigned NOT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `id_customer_group` int unsigned NOT NULL DEFAULT '0' COMMENT '0 = усі',
  `points` int unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id_product`,`id_variant`,`id_customer_group`),
  CONSTRAINT `fk_8yd_prw_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_sequences` (
  `name` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` bigint unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_settings` (
  `setting_key` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` json NOT NULL,
  `id_user_edit` int unsigned DEFAULT NULL,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_stock` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned NOT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `id_warehouse` int unsigned NOT NULL,
  `id_location` int unsigned DEFAULT NULL,
  `on_hand` decimal(15,3) NOT NULL DEFAULT '0.000' COMMENT 'фізично на складі',
  `reserved` decimal(15,3) NOT NULL DEFAULT '0.000' COMMENT 'під замовлення',
  `incoming` decimal(15,3) NOT NULL DEFAULT '0.000' COMMENT 'очікується',
  `available` decimal(15,3) GENERATED ALWAYS AS ((`on_hand` - `reserved`)) STORED,
  `reorder_point` decimal(15,3) DEFAULT NULL,
  `reorder_qty` decimal(15,3) DEFAULT NULL,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_item` (`id_product`,`id_variant`,`id_warehouse`),
  KEY `idx_warehouse` (`id_warehouse`,`available`),
  KEY `idx_location` (`id_location`),
  CONSTRAINT `fk_8yd_pst_location` FOREIGN KEY (`id_location`) REFERENCES `prefix_products_warehouse_locations` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_8yd_pst_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_pst_wh` FOREIGN KEY (`id_warehouse`) REFERENCES `prefix_products_warehouses` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_stock_batches` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned NOT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `id_warehouse` int unsigned NOT NULL,
  `batch_no` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `production_date` date DEFAULT NULL,
  `expiry_date` date DEFAULT NULL,
  `qty` decimal(15,3) NOT NULL DEFAULT '0.000',
  `cost_price` decimal(15,4) DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_batch` (`id_product`,`id_variant`,`id_warehouse`,`batch_no`),
  KEY `idx_expiry` (`id_warehouse`,`expiry_date`),
  CONSTRAINT `fk_8yd_psb_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_psb_wh` FOREIGN KEY (`id_warehouse`) REFERENCES `prefix_products_warehouses` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_stock_documents` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `number` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` enum('receipt','transfer','writeoff','inventory','return','adjustment') COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('draft','posted','cancelled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'draft',
  `version` int unsigned NOT NULL DEFAULT '1',
  `id_warehouse` int unsigned NOT NULL COMMENT 'для transfer — склад-джерело',
  `id_warehouse_to` int unsigned DEFAULT NULL COMMENT 'для transfer — склад-отримувач',
  `id_supplier` int unsigned DEFAULT NULL,
  `external_number` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'номер накладної постачальника',
  `currency` char(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `comment` text COLLATE utf8mb4_unicode_ci,
  `id_user_add` int unsigned DEFAULT NULL,
  `id_user_posted` int unsigned DEFAULT NULL,
  `date_document` date NOT NULL,
  `date_posted` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_number` (`type`,`number`),
  KEY `idx_list` (`status`,`date_document`),
  KEY `fk_8yd_psd_wh` (`id_warehouse`),
  KEY `fk_8yd_psd_wh_to` (`id_warehouse_to`),
  KEY `fk_8yd_psd_supplier` (`id_supplier`),
  CONSTRAINT `fk_8yd_psd_supplier` FOREIGN KEY (`id_supplier`) REFERENCES `prefix_products_suppliers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_8yd_psd_wh` FOREIGN KEY (`id_warehouse`) REFERENCES `prefix_products_warehouses` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_8yd_psd_wh_to` FOREIGN KEY (`id_warehouse_to`) REFERENCES `prefix_products_warehouses` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_stock_documents_items` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_document` int unsigned NOT NULL,
  `id_product` int unsigned NOT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `id_location` int unsigned DEFAULT NULL,
  `batch_no` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `expiry_date` date DEFAULT NULL,
  `qty` decimal(15,3) NOT NULL COMMENT 'для inventory — фактична кількість',
  `qty_expected` decimal(15,3) DEFAULT NULL COMMENT 'для inventory — облікова на момент підрахунку',
  `cost_price` decimal(15,4) DEFAULT NULL,
  `serials` json DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_document` (`id_document`),
  KEY `idx_product` (`id_product`,`id_variant`),
  CONSTRAINT `fk_8yd_psdi_doc` FOREIGN KEY (`id_document`) REFERENCES `prefix_products_stock_documents` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_psdi_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_stock_movements` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned NOT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `id_warehouse` int unsigned NOT NULL,
  `id_batch` int unsigned DEFAULT NULL,
  `type` enum('receipt','sale','return','transfer_in','transfer_out','adjustment','writeoff','inventory','reserve','unreserve','bundle_assembly','bundle_disassembly') COLLATE utf8mb4_unicode_ci NOT NULL,
  `qty` decimal(15,3) NOT NULL COMMENT '± зміна',
  `field` enum('on_hand','reserved','incoming') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'on_hand',
  `qty_before` decimal(15,3) NOT NULL,
  `qty_after` decimal(15,3) NOT NULL,
  `cost_price` decimal(15,4) DEFAULT NULL,
  `ref_type` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'document, order, deal, manual, import',
  `ref_id` int unsigned DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `comment` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_item` (`id_product`,`id_variant`,`id_warehouse`,`date_add`),
  KEY `idx_ref` (`ref_type`,`ref_id`),
  KEY `idx_date` (`date_add`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_stock_reservations` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned NOT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `id_warehouse` int unsigned NOT NULL,
  `qty` decimal(15,3) NOT NULL,
  `ref_type` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ref_id` int unsigned NOT NULL,
  `expires_at` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ref_item` (`ref_type`,`ref_id`,`id_product`,`id_variant`,`id_warehouse`),
  KEY `idx_expires` (`expires_at`),
  KEY `fk_8yd_psr_product` (`id_product`),
  KEY `fk_8yd_psr_wh` (`id_warehouse`),
  CONSTRAINT `fk_8yd_psr_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_psr_wh` FOREIGN KEY (`id_warehouse`) REFERENCES `prefix_products_warehouses` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_stock_serials` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned NOT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `id_warehouse` int unsigned DEFAULT NULL,
  `id_batch` int unsigned DEFAULT NULL,
  `serial` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('in_stock','reserved','sold','returned','written_off') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'in_stock',
  `ref_type` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'order, deal…',
  `ref_id` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_serial` (`id_product`,`serial`),
  KEY `idx_status` (`id_product`,`id_variant`,`status`),
  KEY `idx_ref` (`ref_type`,`ref_id`),
  KEY `fk_8yd_pss_wh` (`id_warehouse`),
  KEY `fk_8yd_pss_batch` (`id_batch`),
  CONSTRAINT `fk_8yd_pss_batch` FOREIGN KEY (`id_batch`) REFERENCES `prefix_products_stock_batches` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_8yd_pss_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_pss_wh` FOREIGN KEY (`id_warehouse`) REFERENCES `prefix_products_warehouses` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_stock_statuses` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `color` char(7) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_stock_statuses_description` (
  `id_stock_status` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id_stock_status`,`id_lang`),
  CONSTRAINT `fk_8yd_pssd_ss` FOREIGN KEY (`id_stock_status`) REFERENCES `prefix_products_stock_statuses` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_subscription_plans` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned NOT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `interval_unit` enum('day','week','month','year') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'month',
  `interval_count` smallint unsigned NOT NULL DEFAULT '1',
  `cycles` smallint unsigned DEFAULT NULL COMMENT 'NULL = безстроково',
  `trial_days` smallint unsigned NOT NULL DEFAULT '0',
  `discount_type` enum('none','fixed','percent') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'none',
  `discount_value` decimal(15,4) NOT NULL DEFAULT '0.0000',
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_product` (`id_product`,`id_variant`),
  CONSTRAINT `fk_8yd_psp_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_suppliers` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `tax_number` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `contact_person` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'E.164',
  `website` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `address` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `country` char(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `currency` char(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ISO 4217',
  `lead_time_days` smallint unsigned DEFAULT NULL,
  `note` text COLLATE utf8mb4_unicode_ci,
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` datetime DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_sync_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_integration` int unsigned NOT NULL,
  `action` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `trigger` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `total` int unsigned NOT NULL DEFAULT '0',
  `sent` int unsigned NOT NULL DEFAULT '0',
  `ok` int unsigned NOT NULL DEFAULT '0',
  `errors` int unsigned NOT NULL DEFAULT '0',
  `message` varchar(1024) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `duration_ms` int unsigned NOT NULL DEFAULT '0',
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_integration` (`id_integration`,`date_add`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_sync_settings` (
  `id_integration` int unsigned NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '0',
  `push_price` tinyint(1) NOT NULL DEFAULT '1',
  `push_stock` tinyint(1) NOT NULL DEFAULT '1',
  `push_status` tinyint(1) NOT NULL DEFAULT '1',
  `push_seo` tinyint(1) NOT NULL DEFAULT '0',
  `push_content` tinyint(1) NOT NULL DEFAULT '0',
  `pull_reviews` tinyint(1) NOT NULL DEFAULT '0',
  `warehouses` json DEFAULT NULL COMMENT 'id складів-джерел залишку; NULL/[] — усі продавані',
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id_integration`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_tax_classes` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `rate` decimal(7,4) NOT NULL DEFAULT '0.0000' COMMENT 'відсоток: 20.0000',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_tax_classes_description` (
  `id_tax_class` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id_tax_class`,`id_lang`),
  CONSTRAINT `fk_8yd_ptcd_tc` FOREIGN KEY (`id_tax_class`) REFERENCES `prefix_products_tax_classes` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_to_attachments` (
  `id_product` int unsigned NOT NULL,
  `id_attachment` int unsigned NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id_product`,`id_attachment`),
  KEY `idx_attachment` (`id_attachment`),
  CONSTRAINT `fk_8yd_pta_att` FOREIGN KEY (`id_attachment`) REFERENCES `prefix_products_attachments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_pta_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_to_attributes` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned NOT NULL,
  `id_attribute` int unsigned NOT NULL,
  `id_attribute_value` int unsigned DEFAULT NULL,
  `value_number` decimal(20,6) DEFAULT NULL,
  `value_date` date DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_prod_attr_val` (`id_product`,`id_attribute`,`id_attribute_value`),
  KEY `idx_filter_value` (`id_attribute_value`,`id_product`),
  KEY `idx_filter_number` (`id_attribute`,`value_number`),
  CONSTRAINT `fk_8yd_ptat_attr` FOREIGN KEY (`id_attribute`) REFERENCES `prefix_products_attributes` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_ptat_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_ptat_value` FOREIGN KEY (`id_attribute_value`) REFERENCES `prefix_products_attribute_values` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_to_attributes_text` (
  `id_product` int unsigned NOT NULL,
  `id_attribute` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL COMMENT '0 = не перекладається',
  `value` text COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id_product`,`id_attribute`,`id_lang`),
  KEY `idx_attr` (`id_attribute`),
  CONSTRAINT `fk_8yd_ptatt_attr` FOREIGN KEY (`id_attribute`) REFERENCES `prefix_products_attributes` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_ptatt_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_to_carriers` (
  `id_product` int unsigned NOT NULL,
  `carrier_code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id_product`,`carrier_code`),
  CONSTRAINT `fk_8yd_ptcr_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_to_categories` (
  `id_product` int unsigned NOT NULL,
  `id_category` int unsigned NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0' COMMENT 'позиція товару в категорії',
  PRIMARY KEY (`id_product`,`id_category`),
  KEY `idx_category` (`id_category`,`sort_order`),
  CONSTRAINT `fk_8yd_ptc_category` FOREIGN KEY (`id_category`) REFERENCES `prefix_products_categories` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_ptc_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_to_customer_groups` (
  `id_product` int unsigned NOT NULL,
  `id_customer_group` int unsigned NOT NULL,
  PRIMARY KEY (`id_product`,`id_customer_group`),
  CONSTRAINT `fk_8yd_ptcg_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_to_option_values` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_product_option` int unsigned NOT NULL,
  `id_option_value` int unsigned NOT NULL,
  `price_mode` enum('fixed','percent') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'fixed',
  `price` decimal(15,4) NOT NULL DEFAULT '0.0000' COMMENT '± до ціни',
  `points` int NOT NULL DEFAULT '0' COMMENT '± бали',
  `weight` decimal(12,4) NOT NULL DEFAULT '0.0000' COMMENT '± вага',
  `quantity` decimal(15,3) DEFAULT NULL COMMENT 'власний залишок значення (OpenCart)',
  `subtract_stock` tinyint(1) NOT NULL DEFAULT '0',
  `sku_suffix` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `sort_order` int NOT NULL DEFAULT '0',
  `price_currency` char(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `price_cur` decimal(15,4) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_po_val` (`id_product_option`,`id_option_value`),
  KEY `idx_value` (`id_option_value`),
  CONSTRAINT `fk_8yd_ptov_po` FOREIGN KEY (`id_product_option`) REFERENCES `prefix_products_to_options` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_ptov_val` FOREIGN KEY (`id_option_value`) REFERENCES `prefix_products_option_values` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_to_options` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned NOT NULL,
  `id_option` int unsigned NOT NULL,
  `is_required` tinyint(1) NOT NULL DEFAULT '0',
  `default_value` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'для text/number/date',
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_prod_opt` (`id_product`,`id_option`),
  KEY `idx_option` (`id_option`),
  CONSTRAINT `fk_8yd_pto_option` FOREIGN KEY (`id_option`) REFERENCES `prefix_products_options` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_8yd_pto_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_to_stores` (
  `id_product` int unsigned NOT NULL,
  `id_store` int unsigned NOT NULL,
  PRIMARY KEY (`id_product`,`id_store`),
  KEY `idx_store` (`id_store`),
  CONSTRAINT `fk_8yd_pts_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_to_suppliers` (
  `id_product` int unsigned NOT NULL,
  `id_variant` int unsigned NOT NULL DEFAULT '0',
  `id_supplier` int unsigned NOT NULL,
  `supplier_sku` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `supplier_price` decimal(15,4) DEFAULT NULL,
  `currency` char(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `lead_time_days` smallint unsigned DEFAULT NULL,
  `min_order_qty` decimal(15,3) DEFAULT NULL,
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id_product`,`id_variant`,`id_supplier`),
  KEY `idx_supplier_sku` (`id_supplier`,`supplier_sku`),
  CONSTRAINT `fk_8yd_ptsu_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_ptsu_supplier` FOREIGN KEY (`id_supplier`) REFERENCES `prefix_products_suppliers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_url_history` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `entity` enum('products','categories','brands') COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_entity` int unsigned NOT NULL,
  `id_lang` tinyint unsigned NOT NULL,
  `slug` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_slug` (`entity`,`id_lang`,`slug`),
  KEY `idx_entity` (`entity`,`id_entity`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_variant_axes` (
  `id_product` int unsigned NOT NULL,
  `id_attribute` int unsigned NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id_product`,`id_attribute`),
  KEY `fk_8yd_pva_attr` (`id_attribute`),
  CONSTRAINT `fk_8yd_pva_attr` FOREIGN KEY (`id_attribute`) REFERENCES `prefix_products_attributes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_8yd_pva_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_variant_media` (
  `id_variant` int unsigned NOT NULL,
  `id_media` int unsigned NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id_variant`,`id_media`),
  KEY `idx_media` (`id_media`),
  CONSTRAINT `fk_8yd_pvm_media` FOREIGN KEY (`id_media`) REFERENCES `prefix_products_media` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_8yd_pvm_variant` FOREIGN KEY (`id_variant`) REFERENCES `prefix_products_variants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_variant_values` (
  `id_variant` int unsigned NOT NULL,
  `id_attribute` int unsigned NOT NULL,
  `id_attribute_value` int unsigned NOT NULL,
  PRIMARY KEY (`id_variant`,`id_attribute`),
  KEY `idx_value` (`id_attribute_value`),
  KEY `fk_8yd_pvv_attr` (`id_attribute`),
  CONSTRAINT `fk_8yd_pvv_attr` FOREIGN KEY (`id_attribute`) REFERENCES `prefix_products_attributes` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_8yd_pvv_value` FOREIGN KEY (`id_attribute_value`) REFERENCES `prefix_products_attribute_values` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_8yd_pvv_variant` FOREIGN KEY (`id_variant`) REFERENCES `prefix_products_variants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_variants` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_product` int unsigned NOT NULL,
  `uuid` char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `combination_key` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'відсортовані id значень: "12-45" — унікальність комбінації',
  `sku` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `mpn` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ean` varchar(14) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `upc` varchar(12) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `jan` varchar(13) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `isbn` varchar(17) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `price_mode` enum('impact','fixed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'impact',
  `price` decimal(15,4) NOT NULL DEFAULT '0.0000' COMMENT 'impact (±) або фіксована',
  `compare_at_price` decimal(15,4) DEFAULT NULL,
  `cost_price` decimal(15,4) DEFAULT NULL,
  `wholesale_price` decimal(15,4) DEFAULT NULL,
  `unit_price_impact` decimal(15,4) DEFAULT NULL,
  `points_price` int unsigned DEFAULT NULL,
  `weight_impact` decimal(12,4) DEFAULT NULL,
  `length` decimal(12,4) DEFAULT NULL,
  `width` decimal(12,4) DEFAULT NULL,
  `height` decimal(12,4) DEFAULT NULL,
  `min_qty` decimal(15,3) DEFAULT NULL,
  `low_stock_threshold` decimal(15,3) DEFAULT NULL,
  `out_of_stock_action` enum('inherit','deny','backorder','preorder') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'inherit',
  `available_date` date DEFAULT NULL,
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `price_currency` char(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `price_cur` decimal(15,4) DEFAULT NULL,
  `compare_cur` decimal(15,4) DEFAULT NULL,
  `cost_currency` char(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `cost_cur` decimal(15,4) DEFAULT NULL,
  `price_auto` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_uuid` (`uuid`),
  UNIQUE KEY `uq_combination` (`id_product`,`combination_key`),
  UNIQUE KEY `uq_sku` (`sku`),
  KEY `idx_ean` (`ean`),
  CONSTRAINT `fk_8yd_pv_product` FOREIGN KEY (`id_product`) REFERENCES `prefix_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_warehouse_locations` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_warehouse` int unsigned NOT NULL,
  `code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'A-01-03',
  `name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wh_code` (`id_warehouse`,`code`),
  CONSTRAINT `fk_8yd_pwl_wh` FOREIGN KEY (`id_warehouse`) REFERENCES `prefix_products_warehouses` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_products_warehouses` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` enum('own','supplier','dropship','store','transit') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'own',
  `id_supplier` int unsigned DEFAULT NULL,
  `country` char(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `city` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `address` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `postcode` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `latitude` decimal(10,7) DEFAULT NULL,
  `longitude` decimal(10,7) DEFAULT NULL,
  `carrier_ref` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'напр. Ref відділення/складу перевізника',
  `phone` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `priority` int NOT NULL DEFAULT '0' COMMENT 'менше = раніше списується',
  `is_sellable` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'залишок враховується в доступності',
  `allow_negative` tinyint(1) NOT NULL DEFAULT '0',
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` datetime DEFAULT NULL,
  `id_user_deleted` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`code`),
  KEY `idx_active` (`deleted_at`,`status`,`priority`),
  KEY `fk_8yd_pw_supplier` (`id_supplier`),
  CONSTRAINT `fk_8yd_pw_supplier` FOREIGN KEY (`id_supplier`) REFERENCES `prefix_products_suppliers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_reports_jobs` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `report` varchar(48) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `params` json NOT NULL,
  `format` enum('xlsx','csv') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'xlsx',
  `status` enum('queued','running','done','failed') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'queued',
  `rows_count` int unsigned DEFAULT NULL,
  `size` bigint unsigned DEFAULT NULL,
  `file` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'шлях відносно REPORTS_DIR',
  `preview` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT 'перші рядки для перегляду',
  `error` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_user` int unsigned NOT NULL,
  `is_shared` tinyint(1) NOT NULL DEFAULT '1',
  `scope_all` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'автор бачив усі замовлення / клієнтів',
  `locale` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'uk',
  `id_lang` int unsigned NOT NULL DEFAULT '1',
  `downloads` int unsigned NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `started_at` datetime DEFAULT NULL,
  `finished_at` datetime DEFAULT NULL,
  `expires_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_status` (`status`,`id`),
  KEY `idx_user` (`id_user`,`status`),
  KEY `idx_report` (`report`,`is_shared`),
  KEY `idx_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_saved_filters` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `page` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'clients / orders / leads',
  `id_user` int unsigned NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `filters` json NOT NULL,
  `is_shared` tinyint(1) NOT NULL DEFAULT '0',
  `sort` int NOT NULL DEFAULT '0',
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_page_name` (`id_user`,`page`,`name`),
  KEY `idx_page_shared` (`page`,`is_shared`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_settings_integrations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Людська назва',
  `order_prefix` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `platform` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Ключ із реєстру платформ: opencart/prestashop/custom/contact-center…',
  `platform_version` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Версія платформи (2.3 / 3.0 …)',
  `default_status_id` int DEFAULT NULL COMMENT 'Стартовий статус замовлення (custom / contact-center)',
  `base_url` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Адреса сайту https://shop.com',
  `callback_url` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'API endpoint модуля (CRM→сайт: статуси, каталог, відгуки)',
  `outbound_token` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Ключ CRM→сайт (Bearer + HMAC)',
  `sync_orders_out` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Слати зміни замовлень CRM→сайт',
  `sync_status_out` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Слати зміни статусу CRM→сайт',
  `assortment_mode` enum('all','selected') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'all' COMMENT 'all — увесь каталог, крім вимкненого; selected — лише увімкнене',
  `color_text` varchar(9) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `color_background` varchar(9) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` enum('active','disabled') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `note` varchar(999) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  `price_rule` json DEFAULT NULL,
  `required_fields` json DEFAULT NULL,
  `alert_emails` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `health_state` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `health_message` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `health_version` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `health_at` datetime DEFAULT NULL,
  `stock_rule` json DEFAULT NULL,
  `content_rule` json DEFAULT NULL,
  `sync_auto_at` datetime DEFAULT NULL,
  `sync_auto_movement` bigint unsigned NOT NULL DEFAULT '0',
  `sync_full_at` datetime DEFAULT NULL,
  `prune_blocked` int unsigned NOT NULL DEFAULT '0',
  `prune_confirm` tinyint(1) NOT NULL DEFAULT '0',
  `recon_missing` int unsigned DEFAULT NULL,
  `recon_extra` int unsigned DEFAULT NULL,
  `recon_modified` int unsigned DEFAULT NULL,
  `recon_unlinked` int unsigned DEFAULT NULL,
  `recon_at` datetime DEFAULT NULL,
  `category_mode` varchar(8) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'system',
  `category_unmapped` varchar(8) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'skip',
  `category_default` int unsigned DEFAULT NULL,
  `category_root` int unsigned DEFAULT NULL,
  `category_tree` mediumtext COLLATE utf8mb4_unicode_ci,
  `category_tree_at` datetime DEFAULT NULL,
  `category_rules` mediumtext COLLATE utf8mb4_unicode_ci,
  `import_schedule_hours` smallint unsigned NOT NULL DEFAULT '0',
  `import_schedule_at` time NOT NULL DEFAULT '03:00:00',
  `import_schedule_options` text COLLATE utf8mb4_unicode_ci,
  `import_schedule_last` datetime DEFAULT NULL,
  `notify` json DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_status` (`status`),
  KEY `idx_platform` (`platform`),
  KEY `idx_default_status` (`default_status_id`),
  CONSTRAINT `fk_si_default_status` FOREIGN KEY (`default_status_id`) REFERENCES `prefix_orders_status` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_settings_integrations_assortment` (
  `id_integration` int NOT NULL,
  `entity` enum('category','product') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_entity` int unsigned NOT NULL,
  `mode` enum('include','exclude') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `date_edit` datetime NOT NULL,
  `overrides` json DEFAULT NULL,
  `err_message` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `err_attempts` int unsigned NOT NULL DEFAULT '0',
  `err_at` datetime DEFAULT NULL,
  `retry_at` datetime DEFAULT NULL,
  `sent_hash` char(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sent_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id_integration`,`entity`,`id_entity`),
  KEY `idx_entity` (`entity`,`id_entity`),
  KEY `idx_retry` (`entity`,`retry_at`),
  KEY `idx_int_edit` (`id_integration`,`entity`,`date_edit`),
  CONSTRAINT `fk_sia_integration` FOREIGN KEY (`id_integration`) REFERENCES `prefix_settings_integrations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_settings_integrations_tokens` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_integration` int NOT NULL COMMENT 'Інтеграція, якій належить токен',
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `prefix` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Перші символи для впізнавання (ok_live_a3f9)',
  `token_hash` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'SHA-256 повного токена',
  `last4` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `environment` enum('live','test') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'live',
  `id_user` int DEFAULT NULL COMMENT 'Хто створив',
  `allowed_domains` json DEFAULT NULL COMMENT '["shop.com"]; null/[] = будь-який',
  `allowed_ips` json DEFAULT NULL COMMENT '["1.2.3.4"]; null/[] = будь-який',
  `source_check_mode` enum('any','all','off') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'any',
  `can_create_orders` tinyint(1) NOT NULL DEFAULT '1',
  `can_update_orders` tinyint(1) NOT NULL DEFAULT '0',
  `can_update_status` tinyint(1) NOT NULL DEFAULT '0',
  `can_create_clients` tinyint(1) NOT NULL DEFAULT '1',
  `can_read` tinyint(1) NOT NULL DEFAULT '0',
  `can_sync_carts` tinyint(1) NOT NULL DEFAULT '0',
  `status` enum('active','disabled') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `expires_at` datetime DEFAULT NULL,
  `revoked_at` datetime DEFAULT NULL,
  `revoked_by` int DEFAULT NULL,
  `revoked_reason` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_used_at` datetime DEFAULT NULL,
  `last_used_ip` varbinary(16) DEFAULT NULL COMMENT 'INET6_ATON',
  `last_used_domain` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `usage_count` bigint unsigned NOT NULL DEFAULT '0',
  `error_count` bigint unsigned NOT NULL DEFAULT '0',
  `note` varchar(999) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  `can_set_rates` tinyint(1) NOT NULL DEFAULT '0',
  `can_import_products` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_token_hash` (`token_hash`),
  KEY `idx_integration` (`id_integration`),
  KEY `idx_prefix` (`prefix`),
  KEY `idx_status` (`status`),
  KEY `idx_expires` (`expires_at`),
  CONSTRAINT `fk_sit_integration` FOREIGN KEY (`id_integration`) REFERENCES `prefix_settings_integrations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_settings_integrations_tokens_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_token` bigint unsigned DEFAULT NULL COMMENT 'null, якщо токен не розпізнано',
  `prefix` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ip` varbinary(16) DEFAULT NULL COMMENT 'INET6_ATON',
  `domain` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `method` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `endpoint` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `user_agent` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `result` enum('success','rejected') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `reject_reason` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `http_status` int DEFAULT NULL,
  `id_order` bigint unsigned DEFAULT NULL,
  `external_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `message` varchar(999) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_date` (`date_add`),
  KEY `idx_external` (`external_id`),
  KEY `idx_token_result` (`id_token`,`result`,`id`),
  KEY `idx_result_date` (`result`,`date_add`),
  CONSTRAINT `fk_sitl_token` FOREIGN KEY (`id_token`) REFERENCES `prefix_settings_integrations_tokens` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_social_accounts` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `network` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_channel` int unsigned DEFAULT NULL,
  `token_cipher` blob,
  `token_iv` varbinary(32) DEFAULT NULL,
  `token_tag` varbinary(32) DEFAULT NULL,
  `target` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `external_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `external_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `external_username` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `external_picture` text COLLATE utf8mb4_unicode_ci,
  `scopes` text COLLATE utf8mb4_unicode_ci,
  `tg_update_offset` bigint DEFAULT NULL,
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `last_check` datetime DEFAULT NULL,
  `last_error` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_upd` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_network` (`network`,`deleted`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_social_media` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `kind` enum('image','video') COLLATE utf8mb4_unicode_ci NOT NULL,
  `path` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `original_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `mime` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `size` bigint unsigned NOT NULL DEFAULT '0',
  `width` int unsigned DEFAULT NULL,
  `height` int unsigned DEFAULT NULL,
  `sha256` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_sha` (`sha256`),
  KEY `idx_list` (`deleted`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_social_post_log` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_post` int unsigned NOT NULL,
  `id_target` int unsigned DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `action` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `note` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `details` json DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_post` (`id_post`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_social_post_media` (
  `id_post` int unsigned NOT NULL,
  `id_media` int unsigned NOT NULL,
  `sort_order` smallint unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id_post`,`id_media`),
  KEY `idx_media` (`id_media`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_social_post_stats` (
  `id_target` int unsigned NOT NULL,
  `likes` int unsigned DEFAULT NULL,
  `comments` int unsigned DEFAULT NULL,
  `shares` int unsigned DEFAULT NULL,
  `saves` int unsigned DEFAULT NULL,
  `reach` int unsigned DEFAULT NULL,
  `views` int unsigned DEFAULT NULL,
  `interactions` int unsigned DEFAULT NULL,
  `raw` json DEFAULT NULL,
  `error` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_fetched` datetime NOT NULL,
  `next_fetch` datetime DEFAULT NULL,
  PRIMARY KEY (`id_target`),
  KEY `idx_next` (`next_fetch`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_social_post_targets` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_post` int unsigned NOT NULL,
  `id_account` int unsigned NOT NULL,
  `format` enum('post','story','reel') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'post',
  `text` text COLLATE utf8mb4_unicode_ci,
  `status` enum('pending','processing','waiting','published','failed','canceled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `attempts` tinyint unsigned NOT NULL DEFAULT '0',
  `next_attempt_at` datetime DEFAULT NULL,
  `lock_token` char(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `locked_until` datetime DEFAULT NULL,
  `state` json DEFAULT NULL,
  `external_id` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `permalink` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `error` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_published` datetime DEFAULT NULL,
  `comment_status` enum('none','pending','done','failed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'none',
  `comment_id` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `comment_error` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `comment_due` datetime DEFAULT NULL,
  `date_upd` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_post_account_format` (`id_post`,`id_account`,`format`),
  KEY `idx_queue` (`status`,`next_attempt_at`),
  KEY `idx_lock` (`lock_token`),
  KEY `idx_comment` (`comment_status`,`comment_due`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_social_post_variants` (
  `id_post` int unsigned NOT NULL,
  `network` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `text` text COLLATE utf8mb4_unicode_ci,
  `first_comment` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id_post`,`network`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_social_posts` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `text` text COLLATE utf8mb4_unicode_ci,
  `first_comment` text COLLATE utf8mb4_unicode_ci,
  `status` enum('draft','review','scheduled','publishing','published','partial','failed','canceled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'draft',
  `publish_at` datetime DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `id_user_edited` int unsigned DEFAULT NULL,
  `id_user_review` int unsigned DEFAULT NULL,
  `date_review` datetime DEFAULT NULL,
  `id_user_approved` int unsigned DEFAULT NULL,
  `date_approved` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_upd` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_status` (`deleted`,`status`,`publish_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_social_snippets` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `kind` enum('template','hashtags') COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `content` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `network` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `usage_count` int unsigned NOT NULL DEFAULT '0',
  `date_used` datetime DEFAULT NULL,
  `id_user` int unsigned DEFAULT NULL,
  `id_user_edited` int unsigned DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_upd` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_kind` (`deleted`,`kind`,`usage_count`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_system_errors` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `fingerprint` char(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `level` enum('error','fatal') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'error',
  `module` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'app',
  `message` varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL,
  `frame` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'перший кадр стеку з коду системи',
  `type` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `stack` mediumtext COLLATE utf8mb4_unicode_ci,
  `count` int unsigned NOT NULL DEFAULT '1',
  `first_seen` datetime NOT NULL,
  `last_seen` datetime NOT NULL,
  `context` json DEFAULT NULL COMMENT 'запит / користувач / поля останнього разу',
  `status` enum('open','resolved','ignored') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'open',
  `resolved_by` int unsigned DEFAULT NULL,
  `resolved_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fingerprint` (`fingerprint`),
  KEY `idx_status_last` (`status`,`last_seen`),
  KEY `idx_module` (`module`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_telegram_unread` (
  `chat_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `manager_id` int unsigned NOT NULL,
  `count` int unsigned NOT NULL DEFAULT '0',
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`chat_id`,`manager_id`),
  KEY `idx_manager` (`manager_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_to_do` (
  `id` int NOT NULL AUTO_INCREMENT,
  `id_user` int NOT NULL,
  `text` longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` int NOT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  `date_end` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_url` (
  `id` int NOT NULL AUTO_INCREMENT,
  `ssl` int NOT NULL,
  `url` varchar(999) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_users` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `first_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Ім''я',
  `last_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Прізвище',
  `patronymic` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'По-батькові',
  `phone` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `birthday` date DEFAULT NULL,
  `gender` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '0=не вказано 1=чоловік 2=жінка',
  `avatar` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Назва файлу. Шлях: /uploads/users/{id}/{avatar}',
  `id_lang` smallint unsigned NOT NULL DEFAULT '1',
  `active` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '0=неактивний 1=активний 2=заблокований 3=запрошений',
  `tfa_enabled` tinyint unsigned NOT NULL DEFAULT '0',
  `tfa_secret` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `tfa_secret_pending` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `tfa_last_step` bigint unsigned NOT NULL DEFAULT '0',
  `tfa_failed_attempts` tinyint unsigned NOT NULL DEFAULT '0',
  `tfa_locked_until` datetime DEFAULT NULL,
  `reset_token` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `reset_token_expires` datetime DEFAULT NULL,
  `failed_login_attempts` tinyint unsigned NOT NULL DEFAULT '0',
  `locked_until` datetime DEFAULT NULL,
  `token_version` int unsigned NOT NULL DEFAULT '0',
  `last_login_ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'IP адреса останнього успішного входу',
  `last_device_type` tinyint unsigned DEFAULT '0' COMMENT '0=desktop 1=mobile 2=tablet',
  `id_created_by` int unsigned DEFAULT NULL COMMENT 'NULL = зареєструвався сам',
  `date_last_login` datetime DEFAULT NULL,
  `date_online_since` datetime DEFAULT NULL COMMENT 'Коли юзер став онлайн (перша вкладка)',
  `date_last_seen` datetime DEFAULT NULL COMMENT 'Коли юзер востаннє був онлайн',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `id_office` int unsigned DEFAULT NULL,
  `id_department` int unsigned DEFAULT NULL,
  `position` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_manager` int unsigned DEFAULT NULL,
  `timezone` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'IANA; NULL — часовий пояс офісу',
  `locale` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'BCP 47 для дат і чисел, напр. en-US, en-IN, uk-UA; NULL — за мовою інтерфейсу',
  `hour12` tinyint(1) DEFAULT NULL COMMENT '1 — 12-годинний, 0 — 24-годинний, NULL — за locale',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_email` (`email`),
  KEY `idx_active` (`active`),
  KEY `idx_id_lang` (`id_lang`),
  KEY `idx_id_created_by` (`id_created_by`),
  KEY `idx_last_name` (`last_name`),
  KEY `idx_first_name` (`first_name`),
  KEY `idx_company_office` (`id_office`),
  KEY `idx_company_department` (`id_department`),
  KEY `idx_company_manager` (`id_manager`),
  CONSTRAINT `fk_users_created_by` FOREIGN KEY (`id_created_by`) REFERENCES `prefix_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_users_lang` FOREIGN KEY (`id_lang`) REFERENCES `prefix_languages` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_users_email_changes` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_user` int unsigned NOT NULL,
  `new_email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `token_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `expires_at` datetime NOT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_token` (`token_hash`),
  KEY `idx_user` (`id_user`),
  CONSTRAINT `fk_email_changes_user` FOREIGN KEY (`id_user`) REFERENCES `prefix_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_users_groups` (
  `id` smallint unsigned NOT NULL AUTO_INCREMENT,
  `active` tinyint unsigned NOT NULL DEFAULT '1',
  `id_created_by` int unsigned DEFAULT NULL COMMENT 'NULL = система',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_active` (`active`),
  KEY `idx_id_created_by` (`id_created_by`),
  CONSTRAINT `fk_groups_created_by` FOREIGN KEY (`id_created_by`) REFERENCES `prefix_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_users_groups_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_group` smallint unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `note` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_group_lang` (`id_group`,`id_lang`),
  KEY `idx_id_group` (`id_group`),
  KEY `fk_groups_lang_lang` (`id_lang`),
  CONSTRAINT `fk_groups_lang_group` FOREIGN KEY (`id_group`) REFERENCES `prefix_users_groups` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_groups_lang_lang` FOREIGN KEY (`id_lang`) REFERENCES `prefix_languages` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_users_groups_permissions` (
  `id_group` smallint unsigned NOT NULL,
  `id_page` smallint unsigned NOT NULL,
  `can_view` tinyint unsigned NOT NULL DEFAULT '0',
  `can_add` tinyint unsigned NOT NULL DEFAULT '0',
  `can_edit` tinyint unsigned NOT NULL DEFAULT '0',
  `can_delete` tinyint unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id_group`,`id_page`),
  KEY `idx_id_page` (`id_page`),
  CONSTRAINT `fk_ugp_group` FOREIGN KEY (`id_group`) REFERENCES `prefix_users_groups` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_ugp_page` FOREIGN KEY (`id_page`) REFERENCES `prefix_users_permissions_pages` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_users_invites` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `token` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_group` smallint unsigned DEFAULT NULL COMMENT 'Група після реєстрації',
  `id_created_by` int unsigned NOT NULL COMMENT 'Хто запросив',
  `status` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '0=очікує 1=завершено',
  `expires_at` datetime NOT NULL,
  `date_accepted` datetime DEFAULT NULL COMMENT 'Дата завершення реєстрації',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `date_edit` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_token` (`token`),
  UNIQUE KEY `uq_email` (`email`),
  KEY `idx_status` (`status`),
  KEY `idx_expires_at` (`expires_at`),
  KEY `idx_id_created_by` (`id_created_by`),
  CONSTRAINT `fk_invites_created_by` FOREIGN KEY (`id_created_by`) REFERENCES `prefix_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_users_login_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_user` int unsigned NOT NULL,
  `ip` varchar(45) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'IPv4 або IPv6',
  `country` varchar(2) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Код країни: UA, PL...',
  `city` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `user_agent` varchar(512) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `device` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '0=desktop 1=mobile 2=tablet',
  `status` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '0=невдала 1=успішна',
  `reason` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`,`date_add`),
  KEY `idx_id_user` (`id_user`),
  KEY `idx_status` (`status`),
  KEY `idx_id_user_date_add` (`id_user`,`date_add`),
  KEY `idx_ip_attack_detect` (`ip`,`date_add`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
/*!50100 PARTITION BY RANGE (((year(`date_add`) * 100) + month(`date_add`)))
(PARTITION p202601 VALUES LESS THAN (202602) ENGINE = InnoDB,
 PARTITION p202602 VALUES LESS THAN (202603) ENGINE = InnoDB,
 PARTITION p202603 VALUES LESS THAN (202604) ENGINE = InnoDB,
 PARTITION p202604 VALUES LESS THAN (202605) ENGINE = InnoDB,
 PARTITION p202605 VALUES LESS THAN (202606) ENGINE = InnoDB,
 PARTITION p202606 VALUES LESS THAN (202607) ENGINE = InnoDB,
 PARTITION p202607 VALUES LESS THAN (202608) ENGINE = InnoDB,
 PARTITION p202608 VALUES LESS THAN (202609) ENGINE = InnoDB,
 PARTITION p202609 VALUES LESS THAN (202610) ENGINE = InnoDB,
 PARTITION p202610 VALUES LESS THAN (202611) ENGINE = InnoDB,
 PARTITION p202611 VALUES LESS THAN (202612) ENGINE = InnoDB,
 PARTITION p202612 VALUES LESS THAN (202613) ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN MAXVALUE ENGINE = InnoDB) */;

CREATE TABLE IF NOT EXISTS `prefix_users_permissions_pages` (
  `id` smallint unsigned NOT NULL AUTO_INCREMENT,
  `slug` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Унікальний ключ: users.list, products.catalog',
  `parent_id` smallint unsigned DEFAULT NULL COMMENT 'NULL = корінь дерева',
  `sort_order` smallint unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_slug` (`slug`),
  KEY `idx_parent` (`parent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_users_permissions_pages_lang` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_page` smallint unsigned NOT NULL,
  `id_lang` smallint unsigned NOT NULL,
  `name` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_page_lang` (`id_page`,`id_lang`),
  KEY `idx_id_lang` (`id_lang`),
  CONSTRAINT `fk_uppl_page` FOREIGN KEY (`id_page`) REFERENCES `prefix_users_permissions_pages` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_users_security_events` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_user` int unsigned DEFAULT NULL COMMENT 'NULL якщо користувач не знайдений',
  `ip_address` varchar(45) COLLATE utf8mb4_unicode_ci NOT NULL,
  `event_type` enum('login_success','login_failed_invalid_password','login_failed_unknown_user','login_blocked','login_inactive','login_failed_invalid_2fa','invalid_request','login_system_error','password_changed','2fa_enabled','2fa_disabled','password_reset_requested','email_change_requested','email_changed') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_agent` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `details` json DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_id` (`id_user`),
  KEY `idx_event_type` (`event_type`),
  KEY `idx_created_at` (`created_at`),
  KEY `idx_ip_address` (`ip_address`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Логування подій безпеки';

CREATE TABLE IF NOT EXISTS `prefix_users_sessions` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `sid` char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `id_user` int unsigned NOT NULL,
  `ip_address` varchar(45) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_agent` varchar(512) COLLATE utf8mb4_unicode_ci NOT NULL,
  `device_fingerprint` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Хеш пристрою (IP + User-Agent)',
  `refresh_token_hash` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_valid` tinyint(1) DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` datetime NOT NULL,
  `last_activity` datetime DEFAULT CURRENT_TIMESTAMP,
  `revoked_at` datetime DEFAULT NULL,
  `revoked_by` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sid` (`sid`),
  KEY `idx_refresh_token` (`refresh_token_hash`),
  KEY `idx_expires` (`expires_at`),
  KEY `idx_valid` (`is_valid`,`expires_at`),
  KEY `idx_user_valid` (`id_user`,`is_valid`,`expires_at`),
  CONSTRAINT `fk_sessions_user` FOREIGN KEY (`id_user`) REFERENCES `prefix_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Активні сесії користувачів';

CREATE TABLE IF NOT EXISTS `prefix_users_tfa_backup_codes` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `id_user` int unsigned NOT NULL,
  `code_hash` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `used_at` datetime DEFAULT NULL,
  `date_add` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_unused` (`id_user`,`used_at`),
  CONSTRAINT `fk_tfa_bc_user` FOREIGN KEY (`id_user`) REFERENCES `prefix_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_users_to_groups` (
  `id_user` int unsigned NOT NULL,
  `id_group` smallint unsigned NOT NULL,
  PRIMARY KEY (`id_user`,`id_group`),
  KEY `idx_id_group` (`id_group`),
  CONSTRAINT `fk_utg_group` FOREIGN KEY (`id_group`) REFERENCES `prefix_users_groups` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_utg_user` FOREIGN KEY (`id_user`) REFERENCES `prefix_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_users_ui_settings` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `id_user` int unsigned NOT NULL,
  `key` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` json NOT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_key` (`id_user`,`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_web_chat` (
  `id` int NOT NULL AUTO_INCREMENT,
  `id_chat` varchar(999) COLLATE utf8mb4_unicode_ci NOT NULL,
  `message` json NOT NULL,
  `type` varchar(999) COLLATE utf8mb4_unicode_ci NOT NULL,
  `date_add` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_web_chat_client_reads` (
  `room_id` varchar(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `site_id` varchar(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `last_read_id` bigint unsigned NOT NULL DEFAULT '0',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`room_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_web_chat_conversations` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `site_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `room_id` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `url_token` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` enum('open','closed','archived') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'open',
  `client_wrote` tinyint(1) NOT NULL DEFAULT '0',
  `operator_id` int DEFAULT NULL,
  `joined_at` datetime(3) DEFAULT NULL,
  `closed_at` datetime(3) DEFAULT NULL,
  `offline_ack_at` datetime(3) DEFAULT NULL,
  `rating` tinyint DEFAULT NULL,
  `rating_comment` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `rated_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_room` (`site_id`,`room_id`),
  UNIQUE KEY `uk_url_token` (`url_token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_web_chat_leads` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `site_id` varchar(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `room_id` varchar(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `visitor_id` varchar(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `email` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `trigger` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `form_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `answers` json DEFAULT NULL,
  `page_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_room` (`site_id`,`room_id`),
  KEY `idx_visitor` (`site_id`,`visitor_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_web_chat_manager` (
  `id` int NOT NULL AUTO_INCREMENT,
  `id_manager` int NOT NULL,
  `id_chat` varchar(999) COLLATE utf8mb4_unicode_ci NOT NULL,
  `message` json NOT NULL,
  `type_message` varchar(999) COLLATE utf8mb4_unicode_ci NOT NULL,
  `date_add` datetime NOT NULL,
  `date_edit` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_web_chat_messages` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `site_id` varchar(190) COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_chat` varchar(190) COLLATE utf8mb4_unicode_ci NOT NULL,
  `sender` enum('client','operator') COLLATE utf8mb4_unicode_ci NOT NULL,
  `manager_id` int DEFAULT NULL,
  `message` json NOT NULL,
  `type` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'text',
  `client_ts` bigint DEFAULT NULL,
  `client_msg_id` char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `edited_at` datetime(3) DEFAULT NULL,
  `deleted_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_client_msg` (`id_chat`,`client_msg_id`),
  KEY `idx_chat` (`site_id`,`id_chat`,`id`),
  KEY `idx_date` (`date_add`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_web_chat_operator_reads` (
  `operator_id` int NOT NULL,
  `room_id` varchar(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `site_id` varchar(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `last_read_id` bigint unsigned NOT NULL DEFAULT '0',
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`operator_id`,`room_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_web_chat_push_subs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `operator_id` int NOT NULL,
  `endpoint` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `p256dh` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `auth` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_agent` varchar(300) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_add` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_endpoint` (`endpoint`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_web_chat_sessions` (
  `uid` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `site_id` varchar(190) COLLATE utf8mb4_unicode_ci NOT NULL,
  `visitor_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `last_seen` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`uid`,`site_id`),
  KEY `idx_visitor` (`site_id`,`visitor_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_web_chat_sites` (
  `site_id` varchar(190) COLLATE utf8mb4_unicode_ci NOT NULL,
  `domains` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `product_card_enabled` tinyint(1) NOT NULL DEFAULT '0',
  `lead_timeout_sec` int NOT NULL DEFAULT '120',
  `offline_lead_enabled` tinyint(1) NOT NULL DEFAULT '1',
  `offline_lead_delay_sec` int NOT NULL DEFAULT '30',
  `brand_color` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '#007fff',
  `config` json DEFAULT NULL,
  PRIMARY KEY (`site_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_web_chat_visitor_meta` (
  `site_id` varchar(190) COLLATE utf8mb4_unicode_ci NOT NULL,
  `visitor_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `data` json NOT NULL,
  `first_data` json DEFAULT NULL,
  `first_seen` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`site_id`,`visitor_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `prefix_web_chat_visitor_products` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `site_id` varchar(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `visitor_id` varchar(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `product_key` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `product` json NOT NULL,
  `views` int unsigned NOT NULL DEFAULT '1',
  `first_viewed` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `last_viewed` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_visitor_product` (`site_id`,`visitor_id`,`product_key`),
  KEY `idx_history` (`site_id`,`visitor_id`,`last_viewed`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. Довідники і права адміністратора ──
-- Дані: prefix_calendar_event_type (10 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_calendar_event_type` (`id`, `code`, `icon`, `color`, `is_system`, `is_absence`, `default_visibility`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 'meeting', 'fas fa-handshake', '#007bff', 1, 0, 2, 1, 1, NOW(), NOW()),
(2, 'call', 'fas fa-phone', '#28a745', 1, 0, 1, 1, 2, NOW(), NOW()),
(3, 'reminder', 'fas fa-bell', '#ffc107', 1, 0, 1, 1, 3, NOW(), NOW()),
(4, 'deadline', 'fas fa-flag', '#dc3545', 1, 0, 2, 1, 4, NOW(), NOW()),
(5, 'task', 'fas fa-check-square', '#6610f2', 1, 0, 1, 1, 5, NOW(), NOW()),
(6, 'personal', 'fas fa-user', '#20c997', 1, 0, 1, 1, 6, NOW(), NOW()),
(7, 'vacation', 'fas fa-umbrella-beach', '#fd7e14', 1, 1, 4, 1, 7, NOW(), NOW()),
(8, 'sick', 'fas fa-notes-medical', '#e83e8c', 1, 1, 4, 1, 8, NOW(), NOW()),
(9, 'other', 'fas fa-circle', '#6c757d', 1, 0, 1, 1, 9, NOW(), NOW()),
(10, 'business_trip', 'fas fa-plane', '#0dcaf0', 1, 1, 4, 1, 10, NOW(), NOW());

-- Дані: prefix_calendar_event_type_lang (120 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_calendar_event_type_lang` (`id_event_type`, `id_lang`, `name`) VALUES
(1, 1, 'Meeting'),
(1, 2, 'Зустріч'),
(1, 3, 'Besprechung'),
(1, 4, 'Réunion'),
(1, 5, 'Reunión'),
(1, 6, 'Riunione'),
(1, 7, 'Reunião'),
(1, 8, 'Vergadering'),
(1, 9, 'Spotkanie'),
(1, 10, '会议'),
(1, 11, '会議'),
(1, 12, '회의'),
(2, 1, 'Call'),
(2, 2, 'Дзвінок'),
(2, 3, 'Anruf'),
(2, 4, 'Appel'),
(2, 5, 'Llamada'),
(2, 6, 'Chiamata'),
(2, 7, 'Chamada'),
(2, 8, 'Oproep'),
(2, 9, 'Połączenie'),
(2, 10, '通话'),
(2, 11, '通話'),
(2, 12, '통화'),
(3, 1, 'Reminder'),
(3, 2, 'Нагадування'),
(3, 3, 'Erinnerung'),
(3, 4, 'Rappel'),
(3, 5, 'Recordatorio'),
(3, 6, 'Promemoria'),
(3, 7, 'Lembrete'),
(3, 8, 'Herinnering'),
(3, 9, 'Przypomnienie'),
(3, 10, '提醒'),
(3, 11, 'リマインダー'),
(3, 12, '알림'),
(4, 1, 'Deadline'),
(4, 2, 'Дедлайн'),
(4, 3, 'Frist'),
(4, 4, 'Échéance'),
(4, 5, 'Fecha límite'),
(4, 6, 'Scadenza'),
(4, 7, 'Prazo'),
(4, 8, 'Deadline'),
(4, 9, 'Termin'),
(4, 10, '截止日期'),
(4, 11, '締め切り'),
(4, 12, '마감일'),
(5, 1, 'Task'),
(5, 2, 'Завдання'),
(5, 3, 'Aufgabe'),
(5, 4, 'Tâche'),
(5, 5, 'Tarea'),
(5, 6, 'Attività'),
(5, 7, 'Tarefa'),
(5, 8, 'Taak'),
(5, 9, 'Zadanie'),
(5, 10, '任务'),
(5, 11, 'タスク'),
(5, 12, '작업'),
(6, 1, 'Personal'),
(6, 2, 'Особисте'),
(6, 3, 'Persönlich'),
(6, 4, 'Personnel'),
(6, 5, 'Personal'),
(6, 6, 'Personale'),
(6, 7, 'Pessoal'),
(6, 8, 'Persoonlijk'),
(6, 9, 'Osobiste'),
(6, 10, '个人'),
(6, 11, '個人'),
(6, 12, '개인'),
(7, 1, 'Vacation'),
(7, 2, 'Відпустка'),
(7, 3, 'Urlaub'),
(7, 4, 'Vacances'),
(7, 5, 'Vacaciones'),
(7, 6, 'Vacanza'),
(7, 7, 'Férias'),
(7, 8, 'Vakantie'),
(7, 9, 'Urlop'),
(7, 10, '假期'),
(7, 11, '休暇'),
(7, 12, '휴가'),
(8, 1, 'Sick leave'),
(8, 2, 'Лікарняний'),
(8, 3, 'Krankmeldung'),
(8, 4, 'Congé maladie'),
(8, 5, 'Baja por enfermedad'),
(8, 6, 'Congedo per malattia'),
(8, 7, 'Licença médica'),
(8, 8, 'Ziekteverlof'),
(8, 9, 'Zwolnienie lekarskie'),
(8, 10, '病假'),
(8, 11, '病気休暇'),
(8, 12, '병가'),
(9, 1, 'Other'),
(9, 2, 'Інше'),
(9, 3, 'Sonstiges'),
(9, 4, 'Autre'),
(9, 5, 'Otro'),
(9, 6, 'Altro'),
(9, 7, 'Outro'),
(9, 8, 'Overig'),
(9, 9, 'Inne'),
(9, 10, '其他'),
(9, 11, 'その他'),
(9, 12, '기타'),
(10, 1, 'Business trip'),
(10, 2, 'Відрядження'),
(10, 3, 'Geschäftsreise'),
(10, 4, 'Voyage d\'affaires'),
(10, 5, 'Viaje de negocios'),
(10, 6, 'Viaggio d\'affari'),
(10, 7, 'Viagem de negócios'),
(10, 8, 'Zakenreis'),
(10, 9, 'Podróż służbowa'),
(10, 10, '出差'),
(10, 11, '出張'),
(10, 12, '출장');

-- Дані: prefix_clients_address_types (4 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_clients_address_types` (`id`, `code`, `icon`, `sort`, `is_system`, `active`, `date_add`, `date_edit`) VALUES
(1, 'shipping', 'fa-solid fa-truck', 1, 1, 1, NOW(), NOW()),
(2, 'billing', 'fa-solid fa-file-invoice', 2, 1, 1, NOW(), NOW()),
(3, 'legal', 'fa-solid fa-scale-balanced', 3, 1, 1, NOW(), NOW()),
(4, 'actual', 'fa-solid fa-location-dot', 4, 1, 1, NOW(), NOW());

-- Дані: prefix_clients_address_types_lang (48 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_clients_address_types_lang` (`id`, `id_address_type`, `id_lang`, `name`) VALUES
(1, 1, 1, 'Shipping'),
(2, 1, 2, 'Доставка'),
(3, 1, 3, 'Versand'),
(4, 1, 4, 'Livraison'),
(5, 1, 5, 'Envío'),
(6, 1, 6, 'Spedizione'),
(7, 1, 7, 'Envio'),
(8, 1, 8, 'Verzending'),
(9, 1, 9, 'Wysyłka'),
(10, 1, 10, '配送'),
(11, 1, 11, '配送'),
(12, 1, 12, '배송'),
(13, 2, 1, 'Billing'),
(14, 2, 2, 'Для рахунків'),
(15, 2, 3, 'Rechnungsadresse'),
(16, 2, 4, 'Facturation'),
(17, 2, 5, 'Facturación'),
(18, 2, 6, 'Fatturazione'),
(19, 2, 7, 'Faturamento'),
(20, 2, 8, 'Facturering'),
(21, 2, 9, 'Rozliczenia'),
(22, 2, 10, '账单'),
(23, 2, 11, '請求先'),
(24, 2, 12, '청구'),
(25, 3, 1, 'Legal'),
(26, 3, 2, 'Юридична'),
(27, 3, 3, 'Rechtlich'),
(28, 3, 4, 'Légal'),
(29, 3, 5, 'Legal'),
(30, 3, 6, 'Legale'),
(31, 3, 7, 'Jurídico'),
(32, 3, 8, 'Juridisch'),
(33, 3, 9, 'Prawny'),
(34, 3, 10, '法定'),
(35, 3, 11, '法定'),
(36, 3, 12, '법적'),
(37, 4, 1, 'Actual'),
(38, 4, 2, 'Фактична'),
(39, 4, 3, 'Tatsächlich'),
(40, 4, 4, 'Réel'),
(41, 4, 5, 'Real'),
(42, 4, 6, 'Effettivo'),
(43, 4, 7, 'Real'),
(44, 4, 8, 'Werkelijk'),
(45, 4, 9, 'Rzeczywisty'),
(46, 4, 10, '实际'),
(47, 4, 11, '実際'),
(48, 4, 12, '실제');

-- Дані: prefix_clients_contact_types (7 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_clients_contact_types` (`id`, `code`, `normalize`, `url_template`, `color_text`, `color_background`, `icon`, `use_for_dedup`, `sort`, `is_system`, `active`, `date_add`, `date_edit`) VALUES
(1, 'phone', 'phone', 'tel:{value}', '#ffffff', '#2ecc71', 'fa-solid fa-phone', 1, 1, 1, 1, NOW(), NOW()),
(2, 'email', 'email', 'mailto:{value}', '#ffffff', '#3498db', 'fa-solid fa-envelope', 1, 2, 1, 1, NOW(), NOW()),
(3, 'telegram', 'lower', 'https://t.me/{value}', '#ffffff', '#229ED9', 'fa-brands fa-telegram', 1, 3, 1, 1, NOW(), NOW()),
(4, 'instagram', 'lower', 'https://instagram.com/{value}', '#ffffff', '#E1306C', 'fa-brands fa-instagram', 1, 4, 1, 1, NOW(), NOW()),
(5, 'viber', 'phone', 'viber://chat?number={value}', '#ffffff', '#7360F2', 'fa-brands fa-viber', 1, 5, 0, 1, NOW(), NOW()),
(6, 'whatsapp', 'phone', 'https://wa.me/{value}', '#ffffff', '#25D366', 'fa-brands fa-whatsapp', 1, 6, 0, 1, NOW(), NOW()),
(7, 'website', 'lower', '{value}', '#ffffff', '#7f8c8d', 'fa-solid fa-globe', 0, 7, 0, 1, NOW(), NOW());

-- Дані: prefix_clients_contact_types_lang (84 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_clients_contact_types_lang` (`id`, `id_contact_type`, `id_lang`, `name`) VALUES
(1, 1, 1, 'Phone'),
(2, 1, 2, 'Телефон'),
(3, 1, 3, 'Telefon'),
(4, 1, 4, 'Téléphone'),
(5, 1, 5, 'Teléfono'),
(6, 1, 6, 'Telefono'),
(7, 1, 7, 'Telefone'),
(8, 1, 8, 'Telefoon'),
(9, 1, 9, 'Telefon'),
(10, 1, 10, '电话'),
(11, 1, 11, '電話'),
(12, 1, 12, '전화'),
(13, 2, 1, 'Email'),
(14, 2, 2, 'Email'),
(15, 2, 3, 'E-Mail'),
(16, 2, 4, 'E-mail'),
(17, 2, 5, 'Correo electrónico'),
(18, 2, 6, 'Email'),
(19, 2, 7, 'E-mail'),
(20, 2, 8, 'E-mail'),
(21, 2, 9, 'E-mail'),
(22, 2, 10, '电子邮件'),
(23, 2, 11, 'メール'),
(24, 2, 12, '이메일'),
(25, 3, 1, 'Telegram'),
(26, 3, 2, 'Telegram'),
(27, 3, 3, 'Telegram'),
(28, 3, 4, 'Telegram'),
(29, 3, 5, 'Telegram'),
(30, 3, 6, 'Telegram'),
(31, 3, 7, 'Telegram'),
(32, 3, 8, 'Telegram'),
(33, 3, 9, 'Telegram'),
(34, 3, 10, 'Telegram'),
(35, 3, 11, 'Telegram'),
(36, 3, 12, 'Telegram'),
(37, 4, 1, 'Instagram'),
(38, 4, 2, 'Instagram'),
(39, 4, 3, 'Instagram'),
(40, 4, 4, 'Instagram'),
(41, 4, 5, 'Instagram'),
(42, 4, 6, 'Instagram'),
(43, 4, 7, 'Instagram'),
(44, 4, 8, 'Instagram'),
(45, 4, 9, 'Instagram'),
(46, 4, 10, 'Instagram'),
(47, 4, 11, 'Instagram'),
(48, 4, 12, 'Instagram'),
(49, 5, 1, 'Viber'),
(50, 5, 2, 'Viber'),
(51, 5, 3, 'Viber'),
(52, 5, 4, 'Viber'),
(53, 5, 5, 'Viber'),
(54, 5, 6, 'Viber'),
(55, 5, 7, 'Viber'),
(56, 5, 8, 'Viber'),
(57, 5, 9, 'Viber'),
(58, 5, 10, 'Viber'),
(59, 5, 11, 'Viber'),
(60, 5, 12, 'Viber'),
(61, 6, 1, 'WhatsApp'),
(62, 6, 2, 'WhatsApp'),
(63, 6, 3, 'WhatsApp'),
(64, 6, 4, 'WhatsApp'),
(65, 6, 5, 'WhatsApp'),
(66, 6, 6, 'WhatsApp'),
(67, 6, 7, 'WhatsApp'),
(68, 6, 8, 'WhatsApp'),
(69, 6, 9, 'WhatsApp'),
(70, 6, 10, 'WhatsApp'),
(71, 6, 11, 'WhatsApp'),
(72, 6, 12, 'WhatsApp'),
(73, 7, 1, 'Website'),
(74, 7, 2, 'Сайт'),
(75, 7, 3, 'Website'),
(76, 7, 4, 'Site web'),
(77, 7, 5, 'Sitio web'),
(78, 7, 6, 'Sito web'),
(79, 7, 7, 'Site'),
(80, 7, 8, 'Website'),
(81, 7, 9, 'Strona internetowa'),
(82, 7, 10, '网站'),
(83, 7, 11, 'ウェブサイト'),
(84, 7, 12, '웹사이트');

-- Дані: prefix_clients_field_options (0 рядків, режим insert-ignore)

-- Дані: prefix_clients_field_options_lang (0 рядків, режим insert-ignore)

-- Дані: prefix_clients_identifier_types (7 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_clients_identifier_types` (`id`, `code`, `applies_kind`, `country`, `validation_regex`, `is_unique`, `sort`, `is_system`, `active`, `date_add`, `date_edit`) VALUES
(1, 'edrpou', 'organization', 'UA', '^[0-9]{8}$', 1, 1, 1, 1, NOW(), NOW()),
(2, 'ipn', 'person', 'UA', '^[0-9]{10}$', 1, 2, 1, 1, NOW(), NOW()),
(3, 'vat_ua', 'all', 'UA', '^[0-9]{12}$', 1, 3, 0, 1, NOW(), NOW()),
(4, 'eu_vat', 'organization', NULL, '^[A-Z]{2}[0-9A-Z]{2,13}$', 1, 4, 0, 1, NOW(), NOW()),
(5, 'passport', 'person', NULL, NULL, 1, 5, 0, 1, NOW(), NOW()),
(6, 'other', 'all', NULL, NULL, 0, 99, 0, 1, NOW(), NOW()),
(7, 'tax_id', 'all', NULL, NULL, 1, 90, 1, 1, NOW(), NOW());

-- Дані: prefix_clients_identifier_types_lang (14 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_clients_identifier_types_lang` (`id`, `id_identifier_type`, `id_lang`, `name`) VALUES
(1, 1, 1, 'EDRPOU code'),
(2, 1, 2, 'Код ЄДРПОУ'),
(3, 2, 1, 'Individual tax number'),
(4, 2, 2, 'ІПН (РНОКПП)'),
(5, 3, 1, 'VAT payer number (UA)'),
(6, 3, 2, 'ІПН платника ПДВ'),
(7, 4, 1, 'EU VAT number'),
(8, 4, 2, 'EU VAT номер'),
(9, 5, 1, 'Passport'),
(10, 5, 2, 'Паспорт'),
(11, 6, 1, 'Other'),
(12, 6, 2, 'Інше'),
(13, 7, 1, 'Tax ID'),
(14, 7, 2, 'Податковий номер');

-- Дані: prefix_clients_legal_types (11 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_clients_legal_types` (`id`, `kind`, `country`, `code`, `color_text`, `color_background`, `icon`, `required_identifiers`, `sort`, `is_system`, `active`, `date_add`, `date_edit`) VALUES
(1, 'person', NULL, 'individual', '#ffffff', '#3498db', 'fa-solid fa-user', NULL, 10, 1, 1, NOW(), NOW()),
(2, 'person', 'UA', 'sole_proprietor', '#ffffff', '#16a085', 'fa-solid fa-user-tie', '[\"ipn\"]', 30, 1, 1, NOW(), NOW()),
(3, 'organization', 'UA', 'llc', '#ffffff', '#8e44ad', 'fa-solid fa-building', '[\"edrpou\"]', 20, 0, 1, NOW(), NOW()),
(4, 'organization', 'UA', 'private_enterprise', '#ffffff', '#9b59b6', 'fa-solid fa-building', '[\"edrpou\"]', 40, 0, 1, NOW(), NOW()),
(5, 'organization', 'UA', 'joint_stock', '#ffffff', '#6c3483', 'fa-solid fa-building-columns', '[\"edrpou\"]', 50, 0, 1, NOW(), NOW()),
(6, 'organization', 'UA', 'government', '#ffffff', '#34495e', 'fa-solid fa-landmark', '[\"edrpou\"]', 60, 0, 1, NOW(), NOW()),
(7, 'organization', 'UA', 'non_profit', '#ffffff', '#27ae60', 'fa-solid fa-people-group', '[\"edrpou\"]', 70, 0, 1, NOW(), NOW()),
(8, 'organization', 'UA', 'charity', '#ffffff', '#e67e22', 'fa-solid fa-hand-holding-heart', '[\"edrpou\"]', 80, 0, 1, NOW(), NOW()),
(9, 'organization', NULL, 'foreign_company', '#ffffff', '#2c3e50', 'fa-solid fa-globe', NULL, 90, 0, 1, NOW(), NOW()),
(10, 'group', NULL, 'household', '#ffffff', '#d35400', 'fa-solid fa-house-user', NULL, 100, 0, 1, NOW(), NOW()),
(11, 'group', NULL, 'group', '#ffffff', '#7f8c8d', 'fa-solid fa-users', NULL, 110, 0, 1, NOW(), NOW());

-- Дані: prefix_clients_legal_types_lang (22 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_clients_legal_types_lang` (`id`, `id_legal_type`, `id_lang`, `name`, `short_name`) VALUES
(1, 1, 1, 'Individual', NULL),
(2, 1, 2, 'Фізична особа', 'Фізособа'),
(3, 2, 1, 'Sole proprietor', 'SP'),
(4, 2, 2, 'Фізична особа-підприємець', 'ФОП'),
(5, 3, 1, 'Limited liability company', 'LLC'),
(6, 3, 2, 'Товариство з обмеженою відповідальністю', 'ТОВ'),
(7, 4, 1, 'Private enterprise', 'PE'),
(8, 4, 2, 'Приватне підприємство', 'ПП'),
(9, 5, 1, 'Joint-stock company', 'JSC'),
(10, 5, 2, 'Акціонерне товариство', 'АТ'),
(11, 6, 1, 'Government body', NULL),
(12, 6, 2, 'Державна установа', NULL),
(13, 7, 1, 'Non-profit organization', 'NGO'),
(14, 7, 2, 'Громадська організація', 'ГО'),
(15, 8, 1, 'Charity foundation', NULL),
(16, 8, 2, 'Благодійний фонд', 'БФ'),
(17, 9, 1, 'Company', NULL),
(18, 9, 2, 'Компанія', NULL),
(19, 10, 1, 'Household', NULL),
(20, 10, 2, 'Родина', NULL),
(21, 11, 1, 'Group', NULL),
(22, 11, 2, 'Група', NULL);

-- Дані: prefix_clients_lifecycle_stages (7 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_clients_lifecycle_stages` (`id`, `code`, `is_customer`, `color_text`, `color_background`, `icon`, `sort`, `is_system`, `active`, `date_add`, `date_edit`) VALUES
(1, 'subscriber', 0, '#ffffff', '#95a5a6', 'fa-solid fa-envelope-open', 10, 1, 1, NOW(), NOW()),
(2, 'lead', 0, '#ffffff', '#f39c12', 'fa-solid fa-bullseye', 20, 1, 1, NOW(), NOW()),
(3, 'prospect', 0, '#ffffff', '#3498db', 'fa-solid fa-magnifying-glass-dollar', 30, 1, 1, NOW(), NOW()),
(4, 'customer', 1, '#ffffff', '#27ae60', 'fa-solid fa-circle-check', 40, 1, 1, NOW(), NOW()),
(5, 'repeat_customer', 1, '#ffffff', '#16a085', 'fa-solid fa-repeat', 50, 1, 1, NOW(), NOW()),
(6, 'vip', 1, '#ffffff', '#8e44ad', 'fa-solid fa-crown', 60, 0, 1, NOW(), NOW()),
(7, 'churned', 1, '#ffffff', '#7f8c8d', 'fa-solid fa-user-slash', 70, 0, 1, NOW(), NOW());

-- Дані: prefix_clients_lifecycle_stages_lang (14 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_clients_lifecycle_stages_lang` (`id`, `id_stage`, `id_lang`, `name`) VALUES
(1, 1, 1, 'Subscriber'),
(2, 1, 2, 'Підписник'),
(3, 2, 1, 'Lead'),
(4, 2, 2, 'Лід'),
(5, 3, 1, 'Prospect'),
(6, 3, 2, 'Потенційний клієнт'),
(7, 4, 1, 'Customer'),
(8, 4, 2, 'Клієнт'),
(9, 5, 1, 'Repeat customer'),
(10, 5, 2, 'Постійний клієнт'),
(11, 6, 1, 'VIP'),
(12, 6, 2, 'VIP'),
(13, 7, 1, 'Churned'),
(14, 7, 2, 'Втрачений');

-- Дані: prefix_clients_relationship_types (10 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_clients_relationship_types` (`id`, `code`, `from_kind`, `to_kind`, `is_symmetric`, `color_text`, `color_background`, `icon`, `sort`, `is_system`, `active`, `date_add`, `date_edit`) VALUES
(1, 'employee_of', 'person', 'organization', 0, '#ffffff', '#3498db', 'fa-solid fa-briefcase', 1, 1, 1, NOW(), NOW()),
(2, 'director_of', 'person', 'organization', 0, '#ffffff', '#8e44ad', 'fa-solid fa-user-tie', 2, 0, 1, NOW(), NOW()),
(3, 'contact_person', 'person', 'organization', 0, '#ffffff', '#16a085', 'fa-solid fa-address-card', 3, 1, 1, NOW(), NOW()),
(4, 'accountant_of', 'person', 'organization', 0, '#ffffff', '#27ae60', 'fa-solid fa-calculator', 4, 0, 1, NOW(), NOW()),
(5, 'decision_maker', 'person', 'organization', 0, '#ffffff', '#c0392b', 'fa-solid fa-gavel', 5, 0, 1, NOW(), NOW()),
(6, 'branch_of', 'organization', 'organization', 0, '#ffffff', '#2980b9', 'fa-solid fa-code-branch', 6, 0, 1, NOW(), NOW()),
(7, 'subsidiary_of', 'organization', 'organization', 0, '#ffffff', '#6c3483', 'fa-solid fa-sitemap', 7, 0, 1, NOW(), NOW()),
(8, 'family', 'person', 'person', 1, '#ffffff', '#e67e22', 'fa-solid fa-people-roof', 8, 0, 1, NOW(), NOW()),
(9, 'referred_by', 'all', 'all', 0, '#ffffff', '#f39c12', 'fa-solid fa-share-nodes', 9, 0, 1, NOW(), NOW()),
(10, 'member_of', 'all', 'group', 0, '#ffffff', '#7f8c8d', 'fa-solid fa-users', 10, 0, 1, NOW(), NOW());

-- Дані: prefix_clients_relationship_types_lang (20 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_clients_relationship_types_lang` (`id`, `id_relationship_type`, `id_lang`, `name`, `reverse_name`) VALUES
(1, 1, 1, 'Works at', 'Employee'),
(2, 1, 2, 'Працює в', 'Працівник'),
(3, 2, 1, 'Director of', 'Director'),
(4, 2, 2, 'Директор', 'Директор'),
(5, 3, 1, 'Contact person of', 'Contact person'),
(6, 3, 2, 'Контактна особа', 'Контактна особа'),
(7, 4, 1, 'Accountant of', 'Accountant'),
(8, 4, 2, 'Бухгалтер', 'Бухгалтер'),
(9, 5, 1, 'Decision maker at', 'Decision maker'),
(10, 5, 2, 'Приймає рішення в', 'Особа, що приймає рішення'),
(11, 6, 1, 'Branch of', 'Branch'),
(12, 6, 2, 'Філія', 'Має філію'),
(13, 7, 1, 'Subsidiary of', 'Subsidiary'),
(14, 7, 2, 'Дочірня компанія', 'Материнська компанія'),
(15, 8, 1, 'Family member', 'Family member'),
(16, 8, 2, 'Родич', 'Родич'),
(17, 9, 1, 'Referred by', 'Referred'),
(18, 9, 2, 'Рекомендований', 'Рекомендував'),
(19, 10, 1, 'Member of', 'Member'),
(20, 10, 2, 'Учасник', 'Має учасника');

-- Дані: prefix_clients_role_types (6 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_clients_role_types` (`id`, `code`, `color_text`, `color_background`, `icon`, `sort`, `is_system`, `active`, `date_add`, `date_edit`) VALUES
(1, 'customer', '#ffffff', '#27ae60', 'fa-solid fa-cart-shopping', 1, 1, 1, NOW(), NOW()),
(2, 'supplier', '#ffffff', '#2980b9', 'fa-solid fa-truck-ramp-box', 2, 1, 1, NOW(), NOW()),
(3, 'partner', '#ffffff', '#8e44ad', 'fa-solid fa-handshake', 3, 0, 1, NOW(), NOW()),
(4, 'dealer', '#ffffff', '#d35400', 'fa-solid fa-store', 4, 0, 1, NOW(), NOW()),
(5, 'dropshipper', '#ffffff', '#16a085', 'fa-solid fa-boxes-packing', 5, 0, 1, NOW(), NOW()),
(6, 'competitor', '#ffffff', '#7f8c8d', 'fa-solid fa-chess', 6, 0, 1, NOW(), NOW());

-- Дані: prefix_clients_role_types_lang (12 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_clients_role_types_lang` (`id`, `id_role_type`, `id_lang`, `name`) VALUES
(1, 1, 1, 'Customer'),
(2, 1, 2, 'Клієнт'),
(3, 2, 1, 'Supplier'),
(4, 2, 2, 'Постачальник'),
(5, 3, 1, 'Partner'),
(6, 3, 2, 'Партнер'),
(7, 4, 1, 'Dealer'),
(8, 4, 2, 'Дилер'),
(9, 5, 1, 'Dropshipper'),
(10, 5, 2, 'Дропшипер'),
(11, 6, 1, 'Competitor'),
(12, 6, 2, 'Конкурент');

-- Дані: prefix_companies_bank_account_type (0 рядків, режим insert-ignore)

-- Дані: prefix_companies_bank_account_type_lang (0 рядків, режим insert-ignore)

-- Дані: prefix_companies_email_type (5 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_email_type` (`id`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW()),
(5, 1, 5, NOW(), NOW());

-- Дані: prefix_companies_email_type_lang (10 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_email_type_lang` (`id`, `id_email_type`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Загальний'),
(2, 1, 1, 'General'),
(3, 2, 2, 'Продажі'),
(4, 2, 1, 'Sales'),
(5, 3, 2, 'Бухгалтерія'),
(6, 3, 1, 'Accounting'),
(7, 4, 2, 'Директор'),
(8, 4, 1, 'Director'),
(9, 5, 2, 'Технічний'),
(10, 5, 1, 'Technical');

-- Дані: prefix_companies_industry (7 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_industry` (`id`, `code`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, '46', 1, 1, NOW(), NOW()),
(2, '10', 1, 2, NOW(), NOW()),
(3, '62', 1, 3, NOW(), NOW()),
(4, '49', 1, 4, NOW(), NOW()),
(5, '41', 1, 5, NOW(), NOW()),
(6, '64', 1, 6, NOW(), NOW()),
(7, '86', 1, 7, NOW(), NOW());

-- Дані: prefix_companies_industry_lang (14 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_industry_lang` (`id`, `id_industry`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Оптова торгівля'),
(2, 1, 1, 'Wholesale Trade'),
(3, 2, 2, 'Виробництво'),
(4, 2, 1, 'Manufacturing'),
(5, 3, 2, 'IT та технології'),
(6, 3, 1, 'IT & Technology'),
(7, 4, 2, 'Логістика'),
(8, 4, 1, 'Logistics'),
(9, 5, 2, 'Будівництво'),
(10, 5, 1, 'Construction'),
(11, 6, 2, 'Фінанси та банки'),
(12, 6, 1, 'Finance & Banking'),
(13, 7, 2, 'Медицина'),
(14, 7, 1, 'Healthcare');

-- Дані: prefix_companies_legal_form (6 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_legal_form` (`id`, `code`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 'ТОВ', 1, 1, NOW(), NOW()),
(2, 'ФОП', 1, 2, NOW(), NOW()),
(3, 'ПАТ', 1, 3, NOW(), NOW()),
(4, 'ПП', 1, 4, NOW(), NOW()),
(5, 'ДП', 1, 5, NOW(), NOW()),
(6, 'КП', 1, 6, NOW(), NOW());

-- Дані: prefix_companies_legal_form_lang (12 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_legal_form_lang` (`id`, `id_legal_form`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Товариство з обмеженою відповідальністю'),
(2, 1, 1, 'Limited Liability Company'),
(3, 2, 2, 'Фізична особа-підприємець'),
(4, 2, 1, 'Sole Proprietor'),
(5, 3, 2, 'Публічне акціонерне товариство'),
(6, 3, 1, 'Public Joint-Stock Company'),
(7, 4, 2, 'Приватне підприємство'),
(8, 4, 1, 'Private Enterprise'),
(9, 5, 2, 'Державне підприємство'),
(10, 5, 1, 'State Enterprise'),
(11, 6, 2, 'Комунальне підприємство'),
(12, 6, 1, 'Municipal Enterprise');

-- Дані: prefix_companies_phone_type (5 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_phone_type` (`id`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW()),
(5, 1, 5, NOW(), NOW());

-- Дані: prefix_companies_phone_type_lang (10 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_phone_type_lang` (`id`, `id_phone_type`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Головний'),
(2, 1, 1, 'Main'),
(3, 2, 2, 'Відділ продажів'),
(4, 2, 1, 'Sales'),
(5, 3, 2, 'Бухгалтерія'),
(6, 3, 1, 'Accounting'),
(7, 4, 2, 'Директор'),
(8, 4, 1, 'Director'),
(9, 5, 2, 'Служба підтримки'),
(10, 5, 1, 'Support');

-- Дані: prefix_companies_segment (3 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_segment` (`id`, `color_background`, `color_text`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, '#28a745', '#ffffff', 1, 1, NOW(), NOW()),
(2, '#ffc107', '#000000', 1, 2, NOW(), NOW()),
(3, '#6c757d', '#ffffff', 1, 3, NOW(), NOW());

-- Дані: prefix_companies_segment_lang (6 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_segment_lang` (`id`, `id_segment`, `id_lang`, `name`, `description`) VALUES
(1, 1, 2, 'A — Ключові', 'Найцінніші клієнти, пріоритет'),
(2, 1, 1, 'A — Key', 'Top-priority clients'),
(3, 2, 2, 'B — Активні', 'Регулярні клієнти середнього рівня'),
(4, 2, 1, 'B — Active', 'Regular mid-tier clients'),
(5, 3, 2, 'C — Потенційні', 'Рідко купують або в процесі'),
(6, 3, 1, 'C — Potential', 'Rarely buy or in process');

-- Дані: prefix_companies_social_type (10 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_social_type` (`id`, `code`, `icon`, `color`, `url_pattern`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 'linkedin', 'fab fa-linkedin', '#0077b5', 'https://linkedin.com/company/{handle}', 1, 1, NOW(), NOW()),
(2, 'facebook', 'fab fa-facebook', '#1877f2', 'https://facebook.com/{handle}', 1, 2, NOW(), NOW()),
(3, 'instagram', 'fab fa-instagram', '#e4405f', 'https://instagram.com/{handle}', 1, 3, NOW(), NOW()),
(4, 'telegram', 'fab fa-telegram', '#2ca5e0', 'https://t.me/{handle}', 1, 4, NOW(), NOW()),
(5, 'viber', 'fab fa-viber', '#7360f2', NULL, 1, 5, NOW(), NOW()),
(6, 'whatsapp', 'fab fa-whatsapp', '#25d366', 'https://wa.me/{handle}', 1, 6, NOW(), NOW()),
(7, 'youtube', 'fab fa-youtube', '#ff0000', 'https://youtube.com/@{handle}', 1, 7, NOW(), NOW()),
(8, 'twitter', 'fab fa-x-twitter', '#000000', 'https://x.com/{handle}', 1, 8, NOW(), NOW()),
(9, 'tiktok', 'fab fa-tiktok', '#010101', 'https://tiktok.com/@{handle}', 1, 9, NOW(), NOW()),
(10, 'skype', 'fab fa-skype', '#00aff0', 'skype:{handle}?call', 1, 10, NOW(), NOW());

-- Дані: prefix_companies_social_type_lang (20 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_social_type_lang` (`id`, `id_social_type`, `id_lang`, `name`) VALUES
(1, 1, 1, 'LinkedIn'),
(2, 1, 2, 'LinkedIn'),
(3, 2, 1, 'Facebook'),
(4, 2, 2, 'Facebook'),
(5, 3, 1, 'Instagram'),
(6, 3, 2, 'Instagram'),
(7, 4, 1, 'Telegram'),
(8, 4, 2, 'Telegram'),
(9, 5, 1, 'Viber'),
(10, 5, 2, 'Viber'),
(11, 6, 1, 'WhatsApp'),
(12, 6, 2, 'WhatsApp'),
(13, 7, 1, 'YouTube'),
(14, 7, 2, 'YouTube'),
(15, 8, 1, 'X (Twitter)'),
(16, 8, 2, 'X (Twitter)'),
(17, 9, 1, 'TikTok'),
(18, 9, 2, 'TikTok'),
(19, 10, 1, 'Skype'),
(20, 10, 2, 'Skype');

-- Дані: prefix_companies_source (6 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_source` (`id`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW()),
(5, 1, 5, NOW(), NOW()),
(6, 1, 6, NOW(), NOW());

-- Дані: prefix_companies_source_lang (12 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_source_lang` (`id`, `id_source`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Сайт / Форма'),
(2, 1, 1, 'Website / Form'),
(3, 2, 2, 'Холодний дзвінок'),
(4, 2, 1, 'Cold Call'),
(5, 3, 2, 'Виставка / Захід'),
(6, 3, 1, 'Exhibition / Event'),
(7, 4, 2, 'Реферал'),
(8, 4, 1, 'Referral'),
(9, 5, 2, 'Соціальні мережі'),
(10, 5, 1, 'Social Media'),
(11, 6, 2, 'Особистий контакт'),
(12, 6, 1, 'Personal Contact');

-- Дані: prefix_companies_status (4 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_status` (`id`, `color_background`, `color_text`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, '#28a745', '#ffffff', 1, 1, NOW(), NOW()),
(2, '#007bff', '#ffffff', 1, 2, NOW(), NOW()),
(3, '#6c757d', '#ffffff', 1, 3, NOW(), NOW()),
(4, '#dc3545', '#ffffff', 1, 4, NOW(), NOW());

-- Дані: prefix_companies_status_lang (8 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_status_lang` (`id`, `id_company_status`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Активна'),
(2, 1, 1, 'Active'),
(3, 2, 2, 'Потенційна'),
(4, 2, 1, 'Potential'),
(5, 3, 2, 'Неактивна'),
(6, 3, 1, 'Inactive'),
(7, 4, 2, 'Заблокована'),
(8, 4, 1, 'Blocked');

-- Дані: prefix_companies_tag_category (4 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_tag_category` (`id`, `color`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, '#007bff', 1, 1, NOW(), NOW()),
(2, '#28a745', 1, 2, NOW(), NOW()),
(3, '#ffc107', 1, 3, NOW(), NOW()),
(4, '#dc3545', 1, 4, NOW(), NOW());

-- Дані: prefix_companies_tag_category_lang (8 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_tag_category_lang` (`id`, `id_tag_category`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Тип співпраці'),
(2, 1, 1, 'Cooperation Type'),
(3, 2, 2, 'Маркетинг'),
(4, 2, 1, 'Marketing'),
(5, 3, 2, 'Фінанси'),
(6, 3, 1, 'Finance'),
(7, 4, 2, 'Пріоритет'),
(8, 4, 1, 'Priority');

-- Дані: prefix_companies_type (6 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_type` (`id`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW()),
(5, 1, 5, NOW(), NOW()),
(6, 1, 6, NOW(), NOW());

-- Дані: prefix_companies_type_lang (12 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_companies_type_lang` (`id`, `id_company_type`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Клієнт'),
(2, 1, 1, 'Client'),
(3, 2, 2, 'Постачальник'),
(4, 2, 1, 'Supplier'),
(5, 3, 2, 'Партнер'),
(6, 3, 1, 'Partner'),
(7, 4, 2, 'Конкурент'),
(8, 4, 1, 'Competitor'),
(9, 5, 2, 'Дистриб\'ютор'),
(10, 5, 1, 'Distributor'),
(11, 6, 2, 'Посередник'),
(12, 6, 1, 'Intermediary');

-- Дані: prefix_contact_label_dict (6 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contact_label_dict` (`id`, `code`, `sort`) VALUES
(1, 'work', 1),
(2, 'home', 2),
(3, 'personal', 3),
(4, 'wife', 4),
(5, 'husband', 5),
(6, 'accountant', 6);

-- Дані: prefix_contact_label_dict_lang (12 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contact_label_dict_lang` (`id`, `id_label`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Робочий'),
(2, 1, 1, 'Work'),
(3, 2, 2, 'Домашній'),
(4, 2, 1, 'Home'),
(5, 3, 2, 'Особистий'),
(6, 3, 1, 'Personal'),
(7, 4, 2, 'Дружина'),
(8, 4, 1, 'Wife'),
(9, 5, 2, 'Чоловік'),
(10, 5, 1, 'Husband'),
(11, 6, 2, 'Бухгалтер'),
(12, 6, 1, 'Accountant');

-- Дані: prefix_contacts_address_type (4 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_address_type` (`id`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW());

-- Дані: prefix_contacts_address_type_lang (8 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_address_type_lang` (`id`, `id_address_type`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Домашня'),
(2, 1, 1, 'Home'),
(3, 2, 2, 'Робоча'),
(4, 2, 1, 'Work'),
(5, 3, 2, 'Для доставки'),
(6, 3, 1, 'Shipping'),
(7, 4, 2, 'Інша'),
(8, 4, 1, 'Other');

-- Дані: prefix_contacts_file_category (6 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_file_category` (`id`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW()),
(5, 1, 5, NOW(), NOW()),
(6, 1, 6, NOW(), NOW());

-- Дані: prefix_contacts_file_category_lang (12 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_file_category_lang` (`id`, `id_category`, `id_lang`, `name`) VALUES
(1, 1, 2, 'NDA / Угода'),
(2, 1, 1, 'NDA / Agreement'),
(3, 2, 2, 'Резюме'),
(4, 2, 1, 'Resume / CV'),
(5, 3, 2, 'Документ'),
(6, 3, 1, 'Document'),
(7, 4, 2, 'Презентація'),
(8, 4, 1, 'Presentation'),
(9, 5, 2, 'Фото'),
(10, 5, 1, 'Photo'),
(11, 6, 2, 'Інше'),
(12, 6, 1, 'Other');

-- Дані: prefix_contacts_role (7 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_role` (`id`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW()),
(5, 1, 5, NOW(), NOW()),
(6, 1, 6, NOW(), NOW()),
(7, 1, 7, NOW(), NOW());

-- Дані: prefix_contacts_role_lang (14 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_role_lang` (`id`, `id_role`, `id_lang`, `name`, `description`) VALUES
(1, 1, 2, 'ЛПР', 'Особа що приймає рішення'),
(2, 1, 1, 'Decision Maker', 'Person who makes decisions'),
(3, 2, 2, 'Агент впливу', 'Впливає на рішення але не вирішує'),
(4, 2, 1, 'Influencer', 'Influences decisions'),
(5, 3, 2, 'Бухгалтер', 'Фінансові питання та оплати'),
(6, 3, 1, 'Accountant', 'Financial and payment matters'),
(7, 4, 2, 'Технічний спец.', 'Технічна оцінка продукту'),
(8, 4, 1, 'Technical', 'Technical product evaluation'),
(9, 5, 2, 'Керівник проекту', 'Веде проект з боку клієнта'),
(10, 5, 1, 'Project Manager', 'Manages project on client side'),
(11, 6, 2, 'Кінцевий користувач', 'Використовує продукт'),
(12, 6, 1, 'End User', 'Uses the product'),
(13, 7, 2, 'Секретар / Асистент', 'Фільтрує доступ до ЛПР'),
(14, 7, 1, 'Assistant', 'Filters access to decision maker');

-- Дані: prefix_contacts_salutation (4 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_salutation` (`id`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW());

-- Дані: prefix_contacts_salutation_lang (8 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_salutation_lang` (`id`, `id_salutation`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Пан'),
(2, 1, 1, 'Mr.'),
(3, 2, 2, 'Пані'),
(4, 2, 1, 'Ms.'),
(5, 3, 2, 'Др.'),
(6, 3, 1, 'Dr.'),
(7, 4, 2, 'Проф.'),
(8, 4, 1, 'Prof.');

-- Дані: prefix_contacts_segment (3 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_segment` (`id`, `color_background`, `color_text`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, '#28a745', '#ffffff', 1, 1, NOW(), NOW()),
(2, '#ffc107', '#000000', 1, 2, NOW(), NOW()),
(3, '#6c757d', '#ffffff', 1, 3, NOW(), NOW());

-- Дані: prefix_contacts_segment_lang (6 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_segment_lang` (`id`, `id_segment`, `id_lang`, `name`, `description`) VALUES
(1, 1, 2, 'A — Ключові', 'Найцінніші контакти'),
(2, 1, 1, 'A — Key', 'Top priority contacts'),
(3, 2, 2, 'B — Активні', 'Регулярні контакти'),
(4, 2, 1, 'B — Active', 'Regular contacts'),
(5, 3, 2, 'C — Потенційні', 'В процесі розвитку'),
(6, 3, 1, 'C — Potential', 'In development');

-- Дані: prefix_contacts_source (7 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_source` (`id`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW()),
(5, 1, 5, NOW(), NOW()),
(6, 1, 6, NOW(), NOW()),
(7, 1, 7, NOW(), NOW());

-- Дані: prefix_contacts_source_lang (14 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_source_lang` (`id`, `id_source`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Сайт / Форма'),
(2, 1, 1, 'Website / Form'),
(3, 2, 2, 'Холодний дзвінок'),
(4, 2, 1, 'Cold Call'),
(5, 3, 2, 'Виставка / Захід'),
(6, 3, 1, 'Exhibition / Event'),
(7, 4, 2, 'Реферал'),
(8, 4, 1, 'Referral'),
(9, 5, 2, 'Соціальні мережі'),
(10, 5, 1, 'Social Media'),
(11, 6, 2, 'Особистий контакт'),
(12, 6, 1, 'Personal Contact'),
(13, 7, 2, 'Імпорт'),
(14, 7, 1, 'Import');

-- Дані: prefix_contacts_status (4 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_status` (`id`, `color_background`, `color_text`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, '#28a745', '#ffffff', 1, 1, NOW(), NOW()),
(2, '#007bff', '#ffffff', 1, 2, NOW(), NOW()),
(3, '#6c757d', '#ffffff', 1, 3, NOW(), NOW()),
(4, '#dc3545', '#ffffff', 1, 4, NOW(), NOW());

-- Дані: prefix_contacts_status_lang (8 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_status_lang` (`id`, `id_contact_status`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Активний'),
(2, 1, 1, 'Active'),
(3, 2, 2, 'Потенційний'),
(4, 2, 1, 'Potential'),
(5, 3, 2, 'Неактивний'),
(6, 3, 1, 'Inactive'),
(7, 4, 2, 'Заблокований'),
(8, 4, 1, 'Blocked');

-- Дані: prefix_contacts_tag_category (5 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_tag_category` (`id`, `color`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, '#007bff', 1, 1, NOW(), NOW()),
(2, '#28a745', 1, 2, NOW(), NOW()),
(3, '#ffc107', 1, 3, NOW(), NOW()),
(4, '#dc3545', 1, 4, NOW(), NOW()),
(5, '#6f42c1', 1, 5, NOW(), NOW());

-- Дані: prefix_contacts_tag_category_lang (10 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_contacts_tag_category_lang` (`id`, `id_tag_category`, `id_lang`, `name`, `description`) VALUES
(1, 1, 2, 'Пріоритет', NULL),
(2, 1, 1, 'Priority', NULL),
(3, 2, 2, 'Тип співпраці', NULL),
(4, 2, 1, 'Cooperation Type', NULL),
(5, 3, 2, 'Маркетинг', NULL),
(6, 3, 1, 'Marketing', NULL),
(7, 4, 2, 'Фінанси', NULL),
(8, 4, 1, 'Finance', NULL),
(9, 5, 2, 'Кваліфікація', NULL),
(10, 5, 1, 'Qualification', NULL);

-- Дані: prefix_currencies (5 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_currencies` (`id`, `iso`, `symbol`, `symbol_pos`, `rate`, `rate_updated`, `is_base`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 'UAH', '₴', 0, '1.000000', NULL, 1, 1, 1, NOW(), NOW()),
(2, 'USD', '$', 0, '0.024000', NULL, 0, 1, 2, NOW(), NOW()),
(3, 'EUR', '€', 0, '0.022000', NULL, 0, 1, 3, NOW(), NOW()),
(4, 'PLN', 'zł', 1, '0.098000', NULL, 0, 1, 4, NOW(), NOW()),
(5, 'GBP', '£', 0, '0.019000', NULL, 0, 1, 5, NOW(), NOW());

-- Дані: prefix_currencies_lang (10 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_currencies_lang` (`id`, `id_currency`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Українська гривня'),
(2, 1, 1, 'Ukrainian Hryvnia'),
(3, 2, 2, 'Долар США'),
(4, 2, 1, 'US Dollar'),
(5, 3, 2, 'Євро'),
(6, 3, 1, 'Euro'),
(7, 4, 2, 'Польський злотий'),
(8, 4, 1, 'Polish Zloty'),
(9, 5, 2, 'Британський фунт'),
(10, 5, 1, 'British Pound');

-- Дані: prefix_customer_loyalty_levels_dict (4 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_customer_loyalty_levels_dict` (`id`, `code`, `color`, `points_required`, `sort`, `active`) VALUES
(1, 'bronze', '#CD7F32', 0, 1, 1),
(2, 'silver', '#C0C0C0', 500, 2, 1),
(3, 'gold', '#FFD700', 1500, 3, 1),
(4, 'platinum', '#E5E4E2', 5000, 4, 1);

-- Дані: prefix_customer_loyalty_levels_dict_lang (8 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_customer_loyalty_levels_dict_lang` (`id`, `id_level`, `id_lang`, `name`, `description`) VALUES
(1, 1, 2, 'Бронза', 'Початковий рівень'),
(2, 1, 1, 'Bronze', 'Entry level'),
(3, 2, 2, 'Срібло', 'Постійний клієнт'),
(4, 2, 1, 'Silver', 'Regular customer'),
(5, 3, 2, 'Золото', 'Преміум клієнт'),
(6, 3, 1, 'Gold', 'Premium customer'),
(7, 4, 2, 'Платина', 'Найвищий рівень'),
(8, 4, 1, 'Platinum', 'Top tier customer');

-- Дані: prefix_customers_groups (4 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_customers_groups` (`id`, `color_text`, `color_background`, `icon`, `sort`, `active`, `date_add`, `date_edit`) VALUES
(1, '#ffffff', '#999999', '', 1, 1, NOW(), NOW()),
(2, '#ffffff', '#FFD700', '', 2, 1, NOW(), NOW()),
(3, '#ffffff', '#FF8C00', '', 3, 1, NOW(), NOW()),
(4, '#ffffff', '#dc3545', '🔥', 4, 1, NOW(), NOW());

-- Дані: prefix_customers_groups_lang (8 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_customers_groups_lang` (`id`, `id_group`, `id_lang`, `text`) VALUES
(1, 1, 2, 'За замовчуванням'),
(2, 1, 1, 'Default'),
(3, 2, 2, 'VIP'),
(4, 2, 1, 'VIP'),
(5, 3, 2, 'Оптовий покупець'),
(6, 3, 1, 'Bulk Buyer'),
(7, 4, 2, 'Під загрозою'),
(8, 4, 1, 'At Risk');

-- Дані: prefix_deals_act_status (4 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_act_status` (`id`, `color_background`, `color_text`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, '#6c757d', '#ffffff', 1, 1, NOW(), NOW()),
(2, '#007bff', '#ffffff', 1, 2, NOW(), NOW()),
(3, '#28a745', '#ffffff', 1, 3, NOW(), NOW()),
(4, '#dc3545', '#ffffff', 1, 4, NOW(), NOW());

-- Дані: prefix_deals_act_status_lang (8 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_act_status_lang` (`id`, `id_act_status`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Чернетка'),
(2, 1, 1, 'Draft'),
(3, 2, 2, 'Надіслано'),
(4, 2, 1, 'Sent'),
(5, 3, 2, 'Підписано'),
(6, 3, 1, 'Signed'),
(7, 4, 2, 'Оскаржено'),
(8, 4, 1, 'Disputed');

-- Дані: prefix_deals_activity_outcome (9 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_activity_outcome` (`id`, `id_activity_type`, `color_background`, `color_text`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, '#d1e7dd', '#0a3622', 1, 1, NOW(), NOW()),
(2, 1, '#f8d7da', '#58151c', 1, 2, NOW(), NOW()),
(3, 1, '#fff3cd', '#664d03', 1, 3, NOW(), NOW()),
(4, 1, '#e2d9f3', '#432874', 1, 4, NOW(), NOW()),
(5, 2, '#d1e7dd', '#0a3622', 1, 1, NOW(), NOW()),
(6, 2, '#f8d7da', '#58151c', 1, 2, NOW(), NOW()),
(7, 2, '#fff3cd', '#664d03', 1, 3, NOW(), NOW()),
(8, NULL, '#d1e7dd', '#0a3622', 1, 1, NOW(), NOW()),
(9, NULL, '#f8d7da', '#58151c', 1, 2, NOW(), NOW());

-- Дані: prefix_deals_activity_outcome_lang (18 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_activity_outcome_lang` (`id`, `id_outcome`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Додзвонився'),
(2, 1, 1, 'Reached'),
(3, 2, 2, 'Не додзвонився'),
(4, 2, 1, 'No Answer'),
(5, 3, 2, 'Зайнятий'),
(6, 3, 1, 'Busy'),
(7, 4, 2, 'Передзвонить сам'),
(8, 4, 1, 'Will Call Back'),
(9, 5, 2, 'Зустріч відбулась'),
(10, 5, 1, 'Meeting Held'),
(11, 6, 2, 'Перенесено'),
(12, 6, 1, 'Rescheduled'),
(13, 7, 2, 'Скасовано'),
(14, 7, 1, 'Canceled'),
(15, 8, 2, 'Виконано'),
(16, 8, 1, 'Completed'),
(17, 9, 2, 'Не виконано'),
(18, 9, 1, 'Not Completed');

-- Дані: prefix_deals_activity_type (12 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_activity_type` (`id`, `code`, `icon`, `color`, `has_duration`, `has_location`, `has_outcome`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 'call', 'fas fa-phone', '#28a745', 1, 0, 1, 1, 1, NOW(), NOW()),
(2, 'meeting', 'fas fa-users', '#007bff', 1, 1, 1, 1, 2, NOW(), NOW()),
(3, 'email', 'fas fa-envelope', '#6f42c1', 0, 0, 1, 1, 3, NOW(), NOW()),
(4, 'note', 'fas fa-sticky-note', '#ffc107', 0, 0, 0, 1, 4, NOW(), NOW()),
(5, 'task', 'fas fa-check-square', '#17a2b8', 0, 0, 1, 1, 5, NOW(), NOW()),
(6, 'demo', 'fas fa-desktop', '#fd7e14', 1, 1, 1, 1, 6, NOW(), NOW()),
(7, 'presentation', 'fas fa-file-powerpoint', '#e83e8c', 1, 1, 1, 1, 7, NOW(), NOW()),
(8, 'whatsapp', 'fab fa-whatsapp', '#25d366', 0, 0, 1, 1, 8, NOW(), NOW()),
(9, 'telegram', 'fab fa-telegram', '#2ca5e0', 0, 0, 1, 1, 9, NOW(), NOW()),
(10, 'viber', 'fab fa-viber', '#7360f2', 0, 0, 1, 1, 10, NOW(), NOW()),
(11, 'deadline', 'fas fa-flag', '#dc3545', 0, 0, 0, 1, 11, NOW(), NOW()),
(12, 'document', 'fas fa-file-alt', '#6c757d', 0, 0, 0, 1, 12, NOW(), NOW());

-- Дані: prefix_deals_activity_type_lang (24 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_activity_type_lang` (`id`, `id_activity_type`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Дзвінок'),
(2, 1, 1, 'Call'),
(3, 2, 2, 'Зустріч'),
(4, 2, 1, 'Meeting'),
(5, 3, 2, 'Email'),
(6, 3, 1, 'Email'),
(7, 4, 2, 'Нотатка'),
(8, 4, 1, 'Note'),
(9, 5, 2, 'Завдання'),
(10, 5, 1, 'Task'),
(11, 6, 2, 'Демо'),
(12, 6, 1, 'Demo'),
(13, 7, 2, 'Презентація'),
(14, 7, 1, 'Presentation'),
(15, 8, 2, 'WhatsApp'),
(16, 8, 1, 'WhatsApp'),
(17, 9, 2, 'Telegram'),
(18, 9, 1, 'Telegram'),
(19, 10, 2, 'Viber'),
(20, 10, 1, 'Viber'),
(21, 11, 2, 'Дедлайн'),
(22, 11, 1, 'Deadline'),
(23, 12, 2, 'Документ'),
(24, 12, 1, 'Document');

-- Дані: prefix_deals_calendar_event_type (7 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_calendar_event_type` (`id`, `code`, `icon`, `color`, `has_location`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 'meeting', 'fas fa-handshake', '#007bff', 1, 1, 1, NOW(), NOW()),
(2, 'call', 'fas fa-phone', '#28a745', 0, 1, 2, NOW(), NOW()),
(3, 'reminder', 'fas fa-bell', '#ffc107', 0, 1, 3, NOW(), NOW()),
(4, 'deadline', 'fas fa-flag', '#dc3545', 0, 1, 4, NOW(), NOW()),
(5, 'demo', 'fas fa-desktop', '#fd7e14', 1, 1, 5, NOW(), NOW()),
(6, 'internal', 'fas fa-users', '#6f42c1', 1, 1, 6, NOW(), NOW()),
(7, 'other', 'fas fa-circle', '#6c757d', 1, 1, 7, NOW(), NOW());

-- Дані: prefix_deals_calendar_event_type_lang (14 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_calendar_event_type_lang` (`id`, `id_event_type`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Зустріч'),
(2, 1, 1, 'Meeting'),
(3, 2, 2, 'Дзвінок'),
(4, 2, 1, 'Call'),
(5, 3, 2, 'Нагадування'),
(6, 3, 1, 'Reminder'),
(7, 4, 2, 'Дедлайн'),
(8, 4, 1, 'Deadline'),
(9, 5, 2, 'Демо'),
(10, 5, 1, 'Demo'),
(11, 6, 2, 'Внутрішня нарада'),
(12, 6, 1, 'Internal meeting'),
(13, 7, 2, 'Інше'),
(14, 7, 1, 'Other');

-- Дані: prefix_deals_contract_status (6 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_contract_status` (`id`, `color_background`, `color_text`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, '#6c757d', '#ffffff', 1, 1, NOW(), NOW()),
(2, '#ffc107', '#000000', 1, 2, NOW(), NOW()),
(3, '#28a745', '#ffffff', 1, 3, NOW(), NOW()),
(4, '#17a2b8', '#ffffff', 1, 4, NOW(), NOW()),
(5, '#dc3545', '#ffffff', 1, 5, NOW(), NOW()),
(6, '#6c757d', '#ffffff', 1, 6, NOW(), NOW());

-- Дані: prefix_deals_contract_status_lang (12 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_contract_status_lang` (`id`, `id_contract_status`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Чернетка'),
(2, 1, 1, 'Draft'),
(3, 2, 2, 'На підписанні'),
(4, 2, 1, 'Pending Signature'),
(5, 3, 2, 'Активний'),
(6, 3, 1, 'Active'),
(7, 4, 2, 'Завершений'),
(8, 4, 1, 'Completed'),
(9, 5, 2, 'Розірваний'),
(10, 5, 1, 'Terminated'),
(11, 6, 2, 'Призупинений'),
(12, 6, 1, 'Suspended');

-- Дані: prefix_deals_contract_type (7 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_contract_type` (`id`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW()),
(5, 1, 5, NOW(), NOW()),
(6, 1, 6, NOW(), NOW()),
(7, 1, 7, NOW(), NOW());

-- Дані: prefix_deals_contract_type_lang (14 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_contract_type_lang` (`id`, `id_contract_type`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Договір постачання'),
(2, 1, 1, 'Supply Agreement'),
(3, 2, 2, 'Договір послуг'),
(4, 2, 1, 'Service Agreement'),
(5, 3, 2, 'Рамковий договір'),
(6, 3, 1, 'Framework Agreement'),
(7, 4, 2, 'Агентський договір'),
(8, 4, 1, 'Agency Agreement'),
(9, 5, 2, 'NDA'),
(10, 5, 1, 'NDA'),
(11, 6, 2, 'Ліцензійна угода'),
(12, 6, 1, 'License Agreement'),
(13, 7, 2, 'Договір підряду'),
(14, 7, 1, 'Contract Work Agreement');

-- Дані: prefix_deals_file_category (8 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_file_category` (`id`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW()),
(5, 1, 5, NOW(), NOW()),
(6, 1, 6, NOW(), NOW()),
(7, 1, 7, NOW(), NOW()),
(8, 1, 8, NOW(), NOW());

-- Дані: prefix_deals_file_category_lang (16 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_file_category_lang` (`id`, `id_category`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Комерційна пропозиція'),
(2, 1, 1, 'Quote'),
(3, 2, 2, 'Договір'),
(4, 2, 1, 'Contract'),
(5, 3, 2, 'Рахунок'),
(6, 3, 1, 'Invoice'),
(7, 4, 2, 'Акт'),
(8, 4, 1, 'Act'),
(9, 5, 2, 'Специфікація'),
(10, 5, 1, 'Specification'),
(11, 6, 2, 'Презентація'),
(12, 6, 1, 'Presentation'),
(13, 7, 2, 'Технічне завдання'),
(14, 7, 1, 'Technical Spec'),
(15, 8, 2, 'Інше'),
(16, 8, 1, 'Other');

-- Дані: prefix_deals_invoice_status (7 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_invoice_status` (`id`, `color_background`, `color_text`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, '#6c757d', '#ffffff', 1, 1, NOW(), NOW()),
(2, '#007bff', '#ffffff', 1, 2, NOW(), NOW()),
(3, '#ffc107', '#000000', 1, 3, NOW(), NOW()),
(4, '#28a745', '#ffffff', 1, 4, NOW(), NOW()),
(5, '#dc3545', '#ffffff', 1, 5, NOW(), NOW()),
(6, '#17a2b8', '#ffffff', 1, 6, NOW(), NOW()),
(7, '#6c757d', '#ffffff', 1, 7, NOW(), NOW());

-- Дані: prefix_deals_invoice_status_lang (14 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_invoice_status_lang` (`id`, `id_invoice_status`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Чернетка'),
(2, 1, 1, 'Draft'),
(3, 2, 2, 'Виставлено'),
(4, 2, 1, 'Issued'),
(5, 3, 2, 'Часткова оплата'),
(6, 3, 1, 'Partially Paid'),
(7, 4, 2, 'Оплачено'),
(8, 4, 1, 'Paid'),
(9, 5, 2, 'Прострочено'),
(10, 5, 1, 'Overdue'),
(11, 6, 2, 'Скасовано'),
(12, 6, 1, 'Canceled'),
(13, 7, 2, 'Повернення'),
(14, 7, 1, 'Refunded');

-- Дані: prefix_deals_item_type (8 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_item_type` (`id`, `code`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 'product', 1, 1, NOW(), NOW()),
(2, 'service', 1, 2, NOW(), NOW()),
(3, 'work', 1, 3, NOW(), NOW()),
(4, 'subscription', 1, 4, NOW(), NOW()),
(5, 'license', 1, 5, NOW(), NOW()),
(6, 'rental', 1, 6, NOW(), NOW()),
(7, 'training', 1, 7, NOW(), NOW()),
(8, 'custom', 1, 8, NOW(), NOW());

-- Дані: prefix_deals_item_type_lang (16 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_item_type_lang` (`id`, `id_item_type`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Товар'),
(2, 1, 1, 'Product'),
(3, 2, 2, 'Послуга'),
(4, 2, 1, 'Service'),
(5, 3, 2, 'Робота'),
(6, 3, 1, 'Work'),
(7, 4, 2, 'Підписка'),
(8, 4, 1, 'Subscription'),
(9, 5, 2, 'Ліцензія'),
(10, 5, 1, 'License'),
(11, 6, 2, 'Оренда'),
(12, 6, 1, 'Rental'),
(13, 7, 2, 'Навчання'),
(14, 7, 1, 'Training'),
(15, 8, 2, 'Довільна'),
(16, 8, 1, 'Custom');

-- Дані: prefix_deals_lost_reason (7 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_lost_reason` (`id`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW()),
(5, 1, 5, NOW(), NOW()),
(6, 1, 6, NOW(), NOW()),
(7, 1, 7, NOW(), NOW());

-- Дані: prefix_deals_lost_reason_lang (14 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_lost_reason_lang` (`id`, `id_lost_reason`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Ціна'),
(2, 1, 1, 'Price'),
(3, 2, 2, 'Обрали конкурента'),
(4, 2, 1, 'Chose competitor'),
(5, 3, 2, 'Немає бюджету'),
(6, 3, 1, 'No budget'),
(7, 4, 2, 'Відклали рішення'),
(8, 4, 1, 'Decision postponed'),
(9, 5, 2, 'Не влаштував продукт'),
(10, 5, 1, 'Product did not fit'),
(11, 6, 2, 'Немає потреби'),
(12, 6, 1, 'No need'),
(13, 7, 2, 'Немає відповіді'),
(14, 7, 1, 'No response');

-- Дані: prefix_deals_pipeline (3 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_pipeline` (`id`, `color`, `is_default`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, '#007bff', 1, 1, 1, NOW(), NOW()),
(2, '#28a745', 0, 1, 2, NOW(), NOW()),
(3, '#ffc107', 0, 1, 3, NOW(), NOW());

-- Дані: prefix_deals_pipeline_lang (6 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_pipeline_lang` (`id`, `id_pipeline`, `id_lang`, `name`, `description`) VALUES
(1, 1, 2, 'Основні продажі', 'Стандартна воронка продажів'),
(2, 1, 1, 'Main Sales', 'Standard sales pipeline'),
(3, 2, 2, 'Партнери', 'Воронка для партнерів'),
(4, 2, 1, 'Partners', 'Partner pipeline'),
(5, 3, 2, 'Тендери', 'Тендерні процедури'),
(6, 3, 1, 'Tenders', 'Tender procedures');

-- Дані: prefix_deals_quote_status (7 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_quote_status` (`id`, `color_background`, `color_text`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, '#6c757d', '#ffffff', 1, 1, NOW(), NOW()),
(2, '#007bff', '#ffffff', 1, 2, NOW(), NOW()),
(3, '#17a2b8', '#ffffff', 1, 3, NOW(), NOW()),
(4, '#28a745', '#ffffff', 1, 4, NOW(), NOW()),
(5, '#dc3545', '#ffffff', 1, 5, NOW(), NOW()),
(6, '#ffc107', '#000000', 1, 6, NOW(), NOW()),
(7, '#6c757d', '#ffffff', 1, 7, NOW(), NOW());

-- Дані: prefix_deals_quote_status_lang (14 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_quote_status_lang` (`id`, `id_quote_status`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Чернетка'),
(2, 1, 1, 'Draft'),
(3, 2, 2, 'Надіслано'),
(4, 2, 1, 'Sent'),
(5, 3, 2, 'Переглянуто'),
(6, 3, 1, 'Viewed'),
(7, 4, 2, 'Прийнято'),
(8, 4, 1, 'Accepted'),
(9, 5, 2, 'Відхилено'),
(10, 5, 1, 'Declined'),
(11, 6, 2, 'Прострочено'),
(12, 6, 1, 'Expired'),
(13, 7, 2, 'Скасовано'),
(14, 7, 1, 'Canceled');

-- Дані: prefix_deals_source (7 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_source` (`id`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW()),
(5, 1, 5, NOW(), NOW()),
(6, 1, 6, NOW(), NOW()),
(7, 1, 7, NOW(), NOW());

-- Дані: prefix_deals_source_lang (14 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_source_lang` (`id`, `id_source`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Вхідний запит'),
(2, 1, 1, 'Inbound'),
(3, 2, 2, 'Холодний дзвінок'),
(4, 2, 1, 'Cold Call'),
(5, 3, 2, 'Реферал'),
(6, 3, 1, 'Referral'),
(7, 4, 2, 'Виставка / Захід'),
(8, 4, 1, 'Event / Exhibition'),
(9, 5, 2, 'Сайт / Форма'),
(10, 5, 1, 'Website / Form'),
(11, 6, 2, 'Соціальні мережі'),
(12, 6, 1, 'Social Media'),
(13, 7, 2, 'Повторний клієнт'),
(14, 7, 1, 'Returning Client');

-- Дані: prefix_deals_stage (18 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_stage` (`id`, `id_pipeline`, `stage_type`, `probability`, `color_background`, `color_text`, `is_default`, `rotting_days`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 'open', 10, '#e7f3ff', '#084298', 1, 14, 1, 1, NOW(), NOW()),
(2, 1, 'open', 25, '#fff3cd', '#664d03', 0, 14, 1, 2, NOW(), NOW()),
(3, 1, 'open', 50, '#fde8d8', '#7a3c00', 0, 10, 1, 3, NOW(), NOW()),
(4, 1, 'open', 75, '#e2d9f3', '#432874', 0, 7, 1, 4, NOW(), NOW()),
(5, 1, 'open', 90, '#d1ecf1', '#0c5460', 0, 5, 1, 5, NOW(), NOW()),
(6, 1, 'won', 100, '#d1e7dd', '#0a3622', 0, NULL, 1, 6, NOW(), NOW()),
(7, 1, 'lost', 0, '#f8d7da', '#58151c', 0, NULL, 1, 7, NOW(), NOW()),
(8, 1, 'canceled', 0, '#e9ecef', '#495057', 0, NULL, 1, 8, NOW(), NOW()),
(9, 2, 'open', 20, '#e7f3ff', '#084298', 1, 21, 1, 1, NOW(), NOW()),
(10, 2, 'open', 60, '#fff3cd', '#664d03', 0, 14, 1, 2, NOW(), NOW()),
(11, 2, 'won', 100, '#d1e7dd', '#0a3622', 0, NULL, 1, 3, NOW(), NOW()),
(12, 2, 'lost', 0, '#f8d7da', '#58151c', 0, NULL, 1, 4, NOW(), NOW()),
(13, 3, 'open', 10, '#e7f3ff', '#084298', 1, 30, 1, 1, NOW(), NOW()),
(14, 3, 'open', 30, '#fff3cd', '#664d03', 0, 21, 1, 2, NOW(), NOW()),
(15, 3, 'open', 50, '#fde8d8', '#7a3c00', 0, 14, 1, 3, NOW(), NOW()),
(16, 3, 'open', 80, '#d1ecf1', '#0c5460', 0, 7, 1, 4, NOW(), NOW()),
(17, 3, 'won', 100, '#d1e7dd', '#0a3622', 0, NULL, 1, 5, NOW(), NOW()),
(18, 3, 'lost', 0, '#f8d7da', '#58151c', 0, NULL, 1, 6, NOW(), NOW());

-- Дані: prefix_deals_stage_lang (36 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_stage_lang` (`id`, `id_stage`, `id_lang`, `name`, `description`) VALUES
(1, 1, 2, 'Новий', NULL),
(2, 1, 1, 'New', NULL),
(3, 2, 2, 'Кваліфікація', NULL),
(4, 2, 1, 'Qualification', NULL),
(5, 3, 2, 'КП надіслано', NULL),
(6, 3, 1, 'Proposal Sent', NULL),
(7, 4, 2, 'Переговори', NULL),
(8, 4, 1, 'Negotiation', NULL),
(9, 5, 2, 'Договір', NULL),
(10, 5, 1, 'Contract', NULL),
(11, 6, 2, 'Виграно', NULL),
(12, 6, 1, 'Won', NULL),
(13, 7, 2, 'Програно', NULL),
(14, 7, 1, 'Lost', NULL),
(15, 8, 2, 'Скасовано', NULL),
(16, 8, 1, 'Canceled', NULL),
(17, 9, 2, 'Знайомство', NULL),
(18, 9, 1, 'Introduction', NULL),
(19, 10, 2, 'Погодження умов', NULL),
(20, 10, 1, 'Terms Agreement', NULL),
(21, 11, 2, 'Партнер підписаний', NULL),
(22, 11, 1, 'Partner Signed', NULL),
(23, 12, 2, 'Відмова', NULL),
(24, 12, 1, 'Declined', NULL),
(25, 13, 2, 'Моніторинг', NULL),
(26, 13, 1, 'Monitoring', NULL),
(27, 14, 2, 'Підготовка заявки', NULL),
(28, 14, 1, 'Bid Preparation', NULL),
(29, 15, 2, 'Заявку подано', NULL),
(30, 15, 1, 'Bid Submitted', NULL),
(31, 16, 2, 'Розгляд', NULL),
(32, 16, 1, 'Under Review', NULL),
(33, 17, 2, 'Тендер виграно', NULL),
(34, 17, 1, 'Tender Won', NULL),
(35, 18, 2, 'Тендер програно', NULL),
(36, 18, 1, 'Tender Lost', NULL);

-- Дані: prefix_deals_tax (4 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_tax` (`id`, `rate`, `is_default`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, '0.00', 0, 1, 1, NOW(), NOW()),
(2, '20.00', 1, 1, 2, NOW(), NOW()),
(3, '7.00', 0, 1, 3, NOW(), NOW()),
(4, '14.00', 0, 1, 4, NOW(), NOW());

-- Дані: prefix_deals_tax_lang (8 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_tax_lang` (`id`, `id_tax`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Без ПДВ'),
(2, 1, 1, 'No VAT'),
(3, 2, 2, 'ПДВ 20%'),
(4, 2, 1, 'VAT 20%'),
(5, 3, 2, 'ПДВ 7%'),
(6, 3, 1, 'VAT 7%'),
(7, 4, 2, 'ПДВ 14%'),
(8, 4, 1, 'VAT 14%');

-- Дані: prefix_deals_type (6 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_type` (`id`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW()),
(5, 1, 5, NOW(), NOW()),
(6, 1, 6, NOW(), NOW());

-- Дані: prefix_deals_type_lang (12 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_type_lang` (`id`, `id_deal_type`, `id_lang`, `name`) VALUES
(1, 1, 2, 'Новий бізнес'),
(2, 1, 1, 'New Business'),
(3, 2, 2, 'Повторний продаж'),
(4, 2, 1, 'Repeat Sale'),
(5, 3, 2, 'Upsell'),
(6, 3, 1, 'Upsell'),
(7, 4, 2, 'Cross-sell'),
(8, 4, 1, 'Cross-sell'),
(9, 5, 2, 'Продовження'),
(10, 5, 1, 'Renewal'),
(11, 6, 2, 'Тендер'),
(12, 6, 1, 'Tender');

-- Дані: prefix_deals_unit (10 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_unit` (`id`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW()),
(5, 1, 5, NOW(), NOW()),
(6, 1, 6, NOW(), NOW()),
(7, 1, 7, NOW(), NOW()),
(8, 1, 8, NOW(), NOW()),
(9, 1, 9, NOW(), NOW()),
(10, 1, 10, NOW(), NOW());

-- Дані: prefix_deals_unit_lang (20 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_deals_unit_lang` (`id`, `id_unit`, `id_lang`, `name`, `name_short`) VALUES
(1, 1, 2, 'Штука', 'шт'),
(2, 1, 1, 'Piece', 'pcs'),
(3, 2, 2, 'Година', 'год'),
(4, 2, 1, 'Hour', 'hr'),
(5, 3, 2, 'День', 'день'),
(6, 3, 1, 'Day', 'day'),
(7, 4, 2, 'Місяць', 'міс'),
(8, 4, 1, 'Month', 'mo'),
(9, 5, 2, 'Рік', 'рік'),
(10, 5, 1, 'Year', 'yr'),
(11, 6, 2, 'Кілограм', 'кг'),
(12, 6, 1, 'Kilogram', 'kg'),
(13, 7, 2, 'Метр', 'м'),
(14, 7, 1, 'Meter', 'm'),
(15, 8, 2, 'Комплект', 'компл'),
(16, 8, 1, 'Set', 'set'),
(17, 9, 2, 'Ліцензія', 'ліц'),
(18, 9, 1, 'License', 'lic'),
(19, 10, 2, 'Послуга', 'посл'),
(20, 10, 1, 'Service', 'svc');

-- Дані: prefix_languages (12 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_languages` (`id`, `iso`, `locale`, `name`, `native_name`, `direction`, `fallback_id`, `active`, `is_default`, `sort`) VALUES
(1, 'en', 'en-US', 'English', 'English', 'ltr', NULL, 1, 1, 1),
(2, 'uk', 'uk-UA', 'Ukrainian', 'Українська', 'ltr', 1, 1, NULL, 2),
(3, 'de', 'de-DE', 'German', 'Deutsch', 'ltr', 1, 1, NULL, 3),
(4, 'fr', 'fr-FR', 'French', 'Français', 'ltr', 1, 1, NULL, 4),
(5, 'es', 'es-ES', 'Spanish', 'Español', 'ltr', 1, 1, NULL, 5),
(6, 'it', 'it-IT', 'Italian', 'Italiano', 'ltr', 1, 1, NULL, 6),
(7, 'pt', 'pt-BR', 'Portuguese (Brazil)', 'Português (Brasil)', 'ltr', 1, 1, NULL, 7),
(8, 'nl', 'nl-NL', 'Dutch', 'Nederlands', 'ltr', 1, 1, NULL, 8),
(9, 'pl', 'pl-PL', 'Polish', 'Polski', 'ltr', 1, 1, NULL, 9),
(10, 'zh', 'zh-CN', 'Chinese (Simplified)', '简体中文', 'ltr', 1, 1, NULL, 10),
(11, 'ja', 'ja-JP', 'Japanese', '日本語', 'ltr', 1, 1, NULL, 11),
(12, 'ko', 'ko-KR', 'Korean', '한국어', 'ltr', 1, 1, NULL, 12);

-- Дані: prefix_leads_activity_outcomes (0 рядків, режим insert-ignore)

-- Дані: prefix_leads_activity_outcomes_lang (0 рядків, режим insert-ignore)

-- Дані: prefix_leads_loss_reasons (0 рядків, режим insert-ignore)

-- Дані: prefix_leads_loss_reasons_lang (0 рядків, режим insert-ignore)

-- Дані: prefix_leads_pipeline_stages (5 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_leads_pipeline_stages` (`id`, `id_pipeline`, `color`, `icon`, `system_type`, `probability`, `sla_hours`, `required_fields`, `auto_actions`, `lock_back`, `is_active`, `sort`, `date_add`, `date_edit`) VALUES
(1, 1, '#0d6efd', '', 'regular', 10, 24, NULL, NULL, 0, 1, 1, NOW(), NOW()),
(2, 1, '#6f42c1', '', 'regular', 30, 48, NULL, NULL, 0, 1, 2, NOW(), NOW()),
(3, 1, '#fd7e14', '', 'regular', 60, 72, NULL, NULL, 0, 1, 3, NOW(), NOW()),
(4, 1, '#20c997', '', 'won', 100, 0, NULL, NULL, 0, 1, 4, NOW(), NOW()),
(5, 1, '#dc3545', '', 'lost', 0, 0, NULL, NULL, 0, 1, 5, NOW(), NOW());

-- Дані: prefix_leads_pipeline_stages_lang (10 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_leads_pipeline_stages_lang` (`id`, `id_stage`, `id_lang`, `name`) VALUES
(1, 1, 1, 'New'),
(2, 1, 2, 'Новий'),
(3, 2, 1, 'Contacted'),
(4, 2, 2, 'Contacted'),
(5, 3, 1, 'Negotiation'),
(6, 3, 2, 'Переговори'),
(7, 4, 1, 'Won'),
(8, 4, 2, 'Виграно'),
(9, 5, 1, 'Lost'),
(10, 5, 2, 'Програно');

-- Дані: prefix_leads_pipelines (1 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_leads_pipelines` (`id`, `is_active`, `is_default`, `sort`, `date_add`, `date_edit`) VALUES
(1, 1, 1, 1, NOW(), NOW());

-- Дані: prefix_leads_pipelines_lang (2 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_leads_pipelines_lang` (`id`, `id_pipeline`, `id_lang`, `name`) VALUES
(1, 1, 1, 'Sales'),
(2, 1, 2, 'Продажі');

-- Дані: prefix_leads_priorities (4 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_leads_priorities` (`id`, `color_text`, `color_background`, `icon`, `sort`, `is_active`, `date_add`, `date_edit`) VALUES
(1, '#ffffff', '#6c757d', '', 1, 1, NOW(), NOW()),
(2, '#ffffff', '#0d6efd', '', 2, 1, NOW(), NOW()),
(3, '#000000', '#ffc107', '', 3, 1, NOW(), NOW()),
(4, '#ffffff', '#dc3545', '', 4, 1, NOW(), NOW());

-- Дані: prefix_leads_priorities_lang (8 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_leads_priorities_lang` (`id`, `id_priority`, `id_lang`, `name`) VALUES
(1, 1, 1, 'Low'),
(2, 1, 2, 'Низький'),
(3, 2, 1, 'Normal'),
(4, 2, 2, 'Нормальний'),
(5, 3, 1, 'High'),
(6, 3, 2, 'Високий'),
(7, 4, 1, 'Urgent'),
(8, 4, 2, 'Терміновий');

-- Дані: prefix_leads_qualifications (4 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_leads_qualifications` (`id`, `slug`, `color_text`, `color_background`, `icon`, `sort`, `is_active`, `date_add`, `date_edit`) VALUES
(1, 'unqualified', '#ffffff', '#6c757d', '', 1, 1, NOW(), NOW()),
(2, 'mql', '#ffffff', '#0d6efd', 'fa-solid fa-user', 2, 1, NOW(), NOW()),
(3, 'sql', '#ffffff', '#198754', 'fa-solid fa-star', 3, 1, NOW(), NOW()),
(4, 'pql', '#ffffff', '#20c997', 'fa-solid fa-trophy', 4, 1, NOW(), NOW());

-- Дані: prefix_leads_qualifications_lang (8 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_leads_qualifications_lang` (`id`, `id_qualification`, `id_lang`, `name`, `description`) VALUES
(1, 1, 1, 'Unqualified', 'Lead has not been qualified yet'),
(2, 1, 2, 'Некваліфікований', 'Лід ще не кваліфіковано'),
(3, 2, 1, 'MQL', 'Marketing Qualified Lead'),
(4, 2, 2, 'MQL', 'Кваліфікований маркетингом'),
(5, 3, 1, 'SQL', 'Sales Qualified Lead'),
(6, 3, 2, 'SQL', 'Кваліфікований продажами'),
(7, 4, 1, 'PQL', 'Product Qualified Lead'),
(8, 4, 2, 'PQL', 'Кваліфікований продуктом');

-- Дані: prefix_leads_settings_status (5 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_leads_settings_status` (`id`, `color_text`, `color_background`, `icon`, `note`, `system_type`, `is_active`, `is_default`, `sort`, `date_add`, `date_edit`) VALUES
(1, '#ffffff', '#198754', 'fa-solid fa-star', '', 'new', 1, 1, 10, NOW(), NOW()),
(2, '#ffffff', '#0d6efd', '', '', 'in_progress', 1, 0, 20, NOW(), NOW()),
(3, '#ffffff', '#ffc107', '', '', 'postponed', 1, 0, 30, NOW(), NOW()),
(4, '#ffffff', '#20c997', '', '', 'won', 1, 0, 40, NOW(), NOW()),
(5, '#ffffff', '#dc3545', '', '', 'lost', 1, 0, 50, NOW(), NOW());

-- Дані: prefix_leads_settings_status_lang (10 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_leads_settings_status_lang` (`id`, `id_status`, `id_lang`, `name`) VALUES
(1, 1, 1, 'New'),
(2, 1, 2, 'Новий'),
(3, 2, 1, 'In progress'),
(4, 2, 2, 'В обробці'),
(5, 3, 1, 'Postponed'),
(6, 3, 2, 'Відкладено'),
(7, 4, 1, 'Won'),
(8, 4, 2, 'Виграно'),
(9, 5, 1, 'Lost'),
(10, 5, 2, 'Програно');

-- Дані: prefix_leads_sources (5 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_leads_sources` (`id`, `is_active`, `sort`, `date_add`, `date_edit`) VALUES
(1, 1, 1, NOW(), NOW()),
(2, 1, 2, NOW(), NOW()),
(3, 1, 3, NOW(), NOW()),
(4, 1, 4, NOW(), NOW()),
(5, 1, 5, NOW(), NOW());

-- Дані: prefix_leads_sources_lang (10 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_leads_sources_lang` (`id`, `id_source`, `id_lang`, `name`) VALUES
(1, 1, 1, 'Website'),
(2, 1, 2, 'Сайт'),
(3, 2, 1, 'Google Ads'),
(4, 2, 2, 'Google Ads'),
(5, 3, 1, 'Facebook'),
(6, 3, 2, 'Facebook'),
(7, 4, 1, 'Referral'),
(8, 4, 2, 'Реферал'),
(9, 5, 1, 'Manual'),
(10, 5, 2, 'Вручну');

-- Дані: prefix_leads_temperatures (3 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_leads_temperatures` (`id`, `slug`, `color_text`, `color_background`, `icon`, `sort`, `is_active`, `date_add`, `date_edit`) VALUES
(1, 'cold', '#0dcaf0', '#e7f8fd', 'fa-solid fa-snowflake', 1, 1, NOW(), NOW()),
(2, 'warm', '#000000', '#fff3cd', 'fa-solid fa-sun', 2, 1, NOW(), NOW()),
(3, 'hot', '#ffffff', '#dc3545', 'fa-solid fa-fire', 3, 1, NOW(), NOW());

-- Дані: prefix_leads_temperatures_lang (6 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_leads_temperatures_lang` (`id`, `id_temperature`, `id_lang`, `name`) VALUES
(1, 1, 1, 'Cold'),
(2, 1, 2, 'Холодний'),
(3, 2, 1, 'Warm'),
(4, 2, 2, 'Теплий'),
(5, 3, 1, 'Hot'),
(6, 3, 2, 'Гарячий');

-- Дані: prefix_orders_currency (3 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_orders_currency` (`id`, `name`, `symbol`, `currency_iso_code`, `rate`, `is_base`, `date_edit`) VALUES
(1, 'Ukrainian Hryvnia', '₴', 'UAH', '0.0240964000', 0, NOW()),
(4, 'US Dollar', '$', 'USD', '1.0000000000', 1, NOW()),
(5, 'Euro', '€', 'EUR', '1.1000000000', 0, NOW());

-- Дані: prefix_orders_delivery (1 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_orders_delivery` (`id`, `color_text`, `color_background`, `date_add`, `date_edit`, `icon`) VALUES
(1, '', '', NOW(), NOW(), '');

-- Дані: prefix_orders_delivery_lang (2 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_orders_delivery_lang` (`id`, `id_delivery`, `id_lang`, `title`, `text`) VALUES
(3, 1, 1, 'Not specified', ''),
(4, 1, 2, 'Не вказано', '');

-- Дані: prefix_orders_payment (1 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_orders_payment` (`id`, `code`, `color_text`, `color_background`, `icon`, `is_online`, `is_prepaid`, `is_cod`, `is_system`, `id_status_default`, `active`, `sort_order`, `date_add`, `date_edit`) VALUES
(1, '', '#ffffff', '#6c757d', '', 0, 0, 0, 0, NULL, 1, 0, NOW(), NOW());

-- Дані: prefix_orders_payment_lang (2 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_orders_payment_lang` (`id`, `id_payment`, `id_lang`, `text`) VALUES
(11, 1, 1, 'Not specified'),
(12, 1, 2, 'Не вказано');

-- Дані: prefix_orders_status (19 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_orders_status` (`id`, `color_text`, `color_background`, `icon`, `date_add`, `date_edit`, `logable`, `count_in_revenue`, `is_final`, `is_negative`, `invoice`, `hidden`, `send_email`, `pdf_invoice`, `pdf_delivery`, `shipped`, `paid`, `delivery`, `id_template`) VALUES
(1, '#ffffff', '#f39c12', 'fa-solid fa-hourglass-half', NOW(), NOW(), 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, NULL),
(2, '#ffffff', '#2fb25c', 'fa-solid fa-circle-check', NOW(), NOW(), 1, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, NULL),
(3, '#ffffff', '#e74c3c', 'fa-solid fa-triangle-exclamation', NOW(), NOW(), 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, NULL),
(4, '#ffffff', '#3498db', 'fa-solid fa-clipboard-check', NOW(), NOW(), 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, NULL),
(5, '#ffffff', '#5dade2', 'fa-solid fa-list-check', NOW(), NOW(), 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, NULL),
(6, '#ffffff', '#8e44ad', 'fa-solid fa-truck-fast', NOW(), NOW(), 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1, NULL),
(7, '#ffffff', '#27ae60', 'fa-solid fa-box', NOW(), NOW(), 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, NULL),
(8, '#ffffff', '#16a085', 'fa-solid fa-check', NOW(), NOW(), 1, 1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, NULL),
(9, '#ffffff', '#c0392b', 'fa-solid fa-circle-xmark', NOW(), NOW(), 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, NULL),
(10, '#ffffff', '#ec7063', 'fa-solid fa-hand-holding-dollar', NOW(), NOW(), 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, NULL),
(11, '#ffffff', '#d35400', 'fa-solid fa-arrow-rotate-left', NOW(), NOW(), 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, NULL),
(12, '#333333', '#f1c40f', 'fa-solid fa-boxes-stacked', NOW(), NOW(), 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, NULL),
(13, '#ffffff', '#e67e22', 'fa-solid fa-money-bill', NOW(), NOW(), 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, NULL),
(14, '#ffffff', '#af7ac5', 'fa-solid fa-wallet', NOW(), NOW(), 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, NULL),
(15, '#ffffff', '#7f8c8d', 'fa-solid fa-rotate-left', NOW(), NOW(), 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, NULL),
(16, '#ffffff', '#95a5a6', 'fa-solid fa-ban', NOW(), NOW(), 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, NULL),
(17, '#ffffff', '#34495e', 'fa-solid fa-clock', NOW(), NOW(), 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, NULL),
(18, '#ffffff', '#922b21', 'fa-solid fa-shield-halved', NOW(), NOW(), 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, NULL),
(19, '#ffffff', '#1abc9c', 'fa-solid fa-bolt', NOW(), NOW(), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL);

-- Дані: prefix_orders_status_lang (228 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_orders_status_lang` (`id`, `id_status`, `id_lang`, `text`) VALUES
(1, 1, 1, 'Awaiting payment'),
(2, 1, 2, 'Очікування оплати'),
(3, 1, 3, 'Warten auf Zahlung'),
(4, 1, 4, 'En attente de paiement'),
(5, 1, 5, 'Pendiente de pago'),
(6, 1, 6, 'In attesa di pagamento'),
(7, 1, 7, 'Aguardando pagamento'),
(8, 1, 8, 'Wacht op betaling'),
(9, 1, 9, 'Oczekiwanie na płatność'),
(10, 1, 10, '等待付款'),
(11, 1, 11, '支払い待ち'),
(12, 1, 12, '결제 대기 중'),
(13, 2, 1, 'Payment accepted'),
(14, 2, 2, 'Оплата прийнята'),
(15, 2, 3, 'Zahlung akzeptiert'),
(16, 2, 4, 'Paiement accepté'),
(17, 2, 5, 'Pago aceptado'),
(18, 2, 6, 'Pagamento accettato'),
(19, 2, 7, 'Pagamento aceito'),
(20, 2, 8, 'Betaling geaccepteerd'),
(21, 2, 9, 'Płatność zaakceptowana'),
(22, 2, 10, '付款已接受'),
(23, 2, 11, '支払い受付済み'),
(24, 2, 12, '결제 승인됨'),
(25, 3, 1, 'Payment error'),
(26, 3, 2, 'Помилка оплати'),
(27, 3, 3, 'Zahlungsfehler'),
(28, 3, 4, 'Erreur de paiement'),
(29, 3, 5, 'Error de pago'),
(30, 3, 6, 'Errore di pagamento'),
(31, 3, 7, 'Erro de pagamento'),
(32, 3, 8, 'Betalingsfout'),
(33, 3, 9, 'Błąd płatności'),
(34, 3, 10, '付款错误'),
(35, 3, 11, '支払いエラー'),
(36, 3, 12, '결제 오류'),
(37, 4, 1, 'Processing'),
(38, 4, 2, 'Обробляється'),
(39, 4, 3, 'In Bearbeitung'),
(40, 4, 4, 'En traitement'),
(41, 4, 5, 'Procesando'),
(42, 4, 6, 'In elaborazione'),
(43, 4, 7, 'Processando'),
(44, 4, 8, 'In verwerking'),
(45, 4, 9, 'W trakcie realizacji'),
(46, 4, 10, '处理中'),
(47, 4, 11, '処理中'),
(48, 4, 12, '처리 중'),
(49, 5, 1, 'Preparing'),
(50, 5, 2, 'Комплектується'),
(51, 5, 3, 'Wird vorbereitet'),
(52, 5, 4, 'En préparation'),
(53, 5, 5, 'Preparando'),
(54, 5, 6, 'In preparazione'),
(55, 5, 7, 'Preparando'),
(56, 5, 8, 'Wordt voorbereid'),
(57, 5, 9, 'Przygotowywanie'),
(58, 5, 10, '准备中'),
(59, 5, 11, '準備中'),
(60, 5, 12, '준비 중'),
(61, 6, 1, 'Shipped'),
(62, 6, 2, 'Відправлено'),
(63, 6, 3, 'Versandt'),
(64, 6, 4, 'Expédié'),
(65, 6, 5, 'Enviado'),
(66, 6, 6, 'Spedito'),
(67, 6, 7, 'Enviado'),
(68, 6, 8, 'Verzonden'),
(69, 6, 9, 'Wysłano'),
(70, 6, 10, '已发货'),
(71, 6, 11, '発送済み'),
(72, 6, 12, '배송됨'),
(73, 7, 1, 'Delivered'),
(74, 7, 2, 'Доставлено'),
(75, 7, 3, 'Zugestellt'),
(76, 7, 4, 'Livré'),
(77, 7, 5, 'Entregado'),
(78, 7, 6, 'Consegnato'),
(79, 7, 7, 'Entregue'),
(80, 7, 8, 'Bezorgd'),
(81, 7, 9, 'Dostarczono'),
(82, 7, 10, '已送达'),
(83, 7, 11, '配達済み'),
(84, 7, 12, '배달됨'),
(85, 8, 1, 'Completed'),
(86, 8, 2, 'Виконано'),
(87, 8, 3, 'Abgeschlossen'),
(88, 8, 4, 'Terminé'),
(89, 8, 5, 'Completado'),
(90, 8, 6, 'Completato'),
(91, 8, 7, 'Concluído'),
(92, 8, 8, 'Voltooid'),
(93, 8, 9, 'Zakończono'),
(94, 8, 10, '已完成'),
(95, 8, 11, '完了'),
(96, 8, 12, '완료됨'),
(97, 9, 1, 'Canceled'),
(98, 9, 2, 'Скасовано'),
(99, 9, 3, 'Storniert'),
(100, 9, 4, 'Annulé'),
(101, 9, 5, 'Cancelado'),
(102, 9, 6, 'Annullato'),
(103, 9, 7, 'Cancelado'),
(104, 9, 8, 'Geannuleerd'),
(105, 9, 9, 'Anulowano'),
(106, 9, 10, '已取消'),
(107, 9, 11, 'キャンセル済み'),
(108, 9, 12, '취소됨'),
(109, 10, 1, 'Refunded'),
(110, 10, 2, 'Кошти повернено'),
(111, 10, 3, 'Erstattet'),
(112, 10, 4, 'Remboursé'),
(113, 10, 5, 'Reembolsado'),
(114, 10, 6, 'Rimborsato'),
(115, 10, 7, 'Reembolsado'),
(116, 10, 8, 'Terugbetaald'),
(117, 10, 9, 'Zwrócono środki'),
(118, 10, 10, '已退款'),
(119, 10, 11, '返金済み'),
(120, 10, 12, '환불됨'),
(121, 11, 1, 'Returned'),
(122, 11, 2, 'Повернення товару'),
(123, 11, 3, 'Zurückgesendet'),
(124, 11, 4, 'Retourné'),
(125, 11, 5, 'Devuelto'),
(126, 11, 6, 'Restituito'),
(127, 11, 7, 'Devolvido'),
(128, 11, 8, 'Geretourneerd'),
(129, 11, 9, 'Zwrócono'),
(130, 11, 10, '已退货'),
(131, 11, 11, '返品済み'),
(132, 11, 12, '반품됨'),
(133, 12, 1, 'On backorder'),
(134, 12, 2, 'Очікування товару'),
(135, 12, 3, 'Nachbestellt'),
(136, 12, 4, 'En réapprovisionnement'),
(137, 12, 5, 'En espera de stock'),
(138, 12, 6, 'In riordino'),
(139, 12, 7, 'Em falta (reposição)'),
(140, 12, 8, 'In backorder'),
(141, 12, 9, 'Oczekuje na dostawę'),
(142, 12, 10, '等待补货'),
(143, 12, 11, '入荷待ち'),
(144, 12, 12, '재입고 대기 중'),
(145, 13, 1, 'Awaiting bank wire payment'),
(146, 13, 2, 'Очікування банківського переказу'),
(147, 13, 3, 'Warten auf Banküberweisung'),
(148, 13, 4, 'En attente de virement bancaire'),
(149, 13, 5, 'Pendiente de transferencia bancaria'),
(150, 13, 6, 'In attesa di bonifico bancario'),
(151, 13, 7, 'Aguardando transferência bancária'),
(152, 13, 8, 'Wacht op bankoverschrijving'),
(153, 13, 9, 'Oczekiwanie na przelew bankowy'),
(154, 13, 10, '等待银行转账'),
(155, 13, 11, '銀行振込待ち'),
(156, 13, 12, '은행 송금 대기 중'),
(157, 14, 1, 'Awaiting cash on delivery'),
(158, 14, 2, 'Очікування накладеного платежу'),
(159, 14, 3, 'Warten auf Nachnahme'),
(160, 14, 4, 'En attente de paiement à la livraison'),
(161, 14, 5, 'Pendiente de pago contra reembolso'),
(162, 14, 6, 'In attesa di pagamento alla consegna'),
(163, 14, 7, 'Aguardando pagamento na entrega'),
(164, 14, 8, 'Wacht op betaling bij levering'),
(165, 14, 9, 'Oczekiwanie na płatność za pobraniem'),
(166, 14, 10, '等待货到付款'),
(167, 14, 11, '代金引換待ち'),
(168, 14, 12, '착불 결제 대기 중'),
(169, 15, 1, 'Chargeback'),
(170, 15, 2, 'Зворотний платіж'),
(171, 15, 3, 'Rückbuchung'),
(172, 15, 4, 'Rétrofacturation'),
(173, 15, 5, 'Contracargo'),
(174, 15, 6, 'Storno (chargeback)'),
(175, 15, 7, 'Estorno (chargeback)'),
(176, 15, 8, 'Terugboeking'),
(177, 15, 9, 'Obciążenie zwrotne'),
(178, 15, 10, '拒付'),
(179, 15, 11, 'チャージバック'),
(180, 15, 12, '지불 거절'),
(181, 16, 1, 'Failed'),
(182, 16, 2, 'Невдале'),
(183, 16, 3, 'Fehlgeschlagen'),
(184, 16, 4, 'Échoué'),
(185, 16, 5, 'Fallido'),
(186, 16, 6, 'Non riuscito'),
(187, 16, 7, 'Falhou'),
(188, 16, 8, 'Mislukt'),
(189, 16, 9, 'Niepowodzenie'),
(190, 16, 10, '失败'),
(191, 16, 11, '失敗'),
(192, 16, 12, '실패'),
(193, 17, 1, 'On hold'),
(194, 17, 2, 'Призупинено'),
(195, 17, 3, 'Angehalten'),
(196, 17, 4, 'En attente'),
(197, 17, 5, 'En espera'),
(198, 17, 6, 'In sospeso'),
(199, 17, 7, 'Em espera'),
(200, 17, 8, 'In de wacht');
INSERT IGNORE INTO `prefix_orders_status_lang` (`id`, `id_status`, `id_lang`, `text`) VALUES
(201, 17, 9, 'Wstrzymane'),
(202, 17, 10, '暂停'),
(203, 17, 11, '保留中'),
(204, 17, 12, '보류 중'),
(205, 18, 1, 'Suspected fraud'),
(206, 18, 2, 'Підозра шахрайства'),
(207, 18, 3, 'Verdacht auf Betrug'),
(208, 18, 4, 'Soupçon de fraude'),
(209, 18, 5, 'Sospecha de fraude'),
(210, 18, 6, 'Sospetta frode'),
(211, 18, 7, 'Suspeita de fraude'),
(212, 18, 8, 'Vermoeden van fraude'),
(213, 18, 9, 'Podejrzenie oszustwa'),
(214, 18, 10, '疑似欺诈'),
(215, 18, 11, '不正の疑い'),
(216, 18, 12, '사기 의심'),
(217, 19, 1, 'New (quick order)'),
(218, 19, 2, 'Нове (швидке замовлення)'),
(219, 19, 3, 'Neu (Schnellbestellung)'),
(220, 19, 4, 'Nouveau (commande rapide)'),
(221, 19, 5, 'Nuevo (pedido rápido)'),
(222, 19, 6, 'Nuovo (ordine rapido)'),
(223, 19, 7, 'Novo (pedido rápido)'),
(224, 19, 8, 'Nieuw (snelle bestelling)'),
(225, 19, 9, 'Nowe (szybkie zamówienie)'),
(226, 19, 10, '新订单（快速订单）'),
(227, 19, 11, '新規（クイック注文）'),
(228, 19, 12, '신규 (빠른 주문)');

-- Дані: prefix_products_attribute_groups (3 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_products_attribute_groups` (`id`, `code`, `sort_order`) VALUES
(9001, 'demo_main', 1),
(9002, 'demo_tech', 2),
(9003, 'demo_clothing', 3);

-- Дані: prefix_products_attribute_groups_description (6 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_products_attribute_groups_description` (`id_attribute_group`, `id_lang`, `name`) VALUES
(9001, 1, 'General'),
(9001, 2, 'Основні'),
(9002, 1, 'Technical'),
(9002, 2, 'Технічні'),
(9003, 1, 'Clothing'),
(9003, 2, 'Одяг');

-- Дані: prefix_products_customer_groups (2 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_products_customer_groups` (`id`, `code`, `name`, `discount_percent`, `price_display`, `min_order_amount`, `requires_approval`, `is_default`, `status`, `sort_order`, `date_add`, `date_upd`) VALUES
(1, 'retail', 'Роздріб', '0.00', 'tax_incl', NULL, 0, 1, 1, 0, NOW(), NOW()),
(2, 'wholesale', 'Опт', '0.00', 'tax_incl', NULL, 0, 0, 1, 1, NOW(), NOW());

-- Дані: prefix_products_customer_groups_description (0 рядків, режим insert-ignore)

-- Дані: prefix_products_settings (12 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_products_settings` (`setting_key`, `value`, `id_user_edit`, `date_edit`) VALUES
('card', '{\"per_page\":50,\"default_status\":\"draft\",\"required_fields\":[\"name\"],\"id_default_attribute_set\":null}', NULL, NOW()),
('currencies', '{\"log\":[{\"at\":\"2026-11-26T14:07:00.436Z\",\"code\":\"USD\",\"held\":false,\"prev\":45.272,\"rate\":45.1064,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-26T14:07:00.436Z\",\"code\":\"EUR\",\"held\":false,\"prev\":49.5346,\"rate\":49.4942,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-25T14:07:00.268Z\",\"code\":\"USD\",\"held\":false,\"prev\":45.3541,\"rate\":45.272,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-25T14:07:00.268Z\",\"code\":\"EUR\",\"held\":false,\"prev\":49.606,\"rate\":49.5346,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-24T14:07:00.143Z\",\"code\":\"USD\",\"held\":false,\"prev\":45.0811,\"rate\":45.3541,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-24T14:07:00.143Z\",\"code\":\"EUR\",\"held\":false,\"prev\":49.455,\"rate\":49.606,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-23T14:07:00.600Z\",\"code\":\"USD\",\"held\":false,\"prev\":44.9293,\"rate\":45.0811,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-23T14:07:00.600Z\",\"code\":\"EUR\",\"held\":false,\"prev\":49.2763,\"rate\":49.455,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-20T14:07:00.238Z\",\"code\":\"USD\",\"held\":false,\"prev\":45.0532,\"rate\":44.9293,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-20T14:07:00.238Z\",\"code\":\"EUR\",\"held\":false,\"prev\":49.5335,\"rate\":49.2763,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-19T14:07:00.314Z\",\"code\":\"USD\",\"held\":false,\"prev\":45.202,\"rate\":45.0532,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-19T14:07:00.314Z\",\"code\":\"EUR\",\"held\":false,\"prev\":49.5717,\"rate\":49.5335,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-18T14:07:00.125Z\",\"code\":\"USD\",\"held\":false,\"prev\":45.3436,\"rate\":45.202,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-18T14:07:00.125Z\",\"code\":\"EUR\",\"held\":false,\"prev\":49.8561,\"rate\":49.5717,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-17T14:07:00.106Z\",\"code\":\"USD\",\"held\":false,\"prev\":45.3918,\"rate\":45.3436,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-17T14:07:00.106Z\",\"code\":\"EUR\",\"held\":false,\"prev\":49.9881,\"rate\":49.8561,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-16T14:07:00.380Z\",\"code\":\"USD\",\"held\":false,\"prev\":45.4274,\"rate\":45.3918,\"user\":null,\"source\":\"nbu\"},{\"at\":\"2026-11-16T14:07:00.380Z\",\"code\":\"EUR\",\"held\":false,\"prev\":50.222,\"rate\":49.9881,\"user\":null,\"source\":\"nbu\"}],\"list\":[{\"code\":\"USD\",\"name\":\"Долар США\",\"rate\":45.1064,\"step\":1,\"apply\":\"auto\",\"minus\":0,\"round\":\"none\",\"units\":1,\"active\":true,\"symbol\":\"$\",\"only_up\":false,\"pending\":false,\"decimals\":2,\"fallback\":\"\",\"max_jump\":0,\"provider\":\"nbu\",\"threshold\":0,\"applied_at\":\"2026-11-26T14:07:02.469Z\",\"correction\":0,\"symbol_pos\":\"after\",\"updated_at\":\"2026-11-26T14:07:00.436Z\",\"stale_hours\":0,\"applied_rate\":45.1064,\"suggested_at\":null,\"suggested_rate\":null,\"suggested_source\":null},{\"code\":\"EUR\",\"name\":\"Євро\",\"rate\":49.4942,\"step\":1,\"apply\":\"auto\",\"minus\":0,\"round\":\"none\",\"units\":1,\"active\":true,\"symbol\":\"€\",\"only_up\":false,\"pending\":false,\"decimals\":2,\"fallback\":\"\",\"max_jump\":0,\"provider\":\"nbu\",\"threshold\":0,\"applied_at\":\"2026-11-26T14:07:02.469Z\",\"correction\":0,\"symbol_pos\":\"after\",\"updated_at\":\"2026-11-26T14:07:00.436Z\",\"stale_hours\":0,\"applied_rate\":49.4942,\"suggested_at\":null,\"suggested_rate\":null,\"suggested_source\":null}],\"base_format\":{\"symbol\":\"\",\"decimals\":2,\"symbol_pos\":\"after\"}}', NULL, NOW()),
('ean', '{\"auto\":false,\"internal_prefix\":\"200\"}', NULL, NOW()),
('edit_lock', '{\"ttl_seconds\":60,\"heartbeat_seconds\":20}', NULL, NOW()),
('images', '{\"format\":\"webp\",\"quality\":82,\"max_width\":2400,\"watermark\":{\"file\":null,\"enabled\":false,\"opacity\":0.5,\"position\":\"southeast\"},\"max_height\":2400,\"thumbnails\":[{\"fit\":\"contain\",\"code\":\"small\",\"width\":150,\"height\":150},{\"fit\":\"contain\",\"code\":\"medium\",\"width\":500,\"height\":500},{\"fit\":\"inside\",\"code\":\"large\",\"width\":1200,\"height\":1200}],\"max_file_mb\":20,\"allowed_mime\":[\"image/jpeg\",\"image/png\",\"image/webp\",\"image/avif\",\"image/gif\"],\"keep_original\":false,\"strip_metadata\":true}', NULL, NOW()),
('prices', '{\"rounding\":2,\"base_currency\":\"UAH\",\"show_compare_at\":true,\"prices_include_tax\":true}', NULL, NOW()),
('publishing', '{\"enabled\":true,\"live_price\":true,\"live_status\":true}', NULL, NOW()),
('rewards', '{\"enabled\":false,\"auto_mode\":\"none\",\"point_value\":1,\"auto_percent\":0,\"accrue_on_status\":null}', NULL, NOW()),
('sku', '{\"auto\":false,\"prefix\":\"GC\",\"pattern\":\"{PREFIX}-{SEQ:6}\",\"variant_pattern\":\"{PARENT}-{AXES}\",\"regenerate_on_change\":false}', NULL, NOW()),
('slug', '{\"auto\":true,\"max_length\":120,\"transliteration\":\"uk\"}', NULL, NOW()),
('stock', '{\"reserve_on\":\"order_create\",\"track_batches\":false,\"track_serials\":false,\"allow_negative\":false,\"multi_warehouse\":true,\"write_off_strategy\":\"priority\",\"id_default_warehouse\":1,\"reservation_ttl_minutes\":60,\"default_out_of_stock_action\":\"deny\"}', NULL, NOW()),
('units', '{\"length\":\"cm\",\"weight\":\"kg\"}', NULL, NOW());

-- Дані: prefix_products_stock_statuses (6 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_products_stock_statuses` (`id`, `code`, `color`, `sort_order`) VALUES
(1, 'in_stock', NULL, 1),
(2, 'out_of_stock', NULL, 2),
(3, 'preorder', NULL, 3),
(4, 'on_request', NULL, 4),
(5, '2_3_days', NULL, 5),
(9001, 'demo_14_days', '#fd7e14', 9);

-- Дані: prefix_products_stock_statuses_description (12 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_products_stock_statuses_description` (`id_stock_status`, `id_lang`, `name`) VALUES
(1, 1, 'In stock'),
(1, 2, 'В наявності'),
(2, 1, 'Out of stock'),
(2, 2, 'Немає в наявності'),
(3, 1, 'Pre-order'),
(3, 2, 'Передзамовлення'),
(4, 1, 'On request'),
(4, 2, 'Під замовлення'),
(5, 1, '2–3 days'),
(5, 2, '2–3 дні'),
(9001, 1, 'Delivery in 14 days'),
(9001, 2, 'Доставка 14 днів');

-- Дані: prefix_products_tax_classes (3 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_products_tax_classes` (`id`, `code`, `rate`, `is_default`, `status`, `sort_order`) VALUES
(9001, 'DEMO_VAT20', '20.0000', 0, 1, 1),
(9002, 'DEMO_VAT7', '7.0000', 0, 1, 2),
(9003, 'DEMO_VAT0', '0.0000', 0, 0, 3);

-- Дані: prefix_products_tax_classes_description (6 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_products_tax_classes_description` (`id_tax_class`, `id_lang`, `name`) VALUES
(9001, 1, 'VAT 20%'),
(9001, 2, 'ПДВ 20%'),
(9002, 1, 'VAT 7%'),
(9002, 2, 'ПДВ 7%'),
(9003, 1, 'No VAT'),
(9003, 2, 'Без ПДВ');

-- Дані: prefix_users_groups (2 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_users_groups` (`id`, `active`, `id_created_by`, `date_add`, `date_edit`) VALUES
(1, 1, NULL, NOW(), NOW()),
(2, 1, NULL, NOW(), NOW());

-- Дані: prefix_users_groups_lang (24 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_users_groups_lang` (`id`, `id_group`, `id_lang`, `name`, `note`) VALUES
(1, 1, 1, 'Administrator', 'Full access to all sections and settings'),
(2, 1, 2, 'Адміністратор', 'Повний доступ до всіх розділів і налаштувань'),
(3, 1, 3, 'Administrator', 'Vollzugriff auf alle Bereiche und Einstellungen'),
(4, 1, 4, 'Administrateur', 'Accès complet à toutes les sections et paramètres'),
(5, 1, 5, 'Administrador', 'Acceso completo a todas las secciones y ajustes'),
(6, 1, 6, 'Amministratore', 'Accesso completo a tutte le sezioni e impostazioni'),
(7, 1, 7, 'Administrador', 'Acesso total a todas as seções e configurações'),
(8, 1, 8, 'Beheerder', 'Volledige toegang tot alle secties en instellingen'),
(9, 1, 9, 'Administrator', 'Pełny dostęp do wszystkich sekcji i ustawień'),
(10, 1, 10, '管理员', '可完全访问所有版块和设置'),
(11, 1, 11, '管理者', 'すべてのセクションと設定への完全アクセス'),
(12, 1, 12, '관리자', '모든 섹션 및 설정에 대한 전체 액세스'),
(13, 2, 1, 'Manager', 'Access to clients, orders and catalog'),
(14, 2, 2, 'Менеджер', 'Доступ до клієнтів, замовлень і каталогу'),
(15, 2, 3, 'Manager', 'Zugriff auf Kunden, Bestellungen und Katalog'),
(16, 2, 4, 'Gestionnaire', 'Accès aux clients, commandes et catalogue'),
(17, 2, 5, 'Gestor', 'Acceso a clientes, pedidos y catálogo'),
(18, 2, 6, 'Manager', 'Accesso a clienti, ordini e catalogo'),
(19, 2, 7, 'Gerente', 'Acesso a clientes, pedidos e catálogo'),
(20, 2, 8, 'Beheerder', 'Toegang tot klanten, bestellingen en catalogus'),
(21, 2, 9, 'Menedżer', 'Dostęp do klientów, zamówień i katalogu'),
(22, 2, 10, '经理', '可访问客户、订单和目录'),
(23, 2, 11, 'マネージャー', '顧客、注文、カタログへのアクセス'),
(24, 2, 12, '매니저', '고객, 주문, 카탈로그에 대한 액세스');

-- Дані: prefix_users_permissions_pages (58 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_users_permissions_pages` (`id`, `slug`, `parent_id`, `sort_order`) VALUES
(1, 'users', NULL, 10),
(2, 'settings', NULL, 90),
(10, 'users.list', 1, 10),
(11, 'users.groups', 1, 20),
(12, 'users.invites', 1, 30),
(90, 'settings.general', 2, 10),
(91, 'settings.languages', 2, 20),
(92, 'contact-center', NULL, 50),
(94, 'contact_center.channels', 92, 10),
(95, 'clients', NULL, 900),
(96, 'clients.list', 95, 901),
(97, 'clients.all', 95, 902),
(98, 'clients.merge', 95, 903),
(99, 'clients.export', 95, 904),
(100, 'clients.import', 95, 905),
(101, 'clients.settings', 95, 906),
(102, 'system', NULL, 950),
(103, 'system.audit', 102, 951),
(104, 'system.trash', 102, 952),
(105, 'leads', NULL, 910),
(106, 'leads.list', 105, 911),
(107, 'leads.all', 105, 912),
(108, 'leads.settings', 105, 913),
(109, 'orders', NULL, 920),
(110, 'orders.list', 109, 921),
(111, 'orders.all', 109, 922),
(112, 'orders.abandoned', 109, 923),
(113, 'orders.settings', 109, 924),
(114, 'catalog', NULL, 50),
(115, 'products.list', 114, 1),
(116, 'products.cost', 114, 2),
(117, 'products.categories', 114, 3),
(118, 'products.brands', 114, 4),
(119, 'products.attributes', 114, 5),
(120, 'products.options', 114, 6),
(121, 'products.warehouses', 114, 7),
(122, 'products.suppliers', 114, 8),
(123, 'products.stock', 114, 9),
(124, 'products.settings', 114, 10),
(125, 'products.import', 114, 95),
(126, 'products.sync', 114, 96),
(127, 'settings.modules', NULL, 900),
(128, 'mailing', NULL, 900),
(129, 'mailing.campaigns', 128, 1),
(130, 'mailing.send', 128, 2),
(131, 'mailing.templates', 128, 3),
(132, 'mailing.contacts', 128, 4),
(133, 'mailing.settings', 128, 5),
(136, 'products.currencies', 114, 11),
(137, 'analytics', NULL, 953),
(138, 'reports', NULL, 954),
(139, 'deals.settings', NULL, 955),
(140, 'contact_center.social', 92, 11),
(141, 'contact_center.comments', 92, 11),
(142, 'company.structure', NULL, 965),
(143, 'chat', NULL, 975),
(144, 'chat.announcements', 143, 10),
(145, 'chat.analytics', 143, 20);

-- Дані: prefix_users_permissions_pages_lang (696 рядків, режим insert-ignore)
INSERT IGNORE INTO `prefix_users_permissions_pages_lang` (`id`, `id_page`, `id_lang`, `name`) VALUES
(1, 1, 1, 'Users'),
(2, 1, 2, 'Користувачі'),
(3, 1, 3, 'Benutzer'),
(4, 1, 4, 'Utilisateurs'),
(5, 1, 5, 'Usuarios'),
(6, 1, 6, 'Utenti'),
(7, 1, 7, 'Usuários'),
(8, 1, 8, 'Gebruikers'),
(9, 1, 9, 'Użytkownicy'),
(10, 1, 10, '用户'),
(11, 1, 11, 'ユーザー'),
(12, 1, 12, '사용자'),
(13, 2, 1, 'Settings'),
(14, 2, 2, 'Налаштування'),
(15, 2, 3, 'Einstellungen'),
(16, 2, 4, 'Paramètres'),
(17, 2, 5, 'Configuración'),
(18, 2, 6, 'Impostazioni'),
(19, 2, 7, 'Configurações'),
(20, 2, 8, 'Instellingen'),
(21, 2, 9, 'Ustawienia'),
(22, 2, 10, '设置'),
(23, 2, 11, '設定'),
(24, 2, 12, '설정'),
(25, 10, 1, 'User list'),
(26, 10, 2, 'Список користувачів'),
(27, 10, 3, 'Benutzerliste'),
(28, 10, 4, 'Liste des utilisateurs'),
(29, 10, 5, 'Lista de usuarios'),
(30, 10, 6, 'Elenco utenti'),
(31, 10, 7, 'Lista de usuários'),
(32, 10, 8, 'Gebruikerslijst'),
(33, 10, 9, 'Lista użytkowników'),
(34, 10, 10, '用户列表'),
(35, 10, 11, 'ユーザー一覧'),
(36, 10, 12, '사용자 목록'),
(37, 11, 1, 'Groups'),
(38, 11, 2, 'Групи'),
(39, 11, 3, 'Gruppen'),
(40, 11, 4, 'Groupes'),
(41, 11, 5, 'Grupos'),
(42, 11, 6, 'Gruppi'),
(43, 11, 7, 'Grupos'),
(44, 11, 8, 'Groepen'),
(45, 11, 9, 'Grupy'),
(46, 11, 10, '组'),
(47, 11, 11, 'グループ'),
(48, 11, 12, '그룹'),
(49, 12, 1, 'Invites'),
(50, 12, 2, 'Запрошення'),
(51, 12, 3, 'Einladungen'),
(52, 12, 4, 'Invitations'),
(53, 12, 5, 'Invitaciones'),
(54, 12, 6, 'Inviti'),
(55, 12, 7, 'Convites'),
(56, 12, 8, 'Uitnodigingen'),
(57, 12, 9, 'Zaproszenia'),
(58, 12, 10, '邀请'),
(59, 12, 11, '招待'),
(60, 12, 12, '초대'),
(61, 90, 1, 'General'),
(62, 90, 2, 'Загальні'),
(63, 90, 3, 'Allgemein'),
(64, 90, 4, 'Général'),
(65, 90, 5, 'General'),
(66, 90, 6, 'Generale'),
(67, 90, 7, 'Geral'),
(68, 90, 8, 'Algemeen'),
(69, 90, 9, 'Ogólne'),
(70, 90, 10, '常规'),
(71, 90, 11, '一般'),
(72, 90, 12, '일반'),
(73, 91, 1, 'Languages'),
(74, 91, 2, 'Мови'),
(75, 91, 3, 'Sprachen'),
(76, 91, 4, 'Langues'),
(77, 91, 5, 'Idiomas'),
(78, 91, 6, 'Lingue'),
(79, 91, 7, 'Idiomas'),
(80, 91, 8, 'Talen'),
(81, 91, 9, 'Języki'),
(82, 91, 10, '语言'),
(83, 91, 11, '言語'),
(84, 91, 12, '언어'),
(85, 92, 1, 'Contact Center'),
(86, 92, 2, 'Контакт-центр'),
(87, 92, 3, 'Kontaktcenter'),
(88, 92, 4, 'Centre de contact'),
(89, 92, 5, 'Centro de contacto'),
(90, 92, 6, 'Contact center'),
(91, 92, 7, 'Contact Center'),
(92, 92, 8, 'Contactcentrum'),
(93, 92, 9, 'Centrum kontaktu'),
(94, 92, 10, '联络中心'),
(95, 92, 11, 'コンタクトセンター'),
(96, 92, 12, '컨택 센터'),
(97, 94, 1, 'Communication Channels'),
(98, 94, 2, 'Канали комунікації'),
(99, 94, 3, 'Kommunikationskanäle'),
(100, 94, 4, 'Canaux de communication'),
(101, 94, 5, 'Canales de comunicación'),
(102, 94, 6, 'Canali di comunicazione'),
(103, 94, 7, 'Canais de comunicação'),
(104, 94, 8, 'Communicatiekanalen'),
(105, 94, 9, 'Kanały komunikacji'),
(106, 94, 10, '沟通渠道'),
(107, 94, 11, 'コミュニケーションチャネル'),
(108, 94, 12, '커뮤니케이션 채널'),
(109, 95, 1, 'Clients'),
(110, 95, 2, 'Клієнти'),
(111, 95, 3, 'Kunden'),
(112, 95, 4, 'Clients'),
(113, 95, 5, 'Clientes'),
(114, 95, 6, 'Clienti'),
(115, 95, 7, 'Clientes'),
(116, 95, 8, 'Klanten'),
(117, 95, 9, 'Klienci'),
(118, 95, 10, '客户'),
(119, 95, 11, '顧客'),
(120, 95, 12, '고객'),
(121, 96, 1, 'List and cards'),
(122, 96, 2, 'Список і картки'),
(123, 96, 3, 'Liste und Karten'),
(124, 96, 4, 'Liste et fiches'),
(125, 96, 5, 'Lista y tarjetas'),
(126, 96, 6, 'Elenco e schede'),
(127, 96, 7, 'Lista e cartões'),
(128, 96, 8, 'Lijst en kaarten'),
(129, 96, 9, 'Lista i karty'),
(130, 96, 10, '列表和卡片'),
(131, 96, 11, 'リストとカード'),
(132, 96, 12, '목록 및 카드'),
(133, 97, 1, 'All clients (not only own)'),
(134, 97, 2, 'Усі клієнти (не лише свої)'),
(135, 97, 3, 'Alle Kunden (nicht nur eigene)'),
(136, 97, 4, 'Tous les clients (pas seulement les siens)'),
(137, 97, 5, 'Todos los clientes (no solo los propios)'),
(138, 97, 6, 'Tutti i clienti (non solo i propri)'),
(139, 97, 7, 'Todos os clientes (não apenas os próprios)'),
(140, 97, 8, 'Alle klanten (niet alleen eigen)'),
(141, 97, 9, 'Wszyscy klienci (nie tylko własni)'),
(142, 97, 10, '所有客户（不仅是自己的）'),
(143, 97, 11, 'すべての顧客（自分のみに限らない）'),
(144, 97, 12, '모든 고객(본인 것만이 아님)'),
(145, 98, 1, 'Duplicates and merge'),
(146, 98, 2, 'Дублі та злиття'),
(147, 98, 3, 'Duplikate und Zusammenführung'),
(148, 98, 4, 'Doublons et fusion'),
(149, 98, 5, 'Duplicados y fusión'),
(150, 98, 6, 'Duplicati e unione'),
(151, 98, 7, 'Duplicados e mesclagem'),
(152, 98, 8, 'Duplicaten en samenvoegen'),
(153, 98, 9, 'Duplikaty i scalanie'),
(154, 98, 10, '重复项和合并'),
(155, 98, 11, '重複と統合'),
(156, 98, 12, '중복 및 병합'),
(157, 99, 1, 'Export'),
(158, 99, 2, 'Експорт'),
(159, 99, 3, 'Export'),
(160, 99, 4, 'Exportation'),
(161, 99, 5, 'Exportar'),
(162, 99, 6, 'Esporta'),
(163, 99, 7, 'Exportar'),
(164, 99, 8, 'Exporteren'),
(165, 99, 9, 'Eksport'),
(166, 99, 10, '导出'),
(167, 99, 11, 'エクスポート'),
(168, 99, 12, '내보내기'),
(169, 100, 1, 'Import'),
(170, 100, 2, 'Імпорт'),
(171, 100, 3, 'Import'),
(172, 100, 4, 'Importation'),
(173, 100, 5, 'Importar'),
(174, 100, 6, 'Importa'),
(175, 100, 7, 'Importar'),
(176, 100, 8, 'Importeren'),
(177, 100, 9, 'Import'),
(178, 100, 10, '导入'),
(179, 100, 11, 'インポート'),
(180, 100, 12, '가져오기'),
(181, 101, 1, 'Client settings'),
(182, 101, 2, 'Налаштування клієнтів'),
(183, 101, 3, 'Kundeneinstellungen'),
(184, 101, 4, 'Paramètres des clients'),
(185, 101, 5, 'Configuración de clientes'),
(186, 101, 6, 'Impostazioni clienti'),
(187, 101, 7, 'Configurações de clientes'),
(188, 101, 8, 'Klantinstellingen'),
(189, 101, 9, 'Ustawienia klientów'),
(190, 101, 10, '客户设置'),
(191, 101, 11, '顧客設定'),
(192, 101, 12, '고객 설정'),
(193, 102, 1, 'System'),
(194, 102, 2, 'Система'),
(195, 102, 3, 'System'),
(196, 102, 4, 'Système'),
(197, 102, 5, 'Sistema'),
(198, 102, 6, 'Sistema'),
(199, 102, 7, 'Sistema'),
(200, 102, 8, 'Systeem');
INSERT IGNORE INTO `prefix_users_permissions_pages_lang` (`id`, `id_page`, `id_lang`, `name`) VALUES
(201, 102, 9, 'System'),
(202, 102, 10, '系统'),
(203, 102, 11, 'システム'),
(204, 102, 12, '시스템'),
(205, 103, 1, 'Audit log'),
(206, 103, 2, 'Журнал дій'),
(207, 103, 3, 'Audit-Protokoll'),
(208, 103, 4, 'Journal d\'audit'),
(209, 103, 5, 'Registro de auditoría'),
(210, 103, 6, 'Registro di controllo'),
(211, 103, 7, 'Registro de auditoria'),
(212, 103, 8, 'Auditspoor'),
(213, 103, 9, 'Dziennik zdarzeń'),
(214, 103, 10, '审计日志'),
(215, 103, 11, '監査ログ'),
(216, 103, 12, '감사 로그'),
(217, 104, 1, 'Trash'),
(218, 104, 2, 'Кошик'),
(219, 104, 3, 'Papierkorb'),
(220, 104, 4, 'Corbeille'),
(221, 104, 5, 'Papelera'),
(222, 104, 6, 'Cestino'),
(223, 104, 7, 'Lixeira'),
(224, 104, 8, 'Prullenbak'),
(225, 104, 9, 'Kosz'),
(226, 104, 10, '回收站'),
(227, 104, 11, 'ゴミ箱'),
(228, 104, 12, '휴지통'),
(229, 105, 1, 'Leads'),
(230, 105, 2, 'Ліди'),
(231, 105, 3, 'Leads'),
(232, 105, 4, 'Prospects'),
(233, 105, 5, 'Clientes potenciales'),
(234, 105, 6, 'Lead'),
(235, 105, 7, 'Leads'),
(236, 105, 8, 'Leads'),
(237, 105, 9, 'Leady'),
(238, 105, 10, '潜在客户'),
(239, 105, 11, 'リード'),
(240, 105, 12, '리드'),
(241, 106, 1, 'List and cards'),
(242, 106, 2, 'Список і картки'),
(243, 106, 3, 'Liste und Karten'),
(244, 106, 4, 'Liste et fiches'),
(245, 106, 5, 'Lista y tarjetas'),
(246, 106, 6, 'Elenco e schede'),
(247, 106, 7, 'Lista e cartões'),
(248, 106, 8, 'Lijst en kaarten'),
(249, 106, 9, 'Lista i karty'),
(250, 106, 10, '列表和卡片'),
(251, 106, 11, 'リストとカード'),
(252, 106, 12, '목록 및 카드'),
(253, 107, 1, 'All leads (not only own)'),
(254, 107, 2, 'Усі ліди (не лише свої)'),
(255, 107, 3, 'Alle Leads (nicht nur eigene)'),
(256, 107, 4, 'Tous les prospects (pas seulement les siens)'),
(257, 107, 5, 'Todos los clientes potenciales (no solo los propios)'),
(258, 107, 6, 'Tutti i lead (non solo i propri)'),
(259, 107, 7, 'Todos os leads (não apenas os próprios)'),
(260, 107, 8, 'Alle leads (niet alleen eigen)'),
(261, 107, 9, 'Wszystkie leady (nie tylko własne)'),
(262, 107, 10, '所有潜在客户（不仅是自己的）'),
(263, 107, 11, 'すべてのリード（自分のみに限らない）'),
(264, 107, 12, '모든 리드(본인 것만이 아님)'),
(265, 108, 1, 'Lead settings'),
(266, 108, 2, 'Налаштування лідів'),
(267, 108, 3, 'Lead-Einstellungen'),
(268, 108, 4, 'Paramètres des prospects'),
(269, 108, 5, 'Configuración de clientes potenciales'),
(270, 108, 6, 'Impostazioni lead'),
(271, 108, 7, 'Configurações de leads'),
(272, 108, 8, 'Lead-instellingen'),
(273, 108, 9, 'Ustawienia leadów'),
(274, 108, 10, '潜在客户设置'),
(275, 108, 11, 'リード設定'),
(276, 108, 12, '리드 설정'),
(277, 109, 1, 'Orders'),
(278, 109, 2, 'Замовлення'),
(279, 109, 3, 'Bestellungen'),
(280, 109, 4, 'Commandes'),
(281, 109, 5, 'Pedidos'),
(282, 109, 6, 'Ordini'),
(283, 109, 7, 'Pedidos'),
(284, 109, 8, 'Bestellingen'),
(285, 109, 9, 'Zamówienia'),
(286, 109, 10, '订单'),
(287, 109, 11, '注文'),
(288, 109, 12, '주문'),
(289, 110, 1, 'List and cards'),
(290, 110, 2, 'Список і картки'),
(291, 110, 3, 'Liste und Karten'),
(292, 110, 4, 'Liste et fiches'),
(293, 110, 5, 'Lista y tarjetas'),
(294, 110, 6, 'Elenco e schede'),
(295, 110, 7, 'Lista e cartões'),
(296, 110, 8, 'Lijst en kaarten'),
(297, 110, 9, 'Lista i karty'),
(298, 110, 10, '列表和卡片'),
(299, 110, 11, 'リストとカード'),
(300, 110, 12, '목록 및 카드'),
(301, 111, 1, 'All orders (not only own)'),
(302, 111, 2, 'Усі замовлення (не лише свої)'),
(303, 111, 3, 'Alle Bestellungen (nicht nur eigene)'),
(304, 111, 4, 'Toutes les commandes (pas seulement les siennes)'),
(305, 111, 5, 'Todos los pedidos (no solo los propios)'),
(306, 111, 6, 'Tutti gli ordini (non solo i propri)'),
(307, 111, 7, 'Todos os pedidos (não apenas os próprios)'),
(308, 111, 8, 'Alle bestellingen (niet alleen eigen)'),
(309, 111, 9, 'Wszystkie zamówienia (nie tylko własne)'),
(310, 111, 10, '所有订单（不仅是自己的）'),
(311, 111, 11, 'すべての注文（自分のみに限らない）'),
(312, 111, 12, '모든 주문(본인 것만이 아님)'),
(313, 112, 1, 'Abandoned carts'),
(314, 112, 2, 'Покинуті кошики'),
(315, 112, 3, 'Verworfene Warenkörbe'),
(316, 112, 4, 'Paniers abandonnés'),
(317, 112, 5, 'Carritos abandonados'),
(318, 112, 6, 'Carrelli abbandonati'),
(319, 112, 7, 'Carrinhos abandonados'),
(320, 112, 8, 'Verlaten winkelwagens'),
(321, 112, 9, 'Porzucone koszyki'),
(322, 112, 10, '被放弃的购物车'),
(323, 112, 11, '放棄されたカート'),
(324, 112, 12, '버려진 장바구니'),
(325, 113, 1, 'Order settings'),
(326, 113, 2, 'Налаштування замовлень'),
(327, 113, 3, 'Bestelleinstellungen'),
(328, 113, 4, 'Paramètres des commandes'),
(329, 113, 5, 'Configuración de pedidos'),
(330, 113, 6, 'Impostazioni ordini'),
(331, 113, 7, 'Configurações de pedidos'),
(332, 113, 8, 'Bestelinstellingen'),
(333, 113, 9, 'Ustawienia zamówień'),
(334, 113, 10, '订单设置'),
(335, 113, 11, '注文設定'),
(336, 113, 12, '주문 설정'),
(337, 114, 1, 'Catalog'),
(338, 114, 2, 'Каталог'),
(339, 114, 3, 'Katalog'),
(340, 114, 4, 'Catalogue'),
(341, 114, 5, 'Catálogo'),
(342, 114, 6, 'Catalogo'),
(343, 114, 7, 'Catálogo'),
(344, 114, 8, 'Catalogus'),
(345, 114, 9, 'Katalog'),
(346, 114, 10, '目录'),
(347, 114, 11, 'カタログ'),
(348, 114, 12, '카탈로그'),
(349, 115, 1, 'Products'),
(350, 115, 2, 'Товари'),
(351, 115, 3, 'Produkte'),
(352, 115, 4, 'Produits'),
(353, 115, 5, 'Productos'),
(354, 115, 6, 'Prodotti'),
(355, 115, 7, 'Produtos'),
(356, 115, 8, 'Producten'),
(357, 115, 9, 'Produkty'),
(358, 115, 10, '产品'),
(359, 115, 11, '製品'),
(360, 115, 12, '제품'),
(361, 116, 1, 'Cost and purchase prices'),
(362, 116, 2, 'Собівартість і закупівельні ціни'),
(363, 116, 3, 'Kosten und Einkaufspreise'),
(364, 116, 4, 'Coûts et prix d\'achat'),
(365, 116, 5, 'Coste y precios de compra'),
(366, 116, 6, 'Costo e prezzi di acquisto'),
(367, 116, 7, 'Custo e preços de compra'),
(368, 116, 8, 'Kosten en inkoopprijzen'),
(369, 116, 9, 'Koszty i ceny zakupu'),
(370, 116, 10, '成本和采购价'),
(371, 116, 11, '原価と仕入価格'),
(372, 116, 12, '원가 및 매입가'),
(373, 117, 1, 'Product categories'),
(374, 117, 2, 'Категорії товарів'),
(375, 117, 3, 'Produktkategorien'),
(376, 117, 4, 'Catégories de produits'),
(377, 117, 5, 'Categorías de productos'),
(378, 117, 6, 'Categorie di prodotti'),
(379, 117, 7, 'Categorias de produtos'),
(380, 117, 8, 'Productcategorieën'),
(381, 117, 9, 'Kategorie produktów'),
(382, 117, 10, '产品分类'),
(383, 117, 11, '製品カテゴリ'),
(384, 117, 12, '제품 카테고리'),
(385, 118, 1, 'Brands'),
(386, 118, 2, 'Бренди'),
(387, 118, 3, 'Marken'),
(388, 118, 4, 'Marques'),
(389, 118, 5, 'Marcas'),
(390, 118, 6, 'Marchi'),
(391, 118, 7, 'Marcas'),
(392, 118, 8, 'Merken'),
(393, 118, 9, 'Marki'),
(394, 118, 10, '品牌'),
(395, 118, 11, 'ブランド'),
(396, 118, 12, '브랜드'),
(397, 119, 1, 'Attributes'),
(398, 119, 2, 'Характеристики'),
(399, 119, 3, 'Attribute'),
(400, 119, 4, 'Attributs');
INSERT IGNORE INTO `prefix_users_permissions_pages_lang` (`id`, `id_page`, `id_lang`, `name`) VALUES
(401, 119, 5, 'Atributos'),
(402, 119, 6, 'Attributi'),
(403, 119, 7, 'Atributos'),
(404, 119, 8, 'Attributen'),
(405, 119, 9, 'Atrybuty'),
(406, 119, 10, '属性'),
(407, 119, 11, '属性'),
(408, 119, 12, '속성'),
(409, 120, 1, 'Product options'),
(410, 120, 2, 'Опції товарів'),
(411, 120, 3, 'Produktoptionen'),
(412, 120, 4, 'Options de produits'),
(413, 120, 5, 'Opciones de productos'),
(414, 120, 6, 'Opzioni prodotti'),
(415, 120, 7, 'Opções de produtos'),
(416, 120, 8, 'Productopties'),
(417, 120, 9, 'Opcje produktów'),
(418, 120, 10, '产品选项'),
(419, 120, 11, '製品オプション'),
(420, 120, 12, '제품 옵션'),
(421, 121, 1, 'Warehouses'),
(422, 121, 2, 'Склади'),
(423, 121, 3, 'Lagerhäuser'),
(424, 121, 4, 'Entrepôts'),
(425, 121, 5, 'Almacenes'),
(426, 121, 6, 'Magazzini'),
(427, 121, 7, 'Armazéns'),
(428, 121, 8, 'Magazijnen'),
(429, 121, 9, 'Magazyny'),
(430, 121, 10, '仓库'),
(431, 121, 11, '倉庫'),
(432, 121, 12, '창고'),
(433, 122, 1, 'Suppliers'),
(434, 122, 2, 'Постачальники'),
(435, 122, 3, 'Lieferanten'),
(436, 122, 4, 'Fournisseurs'),
(437, 122, 5, 'Proveedores'),
(438, 122, 6, 'Fornitori'),
(439, 122, 7, 'Fornecedores'),
(440, 122, 8, 'Leveranciers'),
(441, 122, 9, 'Dostawcy'),
(442, 122, 10, '供应商'),
(443, 122, 11, 'サプライヤー'),
(444, 122, 12, '공급업체'),
(445, 123, 1, 'Stock and stock documents'),
(446, 123, 2, 'Залишки та складські документи'),
(447, 123, 3, 'Lagerbestand und Lagerdokumente'),
(448, 123, 4, 'Stock et documents de stock'),
(449, 123, 5, 'Existencias y documentos de almacén'),
(450, 123, 6, 'Scorte e documenti di magazzino'),
(451, 123, 7, 'Estoque e documentos de estoque'),
(452, 123, 8, 'Voorraad en voorraaddocumenten'),
(453, 123, 9, 'Zapasy i dokumenty magazynowe'),
(454, 123, 10, '库存和库存单据'),
(455, 123, 11, '在庫と在庫伝票'),
(456, 123, 12, '재고 및 재고 문서'),
(457, 124, 1, 'Catalog settings'),
(458, 124, 2, 'Налаштування каталогу'),
(459, 124, 3, 'Katalogeinstellungen'),
(460, 124, 4, 'Paramètres du catalogue'),
(461, 124, 5, 'Configuración del catálogo'),
(462, 124, 6, 'Impostazioni catalogo'),
(463, 124, 7, 'Configurações do catálogo'),
(464, 124, 8, 'Catalogusinstellingen'),
(465, 124, 9, 'Ustawienia katalogu'),
(466, 124, 10, '目录设置'),
(467, 124, 11, 'カタログ設定'),
(468, 124, 12, '카탈로그 설정'),
(469, 125, 1, 'Products import / export'),
(470, 125, 2, 'Імпорт / експорт товарів'),
(471, 125, 3, 'Produktimport/-export'),
(472, 125, 4, 'Import/export de produits'),
(473, 125, 5, 'Importación/exportación de productos'),
(474, 125, 6, 'Importazione/esportazione prodotti'),
(475, 125, 7, 'Importação/exportação de produtos'),
(476, 125, 8, 'Producten importeren/exporteren'),
(477, 125, 9, 'Import/eksport produktów'),
(478, 125, 10, '产品导入/导出'),
(479, 125, 11, '製品のインポート/エクスポート'),
(480, 125, 12, '제품 가져오기/내보내기'),
(481, 126, 1, 'Store synchronization'),
(482, 126, 2, 'Синхронізація з магазинами'),
(483, 126, 3, 'Shop-Synchronisierung'),
(484, 126, 4, 'Synchronisation de la boutique'),
(485, 126, 5, 'Sincronización de tiendas'),
(486, 126, 6, 'Sincronizzazione negozi'),
(487, 126, 7, 'Sincronização de lojas'),
(488, 126, 8, 'Winkel-synchronisatie'),
(489, 126, 9, 'Synchronizacja sklepów'),
(490, 126, 10, '商店同步'),
(491, 126, 11, 'ストア同期'),
(492, 126, 12, '스토어 동기화'),
(493, 127, 1, 'Modules'),
(494, 127, 2, 'Модулі'),
(495, 127, 3, 'Module'),
(496, 127, 4, 'Modules'),
(497, 127, 5, 'Módulos'),
(498, 127, 6, 'Moduli'),
(499, 127, 7, 'Módulos'),
(500, 127, 8, 'Modules'),
(501, 127, 9, 'Moduły'),
(502, 127, 10, '模块'),
(503, 127, 11, 'モジュール'),
(504, 127, 12, '모듈'),
(505, 128, 1, 'Mailing'),
(506, 128, 2, 'Розсилки'),
(507, 128, 3, 'Mailings'),
(508, 128, 4, 'Mailings'),
(509, 128, 5, 'Envíos'),
(510, 128, 6, 'Invii'),
(511, 128, 7, 'Envios'),
(512, 128, 8, 'Mailings'),
(513, 128, 9, 'Wysyłki'),
(514, 128, 10, '群发'),
(515, 128, 11, 'メール配信'),
(516, 128, 12, '메일링'),
(517, 129, 1, 'Campaigns and automations'),
(518, 129, 2, 'Кампанії та автоматизації'),
(519, 129, 3, 'Kampagnen und Automatisierungen'),
(520, 129, 4, 'Campagnes et automatisations'),
(521, 129, 5, 'Campañas y automatizaciones'),
(522, 129, 6, 'Campagne e automazioni'),
(523, 129, 7, 'Campanhas e automações'),
(524, 129, 8, 'Campagnes en automatiseringen'),
(525, 129, 9, 'Kampanie i automatyzacje'),
(526, 129, 10, '营销活动和自动化'),
(527, 129, 11, 'キャンペーンと自動化'),
(528, 129, 12, '캠페인 및 자동화'),
(529, 130, 1, 'Start and stop mailings'),
(530, 130, 2, 'Запуск і зупинка розсилок'),
(531, 130, 3, 'Mailings starten und stoppen'),
(532, 130, 4, 'Démarrer et arrêter les envois'),
(533, 130, 5, 'Iniciar y detener envíos'),
(534, 130, 6, 'Avvia e arresta invii'),
(535, 130, 7, 'Iniciar e parar envios'),
(536, 130, 8, 'Mailings starten en stoppen'),
(537, 130, 9, 'Uruchamianie i zatrzymywanie wysyłek'),
(538, 130, 10, '启动和停止群发'),
(539, 130, 11, '配信の開始と停止'),
(540, 130, 12, '메일링 시작 및 중지'),
(541, 131, 1, 'Templates'),
(542, 131, 2, 'Шаблони'),
(543, 131, 3, 'Vorlagen'),
(544, 131, 4, 'Modèles'),
(545, 131, 5, 'Plantillas'),
(546, 131, 6, 'Modelli'),
(547, 131, 7, 'Modelos'),
(548, 131, 8, 'Sjablonen'),
(549, 131, 9, 'Szablony'),
(550, 131, 10, '模板'),
(551, 131, 11, 'テンプレート'),
(552, 131, 12, '템플릿'),
(553, 132, 1, 'Contacts, lists, import'),
(554, 132, 2, 'Контакти, списки, імпорт'),
(555, 132, 3, 'Kontakte, Listen, Import'),
(556, 132, 4, 'Contacts, listes, importation'),
(557, 132, 5, 'Contactos, listas, importación'),
(558, 132, 6, 'Contatti, liste, importazione'),
(559, 132, 7, 'Contatos, listas, importação'),
(560, 132, 8, 'Contacten, lijsten, importeren'),
(561, 132, 9, 'Kontakty, listy, import'),
(562, 132, 10, '联系人、列表、导入'),
(563, 132, 11, '連絡先、リスト、インポート'),
(564, 132, 12, '연락처, 목록, 가져오기'),
(565, 133, 1, 'Settings and senders'),
(566, 133, 2, 'Налаштування і відправники'),
(567, 133, 3, 'Einstellungen und Absender'),
(568, 133, 4, 'Paramètres et expéditeurs'),
(569, 133, 5, 'Configuración y remitentes'),
(570, 133, 6, 'Impostazioni e mittenti'),
(571, 133, 7, 'Configurações e remetentes'),
(572, 133, 8, 'Instellingen en afzenders'),
(573, 133, 9, 'Ustawienia i nadawcy'),
(574, 133, 10, '设置和发件人'),
(575, 133, 11, '設定と送信者'),
(576, 133, 12, '설정 및 발신자'),
(577, 136, 1, 'Products: currencies and rates'),
(578, 136, 2, 'Товари: валюти й курси'),
(579, 136, 3, 'Produkte: Währungen und Kurse'),
(580, 136, 4, 'Produits : devises et taux'),
(581, 136, 5, 'Productos: monedas y tipos de cambio'),
(582, 136, 6, 'Prodotti: valute e tassi'),
(583, 136, 7, 'Produtos: moedas e taxas'),
(584, 136, 8, 'Producten: valuta\'s en koersen'),
(585, 136, 9, 'Produkty: waluty i kursy'),
(586, 136, 10, '产品：货币和汇率'),
(587, 136, 11, '製品：通貨とレート'),
(588, 136, 12, '제품: 통화 및 환율'),
(589, 137, 1, 'Analytics'),
(590, 137, 2, 'Аналітика'),
(591, 137, 3, 'Analysen'),
(592, 137, 4, 'Analyses'),
(593, 137, 5, 'Analíticas'),
(594, 137, 6, 'Analisi'),
(595, 137, 7, 'Análises'),
(596, 137, 8, 'Analyses'),
(597, 137, 9, 'Analityka'),
(598, 137, 10, '分析'),
(599, 137, 11, '分析'),
(600, 137, 12, '분석');
INSERT IGNORE INTO `prefix_users_permissions_pages_lang` (`id`, `id_page`, `id_lang`, `name`) VALUES
(601, 138, 1, 'Reports'),
(602, 138, 2, 'Звіти'),
(603, 138, 3, 'Berichte'),
(604, 138, 4, 'Rapports'),
(605, 138, 5, 'Informes'),
(606, 138, 6, 'Report'),
(607, 138, 7, 'Relatórios'),
(608, 138, 8, 'Rapporten'),
(609, 138, 9, 'Raporty'),
(610, 138, 10, '报表'),
(611, 138, 11, 'レポート'),
(612, 138, 12, '보고서'),
(613, 139, 1, 'Deals: settings'),
(614, 139, 2, 'Угоди: налаштування'),
(615, 139, 3, 'Deals: Einstellungen'),
(616, 139, 4, 'Affaires : paramètres'),
(617, 139, 5, 'Negocios: configuración'),
(618, 139, 6, 'Affari: impostazioni'),
(619, 139, 7, 'Negócios: configurações'),
(620, 139, 8, 'Deals: instellingen'),
(621, 139, 9, 'Umowy: ustawienia'),
(622, 139, 10, '交易：设置'),
(623, 139, 11, '取引：設定'),
(624, 139, 12, '거래: 설정'),
(625, 140, 1, 'Social media posts'),
(626, 140, 2, 'Публікації в соцмережі'),
(627, 140, 3, 'Social-Media-Beiträge'),
(628, 140, 4, 'Publications sur les réseaux sociaux'),
(629, 140, 5, 'Publicaciones en redes sociales'),
(630, 140, 6, 'Pubblicazioni sui social media'),
(631, 140, 7, 'Publicações em redes sociais'),
(632, 140, 8, 'Social media-berichten'),
(633, 140, 9, 'Posty w mediach społecznościowych'),
(634, 140, 10, '社交媒体帖子'),
(635, 140, 11, 'ソーシャルメディア投稿'),
(636, 140, 12, '소셜 미디어 게시물'),
(637, 141, 1, 'Social media comments'),
(638, 141, 2, 'Коментарі в соцмережах'),
(639, 141, 3, 'Social-Media-Kommentare'),
(640, 141, 4, 'Commentaires sur les réseaux sociaux'),
(641, 141, 5, 'Comentarios en redes sociales'),
(642, 141, 6, 'Commenti sui social media'),
(643, 141, 7, 'Comentários em redes sociais'),
(644, 141, 8, 'Social media-reacties'),
(645, 141, 9, 'Komentarze w mediach społecznościowych'),
(646, 141, 10, '社交媒体评论'),
(647, 141, 11, 'ソーシャルメディアのコメント'),
(648, 141, 12, '소셜 미디어 댓글'),
(939, 142, 3, 'Company structure'),
(940, 142, 1, 'Company structure'),
(941, 142, 5, 'Company structure'),
(942, 142, 4, 'Company structure'),
(943, 142, 6, 'Company structure'),
(944, 142, 11, 'Company structure'),
(945, 142, 12, 'Company structure'),
(946, 142, 8, 'Company structure'),
(947, 142, 9, 'Company structure'),
(948, 142, 7, 'Company structure'),
(949, 142, 2, 'Структура компанії'),
(950, 142, 10, 'Company structure'),
(954, 143, 2, 'Чат компанії'),
(955, 143, 3, 'Чат компанії'),
(956, 143, 4, 'Чат компанії'),
(957, 143, 5, 'Чат компанії'),
(958, 143, 6, 'Чат компанії'),
(959, 143, 7, 'Чат компанії'),
(960, 143, 8, 'Чат компанії'),
(961, 143, 9, 'Чат компанії'),
(962, 143, 10, 'Чат компанії'),
(963, 143, 11, 'Чат компанії'),
(964, 143, 12, 'Чат компанії'),
(965, 143, 1, 'Чат компанії'),
(969, 144, 2, 'Оголошення'),
(970, 144, 3, 'Оголошення'),
(971, 144, 4, 'Оголошення'),
(972, 144, 5, 'Оголошення'),
(973, 144, 6, 'Оголошення'),
(974, 144, 7, 'Оголошення'),
(975, 144, 8, 'Оголошення'),
(976, 144, 9, 'Оголошення'),
(977, 144, 10, 'Оголошення'),
(978, 144, 11, 'Оголошення'),
(979, 144, 12, 'Оголошення'),
(980, 144, 1, 'Оголошення'),
(984, 145, 2, 'Аналітика чату'),
(985, 145, 3, 'Аналітика чату'),
(986, 145, 4, 'Аналітика чату'),
(987, 145, 5, 'Аналітика чату'),
(988, 145, 6, 'Аналітика чату'),
(989, 145, 7, 'Аналітика чату'),
(990, 145, 8, 'Аналітика чату'),
(991, 145, 9, 'Аналітика чату'),
(992, 145, 10, 'Аналітика чату'),
(993, 145, 11, 'Аналітика чату'),
(994, 145, 12, 'Аналітика чату'),
(995, 145, 1, 'Аналітика чату');

-- Група 1 (адміністратор): повні права на всі сторінки, інші групи не змінюються
INSERT INTO `prefix_users_groups_permissions` (`id_group`, `id_page`, `can_view`, `can_add`, `can_edit`, `can_delete`)
SELECT 1, p.`id`, 1, 1, 1, 1 FROM `prefix_users_permissions_pages` p
WHERE EXISTS (SELECT 1 FROM `prefix_users_groups` g WHERE g.`id` = 1)
ON DUPLICATE KEY UPDATE `can_view` = 1, `can_add` = 1, `can_edit` = 1, `can_delete` = 1;

SET SQL_MODE = @OLD_SQL_MODE;
SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
