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
  findContactForStore,
} = require("./helpers");

/**
 * Find the Intercom contact for this store and refresh its details.
 *
 * @param {string} shopUrl - BigCommerce store hash
 */
async function updateToIntercom(shopUrl) {
  const { logCallFunction } = require("../fileLogger");
  logCallFunction("updateToIntercom", { storeHash: shopUrl });
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
    const { contact: existingContact, matchedBy } = await findContactForStore(
      ctx,
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
      matchedBy,
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
