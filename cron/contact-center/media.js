const files = require("../../controllers/contact-center/files");

// Підбирає вкладення, що впали з мережевих помилок
setInterval(function () {
	files.processQueue(20).catch(function () {});
}, 60000);

module.exports = {};