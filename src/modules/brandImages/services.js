const crypto = require("node:crypto");
const { get } = require("../../utils/axiosUtils");
const { BrandImage, BrandImageStatus } = require("../../models");
const BrandJob = require("../../models/BrandJob");
const BrandJobItem = require("../../models/BrandJobItem");
const BrandImageJobLog = require("../../models/BrandImageJobLog");
const { getImageSizesFromUrls } = require("../../utils/sharpFunction");
const { compressBrandImage } = require("./utils/compressBrandImage");
const { fetchBrandById } = require("./utils/bigCommerceBrandImage");
const { restoreSingleBrandImage, purgeStaleBrandOptimizationIfBackupMissing } = require("./utils/restoreBrandImage");
const {
  fetchStoreOptimizationSettings,  
} = require("../imageOptimization/services");
const { normalizeJobType } = require("../../models/constants");
const {
  appendBrandImageJobLog,
  standaloneBrandJobUuid,
} = require("./utils/brandActivityLog");
const config = require("../../config");
const { adjustPendingImages } = require("../../utils/storePendingImages");

const SKIP_BRAND_STATUSES = new Set(["optimized", "optimizing"]);
const SKIP_PENDING_BRAND_STATUSES = new Set(["optimized", "optimizing", "pending"]);
const RESTORE_SUCCESS_STATUSES = new Set(["restored"]);

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

    const staleBrandIds = new Set();
    const optimizedBrandIds = statusRows
      .filter((row) => ["optimized", "uploaded"].includes(row.status))
      .map((row) => row.brand_id);

    if (optimizedBrandIds.length > 0) {
      await Promise.all(
        optimizedBrandIds.map(async (brandId) => {
          const purge = await purgeStaleBrandOptimizationIfBackupMissing({
            storeHash,
            brandId,
          });

          if (purge.cleaned) {
            staleBrandIds.add(brandId);
          }
        })
      );
    }

    for (const row of statusRows) {
      if (staleBrandIds.has(row.brand_id)) {
        continue;
      }

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

  await registerPendingBrandImages(storeHash, [resolvedBrandId]);

  const result = await compressBrandImage({
    storeHash,
    accessToken,
    brandId: resolvedBrandId,
    imageUrl: resolvedImageUrl,
    brandName: resolvedBrandName,
    settings,
    force,
  });

  // Single optimize has no BrandJobItem record step — consume pending here.
  await adjustPendingImages(storeHash, -1);

  if (!result.success) {
    if (result.plan_limit) {
      return {
        success: false,
        status: 403,
        message: result.error || "Monthly image optimization limit reached",
      };
    }
    return { success: false, status: 500, message: result.error || "Brand image optimization failed" };
  }

  return result;
};

exports.restoreBrandImageSingle = async ({
  storeHash,
  accessToken,
  brandId,
  logContext = null,
}) => restoreSingleBrandImage({ storeHash, accessToken, brandId, logContext });

/**
 * Fetch all brands eligible for restore for a given store.
 * Returns only brands with optimized/uploaded status AND a backup file path.
 */
exports.fetchRestorableBrandsForStore = async (storeHash) => {
  const statuses = await BrandImageStatus.find({
    store_hash: storeHash,
    status: { $in: ["optimized", "uploaded"] },
  })
    .select({ brand_id: 1 })
    .lean();

  if (!statuses.length) return [];

  const brandIds = statuses.map((s) => s.brand_id);

  const images = await BrandImage.find({
    store_hash: storeHash,
    brand_id: { $in: brandIds },
    original_image_path: { $ne: null, $exists: true },
  })
    .select({ brand_id: 1 })
    .lean();

  const hasBackup = new Set(images.map((img) => img.brand_id));

  return statuses
    .filter((s) => hasBackup.has(s.brand_id))
    .map((s) => ({
      brand_id: s.brand_id,
    }));
};

exports.purgeStaleBrandOptimizationIfBackupMissing = purgeStaleBrandOptimizationIfBackupMissing;

exports.fetchStoreOptimizationSettings = fetchStoreOptimizationSettings;

/**
 * Fetch ALL brands with images from BigCommerce in paginated chunks.
 * Skips brands without image_url; optionally skips already-optimized brands.
 * Returns items shaped for queueBulkBrandJobs.
 */
exports.fetchAllBrandImagesInChunks = async ({
  storeHash,
  accessToken,
  pageSize = config.catalog.pageSize,
  skipOptimized = true,
}) => {
  const limit = Math.min(250, Math.max(1, Number(pageSize) || config.catalog.pageSize));
  const items = [];
  let page = 1;
  let totalPages = 1;
  let totalBrandsFetched = 0;
  let noImageSkipped = 0;
  let alreadyOptimizedSkipped = 0;

  try {
    while (page <= totalPages) {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });

      const response = await get(
        `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/brands?${params.toString()}`,
        bcJsonHeaders(accessToken),
        { timeout: config.api.bigCommerceTimeoutMs }
      );

      const brands = Array.isArray(response?.data) ? response.data : [];
      const pagination = response?.meta?.pagination || {};
      totalPages = Number(pagination.total_pages) || 1;
      totalBrandsFetched += brands.length;

      const pageItems = [];

      for (const brand of brands) {
        if (typeof brand.image_url !== "string" || !brand.image_url.trim()) {
          noImageSkipped++;
          continue;
        }

        pageItems.push({
          brand_id: brand.id,
          image_url: String(brand.image_url).trim(),
          brand_name: brand.name || null,
          shop: storeHash,
        });
      }

      if (skipOptimized && pageItems.length > 0) {
        const brandIds = pageItems.map((item) => Number(item.brand_id));
        const statusRows = await BrandImageStatus.find({
          store_hash: storeHash,
          brand_id: { $in: brandIds },
          status: { $in: Array.from(SKIP_BRAND_STATUSES) },
        })
          .select({ brand_id: 1 })
          .lean();

        const skipIds = new Set(statusRows.map((row) => Number(row.brand_id)));
        for (const item of pageItems) {
          if (skipIds.has(Number(item.brand_id))) {
            alreadyOptimizedSkipped++;
            continue;
          }
          items.push(item);
        }
      } else {
        items.push(...pageItems);
      }

      page++;
    }
  } catch (err) {
    return {
      error:
        err?.response?.data?.title ||
        err?.message ||
        "Failed to fetch brands from BigCommerce",
      items: [],
      meta: null,
    };
  }

  return {
    error: null,
    items,
    meta: {
      total_pages_fetched: totalPages,
      total_brands_fetched: totalBrandsFetched,
      no_image_skipped: noImageSkipped,
      already_optimized_skipped: alreadyOptimizedSkipped,
    },
  };
};

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
 * Mark brand images pending for store dashboard stats.
 * Skips already optimized, optimizing, or already-pending brands.
 */
async function registerPendingBrandImages(storeHash, brandIds = []) {
  if (!storeHash || !brandIds.length) return { registered: 0, error: null };

  const normalized = [];
  const seen = new Set();

  for (const rawId of brandIds) {
    const brandId = Number(rawId);
    if (!Number.isFinite(brandId) || brandId <= 0 || seen.has(brandId)) continue;
    seen.add(brandId);
    normalized.push(brandId);
  }

  if (!normalized.length) return { registered: 0, error: null };

  try {
    const existingRows = await BrandImageStatus.find({
      store_hash: storeHash,
      brand_id: { $in: normalized },
    })
      .select({ brand_id: 1, status: 1 })
      .lean();

    const skipIds = new Set();
    for (const row of existingRows) {
      if (SKIP_PENDING_BRAND_STATUSES.has(row.status)) {
        skipIds.add(Number(row.brand_id));
      }
    }

    const toRegister = normalized.filter((id) => !skipIds.has(id));
    if (!toRegister.length) return { registered: 0, error: null };

    const bulkOps = toRegister.map((brandId) => ({
      updateOne: {
        filter: { store_hash: storeHash, brand_id: brandId },
        update: {
          $set: { status: "pending", image_update_status: "pending" },
          $setOnInsert: { store_hash: storeHash, brand_id: brandId },
        },
        upsert: true,
      },
    }));

    const bulkResult = await BrandImageStatus.bulkWrite(bulkOps, { ordered: false });
    const registered =
      (Number(bulkResult.upsertedCount) || 0) +
      (Number(bulkResult.modifiedCount) || 0);

    if (registered > 0) {
      await adjustPendingImages(storeHash, registered);
    }

    return { registered, error: null };
  } catch (err) {
    console.error("[registerPendingBrandImages]", err.message);
    return { registered: 0, error: err.message };
  }
}

exports.registerPendingBrandImages = registerPendingBrandImages;

exports.pauseBrandJobsForPlanLimit = async (storeHash, jobUuids = []) => {
  const affectedJobUuids = [...new Set(jobUuids.filter(Boolean))];
  if (!storeHash || affectedJobUuids.length === 0) {
    return { error: null, cleared: 0 };
  }

  try {
    const pendingItems = await BrandJobItem.find({
      store_hash: storeHash,
      job_uuid: { $in: affectedJobUuids },
      status: { $in: ["queued", "optimizing"] },
    })
      .select({ brand_id: 1 })
      .lean();

    const brandIds = [...new Set(pendingItems.map((item) => item.brand_id))];
    const now = new Date();

    const [itemResult] = await Promise.all([
      BrandJobItem.updateMany(
        {
          store_hash: storeHash,
          job_uuid: { $in: affectedJobUuids },
          status: { $in: ["queued", "optimizing"] },
        },
        {
          $set: {
            status: "skipped",
            skip_reason: "Monthly plan limit reached",
            error_message: null,
            completed_at: now,
          },
        }
      ),
      BrandJob.updateMany(
        {
          store_hash: storeHash,
          job_uuid: { $in: affectedJobUuids },
          status: { $in: ["pending", "fetching", "processing"] },
        },
        {
          $set: {
            status: "paused_plan_limit",
            completed_at: null,
          },
        }
      ),
      ...(brandIds.length > 0
        ? [
            BrandImageStatus.updateMany(
              {
                store_hash: storeHash,
                brand_id: { $in: brandIds },
                status: "optimizing",
              },
              {
                $set: {
                  status: "pending",
                  image_update_status: "pending",
                },
              }
            ),
          ]
        : []),
    ]);

    return { error: null, cleared: itemResult.modifiedCount || 0 };
  } catch (err) {
    console.error("[pauseBrandJobsForPlanLimit]", err.message);
    return { error: err.message, cleared: 0 };
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

  if (status === "optimizing" || status === "restoring") {
    $set.started_at = new Date();
    $set.error_message = null;
  }

  if (status === "optimized" || status === "restored") {
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
  storeHash: storeHashHint = null,
  success,
  skipped = false,
  skipReason = null,
  errorMessage = null,
  savedBytes = null,
  savedPercentage = null,
  successStatus = "optimized",
}) => {
  if (!jobUuid) return { error: "jobUuid is required" };

  const itemStatus = skipped ? "skipped" : success ? successStatus : "failed";
  const itemMessage = skipped
    ? skipReason || "Brand skipped"
    : success
      ? null
      : errorMessage ||
        (successStatus === "restored"
          ? "Brand image restore failed"
          : "Brand image optimization failed");

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
    if (skipped) {
      jobIncrement.skipped_images = 1;
    } else if (success) {
      jobIncrement.success_images = 1;
    } else {
      jobIncrement.failed_images = 1;
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

    const storeHash = storeHashHint || updatedJob?.store_hash || null;
    // Consume one dashboard pending slot when a queued optimize item finishes
    // (success or fail). Skips and restores do not touch pending.
    if (
      !skipped &&
      !RESTORE_SUCCESS_STATUSES.has(String(successStatus || "").toLowerCase()) &&
      storeHash
    ) {
      const pendingResult = await adjustPendingImages(storeHash, -1);
      if (pendingResult.error) {
        console.error(
          "[recordBrandJobItemResult] pending decrement failed:",
          pendingResult.error
        );
      }
    } else if (!skipped && !storeHash) {
      console.error(
        "[recordBrandJobItemResult] missing storeHash — pending_images not decremented",
        { jobUuid, brandId }
      );
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
