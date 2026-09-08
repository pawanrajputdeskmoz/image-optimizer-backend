const nodemailer = require("nodemailer");
const config = require("../../config");

let transporter = null;

/**
 * Lazily builds (and caches) the SMTP transporter from config.mail.
 * Returns null when SMTP host is not configured.
 */
function getTransporter() {
  if (transporter) return transporter;

  const { host, port, secure, user, pass } = config.mail;
  if (!host) return null;

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
  });

  return transporter;
}

/**
 * Sends an email using the configured SMTP transport.
 *
 * @param {Object} params
 * @param {string} params.to        Recipient email address.
 * @param {string} params.subject   Email subject line.
 * @param {string} params.html      HTML body.
 * @param {string} [params.text]    Optional plain-text fallback body.
 * @returns {Promise<{ sent: boolean, skipped?: boolean, reason?: string, messageId?: string, error?: string }>}
 */
async function sendMail({ to, subject, html, text } = {}) {
  if (!config.mail.enabled) {
    console.log("[sendMail] mail disabled — skipping", { to, subject });
    return { sent: false, skipped: true, reason: "MAIL_DISABLED" };
  }

  if (!to) {
    return { sent: false, skipped: true, reason: "NO_RECIPIENT" };
  }

  const tx = getTransporter();
  if (!tx) {
    console.warn("[sendMail] SMTP not configured (SMTP_HOST missing) — skipping", {
      to,
      subject,
    });
    return { sent: false, skipped: true, reason: "SMTP_NOT_CONFIGURED" };
  }

  const from = `"${config.mail.fromName}" <${config.mail.fromEmail}>`;
  const info = await tx.sendMail({ from, to, subject, html, text });
  console.log("[sendMail] sent",  to, subject,info.messageId );

  try {
 
    console.log("[sendMail] sent", { to, subject, messageId: info.messageId });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error("[sendMail] failed", { to, subject, error: err?.message });
    return { sent: false, error: err?.message };
  }
}

module.exports = { sendMail };
