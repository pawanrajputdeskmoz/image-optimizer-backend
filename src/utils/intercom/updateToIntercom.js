/**
 * updateToIntercom.js
 *
 * Keeps an existing Intercom contact in sync when the merchant
 * opens the app again (plan, payment, store details, install status).
 */

const { put } = require("../axiosUtils");
const { User, ClientPlan, Plan } = require("../../models");
const {
  INTERCOM_API_BASE,
  INTERCOM_APP_LABEL,
  logIntercom,
  getIntercomHeaders,
  getIntercomIdentity,
  buildContactExternalId,
  findContactByExternalId,
} = require("./helpers");

/**
 * Build the fields we send to Intercom for an update.
 * Based on the older PHP helper updateManualyToIntercom.
 *
 * Note: keyword / report / review fields from that PHP app
 * are not used here — this product does not store them.
 *
 * @param {object} storeInfo - User row from MongoDB
 * @param {{ clientPlan?: object, plan?: object, userHash?: string|null }} [extras]
 * @returns {{ user_id: string, email: string, custom_attributes: object }}
 */
function updateManuallyToIntercom(storeInfo, extras = {}) {
  // Basic store identity
  const shopUrl = storeInfo.store_hash;
  const userId = String(storeInfo._id ?? storeInfo.id);
  const email = storeInfo.email || "";
  const ownerName = storeInfo.username || storeInfo.owner_name || "";
  const platform = storeInfo.provider || storeInfo.platform || "bigcommerce";
  const storeStatus =
    storeInfo.installStatus || storeInfo.store_status || "unknown";

  // Plan + payment from our billing tables
  const clientPlan = extras.clientPlan || null;
  const plan = extras.plan || null;

  const paymentStatus = clientPlan?.subscription_status || "";
  const planName = (
    clientPlan?.base_plan_slug ||
    clientPlan?.plan_name ||
    plan?.slug ||
    "free"
  ).toLowerCase();
  const totalAmount = Number(plan?.price ?? clientPlan?.total_amount ?? 0) || 0;

  // We do not sell "managed services" in this app — always "No".
  // Paid user = has a paid plan and an active (or implied) subscription.
  const managedServices = "No";
  const isPaid =
    totalAmount > 0 &&
    (paymentStatus === "active" || (!paymentStatus && totalAmount > 0));
  const paidUser = isPaid ? "Yes" : "No";
  const PlanAmount = isPaid ? `US$ ${totalAmount}` : "US$ 0";

  // installed vs uninstall — Intercom custom attribute wording
  const installStatus =
    storeInfo.installStatus === "installed" || storeInfo.uninstall === 0
      ? "installed"
      : "uninstall";

  // Link support can open to manage this store's app install
  const appId = process.env.BIG_COMMERCE_APP_ID;
  const appUrl = appId
    ? `https://store-${shopUrl}.mybigcommerce.com/manage/app/${appId}`
    : "";

  // Messenger identity hash (same value the frontend boots with)
  const userHash =
    extras.userHash ?? getIntercomIdentity(userId).userHash ?? "";

  return {
    // Namespaced so this contact does not clash with other apps in the same workspace
    user_id: `${userId} - ${INTERCOM_APP_LABEL}`,
    email,
    custom_attributes: {
      "store hash": shopUrl,
      email,
      "uninstall/install status": installStatus,
      Platform: platform,
      "Store owner name": ownerName,
      "App url": appUrl,
      "Store status": storeStatus,
      "Store name": storeInfo.store_name || "",
      "Store URL": storeInfo.storeUrl || "",
      "Managed Services": managedServices,
      "Payment status": paymentStatus,
      "Paid User": paidUser,
      Plan: PlanAmount,
      "Plan name": planName,
      "user_hash - imageOptimizer": userHash || "",
    },
  };
}

/**
 * Find the Intercom contact for this store and refresh its details.
 *
 * Steps:
 * 1. Load the store, plan, and user hash
 * 2. Find the contact by external_id
 * 3. PUT the latest custom attributes
 *
 * @param {string} shopUrl - BigCommerce store hash
 */
async function updateToIntercom(shopUrl) {
  try {
    if (!shopUrl) {
      throw new Error("store_hash is required");
    }

    // Need INTERCOM_ACCESS_TOKEN in .env
    const headers = getIntercomHeaders();
    if (!headers) {
      logIntercom(
        "[intercom] INTERCOM_ACCESS_TOKEN is not set; skipping update",
        { storeHash: shopUrl, code: "MISSING_TOKEN" }
      );
      return { skipped: true, reason: "MISSING_TOKEN" };
    }

    // 1) Store owner / install info
    const storeInfo = await User.findOne({ store_hash: shopUrl }).lean();
    if (!storeInfo) {
      throw new Error(`User not found for store_hash=${shopUrl}`);
    }

    // 2) Current plan + price
    const clientPlan = await ClientPlan.findOne({ store_hash: shopUrl }).lean();
    const planSlug = (clientPlan?.base_plan_slug || "free").toLowerCase();
    const plan = await Plan.findOne({ slug: planSlug }).lean();

    const mongoUserId = String(storeInfo._id);
    const { userHash } = getIntercomIdentity(mongoUserId);
    const contactExternalId = buildContactExternalId(mongoUserId);

    // 3) If contact is missing, create it (same as install) then stop
    const existingContact = await findContactByExternalId(
      contactExternalId,
      headers
    );

    if (!existingContact?.id) {
      logIntercom(
        "[intercom] Contact not found for update — creating via addToIntercom",
        {
          storeHash: shopUrl,
          contactExternalId,
          code: "CONTACT_NOT_FOUND",
        }
      );
      const { addToIntercom } = require("./addToIntercom");
      return addToIntercom(shopUrl);
    }

    // 4) Build the attribute bag, then push it to Intercom
    const payload = updateManuallyToIntercom(storeInfo, {
      clientPlan,
      plan,
      userHash,
    });

    await put(
      `${INTERCOM_API_BASE}/contacts/${existingContact.id}`,
      {
        email: payload.email || undefined,
        name: storeInfo.username || payload.email || shopUrl,
        custom_attributes: payload.custom_attributes,
      },
      { headers }
    );

    logIntercom("[intercom] Contact updated", {
      storeHash: shopUrl,
      contactExternalId,
      contactId: existingContact.id,
    });
    return true;
  } catch (err) {
    logIntercom("[intercom] updateToIntercom failed", {
      storeHash: shopUrl,
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data,
    });
    throw err;
  }
}

/**
 * Background version of updateToIntercom.
 * Safe to call from dashboard load — Intercom sync won't slow the API response.
 */
function queueUpdateToIntercom(shopUrl) {
  void updateToIntercom(shopUrl).catch((err) => {
    logIntercom("[intercom] queued update failed", {
      storeHash: shopUrl,
      message: err?.message,
    });
  });
}

module.exports = {
  updateManuallyToIntercom,
  updateToIntercom,
  queueUpdateToIntercom,
};
