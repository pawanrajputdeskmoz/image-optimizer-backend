const crypto = require("node:crypto");
const { get } = require("../../utils/axiosUtils");
const { BrandImageStatus } = require("../../models");
const BrandJob = require("../../models/BrandJob");
const BrandJobItem = require("../../models/BrandJobItem");
const BrandImageJobLog = require("../../models/BrandImageJobLog");
const { getImageSizesFromUrls } = require("../../utils/sharpFunction");
const { compressBrandImage } = require("./utils/compressBrandImage");
const { fetchBrandById } = require("./utils/bigCommerceBrandImage");
const { restoreSingleBrandImage } = require("./utils/restoreBrandImage");
const {
  fetchStoreOptimizationSettings,  
} = require("../imageOptimization/services");
const { normalizeJobType } = require("../../models/constants");
const {
  appendBrandImageJobLog,
  standaloneBrandJobUuid,
} = require("./utils/brandActivityLog");
const config = require("../../config");

const SKIP_BRAND_STATUSES = new Set(["optimized", "optimizing"]);

const bcJsonHeaders = (accessToken) => ({
  "X-Auth-Token": accessToken,
  Accept: "application/json",
  "Content-Type": "application/json",
});

/**
 * Fetch a page of brands from BigCommerce and enrich each brand
 * with its optimization status (from DB) and live image size (via sharp).
 */
exports.fetchBrandImages = async ({
  storeHash,
  accessToken,
  storeUrl,
  page,
  limit,
  search = "",
}) => {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });

  if (search) {
    params.set("name:like", search);
  }

  const response = await get(
    `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/brands?${params.toString()}`,
    bcJsonHeaders(accessToken),
    { timeout: config.api.bigCommerceTimeoutMs }
  );

  const brands = Array.isArray(response?.data) ? response.data : [];

  // -- Brands that have an image_url
  const brandsWithImage = brands.filter(
    (b) => typeof b.image_url === "string" && b.image_url.trim().length > 0
  );
  const brandIds = brandsWithImage.map((b) => b.id);

  // -- Single DB query for optimization status
  const statusByBrandId = Object.create(null);

  if (brandIds.length > 0) {
    const statusRows = await BrandImageStatus.find(
      { store_hash: storeHash, brand_id: { $in: brandIds } },
      { brand_id: 1, status: 1, image_update_status: 1, _id: 0 }
    ).lean();

    for (const row of statusRows) {
      statusByBrandId[row.brand_id] = {
        optimization_status: row.status,
        image_update_status: row.image_update_status || "pending",
      };
    }
  }

  // -- Fetch live image sizes via sharp
  const imageUrlItems = brandsWithImage.map((b) => ({
    imageId: b.id,
    url: b.image_url,
  }));

  const sizeByBrandId =
    imageUrlItems.length > 0
      ? await getImageSizesFromUrls(imageUrlItems, {
          concurrency: config.image.sizeFetchConcurrency,
        })
      : Object.create(null);

  // -- Storefront base URL
  const storefrontBase = storeUrl ? String(storeUrl).replace(/\/$/, "") : "";

  // -- Enrich each brand
  for (const brand of brands) {
    const hasImage =
      typeof brand.image_url === "string" && brand.image_url.trim().length > 0;

    brand.has_image = hasImage;

    const customPath =
      brand.custom_url?.url != null
        ? String(brand.custom_url.url).trim()
        : "";

    brand.storefront_url =
      storefrontBase && customPath
        ? `${storefrontBase}${customPath.startsWith("/") ? customPath : `/${customPath}`}`
        : null;

    const statusInfo = statusByBrandId[brand.id] || {
      optimization_status: "pending",
      image_update_status: "pending",
    };

    brand.optimization_status = statusInfo.optimization_status;
    brand.image_update_status = statusInfo.image_update_status;

    const sizeInfo = sizeByBrandId[brand.id];
    brand.size = sizeInfo
      ? {
          bytes: sizeInfo.bytes,
          width: sizeInfo.width,
          height: sizeInfo.height,
          format: sizeInfo.format,
        }
      : {
          bytes: null,
          width: null,
          height: null,
          format: null,
        };
  }

  return {
    brands,
    pagination: response?.meta?.pagination || null,
    count: brands.length,
  };
};

/**
 * Check whether a brand image should be skipped.
 * Returns { skip: boolean, reason?: string, status?: string }
 */
async function shouldSkipBrandOptimization(storeHash, brandId, { force = false, clientStatus = "" } = {}) {
  if (force) return { skip: false };

  const normalizedClientStatus = String(clientStatus || "").toLowerCase();
  if (["optimized", "optimizing"].includes(normalizedClientStatus)) {
    return {
      skip: true,
      reason: "Brand image is already optimized or currently optimizing",
    };
  }

  const statusRow = await BrandImageStatus.findOne(
    { store_hash: storeHash, brand_id: brandId, status: { $in: ["optimized", "optimizing"] } },
    { status: 1 }
  ).lean();

  if (statusRow) {
    return {
      skip: true,
      reason: "Brand image already optimized",
      status: statusRow.status,
    };
  }

  return { skip: false };
}

/**
 * Optimize a single brand image.
 * Mirrors optimizeCategoryImageSingle exactly.
 */
exports.optimizeBrandImageSingle = async ({
  storeHash,
  accessToken,
  brandId,
  imageUrl = null,
  brandName = null,
  settings = {},
  force = false,
  clientStatus = "",
}) => {
  const resolvedBrandId = Number(brandId);
  if (!Number.isFinite(resolvedBrandId) || resolvedBrandId <= 0) {
    return { success: false, status: 400, message: "brand_id is required and must be a positive number" };
  }

  const { skip, reason, status: existingStatus } = await shouldSkipBrandOptimization(
    storeHash,
    resolvedBrandId,
    { force, clientStatus }
  );

  if (skip) {
    return {
      success: true,
      skipped: true,
      message: reason || "Brand image already optimized",
      data: { brand_id: resolvedBrandId, status: existingStatus || "optimized" },
    };
  }

  let resolvedImageUrl = typeof imageUrl === "string" && imageUrl.trim() ? imageUrl.trim() : null;
  let resolvedBrandName = brandName || null;

  // If no image_url provided, fetch the brand from BigCommerce
  if (!resolvedImageUrl) {
    const brand = await fetchBrandById({ storeHash, accessToken, brandId: resolvedBrandId });

    if (!brand) {
      return { success: false, status: 404, message: "Brand not found" };
    }

    resolvedImageUrl =
      typeof brand.image_url === "string" && brand.image_url.trim()
        ? brand.image_url.trim()
        : null;
    resolvedBrandName = resolvedBrandName || brand.name || null;
  }

  if (!resolvedImageUrl) {
    await BrandImageStatus.updateOne(
      { store_hash: storeHash, brand_id: resolvedBrandId },
      { $set: { status: "skipped", image_update_status: "complete" } },
      { upsert: true }
    );

    return {
      success: true,
      skipped: true,
      message: "Brand has no image_url",
      data: { brand_id: resolvedBrandId, brand_name: resolvedBrandName, status: "no_image" },
    };
  }

  const result = await compressBrandImage({
    storeHash,
    accessToken,
    brandId: resolvedBrandId,
    imageUrl: resolvedImageUrl,
    brandName: resolvedBrandName,
    settings,
    force,
  });

  if (!result.success) {
    return { success: false, status: 500, message: result.error || "Brand image optimization failed" };
  }

  return result;
};

exports.restoreBrandImageSingle = async ({ storeHash, accessToken, brandId }) =>
  restoreSingleBrandImage({ storeHash, accessToken, brandId });

exports.fetchStoreOptimizationSettings = fetchStoreOptimizationSettings;

//=======================================================
// Brand Job Management
//=======================================================

/**
 * Brand IDs already optimized / optimizing for this store (to skip at queue time).
 */
exports.getAlreadyOptimizedBrandIdSet = async (storeHash, items = []) => {
  const skipIds = new Set();
  if (!storeHash) return skipIds;

  const brandIds = [];
  for (const item of Array.isArray(items) ? items : []) {
    const bid = Number(item?.brand_id ?? item);
    if (Number.isFinite(bid)) brandIds.push(bid);
  }

  if (brandIds.length === 0) return skipIds;

  const rows = await BrandImageStatus.find({
    store_hash: storeHash,
    brand_id: { $in: brandIds },
    status: { $in: Array.from(SKIP_BRAND_STATUSES) },
  })
    .select({ brand_id: 1 })
    .lean();

  for (const row of rows) {
    if (row?.brand_id != null) skipIds.add(Number(row.brand_id));
  }

  return skipIds;
};

/**
 * Worker-side skip check for a single brand.
 */
exports.shouldSkipBrandOptimization = async (storeHash, brandId) => {
  const bid = Number(brandId);
  if (!storeHash || !Number.isFinite(bid)) return { skip: false, reason: null };

  const statusRow = await BrandImageStatus.findOne({
    store_hash: storeHash,
    brand_id: bid,
    status: { $in: Array.from(SKIP_BRAND_STATUSES) },
  })
    .select({ status: 1 })
    .lean();

  if (statusRow) {
    return {
      skip: true,
      reason:
        statusRow.status === "optimizing"
          ? "Brand image is currently being optimized"
          : "Brand image is already optimized",
    };
  }

  return { skip: false, reason: null };
};

/**
 * Create top-level BrandJob doc + all BrandJobItem docs in one shot.
 */
exports.createBrandBulkJob = async ({
  jobUuid = crypto.randomUUID(),
  storeHash,
  jobType,
  totalImages,
  queuedImages = totalImages,
  skippedImages = 0,
  jobItems = [],
}) => {
  const validJobType = normalizeJobType(jobType);
  if (!validJobType) {
    return { error: `Invalid job_type "${jobType}"`, jobUuid: null, doc: null };
  }

  try {
    const doc = await BrandJob.create({
      job_uuid: jobUuid,
      store_hash: storeHash,
      job_type: validJobType,
      total_images: totalImages,
      queued_images: queuedImages,
      skipped_images: skippedImages,
      processed_images: 0,
      success_images: 0,
      failed_images: 0,
      status: queuedImages > 0 ? "processing" : "completed",
      started_at: new Date(),
    });

    if (jobItems.length > 0) {
      await BrandJobItem.insertMany(jobItems, { ordered: false });
    }

    return { error: null, jobUuid, doc };
  } catch (err) {
    console.error("[createBrandBulkJob]", err.message);
    return { error: err.message, jobUuid: null, doc: null };
  }
};

/**
 * Mark a single BrandJobItem as "optimizing" when the worker picks it up.
 */
exports.setBrandJobItemStatus = async ({
  jobUuid,
  brandId,
  status,
  errorMessage = null,
  savedBytes = null,
  savedPercentage = null,
}) => {
  if (!jobUuid || brandId == null) {
    return { error: "jobUuid and brandId are required" };
  }

  const $set = { status };

  if (status === "optimizing") {
    $set.started_at = new Date();
    $set.error_message = null;
  }

  if (status === "optimized") {
    $set.completed_at = new Date();
    $set.error_message = null;
    if (savedBytes != null) $set.saved_bytes = savedBytes;
    if (savedPercentage != null) $set.saved_percentage = savedPercentage;
  }

  if (status === "failed") {
    $set.completed_at = new Date();
    if (errorMessage) $set.error_message = errorMessage;
  }

  if (status === "skipped") {
    $set.completed_at = new Date();
    if (errorMessage) $set.skip_reason = errorMessage;
  }

  try {
    await BrandJobItem.updateOne(
      { job_uuid: jobUuid, brand_id: Number(brandId) },
      { $set }
    );
    return { error: null };
  } catch (err) {
    return { error: err.message };
  }
};

/**
 * After the worker finishes — update the item row and roll up counters on BrandJob.
 */
exports.recordBrandJobItemResult = async ({
  jobUuid,
  brandId,
  success,
  skipped = false,
  skipReason = null,
  errorMessage = null,
  savedBytes = null,
  savedPercentage = null,
}) => {
  if (!jobUuid) return { error: "jobUuid is required" };

  const itemStatus = skipped ? "skipped" : success ? "optimized" : "failed";
  const itemMessage = skipped
    ? skipReason || "Brand skipped"
    : success
      ? null
      : errorMessage || "Brand image optimization failed";

  try {
    const itemUpdate = BrandJobItem.updateOne(
      { job_uuid: jobUuid, brand_id: Number(brandId) },
      {
        $set: {
          status: itemStatus,
          completed_at: new Date(),
          ...(skipped
            ? { skip_reason: itemMessage, error_message: null }
            : { error_message: itemMessage }),
          ...(success && savedBytes != null ? { saved_bytes: savedBytes } : {}),
          ...(success && savedPercentage != null ? { saved_percentage: savedPercentage } : {}),
        },
      }
    );

    const jobIncrement = { processed_images: 1 };
    if (!skipped) {
      if (success) jobIncrement.success_images = 1;
      else jobIncrement.failed_images = 1;
    }

    const jobUpdate = BrandJob.findOneAndUpdate(
      { job_uuid: jobUuid },
      { $inc: jobIncrement },
      { new: true }
    );

    const [, updatedJob] = await Promise.all([itemUpdate, jobUpdate]);

    if (updatedJob) {
      const queued = updatedJob.queued_images || 0;
      const processed = updatedJob.processed_images || 0;

      if (processed >= queued) {
        await BrandJob.updateOne(
          { job_uuid: jobUuid, status: { $ne: "completed" } },
          { $set: { status: "completed", completed_at: new Date() } }
        );
      }
    }

    return { error: null };
  } catch (err) {
    console.error("[recordBrandJobItemResult]", err.message);
    return { error: err.message };
  }
};

/**
 * Fetch a BrandJob with its items and recent logs (for status polling).
 */
exports.getBrandJobStatus = async (jobUuid, storeHash) => {
  const query = { job_uuid: jobUuid };
  const logQuery = { job_uuid: jobUuid };
  if (storeHash) {
    query.store_hash = storeHash;
    logQuery.store_hash = storeHash;
  }

  try {
    const [job, logs, items] = await Promise.all([
      BrandJob.findOne(query).lean(),
      BrandImageJobLog.find(logQuery)
        .sort({ created_at: -1 })
        .limit(200)
        .lean(),
      BrandJobItem.find({ job_uuid: jobUuid }).sort({ created_at: 1 }).lean(),
    ]);

    if (!job) return { error: null, job: null, logs, items };

    const queued = job.queued_images || 0;
    const processed = job.processed_images || 0;

    return {
      error: null,
      job: { ...job, pending_images: Math.max(0, queued - processed) },
      logs,
      items,
    };
  } catch (err) {
    console.error("[getBrandJobStatus]", err.message);
    return { error: err.message, job: null, logs: [], items: [] };
  }
};

/**
 * Write skip warning logs for brands skipped at queue time.
 */
exports.writeBrandSkipLogs = async (skippedEntries = []) => {
  if (!skippedEntries.length) return { error: null };

  try {
    await BrandImageJobLog.insertMany(
      skippedEntries.map((s) => ({
        job_uuid: s.job_uuid,
        store_hash: s.store_hash,
        source_type: "brand",
        job_type: s.job_type,
        brand_id: Number(s.brand_id),
        log_type: "warning",
        step: "skip",
        message: s.reason || "Brand skipped",
        meta: { index: s.index },
      })),
      { ordered: false }
    );
    return { error: null };
  } catch (err) {
    console.error("[writeBrandSkipLogs]", err.message);
    return { error: err.message };
  }
};

exports.appendBrandImageJobLog = appendBrandImageJobLog;
exports.standaloneBrandJobUuid = standaloneBrandJobUuid;
