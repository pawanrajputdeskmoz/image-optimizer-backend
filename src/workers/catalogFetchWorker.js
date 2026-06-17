const path = require("node:path");
const fs = require("node:fs");
const { config: loadEnv } = require("dotenv");
const appConfig = require("../config");
const { Worker } = require("bullmq");
const { createRedisConnection } = require("../db/redis");
const { connectMongo } = require("../db/mongo");
const { QUEUE_NAME } = require("../queue/catalogFetchQueue");
const { imageOptimizationQueue } = require("../queue/imageOptimizationQueue");
const {
  fetchAllCatalogImagesInChunks,
  buildJobImageMeta,
  syncQueuedJobItemPlacements,
  updateJobAfterCatalogFetch,
  placementFieldsForJobItem,
} = require("../modules/imageOptimization/services");

const envPath = [
  path.join(process.cwd(), ".env"),
  path.join(__dirname, "../.env"),
].find((p) => fs.existsSync(p));
if (envPath) loadEnv({ path: envPath });

const connection = createRedisConnection("bullmq-catalog-fetch-worker");

const QUEUE_BATCH_SIZE = 500;

/** Push items to imageOptimizationQueue in sequential batches. */
async function batchQueueImages(items, jobData) {
  const { jobUuid, storeHash, storeUrl, accessToken, settings } = jobData;
  const results = [];

  for (let i = 0; i < items.length; i += QUEUE_BATCH_SIZE) {
    const batch = items.slice(i, i + QUEUE_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((entry) =>
        imageOptimizationQueue.add(
          "optimize-image",
          {
            jobUuid,
            job_type: "bulk",
            storeHash,
            storeUrl,
            accessToken,
            productId: entry.productId,
            imageId: entry.imageId,
            imageUrl: entry.imageUrl,
            optimization_status: null,
            settings,
            imageMeta: entry.imageMeta || {},
          },
          {
            removeOnComplete: 200,
            removeOnFail: 500,
            attempts: 2,
            backoff: { type: "exponential", delay: 5000 },
          }
        )
      )
    );
    results.push(...batchResults);
  }

  return results;
}

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
      } = job.data;

      console.log("[catalog-fetch-worker] starting", { jobUuid, storeHash });

      // ── 1. Fetch all BC catalog images page by page ────────────────────────
      const { error: catalogError, items, meta } = await fetchAllCatalogImagesInChunks({
        storeHash,
        accessToken,
        storeUrl,
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

      if (!items || items.length === 0) {
        await updateJobAfterCatalogFetch({
          jobUuid,
          storeHash,
          totalImages: meta?.images_found ?? 0,
          queuedImages: 0,
          skippedImages: meta?.skipped_already_optimized || 0,
          jobItems: [],
        });
        return { jobUuid, queued: 0 };
      }

      // ── 2. Build flat toQueue + jobItems list (mirrors queueBulkImageJobs) ───
      const toQueue = items.map((item, index) => ({
        index,
        productId: item.product_id,
        imageId: String(item.image_id),
        imageUrl: item.image_url,
        optimization_status: item.optimization_status || item.status || null,
        placementSource: item,
      }));

      const jobItems = toQueue.map((entry) => ({
        job_uuid: jobUuid,
        store_hash: storeHash,
        job_type: "bulk",
        product_id: Number(entry.productId),
        image_id: Number(entry.imageId),
        image_url: entry.imageUrl,
        status: "queued",
        ...placementFieldsForJobItem(entry.placementSource || {}),
      }));

      // ── 3. Build image metadata (filename/alt templates) in batches ─────────
      const productContextCache = new Map();
      const storeOptions = { currency: currency || null, store_name: store_name || null };

      const toQueueWithMeta = [];
      for (let i = 0; i < toQueue.length; i += QUEUE_BATCH_SIZE) {
        const batch = toQueue.slice(i, i + QUEUE_BATCH_SIZE);
        const batchWithMeta = await Promise.all(
          batch.map(async (entry) => {
            const imageMeta = await buildJobImageMeta({
              storeHash,
              productId: entry.productId,
              imageId: Number(entry.imageId),
              accessToken,
              settings,
              storeOptions,
              productContextCache,
              placementOverrides: entry.placementSource || {},
            });
            return { ...entry, imageMeta };
          })
        );
        toQueueWithMeta.push(...batchWithMeta);
      }

      // ── 4. Update job record + insert job items ──────────────────────────────
      // meta.images_found = queued + skipped_already_optimized
      const totalImages = meta?.images_found ?? items.length;
      const skippedImages = meta?.skipped_already_optimized || 0;

      await updateJobAfterCatalogFetch({
        jobUuid,
        storeHash,
        totalImages,
        queuedImages: toQueueWithMeta.length,
        skippedImages,
        jobItems,
      });

      // ── 5. Sync placement fields on job items ────────────────────────────────
      const { error: placementSyncError } = await syncQueuedJobItemPlacements(jobUuid, toQueueWithMeta);
      if (placementSyncError) {
        console.error("[catalog-fetch-worker] placement sync:", placementSyncError);
      }

      // ── 6. Push all images to imageOptimizationQueue in batches ─────────────
      await batchQueueImages(toQueueWithMeta, {
        jobUuid,
        storeHash,
        storeUrl,
        accessToken,
        settings,
      });

      console.log("[catalog-fetch-worker] done", {
        jobUuid,
        queued: toQueueWithMeta.length,
        skipped: skippedImages,
      });

      return { jobUuid, queued: toQueueWithMeta.length };
    },
    {
      connection,
      concurrency: appConfig.workers.catalogFetchConcurrency,
    }
  );

  // ── Worker event listeners ────────────────────────────────────────────────
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

  console.log("[catalog-fetch-worker] started", { queue: QUEUE_NAME });
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
