const { notify } = require("./notify");
const recipients = require("./recipients");
// Етап 3 додасть: getInbox, getUnreadCount, markRead, markAllRead

module.exports = {
	notify,

	// Отримувачі сповіщень для будь-якого модуля CRM.
	// scope — що налаштовуємо ("contact_center.channel", "orders.status"),
	// scope_ref — конкретний обʼєкт у межах scope.
	// Доставку далі робить notify(), тут лише конфігурація адресатів.
	recipients,
};