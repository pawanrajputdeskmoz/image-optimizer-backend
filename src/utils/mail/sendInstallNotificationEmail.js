const { sendMail, formatReplyTo } = require("./sendMail");
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
  const { subject, html, text } = installNotificationTemplate({
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
