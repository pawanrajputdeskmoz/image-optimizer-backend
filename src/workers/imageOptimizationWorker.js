const path = require("node:path");
const fs = require("node:fs");
const { config: loadEnv } = require("dotenv");
const { Worker } = require("bullmq");
const { createRedisConnection } = require("../db/redis");
const { connectMongo } = require("../db/mongo");
const {
  resolveTier,
  getQueueNameForTier,
  getWorkerConcurrencyForTier,
  LEGACY_QUEUE_NAME,
  STANDARD_TIERS,
} = require("../queue/imageOptimizationQueues");
const { processImageOptimizationJob } = require("./imageOptimizationProcessor");
const { appendImageLog } = require("../modules/imageOptimization/services");
const envPath = [path.join(process.cwd(), ".env"), path.join(__dirname, "../.env")].find(
  (p) => fs.existsSync(p)
);
if (envPath) loadEnv({ path: envPath });

const tierFromEnv = resolveTier(
  process.env.IMAGE_OPTIMIZATION_QUEUE_TIER || process.env.OPTIMIZATION_QUEUE_TIER
);
const listenLegacy =
  String(process.env.IMAGE_OPTIMIZATION_LISTEN_LEGACY || "").toLowerCase() ===
  "true";

function tiersToStart() {
  if (tierFromEnv) {
    return [tierFromEnv];
  }
  // Heavy pool is only started on demand by optimizationHeavySupervisor.
  return [...STANDARD_TIERS];
}

function resolveWorkerName() {
  if (tierFromEnv === "2") return "image-optimization-2";
  if (tierFromEnv === "3") return "image-optimization-3";
  if (tierFromEnv === "heavy") return "image-optimization-heavy";
  return "image-optimization-2";
}

const WORKER_NAME = resolveWorkerName();

const workers = [];
const connections = [];

function attachWorkerEvents(worker, queueName) {
  worker.on("completed", (job) => {
    console.log("[image-optimization-worker] completed", {
      queue: queueName,
      jobId: job.id,
      jobUuid: job.data?.jobUuid,
      imageId: job.data?.imageId,
      productId: job.data?.productId,
    });
  });

  worker.on("failed", async (job, err) => {
    console.error("[image-optimization-worker] failed", {
      queue: queueName,
      jobId: job?.id,
      jobUuid: job?.data?.jobUuid,
      imageId: job?.data?.imageId,
      productId: job?.data?.productId,
      error: err?.message,
    });

    const data = job?.data;
    if (data?.storeHash) {
      await appendImageLog({
        jobUuid: data.jobUuid || data.job_uuid,
        storeHash: data.storeHash,
        jobType: data.job_type || data.type || "bulk",
        imageId: data.imageId,
        productId: data.productId,
        logType: "error",
        step: "worker_failed",
        message: err?.message || "Image optimization worker job failed",
        meta: {
          seq: 7,
          bull_job_id: job?.id,
          attempts_made: job?.attemptsMade,
          queue: queueName,
          source: "bullmq_failed_event",
        },
      });
    }
  });
}

async function startWorkerForTier(tier) {
  const queueName = getQueueNameForTier(tier);
  const connection = createRedisConnection(`bullmq-image-optimization-worker-${tier}`);
  const concurrency = getWorkerConcurrencyForTier(tier);

  const worker = new Worker(
    queueName,
    processImageOptimizationJob,
    {
    connection,
    concurrency,
  }
  );

  attachWorkerEvents(worker, queueName);
  workers.push(worker);
  connections.push(connection);

  console.log("[image-optimization-worker] started", { queue: queueName, tier, concurrency });
}

async function startLegacyWorker() {
  const connection = createRedisConnection("bullmq-image-optimization-worker-legacy");
  const worker = new Worker(
    LEGACY_QUEUE_NAME,
    processImageOptimizationJob,
    {
    connection,
    concurrency: getWorkerConcurrencyForTier("2"),
  }
  );

  attachWorkerEvents(worker, LEGACY_QUEUE_NAME);
  workers.push(worker);
  connections.push(connection);

  console.log("[image-optimization-worker] started legacy drain", {
    queue: LEGACY_QUEUE_NAME,
  });
}

async function startWorker() {
  await connectMongo();
  const tiers = tiersToStart();
  for (const tier of tiers) {
    await startWorkerForTier(tier);
  }

  if (listenLegacy) {
    await startLegacyWorker();
  }
}

async function shutdown(signal) {
  try {
    console.log(`[image-optimization-worker] shutting down (${signal})...`);
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all(connections.map((connection) => connection.quit()));
    process.exit(0);
  } catch (err) {
    console.error("[image-optimization-worker] shutdown error", err);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startWorker().catch((err) => {
  console.error("[image-optimization-worker] start failed", err);
  process.exit(1);
});
