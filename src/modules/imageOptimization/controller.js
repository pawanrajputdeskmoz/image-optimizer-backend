const {
  ImageOptimization,
  ImageJobItem,
  ImageStatus,
  ImageOldData,
} = require("../../models");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  resolveStorageRoot,
  getPreviewSigningSecret,
  resolvePreviewUrl,
  previewMimeType,
  safeDecodeURIComponent,
  isPathInsideRoot,
} = require("../../utils/previewUrls");
const { get } = require("../../utils/axiosUtils");
const { fetchCatalogProducts } = require("../../utils/bcCatalogRateLimit");
const { addOptimizationJob, pickOptimizationQueueTier, TIER_HEAVY } = require("../../queue/imageOptimizationQueues");
const { signalHeavyWorkerNeeded } = require("../../utils/elasticHeavyOptimizationWorker");
const { addRestoreJob, pickRestoreQueueTier } = require("../../queue/imageRestoreQueues");
const { catalogFetchQueue } = require("../../queue/catalogFetchQueue");
const { coordinatorWorkerJobOptions } = require("../../queue/workerJobOptions");
const { restoreSingleImage } = require("./utils/restoreImage");
const { RESTORE_BACKUP_DAYS, RESTORE_BACKUP_MS } = require("./utils/restoreImage");
const {
  normalizePagination,
  buildBigCommerceError,
  fetchStoreOptimizationSettings,
  hasAnyOptimizationFeatureEnabled,
  fetchProductTemplateContext,
  resolveGeneratedImageMeta,
  resolveImagePlacementFields,
  updateBigCommerceProductImageMetadata,
  incrementMetadataUpdateStats,
  createBulkOptimizationJob,
  writeOptimizationLogs,
  getOptimizationJobStatus,
  buildJobImageMeta,
  fetchAllCatalogImagesInChunks,
  placementFieldsForJobItem,
  syncQueuedJobItemPlacements,
  createRestoreJob,
  writeRestoreLogs,
  getRestoreJobStatus,
  validateRestoreItemForQueue,
  appendImageLog,
  getAlreadyOptimizedImageIdSet,
  shouldSkipImageOptimization,
  skipPendingJobItemsForImage,
  updateJobAfterCatalogFetch,
  getOptimizationBatchSize,
  getOptimizationBatchCount,
  queueOptimizationBatchJobs,
  createRestoreJobPlaceholder,
  processBulkRestoreFromStore,
  processRestoreItemsInChunks,
  registerPendingProductImages,
  getStoreDashboardStats: loadStoreDashboardStats,
} = require("./services");
const { getImageSizesFromUrls } = require("../../utils/sharpFunction");
const { resolveProductImageUrl } = require("./utils/urls");
const { compressImage } = require("./utils/compressImage");
const {
  parseChannelId,
  normalizeImageFile,
  resolveChannelSiteUrl,
} = require("../../utils/channelContext");
const config = require("../../config");
const {
  replyIfBulkOptimizationBlocked,
  buildBulkQueuedMessage,
  isFullBulkOptimizationJobType,
} = require("../../utils/bulkOptimizationGuard");
const {
  replyIfBulkRestoreBlocked,
  buildBulkRestoreQueuedMessage,
} = require("../../utils/bulkRestoreGuard");
const {
  canOptimizeImages,
  buildPlanLimitApiBody,
  clearPausedPlanLimitJobs,
  getStorePlanSlug,
} = require("../plans/service");
const { adjustPendingImages } = require("../../utils/storePendingImages");
const { notifyPlanLimitReached } = require("../../utils/planLimitNotify");

/** Run an array of async tasks in sequential batches to avoid memory / Redis pressure. */
async function batchAsync(items, batchSize, asyncFn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(asyncFn));
    results.push(...batchResults);
  }
  return results;
}

//=======================================================
// API Controllers
//=======================================================

// --- Catalog ---
exports.fetchAllProducts = async (req, reply) => {
  try {
    /**
     * ------------------------------------------------
     * 1. Extract & Validate Input
     * ------------------------------------------------
     */

    const body = req.body || {};
    const storeHash = req.storeHash;
    const channelId = parseChannelId(body);

    if (!storeHash) {
      return reply.status(400).send({
        success: false,
        message: "store_hash is required in body or query",
      });
    }

    if (!channelId) {
      return reply.status(400).send({
        success: false,
        message: "channel_id is required and must be a positive number",
      });
    }


    const { page, limit } = normalizePagination(body);

    const searchKeyword =
      typeof body.search === "string"
        ? body.search.trim()
        : "";

    const rawSort =
      typeof body.sort === "string" ? body.sort.trim().toLowerCase() : "";
    // BigCommerce expects separate `sort` + `direction` params (not "id:asc").
    // Default product name sort direction is asc when client omits sort.
    let sortField = "name";
    let sortDirection = "asc";
    if (rawSort === "desc" || rawSort === "name:desc") {
      sortDirection = "desc";
    } else if (rawSort === "asc" || rawSort === "name:asc" || !rawSort) {
      sortDirection = "asc";
    }

    const accessToken = req.accessToken || req.currentUser?.access_token || null;
    const storeUrl = req.currentUser?.storeUrl || null;

    if (
      typeof accessToken !== "string" ||
      accessToken.trim() === ""
    ) {
      return reply.status(401).send({
        success: false,
        message:
          "BigCommerce access token is missing for this store",
      });
    }

    /**
     * ------------------------------------------------
     * 4. Build Query Params
     * ------------------------------------------------
     */

    const params = new URLSearchParams({
      include: "images",
      include_fields:
        "id,name,page_title,price,images,custom_url",
      page: String(page),
      limit: String(limit),
      "channel_id:in": String(channelId),
      sort: sortField,
      direction: sortDirection,
    });

    if (searchKeyword) {
      params.set("keyword", searchKeyword);
    }

    const bcHeaders = {
      "X-Auth-Token": accessToken,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const bcConfig = { timeout: config.api.bigCommerceTimeoutMs };

    const [response, imageBaseUrl] = await Promise.all([
      fetchCatalogProducts(
        get,
        storeHash,
        params,
        bcHeaders,
        bcConfig
      ),
      resolveChannelSiteUrl(
        storeHash,
        channelId,
        accessToken,
        storeUrl
      ),
    ]);

    const products = Array.isArray(response?.data)
      ? response.data
      : [];

    /**
     * ------------------------------------------------
     * 7. Extract Unique Image IDs
     * ------------------------------------------------
     *
     * Single-pass extraction
     * Lower memory pressure
     */

    const imageIdSet = new Set();

    for (let i = 0; i < products.length; i++) {
      const product = products[i];

      const images = product.images;

      if (!Array.isArray(images) || images.length === 0) {
        continue;
      }

      for (let j = 0; j < images.length; j++) {
        const imageId = images[j]?.id;

        if (imageId != null) {
          imageIdSet.add(imageId);
        }
      }
    }

    const imageIds =
      imageIdSet.size > 0
        ? Array.from(imageIdSet)
        : [];

    /**
     * ------------------------------------------------
     * 8. Build image URL list for size fetch
     * ------------------------------------------------
     */

    const imageUrlItems = [];

    for (let i = 0; i < products.length; i++) {
      const images = products[i].images;
      if (!Array.isArray(images) || images.length === 0) continue;

      for (let j = 0; j < images.length; j++) {
        const image = images[j];
        const url = resolveProductImageUrl(
          imageBaseUrl,
          image.image_file,
          image.url_zoom || null
        );

        if (image.id != null && url) {
          imageUrlItems.push({ imageId: image.id, url });
        }
      }
    }

    /**
     * ------------------------------------------------
     * 9. Fetch image statuses + sizes in parallel
     * ------------------------------------------------
     */

    const statusByImageId = Object.create(null);
    const sizeByImageId = Object.create(null);
    const savedPercentageByImageId = Object.create(null);

    const [imageStatusRows, oldDataRows] = await Promise.all([
      imageIds.length > 0
        ? ImageStatus.find(
            {
              store_hash: storeHash,
              image_id: { $in: imageIds },
            },
            {
              image_id: 1,
              status: 1,
              _id: 0,
            }
          ).lean()
        : Promise.resolve([]),
      imageIds.length > 0
        ? ImageOldData.find(
            {
              store_hash: storeHash,
              image_id: { $in: imageIds },
            },
            {
              image_id: 1,
              "original.size": 1,
              "optimized.size": 1,
              saved_percentage: 1,
              _id: 0,
            }
          ).lean()
        : Promise.resolve([]),
    ]);

    for (let i = 0; i < imageStatusRows.length; i++) {
      const row = imageStatusRows[i];
      statusByImageId[row.image_id] = row.status;
    }

    for (let i = 0; i < oldDataRows.length; i++) {
      const row = oldDataRows[i];
      // Prefer optimized size when present (current BC file after optimize).
      const optimizedSize = row.optimized?.size;
      const originalSize = row.original?.size;
      const bytes =
        optimizedSize > 0
          ? optimizedSize
          : originalSize > 0
            ? originalSize
            : null;

      if (bytes != null) {
        sizeByImageId[row.image_id] = bytes;
      }

      if (
        typeof row.saved_percentage === "number" &&
        Number.isFinite(row.saved_percentage)
      ) {
        savedPercentageByImageId[row.image_id] = row.saved_percentage;
      }
    }

    const itemsNeedingSizeFetch = imageUrlItems.filter(
      (item) => sizeByImageId[item.imageId] == null
    );

    if (itemsNeedingSizeFetch.length > 0) {
      const fetchedSizes = await getImageSizesFromUrls(itemsNeedingSizeFetch, {
        concurrency: config.image.sizeFetchConcurrency,
      });

      for (const imageId of Object.keys(fetchedSizes)) {
        const bytes = fetchedSizes[imageId]?.bytes;
        if (typeof bytes === "number" && Number.isFinite(bytes)) {
          sizeByImageId[imageId] = bytes;
        }
      }
    }

    /**
     * ------------------------------------------------
     * 9. Build storefront product URLs (SEO custom paths)
     * ------------------------------------------------
     */

    const storefrontBase = imageBaseUrl
      ? String(imageBaseUrl).replace(/\/$/, "")
      : "";

    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      const customPath =
        product?.custom_url?.url != null
          ? String(product.custom_url.url).trim()
          : "";

      if (storefrontBase && customPath) {
        const normalizedPath = customPath.startsWith("/")
          ? customPath
          : `/${customPath}`;
        product.storefront_url = `${storefrontBase}${normalizedPath}`;
      }
    }

    /**
     * ------------------------------------------------
     * 10. Attach only frontend-used image fields
     * ------------------------------------------------
     */

    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      const images = product.images;

      if (!Array.isArray(images) || images.length === 0) {
        continue;
      }

      for (let j = 0; j < images.length; j++) {
        const image = images[j];

        const rawStatus = String(statusByImageId[image.id] || "pending");
        image.image_file = normalizeImageFile(image.image_file);
        image.optimization_status =
          rawStatus === "optimized" || rawStatus === "complete"
            ? "optimized"
            : rawStatus;

        const bytes = sizeByImageId[image.id];
        image.size = {
          bytes: typeof bytes === "number" ? bytes : null,
        };

        const savedPercentage = savedPercentageByImageId[image.id];
        image.saved_percentage =
          typeof savedPercentage === "number" ? savedPercentage : null;

        // Drop fields the product listing frontend does not use.
        delete image.product_id;
        delete image.url_standard;
        delete image.url_zoom;
        delete image.url_tiny;
        delete image.date_modified;
        delete image.image_update_status;
        delete image.saved_bytes;
      }
    }

    /**
     * ------------------------------------------------
     * 11. Send Response
     * ------------------------------------------------
     */

    return reply.status(200).send({
      success: true,
      message: "Products fetched successfully",
      data: products,
      pagination: response?.meta?.pagination || null,
    });
  } catch (error) {
    console.error(
      "[fetchAllProducts ERROR]",
      error
    );

    const bcError =
      buildBigCommerceError(error);

    return reply
      .status(bcError.status)
      .send(bcError.body);
  }
};

exports.getStoreDashboardStats = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const { error, data } = await loadStoreDashboardStats(storeHash);

    if (error) {
      return reply.status(500).send({
        success: false,
        message: error,
      });
    }

    return reply.status(200).send({
      success: true,
      message: "Store dashboard stats",
      data,
    });
  } catch (err) {
    console.error("[getStoreDashboardStats]", err);
    return reply.status(500).send({
      success: false,
      message: err.message || "Failed to load store stats",
    });
  }
};



//=======================================================

exports.getPreviewImgData = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;

    const imageId = Number(body.image_id);
    const productId = body.product_id != null ? Number(body.product_id) : null;

    if (!Number.isFinite(imageId)) {
      return reply.status(400).send({
        success: false,
        message: "image_id is required and must be a number",
      });
    }

    const optimizationQuery = { store_hash: storeHash, image_id: imageId };
    const oldDataQuery = { store_hash: storeHash, image_id: imageId };
    const statusQuery = { store_hash: storeHash, image_id: imageId };

    if (Number.isFinite(productId)) {
      optimizationQuery.product_id = productId;
      oldDataQuery.product_id = productId;
      statusQuery.product_id = productId;
    }

    const [imageOptimization, imageStatus, imageOldData] = await Promise.all([
      ImageOptimization.findOne(optimizationQuery)
        .select({
          store_hash: 1,
          product_id: 1,
          image_id: 1,
          bigcommerce_image_url: 1,
          original_image_path: 1,
          optimized_image_path: 1,
          bigcommerce_new_image_id: 1,
          bigcommerce_optimized_image_url: 1,
          optimization_type: 1,
          image_quality: 1,
          created_at: 1,
          updated_at: 1,
        })
        .lean(),

      ImageStatus.findOne(statusQuery)
        .select({
          status: 1,
          optimized_at: 1,
          updated_at: 1,
        })
        .lean(),

      ImageOldData.findOne(oldDataQuery)
        .select({
          store_hash: 1,
          product_id: 1,
          image_id: 1,
          imageName: 1,
          altText: 1,
          newImageName: 1,
          newAltText: 1,
          original_image_path: 1,
          original: 1,
          optimized: 1,
          saved_bytes: 1,
          saved_percentage: 1,
          created_at: 1,
          updated_at: 1,
        })
        .lean(),
    ]);

    if (!imageOptimization && !imageOldData) {
      return reply.status(404).send({
        success: false,
        message: "Image preview data not found",
      });
    }

    // If backup is older than the restore retention window, show the same
    // restore-eligibility message in preview flows (compare modals, etc).
    // Note: only possible when productId is present (preview calls send it).
    if (Number.isFinite(productId)) {
      const optimizedAt =
        imageStatus?.optimized_at ||
        imageOptimization?.updated_at ||
        imageOldData?.updated_at ||
        null;

      if (optimizedAt) {
        const ageMs = Date.now() - new Date(optimizedAt).getTime();
        if (ageMs > RESTORE_BACKUP_MS) {
          const optimizedOn = new Date(optimizedAt).toISOString().slice(0, 10);
          return reply.status(400).send({
            success: false,
            message: `Preview is not available. Image was optimized on ${optimizedOn}, which is more than ${RESTORE_BACKUP_DAYS} days ago.`,
            data: {
              image_id: Number(imageId),
              product_id: Number(productId),
              optimized_at: optimizedAt,
              backup_retention_days: RESTORE_BACKUP_DAYS,
            },
          });
        }
      }
    }

    const originalPath =
      imageOptimization?.original_image_path ||
      imageOldData?.original_image_path ||
      null;
    const optimizedPath = imageOptimization?.optimized_image_path || null;

    const oldImageMeta = imageOldData?.original || {};
    const newImageMeta = imageOldData?.optimized || {};
    const oldName = imageOldData?.imageName || "";
    const oldAltText = imageOldData?.altText || "";
    const newName = imageOldData?.newImageName || oldName;
    const newAltText = imageOldData?.newAltText || oldAltText;
    const originalUrl = resolvePreviewUrl(
      req,
      originalPath,
      imageOptimization?.bigcommerce_image_url,
    );
    const optimizedUrl = resolvePreviewUrl(
      req,
      optimizedPath,
      imageOptimization?.bigcommerce_optimized_image_url,
    );

    return reply.status(200).send({
      success: true,
      data: {
        image_id: imageId,
        product_id: imageOptimization?.product_id ?? imageOldData?.product_id ?? productId,
        old: {
          name: oldName,
          alt_text: oldAltText,
          size: oldImageMeta.size ?? null,
          width: oldImageMeta.width ?? null,
          height: oldImageMeta.height ?? null,
          format: oldImageMeta.format ?? null,
          file_path: originalPath,
          url: originalUrl,
        },
        new: {
          name: newName,
          alt_text: newAltText,
          size: newImageMeta.size ?? null,
          width: newImageMeta.width ?? null,
          height: newImageMeta.height ?? null,
          format: newImageMeta.format ?? null,
          file_path: optimizedPath,
          url: optimizedUrl,
        },
        comparison: {
          name: { old: oldName, new: newName },
          alt_text: { old: oldAltText, new: newAltText },
          size: {
            old: oldImageMeta.size ?? null,
            new: newImageMeta.size ?? null,
            saved_bytes: imageOldData?.saved_bytes ?? null,
            saved_percentage: imageOldData?.saved_percentage ?? null,
          },
        },
        saved_bytes: imageOldData?.saved_bytes ?? null,
        saved_percentage: imageOldData?.saved_percentage ?? null,
        files: {
          original: originalPath,
          optimized: optimizedPath,
        },
        urls: {
          original: originalUrl,
          optimized: optimizedUrl,
        },
        // backward-compatible alias
        oldData: imageOldData
          ? {
              imageName: oldName,
              altText: oldAltText,
              newImageName: newName,
              newAltText,
              original: imageOldData.original || { size: null },
              optimized: imageOldData.optimized || { size: null },
            }
          : null,
      },
    });
  } catch (error) {
    console.error("Get Preview Image Data Error:", error);

    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to fetch preview image data",
    });
  }
};

exports.getSignedPreviewFile = async (req, reply) => {
  try {
    const key = typeof req.query?.key === "string" ? req.query.key.trim() : "";
    const sig = typeof req.query?.sig === "string" ? req.query.sig.trim() : "";
    const exp = Number(req.query?.exp);
    const secret = getPreviewSigningSecret();

    if (!key || !sig || !Number.isFinite(exp) || !secret) {
      return reply.status(400).send({ success: false, message: "Invalid preview URL" });
    }

    const now = Math.floor(Date.now() / 1000);
    if (exp < now) {
      return reply.status(403).send({ success: false, message: "Preview URL expired" });
    }

    // Fastify already URL-decodes query values; decode again only if still encoded.
    const storageKey = safeDecodeURIComponent(key).replace(/\\/g, "/");
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(`${storageKey}:${exp}`)
      .digest("hex");
    const sigBuf = Buffer.from(sig, "hex");
    const expectedBuf = Buffer.from(expectedSig, "hex");
    if (
      sigBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expectedBuf)
    ) {
      return reply.status(403).send({ success: false, message: "Invalid preview signature" });
    }

    const storageRoot = resolveStorageRoot();
    const decodedKey = storageKey.replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = path.resolve(storageRoot, decodedKey);
    if (!isPathInsideRoot(filePath, storageRoot)) {
      return reply.status(403).send({ success: false, message: "Invalid preview path" });
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return reply.status(404).send({ success: false, message: "Preview file not found" });
    }

    return reply
      .type(previewMimeType(filePath))
      .header("cache-control", "private, max-age=300")
      .send(fs.createReadStream(filePath));
  } catch (error) {
    console.error("Signed Preview File Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to load preview file",
    });
  }
};





// --- Image optimization (single → multiple → bulk) ---
exports.singleImageOptimization = async (req, reply) => {
  let storeHash;
  let productId;
  let imageId;

  try {
    const body = req.body || {};
    storeHash = req.storeHash;
    const channelId = parseChannelId(body) || 1;
    let storeUrl = req.currentUser?.storeUrl || null;
    imageId = req.params.image_id;
    productId = body.product_id;

    if (!productId) {
      return reply.status(400).send({ success: false, message: "product_id is required" });
    }

    const accessToken = req.currentUser?.access_token;
    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    const [resolvedStoreUrl, { error: settingError, settings }] = await Promise.all([
      resolveChannelSiteUrl(storeHash, channelId, accessToken, storeUrl),
      fetchStoreOptimizationSettings(storeHash, channelId),
    ]);
    storeUrl = resolvedStoreUrl;
    if (settingError) {
      return reply.status(500).send({ success: false, message: settingError });
    }

    const runOptimize = Boolean(settings.optimize_image_enabled);
    const runFilename = Boolean(settings.is_filename_template_enabled);
    const runAltText = Boolean(settings.is_alt_text_template_enabled);

    const bulkMetadataOnlySupported = Boolean(
      settings.optimize_image_enabled ||
        settings.is_alt_text_template_enabled
    );

    if (!bulkMetadataOnlySupported) {
      return reply.status(400).send({
        success: false,
        message:
          "Bulk optimization requires image optimization or alt-text generation to be enabled in store settings",
        data: { settings },
      });
    }

    const forceReoptimize =
      body.force === true ||
      body.force_reoptimize === true ||
      body.reoptimize === true;

    // Filename/alt templates must still apply to already-optimized images
    // (metadata-only update), so "optimized" doesn't block when they're on.
    const metadataTemplatesOn = runFilename || runAltText;

    if (!forceReoptimize) {
      const clientStatus = String(
        body.optimization_status || body.status || ""
      ).toLowerCase();
      const clientSkipReason =
        clientStatus === "optimizing"
            ? "Image is currently being optimized. Please wait for the current optimization job to finish."
            : clientStatus === "optimized"
              ? "Image is already optimized"
              : null;
      const clientBlockingStatuses = metadataTemplatesOn
        ? ["optimizing"]
        : ["optimized", "optimizing"];
      const alreadyOptimizedOnClient = clientBlockingStatuses.includes(
        clientStatus
      );

      const { skip, code: skipCode, reason } = await shouldSkipImageOptimization(
        storeHash,
        productId,
        imageId,
        { accessToken, forceReoptimize }
      );
      const skipBlocks =
        skip && !(metadataTemplatesOn && skipCode === "optimized");

      if (skipBlocks || alreadyOptimizedOnClient) {
        return reply.status(200).send({
          success: true,
          skipped: true,
          message:
            reason ||
            clientSkipReason ||
            "Image is already optimized or currently optimizing",
          data: {
            image_id: Number(imageId),
            product_id: Number(productId),
            status: "optimized",
          },
        });
      }
    }

    let imageUrl = resolveProductImageUrl(
      storeUrl,
      normalizeImageFile(
        typeof body.image_url === "string" ? body.image_url.trim() : ""
      )
    );
    let imageName = body.imageName || body.image_name || null;
    let altText = body.altText || body.alt_text || null;

    const bcHeaders = {
      "X-Auth-Token": accessToken,
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    // Always fetch BC image when optimizing so we can preserve existing
    // description (alt text) when the alt-text generator is off.
    const needsBcImage =
      !imageUrl || runFilename || runAltText || runOptimize;
    const needsProductContext = runFilename || runAltText;

    const [bcImageResult, productContext] = await Promise.all([
      needsBcImage
        ? get(
          `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images/${imageId}`,
          bcHeaders
        ).catch((bcErr) => {
          if (bcErr?.response?.status === 404) return { notFound: true };
          throw bcErr;
        })
        : Promise.resolve(null),
      needsProductContext
        ? fetchProductTemplateContext(storeHash, productId, accessToken, {
          currency: req.currentUser?.currency,
          store_name: req.currentUser?.store_name,
        })
        : Promise.resolve(null),
    ]);

    if (bcImageResult?.notFound && !imageUrl) {
      if (!forceReoptimize) {
        return reply.status(200).send({
          success: true,
          skipped: true,
          message:
            "Image not found on BigCommerce (already replaced or deleted)",
          data: {
            image_id: Number(imageId),
            product_id: Number(productId),
            status: "skipped",
          },
        });
      }
      return reply.status(404).send({ success: false, message: "Image not found" });
    }

    const bcImage = bcImageResult?.data || null;

    if (!imageUrl && bcImage) {
      imageUrl = resolveProductImageUrl(
        storeUrl,
        bcImage?.image_file,
        bcImage?.url_standard || null
      );
      if (!imageUrl) {
        return reply.status(404).send({
          success: false,
          message: storeUrl
            ? "Image not found or image_file missing"
            : "Image not found. Reinstall app to save storeUrl.",
        });
      }
    }

    imageName = imageName || bcImage?.image_file || bcImage?.name || null;
    altText = altText || bcImage?.description || bcImage?.alt_text || null;

    const savedFromDb = await ImageOldData.findOne({
      store_hash: storeHash,
      product_id: productId,
      image_id: imageId,
    })
      .select({ imageName: 1, altText: 1, newImageName: 1, newAltText: 1 })
      .lean();

    const placement = resolveImagePlacementFields({
      ...(bcImage || {}),
      ...body,
    });

    const { oldImageName, oldAltText, newImageName, newAltText } =
      resolveGeneratedImageMeta({
        settings,
        productContext,
        imageId,
        sortOrder: placement.sortOrder,
        sourceFileName: bcImage?.image_file || imageName || "image.jpg",
        fallbackImageName: imageName,
        fallbackAltText: altText,
        savedFromDb,
      });

    // Metadata-only (filename / alt templates, no compression)
    if (!runOptimize) {
      const metadataPayload = { ...placement };
      if (runFilename && newImageName) metadataPayload.imageFile = newImageName;
      if (runAltText && newAltText) metadataPayload.description = newAltText;

      await updateBigCommerceProductImageMetadata({
        storeHash,
        productId,
        imageId,
        accessToken,
        ...metadataPayload,
      });

      await ImageOldData.updateOne(
        { store_hash: storeHash, product_id: productId, image_id: imageId },
        {
          $set: {
            imageName: oldImageName,
            altText: oldAltText,
            ...(runFilename && newImageName ? { newImageName } : {}),
            ...(runAltText && newAltText ? { newAltText } : {}),
          },
        },
        { upsert: true }
      );

      const filenameUpdated = Boolean(runFilename && newImageName);
      const altTextUpdated = Boolean(runAltText && newAltText);
      await incrementMetadataUpdateStats({
        storeHash,
        filenameUpdated,
        altTextUpdated,
      });

      const existingStatus = await ImageStatus.findOne({
        store_hash: storeHash,
        product_id: productId,
        image_id: imageId,
      })
        .select({ status: 1 })
        .lean();

      return reply.status(200).send({
        success: true,
        message: "Image metadata updated successfully",
        data: {
          image_id: imageId,
          product_id: productId,
          status: existingStatus?.status || "pending",
          metadata_only: true,
          settings,
          productContext,
          imageMeta: {
            oldImageName,
            oldAltText,
            newImageName: runFilename ? newImageName : null,
            newAltText: runAltText ? newAltText : null,
          },
        },
      });
    }

    await registerPendingProductImages(storeHash, [
      { product_id: productId, image_id: imageId },
    ], req.currentUser?._id);

    const planLimitReply = await replyIfMonthlyPlanLimitExceeded(
      reply,
      storeHash
    );
    if (planLimitReply) {
      return planLimitReply;
    }

    const result = await compressImage({
      storeHash,
      storeUrl,
      accessToken,
      imageId,
      productId,
      imageUrl,
      settings,
      imageMeta: {
        oldImageName,
        oldAltText,
        newImageName,
        newAltText,
        runFilename,
        runAltText,
        ...placement,
      },
      logContext: null,
    });

    // Single optimize has no job-item record step — consume pending here.
    // Metadata-only runs never registered a pending image, so don't decrement.
    if (!result?.data?.metadataOnly) {
      await adjustPendingImages(storeHash, -1);
    }

    if (!result.success) {
      if (result.plan_limit) {
        return reply.status(403).send(
          buildPlanLimitApiBody({
            code: result.code || "MONTHLY_QUOTA_EXCEEDED",
            message: result.error,
          })
        );
      }
      const bcError = buildBigCommerceError(new Error(result.error));
      return reply.status(bcError.status).send(bcError.body);
    }

    if (result.skipped) {
      return reply.status(200).send({
        success: true,
        skipped: true,
        message: result.reason || "Image optimization skipped",
        data: result.data || {
          image_id: Number(imageId),
          product_id: Number(productId),
          status: "skipped",
        },
      });
    }

    await skipPendingJobItemsForImage({
      storeHash,
      productId,
      imageId,
      skipReason: "Image optimized manually",
    }).catch((err) => {
      console.warn("[singleImageOptimization] skipPendingJobItemsForImage:", err?.message);
    });

    return reply.status(200).send({
      success: true,
      message: "Image optimized",
      data: { ...result.data },
    });
  } catch (error) {
    console.error("[singleImageOptimization] Error:", error);
    if (storeHash) {
      await appendImageLog({
        jobUuid: crypto.randomUUID(),
        storeHash,
        jobType: "single",
        imageId,
        productId,
        logType: "error",
        step: "optimize_failed",
        message: error.message || "Single image optimization failed",
        meta: { stack: error.stack },
      });
    }
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

/** Checkbox-selected images → job_type `checkBox` */
exports.bulkImageOptimizationCheckbox = (req, reply) =>
  queueBulkImageJobs(req, reply, "checkBox");

/**
 * Full-store bulk optimization.
 * Immediately creates a job record (status: "fetching") and pushes ONE job
 * to catalogFetchQueue, then returns 202. The catalogFetchWorker does the
 * actual BigCommerce catalog pagination and image queuing in the background,
 * avoiding Cloudflare's 30-second request timeout.
 */
exports.bulkImageOptimization = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const storeUrl = req.currentUser?.storeUrl || null;
    const accessToken = req.accessToken || req.currentUser?.access_token;

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    if (!storeUrl) {
      return reply.status(400).send({
        success: false,
        message: "storeUrl is missing. Reinstall app to save store URL.",
      });
    }

    const channelId = parseChannelId(req.body) || 1;

    const { error: settingError, settings } = await fetchStoreOptimizationSettings(storeHash, channelId);
    if (settingError) {
      return reply.status(500).send({ success: false, message: settingError });
    }

    const queueSupportsRequestedWork = Boolean(
      settings.optimize_image_enabled ||
        settings.is_alt_text_template_enabled
    );

    if (!queueSupportsRequestedWork) {
      return reply.status(400).send({
        success: false,
        message:
          "Bulk optimization requires image optimization or alt-text generation to be enabled in store settings",
        data: { settings },
      });
    }

    await clearPausedPlanLimitJobs(storeHash).catch(() => {});

    const planSlug = await getStorePlanSlug(storeHash, "free");
    const quota = await canOptimizeImages(storeHash, planSlug, 1);
    if (!quota.allowed) {
      await notifyPlanLimitReached(storeHash, {
        message: quota.message,
        planName: quota.plan_name || quota.plan?.name || null,
        monthlyLimit: quota.monthly_limit ?? null,
        monthlyUsed: quota.monthly_used ?? null,
      }).catch(() => {});
      return reply.status(403).send(buildPlanLimitApiBody(quota));
    }

    const bulkBlocked = await replyIfBulkOptimizationBlocked(
      reply,
      storeHash,
      "product"
    );
    if (bulkBlocked) {
      return;
    }

    const jobUuid = crypto.randomUUID();

    // Create a placeholder job record immediately — status "fetching"
    const ImageJob = require("../../models/ImageJob");
    const jobDoc = await ImageJob.create({
      user_id: req.currentUser?._id,
      job_uuid: jobUuid,
      store_hash: storeHash,
      job_type: "bulk",
      total_images: 0,
      queued_images: 0,
      skipped_images: 0,
      processed_images: 0,
      success_images: 0,
      failed_images: 0,
      status: "fetching",
      started_at: new Date(),
    });

    // Push ONE catalog-fetch job — worker handles the rest
    await catalogFetchQueue.add(
      "fetch-catalog",
      {
        jobUuid,
        userId: req.currentUser?._id,
        jobId: jobDoc._id,
        storeHash,
        storeUrl,
        accessToken,
        channelId,
        settings,
        currency: req.currentUser?.currency || null,
        store_name: req.currentUser?.store_name || null,
        selectedPlan: planSlug,
        maxQueueImages: quota.unlimited ? null : Math.max(0, Number(quota.remaining) || 0),
      },
      coordinatorWorkerJobOptions()
    );

    const queueCap = quota.unlimited
      ? null
      : Math.max(0, Number(quota.remaining) || 0);
    const queuedMessage = queueCap != null
      ? `Bulk optimization started. This run will queue up to ${queueCap.toLocaleString("en-US")} image(s) based on your remaining monthly quota.`
      : buildBulkQueuedMessage("product");

    return reply.status(202).send({
      success: true,
      message: queuedMessage,
      data: {
        job_uuid: jobUuid,
        job_type: "bulk",
        status: "fetching",
        entity_type: "product",
        quota_limited: queueCap != null,
        quota_remaining: queueCap,
      },
    });
  } catch (error) {
    console.error("[bulkImageOptimization] Error:", error);
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

exports.getOptimizationJob = async (req, reply) => {
  try {
    const jobUuid = req.params.job_uuid;
    if (!jobUuid) {
      return reply.status(400).send({
        success: false,
        message: "job_uuid is required",
      });
    }

    const {
      error: statusError,
      job,
      logs,
      items,
      items_pagination,
      plan_limit,
    } = await getOptimizationJobStatus(jobUuid, req.storeHash, {
      itemPage: req.query?.item_page,
      itemLimit: req.query?.item_limit,
      itemAfter: req.query?.item_after,
    });

    if (statusError) {
      return reply.status(500).send({
        success: false,
        message: statusError,
      });
    }

    if (!job && (!logs || logs.length === 0)) {
      return reply.status(404).send({
        success: false,
        message: "Optimization job not found",
      });
    }

    return reply.status(200).send({
      success: true,
      data: {
        job,
        logs,
        items,
        items_pagination,
        plan_limit: plan_limit || job?.plan_limit || null,
      },
    });
  } catch (error) {
    console.error("[getOptimizationJob] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to fetch optimization job",
    });
  }
};

// --- Image restore (single → multiple → bulk) ---
exports.restoreImage = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const channelId = parseChannelId(req.body) || 1;
    let storeUrl = req.currentUser?.storeUrl || null;
    const accessToken = req.accessToken || req.currentUser?.access_token || null;
    const imageId = Number(req.params.image_id);
    const productId = Number(req.body.product_id);

    if (!Number.isFinite(imageId)) {
      return reply.status(400).send({
        success: false,
        message: "image_id must be a valid number",
      });
    }

    if (!Number.isFinite(productId)) {
      return reply.status(400).send({
        success: false,
        message: "product_id is required and must be a valid number",
      });
    }

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    if (!storeUrl) {
      return reply.status(400).send({
        success: false,
        message: "storeUrl is missing. Reinstall app to save store URL.",
      });
    }

    if (accessToken && String(accessToken).trim()) {
      storeUrl = await resolveChannelSiteUrl(
        storeHash,
        channelId,
        accessToken,
        storeUrl
      );
    }

    const placement = resolveImagePlacementFields(req.body || {});
    const overrides = {
      altText: req.body.altText ?? req.body.alt_text,
      imageName: req.body.imageName ?? req.body.image_name,
      placement,
    };

    const { queue, reason } = await validateRestoreItemForQueue(
      storeHash,
      productId,
      imageId
    );

    if (!queue) {
      return reply.status(400).send({
        success: false,
        message: reason,
      });
    }

    const result = await restoreSingleImage({
      storeHash,
      storeUrl,
      accessToken,
      productId,
      imageId,
      overrides,
    });

    if (!result.success) {
      return reply.status(result.statusCode || 400).send({
        success: false,
        message: result.error,
        data: result.data || null,
      });
    }

    return reply.status(200).send({
      success: true,
      message: "Image restored to original and optimization records removed",
      data: result.data,
    });
  } catch (error) {
    console.error("[restoreImage] Error:", error);
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

/** Checkbox-selected images → job_type `restore_checkbox` */

exports.bulkRestoreCheckbox = (req, reply) =>
  queueBulkRestoreJobs(req, reply, "restore_checkbox");

/** Full-store restore: all eligible optimized images */

exports.bulkRestoreAll = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const storeUrl = req.currentUser?.storeUrl || null;
    const accessToken = req.accessToken || req.currentUser?.access_token;

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    if (!storeUrl) {
      return reply.status(400).send({
        success: false,
        message: "storeUrl is missing. Reinstall app to save store URL.",
      });
    }

    if (await replyIfBulkRestoreBlocked(reply, storeHash, "product")) {
      return;
    }

    const jobUuid = crypto.randomUUID();
    const { error: placeholderError, doc: jobDoc } = await createRestoreJobPlaceholder({
      jobUuid,
      userId: req.currentUser?._id,
      storeHash,
      jobType: "restore_bulk",
    });

    if (placeholderError || !jobDoc) {
      return reply.status(500).send({
        success: false,
        message: placeholderError,
      });
    }

    const restoreRouting = { storeHash, estimatedImages: 0 };
    const { tier: coordinatorTier } = await addRestoreJob(
      "restore-bulk-coordinator",
      {
        jobUuid,
        userId: req.currentUser?._id,
        jobId: jobDoc._id,
        storeHash,
        storeUrl,
        accessToken,
        job_type: "restore_bulk",
      },
      {
        jobId: `restore-bulk-coordinator-${jobUuid}`,
      },
      restoreRouting
    );

    return reply.status(202).send({
      success: true,
      message: buildBulkRestoreQueuedMessage("product"),
      data: {
        job_uuid: jobUuid,
        job_type: "restore_bulk",
        status: "fetching",
        entity_type: "product",
        queue_tier: coordinatorTier,
      },
    });
  } catch (error) {
    console.error("[bulkRestoreAll] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to queue bulk restore for store",
    });
  }
};

exports.getRestoreJob = async (req, reply) => {
  try {
    const jobUuid = req.params.job_uuid;
    if (!jobUuid) {
      return reply.status(400).send({
        success: false,
        message: "job_uuid is required",
      });
    }

    const page = Math.max(1, Number(req.query?.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 50));

    const {
      error: statusError,
      job,
      logs,
      items,
      itemsTotal,
      page: resolvedPage,
      limit: resolvedLimit,
    } = await getRestoreJobStatus(jobUuid, req.storeHash, { page, limit });

    if (statusError) {
      return reply.status(500).send({
        success: false,
        message: statusError,
      });
    }

    if (!job && (!logs || logs.length === 0)) {
      return reply.status(404).send({
        success: false,
        message: "Restore job not found",
      });
    }

    return reply.status(200).send({
      success: true,
      data: {
        job,
        logs,
        items,
        items_pagination: {
          page: resolvedPage,
          limit: resolvedLimit,
          total: itemsTotal,
          total_pages: Math.ceil((itemsTotal || 0) / resolvedLimit) || 0,
        },
      },
    });
  } catch (error) {
    console.error("[getRestoreJob] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to fetch restore job",
    });
  }
};

// --- Other ---
exports.updateAltText = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const accessToken =
      req.currentUser?.access_token || req.accessToken || null;
    const imageId = req.params.image_id;
    const productId = req.body.product_id;
    const altText = req.body.alt_text;
    const placement = resolveImagePlacementFields(req.body || {});

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    const existingOldData = await ImageOldData.findOne({
      store_hash: storeHash,
      product_id: Number(productId),
      image_id: Number(imageId),
    })
      .select({ altText: 1, newAltText: 1 })
      .lean();

    // Use the most recent "current" alt as old: newAltText if set (template/prev manual),
    // otherwise fall back to the original altText backup.
    let preservedOldAltText = existingOldData?.newAltText || existingOldData?.altText;
    if (preservedOldAltText == null && Number(productId) > 0) {
      const currentImage = await get(
        `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products/${productId}/images/${imageId}`,
        {
          "X-Auth-Token": accessToken,
          Accept: "application/json",
          "Content-Type": "application/json",
        }
      ).catch(() => null);

      preservedOldAltText =
        currentImage?.data?.description ??
        currentImage?.data?.alt_text ??
        null;
    }

    const result = await updateBigCommerceProductImageMetadata({
      storeHash,
      productId,
      imageId,
      accessToken,
      description: altText,
      ...placement,
    });

    if (result?.error) {
      return reply.status(400).send({
        success: false,
        message: result.error,
      });
    }

    if (result == null) {
      return reply.status(400).send({
        success: false,
        message:
          "At least one of alt_text, sort_order, or is_thumbnail is required",
      });
    }

    await ImageOldData.updateOne(
      {
        store_hash: storeHash,
        product_id: Number(productId),
        image_id: Number(imageId),
      },
      {
        $set: {
          ...(preservedOldAltText != null ? { altText: preservedOldAltText } : {}),
          ...(altText !== undefined ? { newAltText: altText } : {}),
        },
        $setOnInsert: {
          store_hash: storeHash,
          product_id: Number(productId),
          image_id: Number(imageId),
        },
      },
      { upsert: true }
    ).catch(() => { });

    if (altText != null && String(altText).trim()) {
      await incrementMetadataUpdateStats({
        storeHash,
        altTextUpdated: true,
      });
    }

    return reply.status(200).send({
      success: true,
      message: "Alt text updated",
    });
  } catch (error) {
    const bcError = buildBigCommerceError(error);

    return reply.status(bcError.status).send(bcError.body);
  }
};

//=======================================================
// Helpers
//=======================================================

async function replyIfMonthlyPlanLimitExceeded(reply, storeHash) {
  const planSlug = await getStorePlanSlug(storeHash, "free");
  const quota = await canOptimizeImages(storeHash, planSlug, 1);
  if (!quota.allowed) {
    await notifyPlanLimitReached(storeHash, {
      message: quota.message,
      planName: quota.plan_name || quota.plan?.name || null,
      monthlyLimit: quota.monthly_limit ?? null,
      monthlyUsed: quota.monthly_used ?? null,
    }).catch(() => {});
    return reply.status(403).send(buildPlanLimitApiBody(quota));
  }
  return null;
}

async function queueBulkImageJobs(req, reply, jobType, itemsOverride = null) {
  try {
    const items =
      itemsOverride ??
      (Array.isArray(req.body) ? req.body : req.body?.images);

    if (!Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({
        success: false,
        message: itemsOverride
          ? "No images found in store catalog to queue for optimization"
          : "Request body must be a non-empty array of images",
      });
    }

    const storeHash = req.storeHash;

    await clearPausedPlanLimitJobs(storeHash).catch(() => {});

    const planSlug = await getStorePlanSlug(storeHash, "free");
    const quota = await canOptimizeImages(storeHash, planSlug, 1);
    if (!quota.allowed) {
      await notifyPlanLimitReached(storeHash, {
        message: quota.message,
        planName: quota.plan_name || quota.plan?.name || null,
        monthlyLimit: quota.monthly_limit ?? null,
        monthlyUsed: quota.monthly_used ?? null,
      }).catch(() => {});
      return reply.status(403).send(buildPlanLimitApiBody(quota));
    }

    const bulkBlocked = isFullBulkOptimizationJobType(jobType)
      ? await replyIfBulkOptimizationBlocked(reply, storeHash, "product")
      : false;

    if (bulkBlocked) {
      return;
    }

    const storeUrl = req.currentUser?.storeUrl || null;
    const accessToken = req.accessToken || req.currentUser?.access_token;

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    if (!storeUrl) {
      return reply.status(400).send({
        success: false,
        message: "storeUrl is missing. Reinstall app to save store URL.",
      });
    }

    const channelId = parseChannelId(items[0]) || parseChannelId(req.body) || 1;

    const { error: settingError, settings } =
      await fetchStoreOptimizationSettings(storeHash, channelId);
    if (settingError) {
      return reply.status(500).send({ success: false, message: settingError });
    }

    const queueSupportsRequestedWork = Boolean(
      settings.optimize_image_enabled ||
        settings.is_alt_text_template_enabled
    );

    if (!queueSupportsRequestedWork) {
      return reply.status(400).send({
        success: false,
        message:
          "Checkbox optimization requires image optimization or alt-text generation to be enabled in store settings",
        data: { settings },
      });
    }

    const jobUuid = crypto.randomUUID();
    const skipped = [];
    const toQueue = [];
    const jobItems = [];
    const forceReoptimize =
      req.body?.force === true ||
      req.body?.force_reoptimize === true ||
      req.body?.reoptimize === true;

    // Checkbox: only alt-text may re-queue already-optimized images
    // (BC supports description PUT). Filename applies during real
    // optimize/upload, so filename alone must not reopen optimized images.
    // Full bulk now follows the same rule.
    //
    // Do NOT block on ImageStatus "pending" — that means "needs optimize"
    // (catalog sync / prior register), not "already handled".
    const metadataTemplatesOn =
      jobType === "checkBox" || jobType === "bulk"
        ? Boolean(settings.is_alt_text_template_enabled)
        : Boolean(
            settings.is_filename_template_enabled ||
              settings.is_alt_text_template_enabled
          );
    const blockingStatuses = metadataTemplatesOn
      ? ["optimizing"]
      : ["optimized", "optimizing"];

    const skipOptimizedIds = forceReoptimize
      ? new Set()
      : await getAlreadyOptimizedImageIdSet(storeHash, items, blockingStatuses);

    for (let index = 0; index < items.length; index++) {
      const item = items[index] || {};
      const shop = item.shop != null ? String(item.shop).trim() : "";
      const productId = item.product_id;
      const imageId = item.image_id;
      const imageUrlRaw = item.image_url;

      const pushSkipped = (reason, extra = {}) => {
        skipped.push({
          index,
          reason,
          image_id: imageId ?? null,
          product_id: productId ?? null,
          ...extra,
        });
        if (productId != null && productId !== "" && imageId != null && imageId !== "") {
          jobItems.push({
            job_uuid: jobUuid,
            store_hash: storeHash,
            job_type: jobType,
            product_id: Number(productId),
            image_id: Number(imageId),
            image_url: imageUrlRaw ? String(imageUrlRaw).trim() : null,
            status: "skipped",
            skip_reason: reason,
            ...placementFieldsForJobItem(item),
          });
        }
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

      if (!imageUrlRaw || !String(imageUrlRaw).trim()) {
        pushSkipped("image_url is required");
        continue;
      }

      const imageUrl = String(imageUrlRaw).trim();
      const resolvedUrl = resolveProductImageUrl(storeUrl, imageUrl);
      if (!resolvedUrl) {
        pushSkipped("image_url could not be resolved");
        continue;
      }

      const clientStatus = String(
        item.optimization_status || item.status || ""
      ).toLowerCase();
      const clientBlockingStatuses = metadataTemplatesOn
        ? ["optimizing"]
        : ["optimized", "optimizing"];
      const alreadyOptimizedOnClient = clientBlockingStatuses.includes(
        clientStatus
      );

      if (
        !forceReoptimize &&
        (skipOptimizedIds.has(Number(imageId)) || alreadyOptimizedOnClient)
      ) {
        pushSkipped("Image is already optimized or currently optimizing");
        continue;
      }

      jobItems.push({
        job_uuid: jobUuid,
        store_hash: storeHash,
        job_type: jobType,
        product_id: Number(productId),
        image_id: Number(imageId),
        image_url: imageUrl,
        status: "queued",
        ...placementFieldsForJobItem(item),
      });

      toQueue.push({
        index,
        productId,
        imageId: String(imageId),
        imageUrl,
        optimization_status:
          item.optimization_status || item.status || null,
        placementSource: item,
      });
    }

    const quotaQueueLimit = quota.unlimited
      ? null
      : Math.max(0, Number(quota.remaining) || 0);
    let quotaDeferredCount = 0;
    if (quotaQueueLimit != null && toQueue.length > quotaQueueLimit) {
      const overflow = toQueue.splice(quotaQueueLimit);
      quotaDeferredCount = overflow.length;
      const overflowKeySet = new Set(
        overflow.map((entry) => `${Number(entry.productId)}:${Number(entry.imageId)}`)
      );
      const quotaSkipReason =
        "Not queued because this run reached your remaining monthly image quota";

      for (const jobItem of jobItems) {
        if (jobItem.status !== "queued") continue;
        const key = `${Number(jobItem.product_id)}:${Number(jobItem.image_id)}`;
        if (!overflowKeySet.has(key)) continue;
        jobItem.status = "skipped";
        jobItem.skip_reason = quotaSkipReason;
      }

      skipped.push(
        ...overflow.map((entry) => ({
          index: entry.index,
          reason: quotaSkipReason,
          image_id: entry.imageId ?? null,
          product_id: entry.productId ?? null,
        }))
      );
    }

    const optimizationBatchSize = getOptimizationBatchSize();
    const useBatchQueue = toQueue.length >= optimizationBatchSize;

    if (useBatchQueue) {
      let queuedIndex = 0;
      for (const jobItem of jobItems) {
        if (jobItem.status !== "queued") continue;
        jobItem.batch_index = Math.floor(queuedIndex / optimizationBatchSize);
        queuedIndex += 1;
      }
    }

    const { error: createJobError, doc: jobDoc } = await createBulkOptimizationJob({
      jobUuid,
      userId: req.currentUser?._id,
      storeHash,
      jobType,
      totalImages: items.length,
      queuedImages: toQueue.length,
      skippedImages: skipped.length,
      jobItems,
      totalBatches: useBatchQueue
        ? getOptimizationBatchCount(toQueue.length, optimizationBatchSize)
        : 0,
    });

    if (createJobError || !jobDoc) {
      return reply.status(500).send({
        success: false,
        message: createJobError || "Failed to create optimization job in database",
      });
    }

    const storeTemplateOptions = {
      currency: req.currentUser?.currency,
      store_name: req.currentUser?.store_name,
    };

    const routing = {
      estimatedImages: toQueue.length,
      storeHash,
      suppressHeavyWake: true,
    };
    const queueTier = pickOptimizationQueueTier(routing);

    let queuedCount = toQueue.length;

    if (useBatchQueue) {
      const batchCount = getOptimizationBatchCount(toQueue.length, optimizationBatchSize);
      const { error: batchQueueError, results, queued, duplicates, paused } =
        await queueOptimizationBatchJobs({
          jobUuid,
          userId: req.currentUser?._id,
          jobId: jobDoc._id,
          batchCount,
          storeHash,
          storeUrl,
          accessToken,
          settings,
          job_type: jobType,
          currency: storeTemplateOptions.currency || null,
          store_name: storeTemplateOptions.store_name || null,
          estimatedImages: toQueue.length,
          suppressHeavyWake: true,
          selectedPlan: planSlug,
        });

      if (batchQueueError) {
        return reply.status(500).send({
          success: false,
          message: batchQueueError,
        });
      }

      if (paused) {
        return replyIfMonthlyPlanLimitExceeded(reply, storeHash);
      }

      if (queueTier === TIER_HEAVY) {
        await signalHeavyWorkerNeeded();
      }

      queuedCount = queued;
      if (duplicates > 0) {
        console.warn("[queueBulkImageJobs] duplicate batch jobs skipped", {
          jobUuid,
          duplicates,
        });
      }
    } else {
      const productContextCache = new Map();

      const toQueueWithMeta = await batchAsync(toQueue, 500, async (entry) => {
        const imageMeta = await buildJobImageMeta({
          storeHash,
          productId: entry.productId,
          imageId: Number(entry.imageId),
          accessToken,
          settings,
          storeOptions: storeTemplateOptions,
          productContextCache,
          placementOverrides: entry.placementSource || {},
        });
        return { ...entry, imageMeta };
      });

      const { error: placementSyncError } = await syncQueuedJobItemPlacements(
        jobUuid,
        toQueueWithMeta
      );

      if (placementSyncError) {
        console.error("[queueBulkImageJobs] placement sync:", placementSyncError);
      }

      const queueResults = await batchAsync(toQueueWithMeta, 500, (entry) =>
        addOptimizationJob(
          "optimize-image",
          {
            jobUuid,
            userId: req.currentUser?._id,
            jobId: jobDoc._id,
            job_type: jobType,
            storeHash,
            storeUrl,
            accessToken,
            productId: entry.productId,
            imageId: entry.imageId,
            imageUrl: entry.imageUrl,
            optimization_status: entry.optimization_status,
            settings,
            imageMeta: entry.imageMeta,
          },
          {},
          routing
        )
      );

      if (queueTier === TIER_HEAVY) {
        await signalHeavyWorkerNeeded();
      }

      for (let i = 0; i < queueResults.length; i++) {
        if (!queueResults[i]?.duplicate) continue;
        const entry = toQueueWithMeta[i];
        skipped.push({
          index: entry.index,
          reason: "Image is already queued for optimization",
          image_id: entry.imageId ?? null,
          product_id: entry.productId ?? null,
        });
      }

      queuedCount = queueResults.filter(
        (result) => result?.bullJob && !result.duplicate
      ).length;
    }

    if (skipped.length > 0) {
      const { error: skipLogError } = await writeOptimizationLogs(
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

      if (skipLogError) {
        console.error("[queueBulkImageJobs] skip logs:", skipLogError);
      }
    }

    console.log("[queueBulkImageJobs] response ready", {
      jobUuid,
      jobType,
      storeHash,
      total: items.length,
      toQueue: toQueue.length,
      queuedCount,
      skipped: skipped.length,
      queueTier,
      queue_mode: useBatchQueue ? "batch" : "per-image",
    });

    await appendImageLog({
      jobUuid,
      storeHash,
      jobType,
      logType: "info",
      step: "queue_ready",
      message: "Bulk optimization queue request ready",
      meta: {
        seq: 1,
        total: items.length,
        to_queue: toQueue.length,
        queued_count: queuedCount,
        skipped: skipped.length,
        queue_tier: queueTier,
        queue_mode: useBatchQueue ? "batch" : "per-image",
      },
    });

    return reply.status(202).send({
      success: true,
      message:
        quotaDeferredCount > 0
          ? `Queued ${queuedCount} image(s). ${quotaDeferredCount.toLocaleString("en-US")} image(s) were not queued because this run reached your remaining monthly quota.`
          : buildBulkQueuedMessage("product"),
      data: {
        job_uuid: jobUuid,
        entity_type: "product",
        queued: queuedCount,
        skipped: skipped.length,
        queue_mode: useBatchQueue ? "batch" : "per-image",
        quota_limited: quotaDeferredCount > 0,
        not_queued_due_to_quota: quotaDeferredCount,
        quota_remaining: quotaQueueLimit,
      },
    });
  } catch (error) {
    console.error("[queueBulkImageJobs] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to queue bulk optimization",
    });
  }
}

async function queueBulkRestoreJobs(req, reply, jobType, itemsOverride = null) {
  try {
    const items =
      itemsOverride ??
      (Array.isArray(req.body) ? req.body : req.body?.images);

    if (!Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({
        success: false,
        message: itemsOverride
          ? "No restorable images found for this store"
          : "Request body must be a non-empty array of images",
      });
    }

    const storeHash = req.storeHash;

    // Full restore_bulk stays blocked if any restore/optimize is active.
    // restore_checkbox mirrors checkBox optimize — overlapping checkbox restores allowed.
    if (
      jobType === "restore_bulk" &&
      (await replyIfBulkRestoreBlocked(reply, storeHash, "product"))
    ) {
      return;
    }

    const storeUrl = req.currentUser?.storeUrl || null;
    const accessToken = req.accessToken || req.currentUser?.access_token;

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    if (!storeUrl) {
      return reply.status(400).send({
        success: false,
        message: "storeUrl is missing. Reinstall app to save store URL.",
      });
    }

    const restoreRouting = {
      estimatedImages: items.length,
      storeHash,
    };
    const queueTier = pickRestoreQueueTier(restoreRouting);

    const result = await processRestoreItemsInChunks({
      storeHash,
      storeUrl,
      accessToken,
      jobType,
      items,
    });

    if (result.error) {
      return reply.status(500).send({
        success: false,
        message: result.error,
      });
    }

    const { error: statusError, job: jobRecord } = await getRestoreJobStatus(
      result.jobUuid,
      storeHash
    );

    if (statusError) {
      console.error("[queueBulkRestoreJobs] status fetch:", statusError);
    }

    return reply.status(202).send({
      success: true,
      message: buildBulkRestoreQueuedMessage("product"),
      data: {
        job_uuid: result.jobUuid,
        entity_type: "product",
        job_type: jobType,
        queue: queueTier === "heavy" ? "image-restore-heavy" : `image-restore-${queueTier}`,
        queue_tier: result.queueTier || queueTier,
        total_images: result.totalImages,
        queued_images: result.queuedImages,
        skipped_images: result.skippedImages,
        job: jobRecord,
        skipped: result.skipped,
      },
    });
  } catch (error) {
    console.error("[queueBulkRestoreJobs] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to queue bulk restore",
    });
  }
}
