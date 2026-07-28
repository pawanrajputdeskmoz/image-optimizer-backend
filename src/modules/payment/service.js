const axios = require("axios");
const config = require("../../config");
const PaymentHistory = require("../../models/PaymentHistory");
const Plan = require("../../models/Plan");
const ClientPlan = require("../../models/ClientPlan");
const User = require("../../models/User");
const { getPlanBySlug, upgradeStorePlan } = require("../plans/service");
const { syncCurrentMonthUsage } = require("../../utils/monthlyUsage");

let cachedToken = null;
let tokenExpiresAt = 0;

async function getPaypalAccessToken() {
  const { clientId, clientSecret, baseUrl } = config.paypal;
  if (!clientId || !clientSecret) {
    throw new Error("PayPal credentials are not configured");
  }

  if (cachedToken && tokenExpiresAt > Date.now() + 30_000) {
    return cachedToken;
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const { data } = await axios.post(
    `${baseUrl}/v1/oauth2/token`,
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 20_000,
    }
  );

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (Number(data.expires_in) || 3000) * 1000;
  return cachedToken;
}

function paypalErrorMessage(err) {
  const details = err?.response?.data;
  return (
    details?.message ||
    details?.error_description ||
    details?.name ||
    err?.message ||
    "PayPal request failed"
  );
}

function trim(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function mapPaypalStatus(paypalStatus) {
  const status = String(paypalStatus || "").toUpperCase();
  if (status === "ACTIVE") return "active";
  if (status === "CANCELLED" || status === "CANCELED") return "cancel";
  return "pending";
}

async function findClientPlan({ storeHash = null, subscriptionId = null }) {
  const or = [];
  if (subscriptionId) or.push({ paypal_subscription_id: subscriptionId });
  if (storeHash) or.push({ store_hash: storeHash });
  if (!or.length) return null;
  return ClientPlan.findOne(or.length === 1 ? or[0] : { $or: or }).lean();
}

async function resolvePlan(paypalPlanId, fallbackSlug) {
  if (paypalPlanId) {
    const byPaypal = await Plan.findOne({ paypal_plan_id: paypalPlanId, is_active: true }).lean();
    if (byPaypal) return byPaypal;
  }
  if (fallbackSlug) {
    return getPlanBySlug(fallbackSlug, { activeOnly: true });
  }
  return null;
}

async function saveSubscriptionPayment({
  storeHash,
  subscriptionId,
  plan,
  payerEmail = null,
}) {
  if (!storeHash || !subscriptionId || !plan) return;

  const planId = plan._id || plan.id || null;

  await PaymentHistory.findOneAndUpdate(
    { paypal_order_id: subscriptionId },
    {
      $set: {
        store_hash: storeHash,
        plan_id: planId,
        plan_slug: plan.slug,
        plan_name: plan.name,
        amount: Number(plan.price) || 0,
        currency: plan.currency || "USD",
        status: "COMPLETED",
        payment_method: "PAYPAL_SUBSCRIPTION",
        payer_email: payerEmail,
        paid_at: new Date(),
      },
      $setOnInsert: { paypal_order_id: subscriptionId },
    },
    { upsert: true }
  );
}

/**
 * Upsert ClientPlan subscription state.
 * Pending: only PayPal ids + pending status (do NOT change plan yet).
 * Active: upgrade store plan, sync monthly usage limit, save payment history.
 */
async function syncSubscription({
  storeHash = null,
  subscriptionId = null,
  paypalPlanId = null,
  status = "pending",
  activate = false,
  payerEmail = null,
}) {
  const existing = await findClientPlan({ storeHash, subscriptionId });
  const resolvedStoreHash = storeHash || existing?.store_hash || null;
  if (!resolvedStoreHash || !subscriptionId) return null;

  const resolvedPaypalPlanId = paypalPlanId || existing?.paypal_plan_id || null;
  const plan = await resolvePlan(resolvedPaypalPlanId, null);

  // Pending checkout: link subscription only — keep current plan/limit untouched.
  if (!activate && status !== "active") {
    await ClientPlan.findOneAndUpdate(
      { store_hash: resolvedStoreHash },
      {
        $set: {
          assigned_by: "client",
          paypal_subscription_id: subscriptionId,
          subscription_status: status,
          ...(resolvedPaypalPlanId ? { paypal_plan_id: resolvedPaypalPlanId } : {}),
        },
        $setOnInsert: {
          store_hash: resolvedStoreHash,
          base_plan_slug: existing?.base_plan_slug || "free",
          started_at: new Date(),
        },
      },
      { upsert: true }
    );
    return { storeHash: resolvedStoreHash, plan, status };
  }

  if (!plan?.slug) return null;

  const planId = plan._id || plan.id || null;

  // Activate paid plan. upgradeStorePlan may no-op if ClientPlan was already
  // marked early; always sync monthly usage + selectedPlan after that.
  await upgradeStorePlan(resolvedStoreHash, plan.slug);
  await Promise.all([
    User.updateOne(
      { store_hash: resolvedStoreHash },
      { $set: { selectedPlan: plan.slug } }
    ),
    syncCurrentMonthUsage(
      resolvedStoreHash,
      plan.slug,
      plan.monthly_image_limit,
      null,
      planId
    ),
    ClientPlan.findOneAndUpdate(
      { store_hash: resolvedStoreHash },
      {
        $set: {
          assigned_by: "client",
          paypal_subscription_id: subscriptionId,
          paypal_plan_id: resolvedPaypalPlanId || plan.paypal_plan_id || null,
          subscription_status: "active",
          base_plan_slug: plan.slug,
          plan_id: planId,
        },
        $setOnInsert: {
          store_hash: resolvedStoreHash,
          started_at: new Date(),
        },
      },
      { upsert: true }
    ),
    saveSubscriptionPayment({
      storeHash: resolvedStoreHash,
      subscriptionId,
      plan,
      payerEmail,
    }),
  ]);

  return { storeHash: resolvedStoreHash, plan, status: "active" };
}

/** Create a PayPal billing subscription for a paid plan. */
exports.createSubscription = async (storeHash, planId) => {
  const slug = String(planId || "").trim().toLowerCase();
  if (!storeHash || !slug) {
    return { error: "planId is required", code: "INVALID_REQUEST", statusCode: 400 };
  }

  const plan = await Plan.findOne({ slug, is_active: true }).lean();
  if (!plan) {
    return { error: "Plan not found", code: "PLAN_NOT_FOUND", statusCode: 404 };
  }
  if (!plan.paypal_plan_id) {
    return {
      error: "Plan is not registered on PayPal yet. Ask admin to update the plan price.",
      code: "PAYPAL_PLAN_MISSING",
      statusCode: 400,
    };
  }
  if (!(Number(plan.price) > 0)) {
    return { error: "This plan does not require payment", code: "FREE_PLAN", statusCode: 400 };
  }

  try {
    const accessToken = await getPaypalAccessToken();
    const { baseUrl, subscriptionReturnUrl, subscriptionCancelUrl } = config.paypal;

    const { data, status } = await axios.post(
      `${baseUrl}/v1/billing/subscriptions`,
      {
        plan_id: plan.paypal_plan_id,
        custom_id: storeHash,
        application_context: {
          brand_name: "Image Optimizer",
          user_action: "SUBSCRIBE_NOW",
          return_url: subscriptionReturnUrl,
          cancel_url: subscriptionCancelUrl,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
        validateStatus: () => true,
      }
    );

    if (status >= 400 || !data?.id) {
      return {
        error: data?.message || data?.name || "PayPal subscription create failed",
        code: "PAYPAL_SUBSCRIPTION_FAILED",
        statusCode: 502,
        data,
      };
    }

    await syncSubscription({
      storeHash,
      subscriptionId: data.id,
      paypalPlanId: plan.paypal_plan_id,
      status: "pending",
    });

    const approvalUrl = data?.links?.find((l) => l.rel === "approve")?.href || null;
    return {
      error: null,
      statusCode: status,
      data,
      subscriptionId: data.id,
      approvalUrl,
    };
  } catch (err) {
    return {
      error: paypalErrorMessage(err),
      code: "PAYPAL_SUBSCRIPTION_FAILED",
      statusCode: 502,
    };
  }
};

/** Verify PayPal webhook signature and apply subscription lifecycle events. */
exports.handlePaypalWebhook = async (headers, event) => {
  if (!event || typeof event !== "object") {
    return { error: "Invalid webhook body", statusCode: 400 };
  }

  const webhookId = config.paypal.webhookId;
  if (!webhookId) {
    return { error: "PAYPAL_WEBHOOK_ID is not configured", statusCode: 500 };
  }

  try {
    const accessToken = await getPaypalAccessToken();
    const { baseUrl } = config.paypal;

    const { data: verification } = await axios.post(
      `${baseUrl}/v1/notifications/verify-webhook-signature`,
      {
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: event,
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
      }
    );

    if (verification?.verification_status !== "SUCCESS") {
      return { error: "invalid signature", statusCode: 400 };
    }

    const resource = event.resource || {};
    const storeHash = trim(resource.custom_id);
    const subscriptionId = trim(resource.id);
    const paypalPlanId = trim(resource.plan_id);
    const payerEmail = resource.subscriber?.email_address || null;
    const eventType = event.event_type;

    if (!subscriptionId && !storeHash) {
      return { error: null, received: true };
    }

    if (eventType === "BILLING.SUBSCRIPTION.CREATED") {
      await syncSubscription({
        storeHash,
        subscriptionId,
        paypalPlanId,
        status: mapPaypalStatus(resource.status),
      });
    } else if (
      eventType === "BILLING.SUBSCRIPTION.ACTIVATED" ||
      eventType === "BILLING.SUBSCRIPTION.RE-ACTIVATED"
    ) {
      await syncSubscription({
        storeHash,
        subscriptionId,
        paypalPlanId,
        status: "active",
        activate: true,
        payerEmail,
      });
    } else if (eventType === "BILLING.SUBSCRIPTION.CANCELLED") {
      await syncSubscription({
        storeHash,
        subscriptionId,
        paypalPlanId,
        status: "cancel",
      });
    } else if (eventType === "BILLING.SUBSCRIPTION.UPDATED") {
      const mappedStatus = mapPaypalStatus(resource.status);
      await syncSubscription({
        storeHash,
        subscriptionId,
        paypalPlanId,
        status: mappedStatus,
        activate: mappedStatus === "active",
        payerEmail,
      });
    }

    return { error: null, received: true };
  } catch (err) {
    console.error("[paypal-webhook]", err);
    return { error: paypalErrorMessage(err), statusCode: 500 };
  }
};

/** Return subscription status for this store (used by frontend after PayPal approval). */
exports.getSubscriptionStatus = async (storeHash, subscriptionId) => {
  const id = trim(subscriptionId);
  if (!storeHash || !id) {
    return { error: "subscription id is required", statusCode: 400, status: null };
  }

  const clientPlan = await ClientPlan.findOne({
    store_hash: storeHash,
    paypal_subscription_id: id,
  })
    .select({ subscription_status: 1, base_plan_slug: 1 })
    .lean();

  if (!clientPlan) {
    return { error: null, status: "pending", plan_slug: null, plan_name: null };
  }

  const status = clientPlan.subscription_status || "pending";
  let planName = null;
  if (clientPlan.base_plan_slug) {
    const plan = await getPlanBySlug(clientPlan.base_plan_slug, { activeOnly: true });
    planName = plan?.name || null;
  }

  return {
    error: null,
    status,
    plan_slug: clientPlan.base_plan_slug || null,
    plan_name: planName,
  };
};

/** Client payment history (latest first). */
exports.listPaymentHistory = async (storeHash) => {
  const rows = await PaymentHistory.find({ store_hash: storeHash })
    .sort({ created_at: -1 })
    .select({ paypal_response: 0 })
    .lean();

  return rows.map((row) => ({
    plan_slug: row.plan_slug,
    plan_name: row.plan_name,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    payment_method: row.payment_method,
    paypal_order_id: row.paypal_order_id,
    capture_id: row.capture_id,
    payer_email: row.payer_email,
    paid_at: row.paid_at,
    created_at: row.created_at,
  }));
};
