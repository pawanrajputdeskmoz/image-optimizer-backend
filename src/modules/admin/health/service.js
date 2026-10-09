const os = require("node:os");
const fs = require("node:fs/promises");
const mongoose = require("mongoose");
const { getRedis } = require("../../../db/redis");
const { withTimeout } = require("../../../utils/withTimeout");

const REDIS_PING_TIMEOUT_MS = 3000;
const MONGO_PING_TIMEOUT_MS = 5000;

async function checkMongo() {
  const state = mongoose.connection.readyState;
  const states = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };

  let pingMs = null;
  let ok = state === 1;

  if (ok && mongoose.connection.db) {
    const start = Date.now();
    try {
      await withTimeout(
        mongoose.connection.db.admin().ping(),
        MONGO_PING_TIMEOUT_MS,
        "MongoDB ping"
      );
      pingMs = Date.now() - start;
    } catch (err) {
      return {
        ok: false,
        status: states[state] || "unknown",
        ping_ms: null,
        error: err?.message,
      };
    }
  }

  return {
    ok,
    status: states[state] || "unknown",
    ping_ms: pingMs,
    database: mongoose.connection.name || process.env.MONGODB_DB || null,
  };
}

async function checkRedis() {
  const start = Date.now();
  try {
    const pong = await withTimeout(
      getRedis().ping(),
      REDIS_PING_TIMEOUT_MS,
      "Redis ping"
    );
    return {
      ok: pong === "PONG",
      ping_ms: Date.now() - start,
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT) || 6379,
    };
  } catch (err) {
    return {
      ok: false,
      ping_ms: null,
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT) || 6379,
      error: err?.message,
    };
  }
}

function getHostRamStats() {
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  const usedMb = Math.max(0, totalMb - freeMb);
  const percentage = totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0;

  return { percentage, used_mb: usedMb, total_mb: totalMb };
}

function getApiProcessStats() {
  const mem = process.memoryUsage();
  return {
    memory_mb: Math.round(mem.rss / 1024 / 1024),
    heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
  };
}

async function getDiskUsagePercent() {
  try {
    if (typeof fs.statfs !== "function") {
      return null;
    }
    const stats = await fs.statfs(process.cwd());
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bfree) * Number(stats.bsize);
    if (!total) return null;
    const used = total - free;
    return Math.round((used / total) * 100);
  } catch {
    return null;
  }
}

function getUptimeStats() {
  const uptimeSeconds = Math.floor(process.uptime());
  return {
    uptime_seconds: uptimeSeconds,
    uptime_days: Number((uptimeSeconds / 86400).toFixed(1)),
    uptime_label:
      uptimeSeconds >= 86400
        ? `${Math.floor(uptimeSeconds / 86400)} days`
        : uptimeSeconds >= 3600
          ? `${Math.floor(uptimeSeconds / 3600)} hours`
          : `${Math.floor(uptimeSeconds / 60)} minutes`,
  };
}

exports.getServerHealth = async () => {
  const [mongodb, redis, diskUsagePercent] = await Promise.all([
    checkMongo(),
    checkRedis(),
    getDiskUsagePercent(),
  ]);

  const ram = getHostRamStats();
  const apiProcess = getApiProcessStats();
  const uptime = getUptimeStats();
  const healthy = mongodb.ok && redis.ok;

  return {
    healthy,
    status: healthy ? "ok" : "degraded",
    checked_at: new Date().toISOString(),
    server_health: {
      ram,
      api_process: apiProcess,
      disk_usage_percentage: diskUsagePercent,
      uptime_days: uptime.uptime_days,
      uptime_seconds: uptime.uptime_seconds,
      uptime_label: uptime.uptime_label,
    },
    services: {
      mongodb,
      redis,
    },
    process: {
      node_version: process.version,
      pid: process.pid,
      env: process.env.NODE_ENV || "development",
      load_average: os.loadavg(),
      cpu_count: os.cpus().length,
    },
  };
};

exports.checkMongoHealth = checkMongo;
exports.checkRedisHealth = checkRedis;

exports.getServerHealthLite = async () => {
  const [mongodb, redis] = await Promise.all([checkMongo(), checkRedis()]);
  return {
    healthy: mongodb.ok && redis.ok,
    mongodb: mongodb.ok,
    redis: redis.ok,
    uptime_seconds: Math.floor(process.uptime()),
  };
};
