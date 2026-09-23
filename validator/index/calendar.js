const Ajv = require("ajv");

// coerceTypes      — фронт шле числа рядками ("2", "30"); приводимо на льоту
// useDefaults      — підставляє дефолти зі схеми у відсутні поля
// removeAdditional — тихо викидає зайві поля замість помилки
// allErrors        — збираємо всі помилки, а не лише першу
const ajv = new Ajv({
  coerceTypes: true,
  useDefaults: true,
  removeAdditional: true,
  allErrors: true,
});

// ============================================================
// ПАТЕРНИ
// ============================================================

// ISO-datetime без обов'язкової таймзони:
// "2026-08-23T14:30" / "2026-08-23 14:30:00" / "2026-08-23T14:30:00+03:00"
const DATETIME_PATTERN = "^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(:\\d{2})?(\\.\\d+)?(Z|[+-]\\d{2}:?\\d{2})?$";

// "09:00" / "09:00:00"
const TIME_PATTERN = "^\\d{2}:\\d{2}(:\\d{2})?$";

// Обмеження тривалості події: рік.
// Довші події ламають range scan по кластерному індексу.
const MAX_DURATION_MS = 366 * 86400000;

// ============================================================
// СХЕМИ
// ============================================================

// ------------------------------------------------------------
// Створення / редагування події
// ------------------------------------------------------------
const eventSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 255 },
    description: { type: ["string", "null"], maxLength: 65000, default: null },
    location: { type: ["string", "null"], maxLength: 255, default: null },
    location_url: { type: ["string", "null"], maxLength: 500, default: null },

    date_start: { type: "string", pattern: DATETIME_PATTERN },
    date_end: { type: "string", pattern: DATETIME_PATTERN },

    all_day: { type: "integer", enum: [0, 1], default: 0 },

    // Зсув таймзони у хвилинах: -840 (UTC-14) .. +840 (UTC+14)
    tz_offset: { type: "integer", minimum: -840, maximum: 840, default: 0 },

    // 1-низький 2-середній 3-високий 4-критичний
    priority: { type: "integer", minimum: 1, maximum: 4, default: 2 },

    // 1-planned 2-done 3-canceled
    status: { type: "integer", minimum: 1, maximum: 3, default: 1 },

    // Видимість: 1-private 2-busy 3-team(резерв) 4-company
    visibility: { type: "integer", enum: [1, 2, 3, 4], default: 1 },

    // Кому сповіщення: 0-none 1-me 2-participants 3-team(резерв) 4-company
    notify_scope: { type: "integer", enum: [0, 1, 2, 3, 4], default: 2 },

    // Чи займає час у шарі Free/Busy
    is_busy: { type: "integer", enum: [0, 1], default: 1 },

    // tinyint UNSIGNED у БД
    id_event_type: {
      type: ["integer", "null"],
      minimum: 1,
      maximum: 255,
      default: null,
    },

    // 0..43200 хв = до 30 діб наперед; null = без нагадування
    reminder_minutes: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: 43200,
      default: null,
    },

    // Зв'язок із сутністю CRM: 1-deal 2-company 3-contact 4-lead
    id_ref_type: {
      type: ["integer", "null"],
      minimum: 1,
      maximum: 255,
      default: null,
    },
    id_ref: {
      type: ["integer", "null"],
      minimum: 1,
      default: null,
    },

    participant_ids: {
      type: "array",
      items: { type: "integer", minimum: 1 },
      maxItems: 100,
      default: [],
    },
  },
  required: ["title", "date_start", "date_end"],
  additionalProperties: false,
};

// ------------------------------------------------------------
// Перенесення / resize (drag & drop у FullCalendar)
// ------------------------------------------------------------
const rescheduleSchema = {
  type: "object",
  properties: {
    date_start: { type: "string", pattern: DATETIME_PATTERN },
    date_end: { type: "string", pattern: DATETIME_PATTERN },
  },
  required: ["date_start", "date_end"],
  additionalProperties: false,
};

// ------------------------------------------------------------
// Видимий діапазон календаря
// ------------------------------------------------------------
const rangeSchema = {
  type: "object",
  properties: {
    start: { type: "string", pattern: DATETIME_PATTERN },
    end: { type: "string", pattern: DATETIME_PATTERN },

    // Які шари показувати (перемикачі над календарем)
    show_company: { type: "integer", enum: [0, 1], default: 1 },
    show_busy: { type: "integer", enum: [0, 1], default: 0 },
  },
  required: ["start", "end"],
  additionalProperties: false,
};

// ------------------------------------------------------------
// Відповідь на запрошення
// 0-очікує 1-прийнято 2-відхилено 3-можливо
// ------------------------------------------------------------
const respondSchema = {
  type: "object",
  properties: {
    response: { type: "integer", minimum: 0, maximum: 3 },
  },
  required: ["response"],
  additionalProperties: false,
};

// ------------------------------------------------------------
// Налаштування календаря
// ------------------------------------------------------------
const settingsSchema = {
  type: "object",
  properties: {
    default_view: {
      type: "string",
      enum: ["dayGridMonth", "timeGridWeek", "timeGridDay", "listWeek"],
      default: "dayGridMonth",
    },
    first_day: { type: "integer", enum: [0, 1], default: 1 },
    work_time_start: { type: "string", pattern: TIME_PATTERN, default: "09:00:00" },
    work_time_end: { type: "string", pattern: TIME_PATTERN, default: "18:00:00" },
    default_reminder: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: 43200,
      default: 30,
    },
    notify_email: { type: "integer", enum: [0, 1], default: 1 },
    notify_push: { type: "integer", enum: [0, 1], default: 1 },
    auto_accept: { type: "integer", enum: [0, 1], default: 0 },

    show_company: { type: "integer", enum: [0, 1], default: 1 },
    show_busy: { type: "integer", enum: [0, 1], default: 0 },
    default_visibility: { type: "integer", enum: [1, 2, 3, 4], default: 1 },
  },
  additionalProperties: false,
};

// Компіляція один раз при завантаженні модуля
const validateEvent = ajv.compile(eventSchema);
const validateReschedule = ajv.compile(rescheduleSchema);
const validateRange = ajv.compile(rangeSchema);
const validateRespond = ajv.compile(respondSchema);
const validateSettings = ajv.compile(settingsSchema);

// ============================================================
// ПЕРЕВІРКИ, ЯКІ СХЕМОЮ НЕ ВИРАЖАЮТЬСЯ
// ============================================================

function fail(message) {
  return { valid: false, errors: [{ message }] };
}

// Порядок і тривалість дат
function checkDateOrder(data, keyStart, keyEnd) {
  const ts = Date.parse(data[keyStart]);
  const te = Date.parse(data[keyEnd]);

  if (isNaN(ts) || isNaN(te)) return fail("Невірний формат дати");
  if (te < ts) return fail("Дата завершення раніше за початок");
  if (te - ts > MAX_DURATION_MS) return fail("Подія не може тривати понад рік");

  return { valid: true };
}

// Узгодженість видимості й області сповіщень
function checkScopes(data) {
  // Не можна сповіщати ширше, ніж видно: людина отримає картку
  // про подію, яку не має права відкрити
  if (data.notify_scope > data.visibility && data.notify_scope !== 1) {
    return fail("Область сповіщень ширша за видимість події");
  }

  // Приватну подію не можна розсилати всім
  if (data.visibility === 1 && data.notify_scope >= 3) {
    return fail("Приватну подію не можна розсилати всім");
  }

  return { valid: true };
}

// Робочий час: кінець після початку
function checkWorkTime(data) {
  if (data.work_time_end <= data.work_time_start) {
    return fail("Кінець робочого дня раніше за початок");
  }
  return { valid: true };
}

// Обрізаємо пробіли; порожні рядки -> null
function trimStrings(data, keys) {
  for (const key of keys) {
    if (typeof data[key] === "string") {
      data[key] = data[key].trim() || null;
    }
  }
  return { valid: true };
}

// ============================================================
// ЕКСПОРТ
// ============================================================

module.exports = {
  // Створення / редагування події
  event: (data) => {
    if (!validateEvent(data)) {
      return { valid: false, errors: validateEvent.errors };
    }

    trimStrings(data, ["title", "description", "location", "location_url"]);

    // title міг стати null після trim (наприклад, було "   ")
    if (!data.title) return fail("Вкажіть назву події");

    const dates = checkDateOrder(data, "date_start", "date_end");
    if (!dates.valid) return dates;

    // Пара ref-полів має бути заповнена цілком або не заповнена зовсім
    if ((data.id_ref_type === null) !== (data.id_ref === null)) {
      return fail("Невірне посилання на сутність");
    }

    const scopes = checkScopes(data);
    if (!scopes.valid) return scopes;

    return { valid: true, data };
  },

  // Перенесення / resize
  reschedule: (data) => {
    if (!validateReschedule(data)) {
      return { valid: false, errors: validateReschedule.errors };
    }

    const dates = checkDateOrder(data, "date_start", "date_end");
    if (!dates.valid) return dates;

    return { valid: true, data };
  },

  // Видимий діапазон
  range: (data) => {
    if (!validateRange(data)) {
      return { valid: false, errors: validateRange.errors };
    }

    const ts = Date.parse(data.start);
    const te = Date.parse(data.end);

    if (isNaN(ts) || isNaN(te)) return fail("Невірний формат дати");
    if (te < ts) return fail("Кінець діапазону раніше за початок");

    // Захист від запиту "все за 50 років" одним викликом
    if (te - ts > MAX_DURATION_MS) {
      return fail("Діапазон не може перевищувати рік");
    }

    return { valid: true, data };
  },

  // Відповідь на запрошення
  respond: (data) => {
    if (!validateRespond(data)) {
      return { valid: false, errors: validateRespond.errors };
    }
    return { valid: true, data };
  },

  // Налаштування календаря
  settings: (data) => {
    if (!validateSettings(data)) {
      return { valid: false, errors: validateSettings.errors };
    }

    const time = checkWorkTime(data);
    if (!time.valid) return time;

    return { valid: true, data };
  },
};
