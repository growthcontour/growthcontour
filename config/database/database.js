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

// ── Діагностика: стан пулу — для сторінки «Стан системи» ──
require("../../logging/metrics").registerPool("callback", () => ({
	all: pool._allConnections.length,
	free: pool._freeConnections.length,
	queue: pool._connectionQueue.length,
	limit: pool.config.connectionLimit,
}));

pool.getConnection(function (error, connection) {
	if (error) {
		return logging.fatal({ module: "db", err: error }, "MySQL connection failed: " + error.message);
	}
	logging.info({ module: "db" }, "MySQL connected");
	connection.release();
});

module.exports = pool;
