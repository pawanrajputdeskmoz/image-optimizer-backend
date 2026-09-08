/**
 * uninstallFromIntercom.js
 *
 * When a merchant removes the app, we tell Intercom so support
 * can see the store as "uninstalled" (we do not delete the contact).
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
 * Mark this store as uninstalled in Intercom.
 *
 * Steps:
 * 1. Check we have an Intercom API token
 * 2. Load store details from our database
 * 3. Find the matching Intercom contact
 * 4. Update install status fields to "uninstall" / "uninstalled"
 *
 * @param {string} shopUrl - BigCommerce store hash
 */
async function uninstallFromIntercom(shopUrl) {
  try {
    // Need INTERCOM_ACCESS_TOKEN in .env to talk to Intercom
    const headers = getIntercomHeaders();
    if (!headers) {
      logIntercom(
        "[intercom] INTERCOM_ACCESS_TOKEN is not set; skipping uninstall sync",
        { storeHash: shopUrl, code: "MISSING_TOKEN" }
      );
      return { skipped: true, reason: "MISSING_TOKEN" };
    }

    // Pull store + plan info we already store locally
    const ctx = await loadStoreContext(shopUrl);

    // Look up the contact we created on install (external_id = "{userId} - imageOptimizer")
    const existingContact = await findContactByExternalId(
      ctx.contactExternalId,
      headers
    );

    // Nothing to update if they were never synced to Intercom
    if (!existingContact?.id) {
      logIntercom("[intercom] Contact not found for uninstall", {
        storeHash: shopUrl,
        contactExternalId: ctx.contactExternalId,
        code: "CONTACT_NOT_FOUND",
      });
      return { skipped: true, reason: "CONTACT_NOT_FOUND" };
    }

    // Keep all other attributes; only flip install / store status
    const contactPayload = buildContactPayload(shopUrl, ctx, {
      installStatus: "uninstall",
      storeStatus: "uninstalled",
    });

    // Save the change on Intercom
    await put(
      `${INTERCOM_API_BASE}/contacts/${existingContact.id}`,
      contactPayload,
      { headers }
    );

    logIntercom("[intercom] Contact marked uninstalled", {
      storeHash: shopUrl,
      contactExternalId: ctx.contactExternalId,
      contactId: existingContact.id,
    });
    return true;
  } catch (err) {
    logIntercom("[intercom] uninstallFromIntercom failed", {
      storeHash: shopUrl,
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data,
    });
    throw err;
  }
}

/**
 * Same as uninstallFromIntercom, but runs in the background.
 * Use this from the uninstall route so the merchant gets a fast "OK"
 * and Intercom sync happens afterward.
 */
function queueUninstallFromIntercom(shopUrl) {
  void uninstallFromIntercom(shopUrl).catch((err) => {
    logIntercom("[intercom] queued uninstall failed", {
      storeHash: shopUrl,
      message: err?.message,
    });
  });
}

module.exports = {
  uninstallFromIntercom,
  queueUninstallFromIntercom,
};
