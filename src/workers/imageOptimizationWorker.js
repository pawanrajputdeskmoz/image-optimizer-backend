const path = require("node:path");
const fs = require("node:fs");
const { config: loadEnv } = require("dotenv");
const appConfig = require("../config");
const { Worker } = require("bullmq");
const { createRedisConnection } = require("../db/redis");
const { connectMongo } = require("../db/mongo");
const { QUEUE_NAME } = require("../queue/imageOptimizationQueue");
const { compressImage } = require("../utils/compressImage");
const { resolveProductImageUrl } = require("../utils/urls");
const {
  setJobItemStatus,
  recordOptimizationJobImageResult,
  appendImageLog,
  shouldSkipImageOptimization,
} = require("../modules/imageOptimization/services");

const envPath = [path.join(process.cwd(), ".env"), path.join(__dirname, "../.env")].find(
  (p) => fs.existsSync(p)
);
if (envPath) loadEnv({ path: envPath });

const connection = createRedisConnection("bullmq-image-optimization-worker");

let worker;

async function startWorker() {
  await connectMongo();

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const {
        jobUuid,
        job_type: jobTypeFromData,
        type: legacyJobType,
        storeHash,
        storeUrl,
        accessToken,
        productId,
        imageId,
        imageUrl,
        settings,
        imageMeta = {},
      } = job.data;

      const jobType = jobTypeFromData || legacyJobType || "bulk";
      const maxAttempts = job.opts.attempts || 1;
      const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;
      const logContext = jobUuid
        ? { jobUuid, storeHash, jobType, productId, imageId }
        : null;

      if (jobUuid) {
        const { error: statusError } = await setJobItemStatus({
          jobUuid,
          productId,
          imageId,
          status: "optimizing",
        });

        if (statusError) {
          console.error("[image-optimization-worker] optimizing status:", statusError);
          await appendImageLog({
            jobUuid,
            storeHash,
            jobType,
            imageId,
            productId,
            logType: "error",
            step: "worker",
            message: "Failed to set job item status to optimizing",
            meta: { error: statusError },
          });
        }
      }

      const forceReoptimize = Boolean(job.data?.force || job.data?.force_reoptimize);
      if (!forceReoptimize) {
        const clientStatus = String(
          job.data?.optimization_status || job.data?.status || ""
        ).toLowerCase();
        const alreadyOptimizedOnClient = ["optimized", "optimizing"].includes(
          clientStatus
        );
        const { skip, reason } = await shouldSkipImageOptimization(
          storeHash,
          productId,
          imageId
        );

        if (skip || alreadyOptimizedOnClient) {
          const skipMessage =
            reason || "Image is already optimized or currently optimizing";

          if (jobUuid) {
            const { error: recordError } = await recordOptimizationJobImageResult({
              jobUuid,
              storeHash,
              skipped: true,
              skipReason: skipMessage,
              imageId,
              productId,
              jobType,
            });
            if (recordError) {
              console.error("[image-optimization-worker] skip record:", recordError);
            }
          }

          return {
            skipped: true,
            reason: skipMessage,
            image_id: imageId,
            product_id: productId,
          };
        }
      }

      const resolvedUrl = resolveProductImageUrl(storeUrl, imageUrl);
      if (!resolvedUrl) {
        const errMsg =
          "Invalid image_url: could not resolve a valid storefront image URL";

        if (jobUuid && isLastAttempt) {
          const { error: recordError } = await recordOptimizationJobImageResult({
            jobUuid,
            storeHash,
            success: false,
            imageId,
            productId,
            errorMessage: errMsg,
            jobType,
          });

          if (recordError) {
            console.error("[image-optimization-worker] record failed:", recordError);
          }
        }

        throw new Error(errMsg);
      }

      let success = false;
      let resultData = null;
      let errorMessage = null;

      try {
        const result = await compressImage({
          storeHash,
          storeUrl,
          accessToken,
          imageId: String(imageId),
          productId,
          imageUrl: resolvedUrl,
          settings,
          imageMeta,
          logContext,
        });

        if (!result.success) {
          errorMessage = result.error || "Image optimization failed";
          if (isLastAttempt) {
            success = false;
          } else {
            throw new Error(errorMessage);
          }
        } else {
          success = true;
          resultData = result.data;
        }
      } catch (err) {
        errorMessage = err?.message || "Image optimization failed";
        if (!isLastAttempt) {
          throw err;
        }
        success = false;
      }

      if (jobUuid && (success || isLastAttempt)) {
        const compression = resultData?.optimizedImage?.compression;
        const { error: recordError } = await recordOptimizationJobImageResult({
          jobUuid,
          storeHash,
          success,
          imageId,
          productId,
          errorMessage,
          jobType,
          savedBytes: compression?.savedBytes ?? null,
          savedPercentage: compression?.savedPercent ?? null,
        });

        if (recordError) {
          console.error("[image-optimization-worker] record failed:", recordError);
          throw new Error(recordError);
        }
      }

      if (!success) {
        throw new Error(errorMessage || "Image optimization failed");
      }

      return resultData;
    },
    {
      connection,
      concurrency: appConfig.workers.optimizationConcurrency,
    }
  );

  worker.on("completed", (job) => {
    console.log("[image-optimization-worker] completed", {
      jobId: job.id,
      jobUuid: job.data?.jobUuid,
      imageId: job.data?.imageId,
      productId: job.data?.productId,
    });
  });

  worker.on("failed", async (job, err) => {
    console.error("[image-optimization-worker] failed", {
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
        step: "worker",
        message: err?.message || "Image optimization worker job failed",
        meta: {
          bull_job_id: job?.id,
          attempts_made: job?.attemptsMade,
        },
      });
    }
  });

  console.log("[image-optimization-worker] started", { queue: QUEUE_NAME });
}

async function shutdown(signal) {
  try {
    console.log(`[image-optimization-worker] shutting down (${signal})...`);
    if (worker) await worker.close();
    await connection.quit();
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
