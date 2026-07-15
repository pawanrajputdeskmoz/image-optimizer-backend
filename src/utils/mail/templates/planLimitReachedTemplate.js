function escapeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Builds the "monthly limit reached" email (subject + html + text).
 *
 * @param {Object} vars
 * @param {string} [vars.storeName]     Store/merchant display name.
 * @param {string} [vars.planName]      Current plan name (e.g. "Free", "Pro").
 * @param {number} [vars.monthlyLimit]  Monthly image cap for the plan.
 * @param {number} [vars.monthlyUsed]   Images already optimized this month.
 * @param {string} [vars.message]       Optional custom message override.
 * @returns {{ subject: string, html: string, text: string }}
 */
function planLimitReachedTemplate(vars = {}) {
  const {
    storeName,
    planName,
    monthlyLimit,
    monthlyUsed,
    message,
  } = vars;

  const safeStore = escapeHtml(storeName || "there");
  const safePlan = planName ? escapeHtml(planName) : null;
  const hasLimit = Number.isFinite(monthlyLimit);
  const hasUsed = Number.isFinite(monthlyUsed);

  const subject = "Your monthly image optimization limit has been reached";

  const introMessage = escapeHtml(
    message ||
      "Your monthly image optimization limit has been reached, so your bulk optimization has been paused. Please upgrade your plan to continue now, or wait until your limit renews next month."
  );

  const usageRow =
    hasLimit || hasUsed
      ? `
              <tr>
                <td style="padding:16px 24px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
                    <tr>
                      <td style="padding:16px 20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#475569;">
                        ${safePlan ? `<div style="margin-bottom:8px;"><strong style="color:#0f172a;">Plan:</strong> ${safePlan}</div>` : ""}
                        ${hasLimit ? `<div style="margin-bottom:8px;"><strong style="color:#0f172a;">Monthly limit:</strong> ${monthlyLimit.toLocaleString()} images</div>` : ""}
                        ${hasUsed ? `<div><strong style="color:#0f172a;">Used this month:</strong> ${monthlyUsed.toLocaleString()} images</div>` : ""}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>`
      : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background-color:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.08);">
          <tr>
            <td style="background-color:#4f46e5;padding:28px 24px;text-align:center;">
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:1.3;color:#ffffff;font-weight:700;">
                Image Optimizer
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 24px 8px 24px;">
              <h2 style="margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:1.4;color:#0f172a;font-weight:700;">
                Monthly limit reached
              </h2>
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#334155;">
                Hi ${safeStore},
              </p>
              <p style="margin:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#334155;">
                ${introMessage}
              </p>
            </td>
          </tr>
          ${usageRow}
          <tr>
            <td style="padding:8px 24px 28px 24px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#64748b;">
                No action is required if you prefer to wait — your optimization limit will automatically renew at the start of next month.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8fafc;padding:18px 24px;text-align:center;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#94a3b8;">
                This is an automated message from Image Optimizer. Please do not reply to this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const textLines = [
    `Hi ${storeName || "there"},`,
    "",
    message ||
      "Your monthly image optimization limit has been reached, so your bulk optimization has been paused. Please upgrade your plan to continue now, or wait until your limit renews next month.",
  ];
  if (planName) textLines.push("", `Plan: ${planName}`);
  if (hasLimit) textLines.push(`Monthly limit: ${monthlyLimit} images`);
  if (hasUsed) textLines.push(`Used this month: ${monthlyUsed} images`);

  return { subject, html, text: textLines.join("\n") };
}

module.exports = { planLimitReachedTemplate };
