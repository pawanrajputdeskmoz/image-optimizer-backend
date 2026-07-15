const { Queue } = require("bullmq");
const { createRedisConnection, getRedis } = require("../../../db/redis");
const { withTimeout } = require("../../../utils/withTimeout");

const REDIS_PING_TIMEOUT_MS = 3000;
const QUEUE_STAT_TIMEOUT_MS = 4000;
const QUEUE_STATS_TOTAL_TIMEOUT_MS = 12000;
const WORKER_STALE_WAITING_THRESHOLD = 10;

const WORKER_STATUSES = ["running", "stopped", "warn", "at_risk"];

const WORKER_QUEUES = [
  { name: "catalog-fetch", category: "catalog" },
  { name: "image-optimization-heavy", category: "product_optimization" },
  { name: "image-optimization-2", category: "product_optimization" },
  { name: "image-optimization-3", category: "product_optimization" },
  { name: "image-optimization", category: "product_optimization", legacy: true },
  { name: "image-restore-heavy", category: "product_restore" },
  { name: "image-restore-2", category: "product_restore" },
  { name: "image-restore-3", category: "product_restore" },
  { name: "image-restore", category: "product_restore", legacy: true },
  { name: "category-image-optimization", category: "category" },
  { name: "category-image-restore", category: "category" },
  { name: "brand-image-optimization", category: "brand" },
  { name: "brand-image-restore", category: "brand" },
];

let queueConnection = null;

function getQueueConnection() {
  if (!queueConnection) {
    queueConnection = createRedisConnection("admin-queue-inspector");
  }
  return queueConnection;
}

async function isRedisReachable() {
  try {
    const pong = await withTimeout(
      getRedis().ping(),
      REDIS_PING_TIMEOUT_MS,
      "Redis ping"
    );
    return pong === "PONG";
  } catch {
    return false;
  }
}

async function readQueueStats(queueMeta) {
  const queue = new Queue(queueMeta.name, { connection: getQueueConnection() });
  try {
    const [counts, isPaused, workersCount] = await Promise.all([
      queue.getJobCounts(
        "waiting",
        "active",
        "completed",
        "failed",
        "delayed",
        "paused"
      ),
      queue.isPaused(),
      queue.getWorkersCount().catch(() => 0),
    ]);

    const backlog =
      (counts.waiting || 0) +
      (counts.active || 0) +
      (counts.delayed || 0) +
      (counts.paused || 0);

    const workerStatus = classifyQueueWorkerStatus({
      legacy: Boolean(queueMeta.legacy),
      workersCount: Number(workersCount) || 0,
      counts,
      paused: isPaused,
    });

    return {
      queue: queueMeta.name,
      category: queueMeta.category,
      legacy: Boolean(queueMeta.legacy),
      paused: isPaused,
      workers_count: Number(workersCount) || 0,
      worker_status: workerStatus,
      counts,
      backlog,
      healthy:
        workerStatus === "running" &&
        ((counts.failed || 0) === 0 || backlog > 0),
    };
  } finally {
    try {
      await withTimeout(queue.close(), 2000, `Close queue ${queueMeta.name}`);
    } catch {
      // ignore close timeout when Redis is down
    }
  }
}

async function getQueueStats(queueMeta) {
  return withTimeout(
    readQueueStats(queueMeta),
    QUEUE_STAT_TIMEOUT_MS,
    `Queue stats ${queueMeta.name}`
  );
}

function classifyQueueWorkerStatus({ legacy, workersCount, counts, paused }) {
  if (legacy) return null;

  const active = counts?.active || 0;
  const waiting = counts?.waiting || 0;
  const delayed = counts?.delayed || 0;
  const failed = counts?.failed || 0;
  const backlog = waiting + delayed;

  if (workersCount <= 0) {
    return backlog > 0 ? "at_risk" : "stopped";
  }

  if (paused) {
    return backlog > 0 ? "at_risk" : "warn";
  }

  if (backlog >= WORKER_STALE_WAITING_THRESHOLD && active === 0) {
    return "at_risk";
  }

  if (failed > 0 && backlog > 0) {
    return "warn";
  }

  return "running";
}

function buildWorkerStatusSummary(queueStats) {
  const activeQueues = queueStats.filter((row) => !row.legacy && row.counts);
  const statusCounts = {
    running: 0,
    stopped: 0,
    warn: 0,
    at_risk: 0,
  };

  let pendingJobs = 0;
  let failedJobs = 0;
  let activeJobs = 0;

  const queues = activeQueues.map((row) => {
    const status = row.worker_status || "stopped";
    if (WORKER_STATUSES.includes(status)) {
      statusCounts[status] += 1;
    }

    const waiting = row.counts?.waiting || 0;
    const delayed = row.counts?.delayed || 0;
    const failed = row.counts?.failed || 0;
    const active = row.counts?.active || 0;

    pendingJobs += waiting + delayed;
    failedJobs += failed;
    activeJobs += active;

    return {
      queue: row.queue,
      category: row.category,
      status,
      workers_count: row.workers_count || 0,
      backlog: row.backlog || 0,
      npm_script_hint: resolveWorkerScriptHint(row.queue),
    };
  });

  const totalWorkers = activeQueues.length;
  const atRiskCount = statusCounts.warn + statusCounts.at_risk;

  return {
    total_workers: totalWorkers,
    running: statusCounts.running,
    stopped: statusCounts.stopped,
    warn: statusCounts.warn,
    at_risk: statusCounts.at_risk,
    pending_jobs: pendingJobs,
    failed_jobs: failedJobs,
    active_jobs: activeJobs,
    summary_label: `${statusCounts.running} running, ${statusCounts.stopped} stopped, ${atRiskCount} at risk`,
    queues,
  };
}

function resolveWorkerScriptHint(queueName) {
  const map = {
    "catalog-fetch": "worker:catalog-fetch",
    "image-optimization-heavy": "worker:image-optimization-heavy",
    "image-optimization-2": "worker:image-optimization-2",
    "image-optimization-3": "worker:image-optimization-3",
    "image-restore-heavy": "worker:image-restore-heavy",
    "image-restore-2": "worker:image-restore-2",
    "image-restore-3": "worker:image-restore-3",
    "category-image-optimization": "worker:category-image",
    "category-image-restore": "worker:category-image-restore",
    "brand-image-optimization": "worker:brand-image",
    "brand-image-restore": "worker:brand-image-restore",
  };
  return map[queueName] || null;
}

exports.getWorkersOverview = async () => {
  const queueStats = await Promise.all(
    WORKER_QUEUES.map((meta) =>
      getQueueStats(meta).catch((err) => ({
        queue: meta.name,
        category: meta.category,
        legacy: Boolean(meta.legacy),
        error: err?.message || "Failed to read queue stats",
        counts: null,
        backlog: null,
        healthy: false,
      }))
    )
  );

  const totals = queueStats.reduce(
    (acc, row) => {
      if (!row.counts) return acc;
      acc.waiting += row.counts.waiting || 0;
      acc.active += row.counts.active || 0;
      acc.failed += row.counts.failed || 0;
      acc.delayed += row.counts.delayed || 0;
      acc.backlog += row.backlog || 0;
      return acc;
    },
    { waiting: 0, active: 0, failed: 0, delayed: 0, backlog: 0 }
  );

  let redisOk = false;
  try {
    redisOk = await isRedisReachable();
  } catch {
    redisOk = false;
  }

  return {
    redis_connected: redisOk,
    totals,
    queues: queueStats,
    worker_processes: WORKER_QUEUES.filter((q) => !q.legacy).map((q) => ({
      queue: q.name,
      category: q.category,
      npm_script_hint: resolveWorkerScriptHint(q.name),
    })),
  };
};

exports.getQueueDetail = async (queueName) => {
  const meta = WORKER_QUEUES.find((q) => q.name === queueName);
  if (!meta) {
    return { error: "Queue not found", queue: null };
  }

  const stats = await getQueueStats(meta);
  return { error: null, queue: stats };
};

exports.listKnownQueues = () => WORKER_QUEUES.map((q) => q.name);

exports.fetchAllQueueStats = async () => {
  return Promise.all(
    WORKER_QUEUES.map((meta) =>
      getQueueStats(meta).catch((err) => ({
        queue: meta.name,
        category: meta.category,
        legacy: Boolean(meta.legacy),
        error: err?.message || "Failed to read queue stats",
        counts: null,
        backlog: null,
        healthy: false,
      }))
    )
  );
};

exports.fetchAllQueueStatsSafe = async () => {
  if (!(await isRedisReachable())) {
    return [];
  }

  try {
    return await withTimeout(
      exports.fetchAllQueueStats(),
      QUEUE_STATS_TOTAL_TIMEOUT_MS,
      "Queue stats"
    );
  } catch {
    return [];
  }
};

exports.isRedisReachable = isRedisReachable;

exports.getWorkerStatusSummary = async () => {
  const queueStats = await exports.fetchAllQueueStatsSafe();
  return buildWorkerStatusSummary(queueStats);
};

exports.getWorkerQueueDefinitions = () => WORKER_QUEUES;
