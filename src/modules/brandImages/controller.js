const crypto = require("node:crypto");
const { BrandImage, BrandImageStatus } = require("../../models");
const config = require("../../config");
const {
  fetchBrandImages,
  fetchAllBrandImagesInChunks,
  optimizeBrandImageSingle,
  restoreBrandImageSingle,
  fetchRestorableBrandsForStore,
  getAlreadyOptimizedBrandIdSet,
  createBrandBulkJob,
  getBrandJobStatus,
  writeBrandSkipLogs,
  purgeStaleBrandOptimizationIfBackupMissing,
  registerPendingBrandImages,
} = require("./services");
const {
  normalizePagination,
  buildBigCommerceError,
  fetchStoreOptimizationSettings,
  hasAnyOptimizationFeatureEnabled,
} = require("../imageOptimization/services");
const { parseChannelId } = require("../../utils/channelContext");
const { brandImageQueue } = require("../../queue/brandImageQueue");
const { brandImageRestoreQueue } = require("../../queue/brandImageRestoreQueue");
const {
  replyIfBulkOptimizationBlocked,
  buildBulkQueuedMessage,
  isFullBulkOptimizationJobType,
} = require("../../utils/bulkOptimizationGuard");
const {
  replyIfBulkRestoreBlocked,
  buildBulkRestoreQueuedMessage,
} = require("../../utils/bulkRestoreGuard");
const { defaultWorkerJobOptions } = require("../../queue/workerJobOptions");

exports.fetchAllBrands = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;

    if (!storeHash) {
      return reply.status(400).send({
        success: false,
        message: "store_hash is required in body or query",
      });
    }

    const { page, limit } = normalizePagination(body, {
      maxLimit: config.pagination.brandMaxLimit,
    });

    const searchKeyword =
      typeof req.query?.search === "string"
        ? req.query.search.trim()
        : "";

    if (!req.currentUser) {
      return reply.status(404).send({
        success: false,
        message: "Store is not installed. User not found for this store_hash",
      });
    }

    const accessToken = req.accessToken || req.currentUser?.access_token || null;

    if (typeof accessToken !== "string" || accessToken.trim() === "") {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    const result = await fetchBrandImages({
      storeHash,
      accessToken,
      storeUrl: req.currentUser.storeUrl || null,
      page,
      limit,
      search: searchKeyword,
    });

    return reply.status(200).send({
      success: true,
      message: "Brands fetched successfully",
      data: result.brands,
      pagination: result.pagination,
    });
  } catch (error) {
    console.error("[fetchAllBrands ERROR]", error);

    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

exports.getBrandPreviewImgData = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;

    const brandId = Number(body.brand_id);

    if (!Number.isFinite(brandId) || brandId <= 0) {
      return reply.status(400).send({
        success: false,
        message: "brand_id is required and must be a positive number",
      });
    }

    const query = { store_hash: storeHash, brand_id: brandId };

    await purgeStaleBrandOptimizationIfBackupMissing({ storeHash, brandId });

    const [brandImage, brandImageStatus] = await Promise.all([
      BrandImage.findOne(query)
        .select({
          store_hash: 1,
          brand_id: 1,
          brand_name: 1,
          original_url: 1,
          optimized_url: 1,
          original_image_path: 1,
          optimized_image_path: 1,
          original: 1,
          optimized: 1,
          saved_bytes: 1,
          saved_percentage: 1,
          created_at: 1,
          updated_at: 1,
        })
        .lean(),

      BrandImageStatus.findOne(query)
        .select({
          store_hash: 1,
          brand_id: 1,
          status: 1,
          image_update_status: 1,
          optimization_started_at: 1,
          optimized_at: 1,
          created_at: 1,
          updated_at: 1,
        })
        .lean(),
    ]);

    if (!brandImage && !brandImageStatus) {
      return reply.status(404).send({
        success: false,
        message: "Brand image preview data not found",
      });
    }

    const originalPath = brandImage?.original_image_path || null;
    const optimizedPath = brandImage?.optimized_image_path || null;

    return reply.status(200).send({
      success: true,
      data: {
        brand_id: brandId,
        brand_name: brandImage?.brand_name ?? null,
        status: brandImageStatus
          ? {
              optimization_status: brandImageStatus.status || "pending",
              image_update_status: brandImageStatus.image_update_status || "pending",
              optimization_started_at: brandImageStatus.optimization_started_at || null,
              optimized_at: brandImageStatus.optimized_at || null,
            }
          : null,
        imageData: brandImage
          ? {
              original: brandImage.original || { size: null, width: null, height: null, format: null },
              optimized: brandImage.optimized || { size: null, width: null, height: null, format: null },
              saved_bytes: brandImage.saved_bytes ?? null,
              saved_percentage: brandImage.saved_percentage ?? null,
              original_url: brandImage.original_url || null,
              optimized_url: brandImage.optimized_url || null,
            }
          : null,
        files: {
          original: originalPath,
          optimized: optimizedPath,
        },
      },
    });
  } catch (error) {
    console.error("[getBrandPreviewImgData ERROR]", error);

    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to fetch brand preview image data",
    });
  }
};

exports.restoreBrand = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;
    const accessToken = req.accessToken || req.currentUser?.access_token || null;
    const brandId = Number(body.brand_id);

    if (!storeHash) {
      return reply.status(400).send({
        success: false,
        message: "store_hash is required",
      });
    }

    if (!Number.isFinite(brandId) || brandId <= 0) {
      return reply.status(400).send({
        success: false,
        message: "brand_id is required and must be a positive number",
      });
    }

    if (typeof accessToken !== "string" || accessToken.trim() === "") {
      return reply.status(401).send({
        success: false,
        message: "Access token missing",
      });
    }

    const result = await restoreBrandImageSingle({
      storeHash,
      accessToken,
      brandId,
    });

    if (!result.success) {
      const status = result.skipped ? (result.statusCode || 400) : (result.statusCode || 500);
      return reply.status(status).send({
        success: false,
        message: result.error,
        data: result.data || null,
      });
    }

    return reply.status(200).send({
      success: true,
      message: "Brand image restored successfully",
      data: result.data,
    });
  } catch (error) {
    console.error("[restoreBrand ERROR]", error);
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

exports.optimizeBrand = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;
    const channelId = parseChannelId(body) || 1;

    const brandId = req.params.brand_id ?? body.brand_id;

    if (!brandId || !Number.isFinite(Number(brandId)) || Number(brandId) <= 0) {
      return reply.status(400).send({
        success: false,
        message: "brand_id is required and must be a positive number",
      });
    }

    const accessToken = req.accessToken || req.currentUser?.access_token || null;
    if (typeof accessToken !== "string" || accessToken.trim() === "") {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    const { error: settingError, settings } = await fetchStoreOptimizationSettings(
      storeHash,
      channelId
    );
    if (settingError) {
      return reply.status(500).send({ success: false, message: settingError });
    }

    if (settings.optimize_image_enabled === false) {
      return reply.status(400).send({
        success: false,
        message: "Image optimization is disabled in store settings",
        data: { settings },
      });
    }

    const forceReoptimize =
      body.force === true ||
      body.force_reoptimize === true ||
      body.reoptimize === true;

    const result = await optimizeBrandImageSingle({
      storeHash,
      accessToken,
      brandId: Number(brandId),
      imageUrl: body.image_url || null,
      brandName: body.brand_name || null,
      settings,
      force: forceReoptimize,
      clientStatus: body.optimization_status || body.status || "",
    });

    if (!result.success) {
      return reply.status(result.status || 500).send({
        success: false,
        message: result.message,
        data: result.data || null,
      });
    }

    return reply.status(200).send({
      success: true,
      skipped: Boolean(result.skipped),
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    console.error("[optimizeBrand ERROR]", error);
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

/** Full-store: fetch all BC brand images (chunked) → queue job_type `bulk` */
exports.bulkBrandOptimizationAll = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const accessToken = req.accessToken || req.currentUser?.access_token;
    const channelId = parseChannelId(req.body) || 1;

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    const { error: settingError, settings } = await fetchStoreOptimizationSettings(
      storeHash,
      channelId
    );
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

    const forceReoptimize =
      req.body?.force === true ||
      req.body?.force_reoptimize === true ||
      req.body?.reoptimize === true;

    const { error: catalogError, items, meta } = await fetchAllBrandImagesInChunks({
      storeHash,
      accessToken,
      skipOptimized: !forceReoptimize,
    });

    if (catalogError) {
      const bcError = buildBigCommerceError(new Error(catalogError));
      return reply.status(bcError.status).send(bcError.body);
    }

    req.catalogFetchMeta = meta;
    return queueBulkBrandJobs(req, reply, "bulk", items);
  } catch (error) {
    console.error("[bulkBrandOptimizationAll] Error:", error);
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

/** Checkbox-selected brands → job_type `checkBox` */
exports.bulkBrandOptimizationCheckbox = (req, reply) =>
  queueBulkBrandJobs(req, reply, "checkBox");

/**
 * GET /brand-job/:job_uuid
 * Poll job status + item-level progress.
 */
exports.getBrandOptimizationJob = async (req, reply) => {
  try {
    const jobUuid = req.params.job_uuid;
    if (!jobUuid) {
      return reply.status(400).send({ success: false, message: "job_uuid is required" });
    }

    const { error, job, logs, items, items_pagination } = await getBrandJobStatus(
      jobUuid,
      req.storeHash,
      {
        itemPage: req.query?.item_page,
        itemLimit: req.query?.item_limit,
        itemAfter: req.query?.item_after,
      }
    );

    if (error) {
      return reply.status(500).send({ success: false, message: error });
    }

    if (!job) {
      return reply.status(404).send({
        success: false,
        message: "Brand optimization job not found",
      });
    }

    return reply
      .status(200)
      .send({ success: true, data: { job, logs, items, items_pagination } });
  } catch (error) {
    console.error("[getBrandOptimizationJob] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to fetch brand optimization job",
    });
  }
};

/** Checkbox-selected brands → job_type `restore_checkbox` */
exports.bulkRestoreBrandsCheckbox = (req, reply) =>
  queueBulkBrandRestoreJobs(req, reply, "restore_checkbox");

/** Full-store restore: all restorable optimized brand images → job_type `restore_bulk` */
exports.bulkRestoreBrandsAll = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const accessToken = req.accessToken || req.currentUser?.access_token;

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    const items = await fetchRestorableBrandsForStore(storeHash);

    req.restoreFetchMeta = { restorable_brands: items.length };
    return queueBulkBrandRestoreJobs(req, reply, "restore_bulk", items);
  } catch (error) {
    console.error("[bulkRestoreBrandsAll] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to queue bulk brand image restore",
    });
  }
};

async function queueBulkBrandJobs(req, reply, jobType, itemsOverride = null) {
  try {
    const items = itemsOverride ?? (Array.isArray(req.body?.brands) ? req.body.brands : []);

    if (!Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({
        success: false,
        message: itemsOverride
          ? "No brand images found in store catalog to queue for optimization"
          : "Request body must include a non-empty `brands` array",
      });
    }

    const storeHash = req.storeHash;

    if (
      isFullBulkOptimizationJobType(jobType) &&
      (await replyIfBulkOptimizationBlocked(reply, storeHash, "brand"))
    ) {
      return;
    }

    const accessToken = req.accessToken || req.currentUser?.access_token;

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    const channelId = parseChannelId(items[0]) || parseChannelId(req.body) || 1;

    const { error: settingError, settings } = await fetchStoreOptimizationSettings(
      storeHash,
      channelId
    );
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
      : await getAlreadyOptimizedBrandIdSet(storeHash, items);

    for (let index = 0; index < items.length; index++) {
      const item = items[index] || {};
      const shop = item.shop != null ? String(item.shop).trim() : "";
      const brandId = item.brand_id ?? item.brandId;
      const imageUrlRaw = item.image_url ?? item.imageUrl;
      const brandName = item.brand_name ?? item.name ?? null;

      const pushSkipped = (reason) => {
        skipped.push({
          index,
          reason,
          brand_id: brandId ?? null,
        });
        if (brandId != null && brandId !== "") {
          jobItems.push({
            job_uuid: jobUuid,
            store_hash: storeHash,
            job_type: jobType,
            brand_id: Number(brandId),
            image_url: imageUrlRaw ? String(imageUrlRaw).trim() : null,
            status: "skipped",
            skip_reason: reason,
          });
        }
      };

      if (shop && shop !== storeHash) {
        pushSkipped("shop does not match authenticated store");
        continue;
      }

      if (brandId == null || brandId === "") {
        pushSkipped("brand_id is required");
        continue;
      }

      if (!imageUrlRaw || !String(imageUrlRaw).trim()) {
        pushSkipped("image_url is required");
        continue;
      }

      const imageUrl = String(imageUrlRaw).trim();
      const clientStatus = String(item.optimization_status || item.status || "").toLowerCase();
      const alreadyOptimizedOnClient = ["optimized", "optimizing"].includes(clientStatus);

      if (
        !forceReoptimize &&
        (skipOptimizedIds.has(Number(brandId)) || alreadyOptimizedOnClient)
      ) {
        pushSkipped("Brand image is already optimized or currently optimizing");
        continue;
      }

      jobItems.push({
        job_uuid: jobUuid,
        store_hash: storeHash,
        job_type: jobType,
        brand_id: Number(brandId),
        image_url: imageUrl,
        status: "queued",
      });

      toQueue.push({
        index,
        brandId: Number(brandId),
        imageUrl,
        brandName,
        optimization_status: item.optimization_status || item.status || null,
      });
    }

    const { error: createJobError, doc: jobDoc } = await createBrandBulkJob({
      jobUuid,
      userId: req.currentUser?._id,
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
        message: createJobError || "Failed to create brand optimization job in database",
      });
    }

    if (toQueue.length > 0) {
      await registerPendingBrandImages(
        storeHash,
        toQueue.map((entry) => entry.brandId),
        req.currentUser?._id
      );
    }

    if (skipped.length > 0) {
      const { error: skipLogError } = await writeBrandSkipLogs(
        skipped.map((s) => ({
          user_id: req.currentUser?._id,
          job_id: jobDoc._id,
          job_uuid: jobUuid,
          store_hash: storeHash,
          job_type: jobType,
          brand_id: s.brand_id,
          reason: s.reason,
          index: s.index,
        }))
      );
      if (skipLogError) {
        console.error("[queueBulkBrandJobs] skip logs:", skipLogError);
      }
    }

    if (toQueue.length > 0) {
      const BrandImageJobLog = require("../../models/BrandImageJobLog");
      await BrandImageJobLog.insertMany(
        toQueue.map((entry) => ({
          user_id: req.currentUser?._id,
          job_id: jobDoc._id,
          job_uuid: jobUuid,
          store_hash: storeHash,
          source_type: "brand",
          job_type: jobType,
          brand_id: entry.brandId,
          log_type: "info",
          step: "queue",
          message: "Brand image queued for optimization",
          meta: { index: entry.index, image_url: entry.imageUrl },
        })),
        { ordered: false }
      );
    }

    const bullJobs = toQueue.map((entry) => ({
      name: "optimize-brand",
      data: {
        jobUuid,
        userId: req.currentUser?._id,
        jobId: jobDoc._id,
        job_type: jobType,
        storeHash,
        accessToken,
        brandId: entry.brandId,
        imageUrl: entry.imageUrl,
        brandName: entry.brandName,
        settings,
        optimization_status: entry.optimization_status,
      },
      opts: defaultWorkerJobOptions(),
    }));

    const queueResults =
      bullJobs.length > 0 ? await brandImageQueue.addBulk(bullJobs) : [];

    const jobs = queueResults.map((bullJob, i) => ({
      index: toQueue[i].index,
      jobId: bullJob.id,
      brand_id: toQueue[i].brandId,
    }));

    const { error: statusError, job: jobRecord } = await getBrandJobStatus(jobUuid, storeHash);
    if (statusError) {
      console.error("[queueBulkBrandJobs] status fetch:", statusError);
    }

    const responseData = {
      job_uuid: jobUuid,
      job_type: jobType,
      queue: "brand-image-optimization",
      total_brands: items.length,
      queued_brands: jobs.length,
      skipped_brands: skipped.length,
      settings: {
        optimize_image_enabled: Boolean(settings.optimize_image_enabled),
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
      message: buildBulkQueuedMessage("brand"),
      data: {
        ...responseData,
        entity_type: "brand",
      },
    });
  } catch (error) {
    console.error("[queueBulkBrandJobs] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to queue bulk brand optimization",
    });
  }
}

async function queueBulkBrandRestoreJobs(req, reply, jobType, itemsOverride = null) {
  try {
    const items = itemsOverride ?? (Array.isArray(req.body?.brands) ? req.body.brands : []);

    if (!Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({
        success: false,
        message: itemsOverride
          ? "No restorable brand images found for this store"
          : "Request body must include a non-empty `brands` array",
      });
    }

    const storeHash = req.storeHash;

    // Full restore_bulk stays blocked if any restore/optimize is active.
    // restore_checkbox mirrors checkBox optimize — overlapping checkbox restores allowed.
    if (
      jobType === "restore_bulk" &&
      (await replyIfBulkRestoreBlocked(reply, storeHash, "brand"))
    ) {
      return;
    }

    const accessToken = req.accessToken || req.currentUser?.access_token;

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    const jobUuid = crypto.randomUUID();
    const skipped = [];
    const toQueue = [];
    const jobItems = [];

    for (let index = 0; index < items.length; index++) {
      const item = items[index] || {};
      const shop = item.shop != null ? String(item.shop).trim() : "";
      const brandId = item.brand_id ?? item.brandId;

      const pushSkipped = (reason) => {
        skipped.push({ index, reason, brand_id: brandId ?? null });
        if (brandId != null && brandId !== "") {
          jobItems.push({
            job_uuid: jobUuid,
            store_hash: storeHash,
            job_type: jobType,
            brand_id: Number(brandId),
            status: "skipped",
            skip_reason: reason,
          });
        }
      };

      if (shop && shop !== storeHash) {
        pushSkipped("shop does not match authenticated store");
        continue;
      }

      if (brandId == null || brandId === "") {
        pushSkipped("brand_id is required");
        continue;
      }

      jobItems.push({
        job_uuid: jobUuid,
        store_hash: storeHash,
        job_type: jobType,
        brand_id: Number(brandId),
        status: "queued",
      });

      toQueue.push({
        index,
        brandId: Number(brandId),
      });
    }

    const { error: createJobError, doc: jobDoc } = await createBrandBulkJob({
      jobUuid,
      userId: req.currentUser?._id,
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
        message: createJobError || "Failed to create brand restore job in database",
      });
    }

    if (skipped.length > 0) {
      const { error: skipLogError } = await writeBrandSkipLogs(
        skipped.map((s) => ({
          user_id: req.currentUser?._id,
          job_id: jobDoc._id,
          job_uuid: jobUuid,
          store_hash: storeHash,
          job_type: jobType,
          brand_id: s.brand_id,
          reason: s.reason,
          index: s.index,
        }))
      );
      if (skipLogError) {
        console.error("[queueBulkBrandRestoreJobs] skip logs:", skipLogError);
      }
    }

    if (toQueue.length > 0) {
      const BrandImageJobLog = require("../../models/BrandImageJobLog");
      await BrandImageJobLog.insertMany(
        toQueue.map((entry, index) => ({
          user_id: req.currentUser?._id,
          job_id: jobDoc._id,
          job_uuid: jobUuid,
          store_hash: storeHash,
          source_type: "brand",
          job_type: jobType,
          brand_id: entry.brandId,
          log_type: "info",
          step: "queue",
          message: "Brand image queued for restore",
          meta: { index },
        })),
        { ordered: false }
      );
    }

    const queueResults = await Promise.all(
      toQueue.map((entry) =>
        brandImageRestoreQueue.add(
          "restore-brand",
          {
            jobUuid,
            userId: req.currentUser?._id,
            jobId: jobDoc._id,
            job_type: jobType,
            storeHash,
            accessToken,
            brandId: entry.brandId,
          },
          defaultWorkerJobOptions()
        )
      )
    );

    const jobs = queueResults.map((bullJob, i) => ({
      index: toQueue[i].index,
      jobId: bullJob.id,
      brand_id: toQueue[i].brandId,
    }));

    const { error: statusError, job: jobRecord } = await getBrandJobStatus(jobUuid, storeHash);
    if (statusError) {
      console.error("[queueBulkBrandRestoreJobs] status fetch:", statusError);
    }

    const responseData = {
      job_uuid: jobUuid,
      job_type: jobType,
      queue: "brand-image-restore",
      total_brands: items.length,
      queued_brands: jobs.length,
      skipped_brands: skipped.length,
      job: jobRecord,
      jobs,
      skipped,
    };

    if (req.restoreFetchMeta) {
      responseData.catalog = req.restoreFetchMeta;
    }

    return reply.status(202).send({
      success: true,
      message: buildBulkRestoreQueuedMessage("brand"),
      data: {
        ...responseData,
        entity_type: "brand",
      },
    });
  } catch (error) {
    console.error("[queueBulkBrandRestoreJobs] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to queue bulk brand image restore",
    });
  }
}
