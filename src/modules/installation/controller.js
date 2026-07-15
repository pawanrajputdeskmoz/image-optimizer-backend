const {
  exchangeOAuthToken,
  saveInstalledStore,
  getManageAppRedirectUrl,
  syncUserStoreFromBigCommerce,
  verifySignedPayloadJwt,
  signAppApiToken,
} = require("./services");
const { get } = require("../../utils/axiosUtils");
const { trackProductWebhookBurst } = require("../imageOptimization/services");
const { trackCategoryWebhookBurst } = require("../categoryImages/services");
const { appendWebhookLog, upsertWebhookEvent } = require("./utils/webhookActivityLog");
const {
  appendCategoryWebhookLog,
  upsertCategoryWebhookEvent,
} = require("./utils/categoryWebhookActivityLog");
const { queueWelcomeEmail } = require("../../utils/mail/sendWelcomeEmail");
const { User, StoreOptimizationSettings } = require("../../models");

async function persistWebhookEvent(webhook, fields) {
  if (webhook?.isCategory || webhook?.entityType === "category") {
    return upsertCategoryWebhookEvent({
      traceId: webhook.traceId,
      storeHash: webhook.storeHash,
      eventHash: webhook.hash,
      scope: webhook.scope,
      categoryId: webhook.categoryId,
      storeId: fields.storeId,
      status: fields.status,
      payload: fields.payload ?? webhook.payload,
      errorMessage: fields.errorMessage ?? null,
    });
  }

  return upsertWebhookEvent({
    traceId: webhook.traceId,
    storeHash: webhook.storeHash,
    eventHash: webhook.hash,
    scope: webhook.scope,
    productId: webhook.productId,
    storeId: fields.storeId,
    status: fields.status,
    payload: fields.payload ?? webhook.payload,
    errorMessage: fields.errorMessage ?? null,
  });
}

async function persistWebhookLog(webhook, fields) {
  if (webhook?.isCategory || webhook?.entityType === "category") {
    return appendCategoryWebhookLog({
      traceId: fields.traceId ?? webhook.traceId,
      storeHash: fields.storeHash ?? webhook.storeHash,
      eventHash: fields.eventHash ?? webhook.hash,
      scope: fields.scope ?? webhook.scope,
      categoryId: fields.categoryId ?? webhook.categoryId,
      logType: fields.logType,
      step: fields.step,
      message: fields.message,
      meta: fields.meta,
    });
  }

  return appendWebhookLog({
    traceId: fields.traceId ?? webhook.traceId,
    storeHash: fields.storeHash ?? webhook.storeHash,
    eventHash: fields.eventHash ?? webhook.hash,
    scope: fields.scope ?? webhook.scope,
    productId: fields.productId ?? webhook.productId,
    imageId: fields.imageId,
    logType: fields.logType,
    step: fields.step,
    message: fields.message,
    meta: fields.meta,
  });
}

exports.installApp = async (req, reply) => {
  const { code, context, scope } = req.query;

  if (!code || !context || !scope) {
    return reply.status(400).send({
      success: false,
      message:
        "Missing required parameters: code, context, and scope are required",
    });
  }

  try {
    const data = await exchangeOAuthToken({ code, scope, context });

    const { access_token, user, context: storeHashData } = data;
    const storeHash = storeHashData?.replace("stores/", "") || null;

    if (!storeHash) {
      return reply.status(400).send({
        success: false,
        message: "Invalid OAuth context: store hash missing",
      });
    }

    const storeInfoResponse = await get(
      `https://api.bigcommerce.com/stores/${storeHash}/v2/store`,
      {
        "X-Auth-Token": access_token,
        Accept: "application/json",
        "Content-Type": "application/json",
      }
    );
    const storeInfo = storeInfoResponse?.data || {};

    await saveInstalledStore({
      storeHash,
      access_token,
      user,
      scope,
      storeInfo,
    });

    console.log("[install] completed", {
      storeHash,
      storeName: storeInfo.name || null,
    });

    // Reinstall-safe: keep existing settings; create defaults only if missing
    await StoreOptimizationSettings.findOneAndUpdate(
      { store_hash: storeHash, channel_id: 1 },
      {
        $setOnInsert: {
          store_hash: storeHash,
          channel_id: 1,
          optimize_image_enabled: true,
          is_filename_template_enabled: false,
          filename_template: "[name]",
          is_alt_text_template_enabled: false,
          alt_text_template: "[name]",
          image_quality: 80,
          output_format: "jpeg",
          auto_optimize_new_images: false,
          auto_optimize_new_category_images: false,
        },
      },
      { upsert: true }
    );

    queueWelcomeEmail({
      email: user?.email,
      storeName: storeInfo?.name || storeHash,
    });

    return reply.redirect(getManageAppRedirectUrl(storeHash));
  } catch (err) {
    console.error("[install] failed:", {
      message: err.message,
      status: err.response?.status,
      storeHash: req.query.context?.replace("stores/", "") || "unknown",
    });

    if (err.response?.status === 400 || err.response?.status === 401) {
      return reply.status(err.response.status).send({
        success: false,
        message: "Invalid OAuth credentials or authorization code",
        error: process.env.NODE_ENV === "development" ? err.message : undefined,
      });
    }

    return reply.status(500).send({
      success: false,
      message: "Failed to install app. Please try again.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

exports.uninstallApp = async (req, reply) => {
  const { signed_payload_jwt } = req.query;

  if (!signed_payload_jwt) {
    return reply.status(400).send("Missing signed_payload_jwt");
  }

  try {
    const payload = verifySignedPayloadJwt(signed_payload_jwt);
    const storeHash =
      payload?.store_hash ||
      (typeof payload?.sub === "string" ? payload.sub.split("/")[1] : null) ||
      null;

    if (!storeHash) {
      return reply.status(400).send("Invalid store hash in JWT");
    }

    await User.findOneAndUpdate(
      { store_hash: storeHash },
      {
        installStatus: "uninstalled",
        lastUninstalledAt: new Date(),
        access_token: null,
      }
    );

    return reply.status(200).send("OK");
  } catch (err) {
    console.error("[uninstall] failed:", err);
    return reply.status(401).send("Invalid JWT");
  }
};

exports.loadBigComApp = async (req, reply) => {
  try {
    const { signed_payload_jwt } = req.body;

    if (!signed_payload_jwt) {
      return reply.status(400).send({
        success: false,
        message: "Missing signed_payload_jwt",
      });
    }

    const decoded = verifySignedPayloadJwt(signed_payload_jwt, {
      expiresIn: "2d",
    });

    const storeHash = decoded?.sub?.split("/")[1];
    const user = decoded?.user;
    const owner = decoded?.owner;

    const userInfo = await User.findOne({ store_hash: storeHash }).lean();
    if (!userInfo) {
      return reply.status(404).send({
        success: false,
        message: "User not found",
      });
    }

    if (!userInfo.access_token || !String(userInfo.access_token).trim()) {
      return reply.status(401).send({
        success: false,
        message: "BigCommerce access token is missing. Please reinstall the app.",
      });
    }

    let syncedUser = userInfo;

    try {
      syncedUser = await syncUserStoreFromBigCommerce(
        storeHash,
        userInfo.access_token
      );
    } catch (bcErr) {
      console.error("[STORE-CONTROLLER] loadBigComApp store sync failed:", {
        message: bcErr.message,
        status: bcErr?.response?.status,
        storeHash,
      });

      return reply.status(bcErr?.response?.status === 401 ? 401 : 502).send({
        success: false,
        message: "Failed to refresh store details from BigCommerce",
        error:
          process.env.NODE_ENV === "development" ? bcErr.message : undefined,
      });
    }

    if (!syncedUser) {
      return reply.status(404).send({
        success: false,
        message: "User not found after store sync",
      });
    }

    const api_token = signAppApiToken(storeHash, userInfo.access_token);

    return reply.status(200).send({
      success: true,
      data: {
        api_token,
        storeHash,
        storeUrl: syncedUser.storeUrl || null,
        store_name: syncedUser.store_name || null,
        currency: syncedUser.currency || null,
        primaryDomain: syncedUser.primaryDomain || null,
        user,
        owner,
      },
    });
  } catch (error) {
    console.error("JWT Error:", error.message);

    return reply.status(401).send({
      success: false,
      message: "Invalid or expired token",
    });
  }
};

exports.handleProductWebhook = async (req, reply) => {
  const webhook = req.bigCommerceWebhook;

  try {
    if (webhook?.deduplicated) {
      return reply.status(200).send("OK");
    }

    const isProductScope = webhook?.scope?.startsWith("store/product/");
    const isCategoryScope = webhook?.scope?.startsWith("store/category/");

    if (!isProductScope && !isCategoryScope) {
      if (webhook) {
        await persistWebhookEvent(webhook, {
          storeId: webhook.payload?.store_id ? String(webhook.payload.store_id) : null,
          status: "scope_ignored",
        });
        await persistWebhookLog(webhook, {
          logType: "warning",
          step: "scope_ignored",
          message: "Webhook ignored because scope is not supported",
        });
      }
      return reply.status(200).send("OK");
    }

    const {
      storeHash,
      productId: numericProductId,
      categoryId: numericCategoryId,
      hash,
      scope,
      traceId,
      entityType,
    } = webhook;

    await persistWebhookLog(webhook, {
      traceId,
      storeHash,
      eventHash: hash,
      scope,
      productId: numericProductId,
      categoryId: numericCategoryId,
      step: "store_lookup",
      message: "Checking whether store is installed",
    });

    const user = await User.findOne({
      store_hash: storeHash,
      installStatus: "installed",
    })
      .select({ _id: 1 })
      .lean();

    if (!user) {
      await persistWebhookEvent(webhook, {
        storeId: webhook.payload?.store_id ? String(webhook.payload.store_id) : null,
        status: "store_not_found",
      });
      await persistWebhookLog(webhook, {
        traceId,
        storeHash,
        eventHash: hash,
        scope,
        productId: numericProductId,
        categoryId: numericCategoryId,
        logType: "warning",
        step: "store_not_found",
        message: "Webhook ignored because store is not installed",
      });
      return reply.status(200).send("OK");
    }

    if (entityType === "category") {
      await trackCategoryWebhookBurst(storeHash, numericCategoryId, {
        traceId,
        eventHash: hash,
        scope,
      });
    } else {
      await trackProductWebhookBurst(storeHash, numericProductId, {
        traceId,
        eventHash: hash,
        scope,
      });
    }

    await persistWebhookEvent(webhook, {
      storeId: webhook.payload?.store_id ? String(webhook.payload.store_id) : null,
      status: "accepted",
    });

    await persistWebhookLog(webhook, {
      traceId,
      storeHash,
      eventHash: hash,
      scope,
      productId: numericProductId,
      categoryId: numericCategoryId,
      step: "accepted",
      message: "Webhook accepted and added to burst tracker",
      meta: { entity_type: entityType },
    });

    console.log("[handleStoreWebhook] accepted", {
      storeHash,
      entityType,
      productId: numericProductId,
      categoryId: numericCategoryId,
      scope,
    });

    return reply.status(200).send("OK");
  } catch (error) {
    if (webhook) {
      await persistWebhookEvent(webhook, {
        storeId: webhook.payload?.store_id ? String(webhook.payload.store_id) : null,
        status: "failed",
        errorMessage: error.message,
      }).catch(() => {});
      await persistWebhookLog(webhook, {
        logType: "error",
        step: "failed",
        message: "Webhook handler failed",
        meta: { error: error.message },
      }).catch(() => {});
    }

    console.error("[handleStoreWebhook]", error.message);
    return reply.status(200).send("OK");
  }
};
