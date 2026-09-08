const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_SMTP_HOST || process.env.SMTP_HOST,
  port: Number(process.env.EMAIL_SMTP_PORT || process.env.SMTP_PORT) || 587,
  secure:
    process.env.EMAIL_SMTP_SECURE === "true" ||
    process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.EMAIL_SMTP_USER || process.env.SMTP_USER,
    pass: process.env.EMAIL_SMTP_PASSWORD || process.env.SMTP_PASS,
  },
});

/**
 * Simple nodemailer send — mirrors Bulk Optimizer style.
 *
 * @param {Object} params
 * @param {string} params.to
 * @param {string} params.subject
 * @param {string} params.html
 * @param {string} [params.text]
 * @param {string} [params.cc]
 * @param {string} [params.replyTo]
 * @param {string} [params.from]
 */
async function sendMail({
  to,
  subject,
  html,
  text,
  cc,
  replyTo,
  from,
} = {}) {
  if (process.env.MAIL_ENABLED === "false") {
    console.log("[sendMail] mail disabled — skipping", { to, subject });
    return { sent: false, skipped: true, reason: "MAIL_DISABLED" };
  }

  if (!to) {
    return { sent: false, skipped: true, reason: "NO_RECIPIENT" };
  }

  const fromAddress =
    from ||
    process.env.EMAIL_FROM ||
    process.env.MAIL_FROM_EMAIL ||
    undefined;

  try {
    const info = await transporter.sendMail({
      from: fromAddress,
      to,
      cc: cc || undefined,
      replyTo: replyTo || undefined,
      subject,
      html,
      text,
    });
    console.log("[sendMail] sent", { to, cc, subject, messageId: info.messageId });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error("[sendMail] failed", { to, subject, error: err?.message });
    return { sent: false, error: err?.message };
  }
}

module.exports = { sendMail, transporter };
