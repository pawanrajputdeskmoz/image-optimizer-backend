const fs = require("node:fs/promises");
const path = require("node:path");
const { CategoryImage, CategoryImageStatus } = require("../../../models");
const { deleteFile } = require("../../../utils/deleteFile");
const {
  uploadCategoryImage,
  verifyCategoryImageUpdate,
} = require("./bigCommerceCategoryImage");
const {
  appendCategoryImageLog,
  standaloneCategoryJobUuid,
} = require("./categoryActivityLog");

async function logRestoreActivity({
  storeHash,
  channelId,
  treeId,
  categoryId,
  logType = "info",
  step = null,
  message,
  meta = {},
}) {
  if (!storeHash || categoryId == null || !message) return;

  await appendCategoryImageLog({
    jobUuid: standaloneCategoryJobUuid(storeHash, categoryId),
    storeHash,
    channelId,
    treeId,
    jobType: "restore_single",
    categoryId,
    logType,
    step,
    message,
    meta,
  });
}

function resolveOutputFormatFromPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".png") return "png";
  if (ext === ".gif") return "gif";
  if (ext === ".ico") return "ico";
  return "jpeg";
}

/**
 * Validate whether a category image can be restored.
 * Returns { ok, skipReason, statusCode, data, categoryImage, categoryImageStatus, originalPath, originalStat }.
 */
async function validateCategoryRestoreEligibility({ storeHash, channelId, categoryId }) {
  const query = {
    store_hash: storeHash,
    channel_id: Number(channelId),
    category_id: Number(categoryId),
  };

  const [categoryImage, categoryImageStatus] = await Promise.all([
    CategoryImage.findOne(query).lean(),
    CategoryImageStatus.findOne(query).lean(),
  ]);

  if (!categoryImage && !categoryImageStatus) {
    return {
      ok: false,
      skipReason: "No optimization record found for this category",
      statusCode: 404,
    };
  }

  const currentStatus = categoryImageStatus?.status;
  if (currentStatus && !["optimized", "uploaded"].includes(currentStatus)) {
    return {
      ok: false,
      skipReason: `Category image cannot be restored because current status is "${currentStatus}", not "optimized"`,
      statusCode: 400,
    };
  }

  const originalPath = categoryImage?.original_image_path || null;

  if (!originalPath) {
    return {
      ok: false,
      skipReason:
        "Original image backup path not found in database. The file may have been removed already.",
      statusCode: 404,
    };
  }

  let originalStat;
  try {
    originalStat = await fs.stat(originalPath);
  } catch {
    return {
      ok: false,
      skipReason: "Original image backup file is missing on disk. Restore cannot continue.",
      statusCode: 404,
      data: { original_image_path: originalPath },
    };
  }

  if (!originalStat.isFile()) {
    return {
      ok: false,
      skipReason: "Original image backup path does not point to a valid file.",
      statusCode: 400,
    };
  }

  return {
    ok: true,
    categoryImage,
    categoryImageStatus,
    originalPath,
    originalStat,
  };
}

/**
 * Restore a category image to its original backup on BigCommerce and clean up DB/file state.
 */
async function restoreSingleCategoryImage({
  storeHash,
  accessToken,
  channelId,
  categoryId,
  treeId = null,
}) {
  const logBase = { storeHash, channelId, treeId, categoryId };

  const validation = await validateCategoryRestoreEligibility({
    storeHash,
    channelId,
    categoryId,
  });

  if (!validation.ok) {
    await logRestoreActivity({
      ...logBase,
      logType: "warning",
      step: "skip",
      message: validation.skipReason,
      meta: { status_code: validation.statusCode },
    });

    return {
      success: false,
      error: validation.skipReason,
      statusCode: validation.statusCode,
      data: validation.data || null,
      skipped: true,
    };
  }

  const { categoryImage, originalPath } = validation;
  const resolvedTreeId = treeId || categoryImage?.tree_id || null;
  const outputFormat = resolveOutputFormatFromPath(originalPath);

  // Read original image file from disk
  let fileBuffer;
  try {
    fileBuffer = await fs.readFile(originalPath);
  } catch (readErr) {
    const msg = readErr.message || "Failed to read original image file from disk";
    await logRestoreActivity({
      ...logBase,
      treeId: resolvedTreeId,
      logType: "error",
      step: "restore",
      message: msg,
      meta: { original_image_path: originalPath, error: msg },
    });
    return {
      success: false,
      error: msg,
      statusCode: 500,
      skipped: false,
    };
  }

  // Upload original image back to BigCommerce
  let uploadResult;
  try {
    uploadResult = await uploadCategoryImage({
      storeHash,
      categoryId,
      accessToken,
      fileBuffer,
      outputFormat,
      treeId: resolvedTreeId,
    });
  } catch (uploadErr) {
    const uploadErrMsg =
      uploadErr?.response?.data?.title ||
      uploadErr?.response?.data?.message ||
      uploadErr?.message ||
      "Failed to upload restored image to BigCommerce";

    await logRestoreActivity({
      ...logBase,
      treeId: resolvedTreeId,
      logType: "error",
      step: "upload",
      message: uploadErrMsg,
      meta: {
        status: uploadErr?.response?.status,
        detail: uploadErr?.response?.data,
      },
    });

    return {
      success: false,
      error: uploadErrMsg,
      statusCode: uploadErr?.response?.status || 502,
      skipped: false,
    };
  }

  const restoredImageUrl = uploadResult?.image_url || null;

  if (!restoredImageUrl) {
    const msg = "BigCommerce did not return an image URL after upload";
    await logRestoreActivity({
      ...logBase,
      treeId: resolvedTreeId,
      logType: "error",
      step: "upload",
      message: msg,
    });
    return {
      success: false,
      error: msg,
      statusCode: 502,
      skipped: false,
    };
  }

  await logRestoreActivity({
    ...logBase,
    treeId: resolvedTreeId,
    logType: "info",
    step: "upload",
    message: "Restored original category image uploaded to BigCommerce",
    meta: {
      restored_image_url: restoredImageUrl,
      tree_sync: uploadResult.tree_sync,
    },
  });

  // Verify the image is live on BigCommerce
  const verification = await verifyCategoryImageUpdate({
    storeHash,
    accessToken,
    categoryId,
    treeId: resolvedTreeId,
    expectedImageUrl: restoredImageUrl,
  });

  if (!verification.verified) {
    await logRestoreActivity({
      ...logBase,
      treeId: resolvedTreeId,
      logType: "warning",
      step: "verify",
      message: `Category image uploaded but verification failed: ${verification.reason}`,
      meta: { restored_image_url: restoredImageUrl, reason: verification.reason },
    });
  } else {
    await logRestoreActivity({
      ...logBase,
      treeId: resolvedTreeId,
      logType: "info",
      step: "verify",
      message: "Category image restore verified successfully on BigCommerce",
      meta: { image_url: verification.image_url },
    });
  }

  // Clean up optimization records from the database
  const dbQuery = {
    store_hash: storeHash,
    channel_id: Number(channelId),
    category_id: Number(categoryId),
  };

  try {
    await Promise.all([
      CategoryImage.deleteOne(dbQuery),
      CategoryImageStatus.deleteOne(dbQuery),
    ]);
  } catch (dbCleanErr) {
    console.error("[restoreSingleCategoryImage] DB cleanup error:", dbCleanErr.message);
    await logRestoreActivity({
      ...logBase,
      treeId: resolvedTreeId,
      logType: "warning",
      step: "file_cleanup",
      message: "Failed to fully clean up database records after category restore",
      meta: { error: dbCleanErr.message },
    });
  }

  // Delete local image files from disk
  const optimizedPath = categoryImage?.optimized_image_path || null;

  await Promise.all([
    deleteFile(originalPath).catch((err) => {
      console.error("[restoreSingleCategoryImage] delete original file:", err.message);
    }),
    optimizedPath
      ? deleteFile(optimizedPath).catch((err) => {
          console.error("[restoreSingleCategoryImage] delete optimized file:", err.message);
        })
      : Promise.resolve(),
  ]);

  await logRestoreActivity({
    ...logBase,
    treeId: resolvedTreeId,
    logType: "info",
    step: "restore",
    message: "Category image restored successfully",
    meta: {
      category_id: Number(categoryId),
      restored_image_url: restoredImageUrl,
      verified: verification.verified,
    },
  });

  return {
    success: true,
    error: null,
    statusCode: 200,
    skipped: false,
    data: {
      category_id: Number(categoryId),
      channel_id: Number(channelId),
      tree_id: resolvedTreeId,
      category_name: categoryImage?.category_name || null,
      restored_image_url: restoredImageUrl,
      original_url: categoryImage?.original_url || null,
      verified: verification.verified,
      original_size: categoryImage?.original?.size || 0,
      original_width: categoryImage?.original?.width || 0,
      original_height: categoryImage?.original?.height || 0,
      original_format: categoryImage?.original?.format || null,
    },
  };
}

module.exports = {
  validateCategoryRestoreEligibility,
  restoreSingleCategoryImage,
};
