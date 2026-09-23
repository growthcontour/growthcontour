// Єдина точка розсилки подій контакт-центру.
// Формат подій однаковий для всіх каналів — фронт не знає, звідки повідомлення.

const { getIO } = require("../socket/socket");

function io() {
	try {
		return getIO() || null;
	} catch (e) {
		return null;
	}
}

module.exports = {
	// Нове повідомлення: у список чатів і у відкритий діалог
	message(payload) {
		const server = io();
		if (!server) return;

		server.to("io_alert_contact_center").emit("cc:message", payload);
		server.to("io_conversation_" + payload.conversation.id).emit("cc:message", payload);

		if (payload.conversation.id_manager) {
			server.to("io_manager_" + payload.conversation.id_manager).emit("cc:message", payload);
		}
	},

	// Зміна статусу діалогу
	conversationStatus(id, status) {
		const server = io();
		if (!server) return;
		server.to("io_alert_contact_center").emit("cc:conversation_status", { id: id, status: status });
	},

	// Діалог пішов іншому менеджеру
	conversationRemoved(id, idManager) {
		const server = io();
		if (!server) return;
		server.to("io_manager_" + idManager).emit("cc:conversation_removed", { id: id });
	},

	// Файл довантажився — підміна заглушки в діалозі
	attachmentReady(idConversation, idMessage, sortOrder, attachment) {
		const server = io();
		if (!server) return;

		server.to("io_conversation_" + idConversation).emit("cc:attachment_ready", {
			id_message: idMessage,
			sort_order: sortOrder,
			attachment: attachment,
		});
	},

	// Клієнт прочитав вихідні повідомлення до вказаного ID
	readReceipt(idConversation, upToMessageId) {
		const server = io();
		if (!server) return;

		server.to("io_conversation_" + idConversation).emit("cc:read_receipt", {
			id_conversation: idConversation,
			up_to: upToMessageId,
		});
	},

	// Клієнт поставив/прибрав реакцію на повідомлення
	reaction(idConversation, idMessage, emoji) {
		const server = io();
		if (!server) return;

		server.to("io_conversation_" + idConversation).emit("cc:reaction", {
			id_conversation: idConversation,
			id_message: idMessage,
			reaction: emoji, // null = прибрано
		});
	},

	// Клієнт друкує (з текстом прев'ю). text порожній = перестав друкувати
	typing(idConversation, text) {
		const server = io();
		if (!server) return;

		server.to("io_conversation_" + idConversation).emit("cc:typing", {
			id_conversation: idConversation,
			text: text || "",
		});
	},

	// Онлайн-статус співрозмовника — і в список, і у відкритий діалог
	presence(idConversation, online) {
		const server = io();
		if (!server) return;
		const data = { id: idConversation, id_conversation: idConversation, online: !!online };
		server.to("io_alert_contact_center").emit("cc:presence", data);
		server.to("io_conversation_" + idConversation).emit("cc:presence", data);
	},

	// Товар, який зараз/востаннє переглядає клієнт
	product(idConversation, product) {
		const server = io();
		if (!server) return;
		server.to("io_conversation_" + idConversation).emit("cc:product", {
			id_conversation: idConversation,
			product: product || null,
		});
	},

	// Жива поточна сторінка клієнта
	visitorPage(idConversation, pageUrl) {
		const server = io();
		if (!server) return;
		server.to("io_conversation_" + idConversation).emit("cc:visitor_page", {
			id_conversation: idConversation,
			page_url: pageUrl || "",
		});
	},
};
