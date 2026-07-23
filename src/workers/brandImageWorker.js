const path = require("node:path");
const fs = require("node:fs");
const { config: loadEnv } = require("dotenv");
const appConfig = require("../config");
const { Worker } = require("bullmq");
const { createRedisConnection } = require("../db/redis");
const { connectMongo } = require("../db/mongo");
const { QUEUE_NAME } = require("../queue/brandImageQueue");
const { getJobAttempts } = require("../queue/workerJobOptions");
const { compressBrandImage } = require("../modules/brandImages/utils/compressBrandImage");
const {
  setBrandJobItemStatus,
  recordBrandJobItemResult,
  shouldSkipBrandOptimization,
} = require("../modules/brandImages/services");
const { appendBrandImageJobLog } = require("../modules/brandImages/utils/brandActivityLog");
const WORKER_NAME = "brand-image";

const envPath = [
  path.join(process.cwd(), ".env"),
  path.join(__dirname, "../.env"),
].find((p) => fs.existsSync(p));
if (envPath) loadEnv({ path: envPath });

const connection = createRedisConnection("bullmq-brand-image-worker");

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
        job_type: jobType = "checkBox",
        storeHash,
        accessToken,
        brandId,
        imageUrl,
        brandName = null,
        settings = {},
        optimization_status,
      } = job.data;

      const maxAttempts = job.opts?.attempts || getJobAttempts();
      const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;

      const logContext = jobUuid
        ? { userId, jobId, jobUuid, storeHash, jobType, brandId }
        : null;

      // ── Mark item as "optimizing" ────────────────────────────────────────
      if (jobUuid) {
        const { error: statusError } = await setBrandJobItemStatus({
          jobUuid,
          brandId,
          status: "optimizing",
        });

        if (statusError) {
          console.error("[brand-image-worker] set optimizing status:", statusError);
          await appendBrandImageJobLog({
            userId,
            jobId,
            jobUuid,
            storeHash,
            jobType,
            brandId,
            logType: "error",
            step: "worker",
            message: "Failed to set job item status to optimizing",
            meta: { error: statusError },
          });
        }
      }

      // ── Skip check ───────────────────────────────────────────────────────
      const forceReoptimize = Boolean(job.data?.force || job.data?.force_reoptimize);
      if (!forceReoptimize) {
        const clientStatus = String(optimization_status || "").toLowerCase();
        const currentlyOptimizingOnClient = clientStatus === "optimizing";

        const { skip, reason } = await shouldSkipBrandOptimization(storeHash, brandId);

        if (skip || currentlyOptimizingOnClient) {
          const skipMessage = reason || "Brand image is currently being optimized";

          if (jobUuid) {
            await recordBrandJobItemResult({
              jobUuid,
              brandId,
              storeHash,
              success: false,
              skipped: true,
              skipReason: skipMessage,
            });
          }

          await appendBrandImageJobLog({
            userId,
            jobId,
            jobUuid,
            storeHash,
            jobType,
            brandId,
            logType: "info",
            step: "skip",
            message: skipMessage,
            meta: { brand_id: brandId, reason: skipMessage },
          });

          return { skipped: true, reason: skipMessage, brand_id: brandId };
        }
      }

      // ── Validate image URL ───────────────────────────────────────────────
      if (!imageUrl || !String(imageUrl).trim()) {
        const errMsg = "image_url is missing or empty — cannot optimize brand image";

        if (jobUuid && isLastAttempt) {
          await recordBrandJobItemResult({
            jobUuid,
            brandId,
            storeHash,
            success: false,
            errorMessage: errMsg,
          });
        }

        await appendBrandImageJobLog({
          userId,
          jobId,
          jobUuid,
          storeHash,
          jobType,
          brandId,
          logType: "error",
          step: "worker",
          message: errMsg,
          meta: { brand_id: brandId },
        });

        throw new Error(errMsg);
      }

      // ── Run optimization ─────────────────────────────────────────────────
      let success = false;
      let resultData = null;
      let errorMessage = null;

      try {
        const result = await compressBrandImage({
          storeHash,
          accessToken,
          brandId: Number(brandId),
          imageUrl: String(imageUrl).trim(),
          brandName: brandName || null,
          settings,
          force: forceReoptimize,
          logContext,
        });

        if (!result.success) {
          if (result.plan_limit) {
            return {
              skipped: true,
              plan_limit: true,
              reason: result.error,
              brand_id: brandId,
            };
          }

          errorMessage = result.error || "Brand image optimization failed";
          if (!isLastAttempt) throw new Error(errorMessage);
          success = false;
        } else {
          success = true;
          resultData = result.data;
        }
      } catch (err) {
        errorMessage = err?.message || "Brand image optimization failed";
        if (!isLastAttempt) throw err;
        success = false;
      }

      // ── Record result ────────────────────────────────────────────────────
      if (jobUuid && (success || isLastAttempt)) {
        const compression = resultData?.optimizedImage?.compression;

        const { error: recordError } = await recordBrandJobItemResult({
          jobUuid,
          brandId,
          storeHash,
          success,
          errorMessage: success ? null : errorMessage,
          savedBytes: compression?.savedBytes ?? null,
          savedPercentage: compression?.savedPercent ?? null,
        });

        if (recordError) {
          console.error("[brand-image-worker] record result failed:", recordError);
        }
      }

      if (!success) {
        throw new Error(errorMessage || "Brand image optimization failed");
      }

      return resultData;
    },
    {
      connection,
      concurrency: appConfig.workers.brandOptimizationConcurrency,
    }
  );

  // ── Worker event listeners ────────────────────────────────────────────────
  worker.on("completed", (job) => {
    console.log("[brand-image-worker] completed", {
      jobId: job.id,
      jobUuid: job.data?.jobUuid,
      brandId: job.data?.brandId,
    });
  });

  worker.on("failed", async (job, err) => {
    console.error("[brand-image-worker] failed", {
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
        jobType: data.job_type || "checkBox",
        brandId: data.brandId,
        logType: "error",
        step: "worker",
        message: err?.message || "Brand image optimization worker job failed",
        meta: {
          bull_job_id: job?.id,
          attempts_made: job?.attemptsMade,
        },
      });
    }
  });

  console.log("[brand-image-worker] started", { queue: QUEUE_NAME });
}

async function shutdown(signal) {
  try {
    console.log(`[brand-image-worker] shutting down (${signal})...`);
    if (worker) await worker.close();
    await connection.quit();
    process.exit(0);
  } catch (err) {
    console.error("[brand-image-worker] shutdown error", err);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startWorker().catch((err) => {
  console.error("[brand-image-worker] start failed", err);
  process.exit(1);
});
