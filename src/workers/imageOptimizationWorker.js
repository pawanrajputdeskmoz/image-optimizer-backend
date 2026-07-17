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
  getOptimizationQueue,
  addOptimizationBatchJob,
  LEGACY_QUEUE_NAME,
  STANDARD_TIERS,
  TIER_HEAVY,
} = require("../queue/imageOptimizationQueues");
const { processImageOptimizationJob } = require("./imageOptimizationProcessor");
const { appendImageLog } = require("../modules/imageOptimization/services");
const ImageJob = require("../models/ImageJob");
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

/** Max automatic re-dispatches for a permanently failed batch before the whole
 *  job is marked failed (so the client can re-run it from the dashboard). */
const MAX_BATCH_REDISPATCHES = 2;
const HEAVY_QUEUE_NAME = getQueueNameForTier(TIER_HEAVY);

/**
 * Resume a permanently failed optimize-batch job. Batch state lives in Mongo
 * (ImageJobItem), so re-dispatching the same jobUuid+batchIndex safely
 * continues where it stopped. Returns true when a re-dispatch happened.
 */
async function resumeFailedBatchJob(data, { queueName, reason }) {
  const jobUuid = data?.jobUuid;
  if (!jobUuid || data?.batchIndex == null || !data?.storeHash) return false;

  const job = await ImageJob.findOne({ job_uuid: jobUuid })
    .select({ status: 1 })
    .lean();
  if (!job || job.status !== "processing") return false;

  const redispatchCount = Number(data.batchRedispatchCount) || 0;

  if (redispatchCount >= MAX_BATCH_REDISPATCHES) {
    await ImageJob.updateOne(
      { job_uuid: jobUuid, status: "processing" },
      { $set: { status: "failed", completed_at: new Date() } }
    );
    await appendImageLog({
      jobUuid,
      storeHash: data.storeHash,
      jobType: data.job_type || "bulk",
      logType: "error",
      step: "worker_failed",
      message: `Batch ${data.batchIndex} failed after ${redispatchCount} automatic resume attempts — job marked failed. Re-run optimization to continue (already optimized images are skipped).`,
      meta: { batch_index: data.batchIndex, reason: reason || null },
    });
    console.error("[image-optimization-worker] batch resume limit reached — job marked failed", {
      jobUuid,
      batchIndex: data.batchIndex,
    });
    return false;
  }

  const { duplicate } = await addOptimizationBatchJob(
    { ...data, batchRedispatchCount: redispatchCount + 1 },
    {},
    {
      storeHash: data.storeHash,
      forceHeavy: queueName === HEAVY_QUEUE_NAME,
    }
  );

  if (!duplicate) {
    await appendImageLog({
      jobUuid,
      storeHash: data.storeHash,
      jobType: data.job_type || "bulk",
      logType: "warning",
      step: "queue",
      message: `Batch ${data.batchIndex} failed and was automatically re-queued (resume ${redispatchCount + 1}/${MAX_BATCH_REDISPATCHES})`,
      meta: { batch_index: data.batchIndex, reason: reason || null },
    });
    console.log("[image-optimization-worker] failed batch re-queued", {
      jobUuid,
      batchIndex: data.batchIndex,
      resume: redispatchCount + 1,
    });
  }

  return !duplicate;
}

/**
 * Safety net for failures missed by the "failed" event (e.g. worker was down
 * when the batch failed): requeue failed optimize-batch jobs whose ImageJob is
 * still "processing". Runs only in the tier-2 worker to avoid duplicates.
 */
async function sweepFailedBatchJobs() {
  for (const tier of [...STANDARD_TIERS, TIER_HEAVY]) {
    try {
      const queue = getOptimizationQueue(tier);
      const failedJobs = await queue.getFailed(0, 49);
      for (const failedJob of failedJobs) {
        if (failedJob?.name !== "optimize-batch") continue;
        await resumeFailedBatchJob(failedJob.data, {
          queueName: getQueueNameForTier(tier),
          reason: failedJob.failedReason,
        });
      }
    } catch (err) {
      console.error("[image-optimization-worker] failed-batch sweep error", {
        tier,
        error: err?.message,
      });
    }
  }
}

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

    // Batch chain repair: a permanently failed optimize-batch would otherwise
    // strand the whole job (next batch is only dispatched on completion).
    if (job?.name === "optimize-batch") {
      try {
        const state = await job.getState();
        if (state === "failed") {
          await resumeFailedBatchJob(job.data, {
            queueName,
            reason: err?.message,
          });
        }
      } catch (resumeErr) {
        console.error("[image-optimization-worker] batch resume error", {
          jobUuid: job?.data?.jobUuid,
          batchIndex: job?.data?.batchIndex,
          error: resumeErr?.message,
        });
      }
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
    // Long-running batch jobs: tolerate a few missed lock renewals instead of
    // permanently failing with "job stalled more than allowable limit".
    lockDuration: 60_000,
    maxStalledCount: 3,
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
    lockDuration: 60_000,
    maxStalledCount: 3,
  }
  );

  attachWorkerEvents(worker, LEGACY_QUEUE_NAME);
  workers.push(worker);
  connections.push(connection);

  console.log("[image-optimization-worker] started legacy drain", {
    queue: LEGACY_QUEUE_NAME,
  });
}

let sweepTimer = null;

async function startWorker() {
  await connectMongo();
  const tiers = tiersToStart();
  for (const tier of tiers) {
    await startWorkerForTier(tier);
  }

  if (listenLegacy) {
    await startLegacyWorker();
  }

  // Single sweeper owner: only the process running tier 2 (standard workers
  // start tiers 2+3 together; a dedicated tier-3/heavy process skips this).
  if (tiers.includes("2")) {
    sweepTimer = setInterval(() => {
      sweepFailedBatchJobs().catch((err) => {
        console.error("[image-optimization-worker] sweep error", err?.message);
      });
    }, 5 * 60 * 1000);
    // First pass shortly after boot so a stuck job resumes without waiting.
    setTimeout(() => {
      sweepFailedBatchJobs().catch((err) => {
        console.error("[image-optimization-worker] sweep error", err?.message);
      });
    }, 15_000);
  }
}

async function shutdown(signal) {
  try {
    console.log(`[image-optimization-worker] shutting down (${signal})...`);
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
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
