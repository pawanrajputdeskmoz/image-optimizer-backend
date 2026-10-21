const User = require("../../models/User");
const { sendMail, formatReplyTo } = require("./sendMail");
const {
  paymentReceivedTemplate,
} = require("./templates/paymentReceivedTemplate");

/**
 * Internal SeoKart payment alerts (not to the merchant).
 * kind: "visit" | "new" | "recurring"
 */
async function sendPaymentNotificationEmail({
  storeHash,
  storeUrl,
  clientEmail,
  storeName,
  transactionId,
  kind = "new",
  platform = "Bigcommerce",
  app = "Image Optimizer",
} = {}) {
  let resolvedStoreUrl = storeUrl || null;
  let resolvedEmail = clientEmail || null;
  let resolvedName = storeName || null;

  if (storeHash && (!resolvedStoreUrl || !resolvedEmail)) {
    const user = await User.findOne({ store_hash: storeHash })
      .select({ storeUrl: 1, email: 1, store_name: 1 })
      .lean();
    if (user) {
      resolvedStoreUrl = resolvedStoreUrl || user.storeUrl || null;
      resolvedEmail = resolvedEmail || user.email || null;
      resolvedName = resolvedName || user.store_name || null;
    }
  }

  const to = process.env.INSTALL_NOTIFY_EMAIL || "info@seokart.com";
  // Payment alerts go to Pawan (not INSTALL_NOTIFY_CC / Prashant).
  const bcc = "pawanrajput.deskmoz@gmail.com";

  const displayName = resolvedName || storeHash || "Unknown store";
  const { subject, html, text } = paymentReceivedTemplate({
    kind,
    transactionId,
    storeUrl: resolvedStoreUrl,
    clientEmail: resolvedEmail,
    platform,
    app,
  });

  const result = await sendMail({
    from: process.env.EMAIL_FROM || process.env.MAIL_FROM_EMAIL,
    to,
    bcc,
    replyTo: formatReplyTo(resolvedEmail, displayName),
    subject,
    html,
    text,
  });

  if (!result?.sent) {
    console.error("[payment-notify-email] not sent", {
      kind,
      storeHash,
      to,
      bcc,
      reason: result?.reason || result?.error || "unknown",
    });
  } else {
    console.log("[payment-notify-email] sent", {
      kind,
      storeHash,
      to,
      bcc,
      messageId: result.messageId,
    });
  }

  return result;
}

/** Fire-and-forget — does not block checkout or webhook response. */
function queuePaymentNotificationEmail(payload = {}) {
  void sendPaymentNotificationEmail(payload).catch((err) => {
    console.error("[payment-notify-email] send failed:", err?.message);
  });
}

module.exports = {
  sendPaymentNotificationEmail,
  queuePaymentNotificationEmail,
};
