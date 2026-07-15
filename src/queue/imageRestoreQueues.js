const { Queue } = require("bullmq");
const { createRedisConnection } = require("../db/redis");
const appConfig = require("../config");
const { signalHeavyRestoreWorkerNeeded } = require("../utils/elasticHeavyRestoreWorker");
const {
  defaultWorkerJobOptions,
  coordinatorWorkerJobOptions,
} = require("./workerJobOptions");

const TIER_HEAVY = "heavy";
const STANDARD_TIERS = ["2", "3"];

const QUEUE_NAME_BY_TIER = {
  heavy: "image-restore-heavy",
  2: "image-restore-2",
  3: "image-restore-3",
};

/** @deprecated Legacy single queue — drained by tier-2 worker if still in use */
const LEGACY_QUEUE_NAME = "image-restore";

const RESTORE_JOB_OPTIONS = defaultWorkerJobOptions();

const RESTORE_COORDINATOR_JOB_OPTIONS = coordinatorWorkerJobOptions();

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
  if (raw === "image-restore-2" || raw === LEGACY_QUEUE_NAME) return "2";
  if (raw === "image-restore-3" || raw === "image-restore-4") return "3";
  return null;
}

function getQueueNameForTier(tier) {
  const resolved = resolveTier(tier);
  if (!resolved) return null;
  return QUEUE_NAME_BY_TIER[resolved];
}

function getRestoreQueue(tierOrName) {
  const tier = resolveTier(tierOrName);
  if (!tier) {
    throw new Error(`Unknown image restore queue tier: ${tierOrName}`);
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

function pickRestoreQueueTier({
  estimatedImages = 0,
  storeHash = null,
  forceHeavy = false,
} = {}) {
  const count = Number(estimatedImages) || 0;
  const threshold = appConfig.restoreQueues?.heavyThreshold ?? 10_000;

  if (forceHeavy || count >= threshold) {
    return TIER_HEAVY;
  }

  return hashStoreForStandardTier(storeHash);
}

function pickRestoreQueue(options = {}) {
  const tier = pickRestoreQueueTier(options);
  return getRestoreQueue(tier);
}

async function addRestoreJob(jobName, data, options = {}, routing = {}) {
  const tier = pickRestoreQueueTier({
    estimatedImages: routing.estimatedImages ?? routing.imageCount ?? 0,
    storeHash: routing.storeHash ?? data?.storeHash ?? null,
    forceHeavy: Boolean(routing.forceHeavy),
  });
  const queue = getRestoreQueue(tier);
  const queueName = QUEUE_NAME_BY_TIER[tier];

  const defaultOptions =
    jobName === "restore-bulk-coordinator"
      ? RESTORE_COORDINATOR_JOB_OPTIONS
      : RESTORE_JOB_OPTIONS;

  const dedupJobId =
    options.jobId ??
    (jobName === "restore-image" && data?.storeHash && data?.productId != null && data?.imageId != null
      ? `restore-${data.storeHash}-${data.productId}-${data.imageId}`
      : null);
  const hasDedupId = Boolean(dedupJobId);

  if (hasDedupId) {
    const existing = await queue.getJob(dedupJobId);
    if (existing) {
      const state = await existing.getState();
      if (
        state === "waiting" ||
        state === "delayed" ||
        state === "active" ||
        state === "paused"
      ) {
        return { bullJob: existing, tier, queueName, duplicate: true };
      }
    }
  }

  const bullJob = await queue.add(jobName, data, {
    ...defaultOptions,
    ...options,
    ...(hasDedupId ? { jobId: dedupJobId } : {}),
  });

  if (tier === TIER_HEAVY && routing.suppressHeavyWake !== true) {
    await signalHeavyRestoreWorkerNeeded();
  }

  return { bullJob, tier, queueName, duplicate: false };
}

function listRestoreQueueNames() {
  return [
    QUEUE_NAME_BY_TIER.heavy,
    QUEUE_NAME_BY_TIER[2],
    QUEUE_NAME_BY_TIER[3],
    LEGACY_QUEUE_NAME,
  ];
}

function getWorkerConcurrencyForTier(tier) {
  const resolved = resolveTier(tier);
  if (resolved === TIER_HEAVY) {
    return appConfig.workers.restoreHeavyConcurrency;
  }
  return appConfig.workers.restoreStandardConcurrency;
}

module.exports = {
  TIER_HEAVY,
  STANDARD_TIERS,
  QUEUE_NAME_BY_TIER,
  LEGACY_QUEUE_NAME,
  RESTORE_JOB_OPTIONS,
  RESTORE_COORDINATOR_JOB_OPTIONS,
  hashStoreForStandardTier,
  resolveTier,
  getQueueNameForTier,
  getRestoreQueue,
  pickRestoreQueueTier,
  pickRestoreQueue,
  addRestoreJob,
  listRestoreQueueNames,
  getWorkerConcurrencyForTier,
};
