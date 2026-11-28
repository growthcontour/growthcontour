// redisConnector.js
const redis = require('redis');

class RedisConnector {
  constructor() {
    this.client = redis.createClient({
      socket: {
        host: "127.0.0.1",
        port: 6379,
      },
    });

    this.client.on("connect", () => {
      console.log("Connected to Redis");
    });

    this.client.on("error", (err) => {
      //console.error("Redis error:", err);
    });

    // Connect to the Redis server
    this.client.connect();
  }

  setKey(key, value, callback) {
    this.client.set(key, value, (err, reply) => {
      if (err) {
        console.error(`Error setting key ${key}:`, err);
      } else {
        console.log(`Key ${key} set successfully`);
      }

      if (callback) {
        callback(err, reply);
      }
    });
  }

  getKey(key, callback) {
    this.client.get(key, (err, value) => {
      if (err) {
        console.error(`Error getting key ${key}:`, err);
      } else {
        console.log(`Key value for ${key}:`, value);
      }

      if (callback) {
        callback(err, value);
      }
    });
  }

  quit() {
    // Close the Redis connection
    this.client.quit();
  }
}

module.exports = RedisConnector;
