const { post, get } = require("../../utils/axiosUtils");
const { User } = require("../../models");
const jwt = require("jsonwebtoken");

exports.fetchStoreInfo = async (storeHash, accessToken) => {
  if (!storeHash || !accessToken) return null;
  try {
    const storeInfo = await get(
      `https://api.bigcommerce.com/stores/${storeHash}/v2/store`,
      {
        "X-Auth-Token": accessToken,
        Accept: "application/json",
        "Content-Type": "application/json",
      }
    );
    return storeInfo || null;
  } catch (err) {
    console.error("[store] fetchStoreInfo failed:", {
      storeHash,
      message: err?.message,
      status: err?.response?.status,
    });
    return null;
  }
};

/** Always return a full absolute storefront URL (https://..., no trailing slash). */
exports.normalizeAbsoluteStoreUrl = (raw, storeHash) => {
  const fallback = storeHash
    ? `https://store-${storeHash}.mybigcommerce.com`
    : null;

  if (raw == null || typeof raw !== "string") {
    return fallback;
  }

  let url = raw.trim().replace(/\/$/, "");
  if (!url) return fallback;

  if (url.startsWith("//")) {
    url = `https:${url}`;
  } else if (!/^https?:\/\//i.test(url)) {
    url = `https://${url.replace(/^\/+/, "")}`;
  }

  return url.replace(/\/$/, "") || fallback;
};

exports.resolveStoreUrl = (storeInfo, storeHash) => {
  const secureUrl =
    typeof storeInfo?.secure_url === "string"
      ? storeInfo.secure_url.trim()
      : "";
  if (secureUrl) {
    return exports.normalizeAbsoluteStoreUrl(secureUrl, storeHash);
  }

  const domain =
    typeof storeInfo?.domain === "string"
      ? storeInfo.domain.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "")
      : "";
  if (domain) {
    return exports.normalizeAbsoluteStoreUrl(`https://${domain}`, storeHash);
  }

  return exports.normalizeAbsoluteStoreUrl(null, storeHash);
};

exports.buildStoreUpdateFields = (storeInfo, storeHash) => {
  const storeUrl = exports.resolveStoreUrl(storeInfo, storeHash);
  const primaryDomainFromInfo =
    typeof storeInfo?.domain === "string"
      ? storeInfo.domain
          .trim()
          .replace(/^https?:\/\//i, "")
          .replace(/\/$/, "")
          .toLowerCase()
      : null;

  let primaryDomain = primaryDomainFromInfo;
  if (!primaryDomain && storeUrl) {
    try {
      primaryDomain = new URL(storeUrl).hostname.toLowerCase();
    } catch {
      primaryDomain = null;
    }
  }

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

/** Persist a complete storeUrl when missing (e.g. older installs). */
exports.ensureUserStoreUrl = async (userDoc) => {
  if (!userDoc?.store_hash) return userDoc;

  const existing = exports.normalizeAbsoluteStoreUrl(
    userDoc.storeUrl,
    userDoc.store_hash
  );
  if (userDoc.storeUrl && userDoc.storeUrl === existing) {
    return userDoc;
  }

  const nextUrl =
    existing ||
    exports.resolveStoreUrl(
      { domain: userDoc.primaryDomain, secure_url: userDoc.storeUrl },
      userDoc.store_hash
    );

  if (!nextUrl) return userDoc;

  return User.findOneAndUpdate(
    { store_hash: userDoc.store_hash },
    {
      $set: {
        storeUrl: nextUrl,
        ...(userDoc.primaryDomain
          ? {}
          : {
              primaryDomain: (() => {
                try {
                  return new URL(nextUrl).hostname.toLowerCase();
                } catch {
                  return null;
                }
              })(),
            }),
      },
    },
    { returnDocument: "after" }
  ).lean();
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
    { returnDocument: "after" }
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
  username:
    `${storeInfo?.first_name || ""} ${storeInfo?.last_name || ""}`.trim() ||
    "unknown",
  ...exports.buildStoreUpdateFields(storeInfo, storeHash),
});

exports.saveInstalledStore = async ({
  storeHash,
  access_token,
  user,
  scope,
  storeInfo,
}) => {
  const updatePayload = exports.buildInstallUpdatePayload({
    access_token,
    user,
    scope,
    storeInfo,
    storeHash,
  });

  // store_id only in $set — putting it in both $set and $setOnInsert causes a Mongo conflict
  return User.findOneAndUpdate(
    { store_hash: storeHash },
    {
      $set: updatePayload,
      $setOnInsert: {
        provider: "bigcommerce",
        store_hash: storeHash,
      },
    },
    { upsert: true, returnDocument: "after", runValidators: true }
  ).then(async (savedUser) => {
    const { ensureClientPlan } = require("../plans/service");
    await ensureClientPlan(storeHash, "free", savedUser._id);
    return savedUser;
  });
};

exports.getManageAppRedirectUrl = (storeHash) =>
  `https://store-${storeHash}.mybigcommerce.com/manage/app/${process.env.BIG_COMMERCE_APP_ID}`;

/** Absolute callback URL from a Fastify request (supports proxies). */
exports.buildAbsoluteRequestUrl = (req) => {
  if (!req) return null;

  const forwardedHost = req.headers?.["x-forwarded-host"];
  const host = String(forwardedHost || req.headers?.host || "")
    .split(",")[0]
    .trim();
  const forwardedProto = req.headers?.["x-forwarded-proto"];
  const proto = String(forwardedProto || req.protocol || "https")
    .split(",")[0]
    .trim()
    .replace(/:$/, "");
  const pathWithQuery = req.raw?.url || req.url || "";

  if (!host || !pathWithQuery) return null;
  return `${proto}://${host}${pathWithQuery}`;
};

/**
 * Persist the complete signed-payload callback URL on the store user.
 * Accepts either an explicit URL (preferred from frontend) or builds from req.
 */
exports.saveSignedPayloadUrl = async (storeHash, url, req = null) => {
  if (!storeHash) return null;

  const resolved =
    (typeof url === "string" && url.trim()) ||
    exports.buildAbsoluteRequestUrl(req) ||
    null;

  if (!resolved) return null;

  return User.findOneAndUpdate(
    { store_hash: storeHash },
    { $set: { signed_payload_url: resolved } },
    { returnDocument: "after" }
  ).lean();
};

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
