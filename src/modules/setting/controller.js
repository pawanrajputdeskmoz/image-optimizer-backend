const StoreOptimizationSettings = require("../../models/StoreOptimizationSettings");
const { get } = require("../../utils/axiosUtils");
const config = require("../../config");
const {
  registerProductCreatedWebhook,
  disableProductWebhooks,
  registerCategoryCreatedWebhook,
  disableCategoryWebhooks,
  getClientDashboardStats,
  listActivePlans,
  selectClientPlan,
  upgradeClientPlan,
  getClientMonthlyUsageHistory,
} = require("./services");

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
  "optimization_mode",
  "optimize_image_enabled",
  "is_filename_template_enabled",
  "filename_template",
  "is_alt_text_template_enabled",
  "alt_text_template",
  "image_quality",
  "output_format",
  "product_sort_direction",
]);

exports.upsertStoreOptimizationSettings = async (req, reply) => {
  const store_hash = req.storeHash;
  const body = req.body || {};
  const channelId = Number(body.channel_id) || 1;

  const $set = {
    user_id: req.currentUser?._id,
    store_hash,
    channel_id: channelId,
  };
  for (const key of ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (key === "channel_id") continue;
    if (key === "product_sort_direction") {
      $set[key] = body[key] === "desc" ? "desc" : "asc";
      continue;
    }
    $set[key] = body[key];
  }

  // Enforce mode → feature flags before DB save.
  // optimize_and_alt: no forced overrides
  // optimize_only: alt text off
  // alt_only: image optimize + filename off; alt text must stay on
  const mode = String($set.optimization_mode || body.optimization_mode || "").trim();
  if (mode === "optimize_only") {
    $set.is_alt_text_template_enabled = false;
  } else if (mode === "alt_only") {
    if ($set.is_alt_text_template_enabled === false) {
      return reply.status(400).send({
        success: false,
        message:
          "Alt Text Template cannot be disabled when Optimization Mode is Generate Alt Text Only.",
      });
    }
    $set.optimize_image_enabled = false;
    $set.is_filename_template_enabled = false;
    $set.is_alt_text_template_enabled = true;
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

exports.registerProductCreatedWebhookHandler = async (req, reply) => {
  const { storeHash, accessToken } = req;

  if (!accessToken) {
    return reply.status(401).send({
      success: false,
      message: "Access token not found",
    });
  }

  try {
    const result = await registerProductCreatedWebhook({
      storeHash,
      accessToken,
      userId: req.currentUser?._id,
    });

    return reply.send({
      success: true,
      message: result.alreadyExists
        ? "Product webhooks are already registered"
        : "Product webhooks registered successfully",
      data: result,
    });
  } catch (error) {
    const status = error?.statusCode || error?.response?.status || 500;

    const message =
      error?.response?.data?.title ||
      error?.response?.data?.message ||
      error?.message ||
      "Failed to register product webhooks on BigCommerce";

    return reply.status(status).send({
      success: false,
      message,
    });
  }
};

exports.disableProductCreatedWebhookHandler = async (req, reply) => {
  const { storeHash, accessToken } = req;

  if (!accessToken) {
    return reply.status(401).send({
      success: false,
      message: "Access token not found",
    });
  }

  try {
    const result = await disableProductWebhooks({ storeHash, accessToken });

    return reply.send({
      success: true,
      message: result.notFound
        ? "No product webhooks were registered"
        : "Product webhooks disabled successfully",
      data: result,
    });
  } catch (error) {
    const status = error?.statusCode || error?.response?.status || 500;

    const message =
      error?.response?.data?.title ||
      error?.response?.data?.message ||
      error?.message ||
      "Failed to disable product webhooks on BigCommerce";

    return reply.status(status).send({
      success: false,
      message,
    });
  }
};

exports.registerCategoryCreatedWebhookHandler = async (req, reply) => {
  const { storeHash, accessToken } = req;

  if (!accessToken) {
    return reply.status(401).send({
      success: false,
      message: "Access token not found",
    });
  }

  try {
    const result = await registerCategoryCreatedWebhook({
      storeHash,
      accessToken,
      userId: req.currentUser?._id,
    });

    return reply.send({
      success: true,
      message: result.alreadyExists
        ? "Category webhooks are already registered"
        : "Category webhooks registered successfully",
      data: result,
    });
  } catch (error) {
    const status = error?.statusCode || error?.response?.status || 500;

    const message =
      error?.response?.data?.title ||
      error?.response?.data?.message ||
      error?.message ||
      "Failed to register category webhooks on BigCommerce";

    return reply.status(status).send({
      success: false,
      message,
    });
  }
};

exports.disableCategoryCreatedWebhookHandler = async (req, reply) => {
  const { storeHash, accessToken } = req;

  if (!accessToken) {
    return reply.status(401).send({
      success: false,
      message: "Access token not found",
    });
  }

  try {
    const result = await disableCategoryWebhooks({ storeHash, accessToken });

    return reply.send({
      success: true,
      message: result.notFound
        ? "No category webhooks were registered"
        : "Category webhooks disabled successfully",
      data: result,
    });
  } catch (error) {
    const status = error?.statusCode || error?.response?.status || 500;

    const message =
      error?.response?.data?.title ||
      error?.response?.data?.message ||
      error?.message ||
      "Failed to disable category webhooks on BigCommerce";

    return reply.status(status).send({
      success: false,
      message,
    });
  }
};

exports.getClientDashboardStatsHandler = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const selectedPlan = req.currentUser?.selectedPlan || "free";
    const { error, data } = await getClientDashboardStats(storeHash, selectedPlan);

    if (error) {
      return reply.status(500).send({
        success: false,
        message: error,
      });
    }

    return reply.send({
      success: true,
      message: "Dashboard stats loaded",
      data,
    });
  } catch (error) {
    console.error("[getClientDashboardStatsHandler]", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to load dashboard stats",
    });
  }
};

exports.listPlansHandler = async (req, reply) => {
  try {
    const { error, data } = await listActivePlans(req.storeHash);

    if (error) {
      return reply.status(500).send({
        success: false,
        message: error,
      });
    }

    return reply.send({
      success: true,
      message: "Plans loaded",
      data,
    });
  } catch (error) {
    console.error("[listPlansHandler]", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to load plans",
    });
  }
};

exports.getMonthlyUsageHistoryHandler = async (req, reply) => {
  try {
    const limit = Number(req.query?.limit) || 12;
    const { error, data } = await getClientMonthlyUsageHistory(req.storeHash, { limit });

    if (error) {
      return reply.status(500).send({
        success: false,
        message: error,
      });
    }

    return reply.send({
      success: true,
      message: "Monthly usage history loaded",
      data,
    });
  } catch (error) {
    console.error("[getMonthlyUsageHistoryHandler]", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to load monthly usage history",
    });
  }
};

exports.selectPlanHandler = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const planSlug = req.body?.plan_slug || req.body?.plan;

    if (!planSlug) {
      return reply.status(400).send({
        success: false,
        message: "plan_slug is required",
      });
    }

    const { error, data } = await selectClientPlan(storeHash, planSlug);

    if (error) {
      const status = error === "Plan not found or inactive" ? 404 : 400;
      return reply.status(status).send({
        success: false,
        message: error,
      });
    }

    return reply.send({
      success: true,
      message: "Plan updated successfully",
      data,
    });
  } catch (error) {
    console.error("[selectPlanHandler]", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to update plan",
    });
  }
};

exports.upgradePlanHandler = async (req, reply) => {
  try {
    const storeHash = req.storeHash;
    const planSlug = req.body?.plan_slug || req.body?.plan;

    if (!planSlug) {
      return reply.status(400).send({
        success: false,
        message: "plan_slug is required",
      });
    }

    const { error, code, data } = await upgradeClientPlan(storeHash, planSlug);

    if (error) {
      const statusByCode = {
        PLAN_NOT_FOUND: 404,
        STORE_NOT_FOUND: 404,
        SAME_PLAN: 409,
        NOT_AN_UPGRADE: 400,
      };
      const status = statusByCode[code] || 400;

      return reply.status(status).send({
        success: false,
        message: error,
        code,
        data: data || null,
      });
    }

    return reply.send({
      success: true,
      message: "Plan upgraded successfully",
      code,
      data,
    });
  } catch (error) {
    console.error("[upgradePlanHandler]", error);
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to upgrade plan",
    });
  }
};
