/**
 * updateToIntercom.js
 *
 * Keeps an existing Intercom contact in sync when the merchant
 * opens the app again (plan, payment, store details, install status).
 */

const { put } = require("../axiosUtils");
const {
  INTERCOM_API_BASE,
  logIntercom,
  getIntercomHeaders,
  loadStoreContext,
  buildContactPayload,
  findContactByExternalId,
} = require("./helpers");

/**
 * Find the Intercom contact for this store and refresh its details.
 *
 * Steps:
 * 1. Load the store, plan, and user hash
 * 2. Find the contact by external_id
 * 3. PUT the latest custom attributes (exact Intercom attribute names)
 *
 * @param {string} shopUrl - BigCommerce store hash
 */
async function updateToIntercom(shopUrl) {
  try {
    if (!shopUrl) {
      throw new Error("store_hash is required");
    }

    const headers = getIntercomHeaders();
    if (!headers) {
      logIntercom(
        "[intercom] INTERCOM_ACCESS_TOKEN is not set; skipping update",
        { storeHash: shopUrl, code: "MISSING_TOKEN" }
      );
      return { skipped: true, reason: "MISSING_TOKEN" };
    }

    const ctx = await loadStoreContext(shopUrl);

    const existingContact = await findContactByExternalId(
      ctx.contactExternalId,
      headers
    );

    if (!existingContact?.id) {
      logIntercom(
        "[intercom] Contact not found for update — creating via addToIntercom",
        {
          storeHash: shopUrl,
          contactExternalId: ctx.contactExternalId,
          code: "CONTACT_NOT_FOUND",
        }
      );
      const { addToIntercom } = require("./addToIntercom");
      return addToIntercom(shopUrl);
    }

    const contactPayload = buildContactPayload(shopUrl, ctx, {
      installStatus: ctx.installStatus,
      storeStatus: ctx.storeStatus,
    });

    await put(
      `${INTERCOM_API_BASE}/contacts/${existingContact.id}`,
      contactPayload,
      { headers }
    );

    logIntercom("[intercom] Contact updated", {
      storeHash: shopUrl,
      contactExternalId: ctx.contactExternalId,
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
  updateToIntercom,
  queueUpdateToIntercom,
};
