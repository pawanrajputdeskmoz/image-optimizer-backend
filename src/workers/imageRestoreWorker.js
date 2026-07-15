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
} = require("../queue/imageRestoreQueues");
const { processImageRestoreJob } = require("./imageRestoreProcessor");
const { appendImageLog } = require("../modules/imageOptimization/services");
const envPath = [path.join(process.cwd(), ".env"), path.join(__dirname, "../.env")].find(
  (p) => fs.existsSync(p)
);
if (envPath) loadEnv({ path: envPath });

const tierFromEnv = resolveTier(
  process.env.IMAGE_RESTORE_QUEUE_TIER || process.env.RESTORE_QUEUE_TIER
);
const listenLegacy =
  String(process.env.IMAGE_RESTORE_LISTEN_LEGACY || "").toLowerCase() === "true";

function tiersToStart() {
  if (tierFromEnv) {
    return [tierFromEnv];
  }
  // Heavy pool is only started on demand by restoreHeavySupervisor.
  return [...STANDARD_TIERS];
}

function resolveWorkerName() {
  if (tierFromEnv === "2") return "image-restore-2";
  if (tierFromEnv === "3") return "image-restore-3";
  if (tierFromEnv === "heavy") return "image-restore-heavy";
  return "image-restore-2";
}

const WORKER_NAME = resolveWorkerName();

const workers = [];
const connections = [];

function attachWorkerEvents(worker, queueName) {
  worker.on("completed", (job) => {
    console.log("[image-restore-worker] completed", {
      queue: queueName,
      jobId: job.id,
      name: job.name,
      jobUuid: job.data?.jobUuid,
      imageId: job.data?.imageId,
      productId: job.data?.productId,
      chunkIndex: job.data?.chunkIndex,
    });
  });

  worker.on("failed", async (job, err) => {
    console.error("[image-restore-worker] failed", {
      queue: queueName,
      jobId: job?.id,
      name: job?.name,
      jobUuid: job?.data?.jobUuid,
      imageId: job?.data?.imageId,
      productId: job?.data?.productId,
      chunkIndex: job?.data?.chunkIndex,
      error: err?.message,
    });

    const data = job?.data;
    if (data?.storeHash && job?.name !== "restore-chunk") {
      await appendImageLog({
        jobUuid: data.jobUuid,
        storeHash: data.storeHash,
        jobType: data.job_type || "restore_bulk",
        imageId: data.imageId,
        productId: data.productId,
        logType: "error",
        step: "worker",
        message: err?.message || "Image restore worker job failed",
        meta: {
          bull_job_id: job?.id,
          attempts_made: job?.attemptsMade,
          queue: queueName,
        },
      });
    }
  });
}

async function startWorkerForTier(tier) {
  const queueName = getQueueNameForTier(tier);
  const connection = createRedisConnection(`bullmq-image-restore-worker-${tier}`);
  const concurrency = getWorkerConcurrencyForTier(tier);

  const worker = new Worker(
    queueName,
    processImageRestoreJob,
    {
    connection,
    concurrency,
  }
  );

  attachWorkerEvents(worker, queueName);
  workers.push(worker);
  connections.push(connection);

  console.log("[image-restore-worker] started", { queue: queueName, tier, concurrency });
}

async function startLegacyWorker() {
  const connection = createRedisConnection("bullmq-image-restore-worker-legacy");
  const worker = new Worker(
    LEGACY_QUEUE_NAME,
    processImageRestoreJob,
    {
    connection,
    concurrency: getWorkerConcurrencyForTier("2"),
  }
  );

  attachWorkerEvents(worker, LEGACY_QUEUE_NAME);
  workers.push(worker);
  connections.push(connection);

  console.log("[image-restore-worker] started legacy drain", {
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
    console.log(`[image-restore-worker] shutting down (${signal})...`);
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all(connections.map((connection) => connection.quit()));
    process.exit(0);
  } catch (err) {
    console.error("[image-restore-worker] shutdown error", err);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startWorker().catch((err) => {
  console.error("[image-restore-worker] start failed", err);
  process.exit(1);
});
