const path = require("node:path");
const fs = require("node:fs");
const { config: loadEnv } = require("dotenv");
const appConfig = require("../config");
const { Worker } = require("bullmq");
const { createRedisConnection } = require("../db/redis");
const { connectMongo } = require("../db/mongo");
const { QUEUE_NAME } = require("../queue/categoryImageQueue");
const { compressCategoryImage } = require("../modules/categoryImages/utils/compressCategoryImage");
const {
  setCategoryJobItemStatus,
  recordCategoryJobItemResult,
  shouldSkipCategoryOptimization,
} = require("../modules/categoryImages/services");
const {
  appendCategoryImageLog,
} = require("../modules/categoryImages/utils/categoryActivityLog");

const envPath = [
  path.join(process.cwd(), ".env"),
  path.join(__dirname, "../.env"),
].find((p) => fs.existsSync(p));
if (envPath) loadEnv({ path: envPath });

const connection = createRedisConnection("bullmq-category-image-worker");

let worker;

async function startWorker() {
  await connectMongo();

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const {
        jobUuid,
        job_type: jobType = "checkBox",
        storeHash,
        accessToken,
        channelId = 1,
        treeId = null,
        categoryId,
        imageUrl,
        categoryName = null,
        settings = {},
        optimization_status,
      } = job.data;

      const maxAttempts = job.opts.attempts || 1;
      const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;

      const logContext = jobUuid
        ? { jobUuid, storeHash, jobType, channelId, treeId, categoryId }
        : null;

      const runOptimize = Boolean(settings?.optimize_image_enabled);

      // ── Mark item as "optimizing" ──────────────────────────────────────────
      if (jobUuid && runOptimize) {
        const { error: statusError } = await setCategoryJobItemStatus({
          jobUuid,
          categoryId,
          status: "optimizing",
        });

        if (statusError) {
          console.error("[category-image-worker] set optimizing status:", statusError);
          await appendCategoryImageLog({
            jobUuid,
            storeHash,
            channelId,
            treeId,
            jobType,
            categoryId,
            logType: "error",
            step: "worker",
            message: "Failed to set job item status to optimizing",
            meta: { error: statusError },
          });
        }
      }

      // ── Skip check ─────────────────────────────────────────────────────────
      const forceReoptimize = Boolean(job.data?.force || job.data?.force_reoptimize);
      if (!forceReoptimize) {
        const clientStatus = String(optimization_status || "").toLowerCase();
        const alreadyOptimizedOnClient = ["optimized", "optimizing"].includes(clientStatus);

        const { skip, reason } = await shouldSkipCategoryOptimization(storeHash, categoryId);

        if (skip || alreadyOptimizedOnClient) {
          const skipMessage = reason || "Category image is already optimized or currently optimizing";

          if (jobUuid) {
            const { error: recordError } = await recordCategoryJobItemResult({
              jobUuid,
              categoryId,
              success: false,
              skipped: true,
              skipReason: skipMessage,
            });
            if (recordError) {
              console.error("[category-image-worker] skip record:", recordError);
            }
          }

          await appendCategoryImageLog({
            jobUuid,
            storeHash,
            channelId,
            treeId,
            jobType,
            categoryId,
            logType: "info",
            step: "skip",
            message: skipMessage,
            meta: { category_id: categoryId, reason: skipMessage },
          });

          return {
            skipped: true,
            reason: skipMessage,
            category_id: categoryId,
          };
        }
      }

      // ── Validate image URL ─────────────────────────────────────────────────
      if (!imageUrl || !String(imageUrl).trim()) {
        const errMsg = "image_url is missing or empty — cannot optimize category image";

        if (jobUuid && isLastAttempt) {
          await recordCategoryJobItemResult({
            jobUuid,
            categoryId,
            success: false,
            errorMessage: errMsg,
          });
        }

        await appendCategoryImageLog({
          jobUuid,
          storeHash,
          channelId,
          treeId,
          jobType,
          categoryId,
          logType: "error",
          step: "worker",
          message: errMsg,
          meta: { category_id: categoryId },
        });

        throw new Error(errMsg);
      }

      // ── Run optimization ───────────────────────────────────────────────────
      let success = false;
      let resultData = null;
      let errorMessage = null;

      try {
        const result = await compressCategoryImage({
          storeHash,
          accessToken,
          channelId: Number(channelId) || 1,
          treeId: treeId != null ? Number(treeId) : null,
          categoryId: Number(categoryId),
          imageUrl: String(imageUrl).trim(),
          categoryName: categoryName || null,
          settings,
          force: forceReoptimize,
          logContext,
        });

        if (!result.success) {
          errorMessage = result.error || "Category image optimization failed";
          if (!isLastAttempt) {
            throw new Error(errorMessage);
          }
          success = false;
        } else {
          success = true;
          resultData = result.data;
        }
      } catch (err) {
        errorMessage = err?.message || "Category image optimization failed";
        if (!isLastAttempt) {
          throw err;
        }
        success = false;
      }

      // ── Record result ──────────────────────────────────────────────────────
      if (jobUuid && (success || isLastAttempt)) {
        const compression = resultData?.optimizedImage?.compression;

        const { error: recordError } = await recordCategoryJobItemResult({
          jobUuid,
          categoryId,
          success,
          errorMessage: success ? null : errorMessage,
          savedBytes: compression?.savedBytes ?? null,
          savedPercentage: compression?.savedPercent ?? null,
        });

        if (recordError) {
          console.error("[category-image-worker] record result failed:", recordError);
        }
      }

      if (!success) {
        throw new Error(errorMessage || "Category image optimization failed");
      }

      return resultData;
    },
    {
      connection,
      concurrency: appConfig.workers.categoryOptimizationConcurrency,
    }
  );

  // ── Worker event listeners ────────────────────────────────────────────────
  worker.on("completed", (job) => {
    console.log("[category-image-worker] completed", {
      jobId: job.id,
      jobUuid: job.data?.jobUuid,
      categoryId: job.data?.categoryId,
    });
  });

  worker.on("failed", async (job, err) => {
    console.error("[category-image-worker] failed", {
      jobId: job?.id,
      jobUuid: job?.data?.jobUuid,
      categoryId: job?.data?.categoryId,
      error: err?.message,
    });

    const data = job?.data;
    if (data?.storeHash && data?.categoryId != null) {
      await appendCategoryImageLog({
        jobUuid: data.jobUuid,
        storeHash: data.storeHash,
        channelId: data.channelId || 1,
        treeId: data.treeId ?? null,
        jobType: data.job_type || "checkBox",
        categoryId: data.categoryId,
        logType: "error",
        step: "worker",
        message: err?.message || "Category image optimization worker job failed",
        meta: {
          bull_job_id: job?.id,
          attempts_made: job?.attemptsMade,
        },
      });
    }
  });

  console.log("[category-image-worker] started", { queue: QUEUE_NAME });
}

async function shutdown(signal) {
  try {
    console.log(`[category-image-worker] shutting down (${signal})...`);
    if (worker) await worker.close();
    await connection.quit();
    process.exit(0);
  } catch (err) {
    console.error("[category-image-worker] shutdown error", err);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startWorker().catch((err) => {
  console.error("[category-image-worker] start failed", err);
  process.exit(1);
});
