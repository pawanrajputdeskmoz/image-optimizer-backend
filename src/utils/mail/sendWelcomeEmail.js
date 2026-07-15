const { sendMail } = require("./sendMail");
const { welcomeTemplate } = require("./templates/welcomeTemplate");
const { getPlanBySlug } = require("../../modules/plans/service");

/**
 * Sends the welcome email after app install.
 * Fetches free-plan details in the background (one DB read).
 */
async function sendWelcomeEmail({ email, storeName } = {}) {
  if (!email) {
    return { sent: false, skipped: true, reason: "NO_RECIPIENT" };
  }

  const plan = await getPlanBySlug("free", { activeOnly: true });
  const { subject, html, text } = welcomeTemplate({
    storeName: storeName || null,
    planName: plan?.name || "Free",
    monthlyLimit: plan?.monthly_image_limit ?? null,
  });

  return sendMail({ to: email, subject, html, text });
}

/** Fire-and-forget — does not block the install response. */
function queueWelcomeEmail({ email, storeName } = {}) {
  void sendWelcomeEmail({ email, storeName }).catch((err) => {
    console.error("[welcome-email] send failed:", err?.message);
  });
}

module.exports = { sendWelcomeEmail, queueWelcomeEmail };
