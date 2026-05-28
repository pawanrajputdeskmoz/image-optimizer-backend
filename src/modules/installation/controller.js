const {
  exchangeOAuthToken,
  saveInstalledStore,
  getManageAppRedirectUrl,
  syncUserStoreFromBigCommerce,
  verifySignedPayloadJwt,
  signAppApiToken,
} = require("./services");
const { get } = require("../../utils/axiosUtils");

const { User , StoreOptimizationSettings} = require("../../models");

exports.installApp = async (req, reply) => {
  const { code, context, scope } = req.query;

  console.log("[STORE-CONTROLLER] installApp called ------ ");

  if (!code || !context || !scope) {
    return reply.status(400).send({
      success: false,
      message:
        "Missing required parameters: code, context, and scope are required",
    });
  }

  try {
    console.log("start 0")
    const data = await exchangeOAuthToken({ code, scope, context });

    const { access_token, user, context: storeHashData } = data;
    const storeHash = storeHashData?.replace("stores/", "") || null;
    console.log("start end", data)

    if (!storeHash) {
      return reply.status(400).send({
        success: false,
        message: "Invalid OAuth context: store hash missing",
      });
    }

    console.log("start")
    const storeInfoResponse = await get(
      `https://api.bigcommerce.com/stores/${storeHash}/v2/store`,
      {
        "X-Auth-Token": access_token,
        Accept: "application/json",
        "Content-Type": "application/json",
      }
    );
    const storeInfo = storeInfoResponse?.data || {};

    console.log("end")



    await saveInstalledStore({
      storeHash,
      access_token,
      user,
      scope,
      storeInfo,
    });

    console.log("check point 3 ");

    console.log(
      "[STORE-CONTROLLER] app installed successfully ------ ",
      storeInfo.name
    );
    console.log(
      "[STORE-CONTROLLER] Redirecting to BigCommerce dashboard ------ ",
      getManageAppRedirectUrl(storeHash)
    );

    await StoreOptimizationSettings.create({
      store_hash: storeHash,
      optimize_image_enabled: true,
      is_filename_template_enabled: false,
      filename_template: "[name]",
      is_alt_text_template_enabled: false,
      alt_text_template: "[name]",
      image_quality: 80,
      output_format: "jpeg",
      auto_optimize_new_images: true,
    });

    return reply.redirect(getManageAppRedirectUrl(storeHash));
  } catch (err) {
    console.error("[STORE-CONTROLLER] Install app failed:", {
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
  const { signed_payload } = req.query;

  if (!signed_payload) {
    return reply.status(400).send("Missing signed_payload_jwt");
  }

  try {
    const payload = verifySignedPayloadJwt(signed_payload);
    console.log("getting this is payload", payload);
    const { storeHash } = payload;

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
    console.error(" uninstall failed:", err);
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

    const api_token = signAppApiToken(storeHash, userInfo.access_token,);

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
