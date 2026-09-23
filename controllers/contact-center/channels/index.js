const telegram = require("./types/telegram");
const instagram = require("./types/instagram");
const webchat = require("./types/webchat");

const registry = { telegram, instagram, webchat };

module.exports = {
	// всі типи — для модалки додавання
	all() {
		return Object.values(registry);
	},

	// тип по коду, null якщо невідомий
	get(code) {
		return Object.prototype.hasOwnProperty.call(registry, code) ? registry[code] : null;
	},

	// метадані без внутрішніх полів — те, що можна віддати у view
	meta() {
		return Object.values(registry).map(function (t) {
			return { code: t.code, label: t.label, icon: t.icon, color: t.color };
		});
	},
};