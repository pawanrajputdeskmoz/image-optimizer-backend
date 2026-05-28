const path = require("node:path");
const fs = require("node:fs");
const { config } = require("dotenv");
const { Worker } = require("bullmq");
const { createRedisConnection } = require("../db/redis");
const { connectMongo } = require("../db/mongo");
const { QUEUE_NAME } = require("../queue/imageOptimizationQueue");
const { compressImage } = require("../utils/compressImage");
const { resolveProductImageUrl } = require("../utils/urls");
const {
  setJobItemStatus,
  recordOptimizationJobImageResult,
} = require("../modules/imageOptimization/services");

const envPath = [path.join(process.cwd(), ".env"), path.join(__dirname, "../.env")].find(
  (p) => fs.existsSync(p)
);
if (envPath) config({ path: envPath });

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

      if (jobUuid) {
        const { error: statusError } = await setJobItemStatus({
          jobUuid,
          productId,
          imageId,
          status: "optimizing",
        });

        if (statusError) {
          console.error("[image-optimization-worker] optimizing status:", statusError);
        }
      }

      const resolvedUrl = resolveProductImageUrl(storeUrl, imageUrl);
      if (!resolvedUrl) {
        const errMsg =
          "Invalid image_url: could not resolve a valid storefront image URL";

        if (jobUuid && isLastAttempt) {
          const { error: recordError } = await recordOptimizationJobImageResult({
            jobUuid,
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
      concurrency: Number(process.env.IMAGE_OPTIMIZATION_WORKER_CONCURRENCY) || 2,
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

  worker.on("failed", (job, err) => {
    console.error("[image-optimization-worker] failed", {
      jobId: job?.id,
      jobUuid: job?.data?.jobUuid,
      imageId: job?.data?.imageId,
      productId: job?.data?.productId,
      error: err?.message,
    });
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
