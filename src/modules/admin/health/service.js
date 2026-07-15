const os = require("node:os");
const fs = require("node:fs/promises");
const mongoose = require("mongoose");
const { getRedis } = require("../../../db/redis");
const { withTimeout } = require("../../../utils/withTimeout");
const ImageJobItem = require("../../../models/ImageJobItem");
const { fetchAllQueueStatsSafe } = require("../workers/service");

const QUEUE_BACKLOG_HIGH_THRESHOLD = 50;
const RAM_HIGH_THRESHOLD = 85;
const WORKER_STALE_WAITING_THRESHOLD = 10;
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

async function buildRecentAlerts({
  mongodb,
  redis,
  queueStats,
  ramPercentage,
  stuckOptimizingItems,
  limit = 10,
}) {
  const alerts = [];

  if (!mongodb.ok) {
    alerts.push({
      message: "Database connection failed",
      severity: "high",
      source: "database",
    });
  }

  if (!redis.ok) {
    alerts.push({
      message: "Redis connection failed",
      severity: "high",
      source: "redis",
    });
  }

  let totalPending = 0;
  let workerNotResponding = false;

  for (const row of queueStats) {
    if (!row.counts) continue;
    const waiting = row.counts.waiting || 0;
    const delayed = row.counts.delayed || 0;
    const active = row.counts.active || 0;
    const pending = waiting + delayed;
    totalPending += pending;

    if (
      !row.legacy &&
      pending >= WORKER_STALE_WAITING_THRESHOLD &&
      active === 0
    ) {
      workerNotResponding = true;
    }
  }

  if (workerNotResponding) {
    alerts.push({
      message: "Worker not responding",
      severity: "high",
      source: "workers",
    });
  }

  if (totalPending >= QUEUE_BACKLOG_HIGH_THRESHOLD) {
    alerts.push({
      message: "Queue backlog high",
      severity: "medium",
      source: "queues",
    });
  }

  if (ramPercentage >= RAM_HIGH_THRESHOLD) {
    alerts.push({
      message: "System RAM usage high",
      severity: "medium",
      source: "ram",
    });
  }

  if (stuckOptimizingItems > 0) {
    alerts.push({
      message: `${stuckOptimizingItems} image(s) stuck in optimizing state`,
      severity: "medium",
      source: "image_jobs",
    });
  }

  const resolvedLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  return alerts.slice(0, resolvedLimit);
}

async function collectAlertInputs() {
  const [mongodb, redis, stuckOptimizingItems] = await Promise.all([
    checkMongo(),
    checkRedis(),
    ImageJobItem.countDocuments({ status: "optimizing" }),
  ]);

  const queueStats = redis.ok ? await fetchAllQueueStatsSafe() : [];

  return {
    mongodb,
    redis,
    queueStats,
    ramPercentage: getHostRamStats().percentage,
    stuckOptimizingItems,
  };
}

exports.getRecentAlerts = async (limit = 10) => {
  const inputs = await collectAlertInputs();
  const recentAlerts = await buildRecentAlerts({ ...inputs, limit });
  const hasHighSeverity = recentAlerts.some((a) => a.severity === "high");

  return {
    status: hasHighSeverity ? "degraded" : "ok",
    checked_at: new Date().toISOString(),
    recent_alerts: recentAlerts,
    count: recentAlerts.length,
    limit: Math.min(Math.max(Number(limit) || 10, 1), 50),
  };
};

exports.getServerHealth = async () => {
  const [inputs, diskUsagePercent] = await Promise.all([
    collectAlertInputs(),
    getDiskUsagePercent(),
  ]);

  const { mongodb, redis } = inputs;
  const ram = getHostRamStats();
  const apiProcess = getApiProcessStats();
  const uptime = getUptimeStats();
  const healthy = mongodb.ok && redis.ok;

  const recentAlerts = await buildRecentAlerts({
    ...inputs,
    ramPercentage: ram.percentage,
  });

  return {
    healthy,
    status: healthy && recentAlerts.every((a) => a.severity !== "high")
      ? "ok"
      : "degraded",
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
    recent_alerts: recentAlerts,
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
