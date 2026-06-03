const path = require("node:path");
const fs = require("node:fs/promises");
const { del } = require("./axiosUtils");
const { deleteFile } = require("./deleteFile");
const { downloadImage } = require("./downloadImage");
const {
  optimizeImage,
  getImageSizeFromUrl,
  getImageSizeFromUrlWithRetry,
  resolveOptimizeFormat,
} = require("./sharpFunction");
const { resolveProductImageUrl } = require("./urls");
const {
  ImageOptimization,
  ImageOldData,
  ImageStatus,
  StoreImageStat,
} = require("../models");
const {
  updateBigCommerceProductImageMetadata,
} = require("../modules/imageOptimization/services");
const { appendImageLog, resolveJobUuid } = require("./imageActivityLog");
const {
  replaceProductImage,
  purgeExternalCache,
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

  await appendImageLog({
    jobUuid: resolveJobUuid(ctx, ctx.storeHash),
    storeHash: ctx.storeHash,
    jobType: ctx.jobType,
    imageId: imageId ?? ctx.imageId,
    productId: productId ?? ctx.productId,
    ...payload,
  });
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
}) => {
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

  let filePath = null;
  let optimizedImagePath = null;
  let uploadedImage = null;
  let imageOptimizationDoc = null;

  try {
    const {
      error: downloadError,
      filePath: downloadedFilePath,
      optimizedImagesDir,
      assetId,
    } = await downloadImage({ imageUrl, storeHash, productId, imageId });

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

    await logCompressActivity(
      effectiveLogContext,
      { storeHash, productId, imageId },
      {
        logType: "info",
        step: "download",
        message: "Image downloaded for optimization",
        meta: { path: filePath },
      }
    );

    const imageQuality = Math.min(
      100,
      Math.max(1, Math.round(Number(settings.image_quality) || 80))
    );
    const optimizationType =
      imageQuality >= 75 ? "high" : imageQuality >= 45 ? "medium" : "low";

    imageOptimizationDoc = await ImageOptimization.findOneAndUpdate(
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
    );

    await Promise.all([
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
            altText: oldAltText,
            ...(runFilename && newImageName ? { newImageName } : {}),
            ...(runAltText && newAltText ? { newAltText } : {}),
          },
        },
        { upsert: true }
      ),
    ]);

    if (!runOptimize) {
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

      await ImageStatus.updateOne(
        { store_hash: storeHash, product_id: productId, image_id: imageId },
        {
          $set: {
            status: "optimized",
            image_update_status: "complete",
            optimized_at: new Date(),
          },
        },
        { upsert: true }
      );

      try {
        await StoreImageStat.findOneAndUpdate(
          { store_hash: storeHash },
          {
            $inc: { optimized_images: 1 },
            $set: { last_optimized_at: new Date() },
            $setOnInsert: { store_hash: storeHash },
          },
          { upsert: true, new: true }
        );
      } catch (statErr) {
        console.error("[compressImage] StoreImageStat error:", statErr);
        await logCompressActivity(
          effectiveLogContext,
          { storeHash, productId, imageId },
          {
            logType: "warning",
            step: "stat_update",
            message: "StoreImageStat update failed (metadata-only path)",
            meta: { error: statErr?.message || String(statErr) },
          }
        );
      }

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
          status: "optimized",
          imageMeta: {
            oldImageName,
            oldAltText,
            newImageName: runFilename ? newImageName : null,
            newAltText: runAltText ? newAltText : null,
          },
        },
      };
    }

    const { error: optimizeError, optimizedImage } = await optimizeImage(
      filePath,
      {
        quality: settings.image_quality,
        format: resolveOptimizeFormat(settings.output_format),
        outputPath: optimizedImagesDir,
        outputBaseName: assetId,
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

    await logCompressActivity(
      effectiveLogContext,
      { storeHash, productId, imageId },
      {
        logType: "info",
        step: "optimize",
        message: "Image compressed locally",
        meta: {
          output_path: optimizedImagePath,
          saved_bytes: optimizedImage.compression?.savedBytes,
        },
      }
    );

    const fileBuf = await fs.readFile(optimizedImage.outputPath);
    const uploadFileName =
      runFilename && newImageName && String(newImageName).trim()
        ? String(newImageName).trim()
        : path.basename(optimizedImage.outputPath);
    const uploadDescription =
      runAltText && newAltText && String(newAltText).trim()
        ? String(newAltText).trim()
        : oldAltText && String(oldAltText).trim()
          ? String(oldAltText).trim()
          : "Optimized image";
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
      verifyPollIntervalMs: 1000,
      verifyMaxRetries: 10,
    });

    uploadedImage = replacementResult?.newImage || null;
    if (!uploadedImage?.id) {
      throw new Error("Failed to upload optimized image to BigCommerce");
    }

    await logCompressActivity(
      effectiveLogContext,
      { storeHash, productId, imageId },
      {
        logType: "info",
        step: "upload",
        message: "Optimized image uploaded to BigCommerce",
        meta: { new_image_id: uploadedImage.id },
      }
    );

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

    if (replacementResult?.verification?.verified) {
      await logCompressActivity(
        effectiveLogContext,
        { storeHash, productId, imageId },
        {
          logType: "info",
          step: "complete",
          message: "BigCommerce replacement verified",
          meta: {
            old_image_id: imageId,
            new_image_id: newImageId,
            verify_attempts: replacementResult?.verification?.attempts,
          },
        }
      );
    } else {
      await logCompressActivity(
        effectiveLogContext,
        { storeHash, productId, imageId },
        {
          logType: "warning",
          step: "complete",
          message:
            "BigCommerce replacement not fully verified within polling window",
          meta: {
            old_image_id: imageId,
            new_image_id: newImageId,
            verify_attempts: replacementResult?.verification?.attempts,
          },
        }
      );
    }

    const sizeFetchOptions = {
      retries: Number(process.env.BC_IMAGE_SIZE_FETCH_RETRIES) || 4,
      retryDelayMs: Number(process.env.BC_IMAGE_SIZE_FETCH_DELAY_MS) || 750,
    };

    const [originalFromBc, optimizedFromBc] = await Promise.all([
      getImageSizeFromUrl(imageUrl, sizeFetchOptions),
      getImageSizeFromUrlWithRetry(optimizedBcUrl, sizeFetchOptions),
    ]);

    if (optimizedFromBc.bytes == null) {
      throw new Error(
        optimizedFromBc.error ||
        "Failed to calculate optimized image size from storefront URL"
      );
    }

    const origSize =
      Number(optimizedImage.original?.size) ||
      Number(originalFromBc.bytes) ||
      0;
    const optSize =
      Number(optimizedImage.optimized?.size) ||
      Number(optimizedFromBc.bytes) ||
      0;
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
        width: originalFromBc.width ?? optimizedImage.original?.width,
        height: originalFromBc.height ?? optimizedImage.original?.height,
        format: originalFromBc.format ?? optimizedImage.original?.format,
        size: origSize,
      },
      optimized: {
        width: optimizedFromBc.width ?? optimizedImage.optimized?.width,
        height: optimizedFromBc.height ?? optimizedImage.optimized?.height,
        format: optimizedFromBc.format ?? optimizedImage.optimized?.format,
        size: optSize,
      },
      compression: { savedBytes, savedPercent },
    };

    const purgeResult = await purgeExternalCache({
      productId,
      imageId: newImageId,
      imageUrl: optimizedBcUrl,
    });
    await logCompressActivity(
      effectiveLogContext,
      { storeHash, productId, imageId },
      {
        logType: purgeResult.failed > 0 ? "warning" : "info",
        step: "complete",
        message: purgeResult.attempted
          ? "External cache purge completed"
          : "External cache purge skipped (no endpoints configured)",
        meta: purgeResult,
      }
    );

    await ImageOptimization.updateOne(
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
    );

    await Promise.all([
      ImageOldData.updateOne(
        { store_hash: storeHash, product_id: productId, image_id: imageId },
        {
          $set: {
            image_id: newImageId,
            imageName: oldImageName,
            altText: oldAltText,
            ...(runFilename && newImageName ? { newImageName } : {}),
            ...(runAltText && newAltText ? { newAltText } : {}),
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
    } catch (statErr) {
      console.error("[compressImage] StoreImageStat error:", statErr);
      await logCompressActivity(
        effectiveLogContext,
        { storeHash, productId, imageId },
        {
          logType: "warning",
          step: "stat_update",
          message: "StoreImageStat update failed after optimization",
          meta: { error: statErr?.message || String(statErr) },
        }
      );
    }

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
