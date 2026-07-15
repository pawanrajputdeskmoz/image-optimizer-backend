const { Queue } = require("bullmq");
const { createRedisConnection } = require("../db/redis");
const appConfig = require("../config");
const { signalHeavyWorkerNeeded } = require("../utils/elasticHeavyOptimizationWorker");
const {
  defaultWorkerJobOptions,
} = require("./workerJobOptions");
const { appendImageLog } = require("../modules/imageOptimization/utils/imageActivityLog");

const TIER_HEAVY = "heavy";
const STANDARD_TIERS = ["2", "3"];

const QUEUE_NAME_BY_TIER = {
  heavy: "image-optimization-heavy",
  2: "image-optimization-2",
  3: "image-optimization-3",
};

/** @deprecated Legacy single queue — drained by tier-2 worker if still in use */
const LEGACY_QUEUE_NAME = "image-optimization";

const OPTIMIZE_IMAGE_JOB_OPTIONS = defaultWorkerJobOptions();

const OPTIMIZE_BATCH_JOB_OPTIONS = defaultWorkerJobOptions();

const queueCache = new Map();

function hashStoreForStandardTier(storeHash) {
  const s = String(storeHash || "");
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return STANDARD_TIERS[h % STANDARD_TIERS.length];
}

function resolveTier(tierOrName) {
  const raw = String(tierOrName || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === TIER_HEAVY || raw === QUEUE_NAME_BY_TIER.heavy) return TIER_HEAVY;
  if (STANDARD_TIERS.includes(raw)) return raw;
  if (raw === "image-optimization-2" || raw === LEGACY_QUEUE_NAME) return "2";
  if (raw === "image-optimization-3" || raw === "image-optimization-4") return "3";
  return null;
}

function getQueueNameForTier(tier) {
  const resolved = resolveTier(tier);
  if (!resolved) return null;
  return QUEUE_NAME_BY_TIER[resolved];
}

function getOptimizationQueue(tierOrName) {
  const tier = resolveTier(tierOrName);
  if (!tier) {
    throw new Error(`Unknown image optimization queue tier: ${tierOrName}`);
  }

  if (queueCache.has(tier)) {
    return queueCache.get(tier);
  }

  const queueName = QUEUE_NAME_BY_TIER[tier];
  const connection = createRedisConnection(`bullmq-${queueName}`);
  const queue = new Queue(queueName, { connection });
  queueCache.set(tier, queue);
  return queue;
}

/**
 * Route jobs to heavy vs standard pools so large bulk jobs do not block small stores.
 */
function pickOptimizationQueueTier({
  estimatedImages = 0,
  storeHash = null,
  forceHeavy = false,
} = {}) {
  const count = Number(estimatedImages) || 0;
  const threshold = appConfig.optimizationQueues?.heavyThreshold ?? 10_000;

  if (forceHeavy || count >= threshold) {
    return TIER_HEAVY;
  }

  return hashStoreForStandardTier(storeHash);
}

function pickOptimizationQueue(options = {}) {
  const tier = pickOptimizationQueueTier(options);
  return getOptimizationQueue(tier);
}

function isPendingQueueState(state) {
  return state === "waiting" || state === "delayed" || state === "active" || state === "paused";
}

async function addOptimizationJob(
  jobName,
  data,
  options = {},
  routing = {}
) {
  const tier = pickOptimizationQueueTier({
    estimatedImages: routing.estimatedImages ?? routing.imageCount ?? 0,
    storeHash: routing.storeHash ?? data?.storeHash ?? null,
    forceHeavy: Boolean(routing.forceHeavy),
  });
  const queue = getOptimizationQueue(tier);
  const queueName = QUEUE_NAME_BY_TIER[tier];
  const dedupJobId =
    options.jobId ??
    (jobName === "optimize-image"
      ? `opt-${data?.storeHash}-${data?.productId}-${data?.imageId}`
      : null);
  const hasDedupId =
    dedupJobId &&
    data?.storeHash &&
    data?.productId != null &&
    data?.imageId != null;

  if (hasDedupId) {
    const existing = await queue.getJob(dedupJobId);
    if (existing) {
      const state = await existing.getState();
      if (isPendingQueueState(state)) {
        console.log("[addOptimizationJob] duplicate skipped", {
          dedupJobId,
          queue: queueName,
          tier,
          state,
          storeHash: data?.storeHash,
          productId: data?.productId,
          imageId: data?.imageId,
          jobUuid: data?.jobUuid,
        });
        if (data?.storeHash) {
          await appendImageLog({
            jobUuid: data.jobUuid,
            storeHash: data.storeHash,
            jobType: data.job_type || data.type || "bulk",
            imageId: data.imageId,
            productId: data.productId,
            logType: "warning",
            step: "redis_duplicate",
            message: "Redis job already pending — duplicate skipped",
            meta: {
              seq: 2,
              dedup_job_id: dedupJobId,
              queue: queueName,
              tier,
              state,
              bull_job_id: existing.id,
            },
          });
        }
        return { bullJob: existing, tier, queueName, duplicate: true };
      }
      // failed/completed jobs keep the same id and block re-queue — remove then add
      try {
        await existing.remove();
      } catch (_) {
        /* ignore remove races */
      }
    }
  }

  const bullJob = await queue.add(jobName, data, {
    ...OPTIMIZE_IMAGE_JOB_OPTIONS,
    ...options,
    ...(hasDedupId ? { jobId: dedupJobId } : {}),
  });

  if (tier === TIER_HEAVY && routing.suppressHeavyWake !== true) {
    await signalHeavyWorkerNeeded();
  }

  console.log("[addOptimizationJob] queued", {
    jobName,
    bullJobId: bullJob?.id,
    dedupJobId: hasDedupId ? dedupJobId : null,
    queue: queueName,
    tier,
    storeHash: data?.storeHash,
    productId: data?.productId,
    imageId: data?.imageId,
    jobUuid: data?.jobUuid,
  });

  if (data?.storeHash) {
    await appendImageLog({
      jobUuid: data.jobUuid,
      storeHash: data.storeHash,
      jobType: data.job_type || data.type || "bulk",
      imageId: data.imageId,
      productId: data.productId,
      logType: "info",
      step: "redis_queued",
      message: "Image added to Redis optimization queue",
      meta: {
        seq: 2,
        job_name: jobName,
        bull_job_id: bullJob?.id,
        dedup_job_id: hasDedupId ? dedupJobId : null,
        queue: queueName,
        tier,
      },
    });
  }

  return { bullJob, tier, queueName, duplicate: false };
}

/**
 * Enqueue one batch of images (worker loads items from MongoDB by jobUuid + batchIndex).
 */
async function addOptimizationBatchJob(data, options = {}, routing = {}) {
  const tier = pickOptimizationQueueTier({
    estimatedImages: routing.estimatedImages ?? routing.imageCount ?? 0,
    storeHash: routing.storeHash ?? data?.storeHash ?? null,
    forceHeavy: Boolean(routing.forceHeavy),
  });
  const queue = getOptimizationQueue(tier);
  const queueName = QUEUE_NAME_BY_TIER[tier];
  const jobUuid = data?.jobUuid;
  const batchIndex = data?.batchIndex;
  const dedupJobId =
    options.jobId ??
    (jobUuid != null && batchIndex != null
      ? `opt-batch-${jobUuid}-${batchIndex}`
      : null);
  const hasDedupId = Boolean(dedupJobId && jobUuid != null && batchIndex != null);

  if (hasDedupId) {
    const existing = await queue.getJob(dedupJobId);
    if (existing) {
      const state = await existing.getState();
      if (isPendingQueueState(state)) {
        return { bullJob: existing, tier, queueName, duplicate: true };
      }
    }
  }

  const bullJob = await queue.add("optimize-batch", data, {
    ...OPTIMIZE_BATCH_JOB_OPTIONS,
    ...options,
    ...(hasDedupId ? { jobId: dedupJobId } : {}),
  });

  if (tier === TIER_HEAVY && routing.suppressHeavyWake !== true) {
    await signalHeavyWorkerNeeded();
  }

  return { bullJob, tier, queueName, duplicate: false };
}

function listOptimizationQueueNames() {
  return [
    QUEUE_NAME_BY_TIER.heavy,
    QUEUE_NAME_BY_TIER[2],
    QUEUE_NAME_BY_TIER[3],
    LEGACY_QUEUE_NAME,
  ];
}

/**
 * Remove BullMQ optimization jobs for one store only (waiting/active/delayed/failed).
 * Used when monthly quota is exhausted so failed dedup ids do not block re-queue.
 */
async function clearStoreOptimizationJobs(storeHash) {
  const hash = storeHash != null ? String(storeHash).trim() : "";
  if (!hash) return { removed: 0 };

  let removed = 0;
  const tiers = [TIER_HEAVY, ...STANDARD_TIERS];
  const states = ["waiting", "active", "delayed", "failed", "paused"];

  for (const tier of tiers) {
    const queue = getOptimizationQueue(tier);
    const jobs = await queue.getJobs(states, 0, 10_000);
    for (const job of jobs) {
      if (job?.data?.storeHash !== hash) continue;
      try {
        await job.remove();
        removed += 1;
      } catch (_) {
        /* active job may be locked by this worker — ignore */
      }
    }
  }

  if (removed > 0) {
    console.log("[clearStoreOptimizationJobs]", { storeHash: hash, removed });
    await appendImageLog({
      jobUuid: `quota-clear:${hash}`,
      storeHash: hash,
      jobType: "bulk",
      logType: "warning",
      step: "redis_cleared",
      message: `Cleared ${removed} Redis optimization job(s) for store after plan limit`,
      meta: { seq: 8, removed, queues: tiers },
    });
  }

  return { removed };
}

function getWorkerConcurrencyForTier(tier) {
  const resolved = resolveTier(tier);
  if (resolved === TIER_HEAVY) {
    return appConfig.workers.optimizationHeavyConcurrency;
  }
  return appConfig.workers.optimizationStandardConcurrency;
}

module.exports = {
  TIER_HEAVY,
  STANDARD_TIERS,
  QUEUE_NAME_BY_TIER,
  LEGACY_QUEUE_NAME,
  OPTIMIZE_IMAGE_JOB_OPTIONS,
  OPTIMIZE_BATCH_JOB_OPTIONS,
  hashStoreForStandardTier,
  resolveTier,
  getQueueNameForTier,
  getOptimizationQueue,
  pickOptimizationQueueTier,
  pickOptimizationQueue,
  addOptimizationJob,
  addOptimizationBatchJob,
  clearStoreOptimizationJobs,
  listOptimizationQueueNames,
  getWorkerConcurrencyForTier,
};
