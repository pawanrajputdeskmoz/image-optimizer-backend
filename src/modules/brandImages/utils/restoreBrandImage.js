const fs = require("node:fs/promises");
const path = require("node:path");
const { BrandImage, BrandImageStatus } = require("../../../models");
const { deleteFile } = require("../../../utils/deleteFile");
const { replaceBrandImage, verifyBrandImageUpdate } = require("./bigCommerceBrandImage");
const {
  appendBrandImageJobLog,
  resolveBrandJobUuid,
} = require("./brandActivityLog");

async function logRestoreStep(logContext, payload) {
  const storeHash = logContext?.storeHash;
  const brandId = logContext?.brandId;
  if (!storeHash || brandId == null) return;

  const jobUuid = resolveBrandJobUuid(logContext, storeHash, brandId);
  if (!jobUuid) return;

  await appendBrandImageJobLog({
    jobUuid,
    storeHash,
    jobType: logContext.jobType || "restore_single",
    brandId,
    ...payload,
  });
}

function resolveOutputFormatFromPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".png") return "png";
  if (ext === ".gif") return "gif";
  if (ext === ".ico") return "ico";
  return "jpeg";
}

async function cleanupStaleBrandOptimizationRecords({ storeHash, brandId, brandImage = null }) {
  const dbQuery = {
    store_hash: storeHash,
    brand_id: Number(brandId),
  };

  try {
    await Promise.all([
      BrandImage.deleteMany(dbQuery),
      BrandImageStatus.deleteOne(dbQuery),
    ]);
  } catch (err) {
    console.error("[cleanupStaleBrandOptimizationRecords] DB cleanup error:", err.message);
    return { cleaned: false, error: err.message };
  }

  const paths = [
    brandImage?.original_image_path,
    brandImage?.optimized_image_path,
  ].filter(Boolean);

  await Promise.all(
    paths.map((filePath) =>
      deleteFile(filePath).catch((err) => {
        console.error("[cleanupStaleBrandOptimizationRecords] delete file:", err.message);
      })
    )
  );

  return { cleaned: true, error: null };
}

async function isLocalBackupUnavailable(originalPath) {
  if (!originalPath) {
    return true;
  }

  try {
    const stat = await fs.stat(originalPath);
    return !stat.isFile();
  } catch {
    return true;
  }
}

/**
 * Remove BrandImage + BrandImageStatus when local backup is missing or invalid.
 * Used during restore, brand list fetch, and preview.
 */
async function purgeStaleBrandOptimizationIfBackupMissing({ storeHash, brandId }) {
  const query = {
    store_hash: storeHash,
    brand_id: Number(brandId),
  };

  const [brandImage, brandImageStatus] = await Promise.all([
    BrandImage.findOne(query).sort({ updated_at: -1 }).lean(),
    BrandImageStatus.findOne(query).lean(),
  ]);

  if (!brandImage && !brandImageStatus) {
    return { cleaned: false, reason: "no_records" };
  }

  const originalPath = brandImage?.original_image_path || null;
  const backupUnavailable = await isLocalBackupUnavailable(originalPath);

  if (!backupUnavailable) {
    return { cleaned: false, reason: "backup_available" };
  }

  const result = await cleanupStaleBrandOptimizationRecords({
    storeHash,
    brandId,
    brandImage,
  });

  return {
    cleaned: result.cleaned,
    reason: "backup_unavailable",
    error: result.error || null,
  };
}

async function validateBrandRestoreEligibility({ storeHash, brandId }) {
  const query = {
    store_hash: storeHash,
    brand_id: Number(brandId),
  };

  const [brandImage, brandImageStatus] = await Promise.all([
    BrandImage.findOne(query).sort({ updated_at: -1 }).lean(),
    BrandImageStatus.findOne(query).lean(),
  ]);

  if (!brandImage && !brandImageStatus) {
    return {
      ok: false,
      skipReason: "No optimization record found for this brand",
      statusCode: 404,
    };
  }

  const currentStatus = brandImageStatus?.status;
  if (currentStatus && !["optimized", "uploaded"].includes(currentStatus)) {
    return {
      ok: false,
      skipReason: `Brand image cannot be restored because current status is "${currentStatus}", not "optimized"`,
      statusCode: 400,
    };
  }

  const originalPath = brandImage?.original_image_path || null;

  if (!originalPath) {
    return {
      ok: false,
      skipReason:
        "Original image backup path not found in database. The file may have been removed already.",
      statusCode: 404,
      cleanupStaleRecords: true,
      brandImage,
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
      cleanupStaleRecords: true,
      brandImage,
    };
  }

  if (!originalStat.isFile()) {
    return {
      ok: false,
      skipReason: "Original image backup path does not point to a valid file.",
      statusCode: 400,
      cleanupStaleRecords: true,
      brandImage,
    };
  }

  return {
    ok: true,
    brandImage,
    brandImageStatus,
    originalPath,
    originalStat,
  };
}

/**
 * Restore a brand image to its original backup on BigCommerce and clean up DB/file state.
 */
async function restoreSingleBrandImage({ storeHash, accessToken, brandId, logContext = null }) {
  const effectiveLogContext = logContext
    ? {
        jobType: "restore_single",
        brandId,
        ...logContext,
        storeHash: logContext.storeHash || storeHash,
      }
    : null;

  const validation = await validateBrandRestoreEligibility({ storeHash, brandId });

  if (!validation.ok) {
    if (validation.cleanupStaleRecords) {
      await cleanupStaleBrandOptimizationRecords({
        storeHash,
        brandId,
        brandImage: validation.brandImage || null,
      });

      await logRestoreStep(effectiveLogContext, {
        logType: "info",
        step: "file_cleanup",
        message: "Removed stale brand optimization records because backup file is unavailable",
        meta: {
          brand_id: Number(brandId),
          original_image_path: validation.data?.original_image_path || null,
        },
      });
    }

    await logRestoreStep(effectiveLogContext, {
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

  const { brandImage, originalPath } = validation;
  const outputFormat = resolveOutputFormatFromPath(originalPath);

  await logRestoreStep(effectiveLogContext, {
    logType: "info",
    step: "restore",
    message: "Brand image restore started",
    meta: { brand_id: Number(brandId), original_image_path: originalPath },
  });

  let fileBuffer;
  try {
    fileBuffer = await fs.readFile(originalPath);
  } catch (readErr) {
    const msg = readErr.message || "Failed to read original image file from disk";

    await cleanupStaleBrandOptimizationRecords({
      storeHash,
      brandId,
      brandImage,
    });

    await logRestoreStep(effectiveLogContext, {
      logType: "info",
      step: "file_cleanup",
      message: "Removed stale brand optimization records because backup file could not be read",
      meta: { brand_id: Number(brandId), original_image_path: originalPath },
    });

    await logRestoreStep(effectiveLogContext, {
      logType: "warning",
      step: "skip",
      message: msg,
      meta: { original_image_path: originalPath, error: msg },
    });

    return {
      success: false,
      error: msg,
      statusCode: 500,
      skipped: true,
    };
  }

  let uploadResult;
  try {
    uploadResult = await replaceBrandImage({
      storeHash,
      accessToken,
      brandId,
      fileBuffer,
      outputFormat,
    });
  } catch (uploadErr) {
    const uploadErrMsg =
      uploadErr?.response?.data?.title ||
      uploadErr?.response?.data?.message ||
      uploadErr?.message ||
      "Failed to upload restored image to BigCommerce";

    await logRestoreStep(effectiveLogContext, {
      logType: "error",
      step: "upload",
      message: uploadErrMsg,
      meta: { brand_id: Number(brandId), error: uploadErrMsg },
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
    await logRestoreStep(effectiveLogContext, {
      logType: "error",
      step: "upload",
      message: "BigCommerce did not return an image URL after upload",
      meta: { brand_id: Number(brandId) },
    });

    return {
      success: false,
      error: "BigCommerce did not return an image URL after upload",
      statusCode: 502,
      skipped: false,
    };
  }

  const verification = await verifyBrandImageUpdate({
    storeHash,
    accessToken,
    brandId,
    expectedImageUrl: restoredImageUrl,
  });

  const dbQuery = {
    store_hash: storeHash,
    brand_id: Number(brandId),
  };

  try {
    await Promise.all([
      BrandImage.deleteMany(dbQuery),
      BrandImageStatus.deleteOne(dbQuery),
    ]);
  } catch (dbCleanErr) {
    console.error("[restoreSingleBrandImage] DB cleanup error:", dbCleanErr.message);
  }

  const optimizedPath = brandImage?.optimized_image_path || null;

  await Promise.all([
    deleteFile(originalPath).catch((err) => {
      console.error("[restoreSingleBrandImage] delete original file:", err.message);
    }),
    optimizedPath
      ? deleteFile(optimizedPath).catch((err) => {
          console.error("[restoreSingleBrandImage] delete optimized file:", err.message);
        })
      : Promise.resolve(),
  ]);

  await logRestoreStep(effectiveLogContext, {
    logType: "info",
    step: "complete",
    message: "Brand image restored successfully",
    meta: {
      brand_id: Number(brandId),
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
      brand_id: Number(brandId),
      brand_name: brandImage?.brand_name || null,
      restored_image_url: restoredImageUrl,
      original_url: brandImage?.original_url || null,
      verified: verification.verified,
      original_size: brandImage?.original?.size || 0,
      original_width: brandImage?.original?.width || 0,
      original_height: brandImage?.original?.height || 0,
      original_format: brandImage?.original?.format || null,
    },
  };
}

module.exports = {
  validateBrandRestoreEligibility,
  restoreSingleBrandImage,
  purgeStaleBrandOptimizationIfBackupMissing,
  cleanupStaleBrandOptimizationRecords,
};
