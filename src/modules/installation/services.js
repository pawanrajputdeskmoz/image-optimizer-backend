const { post, get } = require("../../utils/axiosUtils");
const { User } = require("../../models");
const jwt = require("jsonwebtoken");


exports.resolveStoreUrl = (storeInfo, storeHash) => {
  const secureUrl =
    typeof storeInfo?.secure_url === "string"
      ? storeInfo.secure_url.trim().replace(/\/$/, "")
      : "";
  if (secureUrl) {
    return secureUrl;
  }

  const domain =
    typeof storeInfo?.domain === "string"
      ? storeInfo.domain.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "")
      : "";
  if (domain) {
    return `https://${domain}`;
  }

  return `https://store-${storeHash}.mybigcommerce.com`;
};

exports.buildStoreUpdateFields = (storeInfo, storeHash) => {
  const storeUrl = exports.resolveStoreUrl(storeInfo, storeHash);
  const primaryDomain =
    typeof storeInfo?.domain === "string"
      ? storeInfo.domain
        .trim()
        .replace(/^https?:\/\//i, "")
        .replace(/\/$/, "")
        .toLowerCase()
      : null;
  const storeName =
    typeof storeInfo?.name === "string" ? storeInfo.name.trim() : null;
  const currency =
    typeof storeInfo?.currency === "string"
      ? storeInfo.currency.trim().toUpperCase()
      : null;

  return {
    storeUrl,
    ...(storeName ? { store_name: storeName } : {}),
    ...(currency ? { currency } : {}),
    ...(primaryDomain ? { primaryDomain } : {}),
    ...(storeInfo?.id != null ? { store_id: String(storeInfo.id) } : {}),
  };
};



exports.syncUserStoreFromBigCommerce = async (storeHash, accessToken) => {
  const storeInfo = await get(
    `https://api.bigcommerce.com/stores/${storeHash}/v2/store`,
    {
      "X-Auth-Token": accessToken,
      Accept: "application/json",
      "Content-Type": "application/json",
    }
  );
  const updateFields = exports.buildStoreUpdateFields(storeInfo, storeHash);

  return User.findOneAndUpdate(
    { store_hash: storeHash },
    { $set: updateFields },
    { new: true }
  ).lean();
};

exports.exchangeOAuthToken = async ({ code, scope, context }) => {
  return post("https://login.bigcommerce.com/oauth2/token", {
    client_id: process.env.BIG_COMMERCE_CLIENT_ID,
    client_secret: process.env.BIG_COMMERCE_CLIENT_SECRET,
    redirect_uri: `${process.env.REDIRECT_URI}/store/install`,
    grant_type: "authorization_code",
    code,
    scope,
    context,
  });
};



exports.buildInstallUpdatePayload = ({
  access_token,
  user,
  scope,
  storeInfo,
  storeHash,
}) => ({
  access_token,
  lastInstalledAt: new Date(),
  installStatus: "installed",
  scope,
  email: user.email,
  username: `${storeInfo.first_name || ""} ${storeInfo.last_name || ""}`.trim(),
  ...exports.buildStoreUpdateFields(storeInfo, storeHash),
});

exports.saveInstalledStore = async ({
  storeHash,
  access_token,
  user,
  scope,
  storeInfo,
}) => {
  
  let updatePayload = {
    access_token,
    lastInstalledAt: new Date(),
    installStatus: "installed",
    scope,
    email: user.email,
    username: `${storeInfo.first_name || ""} ${storeInfo.last_name || ""}`.trim(),
    ...exports.buildStoreUpdateFields(storeInfo, storeHash),
  }

  return User.findOneAndUpdate(
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
};

exports.getManageAppRedirectUrl = (storeHash) =>
  `https://store-${storeHash}.mybigcommerce.com/manage/app/${process.env.BIG_COMMERCE_APP_ID}`;





exports.verifySignedPayloadJwt = (signedPayloadJwt, options = {}) =>
  jwt.verify(signedPayloadJwt, process.env.BIG_COMMERCE_CLIENT_SECRET, {
    algorithms: ["HS256"],
    ...options,
  });

exports.parseStoreHashFromJwtSub = (sub) => {
  if (typeof sub !== "string") return null;
  return sub.replace("stores/", "").split("/").pop() || null;
};

exports.signAppApiToken = (storeHash, access_token) =>
  jwt.sign({ storeHash, access_token }, process.env.JWT_SECRET);
