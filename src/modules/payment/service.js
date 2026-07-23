const axios = require("axios");
const config = require("../../config");
const PaymentHistory = require("../../models/PaymentHistory");
const Plan = require("../../models/Plan");
const ClientPlan = require("../../models/ClientPlan");
const {
  getPlanBySlug,
  getEffectivePlanForStore,
  upgradeStorePlan,
} = require("../plans/service");

let cachedToken = null;
let tokenExpiresAt = 0;

/** Get a PayPal OAuth token (cached until ~30s before expiry). Secret stays server-side. */
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

/** Normalize PayPal/axios errors to a readable message. */
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

/**
 * Create a PayPal order for a paid plan upgrade.
 * Price/currency always come from the Plan document — never from the client.
 */
exports.createPlanOrder = async (storeHash, planId, userId = null) => {
  const slug = String(planId || "").trim().toLowerCase();
  if (!storeHash || !slug) {
    return { error: "planId is required", code: "INVALID_REQUEST", statusCode: 400 };
  }

  const [targetPlan, currentPlan] = await Promise.all([
    getPlanBySlug(slug, { activeOnly: true }),
    getEffectivePlanForStore(storeHash),
  ]);

  if (!targetPlan) {
    return { error: "Plan not found", code: "PLAN_NOT_FOUND", statusCode: 404 };
  }

  const amount = Number(targetPlan.price);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "This plan does not require payment", code: "FREE_PLAN", statusCode: 400 };
  }

  if (currentPlan?.slug === targetPlan.slug) {
    return { error: "You are already on this plan", code: "SAME_PLAN", statusCode: 409 };
  }

  if (Number(targetPlan.display_order) <= Number(currentPlan?.display_order || 0)) {
    return {
      error: "Target plan must be higher than your current plan",
      code: "NOT_AN_UPGRADE",
      statusCode: 400,
    };
  }

  try {
    const accessToken = await getPaypalAccessToken();
    const { baseUrl, returnUrl, cancelUrl } = config.paypal;

    const { data: order } = await axios.post(
      `${baseUrl}/v2/checkout/orders`,
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: `${storeHash}:${targetPlan.slug}`,
            description: targetPlan.name,
            amount: {
              currency_code: (targetPlan.currency || "USD").toUpperCase(),
              value: amount.toFixed(2),
            },
          },
        ],
        application_context: {
          brand_name: "Image Optimizer",
          user_action: "PAY_NOW",
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
      }
    );

    const approvalUrl = order?.links?.find((l) => l.rel === "approve")?.href || null;
    if (!order?.id || !approvalUrl) {
      return { error: "PayPal did not return a valid order", code: "PAYPAL_ORDER_FAILED", statusCode: 502 };
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);

    await Promise.all([
      PaymentHistory.updateMany(
        {
          store_hash: storeHash,
          status: "PENDING",
          created_at: { $gte: monthStart, $lte: threeHoursAgo },
        },
        { $set: { status: "EXPIRED" } }
      ),
      PaymentHistory.deleteMany({
        store_hash: storeHash,
        status: "PENDING",
        created_at: { $gte: monthStart, $gt: threeHoursAgo },
      }),
    ]);

    await PaymentHistory.create({
      user_id: userId,
      plan_id: targetPlan.id,
      store_hash: storeHash,
      plan_slug: targetPlan.slug,
      plan_name: targetPlan.name,
      amount,
      currency: targetPlan.currency || "USD",
      status: "PENDING",
      paypal_order_id: order.id,
      paypal_response: order,
    });

    return { error: null, paypalOrderId: order.id, approvalUrl };
  } catch (err) {
    return { error: paypalErrorMessage(err), code: "PAYPAL_ORDER_FAILED", statusCode: 502 };
  }
};

/**
 * Capture an approved PayPal order, activate the plan, and finalize payment history.
 */
exports.capturePlanOrder = async (storeHash, paypalOrderId) => {
  const orderId = String(paypalOrderId || "").trim();
  if (!storeHash || !orderId) {
    return { error: "paypalOrderId is required", code: "INVALID_REQUEST", statusCode: 400 };
  }

  const record = await PaymentHistory.findOne({
    store_hash: storeHash,
    paypal_order_id: orderId,
  }).lean();

  if (!record) {
    return { error: "Payment record not found", code: "ORDER_NOT_FOUND", statusCode: 404 };
  }

  if (record.status === "COMPLETED") {
    return { error: "Payment has already been captured", code: "ALREADY_CAPTURED", statusCode: 409 };
  }

  try {
    const accessToken = await getPaypalAccessToken();
    const { baseUrl } = config.paypal;

    const { data: capture } = await axios.post(
      `${baseUrl}/v2/checkout/orders/${orderId}/capture`,
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
      }
    );

    const captureUnit = capture?.purchase_units?.[0]?.payments?.captures?.[0];
    const completed = capture?.status === "COMPLETED" || captureUnit?.status === "COMPLETED";

    if (!completed) {
      await PaymentHistory.updateOne(
        { _id: record._id, status: "PENDING" },
        { $set: { status: "FAILED", paypal_response: capture } }
      );
      return { error: "PayPal payment was not completed", code: "PAYMENT_NOT_COMPLETED", statusCode: 402 };
    }

    const finalized = await PaymentHistory.findOneAndUpdate(
      { _id: record._id, status: "PENDING" },
      {
        $set: {
          status: "COMPLETED",
          capture_id: captureUnit?.id || null,
          payer_id: capture?.payer?.payer_id || null,
          payer_email: capture?.payer?.email_address || null,
          paypal_response: capture,
          paid_at: new Date(),
        },
      },
      { new: true }
    ).lean();

    if (!finalized) {
      return { error: "Payment has already been captured", code: "ALREADY_CAPTURED", statusCode: 409 };
    }

    const upgrade = await upgradeStorePlan(storeHash, record.plan_slug);

    return {
      error: null,
      message: "Payment successful",
      subscription: {
        plan_slug: record.plan_slug,
        plan_name: record.plan_name,
        amount: record.amount,
        currency: record.currency,
        status: upgrade.error ? "PENDING_ACTIVATION" : "ACTIVE",
        capture_id: finalized.capture_id,
        payer_email: finalized.payer_email,
        paid_at: finalized.paid_at,
      },
    };
  } catch (err) {
    await PaymentHistory.updateOne(
      { _id: record._id, status: "PENDING" },
      { $set: { status: "FAILED" } }
    ).catch(() => {});
    return { error: paypalErrorMessage(err), code: "PAYPAL_CAPTURE_FAILED", statusCode: 502 };
  }
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

/**
 * Create a PayPal billing subscription for a paid plan that has paypal_plan_id.
 */
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

/**
 * Verify PayPal webhook signature and apply subscription lifecycle events.
 * ClientPlan is unique on store_hash — always upsert/update that single row.
 */
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
      console.warn("[paypal-webhook] invalid signature", verification);
      return { error: "invalid signature", statusCode: 400 };
    }

    const resource = event.resource || {};
    const storeHash = String(resource.custom_id || "").trim() || null;
    const subscriptionId = resource.id || null;
    const paypalPlanId = resource.plan_id || null;
    const eventType = event.event_type;

    if (eventType === "BILLING.SUBSCRIPTION.ACTIVATED") {
      if (!storeHash || !subscriptionId || !paypalPlanId) {
        return { error: null, received: true };
      }

      const plan = await Plan.findOne({ paypal_plan_id: paypalPlanId }).lean();
      if (!plan) {
        return { error: null, received: true };
      }

      await upgradeStorePlan(storeHash, plan.slug);

      await ClientPlan.findOneAndUpdate(
        { store_hash: storeHash },
        {
          $set: {
            base_plan_slug: plan.slug,
            plan_id: plan._id,
            assigned_by: "client",
            started_at: new Date(),
            paypal_subscription_id: subscriptionId,
            paypal_plan_id: paypalPlanId,
            subscription_status: "active",
          },
          $setOnInsert: { store_hash: storeHash },
        },
        { upsert: true }
      );
    } else if (eventType === "BILLING.SUBSCRIPTION.CANCELLED") {
      if (!subscriptionId && !storeHash) {
        return { error: null, received: true };
      }

      await ClientPlan.findOneAndUpdate(
        subscriptionId
          ? { paypal_subscription_id: subscriptionId }
          : { store_hash: storeHash },
        { $set: { subscription_status: "cancel" } }
      );
    } else if (eventType === "BILLING.SUBSCRIPTION.RE-ACTIVATED") {
      const or = [];
      if (subscriptionId) or.push({ paypal_subscription_id: subscriptionId });
      if (storeHash) or.push({ store_hash: storeHash });

      const clientPlan = or.length
        ? await ClientPlan.findOne(or.length === 1 ? or[0] : { $or: or }).lean()
        : null;

      const resolvedStoreHash = storeHash || clientPlan?.store_hash || null;
      const resolvedPaypalPlanId = paypalPlanId || clientPlan?.paypal_plan_id || null;
      if (!resolvedStoreHash || !subscriptionId) {
        return { error: null, received: true };
      }

      let plan = null;
      if (resolvedPaypalPlanId) {
        plan = await Plan.findOne({ paypal_plan_id: resolvedPaypalPlanId }).lean();
      } else if (clientPlan?.base_plan_slug) {
        plan = await Plan.findOne({ slug: clientPlan.base_plan_slug, is_active: true }).lean();
      }
      if (!plan) {
        return { error: null, received: true };
      }

      await upgradeStorePlan(resolvedStoreHash, plan.slug);

      await ClientPlan.findOneAndUpdate(
        { store_hash: resolvedStoreHash },
        {
          $set: {
            base_plan_slug: plan.slug,
            plan_id: plan._id,
            assigned_by: "client",
            paypal_subscription_id: subscriptionId,
            paypal_plan_id: resolvedPaypalPlanId || plan.paypal_plan_id || null,
            subscription_status: "active",
          },
          $setOnInsert: {
            store_hash: resolvedStoreHash,
            started_at: new Date(),
          },
        },
        { upsert: true }
      );
    } else if (eventType === "BILLING.SUBSCRIPTION.UPDATED") {
      const filter = subscriptionId
        ? { paypal_subscription_id: subscriptionId }
        : storeHash
          ? { store_hash: storeHash }
          : null;
      if (!filter) {
        return { error: null, received: true };
      }

      const $set = {};
      if (subscriptionId) $set.paypal_subscription_id = subscriptionId;
      if (paypalPlanId) $set.paypal_plan_id = paypalPlanId;

      const paypalStatus = String(resource.status || "").toUpperCase();
      if (paypalStatus === "ACTIVE") $set.subscription_status = "active";
      if (paypalStatus === "CANCELLED" || paypalStatus === "CANCELED") {
        $set.subscription_status = "cancel";
      }

      if (paypalPlanId) {
        const plan = await Plan.findOne({ paypal_plan_id: paypalPlanId }).lean();
        if (plan) {
          $set.base_plan_slug = plan.slug;
          $set.plan_id = plan._id;
        }
      }

      if (Object.keys($set).length > 0) {
        await ClientPlan.findOneAndUpdate(filter, { $set });
      }
    }

    return { error: null, received: true };
  } catch (err) {
    console.error("[paypal-webhook]", err);
    return { error: paypalErrorMessage(err), statusCode: 500 };
  }
};

/** Poll whether a PayPal subscription is active for this store. */
exports.getSubscriptionStatus = async (storeHash, subscriptionId) => {
  const id = String(subscriptionId || "").trim();
  if (!storeHash || !id) {
    return { error: "subscription id is required", statusCode: 400, status: null };
  }

  const clientPlan = await ClientPlan.findOne({
    store_hash: storeHash,
    paypal_subscription_id: id,
  })
    .select({ subscription_status: 1 })
    .lean();

  return {
    error: null,
    status: clientPlan?.subscription_status === "active" ? "active" : "cancel",
  };
};
