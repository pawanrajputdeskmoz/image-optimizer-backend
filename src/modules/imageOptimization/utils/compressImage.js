const path = require("node:path");
const fs = require("node:fs/promises");
const sharp = require("sharp");
const { del } = require("../../../utils/axiosUtils");
const { deleteFile } = require("../../../utils/deleteFile");
const { downloadImage } = require("../../../utils/downloadImage");
const {
  optimizeImage,
  resolveImageTypeOptimizeFormat,
} = require("../../../utils/sharpFunction");
const { resolveProductImageUrl } = require("./urls");
const {
  ImageOptimization,
  ImageOldData,
  ImageStatus,
  StoreImageStat,
} = require("../../../models");
const {
  updateBigCommerceProductImageMetadata,
  incrementMetadataUpdateStats,
  shouldSkipImageOptimization,
  skipPendingJobItemsForImage,
} = require("../services");
const { recordMonthlyOptimization } = require("../../../utils/monthlyUsage");
const { appendImageLog, resolveJobUuid } = require("./imageActivityLog");
const {
  replaceProductImage,
  resolveOptimizationUploadDescription,
  normalizeUploadDescription,
  fetchProductImageById,
} = require("./bigCommerceProductImage");

async function logCompressActivity(
  logContext,
  { storeHash, productId, imageId },
  payload
) {
  const resolvedStoreHash = logContext?.storeHash || storeHash;
  if (!resolvedStoreHash) {
    return;
  }

  const ctx = {
    storeHash: resolvedStoreHash,
    jobType: logContext?.jobType || "single",
    ...logContext,
  };

  const { error } = await appendImageLog({
    jobUuid: resolveJobUuid(ctx, ctx.storeHash),
    storeHash: ctx.storeHash,
    jobType: ctx.jobType,
    imageId: imageId ?? ctx.imageId,
    productId: productId ?? ctx.productId,
    ...payload,
  });
  if (error) {
    console.warn("[logCompressActivity]", error, { step: payload?.step });
  }
}

/**
 * Download → sharp compress → BC upload → replace image → DB + stats.
 * Reusable from single-image API, bulk worker, or other controllers.
 *
 * @param {object} [logContext] - { jobUuid, storeHash, jobType } for ImageOptimizationLog rows
 */
exports.compressImage = async ({
  storeHash,
  storeUrl,
  accessToken,
  imageId,
  productId,
  imageUrl,
  settings,
  imageMeta = {},
  logContext = null,
  skipQuotaCheck = false,
}) => {
  if (!skipQuotaCheck && storeHash) {
    const User = require("../../../models/User");
    const {
      canOptimizeImages,
      MONTHLY_PLAN_LIMIT_MESSAGE,
    } = require("../../plans/service");
    const user = await User.findOne({ store_hash: storeHash })
      .select({ selectedPlan: 1 })
      .lean();
    const quota = await canOptimizeImages(storeHash, user?.selectedPlan || "free", 1);
    if (!quota.allowed) {
      const { clearStoreOptimizationJobs } = require("../../../queue/imageOptimizationQueues");
      await clearStoreOptimizationJobs(storeHash).catch((err) => {
        console.error("[compressImage] clearStoreOptimizationJobs:", err?.message);
      });
      return {
        success: false,
        plan_limit: true,
        error: quota.message || MONTHLY_PLAN_LIMIT_MESSAGE,
        code: quota.code,
      };
    }
  }
  const effectiveLogContext = {
    jobType: "single",
    productId,
    imageId,
    ...logContext,
    storeHash: logContext?.storeHash || storeHash,
  };
  const {
    oldImageName = null,
    oldAltText = null,
    newImageName = null,
    newAltText = null,
    runFilename = false,
    runAltText = false,
    runOptimize: runOptimizeFromMeta,
    sortOrder = null,
    isThumbnail = null,
  } = imageMeta;

  const runOptimize =
    runOptimizeFromMeta ?? Boolean(settings?.optimize_image_enabled);
  const preservedOldAltText = normalizeUploadDescription(oldAltText) ?? null;
  const preservedNewAltText = runAltText
    ? normalizeUploadDescription(newAltText) ?? null
    : null;

  let filePath = null;
  let optimizedImagePath = null;
  let uploadedImage = null;
  let imageOptimizationDoc = null;

  const buildSkipResponse = (reason) => ({
    success: true,
    skipped: true,
    reason: reason || "Image skipped",
    data: {
      old_image_id: imageId,
      new_image_id: imageId,
      status: "skipped",
      skip_reason: reason,
    },
  });

  const t0 = Date.now();

  try {
    // BC existence is re-verified by replaceProductImage before upload, so no
    // accessToken here (avoids a duplicate BC images-list fetch).
    const { skip, code: skipCode, reason: skipReason } =
      await shouldSkipImageOptimization(storeHash, productId, imageId);

    // Filename/alt-text templates must still apply to already-optimized
    // images: run a metadata-only update for them instead of skipping.
    // Skips for other reasons (e.g. currently optimizing) stay hard skips.
    const metadataOnlyPass = skip
      ? skipCode === "optimized" &&
        ((runFilename && newImageName) || (runAltText && newAltText))
      : !runOptimize;

    if (skip && !metadataOnlyPass) {
      await logCompressActivity(
        effectiveLogContext,
        { storeHash, productId, imageId },
        {
          logType: "warning",
          step: "skip",
          message: skipReason || "Image optimization skipped",
        }
      );
      return buildSkipResponse(skipReason);
    }

    if (metadataOnlyPass) {
      const bcImage = accessToken
        ? await fetchProductImageById({
            storeHash,
            productId,
            imageId,
            accessToken,
          })
        : null;

      if (accessToken && !bcImage) {
        await logCompressActivity(
          effectiveLogContext,
          { storeHash, productId, imageId },
          {
            logType: "warning",
            step: "skip",
            message:
              "Image not found on BigCommerce (already replaced or deleted)",
          }
        );
        return buildSkipResponse(
          "Image not found on BigCommerce (already replaced or deleted)"
        );
      }

      const metadataPayload = {};
      if (sortOrder != null) metadataPayload.sortOrder = sortOrder;
      if (isThumbnail != null) metadataPayload.isThumbnail = isThumbnail;
      if (runFilename && newImageName) metadataPayload.imageFile = newImageName;
      if (runAltText && newAltText) metadataPayload.description = newAltText;

      if (Object.keys(metadataPayload).length > 0) {
        await updateBigCommerceProductImageMetadata({
          storeHash,
          productId,
          imageId,
          accessToken,
          ...metadataPayload,
        });
      }

      await ImageOldData.updateOne(
        { store_hash: storeHash, product_id: productId, image_id: imageId },
        {
          $set: {
            imageName: oldImageName,
            altText: preservedOldAltText,
            ...(runFilename && newImageName ? { newImageName } : {}),
            ...(runAltText && preservedNewAltText ? { newAltText: preservedNewAltText } : {}),
          },
        },
        { upsert: true }
      );

      const filenameUpdated = Boolean(runFilename && newImageName);
      const altTextUpdated = Boolean(runAltText && newAltText);
      const { error: metadataStatError } = await incrementMetadataUpdateStats({
        storeHash,
        filenameUpdated,
        altTextUpdated,
      });
      if (metadataStatError) {
        await logCompressActivity(
          effectiveLogContext,
          { storeHash, productId, imageId },
          {
            logType: "warning",
            step: "stat_update",
            message: "StoreImageStat metadata update failed",
            meta: { error: metadataStatError },
          }
        );
      }

      const existingStatus = await ImageStatus.findOne({
        store_hash: storeHash,
        product_id: productId,
        image_id: imageId,
      })
        .select({ status: 1 })
        .lean();

      return {
        success: true,
        data: {
          old_image_id: imageId,
          new_image_id: imageId,
          new_image_url: imageUrl,
          optimizedImage: {
            compression: { savedBytes: 0, savedPercent: 0 },
            metadataOnly: true,
          },
          metadataOnly: true,
          status: existingStatus?.status || "pending",
          imageMeta: {
            oldImageName,
            oldAltText,
            newImageName: runFilename ? newImageName : null,
            newAltText: runAltText ? newAltText : null,
          },
        },
      };
    }

    const {
      error: downloadError,
      filePath: downloadedFilePath,
      optimizedImagesDir,
      assetId,
    } = await downloadImage({ imageUrl, storeHash, productId, imageId });
    const tDownload = Date.now();

    filePath = downloadedFilePath;

    if (downloadError || !filePath) {
      await deleteFile(filePath).catch(() => {});
      const downloadErrMsg = downloadError || "Failed to download image";
      await logCompressActivity(
        effectiveLogContext,
        { storeHash, productId, imageId },
        {
          logType: "error",
          step: "download",
          message: downloadErrMsg,
          meta: { image_url: imageUrl },
        }
      );
      return { success: false, error: downloadErrMsg };
    }

    logCompressActivity(
      effectiveLogContext,
      { storeHash, productId, imageId },
      {
        logType: "info",
        step: "download",
        message: "Image downloaded for optimization",
        meta: { path: filePath, duration_ms: tDownload - t0 },
      }
    ).catch(() => {});

    const imageQuality = Math.min(
      100,
      Math.max(1, Math.round(Number(settings.image_quality) || 80))
    );
    const optimizationType =
      imageQuality >= 75 ? "high" : imageQuality >= 45 ? "medium" : "low";

    // None of these three depend on each other's result (imageOptimizationDoc
    // is only read later, after compress/replace), so fire them together.
    const [imageOptimizationResult] = await Promise.all([
      ImageOptimization.findOneAndUpdate(
        { store_hash: storeHash, product_id: productId, image_id: imageId },
        {
          $set: {
            bigcommerce_image_url: imageUrl,
            original_image_path: filePath,
            optimization_type: optimizationType,
            image_quality: imageQuality,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ),
      ImageStatus.updateOne(
        { store_hash: storeHash, product_id: productId, image_id: imageId },
        {
          $set: {
            status: "optimizing",
            image_update_status: "processing",
            optimization_started_at: new Date(),
          },
        },
        { upsert: true }
      ),
      ImageOldData.updateOne(
        { store_hash: storeHash, product_id: productId, image_id: imageId },
        {
          $set: {
            original_image_path: filePath,
            imageName: oldImageName,
            altText: preservedOldAltText,
            ...(runFilename && newImageName ? { newImageName } : {}),
            ...(runAltText && preservedNewAltText ? { newAltText: preservedNewAltText } : {}),
          },
        },
        { upsert: true }
      ),
    ]);
    imageOptimizationDoc = imageOptimizationResult;

    const meta = await sharp(filePath, { failOn: "none", animated: false }).metadata();
    const inputFormat = String(meta.format || "jpeg").toLowerCase();
    const productFormat = resolveImageTypeOptimizeFormat(
      "product",
      settings.output_format,
      inputFormat
    );

    const { error: optimizeError, optimizedImage } = await optimizeImage(
      filePath,
      {
        quality: settings.image_quality,
        format: productFormat,
        outputPath: optimizedImagesDir,
        outputBaseName: assetId,
        meta,
      }
    );

    if (optimizeError) {
      await logCompressActivity(
        effectiveLogContext,
        { storeHash, productId, imageId },
        {
          logType: "error",
          step: "optimize_failed",
          message: optimizeError,
        }
      );
      throw new Error(optimizeError);
    }
    optimizedImagePath = optimizedImage.outputPath;
    const tCompress = Date.now();

    logCompressActivity(
      effectiveLogContext,
      { storeHash, productId, imageId },
      {
        logType: "info",
        step: "optimize",
        message: "Image compressed locally",
        meta: {
          output_path: optimizedImagePath,
          saved_bytes: optimizedImage.compression?.savedBytes,
          duration_ms: tCompress - tDownload,
        },
      }
    ).catch(() => {});

    const fileBuf = await fs.readFile(optimizedImage.outputPath);
    const uploadFileName =
      runFilename && newImageName && String(newImageName).trim()
        ? path.basename(String(newImageName).trim())
        : path.basename(optimizedImage.outputPath);
    const uploadDescription = resolveOptimizationUploadDescription({
      runAltText,
      newAltText,
      oldAltText,
    });
    const replacementResult = await replaceProductImage({
      storeHash,
      productId,
      oldImageId: imageId,
      accessToken,
      fileBuffer: fileBuf,
      fileName: uploadFileName,
      description: uploadDescription,
      sortOrder: sortOrder != null ? sortOrder : 1,
      isThumbnail,
      verifyPollIntervalMs: 400,
      verifyMaxRetries: 0,
    });
    const tReplace = Date.now();

    if (replacementResult?.skipped) {
      const skipMessage =
        replacementResult.skipReason ||
        "Image not found on BigCommerce (already replaced or deleted)";

      if (imageOptimizationDoc?._id) {
        await ImageOptimization.deleteOne({ _id: imageOptimizationDoc._id }).catch(
          () => {}
        );
      }

      await ImageStatus.updateOne(
        { store_hash: storeHash, product_id: productId, image_id: imageId },
        {
          $set: {
            status: "pending",
            image_update_status: "idle",
          },
        }
      ).catch(() => {});

      try {
        if (filePath) await deleteFile(filePath);
      } catch {
        // ignore cleanup errors
      }
      try {
        if (optimizedImagePath) await deleteFile(optimizedImagePath);
      } catch {
        // ignore cleanup errors
      }

      await logCompressActivity(
        effectiveLogContext,
        { storeHash, productId, imageId },
        {
          logType: "warning",
          step: "skip",
          message: skipMessage,
        }
      );

      return buildSkipResponse(skipMessage);
    }

    uploadedImage = replacementResult?.newImage || null;
    if (!uploadedImage?.id) {
      throw new Error("Failed to upload optimized image to BigCommerce");
    }

    const newImageId = uploadedImage.id;
    const optimizedBcUrl = resolveProductImageUrl(
      storeUrl,
      uploadedImage.image_file,
      uploadedImage.url_standard || null
    );

    if (!optimizedBcUrl) {
      throw new Error(
        "BigCommerce upload succeeded but image URL could not be built"
      );
    }

    // Activity logs are best-effort; do not block the response on them.
    logCompressActivity(
      effectiveLogContext,
      { storeHash, productId, imageId },
      {
        logType: "info",
        step: "upload",
        message: "Optimized image uploaded to BigCommerce",
        meta: {
          new_image_id: uploadedImage.id,
          duration_ms: tReplace - tCompress,
          verify_attempts: replacementResult?.verification?.attempts,
        },
      }
    ).catch(() => {});

    logCompressActivity(
      effectiveLogContext,
      { storeHash, productId, imageId },
      {
        logType: replacementResult?.verification?.verified ? "info" : "warning",
        step: "complete",
        message: replacementResult?.verification?.verified
          ? "BigCommerce replacement completed"
          : "BigCommerce replacement completed (verify skipped/pending)",
        meta: {
          old_image_id: imageId,
          new_image_id: newImageId,
          verify_attempts: replacementResult?.verification?.attempts,
        },
      }
    ).catch(() => {});

    // optimizedImage.original/optimized already hold the exact bytes read
    // from disk and uploaded to BC, so reuse them instead of re-fetching the
    // same sizes/dimensions from the CDN (BC doesn't alter the file we sent).
    const origSize = Number(optimizedImage.original?.size) || 0;
    const optSize = Number(optimizedImage.optimized?.size) || 0;
    const savedBytes =
      optimizedImage.compression?.savedBytes != null
        ? Math.max(0, optimizedImage.compression.savedBytes)
        : origSize > 0
          ? Math.max(0, origSize - optSize)
          : 0;
    const savedPercent =
      optimizedImage.compression?.savedPercent != null
        ? optimizedImage.compression.savedPercent
        : origSize > 0
          ? Number(((savedBytes / origSize) * 100).toFixed(2))
          : 0;

    const optimizedImageResponse = {
      outputPath: optimizedImage.outputPath,
      usedOriginalBytes: Boolean(optimizedImage.usedOriginalBytes),
      original: {
        ...(optimizedImage.original || {}),
        size: origSize,
      },
      optimized: {
        ...(optimizedImage.optimized || {}),
        size: optSize,
      },
      compression: { savedBytes, savedPercent },
    };

    // Critical status writes must finish before responding (UI depends on them).
    // Stats / skip-pending / monthly usage can finish in the background.
    await Promise.all([
      ImageOptimization.updateOne(
        { _id: imageOptimizationDoc._id },
        {
          $set: {
            image_id: newImageId,
            optimized_image_path: optimizedImage.outputPath,
            bigcommerce_new_image_id: null,
            bigcommerce_optimized_image_url: optimizedBcUrl,
            image_quality:
              Number(optimizedImage.quality) || imageQuality,
          },
        }
      ),
      ImageOldData.updateOne(
        { store_hash: storeHash, product_id: productId, image_id: imageId },
        {
          $set: {
            image_id: newImageId,
            imageName: oldImageName,
            altText: preservedOldAltText,
            ...(runFilename && newImageName ? { newImageName } : {}),
            ...(runAltText && preservedNewAltText ? { newAltText: preservedNewAltText } : {}),
            original: optimizedImageResponse.original,
            optimized: optimizedImageResponse.optimized,
            saved_bytes: savedBytes,
            saved_percentage: savedPercent,
          },
        },
        { upsert: true }
      ),
      ImageStatus.updateOne(
        { store_hash: storeHash, product_id: productId, image_id: imageId },
        {
          $set: {
            image_id: newImageId,
            status: "optimized",
            image_update_status: "complete",
            optimized_at: new Date(),
          },
        },
        { upsert: true }
      ),
    ]);

    const filenameUpdated = Boolean(runFilename && newImageName);
    const altTextUpdated = Boolean(runAltText && newAltText);

    Promise.all([
      (async () => {
        try {
          const statDoc = await StoreImageStat.findOneAndUpdate(
            { store_hash: storeHash },
            {
              $inc: {
                optimized_images: 1,
                total_original_size: origSize,
                total_optimized_size: optSize,
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

          recordMonthlyOptimization(storeHash, "product").catch((err) => {
            console.error("[compressImage] monthly usage track failed:", err);
          });
        } catch (statErr) {
          console.error("[compressImage] StoreImageStat error:", statErr);
        }
      })(),
      filenameUpdated || altTextUpdated
        ? incrementMetadataUpdateStats({
            storeHash,
            filenameUpdated,
            altTextUpdated,
          })
        : Promise.resolve(),
      skipPendingJobItemsForImage({
        storeHash,
        productId,
        imageId,
        skipReason: "Image optimized elsewhere",
        excludeJobUuid: effectiveLogContext?.jobUuid || null,
      }),
    ]).catch((err) => {
      console.warn("[compressImage] background finalize failed:", err?.message || err);
    });

    console.log("[compressImage] timing_ms", {
      productId,
      imageId,
      download: tDownload - t0,
      compress: tCompress - tDownload,
      bc_replace: tReplace - tCompress,
      finalize: Date.now() - tReplace,
      total: Date.now() - t0,
    });

    return {
      success: true,
      data: {
        old_image_id: imageId,
        new_image_id: newImageId,
        new_image_url: optimizedBcUrl,
        optimizedImage: optimizedImageResponse,
        status: "optimized",
        imageMeta: {
          oldImageName,
          oldAltText,
          newImageName: runFilename ? newImageName : null,
          newAltText: runAltText ? newAltText : null,
        },
      },
    };
  } catch (error) {
    try {
      await ImageStatus.updateOne(
        { store_hash: storeHash, product_id: productId, image_id: imageId },
        { $set: { status: "failed", image_update_status: "failed" } },
        { upsert: true }
      );
      await StoreImageStat.updateOne(
        { store_hash: storeHash },
        {
          $inc: { failed_images: 1 },
          $setOnInsert: { store_hash: storeHash },
        },
        { upsert: true }
      );
    } catch (rollbackErr) {
      console.error("[compressImage] Rollback error:", rollbackErr);
      await logCompressActivity(
        effectiveLogContext,
        { storeHash, productId, imageId },
        {
          logType: "warning",
          step: "rollback",
          message: "Rollback status/stat update failed",
          meta: { error: rollbackErr?.message || String(rollbackErr) },
        }
      );
    }

    try { if (filePath) await deleteFile(filePath); } catch { }
    try { if (optimizedImagePath) await deleteFile(optimizedImagePath); } catch { }

    console.error("[compressImage] Error:", error.message);
    await logCompressActivity(
      effectiveLogContext,
      { storeHash, productId, imageId },
      {
        logType: "error",
        step: "optimize_failed",
        message: error.message || "Image optimization failed",
        meta: { stack: error.stack },
      }
    );
    return { success: false, error: error.message };
  }
};
