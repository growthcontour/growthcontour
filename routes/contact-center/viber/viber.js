// ./routes/contact-center/viber/viber.js

const ViberBot = require('viber-bot').Bot;
const BotEvents = require('viber-bot').Events;
const TextMessage = require('viber-bot').Message.Text;

const viber_bot = new ViberBot({
    authToken: '47bf7bac0c27d12d-666c508eb95ef8d-86f7188164a4ee21',
    name: 'Skyneuron',
    avatar: 'http://example.com/avatar.png'
});

viber_bot.on(BotEvents.MESSAGE_RECEIVED, (message, response) => {
    console.log("id: " + response.userProfile.id);
    console.log("test: " + message.text);

    // Відповідь на повідомлення
    viber_bot.sendMessage(response.userProfile, new TextMessage(message.text));
});

module.exports = viber_bot;