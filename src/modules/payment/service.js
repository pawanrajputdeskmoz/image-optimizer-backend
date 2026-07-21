const axios = require("axios");
const config = require("../../config");
const PaymentHistory = require("../../models/PaymentHistory");
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

    // Clean up this store's leftover PENDING records for the current month before
    // creating a new one: expire the stale ones (>3h old) and drop recent duplicates.
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
 * The plan is read from the stored payment record (not the client) to prevent tampering.
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

    // Atomically move PENDING -> COMPLETED to guard against double capture.
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

    // Activate the paid plan (assigns ClientPlan, updates selectedPlan, syncs quota).
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
