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
  RESTORE_BACKUP_MS,
} = require("../../utils/restoreImage");
const ImageOldData = require("../../models/ImageOldData");
const { get } = require("../../utils/axiosUtils");
const { resolveOptimizeFormat } = require("../../utils/sharpFunction");
const {
  updateProductImageMetadata,
} = require("../../utils/bigCommerceProductImage");
const { resolveProductImageUrl } = require("../../utils/urls");
const { appendImageLog } = require("../../utils/imageActivityLog");
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
exports.fetchStoreOptimizationSettings = async (storeHash) => {
  try {

    if (!storeHash) {
      return {
        error: "storeHash is required",
        settings: null,
      };
    }

    const doc = await StoreOptimizationSettings.findOne({
      store_hash: storeHash,
    })
      .select({
        optimize_image_enabled: 1,
        is_filename_template_enabled: 1,
        filename_template: 1,
        is_alt_text_template_enabled: 1,
        alt_text_template: 1,
        image_quality: 1,
        output_format: 1,
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

  if (product.brand_id) {
    try {
      const brandRes = await get(
        `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/brands/${product.brand_id}`,
        headers
      );

      brand = brandRes?.data?.name || "";
    } catch {
      brand = "";
    }
  }

  if (Array.isArray(product.categories) && product.categories.length > 0) {
    try {
      const categoryId = product.categories[0];

      const categoryRes = await get(
        `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/categories/${categoryId}`,
        headers
      );

      category = categoryRes?.data?.name || "";
    } catch {
      category = "";
    }
  }

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
  const dbAltText =
    savedFromDb?.newAltText || savedFromDb?.altText || null;

  const oldImageName = fallbackImageName || dbFileName || null;
  const oldAltText = fallbackAltText || dbAltText || null;
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
    newAltText = dbAltText || oldAltText;
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

  const savedFromDb = await ImageOldData.findOne({
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

const SKIP_QUEUE_STATUSES = new Set(["optimized", "optimizing"]);

/**
 * Image IDs that should not be queued again (already done or in progress).
 * Accepts image id numbers or job items `{ product_id, image_id }`.
 */
exports.getAlreadyOptimizedImageIdSet = async (storeHash, imageIdsOrItems = []) => {
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

  const statusFilter = { $in: Array.from(SKIP_QUEUE_STATUSES) };
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
  imageId
) => {
  const iid = Number(imageId);
  if (!storeHash || !Number.isFinite(iid)) {
    return { skip: false, reason: null };
  }

  const pid = Number(productId);
  const statusQuery = {
    store_hash: storeHash,
    image_id: iid,
    status: { $in: Array.from(SKIP_QUEUE_STATUSES) },
  };

  if (Number.isFinite(pid)) {
    statusQuery.product_id = pid;
  }

  const statusRow = await ImageStatus.findOne(statusQuery)
    .select({ status: 1 })
    .lean();

  if (statusRow) {
    return {
      skip: true,
      reason:
        statusRow.status === "optimizing"
          ? "Image is currently being optimized"
          : "Image is already optimized",
    };
  }

  return { skip: false, reason: null };
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

  try {
    while (page <= totalPages) {
      const params = new URLSearchParams({
        include: "images",
        include_fields: "id,images",
        page: String(page),
        limit: String(limit),
      });

      const search = String(keyword || "").trim();
      if (search) {
        params.set("keyword", search);
      }

      const response = await get(
        `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products?${params.toString()}`,
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
  const status = error?.response?.status || 500;
  const bcPayload = error?.response?.data;
  const message =
    bcPayload?.title ||
    bcPayload?.message ||
    error?.message ||
    "Failed to fetch products from BigCommerce";

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

exports.normalizePagination = (query = {}) => {
  const { defaultPage, defaultLimit, maxLimit } = config.pagination;
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
  storeHash,
  jobType,
  totalImages,
  queuedImages = totalImages,
  skippedImages = 0,
  jobUuid = crypto.randomUUID(),
  jobItems = [],
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
      writes.push(ImageJobItem.insertMany(jobItems, { ordered: false }));
    }

    writes.push(
      ImageOptimizationLog.create({
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

    return { error: null, jobUuid, doc };
  } catch (err) {
    return { error: err.message, jobUuid: null, doc: null };
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

exports.getOptimizationJobStatus = async (jobUuid, storeHash) => {
  const query = { job_uuid: jobUuid };
  const logQuery = { job_uuid: jobUuid };
  if (storeHash) {
    query.store_hash = storeHash;
    logQuery.store_hash = storeHash;
  }

  const [job, logs, items] = await Promise.all([
    ImageJob.findOne(query).lean(),
    ImageOptimizationLog.find(logQuery)
      .sort({ created_at: -1 })
      .limit(200)
      .lean(),
    ImageJobItem.find({ job_uuid: jobUuid }).sort({ created_at: 1 }).lean(),
  ]);

  if (!job) {
    return { error: null, job: null, logs, items };
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
}) => {
  if (!jobUuid) {
    return { error: "jobUuid is required", job: null };
  }

  const validJobType = normalizeJobType(jobTypeHint) || "bulk";
  const itemStatus = skipped ? "skipped" : success ? "optimized" : "failed";
  const itemMessage = skipped
    ? skipReason || "Image skipped"
    : success
      ? null
      : errorMessage || "Image optimization failed";

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
              ? "Image optimized successfully"
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
            ? "Image optimized successfully"
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

    return { error: null, job };
  } catch (err) {
    return { error: err.message, job: null };
  }
};

exports.createRestoreJob = async ({
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
      writes.push(ImageJobItem.insertMany(jobItems, { ordered: false }));
    }

    writes.push(
      ImageOptimizationLog.create({
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

exports.getRestoreJobStatus = async (jobUuid, storeHash) => {
  const query = { job_uuid: jobUuid };
  const logQuery = { job_uuid: jobUuid };
  if (storeHash) {
    query.store_hash = storeHash;
    logQuery.store_hash = storeHash;
  }

  const [job, logs, items] = await Promise.all([
    ImageJob.findOne(query).lean(),
    ImageOptimizationLog.find(logQuery)
      .sort({ created_at: -1 })
      .limit(200)
      .lean(),
    ImageJobItem.find({ job_uuid: jobUuid }).sort({ created_at: 1 }).lean(),
  ]);

  if (!job) {
    return { error: null, job: null, logs, items };
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
 */
exports.fetchRestorableImagesForStore = async (storeHash) => {
  const cutoff = new Date(Date.now() - RESTORE_BACKUP_MS);

  const statuses = await ImageStatus.find({
    store_hash: storeHash,
    status: "optimized",
    optimized_at: { $gte: cutoff },
  })
    .select({ product_id: 1, image_id: 1, optimized_at: 1 })
    .lean();

  if (!statuses.length) {
    return [];
  }

  const keys = statuses.map((s) => ({
    product_id: s.product_id,
    image_id: s.image_id,
  }));

  const optimizations = await ImageOptimization.find({
    store_hash: storeHash,
    $or: keys,
  })
    .select({ product_id: 1, image_id: 1, original_image_path: 1 })
    .lean();

  const pathByKey = new Map(
    optimizations.map((o) => [
      `${o.product_id}:${o.image_id}`,
      o.original_image_path,
    ])
  );

  return statuses
    .filter((s) => pathByKey.has(`${s.product_id}:${s.image_id}`))
    .map((s) => ({
      product_id: s.product_id,
      image_id: s.image_id,
      optimized_at: s.optimized_at,
      original_image_path: pathByKey.get(`${s.product_id}:${s.image_id}`),
    }));
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

