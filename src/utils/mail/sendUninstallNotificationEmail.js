const config = require("../../config");
const { sendMail } = require("./sendMail");
const {
  uninstallNotificationTemplate,
} = require("./templates/uninstallNotificationTemplate");

const DEFAULT_INSTALL_NOTIFY_EMAIL = "info@seokart.com";

/**
 * Sends uninstall details to the internal SeoKart inbox (not the merchant).
 */
async function sendUninstallNotificationEmail({
  storeName,
  storeHash,
  storeUrl,
  domain,
  clientEmail,
  clientName,
  currency,
  storeId,
  uninstalledAt,
} = {}) {
  const to =
    config.mail.installNotifyEmail || DEFAULT_INSTALL_NOTIFY_EMAIL;

  if (!to) {
    return { sent: false, skipped: true, reason: "NO_RECIPIENT" };
  }

  const { subject, html, text } = uninstallNotificationTemplate({
    storeName,
    storeHash,
    storeUrl,
    domain,
    clientEmail,
    clientName,
    currency,
    storeId,
    uninstalledAt,
  });

  return sendMail({ to, subject, html, text });
}

/** Fire-and-forget — does not block the uninstall response. */
function queueUninstallNotificationEmail(payload = {}) {
  void sendUninstallNotificationEmail(payload).catch((err) => {
    console.error("[uninstall-notify-email] send failed:", err?.message);
  });
}

module.exports = {
  sendUninstallNotificationEmail,
  queueUninstallNotificationEmail,
};
