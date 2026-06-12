const crypto = require("node:crypto");
const { get } = require("../../utils/axiosUtils");
const { CategoryImage, CategoryImageStatus } = require("../../models");
const CategoryJob = require("../../models/CategoryJob");
const CategoryJobItem = require("../../models/CategoryJobItem");
const { getImageSizesFromUrls } = require("../../utils/sharpFunction");
const { compressCategoryImage } = require("./utils/compressCategoryImage");
const { fetchCategoryById } = require("./utils/bigCommerceCategoryImage");
const {
  appendCategoryImageLog,
  standaloneCategoryJobUuid,
} = require("./utils/categoryActivityLog");
const { restoreSingleCategoryImage } = require("./utils/restoreCategoryImage");
const { normalizeJobType } = require("../../models/constants");
const config = require("../../config");

/** Category IDs whose status should prevent re-queuing. */
const SKIP_CATEGORY_STATUSES = new Set(["optimized", "optimizing"]);

async function logCategoryOptimizationEvent({
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

  const { error } = await appendCategoryImageLog({
    jobUuid: standaloneCategoryJobUuid(storeHash, categoryId),
    storeHash,
    channelId,
    treeId,
    jobType: "single",
    categoryId,
    logType,
    step,
    message,
    meta,
  });

  if (error) {
    console.warn("[optimizeCategoryImageSingle]", error, { step, categoryId });
  }
}

const bcJsonHeaders = (accessToken) => ({
  "X-Auth-Token": accessToken,
  Accept: "application/json",
  "Content-Type": "application/json",
});

function bcCategoriesUrl(storeHash, params) {
  return `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/trees/categories?${params.toString()}`;
}

function bcTreesUrl(storeHash, params) {
  return `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/trees?${params.toString()}`;
}

function hasCategoryImageUrl(category) {
  const url = category?.image_url;
  return typeof url === "string" && url.trim().length > 0;
}

function normalizeCategoryStatus(dbStatus) {
  const raw = String(dbStatus || "pending").toLowerCase();
  if (raw === "uploaded" || raw === "optimized") return "optimized";
  if (raw === "processing") return "optimizing";
  if (raw === "skipped") return "pending";
  return raw;
}

async function resolveCategoryTreeIds(storeHash, accessToken, channelId) {
  if (!channelId) return [];

  const params = new URLSearchParams({
    limit: "50",
    page: "1",
    "channel_id:in": String(channelId),
  });

  const response = await get(
    bcTreesUrl(storeHash, params),
    bcJsonHeaders(accessToken),
    { timeout: config.api.bigCommerceTimeoutMs }
  );

  const trees = Array.isArray(response?.data) ? response.data : [];
  return trees.map((tree) => tree?.id).filter((id) => id != null);
}

async function fetchCategoriesFromBigCommerce({
  storeHash,
  accessToken,
  page,
  limit,
  treeId = null,
  treeIds = [],
}) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });

  if (treeId != null) {
    params.set("tree_id:in", String(treeId));
  } else if (treeIds.length > 0) {
    params.set("tree_id:in", treeIds.join(","));
  }

  return get(
    bcCategoriesUrl(storeHash, params),
    bcJsonHeaders(accessToken),
    { timeout: config.api.bigCommerceTimeoutMs }
  );
}

function buildStorefrontCategoryUrl(imageBaseUrl, customUrl) {
  const storefrontBase = imageBaseUrl
    ? String(imageBaseUrl).replace(/\/$/, "")
    : "";

  const customPath =
    customUrl?.url != null ? String(customUrl.url).trim() : "";

  if (!storefrontBase || !customPath) {
    return null;
  }

  const normalizedPath = customPath.startsWith("/")
    ? customPath
    : `/${customPath}`;

  return `${storefrontBase}${normalizedPath}`;
}

function matchesCategorySearch(category, search) {
  if (!search) {
    return true;
  }

  const term = search.toLowerCase();
  const name = String(category?.name || "").toLowerCase();
  const pageTitle = String(category?.page_title || "").toLowerCase();
  const categoryId = String(category?.category_id || "");

  return (
    name.includes(term) ||
    pageTitle.includes(term) ||
    categoryId.includes(term)
  );
}

function normalizeImageUrlForCompare(url) {
  return String(url || "").split("?")[0].toLowerCase();
}

function getCategoryOptimizationStatus(liveImageUrl, imageRow, statusRow) {
  const rawStatus = String(statusRow?.status || "pending").toLowerCase();
  const live = normalizeImageUrlForCompare(liveImageUrl);
  const original = normalizeImageUrlForCompare(imageRow?.original_url);
  const optimized = normalizeImageUrlForCompare(imageRow?.optimized_url);

  if (rawStatus === "optimizing" || rawStatus === "processing") {
    return "optimizing";
  }

  if (["optimized", "uploaded"].includes(rawStatus)) {
    // Only revert to "pending" when:
    //   - We actually uploaded a NEW image (optimized_url !== original_url)
    //   - But the live image has since reverted back to the original URL
    // This covers the case where a merchant manually reverts their category image.
    //
    // We do NOT return "pending" when original_url === optimized_url (image was
    // already at optimal quality, no upload was done) — live === original in that
    // case is expected and correct.
    if (original && optimized && original !== optimized && live === original) {
      return "pending";
    }

    // Trust the DB "optimized" status for all other cases:
    //   - live === optimized (exact match)
    //   - live === original === optimized (already optimal, no upload done)
    //   - live differs from both (BigCommerce reformatted the CDN URL after upload)
    return "optimized";
  }

  if (original && live !== original) {
    return "pending";
  }

  return normalizeCategoryStatus(rawStatus);
}

async function loadCategoryOptimizationStateFromDb(storeHash, categoryIds) {
  if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
    return {
      imagesByCategoryId: Object.create(null),
      statusByCategoryId: Object.create(null),
    };
  }

  const [imageRows, statusRows] = await Promise.all([
    CategoryImage.find({
      store_hash: storeHash,
      category_id: { $in: categoryIds },
    })
      .select({
        category_id: 1,
        original_url: 1,
        optimized_url: 1,
        category_name: 1,
        original_image_path: 1,
        optimized_image_path: 1,
        tree_id: 1,
        _id: 0,
      })
      .lean(),
    CategoryImageStatus.find({
      store_hash: storeHash,
      category_id: { $in: categoryIds },
    })
      .select({
        category_id: 1,
        status: 1,
        _id: 0,
      })
      .lean(),
  ]);

  const imagesByCategoryId = Object.create(null);
  const statusByCategoryId = Object.create(null);

  for (const row of imageRows) {
    imagesByCategoryId[row.category_id] = row;
  }
  for (const row of statusRows) {
    statusByCategoryId[row.category_id] = row;
  }

  return { imagesByCategoryId, statusByCategoryId };
}

function enrichCategoryWithImageMeta(
  category,
  imageRow,
  statusRow,
  sizeByCategoryId,
  { imageBaseUrl = null } = {}
) {
  const categoryId = category.category_id;
  const hasImage = hasCategoryImageUrl(category);

  category.has_image = hasImage;
  category.storefront_url = buildStorefrontCategoryUrl(
    imageBaseUrl,
    category.custom_url
  );
  category.category_name = category.name || imageRow?.category_name || null;

  if (!hasImage) {
    category.image_url = null;
    category.status = "no_image";
    category.can_optimize = false;
    category.size = {
      bytes: null,
      width: null,
      height: null,
      format: null,
    };
    return category;
  }

  const sizeInfo = sizeByCategoryId[categoryId];

  category.status = getCategoryOptimizationStatus(
    category.image_url,
    imageRow,
    statusRow
  );
  category.can_optimize = true;

  if (imageRow?.optimized_url && category.status === "optimized") {
    const liveNormalized = normalizeImageUrlForCompare(category.image_url);
    const optimizedNormalized = normalizeImageUrlForCompare(imageRow.optimized_url);

    if (liveNormalized === optimizedNormalized) {
      // Live URL matches our stored optimized URL exactly — no override needed
      category.optimized_url = imageRow.optimized_url;
    } else {
      // BC may have reformatted the CDN URL after our upload (e.g. added _product
      // suffix or changed directory). Keep the live URL as image_url since that is
      // what BC is actually serving; store the DB value as reference only.
      category.optimized_url = category.image_url;
    }
  }

  if (imageRow?.original_image_path) {
    category.original_image_path = imageRow.original_image_path;
  }

  if (imageRow?.optimized_image_path) {
    category.optimized_image_path = imageRow.optimized_image_path;
  }

  category.size = sizeInfo
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

  return category;
}

exports.fetchCategoryImages = async ({
  storeHash,
  accessToken,
  channelId,
  page,
  limit,
  treeId = null,
  search = "",
  imageBaseUrl = null,
}) => {
  const resolvedTreeIds =
    treeId == null
      ? await resolveCategoryTreeIds(storeHash, accessToken, channelId)
      : [];

  const response = await fetchCategoriesFromBigCommerce({
    storeHash,
    accessToken,
    page,
    limit,
    treeId,
    treeIds: resolvedTreeIds,
  });

  const allCategories = Array.isArray(response?.data) ? response.data : [];
  let categories = allCategories;

  if (search) {
    categories = categories.filter((category) =>
      matchesCategorySearch(category, search)
    );
  }

  const categoryIds = categories.map((category) => category.category_id);

  const { imagesByCategoryId, statusByCategoryId } =
    await loadCategoryOptimizationStateFromDb(storeHash, categoryIds);

  const imageUrlItems = categories
    .filter(hasCategoryImageUrl)
    .map((category) => ({
      imageId: category.category_id,
      url: category.image_url,
    }));

  const sizeByCategoryId =
    imageUrlItems.length > 0
      ? await getImageSizesFromUrls(imageUrlItems, {
          concurrency: config.image.sizeFetchConcurrency,
          useRetry: true,
          retries: config.image.sizeFetchRetries,
          retryDelayMs: config.image.sizeFetchRetryDelayMs,
        })
      : Object.create(null);

  for (const category of categories) {
    const categoryId = category.category_id;

    enrichCategoryWithImageMeta(
      category,
      imagesByCategoryId[categoryId],
      statusByCategoryId[categoryId],
      sizeByCategoryId,
      { imageBaseUrl }
    );
  }

  return {
    categories,
    pagination: response?.meta?.pagination || null,
    tree_ids: treeId != null ? [treeId] : resolvedTreeIds,
    count: categories.length,
  };
};

async function shouldSkipCategoryOptimization(
  storeHash,
  channelId,
  categoryId,
  { force = false, clientStatus = "" } = {}
) {
  if (force) {
    return { skip: false };
  }

  const normalizedClientStatus = String(clientStatus || "").toLowerCase();
  if (["optimized", "optimizing"].includes(normalizedClientStatus)) {
    return {
      skip: true,
      reason: "Category image is already optimized or currently optimizing",
    };
  }

  const statusRow = await CategoryImageStatus.findOne({
    store_hash: storeHash,
    category_id: categoryId,
    status: { $in: ["optimized", "optimizing"] },
  })
    .select({ status: 1 })
    .lean();

  if (statusRow) {
    return {
      skip: true,
      reason: "Category image already optimized",
      status: statusRow.status,
    };
  }

  return { skip: false };
}

exports.optimizeCategoryImageSingle = async ({
  storeHash,
  accessToken,
  channelId = 1,
  treeId = null,
  categoryId,
  imageUrl = null,
  categoryName = null,
  settings = {},
  force = false,
  clientStatus = "",
}) => {
  const resolvedCategoryId = Number(categoryId);
  if (!Number.isFinite(resolvedCategoryId) || resolvedCategoryId <= 0) {
    return {
      success: false,
      status: 400,
      message: "category_id is required and must be a positive number",
    };
  }

  const resolvedChannelId =
    Number.isFinite(Number(channelId)) && Number(channelId) > 0
      ? Number(channelId)
      : 1;

  const resolvedTreeId =
    treeId != null &&
    Number.isFinite(Number(treeId)) &&
    Number(treeId) > 0
      ? Number(treeId)
      : null;

  const { skip, reason, status: existingStatus } =
    await shouldSkipCategoryOptimization(
      storeHash,
      resolvedChannelId,
      resolvedCategoryId,
      { force, clientStatus }
    );

  if (skip) {
    await logCategoryOptimizationEvent({
      storeHash,
      channelId: resolvedChannelId,
      treeId: resolvedTreeId,
      categoryId: resolvedCategoryId,
      logType: "info",
      step: "skip",
      message: reason || "Category image already optimized",
      meta: { status: existingStatus || "optimized" },
    });

    return {
      success: true,
      skipped: true,
      message: reason || "Category image already optimized",
      data: {
        category_id: resolvedCategoryId,
        status: existingStatus || "optimized",
      },
    };
  }

  let resolvedImageUrl =
    typeof imageUrl === "string" && imageUrl.trim() ? imageUrl.trim() : null;
  let resolvedCategoryName = categoryName || null;
  let resolvedTreeIdFromBc = resolvedTreeId;

  if (!resolvedImageUrl) {
    const category = await fetchCategoryById({
      storeHash,
      accessToken,
      categoryId: resolvedCategoryId,
      treeId: resolvedTreeId,
    });

    if (!category) {
      await logCategoryOptimizationEvent({
        storeHash,
        channelId: resolvedChannelId,
        treeId: resolvedTreeId,
        categoryId: resolvedCategoryId,
        logType: "error",
        step: "optimize_failed",
        message: "Category not found in BigCommerce catalog",
        meta: { tree_id: resolvedTreeId },
      });

      return {
        success: false,
        status: 404,
        message: "Category not found",
      };
    }

    resolvedImageUrl =
      typeof category.image_url === "string" && category.image_url.trim()
        ? category.image_url.trim()
        : null;
    resolvedCategoryName =
      resolvedCategoryName || category.name || category.page_title || null;
    resolvedTreeIdFromBc = resolvedTreeIdFromBc ?? category.tree_id ?? null;
  }

  if (!resolvedImageUrl) {
    await CategoryImageStatus.updateOne(
      { store_hash: storeHash, category_id: resolvedCategoryId },
      {
        $set: {
          status: "skipped",
          image_update_status: "complete",
          channel_id: resolvedChannelId,
          ...(resolvedTreeIdFromBc != null ? { tree_id: resolvedTreeIdFromBc } : {}),
        },
      },
      { upsert: true }
    );

    await logCategoryOptimizationEvent({
      storeHash,
      channelId: resolvedChannelId,
      treeId: resolvedTreeIdFromBc,
      categoryId: resolvedCategoryId,
      logType: "info",
      step: "skip",
      message: "Category has no image_url",
      meta: {
        category_name: resolvedCategoryName,
        status: "no_image",
      },
    });

    return {
      success: true,
      skipped: true,
      message: "Category has no image_url",
      data: {
        category_id: resolvedCategoryId,
        category_name: resolvedCategoryName,
        status: "no_image",
      },
    };
  }

  await logCategoryOptimizationEvent({
    storeHash,
    channelId: resolvedChannelId,
    treeId: resolvedTreeIdFromBc,
    categoryId: resolvedCategoryId,
    logType: "info",
    step: "queue",
    message: "Category image optimization started",
    meta: {
      image_url: resolvedImageUrl,
      category_name: resolvedCategoryName,
      tree_id: resolvedTreeIdFromBc,
    },
  });

  const result = await compressCategoryImage({
    storeHash,
    accessToken,
    channelId: resolvedChannelId,
    treeId: resolvedTreeIdFromBc,
    categoryId: resolvedCategoryId,
    imageUrl: resolvedImageUrl,
    categoryName: resolvedCategoryName,
    settings,
    force,
  });

  if (!result.success) {
    return {
      success: false,
      status: 500,
      message: result.error || "Category image optimization failed",
    };
  }

  return result;
};

exports.restoreCategoryImageSingle = async ({
  storeHash,
  accessToken,
  channelId,
  categoryId,
  treeId = null,
}) => {
  return restoreSingleCategoryImage({
    storeHash,
    accessToken,
    channelId,
    categoryId,
    treeId,
  });
};

//=======================================================
// Category Job Management (mirrors imageOptimization/services.js job helpers)
//=======================================================

/**
 * Category IDs that are already optimized / optimizing for this store.
 * Returns a Set<Number> of category_ids to skip.
 */
exports.getAlreadyOptimizedCategoryIdSet = async (storeHash, items = []) => {
  const skipIds = new Set();
  if (!storeHash) return skipIds;

  const categoryIds = [];
  for (const item of Array.isArray(items) ? items : []) {
    const cid = Number(item?.category_id ?? item);
    if (Number.isFinite(cid)) categoryIds.push(cid);
  }

  if (categoryIds.length === 0) return skipIds;

  const rows = await CategoryImageStatus.find({
    store_hash: storeHash,
    category_id: { $in: categoryIds },
    status: { $in: Array.from(SKIP_CATEGORY_STATUSES) },
  })
    .select({ category_id: 1 })
    .lean();

  for (const row of rows) {
    if (row?.category_id != null) {
      skipIds.add(Number(row.category_id));
    }
  }

  return skipIds;
};

/**
 * Worker-side check: should this category be skipped mid-queue?
 */
exports.shouldSkipCategoryOptimization = async (storeHash, categoryId) => {
  const cid = Number(categoryId);
  if (!storeHash || !Number.isFinite(cid)) {
    return { skip: false, reason: null };
  }

  const statusRow = await CategoryImageStatus.findOne({
    store_hash: storeHash,
    category_id: cid,
    status: { $in: Array.from(SKIP_CATEGORY_STATUSES) },
  })
    .select({ status: 1 })
    .lean();

  if (statusRow) {
    return {
      skip: true,
      reason:
        statusRow.status === "optimizing"
          ? "Category image is currently being optimized"
          : "Category image is already optimized",
    };
  }

  return { skip: false, reason: null };
};

/**
 * Create the top-level CategoryJob doc + all CategoryJobItem docs in one shot.
 */
exports.createCategoryBulkJob = async ({
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
    return {
      error: `Invalid job_type "${jobType}"`,
      jobUuid: null,
      doc: null,
    };
  }

  try {
    const doc = await CategoryJob.create({
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
      await CategoryJobItem.insertMany(jobItems, { ordered: false });
    }

    return { error: null, jobUuid, doc };
  } catch (err) {
    console.error("[createCategoryBulkJob]", err.message);
    return { error: err.message, jobUuid: null, doc: null };
  }
};

/**
 * Mark a single CategoryJobItem as "optimizing" when the worker picks it up.
 */
exports.setCategoryJobItemStatus = async ({
  jobUuid,
  categoryId,
  status,
  errorMessage = null,
  savedBytes = null,
  savedPercentage = null,
}) => {
  if (!jobUuid || categoryId == null) {
    return { error: "jobUuid and categoryId are required to update job item status" };
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
    await CategoryJobItem.updateOne(
      { job_uuid: jobUuid, category_id: Number(categoryId) },
      { $set }
    );
    return { error: null };
  } catch (err) {
    return { error: err.message };
  }
};

/**
 * After the worker finishes (success / skip / fail) — update the item row
 * and roll up the counters on the parent CategoryJob.
 */
exports.recordCategoryJobItemResult = async ({
  jobUuid,
  categoryId,
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
    ? skipReason || "Category skipped"
    : success
      ? null
      : errorMessage || "Category image optimization failed";

  try {
    const itemUpdate = CategoryJobItem.updateOne(
      { job_uuid: jobUuid, category_id: Number(categoryId) },
      {
        $set: {
          status: itemStatus,
          completed_at: new Date(),
          ...(skipped
            ? { skip_reason: itemMessage, error_message: null }
            : { error_message: itemMessage }),
          ...(success && savedBytes != null ? { saved_bytes: savedBytes } : {}),
          ...(success && savedPercentage != null
            ? { saved_percentage: savedPercentage }
            : {}),
        },
      }
    );

    const jobIncrement = { processed_images: 1 };
    if (skipped) {
      // skipped images are not counted as success or failure
    } else if (success) {
      jobIncrement.success_images = 1;
    } else {
      jobIncrement.failed_images = 1;
    }

    const jobUpdate = CategoryJob.findOneAndUpdate(
      { job_uuid: jobUuid },
      { $inc: jobIncrement },
      { new: true }
    );

    const [, updatedJob] = await Promise.all([itemUpdate, jobUpdate]);

    if (updatedJob) {
      const queued = updatedJob.queued_images || 0;
      const processed = updatedJob.processed_images || 0;

      if (processed >= queued) {
        await CategoryJob.updateOne(
          { job_uuid: jobUuid, status: { $ne: "completed" } },
          {
            $set: {
              status: "completed",
              completed_at: new Date(),
            },
          }
        );
      }
    }

    return { error: null };
  } catch (err) {
    console.error("[recordCategoryJobItemResult]", err.message);
    return { error: err.message };
  }
};

/**
 * Write skip warning logs for categories that were skipped at queue time.
 */
exports.writeCategorySkipLogs = async (skippedEntries = []) => {
  if (!skippedEntries.length) return { error: null };

  try {
    const CategoryImageLog = require("../../models/CategoryImageLog");
    await CategoryImageLog.insertMany(
      skippedEntries.map((s) => ({
        job_uuid: s.job_uuid,
        store_hash: s.store_hash,
        channel_id: s.channel_id || 1,
        tree_id: s.tree_id ?? null,
        source_type: "category",
        job_type: s.job_type,
        category_id: Number(s.category_id),
        log_type: "warning",
        step: "skip",
        message: s.reason || "Category skipped",
        meta: { index: s.index },
      })),
      { ordered: false }
    );
    return { error: null };
  } catch (err) {
    console.error("[writeCategorySkipLogs]", err.message);
    return { error: err.message };
  }
};

/**
 * Fetch a CategoryJob with its items and recent logs (for status polling).
 */
exports.getCategoryJobStatus = async (jobUuid, storeHash) => {
  const query = { job_uuid: jobUuid };
  const logQuery = { job_uuid: jobUuid };
  if (storeHash) {
    query.store_hash = storeHash;
    logQuery.store_hash = storeHash;
  }

  try {
    const CategoryImageLog = require("../../models/CategoryImageLog");

    const [job, logs, items] = await Promise.all([
      CategoryJob.findOne(query).lean(),
      CategoryImageLog.find(logQuery)
        .sort({ created_at: -1 })
        .limit(200)
        .lean(),
      CategoryJobItem.find({ job_uuid: jobUuid }).sort({ created_at: 1 }).lean(),
    ]);

    if (!job) {
      return { error: null, job: null, logs, items };
    }

    const queued = job.queued_images || 0;
    const processed = job.processed_images || 0;

    return {
      error: null,
      job: {
        ...job,
        pending_images: Math.max(0, queued - processed),
      },
      logs,
      items,
    };
  } catch (err) {
    console.error("[getCategoryJobStatus]", err.message);
    return { error: err.message, job: null, logs: [], items: [] };
  }
};
