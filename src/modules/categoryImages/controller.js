const crypto = require("node:crypto");
const { CategoryImage, CategoryImageStatus } = require("../../models");
const config = require("../../config");
const { parseChannelId, resolveChannelSiteUrl } = require("../../utils/channelContext");
const { resolvePreviewUrl } = require("../../utils/previewUrls");
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
  fetchAllCategoryImagesInChunks,
  fetchRestorableCategoriesForStore,
  registerPendingCategoryImages,
} = require("./services");
const {
  fetchStoreOptimizationSettings,
} = require("../imageOptimization/services");
const { categoryImageQueue } = require("../../queue/categoryImageQueue");
const { defaultWorkerJobOptions } = require("../../queue/workerJobOptions");
const {
  replyIfBulkOptimizationBlocked,
  buildBulkQueuedMessage,
  isFullBulkOptimizationJobType,
} = require("../../utils/bulkOptimizationGuard");
const {
  replyIfBulkRestoreBlocked,
  buildBulkRestoreQueuedMessage,
} = require("../../utils/bulkRestoreGuard");
const { categoryImageRestoreQueue } = require("../../queue/categoryImageRestoreQueue");
const {
  canOptimizeImages,
  buildPlanLimitApiBody,
} = require("../plans/service");
const { notifyPlanLimitReached } = require("../../utils/planLimitNotify");

function normalizeCategoryPagination(body = {}) {
  return normalizePagination(body, {
    maxLimit: config.pagination.categoryMaxLimit,
  });
}

exports.fetchAllCategories = async (req, reply) => {
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

    if (!req.currentUser) {
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
      req.currentUser.storeUrl || null
    );

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

    const originalUrl = resolvePreviewUrl(
      req,
      originalPath,
      categoryImage?.original_url,
    );
    const optimizedUrl = resolvePreviewUrl(
      req,
      optimizedPath,
      categoryImage?.optimized_url,
    );

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
              original_url: originalUrl,
              optimized_url: optimizedUrl,
            }
          : null,
        files: {
          original: originalPath,
          optimized: optimizedPath,
        },
        urls: {
          original: originalUrl,
          optimized: optimizedUrl,
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

/** Checkbox-selected categories → job_type `restore_checkbox` */
exports.bulkRestoreCategoriesCheckbox = (req, reply) =>
  queueBulkCategoryRestoreJobs(req, reply, "restore_checkbox");

/** Full-store restore: all restorable optimized category images → job_type `restore_bulk` */
exports.bulkRestoreCategoriesAll = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const accessToken = req.accessToken || req.currentUser?.access_token;

    if (!accessToken || !String(accessToken).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing for this store",
      });
    }

    const items = await fetchRestorableCategoriesForStore(storeHash);

    req.restoreFetchMeta = { restorable_categories: items.length };
    return queueBulkCategoryRestoreJobs(req, reply, "restore_bulk", items);
  } catch (error) {
    console.error("[bulkRestoreCategoriesAll] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to queue bulk category image restore",
    });
  }
};

/** Full-store: fetch all BC category images (chunked) → queue job_type `bulk` */
exports.bulkCategoryOptimizationAll = async (req, reply) => {
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

    const { error: settingError, settings } = await fetchStoreOptimizationSettings(storeHash, channelId);
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

    const { error: catalogError, items, meta } = await fetchAllCategoryImagesInChunks({
      storeHash,
      accessToken,
      channelId,
    });

    if (catalogError) {
      const bcError = buildBigCommerceError(new Error(catalogError));
      return reply.status(bcError.status).send(bcError.body);
    }

    req.catalogFetchMeta = meta;
    return queueBulkCategoryJobs(req, reply, "bulk", items);
  } catch (error) {
    console.error("[bulkCategoryOptimizationAll] Error:", error);
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

    const { error: statusError, job, logs, items, items_pagination } =
      await getCategoryJobStatus(jobUuid, req.storeHash, {
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
        message: "Category optimization job not found",
      });
    }

    return reply.status(200).send({
      success: true,
      data: { job, logs, items, items_pagination },
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

async function queueBulkCategoryJobs(req, reply, jobType, itemsOverride = null) {
  try {
    const items = itemsOverride ?? (Array.isArray(req.body) ? req.body : req.body?.categories);

    if (!Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({
        success: false,
        message: itemsOverride
          ? "No category images found in store catalog to queue for optimization"
          : "Request body must include a non-empty `categories` array",
      });
    }

    const storeHash = req.storeHash;

    const quota = await canOptimizeImages(
      storeHash,
      req.currentUser?.selectedPlan || "free",
      1
    );
    if (!quota.allowed) {
      await notifyPlanLimitReached(storeHash, {
        message: quota.message,
        planName: quota.plan_name || quota.plan?.name || null,
        monthlyLimit: quota.monthly_limit ?? null,
        monthlyUsed: quota.monthly_used ?? null,
      }).catch(() => {});
      return reply.status(403).send(buildPlanLimitApiBody(quota));
    }

    if (
      isFullBulkOptimizationJobType(jobType) &&
      (await replyIfBulkOptimizationBlocked(reply, storeHash, "category"))
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
      const currentlyOptimizingOnClient = clientStatus === "optimizing";

      if (!forceReoptimize && (skipOptimizedIds.has(Number(categoryId)) || currentlyOptimizingOnClient)) {
        pushSkipped("Category image is currently being optimized");
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
        message: createJobError || "Failed to create category optimization job in database",
      });
    }

    if (toQueue.length > 0) {
      await registerPendingCategoryImages(
        storeHash,
        toQueue.map((entry) => ({
          category_id: entry.categoryId,
          channel_id: entry.channelId,
          tree_id: entry.treeId,
        })),
        req.currentUser?._id
      );
    }

    // ── Write skip warning logs ─────────────────────────────────────────────
    if (skipped.length > 0) {
      const { error: skipLogError } = await writeCategorySkipLogs(
        skipped.map((s) => ({
          user_id: req.currentUser?._id,
          job_id: jobDoc._id,
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
            userId: req.currentUser?._id,
            jobId: jobDoc._id,
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
          defaultWorkerJobOptions()
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

    const responseData = {
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
    };

    if (req.catalogFetchMeta) {
      responseData.catalog = req.catalogFetchMeta;
    }

    return reply.status(202).send({
      success: true,
      message: buildBulkQueuedMessage("category"),
      data: {
        ...responseData,
        entity_type: "category",
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

//=======================================================
// Private helper — bulk category image restore queue
//=======================================================

async function queueBulkCategoryRestoreJobs(req, reply, jobType, itemsOverride = null) {
  try {
    const items = itemsOverride ?? (Array.isArray(req.body?.categories) ? req.body.categories : []);

    if (!Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({
        success: false,
        message: itemsOverride
          ? "No restorable category images found for this store"
          : "Request body must include a non-empty `categories` array",
      });
    }

    const storeHash = req.storeHash;

    // Full restore_bulk stays blocked if any restore/optimize is active.
    // restore_checkbox mirrors checkBox optimize — overlapping checkbox restores allowed.
    if (
      jobType === "restore_bulk" &&
      (await replyIfBulkRestoreBlocked(reply, storeHash, "category"))
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

    const channelId = parseChannelId(req.body) || 1;
    const jobUuid = crypto.randomUUID();
    const skipped = [];
    const toQueue = [];
    const jobItems = [];

    for (let index = 0; index < items.length; index++) {
      const item = items[index] || {};
      const shop = item.shop != null ? String(item.shop).trim() : "";
      const categoryId = item.category_id;
      const rawTreeId = item.tree_id;
      const treeId =
        rawTreeId != null && Number.isFinite(Number(rawTreeId)) && Number(rawTreeId) > 0
          ? Number(rawTreeId)
          : null;
      const itemChannelId = item.channel_id ? Number(item.channel_id) : channelId;

      const pushSkipped = (reason) => {
        skipped.push({ index, reason, category_id: categoryId ?? null });
        if (categoryId != null && categoryId !== "") {
          jobItems.push({
            job_uuid: jobUuid,
            store_hash: storeHash,
            job_type: jobType,
            category_id: Number(categoryId),
            tree_id: treeId,
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

      jobItems.push({
        job_uuid: jobUuid,
        store_hash: storeHash,
        job_type: jobType,
        category_id: Number(categoryId),
        tree_id: treeId,
        status: "queued",
      });

      toQueue.push({
        index,
        categoryId: Number(categoryId),
        treeId,
        channelId: itemChannelId,
      });
    }

    // ── Persist job + item records ──────────────────────────────────────────
    const { error: createJobError, doc: jobDoc } = await createCategoryBulkJob({
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
        message: createJobError || "Failed to create category restore job in database",
      });
    }

    // ── Write skip warning logs ─────────────────────────────────────────────
    if (skipped.length > 0) {
      const { error: skipLogError } = await writeCategorySkipLogs(
        skipped.map((s) => ({
          user_id: req.currentUser?._id,
          job_id: jobDoc._id,
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
        console.error("[queueBulkCategoryRestoreJobs] skip logs:", skipLogError);
      }
    }

    // ── Push each category into BullMQ ──────────────────────────────────────
    const queueResults = await Promise.all(
      toQueue.map((entry) =>
        categoryImageRestoreQueue.add(
          "restore-category",
          {
            jobUuid,
            userId: req.currentUser?._id,
            jobId: jobDoc._id,
            job_type: jobType,
            storeHash,
            accessToken,
            channelId: entry.channelId,
            treeId: entry.treeId,
            categoryId: entry.categoryId,
          },
          defaultWorkerJobOptions()
        )
      )
    );

    const jobs = queueResults.map((bullJob, i) => ({
      index: toQueue[i].index,
      jobId: bullJob.id,
      category_id: toQueue[i].categoryId,
    }));

    // ── Fetch fresh job record for the response ─────────────────────────────
    const { error: statusError, job: jobRecord } = await getCategoryJobStatus(jobUuid, storeHash);
    if (statusError) {
      console.error("[queueBulkCategoryRestoreJobs] status fetch:", statusError);
    }

    const responseData = {
      job_uuid: jobUuid,
      job_type: jobType,
      queue: "category-image-restore",
      total_categories: items.length,
      queued_categories: jobs.length,
      skipped_categories: skipped.length,
      job: jobRecord,
      jobs,
      skipped,
    };

    if (req.restoreFetchMeta) {
      responseData.catalog = req.restoreFetchMeta;
    }

    return reply.status(202).send({
      success: true,
      message: buildBulkRestoreQueuedMessage("category"),
      data: {
        ...responseData,
        entity_type: "category",
      },
    });
  } catch (error) {
    console.error("[queueBulkCategoryRestoreJobs] Error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to queue bulk category image restore",
    });
  }
}
