const config = require("../../config");
const { sendMail } = require("./sendMail");
const {
  installNotificationTemplate,
} = require("./templates/installNotificationTemplate");

const DEFAULT_INSTALL_NOTIFY_EMAIL = "info@seokart.com";

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
  const to =
    config.mail.installNotifyEmail || DEFAULT_INSTALL_NOTIFY_EMAIL;

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
