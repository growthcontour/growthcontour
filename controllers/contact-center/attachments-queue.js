const cfg = require("../../config/notifications/config");
const files = require("./files");

// SYNC — качаємо одразу (dev / коли Redis вимкнено)
const syncDriver = {
	async enqueueAttachment(attachmentId) {
		return files.processOne(attachmentId);
	},
};

// BULL — окрема черга, одне завдання на вкладення
let bullDriver = null;
function buildBullDriver() {
	const { Queue } = require("bullmq");
	const { connection } = require("./../notifications/redis");

	const q = new Queue("cc:attachments", {
		connection,
		defaultJobOptions: {
			attempts: 5,
			backoff: { type: "exponential", delay: 5000 },
			removeOnComplete: 1000,
			removeOnFail: 5000,
		},
	});

	return {
		async enqueueAttachment(attachmentId) {
			// jobId = ідемпотентність: те саме вкладення не дублює завдання
			await q.add("download", { attachmentId }, { jobId: `att:${attachmentId}` });
		},
		_queue: q,
	};
}

function getDriver() {
	if (cfg.driver !== "bull") return syncDriver;
	if (!bullDriver) bullDriver = buildBullDriver();
	return bullDriver;
}

module.exports = {
	enqueueAttachment: (id) => getDriver().enqueueAttachment(id),
	_getDriver: getDriver,
};