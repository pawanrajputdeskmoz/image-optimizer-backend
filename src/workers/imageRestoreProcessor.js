const { getJobAttempts } = require("../queue/workerJobOptions");
const {
  processBulkRestoreFromStore,
  processRestoreChunkJob,
  runRestoreImageJob,
} = require("../modules/imageOptimization/services");

async function processImageRestoreJob(job) {
  if (job.name === "restore-bulk-coordinator") {
    const result = await processBulkRestoreFromStore({
      jobUuid: job.data?.jobUuid,
      storeHash: job.data?.storeHash,
      storeUrl: job.data?.storeUrl,
      accessToken: job.data?.accessToken,
      jobType: job.data?.job_type || "restore_bulk",
    });
    console.log("[image-restore-worker] restore-bulk-coordinator", {
      jobUuid: job.data?.jobUuid,
      totalImages: result?.totalImages,
      queuedImages: result?.queuedImages,
      skippedImages: result?.skippedImages,
      chunks: result?.chunks,
    });
    return result;
  }

  if (job.name === "restore-chunk") {
    const result = await processRestoreChunkJob({
      jobUuid: job.data?.jobUuid,
      jobType: job.data?.job_type || "restore_bulk",
      storeHash: job.data?.storeHash,
      storeUrl: job.data?.storeUrl,
      accessToken: job.data?.accessToken,
      items: job.data?.items || [],
      maxAttempts: job.opts?.attempts || getJobAttempts(),
      attemptsMade: job.attemptsMade,
    });
    console.log("[image-restore-worker] restore-chunk", {
      jobUuid: job.data?.jobUuid,
      chunkIndex: job.data?.chunkIndex,
      ...result,
    });
    return result;
  }

  const {
    jobUuid,
    job_type: jobTypeFromData,
    storeHash,
    storeUrl,
    accessToken,
    productId,
    imageId,
    overrides = {},
  } = job.data;

  const jobType = jobTypeFromData || "restore_bulk";
  const maxAttempts = job.opts?.attempts || getJobAttempts();
  const result = await runRestoreImageJob({
    jobUuid,
    jobType,
    storeHash,
    storeUrl,
    accessToken,
    productId,
    imageId,
    overrides,
    maxAttempts,
    attemptsMade: job.attemptsMade,
  });

  if (!result.success) {
    throw new Error(result.errorMessage || "Image restore failed");
  }

  return result.resultData;
}

module.exports = {
  processImageRestoreJob,
};
