const {
  User,
  ImageOptimization,
  ImageJobItem,
  ImageStatus,
  ImageOldData,
} = require("../../models");
const crypto = require("node:crypto");
const path = require("node:path");
const { get } = require("../../utils/axiosUtils");
const { imageOptimizationQueue } = require("../../queue/imageOptimizationQueue");
const { imageRestoreQueue } = require("../../queue/imageRestoreQueue");
const { restoreSingleImage } = require("../../utils/restoreImage");
const {
  normalizePagination,
  buildBigCommerceError,
  fetchStoreOptimizationSettings,
  hasAnyOptimizationFeatureEnabled,
  fetchProductTemplateContext,
  resolveGeneratedImageMeta,
  resolveImagePlacementFields,
  updateBigCommerceProductImageMetadata,
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
  setRestoreJobItemStatus,
  recordRestoreJobImageResult,
  fetchRestorableImagesForStore,
  validateRestoreItemForQueue,
  appendImageLog,
  getAlreadyOptimizedImageIdSet,
  shouldSkipImageOptimization,
} = require("./services");
const {
  getImageSizesFromUrls,
  resolveProductImageUrl,
  compressImage,
} = require("../../utils");
const { performance } = require("perf_hooks");


//=======================================================
// API Controllers
//=======================================================

// --- Catalog ---
exports.fetchAllProducts = async (req, reply) => {
  const apiStart = performance.now();

  try {
    /**
     * ------------------------------------------------
     * 1. Extract & Validate Input
     * ------------------------------------------------
     */

    const body = req.body || {};
    const storeHash = req.storeHash;


    if (!storeHash) {
      return reply.status(400).send({
        success: false,
        message: "store_hash is required in body or query",
      });
    }


    const { page, limit } = normalizePagination(body);

    const query = req.query || {};
    const searchKeyword =
      typeof query.query === "string"
        ? query.query.trim()
        : ""

    const user = await User.findOne(
      { store_hash: storeHash },
      { access_token: 1, storeUrl: 1, _id: 0 }
    ).lean();

    if (!user) {
      return reply.status(404).send({
        success: false,
        message:
          "Store is not installed. User not found for this store_hash",
      });
    }

    const accessToken = req.accessToken || user.access_token;
    const storeUrl = user.storeUrl || null;

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
        "id,name,page_title,price,images",
      page: String(page),
      limit: String(limit),
    });

    if (searchKeyword) {
      params.set("keyword", searchKeyword);
    }

    const bcStart = performance.now();

    const response = await get(
      `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog/products?${params.toString()}`,
      {
        "X-Auth-Token": accessToken,
        Accept: "application/json",
        "Content-Type": "application/json",
        timeout: 10000,
      }
    );

    const bcEnd = performance.now();

    console.log(
      `[BigCommerce API] ${(
        bcEnd - bcStart
      ).toFixed(2)} ms`
    );


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
     * 8. Fetch Image Statuses
     * ------------------------------------------------
     */

    const statusByImageId = Object.create(null);

    if (imageIds.length > 0) {
      const imageStatusRows = await ImageStatus.find(
        {
          store_hash: storeHash,
          image_id: { $in: imageIds },
        },
        {
          image_id: 1,
          status: 1,
          image_update_status: 1,
          _id: 0,
        }
      ).lean();

      for (
        let i = 0;
        i < imageStatusRows.length;
        i++
      ) {
        const row = imageStatusRows[i];

        statusByImageId[row.image_id] = {
          optimization_status: row.status,
          image_update_status: row.image_update_status || "pending",
        };
      }
    }

    /**
     * ------------------------------------------------
     * 8b. Resolve image sizes via sharp (from live URLs)
     * ------------------------------------------------
     */

    const imageUrlItems = [];

    for (let i = 0; i < products.length; i++) {
      const images = products[i].images;
      if (!Array.isArray(images) || images.length === 0) continue;

      for (let j = 0; j < images.length; j++) {
        const image = images[j];
        const url = resolveProductImageUrl(
          storeUrl,
          image.image_file,
          image.url_zoom || null
        );

        if (image.id != null && url) {
          imageUrlItems.push({ imageId: image.id, url });
        }
      }
    }

    const sizeFetchStart = performance.now();
    const sizeByImageId =
      imageUrlItems.length > 0
        ? await getImageSizesFromUrls(imageUrlItems, {
          concurrency: Number(process.env.IMAGE_SIZE_FETCH_CONCURRENCY) || 8,
        })
        : Object.create(null);
    const sizeFetchEnd = performance.now();

    console.log(
      `[fetchAllProducts] Image size fetch: ${imageUrlItems.length} images in ${(
        sizeFetchEnd - sizeFetchStart
      ).toFixed(2)} ms`
    );

    /**
     * ------------------------------------------------
     * 9. Attach Optimization Status + Size
     * ------------------------------------------------
     */

    const optimizationStatusCounts =
      Object.create(null);

    for (let i = 0; i < products.length; i++) {
      const product = products[i];

      const images = product.images;

      if (!Array.isArray(images) || images.length === 0) {
        continue;
      }

      for (let j = 0; j < images.length; j++) {
        const image = images[j];

        const statusInfo = statusByImageId[image.id] || {
          optimization_status: "pending",
          image_update_status: "pending",
        };

        image.optimization_status = statusInfo.optimization_status;
        image.image_update_status = statusInfo.image_update_status;

        const sizeInfo = sizeByImageId[image.id];
        image.size = sizeInfo
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


        optimizationStatusCounts[statusInfo.optimization_status] =
          (optimizationStatusCounts[statusInfo.optimization_status] || 0) + 1;

      }
    }

    /**
     * ------------------------------------------------
     * 10. Total API Timing
     * ------------------------------------------------
     */

    const apiEnd = performance.now();

    console.log(
      `[fetchAllProducts] Total API Time: ${(
        apiEnd - apiStart
      ).toFixed(2)} ms`
    );

    /**
     * ------------------------------------------------
     * 11. Send Response
     * ------------------------------------------------
     */

    return reply.status(200).send({
      success: true,
      message: "Products fetched successfully",

      data: products,

      pagination:
        response?.meta?.pagination || null,

      meta: {
        optimization_status_counts:
          optimizationStatusCounts,

        performance: {
          total_api_time_ms:
            Number(
              (apiEnd - apiStart).toFixed(2)
            ),

          bigcommerce_time_ms:
            Number(
              (bcEnd - bcStart).toFixed(2)
            ),
        },
      },
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

    if (Number.isFinite(productId)) {
      optimizationQuery.product_id = productId;
      oldDataQuery.product_id = productId;
    }

    const [imageOptimization, imageOldData] = await Promise.all([
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

      ImageOldData.findOne(oldDataQuery)
        .select({
          store_hash: 1,
          product_id: 1,
          image_id: 1,
          imageName: 1,
          altText: 1,
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

    const originalPath =
      imageOptimization?.original_image_path ||
      imageOldData?.original_image_path ||
      null;
    const optimizedPath = imageOptimization?.optimized_image_path || null;

    return reply.status(200).send({
      success: true,
      data: {
        image_id: imageId,
        product_id: imageOptimization?.product_id ?? imageOldData?.product_id ?? productId,
        optimization: imageOptimization || null,
        oldData: imageOldData || null,
        files: {
          original: originalPath,
          optimized: optimizedPath,
        },
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





// --- Image optimization (single → multiple → bulk) ---
exports.singleImageOptimization = async (req, reply) => {
  const singleJobUuid = crypto.randomUUID();
  let storeHash;
  let productId;
  let imageId;

  try {
    const body = req.body || {};
    storeHash = req.storeHash;
    const storeUrl = req.currentUser?.storeUrl || null;
    imageId = req.params.image_id;
    productId = body.product_id;

    await appendImageLog({
      jobUuid: singleJobUuid,
      storeHash,
      jobType: "single",
      imageId,
      productId,
      logType: "info",
      step: "queue",
      message: "Single image optimization started",
    });

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

    const { error: settingError, settings } = await fetchStoreOptimizationSettings(storeHash);
    if (settingError) {
      return reply.status(500).send({ success: false, message: settingError });
    }

    const runOptimize = Boolean(settings.optimize_image_enabled);
    const runFilename = Boolean(settings.is_filename_template_enabled);
    const runAltText = Boolean(settings.is_alt_text_template_enabled);

    if (!hasAnyOptimizationFeatureEnabled(settings)) {
      return reply.status(400).send({
        success: false,
        message: "No image optimization features are enabled in store settings",
        data: { settings },
      });
    }

    const forceReoptimize =
      body.force === true ||
      body.force_reoptimize === true ||
      body.reoptimize === true;

    if (!forceReoptimize) {
      const clientStatus = String(
        body.optimization_status || body.status || ""
      ).toLowerCase();
      const alreadyOptimizedOnClient = ["optimized", "optimizing"].includes(
        clientStatus
      );

      const { skip, reason } = await shouldSkipImageOptimization(
        storeHash,
        productId,
        imageId
      );

      if (skip || alreadyOptimizedOnClient) {
        return reply.status(200).send({
          success: true,
          skipped: true,
          message:
            reason ||
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
      typeof body.image_url === "string" ? body.image_url.trim() : ""
    );
    let imageName = body.imageName || body.image_name || null;
    let altText = body.altText || body.alt_text || null;

    const bcHeaders = {
      "X-Auth-Token": accessToken,
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    const needsBcImage = !imageUrl || runFilename || runAltText;
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

    const { oldImageName, oldAltText, newImageName, newAltText } =
      resolveGeneratedImageMeta({
        settings,
        productContext,
        sourceFileName: bcImage?.image_file || imageName || "image.jpg",
        fallbackImageName: imageName,
        fallbackAltText: altText,
        savedFromDb,
      });

    const placement = resolveImagePlacementFields({
      ...(bcImage || {}),
      ...body,
    });

    console.log("getting this in placement", placement);

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

      await Promise.all([
        ImageOldData.updateOne(
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
        ),
        ImageStatus.updateOne(
          { store_hash: storeHash, product_id: productId, image_id: imageId },
          {
            $set: {
              status: "optimized",
              image_update_status: "complete",
              optimized_at: new Date(),
            },
          },
          { upsert: true }
        ),
      ]);

      return reply.status(200).send({
        success: true,
        message: "Image metadata updated successfully",
        data: {
          image_id: imageId,
          product_id: productId,
          status: "optimized",
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
      logContext: {
        jobUuid: singleJobUuid,
        storeHash,
        jobType: "single",
        productId,
        imageId,
      },
    });

    if (!result.success) {
      const bcError = buildBigCommerceError(new Error(result.error));
      return reply.status(bcError.status).send(bcError.body);
    }

    await appendImageLog({
      jobUuid: singleJobUuid,
      storeHash,
      jobType: "single",
      imageId,
      productId,
      logType: "info",
      step: "complete",
      message: "Single image optimization completed",
      meta: { new_image_id: result.data?.new_image_id },
    });

    return reply.status(200).send({
      success: true,
      message: "Image optimized and replaced successfully",
      data: { ...result.data, },
    });
  } catch (error) {
    console.error("[singleImageOptimization] Error:", error);
    if (storeHash) {
      await appendImageLog({
        jobUuid: singleJobUuid,
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

/** Full-store: fetch all BC product images (chunked) → queue job_type `bulk` */
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

    const { error: settingError, settings } =
      await fetchStoreOptimizationSettings(storeHash);
    if (settingError) {
      return reply.status(500).send({ success: false, message: settingError });
    }

    if (!hasAnyOptimizationFeatureEnabled(settings)) {
      return reply.status(400).send({
        success: false,
        message: "No image optimization features are enabled in store settings",
        data: { settings },
      });
    }

    const { error: catalogError, items, meta } =
      await fetchAllCatalogImagesInChunks({
        storeHash,
        accessToken,
        storeUrl,
      });

    if (catalogError) {
      const bcError = buildBigCommerceError(new Error(catalogError));
      return reply.status(bcError.status).send(bcError.body);
    }

    req.catalogFetchMeta = meta;
    return queueBulkImageJobs(req, reply, "bulk", items);
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

    const { error: statusError, job, logs, items } = await getOptimizationJobStatus(
      jobUuid,
      req.storeHash
    );

    if (statusError) {
      return reply.status(500).send({
        success: false,
        message: statusError,
      });
    }

    if (!job) {
      return reply.status(404).send({
        success: false,
        message: "Optimization job not found",
      });
    }

    return reply.status(200).send({
      success: true,
      data: { job, logs, items },
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
    const storeUrl = req.currentUser?.storeUrl || null;
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
    const accessToken = req.accessToken || req.currentUser?.access_token;

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    const items = await fetchRestorableImagesForStore(storeHash);

    req.restoreFetchMeta = {
      restorable_images: items.length,
    };

    return queueBulkRestoreJobs(req, reply, "restore_bulk", items);
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

    const { error: statusError, job, logs, items } = await getRestoreJobStatus(
      jobUuid,
      req.storeHash
    );

    if (statusError) {
      return reply.status(500).send({
        success: false,
        message: statusError,
      });
    }

    if (!job) {
      return reply.status(404).send({
        success: false,
        message: "Restore job not found",
      });
    }

    return reply.status(200).send({
      success: true,
      data: { job, logs, items },
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
          altText,
          newAltText: altText,
        },
        $setOnInsert: {
          store_hash: storeHash,
          product_id: Number(productId),
          image_id: Number(imageId),
        },
      },
      { upsert: true }
    ).catch(() => { });

    return reply.status(200).send({
      success: true,
      message: "Alt text updated",
      data: {
        image_id: Number(imageId),
        product_id: Number(productId),
        alt_text: altText,
        bigcommerce: result,
      },
    });
  } catch (error) {
    const bcError = buildBigCommerceError(error);

    return reply.status(bcError.status).send(bcError.body);
  }
};

//=======================================================
// Helpers
//=======================================================

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

    const { error: settingError, settings } =
      await fetchStoreOptimizationSettings(storeHash);
    if (settingError) {
      return reply.status(500).send({ success: false, message: settingError });
    }

    if (!hasAnyOptimizationFeatureEnabled(settings)) {
      return reply.status(400).send({
        success: false,
        message: "No image optimization features are enabled in store settings",
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

    const skipOptimizedIds = forceReoptimize
      ? new Set()
      : await getAlreadyOptimizedImageIdSet(storeHash, items);

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
      const alreadyOptimizedOnClient = ["optimized", "optimizing"].includes(
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

    const { error: createJobError, doc: jobDoc } = await createBulkOptimizationJob({
      jobUuid,
      storeHash,
      jobType,
      totalImages: items.length,
      queuedImages: toQueue.length,
      skippedImages: skipped.length,
      jobItems,
    });

    if (createJobError || !jobDoc) {
      return reply.status(500).send({
        success: false,
        message: createJobError || "Failed to create optimization job in database",
      });
    }

    const productContextCache = new Map();
    const storeTemplateOptions = {
      currency: req.currentUser?.currency,
      store_name: req.currentUser?.store_name,
    };

    const toQueueWithMeta = await Promise.all(
      toQueue.map(async (entry) => {
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
      })
    );

    const { error: placementSyncError } = await syncQueuedJobItemPlacements(
      jobUuid,
      toQueueWithMeta
    );

    if (placementSyncError) {
      console.error("[queueBulkImageJobs] placement sync:", placementSyncError);
    }

    const queueResults = await Promise.all(
      toQueueWithMeta.map((entry) =>
        imageOptimizationQueue.add(
          "optimize-image",
          {
            jobUuid,
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
          {
            removeOnComplete: 200,
            removeOnFail: 500,
            attempts: 2,
            backoff: { type: "exponential", delay: 5000 },
          }
        )
      )
    );

    const jobs = queueResults.map((bullJob, i) => ({
      index: toQueueWithMeta[i].index,
      jobId: bullJob.id,
      image_id: toQueueWithMeta[i].imageId,
      product_id: toQueueWithMeta[i].productId,
    }));

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

    const { error: statusError, job: jobRecord } = await getOptimizationJobStatus(
      jobUuid,
      storeHash
    );

    if (statusError) {
      console.error("[queueBulkImageJobs] status fetch:", statusError);
    }

    const responseData = {
      job_uuid: jobUuid,
      job_type: jobType,
      queue: "image-optimization",
      total_images: items.length,
      queued_images: jobs.length,
      skipped_images: skipped.length,
      settings: {
        optimize_image_enabled: Boolean(settings.optimize_image_enabled),
        is_filename_template_enabled: Boolean(
          settings.is_filename_template_enabled
        ),
        is_alt_text_template_enabled: Boolean(
          settings.is_alt_text_template_enabled
        ),
        image_quality: settings.image_quality,
        output_format: settings.output_format,
      },
      job: jobRecord,
      jobs,
      skipped,
    };

    if (req.catalogFetchMeta) {
      responseData.catalog = req.catalogFetchMeta;
    }

    return reply.status(202).send({
      success: true,
      message: "Bulk image optimization jobs queued",
      data: responseData,
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

    const jobUuid = crypto.randomUUID();
    const skipped = [];
    const toQueue = [];
    const jobItems = [];

    for (let index = 0; index < items.length; index++) {
      const item = items[index] || {};
      const shop = item.shop != null ? String(item.shop).trim() : "";
      const productId = item.product_id;
      const imageId = item.image_id;
      const imageUrlRaw = item.image_url;
      const imageUrlForJob =
        imageUrlRaw != null && String(imageUrlRaw).trim()
          ? String(imageUrlRaw).trim()
          : null;

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
            image_url: imageUrlForJob,
            status: "skipped",
            skip_reason: reason,
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

      const { queue, reason } = await validateRestoreItemForQueue(
        storeHash,
        productId,
        imageId
      );

      if (!queue) {
        pushSkipped(reason || "Image is not eligible for restore");
        continue;
      }

      jobItems.push({
        job_uuid: jobUuid,
        store_hash: storeHash,
        job_type: jobType,
        product_id: Number(productId),
        image_id: Number(imageId),
        image_url: imageUrlForJob,
        status: "queued",
      });

      toQueue.push({
        index,
        productId: Number(productId),
        imageId: Number(imageId),
        overrides: {
          altText: item.altText ?? item.alt_text,
          imageName: item.imageName ?? item.image_name,
          ...resolveImagePlacementFields(item),
        },
      });
    }

    const { error: createJobError, doc: jobDoc } = await createRestoreJob({
      jobUuid,
      storeHash,
      jobType,
      totalImages: items.length,
      queuedImages: toQueue.length,
      skippedImages: skipped.length,
      jobItems,
    });

    if (createJobError || !jobDoc) {
      return reply.status(500).send({
        success: false,
        message: createJobError || "Failed to create restore job in database",
      });
    }

    const queueResults = await Promise.all(
      toQueue.map((entry) =>
        imageRestoreQueue.add(
          "restore-image",
          {
            jobUuid,
            job_type: jobType,
            storeHash,
            storeUrl,
            accessToken,
            productId: entry.productId,
            imageId: entry.imageId,
            overrides: entry.overrides,
          },
          {
            removeOnComplete: 200,
            removeOnFail: 500,
            attempts: 2,
            backoff: { type: "exponential", delay: 5000 },
          }
        )
      )
    );

    const jobs = queueResults.map((bullJob, i) => ({
      index: toQueue[i].index,
      jobId: bullJob.id,
      image_id: toQueue[i].imageId,
      product_id: toQueue[i].productId,
    }));

    if (skipped.length > 0) {
      const { error: skipLogError } = await writeRestoreLogs(
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
        console.error("[queueBulkRestoreJobs] skip logs:", skipLogError);
      }
    }

    const { error: statusError, job: jobRecord } = await getRestoreJobStatus(
      jobUuid,
      storeHash
    );

    if (statusError) {
      console.error("[queueBulkRestoreJobs] status fetch:", statusError);
    }

    const responseData = {
      job_uuid: jobUuid,
      job_type: jobType,
      queue: "image-restore",
      total_images: items.length,
      queued_images: jobs.length,
      skipped_images: skipped.length,
      job: jobRecord,
      jobs,
      skipped,
    };

    if (req.restoreFetchMeta) {
      responseData.catalog = req.restoreFetchMeta;
    }

    return reply.status(202).send({
      success: true,
      message: "Bulk image restore jobs queued",
      data: responseData,
    });
  } catch (error) {
    console.error("[queueBulkRestoreJobs] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to queue bulk restore",
    });
  }
}
