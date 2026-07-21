const { Queue } = require("bullmq");
const { createRedisConnection } = require("../db/redis");

const QUEUE_NAME = "category-image-optimization";
const connection = createRedisConnection("bullmq-category-image-optimization");

const categoryImageQueue = new Queue(QUEUE_NAME, { connection });

async function clearStoreCategoryOptimizationJobs(storeHash) {
  const hash = storeHash != null ? String(storeHash).trim() : "";
  if (!hash) return { removed: 0, jobUuids: [] };

  const jobs = await categoryImageQueue.getJobs(
    ["waiting", "active", "delayed", "failed", "paused"],
    0,
    10_000
  );
  const jobUuids = new Set();
  let removed = 0;

  for (const job of jobs) {
    if (job?.data?.storeHash !== hash) continue;
    if (job.data.jobUuid) jobUuids.add(job.data.jobUuid);

    try {
      await job.remove();
      removed += 1;
    } catch (_) {
      // An active job can be locked until its current worker run finishes.
    }
  }

  return { removed, jobUuids: [...jobUuids] };
}

module.exports = {
  QUEUE_NAME,
  categoryImageQueue,
  clearStoreCategoryOptimizationJobs,
};
