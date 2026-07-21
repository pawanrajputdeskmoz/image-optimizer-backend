const path = require("node:path");
const fs = require("node:fs");
const { config: loadEnv } = require("dotenv");
const appConfig = require("../config");
const { Worker } = require("bullmq");
const { createRedisConnection } = require("../db/redis");
const { connectMongo } = require("../db/mongo");
const { QUEUE_NAME } = require("../queue/brandImageRestoreQueue");
const { getJobAttempts } = require("../queue/workerJobOptions");
const {
  restoreBrandImageSingle,
  setBrandJobItemStatus,
  recordBrandJobItemResult,
} = require("../modules/brandImages/services");
const { appendBrandImageJobLog } = require("../modules/brandImages/utils/brandActivityLog");
const WORKER_NAME = "brand-image-restore";

const envPath = [
  path.join(process.cwd(), ".env"),
  path.join(__dirname, "../.env"),
].find((p) => fs.existsSync(p));
if (envPath) loadEnv({ path: envPath });

const connection = createRedisConnection("bullmq-brand-image-restore-worker");

let worker;

async function startWorker() {
  await connectMongo();
  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const {
        jobUuid,
        userId = null,
        jobId = null,
        job_type: jobType = "restore_checkbox",
        storeHash,
        accessToken,
        brandId,
      } = job.data;

      const maxAttempts = job.opts?.attempts || getJobAttempts();
      const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;

      const logContext = jobUuid
        ? { userId, jobId, jobUuid, storeHash, jobType, brandId }
        : null;

      if (jobUuid) {
        const { error: statusError } = await setBrandJobItemStatus({
          jobUuid,
          brandId,
          status: "restoring",
        });

        if (statusError) {
          console.error("[brand-image-restore-worker] set restoring status:", statusError);
          await appendBrandImageJobLog({
            userId,
            jobId,
            jobUuid,
            storeHash,
            jobType,
            brandId,
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
        const result = await restoreBrandImageSingle({
          storeHash,
          accessToken,
          brandId: Number(brandId),
          logContext,
        });

        if (!result.success) {
          errorMessage = result.error || "Brand image restore failed";
          if (result.skipped) {
            if (jobUuid) {
              await recordBrandJobItemResult({
                jobUuid,
                brandId,
                storeHash,
                success: false,
                skipped: true,
                skipReason: errorMessage,
                successStatus: "restored",
              });
            }
            return { skipped: true, reason: errorMessage, brand_id: brandId };
          }
          if (!isLastAttempt) {
            throw new Error(errorMessage);
          }
          success = false;
        } else {
          success = true;
          resultData = result.data;
        }
      } catch (err) {
        errorMessage = err?.message || "Brand image restore failed";
        if (!isLastAttempt) {
          throw err;
        }
        success = false;
      }

      if (jobUuid && (success || isLastAttempt)) {
        const { error: recordError } = await recordBrandJobItemResult({
          jobUuid,
          brandId,
          storeHash,
          success,
          errorMessage: success ? null : errorMessage,
          successStatus: "restored",
        });

        if (recordError) {
          console.error("[brand-image-restore-worker] record result failed:", recordError);
        }
      }

      if (!success) {
        throw new Error(errorMessage || "Brand image restore failed");
      }

      return resultData;
    },
    {
      connection,
      concurrency: appConfig.workers.brandRestoreConcurrency,
    }
  );

  worker.on("completed", (job) => {
    console.log("[brand-image-restore-worker] completed", {
      jobId: job.id,
      jobUuid: job.data?.jobUuid,
      brandId: job.data?.brandId,
    });
  });

  worker.on("failed", async (job, err) => {
    console.error("[brand-image-restore-worker] failed", {
      jobId: job?.id,
      jobUuid: job?.data?.jobUuid,
      brandId: job?.data?.brandId,
      error: err?.message,
    });

    const data = job?.data;
    if (data?.storeHash && data?.brandId != null) {
      await appendBrandImageJobLog({
        userId: data.userId,
        jobId: data.jobId,
        jobUuid: data.jobUuid,
        storeHash: data.storeHash,
        jobType: data.job_type || "restore_checkbox",
        brandId: data.brandId,
        logType: "error",
        step: "worker",
        message: err?.message || "Brand image restore worker job failed",
        meta: {
          bull_job_id: job?.id,
          attempts_made: job?.attemptsMade,
        },
      });
    }
  });

  console.log("[brand-image-restore-worker] started", { queue: QUEUE_NAME });
}

async function shutdown(signal) {
  try {
    console.log(`[brand-image-restore-worker] shutting down (${signal})...`);
    if (worker) await worker.close();
    await connection.quit();
    process.exit(0);
  } catch (err) {
    console.error("[brand-image-restore-worker] shutdown error", err);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startWorker().catch((err) => {
  console.error("[brand-image-restore-worker] start failed", err);
  process.exit(1);
});
