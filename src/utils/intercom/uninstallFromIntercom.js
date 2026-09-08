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
  findContactForStore,
} = require("./helpers");

/**
 * Mark this store as uninstalled in Intercom.
 *
 * @param {string} shopUrl - BigCommerce store hash
 */
async function uninstallFromIntercom(shopUrl) {
  const { logCallFunction } = require("../fileLogger");
  logCallFunction("uninstallFromIntercom", { storeHash: shopUrl });
  try {
    const headers = getIntercomHeaders();
    if (!headers) {
      logIntercom(
        "[intercom] INTERCOM_ACCESS_TOKEN is not set; skipping uninstall sync",
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
      logIntercom("[intercom] Contact not found for uninstall", {
        storeHash: shopUrl,
        contactExternalId: ctx.contactExternalId,
        code: "CONTACT_NOT_FOUND",
      });
      return { skipped: true, reason: "CONTACT_NOT_FOUND" };
    }

    const contactPayload = buildContactPayload(shopUrl, ctx, {
      installStatus: "uninstall",
      storeStatus: "uninstalled",
      uninstallationDate: new Date().toISOString(),
    });

    await put(
      `${INTERCOM_API_BASE}/contacts/${existingContact.id}`,
      contactPayload,
      { headers }
    );

    logIntercom("[intercom] Contact marked uninstalled", {
      storeHash: shopUrl,
      contactExternalId: ctx.contactExternalId,
      contactId: existingContact.id,
      matchedBy,
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
