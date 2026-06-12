const path = require("node:path");
const fs = require("node:fs");
const { config: loadEnv } = require("dotenv");
const appConfig = require("../config");
const { Worker } = require("bullmq");
const { createRedisConnection } = require("../db/redis");
const { connectMongo } = require("../db/mongo");
const { QUEUE_NAME } = require("../queue/imageRestoreQueue");
const { restoreSingleImage } = require("../modules/imageOptimization/utils/restoreImage");
const {
  setRestoreJobItemStatus,
  recordRestoreJobImageResult,
  resolveImagePlacementFields,
  appendImageLog,
} = require("../modules/imageOptimization/services");

const envPath = [path.join(process.cwd(), ".env"), path.join(__dirname, "../.env")].find(
  (p) => fs.existsSync(p)
);
if (envPath) loadEnv({ path: envPath });

const connection = createRedisConnection("bullmq-image-restore-worker");

let worker;

async function startWorker() {
  await connectMongo();

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
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
      const maxAttempts = job.opts.attempts || 1;
      const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;
      const logContext = jobUuid
        ? { jobUuid, storeHash, jobType, productId, imageId }
        : null;

      if (jobUuid) {
        const { error: statusError } = await setRestoreJobItemStatus({
          jobUuid,
          productId,
          imageId,
          status: "restoring",
        });

        if (statusError) {
          console.error("[image-restore-worker] restoring status:", statusError);
          await appendImageLog({
            jobUuid,
            storeHash,
            jobType,
            imageId,
            productId,
            logType: "error",
            step: "worker",
            message: "Failed to set job item status to restoring",
            meta: { error: statusError },
          });
        }
      }

      let success = false;
      let resultData = null;
      let errorMessage = null;

      try {
        const placement = resolveImagePlacementFields(overrides);
        const result = await restoreSingleImage({
          storeHash,
          storeUrl,
          accessToken,
          productId,
          imageId,
          overrides: {
            ...overrides,
            placement,
          },
          logContext,
        });

        if (!result.success) {
          errorMessage = result.error || "Image restore failed";
          if (isLastAttempt) {
            success = false;
          } else if (!result.skipped) {
            throw new Error(errorMessage);
          } else {
            success = false;
          }
        } else {
          success = true;
          resultData = result.data;
        }
      } catch (err) {
        errorMessage = err?.message || "Image restore failed";
        if (!isLastAttempt) {
          throw err;
        }
        success = false;
      }

      if (jobUuid && (success || isLastAttempt)) {
        const { error: recordError } = await recordRestoreJobImageResult({
          jobUuid,
          storeHash,
          success,
          imageId,
          productId,
          errorMessage,
          jobType,
          meta: resultData || {},
        });

        if (recordError) {
          console.error("[image-restore-worker] record failed:", recordError);
          throw new Error(recordError);
        }
      }

      if (!success) {
        throw new Error(errorMessage || "Image restore failed");
      }

      return resultData;
    },
    {
      connection,
      concurrency: appConfig.workers.restoreConcurrency,
    }
  );

  worker.on("completed", (job) => {
    console.log("[image-restore-worker] completed", {
      jobId: job.id,
      jobUuid: job.data?.jobUuid,
      imageId: job.data?.imageId,
      productId: job.data?.productId,
    });
  });

  worker.on("failed", async (job, err) => {
    console.error("[image-restore-worker] failed", {
      jobId: job?.id,
      jobUuid: job?.data?.jobUuid,
      imageId: job?.data?.imageId,
      productId: job?.data?.productId,
      error: err?.message,
    });

    const data = job?.data;
    if (data?.storeHash) {
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
        },
      });
    }
  });

  console.log("[image-restore-worker] started", { queue: QUEUE_NAME });
}

async function shutdown(signal) {
  try {
    console.log(`[image-restore-worker] shutting down (${signal})...`);
    if (worker) await worker.close();
    await connection.quit();
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
