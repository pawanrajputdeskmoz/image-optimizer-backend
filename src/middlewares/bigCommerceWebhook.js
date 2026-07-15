const {
  verifyWebhookSecret,
  parseWebhookPayload,
} = require("../utils/bigCommerceWebhook");
const {
  appendWebhookLog,
  upsertWebhookEvent,
  buildWebhookTraceId,
} = require("../modules/installation/utils/webhookActivityLog");
const {
  appendCategoryWebhookLog,
  upsertCategoryWebhookEvent,
  buildCategoryWebhookTraceId,
} = require("../modules/installation/utils/categoryWebhookActivityLog");
const {
  resolveProductWebhookBurst,
  resolveCategoryWebhookBurst,
} = require("../modules/installation/utils/webhookBurst");

function isCategoryScope(scope) {
  return String(scope || "").startsWith("store/category/");
}

function buildEventIds(parsedData) {
  const entityId = parsedData?.entityId ?? parsedData?.productId ?? parsedData?.categoryId ?? null;

  return {
    productId: parsedData?.productId ?? null,
    categoryId: parsedData?.categoryId ?? null,
    entityId,
  };
}

async function saveWebhookEvent({
  isCategory,
  traceId,
  storeHash,
  eventHash,
  scope,
  productId,
  categoryId,
  storeId,
  status,
  payload,
  errorMessage,
}) {
  if (isCategory) {
    return upsertCategoryWebhookEvent({
      traceId,
      storeHash,
      eventHash,
      scope,
      categoryId,
      storeId,
      status,
      payload,
      errorMessage,
    });
  }

  return upsertWebhookEvent({
    traceId,
    storeHash,
    eventHash,
    scope,
    productId,
    storeId,
    status,
    payload,
    errorMessage,
  });
}

async function saveWebhookLog({
  isCategory,
  traceId,
  storeHash,
  eventHash,
  scope,
  productId,
  categoryId,
  logType = "info",
  step,
  message,
  meta = {},
}) {
  if (isCategory) {
    return appendCategoryWebhookLog({
      traceId,
      storeHash,
      eventHash,
      scope,
      categoryId,
      logType,
      step,
      message,
      meta,
    });
  }

  return appendWebhookLog({
    traceId,
    storeHash,
    eventHash,
    scope,
    productId,
    logType,
    step,
    message,
    meta,
  });
}

function resolveTraceId(storeHash, eventHash, isCategory) {
  return isCategory
    ? buildCategoryWebhookTraceId(storeHash, eventHash)
    : buildWebhookTraceId(storeHash, eventHash);
}

async function verifyBigCommerceWebhook(req, reply) {
  const secretCheck = verifyWebhookSecret(req);
  if (!secretCheck.ok) {
    console.warn("[verifyBigCommerceWebhook] rejected:", secretCheck.reason);

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const storeHash = String(body.producer || "").replace(/^stores\//i, "").trim() || null;
    const eventHash = body.hash ? String(body.hash).trim() : null;
    const scope = body.scope || null;
    const entityId = body?.data?.id ?? null;
    const isCategory = isCategoryScope(scope);

    if (storeHash) {
      await saveWebhookEvent({
        isCategory,
        traceId: resolveTraceId(storeHash, eventHash, isCategory),
        storeHash,
        eventHash,
        scope,
        productId: isCategory ? null : entityId,
        categoryId: isCategory ? entityId : null,
        storeId: body?.store_id ? String(body.store_id) : null,
        status: "auth_rejected",
        payload: body,
        errorMessage: secretCheck.reason,
      });
      await saveWebhookLog({
        isCategory,
        traceId: resolveTraceId(storeHash, eventHash, isCategory),
        storeHash,
        eventHash,
        scope,
        productId: isCategory ? null : entityId,
        categoryId: isCategory ? entityId : null,
        logType: "error",
        step: "auth_rejected",
        message: "Webhook rejected during secret verification",
        meta: { reason: secretCheck.reason },
      });
    }

    return reply.status(401).send({
      success: false,
      message: "Unauthorized webhook",
    });
  }

  const parsed = parseWebhookPayload(req.body);

  if (!parsed.ok) {
    console.warn("[verifyBigCommerceWebhook] invalid payload:", parsed.reason);

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const storeHash = String(body.producer || "").replace(/^stores\//i, "").trim() || null;
    const eventHash = body.hash ? String(body.hash).trim() : null;
    const scope = body.scope || null;
    const entityId = body?.data?.id ?? null;
    const isCategory = isCategoryScope(scope);

    if (storeHash) {
      await saveWebhookEvent({
        isCategory,
        traceId: resolveTraceId(storeHash, eventHash, isCategory),
        storeHash,
        eventHash,
        scope,
        productId: isCategory ? null : entityId,
        categoryId: isCategory ? entityId : null,
        storeId: body?.store_id ? String(body.store_id) : null,
        status: "payload_invalid",
        payload: body,
        errorMessage: parsed.reason,
      });
      await saveWebhookLog({
        isCategory,
        traceId: resolveTraceId(storeHash, eventHash, isCategory),
        storeHash,
        eventHash,
        scope,
        productId: isCategory ? null : entityId,
        categoryId: isCategory ? entityId : null,
        logType: "error",
        step: "payload_invalid",
        message: "Webhook payload validation failed",
        meta: { reason: parsed.reason },
      });
    }

    return reply.status(400).send({
      success: false,
      message: "Invalid BigCommerce webhook payload",
    });
  }

  const { storeHash, scope, hash, entityType } = parsed.data;
  const { productId, categoryId, entityId } = buildEventIds(parsed.data);
  const isCategory = entityType === "category";

  const burstResolver = isCategory ? resolveCategoryWebhookBurst : resolveProductWebhookBurst;
  const { deduplicated } = await burstResolver(storeHash, entityId, scope);

  req.bigCommerceWebhook = {
    ...parsed.data,
    traceId: resolveTraceId(storeHash, hash, isCategory),
    deduplicated,
    isCategory,
  };

  await saveWebhookEvent({
    isCategory,
    traceId: req.bigCommerceWebhook.traceId,
    storeHash,
    eventHash: hash,
    scope,
    productId,
    categoryId,
    storeId: parsed.data.payload?.store_id ? String(parsed.data.payload.store_id) : null,
    status: deduplicated ? "deduplicated" : "received",
    payload: parsed.data.payload,
    errorMessage: null,
  });

  if (deduplicated) {
    return;
  }

  await saveWebhookLog({
    isCategory,
    traceId: req.bigCommerceWebhook.traceId,
    storeHash,
    eventHash: hash,
    scope,
    productId,
    categoryId,
    step: "received",
    message: "BigCommerce webhook request received",
    meta: {
      has_secret: Boolean(req.headers["x-webhook-secret"]),
      user_agent: req.headers["user-agent"] || null,
      entity_type: entityType,
    },
  });

  await saveWebhookLog({
    isCategory,
    traceId: req.bigCommerceWebhook.traceId,
    storeHash,
    eventHash: hash,
    scope,
    productId,
    categoryId,
    step: "auth_verified",
    message: "Webhook authenticated and payload parsed",
    meta: {
      created_at: parsed.data.createdAt,
      producer: parsed.data.producer,
      entity_type: entityType,
    },
  });
}

module.exports = { verifyBigCommerceWebhook };
