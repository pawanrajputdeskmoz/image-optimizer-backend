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
 * Builds the internal install-notification email (sent to SeoKart, not the merchant).
 *
 * @param {Object} vars
 * @param {string} [vars.storeName]
 * @param {string} [vars.storeHash]
 * @param {string} [vars.storeUrl]
 * @param {string} [vars.domain]
 * @param {string} [vars.clientEmail]
 * @param {string} [vars.clientName]
 * @param {string} [vars.currency]
 * @param {string|number} [vars.storeId]
 * @param {string} [vars.scope]
 * @param {Date|string} [vars.installedAt]
 * @returns {{ subject: string, html: string, text: string }}
 */
function installNotificationTemplate(vars = {}) {
  const {
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
  } = vars;

  const displayStore = storeName || storeHash || "Unknown store";
  const installedLabel = installedAt
    ? new Date(installedAt).toISOString()
    : new Date().toISOString();

  const subject = `Image Optimizer installed — ${displayStore}`;

  const rows = [
    ["Store name", storeName],
    ["Store hash", storeHash],
    ["Store ID", storeId != null ? String(storeId) : null],
    ["Store URL", storeUrl],
    ["Domain", domain],
    ["Client email", clientEmail],
    ["Client name", clientName],
    ["Currency", currency],
    ["OAuth scope", scope],
    ["Installed at (UTC)", installedLabel],
  ].filter(([, value]) => value != null && String(value).trim() !== "");

  const detailRowsHtml = rows
    .map(
      ([label, value]) => `
                    <tr>
                      <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#64748b;width:140px;vertical-align:top;">
                        ${escapeHtml(label)}
                      </td>
                      <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;word-break:break-word;">
                        ${escapeHtml(value)}
                      </td>
                    </tr>`
    )
    .join("");

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
            <td style="background-color:#0f172a;padding:28px 24px;text-align:center;">
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:1.3;color:#ffffff;font-weight:700;">
                Image Optimizer — New Install
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 24px 8px 24px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#334155;">
                A BigCommerce store has installed Image Optimizer. Details below:
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px 28px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                      ${detailRowsHtml}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8fafc;padding:18px 24px;text-align:center;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#94a3b8;">
                Automated install notification — Image Optimizer
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
    "Image Optimizer — New Install",
    "",
    "A BigCommerce store has installed Image Optimizer.",
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
  ];

  return { subject, html, text: textLines.join("\n") };
}

module.exports = { installNotificationTemplate };
