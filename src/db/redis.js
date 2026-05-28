const Redis = require("ioredis");

/**
 * Central Redis configuration (from environment variables).
 *
 * Supported env vars:
 * - REDIS_HOST (default: 127.0.0.1)
 * - REDIS_PORT (default: 6379)
 * - REDIS_PASSWORD (optional)
 * - REDIS_DB (default: 0)
 */
function getRedisConnectionOptions() {
  const host = process.env.REDIS_HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.REDIS_PORT ?? "6379", 10);
  const password = process.env.REDIS_PASSWORD?.trim() || undefined;
  const db = Number.parseInt(process.env.REDIS_DB ?? "0", 10);

  return {
    host,
    port,
    password,
    db,

    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  };
}

let sharedRedis = null;

function getRedis() {
  if (!sharedRedis) {
    sharedRedis = new Redis(getRedisConnectionOptions());

    sharedRedis.on("connect", () => console.log("[redis] connected"));
    sharedRedis.on("error", (err) => console.error("[redis] error", err));
    sharedRedis.on("end", () => console.log("[redis] disconnected"));
  }

  return sharedRedis;
}

function createRedisConnection(purpose = "redis") {
  const client = new Redis(getRedisConnectionOptions());

  client.on("connect", () => console.log(`[redis:${purpose}] connected`));
  client.on("error", (err) => console.error(`[redis:${purpose}] error`, err));
  client.on("end", () => console.log(`[redis:${purpose}] disconnected`));

  return client;
}

module.exports = {
  getRedisConnectionOptions,
  getRedis,
  createRedisConnection,
};
