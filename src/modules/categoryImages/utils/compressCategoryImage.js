const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const config = require("../../../config");
const { CategoryImage, CategoryImageStatus } = require("../../../models");
const StoreImageStat = require("../../../models/StoreImageStat");
const {
  optimizeImage,
  buildOptimizationMetadataFromUrls,
} = require("../../../utils/sharpFunction");
const { resolveCategoryOptimizeFormat } = require("./categoryImageOptimize");
const {
  downloadCategoryImageToStorage,
} = require("./categoryImageStorage");
const {
  replaceCategoryImage,
  verifyCategoryImageUpdate,
} = require("./bigCommerceCategoryImage");
const {
  appendCategoryImageLog,
  resolveCategoryJobUuid,
} = require("./categoryActivityLog");

function clampQuality(quality, fallback = 80) {
  const q = Number(quality);
  if (!Number.isFinite(q)) return fallback;
  return Math.min(100, Math.max(1, Math.round(q)));
}

function resolveOptimizationType(imageQuality) {
  if (imageQuality >= 75) return "high";
  if (imageQuality >= 45) return "medium";
  return "low";
}

function filenameFromUrl(url) {
  try {
    const name = path.basename(new URL(url).pathname);
    return name && name !== "/" ? name : null;
  } catch {
    return null;
  }
}

async function logCategoryStep(logContext, payload) {
  const storeHash = logContext?.storeHash;
  const categoryId = logContext?.categoryId;
  if (!storeHash || categoryId == null) return;

  const { error } = await appendCategoryImageLog({
    jobUuid: resolveCategoryJobUuid(logContext, storeHash, categoryId),
    storeHash,
    channelId: logContext.channelId ?? 1,
    treeId: logContext.treeId ?? null,
    jobType: logContext.jobType || "single",
    categoryId,
    ...payload,
  });

  if (error) {
    console.warn("[compressCategoryImage]", error, { step: payload?.step });
  }
}

async function markCategoryFailed({
  storeHash,
  channelId,
  treeId,
  categoryId,
}) {
  await CategoryImageStatus.updateOne(
    { store_hash: storeHash, category_id: categoryId },
    {
      $set: {
        status: "failed",
        image_update_status: "failed",
        channel_id: channelId,
        ...(treeId != null ? { tree_id: treeId } : {}),
      },
    },
    { upsert: true }
  );
}

/**
 * Download → sharp optimize → BC category upload → MongoDB updates.
 */
exports.compressCategoryImage = async ({
  storeHash,
  accessToken,
  channelId = 1,
  treeId = null,
  categoryId,
  imageUrl,
  categoryName = null,
  settings = {},
  force = false,
  logContext = null,
}) => {
  const effectiveLogContext = {
    jobType: "single",
    categoryId,
    channelId,
    treeId,
    ...logContext,
    storeHash: logContext?.storeHash || storeHash,
  };

  let originalImagePath = null;
  let optimizedImagePath = null;

  try {
    const {
      error: downloadError,
      originalImagePath: downloadedPath,
      optimizedImagesDir,
      assetId,
    } = await downloadCategoryImageToStorage({
      imageUrl,
      storeHash,
      categoryId,
    });

    originalImagePath = downloadedPath;

    if (downloadError || !originalImagePath) {
      await markCategoryFailed({
        storeHash,
        channelId,
        treeId,
        categoryId,
      });
      await logCategoryStep(effectiveLogContext, {
        logType: "error",
        step: "download",
        message: downloadError || "Failed to download category image",
        meta: { image_url: imageUrl },
      });
      return {
        success: false,
        error: downloadError || "Failed to download category image",
      };
    }

    await logCategoryStep(effectiveLogContext, {
      logType: "info",
      step: "download",
      message: "Category image downloaded for optimization",
      meta: { path: originalImagePath },
    });

    const imageQuality = clampQuality(settings.image_quality);
    const optimizationType = resolveOptimizationType(imageQuality);
    const meta = await sharp(originalImagePath, {
      failOn: "none",
      animated: false,
    }).metadata();

    const inputFormat = String(meta.format || "jpeg").toLowerCase();
    const isAnimatedGif =
      inputFormat === "gif" && Number(meta.pages) > 1;

    if (isAnimatedGif) {
      await CategoryImageStatus.updateOne(
        { store_hash: storeHash, category_id: categoryId },
        {
          $set: {
            status: "skipped",
            image_update_status: "complete",
            original_url: imageUrl,
            channel_id: channelId,
            ...(treeId != null ? { tree_id: treeId } : {}),
          },
        },
        { upsert: true }
      );

      await logCategoryStep(effectiveLogContext, {
        logType: "info",
        step: "skip",
        message:
          "Animated GIF skipped. Animation is not supported for category images.",
        meta: { image_url: imageUrl, category_name: categoryName },
      });

      return {
        success: true,
        skipped: true,
        message:
          "Animated GIF skipped. Animation is not supported for category images.",
        data: {
          category_id: Number(categoryId),
          category_name: categoryName,
          status: "skipped",
        },
      };
    }

    const categoryFormat = resolveCategoryOptimizeFormat(
      settings.output_format,
      inputFormat,
      Boolean(meta.hasAlpha)
    );

    await Promise.all([
      CategoryImageStatus.updateOne(
        { store_hash: storeHash, category_id: categoryId },
        {
          $set: {
            status: "optimizing",
            image_update_status: "processing",
            optimization_started_at: new Date(),
            original_url: imageUrl,
            channel_id: channelId,
            ...(treeId != null ? { tree_id: treeId } : {}),
          },
        },
        { upsert: true }
      ),
      CategoryImage.updateOne(
        { store_hash: storeHash, category_id: categoryId, original_url: imageUrl },
        {
          $set: {
            channel_id: channelId,
            tree_id: treeId,
            category_name: categoryName,
            original_image_path: originalImagePath,
          },
        },
        { upsert: true, setDefaultsOnInsert: true }
      ),
    ]);

    await logCategoryStep(effectiveLogContext, {
      logType: "info",
      step: "optimize",
      message: "Category image optimization in progress",
      meta: {
        image_url: imageUrl,
        optimization_type: optimizationType,
        output_format: categoryFormat,
        image_quality: imageQuality,
      },
    });

    const { error: optimizeError, optimizedImage } = await optimizeImage(
      originalImagePath,
      {
        quality: imageQuality,
        format: categoryFormat,
        outputPath: optimizedImagesDir,
        outputBaseName: assetId,
      }
    );

    if (optimizeError || !optimizedImage?.outputPath) {
      await markCategoryFailed({
        storeHash,
        channelId,
        treeId,
        categoryId,
      });
      await logCategoryStep(effectiveLogContext, {
        logType: "error",
        step: "optimize_failed",
        message: optimizeError || "Category image optimization failed",
      });
      return {
        success: false,
        error: optimizeError || "Category image optimization failed",
      };
    }

    optimizedImagePath = optimizedImage.outputPath;

    await logCategoryStep(effectiveLogContext, {
      logType: "info",
      step: "optimize",
      message: "Category image compressed locally",
      meta: {
        output_path: optimizedImagePath,
        original_size: optimizedImage.original?.size,
        optimized_size: optimizedImage.optimized?.size,
        saved_bytes: optimizedImage.compression?.savedBytes,
        saved_percent: optimizedImage.compression?.savedPercent,
      },
    });

    const originalSize = optimizedImage.original?.size ?? 0;
    const optimizedSize = optimizedImage.optimized?.size ?? 0;

    if (optimizedSize >= originalSize) {
      await Promise.all([
        CategoryImageStatus.updateOne(
          { store_hash: storeHash, category_id: categoryId },
          {
            $set: {
              status: "optimized",
              image_update_status: "complete",
              original_url: imageUrl,
              optimized_url: imageUrl,
              optimized_at: new Date(),
              channel_id: channelId,
              ...(treeId != null ? { tree_id: treeId } : {}),
            },
          },
          { upsert: true }
        ),
        CategoryImage.updateOne(
          { store_hash: storeHash, category_id: categoryId, original_url: imageUrl },
          {
            $set: {
              channel_id: channelId,
              tree_id: treeId,
              category_name: categoryName,
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

      await logCategoryStep(effectiveLogContext, {
        logType: "info",
        step: "complete",
        message: "Category image already at optimal quality, marked as optimized",
        meta: {
          category_id: categoryId,
          category_name: categoryName,
          image_url: imageUrl,
          original_size: originalSize,
          optimized_size: optimizedSize,
          saved_bytes: 0,
          saved_percent: 0,
        },
      });

      try {
        const statDoc = await StoreImageStat.findOneAndUpdate(
          { store_hash: storeHash },
          {
            $inc: {
              optimized_images: 1,
              total_original_size: originalSize,
              total_optimized_size: originalSize,
              total_saved_bytes: 0,
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
        console.error("[compressCategoryImage] StoreImageStat error (already optimal):", statErr);
      }

      return {
        success: true,
        skipped: false,
        message: "Category image already at optimal quality, marked as optimized",
        data: {
          category_id: Number(categoryId),
          category_name: categoryName,
          old_image_url: imageUrl,
          new_image_url: imageUrl,
          optimizedImage,
          status: "optimized",
        },
      };
    }

    const fileBuffer = await fs.readFile(optimizedImagePath);
    const uploadResult = await replaceCategoryImage({
      storeHash,
      categoryId,
      accessToken,
      fileBuffer,
      outputFormat: optimizedImage.format || categoryFormat,
      treeId,
    });

    const newImageUrl = uploadResult?.image_url;
    if (!newImageUrl) {
      throw new Error("BigCommerce category image upload did not return image_url");
    }

    await logCategoryStep(effectiveLogContext, {
      logType: "info",
      step: "upload",
      message: "Optimized category image uploaded to BigCommerce",
      meta: {
        new_image_url: newImageUrl,
        upload_url: uploadResult.upload_url,
      },
    });

    await logCategoryStep(effectiveLogContext, {
      logType: uploadResult.tree_sync?.synced ? "info" : "warning",
      step: "bc_metadata",
      message: uploadResult.tree_sync?.synced
        ? "Category tree image_url synced on BigCommerce"
        : uploadResult.tree_sync?.reason ||
          "Category tree image_url sync skipped or failed",
      meta: {
        tree_id: treeId,
        image_url: newImageUrl,
        tree_sync: uploadResult.tree_sync,
      },
    });

    const verification = await verifyCategoryImageUpdate({
      storeHash,
      accessToken,
      categoryId,
      treeId,
      expectedImageUrl: newImageUrl,
    });

    await logCategoryStep(effectiveLogContext, {
      logType: verification.verified ? "info" : "warning",
      step: "verify",
      message: verification.verified
        ? "Category image update verified"
        : verification.reason || "Category image verification pending",
      meta: { verified: verification.verified },
    });

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

    await Promise.all([
      CategoryImage.updateOne(
        { store_hash: storeHash, category_id: categoryId, original_url: imageUrl },
        {
          $set: {
            channel_id: channelId,
            tree_id: treeId,
            category_name: categoryName,
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
      CategoryImageStatus.updateOne(
        { store_hash: storeHash, category_id: categoryId },
        {
          $set: {
            status: "optimized",
            image_update_status: verification.verified ? "complete" : "failed",
            original_url: imageUrl,
            optimized_url: newImageUrl,
            optimized_at: new Date(),
            channel_id: channelId,
            ...(treeId != null ? { tree_id: treeId } : {}),
          },
        },
        { upsert: true }
      ),
    ]);

    await logCategoryStep(effectiveLogContext, {
      logType: "info",
      step: "complete",
      message: "Category image optimized and saved to database",
      meta: {
        category_id: categoryId,
        category_name: categoryName,
        original_url: imageUrl,
        optimized_url: newImageUrl,
        original_image_path: originalImagePath,
        optimized_image_path: optimizedImagePath,
        original_size: sizeMeta.original.size,
        optimized_size: sizeMeta.optimized.size,
        saved_bytes: savedBytes,
        saved_percent: savedPercent,
        verified: verification.verified,
      },
    });

    try {
      const origSize = Number(sizeMeta.original.size) || 0;
      const optSize = Number(sizeMeta.optimized.size) || 0;
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
      console.error("[compressCategoryImage] StoreImageStat error:", statErr);
    }

    return {
      success: true,
      message: "Category image optimized",
      data: {
        category_id: Number(categoryId),
        category_name: categoryName,
        old_image_url: imageUrl,
        new_image_url: newImageUrl,
        optimizedImage: {
          outputPath: optimizedImagePath,
          original: {
            size: sizeMeta.original.size,
            width: sizeMeta.original.width,
            height: sizeMeta.original.height,
            format: sizeMeta.original.format,
          },
          optimized: {
            size: sizeMeta.optimized.size,
            width: sizeMeta.optimized.width,
            height: sizeMeta.optimized.height,
            format: sizeMeta.optimized.format,
          },
          compression: {
            savedBytes,
            savedPercent,
          },
        },
        status: "optimized",
        verification,
        upload: {
          upload_url: uploadResult.upload_url,
          tree_sync: uploadResult.tree_sync,
        },
      },
    };
  } catch (error) {
    await markCategoryFailed({
      storeHash,
      channelId,
      treeId,
      categoryId,
    });

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
      console.error("[compressCategoryImage] StoreImageStat failed_images error:", statErr);
    }

    await logCategoryStep(effectiveLogContext, {
      logType: "error",
      step: "optimize_failed",
      message: error.message || "Category image optimization failed",
      meta: { stack: error.stack },
    });
    return {
      success: false,
      error: error.message || "Category image optimization failed",
    };
  }
};

exports.clampQuality = clampQuality;
exports.resolveOptimizationType = resolveOptimizationType;
exports.filenameFromUrl = filenameFromUrl;
