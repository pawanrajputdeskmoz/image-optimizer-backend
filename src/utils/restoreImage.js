const fs = require("node:fs/promises");
const path = require("node:path");
const {
  ImageOptimization,
  ImageStatus,
  ImageOldData,
  ImageJobItem,
  StoreImageStat,
} = require("../models");
const { deleteFile } = require("./deleteFile");
const { resolveProductImageUrl } = require("./urls");
const {
  uploadProductImage,
  deleteProductImage,
} = require("./bigCommerceProductImage");
const { get } = require("./axiosUtils");
const { appendImageLog, resolveJobUuid } = require("./imageActivityLog");

async function logRestoreActivity(
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
    jobType: logContext?.jobType || "restore_single",
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

const RESTORE_BACKUP_DAYS = Number(process.env.RESTORE_BACKUP_DAYS) || 30;
const RESTORE_BACKUP_MS = RESTORE_BACKUP_DAYS * 24 * 60 * 60 * 1000;

function buildLookup(storeHash, productId, imageId) {
  return {
    store_hash: storeHash,
    product_id: Number(productId),
    image_id: Number(imageId),
  };
}

async function loadRestoreRecords(storeHash, productId, imageId) {
  const lookup = buildLookup(storeHash, productId, imageId);
  const [imageOptimization, imageStatus, imageOldData] = await Promise.all([
    ImageOptimization.findOne(lookup).lean(),
    ImageStatus.findOne(lookup).lean(),
    ImageOldData.findOne(lookup).lean(),
  ]);

  return { lookup, imageOptimization, imageStatus, imageOldData };
}

/**
 * Validate whether an image can be restored. Returns { ok, skipReason, statusCode, data }.
 */
async function validateRestoreEligibility({
  storeHash,
  productId,
  imageId,
  records = null,
}) {
  const loaded =
    records || (await loadRestoreRecords(storeHash, productId, imageId));
  const { imageOptimization, imageStatus, imageOldData } = loaded;

  if (!imageOptimization && !imageStatus && !imageOldData) {
    return {
      ok: false,
      skipReason: "No optimized image record found for this product and image id",
      statusCode: 404,
    };
  }

  if (imageStatus?.status && imageStatus.status !== "optimized") {
    return {
      ok: false,
      skipReason: `Image cannot be restored because current status is "${imageStatus.status}", not "optimized"`,
      statusCode: 400,
    };
  }

  const optimizedAt =
    imageStatus?.optimized_at ||
    imageOptimization?.updated_at ||
    imageOldData?.updated_at ||
    null;

  if (!optimizedAt) {
    return {
      ok: false,
      skipReason:
        "Optimized date not found. This image may not have been optimized by the app",
      statusCode: 400,
    };
  }

  const ageMs = Date.now() - new Date(optimizedAt).getTime();
  if (ageMs > RESTORE_BACKUP_MS) {
    const optimizedOn = new Date(optimizedAt).toISOString().slice(0, 10);
    return {
      ok: false,
      skipReason: `Restore is not available. Image was optimized on ${optimizedOn}, which is more than ${RESTORE_BACKUP_DAYS} days ago.`,
      statusCode: 400,
      data: {
        image_id: Number(imageId),
        product_id: Number(productId),
        optimized_at: optimizedAt,
        backup_retention_days: RESTORE_BACKUP_DAYS,
      },
    };
  }

  const originalPath =
    imageOptimization?.original_image_path ||
    imageOldData?.original_image_path ||
    null;

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
      skipReason:
        "Original image backup file is missing on disk. Restore cannot continue.",
      statusCode: 404,
      data: { original_image_path: originalPath },
    };
  }

  if (!originalStat.isFile()) {
    return {
      ok: false,
      skipReason: "Original image backup path does not point to a valid file",
      statusCode: 400,
    };
  }

  return {
    ok: true,
    records: loaded,
    originalPath,
    originalStat,
    optimizedAt,
  };
}

function resolveRestoreUploadMeta({ overrides = {}, imageOldData, originalPath }) {
  const description =
    (overrides.altText && String(overrides.altText).trim()) ||
    (overrides.alt_text && String(overrides.alt_text).trim()) ||
    imageOldData?.altText ||
    imageOldData?.newAltText ||
    "Restored original image";

  const uploadFileName =
    (overrides.imageName && String(overrides.imageName).trim()) ||
    (overrides.image_name && String(overrides.image_name).trim()) ||
    imageOldData?.imageName ||
    path.basename(originalPath);

  return { description, uploadFileName };
}

/**
 * Restore one optimized image to its original backup on BigCommerce and clean up local/DB state.
 */
async function restoreSingleImage({
  storeHash,
  storeUrl,
  accessToken,
  productId,
  imageId,
  overrides = {},
  logContext = null,
}) {
  const effectiveLogContext = {
    jobType: "restore_single",
    productId,
    imageId,
    ...logContext,
    storeHash: logContext?.storeHash || storeHash,
  };

  const validation = await validateRestoreEligibility({
    storeHash,
    productId,
    imageId,
  });

  if (!validation.ok) {
    await logRestoreActivity(
      effectiveLogContext,
      { storeHash, productId, imageId },
      {
        logType: "warning",
        step: "skip",
        message: validation.skipReason,
        meta: { status_code: validation.statusCode },
      }
    );
    return {
      success: false,
      error: validation.skipReason,
      statusCode: validation.statusCode,
      data: validation.data || null,
      skipped: true,
    };
  }

  const { records, originalPath, originalStat } = validation;
  const { lookup, imageOptimization, imageOldData } = records;
  const { description, uploadFileName } = resolveRestoreUploadMeta({
    overrides,
    imageOldData,
    originalPath,
  });

  const placement = overrides.placement || {};
  let sortOrder = placement.sortOrder;
  let isThumbnail = placement.isThumbnail;

  // If client did not pass placement fields, preserve existing BC image placement.
  if (sortOrder == null || isThumbnail == null) {
    try {
      const imageRes = await get(
        `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images/${imageId}`,
        {
          "X-Auth-Token": accessToken,
          Accept: "application/json",
          "Content-Type": "application/json",
        }
      );
      const currentImage = imageRes?.data || {};

      if (sortOrder == null && currentImage.sort_order != null) {
        sortOrder = Number(currentImage.sort_order);
      }

      if (isThumbnail == null && currentImage.is_thumbnail != null) {
        isThumbnail = Boolean(currentImage.is_thumbnail);
      }
    } catch (metaErr) {
      await logRestoreActivity(
        effectiveLogContext,
        { storeHash, productId, imageId },
        {
          logType: "warning",
          step: "placement",
          message:
            "Failed to read current BigCommerce image placement; using defaults for restore upload",
          meta: {
            error: metaErr?.message || String(metaErr),
          },
        }
      );
    }
  }

  if (sortOrder == null || Number.isNaN(Number(sortOrder))) {
    sortOrder = 1;
  }

  if (isThumbnail == null) {
    isThumbnail = false;
  }

  const fileBuf = await fs.readFile(originalPath);

  let restoredImage;
  try {
    restoredImage = await uploadProductImage({
      storeHash,
      productId,
      accessToken,
      fileBuffer: fileBuf,
      fileName: uploadFileName,
      description,
      sortOrder,
      isThumbnail,
    });
  } catch (uploadErr) {
    const uploadErrMsg =
      uploadErr?.message || "Failed to upload restored image to BigCommerce";
    await logRestoreActivity(
      effectiveLogContext,
      { storeHash, productId, imageId },
      {
        logType: "error",
        step: "upload",
        message: uploadErrMsg,
        meta: {
          status: uploadErr?.response?.status,
          detail: uploadErr?.response?.data,
        },
      }
    );
    return {
      success: false,
      error: uploadErrMsg,
      statusCode: uploadErr?.response?.status || 502,
      skipped: false,
    };
  }

  if (!restoredImage?.id) {
    const uploadErrMsg = "Failed to upload restored image to BigCommerce";
    await logRestoreActivity(
      effectiveLogContext,
      { storeHash, productId, imageId },
      {
        logType: "error",
        step: "upload",
        message: uploadErrMsg,
      }
    );
    return {
      success: false,
      error: uploadErrMsg,
      statusCode: 502,
      skipped: false,
    };
  }

  await logRestoreActivity(
    effectiveLogContext,
    { storeHash, productId, imageId },
    {
      logType: "info",
      step: "upload",
      message: "Restored original image uploaded to BigCommerce",
      meta: { restored_image_id: restoredImage.id },
    }
  );

  const restoredImageId = restoredImage.id;
  const restoredBcUrl = resolveProductImageUrl(
    storeUrl,
    restoredImage.image_file,
    restoredImage.url_standard || null
  );

  try {
    await deleteProductImage({
      storeHash,
      productId,
      imageId,
      accessToken,
    });
    await logRestoreActivity(
      effectiveLogContext,
      { storeHash, productId, imageId },
      {
        logType: "info",
        step: "bc_delete",
        message: "Removed optimized BigCommerce image after restore",
        meta: {
          removed_image_id: imageId,
          restored_image_id: restoredImageId,
        },
      }
    );
  } catch (deleteErr) {
    const deleteDetail =
      deleteErr?.response?.data || deleteErr.message || String(deleteErr);
    console.error(
      "[restoreSingleImage] BC delete optimized image:",
      deleteDetail
    );
    await logRestoreActivity(
      effectiveLogContext,
      { storeHash, productId, imageId },
      {
        logType: "warning",
        step: "bc_delete",
        message:
          "Failed to delete optimized BigCommerce image after restore (restore continued)",
        meta: {
          removed_image_id: imageId,
          restored_image_id: restoredImageId,
          error: deleteDetail,
        },
      }
    );
  }

  const optimizedPath = imageOptimization?.optimized_image_path || null;
  const origSize =
    Number(imageOldData?.original?.size) || Number(originalStat.size) || 0;
  const optSize = Number(imageOldData?.optimized?.size) || 0;
  const savedBytes =
    Number(imageOldData?.saved_bytes) ||
    (origSize > 0 ? Math.max(0, origSize - optSize) : 0);

  const cleanupTasks = [
    ImageOptimization.deleteOne(lookup),
    ImageOldData.deleteOne(lookup),
    ImageStatus.deleteOne(lookup),
    ImageJobItem.deleteMany({
      store_hash: storeHash,
      product_id: Number(productId),
      image_id: Number(imageId),
    }),
  ];

  if (origSize > 0 || optSize > 0 || savedBytes > 0) {
    cleanupTasks.push(
      StoreImageStat.updateOne(
        { store_hash: storeHash },
        {
          $inc: {
            optimized_images: -1,
            total_original_size: -origSize,
            total_optimized_size: -optSize,
            total_saved_bytes: -savedBytes,
          },
        }
      )
    );
  }

  await Promise.all(cleanupTasks);

  await Promise.all([
    deleteFile(originalPath).catch(async (err) => {
      console.error("[restoreSingleImage] delete original file:", err.message);
      await logRestoreActivity(
        effectiveLogContext,
        { storeHash, productId, imageId },
        {
          logType: "warning",
          step: "file_cleanup",
          message: "Failed to delete original backup file from disk",
          meta: { path: originalPath, error: err.message },
        }
      );
    }),
    optimizedPath
      ? deleteFile(optimizedPath).catch(async (err) => {
          console.error(
            "[restoreSingleImage] delete optimized file:",
            err.message
          );
          await logRestoreActivity(
            effectiveLogContext,
            { storeHash, productId, imageId },
            {
              logType: "warning",
              step: "file_cleanup",
              message: "Failed to delete optimized file from disk",
              meta: { path: optimizedPath, error: err.message },
            }
          );
        })
      : Promise.resolve(),
  ]);

  await logRestoreActivity(
    effectiveLogContext,
    { storeHash, productId, imageId },
    {
      logType: "info",
      step: "restore",
      message: "Image restored successfully",
      meta: {
        restored_image_id: restoredImageId,
        removed_image_id: Number(imageId),
      },
    }
  );

  const oldAltText = imageOldData?.altText ?? null;
  const oldImageName = imageOldData?.imageName ?? null;
  const size =
    Number(imageOldData?.original?.size) > 0
      ? Number(imageOldData.original.size)
      : Number(originalStat?.size) > 0
        ? Number(originalStat.size)
        : null;

  return {
    success: true,
    error: null,
    statusCode: 200,
    skipped: false,
    data: {
      restored_image_id: restoredImageId,
      removed_image_id: Number(imageId),
      product_id: Number(productId),
      restored_image_url: restoredBcUrl,
      backup_retention_days: RESTORE_BACKUP_DAYS,
      old_alt_text: oldAltText,
      old_image_name: oldImageName,
      size,
    },
  };
}

module.exports = {
  RESTORE_BACKUP_DAYS,
  RESTORE_BACKUP_MS,
  buildLookup,
  loadRestoreRecords,
  validateRestoreEligibility,
  restoreSingleImage,
};
