const mysql = require("mysql2");
const logging = require("../../logging/logging"); // перевір шлях відносно цього файлу

// Якщо DB_HOST — це шлях до .sock, підключаємось через сокет, інакше через TCP
const isSocket = String(process.env.DB_HOST || "").startsWith("/");

const pool = mysql.createPool({
	...(isSocket ? { socketPath: process.env.DB_HOST } : { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306) }),
	user: process.env.DB_USER,
	database: process.env.DB_NAME,
	password: process.env.DB_PASSWORD,
	waitForConnections: true,
	connectionLimit: 10,
	queueLimit: 0,
	enableKeepAlive: true,
	keepAliveInitialDelay: 0,
	dateStrings: true,
});

// ── діагностика пулу ──
let active2 = 0;
pool.on("acquire", function (conn) {
	active2++;
	logging.info({ pool: "callback", evt: "acquire", threadId: conn.threadId, active: active2 });
});
pool.on("release", function (conn) {
	active2--;
	logging.info({ pool: "callback", evt: "release", threadId: conn.threadId, active: active2 });
});
pool.on("enqueue", function () {
	logging.info({ pool: "callback", evt: "enqueue", active: active2, msg: "waiting for free connection" });
});
pool.on("connection", function (conn) {
	logging.info({ pool: "callback", evt: "connection", threadId: conn.threadId });
});

pool.getConnection(function (error, connection) {
	if (error) {
		return console.error("Помилка підключення: " + error.message);
	}
	console.log("Підключення до MySQL успішно встановлено.");
	connection.release();
});

module.exports = pool;
