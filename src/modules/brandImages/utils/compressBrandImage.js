const fs = require("node:fs/promises");
const sharp = require("sharp");
const { BrandImage, BrandImageStatus } = require("../../../models");
const StoreImageStat = require("../../../models/StoreImageStat");
const {
  optimizeImage,
  buildOptimizationMetadataFromUrls,
} = require("../../../utils/sharpFunction");
const { downloadImage } = require("../../../utils/downloadImage");
const { resolveImageTypeOptimizeFormat } = require("../../../utils/sharpFunction");
const { replaceBrandImage, verifyBrandImageUpdate } = require("./bigCommerceBrandImage");
const {
  appendBrandImageJobLog,
  resolveBrandJobUuid,
} = require("./brandActivityLog");
const { recordMonthlyOptimization } = require("../../../utils/monthlyUsage");
const { notifyPlanLimitReached } = require("../../../utils/planLimitNotify");

function clampQuality(quality, fallback = 80) {
  const q = Number(quality);
  if (!Number.isFinite(q)) return fallback;
  return Math.min(100, Math.max(1, Math.round(q)));
}

async function markBrandFailed({ storeHash, brandId }) {
  await BrandImageStatus.updateOne(
    { store_hash: storeHash, brand_id: brandId },
    { $set: { status: "failed", image_update_status: "failed" } },
    { upsert: true }
  );
}

async function logBrandStep(logContext, payload) {
  const storeHash = logContext?.storeHash;
  const brandId = logContext?.brandId;
  if (!storeHash || brandId == null) return;

  const { error } = await appendBrandImageJobLog({
    jobUuid: resolveBrandJobUuid(logContext, storeHash, brandId),
    storeHash,
    jobType: logContext.jobType || "single",
    brandId,
    ...payload,
  });

  if (error) {
    console.warn("[compressBrandImage]", error, { step: payload?.step });
  }
}

/**
 * Download → sharp optimize → BC brand upload → MongoDB updates.
 * Mirrors compressCategoryImage exactly but for brands.
 */
exports.compressBrandImage = async ({
  storeHash,
  accessToken,
  brandId,
  imageUrl,
  brandName = null,
  settings = {},
  force = false,
  logContext = null,
}) => {
  const effectiveLogContext = {
    jobType: "single",
    brandId,
    ...logContext,
    storeHash: logContext?.storeHash || storeHash,
  };

  if (!logContext?.skipQuotaCheck) {
    const User = require("../../../models/User");
    const { canOptimizeImages } = require("../../plans/service");
    const user = await User.findOne({ store_hash: storeHash })
      .select({ selectedPlan: 1 })
      .lean();
    const quota = await canOptimizeImages(storeHash, user?.selectedPlan || "free", 1);
    if (!quota.allowed) {
      await notifyPlanLimitReached(storeHash, {
        message: quota.message,
        planName: quota.plan_name || quota.plan?.name || null,
        monthlyLimit: quota.monthly_limit ?? null,
        monthlyUsed: quota.monthly_used ?? null,
      }).catch(() => {});

      const {
        clearStoreBrandOptimizationJobs,
      } = require("../../../queue/brandImageQueue");
      const { pauseBrandJobsForPlanLimit } = require("../services");
      const clearedQueue = await clearStoreBrandOptimizationJobs(storeHash);
      const affectedJobUuids = [
        ...clearedQueue.jobUuids,
        ...(logContext?.jobUuid ? [logContext.jobUuid] : []),
      ];
      await pauseBrandJobsForPlanLimit(storeHash, affectedJobUuids);

      return {
        success: false,
        plan_limit: true,
        error: quota.message,
        code: quota.code,
      };
    }
  }

  let originalImagePath = null;
  let optimizedImagePath = null;

  try {
    // ── 1. Download original image ──────────────────────────────────────────
    const {
      error: downloadError,
      filePath: downloadedPath,
      optimizedImagesDir,
      assetId,
    } = await downloadImage({
      imageUrl,
      storeHash,
      sourceType: "brand",
      productId: brandId,
      imageId: brandId,
    });

    originalImagePath = downloadedPath;

    if (downloadError || !originalImagePath) {
      await markBrandFailed({ storeHash, brandId });
      await logBrandStep(effectiveLogContext, {
        logType: "error",
        step: "download",
        message: downloadError || "Failed to download brand image",
        meta: { image_url: imageUrl },
      });
      return {
        success: false,
        error: downloadError || "Failed to download brand image",
      };
    }

    await logBrandStep(effectiveLogContext, {
      logType: "info",
      step: "download",
      message: "Brand image downloaded for optimization",
      meta: { path: originalImagePath },
    });

    // ── 2. Read image metadata ───────────────────────────────────────────────
    const imageQuality = clampQuality(settings.image_quality);
    const meta = await sharp(originalImagePath, { failOn: "none", animated: false }).metadata();
    const inputFormat = String(meta.format || "jpeg").toLowerCase();
    const isAnimatedGif = inputFormat === "gif" && Number(meta.pages) > 1;

    if (isAnimatedGif) {
      await BrandImageStatus.updateOne(
        { store_hash: storeHash, brand_id: brandId },
        { $set: { status: "skipped", image_update_status: "complete" } },
        { upsert: true }
      );

      await logBrandStep(effectiveLogContext, {
        logType: "info",
        step: "skip",
        message: "Animated GIF skipped. Animation is not supported for brand images.",
        meta: { image_url: imageUrl, brand_name: brandName },
      });

      return {
        success: true,
        skipped: true,
        message: "Animated GIF skipped. Animation is not supported for brand images.",
        data: { brand_id: Number(brandId), brand_name: brandName, status: "skipped" },
      };
    }

    // ── 3. Resolve output format — brand: jpeg, jpg, png only; else keep original ──
    const brandFormat = resolveImageTypeOptimizeFormat(
      "brand",
      settings.output_format,
      inputFormat
    );

    // ── 4. Mark as optimizing in DB ─────────────────────────────────────────
    await Promise.all([
      BrandImageStatus.updateOne(
        { store_hash: storeHash, brand_id: brandId },
        {
          $set: {
            status: "optimizing",
            image_update_status: "processing",
            optimization_started_at: new Date(),
          },
        },
        { upsert: true }
      ),
      BrandImage.updateOne(
        { store_hash: storeHash, brand_id: brandId, original_url: imageUrl },
        {
          $set: {
            brand_name: brandName,
            original_image_path: originalImagePath,
          },
        },
        { upsert: true, setDefaultsOnInsert: true }
      ),
    ]);

    // ── 5. Compress with sharp ───────────────────────────────────────────────
    const { error: optimizeError, optimizedImage } = await optimizeImage(
      originalImagePath,
      {
        quality: imageQuality,
        format: brandFormat,
        outputPath: optimizedImagesDir,
        outputBaseName: assetId,
      }
    );

    if (optimizeError || !optimizedImage?.outputPath) {
      await markBrandFailed({ storeHash, brandId });
      await logBrandStep(effectiveLogContext, {
        logType: "error",
        step: "optimize",
        message: optimizeError || "Brand image optimization failed",
      });
      return {
        success: false,
        error: optimizeError || "Brand image optimization failed",
      };
    }

    optimizedImagePath = optimizedImage.outputPath;

    await logBrandStep(effectiveLogContext, {
      logType: "info",
      step: "optimize",
      message: "Brand image compressed with sharp",
      meta: {
        original_size: optimizedImage.original?.size ?? 0,
        optimized_size: optimizedImage.optimized?.size ?? 0,
      },
    });

    const originalSize = optimizedImage.original?.size ?? 0;
    const optimizedSize = optimizedImage.optimized?.size ?? 0;

    // ── 6. Already optimal — no need to upload ───────────────────────────────
    if (optimizedSize >= originalSize) {
      await Promise.all([
        BrandImageStatus.updateOne(
          { store_hash: storeHash, brand_id: brandId },
          {
            $set: {
              status: "optimized",
              image_update_status: "complete",
              optimized_at: new Date(),
            },
          },
          { upsert: true }
        ),
        BrandImage.updateOne(
          { store_hash: storeHash, brand_id: brandId, original_url: imageUrl },
          {
            $set: {
              brand_name: brandName,
              original_url: imageUrl,
              optimized_url: imageUrl,
              original_image_path: originalImagePath,
              optimized_image_path: optimizedImagePath,
              original: {
                size: originalSize,
                width: optimizedImage.original?.width ?? 0,
                height: optimizedImage.original?.height ?? 0,
                format: optimizedImage.original?.format ?? null,
              },
              optimized: {
                size: optimizedSize,
                width: optimizedImage.optimized?.width ?? 0,
                height: optimizedImage.optimized?.height ?? 0,
                format: optimizedImage.optimized?.format ?? null,
              },
              saved_bytes: 0,
              saved_percentage: 0,
            },
          },
          { upsert: true }
        ),
      ]);

      await updateStoreStats({ storeHash, originalSize, optimizedSize: originalSize, savedBytes: 0 });

      await logBrandStep(effectiveLogContext, {
        logType: "info",
        step: "complete",
        message: "Brand image optimized successfully",
        meta: {
          brand_id: Number(brandId),
          saved_bytes: 0,
          saved_percentage: 0,
          upload_skipped: true,
        },
      });

      return {
        success: true,
        message: "Brand image optimized successfully",
        data: {
          brand_id: Number(brandId),
          brand_name: brandName,
          old_image_url: imageUrl,
          new_image_url: imageUrl,
          optimizedImage,
          status: "optimized",
          upload_skipped: true,
        },
      };
    }

    // ── 7. Upload optimized image to BigCommerce ────────────────────────────
    const fileBuffer = await fs.readFile(optimizedImagePath);
    const uploadResult = await replaceBrandImage({
      storeHash,
      brandId,
      accessToken,
      fileBuffer,
      outputFormat: optimizedImage.format || brandFormat,
    });

    const newImageUrl = uploadResult?.image_url;
    if (!newImageUrl) {
      throw new Error("BigCommerce brand image upload did not return image_url");
    }

    await logBrandStep(effectiveLogContext, {
      logType: "info",
      step: "upload",
      message: "Brand image uploaded to BigCommerce",
      meta: { brand_id: Number(brandId), new_image_url: newImageUrl },
    });

    // ── 8. Verify upload ────────────────────────────────────────────────────
    const verification = await verifyBrandImageUpdate({
      storeHash,
      accessToken,
      brandId,
      expectedImageUrl: newImageUrl,
    });

    await logBrandStep(effectiveLogContext, {
      logType: verification.verified ? "info" : "warning",
      step: "verify",
      message: verification.verified
        ? "Brand image upload verified on BigCommerce"
        : "Brand image upload verification did not confirm the new URL",
      meta: { verified: verification.verified, brand_id: Number(brandId) },
    });

    // ── 9. Build final size metadata ────────────────────────────────────────
    const sizeMeta = await buildOptimizationMetadataFromUrls(imageUrl, newImageUrl, {
      original: {
        size: optimizedImage.original?.size,
        width: optimizedImage.original?.width,
        height: optimizedImage.original?.height,
        format: optimizedImage.original?.format,
      },
      optimized: {
        size: optimizedImage.optimized?.size,
        width: optimizedImage.optimized?.width,
        height: optimizedImage.optimized?.height,
        format: optimizedImage.optimized?.format,
      },
    });

    const savedBytes = sizeMeta.saved_bytes;
    const savedPercent = sizeMeta.saved_percentage;

    // ── 10. Persist final state to DB ───────────────────────────────────────
    await Promise.all([
      BrandImage.updateOne(
        { store_hash: storeHash, brand_id: brandId, original_url: imageUrl },
        {
          $set: {
            brand_name: brandName,
            original_url: imageUrl,
            optimized_url: newImageUrl,
            original_image_path: originalImagePath,
            optimized_image_path: optimizedImagePath,
            original: sizeMeta.original,
            optimized: sizeMeta.optimized,
            saved_bytes: savedBytes,
            saved_percentage: savedPercent,
          },
        },
        { upsert: true }
      ),
      BrandImageStatus.updateOne(
        { store_hash: storeHash, brand_id: brandId },
        {
          $set: {
            status: "optimized",
            image_update_status: verification.verified ? "complete" : "failed",
            optimized_at: new Date(),
          },
        },
        { upsert: true }
      ),
    ]);

    await updateStoreStats({
      storeHash,
      originalSize: Number(sizeMeta.original.size) || 0,
      optimizedSize: Number(sizeMeta.optimized.size) || 0,
      savedBytes,
    });

    await logBrandStep(effectiveLogContext, {
      logType: "info",
      step: "complete",
      message: "Brand image optimization completed",
      meta: {
        brand_id: Number(brandId),
        saved_bytes: savedBytes,
        saved_percentage: savedPercent,
      },
    });

    return {
      success: true,
      message: "Brand image optimized",
      data: {
        brand_id: Number(brandId),
        brand_name: brandName,
        old_image_url: imageUrl,
        new_image_url: newImageUrl,
        optimizedImage: {
          outputPath: optimizedImagePath,
          original: sizeMeta.original,
          optimized: sizeMeta.optimized,
          compression: { savedBytes, savedPercent },
        },
        status: "optimized",
        verification,
        upload: { upload_url: uploadResult.upload_url },
      },
    };
  } catch (error) {
    await markBrandFailed({ storeHash, brandId });

    await logBrandStep(
      {
        jobType: logContext?.jobType || "single",
        brandId,
        storeHash: logContext?.storeHash || storeHash,
        jobUuid: logContext?.jobUuid,
      },
      {
        logType: "error",
        step: "optimize_failed",
        message: error.message || "Brand image optimization failed",
        meta: { brand_id: Number(brandId) },
      }
    );

    try {
      await StoreImageStat.updateOne(
        { store_hash: storeHash },
        {
          $inc: { failed_images: 1 },
          $setOnInsert: { store_hash: storeHash },
        },
        { upsert: true }
      );
    } catch (statErr) {
      console.error("[compressBrandImage] StoreImageStat failed_images error:", statErr);
    }

    return {
      success: false,
      error: error.message || "Brand image optimization failed",
    };
  }
};

async function updateStoreStats({ storeHash, originalSize, optimizedSize, savedBytes }) {
  try {
    const statDoc = await StoreImageStat.findOneAndUpdate(
      { store_hash: storeHash },
      {
        $inc: {
          optimized_images: 1,
          total_original_size: originalSize,
          total_optimized_size: optimizedSize,
          total_saved_bytes: savedBytes,
        },
        $set: { last_optimized_at: new Date() },
        $setOnInsert: { store_hash: storeHash },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const totalOrig = Number(statDoc?.total_original_size) || 0;
    const totalSaved = Number(statDoc?.total_saved_bytes) || 0;
    if (totalOrig > 0) {
      await StoreImageStat.updateOne(
        { store_hash: storeHash },
        { $set: { average_saving_percent: (totalSaved / totalOrig) * 100 } }
      );
    }

    recordMonthlyOptimization(storeHash, "brand").catch((err) => {
      console.error("[compressBrandImage] monthly usage track failed:", err);
    });
  } catch (statErr) {
    console.error("[compressBrandImage] StoreImageStat error:", statErr);
  }
}
