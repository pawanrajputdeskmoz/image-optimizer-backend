const { post, get } = require("../../utils/axiosUtils");
const { User } = require("../../models");
const jwt = require("jsonwebtoken");


exports.installApp = async (req, reply) => {
  const { code, context, scope } = req.query;


  console.log("[STORE-CONTROLLER] installApp called ------ ");

  // Validate required query parameters
  if (!code || !context || !scope) {
    return reply.status(400).send({
      success: false,
      message: "Missing required parameters: code, context, and scope are required"
    });
  }

  try {

    const data = await post("https://login.bigcommerce.com/oauth2/token", {
      client_id: process.env.BIG_COMMERCE_CLIENT_ID,
      client_secret: process.env.BIG_COMMERCE_CLIENT_SECRET,
      redirect_uri: `${process.env.REDIRECT_URI}/big-commerce/install`,
      grant_type: "authorization_code",
      code,
      scope,
      context,
    });




    const { access_token, user, context: storeHashData } = data;
    const storeHash = storeHashData?.replace("stores/", "");
    

    const storeInfo = await get(
      `https://api.bigcommerce.com/stores/${storeHash}/v2/store`,
      {
        "X-Auth-Token": access_token,
        "Accept": "application/json",
        "Content-Type": "application/json"
      }
    );

    const updatePayload = {
      access_token,
      lastInstalledAt: new Date(),
      installStatus: "installed",
      scope,
      email: user.email,
      username: `${storeInfo.first_name || ""} ${storeInfo.last_name || ""}`.trim(),
    };



    await User.findOneAndUpdate(
      { store_hash: storeHash },
      {
        $set: updatePayload,
        $setOnInsert: {
          provider: "bigcommerce",
          store_hash: storeHash,
          store_id: storeInfo.id,
        },
      },
      { upsert: true }
    );
    console.log("[STORE-CONTROLLER] app installed successfully ------ ", storeInfo.name);
    console.log("[STORE-CONTROLLER] Redirecting to BigCommerce dashboard ------ ", `https://store-${storeHash}.mybigcommerce.com/manage/app/${process.env.BIG_COMMERCE_APP_ID}`);

    console.log(`https://store-${storeHash}.mybigcommerce.com/manage/app/${process.env.BIG_COMMERCE_APP_ID}`)
    //  Redirect to BigCommerce dashboard
    return reply.redirect(
      `https://store-${storeHash}.mybigcommerce.com/manage/app/${process.env.BIG_COMMERCE_APP_ID}`
    );
  
  } catch (err) {

    console.error("[STORE-CONTROLLER] Install app failed:", {
      message: err.message,
      status: err.response?.status,
      storeHash: req.query.context?.replace("stores/", "") || "unknown"
    });

    // Handle specific error cases
    if (err.response?.status === 400 || err.response?.status === 401) {
      return reply.status(err.response.status).send({
        success: false,
        message: "Invalid OAuth credentials or authorization code",
        error: process.env.NODE_ENV === "development" ? err.message : undefined
      });
    }

    return reply.status(500).send({
      success: false,
      message: "Failed to install app. Please try again.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined
    });
  }
};

exports.uninstallApp = async (req, reply) => {
  const { signed_payload_jwt } = req.query;

  if (!signed_payload_jwt) {
    return reply.status(400).send("Missing signed_payload_jwt");
  }

  try {
    // Verify JWT
    const payload = jwt.verify(
      signed_payload_jwt,
      process.env.BIG_COMMERCE_CLIENT_SECRET,
      { algorithms: ["HS256"] }
    );


    // Extract store hash
    const storeHash = payload.sub.replace("stores/", "");

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
    console.error("JWT uninstall failed:", err);
    return reply.status(401).send("Invalid JWT");
  }
};
