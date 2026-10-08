const mysql = require("mysql2/promise");
const logging = require("../../logging/logging"); // перевір шлях відносно цього файлу

// Якщо DB_HOST — це шлях до .sock, підключаємось через сокет, інакше через TCP
const isSocket = String(process.env.DB_HOST || "").startsWith("/");

const pool = mysql.createPool({
	...(isSocket ? { socketPath: process.env.DB_HOST } : { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306) }),
	user: process.env.DB_USER,
	database: process.env.DB_NAME,
	password: process.env.DB_PASSWORD,
	waitForConnections: true,
	connectionLimit: 50,
	queueLimit: 500,
	enableKeepAlive: true,
	keepAliveInitialDelay: 0,
	dateStrings: true,
});

// ── діагностика пулу ──
let active1 = 0;
pool.pool.on("acquire", function (conn) {
	active1++;
	logging.info({ pool: "promise", evt: "acquire", threadId: conn.threadId, active: active1 });
});
pool.pool.on("release", function (conn) {
	active1--;
	logging.info({ pool: "promise", evt: "release", threadId: conn.threadId, active: active1 });
});
pool.pool.on("enqueue", function () {
	logging.info({ pool: "promise", evt: "enqueue", active: active1, msg: "waiting for free connection" });
});
pool.pool.on("connection", function (conn) {
	logging.info({ pool: "promise", evt: "connection", threadId: conn.threadId });
});

module.exports = pool;
