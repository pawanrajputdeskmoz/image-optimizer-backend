const path = require("node:path");
const fs = require("node:fs");
const { config: loadEnv } = require("dotenv");
const appConfig = require("../config");
const { Worker } = require("bullmq");
const { createRedisConnection } = require("../db/redis");
const { connectMongo } = require("../db/mongo");
const { QUEUE_NAME } = require("../queue/homeImageQueue");
const {
  optimizeHomeImageDirect,
  recordHomeJobItemResult,
} = require("../modules/homeImages/services");

const envPath = [
  path.join(process.cwd(), ".env"),
  path.join(__dirname, "../.env"),
].find((p) => fs.existsSync(p));
if (envPath) loadEnv({ path: envPath });

const connection = createRedisConnection("bullmq-home-image-worker");

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
        sourceType,
        sourceKey,
        sourceId = null,
        sourceName = null,
        context = null,
        isUpdateSupported = true,
        originalUrl,
        widgetUuid = null,
        widgetName = null,
        imagePath = null,
        metadata = null,
        quality,
        maxWidth,
        outputFormat,
        force = false,
        optimizeOnly = false,
      } = job.data;

      const maxAttempts = job.opts.attempts || 1;
      const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;

      if (!originalUrl || !String(originalUrl).trim()) {
        const errMsg = "original_url is missing — cannot optimize home image";

        if (jobUuid && isLastAttempt) {
          await recordHomeJobItemResult({ jobUuid, success: false, errorMessage: errMsg });
        }

        throw new Error(errMsg);
      }

      let success = false;
      let resultData = null;
      let errorMessage = null;
      let skipped = false;

      try {
        const result = await optimizeHomeImageDirect({
          storeHash,
          accessToken,
          channelId: Number(channelId) || 1,
          sourceType,
          sourceKey,
          sourceId,
          sourceName,
          context,
          isUpdateSupported,
          originalUrl: String(originalUrl).trim(),
          widgetUuid,
          widgetName,
          imagePath,
          metadata,
          quality,
          maxWidth,
          outputFormat,
          force,
          optimizeOnly,
        });

        if (result.skipped) {
          skipped = true;
          success = false;
        } else if (!result.success) {
          errorMessage = result.error || "Home image optimization failed";
          if (!isLastAttempt) {
            throw new Error(errorMessage);
          }
          success = false;
        } else {
          success = true;
          resultData = result.data;
        }
      } catch (err) {
        errorMessage = err?.message || "Home image optimization failed";
        if (!isLastAttempt) {
          throw err;
        }
        success = false;
      }

      if (jobUuid && (success || skipped || isLastAttempt)) {
        const { error: recordError } = await recordHomeJobItemResult({
          jobUuid,
          success,
          skipped,
          errorMessage: success ? null : errorMessage,
          savedBytes: resultData?.saved_bytes ?? null,
        });

        if (recordError) {
          console.error("[home-image-worker] record result failed:", recordError);
        }
      }

      if (!success && !skipped) {
        throw new Error(errorMessage || "Home image optimization failed");
      }

      return skipped ? { skipped: true, source_key: sourceKey } : resultData;
    },
    {
      connection,
      concurrency: appConfig.workers.homeImageOptimizationConcurrency,
    }
  );

  worker.on("completed", (job) => {
    console.log("[home-image-worker] completed", {
      jobId: job.id,
      jobUuid: job.data?.jobUuid,
      sourceKey: job.data?.sourceKey,
    });
  });

  worker.on("failed", async (job, err) => {
    console.error("[home-image-worker] failed", {
      jobId: job?.id,
      jobUuid: job?.data?.jobUuid,
      sourceKey: job?.data?.sourceKey,
      error: err?.message,
    });

    const data = job?.data;
    if (data?.jobUuid && data?.storeHash) {
      await recordHomeJobItemResult({
        jobUuid: data.jobUuid,
        success: false,
        errorMessage: err?.message || "Home image worker job failed",
      });
    }
  });

  console.log("[home-image-worker] started", { queue: QUEUE_NAME });
}

async function shutdown(signal) {
  try {
    console.log(`[home-image-worker] shutting down (${signal})...`);
    if (worker) await worker.close();
    await connection.quit();
    process.exit(0);
  } catch (err) {
    console.error("[home-image-worker] shutdown error", err);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startWorker().catch((err) => {
  console.error("[home-image-worker] start failed", err);
  process.exit(1);
});
