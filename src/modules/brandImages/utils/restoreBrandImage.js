const fs = require("node:fs/promises");
const path = require("node:path");
const { BrandImage, BrandImageStatus } = require("../../../models");
const { deleteFile } = require("../../../utils/deleteFile");
const { replaceBrandImage, verifyBrandImageUpdate } = require("./bigCommerceBrandImage");

function resolveOutputFormatFromPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".png") return "png";
  if (ext === ".gif") return "gif";
  if (ext === ".ico") return "ico";
  return "jpeg";
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
    brandImage,
    brandImageStatus,
    originalPath,
    originalStat,
  };
}

/**
 * Restore a brand image to its original backup on BigCommerce and clean up DB/file state.
 */
async function restoreSingleBrandImage({ storeHash, accessToken, brandId }) {
  const validation = await validateBrandRestoreEligibility({ storeHash, brandId });

  if (!validation.ok) {
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

  let fileBuffer;
  try {
    fileBuffer = await fs.readFile(originalPath);
  } catch (readErr) {
    return {
      success: false,
      error: readErr.message || "Failed to read original image file from disk",
      statusCode: 500,
      skipped: false,
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

    return {
      success: false,
      error: uploadErrMsg,
      statusCode: uploadErr?.response?.status || 502,
      skipped: false,
    };
  }

  const restoredImageUrl = uploadResult?.image_url || null;

  if (!restoredImageUrl) {
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
};
