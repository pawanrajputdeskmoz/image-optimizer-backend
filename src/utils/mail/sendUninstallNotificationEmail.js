const { sendMail, formatReplyTo } = require("./sendMail");
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
  storeAddress,
  clientEmail,
  clientName,
  platform,
} = {}) {
  const to = process.env.INSTALL_NOTIFY_EMAIL || "info@seokart.com";
  // BCC (not CC): Intercom treats CC recipients as the conversation user.
  const bcc =
    process.env.INSTALL_NOTIFY_CC || "prashantsingh.deskmoz@gmail.com";

  const displayName = storeName || storeHash || "Unknown store";
  const { subject, html, text } = uninstallNotificationTemplate({
    storeHash,
    storeUrl,
    storeAddress,
    clientEmail,
    clientName,
    platform,
  });

  return sendMail({
    from: process.env.EMAIL_FROM || process.env.MAIL_FROM_EMAIL,
    to,
    bcc,
    replyTo: formatReplyTo(clientEmail, displayName),
    subject,
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
