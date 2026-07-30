const crypto = require("node:crypto");
const path = require("node:path");
const StoreOptimizationSettings = require("../../models/StoreOptimizationSettings");
const ImageJob = require("../../models/ImageJob");
const ImageJobItem = require("../../models/ImageJobItem");
const ImageStatus = require("../../models/ImageStatus");
const ImageOptimization = require("../../models/ImageOptimization");
const ImageOptimizationLog = require("../../models/ImageOptimizationLog");
const {
  normalizeJobType,
  JOB_TYPES,
  RESTORE_JOB_TYPES,
  isRestoreJobType,
} = require("../../models/constants");
const {
  validateRestoreEligibility,
  restoreSingleImage,
  RESTORE_BACKUP_MS,
} = require("./utils/restoreImage");
const ImageOldData = require("../../models/ImageOldData");
const StoreImageStat = require("../../models/StoreImageStat");
const User = require("../../models/User");
const { get } = require("../../utils/axiosUtils");
const { getRedis } = require("../../db/redis");
const {
  addRestoreJob,
  pickRestoreQueueTier,
  TIER_HEAVY: RESTORE_TIER_HEAVY,
} = require("../../queue/imageRestoreQueues");
const { signalHeavyRestoreWorkerNeeded } = require("../../utils/elasticHeavyRestoreWorker");
const {
  addOptimizationJob,
  addOptimizationBatchJob,
  getOptimizationQueue,
  pickOptimizationQueueTier,
  TIER_HEAVY,
} = require("../../queue/imageOptimizationQueues");
const { signalHeavyWorkerNeeded } = require("../../utils/elasticHeavyOptimizationWorker");
const {
  canOptimizeImages,
  pauseJobForPlanLimit,
  getMonthlyQuotaStatus,
} = require("../plans/service");
const {
  webhookWorkerJobOptions,
  sleepBackoff,
  getJobAttempts,
} = require("../../queue/workerJobOptions");
const fs = require("node:fs/promises");
const { fetchProductImages } = require("./utils/bigCommerceProductImage");
const { resolveOptimizeFormat } = require("../../utils/sharpFunction");
const {
  updateProductImageMetadata,
} = require("./utils/bigCommerceProductImage");
const { resolveProductImageUrl } = require("./utils/urls");
const { fetchCatalogProducts } = require("../../utils/bcCatalogRateLimit");
const { appendImageLog } = require("./utils/imageActivityLog");
const {
  appendWebhookLog,
  buildBurstTraceId,
} = require("../installation/utils/webhookActivityLog");
const config = require("../../config");
const { storeDefaults: DEFAULT_STORE_SETTINGS } = config;

/** Tokens allowed in filename_template / alt_text_template (case-insensitive in brackets). */
const TEMPLATE_TOKEN_RE =
  /\[(name|sku|brand|mpn|page_title|price|type|condition|category|currency|store_name|image_name|image_file|sort_order|image_id)\]/gi;

const bcJsonHeaders = (accessToken) => ({
  "X-Auth-Token": accessToken,
  Accept: "application/json",
  "Content-Type": "application/json",
});

/**
 * First DB read in single-image optimize — store feature flags + templates.
 */
exports.fetchStoreOptimizationSettings = async (storeHash, channelId = 1) => {
  try {

    if (!storeHash) {
      return {
        error: "storeHash is required",
        settings: null,
      };
    }

    const resolvedChannelId =
      Number.isFinite(Number(channelId)) && Number(channelId) > 0
        ? Number(channelId)
        : 1;

    const doc = await StoreOptimizationSettings.findOne({
      store_hash: storeHash,
      channel_id: resolvedChannelId,
    })
      .select({
        optimize_image_enabled: 1,
        is_filename_template_enabled: 1,
        filename_template: 1,
        is_alt_text_template_enabled: 1,
        alt_text_template: 1,
        image_quality: 1,
        output_format: 1,
        auto_optimize_new_images: 1,
        auto_optimize_new_category_images: 1,
        product_sort_direction: 1,
      })
      .lean();

    const settings = !doc
      ? { ...DEFAULT_STORE_SETTINGS }
      : {
        optimize_image_enabled:
          doc.optimize_image_enabled !== false,

        is_filename_template_enabled:
          Boolean(doc.is_filename_template_enabled),

        filename_template:
          doc.filename_template ||
          DEFAULT_STORE_SETTINGS.filename_template,

        is_alt_text_template_enabled:
          Boolean(doc.is_alt_text_template_enabled),

        alt_text_template:
          doc.alt_text_template ||
          DEFAULT_STORE_SETTINGS.alt_text_template,

        image_quality:
          doc.image_quality ??
          DEFAULT_STORE_SETTINGS.image_quality,

        output_format:
          doc.output_format ||
          DEFAULT_STORE_SETTINGS.output_format,

        auto_optimize_new_images:
          Boolean(doc.auto_optimize_new_images),

        auto_optimize_new_category_images:
          Boolean(doc.auto_optimize_new_category_images),

        product_sort_direction:
          doc.product_sort_direction === "desc" ? "desc" : "asc",
      };

    return {
      error: null,
      settings,
    };

  } catch (err) {

    return {
      error: err.message,
      settings: null,
    };
  }
};



exports.applyImageTemplate = (template, context = {}) => {
  if (!template || typeof template !== "string") {
    return "";
  }

  return template
    .replace(TEMPLATE_TOKEN_RE, (_, token) => {
      const key = String(token).toLowerCase();
      const value = context[key];
      return value != null && String(value).trim() !== ""
        ? String(value).trim()
        : "";
    })
    .replace(/\s+/g, " ")
    .trim();
};

exports.sanitizeImageFileName = (name) => {
  const cleaned = String(name || "image")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);

  return cleaned || "image";
};

exports.buildFilenameFromTemplate = (
  template,
  context,
  sourceFileName = "image.jpg",
  outputFormat = null
) => {
  let ext = path.extname(sourceFileName || "") || ".jpg";
  const fmt = outputFormat != null ? resolveOptimizeFormat(outputFormat) : null;
  if (fmt && fmt !== "original") {
    ext = fmt === "jpeg" ? ".jpg" : `.${fmt}`;
  }
  const base = exports.applyImageTemplate(template, context);
  const sanitized = exports.sanitizeImageFileName(base);
  return `${sanitized}${ext}`;
};

exports.buildImageTemplateContext = (
  productContext,
  { imageId = null, sourceFileName = "image.jpg", sortOrder = null } = {}
) => {
  const file = String(sourceFileName || "image.jpg").trim() || "image.jpg";
  const base = path.basename(file);
  const ext = path.extname(base);
  const imageName = (ext ? base.slice(0, -ext.length) : base) || "image";

  return {
    ...(productContext || {}),
    image_name: imageName,
    image_file: base,
    sort_order: sortOrder != null && sortOrder !== "" ? String(sortOrder) : "",
    image_id: imageId != null && imageId !== "" ? String(imageId) : "",
  };
};

/**
 * Product + per-image fields for templates, e.g.
 * [name], [sku], [image_name], [image_id], [sort_order], …
 *
 * `options` is merged last so callers can override any field (e.g. from cache).
 */
exports.fetchProductTemplateContext = async (
  storeHash,
  productId,
  accessToken,
  options = {}
) => {
  const headers = bcJsonHeaders(accessToken);

  const [productRes, storeRes] = await Promise.all([
    get(
      `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}?include_fields=id,name,sku,mpn,page_title,brand_id,price,type,condition,categories`,
      headers
    ),
    get(
      `https://api.bigcommerce.com/stores/${storeHash}/v2/store`,
      headers
    ).catch(() => null),
  ]);

  const product = productRes?.data || {};
  const store = storeRes && typeof storeRes === "object" ? storeRes : {};

  let brand = "";
  let category = "";

  const [brandRes, categoryRes] = await Promise.all([
    product.brand_id
      ? get(
          `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/brands/${product.brand_id}`,
          headers
        ).catch(() => null)
      : Promise.resolve(null),
    Array.isArray(product.categories) && product.categories.length > 0
      ? get(
          `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/categories/${product.categories[0]}`,
          headers
        ).catch(() => null)
      : Promise.resolve(null),
  ]);

  brand = brandRes?.data?.name || "";
  category = categoryRes?.data?.name || "";

  const priceVal = product.price;
  const price =
    priceVal != null && priceVal !== ""
      ? String(priceVal)
      : "";

  return {
    name: product.name || "",
    sku: product.sku || "",
    price,
    type: product.type || "",
    condition: product.condition || "",
    mpn: product.mpn || "",
    page_title: product.page_title || "",
    brand,
    category,
    currency: store.currency != null ? String(store.currency) : "",
    store_name: store.name != null ? String(store.name) : "",
    ...options,
  };
};

exports.resolveGeneratedImageMeta = ({
  settings,
  productContext,
  imageId = null,
  sortOrder = null,
  sourceFileName,
  fallbackImageName,
  fallbackAltText,
  savedFromDb = null,
}) => {
  const dbFileName =
    savedFromDb?.newImageName || savedFromDb?.imageName || null;
  const dbOldAltText = savedFromDb?.altText || null;
  const dbNewAltText = savedFromDb?.newAltText || null;

  const oldImageName = fallbackImageName || dbFileName || null;
  const oldAltText = fallbackAltText || dbOldAltText || null;
  const fileForTemplate = sourceFileName || oldImageName || "image.jpg";

  const templateContext = exports.buildImageTemplateContext(productContext, {
    imageId,
    sourceFileName: fileForTemplate,
    sortOrder,
  });

  let newImageName;
  let newAltText;

  if (settings.is_filename_template_enabled && productContext) {
    const filenameTemplate = settings.filename_template || "";
    newImageName = exports.buildFilenameFromTemplate(
      filenameTemplate,
      templateContext,
      fileForTemplate,
      settings.output_format
    );
    const imageIdStr = String(templateContext.image_id || "").trim();
    const hasUniqueImageToken = /\[(image_id|image_name|image_file)\]/i.test(
      filenameTemplate
    );
    if (imageIdStr && !hasUniqueImageToken) {
      const ext = path.extname(newImageName) || ".jpg";
      const base = ext ? newImageName.slice(0, -ext.length) : newImageName;
      newImageName = `${base}-${imageIdStr}${ext}`;
    }
  } else {
    newImageName = dbFileName || oldImageName;
  }

  if (settings.is_alt_text_template_enabled && productContext) {
    newAltText = exports.applyImageTemplate(
      settings.alt_text_template || "",
      templateContext
    );
  } else {
    newAltText = dbNewAltText || oldAltText;
  }

  return { oldImageName, oldAltText, newImageName, newAltText };
};

/**
 * Build worker imageMeta from store templates + BC image + DB (bulk/checkbox jobs).
 */
exports.placementFieldsForJobItem = (source = {}) => {
  const placement = exports.resolveImagePlacementFields(source);
  const fields = {};

  if (placement.sortOrder != null) {
    fields.sort_order = placement.sortOrder;
  }
  if (placement.isThumbnail != null) {
    fields.is_thumbnail = placement.isThumbnail;
  }

  return fields;
};

exports.syncQueuedJobItemPlacements = async (jobUuid, entries = []) => {
  if (!jobUuid || !Array.isArray(entries) || entries.length === 0) {
    return { error: null };
  }

  const ops = entries
    .map((entry) => {
      const { sortOrder, isThumbnail } = entry.imageMeta || {};
      const $set = {};

      if (sortOrder != null) {
        $set.sort_order = sortOrder;
      }
      if (isThumbnail != null) {
        $set.is_thumbnail = isThumbnail;
      }

      if (Object.keys($set).length === 0) {
        return null;
      }

      return {
        updateOne: {
          filter: buildItemFilter(jobUuid, entry.productId, entry.imageId),
          update: { $set },
        },
      };
    })
    .filter(Boolean);

  if (ops.length === 0) {
    return { error: null };
  }

  try {
    await ImageJobItem.bulkWrite(ops, { ordered: false });
    return { error: null };
  } catch (err) {
    return { error: err.message };
  }
};

exports.buildJobImageMeta = async ({
  storeHash,
  productId,
  imageId,
  accessToken,
  settings,
  storeOptions = {},
  productContextCache = null,
  savedImageDataMap = null,
  placementOverrides = {},
}) => {
  const runFilename = Boolean(settings?.is_filename_template_enabled);
  const runAltText = Boolean(settings?.is_alt_text_template_enabled);
  const runOptimize = Boolean(settings?.optimize_image_enabled);
  const cache =
    productContextCache instanceof Map ? productContextCache : new Map();

  const placementFromOverrides =
    exports.resolveImagePlacementFields(placementOverrides);
  const needsBcPlacement =
    placementFromOverrides.sortOrder == null ||
    placementFromOverrides.isThumbnail == null;

  let bcImage = null;
  if (runFilename || runAltText || runOptimize || needsBcPlacement) {
    try {
      const res = await get(
        `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images/${imageId}`,
        bcJsonHeaders(accessToken)
      );
      bcImage = res?.data || null;
    } catch {
      bcImage = null;
    }
  }

  let productContext = null;
  if (runFilename || runAltText) {
    const cacheKey = String(productId);
    if (cache.has(cacheKey)) {
      productContext = cache.get(cacheKey);
    } else {
      productContext = await exports.fetchProductTemplateContext(
        storeHash,
        productId,
        accessToken,
        storeOptions
      );
      cache.set(cacheKey, productContext);
    }
  }

  const savedKey = `${Number(productId)}:${Number(imageId)}`;
  const savedFromDb =
    savedImageDataMap instanceof Map
      ? savedImageDataMap.get(savedKey) || null
      : await ImageOldData.findOne({
          store_hash: storeHash,
          product_id: Number(productId),
          image_id: Number(imageId),
        })
          .select({ imageName: 1, altText: 1, newImageName: 1, newAltText: 1 })
          .lean();

  const placement = exports.resolveImagePlacementFields({
    ...(bcImage || {}),
    ...placementOverrides,
  });

  const fallbackImageName = bcImage?.image_file || bcImage?.name || null;
  const fallbackAltText =
    bcImage?.description || bcImage?.alt_text || null;

  const { oldImageName, oldAltText, newImageName, newAltText } =
    exports.resolveGeneratedImageMeta({
      settings,
      productContext,
      imageId,
      sortOrder: placement.sortOrder,
      sourceFileName: bcImage?.image_file || "image.jpg",
      fallbackImageName,
      fallbackAltText,
      savedFromDb,
    });

  return {
    oldImageName,
    oldAltText,
    newImageName,
    newAltText,
    runFilename,
    runAltText,
    runOptimize,
    ...placement,
  };
};

const SKIP_QUEUE_STATUSES = new Set(["optimized", "optimizing", "pending"]);
const MANUAL_SKIP_STATUSES = new Set(["optimized", "optimizing"]);

/**
 * Image IDs that should not be queued again (already done or in progress).
 * Accepts image id numbers or job items `{ product_id, image_id }`.
 * Pass `statuses` to narrow the blocking set (e.g. only "optimizing"/"pending"
 * when metadata templates should still run on already-optimized images).
 */
exports.getAlreadyOptimizedImageIdSet = async (
  storeHash,
  imageIdsOrItems = [],
  statuses = null
) => {
  const imageIds = new Set();
  const productIds = new Set();

  for (const entry of Array.isArray(imageIdsOrItems) ? imageIdsOrItems : []) {
    if (entry != null && typeof entry === "object") {
      const iid = Number(entry.image_id);
      const pid = Number(entry.product_id);
      if (Number.isFinite(iid)) imageIds.add(iid);
      if (Number.isFinite(pid)) productIds.add(pid);
    } else {
      const iid = Number(entry);
      if (Number.isFinite(iid)) imageIds.add(iid);
    }
  }

  const skipIds = new Set();
  if (!storeHash) {
    return skipIds;
  }

  const statusFilter = {
    $in: Array.isArray(statuses) && statuses.length > 0
      ? statuses
      : Array.from(SKIP_QUEUE_STATUSES),
  };
  const queries = [];

  if (imageIds.size > 0) {
    queries.push(
      ImageStatus.find({
        store_hash: storeHash,
        image_id: { $in: [...imageIds] },
        status: statusFilter,
      })
        .select({ image_id: 1 })
        .lean()
    );
  }

  if (productIds.size > 0) {
    queries.push(
      ImageStatus.find({
        store_hash: storeHash,
        product_id: { $in: [...productIds] },
        status: statusFilter,
      })
        .select({ image_id: 1 })
        .lean()
    );
  }

  const resultGroups = await Promise.all(queries);
  for (const rows of resultGroups) {
    for (const row of rows) {
      if (row?.image_id != null) {
        skipIds.add(Number(row.image_id));
      }
    }
  }

  return skipIds;
};

exports.shouldSkipImageOptimization = async (
  storeHash,
  productId,
  imageId,
  options = {}
) => {
  const {
    accessToken = null,
    forceReoptimize = false,
  } = options;
  const iid = Number(imageId);
  if (!storeHash || !Number.isFinite(iid)) {
    return { skip: false, reason: null };
  }

  if (forceReoptimize) {
    return { skip: false, reason: null };
  }

  const pid = Number(productId);
  const statusQuery = {
    store_hash: storeHash,
    image_id: iid,
    status: { $in: Array.from(MANUAL_SKIP_STATUSES) },
  };

  if (Number.isFinite(pid)) {
    statusQuery.product_id = pid;
  }

  const optimizationQuery = {
    store_hash: storeHash,
    image_id: iid,
  };
  if (Number.isFinite(pid)) {
    optimizationQuery.product_id = pid;
  }

  const [statusRow, optimizationRow] = await Promise.all([
    ImageStatus.findOne(statusQuery).select({ status: 1 }).lean(),
    ImageOptimization.findOne(optimizationQuery).select({ _id: 1 }).lean(),
  ]);

  if (statusRow) {
    const optimizing = statusRow.status === "optimizing";
    return {
      skip: true,
      code: optimizing ? "optimizing" : "optimized",
      reason: optimizing
        ? "Image is currently being optimized. Please wait for the current optimization job to finish."
        : "Image is already optimized",
    };
  }

  if (optimizationRow) {
    return {
      skip: true,
      reason: "Image already has an optimization record",
    };
  }

  if (accessToken && Number.isFinite(pid)) {
    try {
      const images = await fetchProductImages({
        storeHash,
        productId: pid,
        accessToken,
      });
      const existsOnBc = images.some((img) => Number(img?.id) === iid);
      if (!existsOnBc) {
        return {
          skip: true,
          code: "not_on_bc",
          reason:
            "Image not found on BigCommerce (already replaced or deleted)",
        };
      }
    } catch (err) {
      console.warn(
        "[shouldSkipImageOptimization] BC image check failed:",
        err?.message || err
      );
    }
  }

  return { skip: false, reason: null };
};

async function finalizeOptimizationJobIfComplete(job, jobTypeHint = "bulk") {
  if (!job) {
    return;
  }

  const queued = getQueuedImageCount(job);
  if (
    job.processed_images < queued ||
    queued <= 0 ||
    job.status !== "processing"
  ) {
    return;
  }

  const finalStatus =
    job.success_images === 0 && job.failed_images > 0 ? "failed" : "completed";
  const validJobType = normalizeJobType(jobTypeHint) || job.job_type || "bulk";

  await Promise.all([
    ImageJob.updateOne(
      { job_uuid: job.job_uuid },
      { $set: { status: finalStatus, completed_at: new Date() } }
    ),
    ImageOptimizationLog.create({
      user_id: job.user_id || null,
      job_id: job._id,
      job_uuid: job.job_uuid,
      store_hash: job.store_hash,
      job_type: job.job_type || validJobType,
      log_type: job.failed_images > 0 ? "warning" : "info",
      step: "complete",
      message: `Job ${finalStatus}: ${job.success_images} optimized, ${job.failed_images} failed, ${job.skipped_images} skipped`,
      meta: {
        total_images: job.total_images,
        queued_images: queued,
        skipped_images: job.skipped_images,
        processed_images: job.processed_images,
        success_images: job.success_images,
        failed_images: job.failed_images,
      },
    }),
  ]);
}

/**
 * Mark pending bulk job rows as skipped when the same image was optimized elsewhere.
 */
exports.skipPendingJobItemsForImage = async ({
  storeHash,
  productId,
  imageId,
  skipReason = "Image optimized elsewhere",
  excludeJobUuid = null,
}) => {
  const pid = Number(productId);
  const iid = Number(imageId);
  if (!storeHash || !Number.isFinite(pid) || !Number.isFinite(iid)) {
    return { modifiedCount: 0 };
  }

  const filter = {
    store_hash: storeHash,
    product_id: pid,
    image_id: iid,
    status: { $in: ["queued", "optimizing"] },
  };
  if (excludeJobUuid) {
    filter.job_uuid = { $ne: excludeJobUuid };
  }

  const pendingItems = await ImageJobItem.find(filter)
    .select({ job_uuid: 1 })
    .lean();

  if (!pendingItems.length) {
    return { modifiedCount: 0 };
  }

  const skipReasonText = skipReason || "Image optimized elsewhere";
  const now = new Date();

  await ImageJobItem.updateMany(filter, {
    $set: {
      status: "skipped",
      skip_reason: skipReasonText,
      completed_at: now,
      error_message: null,
    },
  });

  const countByJob = new Map();
  for (const item of pendingItems) {
    countByJob.set(item.job_uuid, (countByJob.get(item.job_uuid) || 0) + 1);
  }

  const updatedJobs = await Promise.all(
    [...countByJob.entries()].map(([jobUuid, count]) =>
      ImageJob.findOneAndUpdate(
        { job_uuid: jobUuid },
        {
          $inc: {
            processed_images: count,
            skipped_images: count,
          },
        },
        { returnDocument: "after" }
      )
    )
  );

  await Promise.all(
    updatedJobs.map((job) => finalizeOptimizationJobIfComplete(job))
  );

  return { modifiedCount: pendingItems.length };
};

/**
 * Fetch every product image from BigCommerce catalog (page 1 … total_pages).
 * Uses page_size per request (default 50); loops until the full catalog is loaded.
 */
exports.fetchAllCatalogImagesInChunks = async ({
  storeHash,
  accessToken,
  storeUrl,
  pageSize = config.catalog.pageSize,
  keyword = "",
  skipOptimized = true,
  productSortDirection = "asc",
}) => {
  if (!storeHash) {
    return { error: "storeHash is required", items: [], meta: null };
  }

  if (!accessToken || !String(accessToken).trim()) {
    return {
      error: "BigCommerce access token is required",
      items: [],
      meta: null,
    };
  }

  if (!storeUrl) {
    return {
      error: "storeUrl is required to build product image URLs",
      items: [],
      meta: null,
    };
  }

  const limit = Math.min(
    250,
    Math.max(1, Number(pageSize) || config.catalog.pageSize)
  );
  const headers = bcJsonHeaders(accessToken);
  const items = [];
  let page = 1;
  let totalPages = 1;
  let totalProducts = 0;
  let skippedAlreadyOptimized = 0;
  const sortDirection =
    productSortDirection === "desc" ? "desc" : "asc";

  try {
    while (page <= totalPages) {
      const params = new URLSearchParams({
        include: "images",
        include_fields: "id,images",
        page: String(page),
        limit: String(limit),
        sort: "name",
        direction: sortDirection,
      });

      const search = String(keyword || "").trim();
      if (search) {
        params.set("keyword", search);
      }

      const response = await fetchCatalogProducts(
        get,
        storeHash,
        params,
        headers
      );

      const products = Array.isArray(response?.data) ? response.data : [];
      const pagination = response?.meta?.pagination || {};
      totalPages = Number(pagination.total_pages) || 1;
      totalProducts += products.length;

      const pageItems = [];

      for (const product of products) {
        const productId = product?.id;
        if (productId == null) continue;

        const images = product.images;
        if (!Array.isArray(images) || images.length === 0) continue;

        for (const image of images) {
          const imageId = image?.id;
          if (imageId == null) continue;

          const imageUrl = resolveProductImageUrl(
            storeUrl,
            image.image_file,
            image.url_zoom || image.url_standard || null
          );

          if (!imageUrl) continue;

          pageItems.push({
            product_id: productId,
            image_id: imageId,
            image_url: imageUrl,
            shop: storeHash,
            sort_order: image.sort_order ?? null,
            is_thumbnail: image.is_thumbnail ?? null,
          });
        }
      }

      if (skipOptimized && pageItems.length > 0) {
        const imageIds = pageItems.map((row) => Number(row.image_id));
        const statusRows = await ImageStatus.find({
          store_hash: storeHash,
          image_id: { $in: imageIds },
          status: { $in: Array.from(SKIP_QUEUE_STATUSES) },
        })
          .select({ image_id: 1 })
          .lean();

        const skipIds = new Set(statusRows.map((row) => Number(row.image_id)));
        for (const row of pageItems) {
          if (skipIds.has(Number(row.image_id))) {
            skippedAlreadyOptimized += 1;
            continue;
          }
          items.push(row);
        }
      } else {
        items.push(...pageItems);
      }

      page += 1;
    }

    return {
      error: null,
      items,
      meta: {
        pages_fetched: totalPages,
        products_fetched: totalProducts,
        images_found: items.length + skippedAlreadyOptimized,
        images_queued: items.length,
        skipped_already_optimized: skippedAlreadyOptimized,
        page_size: limit,
      },
    };
  } catch (err) {
    return {
      error: err.message || "Failed to fetch products from BigCommerce",
      items: [],
      meta: null,
    };
  }
};

function getOptimizationBatchSize() {
  return Math.max(1, config.optimization?.batchSize ?? 500);
}

exports.getOptimizationBatchSize = getOptimizationBatchSize;

exports.getOptimizationBatchCount = (queuedCount, batchSize = null) => {
  const size = batchSize ?? getOptimizationBatchSize();
  const count = Number(queuedCount) || 0;
  if (count <= 0) return 0;
  return Math.ceil(count / size);
};

/**
 * Stream BigCommerce catalog pages into MongoDB ImageJobItem rows (batched),
 * without holding the full catalog in memory or pre-building imageMeta.
 */
exports.streamCatalogFetchToJobItems = async ({
  jobUuid,
  userId = null,
  jobId = null,
  storeHash,
  accessToken,
  storeUrl,
  pageSize = config.catalog.pageSize,
  skipOptimized = true,
  maxQueueImages = null,
  /** When true (filename/alt templates on), already-optimized images are still
   *  queued so the worker can apply metadata; optimizing/pending stay skipped. */
  includeOptimized = false,
  /** Product name sort for BC catalog pages (matches dashboard sort preference). */
  productSortDirection = "asc",
  batchSize = getOptimizationBatchSize(),
}) => {
  if (!jobUuid || !storeHash) {
    return { error: "jobUuid and storeHash are required", meta: null, batchCount: 0 };
  }

  if (!accessToken || !String(accessToken).trim()) {
    return {
      error: "BigCommerce access token is required",
      meta: null,
      batchCount: 0,
    };
  }

  if (!storeUrl) {
    return {
      error: "storeUrl is required to build product image URLs",
      meta: null,
      batchCount: 0,
    };
  }

  const limit = Math.min(
    250,
    Math.max(1, Number(pageSize) || config.catalog.pageSize)
  );
  const headers = bcJsonHeaders(accessToken);
  let page = 1;
  let totalPages = 1;
  let totalProducts = 0;
  let skippedAlreadyOptimized = 0;
  let queuedImages = 0;
  let quotaDeferredImages = 0;
  let batchIndex = 0;
  let pendingBatch = [];
  const discoveredForStats = [];
  const queueCap =
    maxQueueImages == null || !Number.isFinite(Number(maxQueueImages))
      ? null
      : Math.max(0, Number(maxQueueImages) || 0);
  const sortDirection =
    productSortDirection === "desc" ? "desc" : "asc";

  const flushBatch = async () => {
    if (pendingBatch.length === 0) return;
    await ImageJobItem.insertMany(
      pendingBatch.map((item) => ({
        ...item,
        user_id: userId,
        job_id: jobId,
      })),
      { ordered: false }
    ).catch(() => {});
    pendingBatch = [];
    batchIndex += 1;
  };

  try {
    while (page <= totalPages) {
      const params = new URLSearchParams({
        include: "images",
        include_fields: "id,images",
        page: String(page),
        limit: String(limit),
        sort: "name",
        direction: sortDirection,
      });

      const response = await fetchCatalogProducts(
        get,
        storeHash,
        params,
        headers
      );

      const products = Array.isArray(response?.data) ? response.data : [];
      const pagination = response?.meta?.pagination || {};
      totalPages = Number(pagination.total_pages) || 1;
      totalProducts += products.length;

      const pageItems = [];

      for (const product of products) {
        const productId = product?.id;
        if (productId == null) continue;

        const images = product.images;
        if (!Array.isArray(images) || images.length === 0) continue;

        for (const image of images) {
          const imageId = image?.id;
          if (imageId == null) continue;

          const imageUrl = resolveProductImageUrl(
            storeUrl,
            image.image_file,
            image.url_zoom || image.url_standard || null
          );

          if (!imageUrl) continue;

          pageItems.push({
            product_id: productId,
            image_id: imageId,
            image_url: imageUrl,
            sort_order: image.sort_order ?? null,
            is_thumbnail: image.is_thumbnail ?? null,
          });
        }
      }

      let toQueue = pageItems;

      if (skipOptimized && pageItems.length > 0) {
        const imageIds = pageItems.map((row) => Number(row.image_id));
        const statusRows = await ImageStatus.find({
          store_hash: storeHash,
          image_id: { $in: imageIds },
          status: {
            $in: includeOptimized
              ? ["optimizing", "pending"]
              : Array.from(SKIP_QUEUE_STATUSES),
          },
        })
          .select({ image_id: 1 })
          .lean();

        const skipIds = new Set(statusRows.map((row) => Number(row.image_id)));
        toQueue = [];
        for (const row of pageItems) {
          if (skipIds.has(Number(row.image_id))) {
            skippedAlreadyOptimized += 1;
            continue;
          }
          toQueue.push(row);
        }
      }

      for (const row of toQueue) {
        if (queueCap != null && queuedImages >= queueCap) {
          quotaDeferredImages += 1;
          continue;
        }

        const currentBatchIndex = batchIndex;
        pendingBatch.push({
          job_uuid: jobUuid,
          store_hash: storeHash,
          job_type: "bulk",
          product_id: Number(row.product_id),
          image_id: Number(row.image_id),
          image_url: row.image_url,
          status: "queued",
          batch_index: currentBatchIndex,
          ...exports.placementFieldsForJobItem(row),
        });
        queuedImages += 1;
        discoveredForStats.push({
          product_id: Number(row.product_id),
          image_id: Number(row.image_id),
        });

        if (pendingBatch.length >= batchSize) {
          await flushBatch();
        }
      }

      const imagesFoundSoFar =
        queuedImages + skippedAlreadyOptimized + quotaDeferredImages;
      await ImageJob.updateOne(
        { job_uuid: jobUuid },
        {
          $set: {
            total_images: imagesFoundSoFar,
            queued_images: queuedImages,
            skipped_images: skippedAlreadyOptimized,
          },
        }
      );

      page += 1;
    }

    await flushBatch();

    await registerPendingProductImages(storeHash, discoveredForStats, userId);

    if (queueCap != null) {
      const pendingDisplayCount = queuedImages + quotaDeferredImages;
      await StoreImageStat.findOneAndUpdate(
        { store_hash: storeHash },
        {
          $set: {
            pending_images: pendingDisplayCount,
            ...(userId ? { user_id: userId } : {}),
          },
          $setOnInsert: { store_hash: storeHash },
        },
        { upsert: true }
      ).catch((err) => {
        console.error("[streamCatalogFetchToJobItems] pending stat:", err.message);
      });
    }

    return {
      error: null,
      meta: {
        pages_fetched: totalPages,
        products_fetched: totalProducts,
        images_found: queuedImages + skippedAlreadyOptimized + quotaDeferredImages,
        images_queued: queuedImages,
        skipped_already_optimized: skippedAlreadyOptimized,
        quota_deferred_images: quotaDeferredImages,
        quota_capped: quotaDeferredImages > 0,
        page_size: limit,
      },
      batchCount: batchIndex,
      queuedImages,
    };
  } catch (err) {
    return {
      error: err.message || "Failed to fetch products from BigCommerce",
      meta: null,
      batchCount: 0,
      queuedImages: 0,
    };
  }
};

/**
 * Push thin optimize-batch jobs to Redis (one per MongoDB batch_index).
 * @deprecated Prefer dispatchOptimizationBatch for staggered plan-aware dispatch.
 */
exports.queueOptimizationBatchJobs = async ({
  jobUuid,
  userId = null,
  jobId = null,
  batchCount,
  storeHash,
  storeUrl,
  accessToken,
  settings,
  job_type = "bulk",
  currency = null,
  store_name = null,
  estimatedImages = 0,
  suppressHeavyWake = false,
  planSlug = null,
  selectedPlan = null,
}) => {
  if (!batchCount || batchCount <= 0) {
    return { error: null, results: [], tier: null, queued: 0, duplicates: 0 };
  }

  await ImageJob.updateOne(
    { job_uuid: jobUuid },
    { $set: { total_batches: batchCount, last_dispatched_batch_index: -1 } }
  );

  const resolvedPlan =
    selectedPlan ||
    planSlug ||
    (await User.findOne({ store_hash: storeHash }).select({ selectedPlan: 1 }).lean())
      ?.selectedPlan ||
    "free";

  return exports.dispatchOptimizationBatch({
    jobUuid,
    userId,
    jobId,
    batchIndex: 0,
    batchCount,
    storeHash,
    storeUrl,
    accessToken,
    settings,
    job_type,
    currency,
    store_name,
    estimatedImages,
    suppressHeavyWake,
    planSlug: resolvedPlan,
  });
};

/**
 * Dispatch a single batch to Redis after a monthly quota check.
 */
exports.dispatchOptimizationBatch = async ({
  jobUuid,
  userId = null,
  jobId = null,
  batchIndex = 0,
  batchCount = null,
  storeHash,
  storeUrl,
  accessToken,
  settings,
  job_type = "bulk",
  currency = null,
  store_name = null,
  estimatedImages = 0,
  suppressHeavyWake = false,
  planSlug = "free",
}) => {
  if (!jobUuid || !storeHash) {
    return { error: "jobUuid and storeHash are required", dispatched: false };
  }

  const job = await ImageJob.findOne({ job_uuid: jobUuid }).lean();
  if (!job) {
    return { error: "Optimization job not found", dispatched: false };
  }

  if (job.status === "paused_plan_limit") {
    return { error: null, dispatched: false, paused: true };
  }

  const totalBatches = batchCount ?? job.total_batches ?? 0;
  if (totalBatches > 0 && batchIndex >= totalBatches) {
    return { error: null, dispatched: false, done: true };
  }

  const quota = await canOptimizeImages(storeHash, planSlug, 1);
  if (!quota.allowed) {
    await pauseJobForPlanLimit({
      jobUuid,
      storeHash,
      evaluation: {
        allowed: false,
        code: quota.code,
        message: quota.message,
        plan_slug: quota.plan_slug,
        plan_name: quota.plan_name,
        plan_limit: quota.monthly_limit,
        monthly_used: quota.monthly_used,
        remaining: quota.remaining,
        images_to_queue: 0,
        upgrade_required: true,
      },
      totalImages: job.total_images,
      queuedImages: job.queued_images,
      skippedImages: job.skipped_images,
    });

    return {
      error: null,
      dispatched: false,
      paused: true,
      plan_evaluation: quota,
      results: [],
      tier: null,
      queued: 0,
      duplicates: 0,
    };
  }

  const routing = {
    estimatedImages,
    storeHash,
    suppressHeavyWake,
  };

  const payload = {
    jobUuid,
    userId: userId || job.user_id || null,
    jobId: jobId || job._id,
    job_type,
    storeHash,
    storeUrl,
    accessToken,
    settings,
    currency,
    store_name,
    batchIndex,
    selectedPlan: planSlug,
    skipQuotaCheck: true,
  };

  const result = await addOptimizationBatchJob(payload, {}, routing);

  await ImageJob.updateOne(
    { job_uuid: jobUuid },
    {
      $set: {
        status: "processing",
        last_dispatched_batch_index: batchIndex,
        ...(totalBatches > 0 ? { total_batches: totalBatches } : {}),
        completed_at: null,
      },
    }
  );

  const tier = result?.tier ?? null;
  if (tier === TIER_HEAVY && !suppressHeavyWake) {
    await signalHeavyWorkerNeeded();
  }

  return {
    error: null,
    dispatched: true,
    paused: false,
    results: [result],
    tier,
    queued: result?.bullJob && !result?.duplicate ? 1 : 0,
    duplicates: result?.duplicate ? 1 : 0,
  };
};

/**
 * After a batch worker finishes, queue the next batch or pause on plan limit.
 */
exports.handleOptimizationBatchComplete = async (batchJobData = {}) => {
  const {
    jobUuid,
    storeHash,
    batchIndex,
    storeUrl,
    accessToken,
    settings,
    job_type: jobTypeFromData,
    currency = null,
    store_name = null,
    selectedPlan = null,
  } = batchJobData;

  if (!jobUuid || !storeHash || batchIndex == null) {
    return { error: "Invalid batch completion payload", next: null };
  }

  const job = await ImageJob.findOne({ job_uuid: jobUuid }).lean();
  if (!job || job.status === "paused_plan_limit") {
    return { error: null, next: null, paused: Boolean(job?.status === "paused_plan_limit") };
  }

  const totalBatches = Number(job.total_batches) || 0;
  const nextBatchIndex = Number(batchIndex) + 1;

  if (totalBatches <= 0 || nextBatchIndex >= totalBatches) {
    return { error: null, next: null, done: true };
  }

  const user = await User.findOne({ store_hash: storeHash })
    .select({ selectedPlan: 1 })
    .lean();
  const planSlug = selectedPlan || user?.selectedPlan || "free";

  const quota = await getMonthlyQuotaStatus(storeHash, planSlug);
  if (!quota.unlimited && quota.remaining <= 0) {
    await pauseJobForPlanLimit({
      jobUuid,
      storeHash,
      evaluation: {
        allowed: false,
        code: "MONTHLY_QUOTA_EXCEEDED",
        message: `Your ${quota.plan_name || quota.plan?.name || "plan"} monthly image optimization limit has been reached (${quota.monthly_used.toLocaleString("en-US")} / ${quota.monthly_limit.toLocaleString("en-US")}). Please wait until next month or upgrade your plan, then try again.`,
        plan_slug: quota.plan_slug,
        plan_name: quota.plan_name,
        plan_limit: quota.monthly_limit,
        monthly_used: quota.monthly_used,
        remaining: quota.remaining,
        images_to_queue: 0,
        upgrade_required: true,
      },
      totalImages: job.total_images,
      queuedImages: job.queued_images,
      skippedImages: job.skipped_images,
    });

    return { error: null, next: null, paused: true };
  }

  const dispatch = await exports.dispatchOptimizationBatch({
    jobUuid,
    batchIndex: nextBatchIndex,
    storeHash,
    storeUrl,
    accessToken,
    settings,
    job_type: job.job_type || jobTypeFromData || "bulk",
    currency,
    store_name,
    estimatedImages: job.queued_images,
    suppressHeavyWake: false,
    planSlug,
  });

  return {
    error: dispatch.error,
    next: dispatch.dispatched ? nextBatchIndex : null,
    paused: Boolean(dispatch.paused),
    done: Boolean(dispatch.done),
  };
};

/** Parse sort_order / is_thumbnail from request body or BC image payload. */
exports.resolveImagePlacementFields = (source = {}) => {
  const sortOrder = source.sort_order ?? source.sortOrder;
  // Accept is_thumnail (common client typo) alongside is_thumbnail.
  const isThumbnail =
    source.is_thumbnail ?? source.is_thumnail ?? source.isThumbnail;

  const result = {};

  if (sortOrder != null && sortOrder !== "") {
    const n = Number(sortOrder);
    if (!Number.isNaN(n)) {
      result.sortOrder = n;
    }
  }

  if (isThumbnail != null && isThumbnail !== "") {
    result.isThumbnail =
      typeof isThumbnail === "boolean"
        ? isThumbnail
        : ["true", "1", "yes"].includes(
            String(isThumbnail).trim().toLowerCase()
          );
  }

  return result;
};

exports.updateBigCommerceProductImageMetadata = updateProductImageMetadata;

exports.buildBigCommerceError = (error) => {
  const status = error?.response?.status || error?.statusCode || 500;
  const bcPayload = error?.response?.data;
  let message =
    bcPayload?.title ||
    bcPayload?.message ||
    error?.message ||
    "Failed to fetch products from BigCommerce";

  if (status === 401) {
    message =
      "BigCommerce rejected the store access token. Reload the app to refresh your API token, " +
      "or reinstall the app if the token was revoked.";
  }

  return {
    status,
    body: {
      success: false,
      message,
      error: {
        source: "bigcommerce",
        status,
        title: bcPayload?.title || null,
        type: bcPayload?.type || null,
        detail: bcPayload?.detail || bcPayload?.errors || null,
      },
    },
  };
};

exports.normalizePagination = (query = {}, options = {}) => {
  const { defaultPage, defaultLimit, maxLimit: configMaxLimit } = config.pagination;
  const maxLimit =
    Number.isFinite(Number(options.maxLimit)) && Number(options.maxLimit) > 0
      ? Number(options.maxLimit)
      : configMaxLimit;
  const page = Math.max(1, parseInt(query.page, 10) || defaultPage);
  const limit = Math.max(
    1,
    Math.min(maxLimit, parseInt(query.limit, 10) || defaultLimit)
  );
  return { page, limit };
};

exports.hasAnyOptimizationFeatureEnabled = (settings) =>
  Boolean(
    settings?.optimize_image_enabled ||
    settings?.is_filename_template_enabled ||
    settings?.is_alt_text_template_enabled
  );

const SKIP_PENDING_STATUSES = new Set(["optimized", "optimizing", "pending"]);

/**
 * Bulk/single queue: mark images pending for store dashboard.
 * Skips already optimized, optimizing, or already-pending images.
 */
async function registerPendingProductImages(storeHash, images = [], userId = null) {
  if (!storeHash || !images.length) return { registered: 0, error: null };

  const normalized = [];
  const seen = new Set();

  for (const row of images) {
    const productId = Number(row.product_id ?? row.productId);
    const imageId = Number(row.image_id ?? row.imageId);
    if (!Number.isFinite(productId) || !Number.isFinite(imageId)) continue;
    const key = `${productId}:${imageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ productId, imageId });
  }

  if (!normalized.length) return { registered: 0, error: null };

  try {
    const imageIds = normalized.map((row) => row.imageId);
    const existingRows = await ImageStatus.find({
      store_hash: storeHash,
      image_id: { $in: imageIds },
    })
      .select({ product_id: 1, image_id: 1, status: 1 })
      .lean();

    const skipKeys = new Set();
    for (const row of existingRows) {
      if (SKIP_PENDING_STATUSES.has(row.status)) {
        skipKeys.add(`${row.product_id}:${row.image_id}`);
      }
    }

    const toRegister = normalized.filter(
      (row) => !skipKeys.has(`${row.productId}:${row.imageId}`)
    );
    if (!toRegister.length) return { registered: 0, error: null };

    const bulkOps = toRegister.map((row) => ({
      updateOne: {
        filter: {
          store_hash: storeHash,
          product_id: row.productId,
          image_id: row.imageId,
        },
        update: {
          $set: {
            ...(userId ? { user_id: userId } : {}),
            status: "pending",
            image_update_status: "pending",
          },
          $setOnInsert: {
            store_hash: storeHash,
            product_id: row.productId,
            image_id: row.imageId,
          },
        },
        upsert: true,
      },
    }));

    const bulkResult = await ImageStatus.bulkWrite(bulkOps, { ordered: false });
    const registered =
      (Number(bulkResult.upsertedCount) || 0) +
      (Number(bulkResult.modifiedCount) || 0);

    if (registered > 0) {
      await StoreImageStat.findOneAndUpdate(
        { store_hash: storeHash },
        {
          $inc: { pending_images: registered },
          ...(userId ? { $set: { user_id: userId } } : {}),
          $setOnInsert: { store_hash: storeHash },
        },
        { upsert: true }
      );
    }

    return { registered, error: null };
  } catch (err) {
    console.error("[registerPendingProductImages]", err.message);
    return { registered: 0, error: err.message };
  }
}

exports.registerPendingProductImages = registerPendingProductImages;

const {
  getRunningBulkOptimizationMap,
  getRunningBulkRestoreMap,
} = require("../../utils/bulkEntityActivity");

exports.isStoreJobActive = async (storeHash) => {
  if (!storeHash) {
    return { error: "storeHash is required", active_job: false };
  }

  try {
    const [optimizeMap, restoreMap] = await Promise.all([
      getRunningBulkOptimizationMap(storeHash),
      getRunningBulkRestoreMap(storeHash),
    ]);
    const active_job =
      Object.values(optimizeMap).some(Boolean) ||
      Object.values(restoreMap).some(Boolean);
    return { error: null, active_job };
  } catch (err) {
    console.error("[isStoreJobActive]", err.message);
    return { error: err.message, active_job: false };
  }
};

exports.getStoreActiveBulkJobs = async (storeHash) => {
  if (!storeHash) {
    return { error: "storeHash is required", data: null };
  }

  try {
    const [active_bulk_jobs, active_bulk_restores] = await Promise.all([
      getRunningBulkOptimizationMap(storeHash),
      getRunningBulkRestoreMap(storeHash),
    ]);
    return {
      error: null,
      data: {
        active_bulk_jobs,
        active_bulk_restores,
        active_job:
          Object.values(active_bulk_jobs).some(Boolean) ||
          Object.values(active_bulk_restores).some(Boolean),
      },
    };
  } catch (err) {
    console.error("[getStoreActiveBulkJobs]", err.message);
    return { error: err.message, data: null };
  }
};

exports.getStoreDashboardStats = async (storeHash) => {
  if (!storeHash) {
    return { error: "storeHash is required", data: null };
  }

  try {
    const stat = await StoreImageStat.findOne({ store_hash: storeHash }).lean();
    const clamp = (n) => Math.max(0, Number(n) || 0);

    return {
      error: null,
      data: {
        optimized_images: clamp(stat?.optimized_images),
        pending_images: clamp(stat?.pending_images),
        failed_images: clamp(stat?.failed_images),
        total_saved_bytes: clamp(stat?.total_saved_bytes),
        average_saving_percent: Number(stat?.average_saving_percent) || 0,
        last_optimized_at: stat?.last_optimized_at || null,
      },
    };
  } catch (err) {
    console.error("[getStoreDashboardStats]", err.message);
    return { error: err.message, data: null };
  }
};

exports.incrementStoreOptimizationStats = async ({
  storeHash,
  originalSize = 0,
  optimizedSize = 0,
  savedBytes = null,
  failed = false,
}) => {
  if (!storeHash) {
    return { error: "storeHash is required" };
  }

  try {
    if (failed) {
      await StoreImageStat.findOneAndUpdate(
        { store_hash: storeHash },
        {
          $inc: { failed_images: 1 },
          $setOnInsert: { store_hash: storeHash },
        },
        { upsert: true }
      );
      return { error: null };
    }

    const origSize = Number(originalSize) || 0;
    const optSize = Number(optimizedSize) || 0;
    const saved =
      savedBytes != null
        ? Number(savedBytes) || 0
        : Math.max(0, origSize - optSize);

    const statDoc = await StoreImageStat.findOneAndUpdate(
      { store_hash: storeHash },
      {
        $inc: {
          optimized_images: 1,
          total_original_size: origSize,
          total_optimized_size: optSize,
          total_saved_bytes: saved,
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

    return { error: null };
  } catch (err) {
    console.error("[incrementStoreOptimizationStats]", err.message);
    return { error: err.message };
  }
};

exports.incrementMetadataUpdateStats = async ({
  storeHash,
  filenameUpdated = false,
  altTextUpdated = false,
}) => {
  if (!storeHash || (!filenameUpdated && !altTextUpdated)) {
    return { error: null };
  }

  const $inc = {};
  if (filenameUpdated) {
    $inc.filename_updated_images = 1;
  }
  if (altTextUpdated) {
    $inc.alt_text_updated_images = 1;
  }

  try {
    await StoreImageStat.findOneAndUpdate(
      { store_hash: storeHash },
      { $inc, $setOnInsert: { store_hash: storeHash } },
      { upsert: true }
    );
    return { error: null };
  } catch (err) {
    console.error("[incrementMetadataUpdateStats]", err.message);
    return { error: err.message };
  }
};

function getQueuedImageCount(job) {
  if (job.queued_images != null && job.queued_images > 0) {
    return job.queued_images;
  }
  return Math.max(0, (job.total_images || 0) - (job.skipped_images || 0));
}

function buildItemFilter(jobUuid, productId, imageId) {
  return {
    job_uuid: jobUuid,
    product_id: Number(productId),
    image_id: Number(imageId),
  };
}

async function resolveStoreHashForJobRecord(
  jobUuid,
  productId,
  imageId,
  storeHashHint
) {
  if (storeHashHint) {
    return storeHashHint;
  }

  const job = await ImageJob.findOne({ job_uuid: jobUuid })
    .select({ store_hash: 1 })
    .lean();
  if (job?.store_hash) {
    return job.store_hash;
  }

  if (productId != null && imageId != null) {
    const item = await ImageJobItem.findOne(
      buildItemFilter(jobUuid, productId, imageId)
    )
      .select({ store_hash: 1 })
      .lean();
    if (item?.store_hash) {
      return item.store_hash;
    }
  }

  return null;
}

exports.appendImageLog = appendImageLog;

exports.createBulkOptimizationJob = async ({
  userId = null,
  storeHash,
  jobType,
  totalImages,
  queuedImages = totalImages,
  skippedImages = 0,
  jobUuid = crypto.randomUUID(),
  jobItems = [],
  totalBatches = 0,
}) => {
  const validJobType = normalizeJobType(jobType);
  if (!validJobType) {
    return {
      error: `Invalid job_type "${jobType}". Allowed: ${JOB_TYPES.join(", ")}`,
      jobUuid: null,
      doc: null,
    };
  }

  try {
    const doc = await ImageJob.create({
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
      total_batches: Math.max(0, Number(totalBatches) || 0),
      last_dispatched_batch_index: -1,
      status: queuedImages > 0 ? "processing" : "completed",
      started_at: new Date(),
      completed_at: queuedImages > 0 ? null : new Date(),
    });

    const writes = [];

    if (jobItems.length > 0) {
      writes.push(
        ImageJobItem.insertMany(
          jobItems.map((item) => ({
            ...item,
            user_id: userId,
            job_id: doc._id,
          })),
          { ordered: false }
        )
      );
    }

    writes.push(
      ImageOptimizationLog.create({
        user_id: userId,
        job_id: doc._id,
        job_uuid: jobUuid,
        store_hash: storeHash,
        job_type: validJobType,
        log_type: "info",
        step: "queue",
        message: `Optimization job queued (${validJobType})`,
        meta: {
          total_images: totalImages,
          queued_images: queuedImages,
          skipped_images: skippedImages,
        },
      })
    );

    await Promise.all(writes);

    const queuedItems = jobItems.filter((row) => row.status === "queued");
    if (queuedItems.length > 0) {
      await registerPendingProductImages(storeHash, queuedItems, userId);
    }

    return { error: null, jobUuid, doc };
  } catch (err) {
    return { error: err.message, jobUuid: null, doc: null };
  }
};

/**
 * Called by catalogFetchWorker after the BC catalog has been fully fetched and
 * all images have been pushed to imageOptimizationQueue.
 * Updates the job record with real totals and transitions status to "processing".
 */
exports.updateJobAfterCatalogFetch = async ({
  jobUuid,
  userId = null,
  jobId = null,
  storeHash,
  totalImages,
  queuedImages,
  skippedImages,
  jobItems = [],
  failed = false,
  errorMessage = null,
  totalBatches = 0,
}) => {
  try {
    const $set = {
      total_images: totalImages,
      queued_images: queuedImages,
      skipped_images: skippedImages,
      total_batches: Math.max(0, Number(totalBatches) || 0),
    };

    if (failed) {
      $set.status = "failed";
      $set.completed_at = new Date();
    } else {
      $set.status = queuedImages > 0 ? "processing" : "completed";
      if (queuedImages === 0) {
        $set.completed_at = new Date();
      }
    }

    await ImageJob.updateOne({ job_uuid: jobUuid }, { $set });

    if (jobItems.length > 0) {
      await ImageJobItem.insertMany(jobItems, { ordered: false }).catch(() => {});
    }

    await ImageOptimizationLog.create({
      user_id: userId,
      job_id: jobId,
      job_uuid: jobUuid,
      store_hash: storeHash,
      job_type: "bulk",
      log_type: failed ? "error" : "info",
      step: failed ? "optimize_failed" : "queue",
      message: failed
        ? `Catalog fetch failed: ${errorMessage}`
        : `Catalog fetch complete. Queued ${queuedImages} images (${skippedImages} skipped)`,
      meta: { total_images: totalImages, queued_images: queuedImages, skipped_images: skippedImages },
    });

    return { error: null };
  } catch (err) {
    return { error: err.message };
  }
};

exports.writeOptimizationLogs = async (entries = []) => {
  if (!entries.length) {
    return { error: null };
  }

  try {
    await ImageOptimizationLog.insertMany(entries, { ordered: false });
    return { error: null };
  } catch (err) {
    console.error("[writeOptimizationLogs]", err.message);
    return { error: err.message };
  }
};

exports.setJobItemStatus = async ({
  jobUuid,
  productId,
  imageId,
  status,
  errorMessage = null,
  savedBytes = null,
  savedPercentage = null,
}) => {
  if (!jobUuid || productId == null || imageId == null) {
    return {
      error: "jobUuid, productId and imageId are required to update job item status",
    };
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

  if (status === "metadata_updated") {
    $set.completed_at = new Date();
    $set.error_message = null;
  }

  if (status === "failed") {
    $set.completed_at = new Date();
    $set.error_message = errorMessage || "Image optimization failed";
  }

  if (status === "skipped") {
    $set.completed_at = new Date();
    $set.skip_reason = errorMessage || "Skipped";
    $set.error_message = null;
  }

  try {
    await ImageJobItem.updateOne(buildItemFilter(jobUuid, productId, imageId), {
      $set,
    });
    return { error: null };
  } catch (err) {
    return { error: err.message };
  }
};

exports.getOptimizationJobStatus = async (jobUuid, storeHash, options = {}) => {
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

  const [job, logs, items] = await Promise.all([
    ImageJob.findOne(query).lean(),
    ImageOptimizationLog.find(logQuery)
      .sort({ created_at: -1 })
      .limit(200)
      .lean(),
    ImageJobItem.find(itemQuery)
      .sort({ _id: 1 })
      .skip(itemAfter ? 0 : (itemPage - 1) * itemLimit)
      .limit(itemLimit)
      .lean(),
  ]);

  if (!job) {
    return { error: null, job: null, logs, items, plan_limit: null };
  }

  const queued = getQueuedImageCount(job);
  const planLimitLog = logs.find((entry) => entry.step === "plan_limit");

  const plan_limit =
    job.status === "paused_plan_limit" && planLimitLog
      ? {
          code: planLimitLog.meta?.code || "PLAN_LIMIT_EXCEEDED",
          message:
            planLimitLog.message ||
            "Your plan limit was exceeded. Please upgrade your plan to continue.",
          upgrade_required: true,
          plan_slug: planLimitLog.meta?.plan_slug || null,
          plan_limit: planLimitLog.meta?.plan_limit ?? null,
          monthly_used: planLimitLog.meta?.monthly_used ?? null,
          remaining: planLimitLog.meta?.remaining ?? null,
          images_to_queue: planLimitLog.meta?.images_to_queue ?? job.queued_images ?? null,
        }
      : null;

  return {
    error: null,
    job: {
      ...job,
      queued_images: queued,
      pending_images: Math.max(0, queued - (job.processed_images || 0)),
      plan_limit,
    },
    logs,
    items,
    items_pagination: {
      page: itemPage,
      limit: itemLimit,
      total: null,
      requested_total: Number(job.total_images) || 0,
      has_more: items.length === itemLimit,
      next_cursor:
        items.length === itemLimit ? String(items[items.length - 1]._id) : null,
    },
    plan_limit,
  };
};

exports.recordOptimizationJobImageResult = async ({
  jobUuid,
  storeHash: storeHashHint = null,
  success,
  skipped = false,
  skipReason = null,
  imageId = null,
  productId = null,
  errorMessage = null,
  jobType: jobTypeHint = null,
  savedBytes = null,
  savedPercentage = null,
  metadataOnly = false,
}) => {
  if (!jobUuid) {
    return { error: "jobUuid is required", job: null };
  }

  const validJobType = normalizeJobType(jobTypeHint) || "bulk";
  const itemStatus = skipped
    ? "skipped"
    : success
      ? metadataOnly
        ? "metadata_updated"
        : "optimized"
      : "failed";
  const itemMessage = skipped
    ? skipReason || "Image skipped"
    : success
      ? null
      : errorMessage || "Image optimization failed";
  const successLogMessage = metadataOnly
    ? "Image metadata updated successfully"
    : "Image optimized successfully";

  try {
    const itemUpdate = ImageJobItem.updateOne(
      buildItemFilter(jobUuid, productId, imageId),
      {
        $set: {
          status: itemStatus,
          completed_at: new Date(),
          ...(skipped
            ? {
                skip_reason: itemMessage,
                error_message: null,
              }
            : {
                error_message: itemMessage,
              }),
          ...(success && savedBytes != null ? { saved_bytes: savedBytes } : {}),
          ...(success && savedPercentage != null
            ? { saved_percentage: savedPercentage }
            : {}),
        },
      }
    );

    const jobUpdate = ImageJob.findOneAndUpdate(
      { job_uuid: jobUuid },
      {
        $inc: {
          processed_images: 1,
          ...(skipped
            ? { skipped_images: 1 }
            : success
              ? { success_images: 1 }
              : { failed_images: 1 }),
        },
      },
      { returnDocument: "after" }
    );

    const [job] = await Promise.all([jobUpdate, itemUpdate]);

    if (!job) {
      const storeHash = await resolveStoreHashForJobRecord(
        jobUuid,
        productId,
        imageId,
        storeHashHint
      );

      if (storeHash) {
        await appendImageLog({
          jobUuid,
          storeHash,
          jobType: validJobType,
          imageId,
          productId,
          logType: skipped ? "warning" : success ? "info" : "error",
          step: skipped ? "skip" : success ? "optimize" : "optimize_failed",
          message: skipped
            ? itemMessage
            : success
              ? successLogMessage
              : errorMessage || "Image optimization failed",
          meta: {
            ...(skipped || success ? {} : { error: errorMessage }),
            job_record_missing: true,
            ...(success && savedBytes != null ? { saved_bytes: savedBytes } : {}),
            ...(success && savedPercentage != null
              ? { saved_percentage: savedPercentage }
              : {}),
          },
        });
      }

      return {
        error: storeHash
          ? null
          : "Optimization job not found in database",
        job: null,
        jobMissing: true,
      };
    }

    const queued = getQueuedImageCount(job);
    const logWrites = [
      ImageOptimizationLog.create({
        user_id: job.user_id || null,
        job_id: job._id,
        job_uuid: jobUuid,
        store_hash: job.store_hash,
        job_type: job.job_type || validJobType,
        image_id: imageId,
        product_id: productId,
        log_type: skipped ? "warning" : success ? "info" : "error",
        step: skipped ? "skip" : success ? "optimize" : "optimize_failed",
        message: skipped
          ? itemMessage
          : success
            ? successLogMessage
            : errorMessage || "Image optimization failed",
        meta: skipped
          ? {}
          : success
            ? {
                ...(savedBytes != null ? { saved_bytes: savedBytes } : {}),
                ...(savedPercentage != null
                  ? { saved_percentage: savedPercentage }
                  : {}),
              }
            : { error: errorMessage },
      }),
    ];

    if (
      job.processed_images >= queued &&
      queued > 0 &&
      job.status === "processing"
    ) {
      const finalStatus =
        job.success_images === 0 && job.failed_images > 0
          ? "failed"
          : "completed";

      logWrites.push(
        ImageJob.updateOne(
          { job_uuid: jobUuid },
          { $set: { status: finalStatus, completed_at: new Date() } }
        ),
        ImageOptimizationLog.create({
          user_id: job.user_id || null,
          job_id: job._id,
          job_uuid: jobUuid,
          store_hash: job.store_hash,
          job_type: job.job_type || validJobType,
          log_type: job.failed_images > 0 ? "warning" : "info",
          step: "complete",
          message: `Job ${finalStatus}: ${job.success_images} optimized, ${job.failed_images} failed, ${job.skipped_images} skipped`,
          meta: {
            total_images: job.total_images,
            queued_images: queued,
            skipped_images: job.skipped_images,
            processed_images: job.processed_images,
            success_images: job.success_images,
            failed_images: job.failed_images,
          },
        })
      );
    }

    await Promise.all(logWrites);

    // Consume one dashboard pending slot when a queued item finishes
    // (success or fail). Full compress always decrements.
    // Metadata-only (optimize_image_enabled=false) also registered pending at
    // queue time — only decrement when ImageStatus is still pending so
    // already-optimized metadata updates are not counted twice.
    if (!skipped && job.store_hash) {
      if (!metadataOnly) {
        await StoreImageStat.updateOne(
          { store_hash: job.store_hash },
          { $inc: { pending_images: -1 } }
        ).catch((err) => {
          console.error("[recordOptimizationJobImageResult] pending stat:", err.message);
        });
      } else if (productId != null && imageId != null) {
        const pid = Number(productId);
        const iid = Number(imageId);
        if (Number.isFinite(pid) && Number.isFinite(iid)) {
          const cleared = await ImageStatus.findOneAndDelete({
            store_hash: job.store_hash,
            product_id: pid,
            image_id: iid,
            status: "pending",
          }).catch((err) => {
            console.error(
              "[recordOptimizationJobImageResult] pending status clear:",
              err.message
            );
            return null;
          });

          if (cleared) {
            await StoreImageStat.updateOne(
              { store_hash: job.store_hash },
              { $inc: { pending_images: -1 } }
            ).catch((err) => {
              console.error(
                "[recordOptimizationJobImageResult] pending stat:",
                err.message
              );
            });
          }
        }
      }
    }

    return { error: null, job };
  } catch (err) {
    return { error: err.message, job: null };
  }
};

exports.createRestoreJob = async ({
  userId = null,
  storeHash,
  jobType,
  totalImages,
  queuedImages = totalImages,
  skippedImages = 0,
  jobUuid = crypto.randomUUID(),
  jobItems = [],
}) => {
  const validJobType = normalizeJobType(jobType);
  if (!validJobType || !isRestoreJobType(validJobType)) {
    return {
      error: `Invalid restore job_type "${jobType}". Allowed: ${RESTORE_JOB_TYPES.join(", ")}`,
      jobUuid: null,
      doc: null,
    };
  }

  try {
    const doc = await ImageJob.create({
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
      completed_at: queuedImages > 0 ? null : new Date(),
    });

    const writes = [];

    if (jobItems.length > 0) {
      writes.push(
        ImageJobItem.insertMany(
          jobItems.map((item) => ({
            ...item,
            user_id: userId,
            job_id: doc._id,
          })),
          { ordered: false }
        )
      );
    }

    writes.push(
      ImageOptimizationLog.create({
        user_id: userId,
        job_id: doc._id,
        job_uuid: jobUuid,
        store_hash: storeHash,
        job_type: validJobType,
        log_type: "info",
        step: "queue",
        message: `Restore job queued (${validJobType})`,
        meta: {
          total_images: totalImages,
          queued_images: queuedImages,
          skipped_images: skippedImages,
        },
      })
    );

    await Promise.all(writes);

    return { error: null, jobUuid, doc };
  } catch (err) {
    return { error: err.message, jobUuid: null, doc: null };
  }
};

exports.writeRestoreLogs = async (entries = []) => {
  if (!entries.length) {
    return { error: null };
  }

  try {
    await ImageOptimizationLog.insertMany(entries, { ordered: false });
    return { error: null };
  } catch (err) {
    console.error("[writeRestoreLogs]", err.message);
    return { error: err.message };
  }
};

exports.setRestoreJobItemStatus = async ({
  jobUuid,
  productId,
  imageId,
  status,
  errorMessage = null,
}) => {
  if (!jobUuid || productId == null || imageId == null) {
    return {
      error: "jobUuid, productId and imageId are required to update restore job item status",
    };
  }

  const $set = { status };

  if (status === "restoring") {
    $set.started_at = new Date();
    $set.error_message = null;
  }

  if (status === "restored" || status === "failed") {
    $set.completed_at = new Date();
    if (status === "failed") {
      $set.error_message = errorMessage || "Image restore failed";
    } else {
      $set.error_message = null;
    }
  }

  try {
    await ImageJobItem.updateOne(buildItemFilter(jobUuid, productId, imageId), {
      $set,
    });
    return { error: null };
  } catch (err) {
    return { error: err.message };
  }
};

exports.getRestoreJobStatus = async (
  jobUuid,
  storeHash,
  { page = 1, limit = 50 } = {}
) => {
  const query = { job_uuid: jobUuid };
  const logQuery = { job_uuid: jobUuid };
  if (storeHash) {
    query.store_hash = storeHash;
    logQuery.store_hash = storeHash;
  }

  const resolvedPage = Math.max(1, Number(page) || 1);
  const resolvedLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const skip = (resolvedPage - 1) * resolvedLimit;

  const [job, logs, itemsTotal, items] = await Promise.all([
    ImageJob.findOne(query).lean(),
    ImageOptimizationLog.find(logQuery)
      .sort({ created_at: -1 })
      .limit(200)
      .lean(),
    ImageJobItem.countDocuments({ job_uuid: jobUuid }),
    ImageJobItem.find({ job_uuid: jobUuid })
      .sort({ created_at: 1 })
      .skip(skip)
      .limit(resolvedLimit)
      .lean(),
  ]);

  if (!job) {
    return { error: null, job: null, logs, items, itemsTotal: 0, page: resolvedPage, limit: resolvedLimit };
  }

  const queued = getQueuedImageCount(job);

  return {
    error: null,
    job: {
      ...job,
      queued_images: queued,
      pending_images: Math.max(0, queued - (job.processed_images || 0)),
    },
    logs,
    items,
    itemsTotal,
    page: resolvedPage,
    limit: resolvedLimit,
  };
};

exports.recordRestoreJobImageResult = async ({
  jobUuid,
  storeHash: storeHashHint = null,
  success,
  imageId = null,
  productId = null,
  errorMessage = null,
  jobType: jobTypeHint = null,
  meta = {},
}) => {
  if (!jobUuid) {
    return { error: "jobUuid is required", job: null };
  }

  const itemStatus = success ? "restored" : "failed";
  const validJobType = normalizeJobType(jobTypeHint) || "restore_bulk";

  try {
    const itemUpdate = ImageJobItem.updateOne(
      buildItemFilter(jobUuid, productId, imageId),
      {
        $set: {
          status: itemStatus,
          completed_at: new Date(),
          error_message: success
            ? null
            : errorMessage || "Image restore failed",
        },
      }
    );

    const jobUpdate = ImageJob.findOneAndUpdate(
      { job_uuid: jobUuid },
      {
        $inc: {
          processed_images: 1,
          ...(success ? { success_images: 1 } : { failed_images: 1 }),
        },
      },
      { returnDocument: "after" }
    );

    const [job] = await Promise.all([jobUpdate, itemUpdate]);

    if (!job) {
      const storeHash = await resolveStoreHashForJobRecord(
        jobUuid,
        productId,
        imageId,
        storeHashHint
      );

      if (storeHash) {
        await appendImageLog({
          jobUuid,
          storeHash,
          jobType: validJobType,
          imageId,
          productId,
          logType: success ? "info" : "error",
          step: success ? "restore" : "restore_failed",
          message: success
            ? "Image restored successfully"
            : errorMessage || "Image restore failed",
          meta: {
            ...(success ? meta : { error: errorMessage, ...meta }),
            job_record_missing: true,
          },
        });
      }

      return {
        error: storeHash ? null : "Restore job not found in database",
        job: null,
        jobMissing: true,
      };
    }

    const queued = getQueuedImageCount(job);
    const logWrites = [
      ImageOptimizationLog.create({
        user_id: job.user_id || null,
        job_id: job._id,
        job_uuid: jobUuid,
        store_hash: job.store_hash,
        job_type: job.job_type || validJobType,
        image_id: imageId,
        product_id: productId,
        log_type: success ? "info" : "error",
        step: success ? "restore" : "restore_failed",
        message: success
          ? "Image restored successfully"
          : errorMessage || "Image restore failed",
        meta: success ? meta : { error: errorMessage, ...meta },
      }),
    ];

    if (
      job.processed_images >= queued &&
      queued > 0 &&
      job.status === "processing"
    ) {
      const finalStatus =
        job.success_images === 0 && job.failed_images > 0
          ? "failed"
          : "completed";

      logWrites.push(
        ImageJob.updateOne(
          { job_uuid: jobUuid },
          { $set: { status: finalStatus, completed_at: new Date() } }
        ),
        ImageOptimizationLog.create({
          user_id: job.user_id || null,
          job_id: job._id,
          job_uuid: jobUuid,
          store_hash: job.store_hash,
          job_type: job.job_type || validJobType,
          log_type: job.failed_images > 0 ? "warning" : "info",
          step: "complete",
          message: `Restore job ${finalStatus}: ${job.success_images} restored, ${job.failed_images} failed, ${job.skipped_images} skipped`,
          meta: {
            total_images: job.total_images,
            queued_images: queued,
            skipped_images: job.skipped_images,
            processed_images: job.processed_images,
            success_images: job.success_images,
            failed_images: job.failed_images,
          },
        })
      );
    }

    await Promise.all(logWrites);

    return { error: null, job };
  } catch (err) {
    return { error: err.message, job: null };
  }
};

/**
 * List store images eligible for restore (optimized + within backup window).
 * Prefer iterateRestorableImagesInChunks for large stores — this loads all rows into memory.
 */
exports.fetchRestorableImagesForStore = async (storeHash) => {
  const items = [];

  await exports.iterateRestorableImagesInChunks(storeHash, async (chunk) => {
    items.push(...chunk);
  });

  return items;
};

function getRestoreDbChunkSize() {
  return Math.max(50, Number(config.restore?.dbChunkSize) || 500);
}

function getRestoreQueueBatchSize() {
  return Math.max(50, Number(config.restore?.queueBatchSize) || 500);
}

function getRestoreFileCheckConcurrency() {
  return Math.max(5, Number(config.restore?.fileCheckConcurrency) || 50);
}

function restorableItemKey(productId, imageId) {
  return `${Number(productId)}:${Number(imageId)}`;
}

async function enrichStatusChunkWithOptimizationPaths(storeHash, statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    return [];
  }

  const imageIds = statuses.map((row) => row.image_id);

  const optimizations = await ImageOptimization.find({
    store_hash: storeHash,
    image_id: { $in: imageIds },
    original_image_path: { $ne: null, $exists: true },
  })
    .select({ product_id: 1, image_id: 1, original_image_path: 1 })
    .lean();

  const pathByKey = new Map(
    optimizations.map((row) => [
      restorableItemKey(row.product_id, row.image_id),
      row.original_image_path,
    ])
  );

  return statuses
    .filter((row) => pathByKey.has(restorableItemKey(row.product_id, row.image_id)))
    .map((row) => ({
      product_id: row.product_id,
      image_id: row.image_id,
      optimized_at: row.optimized_at,
      original_image_path: pathByKey.get(restorableItemKey(row.product_id, row.image_id)),
    }));
}

/**
 * Stream restorable images from MongoDB in bounded chunks (cursor on ImageStatus).
 */
exports.iterateRestorableImagesInChunks = async (
  storeHash,
  onChunk,
  { chunkSize = getRestoreDbChunkSize() } = {}
) => {
  if (!storeHash || typeof onChunk !== "function") {
    return { error: "storeHash and onChunk are required", totalChunks: 0, totalItems: 0 };
  }

  const cutoff = new Date(Date.now() - RESTORE_BACKUP_MS);
  const resolvedChunkSize = Math.max(50, Number(chunkSize) || getRestoreDbChunkSize());
  let statusBatch = [];
  let totalChunks = 0;
  let totalItems = 0;

  const cursor = ImageStatus.find({
    store_hash: storeHash,
    status: "optimized",
    optimized_at: { $gte: cutoff },
  })
    .select({ product_id: 1, image_id: 1, optimized_at: 1 })
    .lean()
    .cursor();

  const flushBatch = async () => {
    if (statusBatch.length === 0) {
      return;
    }

    const enriched = await enrichStatusChunkWithOptimizationPaths(storeHash, statusBatch);
    statusBatch = [];

    if (enriched.length === 0) {
      return;
    }

    totalChunks += 1;
    totalItems += enriched.length;
    await onChunk(enriched, { chunkIndex: totalChunks, chunkSize: enriched.length });
  };

  for await (const row of cursor) {
    statusBatch.push(row);
    if (statusBatch.length >= resolvedChunkSize) {
      await flushBatch();
    }
  }

  await flushBatch();
  await cursor.close();

  return { error: null, totalChunks, totalItems };
};

async function countRestorableImagesForStore(storeHash) {
  const cutoff = new Date(Date.now() - RESTORE_BACKUP_MS);
  return ImageStatus.countDocuments({
    store_hash: storeHash,
    status: "optimized",
    optimized_at: { $gte: cutoff },
  });
}

async function fileExists(filePath) {
  if (!filePath || !String(filePath).trim()) {
    return false;
  }

  try {
    await fs.access(String(filePath).trim());
    return true;
  } catch {
    return false;
  }
}

async function filterItemsWithExistingBackupFiles(items) {
  const eligible = [];
  const ineligible = [];
  const concurrency = getRestoreFileCheckConcurrency();

  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    const results = await Promise.all(
      slice.map(async (item) => ({
        item,
        exists: await fileExists(item.original_image_path),
      }))
    );

    for (const result of results) {
      if (result.exists) {
        eligible.push(result.item);
      } else {
        ineligible.push({
          item: result.item,
          reason: "Original image backup file is missing on disk. Restore cannot continue.",
        });
      }
    }
  }

  return { eligible, ineligible };
}

/**
 * Split a restore chunk into queued vs skipped rows (batch-friendly for DB-sourced chunks).
 */
exports.classifyRestoreChunkItems = async (storeHash, items, { indexOffset = 0 } = {}) => {
  const skipped = [];
  const candidates = [];
  const needsDbCheck = [];

  for (let index = 0; index < items.length; index++) {
    const item = items[index] || {};
    const globalIndex = indexOffset + index;
    const shop = item.shop != null ? String(item.shop).trim() : "";
    const productId = item.product_id;
    const imageId = item.image_id;

    const pushSkipped = (reason) => {
      skipped.push({
        index: globalIndex,
        reason,
        image_id: imageId ?? null,
        product_id: productId ?? null,
      });
    };

    if (shop && shop !== storeHash) {
      pushSkipped("shop does not match authenticated store");
      continue;
    }

    if (productId == null || productId === "") {
      pushSkipped("product_id is required");
      continue;
    }

    if (imageId == null || imageId === "") {
      pushSkipped("image_id is required");
      continue;
    }

    if (item.original_image_path) {
      candidates.push({ item, globalIndex, productId, imageId });
      continue;
    }

    needsDbCheck.push({ item, globalIndex, productId, imageId });
  }

  if (needsDbCheck.length > 0) {
    const imageIds = needsDbCheck.map((entry) => Number(entry.imageId));
    const cutoff = new Date(Date.now() - RESTORE_BACKUP_MS);

    const [statusRows, optimizationRows] = await Promise.all([
      ImageStatus.find({
        store_hash: storeHash,
        image_id: { $in: imageIds },
        status: "optimized",
        optimized_at: { $gte: cutoff },
      })
        .select({ product_id: 1, image_id: 1 })
        .lean(),
      ImageOptimization.find({
        store_hash: storeHash,
        image_id: { $in: imageIds },
        original_image_path: { $ne: null, $exists: true },
      })
        .select({ product_id: 1, image_id: 1, original_image_path: 1 })
        .lean(),
    ]);

    const statusKeys = new Set(
      statusRows.map((row) => restorableItemKey(row.product_id, row.image_id))
    );
    const pathByKey = new Map(
      optimizationRows.map((row) => [
        restorableItemKey(row.product_id, row.image_id),
        row.original_image_path,
      ])
    );

    for (const entry of needsDbCheck) {
      const key = restorableItemKey(entry.productId, entry.imageId);
      if (!statusKeys.has(key) || !pathByKey.has(key)) {
        skipped.push({
          index: entry.globalIndex,
          reason: "Image is not eligible for restore",
          image_id: entry.imageId ?? null,
          product_id: entry.productId ?? null,
        });
        continue;
      }

      candidates.push({
        item: {
          ...entry.item,
          original_image_path: pathByKey.get(key),
        },
        globalIndex: entry.globalIndex,
        productId: entry.productId,
        imageId: entry.imageId,
      });
    }
  }

  const { eligible, ineligible } = await filterItemsWithExistingBackupFiles(
    candidates
      .filter((entry) => entry.item.original_image_path)
      .map((entry) => entry.item)
  );

  const eligibleKeys = new Set(
    eligible.map((row) => restorableItemKey(row.product_id, row.image_id))
  );

  const toQueue = [];
  const jobItems = [];

  for (const entry of candidates) {
    const key = restorableItemKey(entry.productId, entry.imageId);
    const imageUrlRaw = entry.item.image_url;
    const imageUrlForJob =
      imageUrlRaw != null && String(imageUrlRaw).trim()
        ? String(imageUrlRaw).trim()
        : null;

    if (!entry.item.original_image_path) {
      skipped.push({
        index: entry.globalIndex,
        reason: "Original image backup path not found",
        image_id: entry.imageId ?? null,
        product_id: entry.productId ?? null,
      });
      jobItems.push({
        job_uuid: null,
        store_hash: storeHash,
        job_type: null,
        product_id: Number(entry.productId),
        image_id: Number(entry.imageId),
        image_url: imageUrlForJob,
        status: "skipped",
        skip_reason: "Original image backup path not found",
      });
      continue;
    }

    if (!eligibleKeys.has(key)) {
      const failed = ineligible.find(
        (row) => restorableItemKey(row.item.product_id, row.item.image_id) === key
      );
      skipped.push({
        index: entry.globalIndex,
        reason:
          failed?.reason ||
          "Original image backup file is missing on disk. Restore cannot continue.",
        image_id: entry.imageId ?? null,
        product_id: entry.productId ?? null,
      });
      jobItems.push({
        job_uuid: null,
        store_hash: storeHash,
        job_type: null,
        product_id: Number(entry.productId),
        image_id: Number(entry.imageId),
        image_url: imageUrlForJob,
        status: "skipped",
        skip_reason:
          failed?.reason ||
          "Original image backup file is missing on disk. Restore cannot continue.",
      });
      continue;
    }

    toQueue.push({
      index: entry.globalIndex,
      productId: Number(entry.productId),
      imageId: Number(entry.imageId),
      overrides: exports.resolveImagePlacementFields(entry.item),
    });
    jobItems.push({
      job_uuid: null,
      store_hash: storeHash,
      job_type: null,
      product_id: Number(entry.productId),
      image_id: Number(entry.imageId),
      image_url: imageUrlForJob,
      status: "queued",
      ...exports.placementFieldsForJobItem(entry.item),
    });
  }

  return { toQueue, skipped, jobItems };
};

exports.createRestoreJobPlaceholder = async ({
  jobUuid = crypto.randomUUID(),
  userId = null,
  storeHash,
  jobType,
}) => {
  const validJobType = normalizeJobType(jobType);
  if (!validJobType || !isRestoreJobType(validJobType)) {
    return {
      error: `Invalid restore job_type "${jobType}"`,
      jobUuid: null,
    };
  }

  try {
    const doc = await ImageJob.create({
      user_id: userId,
      job_uuid: jobUuid,
      store_hash: storeHash,
      job_type: validJobType,
      total_images: 0,
      queued_images: 0,
      skipped_images: 0,
      processed_images: 0,
      success_images: 0,
      failed_images: 0,
      status: "fetching",
      started_at: new Date(),
    });

    await ImageOptimizationLog.create({
      user_id: userId,
      job_id: doc._id,
      job_uuid: jobUuid,
      store_hash: storeHash,
      job_type: validJobType,
      log_type: "info",
      step: "queue",
      message: `Restore job started (${validJobType})`,
      meta: { mode: "chunked" },
    });

    return { error: null, jobUuid, doc };
  } catch (err) {
    return { error: err.message, jobUuid: null };
  }
};

exports.updateRestoreJobAfterScan = async ({
  jobUuid,
  userId = null,
  jobId = null,
  storeHash,
  jobType,
  totalImages,
  queuedImages,
  skippedImages,
  failed = false,
  errorMessage = null,
}) => {
  try {
    const $set = {
      total_images: totalImages,
      queued_images: queuedImages,
      skipped_images: skippedImages,
    };

    if (failed) {
      $set.status = "failed";
      $set.completed_at = new Date();
    } else {
      $set.status = queuedImages > 0 ? "processing" : "completed";
      if (queuedImages === 0) {
        $set.completed_at = new Date();
      }
    }

    await ImageJob.updateOne({ job_uuid: jobUuid }, { $set });

    await ImageOptimizationLog.create({
      user_id: userId,
      job_id: jobId,
      job_uuid: jobUuid,
      store_hash: storeHash,
      job_type: jobType,
      log_type: failed ? "error" : "info",
      step: failed ? "failed" : "queue",
      message: failed
        ? `Restore scan failed: ${errorMessage}`
        : `Restore scan complete. Queued ${queuedImages} images (${skippedImages} skipped)`,
      meta: {
        total_images: totalImages,
        queued_images: queuedImages,
        skipped_images: skippedImages,
      },
    });

    return { error: null };
  } catch (err) {
    return { error: err.message };
  }
};

exports.queueRestoreWorkerJobsBatch = async (
  toQueue,
  {
    jobUuid,
    userId = null,
    jobId = null,
    jobType,
    storeHash,
    storeUrl,
    accessToken,
    chunkIndex = 0,
    estimatedImages = 0,
    suppressHeavyWake = false,
  }
) => {
  if (!Array.isArray(toQueue) || toQueue.length === 0) {
    return [];
  }

  const routing = {
    storeHash,
    estimatedImages,
    suppressHeavyWake,
  };
  const results = [];

  for (const entry of toQueue) {
    const { bullJob, duplicate } = await addRestoreJob(
      "restore-image",
      {
        jobUuid,
        userId,
        jobId,
        job_type: jobType,
        storeHash,
        storeUrl,
        accessToken,
        productId: entry.productId,
        imageId: entry.imageId,
        overrides: entry.overrides || {},
      },
      {},
      routing
    );
    if (!duplicate && bullJob) {
      results.push(bullJob);
    }
  }

  return results;
};

exports.runRestoreImageJob = async ({
  jobUuid,
  userId = null,
  jobId = null,
  jobType,
  storeHash,
  storeUrl,
  accessToken,
  productId,
  imageId,
  overrides = {},
  maxAttempts = 1,
  attemptsMade = 0,
}) => {
  const isLastAttempt = attemptsMade + 1 >= maxAttempts;
  const logContext = jobUuid
    ? { userId, jobId, jobUuid, storeHash, jobType, productId, imageId }
    : null;

  if (jobUuid) {
    const { error: statusError } = await exports.setRestoreJobItemStatus({
      jobUuid,
      productId,
      imageId,
      status: "restoring",
    });

    if (statusError) {
      await appendImageLog({
        userId,
        jobId,
        jobUuid,
        storeHash,
        jobType,
        imageId,
        productId,
        logType: "error",
        step: "worker",
        message: "Failed to set job item status to restoring",
        meta: { error: statusError },
      });
    }
  }

  let success = false;
  let resultData = null;
  let errorMessage = null;

  try {
    let placementSource = { ...overrides };
    if (jobUuid && placementSource.is_thumbnail == null && placementSource.isThumbnail == null) {
      const jobItem = await ImageJobItem.findOne({
        job_uuid: jobUuid,
        product_id: Number(productId),
        image_id: Number(imageId),
      })
        .select({ is_thumbnail: 1, sort_order: 1 })
        .lean();

      if (jobItem?.is_thumbnail != null) {
        placementSource.is_thumbnail = jobItem.is_thumbnail;
      }
      if (jobItem?.sort_order != null && placementSource.sort_order == null) {
        placementSource.sort_order = jobItem.sort_order;
      }
    }

    const placement = exports.resolveImagePlacementFields(placementSource);
    const result = await restoreSingleImage({
      storeHash,
      storeUrl,
      accessToken,
      productId,
      imageId,
      overrides: { ...overrides, placement },
      logContext,
    });

    if (!result.success) {
      errorMessage = result.error || "Image restore failed";
      if (!result.skipped && !isLastAttempt) {
        throw new Error(errorMessage);
      }
      success = false;
    } else {
      success = true;
      resultData = result.data;
    }
  } catch (err) {
    errorMessage = err?.message || "Image restore failed";
    if (!isLastAttempt) {
      throw err;
    }
    success = false;
  }

  if (jobUuid && (success || isLastAttempt)) {
    const { error: recordError } = await exports.recordRestoreJobImageResult({
      jobUuid,
      storeHash,
      success,
      imageId,
      productId,
      errorMessage,
      jobType,
      meta: resultData || {},
    });

    if (recordError) {
      throw new Error(recordError);
    }
  }

  return { success, resultData, errorMessage, skipped: !success && !errorMessage };
};

exports.processRestoreChunkJob = async ({
  jobUuid,
  userId = null,
  jobId = null,
  jobType,
  storeHash,
  storeUrl,
  accessToken,
  items = [],
  maxAttempts = getJobAttempts(),
  attemptsMade = 0,
}) => {
  const summary = { processed: 0, success: 0, failed: 0 };
  const itemMaxAttempts = Math.max(maxAttempts, getJobAttempts());

  for (const entry of items) {
    summary.processed += 1;

    for (let attempt = 0; attempt < itemMaxAttempts; attempt += 1) {
      try {
        const result = await exports.runRestoreImageJob({
          jobUuid,
          userId,
          jobId,
          jobType,
          storeHash,
          storeUrl,
          accessToken,
          productId: entry.productId,
          imageId: entry.imageId,
          overrides: entry.overrides || {},
          maxAttempts: itemMaxAttempts,
          attemptsMade: attempt,
        });

        if (result.success) {
          summary.success += 1;
        } else if (attempt >= itemMaxAttempts - 1) {
          summary.failed += 1;
        } else {
          await sleepBackoff(attempt);
          continue;
        }
        break;
      } catch (err) {
        if (attempt >= itemMaxAttempts - 1) {
          summary.failed += 1;
          await appendImageLog({
            userId,
            jobId,
            jobUuid,
            storeHash,
            jobType,
            imageId: entry.imageId,
            productId: entry.productId,
            logType: "error",
            step: "worker",
            message: err?.message || "Restore chunk item failed",
          }).catch(() => {});
        } else {
          await sleepBackoff(attempt);
        }
      }
    }
  }

  return summary;
};

/**
 * Background coordinator: scan DB in chunks, persist job items, queue restore workers.
 */
exports.processBulkRestoreFromStore = async ({
  jobUuid,
  userId = null,
  jobId = null,
  storeHash,
  storeUrl,
  accessToken,
  jobType = "restore_bulk",
}) => {
  const totals = {
    totalImages: 0,
    queuedImages: 0,
    skippedImages: 0,
    chunks: 0,
  };
  const allSkipped = [];

  try {
    const estimatedImages = await countRestorableImagesForStore(storeHash);
    const restoreQueueTier = pickRestoreQueueTier({ estimatedImages, storeHash });

    const { error: iterateError, totalItems } = await exports.iterateRestorableImagesInChunks(
      storeHash,
      async (chunk, meta) => {
        const { toQueue, skipped, jobItems } = await exports.classifyRestoreChunkItems(
          storeHash,
          chunk,
          { indexOffset: totals.totalImages }
        );

        totals.totalImages += chunk.length;
        totals.skippedImages += skipped.length;
        totals.chunks += 1;
        allSkipped.push(...skipped);

        const stampedJobItems = jobItems.map((row) => ({
          ...row,
          user_id: userId,
          job_id: jobId,
          job_uuid: jobUuid,
          job_type: jobType,
        }));

        if (stampedJobItems.length > 0) {
          await ImageJobItem.insertMany(stampedJobItems, { ordered: false });
        }

        const queuedJobs = await exports.queueRestoreWorkerJobsBatch(toQueue, {
          jobUuid,
          userId,
          jobId,
          jobType,
          storeHash,
          storeUrl,
          accessToken,
          chunkIndex: meta?.chunkIndex ?? totals.chunks,
          estimatedImages,
          suppressHeavyWake: true,
        });
        totals.queuedImages += queuedJobs.length;
        totals.skippedImages += Math.max(0, toQueue.length - queuedJobs.length);

        if (skipped.length > 0) {
          await exports.writeRestoreLogs(
            skipped.map((skip) => ({
              user_id: userId,
              job_id: jobId,
              job_uuid: jobUuid,
              store_hash: storeHash,
              job_type: jobType,
              image_id: skip.image_id,
              product_id: skip.product_id,
              log_type: "warning",
              step: "skip",
              message: skip.reason,
              meta: { index: skip.index, chunk: meta?.chunkIndex || totals.chunks },
            }))
          );
        }

        if (totals.chunks % 10 === 0) {
          await ImageJob.updateOne(
            { job_uuid: jobUuid },
            {
              $set: {
                total_images: totals.totalImages,
                queued_images: totals.queuedImages,
                skipped_images: totals.skippedImages,
              },
            }
          );
        }
      }
    );

    if (iterateError) {
      throw new Error(iterateError);
    }

    if (totalItems === 0) {
      await exports.updateRestoreJobAfterScan({
        jobUuid,
        userId,
        jobId,
        storeHash,
        jobType,
        totalImages: 0,
        queuedImages: 0,
        skippedImages: 0,
      });
      return {
        jobUuid,
        ...totals,
        skipped: allSkipped,
        empty: true,
      };
    }

    await exports.updateRestoreJobAfterScan({
      jobUuid,
      userId,
      jobId,
      storeHash,
      jobType,
      totalImages: totals.totalImages,
      queuedImages: totals.queuedImages,
      skippedImages: totals.skippedImages,
    });

    if (restoreQueueTier === RESTORE_TIER_HEAVY) {
      await signalHeavyRestoreWorkerNeeded();
    }

    return {
      jobUuid,
      ...totals,
      skipped: allSkipped,
      empty: false,
    };
  } catch (err) {
    await exports.updateRestoreJobAfterScan({
      jobUuid,
      userId,
      jobId,
      storeHash,
      jobType,
      totalImages: totals.totalImages,
      queuedImages: totals.queuedImages,
      skippedImages: totals.skippedImages,
      failed: true,
      errorMessage: err.message,
    });
    throw err;
  }
};

/**
 * Process an explicit restore list in chunks (checkbox bulk restore).
 */
exports.processRestoreItemsInChunks = async ({
  storeHash,
  storeUrl,
  accessToken,
  jobType,
  items,
}) => {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      error: "No restore items provided",
      jobUuid: null,
      totalImages: 0,
      queuedImages: 0,
      skippedImages: 0,
    };
  }

  const jobUuid = crypto.randomUUID();
  const { error: placeholderError } = await exports.createRestoreJobPlaceholder({
    jobUuid,
    storeHash,
    jobType,
  });

  if (placeholderError) {
    return { error: placeholderError, jobUuid: null };
  }

  const totals = {
    totalImages: 0,
    queuedImages: 0,
    skippedImages: 0,
  };
  const allSkipped = [];
  const chunkSize = getRestoreDbChunkSize();
  const estimatedImages = items.length;
  const restoreQueueTier = pickRestoreQueueTier({ estimatedImages, storeHash });

  for (let offset = 0; offset < items.length; offset += chunkSize) {
    const chunk = items.slice(offset, offset + chunkSize);
    const chunkIndex = Math.floor(offset / chunkSize) + 1;
    const { toQueue, skipped, jobItems } = await exports.classifyRestoreChunkItems(
      storeHash,
      chunk,
      { indexOffset: offset }
    );

    totals.totalImages += chunk.length;
    totals.skippedImages += skipped.length;
    allSkipped.push(...skipped);

    const stampedJobItems = jobItems.map((row) => ({
      ...row,
      job_uuid: jobUuid,
      job_type: jobType,
    }));

    if (stampedJobItems.length > 0) {
      await ImageJobItem.insertMany(stampedJobItems, { ordered: false });
    }

    const queuedJobs = await exports.queueRestoreWorkerJobsBatch(toQueue, {
      jobUuid,
      jobType,
      storeHash,
      storeUrl,
      accessToken,
      chunkIndex,
      estimatedImages,
      suppressHeavyWake: true,
    });
    totals.queuedImages += queuedJobs.length;
    totals.skippedImages += Math.max(0, toQueue.length - queuedJobs.length);

    if (skipped.length > 0) {
      await exports.writeRestoreLogs(
        skipped.map((skip) => ({
          job_uuid: jobUuid,
          store_hash: storeHash,
          job_type: jobType,
          image_id: skip.image_id,
          product_id: skip.product_id,
          log_type: "warning",
          step: "skip",
          message: skip.reason,
          meta: { index: skip.index },
        }))
      );
    }
  }

  await exports.updateRestoreJobAfterScan({
    jobUuid,
    storeHash,
    jobType,
    totalImages: totals.totalImages,
    queuedImages: totals.queuedImages,
    skippedImages: totals.skippedImages,
  });

  if (restoreQueueTier === RESTORE_TIER_HEAVY) {
    await signalHeavyRestoreWorkerNeeded();
  }

  return {
    error: null,
    jobUuid,
    ...totals,
    skipped: allSkipped,
    queueTier: restoreQueueTier,
  };
};

exports.validateRestoreItemForQueue = async (storeHash, productId, imageId) => {
  const validation = await validateRestoreEligibility({
    storeHash,
    productId,
    imageId,
  });

  if (!validation.ok) {
    return { queue: false, reason: validation.skipReason };
  }

  return { queue: true, reason: null };
};

const WEBHOOK_BURST_WINDOW_SEC = 3;
const WEBHOOK_BURST_MAX = 5;

function webhookBurstKeys(storeHash) {
  const prefix = `webhook:burst:${storeHash}`;
  return {
    count: `${prefix}:count`,
    bulk: `${prefix}:bulk`,
    products: `${prefix}:products`,
  };
}

/**
 * Track product webhook in a 3s burst window. Only 1–5 calls per store are processed.
 * Returns whether the webhook was accepted into the burst tracker.
 */
exports.trackProductWebhookBurst = async (storeHash, productId, logContext = {}) => {
  const { traceId, eventHash, scope } = logContext;
  const redis = getRedis();
  const keys = webhookBurstKeys(storeHash);
  const productKey = String(productId);

  await appendWebhookLog({
    traceId,
    storeHash,
    eventHash,
    scope,
    productId,
    step: "burst_track",
    message: `Tracking webhook burst for product ${productId}`,
  });

  const count = await redis.incr(keys.count);
  await redis.sadd(keys.products, productKey);

  if (count === 1) {
    await redis.expire(keys.count, WEBHOOK_BURST_WINDOW_SEC + 2);
    await redis.expire(keys.products, WEBHOOK_BURST_WINDOW_SEC + 2);
    await redis.del(keys.bulk);

    const webhookQueue = getOptimizationQueue(
      pickOptimizationQueueTier({ estimatedImages: 1, storeHash })
    );

    await webhookQueue.add(
      "webhook-process",
      { storeHash },
      webhookWorkerJobOptions({
        delay: WEBHOOK_BURST_WINDOW_SEC * 1000,
        jobId: `webhook-process-${storeHash}`,
      })
    );

    await appendWebhookLog({
      traceId,
      storeHash,
      eventHash,
      scope,
      productId,
      step: "burst_job_scheduled",
      message: "Scheduled delayed webhook burst processing job",
      meta: { delay_sec: WEBHOOK_BURST_WINDOW_SEC },
    });
  } else if (count > WEBHOOK_BURST_MAX) {
    await redis.set(keys.bulk, "1", "EX", WEBHOOK_BURST_WINDOW_SEC + 2);

    await appendWebhookLog({
      traceId,
      storeHash,
      eventHash,
      scope,
      productId,
      logType: "warning",
      step: "burst_limit_exceeded",
      message: "Webhook burst limit exceeded; bulk import mode enabled",
      meta: { count, max: WEBHOOK_BURST_MAX },
    });
  }

  return { count, ignored: count > WEBHOOK_BURST_MAX };
};

/**
 * After the burst window, fetch product images and queue optimization jobs.
 */
exports.processWebhookProductBurst = async (storeHash) => {
  const redis = getRedis();
  const keys = webhookBurstKeys(storeHash);
  const burstTraceId = buildBurstTraceId(storeHash, Date.now());

  const [countRaw, isBulk, productIds] = await Promise.all([
    redis.get(keys.count),
    redis.get(keys.bulk),
    redis.smembers(keys.products),
  ]);

  await redis.del(keys.count, keys.bulk, keys.products);

  const count = Number(countRaw) || 0;

  await appendWebhookLog({
    traceId: burstTraceId,
    storeHash,
    step: "burst_process_start",
    message: "Started webhook burst processing",
    meta: { count, is_bulk: Boolean(isBulk), product_ids: productIds },
  });

  if (
    isBulk ||
    count > WEBHOOK_BURST_MAX ||
    count < 1 ||
    !Array.isArray(productIds) ||
    productIds.length === 0
  ) {
    const reason = isBulk || count > WEBHOOK_BURST_MAX ? "bulk_webhook_burst" : "empty_burst";

    await appendWebhookLog({
      traceId: burstTraceId,
      storeHash,
      logType: "warning",
      step: "burst_ignored",
      message: "Webhook burst processing ignored",
      meta: { reason, count },
    });

    return {
      ignored: true,
      reason,
      count,
    };
  }

  const [user, settingsResult] = await Promise.all([
    User.findOne({
      store_hash: storeHash,
      installStatus: "installed",
    })
      .select({ access_token: 1, storeUrl: 1, currency: 1, store_name: 1 })
      .lean(),
    exports.fetchStoreOptimizationSettings(storeHash),
  ]);

  const accessToken = user?.access_token;
  if (!accessToken || !String(accessToken).trim()) {
    await appendWebhookLog({
      traceId: burstTraceId,
      storeHash,
      logType: "warning",
      step: "burst_ignored",
      message: "Webhook burst ignored because store is not installed",
      meta: { reason: "store_not_installed" },
    });
    return { ignored: true, reason: "store_not_installed" };
  }

  const storeUrl = user.storeUrl;
  if (!storeUrl) {
    await appendWebhookLog({
      traceId: burstTraceId,
      storeHash,
      logType: "warning",
      step: "burst_ignored",
      message: "Webhook burst ignored because store URL is missing",
      meta: { reason: "store_url_missing" },
    });
    return { ignored: true, reason: "store_url_missing" };
  }

  const { error: settingError, settings } = settingsResult;

  await appendWebhookLog({
    traceId: burstTraceId,
    storeHash,
    step: "settings_check",
    message: "Checked auto-optimize settings for webhook burst",
    meta: {
      auto_optimize_new_images: Boolean(settings?.auto_optimize_new_images),
      has_optimization_feature: exports.hasAnyOptimizationFeatureEnabled(settings),
      setting_error: settingError || null,
    },
  });

  if (
    settingError ||
    !settings?.auto_optimize_new_images ||
    !exports.hasAnyOptimizationFeatureEnabled(settings)
  ) {
    await appendWebhookLog({
      traceId: burstTraceId,
      storeHash,
      logType: "warning",
      step: "burst_ignored",
      message: "Webhook burst ignored because auto optimize is disabled",
      meta: { reason: "auto_optimize_disabled" },
    });
    return { ignored: true, reason: "auto_optimize_disabled" };
  }

  const imageEntries = [];

  for (const rawProductId of productIds) {
    const productId = Number(rawProductId);
    if (!Number.isFinite(productId)) continue;

    const images = await fetchProductImages({
      storeHash,
      productId,
      accessToken,
    });

    await appendWebhookLog({
      traceId: burstTraceId,
      storeHash,
      productId,
      step: "product_images_fetch",
      message: `Fetched product images for webhook burst`,
      meta: { image_count: Array.isArray(images) ? images.length : 0 },
    });

    for (const image of images) {
      if (image?.id == null) continue;

      const imageUrl =
        image.image_file || image.url_standard || image.url_zoom || null;
      const resolvedUrl = resolveProductImageUrl(storeUrl, imageUrl);
      if (!resolvedUrl) continue;

      imageEntries.push({
        product_id: productId,
        image_id: Number(image.id),
        image_url: String(imageUrl).trim(),
        sort_order: image.sort_order,
        is_thumbnail: image.is_thumbnail,
      });
    }
  }

  if (imageEntries.length === 0) {
    await appendWebhookLog({
      traceId: burstTraceId,
      storeHash,
      logType: "warning",
      step: "no_images",
      message: "Webhook burst finished with no optimizable images",
      meta: { count, product_ids: productIds },
    });
    return { ignored: true, reason: "no_images", count };
  }

  const skipOptimizedIds = await exports.getAlreadyOptimizedImageIdSet(
    storeHash,
    imageEntries
  );

  const toQueue = [];
  const jobItems = [];
  const jobUuid = crypto.randomUUID();

  for (const entry of imageEntries) {
    if (skipOptimizedIds.has(entry.image_id)) {
      jobItems.push({
        job_uuid: jobUuid,
        store_hash: storeHash,
        job_type: "webhook",
        product_id: entry.product_id,
        image_id: entry.image_id,
        image_url: entry.image_url,
        status: "skipped",
        skip_reason: "Image is already optimized or currently optimizing",
        ...exports.placementFieldsForJobItem(entry),
      });
      continue;
    }

    jobItems.push({
      job_uuid: jobUuid,
      store_hash: storeHash,
      job_type: "webhook",
      product_id: entry.product_id,
      image_id: entry.image_id,
      image_url: entry.image_url,
      status: "queued",
      ...exports.placementFieldsForJobItem(entry),
    });

    toQueue.push(entry);
  }

  const { error: createJobError, doc: jobDoc } = await exports.createBulkOptimizationJob({
    jobUuid,
    userId: user._id,
    storeHash,
    jobType: "webhook",
    totalImages: imageEntries.length,
    queuedImages: toQueue.length,
    skippedImages: imageEntries.length - toQueue.length,
    jobItems,
  });

  if (createJobError || !jobDoc) {
    await appendWebhookLog({
      traceId: burstTraceId,
      storeHash,
      logType: "error",
      step: "failed",
      message: "Failed to create webhook optimization job",
      meta: { reason: createJobError },
    });
    return { ignored: true, reason: createJobError };
  }

  await appendWebhookLog({
    traceId: burstTraceId,
    storeHash,
    step: "job_create",
    message: "Created webhook optimization job",
    meta: {
      job_uuid: jobUuid,
      total_images: imageEntries.length,
      queued_images: toQueue.length,
      skipped_images: imageEntries.length - toQueue.length,
    },
  });

  const productContextCache = new Map();
  const storeTemplateOptions = {
    currency: user.currency,
    store_name: user.store_name,
  };

  const webhookRouting = {
    estimatedImages: toQueue.length,
    storeHash,
    suppressHeavyWake: true,
  };
  const webhookQueueTier = pickOptimizationQueueTier(webhookRouting);

  for (const entry of toQueue) {
    const imageMeta = await exports.buildJobImageMeta({
      storeHash,
      productId: entry.product_id,
      imageId: entry.image_id,
      accessToken,
      settings,
      storeOptions: storeTemplateOptions,
      productContextCache,
      placementOverrides: entry,
    });

    await addOptimizationJob(
      "optimize-image",
      {
        jobUuid,
        userId: user._id,
        jobId: jobDoc._id,
        job_type: "webhook",
        storeHash,
        storeUrl,
        accessToken,
        productId: entry.product_id,
        imageId: String(entry.image_id),
        imageUrl: entry.image_url,
        settings,
        imageMeta,
      },
      {},
      webhookRouting
    );

    await appendWebhookLog({
      traceId: burstTraceId,
      storeHash,
      productId: entry.product_id,
      imageId: entry.image_id,
      step: "optimize_queued",
      message: "Queued image optimization from webhook burst",
      meta: { job_uuid: jobUuid },
    });
  }

  if (webhookQueueTier === TIER_HEAVY) {
    await signalHeavyWorkerNeeded();
  }

  await appendWebhookLog({
    traceId: burstTraceId,
    storeHash,
    step: "complete",
    message: "Webhook burst processing completed",
    meta: {
      count,
      products: productIds.length,
      queued: toQueue.length,
      skipped: imageEntries.length - toQueue.length,
      job_uuid: jobUuid,
    },
  });

  return {
    ignored: false,
    count,
    products: productIds.length,
    queued: toQueue.length,
    skipped: imageEntries.length - toQueue.length,
    job_uuid: jobUuid,
  };
};

