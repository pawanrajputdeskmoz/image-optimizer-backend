const crypto = require("node:crypto");

const WEBHOOK_SECRET_HEADER = "X-Webhook-Secret";
const PRODUCER_PATTERN = /^stores\/[a-z0-9]+$/i;

function getWebhookSecret() {
  const secret =
    process.env.BIGCOMMERCE_WEBHOOK_SECRET || process.env.BIG_COMMERCE_CLIENT_SECRET;

  if (!secret || !String(secret).trim()) {
    throw new Error("BigCommerce webhook secret is not configured");
  }

  return String(secret).trim();
}

function getWebhookAuthHeaders() {
  return {
    [WEBHOOK_SECRET_HEADER]: getWebhookSecret(),
  };
}

function timingSafeEqualStrings(left, right) {
  const leftBuf = Buffer.from(String(left));
  const rightBuf = Buffer.from(String(right));

  if (leftBuf.length !== rightBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuf, rightBuf);
}

function readWebhookSecretHeader(req) {
  const headers = req.headers || {};
  return (
    headers[WEBHOOK_SECRET_HEADER] ||
    headers[WEBHOOK_SECRET_HEADER.toLowerCase()] ||
    headers["x-webhook-secret"] ||
    null
  );
}

function verifyWebhookSecret(req) {
  let expectedSecret;

  try {
    expectedSecret = getWebhookSecret();
  } catch (error) {
    return { ok: false, reason: "webhook_secret_not_configured" };
  }

  const receivedSecret = readWebhookSecretHeader(req);

  if (!receivedSecret) {
    return { ok: false, reason: "missing_webhook_secret" };
  }

  if (!timingSafeEqualStrings(receivedSecret, expectedSecret)) {
    return { ok: false, reason: "invalid_webhook_secret" };
  }

  return { ok: true };
}

function parseStoreHashFromProducer(producer) {
  const normalized = String(producer || "").trim();

  if (!PRODUCER_PATTERN.test(normalized)) {
    return null;
  }

  return normalized.replace(/^stores\//i, "").trim() || null;
}

function parseWebhookPayload(body) {
  const payload = body && typeof body === "object" ? body : null;

  if (!payload) {
    return { ok: false, reason: "invalid_payload" };
  }

  const scope = String(payload.scope || "").trim();
  const producer = String(payload.producer || "").trim();
  const hash = String(payload.hash || "").trim();
  const createdAt = Number(payload.created_at);
  const entityId = Number(payload?.data?.id);
  const storeHash = parseStoreHashFromProducer(producer);
  const isProductScope = scope.startsWith("store/product/");
  const isCategoryScope = scope.startsWith("store/category/");

  if (!scope) {
    return { ok: false, reason: "missing_scope" };
  }

  if (!storeHash) {
    return { ok: false, reason: "invalid_producer" };
  }

  if (!hash) {
    return { ok: false, reason: "missing_hash" };
  }

  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return { ok: false, reason: "invalid_created_at" };
  }

  if (!Number.isFinite(entityId)) {
    return { ok: false, reason: "invalid_entity_id" };
  }

  if (!isProductScope && !isCategoryScope) {
    return { ok: false, reason: "unsupported_scope" };
  }

  return {
    ok: true,
    data: {
      scope,
      producer,
      hash,
      createdAt,
      storeHash,
      entityId,
      productId: isProductScope ? entityId : null,
      categoryId: isCategoryScope ? entityId : null,
      entityType: isProductScope ? "product" : "category",
      payload,
    },
  };
}

module.exports = {
  WEBHOOK_SECRET_HEADER,
  getWebhookSecret,
  getWebhookAuthHeaders,
  verifyWebhookSecret,
  parseWebhookPayload,
  parseStoreHashFromProducer,
};
