const axios = require("axios");
const config = require("../../../config");

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
  const detailText = Array.isArray(details?.details)
    ? details.details.map((d) => d?.description || d?.issue).filter(Boolean).join("; ")
    : null;
  return (
    detailText ||
    details?.message ||
    details?.error_description ||
    details?.name ||
    err?.message ||
    "PayPal request failed"
  );
}

/**
 * Create a PayPal Catalog product + monthly billing plan for an admin Plan.
 * PayPal billing plans are immutable for price — call again when amount changes.
 * Product is created fresh each time (not stored in DB).
 */
async function createPaypalBillingPlan({
  name,
  description = null,
  price,
  currency = "USD",
}) {
  const amount = Number(price);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "PayPal billing plan requires a positive price", planId: null };
  }

  const planName = String(name || "").trim() || "Paid Plan";
  const currencyCode = String(currency || "USD").trim().toUpperCase() || "USD";
  const { baseUrl } = config.paypal;

  try {
    const accessToken = await getPaypalAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    const { data: product } = await axios.post(
      `${baseUrl}/v1/catalogs/products`,
      {
        name: planName,
        type: "SERVICE",
        category: "SOFTWARE",
        ...(description ? { description: String(description).slice(0, 127) } : {}),
      },
      { headers, timeout: 30_000 }
    );

    const productId = product?.id || null;
    if (!productId) {
      return { error: "PayPal did not return a product id", planId: null };
    }

    const { data: billingPlan } = await axios.post(
      `${baseUrl}/v1/billing/plans`,
      {
        product_id: productId,
        name: `${planName} Monthly`,
        ...(description ? { description: String(description).slice(0, 127) } : {}),
        billing_cycles: [
          {
            frequency: { interval_unit: "MONTH", interval_count: 1 },
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: {
              fixed_price: {
                value: amount.toFixed(2),
                currency_code: currencyCode,
              },
            },
          },
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          payment_failure_threshold: 3,
        },
      },
      { headers, timeout: 30_000 }
    );

    const planId = billingPlan?.id || null;
    if (!planId) {
      return { error: "PayPal did not return a billing plan id", planId: null };
    }

    return { error: null, planId };
  } catch (err) {
    return { error: paypalErrorMessage(err), planId: null };
  }
}

module.exports = {
  createPaypalBillingPlan,
};
