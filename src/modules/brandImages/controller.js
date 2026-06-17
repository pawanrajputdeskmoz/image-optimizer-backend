const crypto = require("node:crypto");
const { User, BrandImage, BrandImageStatus } = require("../../models");
const { performance } = require("perf_hooks");
const config = require("../../config");
const {
  fetchBrandImages,
  optimizeBrandImageSingle,
  restoreBrandImageSingle,
  getAlreadyOptimizedBrandIdSet,
  createBrandBulkJob,
  getBrandJobStatus,
  writeBrandSkipLogs,
} = require("./services");
const {
  normalizePagination,
  buildBigCommerceError,
  fetchStoreOptimizationSettings,
  hasAnyOptimizationFeatureEnabled,
} = require("../imageOptimization/services");
const { parseChannelId } = require("../../utils/channelContext");
const { brandImageQueue } = require("../../queue/brandImageQueue");

exports.fetchAllBrands = async (req, reply) => {
  const apiStart = performance.now();

  try {
    const body = req.body || {};
    const storeHash = req.storeHash;

    if (!storeHash) {
      return reply.status(400).send({
        success: false,
        message: "store_hash is required in body or query",
      });
    }

    const { page, limit } = normalizePagination(body);

    const searchKeyword =
      typeof req.query?.search === "string"
        ? req.query.search.trim()
        : "";

    const user = await User.findOne(
      { store_hash: storeHash },
      { storeUrl: 1, _id: 0 }
    ).lean();

    if (!user) {
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

    const bcStart = performance.now();

    const result = await fetchBrandImages({
      storeHash,
      accessToken,
      storeUrl: user.storeUrl || null,
      page,
      limit,
      search: searchKeyword,
    });

    console.log(
      `[BigCommerce API] brands ${(performance.now() - bcStart).toFixed(2)} ms`
    );

    console.log(
      `[fetchAllBrands] Total API Time: ${(performance.now() - apiStart).toFixed(2)} ms`
    );

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

/**
 * POST /bulk-optimize-brands-checkbox
 * Accepts an array of brand objects and enqueues each one for optimization.
 */
exports.bulkBrandOptimizationCheckbox = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const accessToken = req.accessToken || req.currentUser?.access_token;

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    const body = req.body || {};
    const channelId = parseChannelId(body) || 1;
    const rawItems = Array.isArray(body.brands) ? body.brands : [];

    if (rawItems.length === 0) {
      return reply.status(400).send({
        success: false,
        message: "brands array is required and must not be empty",
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

    // Normalize incoming items
    const validItems = [];
    const invalidItems = [];

    for (const item of rawItems) {
      const brandId = Number(item?.brand_id ?? item?.brandId);
      const imageUrl = String(item?.image_url ?? item?.imageUrl ?? "").trim();

      if (!Number.isFinite(brandId) || brandId <= 0) {
        invalidItems.push({ raw: item, reason: "brand_id is missing or invalid" });
        continue;
      }

      if (!imageUrl) {
        invalidItems.push({ brand_id: brandId, reason: "image_url is missing" });
        continue;
      }

      validItems.push({
        brand_id: brandId,
        image_url: imageUrl,
        brand_name: item?.brand_name ?? item?.name ?? null,
        optimization_status: item?.optimization_status ?? item?.status ?? null,
      });
    }

    if (validItems.length === 0) {
      return reply.status(400).send({
        success: false,
        message: "No valid brand items to queue",
        data: { invalid_items: invalidItems },
      });
    }

    // Skip already-optimized brands
    const alreadyOptimizedIds = await getAlreadyOptimizedBrandIdSet(
      storeHash,
      validItems
    );

    const toQueue = [];
    const skippedItems = [];

    for (const item of validItems) {
      if (alreadyOptimizedIds.has(item.brand_id)) {
        skippedItems.push({
          brand_id: item.brand_id,
          reason: "Brand image is already optimized",
        });
      } else {
        toQueue.push(item);
      }
    }

    const jobUuid = crypto.randomUUID();
    const totalImages = validItems.length;
    const queuedImages = toQueue.length;
    const skippedImages = skippedItems.length;

    // Build job item documents (one per queued brand)
    const jobItems = toQueue.map((item) => ({
      job_uuid: jobUuid,
      store_hash: storeHash,
      job_type: "checkBox",
      brand_id: item.brand_id,
      image_url: item.image_url,
      status: "queued",
    }));

    // Persist job record + items
    const { error: jobError } = await createBrandBulkJob({
      jobUuid,
      storeHash,
      jobType: "checkBox",
      totalImages,
      queuedImages,
      skippedImages,
      jobItems,
    });

    if (jobError) {
      return reply.status(500).send({
        success: false,
        message: `Failed to create brand optimization job: ${jobError}`,
      });
    }

    if (skippedItems.length > 0) {
      const { error: skipLogError } = await writeBrandSkipLogs(
        skippedItems.map((s, index) => ({
          job_uuid: jobUuid,
          store_hash: storeHash,
          job_type: "checkBox",
          brand_id: s.brand_id,
          reason: s.reason,
          index,
        }))
      );
      if (skipLogError) {
        console.error("[bulkBrandOptimizationCheckbox] skip logs:", skipLogError);
      }
    }

    if (toQueue.length > 0) {
      const BrandImageJobLog = require("../../models/BrandImageJobLog");
      await BrandImageJobLog.insertMany(
        toQueue.map((item, index) => ({
          job_uuid: jobUuid,
          store_hash: storeHash,
          source_type: "brand",
          job_type: "checkBox",
          brand_id: item.brand_id,
          log_type: "info",
          step: "queue",
          message: "Brand image queued for optimization",
          meta: { index, image_url: item.image_url },
        })),
        { ordered: false }
      );
    }

    // Enqueue each brand image job
    const bullJobs = toQueue.map((item) => ({
      name: "optimize-brand",
      data: {
        jobUuid,
        job_type: "checkBox",
        storeHash,
        accessToken,
        brandId: item.brand_id,
        imageUrl: item.image_url,
        brandName: item.brand_name,
        settings,
        optimization_status: item.optimization_status,
      },
      opts: {
        removeOnComplete: 50,
        removeOnFail: 100,
        attempts: 2,
        backoff: { type: "exponential", delay: 2000 },
      },
    }));

    await brandImageQueue.addBulk(bullJobs);

    return reply.status(202).send({
      success: true,
      message: `Brand image optimization started. ${queuedImages} queued, ${skippedImages} skipped.`,
      data: {
        job_uuid: jobUuid,
        job_type: "checkBox",
        status: "processing",
        total_images: totalImages,
        queued_images: queuedImages,
        skipped_images: skippedImages,
        skipped_details: skippedItems,
        invalid_items: invalidItems,
      },
    });
  } catch (error) {
    console.error("[bulkBrandOptimizationCheckbox] Error:", error);
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

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

    const { error, job, logs, items } = await getBrandJobStatus(jobUuid, req.storeHash);

    if (error) {
      return reply.status(500).send({ success: false, message: error });
    }

    if (!job) {
      return reply.status(404).send({
        success: false,
        message: "Brand optimization job not found",
      });
    }

    return reply.status(200).send({ success: true, data: { job, logs, items } });
  } catch (error) {
    console.error("[getBrandOptimizationJob] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to fetch brand optimization job",
    });
  }
};
