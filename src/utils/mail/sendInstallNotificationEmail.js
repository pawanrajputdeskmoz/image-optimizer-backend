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
  const to = process.env.INSTALL_NOTIFY_EMAIL || "info@seokart.com";
  const cc =
    process.env.INSTALL_NOTIFY_CC || "prashantsingh.deskmoz@gmail.com";

  const displayName = storeName || storeHash || "Unknown store";
  const { html, text } = installNotificationTemplate({
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

  return sendMail({
    from: process.env.EMAIL_FROM || process.env.MAIL_FROM_EMAIL,
    to,
    cc,
    replyTo: clientEmail || undefined,
    subject: `New install: ${displayName} (${storeHash || "n/a"})`,
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
