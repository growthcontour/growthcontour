const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const ajv = new Ajv();
addFormats(ajv);

// ─── basic ────────────────────────────────────────────────────────────────────
const schemaBasic = {
    type: "object",
    properties: {
        first_name:  { type: "string", maxLength: 100 },
        last_name:   { type: "string", maxLength: 100 },
        patronymic:  { type: "string", maxLength: 100 },
        email:       { type: "string", format: "email", maxLength: 255 },
        phone:       { type: "string", maxLength: 20 },
        birthday:    { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        gender:      { type: "integer", enum: [0, 1, 2] },
    },
    required: ["first_name", "last_name", "email", "gender"],
    additionalProperties: false,
};

// ─── password ─────────────────────────────────────────────────────────────────
const schemaPassword = {
    type: "object",
    properties: {
        current_password: { type: "string", minLength: 1 },
        new_password:     { type: "string", minLength: 8, maxLength: 128 },
        confirm_password: { type: "string", minLength: 1 },
    },
    required: ["current_password", "new_password", "confirm_password"],
    additionalProperties: false,
};

// ─── lang ─────────────────────────────────────────────────────────────────────
const schemaLang = {
    type: "object",
    properties: {
        id_lang: { type: "integer", enum: [1, 2] },
    },
    required: ["id_lang"],
    additionalProperties: false,
};

// ─── groups ───────────────────────────────────────────────────────────────────
const schemaGroups = {
    type: "object",
    properties: {
        groups: { type: "array", items: { type: "integer", minimum: 1 } },
    },
    required: ["groups"],
    additionalProperties: false,
};

// ─── tfa-enable ───────────────────────────────────────────────────────────────
const schemaTfaEnable = {
    type: "object",
    properties: {
        secret: { type: "string", minLength: 1 },
        code:   { type: "string", pattern: "^\\d{6}$" },
    },
    required: ["secret", "code"],
    additionalProperties: false,
};

// ─── tfa-disable ──────────────────────────────────────────────────────────────
const schemaTfaDisable = {
    type: "object",
    properties: {
        code: { type: "string", pattern: "^\\d{6}$" },
    },
    required: ["code"],
    additionalProperties: false,
};

const validateBasic      = ajv.compile(schemaBasic);
const validatePassword   = ajv.compile(schemaPassword);
const validateLang       = ajv.compile(schemaLang);
const validateGroups     = ajv.compile(schemaGroups);
const validateTfaEnable  = ajv.compile(schemaTfaEnable);
const validateTfaDisable = ajv.compile(schemaTfaDisable);

module.exports = {
    basic:      (data) => { const v = validateBasic(data);      return v ? { valid: true } : { valid: false, errors: validateBasic.errors }; },
    password:   (data) => { const v = validatePassword(data);   return v ? { valid: true } : { valid: false, errors: validatePassword.errors }; },
    lang:       (data) => { const v = validateLang(data);       return v ? { valid: true } : { valid: false, errors: validateLang.errors }; },
    groups:     (data) => { const v = validateGroups(data);     return v ? { valid: true } : { valid: false, errors: validateGroups.errors }; },
    tfaEnable:  (data) => { const v = validateTfaEnable(data);  return v ? { valid: true } : { valid: false, errors: validateTfaEnable.errors }; },
    tfaDisable: (data) => { const v = validateTfaDisable(data); return v ? { valid: true } : { valid: false, errors: validateTfaDisable.errors }; },
};