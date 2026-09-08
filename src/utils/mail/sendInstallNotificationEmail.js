const { sendMail } = require("./sendMail");
const {
  installNotificationTemplate,
} = require("./templates/installNotificationTemplate");

/**
 * Sends install details to the internal SeoKart inbox (not the merchant).
 */
async function sendInstallNotificationEmail({
  storeName,
  storeHash,
  storeUrl,
  domain,
  clientEmail,
  clientName,
  currency,
  storeId,
  scope,
  installedAt,
} = {}) {
  const to = process.env.INSTALL_NOTIFY_EMAIL;
  if (!to) {
    return { sent: false, skipped: true, reason: "NO_RECIPIENT" };
  }

  const { subject, html, text } = installNotificationTemplate({
    storeName,
    storeHash,
    storeUrl,
    domain,
    clientEmail,
    clientName,
    currency,
    storeId,
    scope,
    installedAt,
  });

  return sendMail({ to, subject, html, text });
}

/** Fire-and-forget — does not block the install response. */
function queueInstallNotificationEmail(payload = {}) {
  void sendInstallNotificationEmail(payload).catch((err) => {
    console.error("[install-notify-email] send failed:", err?.message);
  });
}

module.exports = {
  sendInstallNotificationEmail,
  queueInstallNotificationEmail,
};
