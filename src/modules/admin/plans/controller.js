const Plan = require("../../../models/Plan");
const { listPlans, updatePlans } = require("../../plans/service");
const { createPaypalBillingPlan } = require("./paypalBilling");
const { sendSuccess, sendError } = require("../utils/response");

exports.listPlans = async (req, reply) => {
  const plans = await listPlans();
  return sendSuccess(reply, {
    message: "Plans list",
    data: { plans },
  });
};

/**
 * Update plan fields. When a paid plan's amount changes (or has no PayPal plan yet),
 * register a new PayPal billing plan and store paypal_plan_id.
 */
exports.updatePlans = async (req, reply) => {
  const plansPayload = req.body?.plans;
  if (!Array.isArray(plansPayload) || !plansPayload.length) {
    return sendError(reply, {
      message: "plans array is required and must not be empty",
      statusCode: 400,
    });
  }

  const slugs = plansPayload
    .map((entry) => String(entry?.slug || "").trim().toLowerCase())
    .filter(Boolean);

  const existingPlans = await Plan.find({ slug: { $in: slugs } })
    .select({
      slug: 1,
      name: 1,
      description: 1,
      price: 1,
      currency: 1,
      paypal_plan_id: 1,
    })
    .lean();

  const existingBySlug = new Map(existingPlans.map((p) => [p.slug, p]));

  const { error, plans: updated } = await updatePlans(plansPayload);
  if (error) {
    const statusCode = String(error).includes("not found") ? 404 : 400;
    return sendError(reply, { message: error, statusCode });
  }

  for (const entry of plansPayload) {
    const slug = String(entry?.slug || "").trim().toLowerCase();
    if (!slug || entry.price == null) continue;

    const nextPrice = Number(entry.price);
    if (!Number.isFinite(nextPrice) || nextPrice <= 0) continue;

    const before = existingBySlug.get(slug);
    if (!before) continue;

    const priceChanged = Number(before.price) !== nextPrice;
    const missingPaypalPlan = !before.paypal_plan_id;
    if (!priceChanged && !missingPaypalPlan) continue;

    const updatedPlan = updated.find((p) => p.slug === slug) || before;
    const currency =
      entry.currency != null
        ? String(entry.currency).trim().toUpperCase()
        : updatedPlan.currency || before.currency || "USD";

    const paypal = await createPaypalBillingPlan({
      name: updatedPlan.name || before.name || slug,
      description: updatedPlan.description || before.description || null,
      price: nextPrice,
      currency,
    });

    if (paypal.error || !paypal.planId) {
      return sendError(reply, {
        message: `Plan "${slug}" updated in DB, but PayPal registration failed: ${paypal.error || "unknown error"}`,
        statusCode: 502,
      });
    }

    const saved = await Plan.findOneAndUpdate(
      { slug },
      { $set: { paypal_plan_id: paypal.planId } },
      { returnDocument: "after" }
    ).lean();

    if (saved) {
      const idx = updated.findIndex((p) => p.slug === slug);
      if (idx >= 0) {
        updated[idx] = {
          ...updated[idx],
          paypal_plan_id: saved.paypal_plan_id || null,
        };
      }
    }
  }

  return sendSuccess(reply, {
    message: "Plans updated",
    data: { plans: updated },
  });
};
