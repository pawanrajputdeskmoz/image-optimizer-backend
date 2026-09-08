const crypto = require("crypto");
const { post } = require("../axiosUtils");
const { User, ClientPlan, Plan } = require("../../models");
const { appendDailyLog } = require("../fileLogger");

const INTERCOM_API_BASE = "https://api.intercom.io";
/** Prefix for Intercom user_id / external_id → `io_{storeHash}` */
const INTERCOM_USER_ID_PREFIX = "io";

/**
 * Write every Intercom message to logs/ (daily + intercom-YYYY-MM-DD.log).
 * Also mirrors to the console so you still see it in the terminal.
 */
function logIntercom(message, meta = null) {
  appendDailyLog(message, { category: "intercom", meta });
  const metaText =
    meta && typeof meta === "object" ? ` ${JSON.stringify(meta)}` : "";
  console.log(`${message}${metaText}`);
}

function sanitizeSecret(value) {
  if (value == null) return "";
  let secret = String(value).replace(/^\uFEFF/, "").trim();
  if (
    (secret.startsWith('"') && secret.endsWith('"')) ||
    (secret.startsWith("'") && secret.endsWith("'"))
  ) {
    secret = secret.slice(1, -1).trim();
  }
  return secret;
}

function looksLikeAccessToken(secret) {
  if (!secret) return false;
  if (secret.startsWith("dG9r") || secret.startsWith("tok_")) return true;
  try {
    return Buffer.from(secret, "base64").toString("utf8").startsWith("tok:");
  } catch {
    return false;
  }
}

function getIntercomHeaders() {
  const accessToken = sanitizeSecret(process.env.INTERCOM_ACCESS_TOKEN);
  if (!accessToken) return null;

  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "Intercom-Version": "2.11",
  };
}

/**
 * Intercom user_id / external_id: `io_{storeHash}`.
 * @param {string} storeHash
 */
function buildContactExternalId(storeHash) {
  const hash = String(storeHash ?? "").trim();
  if (!hash) return "";
  if (hash.startsWith(`${INTERCOM_USER_ID_PREFIX}_`)) return hash;
  return `${INTERCOM_USER_ID_PREFIX}_${hash}`;
  
}

/**
 * Generate Intercom user hash using Messenger Identity Verification secret.
 */
function buildIntercomUserHash(userId) {
  const id = userId == null ? "" : String(userId).trim();
  const secret = sanitizeSecret(
    process.env.INTERCOM_IDENTITY_SECRET || process.env.INTERCOM_SECRET_KEY
  );

  if (!secret || !id) {
    return { userHash: null, identityError: secret ? null : "MISSING_IDENTITY_SECRET" };
  }

  if (looksLikeAccessToken(secret)) {
    logIntercom(
      "[intercom] INTERCOM_IDENTITY_SECRET looks like an Access Token. Use Messenger Security / Identity Verification secret instead.",
      {
        code: "IDENTITY_SECRET_IS_ACCESS_TOKEN",
        userId: id,
      }
    );
    return { userHash: null, identityError: "IDENTITY_SECRET_IS_ACCESS_TOKEN" };
  }

  return {
    userHash: crypto.createHmac("sha256", secret).update(id, "utf8").digest("hex"),
    identityError: null,
  };
}

/**
 * Get Intercom identity information for Messenger boot.
 */
function getIntercomIdentity(userId, meta = {}) {
  const id = userId == null ? "" : String(userId).trim();
  const { userHash, identityError } = buildIntercomUserHash(id);

  if (!userHash && identityError === "MISSING_IDENTITY_SECRET") {
    logIntercom(
      "[intercom] INTERCOM_IDENTITY_SECRET is not set; user_hash will be null",
      {
        code: "MISSING_IDENTITY_SECRET",
        userId: id || null,
        ...meta,
      }
    );
  }

  return {
    userId: id,
    userHash,
    identityError: userHash ? null : identityError || "UNKNOWN",
  };
}

async function loadStoreContext(shopUrl) {
  if (!shopUrl) {
    throw new Error("store_hash is required");
  }

  const storeInfo = await User.findOne({ store_hash: shopUrl }).lean();
  if (!storeInfo) {
    throw new Error(`User not found for store_hash=${shopUrl}`);
  }

  const mongoUserId = String(storeInfo._id);
  const contactExternalId = buildContactExternalId(shopUrl);
  const clientPlan = await ClientPlan.findOne({ store_hash: shopUrl }).lean();
  const planSlug = (clientPlan?.base_plan_slug || "free").toLowerCase();
  const plan = await Plan.findOne({ slug: planSlug }).lean();
  const planPrice = Number(plan?.price) || 0;
  const paymentStatus = clientPlan?.subscription_status || "";
  const isPaid =
    planPrice > 0 &&
    (paymentStatus === "active" || (!paymentStatus && planPrice > 0));

  // HMAC must use the same string as Intercom user_id / external_id
  const { userHash } = getIntercomIdentity(contactExternalId);

  return {
    storeInfo,
    mongoUserId,
    contactExternalId,
    email: storeInfo.email || "",
    ownerName: storeInfo.username || "",
    platform: storeInfo.provider || "bigcommerce",
    storeStatus: storeInfo.installStatus || "unknown",
    installStatus:
      storeInfo.installStatus === "installed" ? "installed" : "uninstall",
    planSlug,
    planPrice,
    paymentStatus,
    isPaid,
    userHash,
  };
}

/**
 * Intercom People Data attribute names — must match workspace keys exactly
 * (casing/spacing) as shown in the Intercom Details panel.
 */
function buildCustomAttributes(shopUrl, ctx, overrides = {}) {
  const storeUrl = ctx.storeInfo.storeUrl || "";
  const storeDomain =
    ctx.storeInfo.primaryDomain ||
    (typeof storeUrl === "string"
      ? storeUrl.replace(/^https?:\/\//i, "").replace(/\/$/, "")
      : "");

  const appUrl = process.env.BIG_COMMERCE_APP_ID
    ? `https://store-${shopUrl}.mybigcommerce.com/manage/app/${process.env.BIG_COMMERCE_APP_ID}`
    : "";

  return {
    // Image 1 attributes
    "User id": ctx.contactExternalId || buildContactExternalId(shopUrl),
    "Store hash": shopUrl,
    "Uninstall/install status":
      overrides.installStatus ?? ctx.installStatus,
    "Review url": overrides.reviewUrl ?? "",
    "Store owner name": ctx.ownerName,
    "Keyword limit": overrides.keywordLimit ?? "",
    Platform: ctx.platform,
    Shopurl: storeUrl,
    "Payment status": ctx.paymentStatus,
    "Uninstallation date": overrides.uninstallationDate ?? "",
    "Managed services": overrides.managedServices ?? "No",
    "Paid user": ctx.isPaid ? "Yes" : "No",
    Plan: ctx.isPaid ? `US$ ${ctx.planPrice}` : "US$ 0",
    "Store status": overrides.storeStatus ?? ctx.storeStatus,

    // Image 2 attributes
    "Slack email": overrides.slackEmail ?? "",
    Email: ctx.email,
    "Report frequency": overrides.reportFrequency ?? "",
    "Ga connect": overrides.gaConnect ?? "",
    "Use keyword": overrides.useKeyword ?? "",
    "App url": appUrl,
    Workflowinstanceid: overrides.workflowInstanceId ?? "",
    Product: overrides.product ?? "Image Optimizer",
    "Store name": ctx.storeInfo.store_name || "",
    "Store domain": storeDomain,
    "Plan name": ctx.planSlug,
    "App name": "image optimizer",

    ...overrides.extraAttributes,
  };
}

function buildContactPayload(shopUrl, ctx, overrides = {}) {
  return {
    email: ctx.email || undefined,
    name: ctx.ownerName || ctx.email || shopUrl,
    custom_attributes: buildCustomAttributes(shopUrl, ctx, overrides),
  };
}

async function findContactByExternalId(contactExternalId, headers) {
  const searchResponse = await post(
    `${INTERCOM_API_BASE}/contacts/search`,
    {
      query: {
        field: "external_id",
        operator: "=",
        value: contactExternalId,
      },
    },
    headers
  );

  return searchResponse?.data?.[0] || null;
}

module.exports = {
  INTERCOM_API_BASE,
  INTERCOM_USER_ID_PREFIX,
  logIntercom,
  getIntercomHeaders,
  getIntercomIdentity,
  buildIntercomUserHash,
  buildContactExternalId,
  loadStoreContext,
  buildContactPayload,
  findContactByExternalId,
};
