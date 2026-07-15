const CategoryWebhookLog = require("../../../models/CategoryWebhookLog");
const StoreCategoryWebhookEvent = require("../../../models/StoreCategoryWebhookEvent");
const { WEBHOOK_LOG_STEPS_SET } = require("../../../models/constants");

function buildCategoryWebhookTraceId(storeHash, eventHash) {
  if (!storeHash || !eventHash) {
    return null;
  }

  return `category-webhook-${storeHash}-${eventHash}`;
}

function buildCategoryBurstTraceId(storeHash, burstKey) {
  return `category-webhook-burst-${storeHash}-${burstKey}`;
}

function resolveTraceId({ traceId, storeHash, eventHash }) {
  return (
    traceId ||
    buildCategoryWebhookTraceId(storeHash, eventHash) ||
    `category-webhook-${storeHash}-${Date.now()}`
  );
}

async function nextCategoryWebhookLogSequence(traceId) {
  const lastLog = await CategoryWebhookLog.findOne({ trace_id: traceId })
    .sort({ sequence: -1 })
    .select({ sequence: 1 })
    .lean();

  return (lastLog?.sequence || 0) + 1;
}

async function appendCategoryWebhookLog({
  traceId = null,
  storeHash,
  eventHash = null,
  scope = null,
  categoryId = null,
  logType = "info",
  step = null,
  message,
  meta = {},
}) {
  if (!storeHash || !message) {
    return { error: "storeHash and message are required for category webhook activity log" };
  }

  if (step && !WEBHOOK_LOG_STEPS_SET.has(step)) {
    return { error: `Invalid category webhook log step: ${step}` };
  }

  try {
    const resolvedTraceId = resolveTraceId({ traceId, storeHash, eventHash });
    const sequence = await nextCategoryWebhookLogSequence(resolvedTraceId);

    await CategoryWebhookLog.create({
      trace_id: resolvedTraceId,
      store_hash: storeHash,
      event_hash: eventHash,
      scope,
      category_id: categoryId,
      log_type: logType,
      step,
      sequence,
      message: String(message),
      meta,
    });
    return { error: null };
  } catch (err) {
    console.error("[appendCategoryWebhookLog]", err.message, {
      traceId,
      storeHash,
      step,
      logType,
    });
    return { error: err.message };
  }
}

async function upsertCategoryWebhookEvent({
  traceId = null,
  storeHash,
  eventHash,
  scope = null,
  categoryId = null,
  storeId = null,
  status = "received",
  payload = null,
  errorMessage = null,
}) {
  if (!storeHash || !eventHash) {
    return { error: "storeHash and eventHash are required for category webhook event" };
  }

  try {
    await StoreCategoryWebhookEvent.findOneAndUpdate(
      { store_hash: storeHash, event_hash: eventHash },
      {
        $set: {
          trace_id: resolveTraceId({ traceId, storeHash, eventHash }),
          store_hash: storeHash,
          event_hash: eventHash,
          scope,
          category_id: categoryId,
          store_id: storeId,
          status,
          payload,
          error_message: errorMessage,
          received_at: new Date(),
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    ).lean();
    return { error: null };
  } catch (err) {
    console.error("[upsertCategoryWebhookEvent]", err.message, {
      traceId,
      storeHash,
      eventHash,
      status,
    });
    return { error: err.message };
  }
}

module.exports = {
  appendCategoryWebhookLog,
  upsertCategoryWebhookEvent,
  buildCategoryWebhookTraceId,
  buildCategoryBurstTraceId,
  resolveTraceId,
};
