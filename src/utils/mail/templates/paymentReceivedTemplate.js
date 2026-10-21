function escapeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function linkify(value, hrefPrefix = "") {
  const raw = value == null ? "" : String(value).trim();
  if (!raw) return "";
  const href = hrefPrefix ? `${hrefPrefix}${raw}` : raw;
  return `<a href="${escapeHtml(href)}">${escapeHtml(raw)}</a>`;
}

/**
 * Client clicked Pay / opened PayPal checkout (payment process started).
 */
function paymentPageVisitTemplate(vars = {}) {
  const {
    storeUrl,
    clientEmail,
    platform = "Bigcommerce",
    app = "Image Optimizer",
  } = vars;

  const heading =
    "Below user has tried to visit the payment page for app services:";
  const subject = "Payment page visit — Image Optimizer";

  const html =
    `${escapeHtml(heading)} <br/><br/>` +
    `Store URL : ${linkify(storeUrl)} <br/><br/>` +
    `Email : ${linkify(clientEmail, "mailto:")} <br/><br/>` +
    `Platform : ${escapeHtml(platform)} <br/><br/>` +
    `App : ${escapeHtml(app)} <br/><br/>`;

  const text = [
    heading,
    `Store URL : ${storeUrl || ""}`,
    `Email : ${clientEmail || ""}`,
    `Platform : ${platform}`,
    `App : ${app}`,
  ].join("\n\n");

  return { subject, html, text };
}

/** First successful charge for a store. */
function newPaymentTemplate(vars = {}) {
  const {
    storeUrl,
    clientEmail,
    platform = "Bigcommerce",
    app = "Image Optimizer",
  } = vars;

  const subject = "New subscription payment with following detail.";

  const html =
    `${escapeHtml(subject)} <br/><br/>` +
    `Store URL : ${linkify(storeUrl)} <br/><br/>` +
    `Email : ${linkify(clientEmail, "mailto:")} <br/><br/>` +
    `Platform : ${escapeHtml(platform)} <br/><br/>` +
    `App : ${escapeHtml(app)} <br/><br/>`;

  const text = [
    subject,
    `Store URL : ${storeUrl || ""}`,
    `Email : ${clientEmail || ""}`,
    `Platform : ${platform}`,
    `App : ${app}`,
  ].join("\n\n");

  return { subject, html, text };
}

/** Renewal / 2nd+ successful charge. */
function recurringPaymentTemplate(vars = {}) {
  const {
    transactionId,
    storeUrl,
    clientEmail,
    platform = "Bigcommerce",
    app = "Image Optimizer",
  } = vars;

  const subject = "New recurring payment with following detail.";

  const html =
    `${escapeHtml(subject)} <br/><br/>` +
    `Transaction id : ${escapeHtml(transactionId || "")} <br/><br/>` +
    `Store URL : ${linkify(storeUrl)} <br/><br/>` +
    `Email : ${linkify(clientEmail, "mailto:")} <br/><br/>` +
    `Platform : ${escapeHtml(platform)} <br/><br/>` +
    `App : ${escapeHtml(app)} <br/><br/>`;

  const text = [
    subject,
    `Transaction id : ${transactionId || ""}`,
    `Store URL : ${storeUrl || ""}`,
    `Email : ${clientEmail || ""}`,
    `Platform : ${platform}`,
    `App : ${app}`,
  ].join("\n\n");

  return { subject, html, text };
}

/**
 * @param {"visit"|"new"|"recurring"} kind
 */
function paymentReceivedTemplate(vars = {}) {
  if (vars.kind === "visit") return paymentPageVisitTemplate(vars);
  if (vars.kind === "recurring") return recurringPaymentTemplate(vars);
  return newPaymentTemplate(vars);
}

module.exports = {
  paymentReceivedTemplate,
  paymentPageVisitTemplate,
  newPaymentTemplate,
  recurringPaymentTemplate,
};
