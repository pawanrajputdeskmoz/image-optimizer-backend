const User = require("../models/User");
const PlanLimitNotification = require("../models/PlanLimitNotification");
const { sendMail } = require("./mail/sendMail");
const {
  planLimitReachedTemplate,
} = require("./mail/templates/planLimitReachedTemplate");

function getYearMonth(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Sends (or logs) a one-per-store-per-month plan limit notification.
 */
async function notifyPlanLimitReached(storeHash, payload = {}) {
  if (!storeHash) {
    return { sent: false, error: "storeHash is required" };
  }

  const yearMonth = getYearMonth();
  const existing = await PlanLimitNotification.findOne({
    store_hash: storeHash,
    year_month: yearMonth,
  }).lean();

  if (existing) {
    return { sent: false, duplicate: true, error: null };
  }

  const user = await User.findOne({ store_hash: storeHash, installStatus: "installed" })
    .select({ email: 1, store_name: 1 })
    .lean();

  const message =
    payload.message ||
    "Your monthly image optimization limit has been reached. Please wait until next month or upgrade your plan, then try again.";

  await PlanLimitNotification.create({
    store_hash: storeHash,
    year_month: yearMonth,
    email: user?.email || null,
    message,
  });

  console.log("[plan-limit-notify]", {
    store_hash: storeHash,
    email: user?.email || "(no email)",
    store_name: user?.store_name || null,
    message,
  });

  let emailed = false;
  if (user?.email) {
    const { subject, html, text } = planLimitReachedTemplate({
      storeName: user.store_name || null,
      planName: payload.planName || null,
      monthlyLimit: payload.monthlyLimit ?? null,
      monthlyUsed: payload.monthlyUsed ?? null,
      message,
    });

    const mailResult = await sendMail({
      to: user.email,
      subject,
      html,
      text,
    }).catch((err) => {
      console.error("[plan-limit-notify] email send failed", err?.message);
      return { sent: false, error: err?.message };
    });

    emailed = Boolean(mailResult?.sent);
  }

  return {
    sent: true,
    duplicate: false,
    error: null,
    email: user?.email || null,
    emailed,
  };
}

module.exports = { notifyPlanLimitReached, getYearMonth };
