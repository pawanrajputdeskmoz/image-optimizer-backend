function escapeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** PHP: list($name) = explode(' ', $name); — first word only */
function firstName(name) {
  if (!name || !String(name).trim()) return "";
  return String(name).trim().split(/\s+/)[0];
}

/**
 * Uninstall notification body — matches SEOKart PHP template.
 *
 * @returns {{ subject: string, html: string, text: string }}
 */
function uninstallNotificationTemplate(vars = {}) {
  const {
    storeHash,
    storeUrl,
    storeAddress,
    clientEmail,
    clientName,
    platform = "Bigcommerce",
  } = vars;

  const name = firstName(clientName);
  const subject = "Oops! What happened?";

  const html =
    `Subject: ${escapeHtml(subject)} <br/><br/>` +
    `Name: ${escapeHtml(name)} <br/><br/>` +
    `Email: ${escapeHtml(clientEmail || "")} <br/><br/>` +
    `Address: ${escapeHtml(storeAddress || "")} <br/><br/>` +
    `Store Url: ${escapeHtml(storeUrl || "")} <br/><br/>` +
    `Store Hash: ${escapeHtml(storeHash || "")} <br/><br/>` +
    `Platform: ${escapeHtml(platform)} <br/><br/>`;

  const text = [
    `Subject: ${subject}`,
    `Name: ${name}`,
    `Email: ${clientEmail || ""}`,
    `Address: ${storeAddress || ""}`,
    `Store Url: ${storeUrl || ""}`,
    `Store Hash: ${storeHash || ""}`,
    `Platform: ${platform}`,
  ].join("\n\n");

  return { subject, html, text };
}

module.exports = { uninstallNotificationTemplate };
