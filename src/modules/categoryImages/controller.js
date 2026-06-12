const crypto = require("node:crypto");
const { User, CategoryImage, CategoryImageStatus } = require("../../models");
const { performance } = require("perf_hooks");
const config = require("../../config");
const { parseChannelId, resolveChannelSiteUrl } = require("../../utils/channelContext");
const {
  buildBigCommerceError,
  normalizePagination,
} = require("../imageOptimization/services");
const {
  fetchCategoryImages,
  optimizeCategoryImageSingle,
  restoreCategoryImageSingle,
  getAlreadyOptimizedCategoryIdSet,
  createCategoryBulkJob,
  writeCategorySkipLogs,
  getCategoryJobStatus,
} = require("./services");
const {
  fetchStoreOptimizationSettings,
} = require("../imageOptimization/services");
const { categoryImageQueue } = require("../../queue/categoryImageQueue");

function normalizeCategoryPagination(body = {}) {
  const { page } = normalizePagination(body);
  const rawLimit = parseInt(body.limit, 10);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(250, rawLimit)
      : Math.min(250, config.catalog.pageSize);

  return { page, limit };
}

exports.fetchAllCategories = async (req, reply) => {
  const apiStart = performance.now();

  try {
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

    const { page, limit } = normalizeCategoryPagination(body);

    const query = req.query || {};
    const search =
      typeof query.search === "string" ? query.search.trim() : "";

    const rawTreeId = body.tree_id;
    const treeId =
      rawTreeId != null &&
      Number.isFinite(Number(rawTreeId)) &&
      Number(rawTreeId) > 0
        ? Number(rawTreeId)
        : null;

    const user = await User.findOne(
      { store_hash: storeHash },
      { storeUrl: 1, access_token: 1, _id: 0 }
    ).lean();

    if (!user) {
      return reply.status(404).send({
        success: false,
        message: "Store is not installed",
      });
    }

    const accessToken = req.accessToken || req.currentUser?.access_token || null;

    if (typeof accessToken !== "string" || accessToken.trim() === "") {
      return reply.status(401).send({
        success: false,
        message: "Access token missing",
      });
    }

    const imageBaseUrl = await resolveChannelSiteUrl(
      storeHash,
      channelId,
      accessToken,
      user.storeUrl || null
    );

    const bcStart = performance.now();
    const result = await fetchCategoryImages({
      storeHash,
      accessToken,
      channelId,
      page,
      limit,
      treeId,
      search,
      imageBaseUrl,
    });
    const bcEnd = performance.now();

    console.log(
      `[BigCommerce API] category trees/categories ${(bcEnd - bcStart).toFixed(2)} ms`
    );

    const apiEnd = performance.now();
    console.log(
      `[fetchAllCategories] Total API Time: ${(apiEnd - apiStart).toFixed(2)} ms`
    );

    return reply.status(200).send({
      success: true,
      message: "Categories fetched successfully",
      data: result.categories,
      pagination: result.pagination,
    });
  } catch (error) {
    console.error("[fetchAllCategories ERROR]", error);

    const bcError = buildBigCommerceError(error);
    if (bcError.body?.message?.includes("products")) {
      bcError.body.message = bcError.body.message.replace(
        "products",
        "categories"
      );
    }

    return reply.status(bcError.status).send(bcError.body);
  }
};

exports.getCategoryPreviewImgData = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;

    const categoryId = Number(body.category_id);

    if (!Number.isFinite(categoryId) || categoryId <= 0) {
      return reply.status(400).send({
        success: false,
        message: "category_id is required and must be a positive number",
      });
    }

    const query = { store_hash: storeHash, category_id: categoryId };

    const [categoryImage, categoryImageStatus] = await Promise.all([
      CategoryImage.findOne(query)
        .select({
          store_hash: 1,
          channel_id: 1,
          tree_id: 1,
          category_id: 1,
          category_name: 1,
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

      CategoryImageStatus.findOne(query)
        .select({
          store_hash: 1,
          channel_id: 1,
          category_id: 1,
          status: 1,
          image_update_status: 1,
          original_url: 1,
          optimized_url: 1,
          optimization_started_at: 1,
          optimized_at: 1,
          created_at: 1,
          updated_at: 1,
        })
        .lean(),
    ]);

    if (!categoryImage && !categoryImageStatus) {
      return reply.status(404).send({
        success: false,
        message: "Category image preview data not found",
      });
    }

    const originalPath = categoryImage?.original_image_path || null;
    const optimizedPath = categoryImage?.optimized_image_path || null;

    return reply.status(200).send({
      success: true,
      data: {
        category_id: categoryId,
        category_name: categoryImage?.category_name ?? null,
        channel_id: categoryImage?.channel_id ?? categoryImageStatus?.channel_id ?? null,
        tree_id: categoryImage?.tree_id ?? categoryImageStatus?.tree_id ?? null,
        status: categoryImageStatus
          ? {
              optimization_status: categoryImageStatus.status || "pending",
              image_update_status: categoryImageStatus.image_update_status || "pending",
              optimization_started_at: categoryImageStatus.optimization_started_at || null,
              optimized_at: categoryImageStatus.optimized_at || null,
            }
          : null,
        imageData: categoryImage
          ? {
              original: categoryImage.original || { size: null, width: null, height: null, format: null },
              optimized: categoryImage.optimized || { size: null, width: null, height: null, format: null },
              saved_bytes: categoryImage.saved_bytes ?? null,
              saved_percentage: categoryImage.saved_percentage ?? null,
              original_url: categoryImage.original_url || null,
              optimized_url: categoryImage.optimized_url || null,
            }
          : null,
        files: {
          original: originalPath,
          optimized: optimizedPath,
        },
      },
    });
  } catch (error) {
    console.error("[getCategoryPreviewImgData ERROR]", error);

    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to fetch category preview image data",
    });
  }
};

exports.optimizeCategory = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;
    const channelId = parseChannelId(body) || 1;
    const categoryId = req.params.category_id ?? body.category_id;
    const accessToken = req.accessToken || req.currentUser?.access_token || null;

    if (!storeHash) {
      return reply.status(400).send({
        success: false,
        message: "store_hash is required in body or query",
      });
    }

    if (!categoryId || !Number.isFinite(Number(categoryId)) || Number(categoryId) <= 0) {
      return reply.status(400).send({
        success: false,
        message: "category_id is required and must be a positive number",
      });
    }

    if (typeof accessToken !== "string" || accessToken.trim() === "") {
      return reply.status(401).send({
        success: false,
        message: "Access token missing",
      });
    }

    const { error: settingError, settings } = await fetchStoreOptimizationSettings(
      storeHash,
      channelId
    );

    if (settingError) {
      return reply.status(500).send({
        success: false,
        message: settingError,
      });
    }

    if (settings.optimize_image_enabled === false) {
      return reply.status(400).send({
        success: false,
        message: "Image optimization is disabled in store settings",
        data: { settings },
      });
    }

    const rawTreeId = body.tree_id;
    const treeId =
      rawTreeId != null &&
      Number.isFinite(Number(rawTreeId)) &&
      Number(rawTreeId) > 0
        ? Number(rawTreeId)
        : null;

    const forceReoptimize =
      body.force === true ||
      body.force_reoptimize === true ||
      body.reoptimize === true;

    const result = await optimizeCategoryImageSingle({
      storeHash,
      accessToken,
      channelId,
      treeId,
      categoryId: Number(categoryId),
      imageUrl: body.image_url || null,
      categoryName: body.category_name || null,
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
    console.error("[optimizeCategory ERROR]", error);
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

exports.restoreCategory = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;
    const accessToken = req.accessToken || req.currentUser?.access_token || null;

    const channelId = parseChannelId(body);
    const categoryId = Number(body.category_id);

    if (!storeHash) {
      return reply.status(400).send({
        success: false,
        message: "store_hash is required",
      });
    }

    if (!channelId) {
      return reply.status(400).send({
        success: false,
        message: "channel_id is required and must be a positive number",
      });
    }

    if (!Number.isFinite(categoryId) || categoryId <= 0) {
      return reply.status(400).send({
        success: false,
        message: "category_id is required and must be a positive number",
      });
    }

    if (typeof accessToken !== "string" || accessToken.trim() === "") {
      return reply.status(401).send({
        success: false,
        message: "Access token missing",
      });
    }

    const rawTreeId = body.tree_id;
    const treeId =
      rawTreeId != null &&
      Number.isFinite(Number(rawTreeId)) &&
      Number(rawTreeId) > 0
        ? Number(rawTreeId)
        : null;

    console.log("[restoreCategory] START", { storeHash, channelId, categoryId, treeId });

    const result = await restoreCategoryImageSingle({
      storeHash,
      accessToken,
      channelId,
      categoryId,
      treeId,
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
      message: "Category image restored successfully",
      data: result.data,
    });
  } catch (error) {
    console.error("[restoreCategory ERROR]", error);
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

/** Checkbox-selected categories → job_type `checkBox` */
exports.bulkCategoryOptimizationCheckbox = (req, reply) =>
  queueBulkCategoryJobs(req, reply, "checkBox");

/** GET job status by job_uuid */
exports.getCategoryOptimizationJob = async (req, reply) => {
  try {
    const jobUuid = req.params.job_uuid;
    if (!jobUuid) {
      return reply.status(400).send({
        success: false,
        message: "job_uuid is required",
      });
    }

    const { error: statusError, job, logs, items } = await getCategoryJobStatus(
      jobUuid,
      req.storeHash
    );

    if (statusError) {
      return reply.status(500).send({
        success: false,
        message: statusError,
      });
    }

    if (!job && (!logs || logs.length === 0)) {
      return reply.status(404).send({
        success: false,
        message: "Category optimization job not found",
      });
    }

    return reply.status(200).send({
      success: true,
      data: { job, logs, items },
    });
  } catch (error) {
    console.error("[getCategoryOptimizationJob] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to fetch category optimization job",
    });
  }
};

//=======================================================
// Private helper — mirrors queueBulkImageJobs in imageOptimization/controller.js
//=======================================================

async function queueBulkCategoryJobs(req, reply, jobType) {
  try {
    const items = Array.isArray(req.body) ? req.body : req.body?.categories;

    if (!Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({
        success: false,
        message: "Request body must include a non-empty `categories` array",
      });
    }

    const storeHash = req.storeHash;
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

    if (settings.optimize_image_enabled === false) {
      return reply.status(400).send({
        success: false,
        message: "Image optimization is disabled in store settings",
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
      : await getAlreadyOptimizedCategoryIdSet(storeHash, items);

    for (let index = 0; index < items.length; index++) {
      const item = items[index] || {};
      const shop = item.shop != null ? String(item.shop).trim() : "";
      const categoryId = item.category_id;
      const imageUrlRaw = item.image_url;
      const categoryName = item.category_name || null;
      const rawTreeId = item.tree_id;
      const treeId =
        rawTreeId != null && Number.isFinite(Number(rawTreeId)) && Number(rawTreeId) > 0
          ? Number(rawTreeId)
          : null;

      const pushSkipped = (reason, extra = {}) => {
        skipped.push({
          index,
          reason,
          category_id: categoryId ?? null,
          ...extra,
        });
        if (categoryId != null && categoryId !== "") {
          jobItems.push({
            job_uuid: jobUuid,
            store_hash: storeHash,
            job_type: jobType,
            category_id: Number(categoryId),
            tree_id: treeId,
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

      if (categoryId == null || categoryId === "") {
        pushSkipped("category_id is required");
        continue;
      }

      if (!imageUrlRaw || !String(imageUrlRaw).trim()) {
        pushSkipped("image_url is required");
        continue;
      }

      const imageUrl = String(imageUrlRaw).trim();

      const clientStatus = String(item.optimization_status || item.status || "").toLowerCase();
      const alreadyOptimizedOnClient = ["optimized", "optimizing"].includes(clientStatus);

      if (!forceReoptimize && (skipOptimizedIds.has(Number(categoryId)) || alreadyOptimizedOnClient)) {
        pushSkipped("Category image is already optimized or currently optimizing");
        continue;
      }

      jobItems.push({
        job_uuid: jobUuid,
        store_hash: storeHash,
        job_type: jobType,
        category_id: Number(categoryId),
        tree_id: treeId,
        image_url: imageUrl,
        status: "queued",
      });

      toQueue.push({
        index,
        categoryId: Number(categoryId),
        treeId,
        imageUrl,
        categoryName,
        channelId: parseChannelId(item) || channelId,
        optimization_status: item.optimization_status || item.status || null,
      });
    }

    // ── Persist job + item records ──────────────────────────────────────────
    const { error: createJobError, doc: jobDoc } = await createCategoryBulkJob({
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
        message: createJobError || "Failed to create category optimization job in database",
      });
    }

    // ── Write skip warning logs ─────────────────────────────────────────────
    if (skipped.length > 0) {
      const { error: skipLogError } = await writeCategorySkipLogs(
        skipped.map((s) => ({
          job_uuid: jobUuid,
          store_hash: storeHash,
          channel_id: channelId,
          tree_id: s.tree_id ?? null,
          job_type: jobType,
          category_id: s.category_id,
          reason: s.reason,
          index: s.index,
        }))
      );
      if (skipLogError) {
        console.error("[queueBulkCategoryJobs] skip logs:", skipLogError);
      }
    }

    // ── Push each category into BullMQ ──────────────────────────────────────
    const queueResults = await Promise.all(
      toQueue.map((entry) =>
        categoryImageQueue.add(
          "optimize-category",
          {
            jobUuid,
            job_type: jobType,
            storeHash,
            accessToken,
            channelId: entry.channelId,
            treeId: entry.treeId,
            categoryId: entry.categoryId,
            imageUrl: entry.imageUrl,
            categoryName: entry.categoryName,
            optimization_status: entry.optimization_status,
            settings,
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
      category_id: toQueue[i].categoryId,
    }));

    // ── Fetch fresh job record for the response ─────────────────────────────
    const { error: statusError, job: jobRecord } = await getCategoryJobStatus(
      jobUuid,
      storeHash
    );
    if (statusError) {
      console.error("[queueBulkCategoryJobs] status fetch:", statusError);
    }

    return reply.status(202).send({
      success: true,
      message: "Bulk category optimization queued",
      data: {
        job_uuid: jobUuid,
        job_type: jobType,
        queue: "category-image-optimization",
        total_categories: items.length,
        queued_categories: jobs.length,
        skipped_categories: skipped.length,
        settings: {
          optimize_image_enabled: Boolean(settings.optimize_image_enabled),
          image_quality: settings.image_quality,
          output_format: settings.output_format,
        },
        job: jobRecord,
        jobs,
        skipped,
      },
    });
  } catch (error) {
    console.error("[queueBulkCategoryJobs] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to queue bulk category optimization",
    });
  }
}
