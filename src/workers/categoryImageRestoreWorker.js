const path = require("node:path");
const fs = require("node:fs");
const { config: loadEnv } = require("dotenv");
const appConfig = require("../config");
const { Worker } = require("bullmq");
const { createRedisConnection } = require("../db/redis");
const { connectMongo } = require("../db/mongo");
const { QUEUE_NAME } = require("../queue/categoryImageRestoreQueue");
const { getJobAttempts } = require("../queue/workerJobOptions");
const {
  restoreCategoryImageSingle,
  setCategoryJobItemStatus,
  recordCategoryJobItemResult,
} = require("../modules/categoryImages/services");
const {
  appendCategoryImageLog,
} = require("../modules/categoryImages/utils/categoryActivityLog");
const WORKER_NAME = "category-image-restore";

const envPath = [
  path.join(process.cwd(), ".env"),
  path.join(__dirname, "../.env"),
].find((p) => fs.existsSync(p));
if (envPath) loadEnv({ path: envPath });

const connection = createRedisConnection("bullmq-category-image-restore-worker");

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
        channelId = 1,
        treeId = null,
        categoryId,
      } = job.data;

      const maxAttempts = job.opts?.attempts || getJobAttempts();
      const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;

      // ── Mark item as "restoring" ───────────────────────────────────────────
      if (jobUuid) {
        const { error: statusError } = await setCategoryJobItemStatus({
          jobUuid,
          categoryId,
          status: "restoring",
        });

        if (statusError) {
          console.error("[category-image-restore-worker] set restoring status:", statusError);
          await appendCategoryImageLog({
            userId,
            jobId,
            jobUuid,
            storeHash,
            channelId,
            treeId,
            jobType,
            categoryId,
            logType: "error",
            step: "worker",
            message: "Failed to set job item status to restoring",
            meta: { error: statusError },
          });
        }
      }

      // ── Run restore ────────────────────────────────────────────────────────
      let success = false;
      let resultData = null;
      let errorMessage = null;

      try {
        const result = await restoreCategoryImageSingle({
          storeHash,
          accessToken,
          channelId: Number(channelId) || 1,
          treeId: treeId != null ? Number(treeId) : null,
          categoryId: Number(categoryId),
        });

        if (!result.success) {
          errorMessage = result.error || "Category image restore failed";
          if (result.skipped) {
            // skipped is a terminal state — record it and do not retry
            if (jobUuid) {
              await recordCategoryJobItemResult({
                jobUuid,
                categoryId,
                success: false,
                skipped: true,
                skipReason: errorMessage,
                successStatus: "restored",
              });
            }
            return { skipped: true, reason: errorMessage, category_id: categoryId };
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
        errorMessage = err?.message || "Category image restore failed";
        if (!isLastAttempt) {
          throw err;
        }
        success = false;
      }

      // ── Record result ──────────────────────────────────────────────────────
      if (jobUuid && (success || isLastAttempt)) {
        const { error: recordError } = await recordCategoryJobItemResult({
          jobUuid,
          categoryId,
          success,
          errorMessage: success ? null : errorMessage,
          successStatus: "restored",
        });

        if (recordError) {
          console.error("[category-image-restore-worker] record result failed:", recordError);
        }
      }

      if (!success) {
        throw new Error(errorMessage || "Category image restore failed");
      }

      return resultData;
    },
    {
      connection,
      concurrency: appConfig.workers.categoryRestoreConcurrency,
    }
  );

  // ── Worker event listeners ────────────────────────────────────────────────
  worker.on("completed", (job) => {
    console.log("[category-image-restore-worker] completed", {
      jobId: job.id,
      jobUuid: job.data?.jobUuid,
      categoryId: job.data?.categoryId,
    });
  });

  worker.on("failed", async (job, err) => {
    console.error("[category-image-restore-worker] failed", {
      jobId: job?.id,
      jobUuid: job?.data?.jobUuid,
      categoryId: job?.data?.categoryId,
      error: err?.message,
    });

    const data = job?.data;
    if (data?.storeHash && data?.categoryId != null) {
      await appendCategoryImageLog({
        userId: data.userId,
        jobId: data.jobId,
        jobUuid: data.jobUuid,
        storeHash: data.storeHash,
        channelId: data.channelId || 1,
        treeId: data.treeId ?? null,
        jobType: data.job_type || "restore_checkbox",
        categoryId: data.categoryId,
        logType: "error",
        step: "worker",
        message: err?.message || "Category image restore worker job failed",
        meta: {
          bull_job_id: job?.id,
          attempts_made: job?.attemptsMade,
        },
      });
    }
  });

  console.log("[category-image-restore-worker] started", { queue: QUEUE_NAME });
}

async function shutdown(signal) {
  try {
    console.log(`[category-image-restore-worker] shutting down (${signal})...`);
    if (worker) await worker.close();
    await connection.quit();
    process.exit(0);
  } catch (err) {
    console.error("[category-image-restore-worker] shutdown error", err);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startWorker().catch((err) => {
  console.error("[category-image-restore-worker] start failed", err);
  process.exit(1);
});
