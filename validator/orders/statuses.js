const Ajv = require("ajv");
const ajv = new Ajv({ allErrors: true, coerceTypes: true }); // збираємо всі помилки, не лише першу

// ─── Прапорці (усі однакові: строго 0/1) ────────────────────────────────
const FLAGS = ["logable", "invoice", "hidden", "send_email", "pdf_invoice", "pdf_delivery", "shipped", "paid", "delivery"];
const flagProps = {};
FLAGS.forEach((f) => {
  flagProps[f] = { type: "integer", enum: [0, 1] };
});

// ─── Схема статусу (add / update) ────────────────────────────────────────
const schemaStatus = {
  type: "object",
  properties: {
    // Присутній лише при update; на add його просто не буде
    id: { type: "integer", minimum: 1 },

    // Кольори — строго HEX #rrggbb (захищає і дані, і style бейджа на виводі)
    color_text: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    color_background: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },

    // Іконка — довільний текст, обмежений по довжині
    icon: { type: "string", maxLength: 255 },

    // FK на шаблон листа (може бути null або ціле)
    id_template: { type: ["integer", "null"], minimum: 1 },

    // Назви по мовах: { id_lang: text } — ключі лише цифри, значення-рядки
    names: {
      type: "object",
      patternProperties: {
        "^[0-9]+$": { type: "string", maxLength: 255 },
      },
      additionalProperties: false, // ключі-не-цифри відкидаємо
      minProperties: 1, // хоча б одна мова
    },

    ...flagProps,
  },
  required: ["color_text", "color_background", "names"],
  additionalProperties: false, // будь-які зайві поля — помилка
};

const validateStatus = ajv.compile(schemaStatus);

module.exports = {
  status: (data) => {
    const valid = validateStatus(data);
    return valid ? { valid: true } : { valid: false, errors: validateStatus.errors };
  },
};
