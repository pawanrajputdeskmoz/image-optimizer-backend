const StoreOptimizationSettings = require("../../models/StoreOptimizationSettings");
const { get } = require("../../utils/axiosUtils");
const config = require("../../config");

exports.getChannels = async (req, reply) => {
  const { storeHash, accessToken } = req;

  const headers = {
    "X-Auth-Token": accessToken,
    Accept: "application/json",
  };

  const requestConfig = {
    timeout: config.api.bigCommerceTimeoutMs,
  };

  try {
    const channelQuery = new URLSearchParams({
      "type:in": "storefront",
      "status:in": "active,prelaunch,connected",
      limit: "250",
    }).toString();

    const response = await get(
      `https://api.bigcommerce.com/stores/${storeHash}/v3/channels?${channelQuery}`,
      headers,
      requestConfig
    );

    const rawChannels = Array.isArray(response?.data) ? response.data : [];

    const channels = [];

    for (const channel of rawChannels) {
      try {
        const siteResponse = await get(
          `https://api.bigcommerce.com/stores/${storeHash}/v3/channels/${channel.id}/site`,
          headers,
          requestConfig
        );

        const site = siteResponse?.data;
        if (!site?.id) continue;

        channels.push({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          platform: channel.platform,
          status: channel.status,
          site_id: site?.id || null,
          url: site?.url || "",
        });
      } catch {
        // skip channels without a valid site
      }
    }

    const defaultChannel = channels.find((ch) => ch.id === 1) || null;

    return reply.send({
      success: true,
      message: channels.length ? "Channels loaded" : "No channels found",
      data: channels,
      default: defaultChannel
        ? {
            channel_id: defaultChannel.id,
            site_id: defaultChannel.site_id,
            platform: defaultChannel.platform,
          }
        : null,
    });
  } catch (error) {
    const status = error?.response?.status || 500;

    const message =
      error?.response?.data?.title ||
      error?.response?.data?.message ||
      error?.message ||
      "Failed to fetch channels from BigCommerce";

    return reply.status(status).send({
      success: false,
      message,
    });
  }
};

exports.getStoreOptimizationSettings = async (req, reply) => {
  const store_hash = req.storeHash;
  const channelId = Number(req.query?.channel_id) || 1;

  const doc = await StoreOptimizationSettings.findOne({
    store_hash,
    channel_id: channelId,
  }).lean();

  if (!doc) {
    return reply.send({
      success: true,
      message: "No saved settings yet",
      data: null,
    });
  }

  return reply.send({
    success: true,
    message: "Settings loaded",
    data: doc,
  });
};

const ALLOWED_KEYS = new Set([
  "channel_id",
  "optimize_image_enabled",
  "is_filename_template_enabled",
  "filename_template",
  "is_alt_text_template_enabled",
  "alt_text_template",
  "image_quality",
  "output_format",
  "auto_optimize_new_images",
]);

exports.upsertStoreOptimizationSettings = async (req, reply) => {
  const store_hash = req.storeHash;
  const body = req.body || {};
  const channelId = Number(body.channel_id) || 1;

  const $set = { store_hash, channel_id: channelId };
  for (const key of ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (key === "channel_id") continue;
    $set[key] = body[key];
  }

  const doc = await StoreOptimizationSettings.findOneAndUpdate(
    { store_hash, channel_id: channelId },
    { $set },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    }
  );

  return reply.send({
    success: true,
    message: "Settings saved",
    data: doc.toObject(),
  });
};
