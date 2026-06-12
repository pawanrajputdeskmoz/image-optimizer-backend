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
} = require("./services");

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
