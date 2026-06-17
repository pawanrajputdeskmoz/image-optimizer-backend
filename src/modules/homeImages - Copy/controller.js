const crypto = require("crypto");
const config = require("../../config");
const { parseChannelId } = require("../../utils/channelContext");
const {
  buildBigCommerceError,
  fetchStoreOptimizationSettings,
  hasAnyOptimizationFeatureEnabled,
} = require("../imageOptimization/services");
const {
  optimizeHomeBannerImageSingle,
  fetchHomeImages,
  restoreHomeImageSingle,
  createHomeImageBulkJob,
  recordHomeJobItemResult,
  getHomeJobStatus,
  fetchRestorableHomeImages,
  fetchAllHomeImagesForBulk,
} = require("./services");
const { homeImageQueue } = require("../../queue/homeImageQueue");

// ─── Fetch all home images ────────────────────────────────────────────────────

exports.getHomeImages = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const accessToken = req.currentUser?.access_token || req.accessToken;
    const channelId = parseChannelId(req.query) || req.channelId || 1;

    if (!storeHash || !accessToken) {
      return reply.status(401).send({ success: false, message: "Unauthorized." });
    }

    const result = await fetchHomeImages(
      storeHash,
      accessToken,
      channelId,
      req.currentUser?.storeUrl || null
    );

    return reply.send({
      success: true,
      message: "Homepage images fetched from BigCommerce.",
      count: result.count,
      sources: result.sources,
      v3_capabilities: result.v3_capabilities,
      non_v3_sources: result.non_v3_sources,
      summary: result.summary,
      errors: result.errors,
      data: result.data,
    });
  } catch (error) {
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

// ─── Single optimize ──────────────────────────────────────────────────────────

exports.optimizeHomeBannerImageSingle = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;
    const accessToken = req.currentUser?.access_token || req.accessToken;
    const channelId = parseChannelId(body) || req.channelId || 1;

    if (!storeHash || !accessToken) {
      return reply.status(401).send({ success: false, message: "Unauthorized." });
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

    const result = await optimizeHomeBannerImageSingle({
      storeHash,
      accessToken,
      channelId,
      recordId: body.id || body.record_id || null,
      sourceType: body.source_type || null,
      sourceKey: body.source_key || null,
      originalUrl: body.original_url || null,
      sourceId: body.source_id || null,
      imagePath: body.image_path || null,
      widgetUuid: body.widget_uuid || null,
      isUpdateSupported:
        typeof body.is_update_supported === "boolean"
          ? body.is_update_supported
          : null,
      metadata: body.metadata || null,
      quality: Number(settings.image_quality),
      maxWidth: config.image.optimizeMaxDimension,
      outputFormat: settings.output_format,
      force: body.force === true || body.force_reoptimize === true || body.reoptimize === true,
      optimizeOnly: body.optimize_only === true,
      storeUrl: req.currentUser?.storeUrl || null,
    });

    if (!result.success) {
      return reply.status(result.status || 400).send({
        success: false,
        message: result.message,
        data: result.data || null,
      });
    }

    return reply.send({
      success: true,
      skipped: Boolean(result.skipped),
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

// ─── Restore single ───────────────────────────────────────────────────────────

exports.restoreHomeImage = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;
    const accessToken = req.currentUser?.access_token || req.accessToken;
    const channelId = parseChannelId(body) || req.channelId || 1;

    if (!storeHash || !accessToken) {
      return reply.status(401).send({ success: false, message: "Unauthorized." });
    }

    const result = await restoreHomeImageSingle({
      storeHash,
      accessToken,
      channelId,
      recordId: body.id || body.record_id || null,
      sourceType: body.source_type || null,
      sourceKey: body.source_key || null,
    });

    if (!result.success) {
      return reply.status(result.status || 400).send({
        success: false,
        skipped: Boolean(result.skipped),
        message: result.message,
        data: result.data || null,
      });
    }

    return reply.send({
      success: true,
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

// ─── Bulk optimize (checkbox) ─────────────────────────────────────────────────

exports.bulkOptimizeHomeImagesCheckbox = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;
    const accessToken = req.currentUser?.access_token || req.accessToken;
    const channelId = parseChannelId(body) || req.channelId || 1;
    const images = Array.isArray(body.images) ? body.images : [];
    const force = body.force === true || body.force_reoptimize === true;

    if (!storeHash || !accessToken) {
      return reply.status(401).send({ success: false, message: "Unauthorized." });
    }

    if (images.length === 0) {
      return reply.status(400).send({ success: false, message: "No images provided." });
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
        message: "No image optimization features are enabled in store settings.",
      });
    }

    const jobUuid = crypto.randomUUID();
    const { error: jobError } = await createHomeImageBulkJob({
      jobUuid,
      storeHash,
      channelId,
      jobType: "checkBox",
      totalImages: images.length,
      queuedImages: images.length,
    });

    if (jobError) {
      return reply.status(500).send({ success: false, message: `Failed to create job: ${jobError}` });
    }

    const jobPayloads = images.map((img) => ({
      name: jobUuid,
      data: {
        jobUuid,
        job_type: "checkBox",
        storeHash,
        accessToken,
        channelId,
        sourceType: img.source_type,
        sourceKey: img.source_key,
        sourceId: img.source_id || null,
        sourceName: img.source_name || null,
        context: img.context || null,
        isUpdateSupported: img.is_update_supported ?? true,
        originalUrl: img.original_url,
        widgetUuid: img.widget_uuid || null,
        widgetName: img.widget_name || null,
        imagePath: img.image_path || null,
        metadata: img.metadata || null,
        quality: Number(settings.image_quality),
        maxWidth: config.image.optimizeMaxDimension,
        outputFormat: settings.output_format,
        force,
      },
      opts: { attempts: 2, backoff: { type: "fixed", delay: 3000 } },
    }));

    await homeImageQueue.addBulk(jobPayloads);

    return reply.send({
      success: true,
      message: `Queued ${images.length} home image(s) for optimization.`,
      data: {
        job_uuid: jobUuid,
        queued: images.length,
      },
    });
  } catch (error) {
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

// ─── Bulk optimize (all) ──────────────────────────────────────────────────────

exports.bulkOptimizeHomeImagesAll = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;
    const accessToken = req.currentUser?.access_token || req.accessToken;
    const channelId = parseChannelId(body) || req.channelId || 1;
    const force = body.force === true || body.force_reoptimize === true;

    if (!storeHash || !accessToken) {
      return reply.status(401).send({ success: false, message: "Unauthorized." });
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
        message: "No image optimization features are enabled in store settings.",
      });
    }

    const { items, errors } = await fetchAllHomeImagesForBulk(
      storeHash,
      accessToken,
      channelId,
      req.currentUser?.storeUrl || null,
      { skipOptimized: !force }
    );

    if (items.length === 0) {
      return reply.send({
        success: true,
        message: "No home images found that require optimization.",
        data: { queued: 0, fetch_errors: errors },
      });
    }

    const jobUuid = crypto.randomUUID();
    const { error: jobError } = await createHomeImageBulkJob({
      jobUuid,
      storeHash,
      channelId,
      jobType: "bulk",
      totalImages: items.length,
      queuedImages: items.length,
    });

    if (jobError) {
      return reply.status(500).send({ success: false, message: `Failed to create job: ${jobError}` });
    }

    const jobPayloads = items.map((img) => ({
      name: jobUuid,
      data: {
        jobUuid,
        job_type: "bulk",
        storeHash,
        accessToken,
        channelId,
        sourceType: img.source_type,
        sourceKey: img.source_key,
        sourceId: img.source_id || null,
        sourceName: img.source_name || null,
        context: img.context || null,
        isUpdateSupported: img.is_update_supported ?? true,
        originalUrl: img.original_url,
        widgetUuid: img.widget_uuid || null,
        widgetName: img.widget_name || null,
        imagePath: img.image_path || null,
        metadata: img.metadata || null,
        quality: Number(settings.image_quality),
        maxWidth: config.image.optimizeMaxDimension,
        outputFormat: settings.output_format,
        force,
      },
      opts: { attempts: 2, backoff: { type: "fixed", delay: 3000 } },
    }));

    await homeImageQueue.addBulk(jobPayloads);

    return reply.send({
      success: true,
      message: `Queued ${items.length} home image(s) for optimization.`,
      data: {
        job_uuid: jobUuid,
        queued: items.length,
        fetch_errors: errors,
      },
    });
  } catch (error) {
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

// ─── Bulk restore (all optimized) ────────────────────────────────────────────

exports.bulkRestoreHomeImagesAll = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;
    const accessToken = req.currentUser?.access_token || req.accessToken;
    const channelId = parseChannelId(body) || req.channelId || 1;

    if (!storeHash || !accessToken) {
      return reply.status(401).send({ success: false, message: "Unauthorized." });
    }

    const restorableImages = await fetchRestorableHomeImages(storeHash, channelId);

    if (restorableImages.length === 0) {
      return reply.send({
        success: true,
        message: "No optimized home images found to restore.",
        data: { restored: 0, failed: 0, results: [] },
      });
    }

    const results = [];
    let restored = 0;
    let failed = 0;

    for (const img of restorableImages) {
      const result = await restoreHomeImageSingle({
        storeHash,
        accessToken,
        channelId,
        recordId: String(img._id),
      });

      results.push({
        source_key: img.source_key,
        source_type: img.source_type,
        success: result.success,
        message: result.message,
      });

      if (result.success) {
        restored++;
      } else {
        failed++;
      }
    }

    return reply.send({
      success: true,
      message: `Restored ${restored} home image(s). ${failed > 0 ? `${failed} failed.` : ""}`.trim(),
      data: { restored, failed, results },
    });
  } catch (error) {
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

// ─── Bulk restore (checkbox) ──────────────────────────────────────────────────

exports.bulkRestoreHomeImagesCheckbox = async (req, reply) => {
  try {
    const body = req.body || {};
    const storeHash = req.storeHash;
    const accessToken = req.currentUser?.access_token || req.accessToken;
    const channelId = parseChannelId(body) || req.channelId || 1;
    const images = Array.isArray(body.images) ? body.images : [];

    if (!storeHash || !accessToken) {
      return reply.status(401).send({ success: false, message: "Unauthorized." });
    }

    if (images.length === 0) {
      return reply.status(400).send({ success: false, message: "No images provided." });
    }

    const results = [];
    let restored = 0;
    let failed = 0;

    for (const img of images) {
      const result = await restoreHomeImageSingle({
        storeHash,
        accessToken,
        channelId,
        recordId: img.id || img.record_id || null,
        sourceType: img.source_type || null,
        sourceKey: img.source_key || null,
      });

      results.push({
        source_key: img.source_key || img.id,
        source_type: img.source_type,
        success: result.success,
        skipped: Boolean(result.skipped),
        message: result.message,
      });

      if (result.success) {
        restored++;
      } else {
        failed++;
      }
    }

    return reply.send({
      success: true,
      message: `Restored ${restored} home image(s). ${failed > 0 ? `${failed} failed.` : ""}`.trim(),
      data: { restored, failed, results },
    });
  } catch (error) {
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};

// ─── Job status ───────────────────────────────────────────────────────────────

exports.getHomeOptimizationJob = async (req, reply) => {
  try {
    const { job_uuid } = req.params;
    const storeHash = req.storeHash;

    if (!job_uuid) {
      return reply.status(400).send({ success: false, message: "job_uuid is required." });
    }

    const { error, job } = await getHomeJobStatus(job_uuid, storeHash);

    if (error) {
      return reply.status(500).send({ success: false, message: error });
    }

    if (!job) {
      return reply.status(404).send({ success: false, message: "Job not found." });
    }

    return reply.send({
      success: true,
      data: job,
    });
  } catch (error) {
    const bcError = buildBigCommerceError(error);
    return reply.status(bcError.status).send(bcError.body);
  }
};
