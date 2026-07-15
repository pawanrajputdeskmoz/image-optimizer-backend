const { getRedis } = require("../../../db/redis");

const WEBHOOK_BURST_WINDOW_SEC = 3;
const PRODUCT_CREATED_SCOPE = "store/product/created";
const PRODUCT_UPDATED_SCOPE = "store/product/updated";
const CATEGORY_CREATED_SCOPE = "store/category/created";
const CATEGORY_UPDATED_SCOPE = "store/category/updated";

function webhookCreatedKey(entityType, storeHash, entityId) {
  return `webhook:created:${entityType}:${storeHash}:${entityId}`;
}

async function resolveEntityWebhookBurst(entityType, storeHash, entityId, scope) {
  const redis = getRedis();
  const createdScope =
    entityType === "category" ? CATEGORY_CREATED_SCOPE : PRODUCT_CREATED_SCOPE;
  const updatedScope =
    entityType === "category" ? CATEGORY_UPDATED_SCOPE : PRODUCT_UPDATED_SCOPE;

  if (scope === createdScope) {
    await redis.set(
      webhookCreatedKey(entityType, storeHash, entityId),
      "1",
      "EX",
      WEBHOOK_BURST_WINDOW_SEC + 2
    );
    return { deduplicated: false };
  }

  if (scope === updatedScope) {
    const isCompanionUpdate = await redis.get(
      webhookCreatedKey(entityType, storeHash, entityId)
    );
    return { deduplicated: Boolean(isCompanionUpdate) };
  }

  return { deduplicated: false };
}

/**
 * Mark product/created and skip companion product/updated fired immediately after create.
 */
async function resolveProductWebhookBurst(storeHash, productId, scope) {
  return resolveEntityWebhookBurst("product", storeHash, productId, scope);
}

/**
 * Mark category/created and skip companion category/updated fired immediately after create.
 */
async function resolveCategoryWebhookBurst(storeHash, categoryId, scope) {
  return resolveEntityWebhookBurst("category", storeHash, categoryId, scope);
}

module.exports = {
  WEBHOOK_BURST_WINDOW_SEC,
  PRODUCT_CREATED_SCOPE,
  PRODUCT_UPDATED_SCOPE,
  CATEGORY_CREATED_SCOPE,
  CATEGORY_UPDATED_SCOPE,
  webhookCreatedKey,
  resolveProductWebhookBurst,
  resolveCategoryWebhookBurst,
};
