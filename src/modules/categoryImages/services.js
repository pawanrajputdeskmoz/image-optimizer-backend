const crypto = require("node:crypto");
const { get } = require("../../utils/axiosUtils");
const { CategoryImage, CategoryImageStatus } = require("../../models");
const CategoryJob = require("../../models/CategoryJob");
const CategoryJobItem = require("../../models/CategoryJobItem");
const User = require("../../models/User");
const { getRedis } = require("../../db/redis");
const { categoryImageQueue } = require("../../queue/categoryImageQueue");
const {
  defaultWorkerJobOptions,
  webhookWorkerJobOptions,
} = require("../../queue/workerJobOptions");
const { getImageSizesFromUrls } = require("../../utils/sharpFunction");
const { compressCategoryImage } = require("./utils/compressCategoryImage");
const { fetchCategoryById } = require("./utils/bigCommerceCategoryImage");
const {
  appendCategoryImageLog,
  standaloneCategoryJobUuid,
} = require("./utils/categoryActivityLog");
const { restoreSingleCategoryImage } = require("./utils/restoreCategoryImage");
const { normalizeJobType } = require("../../models/constants");
const {
  fetchStoreOptimizationSettings,
  hasAnyOptimizationFeatureEnabled,
} = require("../imageOptimization/services");
const {
  appendCategoryWebhookLog,
  buildCategoryBurstTraceId,
} = require("../installation/utils/categoryWebhookActivityLog");
const config = require("../../config");
const { adjustPendingImages } = require("../../utils/storePendingImages");

const SKIP_PENDING_CATEGORY_STATUSES = new Set([
  "optimized",
  "optimizing",
  "pending",
]);

/** Category IDs whose status should prevent re-queuing. */
const SKIP_CATEGORY_STATUSES = new Set(["optimized", "optimizing"]);
const RESTORE_SUCCESS_STATUSES = new Set(["restored"]);

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

  await registerPendingCategoryImages(storeHash, [
    {
      category_id: resolvedCategoryId,
      channel_id: resolvedChannelId,
      tree_id: resolvedTreeIdFromBc,
    },
  ]);

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

  // Single optimize has no CategoryJobItem record step — consume pending here.
  await adjustPendingImages(storeHash, -1);

  if (!result.success) {
    if (result.plan_limit) {
      return {
        success: false,
        status: 403,
        message: result.error || "Monthly image optimization limit reached",
      };
    }
    return {
      success: false,
      status: 500,
      message: result.error || "Category image optimization failed",
    };
  }

  return result;
};

/**
 * Fetch all categories eligible for restore for a given store.
 * Returns only categories that have an optimized/uploaded status AND
 * a backup file path recorded in CategoryImage.
 */
exports.fetchRestorableCategoriesForStore = async (storeHash) => {
  const statuses = await CategoryImageStatus.find({
    store_hash: storeHash,
    status: { $in: ["optimized", "uploaded"] },
  })
    .select({ category_id: 1, tree_id: 1, channel_id: 1 })
    .lean();

  if (!statuses.length) return [];

  const categoryIds = statuses.map((s) => s.category_id);

  const images = await CategoryImage.find({
    store_hash: storeHash,
    category_id: { $in: categoryIds },
    original_image_path: { $ne: null, $exists: true },
  })
    .select({ category_id: 1 })
    .lean();

  const hasBackup = new Set(images.map((img) => img.category_id));

  return statuses
    .filter((s) => hasBackup.has(s.category_id))
    .map((s) => ({
      category_id: s.category_id,
      tree_id: s.tree_id ?? null,
      channel_id: s.channel_id || 1,
    }));
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

/**
 * Fetch ALL categories for a channel from BigCommerce in paginated chunks.
 * Silently skips categories with no image_url and already-optimized categories.
 * Returns items shaped for queueBulkCategoryJobs.
 */
exports.fetchAllCategoryImagesInChunks = async ({
  storeHash,
  accessToken,
  channelId,
  pageSize = config.catalog.pageSize,
  skipOptimized = true,
}) => {
  const treeIds = await resolveCategoryTreeIds(storeHash, accessToken, channelId);

  if (treeIds.length === 0) {
    return {
      error: null,
      items: [],
      meta: { total_pages_fetched: 0, total_categories_fetched: 0, no_image_skipped: 0, already_optimized_skipped: 0 },
    };
  }

  const limit = Math.min(250, Math.max(1, Number(pageSize) || config.catalog.pageSize));
  const items = [];
  let page = 1;
  let totalPages = 1;
  let totalCategoriesFetched = 0;
  let noImageSkipped = 0;
  let alreadyOptimizedSkipped = 0;

  try {
    while (page <= totalPages) {
      const response = await fetchCategoriesFromBigCommerce({
        storeHash,
        accessToken,
        page,
        limit,
        treeIds,
      });

      const categories = Array.isArray(response?.data) ? response.data : [];
      const pagination = response?.meta?.pagination || {};
      totalPages = Number(pagination.total_pages) || 1;
      totalCategoriesFetched += categories.length;

      const pageItems = [];

      for (const category of categories) {
        if (!hasCategoryImageUrl(category)) {
          noImageSkipped++;
          continue;
        }
        pageItems.push({
          category_id: category.category_id,
          image_url: String(category.image_url).trim(),
          category_name: category.name || null,
          tree_id: category.tree_id ?? null,
          shop: storeHash,
        });
      }

      if (skipOptimized && pageItems.length > 0) {
        const categoryIds = pageItems.map((item) => Number(item.category_id));
        const statusRows = await CategoryImageStatus.find({
          store_hash: storeHash,
          category_id: { $in: categoryIds },
          status: { $in: ["optimized", "optimizing"] },
        })
          .select({ category_id: 1 })
          .lean();

        const skipIds = new Set(statusRows.map((row) => Number(row.category_id)));
        for (const item of pageItems) {
          if (skipIds.has(Number(item.category_id))) {
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
      error: err?.response?.data?.title || err?.message || "Failed to fetch categories from BigCommerce",
      items: [],
      meta: null,
    };
  }

  return {
    error: null,
    items,
    meta: {
      total_pages_fetched: totalPages,
      total_categories_fetched: totalCategoriesFetched,
      no_image_skipped: noImageSkipped,
      already_optimized_skipped: alreadyOptimizedSkipped,
    },
  };
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
  userId = null,
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
      user_id: userId,
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
      await CategoryJobItem.insertMany(
        jobItems.map((item) => ({
          ...item,
          user_id: userId,
          job_id: doc._id,
        })),
        { ordered: false }
      );
    }

    return { error: null, jobUuid, doc };
  } catch (err) {
    console.error("[createCategoryBulkJob]", err.message);
    return { error: err.message, jobUuid: null, doc: null };
  }
};

/**
 * Mark category images pending for store dashboard stats.
 * Skips already optimized, optimizing, or already-pending categories.
 */
async function registerPendingCategoryImages(
  storeHash,
  categories = [],
  userId = null
) {
  if (!storeHash || !categories.length) return { registered: 0, error: null };

  const normalized = [];
  const seen = new Set();

  for (const row of categories) {
    const categoryId = Number(row.category_id ?? row.categoryId ?? row);
    if (!Number.isFinite(categoryId) || categoryId <= 0 || seen.has(categoryId)) {
      continue;
    }
    seen.add(categoryId);
    const channelId = Number(row.channel_id ?? row.channelId) || 1;
    const treeId =
      row.tree_id != null && Number.isFinite(Number(row.tree_id))
        ? Number(row.tree_id)
        : null;
    normalized.push({ categoryId, channelId, treeId });
  }

  if (!normalized.length) return { registered: 0, error: null };

  try {
    const categoryIds = normalized.map((row) => row.categoryId);
    const existingRows = await CategoryImageStatus.find({
      store_hash: storeHash,
      category_id: { $in: categoryIds },
    })
      .select({ category_id: 1, status: 1 })
      .lean();

    const skipIds = new Set();
    for (const row of existingRows) {
      if (SKIP_PENDING_CATEGORY_STATUSES.has(row.status)) {
        skipIds.add(Number(row.category_id));
      }
    }

    const toRegister = normalized.filter((row) => !skipIds.has(row.categoryId));
    if (!toRegister.length) return { registered: 0, error: null };

    const bulkOps = toRegister.map((row) => ({
      updateOne: {
        filter: {
          store_hash: storeHash,
          category_id: row.categoryId,
        },
        update: {
          $set: {
            ...(userId ? { user_id: userId } : {}),
            status: "pending",
            image_update_status: "pending",
            channel_id: row.channelId,
            ...(row.treeId != null ? { tree_id: row.treeId } : {}),
          },
          $setOnInsert: {
            store_hash: storeHash,
            category_id: row.categoryId,
          },
        },
        upsert: true,
      },
    }));

    const bulkResult = await CategoryImageStatus.bulkWrite(bulkOps, {
      ordered: false,
    });
    const registered =
      (Number(bulkResult.upsertedCount) || 0) +
      (Number(bulkResult.modifiedCount) || 0);

    if (registered > 0) {
      await adjustPendingImages(storeHash, registered, userId);
    }

    return { registered, error: null };
  } catch (err) {
    console.error("[registerPendingCategoryImages]", err.message);
    return { registered: 0, error: err.message };
  }
}

exports.registerPendingCategoryImages = registerPendingCategoryImages;

exports.pauseCategoryJobsForPlanLimit = async (storeHash, jobUuids = []) => {
  const affectedJobUuids = [...new Set(jobUuids.filter(Boolean))];
  if (!storeHash || affectedJobUuids.length === 0) {
    return { error: null, cleared: 0 };
  }

  try {
    const pendingItems = await CategoryJobItem.find({
      store_hash: storeHash,
      job_uuid: { $in: affectedJobUuids },
      status: { $in: ["queued", "optimizing"] },
    })
      .select({ category_id: 1 })
      .lean();

    const categoryIds = [...new Set(pendingItems.map((item) => item.category_id))];
    const now = new Date();

    const [itemResult] = await Promise.all([
      CategoryJobItem.updateMany(
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
      CategoryJob.updateMany(
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
      ...(categoryIds.length > 0
        ? [
            CategoryImageStatus.updateMany(
              {
                store_hash: storeHash,
                category_id: { $in: categoryIds },
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
    console.error("[pauseCategoryJobsForPlanLimit]", err.message);
    return { error: err.message, cleared: 0 };
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

    const storeHash = storeHashHint || updatedJob?.store_hash || null;
    // Consume dashboard pending for finished optimize items (not skips/restores).
    if (
      !skipped &&
      !RESTORE_SUCCESS_STATUSES.has(String(successStatus || "").toLowerCase()) &&
      storeHash
    ) {
      const pendingResult = await adjustPendingImages(storeHash, -1);
      if (pendingResult.error) {
        console.error(
          "[recordCategoryJobItemResult] pending decrement failed:",
          pendingResult.error
        );
      }
    } else if (!skipped && !storeHash) {
      console.error(
        "[recordCategoryJobItemResult] missing storeHash — pending_images not decremented",
        { jobUuid, categoryId }
      );
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
exports.getCategoryJobStatus = async (jobUuid, storeHash, options = {}) => {
  const query = { job_uuid: jobUuid };
  const logQuery = { job_uuid: jobUuid };
  const itemQuery = { job_uuid: jobUuid };
  if (storeHash) {
    query.store_hash = storeHash;
    logQuery.store_hash = storeHash;
    itemQuery.store_hash = storeHash;
  }
  const itemLimit = Math.min(500, Math.max(1, Number(options.itemLimit) || 100));
  const itemPage = Math.max(1, Number(options.itemPage) || 1);
  const itemAfter =
    /^[a-f\d]{24}$/i.test(String(options.itemAfter || ""))
      ? String(options.itemAfter)
      : null;
  if (itemAfter) itemQuery._id = { $gt: itemAfter };

  try {
    const CategoryImageLog = require("../../models/CategoryImageLog");

    const [job, logs, items] = await Promise.all([
      CategoryJob.findOne(query).lean(),
      CategoryImageLog.find(logQuery)
        .sort({ created_at: -1 })
        .limit(200)
        .lean(),
      CategoryJobItem.find(itemQuery)
        .sort({ _id: 1 })
        .skip(itemAfter ? 0 : (itemPage - 1) * itemLimit)
        .limit(itemLimit)
        .lean(),
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
      items_pagination: {
        page: itemPage,
        limit: itemLimit,
        total: Number(job.total_images) || 0,
        next_cursor:
          items.length === itemLimit ? String(items[items.length - 1]._id) : null,
      },
    };
  } catch (err) {
    console.error("[getCategoryJobStatus]", err.message);
    return { error: err.message, job: null, logs: [], items: [] };
  }
};

const WEBHOOK_BURST_WINDOW_SEC = 3;
const WEBHOOK_BURST_MAX = 5;

function categoryWebhookBurstKeys(storeHash) {
  const prefix = `webhook:category:burst:${storeHash}`;
  return {
    count: `${prefix}:count`,
    bulk: `${prefix}:bulk`,
    categories: `${prefix}:categories`,
  };
}

/**
 * Track category webhook in a 3s burst window. Only 1–5 calls per store are processed.
 */
exports.trackCategoryWebhookBurst = async (storeHash, categoryId, logContext = {}) => {
  const { traceId, eventHash, scope } = logContext;
  const redis = getRedis();
  const keys = categoryWebhookBurstKeys(storeHash);
  const categoryKey = String(categoryId);

  await appendCategoryWebhookLog({
    traceId,
    storeHash,
    eventHash,
    scope,
    categoryId,
    step: "burst_track",
    message: `Tracking webhook burst for category ${categoryId}`,
  });

  const count = await redis.incr(keys.count);
  await redis.sadd(keys.categories, categoryKey);

  if (count === 1) {
    await redis.expire(keys.count, WEBHOOK_BURST_WINDOW_SEC + 2);
    await redis.expire(keys.categories, WEBHOOK_BURST_WINDOW_SEC + 2);
    await redis.del(keys.bulk);

    await categoryImageQueue.add(
      "category-webhook-process",
      { storeHash },
      webhookWorkerJobOptions({
        delay: WEBHOOK_BURST_WINDOW_SEC * 1000,
        jobId: `category-webhook-process-${storeHash}`,
      })
    );

    await appendCategoryWebhookLog({
      traceId,
      storeHash,
      eventHash,
      scope,
      categoryId,
      step: "burst_job_scheduled",
      message: "Scheduled delayed category webhook burst processing job",
      meta: { delay_sec: WEBHOOK_BURST_WINDOW_SEC },
    });
  } else if (count > WEBHOOK_BURST_MAX) {
    await redis.set(keys.bulk, "1", "EX", WEBHOOK_BURST_WINDOW_SEC + 2);

    await appendCategoryWebhookLog({
      traceId,
      storeHash,
      eventHash,
      scope,
      categoryId,
      logType: "warning",
      step: "burst_limit_exceeded",
      message: "Category webhook burst limit exceeded; bulk import mode enabled",
      meta: { count, max: WEBHOOK_BURST_MAX },
    });
  }

  return { count, ignored: count > WEBHOOK_BURST_MAX };
};

/**
 * After the burst window, fetch category images and queue optimization jobs.
 */
exports.processWebhookCategoryBurst = async (storeHash) => {
  const redis = getRedis();
  const keys = categoryWebhookBurstKeys(storeHash);
  const burstTraceId = buildCategoryBurstTraceId(storeHash, Date.now());

  const [countRaw, isBulk, categoryIds] = await Promise.all([
    redis.get(keys.count),
    redis.get(keys.bulk),
    redis.smembers(keys.categories),
  ]);

  await redis.del(keys.count, keys.bulk, keys.categories);

  const count = Number(countRaw) || 0;

  await appendCategoryWebhookLog({
    traceId: burstTraceId,
    storeHash,
    step: "burst_process_start",
    message: "Started category webhook burst processing",
    meta: { count, is_bulk: Boolean(isBulk), category_ids: categoryIds },
  });

  if (
    isBulk ||
    count > WEBHOOK_BURST_MAX ||
    count < 1 ||
    !Array.isArray(categoryIds) ||
    categoryIds.length === 0
  ) {
    const reason = isBulk || count > WEBHOOK_BURST_MAX ? "bulk_webhook_burst" : "empty_burst";

    await appendCategoryWebhookLog({
      traceId: burstTraceId,
      storeHash,
      logType: "warning",
      step: "burst_ignored",
      message: "Category webhook burst processing ignored",
      meta: { reason, count },
    });

    return {
      ignored: true,
      reason,
      count,
    };
  }

  const channelId = 1;
  const [user, settingsResult] = await Promise.all([
    User.findOne({
      store_hash: storeHash,
      installStatus: "installed",
    })
      .select({ access_token: 1 })
      .lean(),
    fetchStoreOptimizationSettings(storeHash, channelId),
  ]);

  const accessToken = user?.access_token;
  if (!accessToken || !String(accessToken).trim()) {
    await appendCategoryWebhookLog({
      traceId: burstTraceId,
      storeHash,
      logType: "warning",
      step: "burst_ignored",
      message: "Category webhook burst ignored because store is not installed",
      meta: { reason: "store_not_installed" },
    });
    return { ignored: true, reason: "store_not_installed" };
  }

  const { error: settingError, settings } = settingsResult;

  await appendCategoryWebhookLog({
    traceId: burstTraceId,
    storeHash,
    step: "settings_check",
    message: "Checked auto-optimize settings for category webhook burst",
    meta: {
      auto_optimize_new_category_images: Boolean(settings?.auto_optimize_new_category_images),
      has_optimization_feature: hasAnyOptimizationFeatureEnabled(settings),
      setting_error: settingError || null,
    },
  });

  if (
    settingError ||
    !settings?.auto_optimize_new_category_images ||
    !hasAnyOptimizationFeatureEnabled(settings)
  ) {
    await appendCategoryWebhookLog({
      traceId: burstTraceId,
      storeHash,
      logType: "warning",
      step: "burst_ignored",
      message: "Category webhook burst ignored because category auto optimize is disabled",
      meta: { reason: "auto_optimize_disabled" },
    });
    return { ignored: true, reason: "auto_optimize_disabled" };
  }

  const categoryEntries = [];

  for (const rawCategoryId of categoryIds) {
    const categoryId = Number(rawCategoryId);
    if (!Number.isFinite(categoryId)) continue;

    const category = await fetchCategoryById({
      storeHash,
      accessToken,
      categoryId,
    });

    const imageUrl =
      typeof category?.image_url === "string" && category.image_url.trim()
        ? category.image_url.trim()
        : null;

    await appendCategoryWebhookLog({
      traceId: burstTraceId,
      storeHash,
      categoryId,
      step: "category_images_fetch",
      message: "Fetched category image for webhook burst",
      meta: {
        has_image: Boolean(imageUrl),
        tree_id: category?.tree_id ?? null,
        category_name: category?.name ?? null,
      },
    });

    if (!imageUrl) continue;

    categoryEntries.push({
      category_id: categoryId,
      tree_id: category?.tree_id ?? null,
      image_url: imageUrl,
      category_name: category?.name || category?.page_title || null,
      channel_id: channelId,
    });
  }

  if (categoryEntries.length === 0) {
    await appendCategoryWebhookLog({
      traceId: burstTraceId,
      storeHash,
      logType: "warning",
      step: "no_images",
      message: "Category webhook burst finished with no optimizable images",
      meta: { count, category_ids: categoryIds },
    });
    return { ignored: true, reason: "no_images", count };
  }

  const skipOptimizedIds = await exports.getAlreadyOptimizedCategoryIdSet(
    storeHash,
    categoryEntries
  );

  const toQueue = [];
  const jobItems = [];
  const jobUuid = crypto.randomUUID();

  for (const entry of categoryEntries) {
    if (skipOptimizedIds.has(entry.category_id)) {
      jobItems.push({
        job_uuid: jobUuid,
        store_hash: storeHash,
        job_type: "webhook",
        category_id: entry.category_id,
        tree_id: entry.tree_id,
        image_url: entry.image_url,
        status: "skipped",
        skip_reason: "Category image is already optimized or currently optimizing",
      });
      continue;
    }

    jobItems.push({
      job_uuid: jobUuid,
      store_hash: storeHash,
      job_type: "webhook",
      category_id: entry.category_id,
      tree_id: entry.tree_id,
      image_url: entry.image_url,
      status: "queued",
    });

    toQueue.push(entry);
  }

  const { error: createJobError, doc: jobDoc } = await exports.createCategoryBulkJob({
    jobUuid,
    userId: user._id,
    storeHash,
    jobType: "webhook",
    totalImages: categoryEntries.length,
    queuedImages: toQueue.length,
    skippedImages: categoryEntries.length - toQueue.length,
    jobItems,
  });

  if (createJobError || !jobDoc) {
    await appendCategoryWebhookLog({
      traceId: burstTraceId,
      storeHash,
      logType: "error",
      step: "failed",
      message: "Failed to create category webhook optimization job",
      meta: { reason: createJobError },
    });
    return { ignored: true, reason: createJobError };
  }

  if (toQueue.length > 0) {
    await exports.registerPendingCategoryImages(
      storeHash,
      toQueue.map((entry) => ({
        category_id: entry.category_id,
        channel_id: entry.channel_id,
        tree_id: entry.tree_id,
      })),
      user._id
    );
  }

  await appendCategoryWebhookLog({
    traceId: burstTraceId,
    storeHash,
    step: "job_create",
    message: "Created category webhook optimization job",
    meta: {
      job_uuid: jobUuid,
      total_categories: categoryEntries.length,
      queued_categories: toQueue.length,
      skipped_categories: categoryEntries.length - toQueue.length,
    },
  });

  for (const entry of toQueue) {
    await categoryImageQueue.add(
      "optimize-category",
      {
        jobUuid,
        userId: user._id,
        jobId: jobDoc._id,
        job_type: "webhook",
        storeHash,
        accessToken,
        channelId: entry.channel_id,
        treeId: entry.tree_id,
        categoryId: entry.category_id,
        imageUrl: entry.image_url,
        categoryName: entry.category_name,
        settings,
      },
      defaultWorkerJobOptions({
        jobId: `category-webhook-${storeHash}-${entry.category_id}`,
      })
    );

    await appendCategoryWebhookLog({
      traceId: burstTraceId,
      storeHash,
      categoryId: entry.category_id,
      step: "optimize_queued",
      message: "Queued category image optimization from webhook burst",
      meta: { job_uuid: jobUuid },
    });
  }

  await appendCategoryWebhookLog({
    traceId: burstTraceId,
    storeHash,
    step: "complete",
    message: "Category webhook burst processing completed",
    meta: {
      count,
      categories: categoryIds.length,
      queued: toQueue.length,
      skipped: categoryEntries.length - toQueue.length,
      job_uuid: jobUuid,
    },
  });

  return {
    ignored: false,
    count,
    categories: categoryIds.length,
    queued: toQueue.length,
    skipped: categoryEntries.length - toQueue.length,
    job_uuid: jobUuid,
  };
};
