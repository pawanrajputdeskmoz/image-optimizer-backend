const { post, put } = require("../axiosUtils");
const {
  INTERCOM_API_BASE,
  logIntercom,
  getIntercomHeaders,
  getIntercomIdentity,
  loadStoreContext,
  buildContactPayload,
  findContactByExternalId,
} = require("./helpers");

/**
 * Create (or refresh) an Intercom contact after app install.
 */
async function addToIntercom(shopUrl) {
  const { logCallFunction } = require("../fileLogger");
  logCallFunction("addToIntercom", { storeHash: shopUrl });
  try {
    const headers = getIntercomHeaders();
    if (!headers) {
      logIntercom("[intercom] INTERCOM_ACCESS_TOKEN is not set; skipping add", {
        storeHash: shopUrl,
        code: "MISSING_TOKEN",
      });
      return { skipped: true, reason: "MISSING_TOKEN" };
    }

    const ctx = await loadStoreContext(shopUrl);
    const contactPayload = buildContactPayload(shopUrl, ctx, {
      installStatus: "installed",
      storeStatus: "installed",
    });

    const existingContact = await findContactByExternalId(
      ctx.contactExternalId,
      headers
    );

    if (existingContact?.id) {
      await put(
        `${INTERCOM_API_BASE}/contacts/${existingContact.id}`,
        contactPayload,
        { headers }
      );
      logIntercom("[intercom] Contact updated on add", {
        storeHash: shopUrl,
        contactExternalId: ctx.contactExternalId,
        contactId: existingContact.id,
      });
    } else {
      await post(
        `${INTERCOM_API_BASE}/contacts`,
        {
          role: "user",
          ...contactPayload,
        },
        headers
      );
      logIntercom("[intercom] Contact created", {
        storeHash: shopUrl,
        contactExternalId: ctx.contactExternalId,
      });
    }

    return true;
  } catch (err) {
    logIntercom("[intercom] addToIntercom failed", {
      storeHash: shopUrl,
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data,
    });
    throw err;
  }
}

/** Fire-and-forget — does not block the install response. */
function queueAddToIntercom(shopUrl) {
  void addToIntercom(shopUrl).catch((err) => {
    logIntercom("[intercom] queued add failed", {
      storeHash: shopUrl,
      message: err?.message,
    });
  });
}

module.exports = {
  addToIntercom,
  queueAddToIntercom,
  getIntercomIdentity,
};
