const path = require("node:path");
const fs = require("node:fs");
const { config: loadEnv } = require("dotenv");
const appConfig = require("../config");
const { Worker } = require("bullmq");
const { createRedisConnection } = require("../db/redis");
const { connectMongo } = require("../db/mongo");
const { QUEUE_NAME } = require("../queue/catalogFetchQueue");
const {
  streamCatalogFetchToJobItems,
  queueOptimizationBatchJobs,
  updateJobAfterCatalogFetch,
} = require("../modules/imageOptimization/services");

const envPath = [
  path.join(process.cwd(), ".env"),
  path.join(__dirname, "../.env"),
].find((p) => fs.existsSync(p));
if (envPath) loadEnv({ path: envPath });

const connection = createRedisConnection("bullmq-catalog-fetch-worker");

let worker;

async function startWorker() {
  await connectMongo();
  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const {
        jobUuid,
        storeHash,
        storeUrl,
        accessToken,
        channelId,
        settings,
        currency,
        store_name,
        selectedPlan,
      } = job.data;

      console.log("[catalog-fetch-worker] starting", { jobUuid, storeHash });

      const {
        error: catalogError,
        meta,
        batchCount,
        queuedImages,
      } = await streamCatalogFetchToJobItems({
        jobUuid,
        storeHash,
        accessToken,
        storeUrl,
        // Filename/alt templates must still apply to already-optimized images
        // (worker runs a metadata-only update for them).
        includeOptimized: Boolean(
          settings?.is_filename_template_enabled ||
            settings?.is_alt_text_template_enabled
        ),
      });

      if (catalogError) {
        await updateJobAfterCatalogFetch({
          jobUuid,
          storeHash,
          totalImages: 0,
          queuedImages: 0,
          skippedImages: 0,
          failed: true,
          errorMessage: catalogError,
        });
        throw new Error(catalogError);
      }

      if (!queuedImages) {
        await updateJobAfterCatalogFetch({
          jobUuid,
          storeHash,
          totalImages: meta?.images_found ?? 0,
          queuedImages: 0,
          skippedImages: meta?.skipped_already_optimized || 0,
          jobItems: [],
          totalBatches: 0,
        });
        return { jobUuid, queued: 0, batches: 0 };
      }

      await updateJobAfterCatalogFetch({
        jobUuid,
        storeHash,
        totalImages: meta?.images_found ?? queuedImages,
        queuedImages,
        skippedImages: meta?.skipped_already_optimized || 0,
        jobItems: [],
        totalBatches: batchCount,
      });

      const {
        error: queueError,
        tier,
        queued,
        duplicates,
        paused,
        dispatched,
      } = await queueOptimizationBatchJobs({
        jobUuid,
        batchCount,
        storeHash,
        storeUrl,
        accessToken,
        settings,
        job_type: "bulk",
        currency: currency || null,
        store_name: store_name || null,
        estimatedImages: queuedImages,
        suppressHeavyWake: false,
        selectedPlan: selectedPlan || "free",
      });

      if (queueError) {
        throw new Error(queueError);
      }

      console.log("[catalog-fetch-worker] done", {
        jobUuid,
        queuedImages,
        batches: batchCount,
        redisJobs: queued,
        duplicates,
        tier,
        channelId,
        dispatched,
        paused,
      });

      return {
        jobUuid,
        queued: queuedImages,
        batches: batchCount,
        dispatched,
        paused_plan_limit: Boolean(paused),
      };
    },
    {
      connection,
      concurrency: appConfig.workers.catalogFetchConcurrency,
    }
  );

  worker.on("completed", (job) => {
    console.log("[catalog-fetch-worker] completed", {
      jobId: job.id,
      jobUuid: job.data?.jobUuid,
    });
  });

  worker.on("failed", async (job, err) => {
    console.error("[catalog-fetch-worker] failed", {
      jobId: job?.id,
      jobUuid: job?.data?.jobUuid,
      error: err?.message,
    });

    const data = job?.data;
    if (data?.jobUuid && data?.storeHash) {
      await updateJobAfterCatalogFetch({
        jobUuid: data.jobUuid,
        storeHash: data.storeHash,
        totalImages: 0,
        queuedImages: 0,
        skippedImages: 0,
        failed: true,
        errorMessage: err?.message || "Catalog fetch worker job failed",
      }).catch(() => {});
    }
  });

  console.log("[catalog-fetch-worker] started", {
    queue: QUEUE_NAME,
    concurrency: appConfig.workers.catalogFetchConcurrency,
  });
}

async function shutdown(signal) {
  try {
    console.log(`[catalog-fetch-worker] shutting down (${signal})...`);
    if (worker) await worker.close();
    await connection.quit();
    process.exit(0);
  } catch (err) {
    console.error("[catalog-fetch-worker] shutdown error", err);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startWorker().catch((err) => {
  console.error("[catalog-fetch-worker] start failed", err);
  process.exit(1);
});
