const ImageJobItem = require("../models/ImageJobItem");
const { compressImage } = require("../modules/imageOptimization/utils/compressImage");
const { resolveProductImageUrl } = require("../modules/imageOptimization/utils/urls");
const {
  setJobItemStatus,
  recordOptimizationJobImageResult,
  appendImageLog,
  shouldSkipImageOptimization,
  processWebhookProductBurst,
  buildJobImageMeta,
  handleOptimizationBatchComplete,
} = require("../modules/imageOptimization/services");
const {
  pauseJobForPlanLimit,
  MONTHLY_PLAN_LIMIT_MESSAGE,
} = require("../modules/plans/service");
const { getCurrentMonthQuotaStatus } = require("../utils/monthlyUsage");
const { getJobAttempts, sleepBackoff } = require("../queue/workerJobOptions");

/** Matches recordMonthlyOptimization — only full compress runs consume quota. */
function imageResultConsumesQuota(result, settings) {
  if (!result || result.skipped) return false;
  const metadataOnly = Boolean(
    result.metadataOnly || result.optimizedImage?.metadataOnly
  );
  if (metadataOnly) return false;
  return Boolean(settings?.optimize_image_enabled);
}

/**
 * Optimize a single image (shared by per-image and batch BullMQ jobs).
 */
async function processSingleImageOptimization({
  jobUuid,
  jobType,
  storeHash,
  storeUrl,
  accessToken,
  productId,
  imageId,
  imageUrl,
  settings,
  imageMeta = {},
  optimization_status = null,
  forceReoptimize = false,
  maxAttempts = 1,
  attemptsMade = 0,
  skipQuotaCheck = false,
}) {
  console.log("[image-optimization-worker] process start", {
    jobUuid,
    jobType,
    storeHash,
    productId,
    imageId,
    imageUrl,
    forceReoptimize,
    attemptsMade,
    maxAttempts,
  });

  if (storeHash) {
    await appendImageLog({
      jobUuid,
      storeHash,
      jobType,
      imageId,
      productId,
      logType: "info",
      step: "worker_start",
      message: "Worker started processing image",
      meta: {
        seq: 4,
        image_url: imageUrl,
        force_reoptimize: forceReoptimize,
        attempts_made: attemptsMade,
        max_attempts: maxAttempts,
      },
    });
  }

  const isLastAttempt = attemptsMade + 1 >= maxAttempts;
  const logContext = jobUuid
    ? { jobUuid, storeHash, jobType, productId, imageId }
    : null;

  const runOptimize = Boolean(settings?.optimize_image_enabled);

  if (jobUuid && runOptimize) {
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

  // Filename/alt templates must still apply to already-optimized images
  // (compressImage runs a metadata-only update), so "optimized" doesn't block.
  const metadataTemplatesOn = Boolean(
    settings?.is_filename_template_enabled ||
      settings?.is_alt_text_template_enabled
  );

  if (!forceReoptimize) {
    const clientStatus = String(optimization_status || "").toLowerCase();
    const clientBlockingStatuses = metadataTemplatesOn
      ? ["optimizing"]
      : ["optimized", "optimizing"];
    const alreadyOptimizedOnClient = clientBlockingStatuses.includes(
      clientStatus
    );
    const { skip, code: skipCode, reason } = await shouldSkipImageOptimization(
      storeHash,
      productId,
      imageId,
      { accessToken, forceReoptimize }
    );
    const skipBlocks =
      skip && !(metadataTemplatesOn && skipCode === "optimized");

    if (skipBlocks || alreadyOptimizedOnClient) {
      const skipMessage =
        reason || "Image is already optimized or currently optimizing";

      console.log("[image-optimization-worker] skipped", {
        jobUuid,
        productId,
        imageId,
        reason: skipMessage,
        alreadyOptimizedOnClient,
      });

      if (storeHash) {
        await appendImageLog({
          jobUuid,
          storeHash,
          jobType,
          imageId,
          productId,
          logType: "warning",
          step: "skip",
          message: skipMessage,
          meta: {
            seq: 5,
            already_optimized_on_client: alreadyOptimizedOnClient,
            source: "worker_precheck",
          },
        });
      }

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

  const templatesOn = Boolean(
    settings?.is_filename_template_enabled ||
      settings?.is_alt_text_template_enabled
  );
  let resolvedImageMeta = imageMeta || {};
  if (templatesOn && accessToken) {
    resolvedImageMeta = await buildJobImageMeta({
      storeHash,
      productId,
      imageId: Number(imageId),
      accessToken,
      settings,
      storeOptions: {},
      placementOverrides: imageMeta || {},
    });
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
      imageMeta: resolvedImageMeta,
      logContext,
      skipQuotaCheck,
    });

    if (!result.success) {
      errorMessage = result.error || "Image optimization failed";
      if (isLastAttempt) {
        success = false;
      } else {
        throw new Error(errorMessage);
      }
    } else if (result.skipped) {
      console.log("[image-optimization-worker] skipped after compress", {
        jobUuid,
        productId,
        imageId,
        reason: result.reason || result.data?.skip_reason || "Image skipped",
      });

      if (jobUuid) {
        const { error: recordError } = await recordOptimizationJobImageResult({
          jobUuid,
          storeHash,
          skipped: true,
          skipReason: result.reason || result.data?.skip_reason || "Image skipped",
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
        reason: result.reason || result.data?.skip_reason || "Image skipped",
        image_id: imageId,
        product_id: productId,
      };
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
    const metadataOnly = Boolean(
      resultData?.metadataOnly || resultData?.optimizedImage?.metadataOnly
    );
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
      metadataOnly,
    });

    if (recordError) {
      console.error("[image-optimization-worker] record failed:", recordError);
      throw new Error(recordError);
    }
  }

  if (!success) {
    console.error("[image-optimization-worker] process failed", {
      jobUuid,
      productId,
      imageId,
      errorMessage,
    });
    if (storeHash) {
      await appendImageLog({
        jobUuid,
        storeHash,
        jobType,
        imageId,
        productId,
        logType: "error",
        step: "worker_failed",
        message: errorMessage || "Image optimization failed",
        meta: { seq: 7, attempts_made: attemptsMade, max_attempts: maxAttempts },
      });
    }
    throw new Error(errorMessage || "Image optimization failed");
  }

  console.log("[image-optimization-worker] process success", {
    jobUuid,
    productId,
    imageId,
  });

  if (storeHash) {
    await appendImageLog({
      jobUuid,
      storeHash,
      jobType,
      imageId,
      productId,
      logType: "info",
      step: "worker_success",
      message: "Worker finished image optimization successfully",
      meta: { seq: 7 },
    });
  }

  return resultData;
}

async function processOptimizationBatchJob(job) {
  const {
    jobUuid,
    job_type: jobTypeFromData,
    type: legacyJobType,
    storeHash,
    storeUrl,
    accessToken,
    settings,
    batchIndex,
    currency = null,
    store_name = null,
  } = job.data;

  const jobType = jobTypeFromData || legacyJobType || "bulk";
  const forceReoptimize = Boolean(job.data?.force || job.data?.force_reoptimize);
  const maxAttempts = job.opts?.attempts || getJobAttempts();

  if ((job.attemptsMade || 0) > 0) {
    await ImageJobItem.updateMany(
      {
        job_uuid: jobUuid,
        batch_index: batchIndex,
        status: "optimizing",
      },
      {
        $set: {
          status: "queued",
          error_message: null,
          started_at: null,
        },
      }
    );
  }

  const items = await ImageJobItem.find({
    job_uuid: jobUuid,
    batch_index: batchIndex,
    status: "queued",
  })
    .sort({ product_id: 1, image_id: 1 })
    .lean();

  if (!items.length) {
    return { batchIndex, processed: 0, skipped: 0, failed: 0 };
  }

  const productContextCache = new Map();
  const storeOptions = { currency, store_name };
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let planLimitHit = false;

  // One quota read per batch; local counter avoids per-image DB lookups.
  const batchQuota = storeHash ? await getCurrentMonthQuotaStatus(storeHash) : null;
  const quotaUnlimited = Boolean(batchQuota?.unlimited);
  let quotaRemaining = quotaUnlimited
    ? null
    : Math.max(0, Number(batchQuota?.remaining) || 0);

  if (!quotaUnlimited && quotaRemaining <= 0) {
    planLimitHit = true;
  }

  for (const item of items) {
    if (planLimitHit) {
      break;
    }

    if (!quotaUnlimited && quotaRemaining <= 0) {
      planLimitHit = true;
      break;
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const imageMeta = await buildJobImageMeta({
          storeHash,
          productId: item.product_id,
          imageId: item.image_id,
          accessToken,
          settings,
          storeOptions,
          productContextCache,
          placementOverrides: item,
        });

        const placementUpdates = {};
        if (imageMeta.sortOrder != null) {
          placementUpdates.sort_order = imageMeta.sortOrder;
        }
        if (imageMeta.isThumbnail != null) {
          placementUpdates.is_thumbnail = imageMeta.isThumbnail;
        }
        if (Object.keys(placementUpdates).length > 0) {
          await ImageJobItem.updateOne(
            {
              job_uuid: jobUuid,
              product_id: item.product_id,
              image_id: item.image_id,
            },
            { $set: placementUpdates }
          );
        }

        const result = await processSingleImageOptimization({
          jobUuid,
          jobType,
          storeHash,
          storeUrl,
          accessToken,
          productId: item.product_id,
          imageId: String(item.image_id),
          imageUrl: item.image_url,
          settings,
          imageMeta,
          forceReoptimize,
          maxAttempts,
          attemptsMade: attempt,
          skipQuotaCheck: Boolean(job.data?.skipQuotaCheck),
        });

        if (result?.skipped) {
          skipped += 1;
        } else {
          processed += 1;
          if (
            !quotaUnlimited &&
            imageResultConsumesQuota(result, settings)
          ) {
            quotaRemaining -= 1;
            if (quotaRemaining <= 0) {
              planLimitHit = true;
            }
          }
        }
        break;
      } catch (err) {
        if (attempt < maxAttempts - 1) {
          await sleepBackoff(attempt);
          continue;
        }

        failed += 1;
        console.error("[image-optimization-worker] batch image failed", {
          jobUuid,
          batchIndex,
          productId: item.product_id,
          imageId: item.image_id,
          attempts: maxAttempts,
          error: err?.message,
        });
      }
    }
  }

  if (planLimitHit && jobUuid && storeHash) {
    const monthlyLimit = batchQuota?.monthly_limit ?? null;
    const monthlyUsed =
      monthlyLimit != null
        ? monthlyLimit - Math.max(0, quotaRemaining)
        : batchQuota?.monthly_used ?? null;

    await pauseJobForPlanLimit({
      jobUuid,
      storeHash,
      evaluation: {
        allowed: false,
        code: "MONTHLY_QUOTA_EXCEEDED",
        message: MONTHLY_PLAN_LIMIT_MESSAGE,
        plan_slug: batchQuota?.usage?.plan_slug || null,
        plan_limit: monthlyLimit,
        monthly_used: monthlyUsed,
        remaining: Math.max(0, quotaRemaining ?? 0),
        images_to_queue: 0,
        upgrade_required: true,
      },
    }).catch((err) => {
      console.error("[image-optimization-worker] pause for plan limit:", err?.message);
    });

    await appendImageLog({
      jobUuid,
      storeHash,
      jobType,
      logType: "warning",
      step: "plan_limit",
      message: "Batch stopped — monthly plan limit reached",
      meta: {
        batch_index: batchIndex,
        processed_in_batch: processed,
        remaining_quota: Math.max(0, quotaRemaining ?? 0),
      },
    }).catch(() => {});
  }

  const batchResult = {
    batchIndex,
    processed,
    skipped,
    failed,
    total: items.length,
    plan_limit_hit: planLimitHit,
  };

  try {
    await handleOptimizationBatchComplete(job.data);
  } catch (err) {
    console.error("[image-optimization-worker] batch follow-up failed", {
      jobUuid,
      batchIndex,
      error: err?.message,
    });
  }

  return batchResult;
}

/**
 * Shared BullMQ processor for all image-optimization queue tiers.
 */
async function processImageOptimizationJob(job) {
  if (job.name === "webhook-process") {
    const result = await processWebhookProductBurst(job.data?.storeHash);
    console.log("[image-optimization-worker] webhook-process", result);
    return result;
  }

  if (job.name === "optimize-batch") {
    console.log("[image-optimization-worker] picked optimize-batch", {
      bullJobId: job.id,
      jobUuid: job.data?.jobUuid,
      batchIndex: job.data?.batchIndex,
      storeHash: job.data?.storeHash,
    });
    if (job.data?.storeHash) {
      await appendImageLog({
        jobUuid: job.data.jobUuid,
        storeHash: job.data.storeHash,
        jobType: job.data.job_type || job.data.type || "bulk",
        logType: "info",
        step: "worker_picked",
        message: "Worker picked optimize-batch job from Redis",
        meta: {
          seq: 3,
          bull_job_id: job.id,
          batch_index: job.data.batchIndex,
          attempts_made: job.attemptsMade,
        },
      });
    }
    return processOptimizationBatchJob(job);
  }

  console.log("[image-optimization-worker] picked optimize-image", {
    bullJobId: job.id,
    jobUuid: job.data?.jobUuid,
    productId: job.data?.productId,
    imageId: job.data?.imageId,
    storeHash: job.data?.storeHash,
    attemptsMade: job.attemptsMade,
  });

  if (job.data?.storeHash) {
    await appendImageLog({
      jobUuid: job.data.jobUuid,
      storeHash: job.data.storeHash,
      jobType: job.data.job_type || job.data.type || "bulk",
      imageId: job.data.imageId,
      productId: job.data.productId,
      logType: "info",
      step: "worker_picked",
      message: "Worker picked optimize-image job from Redis",
      meta: {
        seq: 3,
        bull_job_id: job.id,
        attempts_made: job.attemptsMade,
      },
    });
  }

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
  const maxAttempts = job.opts?.attempts || getJobAttempts();
  const forceReoptimize = Boolean(job.data?.force || job.data?.force_reoptimize);

  return processSingleImageOptimization({
    jobUuid,
    jobType,
    storeHash,
    storeUrl,
    accessToken,
    productId,
    imageId,
    imageUrl,
    settings,
    imageMeta,
    optimization_status: job.data?.optimization_status || job.data?.status || null,
    forceReoptimize,
    maxAttempts,
    attemptsMade: job.attemptsMade,
  });
}

module.exports = { processImageOptimizationJob, processSingleImageOptimization };
