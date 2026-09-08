const { sendMail } = require("./sendMail");
const {
  uninstallNotificationTemplate,
} = require("./templates/uninstallNotificationTemplate");

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
  const to = process.env.INSTALL_NOTIFY_EMAIL || "info@seokart.com";
  const cc =
    process.env.INSTALL_NOTIFY_CC || "prashantsingh.deskmoz@gmail.com";

  const displayName = storeName || storeHash || "Unknown store";
  const { html, text } = uninstallNotificationTemplate({
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

  return sendMail({
    from: process.env.EMAIL_FROM || process.env.MAIL_FROM_EMAIL,
    to,
    cc,
    replyTo: clientEmail || undefined,
    subject: `Uninstall: ${displayName} (${storeHash || "n/a"})`,
    html,
    text,
  });
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
